/**
 * Shared Eurostat JSON-stat parser + country list for per-dataset EU overlay seeders.
 * Used by seed-eurostat-house-prices, seed-eurostat-gov-debt-q, seed-eurostat-industrial-production.
 */

import { CHROME_UA } from './_seed-utils.mjs';

export const EUROSTAT_BASE =
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

/**
 * All 27 EU members + EA20 (Euro Area) + EU27_2020 aggregates.
 * Eurostat geo quirks:
 *  - Greece is 'EL' (not ISO 'GR')
 *  - Euro Area is 'EA20' (post-2023)
 *  - EU aggregate is 'EU27_2020'
 */
export const EU_GEOS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'EL', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'EA20', 'EU27_2020',
];

/**
 * Parse Eurostat JSON-stat response for a specific geo code.
 * Returns a time series (sorted ascending by period) plus latest/prior.
 *
 * @param {object} data — JSON-stat response
 * @param {string} geoCode — Eurostat geo code (e.g. 'DE', 'EL', 'EA20')
 * @returns {{ value:number, priorValue:number|null, date:string, series:Array<{date:string,value:number}> }|null}
 */
export function parseEurostatSeries(data, geoCode) {
  try {
    const dims = data?.dimension;
    const values = data?.value;
    if (!dims || !values) return null;

    const geoDim = dims.geo;
    if (!geoDim) return null;

    const geoIndex = geoDim.category?.index;
    if (!geoIndex || geoIndex[geoCode] === undefined) return null;
    const geoPos = geoIndex[geoCode];

    const timeIndexObj = dims.time?.category?.index;
    if (!timeIndexObj) return null;
    // Map time-position -> time-label (e.g. 0 -> '2020-Q1')
    const timeLabels = {};
    for (const [label, pos] of Object.entries(timeIndexObj)) {
      timeLabels[pos] = label;
    }

    const dimOrder = data.id || [];
    const dimSizes = data.size || [];
    const strides = {};
    let stride = 1;
    for (let i = dimOrder.length - 1; i >= 0; i--) {
      strides[dimOrder[i]] = stride;
      stride *= dimSizes[i];
    }

    const series = [];
    for (const key of Object.keys(values)) {
      const idx = Number(key);
      const rawVal = values[key];
      if (rawVal === null || rawVal === undefined) continue;

      let remaining = idx;
      const coords = {};
      for (const dim of dimOrder) {
        const s = strides[dim];
        const dimSize = dimSizes[dimOrder.indexOf(dim)];
        coords[dim] = Math.floor(remaining / s) % dimSize;
        remaining = remaining % s;
      }

      if (coords.geo !== geoPos) continue;
      const label = timeLabels[coords.time];
      if (!label) continue;
      series.push({
        date: label,
        value: typeof rawVal === 'number' ? Math.round(rawVal * 100) / 100 : null,
      });
    }

    if (series.length === 0) return null;

    // Sort ascending by period label. Eurostat labels are lexicographically
    // orderable for annual (YYYY), quarterly (YYYY-QN), and monthly (YYYY-MM).
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const latest = series[series.length - 1];
    const prior = series.length > 1 ? series[series.length - 2] : null;

    return {
      value: latest.value,
      priorValue: prior ? prior.value : null,
      date: latest.date,
      series,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a single Eurostat dataset for one geo and parse to series.
 * @param {{id:string, params:object, unit:string, label:string}} ds
 * @param {string} geoCode
 * @returns {Promise<{value:number, priorValue:number|null, date:string, series:Array, unit:string}|null>}
 */
export async function fetchEurostatCountry(ds, geoCode) {
  const params = new URLSearchParams({
    format: 'JSON',
    lang: 'EN',
    geo: geoCode,
    ...ds.params,
  });
  const url = `${EUROSTAT_BASE}/${ds.id}?${params}`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      console.warn(`  Eurostat ${geoCode}/${ds.id}: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const parsed = parseEurostatSeries(data, geoCode);
    if (!parsed || parsed.value === null) return null;
    return { ...parsed, unit: ds.unit };
  } catch (err) {
    console.warn(`  Eurostat ${geoCode}/${ds.id}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch all EU geos for a single dataset in small batches.
 * @param {{id:string, params:object, unit:string, label:string, sparklineLength?:number}} ds
 * @returns {Promise<{countries:object, seededAt:number}>}
 */
export async function fetchEurostatAllGeos(ds) {
  const BATCH_SIZE = 4;
  const results = {};
  let ok = 0;

  for (let i = 0; i < EU_GEOS.length; i += BATCH_SIZE) {
    const batch = EU_GEOS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((g) => fetchEurostatCountry(ds, g).then((v) => ({ g, v })))
    );
    for (const r of batchResults) {
      if (r.status !== 'fulfilled' || !r.value.v) continue;
      const { g, v } = r.value;
      // Trim series to sparkline length if configured.
      const sparkLen = ds.sparklineLength || v.series.length;
      results[g] = {
        value: v.value,
        priorValue: v.priorValue,
        hasPrior: v.priorValue !== null,
        date: v.date,
        unit: v.unit,
        series: v.series.slice(-sparkLen),
      };
      ok++;
    }
  }

  console.log(`  Eurostat ${ds.id}: ${ok}/${EU_GEOS.length} geos with data`);
  return { countries: results, seededAt: Date.now(), dataset: ds.id, label: ds.label };
}

/**
 * Standard validator — at least N countries must have data.
 */
export function makeValidator(minCountries = 10) {
  return (data) => {
    const count = Object.keys(data?.countries || {}).length;
    if (count < minCountries) {
      console.warn(
        `  Validation failed: only ${count} geos with data (need ≥${minCountries})`
      );
      return false;
    }
    return true;
  };
}
