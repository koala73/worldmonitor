#!/usr/bin/env node
// Monthly oil supply and export series for major exporting countries
// (energy:oil-trade-series:v1, #9392), from declared sources:
//
//   production  EIA Short-Term Energy Outlook, crude oil and liquid fuels
//               supply per country (PAPR_*). Current to the last complete
//               month; recent months are EIA estimates and are revised.
//   jodi        JODI-Oil World Database crude and total-product exports, every
//               month (not just the newest). The UAE has filed only
//               placeholders since 2019, so for it this source is
//               not_reported rather than zero.
//   mirror      UN Comtrade monthly imports FROM the country as declared by
//               each buyer (HS 2709 crude, 2710 products). Buyers file 1-4
//               months late and some file no monthly partner data at all
//               (China after 2024-12), so it is a partial, lagging sample.
//   ais         IMF PortWatch AIS-derived tanker export tonnes summed over
//               the country's ports. An observed-loadings index only: it
//               undercounts real exports (about 0.6 of declared volumes in
//               normal months and 0.3 for the UAE during the 2026 Hormuz
//               closure, when ships ran dark), so it is never an export total.
//
// No source is turned into a modelled export estimate. A month a source does
// not cover is null, never zero, and every source carries its newest observed
// month and a status (ok, stale, not_reported, unavailable).

import { loadEnvFile, CHROME_UA, runSeed, withRetry, resolveProxyForConnect, httpsProxyFetchRaw, readSeedSnapshot } from './_seed-utils.mjs';
import { DAY_MIN } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { fetchYearCsv, parseObsValue } from './seed-jodi-oil.mjs';
import {
  compactCountry,
  lastCompleteMonth,
  monthDays,
  monthRange,
  shiftMonth,
} from './shared/oil-trade-windows.js';

loadEnvFile(import.meta.url);

export const OIL_TRADE_CANONICAL_KEY = 'energy:oil-trade-series:v1';
export const OIL_TRADE_ACTIVATION_KEY = 'seed-activated:energy:oil-trade-series';
const CACHE_TTL_SECONDS = 21 * 24 * 60 * 60; // 3x the weekly cadence
const SERIES_MONTHS = 24;
const REQUEST_TIMEOUT_MS = 90_000;
const MIN_COUNTRIES_WITH_PRODUCTION = 18;

// Approximate barrels per metric tonne. Crude varies about 7.0-7.6 by grade
// and products about 7.0-8.5 by product, so mirror and AIS kb/d carry a few
// percent of conversion error on top of their coverage limits.
export const CRUDE_BBL_PER_TONNE = 7.33;
export const PRODUCTS_BBL_PER_TONNE = 7.6;

// Months after which a source counts as stale, measured from the last
// complete month. Matches each source's normal publication lag plus slack.
const MAX_LAG_MONTHS = { production: 2, jodi: 6, mirror: 4, ais: 1 };
const AIS_MAX_DATASET_AGE_DAYS = 21;
// Fallback unit-error screen when the exporter has no production series:
// Thailand filed 66.5 Mt of UAE crude for 2024-11 against ~2 Mt normally
// (33x). Product cargoes are lumpy, so a real month can be 10x a buyer's
// median; only an order-of-magnitude-plus jump is treated as a unit error.
const MIRROR_OUTLIER_RATIO = 20;
const MIRROR_TOP_REPORTERS = 8;
const COUNTRY_CONCURRENCY = 3;

