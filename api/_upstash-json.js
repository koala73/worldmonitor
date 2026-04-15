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
