/**
 * Population density reference data and the event exposure model.
 *
 * An estimate is one country's average density (population / land area)
 * multiplied by the area of the event-radius disc. Deliberately coarse:
 * there is no city-level population dataset in the repo. Places outside the
 * density table get no estimate. Borrowing a neighbour's density gave
 * Santiago Burkina Faso's figure (#10388, #10408).
 *
 * The dashboard, the REST RPC and the MCP tool all call `estimateExposure`.
 * Callers holding only a point resolve its country with
 * `shared/population-density-country-at.ts`.
 */

import { resolveCountryCode } from './country-code-resolve';

export interface PriorityCountryInfo {
  name: string;
  pop: number;
  area: number;
}

export interface ExposureEstimate {
  exposedPopulation: number;
  exposureRadiusKm: number;
  /** ISO3 code of the country whose density was used. */
  country: string;
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

const DENSITY_BY_ISO2 = new Map(Object.entries(PRIORITY_COUNTRIES).map(([iso3, { pop, area }]) =>
  [resolveCountryCode(iso3), { iso3, density: pop / area }] as const,
));

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
 * contract. Callers that accept free-form radii clamp to this value first.
 */
export const MAX_EXPOSURE_RADIUS_KM = 1000;

function isUsableEventPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0);
}

/**
 * `country` may be ISO2, ISO3 or a name. Returns null for an unusable point or
 * a country outside the density table.
 */
export function estimateExposure(
  lat: number,
  lon: number,
  country: string,
  radiusKm: number,
): ExposureEstimate | null {
  if (!isUsableEventPoint(lat, lon)) return null;
  const code = resolveCountryCode(country);
  const entry = code ? DENSITY_BY_ISO2.get(code) : undefined;
  if (!entry) return null;
  const effectiveRadiusKm = Math.max(0, Number.isFinite(radiusKm) ? radiusKm : 0);
  return {
    exposedPopulation: Math.round(entry.density * Math.PI * effectiveRadiusKm ** 2),
    exposureRadiusKm: effectiveRadiusKm,
    country: entry.iso3,
    densityPerKm2: Math.round(entry.density),
  };
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
