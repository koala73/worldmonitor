import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  globeAltitudeToMapZoom,
  mapZoomToGlobeAltitude,
} from '../src/utils/globe-zoom.ts';

const ANCHORS = [
  [1, 1.8],
  [2, 1.5],
  [2.5, 1.2],
  [3, 0.8],
  [4, 0.5],
  [5, 0.3],
  [6, 0.15],
  [7, 0.08],
  [8, 0.04],
  [9, 0.02],
  [10, 0.01],
] as const;

describe('globe logical zoom mapping', () => {
  it('maps every logical anchor in both directions', () => {
    for (const [zoom, altitude] of ANCHORS) {
      assert.ok(
        Math.abs(mapZoomToGlobeAltitude(zoom) - altitude) < 1e-12,
        `zoom ${zoom} should map to altitude ${altitude}`,
      );
      assert.ok(
        Math.abs(globeAltitudeToMapZoom(altitude) - zoom) < 1e-12,
        `altitude ${altitude} should map to zoom ${zoom}`,
      );
    }
  });

  it('round-trips fractional zooms across the full advertised 1-10 range', () => {
    for (const zoom of [1.25, 2.25, 2.5, 2.75, 4.5, 7.5, 8.75, 9.5]) {
      const roundTrip = globeAltitudeToMapZoom(mapZoomToGlobeAltitude(zoom));
      assert.ok(Math.abs(roundTrip - zoom) < 1e-12, `${zoom} round-tripped as ${roundTrip}`);
    }
  });

  it('keeps named preset altitudes stable through two-decimal URL zooms', () => {
    for (const altitude of [1.8, 1.5, 1.2]) {
      const serializedZoom = Number(globeAltitudeToMapZoom(altitude).toFixed(2));
      assert.ok(Math.abs(mapZoomToGlobeAltitude(serializedZoom) - altitude) < 1e-12);
    }
  });

  it('clamps invalid and out-of-range inputs to safe endpoints', () => {
    assert.equal(mapZoomToGlobeAltitude(Number.NaN), 1.8);
    assert.equal(mapZoomToGlobeAltitude(-10), 1.8);
    assert.equal(mapZoomToGlobeAltitude(50), 0.01);
    assert.equal(globeAltitudeToMapZoom(Number.NaN), 1);
    assert.equal(globeAltitudeToMapZoom(4), 1);
    assert.equal(globeAltitudeToMapZoom(0.001), 10);
  });
});
