import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tilesForBounds } from './tomtomTiles.js';

/**
 * @file TomTom traffic-flow vector-tile client: fetch + MVT decode.
 *
 * Fetches flow tiles from the local `/api/gev/tomtom/flow/{z}/{x}/{y}.pbf` proxy
 * (the TomTom key never reaches the browser) and decodes the Mapbox Vector
 * Tile layer "Traffic flow" into plain lon/lat polylines with congestion
 * attributes. Consumed by the traffic layer's live mode
 * (`src/data/traffic.js` → `src/data/flowMatch.js`).
 *
 * Segment shape: `{coords: [[lon,lat],…], trafficLevel: 0..1, roadType: string,
 * closure: boolean}` — `trafficLevel` is TomTom's current/free-flow speed
 * ratio (1 = free flow). Features with a missing/non-finite `traffic_level`
 * are skipped unless `road_closure` is true (closures decode with level 0).
 *
 * Deps: `pbf@5` (PbfReader) + `@mapbox/vector-tile@3` — both tiny and
 * tree-shakeable; decoding happens client-side so the proxy stays a dumb
 * binary cache.
 *
 * @module data/flowTiles
 */

export { tilesForBounds };

/** @const {string} MVT layer name in TomTom flow tiles (verified live 2026-07-16). */
const FLOW_LAYER_NAME = 'Traffic flow';
/** @const {number} Ms — per-tile decode cache TTL (matches the proxy's 120 s tile TTL). */
const DECODE_CACHE_TTL_MS = 120_000;
/** @const {number} Max decoded tiles kept in memory before oldest-entry eviction. */
const DECODE_CACHE_MAX_ENTRIES = 64;

/**
 * Decoded-tile cache keyed by "z/x/y".
 * @type {Map<string, {at:number, segments:Array}>}
 */
const _decodeCache = new Map();
/** @type {number} Session count of tile requests issued to the proxy (decode-cache misses). */
let _tilesFetched = 0;

/**
 * Decode one TomTom flow tile (MVT protobuf) into flow segments.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} data - Raw .pbf tile bytes.
 * @param {number} z - Tile zoom (for tile-local → lon/lat projection).
 * @param {number} x - Tile column.
 * @param {number} y - Tile row.
 * @returns {Array<{coords:number[][], trafficLevel:number, roadType:string, closure:boolean}>}
 *   Flow polylines in [lon, lat] degrees. Returns [] for undecodable buffers
 *   or tiles without a "Traffic flow" layer (defensive — a corrupt tile must
 *   not kill the traffic layer).
 */
export function decodeFlowTile(data, z, x, y) {
  let layer;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const tile = new VectorTile(new PbfReader(bytes));
    layer = tile.layers[FLOW_LAYER_NAME];
  } catch {
    return [];
  }
  if (!layer) return [];

  const segments = [];
  for (let i = 0; i < layer.length; i++) {
    let feature;
    let geometry;
    try {
      feature = layer.feature(i);
      geometry = feature.toGeoJSON(x, y, z).geometry;
    } catch {
      continue; // one malformed feature must not drop the tile
    }
    const props = feature.properties || {};
    const closure = props.road_closure === true || props.road_closure === 'true';
    const rawLevel = props.traffic_level;
    const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
    // Skip features we can't color — unless closed (closures render dot-free
    // regardless of level, so they stay useful without one).
    if (!hasLevel && !closure) continue;
    const trafficLevel = hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0;
    const roadType = typeof props.road_type === 'string' ? props.road_type : '';

    const lines = geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      segments.push({ coords, trafficLevel, roadType, closure });
    }
  }
  return segments;
}

/** Insert into the decode cache with oldest-entry eviction. */
function cacheSet(key, entry) {
  if (!_decodeCache.has(key) && _decodeCache.size >= DECODE_CACHE_MAX_ENTRIES) {
    const oldest = _decodeCache.keys().next().value;
    _decodeCache.delete(oldest);
  }
  _decodeCache.set(key, entry);
}

/**
 * Fetch + decode all flow tiles covering the given bounds.
 *
 * Tiles are fetched from the local proxy in parallel; each decoded tile is
 * cached in memory for 120 s (keyed z/x/y), so repeat calls for the same
 * viewport are free. Partial tile failures return the segments that DID
 * decode (last-good philosophy); the promise rejects only when every tile
 * failed (e.g. keyless 503, aborted signal, proxy down).
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds - Degrees.
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal] - Abort signal (camera moved / layer disabled).
 * @param {number} [opts.zoom=12] - Flow tile zoom level.
 * @returns {Promise<Array<{coords:number[][], trafficLevel:number, roadType:string, closure:boolean}>>}
 *   Flat array of flow segments across all covering tiles.
 */
export async function fetchFlowForBounds(bounds, { signal, zoom = 12 } = {}) {
  const tiles = tilesForBounds(bounds, zoom);
  if (tiles.length === 0) return [];
  const now = Date.now();

  const results = await Promise.allSettled(tiles.map(async ({ z, x, y }) => {
    const key = `${z}/${x}/${y}`;
    const cached = _decodeCache.get(key);
    if (cached && now - cached.at < DECODE_CACHE_TTL_MS) return cached.segments;

    _tilesFetched += 1;
    const res = await fetch(`/api/gev/tomtom/flow/${z}/${x}/${y}.pbf`, { signal });
    if (!res.ok) throw new Error(`flow tile ${key}: HTTP ${res.status}`);
    const segments = decodeFlowTile(await res.arrayBuffer(), z, x, y);
    cacheSet(key, { at: Date.now(), segments });
    return segments;
  }));

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  if (fulfilled.length === 0) {
    throw results[0].reason instanceof Error ? results[0].reason : new Error('flow fetch failed');
  }
  return fulfilled.flatMap((r) => r.value);
}

/**
 * Session diagnostics for `getStats()` surfaces.
 * @returns {{tilesFetched:number}} Count of tile requests issued to the proxy
 *   this session (decode-cache hits excluded).
 */
export function getFlowSessionStats() {
  return { tilesFetched: _tilesFetched };
}

/** Clear the decode cache (tests + layer teardown). Session stats persist. */
export function resetFlowTileCache() {
  _decodeCache.clear();
}
