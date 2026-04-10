/**
 * DeckGLMap - WebGL-accelerated map visualization for desktop
 * Uses deck.gl for high-performance rendering of large datasets
 * Mobile devices gracefully degrade to the D3/SVG-based Map component
 */
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, LayersList, PickingInfo } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, PathLayer, IconLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import maplibregl from 'maplibre-gl';
import { registerPMTilesProtocol, FALLBACK_DARK_STYLE, FALLBACK_LIGHT_STYLE, getMapProvider, getMapTheme, getStyleForProvider, isLightMapTheme } from '@/config/basemap';
import Supercluster from 'supercluster';
import type {
  MapLayers,
  Hotspot,
  NewsItem,
  InternetOutage,
  RelatedAsset,
  AssetType,
  AisDisruptionEvent,
  AisDensityZone,
  CableAdvisory,
  RepairShip,
  SocialUnrestEvent,
  AIDataCenter,
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  NaturalEvent,
  UcdpGeoEvent,
  MapProtestCluster,
  MapTechHQCluster,
  MapTechEventCluster,
  MapDatacenterCluster,
  CyberThreat,
  CableHealthRecord,
  MilitaryBaseEnriched,
} from '@/types';
import { fetchMilitaryBases, type MilitaryBaseCluster as ServerBaseCluster } from '@/services/military-bases';
import type { AirportDelayAlert, PositionSample } from '@/services/aviation';
import { fetchAircraftPositions } from '@/services/aviation';
import { type IranEvent, getIranEventColor, getIranEventRadius } from '@/services/conflict';
import { getMilitaryBaseColor } from '@/config/military-base-colors';
import { getMineralColor } from '@/config/mineral-colors';
import { getWindColor } from '@/config/wind-colors';
import { CII_LEVEL_COLORS, type CiiLevel } from '@/config/cii-colors';
import type { GpsJamHex } from '@/services/gps-interference';
import { fetchImageryScenes } from '@/services/imagery';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { DisplacementFlow } from '@/services/displacement';
import type { Earthquake } from '@/services/earthquakes';
import type { ClimateAnomaly } from '@/services/climate';
import type { RadiationObservation } from '@/services/radiation';
import { ArcLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { WeatherAlert } from '@/services/weather';
import { escapeHtml } from '@/utils/sanitize';
import { tokenizeForMatch, matchKeyword, matchesAnyKeyword, findMatchingKeywords } from '@/utils/keyword-match';
import { t } from '@/services/i18n';
import { debounce, rafSchedule, getCurrentTheme } from '@/utils/index';
import { showLayerWarning } from '@/utils/layer-warning';
import { localizeMapLabels } from '@/utils/map-locale';
import {
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,

  MILITARY_BASES,
  UNDERSEA_CABLES,
  NUCLEAR_FACILITIES,
  GAMMA_IRRADIATORS,
  PIPELINES,
  PIPELINE_COLORS,
  STRATEGIC_WATERWAYS,
  ECONOMIC_CENTERS,
  AI_DATA_CENTERS,
  SITE_VARIANT,
  STARTUP_HUBS,
  ACCELERATORS,
  TECH_HQS,
  CLOUD_REGIONS,
  PORTS,
  SPACEPORTS,
  CRITICAL_MINERALS,
  STOCK_EXCHANGES,
  FINANCIAL_CENTERS,
  CENTRAL_BANKS,
  COMMODITY_HUBS,
  GULF_INVESTMENTS,
  MINING_SITES,
  PROCESSING_PLANTS,
  COMMODITY_PORTS as COMMODITY_GEO_PORTS,
  SANCTIONED_COUNTRIES_ALPHA2,
} from '@/config';
import type { GulfInvestment } from '@/types';
import { resolveTradeRouteSegments, TRADE_ROUTES as TRADE_ROUTES_LIST, type TradeRouteSegment, type TradeRouteStatus } from '@/config/trade-routes';
import type { ScenarioVisualState } from '@/config/scenario-templates';
import { getLayersForVariant, resolveLayerLabel, bindLayerSearch, type MapVariant } from '@/config/map-layer-definitions';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { trackGateHit } from '@/services/analytics';
import { MapPopup, type PopupType } from './MapPopup';
import type { GetChokepointStatusResponse } from '@/services/supply-chain';
import {
  updateHotspotEscalation,
  getHotspotEscalation,
  setMilitaryData,
  setCIIGetter,
  setGeoAlertGetter,
} from '@/services/hotspot-escalation';
import { getCountryScore } from '@/services/country-instability';
import { getAlertsNearLocation } from '@/services/geo-convergence';
import type { PositiveGeoEvent } from '@/services/positive-events-geo';
import type { KindnessPoint } from '@/services/kindness-data';
import type { HappinessData } from '@/services/happiness-data';
import type { RenewableInstallation } from '@/services/renewable-installations';
import type { SpeciesRecovery } from '@/services/conservation-data';
import { getCountriesGeoJson, getCountryAtCoordinates, getCountryBbox, getCountryCentroid } from '@/services/country-geometry';
import type { DiseaseOutbreakItem } from '@/services/disease-outbreaks';
import type { FeatureCollection, Geometry } from 'geojson';
import type { ResilienceRankingItem } from '@/services/resilience';
import {
  RESILIENCE_CHOROPLETH_COLORS,
  buildResilienceChoroplethMap,
  normalizeExclusiveChoropleths,
} from './resilience-choropleth-utils';

import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { pinWebcam, isPinned } from '@/services/webcams/pinned-store';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import { fetchWebcamImage } from '@/services/webcams';

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type DeckMapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';
type MapInteractionMode = 'flat' | '3d';

export interface CountryClickPayload {
  lat: number;
  lon: number;
  code?: string;
  name?: string;
}

interface DeckMapState {
  zoom: number;
  pan: { x: number; y: number };
  view: DeckMapView;
  layers: MapLayers;
  timeRange: TimeRange;
}

interface HotspotWithBreaking extends Hotspot {
  hasBreaking?: boolean;
}

interface TechEventMarker {
  id: string;
  title: string;
  location: string;
  lat: number;
  lng: number;
  country: string;
  startDate: string;
  endDate: string;
  url: string | null;
  daysUntil: number;
}

// View presets with longitude, latitude, zoom
const VIEW_PRESETS: Record<DeckMapView, { longitude: number; latitude: number; zoom: number }> = {
  global: { longitude: 0, latitude: 20, zoom: 1.5 },
  america: { longitude: -95, latitude: 38, zoom: 3 },
  mena: { longitude: 45, latitude: 28, zoom: 3.5 },
  eu: { longitude: 15, latitude: 50, zoom: 3.5 },
  asia: { longitude: 105, latitude: 35, zoom: 3 },
  latam: { longitude: -60, latitude: -15, zoom: 3 },
  africa: { longitude: 20, latitude: 5, zoom: 3 },
  oceania: { longitude: 135, latitude: -25, zoom: 3.5 },
};

const MAP_INTERACTION_MODE: MapInteractionMode =
  import.meta.env.VITE_MAP_INTERACTION_MODE === 'flat' ? 'flat' : '3d';

const HAPPY_DARK_STYLE = '/map-styles/happy-dark.json';
const HAPPY_LIGHT_STYLE = '/map-styles/happy-light.json';
const isHappyVariant = SITE_VARIANT === 'happy';

// Zoom thresholds for layer visibility and labels (matches old Map.ts)
// Zoom-dependent layer visibility and labels
const LAYER_ZOOM_THRESHOLDS: Partial<Record<keyof MapLayers, { minZoom: number; showLabels?: number }>> = {
  bases: { minZoom: 3, showLabels: 5 },
  nuclear: { minZoom: 3 },
  conflicts: { minZoom: 1, showLabels: 3 },
  economic: { minZoom: 3 },
  natural: { minZoom: 1, showLabels: 2 },
  datacenters: { minZoom: 5 },
  irradiators: { minZoom: 4 },
  spaceports: { minZoom: 3 },
  gulfInvestments: { minZoom: 2, showLabels: 5 },
};
// Export for external use
export { LAYER_ZOOM_THRESHOLDS };

// Theme-aware overlay color function — refreshed each buildLayers() call
function getOverlayColors() {
  const isLight = getCurrentTheme() === 'light';
  return {
    // Threat dots: IDENTICAL in both modes (user locked decision)
    hotspotHigh: [255, 68, 68, 200] as [number, number, number, number],
    hotspotElevated: [255, 165, 0, 200] as [number, number, number, number],
    hotspotLow: [255, 255, 0, 180] as [number, number, number, number],

    // Conflict zone fills: more transparent in light mode
    conflict: isLight
      ? [255, 0, 0, 60] as [number, number, number, number]
      : [255, 0, 0, 100] as [number, number, number, number],

    // Infrastructure/category markers: darker variants in light mode for map readability
    base: [0, 150, 255, 200] as [number, number, number, number],
    nuclear: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 215, 0, 200] as [number, number, number, number],
    datacenter: isLight
      ? [13, 148, 136, 200] as [number, number, number, number]
      : [0, 255, 200, 180] as [number, number, number, number],
    cable: [0, 200, 255, 150] as [number, number, number, number],
    cableHighlight: [255, 100, 100, 200] as [number, number, number, number],
    cableFault: [255, 50, 50, 220] as [number, number, number, number],
    cableDegraded: [255, 165, 0, 200] as [number, number, number, number],
    earthquake: [255, 100, 50, 200] as [number, number, number, number],
    vesselMilitary: [255, 100, 100, 220] as [number, number, number, number],
    protest: [255, 150, 0, 200] as [number, number, number, number],
    outage: [255, 50, 50, 180] as [number, number, number, number],
    trafficAnomaly: [255, 160, 0, 200] as [number, number, number, number],
    ddosHit: [180, 0, 255, 200] as [number, number, number, number],
    weather: [100, 150, 255, 180] as [number, number, number, number],
    startupHub: isLight
      ? [22, 163, 74, 220] as [number, number, number, number]
      : [0, 255, 150, 200] as [number, number, number, number],
    techHQ: [100, 200, 255, 200] as [number, number, number, number],
    accelerator: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 200, 0, 200] as [number, number, number, number],
    cloudRegion: [150, 100, 255, 180] as [number, number, number, number],
    stockExchange: isLight
      ? [20, 120, 200, 220] as [number, number, number, number]
      : [80, 200, 255, 210] as [number, number, number, number],
    financialCenter: isLight
      ? [0, 150, 110, 215] as [number, number, number, number]
      : [0, 220, 150, 200] as [number, number, number, number],
    centralBank: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 210, 80, 210] as [number, number, number, number],
    commodityHub: isLight
      ? [190, 95, 40, 220] as [number, number, number, number]
      : [255, 150, 80, 200] as [number, number, number, number],
    gulfInvestmentSA: [0, 168, 107, 220] as [number, number, number, number],
    gulfInvestmentUAE: [255, 0, 100, 220] as [number, number, number, number],
    ucdpStateBased: [255, 50, 50, 200] as [number, number, number, number],
    ucdpNonState: [255, 165, 0, 200] as [number, number, number, number],
    ucdpOneSided: [255, 255, 0, 200] as [number, number, number, number],
  };
}
// Initialize and refresh on every buildLayers() call
let COLORS = getOverlayColors();

// SVG icons as data URLs for different marker shapes
const MARKER_ICONS = {
  // Square - for datacenters
  square: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="3" fill="white"/></svg>`),
  // Diamond - for hotspots
  diamond: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 30,16 16,30 2,16" fill="white"/></svg>`),
  // Triangle up - for military bases
  triangleUp: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 30,28 2,28" fill="white"/></svg>`),
  // Hexagon - for nuclear
  hexagon: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="white"/></svg>`),
  // Circle - fallback
  circle: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="white"/></svg>`),
  // Star - for special markers
  star: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 20,12 30,12 22,19 25,30 16,23 7,30 10,19 2,12 12,12" fill="white"/></svg>`),
  // Airplane silhouette - top-down with wings and tail (pointing north, rotated by trackDeg)
  plane: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 2 L17.5 10 L17 12 L27 17 L27 19 L17 16 L17 24 L20 26.5 L20 28 L16 27 L12 28 L12 26.5 L15 24 L15 16 L5 19 L5 17 L15 12 L14.5 10 Z" fill="white"/></svg>`),
};

const BASES_ICON_MAPPING = { triangleUp: { x: 0, y: 0, width: 32, height: 32, mask: true } };
const NUCLEAR_ICON_MAPPING = { hexagon: { x: 0, y: 0, width: 32, height: 32, mask: true } };
const DATACENTER_ICON_MAPPING = { square: { x: 0, y: 0, width: 32, height: 32, mask: true } };
const AIRCRAFT_ICON_MAPPING = { plane: { x: 0, y: 0, width: 32, height: 32, mask: true } };

const CONFLICT_COUNTRY_ISO: Record<string, string[]> = {
  iran: ['IR'],
  ukraine: ['UA'],
  sudan: ['SD'],
  myanmar: ['MM'],
};

// Altitude-based color gradient matching Wingbits' color scheme.
// Transitions cyan (sea level) → yellow-green → orange → red (cruise altitude).
const ALTITUDE_COLOR_STOPS: Array<{ alt: number; r: number; g: number; b: number }> = [
  { alt: 0,      r: 0,   g: 217, b: 255 },
  { alt: 5000,   r: 50,  g: 250, b: 160 },
  { alt: 10000,  r: 200, g: 230, b: 60  },
  { alt: 20000,  r: 255, g: 165, b: 30  },
  { alt: 30000,  r: 255, g: 100, b: 35  },
  { alt: 40000,  r: 235, g: 50,  b: 55  },
  { alt: 45000,  r: 210, g: 40,  b: 70  },
];

function altitudeToColor(altFt: number): [number, number, number] {
  const stops = ALTITUDE_COLOR_STOPS;
  const alt = Number.isFinite(altFt) ? altFt : 0;
  if (alt <= stops[0]!.alt) return [stops[0]!.r, stops[0]!.g, stops[0]!.b];
  const last = stops[stops.length - 1]!;
  if (alt >= last.alt) return [last.r, last.g, last.b];
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i]!;
    const lo = stops[i - 1]!;
    if (alt <= hi.alt) {
      const t = (alt - lo.alt) / (hi.alt - lo.alt);
      return [
        Math.round(lo.r + (hi.r - lo.r) * t),
        Math.round(lo.g + (hi.g - lo.g) * t),
        Math.round(lo.b + (hi.b - lo.b) * t),
      ];
    }
  }
  return [last.r, last.g, last.b]; // unreachable: exhaustive bracket search above satisfies TS
}

function ensureClosedRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** Module-level Map from routeId → waypoint IDs. Built once, reused across all layer renders. */
const ROUTE_WAYPOINTS_MAP = new Map<string, string[]>(
  TRADE_ROUTES_LIST.map(r => [r.id, r.waypoints]),
);

export class DeckGLMap {
  private static readonly MAX_CLUSTER_LEAVES = 200;

  private container: HTMLElement;
  private deckOverlay: MapboxOverlay | null = null;
  private maplibreMap: maplibregl.Map | null = null;
  private state: DeckMapState;
  private popup: MapPopup;
  private isResizing = false;
  private savedTopLat: number | null = null;
  private correctingCenter = false;

