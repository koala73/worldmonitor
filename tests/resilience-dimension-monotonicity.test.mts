// Monotonicity-test harness. Pins the direction of movement for the
// highest-leverage indicators so PR 1 + PR 2 cannot accidentally flip
// a sign silently. See
// docs/plans/2026-04-22-001-fix-resilience-scorer-structural-bias-plan.md
// §5 (PR 0 deliverable) and §6 (acceptance gate 8).
//
// Each test builds two synthetic `ResilienceSeedReader` fixtures that
// differ only in the target indicator's value and asserts the dimension
// score moves in the documented direction.
//
// Scope (minimum viable, expanded in PR 0.5 follow-ups):
//   - scoreEnergy: dependency, gasShare, coalShare, renewShare, electricityConsumption
//     (all five direction claims the current scorer makes — PR 1 overturns three of them)
//   - scoreReserveAdequacy: reserveMonths
//   - scoreFiscalSpace: govRevenuePct, fiscalBalancePct, debtToGdpPct
//   - scoreExternalDebtCoverage: debtToReservesRatio
//   - scoreImportConcentration: hhi
//   - scoreFoodWater: peopleInCrisis, phase
//   - scoreGovernanceInstitutional: WGI mean
//
// 15 indicators × 1 direction check each = 15 assertions. The harness
// is written as a table so PR 1 can add/remove rows without touching
// test logic.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreEnergy,
  scoreReserveAdequacy,
  scoreFiscalSpace,
  scoreExternalDebtCoverage,
  scoreImportConcentration,
  scoreFoodWater,
  scoreGovernanceInstitutional,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

function makeStaticReader(staticRecord: unknown, overrides: Record<string, unknown> = {}): ResilienceSeedReader {
  return async (key: string) => {
    if (key === `resilience:static:${TEST_ISO2}`) return staticRecord;
    if (key in overrides) return overrides[key];
    return null;
  };
}

function makeRecoveryReader(keyValueMap: Record<string, unknown>): ResilienceSeedReader {
  return async (key: string) => keyValueMap[key] ?? null;
}

describe('resilience dimension monotonicity — scoreReserveAdequacy', () => {
  it('higher reserveMonths → higher score', async () => {
    const low = await scoreReserveAdequacy(TEST_ISO2, makeRecoveryReader({
      'resilience:recovery:reserve-adequacy:v1': { countries: { [TEST_ISO2]: { reserveMonths: 2 } } },
    }));
    const high = await scoreReserveAdequacy(TEST_ISO2, makeRecoveryReader({
      'resilience:recovery:reserve-adequacy:v1': { countries: { [TEST_ISO2]: { reserveMonths: 12 } } },
    }));
    assert.ok(high.score > low.score, `reserveMonths 2→12 should raise score; got ${low.score} → ${high.score}`);
  });
});

describe('resilience dimension monotonicity — scoreFiscalSpace', () => {
  const baseEntry = { govRevenuePct: 25, fiscalBalancePct: 0, debtToGdpPct: 60 };

  async function scoreWith(override: Partial<typeof baseEntry>) {
    return scoreFiscalSpace(TEST_ISO2, makeRecoveryReader({
      'resilience:recovery:fiscal-space:v1': { countries: { [TEST_ISO2]: { ...baseEntry, ...override } } },
    }));
  }

  it('higher govRevenuePct → higher score', async () => {
    const low = await scoreWith({ govRevenuePct: 10 });
    const high = await scoreWith({ govRevenuePct: 40 });
    assert.ok(high.score > low.score, `govRevenuePct 10→40 should raise score; got ${low.score} → ${high.score}`);
  });

  it('higher fiscalBalancePct → higher score', async () => {
    const low = await scoreWith({ fiscalBalancePct: -10 });
    const high = await scoreWith({ fiscalBalancePct: 3 });
    assert.ok(high.score > low.score, `fiscalBalancePct -10→3 should raise score; got ${low.score} → ${high.score}`);
  });

  it('higher debtToGdpPct → lower score', async () => {
    const low = await scoreWith({ debtToGdpPct: 40 });
    const high = await scoreWith({ debtToGdpPct: 140 });
    assert.ok(low.score > high.score, `debtToGdpPct 40→140 should lower score; got ${low.score} → ${high.score}`);
  });
});