// eia: STEO PAPR series suffix (EIA's FIPS-style code, not ISO).
export const OIL_TRADE_COUNTRIES = [
  { iso2: 'SA', iso3: 'SAU', m49: 682, name: 'Saudi Arabia', eia: 'SA' },
  { iso2: 'AE', iso3: 'ARE', m49: 784, name: 'United Arab Emirates', eia: 'TC' },
  { iso2: 'IQ', iso3: 'IRQ', m49: 368, name: 'Iraq', eia: 'IZ' },
  { iso2: 'KW', iso3: 'KWT', m49: 414, name: 'Kuwait', eia: 'KU' },
  { iso2: 'IR', iso3: 'IRN', m49: 364, name: 'Iran', eia: 'IR' },
  { iso2: 'QA', iso3: 'QAT', m49: 634, name: 'Qatar', eia: 'QA' },
  { iso2: 'OM', iso3: 'OMN', m49: 512, name: 'Oman', eia: 'MU' },
  { iso2: 'BH', iso3: 'BHR', m49: 48, name: 'Bahrain', eia: 'BA' },
  { iso2: 'RU', iso3: 'RUS', m49: 643, name: 'Russia', eia: 'RS' },
  { iso2: 'KZ', iso3: 'KAZ', m49: 398, name: 'Kazakhstan', eia: 'KZ' },
  { iso2: 'AZ', iso3: 'AZE', m49: 31, name: 'Azerbaijan', eia: 'AJ' },
  { iso2: 'NO', iso3: 'NOR', m49: 579, name: 'Norway', eia: 'NO' },
  { iso2: 'US', iso3: 'USA', m49: 842, name: 'United States', eia: 'US' },
  { iso2: 'CA', iso3: 'CAN', m49: 124, name: 'Canada', eia: 'CA' },
  { iso2: 'BR', iso3: 'BRA', m49: 76, name: 'Brazil', eia: 'BR' },
  { iso2: 'MX', iso3: 'MEX', m49: 484, name: 'Mexico', eia: 'MX' },
  { iso2: 'GY', iso3: 'GUY', m49: 328, name: 'Guyana', eia: 'GY' },
  { iso2: 'CO', iso3: 'COL', m49: 170, name: 'Colombia', eia: 'CO' },
  { iso2: 'VE', iso3: 'VEN', m49: 862, name: 'Venezuela', eia: 'VE' },
  { iso2: 'NG', iso3: 'NGA', m49: 566, name: 'Nigeria', eia: 'NI' },
  { iso2: 'AO', iso3: 'AGO', m49: 24, name: 'Angola', eia: 'AO' },
  { iso2: 'LY', iso3: 'LBY', m49: 434, name: 'Libya', eia: 'LY' },
  { iso2: 'DZ', iso3: 'DZA', m49: 12, name: 'Algeria', eia: 'AG' },
  { iso2: 'MY', iso3: 'MYS', m49: 458, name: 'Malaysia', eia: 'MY' },
];

const SOURCE_INFO = {
  production: {
    name: 'EIA Short-Term Energy Outlook',
    url: 'https://www.eia.gov/outlooks/steo/',
    measure: 'Crude oil and liquid fuels supply (production, including condensate and NGLs), kb/d. Recent months are EIA estimates and are revised monthly.',
  },
  jodi: {
    name: 'JODI-Oil World Database',
    url: 'https://www.jodidata.org/oil/',
    measure: 'Crude oil exports (CRUDEOIL TOTEXPSB) and total product exports (TOTPRODS TOTEXPSB) as reported by the country, kb/d.',
  },
  mirror: {
    name: 'UN Comtrade (mirror imports)',
    url: 'https://comtradeapi.un.org/',
    measure: `Imports from the country declared by each buying country, HS 2709 crude and HS 2710 products, converted at ${CRUDE_BBL_PER_TONNE} and ${PRODUCTS_BBL_PER_TONNE} bbl/t, kb/d. A sample of buyers, not total exports.`,
  },
  ais: {
    name: 'IMF PortWatch',
    url: 'https://portwatch.imf.org/',
    measure: `AIS-derived tanker export tonnes summed over the country's ports, converted at ${CRUDE_BBL_PER_TONNE} bbl/t, kb/d. An observed-loadings index that undercounts real exports; not an export total.`,
  },
};

/** A finite number, or null for null, undefined, blank or non-numeric input. */
function presentNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── EIA STEO ────────────────────────────────────────────────────────────────

/**
 * @param {Array<{seriesId: string, period: string, value: string|number}>} rows
 * @param {number} nowMs
 * @returns {Map<string, Map<string, {kbd: number, provisional: boolean}>>}
 */
export function buildEiaSeries(rows, nowMs) {
  const bySeries = new Map(OIL_TRADE_COUNTRIES.map((c) => [`PAPR_${c.eia}`, c.iso2]));
  const end = lastCompleteMonth(nowMs);
  // The newest two complete months are EIA estimates at best, and before the
  // month's STEO release they are the previous vintage's forecast.
  const provisionalFrom = shiftMonth(end, -1);
  const out = new Map();
  for (const row of rows ?? []) {
    const iso2 = bySeries.get(row?.seriesId);
    const month = typeof row?.period === 'string' ? row.period.slice(0, 7) : null;
    // Number(null) and Number('') are 0: an absent value must stay absent.
    const mbd = presentNumber(row?.value);
    if (!iso2 || !month || month > end || mbd === null || mbd < 0) continue;
    if (!out.has(iso2)) out.set(iso2, new Map());
    out.get(iso2).set(month, { kbd: Math.round(mbd * 1000), provisional: month >= provisionalFrom });
  }
  return out;
}

