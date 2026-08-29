import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SCORECARD_INPUT_REGISTRY } from '../server/worldmonitor/scorecard/v1/_input-registry';
import { bandScore, scoreCountry } from '../server/worldmonitor/scorecard/v1/_score-country';
import { scoreBloc } from '../server/worldmonitor/scorecard/v1/_score-bloc';
import type {
  AvailableScorecardEvidence,
  CountryScorecardEvidence,
  ScorecardInputId,
} from '../server/worldmonitor/scorecard/v1/_types';

function available(
  inputId: ScorecardInputId,
  value: number,
  options: Partial<AvailableScorecardEvidence> = {},
): AvailableScorecardEvidence {
  return {
    availability: 'available',
    inputId,
    value,
    year: 2024,
    unit: SCORECARD_INPUT_REGISTRY[inputId].unit,
    source: 'Test source',
    sourceKey: SCORECARD_INPUT_REGISTRY[inputId].sourceKey,
    observations: [{ name: inputId, value, year: 2024, unit: SCORECARD_INPUT_REGISTRY[inputId].unit, source: 'Test source' }],
    ...options,
  };
}

function unavailable(inputId: ScorecardInputId, reason: 'country-unavailable' | 'redistribution-blocked' = 'country-unavailable') {
  return {
    availability: 'unavailable' as const,
    inputId,
    reason,
    source: 'Test source',
    sourceKey: SCORECARD_INPUT_REGISTRY[inputId].sourceKey,
  };
}

function country(
  countryCode: string,
  populationMillions: number,
  patches: Partial<Record<ScorecardInputId, ReturnType<typeof available>>> = {},
): CountryScorecardEvidence {
  const inputs = Object.fromEntries(
    Object.keys(SCORECARD_INPUT_REGISTRY).map((inputId) => [inputId, unavailable(inputId as ScorecardInputId)]),
  ) as CountryScorecardEvidence['inputs'];
  for (const [inputId, evidence] of Object.entries(patches)) {
    inputs[inputId as ScorecardInputId] = evidence!;
  }
  return {
    countryCode,
    population: available('population', populationMillions),
    inputs,
  };
}

describe('five-factor absolute bands', () => {
  it('flips exactly at every frozen lower boundary', () => {
    assert.equal(bandScore(0), 1);
    assert.equal(bandScore(19.9999), 1);
    assert.equal(bandScore(20), 2);
    assert.equal(bandScore(39.9999), 2);
    assert.equal(bandScore(40), 3);
    assert.equal(bandScore(59.9999), 3);
    assert.equal(bandScore(60), 4);
    assert.equal(bandScore(79.9999), 4);
    assert.equal(bandScore(80), 5);
    assert.equal(bandScore(100), 5);
  });
});

describe('five-factor evidence and coverage', () => {
  it('returns null with explicit unavailable and coverage reasons', () => {
    const result = scoreCountry(country('ZZ', 1));
    for (const pillar of Object.values(result.pillars)) {
      assert.equal(pillar.hasScore, false);
      assert.equal(pillar.score, null);
      assert.equal(pillar.subScore, null);
      assert.ok(pillar.insufficientReasons.includes('coverage-below-floor'));
      assert.ok(pillar.insufficientReasons.includes('country-unavailable'));
    }
  });

  it('preserves source observations in every non-null food result', () => {
    const result = scoreCountry(country('AA', 10, {
      'food.productionBalance': available('food.productionBalance', 1.1, {
        aggregation: { numerator: 110, denominator: 100, unit: 'billion kcal' },
        observations: [
          { name: 'calorieProduction', value: 110, year: 2024, unit: 'billion kcal', source: 'USDA PSD' },
          { name: 'calorieConsumption', value: 100, year: 2024, unit: 'billion kcal', source: 'USDA PSD' },
        ],
      }),
      'food.stocksToUse': available('food.stocksToUse', 0.2, {
        aggregation: { numerator: 20, denominator: 100, unit: 'billion kcal' },
      }),
    }));
    assert.equal(result.pillars.food.hasScore, true);
    assert.equal(result.pillars.food.inputs[0]?.observations.length, 2);
    assert.equal(result.pillars.food.inputs[0]?.observations[0]?.source, 'USDA PSD');
  });

  it('keeps the supplier-policy block explicit while defense remains scoreable from reviewed evidence', () => {
    const evidence = country('AA', 10, {
      'defense.expenditureUsd': available('defense.expenditureUsd', 10_000_000_000),
      'defense.expenditurePctGdp': available('defense.expenditurePctGdp', 2.5),
      'defense.personnel': available('defense.personnel', 100_000),
      'defense.industrialBalance': available('defense.industrialBalance', 0.5),
    });
    evidence.inputs['defense.supplierDiversity'] = unavailable('defense.supplierDiversity', 'redistribution-blocked');
    const defense = scoreCountry(evidence).pillars.defense;
    assert.equal(defense.hasScore, true);
    assert.equal(defense.inputs.find((input) => input.inputId === 'defense.supplierDiversity')?.availability, 'unavailable');
  });
});

