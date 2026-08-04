/**
 * Canonical per-request work bound for GetAircraftDetailsBatch.
 *
 * The handler fetches cache misses serially with a 100ms gap, so this is a real
 * latency budget, not a formality. The browser must not exceed it either: the
 * generated validator rejects the call outright above `icao24s` max_items = 20,
 * and anything between this bound and that ceiling is work the handler silently
 * discards.
 *
 * Imported by both sides so the two cannot drift apart:
 *   - server/worldmonitor/military/v1/get-aircraft-details-batch.ts
 *   - src/services/wingbits.ts
 * Kept dependency-free so the browser bundle can import it (same pattern as
 * server/_shared/source-tiers.ts, re-exported from src/config/feeds.ts).
 */
export const AIRCRAFT_DETAILS_BATCH_LIMIT = 10;
