/**
 * #7112 — the two pure functions the SVG overlay marker budget rests on.
 *
 * Both were shipped wrong once and neither failure was visible to the browser
 * harness, which is why they are pinned here:
 *
 *  - `projectionPointAtScreenCentre` divided by zoom, putting the proximity
 *    focus a full viewport off-screen at zoom 4. The e2e test covering it only
 *    asserted that the marker set CHANGED after a pan/zoom, which is true of a
 *    wrong centre too.
 *  - `overlayMarkerPosition` had no branch for a weather alert's `centroid`, so
 *    the entire weather layer scored -Infinity and its proximity cut silently
 *    degenerated to raw feed order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  overlayMarkerPosition,
  projectionPointAtScreenCentre,
} from '../src/utils/overlay-marker-geometry.ts';
import { proximityRank } from '../src/utils/globe-marker-budget.ts';

/**
 * The wrapper transform MapComponent.applyTransform() actually writes:
 * `translate(tx,ty) scale(zoom)` with transform-origin 0 0, so a wrapper-local
 * point `x` paints at `tx + zoom*x`. Reimplemented from the renderer rather than
 * from the function under test, so the two have to agree independently.
 */
function screenCoordOf(projected: number, extent: number, zoom: number, pan: number): number {
  const translate = (extent / 2) * (1 - zoom) + pan * zoom;
  return translate + zoom * projected;
}

describe('projectionPointAtScreenCentre (#7112)', () => {
  it('names the point that actually paints at the centre of the viewport, at every zoom', () => {
    const width = 1440;
    const height = 900;
    for (const zoom of [1, 1.5, 2, 4, 10]) {
      for (const pan of [{ x: 0, y: 0 }, { x: 100, y: -60 }, { x: -320, y: 240 }]) {
        const [px, py] = projectionPointAtScreenCentre(width, height, pan);
        assert.equal(
          screenCoordOf(px, width, zoom, pan.x),
          width / 2,
          `projected x ${px} should paint at the horizontal centre at zoom ${zoom}`,
        );
        assert.equal(
          screenCoordOf(py, height, zoom, pan.y),
          height / 2,
          `projected y ${py} should paint at the vertical centre at zoom ${zoom}`,
        );
      }
    }
  });

  it('is the exact inverse of the pan setCenter() computes', () => {
    // setCenter derives `pan = width/2 - pos (independent of zoom)`. Round-tripping
    // any projected point through that pan must return the same point.
    const width = 1440;
    const height = 900;
    for (const pos of [[0, 0], [620, 300], [1439, 899], [-40, 12]] as const) {
      const pan = { x: width / 2 - pos[0], y: height / 2 - pos[1] };
      assert.deepEqual(projectionPointAtScreenCentre(width, height, pan), [pos[0], pos[1]]);
    }
  });

  it('rejects the divide-by-zoom form this function replaced', () => {
    // The regression, stated as a value: at zoom 4 the old expression named a
    // point one full viewport width off-screen to the left of the viewport.
    const width = 1440;
    const zoom = 4;
    const panX = 100;
    const wrong = width / (2 * zoom) - panX;
    assert.equal(screenCoordOf(wrong, width, zoom, panX), -1440);
    assert.notEqual(projectionPointAtScreenCentre(width, 900, { x: panX, y: 0 })[0], wrong);
  });
});

/**
 * One real payload shape per feed `renderOverlays` iterates. A feed whose
 * position cannot be read ranks -Infinity for its WHOLE layer, so a missing
 * branch here is a silent ranking failure, not a crash.
 */
const FEED_SHAPES: Array<[string, unknown, [number, number]]> = [
  ['vessel / flight / base / hotspot (lon,lat)', { lon: 12, lat: 34 }, [34, 12]],
  ['webcam (lng)', { lng: 12, lat: 34 }, [34, 12]],
  ['tech event (lng, null location)', { lng: 12, lat: 34, location: null }, [34, 12]],
  ['iran event (longitude/latitude)', { longitude: 12, latitude: 34 }, [34, 12]],
  ['earthquake (location.*)', { location: { longitude: 12, latitude: 34 } }, [34, 12]],
  ['acled event (location.*)', { location: { longitude: 12, latitude: 34 }, fatalities: 3 }, [34, 12]],
  ['conflict zone (center tuple)', { center: [12, 34] as const }, [34, 12]],
  ['weather alert (centroid tuple)', { centroid: [12, 34] as const, severity: 'Severe' }, [34, 12]],
];

describe('overlayMarkerPosition (#7112)', () => {
  for (const [name, marker, [lat, lng]] of FEED_SHAPES) {
    it(`reads ${name}`, () => {
      assert.deepEqual(overlayMarkerPosition(marker), { lat, lng });
    });
  }

  it('yields NaN for an unrecognised shape rather than a wrong coordinate', () => {
    const pos = overlayMarkerPosition({ id: 'no-geometry' });
    assert.ok(Number.isNaN(pos.lat) && Number.isNaN(pos.lng));
  });

  it('lets every feed shape rank against a real focus instead of collapsing to -Infinity', () => {
    // The weather regression in one assertion: a layer whose position cannot be
    // read scores -Infinity for every member, so proximityRank cannot order it
    // and the cut falls back to the raw feed order it exists to replace.
    const rank = proximityRank<unknown>({ lat: 34, lng: 12 }, overlayMarkerPosition);
    for (const [name, marker] of FEED_SHAPES) {
      assert.notEqual(rank(marker), -Infinity, `${name} must be rankable`);
    }
    assert.equal(rank({ id: 'no-geometry' }), -Infinity);
  });
});
