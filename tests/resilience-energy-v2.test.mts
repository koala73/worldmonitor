// Contract tests for the PR 1 energy-construct v2 flag gate
// (`RESILIENCE_ENERGY_V2_ENABLED`). Pins two invariants that must
// hold for the flag to be safe to flip:
//
//   1. Flag off = legacy construct. Every test that exercised the
//      pre-PR-1 scorer must keep producing the same score. Any
//      cross-contamination from the v2 code path into the default
//      branch is a merge-blocker.
//   2. Flag on = v2 composite. Each new indicator must move the score
//      in the documented direction (monotonicity), and countries
//      missing a v2 input should degrade gracefully to null per
//      weighted-blend contract rather than throw.
//
// The tests use stubbed readers instead of Redis so the suite stays
// hermetic.

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { scoreEnergy, type ResilienceSeedReader } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'ZZ'; // fictional country so test coverage checks don't flag it

type EnergyReaderOverrides = {
  staticRecord?: unknown;
  storage?: unknown;
  mix?: unknown;
  prices?: unknown;
  // v2 seed overrides (bulk-payload shape: { countries: { [ISO2]: { value } } })
  fossilElectricityShare?: number | null;
  lowCarbonGenerationShare?: number | null;
  powerLosses?: number | null;
  // Allow explicitly returning null for entire bulk payload.
  fossilBulk?: unknown;
  lowCarbonBulk?: unknown;
  lossesBulk?: unknown;
};

function makeBulk(iso: string, value: number | null | undefined): unknown {
  if (value == null) return null;
  return { countries: { [iso]: { value, year: 2024 } } };
}

function makeEnergyReader(iso: string, overrides: EnergyReaderOverrides = {}): ResilienceSeedReader {
  const defaultStatic = {
    iea: { energyImportDependency: { value: 40 } },
    infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 3000 } } },
  };
  const defaultMix = { gasShare: 30, coalShare: 20, renewShare: 30 };
  return async (key: string) => {
    if (key === `resilience:static:${iso}`) return overrides.staticRecord ?? defaultStatic;
    if (key === 'economic:energy:v1:all') return overrides.prices ?? null;
    if (key === `energy:mix:v1:${iso}`) return overrides.mix ?? defaultMix;
    if (key === `energy:gas-storage:v1:${iso}`) return overrides.storage ?? null;
    if (key === 'resilience:fossil-electricity-share:v1') {
      return overrides.fossilBulk ?? makeBulk(iso, overrides.fossilElectricityShare ?? 50);
    }
    if (key === 'resilience:low-carbon-generation:v1') {
      return overrides.lowCarbonBulk ?? makeBulk(iso, overrides.lowCarbonGenerationShare ?? 40);
    }
    if (key === 'resilience:power-losses:v1') {
      return overrides.lossesBulk ?? makeBulk(iso, overrides.powerLosses ?? 10);
    }
    return null;
  };
}

// ─ Flag-off: legacy behaviour is preserved ─────────────────────────

describe('scoreEnergy — RESILIENCE_ENERGY_V2_ENABLED=false (default)', () => {
  before(() => {
    delete process.env.RESILIENCE_ENERGY_V2_ENABLED;
  });

  it('flag is off by default', () => {
    assert.equal(process.env.RESILIENCE_ENERGY_V2_ENABLED, undefined);
  });

  it('reads legacy inputs — higher renewShare raises score', async () => {
    const low = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { mix: { gasShare: 30, coalShare: 20, renewShare: 5 } }));
    const high = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { mix: { gasShare: 30, coalShare: 20, renewShare: 70 } }));
    assert.ok(high.score > low.score, `legacy path should respond to renewShare; got ${low.score} → ${high.score}`);
  });

  it('does NOT read the v2 seed keys — changing fossilElectricityShare has no effect', async () => {
    const baseline = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { fossilElectricityShare: 10 }));
    const hiFossil = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { fossilElectricityShare: 90 }));
    assert.equal(baseline.score, hiFossil.score, 'legacy path must be insensitive to v2 seed keys');
  });
});

// ─ Flag-on: v2 composite is used ────────────────────────────────────

