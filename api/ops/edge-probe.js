/**
 * Vercel cron — 🛰️ US Edge Probe, ALERT mode (every 15 min, off-peak minutes).
 * Posts to Slack only when something is wrong. See api/ops/_probe-core.js.
 *
 * Trade-off (accepted deliberately): this runs INSIDE the deployment it
 * monitors, so it can't catch "all of Vercel is down" — its job is response
 * anomalies (empty data, no-store, 5xx, LKG fallback), and Vercel cron's
 * reliable scheduling beats GitHub Actions' best-effort cron for that.
 */

import { runEdgeProbe } from './_probe-core.js';

export const config = { runtime: 'edge', maxDuration: 300 };

export default async function handler(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  }
  const result = await runEdgeProbe({ summary: false });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
