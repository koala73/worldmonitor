import type { MapLayers } from '@/types';
import type { MapView, TimeRange } from '@/components/Map';
import { LAYER_REGISTRY } from '@/config/map-layer-definitions';

// The registry is typed Record<keyof MapLayers, …>, so every layer is here; a
// hand-kept copy fell behind it and silently dropped 20 layers from deep links.
const LAYER_KEYS = Object.keys(LAYER_REGISTRY) as (keyof MapLayers)[];

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
  chokepoint?: string;
}

/**
 * True when applying this initial URL state starts an async camera move, so
 * the immediate URL sync after boot must be skipped: getCenter() would report
 * stale intermediate coordinates until the flight settles. Three cases:
 *
 *   - a lat+lon pair: applyInitialUrlState calls setCenter() only when both
 *     are present, and setCenter flies.
 *   - a bare zoom with no view preset: setZoom() animates.
 *   - a chokepoint deep link: it opens after renderer readiness.
 *
 * `view` alone never qualifies. Every renderer writes state.view
 * synchronously at the top of setView(), so the debounced read is correct,
 * and the initial Globe/SVG view is applied before the sync listener exists,
 * so those renderers need the immediate write to publish the URL at all.
 */
export function urlHasAsyncFlyTo(
  state: Pick<ParsedMapUrlState, 'view' | 'lat' | 'lon' | 'zoom' | 'chokepoint'> | null | undefined,
): boolean {
  const { view, lat, lon, zoom, chokepoint } = state ?? {};
  return (
    (lat !== undefined && lon !== undefined)
    || (!view && zoom !== undefined)
    || chokepoint !== undefined
  );
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** SearchAction and dashboard deep links share `?q=`. Cap keeps a pasted URL bounded. */
export const DASHBOARD_SEARCH_QUERY_MAX_CHARS = 200;

export function readDashboardSearchQuery(search: string): string | null {
  const raw = new URLSearchParams(search).get('q');
  if (raw == null) return null;
  const query = raw.trim();
  if (!query) return null;
  return query.length > DASHBOARD_SEARCH_QUERY_MAX_CHARS
    ? query.slice(0, DASHBOARD_SEARCH_QUERY_MAX_CHARS)
    : query;
}

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

  // Chokepoint deep-link (?chokepoint=bab_el_mandeb): opens the waterway popup on
  // the live map. Value is a canonical chokepoint/waterway id (lowercase, snake).
  // The map resolves it against STRATEGIC_WATERWAYS and no-ops on an unknown id,
  // so this only needs to reject obviously malformed input.
  const chokepointParam = params.get('chokepoint');
  const chokepoint = chokepointParam && /^[a-z][a-z0-9_]{1,40}$/i.test(chokepointParam.trim())
    ? chokepointParam.trim().toLowerCase()
    : undefined;

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
    chokepoint,
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
    chokepoint?: string;
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

  if (state.center && Number.isFinite(state.center.lat) && Number.isFinite(state.center.lon)) {
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

  if (state.chokepoint) {
    params.set('chokepoint', state.chokepoint);
  }

  url.search = params.toString();
  return url.toString();
}

/**
 * The map URL sync owns the query string, not the fragment. Another surface
 * (Clerk's hash-routed sign-up resume) can be routing on `location.hash`.
 */
export function withUrlFragment(url: string, hash: string): string {
  const next = new URL(url);
  next.hash = hash;
  return next.toString();
}

/**
 * Layer sets are variant-specific. A same-origin variant switch reloads the
 * page, so the previous variant's `layers` param must not become a deep link
 * that overrides the next variant's defaults.
 */
export function withoutVariantScopedUrlState(url: string): string {
  const next = new URL(url);
  next.searchParams.delete('layers');
  return next.toString();
}

/**
 * Satellite pass share links put the place in the fragment, which browsers never send to a
 * server: `#orbital=48.86,2.29` or, with a selected pass, `#orbital=48.86,2.29;40697-202611131230`
 * (NORAD id and closest-approach minute, UTC). Coordinates are rounded to 0.01 degrees.
 * `&view=full` opens the full-screen view instead of the side sheet.
 */
export const ORBITAL_SHARE_KEY = 'orbital';
const ORBITAL_VIEW_KEY = 'view';

export type OrbitalShareView = 'sheet' | 'full';

export interface OrbitalSharePass {
  noradId: number;
  /** Closest approach, floored to the UTC minute. */
  minuteMs: number;
}

export interface OrbitalShareLink {
  point: { lat: number; lon: number };
  pass: OrbitalSharePass | null;
  view: OrbitalShareView;
}

const SHARE_VALUE_RE = /^(-?\d{1,2}(?:\.\d{1,2})?),(-?\d{1,3}(?:\.\d{1,2})?)(?:;(\d{1,9})-(\d{12}))?$/;
const MINUTE_MS = 60_000;

/** Rounds to the 0.01-degree grid share links use, without a "-0". */
export function roundShareCoordinate(value: number): number {
  return Math.round(value * 100) / 100 || 0;
}

function formatShareMinute(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

function parseShareMinute(stamp: string): number | null {
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:00Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && formatShareMinute(ms) === stamp ? ms : null;
}

export function buildOrbitalShareFragment(
  point: { lat: number; lon: number },
  pass?: { noradId: number; timeMs: number } | null,
  view: OrbitalShareView = 'sheet',
): string {
  const coords = `${roundShareCoordinate(point.lat).toFixed(2)},${roundShareCoordinate(point.lon).toFixed(2)}`;
  const value = `${ORBITAL_SHARE_KEY}=${pass ? `${coords};${pass.noradId}-${formatShareMinute(pass.timeMs)}` : coords}`;
  return view === 'full' ? `${value}&${ORBITAL_VIEW_KEY}=full` : value;
}

/** The share link in a `location.hash`, or null when it is absent or malformed. */
export function parseOrbitalShareFragment(hash: string): OrbitalShareLink | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment.includes(`${ORBITAL_SHARE_KEY}=`)) return null;
  const params = new URLSearchParams(fragment);
  const match = SHARE_VALUE_RE.exec(params.get(ORBITAL_SHARE_KEY) ?? '');
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let pass: OrbitalSharePass | null = null;
  if (match[3] && match[4]) {
    const minuteMs = parseShareMinute(match[4]);
    if (minuteMs === null) return null;
    pass = { noradId: Number(match[3]), minuteMs };
  }
  return { point: { lat, lon }, pass, view: params.get(ORBITAL_VIEW_KEY) === 'full' ? 'full' : 'sheet' };
}

/** `hash` without the share key, keeping anything else another surface routes on. */
export function withoutOrbitalShareFragment(hash: string): string {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment.includes(`${ORBITAL_SHARE_KEY}=`)) return fragment;
  const params = new URLSearchParams(fragment);
  params.delete(ORBITAL_SHARE_KEY);
  params.delete(ORBITAL_VIEW_KEY);
  return params.toString();
}
