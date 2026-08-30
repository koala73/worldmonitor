/**
 * #4920: minimal Upstash REST helper shared by the GitHub-Actions-hosted
 * completeness publishers (validate-rss-feeds feed-health, recall
 * benchmark). Deliberately NOT _seed-utils.mjs: that module's credential
 * getter hard-exits when env is missing, while these publishers must
 * skip silently on runs without secrets (local, PRs).
 */

/** @returns {{ restUrl: string; token: string } | null} */
export function getOptionalUpstashCreds() {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !token) return null;
  return { restUrl, token };
}

/**
 * @param {{ restUrl: string; token: string }} creds
 * @param {Array<string>} command Redis command array, e.g. ['GET', 'key']
 */
export async function upstashCommand(creds, command, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const resp = await fetchImpl(creds.restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-ops/1.0 (+https://worldmonitor.app)',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const error = new Error(`Upstash HTTP ${resp.status}`);
    error.status = resp.status;
    error.nonRetryable = resp.status !== 408
      && resp.status !== 429
      && !(resp.status >= 500 && resp.status <= 599);
    const retryAfter = resp.headers?.get?.('retry-after');
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      error.retryAfterMs = Math.min(retryAfterSeconds * 1_000, 60_000);
    }
    throw error;
  }
  const body = await resp.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Upstash returned an unexpected response');
  }
  if (body.error != null) {
    throw new Error(`Upstash rejected command: ${String(body.error)}`);
  }
  if (!Object.hasOwn(body, 'result')) {
    throw new Error('Upstash response did not include a result');
  }
  return body;
}
