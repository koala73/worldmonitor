import {
  CHINA_ACTIVITY_PROXY_FAMILIES,
  CHINA_ACTIVITY_PROXY_REGISTRY,
  type ChinaActivityProxyDefinition,
  type ChinaActivityProxyFamily,
} from './china-activity-nowcast-registry';

export const CHINA_ACTIVITY_NOWCAST_METHOD_VERSION = 'china-activity-nowcast/v1' as const;

export const CHINA_ACTIVITY_COMPARISON_STATES = [
  'agreement',
  'proxy_leading_divergence',
  'official_leading_divergence',
  'mixed_signals',
  'insufficient_data',
] as const;

export const CHINA_ACTIVITY_DIRECTIONS = [
  'strengthening',
  'weakening',
  'unchanged',
] as const;

export type ChinaActivityComparisonState =
  (typeof CHINA_ACTIVITY_COMPARISON_STATES)[number];
export type ChinaActivityDirection = (typeof CHINA_ACTIVITY_DIRECTIONS)[number];

export {
  CHINA_ACTIVITY_PROXY_FAMILIES,
  CHINA_ACTIVITY_PROXY_REGISTRY,
  type ChinaActivityProxyDefinition,
  type ChinaActivityProxyFamily,
} from './china-activity-nowcast-registry';

export interface ChinaActivityOfficialObservation {
  seriesId: string;
  label: string;
  vintageId: string;
  observationPeriod: string;
  periodEnd: string;
  releaseTime: string;
  retrievalTime: string;
  direction: ChinaActivityDirection;
  value: number;
  unit: string;
  available: boolean;
  stale: boolean;
  provenance: unknown;
}

export interface ChinaActivityProxyObservation {
  seriesId: string;
  observationId: string;
  observedAt: string;
  releasedAt: string;
  retrievedAt: string;
  value: number | null;
  priorValue: number | null;
  available: boolean;
  stale: boolean;
  structuralBreak: boolean;
  provenance: unknown;
}

export interface ChinaActivityContribution {
  family: ChinaActivityProxyFamily;
  seriesId: string;
  registry: Readonly<ChinaActivityProxyDefinition>;
  observationId: string | null;
  observedAt: string | null;
  alignedAt: string | null;
  rawValue: number | null;
  priorValue: number | null;
  transformedValue: number | null;
  direction: ChinaActivityDirection | null;
  included: boolean;
  exclusionReason: string | null;
  provenance: unknown;
}

export interface ChinaActivitySensitivity {
  family: ChinaActivityProxyFamily;
  contributionCount: number;
  contributionShare: number;
  stateWithoutFamily: ChinaActivityComparisonState;
  changesConclusion: boolean;
}

export interface ChinaActivityNowcastResponse {
  methodVersion: typeof CHINA_ACTIVITY_NOWCAST_METHOD_VERSION;
  evaluatedAt: string;
  comparisonWindow: {
    days: number;
    startsAt: string;
    endsAt: string;
    forwardFill: false;
    interpolate: false;
  };
  state: ChinaActivityComparisonState;
  official: ChinaActivityOfficialObservation | null;
  contributions: ChinaActivityContribution[];
  missingInputs: Array<{
    family: ChinaActivityProxyFamily;
    seriesId: string;
    reason: string;
  }>;
  confidence: {
    level: 'high' | 'medium' | 'low' | 'insufficient';
    reason: string;
    eligibleFamilies: number;
    totalFamilies: number;
  };
  sensitivity: ChinaActivitySensitivity[];
  historicalEvaluation: {
    available: false;
    reason: string;
    noLookahead: true;
    attempted: 0;
    evaluated: 0;
    coverage: 0;
    directionalAgreement: null;
  };
  limitations: string[];
  audit: {
    deterministic: true;
    llmNumericComputation: false;
    noLookahead: true;
    excludedFutureObservationIds: string[];
    officialCandidatesConsidered: number;
  };
}

export interface EvaluateChinaActivityNowcastInput {
  evaluatedAt: string;
  comparisonWindowDays?: number;
  minimumProxyFamilies?: number;
  officialObservations: readonly ChinaActivityOfficialObservation[];
  proxyObservations: readonly ChinaActivityProxyObservation[];
}

