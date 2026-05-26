import type {
  ServerContext,
  RouteIntelligenceRequest,
  RouteIntelligenceResponse,
  ChokepointExposure,
  BypassOption,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import {
  ApiError,
  ValidationError,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson } from '../../../_shared/redis';
import { CHOKEPOINT_STATUS_KEY } from '../../../_shared/cache-keys';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT, type CargoType } from '../../../_shared/bypass-corridors';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';

interface PortClusterEntry {
  nearestRouteIds: string[];
  coastSide: string;
}

interface ChokepointStatusEntry {
  id: string;
  name?: string;
  disruptionScore?: number;
  warRiskTier?: string;
}

interface ChokepointStatusResponse {
  chokepoints?: ChokepointStatusEntry[];
}

const VALID_CARGO_TYPES = new Set(['container', 'tanker', 'bulk', 'roro']);

export async function routeIntelligence(
  ctx: ServerContext,
  req: RouteIntelligenceRequest,
): Promise<RouteIntelligenceResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    throw new ApiError(403, 'PRO subscription required', '');
  }

  const fromIso2 = (req.fromIso2 ?? '').trim().toUpperCase();
  const toIso2 = (req.toIso2 ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(fromIso2) || !/^[A-Z]{2}$/.test(toIso2)) {
    throw new ValidationError([
      { field: 'fromIso2', description: 'fromIso2 and toIso2 must be valid 2-letter ISO country codes' },
    ]);
  }

  const cargoTypeRaw = (req.cargoType ?? '').trim().toLowerCase();
  const cargoType: CargoType = (VALID_CARGO_TYPES.has(cargoTypeRaw) ? cargoTypeRaw : 'container') as CargoType;
  const hs2 = (req.hs2 ?? '').trim().replace(/\D/g, '') || '27';

  const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
  const fromCluster = clusters[fromIso2];
  const toCluster = clusters[toIso2];

  const fromRoutes = new Set(fromCluster?.nearestRouteIds ?? []);
  const toRoutes = new Set(toCluster?.nearestRouteIds ?? []);
  const sharedRoutes = [...fromRoutes].filter(r => toRoutes.has(r));
  const primaryRouteId = sharedRoutes[0] ?? fromCluster?.nearestRouteIds[0] ?? '';

  const statusRaw = (await getCachedJson(CHOKEPOINT_STATUS_KEY).catch(() => null)) as ChokepointStatusResponse | null;
  const statusMap = new Map<string, ChokepointStatusEntry>(
    (statusRaw?.chokepoints ?? []).map(cp => [cp.id, cp]),
  );

  const relevantRouteSet = new Set(sharedRoutes.length ? sharedRoutes : (fromCluster?.nearestRouteIds ?? []));
  const chokepointExposures: ChokepointExposure[] = CHOKEPOINT_REGISTRY
    .filter(cp => cp.routeIds.some(r => relevantRouteSet.has(r)))
    .map(cp => {
      const overlap = cp.routeIds.filter(r => relevantRouteSet.has(r)).length;
      const exposurePct = Math.round((overlap / Math.max(cp.routeIds.length, 1)) * 100);
      return { chokepointId: cp.id, chokepointName: cp.displayName, exposurePct };
    })
    .filter(e => e.exposurePct > 0)
    .sort((a, b) => b.exposurePct - a.exposurePct);

  const primaryChokepoint = chokepointExposures[0];
  const primaryCpStatus = primaryChokepoint ? statusMap.get(primaryChokepoint.chokepointId) : null;

  const disruptionScore = primaryCpStatus?.disruptionScore ?? 0;
  const warRiskTier = primaryCpStatus?.warRiskTier ?? 'WAR_RISK_TIER_NORMAL';

  const bypassOptions: BypassOption[] = primaryChokepoint
    ? (BYPASS_CORRIDORS_BY_CHOKEPOINT[primaryChokepoint.chokepointId] ?? [])
        .filter(c => c.suitableCargoTypes.length === 0 || c.suitableCargoTypes.includes(cargoType))
        .slice(0, 5)
        .map(c => ({
          id: c.id,
          name: c.name,
          type: c.type,
          addedTransitDays: c.addedTransitDays,
          addedCostMultiplier: c.addedCostMultiplier,
          activationThreshold: c.activationThreshold,
        }))
    : [];

  return {
    fromIso2,
    toIso2,
    cargoType,
    hs2,
    primaryRouteId,
    chokepointExposures,
    bypassOptions,
    warRiskTier,
    disruptionScore,
    fetchedAt: new Date().toISOString(),
  };
}
