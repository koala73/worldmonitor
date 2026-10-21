import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_WEIGHTS,
  RESILIENCE_RETIRED_DIMENSIONS,
  type ResilienceDimensionId,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

// PR 2 §3.4 recovery-domain weight rebalance. The plan pins the two
// new dims (liquidReserveAdequacy, sovereignFiscalBuffer) at ~0.10
// share of the recovery-domain score, with the other four active
// recovery dims absorbing the residual. This test locks the share
// arithmetic against regression — any future weight change must
// explicitly update this test with the new targets so the operator
// rationale stays auditable.
//
// Math (6 active recovery dims at coverage=1.0, weights from
// RESILIENCE_DIMENSION_WEIGHTS):
//   fiscalSpace × 1.0
//   externalDebtCoverage × 1.0
//   importConcentration × 1.0
//   stateContinuity × 1.0
//   liquidReserveAdequacy × 0.5
//   sovereignFiscalBuffer × 0.5
// Total weighted coverage = 4.0 + 2×0.5 = 5.0
// Each new-dim share       = 0.5 / 5.0 = 0.10
// Each other-dim share     = 1.0 / 5.0 = 0.20
describe('recovery-domain weight rebalance (PR 2 §3.4)', () => {
  const recoveryDims = RESILIENCE_DIMENSION_ORDER.filter(
    (id) => RESILIENCE_DIMENSION_DOMAINS[id] === 'recovery',
  );
  const activeRecoveryDims = recoveryDims.filter(
    (id) => !RESILIENCE_RETIRED_DIMENSIONS.has(id),
  );

  it('exposes a per-dimension weight entry for every dim in the order', () => {
    for (const id of RESILIENCE_DIMENSION_ORDER) {
      assert.ok(
        RESILIENCE_DIMENSION_WEIGHTS[id] != null,
        `RESILIENCE_DIMENSION_WEIGHTS missing entry for ${id}. Every dim must have an explicit weight — default 1.0 is fine but must be spelled out so the rebalance decisions stay auditable.`,
      );
    }
  });

  it('pins liquidReserveAdequacy + sovereignFiscalBuffer at weight 0.5', () => {
    assert.equal(
      RESILIENCE_DIMENSION_WEIGHTS.liquidReserveAdequacy,
      0.5,
      'plan §3.4 targets ~10% recovery share; weight 0.5 with the other 4 dims at 1.0 gives 0.5/5.0 = 0.10',
    );
    assert.equal(
      RESILIENCE_DIMENSION_WEIGHTS.sovereignFiscalBuffer,
      0.5,
      'plan §3.4 targets ~10% recovery share; weight 0.5 with the other 4 dims at 1.0 gives 0.5/5.0 = 0.10',
    );
  });

  it('the four active core recovery dims carry weight 1.0', () => {
    const coreRecovery: ResilienceDimensionId[] = [
      'fiscalSpace',
      'externalDebtCoverage',
      'importConcentration',
      'stateContinuity',
    ];
    for (const id of coreRecovery) {
      assert.equal(
        RESILIENCE_DIMENSION_WEIGHTS[id],
        1.0,
        `${id} must carry weight 1.0 per plan §3.4 "other recovery dimensions absorb residual"`,
      );
    }
  });

  it('recovery-domain share math: each new dim = 10% at full coverage', () => {
    // Reproduce the coverage-weighted-mean share denominator using
    // coverage=1.0 for all active dims. If this ever diverges from
    // 0.10 the plan's target is no longer met.
    const weightSum = activeRecoveryDims.reduce(
      (s, id) => s + (RESILIENCE_DIMENSION_WEIGHTS[id] ?? 1),
      0,
    );
    const liquidShare = (RESILIENCE_DIMENSION_WEIGHTS.liquidReserveAdequacy) / weightSum;
    const swfShare = (RESILIENCE_DIMENSION_WEIGHTS.sovereignFiscalBuffer) / weightSum;
    // ±0.005 = tolerant of one future addition drifting the share
    // slightly; the plan says "~0.10" not exactly 0.10.
    assert.ok(
      Math.abs(liquidShare - 0.10) < 0.005,
      `liquidReserveAdequacy share at full coverage = ${liquidShare.toFixed(4)}, expected ~0.10`,
    );
    assert.ok(
      Math.abs(swfShare - 0.10) < 0.005,
      `sovereignFiscalBuffer share at full coverage = ${swfShare.toFixed(4)}, expected ~0.10`,
    );
  });

  it('retired recovery dims (reserveAdequacy, fuelStockDays) stay in the weight map', () => {
    // Retired dims have coverage=0 and so are neutralized at the
    // coverage channel regardless of weight. Keeping them in the
    // weight map at 1.0 rather than stripping them is the defensive
    // choice: if a future scorer bug accidentally returns coverage>0
    // for a retired dim, a missing weight entry here would make the
    // aggregation silently fall through to the `?? 1.0` default,
    // bypassing the retirement signal. Having explicit weights
    // enforces a single source of truth.
    assert.ok(RESILIENCE_DIMENSION_WEIGHTS.reserveAdequacy != null);
    assert.ok(RESILIENCE_DIMENSION_WEIGHTS.fuelStockDays != null);
  });
});
