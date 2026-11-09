#!/usr/bin/env node

/**
 * Collect per-URL index state and per-family search performance from the
 * Google Search Console API, and write a dated snapshot plus a markdown
 * summary next to the reviewed scorecard baselines.
 *
 * Contract, mirrored from `scripts/seo-ai-visibility-collector.mjs`:
 *
 * - named fields are picked out of each API response, never copied wholesale.
 *   `inspectionResult.inspectionResultLink` embeds the property identifier, so
 *   copying a payload would publish it;
 * - a missing value stays `null` and carries a reason. It never becomes zero,
 *   because zero is a measurement and "we could not ask" is not;
 * - credentials arrive only through `loadEnvFile()` and are never printed, and
 *   the writer refuses to emit a snapshot that contains one.
 *
 * Three reporting rules exist because the 2026-09-24 hand-parse showed a
 * report without them is actively misleading:
 *
 * 1. Every URL carries a `kind` as well as a family. 61% of the
 *    "Crawled, currently not indexed" population was `/docs/_next/*` render
 *    assets already serving `noindex`; a headline that counts them moves on
 *    Mintlify redeploys rather than on anything we control. HTML indexability
 *    is reported on its own.
 * 2. A live probe status sits next to Google `coverageState` and disagreement
 *    is flagged, never resolved silently. 428 of 666 reported 404s already
 *    redirected on export day.
 * 3. Every URL carries its host. The apex and the variant dashboards are all
 *    in the Domain property, so per-family denominators that ignore the host
 *    are wrong.
 *
 * Search totals come in two bases and are never mixed. Rows grouped by page
 * count a search once per URL it shows; `siteTotals` and the daily series are
 * requested by property and count it once, as the performance chart does.
 * Both are split into brand and non-brand with `BRAND_QUERY_PATTERN`.
 *
 * And one arithmetic rule: a sampled share is never multiplied up into a
 * reported total. Google caps its example URL exports at 1,000 rows with
 * unspecified ordering, so only an export whose row count equals its reported
 * total is complete. Everything derived from a capped export is labelled.
 *
 * Usage:
 *   node scripts/seo-gsc-collect.mjs --fixtures tests/fixtures/gsc/
 *   node scripts/seo-gsc-collect.mjs --live
 *
 * Options:
 *   --fixtures <dir>      read recorded API responses instead of calling Google
 *   --live                call the API using GSC_SERVICE_ACCOUNT_JSON
 *   --out-dir <dir>       snapshot directory (default docs/research/seo-ai-visibility/gsc)
 *   --date <YYYY-MM-DD>   snapshot date (default the observation date)
 *   --search-export <p>   also write the scorecard search-export for
 *                         scripts/seo-ai-visibility-collector.mjs
 *   --query-set <path>    reviewed queries to look up (default
 *                         docs/research/seo-ai-visibility/query-set.json)
 *   --sample-cap <n>      urlInspection calls per run (default 2000, the quota)
 *   --concurrency <n>     inspections in flight at once (default 5, max 10)
 *   --stdout              print the snapshot instead of writing files
 */

import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';
import {
  HOST_CLASSES,
  URL_KINDS,
  classifyUrl,
  kindForContentType,
  robotsTagBlocksIndexing,
  sitemapUrls,
} from './lib/seo-url-taxonomy.mjs';
import { PAGE_FAMILIES, computeQuerySetDigest } from './seo-ai-visibility-scorecard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEARCH_ANALYTICS_ENDPOINT = 'https://searchconsole.googleapis.com/webmasters/v3/sites';
const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/** searchanalytics.query caps a page at 25,000 rows. */
const SEARCH_ANALYTICS_ROW_LIMIT = 25_000;
/** urlInspection.index.inspect is quota-limited to 2,000 calls a day. */
const DEFAULT_SAMPLE_CAP = 2_000;
/**
 * An inspection takes about 6.6 s (measured 2026-09-25), so 888 sequential
 * calls run past the workflow's 60-minute limit. Five in flight stays far
 * under the 600-per-minute quota and keeps the probes gentle on Mintlify,
 * which answered 502 to 24 concurrent requests.
 */
const DEFAULT_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = Object.freeze({ api: 60_000, sitemap: 30_000, probe: 20_000 });
/** Delays between attempts; four attempts in total. */
const RETRY_DELAYS_MS = Object.freeze([2_000, 8_000, 30_000]);
const MAX_PAGES_PER_WINDOW = 40;
const MAX_URLS_PER_LIST = 5;
const MAX_FLAGGED_URLS = 50;
const MAX_TOP_QUERIES = 20;
const MAX_NON_BRAND_QUERIES = 500;
const MAX_LOW_CLICK_QUERIES_IN_SUMMARY = 30;
const LOW_CLICK_CTR = 0.05;
/**
 * This repository is public, so a query needs real volume before its text is
 * committed. Rarer ones still count toward the summary.
 */
const MIN_LISTED_QUERY_IMPRESSIONS = 20;
/**
 * In October 2026 "kerch strait" and "korea strait" took 25,000 impressions at
 * 97-98% desktop and never one click, while queries people clearly search sat
 * at 20-44% desktop. Rank trackers fit that shape. Search Console cannot name
 * who searched, so this stays a labelled inference.
 */
const LIKELY_AUTOMATED = Object.freeze({ minImpressions: 200, minDesktopShare: 0.9, clicks: 0 });
const MAX_SITEMAP_DOCUMENTS = 50;
const SNAPSHOT_SCHEMA_VERSION = 1;
const PAGE_FAMILY_SCHEMA_VERSION = 2;

const WINDOW_DAYS = Object.freeze({ '28d': 28, '90d': 90 });

/**
 * Queries that name World Monitor itself, including the misspellings and the
 * Japanese name that reach the top of the query report. Everything else is
 * non-brand: the searches the corpus pages exist to win. "war monitor" and
 * "monitor the situation" are generic and stay non-brand.
 *
 * One pattern serves both sides. Search Console evaluates it as RE2 with a
 * `(?i)` prefix, and the snapshot classifies its own top queries with the same
 * source compiled as a case-insensitive JavaScript RegExp, so the two can
 * never drift. It uses only syntax the two engines share.
 */
/**
 * The second alternative takes the misspellings Bing reported on 2026-11-02
 * (moniter, montior, monitar, monotor, moniteur and so on). A vowel cluster or
 * "in"/"ti" sits on at least one side of the `t`, which keeps "monetary" and
 * "montreal" out, and requiring a non-letter (any script) or the end after it
 * keeps "monterrey" and "montería" out while still accepting `_`, `.` and spaces.
 * The first alternative stays unbounded so every query it matched before
 * (worldmonitorapp, world monitoring) is still brand.
 */
export const BRAND_QUERY_PATTERN = '(world|word|wolrd|wrold)[ ._-]*monitor|(world|word|wolrd|wrold|worl|wold|wordl)[ ._-]*mon((i|o|a|in|ti)t(o|e|i|a|io|oe|eu|p)?|t(o|e|i|a|io|oe|eu|p))r(o|s|ing)?(app)?(\\P{L}|$)|ワールドモニター';
const BRAND_QUERY_REGEX = new RegExp(BRAND_QUERY_PATTERN, 'iu');
export const isBrandQuery = (query) => BRAND_QUERY_REGEX.test(String(query ?? ''));
const BRAND_FILTER_EXPRESSION = `(?i)${BRAND_QUERY_PATTERN}`;
const queryFilter = (operator) => ({
  groupType: 'and',
  filters: [{ dimension: 'query', operator, expression: BRAND_FILTER_EXPRESSION }],
});

/**
 * The Search Analytics views collected for every window, besides the existing
 * `page` and `query` rows.
 *
 * Google aggregates a page-grouped query by URL: one search that shows the
 * homepage, three of its sitelinks and `/pro` counts five impressions, one per
 * URL. The UI performance chart aggregates by property and counts it once. So
 * the sum of page rows is not the site total, and on 2026-09-25 it came out
 * about twice the chart. `site` asks for the by-property total directly.
 *
 * A query filter excludes anonymized queries, so `site` minus `siteBrand` minus
 * `siteNonBrand` is the anonymized remainder rather than a rounding error, and
 * `pageNonBrand` is non-brand traffic Google attributes to a query.
 */
const SITE_VIEWS = Object.freeze({
  site: { dimensions: [], filter: null },
  siteBrand: { dimensions: [], filter: 'includingRegex' },
  siteNonBrand: { dimensions: [], filter: 'excludingRegex' },
  daily: { dimensions: ['date'], filter: null },
  dailyNonBrand: { dimensions: ['date'], filter: 'excludingRegex' },
});
const PAGE_NON_BRAND_VIEW = 'pageNonBrand';
const QUERY_DEVICE_VIEW = 'queryNonBrandDevice';
const QUERY_PAGE_VIEW = 'queryNonBrandPage';

/**
 * Reviewed queries are looked up one at a time rather than matched against
 * the top queries: in every snapshot from 2026-09-25 to 2026-11-03 none of
 * the 25 reached the top 20.
 *
 * Probed live on 2026-11-09: `equals` ignores case ("World Monitor" and
 * "WORLD MONITOR" both return the row keyed "world monitor") but not spacing
 * (a leading or doubled space returns nothing). The expression is therefore
 * the reviewed text trimmed, with inner whitespace collapsed, and lowercased
 * to the form Google stores.
 */
const REVIEWED_QUERY_OPERATOR = 'equals';
const REVIEWED_QUERY_ROW_LIMIT = 10;
export const reviewedQueryExpression = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();
/**
 * Google answers a lookup with no row both for a query nobody searched and
 * for an anonymized one under its privacy threshold. Neither is a zero.
 */
export const NOT_REPORTED_REASON = 'Not reported by Search Console: below its privacy threshold or no impressions in this window.';
const VIEW_REQUESTS = Object.freeze({
  page: { dimensions: ['page'], filter: null },
  query: { dimensions: ['query'], filter: null },
  [PAGE_NON_BRAND_VIEW]: { dimensions: ['page'], filter: 'excludingRegex' },
  [QUERY_DEVICE_VIEW]: { dimensions: ['query', 'device'], filter: 'excludingRegex' },
  [QUERY_PAGE_VIEW]: { dimensions: ['query', 'page'], filter: 'excludingRegex' },
  ...SITE_VIEWS,
});

/**
 * Coverage states Google reports for a URL it crawled and chose not to index,
 * and for one it knows about but has not crawled yet. They are kept apart: the
 * first is a verdict on the page, the second only a queue position, and
 * counting them together overstated declined pages by 5x on 2026-09-25.
 * Matched case-insensitively on a normalized string because the API returns
 * display text rather than an enum.
 */
const CRAWLED_NOT_INDEXED_STATES = Object.freeze([
  'crawled - currently not indexed',
  'crawled currently not indexed',
]);
const DISCOVERED_NOT_CRAWLED_STATES = Object.freeze([
  'discovered - currently not indexed',
  'discovered currently not indexed',
]);
const INDEXED_VERDICT = 'PASS';

