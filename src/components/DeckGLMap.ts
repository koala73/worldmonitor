/**
 * DeckGLMap - WebGL-accelerated map visualization for desktop
 * Uses deck.gl for high-performance rendering of large datasets
 * Mobile devices gracefully degrade to the D3/SVG-based Map component
 */
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, LayersList, PickingInfo } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, PathLayer, IconLayer, TextLayer } from '@deck.gl/layers';
import maplibregl from 'maplibre-gl';
import Supercluster from 'supercluster';
import type {
  MapLayers,
  Hotspot,
  NewsItem,
  Earthquake,
  InternetOutage,
  RelatedAsset,
  AssetType,
  AisDisruptionEvent,
  AisDensityZone,
  CableAdvisory,
  RepairShip,
  SocialUnrestEvent,
  AIDataCenter,
  AirportDelayAlert,
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  NaturalEvent,
  UcdpGeoEvent,
  DisplacementFlow,
  ClimateAnomaly,
  MapProtestCluster,
  MapTechHQCluster,
  MapTechEventCluster,
  MapDatacenterCluster,
  CyberThreat,
} from '@/types';
import { ArcLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { WeatherAlert } from '@/services/weather';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { debounce, rafSchedule, getCurrentTheme } from '@/utils/index';
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
  APT_GROUPS,
  CRITICAL_MINERALS,
  STOCK_EXCHANGES,
  FINANCIAL_CENTERS,
  CENTRAL_BANKS,
  COMMODITY_HUBS,
  GULF_INVESTMENTS,
} from '@/config';
import type { GulfInvestment } from '@/types';
import { MapPopup, type PopupType } from './MapPopup';
import {
  updateHotspotEscalation,
  getHotspotEscalation,
  setMilitaryData,
  setCIIGetter,
  setGeoAlertGetter,
} from '@/services/hotspot-escalation';
import { getCountryScore } from '@/services/country-instability';
import { getAlertsNearLocation } from '@/services/geo-convergence';
import { getCountriesGeoJson, getCountryAtCoordinates } from '@/services/country-geometry';

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

// Theme-aware basemap vector style URLs (English labels, no local scripts)
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const LIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

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
    earthquake: [255, 100, 50, 200] as [number, number, number, number],
    vesselMilitary: [255, 100, 100, 220] as [number, number, number, number],
    flightMilitary: [255, 50, 50, 220] as [number, number, number, number],
    protest: [255, 150, 0, 200] as [number, number, number, number],
    outage: [255, 50, 50, 180] as [number, number, number, number],
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
};

export class DeckGLMap {
  private static readonly MAX_CLUSTER_LEAVES = 200;

  private container: HTMLElement;
  private deckOverlay: MapboxOverlay | null = null;
  private maplibreMap: maplibregl.Map | null = null;
  private state: DeckMapState;
  private popup: MapPopup;