describe('resilience dimension monotonicity — scoreExternalDebtCoverage', () => {
  async function scoreWith(ratio: number) {
    return scoreExternalDebtCoverage(TEST_ISO2, makeRecoveryReader({
      'resilience:recovery:external-debt:v1': { countries: { [TEST_ISO2]: { debtToReservesRatio: ratio } } },
    }));
  }

  it('higher debtToReservesRatio → lower score', async () => {
    // NOTE: the current scorer saturates at 100 for ratio ≤ 0 (goalpost
    // lower-better, worst=5 best=0). Picking values inside the 0-5 band
    // to get a meaningful gradient. PR 3 §3.6 re-goalposts this.
    const good = await scoreWith(1);
    const bad = await scoreWith(4);
    assert.ok(good.score > bad.score, `debtToReservesRatio 1→4 should lower score; got ${good.score} → ${bad.score}`);
  });
});

describe('resilience dimension monotonicity — scoreImportConcentration', () => {
  async function scoreWith(hhi: number) {
    return scoreImportConcentration(TEST_ISO2, makeRecoveryReader({
      'resilience:recovery:import-hhi:v1': { countries: { [TEST_ISO2]: { hhi } } },
    }));
  }

  it('higher hhi → lower score (more concentration = more exposure)', async () => {
    // HHI payload is on a 0..1 scale (normalised before storage).
    // 0.15 = diversified supplier base; 0.45 = concentrated.
    const diversified = await scoreWith(0.15);
    const concentrated = await scoreWith(0.45);
    assert.ok(diversified.score > concentrated.score, `hhi 0.15→0.45 should lower score; got ${diversified.score} → ${concentrated.score}`);
  });
});

describe('resilience dimension monotonicity — scoreGovernanceInstitutional', () => {
  async function scoreWith(wgiMeanValue: number) {
    // Static-record shape per `getStaticWgiValues`: `wgi.indicators.<name>.value`.
    const staticRecord = {
      wgi: {
        indicators: {
          voiceAccountability:    { value: wgiMeanValue },
          politicalStability:     { value: wgiMeanValue },
          governmentEffectiveness:{ value: wgiMeanValue },
          regulatoryQuality:      { value: wgiMeanValue },
          ruleOfLaw:              { value: wgiMeanValue },
          controlOfCorruption:    { value: wgiMeanValue },
        },
      },
    };
    return scoreGovernanceInstitutional(TEST_ISO2, makeStaticReader(staticRecord));
  }

  it('higher WGI mean → higher score', async () => {
    const weak = await scoreWith(-1.5);
    const strong = await scoreWith(1.5);
    assert.ok(strong.score > weak.score, `WGI -1.5→1.5 should raise score; got ${weak.score} → ${strong.score}`);
  });
});

describe('resilience dimension monotonicity — scoreFoodWater', () => {
  async function scoreWith(override: Record<string, unknown>) {
    const fao = { peopleInCrisis: 100, phase: 'Phase 1', ...override };
    const staticRecord = { fao, aquastat: { waterStress: { value: 40 }, waterAvailability: { value: 2000 } } };
    return scoreFoodWater(TEST_ISO2, makeStaticReader(staticRecord));
  }

  it('higher peopleInCrisis → lower score', async () => {
    const healthy = await scoreWith({ peopleInCrisis: 1000 });
    const crisis = await scoreWith({ peopleInCrisis: 5_000_000 });
    assert.ok(healthy.score > crisis.score, `peopleInCrisis 1k→5M should lower score; got ${healthy.score} → ${crisis.score}`);
  });

  it('higher IPC phase → lower score', async () => {
    const phase2 = await scoreWith({ phase: 'Phase 2' });
    const phase5 = await scoreWith({ phase: 'Phase 5' });
    assert.ok(phase2.score > phase5.score, `phase 2→5 should lower score; got ${phase2.score} → ${phase5.score}`);
  });
});

