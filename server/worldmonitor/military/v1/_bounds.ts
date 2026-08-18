import type { ListMilitaryFlightsRequest } from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

/**
 * #6249: MapLibre's `getBounds()` returns longitudes outside [-180, 180]
 * once the user pans across world copies, and API callers can send
 * `sw_lon=-190` directly. The live seed's coverage predicate requires
 * `region.west <= bounds.west`, so an unwrapped west below -180 fails
 * coverage, falls back to per-viewer relay recovery, and the relay rejects
 * the out-of-range bbox with an empty result — while the global snapshot
 * that would have answered sits right there.
 *
 * Pure module (no Redis/network imports) so the normalization is unit
 * testable in isolation from the handler's side effects.
 */
export interface RequestBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

function wrapLongitude(lon: number): number {
  // Already-canonical values must pass through unchanged. The `%` wrap
  // introduces float noise (177.34 -> 177.34000000000003) and maps +180
  // onto -180, which then looks like an antimeridian inversion.
  if (lon > -180 && lon <= 180) return lon;
  const wrapped = (((lon + 180) % 360) + 360) % 360 - 180;
  if (wrapped === -180 && lon > 0) return 180;
  return wrapped;
}

/** False for NaN/±Infinity in any corner coordinate — the caller must answer empty. */
export function hasFiniteRequestBounds(req: ListMilitaryFlightsRequest): boolean {
  return [req.swLat, req.swLon, req.neLat, req.neLon].every(Number.isFinite);
}

/**
 * Normalize a request bbox: swap inverted corners, wrap longitudes into
 * [-180, 180], and widen a world-spanning or antimeridian-crossing box to
 * the full longitude range instead of emitting an inverted west/east pair
 * the downstream coverage predicate and bbox filter can never satisfy.
 */
export function normalizeBounds(req: ListMilitaryFlightsRequest): RequestBounds {
  const west = wrapLongitude(Math.min(req.swLon, req.neLon));
  const east = wrapLongitude(Math.max(req.swLon, req.neLon));
  const spannedGlobe = req.neLon - req.swLon >= 360 || west > east;
  return {
    south: Math.min(req.swLat, req.neLat),
    north: Math.max(req.swLat, req.neLat),
    west: spannedGlobe ? -180 : west,
    east: spannedGlobe ? 180 : east,
  };
}
