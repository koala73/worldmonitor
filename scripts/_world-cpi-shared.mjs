// Shared worldwide CPI helpers. Pure transforms only — no I/O, no env access.
//
// Five sources feed one country-indexed dataset:
//   IMF STA CPI        monthly/quarterly, national + HICP, 190+ countries (default)
//   Eurostat HICP      monthly, EU geos                                     (EU overlay)
//   OECD SDMX          monthly/quarterly, members + partners                (gap fill)
//   JP e-Stat          monthly, Japan                                       (national overlay)
//   AU ABS             quarterly, Australia                                 (national overlay)
//
// Every source produces the same shape:
//   { countries: { ISO2: { frequency: 'M'|'Q', indexBase: string, points: [{ date, value }] } } }
// The IMF source additionally carries `harmonised` with the same per-country
// shape for the Eurostat-comparable HICP series.
//
// Percent changes are computed at READ time
// (server/worldmonitor/economic/v1/world-cpi-monthly.ts) because a
// period-over-period change spans window boundaries that only exist after the
// merge across sources.
//
// Index bases differ per source and MUST NOT be compared directly:
//   IMF 2020=100, Eurostat 2015=100, OECD 2015=100, e-Stat 2020=100, ABS 2025=100.
// That is why each country row carries indexBase and why only percent changes
// are surfaced to callers.

import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';

// Trailing observation window per frequency. Trimmed at ingest so the canonical
// Redis values stay bounded; the full source history is not needed by any
// consumer and the window covers a 10-year comparison surface.
export const CPI_MONTHLY_WINDOW = 120;
export const CPI_QUARTERLY_WINDOW = 40;

// Number of trailing points the read path needs to derive both changes:
// one prior period plus the year-ago period, plus the current point itself.
export const MONTHLY_CHANGE_LAG = 13;
export const QUARTERLY_CHANGE_LAG = 5;

// The Australian Bureau of Statistics publishes CPI quarterly. The IMF also
// carries a monthly indicator for Australia, but mixing it into the same row
// would silently change the comparison basis, so the quarterly series is
// pinned for AU across every source that reports both.
export const QUARTERLY_PINNED_COUNTRIES = new Set(['AU']);

// Inputs whose publication lag is structural, not an outage. Budgets are the
// maximum tolerated age of the NEWEST observation in the source:
//   IMF   monthly prints land ~1-2 months after the reference month.
//   OECD  members publish on national schedules; ~2-3 months.
//   Eurostat HICP for month M lands mid M+1 (flash estimate at the end of M).
//   ABS   quarterly CPI, published ~4 weeks after quarter end.
//   e-Stat publishes the month's CPI ~3 weeks after month end.
export const CPI_MAX_CONTENT_AGE_MIN = {
  'imf-cpi': 120 * DAY_MIN,
  'oecd-cpi': 180 * DAY_MIN,
  'eurostat-hicp': 120 * DAY_MIN,
  'estat-cpi': 120 * DAY_MIN,
  'abs-cpi': 400 * DAY_MIN,
};

export const CPI_SOURCE_IDS = ['estat-cpi', 'eurostat-hicp', 'imf-cpi', 'oecd-cpi', 'abs-cpi'];

export const CPI_CANONICAL_KEYS = {
  'imf-cpi': 'economic:world-cpi:imf:v1',
  'eurostat-hicp': 'economic:world-cpi:eurostat:v1',
  'oecd-cpi': 'economic:world-cpi:oecd:v1',
  'estat-cpi': 'economic:world-cpi:estat:v1',
  'abs-cpi': 'economic:world-cpi:abs:v1',
};

export const CPI_LATEST_KEYS = {
  'imf-cpi': 'economic:world-cpi:imf:latest:v1',
  'eurostat-hicp': 'economic:world-cpi:eurostat:latest:v1',
  'oecd-cpi': 'economic:world-cpi:oecd:latest:v1',
  'estat-cpi': 'economic:world-cpi:estat:latest:v1',
  'abs-cpi': 'economic:world-cpi:abs:latest:v1',
};

export const CPI_ACTIVATION_KEYS = {
  'imf-cpi': 'seed-activated:economic:world-cpi-imf',
  'eurostat-hicp': 'seed-activated:economic:world-cpi-eurostat',
  'oecd-cpi': 'seed-activated:economic:world-cpi-oecd',
  'estat-cpi': 'seed-activated:economic:world-cpi-estat',
  'abs-cpi': 'seed-activated:economic:world-cpi-abs',
};

