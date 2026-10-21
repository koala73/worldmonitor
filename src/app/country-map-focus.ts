import { getCountryBbox, getCountryPolygons } from '@/services/country-geometry';

export interface CountryMapFocus {
  iso2: string;
  lat: number;
  lon: number;
  zoom: number;
  bbox: [number, number, number, number];
}

function normalizeLongitude(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Tightest longitude interval from a set of normalized longitudes.
 * The largest circular gap is treated as the ocean; the complement is land.
 * Returns west in (-180, 180] and an unwrapped east = west + span.
 */
function wrappingLongitudeExtent(
  sortedUnique: number[],
): { west: number; span: number } | null {
  if (sortedUnique.length === 0) return null;
  const first = sortedUnique[0];
  if (sortedUnique.length === 1) {
    return first === undefined ? null : { west: first, span: 0 };
  }

  let maxGap = -1;
  let indexAfterGap = 0;
  for (let i = 0; i < sortedUnique.length; i++) {
    const current = sortedUnique[i];
    const next = i === sortedUnique.length - 1
      ? (sortedUnique[0] ?? 0) + 360
      : sortedUnique[i + 1];
    if (current === undefined || next === undefined) continue;
    const gap = next - current;
    if (gap > maxGap) {
      maxGap = gap;
      indexAfterGap = i === sortedUnique.length - 1 ? 0 : i + 1;
    }
  }
  const west = sortedUnique[indexAfterGap];
  if (west === undefined || maxGap < 0) return null;
  return { west, span: 360 - maxGap };
}

/**
 * Antimeridian-aware bbox: [west, minLat, west+span, maxLat].
 * east may be greater than 180 so span stays a real width, not 360°.
 */
export function wrappingBboxFromPolygons(
  polygons: [number, number][][][],
): [number, number, number, number] | null {
  const lons: number[] = [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const point of ring) {
        const lon = point[0];
        const lat = point[1];
        if (lon === undefined || lat === undefined) continue;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        lons.push(normalizeLongitude(lon));
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (lons.length === 0 || !Number.isFinite(minLat)) return null;
  const unique = [...new Set(lons)].sort((left, right) => left - right);
  const extent = wrappingLongitudeExtent(unique);
  if (!extent) return null;
  return [extent.west, minLat, extent.west + extent.span, maxLat];
}

/**
 * The dashboard "country-map" command focuses a country by its GeoJSON bbox,
 * not by opening a brief. Keep the zoom buckets here so WebMCP and search
 * cannot drift. Longitudes may be unwrapped (east > 180) for wrap-around
 * countries such as Russia and Fiji.
 */
export function focusFromCountryBbox(
  bbox: [number, number, number, number],
): { lat: number; lon: number; zoom: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lat = (minLat + maxLat) / 2;
  const lon = normalizeLongitude((minLon + maxLon) / 2);
  const span = Math.max(maxLat - minLat, maxLon - minLon);
  const zoom = span > 40 ? 3 : span > 15 ? 4 : span > 5 ? 5 : 6;
  return { lat, lon, zoom };
}

export function getCountryMapFocus(code: string): CountryMapFocus | null {
  const iso2 = code.toUpperCase();
  const polygons = getCountryPolygons(iso2);
  const bbox = (polygons && wrappingBboxFromPolygons(polygons)) || getCountryBbox(iso2);
  if (!bbox) return null;
  return { iso2, bbox, ...focusFromCountryBbox(bbox) };
}
