/**
 * `GET /api/live-news/v5/refresh-newscatcher` — cron-only endpoint.
 *
 * Pulls clustered headlines from Newscatcher and merges them into the
 * `live-news:nc:v1:digest` Redis accumulator. Schedule lives in vercel.json
 * (hourly to start, conservative for the trial tier).
 *
 * Auth: Bearer CRON_SECRET, or "vercel-cron" user-agent.
 */

import { refreshLiveNewsV5 } from '../../../server/live-news/v5/refresh';

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
    const result = await refreshLiveNewsV5();
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error('[live-news:v5:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
