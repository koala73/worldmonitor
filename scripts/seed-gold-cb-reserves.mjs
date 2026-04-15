#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, withRetry } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const CB_KEY = 'market:gold-cb-reserves:v1';
const CB_TTL = 2_592_000; // 30 days — data is monthly, TTL long to survive missed runs

// IMF IRFCL (International Reserves and Foreign Currency Liquidity) dataflow
// via SDMX 3.0 — public, no auth. The original PR (#3038) targeted
// IMF.STA/IFS which returns HTTP 404 — IFS isn't an exposed dataflow on
// api.imf.org; gold-reserves data lives under IMF.STA/IRFCL.
//
// Dimensions: COUNTRY.INDICATOR.SECTOR.FREQUENCY (4, not 3). Key pattern
// requires explicit wildcards `*.<indicator>.*.M`; empty segments return
// HTTP 400 / zero series. Verified against live API: *._FTO.*.M returns
// 111 series at ~798 KB.
//
// Candidate indicators in order of preference. _FTO (fine troy ounces)
// values convert directly to tonnes — USD suffix is last-resort fallback
// because price moves contaminate delta calculations.
const IMF_SDMX_BASE = 'https://api.imf.org/external/sdmx/3.0';
const IRFCL_DATAFLOW = `${IMF_SDMX_BASE}/data/dataflow/IMF.STA/IRFCL/+`;
const CANDIDATE_INDICATORS = [
  'IRFCLDT1_IRFCL56_FTO',   // Reserve assets: gold, fine troy ounces — PREFERRED
  'IRFCLDT1_IRFCL56GB_FTO', // Gold bullion only, troy ounces
  'IRFCLDT1_IRFCL56UG_FTO', // Unallocated gold, troy ounces
  'IRFCLDT1_IRFCL56_USD',   // USD fallback (last resort; price-contaminated deltas)
];

const TROY_OZ_PER_TONNE = 32_150.7;

const ISO3_NAMES = {
  USA: 'United States', DEU: 'Germany', ITA: 'Italy', FRA: 'France',
  RUS: 'Russia', CHN: 'China', CHE: 'Switzerland', JPN: 'Japan',
  IND: 'India', TUR: 'Turkey', POL: 'Poland', NLD: 'Netherlands',
  SGP: 'Singapore', UZB: 'Uzbekistan', KAZ: 'Kazakhstan', THA: 'Thailand',
  PRT: 'Portugal', GBR: 'United Kingdom', ESP: 'Spain', SAU: 'Saudi Arabia',
  AUT: 'Austria', LBN: 'Lebanon', BEL: 'Belgium', PHL: 'Philippines',
  VEN: 'Venezuela', DZA: 'Algeria', LBY: 'Libya',
  IRQ: 'Iraq', BRA: 'Brazil', DNK: 'Denmark', PAK: 'Pakistan',
  SWE: 'Sweden', FIN: 'Finland', GRC: 'Greece', ROU: 'Romania',
  SRB: 'Serbia', BGR: 'Bulgaria', HUN: 'Hungary', CZE: 'Czech Republic',
  KOR: 'South Korea', IDN: 'Indonesia', MEX: 'Mexico', ZAF: 'South Africa',
  PER: 'Peru', ARG: 'Argentina', COL: 'Colombia', CHL: 'Chile',
  EGY: 'Egypt', MYS: 'Malaysia', AUS: 'Australia', CAN: 'Canada',
  NOR: 'Norway', UKR: 'Ukraine', ECB: 'European Central Bank',
};

// Non-sovereign aggregates we don't want in the top-holders list
const AGGREGATE_CODES = new Set([
  'EU', 'WLD', 'AFE', 'AFW', 'AFR', 'EUU', 'EMU', 'OED', 'LIC', 'LMC',
  'UMC', 'HIC', 'SSA', 'LAC', 'MEA', 'SAS', 'EAP', 'ECA', 'ADVEC', 'EMDE',
]);

