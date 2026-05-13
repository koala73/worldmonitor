/**
 * `GET /api/conflict-archive/v2/refresh-worldnews` — cron-only.
 *
 * Runs every 5 minutes via Vercel cron (offset by 1 min from the
 * live-news cron so we don't fire the worldnewsapi key twice in the
 * same second). Pulls conflict-tagged stories from World News API and
 * merges them into `conflict:archive:wn:v1`.
 *
 * Enrichment (lat/lng for the map) lands separately via the intel-news
 * enrich cron — see `api/intel-news/v1/enrich.ts` where the v2 archive
 * key is registered as an extra bucket.
 *
 * # Runtime choice — Edge
 *
 * No Node-only deps. The Edge bundler resolves our relative
 * `server/conflict-archive/v2/refresh` import; the Node runtime
 * doesn't trace it without explicit `.js` extensions, which is why
 * the existing intel-news Node crons inline everything.
 *
 * Auth: Bearer CRON_SECRET or "vercel-cron" user-agent.
 */

import { refreshConflictArchiveV2 } from '../../../server/conflict-archive/v2/refresh';

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
    const result = await refreshConflictArchiveV2();
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error('[conflict-archive:v2:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers,
    });
  }
}
