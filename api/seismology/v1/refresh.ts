/**
 * `GET /api/seismology/v1/refresh` — cron-only.
 *
 * Fetches the USGS earthquake feed and writes it to Redis
 * (`seismology:earthquakes:v1`) plus a freshness marker
 * (`seed-meta:seismology:earthquakes`). Replaces the GitHub Actions
 * `seed-core` earthquake step — bootstrap reads the key directly and the live
 * handler's `trySeededData()` treats this write as fresh.
 *
 * Schedule in vercel.json: every 30 min. Returns 202 immediately and finishes
 * in the background via `keepAlive`. Idempotent.
 */

import { fetchFreshEarthquakes } from '../../../server/worldmonitor/seismology/v1/list-earthquakes';
import { setCachedJson } from '../../../server/_shared/redis';
import { keepAlive } from '../../../server/_shared/keep-alive';

export const config = { runtime: 'edge', maxDuration: 120 };

const CANONICAL_KEY = 'seismology:earthquakes:v1';
const SEED_META_KEY = 'seed-meta:seismology:earthquakes';
const DATA_TTL = 3600;     // 1h — longer than the 30-min cron so a late run can't empty the feed
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

async function refreshEarthquakes(): Promise<{ count: number }> {
  const { earthquakes } = await fetchFreshEarthquakes();
  if (!earthquakes.length) {
    console.warn('[seismology:refresh] 0 earthquakes fetched — preserving existing cache');
    return { count: 0 };
  }
  await setCachedJson(CANONICAL_KEY, { earthquakes }, DATA_TTL);
  await setCachedJson(SEED_META_KEY, {
    fetchedAt: Date.now(),
    recordCount: earthquakes.length,
    sourceVersion: 'vercel-cron:usgs-2.5-month',
  }, META_TTL);
  return { count: earthquakes.length };
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
    refreshEarthquakes().then(
      (result) => {
        console.log('[seismology:refresh] completed:', JSON.stringify(result));
        return result;
      },
      (err) => {
        console.error('[seismology:refresh] background failed:', err instanceof Error ? err.message : err);
      },
    ),
    'seismology-refresh',
  );

  return new Response(
    JSON.stringify({ status: 'queued', startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
