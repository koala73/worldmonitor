#!/usr/bin/env node

// Publishes the Sentinel-5P TROPOMI tropospheric NO2 activity composite for
// four Chinese industrial clusters (#9722), read by the China activity nowcast
// as its atmosphere family. The region registry, the method, and the payload
// validator live in scripts/shared/china-no2-activity.mjs, which the nowcast
// reader imports too.
//
// Each run asks the CDSE Sentinel Hub Statistical API for daily OFFL NO2 means
// over each region: the current window ending windowEndLagDays before today
// (UTC) and the same month-day span in each of the baselineYears before it.
// 4 regions x (1 current + 3 baseline) = 16 requests, about 18 processing units.
// A region whose requests fail after retries publishes as request_failed; a run
// where every region fails (or the token cannot be fetched) publishes nothing,
// so runSeed keeps last-good and exits 75. The first successful publish SETs
// seed-activated:economic:china-no2-activity, which ends /api/health's
// pre-provisioning softening for chinaNo2Activity.
//
// Railway service config (set up manually via the Railway dashboard or `railway service`):
//   - Service name: seed-china-no2-activity
//   - Root directory: scripts
//   - Start command: node seed-china-no2-activity.mjs
//   - Cron: 20 6 * * *
//   - Variables: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, CDSE_CLIENT_ID, CDSE_CLIENT_SECRET
//
// Dry run (live CDSE requests, prints the windows and the composite, touches no Redis):
//   node scripts/seed-china-no2-activity.mjs --dry-run

import { isMainModule } from './lib/main-module.mjs';
import {
  allSettledWithConcurrency,
  loadEnvFile,
  markPreservableFetchFailure,
  parseRetryAfterMs,
  runSeed,
  withRetry,
} from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  CHINA_NO2_ACTIVITY_ACTIVATION_KEY,
  CHINA_NO2_ACTIVITY_KEY,
  CHINA_NO2_ACTIVITY_METHOD,
  CHINA_NO2_ACTIVITY_METHOD_VERSION,
  CHINA_NO2_ACTIVITY_SOURCE_VERSION,
  CHINA_NO2_ATTRIBUTION_PREFIX,
  CHINA_NO2_REGIONS,
  isLunarNewYearHoliday,
  validateChinaNo2ActivityPayload,
} from './shared/china-no2-activity.mjs';

export const CDSE_TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
export const CDSE_STATISTICS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const USER_AGENT = 'WorldMonitor seed-china-no2-activity/1.0 (+https://www.worldmonitor.app)';
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_ATTEMPTS = 3;
const REQUEST_CONCURRENCY = 2;
const TTL_SECONDS = 7 * 24 * 60 * 60;
const DAY_MS = 86_400_000;