async function fetchEiaRows(nowMs) {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error('EIA_API_KEY not set');
  const end = lastCompleteMonth(nowMs);
  const params = new URLSearchParams({
    api_key: key,
    frequency: 'monthly',
    'data[0]': 'value',
    start: shiftMonth(end, -(SERIES_MONTHS - 1)),
    end,
    length: '5000',
  });
  for (const c of OIL_TRADE_COUNTRIES) params.append('facets[seriesId][]', `PAPR_${c.eia}`);
  const resp = await fetch(`https://api.eia.gov/v2/steo/data/?${params}`, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`EIA STEO HTTP ${resp.status}`);
  // EIA occasionally emits raw control characters inside string fields.
  // eslint-disable-next-line no-control-regex
  const body = JSON.parse((await resp.text()).replace(/[\u0000-\u001f]+/g, ' '));
  const rows = body?.response?.data;
  if (!Array.isArray(rows)) throw new Error('EIA STEO response has no data array');
  return rows;
}

// ── JODI ────────────────────────────────────────────────────────────────────

const JODI_FIELDS = {
  'CRUDEOIL|TOTEXPSB': 'crudeExportsKbd',
  'CRUDEOIL|INDPROD': 'crudeProductionKbd',
  'TOTPRODS|TOTEXPSB': 'productExportsKbd',
};

/**
 * Every month of reported JODI exports per country. Assessment code 3 ("not
 * assessed") is a reported value; placeholders ('-', '..', 'x') are absent.
 *
 * @returns {Map<string, Map<string, {crudeExportsKbd: number|null, crudeProductionKbd: number|null, productExportsKbd: number|null}>>}
 */
export function buildJodiSeries(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    if (r.UNIT_MEASURE !== 'KBD') continue;
    const field = JODI_FIELDS[`${r.ENERGY_PRODUCT}|${r.FLOW_BREAKDOWN}`];
    if (!field) continue;
    const value = parseObsValue(r.OBS_VALUE);
    if (value === null) continue;
    if (!out.has(r.REF_AREA)) out.set(r.REF_AREA, new Map());
    const months = out.get(r.REF_AREA);
    if (!months.has(r.TIME_PERIOD)) {
      months.set(r.TIME_PERIOD, { crudeExportsKbd: null, crudeProductionKbd: null, productExportsKbd: null });
    }
    months.get(r.TIME_PERIOD)[field] = value;
  }
  return out;
}

/** Keep only the rows this seeder reads, without materialising whole files. */
function filterJodiCsv(text, wanted) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split('\n');
  const header = lines[0].replace(/\r$/, '').split(',').map((h) => h.replace(/^"|"$/g, ''));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!wanted.has(line.slice(0, 2).replace(/"/g, ''))) continue;
    const cells = line.replace(/\r$/, '').split(',').map((c) => c.replace(/^"|"$/g, ''));
    const row = {
      REF_AREA: cells[idx.REF_AREA],
      TIME_PERIOD: cells[idx.TIME_PERIOD],
      ENERGY_PRODUCT: cells[idx.ENERGY_PRODUCT],
      FLOW_BREAKDOWN: cells[idx.FLOW_BREAKDOWN],
      UNIT_MEASURE: cells[idx.UNIT_MEASURE],
      OBS_VALUE: cells[idx.OBS_VALUE],
      ASSESSMENT_CODE: cells[idx.ASSESSMENT_CODE],
    };
    if (wanted.has(row.REF_AREA) && JODI_FIELDS[`${row.ENERGY_PRODUCT}|${row.FLOW_BREAKDOWN}`]) rows.push(row);
  }
  return rows;
}

/**
 * Every year file the 24-month window needs. A year that is not published yet
 * (the current year in early January) or fails is skipped: the months it would
 * hold show up as a stale lastObserved, not as lost history for prior years.
 * Throws only when no file loads at all.
 */
