import 'maplibre-gl/dist/maplibre-gl.css';
import '../styles/main.css';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { DeckGLMap } from '../components/DeckGLMap';
import {
  SITE_VARIANT,
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  MILITARY_BASES,
  UNDERSEA_CABLES,
  NUCLEAR_FACILITIES,
  GAMMA_IRRADIATORS,
  PIPELINES,
  STRATEGIC_WATERWAYS,
  ECONOMIC_CENTERS,
  AI_DATA_CENTERS,
  STARTUP_HUBS,
  ACCELERATORS,
  TECH_HQS,
  CLOUD_REGIONS,
  PORTS,
  SPACEPORTS,
  APT_GROUPS,
  CRITICAL_MINERALS,
  STOCK_EXCHANGES,
  FINANCIAL_CENTERS,
  CENTRAL_BANKS,
  COMMODITY_HUBS,
} from '../config';
import type {
  AisDensityZone,
  AisDisruptionEvent,
  CableAdvisory,
  CyberThreat,
  InternetOutage,
  MapLayers,
  MilitaryFlight,
  MilitaryFlightCluster,
  MilitaryVessel,
  MilitaryVesselCluster,
  NaturalEvent,
  NewsItem,
  RepairShip,
  SocialUnrestEvent,
} from '../types';
import type { AirportDelayAlert } from '../services/aviation';
import type { Earthquake } from '../services/earthquakes';
import type { WeatherAlert } from '../services/weather';

type Scenario = 'alpha' | 'beta';
type HarnessVariant = 'full' | 'tech' | 'finance';
type HarnessLayerKey = keyof MapLayers;
type PulseProtestScenario =
  | 'none'
  | 'recent-acled-riot'
  | 'recent-gdelt-riot'
  | 'recent-protest';
type NewsPulseScenario = 'none' | 'recent' | 'stale';

type LayerSnapshot = {
  id: string;
  dataCount: number;
};

type OverlaySnapshot = {
  protestMarkers: number;
  datacenterMarkers: number;
  techEventMarkers: number;
  techHQMarkers: number;
  hotspotMarkers: number;
};

type CameraState = {
  lon: number;
  lat: number;
  zoom: number;
};

type VisualScenario = {
  id: string;
  variant: 'both' | HarnessVariant;
  enabledLayers: HarnessLayerKey[];
  camera: CameraState;
  expectedDeckLayers: string[];
  expectedSelectors: string[];
  includeNewsLocation?: boolean;
};

type VisualScenarioSummary = {
  id: string;
  variant: 'both' | HarnessVariant;
};

type MapHarness = {
  ready: boolean;
  variant: HarnessVariant;
  seedAllDynamicData: () => void;
  setProtestsScenario: (scenario: Scenario) => void;
  setPulseProtestsScenario: (scenario: PulseProtestScenario) => void;
  setNewsPulseScenario: (scenario: NewsPulseScenario) => void;
  setHotspotActivityScenario: (scenario: 'none' | 'breaking') => void;
  forcePulseStartupElapsed: () => void;
  resetPulseStartupTime: () => void;
  isPulseAnimationRunning: () => boolean;
  setZoom: (zoom: number) => void;
  setLayersForSnapshot: (enabledLayers: HarnessLayerKey[]) => void;
  setCamera: (camera: CameraState) => void;
  enableDeterministicVisualMode: () => void;
  getVisualScenarios: () => VisualScenarioSummary[];
  prepareVisualScenario: (scenarioId: string) => boolean;
  isVisualScenarioReady: (scenarioId: string) => boolean;
  getDeckLayerSnapshot: () => LayerSnapshot[];
  getLayerDataCount: (layerId: string) => number;
  getLayerFirstScreenTransform: (layerId: string) => string | null;
  getFirstProtestTitle: () => string | null;
  getProtestClusterCount: () => number;
  getOverlaySnapshot: () => OverlaySnapshot;
  getCyberTooltipHtml: (indicator: string) => string;
  destroy: () => void;
};

declare global {
  interface Window {
    __mapHarness?: MapHarness;
  }
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container for map harness');
}

app.style.width = '1280px';
app.style.height = '720px';
app.style.position = 'relative';
app.style.margin = '0 auto';

const allLayersEnabled: MapLayers = {
  conflicts: true,
  bases: true,
  cables: true,
  pipelines: true,
  hotspots: true,
  ais: true,
  nuclear: true,
  irradiators: true,
  sanctions: true,
  weather: true,
  economic: true,
  waterways: true,
  outages: true,
  cyberThreats: true,
  datacenters: true,
  protests: true,
  flights: true,
  military: true,
  natural: true,
  spaceports: true,
  minerals: true,
  fires: true,
  ucdpEvents: true,
  displacement: true,
  climate: true,
  startupHubs: true,
  cloudRegions: true,
  accelerators: true,
  techHQs: true,
  techEvents: true,
  stockExchanges: true,
  financialCenters: true,
  centralBanks: true,
  commodityHubs: true,
  gulfInvestments: true,
  positiveEvents: true,
  kindness: true,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: true,
};

