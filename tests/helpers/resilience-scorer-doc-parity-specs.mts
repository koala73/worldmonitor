import type { IndicatorSpec } from '../../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import type { ResilienceDimensionId } from '../../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

export interface ScorerDocParityIndicatorSpec {
  id: string;
  dimension: ResilienceDimensionId;
  methodologySection: string;
  methodologyDirection: string;
  registryDirection: IndicatorSpec['direction'];
  methodologyGoalposts: string;
  registryGoalposts: IndicatorSpec['goalposts'];
  weight: number;
  sourceKey?: string;
  tier?: IndicatorSpec['tier'];
}

export const SCORER_DOC_PARITY_SPECS = [
  {
    id: 'electricityAccess',
    dimension: 'infrastructure',
    methodologySection: 'Infrastructure',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '40 - 100',
    registryGoalposts: { worst: 40, best: 100 },
    weight: 0.30,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'roadsPavedInfra',
    dimension: 'infrastructure',
    methodologySection: 'Infrastructure',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '0 - 100',
    registryGoalposts: { worst: 0, best: 100 },
    weight: 0.30,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'infraOutages',
    dimension: 'infrastructure',
    methodologySection: 'Infrastructure',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '20 - 0',
    registryGoalposts: { worst: 20, best: 0 },
    weight: 0.25,
    sourceKey: 'infra:outages:v1',
    tier: 'core',
  },
  {
    id: 'broadband',
    dimension: 'infrastructure',
    methodologySection: 'Infrastructure',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '0 - 40',
    registryGoalposts: { worst: 0, best: 40 },
    weight: 0.15,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'gpiScore',
    dimension: 'socialCohesion',
    methodologySection: 'Social Cohesion',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '3.6 - 1.0',
    registryGoalposts: { worst: 3.6, best: 1 },
    weight: 0.55,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'enrichment',
  },
  {
    id: 'displacementTotal',
    dimension: 'socialCohesion',
    methodologySection: 'Social Cohesion',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '7 - 0',
    registryGoalposts: { worst: 7, best: 0 },
    weight: 0.25,
    sourceKey: 'displacement:summary:v1:{year}',
    tier: 'core',
  },
  {
    id: 'unrestEvents',
    dimension: 'socialCohesion',
    methodologySection: 'Social Cohesion',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '10 - 0',
    registryGoalposts: { worst: 10, best: 0 },
    weight: 0.20,
    sourceKey: 'unrest:events:v1',
    tier: 'core',
  },
  {
    id: 'ucdpConflict',
    dimension: 'borderSecurity',
    methodologySection: 'Conflict & Displacement',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '15 - 0',
    registryGoalposts: { worst: 15, best: 0 },
    weight: 0.65,
    sourceKey: 'conflict:ucdp-events:v1',
    tier: 'core',
  },
  {
    id: 'displacementHosted',
    dimension: 'borderSecurity',
    methodologySection: 'Conflict & Displacement',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '7 - 0',
    registryGoalposts: { worst: 7, best: 0 },
    weight: 0.35,
    sourceKey: 'displacement:summary:v1:{year}',
    tier: 'core',
  },
  {
    id: 'rsfPressFreedom',
    dimension: 'informationCognitive',
    methodologySection: 'Information & Cognitive',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '100 - 0',
    registryGoalposts: { worst: 100, best: 0 },
    weight: 0.55,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'socialVelocity',
    dimension: 'informationCognitive',
    methodologySection: 'Information & Cognitive',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '3 - 0',
    registryGoalposts: { worst: 3, best: 0 },
    weight: 0.15,
    sourceKey: 'intelligence:social:reddit:v1',
    tier: 'core',
  },
  {
    id: 'newsThreatScore',
    dimension: 'informationCognitive',
    methodologySection: 'Information & Cognitive',
    methodologyDirection: 'Lower is better',
    registryDirection: 'lowerBetter',
    methodologyGoalposts: '20 - 0',
    registryGoalposts: { worst: 20, best: 0 },
    weight: 0.30,
    sourceKey: 'news:threat:summary:v1',
    tier: 'core',
  },
  {
    id: 'uhcIndex',
    dimension: 'healthPublicService',
    methodologySection: 'Health & Public Service',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '40 - 90',
    registryGoalposts: { worst: 40, best: 90 },
    weight: 0.35,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'measlesCoverage',
    dimension: 'healthPublicService',
    methodologySection: 'Health & Public Service',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '50 - 99',
    registryGoalposts: { worst: 50, best: 99 },
    weight: 0.25,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'hospitalBeds',
    dimension: 'healthPublicService',
    methodologySection: 'Health & Public Service',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '0 - 8',
    registryGoalposts: { worst: 0, best: 8 },
    weight: 0.10,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'physiciansPer1k',
    dimension: 'healthPublicService',
    methodologySection: 'Health & Public Service',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '0 - 5',
    registryGoalposts: { worst: 0, best: 5 },
    weight: 0.15,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
  {
    id: 'healthExpPerCapitaUsd',
    dimension: 'healthPublicService',
    methodologySection: 'Health & Public Service',
    methodologyDirection: 'Higher is better',
    registryDirection: 'higherBetter',
    methodologyGoalposts: '20 - 3000',
    registryGoalposts: { worst: 20, best: 3000 },
    weight: 0.15,
    sourceKey: 'resilience:static:{ISO2}',
    tier: 'core',
  },
] as const satisfies readonly ScorerDocParityIndicatorSpec[];

export const STATIC_SCORER_CATALOG_PARITY_IDS = [
  'broadband',
  'physiciansPer1k',
  'healthExpPerCapitaUsd',
] as const;

export function scorerDocParitySpecsBySection(): Map<string, readonly ScorerDocParityIndicatorSpec[]> {
  const bySection = new Map<string, ScorerDocParityIndicatorSpec[]>();
  for (const spec of SCORER_DOC_PARITY_SPECS) {
    const specs = bySection.get(spec.methodologySection) ?? [];
    specs.push(spec);
    bySection.set(spec.methodologySection, specs);
  }
  return bySection;
}
