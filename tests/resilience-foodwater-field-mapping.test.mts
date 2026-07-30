// Regression guard for scoreFoodWater — inputs, branching, and the
// "identical cohort scores are construct-deterministic, not regional-
// default leaks" invariant that PR 5.3 of plan 2026-04-24-002 sets
// out to establish.
//
// Context. The plan flagged that all GCC countries score ~53 on
// `foodWater` and asked: is that a mystery regional default or is it
// a genuine construct output? This test suite pins the answer:
// identical inputs produce identical outputs, and the inputs are
// themselves explicable — IPC does not monitor rich food-secure
// states (impute 88) and AQUASTAT/WB water-stress values for the
// GCC are EXTREME (freshwater withdrawal > 100% of renewable
// resources), which clamps the AQUASTAT sub-score to 0. The blend
// of IMPUTE.ipcFood=88 with AQUASTAT=0 under the documented weights
// produces a near-identical score across countries with the same
// water-stress profile. That's the construct working — not a bug.
//
// See docs/methodology/known-limitations.md for the full write-up.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreFoodWater,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

function makeStaticReader(staticRecord: unknown): ResilienceSeedReader {
  return async (key: string) => (key === `resilience:static:${TEST_ISO2}` ? staticRecord : null);
}

describe('scoreAquastatValue — indicator-keyword routing contract', () => {
  it('indicator="water stress" routes to lower-better (higher withdrawal = worse score)', async () => {
    // WB indicator ER.H2O.FWST.ZS: "Level of water stress: freshwater
    // withdrawal as a proportion of available freshwater resources."
    // Seeded as `indicator: 'water stress'`. Containing "stress" →
    // `normalizeLowerBetter(value, 0, 100)` per _dimension-scorers.ts:899.
    const low = makeStaticReader({
      aquastat: { value: 10, indicator: 'water stress' },
      fao: { peopleInCrisis: 0, phase: null },
    });
    const high = makeStaticReader({
      aquastat: { value: 80, indicator: 'water stress' },
      fao: { peopleInCrisis: 0, phase: null },
    });
    const [lowScore, highScore] = await Promise.all([
      scoreFoodWater(TEST_ISO2, low),
      scoreFoodWater(TEST_ISO2, high),
    ]);
    assert.ok(lowScore.score > highScore.score,
      `higher water-stress must LOWER the score; got low=${lowScore.score}, high=${highScore.score}`);
  });

  it('AQUASTAT value > 100 clamps to 0 (the GCC extreme-withdrawal case)', async () => {
    // GCC freshwater withdrawal % of renewable resources is well over
    // 100% (KW ~3200, BH ~3400, AE ~2080, QA ~770). The normaliser
    // clamps anything past the "worst" anchor to 0. Test with 2000,
    // which comfortably exceeds the 100 anchor.
    //
    // IMPORTANT: drive the IMPUTE branch (`fao: null`), not the else
    // branch. In production the static seeder writes `fao: null` for
    // GCC (IPC/HDX does not monitor food-secure states), so the live
    // blend uses the impute path with weights 0.6 (IPC impute=88) +
    // 0.4 (AQUASTAT). The else branch (fao-present, peopleInCrisis=0)
    // happens to converge on a near-identical number at these inputs
    // by coincidence, but testing the wrong branch would let a future
    // impute-branch regression slip through.
    const reader = makeStaticReader({
      aquastat: { value: 2000, indicator: 'water stress' },
      fao: null, // fao==null branch — matches the GCC production shape
    });
    const result = await scoreFoodWater(TEST_ISO2, reader);
    // Blend under the IMPUTE branch:
    //   { score: 88, weight: 0.6, cov: 0.7, imputed }  // IMPUTE.ipcFood
    //   { score: 0,  weight: 0.4, cov: 1.0, observed }  // AQUASTAT clamped
    //   weightedScore = (88*0.6 + 0*0.4) / (0.6+0.4) = 52.8 → 53.
    // This is EXACTLY the observed GCC cohort score. Pinning it.
    assert.equal(Math.round(result.score), 53,
      `GCC water-stress profile must yield ~53 on the IMPUTE branch; got ${result.score}`);
  });

  it('indicator="renewable water availability" routes to higher-better (more = better)', async () => {
    const scarce = makeStaticReader({
      aquastat: { value: 500, indicator: 'renewable water availability' },
      fao: { peopleInCrisis: 0, phase: null },
    });
    const abundant = makeStaticReader({
      aquastat: { value: 4500, indicator: 'renewable water availability' },
      fao: { peopleInCrisis: 0, phase: null },
    });
    const [scarceScore, abundantScore] = await Promise.all([
      scoreFoodWater(TEST_ISO2, scarce),
      scoreFoodWater(TEST_ISO2, abundant),
    ]);
    assert.ok(abundantScore.score > scarceScore.score,
      `more renewable water = higher score; got scarce=${scarceScore.score}, abundant=${abundantScore.score}`);
  });
});

