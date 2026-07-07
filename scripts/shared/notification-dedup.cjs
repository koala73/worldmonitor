'use strict';

/**
 * Slot B dedup-material builder — the single source of truth shared by every
 * notification publisher.
 *
 * When a coalesceKey is set (an NWS VTEC family string, a market asset-family
 * key, an airport/ICAO key, ...) the dedup key is derived from it so adjacent
 * or repeated same-family events collapse to one notification. Otherwise it
 * falls back to the eventType:title hash.
 *
 * Extracted from the three previously byte-identical inline copies in
 * ais-relay.cjs, seed-aviation.mjs, and notification-relay.cjs so the
 * coalesce/fallback formula changes in one place (WM PR #4985 review, finding #2).
 *
 * @param {string} eventType         producer event type (e.g. 'market_alert')
 * @param {string|undefined} title   payload title; coerced to '' when absent
 * @param {string|undefined} coalesceKey  family key; when truthy it wins
 * @returns {string} the material to hash into the dedup key
 */
function buildDedupMaterial(eventType, title, coalesceKey) {
  return coalesceKey ? `coalesce:${coalesceKey}` : `${eventType}:${title ?? ''}`;
}

module.exports = { buildDedupMaterial };
