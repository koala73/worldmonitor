import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adaptCountryEvidence } from '../server/worldmonitor/scorecard/v1/_source-adapters';

function sourceFixture() {
  return {
    population: { countries: { US: { populationMillions: 333, year: 2024 } } },
    foodStocks: {
      US: {
        commodities: {
          wheat: { marketingYear: '2024/25', production: 60, consumption: 50, exports: 10, endingStocks: 12 },
          rice: { marketingYear: '2024/25', production: 20, consumption: 25, exports: 0, endingStocks: 5 },
        },
      },
    },
    demographics: {
      stages: { wpp: { status: 'fresh' }, education: { status: 'fresh' }, ilostat: { status: 'fresh' } },
      countries: {
        US: {
          ageStructure: {
            totalDependencyRatioPercent: { value: 55, year: 2026, source: 'UN WPP' },
            oldAgeDependencyRatioPercent: { value: 28, year: 2026, source: 'UN WPP' },
            workingAgePopulationPeople: { value: 220, year: 2026, source: 'UN WPP' },
            workingAgePopulationProjected10yPeople: { value: 215, year: 2036, source: 'UN WPP' },
          },
          education: {
            tertiaryEnrollmentGrossPercent: { value: 88, year: 2023, source: 'World Bank' },
            researchersPerMillion: { value: 4600, year: 2022, source: 'World Bank' },
            stemGraduatesSharePercent: { value: 28, year: 2023, source: 'World Bank' },
          },
          industrialWorkforce: {
            trainedIndustrialWorkforcePeople: { value: 26, year: 2024, source: 'ILOSTAT' },
            manufacturingEmploymentSharePercent: { value: 10, year: 2024, source: 'ILOSTAT' },
          },
        },
      },
    },
    defense: {
      countries: {
        US: {
          expenditurePctGdp: { value: 3.4, year: 2024, source: 'World Bank' },
          expenditureUsd: { value: 900_000_000_000, year: 2024, source: 'World Bank' },
          personnel: { value: 1_300_000, year: 2024, source: 'World Bank' },
          armsExportsTiv: { value: 10_000, year: 2024, source: 'World Bank' },
          armsImportsTiv: { value: 1_000, year: 2024, source: 'World Bank' },
        },
      },
    },
    energyMix: {
      US: { year: 2023, primaryEnergyConsumptionTwh: 25_000, importShare: -8 },
    },
    staticByCountry: {
      US: {
        aquastat: { value: 25, year: 2022, source: 'worldbank-aquastat' },
        infrastructure: [{ indicator: 'EG.ELC.ACCS.ZS', value: 100, year: 2023 }],
      },
    },
    lowCarbon: { countries: { US: { value: 42, year: 2023 } } },
    powerLosses: { countries: { US: { value: 5, year: 2022 } } },
    importHhi: { countries: { US: { hhi: 0.12, year: 2023 } } },
    techByIso2: {
      US: {
        observations: {
          internet: { value: 97, year: 2023, unit: 'percent', indicatorCode: 'IT.NET.USER.ZS', source: 'World Bank' },
          mobile: { value: 110, year: 2023, unit: 'per 100 people', indicatorCode: 'IT.CEL.SETS.P2', source: 'World Bank' },
          broadband: { value: 38, year: 2023, unit: 'per 100 people', indicatorCode: 'IT.NET.BBND.P2', source: 'World Bank' },
          rdSpend: { value: 3.5, year: 2022, unit: 'percent of GDP', indicatorCode: 'GB.XPD.RSDV.GD.ZS', source: 'World Bank' },
        },
      },
    },
  };
}