  // Data stores
  private hotspots: HotspotWithBreaking[];
  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private outages: InternetOutage[] = [];
  private trafficAnomalies: ProtoTrafficAnomaly[] = [];
  private ddosLocations: DdosLocationHit[] = [];
  private cyberThreats: CyberThreat[] = [];
  private aptGroups: import('@/types').APTGroup[] = [];
  private aptGroupsLoaded = false;
  private _unsubscribeAuthState: (() => void) | null = null;
  private aptGroupsLayerFailed = false;
  private satelliteImageryLayerFailed = false;
  private iranEvents: IranEvent[] = [];
  private aisDisruptions: AisDisruptionEvent[] = [];
  private aisDensity: AisDensityZone[] = [];
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private healthByCableId: Record<string, CableHealthRecord> = {};
  private protests: SocialUnrestEvent[] = [];
  private militaryFlights: MilitaryFlight[] = [];
  private militaryFlightClusters: MilitaryFlightCluster[] = [];
  private activeFlightTrails = new Set<string>();
  private clearTrailsBtn: HTMLButtonElement | null = null;
  private militaryVessels: MilitaryVessel[] = [];
  private militaryVesselClusters: MilitaryVesselCluster[] = [];
  private serverBases: MilitaryBaseEnriched[] = [];
  private serverBaseClusters: ServerBaseCluster[] = [];
  private serverBasesLoaded = false;
  private naturalEvents: NaturalEvent[] = [];
  private firmsFireData: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }> = [];
  private techEvents: TechEventMarker[] = [];
  private flightDelays: AirportDelayAlert[] = [];
  private aircraftPositions: PositionSample[] = [];
  private aircraftFetchTimer: ReturnType<typeof setInterval> | null = null;
  private news: NewsItem[] = [];
  private newsLocations: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }> = [];
  private newsLocationFirstSeen = new Map<string, number>();
  private ucdpEvents: UcdpGeoEvent[] = [];
  private displacementFlows: DisplacementFlow[] = [];
  private gpsJammingHexes: GpsJamHex[] = [];
  private climateAnomalies: ClimateAnomaly[] = [];
  private radiationObservations: RadiationObservation[] = [];
  private diseaseOutbreaks: DiseaseOutbreakItem[] = [];
  private tradeRouteSegments: TradeRouteSegment[] = resolveTradeRouteSegments();
  private storedChokepointData: GetChokepointStatusResponse | null = null;
  private scenarioState: ScenarioVisualState | null = null;
  private affectedIso2Set: Set<string> = new Set();
  private positiveEvents: PositiveGeoEvent[] = [];
  private kindnessPoints: KindnessPoint[] = [];
  private imageryScenes: ImageryScene[] = [];
  private imagerySearchTimer: ReturnType<typeof setTimeout> | null = null;
  private imagerySearchVersion = 0;

  // Phase 8 overlay data
  private happinessScores: Map<string, number> = new Map();
  private happinessYear = 0;
  private happinessSource = '';
  private speciesRecoveryZones: Array<SpeciesRecovery & { recoveryZone: { name: string; lat: number; lon: number } }> = [];
  private renewableInstallations: RenewableInstallation[] = [];
  private webcamData: Array<WebcamEntry | WebcamCluster> = [];
  private countriesGeoJsonData: FeatureCollection<Geometry> | null = null;
  private conflictZoneGeoJson: GeoJSON.FeatureCollection | null = null;

  // CII choropleth data
  private ciiScoresMap: Map<string, { score: number; level: string }> = new Map();
  private ciiScoresVersion = 0;
  private resilienceScoresMap: ReturnType<typeof buildResilienceChoroplethMap> = new Map();
  private resilienceScoresVersion = 0;

  // Country highlight state
  private countryGeoJsonLoaded = false;
  private countryHoverSetup = false;
  private highlightedCountryCode: string | null = null;
  private hoveredCountryIso2: string | null = null;
  private hoveredCountryName: string | null = null;

  // Callbacks
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTradeArcClick?: (segment: TradeRouteSegment, waypoints: string[], x: number, y: number) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onCountryClick?: (country: CountryClickPayload) => void;
  private onMapContextMenu?: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void;
  private readonly handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!this.onMapContextMenu || !this.maplibreMap) return;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const lngLat = this.maplibreMap.unproject([x, y]);
    if (!Number.isFinite(lngLat.lng)) return;
    this.onMapContextMenu({
      lat: lngLat.lat,
      lon: lngLat.lng,
      screenX: e.clientX,
      screenY: e.clientY,
      countryCode: this.hoveredCountryIso2 ?? undefined,
      countryName: this.hoveredCountryName ?? undefined,
    });
  };
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void;
  private onStateChange?: (state: DeckMapState) => void;
  private onAircraftPositionsUpdate?: (positions: PositionSample[]) => void;

  // Highlighted assets
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    base: new Set(),
    nuclear: new Set(),
  };

  private renderRafId: number | null = null;
  private renderPaused = false;
  private renderPending = false;
  private webglLost = false;
  private usedFallbackStyle = false;
  private styleLoadTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private tileMonitorGeneration = 0;


  private layerCache: Map<string, Layer> = new Map();
  private lastZoomThreshold = 0;
  private protestSC: Supercluster | null = null;
  private techHQSC: Supercluster | null = null;
  private techEventSC: Supercluster | null = null;
  private datacenterSC: Supercluster | null = null;
  private datacenterSCSource: AIDataCenter[] = [];
  private protestClusters: MapProtestCluster[] = [];
  private techHQClusters: MapTechHQCluster[] = [];
  private techEventClusters: MapTechEventCluster[] = [];
  private datacenterClusters: MapDatacenterCluster[] = [];
  private lastSCZoom = -1;
  private lastSCBoundsKey = '';
  private lastSCMask = '';
  private protestSuperclusterSource: SocialUnrestEvent[] = [];
  private newsPulseIntervalId: ReturnType<typeof setInterval> | null = null;
  private dayNightIntervalId: ReturnType<typeof setInterval> | null = null;
  private cachedNightPolygon: [number, number][] | null = null;
  private radarRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private radarActive = false;
  private radarTileUrl = '';
  private readonly startupTime = Date.now();
  private lastCableHighlightSignature = '';
  private lastCableHealthSignature = '';
  private lastPipelineHighlightSignature = '';
  private debouncedRebuildLayers: (() => void) & { cancel(): void };
  private debouncedFetchBases: (() => void) & { cancel(): void };
  private debouncedFetchAircraft: (() => void) & { cancel(): void };
  private rafUpdateLayers: (() => void) & { cancel(): void };
  private handleThemeChange: () => void;
  private handleMapThemeChange: () => void;
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Target center set eagerly by setView() so getCenter() returns the correct
   *  destination before moveend fires, preventing stale intermediate coords
   *  from being written to the URL during flyTo. Cleared on moveend. */
  private pendingCenter: { lat: number; lon: number } | null = null;
  private lastAircraftFetchCenter: [number, number] | null = null;
  private lastAircraftFetchZoom = -1;
  private aircraftFetchSeq = 0;

  constructor(container: HTMLElement, initialState: DeckMapState) {
    this.container = container;
    this.state = {
      ...initialState,
      pan: { ...initialState.pan },
      layers: normalizeExclusiveChoropleths(initialState.layers, null),
    };
    this.hotspots = [...INTEL_HOTSPOTS];

    this.debouncedRebuildLayers = debounce(() => {
      if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
      this.maplibreMap.resize();
      try { this.deckOverlay?.setProps({ layers: this.buildLayers() }); } catch { /* map mid-teardown */ }
      this.maplibreMap.triggerRepaint();
    }, 150);
    this.debouncedFetchBases = debounce(() => this.fetchServerBases(), 300);
    this.debouncedFetchAircraft = debounce(() => this.fetchViewportAircraft(), 500);
    this.rafUpdateLayers = rafSchedule(() => {
      if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
      try { this.deckOverlay?.setProps({ layers: this.buildLayers() }); } catch { /* map mid-teardown */ }
      this.maplibreMap?.triggerRepaint();
    });

    this.setupDOM();
    this.popup = new MapPopup(container);

    this.handleThemeChange = () => {
      if (isHappyVariant) {
        this.switchBasemap();
        return;
      }
      const provider = getMapProvider();
      const mapTheme = getMapTheme(provider);
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    };
    window.addEventListener('theme-changed', this.handleThemeChange);

    this.handleMapThemeChange = () => {
      this.switchBasemap();
    };
    window.addEventListener('map-theme-changed', this.handleMapThemeChange);

    this.initMapLibre();

    this.maplibreMap?.on('load', () => {
      localizeMapLabels(this.maplibreMap);
      this.initDeck();
      this.loadCountryBoundaries();
      this.fetchServerBases();
      this.render();
    });

    this.createControls();
    this.createTimeSlider();
    this.createLayerToggles();
    this.createLegend();

    // Start day/night timer only if layer is initially enabled
    if (this.state.layers.dayNight) {
      this.startDayNightTimer();
    }
    if (this.state.layers.weather) {
      this.startWeatherRadar();
    }
    // Kick off lazy APT load if cyberThreats is already on at init (e.g. from URL/localStorage)
    if (this.state.layers.cyberThreats && SITE_VARIANT !== 'tech' && SITE_VARIANT !== 'happy') {
      this.loadAptGroups();
    }
  }

  private startDayNightTimer(): void {
    if (this.dayNightIntervalId) return;
    this.cachedNightPolygon = this.computeNightPolygon();
    this.dayNightIntervalId = setInterval(() => {
      this.cachedNightPolygon = this.computeNightPolygon();
      this.render();
    }, 5 * 60 * 1000);
  }

  private stopDayNightTimer(): void {
    if (this.dayNightIntervalId) {
      clearInterval(this.dayNightIntervalId);
      this.dayNightIntervalId = null;
    }
    this.cachedNightPolygon = null;
  }

  private startWeatherRadar(): void {
    this.radarActive = true;
    this.fetchAndApplyRadar();
    if (!this.radarRefreshIntervalId) {
      this.radarRefreshIntervalId = setInterval(() => this.fetchAndApplyRadar(), 5 * 60 * 1000);
    }
  }

  private stopWeatherRadar(): void {
    this.radarActive = false;
    if (this.radarRefreshIntervalId) {
      clearInterval(this.radarRefreshIntervalId);
      this.radarRefreshIntervalId = null;
    }
    this.removeRadarLayer();
  }

  private fetchAndApplyRadar(): void {
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then(r => r.json())
      .then((data: { host: string; radar: { past: Array<{ path: string }> } }) => {
        const past = data.radar?.past;
        const latest = past?.[past.length - 1];
        if (!latest) return;
        this.radarTileUrl = `${data.host}${latest.path}/256/{z}/{x}/{y}/6/1_1.png`;
        this.applyRadarLayer();
      })
      .catch((err) => console.warn('[DeckGLMap] weather radar fetch failed:', err?.message || err));
  }

  private applyRadarLayer(): void {
    if (!this.maplibreMap || !this.radarActive || !this.radarTileUrl) return;
    if (!this.maplibreMap.isStyleLoaded()) {
      this.maplibreMap.once('style.load', () => this.applyRadarLayer());
      return;
    }
    try {
      const existing = this.maplibreMap.getSource('weather-radar') as (maplibregl.RasterTileSource & { setTiles: (tiles: string[]) => void }) | undefined;
      if (existing) {
        existing.setTiles([this.radarTileUrl]);
        return;
      }
      this.maplibreMap.addSource('weather-radar', {
        type: 'raster',
        tiles: [this.radarTileUrl],
        tileSize: 256,
        attribution: '© RainViewer',
      });
      const beforeId = this.maplibreMap.getLayer('country-interactive') ? 'country-interactive' : undefined;
      this.maplibreMap.addLayer({
        id: 'weather-radar-layer',
        type: 'raster',
        source: 'weather-radar',
        paint: { 'raster-opacity': 0.65 },
      }, beforeId);
    } catch (err) { console.warn('[DeckGLMap] radar layer apply failed:', (err as Error)?.message); }
  }

  private removeRadarLayer(): void {
    if (!this.maplibreMap) return;
    try {
      if (this.maplibreMap.getLayer('weather-radar-layer')) this.maplibreMap.removeLayer('weather-radar-layer');
      if (this.maplibreMap.getSource('weather-radar')) this.maplibreMap.removeSource('weather-radar');
    } catch { /* ignore */ }
  }

  private setupDOM(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'deckgl-map-wrapper';
    wrapper.id = 'deckglMapWrapper';
    wrapper.style.cssText = 'position: relative; width: 100%; height: 100%; overflow: hidden;';

    // MapLibre container - deck.gl renders directly into MapLibre via MapboxOverlay
    const mapContainer = document.createElement('div');
    mapContainer.id = 'deckgl-basemap';
    mapContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%;';
    wrapper.appendChild(mapContainer);

    const attribution = document.createElement('div');
    attribution.className = 'map-attribution';
    attribution.innerHTML = isHappyVariant
      ? '© <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      : '© <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    wrapper.appendChild(attribution);

    this.container.appendChild(wrapper);
  }

  private initMapLibre(): void {
    if (maplibregl.getRTLTextPluginStatus() === 'unavailable') {
      maplibregl.setRTLTextPlugin(
        '/mapbox-gl-rtl-text.min.js',
        true,
      );
    }

    const initialProvider = isHappyVariant ? 'openfreemap' as const : getMapProvider();
    if (initialProvider === 'pmtiles' || initialProvider === 'auto') registerPMTilesProtocol();

    const preset = VIEW_PRESETS[this.state.view];
    const initialMapTheme = getMapTheme(initialProvider);
    const primaryStyle = isHappyVariant
      ? (getCurrentTheme() === 'light' ? HAPPY_LIGHT_STYLE : HAPPY_DARK_STYLE)
      : getStyleForProvider(initialProvider, initialMapTheme);
    if (!isHappyVariant && typeof primaryStyle === 'string' && !primaryStyle.includes('pmtiles')) {
      this.usedFallbackStyle = true;
      const attr = this.container.querySelector('.map-attribution');
      if (attr) attr.innerHTML = '© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    }

    const basemapEl = document.getElementById('deckgl-basemap');
    if (!basemapEl) return;

    this.maplibreMap = new maplibregl.Map({
      container: basemapEl,
      style: primaryStyle,
      center: [preset.longitude, preset.latitude],
      zoom: preset.zoom,
      renderWorldCopies: false,
      attributionControl: false,
      interactive: true,
      canvasContextAttributes: { powerPreference: 'high-performance' },
      ...(MAP_INTERACTION_MODE === 'flat'
        ? {
          maxPitch: 0,
          pitchWithRotate: false,
          dragRotate: false,
          touchPitch: false,
        }
        : {}),
    });

    const recreateWithFallback = () => {
      if (this.usedFallbackStyle) return;
      this.usedFallbackStyle = true;
      const fallback = isLightMapTheme(initialMapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
      console.warn(`[DeckGLMap] Primary basemap failed, recreating with fallback: ${fallback}`);
      const attr = this.container.querySelector('.map-attribution');
      if (attr) attr.innerHTML = '© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
      this.maplibreMap?.remove();
      const fallbackEl = document.getElementById('deckgl-basemap');
      if (!fallbackEl) return;
      this.maplibreMap = new maplibregl.Map({
        container: fallbackEl,
        style: fallback,
        center: [preset.longitude, preset.latitude],
        zoom: preset.zoom,
        renderWorldCopies: false,
        attributionControl: false,
        interactive: true,
        canvasContextAttributes: { powerPreference: 'high-performance' },
        ...(MAP_INTERACTION_MODE === 'flat'
          ? {
            maxPitch: 0,
            pitchWithRotate: false,
            dragRotate: false,
            touchPitch: false,
          }
          : {}),
      });
      this.maplibreMap.on('load', () => {
        localizeMapLabels(this.maplibreMap);
        this.initDeck();
        this.loadCountryBoundaries();
        this.fetchServerBases();
        this.render();
      });
    };

    let tileLoadOk = false;
    let tileErrorCount = 0;

    this.maplibreMap.on('error', (e: { error?: Error; message?: string }) => {
      const msg = e.error?.message ?? e.message ?? '';
      console.warn('[DeckGLMap] map error:', msg);
      if (msg.includes('Failed to fetch') || msg.includes('AJAXError') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('403') || msg.includes('Forbidden')) {
        tileErrorCount++;
        if (!tileLoadOk && tileErrorCount >= 2) {
          recreateWithFallback();
        }
      }
    });

    this.maplibreMap.on('data', (e: { dataType?: string }) => {
      if (e.dataType === 'source') {
        tileLoadOk = true;
        if (this.styleLoadTimeoutId) {
          clearTimeout(this.styleLoadTimeoutId);
          this.styleLoadTimeoutId = null;
        }
      }
    });

    this.styleLoadTimeoutId = setTimeout(() => {
      this.styleLoadTimeoutId = null;
      if (!tileLoadOk) recreateWithFallback();
    }, 10000);

    const canvas = this.maplibreMap.getCanvas();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.webglLost = true;
      console.warn('[DeckGLMap] WebGL context lost — will restore when browser recovers');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.webglLost = false;
      console.info('[DeckGLMap] WebGL context restored');
      this.maplibreMap?.triggerRepaint();
    });

    // Pin top edge during drag-resize: correct center shift synchronously
    // inside MapLibre's own resize() call (before it renders the frame).
    this.maplibreMap.on('move', () => {
      if (this.correctingCenter || !this.isResizing || !this.maplibreMap) return;
      if (this.savedTopLat === null) return;

      const w = this.maplibreMap.getCanvas().clientWidth;
      if (w <= 0) return;
      const currentTop = this.maplibreMap.unproject([w / 2, 0]).lat;
      const delta = this.savedTopLat - currentTop;

      if (Math.abs(delta) > 1e-6) {
        this.correctingCenter = true;
        const c = this.maplibreMap.getCenter();
        const clampedLat = Math.max(-90, Math.min(90, c.lat + delta));
        this.maplibreMap.jumpTo({ center: [c.lng, clampedLat] });
        this.correctingCenter = false;
        // Do NOT update savedTopLat — keep the original mousedown position
        // so every frame targets the exact same geographic anchor.
      }
    });

    this.maplibreMap.getCanvas().addEventListener('contextmenu', this.handleContextMenu);
  }

  private initDeck(): void {
    if (!this.maplibreMap) return;

    this.deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: this.buildLayers(),
      getTooltip: (info: PickingInfo) => this.getTooltip(info),
      onClick: (info: PickingInfo) => this.handleClick(info),
      pickingRadius: 10,
      useDevicePixels: window.devicePixelRatio > 2 ? 2 : true,
      onError: (error: Error) => {
        console.warn('[DeckGLMap] Render error (non-fatal):', error.message);
        if (error.message.includes('apt-groups-layer')) {
          this.aptGroupsLayerFailed = true;
        }
        if (error.message.includes('satellite-imagery-layer')) {
          this.satelliteImageryLayerFailed = true;
          console.warn('[DeckGLMap] Satellite imagery layer failed (likely Intel GPU driver incompatibility) — rebuilding layer stack without it');
          try { this.deckOverlay?.setProps({ layers: this.buildLayers() }); } catch { /* map mid-teardown */ }
        }
      },
    });

    this.maplibreMap.addControl(this.deckOverlay as unknown as maplibregl.IControl);

    this.maplibreMap.on('movestart', () => {
      if (this.moveTimeoutId) {
        clearTimeout(this.moveTimeoutId);
        this.moveTimeoutId = null;
      }
    });

    this.maplibreMap.on('moveend', () => {
      this.pendingCenter = null;
      this.lastSCZoom = -1;
      this.rafUpdateLayers();
      this.debouncedFetchBases();
      this.debouncedFetchAircraft();
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      this.onStateChange?.(this.getState());
      if (this.state.layers.satellites) {
        if (this.imagerySearchTimer) clearTimeout(this.imagerySearchTimer);
        this.imagerySearchTimer = setTimeout(() => this.fetchImageryForViewport(), 500);
      }
    });

    this.maplibreMap.on('move', () => {
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = setTimeout(() => {
        this.lastSCZoom = -1;
        this.rafUpdateLayers();
      }, 100);
    });

    this.maplibreMap.on('zoom', () => {
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = setTimeout(() => {
        this.lastSCZoom = -1;
        this.rafUpdateLayers();
      }, 100);
    });

    this.maplibreMap.on('zoomend', () => {
      const currentZoom = Math.floor(this.maplibreMap?.getZoom() || 2);
      const thresholdCrossed = Math.abs(currentZoom - this.lastZoomThreshold) >= 1;
      if (thresholdCrossed) {
        this.lastZoomThreshold = currentZoom;
        this.debouncedRebuildLayers();
      }
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      this.onStateChange?.(this.getState());
    });
  }

  public setIsResizing(value: boolean): void {
    this.isResizing = value;
    if (value && this.maplibreMap) {
      const w = this.maplibreMap.getCanvas().clientWidth;
      if (w > 0) {
        this.savedTopLat = this.maplibreMap.unproject([w / 2, 0]).lat;
      }
    } else {
      this.savedTopLat = null;
    }
  }

  public resize(): void {
    this.maplibreMap?.resize();
  }

  private getSetSignature(set: Set<string>): string {
    return [...set].sort().join('|');
  }

  private hasRecentNews(now = Date.now()): boolean {
    for (const ts of this.newsLocationFirstSeen.values()) {
      if (now - ts < 30_000) return true;
    }
    return false;
  }

  private getTimeRangeMs(range: TimeRange = this.state.timeRange): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[range];
  }

  private parseTime(value: Date | string | number | undefined | null): number | null {
    if (value == null) return null;
    const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  private filterByTime<T>(
    items: T[],
    getTime: (item: T) => Date | string | number | undefined | null
  ): T[] {
    if (this.state.timeRange === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeMs();
    return items.filter((item) => {
      const ts = this.parseTime(getTime(item));
      return ts == null ? true : ts >= cutoff;
    });
  }

  private _timeFilterCache = new WeakMap<object, { min: number; range: TimeRange; result: unknown[] }>();

  private filterByTimeCached<T>(
    items: T[],
    getTime: (item: T) => Date | string | number | undefined | null
  ): T[] {
    const min = Math.floor(Date.now() / 60000);
    const range = this.state.timeRange;
    const cached = this._timeFilterCache.get(items as object);
    if (cached && cached.min === min && cached.range === range) return cached.result as T[];
    const result = this.filterByTime(items, getTime);
    this._timeFilterCache.set(items as object, { min, range, result });
    return result;
  }

  private filterMilitaryFlightClustersByTimeCached(clusters: MilitaryFlightCluster[]): MilitaryFlightCluster[] {
    const min = Math.floor(Date.now() / 60000);
    const range = this.state.timeRange;
    const cached = this._timeFilterCache.get(clusters as object);
    if (cached && cached.min === min && cached.range === range) return cached.result as MilitaryFlightCluster[];
    const result = this.filterMilitaryFlightClustersByTime(clusters);
    this._timeFilterCache.set(clusters as object, { min, range, result });
    return result;
  }

  private filterMilitaryVesselClustersByTimeCached(clusters: MilitaryVesselCluster[]): MilitaryVesselCluster[] {
    const min = Math.floor(Date.now() / 60000);
    const range = this.state.timeRange;
    const cached = this._timeFilterCache.get(clusters as object);
    if (cached && cached.min === min && cached.range === range) return cached.result as MilitaryVesselCluster[];
    const result = this.filterMilitaryVesselClustersByTime(clusters);
    this._timeFilterCache.set(clusters as object, { min, range, result });
    return result;
  }

  private getFilteredProtests(): SocialUnrestEvent[] {
    return this.filterByTime(this.protests, (event) => event.time);
  }

  private filterMilitaryFlightClustersByTime(clusters: MilitaryFlightCluster[]): MilitaryFlightCluster[] {
    return clusters
      .map((cluster) => {
        const flights = this.filterByTime(cluster.flights ?? [], (flight) => flight.lastSeen);
        if (flights.length === 0) return null;
        return {
          ...cluster,
          flights,
          flightCount: flights.length,
        };
      })
      .filter((cluster): cluster is MilitaryFlightCluster => cluster !== null);
  }

  private filterMilitaryVesselClustersByTime(clusters: MilitaryVesselCluster[]): MilitaryVesselCluster[] {
    return clusters
      .map((cluster) => {
        const vessels = this.filterByTime(cluster.vessels ?? [], (vessel) => vessel.lastAisUpdate);
        if (vessels.length === 0) return null;
        return {
          ...cluster,
          vessels,
          vesselCount: vessels.length,
        };
      })
      .filter((cluster): cluster is MilitaryVesselCluster => cluster !== null);
  }

  private rebuildProtestSupercluster(source: SocialUnrestEvent[] = this.getFilteredProtests()): void {
    this.protestSuperclusterSource = source;
    const points = source.map((p, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] as [number, number] },
      properties: {
        index: i,
        country: p.country,
        severity: p.severity,
        eventType: p.eventType,
        sourceType: p.sourceType,
        validated: Boolean(p.validated),
        fatalities: Number.isFinite(p.fatalities) ? Number(p.fatalities) : 0,
        timeMs: p.time.getTime(),
      },
    }));
    this.protestSC = new Supercluster({
      radius: 60,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        country: String(props.country ?? ''),
        maxSeverityRank: props.severity === 'high' ? 2 : props.severity === 'medium' ? 1 : 0,
        riotCount: props.eventType === 'riot' ? 1 : 0,
        highSeverityCount: props.severity === 'high' ? 1 : 0,
        verifiedCount: props.validated ? 1 : 0,
        totalFatalities: Number(props.fatalities ?? 0) || 0,
        riotTimeMs: props.eventType === 'riot' && props.sourceType !== 'gdelt' && Number.isFinite(Number(props.timeMs)) ? Number(props.timeMs) : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.maxSeverityRank = Math.max(Number(acc.maxSeverityRank ?? 0), Number(props.maxSeverityRank ?? 0));
        acc.riotCount = Number(acc.riotCount ?? 0) + Number(props.riotCount ?? 0);
        acc.highSeverityCount = Number(acc.highSeverityCount ?? 0) + Number(props.highSeverityCount ?? 0);
        acc.verifiedCount = Number(acc.verifiedCount ?? 0) + Number(props.verifiedCount ?? 0);
        acc.totalFatalities = Number(acc.totalFatalities ?? 0) + Number(props.totalFatalities ?? 0);
        const accRiot = Number(acc.riotTimeMs ?? 0);
        const propRiot = Number(props.riotTimeMs ?? 0);
        acc.riotTimeMs = Number.isFinite(propRiot) ? Math.max(accRiot, propRiot) : accRiot;
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.protestSC.load(points);
    this.lastSCZoom = -1;
  }

  private rebuildTechHQSupercluster(): void {
    const points = TECH_HQS.map((h, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [h.lon, h.lat] as [number, number] },
      properties: {
        index: i,
        city: h.city,
        country: h.country,
        type: h.type,
      },
    }));
    this.techHQSC = new Supercluster({
      radius: 50,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        city: String(props.city ?? ''),
        country: String(props.country ?? ''),
        faangCount: props.type === 'faang' ? 1 : 0,
        unicornCount: props.type === 'unicorn' ? 1 : 0,
        publicCount: props.type === 'public' ? 1 : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.faangCount = Number(acc.faangCount ?? 0) + Number(props.faangCount ?? 0);
        acc.unicornCount = Number(acc.unicornCount ?? 0) + Number(props.unicornCount ?? 0);
        acc.publicCount = Number(acc.publicCount ?? 0) + Number(props.publicCount ?? 0);
        if (!acc.city && props.city) acc.city = props.city;
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.techHQSC.load(points);
    this.lastSCZoom = -1;
  }

  private rebuildTechEventSupercluster(): void {
    const points = this.techEvents.map((e, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [e.lng, e.lat] as [number, number] },
      properties: {
        index: i,
        location: e.location,
        country: e.country,
        daysUntil: e.daysUntil,
      },
    }));
    this.techEventSC = new Supercluster({
      radius: 50,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => {
        const daysUntil = Number(props.daysUntil ?? Number.MAX_SAFE_INTEGER);
        return {
          index: Number(props.index ?? 0),
          location: String(props.location ?? ''),
          country: String(props.country ?? ''),
          soonestDaysUntil: Number.isFinite(daysUntil) ? daysUntil : Number.MAX_SAFE_INTEGER,
          soonCount: Number.isFinite(daysUntil) && daysUntil <= 14 ? 1 : 0,
        };
      },
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.soonestDaysUntil = Math.min(
          Number(acc.soonestDaysUntil ?? Number.MAX_SAFE_INTEGER),
          Number(props.soonestDaysUntil ?? Number.MAX_SAFE_INTEGER),
        );
        acc.soonCount = Number(acc.soonCount ?? 0) + Number(props.soonCount ?? 0);
        if (!acc.location && props.location) acc.location = props.location;
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.techEventSC.load(points);
    this.lastSCZoom = -1;
  }

  private rebuildDatacenterSupercluster(): void {
    const activeDCs = AI_DATA_CENTERS.filter(dc => dc.status !== 'decommissioned');
    this.datacenterSCSource = activeDCs;
    const points = activeDCs.map((dc, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [dc.lon, dc.lat] as [number, number] },
      properties: {
        index: i,
        country: dc.country,
        chipCount: dc.chipCount,
        powerMW: dc.powerMW ?? 0,
        status: dc.status,
      },
    }));
    this.datacenterSC = new Supercluster({
      radius: 70,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        country: String(props.country ?? ''),
        totalChips: Number(props.chipCount ?? 0) || 0,
        totalPowerMW: Number(props.powerMW ?? 0) || 0,
        existingCount: props.status === 'existing' ? 1 : 0,
        plannedCount: props.status === 'planned' ? 1 : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.totalChips = Number(acc.totalChips ?? 0) + Number(props.totalChips ?? 0);
        acc.totalPowerMW = Number(acc.totalPowerMW ?? 0) + Number(props.totalPowerMW ?? 0);
        acc.existingCount = Number(acc.existingCount ?? 0) + Number(props.existingCount ?? 0);
        acc.plannedCount = Number(acc.plannedCount ?? 0) + Number(props.plannedCount ?? 0);
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.datacenterSC.load(points);
    this.lastSCZoom = -1;
  }

  private updateClusterData(): void {
    const zoom = Math.floor(this.maplibreMap?.getZoom() ?? 2);
    const bounds = this.maplibreMap?.getBounds();
    if (!bounds) return;
    const bbox: [number, number, number, number] = [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ];
    const boundsKey = `${bbox[0].toFixed(4)}:${bbox[1].toFixed(4)}:${bbox[2].toFixed(4)}:${bbox[3].toFixed(4)}`;
    const layers = this.state.layers;
    const useProtests = layers.protests && this.protestSuperclusterSource.length > 0;
    const useTechHQ = SITE_VARIANT === 'tech' && layers.techHQs;
    const useTechEvents = SITE_VARIANT === 'tech' && layers.techEvents && this.techEvents.length > 0;
    const useDatacenterClusters = layers.datacenters && zoom < 5;
    const layerMask = `${Number(useProtests)}${Number(useTechHQ)}${Number(useTechEvents)}${Number(useDatacenterClusters)}`;
    if (zoom === this.lastSCZoom && boundsKey === this.lastSCBoundsKey && layerMask === this.lastSCMask) return;
    this.lastSCZoom = zoom;
    this.lastSCBoundsKey = boundsKey;
    this.lastSCMask = layerMask;

    if (useTechHQ && !this.techHQSC) this.rebuildTechHQSupercluster();
    if (useDatacenterClusters && !this.datacenterSC) this.rebuildDatacenterSupercluster();

    if (useProtests && this.protestSC) {
      this.protestClusters = this.protestSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const maxSeverityRank = Number(props.maxSeverityRank ?? 0);
          const maxSev = maxSeverityRank >= 2 ? 'high' : maxSeverityRank === 1 ? 'medium' : 'low';
          const riotCount = Number(props.riotCount ?? 0);
          const highSeverityCount = Number(props.highSeverityCount ?? 0);
          const verifiedCount = Number(props.verifiedCount ?? 0);
          const totalFatalities = Number(props.totalFatalities ?? 0);
          const clusterCount = Number(f.properties.point_count ?? 0);
          const riotTimeMs = Number(props.riotTimeMs ?? 0);
          return {
            id: `pc-${f.properties.cluster_id}`,
            _clusterId: f.properties.cluster_id!,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items: [] as SocialUnrestEvent[],
            country: String(props.country ?? ''),
            maxSeverity: maxSev as 'low' | 'medium' | 'high',
            hasRiot: riotCount > 0,
            latestRiotEventTimeMs: riotTimeMs || undefined,
            totalFatalities,
            riotCount,
            highSeverityCount,
            verifiedCount,
            sampled: clusterCount > DeckGLMap.MAX_CLUSTER_LEAVES,
          };
        }
        const item = this.protestSuperclusterSource[f.properties.index]!;
        return {
          id: `pp-${f.properties.index}`, lat: item.lat, lon: item.lon,
          count: 1, items: [item], country: item.country,
          maxSeverity: item.severity, hasRiot: item.eventType === 'riot',
          latestRiotEventTimeMs:
            item.eventType === 'riot' && item.sourceType !== 'gdelt' && Number.isFinite(item.time.getTime())
              ? item.time.getTime()
              : undefined,
          totalFatalities: item.fatalities ?? 0,
          riotCount: item.eventType === 'riot' ? 1 : 0,
          highSeverityCount: item.severity === 'high' ? 1 : 0,
          verifiedCount: item.validated ? 1 : 0,
          sampled: false,
        };
      });
    } else {
      this.protestClusters = [];
    }

    if (useTechHQ && this.techHQSC) {
      this.techHQClusters = this.techHQSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const faangCount = Number(props.faangCount ?? 0);
          const unicornCount = Number(props.unicornCount ?? 0);
          const publicCount = Number(props.publicCount ?? 0);
          const clusterCount = Number(f.properties.point_count ?? 0);
          const primaryType = faangCount >= unicornCount && faangCount >= publicCount
            ? 'faang'
            : unicornCount >= publicCount
              ? 'unicorn'
              : 'public';
          return {
            id: `hc-${f.properties.cluster_id}`,
            _clusterId: f.properties.cluster_id!,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items: [] as import('@/config/tech-geo').TechHQ[],
            city: String(props.city ?? ''),
            country: String(props.country ?? ''),
            primaryType,
            faangCount,
            unicornCount,
            publicCount,
            sampled: clusterCount > DeckGLMap.MAX_CLUSTER_LEAVES,
          };
        }
        const item = TECH_HQS[f.properties.index]!;
        return {
          id: `hp-${f.properties.index}`, lat: item.lat, lon: item.lon,
          count: 1, items: [item], city: item.city, country: item.country,
          primaryType: item.type,
          faangCount: item.type === 'faang' ? 1 : 0,
          unicornCount: item.type === 'unicorn' ? 1 : 0,
          publicCount: item.type === 'public' ? 1 : 0,
          sampled: false,
        };
      });
    } else {
      this.techHQClusters = [];
    }

    if (useTechEvents && this.techEventSC) {
      this.techEventClusters = this.techEventSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const clusterCount = Number(f.properties.point_count ?? 0);
          const soonestDaysUntil = Number(props.soonestDaysUntil ?? Number.MAX_SAFE_INTEGER);
          const soonCount = Number(props.soonCount ?? 0);
          return {
            id: `ec-${f.properties.cluster_id}`,
            _clusterId: f.properties.cluster_id!,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items: [] as TechEventMarker[],
            location: String(props.location ?? ''),
            country: String(props.country ?? ''),
            soonestDaysUntil: Number.isFinite(soonestDaysUntil) ? soonestDaysUntil : Number.MAX_SAFE_INTEGER,
            soonCount,
            sampled: clusterCount > DeckGLMap.MAX_CLUSTER_LEAVES,
          };
        }
        const item = this.techEvents[f.properties.index]!;
        return {
          id: `ep-${f.properties.index}`, lat: item.lat, lon: item.lng,
          count: 1, items: [item], location: item.location, country: item.country,
          soonestDaysUntil: item.daysUntil,
          soonCount: item.daysUntil <= 14 ? 1 : 0,
          sampled: false,
        };
      });
    } else {
      this.techEventClusters = [];
    }

    if (useDatacenterClusters && this.datacenterSC) {
      const activeDCs = this.datacenterSCSource;
      this.datacenterClusters = this.datacenterSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const clusterCount = Number(f.properties.point_count ?? 0);
          const existingCount = Number(props.existingCount ?? 0);
          const plannedCount = Number(props.plannedCount ?? 0);
          const totalChips = Number(props.totalChips ?? 0);
          const totalPowerMW = Number(props.totalPowerMW ?? 0);
          return {
            id: `dc-${f.properties.cluster_id}`,
            _clusterId: f.properties.cluster_id!,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items: [] as AIDataCenter[],
            region: String(props.country ?? ''),
            country: String(props.country ?? ''),
            totalChips,
            totalPowerMW,
            majorityExisting: existingCount >= Math.max(1, clusterCount / 2),
            existingCount,
            plannedCount,
            sampled: clusterCount > DeckGLMap.MAX_CLUSTER_LEAVES,
          };
        }
        const item = activeDCs[f.properties.index]!;
        return {
          id: `dp-${f.properties.index}`, lat: item.lat, lon: item.lon,
          count: 1, items: [item], region: item.country, country: item.country,
          totalChips: item.chipCount, totalPowerMW: item.powerMW ?? 0,
          majorityExisting: item.status === 'existing',
          existingCount: item.status === 'existing' ? 1 : 0,
          plannedCount: item.status === 'planned' ? 1 : 0,
          sampled: false,
        };
      });
    } else {
      this.datacenterClusters = [];
    }
  }




  private isLayerVisible(layerKey: keyof MapLayers): boolean {
    const threshold = LAYER_ZOOM_THRESHOLDS[layerKey];
    if (!threshold) return true;
    const zoom = this.maplibreMap?.getZoom() || 2;
    return zoom >= threshold.minZoom;
  }

  private buildLayers(): LayersList {
    const startTime = performance.now();
    // Refresh theme-aware overlay colors on each rebuild
    COLORS = getOverlayColors();
    const layers: (Layer | null | false)[] = [];
    const { layers: mapLayers } = this.state;
    const filteredEarthquakes = mapLayers.natural ? this.filterByTimeCached(this.earthquakes, (eq) => eq.occurredAt) : [];
    const filteredNaturalEvents = mapLayers.natural ? this.filterByTimeCached(this.naturalEvents, (event) => event.date) : [];
    const filteredDiseaseOutbreaks = mapLayers.diseaseOutbreaks ? this.filterByTimeCached(this.diseaseOutbreaks, (item) => item.publishedAt) : [];
    const filteredRadiationObservations = mapLayers.radiationWatch ? this.filterByTimeCached(this.radiationObservations, (obs) => obs.observedAt) : [];
    const filteredPositiveEvents = mapLayers.positiveEvents ? this.filterByTimeCached(this.positiveEvents, (e) => e.timestamp) : [];
    const filteredIranEvents = mapLayers.iranAttacks ? this.filterByTimeCached(this.iranEvents, (e) => e.timestamp) : [];
    const filteredFirmsFireData = mapLayers.fires ? this.filterByTimeCached(this.firmsFireData, (d) => d.acq_date) : [];
    const filteredTrafficAnomalies = mapLayers.outages ? this.filterByTimeCached(this.trafficAnomalies, (a) => a.startDate) : [];
    const filteredKindnessPoints = mapLayers.kindness ? this.filterByTimeCached(this.kindnessPoints, (p) => p.timestamp) : [];
    const filteredImageryScenes = mapLayers.satellites ? this.filterByTimeCached(this.imageryScenes, (s) => s.datetime) : [];
    const filteredWeatherAlerts = mapLayers.weather ? this.filterByTimeCached(this.weatherAlerts, (alert) => alert.onset) : [];
    const filteredOutages = mapLayers.outages ? this.filterByTimeCached(this.outages, (outage) => outage.pubDate) : [];
    const filteredCableAdvisories = mapLayers.cables ? this.filterByTimeCached(this.cableAdvisories, (advisory) => advisory.reported) : [];
    const filteredFlightDelays = mapLayers.flights ? this.filterByTimeCached(this.flightDelays, (delay) => delay.updatedAt) : [];
    const filteredMilitaryFlights = mapLayers.military ? this.filterByTimeCached(this.militaryFlights, (flight) => flight.lastSeen) : [];
    const filteredMilitaryVessels = mapLayers.military ? this.filterByTimeCached(this.militaryVessels, (vessel) => vessel.lastAisUpdate) : [];
    const filteredMilitaryFlightClusters = mapLayers.military ? this.filterMilitaryFlightClustersByTimeCached(this.militaryFlightClusters) : [];
    const filteredMilitaryVesselClusters = mapLayers.military ? this.filterMilitaryVesselClustersByTimeCached(this.militaryVesselClusters) : [];
    // UCDP is a historical dataset (events aged months); time-range filter always zeroes it out
    const filteredUcdpEvents = mapLayers.ucdpEvents ? this.ucdpEvents : [];

    // Day/night overlay (rendered first as background)
    if (mapLayers.dayNight) {
      if (!this.dayNightIntervalId) this.startDayNightTimer();
      layers.push(this.createDayNightLayer());
    } else {
      if (this.dayNightIntervalId) this.stopDayNightTimer();
      this.layerCache.delete('day-night-layer');
    }

    // Undersea cables layer
    if (mapLayers.cables) {
      layers.push(this.createCablesLayer());
    } else {
      this.layerCache.delete('cables-layer');
    }

    // Pipelines layer
    if (mapLayers.pipelines) {
      layers.push(this.createPipelinesLayer());
    } else {
      this.layerCache.delete('pipelines-layer');
    }

    // Conflict zones layer
    if (mapLayers.conflicts) {
      layers.push(this.createConflictZonesLayer());
    }


    // Military bases layer — hidden at low zoom (E: progressive disclosure) + clusters
    if (mapLayers.bases && this.isLayerVisible('bases')) {
      layers.push(this.createBasesLayer());
      layers.push(...this.createBasesClusterLayer());
    }
    layers.push(this.createEmptyGhost('bases-layer'));

    // Nuclear facilities layer — hidden at low zoom
    if (mapLayers.nuclear && this.isLayerVisible('nuclear')) {
      layers.push(this.createNuclearLayer());
    }
    layers.push(this.createEmptyGhost('nuclear-layer'));

    // Gamma irradiators layer — hidden at low zoom
    if (mapLayers.irradiators && this.isLayerVisible('irradiators')) {
      layers.push(this.createIrradiatorsLayer());
    }

    // Spaceports layer — hidden at low zoom
    if (mapLayers.spaceports && this.isLayerVisible('spaceports')) {
      layers.push(this.createSpaceportsLayer());
    }

    // Hotspots layer (all hotspots including high/breaking, with pulse + ghost)
    if (mapLayers.hotspots) {
      layers.push(...this.createHotspotsLayers());
    }

    // Datacenters layer - SQUARE icons at zoom >= 5, cluster dots at zoom < 5
    const currentZoom = this.maplibreMap?.getZoom() || 2;
    if (mapLayers.datacenters) {
      if (currentZoom >= 5) {
        layers.push(this.createDatacentersLayer());
      } else {
        layers.push(...this.createDatacenterClusterLayers());
      }
    }

    // Earthquakes layer
    if (mapLayers.natural && filteredEarthquakes.length > 0) {
      layers.push(this.createEarthquakesLayer(filteredEarthquakes));
    }
    layers.push(this.createEmptyGhost('earthquakes-layer'));

    // Natural events layers (non-TC scatter + TC tracks/cones/centers)
    if (mapLayers.natural && filteredNaturalEvents.length > 0) {
      layers.push(...this.createNaturalEventsLayers(filteredNaturalEvents));
    }

    if (mapLayers.radiationWatch && filteredRadiationObservations.length > 0) {
      layers.push(this.createRadiationLayer(filteredRadiationObservations));
    }
    layers.push(this.createEmptyGhost('radiation-watch-layer'));

    // Disease outbreaks layer
    if (mapLayers.diseaseOutbreaks && filteredDiseaseOutbreaks.length > 0) {
      layers.push(this.createDiseaseOutbreaksLayer(filteredDiseaseOutbreaks));
    }
    layers.push(this.createEmptyGhost('disease-outbreaks-layer'));

    // Satellite fires layer (NASA FIRMS)
    if (mapLayers.fires && filteredFirmsFireData.length > 0) {
      layers.push(this.createFiresLayer(filteredFirmsFireData));
    }

    // Iran events layer
    if (mapLayers.iranAttacks && filteredIranEvents.length > 0) {
      layers.push(this.createIranEventsLayer(filteredIranEvents));
      layers.push(this.createGhostLayer('iran-events-layer', filteredIranEvents, d => [d.longitude, d.latitude], { radiusMinPixels: 12 }));
    }

    // Weather alerts layer
    if (mapLayers.weather && filteredWeatherAlerts.length > 0) {
      layers.push(this.createWeatherLayer(filteredWeatherAlerts));
    }

    // Internet outages layer
    if (mapLayers.outages && filteredOutages.length > 0) {
      layers.push(this.createOutagesLayer(filteredOutages));
    }
    layers.push(this.createEmptyGhost('outages-layer'));

    if (mapLayers.outages && filteredTrafficAnomalies.length > 0) {
      layers.push(this.createTrafficAnomaliesLayer(filteredTrafficAnomalies));
    }
    layers.push(this.createEmptyGhost('traffic-anomalies-layer'));

    if (mapLayers.outages && this.ddosLocations.length > 0) {
      layers.push(this.createDdosLocationsLayer(this.ddosLocations));
    }
    layers.push(this.createEmptyGhost('ddos-locations-layer'));

    // Cyber threat IOC layer
    if (mapLayers.cyberThreats && this.cyberThreats.length > 0) {
      layers.push(this.createCyberThreatsLayer());
    }
    layers.push(this.createEmptyGhost('cyber-threats-layer'));

    // AIS density layer
    if (mapLayers.ais && this.aisDensity.length > 0) {
      layers.push(this.createAisDensityLayer());
    }

    // AIS disruptions layer (spoofing/jamming)
    if (mapLayers.ais && this.aisDisruptions.length > 0) {
      layers.push(this.createAisDisruptionsLayer());
    }

    // GPS/GNSS jamming layer
    if (mapLayers.gpsJamming && this.gpsJammingHexes.length > 0) {
      layers.push(this.createGpsJammingLayer());
    }

    // Strategic ports layer (shown with AIS)
    if (mapLayers.ais) {
      layers.push(this.createPortsLayer());
    }

    // Cable advisories layer (shown with cables)
    if (mapLayers.cables && filteredCableAdvisories.length > 0) {
      layers.push(this.createCableAdvisoriesLayer(filteredCableAdvisories));
    }

    // Repair ships layer (shown with cables)
    if (mapLayers.cables && this.repairShips.length > 0) {
      layers.push(this.createRepairShipsLayer());
    }

    // Aviation layer (flight delays + NOTAM closures + aircraft positions)
    if (mapLayers.flights && filteredFlightDelays.length > 0) {
      layers.push(this.createFlightDelaysLayer(filteredFlightDelays));
      const closures = filteredFlightDelays.filter(d => d.delayType === 'closure');
      if (closures.length > 0) {
        layers.push(this.createNotamOverlayLayer(closures));
      }
    }

    // Aircraft positions layer (live tracking, under flights toggle)
    if (mapLayers.flights && this.aircraftPositions.length > 0) {
      layers.push(this.createAircraftPositionsLayer());
    }

    // Protests layer (Supercluster-based deck.gl layers)
    if (mapLayers.protests && this.protests.length > 0) {
      layers.push(...this.createProtestClusterLayers());
    }

    // Military vessels layer
    if (mapLayers.military && filteredMilitaryVessels.length > 0) {
      layers.push(this.createMilitaryVesselsLayer(filteredMilitaryVessels));
    }

    // Military vessel clusters layer
    if (mapLayers.military && filteredMilitaryVesselClusters.length > 0) {
      layers.push(this.createMilitaryVesselClustersLayer(filteredMilitaryVesselClusters));
    }

    // Military flight trails (rendered beneath dots)
    if (mapLayers.military && this.activeFlightTrails.size > 0 && filteredMilitaryFlights.length > 0) {
      layers.push(this.createMilitaryFlightTrailsLayer(filteredMilitaryFlights));
    }

    // Military flights layer
    if (mapLayers.military && filteredMilitaryFlights.length > 0) {
      layers.push(this.createMilitaryFlightsLayer(filteredMilitaryFlights));
    }

    // Military flight clusters layer
    if (mapLayers.military && filteredMilitaryFlightClusters.length > 0) {
      layers.push(this.createMilitaryFlightClustersLayer(filteredMilitaryFlightClusters));
    }

    // Strategic waterways layer
    if (mapLayers.waterways) {
      layers.push(this.createWaterwaysLayer());
    }

    // Economic centers layer — hidden at low zoom
    if (mapLayers.economic && this.isLayerVisible('economic')) {
      layers.push(this.createEconomicCentersLayer());
    }

    // Finance variant layers
    if (mapLayers.stockExchanges) {
      layers.push(this.createStockExchangesLayer());
    }
    if (mapLayers.financialCenters) {
      layers.push(this.createFinancialCentersLayer());
    }
    if (mapLayers.centralBanks) {
      layers.push(this.createCentralBanksLayer());
    }
    if (mapLayers.commodityHubs) {
      layers.push(this.createCommodityHubsLayer());
    }

    // Critical minerals layer
    if (mapLayers.minerals) {
      layers.push(this.createMineralsLayer());
    }

    // Commodity variant layers — mine sites, processing plants, export ports
    if (mapLayers.miningSites) {
      layers.push(this.createMiningSitesLayer());
    }
    if (mapLayers.processingPlants) {
      layers.push(this.createProcessingPlantsLayer());
    }
    if (mapLayers.commodityPorts) {
      layers.push(this.createCommodityPortsLayer());
    }

    // APT Groups layer — loaded lazily when cyberThreats layer is enabled
    if (mapLayers.cyberThreats && SITE_VARIANT !== 'tech' && SITE_VARIANT !== 'happy' && this.aptGroups.length > 0 && !this.aptGroupsLayerFailed) {
      layers.push(this.createAPTGroupsLayer());
    }

    // UCDP georeferenced events layer
    if (mapLayers.ucdpEvents && filteredUcdpEvents.length > 0) {
      layers.push(this.createUcdpEventsLayer(filteredUcdpEvents));
    }

    // Displacement flows arc layer
    if (mapLayers.displacement && this.displacementFlows.length > 0) {
      layers.push(this.createDisplacementArcsLayer());
    }

    // Climate anomalies heatmap layer
    if (mapLayers.climate && this.climateAnomalies.length > 0) {
      layers.push(this.createClimateHeatmapLayer());
    }

    // Trade routes layer
    if (mapLayers.tradeRoutes) {
      layers.push(this.createTradeRoutesLayer());
      layers.push(this.createTradeChokepointsLayer());
    } else {
      this.layerCache.delete('trade-routes-layer');
      this.layerCache.delete('trade-chokepoints-layer');
    }

    // Tech variant layers (Supercluster-based deck.gl layers for HQs and events)
    if (SITE_VARIANT === 'tech') {
      if (mapLayers.startupHubs) {
        layers.push(this.createStartupHubsLayer());
      }
      if (mapLayers.techHQs) {
        layers.push(...this.createTechHQClusterLayers());
      }
      if (mapLayers.accelerators) {
        layers.push(this.createAcceleratorsLayer());
      }
      if (mapLayers.cloudRegions) {
        layers.push(this.createCloudRegionsLayer());
      }
      if (mapLayers.techEvents && this.techEvents.length > 0) {
        layers.push(...this.createTechEventClusterLayers());
      }
    }

    // Gulf FDI investments layer
    if (mapLayers.gulfInvestments) {
      layers.push(this.createGulfInvestmentsLayer());
    }

    // Positive events layer (happy variant)
    if (mapLayers.positiveEvents && filteredPositiveEvents.length > 0) {
      layers.push(...this.createPositiveEventsLayers(filteredPositiveEvents));
    }

    // Kindness layer (happy variant -- green baseline pulses + real kindness events)
    if (mapLayers.kindness && filteredKindnessPoints.length > 0) {
      layers.push(...this.createKindnessLayers(filteredKindnessPoints));
    }

    // Phase 8: Happiness choropleth (rendered below point markers)
    if (mapLayers.happiness) {
      const choropleth = this.createHappinessChoroplethLayer();
      if (choropleth) layers.push(choropleth);
    }
    // CII choropleth (country instability heat-map)
    if (mapLayers.ciiChoropleth) {
      const ciiLayer = this.createCIIChoroplethLayer();
      if (ciiLayer) layers.push(ciiLayer);
    }
    if (mapLayers.resilienceScore) {
      const resilienceLayer = this.createResilienceChoroplethLayer();
      if (resilienceLayer) layers.push(resilienceLayer);
    }
    // Sanctions choropleth
    if (mapLayers.sanctions) {
      const sanctionsLayer = this.createSanctionsChoroplethLayer();
      if (sanctionsLayer) layers.push(sanctionsLayer);
    }
    // Scenario heat layer (affected countries tint)
    const scenarioHeat = this.scenarioState ? this.createScenarioHeatLayer() : null;
    if (scenarioHeat) layers.push(scenarioHeat);
    // Phase 8: Species recovery zones
    if (mapLayers.speciesRecovery && this.speciesRecoveryZones.length > 0) {
      layers.push(this.createSpeciesRecoveryLayer());
    }
    // Phase 8: Renewable energy installations
    if (mapLayers.renewableInstallations && this.renewableInstallations.length > 0) {
      layers.push(this.createRenewableInstallationsLayer());
    }

    if (mapLayers.satellites && filteredImageryScenes.length > 0 && !this.satelliteImageryLayerFailed) {
      layers.push(this.createImageryFootprintLayer(filteredImageryScenes));
    }

    // Webcam layer (server-side clustered markers)
    if (mapLayers.webcams && this.webcamData.length > 0) {
      layers.push(new ScatterplotLayer<WebcamEntry | WebcamCluster>({
        id: 'webcam-layer',
        data: this.webcamData,
        getPosition: (d) => [d.lng, d.lat],
        getRadius: (d) => ('count' in d ? Math.min(8 + d.count * 0.5, 24) : 6),
        getFillColor: (d) => ('count' in d ? [0, 212, 255, 180] : [255, 215, 0, 200]) as [number, number, number, number],
        radiusUnits: 'pixels',
        pickable: true,
      }));
    }

    // News geo-locations (always shown if data exists)
    if (this.newsLocations.length > 0) {
      layers.push(...this.createNewsLocationsLayer());
    }

    const result = layers.filter(Boolean) as LayersList;
    const elapsed = performance.now() - startTime;
    if (import.meta.env.DEV && elapsed > 16) {
      console.warn(`[DeckGLMap] buildLayers took ${elapsed.toFixed(2)}ms (>16ms budget), ${result.length} layers`);
    }
    return result;
  }

  // Layer creation methods
  private createCablesLayer(): PathLayer {
    const highlightedCables = this.highlightedAssets.cable;
    const cacheKey = 'cables-layer';
    const cached = this.layerCache.get(cacheKey) as PathLayer | undefined;
    const highlightSignature = this.getSetSignature(highlightedCables);
    const healthSignature = Object.keys(this.healthByCableId).sort().join(',');
    if (cached && highlightSignature === this.lastCableHighlightSignature && healthSignature === this.lastCableHealthSignature) return cached;

    const health = this.healthByCableId;
    const layer = new PathLayer({
      id: cacheKey,
      data: UNDERSEA_CABLES,
      getPath: (d) => d.points,
      getColor: (d) => {
        if (highlightedCables.has(d.id)) return COLORS.cableHighlight;
        const h = health[d.id];
        if (h?.status === 'fault') return COLORS.cableFault;
        if (h?.status === 'degraded') return COLORS.cableDegraded;
        return COLORS.cable;
      },
      getWidth: (d) => {
        if (highlightedCables.has(d.id)) return 3;
        const h = health[d.id];
        if (h?.status === 'fault') return 2.5;
        if (h?.status === 'degraded') return 2;
        return 1;
      },
      widthMinPixels: 1,
      widthMaxPixels: 5,
      pickable: true,
      updateTriggers: { highlighted: highlightSignature, health: healthSignature },
    });

    this.lastCableHighlightSignature = highlightSignature;
    this.lastCableHealthSignature = healthSignature;
    this.layerCache.set(cacheKey, layer);
    return layer;
  }

  private createPipelinesLayer(): PathLayer {
    const highlightedPipelines = this.highlightedAssets.pipeline;
    const cacheKey = 'pipelines-layer';
    const cached = this.layerCache.get(cacheKey) as PathLayer | undefined;
    const highlightSignature = this.getSetSignature(highlightedPipelines);
    if (cached && highlightSignature === this.lastPipelineHighlightSignature) return cached;

    const layer = new PathLayer({
      id: cacheKey,
      data: PIPELINES,
      getPath: (d) => d.points,
      getColor: (d) => {
        if (highlightedPipelines.has(d.id)) {
          return [255, 100, 100, 200] as [number, number, number, number];
        }
        const colorKey = d.type as keyof typeof PIPELINE_COLORS;
        const hex = PIPELINE_COLORS[colorKey] || '#666666';
        return this.hexToRgba(hex, 150);
      },
      getWidth: (d) => highlightedPipelines.has(d.id) ? 3 : 1.5,
      widthMinPixels: 1,
      widthMaxPixels: 4,
      pickable: true,
      updateTriggers: { highlighted: highlightSignature },
    });

    this.lastPipelineHighlightSignature = highlightSignature;
    this.layerCache.set(cacheKey, layer);
    return layer;
  }

  private buildConflictZoneGeoJson(): GeoJSON.FeatureCollection {
    if (this.conflictZoneGeoJson) return this.conflictZoneGeoJson;

    const features: GeoJSON.Feature[] = [];

    for (const zone of CONFLICT_ZONES) {
      const isoCodes = CONFLICT_COUNTRY_ISO[zone.id];
      let usedCountryGeometry = false;

      if (isoCodes?.length && this.countriesGeoJsonData) {
        for (const feature of this.countriesGeoJsonData.features) {
          const code = feature.properties?.['ISO3166-1-Alpha-2'];
          if (typeof code !== 'string' || !isoCodes.includes(code)) continue;

          features.push({
            type: 'Feature',
            properties: { id: zone.id, name: zone.name, intensity: zone.intensity },
            geometry: feature.geometry,
          });
          usedCountryGeometry = true;
        }
      }

      if (usedCountryGeometry) continue;

      features.push({
        type: 'Feature',
        properties: { id: zone.id, name: zone.name, intensity: zone.intensity },
        geometry: { type: 'Polygon', coordinates: [ensureClosedRing(zone.coords)] },
      });
    }

    this.conflictZoneGeoJson = { type: 'FeatureCollection', features };
    return this.conflictZoneGeoJson;
  }

  private createConflictZonesLayer(): GeoJsonLayer {
    const cacheKey = this.countriesGeoJsonData
      ? 'conflict-zones-layer-country-geometry'
      : 'conflict-zones-layer';

    const layer = new GeoJsonLayer({
      id: cacheKey,
      data: this.buildConflictZoneGeoJson(),
      filled: true,
      stroked: true,
      getFillColor: () => COLORS.conflict,
      getLineColor: () => getCurrentTheme() === 'light'
        ? [255, 0, 0, 120] as [number, number, number, number]
        : [255, 0, 0, 180] as [number, number, number, number],
      getLineWidth: 2,
      lineWidthMinPixels: 1,
      pickable: true,
    });
    return layer;
  }


  private getBasesData(): MilitaryBaseEnriched[] {
    return this.serverBasesLoaded ? this.serverBases : MILITARY_BASES as MilitaryBaseEnriched[];
  }

  private createBasesLayer(): IconLayer {
    const highlightedBases = this.highlightedAssets.base;
    const zoom = this.maplibreMap?.getZoom() || 3;
    const alphaScale = Math.min(1, (zoom - 2.5) / 2.5);
    const a = Math.round(160 * Math.max(0.3, alphaScale));
    const data = this.getBasesData();

    return new IconLayer({
      id: 'bases-layer',
      data,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'triangleUp',
      iconAtlas: MARKER_ICONS.triangleUp,
      iconMapping: BASES_ICON_MAPPING,
      getSize: (d) => highlightedBases.has(d.id) ? 16 : 11,
      getColor: (d) => {
        if (highlightedBases.has(d.id)) {
          return [255, 100, 100, 220] as [number, number, number, number];
        }
        return getMilitaryBaseColor(d.type, a);
      },
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 16,
      pickable: true,
    });
  }

  private createBasesClusterLayer(): Layer[] {
    if (this.serverBaseClusters.length === 0) return [];
    const zoom = this.maplibreMap?.getZoom() || 3;
    const alphaScale = Math.min(1, (zoom - 2.5) / 2.5);
    const a = Math.round(180 * Math.max(0.3, alphaScale));

    const scatterLayer = new ScatterplotLayer<ServerBaseCluster>({
      id: 'bases-cluster-layer',
      data: this.serverBaseClusters,
      getPosition: (d) => [d.longitude, d.latitude],
      getRadius: (d) => Math.max(8000, Math.log2(d.count) * 6000),
      getFillColor: (d) => getMilitaryBaseColor(d.dominantType, a),
      radiusMinPixels: 10,
      radiusMaxPixels: 40,
      pickable: true,
    });

    const textLayer = new TextLayer<ServerBaseCluster>({
      id: 'bases-cluster-text',
      data: this.serverBaseClusters,
      getPosition: (d) => [d.longitude, d.latitude],
      getText: (d) => String(d.count),
      getSize: 12,
      getColor: [255, 255, 255, 220],
      fontWeight: 'bold',
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
    });

    return [scatterLayer, textLayer];
  }

  private createNuclearLayer(): IconLayer {
    const highlightedNuclear = this.highlightedAssets.nuclear;
    const data = NUCLEAR_FACILITIES.filter(f => f.status !== 'decommissioned');

    // Nuclear: HEXAGON icons - yellow/orange color, semi-transparent
    return new IconLayer({
      id: 'nuclear-layer',
      data,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'hexagon',
      iconAtlas: MARKER_ICONS.hexagon,
      iconMapping: NUCLEAR_ICON_MAPPING,
      getSize: (d) => highlightedNuclear.has(d.id) ? 15 : 11,
      getColor: (d) => {
        if (highlightedNuclear.has(d.id)) {
          return [255, 100, 100, 220] as [number, number, number, number];
        }
        if (d.status === 'contested') {
          return [255, 50, 50, 200] as [number, number, number, number];
        }
        return [255, 220, 0, 200] as [number, number, number, number]; // Semi-transparent yellow
      },
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 15,
      pickable: true,
    });
  }

  private createIrradiatorsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'irradiators-layer',
      data: GAMMA_IRRADIATORS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: [255, 100, 255, 180] as [number, number, number, number], // Magenta
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  private createSpaceportsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'spaceports-layer',
      data: SPACEPORTS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 10000,
      getFillColor: [200, 100, 255, 200] as [number, number, number, number], // Purple
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createPortsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'ports-layer',
      data: PORTS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: (d) => {
        // Color by port type (matching old Map.ts icons)
        switch (d.type) {
          case 'naval': return [100, 150, 255, 200] as [number, number, number, number]; // Blue - ⚓
          case 'oil': return [255, 140, 0, 200] as [number, number, number, number]; // Orange - 🛢️
          case 'lng': return [255, 200, 50, 200] as [number, number, number, number]; // Yellow - 🛢️
          case 'container': return [0, 200, 255, 180] as [number, number, number, number]; // Cyan - 🏭
          case 'mixed': return [150, 200, 150, 180] as [number, number, number, number]; // Green
          case 'bulk': return [180, 150, 120, 180] as [number, number, number, number]; // Brown
          default: return [0, 200, 255, 160] as [number, number, number, number];
        }
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  private createFlightDelaysLayer(delays: AirportDelayAlert[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'flight-delays-layer',
      data: delays,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        if (d.severity === 'severe') return 15000;
        if (d.severity === 'major') return 12000;
        if (d.severity === 'moderate') return 10000;
        return 8000;
      },
      getFillColor: (d) => {
        if (d.severity === 'severe') return [255, 50, 50, 200] as [number, number, number, number];
        if (d.severity === 'major') return [255, 150, 0, 200] as [number, number, number, number];
        if (d.severity === 'moderate') return [255, 200, 100, 180] as [number, number, number, number];
        return [180, 180, 180, 150] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 15,
      pickable: true,
    });
  }

  private createNotamOverlayLayer(closures: AirportDelayAlert[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'notam-overlay-layer',
      data: closures,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 55000,
      getFillColor: [255, 40, 40, 100] as [number, number, number, number],
      getLineColor: [255, 40, 40, 200] as [number, number, number, number],
      stroked: true,
      lineWidthMinPixels: 2,
      radiusMinPixels: 8,
      radiusMaxPixels: 40,
      pickable: true,
    });
  }

  private createAircraftPositionsLayer(): IconLayer<PositionSample> {
    return new IconLayer<PositionSample>({
      id: 'aircraft-positions-layer',
      data: this.aircraftPositions,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'plane',
      iconAtlas: MARKER_ICONS.plane,
      iconMapping: AIRCRAFT_ICON_MAPPING,
      getSize: (d) => d.onGround ? 14 : 18,
      getColor: (d) => {
        if (d.onGround) return [120, 120, 120, 160] as [number, number, number, number];
        const [r, g, b] = altitudeToColor(d.altitudeFt);
        return [r, g, b, 220] as [number, number, number, number];
      },
      getAngle: (d) => -d.trackDeg,
      sizeMinPixels: 8,
      sizeMaxPixels: 28,
      sizeScale: 1,
      pickable: true,
      billboard: false,
    });
  }

  private createGhostLayer<T>(id: string, data: T[], getPosition: (d: T) => [number, number], opts: { radiusMinPixels?: number } = {}): ScatterplotLayer<T> {
    return new ScatterplotLayer<T>({
      id: `${id}-ghost`,
      data,
      getPosition,
      getRadius: 1,
      radiusMinPixels: opts.radiusMinPixels ?? 12,
      getFillColor: [0, 0, 0, 0],
      pickable: true,
    });
  }

  /** Empty sentinel layer — keeps a stable layer ID for deck.gl interleaved mode without rendering anything. */
  private createEmptyGhost(id: string): ScatterplotLayer {
    return new ScatterplotLayer({ id: `${id}-ghost`, data: [], getPosition: () => [0, 0], visible: false });
  }


  private createDatacentersLayer(): IconLayer {
    const highlightedDC = this.highlightedAssets.datacenter;
    const data = AI_DATA_CENTERS.filter(dc => dc.status !== 'decommissioned');

    // Datacenters: SQUARE icons - purple color, semi-transparent for layering
    return new IconLayer({
      id: 'datacenters-layer',
      data,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'square',
      iconAtlas: MARKER_ICONS.square,
      iconMapping: DATACENTER_ICON_MAPPING,
      getSize: (d) => highlightedDC.has(d.id) ? 14 : 10,
      getColor: (d) => {
        if (highlightedDC.has(d.id)) {
          return [255, 100, 100, 200] as [number, number, number, number];
        }
        if (d.status === 'planned') {
          return [136, 68, 255, 100] as [number, number, number, number]; // Transparent for planned
        }
        return [136, 68, 255, 140] as [number, number, number, number]; // ~55% opacity
      },
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 14,
      pickable: true,
    });
  }

  private createEarthquakesLayer(earthquakes: Earthquake[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'earthquakes-layer',
      data: earthquakes,
      getPosition: (d) => [d.location?.longitude ?? 0, d.location?.latitude ?? 0],
      getRadius: (d) => 2 ** d.magnitude * 1000,
      getFillColor: (d) => {
        const mag = d.magnitude;
        if (mag >= 6) return [255, 0, 0, 200] as [number, number, number, number];
        if (mag >= 5) return [255, 100, 0, 200] as [number, number, number, number];
        return COLORS.earthquake;
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 30,
      pickable: true,
    });
  }

  private createNaturalEventsLayers(events: NaturalEvent[]): Layer[] {
    const nonTC = events.filter(e => !e.stormName && !e.windKt);
    const cyclones = events.filter(e => e.stormName || e.windKt);
    const layers: Layer[] = [];

    if (nonTC.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'natural-events-layer',
        data: nonTC,
        getPosition: (d: NaturalEvent) => [d.lon, d.lat],
        getRadius: (d: NaturalEvent) => d.title.startsWith('🔴') ? 20000 : d.title.startsWith('🟠') ? 15000 : 8000,
        getFillColor: (d: NaturalEvent) => {
          if (d.title.startsWith('🔴')) return [255, 0, 0, 220] as [number, number, number, number];
          if (d.title.startsWith('🟠')) return [255, 140, 0, 200] as [number, number, number, number];
          return [255, 150, 50, 180] as [number, number, number, number];
        },
        radiusMinPixels: 5,
        radiusMaxPixels: 18,
        pickable: true,
      }));
    }

    if (cyclones.length === 0) return layers;

    // Cone polygons (render first, underneath tracks)
    const coneData: { polygon: number[][]; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.conePolygon?.length) continue;
      for (const ring of e.conePolygon) {
        coneData.push({ polygon: ring, stormName: e.stormName || e.title, _event: e });
      }
    }
    if (coneData.length > 0) {
      layers.push(new PolygonLayer({
        id: 'storm-cone-layer',
        data: coneData,
        getPolygon: (d: { polygon: number[][] }) => d.polygon,
        getFillColor: [255, 255, 255, 30],
        getLineColor: [255, 255, 255, 80],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    }

    // Past track segments (per-segment wind coloring)
    const pastSegments: { path: [number, number][]; windKt: number; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.pastTrack?.length) continue;
      for (let i = 0; i < e.pastTrack.length - 1; i++) {
        const a = e.pastTrack[i]!;
        const b = e.pastTrack[i + 1]!;
        pastSegments.push({
          path: [[a.lon, a.lat] as [number, number], [b.lon, b.lat] as [number, number]],
          windKt: b.windKt ?? a.windKt ?? 0,
          stormName: e.stormName || e.title,
          _event: e,
        });
      }
    }
    if (pastSegments.length > 0) {
      layers.push(new PathLayer({
        id: 'storm-past-track-layer',
        data: pastSegments,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: (d: { windKt: number }) => getWindColor(d.windKt),
        getWidth: 3,
        widthUnits: 'pixels' as const,
        pickable: true,
      }));
    }

    // Forecast track
    const forecastPaths: { path: [number, number][]; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.forecastTrack?.length) continue;
      forecastPaths.push({
        path: [[e.lon, e.lat] as [number, number], ...e.forecastTrack.map(p => [p.lon, p.lat] as [number, number])],
        stormName: e.stormName || e.title,
        _event: e,
      });
    }
    if (forecastPaths.length > 0) {
      layers.push(new PathLayer({
        id: 'storm-forecast-track-layer',
        data: forecastPaths,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: [255, 100, 100, 200],
        getWidth: 2,
        widthUnits: 'pixels' as const,
        getDashArray: [6, 4],
        dashJustified: true,
        pickable: true,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    // Storm center markers (on top)
    layers.push(new ScatterplotLayer({
      id: 'storm-centers-layer',
      data: cyclones,
      getPosition: (d: NaturalEvent) => [d.lon, d.lat],
      getRadius: 15000,
      getFillColor: (d: NaturalEvent) => getWindColor(d.windKt ?? 0),
      getLineColor: [255, 255, 255, 200],
      lineWidthMinPixels: 2,
      stroked: true,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
    }));

    return layers;
  }

  private createFiresLayer(items: typeof this.firmsFireData): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'fires-layer',
      data: items,
      getPosition: (d: (typeof this.firmsFireData)[0]) => [d.lon, d.lat],
      getRadius: (d: (typeof this.firmsFireData)[0]) => Math.min(d.frp * 200, 30000) || 5000,
      getFillColor: (d: (typeof this.firmsFireData)[0]) => {
        if (d.brightness > 400) return [255, 30, 0, 220] as [number, number, number, number];
        if (d.brightness > 350) return [255, 140, 0, 200] as [number, number, number, number];
        return [255, 220, 50, 180] as [number, number, number, number];
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createIranEventsLayer(items: IranEvent[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'iran-events-layer',
      data: items,
      getPosition: (d: IranEvent) => [d.longitude, d.latitude],
      getRadius: (d: IranEvent) => getIranEventRadius(d.severity),
      getFillColor: (d: IranEvent) => getIranEventColor(d),
      radiusMinPixels: 4,
      radiusMaxPixels: 16,
      pickable: true,
    });
  }

  private createWeatherLayer(alerts: WeatherAlert[]): ScatterplotLayer {
    // Filter weather alerts that have centroid coordinates
    const alertsWithCoords = alerts.filter(a => a.centroid && a.centroid.length === 2);

    return new ScatterplotLayer({
      id: 'weather-layer',
      data: alertsWithCoords,
      getPosition: (d) => d.centroid as [number, number], // centroid is [lon, lat]
      getRadius: 25000,
      getFillColor: (d) => {
        if (d.severity === 'Extreme') return [255, 0, 0, 200] as [number, number, number, number];
        if (d.severity === 'Severe') return [255, 100, 0, 180] as [number, number, number, number];
        if (d.severity === 'Moderate') return [255, 170, 0, 160] as [number, number, number, number];
        return COLORS.weather;
      },
      radiusMinPixels: 8,
      radiusMaxPixels: 20,
      pickable: true,
    });
  }

  private createOutagesLayer(outages: InternetOutage[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'outages-layer',
      data: outages,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 20000,
      getFillColor: COLORS.outage,
      radiusMinPixels: 6,
      radiusMaxPixels: 18,
      pickable: true,
    });
  }

  private createTrafficAnomaliesLayer(anomalies: ProtoTrafficAnomaly[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'traffic-anomalies-layer',
      data: anomalies.filter(a => a.latitude !== 0 || a.longitude !== 0),
      getPosition: (d) => [d.longitude, d.latitude],
      getRadius: 30000,
      getFillColor: COLORS.trafficAnomaly,
      radiusMinPixels: 5,
      radiusMaxPixels: 14,
      pickable: true,
    });
  }

  private createDdosLocationsLayer(hits: DdosLocationHit[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'ddos-locations-layer',
      data: hits.filter(h => h.latitude !== 0 || h.longitude !== 0),
      getPosition: (d) => [d.longitude, d.latitude],
      getRadius: (d) => 20000 + (d.percentage || 0) * 800,
      getFillColor: COLORS.ddosHit,
      radiusMinPixels: 5,
      radiusMaxPixels: 16,
      pickable: true,
    });
  }

  private createCyberThreatsLayer(): ScatterplotLayer<CyberThreat> {
    return new ScatterplotLayer<CyberThreat>({
      id: 'cyber-threats-layer',
      data: this.cyberThreats,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        switch (d.severity) {
          case 'critical': return 22000;
          case 'high': return 17000;
          case 'medium': return 13000;
          default: return 9000;
        }
      },
      getFillColor: (d) => {
        switch (d.severity) {
          case 'critical': return [255, 61, 0, 225] as [number, number, number, number];
          case 'high': return [255, 102, 0, 205] as [number, number, number, number];
          case 'medium': return [255, 176, 0, 185] as [number, number, number, number];
          default: return [255, 235, 59, 170] as [number, number, number, number];
        }
      },
      radiusMinPixels: 6,
      radiusMaxPixels: 18,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 160] as [number, number, number, number],
      lineWidthMinPixels: 1,
    });
  }

  private createRadiationLayer(items: RadiationObservation[]): ScatterplotLayer<RadiationObservation> {
    return new ScatterplotLayer<RadiationObservation>({
      id: 'radiation-watch-layer',
      data: items,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        const base = d.severity === 'spike' ? 26000 : 18000;
        if (d.corroborated) return base * 1.15;
        if (d.confidence === 'low') return base * 0.85;
        return base;
      },
      getFillColor: (d) => (
        d.severity === 'spike'
          ? [255, 48, 48, 220]
          : d.confidence === 'low'
            ? [255, 174, 0, 150]
            : [255, 174, 0, 200]
      ) as [number, number, number, number],
      getLineColor: [255, 255, 255, 200],
      stroked: true,
      lineWidthMinPixels: 2,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
    });
  }

  private createDiseaseOutbreaksLayer(items: DiseaseOutbreakItem[]): ScatterplotLayer<{ lon: number; lat: number; item: DiseaseOutbreakItem }> {
    type Point = { lon: number; lat: number; item: DiseaseOutbreakItem };
    const points: Point[] = [];
    for (const item of items) {
      if (Number.isFinite(item.lat) && item.lat !== 0 && Number.isFinite(item.lng) && item.lng !== 0) {
        points.push({ lon: item.lng, lat: item.lat, item });
      } else {
        const centroid = getCountryCentroid(item.countryCode ?? '');
        if (centroid) points.push({ lon: centroid.lon, lat: centroid.lat, item });
      }
    }
    return new ScatterplotLayer<Point>({
      id: 'disease-outbreaks-layer',
      data: points,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.item.alertLevel === 'alert' ? 180000 : d.item.alertLevel === 'warning' ? 130000 : 90000,
      getFillColor: (d) => (
        d.item.alertLevel === 'alert'
          ? [231, 76, 60, 200]
          : d.item.alertLevel === 'warning'
            ? [230, 126, 34, 190]
            : [241, 196, 15, 170]
      ) as [number, number, number, number],
      getLineColor: [255, 255, 255, 120],
      stroked: true,
      lineWidthMinPixels: 1,
      radiusMinPixels: 5,
      radiusMaxPixels: 22,
      pickable: true,
    });
  }

  private createAisDensityLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'ais-density-layer',
      data: this.aisDensity,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 4000 + d.intensity * 8000,
      getFillColor: (d) => {
        const intensity = Math.min(Math.max(d.intensity, 0.15), 1);
        const isCongested = (d.deltaPct || 0) >= 15;
        const alpha = Math.round(40 + intensity * 160);
        // Orange for congested areas, cyan for normal traffic
        if (isCongested) {
          return [255, 183, 3, alpha] as [number, number, number, number]; // #ffb703
        }
        return [0, 209, 255, alpha] as [number, number, number, number]; // #00d1ff
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createGpsJammingLayer(): H3HexagonLayer {
    return new H3HexagonLayer({
      id: 'gps-jamming-layer',
      data: this.gpsJammingHexes,
      getHexagon: (d: GpsJamHex) => d.h3,
      getFillColor: (d: GpsJamHex) => {
        if (d.level === 'high') return [255, 80, 80, 180] as [number, number, number, number];
        return [255, 180, 50, 140] as [number, number, number, number];
      },
      getElevation: 0,
      extruded: false,
      filled: true,
      stroked: true,
      getLineColor: [255, 255, 255, 80] as [number, number, number, number],
      getLineWidth: 1,
      lineWidthMinPixels: 1,
      pickable: true,
    });
  }

  private createAisDisruptionsLayer(): ScatterplotLayer {
    // AIS spoofing/jamming events
    return new ScatterplotLayer({
      id: 'ais-disruptions-layer',
      data: this.aisDisruptions,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 12000,
      getFillColor: (d) => {
        // Color by severity/type
        if (d.severity === 'high' || d.type === 'spoofing') {
          return [255, 50, 50, 220] as [number, number, number, number]; // Red
        }
        if (d.severity === 'medium') {
          return [255, 150, 0, 200] as [number, number, number, number]; // Orange
        }
        return [255, 200, 100, 180] as [number, number, number, number]; // Yellow
      },
      radiusMinPixels: 6,
      radiusMaxPixels: 14,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 150] as [number, number, number, number],
      lineWidthMinPixels: 1,
    });
  }

  private createCableAdvisoriesLayer(advisories: CableAdvisory[]): ScatterplotLayer {
    // Cable fault/maintenance advisories
    return new ScatterplotLayer({
      id: 'cable-advisories-layer',
      data: advisories,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 10000,
      getFillColor: (d) => {
        if (d.severity === 'fault') {
          return [255, 50, 50, 220] as [number, number, number, number]; // Red for faults
        }
        return [255, 200, 0, 200] as [number, number, number, number]; // Yellow for maintenance
      },
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
      stroked: true,
      getLineColor: [0, 200, 255, 200] as [number, number, number, number], // Cyan outline (cable color)
      lineWidthMinPixels: 2,
    });
  }

  private createRepairShipsLayer(): ScatterplotLayer {
    // Cable repair ships
    return new ScatterplotLayer({
      id: 'repair-ships-layer',
      data: this.repairShips,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: [0, 255, 200, 200] as [number, number, number, number], // Teal
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  private createMilitaryVesselsLayer(vessels: MilitaryVessel[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'military-vessels-layer',
      data: vessels,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: (d) => {
        if (d.usniSource) return [255, 160, 60, 160] as [number, number, number, number]; // Orange, lower alpha for USNI-only
        return COLORS.vesselMilitary;
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
      stroked: true,
      getLineColor: (d) => {
        if (d.usniSource) return [255, 180, 80, 200] as [number, number, number, number]; // Orange outline
        return [0, 0, 0, 0] as [number, number, number, number]; // No outline for AIS
      },
      lineWidthMinPixels: 2,
    });
  }

  private createMilitaryVesselClustersLayer(clusters: MilitaryVesselCluster[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'military-vessel-clusters-layer',
      data: clusters,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 15000 + (d.vesselCount || 1) * 3000,
      getFillColor: (d) => {
        // Vessel types: 'exercise' | 'deployment' | 'transit' | 'unknown'
        const activity = d.activityType || 'unknown';
        if (activity === 'exercise' || activity === 'deployment') return [255, 100, 100, 200] as [number, number, number, number];
        if (activity === 'transit') return [255, 180, 100, 180] as [number, number, number, number];
        return [200, 150, 150, 160] as [number, number, number, number];
      },
      radiusMinPixels: 8,
      radiusMaxPixels: 25,
      pickable: true,
    });
  }

  private createMilitaryFlightsLayer(flights: MilitaryFlight[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'military-flights-layer',
      data: flights,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: (d) => {
        if (d.onGround) return [120, 120, 120, 160] as [number, number, number, number];
        const [r, g, b] = altitudeToColor(d.altitude);
        return [r, g, b, 220] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createMilitaryFlightTrailsLayer(flights: MilitaryFlight[]): PathLayer {
    const trailed = flights.filter(f => this.activeFlightTrails.has(f.hexCode.toLowerCase()) && f.track && f.track.length > 1);
    return new PathLayer({
      id: 'military-flight-trails-layer',
      data: trailed,
      getPath: (d) => d.track!.map(([lat, lon]: [number, number]) => [lon, lat]),
      getColor: (d) => { const [r, g, b] = altitudeToColor(d.altitude); return [r, g, b, 140] as [number, number, number, number]; },
      getWidth: 2,
      widthUnits: 'pixels' as const,
      getDashArray: [6, 4],
      dashJustified: true,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
    });
  }

  private createMilitaryFlightClustersLayer(clusters: MilitaryFlightCluster[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'military-flight-clusters-layer',
      data: clusters,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 15000 + (d.flightCount || 1) * 3000,
      getFillColor: (d) => {
        const activity = d.activityType || 'unknown';
        if (activity === 'exercise' || activity === 'patrol') return [100, 150, 255, 200] as [number, number, number, number];
        if (activity === 'transport') return [255, 200, 100, 180] as [number, number, number, number];
        return [150, 150, 200, 160] as [number, number, number, number];
      },
      radiusMinPixels: 8,
      radiusMaxPixels: 25,
      pickable: true,
    });
  }

  private createWaterwaysLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'waterways-layer',
      data: STRATEGIC_WATERWAYS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 10000,
      getFillColor: [100, 150, 255, 180] as [number, number, number, number],
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createEconomicCentersLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'economic-centers-layer',
      data: ECONOMIC_CENTERS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: [255, 215, 0, 180] as [number, number, number, number],
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  private createStockExchangesLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'stock-exchanges-layer',
      data: STOCK_EXCHANGES,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.tier === 'mega' ? 18000 : d.tier === 'major' ? 14000 : 11000,
      getFillColor: (d) => {
        if (d.tier === 'mega') return [255, 215, 80, 220] as [number, number, number, number];
        if (d.tier === 'major') return COLORS.stockExchange;
        return [140, 210, 255, 190] as [number, number, number, number];
      },
      radiusMinPixels: 5,
      radiusMaxPixels: 14,
      pickable: true,
    });
  }

  private createFinancialCentersLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'financial-centers-layer',
      data: FINANCIAL_CENTERS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.type === 'global' ? 17000 : d.type === 'regional' ? 13000 : 10000,
      getFillColor: (d) => {
        if (d.type === 'global') return COLORS.financialCenter;
        if (d.type === 'regional') return [0, 190, 130, 185] as [number, number, number, number];
        return [0, 150, 110, 165] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createCentralBanksLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'central-banks-layer',
      data: CENTRAL_BANKS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.type === 'major' ? 15000 : d.type === 'supranational' ? 17000 : 12000,
      getFillColor: (d) => {
        if (d.type === 'major') return COLORS.centralBank;
        if (d.type === 'supranational') return [255, 235, 140, 220] as [number, number, number, number];
        return [235, 180, 80, 185] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createCommodityHubsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'commodity-hubs-layer',
      data: COMMODITY_HUBS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.type === 'exchange' ? 14000 : d.type === 'port' ? 12000 : 10000,
      getFillColor: (d) => {
        if (d.type === 'exchange') return COLORS.commodityHub;
        if (d.type === 'port') return [80, 170, 255, 190] as [number, number, number, number];
        return [255, 110, 80, 185] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 11,
      pickable: true,
    });
  }

  private async loadAptGroups(): Promise<void> {
    const { APT_GROUPS } = await import('@/config/apt-groups');
    this.aptGroups = APT_GROUPS;
    this.aptGroupsLoaded = true;
    this.render();
  }

  private createAPTGroupsLayer(): ScatterplotLayer {
    // APT Groups - cyber threat actor markers (geopolitical variant only)
    // Made subtle to avoid visual clutter - small orange dots
    return new ScatterplotLayer({
      id: 'apt-groups-layer',
      data: this.aptGroups,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: [255, 140, 0, 140] as [number, number, number, number],
      radiusMinPixels: 4,
      radiusMaxPixels: 8,
      pickable: true,
      stroked: false,
    });
  }

  private createMineralsLayer(): ScatterplotLayer {
    // Critical minerals projects
    return new ScatterplotLayer({
      id: 'minerals-layer',
      data: CRITICAL_MINERALS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: (d) => {
        // Color by mineral type
        switch (d.mineral) {
          case 'Lithium': return [0, 200, 255, 200] as [number, number, number, number]; // Cyan
          case 'Cobalt': return [100, 100, 255, 200] as [number, number, number, number]; // Blue
          case 'Rare Earths': return [255, 100, 200, 200] as [number, number, number, number]; // Pink
          case 'Nickel': return [100, 255, 100, 200] as [number, number, number, number]; // Green
          default: return [200, 200, 200, 200] as [number, number, number, number]; // Gray
        }
      },
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  // Commodity variant layers
  private createMiningSitesLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'mining-sites-layer',
      data: MINING_SITES,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.status === 'producing' ? 10000 : d.status === 'development' ? 8000 : 6000,
      getFillColor: (d) => getMineralColor(d.mineral),
      radiusMinPixels: 5,
      radiusMaxPixels: 14,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 60] as [number, number, number, number],
      lineWidthMinPixels: 1,
    });
  }

  private createProcessingPlantsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'processing-plants-layer',
      data: PROCESSING_PLANTS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: (d) => {
        switch (d.type) {
          case 'smelter':    return [255, 80, 30, 210] as [number, number, number, number];
          case 'refinery':   return [255, 160, 50, 200] as [number, number, number, number];
          case 'separation': return [160, 100, 255, 200] as [number, number, number, number];
          case 'processing': return [100, 200, 150, 200] as [number, number, number, number];
          default:           return [200, 150, 100, 200] as [number, number, number, number];
        }
      },
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 80] as [number, number, number, number],
      lineWidthMinPixels: 1,
    });
  }

  private createCommodityPortsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'commodity-ports-layer',
      data: COMMODITY_GEO_PORTS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 12000,
      getFillColor: (d) => getMineralColor(d.commodities[0]),
      radiusMinPixels: 6,
      radiusMaxPixels: 14,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 100] as [number, number, number, number],
      lineWidthMinPixels: 1.5,
    });
  }

  // Tech variant layers
  private createStartupHubsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'startup-hubs-layer',
      data: STARTUP_HUBS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 10000,
      getFillColor: COLORS.startupHub,
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createAcceleratorsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'accelerators-layer',
      data: ACCELERATORS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: COLORS.accelerator,
      radiusMinPixels: 3,
      radiusMaxPixels: 8,
      pickable: true,
    });
  }

  private createCloudRegionsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'cloud-regions-layer',
      data: CLOUD_REGIONS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 12000,
      getFillColor: COLORS.cloudRegion,
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createProtestClusterLayers(): Layer[] {
    this.updateClusterData();
    const layers: Layer[] = [];

    layers.push(new ScatterplotLayer<MapProtestCluster>({
      id: 'protest-clusters-layer',
      data: this.protestClusters,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => 15000 + d.count * 2000,
      radiusMinPixels: 6,
      radiusMaxPixels: 22,
      getFillColor: d => {
        if (d.hasRiot) return [220, 40, 40, 200] as [number, number, number, number];
        if (d.maxSeverity === 'high') return [255, 80, 60, 180] as [number, number, number, number];
        if (d.maxSeverity === 'medium') return [255, 160, 40, 160] as [number, number, number, number];
        return [255, 220, 80, 140] as [number, number, number, number];
      },
      pickable: true,
      updateTriggers: { getRadius: this.lastSCZoom, getFillColor: this.lastSCZoom },
    }));

    const multiClusters = this.protestClusters.filter(c => c.count > 1);
    if (multiClusters.length > 0) {
      layers.push(new TextLayer<MapProtestCluster>({
        id: 'protest-clusters-badge',
        data: multiClusters,
        getText: d => String(d.count),
        getPosition: d => [d.lon, d.lat],
        background: true,
        getBackgroundColor: [0, 0, 0, 180],
        backgroundPadding: [4, 2, 4, 2],
        getColor: [255, 255, 255, 255],
        getSize: 12,
        getPixelOffset: [0, -14],
        pickable: false,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 700,
      }));
    }

    const pulseClusters = this.protestClusters.filter(c => c.maxSeverity === 'high' || c.hasRiot);
    if (pulseClusters.length > 0) {
      const pulse = 1.0 + 0.8 * (0.5 + 0.5 * Math.sin((this.pulseTime || Date.now()) / 400));
      layers.push(new ScatterplotLayer<MapProtestCluster>({
        id: 'protest-clusters-pulse',
        data: pulseClusters,
        getPosition: d => [d.lon, d.lat],
        getRadius: d => 15000 + d.count * 2000,
        radiusScale: pulse,
        radiusMinPixels: 8,
        radiusMaxPixels: 30,
        stroked: true,
        filled: false,
        getLineColor: d => d.hasRiot ? [220, 40, 40, 120] as [number, number, number, number] : [255, 80, 60, 100] as [number, number, number, number],
        lineWidthMinPixels: 1.5,
        pickable: false,
        updateTriggers: { radiusScale: this.pulseTime },
      }));
    }

    layers.push(this.createEmptyGhost('protest-clusters-layer'));
    return layers;
  }

  private createTechHQClusterLayers(): Layer[] {
    this.updateClusterData();
    const layers: Layer[] = [];
    const zoom = this.maplibreMap?.getZoom() || 2;

    layers.push(new ScatterplotLayer<MapTechHQCluster>({
      id: 'tech-hq-clusters-layer',
      data: this.techHQClusters,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => 10000 + d.count * 1500,
      radiusMinPixels: 5,
      radiusMaxPixels: 18,
      getFillColor: d => {
        if (d.primaryType === 'faang') return [0, 220, 120, 200] as [number, number, number, number];
        if (d.primaryType === 'unicorn') return [255, 100, 200, 180] as [number, number, number, number];
        return [80, 160, 255, 180] as [number, number, number, number];
      },
      pickable: true,
      updateTriggers: { getRadius: this.lastSCZoom },
    }));

    const multiClusters = this.techHQClusters.filter(c => c.count > 1);
    if (multiClusters.length > 0) {
      layers.push(new TextLayer<MapTechHQCluster>({
        id: 'tech-hq-clusters-badge',
        data: multiClusters,
        getText: d => String(d.count),
        getPosition: d => [d.lon, d.lat],
        background: true,
        getBackgroundColor: [0, 0, 0, 180],
        backgroundPadding: [4, 2, 4, 2],
        getColor: [255, 255, 255, 255],
        getSize: 12,
        getPixelOffset: [0, -14],
        pickable: false,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 700,
      }));
    }

    if (zoom >= 3) {
      const singles = this.techHQClusters.filter(c => c.count === 1);
      if (singles.length > 0) {
        layers.push(new TextLayer<MapTechHQCluster>({
          id: 'tech-hq-clusters-label',
          data: singles,
          getText: d => d.items[0]?.company ?? '',
          getPosition: d => [d.lon, d.lat],
          getSize: 11,
          getColor: [220, 220, 220, 200],
          getPixelOffset: [0, 12],
          pickable: false,
          fontFamily: 'system-ui, sans-serif',
        }));
      }
    }

    layers.push(this.createEmptyGhost('tech-hq-clusters-layer'));
    return layers;
  }

  private createTechEventClusterLayers(): Layer[] {
    this.updateClusterData();
    const layers: Layer[] = [];

    layers.push(new ScatterplotLayer<MapTechEventCluster>({
      id: 'tech-event-clusters-layer',
      data: this.techEventClusters,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => 10000 + d.count * 1500,
      radiusMinPixels: 5,
      radiusMaxPixels: 18,
      getFillColor: d => {
        if (d.soonestDaysUntil <= 14) return [255, 220, 50, 200] as [number, number, number, number];
        return [80, 140, 255, 180] as [number, number, number, number];
      },
      pickable: true,
      updateTriggers: { getRadius: this.lastSCZoom },
    }));

    const multiClusters = this.techEventClusters.filter(c => c.count > 1);
    if (multiClusters.length > 0) {
      layers.push(new TextLayer<MapTechEventCluster>({
        id: 'tech-event-clusters-badge',
        data: multiClusters,
        getText: d => String(d.count),
        getPosition: d => [d.lon, d.lat],
        background: true,
        getBackgroundColor: [0, 0, 0, 180],
        backgroundPadding: [4, 2, 4, 2],
        getColor: [255, 255, 255, 255],
        getSize: 12,
        getPixelOffset: [0, -14],
        pickable: false,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 700,
      }));
    }

    layers.push(this.createEmptyGhost('tech-event-clusters-layer'));
    return layers;
  }

  private createDatacenterClusterLayers(): Layer[] {
    this.updateClusterData();
    const layers: Layer[] = [];

    layers.push(new ScatterplotLayer<MapDatacenterCluster>({
      id: 'datacenter-clusters-layer',
      data: this.datacenterClusters,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => 15000 + d.count * 2000,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      getFillColor: d => {
        if (d.majorityExisting) return [160, 80, 255, 180] as [number, number, number, number];
        return [80, 160, 255, 180] as [number, number, number, number];
      },
      pickable: true,
      updateTriggers: { getRadius: this.lastSCZoom },
    }));

    const multiClusters = this.datacenterClusters.filter(c => c.count > 1);
    if (multiClusters.length > 0) {
      layers.push(new TextLayer<MapDatacenterCluster>({
        id: 'datacenter-clusters-badge',
        data: multiClusters,
        getText: d => String(d.count),
        getPosition: d => [d.lon, d.lat],
        background: true,
        getBackgroundColor: [0, 0, 0, 180],
        backgroundPadding: [4, 2, 4, 2],
        getColor: [255, 255, 255, 255],
        getSize: 12,
        getPixelOffset: [0, -14],
        pickable: false,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 700,
      }));
    }

    layers.push(this.createEmptyGhost('datacenter-clusters-layer'));
    return layers;
  }

  private createHotspotsLayers(): Layer[] {
    const zoom = this.maplibreMap?.getZoom() || 2;
    const zoomScale = Math.min(1, (zoom - 1) / 3);
    const maxPx = 6 + Math.round(14 * zoomScale);
    const baseOpacity = zoom < 2.5 ? 0.5 : zoom < 4 ? 0.7 : 1.0;
    const layers: Layer[] = [];

    layers.push(new ScatterplotLayer({
      id: 'hotspots-layer',
      data: this.hotspots,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        const score = d.escalationScore || 1;
        return 10000 + score * 5000;
      },
      getFillColor: (d) => {
        const score = d.escalationScore || 1;
        const a = Math.round((score >= 4 ? 200 : score >= 2 ? 200 : 180) * baseOpacity);
        if (score >= 4) return [255, 68, 68, a] as [number, number, number, number];
        if (score >= 2) return [255, 165, 0, a] as [number, number, number, number];
        return [255, 255, 0, a] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: maxPx,
      pickable: true,
      stroked: true,
      getLineColor: (d) =>
        d.hasBreaking ? [255, 255, 255, 255] as [number, number, number, number] : [0, 0, 0, 0] as [number, number, number, number],
      lineWidthMinPixels: 2,
    }));

    const highHotspots = this.hotspots.filter(h => h.level === 'high' || h.hasBreaking);
    if (highHotspots.length > 0) {
      const pulse = 1.0 + 0.8 * (0.5 + 0.5 * Math.sin((this.pulseTime || Date.now()) / 400));
      layers.push(new ScatterplotLayer({
        id: 'hotspots-pulse',
        data: highHotspots,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => {
          const score = d.escalationScore || 1;
          return 10000 + score * 5000;
        },
        radiusScale: pulse,
        radiusMinPixels: 6,
        radiusMaxPixels: 30,
        stroked: true,
        filled: false,
        getLineColor: (d) => {
          const a = Math.round(120 * baseOpacity);
          return d.hasBreaking ? [255, 50, 50, a] as [number, number, number, number] : [255, 165, 0, a] as [number, number, number, number];
        },
        lineWidthMinPixels: 1.5,
        pickable: false,
        updateTriggers: { radiusScale: this.pulseTime },
      }));

    }

    layers.push(this.createEmptyGhost('hotspots-layer'));
    return layers;
  }

  private createGulfInvestmentsLayer(): ScatterplotLayer {
    return new ScatterplotLayer<GulfInvestment>({
      id: 'gulf-investments-layer',
      data: GULF_INVESTMENTS,
      getPosition: (d: GulfInvestment) => [d.lon, d.lat],
      getRadius: (d: GulfInvestment) => {
        if (!d.investmentUSD) return 20000;
        if (d.investmentUSD >= 50000) return 70000;
        if (d.investmentUSD >= 10000) return 55000;
        if (d.investmentUSD >= 1000) return 40000;
        return 25000;
      },
      getFillColor: (d: GulfInvestment) =>
        d.investingCountry === 'SA' ? COLORS.gulfInvestmentSA : COLORS.gulfInvestmentUAE,
      getLineColor: [255, 255, 255, 80] as [number, number, number, number],
      lineWidthMinPixels: 1,
      radiusMinPixels: 5,
      radiusMaxPixels: 28,
      pickable: true,
    });
  }

  private pulseTime = 0;

  private canPulse(now = Date.now()): boolean {
    return now - this.startupTime > 60_000;
  }

  private hasRecentRiot(now = Date.now(), windowMs = 2 * 60 * 60 * 1000): boolean {
    const hasRecentClusterRiot = this.protestClusters.some(c =>
      c.hasRiot && c.latestRiotEventTimeMs != null && (now - c.latestRiotEventTimeMs) < windowMs
    );
    if (hasRecentClusterRiot) return true;

    // Fallback to raw protests because syncPulseAnimation can run before cluster data refreshes.
    return this.protests.some((p) => {
      if (p.eventType !== 'riot' || p.sourceType === 'gdelt') return false;
      const ts = p.time.getTime();
      return Number.isFinite(ts) && (now - ts) < windowMs;
    });
  }

  private needsPulseAnimation(now = Date.now()): boolean {
    return this.hasRecentNews(now)
      || this.hasRecentRiot(now)
      || this.hotspots.some(h => h.hasBreaking)
      || this.positiveEvents.some(e => e.count > 10)
      || this.kindnessPoints.some(p => p.type === 'real');
  }

  private syncPulseAnimation(now = Date.now()): void {
    if (this.renderPaused) {
      if (this.newsPulseIntervalId !== null) this.stopPulseAnimation();
      return;
    }
    const shouldPulse = this.canPulse(now) && this.needsPulseAnimation(now);
    if (shouldPulse && this.newsPulseIntervalId === null) {
      this.startPulseAnimation();
    } else if (!shouldPulse && this.newsPulseIntervalId !== null) {
      this.stopPulseAnimation();
    }
  }

  private startPulseAnimation(): void {
    if (this.newsPulseIntervalId !== null) return;
    const PULSE_UPDATE_INTERVAL_MS = 500;

    this.newsPulseIntervalId = setInterval(() => {
      const now = Date.now();
      if (!this.needsPulseAnimation(now)) {
        this.pulseTime = now;
        this.stopPulseAnimation();
        this.rafUpdateLayers();
        return;
      }
      this.pulseTime = now;
      this.rafUpdateLayers();
    }, PULSE_UPDATE_INTERVAL_MS);
  }

  private stopPulseAnimation(): void {
    if (this.newsPulseIntervalId !== null) {
      clearInterval(this.newsPulseIntervalId);
      this.newsPulseIntervalId = null;
    }
  }

  private createNewsLocationsLayer(): ScatterplotLayer[] {
    const zoom = this.maplibreMap?.getZoom() || 2;
    const alphaScale = zoom < 2.5 ? 0.4 : zoom < 4 ? 0.7 : 1.0;
    const filteredNewsLocations = this.filterByTime(this.newsLocations, (location) => location.timestamp);
    const THREAT_RGB: Record<string, [number, number, number]> = {
      critical: [239, 68, 68],
      high: [249, 115, 22],
      medium: [234, 179, 8],
      low: [34, 197, 94],
      info: [59, 130, 246],
    };
    const THREAT_ALPHA: Record<string, number> = {
      critical: 220,
      high: 190,
      medium: 160,
      low: 120,
      info: 80,
    };

    const now = this.pulseTime || Date.now();
    const PULSE_DURATION = 30_000;

    const layers: ScatterplotLayer[] = [
      new ScatterplotLayer({
        id: 'news-locations-layer',
        data: filteredNewsLocations,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 18000,
        getFillColor: (d) => {
          const rgb = THREAT_RGB[d.threatLevel] || [59, 130, 246];
          const a = Math.round((THREAT_ALPHA[d.threatLevel] || 120) * alphaScale);
          return [...rgb, a] as [number, number, number, number];
        },
        radiusMinPixels: 3,
        radiusMaxPixels: 12,
        pickable: true,
      }),
    ];

    const recentNews = filteredNewsLocations.filter(d => {
      const firstSeen = this.newsLocationFirstSeen.get(d.title);
      return firstSeen && (now - firstSeen) < PULSE_DURATION;
    });

    if (recentNews.length > 0) {
      const pulse = 1.0 + 1.5 * (0.5 + 0.5 * Math.sin(now / 318));

      layers.push(new ScatterplotLayer({
        id: 'news-pulse-layer',
        data: recentNews,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 18000,
        radiusScale: pulse,
        radiusMinPixels: 6,
        radiusMaxPixels: 30,
        pickable: false,
        stroked: true,
        filled: false,
        getLineColor: (d) => {
          const rgb = THREAT_RGB[d.threatLevel] || [59, 130, 246];
          const firstSeen = this.newsLocationFirstSeen.get(d.title) || now;
          const age = now - firstSeen;
          const fadeOut = Math.max(0, 1 - age / PULSE_DURATION);
          const a = Math.round(150 * fadeOut * alphaScale);
          return [...rgb, a] as [number, number, number, number];
        },
        lineWidthMinPixels: 1.5,
        updateTriggers: { pulseTime: now },
      }));
    }

    return layers;
  }

  private createPositiveEventsLayers(items: PositiveGeoEvent[]): Layer[] {
    const layers: Layer[] = [];

    const getCategoryColor = (category: string): [number, number, number, number] => {
      switch (category) {
        case 'nature-wildlife':
        case 'humanity-kindness':
          return [34, 197, 94, 200]; // green
        case 'science-health':
        case 'innovation-tech':
        case 'climate-wins':
          return [234, 179, 8, 200]; // gold
        case 'culture-community':
          return [139, 92, 246, 200]; // purple
        default:
          return [34, 197, 94, 200]; // green default
      }
    };

    // Dot layer (tooltip on hover via getTooltip)
    layers.push(new ScatterplotLayer({
      id: 'positive-events-layer',
      data: items,
      getPosition: (d: PositiveGeoEvent) => [d.lon, d.lat],
      getRadius: 12000,
      getFillColor: (d: PositiveGeoEvent) => getCategoryColor(d.category),
      radiusMinPixels: 5,
      radiusMaxPixels: 10,
      pickable: true,
    }));

    // Gentle pulse ring for significant events (count > 8)
    const significantEvents = items.filter(e => e.count > 8);
    if (significantEvents.length > 0) {
      const pulse = 1.0 + 0.4 * (0.5 + 0.5 * Math.sin((this.pulseTime || Date.now()) / 800));
      layers.push(new ScatterplotLayer({
        id: 'positive-events-pulse',
        data: significantEvents,
        getPosition: (d: PositiveGeoEvent) => [d.lon, d.lat],
        getRadius: 15000,
        radiusScale: pulse,
        radiusMinPixels: 8,
        radiusMaxPixels: 24,
        stroked: true,
        filled: false,
        getLineColor: (d: PositiveGeoEvent) => getCategoryColor(d.category),
        lineWidthMinPixels: 1.5,
        pickable: false,
        updateTriggers: { radiusScale: this.pulseTime },
      }));
    }

    return layers;
  }

  private createKindnessLayers(items: KindnessPoint[]): Layer[] {
    const layers: Layer[] = [];
    if (items.length === 0) return layers;

    // Dot layer (tooltip on hover via getTooltip)
    layers.push(new ScatterplotLayer<KindnessPoint>({
      id: 'kindness-layer',
      data: items,
      getPosition: (d: KindnessPoint) => [d.lon, d.lat],
      getRadius: 12000,
      getFillColor: [74, 222, 128, 200] as [number, number, number, number],
      radiusMinPixels: 5,
      radiusMaxPixels: 10,
      pickable: true,
    }));

    // Pulse for real events
    const pulse = 1.0 + 0.4 * (0.5 + 0.5 * Math.sin((this.pulseTime || Date.now()) / 800));
    layers.push(new ScatterplotLayer<KindnessPoint>({
      id: 'kindness-pulse',
      data: items,
      getPosition: (d: KindnessPoint) => [d.lon, d.lat],
      getRadius: 14000,
      radiusScale: pulse,
      radiusMinPixels: 6,
      radiusMaxPixels: 18,
      stroked: true,
      filled: false,
      getLineColor: [74, 222, 128, 80] as [number, number, number, number],
      lineWidthMinPixels: 1,
      pickable: false,
      updateTriggers: { radiusScale: this.pulseTime },
    }));

    return layers;
  }

  private createHappinessChoroplethLayer(): GeoJsonLayer | null {
    if (!this.countriesGeoJsonData || this.happinessScores.size === 0) return null;
    const scores = this.happinessScores;
    return new GeoJsonLayer({
      id: 'happiness-choropleth-layer',
      data: this.countriesGeoJsonData,
      filled: true,
      stroked: true,
      getFillColor: (feature: { properties?: Record<string, unknown> }) => {
        const code = feature.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
        const score = code ? scores.get(code) : undefined;
        if (score == null) return [0, 0, 0, 0] as [number, number, number, number];
        const t = score / 10;
        return [
          Math.round(40 + (1 - t) * 180),
          Math.round(180 + t * 60),
          Math.round(40 + (1 - t) * 100),
          140,
        ] as [number, number, number, number];
      },
      getLineColor: [100, 100, 100, 60] as [number, number, number, number],
      getLineWidth: 1,
      lineWidthMinPixels: 0.5,
      pickable: true,
      updateTriggers: { getFillColor: [scores.size] },
    });
  }

  private static readonly CII_LEVEL_HEX: Record<string, string> = {
    critical: '#b91c1c', high: '#dc2626', elevated: '#f59e0b', normal: '#eab308', low: '#22c55e',
  };

  private createCIIChoroplethLayer(): GeoJsonLayer | null {
    if (!this.countriesGeoJsonData || this.ciiScoresMap.size === 0) return null;
    const scores = this.ciiScoresMap;
    const colors = CII_LEVEL_COLORS;
    return new GeoJsonLayer({
      id: 'cii-choropleth-layer',
      data: this.countriesGeoJsonData,
      filled: true,
      stroked: true,
      getFillColor: (feature: { properties?: Record<string, unknown> }) => {
        const code = feature.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
        const entry = code ? scores.get(code) : undefined;
        return entry ? (colors[entry.level as CiiLevel] ?? [0, 0, 0, 0]) : [0, 0, 0, 0];
      },
      getLineColor: [80, 80, 80, 80] as [number, number, number, number],
      getLineWidth: 1,
      lineWidthMinPixels: 0.5,
      pickable: true,
      updateTriggers: { getFillColor: [this.ciiScoresVersion] },
    });
  }

  private createResilienceChoroplethLayer(): GeoJsonLayer | null {
    if (!this.countriesGeoJsonData || this.resilienceScoresMap.size === 0) return null;
    const scores = this.resilienceScoresMap;
    return new GeoJsonLayer({
      id: 'resilience-choropleth-layer',
      data: this.countriesGeoJsonData,
      filled: true,
      stroked: true,
      getFillColor: (feature: { properties?: Record<string, unknown> }) => {
        const code = feature.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
        const entry = code ? scores.get(code) : undefined;
        return entry ? RESILIENCE_CHOROPLETH_COLORS[entry.level] : [0, 0, 0, 0];
      },
      getLineColor: [80, 80, 80, 80] as [number, number, number, number],
      getLineWidth: 1,
      lineWidthMinPixels: 0.5,
      pickable: true,
      updateTriggers: { getFillColor: [this.resilienceScoresVersion] },
    });
  }

  private createSanctionsChoroplethLayer(): GeoJsonLayer | null {
    if (!this.countriesGeoJsonData) return null;
    return new GeoJsonLayer({
      id: 'sanctions-choropleth-layer',
      data: this.countriesGeoJsonData,
      filled: true,
      stroked: false,
      getFillColor: (feature: { properties?: Record<string, unknown> }) => {
        const code = feature.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
        const level = code ? SANCTIONED_COUNTRIES_ALPHA2[code] : undefined;
        if (level === 'severe') return [255, 0, 0, 89] as [number, number, number, number];
        if (level === 'high') return [255, 100, 0, 64] as [number, number, number, number];
        if (level === 'moderate') return [255, 200, 0, 51] as [number, number, number, number];
        return [0, 0, 0, 0] as [number, number, number, number];
      },
      pickable: false,
    });
  }

  private createScenarioHeatLayer(): GeoJsonLayer | null {
    if (!this.affectedIso2Set.size || !this.countriesGeoJsonData) return null;
    return new GeoJsonLayer({
      id: 'scenario-heat-layer',
      data: this.countriesGeoJsonData,
      stroked: false,
      filled: true,
      extruded: false,
      pickable: false,
      getFillColor: (feature: { properties?: Record<string, unknown> }) => {
        const code = feature.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
        return (code && this.affectedIso2Set.has(code) ? [220, 60, 40, 80] : [0, 0, 0, 0]) as [number, number, number, number];
      },
      updateTriggers: { getFillColor: [this.scenarioState?.scenarioId ?? null] },
    });
  }

  private createSpeciesRecoveryLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'species-recovery-layer',
      data: this.speciesRecoveryZones,
      getPosition: (d: (typeof this.speciesRecoveryZones)[number]) => [d.recoveryZone.lon, d.recoveryZone.lat],
      getRadius: 50000,
      radiusMinPixels: 8,
      radiusMaxPixels: 25,
      getFillColor: [74, 222, 128, 120] as [number, number, number, number],
      stroked: true,
      getLineColor: [74, 222, 128, 200] as [number, number, number, number],
      lineWidthMinPixels: 1.5,
      pickable: true,
    });
  }

  private createRenewableInstallationsLayer(): ScatterplotLayer {
    const typeColors: Record<string, [number, number, number, number]> = {
      solar: [255, 200, 50, 200],
      wind: [100, 200, 255, 200],
      hydro: [0, 180, 180, 200],
      geothermal: [255, 150, 80, 200],
    };
    const typeLineColors: Record<string, [number, number, number, number]> = {
      solar: [255, 200, 50, 255],
      wind: [100, 200, 255, 255],
      hydro: [0, 180, 180, 255],
      geothermal: [255, 150, 80, 255],
    };
    return new ScatterplotLayer({
      id: 'renewable-installations-layer',
      data: this.renewableInstallations,
      getPosition: (d: RenewableInstallation) => [d.lon, d.lat],
      getRadius: 30000,
      radiusMinPixels: 5,
      radiusMaxPixels: 18,
      getFillColor: (d: RenewableInstallation) => typeColors[d.type] ?? [200, 200, 200, 200] as [number, number, number, number],
      stroked: true,
      getLineColor: (d: RenewableInstallation) => typeLineColors[d.type] ?? [200, 200, 200, 255] as [number, number, number, number],
      lineWidthMinPixels: 1,
      pickable: true,
    });
  }

  private createImageryFootprintLayer(items: ImageryScene[]): PolygonLayer {
    return new PolygonLayer({
      id: 'satellite-imagery-layer',
      data: items.filter(s => s.geometryGeojson),
      getPolygon: (d: ImageryScene) => {
        try {
          const geom = JSON.parse(d.geometryGeojson);
          if (geom.type === 'Polygon') return geom.coordinates[0];
          return [];
        } catch { return []; }
      },
      getFillColor: [0, 180, 255, 40] as [number, number, number, number],
      stroked: false,
      pickable: true,
    });
  }

  private async fetchImageryForViewport(): Promise<void> {
    const map = this.maplibreMap;
    if (!map) return;
    const bounds = map.getBounds();
    const bbox = `${bounds.getWest().toFixed(4)},${bounds.getSouth().toFixed(4)},${bounds.getEast().toFixed(4)},${bounds.getNorth().toFixed(4)}`;
    const version = ++this.imagerySearchVersion;
    try {
      const scenes = await fetchImageryScenes({ bbox, limit: 20 });
      if (version !== this.imagerySearchVersion) return;
      this.imageryScenes = scenes;
      this.render();
    } catch { /* viewport fetch failed silently */ }
  }

  private getTooltip(info: PickingInfo): { html: string } | null {
    if (!info.object) return null;

    const rawLayerId = info.layer?.id || '';
    const layerId = rawLayerId.endsWith('-ghost') ? rawLayerId.slice(0, -6) : rawLayerId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = info.object as any;
    const text = (value: unknown): string => escapeHtml(String(value ?? ''));

    switch (layerId) {
      case 'hotspots-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.subtext)}</div>` };
      case 'earthquakes-layer':
        return { html: `<div class="deckgl-tooltip"><strong>M${(obj.magnitude || 0).toFixed(1)} ${t('components.deckgl.tooltip.earthquake')}</strong><br/>${text(obj.place)}</div>` };
      case 'military-vessels-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.operatorCountry)}</div>` };
      case 'military-flights-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.callsign || obj.registration || t('components.deckgl.tooltip.militaryAircraft'))}</strong><br/>${text(obj.type)}</div>` };
      case 'military-vessel-clusters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.vesselCluster'))}</strong><br/>${obj.vesselCount || 0} ${t('components.deckgl.tooltip.vessels')}<br/>${text(obj.activityType)}</div>` };
      case 'military-flight-clusters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.flightCluster'))}</strong><br/>${obj.flightCount || 0} ${t('components.deckgl.tooltip.aircraft')}<br/>${text(obj.activityType)}</div>` };
      case 'protests-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.country)}</div>` };
      case 'protest-clusters-layer':
        if (obj.count === 1) {
          const item = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(item?.title || t('components.deckgl.tooltip.protest'))}</strong><br/>${text(item?.city || item?.country || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.protestsCount', { count: String(obj.count) })}</strong><br/>${text(obj.country)}</div>` };
      case 'tech-hq-clusters-layer':
        if (obj.count === 1) {
          const hq = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(hq?.company || '')}</strong><br/>${text(hq?.city || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.techHQsCount', { count: String(obj.count) })}</strong><br/>${text(obj.city)}</div>` };
      case 'tech-event-clusters-layer':
        if (obj.count === 1) {
          const ev = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(ev?.title || '')}</strong><br/>${text(ev?.location || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.techEventsCount', { count: String(obj.count) })}</strong><br/>${text(obj.location)}</div>` };
      case 'datacenter-clusters-layer':
        if (obj.count === 1) {
          const dc = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(dc?.name || '')}</strong><br/>${text(dc?.owner || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.dataCentersCount', { count: String(obj.count) })}</strong><br/>${text(obj.country)}</div>` };
      case 'bases-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country)}${obj.kind ? ` · ${text(obj.kind)}` : ''}</div>` };
      case 'bases-cluster-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${obj.count} bases</strong></div>` };
      case 'nuclear-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)}</div>` };
      case 'datacenters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.owner)}</div>` };
      case 'cables-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${t('components.deckgl.tooltip.underseaCable')}</div>` };
      case 'pipelines-layer': {
        const pipelineType = String(obj.type || '').toLowerCase();
        const pipelineTypeLabel = pipelineType === 'oil'
          ? t('popups.pipeline.types.oil')
          : pipelineType === 'gas'
            ? t('popups.pipeline.types.gas')
            : pipelineType === 'products'
              ? t('popups.pipeline.types.products')
              : `${text(obj.type)} ${t('components.deckgl.tooltip.pipeline')}`;
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${pipelineTypeLabel}</div>` };
      }
      case 'conflict-zones-layer': {
        const props = obj.properties || obj;
        return { html: `<div class="deckgl-tooltip"><strong>${text(props.name)}</strong><br/>${t('components.deckgl.tooltip.conflictZone')}</div>` };
      }

      case 'natural-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.category || t('components.deckgl.tooltip.naturalEvent'))}</div>` };
      case 'storm-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName || obj.title)}</strong><br/>${text(obj.classification || '')} ${obj.windKt ? obj.windKt + ' kt' : ''}</div>` };
      case 'storm-forecast-track-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>${t('popups.naturalEvent.classification')}: Forecast Track</div>` };
      case 'storm-past-track-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>Past Track (${obj.windKt} kt)</div>` };
      case 'storm-cone-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>Forecast Cone</div>` };
      case 'ais-density-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.layers.shipTraffic')}</strong><br/>${t('popups.intensity')}: ${text(obj.intensity)}</div>` };
      case 'waterways-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${t('components.deckgl.layers.strategicWaterways')}</div>` };
      case 'economic-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country)}</div>` };
      case 'stock-exchanges-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.shortName)}</strong><br/>${text(obj.city)}, ${text(obj.country)}</div>` };
      case 'financial-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)} ${t('components.deckgl.tooltip.financialCenter')}</div>` };
      case 'central-banks-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.shortName)}</strong><br/>${text(obj.city)}, ${text(obj.country)}</div>` };
      case 'commodity-hubs-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)} · ${text(obj.city)}</div>` };
      case 'startup-hubs-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.city)}</strong><br/>${text(obj.country)}</div>` };
      case 'tech-hqs-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.company)}</strong><br/>${text(obj.city)}</div>` };
      case 'accelerators-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.city)}</div>` };
      case 'cloud-regions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.provider)}</strong><br/>${text(obj.region)}</div>` };
      case 'tech-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.location)}</div>` };
      case 'irradiators-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type || t('components.deckgl.layers.gammaIrradiators'))}</div>` };
      case 'disease-outbreaks-layer': {
        const item = (obj as { item: DiseaseOutbreakItem }).item;
        if (!item) return null;
        const lvlColor = item.alertLevel === 'alert' ? '#e74c3c' : item.alertLevel === 'warning' ? '#e67e22' : '#f1c40f';
        const casesHtml = item.cases ? ` | ${item.cases} case${item.cases !== 1 ? 's' : ''}` : '';
        const dateStr = new Date(item.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const metaHtml = `<br/><span style="opacity:.6;font-size:11px">${text(item.sourceName || '')} | ${dateStr}${casesHtml}</span>`;
        const summaryHtml = item.summary ? `<br/><span style="opacity:.75">${text(item.summary.slice(0, 100))}${item.summary.length > 100 ? '…' : ''}</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong style="color:${lvlColor}">${text(item.alertLevel.toUpperCase())}</strong> ${text(item.disease)}<br/>${text(item.location)}${summaryHtml}${metaHtml}</div>` };
      }
      case 'radiation-watch-layer': {
        const severityLabel = obj.severity === 'spike' ? t('components.deckgl.layers.radiationSpike') : t('components.deckgl.layers.radiationElevated');
        const delta = Number(obj.delta || 0);
        const confidence = String(obj.confidence || 'low').toUpperCase();
        const corroboration = obj.corroborated ? 'CONFIRMED' : obj.conflictingSources ? 'CONFLICTING' : confidence;
        return { html: `<div class="deckgl-tooltip"><strong>${severityLabel}</strong><br/>${text(obj.location)}<br/>${Number(obj.value).toFixed(1)} ${text(obj.unit)} · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs baseline<br/>${text(corroboration)}</div>` };
      }
      case 'spaceports-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country || t('components.deckgl.layers.spaceports'))}</div>` };
      case 'ports-layer': {
        const typeIcon = obj.type === 'naval' ? '⚓' : obj.type === 'oil' || obj.type === 'lng' ? '🛢️' : '🏭';
        return { html: `<div class="deckgl-tooltip"><strong>${typeIcon} ${text(obj.name)}</strong><br/>${text(obj.type || t('components.deckgl.tooltip.port'))} - ${text(obj.country)}</div>` };
      }
      case 'flight-delays-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)} (${text(obj.iata)})</strong><br/>${text(obj.severity)}: ${text(obj.reason)}</div>` };
      case 'notam-overlay-layer':
        return { html: `<div class="deckgl-tooltip"><strong style="color:#ff2828;">&#9888; NOTAM CLOSURE</strong><br/>${text(obj.name)} (${text(obj.iata)})<br/><span style="opacity:.7">${text((obj.reason || '').slice(0, 100))}</span></div>` };
      case 'aircraft-positions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.callsign || obj.icao24)}</strong><br/>${obj.altitudeFt?.toLocaleString() ?? 0} ft · ${obj.groundSpeedKts ?? 0} kts · ${Math.round(obj.trackDeg ?? 0)}°</div>` };
      case 'apt-groups-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.aka)}<br/>${t('popups.sponsor')}: ${text(obj.sponsor)}</div>` };
      case 'minerals-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.mineral)} - ${text(obj.country)}<br/>${text(obj.operator)}</div>` };
      case 'mining-sites-layer': {
        const statusLabel = obj.status === 'producing' ? '⛏️ Producing' : obj.status === 'development' ? '🔧 Development' : '🔍 Exploration';
        const outputStr = obj.annualOutput ? `<br/><span style="opacity:.75">${text(obj.annualOutput)}</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.mineral)} · ${text(obj.country)}<br/>${statusLabel}${outputStr}</div>` };
      }
      case 'processing-plants-layer': {
        const typeLabel = obj.type === 'smelter' ? '🏭 Smelter' : obj.type === 'refinery' ? '⚗️ Refinery' : obj.type === 'separation' ? '🧪 Separation' : '🏗️ Processing';
        const capacityStr = obj.capacityTpa ? `<br/><span style="opacity:.75">${text(String((obj.capacityTpa / 1000).toFixed(0)))}k t/yr</span>` : '';
        const mineralLabel = obj.mineral ?? (Array.isArray(obj.materials) ? obj.materials.join(', ') : '');
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(mineralLabel)} · ${text(obj.country)}<br/>${typeLabel}${capacityStr}</div>` };
      }
      case 'commodity-ports-layer': {
        const commoditiesStr = Array.isArray(obj.commodities) ? obj.commodities.join(', ') : '';
        const volumeStr = obj.annualVolumeMt ? `<br/><span style="opacity:.75">${text(String(obj.annualVolumeMt))}Mt/yr</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>⚓ ${text(obj.name)}</strong><br/>${text(obj.country)}<br/>${text(commoditiesStr)}${volumeStr}</div>` };
      }
      case 'ais-disruptions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>AIS ${text(obj.type || t('components.deckgl.tooltip.disruption'))}</strong><br/>${text(obj.severity)} ${t('popups.severity')}<br/>${text(obj.description)}</div>` };
      case 'gps-jamming-layer':
        return { html: `<div class="deckgl-tooltip"><strong>GPS Jamming</strong><br/>${text(obj.level)} · NP avg: ${Number(obj.npAvg).toFixed(2)}<br/>H3: ${text(obj.h3)}</div>` };
      case 'cable-advisories-layer': {
        const cableName = UNDERSEA_CABLES.find(c => c.id === obj.cableId)?.name || obj.cableId;
        return { html: `<div class="deckgl-tooltip"><strong>${text(cableName)}</strong><br/>${text(obj.severity || t('components.deckgl.tooltip.advisory'))}<br/>${text(obj.description)}</div>` };
      }
      case 'repair-ships-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.repairShip'))}</strong><br/>${text(obj.status)}</div>` };
      case 'weather-layer': {
        const areaDesc = typeof obj.areaDesc === 'string' ? obj.areaDesc : '';
        const area = areaDesc ? `<br/><small>${text(areaDesc.slice(0, 50))}${areaDesc.length > 50 ? '...' : ''}</small>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.event || t('components.deckgl.layers.weatherAlerts'))}</strong><br/>${text(obj.severity)}${area}</div>` };
      }
      case 'outages-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title || t('components.deckgl.tooltip.internetOutage'))}</strong><br/>${text(obj.country)}</div>` };
      case 'traffic-anomalies-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.type || 'Traffic Anomaly')}</strong><br/>${text(obj.locationName || obj.asnName || '')}</div>` };
      case 'ddos-locations-layer':
        return { html: `<div class="deckgl-tooltip"><strong>DDoS: ${text(obj.countryName)}</strong><br/>${text(obj.percentage ? obj.percentage.toFixed(1) + '%' : '')}</div>` };
      case 'cyber-threats-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${t('popups.cyberThreat.title')}</strong><br/>${text(obj.severity || t('components.deckgl.tooltip.medium'))} · ${text(obj.country || t('popups.unknown'))}</div>` };
      case 'iran-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.layers.iranAttacks')}: ${text(obj.category || '')}</strong><br/>${text((obj.title || '').slice(0, 80))}</div>` };
      case 'news-locations-layer':
        return { html: `<div class="deckgl-tooltip"><strong>📰 ${t('components.deckgl.tooltip.news')}</strong><br/>${text(obj.title?.slice(0, 80) || '')}</div>` };
      case 'positive-events-layer': {
        const catLabel = obj.category ? obj.category.replace(/-/g, ' & ') : 'Positive Event';
        const countInfo = obj.count > 1 ? `<br/><span style="opacity:.7">${obj.count} sources reporting</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/><span style="text-transform:capitalize">${text(catLabel)}</span>${countInfo}</div>` };
      }
      case 'kindness-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong></div>` };
      case 'happiness-choropleth-layer': {
        const hcName = obj.properties?.name ?? 'Unknown';
        const hcCode = obj.properties?.['ISO3166-1-Alpha-2'];
        const hcScore = hcCode ? this.happinessScores.get(hcCode as string) : undefined;
        const hcScoreStr = hcScore != null ? hcScore.toFixed(1) : 'No data';
        return { html: `<div class="deckgl-tooltip"><strong>${text(hcName)}</strong><br/>Happiness: ${hcScoreStr}/10${hcScore != null ? `<br/><span style="opacity:.7">${text(this.happinessSource)} (${this.happinessYear})</span>` : ''}</div>` };
      }
      case 'cii-choropleth-layer': {
        const ciiName = obj.properties?.name ?? 'Unknown';
        const ciiCode = obj.properties?.['ISO3166-1-Alpha-2'];
        const ciiEntry = ciiCode ? this.ciiScoresMap.get(ciiCode as string) : undefined;
        if (!ciiEntry) return { html: `<div class="deckgl-tooltip"><strong>${text(ciiName)}</strong><br/><span style="opacity:.7">No CII data</span></div>` };
        const levelColor = DeckGLMap.CII_LEVEL_HEX[ciiEntry.level] ?? '#888';
        return { html: `<div class="deckgl-tooltip"><strong>${text(ciiName)}</strong><br/>CII: <span style="color:${levelColor};font-weight:600">${ciiEntry.score}/100</span><br/><span style="text-transform:capitalize;opacity:.7">${text(ciiEntry.level)}</span></div>` };
      }
      case 'resilience-choropleth-layer': {
        const resilienceName = obj.properties?.name ?? 'Unknown';
        const resilienceCode = obj.properties?.['ISO3166-1-Alpha-2'];
        const resilienceEntry = resilienceCode ? this.resilienceScoresMap.get(resilienceCode as string) : undefined;
        if (!resilienceEntry) {
          return { html: `<div class="deckgl-tooltip"><strong>${text(resilienceName)}</strong><br/><span style="opacity:.7">No resilience data</span></div>` };
        }
        if (resilienceEntry.level === 'insufficient_data') {
          return { html: `<div class="deckgl-tooltip"><strong>${text(resilienceName)}</strong><br/><span style="opacity:.7">Insufficient data</span></div>` };
        }
        const [red, green, blue] = RESILIENCE_CHOROPLETH_COLORS[resilienceEntry.level];
        const levelColor = `rgb(${red}, ${green}, ${blue})`;
        return {
          html: `<div class="deckgl-tooltip"><strong>${text(resilienceName)}</strong><br/>Resilience: <span style="color:${levelColor};font-weight:600">${resilienceEntry.overallScore.toFixed(1)}/100</span><br/><span style="text-transform:capitalize;opacity:.7">${text(resilienceEntry.serverLevel)}</span>${resilienceEntry.lowConfidence ? '<br/><span style="opacity:.7">Low confidence</span>' : ''}</div>`,
        };
      }
      case 'species-recovery-layer': {
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.commonName)}</strong><br/>${text(obj.recoveryZone?.name ?? obj.region)}<br/><span style="opacity:.7">Status: ${text(obj.recoveryStatus)}</span></div>` };
      }
      case 'renewable-installations-layer': {
        const riTypeLabel = obj.type ? String(obj.type).charAt(0).toUpperCase() + String(obj.type).slice(1) : 'Renewable';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${riTypeLabel} &middot; ${obj.capacityMW?.toLocaleString() ?? '?'} MW<br/><span style="opacity:.7">${text(obj.country)} &middot; ${obj.year}</span></div>` };
      }
      case 'gulf-investments-layer': {
        const inv = obj as GulfInvestment;
        const flag = inv.investingCountry === 'SA' ? '🇸🇦' : '🇦🇪';
        const usd = inv.investmentUSD != null
          ? (inv.investmentUSD >= 1000 ? `$${(inv.investmentUSD / 1000).toFixed(1)}B` : `$${inv.investmentUSD}M`)
          : t('components.deckgl.tooltip.undisclosed');
        const stake = inv.stakePercent != null ? `<br/>${text(String(inv.stakePercent))}% ${t('components.deckgl.tooltip.stake')}` : '';
        return {
          html: `<div class="deckgl-tooltip">
            <strong>${flag} ${text(inv.assetName)}</strong><br/>
            <em>${text(inv.investingEntity)}</em><br/>
            ${text(inv.targetCountry)} · ${text(inv.sector)}<br/>
            <strong>${usd}</strong>${stake}<br/>
            <span style="text-transform:capitalize">${text(inv.status)}</span>
          </div>`,
        };
      }
      case 'satellite-imagery-layer': {
        let imgHtml = `<div class="deckgl-tooltip"><strong>&#128752; ${text(obj.satellite)}</strong><br/>${text(obj.datetime)}<br/>Res: ${Number(obj.resolutionM)}m \u00B7 ${text(obj.mode)}`;
        if (isAllowedPreviewUrl(obj.previewUrl)) {
          const safeHref = escapeHtml(new URL(obj.previewUrl).href);
          imgHtml += `<br><img src="${safeHref}" referrerpolicy="no-referrer" style="max-width:180px;max-height:120px;margin-top:4px;border-radius:4px;" class="imagery-preview">`;
        }
        imgHtml += '</div>';
        return { html: imgHtml };
      }
      case 'webcam-layer': {
        const label = 'count' in obj
          ? `${obj.count} webcams`
          : (obj.title || obj.name || 'Webcam');
        return { html: `<div class="deckgl-tooltip"><strong>${text(label)}</strong></div>` };
      }
      default:
        return null;
    }
  }

  private static readonly CHOROPLETH_LAYER_IDS = new Set([
    'cii-choropleth-layer',
    'happiness-choropleth-layer',
    'resilience-choropleth-layer',
  ]);

  private handleClick(info: PickingInfo): void {
    const isChoropleth = info.layer?.id ? DeckGLMap.CHOROPLETH_LAYER_IDS.has(info.layer.id) : false;
    if (!info.object || isChoropleth) {
      if (info.coordinate && this.onCountryClick) {
        const [lon, lat] = info.coordinate as [number, number];
        let country: { code: string; name: string } | null = null;
        if (isChoropleth && info.object?.properties) {
          country = { code: info.object.properties['ISO3166-1-Alpha-2'] as string, name: info.object.properties.name as string };
        } else if (this.hoveredCountryIso2 && this.hoveredCountryName) {
          // Use pre-resolved hover state for instant response
          country = { code: this.hoveredCountryIso2, name: this.hoveredCountryName };
        } else {
          country = this.resolveCountryFromCoordinate(lon, lat);
        }
        // Only fire if we have a country — ocean/no-country clicks are silently ignored
        if (country?.code && country?.name) {
          this.onCountryClick({ lat, lon, code: country.code, name: country.name });
        }
      }
      return;
    }

    const rawClickLayerId = info.layer?.id || '';
    const layerId = rawClickLayerId.endsWith('-ghost') ? rawClickLayerId.slice(0, -6) : rawClickLayerId;

    // Hotspots show popup with related news
    if (layerId === 'hotspots-layer') {
      const hotspot = info.object as Hotspot;
      const relatedNews = this.getRelatedNews(hotspot);
      this.popup.show({
        type: 'hotspot',
        data: hotspot,
        relatedNews,
        x: info.x,
        y: info.y,
      });
      this.popup.loadHotspotGdeltContext(hotspot);
      this.onHotspotClick?.(hotspot);
      return;
    }

    // Handle cluster layers with single/multi logic
    if (layerId === 'protest-clusters-layer') {
      const cluster = info.object as MapProtestCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.protestSC) {
        try {
          const leaves = this.protestSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.protestSuperclusterSource[l.properties.index]).filter((x): x is SocialUnrestEvent => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e) {
          console.warn('[DeckGLMap] stale protest cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'protest', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'protestCluster',
          data: {
            items: cluster.items,
            country: cluster.country,
            count: cluster.count,
            riotCount: cluster.riotCount,
            highSeverityCount: cluster.highSeverityCount,
            verifiedCount: cluster.verifiedCount,
            totalFatalities: cluster.totalFatalities,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }
    if (layerId === 'tech-hq-clusters-layer') {
      const cluster = info.object as MapTechHQCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.techHQSC) {
        try {
          const leaves = this.techHQSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => TECH_HQS[l.properties.index]).filter(Boolean) as typeof TECH_HQS;
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e) {
          console.warn('[DeckGLMap] stale techHQ cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'techHQ', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'techHQCluster',
          data: {
            items: cluster.items,
            city: cluster.city,
            country: cluster.country,
            count: cluster.count,
            faangCount: cluster.faangCount,
            unicornCount: cluster.unicornCount,
            publicCount: cluster.publicCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }
    if (layerId === 'tech-event-clusters-layer') {
      const cluster = info.object as MapTechEventCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.techEventSC) {
        try {
          const leaves = this.techEventSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.techEvents[l.properties.index]).filter((x): x is TechEventMarker => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e) {
          console.warn('[DeckGLMap] stale techEvent cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'techEvent', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'techEventCluster',
          data: {
            items: cluster.items,
            location: cluster.location,
            country: cluster.country,
            count: cluster.count,
            soonCount: cluster.soonCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }
    if (layerId === 'datacenter-clusters-layer') {
      const cluster = info.object as MapDatacenterCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.datacenterSC) {
        try {
          const leaves = this.datacenterSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.datacenterSCSource[l.properties.index]).filter((x): x is AIDataCenter => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e) {
          console.warn('[DeckGLMap] stale datacenter cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'datacenter', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'datacenterCluster',
          data: {
            items: cluster.items,
            region: cluster.region || cluster.country,
            country: cluster.country,
            count: cluster.count,
            totalChips: cluster.totalChips,
            totalPowerMW: cluster.totalPowerMW,
            existingCount: cluster.existingCount,
            plannedCount: cluster.plannedCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }

    if (layerId === 'webcam-layer' && !('count' in info.object)) {
      this.showWebcamClickPopup(info.object as WebcamEntry, info.x, info.y);
      return;
    }

    if (layerId === 'trade-routes-layer') {
      const segment = info.object as TradeRouteSegment;
      if (!hasPremiumAccess(getAuthState())) {
        trackGateHit('trade-arc-intel');
        return;
      }
      const waypoints = ROUTE_WAYPOINTS_MAP.get(segment.routeId) ?? [];
      this.popup.showRouteBreakdown(segment, waypoints, info.x, info.y);
      this.onTradeArcClick?.(segment, waypoints, info.x, info.y);
      return;
    }

    // Map layer IDs to popup types
    const layerToPopupType: Record<string, PopupType> = {
      'conflict-zones-layer': 'conflict',

      'bases-layer': 'base',
      'nuclear-layer': 'nuclear',
      'irradiators-layer': 'irradiator',
      'radiation-watch-layer': 'radiation',
      'datacenters-layer': 'datacenter',
      'cables-layer': 'cable',
      'pipelines-layer': 'pipeline',
      'earthquakes-layer': 'earthquake',
      'weather-layer': 'weather',
      'outages-layer': 'outage',
      'cyber-threats-layer': 'cyberThreat',
      'iran-events-layer': 'iranEvent',
      'protests-layer': 'protest',
      'military-flights-layer': 'militaryFlight',
      'military-vessels-layer': 'militaryVessel',
      'military-vessel-clusters-layer': 'militaryVesselCluster',
      'military-flight-clusters-layer': 'militaryFlightCluster',
      'natural-events-layer': 'natEvent',
      'storm-centers-layer': 'natEvent',
      'storm-forecast-track-layer': 'natEvent',
      'storm-past-track-layer': 'natEvent',
      'storm-cone-layer': 'natEvent',
      'waterways-layer': 'waterway',
      'economic-centers-layer': 'economic',
      'stock-exchanges-layer': 'stockExchange',
      'financial-centers-layer': 'financialCenter',
      'central-banks-layer': 'centralBank',
      'commodity-hubs-layer': 'commodityHub',
      'spaceports-layer': 'spaceport',
      'ports-layer': 'port',
      'flight-delays-layer': 'flight',
      'notam-overlay-layer': 'flight',
      'aircraft-positions-layer': 'aircraft',
      'startup-hubs-layer': 'startupHub',
      'tech-hqs-layer': 'techHQ',
      'accelerators-layer': 'accelerator',
      'cloud-regions-layer': 'cloudRegion',
      'tech-events-layer': 'techEvent',
      'apt-groups-layer': 'apt',
      'minerals-layer': 'mineral',
      'ais-disruptions-layer': 'ais',
      'gps-jamming-layer': 'gpsJamming',
      'cable-advisories-layer': 'cable-advisory',
      'repair-ships-layer': 'repair-ship',
    };

    const popupType = layerToPopupType[layerId];
    if (!popupType) return;

    // For synthetic storm layers, unwrap the backing NaturalEvent
    let data = info.object?._event ?? info.object;
    if (layerId === 'conflict-zones-layer' && info.object.properties) {
      // Find the full conflict zone data from config
      const conflictId = info.object.properties.id;
      const fullConflict = CONFLICT_ZONES.find(c => c.id === conflictId);
      if (fullConflict) data = fullConflict;
    }

    // Enrich iran events with related events from same location
    if (popupType === 'iranEvent' && data.locationName) {
      const clickedId = data.id;
      const normalizedLoc = data.locationName.trim().toLowerCase();
      const related = this.iranEvents
        .filter(e => e.id !== clickedId && e.locationName && e.locationName.trim().toLowerCase() === normalizedLoc)
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .slice(0, 5);
      data = { ...data, relatedEvents: related };
    }

    // Get click coordinates relative to container
    const x = info.x ?? 0;
    const y = info.y ?? 0;

    // Toggle flight trail on military flight click
    if (popupType === 'militaryFlight') {
      const hex = (data as MilitaryFlight).hexCode;
      if (hex) this.toggleFlightTrail(hex);
    }

    this.popup.show({
      type: popupType,
      data: data,
      x,
      y,
    });

    // Async Wingbits live enrichment for any aircraft popup
    if (popupType === 'militaryFlight') {
      const hexCode = (data as { hexCode?: string }).hexCode;
      if (hexCode) this.popup.loadWingbitsLiveFlight(hexCode);
    }
    if (popupType === 'aircraft') {
      const icao24 = (data as { icao24?: string }).icao24;
      if (icao24) this.popup.loadWingbitsLiveFlight(icao24);
    }
  }

  private async showWebcamClickPopup(webcam: WebcamEntry, x: number, y: number): Promise<void> {
    // Remove any existing popup
    this.container.querySelector('.deckgl-webcam-popup')?.remove();

    const popup = document.createElement('div');
    popup.className = 'deckgl-webcam-popup';
    popup.style.position = 'absolute';
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
    popup.style.zIndex = '1000';

    const titleEl = document.createElement('div');
    titleEl.className = 'deckgl-webcam-popup-title';
    titleEl.textContent = webcam.title || webcam.webcamId || '';
    popup.appendChild(titleEl);

    const locationEl = document.createElement('div');
    locationEl.className = 'deckgl-webcam-popup-location';
    locationEl.textContent = webcam.country || '';
    popup.appendChild(locationEl);

    const id = webcam.webcamId;

    // Fetch playerUrl for when user pins
    const imageData = await fetchWebcamImage(id).catch(() => null);

    const pinBtn = document.createElement('button');
    pinBtn.className = 'webcam-pin-btn';
    if (isPinned(id)) {
      pinBtn.classList.add('webcam-pin-btn--pinned');
      pinBtn.textContent = '\u{1F4CC} Pinned';
      pinBtn.disabled = true;
    } else {
      pinBtn.textContent = '\u{1F4CC} Pin';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pinWebcam({
          webcamId: id,
          title: webcam.title || imageData?.title || '',
          lat: webcam.lat,
          lng: webcam.lng,
          category: webcam.category || 'other',
          country: webcam.country || '',
          playerUrl: imageData?.playerUrl || '',
        });
        pinBtn.classList.add('webcam-pin-btn--pinned');
        pinBtn.textContent = '\u{1F4CC} Pinned';
        pinBtn.disabled = true;
      });
    }
    popup.appendChild(pinBtn);

    const cleanup = () => {
      popup.remove();
      document.removeEventListener('click', closeHandler);
      clearTimeout(autoDismiss);
    };
    const closeHandler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) cleanup();
    };
    const autoDismiss = setTimeout(cleanup, 8000);
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    this.container.appendChild(popup);
  }

  // Utility methods
  private hexToRgba(hex: string, alpha: number): [number, number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result?.[1] && result[2] && result[3]) {
      return [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
        alpha,
      ];
    }
    return [100, 100, 100, alpha];
  }

  // UI Creation methods
  private createControls(): void {
    const controls = document.createElement('div');
    controls.className = 'map-controls deckgl-controls';
    controls.innerHTML = `
      <div class="zoom-controls">
        <button class="map-btn zoom-in" title="${t('components.deckgl.zoomIn')}">+</button>
        <button class="map-btn zoom-out" title="${t('components.deckgl.zoomOut')}">-</button>
        <button class="map-btn zoom-reset" title="${t('components.deckgl.resetView')}">&#8962;</button>
      </div>
      <div class="view-selector">
        <select class="view-select">
          <option value="global">${t('components.deckgl.views.global')}</option>
          <option value="america">${t('components.deckgl.views.americas')}</option>
          <option value="mena">${t('components.deckgl.views.mena')}</option>
          <option value="eu">${t('components.deckgl.views.europe')}</option>
          <option value="asia">${t('components.deckgl.views.asia')}</option>
          <option value="latam">${t('components.deckgl.views.latam')}</option>
          <option value="africa">${t('components.deckgl.views.africa')}</option>
          <option value="oceania">${t('components.deckgl.views.oceania')}</option>
        </select>
      </div>
    `;

    this.container.appendChild(controls);

    // Bind events - use event delegation for reliability
    controls.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('zoom-in')) this.zoomIn();
      else if (target.classList.contains('zoom-out')) this.zoomOut();
      else if (target.classList.contains('zoom-reset')) this.resetView();
    });

    const viewSelect = controls.querySelector('.view-select') as HTMLSelectElement;
    viewSelect.value = this.state.view;
    viewSelect.addEventListener('change', () => {
      this.setView(viewSelect.value as DeckMapView);
    });

    // Clear flight trails button (hidden by default)
    this.clearTrailsBtn = document.createElement('button');
    this.clearTrailsBtn.className = 'map-clear-trails-btn';
    this.clearTrailsBtn.textContent = t('components.map.clearTrails');
    this.clearTrailsBtn.style.display = 'none';
    this.clearTrailsBtn.addEventListener('click', () => this.clearFlightTrails());
    controls.appendChild(this.clearTrailsBtn);
  }

  private createTimeSlider(): void {
    const slider = document.createElement('div');
    slider.className = 'time-slider deckgl-time-slider';
    slider.innerHTML = `
      <div class="time-options">
        <button class="time-btn ${this.state.timeRange === '1h' ? 'active' : ''}" data-range="1h">1h</button>
        <button class="time-btn ${this.state.timeRange === '6h' ? 'active' : ''}" data-range="6h">6h</button>
        <button class="time-btn ${this.state.timeRange === '24h' ? 'active' : ''}" data-range="24h">24h</button>
        <button class="time-btn ${this.state.timeRange === '48h' ? 'active' : ''}" data-range="48h">48h</button>
        <button class="time-btn ${this.state.timeRange === '7d' ? 'active' : ''}" data-range="7d">7d</button>
        <button class="time-btn ${this.state.timeRange === 'all' ? 'active' : ''}" data-range="all">${t('components.deckgl.timeAll')}</button>
      </div>
    `;

    this.container.appendChild(slider);

    slider.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = (btn as HTMLElement).dataset.range as TimeRange;
        this.setTimeRange(range);
      });
    });
  }

  private updateTimeSliderButtons(): void {
    const slider = this.container.querySelector('.deckgl-time-slider');
    if (!slider) return;
    slider.querySelectorAll('.time-btn').forEach((btn) => {
      const range = (btn as HTMLElement).dataset.range as TimeRange | undefined;
      btn.classList.toggle('active', range === this.state.timeRange);
    });
  }

  private createLayerToggles(): void {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles deckgl-layer-toggles';

    const layerDefs = getLayersForVariant((SITE_VARIANT || 'full') as MapVariant, 'flat');
    const premiumUnlocked = hasPremiumAccess(getAuthState());
    const layerConfig = layerDefs.map(def => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
      premium: def.premium,
    }));

    toggles.innerHTML = `
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="layer-help-btn" title="${t('components.deckgl.layerGuide')}">?</button>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${t('components.deckgl.layerSearch')}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list" style="max-height: 32vh; overflow-y: auto; scrollbar-width: thin;">
        ${layerConfig.map(({ key, label, icon, premium }) => {
          const isLocked = premium === 'locked' && !premiumUnlocked;
          const isEnhanced = premium === 'enhanced' && !premiumUnlocked;
          return `
          <label class="layer-toggle${isLocked ? ' layer-toggle-locked' : ''}" data-layer="${key}">
            <input type="checkbox" ${this.state.layers[key as keyof MapLayers] ? 'checked' : ''}${isLocked ? ' disabled' : ''}>
            <span class="toggle-icon">${icon}</span>
            <span class="toggle-label">${label}${isLocked ? ' \uD83D\uDD12' : ''}${isEnhanced ? ' <span class="layer-pro-badge">PRO</span>' : ''}</span>
          </label>`;
        }).join('')}
      </div>
    `;

    const authorBadge = document.createElement('div');
    authorBadge.className = 'map-author-badge';
    authorBadge.textContent = '© Elie Habib · Someone™';
    toggles.appendChild(authorBadge);

    this.container.appendChild(toggles);

    // Unlock premium layers when auth state resolves (e.g., Clerk JWT arrives after map init).
    // subscribeAuthState fires the callback synchronously if state is already available,
    // so we defer the self-unsubscribe with queueMicrotask to ensure the assignment completes.
    this._unsubscribeAuthState = subscribeAuthState((state) => {
      if (!hasPremiumAccess(state)) return;
      toggles.querySelectorAll('.layer-toggle-locked').forEach(label => {
        label.classList.remove('layer-toggle-locked');
        const input = label.querySelector('input') as HTMLInputElement | null;
        if (input) input.disabled = false;
        const labelSpan = label.querySelector('.toggle-label');
        if (labelSpan) labelSpan.textContent = labelSpan.textContent!.replace(' \uD83D\uDD12', '');
      });
      queueMicrotask(() => {
        this._unsubscribeAuthState?.();
        this._unsubscribeAuthState = null;
      });
    });

    // Bind toggle events
    toggles.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers;
        if (layer) {
          const enabled = (input as HTMLInputElement).checked;
          const prevRadar = this.state.layers.weather;
          const prevCyber = this.state.layers.cyberThreats;
          if (enabled && (layer === 'resilienceScore' || layer === 'ciiChoropleth')) {
            const conflictingLayer = layer === 'resilienceScore' ? 'ciiChoropleth' : 'resilienceScore';
            if (this.state.layers[conflictingLayer]) {
              this.state.layers[conflictingLayer] = false;
              const conflictingToggle = this.container.querySelector(`.layer-toggle[data-layer="${conflictingLayer}"] input`) as HTMLInputElement | null;
              if (conflictingToggle) conflictingToggle.checked = false;
              this.setLayerReady(conflictingLayer, false);
              this.onLayerChange?.(conflictingLayer, false, 'programmatic');
            }
          }
          this.state.layers[layer] = enabled;
          if (layer === 'military' && !enabled) this.clearFlightTrails();
          if (layer === 'flights') this.manageAircraftTimer(enabled);
          if (this.state.layers.weather && !prevRadar) this.startWeatherRadar();
          else if (!this.state.layers.weather && prevRadar) this.stopWeatherRadar();
          if (this.state.layers.cyberThreats && !prevCyber && !this.aptGroupsLoaded) this.loadAptGroups();
          this.render();
          this.updateLegend();
          this.onLayerChange?.(layer, enabled, 'user');
          this.enforceLayerLimit();
        }
      });
    });
    this.enforceLayerLimit();

    // Help button
    const helpBtn = toggles.querySelector('.layer-help-btn');
    helpBtn?.addEventListener('click', () => this.showLayerHelp());

    // Collapse toggle
    const collapseBtn = toggles.querySelector('.toggle-collapse');
    const toggleList = toggles.querySelector('.toggle-list');

    // Manual scroll: intercept wheel, prevent map zoom, scroll the list ourselves
    if (toggleList) {
      toggles.addEventListener('wheel', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleList.scrollTop += e.deltaY;
      }, { passive: false });
      toggles.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
    }
    bindLayerSearch(toggles);
    const searchEl = toggles.querySelector('.layer-search') as HTMLElement | null;

    collapseBtn?.addEventListener('click', () => {
      toggleList?.classList.toggle('collapsed');
      if (searchEl) searchEl.style.display = toggleList?.classList.contains('collapsed') ? 'none' : '';
      if (collapseBtn) collapseBtn.innerHTML = toggleList?.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
    });
  }

  /** Show layer help popup explaining each layer */
  private showLayerHelp(): void {
    const existing = this.container.querySelector('.layer-help-popup');
    if (existing) {
      existing.remove();
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'layer-help-popup';

    const label = (layerKey: string): string => t(`components.deckgl.layers.${layerKey}`).toUpperCase();
    const staticLabel = (labelKey: string): string => t(`components.deckgl.layerHelp.labels.${labelKey}`).toUpperCase();
    const helpItem = (layerLabel: string, descriptionKey: string): string =>
      `<div class="layer-help-item"><span>${layerLabel}</span> ${t(`components.deckgl.layerHelp.descriptions.${descriptionKey}`)}</div>`;
    const helpSection = (titleKey: string, items: string[], noteKey?: string): string => `
      <div class="layer-help-section">
        <div class="layer-help-title">${t(`components.deckgl.layerHelp.sections.${titleKey}`)}</div>
        ${items.join('')}
        ${noteKey ? `<div class="layer-help-note">${t(`components.deckgl.layerHelp.notes.${noteKey}`)}</div>` : ''}
      </div>
    `;
    const helpHeader = `
      <div class="layer-help-header">
        <span>${t('components.deckgl.layerHelp.title')}</span>
        <button class="layer-help-close" aria-label="Close">×</button>
      </div>
    `;

    const techHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('techEcosystem', [
      helpItem(label('startupHubs'), 'techStartupHubs'),
      helpItem(label('cloudRegions'), 'techCloudRegions'),
      helpItem(label('techHQs'), 'techHQs'),
      helpItem(label('accelerators'), 'techAccelerators'),
      helpItem(label('techEvents'), 'techEvents'),
    ])}
        ${helpSection('infrastructure', [
      helpItem(label('underseaCables'), 'infraCables'),
      helpItem(label('aiDataCenters'), 'infraDatacenters'),
      helpItem(label('internetOutages'), 'infraOutages'),
      helpItem(label('cyberThreats'), 'techCyberThreats'),
    ])}
        ${helpSection('naturalEconomic', [
      helpItem(label('naturalEvents'), 'naturalEventsTech'),
      helpItem(label('fires'), 'techFires'),
      helpItem(staticLabel('countries'), 'countriesOverlay'),
      helpItem(label('dayNight'), 'dayNight'),
    ])}
      </div>
    `;

    const financeHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('financeCore', [
      helpItem(label('stockExchanges'), 'financeExchanges'),
      helpItem(label('financialCenters'), 'financeCenters'),
      helpItem(label('centralBanks'), 'financeCentralBanks'),
      helpItem(label('commodityHubs'), 'financeCommodityHubs'),
      helpItem(label('gulfInvestments'), 'financeGulfInvestments'),
    ])}
        ${helpSection('infrastructureRisk', [
      helpItem(label('underseaCables'), 'financeCables'),
      helpItem(label('pipelines'), 'financePipelines'),
      helpItem(label('internetOutages'), 'financeOutages'),
      helpItem(label('cyberThreats'), 'financeCyberThreats'),
      helpItem(label('tradeRoutes'), 'tradeRoutes'),
    ])}
        ${helpSection('macroContext', [
      helpItem(label('economicCenters'), 'economicCenters'),
      helpItem(label('strategicWaterways'), 'macroWaterways'),
      helpItem(label('weatherAlerts'), 'weatherAlertsMarket'),
      helpItem(label('naturalEvents'), 'naturalEventsMacro'),
      helpItem(label('dayNight'), 'dayNight'),
    ])}
      </div>
    `;

    const fullHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('timeFilter', [
      helpItem(staticLabel('timeRecent'), 'timeRecent'),
      helpItem(staticLabel('timeExtended'), 'timeExtended'),
    ], 'timeAffects')}
        ${helpSection('geopolitical', [
      helpItem(label('conflictZones'), 'geoConflicts'),

      helpItem(label('intelHotspots'), 'geoHotspots'),
      helpItem(staticLabel('sanctions'), 'geoSanctions'),
      helpItem(label('protests'), 'geoProtests'),
      helpItem(label('ucdpEvents'), 'geoUcdpEvents'),
      helpItem(label('displacementFlows'), 'geoDisplacement'),
    ])}
        ${helpSection('militaryStrategic', [
      helpItem(label('militaryBases'), 'militaryBases'),
      helpItem(label('nuclearSites'), 'militaryNuclear'),
      helpItem(label('gammaIrradiators'), 'militaryIrradiators'),
      helpItem(label('militaryActivity'), 'militaryActivity'),
      helpItem(label('spaceports'), 'militarySpaceports'),
    ])}
        ${helpSection('infrastructure', [
      helpItem(label('underseaCables'), 'infraCablesFull'),
      helpItem(label('pipelines'), 'infraPipelinesFull'),
      helpItem(label('internetOutages'), 'infraOutages'),
      helpItem(label('aiDataCenters'), 'infraDatacentersFull'),
      helpItem(label('cyberThreats'), 'infraCyberThreats'),
    ])}
        ${helpSection('transport', [
      helpItem(label('shipTraffic'), 'transportShipping'),
      helpItem(label('tradeRoutes'), 'tradeRoutes'),
      helpItem(label('flightDelays'), 'transportDelays'),
    ])}
        ${helpSection('naturalEconomic', [
      helpItem(label('naturalEvents'), 'naturalEventsFull'),
      helpItem(label('fires'), 'firesFull'),
      helpItem(label('weatherAlerts'), 'weatherAlerts'),
      helpItem(label('climateAnomalies'), 'climateAnomalies'),
      helpItem(label('economicCenters'), 'economicCenters'),
      helpItem(label('criticalMinerals'), 'mineralsFull'),
    ])}
        ${helpSection('overlays', [
      helpItem(label('dayNight'), 'dayNight'),
      helpItem(staticLabel('countries'), 'countriesOverlay'),
      helpItem(label('strategicWaterways'), 'waterwaysLabels'),
    ])}
      </div>
    `;

    popup.innerHTML = SITE_VARIANT === 'tech'
      ? techHelpContent
      : SITE_VARIANT === 'finance'
        ? financeHelpContent
        : fullHelpContent;

    popup.querySelector('.layer-help-close')?.addEventListener('click', () => popup.remove());

    // Prevent scroll events from propagating to map
    const content = popup.querySelector('.layer-help-content');
    if (content) {
      content.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
      content.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
    }

    // Close on click outside
    setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
          popup.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 100);

    this.container.appendChild(popup);
  }

  private createLegend(): void {
    const legend = document.createElement('div');
    legend.className = 'map-legend deckgl-legend';

    // SVG shapes for different marker types
    const shapes = {
      circle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${color}"/></svg>`,
      triangle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 11,10 1,10" fill="${color}"/></svg>`,
      square: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="${color}"/></svg>`,
      hexagon: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="${color}"/></svg>`,
    };

    const isLight = getCurrentTheme() === 'light';
    const resilienceLegendItems: { shape: string; label: string; layerKey: keyof MapLayers }[] = [
      { shape: shapes.square('rgb(239, 68, 68)'), label: 'Resilience: Very Low', layerKey: 'resilienceScore' },
      { shape: shapes.square('rgb(249, 115, 22)'), label: 'Resilience: Low', layerKey: 'resilienceScore' },
      { shape: shapes.square('rgb(234, 179, 8)'), label: 'Resilience: Moderate', layerKey: 'resilienceScore' },
      { shape: shapes.square('rgb(132, 204, 22)'), label: 'Resilience: High', layerKey: 'resilienceScore' },
      { shape: shapes.square('rgb(34, 197, 94)'), label: 'Resilience: Very High', layerKey: 'resilienceScore' },
    ];
    const legendItems: { shape: string; label: string; layerKey: keyof MapLayers }[] = SITE_VARIANT === 'tech'
      ? [
        { shape: shapes.circle(isLight ? 'rgb(22, 163, 74)' : 'rgb(0, 255, 150)'), label: t('components.deckgl.legend.startupHub'), layerKey: 'startupHubs' },
        { shape: shapes.circle('rgb(100, 200, 255)'), label: t('components.deckgl.legend.techHQ'), layerKey: 'techHQs' },
        { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 200, 0)'), label: t('components.deckgl.legend.accelerator'), layerKey: 'accelerators' },
        { shape: shapes.circle('rgb(150, 100, 255)'), label: t('components.deckgl.legend.cloudRegion'), layerKey: 'cloudRegions' },
        { shape: shapes.square('rgb(136, 68, 255)'), label: t('components.deckgl.legend.datacenter'), layerKey: 'datacenters' },
        { shape: shapes.circle('rgb(231, 76, 60)'), label: t('components.deckgl.legend.diseaseAlert'), layerKey: 'diseaseOutbreaks' },
        { shape: shapes.circle('rgb(230, 126, 34)'), label: t('components.deckgl.legend.diseaseWarning'), layerKey: 'diseaseOutbreaks' },
        { shape: shapes.circle('rgb(241, 196, 15)'), label: t('components.deckgl.legend.diseaseWatch'), layerKey: 'diseaseOutbreaks' },
        ...resilienceLegendItems,
      ]
      : SITE_VARIANT === 'finance'
        ? [
          { shape: shapes.circle('rgb(255, 215, 80)'), label: t('components.deckgl.legend.stockExchange'), layerKey: 'stockExchanges' },
          { shape: shapes.circle('rgb(0, 220, 150)'), label: t('components.deckgl.legend.financialCenter'), layerKey: 'financialCenters' },
          { shape: shapes.hexagon('rgb(255, 210, 80)'), label: t('components.deckgl.legend.centralBank'), layerKey: 'centralBanks' },
          { shape: shapes.square('rgb(255, 150, 80)'), label: t('components.deckgl.legend.commodityHub'), layerKey: 'commodityHubs' },
          { shape: shapes.triangle('rgb(80, 170, 255)'), label: t('components.deckgl.legend.waterway'), layerKey: 'waterways' },
          { shape: shapes.circle('rgb(231, 76, 60)'), label: t('components.deckgl.legend.diseaseAlert'), layerKey: 'diseaseOutbreaks' },
          { shape: shapes.circle('rgb(230, 126, 34)'), label: t('components.deckgl.legend.diseaseWarning'), layerKey: 'diseaseOutbreaks' },
          { shape: shapes.circle('rgb(241, 196, 15)'), label: t('components.deckgl.legend.diseaseWatch'), layerKey: 'diseaseOutbreaks' },
          ...resilienceLegendItems,
        ]
        : SITE_VARIANT === 'happy'
          ? [
            { shape: shapes.circle('rgb(34, 197, 94)'), label: 'Positive Event', layerKey: 'positiveEvents' },
            { shape: shapes.circle('rgb(234, 179, 8)'), label: 'Breakthrough', layerKey: 'positiveEvents' },
            { shape: shapes.circle('rgb(74, 222, 128)'), label: 'Act of Kindness', layerKey: 'kindness' },
            { shape: shapes.circle('rgb(255, 100, 50)'), label: 'Natural Event', layerKey: 'natural' },
            { shape: shapes.square('rgb(34, 180, 100)'), label: 'Happy Country', layerKey: 'happiness' },
            { shape: shapes.circle('rgb(74, 222, 128)'), label: 'Species Recovery Zone', layerKey: 'speciesRecovery' },
            { shape: shapes.circle('rgb(255, 200, 50)'), label: 'Renewable Installation', layerKey: 'renewableInstallations' },
            { shape: shapes.circle('rgb(160, 100, 255)'), label: t('components.deckgl.legend.aircraft'), layerKey: 'flights' },
            { shape: shapes.circle('rgb(231, 76, 60)'), label: t('components.deckgl.legend.diseaseAlert'), layerKey: 'diseaseOutbreaks' },
            { shape: shapes.circle('rgb(230, 126, 34)'), label: t('components.deckgl.legend.diseaseWarning'), layerKey: 'diseaseOutbreaks' },
            { shape: shapes.circle('rgb(241, 196, 15)'), label: t('components.deckgl.legend.diseaseWatch'), layerKey: 'diseaseOutbreaks' },
            ...resilienceLegendItems,
          ]
          : SITE_VARIANT === 'commodity'
            ? [
              { shape: shapes.hexagon(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 200, 0)'), label: t('components.deckgl.legend.commodityHub'), layerKey: 'commodityHubs' },
              { shape: shapes.circle('rgb(180, 80, 80)'), label: t('components.deckgl.legend.miningSite'), layerKey: 'miningSites' },
              { shape: shapes.square('rgb(80, 160, 220)'), label: t('components.deckgl.legend.commodityPort'), layerKey: 'commodityPorts' },
              { shape: shapes.circle('rgb(255, 150, 50)'), label: t('components.deckgl.legend.pipeline'), layerKey: 'pipelines' },
              { shape: shapes.triangle('rgb(80, 170, 255)'), label: t('components.deckgl.legend.waterway'), layerKey: 'waterways' },
              { shape: shapes.circle('rgb(200, 100, 255)'), label: t('components.deckgl.legend.processingPlant'), layerKey: 'processingPlants' },
              { shape: shapes.circle('rgb(231, 76, 60)'), label: t('components.deckgl.legend.diseaseAlert'), layerKey: 'diseaseOutbreaks' },
              { shape: shapes.circle('rgb(230, 126, 34)'), label: t('components.deckgl.legend.diseaseWarning'), layerKey: 'diseaseOutbreaks' },
              { shape: shapes.circle('rgb(241, 196, 15)'), label: t('components.deckgl.legend.diseaseWatch'), layerKey: 'diseaseOutbreaks' },
              ...resilienceLegendItems,
            ]
            : [
              { shape: shapes.circle('rgb(255, 68, 68)'), label: t('components.deckgl.legend.highAlert'), layerKey: 'hotspots' },
              { shape: shapes.circle('rgb(255, 165, 0)'), label: t('components.deckgl.legend.elevated'), layerKey: 'hotspots' },
              { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 255, 0)'), label: t('components.deckgl.legend.monitoring'), layerKey: 'hotspots' },
              { shape: shapes.circle('rgb(255, 100, 100)'), label: t('components.deckgl.legend.conflict'), layerKey: 'conflicts' },
              { shape: shapes.triangle('rgb(68, 136, 255)'), label: t('components.deckgl.legend.base'), layerKey: 'bases' },
              { shape: shapes.hexagon(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 220, 0)'), label: t('components.deckgl.legend.nuclear'), layerKey: 'nuclear' },
              { shape: shapes.square('rgb(136, 68, 255)'), label: t('components.deckgl.legend.datacenter'), layerKey: 'datacenters' },
              { shape: shapes.circle('rgb(160, 100, 255)'), label: t('components.deckgl.legend.aircraft'), layerKey: 'flights' },
              { shape: shapes.circle('rgb(231, 76, 60)'), label: t('components.deckgl.legend.diseaseAlert'), layerKey: 'diseaseOutbreaks' },
              { shape: shapes.circle('rgb(230, 126, 34)'), label: t('components.deckgl.legend.diseaseWarning'), layerKey: 'diseaseOutbreaks' },
              { shape: shapes.circle('rgb(241, 196, 15)'), label: t('components.deckgl.legend.diseaseWatch'), layerKey: 'diseaseOutbreaks' },
              ...resilienceLegendItems,
            ];

    legend.innerHTML = `
      <span class="legend-label-title">${t('components.deckgl.legend.title')}</span>
      ${legendItems.map(({ shape, label, layerKey }) => `<span class="legend-item" data-layer="${layerKey}">${shape}<span class="legend-label">${label}</span></span>`).join('')}
    `;

    // CII choropleth gradient legend (shown when layer is active)
    const ciiLegend = document.createElement('div');
    ciiLegend.className = 'cii-choropleth-legend';
    ciiLegend.id = 'ciiChoroplethLegend';
    ciiLegend.style.display = this.state.layers.ciiChoropleth ? 'block' : 'none';
    ciiLegend.innerHTML = `
      <span class="legend-label-title" style="font-size:9px;letter-spacing:0.5px;">CII SCALE</span>
      <div style="display:flex;align-items:center;gap:2px;margin-top:2px;">
        <div style="width:100%;height:8px;border-radius:3px;background:linear-gradient(to right,#28b33e,#dcc030,#e87425,#dc2626,#7f1d1d);"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:8px;opacity:0.7;margin-top:1px;">
        <span>0</span><span>31</span><span>51</span><span>66</span><span>81</span><span>100</span>
      </div>
    `;
    legend.appendChild(ciiLegend);

    this.container.appendChild(legend);
    this.updateLegend();
  }

  private updateLegend(): void {
    this.container.querySelectorAll<HTMLElement>('.legend-item[data-layer]').forEach(item => {
      const layerKey = item.dataset.layer;
      if (!layerKey || !(layerKey in this.state.layers)) return;
      item.style.display = this.state.layers[layerKey as keyof MapLayers] ? '' : 'none';
    });
    const ciiLegend = this.container.querySelector<HTMLElement>('#ciiChoroplethLegend');
    if (ciiLegend) {
      ciiLegend.style.display = this.state.layers.ciiChoropleth ? 'block' : 'none';
    }
  }

  // Public API methods (matching MapComponent interface)
  public render(): void {
    if (this.renderPaused) {
      this.renderPending = true;
      return;
    }
    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
    }
    this.renderRafId = requestAnimationFrame(() => {
      this.renderRafId = null;
      this.updateLayers();
    });
  }

  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;
    if (paused) {
      if (this.renderRafId !== null) {
        cancelAnimationFrame(this.renderRafId);
        this.renderRafId = null;
        this.renderPending = true;
      }
      this.stopPulseAnimation();
      this.stopDayNightTimer();
      return;
    }

    this.syncPulseAnimation();
    if (this.state.layers.dayNight) this.startDayNightTimer();
    if (!paused && this.renderPending) {
      this.renderPending = false;
      this.render();
    }
  }

  private updateLayers(): void {
    if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
    const startTime = performance.now();
    try {
      this.deckOverlay?.setProps({ layers: this.buildLayers() });
    } catch { /* map may be mid-teardown (null.getProjection) */ }
    this.maplibreMap.triggerRepaint();
    const elapsed = performance.now() - startTime;
    if (import.meta.env.DEV && elapsed > 16) {
      console.warn(`[DeckGLMap] updateLayers took ${elapsed.toFixed(2)}ms (>16ms budget)`);
    }
    this.updateZoomHints();
  }

  private updateZoomHints(): void {
    const toggleList = this.container.querySelector('.deckgl-layer-toggles .toggle-list');
    if (!toggleList) return;
    for (const [key, enabled] of Object.entries(this.state.layers)) {
      const toggle = toggleList.querySelector(`.layer-toggle[data-layer="${key}"]`) as HTMLElement | null;
      if (!toggle) continue;
      const zoomHidden = !!enabled && !this.isLayerVisible(key as keyof MapLayers);
      toggle.classList.toggle('zoom-hidden', zoomHidden);
    }
  }

  public setView(view: DeckMapView, zoom?: number): void {
    const preset = VIEW_PRESETS[view];
    if (!preset) return;
    this.state.view = view;
    // Eagerly write target zoom+center so getState()/getCenter() return the
    // correct destination before moveend fires. Without this a 250ms URL sync
    // reads the old cached zoom or an intermediate animated center and
    // overwrites URL params (e.g. ?view=mena&zoom=4 → wrong coords).
    this.state.zoom = zoom ?? preset.zoom;
    this.pendingCenter = { lat: preset.latitude, lon: preset.longitude };

    if (this.maplibreMap) {
      this.maplibreMap.flyTo({
        center: [preset.longitude, preset.latitude],
        zoom: this.state.zoom,
        duration: 1000,
      });
    }

    const viewSelect = this.container.querySelector('.view-select') as HTMLSelectElement;
    if (viewSelect) viewSelect.value = view;

    this.onStateChange?.(this.getState());
  }

  public setZoom(zoom: number): void {
    this.state.zoom = zoom;
    if (this.maplibreMap) {
      this.maplibreMap.setZoom(zoom);
    }
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (this.maplibreMap) {
      this.maplibreMap.flyTo({
        center: [lon, lat],
        ...(zoom != null && { zoom }),
        duration: 500,
      });
    }
  }

  public fitCountry(code: string): void {
    const bbox = getCountryBbox(code);
    if (!bbox || !this.maplibreMap) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    this.maplibreMap.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 40,
      duration: 800,
      maxZoom: 8,
    });
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (this.pendingCenter) return this.pendingCenter;
    if (this.maplibreMap) {
      const center = this.maplibreMap.getCenter();
      return { lat: center.lat, lon: center.lng };
    }
    return null;
  }

  public getBbox(): string | null {
    if (!this.maplibreMap) return null;
    const b = this.maplibreMap.getBounds();
    return `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
  }

  public setTimeRange(range: TimeRange): void {
    this.state.timeRange = range;
    this.rebuildProtestSupercluster();
    this.onTimeRangeChange?.(range);
    this.updateTimeSliderButtons();
    this.render(); // Debounced
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setLayers(layers: MapLayers): void {
    const prevRadar = this.state.layers.weather;
    const prevCyber = this.state.layers.cyberThreats;
    this.state.layers = normalizeExclusiveChoropleths(layers, this.state.layers);
    if (!this.state.layers.military) this.clearFlightTrails();
    this.manageAircraftTimer(this.state.layers.flights);
    if (this.state.layers.weather && !prevRadar) this.startWeatherRadar();
    else if (!this.state.layers.weather && prevRadar) this.stopWeatherRadar();
    if (this.state.layers.cyberThreats && !prevCyber && !this.aptGroupsLoaded) this.loadAptGroups();
    this.render(); // Debounced
    this.updateLegend();

    Object.entries(this.state.layers).forEach(([key, value]) => {
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${key}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = value;
    });
  }

  public getState(): DeckMapState {
    return {
      ...this.state,
      pan: { ...this.state.pan },
      layers: { ...this.state.layers },
    };
  }

  // Zoom controls - public for external access
  public zoomIn(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomIn();
    }
  }

  public zoomOut(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomOut();
    }
  }

  private resetView(): void {
    this.setView('global');
  }

  private createUcdpEventsLayer(events: UcdpGeoEvent[]): ScatterplotLayer<UcdpGeoEvent> {
    return new ScatterplotLayer<UcdpGeoEvent>({
      id: 'ucdp-events-layer',
      data: events,
      getPosition: (d) => [d.longitude, d.latitude],
      getRadius: (d) => Math.max(4000, Math.sqrt(d.deaths_best || 1) * 3000),
      getFillColor: (d) => {
        switch (d.type_of_violence) {
          case 'state-based': return COLORS.ucdpStateBased;
          case 'non-state': return COLORS.ucdpNonState;
          case 'one-sided': return COLORS.ucdpOneSided;
          default: return COLORS.ucdpStateBased;
        }
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 20,
      pickable: false,
    });
  }

  private createDisplacementArcsLayer(): ArcLayer<DisplacementFlow> {
    const withCoords = this.displacementFlows.filter(f => f.originLat != null && f.asylumLat != null);
    const top50 = withCoords.slice(0, 50);
    const maxCount = Math.max(1, ...top50.map(f => f.refugees));
    return new ArcLayer<DisplacementFlow>({
      id: 'displacement-arcs-layer',
      data: top50,
      getSourcePosition: (d) => [d.originLon!, d.originLat!],
      getTargetPosition: (d) => [d.asylumLon!, d.asylumLat!],
      getSourceColor: getCurrentTheme() === 'light' ? [50, 80, 180, 220] : [100, 150, 255, 180],
      getTargetColor: getCurrentTheme() === 'light' ? [20, 150, 100, 220] : [100, 255, 200, 180],
      getWidth: (d) => Math.max(1, (d.refugees / maxCount) * 8),
      widthMinPixels: 1,
      widthMaxPixels: 8,
      pickable: false,
    });
  }

  private createClimateHeatmapLayer(): HeatmapLayer<ClimateAnomaly> {
    return new HeatmapLayer<ClimateAnomaly>({
      id: 'climate-heatmap-layer',
      data: this.climateAnomalies,
      getPosition: (d) => [d.lon, d.lat],
      getWeight: (d) => Math.abs(d.tempDelta) + Math.abs(d.precipDelta) * 0.1,
      radiusPixels: 40,
      intensity: 0.6,
      threshold: 0.15,
      opacity: 0.45,
      colorRange: [
        [68, 136, 255],
        [100, 200, 255],
        [255, 255, 100],
        [255, 200, 50],
        [255, 100, 50],
        [255, 50, 50],
      ],
      pickable: false,
    });
  }

  private createTradeRoutesLayer(): ArcLayer<TradeRouteSegment> {
    const active: [number, number, number, number] = getCurrentTheme() === 'light' ? [30, 100, 180, 200] : [100, 200, 255, 160];
    const disrupted: [number, number, number, number] = getCurrentTheme() === 'light' ? [200, 40, 40, 220] : [255, 80, 80, 200];
    const highRisk: [number, number, number, number] = getCurrentTheme() === 'light' ? [200, 140, 20, 200] : [255, 180, 50, 180];
    const scenario: [number, number, number, number] = getCurrentTheme() === 'light' ? [220, 100, 20, 230] : [255, 140, 50, 210];
    const colorFor = (status: string): [number, number, number, number] =>
      status === 'disrupted' ? disrupted : status === 'high_risk' ? highRisk : active;

    // When a scenario is active, override colors for routes that transit disrupted chokepoints.
    // ROUTE_WAYPOINTS_MAP is module-level so getColor() is O(1) per segment instead of O(n) per frame.
    const scenarioDisrupted = this.scenarioState
      ? new Set(this.scenarioState.disruptedChokepointIds)
      : null;

    const getColor = (d: TradeRouteSegment): [number, number, number, number] => {
      if (scenarioDisrupted && scenarioDisrupted.size > 0) {
        const waypoints = ROUTE_WAYPOINTS_MAP.get(d.routeId);
        if (waypoints && waypoints.some(wp => scenarioDisrupted.has(wp))) {
          return scenario;
        }
      }
      if (!hasPremiumAccess(getAuthState())) return active;  // free users: always blue
      return colorFor(d.status);
    };

    return new ArcLayer<TradeRouteSegment>({
      id: 'trade-routes-layer',
      data: this.tradeRouteSegments,
      getSourcePosition: (d) => d.sourcePosition,
      getTargetPosition: (d) => d.targetPosition,
      getSourceColor: getColor,
      getTargetColor: getColor,
      getWidth: (d) => d.category === 'energy' ? 3 : 2,
      widthMinPixels: 1,
      widthMaxPixels: 6,
      greatCircle: true,
      pickable: true,
    });
  }

  private createTradeChokepointsLayer(): ScatterplotLayer {
    const routeWaypointIds = new Set<string>();
    for (const seg of this.tradeRouteSegments) {
      const waypoints = ROUTE_WAYPOINTS_MAP.get(seg.routeId);
      if (waypoints) for (const wp of waypoints) routeWaypointIds.add(wp);
    }
    const chokepoints = STRATEGIC_WATERWAYS.filter(w => routeWaypointIds.has(w.id));
    const isLight = getCurrentTheme() === 'light';

    return new ScatterplotLayer({
      id: 'trade-chokepoints-layer',
      data: chokepoints,
      getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
      getFillColor: isLight ? [200, 140, 20, 200] : [255, 180, 50, 180],
      getLineColor: isLight ? [100, 70, 10, 255] : [255, 220, 120, 255],
      getRadius: 30000,
      stroked: true,
      lineWidthMinPixels: 1,
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: false,
    });
  }

  /**
   * Compute the solar terminator polygon (night side of the Earth).
   * Uses standard astronomical formulas to find the subsolar point,
   * then traces the terminator line and closes around the dark pole.
   */
  private computeNightPolygon(): [number, number][] {
    const now = new Date();
    const JD = now.getTime() / 86400000 + 2440587.5;
    const D = JD - 2451545.0; // Days since J2000.0

    // Solar mean anomaly (radians)
    const g = ((357.529 + 0.98560028 * D) % 360) * Math.PI / 180;

    // Solar ecliptic longitude (degrees)
    const q = (280.459 + 0.98564736 * D) % 360;
    const L = q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    const LRad = L * Math.PI / 180;

    // Obliquity of ecliptic (radians)
    const eRad = (23.439 - 0.00000036 * D) * Math.PI / 180;

    // Solar declination (radians)
    const decl = Math.asin(Math.sin(eRad) * Math.sin(LRad));

    // Solar right ascension (radians)
    const RA = Math.atan2(Math.cos(eRad) * Math.sin(LRad), Math.cos(LRad));

    // Greenwich Mean Sidereal Time (degrees)
    const GMST = ((18.697374558 + 24.06570982441908 * D) % 24) * 15;

    // Sub-solar longitude (degrees, normalized to [-180, 180])
    let sunLng = RA * 180 / Math.PI - GMST;
    sunLng = ((sunLng % 360) + 540) % 360 - 180;

    // Trace terminator line (1° steps for smooth curve at high zoom)
    const tanDecl = Math.tan(decl);
    const points: [number, number][] = [];

    // Near equinox (|tanDecl| ≈ 0), the terminator is nearly a great circle
    // through the poles — use a vertical line at the subsolar meridian ±90°
    if (Math.abs(tanDecl) < 1e-6) {
      for (let lat = -90; lat <= 90; lat += 1) {
        points.push([sunLng + 90, lat]);
      }
      for (let lat = 90; lat >= -90; lat -= 1) {
        points.push([sunLng - 90, lat]);
      }
      return points;
    }

    for (let lng = -180; lng <= 180; lng += 1) {
      const ha = (lng - sunLng) * Math.PI / 180;
      const lat = Math.atan(-Math.cos(ha) / tanDecl) * 180 / Math.PI;
      points.push([lng, lat]);
    }

    // Close polygon around the dark pole
    const darkPoleLat = decl > 0 ? -90 : 90;
    points.push([180, darkPoleLat]);
    points.push([-180, darkPoleLat]);

    return points;
  }

  private createDayNightLayer(): PolygonLayer {
    const nightPolygon = this.cachedNightPolygon ?? (this.cachedNightPolygon = this.computeNightPolygon());
    const isLight = getCurrentTheme() === 'light';

    return new PolygonLayer({
      id: 'day-night-layer',
      data: [{ polygon: nightPolygon }],
      getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
      getFillColor: isLight ? [0, 0, 40, 35] : [0, 0, 20, 55],
      filled: true,
      stroked: true,
      getLineColor: isLight ? [100, 100, 100, 40] : [200, 200, 255, 25],
      getLineWidth: 1,
      lineWidthUnits: 'pixels' as const,
      pickable: false,
    });
  }

  // Data setters - all use render() for debouncing
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.render();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.render();
  }

  public setImageryScenes(scenes: ImageryScene[]): void {
    this.imageryScenes = scenes;
    this.render();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.render();
  }

  public setTrafficAnomalies(anomalies: ProtoTrafficAnomaly[]): void {
    this.trafficAnomalies = anomalies;
    this.render();
  }

  public setDdosLocations(hits: DdosLocationHit[]): void {
    this.ddosLocations = hits;
    this.render();
  }

  public setCyberThreats(threats: CyberThreat[]): void {
    this.cyberThreats = threats;
    this.render();
  }

  public setIranEvents(events: IranEvent[]): void {
    this.iranEvents = events;
    this.render();
  }

  public setAisData(disruptions: AisDisruptionEvent[], density: AisDensityZone[]): void {
    this.aisDisruptions = disruptions;
    this.aisDensity = density;
    this.render();
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisories = advisories;
    this.repairShips = repairShips;
    this.render();
  }

  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    this.healthByCableId = healthMap;
    this.layerCache.delete('cables-layer');
    this.render();
  }

  public setProtests(events: SocialUnrestEvent[]): void {
    this.protests = events;
    this.rebuildProtestSupercluster();
    this.render();
    this.syncPulseAnimation();
  }

  public setFlightDelays(delays: AirportDelayAlert[]): void {
    this.flightDelays = delays;
    this.render();
  }

  public setAircraftPositions(positions: PositionSample[]): void {
    this.aircraftPositions = positions;
    this.render();
  }

  public setMilitaryFlights(flights: MilitaryFlight[], clusters: MilitaryFlightCluster[] = []): void {
    this.militaryFlights = flights;
    this.militaryFlightClusters = clusters;
    // Prune trails for aircraft no longer in the dataset
    if (this.activeFlightTrails.size > 0) {
      const currentHexes = new Set(flights.map(f => f.hexCode.toLowerCase()));
      for (const hex of this.activeFlightTrails) {
        if (!currentHexes.has(hex)) this.activeFlightTrails.delete(hex);
      }
      this.updateClearTrailsBtn();
    }
    this.render();
  }

  public toggleFlightTrail(hexCode: string): void {
    const key = hexCode.toLowerCase();
    if (this.activeFlightTrails.has(key)) {
      this.activeFlightTrails.delete(key);
    } else {
      this.activeFlightTrails.add(key);
    }
    this.updateClearTrailsBtn();
    this.render();
  }

  public clearFlightTrails(): void {
    if (this.activeFlightTrails.size === 0) return;
    this.activeFlightTrails.clear();
    this.updateClearTrailsBtn();
    this.render();
  }

  private updateClearTrailsBtn(): void {
    if (!this.clearTrailsBtn) return;
    this.clearTrailsBtn.style.display = this.activeFlightTrails.size > 0 ? '' : 'none';
  }

  public setMilitaryVessels(vessels: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    this.militaryVessels = vessels;
    this.militaryVesselClusters = clusters;
    this.render();
  }

  private fetchServerBases(): void {
    if (!this.maplibreMap) return;
    const mapLayers = this.state.layers;
    if (!mapLayers.bases) return;
    const zoom = this.maplibreMap.getZoom();
    if (zoom < 3) return;
    const bounds = this.maplibreMap.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    fetchMilitaryBases(sw.lat, sw.lng, ne.lat, ne.lng, zoom).then((result) => {
      if (!result) return;
      this.serverBases = result.bases;
      this.serverBaseClusters = result.clusters;
      this.serverBasesLoaded = true;
      this.render();
    }).catch((err) => {
      console.error('[bases] fetch error', err);
    });
  }

  private manageAircraftTimer(enabled: boolean): void {
    if (enabled) {
      if (!this.aircraftFetchTimer) {
        this.aircraftFetchTimer = setInterval(() => {
          this.lastAircraftFetchCenter = null; // force refresh on poll
          this.fetchViewportAircraft();
        }, 120_000); // Match server cache TTL (120s anonymous OpenSky tier)
        this.debouncedFetchAircraft();
      }
    } else {
      if (this.aircraftFetchTimer) {
        clearInterval(this.aircraftFetchTimer);
        this.aircraftFetchTimer = null;
      }
      this.aircraftPositions = [];
    }
  }

  private hasAircraftViewportChanged(): boolean {
    if (!this.maplibreMap) return false;
    if (!this.lastAircraftFetchCenter) return true;
    const center = this.maplibreMap.getCenter();
    const zoom = this.maplibreMap.getZoom();
    if (Math.abs(zoom - this.lastAircraftFetchZoom) >= 1) return true;
    const [prevLng, prevLat] = this.lastAircraftFetchCenter;
    // Threshold scales with zoom — higher zoom = smaller movement triggers fetch
    const threshold = Math.max(0.1, 2 / 2 ** Math.max(0, zoom - 3));
    return Math.abs(center.lat - prevLat) > threshold || Math.abs(center.lng - prevLng) > threshold;
  }

  private fetchViewportAircraft(): void {
    if (!this.maplibreMap) return;
    if (!this.state.layers.flights) return;
    const zoom = this.maplibreMap.getZoom();
    if (zoom < 2) {
      if (this.aircraftPositions.length > 0) {
        this.aircraftPositions = [];
        this.render();
      }
      return;
    }
    if (!this.hasAircraftViewportChanged()) return;
    const bounds = this.maplibreMap.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const seq = ++this.aircraftFetchSeq;
    this.setLayerLoading('flights', true);
    fetchAircraftPositions({
      swLat: sw.lat, swLon: sw.lng,
      neLat: ne.lat, neLon: ne.lng,
    }).then((positions) => {
      if (seq !== this.aircraftFetchSeq) return; // discard stale response
      this.aircraftPositions = positions;
      this.onAircraftPositionsUpdate?.(positions);
      const center = this.maplibreMap?.getCenter();
      if (center) {
        this.lastAircraftFetchCenter = [center.lng, center.lat];
        this.lastAircraftFetchZoom = this.maplibreMap!.getZoom();
      }
      this.setLayerReady('flights', positions.length > 0);
      this.render();
    }).catch((err) => {
      console.error('[aircraft] fetch error', err);
      this.setLayerLoading('flights', false);
    });
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalEvents = events;
    this.render();
  }

  public setFires(fires: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }>): void {
    this.firmsFireData = fires;
    this.render();
  }

  public setTechEvents(events: TechEventMarker[]): void {
    this.techEvents = events;
    this.rebuildTechEventSupercluster();
    this.render();
  }

  public setUcdpEvents(events: UcdpGeoEvent[]): void {
    this.ucdpEvents = events;
    this.render();
  }

  public setDisplacementFlows(flows: DisplacementFlow[]): void {
    this.displacementFlows = flows;
    this.render();
  }

  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.climateAnomalies = anomalies;
    this.render();
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.radiationObservations = observations;
    this.render();
  }

  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.webcamData = markers;
    this.render();
  }

  public setGpsJamming(hexes: GpsJamHex[]): void {
    this.gpsJammingHexes = hexes;
    this.render();
  }

  public setDiseaseOutbreaks(outbreaks: DiseaseOutbreakItem[]): void {
    this.diseaseOutbreaks = outbreaks;
    this.render();
  }

  public setNewsLocations(data: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }>): void {
    const now = Date.now();
    for (const d of data) {
      if (!this.newsLocationFirstSeen.has(d.title)) {
        this.newsLocationFirstSeen.set(d.title, now);
      }
    }
    for (const [key, ts] of this.newsLocationFirstSeen) {
      if (now - ts > 60_000) this.newsLocationFirstSeen.delete(key);
    }
    this.newsLocations = data;
    this.render();

    this.syncPulseAnimation(now);
  }

  public setPositiveEvents(events: PositiveGeoEvent[]): void {
    this.positiveEvents = events;
    this.syncPulseAnimation();
    this.render();
  }

  public setKindnessData(points: KindnessPoint[]): void {
    this.kindnessPoints = points;
    this.syncPulseAnimation();
    this.render();
  }

  public setChokepointData(data: GetChokepointStatusResponse | null): void {
    this.popup.setChokepointData(data);
    this.storedChokepointData = data;
    if (this.storedChokepointData) this.refreshTradeRouteStatus(this.storedChokepointData);
  }

  private refreshTradeRouteStatus(data: GetChokepointStatusResponse): void {
    const scoreMap = new Map(data.chokepoints.map(cp => [cp.id, cp.disruptionScore ?? 0]));
    const initialSegments = resolveTradeRouteSegments();
    this.tradeRouteSegments = initialSegments.map(seg => {
      const waypoints = ROUTE_WAYPOINTS_MAP.get(seg.routeId) ?? [];
      const maxScore = waypoints.reduce((max, id) => Math.max(max, scoreMap.get(id) ?? 0), 0);
      const status: TradeRouteStatus = maxScore >= 70 ? 'disrupted' : maxScore > 30 ? 'high_risk' : 'active';
      return { ...seg, status };
    });
    this.render();
  }

  /**
   * Activate or deactivate a scenario visual overlay.
   * When active, trade route arcs transiting disrupted chokepoints shift to
   * an orange scenario color. Pass null to restore normal colors.
   */
  public setScenarioState(state: ScenarioVisualState | null): void {
    this.scenarioState = state;
    this.affectedIso2Set = new Set(state?.affectedIso2s ?? []);
    this.render();
  }

  public setHappinessScores(data: HappinessData): void {
    this.happinessScores = data.scores;
    this.happinessYear = data.year;
    this.happinessSource = data.source;
    this.render();
  }

  public setCIIScores(scores: Array<{ code: string; score: number; level: string }>): void {
    this.ciiScoresMap = new Map(scores.map(s => [s.code, { score: s.score, level: s.level }]));
    this.ciiScoresVersion++;
    this.render();
  }

  public setResilienceRanking(items: ResilienceRankingItem[], greyedOut: ResilienceRankingItem[] = []): void {
    this.resilienceScoresMap = buildResilienceChoroplethMap(items, greyedOut);
    this.resilienceScoresVersion++;
    this.render();
  }

  public setSpeciesRecoveryZones(species: SpeciesRecovery[]): void {
    this.speciesRecoveryZones = species.filter(
      (s): s is SpeciesRecovery & { recoveryZone: { name: string; lat: number; lon: number } } =>
        s.recoveryZone != null
    );
    this.render();
  }

  public setRenewableInstallations(installations: RenewableInstallation[]): void {
    this.renewableInstallations = installations;
    this.render();
  }

  public updateHotspotActivity(news: NewsItem[]): void {
    this.news = news; // Store for related news lookup

    // Update hotspot "breaking" indicators based on recent news
    const breakingKeywords = new Set<string>();
    const recentNews = news.filter(n =>
      Date.now() - n.pubDate.getTime() < 2 * 60 * 60 * 1000 // Last 2 hours
    );

    // Count matches per hotspot for escalation tracking
    const matchCounts = new Map<string, number>();

    recentNews.forEach(item => {
      const tokens = tokenizeForMatch(item.title);
      this.hotspots.forEach(hotspot => {
        if (matchesAnyKeyword(tokens, hotspot.keywords)) {
          breakingKeywords.add(hotspot.id);
          matchCounts.set(hotspot.id, (matchCounts.get(hotspot.id) || 0) + 1);
        }
      });
    });

    this.hotspots.forEach(h => {
      h.hasBreaking = breakingKeywords.has(h.id);
      const matchCount = matchCounts.get(h.id) || 0;
      // Calculate a simple velocity metric (matches per hour normalized)
      const velocity = matchCount > 0 ? matchCount / 2 : 0; // 2 hour window
      updateHotspotEscalation(h.id, matchCount, h.hasBreaking || false, velocity);
    });

    this.render();
    this.syncPulseAnimation();
  }

  /** Get news items related to a hotspot by keyword matching */
  private getRelatedNews(hotspot: Hotspot): NewsItem[] {
    const conflictTopics = ['gaza', 'ukraine', 'ukrainian', 'russia', 'russian', 'israel', 'israeli', 'iran', 'iranian', 'china', 'chinese', 'taiwan', 'taiwanese', 'korea', 'korean', 'syria', 'syrian'];

    return this.news
      .map((item) => {
        const tokens = tokenizeForMatch(item.title);
        const matchedKeywords = findMatchingKeywords(tokens, hotspot.keywords);

        if (matchedKeywords.length === 0) return null;

        const conflictMatches = conflictTopics.filter(t =>
          matchKeyword(tokens, t) && !hotspot.keywords.some(k => k.toLowerCase().includes(t))
        );

        if (conflictMatches.length > 0) {
          const strongLocalMatch = matchedKeywords.some(kw =>
            kw.toLowerCase() === hotspot.name.toLowerCase() ||
            hotspot.agencies?.some(a => matchKeyword(tokens, a))
          );
          if (!strongLocalMatch) return null;
        }

        const score = matchedKeywords.length;
        return { item, score };
      })
      .filter((x): x is { item: NewsItem; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(x => x.item);
  }

  public updateMilitaryForEscalation(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
    setMilitaryData(flights, vessels);
  }

  public getHotspotDynamicScore(hotspotId: string) {
    return getHotspotEscalation(hotspotId);
  }

  /** Get military flight clusters for rendering/analysis */
  public getMilitaryFlightClusters(): MilitaryFlightCluster[] {
    return this.militaryFlightClusters;
  }

  /** Get military vessel clusters for rendering/analysis */
  public getMilitaryVesselClusters(): MilitaryVesselCluster[] {
    return this.militaryVesselClusters;
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    // Clear previous highlights
    Object.values(this.highlightedAssets).forEach(set => set.clear());

    if (assets) {
      assets.forEach(asset => {
        if (asset?.type && this.highlightedAssets[asset.type]) {
          this.highlightedAssets[asset.type].add(asset.id);
        }
      });
    }

    this.render(); // Debounced
  }

  public setOnHotspotClick(callback: (hotspot: Hotspot) => void): void {
    this.onHotspotClick = callback;
  }

  public setOnTradeArcClick(cb: (segment: TradeRouteSegment, waypoints: string[], x: number, y: number) => void): void {
    this.onTradeArcClick = cb;
  }

  public setOnTimeRangeChange(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChange = callback;
  }

  public setOnStateChange(callback: (state: DeckMapState) => void): void {
    this.onStateChange = callback;
  }

  public setOnAircraftPositionsUpdate(callback: (positions: PositionSample[]) => void): void {
    this.onAircraftPositionsUpdate = callback;
  }

  public getHotspotLevels(): Record<string, string> {
    const levels: Record<string, string> = {};
    this.hotspots.forEach(h => {
      levels[h.name] = h.level || 'low';
    });
    return levels;
  }

  public setHotspotLevels(levels: Record<string, string>): void {
    this.hotspots.forEach(h => {
      if (levels[h.name]) {
        h.level = levels[h.name] as 'low' | 'elevated' | 'high';
      }
    });
    this.render(); // Debounced
  }

  public initEscalationGetters(): void {
    setCIIGetter(getCountryScore);
    setGeoAlertGetter(getAlertsNearLocation);
  }

  private layerWarningShown = false;
  private lastActiveLayerCount = 0;

  private enforceLayerLimit(): void {
    const WARN_THRESHOLD = 13;
    const togglesEl = this.container.querySelector('.deckgl-layer-toggles');
    if (!togglesEl) return;
    const activeCount = Array.from(togglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input'))
      .filter(i => (i.closest('.layer-toggle') as HTMLElement)?.style.display !== 'none')
      .filter(i => i.checked).length;
    const increasing = activeCount > this.lastActiveLayerCount;
    this.lastActiveLayerCount = activeCount;
    if (activeCount >= WARN_THRESHOLD && increasing && !this.layerWarningShown) {
      this.layerWarningShown = true;
      showLayerWarning(WARN_THRESHOLD);
    } else if (activeCount < WARN_THRESHOLD) {
      this.layerWarningShown = false;
    }
  }

  // UI visibility methods
  public hideLayerToggle(layer: keyof MapLayers): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) {
      (toggle as HTMLElement).style.display = 'none';
      toggle.setAttribute('data-layer-hidden', '');
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) toggle.classList.toggle('loading', loading);
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (!toggle) return;

    toggle.classList.remove('loading');
    // Match old Map.ts behavior: set 'active' only when layer enabled AND has data
    if (this.state.layers[layer] && hasData) {
      toggle.classList.add('active');
    } else {
      toggle.classList.remove('active');
    }
  }

  public flashAssets(assetType: AssetType, ids: string[]): void {
    if (!this.highlightedAssets[assetType]) return;
    ids.forEach(id => this.highlightedAssets[assetType].add(id));
    this.render();

    setTimeout(() => {
      ids.forEach(id => this.highlightedAssets[assetType]?.delete(id));
      this.render();
    }, 3000);
  }

  // Enable layer programmatically
  public enableLayer(layer: keyof MapLayers): void {
    if (!this.state.layers[layer]) {
      if (layer === 'resilienceScore' && this.state.layers.ciiChoropleth) {
        this.state.layers.ciiChoropleth = false;
        const ciiToggle = this.container.querySelector(`.layer-toggle[data-layer="ciiChoropleth"] input`) as HTMLInputElement | null;
        if (ciiToggle) ciiToggle.checked = false;
        this.setLayerReady('ciiChoropleth', false);
        this.onLayerChange?.('ciiChoropleth', false, 'programmatic');
      } else if (layer === 'ciiChoropleth' && this.state.layers.resilienceScore) {
        this.state.layers.resilienceScore = false;
        const resilienceToggle = this.container.querySelector(`.layer-toggle[data-layer="resilienceScore"] input`) as HTMLInputElement | null;
        if (resilienceToggle) resilienceToggle.checked = false;
        this.setLayerReady('resilienceScore', false);
        this.onLayerChange?.('resilienceScore', false, 'programmatic');
      }
      this.state.layers[layer] = true;
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = true;
      if (layer === 'weather') this.startWeatherRadar();
      if (layer === 'cyberThreats' && !this.aptGroupsLoaded) this.loadAptGroups();
      if (layer === 'flights') this.manageAircraftTimer(true);
      this.render();
      this.updateLegend();
      this.onLayerChange?.(layer, true, 'programmatic');
      this.enforceLayerLimit();
    }
  }

  // Toggle layer on/off programmatically
  public toggleLayer(layer: keyof MapLayers): void {
    const prevRadar = this.state.layers.weather;
    const prevCyber = this.state.layers.cyberThreats;
    const nextEnabled = !this.state.layers[layer];
    if (nextEnabled && layer === 'resilienceScore' && this.state.layers.ciiChoropleth) {
      this.state.layers.ciiChoropleth = false;
      const ciiToggle = this.container.querySelector(`.layer-toggle[data-layer="ciiChoropleth"] input`) as HTMLInputElement | null;
      if (ciiToggle) ciiToggle.checked = false;
      this.setLayerReady('ciiChoropleth', false);
      this.onLayerChange?.('ciiChoropleth', false, 'programmatic');
    } else if (nextEnabled && layer === 'ciiChoropleth' && this.state.layers.resilienceScore) {
      this.state.layers.resilienceScore = false;
      const resilienceToggle = this.container.querySelector(`.layer-toggle[data-layer="resilienceScore"] input`) as HTMLInputElement | null;
      if (resilienceToggle) resilienceToggle.checked = false;
      this.setLayerReady('resilienceScore', false);
      this.onLayerChange?.('resilienceScore', false, 'programmatic');
    }
    this.state.layers[layer] = !this.state.layers[layer];
    if (layer === 'military' && !this.state.layers[layer]) this.clearFlightTrails();
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
    if (toggle) toggle.checked = this.state.layers[layer];
    if (this.state.layers.weather && !prevRadar) this.startWeatherRadar();
    else if (!this.state.layers.weather && prevRadar) this.stopWeatherRadar();
    if (this.state.layers.cyberThreats && !prevCyber && !this.aptGroupsLoaded) this.loadAptGroups();
    if (layer === 'flights') this.manageAircraftTimer(this.state.layers.flights);
    this.render();
    this.updateLegend();
    this.onLayerChange?.(layer, this.state.layers[layer], 'programmatic');
    this.enforceLayerLimit();
  }

  // Update legend visibility based on which layers are currently active
  // Get center coordinates for programmatic popup positioning
  private getContainerCenter(): { x: number; y: number } {
    const rect = this.container.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }

  // Project lat/lon to screen coordinates without moving the map
  private projectToScreen(lat: number, lon: number): { x: number; y: number } | null {
    if (!this.maplibreMap) return null;
    const point = this.maplibreMap.project([lon, lat]);
    return { x: point.x, y: point.y };
  }

  // Trigger click methods - show popup at item location without moving the map
  public triggerHotspotClick(id: string): void {
    const hotspot = this.hotspots.find(h => h.id === id);
    if (!hotspot) return;

    // Get screen position for popup
    const screenPos = this.projectToScreen(hotspot.lat, hotspot.lon);
    const { x, y } = screenPos || this.getContainerCenter();

    // Get related news and show popup
    const relatedNews = this.getRelatedNews(hotspot);
    this.popup.show({
      type: 'hotspot',
      data: hotspot,
      relatedNews,
      x,
      y,
    });
    this.popup.loadHotspotGdeltContext(hotspot);
    this.onHotspotClick?.(hotspot);
  }

  public triggerConflictClick(id: string): void {
    const conflict = CONFLICT_ZONES.find(c => c.id === id);
    if (conflict) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(conflict.center[1], conflict.center[0]);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'conflict', data: conflict, x, y });
    }
  }

  public triggerBaseClick(id: string): void {
    const base = this.serverBases.find(b => b.id === id) || MILITARY_BASES.find(b => b.id === id);
    if (base) {
      const screenPos = this.projectToScreen(base.lat, base.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'base', data: base, x, y });
    }
  }

  public triggerPipelineClick(id: string): void {
    const pipeline = PIPELINES.find(p => p.id === id);
    if (pipeline && pipeline.points.length > 0) {
      const midIdx = Math.floor(pipeline.points.length / 2);
      const midPoint = pipeline.points[midIdx];
      // Don't pan - show popup at projected screen position or center
      const screenPos = midPoint ? this.projectToScreen(midPoint[1], midPoint[0]) : null;
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'pipeline', data: pipeline, x, y });
    }
  }

  public triggerCableClick(id: string): void {
    const cable = UNDERSEA_CABLES.find(c => c.id === id);
    if (cable && cable.points.length > 0) {
      const midIdx = Math.floor(cable.points.length / 2);
      const midPoint = cable.points[midIdx];
      // Don't pan - show popup at projected screen position or center
      const screenPos = midPoint ? this.projectToScreen(midPoint[1], midPoint[0]) : null;
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'cable', data: cable, x, y });
    }
  }

  public triggerDatacenterClick(id: string): void {
    const dc = AI_DATA_CENTERS.find(d => d.id === id);
    if (dc) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(dc.lat, dc.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'datacenter', data: dc, x, y });
    }
  }

  public triggerNuclearClick(id: string): void {
    const facility = NUCLEAR_FACILITIES.find(n => n.id === id);
    if (facility) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(facility.lat, facility.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'nuclear', data: facility, x, y });
    }
  }

  public triggerIrradiatorClick(id: string): void {
    const irradiator = GAMMA_IRRADIATORS.find(i => i.id === id);
    if (irradiator) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(irradiator.lat, irradiator.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'irradiator', data: irradiator, x, y });
    }
  }

  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    // Don't pan - project coordinates to screen position
    const screenPos = this.projectToScreen(lat, lon);
    if (!screenPos) return;

    // Flash effect by temporarily adding a highlight at the location
    const flashMarker = document.createElement('div');
    flashMarker.className = 'flash-location-marker';
    flashMarker.style.cssText = `
      position: absolute;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.5);
      border: 2px solid #fff;
      animation: flash-pulse 0.5s ease-out infinite;
      pointer-events: none;
      z-index: 1000;
      left: ${screenPos.x}px;
      top: ${screenPos.y}px;
      transform: translate(-50%, -50%);
    `;

    // Add animation keyframes if not present
    if (!document.getElementById('flash-animation-styles')) {
      const style = document.createElement('style');
      style.id = 'flash-animation-styles';
      style.textContent = `
        @keyframes flash-pulse {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(2); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    const wrapper = this.container.querySelector('.deckgl-map-wrapper');
    if (wrapper) {
      wrapper.appendChild(flashMarker);
      setTimeout(() => flashMarker.remove(), durationMs);
    }
  }

  // --- Country click + highlight ---

  public setOnCountryClick(cb: (country: CountryClickPayload) => void): void {
    this.onCountryClick = cb;
  }

  public setOnMapContextMenu(cb: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void): void {
    this.onMapContextMenu = cb;
  }

  private resolveCountryFromCoordinate(lon: number, lat: number): { code: string; name: string } | null {
    const fromGeometry = getCountryAtCoordinates(lat, lon);
    if (fromGeometry) return fromGeometry;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return null;
    try {
      if (!this.maplibreMap.getLayer('country-interactive')) return null;
      const point = this.maplibreMap.project([lon, lat]);
      const features = this.maplibreMap.queryRenderedFeatures(point, { layers: ['country-interactive'] });
      const properties = (features?.[0]?.properties ?? {}) as Record<string, unknown>;
      const code = typeof properties['ISO3166-1-Alpha-2'] === 'string'
        ? properties['ISO3166-1-Alpha-2'].trim().toUpperCase()
        : '';
      const name = typeof properties.name === 'string'
        ? properties.name.trim()
        : '';
      if (!code || !name) return null;
      return { code, name };
    } catch {
      return null;
    }
  }

  private loadCountryBoundaries(): void {
    if (!this.maplibreMap || this.countryGeoJsonLoaded) return;
    this.countryGeoJsonLoaded = true;

    getCountriesGeoJson()
      .then((geojson) => {
        if (!this.maplibreMap || !geojson) return;
        if (this.maplibreMap.getSource('country-boundaries')) return;
        this.countriesGeoJsonData = geojson;
        this.conflictZoneGeoJson = null;
        this.maplibreMap.addSource('country-boundaries', {
          type: 'geojson',
          data: geojson,
        });
        this.maplibreMap.addLayer({
          id: 'country-interactive',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0,
          },
        });
        this.maplibreMap.addLayer({
          id: 'country-hover-fill',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#ffffff',
            'fill-opacity': 0.05,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-hover-border',
          type: 'line',
          source: 'country-boundaries',
          paint: {
            'line-color': '#ffffff',
            'line-width': 1.5,
            'line-opacity': 0.22,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-highlight-fill',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0.12,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-highlight-border',
          type: 'line',
          source: 'country-boundaries',
          paint: {
            'line-color': '#3b82f6',
            'line-width': 1.5,
            'line-opacity': 0.5,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });

        if (!this.countryHoverSetup) this.setupCountryHover();
        const paintProvider = getMapProvider();
        const paintMapTheme = getMapTheme(paintProvider);
        this.updateCountryLayerPaint(isLightMapTheme(paintMapTheme) ? 'light' : 'dark');
        if (this.highlightedCountryCode) this.highlightCountry(this.highlightedCountryCode);
        this.render();
      })
      .catch((err) => console.warn('[DeckGLMap] Failed to load country boundaries:', err));
  }

  private setupCountryHover(): void {
    if (!this.maplibreMap || this.countryHoverSetup) return;
    this.countryHoverSetup = true;
    const map = this.maplibreMap;
    let hoveredIso2: string | null = null;

    const clearHover = () => {
      this.hoveredCountryIso2 = null;
      this.hoveredCountryName = null;
      map.getCanvas().style.cursor = '';
      if (!map.getLayer('country-hover-fill')) return;
      const noMatch = ['==', ['get', 'ISO3166-1-Alpha-2'], ''] as maplibregl.FilterSpecification;
      map.setFilter('country-hover-fill', noMatch);
      map.setFilter('country-hover-border', noMatch);
    };

    map.on('mousemove', (e) => {
      if (!this.onCountryClick) return;
      try {
        if (!map.getLayer('country-interactive')) return;
        const features = map.queryRenderedFeatures(e.point, { layers: ['country-interactive'] });
        const props = features?.[0]?.properties;
        const iso2 = props?.['ISO3166-1-Alpha-2'] as string | undefined;
        const name = props?.['name'] as string | undefined;

        if (iso2 && iso2 !== hoveredIso2) {
          hoveredIso2 = iso2;
          this.hoveredCountryIso2 = iso2;
          this.hoveredCountryName = name ?? null;
          const filter = ['==', ['get', 'ISO3166-1-Alpha-2'], iso2] as maplibregl.FilterSpecification;
          map.setFilter('country-hover-fill', filter);
          map.setFilter('country-hover-border', filter);
          map.getCanvas().style.cursor = 'pointer';
        } else if (!iso2 && hoveredIso2) {
          hoveredIso2 = null;
          clearHover();
        }
      } catch { /* style not done loading during theme switch */ }
    });

    map.on('mouseout', () => {
      if (hoveredIso2) {
        hoveredIso2 = null;
        try { clearHover(); } catch { /* style not done loading */ }
      }
    });
  }

  private countryPulseRaf: number | null = null;

  private getHighlightRestOpacity(): { fill: number; border: number } {
    const theme = isLightMapTheme(getMapTheme(getMapProvider())) ? 'light' : 'dark';
    return { fill: theme === 'light' ? 0.18 : 0.12, border: 0.5 };
  }

  public highlightCountry(code: string): void {
    this.highlightedCountryCode = code;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    try {
      if (!this.maplibreMap.getLayer('country-highlight-fill')) return;
      const filter = ['==', ['get', 'ISO3166-1-Alpha-2'], code] as maplibregl.FilterSpecification;
      this.maplibreMap.setFilter('country-highlight-fill', filter);
      this.maplibreMap.setFilter('country-highlight-border', filter);
      this.pulseCountryHighlight();
    } catch { /* style not yet loaded */ }
  }

  public clearCountryHighlight(): void {
    this.highlightedCountryCode = null;
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    if (!this.maplibreMap) return;
    try {
      if (!this.maplibreMap.getLayer('country-highlight-fill')) return;
      const rest = this.getHighlightRestOpacity();
      const noMatch = ['==', ['get', 'ISO3166-1-Alpha-2'], ''] as maplibregl.FilterSpecification;
      this.maplibreMap.setFilter('country-highlight-fill', noMatch);
      this.maplibreMap.setFilter('country-highlight-border', noMatch);
      this.maplibreMap.setPaintProperty('country-highlight-fill', 'fill-opacity', rest.fill);
      this.maplibreMap.setPaintProperty('country-highlight-border', 'line-opacity', rest.border);
    } catch { /* style unloaded or map torn down between panel close and highlight clear */ }
  }

  private pulseCountryHighlight(): void {
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    const map = this.maplibreMap;
    if (!map) return;
    const rest = this.getHighlightRestOpacity();
    const start = performance.now();
    const duration = 3000;
    const step = (now: number) => {
      try {
        if (!map.getLayer('country-highlight-fill')) { this.countryPulseRaf = null; return; }
      } catch { this.countryPulseRaf = null; return; }
      const t = (now - start) / duration;
      if (t >= 1) {
        this.countryPulseRaf = null;
        map.setPaintProperty('country-highlight-fill', 'fill-opacity', rest.fill);
        map.setPaintProperty('country-highlight-border', 'line-opacity', rest.border);
        return;
      }
      const pulse = Math.sin(t * Math.PI * 3) ** 2;
      const fade = 1 - t * t;
      const fillOp = rest.fill + 0.25 * pulse * fade;
      const borderOp = rest.border + 0.5 * pulse * fade;
      map.setPaintProperty('country-highlight-fill', 'fill-opacity', fillOp);
      map.setPaintProperty('country-highlight-border', 'line-opacity', borderOp);
      this.countryPulseRaf = requestAnimationFrame(step);
    };
    this.countryPulseRaf = requestAnimationFrame(step);
  }

  private switchBasemap(): void {
    if (!this.maplibreMap) return;
    const provider = getMapProvider();
    const mapTheme = getMapTheme(provider);
    const style = isHappyVariant
      ? (getCurrentTheme() === 'light' ? HAPPY_LIGHT_STYLE : HAPPY_DARK_STYLE)
      : (this.usedFallbackStyle && provider === 'auto')
        ? (isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE)
        : getStyleForProvider(provider, mapTheme);
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    this.countryGeoJsonLoaded = false;
    this.maplibreMap.setStyle(style, { diff: false });
    this.maplibreMap.once('style.load', () => {
      localizeMapLabels(this.maplibreMap);
      this.loadCountryBoundaries();
      if (this.radarActive) this.applyRadarLayer();
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    });
    if (!isHappyVariant && provider !== 'openfreemap' && !this.usedFallbackStyle) {
      this.monitorTileLoading(mapTheme);
    }
  }

  private monitorTileLoading(mapTheme: string): void {
    if (!this.maplibreMap) return;
    const gen = ++this.tileMonitorGeneration;
    let ok = false;
    let errCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const map = this.maplibreMap;

    const cleanup = () => {
      map.off('error', onError);
      map.off('data', onData);
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    };

    const onError = (e: { error?: Error; message?: string }) => {
      if (gen !== this.tileMonitorGeneration) { cleanup(); return; }
      const msg = e.error?.message ?? e.message ?? '';
      if (msg.includes('Failed to fetch') || msg.includes('AJAXError') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('403') || msg.includes('Forbidden')) {
        errCount++;
        if (!ok && errCount >= 2) {
          cleanup();
          this.switchToFallbackStyle(mapTheme);
        }
      }
    };

    const onData = (e: { dataType?: string }) => {
      if (gen !== this.tileMonitorGeneration) { cleanup(); return; }
      if (e.dataType === 'source') { ok = true; cleanup(); }
    };

    map.on('error', onError);
    map.on('data', onData);

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (gen !== this.tileMonitorGeneration) return;
      cleanup();
      if (!ok) this.switchToFallbackStyle(mapTheme);
    }, 10000);
  }

  private switchToFallbackStyle(mapTheme: string): void {
    if (this.usedFallbackStyle || !this.maplibreMap) return;
    this.usedFallbackStyle = true;
    const fallback = isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    console.warn(`[DeckGLMap] Basemap tiles failed, falling back to OpenFreeMap: ${fallback}`);
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    this.countryGeoJsonLoaded = false;
    this.maplibreMap.setStyle(fallback, { diff: false });
    this.maplibreMap.once('style.load', () => {
      localizeMapLabels(this.maplibreMap);
      this.loadCountryBoundaries();
      if (this.radarActive) this.applyRadarLayer();
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    });
  }

  public reloadBasemap(): void {
    if (!this.maplibreMap) return;
    const provider = getMapProvider();
    if (provider === 'pmtiles' || provider === 'auto') registerPMTilesProtocol();
    this.usedFallbackStyle = false;
    this.switchBasemap();
  }

  private updateCountryLayerPaint(theme: 'dark' | 'light'): void {
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    if (!this.maplibreMap.style || !this.maplibreMap.getLayer('country-hover-fill')) return;
    const hoverFillOpacity   = theme === 'light' ? 0.08 : 0.05;
    const hoverBorderOpacity = theme === 'light' ? 0.35 : 0.22;
    const highlightOpacity   = theme === 'light' ? 0.18 : 0.12;
    this.maplibreMap.setPaintProperty('country-hover-fill',   'fill-opacity', hoverFillOpacity);
    this.maplibreMap.setPaintProperty('country-hover-border', 'line-opacity', hoverBorderOpacity);
    this.maplibreMap.setPaintProperty('country-highlight-fill', 'fill-opacity', highlightOpacity);
  }

  public destroy(): void {
    this.activeFlightTrails.clear();
    this.clearTrailsBtn = null;
    this._unsubscribeAuthState?.();
    this._unsubscribeAuthState = null;
    window.removeEventListener('theme-changed', this.handleThemeChange);
    window.removeEventListener('map-theme-changed', this.handleMapThemeChange);
    this.debouncedRebuildLayers.cancel();
    this.debouncedFetchBases.cancel();
    this.debouncedFetchAircraft.cancel();
    this.rafUpdateLayers.cancel();

    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }

    if (this.countryPulseRaf !== null) {
      cancelAnimationFrame(this.countryPulseRaf);
      this.countryPulseRaf = null;
    }

    if (this.moveTimeoutId) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    if (this.styleLoadTimeoutId) {
      clearTimeout(this.styleLoadTimeoutId);
      this.styleLoadTimeoutId = null;
    }
    this.stopPulseAnimation();
    this.stopDayNightTimer();
    this.stopWeatherRadar();
    if (this.aircraftFetchTimer) {
      clearInterval(this.aircraftFetchTimer);
      this.aircraftFetchTimer = null;
    }


    this.layerCache.clear();

    this.deckOverlay?.finalize();
    this.deckOverlay = null;
    this.maplibreMap?.getCanvas().removeEventListener('contextmenu', this.handleContextMenu);
    this.maplibreMap?.remove();
    this.maplibreMap = null;
    this.container.innerHTML = '';
  }
}
