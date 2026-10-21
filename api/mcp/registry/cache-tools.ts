import { CROSS_BORDER_SOURCES, projectCrossBorderSnapshots } from '../../../server/worldmonitor/displacement/v1/cross-border-data';
import { screenSanctions } from '../../../server/_shared/sanctions-screen';
import { COUNTRY_HISTORY_TOOL } from './country-history-tool';
import { projectSupplyChainData } from './_shipping-freight';
import { CAPITAL_FLOW_PAIR_LEG_SCHEMA, CAPITAL_FLOWS_MAX_COUNTRIES, CAPITAL_FLOWS_PAIRS_LABEL, CAPITAL_FLOWS_SORTS, projectCapitalFlows, type CapitalFlowsSort } from './_capital-flows';
import ISO2_TO_ISO3 from '../../../shared/iso2-to-iso3.js';
import { MARKET_ASSET_CLASSES } from '../../../shared/panel-admission';
import { normalizeSocialVelocity } from '../../_social-velocity.js';
import { projectNaturalEventsRetention } from '../../_natural-events-dashboard.js';
import { NATURAL_DISASTER_EVENT_LISTS, presentNaturalDisastersPanel } from '../_natural-disasters-reuse';
import { GEO_FILTER_OUTPUT_SCHEMA, GEO_FILTER_PROPERTIES, attachGeoFilter, filterEventLists, locationPoint, locator, oldestDatedRows, parseEventFilter, pointAt, type EventList } from '../_geo-filter';
import { CHINA_MACRO_REQUIRED_SERIES } from '../../../shared/china-macro-contract.js';
import {
  normalizeChinaMacroObservations,
  normalizeChinaMacroPreflight,
  validateChinaMacroAvailabilityBindings,
} from '../../../shared/china-macro-normalization';
import {
  getSourceProvenanceState,
  type PropagandaRisk,
} from '../../../shared/source-provenance';
import {
  CREDIBILITY_HIGH_RISK_CAP,
  computeCredibilityScore,
} from '../../../shared/news-credibility.js';
import {
  CORROBORATION_OUTPUT_SCHEMA,
  PUBLISHER_ROSTER_OUTPUT_PROPERTIES,
  assessCorroboration,
  evidenceFromStory,
  publisherRoster,
  toCorroborationJson,
  toPublisherRosterJson,
} from '../../../server/_shared/corroboration';
import { getSourceTier } from '../../../server/_shared/source-tiers';
import { FLOW_SOURCE_WIRE_VALUES, narrowFlowSource } from '../../../server/_shared/flow-source';
import { RECEIPT_FIELDS, selectMarketAlertScorecard, selectScorecardFields } from '../../../server/worldmonitor/forecast/v1/scorecard-fields';
import { hasRedistributableProviderAttribution } from '../../../shared/provider-redistribution';
import { torontoSafetySourceById } from '../../../shared/toronto-safety.js';
import { accuracyAuditOverride, forecastAccuracyAudit, type ForecastAccuracyAudit } from '../../../shared/forecast-accuracy-audit.js';
import { CII_RISK_SCORE_CACHE_KEYS } from '../../_cii-risk-cache-keys.js';
// @ts-expect-error — generated Edge-safe JS mirror; authored types live in shared/bootstrap-tier-keys.d.ts
import { BOOTSTRAP_CACHE_KEYS } from '../../_bootstrap-tier-keys.js';
// @ts-expect-error — Edge-safe JS policy shared with health and seed-health
import { PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY } from '../../_content-freshness.js';
import { DEFAULT_LIST_LIMIT, MARKET_FRESHNESS_CHECKS } from '../constants';
import {
  argBool,
  argNum,
  argStr,
  argStrList,
  cacheEnvelope,
  capArrays,
  capNested,
  capNestedMap,
  ciIncludes,
  compact,
  filterMapValues,
  mapNested,
  matchesCode,
  narrowArray,
  narrowNested,
  pickMapKeys,
  pickMapKeysLike,
  pickNestedMap,
  selectDatasets,
  summarizeData,
} from '../filters';
import { COUNTRY_ARG_HINT, resolveCountryFilter } from '../_country-args';
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import { compareOilWindows, expandCountry } from '../../../shared/oil-trade-windows.js';
import { RpcValidationError } from '../billing-denial';
import type { ConflictSourceObservation, FreshnessCheck, ToolDef } from '../types';
import { forecastCaseReadSchema, forecastPanelAdmissionSchema } from '../../../shared/panel-admission';

import { utf8ByteLength } from '../utils';
import {
  PHYSICAL_DIVERGENCE_OUTPUT_SCHEMA,
  PHYSICAL_PREMIUM_OUTPUT_SCHEMA,
  PHYSICAL_PREMIUM_SYMBOL_ALIASES,
  normalizePhysicalDivergenceDataset,
} from '../../../server/_shared/mcp-physical-divergence';
import {
  CHOKEPOINT_MONITOR_UI_URI,
  CONFLICT_EVENTS_UI_URI,
  FORECASTS_UI_URI,
  MARKET_RADAR_UI_URI,
  NATURAL_DISASTERS_UI_URI,
  NEWS_INTELLIGENCE_UI_URI,
  PREDICTION_MARKETS_UI_URI,
} from '../ui/registry';

function sanctionsChangesCursor(value: unknown): { fetchedAt?: number; offset: number } {
  if (value === undefined) return { offset: 0 };
  const match = typeof value === 'string' && value.length <= 64 && /^([1-9]\d{0,15}):(0|[1-9]\d{0,4})$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[2]) > 10000) {
    throw new RpcValidationError('get_sanctions_data', [{ field: 'changes_cursor', description: 'Use nextCursor from the previous history page.' }]);
  }
  return { fetchedAt: Number(match[1]), offset: Number(match[2]) };
}

function sanctionsArguments(params: Record<string, unknown>) {
  if (params.screen !== undefined && (typeof params.screen !== 'string'
    || params.screen.trim().length < 2 || params.screen.trim().length > 200)) {
    throw new RpcValidationError('get_sanctions_data', [{ field: 'screen', description: 'Expected 2-200 characters.' }]);
  }
  if (params.min_score !== undefined && (typeof params.min_score !== 'number'
    || !Number.isFinite(params.min_score) || params.min_score < 0 || params.min_score > 100)) {
    throw new RpcValidationError('get_sanctions_data', [{ field: 'min_score', description: 'Expected a score from 0 to 100.' }]);
  }
  const countries = resolveCountryFilter(params.country, 'country');
  const days = params.changes_since_days;
  if (days !== undefined && params.screen !== undefined) {
    throw new RpcValidationError('get_sanctions_data', [{ field: 'screen', description: 'Use screen without changes_since_days; history supports query.' }]);
  }
  const cursor = sanctionsChangesCursor(params.changes_cursor);
  if (days === undefined && params.changes_cursor !== undefined) {
    throw new RpcValidationError('get_sanctions_data', [{ field: 'changes_cursor', description: 'Requires changes_since_days.' }]);
  }
  if (days !== undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90)) {
    throw new RpcValidationError('get_sanctions_data', [{ field: 'changes_since_days', description: 'Expected an integer from 1 to 90.' }]);
  }
  return { countries, days, cursor };
}

// Eurostat uses EL for Greece and also publishes these two non-country geos.
function resolveEurostatCountryFilter(raw: unknown): string[] {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return [];
  return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    const geo = argStr(value);
    if (geo === 'ea20' || geo === 'eu27_2020') return [geo];
    return resolveCountryFilter(value, 'countries').map((code) => code === 'gr' ? 'el' : code);
  });
}

// IDMC rows per events-view call: 100 full rows stay well inside the output budget.
const IDU_EVENTS_MAX = 100;

// The UNHCR seeder stores `{ summary: { year, globalTotals, countries, topFlows } }`.
// executeTool then files that value under the cache-key label `summary`, so the
// lists live at `data.summary.summary.*`. Hoist the inner object so `limit`,
// `countries`, and `summary: true` reach the arrays the outputSchema describes.
function hoistDisplacementSeed(data: Record<string, unknown>): void {
  const outer = data.summary;
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return;
  const inner = (outer as Record<string, unknown>).summary;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return;
  const seeded = inner as Record<string, unknown>;
  if (!Array.isArray(seeded.countries) && !Array.isArray(seeded.topFlows)) return;
  data.summary = seeded;
}

// Iran-events domain sunset (war ended 2026-07). Default OFF: drop the dormant
// conflict:iran-events:v1 key from the get_conflict_events cache set so the MCP
// tool stops serving the stale snapshot that lingers for the key's 14-day TTL.
// The output schema still documents an iran-events field (harmless when absent).
// Set IRAN_EVENTS_ENABLED=true to restore. See api/health.js.
const IRAN_EVENTS_ENABLED = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';
// Leave headroom for the cache envelope (`cached_at`, `stale`, and `data`) so
// the dispatcher never replaces a useful conflict response with the generic
// `_budget_exceeded` envelope.
const CONFLICT_EVENTS_OUTPUT_BUDGET_BYTES = 128 * 1024;
const CONFLICT_EVENTS_DATA_BUDGET_BYTES = CONFLICT_EVENTS_OUTPUT_BUDGET_BYTES - 1024;
const CONFLICT_EVENT_LISTS = ['ucdp-events', 'iran-events', 'events'] as const;
const CONFLICT_EVENT_LOCATED_LISTS: EventList[] = [
  { label: 'ucdp-events', list: 'events', locator: locator(locationPoint, 'dateStart') },
  { label: 'iran-events', list: 'events', locator: locator(row => pointAt(row.latitude, row.longitude) ?? locationPoint(row), 'timestamp') },
  { label: 'events', list: 'events', locator: locator(locationPoint, 'occurredAt') },
];
const CONFLICT_EVENTS_FRESHNESS_CHECKS: [FreshnessCheck, ...FreshnessCheck[]] = [
  { key: 'seed-meta:conflict:ucdp-events', maxStaleMin: 30 },
  { key: 'seed-meta:unrest:events', maxStaleMin: 120 },
];
const CONFLICT_PANEL_COLLECTIONS: [string, string][] = [['ucdp-events', 'events'], ['events', 'events'], ['scores', 'ciiScores'], ...(IRAN_EVENTS_ENABLED ? [['iran-events', 'events'] as [string, string]] : [])];
const CROSS_SOURCE_SIGNAL_TYPES = [
  'CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION',
  'CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE',
  'CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING',
  'CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER',
  'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
  'CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK',
  'CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION',
  'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
  'CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT',
  'CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY',
  'CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE',
  'CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION',
  'CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION',
  'CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS',
  'CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME',
  'CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION',
  'CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION',
  'CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE',
  'CROSS_SOURCE_SIGNAL_TYPE_PHYSICAL_PREMIUM_REGIME_TRANSITION',
] as const;

function fitConflictEventsToBudget(data: Record<string, unknown>): void {
  const lists = CONFLICT_EVENT_LISTS.flatMap((label) => {
    const parent = data[label];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return [];
    const events = (parent as Record<string, unknown>).events;
    return Array.isArray(events) ? [{ label, events }] : [];
  });
  const originalEventCount = lists.reduce((sum, { events }) => sum + events.length, 0);
  if (originalEventCount === 0) return;

  const byteLength = () => utf8ByteLength(JSON.stringify(data));
  if (byteLength() <= CONFLICT_EVENTS_DATA_BUDGET_BYTES) return;

  data.partial = true;
  const truncation = {
    reason: 'output_budget',
    original_event_count: originalEventCount,
    returned_event_count: 0,
  };
  data.truncation = truncation;

  const caps = new Map(lists.map(({ label }) => [label, 0]));
  const applyCaps = () => {
    let returnedEventCount = 0;
    for (const { label, events } of lists) {
      const parent = data[label] as Record<string, unknown>;
      const bounded = events.slice(0, caps.get(label) ?? 0);
      parent.events = bounded;
      returnedEventCount += bounded.length;
    }
    truncation.returned_event_count = returnedEventCount;
  };

  let low = 0;
  let high = Math.max(...lists.map(({ events }) => events.length));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    for (const { label } of lists) caps.set(label, mid);
    applyCaps();
    if (byteLength() <= CONFLICT_EVENTS_DATA_BUDGET_BYTES) low = mid;
    else high = mid - 1;
  }
  for (const { label } of lists) caps.set(label, low);
  applyCaps();

  // Spend any remaining budget per feed. This preserves the fair common
  // prefix above while ensuring one oversized feed cannot force every other
  // source to return zero usable events.
  for (const { label, events } of lists) {
    let feedLow = caps.get(label) ?? 0;
    let feedHigh = events.length;
    while (feedLow < feedHigh) {
      const mid = Math.ceil((feedLow + feedHigh) / 2);
      caps.set(label, mid);
      applyCaps();
      if (byteLength() <= CONFLICT_EVENTS_DATA_BUDGET_BYTES) feedLow = mid;
      else feedHigh = mid - 1;
    }
    caps.set(label, feedLow);
    applyCaps();
  }
}

function conflictRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConflictSourceDataUsable(data: Record<string, unknown>): boolean {
  if (['partial', 'stale', 'unavailable', 'upstreamUnavailable', 'degraded'].some(flag => data[flag] === true)) return false;
  return CONFLICT_PANEL_COLLECTIONS.every(([label, field]) => {
    const bucket = data[label];
    if (!conflictRecord(bucket)) return false;
    const rows = bucket[field];
    return Array.isArray(rows) && rows.every(conflictRecord)
      && !['partial', 'stale', 'unavailable', 'upstreamUnavailable', 'rateLimited', 'degraded'].some(flag => bucket[flag] === true)
      && !(typeof bucket.error === 'string' && bucket.error !== '');
  });
}

export function isConflictPanelSnapshotCacheable(value: unknown): boolean {
  if (!conflictRecord(value) || value.stale !== false || value.freshnessUnknown === true
    || typeof value.cached_at !== 'string' || !Number.isFinite(Date.parse(value.cached_at))
    || Array.isArray(value.unreadable) && value.unreadable.length
    || !conflictRecord(value.data) || !isConflictSourceDataUsable(value.data)) return false;
  const source = value.conflict_source;
  if (!conflictRecord(source) || !conflictRecord(source.ucdp)) return false;
  const meta = source.ucdp;
  const ucdp = value.data['ucdp-events'] as Record<string, unknown>;
  return typeof meta.fetchedAt === 'number' && Number.isFinite(meta.fetchedAt) && meta.fetchedAt > 0
    && meta.candidateComplete === true && meta.annualFailedPages === 0
    && typeof meta.candidateVersion === 'string' && meta.candidateVersion.trim() !== '' && !meta.candidateVersion.includes('+partial')
    && meta.candidateVersion === ucdp.candidateVersion
    && (ucdp.candidateComplete === undefined || ucdp.candidateComplete === true)
    && (ucdp.annualFailedPages === undefined || ucdp.annualFailedPages === 0);
}

export function conflictPanelReuseUntil(value: unknown, now = Date.now()): number | null {
  if (!conflictRecord(value) || !isConflictPanelSnapshotCacheable(value)) return null;
  const cachedAt = Date.parse(value.cached_at as string);
  const source = value.conflict_source as ConflictSourceObservation;
  if (cachedAt > now || (source.ucdp.fetchedAt ?? Number.POSITIVE_INFINITY) > now) return null;
  const deadline = cachedAt + Math.min(...CONFLICT_EVENTS_FRESHNESS_CHECKS.map(check => check.maxStaleMin)) * 60_000;
  return deadline > now ? deadline : null;
}

export function projectConflictSourceObservation(value: unknown): ConflictSourceObservation {
  const ucdp: ConflictSourceObservation['ucdp'] = {};
  if (conflictRecord(value)) {
    if (typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt) && value.fetchedAt > 0) ucdp.fetchedAt = value.fetchedAt;
    if (typeof value.candidateVersion === 'string' || value.candidateVersion === null) ucdp.candidateVersion = value.candidateVersion;
    if (typeof value.candidateComplete === 'boolean') ucdp.candidateComplete = value.candidateComplete;
    if (Number.isSafeInteger(value.annualFailedPages) && (value.annualFailedPages as number) >= 0) ucdp.annualFailedPages = value.annualFailedPages as number;
  }
  return { ucdp };
}

function filterConflictEvents(data: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const country = argStr(params.country);
  const minFatal = argNum(params.min_fatalities);
  const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
  const stored = oldestDatedRows(data, CONFLICT_EVENT_LOCATED_LISTS);
  if (country) {
    narrowNested(data, 'ucdp-events', 'events', (e) => ciIncludes(e.country, country));
    narrowNested(data, 'events', 'events', (e) => ciIncludes(e.country, country));
    narrowNested(data, 'scores', 'ciiScores', (s) => matchesCode(s.region, [country]));
  }
  if (minFatal != null) {
    narrowNested(data, 'ucdp-events', 'events', (e) => (argNum(e.deathsBest) ?? 0) >= minFatal);
    narrowNested(data, 'events', 'events', (e) => (argNum(e.fatalities) ?? 0) >= minFatal);
  }
  const geo = filterEventLists(data, CONFLICT_EVENT_LOCATED_LISTS, params, 'get_conflict_events', stored);
  for (const label of CONFLICT_EVENT_LISTS) capNested(data, label, 'events', limit);
  return attachGeoFilter(data, geo);
}

export function filterConflictPanelEvents(data: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const usable = Object.fromEntries(CONFLICT_PANEL_COLLECTIONS.filter(([label, field]) => {
    const bucket = data[label];
    if (!conflictRecord(bucket)) return false;
    const rows = bucket[field];
    return Array.isArray(rows) && rows.every(conflictRecord);
  }).map(([label]) => [label, data[label]]));
  return { ...data, ...filterConflictEvents(usable, params) };
}

export function presentConflictEvents(data: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const presented = structuredClone(data);
  if (!argBool(params.summary) && !argStr(params.jmespath)) fitConflictEventsToBudget(presented);
  return presented;
}

function summarizeConflictEvents(data: Record<string, unknown>): Record<string, unknown> {
  const summary = summarizeData(data);
  if (utf8ByteLength(JSON.stringify(summary)) <= CONFLICT_EVENTS_DATA_BUDGET_BYTES) return summary;

  const samples = CONFLICT_EVENT_LISTS.flatMap((label) => {
    const parent = summary[label];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return [];
    const events = (parent as Record<string, unknown>).events;
    if (!events || typeof events !== 'object' || Array.isArray(events)) return [];
    const sample = (events as Record<string, unknown>).sample;
    return Array.isArray(sample) ? [{ sample, original: [...sample] }] : [];
  });

  for (const { sample } of samples) sample.length = 0;
  const maxSampleLength = Math.max(0, ...samples.map(({ original }) => original.length));
  for (let index = 0; index < maxSampleLength; index++) {
    for (const { sample, original } of samples) {
      if (index >= original.length) continue;
      sample.push(original[index]);
      if (utf8ByteLength(JSON.stringify(summary)) > CONFLICT_EVENTS_DATA_BUDGET_BYTES) sample.pop();
    }
  }

  return summary;
}

function normalizeStoredCredibilityScore(
  value: unknown,
  propagandaRisk: PropagandaRisk,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  const score = Math.round(value);
  return propagandaRisk === 'high'
    ? Math.min(score, CREDIBILITY_HIGH_RISK_CAP)
    : score;
}

// Snapshots written before countryCodes existed carry only countryCode.
function storyCountryCodes(story: Record<string, unknown>): unknown[] {
  return Array.isArray(story.countryCodes) ? story.countryCodes : [story.countryCode];
}

function addNewsSourceProvenance(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((story) => {
    if (!story || typeof story !== 'object' || Array.isArray(story)) return story;
    const record = story as Record<string, unknown>;
    const sourceName = typeof record.primarySource === 'string' ? record.primarySource.trim() : '';
    const provenance = getSourceProvenanceState(sourceName);
    const servedScore = normalizeStoredCredibilityScore(record.credibilityScore, provenance.risk);
    const corroboration = Number(
      record.uniqueSourceCount ?? record.corroborationSourceCount ?? 1,
    );
    const evidence = evidenceFromStory(record);
    const verdict = assessCorroboration(evidence);
    return {
      ...record,
      sourceProvenance: provenance,
      corroboration: toCorroborationJson(verdict),
      ...toPublisherRosterJson(publisherRoster(evidence), verdict),
      credibilityScore: servedScore !== null
        ? servedScore
        : computeCredibilityScore({
          sourceTier: getSourceTier(sourceName),
          propagandaRisk: provenance.risk,
          independentCorroborationCount: Number.isFinite(corroboration) ? corroboration : 1,
        }),
    };
  });
}

function projectRedistributableTheaterPosture(data: Record<string, unknown>): Record<string, unknown> {
  const raw = data.theater_posture;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    data.theater_posture = { theaters: [] };
    return data;
  }
  const posture = raw as Record<string, unknown>;
  if (!hasRedistributableProviderAttribution(posture.provider)) {
    data.theater_posture = { theaters: [] };
    return data;
  }
  delete posture.provider;
  return data;
}

function projectChinaMacroForMcp(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const macro = value as Record<string, unknown>;
  const generatedAt = typeof macro.generatedAt === 'string' ? macro.generatedAt : '';
  const rawObservations = Array.isArray(macro.observations) ? macro.observations : [];
  const observations = normalizeChinaMacroObservations(rawObservations, Date.now(), generatedAt);
  const decisions = normalizeChinaMacroPreflight(
    Array.isArray(macro.sourceDecisions) ? macro.sourceDecisions : [],
    generatedAt,
  );
  if (
    macro.countryCode !== 'CN'
    || observations === null
    || decisions === null
    || !validateChinaMacroAvailabilityBindings(rawObservations, decisions)
  ) return null;

  const launchReady = macro.launchReady === true && CHINA_MACRO_REQUIRED_SERIES.every(
    (seriesId) => observations.some((observation) => (
      observation.id === seriesId
      && observation.hasValue
      && !observation.stale
      && observation.unavailableReason === ''
      && observation.transportStatus === 'fresh'
    )),
  );
  const degraded = observations.some((observation) => (
    !observation.hasValue
    || observation.stale
    || observation.unavailableReason !== ''
    || observation.transportStatus !== 'fresh'
  )) || decisions.some((decision) => decision.status !== 'accepted');

  // Keep the existing unversioned MCP contract stable. The raw v2 snapshot
  // contains an immutable vintage ledger and full provenance payloads; exposing
  // those here would both break `indicators` clients and grow without a useful
  // bound. A separately versioned MCP tool can expose that ledger later.
  return {
    countryCode: 'CN',
    launchReady,
    status: launchReady && !degraded ? 'ready' : 'degraded',
    indicators: observations.map((observation) => ({
      id: observation.id,
      label: observation.label,
      category: observation.category,
      value: observation.hasValue ? observation.value : null,
      priorValue: observation.hasPriorValue ? observation.priorValue : null,
      comparisonValue: observation.hasComparisonValue ? observation.comparisonValue : null,
      comparisonBasis: observation.comparisonBasis,
      unit: observation.unit,
      observationDate: observation.observationDate,
      source: observation.source,
      stale: observation.stale,
      unavailableReason: observation.unavailableReason,
      transportStatus: observation.transportStatus,
      transportFailureReason: observation.transportFailureReason,
    })),
  };
}

const MARKET_SECTOR_MAX_STALE_MIN = MARKET_FRESHNESS_CHECKS[1].maxStaleMin;

// `get_market_data` bundles several independently seeded caches. The outer
// envelope carries aggregate freshness, but sector valuation coverage also
// needs a field-level freshness bit so a caller filtering to sectors does not
// mistake an old valuation snapshot for a current one.
export function applySectorValuationFreshness(
  data: Record<string, unknown>,
  now = Date.now(),
): Record<string, unknown> {
  const sectors = data.sectors;
  if (!sectors || typeof sectors !== 'object' || Array.isArray(sectors)) return data;
  const coverage = (sectors as Record<string, unknown>).valuationCoverage;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    (sectors as Record<string, unknown>).valuationCoverage = {
      sourceStatus: 'degraded',
      stale: true,
    };
    return data;
  }
  const fetchedAtValue = (coverage as Record<string, unknown>).fetchedAt;
  const fetchedAt = typeof fetchedAtValue === 'number' || typeof fetchedAtValue === 'string'
    ? Number(fetchedAtValue)
    : Number.NaN;
  (coverage as Record<string, unknown>).stale = !Number.isFinite(fetchedAt)
    || (now - fetchedAt) / 60_000 > MARKET_SECTOR_MAX_STALE_MIN;
  return data;
}

const MARKET_TRANSPORT_LISTS = [
  ['stocks-bootstrap', 'quotes'], ['commodities-bootstrap', 'quotes'],
  ['crypto', 'quotes'], ['gulf-quotes', 'quotes'], ['sectors', 'sectors'], ['etf-flows', 'etfs'],
] as const;

export function isOrdinaryMarketDefault(params: Record<string, unknown>): boolean {
  return !(typeof params.jmespath === 'string' && params.jmespath.length > 0)
    && !['limit', 'summary', 'refresh', 'request_id', 'panel_request']
    .some(key => Object.prototype.hasOwnProperty.call(params, key))
    && argStrList(params.symbols).length === 0 && argStrList(params.asset_class).length === 0;
}

export function presentDefaultMarketData(result: Record<string, unknown>, budgetBytes: number): Record<string, unknown> {
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return result;
  const presented = structuredClone(result);
  const data = presented.data as Record<string, unknown>;
  const collections: Record<string, Record<string, unknown>> = {};
  const lists = MARKET_TRANSPORT_LISTS.map(([section, field]) => {
    const source = data[section];
    const node = source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : undefined;
    const value = node?.[field];
    const rows = Array.isArray(value) ? value : null;
    const coverage: Record<string, unknown> = rows
      ? { state: 'available', original_count: rows.length, returned_count: rows.length, omitted_count: 0, omission_reason: null }
      : { state: Array.isArray(presented.unreadable) && presented.unreadable.includes(section) ? 'unavailable' : value === null || source === null ? 'null' : source === undefined || node !== undefined && value === undefined ? 'missing' : 'unavailable', original_count: null, returned_count: null, omitted_count: null, omission_reason: null };
    collections[section + '.' + field] = coverage;
    return { node, field, rows, coverage };
  });
  presented.transportCoverage = { count_scope: 'post_filter_snapshot', default_list_limit: 30, collections };
  const size = () => new TextEncoder().encode(JSON.stringify(presented)).byteLength;
  if (size() <= budgetBytes) return presented;
  for (const list of lists) if (list.rows && list.node) {
    list.node[list.field] = [];
    list.coverage.returned_count = 0;
    list.coverage.omitted_count = list.rows.length;
    list.coverage.omission_reason = list.rows.length ? 'output_budget' : null;
  }
  if (size() > budgetBytes) return result;
  const rounds = Math.max(0, ...lists.map(list => list.rows?.length ?? 0));
  for (let ordinal = 0; ordinal < rounds; ordinal++) for (const list of lists) {
    if (!list.rows || !list.node || ordinal >= list.rows.length) continue;
    const selected = list.node[list.field] as unknown[];
    selected.push(list.rows[ordinal]);
    list.coverage.returned_count = selected.length;
    list.coverage.omitted_count = list.rows.length - selected.length;
    list.coverage.omission_reason = selected.length < list.rows.length ? 'output_budget' : null;
    if (size() > budgetBytes) {
      selected.pop();
      list.coverage.returned_count = selected.length;
      list.coverage.omitted_count = list.rows.length - selected.length;
      list.coverage.omission_reason = selected.length < list.rows.length ? 'output_budget' : null;
    }
  }
  return presented;
}

// `records` repeats seaBulletins + coastalBulletins verbatim, and the
// alert-shaped lists re-encode the raw product lists for the dashboard, so
// those copies are trimmed before any original bulletin.
const IMD_TRIM_ORDER = [
  'records', 'marineBulletins', 'portAlerts', 'cycloneEvents',
  'coastalBulletins', 'seaBulletins', 'portWarnings', 'cones', 'windRadii', 'cyclones',
] as const;

export function fitImdToBudget(result: Record<string, unknown>, budgetBytes: number): Record<string, unknown> {
  const data = result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
  const source = (data as Record<string, unknown>).imd_cyclone_marine;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  const presented = structuredClone(result);
  const snapshot = (presented.data as Record<string, unknown>).imd_cyclone_marine as Record<string, unknown>;
  const collections: Record<string, { original_count: number; returned_count: number; omitted_count: number; omission_reason: 'output_budget' }> = {};
  const size = () => utf8ByteLength(JSON.stringify(presented));
  for (const key of IMD_TRIM_ORDER) {
    if (size() <= budgetBytes) break;
    const rows = snapshot[key];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const kept: unknown[] = [];
    snapshot[key] = kept;
    const coverage = { original_count: rows.length, returned_count: 0, omitted_count: rows.length, omission_reason: 'output_budget' as const };
    collections[key] = coverage;
    presented.transportCoverage = { count_scope: 'post_filter_snapshot', collections };
    for (const row of rows) {
      kept.push(row);
      if (size() > budgetBytes) { kept.pop(); break; }
    }
    coverage.returned_count = kept.length;
    coverage.omitted_count = rows.length - kept.length;
  }
  return size() <= budgetBytes ? presented : result;
}

