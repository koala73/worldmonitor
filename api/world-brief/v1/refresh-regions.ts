/**
 * `GET /api/world-brief/v1/refresh-regions` — cron-only, hourly.
 *
 * The region-major dispatcher. Reads the current UTC hour and (re)generates
 * the regional briefs scheduled for it (see REGION_SCHEDULE in _dispatch.ts);
 * each region is written to `news:world-brief:region:<id>:v1`. Most hours have
 * 0 regions due and the route no-ops. Like the global brief refresh it returns
 * 202 and finishes in the background via `keepAlive` (sequential Gemini calls
 * can run past the 25s Edge initial-response cap). Idempotent.
 *
 * Schedule in vercel.json: hourly at :20 (after the :09 enrich + :12 global
 * brief, so the digest's `country` fields are fresh).
 */

import { refreshDueRegions, regionsDueAt } from '../../../server/world-brief/v1/_dispatch';
import { keepAlive } from '../../../server/_shared/keep-alive';

export const config = { runtime: 'edge', maxDuration: 300 };

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

  const utcHour = new Date().getUTCHours();
  const due = regionsDueAt(utcHour);

  // Most hours nothing is scheduled — cheap no-op.
  if (due.length === 0) {
    return new Response(JSON.stringify({ status: 'idle', utcHour, due: [] }), { status: 200, headers });
  }

  keepAlive(
    refreshDueRegions(utcHour).then(
      (result) => {
        console.log('[world-brief:refresh-regions] completed:', JSON.stringify(result.due));
        return result;
      },
      (err) => {
        console.error('[world-brief:refresh-regions] background failed:', err instanceof Error ? err.message : err);
      },
    ),
    'world-brief-refresh-regions',
  );

  return new Response(
    JSON.stringify({ status: 'queued', utcHour, due, startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