export async function fetchJodiRows(nowMs, { fetchYear = fetchYearCsv } = {}) {
  const wanted = new Set(OIL_TRADE_COUNTRIES.map((c) => c.iso2));
  const year = new Date(nowMs).getUTCFullYear();
  const years = [year, year - 1, year - 2];
  const rows = [];
  let loaded = 0;
  // Sequential: each file is 5-26 MB and only the filtered rows are kept.
  for (const kind of ['primary', 'secondary']) {
    for (const y of years) {
      const result = await fetchYear(kind, y);
      if (!result.ok) {
        console.warn(`  JODI ${kind}/${y} unavailable: ${result.error}`);
        continue;
      }
      loaded++;
      rows.push(...filterJodiCsv(result.text, wanted));
    }
  }
  if (loaded === 0) throw new Error('no JODI year file could be loaded');
  return rows;
}

// ── Comtrade mirror ─────────────────────────────────────────────────────────

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Monthly imports from one exporter as declared by its buyers.
 *
 * A buyer-month larger than the exporter's whole production that month is a
 * filing error (one buyer cannot receive more than the country produced), so
 * it is dropped. Without a production series the 20x-median screen applies.
 *
 * @param {Array<{reporterISO: string, period: string, cmdCode: string, netWgt: number|null}>} rows
 * @param {{ production?: Map<string, {kbd: number}> }} [opts]
 * @returns {Map<string, {crudeKbd: number|null, productsKbd: number|null, reporters: Record<string, {crudeKbd?: number, productsKbd?: number}>}>}
 */
export function buildMirrorSeries(rows, { production = new Map() } = {}) {
  // tonnes[reporter][cmd][month]
  const tonnes = new Map();
  for (const r of rows ?? []) {
    const kg = Number(r?.netWgt);
    if (!r?.reporterISO || !/^[A-Z]{3}$/.test(r.reporterISO) || !Number.isFinite(kg) || kg <= 0) continue;
    if (r.cmdCode !== '2709' && r.cmdCode !== '2710') continue;
    const month = `${String(r.period).slice(0, 4)}-${String(r.period).slice(4, 6)}`;
    const byCmd = tonnes.get(r.reporterISO) ?? new Map();
    tonnes.set(r.reporterISO, byCmd);
    const byMonth = byCmd.get(r.cmdCode) ?? new Map();
    byCmd.set(r.cmdCode, byMonth);
    byMonth.set(month, (byMonth.get(month) ?? 0) + kg / 1000);
  }

  const out = new Map();
  for (const [reporter, byCmd] of tonnes) {
    for (const [cmd, byMonth] of byCmd) {
      const field = cmd === '2709' ? 'crudeKbd' : 'productsKbd';
      const bblPerTonne = cmd === '2709' ? CRUDE_BBL_PER_TONNE : PRODUCTS_BBL_PER_TONNE;
      for (const [month, t] of byMonth) {
        const kbd = (t * bblPerTonne) / monthDays(month) / 1000;
        const producedKbd = production.get(month)?.kbd;
        if (typeof producedKbd === 'number' && producedKbd > 0) {
          if (kbd > producedKbd) {
            console.warn(`  mirror: dropping ${reporter} ${cmd} ${month} (${Math.round(kbd)} kb/d exceeds production ${producedKbd})`);
            continue;
          }
        } else {
          const others = [...byMonth].filter(([m]) => m !== month).map(([, v]) => v);
          if (others.length >= 3 && t > MIRROR_OUTLIER_RATIO * median(others)) {
            console.warn(`  mirror: dropping ${reporter} ${cmd} ${month} (${Math.round(t)} t, ${MIRROR_OUTLIER_RATIO}x+ its median)`);
            continue;
          }
        }
        const record = out.get(month) ?? { crudeKbd: null, productsKbd: null, reporters: {} };
        out.set(month, record);
        record.reporters[reporter] = { ...record.reporters[reporter], [field]: kbd };
        record[field] = (record[field] ?? 0) + kbd;
      }
    }
  }
  return out;
}

/**
 * Keep the exporter's largest buyers and fold the rest into otherKbd, so the
 * per-country record stays small. The matched-basis comparison runs on named
 * reporters only, so buyers are ranked by volume over the 12 months ending at
 * `endMonth` (the default current + prior windows): a heavy buyer that stopped
 * filing (China after 2024-12) must not push out one that files through the
 * windows being compared. All-time volume only breaks ties.
 */
