// Generated from scripts/scorecard/v1/_snapshot.mts by scripts/generate-scorecard-edge-mirrors.mjs. Do not edit.
import { SCORECARD_INPUT_REGISTRY, SCORECARD_INPUT_REGISTRY_VERSION } from './_input-registry';
import { SCORECARD_BAND_LABELS, SCORECARD_METHODOLOGY_VERSION } from './_methodology';
import type { ScorecardSourceField } from './_source-registry';
import { bandScore, roundScore, scoreCountry } from './_score-country';
import { adaptCountryEvidence, SCORECARD_SOURCE_KEYS, type ScorecardSourceSnapshots } from './_source-adapters';
import {
  SCORECARD_PILLARS,
  SCORECARD_SNAPSHOT_SCHEMA_VERSION,
  type CountryScorecardResult,
  type CountryScorecardSummary,
  type EvidenceUnavailableReason,
  type FiveFactorReadModelMetadata,
  type FiveFactorSnapshotV1,
  type ScorecardInputId,
  type ScorecardSourceState,
} from './_types';

export const FIVE_FACTOR_SCORECARD_KEY = 'scorecard:five-factor:v1';
export const FIVE_FACTOR_SCORECARD_READ_MODEL_KEY = 'scorecard:five-factor:v1:read-model';
export const FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD = 'metadata';
export const FIVE_FACTOR_SCORECARD_READ_MODEL_LIST_FIELD = 'list';
export const FIVE_FACTOR_SCORECARD_MAX_BYTES = 5 * 1024 * 1024;
export const SCORECARD_PUBLICATION_FLOORS = {
  scoreableCountries: 180,
  populationEvidenceCountries: 150,
  scoreableCountriesByPillar: {
    food: 80,
    energy: 120,
    demographics: 150,
    technology: 120,
    defense: 30,
  },
} as const;

const SCORECARD_INPUT_IDS = Object.keys(SCORECARD_INPUT_REGISTRY) as ScorecardInputId[];
const SCORECARD_SOURCE_KEY_VALUES = [...new Set(Object.values(SCORECARD_SOURCE_KEYS))];
const EVIDENCE_UNAVAILABLE_REASONS = new Set<EvidenceUnavailableReason>([
  'source-unavailable',
  'country-unavailable',
  'invalid-value',
  'stale',
  'coverage-below-floor',
  'required-group-missing',
  'missing-population',
  'redistribution-blocked',
]);
const PILLAR_AGGREGATION_METHODS = new Set([
  'country-weighted-components',
  'aggregate-physical-inputs',
  'population-weighted-continuous-score',
]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isIso2(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isUnavailableReason(value: unknown): value is EvidenceUnavailableReason {
  return typeof value === 'string' && EVIDENCE_UNAVAILABLE_REASONS.has(value as EvidenceUnavailableReason);
}

function hasObservationShape(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'value', 'year', 'unit', 'source', 'indicatorCode'])) return false;
  return typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.value === 'number'
    && Number.isFinite(value.value)
    && Number.isInteger(value.year)
    && isFiniteInRange(value.year, 1900, 2200)
    && typeof value.unit === 'string'
    && value.unit.length > 0
    && typeof value.source === 'string'
    && value.source.length > 0
    && (value.indicatorCode == null || typeof value.indicatorCode === 'string');
}

function hasEvidenceShape(value: unknown, expectedInputId: ScorecardInputId): boolean {
  if (!isRecord(value)
    || value.inputId !== expectedInputId
    || typeof value.source !== 'string'
    || value.source.length === 0
    || value.sourceKey !== SCORECARD_INPUT_REGISTRY[expectedInputId].sourceKey
  ) return false;
  if (value.countryCode != null && !isIso2(value.countryCode)) return false;
  if (value.availability === 'unavailable') {
    return hasOnlyKeys(value, ['availability', 'inputId', 'reason', 'source', 'sourceKey', 'detail', 'countryCode'])
      && isUnavailableReason(value.reason)
      && (value.detail == null || typeof value.detail === 'string');
  }
  if (value.availability !== 'available'
    || !hasOnlyKeys(value, ['availability', 'inputId', 'value', 'year', 'unit', 'source', 'sourceKey', 'quality', 'observations', 'aggregation', 'countryCode'])
    || typeof value.value !== 'number'
    || !Number.isFinite(value.value)
    || !Number.isInteger(value.year)
    || !isFiniteInRange(value.year, 1900, 2200)
    || value.unit !== SCORECARD_INPUT_REGISTRY[expectedInputId].unit
    || (value.quality != null && !['observed', 'retained', 'derived'].includes(String(value.quality)))
    || !Array.isArray(value.observations)
    || value.observations.length === 0
    || !value.observations.every(hasObservationShape)
  ) return false;
  const requiresAggregation = SCORECARD_INPUT_REGISTRY[expectedInputId].blocAggregation === 'physical-ratio';
  if (value.aggregation == null) return !requiresAggregation;
  if (!requiresAggregation) return false;
  if (!isRecord(value.aggregation)) return false;
  if (!hasExactKeys(value.aggregation, ['numerator', 'denominator', 'unit'])) return false;
  if (!(typeof value.aggregation.numerator === 'number'
    && Number.isFinite(value.aggregation.numerator)
    && typeof value.aggregation.denominator === 'number'
    && Number.isFinite(value.aggregation.denominator)
    && value.aggregation.denominator > 0
    && typeof value.aggregation.unit === 'string'
    && value.aggregation.unit.length > 0
  )) return false;
  const aggregateRatio = value.aggregation.numerator / value.aggregation.denominator;
  const tolerance = 1e-12 * Math.max(1, Math.abs(value.value), Math.abs(aggregateRatio));
  return Math.abs(value.value - aggregateRatio) <= tolerance;
}

