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
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import {
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
  activation: 'activations',
  'api-action': 'apiActions',
  'api-key-created': 'apiActions',
  'api-key-revoked': 'apiActions',
  'mcp-connect-success': 'mcpActions',
});

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-visibility-collector] ${message}`);
}

function isIsoCalendarDate(value) {
  if (!isNonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === value;
}

function assertIsoCalendarDate(value, field) {
  invariant(isIsoCalendarDate(value), `${field} must be an ISO calendar date`);
}

function assertIsoUtcDateTime(value, field) {
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
  const windows = Array.isArray(rawWindows) && rawWindows.length > 0
    ? rawWindows
    : [...fallback.values()];
  const labels = new Set();
  const normalized = windows.map((window, index) => {
    invariant(window && typeof window === 'object', `windows[${index}] must be an object`);
    const label = window.label;
    invariant(isNonEmptyString(label), `windows[${index}].label is required`);
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
  const queryById = new Map(querySet.queries.map((query) => [query.id, query]));
  const queryByText = new Map(querySet.queries.map((query) => [query.query, query]));
  const pageFamilyByRoute = new Map();
  for (const query of querySet.queries) {
    const route = pageRoute(query.targetPage.url, `${query.id}.targetPage.url`);
    if (!pageFamilyByRoute.has(route)) pageFamilyByRoute.set(route, query.targetPage.family);
  }
  return { queryById, queryByText, pageFamilyByRoute };
}

function queryIdForRow(row, { queryById, queryByText }) {
  const declaredId = row.queryId ?? null;
  const declaredText = row.query ?? row.queryText ?? null;
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

function normalizePageFamily(row, { pageFamilyByRoute }) {
  if (isNonEmptyString(row.pageFamily)) {
    invariant(PAGE_FAMILIES.includes(row.pageFamily), `unknown page family ${row.pageFamily}`);
    return row.pageFamily;
  }
  const page = row.page ?? row.url ?? null;
  invariant(isNonEmptyString(page), 'page-family row requires page or pageFamily');
  const family = pageFamilyByRoute.get(pageRoute(page, 'page'));
  invariant(family, `page does not map to a reviewed page family: ${page}`);
  return family;
}

function sourceStatus(raw, windows, queryRows, pageFamilyRows) {
  if (raw?.status === 'unavailable') return 'unavailable';
  const requested = raw?.status === 'partial' ? 'partial' : 'available';
  const complete = windows.every(({ metrics }) => metricsAreComplete(metrics))
    && queryRows.every(({ metrics }) => performanceMetricsAreComplete(metrics))
    && pageFamilyRows.every(({ metrics }) => metricsAreComplete(metrics));
  return requested === 'partial' || !complete ? 'partial' : 'available';
}

export function normalizeSearchExport(raw, { querySet, observedAt, provider = 'search' }) {
  if (!raw || raw.status === 'unavailable') {
    return unavailableSearchSource(
      observedAt,
      raw?.reason ?? `No supported ${provider} export was supplied.`,
    );
  }
  const windows = canonicalWindows(raw.windows, observedAt, { requireTrailing: true });
  const queryIndexes = createQueryIndexes(querySet);
  const queryRows = [];
  const pageFamilyRows = [];
  const normalizedWindows = [];
  for (const window of windows) {
    const rawWindow = window.raw;
    const normalizedQueryRows = (rawWindow.queryRows ?? []).map((row) => {
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
    const normalizedPageRows = (rawWindow.pageFamilyRows ?? rawWindow.pageRows ?? []).map((row) => ({
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
  const status = sourceStatus(raw, normalizedWindows, queryRows, pageFamilyRows);
  return {
    status,
    property: null,
    reason: status === 'available' ? null : (raw.reason ?? 'The imported provider data is partial.'),
    windows: normalizedWindows,
    queryRows: status === 'unavailable' ? [] : queryRows,
    pageFamilyRows: status === 'unavailable' ? [] : pageFamilyRows,
  };
}

function normalizeBingAiWindow(window) {
  const totalCitations = finiteNumber(
    window.totalCitations ?? window.citationTotal,
    'totalCitations',
  );
  const averageCitedPages = finiteNumber(
    window.averageCitedPages,
    'averageCitedPages',
  );
  const groundingQueries = (window.groundingQueries ?? []).map((query, index) => ({
    phrase: query.phrase ?? query.query ?? query.groundingQuery,
    citationCount: finiteNumber(
      query.citationCount ?? query.citations ?? query.count,
      `groundingQueries[${index}].citationCount`,
    ),
  }));
  const citedPages = (window.citedPages ?? window.citedUrls ?? []).map((page, index) => {
    const url = page.url ?? page.page;
    invariant(isNonEmptyString(url), `citedPages[${index}].url is required`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`[seo-visibility-collector] citedPages[${index}].url must be an HTTPS URL`);
    }
    invariant(
      parsed.protocol === 'https:' && isWorldMonitorUrl(url),
      `citedPages[${index}].url must be a World Monitor HTTPS URL`,
    );
    return {
      url,
      citationCount: finiteNumber(
        page.citationCount ?? page.citations ?? page.count,
        `citedPages[${index}].citationCount`,
      ),
    };
  });
  return {
    metrics: { totalCitations, averageCitedPages },
    groundingQueries,
    citedPages,
  };
}

export function normalizeBingAiPerformance(raw, { observedAt }) {
  if (!raw || raw.status === 'unavailable') {
    return unavailableBingAiPerformance(
      observedAt,
      raw?.reason ?? 'No Bing AI Performance export was supplied.',
    );
  }
  const windows = canonicalWindows(raw.windows, observedAt, { requireTrailing: true });
  const normalizedWindows = windows.map((window) => ({
    label: window.label,
    startDate: window.startDate,
    endDate: window.endDate,
    ...normalizeBingAiWindow(window.raw),
  }));
  const complete = normalizedWindows.every(({ metrics }) => (
    BING_AI_METRICS.every((metric) => Number.isFinite(metrics[metric]))
  ));
  const status = raw.status === 'partial' || !complete ? 'partial' : 'available';
  return {
    status,
    reason: status === 'available' ? null : (raw.reason ?? 'The imported Bing AI Performance data is partial.'),
    windows: normalizedWindows,
  };
}

function unavailableReferralExport(observedAt, classification, reason) {
  return {
    status: 'unavailable',
    property: null,
    reason,
    classification: structuredClone(classification),
    windows: deriveTrailingWindows(observedAt).map((window) => ({
      ...window,
      metrics: Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null])),
    })),
    segments: [],
  };
}

function normalizeReferrerFamily(value) {
  const family = value ?? 'unknown_direct';
  invariant(REFERRER_FAMILIES.has(family), `unknown referrer family ${family}`);
  return family;
}

function normalizeLandingPageFamily(value) {
  invariant(PAGE_FAMILIES.includes(value), `unknown landing page family ${value}`);
  return value;
}

function eventMetric(row) {
  const event = row.event ?? row.eventName ?? null;
  if (event === 'pageview') {
    if (row.landingPageFamily === 'dashboard' || row.landingPageFamily === 'homepage') {
      return 'dashboardLaunches';
    }
    if (row.landingPageFamily === 'pricing') return 'pricingViews';
    return null;
  }
  if (event === 'pro-activation-exit' && row.completion !== 'complete') return null;
  return EVENT_METRICS[event] ?? null;
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
  const segments = new Map();
  for (const [index, row] of rows.entries()) {
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
      const metric = eventMetric(row);
      if (metric) mergeReferralMetric(metrics.metrics, metric, eventCount(row, `rows[${index}]`));
    }
    segments.set(key, metrics);
  }
  return [...segments.values()].filter(({ metrics }) => (
    REFERRAL_METRICS.some((metric) => Number.isFinite(metrics[metric]))
  ));
}

function aggregateReferralSegments(segments) {
  return Object.fromEntries(REFERRAL_METRICS.map((metric) => {
    const values = segments
      .map((segment) => segment.metrics[metric])
      .filter((value) => Number.isFinite(value));
    return [metric, values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null];
  }));
}

function normalizeStringArray(value, field) {
  invariant(Array.isArray(value), `${field} must be an array`);
  return value.map((item, index) => {
    invariant(isNonEmptyString(item), `${field}[${index}] must be a non-empty string`);
    return item;
  });
}

function normalizeCollectionContext(raw, fallback) {
  const context = raw ?? fallback;
  invariant(context && typeof context === 'object', 'collection context is required');
  return {
    geography: context.geography,
    locale: context.locale,
    signedInStates: normalizeStringArray(context.signedInStates, 'collectionContext.signedInStates'),
    device: context.device,
    limitations: normalizeStringArray(context.limitations, 'collectionContext.limitations'),
  };
}

function normalizeAiSurfaces(raw, fallback) {
  const surfaces = raw ?? fallback;
  invariant(Array.isArray(surfaces), 'AI surface manifest is required');
  return surfaces.map((surface) => ({
    platform: surface.platform,
    status: surface.status,
    reason: surface.reason ?? null,
  }));
}

function normalizeAiObservations(raw, querySet) {
  if (raw == null) return [];
  invariant(Array.isArray(raw), 'aiObservations must be an array');
  const queryIds = new Set(querySet.queries.map((query) => query.id));
  return raw.map((observation, index) => {
    invariant(observation && typeof observation === 'object', `aiObservations[${index}] must be an object`);
    invariant(queryIds.has(observation.queryId), `aiObservations[${index}].queryId is not reviewed`);
    // Whitelist the reviewed artifact fields. Raw prompts, account/session ids,
    // and provider payload extensions are intentionally not copied.
    return {
      queryId: observation.queryId,
      platform: observation.platform,
      observedAt: observation.observedAt,
      geography: observation.geography,
      locale: observation.locale,
      signedInState: observation.signedInState,
      brandMention: observation.brandMention,
      directCitation: observation.directCitation,
      citedUrls: normalizeStringArray(observation.citedUrls, `aiObservations[${index}].citedUrls`),
      competitorsCited: normalizeStringArray(observation.competitorsCited, `aiObservations[${index}].competitorsCited`),
      sentiment: observation.sentiment,
      accuracy: observation.accuracy,
      summary: observation.summary,
      limitations: normalizeStringArray(observation.limitations, `aiObservations[${index}].limitations`),
    };
  });
}

export function normalizeReferralExport(raw, { observedAt, classification }) {
  invariant(classification && typeof classification === 'object', 'referral classification is required');
  if (!raw || raw.status === 'unavailable') {
    return unavailableReferralExport(
      observedAt,
      classification,
      raw?.reason ?? 'No aggregate analytics export was supplied.',
    );
  }
  const windows = canonicalWindows(raw.windows, observedAt);
  const segments = [];
  const normalizedWindows = windows.map((window) => {
    const windowSegments = normalizeReferralRows(
      window.raw.rows ?? window.raw.segments ?? [],
      window.label,
    );
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
  ));
  const status = raw.status === 'partial' || !complete ? 'partial' : 'available';
  return {
    status,
    property: null,
    reason: status === 'available' ? null : (raw.reason ?? 'The imported analytics data is partial.'),
    classification: structuredClone(classification),
    windows: normalizedWindows,
    segments,
  };
}

function revisionFromGit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown-local-revision';
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
  invariant(querySet && typeof querySet === 'object', 'query set is required');
  invariant(sources && typeof sources === 'object', 'source manifest is required');
  assertIsoUtcDateTime(observedAt, 'observedAt');

  const baseline = structuredClone(template);
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
    classification: template.referrals.classification,
  });

  baseline.baselineId = observedAt.slice(0, 10);
  baseline.querySetId = querySet.querySetId;
  baseline.querySetDigest = computeQuerySetDigest(querySet);
  baseline.observedAt = observedAt;
  baseline.repositoryRevision = repositoryRevision;
  baseline.collectionContext = normalizeCollectionContext(
    sources.collectionContext,
    template.collectionContext,
  );
  baseline.search = { googleSearchConsole, bingWebmaster };
  baseline.referrals = referrals;
  baseline.aiSurfaces = normalizeAiSurfaces(sources.aiSurfaces, template.aiSurfaces);
  baseline.aiObservations = normalizeAiObservations(sources.aiObservations, querySet);
  baseline.opportunities = structuredClone(sources.opportunities ?? template.opportunities);
  if (baseline.aiObservations.length === 0) {
    const limitation = 'No manual AI-answer observations were supplied for this collection run.';
    if (!baseline.collectionContext.limitations.includes(limitation)) {
      baseline.collectionContext.limitations = [
        ...baseline.collectionContext.limitations,
        limitation,
      ];
    }
  }

  validateBaseline(baseline, querySet);
  return baseline;
}

function parseArgs(args) {
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
    invariant(isNonEmptyString(value), `${argument} requires a value`);
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
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
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