describe('five-factor bloc aggregation', () => {
  it('aggregates food raw quantities before scoring instead of averaging member scores', () => {
    const a = country('AA', 1, {
      'food.productionBalance': available('food.productionBalance', 1.5, { aggregation: { numerator: 150, denominator: 100, unit: 'billion kcal' } }),
      'food.stocksToUse': available('food.stocksToUse', 0.25, { aggregation: { numerator: 25, denominator: 100, unit: 'billion kcal' } }),
    });
    const b = country('BB', 1, {
      'food.productionBalance': available('food.productionBalance', 0.5, { aggregation: { numerator: 50, denominator: 100, unit: 'billion kcal' } }),
      'food.stocksToUse': available('food.stocksToUse', 0.05, { aggregation: { numerator: 5, denominator: 100, unit: 'billion kcal' } }),
    });
    const aScore = scoreCountry(a).pillars.food.subScore!;
    const bScore = scoreCountry(b).pillars.food.subScore!;
    const bloc = scoreBloc({ id: 'custom:AA-BB', label: 'AA + BB', members: [a, b] });

    assert.equal(Math.round((aScore + bScore) / 2), 50);
    assert.equal(bloc.pillars.food.score, 4);
    assert.ok(Math.abs(bloc.pillars.food.subScore! - ((aScore + bScore) / 2)) > 5);
    assert.equal(bloc.pillars.food.aggregationMethod, 'aggregate-physical-inputs');
  });

  it('population-weights unrounded continuous demographics scores', () => {
    const strong = country('AA', 1, {
      'demographics.totalDependency': available('demographics.totalDependency', 35),
      'demographics.oldAgeDependency': available('demographics.oldAgeDependency', 10),
      'demographics.workingAgeProjection': available('demographics.workingAgeProjection', 1.1),
      'demographics.tertiaryEnrollment': available('demographics.tertiaryEnrollment', 90),
      'demographics.researchersPerMillion': available('demographics.researchersPerMillion', 5000),
    });
    const weak = country('BB', 9, {
      'demographics.totalDependency': available('demographics.totalDependency', 100),
      'demographics.oldAgeDependency': available('demographics.oldAgeDependency', 50),
      'demographics.workingAgeProjection': available('demographics.workingAgeProjection', 0.8),
      'demographics.tertiaryEnrollment': available('demographics.tertiaryEnrollment', 20),
      'demographics.researchersPerMillion': available('demographics.researchersPerMillion', 100),
    });
    const bloc = scoreBloc({ id: 'custom:AA-BB', label: 'AA + BB', members: [strong, weak] });
    assert.equal(bloc.pillars.demographics.subScore, 10);
    assert.equal(bloc.pillars.demographics.aggregationMethod, 'population-weighted-continuous-score');
  });

  it('selects a bloc band from the unrounded continuous score at an exact boundary', () => {
    const target = 59.9951;
    const member = (countryCode: string) => country(countryCode, 1, {
      'technology.internetUse': available('technology.internetUse', 20 + 75 * target / 100),
      'technology.mobileSubscriptions': available('technology.mobileSubscriptions', 50 + 100 * target / 100),
      'technology.fixedBroadband': available('technology.fixedBroadband', 45 * target / 100),
      'technology.rdSpend': available('technology.rdSpend', 0.2 + 3.8 * target / 100),
    });
    const a = member('AA');
    const b = member('BB');
    assert.equal(scoreCountry(a).pillars.technology.subScore, 60);
    const technology = scoreBloc({ id: 'custom:AA-BB', label: 'AA + BB', members: [a, b] }).pillars.technology;
    assert.equal(technology.subScore, 60);
    assert.equal(technology.score, 3, '59.9951 remains below the frozen 60-point band boundary');
  });

  it('records included and excluded members for each pillar', () => {
    const foodMember = country('AA', 1, {
      'food.productionBalance': available('food.productionBalance', 1.2, { aggregation: { numerator: 120, denominator: 100, unit: 'billion kcal' } }),
      'food.stocksToUse': available('food.stocksToUse', 0.2, { aggregation: { numerator: 20, denominator: 100, unit: 'billion kcal' } }),
      'demographics.totalDependency': available('demographics.totalDependency', 50),
      'demographics.oldAgeDependency': available('demographics.oldAgeDependency', 20),
      'demographics.tertiaryEnrollment': available('demographics.tertiaryEnrollment', 70),
      'demographics.researchersPerMillion': available('demographics.researchersPerMillion', 2000),
      'demographics.trainedIndustrialShare': available('demographics.trainedIndustrialShare', 10),
    });
    const missingPopulation = country('BB', 1, {
      'demographics.totalDependency': available('demographics.totalDependency', 50),
      'demographics.oldAgeDependency': available('demographics.oldAgeDependency', 20),
      'demographics.tertiaryEnrollment': available('demographics.tertiaryEnrollment', 70),
      'demographics.researchersPerMillion': available('demographics.researchersPerMillion', 2000),
      'demographics.trainedIndustrialShare': available('demographics.trainedIndustrialShare', 10),
    });
    missingPopulation.population = unavailable('population');
    const bloc = scoreBloc({ id: 'custom:AA-BB', label: 'AA + BB', members: [foodMember, missingPopulation] });

    assert.deepEqual(bloc.pillars.food.includedMembers, ['AA']);
    assert.deepEqual(bloc.pillars.food.excludedMembers, [{ countryCode: 'BB', reason: 'country-unavailable' }]);
    assert.deepEqual(bloc.pillars.demographics.includedMembers, ['AA']);
    assert.deepEqual(bloc.pillars.demographics.excludedMembers, [{ countryCode: 'BB', reason: 'missing-population' }]);
  });
});

describe('scorecard registry closure', () => {
  it('keeps each pillar weight at one and the registry outside CRI', () => {
    for (const pillar of ['food', 'energy', 'demographics', 'technology', 'defense'] as const) {
      const sum = Object.values(SCORECARD_INPUT_REGISTRY)
        .filter((definition) => definition.pillar === pillar)
        .reduce((total, definition) => total + definition.weight, 0);
      assert.equal(Math.round(sum * 100), 100, `${pillar} weights must total one`);
    }
    assert.equal(SCORECARD_INPUT_REGISTRY.population.pillar, null);
  });
});
