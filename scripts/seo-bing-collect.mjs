#!/usr/bin/env node

/**
 * Collect site traffic, query, page and crawl stats from the Bing Webmaster
 * API, and write a dated snapshot plus a markdown summary beside the Search
 * Console snapshots (#10024).
 *
 * The contract is the Search Console collector's:
 *
 * - named fields are picked out of each API response, never copied wholesale;
 * - a missing value stays `null` and carries a reason, never zero;
 * - the API key arrives only through `loadEnvFile()`, is never printed, and the
 *   writer refuses to emit a snapshot that contains it or the site URL.
 *
 * Each API method feeds one section, and each section carries its own
 * `availability` (`available`, `partial` or `unavailable`) with a reason, so a
 * failed method degrades only its own section.
 *
 * Bing reports in two shapes that are never mixed:
 *
 * - `GetRankAndTrafficStats` and `GetCrawlStats` are daily site rows. The
 *   traffic rows are the only source of totals and of the seven-day trend.
 * - `GetQueryStats` and `GetPageStats` are weekly buckets, dated on the Friday
 *   that ends the week, holding at most 100 rows each. Their sums cover the top
 *   rows of each week, so they are labelled `top-100-per-week` and are never
 *   reported as totals. On 2026-11-02 the 30-odd page rows of a week summed to
 *   85-90% of that week's daily impressions, far under the cap, so even an
 *   uncapped week is not complete.
 *
 * Bing AI Performance (citations and grounding queries) has no API method, so
 * that section is always unavailable rather than zero.
 *
 * Usage:
 *   node scripts/seo-bing-collect.mjs --fixtures tests/fixtures/bing/
 *   node scripts/seo-bing-collect.mjs --live
 *
 * Options:
 *   --fixtures <dir>      read recorded API responses instead of calling Bing
 *   --live                call the API using BING_WEBMASTER_API_KEY
 *   --out-dir <dir>       snapshot directory (default docs/research/seo-ai-visibility/bing)
 *   --date <YYYY-MM-DD>   snapshot date (default the observation date)
 *   --stdout              print the snapshot instead of writing files
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME_UA, loadEnvFile } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { classifyUrl } from './lib/seo-url-taxonomy.mjs';
import { PAGE_FAMILIES } from './seo-ai-visibility-scorecard.mjs';
import {
  isBrandQuery,
  markdownCell,
  queryCell,
  number,
  percent,
  weeklyTotals,
} from './seo-gsc-collect.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BING_ENDPOINT = 'https://ssl.bing.com/webmaster/api.svc/json';
/**
 * The site as verified in Bing Webmaster Tools (`GetUserSites`). It is also
 * the apex homepage URL, so page URLs are written without their scheme and
 * this exact string never needs to reach the output.
 */
const BING_SITE_URL = 'https://worldmonitor.app/';
const METHODS = Object.freeze({
  traffic: 'GetRankAndTrafficStats',
  queries: 'GetQueryStats',
  pages: 'GetPageStats',
  crawl: 'GetCrawlStats',
});
const WINDOW_DAYS = Object.freeze({ '28d': 28, '90d': 90 });
const CRAWL_CHANGE_DAYS = 28;
const WEEKLY_ROW_CAP = 100;
const MAX_TOP_QUERIES = 20;
const REQUEST_TIMEOUT_MS = 60_000;
/** Delays between attempts; four attempts in total. */
const RETRY_DELAYS_MS = Object.freeze([2_000, 8_000, 30_000]);
const SNAPSHOT_SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;

const TOP_ROWS_REASON = `Bing returns at most ${WEEKLY_ROW_CAP} rows per weekly bucket, so these sums cover the top rows of each week and are not totals. Totals come from the daily traffic section.`;
const AI_PERFORMANCE_REASON = 'Bing Webmaster Tools reports AI Performance (citations and grounding queries) only in its UI; the Webmaster API has no method for it.';

