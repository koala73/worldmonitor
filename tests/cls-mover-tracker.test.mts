import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diffPanelGeometry,
  formatMoverRecords,
  getMoverRecordStrings,
  resetClsMoverTrackingForTesting,
  startClsMoverTracking,
  type PanelRect,
} from '../src/bootstrap/cls-mover-tracker';

// #5332: the clsText/largestShiftTarget rankings measure shift VICTIMS (what
// moved), not MOVERS (what changed size and pushed them) — proven when pinning
// the ranked panels' heights left field CLS unmoved. This module names movers
// directly: at shift time it diffs a per-panel geometry cache; a panel whose
// HEIGHT changed is a mover, a panel whose position changed at constant height
// is a victim, and a panel present now but absent from the cache is an
// insertion. The diff core is pure and tested here without DOM.

const r = (top: number, height: number): PanelRect => ({ top, height });

function withGlobals<T>(values: Record<string, unknown>, fn: () => T): T {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  try {
    return fn();
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

interface FakePanel {
  dataset: { panel?: string; clsMover?: string };
  top: number;
  height: number;
  getBoundingClientRect: () => { top: number; height: number };
}

function fakePanel(key: string, top: number, height: number, kind: 'panel' | 'mover' = 'panel'): FakePanel {
  const panel: FakePanel = {
    dataset: kind === 'panel' ? { panel: key } : { clsMover: key },
    top,
    height,
    getBoundingClientRect: () => ({ top: panel.top, height: panel.height }),
  };
  return panel;
}

function withTrackerHarness<T>(
  initialGrid: FakePanel[] | null,
  fn: (harness: {
    setGrid: (panels: FakePanel[] | null) => void;
    deliver: (entries: Array<{ startTime: number; value: number; hadRecentInput: boolean }>) => void;
    restoreFromBfcache: () => void;
    observeCalls: () => number;
  }) => T,
): T {
  let panelsGrid = initialGrid;
  let callback: ((list: { getEntries: () => unknown[] }) => void) | undefined;
  let observeCount = 0;
  const pageShowListeners = new Set<(event: { persisted: boolean }) => void>();
  const grid = {
    querySelectorAll: () => panelsGrid ?? [],
  };
  const fakeDocument = {
    getElementById: (id: string) => id === 'panelsGrid' && panelsGrid !== null ? grid : null,
  };
  const fakeWindow = {
    scrollY: 0,
    addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      if (type === 'pageshow') pageShowListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      if (type === 'pageshow') pageShowListeners.delete(listener);
    },
  };
  class FakePerformanceObserver {
    constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
      callback = cb;
    }
    observe(): void {
      observeCount += 1;
    }
    disconnect(): void {}
  }

  return withGlobals({
    document: fakeDocument,
    window: fakeWindow,
    performance: { now: () => 1_000 },
    PerformanceObserver: FakePerformanceObserver,
  }, () => {
    resetClsMoverTrackingForTesting();
    try {
      return fn({
        setGrid: (panels) => { panelsGrid = panels; },
        deliver: (entries) => callback?.({ getEntries: () => entries }),
        restoreFromBfcache: () => {
          for (const listener of pageShowListeners) listener({ persisted: true });
        },
        observeCalls: () => observeCount,
      });
    } finally {
      resetClsMoverTrackingForTesting();
    }
  });
}

describe('diffPanelGeometry (#5332 mover attribution)', () => {
  it('classifies height changes as movers with signed deltas', () => {
    const d = diffPanelGeometry(
      { intel: r(100, 200), politics: r(320, 200) },
      { intel: r(100, 380), politics: r(500, 200) },
    );
    assert.deepEqual(d.heightChangers, [{ key: 'intel', delta: 180 }]);
    assert.deepEqual(d.movedOnly, ['politics']);
    assert.deepEqual(d.inserted, []);
    assert.deepEqual(d.removed, []);
  });

  it('classifies shrinkage as a mover too', () => {
    const d = diffPanelGeometry({ intel: r(100, 380) }, { intel: r(100, 200) });
    assert.deepEqual(d.heightChangers, [{ key: 'intel', delta: -180 }]);
  });

  it('ignores sub-threshold jitter (<=2px)', () => {
    const d = diffPanelGeometry({ intel: r(100, 200) }, { intel: r(101, 202) });
    assert.deepEqual(d.heightChangers, []);
    assert.deepEqual(d.movedOnly, []);
  });

  it('reports panels present now but not in the cache as insertions', () => {
    const d = diffPanelGeometry({ intel: r(100, 200) }, { intel: r(100, 200), 'live-news': r(320, 764) });
    assert.deepEqual(d.inserted, ['live-news']);
  });

  it('a mover is not double-counted as a victim', () => {
    const d = diffPanelGeometry({ intel: r(100, 200) }, { intel: r(50, 380) });
    assert.deepEqual(d.heightChangers, [{ key: 'intel', delta: 180 }]);
    assert.deepEqual(d.movedOnly, []);
  });
});

