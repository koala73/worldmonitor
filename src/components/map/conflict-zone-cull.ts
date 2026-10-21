/**
 * Viewport-culling + cache-key helpers for the conflict-zone GeoJson layer
 * (#4561, follow-up to #4558; part of #4537 / #4487).
 *
 * Pure and dependency-free (geojson types only) so it is unit-testable under
 * `tsx --test` without a DOM/WebGL context. `DeckGLMap.buildConflictZoneGeoJson`
 * uses these to bound the deck.gl tessellation to the zones intersecting the
 * current map viewport instead of tessellating every zone's polygon (the
 * dominant warm-INP presentation-delay cost — field data 2026-06-30/07-01).
 *
 * The cull is deliberately conservative so it never hides a zone that should be
 * visible (R5): it tests each zone's axis-aligned bounding box (never the
 * polygon itself → over-inclusion, never under-inclusion), pads the viewport,
 * and never culls at world/low zoom or across the antimeridian.
 */
import type { Feature, Geometry, Position } from 'geojson';

/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

/** A conflict-zone feature paired with its precomputed geographic bounds. */
export interface BoundedFeature {
  bounds: BBox;
  feature: Feature;
}

/** Fraction of the viewport span added as padding on each side before culling. */
export const CULL_PAD_FRACTION = 0.5;
/** Longitude span (deg) at/above which the viewport is treated as "world" (no cull). */
export const WORLD_LON_SPAN = 300;

function walkPositions(coords: unknown, visit: (lon: number, lat: number) => void): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    visit(coords[0], coords[1]);
    return;
  }
  for (const child of coords) walkPositions(child, visit);
}

/**
 * Axis-aligned bounds of a Polygon / MultiPolygon / GeometryCollection, or null
 * when the geometry carries no coordinates. Walks nested coordinate arrays so it
 * works for both a zone's own polygon and a substituted country multipolygon.
 */
export function geometryBounds(geometry: Geometry | null | undefined): BBox | null {
  if (!geometry) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (lon: number, lat: number): void => {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) {
      const b = geometryBounds(child);
      if (b) {
        visit(b[0], b[1]);
        visit(b[2], b[3]);
      }
    }
  } else if ('coordinates' in geometry) {
    walkPositions(geometry.coordinates, visit);
  }
  return Number.isFinite(west) && Number.isFinite(south) && Number.isFinite(east) && Number.isFinite(north)
    ? [west, south, east, north]
    : null;
}

/** Standard AABB overlap. Assumes both boxes are non-antimeridian-crossing (west <= east). */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * True when the viewport must NOT be culled: it crosses the antimeridian
 * (east <= west), is degenerate/non-finite, or spans (near) the whole globe.
 * Culling in those cases could hide a visible zone, so the caller renders all.
 */
export function isWorldViewport(viewport: BBox, worldLonSpan = WORLD_LON_SPAN): boolean {
  const [west, south, east, north] = viewport;
  if (![west, south, east, north].every((v) => Number.isFinite(v))) return true;
  if (east <= west) return true; // antimeridian crossing / degenerate → don't cull
  return east - west >= worldLonSpan;
}

/** Expand a bbox by a fraction of its span on each side. */
export function padViewport(viewport: BBox, fraction = CULL_PAD_FRACTION): BBox {
  const [west, south, east, north] = viewport;
  const dLon = (east - west) * fraction;
  const dLat = (north - south) * fraction;
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

/**
 * Indices (into `features`, order preserved) whose bounds intersect the padded
 * viewport. At world/low zoom (or across the antimeridian) returns every index
 * so we never under-cull. Index identity (not zone id) is what callers key their
 * tessellation cache on: a multi-country zone emits one feature per country, all
 * sharing the zone id, so an id-based key could collide two distinct feature sets.
 */
export function culledIndices(
  features: readonly BoundedFeature[],
  viewport: BBox,
  padFraction = CULL_PAD_FRACTION,
): number[] {
  if (isWorldViewport(viewport)) return features.map((_, i) => i);
  const padded = padViewport(viewport, padFraction);
  const out: number[] = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (f && bboxIntersects(f.bounds, padded)) out.push(i);
  }
  return out;
}

/** The features whose bounds intersect the padded viewport, order preserved. */
export function cullToViewport(
  features: readonly BoundedFeature[],
  viewport: BBox,
  padFraction = CULL_PAD_FRACTION,
): Feature[] {
  const out: Feature[] = [];
  for (const i of culledIndices(features, viewport, padFraction)) {
    const f = features[i];
    if (f) out.push(f.feature);
  }
  return out;
}

// ── U2: low-zoom geometry simplification backstop ──────────────────────────────
// At world/low zoom the cull can't reduce the zone count (everything is visible),
// so the vertex-heavy country multipolygons still dominate tessellation. Below a
// zoom threshold we RDP-simplify the polygon rings — sub-pixel detail there is
// invisible — bounding the vertex count while keeping every zone present (KTD3).

