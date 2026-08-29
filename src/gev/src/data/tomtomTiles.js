/**
 * @file Pure tile math + budget accounting for the TomTom traffic-flow proxy.
 *
 * Shared by the `/api/gev/tomtom` vite plugin (server-side: coordinate validation,
 * daily budget governor) and `src/data/flowTiles.js` (client-side: which tiles
 * cover the current traffic fetch bounds). Zero dependencies, Cesium-free, so
 * both sides can unit-test against it with node:test.
 *
 * Slippy scheme: standard Web Mercator XYZ, y grows southward
 * (https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames) — the scheme
 * TomTom's `traffic/map/4/tile/flow` endpoints use.
 *
 * @module data/tomtomTiles
 */

/** @const {number} Min supported TomTom flow-tile zoom (proxy validation). */
export const MIN_TILE_ZOOM = 8;
/** @const {number} Max supported TomTom flow-tile zoom (proxy validation). */
export const MAX_TILE_ZOOM = 16;
/** @const {number} Web Mercator latitude limit (degrees). */
const MERCATOR_LAT_LIMIT = 85.05112878;

/**
 * Validate a z/x/y tile coordinate for the TomTom flow proxy.
 *
 * @param {number} z - Zoom level; integer within [MIN_TILE_ZOOM, MAX_TILE_ZOOM].
 * @param {number} x - Tile column; integer within [0, 2^z - 1].
 * @param {number} y - Tile row; integer within [0, 2^z - 1].
 * @returns {boolean} True when the coordinate is a fetchable tile.
 */
export function isValidTileCoord(z, x, y) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < MIN_TILE_ZOOM || z > MAX_TILE_ZOOM) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

/**
 * Convert a lon/lat (degrees) to the containing slippy tile at zoom `z`.
 * Latitude is clamped to the Web Mercator limit; results are clamped into
 * [0, 2^z - 1] so antimeridian/pole inputs stay valid.
 *
 * @param {number} lon - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} z - Zoom level.
 * @returns {{x:number, y:number}} Tile column/row.
 */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

/**
 * Compute the geographic bounding box of a slippy tile.
 *
 * @param {number} z - Zoom level.
 * @param {number} x - Tile column.
 * @param {number} y - Tile row.
 * @returns {{west:number, south:number, east:number, north:number}} Degrees.
 */
export function tileToBBox(z, x, y) {
  const n = 2 ** z;
  const lonAt = (col) => (col / n) * 360 - 180;
  const latAt = (row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: lonAt(x),
    east: lonAt(x + 1),
    north: latAt(y),
    south: latAt(y + 1),
  };
}

/**
 * List the tiles covering a lat/lon bounding box at the given zoom.
 *
 * Traffic fetch bounds are clamped to a 0.05° span, so this is 1–4 tiles at
 * the default z12 in practice; `maxTiles` is a defensive truncation cap for
 * malformed/oversized inputs (row-major from the northwest corner).
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds - Degrees.
 * @param {number} [zoom=12] - Tile zoom level.
 * @param {Object} [opts]
 * @param {number} [opts.maxTiles=64] - Safety cap on returned tiles.
 * @returns {Array<{z:number, x:number, y:number}>} Covering tiles.
 */
export function tilesForBounds(bounds, zoom = 12, { maxTiles = 64 } = {}) {
  if (!bounds) return [];
  const { south, west, north, east } = bounds;
  if (![south, west, north, east].every(Number.isFinite)) return [];
  // Northwest corner has the min x and min y (y grows southward).
  const nw = lonLatToTile(Math.min(west, east), Math.max(south, north), zoom);
  const se = lonLatToTile(Math.max(west, east), Math.min(south, north), zoom);
  const tiles = [];
  for (let y = nw.y; y <= se.y; y++) {
    for (let x = nw.x; x <= se.x; x++) {
      if (tiles.length >= maxTiles) return tiles;
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

// ─── Daily budget accounting ───────────────────────────────

/**
 * UTC calendar-day key for budget bucketing.
 *
 * @param {number} [epochMs=Date.now()] - Timestamp in ms.
 * @returns {string} 'YYYY-MM-DD' in UTC.
 */
export function utcDayKey(epochMs = Date.now()) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Normalize a persisted budget state against today's UTC day key.
 * Rolls the counter to zero on day change; replaces missing/corrupt state.
 * Returns the SAME object when it is already valid for `dayKey` (cheap to
 * call on every request).
 *
 * @param {{date:string, count:number}|null|undefined} state - Persisted state.
 * @param {string} dayKey - Today's UTC day key (from `utcDayKey`).
 * @returns {{date:string, count:number}} Valid state for `dayKey`.
 */
export function normalizeBudget(state, dayKey) {
  const valid = Boolean(state)
    && state.date === dayKey
    && Number.isFinite(state.count)
    && state.count >= 0;
  return valid ? state : { date: dayKey, count: 0 };
}

/**
 * Whether the daily soft cap has been reached.
 *
 * @param {{count:number}} state - Normalized budget state.
 * @param {number} limit - Daily tile budget; non-positive/invalid never blocks.
 * @returns {boolean} True when `count >= limit`.
 */
export function isOverBudget(state, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return state.count >= limit;
}