export function trimMirrorReporters(series, keep = MIRROR_TOP_REPORTERS, endMonth = [...series.keys()].sort().at(-1)) {
  const recentFrom = endMonth ? shiftMonth(endMonth, -11) : null;
  const recent = new Map();
  const totals = new Map();
  for (const [month, record] of series) {
    for (const [r, v] of Object.entries(record.reporters)) {
      const kbd = (v.crudeKbd ?? 0) + (v.productsKbd ?? 0);
      totals.set(r, (totals.get(r) ?? 0) + kbd);
      if (recentFrom && month >= recentFrom && month <= endMonth) recent.set(r, (recent.get(r) ?? 0) + kbd);
    }
  }
  const top = new Set([...totals.keys()]
    .sort((a, b) => (recent.get(b) ?? 0) - (recent.get(a) ?? 0) || totals.get(b) - totals.get(a) || a.localeCompare(b))
    .slice(0, keep));
  for (const record of series.values()) {
    const reporters = {};
    const other = {};
    for (const [r, v] of Object.entries(record.reporters)) {
      if (top.has(r)) { reporters[r] = v; continue; }
      for (const f of ['crudeKbd', 'productsKbd']) if (v[f] != null) other[f] = (other[f] ?? 0) + v[f];
    }
    record.reporters = reporters;
    record.otherKbd = Object.keys(other).length ? other : null;
  }
  return series;
}

/**
 * Map raw Comtrade monthly rows (requested with includeDesc=true; without it
 * reporterISO is null) to mirror rows. isAggregate is true on every
 * customs/transport-mode total row, so it does not identify group reporters;
 * the ISO3 shape check in buildMirrorSeries does.
 */
export function mirrorRowsFromComtrade(data, spec) {
  const rows = [];
  for (const r of data ?? []) {
    if (!r?.reporterISO || r.reporterISO === spec.iso3) continue;
    rows.push({ reporterISO: r.reporterISO, period: String(r.period), cmdCode: String(r.cmdCode), netWgt: r.netWgt });
  }
  return rows;
}

// Comtrade throttles per key: one call in flight per key, spaced out.
const COMTRADE_MIN_GAP_MS = 2000;
const comtradeLanes = new Map();
function comtradeLane(key, task) {
  const previous = comtradeLanes.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  comtradeLanes.set(key, run.then(
    () => new Promise((resolve) => setTimeout(resolve, COMTRADE_MIN_GAP_MS)),
    () => new Promise((resolve) => setTimeout(resolve, COMTRADE_MIN_GAP_MS)),
  ));
  return run;
}

async function fetchComtradeJson(url, key) {
  return comtradeLane(key, () => fetchComtradeJsonNow(url, key));
}

async function fetchComtradeJsonNow(url, key) {
  const resp = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': key, 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 429) throw new Error('Comtrade rate limited (429)');
  if (!resp.ok) throw new Error(`Comtrade HTTP ${resp.status}`);
  const body = await resp.json();
  if (body?.error) throw new Error(`Comtrade error: ${String(body.error).slice(0, 200)}`);
  return Array.isArray(body?.data) ? body.data : [];
}

