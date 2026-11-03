#!/usr/bin/env node

// Publishes the global Sentinel-5P TROPOMI tropospheric NO2 activity dataset
// (#9722): one record per registered region (167 countries derived from the
// repository's country geometry plus 32 industrial clusters) with its
// year-over-year direction, valid-fraction gating, and provenance. The China
// activity nowcast reads the four Chinese clusters from it as its atmosphere
// family. The registry, the method, and the dataset validator live in
// scripts/shared/no2-activity.mjs, which every reader imports too.
//
// Each region keeps a stored daily series in Redis
// (economic:no2-activity:series:v1:<id>). Every run re-fetches the trailing
// refreshDays of every region from the CDSE Sentinel Hub Statistical API
// (OFFL product, qa_value >= minQa, the region's grid) so late offline
// granules heal past days, then backfills the prior baselineYears in chunks
// sized by the region's width, at most backfillChunksPerRun chunks per run,
// clusters first. A region whose refresh failed keeps its stored series; a
// region without a refresh in the last seven days publishes request_failed;
// a run where the token cannot be fetched or every refresh fails publishes
// nothing so runSeed keeps last-good and exits 75. A successful publish also
// atomically SETs seed-activated:economic:no2-activity, which ends
// /api/health's pre-provisioning softening for no2Activity.
//
// Railway service config (set up manually via the Railway dashboard or `railway service`):
//   - Service name: seed-no2-activity
//   - Root directory: scripts
//   - Start command: node seed-no2-activity.mjs
//   - Cron: 20 6 * * *
//   - Variables: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, CDSE_CLIENT_ID, CDSE_CLIENT_SECRET
//
// One-off backfill in a single sitting (about 1,700 chunks for the whole registry):
//   node seed-no2-activity.mjs --backfill-chunks=1800
// Dry run (live CDSE requests for a few regions, reads stored series, writes nothing):
//   node scripts/seed-no2-activity.mjs --dry-run [--regions=jing-jin-ji,country-de] [--backfill-chunks=4]

import { isMainModule } from './lib/main-module.mjs';
import {
  allSettledWithConcurrency,
  getRedisCredentials,
  loadEnvFile,
  loadSharedConfig,
  markPreservableFetchFailure,
  parseRetryAfterMs,
  redisCommand,
  runSeed,
  withRetry,
  writeExtraKey,
} from './_seed-utils.mjs';
import {
  CHINA_NO2_COMPOSITE,
  NO2_ACTIVITY_ACTIVATION_KEY,
  NO2_ACTIVITY_KEY,
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_MAX_REFRESH_AGE_MS,
  NO2_ACTIVITY_METHOD_VERSION,
  NO2_ACTIVITY_SERIES_KEY_PREFIX,
  NO2_ACTIVITY_SOURCE_VERSION,
  NO2_ATTRIBUTION_PREFIX,
  NO2_REGIONS,
  backfillChunkDaysFor,
  dateMs,
  isHolidayMasked,
  signalFor,
  validateNo2ActivityDataset,
} from './shared/no2-activity.mjs';

export const CDSE_TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
export const CDSE_STATISTICS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const USER_AGENT = 'WorldMonitor seed-no2-activity/1.0 (+https://www.worldmonitor.app)';
const REQUEST_TIMEOUT_MS = 290_000;
const REQUEST_ATTEMPTS = 3;
const REQUEST_CONCURRENCY = 3;
const SERIES_TTL_SECONDS = 400 * 24 * 60 * 60;
const DATASET_TTL_SECONDS = 7 * 24 * 60 * 60;
const MGET_CHUNK = 50;
const DAY_MS = 86_400_000;
const VALID_FRACTION_VERSION = 2;

