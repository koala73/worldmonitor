import type { MapLayers } from '@/types';

export const EMBEDDABLE_LAYERS = [
  { id: 'conflicts', mapLayer: 'conflicts', label: 'Conflicts' },
  { id: 'earthquakes', mapLayer: 'natural', label: 'Earthquakes' },
  { id: 'protests', mapLayer: 'protests', label: 'Protests' },
  { id: 'weather', mapLayer: 'weather', label: 'Weather' },
  { id: 'cables', mapLayer: 'cables', label: 'Undersea Cables' },
  { id: 'pipelines', mapLayer: 'pipelines', label: 'Pipelines' },
  { id: 'waterways', mapLayer: 'waterways', label: 'Chokepoints' },
  { id: 'tradeRoutes', mapLayer: 'tradeRoutes', label: 'Trade Routes' },
  { id: 'economic', mapLayer: 'economic', label: 'Economic Centers' },
  { id: 'stockExchanges', mapLayer: 'stockExchanges', label: 'Stock Exchanges' },
  { id: 'financialCenters', mapLayer: 'financialCenters', label: 'Financial Centers' },
  { id: 'centralBanks', mapLayer: 'centralBanks', label: 'Central Banks' },
  { id: 'commodityHubs', mapLayer: 'commodityHubs', label: 'Commodity Hubs' },
  { id: 'gulfInvestments', mapLayer: 'gulfInvestments', label: 'GCC Investments' },
] as const;

export type EmbedLayerId = typeof EMBEDDABLE_LAYERS[number]['id'];
export type EmbedTheme = 'dark' | 'light';
export type EmbedVariant = 'full' | 'tech' | 'finance' | 'commodity' | 'happy' | 'energy';

export interface EmbedCenter {
  lat: number;
  lon: number;
}

export interface EmbedMapState {
  layers: MapLayers;
  layerIds: EmbedLayerId[];
  center: EmbedCenter;
  zoom: number;
  theme: EmbedTheme;
  variant: EmbedVariant;
}

export const DEFAULT_EMBED_LAYER_IDS: EmbedLayerId[] = ['conflicts', 'earthquakes', 'weather'];
export const DEFAULT_EMBED_CENTER: EmbedCenter = { lat: 20, lon: 0 };
export const DEFAULT_EMBED_ZOOM = 1;
export const DEFAULT_EMBED_THEME: EmbedTheme = 'dark';
export const DEFAULT_EMBED_VARIANT: EmbedVariant = 'full';

const EMBED_LAYER_BY_ID = new Map<string, (typeof EMBEDDABLE_LAYERS)[number]>(
  EMBEDDABLE_LAYERS.map((layer) => [layer.id.toLowerCase(), layer]),
);

const EMBED_LAYER_ALIASES = new Map<string, EmbedLayerId>(([
  ['natural', 'earthquakes'],
  ['earthquake', 'earthquakes'],
  ['conflict', 'conflicts'],
  ['protest', 'protests'],
  ['cable', 'cables'],
  ['pipeline', 'pipelines'],
  ['chokepoints', 'waterways'],
  ['chokepoint', 'waterways'],
  ['waterway', 'waterways'],
  ['trade-routes', 'tradeRoutes'],
  ['trade-routes-layer', 'tradeRoutes'],
  ['tradeRoute', 'tradeRoutes'],
  ['trade-route', 'tradeRoutes'],
  ['economy', 'economic'],
  ['stock-exchanges', 'stockExchanges'],
  ['stockExchange', 'stockExchanges'],
  ['stock-exchange', 'stockExchanges'],
  ['financial-centers', 'financialCenters'],
  ['financialCenter', 'financialCenters'],
  ['financial-center', 'financialCenters'],
  ['central-banks', 'centralBanks'],
  ['centralBank', 'centralBanks'],
  ['central-bank', 'centralBanks'],
  ['commodity-hubs', 'commodityHubs'],
  ['commodityHub', 'commodityHubs'],
  ['commodity-hub', 'commodityHubs'],
  ['gcc-investments', 'gulfInvestments'],
  ['gulf-investments', 'gulfInvestments'],
  ['gulfInvestment', 'gulfInvestments'],
  ['gulf-investment', 'gulfInvestments'],
] as const).map(([alias, id]) => [alias.toLowerCase(), id]));