const allLayersDisabled: MapLayers = {
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
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
};

const SEEDED_NEWS_LOCATIONS: Array<{
  lat: number;
  lon: number;
  title: string;
  threatLevel: string;
}> = [
  {
    lat: 48.85,
    lon: 2.35,
    title: 'Harness News Item',
    threatLevel: 'high',
  },
];

const map = new DeckGLMap(app, {
  zoom: 5,
  pan: { x: 0, y: 0 },
  view: 'global',
  layers: allLayersEnabled,
  // Keep harness deterministic regardless of wall-clock date.
  timeRange: 'all',
});

const DETERMINISTIC_BODY_CLASS = 'e2e-deterministic';

const internals = map as unknown as {
  buildLayers?: () => Array<{ id: string; props?: { data?: unknown } }>;
  maplibreMap?: MapLibreMap;
  getTooltip?: (info: { object?: unknown; layer?: { id?: string } }) => { html?: string } | null;
  newsLocationFirstSeen?: Map<string, number>;
  newsPulseIntervalId?: ReturnType<typeof setInterval> | null;
  startupTime?: number;
  stopPulseAnimation?: () => void;
};

const buildLayerState = (enabledLayers: HarnessLayerKey[]): MapLayers => {
  const next: MapLayers = { ...allLayersDisabled };
  for (const key of enabledLayers) {
    next[key] = true;
  }
  return next;
};

const setLayersForSnapshot = (enabledLayers: HarnessLayerKey[]): void => {
  map.setLayers(buildLayerState(enabledLayers));
};

const setCamera = (camera: CameraState): void => {
  const maplibreMap = internals.maplibreMap;
  if (!maplibreMap) return;
  maplibreMap.jumpTo({
    center: [camera.lon, camera.lat],
    zoom: camera.zoom,
  });
  map.render();
};

const getDataCount = (data: unknown): number => {
  if (Array.isArray(data)) return data.length;
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    (data as { type?: string }).type === 'FeatureCollection' &&
    'features' in data &&
    Array.isArray((data as { features?: unknown[] }).features)
  ) {
    return (data as { features: unknown[] }).features.length;
  }
  if (
    data &&
    typeof data === 'object' &&
    'length' in data &&
    typeof (data as { length?: unknown }).length === 'number'
  ) {
    return Number((data as { length: number }).length);
  }
  return data ? 1 : 0;
};

const getDeckLayerSnapshot = (): LayerSnapshot[] => {
  const layers = internals.buildLayers?.() ?? [];
  return layers.map((layer) => ({
    id: layer.id,
    dataCount: getDataCount(layer.props?.data),
  }));
};

const getLayerDataCount = (layerId: string): number => {
  return getDeckLayerSnapshot().find((layer) => layer.id === layerId)?.dataCount ?? 0;
};

const getLayerFirstScreenTransform = (layerId: string): string | null => {
  const maplibreMap = internals.maplibreMap;
  if (!maplibreMap) return null;

  const layers = internals.buildLayers?.() ?? [];
  const target = layers.find((layer) => layer.id === layerId);
  const data = target?.props?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0] as {
    lon?: number;
    lng?: number;
    longitude?: number;
    lat?: number;
    latitude?: number;
  };

  const lon = first.lon ?? first.lng ?? first.longitude;
  const lat = first.lat ?? first.latitude;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const point = maplibreMap.project([lon as number, lat as number]);
  return `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px)`;
};

const getFirstProtestTitle = (): string | null => {
  const layers = internals.buildLayers?.() ?? [];
  const protestLayer = layers.find((layer) => layer.id === 'protest-clusters-layer');
  const data = protestLayer?.props?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0] as { items?: Array<{ title?: string }> };
  const title = first.items?.[0]?.title;
  return typeof title === 'string' ? title : null;
};

const getProtestClusterCount = (): number => {
  return getLayerDataCount('protest-clusters-layer');
};

const getOverlaySnapshot = (): OverlaySnapshot => ({
  protestMarkers: document.querySelectorAll('.protest-marker').length,
  datacenterMarkers: document.querySelectorAll('.datacenter-marker').length,
  techEventMarkers: document.querySelectorAll('.tech-event-marker').length,
  techHQMarkers: document.querySelectorAll('.tech-hq-marker').length,
  hotspotMarkers: document.querySelectorAll('.hotspot').length,
});

const toCamera = (lon: number, lat: number, zoom: number): CameraState => ({
  lon,
  lat,
  zoom,
});

const firstLatLon = <T extends { lat: number; lon: number }>(
  items: T[],
  fallback: [number, number]
): [number, number] => {
  const first = items[0];
  if (!first) return fallback;
  return [first.lon, first.lat];
};

const firstPathPoint = <T extends { points: [number, number][] }>(
  items: T[],
  fallback: [number, number]
): [number, number] => {
  const firstPoint = items[0]?.points?.[0];
  if (!firstPoint || firstPoint.length < 2) return fallback;
  return [firstPoint[0], firstPoint[1]];
};

