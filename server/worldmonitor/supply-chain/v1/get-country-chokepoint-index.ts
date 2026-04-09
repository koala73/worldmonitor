import type {
  ServerContext,
  GetCountryChokepointIndexRequest,
  GetCountryChokepointIndexResponse,
  ChokepointExposureEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { isCallerPremium } from '../../../_shared/premium-check';
import { CHOKEPOINT_EXPOSURE_KEY } from '../../../_shared/cache-keys';
import { CHOKEPOINT_REGISTRY } from '../../../../src/config/chokepoint-registry';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';

const CACHE_TTL = 86400; // 24 hours

interface PortClusterEntry {
  nearestRouteIds: string[];
  coastSide: string;
}

function computeExposures(
  nearestRouteIds: string[],
  hs2: string,
): ChokepointExposureEntry[] {
  const isEnergy = hs2 === '27';
  const routeSet = new Set(nearestRouteIds);

  const entries: ChokepointExposureEntry[] = CHOKEPOINT_REGISTRY.map(cp => {
    const overlap = cp.routeIds.filter(r => routeSet.has(r)).length;
    const maxRoutes = Math.max(cp.routeIds.length, 1);
    let score = (overlap / maxRoutes) * 100;
    // Energy sector: boost shock-model chokepoints by 50% (oil + LNG dependency)
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    return {
      chokepointId: cp.id,
      chokepointName: cp.displayName,
      exposureScore: Math.round(score * 10) / 10,
      coastSide: '',
      shockSupported: cp.shockModelSupported,
    };
  });

  return entries.sort((a, b) => b.exposureScore - a.exposureScore);
}

function vulnerabilityIndex(sorted: ChokepointExposureEntry[]): number {
  const weights = [0.5, 0.3, 0.2];
  const total = sorted.slice(0, 3).reduce((sum, e, i) => sum + e.exposureScore * weights[i]!, 0);
  return Math.round(total * 10) / 10;
}

export async function getCountryChokepointIndex(
  ctx: ServerContext,
  req: GetCountryChokepointIndexRequest,
): Promise<GetCountryChokepointIndexResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    return {
      iso2: req.iso2,
      hs2: req.hs2 || '27',
      exposures: [],
      primaryChokepointId: '',
      vulnerabilityIndex: 0,
      fetchedAt: new Date().toISOString(),
    };
  }

  const iso2 = req.iso2.trim().toUpperCase();
  const hs2 = (req.hs2?.trim() || '27').replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(iso2) || !/^\d{1,2}$/.test(hs2)) {
    return { iso2: req.iso2, hs2: req.hs2 || '27', exposures: [], primaryChokepointId: '', vulnerabilityIndex: 0, fetchedAt: new Date().toISOString() };
  }

  const cacheKey = CHOKEPOINT_EXPOSURE_KEY(iso2, hs2);

  try {
    const result = await cachedFetchJson<GetCountryChokepointIndexResponse>(
      cacheKey,
      CACHE_TTL,
      async () => {
        const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
        const cluster = clusters[iso2];
        const nearestRouteIds = cluster?.nearestRouteIds ?? [];
        const coastSide = cluster?.coastSide ?? 'unknown';

        const exposures = computeExposures(nearestRouteIds, hs2);
        // Attach coastSide only to the top entry
        if (exposures[0]) exposures[0] = { ...exposures[0], coastSide };

        const primaryId = exposures[0]?.chokepointId ?? '';
        const vulnIndex = vulnerabilityIndex(exposures);

        return {
          iso2,
          hs2,
          exposures,
          primaryChokepointId: primaryId,
          vulnerabilityIndex: vulnIndex,
          fetchedAt: new Date().toISOString(),
        };
      },
    );

    return result ?? {
      iso2,
      hs2,
      exposures: [],
      primaryChokepointId: '',
      vulnerabilityIndex: 0,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      iso2,
      hs2,
      exposures: [],
      primaryChokepointId: '',
      vulnerabilityIndex: 0,
      fetchedAt: new Date().toISOString(),
    };
  }
}
