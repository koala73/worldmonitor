// Monthly 10Y government bond yields for the markets without a covered daily
// curve, from two publishers of the same statistical concept:
//   - ECB "long-term interest rate for convergence purposes" (dataset IRS),
//     every EU member in one keyless CSV request. Primary for EU markets.
//   - OECD MEI long-term rates via FRED reprints (IRLTLT01<CC>M156N), keyless
//     CSV per series: https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES>
//     Sole source for non-EU markets and the history backfill for EU ones.
//
// Measured 2026-10-21 on 32-33 overlapping months per EU market: the two
// publishers agree to <= 0.011 pp except FR (max 0.055 pp, mean 0.016 pp).
// Surfaced as measure "monthly-10y", a different cadence from the daily curves.

import { periodTokenToMs, tokensToContentMeta } from '../../_content-age-helpers.mjs';

import { normalizeDateLabel, parseYieldNumber } from './model.mjs';

export const OECD_LT_MARKETS = {
  DE: 'IRLTLT01DEM156N', JP: 'IRLTLT01JPM156N', GB: 'IRLTLT01GBM156N', CA: 'IRLTLT01CAM156N',
  AU: 'IRLTLT01AUM156N', CH: 'IRLTLT01CHM156N', NO: 'IRLTLT01NOM156N', SE: 'IRLTLT01SEM156N',
  IT: 'IRLTLT01ITM156N', ES: 'IRLTLT01ESM156N', KR: 'IRLTLT01KRM156N', MX: 'IRLTLT01MXM156N',
  ZA: 'IRLTLT01ZAM156N', PL: 'IRLTLT01PLM156N', NL: 'IRLTLT01NLM156N', BE: 'IRLTLT01BEM156N',
  AT: 'IRLTLT01ATM156N', PT: 'IRLTLT01PTM156N', IE: 'IRLTLT01IEM156N', FI: 'IRLTLT01FIM156N',
  DK: 'IRLTLT01DKM156N', GR: 'IRLTLT01GRM156N', CZ: 'IRLTLT01CZM156N', HU: 'IRLTLT01HUM156N',
  CL: 'IRLTLT01CLM156N', FR: 'IRLTLT01FRM156N', US: 'IRLTLT01USM156N',
};

// ECB REF_AREA is the ISO2 code; the currency dimension is wildcarded so the
// non-euro members (DKK, CZK, HUF, PLN, SEK) ride the same request.
export const ECB_IRS_MARKETS = ['DE', 'IT', 'ES', 'NL', 'BE', 'AT', 'PT', 'IE', 'FI', 'DK', 'GR', 'CZ', 'HU', 'PL', 'FR', 'SE'];
export const ECB_IRS_URL = `https://data-api.ecb.europa.eu/service/data/IRS/M.${ECB_IRS_MARKETS.join('+')}.L.L40.CI.0000..N.Z?format=csvdata&detail=dataonly`;

export const OECD_LT_SOURCE_FRED = 'oecd-mei-monthly';
export const OECD_LT_SOURCE_ECB = 'ecb-irs-monthly';

export const OECD_LT_TENOR = '10y';

// Content budget per source = release lag + one normal cycle + one skipped
// release + the daily seed interval + margin, in days from the period start.
// Measured 2026-10-21:
//   ECB IRS: September 2026 rows appeared 2026-10-12 (41 d), all 16 markets.
//   FRED/OECD MEI (ALFRED first vintages, 2025-07..2026-09, 27 series): 43-47 d
//   normally; a release skipped for some countries lands at 74-77 d, two skips
//   at 105-106 d, one three-skip at 136 d (FI 2025-08).
// One skipped release therefore ages a market's latest print to at most
// 47 + 62 = 109 d; the second miss is what STALE_CONTENT reports.
const MONTH_DAYS = 31;
const SKIPPED_RELEASE_ALLOWANCE = 1;
const SEED_INTERVAL_DAYS = 1;
const MARGIN_DAYS = 10;
const RELEASE_LAG_DAYS = Object.freeze({
  [OECD_LT_SOURCE_ECB]: 41,
  [OECD_LT_SOURCE_FRED]: 47,
});

export function oecdSourceBudgetMinutes(releaseLagDays) {
  return (releaseLagDays + (1 + SKIPPED_RELEASE_ALLOWANCE) * MONTH_DAYS + SEED_INTERVAL_DAYS + MARGIN_DAYS) * 24 * 60;
}

export const OECD_LT_SOURCE_BUDGET_MIN = Object.freeze(Object.fromEntries(
  Object.entries(RELEASE_LAG_DAYS).map(([source, lagDays]) => [source, oecdSourceBudgetMinutes(lagDays)]),
));

// The health probe pins this single budget; the producer applies the tighter
// per-source budget above when it classifies each market.
export const OECD_LT_MAX_CONTENT_AGE_MIN = Math.max(...Object.values(OECD_LT_SOURCE_BUDGET_MIN));

