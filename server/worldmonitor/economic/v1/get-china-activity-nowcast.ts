import type {
  GetChinaActivityNowcastRequest,
  GetChinaActivityNowcastResponse,
  GetChinaMacroSnapshotResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import {
  CHINA_ACTIVITY_NOWCAST_METHOD_VERSION,
  evaluateChinaActivityNowcast,
  isChinaActivityNowcastUpstreamUnavailable,
  type ChinaActivityDirection,
  type ChinaActivityNowcastResponse,
  type ChinaActivityOfficialObservation,
  type ChinaActivityProxyObservation,
} from '../../../../shared/china-activity-nowcast';
import {
  CHINA_ENERGY_DEMAND_METRIC_KEYS,
  type ChinaCorridorControlTowerResponse,
  type CorridorSourceSignal,
} from '../../../../shared/china-corridor-control-towers';
import { chinaMacroObservationDateMs } from '../../../../shared/china-macro-contract.js';
import { cachedFetchJsonWithMeta, getCachedJsonBatch } from '../../../_shared/redis';
import { CHINA_ACTIVITY_NOWCAST_KEY } from '../../../_shared/cache-keys';
import { resolveChinaCorridorSnapshot } from '../../supply-chain/v1/get-china-corridor-control-towers';
import {
  compareChinaCorridorDirectionalSnapshots,
  createChinaCorridorDirectionalSnapshot,
  persistChinaCorridorDirectionalSnapshot,
  readChinaCorridorDirectionalHistory,
  selectPriorChinaCorridorDirectionalSnapshot,
  type ChinaCorridorDirectionalSnapshot,
} from './china-corridor-breadth-history';
import { getChinaMacroSnapshot } from './get-china-macro-snapshot';

export const CHINA_ACTIVITY_NOWCAST_CACHE_KEY =
  CHINA_ACTIVITY_NOWCAST_KEY;
export const CHINA_ACTIVITY_NOWCAST_TTL_SECONDS = 15 * 60;
// JODI China data can be reported several months after the observation month.
// The energy registry's 210-day freshness budget is the honest live comparison
// window; the generic evaluator keeps its narrower 90-day default for callers
// that do not opt into this source-specific production contract.
export const CHINA_ACTIVITY_NOWCAST_COMPARISON_WINDOW_DAYS = 210;
export const CHINA_ACTIVITY_NOWCAST_MARKET_KEYS = Object.freeze({
  commodities: 'market:commodities-bootstrap:v1',
  commoditiesMeta: 'seed-meta:market:commodities',
  stockIndex: 'market:stock-index:v1:CN',
});

type UnknownRecord = Record<string, unknown>;

export type ChinaActivityNowcastMarketBatchReader = (
  keys: string[],
  raw?: boolean,
) => Promise<Map<string, unknown>>;

export interface ChinaActivityNowcastDependencies {
  getMacro: () => Promise<GetChinaMacroSnapshotResponse>;
  getCorridors: () => Promise<ChinaCorridorControlTowerResponse>;
  readMarketBatch: ChinaActivityNowcastMarketBatchReader;
  readCorridorHistory?: () => Promise<ChinaCorridorDirectionalSnapshot[]>;
  persistCorridorSnapshot?: (
    current: ChinaCorridorDirectionalSnapshot,
  ) => Promise<boolean>;
}

export type ChinaActivityNowcastCache = (
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<ChinaActivityNowcastResponse | null>,
) => Promise<{
  data: ChinaActivityNowcastResponse | null;
  source: 'cache' | 'fresh' | 'skipped';
  leader: boolean;
}>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is UnknownRecord => item !== null)
    : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function officialObservations(
  macro: GetChinaMacroSnapshotResponse,
): ChinaActivityOfficialObservation[] {
  if (macro.unavailable) return [];
  return macro.indicators.flatMap((indicator): ChinaActivityOfficialObservation[] => {
    const periodEndMs = chinaMacroObservationDateMs(indicator.observationPeriod);
    const provenance = parseJsonObject(indicator.provenanceJson);
    if (
      indicator.category !== 'activity'
      || !indicator.hasValue
      || indicator.stale
      || periodEndMs === null
      || provenance === null
      || !['strengthening', 'weakening', 'unchanged'].includes(indicator.direction)
    ) return [];
    return [{
      seriesId: indicator.id,
      label: indicator.label,
      vintageId: indicator.vintageId,
      observationPeriod: indicator.observationPeriod,
      periodEnd: new Date(periodEndMs).toISOString(),
      releaseTime: indicator.releaseTime,
      retrievalTime: indicator.retrievalTime,
      direction: indicator.direction as ChinaActivityDirection,
      value: indicator.value,
      unit: indicator.unit,
      available: indicator.transportStatus === 'fresh',
      stale: indicator.stale,
      provenance,
    }];
  });
}

