#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// Cron: daily 08:00 UTC (0 8 * * *)
export const CLIMATE_OCEAN_ICE_KEY = 'climate:ocean-ice:v1';
export const CACHE_TTL = 86400; // 24h — daily satellite/climate indicator refresh

const NSIDC_DAILY_URL = 'https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v4.0.csv';
const NSIDC_CLIMATOLOGY_URL = 'https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_climatology_1981-2010_v4.0.csv';
const SEA_LEVEL_URL = 'https://sealevel.nasa.gov/overlay-global-mean-sea-level';
const OHC_700M_URL = 'https://www.ncei.noaa.gov/data/oceans/woa/DATA_ANALYSIS/3M_HEAT_CONTENT/DATA/basin/yearly/h22-w0-700m.dat';
const NOAA_GLOBAL_OCEAN_V6_INDEX_URL = 'https://www.ncei.noaa.gov/data/noaa-global-surface-temperature/v6/access/timeseries/';
const NOAA_GLOBAL_OCEAN_V51_URL = 'https://www.ncei.noaa.gov/data/noaa-global-surface-temperature/v5.1/access/timeseries/aravg.mon.ocean.90S.90N.v5.1.0.202312.asc';

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return NaN;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function toMonthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthStartMs(year, month) {
  return Date.UTC(year, month - 1, 1);
}

function dayOfYear(year, month, day) {
  return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / (24 * 60 * 60 * 1000));
}

function midYearMs(yearWithFraction) {
  const wholeYear = Math.floor(yearWithFraction);
  const fraction = yearWithFraction - wholeYear;
  const yearStart = Date.UTC(wholeYear, 0, 1);
  return Math.round(yearStart + fraction * 365.2425 * 24 * 60 * 60 * 1000);
}

async function fetchText(url, label, { timeoutMs = 20_000 } = {}) {
  const resp = await fetch(url, {
    headers: {
      Accept: 'text/plain,text/csv,application/json,text/html;q=0.9,*/*;q=0.8',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`${label} HTTP ${resp.status}`);
  return resp.text();
}

export function parseSeaIceDailyRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /^\d{4}\s*,\s*\d{1,2}\s*,\s*\d{1,2}\s*,/.test(line))
    .map((line) => line.split(',').map((part) => Number(part.trim())))
    .map((cols) => ({
      year: cols[0],
      month: cols[1],
      day: cols[2],
      extent: cols[3],
      area: cols[4],
      measuredAt: Date.UTC(cols[0], cols[1] - 1, cols[2]),
    }))
    .filter((row) => Number.isInteger(row.year)
      && Number.isInteger(row.month)
      && Number.isInteger(row.day)
      && Number.isFinite(row.extent)
      && row.extent > 0)
    .sort((a, b) => a.measuredAt - b.measuredAt);
}

export function parseSeaIceMonthlyRows(text, month) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /^\d/.test(line))
    .map((line) => {
      const cols = line.split(',').map((part) => part.trim());
      const primaryExtent = Number(cols[4]);
      const fallbackExtent = Number(cols.at(-2));
      return {
        year: Number(cols[0]),
        month,
        // NSIDC v4 monthly files are: year, mo, source_dataset, region, extent, area.
        extent: Number.isFinite(primaryExtent) && primaryExtent > 0 ? primaryExtent : fallbackExtent,
      };
    })
    .filter((row) => Number.isInteger(row.year) && Number.isFinite(row.extent) && row.extent > 0);
}

export function parseSeaIceClimatologyRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /^\d{3}\s*,/.test(line))
    .map((line) => line.split(',').map((part) => Number(part.trim())))
    .map((cols) => ({
      doy: cols[0],
      medianExtent: cols[5],
    }))
    .filter((row) => Number.isInteger(row.doy) && row.doy >= 1 && row.doy <= 366
      && Number.isFinite(row.medianExtent) && row.medianExtent > 0);
}

export function computeSeaIceMonthlyMedians(rowsByMonth) {
  const medians = new Map();
  for (const [month, rows] of rowsByMonth.entries()) {
    const baseline = rows
      .filter((row) => row.year >= 1981 && row.year <= 2010)
      .map((row) => row.extent)
      .filter((value) => Number.isFinite(value));
    if (baseline.length) {
      medians.set(month, round(median(baseline), 2));
    }
  }
  return medians;
}

function enumerateRecentMonths(year, month, count = 12) {
  const result = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(year, month - 1 - offset, 1));
    result.push({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      key: toMonthKey(date.getUTCFullYear(), date.getUTCMonth() + 1),
    });
  }
  return result;
}