async function fetchMirrorRows(spec, nowMs, keyIndex) {
  const keys = (process.env.COMTRADE_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('COMTRADE_API_KEYS not set');
  const key = keys[keyIndex % keys.length];
  const end = lastCompleteMonth(nowMs);
  const months = monthRange(shiftMonth(end, -(SERIES_MONTHS - 1)), end).map((m) => m.replace('-', ''));
  const rows = [];
  // The monthly endpoint takes at most 12 periods per call.
  for (let i = 0; i < months.length; i += 12) {
    const params = new URLSearchParams({
      period: months.slice(i, i + 12).join(','),
      partnerCode: String(spec.m49),
      cmdCode: '2709,2710',
      flowCode: 'M',
      customsCode: 'C00',
      motCode: '0',
      partner2Code: '0',
      // reporterISO is null unless descriptions are included.
      includeDesc: 'true',
    });
    const data = await withRetry(() => fetchComtradeJson(`https://comtradeapi.un.org/data/v1/get/C/M/HS?${params}`, key), 3, 8000);
    rows.push(...mirrorRowsFromComtrade(data, spec));
  }
  return rows;
}

// ── PortWatch AIS ───────────────────────────────────────────────────────────

const PORTWATCH_PORTS_URL =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query';

/**
 * @param {Array<{attributes: {year: number, month: number, exportTankerT: number, tankerCalls: number, maxDate: string}}>} features
 */
export function buildAisSeries(features) {
  const months = new Map();
  let datasetMaxDate = null;
  for (const f of features ?? []) {
    const a = f?.attributes ?? {};
    if (!Number.isInteger(a.year) || !Number.isInteger(a.month) || typeof a.maxDate !== 'string') continue;
    const month = `${a.year}-${String(a.month).padStart(2, '0')}`;
    const maxDate = a.maxDate.slice(0, 10);
    if (!datasetMaxDate || maxDate > datasetMaxDate) datasetMaxDate = maxDate;
    const complete = maxDate === `${month}-${String(monthDays(month)).padStart(2, '0')}`;
    const tonnes = presentNumber(a.exportTankerT);
    months.set(month, {
      complete,
      tankerCalls: presentNumber(a.tankerCalls),
      exportTankerKt: tonnes === null ? null : tonnes / 1000,
      // A partial month has no rate: dividing part-month tonnes by the full
      // month (or by a guessed day count) would invent a number.
      loadingsKbd: complete && tonnes !== null ? (tonnes * CRUDE_BBL_PER_TONNE) / monthDays(month) / 1000 : null,
    });
  }
  return { months, datasetMaxDate };
}

async function arcgisJson(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 429) throw Object.assign(new Error('ArcGIS 429'), { proxyable: true });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    const body = await resp.json();
    if (body?.error) throw new Error(`ArcGIS error: ${body.error.message ?? body.error.code}`);
    return body;
  } catch (err) {
    // ArcGIS rate-limits seed-server egress by stalling or 429ing; the
    // PortWatch port-activity seeder routes the same failure through the proxy.
    const timeoutLike = err?.name === 'TimeoutError' || err?.proxyable || /fetch failed/i.test(err?.message ?? '');
    const proxyAuth = timeoutLike ? resolveProxyForConnect() : null;
    if (!proxyAuth) throw err;
    const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json', timeoutMs: 50_000 });
    const body = JSON.parse(buffer.toString('utf8'));
    if (body?.error) throw new Error(`ArcGIS error via proxy: ${body.error.message ?? body.error.code}`);
    return body;
  }
}

async function fetchAisFeatures(spec, nowMs) {
  const start = `${shiftMonth(lastCompleteMonth(nowMs), -(SERIES_MONTHS - 1))}-01`;
  const params = new URLSearchParams({
    where: `ISO3='${spec.iso3}' AND date >= '${start}'`,
    outStatistics: JSON.stringify([
      { statisticType: 'sum', onStatisticField: 'export_tanker', outStatisticFieldName: 'exportTankerT' },
      { statisticType: 'sum', onStatisticField: 'portcalls_tanker', outStatisticFieldName: 'tankerCalls' },
      { statisticType: 'max', onStatisticField: 'date', outStatisticFieldName: 'maxDate' },
    ]),
    groupByFieldsForStatistics: 'year,month',
    orderByFields: 'year,month',
    f: 'json',
  });
  const body = await withRetry(() => arcgisJson(`${PORTWATCH_PORTS_URL}?${params}`), 1, 3000);
  return Array.isArray(body?.features) ? body.features : [];
}

// ── Assembly ────────────────────────────────────────────────────────────────

function sourceStatus(name, lastObserved, end, failed, extra = {}) {
  let status;
  if (failed) status = 'unavailable';
  else if (!lastObserved) status = 'not_reported';
  else status = monthRange(lastObserved, end).length - 1 > MAX_LAG_MONTHS[name] ? 'stale' : 'ok';
  return { ...SOURCE_INFO[name], status, lastObserved, ...extra };
}

const newest = (months, ok = () => true) => [...months].filter(([, v]) => ok(v)).map(([m]) => m).sort().at(-1) ?? null;

/**
 * One country's series, month by month, plus per-source status.
 *
 * @param {{ spec: typeof OIL_TRADE_COUNTRIES[number], eia: Map, jodi: Map, mirror: Map,
 *   ais: { months: Map, datasetMaxDate: string|null }, nowMs: number, failed?: Set<string> }} input
 */