function uniqueSignals(
  corridors: ChinaCorridorControlTowerResponse,
  family: CorridorSourceSignal['family'],
): CorridorSourceSignal[] {
  const byId = new Map<string, CorridorSourceSignal>();
  for (const corridor of corridors.corridors) {
    const condition = corridor.conditions.find((item) => item.family === family);
    for (const signal of condition?.sourceSignals ?? []) {
      if (!byId.has(signal.id)) byId.set(signal.id, signal);
    }
  }
  return [...byId.values()];
}

interface ObservationTimes {
  observedAt: string;
  releasedAt: string;
  retrievedAt: string;
}

function aggregateTimes(
  signals: readonly CorridorSourceSignal[],
  evaluatedAt: string,
): ObservationTimes {
  const latest = (values: Array<string | null>) => {
    const sorted = values
    .map(timestamp)
    .filter((value): value is string => value !== null)
      .sort();
    return sorted[sorted.length - 1] ?? null;
  };
  const observedAt = latest(signals.map((signal) => signal.observationTime));
  const releasedAt = latest(signals.map((signal) => signal.releaseTime))
    ?? observedAt;
  const retrievedAt = latest(signals.map((signal) => signal.retrievalTime))
    ?? releasedAt;
  return {
    observedAt: observedAt ?? evaluatedAt,
    releasedAt: releasedAt ?? evaluatedAt,
    retrievedAt: retrievedAt ?? evaluatedAt,
  };
}

function corridorProvenance(
  signals: readonly CorridorSourceSignal[],
  extra: UnknownRecord = {},
): UnknownRecord {
  return {
    sourceSignalIds: signals.map((signal) => signal.id),
    publishers: signals.map((signal) => signal.publisher),
    sourceUrls: [...new Set(signals.map((signal) => signal.sourceUrl).filter(Boolean))],
    observationTimes: signals.map((signal) => signal.observationTime),
    ...extra,
  };
}

function corridorObservation(input: {
  evaluatedAt: string;
  seriesId: string;
  observationId: string;
  signals: CorridorSourceSignal[];
  value: number | null;
  provenance?: UnknownRecord;
  times?: ObservationTimes;
}): ChinaActivityProxyObservation {
  const times = input.times ?? aggregateTimes(input.signals, input.evaluatedAt);
  const stale = input.signals.some((signal) =>
    signal.availability === 'stale'
    || signal.transportFreshness === 'stale'
    || signal.contentFreshness === 'stale');
  return {
    seriesId: input.seriesId,
    observationId: input.observationId,
    ...times,
    value: input.value,
    priorValue: null,
    available: input.signals.some((signal) => signal.availability === 'available'),
    stale,
    structuralBreak: false,
    provenance: input.provenance ?? corridorProvenance(input.signals),
  };
}

function metricString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function metricStringArray(value: unknown): string[] | null {
  const serialized = metricString(value);
  if (serialized === null) return null;
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return null;
    const values = [...new Set(parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim()))].sort();
    return values.length === parsed.length ? values : null;
  } catch {
    return null;
  }
}

// The reviewed comparison, pinned independently of the Railway seeder that
// writes it (the runtimes share no code). `tests/china-energy-demand-change-
// parity.test.mts` asserts the literals stay equal across the boundary.
const ENERGY_DEMAND_CHANGE_BASIS = 'year_over_year';
const ENERGY_DEMAND_CHANGE_UNIT = '% change';
const ENERGY_DEMAND_CHANGE_LOOKBACK_MONTHS = 12;
const MIN_DEMAND_CHANGE_PRODUCTS = 3;
const MAX_DEMAND_CHANGE_PRODUCTS = 5;
const MAX_DEMAND_CHANGE_PERCENT = 50;

