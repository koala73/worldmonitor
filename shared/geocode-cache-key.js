/**
 * Country-level reverse-geocode cache identity (#7279).
 *
 * Nominatim is queried at the caller's exact coordinate (zoom=3), so the Redis
 * key must not span a cell large enough to sit on both sides of a land border.
 * 0.001° is about 111 m at the equator — fine enough for a country answer,
 * coarse enough that repeat clicks still coalesce. Ocean and Antarctic misses
 * use the same key so empty cells are not 100% provider passthrough.
 *
 * api/reverse-geocode.js, the gateway RPC, and the browser memoization all
 * import this helper so the three surfaces cannot drift.
 */
export const GEOCODE_CACHE_DECIMALS = 3;

export function geocodeCacheCell(lat, lon) {
  return `${Number(lat).toFixed(GEOCODE_CACHE_DECIMALS)},${Number(lon).toFixed(GEOCODE_CACHE_DECIMALS)}`;
}

export function geocodeCacheKey(lat, lon) {
  return `geocode:${geocodeCacheCell(lat, lon)}`;
}
