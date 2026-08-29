/**
 * Bundled neighborhood-polygon lookup — a reliable, deterministic, offline source for
 * neighborhood boundaries that OSM tags as label-nodes-only (Chinatown, the Marina, the
 * Mission, …). It sits AHEAD of the live-Overpass / synthesis path in the resolver, so
 * covered neighborhoods resolve instantly to a REAL boundary with no network dependency
 * because the live Overpass path is slow and inconsistent for neighborhoods.
 *
 * Source-agnostic: each city is a `{name, geometry}` GeoJSON file in
 * `local_data/neighborhoods/`. Swap the file (e.g. to public-domain DataSF) without
 * touching this module — see `local_data/neighborhoods/SOURCE.md`.
 */

import { createRetryableLoader } from './retryableLoad.js';

// bbox = [west, south, east, north]; only load a city file when the point falls in its box.
const CITY_FILES = [
  { id: 'san-francisco', bbox: [-122.55, 37.70, -122.35, 37.84], loader: () => import('./local_data/neighborhoods/san-francisco.json') },
];

const isNode = typeof process !== 'undefined' && !!process.versions?.node
  && typeof window === 'undefined';

/**
 * city id → memoized loader. Failures are NOT memoized: a transient
 * chunk-load error used to cache an empty array forever, silently demoting
 * every later neighborhood ask to the slow live-Overpass ladder for the rest
 * of the session, indistinguishably from "not in a covered city".
 * @type {Map<string, () => Promise<Array>>}
 */
const _cityLoaders = new Map();

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalized-query aliases for names DataSF's taxonomy renamed or absorbed.
 * "Downtown/Civic Center" was split across Tenderloin/Hayes Valley/etc. and
 * deliberately has NO alias — a wrong confident polygon is worse than the
 * live resolver ladder ("Downtown" alone colloquially means FiDi, so it maps).
 */
const NAME_ALIASES = new Map([
  ['financial district', 'financial district south beach'],
  ['downtown', 'financial district south beach'],
]);

/** Ray-casting point-in-ring. ring = [[lon,lat], …]. */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Normalize Polygon | MultiPolygon → array of polygons (each = [outerRing, ...holes]). */
function toPolygons(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

/** The outer ring of the polygon (part) that CONTAINS the point, honoring holes. */
function containingOuterRing(feature, lon, lat) {
  for (const poly of toPolygons(feature.geometry)) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    if (!pointInRing(lon, lat, outer)) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return outer;
  }
  return null;
}

/** Largest outer ring (by vertex count) — used when the name matches but the point is just outside. */
function largestOuterRing(geom) {
  let best = null;
  for (const poly of toPolygons(geom)) {
    const outer = poly[0];
    if (outer && (!best || outer.length > best.length)) best = outer;
  }
  return best;
}

function cityLoader(city) {
  let loader = _cityLoaders.get(city.id);
  if (!loader) {
    loader = createRetryableLoader(async () => {
      let fc;
      if (isNode) {
        // node:test path — plain dynamic JSON import needs an import attribute in Node,
        // so read the file directly (same dual-path pattern as naturalEarthRegions.js).
        const { readFileSync } = await import(/* @vite-ignore */ 'node:fs');
        const url = new URL(`./local_data/neighborhoods/${city.id}.json`, import.meta.url);
        fc = JSON.parse(readFileSync(url, 'utf8'));
      } else {
        // Vite bundles the JSON file as a module.
        const mod = await city.loader();
        fc = mod.default || mod;
      }
      return Array.isArray(fc.features) ? fc.features : [];
    });
    _cityLoaders.set(city.id, loader);
  }
  return loader;
}

async function loadCity(city) {
  try {
    return await cityLoader(city)();
  } catch (error) {
    // The caller falls back to the live resolver ladder, which looks exactly
    // like "no bundled coverage" — say so once, out loud, instead.
    console.warn(`[neighborhoods] ${city.id} pack unavailable:`, error?.message || error);
    return [];
  }
}

/**
 * Look up a bundled neighborhood polygon for a point + name.
 * @param {number} lat
 * @param {number} lon
 * @param {string} matchName - the geocoder's canonical place name (e.g. "Marina District")
 * @returns {Promise<{ring:[number,number][], name:string}|null>} the outer ring + matched
 *   neighborhood name, or null when the point isn't in a covered city / no match.
 */
export async function lookupNeighborhoodRing(lat, lon, matchName) {
  const city = CITY_FILES.find((c) => lon >= c.bbox[0] && lat >= c.bbox[1] && lon <= c.bbox[2] && lat <= c.bbox[3]);
  if (!city) return null;
  const feats = await loadCity(city);
  if (!feats.length) return null;

  // Old/colloquial names whose DataSF taxonomy equivalent has a longer name
  // (P0-2 swap): the word-subset matcher requires every feature-name word in
  // the query, so "Financial District" can never match "Financial
  // District/South Beach" without this. Exact-normalized-key aliases only —
  // no fuzzy aliasing.
  const q = normalize(matchName);
  const aliased = NAME_ALIASES.get(q) || q;
  const qWords = new Set(aliased.split(' ').filter(Boolean));
  if (!qWords.size) return null;

  // A NAME match is REQUIRED — there is NO name-less point-in-polygon fallback. A SF point
  // in an UNbundled neighborhood (Hayes Valley, Tenderloin, …) would otherwise fall inside a
  // neighbor's bundled polygon and be returned as a confident WRONG boundary, blocking the
  // OSM/synthesis ladder. Word-level match (every feature-name word must be in the query) so
  // "Mission" matches "Mission District" but NOT "Outer Mission", avoids substring
  // false-matches ("mission" inside "transmission"), and disambiguates Presidio vs Presidio
  // Heights. Point-in-polygon is only a CONFIRMATION / specificity tiebreak.
  let best = null; // { ring, name, contains, fwordCount }
  for (const f of feats) {
    const fname = normalize(f.properties && f.properties.name);
    if (!fname) continue;
    const fWords = fname.split(' ').filter(Boolean);
    if (!fWords.length || !fWords.every((w) => qWords.has(w))) continue; // require name match
    const containRing = containingOuterRing(f, lon, lat);
    const ring = containRing || largestOuterRing(f.geometry);
    if (!ring) continue;
    const cand = { ring, name: f.properties.name, contains: !!containRing, fwordCount: fWords.length };
    // Prefer a feature that CONTAINS the point, then the most specific name (most words).
    if (!best
      || (cand.contains && !best.contains)
      || (cand.contains === best.contains && cand.fwordCount > best.fwordCount)) {
      best = cand;
    }
  }
  return best ? { ring: best.ring, name: best.name } : null;
}
