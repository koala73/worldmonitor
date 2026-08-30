import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  decideIndicatorRawRedistribution,
  INDICATOR_SOURCE_POLICIES,
} from '../server/worldmonitor/resilience/v1/_indicator-source-policy.ts';

const WORLD_BANK = { providerName: 'World Bank Open Data', sourceUrl: 'https://api.worldbank.org/v2/country/PT/indicator/SE.SEC.CUAT.UP.FE.ZS' };
const OWID = { providerName: 'Our World in Data', sourceUrl: 'https://ourworldindata.org/grapher/share-electricity-low-carbon' };
const UNESCO_VIA_WDI = {
  providerName: 'UNESCO Institute for Statistics via World Bank WDI',
  sourceUrl: 'https://api.worldbank.org/v2/country/PT/indicator/SE.SEC.CUAT.UP.FE.ZS',
};

describe('resilience indicator raw-source policy', () => {
  it('is exhaustive and unique for all 72 registry indicators', () => {
    const registryIds = INDICATOR_REGISTRY.map((indicator) => indicator.id);
    const policyIds = Object.keys(INDICATOR_SOURCE_POLICIES);
    assert.equal(registryIds.length, 72);
    assert.equal(new Set(registryIds).size, registryIds.length);
    assert.deepEqual(policyIds.toSorted(), registryIds.toSorted());
  });

  it('allows observed values only for exact audited World Bank and OWID provenance', () => {
    for (const [indicatorId, source] of [
      ['fxReservesAdequacy', WORLD_BANK],
      ['femaleUpperSecondaryAttainment', UNESCO_VIA_WDI],
      ['lowCarbonGenerationShare', OWID],
    ] as const) {
      const decision = decideIndicatorRawRedistribution({ indicatorId, observationState: 'observed', sources: [source] });
      assert.equal(decision.expose, true, indicatorId);
      assert.equal(decision.status, 'allow', indicatorId);
      assert.equal(decision.reason, 'audited-observed-source', indicatorId);
      assert.match(decision.licenseLabel, /CC BY 4\.0/);
      assert.ok(decision.attribution.length > 0);
    }
  });

  it('rejects a provider host or documentation URL that is outside the reviewed source path', () => {
    for (const sourceUrl of [
      'https://data.worldbank.org/indicator/FI.RES.TOTL.MO',
      'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets',
      'https://api.worldbank.org/v1/country/DE/indicator/FI.RES.TOTL.MO',
    ]) {
      const decision = decideIndicatorRawRedistribution({
        indicatorId: 'fxReservesAdequacy',
        observationState: 'observed',
        sources: [{ providerName: 'World Bank Open Data', sourceUrl }],
      });
      assert.equal(decision.expose, false, sourceUrl);
      assert.equal(decision.reason, 'provider-not-audited-for-redistribution', sourceUrl);
    }
  });

  it('denies explicitly restricted BIS, GPI, and UCDP values', () => {
    for (const indicatorId of ['householdDebtService', 'gpiScore', 'ucdpConflict', 'recoveryConflictPressure']) {
      const decision = decideIndicatorRawRedistribution({
        indicatorId,
        observationState: 'observed',
        sources: [{ providerName: 'claimed open provider' }],
      });
      assert.equal(decision.expose, false, indicatorId);
      assert.equal(decision.status, 'restricted', indicatorId);
      assert.equal(decision.reason, 'redistribution-restricted', indicatorId);
    }
  });

  it('denies audit-incomplete sources despite permissive legacy registry labels', () => {
    for (const indicatorId of ['govRevenuePct', 'uhcIndex', 'recoveryImportHhi', 'energyPriceStress']) {
      const decision = decideIndicatorRawRedistribution({
        indicatorId,
        observationState: 'observed',
        sources: [{ providerName: 'World Bank Open Data' }],
      });
      assert.equal(decision.expose, false, indicatorId);
      assert.equal(decision.status, 'audit-incomplete', indicatorId);
      assert.equal(decision.reason, 'source-audit-incomplete', indicatorId);
    }
  });

  it('requires every constituent of a conditional observation to be audited', () => {
    const worldBankEnergy = decideIndicatorRawRedistribution({
      indicatorId: 'energyImportDependency',
      observationState: 'observed',
      sources: [WORLD_BANK],
    });
    assert.equal(worldBankEnergy.expose, true);
    assert.equal(worldBankEnergy.policyStatus, 'conditional');

    const eurostatEnergy = decideIndicatorRawRedistribution({
      indicatorId: 'energyImportDependency',
      observationState: 'observed',
      sources: [{ providerName: 'Eurostat', sourceUrl: 'https://ec.europa.eu/eurostat/' }],
    });
    assert.equal(eurostatEnergy.expose, false);
    assert.equal(eurostatEnergy.reason, 'provider-not-audited-for-redistribution');

    const adjustedLiquidReserves = decideIndicatorRawRedistribution({
      indicatorId: 'recoveryLiquidReserveMonths',
      observationState: 'observed',
      sources: [WORLD_BANK, { providerName: 'UN Comtrade', sourceUrl: 'https://comtradeplus.un.org/' }],
    });
    assert.equal(adjustedLiquidReserves.expose, false);
    assert.equal(adjustedLiquidReserves.reason, 'provider-not-audited-for-redistribution');

    const auditedFossil = decideIndicatorRawRedistribution({
      indicatorId: 'importedFossilDependence',
      observationState: 'observed',
      sources: [OWID, WORLD_BANK],
    });
    assert.equal(auditedFossil.expose, true);

    const missingOwidFossil = decideIndicatorRawRedistribution({
      indicatorId: 'importedFossilDependence',
      observationState: 'observed',
      sources: [WORLD_BANK],
    });
    assert.equal(missingOwidFossil.expose, false);
    assert.equal(missingOwidFossil.reason, 'required-provider-provenance-missing');

    const eurostatFossil = decideIndicatorRawRedistribution({
      indicatorId: 'importedFossilDependence',
      observationState: 'observed',
      sources: [OWID, { providerName: 'Eurostat' }],
    });
    assert.equal(eurostatFossil.expose, false);
    assert.equal(eurostatFossil.reason, 'provider-not-audited-for-redistribution');

    const contradictoryHint = decideIndicatorRawRedistribution({
      indicatorId: 'energyImportDependency',
      observationState: 'observed',
      sources: [{ providerName: 'World Bank Open Data', sourceUrl: 'https://ec.europa.eu/eurostat/' }],
    });
    assert.equal(contradictoryHint.expose, false);
    assert.equal(contradictoryHint.reason, 'provider-not-audited-for-redistribution');
  });

  it('requires exact UNESCO UIS via WDI provenance for the education raw value', () => {
    const plainWorldBank = decideIndicatorRawRedistribution({
      indicatorId: 'femaleUpperSecondaryAttainment',
      observationState: 'observed',
      sources: [WORLD_BANK],
    });
    assert.equal(plainWorldBank.expose, false);

    const uis = decideIndicatorRawRedistribution({
      indicatorId: 'femaleUpperSecondaryAttainment',
      observationState: 'observed',
      sources: [UNESCO_VIA_WDI],
    });
    assert.equal(uis.expose, true);
    assert.match(uis.attribution, /UNESCO Institute for Statistics/);
  });

  it('defaults to deny for unknown indicators and absent provider provenance', () => {
    const unknown = decideIndicatorRawRedistribution({ indicatorId: 'futureIndicator', observationState: 'observed' });
    assert.equal(unknown.expose, false);
    assert.equal(unknown.status, 'unknown-indicator');

    const unspecified = decideIndicatorRawRedistribution({ indicatorId: 'fxReservesAdequacy', observationState: 'observed' });
    assert.equal(unspecified.expose, false);
    assert.equal(unspecified.reason, 'provider-provenance-required');
  });

  it('never exposes raw values for imputed, fallback, missing, or inactive rows', () => {
    for (const observationState of [
      'imputed',
      'fallback',
      'missing',
      'inactive',
      'retired',
      'not-applicable',
      'source-failure',
    ] as const) {
      const decision = decideIndicatorRawRedistribution({
        indicatorId: 'fxReservesAdequacy',
        observationState,
        sources: [WORLD_BANK],
      });
      assert.equal(decision.expose, false, observationState);
      assert.equal(decision.status, 'ineligible-observation', observationState);
      assert.equal(decision.reason, 'observation-not-observed', observationState);
    }
  });
});
