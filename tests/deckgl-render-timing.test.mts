import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  summarizeRenderTiming,
  formatRenderTiming,
  FRAME_BUDGET_MS,
} from '../src/components/map/render-timing.ts';

describe('summarizeRenderTiming (#4558 U1)', () => {
  it('splits a heavy frame into jsBuild vs deck buckets (happy path)', () => {
    const s = summarizeRenderTiming({
      total: 7935,
      jsBuild: 5200,
      layerCount: 18,
      changedHeavyLayers: ['conflict-zones-layer', 'protest-clusters'],
    });
    assert.equal(s.total, 7935);
    assert.equal(s.jsBuild, 5200);
    assert.equal(s.deckCommit, 7935 - 5200);
    assert.equal(s.layerCount, 18);
    assert.deepEqual(s.changedHeavyLayers, ['conflict-zones-layer', 'protest-clusters']);
    assert.equal(s.overBudget, true);
  });

  it('returns a zero summary for empty/zero parts without NaN (edge case)', () => {
    const s = summarizeRenderTiming({ total: 0 });
    assert.equal(s.total, 0);
    assert.equal(s.jsBuild, 0);
    assert.equal(s.deckCommit, 0);
    assert.equal(s.layerCount, 0);
    assert.deepEqual(s.changedHeavyLayers, []);
    assert.equal(s.overBudget, false);
    assert.ok(!Number.isNaN(s.deckCommit));
  });

  it('floors deckCommit at 0 when a noisy rebuild measurement exceeds total', () => {
    const s = summarizeRenderTiming({ total: 100, jsBuild: 140 });
    // rebuild is clamped to total; deckCommit never goes negative
    assert.equal(s.jsBuild, 100);
    assert.equal(s.deckCommit, 0);
  });

  it('ignores negative / non-finite inputs', () => {
    const s = summarizeRenderTiming({
      total: -5,
      jsBuild: Number.NaN,
      layerCount: -3,
    });
    assert.equal(s.total, 0);
    assert.equal(s.jsBuild, 0);
    assert.equal(s.deckCommit, 0);
    assert.equal(s.layerCount, 0);
  });

  it('marks frames over the 16ms budget and copies the heavy-layer list defensively', () => {
    const input = ['conflict-zones-layer'];
    const s = summarizeRenderTiming({ total: FRAME_BUDGET_MS + 1, changedHeavyLayers: input });
    assert.equal(s.overBudget, true);
    input.push('mutated');
    assert.deepEqual(s.changedHeavyLayers, ['conflict-zones-layer']); // not aliased
  });

  it('formatRenderTiming renders a compact one-line summary', () => {
    const line = formatRenderTiming(
      summarizeRenderTiming({ total: 1200.4, jsBuild: 800, layerCount: 12, changedHeavyLayers: ['x'] }),
    );
    assert.match(line, /render 1200\.4ms/);
    assert.match(line, /jsBuild 800\.0/);
    assert.match(line, /deck 400\.4/);
    assert.match(line, /layers=12/);
    assert.match(line, /changed=\[x\]/);
  });
});
