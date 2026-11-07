// Pure merge logic for the worldwide CPI read. No I/O, no Redis import — the
// gateway handler owns the reads and this module owns the decisions, so the
// precedence and staleness rules are testable without a fixture server.
//
// Source precedence per country (highest first):
//   1. estat-cpi     Japan only — the national release authority
//   2. eurostat-hicp EU geos       — the harmonised European basket
//   3. imf-hicp      European countries covered by the IMF harmonised series
//   4. imf-cpi       default worldwide
//   5. abs-cpi       Australia fallback
//
// The stored IMF payload carries two series maps: `countries` (national CPI)
// and `harmonised` (HICP). They are exposed to the ranking as `imf-cpi` and
// `imf-hicp` respectively. The Eurostat payload carries `countries` only.
//
// A preferred source that has fallen behind the freshest available print for
// that country falls through to the next one. This is what keeps one lagging
// feed (the Eurostat dissemination API measured ~9 months behind on 2026-09-23)
// from masking a current national print.

export type WorldCpiSourceId =
  | 'estat-cpi'
  | 'eurostat-hicp'
  | 'imf-hicp'
  | 'imf-cpi'
  | 'abs-cpi';

export interface WorldCpiObservation {
  date: string;
  value: number;
}

export interface WorldCpiSeries {
  frequency?: string;
  indexBase?: string;
  points?: WorldCpiObservation[];
}

export interface WorldCpiSelectedSeries {
  source: WorldCpiSourceId;
  frequency?: string;
  indexBase?: string;
  points?: WorldCpiObservation[];
}

export type WorldCpiSourcePayloads = Partial<Record<string, { countries?: Record<string, WorldCpiSeries>; harmonised?: Record<string, WorldCpiSeries> }>>;

export interface WorldCpiWireReading {
  index: number;
  periodOverPeriod?: { percent: number };
  yearOverYear?: { percent: number };
}

export interface WorldCpiWirePeriod {
  period: number;
  reading: WorldCpiWireReading;
}

export interface WorldCpiWireCountry {
  country: string;
  source: string;
  frequency: string;
  indexBase: string;
  periods: WorldCpiWirePeriod[];
}

export const WORLD_CPI_SOURCES: WorldCpiSourceId[] = [
  'estat-cpi',
  'eurostat-hicp',
  'imf-hicp',
  'imf-cpi',
  'abs-cpi',
];

export const WORLD_CPI_CANONICAL_KEYS: Record<Exclude<WorldCpiSourceId, 'imf-hicp'>, string> = {
  'imf-cpi': 'economic:world-cpi:imf:v1',
  'eurostat-hicp': 'economic:world-cpi:eurostat:v1',
  'estat-cpi': 'economic:world-cpi:estat:v1',
  'abs-cpi': 'economic:world-cpi:abs:v1',
};

export const WORLD_CPI_LATEST_KEYS: Record<Exclude<WorldCpiSourceId, 'imf-hicp'>, string> = {
  'imf-cpi': 'economic:world-cpi:imf:latest:v1',
  'eurostat-hicp': 'economic:world-cpi:eurostat:latest:v1',
  'estat-cpi': 'economic:world-cpi:estat:latest:v1',
  'abs-cpi': 'economic:world-cpi:abs:latest:v1',
};

// The external source id -> the stored key it reads. IMF harmonised data lives
// inside the IMF payload, so no separate Redis key exists for it.
export const WORLD_CPI_STORAGE_SOURCE: Record<WorldCpiSourceId, Exclude<WorldCpiSourceId, 'imf-hicp'>> = {
  'imf-cpi': 'imf-cpi',
  'imf-hicp': 'imf-cpi',
  'eurostat-hicp': 'eurostat-hicp',
  'estat-cpi': 'estat-cpi',
  'abs-cpi': 'abs-cpi',
};

// How far behind the freshest available print a preferred source may fall
// before the read falls through to the next source. Six months is one quarter
// of reporting lag plus slack — enough that a normal publication gap does not
// flip sources, tight enough that a stalled feed cannot pin a country to a
// year-old print.
export const PREFERRED_SOURCE_MAX_LAG_MONTHS = 6;

/** Convert a period token to a month ordinal (`year * 12 + month`). */
export function periodOrdinal(period: string | undefined): number | undefined {
  const monthly = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (monthly) return Number(monthly[1]) * 12 + Number(monthly[2]);
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(String(period ?? ''));
  if (quarterly) return Number(quarterly[1]) * 12 + (Number(quarterly[2]) - 1) * 3 + 1;
  return undefined;
}