export function assembleCountry({ spec, eia, jodi, mirror, ais, nowMs, failed = new Set() }) {
  const end = lastCompleteMonth(nowMs);
  const months = monthRange(shiftMonth(end, -(SERIES_MONTHS - 1)), end).map((month) => {
    const aisMonth = ais.months.get(month) ?? null;
    return {
      month,
      production: eia.get(month) ?? null,
      jodi: jodi.get(month) ?? null,
      mirror: mirror.get(month) ?? null,
      ais: aisMonth,
    };
  });

  // A complete month with no export total is not an observed loading.
  const aisLast = newest(ais.months, (v) => v.complete && v.loadingsKbd !== null);
  const datasetAgeDays = ais.datasetMaxDate
    ? (nowMs - Date.parse(`${ais.datasetMaxDate}T00:00:00Z`)) / 86_400_000
    : null;
  const aisSource = sourceStatus('ais', aisLast, end, failed.has('ais'), { datasetMaxDate: ais.datasetMaxDate });
  if (aisSource.status === 'ok' && datasetAgeDays != null && datasetAgeDays > AIS_MAX_DATASET_AGE_DAYS) {
    aisSource.status = 'stale';
  }

  return {
    iso2: spec.iso2,
    iso3: spec.iso3,
    name: spec.name,
    months,
    sources: {
      production: sourceStatus('production', newest(eia), end, failed.has('production'), { series: `PAPR_${spec.eia}` }),
      jodi: sourceStatus('jodi', newest(jodi), end, failed.has('jodi')),
      mirror: sourceStatus('mirror', newest(mirror), end, failed.has('mirror')),
      ais: aisSource,
    },
  };
}

const countriesWithCurrentProduction = (data) =>
  Object.values(data?.countries ?? {}).filter((c) => c?.sources?.production?.status === 'ok').length;

const SOURCE_COLUMNS = ['production', 'jodi', 'mirror', 'ais'];

/** Re-index month-aligned columns from the previous series onto the current months. */
function realignColumns(value, prevMonths, months) {
  if (Array.isArray(value)) {
    const byMonth = new Map(prevMonths.map((m, i) => [m, value[i] ?? null]));
    return months.map((m) => byMonth.get(m) ?? null);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, realignColumns(v, prevMonths, months)]));
  }
  return value;
}

/**
 * For each source that failed this run, keep the previous publish's months
 * (realigned to this run's window) instead of publishing nulls over them.
 * The source stays `unavailable`, and lastObserved keeps the month it was
 * last actually seen, so the gap is reported rather than hidden or erased.
 */
export function carryForwardFailedSources(current, previous) {
  if (!previous?.from || !previous?.to || !current?.from || !current?.to) return current;
  const months = monthRange(current.from, current.to);
  const prevMonths = monthRange(previous.from, previous.to);
  const out = { ...current, sources: { ...current.sources } };
  for (const source of SOURCE_COLUMNS) {
    const status = current.sources?.[source]?.status;
    const prevSource = previous.sources?.[source];
    if (status !== 'unavailable' || !prevSource?.lastObserved || !previous[source]) continue;
    out[source] = realignColumns(previous[source], prevMonths, months);
    out.sources[source] = { ...current.sources[source], lastObserved: prevSource.lastObserved, carriedForward: true };
  }
  return out;
}

export function validate(data) {
  return countriesWithCurrentProduction(data) >= MIN_COUNTRIES_WITH_PRODUCTION;
}

// Countries whose production series is current: the measure health's
// minRecordCount gates, so a run that lost EIA reads COVERAGE_PARTIAL.
export function declareRecords(data) {
  return countriesWithCurrentProduction(data);
}

export function contentMeta(data) {
  const months = Object.values(data?.countries ?? {})
    .map((c) => c?.sources?.production?.lastObserved)
    .filter(Boolean)
    .sort();
  if (months.length === 0) return null;
  // Content age is the newest production month's end: EIA publishes monthly,
  // so a newest month more than ~2 months behind means the STEO feed stopped.
  const endOf = (m) => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0, 23, 59, 59);
  return { newestItemAt: endOf(months.at(-1)), oldestItemAt: endOf(months[0]) };
}

