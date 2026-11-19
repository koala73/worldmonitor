// Derived projection of the canonical `wildfire:fires:v1` payload for the server
// hot paths that never render a detection: the CII risk-scores build needs the
// intensity of each detection inside a Tier-1 country, and the temporal-anomaly
// rebuild needs the total count and the FIRMS observation clock. The canonical
// key is 1.9-5 MB; this one is bounded by the Tier-1 share of detections, so it
// clears the 1.5 s Redis GET deadline with room to spare.
//
// Written by scripts/seed-fire-detections.mjs as an extra key of the same run,
// and recomputed by the readers from the canonical key only while this key is
// absent (deploy window, or an extra-key write that failed after publish).
//
// Shared by scripts/ and server/: keep it free of imports outside scripts/shared/.

import { ciiCountryAt } from './cii-country-borders.mjs';

export const WILDFIRE_FIRES_SUMMARY_KEY = 'wildfire:fires-summary:v1';
export const WILDFIRE_FIRES_SUMMARY_META_KEY = 'seed-meta:wildfire:fires-summary';
export const WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY = 'seed-activated:wildfire:fires-summary';
export const WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION = 1;

// Matches scripts/_content-age-helpers.mjs CLOCK_SKEW_TOLERANCE_MS and the
// temporal-anomalies content clock: observations more than an hour in the
// future are undatable, not fresh.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 60 * 1000;

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observationMs(value, skewLimit) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= skewLimit ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ts = Date.parse(value);
    return Number.isFinite(ts) && ts > 0 && ts <= skewLimit ? ts : null;
  }
  return null;
}

function isFirmsRow(row) {
  const source = row.source;
  return source == null || source === '' || source === 'firms';
}

function coordinate(row, nested, flat, ...aliases) {
  const candidates = [row[flat], ...aliases.map((name) => row[name]), row.location?.[nested]];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Summarize a canonical wildfire payload (`{ fireDetections, pagination?, _firms* }`).
 * Returns null when the payload has no detections array, so a reader can tell
 * "unusable" from "empty window".
 */
export function summarizeWildfireDetections(payload, { nowMs = Date.now() } = {}) {
  if (!isPlainObject(payload) || !Array.isArray(payload.fireDetections)) return null;
  const skewLimit = nowMs + CLOCK_SKEW_TOLERANCE_MS;
  const rows = payload.fireDetections;
  const byCountry = {};
  let firmsRows = 0;
  let newest = null;
  let oldest = null;

  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    if (isFirmsRow(row)) {
      firmsRows += 1;
      const ts = observationMs(row.detectedAt, skewLimit);
      if (ts != null) {
        if (newest == null || ts > newest) newest = ts;
        if (oldest == null || ts < oldest) oldest = ts;
      }
    }
    const lat = coordinate(row, 'latitude', 'lat', 'latitude');
    const lon = coordinate(row, 'longitude', 'lon', 'longitude');
    if (lat == null || lon == null) continue;
    const code = ciiCountryAt(lat, lon);
    if (!code) continue;
    (byCountry[code] ??= []).push({ brightness: finiteOrZero(row.brightness), frp: finiteOrZero(row.frp) });
  }

  const reportedTotal = finiteOrNull(payload.pagination?.totalCount);
  return {
    schemaVersion: WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION,
    totalCount: Math.max(reportedTotal ?? 0, rows.length),
    firms: {
      state: typeof payload._firmsState === 'string' ? payload._firmsState : null,
      partial: payload._firmsPartial === true,
      count: finiteOrNull(payload._firmsCount),
      rows: firmsRows,
      newestDetectedAt: newest,
      oldestDetectedAt: oldest,
    },
    byCountry: Object.fromEntries(Object.keys(byCountry).sort().map((code) => [code, byCountry[code]])),
  };
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Boundary parser for a summary read back from Redis. Rejects anything a
 * reader cannot score or date: missing counts, a non-object byCountry, and a
 * firms block without its row count or partial flag, because the content
 * clock reads `rows: 0` as "agency-only, skip" and `partial: false` as
 * "complete coverage". Malformed intensity rows are dropped row by row.
 */
export function parseWildfireFiresSummary(value) {
  if (!isPlainObject(value) || !isPlainObject(value.byCountry) || !isPlainObject(value.firms)) return null;
  const { totalCount, firms } = value;
  if (!isCount(totalCount) || !isCount(firms.rows) || typeof firms.partial !== 'boolean') return null;
  const byCountry = {};
  for (const [code, rows] of Object.entries(value.byCountry)) {
    if (!Array.isArray(rows)) continue;
    byCountry[code] = rows
      .filter(isPlainObject)
      .map((row) => ({ brightness: finiteOrZero(row.brightness), frp: finiteOrZero(row.frp) }));
  }
  return {
    schemaVersion: finiteOrNull(value.schemaVersion) ?? WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION,
    totalCount,
    firms: {
      state: typeof firms.state === 'string' ? firms.state : null,
      partial: firms.partial,
      count: finiteOrNull(firms.count),
      rows: firms.rows,
      newestDetectedAt: finiteOrNull(firms.newestDetectedAt),
      oldestDetectedAt: finiteOrNull(firms.oldestDetectedAt),
    },
    byCountry,
  };
}