/** The newest period in a series entry, or undefined. */
export function newestPeriod(entry: WorldCpiSeries | undefined): string | undefined {
  const points = entry?.points;
  if (!Array.isArray(points) || points.length === 0) return undefined;
  return points[points.length - 1]?.date;
}

/**
 * Build the flat candidate index `{ sourceId: { ISO2: entry } }` from the raw
 * per-source payloads, lifting the IMF `harmonised` map to `imf-hicp`.
 */
export function buildCandidateIndex(
  sources: WorldCpiSourcePayloads | undefined,
): Partial<Record<WorldCpiSourceId, Record<string, WorldCpiSeries>>> {
  const index: Partial<Record<WorldCpiSourceId, Record<string, WorldCpiSeries>>> = {};
  for (const sourceId of WORLD_CPI_SOURCES) {
    const storage = WORLD_CPI_STORAGE_SOURCE[sourceId];
    const payload = sources?.[storage];
    if (!payload || typeof payload !== 'object') continue;
    const field = sourceId === 'imf-hicp' ? 'harmonised' : 'countries';
    const map = payload[field];
    if (map && typeof map === 'object') index[sourceId] = map;
  }
  return index;
}

/**
 * Order the candidate series for one country, best first. `index` is the output
 * of `buildCandidateIndex`, `worldLatest` the newest period observed for the
 * country across every candidate.
 *
 * A candidate is demoted only when it trails `worldLatest` by more than
 * `PREFERRED_SOURCE_MAX_LAG_MONTHS`; the freshest candidate is never demoted,
 * because it defines `worldLatest` and a trailing value of 0 for itself.
 */
export function rankCountrySources(
  country: string,
  index: Partial<Record<WorldCpiSourceId, Record<string, WorldCpiSeries>>>,
  worldLatest: string | undefined,
) {
  const worldOrdinal = periodOrdinal(worldLatest);
  const candidates: Array<{
    sourceId: WorldCpiSourceId;
    entry: WorldCpiSeries;
    newest: string;
    trailing: number;
    stale: boolean;
  }> = [];
  for (const sourceId of WORLD_CPI_SOURCES) {
    const entry = index[sourceId]?.[country];
    const newest = newestPeriod(entry);
    if (!entry || !newest) continue;
    const newestOrdinal = periodOrdinal(newest);
    const trailing = worldOrdinal !== undefined && newestOrdinal !== undefined
      ? Math.max(0, worldOrdinal - newestOrdinal)
      : 0;
    candidates.push({
      sourceId,
      entry,
      newest,
      trailing,
      stale: trailing > PREFERRED_SOURCE_MAX_LAG_MONTHS,
    });
  }
  // Preference order is declared order: a non-stale candidate always beats a
  // stale one, then the declared precedence applies, then freshness breaks any
  // remaining tie.
  candidates.sort((left, right) => {
    if (left.stale !== right.stale) return left.stale ? 1 : -1;
    const leftRank = WORLD_CPI_SOURCES.indexOf(left.sourceId);
    const rightRank = WORLD_CPI_SOURCES.indexOf(right.sourceId);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.trailing - right.trailing;
  });
  return candidates;
}

/**
 * Pick the winning series for every country and return
 * `{ ISO2: { source, frequency, indexBase, points } }`.
 */
export function selectCountrySeries(
  sources: WorldCpiSourcePayloads | undefined,
): Record<string, WorldCpiSelectedSeries> {
  const index = buildCandidateIndex(sources);
  const allCountries = new Set<string>();
  for (const map of Object.values(index)) {
    for (const country of Object.keys(map ?? {})) allCountries.add(country);
  }

  const selected: Record<string, WorldCpiSelectedSeries> = {};
  for (const country of allCountries) {
    const worldLatest = freshestPeriod(index, country);
    const ranked = rankCountrySources(country, index, worldLatest);
    const winner = ranked[0];
    if (!winner) continue;
    selected[country] = {
      source: winner.sourceId,
      frequency: winner.entry.frequency,
      indexBase: winner.entry.indexBase,
      points: winner.entry.points,
    };
  }
  return selected;
}

function freshestPeriod(
  index: Partial<Record<WorldCpiSourceId, Record<string, WorldCpiSeries>>>,
  country: string,
): string | undefined {
  let newest: string | undefined;
  for (const map of Object.values(index)) {
    const candidate = newestPeriod(map?.[country]);
    if (!candidate) continue;
    if (!newest || (periodOrdinal(candidate) ?? 0) > (periodOrdinal(newest) ?? 0)) newest = candidate;
  }
  return newest;
}

