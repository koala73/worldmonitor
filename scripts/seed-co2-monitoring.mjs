#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CO2_MONITORING_KEY = 'climate:co2-monitoring:v1';
const CACHE_TTL = 259200; // 72h = 3x daily interval (gold standard)
const PRE_INDUSTRIAL_BASELINE = 280.0;
const STATION = 'Mauna Loa, Hawaii';

const NOAA_URLS = {
  dailyCo2: 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.txt',
  monthlyCo2: 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt',
  annualCo2Global: 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt',
  methaneMonthly: 'https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_mm_gl.txt',
  nitrousMonthly: 'https://gml.noaa.gov/webdata/ccgg/trends/n2o/n2o_mm_gl.txt',
};

function toEpochMs(year, month, day = 1) {
  return Date.UTC(year, month - 1, day);
}

function isValidMeasurement(value) {
  return Number.isFinite(value) && value > 0;
}

function formatMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseNoaaRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/));
}

export function parseCo2DailyRows(text) {
  return parseNoaaRows(text)
    .map((cols) => ({
      year: Number(cols[0]),
      month: Number(cols[1]),
      day: Number(cols[2]),
      average: Number(cols[4]),
    }))
    .filter((row) => Number.isInteger(row.year) && Number.isInteger(row.month) && Number.isInteger(row.day) && isValidMeasurement(row.average))
    .sort((a, b) => toEpochMs(a.year, a.month, a.day) - toEpochMs(b.year, b.month, b.day));
}

export function parseCo2MonthlyRows(text) {
  return parseNoaaRows(text)
    .map((cols) => ({
      year: Number(cols[0]),
      month: Number(cols[1]),
      average: Number(cols[3]),
    }))
    .filter((row) => Number.isInteger(row.year) && Number.isInteger(row.month) && isValidMeasurement(row.average))
    .sort((a, b) => toEpochMs(a.year, a.month) - toEpochMs(b.year, b.month));
}

export function parseAnnualCo2Rows(text) {
  return parseNoaaRows(text)
    .map((cols) => ({
      year: Number(cols[0]),
      mean: Number(cols[1]),
    }))
    .filter((row) => Number.isInteger(row.year) && isValidMeasurement(row.mean))
    .sort((a, b) => a.year - b.year);
}

export function parseGlobalMonthlyPpbRows(text) {
  return parseNoaaRows(text)
    .map((cols) => ({
      year: Number(cols[0]),
      month: Number(cols[1]),
      average: Number(cols[3]),
    }))
    .filter((row) => Number.isInteger(row.year) && Number.isInteger(row.month) && isValidMeasurement(row.average))
    .sort((a, b) => toEpochMs(a.year, a.month) - toEpochMs(b.year, b.month));
}

function findClosestPriorYearValue(rows, latest) {
  const exact = rows.find((row) => row.year === latest.year - 1 && row.month === latest.month && row.day === latest.day);
  if (exact) return exact.average;

  const targetTime = toEpochMs(latest.year - 1, latest.month, latest.day);
  const candidates = rows.filter((row) => row.year === latest.year - 1);
  if (!candidates.length) return 0;

  const closest = candidates.reduce((best, row) => {
    if (!best) return row;
    const bestDelta = Math.abs(toEpochMs(best.year, best.month, best.day) - targetTime);
    const rowDelta = Math.abs(toEpochMs(row.year, row.month, row.day) - targetTime);
    if (rowDelta < bestDelta) return row;
    if (rowDelta === bestDelta && toEpochMs(row.year, row.month, row.day) < toEpochMs(best.year, best.month, best.day)) {
      return row;
    }
    return best;
  }, null);

  return closest?.average ?? 0;
}

export function buildTrend12m(monthlyRows) {
  const byMonth = new Map(monthlyRows.map((row) => [formatMonth(row.year, row.month), row.average]));
  return monthlyRows.slice(-12).map((row) => {
    const prior = byMonth.get(formatMonth(row.year - 1, row.month));
    return {
      month: formatMonth(row.year, row.month),
      ppm: row.average,
      anomaly: prior ? Math.round((row.average - prior) * 100) / 100 : 0,
    };
  });
}

