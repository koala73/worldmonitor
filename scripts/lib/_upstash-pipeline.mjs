/**
 * Shared Upstash pipeline helper for scripts/lib/* modules.
 *
 * The canonical helper for api/* code is api/_upstash-json.js:redisPipeline.
 * scripts/lib/* modules historically avoid importing from api/, so this
 * file exposes the same behaviour (single POST to /pipeline, 10s timeout,
 * returns null on failure) without the cross-dir import.
 *
 * Keep the shape identical to api/_upstash-json.js:redisPipeline so
 * callers can be swapped if we ever relax the boundary.
 */

/**
 * @param {Array<unknown[]>} commands   Upstash pipeline commands
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10_000]
 * @returns {Promise<Array<{result: unknown}> | null>}  null on any failure
 */
export async function defaultRedisPipeline(commands, { timeoutMs = 10_000 } = {}) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || commands.length === 0) return null;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-digest/1.0',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