/** Bing field per snapshot field. Everything else in a crawl row is dropped. */
const CRAWL_FIELDS = Object.freeze({
  inIndex: 'InIndex',
  crawledPages: 'CrawledPages',
  crawlErrors: 'CrawlErrors',
  code2xx: 'Code2xx',
  code301: 'Code301',
  code302: 'Code302',
  code4xx: 'Code4xx',
  code5xx: 'Code5xx',
  blockedByRobotsTxt: 'BlockedByRobotsTxt',
  allOtherCodes: 'AllOtherCodes',
  dnsFailures: 'DnsFailures',
  connectionTimeout: 'ConnectionTimeout',
  containsMalware: 'ContainsMalware',
  inLinks: 'InLinks',
});

/**
 * `apikey=` is how a request URL would leak the key. `__type` and `/Date(` only
 * appear in a raw Bing payload, so finding them means a field was copied
 * wholesale instead of picked.
 */
const SECRET_MARKERS = Object.freeze(['apikey=', '__type', '/Date(']);

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-bing] ${message}`);
}

const roundTo = (value, digits) => Number(value.toFixed(digits));
const ratio = (numerator, denominator) => (
  denominator > 0 ? roundTo(numerator / denominator, 4) : null
);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDate = (date, days) => isoDate(Date.parse(date) + days * DAY_MS);
const stripScheme = (text) => String(text).replace(/https?:\/\//gi, '');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `/Date(1772755200000)/`, optionally with a `-0800` offset, to `YYYY-MM-DD`. */
export function parseBingDate(value) {
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(String(value));
  invariant(match, 'a row carries a date Bing does not normally send');
  return isoDate(Number(match[1]));
}

const count = (value) => {
  invariant(Number.isInteger(value) && value >= 0, 'a row carries a count that is not a non-negative integer');
  return value;
};

/** Bing writes -1 for "no position", including on every click position it does not compute. */
const position = (value) => (Number.isFinite(value) && value > 0 ? value : null);

const pickTraffic = (row) => ({
  date: parseBingDate(row.Date),
  impressions: count(row.Impressions),
  clicks: count(row.Clicks),
});

// GetPageStats reuses the query row shape, with the URL in `Query`.
const pickWeeklyRow = (row) => ({
  key: String(row.Query ?? ''),
  weekEnding: parseBingDate(row.Date),
  impressions: count(row.Impressions),
  clicks: count(row.Clicks),
  avgImpressionPosition: position(row.AvgImpressionPosition),
  avgClickPosition: position(row.AvgClickPosition),
});

const pickCrawl = (row) => ({
  date: parseBingDate(row.Date),
  ...Object.fromEntries(
    Object.entries(CRAWL_FIELDS).map(([field, source]) => [field, count(row[source])]),
  ),
});

const byDate = (field) => (left, right) => left[field].localeCompare(right[field]);

const PICKERS = Object.freeze({
  traffic: (payload) => payload.map(pickTraffic).sort(byDate('date')),
  queries: (payload) => payload.map(pickWeeklyRow),
  pages: (payload) => payload.map(pickWeeklyRow),
  crawl: (payload) => payload.map(pickCrawl).sort(byDate('date')),
});

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Recorded responses named per method in `manifest.json`. A recording of
 * `{ "error": { "code": n } }` answers as that HTTP failure, so a failed method
 * is exercised by data rather than by a flag only the test sets.
 */
export function createFixtureTransport(directory) {
  const root = resolve(directory);
  const manifest = readJson(join(root, 'manifest.json'));
  return {
    kind: 'fixtures',
    manifest,
    async call(method) {
      const file = manifest.methods?.[method];
      invariant(file !== undefined, `${method} has no recorded response`);
      const payload = readJson(join(root, file));
      invariant(!payload?.error, `${method} failed with HTTP ${payload?.error?.code ?? 0}`);
      return payload;
    },
  };
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function createLiveTransport({
  apiKey,
  siteUrl = BING_SITE_URL,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  const attempts = RETRY_DELAYS_MS.length + 1;
  return {
    kind: 'bing-webmaster-api',
    // The request URL carries the key, so neither it nor the response body
    // ever reaches an error message.
    async call(method) {
      const url = `${BING_ENDPOINT}/${method}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;
      let failure = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2]);
        let response;
        try {
          response = await fetchImpl(url, {
            headers: { accept: 'application/json', 'User-Agent': CHROME_UA },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          failure = error?.name ?? 'network error';
          continue;
        }
        if (response.ok) return response.json();
        await response.body?.cancel().catch(() => {});
        invariant(
          response.status === 429 || response.status >= 500,
          `${method} failed with HTTP ${response.status}`,
        );
        failure = `HTTP ${response.status}`;
      }
      throw new Error(`[seo-bing] ${method} failed with ${failure} after ${attempts} attempts`);
    },
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const unavailable = (method, reason) => ({ method, availability: 'unavailable', reason });