describe('formatMoverRecords', () => {
  it('formats compact strings, largest shift first, capped at three', () => {
    const out = formatMoverRecords([
      { t: 1200, value: 0.31, heightChangers: [{ key: 'threat-timeline', delta: 180 }], inserted: [], removed: [], movedOnly: ['intel', 'politics'] },
      { t: 400, value: 0.08, heightChangers: [], inserted: ['live-news'], removed: [], movedOnly: [] },
      { t: 3000, value: 0.5, heightChangers: [{ key: 'cascade', delta: -64 }], inserted: [], removed: [], movedOnly: [] },
      { t: 9000, value: 0.02, heightChangers: [{ key: 'x', delta: 10 }], inserted: [], removed: [], movedOnly: [] },
    ]);
    assert.equal(out.length, 3);
    assert.match(out[0], /^t=3000 v=0\.5 sized:cascade-64/);
    assert.match(out[1], /^t=1200 v=0\.31 sized:threat-timeline\+180 moved:2/);
    assert.match(out[2], /^t=400 v=0\.08 ins:live-news/);
  });

  it('returns an empty array for no records', () => {
    assert.deepEqual(formatMoverRecords([]), []);
  });

  it('labels removed panels and cold-start records (review P2s)', () => {
    const out = formatMoverRecords([
      { t: 800, value: 0.2, heightChangers: [], inserted: [], removed: ['live-news'], movedOnly: ['intel'] },
      { t: 300, value: 0.4, heightChangers: [], inserted: [], removed: [], movedOnly: [], coldStart: true },
    ]);
    assert.match(out[0], /^t=300 v=0\.4 cold$/);
    assert.match(out[1], /^t=800 v=0\.2 rem:live-news moved:1$/);
  });
});

describe('removed-panel detection (review P2)', () => {
  it('reports panels in the cache but gone from the layout as removed movers', () => {
    const d = diffPanelGeometry(
      { intel: r(100, 200), 'live-news': r(320, 764) },
      { intel: r(100, 200) },
    );
    assert.deepEqual(d.removed, ['live-news']);
    assert.deepEqual(d.heightChangers, []);
  });
});

describe('startClsMoverTracking observer lifecycle', () => {
  it('refreshes after input shifts and attributes one combined observer delivery', () => {
    const intel = fakePanel('intel', 100, 200);
    const politics = fakePanel('politics', 320, 200);
    withTrackerHarness([intel, politics], ({ deliver, observeCalls }) => {
      startClsMoverTracking();
      startClsMoverTracking();
      assert.equal(observeCalls(), 1, 'tracker startup is idempotent');

      intel.height = 300;
      politics.top = 420;
      deliver([{ startTime: 100, value: 0.03, hadRecentInput: true }]);
      assert.deepEqual(getMoverRecordStrings(), [], 'input-driven shifts only refresh the baseline');

      politics.top = 450;
      deliver([
        { startTime: 200, value: 0.03, hadRecentInput: false },
        { startTime: 220, value: 0.03, hadRecentInput: false },
      ]);
      assert.deepEqual(getMoverRecordStrings(), ['t=220 v=0.06 moved:1 n=2']);
    });
  });

  it('tracks stable CTA mover keys and clears the ring on bfcache restore', () => {
    const intel = fakePanel('intel', 100, 200);
    const proCta = fakePanel('pro-widget-cta', 320, 200, 'mover');
    withTrackerHarness([intel], ({ setGrid, deliver, restoreFromBfcache }) => {
      startClsMoverTracking();
      setGrid([intel, proCta]);
      deliver([{ startTime: 300, value: 0.1, hadRecentInput: false }]);
      assert.deepEqual(getMoverRecordStrings(), ['t=300 v=0.1 ins:pro-widget-cta']);

      restoreFromBfcache();
      assert.deepEqual(getMoverRecordStrings(), []);
      proCta.height = 260;
      deliver([{ startTime: 900, value: 0.12, hadRecentInput: false }]);
      assert.deepEqual(getMoverRecordStrings(), ['t=900 v=0.12 sized:pro-widget-cta+60']);
    });
  });

  it('records all tracked children disappearing as removals', () => {
    const intel = fakePanel('intel', 100, 200);
    withTrackerHarness([intel], ({ setGrid, deliver }) => {
      startClsMoverTracking();
      setGrid([]);
      deliver([{ startTime: 500, value: 0.1, hadRecentInput: false }]);
      assert.deepEqual(getMoverRecordStrings(), ['t=500 v=0.1 rem:intel']);
    });
  });

  it('marks the first qualifying shift cold when registration precedes the grid', () => {
    const intel = fakePanel('intel', 100, 200);
    withTrackerHarness(null, ({ setGrid, deliver }) => {
      startClsMoverTracking();
      setGrid([intel]);
      deliver([{ startTime: 120, value: 0.2, hadRecentInput: false }]);
      assert.deepEqual(getMoverRecordStrings(), ['t=120 v=0.2 cold']);
    });
  });
});
