import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countryBox, type CountryBox } from '../shared/country-bbox.ts';
import { SCOPE_ISO2_CODES } from '../shared/tab-scope.ts';
import COUNTRY_CENTROIDS from '../scripts/data/country-centroids.json' with { type: 'json' };
import {
  FOCUS_CENTRES,
  FOCUS_FIT_MAX_ZOOM,
  focusCountryBox,
  focusFitBounds,
  GLOBE_MAX_ALTITUDE,
  focusGlobeAltitude,
  focusSingleWorldFitBounds,
  type FocusFitBounds,
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

  it('returns null for an empty list and for codes with neither a box nor a centre', () => {
    assert.equal(focusFitBounds([]), null);
    assert.equal(focusFitBounds(['XX', '']), null);
  });

  it('skips codes with neither a box nor a centre and fits the rest', () => {
    assert.deepEqual(focusFitBounds(['XX', 'MY']), focusFitBounds(['MY']));
  });

  it('fits a small state missing from the bundled boundaries around its centre', () => {
    // Singapore has no geometry in the bundled boundaries.
    assert.equal(countryBox('SG'), null);
    const fit = focusFitBounds(['SG']);
    assert.ok(fit);
    close(fit.center.lat, 1.36, 'SG lat');
    close(fit.center.lon, 103.82, 'SG lon');
    assert.ok(fit.lonSpan > 0 && fit.lonSpan <= 4 && fit.latSpan > 0 && fit.latSpan <= 4, `small box: ${fit.lonSpan} x ${fit.latSpan}`);
    // Together with a neighbour the union still reaches Singapore.
    const withMy = focusFitBounds(['SG', 'MY'])!;
    assert.ok(withMy.south <= 1.36 && withMy.north >= 1.36);
    assert.ok(withMy.west <= 103.82 && withMy.east >= 103.82);
  });

  it('can fit every selectable country except Antarctica', () => {
    const unfittable = SCOPE_ISO2_CODES.filter((code) => !focusFitBounds([code]));
    assert.deepEqual(unfittable, ['AQ']);
  });

  it('keeps the centre table to selectable countries without a box, copied from the sourced centroids', () => {
    const centroids = COUNTRY_CENTROIDS as Record<string, [number, number]>;
    for (const [code, centre] of Object.entries(FOCUS_CENTRES)) {
      assert.ok(SCOPE_ISO2_CODES.includes(code), `${code} is selectable`);
      assert.equal(countryBox(code), null, `${code} has a box, so it needs no centre`);
      assert.deepEqual(centre, centroids[code], `${code} matches scripts/data/country-centroids.json`);
    }
    // A centre box never crosses the antimeridian (Tuvalu sits at 179.2).
    for (const code of ['TV', 'WF', 'TO']) {
      const box = focusCountryBox(code)!;
      assert.ok(box.west <= box.east && box.west >= -180 && box.east <= 180, `${code}: ${JSON.stringify(box)}`);
    }
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

  /**
   * The longitudes a single-world flat map (MapLibre with renderWorldCopies
   * false, or the SVG map) shows after a fit: the zoom MapLibre's
   * cameraForBounds picks from the longitude span alone (latitude can only
   * lower it, which widens the view), capped at the focus max zoom, then the
   * centre clamped so the view stays inside the one world.
   */
  function singleWorldView(fit: FocusFitBounds, widthPx = 1200, paddingPx = 40): { west: number; east: number } {
    const worldPxAtZ0 = 512;
    const zoomForLon = Math.log2((widthPx - 2 * paddingPx) / ((fit.lonSpan / 360) * worldPxAtZ0));
    const zoom = Math.min(FOCUS_FIT_MAX_ZOOM, zoomForLon);
    const span = Math.min(360, (widthPx / (worldPxAtZ0 * 2 ** zoom)) * 360);
    const half = span / 2;
    const centre = Math.max(-180 + half, Math.min(180 - half, fit.center.lon));
    return { west: centre - half, east: centre + half };
  }

  function shows(view: { west: number; east: number }, box: CountryBox): boolean {
    return box.west >= view.west - 1e-9 && box.east <= view.east + 1e-9;
  }

  it('frames Fiji and the US inside the one world a flat map renders', () => {
    const fit = focusSingleWorldFitBounds(['FJ', 'US']);
    assert.ok(fit);
    assert.ok(fit.west >= -180 && fit.east <= 180, `one world: ${fit.west}..${fit.east}`);
    const view = singleWorldView(fit);
    assert.ok(shows(view, countryBox('FJ')!), `Fiji in ${JSON.stringify(view)}`);
    assert.ok(shows(view, countryBox('US')!), `US in ${JSON.stringify(view)}`);
    // The short arc across the dateline drops Fiji once the map clamps it
    // into one world: the reason the flat renderers do not use it.
    assert.ok(!shows(singleWorldView(focusFitBounds(['FJ', 'US'])!), countryBox('FJ')!));
  });

  it('keeps the short arc for flat maps when it does not cross the antimeridian', () => {
    assert.deepEqual(focusSingleWorldFitBounds(['TH', 'VN', 'ID']), focusFitBounds(['TH', 'VN', 'ID']));
    assert.deepEqual(focusSingleWorldFitBounds(['SG']), focusFitBounds(['SG']));
    assert.equal(focusSingleWorldFitBounds(['XX']), null);
    assert.equal(focusSingleWorldFitBounds(['AQ']), null);
  });

  it('frames Russia on a flat map by its body west of the antimeridian, not the whole world', () => {
    const fit = focusSingleWorldFitBounds(['RU']);
    assert.ok(fit);
    assert.equal(fit.west, 19.6);
    assert.equal(fit.east, 180);
    const withUs = focusSingleWorldFitBounds(['RU', 'US']);
    assert.ok(withUs);
    const view = singleWorldView(withUs);
    assert.ok(shows(view, { ...countryBox('US')! }), `US in ${JSON.stringify(view)}`);
    assert.ok(shows(view, { south: 41.21, west: 19.6, north: 81.29, east: 180 }), `Russia in ${JSON.stringify(view)}`);
  });

  it('frames widely separated countries as far out as the globe camera goes', () => {
    // GB and NZ are about 167 degrees apart: altitude 1.8 sees 69 degrees from
    // the camera's nadir, so no view of it could show both.
    const fit = focusFitBounds(['GB', 'NZ'])!;
    const altitude = focusGlobeAltitude(fit);
    assert.equal(altitude, GLOBE_MAX_ALTITUDE);
  });

  it('never frames a wide focus tighter than it can be seen', () => {
    const horizon = (altitude: number) => Math.acos(1 / (1 + altitude)) * 180 / Math.PI;
    const toRad = (d: number) => d * Math.PI / 180;
    const angle = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
      const d = Math.sin(toRad(a.lat)) * Math.sin(toRad(b.lat))
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(a.lon - b.lon));
      return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
    };
    for (const pair of [['GB', 'NZ'], ['US', 'AU'], ['BR', 'ID'], ['CL', 'JP'], ['AR', 'KR']]) {
      const fit = focusFitBounds(pair)!;
      const altitude = focusGlobeAltitude(fit);
      const radius = Math.max(
        ...[fit.south, fit.north].flatMap((lat) => [fit.west, fit.east].map((lon) => angle(fit.center, { lat, lon }))),
      );
      const needed = Math.min(radius, horizon(GLOBE_MAX_ALTITUDE));
      assert.ok(horizon(altitude) >= needed - 1e-6, `${pair}: sees ${horizon(altitude).toFixed(1)} of the ${needed.toFixed(1)} degrees it needs`);
    }
  });

  it('maps the fitted span to a globe altitude that grows with the span', () => {
    const small = focusGlobeAltitude(focusFitBounds(['LB'])!);
    const region = focusGlobeAltitude(focusFitBounds(['TH', 'VN', 'ID'])!);
    const wide = focusGlobeAltitude(focusFitBounds(['RU', 'US'])!);
    assert.ok(small < region && region < wide, `${small} < ${region} < ${wide}`);
    assert.ok(small > 0 && wide <= GLOBE_MAX_ALTITUDE);
  });
});
