/**
 * `GET /api/live-news/v3/refresh-worldnews` — cron-only endpoint.
 *
 * Runs every 5 minutes via Vercel cron. Pulls clustered top stories
 * from the World News API and merges them into the
 * `live-news:wn:v1:digest` Redis accumulator. The read endpoint at
 * `/api/live-news/v3/list-us-headlines` serves whatever's in that key.
 *
 * # Runtime choice
 *
 * Edge runtime — no Node-only deps (just fetch + Redis), and the Edge
 * bundler resolves the relative `server/` imports we use. The legacy
 * intel-news crons run on Node because they decompress zip dumps; ours
 * doesn't, so Edge is the right fit.
 *
 * Auth: accepts Bearer CRON_SECRET, or any caller whose user-agent
 * contains "vercel-cron". Locked-down for everyone else.
 */

import { refreshLiveNewsV3 } from '../../../server/live-news/v3/refresh';

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
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers,
    });
  }

  if (!isAuthorizedCron(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }), {
      status: 403,
      headers,
    });
  }

  try {
    const result = await refreshLiveNewsV3();
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error('[live-news:v3:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers,
    });
  }
}