export const EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: [{ bands: ["NO2", "dataMask"] }],
           output: [{ id: "no2", bands: 1, sampleType: "FLOAT32" }, { id: "dataMask", bands: 1 }] };
}
function evaluatePixel(s) { return { no2: [s.NO2], dataMask: [s.dataMask] }; }
`;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, days) => isoDate(dateMs(date) + days * DAY_MS);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const seriesKeyFor = (regionId) => `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${regionId}`;

function calendarWindow(dates) {
  return { windowStart: dates[0], windowEnd: dates[dates.length - 1], dates };
}

/** The current window: windowDays UTC dates ending windowEndLagDays before the run date. */
export function currentWindow(nowMs, method = NO2_ACTIVITY_METHOD) {
  const windowEnd = addDays(isoDate(nowMs), -method.windowEndLagDays);
  return calendarWindow(Array.from({ length: method.windowDays }, (_, index) => addDays(windowEnd, index - method.windowDays + 1)));
}

/** The current window's month-day span shifted back `yearsBack` years; Feb 29 drops where the target year has none. */
export function baselineWindow(current, yearsBack) {
  const dates = current.dates
    .map((date) => `${Number(date.slice(0, 4)) - yearsBack}${date.slice(4)}`)
    .filter((date) => Number.isFinite(dateMs(date)));
  return { year: Number(current.windowEnd.slice(0, 4)) - yearsBack, ...calendarWindow(dates) };
}

/** The refresh range [from, to) a run fetches for every region. */
export function refreshRange(current, method = NO2_ACTIVITY_METHOD) {
  return { from: addDays(current.windowEnd, 1 - method.refreshDays), to: addDays(current.windowEnd, 1) };
}

export function buildStatisticsRequest(region, range, geometry = null, method = NO2_ACTIVITY_METHOD) {
  const properties = { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' };
  return {
    input: {
      bounds: geometry ? { geometry, properties } : { bbox: [...region.bbox], properties },
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
      resx: region.resolutionDegrees,
      resy: region.resolutionDegrees,
    },
  };
}

/** Daily rows keyed by UTC date. A day the API could not compute, or with no samples, reads as invalid (nulls). */
export function parseStatisticsResponse(body) {
  if (!Array.isArray(body?.data)) throw new Error('statistics response has no data array');
  const geometryPixelCount = Number.isFinite(body.geometryPixelCount) && body.geometryPixelCount > 0
    ? body.geometryPixelCount
    : null;
  const rows = new Map();
  for (const entry of body.data) {
    const date = String(entry?.interval?.from ?? '').slice(0, 10);
    if (!Number.isFinite(dateMs(date))) continue;
    const stats = entry?.outputs?.no2?.bands?.B0?.stats;
    const sampleCount = stats?.sampleCount;
    if (!Number.isFinite(sampleCount) || sampleCount <= 0 || !Number.isFinite(stats?.noDataCount)) {
      rows.set(date, { date, mean: null, validFraction: null });
      continue;
    }
    rows.set(date, {
      date,
      mean: Number.isFinite(stats.mean) ? stats.mean : null,
      validFraction: Math.min(1, (sampleCount - stats.noDataCount) / (geometryPixelCount ?? sampleCount)),
    });
  }
  return rows;
}

export function emptySeries(region) {
  return { id: region.id, resolutionDegrees: region.resolutionDegrees, validFractionVersion: VALID_FRACTION_VERSION, refreshedAt: null, backfilledYears: [], days: {} };
}

/** A stored series is reused only when it is well formed and on the region's current grid. */
export function parseSeries(value, region) {
  const series = typeof value === 'string' ? safeJson(value) : value;
  if (!series || typeof series !== 'object' || series.id !== region.id
    || series.resolutionDegrees !== region.resolutionDegrees
    || (region.kind === 'country' && series.validFractionVersion !== VALID_FRACTION_VERSION)
    || !Array.isArray(series.backfilledYears) || !series.days || typeof series.days !== 'object') {
    return emptySeries(region);
  }
  return {
    id: region.id,
    resolutionDegrees: region.resolutionDegrees,
    validFractionVersion: VALID_FRACTION_VERSION,
    refreshedAt: typeof series.refreshedAt === 'string' && Number.isFinite(Date.parse(series.refreshedAt)) ? series.refreshedAt : null,
    backfilledYears: series.backfilledYears.filter((year) => Number.isInteger(year)).sort(),
    days: Object.fromEntries(Object.entries(series.days).filter(([date, row]) =>
      Number.isFinite(dateMs(date)) && Array.isArray(row) && row.length === 2)),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Later rows overwrite earlier ones; days before `keepFrom` are dropped. Returns a new series. */
export function mergeSeries(series, rows, keepFrom) {
  const days = { ...series.days };
  for (const row of rows.values()) days[row.date] = [row.mean, row.validFraction];
  const kept = Object.fromEntries(Object.entries(days)
    .filter(([date]) => date >= keepFrom)
    .sort(([left], [right]) => (left < right ? -1 : 1)));
  return { ...series, backfilledYears: [...series.backfilledYears], days: kept };
}

export function seriesCoverage(series) {
  const dates = Object.keys(series.days).sort();
  return {
    refreshedAt: series.refreshedAt,
    days: dates.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    backfilledYears: [...series.backfilledYears].sort(),
  };
}

/** The calendar years a window touches (a window crossing New Year touches two). */
export function windowYears(window) {
  const first = Number(window.windowStart.slice(0, 4));
  const last = Number(window.windowEnd.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Every calendar year the current and baseline windows touch, ascending. */
export function neededYears(current, baselines) {
  return [...new Set([current, ...baselines].flatMap(windowYears))].sort();
}

/**
 * The chunks covering [Jan 1, min(Dec 31, windowEnd)] of `year` for a region,
 * minus the days the run's refresh range already fetches. A year that lies
 * entirely inside the refresh range needs no chunk at all.
 */
export function yearChunks(region, year, windowEnd, refreshFrom, method = NO2_ACTIVITY_METHOD) {
  const chunkDays = backfillChunkDaysFor(region, method);
  const last = Math.min(dateMs(`${year}-12-31`), dateMs(windowEnd), dateMs(refreshFrom) - DAY_MS);
  const chunks = [];
  for (let from = dateMs(`${year}-01-01`); from <= last; from += chunkDays * DAY_MS) {
    const to = Math.min(from + chunkDays * DAY_MS, last + DAY_MS);
    chunks.push({ year, from: isoDate(from), to: isoDate(to) });
  }
  return chunks;
}

/**
 * The backfill chunks this run may spend, clusters first then registry order,
 * whole region-years at a time (a partial year is refetched in full by the
 * next run, so a year is started only when its chunks fit the remaining
 * budget; the first year always starts).
 */
export function backfillQueue(regions, seriesById, years, windowEnd, refreshFrom, budget, method = NO2_ACTIVITY_METHOD) {
  const ordered = [...regions].sort((left, right) =>
    (left.kind === right.kind ? 0 : left.kind === 'cluster' ? -1 : 1));
  const queue = [];
  if (budget <= 0) return queue;
  for (const region of ordered) {
    const done = new Set(seriesById.get(region.id)?.backfilledYears ?? []);
    for (const year of years) {
      if (done.has(year)) continue;
      const chunks = yearChunks(region, year, windowEnd, refreshFrom, method);
      if (chunks.length === 0) continue;
      if (queue.length > 0 && queue.length + chunks.length > budget) return queue;
      for (const chunk of chunks) queue.push({ region, ...chunk });
    }
  }
  return queue;
}

export function summarizeWindow(series, windowStart, windowEnd, holidayCalendar, method = NO2_ACTIVITY_METHOD) {
  const means = [];
  const fractions = [];
  let maskedDays = 0;
  for (let date = windowStart; date <= windowEnd; date = addDays(date, 1)) {
    if (isHolidayMasked(date, holidayCalendar, method)) {
      maskedDays++;
      continue;
    }
    const row = series.days[date];
    if (row && row[0] !== null && row[1] !== null && row[1] >= method.minValidFraction) {
      means.push(row[0]);
      fractions.push(row[1]);
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
 * One dataset record from a region's stored series. `refreshFailed` says this
 * run's refresh request failed; the region is still judged on what is stored,
 * and reads request_failed when its last successful refresh is absent or old.
 */
export function regionResult(definition, series, current, baselines, refreshFailed = false, method = NO2_ACTIVITY_METHOD, nowMs = dateMs(current.windowEnd) + method.windowEndLagDays * DAY_MS) {
  const currentWindowSummary = summarizeWindow(series, current.windowStart, current.windowEnd, definition.holidayCalendar, method);
  const years = baselines.map((baseline) => ({
    year: baseline.year,
    ...summarizeWindow(series, baseline.windowStart, baseline.windowEnd, definition.holidayCalendar, method),
  }));
  const backfilled = new Set(series.backfilledYears);
  const covered = (window) => windowYears(window).every((year) => backfilled.has(year));
  const backfilledBaselines = years.filter(covered);
  const eligibleYears = backfilledBaselines.filter((year) => year.validDays >= method.minValidDays);
  const baselineMean = eligibleYears.length >= method.minBaselineYears ? mean(eligibleYears.map((year) => year.meanNo2MolM2)) : null;
  const baseline = { years, meanNo2MolM2: baselineMean !== null && baselineMean > 0 ? baselineMean : null };
  const refreshAgeMs = series.refreshedAt === null ? Infinity : nowMs - Date.parse(series.refreshedAt);
  // Every year a window touches must be backfilled: until then the refresh
  // days alone would read as cloud-starved rather than as not yet fetched.
  const backfillPending = backfilledBaselines.length < method.minBaselineYears || !covered(current);
  const exclusion = refreshFailed && refreshAgeMs > NO2_ACTIVITY_MAX_REFRESH_AGE_MS
    ? 'request_failed'
    : backfillPending
      ? 'baseline_backfill_pending'
      : currentWindowSummary.validDays < method.minValidDays
        ? 'insufficient_valid_days'
        : baseline.meanNo2MolM2 === null
          ? 'insufficient_baseline_years'
          : null;
  const changePercent = exclusion === null
    ? (currentWindowSummary.meanNo2MolM2 / baseline.meanNo2MolM2 - 1) * 100
    : null;
  return {
    id: definition.id,
    kind: definition.kind,
    label: definition.label,
    countryCode: definition.countryCode,
    bbox: [...definition.bbox],
    resolutionDegrees: definition.resolutionDegrees,
    current: currentWindowSummary,
    baseline,
    series: seriesCoverage(series),
    changePercent,
    ...(exclusion === null ? signalFor(changePercent, method) : { signalValue: null, direction: null }),
    exclusion,
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

/** CDSE tokens live 1800 s and a run can outlast one; a token is reused for 25 minutes, then fetched again. */
const TOKEN_REUSE_MS = 25 * 60_000;

async function fetchToken({ fetchImpl, clientId, clientSecret, retryDelayMs }) {
  return withRetry(async () => {
    const response = await fetchImpl(CDSE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw httpError('CDSE token', response, text);
    const token = JSON.parse(text)?.access_token;
    if (typeof token !== 'string' || token.length === 0) throw new Error('CDSE token response has no access_token');
    return token;
  }, REQUEST_ATTEMPTS - 1, retryDelayMs);
}

export function loadGeometries() {
  return loadSharedConfig('no2-region-geometries.generated.json');
}

/** Redis adapter: MGET the stored series in chunks; write one series. */
export function redisSeriesStore() {
  const { url, token } = getRedisCredentials();
  return {
    async readSeries(keys) {
      const values = new Map();
      for (let start = 0; start < keys.length; start += MGET_CHUNK) {
        const chunk = keys.slice(start, start + MGET_CHUNK);
        const { result } = await withRetry(
          () => redisCommand(url, token, ['MGET', ...chunk], { label: 'Redis MGET no2 series' }),
          REQUEST_ATTEMPTS - 1,
          1_000,
        );
        chunk.forEach((key, index) => values.set(key, Array.isArray(result) ? result[index] ?? null : null));
      }
      return values;
    },
    writeSeries(key, series) {
      return writeExtraKey(key, series, SERIES_TTL_SECONDS);
    },
  };
}

export function makeFetchAll({
  fetchImpl = (...args) => globalThis.fetch(...args),
  store,
  clientId,
  clientSecret,
  now = Date.now,
  method = NO2_ACTIVITY_METHOD,
  regions = NO2_REGIONS,
  geometries = loadGeometries(),
  backfillChunks = method.backfillChunksPerRun,
  backfillDeadlineMs = 40 * 60_000,
  concurrency = REQUEST_CONCURRENCY,
  retryDelayMs = 2_000,
  writeSeries = true,
  log = console.log,
}) {
  return async function fetchAll() {
    const runMs = now();
    const startedAt = Date.now();
    const current = currentWindow(runMs, method);
    const baselines = Array.from({ length: method.baselineYears }, (_, index) => baselineWindow(current, index + 1));
    const years = neededYears(current, baselines);
    const keepFrom = `${years[0]}-01-01`;
    const range = refreshRange(current, method);

    const token = { value: null, fetchedAt: 0 };
    const currentToken = async () => {
      if (token.value !== null && Date.now() - token.fetchedAt < TOKEN_REUSE_MS) return token.value;
      token.value = await fetchToken({ fetchImpl, clientId, clientSecret, retryDelayMs });
      token.fetchedAt = Date.now();
      return token.value;
    };
    try {
      await currentToken();
    } catch (error) {
      throw markPreservableFetchFailure(new Error(`CDSE token fetch failed: ${error?.message || error}`));
    }

    const stored = await store.readSeries(regions.map((region) => seriesKeyFor(region.id)));
    const seriesById = new Map(regions.map((region) => [region.id, parseSeries(stored.get(seriesKeyFor(region.id)), region)]));
    const storedBefore = new Map([...seriesById].map(([id, series]) => [id, JSON.stringify(series)]));

    const usage = { requestCount: 0, processingUnitsSpent: 0 };
    const requestRows = (region, window) => withRetry(async () => {
      usage.requestCount++;
      const requestedAt = Date.now();
      const response = await fetchImpl(CDSE_STATISTICS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await currentToken()}`, 'User-Agent': USER_AGENT },
        body: JSON.stringify(buildStatisticsRequest(region, window, geometries[region.id] ?? null, method)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      const pu = Number(response.headers.get('x-processingunits-spent'));
      if (Number.isFinite(pu) && pu >= 0) usage.processingUnitsSpent += pu;
      log(`  ${region.id} ${window.from}..${window.to} HTTP ${response.status} PU=${Number.isFinite(pu) ? pu.toFixed(3) : '?'} ${Date.now() - requestedAt}ms`);
      if (response.status === 401) {
        // An expired token: the retry fetches a fresh one.
        token.value = null;
        throw new Error('CDSE statistics HTTP 401: token rejected');
      }
      if (!response.ok) throw httpError('CDSE statistics', response, text);
      return parseStatisticsResponse(JSON.parse(text));
    }, REQUEST_ATTEMPTS - 1, retryDelayMs);

    const refreshes = await allSettledWithConcurrency(regions, concurrency, (region) => requestRows(region, range));
    const refreshFailed = new Set();
    regions.forEach((region, index) => {
      const outcome = refreshes[index];
      if (outcome.status === 'fulfilled') {
        const before = seriesById.get(region.id);
        const previousWindowEnd = before.refreshedAt === null
          ? Object.keys(before.days).sort().at(-1)
          : currentWindow(Date.parse(before.refreshedAt), method).windowEnd;
        const series = mergeSeries(before, outcome.value, keepFrom);
        if (previousWindowEnd !== undefined && addDays(previousWindowEnd, 1) < range.from) {
          const gapFromYear = Number(addDays(previousWindowEnd, 1).slice(0, 4));
          const gapToYear = Number(addDays(range.from, -1).slice(0, 4));
          series.backfilledYears = series.backfilledYears.filter((year) => year < gapFromYear || year > gapToYear);
        }
        series.refreshedAt = new Date(runMs).toISOString();
        // A year that lies entirely inside the refresh range is complete with it.
        for (const year of years) {
          if (yearChunks(region, year, current.windowEnd, range.from, method).length === 0 && !series.backfilledYears.includes(year)) {
            series.backfilledYears = [...series.backfilledYears, year].sort();
          }
        }
        seriesById.set(region.id, series);
      } else {
        refreshFailed.add(region.id);
        log(`  ${region.id} refresh failed: ${outcome.reason?.message || outcome.reason}`);
      }
    });
    if (refreshFailed.size === regions.length) {
      throw markPreservableFetchFailure(new Error(`every refresh failed (${usage.requestCount} requests); last-good kept`));
    }

    const queue = backfillQueue(regions, seriesById, years, current.windowEnd, range.from, backfillChunks, method);
    let skippedForDeadline = 0;
    const chunks = await allSettledWithConcurrency(queue, concurrency, (task) => {
      // Chunks still start inside the deadline so the fetch-phase timeout can never
      // outrun the series writes that follow.
      if (Date.now() - startedAt > backfillDeadlineMs) {
        skippedForDeadline++;
        throw new Error('backfill deadline reached');
      }
      return requestRows(task.region, task);
    });
    const chunkOutcomes = new Map();
    queue.forEach((task, index) => {
      const key = `${task.region.id}:${task.year}`;
      const list = chunkOutcomes.get(key) ?? {
        region: task.region,
        year: task.year,
        expected: yearChunks(task.region, task.year, current.windowEnd, range.from, method).length,
        ok: 0,
      };
      const outcome = chunks[index];
      if (outcome.status === 'fulfilled') {
        list.ok++;
        seriesById.set(task.region.id, mergeSeries(seriesById.get(task.region.id), outcome.value, keepFrom));
      } else {
        log(`  ${task.region.id} ${task.from}..${task.to} backfill failed: ${outcome.reason?.message || outcome.reason}`);
      }
      chunkOutcomes.set(key, list);
    });
    for (const { region, year, expected, ok } of chunkOutcomes.values()) {
      const series = seriesById.get(region.id);
      if (ok === expected && !series.backfilledYears.includes(year)) {
        series.backfilledYears = [...series.backfilledYears, year].sort();
      }
    }
    log(`  requests=${usage.requestCount} PU=${usage.processingUnitsSpent.toFixed(3)} refreshFailed=${refreshFailed.size} backfillChunks=${queue.length} skippedForDeadline=${skippedForDeadline}`);

    if (writeSeries) {
      for (const region of regions) {
        const series = seriesById.get(region.id);
        if (Object.keys(series.days).length > 0 && JSON.stringify(series) !== storedBefore.get(region.id)) {
          await store.writeSeries(seriesKeyFor(region.id), series);
        }
      }
    }

    const records = regions.map((region) =>
      regionResult(region, seriesById.get(region.id), current, baselines, refreshFailed.has(region.id), method, runMs));
    const coveredYears = records.flatMap((record) => [record.series.firstDate, record.series.lastDate, record.current.windowEnd])
      .filter((date) => date !== null)
      .map((date) => Number(date.slice(0, 4)));
    const dataset = {
      methodVersion: NO2_ACTIVITY_METHOD_VERSION,
      generatedAt: new Date(runMs).toISOString(),
      method: JSON.parse(JSON.stringify(method)),
      source: {
        publisherId: 'publisher:copernicus-sentinel-5p',
        dataset: 'sentinel-5p-l2',
        band: 'NO2',
        unit: 'mol/m2',
        attribution: `${NO2_ATTRIBUTION_PREFIX} ${Math.min(...coveredYears)}-${Math.max(...coveredYears)}`,
        requestCount: usage.requestCount,
        processingUnitsSpent: usage.processingUnitsSpent,
      },
      regions: Object.fromEntries(records.map((record) => [record.id, record])),
    };
    return dataset;
  };
}

