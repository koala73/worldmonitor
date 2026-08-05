import { unwrapEnvelope } from './_seed-envelope.js';

/**
 * Envelope-aware Redis read that preserves the difference between a cache
 * miss and an infrastructure/parse failure. Analysis composites use this
 * status to avoid turning a lost input into a fresh-looking empty feed.
 *
 * @param {string} key
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ status: 'hit' | 'miss' | 'error'; value: unknown | null }>}
 */
export async function readJsonFromUpstashWithStatus(key, timeoutMs = 3_000) {
  try {
    const value = await readRawJsonFromUpstash(key, timeoutMs);
    if (value === null) return { status: 'miss', value: null };
    const unwrapped = unwrapEnvelope(value).data;
    if (unwrapped === undefined) {
      throw new Error(`readJsonFromUpstashWithStatus: ${key} has a seed envelope without data`);
    }
    return { status: 'hit', value: unwrapped };
  } catch {
    return { status: 'error', value: null };
  }
}

/**
 * Read several envelope-backed JSON values in one Upstash pipeline request.
 * Each command retains its own hit/miss/error result so one malformed cache
 * cannot make the remaining inputs look unavailable.
 *
 * @param {readonly string[]} keys
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<Array<{ status: 'hit' | 'miss' | 'error'; value: unknown | null }>>}
 */
export async function readJsonBatchFromUpstashWithStatus(keys, timeoutMs = 3_000) {
  if (keys.length === 0) return [];

  const creds = getRedisCredentials();
  if (!creds) return keys.map(() => ({ status: 'error', value: null }));

  try {
    const resp = await fetch(`${creds.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-edge/1.0',
      },
      body: JSON.stringify(keys.map((key) => ['GET', key])),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return keys.map(() => ({ status: 'error', value: null }));

    const entries = await resp.json();
    if (!Array.isArray(entries) || entries.length !== keys.length) {
      return keys.map(() => ({ status: 'error', value: null }));
    }

    return entries.map((entry) => {
      if (
        !entry
        || typeof entry !== 'object'
        || !Object.prototype.hasOwnProperty.call(entry, 'result')
        || Object.prototype.hasOwnProperty.call(entry, 'error')
      ) {
        return { status: 'error', value: null };
      }
      if (entry.result === null) return { status: 'miss', value: null };
      try {
        const parsed = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result;
        const value = unwrapEnvelope(parsed).data;
        return value === undefined
          ? { status: 'error', value: null }
          : { status: 'hit', value };
      } catch {
        return { status: 'error', value: null };
      }
    });
  } catch {
    return keys.map(() => ({ status: 'error', value: null }));
  }
}

export async function readJsonFromUpstash(key, timeoutMs = 3_000) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (data.result == null) return null;

  try {
    return unwrapEnvelope(JSON.parse(data.result)).data;
  } catch {
    return null;
  }
}

/**
 * Raw GET on a Redis key. Returns the parsed JSON value (or bare
 * string for non-JSON) without applying seed-envelope unwrap. Use
 * this for caches whose stored shape is NOT `{_seed, data}` — e.g.
 * the per-user brief envelope `{version, issuedAt, data}` whose
 * outer frame must reach the consumer.
 *
 * Semantics:
 *   - Returns the parsed value on a hit.
 *   - Returns `null` ONLY on a genuine miss (Upstash replied 200 with
 *     no result field).
 *   - Throws on every other failure mode (missing credentials, HTTP
 *     non-2xx, timeout/abort, JSON parse failure). Callers MUST
 *     distinguish infrastructure failure from empty-state to avoid
 *     showing users "composing" / "expired" UX during an outage.
 *
 * @param {string} key
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<unknown | null>}
 */
export async function readRawJsonFromUpstash(key, timeoutMs = 3_000) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('readRawJsonFromUpstash: UPSTASH_REDIS_REST_URL/TOKEN not configured');
  }

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`readRawJsonFromUpstash: Upstash GET ${key} returned HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'result')) {
    throw new Error(`readRawJsonFromUpstash: Upstash GET ${key} returned a malformed response`);
  }
  if (data.result === null) return null; // genuine miss
  try {
    return JSON.parse(data.result);
  } catch (err) {
    throw new Error(
      `readRawJsonFromUpstash: JSON.parse failed for ${key}: ${(err instanceof Error ? err.message : String(err))}`,
    );
  }
}

/** Returns Redis credentials or null if not configured. */
export function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Convert successful EXISTS pipeline entries into a three-valued marker map.
 * A key is added only when its entry explicitly has a result of 0 or 1 and
 * has no error field. Missing, malformed, null-result, and per-command-error
 * entries remain absent from the map, which callers interpret as unknown.
 *
 * @param {unknown} results
 * @param {readonly string[]} keys
 * @returns {Map<string, boolean>}
 */
export function readExistsFlags(results, keys) {
  const states = new Map();
  if (!Array.isArray(results) || results.length !== keys.length) return states;

  for (let i = 0; i < keys.length; i++) {
    const entry = results[i];
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.prototype.hasOwnProperty.call(entry, 'error')
      || !Object.prototype.hasOwnProperty.call(entry, 'result')
    ) {
      continue;
    }
    if (entry.result === 1 || entry.result === '1') states.set(keys[i], true);
    else if (entry.result === 0 || entry.result === '0') states.set(keys[i], false);
  }
  return states;
}

/**
 * Execute a batch of Redis commands via the Upstash pipeline endpoint.
 * Returns null on missing credentials, HTTP error, timeout, or a response body
 * that is not an array with exactly one entry per command.
 * @param {Array<string[]>} commands - e.g. [['GET', 'key'], ['EXPIRE', 'key', '60']]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Array<{ result?: unknown, error?: unknown }> | null>}
 */
export async function redisPipeline(commands, timeoutMs = 5_000) {
  const creds = getRedisCredentials();
  if (!creds) return null;
  if (!Array.isArray(commands)) return null;
  try {
    const resp = await fetch(`${creds.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-edge/1.0',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const entries = await resp.json();
    if (!Array.isArray(entries) || entries.length !== commands.length) return null;
    return entries;
  } catch {
    return null;
  }
}

/**
 * Write a JSON value to Redis with a TTL (SET + EXPIRE as pipeline).
 * @param {string} key
 * @param {unknown} value - will be JSON.stringify'd
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>} true on success
 */
export async function setCachedData(key, value, ttlSeconds) {
  const results = await redisPipeline([
    ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)],
  ]);
  return results !== null;
}
