/**
 * RPC: getHumanitarianSummaryBatch -- reads the humanitarian summary cache
 * that scripts/seed-conflict-intel.mjs populates from HDX HAPI.
 *
 * Deliberately does NOT call HAPI directly on a cache miss -- see
 * get-humanitarian-summary.ts for why (HDX's app_identifier rate limiting is
 * per-identifier, not per-IP -- #5554). This handler previously fanned a
 * miss out to up to 25 concurrent direct HAPI fetches per request, which was
 * the single biggest contributor to the traffic burst that got the identifier
 * throttled. A miss here now just means the country isn't in the seeder's
 * country set yet or hasn't been seeded this cycle.
 */

import type {
  ServerContext,
  GetHumanitarianSummaryBatchRequest,
  GetHumanitarianSummaryBatchResponse,
  HumanitarianCountrySummary,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getCachedJsonBatch } from '../../../_shared/redis';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';

const REDIS_CACHE_KEY = 'conflict:humanitarian:v1';
const ISO2_PATTERN = /^[A-Z]{2}$/;

export async function getHumanitarianSummaryBatch(
  _ctx: ServerContext,
  req: GetHumanitarianSummaryBatchRequest,
): Promise<GetHumanitarianSummaryBatchResponse> {
  try {
    const normalized = req.countryCodes
      .map((c) => c.trim().toUpperCase())
      .filter((c) => ISO2_PATTERN.test(c));
    const limitedList = toUniqueSortedLimited(normalized, 25);

    const results: Record<string, HumanitarianCountrySummary> = {};
    const cacheKeys = limitedList.map((cc) => `${REDIS_CACHE_KEY}:${cc}`);
    const cachedMap = await getCachedJsonBatch(cacheKeys);

    for (let i = 0; i < limitedList.length; i++) {
      const cc = limitedList[i]!;
      const cached = cachedMap.get(cacheKeys[i]!) as { summary?: HumanitarianCountrySummary } | undefined;
      if (cached?.summary) results[cc] = cached.summary;
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0 };
  }
}
