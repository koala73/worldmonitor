/**
 * `GET /api/natural/v1/refresh` — cron-only.
 *
 * Fetches the full natural-events feed (EONET + GDACS + NHC) and writes it to
 * Redis (`natural:events:v1`) plus a freshness marker (`seed-meta:natural:events`).
 * This replaces the GitHub Actions `seed-hourly` job for natural events — the
 * bootstrap endpoint reads `natural:events:v1` directly, and the live handler's
 * `trySeededData()` treats this write as fresh, so the map/feed stay current
 * without the GitHub seed cron.
 *
 * Schedule in vercel.json: hourly. Returns 202 immediately and finishes in the
 * background via `keepAlive` (EONET's 365-day pull + NHC's ArcGIS queries can
 * run past the Edge initial-response cap). The work is idempotent.
 */

import { fetchFreshNaturalEvents } from '../../../server/worldmonitor/natural/v1/list-natural-events';
import { setCachedJson } from '../../../server/_shared/redis';
import { keepAlive } from '../../../server/_shared/keep-alive';

export const config = { runtime: 'edge', maxDuration: 300 };

const CANONICAL_KEY = 'natural:events:v1';
const SEED_META_KEY = 'seed-meta:natural:events';
const DATA_TTL = 21_600;   // 6h — longer than the hourly cron so a late run can't empty the feed
const META_TTL = 604_800;  // 7d

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

async function refreshNaturalEvents(): Promise<{ count: number }> {
  const { events } = await fetchFreshNaturalEvents();
  if (!events.length) {
    // Don't overwrite a good cache with an empty pull (upstream hiccup).
    console.warn('[natural:refresh] 0 events fetched — preserving existing cache');
    return { count: 0 };
  }
  await setCachedJson(CANONICAL_KEY, { events }, DATA_TTL);
  await setCachedJson(SEED_META_KEY, {
    fetchedAt: Date.now(),
    recordCount: events.length,
    sourceVersion: 'vercel-cron:eonet+gdacs+nhc',
  }, META_TTL);
  return { count: events.length };
}

export default async function handler(req: Request): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }
  if (!isAuthorizedCron(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }), { status: 403, headers });
  }

  keepAlive(
    refreshNaturalEvents().then(
      (result) => {
        console.log('[natural:refresh] completed:', JSON.stringify(result));
        return result;
      },
      (err) => {
        console.error('[natural:refresh] background failed:', err instanceof Error ? err.message : err);
      },
    ),
    'natural-refresh',
  );

  return new Response(
    JSON.stringify({ status: 'queued', startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