export async function fetchOilTradeSeries({ nowMs = Date.now() } = {}) {
  // Best effort: a failed source keeps these months instead of being nulled.
  const previous = await readSeedSnapshot(OIL_TRADE_CANONICAL_KEY).catch(() => null);
  const failed = { production: false, jodi: false };
  let eia = new Map();
  let jodi = new Map();
  const t0 = Date.now();
  try {
    eia = buildEiaSeries(await withRetry(() => fetchEiaRows(nowMs), 2, 5000), nowMs);
  } catch (err) {
    failed.production = true;
    console.warn(`  EIA STEO unavailable: ${err.message}`);
  }
  console.log(`  EIA STEO: ${eia.size} countries (${Math.round((Date.now() - t0) / 1000)}s)`);
  try {
    jodi = buildJodiSeries(await fetchJodiRows(nowMs));
  } catch (err) {
    failed.jodi = true;
    console.warn(`  JODI unavailable: ${err.message}`);
  }
  console.log(`  JODI: ${jodi.size} countries with reported months (${Math.round((Date.now() - t0) / 1000)}s)`);

  const countries = {};
  const unavailable = { mirror: [], ais: [] };
  const buildOne = async (spec, index) => {
    const startedAt = Date.now();
    const countryFailed = new Set(Object.entries(failed).filter(([, v]) => v).map(([k]) => k));
    let mirror = new Map();
    let ais = { months: new Map(), datasetMaxDate: null };
    try {
      mirror = trimMirrorReporters(buildMirrorSeries(await fetchMirrorRows(spec, nowMs, index), {
        production: eia.get(spec.iso2) ?? new Map(),
      }), MIRROR_TOP_REPORTERS, lastCompleteMonth(nowMs));
    } catch (err) {
      countryFailed.add('mirror');
      unavailable.mirror.push(spec.iso2);
      console.warn(`  ${spec.iso2} Comtrade mirror unavailable: ${err.message}`);
    }
    try {
      ais = buildAisSeries(await fetchAisFeatures(spec, nowMs));
    } catch (err) {
      countryFailed.add('ais');
      unavailable.ais.push(spec.iso2);
      console.warn(`  ${spec.iso2} PortWatch unavailable: ${err.message}`);
    }
    const country = assembleCountry({
      spec,
      eia: eia.get(spec.iso2) ?? new Map(),
      jodi: jodi.get(spec.iso2) ?? new Map(),
      mirror,
      ais,
      nowMs,
      failed: countryFailed,
    });
    countries[spec.iso2] = carryForwardFailedSources(compactCountry(country), previous?.countries?.[spec.iso2]);
    const s = country.sources;
    console.log(`  ${spec.iso2}: production ${s.production.status}@${s.production.lastObserved ?? '-'}`
      + ` jodi ${s.jodi.status}@${s.jodi.lastObserved ?? '-'} mirror ${s.mirror.status}@${s.mirror.lastObserved ?? '-'}`
      + ` ais ${s.ais.status}@${s.ais.lastObserved ?? '-'} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  };
  // Three at a time: Comtrade and ArcGIS both throttle bursts, and each
  // country is two Comtrade calls plus one aggregated PortWatch query.
  const queue = OIL_TRADE_COUNTRIES.map((spec, index) => ({ spec, index }));
  await Promise.all(Array.from({ length: COUNTRY_CONCURRENCY }, async () => {
    while (queue.length) {
      const { spec, index } = queue.shift();
      await buildOne(spec, index);
    }
  }));
  // Stable key order regardless of completion order.
  const ordered = Object.fromEntries(OIL_TRADE_COUNTRIES.map((c) => [c.iso2, countries[c.iso2]]));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    throughMonth: lastCompleteMonth(nowMs),
    conversion: { crudeBblPerTonne: CRUDE_BBL_PER_TONNE, productsBblPerTonne: PRODUCTS_BBL_PER_TONNE },
    unavailable,
    countries: ordered,
  };
}

// Durable marker read by api/health.js: once set, an absent or stale series
// is a fault rather than a deploy-before-first-publish gap.
async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', OIL_TRADE_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: oil-trade-series activation marker write failed: ${err?.message || err}`);
  }
}

export const seedOptions = {
  validateFn: validate,
  ttlSeconds: CACHE_TTL_SECONDS,
  sourceVersion: 'eia-steo-jodi-comtrade-portwatch-v1',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 14 * DAY_MIN, // weekly cadence; two missed runs
  contentMeta,
  // The newest STEO month normally sits one month behind; three months behind
  // means EIA publication or our fetch has stopped.
  maxContentAgeMin: 100 * DAY_MIN,
  emptyDataIsFailure: true,
  lockTtlMs: 15 * 60 * 1000,
  afterPublish: markActivated,
};

if (process.argv[1]?.endsWith('seed-oil-trade-series.mjs')) {
  runSeed('energy', 'oil-trade-series', OIL_TRADE_CANONICAL_KEY, () => fetchOilTradeSeries(), seedOptions).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