function hasReasonArray(value: unknown): value is EvidenceUnavailableReason[] {
  return Array.isArray(value) && value.every(isUnavailableReason);
}

function hasMemberArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isIso2) && new Set(value).size === value.length;
}

function hasExcludedMembersShape(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry)
    && hasExactKeys(entry, ['countryCode', 'reason'])
    && isIso2(entry.countryCode)
    && isUnavailableReason(entry.reason));
}

function hasMemberWeightsShape(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry)
    && hasExactKeys(entry, ['countryCode', 'populationMillions'])
    && isIso2(entry.countryCode)
    && (entry.populationMillions === null
      || (typeof entry.populationMillions === 'number' && Number.isFinite(entry.populationMillions) && entry.populationMillions > 0)));
}

function hasPillarScoreState(value: Record<string, unknown>): boolean {
  if (typeof value.hasScore !== 'boolean' || !isFiniteInRange(value.inputCoverage, 0, 1)) return false;
  if (value.hasScore) {
    return Number.isInteger(value.score)
      && isFiniteInRange(value.score, 1, 5)
      && isFiniteInRange(value.subScore, 0, 100)
      && isFiniteInRange(value.continuousScore, 0, 100)
      && value.score === bandScore(value.continuousScore)
      && value.subScore === roundScore(value.continuousScore, 2)
      && typeof value.band === 'string'
      && value.band === SCORECARD_BAND_LABELS[value.score as keyof typeof SCORECARD_BAND_LABELS]
      && Array.isArray(value.insufficientReasons)
      && value.insufficientReasons.length === 0;
  }
  return value.score === null
    && value.subScore === null
    && value.continuousScore === null
    && value.band === null
    && hasReasonArray(value.insufficientReasons);
}

function hasPillarResultShape(value: unknown, pillarId: typeof SCORECARD_PILLARS[number]): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, ['hasScore', 'score', 'subScore', 'continuousScore', 'band', 'inputCoverage', 'aggregationMethod', 'inputs', 'insufficientReasons', 'includedMembers', 'excludedMembers', 'memberWeights'])
    || !hasPillarScoreState(value)
    || typeof value.aggregationMethod !== 'string'
    || !PILLAR_AGGREGATION_METHODS.has(value.aggregationMethod)
    || !hasMemberArray(value.includedMembers)
    || !hasExcludedMembersShape(value.excludedMembers)
    || !hasMemberWeightsShape(value.memberWeights)
    || !Array.isArray(value.inputs)
  ) return false;
  const inputs = value.inputs;
  const expectedInputs = SCORECARD_INPUT_IDS.filter((inputId) => SCORECARD_INPUT_REGISTRY[inputId].pillar === pillarId);
  return inputs.length === expectedInputs.length
    && expectedInputs.every((inputId, index) => hasEvidenceShape(inputs[index], inputId));
}

function hasSourceStatesShape(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, SCORECARD_SOURCE_KEY_VALUES)) return false;
  return Object.entries(value).every(([sourceKey, state]) => isRecord(state)
    && hasOnlyKeys(state, ['status', 'sourceKey', 'detail'])
    && ['available', 'unavailable', 'stale'].includes(String(state.status))
    && state.sourceKey === sourceKey
    && (state.detail == null || typeof state.detail === 'string'));
}

