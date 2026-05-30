import type {
  GetResilienceRuntimeManifestResponse,
  ResilienceServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import {
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_INTERVAL_KEY_PREFIX,
  RESILIENCE_INTERVAL_METHODOLOGY,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_META_KEY,
  RESILIENCE_SCHEMA_V2_ENABLED,
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_STATIC_META_KEY,
  getCurrentCacheFormula,
  isEnergyV2Enabled,
  isFinancialSystemExposureEnabled,
  isPillarCombineEnabled,
} from './_shared';

const MANIFEST_VERSION = 1;

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
    deployedCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
    vercelEnv: process.env.VERCEL_ENV ?? '',
    formulaTag: getCurrentCacheFormula(),
    dataVersion: toIsoDate(staticMeta?.fetchedAt),
    flags: [
      { name: 'RESILIENCE_SCHEMA_V2_ENABLED', enabled: RESILIENCE_SCHEMA_V2_ENABLED },
      { name: 'RESILIENCE_PILLAR_COMBINE_ENABLED', enabled: isPillarCombineEnabled() },
      { name: 'RESILIENCE_ENERGY_V2_ENABLED', enabled: isEnergyV2Enabled() },
      { name: 'RESILIENCE_FIN_SYS_EXPOSURE_ENABLED', enabled: isFinancialSystemExposureEnabled() },
    ],
    cache: {
      scorePrefix: RESILIENCE_SCORE_CACHE_PREFIX,
      rankingKey: RESILIENCE_RANKING_CACHE_KEY,
      historyPrefix: RESILIENCE_HISTORY_KEY_PREFIX,
      intervalPrefix: RESILIENCE_INTERVAL_KEY_PREFIX,
      intervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
    },
    rankingCache: {
      fetchedAt: toIsoTimestamp(rankingMeta?.fetchedAt),
      count: safeNonNegativeInteger(rankingMeta?.count),
      scored: safeNonNegativeInteger(rankingMeta?.scored),
      total: safeNonNegativeInteger(rankingMeta?.total),
    },
  };
};
