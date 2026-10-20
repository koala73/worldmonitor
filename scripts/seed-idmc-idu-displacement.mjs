#!/usr/bin/env node
// New internal displacement events from IDMC's Internal Displacement Updates
// (IDU), read from the per-country CSVs IDMC publishes on HDX
// (<iso3>-idmc-idu-events). The Helix API carries the same rows but needs a
// client_id IDMC has not issued (#9014).
//
// IDMC enters a figure a median of 23 days after the displacement (p90 65 days,
// measured 2026-10-20), so the newest week is always thin. Surges are judged on
// a 30-day window against the monthly mean of the 150 days before it, and
// newlyReported7d counts figures by publication date instead.

import Papa from 'papaparse';

import { loadEnvFile, CHROME_UA, runSeed, withRetry } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

export const IDU_CANONICAL_KEY = 'displacement:idmc-idu:v1';
export const IDU_ACTIVATION_KEY = 'seed-activated:displacement:idmc-idu';
const HDX_SEARCH_URL = 'https://data.humdata.org/api/3/action/package_search';
const HDX_ORGANIZATION = 'international-displacement-monitoring-centre-idmc';
const DATASET_NAME = /^([a-z]{3})-idmc-idu-events$/;
const SEARCH_ROWS = 1000;
const CACHE_TTL_SECONDS = 3 * 24 * 60 * 60;
const FETCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 60_000;
// Largest file was 4.3 MB (PER) on 2026-10-20.
const MAX_CSV_BYTES = 32 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 180;
export const RECENT_DAYS = 30;
export const NEWLY_REPORTED_DAYS = 7;
export const SURGE_MIN_DISPLACED = 5000;
export const SURGE_RATIO = 3;
// One dataset that HDX lists but will not serve must not hide every other
// country; more than this many is an outage, not a bad file.
export const MAX_MISSING_COUNTRIES = 3;
export const MIN_COUNTRIES = 30;

const REQUIRED_COLUMNS = [
  'id', 'iso3', 'country', 'latitude', 'longitude', 'role', 'displacement_type', 'figure',
  'displacement_date', 'event_id', 'event_name', 'created_at',
];

async function getWithTimeout(url) {
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json, text/csv', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const err = new Error(`HDX ${url}: HTTP ${resp.status}`);
      // A missing or forbidden resource stays that way within one run.
      err.nonRetryable = resp.status >= 400 && resp.status < 500 && resp.status !== 429;
      throw err;
    }
    return resp;
  }, 2, 2000);
}

/** Lists the IDU event datasets and their CSV resource. */
export async function listIduDatasets() {
  const query = new URLSearchParams({ fq: `organization:${HDX_ORGANIZATION}`, rows: String(SEARCH_ROWS) });
  const body = await (await getWithTimeout(`${HDX_SEARCH_URL}?${query}`)).json();
  if (body?.success !== true) throw new Error('HDX package_search returned success=false');
  const { count, results } = body.result ?? {};
  if (!Array.isArray(results)) throw new Error('HDX package_search returned no results array');
  if (Number(count) > results.length) throw new Error(`HDX package_search truncated: ${results.length} of ${count} datasets`);

  const datasets = [];
  for (const pkg of results) {
    const match = DATASET_NAME.exec(pkg?.name ?? '');
    if (!match) continue;
    const csv = (pkg.resources ?? []).find((r) => String(r?.format ?? '').toUpperCase() === 'CSV' && r?.url);
    datasets.push({ countryCode: match[1].toUpperCase(), url: csv?.url ?? null });
  }
  return datasets;
}

async function fetchCsv(url) {
  const resp = await getWithTimeout(url);
  const length = Number(resp.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_CSV_BYTES) throw new Error(`HDX ${url}: ${length} bytes exceeds ${MAX_CSV_BYTES}`);
  const text = await resp.text();
  if (text.length > MAX_CSV_BYTES) throw new Error(`HDX ${url}: body exceeds ${MAX_CSV_BYTES} bytes`);
  return text;
}

export function parseIduCsv(text) {
  const parsed = Papa.parse(String(text ?? ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.replace(/^\ufeff/, '').trim(),
  });
  const fields = new Set(parsed.meta?.fields ?? []);
  const missing = REQUIRED_COLUMNS.filter((field) => !fields.has(field));
  if (missing.length > 0) throw new Error(`IDU CSV is missing columns: ${missing.join(', ')}`);
  if (parsed.errors?.length > 0) throw new Error(`IDU CSV is invalid: ${parsed.errors[0].message}`);
  return parsed.data;
}

const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}/.test(value ?? '') ? value.slice(0, 10) : '');
const daysAgo = (nowMs, days) => new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
const text = (value) => String(value ?? '').trim();

/**
 * Normalizes IDU rows into events inside the window. Only "Recommended figure"
 * rows count: "Triangulation" rows cross-check the same displacement.
 */