export function hasCountryScorecardSummaryShape(value: unknown, expectedCountryCode?: string): value is CountryScorecardSummary {
  if (!isRecord(value)
    || !hasExactKeys(value, ['countryCode', 'pillars'])
    || !isIso2(value.countryCode)
    || (expectedCountryCode != null && value.countryCode !== expectedCountryCode)
    || !isRecord(value.pillars)
    || !hasExactKeys(value.pillars, SCORECARD_PILLARS)
  ) return false;
  const pillars = value.pillars;
  return SCORECARD_PILLARS.every((pillarId) => {
    const pillar = pillars[pillarId];
    return isRecord(pillar)
      && hasExactKeys(pillar, ['hasScore', 'score', 'subScore', 'band', 'inputCoverage', 'insufficientReasons'])
      && typeof pillar.hasScore === 'boolean'
      && isFiniteInRange(pillar.inputCoverage, 0, 1)
      && hasReasonArray(pillar.insufficientReasons)
      && (pillar.hasScore
        ? Number.isInteger(pillar.score)
          && isFiniteInRange(pillar.score, 1, 5)
          && isFiniteInRange(pillar.subScore, 0, 100)
          && (pillar.score === bandScore(pillar.subScore)
            || ([20, 40, 60, 80].includes(pillar.subScore) && pillar.score === bandScore(pillar.subScore) - 1))
          && typeof pillar.band === 'string'
          && pillar.band === SCORECARD_BAND_LABELS[pillar.score as keyof typeof SCORECARD_BAND_LABELS]
          && pillar.insufficientReasons.length === 0
        : pillar.score === null && pillar.subScore === null && pillar.band === null);
  });
}

export { SCORECARD_SOURCE_KEYS };

export function buildFiveFactorSnapshot(
  countryCodes: string[],
  sources: ScorecardSourceSnapshots,
  computedAt = new Date().toISOString(),
): FiveFactorSnapshotV1 {
  const asOfYear = new Date(computedAt).getUTCFullYear();
  const countries = Object.fromEntries(countryCodes.map((countryCode) => {
    const evidence = adaptCountryEvidence(countryCode, sources, asOfYear);
    return [countryCode, { evidence, result: scoreCountry(evidence) }];
  }));
  const sourceStates = Object.fromEntries((Object.entries(SCORECARD_SOURCE_KEYS) as Array<[ScorecardSourceField, string]>).map(([field, sourceKey]) => {
    const freshness = sources.sourceFreshness?.[field];
    return [sourceKey, {
      status: !sources[field] ? 'unavailable' : freshness?.status === 'stale' ? 'stale' : 'available',
      sourceKey,
      ...(!sources[field]
        ? { detail: 'Canonical source snapshot was not available during computation.' }
        : freshness?.status === 'stale'
          ? { detail: freshness.detail || 'Source freshness contract expired.' }
          : {}),
    }];
  })) as Record<string, ScorecardSourceState>;
  return {
    schemaVersion: SCORECARD_SNAPSHOT_SCHEMA_VERSION,
    methodologyVersion: SCORECARD_METHODOLOGY_VERSION,
    inputRegistryVersion: SCORECARD_INPUT_REGISTRY_VERSION,
    computedAt,
    sourceStates,
    countries,
  };
}

export function scorecardCoverage(snapshot: FiveFactorSnapshotV1): {
  scoreableCountries: number;
  populationEvidenceCountries: number;
  scoreableCountriesByPillar: Record<typeof SCORECARD_PILLARS[number], number>;
} {
  const scoreableCountriesByPillar = Object.fromEntries(SCORECARD_PILLARS.map((pillarId) => [pillarId, 0])) as Record<typeof SCORECARD_PILLARS[number], number>;
  let scoreableCountries = 0;
  let populationEvidenceCountries = 0;
  for (const record of Object.values(snapshot.countries)) {
    if (record.evidence.inputs.population.availability === 'available') populationEvidenceCountries += 1;
    let hasAnyScore = false;
    for (const pillarId of SCORECARD_PILLARS) {
      if (!record.result.pillars[pillarId].hasScore) continue;
      scoreableCountriesByPillar[pillarId] += 1;
      hasAnyScore = true;
    }
    if (hasAnyScore) scoreableCountries += 1;
  }
  return { scoreableCountries, populationEvidenceCountries, scoreableCountriesByPillar };
}

export function scorecardSnapshotBytes(snapshot: FiveFactorSnapshotV1): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

export function summarizeCountryScorecard(result: CountryScorecardResult): CountryScorecardSummary {
  return {
    countryCode: result.countryCode,
    pillars: Object.fromEntries(SCORECARD_PILLARS.map((pillarId) => {
      const pillar = result.pillars[pillarId];
      return [pillarId, {
        hasScore: pillar.hasScore,
        score: pillar.score,
        subScore: pillar.subScore,
        band: pillar.band,
        inputCoverage: pillar.inputCoverage,
        insufficientReasons: pillar.insufficientReasons,
      }];
    })) as CountryScorecardSummary['pillars'],
  };
}

