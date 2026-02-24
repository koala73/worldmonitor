import type { FeatureCollection, Geometry, GeoJsonProperties, Position } from 'geojson';

interface IndexedCountryGeometry {
  code: string;
  name: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  polygons: [number, number][][][]; // polygon -> ring -> [lon, lat]
}

interface CountryHit {
  code: string;
  name: string;
}

const COUNTRY_GEOJSON_URL = '/data/countries.geojson';

let loadPromise: Promise<void> | null = null;
let loadedGeoJson: FeatureCollection<Geometry> | null = null;
const countryIndex = new Map<string, IndexedCountryGeometry>();
let countryList: IndexedCountryGeometry[] = [];

function normalizeCode(properties: GeoJsonProperties | null | undefined): string | null {
  if (!properties) return null;
  const rawCode = properties['ISO3166-1-Alpha-2'] ?? properties.ISO_A2 ?? properties.iso_a2;
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function normalizeName(properties: GeoJsonProperties | null | undefined): string | null {
  if (!properties) return null;
  const rawName = properties.name ?? properties.NAME ?? properties.admin;
  if (typeof rawName !== 'string') return null;
  const name = rawName.trim();
  return name.length > 0 ? name : null;
}

function toCoord(point: Position): [number, number] | null {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lon = Number(point[0]);
  const lat = Number(point[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function normalizePolygonRings(rings: Position[][]): [number, number][][] {
  return rings
    .map((ring) => ring.map(toCoord).filter((p): p is [number, number] => p !== null))
    .filter((ring) => ring.length >= 3);
}

function normalizeGeometry(geometry: Geometry | null | undefined): [number, number][][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    const polygon = normalizePolygonRings(geometry.coordinates);
    return polygon.length > 0 ? [polygon] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((polygonCoords) => normalizePolygonRings(polygonCoords))
      .filter((polygon) => polygon.length > 0);
  }
  return [];
}

function computeBbox(polygons: [number, number][][][]): [number, number, number, number] | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let hasPoint = false;

  polygons.forEach((polygon) => {
    polygon.forEach((ring) => {
      ring.forEach(([lon, lat]) => {
        hasPoint = true;
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      });
    });
  });

  return hasPoint ? [minLon, minLat, maxLon, maxLat] : null;
}

function pointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  const cross = (py - y1) * (x2 - x1) - (px - x1) * (y2 - y1);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (px - x1) * (px - x2) + (py - y1) * (py - y2);
  return dot <= 0;
}

function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i];
    const previous = ring[j];
    if (!current || !previous) continue;
    const [xi, yi] = current;
    const [xj, yj] = previous;
    if (pointOnSegment(lon, lat, xi, yi, xj, yj)) return true;
    const intersects = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInCountryGeometry(country: IndexedCountryGeometry, lon: number, lat: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = country.bbox;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;

  for (const polygon of country.polygons) {
    const outer = polygon[0];
    if (!outer || !pointInRing(lon, lat, outer)) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i++) {
      const hole = polygon[i];
      if (hole && pointInRing(lon, lat, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

async function ensureLoaded(): Promise<void> {
  if (loadedGeoJson || loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
    if (typeof fetch !== 'function') return;

    try {
      const response = await fetch(COUNTRY_GEOJSON_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as FeatureCollection<Geometry>;
      if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        return;
      }

      loadedGeoJson = data;
      countryIndex.clear();
      countryList = [];

      for (const feature of data.features) {
        const code = normalizeCode(feature.properties);
        const name = normalizeName(feature.properties);
        if (!code || !name) continue;

        const polygons = normalizeGeometry(feature.geometry);
        const bbox = computeBbox(polygons);
        if (!bbox || polygons.length === 0) continue;

        const indexed: IndexedCountryGeometry = { code, name, polygons, bbox };
        countryIndex.set(code, indexed);
        countryList.push(indexed);
      }
    } catch (err) {
      console.warn('[country-geometry] Failed to load countries.geojson:', err);
    }
  })();

  await loadPromise;
}

export async function preloadCountryGeometry(): Promise<void> {
  await ensureLoaded();
}

export async function getCountriesGeoJson(): Promise<FeatureCollection<Geometry> | null> {
  await ensureLoaded();
  return loadedGeoJson;
}

export function hasCountryGeometry(code: string): boolean {
  // Synchronous API: caller should preload via preloadCountryGeometry().
  return countryIndex.has(code.toUpperCase());
}

export function getCountryAtCoordinates(lat: number, lon: number, candidateCodes?: string[]): CountryHit | null {
  // Synchronous API: return null until geometry is preloaded.
  if (!loadedGeoJson) return null;
  const candidates = Array.isArray(candidateCodes) && candidateCodes.length > 0
    ? candidateCodes
      .map((code) => countryIndex.get(code.toUpperCase()))
      .filter((country): country is IndexedCountryGeometry => Boolean(country))
    : countryList;

  for (const country of candidates) {
    if (pointInCountryGeometry(country, lon, lat)) {
      return { code: country.code, name: country.name };
    }
  }
  return null;
}

export function isCoordinateInCountry(lat: number, lon: number, code: string): boolean | null {
  // Synchronous API: return null until geometry is preloaded.
  if (!loadedGeoJson) return null;
  const country = countryIndex.get(code.toUpperCase());
  if (!country) return null;
  return pointInCountryGeometry(country, lon, lat);
}
