/**
 * Edge-safe mirror of shared/geocode-cache-key.js (#7279).
 *
 * api/*.js may only import same-directory _*.js helpers and packages
 * (AGENTS.md). Keep the public shape and function bodies in lockstep with
 * the shared helper; tests/reverse-geocode-cache-contract.test.mts fails
 * if they drift.
 */
export const GEOCODE_CACHE_DECIMALS = 3;

export function geocodeCacheCell(lat, lon) {
  return `${Number(lat).toFixed(GEOCODE_CACHE_DECIMALS)},${Number(lon).toFixed(GEOCODE_CACHE_DECIMALS)}`;
}

export function geocodeCacheKey(lat, lon) {
  return `geocode:${geocodeCacheCell(lat, lon)}`;
}
