import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FOCUS_FIT_MAX_ZOOM,
  focusFitBounds,
  focusGlobeAltitude,
} from '../src/utils/focus-map.ts';

function close(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}

describe('focus map fit (#10453)', () => {
  it('unions Thailand, Vietnam and Indonesia into one box', () => {
    const fit = focusFitBounds(['TH', 'VN', 'ID']);
    assert.ok(fit);
    // ID gives the west, east and south edges; VN the north.
    assert.equal(fit.west, 95.2);
    assert.equal(fit.east, 140.98);
    assert.equal(fit.south, -10.34);
    assert.equal(fit.north, 23.32);
    close(fit.lonSpan, 140.98 - 95.2, 'lonSpan');
    close(fit.latSpan, 23.32 + 10.34, 'latSpan');
    close(fit.center.lat, (23.32 - 10.34) / 2, 'center.lat');
    close(fit.center.lon, (95.2 + 140.98) / 2, 'center.lon');
  });

  it('does not depend on the order the countries were chosen in', () => {
    assert.deepEqual(focusFitBounds(['ID', 'VN', 'TH']), focusFitBounds(['TH', 'VN', 'ID']));
  });

  it('fits Fiji and the US across the Pacific, not across Europe', () => {
    const fit = focusFitBounds(['FJ', 'US']);
    assert.ok(fit);
    // The shortest arc runs east from Fiji (177.34) over the dateline to the
    // US east coast (-66.98, unwrapped to 293.02): about 116 degrees. The
    // naive min/max box would span 345 degrees through Greenwich.
    assert.equal(fit.west, 177.34);
    close(fit.east, -66.98 + 360, 'east');
    close(fit.lonSpan, 293.02 - 177.34, 'lonSpan');
    assert.ok(fit.east > 180, 'east is unwrapped past 180 so renderers fit across the dateline');
    assert.ok(fit.center.lon >= -180 && fit.center.lon < 180, `center normalized: ${fit.center.lon}`);
    close(fit.center.lon, (177.34 + 293.02) / 2 - 360, 'center.lon');
  });

  it('keeps a country whose own box crosses the dateline on its tight arc', () => {
    const fit = focusFitBounds(['RU']);
    assert.ok(fit);
    assert.equal(fit.west, 19.6);
    close(fit.east, -169.7 + 360, 'east');
    assert.ok(fit.lonSpan < 180, `Russia spans ${fit.lonSpan}, not the world`);
    assert.ok(fit.center.lon > 60 && fit.center.lon < 140, `Russia centre is Siberia, not ${fit.center.lon}`);
  });

  it('chooses the shorter arc when Russia and the US are both chosen', () => {
    const fit = focusFitBounds(['RU', 'US']);
    assert.ok(fit);
    // East from Russia's west edge over the Bering Strait to the US east coast.
    assert.equal(fit.west, 19.6);
    close(fit.east, -66.98 + 360, 'east');
    assert.ok(fit.lonSpan < 360);
  });

  it('fits a single small country to its own box', () => {
    const fit = focusFitBounds(['LB']);
    assert.ok(fit);
    assert.deepEqual(
      { south: fit.south, west: fit.west, north: fit.north, east: fit.east },
      { south: 33.09, west: 35.11, north: 34.65, east: 36.6 },
    );
    // The renderers clamp the zoom so a small country does not fill the map
    // at street level.
    assert.ok(FOCUS_FIT_MAX_ZOOM >= 4 && FOCUS_FIT_MAX_ZOOM <= 7);
  });

  it('returns null for an empty list, unknown codes, and countries without a box', () => {
    assert.equal(focusFitBounds([]), null);
    assert.equal(focusFitBounds(['XX', '']), null);
    // Singapore has no geometry in the bundled boundaries.
    assert.equal(focusFitBounds(['SG']), null);
  });

  it('skips countries without a box and fits the rest', () => {
    assert.deepEqual(focusFitBounds(['SG', 'MY']), focusFitBounds(['MY']));
  });

  it('returns null when a chosen country covers every longitude', () => {
    assert.equal(focusFitBounds(['AQ']), null);
    assert.equal(focusFitBounds(['AQ', 'TH']), null);
  });

  it('clamps latitude to the Web Mercator range', () => {
    const fit = focusFitBounds(['GL']);
    assert.ok(fit);
    assert.ok(fit.north <= 85 && fit.south >= -85);
  });

  it('accepts an injected box lookup', () => {
    const fit = focusFitBounds(['AA', 'BB'], (code) => (code === 'AA'
      ? { south: -20, west: 170, north: -10, east: -175 }
      : code === 'BB' ? { south: -5, west: -170, north: 0, east: -160 } : null));
    assert.ok(fit);
    assert.equal(fit.west, 170);
    assert.equal(fit.east, 200);
    assert.equal(fit.center.lon, -175);
  });

  it('maps the fitted span to a globe altitude that grows with the span', () => {
    const small = focusGlobeAltitude(focusFitBounds(['LB'])!);
    const region = focusGlobeAltitude(focusFitBounds(['TH', 'VN', 'ID'])!);
    const wide = focusGlobeAltitude(focusFitBounds(['RU', 'US'])!);
    assert.ok(small < region && region < wide, `${small} < ${region} < ${wide}`);
    assert.ok(small > 0 && wide <= 2.5);
  });
});
