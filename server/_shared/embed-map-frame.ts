/**
 * Composes the partner map frame from the domain handlers the equivalent RPCs
 * already use, so this endpoint is a fan-out over one data path rather than a
 * second implementation of it.
 *
 * Every knob is a knob a stolen credential can turn, so the request carries
 * `layers` and nothing else — no bbox, no page size, no time window. Each
 * upstream is called with its own defaults.
 */

import {
  EMBED_KEYED_REFRESH_MS,
  EMBED_LAYER_IDS,
  getEmbedPanelFreeTier,
  isEmbedLayerId,
  type EmbedLayerId,
} from '../../shared/embed-panels';
import type {
  EmbedMapFrameData,
  EmbedMapFrameLayerState,
  EmbedMapFrameResponse,
} from '../../shared/embed-map-frame';

export type EmbedMapFrameTier = 'free' | 'keyed';

/**
 * The upstream reads, injected so the composition can be tested without Redis
 * or a live ACLED cache. Each returns the verbatim wire array its RPC returns.
 */
export interface EmbedMapFrameSources {
  listConflicts: () => Promise<readonly unknown[]>;
  listEarthquakes: () => Promise<readonly unknown[]>;
  listNaturalEvents: () => Promise<readonly unknown[]>;
  listProtests: () => Promise<readonly unknown[]>;
  listWeatherAlerts: () => Promise<readonly unknown[]>;
}

/** Which upstreams each live layer needs. Absent ⇒ the layer is static data
 *  the client already ships, and needs only an entitlement answer. */
const SOURCES_BY_LAYER = {
  conflicts: ['conflicts'],
  earthquakes: ['earthquakes', 'naturalEvents'],
  protests: ['protests'],
  weather: ['weatherAlerts'],
} as const satisfies Partial<Record<EmbedLayerId, readonly (keyof EmbedMapFrameData)[]>>;

type LiveLayerId = keyof typeof SOURCES_BY_LAYER;
type SourceKey = keyof EmbedMapFrameData;

const FETCHER_BY_SOURCE: Record<SourceKey, keyof EmbedMapFrameSources> = {
  conflicts: 'listConflicts',
  earthquakes: 'listEarthquakes',
  naturalEvents: 'listNaturalEvents',
  protests: 'listProtests',
  weatherAlerts: 'listWeatherAlerts',
};

function isLiveLayer(id: EmbedLayerId): id is LiveLayerId {
  return id in SOURCES_BY_LAYER;
}

/**
 * The layers this tier may serve.
 *
 * The free set comes from the registry, not from a literal here — the whole
 * point of `EmbedPanelAccess` is that the free policy has one definition.
 */
export function entitledLayersForTier(tier: EmbedMapFrameTier): readonly EmbedLayerId[] {
  const free = getEmbedPanelFreeTier('map');
  if (!free) throw new Error('map panel lost its free tier');
  return tier === 'free' ? free.layers : EMBED_LAYER_IDS;
}

/**
 * The `Cache-Control` for a response.
 *
 * `shared` is granted ONLY to the exact public URL shape — the keyed tier gets
 * `private, no-store` unconditionally, matching `api/embed/entitlement.ts`.
 * There is no middle setting: #5386 is the incident where a body that was
 * merely "not public" still landed in a warm shared entry and answered a
 * different caller's request.
 */
export function cacheControlForEmbedFrame(shared: boolean): string {
  if (!shared) return 'private, no-store';
  const seconds = Math.floor(refreshMsForTier('free') / 1000);
  // The free tier stops costing us anything only if the CDN can actually hold
  // it; `stale-while-revalidate` keeps a wall display rendering through an
  // origin blip.
  return `public, max-age=60, s-maxage=${seconds}, stale-while-revalidate=600`;
}

export function refreshMsForTier(tier: EmbedMapFrameTier): number {
  const free = getEmbedPanelFreeTier('map');
  if (!free) throw new Error('map panel lost its free tier');
  return tier === 'free' ? free.refreshMs : EMBED_KEYED_REFRESH_MS;
}

/**
 * Parse the only input this endpoint accepts.
 *
 * Unknown ids are dropped rather than rejected: a partner pinned to an older
 * snippet must keep rendering the layers we still recognise. Order and
 * duplicates are normalised so the CDN cache key does not fragment.
 */
export function parseRequestedLayers(raw: string | null): EmbedLayerId[] {
  const free = getEmbedPanelFreeTier('map');
  if (raw === null || raw.trim() === '') return free ? [...free.layers] : [];
  const seen = new Set<EmbedLayerId>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id && isEmbedLayerId(id)) seen.add(id);
  }
  return [...seen];
}

export async function composeEmbedMapFrame(
  requestedLayers: readonly EmbedLayerId[],
  tier: EmbedMapFrameTier,
  sources: EmbedMapFrameSources,
  now: number = Date.now(),
): Promise<EmbedMapFrameResponse> {
  const entitled = new Set(entitledLayersForTier(tier));
  const layers: Partial<Record<EmbedLayerId, EmbedMapFrameLayerState>> = {};

  // Only fetch what this tier may actually serve — an unentitled layer must
  // not cost an upstream read, or the free tier would fund the paid one.
  const needed = new Set<SourceKey>();
  for (const id of requestedLayers) {
    if (!entitled.has(id)) {
      layers[id] = 'not-entitled';
      continue;
    }
    if (!isLiveLayer(id)) {
      layers[id] = 'ok';
      continue;
    }
    for (const source of SOURCES_BY_LAYER[id]) needed.add(source);
  }

  const order = [...needed];
  const settled = await Promise.allSettled(
    order.map((source) => sources[FETCHER_BY_SOURCE[source]]()),
  );

  const data: EmbedMapFrameData = {};
  const failed = new Set<SourceKey>();
  order.forEach((source, index) => {
    const result = settled[index];
    if (result?.status === 'fulfilled') data[source] = result.value;
    else failed.add(source);
  });

  for (const id of requestedLayers) {
    if (layers[id] !== undefined) continue;
    const required = SOURCES_BY_LAYER[id as LiveLayerId];
    const down = required.filter((source) => failed.has(source)).length;
    layers[id] = down === 0 ? 'ok' : down === required.length ? 'unavailable' : 'partial';
  }

  return {
    tier,
    refreshMs: refreshMsForTier(tier),
    generatedAt: now,
    layers,
    data,
  };
}
