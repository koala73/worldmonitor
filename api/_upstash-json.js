import { unwrapEnvelope } from './_seed-envelope.js';

/**
 * Deployment key prefix — the api-layer mirror of
 * `server/_shared/redis.ts::getKeyPrefix` (the M-6 fix). Preview/development
 * Vercel deployments share one Upstash instance with production, so every key
 * THIS deployment owns is namespaced `preview:<sha>:…` to keep its reads and
 * writes out of the production namespace. Production (and any runtime without
 * VERCEL_ENV — the Railway digest service imports this module) gets ''.
 *
 * The prefix is a WRITE-OWNERSHIP contract (#7575/#7673/#7674):
 *   - Keys this app writes (route-owned caches, per-user state, rate-limit
 *     counters, MCP story/digest state) — leave `raw` unset so reads and
 *     writes land in the deployment's own namespace.
 *   - Keys written by Railway seeders/relays, which do not know the prefix
 *     scheme — pass `raw = true` so preview reads the real production rows
 *     instead of a namespace no seeder populates. The same rule already
 *     applies to the server helpers (`getCachedJson(key, true)` for
 *     seeder-owned keys) and to deliberately cross-deployment user state
 *     (`entitlements:*`, see server/_shared/entitlement-check.ts P2-3).
 * Production is unaffected either way: the prefix is '' there, so a wrong
 * classification can only fail visibly on a preview deployment.
 */
export function getKeyPrefix() {
  const env = process.env.VERCEL_ENV; // 'production' | 'preview' | 'development'
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

/**
 * Apply the deployment prefix to an app-owned key. Exported for the mixed
 * pipelines that must name per-key ownership at command-construction time
 * (api/health.js sweep) and then pass `raw = true` so the pipeline helpers do
 * not prefix again.
 *
 * Computed per call, NOT memoized — mirrors server/_shared/pro-mcp-token.ts's
 * envPrefix: tests may mutate VERCEL_ENV between calls, and the cost is one
 * trivial string read.
 */
export function applyRedisKeyPrefix(key) {
  const prefix = getKeyPrefix();
  return prefix ? `${prefix}${key}` : key;
}

/**
 * Envelope-aware Redis read that preserves the difference between a cache
 * miss and an infrastructure/parse failure. Analysis composites use this
 * status to avoid turning a lost input into a fresh-looking empty feed.
 *
 * @param {string} key
 * @param {number} [timeoutMs=3000]
 * @param {boolean} [raw=false] - true reads the key verbatim (seeder-owned /
 *   already-final keys); default applies the deployment key prefix.
 * @returns {Promise<{ status: 'hit' | 'miss' | 'error'; value: unknown | null }>}
 */
export async function readJsonFromUpstashWithStatus(key, timeoutMs = 3_000, raw = false) {
  try {
    const value = await readRawJsonFromUpstash(key, timeoutMs, raw);
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
 * @param {boolean} [raw=false] - true reads the keys verbatim; default
 *   applies the deployment key prefix to every key.
 * @returns {Promise<Array<{ status: 'hit' | 'miss' | 'error'; value: unknown | null }>>}
 */
export async function readJsonBatchFromUpstashWithStatus(keys, timeoutMs = 3_000, raw = false) {
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
      body: JSON.stringify(keys.map((key) => ['GET', raw ? key : applyRedisKeyPrefix(key)])),
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

export async function readJsonFromUpstash(key, timeoutMs = 3_000, raw = false) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/get/${encodeURIComponent(raw ? key : applyRedisKeyPrefix(key))}`, {
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
 * @param {boolean} [raw=false] - true reads the key verbatim (seeder-owned /
 *   already-final keys); default applies the deployment key prefix.
 * @returns {Promise<unknown | null>}
 */
export async function readRawJsonFromUpstash(key, timeoutMs = 3_000, raw = false) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('readRawJsonFromUpstash: UPSTASH_REDIS_REST_URL/TOKEN not configured');
  }

  const resp = await fetch(`${url}/get/${encodeURIComponent(raw ? key : applyRedisKeyPrefix(key))}`, {
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
 * Prefix the key argument of one pipeline command, mirroring
 * `server/_shared/redis.ts::normalizePipelineCommand` so the two layers
 * behave identically: only the first string argument after the verb is a key,
 * and EVAL's KEYS are found via its key-count argument.
 */
function normalizePipelineCommand(command, raw) {
  if (raw || !Array.isArray(command) || command.length < 2) return [...command];
  const [verb, key, ...rest] = command;
  if (typeof verb !== 'string' || typeof key !== 'string') return [...command];
  if (verb.toUpperCase() === 'EVAL') {
    const keyCount = Number(rest[0]);
    if (!Number.isInteger(keyCount) || keyCount < 0 || rest.length < keyCount + 1) return [...command];
    const keys = rest.slice(1, keyCount + 1).map((item) => (typeof item === 'string' ? applyRedisKeyPrefix(item) : item));
    return [verb, key, rest[0], ...keys, ...rest.slice(keyCount + 1)];
  }
  return [verb, applyRedisKeyPrefix(key), ...rest];
}

/**
 * Execute a batch of Redis commands via the Upstash pipeline endpoint.
 * Returns null on missing credentials, HTTP error, timeout, or a response body
 * that is not an array with exactly one entry per command.
 * @param {Array<string[]>} commands - e.g. [['GET', 'key'], ['EXPIRE', 'key', '60']]
 * @param {number} [timeoutMs=5000]
 * @param {boolean} [raw=false] - true sends the commands verbatim (keys are
 *   already final: seeder-owned, or pre-prefixed via applyRedisKeyPrefix for
 *   mixed-ownership pipelines); default prefixes each command's key.
 * @returns {Promise<Array<{ result?: unknown, error?: unknown }> | null>}
 */
export async function redisPipeline(commands, timeoutMs = 5_000, raw = false) {
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
      body: JSON.stringify(commands.map((command) => normalizePipelineCommand(command, raw))),
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
 * @param {boolean} [raw=false] - true writes the key verbatim (seeder-owned /
 *   already-final keys); default applies the deployment key prefix.
 * @returns {Promise<boolean>} true on success
 */
export async function setCachedData(key, value, ttlSeconds, raw = false) {
  const results = await redisPipeline([
    ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)],
  ], 5_000, raw);
  return results !== null;
}