const FORECAST_VOID_REASONS = new Set([
  'no_establishable_metric', 'value_source_never_settled', 'count_source_window_not_retained',
  'unsupported_window', 'unsupported_metric_key', 'not_hard_spec', 'missing_threshold',
  'missing_deadline', 'missing_generated_at', 'beyond_archive_horizon', 'no_archive_evidence',
  'all_judges_void', 'judge_disagreement', 'judge_retry_exhausted', 'withheld_unpublished', 'other',
  'resolver_envelope_bug', 'market_price_not_outcome', 'judged_evidence_unreliable', 'judged_old_selection',
  'late_read', 'feed_unavailable', 'resolver_could_not_read_feed', 'base_rate_placeholder',
]);

function forecastFamilyOutcomes(data: Record<string, unknown>, ids: string[]) {
  const raw = data.scorecard;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const card = raw as Record<string, unknown>;
  if (card.degraded || card.error || !Array.isArray(card.familyOutcomes)) return undefined;
  const rows = selectScorecardFields(card).familyOutcomes;
  if (!Array.isArray(rows)) return undefined;
  const retained = new Set(ids.slice(0, 30));
  const counts = new Map<string, number>();
  const history: { forecastId: string; outcome: string; voidReason?: string }[] = [];
  for (const row of rows) {
    if (typeof row.forecastId !== 'string' || !row.forecastId || !retained.has(row.forecastId)
      || !['YES', 'NO', 'VOID'].includes(row.outcome)) continue;
    const count = counts.get(row.forecastId) ?? 0;
    if (count >= 5) continue;
    counts.set(row.forecastId, count + 1);
    history.push({ forecastId: row.forecastId, outcome: row.outcome,
      ...(row.outcome === 'VOID' ? { voidReason: FORECAST_VOID_REASONS.has(row.voidReason) ? row.voidReason : 'other' } : {}),
    });
    if (history.length === 150) break;
  }
  return history;
}

// The scorecard seed's clock (#8990): the same 36-hour budget the REST handler
// applies. An unknown clock is stale, so it cannot lift the audit.
function scorecardClock(data: Record<string, unknown>, card: Record<string, unknown> | null) {
  const capturedAt = Date.now();
  const meta = data.scorecardMeta;
  const raw = meta && typeof meta === 'object' && 'fetchedAt' in meta ? meta.fetchedAt : undefined;
  // A missing, non-numeric or future clock is unknown, never fresh.
  const fetchedAt = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : NaN;
  const knownClock = Number.isFinite(fetchedAt) && fetchedAt <= capturedAt;
  return {
    windowDays: typeof card?.rollingWindowDays === 'number' && Number.isFinite(card.rollingWindowDays) && card.rollingWindowDays > 0 ? card.rollingWindowDays : 180,
    stale: !knownClock || capturedAt - fetchedAt > 36 * 3600000, freshnessUnknown: !knownClock,
    asOf: knownClock ? new Date(fetchedAt).toISOString() : null, capturedAt: new Date(capturedAt).toISOString(),
  };
}

function scorecardRecord(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = data.scorecard;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** The audit for the stored scorecard, held while its seed is stale (#8990). */
export function storedScorecardAudit(data: Record<string, unknown>): ForecastAccuracyAudit | null {
  const card = scorecardRecord(data);
  return forecastAccuracyAudit(card, { stale: scorecardClock(data, card).stale });
}

/**
 * While an audit holds for this scorecard (#8990) no domain score leaves this
 * tool: status reads unavailable, byDomain is empty, and underAudit says why.
 * The freshness fields stay, so the badge's clock contract is unchanged.
 */
export function forecastReliability(data: Record<string, unknown>, domains: string[], audit: ForecastAccuracyAudit | null = storedScorecardAudit(data)) {
  const underAudit = audit ? { underAudit: { since: audit.since, issue: audit.issue, reason: audit.reason } } : {};
  const unavailable = { status: 'unavailable', ...underAudit };
  const card = scorecardRecord(data);
  if (!card) return unavailable;
  if (card.degraded || card.error || typeof card.schemaVersion !== 'number'
    || !Number.isFinite(card.schemaVersion) || card.schemaVersion < 2 || !Array.isArray(card.publishedByDomain)) return unavailable;
  const rows = new Map<string, Record<string, unknown>>();
  for (const value of card.publishedByDomain) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.domain === 'string' && row.domain !== 'bet_engine' && domains.includes(row.domain)) rows.set(row.domain, row);
  }
  const clock = scorecardClock(data, card);
  if (audit) return { status: 'unavailable', ...underAudit, ...clock, byDomain: [] };
  return {
    status: 'ready', ...clock,
    byDomain: [...new Set(domains)].filter(domain => domain !== 'bet_engine').map(domain => {
      const row = rows.get(domain);
      const sampleCount = typeof row?.count === 'number' && Number.isFinite(row.count) && row.count > 0 ? row.count : 0;
      const yes = row?.yesCount;
      // The seeder writes a domain's bss only once the domain meets its family minimums (#8990).
      return typeof row?.bss === 'number' && Number.isFinite(row.bss) && typeof row.brier === 'number' && Number.isFinite(row.brier)
        && typeof yes === 'number' && Number.isInteger(yes) && yes >= 0 && yes <= sampleCount
        ? { domain, kind: 'measured', n: sampleCount, brier: row.brier, yesShare: yes / sampleCount, bss: row.bss }
        : { domain, kind: 'unmeasured', n: sampleCount };
    }),
  };
}

const FORECAST_SCORECARD_DESCRIPTION = 'It grades published forecasts after they resolve: calibration, Brier/log score with Brier 95% intervals, domain and generation-origin breakdowns, the matured-to-scored funnel, pending/judged resolution counts, receipts for the newest resolved forecasts, familyOutcomes (the recent outcomes of each live forecast id), and horizonGrades (grades of the 24h/7d/30d projections, which are not probabilities). From schemaVersion 3, totals and funnel count published forecasts only; shadow bets appear in byGenerationOrigin. Past accuracy only: no open forecasts, current probabilities or case files, and nothing about countries. Flagged stale after 36 hours. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance. view=archive lists resolved forecasts; domain, outcome, forecast_id, before and limit filter/page it. Trajectories require forecast_id.';

/**
 * The first sentence is the one tools/list keeps, so it names the tool's
 * purpose and the audit rule (#8990). A manual override makes the rule the
 * dated notice. Otherwise the audit follows each scorecard, which a static
 * description cannot know, so it points at underAudit.
 */
export function forecastScorecardDescription(configured?: ForecastAccuracyAudit | null): string {
  const override = accuracyAuditOverride(configured);
  const lead = override
    ? `Forecast resolution scorecard, under audit since ${override.since} (issue ${override.issue}): its scores are unverified.`
    : 'Forecast resolution scorecard: the accuracy record of WorldMonitor forecasts; underAudit marks scores still under audit.';
  return `${lead} ${FORECAST_SCORECARD_DESCRIPTION}`;
}

/** The raw scorecard stays in the result; underAudit (#8990) tells a reader not to quote it as a verdict. */
export function projectForecastScorecard(data: Record<string, unknown>, audit: ForecastAccuracyAudit | null = storedScorecardAudit(data)) {
  const scorecard = data.scorecard;
  const isRecord = scorecard != null && typeof scorecard === 'object' && !Array.isArray(scorecard);
  return {
    underAudit: audit ? { since: audit.since, issue: audit.issue, reason: audit.reason } : null,
    scorecard: isRecord ? selectScorecardFields(scorecard as Record<string, unknown>, { extended: true }) : null,
    marketAlerts: selectMarketAlertScorecard(data.marketAlerts) ?? null,
  };
}

function forecastRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function forecastPoints(value: unknown, limit: number): [string, number][] {
  return Array.isArray(value) ? value.filter((p): p is [string, number] => Array.isArray(p) && p.length === 2
    && typeof p[0] === 'string' && Number.isFinite(Date.parse(p[0])) && typeof p[1] === 'number'
    && Number.isFinite(p[1]) && p[1] >= 0 && p[1] <= 1).slice(-limit) : [];
}

function attachForecastHistory(data: Record<string, unknown>, includeHistory: boolean) {
  const node = forecastRecord(data.predictions);
  if (!Array.isArray(node?.predictions)) return;
  const trail = forecastRecord(data.probabilityTrail);
  const segments = trail?.generatedAt === node.generatedAt ? forecastRecord(trail?.forecasts) : null;
  node.predictions = node.predictions.map(value => {
    const row = forecastRecord(value);
    if (!row) return value;
    const segment = forecastRecord(segments?.[String(row.id)]);
    const matching = segment?.region === row.region ? segment : null;
    const points = forecastPoints(matching?.points, 120);
    const now = Number(node.generatedAt);
    const change = (days: number) => {
      const prior = [...points].reverse().find(([at]) => Date.parse(at) <= now - days * 86_400_000);
      return prior && typeof row.probability === 'number' && Number.isFinite(row.probability)
        ? Math.round((row.probability - prior[1]) * 1e6) / 1e6 : null;
    };
    const { history: _history, ...published } = row;
    return { ...published, firstSeenAt: matching?.firstSeenAt ?? null, firstSeenProbability: matching?.firstSeenProbability ?? null,
      change24h: change(1), change7d: change(7), ...(includeHistory ? { history: points } : {}) };
  });
}

function projectForecastArchive(value: unknown, metaValue: unknown) {
  const archive = forecastRecord(value);
  if (!Array.isArray(archive?.rows)) return null;
  const meta = forecastRecord(metaValue);
  const fetchedAt = Number(meta?.fetchedAt);
  const fields = [...RECEIPT_FIELDS, 'forecastId', 'domain', 'region', 'lane', 'deadline', 'firstSeenAt', 'lastSeenAt'];
  return { generatedAt: archive.generatedAt, rollingWindowDays: archive.rollingWindowDays,
    stale: !Number.isFinite(fetchedAt) || fetchedAt <= 0 || Date.now() - fetchedAt > 2160 * 60_000 || meta?.status === 'error',
    rows: archive.rows.flatMap(value => {
      const row = forecastRecord(value);
      if (!row || !['YES', 'NO', 'VOID'].includes(String(row.outcome)) || typeof row.resolvedAt !== 'number') return [];
      const safe: Record<string, unknown> = {};
      for (const field of fields) if (row[field] === null || ['string', 'number'].includes(typeof row[field])) safe[field] = row[field];
      const evidence = forecastRecord(row.evidence);
      if (evidence && Number.isInteger(evidence.selectionVersion)) safe.evidence = { selectionVersion: evidence.selectionVersion };
      if (Array.isArray(row.trajectory)) safe.trajectory = forecastPoints(row.trajectory, 30);
      return [safe];
    }) };
}

function forecastArchiveArguments(params: Record<string, unknown>) {
  const limit = params.limit ?? 25;
  const continuation = typeof params.before === 'string' ? /^(\d+):(\d+)$/.exec(params.before) : null;
  const before = continuation ? Number(continuation[1]) : params.before;
  const offset = continuation ? Number(continuation[2]) : 0;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50
    || before !== undefined && (typeof before !== 'number' || !Number.isFinite(before))
    || !Number.isSafeInteger(offset) || offset < 0
    || params.outcome !== undefined && !['YES', 'NO', 'VOID'].includes(String(params.outcome))) {
    throw new RpcValidationError('get_forecast_scorecard', [{ field: 'before', description: 'Use a resolvedAt timestamp or nextBefore cursor, limit 1-50 and outcome YES, NO or VOID.' }]);
  }
  return { limit, continuation, before, offset };
}

function filterForecastScorecard(data: Record<string, unknown>, params: Record<string, unknown>) {
  const { forecastArchive, ...summary } = data;
  if (params.view === undefined || params.view === 'summary') return summary;
  if (params.view !== 'archive') throw new RpcValidationError('get_forecast_scorecard', [{ field: 'view', description: 'Expected summary or archive.' }]);
  const { limit, continuation, before, offset } = forecastArchiveArguments(params);
  const archive = forecastArchive as ReturnType<typeof projectForecastArchive>;
  if (!archive) return { underAudit: data.underAudit, archive: null };
  const rows = archive.rows.filter(row => (!params.domain || argStr(row.domain) === argStr(params.domain))
    && (!params.outcome || row.outcome === params.outcome) && (!params.forecast_id || row.forecastId === params.forecast_id)
    && (before === undefined || Number(row.resolvedAt) < Number(before) || !!continuation && row.resolvedAt === before))
    .sort((a, b) => Number(b.resolvedAt) - Number(a.resolvedAt) || String(a.forecastId).localeCompare(String(b.forecastId))
      || Number(a.deadline) - Number(b.deadline) || Number(a.firstSeenAt) - Number(b.firstSeenAt) || String(a.question).localeCompare(String(b.question)))
    .filter((row, index) => !continuation || row.resolvedAt !== before || index >= offset);
  const page = rows.slice(0, limit).map(row => {
    const { trajectory, ...receipt } = row;
    return params.forecast_id ? { ...receipt, ...(trajectory === undefined ? {} : { trajectory }) } : receipt;
  });
  const result = { underAudit: data.underAudit, archive: { generatedAt: archive.generatedAt, rollingWindowDays: archive.rollingWindowDays, stale: archive.stale,
    rows: page, nextBefore: null as string | null } };
  // Leave envelope room inside the fixed tool budget, including family trajectories.
  while (page.length > 1 && utf8ByteLength(JSON.stringify(result)) > 60_000) page.pop();
  if (page.length < rows.length) {
    const at = page[page.length - 1]!.resolvedAt;
    const seen = page.filter(row => row.resolvedAt === at).length + (continuation && at === before ? offset : 0);
    result.archive.nextBefore = `${at}:${seen}`;
  }
  return result;
}