async function fetchRows(transport, section) {
  const method = METHODS[section];
  try {
    const payload = await transport.call(method);
    invariant(Array.isArray(payload?.d), `${method} returned no row list`);
    return { rows: PICKERS[section](payload.d), reason: null };
  } catch (error) {
    return { rows: null, reason: error.message.replace(/^\[seo-bing\] /, '') };
  }
}

/**
 * Windows end on the latest date Bing reports. The daily traffic rows decide
 * it; when the traffic method failed, the newest weekly bucket across queries
 * and pages stands in, so neither section loses its latest week.
 */
function deriveWindows(raw) {
  const latestOf = (dates) => (dates && dates.length > 0
    ? dates.reduce((latest, date) => (date > latest ? date : latest))
    : null);
  let end = null;
  const trafficEnd = latestOf(raw.traffic.rows?.map((row) => row.date));
  if (trafficEnd) {
    end = { section: 'traffic', date: trafficEnd };
  } else {
    for (const section of ['queries', 'pages']) {
      const date = latestOf(raw[section].rows?.map((row) => row.weekEnding));
      if (date && (!end || date > end.date)) end = { section, date };
    }
  }
  if (!end) return { endSource: null, windows: [] };
  return {
    endSource: METHODS[end.section],
    windows: Object.entries(WINDOW_DAYS).map(([label, days]) => ({
      label,
      days,
      startDate: shiftDate(end.date, -(days - 1)),
      endDate: end.date,
    })),
  };
}

const inWindow = (date, window) => date >= window.startDate && date <= window.endDate;
const sumOf = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

/**
 * One row per date. A date Bing repeats verbatim counts once; a date whose
 * rows disagree is left out, since neither row can be trusted over the other.
 * Counting rows instead of dates would read either case as a complete window
 * and double-count it.
 */
function onePerDate(rows) {
  const unique = [];
  const conflicting = [];
  for (const [date, group] of groupBy(rows, (row) => row.date)) {
    const [first] = group;
    if (group.every((row) => row.impressions === first.impressions && row.clicks === first.clicks)) {
      unique.push(first);
    } else {
      conflicting.push(date);
    }
  }
  return { rows: unique.sort(byDate('date')), conflicting: conflicting.sort() };
}

function buildTraffic({ rows: rawRows, reason }, windows) {
  if (rawRows === null) return unavailable(METHODS.traffic, reason);
  if (rawRows.length === 0) return unavailable(METHODS.traffic, 'Bing returned no daily rows');
  const { rows, conflicting } = onePerDate(rawRows);
  const gaps = conflicting.length > 0
    ? [`Bing returned conflicting rows for ${conflicting.join(', ')}, so those days are left out`]
    : [];
  const byWindow = {};
  for (const window of windows) {
    const slice = rows.filter((row) => inWindow(row.date, window));
    const impressions = sumOf(slice, 'impressions');
    const clicks = sumOf(slice, 'clicks');
    if (slice.length < window.days) {
      gaps.push(`${window.label}: Bing reported ${slice.length} of ${window.days} days`);
    }
    byWindow[window.label] = {
      startDate: window.startDate,
      endDate: window.endDate,
      daysReported: slice.length,
      impressions,
      clicks,
      ctr: ratio(clicks, impressions),
    };
  }
  const widest = windows.at(-1);
  const trend = weeklyTotals(
    rows
      .filter((row) => inWindow(row.date, widest))
      .map((row) => ({ ...row, nonBrandImpressions: null, nonBrandClicks: null })),
  ).map(({ startDate, endDate, days, impressions, clicks }) => ({
    startDate,
    endDate,
    days,
    impressions,
    clicks,
    ctr: ratio(clicks, impressions),
  }));
  return {
    method: METHODS.traffic,
    availability: gaps.length === 0 ? 'available' : 'partial',
    reason: gaps.length === 0 ? null : `${gaps.join('; ')}. A missing day is counted as nothing, not estimated.`,
    basis: 'daily-site-totals',
    windows: byWindow,
    weeklyTrend: trend,
  };
}

