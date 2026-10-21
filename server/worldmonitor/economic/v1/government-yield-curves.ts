/**
 * Shared multi-country yield-curve model: covered-market registry, Redis key
 * shapes, and seed→response normalization for GetGovernmentYieldCurve.
 *
 * Storage follows the US Treasury par-curve pattern (#8481): a canonical key
 * per market plus a `:latest` key plus per-year shards, because one GET of a
 * full daily history exceeds the Redis read budget. Markets without history
 * (OECD monthly, ChinaBond latest-only) publish canonical + `:latest` only.
 */

export type YieldMeasure = 'par' | 'spot' | 'benchmark' | 'monthly-10y';

export interface CoveredMarket {
  /** Uppercase ISO 3166-1 alpha-2 code, also the canonical key segment. */
  country: string;
  /** Seed resource segment and health probe label. */
  resource: string;
  /** Attribution-facing descriptor, echoed as the response `source`. */
  source: string;
  measure: YieldMeasure;
  /** First year with data; year shards start here. */
  startYear: number;
}

export const GOV_YIELD_KEY_PREFIX = 'economic:yield-curve';

export const COVERED_MARKETS: readonly CoveredMarket[] = [
  { country: 'JP', resource: 'yield-curve-jp', source: 'jp-mof-cmt', measure: 'par', startYear: 1974 },
  { country: 'CA', resource: 'yield-curve-ca', source: 'ca-boc-benchmark', measure: 'benchmark', startYear: 1990 },
  { country: 'DE', resource: 'yield-curve-de', source: 'de-bundesbank-par', measure: 'par', startYear: 1997 },
  { country: 'GB', resource: 'yield-curve-gb', source: 'uk-boe-spot', measure: 'spot', startYear: 1979 },
  { country: 'AU', resource: 'yield-curve-au', source: 'au-rba-ags', measure: 'benchmark', startYear: 2013 },
  { country: 'CH', resource: 'yield-curve-ch', source: 'ch-snb-spot', measure: 'spot', startYear: 1988 },
  { country: 'NO', resource: 'yield-curve-no', source: 'no-norges-zero', measure: 'spot', startYear: 2015 },
  { country: 'SE', resource: 'yield-curve-se', source: 'se-riksbank', measure: 'benchmark', startYear: 1990 },
];

/** Monthly OECD MEI 10Y benchmark, keyed per market without a covered daily curve. */
export const OECD_LT_KEY = `${GOV_YIELD_KEY_PREFIX}:oecd-lt:v1`;
export const OECD_LT_LATEST_KEY = `${GOV_YIELD_KEY_PREFIX}:oecd-lt:v1:latest`;
export const OECD_LT_RESOURCE = 'oecd-lt-rates';

export function govYieldCanonicalKey(country: string): string {
  return `${GOV_YIELD_KEY_PREFIX}:${country.toLowerCase()}:v1`;
}

export function govYieldLatestKey(country: string): string {
  return `${GOV_YIELD_KEY_PREFIX}:${country.toLowerCase()}:v1:latest`;
}

export function govYieldYearKey(country: string, year: number): string {
  return `${GOV_YIELD_KEY_PREFIX}:${country.toLowerCase()}:v1:${year}`;
}

export function govYieldYears(startYear: number, now = new Date()): number[] {
  const end = now.getUTCFullYear();
  const years: number[] = [];
  for (let year = startYear; year <= end; year += 1) years.push(year);
  return years;
}

export function findCoveredMarket(country: string): CoveredMarket | undefined {
  const normalized = country.trim().toUpperCase();
  return COVERED_MARKETS.find((market) => market.country === normalized);
}

function businessDayMs(isoDate: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

interface CurveSeedPoint {
  date?: unknown;
  tenors?: unknown;
}

export interface NormalizedCurve {
  date: number;
  tenors: Record<string, number>;
}

function toNormalizedCurve(seed: CurveSeedPoint): NormalizedCurve | undefined {
  const date = typeof seed.date === 'string' ? businessDayMs(seed.date) : undefined;
  if (date == null) return undefined;
  const tenors: Record<string, number> = {};
  let present = false;
  if (seed.tenors && typeof seed.tenors === 'object' && !Array.isArray(seed.tenors)) {
    for (const [tenor, value] of Object.entries(seed.tenors as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      tenors[tenor] = value;
      present = true;
    }
  }
  return present ? { date, tenors } : undefined;
}

function curvesFromPayload(value: unknown): NormalizedCurve[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as { curves?: unknown };
  const seeds = Array.isArray(record.curves) ? record.curves : [value];
  const out: NormalizedCurve[] = [];
  for (const seed of seeds) {
    if (!seed || typeof seed !== 'object') continue;
    const curve = toNormalizedCurve(seed as CurveSeedPoint);
    if (curve) out.push(curve);
  }
  return out;
}

/** Normalize the `:latest` payload (a single point or a one-element shard). */
export function govYieldCurveFromLatest(value: unknown): NormalizedCurve[] {
  return curvesFromPayload(value);
}

/** Merge year shards (or any seed payloads) into one ascending history. */
export function govYieldCurvesFromShards(values: unknown[]): NormalizedCurve[] {
  const byDate = new Map<number, NormalizedCurve>();
  for (const value of values) {
    for (const curve of curvesFromPayload(value)) {
      // Later shards win; year shards are disjoint so this only matters when
      // the same date appears in both a shard and the canonical payload.
      byDate.set(curve.date, { ...byDate.get(curve.date), ...curve } as NormalizedCurve);
    }
  }
  return [...byDate.values()].sort((left, right) => left.date - right.date);
}

/** Extract one country's monthly curves from the OECD canonical payload. */
export function oecdLtCurvesForCountry(value: unknown, country: string): NormalizedCurve[] {
  if (!value || typeof value !== 'object') return [];
  const countries = (value as { countries?: unknown }).countries;
  if (!countries || typeof countries !== 'object' || Array.isArray(countries)) return [];
  const normalized = country.trim().toUpperCase();
  const entry = (countries as Record<string, unknown>)[normalized];
  if (!entry || typeof entry !== 'object') return [];
  return curvesFromPayload(entry);
}