export function buildIceTrend12m(dailyRows, monthlyMedians) {
  const latest = dailyRows.at(-1);
  if (!latest) return [];

  const latestByMonth = new Map();
  for (const row of dailyRows) latestByMonth.set(toMonthKey(row.year, row.month), row);

  return enumerateRecentMonths(latest.year, latest.month, 12)
    .map(({ key, month }) => {
      const row = latestByMonth.get(key);
      const medianExtent = monthlyMedians.get(month);
      if (!row || !Number.isFinite(medianExtent)) return null;
      return {
        month: key,
        extentMkm2: round(row.extent, 2),
        anomalyMkm2: round(row.extent - medianExtent, 2),
      };
    })
    .filter((row) => row != null);
}

export function buildIceTrend12mFromClimatology(dailyRows, dailyMedianByDoy) {
  const latest = dailyRows.at(-1);
  if (!latest) return [];

  const latestByMonth = new Map();
  for (const row of dailyRows) latestByMonth.set(toMonthKey(row.year, row.month), row);

  return enumerateRecentMonths(latest.year, latest.month, 12)
    .map(({ key }) => {
      const row = latestByMonth.get(key);
      if (!row) return null;
      const climatologyMedian = dailyMedianByDoy.get(dayOfYear(row.year, row.month, row.day));
      if (!Number.isFinite(climatologyMedian)) return null;
      return {
        month: key,
        extentMkm2: round(row.extent, 2),
        anomalyMkm2: round(row.extent - climatologyMedian, 2),
      };
    })
    .filter((row) => row != null);
}

function classifyArcticTrend(current, monthlyMedian, dailyRows) {
  const sameDayHistory = dailyRows.filter((row) => row.month === current.month && row.day === current.day);
  const minSameDayExtent = sameDayHistory.length
    ? Math.min(...sameDayHistory.map((row) => row.extent))
    : Number.POSITIVE_INFINITY;
  if (sameDayHistory.length >= 2 && current.extent <= minSameDayExtent + 1e-9) {
    return 'record_low';
  }
  if (!Number.isFinite(monthlyMedian)) return null;
  const anomaly = current.extent - monthlyMedian;
  if (anomaly <= -0.5) return 'below_average';
  if (anomaly >= 0.5) return 'above_average';
  return 'average';
}

async function fetchSeaIceSection() {
  const [dailyText, climatologyResult] = await Promise.all([
    fetchText(NSIDC_DAILY_URL, 'NSIDC daily sea ice', { timeoutMs: 90_000 }),
    fetchText(NSIDC_CLIMATOLOGY_URL, 'NSIDC sea ice climatology').then((text) => ({ text })).catch((err) => {
      console.warn(`[OceanIce] NSIDC sea ice climatology unavailable: ${err?.message || err}`);
      return null;
    }),
  ]);

  const dailyRows = parseSeaIceDailyRows(dailyText);
  if (!dailyRows.length) {
    throw new Error('NSIDC daily sea ice rows missing');
  }

  const latest = dailyRows.at(-1);
  const dailyMedianByDoy = new Map(
    climatologyResult
      ? parseSeaIceClimatologyRows(climatologyResult.text).map((row) => [row.doy, row.medianExtent])
      : [],
  );
  const currentMedian = dailyMedianByDoy.get(dayOfYear(latest.year, latest.month, latest.day));
  const trend12m = buildIceTrend12mFromClimatology(dailyRows, dailyMedianByDoy);

  const arcticTrend = classifyArcticTrend(latest, currentMedian, dailyRows);

  return {
    data: {
      arctic_extent_mkm2: round(latest.extent, 2),
      ...(Number.isFinite(currentMedian) ? { arctic_extent_anomaly_mkm2: round(latest.extent - currentMedian, 2) } : {}),
      ...(arcticTrend != null ? { arctic_trend: arcticTrend } : {}),
      ...(trend12m.length
        ? {
            ice_trend_12m: trend12m.map((point) => ({
              month: point.month,
              extent_mkm2: point.extentMkm2,
              anomaly_mkm2: point.anomalyMkm2,
            })),
          }
        : {}),
    },
    measuredAt: latest.measuredAt,
  };
}

