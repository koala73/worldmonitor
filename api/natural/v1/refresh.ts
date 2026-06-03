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
 * Runs on the NODE runtime (not Edge): GDACS (and occasionally EONET) fetches
 * fail silently on the Edge runtime — droughts/storms sourced from GDACS were
 * coming back empty there. Node matches the old GitHub seeder where GDACS works.
 * Completes synchronously within maxDuration (EONET + GDACS + NHC finish in well
 * under it); no background/keepAlive needed. Idempotent.
 */

import {
  fetchNaturalEventsBySource,
  mergeNaturalEvents,
  naturalEventSource,
} from '../../../server/worldmonitor/natural/v1/list-natural-events';
import { setCachedJson, getCachedJson } from '../../../server/_shared/redis';

export const config = { runtime: 'nodejs', maxDuration: 300 };

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

async function refreshNaturalEvents(): Promise<{ count: number; preserved: string[] }> {
  // Read the current cache and split it back into per-source slices.
  const existing = (await getCachedJson(CANONICAL_KEY)) as { events?: any[] } | null;
  const existingEvents = Array.isArray(existing?.events) ? existing!.events! : [];
  const existingBySource = {
    eonet: existingEvents.filter((e) => naturalEventSource(e) === 'eonet'),
    gdacs: existingEvents.filter((e) => naturalEventSource(e) === 'gdacs'),
    nhc: existingEvents.filter((e) => naturalEventSource(e) === 'nhc'),
  };

  // Fetch every source independently. For each source, use the FRESH slice if it
  // came back OK; if that source's upstream failed (e.g. EONET 503), KEEP its
  // previous cached slice. So one source's outage only freezes its own part —
  // the rest still update, and nothing is ever dropped to a handful of events.
  const fresh = await fetchNaturalEventsBySource();
  const preserved: string[] = [];
  const pick = (src: 'eonet' | 'gdacs' | 'nhc') => {
    if (fresh[src] !== null) return fresh[src] as any[];
    preserved.push(src);
    return existingBySource[src];
  };

  const merged = mergeNaturalEvents(pick('nhc'), pick('gdacs'), pick('eonet'));

  if (!merged.length) {
    // All sources failed AND no prior cache — leave whatever's there untouched.
    console.warn('[natural:refresh] empty merge with no cache — leaving existing data');
    return { count: existingEvents.length, preserved };
  }

  await setCachedJson(CANONICAL_KEY, { events: merged }, DATA_TTL);
  await setCachedJson(SEED_META_KEY, {
    fetchedAt: Date.now(),
    recordCount: merged.length,
    sourceVersion: preserved.length
      ? `vercel-cron:partial(preserved=${preserved.join('+')})`
      : 'vercel-cron:eonet+gdacs+nhc',
  }, META_TTL);
  return { count: merged.length, preserved };
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
    const result = await refreshNaturalEvents();
    console.log('[natural:refresh] completed:', JSON.stringify(result));
    return new Response(JSON.stringify({ status: 'ok', ...result }), { status: 200, headers });
  } catch (err) {
    console.error('[natural:refresh] failed:', err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers },
    );
  }
}
