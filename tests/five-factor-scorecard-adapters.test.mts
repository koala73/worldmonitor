import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adaptCountryEvidence, type ScorecardSourceSnapshots } from '../server/worldmonitor/scorecard/v1/_source-adapters';

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
      US: { year: 2023, balanceYear: 2023, primaryEnergyConsumptionTwh: 25_000, balanceImportSharePercent: -8 },
    },
    staticByCountry: {
      US: {
        aquastat: { value: 25, year: 2022, source: 'worldbank-aquastat', indicator: 'water stress' },
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
    assert.equal(balance.sourceKey, 'energy:mix:v1:_all');
    assert.deepEqual(balance.observations.map((observation) => observation.name), [
      'primaryEnergyConsumptionTwh',
      'netEnergyImportsPercent',
      'primaryEnergyProductionTwh',
    ]);
  });

  it('distinguishes missing balance observations from finite invalid denominators', () => {
    const missing = sourceFixture();
    delete (missing.energyMix.US as Partial<typeof missing.energyMix.US>).primaryEnergyConsumptionTwh;
    const missingEnergy = adaptCountryEvidence('US', missing).inputs['energy.productionBalance'];
    assert.equal(missingEnergy.availability === 'unavailable' && missingEnergy.reason, 'country-unavailable');

    const invalidEnergySources = sourceFixture();
    invalidEnergySources.energyMix.US.primaryEnergyConsumptionTwh = 0;
    const invalidEnergy = adaptCountryEvidence('US', invalidEnergySources).inputs['energy.productionBalance'];
    assert.equal(invalidEnergy.availability === 'unavailable' && invalidEnergy.reason, 'invalid-value');

    const invalidFoodSources = sourceFixture();
    invalidFoodSources.foodStocks.US.commodities.wheat.consumption = 0;
    const invalidFood = adaptCountryEvidence('US', invalidFoodSources).inputs['food.productionBalance'];
    assert.equal(invalidFood.availability === 'unavailable' && invalidFood.reason, 'invalid-value');
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

  it('dates the 10-year working-age ratio from its observed baseline', () => {
    const sources = sourceFixture();
    const projection = adaptCountryEvidence('US', sources, 2026).inputs['demographics.workingAgeProjection'];
    assert.equal(projection.availability, 'available');
    assert.equal(projection.availability === 'available' && projection.year, 2026);
    assert.equal(projection.availability === 'available' && projection.observations[1]?.year, 2036);

    const expired = adaptCountryEvidence('US', sources, 2030).inputs['demographics.workingAgeProjection'];
    assert.equal(expired.availability === 'unavailable' && expired.reason, 'stale');

    sources.demographics.countries.US.ageStructure.workingAgePopulationProjected10yPeople.year = 2035;
    const invalid = adaptCountryEvidence('US', sources, 2026).inputs['demographics.workingAgeProjection'];
    assert.equal(invalid.availability === 'unavailable' && invalid.reason, 'invalid-value');
  });

  it('aggregates food commodities in calorie-equivalent units', () => {
    const evidence = adaptCountryEvidence('US', sourceFixture());
    const production = evidence.inputs['food.productionBalance'];
    const stocks = evidence.inputs['food.stocksToUse'];
    assert.equal(production.availability, 'available');
    assert.equal(stocks.availability, 'available');
    if (production.availability !== 'available' || stocks.availability !== 'available') return;
    assert.equal(production.aggregation?.numerator, 0.2724);
    assert.equal(production.aggregation?.denominator, 0.257);
    assert.ok(production.aggregation!.numerator > production.aggregation!.denominator);
    assert.equal(production.unit, 'ratio');
    assert.ok(stocks.aggregation!.denominator > stocks.aggregation!.numerator);
  });

  it('keeps stock evidence when production evidence is unavailable', () => {
    const sources = sourceFixture();
    sources.foodStocks.US.commodities.wheat.production = null as never;
    sources.foodStocks.US.commodities.rice.production = null as never;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.inputs['food.productionBalance'].availability, 'unavailable');
    assert.equal(evidence.inputs['food.stocksToUse'].availability, 'available');
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

  it('dates mixed-year food aggregates from the oldest contributing commodity', () => {
    const sources = sourceFixture();
    sources.foodStocks.US.commodities.wheat.marketingYear = '2021/22';
    sources.foodStocks.US.commodities.rice.marketingYear = '2025/26';
    const evidence = adaptCountryEvidence('US', sources, 2025);
    assert.equal(evidence.inputs['food.productionBalance'].availability === 'unavailable'
      && evidence.inputs['food.productionBalance'].reason, 'stale');
    assert.equal(evidence.inputs['food.stocksToUse'].availability === 'unavailable'
      && evidence.inputs['food.stocksToUse'].reason, 'stale');
  });

  it('accepts only AQUASTAT water-stress observations for the water-security input', () => {
    const sources = sourceFixture();
    sources.staticByCountry.US.aquastat = {
      value: 4000,
      year: 2022,
      source: 'worldbank-aquastat',
      indicator: 'renewable water availability',
    } as never;
    const water = adaptCountryEvidence('US', sources).inputs['food.waterSecurity'];
    assert.equal(water.availability === 'unavailable' && water.reason, 'country-unavailable');
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

  it('marks recovered static observations as retained', () => {
    const sources = sourceFixture();
    Object.assign(sources.staticByCountry.US.aquastat, {
      _recovered: { dataset: 'aquastat', seededAt: '2026-08-29T00:00:00.000Z' },
    });
    sources.staticByCountry.US.infrastructure = {
      indicators: {
        'EG.ELC.ACCS.ZS': { indicatorCode: 'EG.ELC.ACCS.ZS', value: 99.7, year: 2022, source: 'World Bank' },
      },
      _recovered: { dataset: 'infrastructure', seededAt: '2026-08-29T00:00:00.000Z' },
    } as never;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.inputs['food.waterSecurity'].availability === 'available'
      && evidence.inputs['food.waterSecurity'].quality, 'retained');
    assert.equal(evidence.inputs['technology.electricityAccess'].availability === 'available'
      && evidence.inputs['technology.electricityAccess'].quality, 'retained');
  });

  it('never coerces explicit null source values to zero', () => {
    const sources = sourceFixture();
    sources.population.countries.US.populationMillions = null as never;
    sources.techByIso2.US.observations.internet.value = null as never;
    sources.foodStocks.US.commodities.wheat.production = null as never;
    sources.foodStocks.US.commodities.rice.production = null as never;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.inputs.population.availability, 'unavailable');
    assert.equal(evidence.inputs['technology.internetUse'].availability, 'unavailable');
    assert.equal(evidence.inputs['food.productionBalance'].availability, 'unavailable');
  });

  it('rejects boolean, array, and object source values instead of coercing them to numbers', () => {
    const sources = sourceFixture();
    sources.lowCarbon.countries.US.value = false as never;
    sources.powerLosses.countries.US.value = [] as never;
    sources.techByIso2.US.observations.internet.year = [2023] as never;
    sources.foodStocks.US.commodities.wheat.marketingYear = [2024] as never;
    sources.foodStocks.US.commodities.rice.marketingYear = { year: 2024 } as never;
    const evidence = adaptCountryEvidence('US', sources);
    assert.equal(evidence.inputs['energy.lowCarbonShare'].availability === 'unavailable'
      && evidence.inputs['energy.lowCarbonShare'].reason, 'invalid-value');
    assert.equal(evidence.inputs['energy.gridEfficiency'].availability === 'unavailable'
      && evidence.inputs['energy.gridEfficiency'].reason, 'invalid-value');
    assert.equal(evidence.inputs['technology.internetUse'].availability === 'unavailable'
      && evidence.inputs['technology.internetUse'].reason, 'invalid-value');
    assert.equal(evidence.inputs['food.productionBalance'].availability, 'unavailable');
    assert.equal(evidence.inputs['food.stocksToUse'].availability, 'unavailable');
  });

  it('requires complete, same-year arms-transfer observations for the industrial balance', () => {
    const missingSide = sourceFixture();
    missingSide.defense.countries.US.armsImportsTiv.value = null as never;
    assert.equal(adaptCountryEvidence('US', missingSide).inputs['defense.industrialBalance'].availability, 'unavailable');

    const mismatchedYears = sourceFixture();
    mismatchedYears.defense.countries.US.armsImportsTiv.year = 2023;
    assert.equal(adaptCountryEvidence('US', mismatchedYears).inputs['defense.industrialBalance'].availability, 'unavailable');

    const explicitZero = sourceFixture();
    explicitZero.defense.countries.US.armsImportsTiv.value = 0;
    assert.equal(adaptCountryEvidence('US', explicitZero).inputs['defense.industrialBalance'].availability, 'available');
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

  it('applies both WPP and ILOSTAT stage states to the derived trained-workforce share', () => {
    const retained = sourceFixture();
    retained.demographics.stages.wpp.status = 'retained';
    const retainedShare = adaptCountryEvidence('US', retained).inputs['demographics.trainedIndustrialShare'];
    assert.equal(retainedShare.availability === 'available' && retainedShare.quality, 'retained');

    const unavailable = sourceFixture();
    unavailable.demographics.stages.wpp.status = 'unavailable';
    const unavailableShare = adaptCountryEvidence('US', unavailable).inputs['demographics.trainedIndustrialShare'];
    assert.equal(unavailableShare.availability === 'unavailable' && unavailableShare.reason, 'source-unavailable');
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

  it('applies frozen observation-age boundaries and source-envelope staleness', () => {
    const atBoundary = adaptCountryEvidence('US', sourceFixture(), 2027);
    assert.equal(atBoundary.inputs['food.productionBalance'].availability, 'available');

    const beyondBoundary = adaptCountryEvidence('US', sourceFixture(), 2028);
    assert.equal(beyondBoundary.inputs['food.productionBalance'].availability, 'unavailable');
    assert.equal(beyondBoundary.inputs['food.productionBalance'].availability === 'unavailable'
      && beyondBoundary.inputs['food.productionBalance'].reason, 'stale');

    const expiredEnvelope = sourceFixture();
    Object.assign(expiredEnvelope, {
      sourceFreshness: { techByIso2: { status: 'stale', detail: 'content-age contract expired' } },
    });
    const evidence = adaptCountryEvidence('US', expiredEnvelope, 2026);
    assert.equal(evidence.inputs['technology.internetUse'].availability, 'unavailable');
    assert.equal(evidence.inputs['technology.internetUse'].availability === 'unavailable'
      && evidence.inputs['technology.internetUse'].reason, 'stale');
  });

  it('applies static-source freshness per country instead of poisoning the cohort', () => {
    const sources = sourceFixture();
    const sourceFreshness: NonNullable<ScorecardSourceSnapshots['sourceFreshness']> = {
      staticByCountry: {
        status: 'stale',
        detail: 'One country is stale.',
        byCountry: {
          US: { status: 'fresh' },
          CA: { status: 'stale', detail: 'CA static content expired.' },
        },
      },
    };
    Object.assign(sources, { sourceFreshness });
    const fresh = adaptCountryEvidence('US', sources, 2026);
    assert.equal(fresh.inputs['food.waterSecurity'].availability, 'available');
    assert.equal(fresh.inputs['technology.electricityAccess'].availability, 'available');

    sourceFreshness.staticByCountry.byCountry.US = { status: 'stale', detail: 'US static content expired.' };
    const stale = adaptCountryEvidence('US', sources, 2026);
    assert.equal(stale.inputs['food.waterSecurity'].availability === 'unavailable'
      && stale.inputs['food.waterSecurity'].reason, 'stale');
  });
});
