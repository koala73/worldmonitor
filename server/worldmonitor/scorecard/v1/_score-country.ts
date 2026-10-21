// Generated from scripts/scorecard/v1/_score-country.mts by scripts/generate-scorecard-edge-mirrors.mjs. Do not edit.
import { SCORECARD_INPUT_REGISTRY } from './_input-registry';
import { SCORECARD_BAND_LABELS, SCORECARD_METHODOLOGY_VERSION, SCORECARD_PILLAR_RULES } from './_methodology';
import {
  SCORECARD_PILLARS,
  type AvailableScorecardEvidence,
  type CountryScorecardEvidence,
  type CountryScorecardResult,
  type EvidenceUnavailableReason,
  type PillarResult,
  type ScorecardBand,
  type ScorecardInputId,
  type ScorecardPillar,
} from './_types';

export function roundScore(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function bandScore(value: number): ScorecardBand {
  const bounded = Math.max(0, Math.min(100, value));
  if (bounded >= 80) return 5;
  if (bounded >= 60) return 4;
  if (bounded >= 40) return 3;
  if (bounded >= 20) return 2;
  return 1;
}

export function normalizeEvidence(evidence: AvailableScorecardEvidence): number {
  const definition = SCORECARD_INPUT_REGISTRY[evidence.inputId];
  const { worst, best, kind } = definition.normalization;
  let value = evidence.value;
  let start: number = worst;
  let end: number = best;
  if (kind === 'log') {
    if (!(value > 0) || !(worst > 0) || !(best > 0)) return 0;
    value = Math.log10(value);
    start = Math.log10(worst);
    end = Math.log10(best);
  }
  if (start === end) return 0;
  return Math.max(0, Math.min(100, ((value - start) / (end - start)) * 100));
}

function uniqueReasons(reasons: EvidenceUnavailableReason[]): EvidenceUnavailableReason[] {
  return [...new Set(reasons)];
}

export function scorePillar(
  pillar: ScorecardPillar,
  evidenceById: CountryScorecardEvidence['inputs'],
): PillarResult {
  const definitions = (Object.entries(SCORECARD_INPUT_REGISTRY) as Array<[ScorecardInputId, typeof SCORECARD_INPUT_REGISTRY[ScorecardInputId]]>)
    .filter(([, definition]) => definition.pillar === pillar);
  const inputs = definitions.map(([inputId]) => evidenceById[inputId]);
  const available = inputs.filter((input): input is AvailableScorecardEvidence => input.availability === 'available');
  const coveredWeight = available.reduce((total, input) => total + SCORECARD_INPUT_REGISTRY[input.inputId].weight, 0);
  const rules = SCORECARD_PILLAR_RULES[pillar];
  const availableGroups = new Set<string>(available.map((input) => SCORECARD_INPUT_REGISTRY[input.inputId].group));
  const groupsPresent = rules.requiredGroups.every((alternatives) => alternatives.some((group) => availableGroups.has(group)));
  const reasons = inputs
    .filter((input) => input.availability === 'unavailable')
    .map((input) => input.reason);
  if (coveredWeight + Number.EPSILON < rules.coverageFloor) reasons.push('coverage-below-floor');
  if (!groupsPresent) reasons.push('required-group-missing');
  const scorable = coveredWeight + Number.EPSILON >= rules.coverageFloor && groupsPresent;
  if (!scorable) {
    return {
      hasScore: false,
      score: null,
      subScore: null,
      continuousScore: null,
      band: null,
      inputCoverage: roundScore(coveredWeight, 4),
      aggregationMethod: 'country-weighted-components',
      inputs,
      insufficientReasons: uniqueReasons(reasons),
      includedMembers: [],
      excludedMembers: [],
      memberWeights: [],
    };
  }
  const continuous = available.reduce(
    (total, input) => total + normalizeEvidence(input) * SCORECARD_INPUT_REGISTRY[input.inputId].weight,
    0,
  ) / coveredWeight;
  const score = bandScore(continuous);
  return {
    hasScore: true,
    score,
    subScore: roundScore(continuous, 2),
    continuousScore: continuous,
    band: SCORECARD_BAND_LABELS[score],
    inputCoverage: roundScore(coveredWeight, 4),
    aggregationMethod: 'country-weighted-components',
    inputs,
    insufficientReasons: [],
    includedMembers: [],
    excludedMembers: [],
    memberWeights: [],
  };
}

export function scoreCountry(evidence: CountryScorecardEvidence): CountryScorecardResult {
  return {
    countryCode: evidence.countryCode,
    methodologyVersion: SCORECARD_METHODOLOGY_VERSION,
    pillars: Object.fromEntries(
      SCORECARD_PILLARS.map((pillar) => [pillar, scorePillar(pillar, evidence.inputs)]),
    ) as CountryScorecardResult['pillars'],
  };
}
