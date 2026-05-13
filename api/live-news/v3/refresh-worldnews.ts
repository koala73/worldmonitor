/**
 * `GET /api/live-news/v3/refresh-worldnews` — cron-only endpoint.
 *
 * Runs every 5 minutes via Vercel cron. Pulls clustered top stories
 * from the World News API and merges them into the
 * `live-news:wn:v1:digest` Redis accumulator. The read endpoint at
 * `/api/live-news/v3/list-us-headlines` serves whatever's in that key.
 *
 * Auth: same pattern as `/api/intel-news/v1/refresh` — accepts a Bearer
 * CRON_SECRET header, or any caller whose user-agent contains
 * "vercel-cron". Locked-down for everyone else.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { refreshLiveNewsV3 } from '../../../server/live-news/v3/refresh';

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
    const result = await refreshLiveNewsV3();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[live-news:v3:refresh] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