describe('scoreEnergy — RESILIENCE_ENERGY_V2_ENABLED=true', () => {
  before(() => {
    process.env.RESILIENCE_ENERGY_V2_ENABLED = 'true';
  });
  after(() => {
    delete process.env.RESILIENCE_ENERGY_V2_ENABLED;
  });

  it('flag is on', () => {
    assert.equal(process.env.RESILIENCE_ENERGY_V2_ENABLED, 'true');
  });

  it('v2 path reads importedFossilDependence — lower fossilElectricityShare raises score', async () => {
    const cleanGrid = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { fossilElectricityShare: 5 }));
    const dirtyGrid = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { fossilElectricityShare: 90 }));
    assert.ok(cleanGrid.score > dirtyGrid.score, `fossil share 5→90 should lower score; got ${cleanGrid.score} → ${dirtyGrid.score}`);
  });

  it('net exporter (negative EG.IMP.CONS.ZS) collapses importedFossilDependence to 0', async () => {
    // Plan §3.2: max(netImports, 0) ensures net exporters are not
    // penalised by the composite regardless of their fossil share.
    const netExporter = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, {
      staticRecord: {
        iea: { energyImportDependency: { value: -80 } }, // net exporter
        infrastructure: { indicators: {} },
      },
      fossilElectricityShare: 90, // fossil-heavy but domestic → should NOT penalise
    }));
    const netImporter = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, {
      staticRecord: {
        iea: { energyImportDependency: { value: 80 } }, // heavy importer
        infrastructure: { indicators: {} },
      },
      fossilElectricityShare: 90,
    }));
    assert.ok(
      netExporter.score > netImporter.score,
      `net exporter (90% fossil) must score higher than net importer (90% fossil); got ${netExporter.score} vs ${netImporter.score}`,
    );
  });

  it('higher lowCarbonGenerationShare raises score (nuclear credit)', async () => {
    const noNuclear = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { lowCarbonGenerationShare: 5 }));
    const heavyNuclear = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { lowCarbonGenerationShare: 75 }));
    assert.ok(heavyNuclear.score > noNuclear.score, `low-carbon 5→75 should raise score; got ${noNuclear.score} → ${heavyNuclear.score}`);
  });

  it('higher powerLosses lowers score (grid-integrity penalty)', async () => {
    const cleanGrid = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { powerLosses: 4 }));
    const leakyGrid = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { powerLosses: 22 }));
    assert.ok(cleanGrid.score > leakyGrid.score, `power losses 4→22 should lower score; got ${cleanGrid.score} → ${leakyGrid.score}`);
  });

  it('euGasStorageStress gated by EU membership — non-EU country ignores storage signal', async () => {
    // TEST_ISO2 is ZZ which is NOT in EU_GAS_STORAGE_COUNTRIES. The
    // storage input should be dropped from the blend regardless of
    // its value.
    const noStorage = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, {}));
    const lowStorage = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, { storage: { fillPct: 10 } }));
    assert.equal(noStorage.score, lowStorage.score, 'non-EU country should be invariant to storage fill');
  });

  it('euGasStorageStress applies to EU member — DE with low storage scores lower than DE with high storage', async () => {
    const deLow = await scoreEnergy('DE', makeEnergyReader('DE', { storage: { fillPct: 10 } }));
    const deHigh = await scoreEnergy('DE', makeEnergyReader('DE', { storage: { fillPct: 90 } }));
    assert.ok(deHigh.score > deLow.score, `DE storage 10→90 should raise score; got ${deLow.score} → ${deHigh.score}`);
  });

  it('missing v2 seed inputs degrade gracefully (no throw, coverage < 1.0)', async () => {
    const allMissing = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2, {
      fossilBulk: null, lowCarbonBulk: null, lossesBulk: null,
    }));
    // Score may be null/low but must NOT throw. Coverage should be
    // well below 1.0 because most inputs are absent.
    assert.ok(allMissing.coverage < 1.0, `all-missing coverage should be < 1.0, got ${allMissing.coverage}`);
  });

  it('reserveMarginPct is NOT read in v2 path (deferred per plan §3.1)', async () => {
    // Regression guard: a future commit that adds a reserveMargin
    // reader to scoreEnergyV2 without landing its seeder would
    // silently renormalize weights on flag-on. This test pins the
    // explicit exclusion: changing the reserve-margin Redis key
    // content must have zero effect on the score.
    const baseline = await scoreEnergy(TEST_ISO2, makeEnergyReader(TEST_ISO2));
    const customReader: ResilienceSeedReader = async (key: string) => {
      if (key === 'resilience:reserve-margin:v1') {
        return { countries: { [TEST_ISO2]: { value: 99, year: 2024 } } };
      }
      return (await makeEnergyReader(TEST_ISO2)(key));
    };
    const withReserveMargin = await scoreEnergy(TEST_ISO2, customReader);
    assert.equal(baseline.score, withReserveMargin.score,
      'reserve-margin key contents must not affect the v2 score until the indicator re-ships');
  });
});
