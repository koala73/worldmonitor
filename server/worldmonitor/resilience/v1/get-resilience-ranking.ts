import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceRankingRequest,
  GetResilienceRankingResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson, runRedisPipeline } from '../../../_shared/redis';
import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  buildRankingItem,
  getCachedResilienceScores,
  listScorableCountries,
  sortRankingItems,
  warmMissingResilienceScores,
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

export const getResilienceRanking: ResilienceServiceHandler['getResilienceRanking'] = async (
  _ctx: ServerContext,
  _req: GetResilienceRankingRequest,
): Promise<GetResilienceRankingResponse> => {
  const cached = await getCachedJson(RESILIENCE_RANKING_CACHE_KEY) as GetResilienceRankingResponse | null;
  if (cached?.items?.length) return cached;

  const countryCodes = await listScorableCountries();
  if (countryCodes.length === 0) return { items: [] };

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

  const response: GetResilienceRankingResponse = {
    items: sortRankingItems(
      countryCodes.map((countryCode) => buildRankingItem(countryCode, cachedScores.get(countryCode))),
    ),
  };

  const stillMissing = countryCodes.filter((countryCode) => !cachedScores.has(countryCode));
  if (stillMissing.length === 0) {
    await runRedisPipeline([
      ['SET', RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(response), 'EX', RESILIENCE_RANKING_CACHE_TTL_SECONDS],
      ['SET', RESILIENCE_RANKING_META_KEY, JSON.stringify({ fetchedAt: Date.now(), count: response.items.length }), 'EX', RESILIENCE_RANKING_META_TTL_SECONDS],
    ]);
  }

  return response;
};
