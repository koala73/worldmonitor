import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  decideIndicatorRawRedistribution,
  getIndicatorSourcePolicy,
  getObservedSourceDisplayMetadata,
  INDICATOR_SOURCE_POLICIES,
} from '../server/worldmonitor/resilience/v1/_indicator-source-policy.ts';
import { wgiObservationSource } from '../shared/wgi-source-provenance.js';

const worldBank = (indicatorId: string) => ({
  providerName: 'World Bank Open Data',
  sourceUrl: `https://api.worldbank.org/v2/country/PT/indicator/${indicatorId}`,
});
const WORLD_BANK_FX = worldBank('FI.RES.TOTL.MO');
const WORLD_BANK_ENERGY_IMPORT = worldBank('EG.IMP.CONS.ZS');
const OWID = { providerName: 'Our World in Data', sourceUrl: 'https://ourworldindata.org/grapher/share-electricity-low-carbon' };
const UNESCO_VIA_WDI = {
  providerName: 'UNESCO Institute for Statistics via World Bank WDI',
  sourceUrl: 'https://api.worldbank.org/v2/country/PT/indicator/SE.SEC.CUAT.UP.FE.ZS',
};

const WB = 'World Bank Open Data';
const OWID_PROVIDER = 'Our World in Data';
const rawSource = (providerName: string, sourceUrl: string) => ({ providerName, sourceUrl });
const wdi = (indicatorId: string) => rawSource(WB, `https://api.worldbank.org/v2/country/PT/indicator/${indicatorId}`);
const owidEnergy = () => rawSource(OWID_PROVIDER, 'https://ourworldindata.org/energy');

