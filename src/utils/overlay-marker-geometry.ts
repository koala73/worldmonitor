/**
 * Pure geometry the SVG map's overlay marker budget depends on (#7112).
 *
 * Split out of `MapComponent` for the same reason `globe-marker-budget.ts` is:
 * both functions are total, DOM-free and easy to get subtly wrong, so they are
 * unit-tested directly against real payload shapes and the renderer's own
 * transform algebra rather than through a browser harness that can only observe
 * that "something changed".
 */
import type { LatLng } from './globe-marker-budget';

/**
 * Reads a marker's coordinates across every feed shape `renderOverlays` iterates
 * (#7112): most expose `lon`/`lat`, webcams use `lng`, Iran events use the long
 * spellings, earthquakes and ACLED events nest them under `location`, conflict
 * zones carry a `[lon, lat]` `center` tuple and weather alerts a `[lon, lat]`
 * `centroid`. A shape with none of them yields NaN, which `proximityRank`
 * already sorts last rather than poisoning the comparator — the same outcome as
 * the render loops, which skip a null position.
 *
 * Every branch here is load-bearing: a feed whose position cannot be read ranks
 * -Infinity for the WHOLE layer, so the proximity cut silently degenerates to
 * raw feed order — the outcome `proximityRank`'s own docstring calls
 * indefensible. `overlay-marker-geometry.test.mts` pins one real payload per
 * shape so a new feed with a fifth spelling fails loudly instead.
 */
export function overlayMarkerPosition(marker: unknown): LatLng {
  const m = marker as {
    lat?: number; lon?: number; lng?: number;
    latitude?: number; longitude?: number;
    location?: { latitude?: number; longitude?: number } | null;
    center?: readonly [number, number];
    centroid?: readonly [number, number];
  };
  return {
    lat: m.lat ?? m.latitude ?? m.location?.latitude ?? m.center?.[1] ?? m.centroid?.[1] ?? Number.NaN,
    lng: m.lon ?? m.lng ?? m.longitude ?? m.location?.longitude ?? m.center?.[0] ?? m.centroid?.[0] ?? Number.NaN,
  };
}

/**
 * The projection coordinate currently sitting at the screen centre (#7112).
 *
 * `applyTransform` writes `translate(tx,ty) scale(zoom)` with
 * `tx = (width/2)(1-zoom) + pan.x*zoom` onto the wrapper, so a wrapper-local
 * point `x` lands at screen `tx + zoom*x`. Solving `tx + zoom*x = width/2`
 * gives `x = width/2 - pan.x` — the zoom cancels. `setCenter` derives the same
 * identity from the other direction ("pan = width/2 - pos, independent of
 * zoom") and is the round-trip inverse of this function.
 *
 * Dividing by zoom here (as this and `getCenter` both once did) puts the point
 * a full viewport off-screen at zoom 4, which for the marker budget means
 * ranking every proximity-ordered layer against a location the user is not
 * looking at.
 */
export function projectionPointAtScreenCentre(
  width: number,
  height: number,
  pan: { x: number; y: number },
): [number, number] {
  return [width / 2 - pan.x, height / 2 - pan.y];
}
