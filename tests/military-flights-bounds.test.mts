import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasFiniteRequestBounds,
  normalizeBounds,
} from '../server/worldmonitor/military/v1/_bounds.ts';

type Req = Parameters<typeof normalizeBounds>[0];
const req = (over: Partial<Req> = {}): Req => ({
  swLat: 0,
  swLon: 0,
  neLat: 1,
  neLon: 1,
  ...over,
} as Req);

describe('military-flights request bounds normalization (#6249)', () => {
  it('wraps an unwrapped west longitude from a world-copy viewport', () => {
    // A narrow world-copy viewport that does not cross the antimeridian:
    // raw 185..190 wraps cleanly to -175..-170.
    const bounds = normalizeBounds(req({ swLon: 185, neLon: 190 }));
    assert.deepEqual(bounds, { south: 0, north: 1, west: -175, east: -170 });
    // The global seed coverage predicate accepts every wrapped box.
    assert.ok(bounds.west >= -180 && bounds.east <= 180);
  });

  it('widens a world-spanning viewport to the full longitude range', () => {
    const bounds = normalizeBounds(req({ swLon: -200, neLon: 170 }));
    assert.deepEqual(bounds, { south: 0, north: 1, west: -180, east: 180 });
  });

  it('widens a wrapped antimeridian-crossing box instead of inverting west/east', () => {
    // Raw 170..190 crosses the antimeridian: wrapped west=170 > east=-170.
    const bounds = normalizeBounds(req({ swLon: 170, neLon: 190 }));
    assert.deepEqual(bounds, { south: 0, north: 1, west: -180, east: 180 });
  });

  it('normalizes inverted corners by swapping before wrapping', () => {
    // sw/ne given as (170, -170): existing callers rely on min/max swapping.
    const bounds = normalizeBounds(req({ swLon: 170, neLon: -170 }));
    assert.deepEqual(bounds, { south: 0, north: 1, west: -170, east: 170 });
  });

  it('keeps exact antimeridian boundaries untouched', () => {
    const bounds = normalizeBounds(req({ swLat: -90, swLon: -180, neLat: 90, neLon: 180 }));
    assert.deepEqual(bounds, { south: -90, north: 90, west: -180, east: 180 });
  });

  it('does not widen a Pacific box that only touches +180', () => {
    // Fiji / MapLibre east-edge: wrap(+180) must stay +180, not invert to -180.
    assert.deepEqual(
      normalizeBounds(req({ swLon: 177.34, neLon: 180 })),
      { south: 0, north: 1, west: 177.34, east: 180 },
    );
    assert.deepEqual(
      normalizeBounds(req({ swLon: 140, neLon: 180 })),
      { south: 0, north: 1, west: 140, east: 180 },
    );
    // World-copy of 140..180.
    assert.deepEqual(
      normalizeBounds(req({ swLon: 500, neLon: 540 })),
      { south: 0, north: 1, west: 140, east: 180 },
    );
  });

  it('swaps inverted corners and wraps the result', () => {
    const bounds = normalizeBounds(req({ swLat: 10, swLon: 20, neLat: 5, neLon: 10 }));
    assert.deepEqual(bounds, { south: 5, north: 10, west: 10, east: 20 });
  });

  it('rejects non-finite coordinates before normalization', () => {
    for (const over of [
      { swLat: Number.NaN },
      { swLon: Number.POSITIVE_INFINITY },
      { neLat: Number.NaN },
      { neLon: Number.NEGATIVE_INFINITY },
    ]) {
      assert.equal(hasFiniteRequestBounds(req(over)), false, JSON.stringify(over));
    }
    assert.equal(hasFiniteRequestBounds(req()), true);
  });
});