function observationMonthIndex(value: string | null): number | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? '');
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function monthPeriodEnd(value: string | null): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? '');
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 1) - 1).toISOString();
}

interface PublishedEnergyDemandChange {
  percentChange: number;
  basis: string;
  unit: string;
  observationPeriod: string;
  priorObservationPeriod: string;
  priorPeriodEnd: string;
  products: string[];
  productCount: number;
  currentDemandKbd: number;
  priorDemandKbd: number;
  signalId: string;
  times: ObservationTimes;
}

/**
 * Read an explicitly published directional demand change off the reviewed
 * energy condition.
 *
 * Every part of the change must be present: a finite percentage, the basis it
 * was computed on, its own period end, and a period label. Source-availability
 * coverage booleans carry none of those, so they can never satisfy this and can
 * never become a zero or a neutral contribution.
 */
function publishedEnergyDemandChange(
  signals: readonly CorridorSourceSignal[],
  evaluatedAt: string,
): PublishedEnergyDemandChange | null {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const keys = CHINA_ENERGY_DEMAND_METRIC_KEYS;
  for (const signal of signals) {
    const percentChange = finiteNumber(signal.metrics[keys.percent]);
    const observationPeriod = metricString(signal.metrics[keys.currentMonth]);
    const priorObservationPeriod = metricString(signal.metrics[keys.priorMonth]);
    const periodEnd = timestamp(metricString(signal.metrics[keys.changePeriodEnd]));
    const priorPeriodEnd = timestamp(metricString(signal.metrics[keys.changePriorPeriodEnd]));
    const currentPeriodIndex = observationMonthIndex(observationPeriod);
    const priorPeriodIndex = observationMonthIndex(priorObservationPeriod);
    const expectedPeriodEnd = monthPeriodEnd(observationPeriod);
    const expectedPriorPeriodEnd = monthPeriodEnd(priorObservationPeriod);
    const products = metricStringArray(signal.metrics[keys.products]);
    const productCount = finiteNumber(signal.metrics[keys.productCount]);
    const currentDemandKbd = finiteNumber(signal.metrics[keys.currentDemandKbd]);
    const priorDemandKbd = finiteNumber(signal.metrics[keys.priorDemandKbd]);
    const expectedPercentChange = currentDemandKbd !== null
      && priorDemandKbd !== null
      && priorDemandKbd > 0
      ? ((currentDemandKbd - priorDemandKbd) / priorDemandKbd) * 100
      : null;
    const percentTolerance = expectedPercentChange === null
      ? null
      : 1e-9 * Math.max(1, Math.abs(expectedPercentChange), Math.abs(percentChange ?? 0));
    const arithmeticMatches = percentChange !== null
      && expectedPercentChange !== null
      && percentTolerance !== null
      && Math.abs(expectedPercentChange - percentChange) <= percentTolerance;
    // Pin the reviewed basis here too: the corridor payload crosses a cache
    // this runtime does not own, and a seasonal comparison must not be read as
    // an activity direction just because it arrived in the right field.
    if (
      percentChange === null
      || signal.metrics[keys.basis] !== ENERGY_DEMAND_CHANGE_BASIS
      || signal.metrics[keys.unit] !== ENERGY_DEMAND_CHANGE_UNIT
      || observationPeriod === null
      || priorObservationPeriod === null
      || periodEnd === null
      || priorPeriodEnd === null
      || currentPeriodIndex === null
      || priorPeriodIndex === null
      || currentPeriodIndex - priorPeriodIndex !== ENERGY_DEMAND_CHANGE_LOOKBACK_MONTHS
      || expectedPeriodEnd === null
      || expectedPriorPeriodEnd === null
      || Date.parse(periodEnd) !== Date.parse(expectedPeriodEnd)
      || Date.parse(priorPeriodEnd) !== Date.parse(expectedPriorPeriodEnd)
      || products === null
      || productCount === null
      || !Number.isInteger(productCount)
      || productCount < MIN_DEMAND_CHANGE_PRODUCTS
      || productCount > MAX_DEMAND_CHANGE_PRODUCTS
      || products.length !== productCount
      || currentDemandKbd === null
      || currentDemandKbd < 0
      || priorDemandKbd === null
      || priorDemandKbd <= 0
      || !arithmeticMatches
      || Math.abs(percentChange) > MAX_DEMAND_CHANGE_PERCENT
      || Date.parse(priorPeriodEnd) >= Date.parse(periodEnd)
    ) continue;
    const times = energyObservationTimes(signal, periodEnd, evaluatedAtMs);
    if (times === null) continue;
    return {
      percentChange,
      basis: ENERGY_DEMAND_CHANGE_BASIS,
      unit: ENERGY_DEMAND_CHANGE_UNIT,
      observationPeriod,
      priorObservationPeriod,
      priorPeriodEnd,
      products,
      productCount,
      currentDemandKbd,
      priorDemandKbd,
      signalId: signal.id,
      times,
    };
  }
  return null;
}

