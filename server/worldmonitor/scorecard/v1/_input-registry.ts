// Generated from scripts/scorecard/v1/_input-registry.mts by scripts/generate-scorecard-edge-mirrors.mjs. Do not edit.
import type { ScorecardInputId, ScorecardPillar } from './_types';
import { SCORECARD_SOURCE_KEYS, type ScorecardSourceField } from './_source-registry';

export type ScorecardInputDefinition = {
  pillar: ScorecardPillar | null;
  weight: number;
  unit: string;
  sourceKey: string;
  sourceField: ScorecardSourceField | null;
  maxAgeYears: number;
  group: string;
  normalization: {
    kind: 'linear' | 'log';
    worst: number;
    best: number;
  };
  blocAggregation: 'none' | 'physical-ratio' | 'population-weighted-component';
};

export const SCORECARD_INPUT_REGISTRY = {
  population: { pillar: null, weight: 0, unit: 'million people', sourceKey: SCORECARD_SOURCE_KEYS.population, sourceField: 'population', maxAgeYears: 3, group: 'population', normalization: { kind: 'linear', worst: 0, best: 1 }, blocAggregation: 'none' },
  'food.productionBalance': { pillar: 'food', weight: 0.55, unit: 'ratio', sourceKey: SCORECARD_SOURCE_KEYS.foodStocks, sourceField: 'foodStocks', maxAgeYears: 3, group: 'balance', normalization: { kind: 'linear', worst: 0.5, best: 1.25 }, blocAggregation: 'physical-ratio' },
  'food.stocksToUse': { pillar: 'food', weight: 0.25, unit: 'ratio', sourceKey: SCORECARD_SOURCE_KEYS.foodStocks, sourceField: 'foodStocks', maxAgeYears: 3, group: 'buffer', normalization: { kind: 'linear', worst: 0.05, best: 0.25 }, blocAggregation: 'physical-ratio' },
  'food.waterSecurity': { pillar: 'food', weight: 0.15, unit: 'percent water stress', sourceKey: SCORECARD_SOURCE_KEYS.staticByCountry, sourceField: 'staticByCountry', maxAgeYears: 7, group: 'water', normalization: { kind: 'linear', worst: 100, best: 10 }, blocAggregation: 'population-weighted-component' },
  'food.importDiversity': { pillar: 'food', weight: 0.05, unit: 'HHI', sourceKey: SCORECARD_SOURCE_KEYS.importHhi, sourceField: 'importHhi', maxAgeYears: 5, group: 'trade', normalization: { kind: 'linear', worst: 0.65, best: 0.15 }, blocAggregation: 'population-weighted-component' },
  'energy.productionBalance': { pillar: 'energy', weight: 0.6, unit: 'ratio', sourceKey: SCORECARD_SOURCE_KEYS.energyMix, sourceField: 'energyMix', maxAgeYears: 4, group: 'balance', normalization: { kind: 'linear', worst: 0.25, best: 1.25 }, blocAggregation: 'physical-ratio' },
  'energy.lowCarbonShare': { pillar: 'energy', weight: 0.25, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.lowCarbon, sourceField: 'lowCarbon', maxAgeYears: 5, group: 'generation', normalization: { kind: 'linear', worst: 0, best: 80 }, blocAggregation: 'population-weighted-component' },
  'energy.gridEfficiency': { pillar: 'energy', weight: 0.15, unit: 'percent losses', sourceKey: SCORECARD_SOURCE_KEYS.powerLosses, sourceField: 'powerLosses', maxAgeYears: 7, group: 'grid', normalization: { kind: 'linear', worst: 25, best: 3 }, blocAggregation: 'population-weighted-component' },
  'demographics.totalDependency': { pillar: 'demographics', weight: 0.15, unit: 'dependents per 100 working-age people', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 3, group: 'age', normalization: { kind: 'linear', worst: 100, best: 35 }, blocAggregation: 'population-weighted-component' },
  'demographics.oldAgeDependency': { pillar: 'demographics', weight: 0.1, unit: 'older dependents per 100 working-age people', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 3, group: 'age', normalization: { kind: 'linear', worst: 50, best: 10 }, blocAggregation: 'population-weighted-component' },
  'demographics.workingAgeProjection': { pillar: 'demographics', weight: 0.2, unit: '10-year ratio', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 3, group: 'age', normalization: { kind: 'linear', worst: 0.8, best: 1.1 }, blocAggregation: 'population-weighted-component' },
  'demographics.tertiaryEnrollment': { pillar: 'demographics', weight: 0.15, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 7, group: 'capability', normalization: { kind: 'linear', worst: 20, best: 90 }, blocAggregation: 'population-weighted-component' },
  'demographics.researchersPerMillion': { pillar: 'demographics', weight: 0.1, unit: 'per million people', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 7, group: 'capability', normalization: { kind: 'linear', worst: 100, best: 5000 }, blocAggregation: 'population-weighted-component' },
  'demographics.stemGraduateShare': { pillar: 'demographics', weight: 0.1, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 7, group: 'capability', normalization: { kind: 'linear', worst: 10, best: 40 }, blocAggregation: 'population-weighted-component' },
  'demographics.trainedIndustrialShare': { pillar: 'demographics', weight: 0.15, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 5, group: 'capability', normalization: { kind: 'linear', worst: 2, best: 25 }, blocAggregation: 'population-weighted-component' },
  'demographics.manufacturingEmploymentShare': { pillar: 'demographics', weight: 0.05, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 5, group: 'capability', normalization: { kind: 'linear', worst: 5, best: 25 }, blocAggregation: 'population-weighted-component' },
  'technology.internetUse': { pillar: 'technology', weight: 0.2, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.techByIso2, sourceField: 'techByIso2', maxAgeYears: 7, group: 'connectivity', normalization: { kind: 'linear', worst: 20, best: 95 }, blocAggregation: 'population-weighted-component' },
  'technology.mobileSubscriptions': { pillar: 'technology', weight: 0.1, unit: 'per 100 people', sourceKey: SCORECARD_SOURCE_KEYS.techByIso2, sourceField: 'techByIso2', maxAgeYears: 7, group: 'connectivity', normalization: { kind: 'linear', worst: 50, best: 150 }, blocAggregation: 'population-weighted-component' },
  'technology.fixedBroadband': { pillar: 'technology', weight: 0.15, unit: 'per 100 people', sourceKey: SCORECARD_SOURCE_KEYS.techByIso2, sourceField: 'techByIso2', maxAgeYears: 7, group: 'connectivity', normalization: { kind: 'linear', worst: 0, best: 45 }, blocAggregation: 'population-weighted-component' },
  'technology.rdSpend': { pillar: 'technology', weight: 0.25, unit: 'percent of GDP', sourceKey: SCORECARD_SOURCE_KEYS.techByIso2, sourceField: 'techByIso2', maxAgeYears: 7, group: 'innovation', normalization: { kind: 'linear', worst: 0.2, best: 4 }, blocAggregation: 'population-weighted-component' },
  'technology.researchersPerMillion': { pillar: 'technology', weight: 0.15, unit: 'per million people', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 7, group: 'innovation', normalization: { kind: 'linear', worst: 100, best: 5000 }, blocAggregation: 'population-weighted-component' },
  'technology.stemGraduateShare': { pillar: 'technology', weight: 0.1, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.demographics, sourceField: 'demographics', maxAgeYears: 7, group: 'innovation', normalization: { kind: 'linear', worst: 10, best: 40 }, blocAggregation: 'population-weighted-component' },
  'technology.electricityAccess': { pillar: 'technology', weight: 0.05, unit: 'percent', sourceKey: SCORECARD_SOURCE_KEYS.staticByCountry, sourceField: 'staticByCountry', maxAgeYears: 7, group: 'infrastructure', normalization: { kind: 'linear', worst: 50, best: 100 }, blocAggregation: 'population-weighted-component' },
  'defense.expenditureUsd': { pillar: 'defense', weight: 0.2, unit: 'current USD', sourceKey: SCORECARD_SOURCE_KEYS.defense, sourceField: 'defense', maxAgeYears: 5, group: 'posture', normalization: { kind: 'log', worst: 100_000_000, best: 100_000_000_000 }, blocAggregation: 'population-weighted-component' },
  'defense.expenditurePctGdp': { pillar: 'defense', weight: 0.15, unit: 'percent of GDP', sourceKey: SCORECARD_SOURCE_KEYS.defense, sourceField: 'defense', maxAgeYears: 5, group: 'posture', normalization: { kind: 'linear', worst: 0.5, best: 5 }, blocAggregation: 'population-weighted-component' },
  'defense.personnel': { pillar: 'defense', weight: 0.15, unit: 'people', sourceKey: SCORECARD_SOURCE_KEYS.defense, sourceField: 'defense', maxAgeYears: 5, group: 'posture', normalization: { kind: 'log', worst: 10_000, best: 1_000_000 }, blocAggregation: 'population-weighted-component' },
  'defense.industrialBalance': { pillar: 'defense', weight: 0.3, unit: 'export share', sourceKey: SCORECARD_SOURCE_KEYS.defense, sourceField: 'defense', maxAgeYears: 5, group: 'industry', normalization: { kind: 'linear', worst: 0, best: 1 }, blocAggregation: 'population-weighted-component' },
  'defense.supplierDiversity': { pillar: 'defense', weight: 0.2, unit: 'HHI', sourceKey: 'military:arms-suppliers:v1', sourceField: null, maxAgeYears: 5, group: 'industry', normalization: { kind: 'linear', worst: 0.65, best: 0.15 }, blocAggregation: 'population-weighted-component' },
} as const satisfies Record<ScorecardInputId, ScorecardInputDefinition>;

export const SCORECARD_INPUT_REGISTRY_VERSION = '1.0.0' as const;
