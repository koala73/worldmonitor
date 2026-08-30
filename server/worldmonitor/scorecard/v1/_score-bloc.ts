import { SCORECARD_INPUT_REGISTRY } from './_input-registry';
import { SCORECARD_BAND_LABELS, SCORECARD_METHODOLOGY_VERSION, SCORECARD_PILLAR_RULES } from './_methodology';
import { bandScore, normalizeEvidence, roundScore, scoreCountry } from './_score-country';
import {
  type AvailableScorecardEvidence,
  type BlocScorecardResult,
  type CountryScorecardEvidence,
  type CountryScorecardResult,
  type EvidenceUnavailableReason,
  type PillarResult,
  type ScorecardInputId,
  type ScorecardPillar,
} from './_types';

function populationOf(member: CountryScorecardEvidence): number | null {
  const population = member.inputs.population;
  return population.availability === 'available' && population.value > 0 ? population.value : null;
}

function unavailableResult(
  inputs: PillarResult['inputs'],
  coverage: number,
  method: PillarResult['aggregationMethod'],
  reasons: EvidenceUnavailableReason[],
  includedMembers: string[] = [],
  excludedMembers: PillarResult['excludedMembers'] = [],
  memberWeights: PillarResult['memberWeights'] = [],
): PillarResult {
  return {
    hasScore: false,
    score: null,
    subScore: null,
    continuousScore: null,
    band: null,
    inputCoverage: roundScore(coverage, 4),
    aggregationMethod: method,
    inputs,
    insufficientReasons: [...new Set(reasons)],
    includedMembers,
    excludedMembers,
    memberWeights,
  };
}

function scoredResult(
  inputs: PillarResult['inputs'],
  coverage: number,
  method: PillarResult['aggregationMethod'],
  continuous: number,
  includedMembers: string[] = [],
  excludedMembers: PillarResult['excludedMembers'] = [],
  memberWeights: PillarResult['memberWeights'] = [],
): PillarResult {
  const score = bandScore(continuous);
  return {
    hasScore: true,
    score,
    subScore: roundScore(continuous, 2),
    continuousScore: continuous,
    band: SCORECARD_BAND_LABELS[score],
    inputCoverage: roundScore(coverage, 4),
    aggregationMethod: method,
    inputs,
    insufficientReasons: [],
    includedMembers,
    excludedMembers,
    memberWeights,
  };
}

function memberExclusionReason(
  member: CountryScorecardEvidence,
  inputIds: ScorecardInputId[],
): EvidenceUnavailableReason {
  const inputs = inputIds.map((inputId) => member.inputs[inputId]);
  if (populationOf(member) == null && inputs.some((input) => input.availability === 'available')) {
    return 'missing-population';
  }
  return inputs.find((input) => input.availability === 'unavailable')?.reason ?? 'coverage-below-floor';
}

function scorePhysicalBlocPillar(
  pillar: 'food' | 'energy',
  members: CountryScorecardEvidence[],
): PillarResult {
  const definitions = (Object.entries(SCORECARD_INPUT_REGISTRY) as Array<[ScorecardInputId, typeof SCORECARD_INPUT_REGISTRY[ScorecardInputId]]>)
    .filter(([, definition]) => definition.pillar === pillar);
  const inputs = members.flatMap((member) => definitions.map(([inputId]) => ({
    ...member.inputs[inputId],
    countryCode: member.countryCode,
  })));
  const memberWeights = members.map((member) => ({
    countryCode: member.countryCode,
    populationMillions: populationOf(member),
  }));
  const componentScores: Array<{ inputId: ScorecardInputId; score: number; weight: number; group: string }> = [];
  const contributingMembers = new Set<string>();

  for (const [inputId, definition] of definitions) {
    const rows = members
      .map((member) => ({ member, evidence: member.inputs[inputId], population: populationOf(member) }))
      .filter((row): row is { member: CountryScorecardEvidence; evidence: AvailableScorecardEvidence; population: number | null } => row.evidence.availability === 'available');
    if (definition.blocAggregation === 'physical-ratio') {
      const aggregatable = rows.filter((row) => row.evidence.aggregation && row.evidence.aggregation.denominator > 0);
      if (aggregatable.length === 0) continue;
      aggregatable.forEach((row) => contributingMembers.add(row.member.countryCode));
      const numerator = aggregatable.reduce((sum, row) => sum + row.evidence.aggregation!.numerator, 0);
      const denominator = aggregatable.reduce((sum, row) => sum + row.evidence.aggregation!.denominator, 0);
      const exemplar = aggregatable[0]!.evidence;
      componentScores.push({
        inputId,
        score: normalizeEvidence({ ...exemplar, value: numerator / denominator }),
        weight: definition.weight,
        group: definition.group,
      });
      continue;
    }
    const weighted = rows.flatMap((row) => row.population == null ? [] : [{ ...row, population: row.population }]);
    const population = weighted.reduce((sum, row) => sum + row.population, 0);
    if (population <= 0) continue;
    weighted.forEach((row) => contributingMembers.add(row.member.countryCode));
    componentScores.push({
      inputId,
      score: weighted.reduce((sum, row) => sum + normalizeEvidence(row.evidence) * row.population, 0) / population,
      weight: definition.weight,
      group: definition.group,
    });
  }

  const coverage = componentScores.reduce((sum, component) => sum + component.weight, 0);
  const rules = SCORECARD_PILLAR_RULES[pillar];
  const inputIds = definitions.map(([inputId]) => inputId);
  const includedMembers = members
    .map((member) => member.countryCode)
    .filter((countryCode) => contributingMembers.has(countryCode));
  const excludedMembers = members
    .filter((member) => !contributingMembers.has(member.countryCode))
    .map((member) => ({ countryCode: member.countryCode, reason: memberExclusionReason(member, inputIds) }));
  const groups = new Set(componentScores.map((component) => component.group));
  const groupsPresent = rules.requiredGroups.every((alternatives) => alternatives.some((group) => groups.has(group)));
  if (coverage + Number.EPSILON < rules.coverageFloor || !groupsPresent) {
    return unavailableResult(inputs, coverage, 'aggregate-physical-inputs', [
      ...(coverage + Number.EPSILON < rules.coverageFloor ? ['coverage-below-floor' as const] : []),
      ...(!groupsPresent ? ['required-group-missing' as const] : []),
    ], includedMembers, excludedMembers, memberWeights);
  }
  const continuous = componentScores.reduce((sum, component) => sum + component.score * component.weight, 0) / coverage;
  return scoredResult(inputs, coverage, 'aggregate-physical-inputs', continuous, includedMembers, excludedMembers, memberWeights);
}

