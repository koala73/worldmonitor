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

/** Optional higher-resolution boundary overrides sourced from Natural Earth. */
const COUNTRY_OVERRIDES_URL = '/data/country-boundary-overrides.geojson';

const POLITICAL_OVERRIDES: Record<string, string> = { 'CN-TW': 'TW' };

const NAME_ALIASES: Record<string, string> = {
  'dr congo': 'CD', 'democratic republic of the congo': 'CD',
  'czech republic': 'CZ', 'ivory coast': 'CI', "cote d'ivoire": 'CI',
  'uae': 'AE', 'uk': 'GB', 'usa': 'US',
  'south korea': 'KR', 'north korea': 'KP',
  'republic of the congo': 'CG', 'east timor': 'TL',
  'cape verde': 'CV', 'swaziland': 'SZ', 'burma': 'MM',
};

let loadPromise: Promise<void> | null = null;
let loadedGeoJson: FeatureCollection<Geometry> | null = null;
const countryIndex = new Map<string, IndexedCountryGeometry>();
let countryList: IndexedCountryGeometry[] = [];
const iso3ToIso2 = new Map<string, string>();
const nameToIso2 = new Map<string, string>();
const codeToName = new Map<string, string>();
let sortedCountryNames: Array<{ name: string; code: string; regex: RegExp }> = [];

function normalizeCode(properties: GeoJsonProperties | null | undefined): string | null {
  if (!properties) return null;
  const rawCode = properties['ISO3166-1-Alpha-2'] ?? properties.ISO_A2 ?? properties.iso_a2;
  if (typeof rawCode !== 'string') return null;
  const trimmed = rawCode.trim().toUpperCase();
  const overridden = POLITICAL_OVERRIDES[trimmed] ?? trimmed;
  return /^[A-Z]{2}$/.test(overridden) ? overridden : null;
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCountryNameMatchers(): void {
  sortedCountryNames = [...nameToIso2.entries()]
    .filter(([name]) => name.length >= 4)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([name, code]) => ({
      name,
      code,
      regex: new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),
    }));
}

