import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceRankingRequest,
  GetResilienceRankingResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson, runRedisPipeline } from '../../../_shared/redis';
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

// How many missing countries to score synchronously per ranking request.
// The shared memoized reader means global Redis keys are fetched once total
// (not once per country), so the actual Upstash burst is:
//   17 shared reads + N×3 per-country reads + N pipeline writes
// Wall time does NOT scale with N because all countries run via Promise.allSettled
// in parallel; it is bounded by ~2-3 sequential RTTs within one country (~60-150 ms).
// 200 covers the full static index (~130-180 countries) in a single cold-cache pass.
const SYNC_WARM_LIMIT = 200;

async function fetchIntervals(countryCodes: string[]): Promise<Map<string, ScoreInterval>> {
  if (countryCodes.length === 0) return new Map();
  const results = await runRedisPipeline(countryCodes.map((cc) => ['GET', `${RESILIENCE_INTERVAL_KEY_PREFIX}${cc}`]), true);
  const map = new Map<string, ScoreInterval>();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw) as { p05?: number; p95?: number };
      if (typeof parsed.p05 === 'number' && typeof parsed.p95 === 'number') {
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

  const stillMissing = countryCodes.filter((countryCode) => !cachedScores.has(countryCode));
  if (stillMissing.length === 0) {
    await runRedisPipeline([
      ['SET', RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(response), 'EX', RESILIENCE_RANKING_CACHE_TTL_SECONDS],
      ['SET', RESILIENCE_RANKING_META_KEY, JSON.stringify({ fetchedAt: Date.now(), count: response.items.length + response.greyedOut.length }), 'EX', RESILIENCE_RANKING_META_TTL_SECONDS],
    ]);
  }

  return response;
};