type ScoredMember = {
  member: CountryScorecardEvidence;
  population: number | null;
  pillars: CountryScorecardResult['pillars'];
};

function scorePopulationWeightedPillar(
  pillar: Exclude<ScorecardPillar, 'food' | 'energy'>,
  countryRows: ScoredMember[],
): PillarResult {
  const rows = countryRows.map((row) => ({ ...row, pillar: row.pillars[pillar] }));
  const inputs = rows.flatMap((row) => row.pillar.inputs.map((evidence) => ({
    ...evidence,
    countryCode: row.member.countryCode,
  })));
  const memberWeights = rows.map((row) => ({
    countryCode: row.member.countryCode,
    populationMillions: row.population,
  }));
  const knownPopulation = rows.reduce((sum, row) => sum + (row.population ?? 0), 0);
  const scored = rows.filter((row): row is typeof row & { population: number; pillar: PillarResult & { continuousScore: number } } =>
    row.population != null && row.pillar.hasScore && row.pillar.continuousScore != null);
  const scoredPopulation = scored.reduce((sum, row) => sum + row.population, 0);
  const includedMembers = scored.map((row) => row.member.countryCode);
  const excludedMembers = rows
    .filter((row) => !includedMembers.includes(row.member.countryCode))
    .map((row) => ({
      countryCode: row.member.countryCode,
      reason: row.population == null
        ? 'missing-population' as const
        : row.pillar.insufficientReasons[0] ?? 'coverage-below-floor' as const,
    }));
  if (knownPopulation <= 0) {
    return unavailableResult(inputs, 0, 'population-weighted-continuous-score', ['missing-population', 'coverage-below-floor'], includedMembers, excludedMembers, memberWeights);
  }
  if (scoredPopulation <= 0) {
    const reasons = [...new Set([
      ...excludedMembers.map((member) => member.reason),
      'coverage-below-floor' as const,
    ])];
    return unavailableResult(inputs, 0, 'population-weighted-continuous-score', reasons, includedMembers, excludedMembers, memberWeights);
  }
  const coverage = scored.reduce((sum, row) => sum + row.population * row.pillar.inputCoverage, 0) / knownPopulation;
  if (coverage + Number.EPSILON < SCORECARD_PILLAR_RULES[pillar].coverageFloor) {
    return unavailableResult(inputs, coverage, 'population-weighted-continuous-score', ['coverage-below-floor'], includedMembers, excludedMembers, memberWeights);
  }
  const continuous = scored.reduce((sum, row) => sum + row.population * row.pillar.continuousScore, 0) / scoredPopulation;
  return scoredResult(inputs, coverage, 'population-weighted-continuous-score', continuous, includedMembers, excludedMembers, memberWeights);
}

export function scoreBloc(input: {
  id: string;
  label: string;
  members: CountryScorecardEvidence[];
  requestedMembers?: string[];
  unavailableMembers?: Array<{ countryCode: string; reason: EvidenceUnavailableReason }>;
}): BlocScorecardResult {
  const countryRows = input.members.map((member) => ({
    member,
    population: populationOf(member),
    pillars: scoreCountry(member).pillars,
  }));
  return {
    id: input.id,
    label: input.label,
    methodologyVersion: SCORECARD_METHODOLOGY_VERSION,
    members: input.requestedMembers ?? input.members.map((member) => member.countryCode),
    includedMembers: input.members.map((member) => member.countryCode),
    excludedMembers: input.unavailableMembers ?? [],
    pillars: {
      food: scorePhysicalBlocPillar('food', input.members),
      energy: scorePhysicalBlocPillar('energy', input.members),
      demographics: scorePopulationWeightedPillar('demographics', countryRows),
      technology: scorePopulationWeightedPillar('technology', countryRows),
      defense: scorePopulationWeightedPillar('defense', countryRows),
    },
  };
}