/**
 * Times for the "no change published" observation, anchored to the period the
 * demand series covers rather than the family's latest coverage timestamp.
 *
 * Without this the registry's 30-day publication lag would be measured against
 * an unrelated clock, so a series that published nothing at all would be
 * reported as `lag_not_elapsed` ("not due yet") whenever any energy source
 * happened to be fresh. Anchored here, both exclusion reasons are true:
 * `lag_not_elapsed` means this month's change is genuinely not due, and
 * `missing_directional_value` means it was due and was not published.
 */
function unpublishedEnergyDemandTimes(
  signals: readonly CorridorSourceSignal[],
  evaluatedAt: string,
): ObservationTimes | null {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  for (const signal of signals) {
    const periodEnd = timestamp(
      metricString(signal.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.periodEnd]),
    );
    if (periodEnd === null) continue;
    const times = energyObservationTimes(signal, periodEnd, evaluatedAtMs);
    if (times !== null) return times;
  }
  return null;
}

/**
 * Anchor an energy observation to a period end, keeping the release and
 * retrieval envelope coherent.
 *
 * A snapshot with no retrieval timestamp is not dated "retrieved now" — that
 * would manufacture freshness the source never claimed — so it yields no times
 * and the caller falls back to refusing the value.
 */
function energyObservationTimes(
  signal: CorridorSourceSignal,
  periodEnd: string,
  evaluatedAtMs: number,
): ObservationTimes | null {
  const retrievedAt = timestamp(signal.retrievalTime);
  if (retrievedAt === null) return null;
  const releasedAt = timestamp(signal.releaseTime) ?? retrievedAt;
  // An observation cannot be released before the period it measures ended, nor
  // retrieved before release, nor retrieved after the evaluation instant.
  return (
    Date.parse(periodEnd) <= Date.parse(releasedAt)
    && Date.parse(releasedAt) <= Date.parse(retrievedAt)
    && Date.parse(retrievedAt) <= evaluatedAtMs
  )
    ? { observedAt: periodEnd, releasedAt, retrievedAt }
    : null;
}

