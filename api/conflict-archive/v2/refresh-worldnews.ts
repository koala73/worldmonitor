/**
 * `GET /api/conflict-archive/v2/refresh-worldnews` — cron-only.
 *
 * Runs every 5 minutes via Vercel cron (offset by 1 min from the live-news
 * cron so we don't fire the worldnewsapi key twice in the same second).
 * Pulls conflict-tagged stories from World News API and merges them into
 * `conflict:archive:wn:v1`.
 *
 * Enrichment (lat/lng for the map) lands separately via the intel-news
 * enrich cron — see `api/intel-news/v1/enrich.ts` where the v2 archive
 * key is registered as an extra bucket.
 *
 * Auth: same pattern as the other crons — Bearer CRON_SECRET, or
 * "vercel-cron" user-agent.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { refreshConflictArchiveV2 } from '../../../server/conflict-archive/v2/refresh';

function isAuthorizedCron(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = (req.headers.authorization ?? '') as string;
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = ((req.headers['user-agent'] ?? '') as string).toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!isAuthorizedCron(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }));
    return;
  }

  try {
    const result = await refreshConflictArchiveV2();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[conflict-archive:v2:refresh] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
