#!/usr/bin/env node
/**
 * Validate and render the file-based SEO / AI-citation visibility scorecard.
 *
 * This is intentionally a local, file-based pipeline:
 * - supported Search Console/Bing/analytics exports are normalized before use;
 * - unavailable inputs remain null and carry a reason;
 * - manual AI observations distinguish a brand mention from a direct citation;
 * - no search-result scraping or credentials are introduced.
 *
 * Usage:
 *   node scripts/seo-ai-visibility-scorecard.mjs \
 *     --queries docs/research/seo-ai-visibility/query-set.json \
 *     --baseline docs/research/seo-ai-visibility/baselines/2026-07-27.json \
 *     --output docs/research/seo-ai-visibility/scorecards/2026-07-27.md
 *
 * Optional:
 *   --previous <baseline.json>  include a monthly new/lost citation comparison
 *   --check                     fail when --output differs from generated content
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { isMainModule } from './lib/main-module.mjs';

const defineDomain = (entries) => Object.freeze(
  entries.map(([id, label]) => Object.freeze({ id, label })),
);
const domainIds = (domain) => Object.freeze(domain.map(({ id }) => id));
const domainLabels = (domain) => Object.freeze(Object.fromEntries(
  domain.map(({ id, label }) => [id, label]),
));

const AI_PLATFORM_DOMAIN = defineDomain([
  ['chatgpt_search', 'ChatGPT Search'],
  ['perplexity', 'Perplexity'],
  ['google_ai', 'Google AI Overview'],
  ['copilot_search', 'Copilot Search'],
]);
const PAGE_FAMILY_DOMAIN = defineDomain([
  ['homepage', 'Homepage'],
  ['dashboard', 'Dashboard'],
  ['blog', 'Blog'],
  ['documentation', 'Documentation'],
  ['country_pages', 'Country pages'],
  ['chokepoints', 'Chokepoints'],
  ['crises', 'Crises'],
  ['tools', 'Tools'],
  ['pricing', 'Pricing'],
  ['developer_mcp', 'Developer / MCP'],
]);
const INTENT_DOMAIN = defineDomain([
  ['category_definition', 'Category / definition'],
  ['use_case', 'Use case'],
  ['developer_agent', 'Developer / agent'],
  ['evaluation', 'Evaluation'],
  ['branded_entity', 'Branded / entity'],
]);

export const AI_PLATFORMS = domainIds(AI_PLATFORM_DOMAIN);
export const PAGE_FAMILIES = domainIds(PAGE_FAMILY_DOMAIN);
const INTENTS = domainIds(INTENT_DOMAIN);

const AVAILABILITY_STATES = new Set(['available', 'partial', 'unavailable']);
const SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'mixed']);
const ACCURACY_STATES = new Set(['accurate', 'mixed', 'inaccurate', 'unverified']);
const REFERENCE_ROLES = new Set(['competitor', 'source']);
const SEARCH_METRICS = Object.freeze([
  'indexedPages',
  'impressions',
  'clicks',
  'ctr',
  'averagePosition',
]);
const SEARCH_PERFORMANCE_METRICS = Object.freeze([
  'impressions',
  'clicks',
  'ctr',
  'averagePosition',
]);
const REFERRAL_METRICS = Object.freeze([
  'sessions',
  'dashboardLaunches',
  'pricingViews',
  'signUps',
  'proConversions',
  'apiActions',
  'mcpActions',
]);

const PLATFORM_LABELS = domainLabels(AI_PLATFORM_DOMAIN);
const PAGE_FAMILY_LABELS = domainLabels(PAGE_FAMILY_DOMAIN);
const INTENT_LABELS = domainLabels(INTENT_DOMAIN);

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-visibility] ${message}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function assertIsoCalendarDate(value, field) {
  invariant(
    isNonEmptyString(value) && isIsoCalendarDate(value),
    `${field} must be an ISO calendar date (YYYY-MM-DD)`,
  );
}

function assertIsoUtcDateTime(value, field) {
  const match = isNonEmptyString(value)
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value)
    : null;
  invariant(
    match
      && isIsoCalendarDate(match[1])
      && Number(match[2]) <= 23
      && Number(match[3]) <= 59
      && Number(match[4]) <= 59
      && Number.isFinite(Date.parse(value)),
    `${field} must be an ISO UTC date-time`,
  );
}

export function computeQuerySetDigest(querySet) {
  const queries = [...querySet.queries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((query) => ({
      id: query.id,
      query: query.query,
      intent: query.intent,
      targetAudience: query.targetAudience,
      targetPage: {
        family: query.targetPage.family,
        url: query.targetPage.url,
      },
      conversionGoal: query.conversionGoal,
      referenceEntities: [...query.referenceEntities]
        .sort((left, right) => (
          `${left.role}:${left.name}:${left.url}`
            .localeCompare(`${right.role}:${right.name}:${right.url}`)
        ))
        .map((entity) => ({
          role: entity.role,
          name: entity.name,
          url: entity.url,
        })),
    }));
  const contract = JSON.stringify({
    schemaVersion: querySet.schemaVersion,
    querySetId: querySet.querySetId,
    queries,
  });
  return `sha256:${createHash('sha256').update(contract).digest('hex')}`;
}

function assertNullableMetrics(metrics, metricNames, label, status) {
  invariant(metrics && typeof metrics === 'object', `${label}.metrics is required`);
  for (const metric of metricNames) {
    invariant(metric in metrics, `${label}.metrics.${metric} is required`);
    const value = metrics[metric];
    invariant(
      value === null || (typeof value === 'number' && Number.isFinite(value)),
      `${label}.metrics.${metric} must be a finite number or null`,
    );
    if (value !== null) {
      invariant(
        value >= 0,
        `${label}.metrics.${metric} must be non-negative`,
      );
      if (metric === 'ctr') {
        invariant(
          value <= 1,
          `${label}.metrics.ctr must be between 0 and 1`,
        );
      }
    }
    if (status === 'unavailable') {
      invariant(
        value === null,
        `${label}: unavailable metrics must be null (${metric})`,
      );
    } else if (status === 'available') {
      invariant(
        typeof value === 'number' && Number.isFinite(value),
        `${label}: available metrics must be finite numbers (${metric})`,
      );
    }
  }
}

function validateWindowedSource(
  source,
  metricNames,
  label,
  latestEndDate,
) {
  invariant(source && typeof source === 'object', `${label} is required`);
  invariant(
    source.property === null,
    `${label}.property must remain null in committed artifacts`,
  );
  invariant(
    AVAILABILITY_STATES.has(source.status),
    `${label}.status must be available, partial, or unavailable`,
  );
  if (source.status !== 'available') {
    invariant(isNonEmptyString(source.reason), `${label}.reason is required`);
  }
  invariant(Array.isArray(source.windows) && source.windows.length > 0, `${label}.windows is required`);
  const windowLabels = source.windows.map(({ label: windowLabel }) => windowLabel);
  invariant(
    new Set(windowLabels).size === windowLabels.length,
    `${label}.window labels must be unique`,
  );
  for (const [index, window] of source.windows.entries()) {
    const windowLabel = `${label}.windows[${index}]`;
    invariant(isNonEmptyString(window.label), `${windowLabel}.label is required`);
    assertIsoCalendarDate(window.startDate, `${windowLabel}.startDate`);
    assertIsoCalendarDate(window.endDate, `${windowLabel}.endDate`);
    const start = Date.parse(window.startDate);
    const end = Date.parse(window.endDate);
    invariant(start <= end, `${windowLabel}.startDate must not be after endDate`);
    if (latestEndDate !== undefined) {
      invariant(
        end <= Date.parse(latestEndDate),
        `${windowLabel}.endDate must not be after the baseline observation date`,
      );
    }
    const numericLabel = /^(\d+)d$/.exec(window.label);
    if (numericLabel) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      const startDay = Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
      );
      const endDay = Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate(),
      );
      const inclusiveDays = ((endDay - startDay) / 86_400_000) + 1;
      invariant(
        Number(numericLabel[1]) === inclusiveDays,
        `${windowLabel}.label must match the inclusive calendar-day span`,
      );
    }
    assertNullableMetrics(window.metrics, metricNames, windowLabel, source.status);
  }
}

function validateSearchSource(source, label, queryIds, latestEndDate) {
  validateWindowedSource(source, SEARCH_METRICS, label, latestEndDate);
  const windowLabels = new Set(source.windows.map(({ label: windowLabel }) => windowLabel));
  const rowContracts = [
    {
      field: 'queryRows',
      groupField: 'queryId',
      groupIds: queryIds,
      metrics: SEARCH_PERFORMANCE_METRICS,
    },
    {
      field: 'pageFamilyRows',
      groupField: 'pageFamily',
      groupIds: new Set(PAGE_FAMILIES),
      metrics: SEARCH_METRICS,
    },
  ];
  for (const contract of rowContracts) {
    const rows = source[contract.field];
    invariant(Array.isArray(rows), `${label}.${contract.field} must be an array`);
    if (source.status === 'unavailable') {
      invariant(
        rows.length === 0,
        `${label}.${contract.field} must be empty when the source is unavailable`,
      );
    }
    const rowKeys = new Set();
    for (const [index, row] of rows.entries()) {
      const rowLabel = `${label}.${contract.field}[${index}]`;
      invariant(
        windowLabels.has(row.windowLabel),
        `${rowLabel}.windowLabel must reference a source window`,
      );
      invariant(
        contract.groupIds.has(row[contract.groupField]),
        `${rowLabel}.${contract.groupField} is invalid`,
      );
      const rowKey = `${row.windowLabel}:${row[contract.groupField]}`;
      invariant(!rowKeys.has(rowKey), `${label}.${contract.field} has duplicate ${rowKey}`);
      rowKeys.add(rowKey);
      assertNullableMetrics(row.metrics, contract.metrics, rowLabel, source.status);
    }
  }
}

function validateReferralSegments(referrals, referrerFamilyIds) {
  invariant(Array.isArray(referrals.segments), 'referrals.segments must be an array');
  if (referrals.status === 'unavailable') {
    invariant(
      referrals.segments.length === 0,
      'referrals.segments must be empty when referrals are unavailable',
    );
  }
  const windowLabels = new Set(referrals.windows.map(({ label }) => label));
  const segmentKeys = new Set();
  for (const [index, segment] of referrals.segments.entries()) {
    const label = `referrals.segments[${index}]`;
    invariant(
      windowLabels.has(segment.windowLabel),
      `${label}.windowLabel must reference a referral window`,
    );
    invariant(
      referrerFamilyIds.has(segment.referrerFamily),
      `${label}.referrerFamily is invalid`,
    );
    invariant(
      PAGE_FAMILIES.includes(segment.landingPageFamily),
      `${label}.landingPageFamily is invalid`,
    );
    const segmentKey = [
      segment.windowLabel,
      segment.referrerFamily,
      segment.landingPageFamily,
    ].join(':');
    invariant(!segmentKeys.has(segmentKey), `duplicate referral segment ${segmentKey}`);
    segmentKeys.add(segmentKey);
    assertNullableMetrics(segment.metrics, REFERRAL_METRICS, label, referrals.status);
  }
}

function isWorldMonitorUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'worldmonitor.app'
      || url.hostname.endsWith('.worldmonitor.app');
  } catch {
    return false;
  }
}

function validateAiSurfaces(aiSurfaces) {
  invariant(Array.isArray(aiSurfaces), 'aiSurfaces must be an array');
  invariant(
    aiSurfaces.length === AI_PLATFORMS.length,
    'aiSurfaces must contain every supported platform exactly once',
  );
  const platforms = new Set();
  for (const [index, surface] of aiSurfaces.entries()) {
    const label = `aiSurfaces[${index}]`;
    invariant(AI_PLATFORMS.includes(surface.platform), `${label}.platform is invalid`);
    invariant(!platforms.has(surface.platform), `duplicate AI surface ${surface.platform}`);
    platforms.add(surface.platform);
    invariant(
      AVAILABILITY_STATES.has(surface.status),
      `${label}.status must be available, partial, or unavailable`,
    );
    if (surface.status !== 'available') {
      invariant(isNonEmptyString(surface.reason), `${label}.reason is required`);
    }
  }
  for (const platform of AI_PLATFORMS) {
    invariant(platforms.has(platform), `aiSurfaces is missing ${platform}`);
  }
  return new Map(aiSurfaces.map((surface) => [surface.platform, surface]));
}

export function validateQuerySet(querySet) {
  invariant(querySet?.schemaVersion === 1, 'query set schemaVersion must be 1');
  invariant(isNonEmptyString(querySet.querySetId), 'querySetId is required');
  assertIsoCalendarDate(querySet.reviewedAt, 'reviewedAt');
  invariant(
    Array.isArray(querySet.queries)
      && querySet.queries.length >= 20
      && querySet.queries.length <= 30,
    'queries must contain 20-30 reviewed entries',
  );

  const ids = new Set();
  const intents = new Set();
  const pageFamilies = new Set();
  for (const [index, query] of querySet.queries.entries()) {
    const label = `queries[${index}]`;
    invariant(isNonEmptyString(query.id), `${label}.id is required`);
    invariant(!ids.has(query.id), `duplicate query id: ${query.id}`);
    ids.add(query.id);
    invariant(isNonEmptyString(query.query), `${query.id}.query is required`);
    invariant(INTENTS.includes(query.intent), `${query.id}.intent is invalid`);
    intents.add(query.intent);
    invariant(isNonEmptyString(query.targetAudience), `${query.id}.targetAudience is required`);
    invariant(isNonEmptyString(query.conversionGoal), `${query.id}.conversionGoal is required`);
    invariant(
      PAGE_FAMILIES.includes(query.targetPage?.family),
      `${query.id}.targetPage.family is invalid`,
    );
    pageFamilies.add(query.targetPage.family);
    invariant(
      isNonEmptyString(query.targetPage.url) && query.targetPage.url.startsWith('https://'),
      `${query.id}.targetPage.url must be HTTPS`,
    );
    invariant(
      Array.isArray(query.referenceEntities) && query.referenceEntities.length > 0,
      `${query.id}.referenceEntities must contain at least one named competitor/source`,
    );
    for (const [entityIndex, entity] of query.referenceEntities.entries()) {
      invariant(
        REFERENCE_ROLES.has(entity.role),
        `${query.id}.referenceEntities[${entityIndex}].role is invalid`,
      );
      invariant(
        isNonEmptyString(entity.name),
        `${query.id}.referenceEntities[${entityIndex}].name is required`,
      );
      invariant(
        isNonEmptyString(entity.url) && entity.url.startsWith('https://'),
        `${query.id}.referenceEntities[${entityIndex}].url must be HTTPS`,
      );
    }
  }

  for (const intent of INTENTS) {
    invariant(intents.has(intent), `query set is missing intent ${intent}`);
  }
  for (const family of PAGE_FAMILIES) {
    invariant(pageFamilies.has(family), `query set is missing page family ${family}`);
  }
  return querySet;
}

export function validateBaseline(baseline, querySet) {
  validateQuerySet(querySet);
  invariant(baseline?.schemaVersion === 1, 'baseline schemaVersion must be 1');
  invariant(isNonEmptyString(baseline.baselineId), 'baselineId is required');
  invariant(
    baseline.querySetId === querySet.querySetId,
    `baseline querySetId must equal ${querySet.querySetId}`,
  );
  invariant(
    baseline.querySetDigest === computeQuerySetDigest(querySet),
    'baseline querySetDigest must match the supplied query set',
  );
  assertIsoUtcDateTime(baseline.observedAt, 'observedAt');
  const baselineObservedAt = Date.parse(baseline.observedAt);
  const baselineObservationDate = baseline.observedAt.slice(0, 10);
  invariant(
    Date.parse(querySet.reviewedAt) <= Date.parse(baselineObservationDate),
    'query set reviewedAt must not be after baseline.observedAt',
  );
  invariant(
    isNonEmptyString(baseline.repositoryRevision),
    'repositoryRevision is required',
  );

  const context = baseline.collectionContext;
  invariant(context && typeof context === 'object', 'collectionContext is required');
  invariant(isNonEmptyString(context.geography), 'collectionContext.geography is required');
  invariant(isNonEmptyString(context.locale), 'collectionContext.locale is required');
  invariant(
    Array.isArray(context.signedInStates) && context.signedInStates.length > 0,
    'collectionContext.signedInStates is required',
  );
  invariant(
    context.signedInStates.every(isNonEmptyString)
      && new Set(context.signedInStates).size === context.signedInStates.length,
    'collectionContext.signedInStates must contain unique non-empty strings',
  );
  invariant(isNonEmptyString(context.device), 'collectionContext.device is required');
  invariant(
    Array.isArray(context.limitations),
    'collectionContext.limitations must be an array',
  );

  const aiSurfaces = validateAiSurfaces(baseline.aiSurfaces);
  const queryIds = new Set(querySet.queries.map((query) => query.id));
  invariant(baseline.search && typeof baseline.search === 'object', 'search is required');
  validateSearchSource(
    baseline.search.googleSearchConsole,
    'search.googleSearchConsole',
    queryIds,
    baselineObservationDate,
  );
  validateSearchSource(
    baseline.search.bingWebmaster,
    'search.bingWebmaster',
    queryIds,
    baselineObservationDate,
  );
  validateWindowedSource(
    baseline.referrals,
    REFERRAL_METRICS,
    'referrals',
    baselineObservationDate,
  );
  invariant(
    baseline.referrals.classification
      && typeof baseline.referrals.classification === 'object',
    'referrals.classification is required',
  );
  invariant(
    Array.isArray(baseline.referrals.classification.dimensions)
      && baseline.referrals.classification.dimensions.length > 0,
    'referrals.classification.dimensions is required',
  );
  invariant(
    Array.isArray(baseline.referrals.classification.families)
      && baseline.referrals.classification.families.length > 0,
    'referrals.classification.families is required',
  );
  const referrerFamilyIds = new Set();
  for (const [index, family] of baseline.referrals.classification.families.entries()) {
    const label = `referrals.classification.families[${index}]`;
    invariant(isNonEmptyString(family.id), `${label}.id is required`);
    invariant(!referrerFamilyIds.has(family.id), `duplicate referral family ${family.id}`);
    referrerFamilyIds.add(family.id);
    invariant(isNonEmptyString(family.label), `${label}.label is required`);
    invariant(Array.isArray(family.hostSuffixes), `${label}.hostSuffixes must be an array`);
    invariant(Array.isArray(family.utmSources), `${label}.utmSources must be an array`);
  }
  validateReferralSegments(baseline.referrals, referrerFamilyIds);

  invariant(
    Array.isArray(baseline.aiObservations),
    'aiObservations must be an array',
  );
  const observationKeys = new Set();
  for (const [index, observation] of baseline.aiObservations.entries()) {
    const label = `aiObservations[${index}]`;
    invariant(queryIds.has(observation.queryId), `${label}.queryId is unknown`);
    invariant(AI_PLATFORMS.includes(observation.platform), `${label}.platform is invalid`);
    invariant(
      aiSurfaces.get(observation.platform)?.status !== 'unavailable',
      `${label}.platform is unavailable`,
    );
    const key = `${observation.queryId}:${observation.platform}`;
    invariant(!observationKeys.has(key), `duplicate AI observation ${key}`);
    observationKeys.add(key);
    assertIsoUtcDateTime(observation.observedAt, `${label}.observedAt`);
    invariant(
      Date.parse(observation.observedAt) <= baselineObservedAt,
      `${label}.observedAt must not be after baseline.observedAt`,
    );
    invariant(typeof observation.brandMention === 'boolean', `${label}.brandMention is required`);
    invariant(typeof observation.directCitation === 'boolean', `${label}.directCitation is required`);
    invariant(Array.isArray(observation.citedUrls), `${label}.citedUrls must be an array`);
    invariant(
      observation.citedUrls.every((url) => isNonEmptyString(url) && url.startsWith('https://')),
      `${label}.citedUrls must contain HTTPS URLs`,
    );
    const hasWorldMonitorCitation = observation.citedUrls.some(isWorldMonitorUrl);
    invariant(
      observation.directCitation === hasWorldMonitorCitation,
      `${label}: directCitation must match World Monitor cited URLs`,
    );
    invariant(Array.isArray(observation.competitorsCited), `${label}.competitorsCited must be an array`);
    invariant(SENTIMENTS.has(observation.sentiment), `${label}.sentiment is invalid`);
    invariant(ACCURACY_STATES.has(observation.accuracy), `${label}.accuracy is invalid`);
    invariant(isNonEmptyString(observation.summary), `${label}.summary is required`);
    invariant(isNonEmptyString(observation.geography), `${label}.geography is required`);
    invariant(isNonEmptyString(observation.locale), `${label}.locale is required`);
    invariant(isNonEmptyString(observation.signedInState), `${label}.signedInState is required`);
    invariant(
      observation.geography === context.geography,
      `${label}.geography must equal collectionContext.geography`,
    );
    invariant(
      observation.locale === context.locale,
      `${label}.locale must equal collectionContext.locale`,
    );
    invariant(
      context.signedInStates.includes(observation.signedInState),
      `${label}.signedInState must be declared in collectionContext.signedInStates`,
    );
    invariant(
      Array.isArray(observation.limitations),
      `${label}.limitations must be an array`,
    );
  }

  invariant(
    Array.isArray(baseline.opportunities) && baseline.opportunities.length === 5,
    'opportunities must contain exactly five prioritized entries',
  );
  const priorities = baseline.opportunities.map((opportunity) => opportunity.priority);
  const sortedPriorities = [...priorities].sort((left, right) => left - right);
  invariant(
    sortedPriorities.every(
      (priority, index) => Number.isInteger(priority) && priority === index + 1,
    ),
    'opportunity priorities must be exactly the integers 1-5',
  );
  for (const opportunity of baseline.opportunities) {
    invariant(isNonEmptyString(opportunity.title), 'opportunity.title is required');
    invariant(isNonEmptyString(opportunity.evidence), 'opportunity.evidence is required');
    invariant(isNonEmptyString(opportunity.experiment), 'opportunity.experiment is required');
    invariant(isNonEmptyString(opportunity.successCriteria), 'opportunity.successCriteria is required');
    invariant(
      Array.isArray(opportunity.queryIds)
        && opportunity.queryIds.length > 0
        && opportunity.queryIds.every((id) => queryIds.has(id)),
      `${opportunity.title}: queryIds must reference the query set`,
    );
  }
  invariant(
    Array.isArray(baseline.guardrails)
      && baseline.guardrails.length > 0
      && baseline.guardrails.every(isNonEmptyString),
    'guardrails must be a non-empty array of strings',
  );
  return baseline;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function rate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function sumMetric(rows, metric) {
  if (
    rows.length === 0
    || rows.some(({ metrics }) => !Number.isFinite(metrics[metric]))
  ) {
    return null;
  }
  return round(rows.reduce((total, { metrics }) => total + metrics[metric], 0));
}

function aggregateSearchMetrics(rows, includeIndexedPages) {
  const impressions = sumMetric(rows, 'impressions');
  const clicks = sumMetric(rows, 'clicks');
  let ctr = null;
  if (impressions !== null && clicks !== null) {
    if (impressions > 0) ctr = round(clicks / impressions);
    else if (clicks === 0) ctr = 0;
  }
  const hasWeightedPositions = impressions !== null
    && impressions > 0
    && rows.every(({ metrics }) => (
      Number.isFinite(metrics.averagePosition)
      && Number.isFinite(metrics.impressions)
    ));
  const averagePosition = hasWeightedPositions
    ? round(
      rows.reduce(
        (total, { metrics }) => total + metrics.averagePosition * metrics.impressions,
        0,
      ) / impressions,
    )
    : null;
  return {
    indexedPages: includeIndexedPages ? sumMetric(rows, 'indexedPages') : null,
    impressions,
    clicks,
    ctr,
    averagePosition,
  };
}

function aggregateAdditiveMetrics(rows, metricNames) {
  return Object.fromEntries(
    metricNames.map((metric) => [metric, sumMetric(rows, metric)]),
  );
}

function aggregateWindowedRows(source, rows, aggregateMetrics) {
  return {
    status: source.status,
    reason: source.reason,
    windows: source.windows.map((window) => ({
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      metrics: aggregateMetrics(
        rows.filter((row) => row.windowLabel === window.label),
      ),
    })),
  };
}

const INTENT_SLICE = Object.freeze({
  domain: INTENT_DOMAIN,
  matchesQuery: (query, group) => query.intent === group,
  searchRows: (source, _group, queryIds) => (
    source.queryRows.filter((row) => queryIds.has(row.queryId))
  ),
  includeIndexedPages: false,
});
const PAGE_FAMILY_SLICE = Object.freeze({
  domain: PAGE_FAMILY_DOMAIN,
  matchesQuery: (query, group) => query.targetPage.family === group,
  searchRows: (source, group) => (
    source.pageFamilyRows.filter((row) => row.pageFamily === group)
  ),
  includeIndexedPages: true,
});

function buildSlices(
  querySet,
  observations,
  search,
  eligiblePlatformCount,
  descriptor,
) {
  return Object.fromEntries(descriptor.domain.map(({ id: group }) => {
    const queries = querySet.queries.filter(
      (query) => descriptor.matchesQuery(query, group),
    );
    const queryIds = new Set(queries.map((query) => query.id));
    const rows = observations.filter((observation) => queryIds.has(observation.queryId));
    const mentions = rows.filter((observation) => observation.brandMention).length;
    const citations = rows.filter((observation) => observation.directCitation).length;
    const providerSearch = Object.fromEntries(
      Object.entries(search).map(([provider, source]) => [
        provider,
        aggregateWindowedRows(
          source,
          descriptor.searchRows(source, group, queryIds),
          (searchRows) => aggregateSearchMetrics(
            searchRows,
            descriptor.includeIndexedPages,
          ),
        ),
      ]),
    );
    const possibleObservations = queries.length * eligiblePlatformCount;
    return [group, {
      queries: queries.length,
      observations: rows.length,
      possibleObservations,
      brandMentions: mentions,
      directCitations: citations,
      coverageRate: rate(rows.length, possibleObservations),
      brandMentionRate: rate(mentions, rows.length),
      directCitationRate: rate(citations, rows.length),
      targetUrls: [...new Set(queries.map((query) => query.targetPage.url))],
      search: providerSearch,
    }];
  }));
}

function buildReferralSlices(referrals, domain, matchesSegment) {
  return Object.fromEntries(domain.map(({ id }) => [
    id,
    aggregateWindowedRows(
      referrals,
      referrals.segments.filter((segment) => matchesSegment(segment, id)),
      (segments) => aggregateAdditiveMetrics(segments, REFERRAL_METRICS),
    ),
  ]));
}

export function buildScorecard(querySet, baseline) {
  validateBaseline(baseline, querySet);
  const observations = structuredClone(baseline.aiObservations);
  const mentions = observations.filter((observation) => observation.brandMention).length;
  const citations = observations.filter((observation) => observation.directCitation).length;
  const eligiblePlatformCount = baseline.aiSurfaces.filter(
    ({ status }) => status !== 'unavailable',
  ).length;
  const targetPossible = querySet.queries.length * AI_PLATFORMS.length;
  const possible = querySet.queries.length * eligiblePlatformCount;
  const byIntent = buildSlices(
    querySet,
    observations,
    baseline.search,
    eligiblePlatformCount,
    INTENT_SLICE,
  );
  const byPageFamily = buildSlices(
    querySet,
    observations,
    baseline.search,
    eligiblePlatformCount,
    PAGE_FAMILY_SLICE,
  );
  const referrals = structuredClone(baseline.referrals);
  referrals.byReferrerFamily = buildReferralSlices(
    baseline.referrals,
    baseline.referrals.classification.families,
    (segment, family) => segment.referrerFamily === family,
  );
  referrals.byPageFamily = buildReferralSlices(
    baseline.referrals,
    PAGE_FAMILY_DOMAIN,
    (segment, family) => segment.landingPageFamily === family,
  );

  return {
    schemaVersion: 1,
    baselineId: baseline.baselineId,
    querySetId: querySet.querySetId,
    querySetDigest: baseline.querySetDigest,
    generatedAt: baseline.observedAt,
    repositoryRevision: baseline.repositoryRevision,
    collectionContext: structuredClone(baseline.collectionContext),
    querySet: {
      total: querySet.queries.length,
      byIntent: Object.fromEntries(
        Object.entries(byIntent).map(([intent, slice]) => [intent, slice.queries]),
      ),
      byPageFamily: Object.fromEntries(
        Object.entries(byPageFamily).map(
          ([family, slice]) => [family, slice.queries],
        ),
      ),
    },
    search: structuredClone(baseline.search),
    referrals,
    ai: {
      surfaces: structuredClone(baseline.aiSurfaces),
      observed: observations.length,
      targetPossible,
      possible,
      coverageRate: rate(observations.length, possible),
      brandMentions: mentions,
      directCitations: citations,
      brandMentionRate: rate(mentions, observations.length),
      directCitationRate: rate(citations, observations.length),
      observations,
      accuracyRisks: observations.filter(
        (observation) => observation.accuracy === 'mixed'
          || observation.accuracy === 'inaccurate',
      ),
    },
    byIntent,
    byPageFamily,
    opportunities: [...baseline.opportunities].sort(
      (left, right) => left.priority - right.priority,
    ),
    guardrails: structuredClone(baseline.guardrails),
    comparison: null,
  };
}

function observationKey(observation) {
  return JSON.stringify([
    observation.queryId,
    observation.platform,
    observation.geography,
    observation.locale,
    observation.signedInState,
  ]);
}

function observationIndex(scorecard) {
  return new Map(
    scorecard.ai.observations
      .map((observation) => [
        observationKey(observation),
        observation,
      ]),
  );
}

function assertComparableScorecards(previous, current) {
  invariant(
    previous.querySetId === current.querySetId,
    'scorecard querySetId must match for comparison',
  );
  invariant(
    previous.querySetDigest === current.querySetDigest,
    'scorecard querySetDigest must match for comparison',
  );
  assertIsoUtcDateTime(previous.generatedAt, 'previous.generatedAt');
  assertIsoUtcDateTime(current.generatedAt, 'current.generatedAt');
  invariant(
    Date.parse(current.generatedAt) > Date.parse(previous.generatedAt),
    'current scorecard must be newer than previous scorecard',
  );
  for (const field of ['geography', 'locale', 'device']) {
    invariant(
      previous.collectionContext?.[field] === current.collectionContext?.[field],
      `collectionContext.${field} must match for comparison`,
    );
  }
  const previousSignedInStates = [...previous.collectionContext.signedInStates].sort();
  const currentSignedInStates = [...current.collectionContext.signedInStates].sort();
  invariant(
    previousSignedInStates.length === currentSignedInStates.length
      && previousSignedInStates.every(
        (state, index) => state === currentSignedInStates[index],
      ),
    'collectionContext.signedInStates must match for comparison',
  );
}

const MEANINGFUL_ABSOLUTE_CHANGE = Object.freeze({
  ctr: 0.01,
  averagePosition: 1,
  indexedPages: 5,
  clicks: 10,
  impressions: 100,
  sessions: 10,
  dashboardLaunches: 1,
  pricingViews: 1,
  signUps: 1,
  proConversions: 1,
  apiActions: 1,
  mcpActions: 1,
});
const RELATIVE_CHANGE_METRICS = new Set([
  'clicks',
  'impressions',
  ...REFERRAL_METRICS,
]);

function metricDelta(previous, current, metric) {
  const before = previous.metrics[metric];
  const after = current.metrics[metric];
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const absolute = round(after - before);
  const relative = before === 0 ? null : round((after - before) / Math.abs(before));
  const exceedsAbsoluteThreshold = Math.abs(absolute)
    >= MEANINGFUL_ABSOLUTE_CHANGE[metric];
  const exceedsRelativeThreshold = RELATIVE_CHANGE_METRICS.has(metric)
    && relative !== null
    && Math.abs(relative) >= 0.1;
  const meaningful = exceedsAbsoluteThreshold || exceedsRelativeThreshold;
  return { before, after, absolute, relative, meaningful };
}

function compareWindowedSource(previous, current, metricNames, label) {
  if (
    previous?.status === 'unavailable'
    || current?.status === 'unavailable'
    || !previous.windows?.length
    || !current.windows?.length
  ) {
    return null;
  }
  const currentWindowsByLabel = new Map(
    current.windows.map((window) => [window.label, window]),
  );
  const sharedWindows = previous.windows.filter(
    (window) => currentWindowsByLabel.has(window.label),
  );
  if (sharedWindows.length === 0) return null;
  // Single-window comparison: prefer the canonical 28d label (mirroring
  // preferredWindow) so selection never depends on authored window order.
  const previousWindow = sharedWindows.find(({ label }) => label === '28d')
    ?? sharedWindows[0];
  const currentWindow = currentWindowsByLabel.get(previousWindow.label);
  for (const [period, window] of [
    ['previous', previousWindow],
    ['current', currentWindow],
  ]) {
    assertIsoCalendarDate(window.startDate, `${label}.${period}.startDate`);
    assertIsoCalendarDate(window.endDate, `${label}.${period}.endDate`);
  }
  invariant(
    Date.parse(currentWindow.startDate) > Date.parse(previousWindow.startDate)
      && Date.parse(currentWindow.endDate) > Date.parse(previousWindow.endDate),
    `${label} current ${previousWindow.label} window must advance beyond the previous window`,
  );
  return {
    windowLabel: previousWindow.label,
    previousPeriod: {
      startDate: previousWindow.startDate,
      endDate: previousWindow.endDate,
    },
    currentPeriod: {
      startDate: currentWindow.startDate,
      endDate: currentWindow.endDate,
    },
    metrics: Object.fromEntries(
      metricNames.map((metric) => [
        metric,
        metricDelta(previousWindow, currentWindow, metric),
      ]),
    ),
  };
}

export function compareScorecards(previous, current) {
  assertComparableScorecards(previous, current);
  const previousObservations = observationIndex(previous);
  const currentObservations = observationIndex(current);
  const newCitations = [];
  const lostCitations = [];
  const newlyObserved = [];
  const noLongerObserved = [];
  for (const [key, observation] of currentObservations) {
    const previousObservation = previousObservations.get(key);
    if (!previousObservation) {
      newlyObserved.push(structuredClone(observation));
    } else if (!previousObservation.directCitation && observation.directCitation) {
      newCitations.push(structuredClone(observation));
    }
  }
  for (const [key, observation] of previousObservations) {
    const currentObservation = currentObservations.get(key);
    if (!currentObservation) {
      noLongerObserved.push(structuredClone(observation));
    } else if (observation.directCitation && !currentObservation.directCitation) {
      lostCitations.push(structuredClone(observation));
    }
  }
  const byObservationKey = (left, right) => (
    observationKey(left).localeCompare(observationKey(right))
  );

  return {
    previousBaselineId: previous.baselineId,
    currentBaselineId: current.baselineId,
    newCitations: newCitations.sort(byObservationKey),
    lostCitations: lostCitations.sort(byObservationKey),
    newlyObserved: newlyObserved.sort(byObservationKey),
    noLongerObserved: noLongerObserved.sort(byObservationKey),
    search: {
      googleSearchConsole: compareWindowedSource(
        previous.search.googleSearchConsole,
        current.search.googleSearchConsole,
        SEARCH_METRICS,
        'googleSearchConsole',
      ),
      bingWebmaster: compareWindowedSource(
        previous.search.bingWebmaster,
        current.search.bingWebmaster,
        SEARCH_METRICS,
        'bingWebmaster',
      ),
    },
    referrals: compareWindowedSource(
      previous.referrals,
      current.referrals,
      REFERRAL_METRICS,
      'referrals',
    ),
    entityAnswerRisks: structuredClone(current.ai.accuracyRisks),
  };
}

function percent(value) {
  return value === null ? 'Unavailable' : `${round(value * 100, 1)}%`;
}

function displayStatus(source) {
  const status = source.status[0].toUpperCase() + source.status.slice(1);
  return source.status === 'available'
    ? status
    : `${status} — ${source.reason}`;
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function searchProviderRows(scorecard) {
  return [
    ['Google Search Console', scorecard.search.googleSearchConsole],
    ['Bing Webmaster', scorecard.search.bingWebmaster],
    ['Referral analytics', scorecard.referrals],
  ];
}

function preferredWindow(source) {
  return source.windows.find(({ label }) => label === '28d') ?? source.windows[0];
}

function formatSearchPerformance(source, includeIndexedPages = false) {
  const window = preferredWindow(source);
  const { metrics } = window;
  if (Object.values(metrics).every((value) => value === null)) {
    return source.status === 'available' ? 'No normalized rows' : 'Unavailable';
  }
  const fields = [
    ...(includeIndexedPages ? [`${metrics.indexedPages ?? '—'} indexed`] : []),
    `${metrics.impressions ?? '—'} imp`,
    `${metrics.clicks ?? '—'} clicks`,
    `${percent(metrics.ctr)}`,
    `pos ${metrics.averagePosition ?? '—'}`,
  ];
  return `${window.label}: ${fields.join(' / ')}`;
}

function referralMetricCell(source, metric) {
  const value = preferredWindow(source).metrics[metric];
  return value === null ? 'Unavailable' : value;
}

function formatReferralRow(label, source) {
  const cells = REFERRAL_METRICS.map((metric) => referralMetricCell(source, metric));
  return `| ${label} | ${cells.join(' | ')} |`;
}

function markdownLink(url) {
  const target = url
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll(' ', '%20');
  return `[link](${target})`;
}

function formatComparison(comparison) {
  if (!comparison) {
    return [
      '## Monthly comparison',
      '',
      'First recorded period; no previous baseline was supplied. The next run should',
      'pass `--previous <baseline.json>` to report new/lost citations, meaningful',
      'search and CTR changes, referral movement, and entity-answer risks.',
      '',
    ];
  }
  const citationLabel = (observation) => (
    `${observation.queryId} on ${PLATFORM_LABELS[observation.platform]}`
    + ` (${observation.geography}, ${observation.locale}, ${observation.signedInState})`
  );
  const meaningfulSearch = [];
  const indexingRegressions = [];
  const periodTransition = ({ previousPeriod, currentPeriod }) => (
    `${previousPeriod.startDate}..${previousPeriod.endDate}`
    + ` → ${currentPeriod.startDate}..${currentPeriod.endDate}`
  );
  for (const [provider, windowComparison] of Object.entries(comparison.search)) {
    if (!windowComparison) continue;
    const { windowLabel, metrics } = windowComparison;
    for (const [metric, delta] of Object.entries(metrics)) {
      if (delta?.meaningful) {
        meaningfulSearch.push(
          `${provider}.${metric} (${windowLabel}): ${delta.before} → ${delta.after} (${delta.absolute >= 0 ? '+' : ''}${delta.absolute}); periods ${periodTransition(windowComparison)}`,
        );
      }
    }
    if (metrics.indexedPages?.meaningful && metrics.indexedPages.absolute < 0) {
      indexingRegressions.push(
        `${provider} (${windowLabel}): ${metrics.indexedPages.before} → ${metrics.indexedPages.after}; periods ${periodTransition(windowComparison)}`,
      );
    }
  }
  const referralComparison = comparison.referrals;
  const comparedPeriods = [
    ...Object.entries(comparison.search)
      .filter(([, windowComparison]) => windowComparison)
      .map(([provider, windowComparison]) => (
        `${provider} ${windowComparison.windowLabel}: ${periodTransition(windowComparison)}`
      )),
    ...(referralComparison
      ? [`referrals ${referralComparison.windowLabel}: ${periodTransition(referralComparison)}`]
      : []),
  ];
  const meaningfulReferrals = Object.entries(referralComparison?.metrics ?? {})
    .filter(([, delta]) => delta?.meaningful)
    .map(([metric, delta]) => (
      `${metric} (${referralComparison.windowLabel}): ${delta.before} → ${delta.after} (${delta.absolute >= 0 ? '+' : ''}${delta.absolute}); periods ${periodTransition(referralComparison)}`
    ));
  return [
    '## Monthly comparison',
    '',
    `Compared \`${comparison.previousBaselineId}\` with \`${comparison.currentBaselineId}\`.`,
    '',
    `- Compared provider periods: ${comparedPeriods.length ? comparedPeriods.join('; ') : 'none available'}`,
    `- New citations: ${comparison.newCitations.length ? comparison.newCitations.map(citationLabel).join('; ') : 'none'}`,
    `- Lost citations: ${comparison.lostCitations.length ? comparison.lostCitations.map(citationLabel).join('; ') : 'none'}`,
    `- Newly observed query/platform/context combinations: ${comparison.newlyObserved.length ? comparison.newlyObserved.map(citationLabel).join('; ') : 'none'}`,
    `- No longer observed query/platform/context combinations: ${comparison.noLongerObserved.length ? comparison.noLongerObserved.map(citationLabel).join('; ') : 'none'}`,
    `- Meaningful search changes: ${meaningfulSearch.length ? meaningfulSearch.join('; ') : 'none or unavailable'}`,
    `- Indexing regressions: ${indexingRegressions.length ? indexingRegressions.join('; ') : 'none or unavailable'}`,
    `- Referral/outcome movement: ${meaningfulReferrals.length ? meaningfulReferrals.join('; ') : 'none or unavailable'}`,
    `- Entity answers needing review: ${comparison.entityAnswerRisks.length}`,
    '',
  ];
}

export function formatScorecardMarkdown(scorecard) {
  const lines = [
    `# SEO and AI-citation visibility scorecard — ${scorecard.baselineId}`,
    '',
    `Generated from repository revision \`${scorecard.repositoryRevision}\` at`,
    `\`${scorecard.generatedAt}\`. Missing provider data is reported as unavailable,`,
    'never coerced to zero.',
    `Query contract: \`${scorecard.querySetId}\` / \`${scorecard.querySetDigest}\`.`,
    '',
    '## Collection context',
    '',
    `- Geography: ${scorecard.collectionContext.geography}`,
    `- Locale: ${scorecard.collectionContext.locale}`,
    `- Signed-in state: ${scorecard.collectionContext.signedInStates.join(' / ')}`,
    `- Device: ${scorecard.collectionContext.device}`,
    `- Limitations: ${scorecard.collectionContext.limitations.join(' ')}`,
    '',
    '## Data availability',
    '',
    '| Source | Status | Windows |',
    '| --- | --- | --- |',
    ...searchProviderRows(scorecard).map(([label, source]) => (
      `| ${label} | ${markdownCell(displayStatus(source))} | ${source.windows.map((window) => window.label).join(', ')} |`
    )),
    '',
    '| AI surface | Status |',
    '| --- | --- |',
    ...scorecard.ai.surfaces.map((surface) => (
      `| ${PLATFORM_LABELS[surface.platform]} | ${markdownCell(displayStatus(surface))} |`
    )),
    '',
    `Referral families: ${scorecard.referrals.classification.families.map((family) => family.label).join(', ')}.`,
    '',
    '## Query registry',
    '',
    `${scorecard.querySet.total} reviewed queries, split by decision intent and target page family.`,
    '',
    '| Intent | Queries | GSC query performance | Bing query performance | AI observations | Mention rate | Direct-citation rate |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: |',
    ...Object.entries(scorecard.byIntent).map(([intent, slice]) => (
      `| ${INTENT_LABELS[intent]} | ${slice.queries} | ${formatSearchPerformance(slice.search.googleSearchConsole)} | ${formatSearchPerformance(slice.search.bingWebmaster)} | ${slice.observations}/${slice.possibleObservations} | ${percent(slice.brandMentionRate)} | ${percent(slice.directCitationRate)} |`
    )),
    '',
    '| Page family | Queries | GSC page performance | Bing page performance | AI observations | Mention rate | Direct-citation rate |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: |',
    ...Object.entries(scorecard.byPageFamily).map(([family, slice]) => (
      `| ${PAGE_FAMILY_LABELS[family]} | ${slice.queries} | ${formatSearchPerformance(slice.search.googleSearchConsole, true)} | ${formatSearchPerformance(slice.search.bingWebmaster, true)} | ${slice.observations}/${slice.possibleObservations} | ${percent(slice.brandMentionRate)} | ${percent(slice.directCitationRate)} |`
    )),
    '',
    '## Referral and product outcomes',
    '',
    'Referral segments retain both the major referrer family and landing-page family.',
    'Unavailable aggregates remain unavailable in every slice.',
    '',
    '| Referrer family | Sessions | Dashboard launches | Pricing views | Sign-ups | Pro conversions | API actions | MCP actions |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...scorecard.referrals.classification.families.map(({ id, label }) => (
      formatReferralRow(label, scorecard.referrals.byReferrerFamily[id])
    )),
    '',
    '| Landing-page family | Sessions | Dashboard launches | Pricing views | Sign-ups | Pro conversions | API actions | MCP actions |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(scorecard.referrals.byPageFamily).map(([family, source]) => (
      formatReferralRow(PAGE_FAMILY_LABELS[family], source)
    )),
    '',
    '## AI-answer audit',
    '',
    `Coverage: ${scorecard.ai.observed}/${scorecard.ai.possible} (${percent(scorecard.ai.coverageRate)}).`,
    `Full target matrix: ${scorecard.ai.targetPossible} query/platform pairs.`,
    `Observed mention rate: ${percent(scorecard.ai.brandMentionRate)}.`,
    `Observed direct-citation rate: ${percent(scorecard.ai.directCitationRate)}.`,
    'These are descriptive observations, not causal or population-level estimates.',
    '',
    '| Query | Platform | Observed at (UTC) | Context | Brand | Citation | Sentiment | Accuracy | Cited URLs |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...scorecard.ai.observations.map((observation) => (
      `| ${observation.queryId} | ${PLATFORM_LABELS[observation.platform]} | ${observation.observedAt} | ${markdownCell(`${observation.geography} / ${observation.locale} / ${observation.signedInState}`)} | ${observation.brandMention ? 'Mention' : 'No mention'} | ${observation.directCitation ? 'Direct citation' : 'No direct citation'} | ${observation.sentiment} | ${observation.accuracy} | ${markdownCell(observation.citedUrls.map(markdownLink).join(', ')) || 'none'} |`
    )),
    '',
    '### Accuracy and entity risks',
    '',
    ...(scorecard.ai.accuracyRisks.length
      ? scorecard.ai.accuracyRisks.map((observation) => (
        `- ${PLATFORM_LABELS[observation.platform]} / ${observation.queryId}: ${markdownCell(observation.summary)}`
      ))
      : ['- No mixed or inaccurate answers recorded.']),
    '',
    ...formatComparison(scorecard.comparison),
    '## Top five opportunities',
    '',
    ...scorecard.opportunities.flatMap((opportunity) => [
      `### ${opportunity.priority}. ${opportunity.title}`,
      '',
      `- Evidence: ${opportunity.evidence}`,
      `- Experiment: ${opportunity.experiment}`,
      `- Success criteria: ${opportunity.successCriteria}`,
      `- Query IDs: ${opportunity.queryIds.join(', ')}`,
      '',
    ]),
    '## Reproduction contract',
    '',
    '1. Use the same query text from `query-set.json`; do not paraphrase between platforms.',
    '2. Record UTC date/time, country-level geography, locale, device, and whether the',
    '   surface was signed-out or signed-in. Do not record account identifiers or prompts',
    '   unrelated to this reviewed query set.',
    '3. Count a direct citation only when the answer links to a `worldmonitor.app` URL.',
    '   A mention supported only by a directory, review, or social post is not a direct citation.',
    '4. Export Search Console/Bing data through supported product exports or APIs. Do not',
    '   scrape search-result pages or commit property IDs, tokens, or credentials.',
    '5. Reconcile referral aggregates with the analytics provider and keep prompt text out',
    '   of analytics. Use bounded source/page-family fields and existing UTM attribution.',
    '',
    '## Guardrails',
    '',
    ...scorecard.guardrails.map((guardrail) => `- ${guardrail}`),
  ];
  return `${lines.join('\n')}\n`;
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
      ['--queries', '--baseline', '--previous', '--output'].includes(argument),
      `unknown argument ${argument}`,
    );
    const value = args[index + 1];
    invariant(isNonEmptyString(value), `${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  invariant(options.queries, '--queries is required');
  invariant(options.baseline, '--baseline is required');
  if (options.check) invariant(options.output, '--check requires --output');
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

export async function runCli(args) {
  const options = parseArgs(args);
  const querySet = readJson(options.queries);
  const baseline = readJson(options.baseline);
  const scorecard = buildScorecard(querySet, baseline);
  if (options.previous) {
    const previous = buildScorecard(querySet, readJson(options.previous));
    scorecard.comparison = compareScorecards(previous, scorecard);
  }
  const markdown = formatScorecardMarkdown(scorecard);
  if (!options.output) {
    process.stdout.write(markdown);
    return markdown;
  }
  const outputPath = resolve(options.output);
  if (options.check) {
    const committed = readFileSync(outputPath, 'utf8');
    invariant(
      committed === markdown,
      `${options.output} is stale; regenerate it without --check`,
    );
    return markdown;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown);
  return markdown;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