const SECRET_MARKERS = Object.freeze([
  'private_key',
  'private_key_id',
  'client_email',
  'client_secret',
  'BEGIN PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  'refresh_token',
  'access_token',
  'inspectionResultLink',
  'sc-domain:',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-gsc] ${message}`);
}

class QuotaExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

const normalizeState = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/–|—/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const isCrawledNotIndexed = (coverageState) => (
  CRAWLED_NOT_INDEXED_STATES.includes(normalizeState(coverageState))
);
const isDiscoveredNotCrawled = (coverageState) => (
  DISCOVERED_NOT_CRAWLED_STATES.includes(normalizeState(coverageState))
);

const finite = (value) => (Number.isFinite(value) ? value : null);
const roundTo = (value, digits) => (
  value === null ? null : Number(value.toFixed(digits))
);

/**
 * A ratio that always says what it was measured over.
 *
 * `basis` names the denominator the ratio was measured over, so a reader can
 * never mistake an inspected-sample share for a population share.
 * `extrapolated` is always false: this collector does not multiply a sampled
 * share up to a reported total, and the field exists so that stays visible
 * rather than implicit.
 */
function share(numerator, denominator, basis) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return {
      value: null,
      numerator: Number.isFinite(numerator) ? numerator : null,
      denominator: Number.isFinite(denominator) ? denominator : null,
      basis,
      extrapolated: false,
      reason: 'no denominator was measured',
    };
  }
  return {
    value: roundTo(numerator / denominator, 4),
    numerator,
    denominator,
    basis,
    extrapolated: false,
    reason: null,
  };
}

function finalizeMetrics(accumulator) {
  const { clicks, impressions, positionWeight, positionTotal, urls } = accumulator;
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? roundTo(clicks / impressions, 4) : null,
    averagePosition: positionWeight > 0 ? roundTo(positionTotal / positionWeight, 2) : null,
    urls,
  };
}

const newAccumulator = () => ({
  clicks: 0,
  impressions: 0,
  positionTotal: 0,
  positionWeight: 0,
  urls: 0,
});

function addRow(accumulator, row) {
  accumulator.clicks += row.clicks;
  accumulator.impressions += row.impressions;
  if (row.position !== null && row.impressions > 0) {
    accumulator.positionTotal += row.position * row.impressions;
    accumulator.positionWeight += row.impressions;
  }
  accumulator.urls += 1;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Decode the service-account key.
 *
 * The variable holds base64 so a PEM newline cannot break a `.env.local` line.
 * A raw JSON value is accepted too, because that is what a first attempt
 * usually produces and failing on it teaches nothing.
 */
export function decodeServiceAccount(rawValue) {
  invariant(
    typeof rawValue === 'string' && rawValue.trim() !== '',
    'GSC_SERVICE_ACCOUNT_JSON is empty',
  );
  const trimmed = rawValue.trim();
  const decoded = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('[seo-gsc] GSC_SERVICE_ACCOUNT_JSON is not base64-encoded JSON');
  }
  for (const field of ['client_email', 'private_key']) {
    invariant(
      typeof parsed[field] === 'string' && parsed[field] !== '',
      `GSC_SERVICE_ACCOUNT_JSON is missing ${field}`,
    );
  }
  return parsed;
}

const base64Url = (value) => Buffer.from(value).toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

export function createServiceAccountAssertion(serviceAccount, { nowSeconds, scope = SEARCH_CONSOLE_SCOPE }) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(serviceAccount.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${claims}.${signature}`;
}

async function requestAccessToken(serviceAccount, { fetchImpl = fetch, nowSeconds }) {
  const assertion = createServiceAccountAssertion(serviceAccount, { nowSeconds });
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  // The body can echo the assertion back in an error, so only the status is
  // ever surfaced.
  invariant(response.ok, `token exchange failed with HTTP ${response.status}`);
  const payload = await response.json();
  invariant(
    typeof payload?.access_token === 'string' && payload.access_token !== '',
    'token exchange returned no access token',
  );
  return payload.access_token;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Replay recorded API responses.
 *
 * The manifest names each recorded page, so pagination, a quota-exhausted
 * response and a canonical mismatch are all exercised by data rather than by a
 * flag that only the test sets.
 */
export function createFixtureTransport(directory) {
  const root = resolve(directory);
  const manifest = readJson(join(root, 'manifest.json'));
  const rowLimit = manifest.rowLimit ?? SEARCH_ANALYTICS_ROW_LIMIT;
  const inspections = manifest.urlInspection
    ? readJson(join(root, manifest.urlInspection))
    : {};
  const probes = manifest.liveProbes ? readJson(join(root, manifest.liveProbes)) : {};

  const readRecorded = (file) => {
    const payload = readJson(join(root, file));
    if (payload?.error) {
      const code = payload.error.code ?? 0;
      if (code === 429) {
        throw new QuotaExhaustedError(payload.error.message ?? 'quota exhausted');
      }
      throw new Error(`[seo-gsc] recorded response ${file} failed with HTTP ${code}`);
    }
    return payload;
  };

  return {
    kind: 'fixtures',
    manifest,
    rowLimit,
    sitemaps: () => (manifest.sitemaps ?? []).map((entry) => ({
      url: entry.url,
      xml: readFileSync(join(root, entry.file), 'utf8'),
    })),
    // An unrecorded view answers null, which the collector reports as not
    // measured. An empty recording is a real zero.
    async searchAnalytics({ windowLabel, dimension, page }) {
      const pages = manifest.searchAnalytics?.[windowLabel]?.[dimension];
      if (pages === undefined) return null;
      if (page >= pages.length) return { rows: [] };
      return readRecorded(pages[page]);
    },
    // Recorded by window and the expression actually sent, so a fixture keyed
    // by the lowercased text also proves the reviewed text was normalized.
    async lookupQuery({ windowLabel, expression }) {
      const file = manifest.reviewedQueries?.[windowLabel]?.[expression];
      return file === undefined ? null : readRecorded(file);
    },
    async inspect(url) {
      const recorded = inspections[url];
      if (recorded === undefined) return null;
      if (recorded?.error) {
        const code = recorded.error.code ?? 0;
        if (code === 429) throw new QuotaExhaustedError(recorded.error.message ?? 'quota exhausted');
        throw new Error(`[seo-gsc] recorded inspection for a URL failed with HTTP ${code}`);
      }
      return recorded;
    },
    async probe(url) {
      return probes[url] ?? null;
    },
  };
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** True when a 429 body names the daily quota, which no backoff can recover. */
async function isDailyQuota(response) {
  try {
    const payload = await response.json();
    return /per day|daily/i.test(String(payload?.error?.message ?? ''));
  } catch {
    return false;
  }
}

export function createLiveTransport({ accessToken, property, fetchImpl = fetch, sleep = defaultSleep }) {
  const authorized = (extra = {}) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    ...extra,
  });
  const attempts = RETRY_DELAYS_MS.length + 1;

  // The endpoint path carries the property identifier, so neither the URL nor
  // the response body ever reaches an error message.
  const post = async (endpoint, body) => {
    let failure = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2]);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: authorized(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS.api),
        });
      } catch (error) {
        failure = error?.name ?? 'network error';
        continue;
      }
      if (response.ok) return response.json();
      if (response.status === 429) {
        if (await isDailyQuota(response)) {
          throw new QuotaExhaustedError('Search Console daily quota is exhausted (HTTP 429)');
        }
        failure = 'HTTP 429';
        continue;
      }
      await response.body?.cancel().catch(() => {});
      invariant(response.status >= 500, `Search Console request failed with HTTP ${response.status}`);
      failure = `HTTP ${response.status}`;
    }
    if (failure === 'HTTP 429') {
      throw new QuotaExhaustedError(`Search Console returned HTTP 429 after ${attempts} attempts`);
    }
    throw new Error(`[seo-gsc] Search Console request failed with ${failure} after ${attempts} attempts`);
  };

  return {
    kind: 'search-console-api',
    rowLimit: SEARCH_ANALYTICS_ROW_LIMIT,
    // Follows a sitemap index down to its children. The blog sitemap is an
    // index, so stopping at the top level would silently drop every post from
    // the inventory and report the blog family as undeclared.
    async sitemaps(urls) {
      const documents = [];
      const seen = new Set();
      const queue = [...urls];
      while (queue.length > 0 && documents.length < MAX_SITEMAP_DOCUMENTS) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        const response = await fetchImpl(url, {
          headers: { accept: 'application/xml' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS.sitemap),
        });
        invariant(response.ok, `sitemap fetch failed with HTTP ${response.status}`);
        const xml = await response.text();
        documents.push({ url, xml });
        if (/<sitemapindex[\s>]/.test(xml)) queue.push(...sitemapUrls(xml));
      }
      invariant(
        queue.length === 0,
        `sitemap expansion exceeded the ${MAX_SITEMAP_DOCUMENTS}-document limit`,
      );
      return documents;
    },
    // `windowLabel` selects the recording in the fixture transport; live calls
    // carry the dates instead, so the parameter is accepted and ignored to keep
    // one call shape across both.
    async searchAnalytics({ dimension, page, startDate, endDate }) {
      const endpoint = `${SEARCH_ANALYTICS_ENDPOINT}/${encodeURIComponent(property)}/searchAnalytics/query`;
      const request = VIEW_REQUESTS[dimension];
      invariant(request, `unknown Search Analytics view ${dimension}`);
      return post(endpoint, {
        startDate,
        endDate,
        dimensions: request.dimensions,
        ...(request.filter ? { dimensionFilterGroups: [queryFilter(request.filter)] } : {}),
        rowLimit: SEARCH_ANALYTICS_ROW_LIMIT,
        startRow: page * SEARCH_ANALYTICS_ROW_LIMIT,
        dataState: 'final',
      });
    },
    // Grouped by query on purpose: with no dimension Google answers a query it
    // never saw with a zero row, and grouped it answers with no row at all.
    async lookupQuery({ expression, startDate, endDate }) {
      return post(`${SEARCH_ANALYTICS_ENDPOINT}/${encodeURIComponent(property)}/searchAnalytics/query`, {
        startDate,
        endDate,
        dimensions: ['query'],
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [{ dimension: 'query', operator: REVIEWED_QUERY_OPERATOR, expression }],
        }],
        rowLimit: REVIEWED_QUERY_ROW_LIMIT,
        dataState: 'final',
      });
    },
    async inspect(url) {
      return post(URL_INSPECTION_ENDPOINT, {
        inspectionUrl: url,
        siteUrl: property,
      });
    },
    async probe(url) {
      // GET rather than HEAD: some origins answer HEAD from a different path
      // and would report a content-type the crawler never sees. `manual`
      // keeps the first hop, which is the hop Google recorded.
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS.probe),
      });
      // Only the headers are needed. Cancelling the body releases the socket
      // instead of holding it until garbage collection.
      await response.body?.cancel().catch(() => {});
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        xRobotsTag: response.headers.get('x-robots-tag'),
        location: response.headers.get('location'),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * Expand sitemap documents into a classified URL inventory.
 *
 * A sitemap index contributes its children rather than itself, and an unmapped
 * URL stops the run. A catch-all bucket is exactly what made the 2026-09-24
 * coverage read unusable.
 */
