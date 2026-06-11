/**
 * Vercel cron — 🛰️ US Edge Probe, SUMMARY mode (daily 17:07 UTC = 20:07 TRT
 * = 13:07 ET / 10:07 PT, while both US coasts are active). Posts the full
 * live-situation report to Slack even when everything is healthy.
 * Separate path from edge-probe.js because vercel.json cron entries are
 * cleanest without query strings. See api/ops/_probe-core.js.
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
  const result = await runEdgeProbe({ summary: true });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