const VALID_THEMES = new Set<EmbedTheme>(['dark', 'light']);
const VALID_VARIANTS = new Set<EmbedVariant>(['full', 'tech', 'finance', 'commodity', 'happy', 'energy']);

export function createBlankMapLayers(): MapLayers {
  return {
    conflicts: false,
    bases: false,
    cables: false,
    pipelines: false,
    hotspots: false,
    ais: false,
    nuclear: false,
    irradiators: false,
    radiationWatch: false,
    sanctions: false,
    weather: false,
    economic: false,
    waterways: false,
    outages: false,
    cyberThreats: false,
    datacenters: false,
    protests: false,
    flights: false,
    military: false,
    natural: false,
    spaceports: false,
    minerals: false,
    fires: false,
    ucdpEvents: false,
    displacement: false,
    climate: false,
    startupHubs: false,
    cloudRegions: false,
    accelerators: false,
    techHQs: false,
    techEvents: false,
    stockExchanges: false,
    financialCenters: false,
    centralBanks: false,
    commodityHubs: false,
    gulfInvestments: false,
    positiveEvents: false,
    kindness: false,
    happiness: false,
    speciesRecovery: false,
    renewableInstallations: false,
    tradeRoutes: false,
    iranAttacks: false,
    gpsJamming: false,
    satellites: false,
    ciiChoropleth: false,
    resilienceScore: false,
    dayNight: false,
    miningSites: false,
    processingPlants: false,
    commodityPorts: false,
    webcams: false,
    diseaseOutbreaks: false,
    storageFacilities: false,
    fuelShortages: false,
    liveTankers: false,
  };
}

export function mapLayersFromEmbedIds(layerIds: readonly EmbedLayerId[]): MapLayers {
  const layers = createBlankMapLayers();
  for (const id of layerIds) {
    const layer = EMBED_LAYER_BY_ID.get(id.toLowerCase());
    if (layer) layers[layer.mapLayer] = true;
  }
  return layers;
}

export function parseEmbedLayerIds(value: string | null): EmbedLayerId[] {
  if (value === null) return [...DEFAULT_EMBED_LAYER_IDS];
  const seen = new Set<EmbedLayerId>();
  for (const rawPart of value.split(',')) {
    const normalized = rawPart.trim().toLowerCase();
    if (!normalized || normalized === 'none') continue;
    const id = EMBED_LAYER_BY_ID.get(normalized)?.id ?? EMBED_LAYER_ALIASES.get(normalized);
    if (id) seen.add(id);
  }
  return [...seen];
}

function parseCenter(value: string | null): EmbedCenter {
  if (!value) return { ...DEFAULT_EMBED_CENTER };
  const parts = value.split(',');
  const latRaw = Number(parts[0]?.trim());
  const lonRaw = Number(parts[1]?.trim());
  if (!Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) return { ...DEFAULT_EMBED_CENTER };
  return {
    lat: clamp(latRaw, -90, 90),
    lon: clamp(lonRaw, -180, 180),
  };
}

function parseZoom(value: string | null): number {
  if (!value) return DEFAULT_EMBED_ZOOM;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_EMBED_ZOOM;
  return clamp(parsed, 1, 10);
}

function parseTheme(value: string | null): EmbedTheme {
  return VALID_THEMES.has(value as EmbedTheme) ? value as EmbedTheme : DEFAULT_EMBED_THEME;
}

