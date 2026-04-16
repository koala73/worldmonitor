import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceRankingRequest,
  GetResilienceRankingResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson, runRedisPipeline } from '../../../_shared/redis';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';
import {
  GREY_OUT_COVERAGE_THRESHOLD,
  RESILIENCE_INTERVAL_KEY_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  buildRankingItem,
  getCachedResilienceScores,
  listScorableCountries,
  sortRankingItems,
  warmMissingResilienceScores,
  type ScoreInterval,
} from './_shared';

const RESILIENCE_RANKING_META_KEY = 'seed-meta:resilience:ranking';
const RESILIENCE_RANKING_META_TTL_SECONDS = 7 * 24 * 60 * 60;

// Hard ceiling on one synchronous warm pass — purely a safety net against a
// runaway static index. The shared memoized reader means global Redis keys are
// fetched once total (not once per country), so the Upstash burst is
//   17 shared reads + N×3 per-country reads + N pipeline writes
// and wall time does NOT scale with N because all countries run via
// Promise.allSettled in parallel; it is bounded by ~2-3 sequential RTTs within
// one country (~60-150 ms). 1000 is several multiples above the current static
// index (~222 countries) so every warm pass is unconditionally complete.
const SYNC_WARM_LIMIT = 1000;

// Minimum fraction of scorable countries that must have a cached score before we
// persist the ranking to Redis. Prevents a cold-start (0% cached) from being
// locked in, while still allowing partial-state writes (e.g. 90%) to succeed so
// the next call doesn't re-warm everything. This is a safety rail against genuine
// warm failures (Redis blips, data gaps) — it must NOT be tripped by the handler
// capping how many countries it attempts. See SYNC_WARM_LIMIT above.
const RANKING_CACHE_MIN_COVERAGE = 0.75;

async function fetchIntervals(countryCodes: string[]): Promise<Map<string, ScoreInterval>> {
  if (countryCodes.length === 0) return new Map();
  const results = await runRedisPipeline(countryCodes.map((cc) => ['GET', `${RESILIENCE_INTERVAL_KEY_PREFIX}${cc}`]), true);
  const map = new Map<string, ScoreInterval>();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try {
      // Envelope-aware: interval keys come through seed-resilience-scores' extra-key path.
      const parsed = unwrapEnvelope(JSON.parse(raw)).data as { p05?: number; p95?: number } | null;
      if (parsed && typeof parsed.p05 === 'number' && typeof parsed.p95 === 'number') {
        map.set(countryCodes[i]!, { p05: parsed.p05, p95: parsed.p95 });
      }
    } catch { /* ignore malformed interval entries */ }
  }
  return map;
}

