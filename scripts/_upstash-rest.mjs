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
export async function upstashCommand(creds, command) {
  const resp = await fetch(creds.restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-ops/1.0 (+https://worldmonitor.app)',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  return resp.json();
}
