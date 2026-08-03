#!/usr/bin/env node

/**
 * Normalize first-party SEO and product-outcome exports into the reviewed
 * scorecard baseline contract.
 *
 * The collector accepts only bounded aggregate exports. It deliberately picks
 * fields from the input instead of copying arbitrary provider payloads, so
 * property identifiers, credentials, prompts, session ids, and user ids never
 * reach a committed baseline.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import {
  AI_PLATFORMS,
  PAGE_FAMILIES,
  BING_AI_METRICS,
  REFERRAL_METRICS,
  SEARCH_PERFORMANCE_METRICS,
  SEARCH_METRICS,
  computeQuerySetDigest,
  isNonEmptyString,
  isWorldMonitorUrl,
  validateBaseline,
} from './seo-ai-visibility-scorecard.mjs';
import { isMainModule } from './lib/main-module.mjs';

const UTC_DAY_MS = 86_400_000;
const WINDOW_DAYS = Object.freeze({ '28d': 28, '90d': 90 });
const AVAILABILITY_STATES = new Set(['available', 'partial', 'unavailable']);
const REFERRER_FAMILIES = new Set([
  'chatgpt',
  'perplexity',
  'google_search_ai',
  'copilot_bing',
  'claude',
  'other_ai_search',
  'unknown_direct',
]);
const EVENT_METRICS = Object.freeze({
  session: 'sessions',
  sessions: 'sessions',
  'dashboard-launch': 'dashboardLaunches',
  'dashboard-launches': 'dashboardLaunches',
  'pricing-view': 'pricingViews',
  'pricing-views': 'pricingViews',
  'sign-up': 'signUps',
  'checkout-success': 'proConversions',
  'pro-activation-exit': 'activations',
  'mcp-connect-success': 'mcpActions',
});
const API_ACTIONS = new Set(['key-created', 'key-revoked']);

// These inputs are operator-provided exports. Keep the limits comfortably
// above the reviewed fixtures while bounding work before normalization,
// cloning, or serialization.
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const MAX_WINDOWS = 16;
const MAX_ROWS_PER_WINDOW = 5_000;
const MAX_TOTAL_ROWS = 25_000;
const MAX_ARRAY_ITEMS = 500;
const MAX_QUERY_SET_ENTRIES = 30;
const MAX_REFERENCE_ENTITIES = 20;
const MAX_AI_OBSERVATIONS = 500;
const MAX_OPPORTUNITIES = 5;

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-visibility-collector] ${message}`);
}

function boundedString(value, field, maximumBytes = MAX_STRING_BYTES) {
  invariant(typeof value === 'string', `${field} must be a string`);
  invariant(
    Buffer.byteLength(value, 'utf8') <= maximumBytes,
    `${field} exceeds the ${maximumBytes}-byte limit`,
  );
  return value;
}

function boundedNonEmptyString(value, field, maximumBytes = MAX_STRING_BYTES) {
  boundedString(value, field, maximumBytes);
  invariant(isNonEmptyString(value), `${field} must be a non-empty string`);
  return value;
}

function optionalBoundedString(value, field, maximumBytes = MAX_STRING_BYTES) {
  if (value === undefined || value === null) return null;
  return boundedString(value, field, maximumBytes);
}

function boundedArray(value, field, maximumLength = MAX_ARRAY_ITEMS) {
  invariant(Array.isArray(value), `${field} must be an array`);
  invariant(
    value.length <= maximumLength,
    `${field} exceeds the ${maximumLength}-item limit`,
  );
  return value;
}

function optionalArray(value, field, maximumLength = MAX_ARRAY_ITEMS) {
  if (value === undefined || value === null) return [];
  return boundedArray(value, field, maximumLength);
}

function sourceStatusValue(raw, field) {
  if (raw?.status === undefined) return 'available';
  const status = boundedString(raw.status, `${field}.status`, 32);
  invariant(AVAILABILITY_STATES.has(status), `${field} must be available, partial, or unavailable`);
  return status;
}

function sourceReason(value, fallback, field) {
  return value === undefined || value === null
    ? fallback
    : boundedNonEmptyString(value, field);
}

function assertQuerySetBounds(querySet) {
  invariant(querySet && typeof querySet === 'object', 'query set is required');
  boundedNonEmptyString(querySet.querySetId, 'querySet.querySetId');
  boundedNonEmptyString(querySet.reviewedAt, 'querySet.reviewedAt', 64);
  const queries = boundedArray(
    querySet.queries,
    'querySet.queries',
    MAX_QUERY_SET_ENTRIES,
  );
  for (const [index, query] of queries.entries()) {
    const label = `querySet.queries[${index}]`;
    invariant(query && typeof query === 'object', `${label} must be an object`);
    boundedNonEmptyString(query.id, `${label}.id`);
    boundedNonEmptyString(query.query, `${label}.query`);
    boundedNonEmptyString(query.intent, `${label}.intent`);
    boundedNonEmptyString(query.targetAudience, `${label}.targetAudience`);
    boundedNonEmptyString(query.conversionGoal, `${label}.conversionGoal`);
    invariant(query.targetPage && typeof query.targetPage === 'object', `${label}.targetPage is required`);
    boundedNonEmptyString(query.targetPage.family, `${label}.targetPage.family`);
    boundedNonEmptyString(query.targetPage.url, `${label}.targetPage.url`, MAX_URL_BYTES);
    const entities = boundedArray(
      query.referenceEntities,
      `${label}.referenceEntities`,
      MAX_REFERENCE_ENTITIES,
    );
    for (const [entityIndex, entity] of entities.entries()) {
      const entityLabel = `${label}.referenceEntities[${entityIndex}]`;
      invariant(entity && typeof entity === 'object', `${entityLabel} must be an object`);
      boundedNonEmptyString(entity.role, `${entityLabel}.role`);
      boundedNonEmptyString(entity.name, `${entityLabel}.name`);
      boundedNonEmptyString(entity.url, `${entityLabel}.url`, MAX_URL_BYTES);
    }
  }
}

function isIsoCalendarDate(value) {
  if (!isNonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === value;
}

function assertIsoCalendarDate(value, field) {
  boundedString(value, field, 64);
  invariant(isIsoCalendarDate(value), `${field} must be an ISO calendar date`);
}

function assertIsoUtcDateTime(value, field) {
  boundedString(value, field, 64);
  invariant(
    isNonEmptyString(value)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      && Number.isFinite(Date.parse(value)),
    `${field} must be an ISO UTC date-time`,
  );
}

function observationDate(observedAt) {
  assertIsoUtcDateTime(observedAt, 'observedAt');
  return observedAt.slice(0, 10);
}

function dateMinusInclusiveDays(endDate, days) {
  const start = new Date(`${endDate}T00:00:00Z`).getTime() - ((days - 1) * UTC_DAY_MS);
  return new Date(start).toISOString().slice(0, 10);
}

export function deriveTrailingWindows(observedAt) {
  const endDate = observationDate(observedAt);
  return Object.entries(WINDOW_DAYS).map(([label, days]) => ({
    label,
    startDate: dateMinusInclusiveDays(endDate, days),
    endDate,
  }));
}

function finiteNumber(value, field, { nullable = true, maximum = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    invariant(nullable, `${field} is required`);
    return null;
  }
  invariant(
    typeof value === 'number' && Number.isFinite(value),
    `${field} must be a finite number or null`,
  );
  invariant(value >= 0, `${field} must be non-negative`);
  invariant(value <= maximum, `${field} is outside its allowed range`);
  return value;
}

function sourceValue(raw, key, aliases = []) {
  const record = raw?.metrics && typeof raw.metrics === 'object' ? raw.metrics : raw;
  for (const candidate of [key, ...aliases]) {
    if (record && candidate in record) return record[candidate];
    if (raw && candidate in raw) return raw[candidate];
  }
  return undefined;
}

function normalizeSearchMetrics(raw, { includeIndexedPages }) {
  return {
    indexedPages: includeIndexedPages
      ? finiteNumber(sourceValue(raw, 'indexedPages'), 'indexedPages')
      : null,
    impressions: finiteNumber(sourceValue(raw, 'impressions'), 'impressions'),
    clicks: finiteNumber(sourceValue(raw, 'clicks'), 'clicks'),
    ctr: finiteNumber(sourceValue(raw, 'ctr'), 'ctr', { maximum: 1 }),
    averagePosition: finiteNumber(
      sourceValue(raw, 'averagePosition', ['position']),
      'averagePosition',
    ),
  };
}

function aggregateSearchRows(rows, includeIndexedPages) {
  const metricSum = (metric) => (
    rows.length > 0 && rows.every(({ metrics }) => Number.isFinite(metrics[metric]))
      ? rows.reduce((total, row) => total + row.metrics[metric], 0)
      : null
  );
  const impressions = metricSum('impressions');
  const clicks = metricSum('clicks');
  const ctr = impressions !== null && clicks !== null
    ? (impressions > 0 ? clicks / impressions : 0)
    : null;
  const averagePosition = impressions !== null
    && impressions > 0
    && rows.every(({ metrics }) => (
      Number.isFinite(metrics.averagePosition)
      && Number.isFinite(metrics.impressions)
    ))
    ? rows.reduce(
      (total, row) => total + (row.metrics.averagePosition * row.metrics.impressions),
      0,
    ) / impressions
    : null;
  return {
    indexedPages: includeIndexedPages ? metricSum('indexedPages') : null,
    impressions,
    clicks,
    ctr,
    averagePosition,
  };
}

function mergeMetrics(explicit, aggregate) {
  return Object.fromEntries(
    SEARCH_METRICS.map((metric) => [
      metric,
      explicit[metric] ?? aggregate[metric],
    ]),
  );
}

function metricsAreComplete(metrics) {
  return SEARCH_METRICS.every((metric) => Number.isFinite(metrics[metric]));
}

function performanceMetricsAreComplete(metrics) {
  return SEARCH_PERFORMANCE_METRICS.every((metric) => Number.isFinite(metrics[metric]));
}

function canonicalWindows(rawWindows, observedAt, { requireTrailing = false } = {}) {
  const fallback = new Map(deriveTrailingWindows(observedAt).map((window) => [window.label, window]));
  const suppliedWindows = rawWindows === undefined || rawWindows === null
    ? null
    : boundedArray(rawWindows, 'windows', MAX_WINDOWS);
  const windows = suppliedWindows && suppliedWindows.length > 0
    ? suppliedWindows
    : [...fallback.values()];
  const labels = new Set();
  const normalized = windows.map((window, index) => {
    invariant(window && typeof window === 'object', `windows[${index}] must be an object`);
    const label = boundedNonEmptyString(window.label, `windows[${index}].label`);
    invariant(!labels.has(label), `duplicate window ${label}`);
    labels.add(label);
    const defaultWindow = fallback.get(label);
    const startDate = window.startDate ?? defaultWindow?.startDate;
    const endDate = window.endDate ?? defaultWindow?.endDate;
    assertIsoCalendarDate(startDate, `windows[${index}].startDate`);
    assertIsoCalendarDate(endDate, `windows[${index}].endDate`);
    invariant(
      Date.parse(startDate) <= Date.parse(endDate),
      `windows[${index}].startDate must not be after endDate`,
    );
    invariant(
      Date.parse(endDate) <= Date.parse(observationDate(observedAt)),
      `windows[${index}].endDate must not be after observedAt`,
    );
    return { label, startDate, endDate, raw: window };
  });
  if (requireTrailing) {
    for (const label of Object.keys(WINDOW_DAYS)) {
      invariant(labels.has(label), `source must include trailing ${label} window`);
    }
  }
  return normalized;
}

function unavailableSearchSource(observedAt, reason) {
  return {
    status: 'unavailable',
    property: null,
    reason,
    windows: deriveTrailingWindows(observedAt).map((window) => ({
      ...window,
      metrics: Object.fromEntries(SEARCH_METRICS.map((metric) => [metric, null])),
    })),
    queryRows: [],
    pageFamilyRows: [],
  };
}

function unavailableBingAiPerformance(observedAt, reason) {
  return {
    status: 'unavailable',
    reason,
    windows: deriveTrailingWindows(observedAt).map((window) => ({
      ...window,
      metrics: Object.fromEntries(BING_AI_METRICS.map((metric) => [metric, null])),
      groundingQueries: [],
      citedPages: [],
    })),
  };
}

function pageRoute(value, field) {
  boundedNonEmptyString(value, field, MAX_URL_BYTES);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[seo-visibility-collector] ${field} must be an HTTPS URL`);
  }
  invariant(parsed.protocol === 'https:', `${field} must be an HTTPS URL`);
  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${parsed.hostname}${normalizedPath}`;
}

function createQueryIndexes(querySet) {
  assertQuerySetBounds(querySet);
  const queryById = new Map(querySet.queries.map((query) => [query.id, query]));
  const queryByText = new Map(querySet.queries.map((query) => [query.query, query]));
  const pageFamiliesByRoute = new Map();
  for (const query of querySet.queries) {
    const route = pageRoute(query.targetPage.url, `${query.id}.targetPage.url`);
    const families = pageFamiliesByRoute.get(route) ?? new Set();
    families.add(query.targetPage.family);
    pageFamiliesByRoute.set(route, families);
  }
  return { queryById, queryByText, pageFamiliesByRoute };
}

function queryIdForRow(row, { queryById, queryByText }) {
  invariant(row && typeof row === 'object', 'imported query row must be an object');
  const declaredId = optionalBoundedString(row.queryId, 'queryId');
  const declaredText = optionalBoundedString(
    row.query ?? row.queryText,
    'query',
  );
  const query = declaredId ? queryById.get(declaredId) : queryByText.get(declaredText);
  invariant(query, 'imported row must reference an exact reviewed query text or queryId');
  if (declaredText !== null) {
    invariant(
      declaredText === query.query,
      `${declaredId ?? declaredText} must use exact reviewed query text`,
    );
  }
  return query.id;
}

function normalizePageFamily(row, { pageFamiliesByRoute }) {
  invariant(row && typeof row === 'object', 'page-family row must be an object');
  if (isNonEmptyString(row.pageFamily)) {
    const pageFamily = boundedString(row.pageFamily, 'pageFamily');
    invariant(PAGE_FAMILIES.includes(pageFamily), `unknown page family ${pageFamily}`);
    return pageFamily;
  }
  const page = optionalBoundedString(row.page ?? row.url, 'page', MAX_URL_BYTES);
  invariant(isNonEmptyString(page), 'page-family row requires page or pageFamily');
  const route = pageRoute(page, 'page');
  const families = pageFamiliesByRoute.get(route);
  invariant(families, `page does not map to a reviewed page family: ${page}`);
  invariant(
    families.size === 1,
    `page maps ambiguously to reviewed page families: ${page}`,
  );
  return families.values().next().value;
}

function hasBreakdownCoverage(rows, groupSelector, expectedGroups, windows) {
  const groupsByWindow = new Map(windows.map(({ label }) => [label, new Set()]));
  for (const row of rows) {
    groupsByWindow.get(row.windowLabel)?.add(groupSelector(row));
  }
  return [...groupsByWindow.values()].every((groups) => (
    [...expectedGroups].every((group) => groups.has(group))
  ));
}

function sourceStatus(requested, windows, queryRows, pageFamilyRows, querySet) {
  if (requested === 'unavailable') return 'unavailable';
  const complete = windows.every(({ metrics }) => metricsAreComplete(metrics))
    && queryRows.every(({ metrics }) => performanceMetricsAreComplete(metrics))
    && pageFamilyRows.every(({ metrics }) => metricsAreComplete(metrics))
    && hasBreakdownCoverage(
      queryRows,
      (row) => row.queryId,
      querySet.queries.map((query) => query.id),
      windows,
    )
    && hasBreakdownCoverage(
      pageFamilyRows,
      (row) => row.pageFamily,
      PAGE_FAMILIES,
      windows,
    );
  return requested === 'partial' || !complete ? 'partial' : 'available';
}

export function normalizeSearchExport(raw, { querySet, observedAt, provider = 'search' }) {
  if (!raw || raw.status === 'unavailable') {
    return unavailableSearchSource(
      observedAt,
      sourceReason(
        raw?.reason,
        `No supported ${provider} export was supplied.`,
        `${provider}.reason`,
      ),
    );
  }
  assertQuerySetBounds(querySet);
  const requestedStatus = sourceStatusValue(raw, `${provider} status`);
  const windows = canonicalWindows(raw.windows, observedAt, { requireTrailing: true });
  const queryIndexes = createQueryIndexes(querySet);
  const queryRows = [];
  const pageFamilyRows = [];
  const normalizedWindows = [];
  let totalRows = 0;
  for (const window of windows) {
    const rawWindow = window.raw;
    invariant(rawWindow && typeof rawWindow === 'object', `windows.${window.label} must be an object`);
    const rawQueryRows = optionalArray(
      rawWindow.queryRows,
      `windows.${window.label}.queryRows`,
      MAX_ROWS_PER_WINDOW,
    );
    const rawPageRows = optionalArray(
      rawWindow.pageFamilyRows ?? rawWindow.pageRows,
      `windows.${window.label}.pageFamilyRows`,
      MAX_ROWS_PER_WINDOW,
    );
    totalRows += rawQueryRows.length + rawPageRows.length;
    invariant(totalRows <= MAX_TOTAL_ROWS, `search breakdown rows exceed the ${MAX_TOTAL_ROWS}-row limit`);
    const normalizedQueryRows = rawQueryRows.map((row) => {
      const { indexedPages: _indexedPages, ...metrics } = normalizeSearchMetrics(
        row,
        { includeIndexedPages: false },
      );
      return {
        windowLabel: window.label,
        queryId: queryIdForRow(row, queryIndexes),
        metrics,
      };
    });
    const normalizedPageRows = rawPageRows.map((row) => ({
      windowLabel: window.label,
      pageFamily: normalizePageFamily(row, queryIndexes),
      metrics: normalizeSearchMetrics(row, { includeIndexedPages: true }),
    }));
    const explicitMetrics = normalizeSearchMetrics(rawWindow, { includeIndexedPages: true });
    const aggregate = aggregateSearchRows(normalizedQueryRows, false);
    const metrics = mergeMetrics(explicitMetrics, aggregate);
    queryRows.push(...normalizedQueryRows);
    pageFamilyRows.push(...normalizedPageRows);
    normalizedWindows.push({
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      metrics,
    });
  }
  const status = sourceStatus(
    requestedStatus,
    normalizedWindows,
    queryRows,
    pageFamilyRows,
    querySet,
  );
  return {
    status,
    property: null,
    reason: status === 'available'
      ? null
      : sourceReason(raw.reason, 'The imported provider data is partial.', `${provider}.reason`),
    windows: normalizedWindows,
    queryRows: status === 'unavailable' ? [] : queryRows,
    pageFamilyRows: status === 'unavailable' ? [] : pageFamilyRows,
  };
}

function normalizeBingAiWindow(window) {
  invariant(window && typeof window === 'object', 'Bing AI window must be an object');
  const totalCitations = finiteNumber(
    window.totalCitations ?? window.citationTotal,
    'totalCitations',
  );
  const averageCitedPages = finiteNumber(
    window.averageCitedPages,
    'averageCitedPages',
  );
  const groundingQueriesProvided = Array.isArray(window.groundingQueries);
  if (
    window.groundingQueries !== undefined
    && window.groundingQueries !== null
  ) {
    invariant(groundingQueriesProvided, 'groundingQueries must be an array');
  }
  const groundingQueries = optionalArray(
    window.groundingQueries,
    'groundingQueries',
    MAX_ROWS_PER_WINDOW,
  ).map((query, index) => {
    invariant(query && typeof query === 'object', `groundingQueries[${index}] must be an object`);
    const phrase = boundedNonEmptyString(
      query.phrase ?? query.query ?? query.groundingQuery,
      `groundingQueries[${index}].phrase`,
    );
    return {
      phrase,
    citationCount: finiteNumber(
      query.citationCount ?? query.citations ?? query.count,
      `groundingQueries[${index}].citationCount`,
    ),
    };
  });
  const citedPagesInput = Array.isArray(window.citedPages)
    ? window.citedPages
    : window.citedPages === undefined || window.citedPages === null
      ? window.citedUrls
      : null;
  const citedPagesProvided = Array.isArray(citedPagesInput);
  if (
    window.citedPages !== undefined
    && window.citedPages !== null
  ) {
    invariant(Array.isArray(window.citedPages), 'citedPages must be an array');
  }
  if (
    window.citedUrls !== undefined
    && window.citedUrls !== null
    && window.citedPages === undefined
  ) {
    invariant(Array.isArray(window.citedUrls), 'citedUrls must be an array');
  }
  const citedPages = optionalArray(
    citedPagesInput,
    'citedPages',
    MAX_ROWS_PER_WINDOW,
  ).map((page, index) => {
    invariant(page && typeof page === 'object', `citedPages[${index}] must be an object`);
    const url = boundedNonEmptyString(
      page.url ?? page.page,
      `citedPages[${index}].url`,
      MAX_URL_BYTES,
    );
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`[seo-visibility-collector] citedPages[${index}].url must be an HTTPS URL`);
    }
    invariant(parsed.protocol === 'https:', `citedPages[${index}].url must be an HTTPS URL`);
    invariant(
      parsed.username === '' && parsed.password === '',
      `citedPages[${index}].url must not contain credentials`,
    );
    invariant(
      isWorldMonitorUrl(parsed.toString()),
      `citedPages[${index}].url must be a World Monitor HTTPS URL`,
    );
    return {
      url: parsed.toString(),
      citationCount: finiteNumber(
        page.citationCount ?? page.citations ?? page.count,
        `citedPages[${index}].citationCount`,
      ),
    };
  });
  return {
    metrics: { totalCitations, averageCitedPages },
    groundingQueries: groundingQueriesProvided ? groundingQueries : null,
    citedPages: citedPagesProvided ? citedPages : null,
    groundingQueriesProvided,
    citedPagesProvided,
  };
}

export function normalizeBingAiPerformance(raw, { observedAt }) {
  if (!raw || raw.status === 'unavailable') {
    return unavailableBingAiPerformance(
      observedAt,
      sourceReason(
        raw?.reason,
        'No Bing AI Performance export was supplied.',
        'bingAiPerformance.reason',
      ),
    );
  }
  const requestedStatus = sourceStatusValue(raw, 'Bing AI Performance status');
  const windows = canonicalWindows(raw.windows, observedAt, { requireTrailing: true });
  const normalizedWindowsWithPresence = windows.map((window) => ({
    label: window.label,
    startDate: window.startDate,
    endDate: window.endDate,
    ...normalizeBingAiWindow(window.raw),
  }));
  const complete = normalizedWindowsWithPresence.every((window) => (
    BING_AI_METRICS.every((metric) => Number.isFinite(window.metrics[metric]))
      && window.groundingQueriesProvided
      && window.citedPagesProvided
  ));
  const status = requestedStatus === 'partial' || !complete
    ? 'partial'
    : 'available';
  return {
    status,
    reason: status === 'available'
      ? null
      : sourceReason(raw.reason, 'The imported Bing AI Performance data is partial.', 'bingAiPerformance.reason'),
    windows: normalizedWindowsWithPresence.map((window) => {
      const {
        groundingQueriesProvided: _groundingQueriesProvided,
        citedPagesProvided: _citedPagesProvided,
        ...normalizedWindow
      } = window;
      return normalizedWindow;
    }),
  };
}

function unavailableReferralExport(observedAt, classification, reason) {
  return {
    status: 'unavailable',
    property: null,
    reason,
    classification,
    windows: deriveTrailingWindows(observedAt).map((window) => ({
      ...window,
      metrics: Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null])),
    })),
    segments: [],
  };
}

function normalizeReferralClassification(classification) {
  invariant(
    classification && typeof classification === 'object',
    'referral classification is required',
  );
  const dimensions = normalizeStringArray(
    classification.dimensions,
    'referrals.classification.dimensions',
  );
  const families = boundedArray(
    classification.families,
    'referrals.classification.families',
  );
  return {
    dimensions,
    families: families.map((family, index) => {
      const label = `referrals.classification.families[${index}]`;
      invariant(family && typeof family === 'object', `${label} must be an object`);
      return {
        id: boundedNonEmptyString(family.id, `${label}.id`),
        label: boundedNonEmptyString(family.label, `${label}.label`),
        hostSuffixes: normalizeStringArray(family.hostSuffixes, `${label}.hostSuffixes`),
        utmSources: normalizeStringArray(family.utmSources, `${label}.utmSources`),
      };
    }),
  };
}

function normalizeReferrerFamily(value) {
  const family = boundedNonEmptyString(value, 'referrerFamily');
  invariant(REFERRER_FAMILIES.has(family), `unknown referrer family ${family}`);
  return family;
}

function normalizeLandingPageFamily(value) {
  const family = boundedNonEmptyString(value, 'landingPageFamily');
  invariant(PAGE_FAMILIES.includes(family), `unknown landing page family ${family}`);
  return family;
}

function eventMetric(row) {
  const rawEvent = row.event ?? row.eventName ?? null;
  const event = optionalBoundedString(rawEvent, 'event');
  if (event === 'pageview') {
    if (row.landingPageFamily === 'dashboard' || row.landingPageFamily === 'homepage') {
      return { metric: 'dashboardLaunches', quarantine: false };
    }
    if (row.landingPageFamily === 'pricing') {
      return { metric: 'pricingViews', quarantine: false };
    }
    return { metric: null, quarantine: false };
  }
  if (event === 'pro-activation-exit' || event === 'activation') {
    const completion = optionalBoundedString(row.completion, 'completion');
    return {
      metric: completion === 'complete' ? 'activations' : null,
      quarantine: false,
    };
  }
  if (event === 'api-action') {
    const action = optionalBoundedString(row.action ?? row.apiAction, 'api-action.action');
    return {
      metric: action !== null && API_ACTIONS.has(action) ? 'apiActions' : null,
      quarantine: action === null || !API_ACTIONS.has(action),
    };
  }
  if (event === 'api-key-created' || event === 'api-key-revoked') {
    const expectedAction = event === 'api-key-created' ? 'key-created' : 'key-revoked';
    const action = optionalBoundedString(row.action ?? row.apiAction, 'api-action.action');
    return {
      metric: action === null || action === expectedAction ? 'apiActions' : null,
      quarantine: action !== null && action !== expectedAction,
    };
  }
  return { metric: EVENT_METRICS[event] ?? null, quarantine: false };
}

function eventCount(row, field) {
  return finiteNumber(
    row.count ?? row.value ?? row.total,
    `${field}.count`,
    { nullable: false },
  );
}

function emptyReferralMetrics() {
  return Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null]));
}

function mergeReferralMetric(target, metric, value) {
  if (value === null) return;
  target[metric] = target[metric] === null ? value : target[metric] + value;
}

function normalizeReferralRows(rows, windowLabel) {
  const inputRows = boundedArray(rows, `windows.${windowLabel}.rows`, MAX_ROWS_PER_WINDOW);
  const segments = new Map();
  let omittedRows = 0;
  for (const [index, row] of inputRows.entries()) {
    if (
      !row
      || typeof row !== 'object'
      || !isNonEmptyString(row.referrerFamily)
      || !isNonEmptyString(row.landingPageFamily)
    ) {
      omittedRows += 1;
      continue;
    }
    const referrerFamily = normalizeReferrerFamily(row.referrerFamily);
    const landingPageFamily = normalizeLandingPageFamily(row.landingPageFamily);
    const key = `${referrerFamily}:${landingPageFamily}`;
    const metrics = segments.get(key) ?? {
      windowLabel,
      referrerFamily,
      landingPageFamily,
      metrics: emptyReferralMetrics(),
    };
    if (row.metrics && typeof row.metrics === 'object') {
      for (const metric of REFERRAL_METRICS) {
        const value = finiteNumber(row.metrics[metric], `rows[${index}].metrics.${metric}`);
        mergeReferralMetric(metrics.metrics, metric, value);
      }
    } else {
      const { metric, quarantine } = eventMetric(row);
      if (quarantine) {
        omittedRows += 1;
        continue;
      }
      if (metric) mergeReferralMetric(metrics.metrics, metric, eventCount(row, `rows[${index}]`));
    }
    segments.set(key, metrics);
  }
  return {
    segments: [...segments.values()].filter(({ metrics }) => (
      REFERRAL_METRICS.some((metric) => Number.isFinite(metrics[metric]))
    )),
    omittedRows,
  };
}

function aggregateReferralSegments(segments) {
  return Object.fromEntries(REFERRAL_METRICS.map((metric) => {
    const values = segments
      .map((segment) => segment.metrics[metric])
      .filter((value) => Number.isFinite(value));
    return [metric, values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null];
  }));
}

function normalizeStringArray(value, field, maximumLength = MAX_ARRAY_ITEMS) {
  const values = boundedArray(value, field, maximumLength);
  return values.map((item, index) => {
    return boundedNonEmptyString(item, `${field}[${index}]`);
  });
}

function normalizeCollectionContext(raw, fallback) {
  const context = raw ?? fallback;
  invariant(context && typeof context === 'object', 'collection context is required');
  return {
    geography: boundedNonEmptyString(context.geography, 'collectionContext.geography'),
    locale: boundedNonEmptyString(context.locale, 'collectionContext.locale'),
    signedInStates: normalizeStringArray(context.signedInStates, 'collectionContext.signedInStates'),
    device: boundedNonEmptyString(context.device, 'collectionContext.device'),
    limitations: normalizeStringArray(context.limitations, 'collectionContext.limitations'),
  };
}

function normalizeAiSurfaces(raw) {
  const surfaces = raw == null
    ? AI_PLATFORMS.map((platform) => ({
      platform,
      status: 'unavailable',
      reason: 'No current AI surface manifest was supplied.',
    }))
    : boundedArray(raw, 'aiSurfaces');
  return surfaces.map((surface, index) => {
    const label = `aiSurfaces[${index}]`;
    invariant(surface && typeof surface === 'object', `${label} must be an object`);
    const platform = boundedNonEmptyString(surface.platform, `${label}.platform`);
    const status = boundedNonEmptyString(surface.status, `${label}.status`);
    invariant(AVAILABILITY_STATES.has(status), `${label}.status must be available, partial, or unavailable`);
    return {
      platform,
      status,
      reason: optionalBoundedString(surface.reason, `${label}.reason`),
    };
  });
}

function normalizeAiObservations(raw, querySet) {
  if (raw == null) return [];
  const observations = boundedArray(raw, 'aiObservations', MAX_AI_OBSERVATIONS);
  assertQuerySetBounds(querySet);
  const queryIds = new Set(querySet.queries.map((query) => query.id));
  return observations.map((observation, index) => {
    invariant(observation && typeof observation === 'object', `aiObservations[${index}] must be an object`);
    const queryId = boundedNonEmptyString(observation.queryId, `aiObservations[${index}].queryId`);
    invariant(queryIds.has(queryId), `aiObservations[${index}].queryId is not reviewed`);
    // Whitelist the reviewed artifact fields. Raw prompts, account/session ids,
    // and provider payload extensions are intentionally not copied.
    return {
      queryId,
      platform: boundedNonEmptyString(observation.platform, `aiObservations[${index}].platform`),
      observedAt: boundedNonEmptyString(observation.observedAt, `aiObservations[${index}].observedAt`),
      geography: boundedNonEmptyString(observation.geography, `aiObservations[${index}].geography`),
      locale: boundedNonEmptyString(observation.locale, `aiObservations[${index}].locale`),
      signedInState: boundedNonEmptyString(observation.signedInState, `aiObservations[${index}].signedInState`),
      brandMention: observation.brandMention,
      directCitation: observation.directCitation,
      citedUrls: normalizeStringArray(observation.citedUrls, `aiObservations[${index}].citedUrls`),
      competitorsCited: normalizeStringArray(observation.competitorsCited, `aiObservations[${index}].competitorsCited`),
      sentiment: boundedNonEmptyString(observation.sentiment, `aiObservations[${index}].sentiment`),
      accuracy: boundedNonEmptyString(observation.accuracy, `aiObservations[${index}].accuracy`),
      summary: boundedNonEmptyString(observation.summary, `aiObservations[${index}].summary`),
      limitations: normalizeStringArray(observation.limitations, `aiObservations[${index}].limitations`),
    };
  });
}

function normalizeOpportunities(raw, fallback) {
  const opportunities = raw == null ? fallback : raw;
  const entries = boundedArray(opportunities, 'opportunities', MAX_OPPORTUNITIES);
  return entries.map((opportunity, index) => {
    const label = `opportunities[${index}]`;
    invariant(opportunity && typeof opportunity === 'object', `${label} must be an object`);
    return {
      priority: opportunity.priority,
      title: boundedNonEmptyString(opportunity.title, `${label}.title`),
      evidence: boundedNonEmptyString(opportunity.evidence, `${label}.evidence`),
      experiment: boundedNonEmptyString(opportunity.experiment, `${label}.experiment`),
      successCriteria: boundedNonEmptyString(
        opportunity.successCriteria,
        `${label}.successCriteria`,
      ),
      queryIds: normalizeStringArray(opportunity.queryIds, `${label}.queryIds`, MAX_QUERY_SET_ENTRIES),
    };
  });
}

export function normalizeReferralExport(raw, { observedAt, classification }) {
  const normalizedClassification = normalizeReferralClassification(classification);
  if (!raw || raw.status === 'unavailable') {
    return unavailableReferralExport(
      observedAt,
      normalizedClassification,
      sourceReason(
        raw?.reason,
        'No aggregate analytics export was supplied.',
        'referrals.reason',
      ),
    );
  }
  const requestedStatus = sourceStatusValue(raw, 'referrals status');
  const windows = canonicalWindows(raw.windows, observedAt);
  const segments = [];
  let omittedRows = 0;
  let totalRows = 0;
  const normalizedWindows = windows.map((window) => {
    invariant(window.raw && typeof window.raw === 'object', `windows.${window.label} must be an object`);
    const rawRows = optionalArray(
      window.raw.rows ?? window.raw.segments,
      `windows.${window.label}.rows`,
      MAX_ROWS_PER_WINDOW,
    );
    totalRows += rawRows.length;
    invariant(totalRows <= MAX_TOTAL_ROWS, `referral rows exceed the ${MAX_TOTAL_ROWS}-row limit`);
    const normalizedRows = normalizeReferralRows(rawRows, window.label);
    const windowSegments = normalizedRows.segments;
    omittedRows += normalizedRows.omittedRows;
    segments.push(...windowSegments);
    const explicitMetrics = Object.fromEntries(REFERRAL_METRICS.map((metric) => [
      metric,
      finiteNumber(window.raw.metrics?.[metric], `windows.${window.label}.metrics.${metric}`),
    ]));
    const aggregate = aggregateReferralSegments(windowSegments);
    const metrics = Object.fromEntries(REFERRAL_METRICS.map((metric) => [
      metric,
      explicitMetrics[metric] ?? aggregate[metric],
    ]));
    return {
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      metrics,
    };
  });
  const complete = normalizedWindows.every(({ metrics }) => (
    REFERRAL_METRICS.every((metric) => Number.isFinite(metrics[metric]))
  )) && omittedRows === 0;
  const status = requestedStatus === 'partial' || !complete
    ? 'partial'
    : 'available';
  return {
    status,
    property: null,
    reason: status === 'available'
      ? null
      : sourceReason(raw.reason, 'The imported analytics data is partial.', 'referrals.reason'),
    classification: normalizedClassification,
    windows: normalizedWindows,
    segments,
  };
}

function revisionFromGit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function collectBaseline({
  template,
  querySet,
  sources,
  observedAt,
  repositoryRevision = revisionFromGit(),
}) {
  invariant(template && typeof template === 'object', 'baseline template is required');
  assertQuerySetBounds(querySet);
  invariant(sources && typeof sources === 'object', 'source manifest is required');
  assertIsoUtcDateTime(observedAt, 'observedAt');
  invariant(
    repositoryRevision !== null
      && repositoryRevision !== undefined
      && repositoryRevision !== 'unknown-local-revision',
    'repositoryRevision must be supplied when the local git revision is unavailable',
  );
  const normalizedRevision = boundedNonEmptyString(repositoryRevision, 'repositoryRevision');

  const googleSearchConsole = normalizeSearchExport(
    sources.googleSearchConsole,
    { querySet, observedAt, provider: 'Google Search Console' },
  );
  const bingSource = sources.bingWebmaster ?? {};
  const bingWebmaster = normalizeSearchExport(
    bingSource.search ?? bingSource,
    { querySet, observedAt, provider: 'Bing Webmaster' },
  );
  bingWebmaster.aiPerformance = normalizeBingAiPerformance(
    bingSource.aiPerformance ?? sources.bingAiPerformance,
    { observedAt },
  );
  const referrals = normalizeReferralExport(sources.referrals, {
    observedAt,
    classification: template.referrals?.classification,
  });

  const collectionContext = normalizeCollectionContext(
    sources.collectionContext,
    template.collectionContext,
  );
  const aiSurfaces = normalizeAiSurfaces(sources.aiSurfaces);
  const aiObservations = normalizeAiObservations(sources.aiObservations, querySet);
  const opportunities = normalizeOpportunities(sources.opportunities, template.opportunities);
  const guardrails = normalizeStringArray(template.guardrails, 'template.guardrails');
  const baseline = {
    schemaVersion: template.schemaVersion,
    baselineId: observedAt.slice(0, 10),
    querySetId: querySet.querySetId,
    querySetDigest: computeQuerySetDigest(querySet),
    observedAt,
    repositoryRevision: normalizedRevision,
    collectionContext,
    search: { googleSearchConsole, bingWebmaster },
    referrals,
    aiSurfaces,
    aiObservations,
    opportunities,
    guardrails,
  };
  if (aiObservations.length === 0) {
    const limitation = 'No manual AI-answer observations were supplied for this collection run.';
    if (!collectionContext.limitations.includes(limitation)) {
      invariant(
        collectionContext.limitations.length < MAX_ARRAY_ITEMS,
        'collectionContext.limitations exceeds the item limit',
      );
      collectionContext.limitations = [
        ...collectionContext.limitations,
        limitation,
      ];
    }
  }

  validateBaseline(baseline, querySet);
  return baseline;
}

function parseArgs(args) {
  boundedArray(args, 'CLI arguments', MAX_ARRAY_ITEMS);
  const options = { check: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    invariant(
      ['--queries', '--template', '--sources', '--observed-at', '--output', '--repository-revision']
        .includes(argument),
      `unknown argument ${argument}`,
    );
    const value = args[index + 1];
    boundedNonEmptyString(value, `${argument} value`, MAX_URL_BYTES);
    options[argument.slice(2).replaceAll('-', '_')] = value;
    index += 1;
  }
  for (const required of ['queries', 'template', 'sources', 'observed_at']) {
    invariant(options[required], `--${required.replaceAll('_', '-')} is required`);
  }
  if (options.check) invariant(options.output, '--check requires --output');
  return options;
}

function readJson(path) {
  const descriptor = openSync(resolve(path), 'r');
  try {
    const contents = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
    const bytesRead = readSync(descriptor, contents, 0, contents.length, 0);
    invariant(bytesRead <= MAX_INPUT_BYTES, `${path} exceeds the ${MAX_INPUT_BYTES}-byte input limit`);
    return JSON.parse(contents.subarray(0, bytesRead).toString('utf8'));
  } finally {
    closeSync(descriptor);
  }
}

export async function runCli(args) {
  const options = parseArgs(args);
  const querySet = readJson(options.queries);
  const template = readJson(options.template);
  const sources = readJson(options.sources);
  const baseline = collectBaseline({
    template,
    querySet,
    sources,
    observedAt: options.observed_at,
    repositoryRevision: options.repository_revision ?? revisionFromGit(),
  });
  const serialized = `${JSON.stringify(baseline, null, 2)}\n`;
  if (!options.output) {
    process.stdout.write(serialized);
    return serialized;
  }
  const outputPath = resolve(options.output);
  if (options.check) {
    invariant(
      readFileSync(outputPath, 'utf8') === serialized,
      `${options.output} is stale; regenerate it without --check`,
    );
    return serialized;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  return serialized;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
