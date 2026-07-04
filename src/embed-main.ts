import './styles/base-layer.css';
import './styles/happy-theme.css';
import './styles/embed.css';
import { MapContainer, type MapContainerState } from '@/components/MapContainer';
import { initI18n } from '@/services/i18n';
import { EmbedDataLoader } from '@/embed/embed-data-loader';
import {
  buildWorldMonitorAttributionUrl,
  parseEmbedParams,
} from '@/embed/embed-url';

function getReferrerHost(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).host || null;
  } catch {
    return null;
  }
}

function mountError(root: HTMLElement, message: string): void {
  root.textContent = '';
  const error = document.createElement('div');
  error.className = 'wm-embed-error';
  error.textContent = message;
  root.appendChild(error);
}

async function bootEmbed(): Promise<void> {
  const root = document.getElementById('embedRoot');
  if (!root) return;

  try {
    const params = parseEmbedParams(window.location.search);
    document.documentElement.dataset.theme = params.theme;
    document.documentElement.dataset.variant = params.variant;
    document.body.dataset.embedReady = 'false';

    await initI18n();

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
    document.body.dataset.embedReady = 'true';
    window.addEventListener('pagehide', () => {
      loader.destroy();
      map.destroy();
    }, { once: true });
  } catch (error) {
    console.error('[embed] Failed to boot map:', error);
    mountError(root, 'World Monitor map embed could not load.');
    document.body.dataset.embedReady = 'error';
  }
}

void bootEmbed();
