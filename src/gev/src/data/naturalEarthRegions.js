/**
 * Natural Earth physical-regions lookup — offline polygons for named natural
 * regions (mountain ranges, deserts, plateaus, peninsulas, islands) and marine
 * areas (seas, gulfs, straits, bays), so voice asks like "outline the Alps"
 * resolve to REAL region geometry instead of failing or matching a tiny meadow.
 *
 * Data: `local_data/natural_earth/{regions,marine}.json` — curated from the
 * Natural Earth 10m physical vectors (public domain; see each file's `meta`
 * header and DATA_SOURCES.md). Curation kept named features only, outer rings
 * only, Douglas-Peucker simplified (~0.01°) with coords rounded to 3 decimals.
 *
 * PURE data module — no Cesium imports, node-testable. The packs are lazy-
 * loaded on first lookup and cached in module scope (bbox/area computed once
 * at load). In the browser Vite bundles the JSON via dynamic import; under
 * node the same files are read from disk. A failed load is retried on the
 * next lookup rather than cached (see `createRetryableLoader`).
 */

import { createRetryableLoader } from './retryableLoad.js';

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Spherical-excess ring area (km²) — same family as turf/geojson-area. */
function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    sum += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

function haversineKm(lon1, lat1, lon2, lat2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Normalize a query/name for matching: lowercase, strip diacritics and
 * punctuation, collapse whitespace, strip a leading "the ".
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/**
 * Common spoken aliases → the pack's canonical (normalized) names.
 * Keys and values are both in normalizeName() form.
 */
const ALIASES = {
  'rockies': 'rocky mountains',
  'himalaya': 'himalayas',
  'the himalaya': 'himalayas',
  'alps mountains': 'alps',
  'sahara desert': 'sahara',
  'gobi': 'gobi desert',
  'kalahari': 'kalahari desert',
  'atacama': 'desierto de atacama',
  'atacama desert': 'desierto de atacama',
  'tibetan plateau': 'plateau of tibet',
  'tibet plateau': 'plateau of tibet',
  'appalachians': 'appalachian mts',
  'appalachian mountains': 'appalachian mts',
  'caucasus': 'caucasus mts',
  'caucasus mountains': 'caucasus mts',
  'balkans': 'balkan pen',
  'balkan peninsula': 'balkan pen',
  'andes mountains': 'andes',
  'urals': 'ural mountains',
  'pyrenees mountains': 'pyrenees',
  'arabian gulf': 'persian gulf',
  'gulf of arabia': 'persian gulf',
  'mediterranean': 'mediterranean sea',
  'caribbean': 'caribbean sea',
  'baja': 'baja california',
  'yucatan': 'pen de yucatan',
  'yucatan peninsula': 'pen de yucatan',
  'kamchatka': 'kamchatka peninsula',
  'sierra nevada mountains': 'sierra nevada',
};

/** Generic suffix rewrites tried when there is no exact/alias hit. */
function suffixVariants(norm) {
  const v = [];
  // "x mountains" ↔ "x mts" (pack uses "Mts."; normalization strips the dot)
  if (norm.endsWith(' mountains')) v.push(norm.replace(/ mountains$/, ' mts'), norm.replace(/ mountains$/, ''));
  if (norm.endsWith(' mts')) v.push(norm.replace(/ mts$/, ' mountains'), norm.replace(/ mts$/, ''));
  // "x desert" ↔ "x"
  if (norm.endsWith(' desert')) v.push(norm.replace(/ desert$/, ''));
  else v.push(norm + ' desert');
  // "x peninsula" ↔ "x pen" (pack uses "Pen.")
  if (norm.endsWith(' peninsula')) v.push(norm.replace(/ peninsula$/, ' pen'));
  if (norm.endsWith(' pen')) v.push(norm.replace(/ pen$/, ' peninsula'));
  // "x range" → "x"
  if (norm.endsWith(' range')) v.push(norm.replace(/ range$/, ''));
  return v;
}

/** @type {Array|null} flat entry list for listRegions() */
let _entries = null;

const isNode = typeof process !== 'undefined' && !!process.versions?.node
  && typeof window === 'undefined';

async function loadPackFile(base) {
  if (isNode) {
    const { readFileSync } = await import(/* @vite-ignore */ 'node:fs');
    const url = new URL(`./local_data/natural_earth/${base}.json`, import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
  }
  // Vite bundles these JSON files as modules (same pattern as neighborhoodPolygons.js)
  const mod = base === 'regions'
    ? await import('./local_data/natural_earth/regions.json')
    : await import('./local_data/natural_earth/marine.json');
  return mod.default || mod;
}

function buildEntries(pack, kind) {
  const out = [];
  for (const ft of pack.features || []) {
    const polygons = ft.polygons || [];
    if (!polygons.length) continue;
    let areaKm2 = 0;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const ring of polygons) {
      areaKm2 += ringAreaKm2(ring);
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    out.push({
      name: ft.name,
      namealt: ft.namealt || null,
      featurecla: ft.featurecla || '',
      kind,
      polygons,
      areaKm2,
      bbox: [minLon, minLat, maxLon, maxLat],
      bboxDiagonalKm: haversineKm(minLon, minLat, maxLon, maxLat),
    });
  }
  return out;
}

/**
 * Load + index both packs, once. A failure is NOT memoized: callers
 * `.catch(() => null)` and would otherwise report a broken pack to the user
 * as "no such region" for the rest of the session.
 */
const loadIndex = createRetryableLoader(async () => {
  const [regions, marine] = await Promise.all([
    loadPackFile('regions'),
    loadPackFile('marine'),
  ]);
  _entries = [
    ...buildEntries(regions, 'natural'),
    ...buildEntries(marine, 'marine'),
  ];
  const index = new Map();
  for (const entry of _entries) {
    for (const key of new Set([normalizeName(entry.name), normalizeName(entry.namealt)])) {
      if (!key) continue;
      const list = index.get(key);
      if (list) list.push(entry); else index.set(key, [entry]);
    }
  }
  // duplicate names exist in Natural Earth (e.g. two "Cordillera Oriental",
  // a sliver + real "Canadian Shield") — prefer the largest-area match
  for (const list of index.values()) list.sort((a, b) => b.areaKm2 - a.areaKm2);
  return index;
});

function toResult(entry) {
  return {
    name: entry.name,
    featurecla: entry.featurecla,
    kind: entry.kind,
    polygons: entry.polygons,
    bboxDiagonalKm: entry.bboxDiagonalKm,
    areaKm2: entry.areaKm2,
  };
}

/**
 * Look up a named natural/marine region.
 * Case-insensitive; strips "the"; resolves common aliases ("Rockies" →
 * "Rocky Mountains", "Sahara Desert" → "Sahara") and generic suffix variants
 * ("X Mountains" ↔ "X Mts.", "X Peninsula" ↔ "X Pen.").
 *
 * @param {string} query e.g. "the Alps", "Rockies", "Gulf of Mexico"
 * @returns {Promise<{name:string, featurecla:string, kind:'natural'|'marine',
 *   polygons:Array<Array<[number,number]>>, bboxDiagonalKm:number,
 *   areaKm2:number}|null>} largest-area match, or null when nothing matches.
 */
export async function findNaturalRegion(query) {
  const norm = normalizeName(query);
  if (!norm) return null;
  const index = await loadIndex();
  const candidates = [norm, ALIASES[norm], ...suffixVariants(ALIASES[norm] || norm)];
  for (const key of candidates) {
    if (!key) continue;
    const list = index.get(key);
    if (list && list.length) return toResult(list[0]);
  }
  return null;
}

/**
 * Diagnostics: every region in the pack (no geometry).
 * @returns {Promise<Array<{name:string, featurecla:string, kind:string, areaKm2:number, bboxDiagonalKm:number}>>}
 */
export async function listRegions() {
  await loadIndex();
  return _entries.map((e) => ({
    name: e.name,
    featurecla: e.featurecla,
    kind: e.kind,
    areaKm2: e.areaKm2,
    bboxDiagonalKm: e.bboxDiagonalKm,
  }));
}

// exported for tests
export { normalizeName as _normalizeName };

/**
 * Ray-cast (even-odd) point-in-ring test. Ring = [[lon,lat], …], open or
 * closed. Degenerate rings (<3 verts) are never containing.
 * @param {Array<[number,number]>} ring
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Resolve a natural-region OUTLINE ring for the annotation resolver's first
 * rung. Stricter than `findNaturalRegion`: walks ALL entries sharing the
 * matched name (duplicate names included — the US and Spanish "Sierra
 * Nevada" both exist upstream) and returns the single ring that CONTAINS the
 * geocoded anchor. Containment is simultaneously the disambiguator and the
 * wrong-place guard: when no ring contains the anchor this returns null and
 * the resolver's normal ladder continues unchanged.
 *
 * @param {string} query   The user's place ask (aliases/articles handled).
 * @param {number} lat     Geocoded anchor latitude.
 * @param {number} lon     Geocoded anchor longitude.
 * @returns {Promise<{name:string, kind:'natural'|'marine', featurecla:string,
 *   ring:Array<[number,number]>, areaKm2:number}|null>}
 */
export async function lookupNaturalRegionOutline(query, lat, lon) {
  const norm = normalizeName(query);
  if (!norm || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const index = await loadIndex();
  const candidates = [norm, ALIASES[norm], ...suffixVariants(ALIASES[norm] || norm)];
  const seen = new Set();
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const entry of index.get(key) || []) {
      for (const ring of entry.polygons) {
        if (pointInRing(ring, lat, lon)) {
          return {
            name: entry.name,
            kind: entry.kind,
            featurecla: entry.featurecla,
            ring,
            areaKm2: entry.areaKm2,
          };
        }
      }
    }
  }
  return null;
}
