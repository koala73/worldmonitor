import { CHOKEPOINT_REGISTRY } from '../../../../src/config/chokepoint-registry';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';
import COUNTRY_REGIONS from '../../../../scripts/shared/iso2-to-region.json';
import { bilateralTransitShares } from '../../../../scripts/shared/bilateral-chokepoint-transit.mjs';

interface PortClusterEntry {
  nearestRouteIds: string[];
  coastSide: string;
}

export interface ProductExporter {
  partnerCode: number;
  partnerIso2: string;
  value: number;
  share: number;
}

export interface CountryProduct {
  hs4: string;
  description: string;
  totalValue: number;
  topExporters: ProductExporter[];
  year: number;
}

export interface ExposureEntry {
  chokepointId: string;
  chokepointName: string;
  exposureScore: number;
  coastSide: string;
  shockSupported: boolean;
}

const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
const transitContext = {
  clusters,
  regions: COUNTRY_REGIONS as Record<string, string>,
  chokepoints: CHOKEPOINT_REGISTRY,
};

export function getRouteIdsForCountry(iso2: string): string[] {
  return clusters[iso2]?.nearestRouteIds ?? [];
}

export function getCoastSide(iso2: string): string {
  return clusters[iso2]?.coastSide ?? 'unknown';
}

export function hs4ToHs2(hs4: string): string {
  return String(Number.parseInt(hs4.slice(0, 2), 10));
}

export function computeFlowWeightedExposures(
  importerIso2: string,
  hs2: string,
  products: CountryProduct[],
): ExposureEntry[] {
  const isEnergy = hs2 === '27';
  const normalizedHs2 = String(Number.parseInt(hs2, 10));
  const matchingProducts = products.filter(p => hs4ToHs2(p.hs4) === normalizedHs2);

  if (matchingProducts.length === 0) return [];

  const totalSectorValue = matchingProducts.reduce((s, p) => s + p.totalValue, 0);

  const cpScores = new Map<string, number>();
  for (const cp of CHOKEPOINT_REGISTRY) cpScores.set(cp.id, 0);

  for (const product of matchingProducts) {
    const productWeight = totalSectorValue > 0 ? product.totalValue / totalSectorValue : 0;

    for (const exporter of product.topExporters) {
      if (!exporter.partnerIso2) continue;
      for (const [cpId, fraction] of bilateralTransitShares(importerIso2, exporter.partnerIso2, transitContext)) {
        cpScores.set(cpId, (cpScores.get(cpId) ?? 0) + fraction * exporter.share * productWeight * 100);
      }
    }
  }

  const entries: ExposureEntry[] = CHOKEPOINT_REGISTRY.map(cp => {
    let score = cpScores.get(cp.id) ?? 0;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    score = Math.min(score, 100);
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

export function computeFallbackExposures(
  nearestRouteIds: string[],
  hs2: string,
): ExposureEntry[] {
  const isEnergy = hs2 === '27';
  const routeSet = new Set(nearestRouteIds);

  const entries: ExposureEntry[] = CHOKEPOINT_REGISTRY.map(cp => {
    const overlap = cp.routeIds.filter(r => routeSet.has(r)).length;
    const maxRoutes = Math.max(cp.routeIds.length, 1);
    let score = (overlap / maxRoutes) * 100;
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

export function vulnerabilityIndex(sorted: ExposureEntry[]): number {
  const weights = [0.5, 0.3, 0.2];
  const total = sorted.slice(0, 3).reduce((sum, e, i) => sum + e.exposureScore * weights[i]!, 0);
  return Math.round(total * 10) / 10;
}
