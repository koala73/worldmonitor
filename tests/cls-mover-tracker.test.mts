import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diffPanelGeometry,
  formatMoverRecords,
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

describe('diffPanelGeometry (#5332 mover attribution)', () => {
  it('classifies height changes as movers with signed deltas', () => {
    const d = diffPanelGeometry(
      { intel: r(100, 200), politics: r(320, 200) },
      { intel: r(100, 380), politics: r(500, 200) },
    );
    assert.deepEqual(d.heightChangers, [{ key: 'intel', delta: 180 }]);
    assert.deepEqual(d.movedOnly, ['politics']);
    assert.deepEqual(d.inserted, []);
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
      { t: 1200, value: 0.31, heightChangers: [{ key: 'threat-timeline', delta: 180 }], inserted: [], movedOnly: ['intel', 'politics'] },
      { t: 400, value: 0.08, heightChangers: [], inserted: ['live-news'], movedOnly: [] },
      { t: 3000, value: 0.5, heightChangers: [{ key: 'cascade', delta: -64 }], inserted: [], movedOnly: [] },
      { t: 9000, value: 0.02, heightChangers: [{ key: 'x', delta: 10 }], inserted: [], movedOnly: [] },
    ]);
    assert.equal(out.length, 3);
    assert.match(out[0], /^t=3000 v=0\.5 grew:cascade-64/);
    assert.match(out[1], /^t=1200 v=0\.31 grew:threat-timeline\+180 moved:2/);
    assert.match(out[2], /^t=400 v=0\.08 ins:live-news/);
  });

  it('returns an empty array for no records', () => {
    assert.deepEqual(formatMoverRecords([]), []);
  });
});
