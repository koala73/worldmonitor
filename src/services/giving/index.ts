import { getRpcBaseUrl } from '@/services/rpc-client';
import type { GetGivingSummaryResponse as ProtoResponse } from '@/generated/client/worldmonitor/giving/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getBootstrapHydrationState, getHydratedData } from '@/services/bootstrap';
import { GivingServiceClient } from '@/services/generated-rpc-clients';
import {
  EMPTY_PROTO_RESPONSE,
  GIVING_BREAKER_CACHE_KEY,
  GIVING_STALE_CEILING_MS,
  classifyGivingResponse,
  isCacheableGivingResponse,
  resolveGivingHydration,
  resolveGivingRefresh,
} from './model';
import type {
  GivingFetchResult,
  GivingRefreshFailure,
  GivingSnapshot,
} from './model';

export * from './model';

const client = new GivingServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});

const breaker = createCircuitBreaker<ProtoResponse>({
  name: 'Global Giving',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
  persistentStaleCeilingMs: GIVING_STALE_CEILING_MS,
});

let lastGoodSnapshot: GivingSnapshot | null = null;
let lastRefreshFailure: GivingRefreshFailure | null = null;
let fetchPromise: Promise<GivingFetchResult> | null = null;

export async function fetchGivingSummary(): Promise<GivingFetchResult> {
  const now = Date.now();
  const hydrated = getHydratedData('giving') as ProtoResponse | undefined;
  if (hydrated) {
    const hydration = resolveGivingHydration(
      hydrated,
      getBootstrapHydrationState().tiers.slow.source,
      now,
    );
    if (hydration.lastGood) lastGoodSnapshot = hydration.lastGood;
    lastRefreshFailure = hydration.refreshFailure;
    if (hydration.immediateResult) return hydration.immediateResult;
  }

  if (fetchPromise) return fetchPromise;

  fetchPromise = (async (): Promise<GivingFetchResult> => {
    let nonV2Refresh: ProtoResponse | null = null;
    const response = await breaker.execute(async () => {
      let responseFailure: GivingRefreshFailure | null = null;
      try {
        const fresh = await client.getGivingSummary({
          platformLimit: 0,
          categoryLimit: 0,
        });
        const classified = classifyGivingResponse(fresh);
        if (classified.kind !== 'v2') {
          nonV2Refresh = fresh;
          responseFailure = classified.kind;
          throw new Error(`Giving refresh returned ${classified.kind} data`);
        }
        lastRefreshFailure = null;
        return fresh;
      } catch (error) {
        lastRefreshFailure = responseFailure ?? 'transport';
        throw error;
      }
    }, EMPTY_PROTO_RESPONSE, {
      cacheKey: GIVING_BREAKER_CACHE_KEY,
      shouldCache: isCacheableGivingResponse,
      staleRefreshMode: 'await',
      forceRefresh: lastRefreshFailure !== null,
    });

    const resolvedAt = Date.now();
    const classified = classifyGivingResponse(response, resolvedAt);
    if (classified.kind === 'v2') {
      lastGoodSnapshot = classified.snapshot;
      if (breaker.getDataState().mode !== 'live' && lastRefreshFailure) {
        return resolveGivingRefresh(null, lastGoodSnapshot, resolvedAt, lastRefreshFailure);
      }
      return resolveGivingRefresh(response, null, resolvedAt, null);
    }

    if (nonV2Refresh) {
      return resolveGivingRefresh(
        nonV2Refresh,
        lastGoodSnapshot,
        resolvedAt,
        lastRefreshFailure,
      );
    }

    const failure = lastRefreshFailure ?? classified.kind;
    return resolveGivingRefresh(null, lastGoodSnapshot, resolvedAt, failure);
  })().finally(() => {
    fetchPromise = null;
  });

  return fetchPromise;
}