function weekCoverage(slice) {
  const rowsPerWeek = new Map();
  for (const row of slice) rowsPerWeek.set(row.weekEnding, (rowsPerWeek.get(row.weekEnding) ?? 0) + 1);
  const weeks = [...rowsPerWeek.keys()].sort();
  return {
    weeks: weeks.length,
    firstWeekEnding: weeks[0] ?? null,
    lastWeekEnding: weeks.at(-1) ?? null,
    weeksAtRowCap: weeks.filter((week) => rowsPerWeek.get(week) >= WEEKLY_ROW_CAP).length,
  };
}

const metrics = (rows) => {
  const impressions = sumOf(rows, 'impressions');
  const clicks = sumOf(rows, 'clicks');
  return { impressions, clicks, ctr: ratio(clicks, impressions) };
};

/** Weighted by the volume each position was measured over; null when nothing was. */
function weightedPosition(rows, field, weightField) {
  let total = 0;
  let weight = 0;
  for (const row of rows) {
    if (row[field] === null || row[weightField] === 0) continue;
    total += row[field] * row[weightField];
    weight += row[weightField];
  }
  return weight > 0 ? roundTo(total / weight, 2) : null;
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function buildQueries({ rows, reason }, windows) {
  if (rows === null) return unavailable(METHODS.queries, reason);
  const byWindow = {};
  for (const window of windows) {
    const slice = rows.filter((row) => inWindow(row.weekEnding, window));
    const brandRows = slice.filter((row) => isBrandQuery(row.key));
    const nonBrandRows = slice.filter((row) => !isBrandQuery(row.key));
    const split = (subset) => ({
      ...metrics(subset),
      queries: new Set(subset.map((row) => row.key)).size,
    });
    const topQueries = [...groupBy(slice, (row) => row.key)]
      .map(([query, group]) => ({
        query,
        brand: isBrandQuery(query),
        ...metrics(group),
        avgImpressionPosition: weightedPosition(group, 'avgImpressionPosition', 'impressions'),
        avgClickPosition: weightedPosition(group, 'avgClickPosition', 'clicks'),
      }))
      .sort((left, right) => right.impressions - left.impressions
        || left.query.localeCompare(right.query))
      .slice(0, MAX_TOP_QUERIES);
    byWindow[window.label] = {
      startDate: window.startDate,
      endDate: window.endDate,
      ...weekCoverage(slice),
      ...metrics(slice),
      brand: split(brandRows),
      nonBrand: split(nonBrandRows),
      topQueries,
    };
  }
  return {
    method: METHODS.queries,
    availability: 'partial',
    reason: TOP_ROWS_REASON,
    basis: 'top-100-per-week',
    windows: byWindow,
  };
}

function buildPages({ rows, reason }, windows) {
  if (rows === null) return unavailable(METHODS.pages, reason);
  const byWindow = {};
  for (const window of windows) {
    const slice = rows.filter((row) => inWindow(row.weekEnding, window));
    const families = new Map();
    const unmapped = [];
    for (const row of slice) {
      let family;
      try {
        family = classifyUrl(row.key).family;
      } catch (error) {
        unmapped.push({ ...row, reason: error.message.replace(/^\[seo-url-taxonomy\] /, '') });
        continue;
      }
      if (!families.has(family)) families.set(family, []);
      families.get(family).push(row);
    }
    const byFamily = {};
    for (const family of PAGE_FAMILIES) {
      const group = families.get(family);
      if (!group) continue;
      byFamily[family] = { ...metrics(group), urls: new Set(group.map((row) => row.key)).size };
    }
    byWindow[window.label] = {
      startDate: window.startDate,
      endDate: window.endDate,
      ...weekCoverage(slice),
      ...metrics(slice),
      byFamily,
      unmapped: {
        ...metrics(unmapped),
        urls: [...groupBy(unmapped, (row) => row.key)]
          .map(([url, group]) => ({
            url: stripScheme(url),
            ...metrics(group),
            reason: stripScheme(group[0].reason),
          }))
          .sort((left, right) => right.impressions - left.impressions
            || left.url.localeCompare(right.url)),
      },
    };
  }
  return {
    method: METHODS.pages,
    availability: 'partial',
    reason: TOP_ROWS_REASON,
    basis: 'top-100-per-week',
    windows: byWindow,
  };
}

function buildCrawl({ rows, reason }) {
  if (rows === null) return unavailable(METHODS.crawl, reason);
  if (rows.length === 0) return unavailable(METHODS.crawl, 'Bing returned no crawl rows');
  const latest = rows.at(-1);
  const fromDate = shiftDate(latest.date, -CRAWL_CHANGE_DAYS);
  const baseline = rows.find((row) => row.date === fromDate) ?? null;
  return {
    method: METHODS.crawl,
    availability: baseline ? 'available' : 'partial',
    reason: baseline ? null : `Bing returned no crawl row for ${fromDate}, so the ${CRAWL_CHANGE_DAYS}-day change is not measured`,
    latest,
    change: baseline
      ? {
        days: CRAWL_CHANGE_DAYS,
        fromDate,
        toDate: latest.date,
        ...Object.fromEntries(
          Object.keys(CRAWL_FIELDS).map((field) => [field, latest[field] - baseline[field]]),
        ),
      }
      : null,
  };
}

export async function collectBingSnapshot({ transport, observedAt }) {
  const raw = {};
  for (const section of Object.keys(METHODS)) {
    raw[section] = await fetchRows(transport, section);
  }
  const failures = Object.values(raw).filter((entry) => entry.rows === null);
  invariant(
    failures.length < Object.keys(METHODS).length,
    `every Bing method failed, so there is no snapshot to write: ${failures.map((entry) => entry.reason).join('; ')}`,
  );

  const { endSource, windows } = deriveWindows(raw);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `bing-${observedAt.slice(0, 10)}`,
    observedAt,
    source: transport.kind,
    site: null,
    windowEndSource: endSource,
    windows: windows.map(({ label, startDate, endDate }) => ({ label, startDate, endDate })),
    traffic: buildTraffic(raw.traffic, windows),
    queries: buildQueries(raw.queries, windows),
    pages: buildPages(raw.pages, windows),
    crawl: buildCrawl(raw.crawl),
    aiPerformance: { method: null, availability: 'unavailable', reason: AI_PERFORMANCE_REASON },
    guardrails: [
      'Totals come only from the daily traffic rows. Query and page sums are top-100-per-week and are never reported as totals.',
      'A position Bing reports as -1 is recorded as null, not as a rank.',
      'The site URL and the API key stay in operator configuration and never reach this file.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Scorecard feed
// ---------------------------------------------------------------------------

/**
 * Shape a snapshot for `sources.bingWebmaster` of
 * `scripts/seo-ai-visibility-collector.mjs`, the way the Search Console
 * collector's `toScorecardSearchExport` does.
 *
 * - Window totals come only from the daily traffic rows, and only for a window
 *   Bing reported every day of: a sum with a missing day is an undercount, so
 *   it is null. `GetRankAndTrafficStats` carries no position, so the site
 *   average position is always null.
 * - `indexedPages` is the latest `InIndex` from `GetCrawlStats`, Bing's count
 *   of the site's pages in its index.
 * - Query and page-family rows are top-100-per-week sums, so the source is
 *   always partial and says so. Query rows exist only for reviewed queries,
 *   matched on exact text, among the top queries per window. Page rows carry no
 *   position or index count.
 * - AI Performance has no API method; its unavailable reason is carried over.
 */
export function toScorecardBingSource(snapshot, { querySet }) {
  const aiPerformance = {
    status: 'unavailable',
    reason: snapshot.aiPerformance?.reason ?? AI_PERFORMANCE_REASON,
  };
  if (snapshot.windows.length === 0) {
    return {
      search: {
        status: 'unavailable',
        reason: 'The Bing snapshot has no window: no traffic, query or page rows were returned.',
      },
      aiPerformance,
    };
  }
  const reviewed = new Set(querySet.queries.map((query) => query.query));
  const { traffic, queries, pages, crawl } = snapshot;
  const latestInIndex = crawl.availability === 'unavailable' ? null : crawl.latest.inIndex;
  const notes = [
    `Query and page-family rows are top-${WEEKLY_ROW_CAP}-per-week sums, not totals; a weekly bucket counts toward a window when the Friday it ends on falls inside it.`,
    `Query rows exist only for reviewed queries that appear with exact text among the top ${MAX_TOP_QUERIES} queries per window; a reviewed query outside that list has no row, which is not a zero.`,
    'Window totals come from the daily traffic rows, which carry no position, so averagePosition is null at the window and page-family level.',
    latestInIndex === null
      ? `indexedPages is null: crawl stats are unavailable (${crawl.reason}).`
      : `indexedPages is Bing's InIndex count on ${crawl.latest.date}; the same count stands in both windows.`,
  ];
  if (traffic.availability === 'unavailable') notes.push(`Window totals are null: daily traffic is unavailable (${traffic.reason}).`);
  for (const section of [queries, pages]) {
    if (section.availability === 'unavailable') notes.push(`${section.method} is unavailable (${section.reason}).`);
  }
  const windows = snapshot.windows.map((window) => {
    const days = Number.parseInt(window.label, 10);
    const daily = traffic.availability === 'unavailable' ? null : traffic.windows[window.label];
    const totals = daily && daily.daysReported === days ? daily : null;
    if (daily && !totals) notes.push(`${window.label}: Bing reported ${daily.daysReported} of ${days} days, so the window totals are null rather than an undercount.`);
    const queryWindow = queries.availability === 'unavailable' ? null : queries.windows[window.label];
    const pageWindow = pages.availability === 'unavailable' ? null : pages.windows[window.label];
    return {
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      impressions: totals ? totals.impressions : null,
      clicks: totals ? totals.clicks : null,
      ctr: totals ? totals.ctr : null,
      position: null,
      indexedPages: latestInIndex,
      queryRows: (queryWindow?.topQueries ?? [])
        .filter((row) => reviewed.has(row.query))
        .map((row) => ({
          query: row.query,
          impressions: row.impressions,
          clicks: row.clicks,
          ctr: row.ctr,
          position: row.avgImpressionPosition,
        })),
      pageFamilyRows: Object.entries(pageWindow?.byFamily ?? {}).map(([pageFamily, row]) => ({
        pageFamily,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: row.ctr,
        position: null,
        indexedPages: null,
      })),
    };
  });
  return {
    search: { status: 'partial', reason: notes.join(' '), windows },
    aiPerformance,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Refuse to write anything that carries the key, the site URL, or a sign that
 * a raw payload was copied rather than picked.
 */
export function assertNoSecrets(serialized, { apiKey = null, siteUrl = BING_SITE_URL } = {}) {
  for (const marker of SECRET_MARKERS) {
    invariant(!serialized.includes(marker), `refusing to write output containing ${marker}`);
  }
  for (const [label, value] of [['the API key', apiKey], ['the site URL', siteUrl]]) {
    if (typeof value !== 'string' || value === '') continue;
    invariant(
      !serialized.includes(value) && !serialized.includes(encodeURIComponent(value)),
      `refusing to write output containing ${label}`,
    );
  }
  return serialized;
}

const position1 = (value) => (value === null ? 'n/a' : value.toFixed(1));
const signed = (value) => (value > 0 ? `+${value}` : String(value));
const unavailableLine = (section) => `Not measured: ${section.reason}`;

function renderTraffic(traffic, lines) {
  lines.push('## Totals');
  lines.push('');
  if (traffic.availability === 'unavailable') {
    lines.push(unavailableLine(traffic));
    lines.push('');
    return;
  }
  lines.push('Daily site totals from `GetRankAndTrafficStats`, the only complete source.');
  if (traffic.reason) lines.push(`Partial: ${traffic.reason}`);
  lines.push('');
  lines.push('| Window | Dates | Days reported | Impressions | Clicks | CTR |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const [label, window] of Object.entries(traffic.windows)) {
    lines.push(`| ${label} | ${window.startDate} to ${window.endDate} | ${window.daysReported} | ${window.impressions} | ${window.clicks} | ${percent(window.ctr)} |`);
  }
  lines.push('');
  lines.push('### Seven-day trend');
  lines.push('');
  lines.push('Rolling seven-day periods ending on the latest date, not Monday-to-Sunday weeks. Days counts the dates Bing returned, and the oldest period can fall partly outside the 90-day window.');
  lines.push('');
  lines.push('| Period | Days | Impressions | Clicks | CTR |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const week of traffic.weeklyTrend) {
    lines.push(`| ${week.startDate} to ${week.endDate} | ${week.days} | ${number(week.impressions)} | ${number(week.clicks)} | ${percent(week.ctr)} |`);
  }
  lines.push('');
}

const weeksLabel = (window) => (window.weeks === 0
  ? 'no weekly buckets'
  : `${window.weeks} weekly buckets ending ${window.firstWeekEnding} to ${window.lastWeekEnding}, ${window.weeksAtRowCap} at the ${WEEKLY_ROW_CAP}-row cap`);

function renderQueries(queries, primaryLabel, lines) {
  lines.push('## Queries (top 100 per week, not totals)');
  lines.push('');
  if (queries.availability === 'unavailable') {
    lines.push(unavailableLine(queries));
    lines.push('');
    return;
  }
  lines.push(`${queries.reason} A bucket counts toward a window when the Friday it ends on falls inside the window, so its first days can precede the window start.`);
  lines.push('');
  lines.push('| Window | Buckets | Brand impressions | Brand clicks | Non-brand impressions | Non-brand clicks |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const [label, window] of Object.entries(queries.windows)) {
    lines.push(`| ${label} | ${weeksLabel(window)} | ${window.brand.impressions} | ${window.brand.clicks} | ${window.nonBrand.impressions} | ${window.nonBrand.clicks} |`);
  }
  lines.push('');
  const primary = queries.windows[primaryLabel];
  if (!primary || primary.topQueries.length === 0) return;
  lines.push(`### Top queries (${primaryLabel}, top 100 per week)`);
  lines.push('');
  lines.push('| Query | Brand | Impressions | Clicks | CTR | Position |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const row of primary.topQueries) {
    lines.push(`| ${queryCell(row.query)} | ${row.brand ? 'yes' : 'no'} | ${row.impressions} | ${row.clicks} | ${percent(row.ctr)} | ${position1(row.avgImpressionPosition)} |`);
  }
  lines.push('');
}

function renderPages(pages, primaryLabel, lines) {
  lines.push(`## Page families (${primaryLabel}, top 100 per week)`);
  lines.push('');
  if (pages.availability === 'unavailable') {
    lines.push(unavailableLine(pages));
    lines.push('');
    return;
  }
  const primary = pages.windows[primaryLabel];
  if (!primary) return;
  lines.push(`${pages.reason} ${weeksLabel(primary)}.`);
  lines.push('');
  lines.push('| Family | URLs | Impressions | Clicks | CTR |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const [family, row] of Object.entries(primary.byFamily)) {
    lines.push(`| ${family} | ${row.urls} | ${row.impressions} | ${row.clicks} | ${percent(row.ctr)} |`);
  }
  lines.push('');
  if (primary.unmapped.urls.length > 0) {
    lines.push('### URLs outside every family');
    lines.push('');
    lines.push(`${primary.unmapped.urls.length} URLs, ${primary.unmapped.impressions} impressions, ${primary.unmapped.clicks} clicks. They count in the window sums above. Give each recurring one a family.`);
    lines.push('');
    for (const row of primary.unmapped.urls) {
      lines.push(`- \`${row.url}\`: ${row.impressions} impressions, ${row.clicks} clicks (${markdownCell(row.reason)})`);
    }
    lines.push('');
  }
}

function renderCrawl(crawl, lines) {
  lines.push('## Crawl and index');
  lines.push('');
  if (crawl.availability === 'unavailable') {
    lines.push(unavailableLine(crawl));
    lines.push('');
    return;
  }
  if (crawl.reason) lines.push(`Partial: ${crawl.reason}.`);
  else lines.push(`Latest daily row against the row ${CRAWL_CHANGE_DAYS} days earlier (${crawl.change.fromDate}).`);
  lines.push('');
  lines.push(`| Metric | ${crawl.latest.date} | Change over ${CRAWL_CHANGE_DAYS} days |`);
  lines.push('|---|---:|---:|');
  for (const field of Object.keys(CRAWL_FIELDS)) {
    lines.push(`| ${field} | ${crawl.latest[field]} | ${crawl.change ? signed(crawl.change[field]) : 'n/a'} |`);
  }
  lines.push('');
}

export function renderBingMarkdown(snapshot) {
  const primaryLabel = snapshot.windows[0]?.label ?? null;
  const lines = [];
  lines.push(`# Bing Webmaster snapshot ${snapshot.observedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`Source: \`${snapshot.source}\`. Site identifier: withheld.`);
  lines.push(snapshot.windowEndSource
    ? `Windows end on ${snapshot.windows[0].endDate}, the latest date \`${snapshot.windowEndSource}\` reports.`
    : 'No window could be derived: no traffic, query or page rows were returned.');
  lines.push('');
  lines.push('| Section | Method | Availability |');
  lines.push('|---|---|---|');
  for (const name of ['traffic', 'queries', 'pages', 'crawl', 'aiPerformance']) {
    const section = snapshot[name];
    lines.push(`| ${name} | ${section.method ? `\`${section.method}\`` : 'none'} | ${section.availability} |`);
  }
  lines.push('');
  renderTraffic(snapshot.traffic, lines);
  renderQueries(snapshot.queries, primaryLabel, lines);
  renderPages(snapshot.pages, primaryLabel, lines);
  renderCrawl(snapshot.crawl, lines);
  lines.push('## AI Performance');
  lines.push('');
  lines.push(unavailableLine(snapshot.aiPerformance));
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    fixtures: null,
    live: false,
    outDir: 'docs/research/seo-ai-visibility/bing',
    date: null,
    stdout: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      invariant(value !== undefined && !value.startsWith('--'), `${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--fixtures': options.fixtures = next(); break;
      case '--live': options.live = true; break;
      case '--out-dir': options.outDir = next(); break;
      case '--date': options.date = next(); break;
      case '--stdout': options.stdout = true; break;
      default: throw new Error(`[seo-bing] unknown argument ${flag}`);
    }
  }
  invariant(options.fixtures !== null || options.live, 'pass --fixtures <dir> or --live');
  invariant(
    !(options.fixtures !== null && options.live),
    '--fixtures and --live are mutually exclusive',
  );
  invariant(
    options.date === null || /^\d{4}-\d{2}-\d{2}$/.test(options.date),
    '--date must be YYYY-MM-DD',
  );
  return options;
}

export async function runCli(argv, { env = process.env, log = console.log, now = Date.now } = {}) {
  const options = parseArgs(argv);

  let transport;
  let observedAt;
  let apiKey = null;
  if (options.fixtures) {
    transport = createFixtureTransport(resolve(REPO_ROOT, options.fixtures));
    observedAt = transport.manifest.recordedAt;
    invariant(
      typeof observedAt === 'string' && observedAt !== '',
      'the fixture manifest must record recordedAt so the run is deterministic',
    );
  } else {
    loadEnvFile(import.meta.url, { only: ['BING_WEBMASTER_API_KEY'] });
    apiKey = env.BING_WEBMASTER_API_KEY;
    invariant(
      typeof apiKey === 'string' && apiKey.trim() !== '',
      'BING_WEBMASTER_API_KEY is not set. Generate it in Bing Webmaster Tools, Settings, API access, and store it in .env.local.',
    );
    transport = createLiveTransport({ apiKey: apiKey.trim() });
    observedAt = new Date(now()).toISOString();
  }

  const snapshot = await collectBingSnapshot({ transport, observedAt });
  const date = options.date ?? observedAt.slice(0, 10);
  const json = assertNoSecrets(`${JSON.stringify(snapshot, null, 2)}\n`, { apiKey });
  const markdown = assertNoSecrets(renderBingMarkdown(snapshot), { apiKey });

  if (options.stdout) {
    log(json);
    return { snapshot, markdown, written: [] };
  }

  const outDir = resolve(REPO_ROOT, options.outDir);
  mkdirSync(outDir, { recursive: true });
  const written = [join(outDir, `${date}.json`), join(outDir, `${date}.md`)];
  writeFileSync(written[0], json);
  writeFileSync(written[1], markdown);
  log(`[seo-bing] wrote ${written.map((path) => path.replace(`${REPO_ROOT}/`, '')).join(', ')}`);
  return { snapshot, markdown, written };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