function corridorProxyObservations(
  corridors: ChinaCorridorControlTowerResponse,
  evaluatedAt: string,
  priorCorridorSnapshot: ChinaCorridorDirectionalSnapshot | null,
  corridorHistoryReadFailed: boolean,
): ChinaActivityProxyObservation[] {
  if (corridors.corridors.length === 0) return [];
  const observations: ChinaActivityProxyObservation[] = [];

  const portSignals = uniqueSignals(corridors, 'port');
  const trendDeltas = portSignals
    .map((signal) => finiteNumber(signal.metrics.trendDelta))
    .filter((value): value is number => value !== null);
  observations.push(corridorObservation({
    evaluatedAt,
    seriesId: 'portwatch_tanker_calls_trend',
    observationId: `portwatch-trend:${corridors.generatedAt}`,
    signals: portSignals,
    value: trendDeltas.length === 0
      ? null
      : trendDeltas.reduce((sum, value) => sum + value, 0) / trendDeltas.length,
    provenance: corridorProvenance(portSignals, {
      reviewedSignalCount: portSignals.length,
      directionalSignalCount: trendDeltas.length,
      aggregation: 'arithmetic_mean_of_finite_trend_delta',
    }),
  }));

  const aviationSignals = uniqueSignals(corridors, 'aviation');
  const statuses = aviationSignals
    .map((signal) => signal.metrics.providerStatus)
    .filter((value): value is string => value === 'normal' || value === 'disruption');
  const aviationBalance = statuses.length === 0
    ? null
    : (
      statuses.filter((value) => value === 'normal').length
      - statuses.filter((value) => value === 'disruption').length
    ) / statuses.length;
  observations.push(corridorObservation({
    evaluatedAt,
    seriesId: 'aviation_hub_disruption_balance',
    observationId: `aviation-balance:${corridors.generatedAt}`,
    signals: aviationSignals,
    value: aviationBalance,
    provenance: corridorProvenance(aviationSignals, {
      reviewedSignalCount: aviationSignals.length,
      directionalSignalCount: statuses.length,
      aggregation: 'normal_share_minus_disruption_share',
    }),
  }));

  const tradeSignals = uniqueSignals(corridors, 'trade');
  const ccfi = tradeSignals.find((signal) =>
    signal.selectorId === 'supply_chain:shipping:v2:CCFI'
    || signal.id.startsWith('signal:ccfi:'));
  if (ccfi) {
    // Only a proven period-over-period move counts (#6066) — the exchange's own
    // percentage, or the change between two levels it published. The current
    // level and the legacy fabricable `changePct` are never read, so a level
    // cannot be reinterpreted as a change or a neutral contribution.
    const periodChange = finiteNumber(ccfi.metrics.periodChangePct);
    // Each way of having no change gets its own name. A signal that never
    // arrived, one that arrived but is no longer timely, and one that arrived
    // timely with a level but no comparable prior are three different facts;
    // collapsing them would overstate what the source actually published.
    const ccfiFreshnessStale = ccfi.availability === 'stale'
      || ccfi.transportFreshness === 'stale'
      || ccfi.contentFreshness === 'stale';
    const exclusion = periodChange !== null
      ? null
      : ccfi.availability === 'unavailable'
        ? 'source_signal_unavailable'
        : ccfiFreshnessStale
          ? 'source_signal_stale'
          : 'missing_comparable_prior';
    observations.push(corridorObservation({
      evaluatedAt,
      seriesId: 'ccfi_freight_rate_change',
      observationId: `ccfi-change:${corridors.generatedAt}`,
      signals: [ccfi],
      value: periodChange,
      provenance: corridorProvenance([ccfi], {
        currentLevel: finiteNumber(ccfi.metrics.currentValue),
        priorPeriodLevel: finiteNumber(ccfi.metrics.priorPeriodValue),
        priorPeriodDate: typeof ccfi.metrics.priorPeriodDate === 'string'
          ? ccfi.metrics.priorPeriodDate
          : null,
        periodChangeBasis: typeof ccfi.metrics.periodChangeBasis === 'string'
          ? ccfi.metrics.periodChangeBasis
          : null,
        ...(exclusion === null ? {} : { exclusion }),
      }),
    }));
  }

  const energySignals = uniqueSignals(corridors, 'power_energy');
  const energyChange = publishedEnergyDemandChange(energySignals, evaluatedAt);
  // Both branches are dated by the demand series' OWN period, so the registry's
  // publication-lag rule is measured against the right clock whether or not a
  // change was published. With no demand period at all there is no observation
  // of this series to make — borrowing the family's coverage clock would report
  // a pending lag for a value that was never going to arrive.
  const energyTimes = energyChange?.times
    ?? unpublishedEnergyDemandTimes(energySignals, evaluatedAt);
  if (energySignals.length > 0 && energyTimes !== null) {
    observations.push(corridorObservation({
      evaluatedAt,
      seriesId: 'china_energy_demand_change',
      observationId: `energy-demand-change:${energyChange?.observationPeriod ?? corridors.generatedAt}`,
      signals: energySignals,
      // Coverage flags prove data presence, not direction.
      value: energyChange?.percentChange ?? null,
      times: energyTimes,
      provenance: corridorProvenance(energySignals, energyChange === null
        ? { exclusion: 'directional_demand_change_not_published' }
        : {
          demandChangeBasis: energyChange.basis,
          demandChangeUnit: energyChange.unit,
          observationPeriod: energyChange.observationPeriod,
          priorObservationPeriod: energyChange.priorObservationPeriod,
          periodEnd: energyChange.times.observedAt,
          priorPeriodEnd: energyChange.priorPeriodEnd,
          products: energyChange.products,
          productCount: energyChange.productCount,
          currentDemandKbd: energyChange.currentDemandKbd,
          priorDemandKbd: energyChange.priorDemandKbd,
          directionalSignalId: energyChange.signalId,
        }),
    }));
  }

  const currentCorridorSnapshot = createChinaCorridorDirectionalSnapshot(corridors);
  const breadth = currentCorridorSnapshot === null
    ? {
      value: null,
      priorValue: null,
      exclusion: 'directional_observations_not_available' as const,
    }
    : corridorHistoryReadFailed
      ? {
        value: null,
        priorValue: null,
        exclusion: 'corridor_history_read_failed' as const,
      }
    : compareChinaCorridorDirectionalSnapshots(
      currentCorridorSnapshot,
      priorCorridorSnapshot,
    );
  observations.push({
    seriesId: 'corridor_activity_breadth_change',
    observationId: `corridor-breadth-change:${corridors.generatedAt}`,
    observedAt: corridors.generatedAt,
    releasedAt: corridors.generatedAt,
    retrievedAt: corridors.generatedAt,
    value: breadth.value,
    priorValue: breadth.priorValue,
    available: true,
    stale: false,
    structuralBreak: false,
    provenance: {
      corridorIds: currentCorridorSnapshot?.corridorIds
        ?? corridors.corridors.map((corridor) => corridor.id).sort(),
      familyKeys: currentCorridorSnapshot?.familyKeys ?? [],
      generatedAt: corridors.generatedAt,
      ...(priorCorridorSnapshot === null ? {} : {
        priorGeneratedAt: priorCorridorSnapshot.generatedAt,
      }),
      directionalFamilies: currentCorridorSnapshot?.directionalFamilies ?? [],
      priorDirectionalFamilies: priorCorridorSnapshot?.directionalFamilies ?? [],
      directionalSelectorKeys: currentCorridorSnapshot?.directionalSelectorKeys ?? [],
      priorDirectionalSelectorKeys: priorCorridorSnapshot?.directionalSelectorKeys ?? [],
      directionalFamilyCount: currentCorridorSnapshot?.directionalFamilies.length ?? 0,
      priorDirectionalFamilyCount: priorCorridorSnapshot?.directionalFamilies.length ?? 0,
      strengtheningFamilies: currentCorridorSnapshot?.strengtheningFamilies ?? [],
      priorStrengtheningFamilies: priorCorridorSnapshot?.strengtheningFamilies ?? [],
      weakeningFamilies: currentCorridorSnapshot?.weakeningFamilies ?? [],
      priorWeakeningFamilies: priorCorridorSnapshot?.weakeningFamilies ?? [],
      activityBreadthValue: currentCorridorSnapshot === null
        ? null
        : currentCorridorSnapshot.strengtheningFamilies.length
          - currentCorridorSnapshot.weakeningFamilies.length,
      priorActivityBreadthValue: priorCorridorSnapshot === null
        ? null
        : priorCorridorSnapshot.strengtheningFamilies.length
          - priorCorridorSnapshot.weakeningFamilies.length,
      ...(breadth.exclusion === null
        ? { aggregation: 'signed_activity_family_count_change' }
        : { exclusion: breadth.exclusion }),
    },
  });
  return observations;
}

