import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORECARD_INPUT_REGISTRY,
  SCORECARD_INPUT_REGISTRY_VERSION,
} from '../scripts/scorecard/v1/_input-registry.mts';
import {
  SCORECARD_BAND_LABELS,
  SCORECARD_METHODOLOGY_VERSION,
  SCORECARD_PILLAR_RULES,
} from '../scripts/scorecard/v1/_methodology.mts';
import { SCORECARD_SOURCE_KEYS } from '../scripts/scorecard/v1/_source-registry.mts';
import { SCORECARD_PUBLICATION_FLOORS } from '../scripts/scorecard/v1/_snapshot.mts';

describe('five-factor frozen v1 methodology contract', () => {
  it('pins versions, absolute bands, scoring floors, and publication floors', () => {
    assert.equal(SCORECARD_METHODOLOGY_VERSION, '1.0.0');
    assert.equal(SCORECARD_INPUT_REGISTRY_VERSION, '1.0.0');
    assert.deepEqual(SCORECARD_BAND_LABELS, {
      1: 'severe-deficit',
      2: 'material-deficit',
      3: 'mixed-capability',
      4: 'strong-capability',
      5: 'high-capability',
    });
    assert.deepEqual(SCORECARD_PILLAR_RULES, {
      food: { coverageFloor: 0.7, requiredGroups: [['balance']] },
      energy: { coverageFloor: 0.6, requiredGroups: [['balance']] },
      demographics: { coverageFloor: 0.6, requiredGroups: [['age'], ['capability']] },
      technology: { coverageFloor: 0.65, requiredGroups: [['connectivity'], ['innovation']] },
      defense: { coverageFloor: 0.5, requiredGroups: [['posture'], ['industry']] },
    });
    assert.deepEqual(SCORECARD_PUBLICATION_FLOORS, {
      scoreableCountries: 180,
      populationEvidenceCountries: 150,
      scoreableCountriesByPillar: {
        food: 80,
        energy: 120,
        demographics: 150,
        technology: 120,
        defense: 30,
      },
    });
  });

  it('pins every input weight, source, age limit, normalization, and bloc aggregation rule', () => {
    const compact = Object.fromEntries(Object.entries(SCORECARD_INPUT_REGISTRY).map(([id, input]) => [id, [
      input.pillar,
      input.weight,
      input.unit,
      input.sourceKey,
      input.sourceField,
      input.maxAgeYears,
      input.group,
      input.normalization.kind,
      input.normalization.worst,
      input.normalization.best,
      input.blocAggregation,
    ]]));

    assert.deepEqual(compact, {
      population: [null, 0, 'million people', 'economic:imf:labor:v1', 'population', 3, 'population', 'linear', 0, 1, 'none'],
      'food.productionBalance': ['food', 0.55, 'ratio', 'resilience:food-stocks:v1', 'foodStocks', 3, 'balance', 'linear', 0.5, 1.25, 'physical-ratio'],
      'food.stocksToUse': ['food', 0.25, 'ratio', 'resilience:food-stocks:v1', 'foodStocks', 3, 'buffer', 'linear', 0.05, 0.25, 'physical-ratio'],
      'food.waterSecurity': ['food', 0.15, 'percent water stress', 'resilience:static:{ISO2}', 'staticByCountry', 7, 'water', 'linear', 100, 10, 'population-weighted-component'],
      'food.importDiversity': ['food', 0.05, 'HHI', 'resilience:recovery:import-hhi:v1', 'importHhi', 5, 'trade', 'linear', 0.65, 0.15, 'population-weighted-component'],
      'energy.productionBalance': ['energy', 0.6, 'ratio', 'energy:mix:v1:_all', 'energyMix', 4, 'balance', 'linear', 0.25, 1.25, 'physical-ratio'],
      'energy.lowCarbonShare': ['energy', 0.25, 'percent', 'resilience:low-carbon-generation:v1', 'lowCarbon', 5, 'generation', 'linear', 0, 80, 'population-weighted-component'],
      'energy.gridEfficiency': ['energy', 0.15, 'percent losses', 'resilience:power-losses:v1', 'powerLosses', 7, 'grid', 'linear', 25, 3, 'population-weighted-component'],
      'demographics.totalDependency': ['demographics', 0.15, 'dependents per 100 working-age people', 'demographics:capability:v1', 'demographics', 3, 'age', 'linear', 100, 35, 'population-weighted-component'],
      'demographics.oldAgeDependency': ['demographics', 0.1, 'older dependents per 100 working-age people', 'demographics:capability:v1', 'demographics', 3, 'age', 'linear', 50, 10, 'population-weighted-component'],
      'demographics.workingAgeProjection': ['demographics', 0.2, '10-year ratio', 'demographics:capability:v1', 'demographics', 3, 'age', 'linear', 0.8, 1.1, 'population-weighted-component'],
      'demographics.tertiaryEnrollment': ['demographics', 0.15, 'percent', 'demographics:capability:v1', 'demographics', 7, 'capability', 'linear', 20, 90, 'population-weighted-component'],
      'demographics.researchersPerMillion': ['demographics', 0.1, 'per million people', 'demographics:capability:v1', 'demographics', 7, 'capability', 'linear', 100, 5000, 'population-weighted-component'],
      'demographics.stemGraduateShare': ['demographics', 0.1, 'percent', 'demographics:capability:v1', 'demographics', 7, 'capability', 'linear', 10, 40, 'population-weighted-component'],
      'demographics.trainedIndustrialShare': ['demographics', 0.15, 'percent', 'demographics:capability:v1', 'demographics', 5, 'capability', 'linear', 2, 25, 'population-weighted-component'],
      'demographics.manufacturingEmploymentShare': ['demographics', 0.05, 'percent', 'demographics:capability:v1', 'demographics', 5, 'capability', 'linear', 5, 25, 'population-weighted-component'],
      'technology.internetUse': ['technology', 0.2, 'percent', 'economic:worldbank-techreadiness:v1', 'techByIso2', 7, 'connectivity', 'linear', 20, 95, 'population-weighted-component'],
      'technology.mobileSubscriptions': ['technology', 0.1, 'per 100 people', 'economic:worldbank-techreadiness:v1', 'techByIso2', 7, 'connectivity', 'linear', 50, 150, 'population-weighted-component'],
      'technology.fixedBroadband': ['technology', 0.15, 'per 100 people', 'economic:worldbank-techreadiness:v1', 'techByIso2', 7, 'connectivity', 'linear', 0, 45, 'population-weighted-component'],
      'technology.rdSpend': ['technology', 0.25, 'percent of GDP', 'economic:worldbank-techreadiness:v1', 'techByIso2', 7, 'innovation', 'linear', 0.2, 4, 'population-weighted-component'],
      'technology.researchersPerMillion': ['technology', 0.15, 'per million people', 'demographics:capability:v1', 'demographics', 7, 'innovation', 'linear', 100, 5000, 'population-weighted-component'],
      'technology.stemGraduateShare': ['technology', 0.1, 'percent', 'demographics:capability:v1', 'demographics', 7, 'innovation', 'linear', 10, 40, 'population-weighted-component'],
      'technology.electricityAccess': ['technology', 0.05, 'percent', 'resilience:static:{ISO2}', 'staticByCountry', 7, 'infrastructure', 'linear', 50, 100, 'population-weighted-component'],
      'defense.expenditureUsd': ['defense', 0.2, 'current USD', 'military:industrial-base:v1', 'defense', 5, 'posture', 'log', 100_000_000, 100_000_000_000, 'population-weighted-component'],
      'defense.expenditurePctGdp': ['defense', 0.15, 'percent of GDP', 'military:industrial-base:v1', 'defense', 5, 'posture', 'linear', 0.5, 5, 'population-weighted-component'],
      'defense.personnel': ['defense', 0.15, 'people', 'military:industrial-base:v1', 'defense', 5, 'posture', 'log', 10_000, 1_000_000, 'population-weighted-component'],
      'defense.industrialBalance': ['defense', 0.3, 'export share', 'military:industrial-base:v1', 'defense', 5, 'industry', 'linear', 0, 1, 'population-weighted-component'],
      'defense.supplierDiversity': ['defense', 0.2, 'HHI', 'military:arms-suppliers:v1', null, 5, 'industry', 'linear', 0.65, 0.15, 'population-weighted-component'],
    });
    for (const input of Object.values(SCORECARD_INPUT_REGISTRY)) {
      if (input.sourceField) assert.equal(input.sourceKey, SCORECARD_SOURCE_KEYS[input.sourceField]);
    }
  });
});
