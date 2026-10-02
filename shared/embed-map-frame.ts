/**
 * Wire contract for `GET /api/embed/map-frame` — the one endpoint the partner
 * map frame polls, replacing four separate anonymous RPC calls.
 *
 * One endpoint rather than four because a credential published in partner HTML
 * has a blast radius equal to the set of paths that accept it. Keep this module
 * free of browser and server imports: the edge composes the response and the
 * embed entry consumes it.
 */

import {
  EMBED_LAYER_IDS,
  getEmbedPanelFreeTier,
  isEmbedLayerId,
  type EmbedLayerId,
} from './embed-panels';

export const EMBED_MAP_FRAME_PATH = '/api/embed/map-frame';

/**
 * Per-layer outcome.
 *
 * `partial` exists because the earthquakes layer draws on two upstreams
 * (seismic events and natural events); reporting it as `ok` would claim data
 * the frame did not receive, and as `unavailable` would hide data it did.
 */
export type EmbedMapFrameLayerState = 'ok' | 'partial' | 'unavailable' | 'not-entitled';

/**
 * Upstream payloads, verbatim.
 *
 * Each is the exact wire shape its RPC already returns, so the composed
 * endpoint is a fan-out over the SAME handlers rather than a second
 * implementation of the data path, and the client keeps the mappers it
 * already has. Typed loosely here only because element types live in
 * `src/generated/`, which this module must not reach into; the edge produces
 * them fully typed and the client narrows them at the parse boundary.
 */
export interface EmbedMapFrameData {
  conflicts?: readonly unknown[];
  earthquakes?: readonly unknown[];
  naturalEvents?: readonly unknown[];
  protests?: readonly unknown[];
  weatherAlerts?: readonly unknown[];
}

export interface EmbedMapFrameResponse {
  /** Which policy produced this body — the client does not infer it. */
  tier: 'free' | 'keyed';
  /** Poll interval for this tier, so the cadence is server-owned. */
  refreshMs: number;
  generatedAt: number;
  /**
   * State for every layer the caller asked for, entitled or not. A partial
   * upstream failure ships here as data rather than failing the whole frame:
   * a wall display showing three of four layers beats a blank one.
   */
  layers: Partial<Record<EmbedLayerId, EmbedMapFrameLayerState>>;
  data: EmbedMapFrameData;
}

// ---------------------------------------------------------------------------
// Shared-cache contract
//
// Two bodies on one path is a shared-cache correctness problem, and #5386 is
// the incident: a warm edge entry can answer a request before the origin ever
// sees its headers, so `Vary` on a credential header is not a boundary. The
// marker therefore lives in the URL, and the accepted public query is an EXACT
// raw-string match rather than a permissive parse — the CDN key space has to
// be an enumerable set, not "whatever a caller happened to send".
//
// The builder and the validator live together, the way `addPublicSharedRpcMarker`
// sits beside `isPublicSharedRpcRequest`, so a URL this repo emits and a URL
// this repo will shared-cache cannot drift apart.
// ---------------------------------------------------------------------------

/** Registry order, so one requested set has exactly one cacheable spelling. */
const LAYER_RANK = new Map<EmbedLayerId, number>(
  EMBED_LAYER_IDS.map((id, index) => [id, index]),
);

export function canonicalizeEmbedLayers(
  ids: readonly EmbedLayerId[],
): EmbedLayerId[] {
  return [...new Set(ids)].sort(
    (a, b) => (LAYER_RANK.get(a) ?? 0) - (LAYER_RANK.get(b) ?? 0),
  );
}

/**
 * The one shared-cacheable query for a given free-layer set (no leading `?`).
 *
 * Throws rather than emitting a URL the validator would reject — a silent
 * mismatch here is an uncached free tier, which is the cost this whole
 * contract exists to avoid.
 */
export function buildPublicEmbedFrameSearch(ids: readonly EmbedLayerId[]): string {
  const canonical = canonicalizeEmbedLayers(ids);
  const search = `layers=${canonical.join(',')}&public=1`;
  if (classifyPublicEmbedFrameSearch(search) === null) {
    throw new Error(`not a shared-cacheable embed frame shape: ${search}`);
  }
  return search;
}

/**
 * Exact-match the public query shape. Returns the requested free layers, or
 * null when this is not the shared-cacheable shape.
 *
 * Order- and encoding-sensitive on purpose: comparing a re-serialised
 * `URLSearchParams` would normalise `layers=conflicts%2Cweather` into
 * `layers=conflicts,weather` and quietly widen the accepted set — the same
 * reason `public-rpc-cache.ts` compares raw strings.
 *
 * The free tier has three layers, so the accepted set is its seven non-empty
 * subsets: a bounded, enumerable CDN key space.
 */
export function classifyPublicEmbedFrameSearch(
  rawSearch: string,
): EmbedLayerId[] | null {
  const search = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  const free = getEmbedPanelFreeTier('map');
  if (!free) return null;

  const parts = search.split('&');
  if (parts.length !== 2 || parts[1] !== 'public=1') return null;

  const layersPart = parts[0] ?? '';
  if (!layersPart.startsWith('layers=')) return null;
  const value = layersPart.slice('layers='.length);
  if (!value) return null;

  const requested = value.split(',');
  const freeSet = new Set<string>(free.layers);
  const seen = new Set<string>();
  for (const id of requested) {
    // Free-tier membership, not merely a valid layer id: a keyless URL naming
    // a paid layer must not become a shared-cache entry at all.
    if (!isEmbedLayerId(id) || !freeSet.has(id) || seen.has(id)) return null;
    seen.add(id);
  }

  const ids = requested as EmbedLayerId[];
  // Reject any spelling but the canonical one so the key space cannot be
  // multiplied by reordering.
  if (canonicalizeEmbedLayers(ids).join(',') !== value) return null;
  return ids;
}

/**
 * Classify a full request. Anything that is not the exact public shape returns
 * null and is served uncacheable — including a stray `?rpc=` echo, which this
 * static route does not receive today (there is no dynamic segment in
 * `api/embed/map-frame.ts`), and which would fail closed toward `no-store`
 * rather than toward a shared entry if that ever changed.
 */
export function classifyPublicEmbedFrameRequest(
  urlLike: string | URL,
  method = 'GET',
): EmbedLayerId[] | null {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return null;

  let url: URL;
  try {
    url = urlLike instanceof URL ? urlLike : new URL(urlLike, 'https://worldmonitor.invalid');
  } catch {
    return null;
  }

  const pathname = url.pathname.length > 1
    ? url.pathname.replace(/\/+$/, '')
    : url.pathname;
  if (pathname !== EMBED_MAP_FRAME_PATH) return null;

  return classifyPublicEmbedFrameSearch(url.search);
}
