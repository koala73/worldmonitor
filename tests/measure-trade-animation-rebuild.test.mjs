/**
 * Decision math for the #7781 trade-animation rebuild profile.
 * Browser capture lives in scripts/measure-trade-animation-rebuild.mjs;
 * these tests lock the attribution and stop-condition without Playwright.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  FRAME_BUDGET_MS,
  decideTradeAnimationIsolation,
  isSoftwareGlRenderer,
  parseArgs,
  summarizeLongTasks,
  summarizeProfile,
} from '../scripts/measure-trade-animation-rebuild.mjs';

function sample(overrides = {}) {
  return {
    totalMs: 0.4,
    jsBuildMs: 0.1,
    deckCommitMs: 0.2,
    layerCount: 8,
    nuclearIdentityChanged: true,
    tripsIdentityChanged: true,
    ...overrides,
  };
}

function cheapProfile(overrides = {}) {
  return {
    displayFrames: 61,
    warmupFrames: 20,
    zoom: 5,
    enabledLayers: ['nuclear', 'datacenters', 'tradeRoutes'],
    buildCount: 30,
    hintCallCount: 30,
    hintScanCount: 0,
    samples: Array.from({ length: 30 }, () => sample()),
    rafIntervalsMs: Array.from({ length: 60 }, () => 16.7),
    longTasks: [],
    fixture: {
      nuclearCount: 250,
      datacenterCount: 313,
      routeSegments: 57,
      trips: 21,
      chokepoints: 9,
      newsMarkers: 1,
      layerIds: ['nuclear-layer', 'datacenters-layer', 'trade-route-trips-layer'],
    },
    glRenderer: 'Apple GPU',
    ...overrides,
  };
}

describe('summarizeProfile (#7781)', () => {
  it('splits jsBuild vs deck commit and counts identity churn after the first sample', () => {
    const summary = summarizeProfile(cheapProfile({
      samples: [
        sample({ nuclearIdentityChanged: true, tripsIdentityChanged: true }),
        sample({ nuclearIdentityChanged: true, tripsIdentityChanged: true, totalMs: 0.5 }),
        sample({ nuclearIdentityChanged: false, tripsIdentityChanged: true, totalMs: 0.6 }),
      ],
      buildCount: 3,
    }));
    assert.equal(summary.sampleCount, 3);
    assert.equal(summary.jsBuildMs, 0.3);
    assert.equal(summary.deckCommitMs, 0.6);
    assert.equal(summary.nuclearIdentityChanges, 1);
    assert.equal(summary.tripsIdentityChanges, 2);
    assert.equal(summary.overBudgetCount, 0);
    assert.equal(summary.hintScanCount, 0);
  });

  it('counts over-budget samples and missed rAF intervals', () => {
    const summary = summarizeProfile(cheapProfile({
      samples: [
        sample({ totalMs: FRAME_BUDGET_MS + 1 }),
        sample({ totalMs: FRAME_BUDGET_MS + 4 }),
        sample({ totalMs: 1 }),
      ],
      rafIntervalsMs: [16, 33, 17, 41],
      longTasks: [{ name: 'self', duration: 80, startTime: 1 }],
    }));
    assert.equal(summary.overBudgetCount, 2);
    assert.equal(summary.missedFrameCount, 2);
    assert.equal(summary.longTasks.longTaskCount, 1);
    assert.equal(summary.longTasks.tbtMs, 30);
  });
});

describe('decideTradeAnimationIsolation (#7781)', () => {
  it('stops with no-change when rebuilds stay under the frame budget', () => {
    const on = summarizeProfile(cheapProfile());
    const off = summarizeProfile(cheapProfile({
      enabledLayers: ['nuclear', 'datacenters'],
      buildCount: 0,
      samples: [],
      hintCallCount: 0,
    }));
    const decision = decideTradeAnimationIsolation(on, off, { hardware: true });
    assert.equal(decision.decision, 'no-change');
    assert.match(decision.reason, /No repeatable main-thread/);
  });

  it('implements when unrelated rebuilds cause a repeatable budget miss versus trade-off', () => {
    const on = summarizeProfile(cheapProfile({
      samples: Array.from({ length: 30 }, () => sample({
        totalMs: 18,
        jsBuildMs: 6,
        deckCommitMs: 11,
      })),
    }));
    const off = summarizeProfile(cheapProfile({
      enabledLayers: ['nuclear', 'datacenters'],
      buildCount: 1,
      samples: [sample({ totalMs: 0.3, jsBuildMs: 0.1, deckCommitMs: 0.1 })],
    }));
    const decision = decideTradeAnimationIsolation(on, off, { hardware: true });
    assert.equal(decision.decision, 'implement');
    assert.ok(decision.extraPerBuildMs >= 1);
  });

  it('does not treat software-GL missed frames alone as a hardware win', () => {
    const on = summarizeProfile(cheapProfile({
      samples: Array.from({ length: 30 }, () => sample({ totalMs: 2 })),
      rafIntervalsMs: Array.from({ length: 60 }, () => 28),
    }));
    const off = summarizeProfile(cheapProfile({
      enabledLayers: ['nuclear', 'datacenters'],
      buildCount: 0,
      samples: [],
      rafIntervalsMs: Array.from({ length: 60 }, () => 16.7),
    }));
    const decision = decideTradeAnimationIsolation(on, off, { softwareGl: true, hardware: false });
    assert.equal(decision.decision, 'unmet');
    assert.match(decision.reason, /software-GL/);
  });

  it('reports unmet when trade-on collected no builds', () => {
    const empty = summarizeProfile({ samples: [], buildCount: 0, longTasks: [] });
    const decision = decideTradeAnimationIsolation(empty, empty);
    assert.equal(decision.decision, 'unmet');
  });

  it('does not implement when both fixtures miss the same display frames', () => {
    const stalls = Array.from({ length: 60 }, () => 28);
    const on = summarizeProfile(cheapProfile({
      samples: Array.from({ length: 30 }, () => sample({ totalMs: 0.6, jsBuildMs: 0.2, deckCommitMs: 0.4 })),
      rafIntervalsMs: stalls,
    }));
    const off = summarizeProfile(cheapProfile({
      enabledLayers: ['nuclear', 'datacenters'],
      buildCount: 0,
      samples: [],
      rafIntervalsMs: stalls,
    }));
    const decision = decideTradeAnimationIsolation(on, off, { hardware: true });
    assert.equal(decision.decision, 'no-change');
  });

  it('treats a SwiftShader renderer as software even without the CLI flag', () => {
    const on = summarizeProfile(cheapProfile({
      glRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)))',
      rafIntervalsMs: Array.from({ length: 60 }, () => 28),
    }));
    const off = summarizeProfile(cheapProfile({
      enabledLayers: ['nuclear', 'datacenters'],
      buildCount: 0,
      samples: [],
      rafIntervalsMs: Array.from({ length: 60 }, () => 16.7),
      glRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)))',
    }));
    const decision = decideTradeAnimationIsolation(on, off, { hardware: true, softwareGl: false });
    assert.equal(decision.decision, 'unmet');
    assert.equal(isSoftwareGlRenderer(on.glRenderer), true);
  });
});

describe('parseArgs', () => {
  it('defaults to the settled harness URL and production-profile flags off', () => {
    const args = parseArgs(['node', 'scripts/measure-trade-animation-rebuild.mjs']);
    assert.equal(args.url, 'http://127.0.0.1:4173/tests/map-harness.html?alert=false');
    assert.equal(args.cpu, 1);
    assert.equal(args.repeats, 3);
    assert.equal(args.frames, 61);
    assert.equal(args.softwareGl, false);
    assert.equal(args.startServer, false);
  });
});

describe('summarizeLongTasks', () => {
  it('returns zeros for empty input', () => {
    assert.deepEqual(summarizeLongTasks(undefined), {
      taskCount: 0,
      longTaskCount: 0,
      totalMs: 0,
      tbtMs: 0,
    });
  });
});

describe('summarizeProfile buildCount', () => {
  it('keeps an explicit zero build count instead of falling back to sample length', () => {
    const summary = summarizeProfile({
      buildCount: 0,
      samples: [sample()],
      longTasks: [],
    });
    assert.equal(summary.buildCount, 0);
    assert.equal(summary.sampleCount, 1);
  });
});

it('does not infer hardware from a generic WebGL renderer name', () => {
  const on = cheapProfile({ glRenderer: 'WebKit WebGL',
    rafIntervalsMs: Array.from({ length: 60 }, () => 28),
    samples: Array.from({ length: 30 }, () => sample({ totalMs: 2 })),
  });
  const off = cheapProfile({ buildCount: 0, samples: [] });
  const report = buildReport({ tradeOn: [on], tradeOff: [off] }, { headed: true });
  assert.equal(report.hardwareGl, false);
  assert.equal(report.decision.decision, 'unmet');
});
