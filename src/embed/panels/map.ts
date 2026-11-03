import { MapContainer, type MapContainerState } from '@/components/MapContainer';
import { EmbedDataLoader } from '@/embed/embed-data-loader';
import { mintEmbedGrant } from '@/embed/embed-fetch';
import {
  buildWorldMonitorAttributionUrl,
  type EmbedMapState,
} from '@/embed/embed-url';

function getReferrerHost(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).host || null;
  } catch {
    return null;
  }
}

/**
 * Mounts the map at the free tier immediately, then upgrades in place if the
 * parent supplies a credential.
 *
 * Deliberately does NOT await the credential handshake before painting: a
 * keyless embed is a growth surface, and blocking first paint on a
 * postMessage that will never arrive would cost every one of them the full
 * handshake timeout.
 */
export async function mountEmbedMapPanel(
  root: HTMLElement,
  params: EmbedMapState,
  apiKeyPromise: Promise<string | null> = Promise.resolve(null),
): Promise<() => void> {
  const mapMount = document.createElement('div');
  mapMount.className = 'wm-embed-map';
  root.appendChild(mapMount);

  const initialState: MapContainerState = {
    zoom: params.zoom,
    pan: { x: 0, y: 0 },
    view: 'global',
    layers: params.layers,
    timeRange: '7d',
  };
  const map = new MapContainer(mapMount, initialState, false, { chrome: false });

  window.requestAnimationFrame(() => {
    map.setCenter(params.center.lat, params.center.lon, params.zoom);
  });

  const attribution = document.createElement('a');
  attribution.className = 'wm-embed-attribution';
  attribution.href = buildWorldMonitorAttributionUrl(new URL('/dashboard', window.location.origin).toString(), getReferrerHost());
  attribution.target = '_blank';
  attribution.rel = 'noopener noreferrer';
  attribution.textContent = 'Live map by World Monitor';
  root.appendChild(attribution);

  // Resolved once and reused for every re-mint, so an expiring grant does not
  // re-run the parent handshake.
  let embeddingApiKey: string | null = null;
  const loader = new EmbedDataLoader(map, params.layerIds, {
    renewGrant: async () => (
      embeddingApiKey
        ? mintEmbedGrant('map', embeddingApiKey)
        : { status: 'denied' as const }
    ),
  });
  await loader.start();

  void (async () => {
    embeddingApiKey = await apiKeyPromise;
    if (!embeddingApiKey) return;
    await loader.requestGrant();
  })();

  return () => {
    loader.destroy();
    map.destroy();
  };
}