async function ensureLoaded(): Promise<void> {
  if (loadedGeoJson || loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
    if (typeof fetch !== 'function') return;

    try {
      const [response, overrideResp] = await Promise.all([
        fetch(COUNTRY_GEOJSON_URL),
        fetch(COUNTRY_OVERRIDES_URL).catch(() => null),
      ]);
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
      iso3ToIso2.clear();
      nameToIso2.clear();
      codeToName.clear();

      for (const feature of data.features) {
        const code = normalizeCode(feature.properties);
        const name = normalizeName(feature.properties);
        if (!code || !name) continue;

        const iso3 = feature.properties?.['ISO3166-1-Alpha-3'];
        if (typeof iso3 === 'string' && /^[A-Z]{3}$/i.test(iso3.trim())) {
          iso3ToIso2.set(iso3.trim().toUpperCase(), code);
        }
        nameToIso2.set(name.toLowerCase(), code);
        if (!codeToName.has(code)) codeToName.set(code, name);

        const polygons = normalizeGeometry(feature.geometry);
        const bbox = computeBbox(polygons);
        if (!bbox || polygons.length === 0) continue;

        const indexed: IndexedCountryGeometry = { code, name, polygons, bbox };
        countryIndex.set(code, indexed);
        countryList.push(indexed);
      }

      for (const [alias, code] of Object.entries(NAME_ALIASES)) {
        if (!nameToIso2.has(alias)) {
          nameToIso2.set(alias, code);
        }
      }

      // Apply optional higher-resolution boundary overrides (sourced from Natural Earth)
      try {
        if (overrideResp?.ok) {
          const overrideData = (await overrideResp.json()) as FeatureCollection<Geometry>;
          if (overrideData?.type === 'FeatureCollection' && Array.isArray(overrideData.features)) {
            for (const overrideFeature of overrideData.features) {
              const code = normalizeCode(overrideFeature.properties);
              if (!code || !overrideFeature.geometry) continue;
              const mainFeature = data.features.find((f) => normalizeCode(f.properties) === code);
              if (!mainFeature) continue;
              mainFeature.geometry = overrideFeature.geometry;
              const polygons = normalizeGeometry(overrideFeature.geometry);
              const bbox = computeBbox(polygons);
              if (bbox && polygons.length > 0) {
                const existing = countryIndex.get(code);
                if (existing) {
                  existing.polygons = polygons;
                  existing.bbox = bbox;
                }
              }
            }
          }
        }
      } catch {
        // Overrides are optional; ignore fetch/parse errors
      }

      buildCountryNameMatchers();
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
  return countryIndex.has(code.toUpperCase());
}

export function getCountryAtCoordinates(lat: number, lon: number, candidateCodes?: string[]): CountryHit | null {
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
  if (!loadedGeoJson) return null;
  const country = countryIndex.get(code.toUpperCase());
  if (!country) return null;
  return pointInCountryGeometry(country, lon, lat);
}

export function getCountryNameByCode(code: string): string | null {
  const upper = code.toUpperCase();
  const entry = countryIndex.get(upper);
  if (entry) return entry.name;
  return codeToName.get(upper) ?? null;
}

export function iso3ToIso2Code(iso3: string): string | null {
  return iso3ToIso2.get(iso3.trim().toUpperCase()) ?? null;
}

export function nameToCountryCode(text: string): string | null {
  const normalized = text.toLowerCase().trim();
  return nameToIso2.get(normalized) ?? null;
}

export function matchCountryNamesInText(text: string): string[] {
  const matched: string[] = [];
  let remaining = text.toLowerCase();
  for (const { code, regex } of sortedCountryNames) {
    if (regex.test(remaining)) {
      matched.push(code);
      remaining = remaining.replace(regex, '');
    }
  }
  return matched;
}

export function getAllCountryCodes(): string[] {
  return [...countryIndex.keys()];
}

export function getCountryBbox(code: string): [number, number, number, number] | null {
  const entry = countryIndex.get(code.toUpperCase());
  return entry?.bbox ?? null;
}

export function getCountryCentroid(
  code: string,
  fallbackBounds?: Record<string, { n: number; s: number; e: number; w: number }>,
): { lat: number; lon: number } | null {
  const bbox = getCountryBbox(code);
  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  }
  const fb = fallbackBounds?.[code];
  if (fb) {
    return { lat: (fb.n + fb.s) / 2, lon: (fb.e + fb.w) / 2 };
  }
  return null;
}

export const ME_STRIKE_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
  BH: { n: 26.3, s: 25.8, e: 50.8, w: 50.3 }, QA: { n: 26.2, s: 24.5, e: 51.7, w: 50.7 },
  LB: { n: 34.7, s: 33.1, e: 36.6, w: 35.1 }, KW: { n: 30.1, s: 28.5, e: 48.5, w: 46.5 },
  IL: { n: 33.3, s: 29.5, e: 35.9, w: 34.3 }, AE: { n: 26.1, s: 22.6, e: 56.4, w: 51.6 },
  JO: { n: 33.4, s: 29.2, e: 39.3, w: 34.9 }, SY: { n: 37.3, s: 32.3, e: 42.4, w: 35.7 },
  OM: { n: 26.4, s: 16.6, e: 59.8, w: 52.0 }, IQ: { n: 37.4, s: 29.1, e: 48.6, w: 38.8 },
  YE: { n: 19, s: 12, e: 54.5, w: 42 }, IR: { n: 40, s: 25, e: 63, w: 44 },
  SA: { n: 32, s: 16, e: 55, w: 35 },
};

export function resolveCountryFromBounds(
  lat: number, lon: number,
  bounds: Record<string, { n: number; s: number; e: number; w: number }>,
): string | null {
  const matches: Array<{ code: string; area: number }> = [];
  for (const [code, b] of Object.entries(bounds)) {
    if (lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e) {
      matches.push({ code, area: (b.n - b.s) * (b.e - b.w) });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.code;

  let anyGeometryAvailable = false;
  for (const m of matches) {
    const precise = isCoordinateInCountry(lat, lon, m.code);
    if (precise === true) return m.code;
    if (precise === false) anyGeometryAvailable = true;
  }

  if (!anyGeometryAvailable) return null;

  matches.sort((a, b) => a.area - b.area);
  return matches[0]!.code;
}
