/**
 * Population exposure core — shared between the dashboard
 * (src/services/population-exposure.ts) and the server RPC handler
 * (server/worldmonitor/displacement/v1/get-population-exposure.ts).
 *
 * Country-density approximation: nearest priority-country centroid supplies a
 * pop/area density, multiplied by the event radius disc. Deliberately coarse —
 * there is no city-level population dataset in the repo.
 *
 * Dependency-free: importable from Vite client code, Vercel Edge bundles,
 * server handlers, and tsx tests alike.
 */

export interface PriorityCountryInfo {
  name: string;
  pop: number;
  area: number;
}

export interface ExposureEstimate {
  exposedPopulation: number;
  exposureRadiusKm: number;
  nearestCountry: string;
  densityPerKm2: number;
}

export interface CountryPopulation {
  code: string;
  name: string;
  population: number;
  densityPerKm2: number;
}

export const PRIORITY_COUNTRIES: Record<string, PriorityCountryInfo> = {
  UKR: { name: 'Ukraine', pop: 37000000, area: 603550 },
  RUS: { name: 'Russia', pop: 144100000, area: 17098242 },
  ISR: { name: 'Israel', pop: 9800000, area: 22072 },
  PSE: { name: 'Palestine', pop: 5400000, area: 6020 },
  SYR: { name: 'Syria', pop: 22100000, area: 185180 },
  IRN: { name: 'Iran', pop: 88600000, area: 1648195 },
  TWN: { name: 'Taiwan', pop: 23600000, area: 36193 },
  ETH: { name: 'Ethiopia', pop: 126500000, area: 1104300 },
  SDN: { name: 'Sudan', pop: 48100000, area: 1861484 },
  SSD: { name: 'South Sudan', pop: 11400000, area: 619745 },
  SOM: { name: 'Somalia', pop: 18100000, area: 637657 },
  YEM: { name: 'Yemen', pop: 34400000, area: 527968 },
  AFG: { name: 'Afghanistan', pop: 42200000, area: 652230 },
  PAK: { name: 'Pakistan', pop: 240500000, area: 881913 },
  IND: { name: 'India', pop: 1428600000, area: 3287263 },
  MMR: { name: 'Myanmar', pop: 54200000, area: 676578 },
  COD: { name: 'DR Congo', pop: 102300000, area: 2344858 },
  NGA: { name: 'Nigeria', pop: 223800000, area: 923768 },
  MLI: { name: 'Mali', pop: 22600000, area: 1240192 },
  BFA: { name: 'Burkina Faso', pop: 22700000, area: 274200 },
};

export const EXPOSURE_CENTROIDS: Record<string, [number, number]> = {
  UKR: [48.4, 31.2], RUS: [61.5, 105.3], ISR: [31.0, 34.8], PSE: [31.9, 35.2],
  SYR: [35.0, 38.0], IRN: [32.4, 53.7], TWN: [23.7, 121.0], ETH: [9.1, 40.5],
  SDN: [15.5, 32.5], SSD: [6.9, 31.3], SOM: [5.2, 46.2], YEM: [15.6, 48.5],
  AFG: [33.9, 67.7], PAK: [30.4, 69.3], IND: [20.6, 79.0], MMR: [19.8, 96.7],
  COD: [-4.0, 21.8], NGA: [9.1, 7.5], MLI: [17.6, -4.0], BFA: [12.3, -1.6],
};

const FALLBACK_INFO: PriorityCountryInfo = { name: '', pop: 50_000_000, area: 500_000 };

/**
 * Ceiling for new agent-facing exposure requests.
 *
 * The estimate multiplies ONE country's average density across the whole
 * disc, so it is only meaningful while the disc stays inside terrain that
 * density describes. The event radii this model ships with top out at 100 km;
 * 1000 km is a generous bound that still keeps the arithmetic defensible.
 * Without it an unclamped caller radius produces a confidently-wrong number —
 * radius 20000 yields ~5.6e11 people, ~69x world population — which is worse
 * than refusing, because it looks like an answer.
 *
 * The existing v1 REST RPC predates this ceiling and keeps its unbounded
 * contract. New callers that accept free-form radii use
 * `computeBoundedExposure`; callers with already-bounded domain radii use
 * `computeExposure`.
 */
export const MAX_EXPOSURE_RADIUS_KM = 1000;

export function computeExposure(lat: number, lon: number, radiusKm: number): ExposureEstimate {
  const effectiveRadiusKm = Math.max(0, Number.isFinite(radiusKm) ? radiusKm : 0);
  let bestMatch: string | null = null;
  let bestDist = Infinity;

  for (const [code, [cLat, cLon]] of Object.entries(EXPOSURE_CENTROIDS)) {
    const dist = Math.sqrt((lat - cLat) ** 2 + (lon - cLon) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = code;
    }
  }

  const info = bestMatch ? PRIORITY_COUNTRIES[bestMatch] ?? FALLBACK_INFO : FALLBACK_INFO;
  const density = info.pop / info.area;
  const areaKm2 = Math.PI * effectiveRadiusKm * effectiveRadiusKm;

  return {
    exposedPopulation: Math.round(density * areaKm2),
    exposureRadiusKm: effectiveRadiusKm,
    nearestCountry: bestMatch || '',
    densityPerKm2: Math.round(density),
  };
}

export function computeBoundedExposure(
  lat: number,
  lon: number,
  radiusKm: number,
): ExposureEstimate {
  const boundedRadiusKm = Number.isFinite(radiusKm)
    ? Math.min(MAX_EXPOSURE_RADIUS_KM, Math.max(0, radiusKm))
    : 0;
  return computeExposure(lat, lon, boundedRadiusKm);
}

export function getRadiusForEventType(type: string): number {
  switch (type) {
    case 'conflict':
    case 'battle':
    case 'state-based':
    case 'non-state':
    case 'one-sided':
      return 50;
    case 'earthquake':
      return 100;
    case 'flood':
      return 100;
    case 'fire':
    case 'wildfire':
      return 30;
    default:
      return 50;
  }
}

export function listCountryPopulations(): CountryPopulation[] {
  return Object.entries(PRIORITY_COUNTRIES).map(([code, info]) => ({
    code,
    name: info.name,
    population: info.pop,
    densityPerKm2: Math.round(info.pop / info.area),
  }));
}