function marketProxyObservations(
  marketValues: Map<string, unknown>,
): ChinaActivityProxyObservation[] {
  const observations: ChinaActivityProxyObservation[] = [];
  const commodities = record(marketValues.get(CHINA_ACTIVITY_NOWCAST_MARKET_KEYS.commodities));
  const commoditiesMeta = record(
    marketValues.get(CHINA_ACTIVITY_NOWCAST_MARKET_KEYS.commoditiesMeta),
  );
  const commodityObservedAt = timestamp(commoditiesMeta?.fetchedAt);
  const reviewedQuotes = records(commodities?.quotes).filter((quote) =>
    quote.symbol === 'HG=F' || quote.symbol === 'ALI=F');
  const commodityChanges = reviewedQuotes
    .map((quote) => finiteNumber(quote.change))
    .filter((value): value is number => value !== null);
  if (commodityObservedAt !== null) {
    observations.push({
      seriesId: 'china_input_commodity_change',
      observationId: `china-input-commodities:${commodityObservedAt}`,
      observedAt: commodityObservedAt,
      releasedAt: commodityObservedAt,
      retrievedAt: commodityObservedAt,
      value: commodityChanges.length === 0
        ? null
        : commodityChanges.reduce((sum, value) => sum + value, 0) / commodityChanges.length,
      priorValue: null,
      available: commodityChanges.length > 0,
      stale: false,
      structuralBreak: false,
      provenance: {
        symbols: reviewedQuotes.map((quote) => quote.symbol),
        publisherId: 'publisher:alphavantage-yahoo',
        seedMetaFetchedAt: commodityObservedAt,
        aggregation: 'arithmetic_mean_of_finite_percentage_changes',
      },
    });
  }

  const stockIndex = record(marketValues.get(CHINA_ACTIVITY_NOWCAST_MARKET_KEYS.stockIndex));
  const stockObservedAt = timestamp(stockIndex?.fetchedAt);
  if (stockObservedAt !== null) {
    observations.push({
      seriesId: 'sse_composite_week_change',
      observationId: `sse-composite-week-change:${stockObservedAt}`,
      observedAt: stockObservedAt,
      releasedAt: stockObservedAt,
      retrievedAt: stockObservedAt,
      value: finiteNumber(stockIndex?.weekChangePercent),
      priorValue: null,
      available: stockIndex?.available === true && stockIndex?.code === 'CN',
      stale: false,
      structuralBreak: false,
      provenance: {
        publisherId: 'publisher:yahoo-finance',
        symbol: stockIndex?.symbol,
        fetchedAt: stockObservedAt,
      },
    });
  }
  return observations;
}