/**
 * Normalize an observation period to a sortable ISO token.
 *   '2026-M08' -> '2026-08'   (SDMX 3.0 monthly)
 *   '2026-08'  -> '2026-08'
 *   '2026-Q2'  -> '2026-Q2'
 * Returns undefined for anything else.
 */
export function normalizeCpiPeriod(period) {
  if (typeof period !== 'string') return undefined;
  const monthly = /^(\d{4})-M(\d{2})$/.exec(period);
  if (monthly) return `${monthly[1]}-${monthly[2]}`;
  if (/^\d{4}-\d{2}$/.test(period)) return period;
  if (/^\d{4}-Q[1-4]$/.test(period)) return period;
  return undefined;
}

export function monthOf(period) {
  return /^\d{4}-\d{2}$/.test(String(period ?? '')) ? String(period) : undefined;
}

export function quarterOf(period) {
  return /^\d{4}-Q[1-4]$/.test(String(period ?? '')) ? String(period) : undefined;
}

export function periodFrequency(period) {
  if (monthOf(period)) return 'M';
  if (quarterOf(period)) return 'Q';
  return undefined;
}

/**
 * Convert a period token to a month ordinal (`year * 12 + month`, 1-based) so
 * monthly and quarterly series can be compared for freshness on one axis.
 * A quarter resolves to its FIRST month, which is the conservative direction
 * for a staleness comparison.
 */
export function periodMonthOrdinal(period) {
  const monthly = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (monthly) return Number(monthly[1]) * 12 + Number(monthly[2]);
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(String(period ?? ''));
  if (quarterly) return Number(quarterly[1]) * 12 + (Number(quarterly[2]) - 1) * 3 + 1;
  return undefined;
}

/** Shift an ISO 'YYYY-MM' month token by delta months. */
export function shiftMonth(isoMonth, delta) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(isoMonth ?? ''));
  if (!match) return undefined;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Shift an ISO 'YYYY-Qn' quarter token by delta quarters. */
export function shiftQuarter(isoQuarter, delta) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(isoQuarter ?? ''));
  if (!match) return undefined;
  const total = Number(match[1]) * 4 + (Number(match[2]) - 1) + delta;
  return `${Math.floor(total / 4)}-Q${(total % 4) + 1}`;
}

/**
 * Normalize one country's raw points into a sorted, de-duplicated, windowed
 * series. Returns null when nothing valid remains.
 *
 * `points` accepts mixed frequencies (the IMF series carries M and Q) and keeps
 * ONE frequency only: monthly is preferred unless the country is frequency
 * pinned (AU), because a quarterly print of the same basket is strictly less
 * informative. Mixing the two in one series would corrupt the change math.
 *
 * @param {Array<{date:string,value:number}>} rawPoints
 * @param {{ iso2?: string, indexBase?: string }} [options]
 */
