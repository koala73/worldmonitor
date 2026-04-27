import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeLowConfidence,
  computeOverallCoverage,
} from '../server/worldmonitor/resilience/v1/_shared';
import type {
  GetResilienceScoreResponse,
  ResilienceDimension,
} from '../src/generated/server/worldmonitor/resilience/v1/service_server';

// PR 3 §3.5 follow-up (reviewer P1): the retired dimension (fuelStockDays,
// post-retirement) returns coverage=0 structurally and contributes zero
// weight to the domain score via coverageWeightedMean. The user-facing
// confidence/coverage averages must exclude retired dims — otherwise
// the retirement silently drags the reported averageCoverage down for
// every country even though the dimension is not part of the score.
//
// Reviewer anchor: on the US profile, including retired dims gave
// averageCoverage=0.8105 vs 0.8556 when retired dims are excluded —
// enough drift to misclassify edge countries as lowConfidence and to
// shift the widget's overallCoverage pill for the whole ranking.
//
// Critical invariant: the filter is keyed on the retired-dim REGISTRY,
// not on `coverage === 0`. Non-retired dimensions can legitimately
// emit coverage=0 on genuinely sparse-data countries via weightedBlend
// fall-through, and those entries MUST continue to drag confidence
// down — that is the sparse-data signal lowConfidence exists to
// surface. A too-aggressive `coverage === 0` filter would hide the
// sparsity and e.g. let South Sudan pass as full-confidence.

function dim(id: string, coverage: number): ResilienceDimension {
  return {
    id,
    score: 50,
    coverage,
    observedWeight: coverage > 0 ? 1 : 0,
    imputedWeight: 0,
    imputationClass: '',
    freshness: { lastObservedAtMs: '0', staleness: '' },
  };
}

describe('computeOverallCoverage: retired-dim exclusion', () => {
  it('excludes retired dimensions from the average', () => {
    const response = {
      domains: [
        {
          id: 'recovery',
          dimensions: [
            dim('fiscalSpace', 0.9),
            dim('liquidReserveAdequacy', 0.8),  // active replacement for reserveAdequacy
            // Retired dims contribute coverage=0 in real payloads; both
            // must be filtered out so the visible coverage reading
            // tracks only the active dims.
            dim('reserveAdequacy', 0),          // retired in PR 2 §3.4
            dim('fuelStockDays', 0),            // retired in PR 3 §3.5
          ],
        },
      ],
    } as unknown as GetResilienceScoreResponse;

    // (0.9 + 0.8) / 2 = 0.85 — only the two active dims count.
    // With retired included the flat mean would be
    // (0.9 + 0.8 + 0 + 0) / 4 = 0.425 — the regression shape.
    assert.equal(computeOverallCoverage(response).toFixed(4), '0.8500');
  });

  it('keeps NON-retired coverage=0 dims in the average (sparse-data signal)', () => {
    // A genuinely sparse-data country can emit coverage=0 on non-retired
    // dims via weightedBlend fall-through. Those entries must stay in
    // the average so sparse countries still surface as low confidence
    // via the flat mean path.
    const response = {
      domains: [
        {
          id: 'economic',
          dimensions: [
            dim('macroFiscal', 0.9),
            // NON-retired coverage=0: represents genuine data sparsity.
            dim('currencyExternal', 0),
          ],
        },
      ],
    } as unknown as GetResilienceScoreResponse;

    // (0.9 + 0) / 2 = 0.45. If the filter were keyed on coverage=0,
    // the genuine sparsity would be hidden and this would be 0.9.
    assert.equal(computeOverallCoverage(response).toFixed(4), '0.4500');
  });

  it('returns 0 when ALL dims are retired (degenerate case)', () => {
    const response = {
      domains: [
        { id: 'recovery', dimensions: [dim('fuelStockDays', 0)] },
      ],
    } as unknown as GetResilienceScoreResponse;
    assert.equal(computeOverallCoverage(response), 0);
  });
});

describe('computeLowConfidence: retired-dim exclusion', () => {
  it('does not flip lowConfidence purely on retired-dim drag', () => {
    // Three active dims at 0.72 = 0.72 mean (above the low-confidence
    // threshold). A single retired dim at coverage=0 must not flip the
    // flag by dragging the flat mean below the threshold — that was
    // the regression on the US profile.
    const dims = [
      dim('fiscalSpace', 0.72),
      dim('reserveAdequacy', 0.72),
      dim('externalDebtCoverage', 0.72),
      dim('fuelStockDays', 0), // retired
    ];
    assert.equal(computeLowConfidence(dims, 0), false,
      'retired fuelStockDays must not flip lowConfidence for an otherwise well-covered country');
  });

  it('DOES flip lowConfidence for non-retired coverage=0 dims (sparse data)', () => {
    // A sparse-data country: multiple non-retired dims at coverage=0
    // via weightedBlend fall-through. The flat mean drops below the
    // threshold and the flag must fire — this is the sparse-data
    // signal lowConfidence exists to surface. A too-aggressive filter
    // on coverage=0 would hide this.
    const dims = [
      dim('macroFiscal', 0.9),
      dim('currencyExternal', 0),   // non-retired coverage=0
      dim('tradePolicy', 0),     // non-retired coverage=0
      dim('cyberDigital', 0),       // non-retired coverage=0
    ];
    assert.equal(computeLowConfidence(dims, 0), true,
      'non-retired coverage=0 dims must drag lowConfidence down — that is the sparse-data signal');
  });

  it('respects the imputationShare threshold independently', () => {
    // Imputation-share check is a separate arm of the OR; retired-dim
    // filtering must not suppress a legitimate high-imputation-share
    // trigger.
    const dims = [dim('fiscalSpace', 0.95)];
    assert.equal(computeLowConfidence(dims, 0.6), true,
      'imputationShare > 0.4 must flip lowConfidence even when coverage looks strong');
  });
});