export function buildInventory(documents) {
  const byUrl = new Map();
  const sitemaps = [];
  for (const { url, xml } of documents) {
    const locations = sitemapUrls(xml);
    const isIndex = /<sitemapindex[\s>]/.test(xml);
    sitemaps.push({
      url,
      kind: isIndex ? 'index' : 'urlset',
      urlCount: isIndex ? 0 : locations.length,
      childCount: isIndex ? locations.length : 0,
    });
    if (isIndex) continue;
    for (const location of locations) {
      if (byUrl.has(location)) continue;
      byUrl.set(location, classifyUrl(location));
    }
  }
  const urls = [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
  return { sitemaps, urls };
}

/**
 * Pick the URLs to inspect.
 *
 * Round-robin across families so every family is represented before any family
 * gets a second slot. A proportional sample would spend the whole quota on
 * `/countries/`, which is 197 of the root sitemap alone, and tell us nothing
 * about the families the tracker is actually asking about.
 */
export function stratifiedSample(urls, cap) {
  const byFamily = new Map();
  for (const entry of urls) {
    const bucket = byFamily.get(entry.family) ?? [];
    bucket.push(entry);
    byFamily.set(entry.family, bucket);
  }
  const families = [...byFamily.keys()].sort();
  const picked = [];
  let round = 0;
  let added = true;
  while (picked.length < cap && added) {
    added = false;
    for (const family of families) {
      if (picked.length >= cap) break;
      const bucket = byFamily.get(family);
      if (round >= bucket.length) continue;
      picked.push(bucket[round]);
      added = true;
    }
    round += 1;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Verdicts Google documents as an outcome. `VERDICT_UNSPECIFIED` means the
 * outcome is unknown, so it is no measurement at all, not a "not indexed".
 */
const KNOWN_VERDICTS = new Set(['PASS', 'PARTIAL', 'FAIL', 'NEUTRAL']);

/** Pick the named index-status fields. Never copy the payload. */
export function pickIndexStatus(response) {
  const status = response?.inspectionResult?.indexStatusResult;
  if (!status || typeof status !== 'object') return null;
  if (!KNOWN_VERDICTS.has(status.verdict)) return null;
  const asString = (value) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    verdict: asString(status.verdict),
    coverageState: asString(status.coverageState),
    indexingState: asString(status.indexingState),
    robotsTxtState: asString(status.robotsTxtState),
    pageFetchState: asString(status.pageFetchState),
    lastCrawlTime: asString(status.lastCrawlTime),
    googleCanonical: asString(status.googleCanonical),
    userCanonical: asString(status.userCanonical),
  };
}

function normalizeProbe(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      status: null,
      contentType: null,
      xRobotsTag: null,
      location: null,
      reason: 'no live probe was recorded for this URL',
    };
  }
  return {
    status: Number.isFinite(raw.status) ? raw.status : null,
    contentType: typeof raw.contentType === 'string' ? raw.contentType : null,
    xRobotsTag: typeof raw.xRobotsTag === 'string' ? raw.xRobotsTag : null,
    location: typeof raw.location === 'string' ? raw.location : null,
    reason: Number.isFinite(raw.status) ? null : 'the live probe returned no status',
  };
}

/**
 * Describe how Google's recorded state and today's live response disagree.
 *
 * Returns null when they agree or when there is not enough evidence. The
 * disagreement is recorded, never resolved: a trend line built on
 * `coverageState` alone reports defects that were fixed before the export.
 */
export function describeDisagreement(indexStatus, probe) {
  if (!indexStatus || probe.status === null) return null;
  const state = normalizeState(indexStatus.coverageState);
  const live = probe.status;
  if (state.includes('not found') || state.includes('404')) {
    if (live >= 300 && live < 400) return 'google-recorded-404-live-redirects';
    if (live >= 200 && live < 300) return 'google-recorded-404-live-serves-200';
  }
  if (state.includes('redirect') && live >= 200 && live < 300) {
    return 'google-recorded-redirect-live-serves-200';
  }
  if (indexStatus.verdict === INDEXED_VERDICT && live >= 400) {
    return 'google-recorded-indexed-live-errors';
  }
  if (isCrawledNotIndexed(indexStatus.coverageState)
    && robotsTagBlocksIndexing(probe.xRobotsTag)) {
    return 'google-recorded-crawled-not-indexed-live-serves-noindex';
  }
  return null;
}

async function probeOrReason(transport, url) {
  try {
    return normalizeProbe(await transport.probe(url));
  } catch (error) {
    return { ...normalizeProbe(null), reason: `the live probe failed: ${error?.name ?? 'error'}` };
  }
}

async function inspectOne(transport, entry) {
  let response = null;
  let inspectionError = null;
  try {
    response = await transport.inspect(entry.url);
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw error;
    inspectionError = error?.message ?? String(error);
  }
  const indexStatus = pickIndexStatus(response);
  const probe = await probeOrReason(transport, entry.url);
  return {
    url: entry.url,
    family: entry.family,
    kind: entry.kind,
    host: entry.host,
    hostClass: entry.hostClass,
    indexStatus,
    indexStatusReason: indexStatus
      ? null
      : (inspectionError
        ? `urlInspection failed: ${inspectionError}`
        : 'urlInspection returned no index status for this URL'),
    inspectionError,
    probe,
    observedKind: kindForContentType(probe.contentType),
    noindex: robotsTagBlocksIndexing(probe.xRobotsTag),
    disagreement: describeDisagreement(indexStatus, probe),
  };
}

/**
 * Inspect the sample with a bounded pool. Records keep sample order, so the
 * snapshot stays deterministic whatever order the calls finish in. One URL's
 * failure is recorded against that URL; only the daily quota stops the pool.
 */
