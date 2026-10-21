import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMapColWidthBounds,
  clampMapColWidthPercent,
  MAP_COL_MIN_PERCENT,
  MAP_COL_MAX_PERCENT,
  MAP_COL_MIN_PX,
  MAP_COL_DEFAULT_PERCENT,
  PANELS_COL_MIN_PX,
  MAP_COL_DIVIDER_PX,
  getVisualMapSide,
  mapRightClassForVisualSide,
} from '../src/app/split-layout.ts';

describe('split-layout map column bounds', () => {
  it('falls back to the raw percentage bounds for unusable widths', () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(getMapColWidthBounds(width), {
        minPct: MAP_COL_MIN_PERCENT,
        maxPct: MAP_COL_MAX_PERCENT,
      });
    }
  });

  it('tightens both bounds by the pixel floors', () => {
    const { minPct, maxPct } = getMapColWidthBounds(1000);
    assert.equal(minPct, (MAP_COL_MIN_PX / 1000) * 100);
    assert.equal(maxPct, ((1000 - PANELS_COL_MIN_PX - MAP_COL_DIVIDER_PX) / 1000) * 100);
  });

  it('lets the map floor win on degenerate containers', () => {
    // Narrower than both floors combined: max collapses onto min.
    const { minPct, maxPct } = getMapColWidthBounds(400);
    assert.equal(minPct, maxPct);
    assert.equal(minPct, (MAP_COL_MIN_PX / 400) * 100);
  });

  it('clamps a non-finite percentage to the clamped default', () => {
    assert.equal(clampMapColWidthPercent(Number.NaN, 2200), MAP_COL_DEFAULT_PERCENT);
    // On a narrow container the default itself is clamped to the max bound.
    const { maxPct } = getMapColWidthBounds(700);
    assert.equal(clampMapColWidthPercent(Number.NaN, 700), Math.min(MAP_COL_DEFAULT_PERCENT, maxPct));
  });

  it('clamps out-of-range percentages into the effective bounds', () => {
    const { minPct, maxPct } = getMapColWidthBounds(1000);
    assert.equal(clampMapColWidthPercent(1, 1000), minPct);
    assert.equal(clampMapColWidthPercent(99, 1000), maxPct);
    assert.equal(clampMapColWidthPercent(50, 1000), 50);
  });

  it('maps persisted physical sides to logical grid columns under LTR and RTL', () => {
    assert.equal(mapRightClassForVisualSide('right', false), true);
    assert.equal(mapRightClassForVisualSide('left', false), false);
    assert.equal(mapRightClassForVisualSide('right', true), false);
    assert.equal(mapRightClassForVisualSide('left', true), true);

    assert.equal(getVisualMapSide(false, false), 'left');
    assert.equal(getVisualMapSide(true, false), 'right');
    assert.equal(getVisualMapSide(false, true), 'right');
    assert.equal(getVisualMapSide(true, true), 'left');
  });
});