export function buildEvents(rows, { nowMs = Date.now() } = {}) {
  const from = daysAgo(nowMs, WINDOW_DAYS);
  const today = daysAgo(nowMs, 0);
  const events = [];
  for (const row of rows) {
    if (text(row?.role) !== 'Recommended figure') continue;
    const displacementDate = isoDate(row.displacement_date);
    if (!displacementDate || displacementDate < from || displacementDate > today) continue;
    const figure = Number(row.figure);
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    const countryCode = text(row.iso3).toUpperCase();
    if (!Number.isFinite(figure) || figure <= 0 || !/^[A-Z]{3}$/.test(countryCode)) continue;
    const hasPoint = text(row.latitude) !== '' && text(row.longitude) !== ''
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    events.push({
      id: text(row.id),
      countryCode,
      countryName: text(row.country) || countryCode,
      displacementType: text(row.displacement_type),
      figure,
      qualifier: text(row.qualifier),
      displacementDate,
      startDate: isoDate(row.displacement_start_date),
      endDate: isoDate(row.displacement_end_date),
      eventId: text(row.event_id),
      eventName: text(row.event_name),
      category: text(row.category),
      hazardType: text(row.type),
      locationName: text(row.locations_name),
      locationAccuracy: text(row.locations_accuracy),
      sources: text(row.sources),
      createdAt: isoDate(row.created_at),
      ...(hasPoint ? { location: { latitude, longitude } } : {}),
    });
  }
  return events.sort((a, b) => b.displacementDate.localeCompare(a.displacementDate) || b.figure - a.figure);
}

/** Per-country totals and the surge flag. */
export function summarizeCountries(events, { nowMs = Date.now() } = {}) {
  const recentFrom = daysAgo(nowMs, RECENT_DAYS);
  const reportedFrom = daysAgo(nowMs, NEWLY_REPORTED_DAYS);
  const baselineMonths = (WINDOW_DAYS - RECENT_DAYS) / 30;
  const byCountry = new Map();
  for (const ev of events) {
    let c = byCountry.get(ev.countryCode);
    if (!c) {
      c = {
        countryCode: ev.countryCode,
        countryName: ev.countryName,
        displaced30d: 0,
        conflict30d: 0,
        disaster30d: 0,
        events30d: 0,
        baselineTotal: 0,
        newlyReported7d: 0,
        latestDisplacementDate: '',
      };
      byCountry.set(ev.countryCode, c);
    }
    if (ev.displacementDate >= recentFrom) {
      c.displaced30d += ev.figure;
      c.events30d += 1;
      if (ev.displacementType === 'Conflict') c.conflict30d += ev.figure;
      else if (ev.displacementType === 'Disaster') c.disaster30d += ev.figure;
    } else {
      c.baselineTotal += ev.figure;
    }
    if (ev.createdAt >= reportedFrom) c.newlyReported7d += ev.figure;
    if (ev.displacementDate > c.latestDisplacementDate) c.latestDisplacementDate = ev.displacementDate;
  }
  return [...byCountry.values()]
    .map(({ baselineTotal, ...c }) => {
      const baseline = baselineTotal / baselineMonths;
      return {
        ...c,
        baselineMonthly: Math.round(baseline),
        surge: c.displaced30d >= SURGE_MIN_DISPLACED && c.displaced30d >= SURGE_RATIO * baseline,
      };
    })
    .sort((a, b) => b.displaced30d - a.displaced30d || b.baselineMonthly - a.baselineMonthly);
}

export async function fetchIduDisplacement({ nowMs = Date.now() } = {}) {
  const datasets = await listIduDatasets();
  if (datasets.length === 0) throw new Error('HDX lists no IDMC IDU event datasets');

  const rows = [];
  const missingCountries = [];
  const queue = [...datasets];
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const { countryCode, url } = queue.shift();
      try {
        if (!url) throw new Error('no CSV resource');
        rows.push(...parseIduCsv(await fetchCsv(url)));
      } catch (err) {
        missingCountries.push(countryCode);
        console.warn(`  WARN: IDU ${countryCode} skipped: ${err?.message || err}`);
      }
    }
  }));
  if (missingCountries.length > MAX_MISSING_COUNTRIES) {
    throw new Error(`IDU: ${missingCountries.length} of ${datasets.length} country files failed (${missingCountries.sort().join(', ')})`);
  }

  const events = buildEvents(rows, { nowMs });
  const countries = summarizeCountries(events, { nowMs });
  const surges = countries.filter((c) => c.surge).map((c) => c.countryCode);
  console.log(`  IDU: ${datasets.length} datasets, ${rows.length} rows, ${events.length} events in ${countries.length} countries since ${daysAgo(nowMs, WINDOW_DAYS)}; surges: ${surges.join(', ') || 'none'}`);
  return {
    source: 'IDMC Internal Displacement Updates (via HDX)',
    windowFrom: daysAgo(nowMs, WINDOW_DAYS),
    missingCountries: missingCountries.sort(),
    countries,
    events,
  };
}

export function validate(data) {
  return Array.isArray(data?.events) && Array.isArray(data?.countries) && data.countries.length >= MIN_COUNTRIES;
}

export function declareRecords(data) {
  return data?.events?.length ?? 0;
}

// Dated by publication, not displacement, so a quiet month on the ground does
// not read as a stale feed.
export function contentMeta(data, nowMs = Date.now()) {
  return tokensToContentMeta((data?.events ?? []).map((ev) => ev.createdAt), nowMs);
}

// Durable marker for /api/health, written only after a successful publish.
async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', IDU_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: IDU activation marker write failed: ${err?.message || err}`);
  }
}

export const seedOptions = {
  validateFn: validate,
  ttlSeconds: CACHE_TTL_SECONDS,
  sourceVersion: 'idmc-idu-hdx-v1',
  declareRecords,
  contentMeta,
  schemaVersion: 1,
  maxStaleMin: 2880, // daily health-bundle tick; 48h = two missed ticks
  // IDMC publishes new figures most weekdays.
  maxContentAgeMin: 14 * DAY_MIN,
  emptyDataIsFailure: true,
  afterPublish: markActivated,
};

if (process.argv[1]?.endsWith('seed-idmc-idu-displacement.mjs')) {
  runSeed('displacement', 'idmc-idu', IDU_CANONICAL_KEY, () => fetchIduDisplacement(), seedOptions).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