export function parseSeaLevelOverlay(html) {
  const normalized = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const riseMatch = normalized.match(/RISE SINCE 1993\s+([0-9]+(?:\.[0-9]+)?)\s+millimeters/i)
    ?? normalized.match(/since 1993[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*(?:mm|millimeters)/i);
  const rateMatch = normalized.match(/current yearly rate of\s+[0-9.]+\s+inches\/year\s+\(([0-9.]+)\s+centimeters\/year\)/i)
    ?? normalized.match(/current.*?([0-9]+(?:\.[0-9]+)?)\s+centimeters\/year/i);
  return {
    seaLevelMmAbove1993: riseMatch ? round(Number(riseMatch[1]), 1) : NaN,
    seaLevelAnnualRiseMm: rateMatch ? round(Number(rateMatch[1]) * 10, 1) : NaN,
  };
}

async function fetchSeaLevelSection() {
  const html = await fetchText(SEA_LEVEL_URL, 'NASA global mean sea level');
  const parsed = parseSeaLevelOverlay(html);
  if (!Number.isFinite(parsed.seaLevelMmAbove1993) && !Number.isFinite(parsed.seaLevelAnnualRiseMm)) {
    throw new Error('Sea level page missing rise/rate values');
  }
  return {
    data: {
      ...(Number.isFinite(parsed.seaLevelMmAbove1993) ? { sea_level_mm_above_1993: parsed.seaLevelMmAbove1993 } : {}),
      ...(Number.isFinite(parsed.seaLevelAnnualRiseMm) ? { sea_level_annual_rise_mm: parsed.seaLevelAnnualRiseMm } : {}),
    },
  };
}

export function parseOhcYearlyRows(text) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^YEAR\b/i.test(line))
    .map((line) => line.split(/\s+/).map((part) => Number(part)))
    .map((cols) => ({
      yearMid: cols[0],
      world: cols[1],
    }))
    .filter((row) => Number.isFinite(row.yearMid) && Number.isFinite(row.world));
  if (rows.length) return rows;

  const numbers = Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g), (match) => Number(match[0]));
  const fallback = [];
  for (let index = 0; index + 6 < numbers.length; index += 7) {
    fallback.push({
      yearMid: numbers[index],
      world: numbers[index + 1],
    });
  }
  return fallback.filter((row) => Number.isFinite(row.yearMid) && Number.isFinite(row.world));
}

async function fetchOhcSection() {
  const text = await fetchText(OHC_700M_URL, 'NOAA ocean heat content');
  const rows = parseOhcYearlyRows(text);
  const latest = rows.at(-1);
  if (!latest) throw new Error('OHC yearly rows missing');
  return {
    data: {
      ohc_0_700m_zj: round(latest.world * 10, 2),
    },
    measuredAt: midYearMs(latest.yearMid),
  };
}

export function parseOceanTemperatureRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /^\d{4}\s+\d{1,2}\s+[-+]?\d/.test(line))
    .map((line) => line.split(/\s+/))
    .map((cols) => ({
      year: Number(cols[0]),
      month: Number(cols[1]),
      anomaly: Number(cols[2]),
    }))
    .filter((row) => Number.isInteger(row.year)
      && Number.isInteger(row.month)
      && row.month >= 1
      && row.month <= 12
      && Number.isFinite(row.anomaly))
    .sort((a, b) => (a.year - b.year) || (a.month - b.month));
}

export function computeOceanBaselineOffsets(rows, startYear = 1991, endYear = 2020) {
  const totals = new Map();
  const counts = new Map();

  for (const row of rows) {
    if (row.year < startYear || row.year > endYear) continue;
    totals.set(row.month, (totals.get(row.month) ?? 0) + row.anomaly);
    counts.set(row.month, (counts.get(row.month) ?? 0) + 1);
  }

  const offsets = new Map();
  for (let month = 1; month <= 12; month++) {
    const total = totals.get(month);
    const count = counts.get(month);
    if (!Number.isFinite(total) || !count) continue;
    offsets.set(month, round(total / count, 3));
  }
  return offsets;
}

export function extractLatestOceanSeriesPath(indexHtml) {
  const matches = Array.from(
    indexHtml.matchAll(/href="(aravg\.mon\.ocean\.90S\.90N\.(v6\.[0-9.]+?)\.(\d{6})\.asc)"/g),
    (match) => ({
      path: match[1],
      version: match[2],
      period: Number(match[3]),
    }),
  );
  if (!matches.length) return null;

  matches.sort((left, right) => {
    if (left.period !== right.period) return left.period - right.period;
    return left.version.localeCompare(right.version, undefined, { numeric: true });
  });

  return matches.at(-1)?.path ?? null;
}

