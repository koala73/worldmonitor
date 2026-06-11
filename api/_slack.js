/**
 * Slack ops alerts — fire when a conversion-critical endpoint emits a
 * NON-CACHEABLE response (503 hard-fail, empty no-store, partial no-store).
 *
 * Why that condition: we can't see inside Vercel's cache, but we control
 * what is ELIGIBLE to enter it. Every healthy response carries s-maxage and
 * refreshes the CDN's last-known-good copy; every 503/no-store does not.
 * So "emitted a non-cacheable response" simultaneously means "users may be
 * seeing degraded data" AND "the CDN safety copy has stopped refreshing".
 *
 * Identity: every message is signed "⚡ Origin Monitor" so it's always clear
 * WHICH watchdog detected an anomaly (its sibling is "🛰️ US Edge Probe", the
 * GitHub-Actions prober in scripts/probe-us-edge.mjs — that one sees what US
 * users receive from the CDN; this one sees what the origin itself emits).
 *
 * Setup: set WM_SLACK_ALERT_WEBHOOK (Slack incoming-webhook URL) in the
 * Vercel env. Absent → no-op, zero cost.
 *
 * Throttling: one message per eventKey per `throttleSeconds`, enforced in
 * two layers — per-isolate memory (survives even when Redis is the thing
 * that's down) and a cross-isolate Redis SET NX. Alerting fails OPEN on
 * Redis errors: a Redis outage is exactly when we must not stay silent.
 */

const SENDER = '⚡ *Origin Monitor* (Vercel)';

const memThrottle = new Map();

async function redisSetNX(key, ttlSeconds) {
  // Returns true when WE claimed the key (i.e. proceed), true on Redis
  // failure (fail open), false when someone else holds it.
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return true;
    const cmd = ttlSeconds
      ? ['SET', key, '1', 'NX', 'EX', String(ttlSeconds)]
      : ['SET', key, '1', 'NX'];
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([cmd]),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return true;
    const data = await resp.json();
    return data?.[0]?.result !== null;
  } catch {
    return true;
  }
}

async function postToSlack(text) {
  const webhook = process.env.WM_SLACK_ALERT_WEBHOOK;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn('[slack] notify failed:', err?.message || err);
  }
}

export async function notifySlack(eventKey, text, throttleSeconds = 900) {
  if (!process.env.WM_SLACK_ALERT_WEBHOOK) return;

  const now = Date.now();
  if (now - (memThrottle.get(eventKey) ?? 0) < throttleSeconds * 1000) return;
  memThrottle.set(eventKey, now);

  // Cross-isolate throttle (best effort; fails open on Redis errors —
  // a Redis outage is exactly when we must not stay silent).
  if (!(await redisSetNX(`slack:throttle:${eventKey}`, throttleSeconds))) return;

  const region = process.env.VERCEL_REGION || '-';
  const ts = new Date().toISOString().slice(0, 16) + 'Z';
  await postToSlack(`${SENDER}\n${text}\n_region ${region} · ${ts}_`);
}

/**
 * One-time self-introduction, posted on the first request after the first
 * deployment that ships this monitor (Redis SET NX, no expiry — once ever).
 * Call from a high-traffic handler (bootstrap). In-memory flag keeps the
 * cost to a single Redis check per isolate cold-start.
 */
let introChecked = false;
export async function announceOriginMonitorOnce() {
  if (introChecked || !process.env.WM_SLACK_ALERT_WEBHOOK) return;
  introChecked = true;
  if (!(await redisSetNX('slack:intro:origin-monitor:v1', 0))) return;
  await postToSlack(
    `${SENDER} is now live. 👋\n` +
    `I run inside the API itself and post here the moment a FEED endpoint emits a response that can NOT refresh the CDN's safety copy:\n` +
    `• 🔴 \`503\` — Redis failure or missing/empty data; the CDN is serving the last known-good copy (stale-if-error, up to 24h)\n` +
    `• 🟠 \`200 no-store\` — an empty feed; users get it live, but the cached good copy stops refreshing while it persists\n` +
    `Watching: \`live-news/v6\` · \`intel-news/v6\` · \`conflict-archive/v5\` · \`world-brief/get-region\`\n` +
    `Throttle: max 1 message per condition per 15 min. No message = all responses cacheable and populated.\n` +
    `My sibling 🛰️ *US Edge Probe* (a Vercel cron) checks these endpoints AND bootstrap from US vantage points every 15 min — bootstrap anomalies (503s, mobile-relevant gaps) are ITS job — and posts a daily report at 13:07 ET / 10:07 PT (= 20:07 TRT).`,
  );
}
