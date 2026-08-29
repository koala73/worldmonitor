// src/data/aircraftMeta.js
/**
 * Sticky per-aircraft metadata merge: once a field has resolved for an
 * aircraft, a later snapshot that MISSES the field (empty/null — OpenSky and
 * adsb.lol both do this intermittently) must not regress it. A later snapshot
 * that CHANGES the field always wins. Pattern from skylight (MIT)
 * server/src/datasource.ts "sticky enrichment".
 */

export function stickyText(next, prev) {
  const n = String(next || '').trim();
  if (n) return n;
  const p = String(prev || '').trim();
  return p || '';
}

export function stickyNumber(next, prev, fallback) {
  if (Number.isFinite(next)) return next;
  if (Number.isFinite(prev)) return prev;
  return fallback;
}
