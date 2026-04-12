/**
 * GET /api/supply-chain/v1/get-route-impact
 *
 * Returns strategic-product impact data for a country-pair lane:
 * - Lane value in USD for the selected HS2 (from bilateral-hs4 store)
 * - Top 5 strategic products by import value with chokepoint exposure
 * - Resilience score (server-side, from Redis cache)
 * - Dependency flags (reuses get-sector-dependency logic)
 *
 * PRO-gated. Non-bootstrapped (request-varying cache key).
 */

import type {
  ServerContext,
  GetRouteImpactRequest,
  GetRouteImpactResponse,
  StrategicProduct,
  DependencyFlag,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { lazyFetchBilateralHs4 } from './_bilateral-hs4-lazy';
import { ROUTE_IMPACT_KEY } from '../../../_shared/cache-keys';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../../../_shared/bypass-corridors';
import { RESILIENCE_SCORE_CACHE_PREFIX } from '../../resilience/v1/_shared';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';

const CACHE_TTL_SECONDS = 86400; // 24h

interface PortClusterEntry { nearestRouteIds: string[]; coastSide: string; }

interface ProductExporter {
  partnerCode: number;
  partnerIso2: string;
  value: number;
  share: number;
}

interface CountryProduct {
  hs4: string;
  description: string;
  totalValue: number;
  topExporters: ProductExporter[];
  year: number;
}

interface BilateralHs4Payload {
  iso2: string;
  products: CountryProduct[];
  fetchedAt: string;
}


function hs4ToHs2(hs4: string): string {
  const n = Number.parseInt(hs4.slice(0, 2), 10);
  return String(n);
}

function computePrimaryChokepointId(toIso2: string, hs2: string): string {
  const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
  const cluster = clusters[toIso2];
  if (!cluster?.nearestRouteIds?.length) return '';
  const isEnergy = hs2 === '27';
  const routeSet = new Set(cluster.nearestRouteIds);
  let bestId = '';
  let bestScore = 0;
  for (const cp of CHOKEPOINT_REGISTRY) {
    const overlap = cp.routeIds.filter((r) => routeSet.has(r)).length;
    let score = (overlap / Math.max(cp.routeIds.length, 1)) * 100;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    if (score > bestScore) { bestScore = score; bestId = cp.id; }
  }
  return bestId;
}

function computeRealExposureScore(toIso2: string, hs2: string): { primaryChokepointId: string; primaryExposure: number } {
  const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
  const cluster = clusters[toIso2];
  if (!cluster?.nearestRouteIds?.length) return { primaryChokepointId: '', primaryExposure: 0 };
  const isEnergy = hs2 === '27';
  const routeSet = new Set(cluster.nearestRouteIds);
  let bestId = '';
  let bestScore = 0;
  for (const cp of CHOKEPOINT_REGISTRY) {
    const overlap = cp.routeIds.filter((r) => routeSet.has(r)).length;
    let score = (overlap / Math.max(cp.routeIds.length, 1)) * 100;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    if (score > bestScore) { bestScore = score; bestId = cp.id; }
  }
  return { primaryChokepointId: bestId, primaryExposure: Math.round(bestScore) };
}

function computeDependencyFlags(
  toIso2: string,
  hs2: string,
  primaryExporterShare: number,
): DependencyFlag[] {
  const { primaryChokepointId, primaryExposure } = computeRealExposureScore(toIso2, hs2);
  const flags: DependencyFlag[] = [];
  const singleSource = primaryExporterShare > 0.8;
  const hasViableBypass = primaryChokepointId
    ? (BYPASS_CORRIDORS_BY_CHOKEPOINT[primaryChokepointId] ?? []).length > 0
    : false;
  const singleCorridor = primaryExposure > 80 && !hasViableBypass;

  if (singleSource && singleCorridor) flags.push('DEPENDENCY_FLAG_COMPOUND_RISK');
  else if (singleSource) flags.push('DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL');
  else if (singleCorridor) flags.push('DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL');
  if (hasViableBypass && !singleSource) flags.push('DEPENDENCY_FLAG_DIVERSIFIABLE');
  return flags;
}

function emptyResponse(_req: GetRouteImpactRequest, comtradeSource: string): GetRouteImpactResponse {
  return {
    laneValueUsd: 0,
    primaryExporterIso2: '',
    primaryExporterShare: 0,
    topStrategicProducts: [],
    resilienceScore: 0,
    dependencyFlags: [],
    hs2InSeededUniverse: false,
    comtradeSource,
    fetchedAt: new Date().toISOString(),
  };
}

async function readResilienceScore(iso2: string): Promise<number> {
  try {
    const raw = await getCachedJson(`${RESILIENCE_SCORE_CACHE_PREFIX}${iso2}`, true);
    if (raw && typeof raw === 'object' && 'overallScore' in (raw as object)) {
      return (raw as { overallScore: number }).overallScore;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function computeImpact(req: GetRouteImpactRequest): Promise<GetRouteImpactResponse | null> {
  const fromIso2 = req.fromIso2.trim().toUpperCase();
  const toIso2 = req.toIso2.trim().toUpperCase();
  const hs2 = req.hs2.trim().replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(fromIso2) || !/^[A-Z]{2}$/.test(toIso2)) {
    return emptyResponse(req, 'missing');
  }

  const bilateralKey = `comtrade:bilateral-hs4:${toIso2}:v1`;
  let rawPayload = await getCachedJson(bilateralKey, true).catch(() => null);

  if (!rawPayload) {
    const lazyResult = await lazyFetchBilateralHs4(toIso2);
    if (!lazyResult) {
      // null = sentinel exists (permanent negative) or concurrent fetch in-flight (transient).
      // Return null so cachedFetchJson uses short negative-TTL (120s).
      return null;
    }
    if (lazyResult.products.length === 0) {
      if (lazyResult.comtradeSource === 'lazy' || lazyResult.rateLimited) {
        // Transient: fetch error, timeout, or 429. Short-cache via null.
        return null;
      }
      // Permanent empty: country has no bilateral data in Comtrade. Safe to cache long-term.
      return emptyResponse(req, 'empty');
    }
    rawPayload = { iso2: toIso2, products: lazyResult.products, fetchedAt: new Date().toISOString() };
  }

  const payload = rawPayload as BilateralHs4Payload;
  if (!payload.products?.length) return emptyResponse(req, 'empty');

  const normalizedHs2 = String(Number.parseInt(hs2, 10));
  const matchingHs4s = payload.products.filter((p) => hs4ToHs2(p.hs4) === normalizedHs2);
  const hs2InSeededUniverse = matchingHs4s.length > 0;

  let laneValueUsd = 0;
  let primaryExporterIso2 = '';
  let primaryExporterShare = 0;
  let bestExporterValue = 0;

  for (const product of matchingHs4s) {
    const exporter = product.topExporters.find((e) => e.partnerIso2 === fromIso2);
    if (exporter) {
      laneValueUsd += exporter.value;
      if (exporter.value > bestExporterValue) {
        bestExporterValue = exporter.value;
        primaryExporterIso2 = exporter.partnerIso2;
        primaryExporterShare = exporter.share;
      }
    }
  }

  const sortedProducts = [...payload.products].sort((a, b) => b.totalValue - a.totalValue);
  const top5 = sortedProducts.slice(0, 5);
  const topStrategicProducts: StrategicProduct[] = top5.map((p) => ({
    hs4: p.hs4,
    label: p.description,
    totalValueUsd: p.totalValue,
    topExporterIso2: p.topExporters[0]?.partnerIso2 ?? '',
    topExporterShare: p.topExporters[0]?.share ?? 0,
    primaryChokepointId: computePrimaryChokepointId(toIso2, hs4ToHs2(p.hs4)),
  }));

  const resilienceScore = await readResilienceScore(toIso2);

  const dependencyFlags = computeDependencyFlags(toIso2, hs2, primaryExporterShare);

  return {
    laneValueUsd,
    primaryExporterIso2,
    primaryExporterShare,
    topStrategicProducts,
    resilienceScore,
    dependencyFlags,
    hs2InSeededUniverse,
    comtradeSource: 'bilateral-hs4',
    fetchedAt: new Date().toISOString(),
  };
}

export async function getRouteImpact(
  ctx: ServerContext,
  req: GetRouteImpactRequest,
): Promise<GetRouteImpactResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) return emptyResponse(req, 'missing');

  const fromIso2 = req.fromIso2?.trim().toUpperCase() ?? '';
  const toIso2 = req.toIso2?.trim().toUpperCase() ?? '';
  const hs2 = req.hs2?.trim().replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(fromIso2) || !/^[A-Z]{2}$/.test(toIso2)) {
    return emptyResponse(req, 'missing');
  }

  const cacheKey = ROUTE_IMPACT_KEY(fromIso2, toIso2, hs2);
  const result = await cachedFetchJson<GetRouteImpactResponse>(
    cacheKey,
    CACHE_TTL_SECONDS,
    async () => computeImpact({ fromIso2, toIso2, hs2 }),
  );
  return result ?? emptyResponse(req, 'lazy');
}