export function normalizeCountrySeries(rawPoints, { iso2, indexBase } = {}) {
  const byFrequency = { M: new Map(), Q: new Map() };
  for (const point of Array.isArray(rawPoints) ? rawPoints : []) {
    const date = normalizeCpiPeriod(point?.date);
    const value = Number(point?.value);
    const frequency = periodFrequency(date);
    if (!frequency || !Number.isFinite(value) || value <= 0) continue;
    byFrequency[frequency].set(date, value);
  }
  const pinned = iso2 ? QUARTERLY_PINNED_COUNTRIES.has(iso2) : false;
  const frequency = pinned
    ? (byFrequency.Q.size > 0 ? 'Q' : null)
    : (byFrequency.M.size > 0 ? 'M' : byFrequency.Q.size > 0 ? 'Q' : null);
  if (!frequency) return null;
  const window = frequency === 'M' ? CPI_MONTHLY_WINDOW : CPI_QUARTERLY_WINDOW;
  const points = [...byFrequency[frequency].entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
  const series = { frequency, points: points.slice(-window) };
  if (typeof indexBase === 'string' && indexBase.length > 0) series.indexBase = indexBase;
  return series;
}

function buildSeriesMap(byCountry, indexBases) {
  const countries = {};
  for (const [iso2, entry] of Object.entries(byCountry ?? {})) {
    const rawPoints = Array.isArray(entry) ? entry : entry?.points;
    const series = normalizeCountrySeries(rawPoints, { iso2, indexBase: indexBases?.[iso2] });
    if (!series) continue;
    countries[iso2] = series;
  }
  return countries;
}

/**
 * Build the canonical `{ countries }` payload from a `{ ISO2: [...] }` map.
 * `indexBases` optionally labels each country's index base string.
 */
export function buildNational(byCountry, indexBases) {
  return { countries: buildSeriesMap(byCountry, indexBases) };
}

/** Same as `buildNational`, for the IMF harmonised (HICP) series map. */
export function buildHarmonised(byCountry, indexBases) {
  return { harmonised: buildSeriesMap(byCountry, indexBases) };
}

/**
 * Series maps a canonical CPI payload may carry. `countries` is the national
 * CPI series; `harmonised` is the HICP series some sources report alongside it.
 */
export function cpiSeriesMaps(data) {
  return ['countries', 'harmonised']
    .map((field) => [field, data?.[field]])
    .filter(([, map]) => map && typeof map === 'object');
}

/**
 * Latest projection: for every series map, the newest point plus the trailing
 * points the read path needs to derive period-over-period and year-over-year
 * changes. `changeLag` is 13 for monthly sources (12 months back plus one prior
 * month) and 5 for quarterly (4 quarters back plus one prior quarter).
 */
export function latestCpiWindow(data, changeLag = MONTHLY_CHANGE_LAG) {
  const out = {};
  for (const [field, map] of cpiSeriesMaps(data)) {
    const windowed = {};
    for (const [iso2, entry] of Object.entries(map)) {
      const points = Array.isArray(entry?.points) ? entry.points : [];
      if (points.length === 0) continue;
      const lag = entry.frequency === 'Q' ? QUARTERLY_CHANGE_LAG : changeLag;
      windowed[iso2] = {
        frequency: entry.frequency,
        ...(entry.indexBase ? { indexBase: entry.indexBase } : {}),
        points: points.slice(-(lag + 1)),
      };
    }
    out[field] = windowed;
  }
  return out;
}

/** Total point count across every series map, for seed-meta recordCount. */
export function countCpiPoints(data) {
  return cpiSeriesMaps(data).reduce(
    (total, [, map]) => total + Object.values(map)
      .reduce((sum, entry) => sum + (entry?.points?.length ?? 0), 0),
    0,
  );
}

/**
 * Count countries with at least one national CPI point. Used as the contract
 * recordCount so a source that returns a handful of countries on a degraded
 * upstream day fails validation instead of publishing a near-empty canonical
 * key.
 */
export function countCpiCountries(data) {
  return Object.keys(data?.countries ?? {}).length;
}

/**
 * Content-age clock from the newest observation across every series map. A
 * frozen upstream ages every country out at once, so the newest observation is
 * the release clock for a worldwide source; one lagging country cannot mask a
 * frozen feed.
 *
 * Quarterly tokens resolve to the FIRST day of the quarter via
 * `periodTokenToMs`, which is conservative for a max-age budget: it reports an
 * older timestamp than the true period end.
 */
export function cpiContentMeta(data) {
  const tokens = [];
  for (const [, map] of cpiSeriesMaps(data)) {
    for (const entry of Object.values(map)) {
      const newest = entry?.points?.[entry.points.length - 1]?.date;
      if (newest) tokens.push(newest);
    }
  }
  if (tokens.length === 0) return null;
  return tokensToContentMeta(tokens);
}

/**
 * Split one line of RFC4180-style CSV into fields. Handles double-quoted fields
 * and embedded commas; the SDMX sources emit unquoted numeric CSV today, but a
 * provider-side quote would otherwise shift every column silently.
 */
export function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      fields.push(field);
      field = '';
      continue;
    }
    field += char;
  }
  fields.push(field);
  return fields;
}

/**
 * Parse an SDMX CSV document (IMF / OECD / ABS share the shape) into row
 * objects keyed by header name. The first line may carry a `STRUCTURE[;]`
 * marker; a UTF-8 BOM is tolerated. Empty lines are dropped.
 */
export function parseSdmxCsv(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((name) => name.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = fields[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

/**
 * ISO-3 -> ISO-2 lookup from the shared mapping document. Country aggregates
 * (e.g. `WLD`, `EUU`) are absent from the mapping and are therefore dropped by
 * callers rather than mistranslated.
 */
export function iso3ToIso2Map(iso3ToIso2) {
  return new Map(Object.entries(iso3ToIso2 ?? {}));
}
