import type {
  GetResilienceIndicatorsRequest,
  GetResilienceIndicatorsResponse,
  ResilienceIndicator,
  ResilienceIndicatorRawValue,
  ResilienceIndicatorSource,
  ResilienceServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import {
  RESILIENCE_SCHEMA_V2_ENABLED,
  RESILIENCE_STATIC_META_KEY,
  ensureResilienceScoreGenerationCached,
  getCurrentCacheFormula,
  toResilienceDataVersion,
  type CacheFormulaTag,
  type ResilienceConstructVersions,
} from './_shared';
import { getConstructVersions } from './get-resilience-runtime-manifest';
import {
  scoreAllDimensions,
  strictResilienceSeedReader,
  type ResilienceDimensionId,
  type ResilienceDimensionScore,
  type ResilienceSeedReader,
} from './_dimension-scorers';
import {
  createIndicatorTraceCollector,
  materializeIndicatorTrace,
  type IndicatorTraceRow,
  type ResilienceIndicatorTraceSnapshot,
} from './_indicator-trace';
import {
  decideIndicatorRawRedistribution,
  getIndicatorSourcePolicy,
  getObservedSourceDisplayMetadata,
} from './_indicator-source-policy';

export const RESILIENCE_INDICATOR_METHODOLOGY = 'score-generation-trace-v1';
const RESILIENCE_INDICATOR_CACHE_TTL_SECONDS = 300;
const RESILIENCE_INDICATOR_NEGATIVE_TTL_SECONDS = 120;

type Clock = () => Date;
type StaticMetaReader = () => Promise<unknown>;

export interface ResilienceIndicatorHandlerDependencies {
  reader?: ResilienceSeedReader;
  now?: Clock;
  readStaticMeta?: StaticMetaReader;
  responseCache?: null | ((
    key: string,
    fetcher: () => Promise<GetResilienceIndicatorsResponse>,
  ) => Promise<GetResilienceIndicatorsResponse | null>);
}

export function cacheResilienceIndicatorResponse(
  key: string,
  fetcher: () => Promise<GetResilienceIndicatorsResponse>,
): Promise<GetResilienceIndicatorsResponse | null> {
  return cachedFetchJson(
    key,
    RESILIENCE_INDICATOR_CACHE_TTL_SECONDS,
    fetcher,
    RESILIENCE_INDICATOR_NEGATIVE_TTL_SECONDS,
    { cacheFetcherErrors: false },
  );
}

interface ResponseBuildOptions {
  now: Date;
  dataVersion: string;
  formula?: CacheFormulaTag;
  schemaVersion?: '1.0' | '2.0';
  constructVersions?: ResilienceConstructVersions;
}

function normalizedCountryCode(value: unknown): string | null {
  const countryCode = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(countryCode) ? countryCode : null;
}

function toIsoTimestamp(value: number | null): string {
  if (!Number.isFinite(value) || Number(value) <= 0) return '';
  return new Date(Number(value)).toISOString();
}

function explicitIsoTimestamp(value: unknown): string {
  if (typeof value === 'number') return toIsoTimestamp(value);
  if (typeof value !== 'string') return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function roundFour(value: number): number {
  return Number(value.toFixed(4));
}

function observationAge(
  row: IndicatorTraceRow,
  now: Date,
): Pick<
  ResilienceIndicator,
  'observationAgeAvailable' | 'observationAgeValue' | 'observationAgeUnit' | 'observationAgeBasis'
> {
  if (Number.isFinite(row.observedAtMs) && Number(row.observedAtMs) > 0) {
    const ageDays = Math.floor(Math.max(0, now.getTime() - Number(row.observedAtMs)) / 86_400_000);
    return {
      observationAgeAvailable: true,
      observationAgeValue: ageDays,
      observationAgeUnit: 'days',
      observationAgeBasis: 'observation-timestamp',
    };
  }
  if (Number.isInteger(row.sourceYear) && Number(row.sourceYear) > 0) {
    return {
      observationAgeAvailable: true,
      observationAgeValue: Math.max(0, now.getUTCFullYear() - Number(row.sourceYear)),
      observationAgeUnit: 'years',
      observationAgeBasis: 'source-year',
    };
  }
  return {
    observationAgeAvailable: false,
    observationAgeValue: 0,
    observationAgeUnit: '',
    observationAgeBasis: '',
  };
}

function indicatorSources(row: IndicatorTraceRow): ResilienceIndicatorSource[] {
  const policy = getIndicatorSourcePolicy(row.indicatorId);
  const sourceHints = row.state === 'observed' ? row.observedSources : [];
  const count = Math.max(row.sourceKeys.length, sourceHints.length);
  const sources: ResilienceIndicatorSource[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const hint = sourceHints[index];
    const key = hint?.sourceKey ?? row.sourceKeys[index] ?? row.sourceKeys[0] ?? '';
    const metadata = hint
      ? getObservedSourceDisplayMetadata(policy, hint)
      : null;
    const name = metadata?.providerName || policy?.providerName || key;
    const url = hint?.sourceUrl || metadata?.sourceUrl || policy?.sourceUrl || '';
    const identity = `${key}\u0000${name}\u0000${url}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    sources.push({
      key,
      name,
      attribution: metadata?.attribution ?? policy?.attribution ?? '',
      license: metadata?.licenseLabel ?? policy?.licenseLabel ?? row.license,
      url,
      observationProvenance: hint != null,
      licenseUrl: metadata?.licenseUrl ?? policy?.licenseUrl ?? '',
      attributionUrl: metadata?.attributionUrl ?? policy?.attributionUrl ?? '',
    });
  }
  return sources;
}

function rawValue(row: IndicatorTraceRow, retrievedAtAvailable: boolean): ResilienceIndicatorRawValue {
  const decision = decideIndicatorRawRedistribution({
    indicatorId: row.indicatorId,
    observationState: row.state,
    sources: row.observedSources,
  });
  const hasNumeric = typeof row.rawValue === 'number' && Number.isFinite(row.rawValue);
  const hasText = typeof row.rawValue === 'string';
  const hasValue = hasNumeric || hasText;
  const available = decision.expose && hasValue && retrievedAtAvailable;
  return {
    available,
    numericValue: available && hasNumeric ? row.rawValue as number : 0,
    numericValueAvailable: available && hasNumeric,
    textValue: available && hasText ? row.rawValue as string : '',
    textValueAvailable: available && hasText,
    unit: available ? row.rawUnit : '',
    status: available ? 'available' : hasValue && decision.expose ? 'conditional' : hasValue ? decision.status : 'absent',
    reason: available ? '' : hasValue && decision.expose ? 'retrieval-timestamp-required' : hasValue ? decision.reason : 'no-observed-raw-value',
  };
}

function toIndicator(row: IndicatorTraceRow, now: Date): ResilienceIndicator {
  const normalizedScoreAvailable = Number.isFinite(row.normalizedScore);
  const isActive = row.state !== 'inactive' && row.state !== 'retired';
  const hasRuntimeWeights = row.runtimeWeightsAvailable;
  const observedAt = toIsoTimestamp(row.observedAtMs);
  const retrievedAt = explicitIsoTimestamp(row.retrievedAt);
  const retrievedAtAvailable = retrievedAt.length > 0;
  const exposedRawValue = rawValue(row, retrievedAtAvailable);
  return {
    id: row.indicatorId,
    dimension: row.dimension,
    tier: row.tier,
    active: isActive,
    includedInDimensionScore: row.includedInDimensionScore,
    state: row.state,
    reason: row.reason,
    normalizedScoreAvailable,
    normalizedScore: normalizedScoreAvailable ? Number(row.normalizedScore) : 0,
    nominalWeight: row.nominalWeight,
    runtimeWeightAvailable: hasRuntimeWeights,
    runtimeWeight: hasRuntimeWeights ? row.runtimeWeight : 0,
    scoringWeightShareAvailable: hasRuntimeWeights,
    scoringWeightShare: hasRuntimeWeights ? row.scoringWeightShare : 0,
    literalContribution: roundFour(row.literalContribution),
    effectiveContribution: roundFour(row.effectiveContribution),
    imputationClass: row.imputationClass ?? '',
    sourceYearAvailable: Number.isInteger(row.sourceYear) && Number(row.sourceYear) > 0,
    sourceYear: Number.isInteger(row.sourceYear) && Number(row.sourceYear) > 0 ? Number(row.sourceYear) : 0,
    ...observationAge(row, now),
    retrievedAtAvailable: exposedRawValue.available && retrievedAtAvailable,
    retrievedAt: exposedRawValue.available && retrievedAtAvailable ? retrievedAt : '',
    observedAtAvailable: observedAt.length > 0,
    observedAt,
    sources: indicatorSources(row),
    rawValue: exposedRawValue,
  };
}

export function toGetResilienceIndicatorsResponse(
  countryCode: string,
  scores: Readonly<Record<ResilienceDimensionId, ResilienceDimensionScore>> | null,
  snapshot: ResilienceIndicatorTraceSnapshot,
  options: ResponseBuildOptions,
): GetResilienceIndicatorsResponse {
  return {
    countryCode,
    methodology: RESILIENCE_INDICATOR_METHODOLOGY,
    formula: options.formula ?? getCurrentCacheFormula(),
    dataVersion: options.dataVersion,
    schemaVersion: options.schemaVersion ?? (RESILIENCE_SCHEMA_V2_ENABLED ? '2.0' : '1.0'),
    constructVersions: options.constructVersions ?? getConstructVersions(),
    dimensions: snapshot.dimensions.map((dimension) => {
      const literalContributionTotal = roundFour(dimension.indicators.reduce(
        (sum, row) => sum + roundFour(row.literalContribution),
        0,
      ));
      const effectiveContributionTotal = roundFour(dimension.indicators.reduce(
        (sum, row) => sum + row.effectiveContribution,
        0,
      ));
      return {
        id: dimension.id,
        score: dimension.score,
        coverage: scores?.[dimension.id]?.coverage ?? dimension.coverage,
        prePolicyScore: dimension.prePolicyScore,
        policyCapName: dimension.policyCapName,
        policyCapFactor: dimension.policyCapFactor,
        literalContributionTotal,
        effectiveContributionTotal,
        active: dimension.active,
        reconciliationAvailable: dimension.active,
        reason: dimension.reason,
      };
    }),
    indicators: snapshot.indicators.map((row) => toIndicator(row, options.now)),
  };
}

export function createGetResilienceIndicators(
  dependencies: ResilienceIndicatorHandlerDependencies = {},
): ResilienceServiceHandler['getResilienceIndicators'] {
  const now = dependencies.now ?? (() => new Date());
  const readStaticMeta = dependencies.readStaticMeta
    ?? (() => strictResilienceSeedReader(RESILIENCE_STATIC_META_KEY));
  const hasInjectedBuildDependency = dependencies.reader != null
    || dependencies.now != null
    || dependencies.readStaticMeta != null;
  const responseCache = dependencies.responseCache === undefined
    ? hasInjectedBuildDependency
      ? null
      : cacheResilienceIndicatorResponse
    : dependencies.responseCache;

  return async (
    _ctx: ServerContext,
    req: GetResilienceIndicatorsRequest,
  ): Promise<GetResilienceIndicatorsResponse> => {
    const countryCode = normalizedCountryCode(req.countryCode);
    if (!countryCode) {
      throw new ValidationError([{
        field: 'countryCode',
        description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code',
      }]);
    }

    if (!hasInjectedBuildDependency && dependencies.responseCache === undefined) {
      const generation = await ensureResilienceScoreGenerationCached(countryCode);
      return toGetResilienceIndicatorsResponse(
        countryCode,
        null,
        generation.trace.snapshot,
        {
          now: now(),
          dataVersion: generation.trace.dataVersion,
          formula: generation.trace.formula,
          schemaVersion: generation.trace.schemaVersion,
          constructVersions: generation.trace.constructVersions,
        },
      );
    }

    const buildResponse = async (): Promise<GetResilienceIndicatorsResponse> => {
      const trace = createIndicatorTraceCollector();
      const [scores, staticMeta] = await Promise.all([
        scoreAllDimensions(countryCode, dependencies.reader ?? strictResilienceSeedReader, { trace }),
        readStaticMeta(),
      ]);
      const dataVersion = staticMeta && typeof staticMeta === 'object'
        ? toResilienceDataVersion((staticMeta as { fetchedAt?: unknown }).fetchedAt)
        : '';
      return toGetResilienceIndicatorsResponse(
        countryCode,
        scores,
        materializeIndicatorTrace(trace, scores),
        { now: now(), dataVersion },
      );
    };

    if (!responseCache) return buildResponse();
    const constructs = getConstructVersions();
    const cacheKey = [
      'resilience:indicator-trace:v1',
      countryCode,
      getCurrentCacheFormula(),
      RESILIENCE_SCHEMA_V2_ENABLED ? 'schema-v2' : 'schema-v1',
      `energy-${constructs.energy}`,
      `education-${constructs.education}`,
      `financial-system-${constructs.financialSystemExposure}`,
    ].join(':');
    const cached = await responseCache(cacheKey, buildResponse);
    if (cached == null) throw new Error('Resilience indicator response cache returned no data');
    return cached;
  };
}

export const getResilienceIndicators = createGetResilienceIndicators();