export function buildFiveFactorReadModel(snapshot: FiveFactorSnapshotV1): {
  metadata: FiveFactorReadModelMetadata;
  list: CountryScorecardSummary[];
  countries: FiveFactorSnapshotV1['countries'];
} {
  const countryCodes = Object.keys(snapshot.countries).sort();
  return {
    metadata: {
      schemaVersion: snapshot.schemaVersion,
      methodologyVersion: snapshot.methodologyVersion,
      inputRegistryVersion: snapshot.inputRegistryVersion,
      computedAt: snapshot.computedAt,
      sourceStates: snapshot.sourceStates,
      countryCodes,
    },
    list: countryCodes.map((countryCode) => summarizeCountryScorecard(snapshot.countries[countryCode]!.result)),
    countries: snapshot.countries,
  };
}

export function hasFiveFactorSnapshotShape(value: unknown): value is FiveFactorSnapshotV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'methodologyVersion', 'inputRegistryVersion', 'computedAt', 'sourceStates', 'countries'])
  ) return false;
  const snapshot = value as Partial<FiveFactorSnapshotV1>;
  if (
    snapshot.schemaVersion !== SCORECARD_SNAPSHOT_SCHEMA_VERSION
    || snapshot.methodologyVersion !== SCORECARD_METHODOLOGY_VERSION
    || snapshot.inputRegistryVersion !== SCORECARD_INPUT_REGISTRY_VERSION
    || typeof snapshot.computedAt !== 'string'
    || !Number.isFinite(Date.parse(snapshot.computedAt))
    || new Date(snapshot.computedAt).toISOString() !== snapshot.computedAt
    || !hasSourceStatesShape(snapshot.sourceStates)
    || !isRecord(snapshot.countries)
  ) return false;
  return Object.entries(snapshot.countries).every(([countryCode, record]) => {
    if (!isIso2(countryCode)
      || !isRecord(record)
      || !hasExactKeys(record, ['evidence', 'result'])
      || !isRecord(record.evidence)
      || !hasExactKeys(record.evidence, ['countryCode', 'inputs'])
      || record.evidence.countryCode !== countryCode
      || !isRecord(record.evidence.inputs)
      || !hasExactKeys(record.evidence.inputs, SCORECARD_INPUT_IDS)
      || !SCORECARD_INPUT_IDS.every((inputId) => hasEvidenceShape(record.evidence.inputs[inputId], inputId))
      || !isRecord(record.result)
      || !hasExactKeys(record.result, ['countryCode', 'methodologyVersion', 'pillars'])
      || record.result.countryCode !== countryCode
      || record.result.methodologyVersion !== SCORECARD_METHODOLOGY_VERSION
      || !isRecord(record.result.pillars)
      || !hasExactKeys(record.result.pillars, SCORECARD_PILLARS)
    ) return false;
    if (!SCORECARD_PILLARS.every((pillarId) => hasPillarResultShape(record.result.pillars[pillarId], pillarId))) return false;
    return JSON.stringify(scoreCountry(record.evidence)) === JSON.stringify(record.result);
  });
}

export function validateFiveFactorSnapshot(
  snapshot: FiveFactorSnapshotV1,
  options: {
    minimumCountries?: number;
    minimumScoreableCountries?: number;
    minimumPopulationEvidenceCountries?: number;
    minimumScoreableCountriesByPillar?: Partial<Record<typeof SCORECARD_PILLARS[number], number>>;
    maxBytes?: number;
  } = {},
): boolean {
  const minimumCountries = options.minimumCountries ?? 150;
  const minimumScoreableCountries = options.minimumScoreableCountries
    ?? (options.minimumCountries == null ? SCORECARD_PUBLICATION_FLOORS.scoreableCountries : 1);
  const minimumPopulationEvidenceCountries = options.minimumPopulationEvidenceCountries
    ?? (options.minimumCountries == null ? SCORECARD_PUBLICATION_FLOORS.populationEvidenceCountries : 1);
  const minimumScoreableCountriesByPillar = options.minimumScoreableCountriesByPillar
    ?? (options.minimumCountries == null ? SCORECARD_PUBLICATION_FLOORS.scoreableCountriesByPillar : {});
  const maxBytes = options.maxBytes ?? FIVE_FACTOR_SCORECARD_MAX_BYTES;
  if (!hasFiveFactorSnapshotShape(snapshot)) return false;
  const entries = Object.entries(snapshot?.countries || {});
  if (entries.length < minimumCountries || scorecardSnapshotBytes(snapshot) > maxBytes) return false;
  for (const [countryCode, record] of entries) {
    if (record.evidence.countryCode !== countryCode || record.result.countryCode !== countryCode) return false;
  }
  const coverage = scorecardCoverage(snapshot);
  if (coverage.scoreableCountries < minimumScoreableCountries) return false;
  if (coverage.populationEvidenceCountries < minimumPopulationEvidenceCountries) return false;
  return SCORECARD_PILLARS.every((pillarId) =>
    coverage.scoreableCountriesByPillar[pillarId] >= (minimumScoreableCountriesByPillar[pillarId] ?? 0));
}
