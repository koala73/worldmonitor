// Construct invariants — formula-level assertions with synthetic inputs.
//
// Purpose. Complement `resilience-dimension-monotonicity.test.mts` (which
// pins direction) with precise ANCHOR-VALUE checks. These tests fail when
// the scoring FORMULA breaks, not when a country's RANK changes. They are
// deliberately country-identity-free so the audit gate (see
// `docs/methodology/cohort-sanity-release-gate.md`) does not collapse into
// an outcome-seeking "ENTITY A must > ENTITY B" assertion — that is the
// anti-pattern the cohort-sanity skill explicitly warns against.
//
// Plan reference. PR 0 from
// `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md`
// (§"PR 0 — Release-gate audit harness"):
//   > `score(HHI=0.05) > score(HHI=0.20)`
//   > `score(debtToReservesRatio=0) > score(ratio=1) > score(ratio=2)`
//   > `score(effMo=12) > score(effMo=3)`
//   > `score(lowCarbonShare=80, fossilImportDep=0) > score(lowCarbonShare=0, fossilImportDep=100)`
//
// The tests are organised by scorer and include both the monotonicity
// claim and the precise anchor value where the construct fixes one
// (Greenspan-Guidotti = 50; saturating transform at effMo=12 = ~63).
// An anchor drift > 1 point is an invariant break: investigate before
// editing the test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreImportConcentration,
  scoreExternalDebtCoverage,
  scoreSovereignFiscalBuffer,
  isExcludedFromConfidenceMean,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

function makeReader(keyValueMap: Record<string, unknown>): ResilienceSeedReader {
  return async (key: string) => keyValueMap[key] ?? null;
}

describe('construct invariants — importConcentration', () => {
  async function scoreWith(hhi: number) {
    return scoreImportConcentration(TEST_ISO2, makeReader({
      'resilience:recovery:import-hhi:v1': { countries: { [TEST_ISO2]: { hhi } } },
    }));
  }

  it('score(HHI=0.05) > score(HHI=0.20)', async () => {
    const diversified = await scoreWith(0.05);
    const concentrated = await scoreWith(0.20);
    assert.ok(
      diversified.score > concentrated.score,
      `HHI 0.05→0.20 should lower score; got ${diversified.score} → ${concentrated.score}`,
    );
  });

  it('HHI=0 anchors at score 100 (no-concentration pole)', async () => {
    const r = await scoreWith(0);
    assert.ok(Math.abs(r.score - 100) < 1, `expected ~100 at HHI=0, got ${r.score}`);
  });

  it('HHI=0.5 (fully concentrated under current 0..5000 goalpost) anchors at score 0', async () => {
    // Current scorer: hhi×10000 normalised against (0, 5000). 0.5×10000 = 5000 → 0.
    const r = await scoreWith(0.5);
    assert.ok(Math.abs(r.score - 0) < 1, `expected ~0 at HHI=0.5 under current goalpost, got ${r.score}`);
  });
});

describe('construct invariants — externalDebtCoverage (Greenspan-Guidotti anchor)', () => {
  async function scoreWith(debtToReservesRatio: number) {
    return scoreExternalDebtCoverage(TEST_ISO2, makeReader({
      'resilience:recovery:external-debt:v1': {
        countries: { [TEST_ISO2]: { debtToReservesRatio } },
      },
    }));
  }

  it('ratio=0 → score 100 (zero-rollover-exposure pole)', async () => {
    const r = await scoreWith(0);
    assert.ok(Math.abs(r.score - 100) < 1, `expected ~100 at ratio=0, got ${r.score}`);
  });

  it('ratio=1.0 → score 50 (Greenspan-Guidotti threshold)', async () => {
    const r = await scoreWith(1.0);
    assert.ok(
      Math.abs(r.score - 50) < 1,
      `expected ~50 at ratio=1.0 under Greenspan-Guidotti anchor (worst=2), got ${r.score}`,
    );
  });

  it('ratio=2.0 → score 0 (acute rollover-shock pole)', async () => {
    const r = await scoreWith(2.0);
    assert.ok(Math.abs(r.score - 0) < 1, `expected ~0 at ratio=2.0, got ${r.score}`);
  });

  it('monotonic: score(ratio=0) > score(ratio=1) > score(ratio=2)', async () => {
    const [r0, r1, r2] = await Promise.all([scoreWith(0), scoreWith(1), scoreWith(2)]);
    assert.ok(r0.score > r1.score && r1.score > r2.score,
      `expected strictly decreasing; got ${r0.score}, ${r1.score}, ${r2.score}`);
  });
});

