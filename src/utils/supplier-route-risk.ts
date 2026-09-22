import COUNTRY_PORT_CLUSTERS from '../../scripts/shared/country-port-clusters.json';
import COUNTRY_REGIONS from '../../scripts/shared/iso2-to-region.json';
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
const regions: Record<string, string> = COUNTRY_REGIONS;

// Regional ends of the existing TRADE_ROUTES corridors and their country clusters.
// A nearby corridor is not a connecting route when both countries are at the same
// end. This is a geography check, not evidence of a shipment or its transport mode.
const CORRIDOR_REGIONS: Record<string, readonly [string, string]> = {
  'china-europe-suez': ['east-asia', 'europe'],
  'china-us-west': ['east-asia', 'north-america'],
  'china-us-east-suez': ['east-asia', 'north-america'],
  'china-us-east-panama': ['east-asia', 'north-america'],
  'gulf-europe-oil': ['mena', 'europe'],
  'gulf-asia-oil': ['mena', 'east-asia'],
  'qatar-europe-lng': ['mena', 'europe'],
  'qatar-asia-lng': ['mena', 'east-asia'],
  'us-europe-lng': ['north-america', 'europe'],
  'russia-med-oil': ['europe', 'europe'],
  'intra-asia-container': ['east-asia', 'east-asia'],
  'singapore-med': ['east-asia', 'europe'],
  'brazil-china-bulk': ['latam', 'east-asia'],
  'gulf-americas-cape': ['mena', 'latam'],
  'asia-europe-cape': ['east-asia', 'europe'],
  'india-europe': ['south-asia', 'europe'],
  'india-se-asia': ['south-asia', 'east-asia'],
  'china-africa': ['east-asia', 'sub-saharan-africa'],
  'cpec-route': ['south-asia', 'east-asia'],
  'transatlantic': ['north-america', 'europe'],
};

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

// Chokepoints plausibly traversed for intra-regional trade within a coastSide.
// When both exporter and importer share the same coastSide, drop waypoints outside this set
// so routes like gulf-europe-oil don't attribute Hormuz/Bab el-Mandeb to GR→TR refined petroleum.
const INTRA_REGIONAL_CHOKEPOINTS: Record<string, Set<string>> = {
  med: new Set(['bosphorus', 'gibraltar', 'suez']),
  atlantic: new Set(['panama', 'gibraltar', 'dover_strait', 'cape_of_good_hope']),
  pacific: new Set(['panama', 'malacca_strait', 'taiwan_strait', 'korea_strait', 'lombok_strait']),
  indian: new Set(['malacca_strait', 'bab_el_mandeb', 'hormuz_strait', 'cape_of_good_hope', 'lombok_strait']),
};

function getCluster(iso2: string): ClusterEntry | undefined {
  const entry = clusters[iso2];
  if (!entry || typeof entry === 'string') return undefined;
  return entry;
}

function findOverlappingRoutes(exporterIso2: string, importerIso2: string): string[] {
  const exporterCluster = getCluster(exporterIso2);
  const importerCluster = getCluster(importerIso2);
  if (!exporterCluster || !importerCluster) return [];
  if (exporterIso2 === importerIso2 || exporterCluster.coastSide === 'landlocked' || importerCluster.coastSide === 'landlocked') return [];

  const exporterRegion = regions[exporterIso2];
  const importerRegion = regions[importerIso2];
  const importerSet = new Set(importerCluster.nearestRouteIds);
  return exporterCluster.nearestRouteIds.filter(id => {
    if (!importerSet.has(id)) return false;
    const endpoints = CORRIDOR_REGIONS[id];
    if (!endpoints) return false;
    // India is an intermediate destination on the Gulf-Asia corridor; its
    // modeled leg ends before Malacca, rather than inheriting the full route.
    if (id === 'gulf-asia-oil' && ((exporterIso2 === 'IN' && importerRegion === 'mena')
      || (importerIso2 === 'IN' && exporterRegion === 'mena'))) return true;
    return (exporterRegion === endpoints[0] && importerRegion === endpoints[1])
      || (exporterRegion === endpoints[1] && importerRegion === endpoints[0]);
  });
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
  const exporterCluster = getCluster(exporterIso2);
  const importerCluster = getCluster(importerIso2);
  const hasExporterCluster = !!exporterCluster;
  const hasImporterCluster = !!importerCluster;
  const routeIds = findOverlappingRoutes(exporterIso2, importerIso2);
  const hasRouteData = hasExporterCluster && hasImporterCluster && routeIds.length > 0;
  let transitChokepoints = collectTransitChokepoints(routeIds, chokepointScores);
  if (routeIds.includes('gulf-asia-oil') && (exporterIso2 === 'IN' || importerIso2 === 'IN')) {
    transitChokepoints = transitChokepoints.filter(cp => cp.chokepointId !== 'malacca_strait');
  }
  // For intra-regional pairs (same coastSide), overlapping "pass-through" routes like
  // gulf-europe-oil falsely attribute distant waypoints. Restrict transit to chokepoints
  // that plausibly sit on an intra-regional path.
  const sharedCoast = exporterCluster?.coastSide === importerCluster?.coastSide ? exporterCluster?.coastSide : null;
  if (sharedCoast && INTRA_REGIONAL_CHOKEPOINTS[sharedCoast]) {
    const allowed = INTRA_REGIONAL_CHOKEPOINTS[sharedCoast]!;
    transitChokepoints = transitChokepoints.filter(cp => allowed.has(cp.chokepointId));
  }
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
