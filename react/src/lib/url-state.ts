/** React-safe map URL contract (mirrors vanilla urlState.ts). */

export type MapView =
  | 'global'
  | 'america'
  | 'mena'
  | 'eu'
  | 'asia'
  | 'latam'
  | 'africa'
  | 'oceania';

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';

export const LAYER_KEYS = [
  'conflicts',
  'bases',
  'cables',
  'pipelines',
  'hotspots',
  'convoHotspots',
  'aiUsage',
  'aiPolicy',
  'ais',
  'nuclear',
  'irradiators',
  'sanctions',
  'weather',
  'economic',
  'waterways',
  'outages',
  'cyberThreats',
  'datacenters',
  'protests',
  'flights',
  'military',
  'natural',
  'spaceports',
  'minerals',
  'fires',
  'ucdpEvents',
  'displacement',
  'tradeRoutes',
  'iranAttacks',
  'satellites',
  'ciiChoropleth',
  'resilienceScore',
  'stockExchanges',
  'financialCenters',
  'centralBanks',
  'commodityHubs',
  'commodityPorts',
  'gulfInvestments',
  'startupHubs',
  'techHQs',
  'techEvents',
  'cloudRegions',
  'accelerators',
  'storageFacilities',
  'fuelShortages',
  'liveTankers',
  'webcams',
  'positiveEvents',
  'kindness',
  'happiness',
  'speciesRecovery',
  'renewableInstallations',
] as const;

export type LayerKey = (typeof LAYER_KEYS)[number];
export type LayerMap = Record<LayerKey, boolean>;

export const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '48h', '7d', 'all'];
export const VIEW_VALUES: MapView[] = [
  'global',
  'america',
  'mena',
  'eu',
  'asia',
  'latam',
  'africa',
  'oceania',
];

/** DeckGLMap VIEW_PRESETS — lon/lat/zoom. */
export const VIEW_PRESETS: Record<MapView, { lon: number; lat: number; zoom: number }> = {
  global: { lon: 0, lat: 20, zoom: 1.5 },
  america: { lon: -95, lat: 38, zoom: 3 },
  mena: { lon: 45, lat: 28, zoom: 3.5 },
  eu: { lon: 15, lat: 50, zoom: 3.5 },
  asia: { lon: 105, lat: 35, zoom: 3 },
  latam: { lon: -60, lat: -15, zoom: 3 },
  africa: { lon: 20, lat: 5, zoom: 3 },
  oceania: { lon: 135, lat: -25, zoom: 3.5 },
};

export interface ParsedMapUrlState {
  view?: MapView;
  zoom?: number;
  lat?: number;
  lon?: number;
  timeRange?: TimeRange;
  /** Epoch ms playhead within the active time window; omit = live end. */
  timeFocus?: number | null;
  layers?: LayerMap;
}

export interface MapUrlState {
  view: MapView;
  zoom: number;
  lat: number;
  lon: number;
  timeRange: TimeRange;
  /** Epoch ms playhead; null = live end of the window. */
  timeFocus: number | null;
  layers: LayerMap;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function emptyLayers(on = false): LayerMap {
  return Object.fromEntries(LAYER_KEYS.map((k) => [k, on])) as LayerMap;
}

export function layersFromKeys(keys: readonly string[]): LayerMap {
  const set = new Set(keys);
  return Object.fromEntries(LAYER_KEYS.map((k) => [k, set.has(k)])) as LayerMap;
}

function parseEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = params.get(key);
  return value && allowed.includes(value as T) ? (value as T) : undefined;
}

function parseFloatParam(
  params: URLSearchParams,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = params.get(key);
  const value = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) ? clamp(value, min, max) : undefined;
}

export function parseMapUrlState(
  search: string,
  fallbackLayers: LayerMap = emptyLayers(false),
): ParsedMapUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view = parseEnum(params, 'view', VIEW_VALUES);
  const zoom = parseFloatParam(params, 'zoom', 1, 10);
  const lat = parseFloatParam(params, 'lat', -90, 90);
  const lon = parseFloatParam(params, 'lon', -180, 180);
  const timeRange = parseEnum(params, 'timeRange', TIME_RANGES);
  const timeFocusRaw = params.get('timeFocus');
  let timeFocus: number | null | undefined;
  if (timeFocusRaw != null && timeFocusRaw !== '') {
    const ms = Number.parseInt(timeFocusRaw, 10);
    timeFocus = Number.isFinite(ms) ? ms : null;
  }

  const layersParam = params.get('layers');
  let layers: LayerMap | undefined;
  if (layersParam !== null) {
    layers = { ...fallbackLayers };
    const normalized = layersParam.trim();
    if (normalized !== '' && normalized !== 'none') {
      const requested = new Set(
        normalized
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      if (requested.has('satelliteImagery')) {
        requested.delete('satelliteImagery');
        requested.add('satellites');
      }
      for (const key of LAYER_KEYS) {
        layers[key] = requested.has(key);
      }
    } else {
      for (const key of LAYER_KEYS) {
        layers[key] = false;
      }
    }
  }

  return { view, zoom, lat, lon, timeRange, timeFocus, layers };
}

export function resolveInitialState(search: string): MapUrlState {
  const parsed = parseMapUrlState(search);
  const view = parsed.view ?? 'global';
  const preset = VIEW_PRESETS[view];
  const hasCenter = parsed.lat !== undefined && parsed.lon !== undefined;
  return {
    view,
    zoom: parsed.zoom ?? preset.zoom,
    lat: hasCenter ? parsed.lat! : preset.lat,
    lon: hasCenter ? parsed.lon! : preset.lon,
    timeRange: parsed.timeRange ?? '24h',
    timeFocus: parsed.timeFocus ?? null,
    layers: parsed.layers ?? emptyLayers(false),
  };
}

export function buildMapUrl(baseUrl: string, state: MapUrlState): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    url = new URL(typeof window !== 'undefined' ? window.location.href : 'http://localhost:3020/');
  }
  const params = new URLSearchParams();
  params.set('lat', state.lat.toFixed(4));
  params.set('lon', state.lon.toFixed(4));
  params.set('zoom', state.zoom.toFixed(2));
  params.set('view', state.view);
  params.set('timeRange', state.timeRange);
  if (state.timeFocus != null) {
    params.set('timeFocus', String(state.timeFocus));
  }
  const active = LAYER_KEYS.filter((k) => state.layers[k]);
  params.set('layers', active.length > 0 ? active.join(',') : 'none');
  url.search = params.toString();
  return url.toString();
}

export function syncUrl(state: MapUrlState): void {
  if (typeof window === 'undefined') return;
  const next = buildMapUrl(window.location.href, state);
  const current = window.location.href;
  if (next !== current) {
    window.history.replaceState(null, '', next);
  }
}
