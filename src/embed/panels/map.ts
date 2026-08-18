import { MapContainer, type MapContainerState } from '@/components/MapContainer';
import { EmbedDataLoader } from '@/embed/embed-data-loader';
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

export async function mountEmbedMapPanel(root: HTMLElement, params: EmbedMapState): Promise<() => void> {
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

  const loader = new EmbedDataLoader(map, params.layerIds);
  await loader.start();

  return () => {
    loader.destroy();
    map.destroy();
  };
}