function findMonthlyAverageForLatestDaily(monthlyRows, latestDaily) {
  const exact = monthlyRows.findLast((row) => row.year === latestDaily.year && row.month === latestDaily.month);
  if (exact) return exact.average;

  const targetTime = toEpochMs(latestDaily.year, latestDaily.month);
  const prior = monthlyRows.filter((row) => toEpochMs(row.year, row.month) <= targetTime).at(-1);
  return prior?.average ?? 0;
}

export function buildCo2MonitoringPayload({ dailyRows, monthlyRows, annualRows, methaneRows, nitrousRows }) {
  const latestDaily = dailyRows.at(-1);
  const monthlyAverage = latestDaily ? findMonthlyAverageForLatestDaily(monthlyRows, latestDaily) : 0;
  const latestMethane = methaneRows.at(-1);
  const latestNitrous = nitrousRows.at(-1);
  const latestAnnual = annualRows.at(-1);
  const previousAnnual = annualRows.at(-2);

  if (!latestDaily || !latestMethane || !latestNitrous || !latestAnnual || !previousAnnual || monthlyRows.length < 12 || monthlyAverage <= 0) {
    throw new Error('Insufficient NOAA GML data to build CO2 monitoring payload');
  }

  return {
    monitoring: {
      currentPpm: latestDaily.average,
      yearAgoPpm: findClosestPriorYearValue(dailyRows, latestDaily),
      annualGrowthRate: Math.round((latestAnnual.mean - previousAnnual.mean) * 100) / 100,
      preIndustrialBaseline: PRE_INDUSTRIAL_BASELINE,
      monthlyAverage,
      trend12m: buildTrend12m(monthlyRows),
      methanePpb: latestMethane.average,
      nitrousOxidePpb: latestNitrous.average,
      measuredAt: String(toEpochMs(latestDaily.year, latestDaily.month, latestDaily.day)),
      station: STATION,
    },
  };
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/plain' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`NOAA GML ${resp.status} for ${url}`);
  return resp.text();
}

export async function fetchCo2Monitoring() {
  const [dailyText, monthlyText, annualText, methaneText, nitrousText] = await Promise.all([
    fetchText(NOAA_URLS.dailyCo2),
    fetchText(NOAA_URLS.monthlyCo2),
    fetchText(NOAA_URLS.annualCo2Global),
    fetchText(NOAA_URLS.methaneMonthly),
    fetchText(NOAA_URLS.nitrousMonthly),
  ]);

  return buildCo2MonitoringPayload({
    dailyRows: parseCo2DailyRows(dailyText),
    monthlyRows: parseCo2MonthlyRows(monthlyText),
    annualRows: parseAnnualCo2Rows(annualText),
    methaneRows: parseGlobalMonthlyPpbRows(methaneText),
    nitrousRows: parseGlobalMonthlyPpbRows(nitrousText),
  });
}

function validate(data) {
  const annualGrowthRate = data?.monitoring?.annualGrowthRate;
  return data?.monitoring?.currentPpm > 0
    && data?.monitoring?.yearAgoPpm > 0
    && Number.isFinite(annualGrowthRate)
    && data?.monitoring?.monthlyAverage > 0
    && data?.monitoring?.methanePpb > 0
    && data?.monitoring?.nitrousOxidePpb > 0
    && Array.isArray(data?.monitoring?.trend12m)
    && data.monitoring.trend12m.length === 12;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  runSeed('climate', 'co2-monitoring', CO2_MONITORING_KEY, fetchCo2Monitoring, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    recordCount: (data) => data?.monitoring?.trend12m?.length ?? 0,
    sourceVersion: 'noaa-gml-co2-ch4-n2o-v1',
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
