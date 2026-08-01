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
import type {
  ChinaCorridorControlTowerResponse,
  CorridorSourceSignal,
} from '../../../../shared/china-corridor-control-towers';
import { chinaMacroObservationDateMs } from '../../../../shared/china-macro-contract.js';
import { cachedFetchJson, getCachedJsonBatch } from '../../../_shared/redis';
import { CHINA_ACTIVITY_NOWCAST_KEY } from '../../../_shared/cache-keys';
import { resolveChinaCorridorSnapshot } from '../../supply-chain/v1/get-china-corridor-control-towers';
import { getChinaMacroSnapshot } from './get-china-macro-snapshot';

export const CHINA_ACTIVITY_NOWCAST_CACHE_KEY =
  CHINA_ACTIVITY_NOWCAST_KEY;
export const CHINA_ACTIVITY_NOWCAST_TTL_SECONDS = 15 * 60;
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
}

export type ChinaActivityNowcastCache = (
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<ChinaActivityNowcastResponse | null>,
) => Promise<ChinaActivityNowcastResponse | null>;

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

function aggregateTimes(signals: readonly CorridorSourceSignal[], evaluatedAt: string) {
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
}): ChinaActivityProxyObservation {
  const times = aggregateTimes(input.signals, input.evaluatedAt);
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

function corridorProxyObservations(
  corridors: ChinaCorridorControlTowerResponse,
  evaluatedAt: string,
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
    observations.push(corridorObservation({
      evaluatedAt,
      seriesId: 'ccfi_freight_rate_change',
      observationId: `ccfi-change:${corridors.generatedAt}`,
      signals: [ccfi],
      // #5578 currently publishes the current level only. A level must not be
      // reinterpreted as a change or a neutral contribution.
      value: null,
      provenance: corridorProvenance([ccfi], {
        currentLevel: finiteNumber(ccfi.metrics.currentValue),
        exclusion: 'period_change_not_published',
      }),
    }));
  }

  const energySignals = uniqueSignals(corridors, 'power_energy');
  if (energySignals.length > 0) {
    observations.push(corridorObservation({
      evaluatedAt,
      seriesId: 'china_energy_demand_change',
      observationId: `energy-demand-change:${corridors.generatedAt}`,
      signals: energySignals,
      // Coverage flags prove data presence, not direction.
      value: null,
      provenance: corridorProvenance(energySignals, {
        exclusion: 'directional_demand_change_not_published',
      }),
    }));
  }

  observations.push({
    seriesId: 'corridor_activity_breadth_change',
    observationId: `corridor-breadth-change:${corridors.generatedAt}`,
    observedAt: corridors.generatedAt,
    releasedAt: corridors.generatedAt,
    retrievedAt: corridors.generatedAt,
    // One snapshot has no comparable prior. Availability breadth must not be
    // flattened into an activity change.
    value: null,
    priorValue: null,
    available: true,
    stale: false,
    structuralBreak: false,
    provenance: {
      corridorIds: corridors.corridors.map((corridor) => corridor.id),
      generatedAt: corridors.generatedAt,
      exclusion: 'comparable_prior_snapshot_not_available',
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
}): {
  officialObservations: ChinaActivityOfficialObservation[];
  proxyObservations: ChinaActivityProxyObservation[];
} {
  return {
    officialObservations: officialObservations(input.macro),
    proxyObservations: [
      ...corridorProxyObservations(input.corridors, input.evaluatedAt),
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
  const [macroResult, corridorsResult, marketResult] = await Promise.allSettled([
    dependencies.getMacro(),
    dependencies.getCorridors(),
    dependencies.readMarketBatch(
      Object.values(CHINA_ACTIVITY_NOWCAST_MARKET_KEYS),
      true,
    ),
  ]);
  const inputs = buildChinaActivityNowcastInputs({
    evaluatedAt,
    macro: macroResult.status === 'fulfilled'
      ? macroResult.value
      : unavailableMacro(evaluatedAt),
    corridors: corridorsResult.status === 'fulfilled'
      ? corridorsResult.value
      : unavailableCorridors(evaluatedAt),
    marketValues: marketResult.status === 'fulfilled'
      ? marketResult.value
      : new Map(),
  });
  return evaluateChinaActivityNowcast({
    evaluatedAt,
    officialObservations: inputs.officialObservations,
    proxyObservations: inputs.proxyObservations,
  });
}

const defaultDependencies = (
  evaluatedAt: string,
  ctx: ServerContext,
): ChinaActivityNowcastDependencies => ({
  getMacro: () => getChinaMacroSnapshot(ctx, {}),
  getCorridors: () => resolveChinaCorridorSnapshot(evaluatedAt),
  readMarketBatch: getCachedJsonBatch,
});

const defaultCache: ChinaActivityNowcastCache =
  (key, ttlSeconds, fetcher) => cachedFetchJson(key, ttlSeconds, fetcher);

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
    if (cached !== null) return cached;
  } catch {
    // Recompose below so cache transport failures never become a positive state.
  }
  if (insufficientCacheMiss !== null) return insufficientCacheMiss;
  return composeChinaActivityNowcastSnapshot(evaluatedAt, dependencies);
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
      evaluateChinaActivityNowcast({
        evaluatedAt,
        officialObservations: [],
        proxyObservations: [],
      }),
    );
  }
}

export { CHINA_ACTIVITY_NOWCAST_METHOD_VERSION };
