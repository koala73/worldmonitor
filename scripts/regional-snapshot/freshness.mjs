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
 * @property {string=} metaKey - Optional companion seed-meta key carrying
 *   {fetchedAt, recordCount}. Used when the primary payload has no
 *   top-level timestamp field. classifyInputs() will prefer the meta key's
 *   timestamp when both are available so a stalled seeder can be detected
 *   even if the data payload is still served from a previous write.
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
  // The aviation/gpsjam payloads have no top-level timestamp field, so they
  // rely on companion seed-meta:* keys (written by the seeders via
  // writeFreshnessMetadata / upstashSet) for stale detection. Without these
  // metaKey hints, classifyInputs would fall back to "undated = fresh" and
  // miss stalled seeders entirely.
  { key: 'aviation:delays:faa:v1',               maxAgeMin: 60,    feedsAxes: ['mobility'], metaKey: 'seed-meta:aviation:faa' },
  { key: 'aviation:delays:intl:v3',              maxAgeMin: 90,    feedsAxes: ['mobility'], metaKey: 'seed-meta:aviation:intl' },
  { key: 'aviation:notam:closures:v2',           maxAgeMin: 120,   feedsAxes: ['mobility'], metaKey: 'seed-meta:aviation:notam' },
  { key: 'intelligence:gpsjam:v2',               maxAgeMin: 240,   feedsAxes: ['mobility', 'airspace'], metaKey: 'seed-meta:intelligence:gpsjam' },
  // military:flights:v1 already carries top-level fetchedAt, no metaKey needed.
  { key: 'military:flights:v1',                  maxAgeMin: 30,    feedsAxes: ['mobility', 'reroute_intensity'] },
];

/** Every metaKey referenced by FRESHNESS_REGISTRY, for pre-fetching. */
export const ALL_META_KEYS = FRESHNESS_REGISTRY
  .map((s) => s.metaKey)
  .filter((k) => typeof k === 'string' && k.length > 0);

export const ALL_INPUT_KEYS = FRESHNESS_REGISTRY.map((s) => s.key);

/**
 * Classify each input as fresh, stale, or missing.
 *
 * Timestamp resolution order per input:
 *   1. If the spec has a `metaKey`, use metaPayloads[metaKey].fetchedAt.
 *      This is the canonical signal for sources whose data payload lacks
 *      a top-level timestamp (FAA alerts, AviationStack, NOTAM, GPS jam).
 *   2. Otherwise, pull a timestamp from the primary payload via
 *      extractTimestamp (fetchedAt, generatedAt, timestamp, updatedAt,
 *      lastUpdate).
 *   3. If neither yields a timestamp, fall back to "fresh" (cannot prove
 *      staleness). This fallback remains so we don't regress existing
 *      keys that have never needed a meta key.
 *
 * @param {Record<string, unknown>} payloads - Map of key -> raw value (or null)
 * @param {Record<string, unknown>} [metaPayloads] - Map of metaKey -> raw value (or null)
 * @returns {{ fresh: string[]; stale: string[]; missing: string[] }}
 */
export function classifyInputs(payloads, metaPayloads = {}) {
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

    // Prefer the companion seed-meta:*.fetchedAt when the spec declares one.
    // This is the only way to detect a stalled seeder for payloads that
    // don't carry a top-level timestamp of their own.
    let ts = null;
    if (spec.metaKey) {
      const meta = metaPayloads[spec.metaKey];
      ts = extractTimestamp(meta);
    }
    if (ts === null) ts = extractTimestamp(payload);

    if (ts === null) {
      // Present but undated — treat as fresh (we cannot prove staleness).
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
