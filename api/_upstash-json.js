import { unwrapEnvelope } from './_seed-envelope.js';

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
  if (!data.result) return null;

  try {
    // Envelope-aware: contract-mode canonical keys are stored as {_seed, data}.
    // MCP tool outputs and RPC consumers must see the bare payload only.
    // unwrapEnvelope is a no-op on legacy bare-shape values and on seed-meta
    // keys (which remain top-level {fetchedAt, recordCount, ...}).
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
  if (data.result == null) return null; // genuine miss
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
 * Execute a batch of Redis commands via the Upstash pipeline endpoint.
 * Returns null on missing credentials, HTTP error, or timeout.
 * @param {Array<string[]>} commands - e.g. [['GET', 'key'], ['EXPIRE', 'key', '60']]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Array<{ result: unknown }> | null>}
 */
export async function redisPipeline(commands, timeoutMs = 5_000) {
  const creds = getRedisCredentials();
  if (!creds) return null;
  try {
    const resp = await fetch(`${creds.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
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