export function parseFredCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  if (lines.length < 2) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    if (cells.length < 2) continue;
    const date = normalizeDateLabel(cells[0] ?? '');
    const value = parseYieldNumber(cells[1]);
    if (!date || value == null) continue;
    out.push({ date, value });
  }
  return out;
}

/** Parse the ECB IRS `csvdata` export into FRED-shaped month-start points per market. */
export function parseEcbIrsCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  if (lines.length < 2) return {};
  const header = lines[0].split(',');
  const areaIdx = header.indexOf('REF_AREA');
  const periodIdx = header.indexOf('TIME_PERIOD');
  const valueIdx = header.indexOf('OBS_VALUE');
  if (areaIdx < 0 || periodIdx < 0 || valueIdx < 0) return {};
  const out = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const market = cells[areaIdx]?.trim();
    const period = /^(\d{4})-(\d{2})$/.exec(cells[periodIdx]?.trim() ?? '');
    const value = parseYieldNumber(cells[valueIdx]);
    if (!market || !period || value == null) continue;
    const date = normalizeDateLabel(`${period[1]}-${period[2]}-01`);
    if (!date) continue;
    (out[market] ??= []).push({ date, value });
  }
  for (const points of Object.values(out)) points.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function mergeMarketSeries(primary, fallback) {
  const byDate = new Map();
  for (const { date, value } of fallback ?? []) byDate.set(date, { value, source: OECD_LT_SOURCE_FRED });
  for (const { date, value } of primary ?? []) byDate.set(date, { value, source: OECD_LT_SOURCE_ECB });
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return null;
  const sources = [];
  if (primary?.length) sources.push(OECD_LT_SOURCE_ECB);
  if (fallback?.length) sources.push(OECD_LT_SOURCE_FRED);
  return {
    source: byDate.get(dates.at(-1)).source,
    sources,
    curves: dates.map((date) => ({ date, tenors: { [OECD_LT_TENOR]: byDate.get(date).value } })),
  };
}

/**
 * Build the canonical payload from per-source parsed series. ECB wins on any
 * month both publish; FRED supplies every other month, including the decades
 * before the ECB series start. `source` names the publisher of the latest
 * print so readers can attribute what they serve as current.
 */
export function buildOecdLtPayload({ fred, ecb }) {
  const countries = {};
  const markets = new Set([...Object.keys(fred ?? {}), ...Object.keys(ecb ?? {})]);
  for (const market of markets) {
    const entry = mergeMarketSeries(ecb?.[market], fred?.[market]);
    if (entry) countries[market] = entry;
  }
  return { countries };
}

export function declareOecdRecords(payload) {
  const countries = payload?.countries;
  if (!countries || typeof countries !== 'object') return 0;
  return Object.values(countries).reduce((sum, entry) => sum + (Array.isArray(entry?.curves) ? entry.curves.length : 0), 0);
}

// Only each market's current observation participates; historical curve rows
// remain available to readers but cannot make the current snapshot stale.
export function oecdLatestContentMeta(data) {
  return tokensToContentMeta(Object.values(data?.countries ?? {})
    .map((entry) => entry?.curves?.at(-1)?.date));
}

function marketBudgetMs(entry) {
  const source = entry?.source ?? OECD_LT_SOURCE_FRED;
  const minutes = Object.hasOwn(OECD_LT_SOURCE_BUDGET_MIN, source) ? OECD_LT_SOURCE_BUDGET_MIN[source] : null;
  return minutes === null ? null : minutes * 60_000;
}

export function oecdContentFreshness(data, now = Date.now()) {
  const countries = Object.keys(OECD_LT_MARKETS);
  const observations = countries.map((country) => {
    const entry = data?.countries?.[country];
    const budgetMs = marketBudgetMs(entry);
    const at = budgetMs === null ? null : periodTokenToMs(entry?.curves?.at(-1)?.date);
    return { country, at, budgetMs };
  });
  const unknown = observations.filter(({ at }) => at === null);
  const stale = observations.filter(({ at, budgetMs }) => at !== null
    && (at > now || now - at >= budgetMs));
  const oldest = observations.filter(({ at }) => at !== null)
    .sort((a, b) => a.at - b.at)[0];
  return {
    coveredCount: countries.length,
    freshCount: countries.length - unknown.length - stale.length,
    staleCount: stale.length,
    unknownCount: unknown.length,
    staleCountries: stale.map(({ country }) => country),
    criticalCountries: countries,
    criticalFreshCount: countries.length - unknown.length - stale.length,
    criticalStaleCountries: [...stale, ...unknown].map(({ country }) => country),
    criticalMissingCountries: unknown.length,
    criticalOldestObservedAt: oldest?.at ?? null,
    criticalOldestObservedCountry: oldest?.country ?? null,
  };
}
