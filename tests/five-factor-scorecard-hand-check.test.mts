import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import handCheck from './fixtures/five-factor-scorecard-hand-check-v1.json' with { type: 'json' };
import { adaptCountryEvidence } from '../server/worldmonitor/scorecard/v1/_source-adapters.ts';
import { scoreCountry } from '../server/worldmonitor/scorecard/v1/_score-country.ts';
import { SCORECARD_PILLARS } from '../server/worldmonitor/scorecard/v1/_types.ts';

function handCheckCountry(countryCode: string, rawValues: number[]) {
  const [foodBalance, waterStress, energyBalance, totalDependency, workingAgeProjection,
    tertiaryEnrollment, researchers, internetUse, mobileSubscriptions, rdSpend,
    stemGraduateShare, defenseExpenditure, industrialBalance] = rawValues;
  const metric = (value: number, source: string) => ({ value, year: 2024, source });
  return adaptCountryEvidence(countryCode, {
    population: { countries: { [countryCode]: { populationMillions: 10, year: 2024 } } },
    foodStocks: { [countryCode]: { commodities: { wheat: {
      marketingYear: '2024/25', production: foodBalance * 100, consumption: 100,
      exports: 0, endingStocks: null,
    } } } },
    demographics: {
      stages: { wpp: { status: 'fresh' }, education: { status: 'fresh' }, ilostat: { status: 'fresh' } },
      countries: { [countryCode]: {
        ageStructure: {
          totalDependencyRatioPercent: metric(totalDependency, 'UN WPP'),
          oldAgeDependencyRatioPercent: null,
          workingAgePopulationPeople: metric(100, 'UN WPP'),
          workingAgePopulationProjected10yPeople: { value: workingAgeProjection * 100, year: 2034, source: 'UN WPP' },
        },
        education: {
          tertiaryEnrollmentGrossPercent: metric(tertiaryEnrollment, 'World Bank'),
          researchersPerMillion: metric(researchers, 'World Bank'),
          stemGraduatesSharePercent: metric(stemGraduateShare, 'World Bank'),
        },
        industrialWorkforce: {},
      } },
    },
    defense: { countries: { [countryCode]: {
      expenditureUsd: metric(defenseExpenditure, 'World Bank'),
      expenditurePctGdp: null,
      personnel: null,
      armsExportsTiv: metric(industrialBalance * 100, 'World Bank'),
      armsImportsTiv: metric((1 - industrialBalance) * 100, 'World Bank'),
    } } },
    energyMix: { [countryCode]: {
      balanceYear: 2024,
      primaryEnergyConsumptionTwh: 100,
      balanceImportSharePercent: (1 - energyBalance) * 100,
    } },
    staticByCountry: { [countryCode]: {
      aquastat: { ...metric(waterStress, 'worldbank-aquastat'), indicator: 'water stress' },
      infrastructure: null,
    } },
    lowCarbon: null,
    powerLosses: null,
    importHhi: null,
    techByIso2: { [countryCode]: { observations: {
      internet: metric(internetUse, 'World Bank'),
      mobile: metric(mobileSubscriptions, 'World Bank'),
      rdSpend: metric(rdSpend, 'World Bank'),
    } } },
  }, 2026);
}

describe('five-factor scorecard ten-country hand check', () => {
  it('matches the independently frozen anchor table for every pillar', () => {
    assert.equal(handCheck.methodologyVersion, '1.0.0');
    assert.equal(handCheck.countries.length, 10);
    for (const anchor of handCheck.countries) {
      assert.equal(anchor.rawValues.length, handCheck.inputIds.length);
      const result = scoreCountry(handCheckCountry(anchor.countryCode, anchor.rawValues));
      for (const pillarId of SCORECARD_PILLARS) {
        const pillar = result.pillars[pillarId];
        const [expectedSubScore, expectedBand] = anchor.expected[pillarId];
        assert.equal(pillar.hasScore, true, `${anchor.countryCode} ${pillarId} should be scoreable`);
        assert.equal(pillar.score, expectedBand, `${anchor.countryCode} ${pillarId} band drift`);
        assert.ok(Math.abs(pillar.subScore! - expectedSubScore) < 0.01,
          `${anchor.countryCode} ${pillarId} continuous score drift: ${pillar.subScore}`);
      }
    }
  });
});