export const getResilienceRanking: ResilienceServiceHandler['getResilienceRanking'] = async (
  ctx: ServerContext,
  _req: GetResilienceRankingRequest,
): Promise<GetResilienceRankingResponse> => {
  // ?refresh=1 forces a full recompute-and-publish instead of returning the
  // existing cache. It is seed-service-only: a full warm is expensive (~222
  // score computations + chunked pipeline SETs) and an unauthenticated or
  // Pro-bearer caller looping on refresh=1 could DoS Upstash quota and Edge
  // budget. Gated on a valid seed API key in X-WorldMonitor-Key (the same
  // WORLDMONITOR_VALID_KEYS list the cron uses). Pro bearer tokens do NOT
  // grant refresh — they get the standard cache-first path.
  const forceRefresh = (() => {
    try {
      if (new URL(ctx.request.url).searchParams.get('refresh') !== '1') return false;
    } catch { return false; }
    const wmKey = ctx.request.headers.get('X-WorldMonitor-Key') ?? '';
    if (!wmKey) return false;
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    const apiKey = process.env.WORLDMONITOR_API_KEY ?? '';
    const allowed = new Set(validKeys);
    if (apiKey) allowed.add(apiKey);
    if (!allowed.has(wmKey)) {
      console.warn('[resilience] refresh=1 rejected: X-WorldMonitor-Key not in seed allowlist');
      return false;
    }
    return true;
  })();
  if (!forceRefresh) {
    const cached = await getCachedJson(RESILIENCE_RANKING_CACHE_KEY) as GetResilienceRankingResponse | null;
    if (cached != null && (cached.items.length > 0 || (cached.greyedOut?.length ?? 0) > 0)) return cached;
  }

  const countryCodes = await listScorableCountries();
  if (countryCodes.length === 0) return { items: [], greyedOut: [] };

  const cachedScores = await getCachedResilienceScores(countryCodes);
  const missing = countryCodes.filter((countryCode) => !cachedScores.has(countryCode));
  if (missing.length > 0) {
    try {
      // Merge warm results into cachedScores directly rather than re-reading
      // from Redis. Upstash REST writes (/set) aren't always visible to an
      // immediately-following /pipeline GET in the same Vercel invocation,
      // which collapsed coverage to 0/N and silently dropped the ranking
      // publish. The warmer already holds every score in memory — trust it.
      // See `feedback_upstash_write_reread_race_in_handler.md`.
      const warmed = await warmMissingResilienceScores(missing.slice(0, SYNC_WARM_LIMIT));
      for (const [countryCode, score] of warmed) cachedScores.set(countryCode, score);
    } catch (err) {
      console.warn('[resilience] ranking warmup failed:', err);
    }
  }

  const intervals = await fetchIntervals([...cachedScores.keys()]);
  const allItems = countryCodes.map((countryCode) => buildRankingItem(countryCode, cachedScores.get(countryCode), intervals.get(countryCode)));
  const response: GetResilienceRankingResponse = {
    items: sortRankingItems(allItems.filter((item) => item.overallCoverage >= GREY_OUT_COVERAGE_THRESHOLD)),
    greyedOut: allItems.filter((item) => item.overallCoverage < GREY_OUT_COVERAGE_THRESHOLD),
  };

  // Cache the ranking when we have substantive coverage — don't hold out for 100%.
  // The previous gate (stillMissing === 0) meant a single failing-to-warm country
  // permanently blocked the write, leaving the cache null for days while the 6h TTL
  // expired between cron ticks. Countries that fail to warm already land in
  // `greyedOut` with coverage 0, so the response is correct for partial states.
  const coverageRatio = cachedScores.size / countryCodes.length;
  if (coverageRatio >= RANKING_CACHE_MIN_COVERAGE) {
    // Upstash REST /pipeline is not transactional: each SET can succeed or
    // fail independently. A partial write (ranking OK, meta missed) would
    // leave health.js reading a stale meta over a fresh ranking — the seeder
    // self-heal here ensures we at least log it, and the seeder also verifies
    // BOTH keys post-refresh. If either SET didn't return OK we log a warning
    // that ops can grep for, rather than silently succeeding.
    const pipelineResult = await runRedisPipeline([
      ['SET', RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(response), 'EX', RESILIENCE_RANKING_CACHE_TTL_SECONDS],
      ['SET', RESILIENCE_RANKING_META_KEY, JSON.stringify({
        fetchedAt: Date.now(),
        count: response.items.length + response.greyedOut.length,
        scored: cachedScores.size,
        total: countryCodes.length,
      }), 'EX', RESILIENCE_RANKING_META_TTL_SECONDS],
    ]);
    const rankingOk = pipelineResult[0]?.result === 'OK';
    const metaOk = pipelineResult[1]?.result === 'OK';
    if (!rankingOk || !metaOk) {
      console.warn(`[resilience] ranking publish partial: ranking=${rankingOk ? 'OK' : 'FAIL'} meta=${metaOk ? 'OK' : 'FAIL'}`);
    }
  } else {
    console.warn(`[resilience] ranking not cached — coverage ${cachedScores.size}/${countryCodes.length} below ${RANKING_CACHE_MIN_COVERAGE * 100}% threshold`);
  }

  return response;
};
