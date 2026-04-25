// Live Tankers service — fetches per-vessel position reports for AIS ship
// type 80-89 (tanker class) inside chokepoint bounding boxes. Powers the
// LiveTankersLayer on the Energy Atlas map.
//
// Per the parity-push plan U8 (docs/plans/2026-04-25-003-feat-energy-parity-pushup-plan.md):
// - Sources bbox centroids from `src/config/chokepoint-registry.ts`
//   (NOT `server/.../_chokepoint-ids.ts` — that file strips lat/lon).
// - One getVesselSnapshot call per chokepoint, ±2° box around centroid.
// - In-memory cache, 60s TTL per chokepoint key.
// - On per-zone failure, returns last successful response (graceful
//   degradation; one outage doesn't blank the whole layer).
//
// The handler-side cache (server/worldmonitor/maritime/v1/get-vessel-snapshot.ts)
// also caches by quantized bbox + tankers flag at 60s TTL, and the gateway
// 'live' tier (server/gateway.ts) sets s-maxage=60 so concurrent identical
// requests across users get absorbed at the CDN. This three-layer cache
// (CDN → handler → service) means the per-tab 6-call/min worst case scales
// sub-linearly with the user count.

import { CHOKEPOINT_REGISTRY, type ChokepointRegistryEntry } from '@/config/chokepoint-registry';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { MaritimeServiceClient } from '@/generated/client/worldmonitor/maritime/v1/service_client';
import type { SnapshotCandidateReport } from '@/generated/client/worldmonitor/maritime/v1/service_client';

const client = new MaritimeServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

// ±2° box around each chokepoint centroid. Tuned in the implementation
// section of plan U8 — Hormuz traffic at peak transit is ~50-150 vessels
// in this box, well below the server-side 200/zone cap. Implementer should
// adjust if a specific zone (e.g. Malacca, much busier) consistently fills
// the cap.
const BBOX_HALF_DEGREES = 2;

// Cache TTL must match the gateway 'live' tier's s-maxage (60s). Going
// shorter wastes CDN cache hits; going longer breaks the freshness contract.
const CACHE_TTL_MS = 60_000;

// Default chokepoints whose live tankers we render. Energy-relevant subset
// of the full chokepoint registry — global trade hubs that aren't oil/gas
// chokepoints (e.g. Strait of Dover, English Channel) are skipped.
const DEFAULT_CHOKEPOINT_IDS = new Set<string>([
  'hormuz_strait',
  'suez',
  'bab_el_mandeb',
  'malacca_strait',
  'panama',
  'bosphorus', // Turkish Straits per CHOKEPOINT_REGISTRY canonical id
]);

interface CacheSlot {
  data: SnapshotCandidateReport[];
  fetchedAt: number;
}

const cache = new Map<string, CacheSlot>();

export interface ChokepointTankers {
  chokepoint: ChokepointRegistryEntry;
  tankers: SnapshotCandidateReport[];
  /** True when this zone's last fetch failed and we're serving stale data. */
  stale: boolean;
}

function getDefaultChokepoints(): ChokepointRegistryEntry[] {
  return CHOKEPOINT_REGISTRY.filter((c) => DEFAULT_CHOKEPOINT_IDS.has(c.id));
}

function bboxFor(c: ChokepointRegistryEntry): {
  swLat: number; swLon: number; neLat: number; neLon: number;
} {
  return {
    swLat: c.lat - BBOX_HALF_DEGREES,
    swLon: c.lon - BBOX_HALF_DEGREES,
    neLat: c.lat + BBOX_HALF_DEGREES,
    neLon: c.lon + BBOX_HALF_DEGREES,
  };
}

async function fetchOne(c: ChokepointRegistryEntry, signal?: AbortSignal): Promise<SnapshotCandidateReport[]> {
  const bbox = bboxFor(c);
  const resp = await client.getVesselSnapshot(
    {
      ...bbox,
      includeCandidates: false,
      includeTankers: true,
    },
    { signal },
  );
  return resp.snapshot?.tankerReports ?? [];
}

/**
 * Fetch tanker positions for a set of chokepoints, returning per-zone
 * results. Failed zones return their last successful data with `stale: true`;
 * if a zone has never succeeded, it's omitted from the return value.
 *
 * @param chokepoints - chokepoints to query. Defaults to the energy-relevant
 *                      subset (Hormuz, Suez, Bab el-Mandeb, Malacca, Panama,
 *                      Turkish Straits) when omitted.
 * @param options.signal - AbortSignal to cancel in-flight RPC calls when
 *                      the caller's context tears down (layer toggled off,
 *                      map destroyed, newer refresh started). Without this,
 *                      a slow older refresh can race-write stale data after
 *                      a newer one already populated the layer state.
 */
export async function fetchLiveTankers(
  chokepoints?: ChokepointRegistryEntry[],
  options: { signal?: AbortSignal } = {},
): Promise<ChokepointTankers[]> {
  const targets = chokepoints ?? getDefaultChokepoints();
  const now = Date.now();
  const { signal } = options;

  const results = await Promise.allSettled(
    targets.map(async (c) => {
      const slot = cache.get(c.id);
      if (slot && now - slot.fetchedAt < CACHE_TTL_MS) {
        return { chokepoint: c, tankers: slot.data, stale: false };
      }
      // Bail early if already aborted before the per-zone fetch starts —
      // saves a wasted RPC + cache write when the caller has moved on.
      if (signal?.aborted) {
        if (slot) return { chokepoint: c, tankers: slot.data, stale: true };
        throw new DOMException('aborted before fetch', 'AbortError');
      }
      try {
        const tankers = await fetchOne(c, signal);
        // Re-check abort after the fetch resolves: prevents a slow
        // resolver from clobbering cache after the caller cancelled.
        if (signal?.aborted) {
          if (slot) return { chokepoint: c, tankers: slot.data, stale: true };
          throw new DOMException('aborted after fetch', 'AbortError');
        }
        cache.set(c.id, { data: tankers, fetchedAt: now });
        return { chokepoint: c, tankers, stale: false };
      } catch (err) {
        // Per-zone failure: serve last-known data if any. The layer
        // continues rendering even if one chokepoint's relay is flaky.
        if (slot) return { chokepoint: c, tankers: slot.data, stale: true };
        throw err; // no last-known data → drop this zone
      }
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<ChokepointTankers> => r.status === 'fulfilled')
    .map((r) => r.value);
}

// Internal exports for test coverage; not part of the public surface.
export const _internal = {
  bboxFor,
  getDefaultChokepoints,
  CACHE_TTL_MS,
  BBOX_HALF_DEGREES,
};