/** Zoom at/above which no simplification runs (zoomed in → detail matters, cull already helps). */
export const SIMPLIFY_ZOOM_THRESHOLD = 4;
/** Max RDP tolerance (deg) applied at the lowest zoom. ~1 world-view pixel at typical widths. */
export const SIMPLIFY_MAX_TOLERANCE_DEG = 0.5;

// Coordinate accessors: a GeoJSON Position always carries [lon, lat]; the `?? 0`
// only guards the (never-valid) missing-index case that noUncheckedIndexedAccess
// forces us to consider — it never fires for real data.
const lon = (p: Position): number => p[0] ?? 0;
const lat = (p: Position): number => p[1] ?? 0;
const samePoint = (a: Position, b: Position): boolean => lon(a) === lon(b) && lat(a) === lat(b);

/** Perpendicular distance from point p to the infinite line through a-b. */
function perpendicularDistance(p: Position, a: Position, b: Position): number {
  const dx = lon(b) - lon(a);
  const dy = lat(b) - lat(a);
  const denom = Math.hypot(dx, dy);
  if (denom === 0) return Math.hypot(lon(p) - lon(a), lat(p) - lat(a));
  return Math.abs(dy * lon(p) - dx * lat(p) + lon(b) * lat(a) - lat(b) * lon(a)) / denom;
}

/** Ramer-Douglas-Peucker on an open polyline: keeps both endpoints, drops points within tolerance. */
function rdp(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points.slice();
  if (!points[0] || !points[points.length - 1]) return points.slice();

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const segment = stack.pop();
    if (!segment) break;
    const [startIndex, endIndex] = segment;
    if (endIndex - startIndex <= 1) continue;

    const first = points[startIndex];
    const last = points[endIndex];
    if (!first || !last) continue;

    let index = 0;
    let maxDist = 0;
    for (let i = startIndex + 1; i < endIndex; i++) {
      const pt = points[i];
      if (!pt) continue;
      const d = perpendicularDistance(pt, first, last);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }

    if (maxDist > tolerance) {
      keep[index] = true;
      stack.push([startIndex, index], [index, endIndex]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a single closed ring with RDP, preserving closure and polygon
 * validity. The ring is split at its farthest vertex so RDP runs on two open
 * polylines (a closed ring's p0==pn baseline is degenerate). Output points are a
 * strict subset of the input (RDP never moves or adds a vertex), so no new
 * geometry is introduced. Falls back to the original ring if simplification
 * would drop below a valid polygon (< 4 points incl. closure) or not reduce it.
 */
export function simplifyRing(ring: Position[], tolerance: number): Position[] {
  if (tolerance <= 0 || ring.length <= 5) return ring;
  const start = ring[0];
  const finish = ring[ring.length - 1];
  if (!start || !finish) return ring;

  const open = samePoint(start, finish) ? ring.slice(0, -1) : ring.slice();
  const anchor = open[0];
  if (open.length <= 4 || !anchor) return ring;

  let far = 0;
  let farDist = -1;
  for (let i = 1; i < open.length; i++) {
    const pt = open[i];
    if (!pt) continue;
    const d = Math.hypot(lon(pt) - lon(anchor), lat(pt) - lat(anchor));
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }

  const first = rdp(open.slice(0, far + 1), tolerance);
  const second = rdp([...open.slice(far), anchor], tolerance);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  const head = merged[0];
  if (merged.length < 4 || !head) return ring;

  const result = [...merged, head];
  return result.length < ring.length ? result : ring;
}

/** Apply {@link simplifyRing} to every ring of a Polygon/MultiPolygon; other geometry is returned as-is. */
export function simplifyGeometry(geometry: Geometry, tolerance: number): Geometry {
  if (tolerance <= 0) return geometry;
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => simplifyRing(r, tolerance)) };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((poly) => poly.map((r) => simplifyRing(r, tolerance))),
    };
  }
  if (geometry.type === 'GeometryCollection') {
    return {
      type: 'GeometryCollection',
      geometries: geometry.geometries.map((g) => simplifyGeometry(g, tolerance)),
    };
  }
  return geometry;
}

/**
 * Monotonic zoom → RDP tolerance (deg). Zero at/above the threshold (no
 * simplification when zoomed in); ramps linearly to {@link SIMPLIFY_MAX_TOLERANCE_DEG}
 * as zoom drops toward 0, so lower zoom = coarser simplification.
 */
export function zoomToSimplifyTolerance(
  zoom: number,
  threshold = SIMPLIFY_ZOOM_THRESHOLD,
  maxTolerance = SIMPLIFY_MAX_TOLERANCE_DEG,
): number {
  if (!Number.isFinite(zoom) || zoom >= threshold) return 0;
  const fraction = (threshold - Math.max(0, zoom)) / threshold;
  return maxTolerance * fraction;
}
