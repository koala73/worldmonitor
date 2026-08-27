/**
 * Click routing for the global-view webcam ScatterplotLayer (#3877).
 *
 * The layer mixes individual cameras (`WebcamEntry`) with server-side clusters
 * (`WebcamCluster`). Leaf clicks must open the public stream in a new tab and
 * consume the deck.gl pick so the MapboxOverlay `onClick` does not double-fire.
 * Cluster clicks must never spawn N tabs — callers zoom/expand instead.
 *
 * Discriminate on the `_kind` tag stamped at `setWebcams` ingestion, with a
 * `'count' in obj` fallback for untagged objects. Do not cast a cluster to a
 * leaf: `webcamId` is undefined on clusters and would fetch/open garbage.
 */

export interface WebcamLeafLike {
  _kind?: 'webcam';
  webcamId: string;
  title: string;
  lat: number;
  lng: number;
  category: string;
  country: string;
}

export interface WebcamClusterLike {
  _kind?: 'webcam-cluster';
  lat: number;
  lng: number;
  count: number;
}

export const WEBCAM_STREAM_OPEN_FEATURES = 'noopener,noreferrer';

export type OpenWindowFn = (url: string, target?: string, features?: string) => unknown;

export function isWebcamClusterMarker(obj: unknown): obj is WebcamClusterLike {
  if (obj === null || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>;
  if (rec._kind === 'webcam-cluster') return true;
  if (rec._kind === 'webcam') return false;
  return typeof rec.count === 'number' && typeof rec.webcamId !== 'string';
}

export function isWebcamLeafMarker(obj: unknown): obj is WebcamLeafLike {
  if (obj === null || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>;
  if (rec._kind === 'webcam') return typeof rec.webcamId === 'string';
  if (rec._kind === 'webcam-cluster') return false;
  return typeof rec.webcamId === 'string' && typeof rec.count !== 'number';
}

export function resolveWebcamStreamUrl(
  webcam: Pick<WebcamLeafLike, 'webcamId'>,
  image?: { playerUrl?: string; windyUrl?: string } | null,
): string | null {
  const fromImage = (image?.windyUrl || '').trim();
  if (fromImage) return fromImage;
  const id = webcam.webcamId?.trim();
  if (!id) return null;
  return `https://www.windy.com/webcams/${encodeURIComponent(id)}`;
}

export function openWebcamStreamInNewTab(
  url: string | null | undefined,
  openWindow: OpenWindowFn | undefined = defaultOpenWindow(),
): boolean {
  if (!url || !openWindow) return false;
  openWindow(url, '_blank', WEBCAM_STREAM_OPEN_FEATURES);
  return true;
}

export type WebcamLayerClickKind = 'leaf' | 'cluster' | 'none';

export function webcamLayerClickKind(obj: unknown): WebcamLayerClickKind {
  if (isWebcamClusterMarker(obj)) return 'cluster';
  if (isWebcamLeafMarker(obj)) return 'leaf';
  return 'none';
}

export interface WebcamLayerClickHandlers {
  openWindow?: OpenWindowFn;
  onLeaf: (webcam: WebcamLeafLike) => void;
  onCluster: (cluster: WebcamClusterLike) => void;
}

/**
 * Route a webcam-layer pick. Returns true when the event was consumed so the
 * caller can `return true` from the layer `onClick` (same contract as the
 * energy pipeline / storage layer handlers).
 */
export function dispatchWebcamLayerClick(
  obj: unknown,
  handlers: WebcamLayerClickHandlers,
): boolean {
  if (isWebcamClusterMarker(obj)) {
    handlers.onCluster(obj);
    return true;
  }
  if (isWebcamLeafMarker(obj)) {
    openWebcamStreamInNewTab(resolveWebcamStreamUrl(obj), handlers.openWindow ?? defaultOpenWindow());
    handlers.onLeaf(obj);
    return true;
  }
  return false;
}

function defaultOpenWindow(): OpenWindowFn | undefined {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return undefined;
  return (url, target, features) => window.open(url, target, features);
}