  // Data stores
  private hotspots: HotspotWithBreaking[];
  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private outages: InternetOutage[] = [];
  private cyberThreats: CyberThreat[] = [];
  private aisDisruptions: AisDisruptionEvent[] = [];
  private aisDensity: AisDensityZone[] = [];
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private protests: SocialUnrestEvent[] = [];
  private militaryFlights: MilitaryFlight[] = [];
  private militaryFlightClusters: MilitaryFlightCluster[] = [];
  private militaryVessels: MilitaryVessel[] = [];
  private militaryVesselClusters: MilitaryVesselCluster[] = [];
  private naturalEvents: NaturalEvent[] = [];
  private firmsFireData: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }> = [];
  private techEvents: TechEventMarker[] = [];
  private flightDelays: AirportDelayAlert[] = [];
  private news: NewsItem[] = [];
  private newsLocations: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }> = [];
  private newsLocationFirstSeen = new Map<string, number>();
  private ucdpEvents: UcdpGeoEvent[] = [];
  private displacementFlows: DisplacementFlow[] = [];
  private climateAnomalies: ClimateAnomaly[] = [];

  // Country highlight state
  private countryGeoJsonLoaded = false;
  private countryHoverSetup = false;
  private highlightedCountryCode: string | null = null;

  // Callbacks
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onCountryClick?: (country: CountryClickPayload) => void;
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean) => void;
  private onStateChange?: (state: DeckMapState) => void;

  // Highlighted assets
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    base: new Set(),
    nuclear: new Set(),
  };

  private renderScheduled = false;
  private renderPaused = false;
  private renderPending = false;
  private resizeObserver: ResizeObserver | null = null;

  private layerCache: Map<string, Layer> = new Map();
  private lastZoomThreshold = 0;
  private protestSC: Supercluster | null = null;
  private techHQSC: Supercluster | null = null;
  private techEventSC: Supercluster | null = null;
  private datacenterSC: Supercluster | null = null;
  private protestClusters: MapProtestCluster[] = [];
  private techHQClusters: MapTechHQCluster[] = [];
  private techEventClusters: MapTechEventCluster[] = [];
  private datacenterClusters: MapDatacenterCluster[] = [];
  private lastSCZoom = -1;
  private lastSCBoundsKey = '';
  private lastSCMask = '';
  private protestSuperclusterSource: SocialUnrestEvent[] = [];
  private newsPulseIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly startupTime = Date.now();
  private lastCableHighlightSignature = '';
  private lastPipelineHighlightSignature = '';
  private debouncedRebuildLayers: () => void;
  private rafUpdateLayers: () => void;
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, initialState: DeckMapState) {
    this.container = container;
    this.state = initialState;
    this.hotspots = [...INTEL_HOTSPOTS];

    this.rebuildTechHQSupercluster();
    this.rebuildDatacenterSupercluster();

    this.debouncedRebuildLayers = debounce(() => {
      if (this.renderPaused) return;
      this.maplibreMap?.resize();
      this.deckOverlay?.setProps({ layers: this.buildLayers() });
    }, 150);
    this.rafUpdateLayers = rafSchedule(() => {
      if (this.renderPaused) return;
      this.deckOverlay?.setProps({ layers: this.buildLayers() });
    });

    this.setupDOM();
    this.popup = new MapPopup(container);

    window.addEventListener('theme-changed', (e: Event) => {
      const theme = (e as CustomEvent).detail?.theme as 'dark' | 'light';
      if (theme) {
        this.switchBasemap(theme);
        this.render(); // Rebuilds Deck.GL layers with new theme-aware colors
      }
    });

    this.initMapLibre();

    this.maplibreMap?.on('load', () => {
      this.initDeck();
      this.loadCountryBoundaries();
      this.render();
    });

    this.setupResizeObserver();

    this.createControls();
    this.createTimeSlider();
    this.createLayerToggles();
    this.createLegend();
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

    this.container.appendChild(wrapper);
  }

  private initMapLibre(): void {
    const preset = VIEW_PRESETS[this.state.view];
    const initialTheme = getCurrentTheme();

    this.maplibreMap = new maplibregl.Map({
      container: 'deckgl-basemap',
      style: initialTheme === 'light' ? LIGHT_STYLE : DARK_STYLE,
      center: [preset.longitude, preset.latitude],
      zoom: preset.zoom,
      renderWorldCopies: false,
      attributionControl: false,
      interactive: true,
      ...(MAP_INTERACTION_MODE === 'flat'
        ? {
          maxPitch: 0,
          pitchWithRotate: false,
          dragRotate: false,
          touchPitch: false,
        }
        : {}),
    });
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
    });

    this.maplibreMap.addControl(this.deckOverlay as unknown as maplibregl.IControl);

    this.maplibreMap.on('movestart', () => {
      if (this.moveTimeoutId) {
        clearTimeout(this.moveTimeoutId);
        this.moveTimeoutId = null;
      }
    });

    this.maplibreMap.on('moveend', () => {
      this.lastSCZoom = -1;
      this.rafUpdateLayers();
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
    });
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.maplibreMap) {
        this.maplibreMap.resize();
      }
    });
    this.resizeObserver.observe(this.container);
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
        validated: Boolean(p.validated),
        fatalities: Number.isFinite(p.fatalities) ? Number(p.fatalities) : 0,
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
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.maxSeverityRank = Math.max(Number(acc.maxSeverityRank ?? 0), Number(props.maxSeverityRank ?? 0));
        acc.riotCount = Number(acc.riotCount ?? 0) + Number(props.riotCount ?? 0);
        acc.highSeverityCount = Number(acc.highSeverityCount ?? 0) + Number(props.highSeverityCount ?? 0);
        acc.verifiedCount = Number(acc.verifiedCount ?? 0) + Number(props.verifiedCount ?? 0);
        acc.totalFatalities = Number(acc.totalFatalities ?? 0) + Number(props.totalFatalities ?? 0);
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

    if (useProtests && this.protestSC) {
      this.protestClusters = this.protestSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const leaves = this.protestSC!.getLeaves(f.properties.cluster_id!, DeckGLMap.MAX_CLUSTER_LEAVES);
          const items = leaves.map(l => this.protestSuperclusterSource[l.properties.index]).filter((x): x is SocialUnrestEvent => !!x);
          const maxSeverityRank = Number(props.maxSeverityRank ?? 0);
          const maxSev = maxSeverityRank >= 2 ? 'high' : maxSeverityRank === 1 ? 'medium' : 'low';
          const riotCount = Number(props.riotCount ?? 0);
          const highSeverityCount = Number(props.highSeverityCount ?? 0);
          const verifiedCount = Number(props.verifiedCount ?? 0);
          const totalFatalities = Number(props.totalFatalities ?? 0);
          const clusterCount = Number(f.properties.point_count ?? items.length);
          const latestRiotEventTimeMs = items.reduce((max, it) => {
            if (it.eventType !== 'riot' || it.sourceType === 'gdelt') return max;
            const ts = it.time.getTime();
            return Number.isFinite(ts) ? Math.max(max, ts) : max;
          }, 0);
          return {
            id: `pc-${f.properties.cluster_id}`,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items,
            country: String(props.country ?? items[0]?.country ?? ''),
            maxSeverity: maxSev as 'low' | 'medium' | 'high',
            hasRiot: riotCount > 0,
            latestRiotEventTimeMs: latestRiotEventTimeMs || undefined,
            totalFatalities,
            riotCount,
            highSeverityCount,
            verifiedCount,
            sampled: items.length < clusterCount,
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
          const leaves = this.techHQSC!.getLeaves(f.properties.cluster_id!, DeckGLMap.MAX_CLUSTER_LEAVES);
          const items = leaves.map(l => TECH_HQS[l.properties.index]).filter(Boolean) as typeof TECH_HQS;
          const faangCount = Number(props.faangCount ?? 0);
          const unicornCount = Number(props.unicornCount ?? 0);
          const publicCount = Number(props.publicCount ?? 0);
          const clusterCount = Number(f.properties.point_count ?? items.length);
          const primaryType = faangCount >= unicornCount && faangCount >= publicCount
            ? 'faang'
            : unicornCount >= publicCount
              ? 'unicorn'
              : 'public';
          return {
            id: `hc-${f.properties.cluster_id}`,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items,
            city: String(props.city ?? items[0]?.city ?? ''),
            country: String(props.country ?? items[0]?.country ?? ''),
            primaryType,
            faangCount,
            unicornCount,
            publicCount,
            sampled: items.length < clusterCount,
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
          const leaves = this.techEventSC!.getLeaves(f.properties.cluster_id!, DeckGLMap.MAX_CLUSTER_LEAVES);
          const items = leaves.map(l => this.techEvents[l.properties.index]).filter((x): x is TechEventMarker => !!x);
          const clusterCount = Number(f.properties.point_count ?? items.length);
          const soonestDaysUntil = Number(props.soonestDaysUntil ?? Number.MAX_SAFE_INTEGER);
          const soonCount = Number(props.soonCount ?? 0);
          return {
            id: `ec-${f.properties.cluster_id}`,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items,
            location: String(props.location ?? items[0]?.location ?? ''),
            country: String(props.country ?? items[0]?.country ?? ''),
            soonestDaysUntil: Number.isFinite(soonestDaysUntil) ? soonestDaysUntil : Number.MAX_SAFE_INTEGER,
            soonCount,
            sampled: items.length < clusterCount,
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
      const activeDCs = AI_DATA_CENTERS.filter(dc => dc.status !== 'decommissioned');
      this.datacenterClusters = this.datacenterSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const leaves = this.datacenterSC!.getLeaves(f.properties.cluster_id!, DeckGLMap.MAX_CLUSTER_LEAVES);
          const items = leaves.map(l => activeDCs[l.properties.index]).filter((x): x is AIDataCenter => !!x);
          const clusterCount = Number(f.properties.point_count ?? items.length);
          const existingCount = Number(props.existingCount ?? 0);
          const plannedCount = Number(props.plannedCount ?? 0);
          const totalChips = Number(props.totalChips ?? 0);
          const totalPowerMW = Number(props.totalPowerMW ?? 0);
          return {
            id: `dc-${f.properties.cluster_id}`,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items,
            region: String(props.country ?? items[0]?.country ?? ''),
            country: String(props.country ?? items[0]?.country ?? ''),
            totalChips,
            totalPowerMW,
            majorityExisting: existingCount >= Math.max(1, clusterCount / 2),
            existingCount,
            plannedCount,
            sampled: items.length < clusterCount,
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
    const filteredEarthquakes = this.filterByTime(this.earthquakes, (eq) => eq.time);
    const filteredNaturalEvents = this.filterByTime(this.naturalEvents, (event) => event.date);
    const filteredWeatherAlerts = this.filterByTime(this.weatherAlerts, (alert) => alert.onset);
    const filteredOutages = this.filterByTime(this.outages, (outage) => outage.pubDate);
    const filteredCableAdvisories = this.filterByTime(this.cableAdvisories, (advisory) => advisory.reported);
    const filteredFlightDelays = this.filterByTime(this.flightDelays, (delay) => delay.updatedAt);
    const filteredMilitaryFlights = this.filterByTime(this.militaryFlights, (flight) => flight.lastSeen);
    const filteredMilitaryVessels = this.filterByTime(this.militaryVessels, (vessel) => vessel.lastAisUpdate);
    const filteredMilitaryFlightClusters = this.filterMilitaryFlightClustersByTime(this.militaryFlightClusters);
    const filteredMilitaryVesselClusters = this.filterMilitaryVesselClustersByTime(this.militaryVesselClusters);
    const filteredUcdpEvents = this.filterByTime(this.ucdpEvents, (event) => event.date_start);

    // Undersea cables layer
    if (mapLayers.cables) {
      layers.push(this.createCablesLayer());
    }

    // Pipelines layer
    if (mapLayers.pipelines) {
      layers.push(this.createPipelinesLayer());
    }

    // Conflict zones layer
    if (mapLayers.conflicts) {
      layers.push(this.createConflictZonesLayer());
    }

    // Military bases layer — hidden at low zoom (E: progressive disclosure) + ghost
    if (mapLayers.bases && this.isLayerVisible('bases')) {
      layers.push(this.createBasesLayer());
      layers.push(this.createGhostLayer('bases-layer', MILITARY_BASES, d => [d.lon, d.lat], { radiusMinPixels: 12 }));
    }

    // Nuclear facilities layer — hidden at low zoom + ghost
    if (mapLayers.nuclear && this.isLayerVisible('nuclear')) {
      layers.push(this.createNuclearLayer());
      layers.push(this.createGhostLayer('nuclear-layer', NUCLEAR_FACILITIES.filter(f => f.status !== 'decommissioned'), d => [d.lon, d.lat], { radiusMinPixels: 12 }));
    }

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

    // Earthquakes layer + ghost for easier picking
    if (mapLayers.natural && filteredEarthquakes.length > 0) {
      layers.push(this.createEarthquakesLayer(filteredEarthquakes));
      layers.push(this.createGhostLayer('earthquakes-layer', filteredEarthquakes, d => [d.lon, d.lat], { radiusMinPixels: 12 }));
    }

    // Natural events layer
    if (mapLayers.natural && filteredNaturalEvents.length > 0) {
      layers.push(this.createNaturalEventsLayer(filteredNaturalEvents));
    }

    // Satellite fires layer (NASA FIRMS)
    if (mapLayers.fires && this.firmsFireData.length > 0) {
      layers.push(this.createFiresLayer());
    }

    // Weather alerts layer
    if (mapLayers.weather && filteredWeatherAlerts.length > 0) {
      layers.push(this.createWeatherLayer(filteredWeatherAlerts));
    }

    // Internet outages layer + ghost for easier picking
    if (mapLayers.outages && filteredOutages.length > 0) {
      layers.push(this.createOutagesLayer(filteredOutages));
      layers.push(this.createGhostLayer('outages-layer', filteredOutages, d => [d.lon, d.lat], { radiusMinPixels: 12 }));
    }

    // Cyber threat IOC layer
    if (mapLayers.cyberThreats && this.cyberThreats.length > 0) {
      layers.push(this.createCyberThreatsLayer());
      layers.push(this.createGhostLayer('cyber-threats-layer', this.cyberThreats, d => [d.lon, d.lat], { radiusMinPixels: 12 }));
    }

    // AIS density layer
    if (mapLayers.ais && this.aisDensity.length > 0) {
      layers.push(this.createAisDensityLayer());
    }

    // AIS disruptions layer (spoofing/jamming)
    if (mapLayers.ais && this.aisDisruptions.length > 0) {
      layers.push(this.createAisDisruptionsLayer());
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

    // Flight delays layer
    if (mapLayers.flights && filteredFlightDelays.length > 0) {
      layers.push(this.createFlightDelaysLayer(filteredFlightDelays));
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

    // APT Groups layer (geopolitical variant only - always shown, no toggle)
    if (SITE_VARIANT !== 'tech') {
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
    if (cached && highlightSignature === this.lastCableHighlightSignature) return cached;

    const layer = new PathLayer({
      id: cacheKey,
      data: UNDERSEA_CABLES,
      getPath: (d) => d.points,
      getColor: (d) =>
        highlightedCables.has(d.id) ? COLORS.cableHighlight : COLORS.cable,
      getWidth: (d) => highlightedCables.has(d.id) ? 3 : 1,
      widthMinPixels: 1,
      widthMaxPixels: 5,
      pickable: true,
      updateTriggers: { highlighted: highlightSignature },
    });

    this.lastCableHighlightSignature = highlightSignature;
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

  private createConflictZonesLayer(): GeoJsonLayer {
    const cacheKey = 'conflict-zones-layer';

    const geojsonData = {
      type: 'FeatureCollection' as const,
      features: CONFLICT_ZONES.map(zone => ({
        type: 'Feature' as const,
        properties: { id: zone.id, name: zone.name, intensity: zone.intensity },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [zone.coords],
        },
      })),
    };

    const layer = new GeoJsonLayer({
      id: cacheKey,
      data: geojsonData,
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

  private createBasesLayer(): IconLayer {
    const highlightedBases = this.highlightedAssets.base;

    // Base colors by operator type - semi-transparent for layering
    // F: Fade in bases as you zoom — subtle at zoom 3, full at zoom 5+
    const zoom = this.maplibreMap?.getZoom() || 3;
    const alphaScale = Math.min(1, (zoom - 2.5) / 2.5); // 0.2 at zoom 3, 1.0 at zoom 5
    const a = Math.round(160 * Math.max(0.3, alphaScale));

    const getBaseColor = (type: string): [number, number, number, number] => {
      switch (type) {
        case 'us-nato': return [68, 136, 255, a];
        case 'russia': return [255, 68, 68, a];
        case 'china': return [255, 136, 68, a];
        case 'uk': return [68, 170, 255, a];
        case 'france': return [0, 85, 164, a];
        case 'india': return [255, 153, 51, a];
        case 'japan': return [188, 0, 45, a];
        default: return [136, 136, 136, a];
      }
    };

    // Military bases: TRIANGLE icons - color by operator, semi-transparent
    return new IconLayer({
      id: 'bases-layer',
      data: MILITARY_BASES,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'triangleUp',
      iconAtlas: MARKER_ICONS.triangleUp,
      iconMapping: { triangleUp: { x: 0, y: 0, width: 32, height: 32, mask: true } },
      getSize: (d) => highlightedBases.has(d.id) ? 16 : 11,
      getColor: (d) => {
        if (highlightedBases.has(d.id)) {
          return [255, 100, 100, 220] as [number, number, number, number];
        }
        return getBaseColor(d.type);
      },
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 16,
      pickable: true,
    });
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
      iconMapping: { hexagon: { x: 0, y: 0, width: 32, height: 32, mask: true } },
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
        if (d.severity === 'GDP') return 15000; // Ground Delay Program
        if (d.severity === 'GS') return 12000; // Ground Stop
        return 8000;
      },
      getFillColor: (d) => {
        if (d.severity === 'GS') return [255, 50, 50, 200] as [number, number, number, number]; // Red for ground stops
        if (d.severity === 'GDP') return [255, 150, 0, 200] as [number, number, number, number]; // Orange for delays
        return [255, 200, 100, 180] as [number, number, number, number]; // Yellow
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 15,
      pickable: true,
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
      iconMapping: { square: { x: 0, y: 0, width: 32, height: 32, mask: true } },
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
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => Math.pow(2, d.magnitude) * 1000,
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

  private createNaturalEventsLayer(events: NaturalEvent[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'natural-events-layer',
      data: events,
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
    });
  }

  private createFiresLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'fires-layer',
      data: this.firmsFireData,
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
      getFillColor: COLORS.vesselMilitary,
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
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
      getFillColor: COLORS.flightMilitary,
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
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

  private createAPTGroupsLayer(): ScatterplotLayer {
    // APT Groups - cyber threat actor markers (geopolitical variant only)
    // Made subtle to avoid visual clutter - small orange dots
    return new ScatterplotLayer({
      id: 'apt-groups-layer',
      data: APT_GROUPS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: [255, 140, 0, 140] as [number, number, number, number], // Subtle orange
      radiusMinPixels: 4,
      radiusMaxPixels: 8,
      pickable: true,
      stroked: false, // No outline - cleaner look
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

    layers.push(this.createGhostLayer('protest-clusters-layer', this.protestClusters, d => [d.lon, d.lat], { radiusMinPixels: 14 }));

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

    layers.push(this.createGhostLayer('tech-hq-clusters-layer', this.techHQClusters, d => [d.lon, d.lat], { radiusMinPixels: 14 }));

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

    layers.push(this.createGhostLayer('tech-event-clusters-layer', this.techEventClusters, d => [d.lon, d.lat], { radiusMinPixels: 14 }));

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

    layers.push(this.createGhostLayer('datacenter-clusters-layer', this.datacenterClusters, d => [d.lon, d.lat], { radiusMinPixels: 14 }));

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

    layers.push(this.createGhostLayer('hotspots-layer', this.hotspots, d => [d.lon, d.lat], { radiusMinPixels: 14 }));

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
      || this.hotspots.some(h => h.hasBreaking);
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
        return { html: `<div class="deckgl-tooltip"><strong>M${(obj.magnitude || 0).toFixed(1)} Earthquake</strong><br/>${text(obj.place)}</div>` };
      case 'military-vessels-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.operatorCountry)}</div>` };
      case 'military-flights-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.callsign || obj.registration || 'Military Aircraft')}</strong><br/>${text(obj.type)}</div>` };
      case 'military-vessel-clusters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || 'Vessel Cluster')}</strong><br/>${obj.vesselCount || 0} vessels<br/>${text(obj.activityType)}</div>` };
      case 'military-flight-clusters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || 'Flight Cluster')}</strong><br/>${obj.flightCount || 0} aircraft<br/>${text(obj.activityType)}</div>` };
      case 'protests-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.country)}</div>` };
      case 'protest-clusters-layer':
        if (obj.count === 1) {
          const item = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(item?.title || 'Protest')}</strong><br/>${text(item?.city || item?.country || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${obj.count} protests</strong><br/>${text(obj.country)}</div>` };
      case 'tech-hq-clusters-layer':
        if (obj.count === 1) {
          const hq = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(hq?.company || '')}</strong><br/>${text(hq?.city || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${obj.count} tech HQs</strong><br/>${text(obj.city)}</div>` };
      case 'tech-event-clusters-layer':
        if (obj.count === 1) {
          const ev = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(ev?.title || '')}</strong><br/>${text(ev?.location || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${obj.count} tech events</strong><br/>${text(obj.location)}</div>` };
      case 'datacenter-clusters-layer':
        if (obj.count === 1) {
          const dc = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(dc?.name || '')}</strong><br/>${text(dc?.owner || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${obj.count} data centers</strong><br/>${text(obj.country)}</div>` };
      case 'bases-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country)}</div>` };
      case 'nuclear-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)}</div>` };
      case 'datacenters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.owner)}</div>` };
      case 'cables-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>Undersea Cable</div>` };
      case 'pipelines-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)} Pipeline</div>` };
      case 'conflict-zones-layer': {
        const props = obj.properties || obj;
        return { html: `<div class="deckgl-tooltip"><strong>${text(props.name)}</strong><br/>Conflict Zone</div>` };
      }
      case 'natural-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.category || 'Natural Event')}</div>` };
      case 'ais-density-layer':
        return { html: `<div class="deckgl-tooltip"><strong>Ship Traffic</strong><br/>Intensity: ${text(obj.intensity)}</div>` };
      case 'waterways-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>Strategic Waterway</div>` };
      case 'economic-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country)}</div>` };
      case 'stock-exchanges-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.shortName)}</strong><br/>${text(obj.city)}, ${text(obj.country)}</div>` };
      case 'financial-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)} financial center</div>` };
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
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type || 'Gamma Irradiator')}</div>` };
      case 'spaceports-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country || 'Spaceport')}</div>` };
      case 'ports-layer': {
        const typeIcon = obj.type === 'naval' ? '⚓' : obj.type === 'oil' || obj.type === 'lng' ? '🛢️' : '🏭';
        return { html: `<div class="deckgl-tooltip"><strong>${typeIcon} ${text(obj.name)}</strong><br/>${text(obj.type || 'Port')} - ${text(obj.country)}</div>` };
      }
      case 'flight-delays-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.airport)}</strong><br/>${text(obj.severity)}: ${text(obj.reason)}</div>` };
      case 'apt-groups-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.aka)}<br/>Sponsor: ${text(obj.sponsor)}</div>` };
      case 'minerals-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.mineral)} - ${text(obj.country)}<br/>${text(obj.operator)}</div>` };
      case 'ais-disruptions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>AIS ${text(obj.type || 'Disruption')}</strong><br/>${text(obj.severity)} severity<br/>${text(obj.description)}</div>` };
      case 'cable-advisories-layer': {
        const cableName = UNDERSEA_CABLES.find(c => c.id === obj.cableId)?.name || obj.cableId;
        return { html: `<div class="deckgl-tooltip"><strong>${text(cableName)}</strong><br/>${text(obj.severity || 'Advisory')}<br/>${text(obj.description)}</div>` };
      }
      case 'repair-ships-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || 'Repair Ship')}</strong><br/>${text(obj.status)}</div>` };
      case 'weather-layer': {
        const areaDesc = typeof obj.areaDesc === 'string' ? obj.areaDesc : '';
        const area = areaDesc ? `<br/><small>${text(areaDesc.slice(0, 50))}${areaDesc.length > 50 ? '...' : ''}</small>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.event || 'Weather Alert')}</strong><br/>${text(obj.severity)}${area}</div>` };
      }
      case 'outages-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.asn || 'Internet Outage')}</strong><br/>${text(obj.country)}</div>` };
      case 'cyber-threats-layer':
        return { html: `<div class="deckgl-tooltip"><strong>Cyber Threat</strong><br/>${text(obj.severity || 'medium')} · ${text(obj.country || 'Unknown')}</div>` };
      case 'news-locations-layer':
        return { html: `<div class="deckgl-tooltip"><strong>📰 News</strong><br/>${text(obj.title?.slice(0, 80) || '')}</div>` };
      case 'gulf-investments-layer': {
        const inv = obj as GulfInvestment;
        const flag = inv.investingCountry === 'SA' ? '🇸🇦' : '🇦🇪';
        const usd = inv.investmentUSD != null
          ? (inv.investmentUSD >= 1000 ? `$${(inv.investmentUSD / 1000).toFixed(1)}B` : `$${inv.investmentUSD}M`)
          : 'Undisclosed';
        const stake = inv.stakePercent != null ? `<br/>${text(String(inv.stakePercent))}% stake` : '';
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
      default:
        return null;
    }
  }

  private handleClick(info: PickingInfo): void {
    if (!info.object) {
      // Empty map click → country detection
      if (info.coordinate && this.onCountryClick) {
        const [lon, lat] = info.coordinate as [number, number];
        const country = this.resolveCountryFromCoordinate(lon, lat);
        this.onCountryClick({
          lat,
          lon,
          ...(country ? { code: country.code, name: country.name } : {}),
        });
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

    // Map layer IDs to popup types
    const layerToPopupType: Record<string, PopupType> = {
      'conflict-zones-layer': 'conflict',
      'bases-layer': 'base',
      'nuclear-layer': 'nuclear',
      'irradiators-layer': 'irradiator',
      'datacenters-layer': 'datacenter',
      'cables-layer': 'cable',
      'pipelines-layer': 'pipeline',
      'earthquakes-layer': 'earthquake',
      'weather-layer': 'weather',
      'outages-layer': 'outage',
      'cyber-threats-layer': 'cyberThreat',
      'protests-layer': 'protest',
      'military-flights-layer': 'militaryFlight',
      'military-vessels-layer': 'militaryVessel',
      'military-vessel-clusters-layer': 'militaryVesselCluster',
      'military-flight-clusters-layer': 'militaryFlightCluster',
      'natural-events-layer': 'natEvent',
      'waterways-layer': 'waterway',
      'economic-centers-layer': 'economic',
      'stock-exchanges-layer': 'stockExchange',
      'financial-centers-layer': 'financialCenter',
      'central-banks-layer': 'centralBank',
      'commodity-hubs-layer': 'commodityHub',
      'spaceports-layer': 'spaceport',
      'ports-layer': 'port',
      'flight-delays-layer': 'flight',
      'startup-hubs-layer': 'startupHub',
      'tech-hqs-layer': 'techHQ',
      'accelerators-layer': 'accelerator',
      'cloud-regions-layer': 'cloudRegion',
      'tech-events-layer': 'techEvent',
      'apt-groups-layer': 'apt',
      'minerals-layer': 'mineral',
      'ais-disruptions-layer': 'ais',
      'cable-advisories-layer': 'cable-advisory',
      'repair-ships-layer': 'repair-ship',
    };

    const popupType = layerToPopupType[layerId];
    if (!popupType) return;

    // For GeoJSON layers, the data is in properties
    let data = info.object;
    if (layerId === 'conflict-zones-layer' && info.object.properties) {
      // Find the full conflict zone data from config
      const conflictId = info.object.properties.id;
      const fullConflict = CONFLICT_ZONES.find(c => c.id === conflictId);
      if (fullConflict) data = fullConflict;
    }

    // Get click coordinates relative to container
    const x = info.x ?? 0;
    const y = info.y ?? 0;

    this.popup.show({
      type: popupType,
      data: data,
      x,
      y,
    });
  }

  // Utility methods
  private hexToRgba(hex: string, alpha: number): [number, number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result && result[1] && result[2] && result[3]) {
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

    const layerConfig = SITE_VARIANT === 'tech'
      ? [
        { key: 'startupHubs', label: t('components.deckgl.layers.startupHubs'), icon: '&#128640;' },
        { key: 'techHQs', label: t('components.deckgl.layers.techHQs'), icon: '&#127970;' },
        { key: 'accelerators', label: t('components.deckgl.layers.accelerators'), icon: '&#9889;' },
        { key: 'cloudRegions', label: t('components.deckgl.layers.cloudRegions'), icon: '&#9729;' },
        { key: 'datacenters', label: t('components.deckgl.layers.aiDataCenters'), icon: '&#128421;' },
        { key: 'cables', label: t('components.deckgl.layers.underseaCables'), icon: '&#128268;' },
        { key: 'outages', label: t('components.deckgl.layers.internetOutages'), icon: '&#128225;' },
        { key: 'cyberThreats', label: t('components.deckgl.layers.cyberThreats'), icon: '&#128737;' },
        { key: 'techEvents', label: t('components.deckgl.layers.techEvents'), icon: '&#128197;' },
        { key: 'natural', label: t('components.deckgl.layers.naturalEvents'), icon: '&#127755;' },
        { key: 'fires', label: t('components.deckgl.layers.fires'), icon: '&#128293;' },
      ]
      : SITE_VARIANT === 'finance'
      ? [
          { key: 'stockExchanges', label: t('components.deckgl.layers.stockExchanges'), icon: '&#127963;' },
          { key: 'financialCenters', label: t('components.deckgl.layers.financialCenters'), icon: '&#128176;' },
          { key: 'centralBanks', label: t('components.deckgl.layers.centralBanks'), icon: '&#127974;' },
          { key: 'commodityHubs', label: t('components.deckgl.layers.commodityHubs'), icon: '&#128230;' },
          { key: 'gulfInvestments', label: t('components.deckgl.layers.gulfInvestments'), icon: '&#127760;' },
          { key: 'cables', label: t('components.deckgl.layers.underseaCables'), icon: '&#128268;' },
          { key: 'pipelines', label: t('components.deckgl.layers.pipelines'), icon: '&#128738;' },
          { key: 'outages', label: t('components.deckgl.layers.internetOutages'), icon: '&#128225;' },
          { key: 'weather', label: t('components.deckgl.layers.weatherAlerts'), icon: '&#9928;' },
          { key: 'economic', label: t('components.deckgl.layers.economicCenters'), icon: '&#128176;' },
          { key: 'waterways', label: t('components.deckgl.layers.strategicWaterways'), icon: '&#9875;' },
          { key: 'natural', label: t('components.deckgl.layers.naturalEvents'), icon: '&#127755;' },
          { key: 'cyberThreats', label: t('components.deckgl.layers.cyberThreats'), icon: '&#128737;' },
        ]
      : [
        { key: 'hotspots', label: t('components.deckgl.layers.intelHotspots'), icon: '&#127919;' },
        { key: 'conflicts', label: t('components.deckgl.layers.conflictZones'), icon: '&#9876;' },
        { key: 'bases', label: t('components.deckgl.layers.militaryBases'), icon: '&#127963;' },
        { key: 'nuclear', label: t('components.deckgl.layers.nuclearSites'), icon: '&#9762;' },
        { key: 'irradiators', label: t('components.deckgl.layers.gammaIrradiators'), icon: '&#9888;' },
        { key: 'spaceports', label: t('components.deckgl.layers.spaceports'), icon: '&#128640;' },
        { key: 'cables', label: t('components.deckgl.layers.underseaCables'), icon: '&#128268;' },
        { key: 'pipelines', label: t('components.deckgl.layers.pipelines'), icon: '&#128738;' },
        { key: 'datacenters', label: t('components.deckgl.layers.aiDataCenters'), icon: '&#128421;' },
        { key: 'military', label: t('components.deckgl.layers.militaryActivity'), icon: '&#9992;' },
        { key: 'ais', label: t('components.deckgl.layers.shipTraffic'), icon: '&#128674;' },
        { key: 'flights', label: t('components.deckgl.layers.flightDelays'), icon: '&#9992;' },
        { key: 'protests', label: t('components.deckgl.layers.protests'), icon: '&#128226;' },
        { key: 'ucdpEvents', label: t('components.deckgl.layers.ucdpEvents'), icon: '&#9876;' },
        { key: 'displacement', label: t('components.deckgl.layers.displacementFlows'), icon: '&#128101;' },
        { key: 'climate', label: t('components.deckgl.layers.climateAnomalies'), icon: '&#127787;' },
        { key: 'weather', label: t('components.deckgl.layers.weatherAlerts'), icon: '&#9928;' },
        { key: 'outages', label: t('components.deckgl.layers.internetOutages'), icon: '&#128225;' },
        { key: 'cyberThreats', label: t('components.deckgl.layers.cyberThreats'), icon: '&#128737;' },
        { key: 'natural', label: t('components.deckgl.layers.naturalEvents'), icon: '&#127755;' },
        { key: 'fires', label: t('components.deckgl.layers.fires'), icon: '&#128293;' },
        { key: 'waterways', label: t('components.deckgl.layers.strategicWaterways'), icon: '&#9875;' },
        { key: 'economic', label: t('components.deckgl.layers.economicCenters'), icon: '&#128176;' },
        { key: 'minerals', label: t('components.deckgl.layers.criticalMinerals'), icon: '&#128142;' },
      ];

    toggles.innerHTML = `
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="layer-help-btn" title="${t('components.deckgl.layerGuide')}">?</button>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <div class="toggle-list" style="max-height: 32vh; overflow-y: auto; scrollbar-width: thin;">
        ${layerConfig.map(({ key, label, icon }) => `
          <label class="layer-toggle" data-layer="${key}">
            <input type="checkbox" ${this.state.layers[key as keyof MapLayers] ? 'checked' : ''}>
            <span class="toggle-icon">${icon}</span>
            <span class="toggle-label">${label}</span>
          </label>
        `).join('')}
      </div>
    `;

    this.container.appendChild(toggles);

    // Bind toggle events
    toggles.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers;
        if (layer) {
          this.state.layers[layer] = (input as HTMLInputElement).checked;
          this.render();
          this.onLayerChange?.(layer, (input as HTMLInputElement).checked);
        }
      });
    });

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
    collapseBtn?.addEventListener('click', () => {
      toggleList?.classList.toggle('collapsed');
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

    const techHelpContent = `
      <div class="layer-help-header">
        <span>Map Layers Guide</span>
        <button class="layer-help-close">×</button>
      </div>
      <div class="layer-help-content">
        <div class="layer-help-section">
          <div class="layer-help-title">Tech Ecosystem</div>
          <div class="layer-help-item"><span>STARTUPHUBS</span> Major startup ecosystems (SF, NYC, London, etc.)</div>
          <div class="layer-help-item"><span>CLOUDREGIONS</span> AWS, Azure, GCP data center regions</div>
          <div class="layer-help-item"><span>TECHHQS</span> Headquarters of major tech companies</div>
          <div class="layer-help-item"><span>ACCELERATORS</span> Y Combinator, Techstars, 500 Startups locations</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Infrastructure</div>
          <div class="layer-help-item"><span>CABLES</span> Major undersea fiber optic cables (internet backbone)</div>
          <div class="layer-help-item"><span>DATACENTERS</span> AI compute clusters ≥10,000 GPUs</div>
          <div class="layer-help-item"><span>OUTAGES</span> Internet blackouts and service disruptions</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Natural & Economic</div>
          <div class="layer-help-item"><span>NATURAL</span> Earthquakes, storms, fires (may affect data centers)</div>
          <div class="layer-help-item"><span>WEATHER</span> Severe weather alerts</div>
          <div class="layer-help-item"><span>ECONOMIC</span> Stock exchanges & central banks</div>
          <div class="layer-help-item"><span>COUNTRIES</span> Country name overlays</div>
        </div>
      </div>
    `;

    const financeHelpContent = `
      <div class="layer-help-header">
        <span>Map Layers Guide</span>
        <button class="layer-help-close">×</button>
      </div>
      <div class="layer-help-content">
        <div class="layer-help-section">
          <div class="layer-help-title">Finance Core</div>
          <div class="layer-help-item"><span>STOCKEXCHANGES</span> Major global exchanges by market tier</div>
          <div class="layer-help-item"><span>FINANCIALCENTERS</span> Global and regional finance hubs</div>
          <div class="layer-help-item"><span>CENTRALBANKS</span> Monetary policy institutions worldwide</div>
          <div class="layer-help-item"><span>COMMODITYHUBS</span> Key exchanges, ports, and refining hubs</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Infrastructure & Risk</div>
          <div class="layer-help-item"><span>CABLES</span> Major undersea fiber routes tied to market infrastructure</div>
          <div class="layer-help-item"><span>PIPELINES</span> Oil/gas pipeline routes affecting energy markets</div>
          <div class="layer-help-item"><span>OUTAGES</span> Internet disruptions that can impact market operations</div>
          <div class="layer-help-item"><span>CYBERTHREATS</span> Security events around financial infrastructure</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Macro Context</div>
          <div class="layer-help-item"><span>ECONOMIC</span> Major economic and financial centers</div>
          <div class="layer-help-item"><span>WATERWAYS</span> Strategic chokepoints for commodity shipping</div>
          <div class="layer-help-item"><span>WEATHER</span> Severe weather events with market relevance</div>
          <div class="layer-help-item"><span>NATURAL</span> Earthquakes, fires, floods, and other natural disruptions</div>
        </div>
      </div>
    `;

    const fullHelpContent = `
      <div class="layer-help-header">
        <span>Map Layers Guide</span>
        <button class="layer-help-close">×</button>
      </div>
      <div class="layer-help-content">
        <div class="layer-help-section">
          <div class="layer-help-title">Time Filter (top-right)</div>
          <div class="layer-help-item"><span>1H/6H/24H</span> Filter time-based data to recent hours</div>
          <div class="layer-help-item"><span>7D/30D/ALL</span> Show data from past week, month, or all time</div>
          <div class="layer-help-note">Affects: Earthquakes, Weather, Protests, Outages</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Geopolitical</div>
          <div class="layer-help-item"><span>CONFLICTS</span> Active war zones (Ukraine, Gaza, etc.) with boundaries</div>
          <div class="layer-help-item"><span>HOTSPOTS</span> Tension regions - color-coded by news activity level</div>
          <div class="layer-help-item"><span>SANCTIONS</span> Countries under US/EU/UN economic sanctions</div>
          <div class="layer-help-item"><span>PROTESTS</span> Civil unrest, demonstrations (time-filtered)</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Military & Strategic</div>
          <div class="layer-help-item"><span>BASES</span> US/NATO, China, Russia military installations (150+)</div>
          <div class="layer-help-item"><span>NUCLEAR</span> Power plants, enrichment, weapons facilities</div>
          <div class="layer-help-item"><span>IRRADIATORS</span> Industrial gamma irradiator facilities</div>
          <div class="layer-help-item"><span>MILITARY</span> Live military aircraft and vessel tracking</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Infrastructure</div>
          <div class="layer-help-item"><span>CABLES</span> Major undersea fiber optic cables (20 backbone routes)</div>
          <div class="layer-help-item"><span>PIPELINES</span> Oil/gas pipelines (Nord Stream, TAPI, etc.)</div>
          <div class="layer-help-item"><span>OUTAGES</span> Internet blackouts and disruptions</div>
          <div class="layer-help-item"><span>DATACENTERS</span> AI compute clusters ≥10,000 GPUs only</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Transport</div>
          <div class="layer-help-item"><span>SHIPPING</span> Vessels, chokepoints, 61 strategic ports</div>
          <div class="layer-help-item"><span>DELAYS</span> Airport delays and ground stops (FAA)</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Natural & Economic</div>
          <div class="layer-help-item"><span>NATURAL</span> Earthquakes (USGS) + storms, fires, volcanoes, floods (NASA EONET)</div>
          <div class="layer-help-item"><span>WEATHER</span> Severe weather alerts</div>
          <div class="layer-help-item"><span>ECONOMIC</span> Stock exchanges & central banks</div>
        </div>
        <div class="layer-help-section">
          <div class="layer-help-title">Labels</div>
          <div class="layer-help-item"><span>COUNTRIES</span> Country name overlays</div>
          <div class="layer-help-item"><span>WATERWAYS</span> Strategic chokepoint labels</div>
        </div>
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
    const legendItems = SITE_VARIANT === 'tech'
      ? [
          { shape: shapes.circle(isLight ? 'rgb(22, 163, 74)' : 'rgb(0, 255, 150)'), label: 'Startup Hub' },
          { shape: shapes.circle('rgb(100, 200, 255)'), label: 'Tech HQ' },
          { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 200, 0)'), label: 'Accelerator' },
          { shape: shapes.circle('rgb(150, 100, 255)'), label: 'Cloud Region' },
          { shape: shapes.square('rgb(136, 68, 255)'), label: 'Datacenter' },
        ]
      : SITE_VARIANT === 'finance'
      ? [
          { shape: shapes.circle('rgb(255, 215, 80)'), label: 'Stock Exchange' },
          { shape: shapes.circle('rgb(0, 220, 150)'), label: 'Financial Center' },
          { shape: shapes.hexagon('rgb(255, 210, 80)'), label: 'Central Bank' },
          { shape: shapes.square('rgb(255, 150, 80)'), label: 'Commodity Hub' },
          { shape: shapes.triangle('rgb(80, 170, 255)'), label: 'Waterway' },
        ]
      : [
          { shape: shapes.circle('rgb(255, 68, 68)'), label: 'High Alert' },
          { shape: shapes.circle('rgb(255, 165, 0)'), label: 'Elevated' },
          { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 255, 0)'), label: 'Monitoring' },
          { shape: shapes.triangle('rgb(68, 136, 255)'), label: 'Base' },
          { shape: shapes.hexagon(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 220, 0)'), label: 'Nuclear' },
          { shape: shapes.square('rgb(136, 68, 255)'), label: 'Datacenter' },
        ];

    legend.innerHTML = `
      <span class="legend-label-title">LEGEND</span>
      ${legendItems.map(({ shape, label }) => `<span class="legend-item">${shape}<span class="legend-label">${label}</span></span>`).join('')}
    `;

    this.container.appendChild(legend);
  }

  // Public API methods (matching MapComponent interface)
  public render(): void {
    if (this.renderPaused) {
      this.renderPending = true;
      return;
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;

    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.updateLayers();
    });
  }

  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;
    if (paused) {
      this.stopPulseAnimation();
      return;
    }

    this.syncPulseAnimation();
    if (!paused && this.renderPending) {
      this.renderPending = false;
      this.render();
    }
  }

  private updateLayers(): void {
    if (this.renderPaused) return;
    const startTime = performance.now();
    if (this.deckOverlay) {
      this.deckOverlay.setProps({ layers: this.buildLayers() });
    }
    const elapsed = performance.now() - startTime;
    if (import.meta.env.DEV && elapsed > 16) {
      console.warn(`[DeckGLMap] updateLayers took ${elapsed.toFixed(2)}ms (>16ms budget)`);
    }
  }

  public setView(view: DeckMapView): void {
    this.state.view = view;
    const preset = VIEW_PRESETS[view];

    if (this.maplibreMap) {
      this.maplibreMap.flyTo({
        center: [preset.longitude, preset.latitude],
        zoom: preset.zoom,
        duration: 1000,
      });
    }

    const viewSelect = this.container.querySelector('.view-select') as HTMLSelectElement;
    if (viewSelect) viewSelect.value = view;

    this.onStateChange?.(this.state);
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

  public getCenter(): { lat: number; lon: number } | null {
    if (this.maplibreMap) {
      const center = this.maplibreMap.getCenter();
      return { lat: center.lat, lon: center.lng };
    }
    return null;
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
    this.state.layers = layers;
    this.render(); // Debounced

    // Update toggle checkboxes
    Object.entries(layers).forEach(([key, value]) => {
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${key}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = value;
    });
  }

  public getState(): DeckMapState {
    return { ...this.state };
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

  // Data setters - all use render() for debouncing
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.render();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    const withCentroid = alerts.filter(a => a.centroid && a.centroid.length === 2).length;
    console.log(`[DeckGLMap] Weather alerts: ${alerts.length} total, ${withCentroid} with coordinates`);
    this.render();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.render();
  }

  public setCyberThreats(threats: CyberThreat[]): void {
    this.cyberThreats = threats;
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

  public setMilitaryFlights(flights: MilitaryFlight[], clusters: MilitaryFlightCluster[] = []): void {
    this.militaryFlights = flights;
    this.militaryFlightClusters = clusters;
    this.render();
  }

  public setMilitaryVessels(vessels: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    this.militaryVessels = vessels;
    this.militaryVesselClusters = clusters;
    this.render();
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
      this.hotspots.forEach(hotspot => {
        if (hotspot.keywords.some(kw =>
          item.title.toLowerCase().includes(kw.toLowerCase())
        )) {
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
    // High-priority conflict keywords that indicate the news is really about another topic
    const conflictTopics = ['gaza', 'ukraine', 'russia', 'israel', 'iran', 'china', 'taiwan', 'korea', 'syria'];

    return this.news
      .map((item) => {
        const titleLower = item.title.toLowerCase();
        const matchedKeywords = hotspot.keywords.filter((kw) => titleLower.includes(kw.toLowerCase()));

        if (matchedKeywords.length === 0) return null;

        // Check if this news mentions other hotspot conflict topics
        const conflictMatches = conflictTopics.filter(t =>
          titleLower.includes(t) && !hotspot.keywords.some(k => k.toLowerCase().includes(t))
        );

        // If article mentions a major conflict topic that isn't this hotspot, deprioritize heavily
        if (conflictMatches.length > 0) {
          // Only include if it ALSO has a strong local keyword (city name, agency)
          const strongLocalMatch = matchedKeywords.some(kw =>
            kw.toLowerCase() === hotspot.name.toLowerCase() ||
            hotspot.agencies?.some(a => titleLower.includes(a.toLowerCase()))
          );
          if (!strongLocalMatch) return null;
        }

        // Score: more keyword matches = more relevant
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
        this.highlightedAssets[asset.type].add(asset.id);
      });
    }

    this.render(); // Debounced
  }

  public setOnHotspotClick(callback: (hotspot: Hotspot) => void): void {
    this.onHotspotClick = callback;
  }

  public setOnTimeRangeChange(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean) => void): void {
    this.onLayerChange = callback;
  }

  public setOnStateChange(callback: (state: DeckMapState) => void): void {
    this.onStateChange = callback;
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

  // UI visibility methods
  public hideLayerToggle(layer: keyof MapLayers): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) (toggle as HTMLElement).style.display = 'none';
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
    // Temporarily highlight assets
    ids.forEach(id => this.highlightedAssets[assetType].add(id));
    this.render();

    setTimeout(() => {
      ids.forEach(id => this.highlightedAssets[assetType].delete(id));
      this.render();
    }, 3000);
  }

  // Enable layer programmatically
  public enableLayer(layer: keyof MapLayers): void {
    if (!this.state.layers[layer]) {
      this.state.layers[layer] = true;
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = true;
      this.render();
      this.onLayerChange?.(layer, true);
    }
  }

  // Toggle layer on/off programmatically
  public toggleLayer(layer: keyof MapLayers): void {
    console.log(`[DeckGLMap.toggleLayer] ${layer}: ${this.state.layers[layer]} -> ${!this.state.layers[layer]}`);
    this.state.layers[layer] = !this.state.layers[layer];
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
    if (toggle) toggle.checked = this.state.layers[layer];
    this.render();
    this.onLayerChange?.(layer, this.state.layers[layer]);
  }

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
    const base = MILITARY_BASES.find(b => b.id === id);
    if (base) {
      // Don't pan - show popup at projected screen position or center
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

  private resolveCountryFromCoordinate(lon: number, lat: number): { code: string; name: string } | null {
    const fromGeometry = getCountryAtCoordinates(lat, lon);
    if (fromGeometry) return fromGeometry;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return null;
    try {
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
            'fill-color': '#3b82f6',
            'fill-opacity': 0.06,
          },
          filter: ['==', ['get', 'name'], ''],
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
        this.updateCountryLayerPaint(getCurrentTheme());
        if (this.highlightedCountryCode) this.highlightCountry(this.highlightedCountryCode);
        console.log('[DeckGLMap] Country boundaries loaded');
      })
      .catch((err) => console.warn('[DeckGLMap] Failed to load country boundaries:', err));
  }

  private setupCountryHover(): void {
    if (!this.maplibreMap || this.countryHoverSetup) return;
    this.countryHoverSetup = true;
    const map = this.maplibreMap;
    let hoveredName: string | null = null;

    map.on('mousemove', (e) => {
      if (!this.onCountryClick) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['country-interactive'] });
      const name = features?.[0]?.properties?.name as string | undefined;

      if (name && name !== hoveredName) {
        hoveredName = name;
        map.setFilter('country-hover-fill', ['==', ['get', 'name'], name]);
        map.getCanvas().style.cursor = 'pointer';
      } else if (!name && hoveredName) {
        hoveredName = null;
        map.setFilter('country-hover-fill', ['==', ['get', 'name'], '']);
        map.getCanvas().style.cursor = '';
      }
    });

    map.on('mouseout', () => {
      if (hoveredName) {
        hoveredName = null;
        map.setFilter('country-hover-fill', ['==', ['get', 'name'], '']);
        map.getCanvas().style.cursor = '';
      }
    });
  }

  public highlightCountry(code: string): void {
    this.highlightedCountryCode = code;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    const filter: maplibregl.FilterSpecification = ['==', ['get', 'ISO3166-1-Alpha-2'], code];
    try {
      this.maplibreMap.setFilter('country-highlight-fill', filter);
      this.maplibreMap.setFilter('country-highlight-border', filter);
    } catch { /* layer not ready yet */ }
  }

  public clearCountryHighlight(): void {
    this.highlightedCountryCode = null;
    if (!this.maplibreMap) return;
    const noMatch: maplibregl.FilterSpecification = ['==', ['get', 'ISO3166-1-Alpha-2'], ''];
    try {
      this.maplibreMap.setFilter('country-highlight-fill', noMatch);
      this.maplibreMap.setFilter('country-highlight-border', noMatch);
    } catch { /* layer not ready */ }
  }

  private switchBasemap(theme: 'dark' | 'light'): void {
    if (!this.maplibreMap) return;
    this.maplibreMap.setStyle(theme === 'light' ? LIGHT_STYLE : DARK_STYLE);
    // setStyle() replaces all sources/layers — reset guard so country layers are re-added
    this.countryGeoJsonLoaded = false;
    this.maplibreMap.once('style.load', () => {
      this.loadCountryBoundaries();
    });
  }

  private updateCountryLayerPaint(theme: 'dark' | 'light'): void {
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    const hoverOpacity = theme === 'light' ? 0.10 : 0.06;
    const highlightOpacity = theme === 'light' ? 0.18 : 0.12;
    try {
      this.maplibreMap.setPaintProperty('country-hover-fill', 'fill-opacity', hoverOpacity);
      this.maplibreMap.setPaintProperty('country-highlight-fill', 'fill-opacity', highlightOpacity);
    } catch { /* layers may not be ready */ }
  }

  public destroy(): void {
    if (this.moveTimeoutId) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    this.stopPulseAnimation();

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.layerCache.clear();

    this.deckOverlay?.finalize();
    this.maplibreMap?.remove();

    this.container.innerHTML = '';
  }
}
