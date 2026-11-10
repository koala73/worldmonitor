/**
 * Finds which density-table country contains a point, for exposure callers
 * that hold only a lat/lon (the REST RPC, MCP point mode, earthquake and fire
 * feeds). The outlines come from `public/data/countries-50m.json` via
 * `scripts/generate-population-density-boundaries.mjs`.
 *
 * Kept apart from `analysis-population-exposure.ts` so the dashboard, which
 * always has the event's reported country, does not ship the geometry.
 */

import BOUNDARIES from './population-density-boundaries.json';
import {
  estimateExposure,
  type ExposureEstimate,
} from './analysis-population-exposure';

type Ring = number[][];

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

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi! > lat) !== (yj! > lat) && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) {
      inside = !inside;
    }
  }
  return inside;
}

/** ISO2 code of the density-table country containing the point, or null. */
export function densityCountryAt(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const { code, bbox: [west, south, east, north], polygons } of OUTLINES) {
    if (lon < west || lon > east || lat < south || lat > north) continue;
    for (const [outer, ...holes] of polygons) {
      if (outer && inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole))) return code;
    }
  }
  return null;
}

/**
 * Uses the reported country when the caller has one, and otherwise the
 * country under the point. Null outside the density table.
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