export const EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: [{ bands: ["NO2", "dataMask"] }],
           output: [{ id: "no2", bands: 1, sampleType: "FLOAT32" }, { id: "dataMask", bands: 1 }] };
}
function evaluatePixel(s) { return { no2: [s.NO2], dataMask: [s.dataMask] }; }
`;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date, days) => isoDate(dateMs(date) + days * DAY_MS);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function calendarWindow(dates) {
  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];
  return { windowStart, windowEnd, dates, range: { from: windowStart, to: addDays(windowEnd, 1) } };
}

/** The current window: windowDays UTC dates ending windowEndLagDays before the run date. */
export function currentWindow(nowMs, method = CHINA_NO2_ACTIVITY_METHOD) {
  const windowEnd = addDays(isoDate(nowMs), -method.windowEndLagDays);
  const dates = Array.from({ length: method.windowDays }, (_, index) => addDays(windowEnd, index - method.windowDays + 1));
  return calendarWindow(dates);
}

/** The current window's month-day span shifted back `yearsBack` years; Feb 29 drops where the target year has none. */
export function baselineWindow(current, yearsBack) {
  const dates = current.dates
    .map((date) => `${Number(date.slice(0, 4)) - yearsBack}${date.slice(4)}`)
    .filter((date) => isoDate(dateMs(date)) === date);
  return { year: Number(current.windowEnd.slice(0, 4)) - yearsBack, ...calendarWindow(dates) };
}

export function buildStatisticsRequest(region, range, method = CHINA_NO2_ACTIVITY_METHOD) {
  return {
    input: {
      bounds: { bbox: [...region.bbox], properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' } },
      data: [{
        type: 'sentinel-5p-l2',
        dataFilter: { timeliness: method.timeliness },
        processing: { minQa: method.minQa },
      }],
    },
    aggregation: {
      timeRange: { from: `${range.from}T00:00:00Z`, to: `${range.to}T00:00:00Z` },
      aggregationInterval: { of: 'P1D' },
      evalscript: EVALSCRIPT,
      resx: method.resolutionDegrees,
      resy: method.resolutionDegrees,
    },
  };
}

/** Daily rows keyed by UTC date. A day the API could not compute, or with no samples, reads as invalid (nulls). */
export function parseStatisticsResponse(body) {
  if (!Array.isArray(body?.data)) throw new Error('statistics response has no data array');
  const rows = new Map();
  for (const entry of body.data) {
    const date = String(entry?.interval?.from ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const stats = entry?.outputs?.no2?.bands?.B0?.stats;
    const sampleCount = stats?.sampleCount;
    if (!Number.isFinite(sampleCount) || sampleCount <= 0 || !Number.isFinite(stats?.noDataCount)) {
      rows.set(date, { date, mean: null, validFraction: null });
      continue;
    }
    rows.set(date, {
      date,
      mean: Number.isFinite(stats.mean) ? stats.mean : null,
      validFraction: (sampleCount - stats.noDataCount) / sampleCount,
    });
  }
  return rows;
}

export function summarizeWindow(rowsByDate, windowStart, windowEnd, method = CHINA_NO2_ACTIVITY_METHOD) {
  const means = [];
  const fractions = [];
  let maskedDays = 0;
  for (let date = windowStart; date <= windowEnd; date = addDays(date, 1)) {
    if (isLunarNewYearHoliday(date, method)) {
      maskedDays++;
      continue;
    }
    const row = rowsByDate.get(date);
    if (row && row.mean !== null && row.validFraction !== null && row.validFraction >= method.minValidFraction) {
      means.push(row.mean);
      fractions.push(row.validFraction);
    }
  }
  return {
    windowStart,
    windowEnd,
    validDays: means.length,
    maskedDays,
    meanNo2MolM2: means.length === 0 ? null : mean(means),
    meanValidFraction: fractions.length === 0 ? null : mean(fractions),
  };
}

/**
 * `current` is the summarized current window, or null when its request failed
 * (then `currentSpan` names its dates); `years` are the baseline windows that
 * parsed, each with its `year`.
 */
export function regionResult(definition, { current, currentSpan, years, requestFailed = false }, method = CHINA_NO2_ACTIVITY_METHOD) {
  const base = { id: definition.id, label: definition.label, bbox: [...definition.bbox] };
  if (requestFailed) {
    const { windowStart, windowEnd } = currentSpan ?? current;
    return {
      ...base,
      current: { windowStart, windowEnd, validDays: 0, maskedDays: 0, meanNo2MolM2: null, meanValidFraction: null },
      baseline: { years, meanNo2MolM2: null },
      changePercent: null,
      exclusion: 'request_failed',
    };
  }
  const eligible = years.filter((year) => year.validDays >= method.minValidDays);
  const baselineMean = eligible.length >= method.minBaselineYears ? mean(eligible.map((year) => year.meanNo2MolM2)) : null;
  const baseline = { years, meanNo2MolM2: baselineMean !== null && baselineMean > 0 ? baselineMean : null };
  const exclusion = current.validDays < method.minValidDays
    ? 'insufficient_valid_days'
    : baseline.meanNo2MolM2 === null ? 'insufficient_baseline_years' : null;
  return {
    ...base,
    current,
    baseline,
    changePercent: exclusion === null ? (current.meanNo2MolM2 / baseline.meanNo2MolM2 - 1) * 100 : null,
    exclusion,
  };
}

export function compositeOf(regions, method = CHINA_NO2_ACTIVITY_METHOD) {
  const eligible = regions.filter((region) => region.exclusion === null);
  const regionIds = eligible.map((region) => region.id);
  if (eligible.length < method.minRegions) {
    return { changePercent: null, signalValue: null, regionIds, exclusion: 'insufficient_regions' };
  }
  const sorted = eligible.map((region) => region.changePercent).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const changePercent = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    changePercent,
    signalValue: Math.abs(changePercent) < method.deadBandPercent ? 0 : changePercent,
    regionIds,
    exclusion: null,
  };
}

function httpError(label, response, text) {
  const error = new Error(`${label} HTTP ${response.status}: ${text.slice(0, 200)}`);
  // 429 and 5xx can clear on a retry; any other status is a request or credential problem that will not.
  if (response.status !== 429 && response.status < 500) error.nonRetryable = true;
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}

async function fetchToken({ fetchImpl, clientId, clientSecret, retryDelayMs }) {
  return withRetry(async () => {
    const response = await fetchImpl(CDSE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw httpError('CDSE token', response, text);
    const token = JSON.parse(text)?.access_token;
    if (typeof token !== 'string' || token.length === 0) throw new Error('CDSE token response has no access_token');
    return token;
  }, REQUEST_ATTEMPTS - 1, retryDelayMs);
}

export function makeFetchAll({
  fetchImpl = (...args) => globalThis.fetch(...args),
  clientId,
  clientSecret,
  now = Date.now,
  method = CHINA_NO2_ACTIVITY_METHOD,
  regions = CHINA_NO2_REGIONS,
  concurrency = REQUEST_CONCURRENCY,
  retryDelayMs = 2_000,
  log = console.log,
}) {
  return async function fetchAll() {
    const runMs = now();
    const current = currentWindow(runMs, method);
    const baselines = Array.from({ length: method.baselineYears }, (_, index) => baselineWindow(current, index + 1));
    const windows = [{ year: null, ...current }, ...baselines];

    let token;
    try {
      token = await fetchToken({ fetchImpl, clientId, clientSecret, retryDelayMs });
    } catch (error) {
      throw markPreservableFetchFailure(new Error(`CDSE token fetch failed: ${error?.message || error}`));
    }

    const usage = { requestCount: 0, processingUnitsSpent: 0 };
    const requestWindow = (region, window) => withRetry(async () => {
      usage.requestCount++;
      const startedAt = Date.now();
      const response = await fetchImpl(CDSE_STATISTICS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
        body: JSON.stringify(buildStatisticsRequest(region, window.range, method)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      const pu = Number(response.headers.get('x-processingunits-spent'));
      if (Number.isFinite(pu) && pu >= 0) usage.processingUnitsSpent += pu;
      log(`  ${region.id} ${window.range.from}..${window.range.to} HTTP ${response.status} PU=${Number.isFinite(pu) ? pu.toFixed(3) : '?'} ${Date.now() - startedAt}ms`);
      if (!response.ok) throw httpError('CDSE statistics', response, text);
      return summarizeWindow(parseStatisticsResponse(JSON.parse(text)), window.windowStart, window.windowEnd, method);
    }, REQUEST_ATTEMPTS - 1, retryDelayMs);

    const tasks = regions.flatMap((region) => windows.map((window) => ({ region, window })));
    const settled = await allSettledWithConcurrency(tasks, concurrency, ({ region, window }) => requestWindow(region, window));

    const results = regions.map((region, regionIndex) => {
      const outcomes = settled.slice(regionIndex * windows.length, (regionIndex + 1) * windows.length);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') log(`  ${region.id} request failed: ${outcome.reason?.message || outcome.reason}`);
      }
      const [currentOutcome, ...baselineOutcomes] = outcomes;
      const years = baselineOutcomes.flatMap((outcome, index) => (outcome.status === 'fulfilled'
        ? [{ year: baselines[index].year, ...outcome.value }]
        : []));
      return regionResult(region, {
        current: currentOutcome.status === 'fulfilled' ? currentOutcome.value : null,
        currentSpan: current,
        years,
        requestFailed: outcomes.some((outcome) => outcome.status === 'rejected'),
      }, method);
    });

    if (results.every((region) => region.exclusion === 'request_failed')) {
      throw markPreservableFetchFailure(new Error(`every region failed (${usage.requestCount} requests); last-good kept`));
    }

    const requestedYears = windows.flatMap((window) => [window.windowStart, window.windowEnd]).map((date) => Number(date.slice(0, 4)));
    const payload = {
      methodVersion: CHINA_NO2_ACTIVITY_METHOD_VERSION,
      generatedAt: new Date(runMs).toISOString(),
      method: { ...method, holidayMask: { ...method.holidayMask } },
      source: {
        publisherId: 'publisher:copernicus-sentinel-5p',
        dataset: 'sentinel-5p-l2',
        band: 'NO2',
        unit: 'mol/m2',
        attribution: `${CHINA_NO2_ATTRIBUTION_PREFIX} ${Math.min(...requestedYears)}-${Math.max(...requestedYears)}`,
        requestCount: usage.requestCount,
        processingUnitsSpent: usage.processingUnitsSpent,
      },
      regions: results,
      composite: compositeOf(results, method),
    };
    if (!validateChinaNo2ActivityPayload(payload, method)) {
      throw new Error('built a payload that fails validateChinaNo2ActivityPayload (seeder bug)');
    }
    return payload;
  };
}

export function declareRecords(data) {
  return Array.isArray(data?.composite?.regionIds) ? data.composite.regionIds.length : 0;
}

/** runSeed's afterPublish hook. Best-effort: a failed write costs one more run of health softening, never the run. */
export async function markChinaNo2Activated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', CHINA_NO2_ACTIVITY_ACTIVATION_KEY, '1']);
  } catch (error) {
    console.warn(`  WARN: activation marker write failed: ${error?.message || error}`);
  }
}

const formatNumber = (value, digits = 3) => (value === null ? 'null' : Number(value).toPrecision(digits));
const formatWindow = (window) => `${window.windowStart}..${window.windowEnd} valid=${window.validDays} masked=${window.maskedDays} mean=${formatNumber(window.meanNo2MolM2)} frac=${formatNumber(window.meanValidFraction, 2)}`;

async function main() {
  loadEnvFile(import.meta.url);
  const dryRun = process.argv.includes('--dry-run');
  const clientId = process.env.CDSE_CLIENT_ID?.trim();
  const clientSecret = process.env.CDSE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    if (process.env.RAILWAY_ENVIRONMENT) {
      // #5256: no later tick can fix a missing variable, so a daily crash would only train the team to ignore the
      // crash channel. /api/health reports chinaNo2Activity EMPTY, then STALE_SEED, which is where the alarm belongs.
      console.log('NO SOURCE: CDSE_CLIENT_ID/CDSE_CLIENT_SECRET unset; published nothing, /api/health carries the alarm');
      process.exit(0);
    }
    throw new Error('CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are required');
  }
  const fetchAll = makeFetchAll({ clientId, clientSecret });
  console.log(`china no2 activity: ${CHINA_NO2_REGIONS.length} regions x ${1 + CHINA_NO2_ACTIVITY_METHOD.baselineYears} windows${dryRun ? ', dry run' : ''}`);

  if (dryRun) {
    try {
      const payload = await fetchAll();
      for (const region of payload.regions) {
        console.log(`  ${region.id}: exclusion=${region.exclusion} change=${formatNumber(region.changePercent, 4)}%`);
        console.log(`    current  ${formatWindow(region.current)}`);
        for (const year of region.baseline.years) console.log(`    ${year.year}     ${formatWindow(year)}`);
        console.log(`    baseline mean=${formatNumber(region.baseline.meanNo2MolM2)}`);
      }
      const { composite, source } = payload;
      console.log(`  composite: change=${formatNumber(composite.changePercent, 4)}% signal=${formatNumber(composite.signalValue, 4)} regions=[${composite.regionIds.join(', ')}] exclusion=${composite.exclusion}`);
      console.log(`  requests=${source.requestCount} PU=${source.processingUnitsSpent.toFixed(3)} attribution="${source.attribution}"`);
      console.log(`  valid payload: ${validateChinaNo2ActivityPayload(payload)}; records: ${declareRecords(payload)}`);
    } catch (error) {
      console.log(`  would exit 75 and keep last-good: ${error.message}`);
    }
    console.log('  dry run: no Redis access; nothing published');
    return;
  }

  await runSeed('economic', 'china-no2-activity', CHINA_NO2_ACTIVITY_KEY, fetchAll, {
    validateFn: validateChinaNo2ActivityPayload,
    afterPublish: markChinaNo2Activated,
    ttlSeconds: TTL_SECONDS,
    declareRecords,
    zeroIsValid: true,
    schemaVersion: 1,
    sourceVersion: CHINA_NO2_ACTIVITY_SOURCE_VERSION,
    maxStaleMin: 4320, // 3 x the 20 6 * * * cron
    fetchPhaseTimeoutMs: 8 * 60_000,
    lockTtlMs: 10 * 60_000,
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