/** A record for a region this run did not touch, so a partial run still assembles a full dataset. */
export function pendingRecord(definition, nowMs, method = NO2_ACTIVITY_METHOD) {
  const current = currentWindow(nowMs, method);
  const baselines = Array.from({ length: method.baselineYears }, (_, index) => baselineWindow(current, index + 1));
  return regionResult(definition, emptySeries(definition), current, baselines, false, method);
}

export function declareRecords(data) {
  return Object.values(data?.regions ?? {}).filter((region) => region?.exclusion === null).length;
}

export async function publishNo2Atomically(_data, { canonicalKey, payload, ttlSeconds }, { url, token } = getRedisCredentials()) {
  const { result } = await redisCommand(url, token, [
    'EVAL',
    "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('SET', KEYS[2], '1'); return 1",
    2, canonicalKey, NO2_ACTIVITY_ACTIVATION_KEY, payload, ttlSeconds,
  ], { label: 'NO2 dataset and activation publication' });
  if (result !== 1) throw new Error('NO2 dataset and activation publication was not confirmed');
}

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
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
      // crash channel. /api/health reports no2Activity EMPTY, then STALE_SEED, which is where the alarm belongs.
      console.log('NO SOURCE: CDSE_CLIENT_ID/CDSE_CLIENT_SECRET unset; published nothing, /api/health carries the alarm');
      process.exit(0);
    }
    throw new Error('CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are required');
  }
  const backfillArg = Number(argValue('backfill-chunks'));
  const backfillChunks = Number.isFinite(backfillArg) && backfillArg >= 0 ? backfillArg : undefined;

  if (dryRun) {
    const ids = argValue('regions')?.split(',').map((id) => id.trim()).filter(Boolean)
      ?? [...CHINA_NO2_COMPOSITE.regionIds, 'country-de', 'country-ru', 'country-us', 'country-br', 'country-in'];
    const regions = NO2_REGIONS.filter((region) => ids.includes(region.id));
    const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    const store = hasRedis ? redisSeriesStore() : { readSeries: async () => new Map() };
    console.log(`no2 activity dry run: ${regions.length} of ${NO2_REGIONS.length} regions, backfill chunks ${backfillChunks ?? 0}, stored series ${hasRedis ? 'read' : 'unavailable'}, nothing written`);
    const nowMs = Date.now();
    const fetchAll = makeFetchAll({ store, clientId, clientSecret, regions, now: () => nowMs, backfillChunks: backfillChunks ?? 0, writeSeries: false });
    try {
      const partial = await fetchAll();
      for (const record of Object.values(partial.regions)) {
        console.log(`  ${record.id}: exclusion=${record.exclusion} change=${formatNumber(record.changePercent, 4)}% direction=${record.direction} series=${record.series.days}d backfilled=[${record.series.backfilledYears.join(',')}]`);
        console.log(`    current  ${formatWindow(record.current)}`);
        for (const year of record.baseline.years) console.log(`    ${year.year}     ${formatWindow(year)}`);
      }
      const full = {
        ...partial,
        regions: Object.fromEntries(NO2_REGIONS.map((definition) => [definition.id, partial.regions[definition.id] ?? pendingRecord(definition, nowMs)])),
      };
      console.log(`  requests=${partial.source.requestCount} PU=${partial.source.processingUnitsSpent.toFixed(3)} attribution="${partial.source.attribution}"`);
      const { projectBudget } = await import('./generate-no2-regions.mjs');
      console.log(`  projected monthly budget for the full registry: ${JSON.stringify(projectBudget(NO2_REGIONS, NO2_ACTIVITY_METHOD, backfillChunkDaysFor))}`);
      console.log(`  valid full dataset: ${validateNo2ActivityDataset(full)}; eligible records: ${declareRecords(full)}`);
    } catch (error) {
      console.log(`  would exit 75 and keep last-good: ${error.message}`);
    }
    return;
  }

  const fetchAll = makeFetchAll({ store: redisSeriesStore(), clientId, clientSecret, backfillChunks });
  console.log(`no2 activity: ${NO2_REGIONS.length} regions, backfill chunks ${backfillChunks ?? NO2_ACTIVITY_METHOD.backfillChunksPerRun}`);
  await runSeed('economic', 'no2-activity', NO2_ACTIVITY_KEY, fetchAll, {
    validateFn: validateNo2ActivityDataset,
    publishAtomically: publishNo2Atomically,
    ttlSeconds: DATASET_TTL_SECONDS,
    declareRecords,
    zeroIsValid: true,
    schemaVersion: 1,
    sourceVersion: NO2_ACTIVITY_SOURCE_VERSION,
    maxStaleMin: 4320, // 3 x the 20 6 * * * cron
    fetchPhaseTimeoutMs: 60 * 60_000,
    lockTtlMs: 75 * 60_000,
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
