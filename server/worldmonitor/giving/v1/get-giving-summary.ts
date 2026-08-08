/**
 * GetGivingSummary serves a cacheable snapshot of published giving claims.
 *
 * Source periods, qualifiers, currencies, and verification status live in the
 * checked-in claim registry. generatedAt/fetchedAt remain response/cache
 * materialization times and are never substituted for source dates.
 */

import type {
  ServerContext,
  GetGivingSummaryRequest,
  GetGivingSummaryResponse,
  GivingSummary,
} from '../../../../src/generated/server/worldmonitor/giving/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { buildPublishedEstimateSummary } from './published-estimates';

const REDIS_CACHE_KEY = 'giving:summary:v2';
const REDIS_CACHE_TTL = 3600; // 1 hour

function responseFetchedAt(summary: GivingSummary | undefined): number {
  const parsed = summary?.generatedAt ? Date.parse(summary.generatedAt) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function getGivingSummary(
  _ctx: ServerContext,
  req: GetGivingSummaryRequest,
): Promise<GetGivingSummaryResponse> {
  try {
    const result = await cachedFetchJson<GetGivingSummaryResponse>(REDIS_CACHE_KEY, REDIS_CACHE_TTL, async () => {
      const summary = buildPublishedEstimateSummary();
      return { summary, fetchedAt: responseFetchedAt(summary), dataAvailable: true };
    });

    if (!result) {
      return { summary: undefined as unknown as GivingSummary, fetchedAt: 0, dataAvailable: false };
    }

    const summary = result.summary;
    if (!summary) {
      return { summary, fetchedAt: 0, dataAvailable: false };
    }

    // Limits project only the response arrays. The highlighted aggregate and
    // provenance intentionally continue to describe the full cached snapshot.
    return {
      summary: {
        ...summary,
        platforms: req.platformLimit > 0 && summary.platforms
          ? summary.platforms.slice(0, req.platformLimit)
          : summary.platforms,
        categories: req.categoryLimit > 0 && summary.categories
          ? summary.categories.slice(0, req.categoryLimit)
          : summary.categories,
      },
      fetchedAt: result.fetchedAt || responseFetchedAt(summary),
      dataAvailable: true,
    };
  } catch {
    return { summary: undefined as unknown as GivingSummary, fetchedAt: 0, dataAvailable: false };
  }
}
