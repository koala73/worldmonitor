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
  _ctx: ServerContext,
  _req: GetResilienceRankingRequest,
): Promise<GetResilienceRankingResponse> => {
  const cached = await getCachedJson(RESILIENCE_RANKING_CACHE_KEY) as GetResilienceRankingResponse | null;
  if (cached != null && (cached.items.length > 0 || (cached.greyedOut?.length ?? 0) > 0)) return cached;

  const countryCodes = await listScorableCountries();
  if (countryCodes.length === 0) return { items: [], greyedOut: [] };

  let cachedScores = await getCachedResilienceScores(countryCodes);
  const missing = countryCodes.filter((countryCode) => !cachedScores.has(countryCode));
  if (missing.length > 0) {
    try {
      await warmMissingResilienceScores(missing.slice(0, SYNC_WARM_LIMIT));
      cachedScores = await getCachedResilienceScores(countryCodes);
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
    await runRedisPipeline([
      ['SET', RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(response), 'EX', RESILIENCE_RANKING_CACHE_TTL_SECONDS],
      ['SET', RESILIENCE_RANKING_META_KEY, JSON.stringify({
        fetchedAt: Date.now(),
        count: response.items.length + response.greyedOut.length,
        scored: cachedScores.size,
        total: countryCodes.length,
      }), 'EX', RESILIENCE_RANKING_META_TTL_SECONDS],
    ]);
  } else {
    console.warn(`[resilience] ranking not cached — coverage ${cachedScores.size}/${countryCodes.length} below ${RANKING_CACHE_MIN_COVERAGE * 100}% threshold`);
  }

  return response;
};
