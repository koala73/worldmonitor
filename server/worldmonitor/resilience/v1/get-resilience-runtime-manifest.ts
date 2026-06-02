import type {
  GetResilienceRuntimeManifestResponse,
  ResilienceServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import {
  RESILIENCE_RANKING_META_KEY,
  RESILIENCE_STATIC_META_KEY,
  getCurrentCacheFormula,
  isEnergyV2Enabled,
} from './_shared';

const MANIFEST_VERSION = 3;

const PUBLIC_CACHE_STATE = {
  scorePrefix: '',
  rankingKey: '',
  historyPrefix: '',
  intervalPrefix: '',
  intervalMethodology: '',
};

function getConstructVersions(): { energy: 'legacy' | 'v2' } {
  return {
    energy: isEnergyV2Enabled() ? 'v2' : 'legacy',
  };
}

interface SeedMeta {
  fetchedAt?: unknown;
}

interface RankingMeta {
  fetchedAt?: unknown;
  count?: unknown;
  scored?: unknown;
  total?: unknown;
}

function toIsoDate(value: unknown): string {
  const iso = toIsoTimestamp(value);
  return iso ? iso.slice(0, 10) : '';
}

function toIsoTimestamp(value: unknown): string {
  const date = typeof value === 'number' || typeof value === 'string'
    ? new Date(value)
    : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return date.toISOString();
}

function safeNonNegativeInteger(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.trunc(num);
}

export const getResilienceRuntimeManifest: ResilienceServiceHandler['getResilienceRuntimeManifest'] = async (
  ctx: ServerContext,
): Promise<GetResilienceRuntimeManifestResponse> => {
  markNoCacheResponse(ctx.request);

  const [staticMeta, rankingMeta] = await Promise.all([
    getCachedJson(RESILIENCE_STATIC_META_KEY, true) as Promise<SeedMeta | null>,
    getCachedJson(RESILIENCE_RANKING_META_KEY, true) as Promise<RankingMeta | null>,
  ]);

  return {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    deployedCommitSha: '',
    vercelEnv: '',
    formulaTag: getCurrentCacheFormula(),
    dataVersion: toIsoDate(staticMeta?.fetchedAt),
    flags: [],
    cache: PUBLIC_CACHE_STATE,
    rankingCache: {
      fetchedAt: toIsoTimestamp(rankingMeta?.fetchedAt),
      count: safeNonNegativeInteger(rankingMeta?.count),
      scored: safeNonNegativeInteger(rankingMeta?.scored),
      total: safeNonNegativeInteger(rankingMeta?.total),
    },
    constructVersions: getConstructVersions(),
  };
};
