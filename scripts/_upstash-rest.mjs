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
export const UPSTASH_COMMAND_TIMEOUT_MS = 15_000;
export const UPSTASH_RETRY_AFTER_MAX_MS = 2_000;

export async function upstashCommand(creds, command) {
  const resp = await fetch(creds.restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-ops/1.0 (+https://worldmonitor.app)',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(UPSTASH_COMMAND_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const error = new Error(`Upstash HTTP ${resp.status}`);
    error.status = resp.status;
    const retryAfter = resp.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const retryAt = Date.parse(retryAfter);
      const parsedRetryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
      error.retryAfterMs = Number.isFinite(parsedRetryAfterMs)
        ? Math.min(parsedRetryAfterMs, UPSTASH_RETRY_AFTER_MAX_MS)
        : undefined;
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
