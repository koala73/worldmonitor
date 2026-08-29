import type {
  FiveFactorBlocScorecard,
  FiveFactorCountryScorecard,
  FiveFactorPillar,
  ScorecardEvidence as PublicScorecardEvidence,
} from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { SCORECARD_PILLARS, type BlocScorecardResult, type CountryScorecardResult, type PillarResult, type ScorecardEvidence, type ScorecardPillar } from './_types';

export function toPublicEvidence(evidence: ScorecardEvidence): PublicScorecardEvidence {
  if (evidence.availability === 'unavailable') {
    return {
      inputId: evidence.inputId,
      available: false,
      value: 0,
      hasValue: false,
      year: 0,
      unit: '',
      source: evidence.source,
      sourceKey: evidence.sourceKey,
      unavailableReason: evidence.reason,
      quality: '',
      observations: [],
    };
  }
  return {
    inputId: evidence.inputId,
    available: true,
    value: evidence.value,
    hasValue: true,
    year: evidence.year,
    unit: evidence.unit,
    source: evidence.source,
    sourceKey: evidence.sourceKey,
    unavailableReason: '',
    quality: evidence.quality || 'observed',
    observations: evidence.observations.map((observation) => ({
      name: observation.name,
      value: observation.value,
      year: observation.year,
      unit: observation.unit,
      source: observation.source,
      indicatorCode: observation.indicatorCode || '',
    })),
  };
}

export function toPublicPillar(pillar: ScorecardPillar, result: PillarResult): FiveFactorPillar {
  return {
    pillar,
    hasScore: result.hasScore,
    score: result.score ?? 0,
    subScore: result.subScore ?? 0,
    band: result.band ?? '',
    inputCoverage: result.inputCoverage,
    aggregationMethod: result.aggregationMethod,
    inputs: result.inputs.map(toPublicEvidence),
    insufficientReasons: result.insufficientReasons,
    includedMembers: result.includedMembers,
    excludedMembers: result.excludedMembers,
  };
}

export function toPublicCountryScorecard(result: CountryScorecardResult, computedAt: string): FiveFactorCountryScorecard {
  return {
    countryCode: result.countryCode,
    methodologyVersion: result.methodologyVersion,
    computedAt,
    pillars: SCORECARD_PILLARS.map((pillar) => toPublicPillar(pillar, result.pillars[pillar])),
  };
}

export function toPublicBlocScorecard(result: BlocScorecardResult, computedAt: string): FiveFactorBlocScorecard {
  return {
    id: result.id,
    label: result.label,
    methodologyVersion: result.methodologyVersion,
    computedAt,
    members: result.members,
    includedMembers: result.includedMembers,
    excludedMembers: result.excludedMembers,
    pillars: SCORECARD_PILLARS.map((pillar) => toPublicPillar(pillar, result.pillars[pillar])),
  };
}