const firstConflictPoint = (fallback: [number, number]): [number, number] => {
  const coords = CONFLICT_ZONES[0]?.coords?.[0];
  if (!coords || coords.length < 2) return fallback;
  return [coords[0], coords[1]];
};

const seededCameras = {
  ais: toCamera(55.0, 25.0, 5.2),
  weather: toCamera(-80.2, 25.7, 5.2),
  outages: toCamera(-0.1, 51.5, 5.2),
  cyber: toCamera(-0.12, 51.5, 5.2),
  protests: toCamera(0.2, 20.1, 5.2),
  flights: toCamera(-73.9, 40.4, 5.2),
  military: toCamera(56.3, 26.1, 5.2),
  natural: toCamera(-118.2, 34.1, 4.8),
  fires: toCamera(-60.1, -5.4, 5.0),
  techEvents: toCamera(-122.42, 37.77, 5.2),
  news: toCamera(2.35, 48.85, 5.0),
};

const [conflictLon, conflictLat] = firstConflictPoint([36.0, 35.0]);
const [baseLon, baseLat] = firstLatLon(MILITARY_BASES, [44.0, 33.0]);
const [cableLon, cableLat] = firstPathPoint(UNDERSEA_CABLES, [38.0, 20.0]);
const [pipelineLon, pipelineLat] = firstPathPoint(PIPELINES, [45.0, 30.0]);
const [hotspotLon, hotspotLat] = firstLatLon(INTEL_HOTSPOTS, [0.0, 20.0]);
const [nuclearLon, nuclearLat] = firstLatLon(NUCLEAR_FACILITIES, [14.0, 50.0]);
const [irradiatorLon, irradiatorLat] = firstLatLon(GAMMA_IRRADIATORS, [12.0, 50.0]);
const [waterwayLon, waterwayLat] = firstLatLon(STRATEGIC_WATERWAYS, [32.0, 30.0]);
const [economicLon, economicLat] = firstLatLon(ECONOMIC_CENTERS, [-74.0, 40.7]);
const [datacenterLon, datacenterLat] = firstLatLon(AI_DATA_CENTERS, [-121.9, 37.3]);
const [spaceportLon, spaceportLat] = firstLatLon(SPACEPORTS, [-80.6, 28.6]);
const [mineralLon, mineralLat] = firstLatLon(CRITICAL_MINERALS, [135.0, -27.0]);
const [startupLon, startupLat] = firstLatLon(STARTUP_HUBS, [-122.08, 37.38]);
const [acceleratorLon, acceleratorLat] = firstLatLon(ACCELERATORS, [-122.41, 37.77]);
const [techHQLon, techHQLat] = firstLatLon(TECH_HQS, [-122.0, 37.3]);
const [cloudRegionLon, cloudRegionLat] = firstLatLon(CLOUD_REGIONS, [-122.3, 37.6]);
const [aptLon, aptLat] = firstLatLon(APT_GROUPS, [116.4, 39.9]);
const [portLon, portLat] = firstLatLon(PORTS, [32.5, 29.9]);
const [exchangeLon, exchangeLat] = firstLatLon(STOCK_EXCHANGES, [-74.0, 40.7]);
const [financialCenterLon, financialCenterLat] = firstLatLon(FINANCIAL_CENTERS, [-74.0, 40.7]);
const [centralBankLon, centralBankLat] = firstLatLon(CENTRAL_BANKS, [-77.0, 38.9]);
const [commodityHubLon, commodityHubLat] = firstLatLon(COMMODITY_HUBS, [-87.6, 41.8]);

