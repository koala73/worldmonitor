/**
 * GET /api/supply-chain/v1/get-route-explorer-lane
 *
 * Internal wrapper around the vendor-only `route-intelligence` compute. Adds:
 *   - Browser-callable PRO gating via `premium-paths.ts` (no forceKey API-key gate)
 *   - `primaryRouteGeometry` polyline for map rendering
 *   - `fromPort` / `toPort` on every bypass option (so the client can feed
 *     `MapContainer.setBypassRoutes` directly without its own geometry lookup)
 *   - `status: 'active' | 'proposed' | 'unavailable'` per corridor, derived
 *     from the `notes` field to honestly label `kra_canal_future` and
 *     `black_sea_western_ports`
 *   - Static `estTransitDaysRange` and `estFreightUsdPerTeuRange` from
 *     hand-curated tables
 *   - `noModeledLane: true` when we fell back to the origin's first route
 *     because origin and destination clusters share no routes
 *
 * This handler is called through the supply-chain service dispatcher, NOT as
 * an edge function — so it receives a `ServerContext` and a typed request.
 */

import type {
  ServerContext,
  GetRouteExplorerLaneRequest,
  GetRouteExplorerLaneResponse,
  GeoPoint,
  CorridorStatus,
  BypassCorridorOption,
  ChokepointExposureSummary,
  NumberRange,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { ROUTE_EXPLORER_LANE_KEY } from '../../../_shared/cache-keys';
import { CHOKEPOINT_STATUS_KEY } from '../../../_shared/cache-keys';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../../../_shared/bypass-corridors';
import type { BypassCorridor, CargoType } from '../../../_shared/bypass-corridors';
import { TIER_RANK } from './_insurance-tier';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';
import { TRADE_ROUTES } from '../../../../src/config/trade-routes';
import { PORTS } from '../../../../src/config/ports';
import {
  TRANSIT_DAYS_BY_ROUTE_ID,
  TRANSIT_DAYS_FALLBACK,
  FREIGHT_USD_BY_CARGO_TYPE,
  FREIGHT_USD_FALLBACK,
  getCorridorGeometryOrFallback,
} from './_route-explorer-static-tables';

const CACHE_TTL_SECONDS = 60; // matches vendor endpoint cadence

interface PortClusterEntry {
  nearestRouteIds: string[];
  coastSide: string;
}

interface ChokepointStatus {
  id: string;
  name?: string;
  disruptionScore?: number;
  warRiskTier?: string;
}

interface ChokepointStatusResponse {
  chokepoints?: ChokepointStatus[];
}

const CARGO_TYPES = new Set(['container', 'tanker', 'bulk', 'roro']);

const CARGO_TO_ROUTE_CATEGORY: Record<string, string> = {
  container: 'container',
  tanker: 'energy',
  bulk: 'bulk',
  roro: 'container',
};

function rankSharedRoutesByCargo(
  sharedRoutes: string[],
  cargoType: string,
): string[] {
  const preferredCategory = CARGO_TO_ROUTE_CATEGORY[cargoType] ?? 'container';
  const routeMap = new Map(TRADE_ROUTES.map((r) => [r.id, r]));
  return [...sharedRoutes].sort((a, b) => {
    const catA = routeMap.get(a)?.category ?? '';
    const catB = routeMap.get(b)?.category ?? '';
    const matchA = catA === preferredCategory ? 0 : 1;
    const matchB = catB === preferredCategory ? 0 : 1;
    return matchA - matchB;
  });
}

function emptyResponse(
  req: GetRouteExplorerLaneRequest,
  fallbackHs2: string,
  fallbackCargo: string,
): GetRouteExplorerLaneResponse {
  return {
    fromIso2: req.fromIso2,
    toIso2: req.toIso2,
    hs2: fallbackHs2,
    cargoType: fallbackCargo,
    primaryRouteId: '',
    primaryRouteGeometry: [],
    chokepointExposures: [],
    bypassOptions: [],
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    disruptionScore: 0,
    noModeledLane: true,
    fetchedAt: new Date().toISOString(),
  };
}

function rangeOf(tuple: readonly [number, number]): NumberRange {
  return { min: tuple[0], max: tuple[1] };
}

function geoPoint(lon: number, lat: number): GeoPoint {
  return { lon, lat };
}

/**
 * Resolve coordinates for a `TradeRoute.waypoints` entry. Waypoints are string
 * IDs that can refer to either a `PORTS` entry or a chokepoint (via
 * `CHOKEPOINT_REGISTRY`). We try both in that order.
 */
function lookupWaypointCoord(waypointId: string): GeoPoint | null {
  const port = PORTS.find((p) => p.id === waypointId);
  if (port) return geoPoint(port.lon, port.lat);
  const cp = CHOKEPOINT_REGISTRY.find((c) => c.id === waypointId);
  if (cp) return geoPoint(cp.lon, cp.lat);
  return null;
}

/**
 * Build the primaryRouteGeometry polyline from a trade-route definition. We
 * use `from` → `waypoints[]` → `to` in sequence, dropping any waypoint we
 * can't resolve. Returns an empty array when `routeId` is empty or unknown.
 */
function buildRouteGeometry(routeId: string): GeoPoint[] {
  if (!routeId) return [];
  const route = TRADE_ROUTES.find((r) => r.id === routeId);
  if (!route) return [];
  const coords: GeoPoint[] = [];
  const fromCoord = lookupWaypointCoord(route.from);
  if (fromCoord) coords.push(fromCoord);
  for (const wp of route.waypoints) {
    const c = lookupWaypointCoord(wp);
    if (c) coords.push(c);
  }
  const toCoord = lookupWaypointCoord(route.to);
  if (toCoord) coords.push(toCoord);
  return coords;
}

/**
 * Derive a corridor status from the hand-authored `notes` field on the source
 * config. We keep this string-matching intentionally narrow to avoid over-
 * classifying as proposed/unavailable — default is ACTIVE.
 */
function deriveCorridorStatus(corridor: BypassCorridor): CorridorStatus {
  const notes = (corridor.notes ?? '').toLowerCase();
  const name = (corridor.name ?? '').toLowerCase();
  if (/proposed|not yet constructed|notional/.test(notes) || /proposed|\(future\)/.test(name)) {
    return 'CORRIDOR_STATUS_PROPOSED';
  }
  if (/blockaded|effectively closed|not usable|suspended/.test(notes)) {
    return 'CORRIDOR_STATUS_UNAVAILABLE';
  }
  return 'CORRIDOR_STATUS_ACTIVE';
}

function deriveBypassWarRiskTier(
  corridor: BypassCorridor,
  statusMap: Map<string, ChokepointStatus>,
): string {
  if (corridor.waypointChokepointIds.length > 0) {
    return corridor.waypointChokepointIds.reduce<string>((best, id) => {
      const t = statusMap.get(id)?.warRiskTier ?? 'WAR_RISK_TIER_UNSPECIFIED';
      return (TIER_RANK[t] ?? 0) > (TIER_RANK[best] ?? 0) ? t : best;
    }, 'WAR_RISK_TIER_UNSPECIFIED');
  }
  const status = deriveCorridorStatus(corridor);
  if (status === 'CORRIDOR_STATUS_UNAVAILABLE') return 'WAR_RISK_TIER_WAR_ZONE';
  return 'WAR_RISK_TIER_UNSPECIFIED';
}

function buildBypassOption(
  corridor: BypassCorridor,
  primaryChokepointId: string,
  statusMap: Map<string, ChokepointStatus>,
): BypassCorridorOption {
  const geom = getCorridorGeometryOrFallback(corridor.id, primaryChokepointId);
  return {
    id: corridor.id,
    name: corridor.name,
    type: corridor.type,
    addedTransitDays: corridor.addedTransitDays,
    addedCostMultiplier: corridor.addedCostMultiplier,
    warRiskTier: deriveBypassWarRiskTier(corridor, statusMap),
    status: deriveCorridorStatus(corridor),
    fromPort: geoPoint(geom.fromPort[0], geom.fromPort[1]),
    toPort: geoPoint(geom.toPort[0], geom.toPort[1]),
  };
}

/**
 * Pure compute function used by the handler and exposed for tests. Does not
 * consult premium gating or the response cache. Callers must provide live
 * chokepoint status via the parameter; in production the handler fetches it
 * from Redis.
 */
export async function computeLane(
  req: GetRouteExplorerLaneRequest,
  injectedStatusMap?: Map<string, ChokepointStatus>,
): Promise<GetRouteExplorerLaneResponse> {
  const fromIso2 = req.fromIso2.trim().toUpperCase();
  const toIso2 = req.toIso2.trim().toUpperCase();
  const hs2 = req.hs2.trim().replace(/\D/g, '') || '27';
  const cargoLower = req.cargoType.trim().toLowerCase();
  const cargoType = CARGO_TYPES.has(cargoLower) ? cargoLower : 'container';

  if (!/^[A-Z]{2}$/.test(fromIso2) || !/^[A-Z]{2}$/.test(toIso2)) {
    return emptyResponse(req, hs2, cargoType);
  }

  const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
  const fromCluster = clusters[fromIso2];
  const toCluster = clusters[toIso2];

  const fromRoutes = new Set(fromCluster?.nearestRouteIds ?? []);
  const toRoutes = new Set(toCluster?.nearestRouteIds ?? []);
  const sharedRoutes = [...fromRoutes].filter((r) => toRoutes.has(r));
  const noModeledLane = sharedRoutes.length === 0;
  const rankedRoutes = rankSharedRoutesByCargo(sharedRoutes, cargoType);
  const primaryRouteId = rankedRoutes[0] ?? fromCluster?.nearestRouteIds[0] ?? '';

  let statusMap: Map<string, ChokepointStatus>;
  if (injectedStatusMap) {
    statusMap = injectedStatusMap;
  } else {
    const statusRaw = (await getCachedJson(CHOKEPOINT_STATUS_KEY).catch(
      () => null,
    )) as ChokepointStatusResponse | null;
    statusMap = new Map<string, ChokepointStatus>(
      (statusRaw?.chokepoints ?? []).map((cp) => [cp.id, cp]),
    );
  }

  const primaryRouteSet = new Set(primaryRouteId ? [primaryRouteId] : []);
  const chokepointExposures: ChokepointExposureSummary[] = CHOKEPOINT_REGISTRY
    .filter((cp) => cp.routeIds.some((r) => primaryRouteSet.has(r)))
    .map((cp) => {
      const overlap = cp.routeIds.filter((r) => primaryRouteSet.has(r)).length;
      const exposurePct = Math.round((overlap / Math.max(cp.routeIds.length, 1)) * 100);
      return {
        chokepointId: cp.id,
        chokepointName: cp.displayName,
        exposurePct,
      };
    })
    .filter((e) => e.exposurePct > 0)
    .sort((a, b) => b.exposurePct - a.exposurePct);

  const primaryChokepoint = chokepointExposures[0];
  const primaryCpStatus = primaryChokepoint ? statusMap.get(primaryChokepoint.chokepointId) : null;
  const disruptionScore = primaryCpStatus?.disruptionScore ?? 0;
  const warRiskTier = primaryCpStatus?.warRiskTier ?? 'WAR_RISK_TIER_NORMAL';

  const PLACEHOLDER_CORRIDOR_IDS = new Set(['gibraltar_no_bypass', 'cape_of_good_hope_is_bypass']);
  const bypassOptions: BypassCorridorOption[] = primaryChokepoint
    ? (BYPASS_CORRIDORS_BY_CHOKEPOINT[primaryChokepoint.chokepointId] ?? [])
        .filter((c) => {
          if (PLACEHOLDER_CORRIDOR_IDS.has(c.id)) return false;
          if (c.suitableCargoTypes.length > 0 && !c.suitableCargoTypes.includes(cargoType as CargoType)) return false;
          return true;
        })
        .slice(0, 5)
        .map((c) => buildBypassOption(c, primaryChokepoint.chokepointId, statusMap))
    : [];

  const transitTuple = TRANSIT_DAYS_BY_ROUTE_ID[primaryRouteId] ?? TRANSIT_DAYS_FALLBACK;
  const freightTuple = FREIGHT_USD_BY_CARGO_TYPE[cargoType] ?? FREIGHT_USD_FALLBACK;

  return {
    fromIso2,
    toIso2,
    hs2,
    cargoType,
    primaryRouteId: noModeledLane ? '' : primaryRouteId,
    primaryRouteGeometry: noModeledLane ? [] : buildRouteGeometry(primaryRouteId),
    chokepointExposures: noModeledLane ? [] : chokepointExposures,
    bypassOptions: noModeledLane ? [] : bypassOptions,
    warRiskTier: noModeledLane ? 'WAR_RISK_TIER_NORMAL' : warRiskTier,
    disruptionScore: noModeledLane ? 0 : disruptionScore,
    estTransitDaysRange: noModeledLane ? undefined : rangeOf(transitTuple),
    estFreightUsdPerTeuRange: noModeledLane ? undefined : rangeOf(freightTuple),
    noModeledLane,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getRouteExplorerLane(
  ctx: ServerContext,
  req: GetRouteExplorerLaneRequest,
): Promise<GetRouteExplorerLaneResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const hs2 = req.hs2?.trim().replace(/\D/g, '') || '27';
  const cargo = CARGO_TYPES.has(req.cargoType?.trim().toLowerCase() ?? '')
    ? req.cargoType.trim().toLowerCase()
    : 'container';
  if (!isPro) return emptyResponse(req, hs2, cargo);

  const fromIso2 = req.fromIso2?.trim().toUpperCase() ?? '';
  const toIso2 = req.toIso2?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(fromIso2) || !/^[A-Z]{2}$/.test(toIso2)) {
    return emptyResponse(req, hs2, cargo);
  }

  const cacheKey = ROUTE_EXPLORER_LANE_KEY(fromIso2, toIso2, hs2, cargo);
  const result = await cachedFetchJson<GetRouteExplorerLaneResponse>(
    cacheKey,
    CACHE_TTL_SECONDS,
    async () => computeLane({ fromIso2, toIso2, hs2, cargoType: cargo }),
  );
  return result ?? emptyResponse(req, hs2, cargo);
}