const registryById = new Map(
  CHINA_ACTIVITY_PROXY_REGISTRY.map((definition) => [definition.id, definition]),
);
const validDirections = new Set<string>(CHINA_ACTIVITY_DIRECTIONS);
const validStates = new Set<string>(CHINA_ACTIVITY_COMPARISON_STATES);
const MILLISECONDS_PER_DAY = 86_400_000;

function instant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasProvenance(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectOfficial(
  observations: readonly ChinaActivityOfficialObservation[],
  evaluatedAtMs: number,
): ChinaActivityOfficialObservation | null {
  return observations
    .filter((observation) => {
      const periodEnd = instant(observation.periodEnd);
      const releaseTime = instant(observation.releaseTime);
      const retrievalTime = instant(observation.retrievalTime);
      return periodEnd !== null
        && releaseTime !== null
        && retrievalTime !== null
        && periodEnd <= releaseTime
        && releaseTime <= retrievalTime
        && retrievalTime <= evaluatedAtMs
        && observation.available
        && !observation.stale
        && finite(observation.value)
        && validDirections.has(observation.direction)
        && hasProvenance(observation.provenance);
    })
    .sort((left, right) => {
      const period = (instant(right.periodEnd) ?? 0) - (instant(left.periodEnd) ?? 0);
      if (period !== 0) return period;
      return (instant(right.retrievalTime) ?? 0) - (instant(left.retrievalTime) ?? 0);
    })[0] ?? null;
}

function transformedValue(
  definition: Readonly<ChinaActivityProxyDefinition>,
  observation: ChinaActivityProxyObservation,
): number | null {
  if (!finite(observation.value)) return null;
  const value = definition.transformation.kind === 'signed_value'
    ? observation.value
    : finite(observation.priorValue) && observation.priorValue !== 0
      ? ((observation.value - observation.priorValue) / Math.abs(observation.priorValue)) * 100
      : null;
  if (value === null) return null;
  return definition.transformation.direction === 'inverse' ? -value : value;
}

function directionFromValue(value: number): ChinaActivityDirection {
  if (value > 1e-9) return 'strengthening';
  if (value < -1e-9) return 'weakening';
  return 'unchanged';
}

function excludedContribution(
  definition: Readonly<ChinaActivityProxyDefinition>,
  reason: string,
  observation: ChinaActivityProxyObservation | null = null,
): ChinaActivityContribution {
  return {
    family: definition.family,
    seriesId: definition.id,
    registry: definition,
    observationId: observation?.observationId ?? null,
    observedAt: observation?.observedAt ?? null,
    alignedAt: null,
    rawValue: observation?.value ?? null,
    priorValue: observation?.priorValue ?? null,
    transformedValue: null,
    direction: null,
    included: false,
    exclusionReason: reason,
    provenance: observation?.provenance ?? null,
  };
}

function contributionFor(
  definition: Readonly<ChinaActivityProxyDefinition>,
  observations: readonly ChinaActivityProxyObservation[],
  evaluatedAtMs: number,
  windowStartsAtMs: number,
): ChinaActivityContribution {
  const latest = observations
    .filter((observation) => observation.seriesId === definition.id)
    .filter((observation) => {
      const observedAt = instant(observation.observedAt);
      const releasedAt = instant(observation.releasedAt);
      const retrievedAt = instant(observation.retrievedAt);
      return observedAt !== null
        && releasedAt !== null
        && retrievedAt !== null
        && observedAt <= releasedAt
        && releasedAt <= retrievedAt
        && retrievedAt <= evaluatedAtMs;
    })
    .sort((left, right) =>
      (instant(right.observedAt) ?? 0) - (instant(left.observedAt) ?? 0))[0] ?? null;

  if (latest === null) return excludedContribution(definition, 'no_observation');
  const observedAtMs = instant(latest.observedAt)!;
  if (latest.structuralBreak) {
    return excludedContribution(definition, 'structural_break', latest);
  }
  if (!latest.available) {
    return excludedContribution(definition, 'unavailable', latest);
  }
  if (latest.stale) {
    return excludedContribution(definition, 'marked_stale', latest);
  }
  if (!hasProvenance(latest.provenance)) {
    return excludedContribution(definition, 'missing_provenance', latest);
  }
  const alignedAtMs = observedAtMs + definition.lagRule.days * MILLISECONDS_PER_DAY;
  if (alignedAtMs > evaluatedAtMs) {
    return excludedContribution(definition, 'lag_not_elapsed', latest);
  }
  if (alignedAtMs < windowStartsAtMs) {
    return excludedContribution(definition, 'outside_comparison_window_no_fill', latest);
  }
  if (
    evaluatedAtMs - observedAtMs
    > definition.freshnessBudgetMinutes * 60_000
  ) {
    return excludedContribution(definition, 'freshness_budget_exceeded', latest);
  }
  const transformed = transformedValue(definition, latest);
  if (transformed === null) {
    return excludedContribution(
      definition,
      definition.transformation.kind === 'percentage_change'
        ? 'missing_comparable_prior'
        : 'missing_directional_value',
      latest,
    );
  }
  return {
    family: definition.family,
    seriesId: definition.id,
    registry: definition,
    observationId: latest.observationId,
    observedAt: latest.observedAt,
    alignedAt: new Date(alignedAtMs).toISOString(),
    rawValue: latest.value,
    priorValue: latest.priorValue,
    transformedValue: transformed,
    direction: directionFromValue(transformed),
    included: true,
    exclusionReason: null,
    provenance: latest.provenance,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null;
}

function classify(
  official: ChinaActivityOfficialObservation | null,
  contributions: readonly ChinaActivityContribution[],
  minimumProxyFamilies: number,
): ChinaActivityComparisonState {
  if (official === null || official.direction === 'unchanged') return 'insufficient_data';
  const directional = contributions.filter((contribution) =>
    contribution.included && contribution.direction !== 'unchanged');
  const families = new Set(directional.map((contribution) => contribution.family));
  if (families.size < minimumProxyFamilies) return 'insufficient_data';

  const strengthening = directional.filter((item) => item.direction === 'strengthening').length;
  const weakening = directional.filter((item) => item.direction === 'weakening').length;
  const total = strengthening + weakening;
  const leading = Math.max(strengthening, weakening);
  if (total === 0 || leading / total < 2 / 3) return 'mixed_signals';
  const proxyDirection: Exclude<ChinaActivityDirection, 'unchanged'> =
    strengthening > weakening ? 'strengthening' : 'weakening';
  if (proxyDirection === official.direction) return 'agreement';

  const proxyMedian = median(directional
    .map((item) => item.alignedAt === null ? null : instant(item.alignedAt))
    .filter((value): value is number => value !== null));
  const officialPeriodEnd = instant(official.periodEnd);
  return (
    proxyMedian !== null
    && officialPeriodEnd !== null
    && proxyMedian > officialPeriodEnd
  )
    ? 'proxy_leading_divergence'
    : 'official_leading_divergence';
}

function confidenceFor(
  state: ChinaActivityComparisonState,
  official: ChinaActivityOfficialObservation | null,
  contributions: readonly ChinaActivityContribution[],
  sensitivity: readonly ChinaActivitySensitivity[],
  minimumProxyFamilies: number,
): ChinaActivityNowcastResponse['confidence'] {
  const eligibleFamilies = new Set(
    contributions.filter((item) => item.included).map((item) => item.family),
  ).size;
  if (state === 'insufficient_data') {
    const directionalFamilies = new Set(
      contributions
        .filter((item) => item.included && item.direction !== 'unchanged')
        .map((item) => item.family),
    ).size;
    const reason = official === null
      ? 'One eligible official vintage is required.'
      : official.direction === 'unchanged'
        ? 'The eligible official vintage is unchanged; a directional comparison requires strengthening or weakening.'
        : `At least ${minimumProxyFamilies} non-flat proxy families are required; ${directionalFamilies} are eligible.`;
    return {
      level: 'insufficient',
      reason,
      eligibleFamilies,
      totalFamilies: CHINA_ACTIVITY_PROXY_FAMILIES.length,
    };
  }
  const conclusionSensitive = sensitivity.some((item) => item.changesConclusion);
  const coverage = eligibleFamilies / CHINA_ACTIVITY_PROXY_FAMILIES.length;
  const level = !conclusionSensitive && coverage >= 0.75
    ? 'high'
    : coverage >= 0.5
      ? 'medium'
      : 'low';
  return {
    level,
    reason: conclusionSensitive
      ? 'At least one proxy family changes the leave-one-family-out conclusion.'
      : `Eligible proxy-family coverage is ${eligibleFamilies}/${CHINA_ACTIVITY_PROXY_FAMILIES.length}.`,
    eligibleFamilies,
    totalFamilies: CHINA_ACTIVITY_PROXY_FAMILIES.length,
  };
}

function sensitivityFor(
  official: ChinaActivityOfficialObservation | null,
  contributions: readonly ChinaActivityContribution[],
  state: ChinaActivityComparisonState,
  minimumProxyFamilies: number,
): ChinaActivitySensitivity[] {
  const includedCount = contributions.filter((item) => item.included).length;
  return CHINA_ACTIVITY_PROXY_FAMILIES.map((family) => {
    const withoutFamily = contributions.filter((item) => item.family !== family);
    const contributionCount = contributions.filter((item) =>
      item.family === family && item.included).length;
    const stateWithoutFamily = classify(official, withoutFamily, minimumProxyFamilies);
    return {
      family,
      contributionCount,
      contributionShare: includedCount === 0 ? 0 : contributionCount / includedCount,
      stateWithoutFamily,
      changesConclusion: contributionCount > 0 && stateWithoutFamily !== state,
    };
  });
}

export function evaluateChinaActivityNowcast(
  input: EvaluateChinaActivityNowcastInput,
): ChinaActivityNowcastResponse {
  const evaluatedAtMs = instant(input.evaluatedAt);
  if (evaluatedAtMs === null) throw new Error('Invalid China activity nowcast evaluation time');
  const comparisonWindowDays = Math.max(1, Math.trunc(input.comparisonWindowDays ?? 90));
  const minimumProxyFamilies = Math.max(1, Math.trunc(input.minimumProxyFamilies ?? 3));
  const windowStartsAtMs = evaluatedAtMs - comparisonWindowDays * MILLISECONDS_PER_DAY;
  const official = selectOfficial(input.officialObservations, evaluatedAtMs);
  const contributions = CHINA_ACTIVITY_PROXY_REGISTRY.map((definition) =>
    contributionFor(
      definition,
      input.proxyObservations,
      evaluatedAtMs,
      windowStartsAtMs,
    ));
  const state = classify(official, contributions, minimumProxyFamilies);
  const sensitivity = sensitivityFor(
    official,
    contributions,
    state,
    minimumProxyFamilies,
  );
  const excludedFutureObservationIds = input.proxyObservations
    .filter((observation) => {
      const observed = instant(observation.observedAt);
      const released = instant(observation.releasedAt);
      const retrieved = instant(observation.retrievedAt);
      return observed === null
        || released === null
        || retrieved === null
        || observed > evaluatedAtMs
        || released > evaluatedAtMs
        || retrieved > evaluatedAtMs;
    })
    .map((observation) => observation.observationId)
    .sort();

  return {
    methodVersion: CHINA_ACTIVITY_NOWCAST_METHOD_VERSION,
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
    comparisonWindow: {
      days: comparisonWindowDays,
      startsAt: new Date(windowStartsAtMs).toISOString(),
      endsAt: new Date(evaluatedAtMs).toISOString(),
      forwardFill: false,
      interpolate: false,
    },
    state,
    official,
    contributions,
    missingInputs: contributions
      .filter((item) => !item.included)
      .map((item) => ({
        family: item.family,
        seriesId: item.seriesId,
        reason: item.exclusionReason ?? 'unavailable',
      })),
    confidence: confidenceFor(
      state,
      official,
      contributions,
      sensitivity,
      minimumProxyFamilies,
    ),
    sensitivity,
    historicalEvaluation: {
      available: false,
      reason: 'The live cache does not yet contain a bounded historical proxy ledger; no backtest is inferred from current-only snapshots.',
      noLookahead: true,
      attempted: 0,
      evaluated: 0,
      coverage: 0,
      directionalAgreement: null,
    },
    limitations: [
      'This is a directional comparison, not a replacement GDP estimate or a hidden-activity verification.',
      'Market prices and freight rates can move for global supply, capacity, and risk reasons unrelated to China activity.',
      'Missing, stale, structurally changed, or provenance-free inputs are excluded rather than treated as neutral.',
    ],
    audit: {
      deterministic: true,
      llmNumericComputation: false,
      noLookahead: true,
      excludedFutureObservationIds,
      officialCandidatesConsidered: input.officialObservations.length,
    },
  };
}

export interface BacktestChinaActivityNowcastInput {
  evaluationTimes: readonly string[];
  comparisonWindowDays?: number;
  minimumProxyFamilies?: number;
  officialObservations: readonly ChinaActivityOfficialObservation[];
  proxyObservations: readonly ChinaActivityProxyObservation[];
}

export interface ChinaActivityNowcastBacktest {
  methodVersion: typeof CHINA_ACTIVITY_NOWCAST_METHOD_VERSION;
  noLookahead: true;
  attempted: number;
  evaluated: number;
  coverage: number;
  directionalAgreement: number | null;
  rows: Array<{
    evaluatedAt: string;
    state: ChinaActivityComparisonState;
    officialVintageId: string | null;
    directionalAgreement: boolean | null;
    eligibleFamilies: number;
  }>;
}

export function backtestChinaActivityNowcast(
  input: BacktestChinaActivityNowcastInput,
): ChinaActivityNowcastBacktest {
  const rows = input.evaluationTimes.map((evaluatedAt) => {
    const result = evaluateChinaActivityNowcast({
      evaluatedAt,
      comparisonWindowDays: input.comparisonWindowDays,
      minimumProxyFamilies: input.minimumProxyFamilies,
      officialObservations: input.officialObservations,
      proxyObservations: input.proxyObservations,
    });
    const directionalAgreement = result.state === 'agreement'
      ? true
      : result.state === 'proxy_leading_divergence'
        || result.state === 'official_leading_divergence'
        ? false
        : null;
    return {
      evaluatedAt: result.evaluatedAt,
      state: result.state,
      officialVintageId: result.official?.vintageId ?? null,
      directionalAgreement,
      eligibleFamilies: result.confidence.eligibleFamilies,
    };
  });
  const evaluatedRows = rows.filter((row) => row.directionalAgreement !== null);
  const agreements = evaluatedRows.filter((row) => row.directionalAgreement).length;
  return {
    methodVersion: CHINA_ACTIVITY_NOWCAST_METHOD_VERSION,
    noLookahead: true,
    attempted: rows.length,
    evaluated: evaluatedRows.length,
    coverage: rows.length === 0 ? 0 : evaluatedRows.length / rows.length,
    directionalAgreement: evaluatedRows.length === 0 ? null : agreements / evaluatedRows.length,
    rows,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || finite(value);
}

function isInstantOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && instant(value) !== null);
}

function isOfficialObservation(
  value: unknown,
): value is ChinaActivityOfficialObservation {
  return isRecord(value)
    && typeof value.seriesId === 'string'
    && typeof value.label === 'string'
    && typeof value.vintageId === 'string'
    && typeof value.observationPeriod === 'string'
    && typeof value.periodEnd === 'string'
    && instant(value.periodEnd) !== null
    && typeof value.releaseTime === 'string'
    && instant(value.releaseTime) !== null
    && typeof value.retrievalTime === 'string'
    && instant(value.retrievalTime) !== null
    && validDirections.has(String(value.direction))
    && finite(value.value)
    && typeof value.unit === 'string'
    && typeof value.available === 'boolean'
    && typeof value.stale === 'boolean'
    && hasProvenance(value.provenance);
}

function isContribution(value: unknown): value is ChinaActivityContribution {
  if (!isRecord(value)) return false;
  const definition = registryById.get(String(value.seriesId));
  if (
    definition === undefined
    || value.family !== definition.family
    || !isRecord(value.registry)
    || value.registry.id !== definition.id
    || !isStringOrNull(value.observationId)
    || !isInstantOrNull(value.observedAt)
    || !isInstantOrNull(value.alignedAt)
    || !isFiniteOrNull(value.rawValue)
    || !isFiniteOrNull(value.priorValue)
    || !isFiniteOrNull(value.transformedValue)
    || typeof value.included !== 'boolean'
    || !isStringOrNull(value.exclusionReason)
  ) return false;

  if (value.included) {
    return typeof value.observationId === 'string'
      && typeof value.observedAt === 'string'
      && typeof value.alignedAt === 'string'
      && finite(value.transformedValue)
      && validDirections.has(String(value.direction))
      && value.exclusionReason === null
      && hasProvenance(value.provenance);
  }
  return value.direction === null
    && value.transformedValue === null
    && typeof value.exclusionReason === 'string';
}

function isMissingInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const definition = registryById.get(String(value.seriesId));
  return definition !== undefined
    && value.family === definition.family
    && typeof value.reason === 'string';
}