const VISUAL_SCENARIOS: VisualScenario[] = [
  {
    id: 'conflicts-z4',
    variant: 'both',
    enabledLayers: ['conflicts'],
    camera: toCamera(conflictLon, conflictLat, 4.0),
    expectedDeckLayers: ['conflict-zones-layer'],
    expectedSelectors: [],
  },
  {
    id: 'bases-z5',
    variant: 'both',
    enabledLayers: ['bases'],
    camera: toCamera(baseLon, baseLat, 5.2),
    expectedDeckLayers: ['bases-layer'],
    expectedSelectors: [],
  },
  {
    id: 'cables-z4',
    variant: 'both',
    enabledLayers: ['cables'],
    camera: toCamera(cableLon, cableLat, 4.2),
    expectedDeckLayers: ['cables-layer', 'cable-advisories-layer', 'repair-ships-layer'],
    expectedSelectors: [],
  },
  {
    id: 'pipelines-z4',
    variant: 'both',
    enabledLayers: ['pipelines'],
    camera: toCamera(pipelineLon, pipelineLat, 4.2),
    expectedDeckLayers: ['pipelines-layer'],
    expectedSelectors: [],
  },
  {
    id: 'hotspots-z4',
    variant: 'both',
    enabledLayers: ['hotspots'],
    camera: toCamera(hotspotLon, hotspotLat, 4.2),
    expectedDeckLayers: ['hotspots-layer'],
    expectedSelectors: [],
  },
  {
    id: 'ais-z5',
    variant: 'both',
    enabledLayers: ['ais'],
    camera: seededCameras.ais,
    expectedDeckLayers: ['ais-density-layer', 'ais-disruptions-layer', 'ports-layer'],
    expectedSelectors: [],
  },
  {
    id: 'ports-z5',
    variant: 'both',
    enabledLayers: ['ais'],
    camera: toCamera(portLon, portLat, 5.2),
    expectedDeckLayers: ['ports-layer'],
    expectedSelectors: [],
  },
  {
    id: 'nuclear-z5',
    variant: 'both',
    enabledLayers: ['nuclear'],
    camera: toCamera(nuclearLon, nuclearLat, 5.2),
    expectedDeckLayers: ['nuclear-layer'],
    expectedSelectors: [],
  },
  {
    id: 'irradiators-z5',
    variant: 'both',
    enabledLayers: ['irradiators'],
    camera: toCamera(irradiatorLon, irradiatorLat, 5.2),
    expectedDeckLayers: ['irradiators-layer'],
    expectedSelectors: [],
  },
  {
    id: 'weather-z5',
    variant: 'both',
    enabledLayers: ['weather'],
    camera: seededCameras.weather,
    expectedDeckLayers: ['weather-layer'],
    expectedSelectors: [],
  },
  {
    id: 'economic-z5',
    variant: 'both',
    enabledLayers: ['economic'],
    camera: toCamera(economicLon, economicLat, 5.1),
    expectedDeckLayers: ['economic-centers-layer'],
    expectedSelectors: [],
  },
  {
    id: 'waterways-z5',
    variant: 'both',
    enabledLayers: ['waterways'],
    camera: toCamera(waterwayLon, waterwayLat, 5.1),
    expectedDeckLayers: ['waterways-layer'],
    expectedSelectors: [],
  },
  {
    id: 'outages-z5',
    variant: 'both',
    enabledLayers: ['outages'],
    camera: seededCameras.outages,
    expectedDeckLayers: ['outages-layer'],
    expectedSelectors: [],
  },
  {
    id: 'cyber-z5',
    variant: 'both',
    enabledLayers: ['cyberThreats'],
    camera: seededCameras.cyber,
    expectedDeckLayers: ['cyber-threats-layer'],
    expectedSelectors: [],
  },
  {
    id: 'datacenters-cluster-z3',
    variant: 'both',
    enabledLayers: ['datacenters'],
    camera: toCamera(datacenterLon, datacenterLat, 3.0),
    expectedDeckLayers: ['datacenter-clusters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'datacenters-icons-z6',
    variant: 'both',
    enabledLayers: ['datacenters'],
    camera: toCamera(datacenterLon, datacenterLat, 6.0),
    expectedDeckLayers: ['datacenters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'protests-z5',
    variant: 'both',
    enabledLayers: ['protests'],
    camera: seededCameras.protests,
    expectedDeckLayers: ['protest-clusters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'flights-z5',
    variant: 'both',
    enabledLayers: ['flights'],
    camera: seededCameras.flights,
    expectedDeckLayers: ['flight-delays-layer'],
    expectedSelectors: [],
  },
  {
    id: 'military-z5',
    variant: 'both',
    enabledLayers: ['military'],
    camera: seededCameras.military,
    expectedDeckLayers: [
      'military-vessels-layer',
      'military-vessel-clusters-layer',
      'military-flights-layer',
      'military-flight-clusters-layer',
    ],
    expectedSelectors: [],
  },
  {
    id: 'natural-z5',
    variant: 'both',
    enabledLayers: ['natural'],
    camera: seededCameras.natural,
    expectedDeckLayers: ['earthquakes-layer', 'natural-events-layer'],
    expectedSelectors: [],
  },
  {
    id: 'spaceports-z5',
    variant: 'both',
    enabledLayers: ['spaceports'],
    camera: toCamera(spaceportLon, spaceportLat, 5.1),
    expectedDeckLayers: ['spaceports-layer'],
    expectedSelectors: [],
  },
  {
    id: 'minerals-z5',
    variant: 'both',
    enabledLayers: ['minerals'],
    camera: toCamera(mineralLon, mineralLat, 5.1),
    expectedDeckLayers: ['minerals-layer'],
    expectedSelectors: [],
  },
  {
    id: 'fires-z5',
    variant: 'both',
    enabledLayers: ['fires'],
    camera: seededCameras.fires,
    expectedDeckLayers: ['fires-layer'],
    expectedSelectors: [],
  },
  {
    id: 'news-z5',
    variant: 'both',
    enabledLayers: [],
    camera: seededCameras.news,
    expectedDeckLayers: ['news-locations-layer'],
    expectedSelectors: [],
    includeNewsLocation: true,
  },
  {
    id: 'apt-groups-z5',
    variant: 'full',
    enabledLayers: [],
    camera: toCamera(aptLon, aptLat, 5.1),
    expectedDeckLayers: ['apt-groups-layer'],
    expectedSelectors: [],
  },
  {
    id: 'startup-hubs-z5',
    variant: 'tech',
    enabledLayers: ['startupHubs'],
    camera: toCamera(startupLon, startupLat, 5.2),
    expectedDeckLayers: ['startup-hubs-layer'],
    expectedSelectors: [],
  },
  {
    id: 'accelerators-z5',
    variant: 'tech',
    enabledLayers: ['accelerators'],
    camera: toCamera(acceleratorLon, acceleratorLat, 5.2),
    expectedDeckLayers: ['accelerators-layer'],
    expectedSelectors: [],
  },
  {
    id: 'cloud-regions-z5',
    variant: 'tech',
    enabledLayers: ['cloudRegions'],
    camera: toCamera(cloudRegionLon, cloudRegionLat, 5.2),
    expectedDeckLayers: ['cloud-regions-layer'],
    expectedSelectors: [],
  },
  {
    id: 'tech-hqs-z5',
    variant: 'tech',
    enabledLayers: ['techHQs'],
    camera: toCamera(techHQLon, techHQLat, 5.2),
    expectedDeckLayers: ['tech-hq-clusters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'tech-events-z5',
    variant: 'tech',
    enabledLayers: ['techEvents'],
    camera: seededCameras.techEvents,
    expectedDeckLayers: ['tech-event-clusters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'stock-exchanges-z5',
    variant: 'finance',
    enabledLayers: ['stockExchanges'],
    camera: toCamera(exchangeLon, exchangeLat, 5.2),
    expectedDeckLayers: ['stock-exchanges-layer'],
    expectedSelectors: [],
  },
  {
    id: 'financial-centers-z5',
    variant: 'finance',
    enabledLayers: ['financialCenters'],
    camera: toCamera(financialCenterLon, financialCenterLat, 5.2),
    expectedDeckLayers: ['financial-centers-layer'],
    expectedSelectors: [],
  },
  {
    id: 'central-banks-z5',
    variant: 'finance',
    enabledLayers: ['centralBanks'],
    camera: toCamera(centralBankLon, centralBankLat, 5.2),
    expectedDeckLayers: ['central-banks-layer'],
    expectedSelectors: [],
  },
  {
    id: 'commodity-hubs-z5',
    variant: 'finance',
    enabledLayers: ['commodityHubs'],
    camera: toCamera(commodityHubLon, commodityHubLat, 5.2),
    expectedDeckLayers: ['commodity-hubs-layer'],
    expectedSelectors: [],
  },
  // Note: `sanctions` has no map renderer in DeckGLMap today; excluded from visual scenarios.
];

const visualScenarioMap = new Map(VISUAL_SCENARIOS.map((scenario) => [scenario.id, scenario]));

const filterScenariosForVariant = (variant: HarnessVariant): VisualScenario[] => {
  return VISUAL_SCENARIOS.filter(
    (scenario) => scenario.variant === 'both' || scenario.variant === variant
  );
};

const currentHarnessVariant: HarnessVariant = SITE_VARIANT === 'tech'
  ? 'tech'
  : SITE_VARIANT === 'finance'
  ? 'finance'
  : 'full';

const buildProtests = (scenario: Scenario): SocialUnrestEvent[] => {
  const title =
    scenario === 'alpha' ? 'Scenario Alpha Protest' : 'Scenario Beta Protest';
  const baseTime =
    scenario === 'alpha'
      ? new Date('2026-02-01T12:00:00.000Z')
      : new Date('2026-02-01T13:00:00.000Z');

  return [
    {
      id: `e2e-protest-${scenario}`,
      title,
      summary: `${title} summary`,
      eventType: 'riot',
      city: 'Harness City',
      country: 'Harnessland',
      lat: 20.1,
      lon: 0.2,
      time: baseTime,
      severity: 'high',
      fatalities: scenario === 'alpha' ? 1 : 2,
      sources: ['e2e'],
      sourceType: 'rss',
      tags: ['e2e'],
      actors: ['Harness Group'],
      relatedHotspots: [],
      confidence: 'high',
      validated: true,
    },
  ];
};

const buildPulseProtests = (scenario: PulseProtestScenario): SocialUnrestEvent[] => {
  if (scenario === 'none') return [];

  const now = new Date();
  const isRiot = scenario !== 'recent-protest';
  const sourceType = scenario === 'recent-gdelt-riot' ? 'gdelt' : 'acled';

  return [
    {
      id: `e2e-pulse-protest-${scenario}`,
      title: `Pulse Protest ${scenario}`,
      summary: `Pulse protest fixture: ${scenario}`,
      eventType: isRiot ? 'riot' : 'protest',
      city: 'Harness City',
      country: 'Harnessland',
      lat: 20.1,
      lon: 0.2,
      time: now,
      severity: isRiot ? 'high' : 'medium',
      fatalities: isRiot ? 1 : 0,
      sources: ['e2e'],
      sourceType,
      tags: ['e2e', 'pulse'],
      actors: ['Harness Group'],
      relatedHotspots: [],
      confidence: 'high',
      validated: true,
    },
  ];
};

const buildHotspotActivityNews = (
  scenario: 'none' | 'breaking'
): NewsItem[] => {
  if (scenario === 'none') return [];

  return [
    {
      source: 'e2e-harness',
      title: 'Sahel alert: mali coup activity intensifies',
      link: 'https://example.com/hotspot-breaking',
      pubDate: new Date(),
      isAlert: true,
    },
  ];
};

const seedAllDynamicData = (): void => {
  const earthquakes: Earthquake[] = [
    {
      id: 'e2e-eq-1',
      place: 'Harness Fault',
      magnitude: 5.8,
      depthKm: 12,
      location: { latitude: 34.1, longitude: -118.2 },
      occurredAt: new Date('2026-02-01T10:00:00.000Z').getTime(),
      sourceUrl: 'https://example.com/eq',
    },
  ];

  const weather: WeatherAlert[] = [
    {
      id: 'e2e-weather-1',
      event: 'Storm Warning',
      severity: 'Severe',
      headline: 'Harness Weather Alert',
      description: 'Severe storm conditions expected in harness region.',
      areaDesc: 'Harness Region',
      onset: new Date('2026-02-01T09:00:00.000Z'),
      expires: new Date('2026-02-01T18:00:00.000Z'),
      coordinates: [[-80.1, 25.7], [-80.2, 25.8], [-80.3, 25.6]],
      centroid: [-80.2, 25.7],
    },
  ];

  const outages: InternetOutage[] = [
    {
      id: 'e2e-outage-1',
      title: 'Harness Network Degradation',
      link: 'https://example.com/outage',
      description: 'Network disruption for test coverage.',
      pubDate: new Date('2026-02-01T11:00:00.000Z'),
      country: 'Harnessland',
      lat: 51.5,
      lon: -0.1,
      severity: 'major',
      categories: ['connectivity'],
    },
  ];

  const cyberThreats: CyberThreat[] = [
    {
      id: 'e2e-cyber-1',
      type: 'c2_server',
      source: 'feodo',
      indicator: '1.2.3.4',
      indicatorType: 'ip',
      lat: 51.5,
      lon: -0.12,
      country: 'GB',
      severity: 'high',
      malwareFamily: 'QakBot',
      tags: ['botnet', 'c2'],
      firstSeen: '2026-02-01T09:00:00.000Z',
      lastSeen: '2026-02-01T10:00:00.000Z',
    },
  ];

  const aisDisruptions: AisDisruptionEvent[] = [
    {
      id: 'e2e-ais-disruption-1',
      name: 'Harness Chokepoint',
      type: 'chokepoint_congestion',
      lat: 25.0,
      lon: 55.0,
      severity: 'high',
      changePct: 34,
      windowHours: 6,
      vesselCount: 61,
      description: 'High congestion detected for coverage.',
    },
  ];

  const aisDensity: AisDensityZone[] = [
    {
      id: 'e2e-ais-density-1',
      name: 'Harness Density Zone',
      lat: 24.8,
      lon: 54.9,
      intensity: 0.8,
      deltaPct: 22,
      shipsPerDay: 230,
    },
  ];

  const cableAdvisories: CableAdvisory[] = [
    {
      id: 'e2e-cable-adv-1',
      cableId: 'sea-me-we-5',
      title: 'Harness Cable Fault',
      severity: 'fault',
      description: 'Fiber disruption under investigation.',
      reported: new Date('2026-02-01T08:00:00.000Z'),
      lat: 12.2,
      lon: 45.2,
      impact: 'Regional latency increase',
      repairEta: '24h',
    },
  ];

  const repairShips: RepairShip[] = [
    {
      id: 'e2e-repair-1',
      name: 'Harness Repair Vessel',
      cableId: 'sea-me-we-5',
      status: 'enroute',
      lat: 12.5,
      lon: 45.1,
      eta: '2026-02-02T00:00:00Z',
      note: 'En route to suspected break location.',
    },
  ];

  const flightDelays: AirportDelayAlert[] = [
    {
      id: 'e2e-flight-1',
      iata: 'HNS',
      icao: 'EHNS',
      name: 'Harness International',
      city: 'Harness City',
      country: 'Harnessland',
      lat: 40.4,
      lon: -73.9,
      region: 'americas',
      delayType: 'ground_delay',
      severity: 'major',
      avgDelayMinutes: 48,
      reason: 'Severe weather',
      source: 'computed',
      updatedAt: new Date('2026-02-01T11:00:00.000Z'),
    },
  ];

  const militaryFlights: MilitaryFlight[] = [
    {
      id: 'e2e-mil-flight-1',
      callsign: 'HARN01',
      hexCode: 'abc123',
      aircraftType: 'fighter',
      operator: 'usaf',
      operatorCountry: 'US',
      lat: 33.9,
      lon: -117.9,
      altitude: 30000,
      heading: 92,
      speed: 430,
      onGround: false,
      lastSeen: new Date('2026-02-01T11:00:00.000Z'),
      confidence: 'high',
    },
  ];

  const militaryFlightClusters: MilitaryFlightCluster[] = [
    {
      id: 'e2e-mil-flight-cluster-1',
      name: 'Harness Air Cluster',
      lat: 34.0,
      lon: -118.0,
      flightCount: 3,
      flights: militaryFlights,
      activityType: 'exercise',
    },
  ];

  const militaryVessels: MilitaryVessel[] = [
    {
      id: 'e2e-mil-vessel-1',
      mmsi: '123456789',
      name: 'Harness Destroyer',
      vesselType: 'destroyer',
      operator: 'usn',
      operatorCountry: 'US',
      lat: 26.2,
      lon: 56.4,
      heading: 145,
      speed: 18,
      lastAisUpdate: new Date('2026-02-01T11:00:00.000Z'),
      confidence: 'high',
    },
  ];

  const militaryVesselClusters: MilitaryVesselCluster[] = [
    {
      id: 'e2e-mil-vessel-cluster-1',
      name: 'Harness Naval Group',
      lat: 26.1,
      lon: 56.3,
      vesselCount: 4,
      vessels: militaryVessels,
      activityType: 'deployment',
    },
  ];

  const naturalEvents: NaturalEvent[] = [
    {
      id: 'e2e-natural-1',
      title: '🔴 Harness Volcano Activity',
      category: 'volcanoes',
      categoryTitle: 'Volcano',
      lat: 14.7,
      lon: -90.9,
      date: new Date('2026-02-01T06:00:00.000Z'),
      closed: false,
    },
  ];

  map.setRenderPaused(true);
  map.setLayers(allLayersEnabled);
  map.setZoom(5);
  map.setEarthquakes(earthquakes);
  map.setWeatherAlerts(weather);
  map.setOutages(outages);
  map.setCyberThreats(cyberThreats);
  map.setAisData(aisDisruptions, aisDensity);
  map.setCableActivity(cableAdvisories, repairShips);
  map.setProtests(buildProtests('alpha'));
  map.setFlightDelays(flightDelays);
  map.setMilitaryFlights(militaryFlights, militaryFlightClusters);
  map.setMilitaryVessels(militaryVessels, militaryVesselClusters);
  map.setNaturalEvents(naturalEvents);
  map.setFires([
    {
      lat: -5.4,
      lon: -60.1,
      brightness: 420,
      frp: 180,
      confidence: 0.95,
      region: 'Harness Fire Region',
      acq_date: '2026-02-01',
      daynight: 'D',
    },
  ]);
  map.setTechEvents([
    {
      id: 'e2e-tech-event-1',
      title: 'Harness Summit Alpha',
      location: 'Harness City',
      lat: 37.77,
      lng: -122.42,
      country: 'US',
      startDate: '2026-03-10',
      endDate: '2026-03-12',
      url: 'https://example.com/alpha',
      daysUntil: 20,
    },
    {
      id: 'e2e-tech-event-2',
      title: 'Harness Summit Beta',
      location: 'Harness City',
      lat: 37.77,
      lng: -122.42,
      country: 'US',
      startDate: '2026-04-01',
      endDate: '2026-04-02',
      url: 'https://example.com/beta',
      daysUntil: 42,
    },
  ]);
  map.setNewsLocations(SEEDED_NEWS_LOCATIONS);
  map.setRenderPaused(false);
  map.render();
};

const makeNewsLocationsNonRecent = (): void => {
  const now = Date.now();
  if (internals.newsLocationFirstSeen) {
    for (const key of internals.newsLocationFirstSeen.keys()) {
      internals.newsLocationFirstSeen.set(key, now - 120_000);
    }
  }
  internals.stopPulseAnimation?.();
};

const setNewsPulseScenario = (scenario: NewsPulseScenario): void => {
  if (scenario === 'none') {
    internals.newsLocationFirstSeen?.clear();
    map.setNewsLocations([]);
    return;
  }

  if (scenario === 'recent') {
    map.setNewsLocations([
      {
        lat: 48.85,
        lon: 2.35,
        title: `Harness Pulse News ${Date.now()}`,
        threatLevel: 'high',
      },
    ]);
    return;
  }

  map.setNewsLocations(SEEDED_NEWS_LOCATIONS);
  makeNewsLocationsNonRecent();
};

let deterministicVisualModeEnabled = false;
const DETERMINISTIC_STYLE_ID = 'e2e-deterministic-style';

const ensureDeterministicStyles = (): void => {
  if (document.getElementById(DETERMINISTIC_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = DETERMINISTIC_STYLE_ID;
  style.textContent = `
    body.${DETERMINISTIC_BODY_CLASS} *,
    body.${DETERMINISTIC_BODY_CLASS} *::before,
    body.${DETERMINISTIC_BODY_CLASS} *::after {
      animation: none !important;
      transition: none !important;
    }

    body.${DETERMINISTIC_BODY_CLASS} .deckgl-controls,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-time-slider,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-layer-toggles,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-legend,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-timestamp,
    body.${DETERMINISTIC_BODY_CLASS} .maplibregl-ctrl-bottom-right,
    body.${DETERMINISTIC_BODY_CLASS} .maplibregl-ctrl-bottom-left {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
};

const hideRasterBasemap = (): void => {
  const maplibreMap = internals.maplibreMap;
  if (!maplibreMap) return;

  try {
    if (maplibreMap.getLayer('carto-dark-layer')) {
      maplibreMap.setPaintProperty('carto-dark-layer', 'raster-opacity', 0);
    }
  } catch {
    // No-op for harness stability.
  }
};

const enableDeterministicVisualMode = (): void => {
  document.body.classList.add(DETERMINISTIC_BODY_CLASS);
  ensureDeterministicStyles();
  hideRasterBasemap();
  makeNewsLocationsNonRecent();
  map.render();
  deterministicVisualModeEnabled = true;
};

const prepareVisualScenario = (scenarioId: string): boolean => {
  const scenario = visualScenarioMap.get(scenarioId);
  if (!scenario) return false;

  enableDeterministicVisualMode();

  map.setRenderPaused(true);
  setLayersForSnapshot(scenario.enabledLayers);
  map.setNewsLocations(scenario.includeNewsLocation ? SEEDED_NEWS_LOCATIONS : []);
  if (!scenario.includeNewsLocation) {
    makeNewsLocationsNonRecent();
  }
  setCamera(scenario.camera);
  map.setRenderPaused(false);
  map.render();

  return true;
};

const isVisualScenarioReady = (scenarioId: string): boolean => {
  const scenario = visualScenarioMap.get(scenarioId);
  if (!scenario) return false;

  const layersById = new Map<string, number>(
    getDeckLayerSnapshot().map((layer) => [layer.id, layer.dataCount])
  );

  for (const expectedLayerId of scenario.expectedDeckLayers) {
    if ((layersById.get(expectedLayerId) ?? 0) <= 0) {
      return false;
    }
  }

  for (const selector of scenario.expectedSelectors) {
    if (document.querySelectorAll(selector).length <= 0) {
      return false;
    }
  }

  return true;
};

const getCyberTooltipHtml = (indicator: string): string => {
  const tooltip = internals.getTooltip?.({
    object: {
      country: indicator,
      severity: 'high',
      source: 'feodo',
    },
    layer: { id: 'cyber-threats-layer' },
  });
  return typeof tooltip?.html === 'string' ? tooltip.html : '';
};

seedAllDynamicData();

let ready = false;
const readyStartedAt = Date.now();
const STYLE_READY_FALLBACK_MS = 12_000;
const pollReady = (): void => {
  const hasCanvas = Boolean(document.querySelector('#deckgl-basemap canvas'));
  const maplibreMap = internals.maplibreMap;
  const styleLoaded = Boolean(maplibreMap?.isStyleLoaded());
  const allowStyleFallback =
    hasCanvas &&
    Boolean(maplibreMap) &&
    Date.now() - readyStartedAt >= STYLE_READY_FALLBACK_MS;

  if ((hasCanvas && styleLoaded) || allowStyleFallback) {
    if (!deterministicVisualModeEnabled) {
      enableDeterministicVisualMode();
    }
    ready = true;
    return;
  }

  requestAnimationFrame(pollReady);
};
pollReady();

window.__mapHarness = {
  get ready() {
    return ready;
  },
  variant: currentHarnessVariant,
  seedAllDynamicData,
  setProtestsScenario: (scenario: Scenario): void => {
    map.setProtests(buildProtests(scenario));
  },
  setPulseProtestsScenario: (scenario: PulseProtestScenario): void => {
    map.setProtests(buildPulseProtests(scenario));
  },
  setNewsPulseScenario,
  setHotspotActivityScenario: (scenario: 'none' | 'breaking'): void => {
    map.updateHotspotActivity(buildHotspotActivityNews(scenario));
  },
  forcePulseStartupElapsed: (): void => {
    internals.startupTime = Date.now() - 61_000;
  },
  resetPulseStartupTime: (): void => {
    internals.startupTime = Date.now();
  },
  isPulseAnimationRunning: (): boolean => {
    return internals.newsPulseIntervalId != null;
  },
  setZoom: (zoom: number): void => {
    map.setZoom(zoom);
    map.render();
  },
  setLayersForSnapshot,
  setCamera,
  enableDeterministicVisualMode,
  getVisualScenarios: (): VisualScenarioSummary[] => {
    return filterScenariosForVariant(currentHarnessVariant).map((scenario) => ({
      id: scenario.id,
      variant: scenario.variant,
    }));
  },
  prepareVisualScenario,
  isVisualScenarioReady,
  getDeckLayerSnapshot,
  getLayerDataCount,
  getLayerFirstScreenTransform,
  getFirstProtestTitle,
  getProtestClusterCount,
  getOverlaySnapshot,
  getCyberTooltipHtml,
  destroy: (): void => {
    map.destroy();
  },
};