describe('five-factor source adapters', () => {
  it('adds a physical energy balance with source-preserving observations', () => {
    const evidence = adaptCountryEvidence('US', sourceFixture());
    const balance = evidence.inputs['energy.productionBalance'];
    assert.equal(balance.availability, 'available');
    if (balance.availability !== 'available') return;
    assert.equal(balance.aggregation?.denominator, 25_000);
    assert.equal(balance.aggregation?.numerator, 27_000);
    assert.equal(balance.value, 1.08);
    assert.deepEqual(balance.observations.map((observation) => observation.name), [
      'primaryEnergyConsumptionTwh',
      'netEnergyImportsPercent',
      'primaryEnergyProductionTwh',
    ]);
  });

  it('keeps raw World Bank technology values, years, units, and indicator codes', () => {
    const evidence = adaptCountryEvidence('US', sourceFixture());
    const internet = evidence.inputs['technology.internetUse'];
    assert.equal(internet.availability, 'available');
    if (internet.availability !== 'available') return;
    assert.equal(internet.value, 97);
    assert.equal(internet.observations[0]?.indicatorCode, 'IT.NET.USER.ZS');
    assert.equal(internet.year, 2023);
    assert.equal(internet.source, 'World Bank');
  });

  it('aggregates food commodities in calorie-equivalent units', () => {
    const evidence = adaptCountryEvidence('US', sourceFixture());
    const production = evidence.inputs['food.productionBalance'];
    const stocks = evidence.inputs['food.stocksToUse'];
    assert.equal(production.availability, 'available');
    assert.equal(stocks.availability, 'available');
    if (production.availability !== 'available' || stocks.availability !== 'available') return;
    assert.ok(production.aggregation!.numerator > production.aggregation!.denominator);
    assert.equal(production.unit, 'ratio');
    assert.ok(stocks.aggregation!.denominator > stocks.aggregation!.numerator);
  });

  it('does not let a newer incomplete commodity advance an aggregate evidence year', () => {
    const sources = sourceFixture();
    sources.foodStocks.US.commodities.corn = {
      marketingYear: '2025/26', production: null, consumption: null, exports: 0, endingStocks: null,
    } as never;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.inputs['food.productionBalance'].availability, 'available');
    assert.equal(evidence.inputs['food.productionBalance'].availability === 'available' && evidence.inputs['food.productionBalance'].year, 2024);
    assert.equal(evidence.inputs['food.stocksToUse'].availability === 'available' && evidence.inputs['food.stocksToUse'].year, 2024);
  });

  it('reads the landed nested infrastructure indicator shape', () => {
    const sources = sourceFixture();
    sources.staticByCountry.US.infrastructure = {
      indicators: {
        'EG.ELC.ACCS.ZS': { indicatorCode: 'EG.ELC.ACCS.ZS', value: 99.7, year: 2022, source: 'World Bank' },
      },
    } as never;
    const electricity = adaptCountryEvidence('US', sources).inputs['technology.electricityAccess'];
    assert.equal(electricity.availability, 'available');
    assert.equal(electricity.availability === 'available' && electricity.value, 99.7);
    assert.equal(electricity.availability === 'available' && electricity.year, 2022);
  });

  it('never coerces explicit null source values to zero', () => {
    const sources = sourceFixture();
    sources.population.countries.US.populationMillions = null as never;
    sources.techByIso2.US.observations.internet.value = null as never;
    sources.foodStocks.US.commodities.wheat.production = null as never;
    sources.foodStocks.US.commodities.rice.production = null as never;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.population.availability, 'unavailable');
    assert.equal(evidence.inputs['technology.internetUse'].availability, 'unavailable');
    assert.equal(evidence.inputs['food.productionBalance'].availability, 'unavailable');
  });

  it('propagates retained and unavailable demographics stage quality independently', () => {
    const sources = sourceFixture();
    sources.demographics.stages.education.status = 'retained';
    sources.demographics.stages.ilostat.status = 'unavailable';
    const evidence = adaptCountryEvidence('US', sources);
    const tertiary = evidence.inputs['demographics.tertiaryEnrollment'];
    const researchers = evidence.inputs['technology.researchersPerMillion'];
    const industrial = evidence.inputs['demographics.manufacturingEmploymentShare'];
    assert.equal(tertiary.availability === 'available' && tertiary.quality, 'retained');
    assert.equal(researchers.availability === 'available' && researchers.quality, 'retained');
    assert.equal(industrial.availability === 'unavailable' && industrial.reason, 'source-unavailable');
  });

  it('marks supplier diversity policy-unavailable without storing supplier data', () => {
    const evidence = adaptCountryEvidence('US', sourceFixture());
    assert.deepEqual(evidence.inputs['defense.supplierDiversity'], {
      availability: 'unavailable',
      inputId: 'defense.supplierDiversity',
      reason: 'redistribution-blocked',
      source: 'SIPRI Arms Transfers Database',
      sourceKey: 'military:arms-suppliers:v1',
      detail: 'Partner-facing redistribution is not approved for v1.',
    });
    const hasRawSupplierRows = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      if (Object.prototype.hasOwnProperty.call(value, 'suppliers')) return true;
      return Object.values(value).some(hasRawSupplierRows);
    };
    assert.equal(hasRawSupplierRows(evidence), false);
  });

  it('uses source-unavailable for a missing source and country-unavailable for a country gap', () => {
    const sources = sourceFixture();
    sources.techByIso2 = null as never;
    delete sources.demographics.countries.US;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.inputs['technology.internetUse'].availability, 'unavailable');
    assert.equal(evidence.inputs['technology.internetUse'].availability === 'unavailable' && evidence.inputs['technology.internetUse'].reason, 'source-unavailable');
    assert.equal(evidence.inputs['demographics.totalDependency'].availability === 'unavailable' && evidence.inputs['demographics.totalDependency'].reason, 'country-unavailable');
  });
});