async function fetchIrfclMonthlySeries(indicator) {
  // IRFCL dimensions: COUNTRY.INDICATOR.SECTOR.FREQUENCY. We wildcard COUNTRY
  // and SECTOR; FREQUENCY=M for monthly.
  const url = `${IRFCL_DATAFLOW}/*.${indicator}.*.M?dimensionAtObservation=TIME_PERIOD&attributes=dsd&measures=all`;

  const json = await withRetry(async () => {
    const r = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`IMF IRFCL ${indicator}: HTTP ${r.status}`);
    return r.json();
  }, 2, 3000);

  const struct = json?.data?.structures?.[0];
  const ds = json?.data?.dataSets?.[0];
  if (!struct || !ds?.series) return {};

  // Dimension layout is vendor-specific. Find COUNTRY and TIME_PERIOD positions
  // rather than assuming them.
  const seriesDims = struct.dimensions?.series ?? [];
  const countryDim = seriesDims.find(d => d.id === 'COUNTRY' || d.id === 'REF_AREA');
  const countryDimPos = seriesDims.indexOf(countryDim);
  const timeDim = struct.dimensions?.observation?.find(d => d.id === 'TIME_PERIOD');
  if (!countryDim || countryDimPos === -1 || !timeDim) return {};

  const countryValues = countryDim.values.map(v => ({ id: v.id, name: v.name || v.id }));
  const timeValues = timeDim.values.map(v => v.value || v.id);

  const result = {};
  for (const [seriesKey, seriesData] of Object.entries(ds.series)) {
    const keyParts = seriesKey.split(':');
    const countryIdx = parseInt(keyParts[countryDimPos], 10);
    const country = countryValues[countryIdx];
    if (!country?.id) continue;

    const byMonth = {};
    for (const [obsKey, obsVal] of Object.entries(seriesData.observations || {})) {
      const period = timeValues[parseInt(obsKey, 10)]; // e.g. "2026-01"
      if (!period) continue;
      const v = obsVal?.[0];
      if (v != null && Number.isFinite(parseFloat(v))) byMonth[period] = parseFloat(v);
    }
    if (Object.keys(byMonth).length > 0) {
      result[country.id] = { name: country.name, byMonth };
    }
  }
  return result;
}

async function fetchFirstAvailableIndicator() {
  for (const indicator of CANDIDATE_INDICATORS) {
    try {
      const data = await fetchIrfclMonthlySeries(indicator);
      const countries = Object.keys(data).length;
      if (countries >= 20) {
        console.log(`  [IMF IRFCL] ${indicator}: ${countries} countries`);
        return { indicator, data };
      }
      console.warn(`  [IMF IRFCL] ${indicator}: only ${countries} countries — trying next`);
    } catch (e) {
      console.warn(`  [IMF IRFCL] ${indicator} failed: ${e.message} — trying next`);
    }
  }
  return null;
}

export function latestMonth(byMonth) {
  const months = Object.keys(byMonth).sort();
  return months[months.length - 1];
}

