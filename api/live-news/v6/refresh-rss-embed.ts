/**
 * `GET /api/live-news/v6/refresh-rss-embed` — cron-only.
 *
 * Schedule in vercel.json: every 15 min. Pulls RSS feeds, embeds new
 * items via Gemini, clusters at threshold 0.7, writes the v6 digest.
 */

import { refreshLiveNewsV6 } from '../../../server/live-news/v6/refresh';

export const config = { runtime: 'edge' };

function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = (req.headers.get('user-agent') ?? '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: Request): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }
  if (!isAuthorizedCron(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }), { status: 403, headers });
  }
  try {
    const result = await refreshLiveNewsV6();
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error('[live-news:v6:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
