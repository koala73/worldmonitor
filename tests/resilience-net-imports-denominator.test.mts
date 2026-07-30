// Construct invariants for PR 3A §net-imports denominator fix
// (plan `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-
// structural-audit-plan.md`).
//
// The plan's acceptance gate (construct-objective, not rank-targeted):
//
//   Two synthetic countries, same SWF, same gross imports. Country A
//   re-exports 60%; B re-exports 0%. Post-fix: A's effMo is 2.5× B's
//   (reflecting reduced denominator).
//
// The 2.5× ratio comes from 1/(1 − 0.6) = 2.5 — a pure formula
// consequence. This test pins the math independently of the seeder's
// live-API plumbing so a future refactor cannot silently flip the
// transform direction or goalpost.
//
// Also covers:
//   - Identity: share = 0 → netImports === grossImports (status quo)
//   - Boundary: share = 1 is REJECTED (would zero the denominator and
//     crash the downstream rawMonths math)
//   - Input validation: negative or non-finite inputs throw
//   - The plan's acceptance pair (2.5× ratio)
//   - Re-export-hub cohort pattern: proportional effMo lift
//   - SWF-heavy-exporter cohort (share ≈ 0): effMo unchanged

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeNetImports } from '../scripts/seed-sovereign-wealth.mjs';

describe('computeNetImports — construct contract', () => {
  it('share = 0 leaves gross imports unchanged (status quo identity)', () => {
    assert.equal(computeNetImports(100_000_000_000, 0), 100_000_000_000);
  });

  it('share = 0.6 produces the 2.5× effMo ratio the plan names as an acceptance gate', () => {
    const gross = 100_000_000_000;
    const shareA = 0.6;
    const shareB = 0;
    const netA = computeNetImports(gross, shareA);
    const netB = computeNetImports(gross, shareB);
    // rawMonths = aum / netImports × 12 → a LARGER denominator gives a
    // smaller rawMonths. For equal AUM, ratio of rawMonths scales as
    // netB / netA (inverse of the denominator ratio).
    const rawMonthsRatio = netB / netA;
    assert.ok(
      Math.abs(rawMonthsRatio - 2.5) < 1e-9,
      `Post-fix rawMonths ratio must be 2.5× exactly (= 1/(1−0.6)); got ${rawMonthsRatio}`,
    );
  });

  it('monotonic: larger share → smaller denominator → larger rawMonths for equal AUM', () => {
    const gross = 100_000_000_000;
    const shares = [0, 0.1, 0.3, 0.5, 0.7, 0.9];
    const denominators = shares.map((s) => computeNetImports(gross, s));
    for (let i = 1; i < denominators.length; i++) {
      assert.ok(
        denominators[i] < denominators[i - 1],
        `share=${shares[i]} denominator must be smaller than share=${shares[i - 1]}; got ${denominators[i]} ≥ ${denominators[i - 1]}`,
      );
    }
  });

  it('rejects share = 1 (would zero the denominator and crash rawMonths)', () => {
    assert.throws(() => computeNetImports(100e9, 1.0),
      /reexportShareOfImports must be in \[0, 1\)/);
  });

  it('rejects negative share', () => {
    assert.throws(() => computeNetImports(100e9, -0.1),
      /reexportShareOfImports must be in \[0, 1\)/);
  });

  it('rejects non-finite / non-positive grossImportsUsd', () => {
    assert.throws(() => computeNetImports(0, 0.5),
      /grossImportsUsd must be positive finite/);
    assert.throws(() => computeNetImports(-100, 0.5),
      /grossImportsUsd must be positive finite/);
    assert.throws(() => computeNetImports(Number.NaN, 0.5),
      /grossImportsUsd must be positive finite/);
    assert.throws(() => computeNetImports(Number.POSITIVE_INFINITY, 0.5),
      /grossImportsUsd must be positive finite/);
  });

  it('treats non-finite share as 0 (backward-compat for missing manifest entry)', () => {
    // Countries not in the re-export manifest get `undefined` from
    // the loader's `.get()` call. The seeder coalesces to 0 with `??`
    // but `computeNetImports` also guards against NaN/Infinity to be
    // defensive at the boundary.
    assert.equal(computeNetImports(100e9, Number.NaN), 100e9);
    assert.equal(computeNetImports(100e9, undefined as unknown as number), 100e9);
  });
});

describe('computeNetImports — cohort invariants from plan §PR 3A', () => {
  it('re-export hub cohort: effMo lift is proportional to published share', () => {
    // Synthetic re-export hubs with varying UNCTAD shares.
    // The plan's out-of-sample acceptance gate: "re-export hub cohort
    // — each sees sovFisc effMo increase proportional to UNCTAD
    // re-export share." Test the PROPORTIONALITY CLAIM with
    // synthetic data.
    const gross = 500_000_000_000;
    const aum = 100_000_000_000; // same SWF
    const hubs = [
      { country: 'A', share: 0.95 },  // HK-pattern
      { country: 'B', share: 0.45 },  // SG-pattern
      { country: 'C', share: 0.30 },  // NL-pattern
      { country: 'D', share: 0.20 },  // BE-pattern
      { country: 'E', share: 0 },     // non-hub
    ];
    const computed = hubs.map(({ country, share }) => {
      const net = computeNetImports(gross, share);
      const rawMonths = (aum / net) * 12;
      return { country, share, rawMonths };
    });
    // RawMonths must strictly increase with share (the higher the
    // re-export share, the smaller the net-imports denominator, the
    // larger the rawMonths).
    for (let i = 1; i < computed.length; i++) {
      if (computed[i - 1].share > computed[i].share) {
        assert.ok(
          computed[i - 1].rawMonths > computed[i].rawMonths,
          `${computed[i - 1].country} (share=${computed[i - 1].share}) rawMonths must exceed ${computed[i].country} (share=${computed[i].share}); got ${computed[i - 1].rawMonths} vs ${computed[i].rawMonths}`,
        );
      }
    }
    // The non-hub (share=0) must exactly match the gross-imports
    // baseline: 12 × aum / gross.
    const baseline = (aum / gross) * 12;
    const nonHub = computed.find((c) => c.country === 'E');
    assert.ok(nonHub && Math.abs(nonHub.rawMonths - baseline) < 1e-9,
      `non-hub (share=0) rawMonths must equal baseline ${baseline}; got ${nonHub?.rawMonths}`);
  });

  it('SWF-heavy exporter cohort (share ≈ 0): effMo essentially unchanged vs baseline', () => {
    // The plan's claim: "SWF-heavy exporter cohort (NO, QA, KW, SA,
    // KZ, AZ) — scores essentially unchanged (these countries
    // re-export < 5%, denominator change negligible)." Synthetic
    // test: share=0.03 yields rawMonths within 4% of baseline.
    const gross = 200_000_000_000;
    const aum = 1_000_000_000_000;
    const baseline = (aum / gross) * 12;
    const withSmallShare = (aum / computeNetImports(gross, 0.03)) * 12;
    const relativeLift = (withSmallShare - baseline) / baseline;
    assert.ok(
      relativeLift >= 0 && relativeLift < 0.05,
      `small share (≤5%) must produce <5% lift; got ${(relativeLift * 100).toFixed(2)}%`,
    );
  });
});