export function buildChinaActivityNowcastInputs(input: {
  evaluatedAt: string;
  macro: GetChinaMacroSnapshotResponse;
  corridors: ChinaCorridorControlTowerResponse;
  marketValues: Map<string, unknown>;
  priorCorridorSnapshot?: ChinaCorridorDirectionalSnapshot | null;
  corridorHistoryReadFailed?: boolean;
}): {
  officialObservations: ChinaActivityOfficialObservation[];
  proxyObservations: ChinaActivityProxyObservation[];
} {
  return {
    officialObservations: officialObservations(input.macro),
    proxyObservations: [
      ...corridorProxyObservations(
        input.corridors,
        input.evaluatedAt,
        input.priorCorridorSnapshot ?? null,
        input.corridorHistoryReadFailed ?? false,
      ),
      ...marketProxyObservations(input.marketValues),
    ],
  };
}

function unavailableMacro(evaluatedAt: string): GetChinaMacroSnapshotResponse {
  return {
    countryCode: 'CN',
    generatedAt: evaluatedAt,
    status: 'unavailable',
    launchReady: false,
    contentObservationDate: '',
    latestObservationDate: '',
    indicators: [],
    sourceDecisions: [],
    releaseEvents: [],
    unavailable: true,
    schemaVersion: 2,
    pillars: [],
  };
}

function unavailableCorridors(evaluatedAt: string): ChinaCorridorControlTowerResponse {
  return { generatedAt: evaluatedAt, corridors: [] };
}

export async function composeChinaActivityNowcastSnapshot(
  evaluatedAt: string,
  dependencies: ChinaActivityNowcastDependencies,
): Promise<ChinaActivityNowcastResponse> {
  const [macroResult, corridorsResult, marketResult, corridorHistoryResult] =
    await Promise.allSettled([
    dependencies.getMacro(),
    dependencies.getCorridors(),
    dependencies.readMarketBatch(
      Object.values(CHINA_ACTIVITY_NOWCAST_MARKET_KEYS),
      true,
    ),
    dependencies.readCorridorHistory?.() ?? Promise.resolve([]),
  ]);
  const corridors = corridorsResult.status === 'fulfilled'
    ? corridorsResult.value
    : unavailableCorridors(evaluatedAt);
  const corridorHistory = corridorHistoryResult.status === 'fulfilled'
    ? corridorHistoryResult.value
    : [];
  const currentCorridorSnapshot = createChinaCorridorDirectionalSnapshot(corridors);
  const priorCorridorSnapshot = currentCorridorSnapshot === null
    ? null
    : selectPriorChinaCorridorDirectionalSnapshot(
      currentCorridorSnapshot,
      corridorHistory,
    );
  const inputs = buildChinaActivityNowcastInputs({
    evaluatedAt,
    macro: macroResult.status === 'fulfilled'
      ? macroResult.value
      : unavailableMacro(evaluatedAt),
    corridors,
    marketValues: marketResult.status === 'fulfilled'
      ? marketResult.value
      : new Map(),
    priorCorridorSnapshot,
    corridorHistoryReadFailed: corridorHistoryResult.status === 'rejected',
  });
  const response = evaluateChinaActivityNowcast({
    evaluatedAt,
    comparisonWindowDays: CHINA_ACTIVITY_NOWCAST_COMPARISON_WINDOW_DAYS,
    officialObservations: inputs.officialObservations,
    proxyObservations: inputs.proxyObservations,
  });
  if (
    currentCorridorSnapshot !== null
    && corridorHistoryResult.status === 'fulfilled'
    && dependencies.persistCorridorSnapshot
  ) {
    try {
      await dependencies.persistCorridorSnapshot(
        currentCorridorSnapshot,
      );
    } catch {
      // Persistence is evidence for the next run. A write failure must keep the
      // current response fail-closed, not turn an otherwise valid nowcast into
      // an upstream outage.
    }
  }
  return response;
}