describe('resilience dimension monotonicity — scoreEnergy (current construct)', () => {
  // NOTE: these tests pin the CURRENT scorer direction for each indicator.
  // PR 1 §3.1-3.3 overturns three of them (electricityConsumption, gasShare,
  // coalShare) — when PR 1 ships, those tests are REPLACED by tests for
  // the new indicators (importedFossilDependence, lowCarbonGenerationShare).
  // The failure of one of these tests in the meantime is a signal that a
  // PR has accidentally altered the construct; PR 1 should update this
  // file in the same commit that changes scoreEnergy.

  function makeEnergyReader(overrides: {
    staticRecord?: unknown;
    mix?: unknown;
    prices?: unknown;
    storage?: unknown;
  } = {}): ResilienceSeedReader {
    const defaultStatic = {
      iea: { energyImportDependency: { value: 30 } },
      infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 3000 } } },
    };
    const defaultMix = { gasShare: 30, coalShare: 20, renewShare: 30 };
    return async (key: string) => {
      if (key === `resilience:static:${TEST_ISO2}`) return overrides.staticRecord ?? defaultStatic;
      if (key === 'economic:energy:v1:all') return overrides.prices ?? null;
      if (key === `energy:mix:v1:${TEST_ISO2}`) return overrides.mix ?? defaultMix;
      if (key === `energy:gas-storage:v1:${TEST_ISO2}`) return overrides.storage ?? null;
      return null;
    };
  }

  it('higher import dependency → lower score', async () => {
    const selfSufficient = await scoreEnergy(TEST_ISO2, makeEnergyReader({
      staticRecord: {
        iea: { energyImportDependency: { value: 10 } },
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 3000 } } },
      },
    }));
    const dependent = await scoreEnergy(TEST_ISO2, makeEnergyReader({
      staticRecord: {
        iea: { energyImportDependency: { value: 90 } },
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 3000 } } },
      },
    }));
    assert.ok(selfSufficient.score > dependent.score, `import dep 10→90 should lower score; got ${selfSufficient.score} → ${dependent.score}`);
  });

  it('higher renewShare → higher score', async () => {
    const low = await scoreEnergy(TEST_ISO2, makeEnergyReader({ mix: { gasShare: 30, coalShare: 20, renewShare: 5 } }));
    const high = await scoreEnergy(TEST_ISO2, makeEnergyReader({ mix: { gasShare: 30, coalShare: 20, renewShare: 70 } }));
    assert.ok(high.score > low.score, `renewShare 5→70 should raise score; got ${low.score} → ${high.score}`);
  });

  it('CURRENT: higher gasShare → lower score (THIS CHANGES IN PR 1 — see plan §3.2)', async () => {
    // Pins the current (v3-plan-condemned) behavior so PR 1 knows what
    // it is replacing. When PR 1 ships the new importedFossilDependence
    // composite, this test is REPLACED, not deleted — the replacement
    // pins the new construct's direction.
    const low = await scoreEnergy(TEST_ISO2, makeEnergyReader({ mix: { gasShare: 10, coalShare: 20, renewShare: 30 } }));
    const high = await scoreEnergy(TEST_ISO2, makeEnergyReader({ mix: { gasShare: 70, coalShare: 20, renewShare: 30 } }));
    assert.ok(low.score > high.score, `gasShare 10→70 should lower score under current construct; got ${low.score} → ${high.score}`);
  });

  it('CURRENT: higher coalShare → lower score (THIS CHANGES IN PR 1 — see plan §3.2)', async () => {
    const low = await scoreEnergy(TEST_ISO2, makeEnergyReader({ mix: { gasShare: 30, coalShare: 10, renewShare: 30 } }));
    const high = await scoreEnergy(TEST_ISO2, makeEnergyReader({ mix: { gasShare: 30, coalShare: 70, renewShare: 30 } }));
    assert.ok(low.score > high.score, `coalShare 10→70 should lower score under current construct; got ${low.score} → ${high.score}`);
  });

  it('CURRENT: higher electricityConsumption → higher score (THIS FAILS THE MECHANISM TEST — see plan §3.1)', async () => {
    // This test PASSES today because the current scorer rewards
    // per-capita electricity consumption. The v3 plan classifies
    // electricityConsumption as a wealth-proxy that fails the mechanism
    // test; PR 1 removes it. When PR 1 ships, this test is DELETED (not
    // replaced), because the indicator no longer exists. The delete is
    // the signal that the wealth-proxy concern is resolved.
    const low = await scoreEnergy(TEST_ISO2, makeEnergyReader({
      staticRecord: {
        iea: { energyImportDependency: { value: 30 } },
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 500 } } },
      },
    }));
    const high = await scoreEnergy(TEST_ISO2, makeEnergyReader({
      staticRecord: {
        iea: { energyImportDependency: { value: 30 } },
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 7500 } } },
      },
    }));
    assert.ok(high.score > low.score, `electricityConsumption 500→7500 kWh/cap should raise score under current construct; got ${low.score} → ${high.score}`);
  });
});
