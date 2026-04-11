// @ts-check
// Source freshness registry. Mirrors the table in
// docs/internal/pro-regional-intelligence-appendix-scoring.md "Source Freshness Registry".
//
// Each entry maps a Redis key (or key prefix) to its expected max-age.
// The snapshot writer marks inputs as stale or missing based on this table
// and feeds those flags into SnapshotMeta.snapshot_confidence.

/**
 * @typedef {object} SourceFreshnessSpec
 * @property {string} key      - Redis key (literal, no template variables)
 * @property {number} maxAgeMin - Maximum acceptable age in minutes
 * @property {string[]} feedsAxes - Which balance axes / sections this input drives
 */

/**
 * Only keys that compute modules actually consume via sources['...'].
 * Keys must be added here in lockstep with new compute consumers, never
 * speculatively. Drift between this list and the consumers is an alerting
 * blind spot (a missing key drags down snapshot_confidence and a present
 * key with no consumer wastes a Redis read).
 *
 * @type {SourceFreshnessSpec[]}
 */
export const FRESHNESS_REGISTRY = [
  { key: 'risk:scores:sebuf:stale:v1',          maxAgeMin: 30,    feedsAxes: ['domestic_fragility', 'coercive_pressure'] },
  { key: 'forecast:predictions:v2',              maxAgeMin: 180,   feedsAxes: ['scenarios', 'actors'] },
  { key: 'supply_chain:chokepoints:v4',          maxAgeMin: 30,    feedsAxes: ['maritime_access', 'corridors'] },
  { key: 'supply_chain:transit-summaries:v1',    maxAgeMin: 30,    feedsAxes: ['maritime_access'] },
  { key: 'intelligence:cross-source-signals:v1', maxAgeMin: 45,    feedsAxes: ['coercive_pressure', 'evidence'] },
  { key: 'relay:oref:history:v1',                maxAgeMin: 15,    feedsAxes: ['coercive_pressure', 'triggers'] },
  { key: 'economic:macro-signals:v1',            maxAgeMin: 60,    feedsAxes: ['capital_stress'] },
  { key: 'economic:national-debt:v1',            maxAgeMin: 10080, feedsAxes: ['capital_stress'] },
  { key: 'economic:stress-index:v1',             maxAgeMin: 120,   feedsAxes: ['capital_stress'] },
  { key: 'energy:mix:v1:_all',                   maxAgeMin: 50400, feedsAxes: ['energy_vulnerability'] },
  { key: 'economic:eu-gas-storage:v1',           maxAgeMin: 2880,  feedsAxes: ['energy_vulnerability'] },
  { key: 'economic:spr:v1',                      maxAgeMin: 10080, feedsAxes: ['energy_buffer'] },
  // Mobility v1 (Phase 2 PR2) — feed the MobilityState block via mobility.mjs.
  // maxAgeMin matches each seeder's cron interval + safety buffer.
  { key: 'aviation:delays:faa:v1',               maxAgeMin: 60,    feedsAxes: ['mobility'] },
  { key: 'aviation:delays:intl:v3',              maxAgeMin: 90,    feedsAxes: ['mobility'] },
  { key: 'aviation:notam:closures:v2',           maxAgeMin: 120,   feedsAxes: ['mobility'] },
  { key: 'intelligence:gpsjam:v2',               maxAgeMin: 240,   feedsAxes: ['mobility', 'airspace'] },
  { key: 'military:flights:v1',                  maxAgeMin: 30,    feedsAxes: ['mobility', 'reroute_intensity'] },
];

export const ALL_INPUT_KEYS = FRESHNESS_REGISTRY.map((s) => s.key);

/**
 * Classify each input as fresh, stale, or missing.
 * @param {Record<string, unknown>} payloads - Map of key -> raw value (or null)
 * @returns {{ fresh: string[]; stale: string[]; missing: string[] }}
 */
export function classifyInputs(payloads) {
  const fresh = [];
  const stale = [];
  const missing = [];
  const now = Date.now();

  for (const spec of FRESHNESS_REGISTRY) {
    const payload = payloads[spec.key];
    if (payload === null || payload === undefined) {
      missing.push(spec.key);
      continue;
    }
    // Try to extract a timestamp from common shapes.
    const ts = extractTimestamp(payload);
    if (ts === null) {
      // Present but undated -- treat as fresh (we cannot prove staleness).
      fresh.push(spec.key);
      continue;
    }
    const ageMin = (now - ts) / 60_000;
    if (ageMin > spec.maxAgeMin) {
      stale.push(spec.key);
    } else {
      fresh.push(spec.key);
    }
  }
  return { fresh, stale, missing };
}

/** Pull a timestamp out of common payload shapes; null if none found. */
function extractTimestamp(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const obj = payload;
  for (const field of ['fetchedAt', 'generatedAt', 'timestamp', 'updatedAt', 'lastUpdate']) {
    if (typeof obj[field] === 'number') return obj[field];
    if (typeof obj[field] === 'string') {
      const parsed = Date.parse(obj[field]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
