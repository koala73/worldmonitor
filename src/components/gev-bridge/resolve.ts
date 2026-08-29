/**
 * Turn a pushed payload into markers, using its spec.
 *
 * Kept apart from both the table and the renderer so the interesting part —
 * "does a tracker row survive the trip to a marker?" — is testable with no
 * Cesium, no DOM and no viewer. Every accessor in a spec runs against data
 * that came off the network, so each one is guarded: a spec that throws on
 * one malformed row must not cost the layer its other 400.
 */

import type { BridgeMarker, BridgeSpec } from './types';

export function resolveMarkers(spec: BridgeSpec, payload: unknown): BridgeMarker[] {
  const markers: BridgeMarker[] = [];
  const seen = new Set<string>();

  for (const part of spec.parts) {
    let rows: unknown[];
    try {
      rows = part.rows(payload) ?? [];
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row == null) continue;
      try {
        if (part.skip?.(row)) continue;
        const lat = part.lat(row);
        const lon = part.lon(row);
        // A tracker with no position is not a bug — plenty of feeds carry
        // rows that were never geocoded. Dropping them silently is what the
        // old globe did, and surfacing them at (0, 0) would be worse: a
        // phantom cluster in the Gulf of Guinea.
        if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const id = part.id(row, i);
        // Ids collide when a feed repeats a key. First one wins, so the
        // marker that survives is stable across polls rather than arbitrary.
        if (seen.has(id)) continue;
        seen.add(id);

        markers.push({
          id,
          kind: part.kind,
          lat,
          lon,
          ...(part.height && { height: part.height(row) }),
          title: part.title(row),
          style: part.style(row),
          row,
        });
      } catch {
        /* one malformed row, not one broken layer */
      }
    }
  }

  return markers;
}