function parseVariant(value: string | null): EmbedVariant {
  return VALID_VARIANTS.has(value as EmbedVariant) ? value as EmbedVariant : DEFAULT_EMBED_VARIANT;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeCenter(center: EmbedCenter | null | undefined): EmbedCenter {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
    return { ...DEFAULT_EMBED_CENTER };
  }
  return {
    lat: clamp(center.lat, -90, 90),
    lon: clamp(center.lon, -180, 180),
  };
}

export function parseEmbedParams(search: string | URLSearchParams): EmbedMapState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const layerIds = parseEmbedLayerIds(params.get('layers'));
  return {
    layers: mapLayersFromEmbedIds(layerIds),
    layerIds,
    center: parseCenter(params.get('center')),
    zoom: parseZoom(params.get('zoom')),
    theme: parseTheme(params.get('theme')),
    variant: parseVariant(params.get('variant')),
  };
}

export function buildEmbedMapUrl(
  baseUrl: string,
  state: {
    layerIds?: readonly EmbedLayerId[];
    layers?: MapLayers;
    center?: EmbedCenter | null;
    zoom?: number;
    theme?: EmbedTheme;
    variant?: EmbedVariant;
  } = {},
): string {
  const url = new URL(baseUrl, 'https://www.worldmonitor.app');
  const layerIds = state.layerIds ?? embedLayerIdsFromMapLayers(state.layers ?? mapLayersFromEmbedIds(DEFAULT_EMBED_LAYER_IDS));
  const center = normalizeCenter(state.center ?? DEFAULT_EMBED_CENTER);
  const zoom = Number.isFinite(state.zoom) ? clamp(state.zoom as number, 1, 10) : DEFAULT_EMBED_ZOOM;
  const theme = VALID_THEMES.has(state.theme as EmbedTheme) ? state.theme as EmbedTheme : DEFAULT_EMBED_THEME;
  const variant = VALID_VARIANTS.has(state.variant as EmbedVariant) ? state.variant as EmbedVariant : DEFAULT_EMBED_VARIANT;

  url.search = '';
  url.searchParams.set('layers', [...new Set(layerIds)].join(','));
  url.searchParams.set('center', `${roundCoord(center.lat)},${roundCoord(center.lon)}`);
  url.searchParams.set('zoom', roundZoom(zoom));
  url.searchParams.set('theme', theme);
  url.searchParams.set('variant', variant);
  return url.toString();
}

export function embedLayerIdsFromMapLayers(layers: MapLayers): EmbedLayerId[] {
  return EMBEDDABLE_LAYERS
    .filter((layer) => layers[layer.mapLayer])
    .map((layer) => layer.id);
}

export function buildEmbedIframeSnippet(url: string, options: { width?: string; height?: string } = {}): string {
  const width = sanitizeCssDimension(options.width ?? '100%');
  const height = sanitizePixelDimension(options.height ?? '420', 120, 1200);
  return `<iframe src="${escapeAttribute(url)}" title="World Monitor live map" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" style="width:${width};height:${height}px;border:0;display:block" allowfullscreen></iframe>`;
}

export function buildWorldMonitorAttributionUrl(baseUrl: string, referrerHost: string | null): string {
  const url = new URL(baseUrl, 'https://www.worldmonitor.app');
  url.searchParams.set('utm_source', 'embed');
  url.searchParams.set('utm_medium', 'iframe');
  url.searchParams.set('utm_campaign', referrerHost ? referrerHost.slice(0, 80) : 'direct');
  return url.toString();
}

function roundCoord(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function roundZoom(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function sanitizeCssDimension(value: string): string {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?%$/.test(trimmed)) return trimmed;
  return `${sanitizePixelDimension(trimmed, 120, 1200)}px`;
}

function sanitizePixelDimension(value: string, min: number, max: number): string {
  const numeric = Number(value.trim().replace(/px$/i, ''));
  if (!Number.isFinite(numeric)) return '420';
  return String(Math.max(min, Math.min(max, Math.round(numeric))));
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