describe('construct invariants — sovereignFiscalBuffer (saturating transform)', () => {
  // Saturating transform per scorer (line ~1687):
  //   score = 100 * (1 - exp(-em / 12))
  // Reference values (not tuning points — these are what the formula SHOULD
  // produce if no one has silently redefined it):
  //   em=0  → 0
  //   em=3  → 100*(1-e^-0.25) ≈ 22.1
  //   em=12 → 100*(1-e^-1)    ≈ 63.2
  //   em=24 → 100*(1-e^-2)    ≈ 86.5
  //   em→∞  → 100

  async function scoreWithEm(em: number) {
    return scoreSovereignFiscalBuffer(TEST_ISO2, makeReader({
      'resilience:recovery:sovereign-wealth:v1': {
        countries: { [TEST_ISO2]: { totalEffectiveMonths: em, completeness: 1.0 } },
      },
    }));
  }

  it('em=0 → score 0 (no SWF buffer)', async () => {
    const r = await scoreWithEm(0);
    assert.ok(Math.abs(r.score - 0) < 1, `expected ~0 at em=0, got ${r.score}`);
  });

  it('em=12 → score ≈ 63 (one-year saturating anchor)', async () => {
    const r = await scoreWithEm(12);
    const expected = 100 * (1 - Math.exp(-1));
    assert.ok(
      Math.abs(r.score - expected) < 1,
      `expected ~${expected.toFixed(1)} at em=12, got ${r.score}`,
    );
  });

  it('em=24 → score ≈ 86 (two-year saturating anchor)', async () => {
    const r = await scoreWithEm(24);
    const expected = 100 * (1 - Math.exp(-2));
    assert.ok(
      Math.abs(r.score - expected) < 1,
      `expected ~${expected.toFixed(1)} at em=24, got ${r.score}`,
    );
  });

  it('monotonic: score(em=3) < score(em=12) < score(em=24)', async () => {
    const [r3, r12, r24] = await Promise.all([scoreWithEm(3), scoreWithEm(12), scoreWithEm(24)]);
    assert.ok(r3.score < r12.score && r12.score < r24.score,
      `expected strictly increasing; got em=3:${r3.score}, em=12:${r12.score}, em=24:${r24.score}`);
  });

  it('country not in manifest → score 0, coverage 0 (dim-not-applicable, plan 2026-04-26-001 §U3)', async () => {
    // Plan 2026-04-26-001 §U3 reframed Path 3 from "substantive
    // absence (score 0, full coverage 1.0)" to "dim-not-applicable
    // (score 0, ZERO coverage)". The original framing penalized
    // advanced economies (DE, JP, FR, IT) that hold reserves through
    // Treasury / central-bank channels rather than dedicated SWFs.
    // The recovery domain's coverage-weighted mean now re-normalizes
    // around the remaining recovery dims because this row contributes
    // 0 weight. Score remains numeric (zero) per the
    // ResilienceDimensionScore.score:number contract and the
    // release-gate Number.isFinite check.
    const r = await scoreSovereignFiscalBuffer(TEST_ISO2, makeReader({
      'resilience:recovery:sovereign-wealth:v1': { countries: {} },
    }));
    assert.equal(r.score, 0, `expected 0 when country has no manifest entry, got ${r.score}`);
    assert.equal(r.coverage, 0, `expected coverage=0 (dim-not-applicable for non-SWF country), got ${r.coverage}`);
    assert.equal(r.imputationClass, 'not-applicable',
      `expected imputationClass='not-applicable' (the proto's structurally-not-applicable sentinel — review fixup on plan 2026-04-26-001 §U3), got ${r.imputationClass}`);
  });

  // Plan 2026-04-26-001 §U3 review fixup: the not-applicable filter must
  // distinguish Path 3 (no manifest entry, true dim-not-applicable) from
  // Path 2 with completeness=0 (manifest entry exists but the scrape
  // collapsed). The latter is a DATA OUTAGE on a country that DOES carry
  // the construct and MUST drag user-facing confidence down.
  it('filter discriminator: Path 3 is excluded but Path 2 with completeness=0 is NOT (real data outage on a SWF country)', async () => {
    // Path 3: country absent from manifest entirely.
    const path3 = await scoreSovereignFiscalBuffer(TEST_ISO2, makeReader({
      'resilience:recovery:sovereign-wealth:v1': { countries: {} },
    }));
    // Path 2: country IN manifest but completeness=0 (full scrape outage).
    const path2OutageCompleteness = await scoreSovereignFiscalBuffer(TEST_ISO2, makeReader({
      'resilience:recovery:sovereign-wealth:v1': {
        countries: { [TEST_ISO2]: { totalEffectiveMonths: 12, completeness: 0 } },
      },
    }));

    // Both can produce coverage=0 — that's why the naive filter is wrong.
    assert.equal(path3.coverage, 0, 'Path 3 must have coverage=0');
    assert.ok(path2OutageCompleteness.coverage < 0.01,
      `Path 2 completeness=0 must produce ~0 coverage (got ${path2OutageCompleteness.coverage})`);

    // The discriminator: Path 3 has observedWeight=0; Path 2 has observedWeight=1.
    assert.equal(path3.observedWeight, 0, 'Path 3 observedWeight must be 0');
    assert.equal(path2OutageCompleteness.observedWeight, 1, 'Path 2 observedWeight must be 1 even with completeness=0');

    // The filter MUST exclude Path 3 (it's truly not applicable to this country)
    // but MUST NOT exclude Path 2 (it's a data outage that should drag confidence).
    assert.equal(
      isExcludedFromConfidenceMean({
        id: 'sovereignFiscalBuffer',
        coverage: path3.coverage,
        observedWeight: path3.observedWeight,
        imputedWeight: path3.imputedWeight,
      }),
      true,
      'Path 3 (dim-not-applicable) MUST be excluded from confidence mean',
    );
    assert.equal(
      isExcludedFromConfidenceMean({
        id: 'sovereignFiscalBuffer',
        coverage: path2OutageCompleteness.coverage,
        observedWeight: path2OutageCompleteness.observedWeight,
        imputedWeight: path2OutageCompleteness.imputedWeight,
      }),
      false,
      'Path 2 with completeness=0 (data outage on SWF country) MUST NOT be excluded — operator must see the low-confidence signal',
    );
  });
});
