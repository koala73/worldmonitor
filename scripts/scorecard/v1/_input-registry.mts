import type { ScorecardInputId, ScorecardPillar } from './_types.mts';

export type ScorecardInputDefinition = {
  pillar: ScorecardPillar | null;
  weight: number;
  unit: string;
  sourceKey: string;
  group: string;
  normalization: {
    kind: 'linear' | 'log';
    worst: number;
    best: number;
  };
  blocAggregation: 'none' | 'physical-ratio' | 'population-weighted-component';
};

export const SCORECARD_INPUT_REGISTRY = {
  population: { pillar: null, weight: 0, unit: 'million people', sourceKey: 'economic:imf:labor:v1', group: 'population', normalization: { kind: 'linear', worst: 0, best: 1 }, blocAggregation: 'none' },
  'food.productionBalance': { pillar: 'food', weight: 0.55, unit: 'ratio', sourceKey: 'resilience:food-stocks:v1', group: 'balance', normalization: { kind: 'linear', worst: 0.5, best: 1.25 }, blocAggregation: 'physical-ratio' },
  'food.stocksToUse': { pillar: 'food', weight: 0.25, unit: 'ratio', sourceKey: 'resilience:food-stocks:v1', group: 'buffer', normalization: { kind: 'linear', worst: 0.05, best: 0.25 }, blocAggregation: 'physical-ratio' },
  'food.waterSecurity': { pillar: 'food', weight: 0.15, unit: 'percent water stress', sourceKey: 'resilience:static:{ISO2}', group: 'water', normalization: { kind: 'linear', worst: 100, best: 10 }, blocAggregation: 'population-weighted-component' },
  'food.importDiversity': { pillar: 'food', weight: 0.05, unit: 'HHI', sourceKey: 'resilience:recovery:import-hhi:v1', group: 'trade', normalization: { kind: 'linear', worst: 0.65, best: 0.15 }, blocAggregation: 'population-weighted-component' },
  'energy.productionBalance': { pillar: 'energy', weight: 0.6, unit: 'ratio', sourceKey: 'energy:mix:v1:_all + resilience:static:{ISO2}', group: 'balance', normalization: { kind: 'linear', worst: 0.25, best: 1.25 }, blocAggregation: 'physical-ratio' },
  'energy.lowCarbonShare': { pillar: 'energy', weight: 0.25, unit: 'percent', sourceKey: 'resilience:low-carbon-generation:v1', group: 'generation', normalization: { kind: 'linear', worst: 0, best: 80 }, blocAggregation: 'population-weighted-component' },
  'energy.gridEfficiency': { pillar: 'energy', weight: 0.15, unit: 'percent losses', sourceKey: 'resilience:power-losses:v1', group: 'grid', normalization: { kind: 'linear', worst: 25, best: 3 }, blocAggregation: 'population-weighted-component' },
  'demographics.totalDependency': { pillar: 'demographics', weight: 0.15, unit: 'dependents per 100 working-age people', sourceKey: 'demographics:capability:v1', group: 'age', normalization: { kind: 'linear', worst: 100, best: 35 }, blocAggregation: 'population-weighted-component' },
  'demographics.oldAgeDependency': { pillar: 'demographics', weight: 0.1, unit: 'older dependents per 100 working-age people', sourceKey: 'demographics:capability:v1', group: 'age', normalization: { kind: 'linear', worst: 50, best: 10 }, blocAggregation: 'population-weighted-component' },
  'demographics.workingAgeProjection': { pillar: 'demographics', weight: 0.2, unit: '10-year ratio', sourceKey: 'demographics:capability:v1', group: 'age', normalization: { kind: 'linear', worst: 0.8, best: 1.1 }, blocAggregation: 'population-weighted-component' },
  'demographics.tertiaryEnrollment': { pillar: 'demographics', weight: 0.15, unit: 'percent', sourceKey: 'demographics:capability:v1', group: 'capability', normalization: { kind: 'linear', worst: 20, best: 90 }, blocAggregation: 'population-weighted-component' },
  'demographics.researchersPerMillion': { pillar: 'demographics', weight: 0.1, unit: 'per million people', sourceKey: 'demographics:capability:v1', group: 'capability', normalization: { kind: 'linear', worst: 100, best: 5000 }, blocAggregation: 'population-weighted-component' },
  'demographics.stemGraduateShare': { pillar: 'demographics', weight: 0.1, unit: 'percent', sourceKey: 'demographics:capability:v1', group: 'capability', normalization: { kind: 'linear', worst: 10, best: 40 }, blocAggregation: 'population-weighted-component' },
  'demographics.trainedIndustrialShare': { pillar: 'demographics', weight: 0.15, unit: 'percent', sourceKey: 'demographics:capability:v1', group: 'capability', normalization: { kind: 'linear', worst: 2, best: 25 }, blocAggregation: 'population-weighted-component' },
  'demographics.manufacturingEmploymentShare': { pillar: 'demographics', weight: 0.05, unit: 'percent', sourceKey: 'demographics:capability:v1', group: 'capability', normalization: { kind: 'linear', worst: 5, best: 25 }, blocAggregation: 'population-weighted-component' },
  'technology.internetUse': { pillar: 'technology', weight: 0.2, unit: 'percent', sourceKey: 'economic:worldbank-techreadiness:v1', group: 'connectivity', normalization: { kind: 'linear', worst: 20, best: 95 }, blocAggregation: 'population-weighted-component' },
  'technology.mobileSubscriptions': { pillar: 'technology', weight: 0.1, unit: 'per 100 people', sourceKey: 'economic:worldbank-techreadiness:v1', group: 'connectivity', normalization: { kind: 'linear', worst: 50, best: 150 }, blocAggregation: 'population-weighted-component' },
  'technology.fixedBroadband': { pillar: 'technology', weight: 0.15, unit: 'per 100 people', sourceKey: 'economic:worldbank-techreadiness:v1', group: 'connectivity', normalization: { kind: 'linear', worst: 0, best: 45 }, blocAggregation: 'population-weighted-component' },
  'technology.rdSpend': { pillar: 'technology', weight: 0.25, unit: 'percent of GDP', sourceKey: 'economic:worldbank-techreadiness:v1', group: 'innovation', normalization: { kind: 'linear', worst: 0.2, best: 4 }, blocAggregation: 'population-weighted-component' },
  'technology.researchersPerMillion': { pillar: 'technology', weight: 0.15, unit: 'per million people', sourceKey: 'demographics:capability:v1', group: 'innovation', normalization: { kind: 'linear', worst: 100, best: 5000 }, blocAggregation: 'population-weighted-component' },
  'technology.stemGraduateShare': { pillar: 'technology', weight: 0.1, unit: 'percent', sourceKey: 'demographics:capability:v1', group: 'innovation', normalization: { kind: 'linear', worst: 10, best: 40 }, blocAggregation: 'population-weighted-component' },
  'technology.electricityAccess': { pillar: 'technology', weight: 0.05, unit: 'percent', sourceKey: 'resilience:static:{ISO2}', group: 'infrastructure', normalization: { kind: 'linear', worst: 50, best: 100 }, blocAggregation: 'population-weighted-component' },
  'defense.expenditureUsd': { pillar: 'defense', weight: 0.2, unit: 'current USD', sourceKey: 'military:industrial-base:v1', group: 'posture', normalization: { kind: 'log', worst: 100_000_000, best: 100_000_000_000 }, blocAggregation: 'population-weighted-component' },
  'defense.expenditurePctGdp': { pillar: 'defense', weight: 0.15, unit: 'percent of GDP', sourceKey: 'military:industrial-base:v1', group: 'posture', normalization: { kind: 'linear', worst: 0.5, best: 5 }, blocAggregation: 'population-weighted-component' },
  'defense.personnel': { pillar: 'defense', weight: 0.15, unit: 'people', sourceKey: 'military:industrial-base:v1', group: 'posture', normalization: { kind: 'log', worst: 10_000, best: 1_000_000 }, blocAggregation: 'population-weighted-component' },
  'defense.industrialBalance': { pillar: 'defense', weight: 0.3, unit: 'export share', sourceKey: 'military:industrial-base:v1', group: 'industry', normalization: { kind: 'linear', worst: 0, best: 1 }, blocAggregation: 'population-weighted-component' },
  'defense.supplierDiversity': { pillar: 'defense', weight: 0.2, unit: 'HHI', sourceKey: 'military:arms-suppliers:v1', group: 'industry', normalization: { kind: 'linear', worst: 0.65, best: 0.15 }, blocAggregation: 'population-weighted-component' },
} as const satisfies Record<ScorecardInputId, ScorecardInputDefinition>;

export const SCORECARD_INPUT_REGISTRY_VERSION = '1.0.0' as const;
