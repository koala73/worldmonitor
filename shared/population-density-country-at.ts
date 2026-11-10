/**
 * Finds which density-table country contains a point, for exposure callers
 * that hold only a lat/lon (the REST RPC, MCP point mode, earthquake and fire
 * feeds). The outlines come from the pinned 10m World Atlas via
 * `scripts/generate-population-density-boundaries.mjs`.
 *
 * Kept apart from the core model so the dashboard ships only the small PS
 * outline needed to correct the provider's Israel labels.
 */

import BOUNDARIES from './population-density-boundaries.json';
import { inRing, type Ring } from './population-density-geometry';
import {
  estimateExposure,
  type ExposureEstimate,
} from './analysis-population-exposure';

interface CountryOutline {
  code: string;
  bbox: [west: number, south: number, east: number, north: number];
  polygons: Ring[][];
}

const OUTLINES: CountryOutline[] = Object.entries(BOUNDARIES.countries as Record<string, Ring[][]>)
  .map(([code, polygons]) => {
    const bbox: CountryOutline['bbox'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygons) {
      for (const [lon, lat] of polygon[0] ?? []) {
        bbox[0] = Math.min(bbox[0], lon!);
        bbox[1] = Math.min(bbox[1], lat!);
        bbox[2] = Math.max(bbox[2], lon!);
        bbox[3] = Math.max(bbox[3], lat!);
      }
    }
    return { code, bbox, polygons };
  });

const COASTAL_SNAP_KM = 5;
const KM_PER_DEGREE = 6371 * Math.PI / 180;

// Local tangent-plane distance is sufficient for a maximum five-km snap.
// Wrap around the query longitude so Russia's dateline coast stays local.
function ringDistanceKm(lat: number, lon: number, ring: Ring): number {
  const scaleX = KM_PER_DEGREE * Math.cos(lat * Math.PI / 180);
  const project = ([x, y]: number[]): [number, number] => [
    (((x! - lon + 540) % 360) - 180) * scaleX,
    (y! - lat) * KM_PER_DEGREE,
  ];
  let nearest = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = project(ring[i - 1]!);
    const [bx, by] = project(ring[i]!);
    // Independently wrapped endpoints can straddle the far side of Earth.
    // Such a segment cannot be within the local five-km search window.
    if (Math.abs(bx - ax) > 180 * scaleX) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
    nearest = Math.min(nearest, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return nearest;
}

/** ISO2 country containing the point, or the closest outline within 5 km. */
export function densityCountryAt(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  for (const { code, bbox: [west, south, east, north], polygons } of OUTLINES) {
    if (lon < west || lon > east || lat < south || lat > north) continue;
    for (const [outer, ...holes] of polygons) {
      if (outer && inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole))) return code;
    }
  }
  let nearestCountry: string | null = null;
  let nearestKm = COASTAL_SNAP_KM;
  const latitudeMargin = COASTAL_SNAP_KM / KM_PER_DEGREE;
  const longitudeMargin = latitudeMargin / Math.max(0.000001, Math.cos(lat * Math.PI / 180));
  for (const { code, bbox: [west, south, east, north], polygons } of OUTLINES) {
    if (lat < south - latitudeMargin || lat > north + latitudeMargin
      || lon < west - longitudeMargin || lon > east + longitudeMargin) continue;
    // Snapping across a land border would reintroduce neighbour-density
    // errors. Refuse this fallback within 5 km of any such border.
    const borders = (BOUNDARIES.landBorders as Record<string, Ring[]>)[code] ?? [];
    if (borders.some((line) => ringDistanceKm(lat, lon, line) <= COASTAL_SNAP_KM)) continue;
    for (const [outer, ...holes] of polygons) {
      if (!outer || holes.some((hole) => inRing(lon, lat, hole))) continue;
      const distance = ringDistanceKm(lat, lon, outer);
      if (distance <= nearestKm) {
        nearestKm = distance;
        nearestCountry = code;
      }
    }
  }
  return nearestCountry;
}

/**
 * Uses the reported country when the caller has one, and otherwise the
 * country under the point. Israel-labelled events inside the PS outline use
 * Palestine's density. Null outside the density table.
 */
export function estimatePointExposure(
  lat: number,
  lon: number,
  radiusKm: number,
  reportedCountry?: string,
): ExposureEstimate | null {
  const country = reportedCountry || densityCountryAt(lat, lon);
  return country ? estimateExposure(lat, lon, country, radiusKm) : null;
}