describe('scoreFoodWater — IPC absence path (stable-absence imputation)', () => {
  it('country not in IPC/HDX (fao=null) imputes ipcFood=88 when static record present', async () => {
    const reader = makeStaticReader({
      aquastat: { value: 20, indicator: 'water stress' },
      fao: null, // crisis_monitoring_absent — food-secure country, not a monitored crisis
    });
    const result = await scoreFoodWater(TEST_ISO2, reader);
    // Blend: {score:88, weight:0.6, cov:0.7, imputed} + {score:80, weight:0.4, cov:1.0, observed}
    //   weightedScore = (88*0.6 + 80*0.4) / (0.6+0.4) = 52.8 + 32.0 = 84.8 → 85
    // Pinning the blended range to catch a formula regression.
    assert.ok(result.score >= 80 && result.score <= 90,
      `IPC-absent + moderate aquastat must blend to 80-90; got ${result.score}`);
    // Per weightedBlend's T1.7 rule (line 601 of _dimension-scorers.ts):
    // `imputationClass` surfaces ONLY when observedWeight === 0. Here
    // AQUASTAT is observed data (score=80), so it "wins" and the final
    // imputationClass is null. The IPC-impute is still reflected in
    // `imputedWeight` and the lower coverage (70% for IPC * 0.6 + 100%
    // for AQUASTAT * 0.4 = 82% weighted).
    assert.equal(result.imputationClass, null,
      'mixed observed+imputed → imputationClass=null (observed wins); IPC impute reflected in imputedWeight');
    assert.ok(result.imputedWeight > 0, 'IPC slot must be counted as imputed');
    assert.ok(result.observedWeight > 0, 'AQUASTAT slot must be counted as observed');
  });

  it('country fully imputed (fao=null AND aquastat absent) surfaces imputationClass=stable-absence', async () => {
    // This is the scenario where `imputationClass` actually surfaces:
    // AQUASTAT missing (null score, no impute) → contributes no weight
    // AT ALL to observedWeight or imputedWeight. The remaining IPC
    // slot is fully imputed, so the dimension is fully imputed and
    // weightedBlend picks the dominant (only) class.
    const reader = makeStaticReader({
      aquastat: null, // AQUASTAT data missing entirely
      fao: null,      // IPC not monitoring
    });
    const result = await scoreFoodWater(TEST_ISO2, reader);
    assert.equal(result.imputationClass, 'stable-absence',
      'fully-imputed dim must surface stable-absence class');
    // Single imputed slot {score:88, weight:0.6, cov:0.7}:
    //   weightedScore = 88 * 0.6 / 0.6 = 88 (only this slot has a score)
    //   weightedCertainty = 0.7 * 0.6 / (0.6+0.4) = 0.42 total weighted / total
    assert.ok(result.score >= 85 && result.score <= 92,
      `fully-imputed must score ~88; got ${result.score}`);
  });

  it('static-record absent entirely (seeder never ran) does NOT impute — returns null branch', async () => {
    // Per the scorer comment at line 1482 of _dimension-scorers.ts:
    // "A missing resilience:static:{ISO2} key means the seeder never
    // ran — not crisis-free." So this path returns weight-null for
    // the IPC slot, not an IMPUTE. The AQUASTAT slot is also null
    // because scoreAquastatValue(null)=null. Result: zero-signal.
    const reader = makeStaticReader(null);
    const result = await scoreFoodWater(TEST_ISO2, reader);
    // weightedBlend with two null-score slots returns coverage=0.
    assert.equal(result.coverage, 0,
      'fully-absent static record must produce coverage=0 (no impute-as-if-safe)');
  });
});

describe('scoreFoodWater — cohort determinism (not a regional-default leak)', () => {
  it('two countries with identical inputs produce identical scores (construct-deterministic)', async () => {
    // Two synthetic "GCC-shaped" countries: extreme water stress
    // (WB value > 100 clamps AQUASTAT to 0) + IPC-absent. Same
    // inputs → same output is the CORRECT behavior. An identical
    // score across a cohort is a construct signal, NOT evidence of
    // a hardcoded regional default.
    const gccShape = {
      aquastat: { value: 2500, indicator: 'water stress' },
      fao: null,
    };
    const [a, b] = await Promise.all([
      scoreFoodWater('AE', async (k) => (k === 'resilience:static:AE' ? gccShape : null)),
      scoreFoodWater('KW', async (k) => (k === 'resilience:static:KW' ? gccShape : null)),
    ]);
    assert.equal(a.score, b.score,
      'identical inputs must produce identical scores — the observed GCC cohort identity is construct-deterministic');
    assert.equal(a.coverage, b.coverage, 'and identical coverage');
  });

  it('a different water-profile input produces a different score (rules out the regional-default hypothesis)', async () => {
    // Same IPC-absent status, but different AQUASTAT indicator /
    // value: a high-renewable country. If foodWater were using a
    // hardcoded regional default, this country would score the
    // same as the water-stress case above. It must not.
    const waterStressShape = {
      aquastat: { value: 2500, indicator: 'water stress' },
      fao: null,
    };
    const waterAbundantShape = {
      aquastat: { value: 8000, indicator: 'renewable water availability' },
      fao: null,
    };
    const [stressed, abundant] = await Promise.all([
      scoreFoodWater('AE', async (k) => (k === 'resilience:static:AE' ? waterStressShape : null)),
      scoreFoodWater('IS', async (k) => (k === 'resilience:static:IS' ? waterAbundantShape : null)),
    ]);
    assert.ok(abundant.score > stressed.score,
      `water-abundant country must outscore water-stressed; got stressed=${stressed.score}, abundant=${abundant.score} — a regional default would have tied these`);
  });
});