export function monthOffset(period, deltaMonths) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function buildReservesPayload(raw, indicator, goldUsdByCountry = {}, totalReservesUsdByCountry = {}) {
  const asOfMonth = (() => {
    const all = new Set();
    for (const c of Object.values(raw)) {
      for (const m of Object.keys(c.byMonth)) all.add(m);
    }
    const sorted = [...all].sort();
    return sorted[sorted.length - 1] ?? '';
  })();
  if (!asOfMonth) return null;

  const priorMonth = monthOffset(asOfMonth, -12);
  // IRFCL `_FTO` suffix = Fine Troy Ounces (convertible to tonnes). `_USD`
  // values are price-contaminated, so we flag non-ounces and skip deltas.
  // Backward-compat: legacy `_OZT`/`OUNCE` substrings (from pre-merge PR) also
  // satisfy the check.
  const valueIsOunces = /_FTO|_OZT|OUNCE/i.test(indicator);

  const toTonnes = (v) => valueIsOunces ? v / TROY_OZ_PER_TONNE : null;

  // Find latest month within a country's byMonth map at or before asOfMonth.
  // IRFCL reporting lags vary per country — use the most recent available
  // value within the last 3 months to compute pctOfReserves so we don't drop
  // countries that report one month late.
  const latestAtOrBefore = (byMonth, cutoff) => {
    if (!byMonth) return null;
    for (let back = 0; back < 3; back++) {
      const m = monthOffset(cutoff, -back);
      const v = byMonth[m];
      if (v != null && Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };

  const holders = [];
  for (const [iso3, rec] of Object.entries(raw)) {
    if (AGGREGATE_CODES.has(iso3)) continue;
    const current = rec.byMonth[asOfMonth];
    const prior = rec.byMonth[priorMonth];
    if (current == null || !Number.isFinite(current) || current <= 0) continue;

    let tonnes;
    let deltaTonnes12m = 0;
    if (valueIsOunces) {
      tonnes = toTonnes(current);
      if (prior != null && Number.isFinite(prior) && prior > 0) {
        deltaTonnes12m = +(toTonnes(current) - toTonnes(prior)).toFixed(2);
      }
    } else {
      // USD series — expose raw value but flag that delta needs gold-price
      // adjustment, which we don't do here. Set deltaTonnes12m to 0 so UI
      // shows USD only; top-buyers/sellers list falls back to unreliable.
      tonnes = 0; // mark "unknown in tonnes"
    }

    // pctOfReserves = gold's share of total official reserve assets (both in
    // USD). Requires the two parallel indicator series — falls back to 0 when
    // either side is missing for this country (small reporters often publish
    // only the core ounces series).
    const goldUsd = latestAtOrBefore(goldUsdByCountry[iso3]?.byMonth, asOfMonth);
    const totalUsd = latestAtOrBefore(totalReservesUsdByCountry[iso3]?.byMonth, asOfMonth);
    const pctOfReserves = (goldUsd != null && totalUsd != null && totalUsd > 0)
      ? +((goldUsd / totalUsd) * 100).toFixed(2)
      : 0;

    holders.push({
      iso3,
      name: ISO3_NAMES[iso3] || rec.name || iso3,
      tonnes: Number.isFinite(tonnes) ? +tonnes.toFixed(2) : 0,
      pctOfReserves,
      valueUsd: valueIsOunces ? (goldUsd ?? 0) : +current.toFixed(0),
      deltaTonnes12m,
    });
  }

  if (!holders.length) return null;

  // Sort top holders by tonnes if we have them, else by USD value
  holders.sort((a, b) => (b.tonnes - a.tonnes) || (b.valueUsd - a.valueUsd));
  const topHolders = holders.slice(0, 20).map(h => ({
    iso3: h.iso3, name: h.name, tonnes: h.tonnes, pctOfReserves: h.pctOfReserves,
  }));

  const withDeltas = holders.filter(h => h.deltaTonnes12m !== 0);
  withDeltas.sort((a, b) => b.deltaTonnes12m - a.deltaTonnes12m);
  const topBuyers12m = withDeltas.filter(h => h.deltaTonnes12m > 0).slice(0, 10)
    .map(h => ({ iso3: h.iso3, name: h.name, deltaTonnes12m: h.deltaTonnes12m }));
  const topSellers12m = withDeltas.filter(h => h.deltaTonnes12m < 0).slice(-10).reverse()
    .map(h => ({ iso3: h.iso3, name: h.name, deltaTonnes12m: h.deltaTonnes12m }));

  const totalTonnes = +holders.reduce((s, h) => s + (h.tonnes || 0), 0).toFixed(2);

  return {
    updatedAt: new Date().toISOString(),
    indicator,
    valueIsOunces,
    asOfMonth,
    totalTonnes,
    topHolders,
    topBuyers12m,
    topSellers12m,
  };
}

// Indicators used to compute pctOfReserves = gold_usd / total_reserves_usd.
// Both are IRFCLDT1 USD-denominated; fetched in parallel with the primary
// tonnage indicator so the share is computed from matched-month values.
const GOLD_USD_INDICATOR = 'IRFCLDT1_IRFCL56_USD';   // Official reserve assets, gold (USD market value)
const TOTAL_RESERVES_USD = 'IRFCLDT1_IRFCL65_USD';   // Official reserve assets (total, USD market value)

async function fetchCbReserves() {
  // Fetch the tonnage indicator + the two USD series for pctOfReserves in
  // parallel. The pct series are optional — on failure we still publish the
  // tonnage payload with pctOfReserves=0 rather than blocking the seed.
  const [primary, goldUsdRes, totalUsdRes] = await Promise.allSettled([
    fetchFirstAvailableIndicator(),
    fetchIrfclMonthlySeries(GOLD_USD_INDICATOR),
    fetchIrfclMonthlySeries(TOTAL_RESERVES_USD),
  ]);

  const res = primary.status === 'fulfilled' ? primary.value : null;
  if (!res) throw new Error('All IMF IRFCL candidate tonnage indicators returned empty / failed');

  const goldUsd = goldUsdRes.status === 'fulfilled' ? goldUsdRes.value : {};
  const totalUsd = totalUsdRes.status === 'fulfilled' ? totalUsdRes.value : {};
  const pctCoverage = Object.keys(goldUsd).length && Object.keys(totalUsd).length
    ? Math.min(Object.keys(goldUsd).length, Object.keys(totalUsd).length)
    : 0;
  console.log(`  [IMF IRFCL] pctOfReserves denominator coverage: ${pctCoverage} countries (gold_usd=${Object.keys(goldUsd).length}, total_usd=${Object.keys(totalUsd).length})`);

  const payload = buildReservesPayload(res.data, res.indicator, goldUsd, totalUsd);
  if (!payload) throw new Error(`buildReservesPayload returned null (indicator=${res.indicator})`);
  return payload;
}

export function declareRecords(data) {
  return Array.isArray(data?.topHolders) ? data.topHolders.length : 0;
}

if (process.argv[1]?.endsWith('seed-gold-cb-reserves.mjs')) {
  runSeed('market', 'gold-cb-reserves', CB_KEY, fetchCbReserves, {
    ttlSeconds: CB_TTL,
    validateFn: data => Array.isArray(data?.topHolders) && data.topHolders.length >= 10,
    recordCount: data => data?.topHolders?.length ?? 0,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 44640,
    sourceVersion: 'imf-ifs-v1',
  }).catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}