// Independent licensing contract. Do not derive this table from the
// production policy: a wrong series in that policy must fail this test.
const EXPECTED_RAW_ENABLED_SOURCES = {
  fxReservesAdequacy: [wdi('FI.RES.TOTL.MO')],
  appliedTariffRate: [wdi('TM.TAX.MRCH.WM.AR.ZS')],
  shortTermExternalDebtPctGni: [wdi('DT.DOD.DSTC.CD'), wdi('NY.GNP.MKTP.CD')],
  roadsPavedLogistics: [wdi('IS.ROD.PAVE.ZS')],
  electricityAccess: [wdi('EG.ELC.ACCS.ZS')],
  roadsPavedInfra: [wdi('IS.ROD.PAVE.ZS')],
  broadband: [wdi('IT.NET.BBND.P2')],
  energyImportDependency: [wdi('EG.IMP.CONS.ZS')],
  gasShare: [owidEnergy()],
  coalShare: [owidEnergy()],
  renewShare: [owidEnergy()],
  electricityConsumption: [wdi('EG.USE.ELEC.KH.PC')],
  importedFossilDependence: [wdi('EG.ELC.FOSL.ZS'), wdi('EG.IMP.CONS.ZS')],
  powerLossesPct: [wdi('EG.ELC.LOSS.ZS')],
  wgiVoiceAccountability: [wdi('GOV_WGI_VA.EST')],
  wgiPoliticalStability: [wdi('GOV_WGI_PV.EST')],
  wgiGovernmentEffectiveness: [wdi('GOV_WGI_GE.EST')],
  wgiRegulatoryQuality: [wdi('GOV_WGI_RQ.EST')],
  wgiRuleOfLaw: [wdi('GOV_WGI_RL.EST')],
  wgiControlOfCorruption: [wdi('GOV_WGI_CC.EST')],
  femaleUpperSecondaryAttainment: [UNESCO_VIA_WDI],
  aquastatScore: [wdi('ER.H2O.FWST.ZS')],
  recoveryReserveMonths: [wdi('FI.RES.TOTL.MO')],
  recoveryLiquidReserveMonths: [wdi('FI.RES.TOTL.MO')],
  recoveryDebtToReserves: [wdi('DT.DOD.DSTC.CD'), wdi('FI.RES.TOTL.CD')],
  recoveryWgiContinuity: [
    wdi('GOV_WGI_VA.EST'),
    wdi('GOV_WGI_PV.EST'),
    wdi('GOV_WGI_GE.EST'),
    wdi('GOV_WGI_RQ.EST'),
    wdi('GOV_WGI_RL.EST'),
    wdi('GOV_WGI_CC.EST'),
  ],
} as const;

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
      ['fxReservesAdequacy', WORLD_BANK_FX],
      ['femaleUpperSecondaryAttainment', UNESCO_VIA_WDI],
    ] as const) {
      const decision = decideIndicatorRawRedistribution({ indicatorId, observationState: 'observed', sources: [source] });
      assert.equal(decision.expose, true, indicatorId);
      assert.equal(decision.status, 'allow', indicatorId);
      assert.equal(decision.reason, 'audited-observed-source', indicatorId);
      assert.match(decision.licenseLabel, /CC BY 4\.0/);
      assert.ok(decision.attribution.length > 0);
    }
  });

  it('accepts the exact required paths for every raw-enabled policy', () => {
    const rawEnabledPolicyIds = Object.entries(INDICATOR_SOURCE_POLICIES)
      .filter(([, policy]) => policy.status === 'allow' || policy.status === 'conditional')
      .map(([indicatorId]) => indicatorId)
      .toSorted();
    assert.deepEqual(rawEnabledPolicyIds, Object.keys(EXPECTED_RAW_ENABLED_SOURCES).toSorted());

    for (const [indicatorId, sources] of Object.entries(EXPECTED_RAW_ENABLED_SOURCES)) {
      const decision = decideIndicatorRawRedistribution({
        indicatorId,
        observationState: 'observed',
        sources,
      });
      assert.equal(decision.expose, true, `${indicatorId}: ${decision.reason}`);
      assert.equal(decision.reason, 'audited-observed-source', indicatorId);
    }
  });

  it('denies WGI producer-provenance drift independently of the audit policy', () => {
    const produced = wgiObservationSource('VA.EST');
    const accepted = decideIndicatorRawRedistribution({
      indicatorId: 'wgiVoiceAccountability',
      observationState: 'observed',
      sources: [produced],
    });
    assert.equal(accepted.expose, true);

    const drifted = {
      ...produced,
      sourceUrl: produced.sourceUrl.replace('/GOV_WGI_', '/GOV_WGI_V2_'),
    };
    const denied = decideIndicatorRawRedistribution({
      indicatorId: 'wgiVoiceAccountability',
      observationState: 'observed',
      sources: [drifted],
    });
    assert.equal(denied.expose, false);
    assert.equal(denied.reason, 'provider-not-audited-for-redistribution');
  });

  it('rejects a provider host or documentation URL that is outside the reviewed source path', () => {
    for (const sourceUrl of [
      'https://data.worldbank.org/indicator/FI.RES.TOTL.MO',
      'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets',
      'https://api.worldbank.org/v1/country/DE/indicator/FI.RES.TOTL.MO',
      'https://api.worldbank.org/v2/',
      'https://api.worldbank.org/v2/country/DE/indicator/NY.GDP.MKTP.CD',
      'https://api.worldbank.org/v2/country/DE/indicator/NY.GDP.MKTP.CD?next=/indicator/FI.RES.TOTL.MO',
      'https://api.worldbank.org/v2/country/DE/indicator/FI.RES.TOTL.MO/unreviewed',
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
    for (const indicatorId of ['govRevenuePct', 'uhcIndex', 'recoveryImportHhi', 'energyPriceStress', 'lowCarbonGenerationShare']) {
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
      sources: [WORLD_BANK_ENERGY_IMPORT],
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
      sources: [WORLD_BANK_FX, { providerName: 'UN Comtrade', sourceUrl: 'https://comtradeplus.un.org/' }],
    });
    assert.equal(adjustedLiquidReserves.expose, false);
    assert.equal(adjustedLiquidReserves.reason, 'provider-not-audited-for-redistribution');

    const auditedFossil = decideIndicatorRawRedistribution({
      indicatorId: 'importedFossilDependence',
      observationState: 'observed',
      sources: [
        { providerName: 'World Bank Open Data', sourceUrl: 'https://api.worldbank.org/v2/country/all/indicator/EG.ELC.FOSL.ZS' },
        WORLD_BANK_ENERGY_IMPORT,
      ],
    });
    assert.equal(auditedFossil.expose, true);

    const eurostatFossil = decideIndicatorRawRedistribution({
      indicatorId: 'importedFossilDependence',
      observationState: 'observed',
      sources: [worldBank('EG.ELC.FOSL.ZS'), { providerName: 'Eurostat', sourceUrl: 'https://ec.europa.eu/eurostat/' }],
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
      sources: [WORLD_BANK_FX],
    });
    assert.equal(plainWorldBank.expose, false);

    const uis = decideIndicatorRawRedistribution({
      indicatorId: 'femaleUpperSecondaryAttainment',
      observationState: 'observed',
      sources: [UNESCO_VIA_WDI],
    });
    assert.equal(uis.expose, true);
    assert.match(uis.attribution, /UNESCO Institute for Statistics/);

    const metadata = getObservedSourceDisplayMetadata(
      getIndicatorSourcePolicy('femaleUpperSecondaryAttainment'),
      UNESCO_VIA_WDI,
    );
    assert.equal(metadata.licenseUrl, 'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets');
    assert.equal(metadata.attributionUrl, 'https://uis.unesco.org/');
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
        sources: [WORLD_BANK_FX],
      });
      assert.equal(decision.expose, false, observationState);
      assert.equal(decision.status, 'ineligible-observation', observationState);
      assert.equal(decision.reason, 'observation-not-observed', observationState);
    }
  });
});
