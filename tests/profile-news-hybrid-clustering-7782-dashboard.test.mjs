import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FRAME_BUDGET_MS,
  buildDashboardCaseSummary,
  decideDashboardAttribution,
} from '../scripts/profile-news-hybrid-clustering-7782-dashboard.mjs';

function sample(overrides = {}) {
  return {
    selectedPath: 'hybrid',
    mlAvailableAtSelection: true,
    itemCount: 289,
    clusterCount: 261,
    totalLatencyMs: 20,
    mainThreadTaskMs: 10,
    coreMs: 18,
    coreFrameIntervalsMs: [20],
    coreLongTasksMs: [],
    ...overrides,
  };
}

describe('dashboard hybrid-clustering attribution gate (#7782)', () => {
  it('summarizes exact path proof and frame misses for one dashboard case', () => {
    const summary = buildDashboardCaseSummary('representative', 'hybrid', [
      sample({ coreMs: 18, coreFrameIntervalsMs: [20] }),
      sample({ coreMs: 17, coreFrameIntervalsMs: [19] }),
      sample({ coreMs: 15, coreFrameIntervalsMs: [16] }),
    ]);

    assert.equal(summary.pathProof.selectedEverySample, true);
    assert.equal(summary.pathProof.mlAvailableEverySample, true);
    assert.equal(summary.itemCount, 289);
    assert.equal(summary.coreMs.median, 17);
    assert.equal(summary.coreFrameBudgetMissCount, 2);
    assert.equal(summary.repeatableCoreFrameMiss, true);
    assert.equal(summary.coreLongTaskCount, 0);
  });

  it('requires the production dashboard to select hybrid with local ML available', () => {
    const hybrid = buildDashboardCaseSummary('representative', 'hybrid', [
      sample({ selectedPath: 'analysis-worker', mlAvailableAtSelection: false }),
    ]);
    const worker = buildDashboardCaseSummary('representative', 'analysis-worker', [
      sample({ selectedPath: 'analysis-worker', coreMs: 0, mainThreadTaskMs: 2 }),
    ]);

    assert.deepEqual(decideDashboardAttribution([hybrid, worker]), {
      decision: 'unmet',
      reason: 'The representative hybrid generation was not selected with local ML available for every sample.',
    });
  });

  it('stops without production movement when the synchronous core does not repeatably miss a frame budget', () => {
    const hybrid = buildDashboardCaseSummary('representative', 'hybrid', [
      sample({ coreMs: 12, coreFrameIntervalsMs: [16] }),
      sample({ coreMs: 14, coreFrameIntervalsMs: [16.5] }),
      sample({ coreMs: 15, coreFrameIntervalsMs: [16.6] }),
    ]);
    const worker = buildDashboardCaseSummary('representative', 'analysis-worker', [
      sample({ selectedPath: 'analysis-worker', coreMs: 0, mainThreadTaskMs: 2 }),
    ]);

    assert.deepEqual(decideDashboardAttribution([hybrid, worker]), {
      decision: 'no-change',
      reason: `No representative dashboard frame miss or ${FRAME_BUDGET_MS} ms core overrun repeated across samples.`,
    });
  });

  it('permits offload only when the existing worker removes an attributed repeated miss', () => {
    const hybrid = buildDashboardCaseSummary('representative', 'hybrid', [
      sample({ coreMs: 18, coreFrameIntervalsMs: [20], mainThreadTaskMs: 12 }),
      sample({ coreMs: 19, coreFrameIntervalsMs: [22], mainThreadTaskMs: 13 }),
      sample({ coreMs: 17, coreFrameIntervalsMs: [21], mainThreadTaskMs: 11 }),
    ]);
    const worker = buildDashboardCaseSummary('representative', 'analysis-worker', [
      sample({ selectedPath: 'analysis-worker', coreMs: 0, coreFrameIntervalsMs: [], mainThreadTaskMs: 2 }),
      sample({ selectedPath: 'analysis-worker', coreMs: 0, coreFrameIntervalsMs: [], mainThreadTaskMs: 3 }),
      sample({ selectedPath: 'analysis-worker', coreMs: 0, coreFrameIntervalsMs: [], mainThreadTaskMs: 2 }),
    ]);

    assert.deepEqual(decideDashboardAttribution([hybrid, worker]), {
      decision: 'implement',
      reason: 'The existing analysis worker removed a repeatable representative frame-budget miss with lower renderer task occupancy.',
    });
  });

  it('does not claim the worker removed the miss when its own path repeats it', () => {
    const hybrid = buildDashboardCaseSummary('representative', 'hybrid', [
      sample({ coreMs: 18, coreFrameIntervalsMs: [20], mainThreadTaskMs: 12 }),
      sample({ coreMs: 19, coreFrameIntervalsMs: [22], mainThreadTaskMs: 13 }),
      sample({ coreMs: 17, coreFrameIntervalsMs: [21], mainThreadTaskMs: 11 }),
    ]);
    const worker = buildDashboardCaseSummary('representative', 'analysis-worker', [
      sample({ selectedPath: 'analysis-worker', coreMs: 0, pathFrameIntervalsMs: [20], mainThreadTaskMs: 2 }),
      sample({ selectedPath: 'analysis-worker', coreMs: 0, pathFrameIntervalsMs: [21], mainThreadTaskMs: 3 }),
      sample({ selectedPath: 'analysis-worker', coreMs: 0, pathFrameIntervalsMs: [], mainThreadTaskMs: 2 }),
    ]);

    assert.deepEqual(decideDashboardAttribution([hybrid, worker]), {
      decision: 'no-change',
      reason: 'A repeated representative miss was observed, but the existing worker did not improve both frame delivery and renderer task occupancy.',
    });
  });
});