async function fetchSstSection() {
  const [indexHtml, baselineText] = await Promise.all([
    fetchText(NOAA_GLOBAL_OCEAN_V6_INDEX_URL, 'NOAA global ocean temperature index'),
    fetchText(NOAA_GLOBAL_OCEAN_V51_URL, 'NOAA global ocean temperature baseline'),
  ]);

  const latestPath = extractLatestOceanSeriesPath(indexHtml);
  if (!latestPath) {
    throw new Error('NOAA global ocean temperature index missing latest series path');
  }

  const currentText = await fetchText(new URL(latestPath, NOAA_GLOBAL_OCEAN_V6_INDEX_URL).toString(), 'NOAA global ocean temperature series');
  const currentRows = parseOceanTemperatureRows(currentText);
  const baselineRows = parseOceanTemperatureRows(baselineText);
  const latest = currentRows.at(-1);
  if (!latest) throw new Error('NOAA global ocean temperature rows missing');

  const offsets = computeOceanBaselineOffsets(baselineRows);
  const baselineOffset = offsets.get(latest.month);
  if (!Number.isFinite(baselineOffset)) {
    throw new Error(`Missing NOAA ocean baseline offset for month ${latest.month}`);
  }

  // NOAA v6 ocean-only anomalies are relative to 1991-2020. Convert them back
  // to the requested 1971-2000 reference period using the NOAA v5.1 ocean-only
  // 1991-2020 monthly mean anomalies, which are already expressed against
  // 1971-2000. This keeps the output on the requested baseline while staying
  // on current NOAA data for the latest month.
  return {
    data: {
      sst_anomaly_c: round(latest.anomaly + baselineOffset, 2),
    },
    measuredAt: monthStartMs(latest.year, latest.month),
  };
}

const SOURCE_FIELD_GROUPS = [
  ['arctic_extent_mkm2', 'arctic_extent_anomaly_mkm2', 'arctic_trend', 'ice_trend_12m'],
  ['sea_level_mm_above_1993', 'sea_level_annual_rise_mm'],
  ['ohc_0_700m_zj'],
  ['sst_anomaly_c'],
];

export function buildOceanIcePayload(settled, priorCache) {
  const payload = {};
  const measuredAts = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result?.data) {
      Object.assign(payload, result.data);
      if (Number.isFinite(result.measuredAt) && result.measuredAt > 0) {
        measuredAts.push(result.measuredAt);
      }
    } else if (priorCache && typeof priorCache === 'object' && i < SOURCE_FIELD_GROUPS.length) {
      for (const field of SOURCE_FIELD_GROUPS[i]) {
        if (priorCache[field] != null) payload[field] = priorCache[field];
      }
    }
  }

  if (!Object.keys(payload).length) {
    throw new Error('All ocean/ice upstreams failed');
  }

  if (measuredAts.length) payload.measured_at = Math.max(...measuredAts);
  return payload;
}

async function readPriorCache() {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(CLIMATE_OCEAN_ICE_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

export async function fetchOceanIceData() {
  const [allSettled, prior] = await Promise.all([
    Promise.allSettled([
      fetchSeaIceSection(),
      fetchSeaLevelSection(),
      fetchOhcSection(),
      fetchSstSection(),
    ]),
    readPriorCache(),
  ]);

  const resolved = allSettled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    console.warn(`[OceanIce] Source ${i} failed: ${result.reason?.message || result.reason}`);
    return null;
  });

  const hadFailures = resolved.some((r) => r == null);
  if (hadFailures && prior) {
    console.log('[OceanIce] Merging failed source groups with prior cache');
  }

  return buildOceanIcePayload(resolved, hadFailures ? prior : undefined);
}

export function countIndicators(data) {
  const payload = data ?? {};
  return [
    payload.arctic_extent_mkm2,
    payload.arctic_extent_anomaly_mkm2,
    payload.sea_level_mm_above_1993,
    payload.sea_level_annual_rise_mm,
    payload.ohc_0_700m_zj,
    payload.sst_anomaly_c,
    Array.isArray(payload.ice_trend_12m) && payload.ice_trend_12m.length ? 1 : NaN,
  ].filter((value) => Number.isFinite(value)).length;
}

function validate(data) {
  return countIndicators(data) > 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  runSeed('climate', 'ocean-ice', CLIMATE_OCEAN_ICE_KEY, fetchOceanIceData, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    recordCount: countIndicators,
    sourceVersion: 'nsidc-sea-ice_v4-climatology-noaa-ohc-nasa-gmsl-noaa-global-ocean-v6-v51-baseline-v3',
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