export const CACHE_TOOLS: ToolDef[] = [
  COUNTRY_HISTORY_TOOL,
  {
    name: 'get_toronto_reported_occurrences',
    title: 'Toronto reported crime occurrences',
    _outputBudgetBytes: 65536,
    // TPS rows are licensed for reuse with attribution. Extract it from the
    // cache envelope so a projection over `records` cannot leave the rows
    // without the licence assertion that permits redistributing them.
    _attribution: 'data.reported_occurrences.{attribution: attribution, source: source, fetchedAt: fetchedAt}',
    description: 'Return Toronto Police Service Major Crime Indicators rows: reported occurrences with offence, division, neighbourhood, approximate coordinates and report dates, from the seeded open-data extract (flagged stale after 2 weeks). Retrospective reported crime only; not live dispatch, and coordinates are approximate by design. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. division, neighbourhood and offence are case-insensitive substring filters; limit returns 1-100 rows (default 50). Attribution rides with every projection.',
    inputSchema: {
      type: 'object',
      properties: {
        division: { type: 'string', description: 'Case-insensitive TPS division filter.' },
        neighbourhood: { type: 'string', description: 'Case-insensitive neighbourhood filter.' },
        offence: { type: 'string', description: 'Case-insensitive offence filter.' },
        limit: { type: 'number', description: 'Maximum rows to return, from 1 to 100 (default 50).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      reported_occurrences: {
        type: ['object', 'null'],
        properties: {
          semantic: { type: 'string', enum: ['reported_occurrence'] },
          source: { type: 'string', enum: ['tps-mci'] },
          attribution: { type: 'string' },
          fetchedAt: { type: 'string' },
          newestContentAt: { type: ['number', 'null'] },
          records: { type: 'array', maxItems: 100, items: { type: 'object' } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const division = argStr(params.division);
      const neighbourhood = argStr(params.neighbourhood);
      const offence = argStr(params.offence);
      narrowNested(data, 'reported_occurrences', 'records', (row) => (
        (!division || ciIncludes(row.division, division))
        && (!neighbourhood || ciIncludes(row.neighbourhood158, neighbourhood))
        && (!offence || ciIncludes(row.offence, offence))
      ));
      const requested = argNum(params.limit);
      capNested(data, 'reported_occurrences', 'records', Math.min(Math.max(requested ?? 50, 1), 100));
      return data;
    },
    _cacheKeys: ['safety:toronto:tps-mci:v1'],
    _cacheLabels: { 'safety:toronto:tps-mci:v1': 'reported_occurrences' },
    _freshnessChecks: [{ key: 'seed-meta:safety:tps-mci', maxStaleMin: 20160 }],
    _apiPaths: ['GET /api/safety/v1/get-toronto-safety'],
  },
  {
    name: 'get_toronto_calls_attended',
    title: 'Toronto police calls attended',
    _outputBudgetBytes: 65536,
    // Read AFTER `_postFilter`, which rewrites `attribution` from the source
    // descriptor — a pre-CKAN cached blob still carries the retired
    // OGL-Ontario claim, and the rider must publish the current licence.
    _attribution: 'data.annual_aggregates.{attribution: attribution, source: source, fetchedAt: fetchedAt}',
    description: 'Bounded Toronto Police Service Calls for Service Attended annual aggregates. These are neighbourhood and division counts, not incident points.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Exact event year.' },
        division: { type: 'string', description: 'Case-insensitive original or final TPS division filter.' },
        neighbourhood: { type: 'string', description: 'Case-insensitive neighbourhood filter.' },
        limit: { type: 'number', description: 'Maximum rows to return, from 1 to 100 (default 50).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      annual_aggregates: {
        type: ['object', 'null'],
        properties: {
          semantic: { type: 'string', enum: ['annual_aggregate'] },
          source: { type: 'string', enum: ['tps-calls-attended'] },
          attribution: { type: 'string' },
          fetchedAt: { type: 'string' },
          newestContentYear: { type: ['number', 'null'] },
          records: { type: 'array', maxItems: 100, items: { type: 'object' } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const year = argNum(params.year);
      const division = argStr(params.division);
      const neighbourhood = argStr(params.neighbourhood);
      narrowNested(data, 'annual_aggregates', 'records', (row) => (
        (year == null || row.eventYear === year)
        && (!division || ciIncludes(row.divisionOriginal, division) || ciIncludes(row.divisionFinal, division))
        && (!neighbourhood || ciIncludes(row.neighbourhood158, neighbourhood))
      ));
      const requested = argNum(params.limit);
      capNested(data, 'annual_aggregates', 'records', Math.min(Math.max(requested ?? 50, 1), 100));
      // Attribution is a licence assertion, so it comes from the descriptor —
      // never from whatever snapshot happens to be cached. A pre-CKAN blob
      // still carries the retired OGL-Ontario claim until it is overwritten.
      const aggregates = (data as Record<string, unknown>).annual_aggregates;
      if (aggregates && typeof aggregates === 'object') {
        const descriptor = torontoSafetySourceById('tps-calls-attended');
        if (descriptor?.attribution) {
          (aggregates as Record<string, unknown>).attribution = descriptor.attribution;
        }
      }
      return data;
    },
    _cacheKeys: ['safety:toronto:tps-calls-attended:v1'],
    _cacheLabels: { 'safety:toronto:tps-calls-attended:v1': 'annual_aggregates' },
    _freshnessChecks: [{ key: 'seed-meta:safety:tps-calls-attended', maxStaleMin: 20160 }],
    _apiPaths: ['GET /api/safety/v1/get-toronto-safety'],
  },
  {
    // Intentionally fixed-universe, unlike the ListMarketQuotes RPC: this reads
    // and filters the seeded bootstrap snapshot and never gap-fetches an
    // unseeded ticker through a provider (#6305). An arbitrary equity the
    // seeder does not carry is absent here by design — `symbols` narrows the
    // snapshot, it does not request new instruments. Documented in
    // docs/finance-data.mdx § Client parity.
    name: 'get_market_data',
    title: 'Market quotes and commodity prices',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded market snapshot: equity, commodity, crypto and Gulf-market quotes, SGE physical-vs-COMEX premiums, physical-divergence regimes, sector performance with explicit valuation coverage, ETF flows and the Fear & Greed index. Quotes are flagged stale after 30 minutes. Covers the curated symbol universe only: symbols filters that snapshot and cannot look up arbitrary tickers. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. asset_class selects classes, limit caps each per-class list (default 30, 0 for no cap). Dedicated paid plans open or reuse one market panel allocation across filters; refresh with request_id starts a new one. API plans retain per-tool billing.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tickers to keep, e.g. ["AAPL","GC=F","BTC"]. Case-insensitive; matches equity/commodity/crypto/gulf quotes, physical-premium and divergence aliases (gold/XAU/GC=F, silver/XAG/SI=F), sector ETFs, and ETF-flow tickers. Omit for the full snapshot.',
        },
        asset_class: {
          type: 'array',
          items: { type: 'string', enum: MARKET_ASSET_CLASSES },
          description: 'Restrict the response to one or more asset classes. Omit for all.',
        },
        limit: { type: 'number', description: 'Cap each per-class quote list (stocks/commodities/crypto/gulf/sectors/ETF flows) to at most this many items (default 30, pass 0 for no cap).' },
        refresh: { type: 'boolean', description: 'Reload the curated snapshot with one new paid panel allocation. Default false reuses the current market panel. Requires request_id; omit panel_request when refreshing.' },
        request_id: { type: 'string', format: 'uuid', description: 'Stable refresh ID. Retries with the same ID reuse one paid allocation and its original expiry.' },
        panel_request: { type: 'string', maxLength: 160, description: 'Server-issued market-panel receipt token for bounded curated reads. API allowances do not accept receipts.' },
      },
      required: [],
    },
    // Every quote list serves `change` (a PERCENT — the seeders
    // normalise Finnhub `dp` / Alpha Vantage / Yahoo through
    // scripts/shared/market-quote-provider.mjs) and ETF rows serve `estFlow`.
    // This schema previously advertised `changePercent` and `flow`, which no
    // producer has ever written, so every agent projecting per the hint got
    // null for each row. Keep these names pinned to the seeders.
    outputSchema: (() => {
      const schema = cacheEnvelope({
      'stocks-bootstrap': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, change: { type: 'number', description: 'Percent change vs prior close.' } } } },
          finnhubSkipped: { type: 'boolean' },
          skipReason: { type: 'string' },
          rateLimited: { type: 'boolean' },
        },
      },
      'commodities-bootstrap': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, change: { type: 'number', description: 'Percent change vs prior close.' } } } },
        },
      },
      'physical-premium': PHYSICAL_PREMIUM_OUTPUT_SCHEMA,
      'physical-divergence': PHYSICAL_DIVERGENCE_OUTPUT_SCHEMA,
      crypto: {
        type: ['object', 'null'],
        properties: {
          // Crypto trades continuously, so there is no prior close to compare
          // against: scripts/seed-crypto-quotes.mjs carries the provider's
          // rolling percent_change_24h straight into `change`.
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, change: { type: 'number', description: 'Percent change over the trailing 24 hours (crypto trades continuously; this is not a prior-close comparison).' } } } },
        },
      },
      sectors: {
        type: ['object', 'null'],
        properties: {
          sectors: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, name: { type: 'string' }, change: { type: 'number', description: 'Percent change vs prior close.' } } } },
          valuations: { type: ['object', 'array', 'null'] },
          valuationCoverage: {
            type: ['object', 'null'],
            properties: {
              valuationCount: { type: 'number' },
              expectedValuationCount: { type: 'number' },
              currentValuationCount: {
                type: 'number',
                description: 'Valuations fetched live this cycle. Omitted when it equals valuationCount (nothing stale). When present it is lower than valuationCount, and the difference is the records replayed from the last-good snapshot -- valuationCount alone does NOT mean that many symbols are current.',
              },
              sourceStatus: { type: 'string', enum: ['ok', 'partial', 'degraded'] },
              source: { type: 'string' },
              fetchedAt: { type: 'number' },
              stale: { type: 'boolean' },
              staleValuationSymbols: {
                type: 'array',
                items: { type: 'string' },
                description: 'Symbols whose valuation record was replayed from the last-good snapshot rather than fetched this cycle. These symbols DO have values in `valuations`; read lastGood.fetchedAt for their age (bounded by a 7-day snapshot TTL). Disjoint from unavailableSymbols.',
              },
              unavailableSymbols: {
                type: 'array',
                items: { type: 'string' },
                description: 'Symbols with no valuation published at all -- absent from `valuations`. Disjoint from staleValuationSymbols.',
              },
              valuationDiagnostics: {
                type: 'array',
                description: 'Bounded per-symbol direct/proxy outcomes from the final Yahoo valuation routes. This is diagnostic metadata, not a valuation record.',
                items: {
                  type: 'object',
                  properties: {
                    symbol: { type: 'string' },
                    outcomes: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          route: { type: 'string', enum: ['v7Quote', 'v7QuoteBatch', 'quoteSummary'] },
                          transport: { type: 'string', enum: ['direct', 'proxy'] },
                          attempts: { type: 'number' },
                          status: { type: 'number' },
                          responseClass: { type: 'string' },
                          missingFields: { type: 'array', items: { type: 'string' } },
                          failure: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
              lastGood: {
                type: ['object', 'null'],
                properties: {
                  fetchedAt: { type: 'number' },
                  stale: { type: 'boolean' },
                  symbols: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      'etf-flows': {
        type: ['object', 'null'],
        properties: {
          timestamp: { type: ['string', 'number', 'null'] },
          summary: { type: ['object', 'null'] },
          etfs: { type: 'array', items: { type: 'object', properties: { ticker: { type: 'string' }, estFlow: { type: 'number', description: 'Estimated net USD flow (volume x price heuristic).' } } } },
          rateLimited: { type: 'boolean' },
        },
      },
      'gulf-quotes': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, change: { type: 'number', description: 'Percent change vs prior close.' } } } },
          rateLimited: { type: 'boolean' },
        },
      },
      'fear-greed': {
        type: ['object', 'null'],
        properties: {
          timestamp: { type: ['string', 'number', 'null'] },
          composite: { type: ['object', 'number', 'null'], properties: {
            score: { type: 'number' }, label: { type: 'string' }, previous: { type: ['number', 'null'] },
          } },
          categories: { type: ['object', 'array', 'null'] },
          headerMetrics: { type: ['object', 'array', 'null'] },
          sectorPerformance: { type: ['object', 'array', 'null'] },
          unavailable: { type: 'boolean' },
        },
      },
      }) as { properties: Record<string, unknown> };
      return { ...schema, properties: { ...schema.properties, transportCoverage: {
        type: 'object', required: ['count_scope', 'default_list_limit', 'collections'], properties: {
          count_scope: { const: 'post_filter_snapshot' }, default_list_limit: { const: 30 },
          collections: { type: 'object', properties: Object.fromEntries(MARKET_TRANSPORT_LISTS.map(([section, field]) => [section + '.' + field, {
            type: 'object', required: ['state', 'original_count', 'returned_count', 'omitted_count', 'omission_reason'], properties: {
              state: { type: 'string', enum: ['available', 'missing', 'null', 'unavailable'] },
              original_count: { type: ['integer', 'null'], minimum: 0 }, returned_count: { type: ['integer', 'null'], minimum: 0 },
              omitted_count: { type: ['integer', 'null'], minimum: 0 }, omission_reason: { enum: ['output_budget', null] },
            },
          }])) },
        },
      } } };
    })(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      normalizePhysicalDivergenceDataset(data);
      const symbols = argStrList(params.symbols);
      if (symbols.length > 0) {
        for (const label of ['stocks-bootstrap', 'commodities-bootstrap', 'crypto', 'gulf-quotes']) {
          narrowNested(data, label, 'quotes', (q) => matchesCode(q.symbol, symbols));
        }
        narrowNested(data, 'physical-premium', 'premiums', (premium) => {
          const aliases = typeof premium.metal === 'string'
            ? PHYSICAL_PREMIUM_SYMBOL_ALIASES[premium.metal]
            : undefined;
          if (!aliases) return false;
          return aliases.some((alias) => matchesCode(alias, symbols));
        });
        narrowNested(data, 'physical-divergence', 'readings', (reading) => {
          const aliases = typeof reading.metal === 'string'
            ? PHYSICAL_PREMIUM_SYMBOL_ALIASES[reading.metal]
            : undefined;
          return aliases?.some((alias) => matchesCode(alias, symbols)) ?? false;
        });
        const divergence = data['physical-divergence'];
        if (divergence && typeof divergence === 'object' && !Array.isArray(divergence)) {
          const divergenceRecord = divergence as Record<string, unknown>;
          const readings = Array.isArray(divergenceRecord.readings)
            ? divergenceRecord.readings
            : [];
          const visibleMetals = new Set(readings.flatMap((reading) => (
            reading && typeof reading === 'object' && !Array.isArray(reading)
            && typeof (reading as Record<string, unknown>).metal === 'string'
              ? [(reading as Record<string, unknown>).metal]
              : []
          )));
          if (!(visibleMetals.has('gold') && visibleMetals.has('silver'))) {
            delete divergenceRecord.composite;
          }
        }
        narrowNested(data, 'sectors', 'sectors', (s) => matchesCode(s.symbol, symbols));
        const sectorData = data.sectors;
        if (sectorData && typeof sectorData === 'object' && !Array.isArray(sectorData)) {
          const sector = sectorData as Record<string, unknown>;
          const coverage = sector.valuationCoverage;
          const valuations = sector.valuations;
          const unavailable = coverage && typeof coverage === 'object' && !Array.isArray(coverage)
            ? (coverage as Record<string, unknown>).unavailableSymbols
            : null;
          const allSectorSymbols = new Set<string>([
            ...(Array.isArray(sector.sectors)
              ? sector.sectors.flatMap((row) => {
                if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
                const symbol = (row as Record<string, unknown>).symbol;
                return typeof symbol === 'string' ? [symbol.toLowerCase()] : [];
              })
              : []),
            ...(valuations && typeof valuations === 'object' && !Array.isArray(valuations)
              ? Object.keys(valuations).map((symbol) => symbol.toLowerCase())
              : []),
            ...(Array.isArray(unavailable)
              ? unavailable.filter((symbol): symbol is string => typeof symbol === 'string').map((symbol) => symbol.toLowerCase())
              : []),
          ]);
          const requestedSectorSymbols = symbols.filter((symbol) => allSectorSymbols.has(symbol));
          // symbols= is active: always project sector valuations/coverage to the
          // requested sector subset (empty when the filter is equity-only).
          if (valuations && typeof valuations === 'object' && !Array.isArray(valuations)) {
            sector.valuations = Object.fromEntries(
              Object.entries(valuations).filter(([symbol]) => requestedSectorSymbols.includes(symbol.toLowerCase())),
            );
          }
          if (coverage && typeof coverage === 'object' && !Array.isArray(coverage)) {
            const coverageRecord = coverage as Record<string, unknown>;
            if (Array.isArray(coverageRecord.unavailableSymbols)) {
              const filteredUnavailable = coverageRecord.unavailableSymbols
                .filter((symbol): symbol is string => typeof symbol === 'string')
                .filter((symbol) => requestedSectorSymbols.includes(symbol.toLowerCase()));
              if (filteredUnavailable.length === 0) {
                delete coverageRecord.unavailableSymbols;
              } else {
                coverageRecord.unavailableSymbols = filteredUnavailable;
              }
            }
            const filteredStaleValuationSymbols = Array.isArray(coverageRecord.staleValuationSymbols)
              ? coverageRecord.staleValuationSymbols
                .filter((symbol): symbol is string => typeof symbol === 'string')
                .filter((symbol) => requestedSectorSymbols.includes(symbol.toLowerCase()))
              : [];
            if (filteredStaleValuationSymbols.length === 0) {
              delete coverageRecord.staleValuationSymbols;
            } else {
              coverageRecord.staleValuationSymbols = filteredStaleValuationSymbols;
            }
            if (coverageRecord.lastGood && typeof coverageRecord.lastGood === 'object' && !Array.isArray(coverageRecord.lastGood)) {
              const lastGoodRecord = coverageRecord.lastGood as Record<string, unknown>;
              if (Array.isArray(lastGoodRecord.symbols)) {
                lastGoodRecord.symbols = lastGoodRecord.symbols
                  .filter((symbol): symbol is string => typeof symbol === 'string')
                  .filter((symbol) => requestedSectorSymbols.includes(symbol.toLowerCase()));
              }
              // Match seeder omit-empty: never leave lastGood with symbols:[].
              if (!Array.isArray(lastGoodRecord.symbols) || lastGoodRecord.symbols.length === 0) {
                delete coverageRecord.lastGood;
              }
            }
            if (Array.isArray(coverageRecord.valuationDiagnostics)) {
              const filteredDiagnostics = coverageRecord.valuationDiagnostics.filter((diagnostic) => {
                if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return false;
                const symbol = (diagnostic as Record<string, unknown>).symbol;
                return typeof symbol === 'string' && requestedSectorSymbols.includes(symbol.toLowerCase());
              });
              if (filteredDiagnostics.length === 0) {
                delete coverageRecord.valuationDiagnostics;
              } else {
                coverageRecord.valuationDiagnostics = filteredDiagnostics;
              }
            }
            const filteredValuationCount = sector.valuations && typeof sector.valuations === 'object' && !Array.isArray(sector.valuations)
              ? Object.keys(sector.valuations).length
              : 0;
            const expectedValuationCount = requestedSectorSymbols.length;
            const staleValuationCount = sector.valuations && typeof sector.valuations === 'object' && !Array.isArray(sector.valuations)
              ? filteredStaleValuationSymbols.filter((symbol) => Object.prototype.hasOwnProperty.call(sector.valuations, symbol)).length
              : 0;
            const hasCurrentValuationCount = typeof coverageRecord.currentValuationCount === 'number'
              && Number.isFinite(coverageRecord.currentValuationCount);
            const filteredCurrentValuationCount = Math.max(0, filteredValuationCount - staleValuationCount);
            coverageRecord.valuationCount = filteredValuationCount;
            coverageRecord.expectedValuationCount = expectedValuationCount;
            // Mirror the producer's omit-when-equal rule (see
            // buildSectorValuationCoverage): emitting the field when it equals
            // valuationCount makes the two surfaces disagree on the field's own
            // emission contract.
            if (hasCurrentValuationCount && filteredCurrentValuationCount !== filteredValuationCount) {
              coverageRecord.currentValuationCount = filteredCurrentValuationCount;
            } else {
              delete coverageRecord.currentValuationCount;
            }
            // Empty request set (no sector symbols matched): complete empty view, not degraded.
            // Zero CURRENT records is degraded even when stale fills keep the
            // filtered count non-zero -- mirrors the seeder's own escalation.
            coverageRecord.sourceStatus = expectedValuationCount === 0
              ? 'ok'
              : filteredValuationCount === 0
                || (hasCurrentValuationCount && filteredCurrentValuationCount === 0)
                ? 'degraded'
                : filteredValuationCount < expectedValuationCount
                  || filteredStaleValuationSymbols.length > 0
                  || (hasCurrentValuationCount && filteredCurrentValuationCount < expectedValuationCount)
                  ? 'partial'
                  : 'ok';
          }
        }
        narrowNested(data, 'etf-flows', 'etfs', (e) => matchesCode(e.ticker, symbols));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      for (const label of ['stocks-bootstrap', 'commodities-bootstrap', 'crypto', 'gulf-quotes']) {
        capNested(data, label, 'quotes', limit);
      }
      capNested(data, 'sectors', 'sectors', limit);
      capNested(data, 'etf-flows', 'etfs', limit);
      capNested(data, 'physical-premium', 'premiums', limit);
      applySectorValuationFreshness(data);
      const cls = argStrList(params.asset_class);
      if (cls.length > 0) {
        const map: Record<string, string[]> = {
          equity: ['stocks-bootstrap'], commodity: ['commodities-bootstrap', 'physical-premium', 'physical-divergence'], crypto: ['crypto'],
          sectors: ['sectors'], etf: ['etf-flows'], gulf: ['gulf-quotes'], sentiment: ['fear-greed'],
        };
        return selectDatasets(data, cls.flatMap((assetClass) => map[assetClass] ?? []));
      }
      return data;
    },
    // MCP Apps (`io.modelcontextprotocol/ui`): links the tool to its interactive
    // ui:// app shell. Single source of truth — registered in ../ui/registry.ts.
    _uiResourceUri: MARKET_RADAR_UI_URI,
    _cacheKeys: [
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:physical-premium:v1',
      'market:physical-divergence:v1',
      'market:crypto:v1',
      'market:sectors:v2',
      'market:etf-flows:v1',
      'market:gulf-quotes:v1',
      'market:fear-greed:v1',
    ],
    // Do not add the new physical-premium seed-meta yet. evaluateFreshness ORs
    // every check into one tool-wide flag, so its deployment-order miss would
    // mark unrelated equity, crypto, FX, and commodity responses stale until
    // the first Railway publish. /api/health owns this key meanwhile.
    _freshnessChecks: [...MARKET_FRESHNESS_CHECKS],
    // NOTE: `GET /api/market/v1/get-gold-intelligence` is NOT covered here.
    // The audit-time cross-reference matched on the single `market:commodities-bootstrap:v1`
    // key shared between this tool and the gold-intel handler, but the handler also reads 4
    // gold-specific keys (COT, gold-extended, gold-ETF-flows, gold-CB-reserves) that this
    // tool's `_cacheKeys` does NOT expose. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future commodities-expansion tool bundles those.
    _apiPaths: [
      "GET /api/market/v1/get-fear-greed-index",
      "GET /api/market/v1/get-physical-premiums",
      "GET /api/market/v1/get-physical-divergence-index",
      "GET /api/market/v1/get-sector-summary",
      "GET /api/market/v1/list-commodity-quotes",
      "GET /api/market/v1/list-crypto-quotes",
      "GET /api/market/v1/list-etf-flows",
      "GET /api/market/v1/list-gulf-quotes",
      "GET /api/market/v1/list-market-quotes",
    ],
  },
  {
    name: 'get_conflict_events',
    title: 'Armed conflict and unrest events',
    _uiResourceUri: CONFLICT_EVENTS_UI_URI,
    _outputBudgetBytes: CONFLICT_EVENTS_OUTPUT_BUDGET_BYTES,
    description: 'Return the seeded conflict snapshot: active armed-conflict events (UCDP and Iran tracker) and unrest events with coordinates, fatalities and dates, plus country risk scores. UCDP data is flagged stale after 30 minutes, unrest after 2 hours. Event-level records; no narrative or forecasts. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. country matches event country names and the alpha-2 code on risk scores; min_fatalities drops events below a count; limit caps each list (default 30, 0 for no cap). Dedicated paid connections reuse one panel allocation across openings and filters; refresh with request_id starts a new one; authorized panel_request reads report current usage when confirmed. API and free allowances retain per-tool billing and reject paid controls. bbox or lat/lon/radius_km limit the area, since_days the last N days; geo_filter counts rows lacking coordinates or dates.',
    inputSchema: {
      type: 'object',
      properties: {
        country: {
          type: 'string',
          description: 'Filter to one country — matches the country name on conflict/unrest events and the ISO 3166-1 alpha-2 region code on risk scores (case-insensitive).',
        },
        min_fatalities: {
          type: 'number',
          description: 'Drop events below this fatality count (UCDP deathsBest / unrest fatalities).',
        },
        limit: { type: 'number', description: 'Cap each event list to at most this many items (default 30, pass 0 for no cap).' },
        panel_request: { type: 'string', description: 'Paid conflict panel receipt for bounded internal filtered reads without another daily allocation.' },
        refresh: { type: 'boolean', description: 'Request one new paid conflict panel allocation. Requires request_id and no panel_request.' },
        request_id: { type: 'string', format: 'uuid', description: 'Retry identity for an explicit paid refresh. Reuse the ID to avoid another allocation.' },
        ...GEO_FILTER_PROPERTIES,
      },
      required: [],
    },
    outputSchema: (() => {
      const envelope = cacheEnvelope({
        'ucdp-events': {
          type: ['object', 'null'],
          properties: {
            events: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string' }, dateStart: { type: ['number', 'string'] }, dateEnd: { type: ['number', 'string'] },
              location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
              country: { type: 'string' }, sideA: { type: 'string' }, sideB: { type: 'string' },
              deathsBest: { type: 'number' }, deathsLow: { type: 'number' }, deathsHigh: { type: 'number' },
              violenceType: { type: 'string' }, sourceOriginal: { type: 'string' },
            } } },
            fetchedAt: { type: ['number', 'string'] },
            version: { type: ['string', 'number'] },
            // Newest merged GED Candidate release, or null when the annual base is
            // serving alone. A `+partial` suffix means the candidate was fetched
            // incompletely.
            candidateVersion: { type: ['string', 'null'] },
            candidateComplete: { type: 'boolean' },
            totalRaw: { type: 'number' },
            filteredCount: { type: 'number' },
          },
        },
        'iran-events': {
          type: ['object', 'null'],
          properties: {
            events: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string' }, country: { type: 'string' },
              location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            } } },
            scrapedAt: { type: ['number', 'string'] },
          },
        },
        events: {
          type: ['object', 'null'],
          properties: {
            events: { type: 'array', items: { type: 'object', properties: {
              country: { type: 'string' }, fatalities: { type: 'number' },
              location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            } } },
            clusters: { type: ['array', 'object', 'null'] },
          },
        },
        scores: {
          type: ['object', 'null'],
          properties: {
            ciiScores: { type: 'array', items: { type: 'object', properties: { region: { type: 'string' }, score: { type: 'number' } } } },
            strategicRisks: { type: ['array', 'object', 'null'] },
          },
        },
        partial: { type: 'boolean', description: 'True when event lists were shortened to fit the MCP output budget.' },
        truncation: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            original_event_count: { type: 'number' },
            returned_event_count: { type: 'number' },
          },
        },
        geo_filter: GEO_FILTER_OUTPUT_SCHEMA,
      }) as { properties: Record<string, unknown> };
      return {
        ...envelope,
        properties: {
          ...envelope.properties,
          conflict_source: {
            type: 'object',
            description: 'Actual fields copied from the already-read UCDP seed metadata. Missing fields remain absent. This observation is not an atomic dataset snapshot or proof of all upstream provider coverage.',
            properties: { ucdp: { type: 'object', properties: {
              fetchedAt: { type: 'number' }, candidateVersion: { type: ['string', 'null'] },
              candidateComplete: { type: 'boolean' }, annualFailedPages: { type: 'integer', minimum: 0 },
            } } },
          },
        },
      };
    })(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _summarize: summarizeConflictEvents,
    _validateArgs: params => { parseEventFilter(params, 'get_conflict_events'); },
    _postFilter: (data, params) => presentConflictEvents(filterConflictEvents(data, params), params),
    _cacheKeys: [
      'conflict:ucdp-events:v1',
      ...(IRAN_EVENTS_ENABLED ? ['conflict:iran-events:v1'] : []),
      'unrest:events:v1',
      CII_RISK_SCORE_CACHE_KEYS.stale,
    ],
    // Per-key budgets (#5864): unrest:events:v1 is materializer-backed since
    // #5863 and was invisible to this envelope — a dead 15-min pipeline still
    // reported stale:false to agents.
    _freshnessChecks: CONFLICT_EVENTS_FRESHNESS_CHECKS,
    // NOTE: `GET /api/intelligence/v1/get-risk-scores` is NOT covered here.
    // The audit-time hint matched only this tool's conflict/risk cache keys,
    // but the handler at server/worldmonitor/intelligence/v1/get-risk-scores.ts
    // reads a broader cross-domain set (infra outages, climate anomalies,
    // cyber threats, wildfires, GPS jamming, OREF history, security
    // advisories, displacement, news insights, news threats, aviation,
    // earthquakes, sanctions, temporal anomalies, and military CII). Excluded
    // as `deferred-to-future-tool` -
    // belongs in a future expanded_risk_scores composite tool, not here.
    _apiPaths: [
      "GET /api/conflict/v1/list-iran-events",
      "GET /api/conflict/v1/list-ucdp-events",
      "GET /api/unrest/v1/list-unrest-events",
    ],
  },
  {
    name: 'get_aviation_status',
    title: 'Airport delays and airspace closures',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded airport disruption snapshot: one alert row per monitored airport (about 85 major airports worldwide) with iata, name, country and severity, built from AviationStack delay aggregates for international hubs, FAA ASWS delays for US airports and ICAO NOTAM closures. Seeded about every 30 minutes and flagged stale after 90. The snapshot holds every monitored airport, so most rows are severity "normal" unless disrupted_only=true, and the default limit of 30 returns only part of it (0 for the whole list). Airport-level status only; no fares, schedules or flight tracks. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. country is a case-insensitive name substring, iata selects one airport, limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        disrupted_only: {
          type: 'boolean',
          description: 'Drop airports with severity "normal" — keep only airports actually experiencing delays/closures. The bootstrap lists every monitored airport, so most rows are non-events without this.',
        },
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring, e.g. "united states").' },
        iata: { type: 'string', description: 'Filter to a single airport by IATA code (e.g. "JFK").' },
        limit: { type: 'number', description: 'Cap the alert list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'delays-bootstrap': {
        type: ['object', 'null'],
        properties: {
          alerts: { type: 'array', items: { type: 'object', properties: {
            iata: { type: 'string' }, country: { type: 'string' },
            severity: { type: 'string' }, name: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const iata = argStr(params.iata);
      if (argBool(params.disrupted_only)) {
        narrowNested(data, 'delays-bootstrap', 'alerts', (a) => argStr(a.severity) !== 'normal');
      }
      if (country) narrowNested(data, 'delays-bootstrap', 'alerts', (a) => ciIncludes(a.country, country));
      if (iata) narrowNested(data, 'delays-bootstrap', 'alerts', (a) => argStr(a.iata) === iata);
      capNested(data, 'delays-bootstrap', 'alerts', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['aviation:delays-bootstrap:v2'],
    // The aggregate's own meta, as api/health.js flightDelays reads it (#6987).
    // seed-meta:aviation:faa counts the FAA side-car only.
    _freshnessChecks: [{ key: 'seed-meta:aviation:delays-bootstrap', maxStaleMin: 90 }],
    _apiPaths: [],
  },
  {
    name: 'get_news_intelligence',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Threat news stories and signals',
    _uiResourceUri: NEWS_INTELLIGENCE_UI_URI,
    _outputBudgetBytes: 131072,
    description: 'Return the seeded threat-news feed as individual items, not a written brief: AI-classified top stories, GDELT intelligence signals by topic, cross-source signals (including physical-premium regime transitions) and government security advisories. Flagged stale after 30 minutes; live window only, not a historical index. Each top story carries corroboration metadata: uniqueSourceCount, corroborationSourceCount, entityCorroboration, sourceTier, outlet names, clustered headlines, credibilityScore (0-100 source reliability, distinct from importance), corroboration, and the publishers roster; corroboration.state (single-publisher, tier4-only, corroborated, unknown) describes coverage, not accuracy. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. topic, category, country, alerts_only, query and min_importance narrow the lists; limit caps each (default 30, 0 = no cap). Paid News Intelligence panels charge one opening allocation; repeat opens and filters reuse it.',
    inputSchema: {
      type: 'object',
      properties: {
        panel_request: { type: 'string', maxLength: 160, description: 'Server-issued closed News Intelligence panel token. Omit for a paid opening; repeat and filters reuse its original source snapshot.' },
        refresh: { type: 'boolean', description: 'Paid panel only. Explicitly open a new allocation without panel_request and with a UUID request_id.' },
        request_id: { type: 'string', format: 'uuid', description: 'Refresh identity. Retrying the same UUID reuses that allocation.' },
        topic: {
          type: 'string',
          enum: ['conflict', 'economy', 'cyber', 'nuclear', 'intelligence', 'maritime'],
          description: 'Filter GDELT intelligence to a single topic.',
        },
        category: { type: 'string', description: 'Filter top news stories to one category (e.g. "conflict", "economy"; fallback is "general").' },
        country: { type: 'string', description: 'Filter top stories and travel advisories to one ISO 3166-1 alpha-2 country code (case-insensitive). Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.' },
        alerts_only: { type: 'boolean', description: 'Keep only top stories flagged as alerts.' },
        query: { type: 'string', description: 'Keep only top stories whose headline, primary source, or any clustered member headline contains this text (case-insensitive substring). This filters the LIVE news window only — it is not a historical index, so an event older than the current digest will not be found here. Use search_intel_history for that.' },
        min_importance: { type: 'number', description: 'Keep only top stories whose effectiveImportanceScore is at least this value. 0 is honoured as a real floor rather than treated as absent; a story carrying no score is excluded when this is set, never treated as scoring zero.' },
        limit: { type: 'number', description: 'Cap each list (top stories, signals, advisories) to at most this many items (default 30, pass 0 for no cap). Applied AFTER query and min_importance, so a capped list is drawn from the matches.' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      insights: {
        type: ['object', 'null'],
        properties: {
          topStories: { type: 'array', items: { type: 'object', properties: {
            primaryTitle: { type: 'string' }, primarySource: { type: 'string' }, primaryLink: { type: 'string' },
            // Epoch milliseconds from the digest pipeline, or an ISO string when a
            // feed item carried only a text date (scripts/seed-insights.mjs).
            pubDate: { type: ['string', 'number'] }, sourceCount: { type: 'number' }, importanceScore: { type: 'number' },
            credibilityScore: { type: 'number', description: '0-100 source-reliability score, distinct from importanceScore. Built from source tier, propaganda risk, and independent corroboration. State-controlled media is capped at 40.' },
            // Corroboration and clustering fields the seeder already writes
            // into every news:insights:v1 topStories entry (see the object
            // built in scripts/seed-insights.mjs). This is a cache tool: the
            // raw blob is served and _postFilter only narrows and caps, never
            // strips, so all of these already reach the client. Declaring them
            // closes a schema that was silently under-describing its own
            // payload, and left an agent unable to weigh corroboration. (#4925)
            uniqueSourceCount: { type: 'number', description: 'Distinct outlets that carried the story — the corroboration breadth signal.' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Outlet names in the cluster, tier-sorted and deduped.' },
            memberTitles: { type: 'array', items: { type: 'string' }, description: 'Headline of every article in the cluster, primary first.' },
            lastUpdated: { type: 'string', description: 'Timestamp of the newest article in the cluster.' },
            sourceTier: { type: 'number', description: 'Best (lowest) source tier in the cluster; 1 is a wire or primary outlet.' },
            entityCorroboration: { type: 'boolean', description: 'True when named entities were corroborated across outlets.' },
            corroborationSourceCount: { type: 'number', description: 'Outlets that independently corroborated the story per the seeder entity gate; 0 when that gate did not fire.' },
            upstreamImportanceScore: { type: 'number', description: 'Highest per-article importance score in the cluster, before seeder re-ranking.' },
            effectiveImportanceScore: { type: 'number', description: 'Post-ranking importance score used to order topStories.' },
            velocity: { type: 'object', properties: {
              level: { type: 'string' }, sourcesPerHour: { type: 'number' },
            } },
            category: { type: 'string' }, threatLevel: { type: 'string' },
            countryCode: { type: ['string', 'null'] }, isAlert: { type: 'boolean' },
            countryCodes: { type: 'array', items: { type: 'string' }, description: 'Every country named in the headline, primary (countryCode) first. The country filter matches any of them.' },
            sourceProvenance: {
              type: 'object',
              properties: {
                risk: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
                type: { type: 'string', enum: ['wire', 'gov', 'intel', 'mainstream', 'market', 'tech', 'other', 'unknown'] },
                riskDeclared: { type: 'boolean' },
                typeDeclared: { type: 'boolean' },
                riskReviewed: { type: 'boolean' },
                typeReviewed: { type: 'boolean' },
                stateAffiliated: { type: 'string' },
                knownBiases: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Curated perspective labels. Recorded for few sources: empty means not assessed, not neutral.',
                },
                note: { type: 'string' },
                summary: { type: 'string', description: 'Every provenance fact as short fixed-order clauses in one string; includes "Perspective: none recorded." when no label exists.' },
              },
              required: ['risk', 'type', 'riskDeclared', 'typeDeclared', 'riskReviewed', 'typeReviewed', 'knownBiases', 'summary'],
            },
            corroboration: CORROBORATION_OUTPUT_SCHEMA,
            ...PUBLISHER_ROSTER_OUTPUT_PROPERTIES,
          } } },
        },
      },
      'gdelt-intel': {
        type: ['object', 'null'],
        properties: {
          topics: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, signals: { type: ['array', 'object'] } } } },
        },
      },
      'cross-source-signals': {
        type: ['object', 'null'],
        properties: { signals: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: [...CROSS_SOURCE_SIGNAL_TYPES] },
          theater: { type: 'string' },
          summary: { type: 'string' },
          severity: { type: 'string' },
          severityScore: { type: 'number' },
          detectedAt: { type: 'number' },
          contributingTypes: { type: 'array', items: { type: 'string' } },
          signalCount: { type: 'number' },
        } } } },
      },
      'advisories-bootstrap': {
        type: ['object', 'null'],
        properties: {
          advisories: { type: 'array', items: { type: 'object', properties: { country: { type: 'string' }, level: { type: ['string', 'number'] } } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const topic = argStr(params.topic);
      const category = argStr(params.category);
      const countries = resolveCountryFilter(params.country, 'country');
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      mapNested(data, 'insights', 'topStories', addNewsSourceProvenance);
      if (topic) narrowNested(data, 'gdelt-intel', 'topics', (t) => argStr(t.id) === topic);
      if (category) narrowNested(data, 'insights', 'topStories', (s) => argStr(s.category) === category);
      if (countries.length > 0) {
        narrowNested(data, 'insights', 'topStories', (s) => storyCountryCodes(s).some((code) => matchesCode(code, countries)));
        narrowNested(data, 'advisories-bootstrap', 'advisories', (a) => matchesCode(a.country, countries));
      }
      if (argBool(params.alerts_only)) narrowNested(data, 'insights', 'topStories', (s) => s.isAlert === true);
      // query + min_importance run BEFORE the caps: filtering after capping
      // would draw the cap from the first N items and then match within them,
      // so a story matching the query but sitting past the cap would vanish.
      const query = argStr(params.query);
      if (query) {
        narrowNested(data, 'insights', 'topStories', (s) => (
          ciIncludes(s.primaryTitle, query)
          || ciIncludes(s.primarySource, query)
          || (Array.isArray(s.memberTitles) && s.memberTitles.some((t: unknown) => ciIncludes(t, query)))
        ));
      }
      // `?? null` distinguishes an absent threshold from an explicit 0, which
      // is a real floor: a story with no score must not pass it.
      const minImportance = argNum(params.min_importance);
      if (minImportance !== null) {
        narrowNested(data, 'insights', 'topStories', (s) => {
          const score = argNum(s.effectiveImportanceScore);
          return score !== null && score >= minImportance;
        });
      }
      capNested(data, 'insights', 'topStories', limit);
      capNested(data, 'cross-source-signals', 'signals', limit);
      capNested(data, 'advisories-bootstrap', 'advisories', limit);
      return data;
    },
    _cacheKeys: [
      'news:insights:v1',
      'intelligence:gdelt-intel:v1',
      'intelligence:cross-source-signals:v1',
      'intelligence:advisories-bootstrap:v1',
    ],
    // Per-key budgets (#5864): the envelope used to gate on the insights meta
    // alone, so a stalled GDELT materializer left agents reading stale:false
    // for hours. Every bundled key now carries its own freshness budget,
    // matching api/health.js.
    _freshnessChecks: [
      { key: 'seed-meta:news:insights',                    maxStaleMin: 30 },  // 15min cron × 2
      { key: 'seed-meta:intelligence:gdelt-intel',         maxStaleMin: 45, honorContentAge: true }, // 15min materializer; matches api/health.js
      { key: 'seed-meta:intelligence:cross-source-signals', maxStaleMin: 60 }, // 30min cron × 2
    ],
    _apiPaths: [
      "GET /api/intelligence/v1/list-cross-source-signals",
      "GET /api/intelligence/v1/search-gdelt-documents",
    ],
  },
  {
    name: 'get_natural_disasters',
    title: 'Earthquakes, wildfires and natural hazards',
    _uiResourceUri: NATURAL_DISASTERS_UI_URI,
    _outputBudgetBytes: 131072,
    description: 'Recent M4.5+ earthquakes (USGS and Earthquakes Canada / NRCan), active wildfires (NASA FIRMS), and natural hazard events. Pro panels charge one allocation per opening; repeated views reuse the admission. Snapshot reuse is bounded by source clocks and known health, not complete provider coverage. An oversized response simplifies or omits storm geometry and regional detail, with explicit transportCoverage counts; a jmespath projection that fits returns the original detail. bbox or lat/lon/radius_km limit the area, since_days the last N days; geo_filter counts rows lacking coordinates or dates.',
    inputSchema: {
      type: 'object',
      properties: {
        panel_request: { type: 'string', maxLength: 160, description: 'Server-issued Natural Disasters panel token, or the existing news token for its exact bounded map reads. Omit for an ordinary paid opening; a news token cannot widen its map scope.' },
        refresh: { type: 'boolean', description: 'Paid standalone panel only. Explicitly open one new allocation. Omit panel_request and supply a UUID request_id.' },
        request_id: { type: 'string', format: 'uuid', description: 'Paid standalone refresh identity. Retrying the same UUID reuses that allocation.' },
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['earthquakes', 'wildfires', 'other'] },
          description: 'Restrict to one or more hazard datasets (earthquakes / wildfires / other natural events). Omit for all.',
        },
        min_magnitude: { type: 'number', description: 'Drop earthquakes and natural events below this magnitude.' },
        active_only: { type: 'boolean', description: 'Keep only natural events that are still active (not closed).' },
        limit: { type: 'number', description: 'Cap each hazard list to at most this many items (default 30, pass 0 for no cap).' },
        ...GEO_FILTER_PROPERTIES,
      },
      required: [],
    },
    outputSchema: (() => {
      const schema = cacheEnvelope({
      earthquakes: {
        type: ['object', 'null'],
        properties: {
          earthquakes: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, place: { type: 'string' }, magnitude: { type: 'number' },
            depthKm: { type: 'number' }, occurredAt: { type: 'number' }, sourceUrl: { type: 'string' }, source: { type: 'string' }, category: { type: 'string' },
            location: { type: 'object', properties: {
              latitude: { type: 'number' }, longitude: { type: 'number' },
            } },
            nearTestSite: { type: 'boolean' }, testSiteName: { type: 'string' },
            concernScore: { type: 'number' }, concernLevel: { type: 'string' },
          } } },
        },
      },
      fires: {
        type: ['object', 'null'],
        properties: {
          fireDetections: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' },
            location: { type: 'object', properties: {
              latitude: { type: 'number' }, longitude: { type: 'number' },
            } },
            brightness: { type: 'number' }, frp: { type: 'number' },
            confidence: { type: 'string', enum: [
              'FIRE_CONFIDENCE_HIGH', 'FIRE_CONFIDENCE_NOMINAL',
              'FIRE_CONFIDENCE_LOW', 'FIRE_CONFIDENCE_UNSPECIFIED',
            ] },
            satellite: { type: 'string' }, detectedAt: { type: 'number' }, region: { type: 'string' },
            dayNight: { type: 'string' }, possibleExplosion: { type: 'boolean' },
          } } },
        },
      },
      events: {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            magnitude: { type: ['number', 'null'] }, closed: { type: 'boolean' },
            country: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' },
          } } },
        },
      },
      geo_filter: GEO_FILTER_OUTPUT_SCHEMA,
      }) as { properties: Record<string, unknown> };
      return { ...schema, properties: { ...schema.properties, transportCoverage: {
        type: 'object', required: ['count_scope', 'details'], properties: {
          count_scope: { const: 'post_filter_snapshot' },
          details: { type: 'array', items: { type: 'object', required: [
            'dataset', 'collection', 'event_id', 'event_index', 'field', 'state', 'original_count',
            'returned_count', 'omitted_count', 'omission_reason', 'geometry_simplified',
          ], properties: {
            dataset: { const: 'events' }, collection: { type: 'string' },
            event_id: { type: ['string', 'null'] }, event_index: { type: ['integer', 'null'], minimum: 0 },
            field: { type: 'string' }, state: { const: 'available' },
            original_count: { type: 'integer', minimum: 0 }, returned_count: { type: 'integer', minimum: 0 },
            omitted_count: { type: 'integer', minimum: 0 },
            omission_reason: { enum: ['geometry_simplified', 'output_budget'] }, geometry_simplified: { type: 'boolean' },
            original_ring_count: { type: 'integer', minimum: 0 }, returned_ring_count: { type: 'integer', minimum: 0 },
          } } },
        },
      } } };
    })(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const minMag = argNum(params.min_magnitude);
      data.events = projectNaturalEventsRetention(data.events);
      const stored = oldestDatedRows(data, NATURAL_DISASTER_EVENT_LISTS);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (minMag != null) {
        narrowNested(data, 'earthquakes', 'earthquakes', (q) => (argNum(q.magnitude) ?? 0) >= minMag);
        narrowNested(data, 'events', 'events', (e) => (argNum(e.magnitude) ?? 0) >= minMag);
      }
      if (argBool(params.active_only)) narrowNested(data, 'events', 'events', (e) => e.closed === false);
      const geo = filterEventLists(data, NATURAL_DISASTER_EVENT_LISTS, params, 'get_natural_disasters', stored);
      capNested(data, 'earthquakes', 'earthquakes', limit);
      capNested(data, 'fires', 'fireDetections', limit);
      capNested(data, 'events', 'events', limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = { earthquakes: 'earthquakes', wildfires: 'fires', other: 'events' };
        return attachGeoFilter(selectDatasets(data, compact(ds.map((d) => map[d]))), geo);
      }
      return attachGeoFilter(data, geo);
    },
    _validateArgs: params => { parseEventFilter(params, 'get_natural_disasters'); },
    _fitToBudget: (result, budgetBytes, args) => presentNaturalDisastersPanel(result, budgetBytes, argBool(args.summary)),
    _cacheKeys: [
      'seismology:earthquakes:v1',
      'wildfire:fires:v1',
      'natural:events:v1',
    ],
    _freshnessChecks: [{ key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 }],
    _apiPaths: [
      "GET /api/natural/v1/list-natural-events",
      "GET /api/seismology/v1/list-earthquakes",
      "GET /api/wildfire/v1/list-fire-detections",
    ],
  },
  {
    name: 'get_military_posture',
    title: 'Theater military posture',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded theater posture assessment: for each global theater (Iran, Taiwan, Baltic, Korea and others) a posture level, military risk score and the aggregated positioning and escalation signals behind it. Flagged stale after 2 hours; theater-level summaries only, no individual aircraft or vessel tracks. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. theater is a case-insensitive id substring, posture_level filters one level exactly, limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        theater: { type: 'string', description: 'Filter to one theater by id (case-insensitive substring, e.g. "iran", "taiwan", "baltic", "korea").' },
        posture_level: { type: 'string', description: 'Filter to a single posture level.' },
        limit: { type: 'number', description: 'Cap the theaters list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      theater_posture: {
        type: ['object', 'null'],
        properties: {
          theaters: { type: 'array', items: { type: 'object', properties: {
            theater: { type: 'string' }, postureLevel: { type: 'string' },
            summary: { type: 'string' }, signals: { type: ['array', 'object', 'null'] },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      projectRedistributableTheaterPosture(data);
      const theater = argStr(params.theater);
      const level = argStr(params.posture_level);
      if (theater) narrowNested(data, 'theater_posture', 'theaters', (t) => ciIncludes(t.theater, theater));
      if (level) narrowNested(data, 'theater_posture', 'theaters', (t) => argStr(t.postureLevel) === level);
      capNested(data, 'theater_posture', 'theaters', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['theater_posture:sebuf:stale:v1'],
    _freshnessChecks: [{ key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 120 }],
    // CASCADE-MIRROR EQUIVALENCE: the API handler at
    // server/worldmonitor/military/v1/get-theater-posture.ts:23 reads 3 cascade
    // variants (live + stale + backup) and returns the freshest available.
    // This MCP tool reads only the stale variant; PR #3658's U7 already
    // documents `theater-posture:sebuf:v1` and `theater-posture:sebuf:backup:v1`
    // as `cascade-mirror: covered by get_military_posture` exclusions in the
    // bootstrap-parity test — they share the same payload shape, only freshness
    // differs. Coverage is intentional. The audit script's partial-overlap
    // warning for this op is suppressed via CASCADE_MIRROR_EXEMPT in
    // scripts/audit-mcp-api-coverage.mjs.
    _apiPaths: [
      "GET /api/military/v1/get-theater-posture",
    ],
  },
  {
    name: 'get_cyber_threats',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Cyber threat intelligence',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded cyber-threat snapshot: malware indicators of compromise (URLhaus, Feodo Tracker), CISA Known Exploited Vulnerabilities and active command-and-control infrastructure, each with type, severity, country when known, and first-seen time. Flagged stale after 4 hours. Indicator feeds only; no incident narratives or attribution analysis. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. threat_type is a case-insensitive substring (malware, vulnerability, c2); min_severity keeps known severities at or above a level; country drops threats without a country; limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        threat_type: { type: 'string', description: 'Filter to one threat type (case-insensitive substring, e.g. "malware", "vulnerability", "c2").' },
        min_severity: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Keep only threats with a known severity at or above this level; exclude missing or unrecognized severities.',
        },
        country: { type: 'string', description: 'Filter to one ISO 3166-1 alpha-2 country code (many threats have no country and are dropped by this filter). Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.' },
        limit: { type: 'number', description: 'Cap the threat list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'threats-bootstrap': {
        type: ['object', 'null'],
        properties: {
          threats: { type: 'array', items: { type: 'object', properties: {
            type: { type: 'string' }, severity: { type: 'string' }, country: { type: 'string' },
            indicator: { type: 'string' }, description: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.threat_type);
      const countries = resolveCountryFilter(params.country, 'country');
      const minSev = argStr(params.min_severity).replace('criticality_level_', '');
      const ranks: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      const minRank = ranks[minSev];
      if (type) narrowNested(data, 'threats-bootstrap', 'threats', (t) => ciIncludes(t.type, type));
      if (countries.length > 0) {
        narrowNested(data, 'threats-bootstrap', 'threats', (t) => matchesCode(t.country, countries));
      }
      if (minRank != null) {
        narrowNested(data, 'threats-bootstrap', 'threats', (t) => {
          const tok = argStr(t.severity).replace('criticality_level_', '');
          const r = ranks[tok];
          return r != null && r >= minRank;
        });
      }
      capNested(data, 'threats-bootstrap', 'threats', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['cyber:threats-bootstrap:v2'],
    _freshnessChecks: [{ key: 'seed-meta:cyber:threats', maxStaleMin: 240 }],
    _apiPaths: [],
  },
  {
    name: 'get_economic_data',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Rates, economic calendars and fuel prices',
    _outputBudgetBytes: 131072,
    description: 'Read cached rates, calendars and fuel prices with official-only 12-series China macro (no proxies, see launchReady). Includes Fed Funds (FRED), economic and official NBS/PBoC release calendars, fuel prices, ECB FX rates, Bank of Russia official rates (RUB per 1 unit of each listed currency, plus the CBR key policy rate), EU yield curves, US federal spending awards, earnings, COT positioning, BIS household debt service ratios, and BIS residential/commercial property prices. Optional China macro data has official-only 12-series; 5 NBS/SAFE ingestible, PBoC/GACC unavailable, no proxies; see launchReady/status. Retained values expose transportStatus and transportFailureReason independently. Requested datasets may be unavailable or stale; this tool reads cached data and does not fetch fresh upstream releases.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['fedfunds', 'econ-calendar', 'china-macro', 'china-release-calendar', 'fuel-prices', 'ecb-fx-rates', 'cbr-rates', 'yield-curve-eu', 'spending', 'earnings-calendar', 'cot', 'dsr', 'property-residential', 'property-commercial'],
          },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full economic bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-keyed datasets (fuel-prices, BIS DSR/property, economic calendar) to one ISO 3166-1 alpha-2 code. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (calendar, spending, earnings) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // FRED key is `economic:fred:v1:FEDFUNDS:0` — the label-walk skips the
    // `0` suffix (NON_LABEL regex matches bare digits) and the `v1` segment,
    // landing on `FEDFUNDS`.
    outputSchema: cacheEnvelope({
      FEDFUNDS: { type: ['object', 'array', 'null'] },
      'econ-calendar': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, event: { type: 'string' }, time: { type: ['string', 'number'] },
        } } } },
      },
      'china-macro': {
        type: ['object', 'null'],
        properties: {
          countryCode: { type: 'string' }, launchReady: { type: 'boolean' }, status: { type: 'string' },
          indicators: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, label: { type: 'string' }, category: { type: 'string' },
            value: { type: ['number', 'null'] }, priorValue: { type: ['number', 'null'] },
            comparisonValue: { type: ['number', 'null'] }, comparisonBasis: { type: 'string' },
            unit: { type: 'string' },
            observationDate: { type: 'string' }, source: { type: 'string' },
            stale: { type: 'boolean' }, unavailableReason: { type: 'string' },
            transportStatus: { type: 'string' }, transportFailureReason: { type: 'string' },
          } } },
        },
      },
      'china-release-calendar': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          event: { type: 'string' }, countryCode: { type: 'string' }, releaseDate: { type: 'string' }, status: { type: 'string' }, source: { type: 'string' },
        } } } },
      },
      'fuel-prices': {
        type: ['object', 'null'],
        properties: { countries: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' } } } } },
      },
      'ecb-fx-rates': { type: ['object', 'null'] },
      // Described rather than left as a bare object, unlike its ecb-fx-rates
      // neighbour: this dataset has no dashboard panel, so an MCP caller is its
      // ONLY reader and there is no UI to cross-check a misreading against. The
      // three properties below each name a specific misreading — inverted
      // direction, a date read as "today", and the per-Nominal block price
      // mistaken for the unit rate.
      'cbr-rates': {
        type: ['object', 'null'],
        properties: {
          quoteCurrency: { type: 'string', description: 'Always "RUB". Rates are RUB PER ONE UNIT of each listed currency — rates.USD.rate = 81.13 means 1 USD costs 81.13 RUB, not the reverse.' },
          rateUnit: { type: 'string', description: 'Human-readable restatement of the quote direction.' },
          effectiveDate: { type: 'string', description: 'ISO date the rate is OFFICIALLY IN FORCE. CBR sets rates for the next calendar day, so this is routinely tomorrow — it is not "as of today".' },
          previousDate: { type: ['string', 'null'], description: 'The calendar day requested as the change1d baseline.' },
          previousEffectiveDate: { type: ['string', 'null'], description: 'The day CBR stamped on the baseline table it returned; differs from previousDate after a weekend or holiday.' },
          rates: {
            type: 'object',
            description: 'Keyed by ISO 4217 alpha code. Use `rate`; `valuePerNominal` is the block price and is 100x or 10000x larger for currencies quoted per 100 or per 10 000 units.',
            additionalProperties: {
              type: 'object',
              properties: {
                rate: { type: 'number', description: 'RUB per ONE unit. The field to quote.' },
                valuePerNominal: { type: 'number', description: 'RUB per `nominal` units, as published. NOT the unit rate.' },
                nominal: { type: 'number', description: 'Units the published price covers (1, 100, or 10000).' },
                name: { type: 'string', description: 'Official CBR currency name, in Russian.' },
                numCode: { type: 'string' },
                change1d: { type: ['number', 'null'], description: 'Change in `rate` vs the previous day, or null when that baseline was unavailable — never 0 for unknown.' },
              },
            },
          },
          keyRate: {
            type: ['object', 'null'],
            description: 'CBR key policy rate. `changes` lists only observed transitions; `windowStart` is where the 2-year lookback opened and is NOT a policy decision.',
            properties: {
              rate: { type: 'number', description: 'Current key rate, percent.' },
              observedAt: { type: 'string', description: 'Newest observation date, not the date the rate last moved.' },
              previousRate: { type: ['number', 'null'] },
              changedAt: { type: ['string', 'null'], description: 'First date at the current rate, or null when the window shows no move.' },
              change: { type: ['number', 'null'] },
              windowStart: { type: 'object', description: 'Oldest observation in the queried window. Its date is the lookback boundary, NOT a rate decision.' },
              changes: { type: 'array', description: 'Observed transitions, oldest first. Empty when the rate held for the whole window.', items: { type: 'object' } },
            },
          },
        },
      },
      'yield-curve-eu': { type: ['object', 'null'] },
      spending: {
        type: ['object', 'null'],
        properties: { awards: { type: 'array', items: { type: 'object' } } },
      },
      'earnings-calendar': {
        type: ['object', 'null'],
        properties: { earnings: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, date: { type: 'string' } } } } },
      },
      cot: { type: ['object', 'null'] },
      dsr: {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
      'property-residential': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
      'property-commercial': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      data['china-macro'] = projectChinaMacroForMcp(data['china-macro']);
      const countries = resolveCountryFilter(params.country, 'country');
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'fuel-prices', 'countries', (c) => matchesCode(c.code, countries));
        narrowNested(data, 'econ-calendar', 'events', (e) => matchesCode(e.country, countries));
        narrowNested(data, 'china-release-calendar', 'events', (e) => matchesCode(e.countryCode, countries));
        if (!countries.some((code) => code.toUpperCase() === 'CN')) data['china-macro'] = null;
        for (const label of ['dsr', 'property-residential', 'property-commercial']) {
          narrowNested(data, label, 'entries', (e) => matchesCode(e.countryCode, countries));
        }
      }
      capNested(data, 'econ-calendar', 'events', limit);
      capNested(data, 'china-release-calendar', 'events', limit);
      capNested(data, 'spending', 'awards', limit);
      capNested(data, 'earnings-calendar', 'earnings', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: [
      'economic:fred:v1:FEDFUNDS:0',
      'economic:econ-calendar:v1',
      BOOTSTRAP_CACHE_KEYS.chinaMacro,
      BOOTSTRAP_CACHE_KEYS.chinaReleaseCalendar,
      'economic:fuel-prices:v1',
      'economic:ecb-fx-rates:v1',
      'economic:cbr-rates:v1',
      'economic:yield-curve-eu:v1',
      'economic:spending:v1',
      'market:earnings-calendar:v1',
      'market:cot:v1',
      'economic:bis:dsr:v1',
      'economic:bis:property-residential:v1',
      'economic:bis:property-commercial:v1',
    ],
    _cacheLabels: {
      [BOOTSTRAP_CACHE_KEYS.chinaMacro]: 'china-macro',
      [BOOTSTRAP_CACHE_KEYS.chinaReleaseCalendar]: 'china-release-calendar',
    },
    _freshnessChecks: [
      { key: 'seed-meta:economic:econ-calendar', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:china-macro-transport', maxStaleMin: 4320 },
      { key: 'seed-meta:economic:china-release-calendar', maxStaleMin: 4320 },
      // Per-dataset BIS seed-meta keys — the aggregate
      // `seed-meta:economic:bis-extended` would report "fresh" even if only
      // one of the three datasets (DSR / SPP / CPP) is current, matching the
      // false-freshness bug already fixed for /api/health and resilience.
      { key: 'seed-meta:economic:bis-dsr', maxStaleMin: 1440 }, // 12h cron × 2
      { key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:bis-property-commercial', maxStaleMin: 1440 },
      // No cbr-rates entry, matching its closest peer in this tool (ecb-fx-rates)
      // and 8 of the 14 datasets here. evaluateFreshness treats a missing
      // seed-meta as stale and ORs every check into ONE tool-level flag, so a
      // brand-new key would mark every UNRELATED dataset stale — with
      // cached_at: null — from the Vercel deploy until the first Railway tick.
      // The activation-marker grace only covers requireContentFreshness blocks,
      // so it cannot bridge that. CBR freshness is owned by /api/health, which
      // models it per-key and with a content-age contract this shape cannot
      // express (see cbrContentMeta in scripts/seed-cbr-rates.mjs).
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-ecb-fx-rates",
      "GET /api/economic/v1/get-economic-calendar",
      "GET /api/economic/v1/get-china-macro-snapshot",
      "GET /api/economic/v1/get-eu-yield-curve",
      "GET /api/economic/v1/list-fuel-prices",
      "GET /api/market/v1/get-cot-positioning",
      "GET /api/market/v1/list-earnings-calendar",
    ],
  },
  {
    name: 'get_country_macro',
    _validateArgs: params => { resolveCountryFilter(params.countries, 'countries'); },
    title: 'Country macroeconomic indicators',
    _outputBudgetBytes: 131072,
    description: 'Per-country macroeconomic indicators from IMF WEO (~210 countries, monthly cadence). Bundles fiscal/external balance (inflation, current account, gov revenue/expenditure/primary balance, CPI), growth & per-capita (real GDP growth, GDP/capita USD & PPP, savings & investment rates, savings-investment gap), labor & demographics (unemployment, population), and external trade (current account USD, import/export volume % changes). Latest available year per series. Use for country-level economic screening, peer benchmarking, and stagflation/imbalance flags. NOTE: export/import LEVELS in USD (exportsUsd, importsUsd, tradeBalanceUsd) are returned as null — WEO retracted broad coverage for BX/BM indicators in 2026-04; use currentAccountUsd or volume changes (import/exportVolumePctChg) instead.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'ISO 3166-1 alpha-2 country codes to keep across all four IMF datasets (e.g. ["US","DE","CN"]). Omit for all ~210 countries. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap each IMF dataset country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // Each IMF label maps to `{ countries: { [iso2]: { ... per-series metrics ... } } }`.
    outputSchema: cacheEnvelope({
      macro: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      growth: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      labor: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      external: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = resolveCountryFilter(params.countries, 'countries');
      if (codes.length > 0) {
        for (const label of ['macro', 'growth', 'labor', 'external']) pickNestedMap(data, label, 'countries', codes);
        return data;
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      for (const label of ['macro', 'growth', 'labor', 'external']) capNestedMap(data, label, 'countries', limit);
      return data;
    },
    _cacheKeys: [
      'economic:imf:macro:v2',
      'economic:imf:growth:v1',
      'economic:imf:labor:v1',
      'economic:imf:external:v1',
    ],
    _freshnessChecks: [
      { key: 'seed-meta:economic:imf-macro', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-growth', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-labor', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-external', maxStaleMin: 100800 },
    ],
    _apiPaths: [],
  },
  {
    name: 'get_eu_housing_cycle',
    _validateArgs: params => { resolveEurostatCountryFilter(params.countries); },
    title: 'EU house price index',
    _outputBudgetBytes: 131072,
    description: 'Eurostat annual house price index (prc_hpi_a, base 2015=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes the latest value, prior value, date, unit, and a 10-year sparkline series. Complements BIS WS_SPP with broader EU coverage for the Housing cycle tile.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'house-prices': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          date: { type: 'string' }, unit: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = resolveEurostatCountryFilter(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'house-prices', 'countries', codes);
        return data;
      }
      capNestedMap(data, 'house-prices', 'countries', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['economic:eurostat:house-prices:v1'],
    _freshnessChecks: [{ key: 'seed-meta:economic:eurostat-house-prices', maxStaleMin: 60 * 24 * 50 }], // weekly cron, annual data
    _apiPaths: [],
  },
  {
    name: 'get_eu_quarterly_gov_debt',
    _validateArgs: params => { resolveEurostatCountryFilter(params.countries); },
    title: 'EU quarterly government debt',
    _outputBudgetBytes: 131072,
    description: 'Eurostat quarterly general government gross debt (gov_10q_ggdebt, %GDP) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, quarter label, and an 8-quarter sparkline series. Provides fresher debt-trajectory signal than annual IMF GGXWDG_NGDP for EU panels.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'gov-debt-q': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          quarter: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = resolveEurostatCountryFilter(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'gov-debt-q', 'countries', codes);
        return data;
      }
      capNestedMap(data, 'gov-debt-q', 'countries', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['economic:eurostat:gov-debt-q:v1'],
    _freshnessChecks: [{ key: 'seed-meta:economic:eurostat-gov-debt-q', maxStaleMin: 60 * 24 * 14 }], // quarterly data, 2-day cron
    _apiPaths: [],
  },
  {
    name: 'get_eu_industrial_production',
    _validateArgs: params => { resolveEurostatCountryFilter(params.countries); },
    title: 'EU industrial production',
    _outputBudgetBytes: 131072,
    description: 'Return the Eurostat monthly industrial production index (sts_inpr_m: NACE B-D industry excluding construction, seasonally and calendar adjusted, 2021=100) for the 27 EU members plus the EA20 and EU27_2020 aggregates. Each country entry has the latest value, prior value, month label and a 12-month series. Monthly data; the seed is flagged stale after 5 days. Covers the EU industrial index only; no other production or GDP measures. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. countries uses Eurostat geo codes (ISO alpha-2 except EL for Greece); limit caps the country map when no filter is given (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'industrial-production': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          month: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = resolveEurostatCountryFilter(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'industrial-production', 'countries', codes);
        return data;
      }
      capNestedMap(data, 'industrial-production', 'countries', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['economic:eurostat:industrial-production:v1'],
    _freshnessChecks: [{ key: 'seed-meta:economic:eurostat-industrial-production', maxStaleMin: 60 * 24 * 5 }], // monthly data, daily cron
    _apiPaths: [],
  },
  {
    name: 'get_prediction_markets',
    title: 'Prediction markets',
    _uiResourceUri: PREDICTION_MARKETS_UI_URI,
    _outputBudgetBytes: 131072,
    description: 'Return seeded prediction-market contracts from multiple venues with current probabilities, grouped into three buckets: geopolitical (including elections), tech (AI, crypto, science) and finance (economics, plus the untagged fallback for non-geopolitical records). Flagged stale when the seed is older than 90 minutes. Kalshi currently supplies no classifier tags, so source=kalshi with category=tech returns no records and other non-geopolitical Kalshi records fall back to finance. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. query matches titles case-insensitively; limit caps each bucket (default 30, 0 for no cap). Dedicated paid connections reuse one panel allocation across openings and filters; refresh with a request_id starts a new one and the same ID retries it. API allowances retain per-tool billing. change24h/change7d are percentage-point moves (7d: Polymarket only); sort=move_24h|move_7d ranks by absolute move.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['geopolitical', 'tech', 'finance'],
          description: 'Restrict to one market category bucket. Omit for all three. Finance also owns untagged non-geopolitical records.',
        },
        query: { type: 'string', description: 'Keep only markets whose title contains this text (case-insensitive).' },
        source: { type: 'string', enum: ['kalshi', 'polymarket'], description: 'Filter to one prediction-market source. Kalshi currently provides no classifier tags, so source=kalshi with category=tech returns no records.' },
        sort: { type: 'string', enum: ['rank', 'move_24h', 'move_7d'], default: 'rank', description: 'Order each bucket by seed rank or absolute 24h/7d move before limiting. Missing moves go last.' },
        limit: { type: 'number', description: 'Cap each category bucket to at most this many markets (default 30, pass 0 for no cap).' },
        panel_request: { type: 'string', description: 'Paid prediction panel receipt. Reuse for internal curated reads without another daily allocation.' },
        refresh: { type: 'boolean', description: 'Paid panel only. Start a new allocation with request_id; retry the same ID to reuse it.' },
        request_id: { type: 'string', format: 'uuid', description: 'Paid refresh identifier. Required when refresh is true.' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'markets-bootstrap': {
        type: ['object', 'null'],
        properties: {
          geopolitical: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' }, yesPrice: { type: 'number', minimum: 0, maximum: 100 },
            change24h: { type: 'number', minimum: -100, maximum: 100 },
            change7d: { type: 'number', minimum: -100, maximum: 100 },
            source: { type: 'string' }, volume: { type: 'number' }, url: { type: 'string' },
            endDate: { type: 'string' }, regions: { type: 'array', items: { type: 'string' } },
          } } },
          tech: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' }, yesPrice: { type: 'number', minimum: 0, maximum: 100 },
            change24h: { type: 'number', minimum: -100, maximum: 100 },
            change7d: { type: 'number', minimum: -100, maximum: 100 },
            source: { type: 'string' }, volume: { type: 'number' }, url: { type: 'string' },
            endDate: { type: 'string' }, regions: { type: 'array', items: { type: 'string' } },
          } } },
          finance: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' }, yesPrice: { type: 'number', minimum: 0, maximum: 100 },
            change24h: { type: 'number', minimum: -100, maximum: 100 },
            change7d: { type: 'number', minimum: -100, maximum: 100 },
            source: { type: 'string' }, volume: { type: 'number' }, url: { type: 'string' },
            endDate: { type: 'string' }, regions: { type: 'array', items: { type: 'string' } },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const buckets = ['geopolitical', 'tech', 'finance'];
      const bootstrap = data['markets-bootstrap'];
      if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)
        || !buckets.every(bucket => Array.isArray((bootstrap as Record<string, unknown>)[bucket]))) return data;
      const category = argStr(params.category);
      const query = argStr(params.query);
      const source = argStr(params.source);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      const sort = argStr(params.sort);
      const changeField = sort === 'move_24h' ? 'change24h' : sort === 'move_7d' ? 'change7d' : null;
      for (const b of buckets) {
        if (query) narrowNested(data, 'markets-bootstrap', b, (m) => ciIncludes(m.title, query));
        if (source) narrowNested(data, 'markets-bootstrap', b, (m) => argStr(m.source) === source);
        if (changeField) {
          const node = bootstrap as Record<string, unknown>;
          node[b] = [...node[b] as Record<string, unknown>[]].sort((a, b) => {
            const aMove = a[changeField];
            const bMove = b[changeField];
            return (typeof bMove === 'number' && Number.isFinite(bMove) ? Math.abs(bMove) : -1)
              - (typeof aMove === 'number' && Number.isFinite(aMove) ? Math.abs(aMove) : -1);
          });
        }
        capNested(data, 'markets-bootstrap', b, limit);
      }
      if (category && buckets.includes(category)) {
        const node = data['markets-bootstrap'];
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          const n = node as Record<string, unknown>;
          for (const b of buckets) if (b !== category) n[b] = [];
        }
      }
      return data;
    },
    _cacheKeys: ['prediction:markets-bootstrap:v1'],
    _freshnessChecks: [{ key: 'seed-meta:prediction:markets', maxStaleMin: 90 }],
    _apiPaths: [
      "GET /api/prediction/v1/list-prediction-markets",
    ],
  },
  {
    name: 'get_sanctions_data',
    _validateArgs: params => { sanctionsArguments(params); },
    title: 'Sanctions lists and pressure scores',
    _subscriptionOnly: true,
    _outputBudgetBytes: 131072,
    description: 'Screen OFAC SDN, OFAC Consolidated, Canada SEMA and six US Consolidated Screening List export-control lists (BIS Entity, Denied Persons, Unverified, Military End User; State ITAR debarred, nonproliferation), or read country pressure and designation changes. Pressure counts OFAC and SEMA only; CSL rows have et unspecified, and their events carry notice (Federal Register citation) and url. screen matches names, up to 10 aliases and exact IMO IDs, returning score/matched_on/matched_text; query filters primary names. changes_since_days (1-90) selects history only, paged by changes_cursor, max 100 events/page. Gaps include held diffs above 5% removals; history keeps 90 days/10,000 events (truncatedBefore marks cap loss). Seeded every 6 hours, stale after 12 hours; no live fetch. Subscription required, weight 1. Matches are leads to confirm with the issuing agency, not legal advice.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter sanctioned entities and pressure scores to one ISO 3166-1 alpha-2 country code. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.' },
        entity_type: { type: 'string', description: 'Filter to one entity type (case-insensitive substring, e.g. "vessel", "aircraft", "individual", "entity"; CSL rows are "unspecified").' },
        query: { type: 'string', description: 'Keep only sanctioned entities whose name contains this text (case-insensitive).' },
        screen: { type: 'string', minLength: 2, maxLength: 200, description: 'Screen a name, alias or IMO identifier against the seeded lists (2-200 characters). Omit changes_since_days for entity screening.' },
        min_score: { type: 'number', minimum: 0, maximum: 100, default: 70, description: 'Minimum screening score from 0 to 100 (default 70); applies only with screen.' },
        changes_since_days: { type: 'integer', minimum: 1, maximum: 90, description: 'Select history only for the last 1-90 days. Country, entity_type and query filter events; gaps remain visible on every page.' },
        changes_cursor: { type: 'string', maxLength: 64, description: 'Continue from changes.nextCursor with the same filters. Restart if the seeded history changed.' },
        limit: { type: 'number', description: 'List cap, default 30; 0 removes the cap except in history mode, where pages contain at most 100 events and may be smaller to fit the response budget.' },
      },
      required: [],
    },
    // `_postFilter` calls `narrowArray(data, 'entities', ...)` on the
    // entities slot, so that label's value is itself an array (not an object
    // with a child array). The pressure label is the usual `{entries, countries}` shape.
    outputSchema: cacheEnvelope({
      entities: {
        type: ['array', 'object', 'null'],
        items: { type: 'object', properties: {
          // Up to three ISO country codes per entity (scripts/seed-sanctions-pressure.mjs).
          name: { type: 'string' }, cc: { type: 'array', items: { type: 'string' } }, et: { type: 'string' },
          id: { type: 'string' }, pr: { type: 'array', items: { type: 'string' } },
          al: { type: 'array', maxItems: 10, items: { type: 'string' } },
          ids: { type: 'array', items: { type: 'string' } }, sl: { type: 'array', items: { type: 'string' } },
          score: { type: 'number', minimum: 0, maximum: 100 },
          matched_on: { enum: ['name', 'alias', 'identifier'] }, matched_text: { type: 'string' },
        } },
      },
      pressure: {
        type: ['object', 'null'],
        properties: {
          entries: { type: 'array', items: { type: 'object', properties: {
            countryCodes: { type: ['array', 'string'] }, entityType: { type: 'string' },
          } } },
          countries: { type: 'array', items: { type: 'object', properties: {
            countryCode: { type: 'string' }, pressureScore: { type: 'number' },
          } } },
        },
      },
      changes: {
        type: ['object', 'null'],
        properties: {
          version: { type: 'number' }, fetchedAt: { type: 'number' }, truncatedBefore: { type: 'number' },
          matchingEvents: { type: 'integer' }, nextCursor: { type: 'string', description: 'Continue with changes_cursor; empty when complete. Keep the same filters.' },
          events: { type: 'array', items: { type: 'object', properties: {
            at: { type: 'number' }, effectiveAt: { type: 'string' },
            op: { type: 'string', enum: ['added', 'removed', 'amended'] },
            list: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, et: { type: 'string' },
            cc: { type: 'array', items: { type: 'string' } }, pr: { type: 'array', items: { type: 'string' } },
            prevPr: { type: 'array', items: { type: 'string' } },
            notice: { type: 'string', description: 'Federal Register citation (CSL lists only).' },
            url: { type: 'string', description: 'Issuing list page (CSL lists only).' },
          } } },
          gaps: { type: 'array', items: { type: 'object', properties: {
            list: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' },
            reason: { type: 'string', enum: ['retained', 'unavailable', 'held', 'baseline-unavailable'] },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const { countries, days, cursor } = sanctionsArguments(params);
      const etype = argStr(params.entity_type);
      const query = argStr(params.query);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (days === undefined) delete data.changes;
      else {
        const snapshotAt = (data.changes as { fetchedAt?: number } | null)?.fetchedAt;
        const since = (snapshotAt ?? Date.now()) - (days as number) * 86400000;
        narrowNested(data, 'changes', 'events', e => typeof e.at === 'number' && e.at >= since
          && (!countries.length || matchesCode(e.cc, countries))
          && (!etype || ciIncludes(e.et, etype)) && (!query || ciIncludes(e.name, query)));
        narrowNested(data, 'changes', 'gaps', gap => typeof gap.to === 'number' && gap.to >= since);
        const changes = data.changes;
        if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
          const log = changes as Record<string, unknown>;
          delete log.sourceFetchedAt;
          delete log.heldSources;
          if (cursor.fetchedAt !== undefined && cursor.fetchedAt !== log.fetchedAt) {
            throw new RpcValidationError('get_sanctions_data', [{ field: 'changes_cursor', description: 'History changed; restart without the cursor.' }]);
          }
          if (Array.isArray(log.events)) {
            log.events.sort((a, b) => Number(b.at) - Number(a.at));
            const total = log.events.length;
            if (cursor.offset > total) {
              throw new RpcValidationError('get_sanctions_data', [{ field: 'changes_cursor', description: 'Cursor is outside the filtered history.' }]);
            }
            const size = limit === 0 ? 100 : Math.max(1, Math.min(100, Math.trunc(limit)));
            const page = log.events.slice(cursor.offset, cursor.offset + size);
            log.events = page;
            log.matchingEvents = total;
            log.nextCursor = cursor.offset + page.length < total ? `${log.fetchedAt}:${cursor.offset + page.length}` : '';
          }
        }
      }
      if (countries.length > 0) {
        narrowArray(data, 'entities', (e) => matchesCode(e.cc, countries));
        narrowNested(data, 'pressure', 'entries', (e) => matchesCode(e.countryCodes, countries));
        narrowNested(data, 'pressure', 'countries', (c) => matchesCode(c.countryCode, countries));
      }
      if (etype) {
        narrowArray(data, 'entities', (e) => ciIncludes(e.et, etype));
        narrowNested(data, 'pressure', 'entries', (e) => ciIncludes(e.entityType, etype));
      }
      if (query) narrowArray(data, 'entities', (e) => ciIncludes(e.name, query));
      if (typeof params.screen === 'string' && Array.isArray(data.entities)) {
        data.entities = screenSanctions(data.entities, params.screen.trim(), argNum(params.min_score) ?? 70);
      }
      capArrays(data, limit);
      capNested(data, 'pressure', 'entries', limit);
      return data;
    },
    _fitToBudget: (result, budgetBytes, args) => {
      if (args.changes_since_days === undefined) return result;
      const presented = structuredClone(result);
      const data = presented.data as Record<string, unknown> | undefined;
      const log = data?.changes as Record<string, unknown> | null | undefined;
      if (!log || !Array.isArray(log.events)) return result;
      const { offset } = sanctionsChangesCursor(args.changes_cursor);
      while (log.events.length > 1 && utf8ByteLength(JSON.stringify(presented)) > budgetBytes) {
        log.events.pop();
        log.nextCursor = `${log.fetchedAt}:${offset + log.events.length}`;
      }
      return presented;
    },
    _cacheKeys: ['sanctions:entities:v1', 'sanctions:pressure:v1', 'sanctions:changes:v1'],
    _freshnessChecks: [
      { key: 'seed-meta:sanctions:entities', maxStaleMin: 720 },
      { key: 'seed-meta:sanctions:pressure', maxStaleMin: 720 },
      { key: 'seed-meta:sanctions:changes', maxStaleMin: 720 },
    ],
    _apiPaths: [
      "GET /api/sanctions/v1/list-sanctions-pressure",
      "GET /api/sanctions/v1/lookup-sanction-entity",
    ],
  },
  {
    name: 'get_cross_border_arrivals',
    title: 'Cross-border refugee arrivals',
    _outputBudgetBytes: 262144,
    description: 'Return UNHCR Operational Data Portal cross-border displacement situations: per-situation arrival and return counts, stock totals, source dates and the IDs of situations that were unavailable at seed time. Flagged stale after 2 days; no request-time provider fetch. Situations overlap, so they are never summed into a global total; stock totals and monthly arrivals are different measures; this is not UNHCR annual statistics or IOM DTM. Takes no filters. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance. Attribution and source URLs ride with every projection.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: cacheEnvelope({
      crossBorderArrivals: {
        type: ['object', 'null'],
        properties: {
          source: { type: 'string' },
          situationCount: { type: 'integer', description: 'Full situation count in summary mode, before the three-situation sample.' },
          unavailable: { type: 'array', items: { type: 'string' }, description: 'Situation IDs that failed during publication. Partial failure, not zero displacement.' },
          situations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, name: { type: 'string' },
                origin: { type: ['string', 'null'] }, sourceUrl: { type: 'string' },
                asOf: { type: 'string', description: 'Upstream report date; distinct from cached_at.' },
                accelerating: { type: 'boolean' },
                flows: {
                  type: 'array', items: {
                    type: 'object', properties: {
                      kind: { type: 'string', enum: ['outflow', 'return', 'arrival', 'death'] },
                      label: { type: 'string' }, measure: { type: 'string', enum: ['stock', 'monthly'] },
                      origin: { type: ['string', 'null'] }, total: { type: 'number' }, asOf: { type: 'string' },
                      months: { type: 'array', items: { type: 'object', properties: { month: { type: 'string' }, individuals: { type: 'number' } } } },
                      countries: { type: 'array', items: { type: 'object', properties: {
                        country: { type: 'string' }, iso2: { type: ['string', 'null'] }, individuals: { type: 'number' }, date: { type: 'string' },
                        change: { type: 'object', properties: { since: { type: 'string' }, delta: { type: 'number' } } },
                      } } },
                    },
                  },
                },
                trend: { type: 'object', properties: {
                  measure: { type: 'string', enum: ['stock', 'monthly'] },
                  points: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, prefixItems: [{ type: 'string' }, { type: 'number' }], items: false } },
                  latestDelta: { type: ['number', 'null'] }, latestDays: { type: ['number', 'null'] }, accelerating: { type: 'boolean' },
                } },
              },
            },
          },
          attribution: { type: 'object', properties: {
            source: { type: 'string' }, sourceUrl: { type: 'string' }, license: { type: 'string' },
            licenseUrl: { type: 'string' }, termsUrl: { type: 'string' }, changes: { type: 'string' }, notice: { type: 'string' },
          } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _cacheKeys: ['displacement:cross-border:v1'],
    _cacheLabels: { 'displacement:cross-border:v1': 'crossBorderArrivals' },
    _freshnessChecks: [{ key: 'seed-meta:displacement:cross-border', maxStaleMin: 2880, minRecordCount: 12, honorContentAge: true }],
    _apiPaths: [],
    _attribution: 'data.crossBorderArrivals.{attribution: attribution, sources: situations[].{sourceUrl: sourceUrl, asOf: asOf}}',
    _summarize: (data) => {
      const value = data.crossBorderArrivals;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return data;
      const snapshot = value as Record<string, unknown>;
      if (!Array.isArray(snapshot.situations)) return data;
      return { ...data, crossBorderArrivals: {
        ...snapshot,
        situationCount: snapshot.situations.length,
        situations: snapshot.situations.slice(0, 3),
      } };
    },
    _project: (data) => {
      const snapshot = data.crossBorderArrivals;
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return data;
      return { ...data, crossBorderArrivals: { ...snapshot, attribution: {
        source: 'UNHCR Operational Data Portal',
        sourceUrl: 'https://data.unhcr.org/',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        termsUrl: 'https://data.unhcr.org/en/disclaimer/',
        changes: 'WorldMonitor normalizes portal aggregate reports and derives change figures; per-situation source URLs and dates are retained.',
        notice: 'ODP dataset license applies except where otherwise indicated. No UNHCR endorsement. Situations overlap; do not sum totals.',
      } } };
    },
  },
  {
    name: 'get_displacement_data',
    _validateArgs: params => {
      resolveCountryFilter(params.countries, 'countries');
      if (params.view !== undefined && !['annual', 'movements', 'events', 'regions'].includes(params.view as string)) {
        throw new RpcValidationError('get_displacement_data', [{ field: 'view', description: 'Expected "annual", "movements", "events" or "regions".' }]);
      }
    },
    title: 'Refugee and displacement counts',
    _outputBudgetBytes: 131072,
    description: 'Read UNHCR annual displacement stocks for summary.year: global totals, per-country refugees, asylum seekers, IDPs and stateless people by origin, hosted totals and top origin-to-asylum flows. Default view annual; the latest published year may be prior; stale after 60 hours. view=movements: dated UNHCR reports, UK arrivals, CBP encounters, Frontex detections and Panama Darién arrivals with per-source health; encounters are events, not people; route picks one route/situation ID. view=events: IDMC internal displacement, per-country 30-day totals (conflict/disaster), newlyReported7d, surge vs prior 150 days, located figures from 180 days; posted ~3 weeks late. view=regions: IOM DTM latest round per operation: IDPs by cause, first-level region and region-to-region flow. Sources and operations overlap; never sum. events/regions stale after 48 hours. countries matches origin or asylum. limit caps lists (default 30, 0 = all; events max 100). Read-only seeded cache; API weight 1, included in signed-in free allowance.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['annual', 'movements', 'events', 'regions'], description: 'Default annual. movements returns source-dated operational movement reports. events returns IDMC internal displacement in iduEvents. regions returns IOM DTM operations in dtmRegions.' },
        route: { type: 'string', maxLength: 120, description: 'Exact route or situation ID in the movements view.' },
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Country names, ISO alpha-2, or alpha-3 codes to keep (e.g. ["Syria","UA","AFG"]). Matches per-country totals, origin/asylum flows, IDMC rows and DTM operations. Omit for all. Unresolved names and alpha-3 codes return Invalid params; an unknown two-letter code matches nothing.',
        },
        limit: { type: 'number', description: 'Cap the per-country, top-flow, IDMC and DTM operation lists to at most this many items (default 30, pass 0 for no cap; IDMC events stay capped at 100).' },
      },
      required: [],
    },
    _attribution: 'data.crossBorderMovements.movements[].{source: source, sourceUrl: sourceUrl, license: license, licenseUrl: licenseUrl, notice: notice} || data.iduEvents.attribution || data.dtmRegions.attribution',
    outputSchema: cacheEnvelope({
      iduEvents: {
        type: ['object', 'null'],
        description: 'Present with view "events".',
        properties: {
          source: { type: 'string' },
          windowFrom: { type: 'string', description: 'First displacement date (YYYY-MM-DD) in events.' },
          missingCountries: { type: 'array', items: { type: 'string' }, description: 'ISO3 codes whose file failed at seed time. Partial failure, not zero displacement.' },
          countries: { type: 'array', items: { type: 'object', properties: {
            countryCode: { type: 'string' }, countryName: { type: 'string' },
            displaced30d: { type: 'number' }, conflict30d: { type: 'number' }, disaster30d: { type: 'number' }, events30d: { type: 'number' },
            newlyReported7d: { type: 'number', description: 'Figures published in the last 7 days, whatever the displacement date.' },
            latestDisplacementDate: { type: 'string' },
            baselineMonthly: { type: 'number', description: 'Monthly mean of the 150 days before the 30-day window.' },
            surge: { type: 'boolean', description: 'displaced30d is at least 5,000 and 3x baselineMonthly.' },
          } } },
          events: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, countryCode: { type: 'string' }, countryName: { type: 'string' },
            displacementType: { type: 'string', enum: ['Conflict', 'Disaster'] }, figure: { type: 'number' }, qualifier: { type: 'string' },
            displacementDate: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' },
            eventId: { type: 'string' }, eventName: { type: 'string' }, category: { type: 'string' }, hazardType: { type: 'string' },
            locationName: { type: 'string' }, locationAccuracy: { type: 'string' }, sources: { type: 'string' },
            createdAt: { type: 'string', description: 'Date IDMC published the figure.' },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
          attribution: { type: 'object', properties: {
            source: { type: 'string' }, sourceUrl: { type: 'string' }, hdxUrl: { type: 'string' }, license: { type: 'string' }, licenseUrl: { type: 'string' },
          } },
        },
      },
      dtmRegions: {
        type: ['object', 'null'],
        description: 'Present with view "regions".',
        properties: {
          source: { type: 'string' },
          lookbackFrom: { type: 'string', description: 'Oldest reporting date (YYYY-MM-DD) an operation may have.' },
          operations: { type: 'array', description: 'Latest survey round per IOM DTM operation, largest first. Operations in one country can overlap; do not add them.', items: { type: 'object', properties: {
            countryCode: { type: 'string' }, countryName: { type: 'string' }, operation: { type: 'string' },
            reportingDate: { type: 'string' }, roundNumber: { type: 'number' }, totalIdps: { type: 'number' },
            reasons: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, idps: { type: 'number' } } } },
            regions: { type: 'array', items: { type: 'object', properties: {
              pcode: { type: 'string', description: 'OCHA P-code; empty when DTM gave none.' }, name: { type: 'string' }, idps: { type: 'number' },
              location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            } } },
            flows: { type: 'array', description: 'Largest region-to-region routes, up to 30: IDPs in the destination who fled the origin.', items: { type: 'object', properties: {
              originPcode: { type: 'string' }, originName: { type: 'string' }, destinationPcode: { type: 'string' }, destinationName: { type: 'string' }, idps: { type: 'number' },
              originLocation: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
              destinationLocation: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            } } },
          } } },
          attribution: { type: 'object', properties: { source: { type: 'string' }, sourceUrl: { type: 'string' }, notice: { type: 'string' } } },
        },
      },
      crossBorderMovements: { type: 'object', properties: { movements: { type: 'array', items: { type: 'object', properties: { id: {type: 'string'}, route: {type: 'string'}, kind: {type: 'string'}, measure: {type: 'string'}, countryCode: {type: 'string'}, originCode: {type: 'string'}, asOf: {type: 'string'}, count: {type: 'number'}, last7Days: {type: 'number'}, last30Days: {type: 'number'}, changePct: {type: 'number'}, stockChange: {type: 'number'}, stockChangeSince: {type: 'string'}, surge: {type: 'boolean'}, stale: {type: 'boolean'}, source: {type: 'string'}, sourceUrl: {type: 'string'}, license: {type: 'string'}, licenseUrl: {type: 'string'}, notice: {type: 'string'} } } }, sources: {type: 'array', items: {type: 'object'}}, dataAvailable: {type: 'boolean'} } },
      summary: {
        type: ['object', 'null'],
        properties: {
          year: { type: 'number' },
          globalTotals: { type: 'object', properties: {
            refugees: { type: 'number' }, asylumSeekers: { type: 'number' }, idps: { type: 'number' },
            stateless: { type: 'number' }, total: { type: 'number' },
          } },
          countries: { type: 'array', items: { type: 'object', properties: {
            code: { type: 'string' }, name: { type: 'string' },
            refugees: { type: 'number' }, asylumSeekers: { type: 'number' }, idps: { type: 'number' },
            stateless: { type: 'number' }, totalDisplaced: { type: 'number' },
            hostRefugees: { type: 'number' }, hostAsylumSeekers: { type: 'number' }, hostTotal: { type: 'number' },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
          topFlows: { type: 'array', items: { type: 'object', properties: {
            originCode: { type: 'string' }, originName: { type: 'string' },
            asylumCode: { type: 'string' }, asylumName: { type: 'string' }, refugees: { type: 'number' },
            originLocation: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            asylumLocation: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      if (params.view === 'movements') {
        const result = projectCrossBorderSnapshots(Object.fromEntries(CROSS_BORDER_SOURCES.map(source => [source.id, data[source.id]])));
        const countries = resolveCountryFilter(params.countries, 'countries').map(code => code.toUpperCase());
        const route = typeof params.route === 'string' ? params.route.trim() : '';
        result.movements = result.movements.filter(m => (!countries.length || countries.includes(m.countryCode) || countries.includes(m.originCode)) && (!route || m.route === route));
        const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
        if (limit > 0) result.movements = result.movements.slice(0, limit);
        return { crossBorderMovements: result };
      }
      hoistDisplacementSeed(data);
      const countries = resolveCountryFilter(params.countries, 'countries');
      const codes = [...countries, ...compact(countries.map((code) => ISO2_TO_ISO3[code.toUpperCase()]?.toLowerCase()))];
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (codes.length > 0) {
        narrowNested(data, 'summary', 'countries', (c) => matchesCode(c.code, codes));
        narrowNested(data, 'summary', 'topFlows', (f) => matchesCode(f.originCode, codes) || matchesCode(f.asylumCode, codes));
        narrowNested(data, 'iduEvents', 'countries', (c) => matchesCode(c.countryCode, codes));
        narrowNested(data, 'iduEvents', 'events', (e) => matchesCode(e.countryCode, codes));
        narrowNested(data, 'dtmRegions', 'operations', (op) => matchesCode(op.countryCode, codes));
      }
      capNested(data, 'summary', 'countries', limit);
      capNested(data, 'summary', 'topFlows', limit);
      capNested(data, 'iduEvents', 'countries', limit);
      capNested(data, 'iduEvents', 'events', limit > 0 ? Math.min(limit, IDU_EVENTS_MAX) : IDU_EVENTS_MAX);
      capNested(data, 'dtmRegions', 'operations', limit);
      return data;
    },
    _project: (data) => {
      const isSnapshot = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
      const { iduEvents, dtmRegions } = data;
      let projected = data;
      if (isSnapshot(iduEvents)) {
        projected = { ...projected, iduEvents: { ...iduEvents, attribution: {
          source: 'Internal Displacement Monitoring Centre (IDMC), Internal Displacement Updates',
          sourceUrl: 'https://www.internal-displacement.org/',
          hdxUrl: 'https://data.humdata.org/organization/international-displacement-monitoring-centre-idmc',
          license: 'CC BY-IGO',
          licenseUrl: 'https://creativecommons.org/licenses/by/3.0/igo/',
        } } };
      }
      if (isSnapshot(dtmRegions)) {
        projected = { ...projected, dtmRegions: { ...dtmRegions, attribution: {
          source: 'International Organization for Migration (IOM), Displacement Tracking Matrix (DTM)',
          sourceUrl: 'https://dtm.iom.int/',
          notice: 'Latest survey round per operation. Operations in one country can overlap; do not add their totals.',
        } } };
      }
      return projected;
    },
    // Dynamic-year key resolved once at module evaluation — mirrors the
    // STANDALONE_KEYS pattern in api/health.js:147. The UNHCR seeder publishes
    // a single current-year key; the prior year exists at the same prefix but
    // is intentionally excluded — the executeTool label-walk would strip the
    // year segment from both keys and collide on the same `summary` label,
    // causing the second result to overwrite the first.
    _cacheKeys: [`displacement:summary:v1:${new Date().getUTCFullYear()}`, 'displacement:idmc-idu:v1', 'displacement:dtm:v1', ...CROSS_BORDER_SOURCES.map(source => source.key)],
    _cacheLabels: { 'displacement:idmc-idu:v1': 'iduEvents', 'displacement:dtm:v1': 'dtmRegions', ...Object.fromEntries(CROSS_BORDER_SOURCES.map(source => [source.key, source.id])) },
    // The events and regions budgets match SEED_META.idmcIduDisplacement and
    // SEED_META.dtmDisplacement in api/health.js; the DTM seed-meta also
    // carries the 90-day round-age budget.
    _freshnessChecks: [{ key: 'seed-meta:displacement:summary', maxStaleMin: 3600 }, { key: 'seed-meta:displacement:idmc-idu', maxStaleMin: 2880, minRecordCount: 500 }, { key: 'seed-meta:displacement:dtm', maxStaleMin: 2880, minRecordCount: 15, honorContentAge: true }, ...CROSS_BORDER_SOURCES.map(source => ({ key: `seed-meta:${source.key.replace(/:v1$/, '')}`, maxStaleMin: 2880, honorContentAge: true, ...(source.id === 'odp' ? {} : { contentFreshnessActivationKey: `seed-activated:displacement:border-${source.id}` }) }))],
    // Audit miss: handler uses cachedFetchJson with a year-suffixed key the
    // audit's regex couldn't statically resolve. The op IS covered by this
    // tool — same underlying displacement:summary:v1:<year> cache.
    _apiPaths: [
      'GET /api/displacement/v1/get-displacement-summary',
      'GET /api/displacement/v1/get-cross-border-movements',
      'GET /api/displacement/v1/get-internal-displacement',
    ],
  },
  {
    name: 'get_health_signals',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Disease outbreaks and air quality',
    _outputBudgetBytes: 131072,
    description: 'Active disease outbreaks (WHO/ECDC etc.) and global air-quality station readings (OpenAQ/WAQI PM2.5). For health-risk screening.',
    inputSchema: {
      type: 'object',
      properties: {
        signal_type: {
          type: 'array',
          items: { type: 'string', enum: ['outbreaks', 'air-quality'] },
          description: 'Restrict to disease outbreaks, air-quality stations, or both. Omit for both.',
        },
        country: { type: 'string', description: 'Filter outbreaks and air-quality stations to one ISO 3166-1 alpha-2 country code. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.' },
        disease: { type: 'string', description: 'Keep only outbreaks whose disease name contains this text (case-insensitive).' },
        min_aqi: { type: 'number', description: 'Drop air-quality stations below this AQI value.' },
        limit: { type: 'number', description: 'Cap the outbreak and station lists to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'disease-outbreaks': {
        type: ['object', 'null'],
        properties: {
          outbreaks: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string', description: 'Source-derived report identifier; multiple sources may report one event.' },
            disease: { type: 'string' }, location: { type: 'string' }, countryCode: { type: 'string' },
            alertLevel: { type: 'string', description: 'Editorial watch, warning or alert classification, not a case-count measurement.' },
            summary: { type: 'string' }, sourceName: { type: 'string' }, sourceUrl: { type: 'string' },
            publishedAt: { type: 'number', description: 'Source report publication time in Unix epoch milliseconds, or fetch time when the source date is missing or invalid; this field alone does not confirm publication time.' },
            lat: { type: 'number' }, lng: { type: 'number', description: 'Latitude/longitude are source locations or inferred points; both zero means unknown.' },
            cases: { type: ['number', 'null'], description: 'Reported case count; zero, null or absence means unknown, not no cases.' },
            country: { type: 'string', description: 'Optional legacy country field; current reports use location and countryCode.' },
            deaths: { type: ['number', 'null'], description: 'Optional legacy count; absence is not zero.' },
            date: { type: 'string', description: 'Optional legacy date; current reports use publishedAt.' },
          } } },
          fetchedAt: { type: 'number', description: 'Snapshot fetch time in Unix epoch milliseconds; absent clocks remain unknown.' },
          alertLevelMethodologyVersion: { type: 'string', description: 'Version of the editorial alert-level classifier.' },
        },
      },
      'air-quality': {
        type: ['object', 'null'],
        properties: {
          stations: { type: 'array', items: { type: 'object', properties: {
            country_code: { type: 'string' }, city: { type: 'string' }, aqi: { type: ['number', 'null'] },
            pm25: { type: ['number', 'null'] }, latitude: { type: 'number' }, longitude: { type: 'number' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = resolveCountryFilter(params.country, 'country');
      const disease = argStr(params.disease);
      const minAqi = argNum(params.min_aqi);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'disease-outbreaks', 'outbreaks', (o) => matchesCode(o.countryCode, countries));
        narrowNested(data, 'air-quality', 'stations', (s) => matchesCode(s.country_code, countries));
      }
      if (disease) narrowNested(data, 'disease-outbreaks', 'outbreaks', (o) => ciIncludes(o.disease, disease));
      if (minAqi != null) narrowNested(data, 'air-quality', 'stations', (s) => (argNum(s.aqi) ?? 0) >= minAqi);
      capNested(data, 'disease-outbreaks', 'outbreaks', limit);
      capNested(data, 'air-quality', 'stations', limit);
      const st = argStrList(params.signal_type);
      if (st.length > 0) {
        const map: Record<string, string> = { outbreaks: 'disease-outbreaks', 'air-quality': 'air-quality' };
        return selectDatasets(data, compact(st.map((s) => map[s])));
      }
      return data;
    },
    // Uses the health-domain canonical key health:air-quality:v1 (NOT the
    // climate-domain mirror climate:air-quality:v1, which stays exclusively
    // in get_climate_data). Both are written by the same seeder
    // (scripts/seed-health-air-quality.mjs exports HEALTH_AIR_QUALITY_KEY +
    // CLIMATE_AIR_QUALITY_KEY) so no duplicate seed work.
    _cacheKeys: ['health:disease-outbreaks:v1', 'health:air-quality:v1'],
    _freshnessChecks: [
      { key: 'seed-meta:health:disease-outbreaks', maxStaleMin: 2880 }, // daily cron; 48h budget
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },        // hourly cron; 3h budget
    ],
    _apiPaths: [
      "GET /api/health/v1/list-air-quality-alerts",
      "GET /api/health/v1/list-disease-outbreaks",
    ],
  },
  {
    name: 'get_energy_intelligence',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Energy supply, prices and disruptions',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded energy bundle: EIA petroleum stocks, Ember electricity prices and generation mix, GIE national gas storage (fill percentage, stored TWh, observation date per country), fuel shortages, active energy disruptions, government crisis policies, fossil-electricity share, World Bank renewable share, and dated histories of EU gas storage (TWh), US gas storage (bcf) and US commercial crude stocks (million barrels). Each sub-dataset carries its own seed time and staleness budget (gas storage and electricity are flagged stale after 2 days, crisis policies only after many months). _countries is a coverage index only, and null observations mean unavailable, not zero. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. dataset selects sub-datasets, country narrows the country-keyed ones, limit caps each list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['eia-petroleum', 'electricity', 'ember', 'gas-storage', 'fuel-shortages', 'disruptions', 'crisis-policies', 'fossil-share', 'renewable', 'eu-gas-storage', 'nat-gas-storage', 'crude-inventories'],
          },
          description: 'Restrict the response to one or more energy sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-keyed datasets (Ember electricity mix, gas storage, fuel shortages, energy disruptions, fossil-share) to one ISO 3166-1 alpha-2 code. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap each list-bearing energy slice (crisis-policies, electricity regions, gas-storage countries, World Bank renewable history/regions, newest-first storage and inventory histories) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // Labels derived from each cache key's last informative segment:
    //   energy:eia-petroleum:v1                  -> eia-petroleum
    //   energy:electricity:v1:index              -> index
    //   energy:ember:v1:_all                     -> _all
    //   energy:gas-storage:v1:_countries         -> _countries
    //   energy:fuel-shortages:v1                 -> fuel-shortages
    //   energy:disruptions:v1                    -> disruptions
    //   energy:crisis-policies:v1                -> crisis-policies
    //   resilience:fossil-electricity-share:v1   -> fossil-electricity-share
    //   economic:worldbank-renewable:v1          -> worldbank-renewable
    outputSchema: cacheEnvelope({
      'eia-petroleum': { type: ['object', 'null'], additionalProperties: {
        type: 'object', properties: {
          current: { type: 'number' }, previous: { type: ['number', 'null'] }, date: { type: 'string' },
          unit: { type: 'string', description: 'Source unit. Stocks and production use thousand barrels and thousand barrels per day; prices use USD per barrel.' },
        },
      } },
      index: { type: ['object', 'null'], properties: { regions: { type: 'array', items: { type: 'object' } } } },
      _all: { type: ['object', 'null'] },
      _countries: { type: ['array', 'object', 'null'] },
      'gas-storage': { type: ['object', 'null'], additionalProperties: {
        type: 'object', properties: {
          iso2: { type: 'string' }, countryName: { type: 'string' },
          fillPct: { type: 'number', description: 'National natural-gas storage fill percentage.' },
          fillPctChange1d: { type: 'number', description: 'Change in percentage points.' },
          gasTwh: { type: 'number', description: 'Stored natural gas in terawatt-hours.' },
          trend: { type: 'string' }, date: { type: 'string', description: 'Observation date.' },
          seededAt: { type: 'string' },
        },
      } },
      'fuel-shortages': { type: ['object', 'null'], properties: { shortages: { type: ['object', 'array', 'null'] } } },
      disruptions: { type: ['object', 'null'], properties: { events: { type: ['object', 'array', 'null'] } } },
      'crisis-policies': { type: ['object', 'null'], properties: { policies: { type: 'array', items: { type: 'object' } } } },
      'fossil-electricity-share': { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      'worldbank-renewable': { type: ['object', 'null'], properties: {
        historicalData: { type: 'array', items: { type: 'object' } },
        regions: { type: 'array', items: { type: 'object' } },
      } },
      'eu-gas-storage': {
        type: ['object', 'null'],
        properties: {
          fillPct: { type: 'number', description: 'EU storage fill percentage.' },
          fillPctChange1d: { type: ['number', 'null'], description: 'Daily change in percentage points.' },
          gasDaysConsumption: { type: ['number', 'null'], description: 'Approximate days of consumption, a source heuristic.' },
          trend: { type: 'string' },
          updatedAt: { type: 'string', description: 'Observation date, distinct from the cache fetch timestamp.' },
          seededAt: { type: ['string', 'number'] },
          unavailable: { type: 'boolean' },
          history: {
            type: 'array',
            items: { type: 'object', properties: {
              date: { type: 'string' }, fillPct: { type: 'number' },
              gasTwh: { type: 'number', description: 'Stored gas in terawatt-hours.' },
            } },
          },
        },
      },
      'nat-gas-storage': {
        type: ['object', 'null'],
        properties: {
          latestPeriod: { type: 'string' },
          weeks: { type: 'array', items: { type: 'object', properties: {
            period: { type: 'string' },
            storBcf: { type: 'number', description: 'US working gas in billion cubic feet.' },
            weeklyChangeBcf: { type: ['number', 'null'], description: 'Weekly change in billion cubic feet; null if the prior observation is unavailable.' },
          } } },
        },
      },
      'crude-inventories': {
        type: ['object', 'null'],
        properties: {
          latestPeriod: { type: 'string' },
          weeks: { type: 'array', items: { type: 'object', properties: {
            period: { type: 'string' },
            stocksMb: { type: 'number', description: 'US commercial crude inventories in million barrels.' },
            weeklyChangeMb: { type: ['number', 'null'], description: 'Weekly change in million barrels; null if the prior observation is unavailable.' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = resolveCountryFilter(params.country, 'country');
      if (countries.length > 0) {
        data._all = pickMapKeys(data._all, countries);
        data['gas-storage'] = pickMapKeys(data['gas-storage'], countries);
        pickNestedMap(data, 'fossil-electricity-share', 'countries', countries);
        // energy:gas-storage:v1:_countries is a string[] of ISO2 codes — match
        // the entry directly; the `?.iso2` fallback tolerates an object shape.
        narrowArray(data, '_countries', (c) => matchesCode(c, countries) || matchesCode(c?.iso2, countries));
        mapNested(data, 'fuel-shortages', 'shortages', (m) => filterMapValues(m, (s) => matchesCode(s.country, countries)));
        mapNested(data, 'disruptions', 'events', (m) => filterMapValues(m, (e) => matchesCode(e.countries, countries)));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'crisis-policies', 'policies', limit);
      capNested(data, 'index', 'regions', limit);
      capNested(data, 'worldbank-renewable', 'historicalData', limit);
      capNested(data, 'worldbank-renewable', 'regions', limit);
      capNested(data, 'eu-gas-storage', 'history', limit);
      capNested(data, 'nat-gas-storage', 'weeks', limit);
      capNested(data, 'crude-inventories', 'weeks', limit);
      // _countries is a top-level string[] — capArrays handles top-level arrays;
      // in the energy bundle it's the only such array, so no collateral damage.
      capArrays(data, limit);
      if (limit > 0 && data['gas-storage'] && typeof data['gas-storage'] === 'object') {
        data['gas-storage'] = Object.fromEntries(Object.entries(data['gas-storage']).slice(0, limit));
      }
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = {
          'eia-petroleum': 'eia-petroleum', electricity: 'index', ember: '_all', 'gas-storage': '_countries',
          'fuel-shortages': 'fuel-shortages', disruptions: 'disruptions', 'crisis-policies': 'crisis-policies',
          'fossil-share': 'fossil-electricity-share', renewable: 'worldbank-renewable',
          'eu-gas-storage': 'eu-gas-storage', 'nat-gas-storage': 'nat-gas-storage', 'crude-inventories': 'crude-inventories',
        };
        const selected = compact(ds.map((d) => map[d]));
        if (ds.includes('gas-storage')) selected.push('gas-storage');
        return selectDatasets(data, selected);
      }
      return data;
    },
    // Broad 13-key energy bundle mirroring get_economic_data. Cadences span
    // hourly (electricity prices) to annual (World Bank renewable share); use
    // _freshnessChecks with per-key maxStaleMin pulled from
    // api/health.js::SEED_META so a slow-cadence key doesn't drag the
    // aggregate stale flag unnecessarily.
    _cacheKeys: [
      'energy:eia-petroleum:v1',                  // STANDALONE_KEYS::eiaPetroleum
      'energy:electricity:v1:index',              // BOOTSTRAP_KEYS::electricityPrices
      'energy:ember:v1:_all',                     // STANDALONE_KEYS::emberElectricity
      'energy:gas-storage:v1:_countries',         // BOOTSTRAP_KEYS::gasStorageCountries
      'energy:gas-storage:v1:all',
      'energy:fuel-shortages:v1',                 // STANDALONE_KEYS::fuelShortages
      'energy:disruptions:v1',                    // STANDALONE_KEYS::energyDisruptions
      'energy:crisis-policies:v1',                // STANDALONE_KEYS::energyCrisisPolicies
      'resilience:fossil-electricity-share:v1',   // STANDALONE_KEYS::fossilElectricityShare
      'economic:worldbank-renewable:v1',          // BOOTSTRAP_KEYS::renewableEnergy
      'economic:eu-gas-storage:v1',
      'economic:nat-gas-storage:v1',
      'economic:crude-inventories:v1',
    ],
    _cacheLabels: { 'energy:gas-storage:v1:all': 'gas-storage' },
    _freshnessChecks: [
      { key: 'seed-meta:energy:eia-petroleum',                  maxStaleMin: 4320 },   // daily bundle; 72h = 3× interval
      { key: 'seed-meta:energy:electricity-prices',             maxStaleMin: 3000 },   // one snapshot per UTC day, tried at 14/17/20/23 UTC; two days + 2h margin
      { key: 'seed-meta:energy:ember',                          maxStaleMin: 2880 },   // daily cron (08:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:gas-storage-countries',          maxStaleMin: 2880 },   // daily cron at 10:30 UTC; 48h = 2× interval
      { key: 'seed-meta:energy:fuel-shortages',                 maxStaleMin: 2880 },   // 2d — daily cron × 2 headroom
      { key: 'seed-meta:energy:disruptions',                    maxStaleMin: 20160 },  // 14d — weekly cron × 2 headroom
      { key: 'seed-meta:energy:crisis-policies',                maxStaleMin: 60 * 24 * 400 }, // ~400d static registry
      { key: 'seed-meta:resilience:fossil-electricity-share',   maxStaleMin: 11520 },  // ~8d (annual WB-style cadence)
      { key: 'seed-meta:economic:worldbank-renewable:v1',       maxStaleMin: 10080 },  // 7d WB weekly-cron annual data
      { key: 'seed-meta:economic:eu-gas-storage',               maxStaleMin: 2880 },
      { key: 'seed-meta:economic:nat-gas-storage',              maxStaleMin: 20160 },
      { key: 'seed-meta:economic:crude-inventories',            maxStaleMin: 20160 },
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-energy-crisis-policies",
      "GET /api/supply-chain/v1/get-fuel-shortage-detail",
      "GET /api/supply-chain/v1/list-energy-disruptions",
      "GET /api/supply-chain/v1/list-fuel-shortages",
      'GET /api/economic/v1/get-eu-gas-storage',
      'GET /api/economic/v1/get-nat-gas-storage',
      'GET /api/economic/v1/get-crude-inventories',
    ],
  },
  {
    name: 'get_oil_trade_series',
    title: 'Oil production and export series by country',
    _outputBudgetBytes: 131072,
    description: 'Monthly oil supply and export series for 24 major exporters over 24 complete months, comparing the last N complete months with the N before and a year earlier (default N=6), e.g. UAE oil exports, last 6 months vs the 6 before. Four sources, never blended: production (EIA STEO liquids supply, revisable estimates); jodi (the country\'s own JODI crude and product exports; the UAE has filed none since 2019); mirror (Comtrade imports declared by buyers, a lagging sample compared only on buyers in basis.reporters); ais (PortWatch tanker loadings, an index that undercounts, not an export total). Uncovered months are null, never zero; each source has status and lastObserved. Weekly seed, stale after 14 days. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance. country adds monthly rows; window_months sets N (1-12).',
    inputSchema: {
      type: 'object',
      properties: {
        country: {
          type: 'array',
          items: { type: 'string' },
          description: 'Countries as ISO alpha-2, alpha-3 or English names (e.g. ["AE"], ["Saudi Arabia"]). Selected countries include their monthly rows. Omit for every covered country, comparison only. Unresolved inputs return Invalid params; a resolvable country outside the 24 covered returns no row.',
        },
        window_months: {
          type: 'integer', minimum: 1, maximum: 12,
          description: 'Months per comparison window, ending at the last complete month (default 6: the last 6 complete months vs the 6 before, plus the same 6 months a year earlier).',
        },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      oilTradeSeries: {
        type: ['object', 'null'],
        properties: {
          generatedAt: { type: 'string', description: 'Seed time.' },
          throughMonth: { type: 'string', description: 'Last complete month at seed time.' },
          windowMonths: { type: 'integer' },
          conversion: { type: 'object', properties: { crudeBblPerTonne: { type: 'number' }, productsBblPerTonne: { type: 'number' } } },
          unavailable: { type: 'object', description: 'Countries whose mirror or ais fetch failed at seed time. Unavailable, not zero.', properties: {
            mirror: { type: 'array', items: { type: 'string' } }, ais: { type: 'array', items: { type: 'string' } },
          } },
          countries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                iso2: { type: 'string' }, iso3: { type: 'string' }, name: { type: 'string' },
                sources: { type: 'object', description: 'Per source: name, url, measure, status (ok, stale, not_reported, unavailable), lastObserved month. carriedForward marks an unavailable source still showing its previous publish\'s months.' },
                comparison: {
                  type: 'object',
                  properties: {
                    windowMonths: { type: 'integer' },
                    windows: { type: 'object', description: 'current, prior and yearAgo as {from, to} months.' },
                    metrics: {
                      type: 'object',
                      description: 'production, jodiCrudeExports, jodiProductExports, mirrorCrudeImports, mirrorProductImports, aisTankerLoadings. Each: current/prior/yearAgo {kbd, monthsCovered} day-weighted over covered months (kbd null when none), changePct vs prior, yoyPct (currentForYoy vs yearAgo; for mirror metrics on basis.yoyReporters), complete (both windows fully covered), and for mirror metrics basis.reporters.',
                    },
                  },
                },
                months: {
                  type: 'array',
                  description: 'Present only for selected countries. One row per month; a source block is null for a month it does not cover.',
                  items: { type: 'object', properties: {
                    month: { type: 'string' },
                    production: { type: ['object', 'null'], properties: { kbd: { type: 'number' }, provisional: { type: 'boolean' } } },
                    jodi: { type: ['object', 'null'], properties: { crudeExportsKbd: { type: ['number', 'null'] }, productExportsKbd: { type: ['number', 'null'] }, crudeProductionKbd: { type: ['number', 'null'] } } },
                    mirror: { type: ['object', 'null'], properties: { crudeKbd: { type: ['number', 'null'] }, productsKbd: { type: ['number', 'null'] }, reporters: { type: 'object' }, otherKbd: { type: ['object', 'null'] } } },
                    ais: { type: ['object', 'null'], properties: { complete: { type: 'boolean' }, loadingsKbd: { type: ['number', 'null'] }, exportTankerKt: { type: ['number', 'null'] }, tankerCalls: { type: ['number', 'null'] } } },
                  } },
                },
              },
            },
          },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _cacheKeys: ['energy:oil-trade-series:v1'],
    _cacheLabels: { 'energy:oil-trade-series:v1': 'oilTradeSeries' },
    _freshnessChecks: [{ key: 'seed-meta:energy:oil-trade-series', maxStaleMin: 20160, minRecordCount: 18, honorContentAge: true }],
    _apiPaths: [],
    _postFilter: (data, params) => {
      const payload = data.oilTradeSeries;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return data;
      const stored = (payload as { countries?: unknown }).countries;
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return data;
      const selected = resolveCountryFilter(params.country, 'country').map((code) => code.toUpperCase());
      const rawWindow = argNum(params.window_months);
      const windowMonths = rawWindow !== null && Number.isInteger(rawWindow) && rawWindow >= 1 && rawWindow <= 12 ? rawWindow : 6;
      const nowMs = Date.now();
      const countries = Object.values(stored as Record<string, Record<string, unknown>>)
        .filter((c) => selected.length === 0 || selected.includes(String(c?.iso2)))
        .map((c) => {
          const expanded = expandCountry(c);
          const { months, from: _from, to: _to, ...rest } = expanded;
          const comparison = compareOilWindows(expanded, { nowMs, windowMonths });
          return selected.length > 0 ? { ...rest, comparison, months } : { ...rest, comparison };
        });
      return { ...data, oilTradeSeries: { ...payload, windowMonths, countries } };
    },
  },
  {
    name: 'get_climate_data',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Climate anomalies and disasters',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded climate bundle: temperature and precipitation anomalies against 30-year WMO normals, climate-relevant disaster alerts (ReliefWeb, GDACS, FIRMS), the NOAA Mauna Loa CO2 trend, OpenAQ/WAQI PM2.5 station readings, NSIDC/NOAA Arctic sea-ice extent and ocean-heat indicators, active weather alerts and climate news. Each sub-dataset carries its own seed time and staleness budget (anomalies are flagged stale after 2 h, CO2 and sea ice after 2 days). Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. dataset selects sub-datasets, country narrows the disaster and air-quality lists, limit caps each list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['anomalies', 'disasters', 'co2-monitoring', 'air-quality', 'ocean-ice', 'news-intelligence', 'alerts'],
          },
          description: 'Restrict the response to one or more climate sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-tagged datasets (climate disasters, air-quality stations) to one ISO 3166-1 alpha-2 code. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (anomalies, disasters, stations, news, alerts) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      anomalies: { type: ['object', 'null'], properties: { anomalies: { type: 'array', items: { type: 'object' } } } },
      disasters: { type: ['object', 'null'], properties: { disasters: { type: 'array', items: { type: 'object', properties: {
        countryCode: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' },
      } } } } },
      'co2-monitoring': { type: ['object', 'null'] },
      'air-quality': { type: ['object', 'null'], properties: { stations: { type: 'array', items: { type: 'object', properties: {
        country_code: { type: 'string' }, city: { type: 'string' }, aqi: { type: ['number', 'null'] },
      } } } } },
      'ocean-ice': { type: ['object', 'null'] },
      'news-intelligence': { type: ['object', 'null'], properties: { items: { type: 'array', items: { type: 'object' } } } },
      alerts: { type: ['object', 'null'], properties: { alerts: { type: 'array', items: { type: 'object' } } } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = resolveCountryFilter(params.country, 'country');
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'disasters', 'disasters', (d) => matchesCode(d.countryCode, countries));
        narrowNested(data, 'air-quality', 'stations', (s) => matchesCode(s.country_code, countries));
      }
      capNested(data, 'anomalies', 'anomalies', limit);
      capNested(data, 'disasters', 'disasters', limit);
      capNested(data, 'air-quality', 'stations', limit);
      capNested(data, 'news-intelligence', 'items', limit);
      capNested(data, 'alerts', 'alerts', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: ['climate:anomalies:v2', 'climate:disasters:v1', 'climate:co2-monitoring:v1', 'climate:air-quality:v1', 'climate:ocean-ice:v1', 'climate:news-intelligence:v1', 'weather:alerts:v1'],
    _freshnessChecks: [
      { key: 'seed-meta:climate:anomalies', maxStaleMin: 120 },
      { key: 'seed-meta:climate:disasters', maxStaleMin: 720 },
      { key: 'seed-meta:climate:co2-monitoring', maxStaleMin: 2880 },
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },
      { key: 'seed-meta:climate:ocean-ice', maxStaleMin: 2880 },
      { key: 'seed-meta:climate:news-intelligence', maxStaleMin: 90 },
      { key: 'seed-meta:weather:alerts', maxStaleMin: 45 },
    ],
    _apiPaths: [
      "GET /api/climate/v1/get-co2-monitoring",
      "GET /api/climate/v1/get-ocean-ice-data",
      "GET /api/climate/v1/list-air-quality-data",
      "GET /api/climate/v1/list-climate-anomalies",
      "GET /api/climate/v1/list-climate-disasters",
      "GET /api/climate/v1/list-climate-news",
    ],
  },
  {
    name: 'get_imd_cyclone_marine',
    title: 'India cyclone and marine bulletins',
    _outputBudgetBytes: 65536,
    // IMD bulletins are reusable with attribution to the issuing office. The
    // snapshot carries it inline; the rider keeps it attached when a caller
    // projects only `seaBulletins` or `coastalBulletins`.
    _attribution: 'data.imd_cyclone_marine.{attribution: attribution, sourceName: sourceName, sourceUrl: sourceUrl}',
    description:
      'Return India Meteorological Department sea-area and coastal marine bulletins from the public mausam.imd.gov.in pages: storm warnings, port signals, storm-surge and tidal warnings, wind, visibility and sea state per area with each bulletin\'s validity window. Flagged stale after 45 minutes; not merged into the global weather alerts. IMD cyclone track, wind-radii and cone products are API-only and disabled (GDACS covers North Indian Ocean cyclones in the natural-events data); port and fishermen warning PDFs are not parsed. coverageState reports bulletin coverage: ok is live, degraded means some pages failed and their last-good records were carried, unavailable means no page was readable; per-page status is under products.<id>.pages, and empty lists under degraded or unavailable coverage are not an all-clear. An oversized response trims lists from the end and reports each trimmed list in transportCoverage. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['cyclone', 'port', 'marine'] },
          description: 'Restrict to cyclone tracks/wind/cones, port warnings, or sea-area/coastal bulletins. Omit for the full snapshot. coverageState and per-product health are always returned.',
        },
        limit: { type: 'number', description: 'Cap each product list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: (() => {
      const schema = cacheEnvelope({
      imd_cyclone_marine: {
        type: ['object', 'null'],
        properties: {
          coverageState: { type: 'string', enum: ['ok', 'disabled', 'degraded', 'unavailable'] },
          skipReason: { type: ['string', 'null'] },
          generatedAt: { type: 'number' },
          products: { type: 'object', additionalProperties: { type: 'object', properties: {
            status: { type: 'string' },
            reason: { type: ['string', 'null'] },
            recordCount: { type: 'number' },
            warningCount: { type: 'number' },
            carried: { type: 'boolean' },
          } } },
          failedProducts: { type: 'array', items: { type: 'string' } },
          cycloneEvents: { type: 'array', items: { type: 'object' } },
          portAlerts: { type: 'array', items: { type: 'object' } },
          marineBulletins: { type: 'array', items: { type: 'object' } },
          cyclones: { type: 'array', items: { type: 'object' } },
          windRadii: { type: 'array', items: { type: 'object' } },
          cones: { type: 'array', items: { type: 'object' } },
          portWarnings: { type: 'array', items: { type: 'object' } },
          seaBulletins: { type: 'array', items: { type: 'object' } },
          coastalBulletins: { type: 'array', items: { type: 'object' } },
          sourceName: { type: 'string' },
          sourceUrl: { type: 'string' },
          attribution: { type: 'string' },
        },
        required: ['coverageState'],
      },
      }) as { properties: Record<string, unknown> };
      return { ...schema, properties: { ...schema.properties, transportCoverage: {
        type: 'object', required: ['count_scope', 'collections'], properties: {
          count_scope: { const: 'post_filter_snapshot' },
          collections: { type: 'object', additionalProperties: { type: 'object', required: [
            'original_count', 'returned_count', 'omitted_count', 'omission_reason',
          ], properties: {
            original_count: { type: 'integer', minimum: 0 }, returned_count: { type: 'integer', minimum: 0 },
            omitted_count: { type: 'integer', minimum: 0 }, omission_reason: { const: 'output_budget' },
          } } },
        },
      } } };
    })(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _fitToBudget: fitImdToBudget,
    _postFilter: (data, params) => {
      let snapshot = data.imd_cyclone_marine;
      // A legacy or corrupt cache value must not look like an India all-clear.
      // The wire contract requires coverageState on every usable object, so
      // replace an unexpected value with the explicit unavailable state.
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        snapshot = { coverageState: 'unavailable', skipReason: 'IMD_CACHE_INVALID' };
        data.imd_cyclone_marine = snapshot;
      }
      const rec = snapshot as Record<string, unknown>;
      if (!['ok', 'disabled', 'degraded', 'unavailable'].includes(argStr(rec.coverageState))) {
        rec.coverageState = 'unavailable';
        rec.skipReason = 'IMD_CACHE_INVALID';
      }
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      const listKeys = [
        'cyclones', 'windRadii', 'cones', 'portWarnings', 'seaBulletins',
        'coastalBulletins', 'cycloneEvents', 'portAlerts', 'marineBulletins', 'records',
      ] as const;
      for (const key of listKeys) capNested(data, 'imd_cyclone_marine', key, limit);

      const datasets = argStrList(params.dataset);
      if (datasets.length > 0) {
        const keep = new Set<string>();
        if (datasets.includes('cyclone')) {
          keep.add('cyclones');
          keep.add('windRadii');
          keep.add('cones');
          keep.add('cycloneEvents');
        }
        if (datasets.includes('port')) {
          keep.add('portWarnings');
          keep.add('portAlerts');
        }
        if (datasets.includes('marine')) {
          keep.add('seaBulletins');
          keep.add('coastalBulletins');
          keep.add('marineBulletins');
        }
        for (const key of listKeys) {
          if (!keep.has(key) && Array.isArray(rec[key])) rec[key] = [];
        }
      }
      return data;
    },
    _cacheKeys: ['weather:imd-cyclone-marine:v1'],
    _cacheLabels: { 'weather:imd-cyclone-marine:v1': 'imd_cyclone_marine' },
    _freshnessChecks: [{ key: 'seed-meta:weather:imd-cyclone-marine', maxStaleMin: 45 }],
    _apiPaths: [],
  },
  {
    name: 'get_infrastructure_status',
    title: 'Internet outages, traffic anomalies, DDoS and cloud status',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded Cloudflare Radar Internet snapshot: outages (national and regional, with start time, severity and cause, plus cloud and Internet service status), traffic anomalies (epoch ms, end 0 means ongoing, totalCount is global before filtering) and the global DDoS protocol, vector and target-country summary. Outages are stale after 30 minutes, traffic and DDoS after 60. Empty lists mean no recorded rows. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. dataset selects datasets (default all); country (ISO code or English name) filters outages and traffic, never DDoS; severity filters outages; limit caps each list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['outages', 'traffic', 'ddos'] },
          description: 'Restrict the response to outages, traffic anomalies or the DDoS summary. Omit for all three.',
        },
        country: { type: 'string', description: `Filter outages and traffic anomalies to one country. ${COUNTRY_ARG_HINT} Unresolved inputs return Invalid params. DDoS summaries are global, so a DDoS-only call with country returns Invalid params.` },
        severity: { type: 'string', description: 'Filter to one outage severity (case-insensitive substring).' },
        limit: { type: 'integer', minimum: 0, description: 'Cap each list (outages, anomalies, DDoS protocols, vectors and target countries) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      outages: {
        type: ['object', 'null'],
        properties: { outages: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, severity: { type: 'string' }, asn: { type: ['number', 'string'] },
          startTime: { type: 'string' }, description: { type: 'string' },
        } } } },
      },
      'traffic-anomalies': {
        type: ['object', 'null'],
        properties: {
          anomalies: { type: 'array', items: { type: 'object', properties: {
            uuid: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' },
            startDate: { type: 'number' }, endDate: { type: 'number', description: '0 means ongoing.' },
            asn: { type: 'string' }, asnName: { type: 'string' }, locationCode: { type: 'string' }, locationName: { type: 'string' },
            latitude: { type: 'number' }, longitude: { type: 'number' },
          } } },
          totalCount: { type: 'integer', description: 'Global anomaly count before the country filter and limit.' },
        },
      },
      ddos: {
        type: ['object', 'null'],
        properties: {
          protocol: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, percentage: { type: 'number' } } } },
          vector: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, percentage: { type: 'number' } } } },
          dateRangeStart: { type: 'string' }, dateRangeEnd: { type: 'string' },
          topTargetLocations: { type: 'array', items: { type: 'object', properties: {
            countryCode: { type: 'string' }, countryName: { type: 'string' }, percentage: { type: 'number' },
            latitude: { type: 'number' }, longitude: { type: 'number' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _validateArgs: (params) => {
      resolveCountryFilter(params.country, 'country');
      const datasets = argStrList(params.dataset);
      if (params.country !== undefined && datasets.length > 0 && datasets.every((dataset) => dataset === 'ddos')) {
        throw new RpcValidationError('get_infrastructure_status', [{ field: 'country', description: 'DDoS summaries are global; country filters outages and traffic only.' }]);
      }
    },
    _postFilter: (data, params) => {
      const [country] = resolveCountryFilter(params.country, 'country').map((code) => code.toUpperCase());
      const severity = argStr(params.severity);
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      const traffic = data['traffic-anomalies'] as { anomalies?: unknown; totalCount?: number } | null | undefined;
      if (traffic && Array.isArray(traffic.anomalies)) traffic.totalCount = traffic.anomalies.length;
      if (country) {
        // Outage rows carry only a country name, so resolve it to compare codes.
        narrowNested(data, 'outages', 'outages', (o) => resolveCountryCode(o.country) === country);
        narrowNested(data, 'traffic-anomalies', 'anomalies', (a) => a.locationCode === country);
      }
      if (severity) narrowNested(data, 'outages', 'outages', (o) => ciIncludes(o.severity, severity));
      capNested(data, 'outages', 'outages', limit);
      capNested(data, 'traffic-anomalies', 'anomalies', limit);
      for (const list of ['protocol', 'vector', 'topTargetLocations']) capNested(data, 'ddos', list, limit);
      if (data.ddos && typeof data.ddos === 'object') delete (data.ddos as Record<string, unknown>)._targetLocationsDegraded;
      const selected = argStrList(params.dataset).map((dataset) => dataset === 'traffic' ? 'traffic-anomalies' : dataset);
      return selected.length > 0 ? selectDatasets(data, selected) : data;
    },
    _cacheKeys: ['infra:outages:v1', 'cf:radar:traffic-anomalies:v1', 'cf:radar:ddos:v1'],
    _freshnessChecks: [
      { key: 'seed-meta:infra:outages', maxStaleMin: 30 },
      { key: 'seed-meta:cf:radar:traffic-anomalies', maxStaleMin: 60 },
      { key: 'seed-meta:cf:radar:ddos', maxStaleMin: 60 },
    ],
    _apiPaths: [
      "GET /api/infrastructure/v1/list-internet-outages",
      'GET /api/infrastructure/v1/list-internet-traffic-anomalies',
      'GET /api/infrastructure/v1/list-internet-ddos-attacks',
    ],
  },
  {
    name: 'get_supply_chain_data',
    title: 'Freight rates, supply-chain pressure and trade flows',
    _subscriptionOnly: true,
    _outputBudgetBytes: 131072,
    description: 'Return seeded supply-chain pressure and trade data: freight-rate indices, the NY Fed GSCPI, a BDRY and carrier-equity shipping-stress proxy, monthly customs revenue and UN COMTRADE flows. Freight includes FRED levels and history, plus SSE change percentages, direction and z-scores against stored prior observations, with at least 12 baseline points. SSE raw levels and Baltic indices are excluded. GSCPI is monthly, in standard deviations, and subject to revision. Customs revenue is stale after 2 days; freight after 7 hours; GSCPI after 2 days. Requires a paid plan; no live fetch, weight 1 on API plans. dataset selects shipping_stress, customs-revenue, flows, freight-rates or gscpi; commodity and reporter filter flows. limit caps lists, with newest GSCPI months kept chronological (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['shipping_stress', 'customs-revenue', 'flows', 'freight-rates', 'gscpi'] },
          description: 'Restrict the response to one or more sub-datasets (equity shipping-stress proxy, customs revenue, COMTRADE flows, freight rates, GSCPI). Omit for all.',
        },
        commodity: {
          type: 'string',
          description: 'Filter COMTRADE flows to one commodity — matches the HS code exactly or the commodity description by substring (e.g. "2709" or "crude").',
        },
        reporter: {
          type: 'string',
          description: 'Filter COMTRADE flows to one reporter by numeric reporter code or reporter name (e.g. "156" or "China").',
        },
        limit: { type: 'number', description: 'Cap each list dataset (carriers, months, flows, freight indices and GSCPI observations) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      shipping_stress: {
        type: ['object', 'null'],
        properties: { carriers: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, stressScore: { type: ['number', 'null'] },
        } } } },
      },
      'customs-revenue': {
        type: ['object', 'null'],
        properties: { months: { type: 'array', items: { type: 'object', properties: {
          month: { type: 'string' }, revenueUsd: { type: ['number', 'null'] },
        } } } },
      },
      flows: {
        type: ['object', 'null'],
        properties: { flows: { type: 'array', items: { type: 'object', properties: {
          cmdCode: { type: 'string' }, cmdDesc: { type: 'string' }, reporter: { type: 'string' },
          partner: { type: 'string' }, value: { type: ['number', 'null'] },
        } } } },
      },
      'freight-rates': {
        type: ['object', 'null'],
        properties: {
          fetchedAt: { type: ['string', 'null'] },
          indices: { type: 'array', items: {
            type: 'object',
            properties: {
              indexId: { type: 'string', enum: ['PCU483111483111', 'TSIFRGHT', 'SCFI', 'CCFI'] },
              name: { type: 'string' }, source: { type: 'string' }, unit: { type: 'string' },
              frequency: { type: 'string', enum: ['monthly', 'weekly'] },
              observationDate: { type: ['string', 'null'] },
              periodChangePct: { type: ['number', 'null'] },
              periodChangeBasis: { type: ['string', 'null'] }, priorPeriodDate: { type: ['string', 'null'] },
              zScore: { type: ['number', 'null'], description: 'Population z-score against stored observations excluding the latest. Null with fewer than 12 baseline points or zero variance.' },
              baselinePoints: { type: 'integer' }, baselineStart: { type: ['string', 'null'] },
              direction: { type: ['string', 'null'], enum: ['up', 'down', 'flat', null] },
              currentValue: { type: ['number', 'null'], description: 'FRED series only.' },
              history: { type: 'array', description: 'FRED series only.', items: { type: 'object', properties: {
                date: { type: 'string' }, value: { type: 'number' },
              } } },
            },
            required: ['indexId', 'source', 'frequency', 'observationDate', 'periodChangePct', 'zScore', 'baselinePoints', 'baselineStart', 'direction'],
            additionalProperties: false,
          } },
        },
      },
      gscpi: {
        type: ['object', 'null'],
        description: 'Federal Reserve Bank of New York Global Supply Chain Pressure Index. Monthly values are subject to revision.',
        properties: {
          source: { type: 'string' }, sourceUrl: { type: 'string' },
          series: { type: 'object', properties: {
            series_id: { type: 'string' }, title: { type: 'string' }, units: { type: 'string' }, frequency: { type: 'string' },
            observations: { type: 'array', items: { type: 'object', properties: {
              date: { type: 'string' }, value: { type: 'number' },
            } } },
          } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const commodity = argStr(params.commodity);
      const reporter = argStr(params.reporter);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (commodity) {
        narrowNested(data, 'flows', 'flows', (f) => argStr(f.cmdCode) === commodity || ciIncludes(f.cmdDesc, commodity));
      }
      if (reporter) {
        narrowNested(data, 'flows', 'flows', (f) => argStr(f.reporterCode) === reporter || ciIncludes(f.reporterName ?? f.reporter, reporter));
      }
      capNested(data, 'shipping_stress', 'carriers', limit);
      capNested(data, 'customs-revenue', 'months', limit);
      capNested(data, 'flows', 'flows', limit);
      capNested(data, 'freight-rates', 'indices', limit);
      const series = (data.gscpi as { series?: { observations?: unknown[] } } | null)?.series;
      if (series?.observations && limit > 0) {
        const count = Math.floor(limit);
        series.observations = count > 0 ? series.observations.slice(-count) : [];
      }
      return selectDatasets(data, argStrList(params.dataset));
    },
    _project: projectSupplyChainData,
    _cacheLabels: { 'supply_chain:shipping:v2': 'freight-rates', 'economic:fred:v1:GSCPI:0': 'gscpi' },
    _cacheKeys: [
      'supply_chain:shipping_stress:v1',
      'trade:customs-revenue:v1',
      'comtrade:flows:v1',
      'supply_chain:shipping:v2',
      'economic:fred:v1:GSCPI:0',
    ],
    _freshnessChecks: [
      { key: 'seed-meta:trade:customs-revenue', maxStaleMin: 2880 },
      { key: 'seed-meta:supply_chain:shipping', maxStaleMin: 420, honorContentAge: true },
      { key: 'seed-meta:economic:gscpi', maxStaleMin: 2880 },
    ],
    _apiPaths: [
      "GET /api/supply-chain/v1/get-shipping-stress",
      "GET /api/trade/v1/get-customs-revenue",
      "GET /api/supply-chain/v1/get-shipping-rates",
    ],
  },
  {
    name: 'get_price_and_debt_indicators',
    _validateArgs: params => { resolveCountryFilter(params.country, 'country'); },
    title: 'Big Mac, food price and debt indicators',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded price and debt indicator bundle: the Economist Big Mac index by country, the FAO Food Price Index and per-country national debt levels. Each sub-dataset has its own staleness budget (Big Mac a week, FAO and debt 60 days). No tariff rates: a dataset value of tariffs is rejected with a validation error. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. dataset selects bigmac, fao-ffpi or national-debt; country narrows Big Mac and debt rows (alpha-2, alpha-3 or name); limit caps each list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['bigmac', 'fao-ffpi', 'national-debt'] },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the per-country datasets to one ISO 3166-1 alpha-2 country code (e.g. "US"). It is translated to alpha-3 internally for the national-debt dataset; passing an alpha-3 code directly also works. Country names and alpha-3 codes are accepted; unresolved inputs return Invalid params.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (BigMac countries, debt entries) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      bigmac: {
        type: ['object', 'null'],
        properties: { countries: { type: 'array', items: { type: 'object', properties: {
          code: { type: 'string' }, priceLocal: { type: ['number', 'null'] }, priceUsd: { type: ['number', 'null'] },
        } } } },
      },
      'fao-ffpi': { type: ['object', 'null'] },
      'national-debt': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: {
          iso3: { type: 'string' }, value: { type: ['number', 'null'] }, year: { type: ['number', 'string'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const ds = argStrList(params.dataset);
      // The US MFN series left this free-account bundle (#9301): its REST
      // route is Pro, and get_tariff_averages serves it there.
      if (ds.includes('tariffs')) {
        throw new RpcValidationError('get_price_and_debt_indicators', [{ field: 'dataset', description: 'The tariffs dataset moved to get_tariff_averages (Pro). Choose bigmac, fao-ffpi or national-debt.' }]);
      }
      const countries = resolveCountryFilter(params.country, 'country');
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'bigmac', 'countries', (c) => matchesCode(c.code, countries));
        // national-debt entries are keyed by ISO alpha-3 (iso3:"USA"); the
        // country param is alpha-2 like the rest of the tool, so expand it.
        const debtCodes = [
          ...countries,
          ...compact(countries.map((c) => ISO2_TO_ISO3[c.toUpperCase()]?.toLowerCase())),
        ];
        narrowNested(data, 'national-debt', 'entries', (e) => matchesCode(e.iso3, debtCodes));
      }
      capNested(data, 'bigmac', 'countries', limit);
      capNested(data, 'national-debt', 'entries', limit);
      if (ds.length > 0) return selectDatasets(data, ds);
      return data;
    },
    // 3-key economic bundle, weekly (Big Mac) to monthly (FAO / national
    // debt). Per-key _freshnessChecks pulled from api/health.js::SEED_META so
    // a slow monthly key doesn't drag the aggregate stale flag.
    _cacheKeys: [
      'economic:bigmac:v1',            // BOOTSTRAP_KEYS::bigmac
      'economic:fao-ffpi:v1',          // BOOTSTRAP_KEYS::faoFoodPriceIndex
      'economic:national-debt:v1',     // BOOTSTRAP_KEYS::nationalDebt
    ],
    _freshnessChecks: [
      { key: 'seed-meta:economic:bigmac',             maxStaleMin: 10080 }, // weekly seed; 7d
      { key: 'seed-meta:economic:fao-ffpi',           maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
      { key: 'seed-meta:economic:national-debt',      maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-fao-food-price-index",
      "GET /api/economic/v1/get-national-debt",
      "GET /api/economic/v1/list-bigmac-prices",
    ],
  },
  {
    name: 'get_capital_flows',
    title: 'Cross-country capital flows',
    _outputBudgetBytes: 131072,
    description: 'Return where money enters and leaves about 230 economies, and between any two, from official statistics. IMF balance of payments: gross inflows and outflows split into FDI, portfolio and other investment, quarterly or annual by country, with derived Forbes-Warnock states (surge or stop for inflows, flight or retrenchment for outflows) and z-scores. Per country and per pair: BIS cross-border bank deposits and lending, IMF portfolio holdings and IMF direct-investment positions. People changing residence are not a BOP flow. Sources lag 1-3 quarters (FDI ~2 years); stale after 10 days or when the newest BOP quarter is over a year old. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance. country (max 10) returns full views; counterpart adds both directions of each pair, each leg marked reported, not_itemized or not_published. Without country, a ranking of countries that have the sort metric (default outflow_z; annual-only series have none) capped by limit (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        country: {
          type: 'array',
          items: { type: 'string' },
          maxItems: CAPITAL_FLOWS_MAX_COUNTRIES,
          description: 'Countries to return in full: ISO 3166-1 alpha-2 (e.g. "GB"), alpha-3 ("ARE") or English names. Omit to get the cross-country ranking.',
        },
        include_series: { type: 'boolean', description: 'With country, also return the period-by-period BOP flows (12 quarters or 6 years). Default false.' },
        counterpart: {
          type: 'string',
          description: 'With country, a partner country (alpha-2, alpha-3 or name). Returns pairs[]: deposits each side\'s non-banks hold in the other\'s banks and bank lending each way (stock, 4-quarter flow, 8 quarters of history), each side\'s holdings of the other\'s securities, and direct investment each way with both sides\' figures, plus the counterpart\'s own view.',
        },
        sort: {
          type: 'string',
          enum: [...CAPITAL_FLOWS_SORTS],
          description: 'Ranking field when country is omitted. outflow_z / inflow_z rank the latest Forbes-Warnock z-score; *_pct_gdp rank trailing gross flows as a share of GDP; net_usd_bn ranks inflows minus outflows; bank_deposits_abroad_flow_4q ranks the 4-quarter change in non-bank deposits held in foreign banks; foreign_portfolio_change_pct ranks the year-on-year change in foreign holdings of the country\'s securities. Default outflow_z.',
        },
        ascending: { type: 'boolean', description: 'Sort ascending instead of descending. Default false.' },
        limit: { type: 'number', description: 'Cap the ranking to this many countries (default 30, pass 0 for no cap). Ignored with country.' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'capital-flows': {
        type: ['object', 'null'],
        properties: {
          latest: { type: ['object', 'null'], properties: {
            bopQuarter: { type: ['string', 'null'] }, bopNewestQuarter: { type: ['string', 'null'] }, bopYear: { type: ['string', 'null'] },
            bisQuarter: { type: ['string', 'null'] }, pipYear: { type: ['number', 'null'] }, fdiYear: { type: ['number', 'null'] },
          } },
          coverage: { type: ['object', 'null'] },
          units: { type: 'string' },
          method: { type: ['object', 'null'], description: 'Method notes per view, including the caveat that wealth migration is not a BOP flow.' },
          seededAt: { type: ['string', 'null'] },
          countries: {
            type: 'object',
            description: 'Present when country is given. Keyed by alpha-2; null when the country has no data.',
            additionalProperties: { type: ['object', 'null'], properties: {
              iso2: { type: 'string' }, iso3: { type: ['string', 'null'] }, gdpUsdBn: { type: ['number', 'null'] },
              bop: { type: ['object', 'null'], description: 'frequency quarterly carries state, episodes and trailing4q; annual carries latestYear and no episodes.' },
              bank: { type: ['object', 'null'] },
              portfolio: { type: ['object', 'null'] },
              fdi: { type: ['object', 'null'], description: 'IMF direct-investment positions as the country reports them, by immediate counterpart.' },
            } },
          },
          pairs: {
            type: 'array',
            description: 'Present with counterpart: one entry per country (a) against the counterpart (b); null when the pair matrices are unavailable or from a different seed run.',
            items: {
              type: ['object', 'null'],
              properties: {
                country: { type: 'string' }, counterpart: { type: 'string' },
                bankPeriod: { type: 'string' }, portfolioYear: { type: 'integer' },
                aDepositsInB: CAPITAL_FLOW_PAIR_LEG_SCHEMA, bDepositsInA: CAPITAL_FLOW_PAIR_LEG_SCHEMA,
                aBorrowingFromB: CAPITAL_FLOW_PAIR_LEG_SCHEMA, bBorrowingFromA: CAPITAL_FLOW_PAIR_LEG_SCHEMA,
                aHoldingsOfB: CAPITAL_FLOW_PAIR_LEG_SCHEMA, bHoldingsOfA: CAPITAL_FLOW_PAIR_LEG_SCHEMA,
                aFdiInB: CAPITAL_FLOW_PAIR_LEG_SCHEMA, bFdiInA: CAPITAL_FLOW_PAIR_LEG_SCHEMA,
                fdiYear: { type: 'integer' },
              },
              required: ['country', 'counterpart', 'aDepositsInB', 'bDepositsInA', 'aBorrowingFromB', 'bBorrowingFromA', 'aHoldingsOfB', 'bHoldingsOfA', 'aFdiInB', 'bFdiInA'],
            },
          },
          sort: { type: 'string', enum: [...CAPITAL_FLOWS_SORTS] },
          order: { type: 'string', enum: ['ascending', 'descending'] },
          rankedCount: { type: 'integer', description: 'Countries with a value for the sort field, before limit.' },
          ranking: {
            type: 'array',
            description: 'Present when country is omitted.',
            items: {
              type: 'object',
              properties: {
                country: { type: 'string' },
                frequency: { type: ['string', 'null'], enum: ['quarterly', 'annual', null] },
                latestPeriod: { type: ['string', 'null'] },
                inflowState: { type: ['string', 'null'], enum: ['surge', 'stop', null] },
                outflowState: { type: ['string', 'null'], enum: ['flight', 'retrenchment', null] },
                inflowZ: { type: ['number', 'null'] }, outflowZ: { type: ['number', 'null'] },
                inflowsUsdBn: { type: ['number', 'null'] }, outflowsUsdBn: { type: ['number', 'null'] }, netUsdBn: { type: ['number', 'null'] },
                inflowsPctGdp: { type: ['number', 'null'] }, outflowsPctGdp: { type: ['number', 'null'] },
                bankDepositsAbroadFlow4qUsdBn: { type: ['number', 'null'] },
                foreignPortfolioChangePct: { type: ['number', 'null'] },
              },
              required: ['country', 'frequency', 'latestPeriod', 'inflowState', 'outflowState', 'inflowZ', 'outflowZ'],
            },
          },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = resolveCountryFilter(params.country, 'country');
      if (countries.length > CAPITAL_FLOWS_MAX_COUNTRIES) {
        throw new RpcValidationError('get_capital_flows', [{ field: 'country', description: `Pass at most ${CAPITAL_FLOWS_MAX_COUNTRIES} countries.` }]);
      }
      const sortArg = typeof params.sort === 'string' && params.sort ? params.sort : 'outflow_z';
      if (!(CAPITAL_FLOWS_SORTS as readonly string[]).includes(sortArg)) {
        throw new RpcValidationError('get_capital_flows', [{ field: 'sort', description: `Choose one of ${CAPITAL_FLOWS_SORTS.join(', ')}.` }]);
      }
      const counterpart = resolveCountryFilter(params.counterpart, 'counterpart');
      if (counterpart.length > 0 && countries.length === 0) {
        throw new RpcValidationError('get_capital_flows', [{ field: 'counterpart', description: 'counterpart needs at least one country.' }]);
      }
      if (counterpart.length > 1) {
        throw new RpcValidationError('get_capital_flows', [{ field: 'counterpart', description: 'Pass one counterpart.' }]);
      }
      return projectCapitalFlows(data, {
        countries,
        counterpart: counterpart[0],
        includeSeries: argBool(params.include_series),
        sort: sortArg as CapitalFlowsSort,
        ascending: argBool(params.ascending),
        // 0 = no cap; a negative limit falls back to the default rather than uncapping.
        limit: (() => { const n = argNum(params.limit); return n == null || n < 0 ? DEFAULT_LIST_LIMIT : Math.floor(n); })(),
      });
    },
    // The pair matrices (~280 KB) are written by the same seeder run; the
    // projection drops them unless a counterpart is asked for.
    _cacheKeys: ['economic:capital-flows:v1', 'economic:capital-flows:pairs:v1'], // STANDALONE_KEYS::capitalFlows
    _cacheLabels: { 'economic:capital-flows:pairs:v1': CAPITAL_FLOWS_PAIRS_LABEL },
    _freshnessChecks: [
      // Weekly macro-bundle seed; 10d matches api/health.js SEED_META.capitalFlows.
      // honorContentAge: a frozen IMF BOP feed (newest quarter > 12 months) flags stale.
      { key: 'seed-meta:economic:capital-flows', maxStaleMin: 14400, honorContentAge: true },
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-capital-flows",
    ],
  },
  {
    name: 'get_chokepoint_status',
    title: 'Maritime chokepoint status',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded maritime chokepoint snapshot: per-chokepoint vessel transit counts at 10-minute cadence, rolling transit summaries, a port-country coverage index, oil and gas flow aggregates, baselines and the canonical 13-chokepoint registry (Suez, Hormuz, Malacca, Bab-el-Mandeb, Panama and others). Transit data is flagged stale after 30 minutes. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. chokepoint narrows transit-summaries, chokepoint_transits, chokepoint-baselines and chokepoint-flows by case-insensitive substring ("hormuz"), leaving ref and _countries unfiltered; dataset selects sub-datasets; limit caps the baselines list and _countries index (default 30, 0 for no cap) while keyed maps are not capped. Paid openings use one chokepoint panel allocation; repeat views reuse it, refresh with a request_id UUID spends a new one and the same UUID retries it. API and free accounts retain per-tool accounting.',
    inputSchema: {
      type: 'object',
      properties: {
        panel_request: { type: 'string', description: 'Signed owner-bound chokepoint reader token from a paid opening. Covers only this tool and its existing filters; cannot be combined with refresh.' },
        refresh: { type: 'boolean', description: 'Paid allowance only: explicitly request a new panel allocation. Supply a request_id UUID.' },
        request_id: { type: 'string', description: 'UUID for an explicit paid refresh; retry the same UUID to reuse that allocation.' },
        chokepoint: {
          type: 'string',
          description: 'Filter to one chokepoint — matches by case-insensitive substring in transit-summaries, chokepoint_transits, chokepoint-baselines and chokepoint-flows (e.g. "hormuz" matches "hormuz_strait", "Strait of Hormuz"). ref and _countries are not filtered by it.',
        },
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['transit-summaries', 'chokepoint_transits', '_countries', 'chokepoint-baselines', 'ref', 'chokepoint-flows'],
          },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full bundle.',
        },
        limit: { type: 'number', description: 'Cap the chokepoint-baselines list and the _countries ISO2 index to at most this many items (default 30, pass 0 for no cap). Keyed-object maps (transit-summaries, chokepoint_transits, ref, chokepoint-flows) are intentionally not capped; the `chokepoint` filter narrows all of them except ref.' },
      },
      required: [],
    },
    // Schema validated against tests/fixtures/jmespath-samples/thin-get-chokepoint-status.response.json.
    outputSchema: cacheEnvelope({
      'transit-summaries': {
        type: ['object', 'null'],
        properties: {
          summaries: { type: 'object', additionalProperties: { type: 'object', properties: {
            todayTotal: { type: ['number', 'null'] }, todayTanker: { type: ['number', 'null'] },
            todayCargo: { type: ['number', 'null'] }, todayOther: { type: ['number', 'null'] },
            wowChangePct: { type: ['number', 'null'] }, riskLevel: { type: 'string' },
            incidentCount7d: { type: ['number', 'null'] }, disruptionPct: { type: ['number', 'null'] },
            riskSummary: { type: 'string', description: 'Generated prose is withheld as an empty string. This does not indicate low risk.' },
            riskReportAction: { type: 'string', description: 'Operational advice is withheld as an empty string because it has no verified routing basis.' },
            anomaly: { type: 'object' }, dataAvailable: { type: 'boolean' },
            // null todayTotal means the relay's 24h AIS window was empty --
            // unsupplied, not a measured zero (#7457). dataAvailable is
            // PortWatch history presence and says nothing about today's count.
            todayCountsAvailable: { type: 'boolean' },
          } } },
          fetchedAt: { type: ['number', 'string'] },
        },
      },
      chokepoint_transits: {
        type: ['object', 'null'],
        properties: {
          // Same in-memory AIS window as transit-summaries, so the same caveat
          // applies: `available: false` means the window was empty and the
          // numeric counts are a zero fill, not a measurement.
          transits: { type: 'object', additionalProperties: { type: 'object', properties: {
            tanker: { type: 'number' }, cargo: { type: 'number' },
            other: { type: 'number' }, total: { type: 'number' },
            available: { type: 'boolean' },
          } } },
          fetchedAt: { type: ['number', 'string'] },
        },
      },
      _countries: {
        type: ['array', 'object', 'null'],
        items: { type: 'string' },
      },
      'chokepoint-baselines': {
        type: ['object', 'null'],
        properties: {
          source: { type: 'string' }, referenceYear: { type: ['number', 'string'] },
          updatedAt: { type: 'string' },
          chokepoints: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, relayId: { type: 'string' }, name: { type: 'string' },
          } } },
        },
      },
      ref: {
        type: ['object', 'null'],
        additionalProperties: { type: 'object' },
      },
      'chokepoint-flows': {
        type: ['object', 'null'],
        additionalProperties: { type: 'object', properties: {
          currentMbd: { type: ['number', 'null'] },
          baselineMbd: { type: ['number', 'null'] },
          flowRatio: { type: ['number', 'null'] },
          disrupted: { type: 'boolean' },
          // The closed taxonomy #6101 promoted on the REST path; served
          // values are narrowed onto it in _postFilter below, so this enum
          // is enforced, not aspirational (#6113).
          source: { type: 'string', enum: [...FLOW_SOURCE_WIRE_VALUES] },
          // Raw seeder value, NOT the closed hazard enum. Hand-authored JSON
          // Schema COULD express it here today (#6113 says so explicitly; see
          // the `source` enums on get_toronto_* above) — this is DEFERRED, not
          // blocked: #6106 blocks the REST twin on sebuf codegen, and shipping
          // the closed set on one surface only would recreate the very
          // declare-vs-serve split this tool just closed for `source`.
          //
          // Nullability is likewise a DELIBERATE divergence from REST, not an
          // oversight: get-chokepoint-status.ts coerces `null -> ''` because
          // the proto field is non-nullable, a constraint this hand-authored
          // schema does not have. Serving `null` keeps "no hazard nearby"
          // distinguishable from "hazard with an empty name", which is the more
          // useful answer for an agent. Declared as it is actually served.
          hazardAlertLevel: { type: ['string', 'null'] },
          hazardAlertName: { type: ['string', 'null'] },
        } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      // Narrow BEFORE any filtering so the declared source enum above is a
      // property of every served response, exactly as the REST boundary's
      // narrowServedSources makes it (#6113). The blob is written by a seeder
      // that deploys independently; an undeclared basis must read as
      // FLOW_SOURCE_UNSPECIFIED, never leak verbatim.
      //
      // Deliberately NOT guarded on `'source' in entry`. This is about the
      // CLOSED-ENUM field specifically: the schema above declares a closed set
      // for `source`, and "absent" is not a member of it, so an entry omitting
      // the key must read FLOW_SOURCE_UNSPECIFIED — the declared way to say
      // "not one of the known bases". The REST twin resolves it the same way
      // (`source: toFlowSource(...)`, built unconditionally), and
      // tests/chokepoint-flow-source-taxonomy.test.mts pins that case there.
      //
      // Scope note: this is NOT a general "match REST field-for-field" rule.
      // REST also defaults hazardAlertLevel/hazardAlertName (`?? ''`), and this
      // surface deliberately does not — see the nullability comment on those
      // two fields above. Closed enum here, raw passthrough there, on purpose.
      const flows = data['chokepoint-flows'];
      if (flows && typeof flows === 'object') {
        for (const entry of Object.values(flows)) {
          if (entry && typeof entry === 'object') {
            (entry as { source: unknown }).source = narrowFlowSource((entry as { source: unknown }).source);
          }
        }
      }
      mapNested(data, 'transit-summaries', 'summaries', (summaries) => {
        if (!summaries || typeof summaries !== 'object' || Array.isArray(summaries)) return summaries;
        return Object.fromEntries(Object.entries(summaries).map(([id, entry]) => [id,
          entry && typeof entry === 'object'
            ? { ...entry, riskSummary: '', riskReportAction: '' }
            : entry,
        ]));
      });
      const cp = argStr(params.chokepoint);
      if (cp) {
        mapNested(data, 'transit-summaries', 'summaries', (m) => pickMapKeysLike(m, cp));
        mapNested(data, 'chokepoint_transits', 'transits', (m) => pickMapKeysLike(m, cp));
        data['chokepoint-flows'] = pickMapKeysLike(data['chokepoint-flows'], cp);
        narrowNested(data, 'chokepoint-baselines', 'chokepoints', (c) => ciIncludes(c?.id, cp) || ciIncludes(c?.relayId, cp) || ciIncludes(c?.name, cp));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'chokepoint-baselines', 'chokepoints', limit);
      // _countries is the only top-level array in this bundle (string[] of ISO2 codes).
      capArrays(data, limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    // Maritime chokepoint bundle distinct from get_supply_chain_data (which keeps
    // shipping-stress + customs + comtrade). Cadences span 10-minute relay
    // (transit-summaries, chokepoint_transits) to ~400-day static registries
    // (chokepoint-baselines), so per-key _freshnessChecks pulled from
    // api/health.js::SEED_META — a fast transit outage isn't masked by the
    // slow chokepoint-baselines budget, and the long-cadence portwatch keys
    // don't drag aggregate stale flagging.
    //
    // That mirror claim is ENFORCED, not aspirational: the portwatch-ports
    // entry is asserted field-for-field against health's exported
    // SEED_META.portwatchPortActivity in
    // tests/mcp-portwatch-content-freshness-parity.test.mjs. #4293 aligned the
    // two surfaces on cardinality; #6080 aligned them on content freshness
    // after the comment had silently stopped being true.
    //
    // Payload measurement (PR pre-merge, fun-toad-55127.upstash.io 2026-05-11):
    //   transit-summaries:v1                        — 6.8 KB
    //   chokepoint_transits:v1                      — 1.1 KB
    //   portwatch-ports:v1:_countries               — 0.9 KB
    //   energy:chokepoint-baselines:v1              — 0.6 KB
    //   portwatch:chokepoints:ref:v1                — 7.9 KB
    //   energy:chokepoint-flows:v1                  — 1.2 KB
    //   ────────────────────────────────────────────────────
    //   Total: 18.5 KB (well under the 200KB/single-key and 500KB/aggregate
    //   thresholds that historically tripped handler timeouts —
    //   see tests/transit-summaries.test.mjs:539-545).
    //
    // EXCLUDED on purpose: supply_chain:corridorrisk:v1 is an intermediate
    // key whose data flows through supply_chain:transit-summaries:v1
    // (api/health.js:461). U7 will add corridorrisk to EXCLUDED_FROM_MCP.
    // MCP Apps (`io.modelcontextprotocol/ui`): links the tool to its interactive
    // ui:// app shell. Single source of truth — registered in ../ui/registry.ts.
    _uiResourceUri: CHOKEPOINT_MONITOR_UI_URI,
    _cacheKeys: [
      'supply_chain:transit-summaries:v1',          // STANDALONE_KEYS::transitSummaries
      'supply_chain:chokepoint_transits:v1',        // STANDALONE_KEYS::chokepointTransits
      'supply_chain:portwatch-ports:v1:_countries', // STANDALONE_KEYS::portwatchPortActivity
      'energy:chokepoint-baselines:v1',             // STANDALONE_KEYS::chokepointBaselines
      'portwatch:chokepoints:ref:v1',               // STANDALONE_KEYS::portwatchChokepointsRef
      'energy:chokepoint-flows:v1',                 // STANDALONE_KEYS::chokepointFlows
    ],
    _freshnessChecks: [
      { key: 'seed-meta:supply_chain:transit-summaries',   maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:chokepoint_transits', maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      // #3613 requires full country coverage; #6060 adds the per-entity content
      // dimension — a complete 174/174 run can still carry a synthetic >170h-old CN payload,
      // which transport age and record count both read as fresh (#6080).
      {
        key: 'seed-meta:supply_chain:portwatch-ports',
        maxStaleMin: 2160, // 12h cron; 36h = 3× interval
        minRecordCount: 174,
        requireContentFreshness: { countries: ['CN', 'HK'], budgetMinutes: 10 * 24 * 60 },
        contentFreshnessActivationKey: PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY,
      },
      { key: 'seed-meta:energy:chokepoint-baselines',      maxStaleMin: 60 * 24 * 400 },  // ~400d static registry
      { key: 'seed-meta:portwatch:chokepoints-ref',        maxStaleMin: 60 * 24 * 14 },   // weekly cron; 14d = 2× interval
      { key: 'seed-meta:energy:chokepoint-flows',          maxStaleMin: 720 },            // 6h cron; 12h = 2× interval
    ],
    _apiPaths: [
      "GET /api/supply-chain/v1/get-chokepoint-status",
    ],
  },
  {
    name: 'get_positive_events',
    title: 'Positive geopolitical events',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded map of positive-news locations: each entry is a place (name, latitude, longitude) with the count of positive-toned GDELT bulk reports that mention it, a category classified from report keywords (science-health, nature-wildlife, climate-wins, innovation-tech, humanity-kindness, culture-community) and the timestamp of the latest report. Location buckets, not individual stories: there are no titles, article text or source URLs, and a bucket needs at least 3 reports before it appears. Seeded from the GDELT bulk feed and flagged stale after 1 h. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. category selects one of the six buckets; limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['science-health', 'nature-wildlife', 'climate-wins', 'innovation-tech', 'humanity-kindness', 'culture-community'],
          description: 'Filter to one positive-event category.',
        },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'geo-bootstrap': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          category: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
          date: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const category = argStr(params.category);
      if (category) narrowNested(data, 'geo-bootstrap', 'events', (e) => argStr(e.category) === category);
      capNested(data, 'geo-bootstrap', 'events', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['positive_events:geo-bootstrap:v1'],
    _freshnessChecks: [{ key: 'seed-meta:positive-events:geo', maxStaleMin: 60 }],
    _apiPaths: [
      'GET /api/positive-events/v1/list-positive-geo-events',
    ],
  },
  {
    name: 'get_radiation_data',
    title: 'Radiation monitoring readings',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded radiation monitoring snapshot: gamma dose-rate readings from public monitoring stations worldwide with station, country, value, unit, time and a severity flag (normal, elevated, spike) that marks anomalous readings. Flagged stale after 30 minutes. Station observations only; an elevated reading is a flag for review, not a confirmed nuclear incident. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. country is a case-insensitive name substring; anomalous_only drops normal readings; limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring).' },
        anomalous_only: {
          type: 'boolean',
          description: 'Drop observations with severity "normal" — keep only elevated/spike readings.',
        },
        limit: { type: 'number', description: 'Cap the observation list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      observations: {
        type: ['object', 'null'],
        properties: { observations: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, severity: { type: 'string' },
          stationName: { type: 'string' }, value: { type: ['number', 'null'] }, unit: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      if (country) narrowNested(data, 'observations', 'observations', (o) => ciIncludes(o.country, country));
      if (argBool(params.anomalous_only)) {
        narrowNested(data, 'observations', 'observations', (o) => !argStr(o.severity).endsWith('normal'));
      }
      capNested(data, 'observations', 'observations', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['radiation:observations:v1'],
    _freshnessChecks: [{ key: 'seed-meta:radiation:observations', maxStaleMin: 30 }],
    _apiPaths: [
      "GET /api/radiation/v1/list-radiation-observations",
    ],
  },
  {
    name: 'get_research_signals',
    title: 'Technology and research signals',
    _outputBudgetBytes: 131072,
    description: 'Return the seeded technology and research event list: upcoming and recent conferences, earnings dates, IPOs and other tech events from curated feeds such as Techmeme and dev.events, each with type, source, date and link. Flagged stale after 8 hours. Calendar-style event signals only; no papers, patents or funding data. Seeded-cache read with no live fetch: weight 1 on API plans, included in the signed-in free allowance. type selects conference, earnings, ipo or other; source filters one feed; limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['conference', 'earnings', 'ipo', 'other'],
          description: 'Filter to one tech-event type.',
        },
        source: { type: 'string', description: 'Filter to one source feed (e.g. "techmeme", "dev.events", "curated").' },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'tech-events-bootstrap': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          type: { type: 'string' }, source: { type: 'string' },
          title: { type: 'string' }, date: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.type);
      const source = argStr(params.source);
      if (type) narrowNested(data, 'tech-events-bootstrap', 'events', (e) => argStr(e.type) === type);
      if (source) narrowNested(data, 'tech-events-bootstrap', 'events', (e) => argStr(e.source) === source);
      capNested(data, 'tech-events-bootstrap', 'events', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['research:tech-events-bootstrap:v1'],
    _freshnessChecks: [{ key: 'seed-meta:research:tech-events', maxStaleMin: 480 }],
    _apiPaths: [
      'GET /api/research/v1/list-tech-events',
    ],
  },
  {
    name: 'get_forecast_predictions',
    title: 'Published forecast list (cached)',
    _uiResourceUri: FORECASTS_UI_URI,
    _outputBudgetBytes: 131072,
    description: 'Return the current published forecast list from the seeded cache (paid panel openings also attach per-domain reliability and recent familyOutcomes, not the full accuracy scorecard): each forecast with id, domain, region, probability, scenario text and, for API readers, its case file. Flagged stale after 90 minutes; AI assessments, not guarantees. Rows include firstSeenAt, firstSeenProbability, change24h and change7d. include_history adds up to 30 days of probability points and caps the list at 10. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance. domain filters exactly (conflict, market, supply_chain, political, military, cyber, infrastructure), region by case-insensitive substring, limit caps the list (default 30, 0 for no cap). Paid interactive openings return the compact list with case files stripped (hasCaseFile marks them) plus a signed panelRequest; repeat openings reuse the five-minute admission and refresh needs a fresh request_id.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Filter to one forecast domain (exact, case-insensitive): conflict, market, supply_chain, political, military, cyber, infrastructure.' },
        region: { type: 'string', description: 'Filter to one region/theater (case-insensitive substring).' },
        limit: { type: 'number', description: 'Paid interactive panel: integers 1–30, default 30. Ordinary API readers may use 0 for no cap.' },
        include_history: { type: 'boolean', description: 'Attach up to 120 probability points per forecast, up to 30 days. Caps rows at 10. Omitted in panel openings.' },
        refresh: { type: 'boolean', description: 'Request a new paid panel snapshot; requires a fresh request_id.' },
        request_id: { type: 'string', description: 'Unique idempotency identifier for an explicit refresh.' },
        panel_request: { type: 'string', description: 'Signed forecast panel receipt for a bounded internal list replay.' },
      },
      required: [],
    },
    outputSchema: (() => {
      const schema = cacheEnvelope({
      familyOutcomes: { type: 'array', maxItems: 150, items: { type: 'object', additionalProperties: false,
        properties: { forecastId: { type: 'string' }, outcome: { type: 'string', enum: ['YES', 'NO', 'VOID'] }, voidReason: { type: 'string', enum: [...FORECAST_VOID_REASONS] } },
        required: ['forecastId', 'outcome'],
      } },
      reliability: { type: 'object', properties: {
        status: { type: 'string', enum: ['ready', 'unavailable'] },
        underAudit: { type: 'object', description: 'Present while forecast accuracy is under audit; domain scores are withheld.', properties: { since: { type: 'string' }, issue: { type: 'number' }, reason: { type: 'string' } } },
        byDomain: { type: 'array', maxItems: 30, items: { type: 'object' } },
      } },
      predictions: {
        type: ['object', 'null'],
        properties: { predictions: { type: 'array', items: { type: 'object', properties: {
          domain: { type: 'string' }, region: { type: 'string' },
          probability: { type: ['number', 'null'] }, title: { type: 'string' },
          firstSeenAt: { type: ['string', 'null'] }, firstSeenProbability: { type: ['number', 'null'] },
          change24h: { type: ['number', 'null'] }, change7d: { type: ['number', 'null'] },
          history: { type: 'array', maxItems: 120, items: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2 } },
        } } } },
      },
      }) as { properties: Record<string, unknown> };
      return { ...schema, properties: { ...schema.properties, panelRequest: forecastPanelAdmissionSchema.toJSONSchema() } };
    })(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params, execution) => {
      const domain = argStr(params.domain);
      const region = argStr(params.region);
      if (domain) narrowNested(data, 'predictions', 'predictions', (p) => argStr(p.domain) === domain);
      if (region) narrowNested(data, 'predictions', 'predictions', (p) => ciIncludes(p.region, region));
      const panelOpening = execution?.panelScope === 'forecasts' || !!(execution?.panelRequest && 'panel' in execution.panelRequest && execution.panelRequest.panel === 'forecasts');
      const includeHistory = params.include_history === true && !panelOpening;
      const requestedLimit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'predictions', 'predictions', includeHistory ? Math.min(requestedLimit > 0 ? requestedLimit : 10, 10) : requestedLimit);
      attachForecastHistory(data, includeHistory);
      if (execution?.panelScope === 'forecasts' || execution?.panelRequest && 'panel' in execution.panelRequest && execution.panelRequest.panel === 'forecasts') {
        const source = data.predictions;
        if (source && typeof source === 'object' && !Array.isArray(source)) {
          const node = source as Record<string, unknown>;
          if (Array.isArray(node.predictions)) {
            let detailStripped = 0;
            const predictions = node.predictions.map(value => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
              const { caseFile, ...row } = value as Record<string, unknown>;
              if (caseFile !== undefined) { detailStripped++; return { ...row, hasCaseFile: true }; }
              return row;
            });
            data.predictions = {
              generatedAt: node.generatedAt, predictions, detailStripped,
              ...(typeof node.degraded === 'boolean' ? { degraded: node.degraded } : {}),
              ...(typeof node.stale === 'boolean' ? { stale: node.stale } : {}),
              ...(typeof node.error === 'string' ? { error: node.error.slice(0, 1200) } : {}),
            };
          }
        }
      }
      if (execution?.panelScope === 'forecasts' || execution?.panelRequest && 'panel' in execution.panelRequest && execution.panelRequest.panel === 'forecasts') {
        const node = data.predictions as { predictions?: unknown[] } | null;
        const domains = (Array.isArray(node?.predictions) ? node.predictions : []).flatMap(value => value && typeof value === 'object' && 'domain' in value && typeof value.domain === 'string' ? [value.domain] : []);
        const ids = (Array.isArray(node?.predictions) ? node.predictions : []).flatMap(value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? [value.id] : []);
        const familyOutcomes = forecastFamilyOutcomes(data, ids);
        return { predictions: data.predictions, reliability: forecastReliability(data, domains), ...(familyOutcomes === undefined ? {} : { familyOutcomes }) };
      }
      const rows = forecastRecord(data.predictions)?.predictions;
      if (includeHistory && Array.isArray(rows)) {
        while (rows.length > 1 && utf8ByteLength(JSON.stringify({ predictions: data.predictions })) > 128_000) rows.pop();
      }
      return { predictions: data.predictions };
    },
    _cacheKeys: ['forecast:predictions:v2', 'forecast:scorecard:v1', 'seed-meta:forecast:scorecard', 'forecast:probability-trail:v1'],
    _cacheLabels: { 'forecast:predictions:v2': 'predictions', 'forecast:scorecard:v1': 'scorecard', 'seed-meta:forecast:scorecard': 'scorecardMeta', 'forecast:probability-trail:v1': 'probabilityTrail' },
    _freshnessChecks: [{ key: 'seed-meta:forecast:predictions', maxStaleMin: 90 }, { key: 'seed-meta:forecast:probability-trail', maxStaleMin: 90 }],
    _apiPaths: [
      "GET /api/forecast/v1/get-forecasts",
    ],
  },
  {
    name: 'get_forecast_case',
    title: 'One forecast case file by ID',
    _subscriptionOnly: true,
    _outputBudgetBytes: 131072,
    description: 'Read exactly one original published forecast case, including its full case file, by forecast ID and the exact generatedAt of the forecast list it came from; no list and no accuracy scores. Returns generation_changed with no forecast when the published list has been regenerated since, and missing when the ID is not in the current generation. Dedicated MCP plans read it inside an open forecasts panel with its signed panel_request and no additional daily allocation; API plans read it without panel_request at the normal per-call charge. A single case exceeding the fixed response budget remains explicitly unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        forecast_id: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact original forecast ID from the forecast list.' },
        generated_at: { type: 'string', minLength: 1, maxLength: 64, description: 'Exact String(generatedAt) of the forecast list the ID came from.' },
        panel_request: { type: 'string', minLength: 1, maxLength: 160, description: 'Signed forecasts panel receipt. Required on dedicated MCP plans; not accepted on API plans.' },
      },
      required: ['forecast_id', 'generated_at'],
    },
    outputSchema: cacheEnvelope({ forecastCase: { type: 'object', properties: {
      status: { type: 'string', enum: ['ready', 'missing', 'unavailable', 'generation_changed'] },
      generatedAt: { type: ['number', 'string', 'null'] },
      forecast: { type: ['object', 'null'] },
    }, required: ['status', 'generatedAt', 'forecast'] } }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params, execution) => {
      if (execution?.panelScope !== 'forecasts' && execution?.perToolForecastRead !== true) throw new RpcValidationError('get_forecast_case', [{ field: 'panel_request', description: 'A verified forecast panel admission is required.' }]);
      const parsed = forecastCaseReadSchema.safeParse(params);
      if (!parsed.success) throw new RpcValidationError('get_forecast_case', [{ field: 'forecast_id', description: 'Provide an exact forecast ID and list generation.' }]);
      const source = data.predictions;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return { forecastCase: { status: 'unavailable', generatedAt: null, forecast: null } };
      const node = source as Record<string, unknown>;
      const generatedAt = typeof node.generatedAt === 'number' || typeof node.generatedAt === 'string' ? node.generatedAt : null;
      if (!Array.isArray(node.predictions) || generatedAt === null) return { forecastCase: { status: 'unavailable', generatedAt, forecast: null } };
      if (String(generatedAt) !== params.generated_at) return { forecastCase: { status: 'generation_changed', generatedAt, forecast: null } };
      const forecast = node.predictions.find(row => row && typeof row === 'object' && !Array.isArray(row) && row.id === params.forecast_id) ?? null;
      return { forecastCase: { status: forecast ? 'ready' : 'missing', generatedAt, forecast } };
    },
    _cacheKeys: ['forecast:predictions:v2'],
    _freshnessChecks: [{ key: 'seed-meta:forecast:predictions', maxStaleMin: 90 }],
    _apiPaths: ['GET /api/forecast/v1/get-forecasts'],
  },
  {
    name: 'get_forecast_scorecard',
    _validateArgs: params => { if (params.view === 'archive') forecastArchiveArguments(params); },
    title: 'Forecast accuracy scorecard',
    _outputBudgetBytes: 65536,
    description: forecastScorecardDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['summary', 'archive'], description: 'Summary by default, or resolved forecast archive.' },
        domain: { type: 'string', description: 'Exact forecast domain for archive rows.' },
        outcome: { type: 'string', enum: ['YES', 'NO', 'VOID'], description: 'Archive outcome filter.' },
        forecast_id: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact family ID; includes its trajectories.' },
        before: { type: ['number', 'string'], description: 'Exclusive resolvedAt timestamp in milliseconds, or the nextBefore continuation from the previous page.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum archive rows, default 25; output budget may shorten a page.' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      archive: { type: ['object', 'null'], properties: {
        generatedAt: { type: 'number' }, rollingWindowDays: { type: 'number' },
        stale: { type: 'boolean' },
        rows: { type: 'array', maxItems: 50, items: { type: 'object' } },
        nextBefore: { type: ['string', 'null'] },
      } },
      underAudit: {
        type: ['object', 'null'],
        description: 'Set while the accuracy record is under audit: the scores below are unreliable and must not be quoted as a verdict. Without a manual override, it clears once the headline is measurable and the scorecard is fresh.',
        properties: { since: { type: 'string' }, issue: { type: 'number' }, reason: { type: 'string' } },
      },
      scorecard: {
        type: ['object', 'null'],
        properties: {
          schemaVersion: { type: ['number', 'null'] },
          generatedAt: { type: ['number', 'null'] },
          rollingWindowDays: { type: ['number', 'null'] },
          methodology: { type: ['string', 'null'] },
          totals: { type: ['object', 'null'] },
          overall: { type: ['object', 'null'] },
          skill: { type: ['object', 'null'] },
          byDomain: { type: 'array', items: { type: 'object' } },
          byGenerationOrigin: { type: 'array', items: { type: 'object' } },
          calibration: { type: 'array', items: { type: 'object' } },
          vsMarketSkill: { type: ['object', 'null'] },
          publishedByDomain: { type: 'array', items: { type: 'object' } },
          uncertainty: { type: ['object', 'null'] },
          funnel: { type: ['object', 'null'] },
          receipts: { type: 'array', items: { type: 'object' } },
          familyOutcomes: { type: 'array', items: { type: 'object' } },
          horizonGrades: {
            type: ['object', 'null'],
            description: 'Point-in-time grades of the 24h/7d/30d projections, one row per curvesVersion and horizon. Projections are not probabilities: they come from fixed hand-set curves. A row carries brier and realizedRate only when measurable (minimums: forecast families with YES and NO outcomes); otherwise counts only.',
          },
        },
      },
      marketAlerts: {
        type: ['object', 'null'],
        properties: {
          generatedAt: { type: 'number' },
          windowHours: { type: 'number' },
          rollingWindowDays: { type: 'number' },
          methodology: { type: 'string' },
          byType: { type: 'array', items: { type: 'object', properties: {
            type: { type: 'string' }, scored: { type: 'number' }, hitRate: { type: 'number' }, baseN: { type: 'number' },
            baseHitRate: { type: 'number' }, pairedHitRate: { type: 'number' },
            medianLeadTimeMs: { type: 'number', description: 'Median over hits; omitted below 30 hits.' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // The seed-meta clock decides staleness, and a stale scorecard holds the audit (#8990).
    _cacheKeys: ['forecast:scorecard:v1', 'correlation:market-alerts:scorecard:v1', 'seed-meta:forecast:scorecard', 'forecast:archive:v1', 'seed-meta:forecast:archive'],
    _cacheLabels: { 'correlation:market-alerts:scorecard:v1': 'marketAlerts', 'seed-meta:forecast:scorecard': 'scorecardMeta', 'forecast:archive:v1': 'forecastArchive', 'seed-meta:forecast:archive': 'archiveMeta' },
    _project: (data) => ({ ...projectForecastScorecard(data), ...(data.forecastArchive ? { forecastArchive: projectForecastArchive(data.forecastArchive, data.archiveMeta) } : {}) }),
    _postFilter: filterForecastScorecard,
    _freshnessChecks: [{ key: 'seed-meta:forecast:scorecard', maxStaleMin: 2160 }],
    _apiPaths: [
      "GET /api/forecast/v1/get-forecast-scorecard",
    ],
  },

  // -------------------------------------------------------------------------
  // Social velocity — cache read (Reddit signals, seeded by relay)
  // -------------------------------------------------------------------------
  {
    name: 'get_social_velocity',
    title: 'Reddit geopolitical activity',
    _outputBudgetBytes: 131072,
    description: 'Return the 30 Reddit posts from r/worldnews and r/geopolitics with the highest velocityScore (log of score x upvote ratio x a 6-hour recency decay), each with title, subreddit, url (the Reddit permalink), score, upvoteRatio, numComments and createdAt. Measures what is drawing public attention on Reddit now, not what happened: posts are unverified user submissions with no classification or corroboration, there is no history beyond the current snapshot, and no other social platform is covered. Refreshed about every 3 hours, flagged stale after 9 hours. Seeded-cache read: weight 1 on API plans, included in the signed-in free allowance. subreddit keeps worldnews or geopolitics; limit caps the list (default 30, 0 for no cap).',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Keep one subreddit: "worldnews" or "geopolitics".' },
        limit: { type: 'number', description: 'Cap the post list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      reddit: {
        type: ['object', 'null'],
        properties: { posts: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, subreddit: { type: 'string' }, title: { type: 'string' },
          score: { type: ['number', 'null'] }, url: { type: 'string' }, createdAt: { type: ['string', 'number'] },
          upvoteRatio: { type: 'number' }, numComments: { type: 'number' }, velocityScore: { type: 'number' },
        } } }, fetchedAt: { type: 'number' } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const sub = argStr(params.subreddit);
      if (data.reddit != null) data.reddit = normalizeSocialVelocity(data.reddit);
      if (sub) narrowNested(data, 'reddit', 'posts', (p) => argStr(p.subreddit) === sub);
      capNested(data, 'reddit', 'posts', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['intelligence:social:reddit:v1'],
    // Mirrors api/health.js SEED_META.socialVelocity: the relay seeds every 3h.
    _freshnessChecks: [{ key: 'seed-meta:intelligence:social-reddit', maxStaleMin: 540 }],
    _apiPaths: [
      "GET /api/intelligence/v1/get-social-velocity",
    ],
  },

  {
    name: 'get_temporal_anomalies',
    title: 'Unusual event activity vs baseline',
    _outputBudgetBytes: 65536,
    description:
      'Temporal anomaly watch: current event counts vs day-of-week and seasonal baselines, scored by z-score severity. ' +
      'Surfaces where activity is statistically abnormal right now — news velocity, satellite fire detections, and other tracked ' +
      'streams are compared against 90-day Welford baselines keyed by weekday and month, so a Tuesday in July is only compared ' +
      'to prior Tuesdays in July. Each anomaly carries the observed count, expected baseline count, z-score, multiplier, and a ' +
      'severity band (medium >= 1.5σ, high >= 2σ, critical >= 3σ). Filter by stream type, region, or minimum severity. An empty ' +
      'anomaly list with fresh data means activity is within normal bounds — that is itself signal. Statistical deviations ' +
      'per stream only: no story content, no cross-domain alert rollup. Seeded-cache read: weight 1 on API plans, included in ' +
      'the signed-in free allowance.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter to one tracked stream type (e.g. "news", "satellite_fires"); see trackedTypes in the response for what is currently baselined.',
        },
        region: { type: 'string', description: 'Filter to one region label (case-insensitive exact match).' },
        min_severity: {
          type: 'string',
          enum: ['medium', 'high', 'critical'],
          description: 'Drop anomalies below this severity band.',
        },
        limit: { type: 'number', description: 'Cap the anomaly list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      snapshot: {
        type: ['object', 'null'],
        properties: {
          anomalies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' }, region: { type: 'string' },
                currentCount: { type: 'number' }, expectedCount: { type: 'number' },
                zScore: { type: 'number' }, severity: { type: 'string' },
                multiplier: { type: 'number' }, message: { type: 'string' },
              },
            },
          },
          trackedTypes: { type: 'array', items: { type: 'string' } },
          computedAt: { type: 'string' },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.type);
      const region = argStr(params.region);
      const minSeverity = argStr(params.min_severity);
      const severityRank: Record<string, number> = { medium: 1, high: 2, critical: 3 };
      const floor = minSeverity ? (severityRank[minSeverity] ?? 0) : 0;
      narrowNested(data, 'snapshot', 'anomalies', (a) => {
        if (type && String(a.type ?? '').toLowerCase() !== type) return false;
        if (region && String(a.region ?? '').toLowerCase() !== region) return false;
        if (floor && (severityRank[String(a.severity ?? '')] ?? 0) < floor) return false;
        return true;
      });
      capNested(data, 'snapshot', 'anomalies', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['temporal:anomalies:v1'],
    _cacheLabels: { 'temporal:anomalies:v1': 'snapshot' },
    // liveness 45min; content-age (newestItemAt vs maxContentAgeMin) is stamped
    // on the same key and evaluated by evaluateFreshness via honorContentAge.
    _freshnessChecks: [{ key: 'seed-meta:temporal:anomalies', maxStaleMin: 45, honorContentAge: true }],
    _apiPaths: [],
  },

  {
    name: 'get_test_site_seismicity',
    title: 'Nuclear test-site seismic activity',
    _outputBudgetBytes: 65536,
    description:
      'Nuclear test-site seismic monitor: USGS earthquakes near known test sites scored for proliferation concern. ' +
      'Watches seismic events within 100 km of the monitored nuclear test sites (Punggye-ri, Lop Nur, Novaya Zemlya, the ' +
      'Nevada National Security Site, Semipalatinsk, and other historical sites) and scores each event 0-100 from magnitude, ' +
      'proximity, and depth — shallow events close to a site score highest, since underground tests are shallow by nature. ' +
      'Concern bands: low, moderate, elevated, critical. Includes a per-site rollup (event count, max concern, max magnitude). ' +
      'An empty list with fresh data means no seismicity near any monitored site in the current feed window.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Filter to one test site by name substring (e.g. "Punggye", "Lop Nur", case-insensitive).' },
        min_concern: {
          type: 'string',
          enum: ['low', 'moderate', 'elevated', 'critical'],
          description: 'Drop events below this concern band.',
        },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      earthquakes: {
        type: ['object', 'null'],
        properties: {
          earthquakes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, place: { type: 'string' },
                magnitude: { type: 'number' }, depthKm: { type: 'number' },
                location: {
                  type: 'object',
                  properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
                },
                occurredAt: { type: 'number' },
                nearTestSite: { type: 'boolean' }, testSiteName: { type: 'string' },
                concernScore: { type: 'number' }, concernLevel: { type: 'string' },
              },
            },
          },
          siteSummary: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                site: { type: 'string' }, eventCount: { type: 'number' },
                maxConcernScore: { type: 'number' }, maxConcernLevel: { type: 'string' },
                maxMagnitude: { type: 'number' },
              },
            },
          },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const site = argStr(params.site);
      const minConcern = argStr(params.min_concern);
      const concernRank: Record<string, number> = { low: 1, moderate: 2, elevated: 3, critical: 4 };
      const floor = minConcern ? (concernRank[minConcern] ?? 0) : 0;
      narrowNested(data, 'earthquakes', 'earthquakes', (q) => {
        const siteName = typeof q.testSiteName === 'string' ? q.testSiteName : '';
        if (!q.nearTestSite && !siteName && typeof q.concernScore !== 'number') return false;
        if (site && !siteName.toLowerCase().includes(site)) return false;
        if (floor && (concernRank[String(q.concernLevel ?? '')] ?? 0) < floor) return false;
        return true;
      });
      const payload = data.earthquakes as {
        earthquakes?: Array<Record<string, unknown>>;
        siteSummary?: Array<Record<string, unknown>>;
      } | null;
      if (payload && Array.isArray(payload.earthquakes)) {
        const bySite = new Map<string, { site: string; eventCount: number; maxConcernScore: number; maxConcernLevel: string; maxMagnitude: number }>();
        for (const q of payload.earthquakes) {
          const name = (typeof q.testSiteName === 'string' && q.testSiteName) || 'Unattributed';
          const entry = bySite.get(name) ?? { site: name, eventCount: 0, maxConcernScore: 0, maxConcernLevel: '', maxMagnitude: 0 };
          entry.eventCount += 1;
          const score = typeof q.concernScore === 'number' ? q.concernScore : 0;
          if (score >= entry.maxConcernScore) {
            entry.maxConcernScore = score;
            entry.maxConcernLevel = typeof q.concernLevel === 'string' ? q.concernLevel : entry.maxConcernLevel;
          }
          const mag = typeof q.magnitude === 'number' ? q.magnitude : 0;
          if (mag > entry.maxMagnitude) entry.maxMagnitude = mag;
          bySite.set(name, entry);
        }
        payload.siteSummary = [...bySite.values()].sort((a, b) => b.maxConcernScore - a.maxConcernScore);
      }
      capNested(data, 'earthquakes', 'earthquakes', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['seismology:earthquakes:v1'],
    _cacheLabels: { 'seismology:earthquakes:v1': 'earthquakes' },
    _freshnessChecks: [{ key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 }],
    _apiPaths: [],
  },

];