function isSensitivity(value: unknown): boolean {
  return isRecord(value)
    && CHINA_ACTIVITY_PROXY_FAMILIES.includes(value.family as ChinaActivityProxyFamily)
    && Number.isInteger(value.contributionCount)
    && Number(value.contributionCount) >= 0
    && finite(value.contributionShare)
    && value.contributionShare >= 0
    && value.contributionShare <= 1
    && validStates.has(String(value.stateWithoutFamily))
    && typeof value.changesConclusion === 'boolean';
}

function equalSensitivity(
  left: readonly ChinaActivitySensitivity[],
  right: readonly ChinaActivitySensitivity[],
): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const expected = right[index];
      return expected !== undefined
        && item.family === expected.family
        && item.contributionCount === expected.contributionCount
        && item.contributionShare === expected.contributionShare
        && item.stateWithoutFamily === expected.stateWithoutFamily
        && item.changesConclusion === expected.changesConclusion;
    });
}

export function isChinaActivityNowcastUpstreamUnavailable(
  response: ChinaActivityNowcastResponse,
): boolean {
  return response.official === null
    && response.contributions.every((contribution) => !contribution.included);
}

function isChinaActivityNowcastResponse(value: unknown): value is ChinaActivityNowcastResponse {
  if (!isRecord(value)) return false;
  if (
    value.methodVersion !== CHINA_ACTIVITY_NOWCAST_METHOD_VERSION
    || !validStates.has(String(value.state))
    || instant(String(value.evaluatedAt)) === null
    || !isRecord(value.comparisonWindow)
    || !Number.isInteger(value.comparisonWindow.days)
    || Number(value.comparisonWindow.days) < 1
    || typeof value.comparisonWindow.startsAt !== 'string'
    || instant(value.comparisonWindow.startsAt) === null
    || typeof value.comparisonWindow.endsAt !== 'string'
    || instant(value.comparisonWindow.endsAt) === null
    || value.comparisonWindow.endsAt !== value.evaluatedAt
    || value.comparisonWindow.forwardFill !== false
    || value.comparisonWindow.interpolate !== false
    || !Array.isArray(value.contributions)
    || value.contributions.length !== CHINA_ACTIVITY_PROXY_REGISTRY.length
    || !value.contributions.every((item, index) =>
      isContribution(item)
      && item.seriesId === CHINA_ACTIVITY_PROXY_REGISTRY[index]?.id)
    || !Array.isArray(value.missingInputs)
    || !value.missingInputs.every(isMissingInput)
    || !isRecord(value.confidence)
    || !['high', 'medium', 'low', 'insufficient'].includes(String(value.confidence.level))
    || typeof value.confidence.reason !== 'string'
    || !Number.isInteger(value.confidence.eligibleFamilies)
    || Number(value.confidence.eligibleFamilies) < 0
    || Number(value.confidence.eligibleFamilies) > CHINA_ACTIVITY_PROXY_FAMILIES.length
    || value.confidence.totalFamilies !== CHINA_ACTIVITY_PROXY_FAMILIES.length
    || !Array.isArray(value.sensitivity)
    || value.sensitivity.length !== CHINA_ACTIVITY_PROXY_FAMILIES.length
    || !value.sensitivity.every(isSensitivity)
    || new Set(value.sensitivity.map((item) =>
      (item as Record<string, unknown>).family)).size !== CHINA_ACTIVITY_PROXY_FAMILIES.length
    || !isRecord(value.historicalEvaluation)
    || value.historicalEvaluation.available !== false
    || typeof value.historicalEvaluation.reason !== 'string'
    || value.historicalEvaluation.noLookahead !== true
    || value.historicalEvaluation.attempted !== 0
    || value.historicalEvaluation.evaluated !== 0
    || value.historicalEvaluation.coverage !== 0
    || value.historicalEvaluation.directionalAgreement !== null
    || !Array.isArray(value.limitations)
    || !value.limitations.every((item) => typeof item === 'string')
    || !isRecord(value.audit)
    || value.audit.deterministic !== true
    || value.audit.llmNumericComputation !== false
    || value.audit.noLookahead !== true
    || !Array.isArray(value.audit.excludedFutureObservationIds)
    || !value.audit.excludedFutureObservationIds.every((item) => typeof item === 'string')
    || !Number.isInteger(value.audit.officialCandidatesConsidered)
    || Number(value.audit.officialCandidatesConsidered) < 0
  ) return false;
  if (value.official !== null && !isOfficialObservation(value.official)) return false;

  const candidate = value as unknown as ChinaActivityNowcastResponse;
  const evaluatedAtMs = instant(candidate.evaluatedAt)!;
  const expectedWindowStart = new Date(
    evaluatedAtMs - candidate.comparisonWindow.days * MILLISECONDS_PER_DAY,
  ).toISOString();
  if (candidate.comparisonWindow.startsAt !== expectedWindowStart) return false;
  if (candidate.official !== null) {
    const periodEnd = instant(candidate.official.periodEnd)!;
    const releaseTime = instant(candidate.official.releaseTime)!;
    const retrievalTime = instant(candidate.official.retrievalTime)!;
    if (
      !candidate.official.available
      || candidate.official.stale
      || periodEnd > releaseTime
      || releaseTime > retrievalTime
      || retrievalTime > evaluatedAtMs
    ) return false;
  }
  if (candidate.contributions.some((contribution) =>
    (contribution.observedAt !== null && instant(contribution.observedAt)! > evaluatedAtMs)
    || (contribution.alignedAt !== null && instant(contribution.alignedAt)! > evaluatedAtMs)
  )) return false;
  if (classify(candidate.official, candidate.contributions, 3) !== candidate.state) return false;

  const excluded = candidate.contributions.filter((item) => !item.included);
  if (
    candidate.missingInputs.length !== excluded.length
    || candidate.missingInputs.some((item, index) => {
      const contribution = excluded[index];
      return contribution === undefined
        || item.family !== contribution.family
        || item.seriesId !== contribution.seriesId
        || item.reason !== contribution.exclusionReason;
    })
  ) return false;

  const eligibleFamilies = new Set(
    candidate.contributions.filter((item) => item.included).map((item) => item.family),
  ).size;
  if (candidate.confidence.eligibleFamilies !== eligibleFamilies) return false;

  const expectedSensitivity = sensitivityFor(
    candidate.official,
    candidate.contributions,
    candidate.state,
    3,
  );
  if (!equalSensitivity(candidate.sensitivity, expectedSensitivity)) return false;
  const expectedConfidence = confidenceFor(
    candidate.state,
    candidate.official,
    candidate.contributions,
    expectedSensitivity,
    3,
  );
  return candidate.confidence.level === expectedConfidence.level
    && candidate.confidence.reason === expectedConfidence.reason
    && candidate.confidence.eligibleFamilies === expectedConfidence.eligibleFamilies
    && candidate.confidence.totalFamilies === expectedConfidence.totalFamilies;
}

export function parseChinaActivityNowcastWirePayload(
  payloadJson: string,
): ChinaActivityNowcastResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error('Invalid China activity nowcast response');
  }
  if (!isChinaActivityNowcastResponse(parsed)) {
    throw new Error('Invalid China activity nowcast response');
  }
  return {
    ...parsed,
    contributions: parsed.contributions.map((contribution) => ({
      ...contribution,
      registry: registryById.get(contribution.seriesId)!,
    })),
  };
}
