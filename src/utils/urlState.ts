import type { MapLayers } from '@/types';
import type { MapView, TimeRange } from '@/components/Map';

const LAYER_KEYS: (keyof MapLayers)[] = [
  'conflicts',
  'bases',
  'cables',
  'pipelines',
  'hotspots',
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
  'climate',
  'startupHubs',
  'cloudRegions',
  'accelerators',
  'techHQs',
  'techEvents',
  'tradeRoutes',
  'iranAttacks',
  'gpsJamming',
  'satellites',
  'ciiChoropleth',
  'resilienceScore',
];

const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '48h', '7d', 'all'];
const VIEW_VALUES: MapView[] = ['global', 'america', 'mena', 'eu', 'asia', 'latam', 'africa', 'oceania'];

export interface ParsedMapUrlState {
  view?: MapView;
  zoom?: number;
  lat?: number;
  lon?: number;
  timeRange?: TimeRange;
  layers?: MapLayers;
  country?: string;
  expanded?: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const parseEnumParam = <T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[]
): T | undefined => {
  const value = params.get(key);
  return value && allowed.includes(value as T) ? (value as T) : undefined;
};

const parseClampedFloatParam = (
  params: URLSearchParams,
  key: string,
  min: number,
  max: number
): number | undefined => {
  const rawValue = params.get(key);
  const value = rawValue ? Number.parseFloat(rawValue) : NaN;
  return Number.isFinite(value) ? clamp(value, min, max) : undefined;
};

export function parseMapUrlState(
  search: string,
  fallbackLayers: MapLayers
): ParsedMapUrlState {
  const params = new URLSearchParams(search);

  const view = parseEnumParam(params, 'view', VIEW_VALUES);
  const zoom = parseClampedFloatParam(params, 'zoom', 1, 10);
  const lat = parseClampedFloatParam(params, 'lat', -90, 90);
  const lon = parseClampedFloatParam(params, 'lon', -180, 180);
  const timeRange = parseEnumParam(params, 'timeRange', TIME_RANGES);

  const countryParam = params.get('country');
  const country = countryParam && /^[A-Z]{2}$/i.test(countryParam.trim()) ? countryParam.trim().toUpperCase() : undefined;

  const expandedParam = params.get('expanded');
  const expanded = expandedParam === '1' ? true : undefined;

  const layersParam = params.get('layers');
  let layers: MapLayers | undefined;
  if (layersParam !== null) {
    layers = { ...fallbackLayers };
    const normalizedLayers = layersParam.trim();
    if (normalizedLayers !== '' && normalizedLayers !== 'none') {
      const requested = new Set(
        normalizedLayers
          .split(',')
          .map((layer) => layer.trim())
          .filter(Boolean)
      );
      if (requested.has('satelliteImagery')) {
        requested.delete('satelliteImagery');
        requested.add('satellites');
      }
      LAYER_KEYS.forEach((key) => {
        layers![key] = requested.has(key);
      });
    } else {
      LAYER_KEYS.forEach((key) => {
        layers![key] = false;
      });
    }
  }

  return {
    view,
    zoom,
    lat,
    lon,
    timeRange,
    layers,
    country,
    expanded,
  };
}

export function buildMapUrl(
  baseUrl: string,
  state: {
    view: MapView;
    zoom: number;
    center?: { lat: number; lon: number } | null;
    timeRange: TimeRange;
    layers: MapLayers;
    country?: string;
    expanded?: boolean;
  }
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // window.location.origin can be "null" string in some in-app browsers / WebViews
    url = new URL(window.location.href);
  }
  const params = new URLSearchParams();

  if (state.center) {
    params.set('lat', state.center.lat.toFixed(4));
    params.set('lon', state.center.lon.toFixed(4));
  }

  params.set('zoom', state.zoom.toFixed(2));
  params.set('view', state.view);
  params.set('timeRange', state.timeRange);

  const activeLayers = LAYER_KEYS.filter((layer) => state.layers[layer]);
  params.set('layers', activeLayers.length > 0 ? activeLayers.join(',') : 'none');

  if (state.country) {
    params.set('country', state.country);
  }

  if (state.expanded) {
    params.set('expanded', '1');
  }

  url.search = params.toString();
  return url.toString();
}
