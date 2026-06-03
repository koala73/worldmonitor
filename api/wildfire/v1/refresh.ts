/**
 * `GET /api/wildfire/v1/refresh` — cron-only.
 *
 * Fetches NASA FIRMS active-fire detections (all monitored regions, FRP-capped)
 * and writes them to Redis (`wildfire:fires:v1`) plus a freshness marker
 * (`seed-meta:wildfire:fires`). Replaces the GitHub Actions `seed-extended`
 * fire-detections step — bootstrap reads the key directly and the live handler's
 * seed check treats this write as fresh.
 *
 * Needs `NASA_FIRMS_API_KEY` in the Vercel environment. Schedule in vercel.json:
 * hourly (inside the handler's 90-min freshness window). Returns 202 and finishes
 * in the background via `keepAlive`. Idempotent.
 */

import { fetchFreshFireDetections } from '../../../server/worldmonitor/wildfire/v1/list-fire-detections';
import { setCachedJson } from '../../../server/_shared/redis';
import { keepAlive } from '../../../server/_shared/keep-alive';

export const config = { runtime: 'edge', maxDuration: 300 };

const CANONICAL_KEY = 'wildfire:fires:v1';
const SEED_META_KEY = 'seed-meta:wildfire:fires';
const DATA_TTL = 10_800;   // 3h — longer than the hourly cron + FIRMS NRT update cadence
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

async function refreshFireDetections(): Promise<{ count: number }> {
  const { fireDetections } = await fetchFreshFireDetections();
  if (!fireDetections.length) {
    // Either no key configured or an upstream hiccup — don't clobber a good cache.
    console.warn('[wildfire:refresh] 0 fire detections — preserving existing cache');
    return { count: 0 };
  }
  await setCachedJson(CANONICAL_KEY, { fireDetections }, DATA_TTL);
  await setCachedJson(SEED_META_KEY, {
    fetchedAt: Date.now(),
    recordCount: fireDetections.length,
    sourceVersion: 'vercel-cron:firms-viirs-snpp',
  }, META_TTL);
  return { count: fireDetections.length };
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
    refreshFireDetections().then(
      (result) => {
        console.log('[wildfire:refresh] completed:', JSON.stringify(result));
        return result;
      },
      (err) => {
        console.error('[wildfire:refresh] background failed:', err instanceof Error ? err.message : err);
      },
    ),
    'wildfire-refresh',
  );

  return new Response(
    JSON.stringify({ status: 'queued', startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
