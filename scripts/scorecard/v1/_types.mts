export const SCORECARD_PILLARS = ['food', 'energy', 'demographics', 'technology', 'defense'] as const;
export const SCORECARD_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export type ScorecardPillar = typeof SCORECARD_PILLARS[number];
export type ScorecardBand = 1 | 2 | 3 | 4 | 5;

export type ScorecardInputId =
  | 'population'
  | 'food.productionBalance'
  | 'food.stocksToUse'
  | 'food.waterSecurity'
  | 'food.importDiversity'
  | 'energy.productionBalance'
  | 'energy.lowCarbonShare'
  | 'energy.gridEfficiency'
  | 'demographics.totalDependency'
  | 'demographics.oldAgeDependency'
  | 'demographics.workingAgeProjection'
  | 'demographics.tertiaryEnrollment'
  | 'demographics.researchersPerMillion'
  | 'demographics.stemGraduateShare'
  | 'demographics.trainedIndustrialShare'
  | 'demographics.manufacturingEmploymentShare'
  | 'technology.internetUse'
  | 'technology.mobileSubscriptions'
  | 'technology.fixedBroadband'
  | 'technology.rdSpend'
  | 'technology.researchersPerMillion'
  | 'technology.stemGraduateShare'
  | 'technology.electricityAccess'
  | 'defense.expenditureUsd'
  | 'defense.expenditurePctGdp'
  | 'defense.personnel'
  | 'defense.industrialBalance'
  | 'defense.supplierDiversity';

export type EvidenceUnavailableReason =
  | 'source-unavailable'
  | 'country-unavailable'
  | 'invalid-value'
  | 'stale'
  | 'coverage-below-floor'
  | 'required-group-missing'
  | 'missing-population'
  | 'redistribution-blocked';

export interface SourceObservation {
  name: string;
  value: number;
  year: number;
  unit: string;
  source: string;
  indicatorCode?: string;
}

export interface AvailableScorecardEvidence {
  availability: 'available';
  inputId: ScorecardInputId;
  value: number;
  year: number;
  unit: string;
  source: string;
  sourceKey: string;
  quality?: 'observed' | 'retained' | 'derived';
  observations: SourceObservation[];
  aggregation?: {
    numerator: number;
    denominator: number;
    unit: string;
  };
  countryCode?: string;
}

export interface UnavailableScorecardEvidence {
  availability: 'unavailable';
  inputId: ScorecardInputId;
  reason: EvidenceUnavailableReason;
  source: string;
  sourceKey: string;
  detail?: string;
  countryCode?: string;
}

export type ScorecardEvidence = AvailableScorecardEvidence | UnavailableScorecardEvidence;

export interface CountryScorecardEvidence {
  countryCode: string;
  inputs: Record<ScorecardInputId, ScorecardEvidence>;
}

export type PillarAggregationMethod =
  | 'country-weighted-components'
  | 'aggregate-physical-inputs'
  | 'population-weighted-continuous-score';

export interface PillarResult {
  hasScore: boolean;
  score: ScorecardBand | null;
  subScore: number | null;
  continuousScore: number | null;
  band: string | null;
  inputCoverage: number;
  aggregationMethod: PillarAggregationMethod;
  inputs: ScorecardEvidence[];
  insufficientReasons: EvidenceUnavailableReason[];
  includedMembers: string[];
  excludedMembers: Array<{ countryCode: string; reason: EvidenceUnavailableReason }>;
  memberWeights: Array<{ countryCode: string; populationMillions: number | null }>;
}

export interface CountryScorecardSummary {
  countryCode: string;
  pillars: Record<ScorecardPillar, Pick<PillarResult, 'hasScore' | 'score' | 'subScore' | 'band' | 'inputCoverage' | 'insufficientReasons'>>;
}

export interface FiveFactorReadModelMetadata {
  schemaVersion: typeof SCORECARD_SNAPSHOT_SCHEMA_VERSION;
  methodologyVersion: '1.0.0';
  inputRegistryVersion: '1.0.0';
  computedAt: string;
  sourceStates: Record<string, ScorecardSourceState>;
  countryCodes: string[];
}

export interface CountryScorecardResult {
  countryCode: string;
  methodologyVersion: string;
  pillars: Record<ScorecardPillar, PillarResult>;
}

export interface BlocScorecardResult {
  id: string;
  label: string;
  methodologyVersion: string;
  members: string[];
  includedMembers: string[];
  excludedMembers: Array<{ countryCode: string; reason: EvidenceUnavailableReason }>;
  pillars: Record<ScorecardPillar, PillarResult>;
}

export type ScorecardSourceState = {
  status: 'available' | 'unavailable' | 'stale';
  sourceKey: string;
  detail?: string;
};

export interface FiveFactorSnapshotV1 {
  schemaVersion: typeof SCORECARD_SNAPSHOT_SCHEMA_VERSION;
  methodologyVersion: '1.0.0';
  inputRegistryVersion: '1.0.0';
  computedAt: string;
  sourceStates: Record<string, ScorecardSourceState>;
  countries: Record<string, {
    evidence: CountryScorecardEvidence;
    result: CountryScorecardResult;
  }>;
}
