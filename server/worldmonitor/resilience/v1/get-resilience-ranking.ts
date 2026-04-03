import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceRankingRequest,
  GetResilienceRankingResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  buildRankingItem,
  getCachedResilienceScores,
  listScorableCountries,
  sortRankingItems,
  warmMissingResilienceScores,
} from './_shared';

export const getResilienceRanking: ResilienceServiceHandler['getResilienceRanking'] = async (
  _ctx: ServerContext,
  _req: GetResilienceRankingRequest,
): Promise<GetResilienceRankingResponse> => {
  const cached = await getCachedJson(RESILIENCE_RANKING_CACHE_KEY) as GetResilienceRankingResponse | null;
  if (cached?.items?.length) return cached;

  const countryCodes = await listScorableCountries();
  if (countryCodes.length === 0) return { items: [] };

  const cachedScores = await getCachedResilienceScores(countryCodes);
  const missing = countryCodes.filter((countryCode) => !cachedScores.has(countryCode));
  if (missing.length > 0) {
    void warmMissingResilienceScores(missing).catch((err) => {
      console.warn('[resilience] ranking warmup failed:', err);
    });
  }

  const response: GetResilienceRankingResponse = {
    items: sortRankingItems(
      countryCodes.map((countryCode) => buildRankingItem(countryCode, cachedScores.get(countryCode))),
    ),
  };

  if (missing.length === 0) {
    await setCachedJson(RESILIENCE_RANKING_CACHE_KEY, response, RESILIENCE_RANKING_CACHE_TTL_SECONDS);
  }

  return response;
};
