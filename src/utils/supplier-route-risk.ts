import COUNTRY_PORT_CLUSTERS from '../../scripts/shared/country-port-clusters.json';
import { TRADE_ROUTES } from '@/config/trade-routes';
import { CHOKEPOINT_REGISTRY } from '@/config/chokepoint-registry';

export type SupplierRiskLevel = 'safe' | 'at_risk' | 'critical' | 'unknown';

export interface TransitChokepoint {
  chokepointId: string;
  chokepointName: string;
  disruptionScore: number;
}

export interface SupplierRouteRisk {
  exporterIso2: string;
  importerIso2: string;
  routeIds: string[];
  transitChokepoints: TransitChokepoint[];
  riskLevel: SupplierRiskLevel;
  maxDisruptionScore: number;
  recommendation: string;
}

export type ChokepointScoreMap = Map<string, number>;

interface ClusterEntry {
  nearestRouteIds: string[];
  coastSide: string;
}

interface CountryPortClustersJson {
  _comment: string;
  [iso2: string]: ClusterEntry | string;
}

const clusters: CountryPortClustersJson = COUNTRY_PORT_CLUSTERS;

const chokepointByRoute = new Map<string, string[]>();
for (const route of TRADE_ROUTES) {
  if (route.waypoints.length > 0) {
    chokepointByRoute.set(route.id, route.waypoints);
  }
}

const chokepointNameMap = new Map<string, string>();
for (const cp of CHOKEPOINT_REGISTRY) {
  chokepointNameMap.set(cp.id, cp.displayName);
}

function getCluster(iso2: string): ClusterEntry | undefined {
  const entry = clusters[iso2];
  if (!entry || typeof entry === 'string') return undefined;
  return entry;
}

function findOverlappingRoutes(exporterIso2: string, importerIso2: string): string[] {
  const exporterCluster = getCluster(exporterIso2);
  const importerCluster = getCluster(importerIso2);
  if (!exporterCluster || !importerCluster) return [];

  const importerSet = new Set(importerCluster.nearestRouteIds);
  return exporterCluster.nearestRouteIds.filter(r => importerSet.has(r));
}

function collectTransitChokepoints(routeIds: string[], scores: ChokepointScoreMap): TransitChokepoint[] {
  const seen = new Set<string>();
  const result: TransitChokepoint[] = [];

  for (const routeId of routeIds) {
    const waypoints = chokepointByRoute.get(routeId);
    if (!waypoints) continue;
    for (const cpId of waypoints) {
      if (seen.has(cpId)) continue;
      seen.add(cpId);
      result.push({
        chokepointId: cpId,
        chokepointName: chokepointNameMap.get(cpId) ?? cpId,
        disruptionScore: scores.get(cpId) ?? 0,
      });
    }
  }

  return result;
}

function determineRiskLevel(chokepoints: TransitChokepoint[], hasRouteData: boolean): SupplierRiskLevel {
  if (!hasRouteData) return 'unknown';
  for (const cp of chokepoints) {
    if (cp.disruptionScore >= 70) return 'critical';
  }
  for (const cp of chokepoints) {
    if (cp.disruptionScore > 30) return 'at_risk';
  }
  return 'safe';
}

function buildRecommendation(riskLevel: SupplierRiskLevel, chokepoints: TransitChokepoint[]): string {
  if (riskLevel === 'unknown') return 'No modeled maritime route data available for this pair.';
  if (chokepoints.length === 0) return 'No transit chokepoints detected.';
  if (riskLevel === 'critical') {
    const worst = chokepoints.reduce((a, b) => a.disruptionScore > b.disruptionScore ? a : b);
    return `Route transits ${worst.chokepointName} (disruption: ${worst.disruptionScore}/100). Consider alternative suppliers.`;
  }
  if (riskLevel === 'at_risk') {
    const elevated = chokepoints.filter(cp => cp.disruptionScore > 30);
    const names = elevated.map(cp => cp.chokepointName).join(', ');
    return `Route transits ${names} (elevated risk). Monitor closely.`;
  }
  return 'Route avoids all currently disrupted chokepoints.';
}

export function computeSupplierRouteRisk(
  exporterIso2: string,
  importerIso2: string,
  chokepointScores: ChokepointScoreMap,
): SupplierRouteRisk {
  const hasExporterCluster = !!getCluster(exporterIso2);
  const hasImporterCluster = !!getCluster(importerIso2);
  const routeIds = findOverlappingRoutes(exporterIso2, importerIso2);
  const hasRouteData = hasExporterCluster && hasImporterCluster && routeIds.length > 0;
  const transitChokepoints = collectTransitChokepoints(routeIds, chokepointScores);
  const riskLevel = determineRiskLevel(transitChokepoints, hasRouteData);
  const maxDisruptionScore = transitChokepoints.length > 0
    ? Math.max(...transitChokepoints.map(cp => cp.disruptionScore))
    : 0;
  const recommendation = buildRecommendation(riskLevel, transitChokepoints);

  return {
    exporterIso2,
    importerIso2,
    routeIds,
    transitChokepoints,
    riskLevel,
    maxDisruptionScore,
    recommendation,
  };
}

export interface EnrichedExporter {
  partnerCode: number;
  partnerIso2: string;
  value: number;
  share: number;
  risk: SupplierRouteRisk;
  safeAlternative: string | null;
}

export function computeAlternativeSuppliers(
  exporters: Array<{ partnerCode: number; partnerIso2: string; value: number; share: number }>,
  importerIso2: string,
  chokepointScores: ChokepointScoreMap,
): EnrichedExporter[] {
  const enriched: EnrichedExporter[] = exporters.map(exp => ({
    ...exp,
    risk: computeSupplierRouteRisk(exp.partnerIso2, importerIso2, chokepointScores),
    safeAlternative: null,
  }));

  const safeExporters = enriched.filter(e => e.risk.riskLevel === 'safe');
  for (const exp of enriched) {
    if (exp.risk.riskLevel === 'critical' || exp.risk.riskLevel === 'at_risk') {
      const alt = safeExporters.find(s => s.partnerIso2 !== exp.partnerIso2);
      exp.safeAlternative = alt?.partnerIso2 ?? null;
    }
  }

  return enriched;
}