/** Round to 4 decimals via scaled integers to avoid float drift. */
export function roundPercent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Shift a period token back by `months`, preserving its frequency shape.
 *   '2026-08' - 6 -> '2026-02';  '2026-Q2' - 6 -> '2025-Q4'
 */
export function shiftPeriod(period: string | undefined, months: number): string | undefined {
  const ordinal = periodOrdinal(period);
  if (ordinal === undefined) return undefined;
  const shifted = ordinal - months;
  if (/^\d{4}-Q[1-4]$/.test(String(period))) {
    return `${Math.floor((shifted - 1) / 12)}-Q${Math.floor(((shifted - 1) % 12) / 3) + 1}`;
  }
  return `${Math.floor((shifted - 1) / 12)}-${String((shifted - 1) % 12 + 1).padStart(2, '0')}`;
}

/**
 * Compute the wire reading for one period: index plus period-over-period and
 * year-over-year percent changes. Changes are omitted (not nulled) when the
 * comparison period is absent, matching the US CPI contract.
 */
export function readingAt(
  points: WorldCpiObservation[],
  indexByPeriod: Map<string, number>,
  position: number,
  frequency: string | undefined,
): WorldCpiWireReading | undefined {
  const point = points[position];
  if (!point) return undefined;
  const reading: WorldCpiWireReading = { index: point.value };
  const priorMonths = frequency === 'Q' ? 3 : 1;
  const change = (base: number | undefined) => (
    Number.isFinite(point.value) && Number.isFinite(base) && base !== 0
      ? { percent: roundPercent((point.value / (base as number) - 1) * 100) }
      : undefined
  );
  const periodOverPeriod = change(indexByPeriod.get(shiftPeriod(point.date, priorMonths) ?? ''));
  const yearOverYear = change(indexByPeriod.get(shiftPeriod(point.date, 12) ?? ''));
  // A shifted token can land on another frequency's shape (Q -> MM) when the
  // offset crosses a quarter boundary; guard by re-checking the token shape.
  if (periodOverPeriod && shapeMatches(point.date, priorMonths)) reading.periodOverPeriod = periodOverPeriod;
  if (yearOverYear) reading.yearOverYear = yearOverYear;
  return reading;
}

function shapeMatches(period: string, offset: number): boolean {
  const shifted = shiftPeriod(period, offset);
  if (!shifted) return false;
  return /^\d{4}-Q[1-4]$/.test(period) === /^\d{4}-Q[1-4]$/.test(shifted);
}

/**
 * Build the wire-shaped country list.
 *
 * @param selected  output of `selectCountrySeries`
 * @param history   false returns the latest period per country
 * @param countryFilter optional ISO-2 filter
 */
export function buildWorldCpiCountries(
  selected: Record<string, WorldCpiSelectedSeries>,
  history: boolean,
  countryFilter?: string,
): WorldCpiWireCountry[] {
  const filter = typeof countryFilter === 'string' && countryFilter.length > 0
    ? countryFilter.toUpperCase() : undefined;
  const countries: WorldCpiWireCountry[] = [];
  for (const country of Object.keys(selected).sort()) {
    if (filter && country !== filter) continue;
    const series = selected[country];
    if (!series) continue;
    const points = Array.isArray(series.points) ? series.points : [];
    if (points.length === 0) continue;
    const indexByPeriod = new Map(points.map((point) => [point.date, point.value]));
    const positions = history ? points.map((_, index) => index) : [points.length - 1];
    const periods: WorldCpiWirePeriod[] = [];
    for (const position of positions) {
      const point = points[position];
      const reading = readingAt(points, indexByPeriod, position, series.frequency);
      if (!point || !reading) continue;
      periods.push({ period: periodStartMs(point.date), reading });
    }
    if (periods.length === 0) continue;
    countries.push({
      country,
      source: series.source,
      frequency: series.frequency ?? 'M',
      indexBase: series.indexBase ?? '',
      periods,
    });
  }
  return countries;
}

/** UTC midnight on the first day of a period, as Unix epoch milliseconds. */
export function periodStartMs(period: string | undefined): number {
  const monthly = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (monthly) return Date.UTC(Number(monthly[1]), Number(monthly[2]) - 1, 1);
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(String(period ?? ''));
  if (quarterly) return Date.UTC(Number(quarterly[1]), (Number(quarterly[2]) - 1) * 3, 1);
  return 0;
}