function insufficientChinaActivityNowcast(
  evaluatedAt: string,
): ChinaActivityNowcastResponse {
  return evaluateChinaActivityNowcast({
    evaluatedAt,
    officialObservations: [],
    proxyObservations: [],
  });
}

const defaultDependencies = (
  evaluatedAt: string,
  ctx: ServerContext,
): ChinaActivityNowcastDependencies => ({
  getMacro: () => getChinaMacroSnapshot(ctx, {}),
  getCorridors: () => resolveChinaCorridorSnapshot(evaluatedAt),
  readMarketBatch: getCachedJsonBatch,
  readCorridorHistory: readChinaCorridorDirectionalHistory,
  persistCorridorSnapshot: persistChinaCorridorDirectionalSnapshot,
});

const defaultCache: ChinaActivityNowcastCache =
  (key, ttlSeconds, fetcher) => cachedFetchJsonWithMeta(key, ttlSeconds, fetcher);

export async function resolveChinaActivityNowcastSnapshot(
  evaluatedAt: string,
  dependencies: ChinaActivityNowcastDependencies,
  cache: ChinaActivityNowcastCache = defaultCache,
): Promise<ChinaActivityNowcastResponse> {
  let insufficientCacheMiss: ChinaActivityNowcastResponse | null = null;
  try {
    const cached = await cache(
      CHINA_ACTIVITY_NOWCAST_CACHE_KEY,
      CHINA_ACTIVITY_NOWCAST_TTL_SECONDS,
      async () => {
        const composed = await composeChinaActivityNowcastSnapshot(evaluatedAt, dependencies);
        if (composed.state === 'insufficient_data') {
          insufficientCacheMiss = composed;
          return null;
        }
        return composed;
      },
    );
    if (cached.data !== null) return cached.data;
  } catch {
    // Cache transport failures never become a positive state.
  }
  if (insufficientCacheMiss !== null) return insufficientCacheMiss;
  // A null cache result can be a Redis NEG_SENTINEL hit. Do not recompose: that
  // would reread and rewrite corridor history on every request in the negative
  // cache window. The empty response is deliberately fail-closed.
  return insufficientChinaActivityNowcast(evaluatedAt);
}

export function projectChinaActivityNowcastWireResponse(
  response: ChinaActivityNowcastResponse,
): GetChinaActivityNowcastResponse {
  return {
    generatedAt: response.evaluatedAt,
    methodVersion: response.methodVersion,
    comparisonState: response.state,
    upstreamUnavailable: isChinaActivityNowcastUpstreamUnavailable(response),
    payloadJson: JSON.stringify(response),
  };
}

export async function getChinaActivityNowcast(
  ctx: ServerContext,
  _req: GetChinaActivityNowcastRequest,
): Promise<GetChinaActivityNowcastResponse> {
  const evaluatedAt = new Date().toISOString();
  try {
    return projectChinaActivityNowcastWireResponse(
      await resolveChinaActivityNowcastSnapshot(
        evaluatedAt,
        defaultDependencies(evaluatedAt, ctx),
      ),
    );
  } catch {
    return projectChinaActivityNowcastWireResponse(
      insufficientChinaActivityNowcast(evaluatedAt),
    );
  }
}

export { CHINA_ACTIVITY_NOWCAST_METHOD_VERSION };