async function collectIndexation(transport, inventory, { sampleCap, concurrency }) {
  const sample = stratifiedSample(inventory.urls, sampleCap);
  const slots = new Array(sample.length);
  let next = 0;
  let quotaError = null;
  const worker = async () => {
    while (quotaError === null && next < sample.length) {
      const index = next;
      next += 1;
      try {
        slots[index] = await inspectOne(transport, sample[index]);
      } catch (error) {
        if (!(error instanceof QuotaExhaustedError)) throw error;
        quotaError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, worker));
  const records = slots.filter(Boolean);
  const quotaReason = quotaError
    ? `urlInspection quota was exhausted after ${records.length} of ${sample.length} URLs: ${quotaError.message}`
    : null;
  return { sample, records, quotaReason };
}

async function collectPagedRows(transport, window, dimension) {
  const rows = [];
  let truncationReason = null;
  let recorded = true;
  for (let page = 0; page < MAX_PAGES_PER_WINDOW; page += 1) {
    let response;
    try {
      response = await transport.searchAnalytics({
        windowLabel: window.label,
        dimension,
        page,
        startDate: window.startDate,
        endDate: window.endDate,
      });
    } catch (error) {
      if (error instanceof QuotaExhaustedError) {
        truncationReason = `searchanalytics quota was exhausted after ${rows.length} ${dimension} rows: ${error.message}`;
        // Nothing was measured, so the view is absent rather than empty.
        if (page === 0) recorded = false;
        break;
      }
      throw error;
    }
    if (response === null && page === 0) {
      recorded = false;
      break;
    }
    const returned = Array.isArray(response?.rows) ? response.rows : [];
    for (const row of returned) {
      const key = Array.isArray(row.keys) ? row.keys[0] : null;
      if (typeof key !== 'string' || key === '') continue;
      rows.push({
        key,
        secondKey: row.keys[1] ?? null,
        clicks: finite(row.clicks) ?? 0,
        impressions: finite(row.impressions) ?? 0,
        position: finite(row.position),
      });
    }
    if (returned.length < transport.rowLimit) break;
    if (page === MAX_PAGES_PER_WINDOW - 1) {
      truncationReason = `stopped after ${MAX_PAGES_PER_WINDOW} pages of ${dimension} rows`;
    }
  }
  return { rows, truncationReason, recorded };
}

async function collectPerformance(transport, windows) {
  const results = [];
  for (const window of windows) {
    const dimensions = {};
    for (const dimension of ['page', 'query', PAGE_NON_BRAND_VIEW]) {
      dimensions[dimension] = await collectPagedRows(transport, window, dimension);
    }
    const site = {};
    for (const view of ['site', 'siteBrand', 'siteNonBrand']) {
      site[view] = await collectSiteView(transport, window, view);
    }
    results.push({ window, dimensions, site });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * One by-property view: a single request with no pagination. A view the
 * transport could not answer is recorded as unavailable with its reason, never
 * as zero. A view Google answered with no rows is a real zero.
 */
async function collectSiteView(transport, window, view) {
  let response;
  try {
    response = await transport.searchAnalytics({
      windowLabel: window.label,
      dimension: view,
      page: 0,
      startDate: window.startDate,
      endDate: window.endDate,
    });
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      return { status: 'unavailable', reason: `searchanalytics quota was exhausted: ${error.message}`, rows: null };
    }
    throw error;
  }
  if (response === null) {
    return { status: 'unavailable', reason: `the ${view} view was not collected`, rows: null };
  }
  const rows = (Array.isArray(response.rows) ? response.rows : []).map((row) => ({
    key: Array.isArray(row.keys) ? (row.keys[0] ?? null) : null,
    clicks: finite(row.clicks) ?? 0,
    impressions: finite(row.impressions) ?? 0,
    position: finite(row.position),
  }));
  return { status: 'available', reason: null, rows };
}

const unmeasuredLookup = (lookup, status, reason) => ({
  ...lookup, status, reason, clicks: null, impressions: null, position: null,
});

function readLookup(lookup, response) {
  if (response === null) return unmeasuredLookup(lookup, 'unavailable', 'no lookup was recorded for this query');
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  if (rows.length === 0) return unmeasuredLookup(lookup, 'not-reported', NOT_REPORTED_REASON);
  const matching = rows.filter((row) => Array.isArray(row.keys) && row.keys[0] === lookup.expression);
  if (matching.length !== 1) {
    return unmeasuredLookup(lookup, 'unavailable', 'Search Console answered with rows for other queries');
  }
  const [row] = matching;
  const clicks = finite(row.clicks);
  const impressions = finite(row.impressions);
  if (clicks === null || impressions === null) {
    return unmeasuredLookup(lookup, 'unavailable', 'Search Console returned a row without clicks or impressions');
  }
  return { ...lookup, status: 'reported', reason: null, clicks, impressions, position: finite(row.position) };
}

/**
 * One exact-match lookup per reviewed query and window: 25 queries and two
 * windows are 50 small requests through the same retrying transport. A failed
 * lookup is recorded against its query and the rest continue; the quota stops
 * them all, and every query left unasked says so.
 */
async function collectReviewedQueries(transport, windows, querySet) {
  if (!querySet) {
    return {
      status: 'unavailable',
      reason: 'no reviewed query set was supplied',
      querySetId: null,
      querySetDigest: null,
      operator: REVIEWED_QUERY_OPERATOR,
      windows: [],
    };
  }
  invariant(typeof transport.lookupQuery === 'function', 'the transport cannot look up reviewed queries');
  let quotaReason = null;
  const collected = [];
  for (const window of windows) {
    const lookups = [];
    for (const query of querySet.queries) {
      const lookup = { queryId: query.id, query: query.query, expression: reviewedQueryExpression(query.query) };
      if (quotaReason) {
        lookups.push(unmeasuredLookup(lookup, 'unavailable', quotaReason));
        continue;
      }
      try {
        lookups.push(readLookup(lookup, await transport.lookupQuery({
          windowLabel: window.label,
          expression: lookup.expression,
          startDate: window.startDate,
          endDate: window.endDate,
        })));
      } catch (error) {
        if (error instanceof QuotaExhaustedError) {
          quotaReason = `searchanalytics quota was exhausted: ${error.message}`;
        }
        lookups.push(unmeasuredLookup(
          lookup,
          'unavailable',
          quotaReason ?? `the lookup failed: ${error?.message ?? String(error)}`,
        ));
      }
    }
    collected.push({ label: window.label, startDate: window.startDate, endDate: window.endDate, lookups });
  }
  const gaps = collected
    .map((window) => [window.label, window.lookups.filter((lookup) => lookup.status === 'unavailable').length])
    .filter(([, count]) => count > 0);
  const answered = collected.some((window) => window.lookups.some((lookup) => lookup.status !== 'unavailable'));
  return {
    status: gaps.length === 0 ? 'available' : (answered ? 'partial' : 'unavailable'),
    reason: gaps.length === 0
      ? null
      : gaps.map(([label, count]) => `${label}: ${count} of ${querySet.queries.length} lookups unavailable`).join('; '),
    querySetId: querySet.querySetId,
    querySetDigest: computeQuerySetDigest(querySet),
    operator: REVIEWED_QUERY_OPERATOR,
    windows: collected,
  };
}

/** The non-brand query rows, collected for the first window only. */
async function collectNonBrandQueries(transport, windows) {
  const [window] = windows;
  if (!window) return null;
  return {
    window,
    device: await collectPagedRows(transport, window, QUERY_DEVICE_VIEW),
    page: await collectPagedRows(transport, window, QUERY_PAGE_VIEW),
  };
}

/** The daily by-property series, collected once over the widest window. */
async function collectDaily(transport, windows) {
  const widest = [...windows].sort((left, right) => (
    Date.parse(left.startDate) - Date.parse(right.startDate)
  ))[0];
  if (!widest) return null;
  return {
    window: widest,
    all: await collectSiteView(transport, widest, 'daily'),
    nonBrand: await collectSiteView(transport, widest, 'dailyNonBrand'),
  };
}

function siteMetrics(view) {
  if (view.status !== 'available') return null;
  const accumulator = newAccumulator();
  for (const row of view.rows) addRow(accumulator, row);
  const { clicks, impressions, ctr, averagePosition } = finalizeMetrics(accumulator);
  return { clicks, impressions, ctr, averagePosition };
}

/**
 * Totals counted once per search, as the Search Console performance chart
 * counts them, split into brand, non-brand and the anonymized remainder.
 */
function buildSiteTotals(site) {
  const all = siteMetrics(site.site);
  const brand = siteMetrics(site.siteBrand);
  const nonBrand = siteMetrics(site.siteNonBrand);
  const unavailable = Object.entries(site)
    .filter(([, view]) => view.status !== 'available')
    .map(([, view]) => view.reason);
  const remainder = (field) => (
    all && brand && nonBrand ? Math.max(0, all[field] - brand[field] - nonBrand[field]) : null
  );
  return {
    status: unavailable.length === 0 ? 'available' : (all ? 'partial' : 'unavailable'),
    reason: unavailable.length === 0 ? null : unavailable.join('; '),
    basis: 'by-property',
    brandPattern: BRAND_QUERY_PATTERN,
    all,
    brand,
    nonBrand,
    anonymized: all && brand && nonBrand
      ? { clicks: remainder('clicks'), impressions: remainder('impressions') }
      : null,
    nonBrandShare: share(nonBrand?.impressions ?? null, all?.impressions ?? null, 'by-property-impressions'),
  };
}

function buildDaily(daily) {
  if (!daily) return { status: 'unavailable', reason: 'no window was requested', rows: [] };
  const { window, all, nonBrand } = daily;
  if (all.status !== 'available') {
    return { status: 'unavailable', reason: all.reason, startDate: window.startDate, endDate: window.endDate, rows: [] };
  }
  const nonBrandByDate = new Map(
    (nonBrand.rows ?? []).map((row) => [row.key, row]),
  );
  const rows = all.rows
    .filter((row) => typeof row.key === 'string')
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((row) => {
      const nb = nonBrand.status === 'available' ? (nonBrandByDate.get(row.key) ?? null) : null;
      return {
        date: row.key,
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position === null ? null : roundTo(row.position, 2),
        // A date with no non-brand row is a real zero when the view answered;
        // null only when the non-brand view itself was not measured.
        nonBrandClicks: nonBrand.status === 'available' ? (nb?.clicks ?? 0) : null,
        nonBrandImpressions: nonBrand.status === 'available' ? (nb?.impressions ?? 0) : null,
      };
    });
  return {
    status: nonBrand.status === 'available' ? 'available' : 'partial',
    reason: nonBrand.status === 'available' ? null : nonBrand.reason,
    basis: 'by-property',
    startDate: window.startDate,
    endDate: window.endDate,
    rows,
  };
}

function countBy(entries, selector) {
  const counts = {};
  for (const entry of entries) {
    const key = selector(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function groupIndexation(records, declaredCounts, selector, groupIds) {
  const groups = {};
  for (const id of groupIds) {
    const inGroup = records.filter((record) => selector(record) === id);
    const declared = declaredCounts[id] ?? 0;
    if (declared === 0 && inGroup.length === 0) continue;
    const indexed = inGroup.filter((record) => record.indexStatus?.verdict === INDEXED_VERDICT).length;
    const withStatus = inGroup.filter((record) => record.indexStatus !== null);
    const coverageStates = countBy(
      withStatus,
      (record) => record.indexStatus.coverageState ?? 'unreported',
    );
    groups[id] = {
      declared,
      inspected: inGroup.length,
      indexed: withStatus.length > 0 ? indexed : null,
      indexedReason: withStatus.length > 0 ? null : 'no URL in this group returned an index status',
      indexedShare: share(indexed, withStatus.length, 'inspected'),
      crawledNotIndexed: withStatus.filter(
        (record) => isCrawledNotIndexed(record.indexStatus.coverageState),
      ).length,
      discoveredNotCrawled: withStatus.filter(
        (record) => isDiscoveredNotCrawled(record.indexStatus.coverageState),
      ).length,
      servingNoindex: inGroup.filter((record) => record.noindex).length,
      coverageStates,
    };
  }
  return groups;
}

function topCoverageReasons(records) {
  const counts = countBy(
    records.filter((record) => record.indexStatus?.verdict !== INDEXED_VERDICT
      && record.indexStatus !== null),
    (record) => record.indexStatus.coverageState ?? 'unreported',
  );
  return Object.entries(counts)
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .slice(0, 3)
    .map(([state, count]) => ({ state, count }));
}

/**
 * One row per non-brand query. Metrics come from the query-by-device rows,
 * which Google aggregates by property; the query-by-page rows, which count a
 * search once per URL, only name the page.
 *
 * A device view cut short leaves desktop shares and totals wrong rather than
 * merely incomplete, so it reports nothing instead of a smaller list.
 */
export function buildNonBrandQueries(raw) {
  const unavailable = (reason, window = null) => ({
    status: 'unavailable',
    reason,
    window,
    method: null,
    summary: null,
    rows: [],
  });
  if (!raw) return unavailable('no window was requested');
  const { window, device, page } = raw;
  if (!device.recorded) return unavailable(`the ${QUERY_DEVICE_VIEW} view was not collected`, window.label);
  if (device.truncationReason) return unavailable(device.truncationReason, window.label);

  const byQuery = new Map();
  for (const row of device.rows) {
    const entry = byQuery.get(row.key) ?? { clicks: 0, impressions: 0, desktop: 0, weighted: 0, positioned: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    if (row.secondKey === 'DESKTOP') entry.desktop += row.impressions;
    if (row.position !== null) {
      entry.weighted += row.position * row.impressions;
      entry.positioned += row.impressions;
    }
    byQuery.set(row.key, entry);
  }
  const topPage = new Map();
  for (const row of page.rows) {
    const current = topPage.get(row.key);
    if (!current || row.impressions > current.impressions) topPage.set(row.key, row);
  }

  const pageGap = page.recorded
    ? page.truncationReason
    : `the ${QUERY_PAGE_VIEW} view was not collected`;
  const queries = [...byQuery].map(([query, entry]) => {
    const desktopShare = entry.impressions > 0 ? entry.desktop / entry.impressions : null;
    return {
      query,
      // The true top page may be in rows the cut-short view never returned.
      page: pageGap ? null : (topPage.get(query)?.secondKey ?? null),
      clicks: entry.clicks,
      impressions: entry.impressions,
      position: entry.positioned > 0 ? roundTo(entry.weighted / entry.positioned, 2) : null,
      desktopShare: desktopShare === null ? null : roundTo(desktopShare, 3),
      likelyAutomated: entry.clicks === LIKELY_AUTOMATED.clicks
        && entry.impressions >= LIKELY_AUTOMATED.minImpressions
        && desktopShare !== null
        && desktopShare >= LIKELY_AUTOMATED.minDesktopShare,
    };
  }).sort((left, right) => right.impressions - left.impressions
    || left.query.localeCompare(right.query));

  const sumImpressions = (rows) => rows.reduce((sum, row) => sum + row.impressions, 0);
  const automated = queries.filter((row) => row.likelyAutomated);
  const nonBrandImpressions = sumImpressions(queries);
  const likelyAutomatedImpressions = sumImpressions(automated);
  return {
    status: pageGap ? 'partial' : 'available',
    reason: pageGap ?? null,
    window: window.label,
    method: {
      basis: 'inference from zero clicks and desktop share; existing non-brand totals still include these queries',
      ...LIKELY_AUTOMATED,
      minListedImpressions: MIN_LISTED_QUERY_IMPRESSIONS,
      maxListed: MAX_NON_BRAND_QUERIES,
    },
    summary: {
      queries: queries.length,
      nonBrandImpressions,
      likelyAutomatedQueries: automated.length,
      likelyAutomatedImpressions,
      nonBrandImpressionsExcludingLikelyAutomated: nonBrandImpressions - likelyAutomatedImpressions,
    },
    rows: queries
      .filter((row) => row.impressions >= MIN_LISTED_QUERY_IMPRESSIONS)
      .slice(0, MAX_NON_BRAND_QUERIES),
  };
}

function buildPerformance(performance, inventory, indexedByFamily, daily, nonBrandQueries) {
  const routeFamily = new Map(inventory.urls.map((entry) => [entry.url, entry]));
  const windows = performance.map(({ window, dimensions, site }) => {
    const totals = newAccumulator();
    // Non-brand rows per family, measured only when the filtered view was
    // collected. Rows outside every family are left out here; the unmapped
    // list above already names them.
    // A truncated view is an undercount, which is reported as unmeasured with
    // the truncation reason rather than published as a smaller number.
    const nonBrandView = dimensions[PAGE_NON_BRAND_VIEW];
    const nonBrandRecorded = nonBrandView.recorded && nonBrandView.truncationReason === null;
    const nonBrandUnmeasuredReason = nonBrandView.truncationReason
      ?? 'the non-brand page view was not collected';
    const nonBrandByFamily = new Map(PAGE_FAMILIES.map((family) => [family, newAccumulator()]));
    for (const row of dimensions[PAGE_NON_BRAND_VIEW].rows) {
      let classified = routeFamily.get(row.key);
      if (!classified) {
        try {
          classified = classifyUrl(row.key);
        } catch {
          continue;
        }
      }
      addRow(nonBrandByFamily.get(classified.family), row);
    }
    const families = new Map(PAGE_FAMILIES.map((family) => [family, newAccumulator()]));
    // Google reports URLs we never declared: legacy paths, other hosts in the
    // Domain property. They stay in the totals and are listed by name, so the
    // report shows exactly what needs a family instead of hiding it in "other"
    // or failing the run over data we do not control.
    const unmapped = newAccumulator();
    const unmappedRows = [];
    const pageRows = [];
    for (const row of dimensions.page.rows) {
      addRow(totals, row);
      let classified = routeFamily.get(row.key);
      if (!classified) {
        try {
          classified = classifyUrl(row.key);
        } catch (error) {
          addRow(unmapped, row);
          unmappedRows.push({ ...row, reason: error.message.replace(/^\[seo-url-taxonomy\] /, '') });
          continue;
        }
      }
      addRow(families.get(classified.family), row);
      pageRows.push({ ...row, family: classified.family });
    }
    const byFamily = {};
    for (const [family, accumulator] of families) {
      if (accumulator.urls === 0 && (indexedByFamily[family]?.declared ?? 0) === 0) continue;
      const metrics = finalizeMetrics(accumulator);
      const indexed = indexedByFamily[family]?.indexed ?? null;
      const rowsForFamily = pageRows
        .filter((row) => row.family === family)
        .sort((left, right) => right.impressions - left.impressions
          || left.key.localeCompare(right.key));
      const nonBrand = finalizeMetrics(nonBrandByFamily.get(family));
      byFamily[family] = {
        ...metrics,
        nonBrandImpressions: nonBrandRecorded ? nonBrand.impressions : null,
        nonBrandClicks: nonBrandRecorded ? nonBrand.clicks : null,
        nonBrandReason: nonBrandRecorded ? null : nonBrandUnmeasuredReason,
        impressionsPerIndexedUrl: indexed !== null && indexed > 0
          ? roundTo(metrics.impressions / indexed, 2)
          : null,
        impressionsPerIndexedUrlReason: indexed !== null && indexed > 0
          ? null
          : 'no URL in this family was confirmed indexed in the sample',
        impressionsPerIndexedUrlBasis: 'sampled-indexed-count',
        bestUrls: rowsForFamily.slice(0, MAX_URLS_PER_LIST).map(pageRowSummary),
        worstUrls: rowsForFamily.slice(-MAX_URLS_PER_LIST).reverse().map(pageRowSummary),
      };
    }
    const queryRows = [...dimensions.query.rows]
      .sort((left, right) => right.impressions - left.impressions
        || left.key.localeCompare(right.key))
      .slice(0, MAX_TOP_QUERIES)
      .map((row) => ({
        query: row.key,
        brand: isBrandQuery(row.key),
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
      }));
    const truncation = [
      dimensions.page.truncationReason,
      dimensions.query.truncationReason,
      dimensions[PAGE_NON_BRAND_VIEW].truncationReason,
    ].filter(Boolean);
    return {
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      status: truncation.length > 0 ? 'partial' : 'available',
      reason: truncation.length > 0 ? truncation.join('; ') : null,
      // Counted once per URL shown, so one search can count several times.
      // `siteTotals` is the by-property number the performance chart shows.
      totalsBasis: 'sum-of-page-rows',
      totals: finalizeMetrics(totals),
      siteTotals: buildSiteTotals(site),
      rowCounts: {
        page: dimensions.page.rows.length,
        query: dimensions.query.rows.length,
      },
      byFamily,
      unmapped: {
        urls: unmapped.urls,
        clicks: unmapped.clicks,
        impressions: unmapped.impressions,
        topUrls: unmappedRows
          .sort((left, right) => right.impressions - left.impressions
            || left.key.localeCompare(right.key))
          .map((row) => ({ ...pageRowSummary(row), reason: row.reason })),
      },
      topQueries: queryRows,
    };
  });
  const partial = windows.some((window) => window.status !== 'available');
  return {
    status: windows.length === 0 ? 'unavailable' : (partial ? 'partial' : 'available'),
    reason: windows.length === 0 ? 'no window was requested' : null,
    windows,
    daily: buildDaily(daily),
    nonBrandQueries: buildNonBrandQueries(nonBrandQueries),
  };
}

const pageRowSummary = (row) => ({
  url: row.key,
  clicks: row.clicks,
  impressions: row.impressions,
  position: row.position,
});

export function deriveWindows(observedAt) {
  const end = new Date(Date.parse(observedAt));
  const endDate = new Date(end.getTime() - 86_400_000);
  const iso = (date) => date.toISOString().slice(0, 10);
  return Object.entries(WINDOW_DAYS).map(([label, days]) => ({
    label,
    startDate: iso(new Date(endDate.getTime() - (days - 1) * 86_400_000)),
    endDate: iso(endDate),
  }));
}

function repositoryRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Build the snapshot.
 *
 * `reportedTotals` is where a Search Console coverage report total goes when
 * the operator has one. Whenever a total is present and larger than the rows
 * we saw, the snapshot says so and refuses to treat the sampled share as the
 * population share.
 */
export async function collectGscSnapshot({
  transport,
  documents,
  observedAt,
  windows,
  sampleCap = DEFAULT_SAMPLE_CAP,
  concurrency = DEFAULT_CONCURRENCY,
  propertyKind = null,
  reportedTotals = {},
  querySet = null,
  revision = repositoryRevision(),
}) {
  const inventory = buildInventory(documents);
  invariant(inventory.urls.length > 0, 'the sitemap inventory is empty');
  // Search Analytics first: it is cheap, and an auth or permission failure
  // there must stop the run before any of the daily inspection quota is spent.
  const performanceRaw = await collectPerformance(transport, windows);
  const dailyRaw = await collectDaily(transport, windows);
  const reviewedQueries = await collectReviewedQueries(transport, windows, querySet);
  const nonBrandQueriesRaw = await collectNonBrandQueries(transport, windows);
  const { sample, records, quotaReason } = await collectIndexation(
    transport,
    inventory,
    { sampleCap, concurrency },
  );

  const declaredByFamily = countBy(inventory.urls, (entry) => entry.family);
  const declaredByKind = countBy(inventory.urls, (entry) => entry.kind);
  const declaredByHost = countBy(inventory.urls, (entry) => entry.host);

  const byFamily = groupIndexation(records, declaredByFamily, (r) => r.family, PAGE_FAMILIES);
  const byKind = groupIndexation(records, declaredByKind, (r) => r.kind, URL_KINDS);
  const byHost = groupIndexation(
    records,
    declaredByHost,
    (r) => r.host,
    Object.keys(declaredByHost),
  );

  const htmlRecords = records.filter((record) => record.kind === 'html');
  const htmlWithStatus = htmlRecords.filter((record) => record.indexStatus !== null);
  const htmlIndexed = htmlWithStatus.filter(
    (record) => record.indexStatus.verdict === INDEXED_VERDICT,
  );
  // The only cell that warrants attention: crawled and declined, not serving
  // noindex, and actually answering as HTML today.
  const actionable = htmlWithStatus.filter((record) => (
    isCrawledNotIndexed(record.indexStatus.coverageState)
    && !record.noindex
    && (record.observedKind === 'html' || record.observedKind === null)
    && (record.probe.status === null || (record.probe.status >= 200 && record.probe.status < 300))
  ));

  // A URL whose inspection failed or came back empty is an absence of a
  // measurement, not a "not indexed", so it keeps the sample incomplete.
  const inspectionErrors = records.filter((record) => record.inspectionError !== null);
  const unmeasured = records.filter((record) => record.indexStatus === null).length;
  const unmeasuredReason = unmeasured > 0
    ? `${unmeasured} ${unmeasured === 1 ? 'inspection' : 'inspections'} failed or returned no index status; the sample is not complete`
    : null;
  const sampleComplete = records.length === inventory.urls.length
    && quotaReason === null
    && unmeasured === 0;
  const samplingNotes = [];
  if (records.length < inventory.urls.length) {
    samplingNotes.push(
      `Inspected ${records.length} of ${inventory.urls.length} declared URLs. Shares below are measured over the inspected rows and are not projected onto the declared total.`,
    );
  }
  if (quotaReason) samplingNotes.push(quotaReason);
  if (unmeasuredReason) samplingNotes.push(`${unmeasuredReason}.`);
  for (const [label, total] of Object.entries(reportedTotals)) {
    const seen = records.filter(
      (record) => normalizeState(record.indexStatus?.coverageState) === normalizeState(label),
    ).length;
    const rowWord = seen === 1 ? 'row' : 'rows';
    samplingNotes.push(
      seen === total
        ? `The ${label} export is complete: ${seen} ${rowWord} for a reported total of ${total}.`
        : `The ${label} export is capped: ${seen} ${rowWord} for a reported total of ${total}. Do not multiply a share from these rows up to ${total}.`,
    );
  }

  const performance = buildPerformance(performanceRaw, inventory, byFamily, dailyRaw, nonBrandQueriesRaw);
  for (const window of performance.windows) {
    if (window.status !== 'available') samplingNotes.push(`${window.label}: ${window.reason}`);
    if (window.unmapped.urls > 0) {
      samplingNotes.push(
        `${window.label}: ${window.unmapped.urls} page rows map to no family (${window.unmapped.impressions} impressions). They count in the totals and are listed under unmapped.`,
      );
    }
  }
  // A family's HTML count is exact only when every declared HTML URL in it
  // returned an index status; otherwise it is null rather than an undercount.
  const htmlDeclaredByFamily = countBy(
    inventory.urls.filter((entry) => entry.kind === 'html'),
    (entry) => entry.family,
  );
  const htmlIndexedByFamily = {};
  for (const [family, declared] of Object.entries(htmlDeclaredByFamily)) {
    const measured = htmlWithStatus.filter((record) => record.family === family);
    htmlIndexedByFamily[family] = measured.length === declared
      ? measured.filter((record) => record.indexStatus.verdict === INDEXED_VERDICT).length
      : null;
  }

  const flagged = (predicate, mapper) => records
    .filter(predicate)
    .slice(0, MAX_FLAGGED_URLS)
    .map(mapper);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    pageFamilySchemaVersion: PAGE_FAMILY_SCHEMA_VERSION,
    snapshotId: `gsc-${observedAt.slice(0, 10)}`,
    observedAt,
    repositoryRevision: revision,
    source: transport.kind,
    // The property identifier belongs in operator configuration only. Its
    // shape is recorded so a reader knows whether the numbers cover every
    // host in the property.
    property: null,
    propertyKind,
    sitemaps: inventory.sitemaps,
    inventory: {
      declared: inventory.urls.length,
      byFamily: declaredByFamily,
      byKind: declaredByKind,
      byHost: declaredByHost,
    },
    indexation: {
      status: records.length === 0 ? 'unavailable' : (sampleComplete ? 'available' : 'partial'),
      reason: records.length === 0
        ? (quotaReason ?? 'no URL was inspected')
        : (sampleComplete ? null : (quotaReason ?? unmeasuredReason ?? 'the inspection sample is capped')),
      sample: {
        cap: sampleCap,
        selected: sample.length,
        inspected: records.length,
        declared: inventory.urls.length,
        complete: sampleComplete,
        basis: 'round-robin across page families',
        extrapolated: false,
      },
      byFamily,
      byKind,
      byHost,
      htmlPages: {
        declared: declaredByKind.html ?? 0,
        inspected: htmlRecords.length,
        withIndexStatus: htmlWithStatus.length,
        indexed: htmlWithStatus.length > 0 ? htmlIndexed.length : null,
        indexedReason: htmlWithStatus.length > 0
          ? null
          : 'no HTML page in the sample returned an index status',
        indexedShare: share(htmlIndexed.length, htmlWithStatus.length, 'inspected-html'),
        indexedByFamily: htmlIndexedByFamily,
        crawledNotIndexed: htmlWithStatus.filter(
          (record) => isCrawledNotIndexed(record.indexStatus.coverageState),
        ).length,
        discoveredNotCrawled: htmlWithStatus.filter(
          (record) => isDiscoveredNotCrawled(record.indexStatus.coverageState),
        ).length,
        actionable: actionable.length,
        actionableUrls: actionable.slice(0, MAX_FLAGGED_URLS).map((record) => ({
          url: record.url,
          family: record.family,
          host: record.host,
          coverageState: record.indexStatus.coverageState,
          liveStatus: record.probe.status,
          liveContentType: record.probe.contentType,
        })),
      },
      topNotIndexedReasons: topCoverageReasons(records),
      inspectionErrors: inspectionErrors.slice(0, MAX_FLAGGED_URLS).map((record) => ({
        url: record.url,
        family: record.family,
        reason: record.inspectionError,
      })),
      canonicalMismatches: flagged(
        (record) => record.indexStatus?.googleCanonical
          && record.indexStatus.userCanonical
          && record.indexStatus.googleCanonical !== record.indexStatus.userCanonical,
        (record) => ({
          url: record.url,
          family: record.family,
          host: record.host,
          googleCanonical: record.indexStatus.googleCanonical,
          userCanonical: record.indexStatus.userCanonical,
          coverageState: record.indexStatus.coverageState,
        }),
      ),
      liveStateDisagreements: flagged(
        (record) => record.disagreement !== null,
        (record) => ({
          url: record.url,
          family: record.family,
          host: record.host,
          coverageState: record.indexStatus?.coverageState ?? null,
          liveStatus: record.probe.status,
          liveLocation: record.probe.location,
          liveRobotsTag: record.probe.xRobotsTag,
          disagreement: record.disagreement,
        }),
      ),
      kindDisagreements: flagged(
        (record) => record.observedKind !== null && record.observedKind !== record.kind,
        (record) => ({
          url: record.url,
          declaredKind: record.kind,
          observedKind: record.observedKind,
          contentType: record.probe.contentType,
        }),
      ),
    },
    performance,
    reviewedQueries,
    samplingNotes,
    guardrails: [
      'Shares are measured over inspected rows. No sampled share is projected onto a reported total.',
      'Google coverage state and the live probe status are both recorded; disagreement is flagged, never resolved.',
      'Property identifiers and credentials stay in operator configuration and never reach this file.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Refuse to write anything that looks like a credential or a property id.
 *
 * The collector already picks named fields, so this is the belt to that
 * braces: a future field addition that reintroduces a payload copy fails here
 * rather than in a published commit.
 */
export function assertNoSecrets(serialized, { property = null } = {}) {
  for (const marker of SECRET_MARKERS) {
    invariant(
      !serialized.includes(marker),
      `refusing to write output containing ${marker}`,
    );
  }
  // A URL-prefix property is the site's own public origin, which every URL in
  // the snapshot starts with. Only an opaque identifier can leak.
  if (typeof property === 'string' && property !== '' && !/^https?:\/\//i.test(property)) {
    invariant(
      !serialized.includes(property),
      'refusing to write output containing the property identifier',
    );
  }
  return serialized;
}

/**
 * Sum a daily series into seven-day periods ending on its latest date, oldest
 * first, so the newest period is always a full seven days. These are rolling
 * periods, not Monday-to-Sunday weeks. Rows are bucketed by date rather than
 * by position, because Google omits a day with no data instead of returning a
 * zero row.
 */
export function weeklyTotals(rows) {
  if (rows.length === 0) return [];
  const DAY_MS = 86_400_000;
  const last = Date.parse(rows.at(-1).date);
  const buckets = new Map();
  for (const row of rows) {
    const index = Math.floor((last - Date.parse(row.date)) / (7 * DAY_MS));
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(row);
  }
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return [...buckets.entries()]
    .sort(([left], [right]) => right - left)
    .map(([index, slice]) => {
      const sum = (field) => (slice.some((row) => row[field] === null)
        ? null
        : slice.reduce((total, row) => total + row[field], 0));
      return {
        startDate: iso(last - (index * 7 + 6) * DAY_MS),
        endDate: iso(last - index * 7 * DAY_MS),
        days: slice.length,
        impressions: sum('impressions'),
        clicks: sum('clicks'),
        nonBrandImpressions: sum('nonBrandImpressions'),
        nonBrandClicks: sum('nonBrandClicks'),
      };
    });
}

function renderSearchTotals(performance) {
  const lines = ['## Search totals', ''];
  lines.push('Counted by property: one search is one impression however many of our');
  lines.push('URLs it shows, as in the Search Console performance chart. The page-row');
  lines.push('sum counts the same search once per URL, so it runs higher.');
  lines.push('');
  lines.push('| Window | Impressions | Clicks | Brand impressions | Non-brand impressions | Non-brand clicks | Anonymized impressions | Non-brand share | Page-row sum impressions |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const window of performance.windows) {
    const site = window.siteTotals;
    lines.push([
      `| ${window.label} (${window.startDate} to ${window.endDate})`,
      number(site.all?.impressions ?? null),
      number(site.all?.clicks ?? null),
      number(site.brand?.impressions ?? null),
      number(site.nonBrand?.impressions ?? null),
      number(site.nonBrand?.clicks ?? null),
      number(site.anonymized?.impressions ?? null),
      percent(site.nonBrandShare.value),
      `${window.totals.impressions} |`,
    ].join(' | '));
  }
  lines.push('');
  const unavailable = performance.windows.filter((window) => window.siteTotals.status !== 'available');
  for (const window of unavailable) lines.push(`- ${window.label}: ${window.siteTotals.reason}`);
  if (unavailable.length > 0) lines.push('');
  const brandPattern = performance.windows[0]?.siteTotals.brandPattern ?? BRAND_QUERY_PATTERN;
  lines.push(`Brand queries match \`${brandPattern}\`, case-insensitive. Google drops anonymized queries from any query-filtered view, so they are reported as the remainder.`);
  lines.push('');

  const { daily } = performance;
  lines.push('### Seven-day trend');
  lines.push('');
  if (daily.status === 'unavailable' || daily.rows.length === 0) {
    lines.push(`Not measured: ${daily.reason ?? 'the daily series returned no rows'}.`);
  } else {
    lines.push(`By property, ${daily.startDate} to ${daily.endDate}, final data only. Each row is a seven-day period ending on the latest date, not a Monday-to-Sunday week. Days counts the dates Google returned; it omits a date with no data, and the oldest period can fall partly outside the window.`);
    lines.push('');
    lines.push('| Period | Days | Impressions | Clicks | Non-brand impressions | Non-brand clicks |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const week of weeklyTotals(daily.rows)) {
      lines.push(`| ${week.startDate} to ${week.endDate} | ${week.days} | ${number(week.impressions)} | ${number(week.clicks)} | ${number(week.nonBrandImpressions)} | ${number(week.nonBrandClicks)} |`);
    }
  }
  lines.push('');

  const primary = performance.windows[0] ?? null;
  if (primary && primary.topQueries.length > 0) {
    lines.push(`### Top queries (${primary.label})`);
    lines.push('');
    lines.push('| Query | Brand | Impressions | Clicks | CTR | Position |');
    lines.push('|---|---|---:|---:|---:|---:|');
    for (const row of primary.topQueries) {
      const ctr = row.impressions > 0 ? row.clicks / row.impressions : null;
      lines.push(`| ${queryCell(row.query)} | ${row.brand ? 'yes' : 'no'} | ${row.impressions} | ${row.clicks} | ${percent(ctr)} | ${row.position === null ? 'n/a' : row.position.toFixed(1)} |`);
    }
    lines.push('');
  }

  const list = performance.nonBrandQueries;
  if (list.summary === null) {
    lines.push(`Non-brand queries: unavailable (${list.reason}).`);
    lines.push('');
    return lines;
  }
  const { summary } = list;
  lines.push(`### Non-brand queries with few clicks (${list.window})`);
  lines.push('');
  lines.push(`${summary.likelyAutomatedQueries} of ${summary.queries} non-brand queries look automated, ${summary.likelyAutomatedImpressions} of ${summary.nonBrandImpressions} impressions. That is an inference from zero clicks and at least ${Math.round(list.method.minDesktopShare * 100)}% desktop, and the non-brand totals above still include them. Most impressions first, below ${Math.round(LOW_CLICK_CTR * 100)}% CTR.`);
  lines.push('');
  if (list.reason) {
    lines.push(`Top pages are withheld: ${list.reason}.`);
    lines.push('');
  }
  lines.push('| Query | Top page | Impressions | Clicks | CTR | Position | Desktop | Likely automated |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---|');
  const lowClick = list.rows
    .filter((row) => row.impressions > 0 && row.clicks / row.impressions < LOW_CLICK_CTR)
    .slice(0, MAX_LOW_CLICK_QUERIES_IN_SUMMARY);
  for (const row of lowClick) {
    const page = row.page === null ? 'n/a' : markdownCell(row.page.replace('https://www.worldmonitor.app', '') || '/');
    const desktop = row.desktopShare === null ? 'n/a' : `${Math.round(row.desktopShare * 100)}%`;
    lines.push(`| ${queryCell(row.query)} | ${page} | ${row.impressions} | ${row.clicks} | ${percent(row.clicks / row.impressions)} | ${row.position === null ? 'n/a' : row.position.toFixed(1)} | ${desktop} | ${row.likelyAutomated ? 'yes' : 'no'} |`);
  }
  lines.push('');
  return lines;
}

function renderReviewedQueries(section) {
  if (!section) return [];
  const lines = ['### Reviewed queries', ''];
  if (section.windows.length === 0) {
    lines.push(`Not measured: ${section.reason}.`, '');
    return lines;
  }
  lines.push(`One \`${section.operator}\` lookup per reviewed query (\`${section.querySetId}\`) and window, on the reviewed text lowercased with spaces collapsed, the form Search Console stores. Not reported means Google returned no row: the query fell below its privacy threshold or had no impressions. That is not a zero.`);
  lines.push('');
  lines.push('| Window | Looked up | Reported | Not reported | Unavailable |');
  lines.push('|---|---:|---:|---:|---:|');
  const count = (window, status) => window.lookups.filter((lookup) => lookup.status === status).length;
  for (const window of section.windows) {
    lines.push(`| ${window.label} | ${window.lookups.length} | ${count(window, 'reported')} | ${count(window, 'not-reported')} | ${count(window, 'unavailable')} |`);
  }
  lines.push('');
  const [primary] = section.windows;
  const reported = primary.lookups.filter((lookup) => lookup.status === 'reported');
  if (reported.length > 0) {
    lines.push(`| Reviewed query (${primary.label}) | Impressions | Clicks | CTR | Position |`);
    lines.push('|---|---:|---:|---:|---:|');
    for (const lookup of reported) {
      const ctr = lookup.impressions > 0 ? lookup.clicks / lookup.impressions : null;
      lines.push(`| ${markdownCell(lookup.query)} | ${lookup.impressions} | ${lookup.clicks} | ${percent(ctr)} | ${lookup.position === null ? 'n/a' : lookup.position.toFixed(1)} |`);
    }
    lines.push('');
  }
  return lines;
}

// Escape the backslash first, then the pipe that would end the table cell, and
// flatten line breaks.
const markdownCell = (value) => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/[\r\n]+/g, ' ');

// A query is user text in a report that merges without a person reading it, so
// nothing in it may render as a link, image or HTML. `:` and `.` are included
// because GFM autolinks a bare URL, www. host or email address.
export const queryCell = (value) => String(value)
  .replace(/[\\|`*_[\]()<>!~:.]/g, '\\$&')
  .replace(/[\r\n]+/g, ' ');

const percent = (ratio) => (ratio === null ? 'n/a' : `${(ratio * 100).toFixed(1)}%`);
const number = (value) => (value === null ? 'n/a' : String(value));
const urlList = (entries) => (
  entries.length === 0
    ? 'n/a'
    : entries.map((entry) => `${entry.url} (${entry.impressions})`).join('<br>')
);

export function renderGscMarkdown(snapshot) {
  const primary = snapshot.performance.windows[0] ?? null;
  const lines = [];
  lines.push(`# Search Console snapshot ${snapshot.observedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`Source: \`${snapshot.source}\`. Repository revision \`${snapshot.repositoryRevision}\`.`);
  lines.push(`Property identifier: withheld (kind: ${snapshot.propertyKind ?? 'unrecorded'}).`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- Declared URLs: ${snapshot.inventory.declared}`);
  lines.push(`- Inspected: ${snapshot.indexation.sample.inspected} (${snapshot.indexation.status})`);
  lines.push(
    `- HTML pages indexed: ${number(snapshot.indexation.htmlPages.indexed)} of ${snapshot.indexation.htmlPages.withIndexStatus} inspected (${percent(snapshot.indexation.htmlPages.indexedShare.value)})`,
  );
  lines.push(
    `- HTML pages crawled and declined, serving no \`noindex\`: ${snapshot.indexation.htmlPages.actionable}`,
  );
  lines.push(
    `- HTML pages discovered but not yet crawled: ${snapshot.indexation.htmlPages.discoveredNotCrawled}`,
  );
  lines.push(
    `- Live-state disagreements flagged: ${snapshot.indexation.liveStateDisagreements.length}`,
  );
  lines.push('');
  lines.push('Indexability is reported for HTML pages on their own. Render');
  lines.push('subresources and machine-readable twins are counted under `kind`');
  lines.push('below, because a coverage number that mixes them moves when the');
  lines.push('docs build renames a chunk rather than when a page changes.');
  lines.push('');

  lines.push(...renderSearchTotals(snapshot.performance));
  lines.push(...renderReviewedQueries(snapshot.reviewedQueries));

  lines.push('## By page family');
  lines.push('');
  lines.push('Impressions and clicks here are summed over page rows, so one search counts once per URL it shows. Non-brand impressions exclude brand and anonymized queries.');
  lines.push('');
  lines.push('| Family | Declared | Inspected | Indexed | Indexed share | Top declined reasons | Impressions | Non-brand impressions | Clicks | CTR | Impressions per indexed URL |');
  lines.push('|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|');
  // The union, not just the declared families: a family that earns impressions
  // without appearing in a sitemap is exactly the row worth seeing, and
  // iterating only the indexation keys would drop it.
  const reportedFamilies = PAGE_FAMILIES.filter((family) => (
    snapshot.indexation.byFamily[family] !== undefined
    || primary?.byFamily?.[family] !== undefined
  ));
  for (const family of reportedFamilies) {
    const index = snapshot.indexation.byFamily[family] ?? null;
    const perf = primary?.byFamily?.[family] ?? null;
    if (!index) {
      lines.push(
        `| ${family} | 0 | 0 | n/a | n/a | not declared in any sitemap | ${perf.impressions} | ${number(perf.nonBrandImpressions)} | ${perf.clicks} | ${percent(perf.ctr)} | n/a |`,
      );
      continue;
    }
    const reasons = Object.entries(index.coverageStates)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 2)
      .map(([state, count]) => `${state} (${count})`)
      .join('; ') || 'n/a';
    lines.push([
      `| ${family}`,
      index.declared,
      index.inspected,
      number(index.indexed),
      percent(index.indexedShare.value),
      reasons,
      perf ? perf.impressions : 'n/a',
      perf ? number(perf.nonBrandImpressions) : 'n/a',
      perf ? perf.clicks : 'n/a',
      perf ? percent(perf.ctr) : 'n/a',
      `${perf ? number(perf.impressionsPerIndexedUrl) : 'n/a'} |`,
    ].join(' | '));
  }
  lines.push('');

  lines.push('## By response kind');
  lines.push('');
  lines.push('| Kind | Declared | Inspected | Indexed | Crawled and declined | Discovered, not crawled | Serving noindex |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const kind of URL_KINDS) {
    const index = snapshot.indexation.byKind[kind];
    if (!index) continue;
    lines.push(`| ${kind} | ${index.declared} | ${index.inspected} | ${number(index.indexed)} | ${index.crawledNotIndexed} | ${index.discoveredNotCrawled} | ${index.servingNoindex} |`);
  }
  lines.push('');

  lines.push('## By host');
  lines.push('');
  lines.push('| Host | Declared | Inspected | Indexed |');
  lines.push('|---|---:|---:|---:|');
  for (const [host, index] of Object.entries(snapshot.indexation.byHost)) {
    lines.push(`| ${host} | ${index.declared} | ${index.inspected} | ${number(index.indexed)} |`);
  }
  lines.push('');
  lines.push(`Host classes in the property: ${HOST_CLASSES.join(', ')}.`);
  lines.push('');

  if (primary) {
    lines.push(`## Best and worst URLs (${primary.label})`);
    lines.push('');
    lines.push('| Family | Best by impressions | Worst by impressions |');
    lines.push('|---|---|---|');
    for (const [family, perf] of Object.entries(primary.byFamily)) {
      lines.push(`| ${family} | ${urlList(perf.bestUrls)} | ${urlList(perf.worstUrls)} |`);
    }
    lines.push('');
  }

  if (primary && primary.unmapped.urls > 0) {
    lines.push(`## URLs outside every family (${primary.label})`);
    lines.push('');
    lines.push(`${primary.unmapped.urls} page rows, ${primary.unmapped.impressions} impressions, ${primary.unmapped.clicks} clicks. They count in the totals above. Give each recurring one a family.`);
    lines.push('');
    lines.push('| URL | Impressions | Clicks | Reason |');
    lines.push('|---|---:|---:|---|');
    for (const row of primary.unmapped.topUrls) {
      lines.push(`| ${row.url} | ${row.impressions} | ${row.clicks} | ${row.reason} |`);
    }
    lines.push('');
  }

  if (snapshot.indexation.inspectionErrors.length > 0) {
    lines.push('## Failed inspections');
    lines.push('');
    lines.push('| URL | Family | Reason |');
    lines.push('|---|---|---|');
    for (const row of snapshot.indexation.inspectionErrors) {
      lines.push(`| ${row.url} | ${row.family} | ${row.reason} |`);
    }
    lines.push('');
  }

  if (snapshot.indexation.liveStateDisagreements.length > 0) {
    lines.push('## Google state versus live response');
    lines.push('');
    lines.push('Recorded, not resolved. A trend built on `coverageState` alone reports defects that no longer exist.');
    lines.push('');
    lines.push('| URL | Google state | Live status | Disagreement |');
    lines.push('|---|---|---:|---|');
    for (const row of snapshot.indexation.liveStateDisagreements) {
      lines.push(`| ${row.url} | ${row.coverageState ?? 'n/a'} | ${number(row.liveStatus)} | ${row.disagreement} |`);
    }
    lines.push('');
  }

  if (snapshot.indexation.canonicalMismatches.length > 0) {
    lines.push('## Canonical mismatches');
    lines.push('');
    lines.push('| URL | Google canonical | Declared canonical |');
    lines.push('|---|---|---|');
    for (const row of snapshot.indexation.canonicalMismatches) {
      lines.push(`| ${row.url} | ${row.googleCanonical} | ${row.userCanonical} |`);
    }
    lines.push('');
  }

  lines.push('## Sampling');
  lines.push('');
  if (snapshot.samplingNotes.length === 0) {
    lines.push('- The inspected set covers every declared URL.');
  } else {
    for (const note of snapshot.samplingNotes) lines.push(`- ${note}`);
  }
  lines.push('');
  lines.push('## Guardrails');
  lines.push('');
  for (const guardrail of snapshot.guardrails) lines.push(`- ${guardrail}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * The lookups usable for `querySet`, by window label, and the note that says
 * how they were measured or why there are none.
 *
 * A snapshot that predates the lookups has no query rows. The top-query list is
 * not a fallback: no reviewed query appeared in it in any snapshot through
 * 2026-11-03, and its keys are lowercased, so most reviewed text could not match.
 */
function reviewedLookups(section, querySet) {
  const none = (note) => ({ byWindow: new Map(), note });
  if (!querySet) return none('No reviewed query set was supplied, so there are no query rows');
  if (!section) {
    return none('This snapshot predates reviewed-query lookups, so it has no query rows; the reviewed queries are unmeasured, not zero');
  }
  if (section.querySetId === null) return none(`Reviewed-query lookups were not collected: ${section.reason}`);
  const digest = computeQuerySetDigest(querySet);
  if (section.querySetId !== querySet.querySetId || section.querySetDigest !== digest) {
    const short = (value) => value.slice(0, 'sha256:'.length + 12);
    return none(`Reviewed-query lookups were made for query set ${section.querySetId} (${short(section.querySetDigest)}), not the supplied ${querySet.querySetId} (${short(digest)}), so no query rows are mapped`);
  }
  const count = (window, status) => window.lookups.filter((lookup) => lookup.status === status).length;
  const counts = section.windows
    .map((window) => `${window.label}: ${count(window, 'reported')} of ${window.lookups.length} reported, ${count(window, 'not-reported')} not reported, ${count(window, 'unavailable')} unavailable`)
    .join('; ');
  return {
    byWindow: new Map(section.windows.map((window) => [window.label, window.lookups])),
    note: `Query rows come from one Search Console lookup per reviewed query and window, on the reviewed text lowercased with spaces collapsed (${counts}). A query Search Console does not report has null metrics with that reason: it fell below Google's privacy threshold or had no impressions, which is not a zero`,
  };
}

/**
 * Shape the per-family numbers for `scripts/seo-ai-visibility-collector.mjs`.
 *
 * The scorecard stays the single report. This is the feed into it, not a
 * parallel one.
 *
 * - Window totals are the by-property `siteTotals.all`, the site aggregate the
 *   performance chart shows. The page-row sum counts one search once per URL
 *   it shows, so it is never passed off as a site total; without by-property
 *   totals the window metrics are null.
 * - Page-family rows are page-grouped sums, which is what a family can mean.
 *   A family with no page row in a truncated window is unmeasured, not zero,
 *   so it gets no row there.
 * - Query rows come from the snapshot's per-query lookups, one per reviewed
 *   query and window. A query Google did not report keeps null metrics with
 *   that reason. Pass `querySet`; lookups made for a different set are refused.
 *
 * `reason` is always set, because the collector downgrades a window without
 * full query and family coverage to partial and must say why.
 */
export function toScorecardSearchExport(snapshot, { querySet = null } = {}) {
  const { performance } = snapshot;
  if (performance.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: `Search Console performance was not collected: ${performance.reason}`,
    };
  }
  // The scorecard's indexedPages means HTML pages in the declared inventory.
  // The site total is only that number when every declared URL returned an
  // index status; a family row is exact when its own URLs all did. Anything
  // else is an absence of a measurement, so null.
  const { htmlPages, sample } = snapshot.indexation;
  const complete = sample.complete === true;
  const lookups = reviewedLookups(snapshot.reviewedQueries, querySet);
  const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
  const notes = [
    'Window totals are Search Console by-property site totals. Page-family rows sum page-grouped rows, where one search counts once per URL it shows, so they are not shares of the site total.',
    sentence(lookups.note),
    complete
      ? `indexedPages counts sitemap-declared HTML URLs that URL Inspection reported indexed when the snapshot ran (${snapshot.observedAt.slice(0, 10)}); the same count stands in both windows.`
      : sentence(`indexedPages is null: the URL Inspection sample is not a complete count of the ${sample.declared} declared URLs (${snapshot.indexation.reason ?? 'no reason recorded'})`),
  ];
  const windows = performance.windows.map((window) => {
    // `all` is null only when the by-property view itself failed. A failed
    // brand or non-brand split makes siteTotals partial but leaves it valid.
    const site = window.siteTotals?.all ?? null;
    if (!site) notes.push(`${window.label}: no by-property site totals, so the window metrics are null (${window.siteTotals?.reason ?? 'not collected'}).`);
    const truncated = window.status !== 'available';
    if (truncated) notes.push(`${sentence(`${window.label}: ${window.reason}`)} Families with no page row in this window get no row.`);
    return {
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      clicks: site ? site.clicks : null,
      impressions: site ? site.impressions : null,
      ctr: site ? site.ctr : null,
      position: site ? site.averagePosition : null,
      indexedPages: complete ? htmlPages.indexed : null,
      pageFamilyRows: Object.entries(window.byFamily)
        .filter(([, metrics]) => !truncated || metrics.urls > 0)
        .map(([pageFamily, metrics]) => ({
          pageFamily,
          clicks: metrics.clicks,
          impressions: metrics.impressions,
          ctr: metrics.ctr,
          position: metrics.averagePosition,
          indexedPages: htmlPages.indexedByFamily[pageFamily] ?? null,
        })),
      queryRows: (lookups.byWindow.get(window.label) ?? []).map((lookup) => ({
        queryId: lookup.queryId,
        query: lookup.query,
        clicks: lookup.clicks,
        impressions: lookup.impressions,
        ctr: lookup.impressions > 0 ? roundTo(lookup.clicks / lookup.impressions, 4) : null,
        position: lookup.position,
        reason: lookup.reason,
      })),
    };
  });
  return {
    status: performance.status === 'available' ? 'available' : 'partial',
    reason: notes.join(' '),
    windows,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    fixtures: null,
    live: false,
    outDir: 'docs/research/seo-ai-visibility/gsc',
    date: null,
    searchExport: null,
    querySet: DEFAULT_QUERY_SET,
    sampleCap: DEFAULT_SAMPLE_CAP,
    concurrency: DEFAULT_CONCURRENCY,
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
      case '--search-export': options.searchExport = next(); break;
      case '--query-set': options.querySet = next(); break;
      case '--sample-cap': options.sampleCap = Number.parseInt(next(), 10); break;
      case '--concurrency': options.concurrency = Number.parseInt(next(), 10); break;
      case '--stdout': options.stdout = true; break;
      default: throw new Error(`[seo-gsc] unknown argument ${flag}`);
    }
  }
  invariant(
    options.fixtures !== null || options.live,
    'pass --fixtures <dir> or --live',
  );
  invariant(
    !(options.fixtures !== null && options.live),
    '--fixtures and --live are mutually exclusive',
  );
  invariant(
    Number.isInteger(options.sampleCap) && options.sampleCap > 0,
    '--sample-cap must be a positive integer',
  );
  invariant(
    Number.isInteger(options.concurrency) && options.concurrency > 0 && options.concurrency <= 10,
    '--concurrency must be an integer from 1 to 10',
  );
  return options;
}

const DEFAULT_QUERY_SET = 'docs/research/seo-ai-visibility/query-set.json';

const LIVE_SITEMAPS = Object.freeze([
  'https://www.worldmonitor.app/sitemap-main.xml',
  'https://www.worldmonitor.app/blog/sitemap-index.xml',
  'https://www.worldmonitor.app/docs/sitemap.xml',
]);

export async function runCli(argv, { env = process.env, log = console.log, now = Date.now } = {}) {
  const options = parseArgs(argv);

  let transport;
  let documents;
  let observedAt;
  let propertyKind = null;
  let property = null;
  let reportedTotals = {};

  if (options.fixtures) {
    transport = createFixtureTransport(resolve(REPO_ROOT, options.fixtures));
    documents = transport.sitemaps();
    observedAt = transport.manifest.recordedAt;
    propertyKind = transport.manifest.propertyKind ?? null;
    reportedTotals = transport.manifest.reportedTotals ?? {};
    invariant(
      typeof observedAt === 'string' && observedAt !== '',
      'the fixture manifest must record recordedAt so the run is deterministic',
    );
  } else {
    loadEnvFile(import.meta.url, { only: ['GSC_SERVICE_ACCOUNT_JSON', 'GSC_PROPERTY'] });
    const rawKey = env.GSC_SERVICE_ACCOUNT_JSON;
    invariant(
      typeof rawKey === 'string' && rawKey.trim() !== '',
      'GSC_SERVICE_ACCOUNT_JSON is not set. The owner creates the service account, '
        + 'grants it Restricted access on the property, and stores the base64 key in .env.local.',
    );
    property = env.GSC_PROPERTY;
    invariant(
      typeof property === 'string' && property.trim() !== '',
      'GSC_PROPERTY is not set (for example sc-domain:example.com)',
    );
    propertyKind = property.startsWith('sc-domain:') ? 'domain' : 'url-prefix';
    const serviceAccount = decodeServiceAccount(rawKey);
    const accessToken = await requestAccessToken(serviceAccount, {
      nowSeconds: Math.floor(now() / 1000),
    });
    transport = createLiveTransport({ accessToken, property });
    documents = await transport.sitemaps(LIVE_SITEMAPS);
    observedAt = new Date(now()).toISOString();
  }

  const windows = deriveWindows(observedAt);
  const querySet = readJson(resolve(REPO_ROOT, options.querySet));
  const snapshot = await collectGscSnapshot({
    transport,
    documents,
    observedAt,
    windows,
    sampleCap: options.sampleCap,
    concurrency: options.concurrency,
    propertyKind,
    reportedTotals,
    querySet,
  });

  const date = options.date ?? observedAt.slice(0, 10);
  const json = assertNoSecrets(`${JSON.stringify(snapshot, null, 2)}\n`, { property });
  const markdown = assertNoSecrets(renderGscMarkdown(snapshot), { property });

  if (options.stdout) {
    log(json);
    return { snapshot, markdown, written: [] };
  }

  const outDir = resolve(REPO_ROOT, options.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${date}.json`);
  const markdownPath = join(outDir, `${date}.md`);
  writeFileSync(jsonPath, json);
  writeFileSync(markdownPath, markdown);
  const written = [jsonPath, markdownPath];

  if (options.searchExport) {
    const exportPath = resolve(REPO_ROOT, options.searchExport);
    mkdirSync(dirname(exportPath), { recursive: true });
    const exportJson = assertNoSecrets(
      `${JSON.stringify(toScorecardSearchExport(snapshot, { querySet }), null, 2)}\n`,
      { property },
    );
    writeFileSync(exportPath, exportJson);
    written.push(exportPath);
  }

  log(`[seo-gsc] wrote ${written.map((path) => path.replace(`${REPO_ROOT}/`, '')).join(', ')}`);
  return { snapshot, markdown, written };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { QuotaExhaustedError, DEFAULT_SAMPLE_CAP, isCrawledNotIndexed, markdownCell, number, percent };
