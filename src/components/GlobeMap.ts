/**
 * GlobeMap - 3D interactive globe using globe.gl
 *
 * Matches World Monitor's MapContainer API so it can be used as a drop-in
 * replacement within MapContainer when the user enables globe mode.
 *
 * Architecture mirrors Sentinel (sentinel.axonia.us):
 *  - globe.gl v2 (new Globe(element, config))
 *  - Earth texture: /textures/earth-topo-bathy.jpg
 *  - Night sky background: /textures/night-sky.png
 *  - Specular/water map: /textures/earth-water.png
 *  - Atmosphere: #4466cc glow via built-in Fresnel shader
 *  - All markers via htmlElementsData (single merged array with _kind discriminator)
 *  - Auto-rotate after 60 s of inactivity
 */

import Globe from 'globe.gl';
import { isDesktopRuntime } from '@/services/runtime';
import type { GlobeInstance, ConfigOptions } from 'globe.gl';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, MILITARY_BASES, NUCLEAR_FACILITIES, SPACEPORTS, ECONOMIC_CENTERS, STRATEGIC_WATERWAYS, CRITICAL_MINERALS, UNDERSEA_CABLES } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { t } from '@/services/i18n';
import { SITE_VARIANT } from '@/config/variant';
import { getGlobeRenderScale, resolveGlobePixelRatio, resolvePerformanceProfile, subscribeGlobeRenderScaleChange, getGlobeTexture, GLOBE_TEXTURE_URLS, subscribeGlobeTextureChange, getGlobeVisualPreset, subscribeGlobeVisualPresetChange, type GlobeRenderScale, type GlobePerformanceProfile, type GlobeVisualPreset } from '@/services/globe-render-settings';
import { getLayersForVariant, resolveLayerLabel, bindLayerSearch, type MapVariant } from '@/config/map-layer-definitions';
import { getSecretState } from '@/services/runtime-config';
import { resolveTradeRouteSegments, type TradeRouteSegment } from '@/config/trade-routes';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { getCountryBbox, getCountriesGeoJson, getCountryAtCoordinates, getCountryNameByCode } from '@/services/country-geometry';
import { escapeHtml } from '@/utils/sanitize';
import { showLayerWarning } from '@/utils/layer-warning';
import type { FeatureCollection, Geometry } from 'geojson';
import type { MapLayers, Hotspot, MilitaryFlight, MilitaryVessel, MilitaryVesselCluster, NaturalEvent, InternetOutage, CyberThreat, SocialUnrestEvent, UcdpGeoEvent, MilitaryBase, GammaIrradiator, Spaceport, EconomicCenter, StrategicWaterway, CriticalMineralProject, AIDataCenter, UnderseaCable, Pipeline, CableAdvisory, RepairShip, AisDisruptionEvent, AisDensityZone, AisDisruptionType } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { AirportDelayAlert } from '@/services/aviation';
import { MapPopup } from './MapPopup';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { WeatherAlert } from '@/services/weather';
import { type IranEvent, getIranEventHexColor } from '@/services/conflict';
import type { DisplacementFlow } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';
import type { SatellitePosition } from '@/services/satellites';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { getCategoryStyle } from '@/services/webcams';
import { pinWebcam, isPinned } from '@/services/webcams/pinned-store';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { RadiationObservation } from '@/services/radiation';

const SAT_COUNTRY_COLORS: Record<string, string> = { CN: '#ff2020', RU: '#ff8800', US: '#4488ff', EU: '#44cc44', KR: '#aa66ff', IN: '#ff66aa', TR: '#ff4466', OTHER: '#ccccff' };
const SAT_TYPE_EMOJI: Record<string, string> = { sar: '\u{1F4E1}', optical: '\u{1F4F7}', military: '\u{1F396}', sigint: '\u{1F4FB}' };
const SAT_TYPE_LABEL: Record<string, string> = { sar: 'SAR Imaging', optical: 'Optical Imaging', military: 'Military', sigint: 'SIGINT' };
const SAT_OPERATOR_NAME: Record<string, string> = { CN: 'China', RU: 'Russia', US: 'United States', EU: 'ESA / EU', KR: 'South Korea', IN: 'India', TR: 'Turkey', OTHER: 'Other' };

// ─── Marker discriminated union ─────────────────────────────────────────────
interface BaseMarker {
  _kind: string;
  _lat: number;
  _lng: number;
}
interface ConflictMarker extends BaseMarker {
  _kind: 'conflict';
  id: string;
  fatalities: number;
  eventType: string;
  location: string;
}
interface HotspotMarker extends BaseMarker {
  _kind: 'hotspot';
  id: string;
  name: string;
  escalationScore: number;
}
interface FlightMarker extends BaseMarker {
  _kind: 'flight';
  id: string;
  callsign: string;
  type: string;
  heading: number;
}
interface VesselMarker extends BaseMarker {
  _kind: 'vessel';
  id: string;
  name: string;
  type: string;       // raw enum key: 'carrier'|'destroyer' etc — color/icon lookup
  typeLabel: string;  // human-readable: 'Aircraft Carrier' etc — display only
  hullNumber?: string;
  operator?: string;
  operatorCountry?: string;
  isDark?: boolean;
  usniStrikeGroup?: string;
  usniRegion?: string;
  usniDeploymentStatus?: string;
  usniHomePort?: string;
  usniActivityDescription?: string;
  usniArticleDate?: string;
  usniSource?: boolean;
}
interface ClusterMarker extends BaseMarker {
  _kind: 'cluster';
  id: string;
  name: string;
  vesselCount: number;
  activityType?: string;
  region?: string;
}
interface WeatherMarker extends BaseMarker {
  _kind: 'weather';
  id: string;
  severity: string;
  headline: string;
}
interface NaturalMarker extends BaseMarker {
  _kind: 'natural';
  id: string;
  category: string;
  title: string;
}
interface IranMarker extends BaseMarker {
  _kind: 'iran';
  id: string;
  title: string;
  category: string;
  severity: string;
  location: string;
}
interface OutageMarker extends BaseMarker {
  _kind: 'outage';
  id: string;
  title: string;
  severity: string;
  country: string;
}
interface TrafficAnomalyMarker extends BaseMarker {
  _kind: 'trafficAnomaly';
  id: string;
  type: string;
  locationName: string;
}
interface DdosHitMarker extends BaseMarker {
  _kind: 'ddosHit';
  id: string;
  countryName: string;
  percentage: number;
}
interface CyberMarker extends BaseMarker {
  _kind: 'cyber';
  id: string;
  indicator: string;
  severity: string;
  type: string;
}
interface FireMarker extends BaseMarker {
  _kind: 'fire';
  id: string;
  region: string;
  brightness: number;
}
interface ProtestMarker extends BaseMarker {
  _kind: 'protest';
  id: string;
  title: string;
  eventType: string;
  country: string;
}
interface UcdpMarker extends BaseMarker {
  _kind: 'ucdp';
  id: string;
  sideA: string;
  sideB: string;
  deaths: number;
  country: string;
}
interface DisplacementMarker extends BaseMarker {
  _kind: 'displacement';
  id: string;
  origin: string;
  asylum: string;
  refugees: number;
}
interface ClimateMarker extends BaseMarker {
  _kind: 'climate';
  id: string;
  zone: string;
  type: string;
  severity: string;
  tempDelta: number;
}
interface GpsJamMarker extends BaseMarker {
  _kind: 'gpsjam';
  id: string;
  level: string;
  npAvg: number;
}
interface TechMarker extends BaseMarker {
  _kind: 'tech';
  id: string;
  title: string;
  country: string;
  daysUntil: number;
}
interface ConflictZoneMarker extends BaseMarker {
  _kind: 'conflictZone';
  id: string;
  name: string;
  intensity: string;
  parties: string[];
  casualties?: string;
}
interface MilBaseMarker extends BaseMarker {
  _kind: 'milbase';
  id: string;
  name: string;
  type: string;
  country: string;
}
interface NuclearSiteMarker extends BaseMarker {
  _kind: 'nuclearSite';
  id: string;
  name: string;
  type: string;
  status: string;
}
interface IrradiatorSiteMarker extends BaseMarker {
  _kind: 'irradiator';
  id: string;
  city: string;
  country: string;
}
interface SpaceportSiteMarker extends BaseMarker {
  _kind: 'spaceport';
  id: string;
  name: string;
  country: string;
  operator: string;
  launches: string;
}
interface EarthquakeMarker extends BaseMarker {
  _kind: 'earthquake';
  id: string;
  place: string;
  magnitude: number;
}
interface RadiationMarker extends BaseMarker {
  _kind: 'radiation';
  id: string;
  location: string;
  country: string;
  source: RadiationObservation['source'];
  contributingSources: RadiationObservation['contributingSources'];
  value: number;
  unit: string;
  observedAt: Date;
  freshness: RadiationObservation['freshness'];
  baselineValue: number;
  delta: number;
  zScore: number;
  severity: 'normal' | 'elevated' | 'spike';
  confidence: RadiationObservation['confidence'];
  corroborated: boolean;
  conflictingSources: boolean;
  convertedFromCpm: boolean;
  sourceCount: number;
}
interface EconomicMarker extends BaseMarker {
  _kind: 'economic';
  id: string;
  name: string;
  type: string;
  country: string;
  description: string;
}
interface DatacenterMarker extends BaseMarker {
  _kind: 'datacenter';
  id: string;
  name: string;
  owner: string;
  country: string;
  chipType: string;
}
interface WaterwayMarker extends BaseMarker {
  _kind: 'waterway';
  id: string;
  name: string;
  description: string;
}
interface MineralMarker extends BaseMarker {
  _kind: 'mineral';
  id: string;
  name: string;
  mineral: string;
  country: string;
  status: string;
}
interface FlightDelayMarker extends BaseMarker {
  _kind: 'flightDelay';
  id: string;
  iata: string;
  name: string;
  city: string;
  country: string;
  severity: string;
  delayType: string;
  avgDelayMinutes: number;
  reason: string;
}
interface NotamRingMarker extends BaseMarker {
  _kind: 'notamRing';
  name: string;
  reason: string;
}
interface NewsLocationMarker extends BaseMarker {
  _kind: 'newsLocation';
  id: string;
  title: string;
  threatLevel: string;
}
interface FlashMarker extends BaseMarker {
  _kind: 'flash';
  id: string;
}
interface CableAdvisoryMarker extends BaseMarker {
  _kind: 'cableAdvisory';
  id: string;
  cableId: string;
  title: string;
  severity: string;
  impact: string;
  repairEta: string;
}
interface RepairShipMarker extends BaseMarker {
  _kind: 'repairShip';
  id: string;
  name: string;
  status: string;
  eta: string;
  operator: string;
}
interface AisDisruptionMarker extends BaseMarker {
  _kind: 'aisDisruption';
  id: string;
  name: string;
  type: AisDisruptionType;
  severity: AisDisruptionEvent['severity'];
  description: string;
}
interface SatelliteMarker extends BaseMarker {
  _kind: 'satellite';
  id: string;
  name: string;
  country: string;
  type: string;
  alt: number;
  velocity: number;
  inclination: number;
}
interface SatFootprintMarker extends BaseMarker {
  _kind: 'satFootprint';
  country: string;
  noradId: string;
}
interface ImagerySceneMarker extends BaseMarker {
  _kind: 'imageryScene';
  satellite: string;
  datetime: string;
  resolutionM: number;
  mode: string;
  previewUrl: string;
}
interface WebcamMarkerData extends BaseMarker {
  _kind: 'webcam';
  webcamId: string;
  title: string;
  category: string;
  country: string;
}
interface WebcamClusterData extends BaseMarker {
  _kind: 'webcam-cluster';
  count: number;
  categories: string[];
}
interface GlobePath {
  id: string;
  name: string;
  points: number[][];
  pathType: 'cable' | 'oil' | 'gas' | 'products' | 'orbit' | 'stormTrack' | 'stormHistory';
  status: string;
  country?: string;
  windKt?: number;
}
interface GlobePolygon {
  coords: number[][][];
  name: string;
  _kind: 'cii' | 'conflict' | 'imageryFootprint' | 'forecastCone';
  level?: string;
  score?: number;

  intensity?: string;
  parties?: string[];
  casualties?: string;

  satellite?: string;
  datetime?: string;
  resolutionM?: number;
  mode?: string;
  previewUrl?: string;
}
type GlobeMarker =
  | ConflictMarker | HotspotMarker | FlightMarker | VesselMarker | ClusterMarker
  | WeatherMarker | NaturalMarker | IranMarker | OutageMarker | TrafficAnomalyMarker | DdosHitMarker
  | CyberMarker | FireMarker | ProtestMarker
  | UcdpMarker | DisplacementMarker | ClimateMarker | GpsJamMarker | TechMarker
  | ConflictZoneMarker | MilBaseMarker | NuclearSiteMarker | IrradiatorSiteMarker | SpaceportSiteMarker
  | EarthquakeMarker | RadiationMarker | EconomicMarker | DatacenterMarker | WaterwayMarker | MineralMarker
  | FlightDelayMarker | NotamRingMarker | CableAdvisoryMarker | RepairShipMarker | AisDisruptionMarker
  | NewsLocationMarker | FlashMarker | SatelliteMarker | SatFootprintMarker | ImagerySceneMarker
  | WebcamMarkerData | WebcamClusterData;

interface GlobeControlsLike {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enablePan: boolean;
  enableZoom: boolean;
  zoomSpeed: number;
  minDistance: number;
  maxDistance: number;
  enableDamping: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export class GlobeMap {
  private container: HTMLElement;
  private globe: GlobeInstance | null = null;
  private unsubscribeGlobeQuality: (() => void) | null = null;
  private unsubscribeGlobeTexture: (() => void) | null = null;
  private unsubscribeVisualPreset: (() => void) | null = null;
  private savedDefaultMaterial: any = null;
  private controls: GlobeControlsLike | null = null;
  private renderPaused = false;
  private outerGlow: any = null;
  private innerGlow: any = null;
  private starField: any = null;
  private cyanLight: any = null;
  private extrasAnimFrameId: number | null = null;
  private pendingFlushWhilePaused = false;
  private controlsAutoRotateBeforePause: boolean | null = null;
  private controlsDampingBeforePause: boolean | null = null;

  private initialized = false;
  private destroyed = false;
  private webglLost = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushMaxTimer: ReturnType<typeof setTimeout> | null = null;
  private _pulseEnabled = true;
  private reversedRingCache = new Map<string, number[][][]>();

  // Idle rendering: pause globe animation when nothing changes
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isGlobeAnimating = true;
  private visibilityHandler: (() => void) | null = null;

  // Current data
  private hotspots: HotspotMarker[] = [];
  private flights: FlightMarker[] = [];
  private vessels: VesselMarker[] = [];
  private vesselData: Map<string, MilitaryVessel> = new Map();
  private flightData: Map<string, MilitaryFlight> = new Map();
  private clusterMarkers: ClusterMarker[] = [];
  private clusterData: Map<string, MilitaryVesselCluster> = new Map();
  private popup: MapPopup | null = null;
  private weatherMarkers: WeatherMarker[] = [];
  private naturalMarkers: NaturalMarker[] = [];
  private iranMarkers: IranMarker[] = [];
  private outageMarkers: OutageMarker[] = [];
  private trafficAnomalyMarkers: TrafficAnomalyMarker[] = [];
  private ddosMarkers: DdosHitMarker[] = [];
  private cyberMarkers: CyberMarker[] = [];
  private fireMarkers: FireMarker[] = [];
  private protestMarkers: ProtestMarker[] = [];
  private ucdpMarkers: UcdpMarker[] = [];
  private displacementMarkers: DisplacementMarker[] = [];
  private climateMarkers: ClimateMarker[] = [];
  private gpsJamMarkers: GpsJamMarker[] = [];
  private techMarkers: TechMarker[] = [];
  private conflictZoneMarkers: ConflictZoneMarker[] = [];
  private milBaseMarkers: MilBaseMarker[] = [];
  private nuclearSiteMarkers: NuclearSiteMarker[] = [];
  private irradiatorSiteMarkers: IrradiatorSiteMarker[] = [];
  private spaceportSiteMarkers: SpaceportSiteMarker[] = [];
  private earthquakeMarkers: EarthquakeMarker[] = [];
  private radiationMarkers: RadiationMarker[] = [];
  private economicMarkers: EconomicMarker[] = [];
  private datacenterMarkers: DatacenterMarker[] = [];
  private waterwayMarkers: WaterwayMarker[] = [];
  private mineralMarkers: MineralMarker[] = [];
  private flightDelayMarkers: FlightDelayMarker[] = [];
  private notamRingMarkers: NotamRingMarker[] = [];
  private newsLocationMarkers: NewsLocationMarker[] = [];
  private flashMarkers: FlashMarker[] = [];
  private cableAdvisoryMarkers: CableAdvisoryMarker[] = [];
  private repairShipMarkers: RepairShipMarker[] = [];
  private aisMarkers: AisDisruptionMarker[] = [];
  private satelliteMarkers: SatelliteMarker[] = [];
  private satelliteTrailPaths: GlobePath[] = [];
  private stormTrackPaths: GlobePath[] = [];
  private stormConePolygons: GlobePolygon[] = [];
  private satelliteFootprintMarkers: SatFootprintMarker[] = [];
  private imagerySceneMarkers: ImagerySceneMarker[] = [];
  private webcamMarkers: (WebcamMarkerData | WebcamClusterData)[] = [];
  private webcamMarkerMode: string = localStorage.getItem('wm-webcam-marker-mode') || 'icon';
  private imageryFootprintPolygons: GlobePolygon[] = [];
  private lastImageryCenter: { lat: number; lon: number } | null = null;
  private imageryFetchTimer: ReturnType<typeof setTimeout> | null = null;
  private imageryFetchVersion = 0;
  private controlsEndHandler: (() => void) | null = null;
  private satBeamGroup: any = null;
  private tradeRouteSegments: TradeRouteSegment[] = [];
  private globePaths: GlobePath[] = [];
  private cableFaultIds = new Set<string>();
  private cableDegradedIds = new Set<string>();
  private ciiScoresMap: Map<string, { score: number; level: string }> = new Map();
  private countriesGeoData: FeatureCollection<Geometry> | null = null;

  // Current layers state
  private layers: MapLayers;
  private timeRange: TimeRange;
  private currentView: MapView = 'global';

  // Click callbacks
  private onHotspotClickCb: ((h: Hotspot) => void) | null = null;

  // Auto-rotate timer (like Sentinel: resume after 60 s idle)
  private autoRotateTimer: ReturnType<typeof setTimeout> | null = null;

  // Overlay UI elements
  private layerTogglesEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;
  private tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  private satHoverStyle: HTMLStyleElement | null = null;

  // Callbacks
  private onLayerChangeCb: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;
  private onMapContextMenuCb?: (payload: { lat: number; lon: number; screenX: number; screenY: number }) => void;
  private readonly handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!this.onMapContextMenuCb || !this.globe) return;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const coords = this.globe.toGlobeCoords(x, y);
    if (!coords) return;
    this.onMapContextMenuCb({ lat: coords.lat, lon: coords.lng, screenX: e.clientX, screenY: e.clientY });
  };

  constructor(container: HTMLElement, initialState: MapContainerState) {
    this.container = container;
    this.popup = new MapPopup(this.container);
    this.layers = { ...initialState.layers };
    this.timeRange = initialState.timeRange;
    this.currentView = initialState.view;

    this.container.classList.add('globe-mode');
    this.container.style.cssText = 'width:100%;height:100%;background:#000;position:relative;';

    this.initGlobe().catch(err => {
      console.error('[GlobeMap] Init failed:', err);
    });
  }

  private async initGlobe(): Promise<void> {
    if (this.destroyed) return;

    const desktop = isDesktopRuntime();
    const initialScale = getGlobeRenderScale();
    const initialPixelRatio = desktop
      ? Math.min(resolveGlobePixelRatio(initialScale), 1.25)
      : resolveGlobePixelRatio(initialScale);
    const config: ConfigOptions = {
      animateIn: false,
      rendererConfig: {
        // Desktop (Tauri/WebView2) can fall back to software rendering on some machines.
        // Keep defaults conservative to avoid 1fps reports (see #930).
        powerPreference: desktop ? 'high-performance' : 'default',
        logarithmicDepthBuffer: !desktop,
        antialias: initialPixelRatio > 1,
      },
    };

    const globe = new Globe(this.container, config) as GlobeInstance;

    if (this.destroyed) {
      globe._destructor();
      return;
    }

    const satStyle = document.createElement('style');
    satStyle.textContent = `.sat-hit:hover .sat-dot { transform: scale(2.5); box-shadow: 0 0 10px 4px currentColor; }`;
    document.head.appendChild(satStyle);
    this.satHoverStyle = satStyle;

    this.unsubscribeGlobeQuality?.();
    this.unsubscribeGlobeQuality = subscribeGlobeRenderScaleChange((scale) => {
      this.applyRenderQuality(scale);
      this.applyPerformanceProfile(resolvePerformanceProfile(scale));
    });

    // Initial sizing: use container dimensions, fall back to window if not yet laid out
    const initW = this.container.clientWidth || window.innerWidth;
    const initH = this.container.clientHeight || window.innerHeight;

    const initialTexture = getGlobeTexture();
    globe
      .globeImageUrl(GLOBE_TEXTURE_URLS[initialTexture])
      .backgroundImageUrl('')
      .atmosphereColor('#4466cc')
      .atmosphereAltitude(0.18)
      .width(initW)
      .height(initH)
      .pathTransitionDuration(0);

    // Orbit controls — match Sentinel's settings
    const controls = globe.controls() as GlobeControlsLike;
    this.controls = controls;
    controls.autoRotate = !desktop;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.zoomSpeed = 1.4;
    controls.minDistance = 101;
    controls.maxDistance = 600;
    controls.enableDamping = !desktop;

    this.controlsEndHandler = () => {
      if (!this.layers.satellites) return;
      if (this.imageryFetchTimer) clearTimeout(this.imageryFetchTimer);
      this.imageryFetchTimer = setTimeout(() => this.fetchImageryForViewport(), 800);
    };
    controls.addEventListener('end', this.controlsEndHandler);

    // Force the canvas to visually fill the container so it expands with CSS transitions.
    // globe.gl sets explicit width/height attributes; we override the CSS so the canvas
    // always covers the full container even before the next renderer resize fires.
    const glCanvas = this.container.querySelector('canvas');
    if (glCanvas) {
      (glCanvas as HTMLElement).style.cssText =
        'position:absolute;top:0;left:0;width:100% !important;height:100% !important;';
    }

    // Globe attribution (texture + OpenStreetMap data)
    const attribution = document.createElement('div');
    attribution.className = 'map-attribution';
    attribution.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> © <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>';
    this.container.appendChild(attribution);

    // Upgrade material to MeshStandardMaterial + add scene enhancements
    // Save default material for classic preset restoration
    this.savedDefaultMaterial = globe.globeMaterial();

    // Apply visual enhancements based on preset
    const initialPreset = getGlobeVisualPreset();
    if (initialPreset === 'enhanced') {
      setTimeout(() => this.applyEnhancedVisuals(), 800);
    }

    this.unsubscribeVisualPreset = subscribeGlobeVisualPresetChange((preset) => {
      this.applyVisualPreset(preset);
    });

    // Subscribe to texture changes (kept as-is)
    this.unsubscribeGlobeTexture = subscribeGlobeTextureChange((texture) => {
      if (this.globe) this.globe.globeImageUrl(GLOBE_TEXTURE_URLS[texture]);
    });

    // Pause auto-rotate on user interaction; resume after 60 s idle (like Sentinel)
    const pauseAutoRotate = () => {
      if (this.renderPaused) return;
      controls.autoRotate = false;
      if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    };
    const scheduleResumeAutoRotate = () => {
      if (this.renderPaused) return;
      if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
      this.autoRotateTimer = setTimeout(() => {
        if (!this.renderPaused) controls.autoRotate = !desktop;
      }, 60_000);
    };

    const canvas = this.container.querySelector('canvas');
    if (canvas) {
      // Wake globe on any user interaction (idle rendering optimization)
      const wakeOnInteraction = () => this.wakeGlobe();
      canvas.addEventListener('mousedown', () => { pauseAutoRotate(); wakeOnInteraction(); });
      canvas.addEventListener('touchstart', () => { pauseAutoRotate(); wakeOnInteraction(); }, { passive: true });
      canvas.addEventListener('wheel', wakeOnInteraction, { passive: true });
      let lastMoveWake = 0;
      canvas.addEventListener('mousemove', () => {
        const now = performance.now();
        if (now - lastMoveWake > 500) { lastMoveWake = now; wakeOnInteraction(); }
      }, { passive: true });
      canvas.addEventListener('mouseup', scheduleResumeAutoRotate);
      canvas.addEventListener('touchend', scheduleResumeAutoRotate);
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.webglLost = true;
        console.warn('[GlobeMap] WebGL context lost — will restore when browser recovers');
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.webglLost = false;
        console.info('[GlobeMap] WebGL context restored');
        this.flushMarkers();
      });
    }

    this.container.addEventListener('contextmenu', this.handleContextMenu);

    // Wire HTML marker layer
    globe
      .htmlElementsData([])
      .htmlLat((d: object) => (d as GlobeMarker)._lat)
      .htmlLng((d: object) => (d as GlobeMarker)._lng)
      .htmlAltitude((d: object) => {
        const m = d as GlobeMarker;
        if (m._kind === 'satFootprint') return 0;
        if (m._kind === 'satellite') return (m as SatelliteMarker).alt / 6371;
        if (m._kind === 'flight' || m._kind === 'vessel' || m._kind === 'cluster') return 0.012;
        if (m._kind === 'hotspot') return 0.005;
        return 0.003;
      })
      .htmlElement((d: object) => this.buildMarkerElement(d as GlobeMarker));

    // Arc accessors — set once, only data changes on flush

    (globe as any)
      .arcStartLat((d: TradeRouteSegment) => d.sourcePosition[1])
      .arcStartLng((d: TradeRouteSegment) => d.sourcePosition[0])
      .arcEndLat((d: TradeRouteSegment) => d.targetPosition[1])
      .arcEndLng((d: TradeRouteSegment) => d.targetPosition[0])
      .arcColor((d: TradeRouteSegment) => {
        if (d.status === 'disrupted') return ['rgba(255,32,32,0.1)', 'rgba(255,32,32,0.8)', 'rgba(255,32,32,0.1)'];
        if (d.status === 'high_risk') return ['rgba(255,180,0,0.1)', 'rgba(255,180,0,0.7)', 'rgba(255,180,0,0.1)'];
        if (d.category === 'energy')    return ['rgba(255,140,0,0.05)', 'rgba(255,140,0,0.6)', 'rgba(255,140,0,0.05)'];
        if (d.category === 'container') return ['rgba(68,136,255,0.05)', 'rgba(68,136,255,0.6)', 'rgba(68,136,255,0.05)'];
        return ['rgba(68,204,136,0.05)', 'rgba(68,204,136,0.6)', 'rgba(68,204,136,0.05)'];
      })
      .arcAltitudeAutoScale(0.3)
      .arcStroke(0.5)
      .arcDashLength(0.9)
      .arcDashGap(4)
      .arcDashAnimateTime(5000)
      .arcLabel((d: TradeRouteSegment) => `${d.routeName} · ${d.volumeDesc}`);

    // Path accessors — set once
    (globe as any)
      .pathPoints((d: GlobePath) => d?.points ?? [])
      .pathPointLat((p: number[]) => p[1])
      .pathPointLng((p: number[]) => p[0])
      .pathPointAlt((p: number[], _idx: number, path: object) =>
        (path as GlobePath)?.pathType === 'orbit' && p.length > 2 ? (p[2] ?? 0) / 6371 : 0
      )
      .pathColor((d: GlobePath) => {
        if (!d) return 'rgba(180,160,255,0.6)';
        if (d.pathType === 'orbit') {
          const colors: Record<string, string> = { CN: 'rgba(255,32,32,0.4)', RU: 'rgba(255,136,0,0.4)', US: 'rgba(68,136,255,0.4)', EU: 'rgba(68,204,68,0.4)' };
          return colors[d.country || ''] || 'rgba(200,200,255,0.3)';
        }
        if (d.pathType === 'cable') {
          if (this.cableFaultIds.has(d.id))    return '#ff3030';
          if (this.cableDegradedIds.has(d.id)) return '#ff8800';
          return 'rgba(0,200,255,0.65)';
        }
        if (d.pathType === 'oil')   return 'rgba(255,140,0,0.6)';
        if (d.pathType === 'gas')   return 'rgba(80,220,120,0.6)';
        if (d.pathType === 'stormTrack') return 'rgba(255,100,100,0.8)';
        if (d.pathType === 'stormHistory') {
          const w = d.windKt || 0;
          if (w >= 137) return 'rgba(255,96,96,0.8)';
          if (w >= 96) return 'rgba(255,140,0,0.8)';
          if (w >= 64) return 'rgba(255,231,117,0.8)';
          if (w >= 34) return 'rgba(94,186,255,0.8)';
          return 'rgba(160,160,160,0.6)';
        }
        return 'rgba(180,160,255,0.6)';
      })
      .pathStroke((d: GlobePath) => {
        if (!d) return 0.6;
        if (d.pathType === 'orbit') return 0.3;
        if (d.pathType === 'cable') return 0.3;
        if (d.pathType === 'stormTrack' || d.pathType === 'stormHistory') return 1.2;
        return 0.6;
      })
      .pathDashLength((d: GlobePath) => {
        if (!d) return 0.6;
        if (d.pathType === 'orbit') return 0.4;
        if (d.pathType === 'cable') return 1;
        if (d.pathType === 'stormTrack') return 0.8;
        if (d.pathType === 'stormHistory') return 1;
        return 0.6;
      })
      .pathDashGap((d: GlobePath) => {
        if (!d) return 0.25;
        if (d.pathType === 'orbit') return 0.15;
        if (d.pathType === 'cable') return 0;
        if (d.pathType === 'stormTrack') return 0.4;
        if (d.pathType === 'stormHistory') return 0;
        return 0.25;
      })
      .pathDashAnimateTime((d: GlobePath) => {
        if (!d) return 5000;
        if (d.pathType === 'orbit') return 0;
        if (d.pathType === 'cable') return 0;
        if (d.pathType === 'stormTrack') return 3000;
        if (d.pathType === 'stormHistory') return 0;
        return 5000;
      })
      .pathLabel((d: GlobePath) => d?.name ?? '');

    // Polygon accessors — set once
    (globe as any)
      .polygonGeoJsonGeometry((d: GlobePolygon) => ({ type: 'Polygon', coordinates: d.coords }))
      .polygonCapColor((d: GlobePolygon) => {
        if (d._kind === 'cii') return GlobeMap.CII_GLOBE_COLORS[d.level!] ?? 'rgba(0,0,0,0)';
        if (d._kind === 'conflict') return GlobeMap.CONFLICT_CAP[d.intensity!] ?? GlobeMap.CONFLICT_CAP.low;
        if (d._kind === 'imageryFootprint') return 'rgba(0,0,0,0)';
        if (d._kind === 'forecastCone') return 'rgba(255,140,60,0.2)';
        return 'rgba(255,60,60,0.15)';
      })
      .polygonSideColor((d: GlobePolygon) => {
        if (d._kind === 'cii') return 'rgba(0,0,0,0)';
        if (d._kind === 'conflict') return GlobeMap.CONFLICT_SIDE[d.intensity!] ?? GlobeMap.CONFLICT_SIDE.low;
        if (d._kind === 'imageryFootprint') return 'rgba(0,0,0,0)';
        if (d._kind === 'forecastCone') return 'rgba(255,140,60,0.1)';
        return 'rgba(255,60,60,0.08)';
      })
      .polygonStrokeColor((d: GlobePolygon) => {
        if (d._kind === 'cii') return 'rgba(80,80,80,0.3)';
        if (d._kind === 'conflict') return GlobeMap.CONFLICT_STROKE[d.intensity!] ?? GlobeMap.CONFLICT_STROKE.low;
        if (d._kind === 'imageryFootprint') return '#00b4ff';
        if (d._kind === 'forecastCone') return 'rgba(255,140,60,0.5)';
        return '#ff4444';
      })
      .polygonAltitude((d: GlobePolygon) => {
        if (d._kind === 'cii') return 0.002;
        if (d._kind === 'conflict') return GlobeMap.CONFLICT_ALT[d.intensity!] ?? GlobeMap.CONFLICT_ALT.low;
        return 0.005;
      })
      .polygonLabel((d: GlobePolygon) => {
        if (d._kind === 'cii') return `<b>${escapeHtml(d.name)}</b><br/>CII: ${d.score}/100 (${escapeHtml(d.level ?? '')})`;
        if (d._kind === 'conflict') {
          let label = `<b>${escapeHtml(d.name)}</b>`;
          if (d.parties?.length) label += `<br/>Parties: ${d.parties.map(p => escapeHtml(p)).join(', ')}`;
          if (d.casualties) label += `<br/>Casualties: ${escapeHtml(d.casualties)}`;
          return label;
        }
        if (d._kind === 'imageryFootprint') {
          let label = `<span style="color:#00b4ff;font-weight:bold;">&#128752; ${escapeHtml(d.satellite ?? '')}</span>`;
          if (d.datetime) label += `<br><span style="opacity:.7;">${escapeHtml(d.datetime)}</span>`;
          if (d.resolutionM != null || d.mode) {
            const parts: string[] = [];
            if (d.resolutionM != null) parts.push(`${d.resolutionM}m`);
            if (d.mode) parts.push(escapeHtml(d.mode));
            label += `<br><span style="opacity:.5;">Res: ${parts.join(' \u00B7 ')}</span>`;
          }
          if (isAllowedPreviewUrl(d.previewUrl)) {
            const safeHref = escapeHtml(new URL(d.previewUrl!).href);
            label += `<br><img src="${safeHref}" referrerpolicy="no-referrer" style="max-width:180px;max-height:120px;margin-top:4px;border-radius:4px;" class="imagery-preview">`;
          }
          return label;
        }
        return escapeHtml(d.name);
      });

    this.globe = globe;
    this.initialized = true;

    // Apply initial render quality + performance profile
    this.applyRenderQuality(initialScale);
    this.applyPerformanceProfile(resolvePerformanceProfile(initialScale));

    // Add overlay UI (zoom controls + layer panel)
    this.createControls();
    this.createLayerToggles();

    // Load static datasets
    this.setHotspots(INTEL_HOTSPOTS);
    this.initStaticLayers();
    this.setConflictZones();

    // Navigate to initial view
    this.setView(this.currentView);

    this.layers.dayNight = false;
    this.hideLayerToggle('dayNight');

    // Flush any data that arrived before init completed
    this.flushMarkers();
    this.flushArcs();
    this.flushPaths();
    this.flushPolygons();

    // Initial imagery fetch if satellites layer is already enabled
    if (this.layers.satellites) {
      this.fetchImageryForViewport();
    }

    // Idle rendering: pause animation when nothing is happening
    this.setupVisibilityHandler();
    this.scheduleIdlePause();

    // Load countries GeoJSON for CII choropleth
    getCountriesGeoJson().then(geojson => {
      if (geojson && !this.destroyed) {
        this.countriesGeoData = geojson;
        this.reversedRingCache.clear();
        this.flushPolygons();
      }
    }).catch(err => { if (import.meta.env.DEV) console.warn('[GlobeMap] Failed to load countries GeoJSON', err); });
  }

  // ─── Marker element builder ────────────────────────────────────────────────

  private pulseStyle(duration: string): string {
    return this._pulseEnabled ? `animation:globe-pulse ${duration} ease-out infinite;` : 'animation:none;';
  }

  /** Wrap marker content in an invisible 20×20px hit target for easier clicking on the globe. */
  private static wrapHit(inner: string): string {
    return `<div style="width:20px;height:20px;display:flex;align-items:center;justify-content:center">${inner}</div>`;
  }

  private buildMarkerElement(d: GlobeMarker): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'pointer-events:auto;cursor:pointer;user-select:none;';

    if (d._kind === 'conflict') {
      const size = Math.min(12, 6 + (d.fatalities ?? 0) * 0.4);
      el.innerHTML = GlobeMap.wrapHit(`
        <div style="position:relative;width:${size}px;height:${size}px;">
          <div style="
            position:absolute;inset:0;border-radius:50%;
            background:rgba(255,50,50,0.85);
            border:1.5px solid rgba(255,120,120,0.9);
            box-shadow:0 0 6px 2px rgba(255,50,50,0.5);
          "></div>
          <div style="
            position:absolute;inset:-4px;border-radius:50%;
            background:rgba(255,50,50,0.2);
            ${this.pulseStyle('2s')}
          "></div>
        </div>`);
      el.title = `${d.location}`;
    } else if (d._kind === 'hotspot') {
      const colors: Record<number, string> = { 5: '#ff2020', 4: '#ff6600', 3: '#ffaa00', 2: '#ffdd00', 1: '#88ff44' };
      const c = colors[d.escalationScore] ?? '#ffaa00';
      el.innerHTML = GlobeMap.wrapHit(`
        <div style="
          width:10px;height:10px;
          background:${c};
          border:1.5px solid rgba(255,255,255,0.6);
          clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);
          box-shadow:0 0 8px 2px ${c}88;
        "></div>`);
      el.title = d.name;
    } else if (d._kind === 'flight') {
      const heading = d.heading ?? 0;
      const color = GlobeMap.FLIGHT_TYPE_COLORS[d.type] ?? '#cccccc';
      el.innerHTML = GlobeMap.wrapHit(`
        <div style="transform:rotate(${heading}deg);font-size:11px;color:${color};text-shadow:0 0 4px ${color}88;line-height:1;">
          ✈
        </div>`);
      el.title = `${d.callsign} (${d.type})`;
    } else if (d._kind === 'vessel') {
      const c = GlobeMap.VESSEL_TYPE_COLORS[d.type] ?? '#44aaff';
      const icon = GlobeMap.VESSEL_TYPE_ICONS[d.type] ?? '\u26f4';
      const isCarrier = d.type === 'carrier';
      const sz = isCarrier ? 15 : 10;
      const glow = isCarrier ? `0 0 10px 4px ${c}bb` : `0 0 4px ${c}88`;
      const darkRing = d.isDark
        ? `<div style="position:absolute;inset:-6px;border-radius:50%;border:2px solid #ff444499;${this.pulseStyle('1.5s')}"></div>`
        : '';
      const usniRing = d.usniSource
        ? `<div style="position:absolute;inset:-4px;border-radius:50%;border:2px dashed #ffaa4466;"></div>`
        : '';
      el.innerHTML = GlobeMap.wrapHit(
        `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;">` +
        darkRing +
        usniRing +
        `<div style="font-size:${sz}px;color:${c};text-shadow:${glow};line-height:1;${d.usniSource ? 'opacity:0.8;' : ''}">${icon}</div>` +
        `</div>`
      );
      el.title = `${d.name}${d.hullNumber ? ` (${d.hullNumber})` : ''} \u00b7 ${d.typeLabel} \u00b7 ${d.usniSource ? 'EST. POSITION' : 'AIS LIVE'}`;
    } else if (d._kind === 'cluster') {
      const cc = GlobeMap.CLUSTER_ACTIVITY_COLORS[d.activityType ?? 'unknown'] ?? '#6688aa';
      const sz = Math.max(14, Math.min(26, 12 + d.vesselCount * 2));
      el.innerHTML = GlobeMap.wrapHit(
        `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:${sz}px;height:${sz}px;">` +
        `<div style="position:absolute;inset:0;border-radius:50%;background:${cc}22;border:2px solid ${cc}bb;${this.pulseStyle('2.5s')}"></div>` +
        `<span style="position:relative;font-size:9px;color:${cc};font-weight:bold;line-height:1;">${d.vesselCount}</span>` +
        `</div>`
      );
      el.title = `${d.name} \u00b7 ${d.vesselCount} vessel${d.vesselCount !== 1 ? 's' : ''}`;
    } else if (d._kind === 'weather') {
      const severityColors: Record<string, string> = {
        Extreme: '#ff0044', Severe: '#ff6600', Moderate: '#ffaa00', Minor: '#88aaff',
      };
      const c = severityColors[d.severity] ?? '#88aaff';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:9px;color:${c};text-shadow:0 0 4px ${c}88;font-weight:bold;">⚡</div>`);
      el.title = d.headline;
    } else if (d._kind === 'radiation') {
      const c = d.severity === 'spike' ? '#ff3030' : '#ffaa00';
      const ring = d.severity === 'spike'
        ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:2px solid ${c}66;${this.pulseStyle('1.8s')}"></div>`
        : '';
      const confirmRing = d.corroborated
        ? '<div style="position:absolute;inset:-9px;border-radius:50%;border:1px dashed #7dd3fc88;"></div>'
        : '';
      el.innerHTML = GlobeMap.wrapHit(
        `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;">${ring}${confirmRing}<div style="font-size:11px;color:${c};text-shadow:0 0 5px ${c}88;opacity:${d.confidence === 'low' ? 0.75 : 1};">☢</div></div>`
      );
      el.title = `${d.location} · ${d.severity} · ${d.confidence}`;
    } else if (d._kind === 'natural') {
      const typeIcons: Record<string, string> = {
        earthquakes: '〽', volcanoes: '🌋', severeStorms: '🌀',
        floods: '💧', wildfires: '🔥', drought: '☀',
      };
      const icon = typeIcons[d.category] ?? '⚠';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;">${icon}</div>`);
      el.title = d.title;
    } else if (d._kind === 'iran') {
      const sc = getIranEventHexColor(d);
      el.innerHTML = GlobeMap.wrapHit(`
        <div style="position:relative;width:9px;height:9px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${sc};border:1.5px solid rgba(255,255,255,0.5);box-shadow:0 0 5px 2px ${sc}88;"></div>
          <div style="position:absolute;inset:-4px;border-radius:50%;background:${sc}33;${this.pulseStyle('2s')}"></div>
        </div>`);
      el.title = d.title;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:12px;color:${sc};text-shadow:0 0 4px ${sc}88;">📡</div>`);
      el.title = `${d.country}: ${d.title}`;
    } else if (d._kind === 'trafficAnomaly') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#ffa000;text-shadow:0 0 4px #ffa00088;font-weight:bold;">⚡</div>`);
      el.title = `${d.type || 'Traffic Anomaly'}: ${d.locationName}`;
    } else if (d._kind === 'ddosHit') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#b400ff;text-shadow:0 0 4px #b400ff88;font-weight:bold;">⚔</div>`);
      el.title = `DDoS: ${d.countryName} (${d.percentage.toFixed(1)}%)`;
    } else if (d._kind === 'cyber') {
      const sc = d.severity === 'critical' ? '#ff0044' : d.severity === 'high' ? '#ff4400' : d.severity === 'medium' ? '#ffaa00' : '#44aaff';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:${sc};text-shadow:0 0 4px ${sc}88;font-weight:bold;">🛡</div>`);
      el.title = `${d.type}: ${d.indicator}`;
    } else if (d._kind === 'fire') {
      const intensity = d.brightness > 400 ? '#ff2020' : d.brightness > 330 ? '#ff6600' : '#ffaa00';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:${intensity};text-shadow:0 0 4px ${intensity}88;">🔥</div>`);
      el.title = `Fire — ${d.region}`;
    } else if (d._kind === 'protest') {
      const typeColors: Record<string, string> = {
        riot: '#ff3030', protest: '#ffaa00', strike: '#44aaff',
        demonstration: '#88ff44', civil_unrest: '#ff6600',
      };
      const c = typeColors[d.eventType] ?? '#ffaa00';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:${c};text-shadow:0 0 4px ${c}88;">📢</div>`);
      el.title = d.title;
    } else if (d._kind === 'ucdp') {
      const size = Math.min(10, 5 + (d.deaths || 0) * 0.3);
      el.innerHTML = GlobeMap.wrapHit(`
        <div style="position:relative;width:${size}px;height:${size}px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:rgba(255,100,0,0.85);border:1.5px solid rgba(255,160,80,0.9);box-shadow:0 0 5px 2px rgba(255,100,0,0.5);"></div>
        </div>`);
      el.title = `${d.sideA} vs ${d.sideB}`;
    } else if (d._kind === 'displacement') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:#88bbff;text-shadow:0 0 4px #88bbff88;">👥</div>`);
      el.title = `${d.origin} → ${d.asylum}`;
    } else if (d._kind === 'climate') {
      const typeColors: Record<string, string> = { warm: '#ff4400', cold: '#44aaff', wet: '#00ccff', dry: '#ff8800', mixed: '#88ff88' };
      const c = typeColors[d.type] ?? '#88ff88';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:${c};text-shadow:0 0 4px ${c}88;">🌡</div>`);
      el.title = `${d.zone} (${d.type})`;
    } else if (d._kind === 'gpsjam') {
      const c = d.level === 'high' ? '#ff2020' : '#ff8800';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:${c};text-shadow:0 0 4px ${c}88;">📡</div>`);
      el.title = `GPS Jamming (${d.level})`;
    } else if (d._kind === 'tech') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#44aaff;text-shadow:0 0 4px #44aaff88;">💻</div>`);
      el.title = d.title;
    } else if (d._kind === 'conflictZone') {
      const intColor = d.intensity === 'high' ? '#ff2020' : d.intensity === 'medium' ? '#ff8800' : '#ffcc00';
      el.innerHTML = `
        <div style="position:relative;width:20px;height:20px;">
          <div style="
            position:absolute;inset:0;border-radius:50%;
            background:${intColor}33;
            border:1.5px solid ${intColor}99;
            box-shadow:0 0 6px 2px ${intColor}44;
          "></div>
          <div style="
            position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
            font-size:9px;line-height:1;color:${intColor};
          ">⚔</div>
        </div>`;
      el.title = d.name;
    } else if (d._kind === 'milbase') {
      const typeColors: Record<string, string> = {
        'us-nato': '#4488ff', uk: '#4488ff', france: '#4488ff',
        russia: '#ff4444', china: '#ff8844', india: '#ff8844',
        other: '#aaaaaa',
      };
      const c = typeColors[d.type] ?? '#aaaaaa';
      el.innerHTML = GlobeMap.wrapHit(`
        <div style="
          width:0;height:0;
          border-left:5px solid transparent;
          border-right:5px solid transparent;
          border-bottom:9px solid ${c};
          filter:drop-shadow(0 0 3px ${c}88);
        "></div>`);
      el.title = `${d.name}${d.country ? ' · ' + d.country : ''}`;
    } else if (d._kind === 'nuclearSite') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:#ffd700;text-shadow:0 0 4px #ffd70088;">☢</div>`);
      el.title = `${d.name} (${d.type})`;
    } else if (d._kind === 'irradiator') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#ff8800;text-shadow:0 0 3px #ff880088;">⚠</div>`);
      el.title = `${d.city}, ${d.country}`;
    } else if (d._kind === 'spaceport') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:#88ddff;text-shadow:0 0 4px #88ddff88;">🚀</div>`);
      el.title = `${d.name} (${d.operator})`;
    } else if (d._kind === 'earthquake') {
      const mc = d.magnitude >= 6 ? '#ff2020' : d.magnitude >= 4 ? '#ff8800' : '#ffcc00';
      const sz = Math.max(8, Math.min(18, Math.round(d.magnitude * 2.5)));
      el.innerHTML = GlobeMap.wrapHit(`<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${mc}44;border:2px solid ${mc};box-shadow:0 0 6px 2px ${mc}55;"></div>`);
      el.title = `M${d.magnitude.toFixed(1)} — ${d.place}`;
    } else if (d._kind === 'economic') {
      const ec = d.type === 'exchange' ? '#ffd700' : d.type === 'central-bank' ? '#4488ff' : '#44cc88';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:${ec};text-shadow:0 0 4px ${ec}88;">💰</div>`);
      el.title = `${d.name} · ${d.country}`;
    } else if (d._kind === 'datacenter') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#88aaff;text-shadow:0 0 3px #88aaff88;">🖥</div>`);
      el.title = `${d.name} (${d.owner})`;
    } else if (d._kind === 'waterway') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#44aadd;text-shadow:0 0 3px #44aadd88;">⚓</div>`);
      el.title = d.name;
    } else if (d._kind === 'mineral') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:10px;color:#cc88ff;text-shadow:0 0 3px #cc88ff88;">💎</div>`);
      el.title = `${d.mineral} — ${d.name}`;
    } else if (d._kind === 'flightDelay') {
      const sc = d.severity === 'severe' ? '#ff2020' : d.severity === 'major' ? '#ff6600' : d.severity === 'moderate' ? '#ffaa00' : '#ffee44';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">✈</div>`);
      el.title = `${d.iata} — ${d.severity}`;
    } else if (d._kind === 'notamRing') {
      el.innerHTML = `<div style="position:relative;width:20px;height:20px;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:-3px;border-radius:50%;border:2px solid #ff282888;${this.pulseStyle('2s')}"></div><div style="font-size:12px;color:#ff2828;text-shadow:0 0 6px #ff282888;">⚠</div></div>`;
      el.title = `NOTAM: ${d.name}`;
    } else if (d._kind === 'cableAdvisory') {
      const sc = d.severity === 'fault' ? '#ff2020' : '#ff8800';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">🔌</div>`);
      el.title = `${d.title} (${d.severity})`;
    } else if (d._kind === 'repairShip') {
      const sc = d.status === 'on-station' ? '#44ff88' : '#44aaff';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">🚢</div>`);
      el.title = d.name;
    } else if (d._kind === 'newsLocation') {
      const tc = d.threatLevel === 'critical' ? '#ff2020'
               : d.threatLevel === 'high'     ? '#ff6600'
               : (d.threatLevel === 'elevated' || d.threatLevel === 'medium') ? '#ffaa00'
               : '#44aaff';
      el.innerHTML = `
        <div style="position:relative;width:16px;height:16px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${tc}44;border:1.5px solid ${tc};box-shadow:0 0 5px 2px ${tc}55;"></div>
          <div style="position:absolute;inset:-5px;border-radius:50%;background:${tc}22;${this.pulseStyle('1.8s')}"></div>
        </div>`;
      el.title = d.title;
    } else if (d._kind === 'aisDisruption') {
      const sc = d.severity === 'high' ? '#ff2020' : d.severity === 'elevated' ? '#ff8800' : '#44aaff';
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">⛴</div>`);
      el.title = d.name;
    } else if (d._kind === 'satellite') {
      const c = SAT_COUNTRY_COLORS[(d as SatelliteMarker).country] || '#ccccff';
      el.innerHTML = `<div class="sat-hit" style="width:16px;height:16px;display:flex;align-items:center;justify-content:center;margin:-8px 0 0 -8px;color:${c}"><div class="sat-dot" style="width:5px;height:5px;border-radius:50%;background:${c};box-shadow:0 0 6px 2px ${c}88;transition:transform .15s,box-shadow .15s;"></div></div>`;
      el.title = `${(d as SatelliteMarker).name}`;
    } else if (d._kind === 'satFootprint') {
      const colors: Record<string, string> = { CN: '#ff2020', RU: '#ff8800', US: '#4488ff', EU: '#44cc44' };
      const c = colors[(d as SatFootprintMarker).country] || '#ccccff';
      el.innerHTML = `<div style="width:12px;height:12px;border-radius:50%;border:1px solid ${c}66;background:${c}15;margin:-6px 0 0 -6px"></div>`;
      el.style.pointerEvents = 'none';
    } else if (d._kind === 'imageryScene') {
      el.innerHTML = GlobeMap.wrapHit(`<div style="font-size:11px;color:#00b4ff;text-shadow:0 0 4px #00b4ff88;">&#128752;</div>`);
      el.title = `${d.satellite} ${d.datetime}`;
    } else if (d._kind === 'webcam') {
      const style = getCategoryStyle(d.category);
      const emoji = this.webcamMarkerMode === 'emoji' ? style.emoji : '\u{1F4F7}';
      el.innerHTML = GlobeMap.wrapHit(`<span style="background:${style.color}33;border:1px solid ${style.color}88;border-radius:10px;padding:1px 5px;font-size:12px;">${emoji}</span>`);
      el.title = d.title;
    } else if (d._kind === 'webcam-cluster') {
      el.innerHTML = GlobeMap.wrapHit(`<span style="background:#00d4ff33;border:1px solid #00d4ff88;border-radius:12px;padding:2px 7px;font-size:11px;font-weight:bold;color:#00d4ff;">${d.count}</span>`);
      el.title = `${d.count} webcams`;
    } else if (d._kind === 'flash') {
      el.style.pointerEvents = 'none';
      el.innerHTML = `
        <div style="position:relative;width:0;height:0;">
          <div style="position:absolute;width:44px;height:44px;border-radius:50%;
            border:2px solid rgba(255,255,255,0.9);background:rgba(255,255,255,0.2);
            left:-22px;top:-22px;
            ${this.pulseStyle('0.7s')}"></div>
        </div>`;
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleMarkerClick(d, el);
    });

    return el;
  }

  private handleMarkerClick(d: GlobeMarker, anchor: HTMLElement): void {
    if (d._kind === 'hotspot' && this.onHotspotClickCb) {
      this.onHotspotClickCb({
        id: d.id,
        name: d.name,
        lat: d._lat,
        lon: d._lng,
        keywords: [],
        escalationScore: d.escalationScore as Hotspot['escalationScore'],
      });
    }

    if (d._kind === 'flight' && this.popup) {
      const flight = this.flightData.get(d.id);
      if (flight) {
        const aRect = anchor.getBoundingClientRect();
        const cRect = this.container.getBoundingClientRect();
        const x = aRect.left - cRect.left + aRect.width / 2;
        const y = aRect.top - cRect.top;
        this.hideTooltip();
        this.popup.show({ type: 'militaryFlight', data: flight, x, y });
        this.popup.loadWingbitsLiveFlight(flight.hexCode);
        return;
      }
    }

    if (d._kind === 'vessel' && this.popup) {
      const vessel = this.vesselData.get(d.id);
      if (vessel) {
        const aRect = anchor.getBoundingClientRect();
        const cRect = this.container.getBoundingClientRect();
        const x = aRect.left - cRect.left + aRect.width / 2;
        const y = aRect.top  - cRect.top;
        this.hideTooltip();
        this.popup.show({ type: 'militaryVessel', data: vessel, x, y });
        return;
      }
    }

    if (d._kind === 'cluster' && this.popup) {
      const cluster = this.clusterData.get(d.id);
      if (cluster) {
        const aRect = anchor.getBoundingClientRect();
        const cRect = this.container.getBoundingClientRect();
        const x = aRect.left - cRect.left + aRect.width / 2;
        const y = aRect.top  - cRect.top;
        this.hideTooltip();
        this.popup.show({ type: 'militaryVesselCluster', data: cluster, x, y });
        return;
      }
    }

    if (d._kind === 'webcam-cluster' && this.globe) {
      const pov = this.globe.pointOfView();
      // Fly to cluster and zoom in (reduce altitude by 60%)
      this.globe.pointOfView({ lat: d._lat, lng: d._lng, altitude: pov.altitude * 0.4 }, 800);
    }
    if (d._kind === 'radiation' && this.popup) {
      const aRect = anchor.getBoundingClientRect();
      const cRect = this.container.getBoundingClientRect();
      const x = aRect.left - cRect.left + aRect.width / 2;
      const y = aRect.top - cRect.top;
      this.hideTooltip();
      this.popup.show({
        type: 'radiation',
        data: {
          id: d.id,
          source: d.source,
          contributingSources: d.contributingSources,
          location: d.location,
          country: d.country,
          lat: d._lat,
          lon: d._lng,
          value: d.value,
          unit: d.unit,
          observedAt: d.observedAt,
          freshness: d.freshness,
          baselineValue: d.baselineValue,
          delta: d.delta,
          zScore: d.zScore,
          severity: d.severity,
          confidence: d.confidence,
          corroborated: d.corroborated,
          conflictingSources: d.conflictingSources,
          convertedFromCpm: d.convertedFromCpm,
          sourceCount: d.sourceCount,
        },
        x,
        y,
      });
      return;
    }
    this.showMarkerTooltip(d, anchor);
  }

  private showMarkerTooltip(d: GlobeMarker, anchor: HTMLElement): void {
    this.hideTooltip();
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      'background:rgba(10,12,16,0.95)',
      'border:1px solid rgba(60,120,60,0.6)',
      'padding:8px 12px',
      'border-radius:3px',
      'font-size:11px',
      'font-family:var(--font-mono)',
      'color:#d4d4d4',
      'max-width:280px',
      'z-index:1000',
      'pointer-events:auto',
      'line-height:1.5',
    ].join(';');

    const closeBtn = `<button style="position:absolute;top:4px;right:4px;background:none;border:none;color:#888;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;" aria-label="Close">\u00D7</button>`;

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let html = '';
    if (d._kind === 'conflict') {
      html = `<span style="color:#ff5050;font-weight:bold;">⚔ ${esc(d.location)}</span>` +
             (d.eventType ? `<br><span style="opacity:.7;">${esc(d.eventType)}</span>` : '') +
             (d.fatalities ? `<br><span style="opacity:.5;">Casualties: ${d.fatalities}</span>` : '');
    } else if (d._kind === 'hotspot') {
      const sc = ['', '#88ff44', '#ffdd00', '#ffaa00', '#ff6600', '#ff2020'][d.escalationScore] ?? '#ffaa00';
      html = `<span style="color:${sc};font-weight:bold;">🎯 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">Escalation: ${d.escalationScore}/5</span>`;
    } else if (d._kind === 'flight') {
      const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      const compass = dirs[Math.round(((d.heading ?? 0) % 360 + 360) % 360 / 22.5) % 16];
      html = `<span style="font-weight:bold;">✈ ${esc(d.callsign)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.type)}</span>` +
             `<br><span style="opacity:.5;">Heading: ${compass} (${Math.round(d.heading ?? 0)}°)</span>`;
    } else if (d._kind === 'vessel') {
      const deployStatus = d.usniDeploymentStatus && d.usniDeploymentStatus !== 'unknown'
        ? ` <span style="opacity:.6;font-size:10px;">[${esc(d.usniDeploymentStatus.toUpperCase().replace('-', ' '))}]</span>`
        : '';
      const darkWarning = d.isDark
        ? `<br><span style="color:#ff4444;font-size:10px;font-weight:bold;">⚠ AIS DARK</span>`
        : '';
      const operatorLine = d.operatorCountry || d.operator
        ? `<br><span style="opacity:.6;font-size:10px;">${esc(d.operatorCountry || d.operator || '')}</span>`
        : '';
      const hullLine = d.hullNumber
        ? ` <span style="opacity:.5;font-size:10px;">(${esc(d.hullNumber)})</span>`
        : '';
      const articleDate = d.usniArticleDate
        ? ` · ${new Date(d.usniArticleDate).toLocaleDateString()}`
        : '';
      const inPort = d.usniDeploymentStatus === 'in-port';
      const portLine = inPort && d.usniHomePort
        ? `<br><span style="color:#44aaff;font-size:10px;">🏠 ${esc(d.usniHomePort)}</span>`
        : '';
      html = `<span style="font-weight:bold;">⛴ ${esc(d.name)}${hullLine}${deployStatus}</span>`
        + darkWarning
        + `<br><span style="opacity:.7;">${esc(d.typeLabel)}</span>`
        + operatorLine
        + portLine
        + (!inPort && d.usniStrikeGroup ? `<br><span style="opacity:.85;">⚓ ${esc(d.usniStrikeGroup)}</span>` : '')
        + (d.usniRegion ? `<br><span style="opacity:.6;font-size:10px;">${esc(d.usniRegion)}</span>` : '')
        + (d.usniActivityDescription ? `<br><span style="opacity:.6;font-size:10px;white-space:normal;display:block;max-width:200px;">${esc(d.usniActivityDescription.slice(0, 120))}</span>` : '')
        + (d.usniSource
          ? `<br><span style="color:#ffaa44;font-size:9px;">⚠ EST. POSITION — ${inPort ? 'In-port' : 'Approx.'} via USNI${articleDate}</span>`
          : `<br><span style="color:#44ff88;font-size:9px;">● AIS LIVE</span>`);
    } else if (d._kind === 'cluster') {
      const cc = GlobeMap.CLUSTER_ACTIVITY_COLORS[d.activityType ?? 'unknown'] ?? '#6688aa';
      const actLabel = d.activityType && d.activityType !== 'unknown'
        ? d.activityType.charAt(0).toUpperCase() + d.activityType.slice(1) : '';
      html = `<span style="color:${cc};font-weight:bold;">⚓ ${esc(d.name)}</span>`
        + `<br><span style="opacity:.7;">${d.vesselCount} vessel${d.vesselCount !== 1 ? 's' : ''}</span>`
        + (actLabel ? `<br><span style="opacity:.6;font-size:10px;">Activity: ${esc(actLabel)}</span>` : '')
        + (d.region ? `<br><span style="opacity:.6;font-size:10px;">${esc(d.region)}</span>` : '');
    } else if (d._kind === 'weather') {
      const wc = d.severity === 'Extreme' ? '#ff0044' : d.severity === 'Severe' ? '#ff6600' : '#88aaff';
      html = `<span style="color:${wc};font-weight:bold;">⚡ ${esc(d.severity)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.headline.slice(0, 90))}</span>`;
    } else if (d._kind === 'radiation') {
      const rc = d.severity === 'spike' ? '#ff3030' : '#ffaa00';
      html = `<span style="color:${rc};font-weight:bold;">☢ ${esc(d.severity.toUpperCase())}</span>` +
             `<br><span style="opacity:.7;">${esc(d.location)}, ${esc(d.country)}</span>` +
             `<br><span style="opacity:.5;">${d.value.toFixed(1)} ${esc(d.unit)} · ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} vs baseline</span>` +
             `<br><span style="opacity:.55;font-size:10px;">${esc(d.confidence.toUpperCase())}${d.corroborated ? ' · CONFIRMED' : ''}${d.conflictingSources ? ' · CONFLICT' : ''}</span>`;
    } else if (d._kind === 'natural') {
      html = `<span style="font-weight:bold;">${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.7;">${esc(d.category)}</span>`;
    } else if (d._kind === 'iran') {
      const sc = getIranEventHexColor(d);
      html = `<span style="color:${sc};font-weight:bold;">🎯 ${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.7;">${esc(d.category)}${d.location ? ' · ' + esc(d.location) : ''}</span>`;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${sc};font-weight:bold;">📡 ${d.severity.toUpperCase()} Outage</span>` +
             `<br><span style="opacity:.7;">${esc(d.country)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.title.slice(0, 70))}</span>`;
    } else if (d._kind === 'trafficAnomaly') {
      html = `<span style="color:#ffa000;font-weight:bold;">⚡ ${esc(d.type || 'Traffic Anomaly')}</span>` +
             `<br><span style="opacity:.7;">${esc(d.locationName)}</span>`;
    } else if (d._kind === 'ddosHit') {
      html = `<span style="color:#b400ff;font-weight:bold;">⚔ DDoS Target: ${esc(d.countryName)}</span>` +
             `<br><span style="opacity:.7;">${d.percentage.toFixed(1)}% of attack traffic</span>`;
    } else if (d._kind === 'cyber') {
      const sc = d.severity === 'critical' ? '#ff0044' : d.severity === 'high' ? '#ff4400' : '#ffaa00';
      html = `<span style="color:${sc};font-weight:bold;">🛡 ${d.severity.toUpperCase()}</span>` +
             `<br><span style="opacity:.7;">${esc(d.type)}</span>` +
             `<br><span style="opacity:.5;font-size:10px;">${esc(d.indicator.slice(0, 40))}</span>`;
    } else if (d._kind === 'fire') {
      html = `<span style="color:#ff6600;font-weight:bold;">🔥 Wildfire</span>` +
             `<br><span style="opacity:.7;">${esc(d.region)}</span>` +
             `<br><span style="opacity:.5;">Brightness: ${d.brightness.toFixed(0)} K</span>`;
    } else if (d._kind === 'protest') {
      const typeColors: Record<string, string> = { riot: '#ff3030', strike: '#44aaff', protest: '#ffaa00' };
      const c = typeColors[d.eventType] ?? '#ffaa00';
      html = `<span style="color:${c};font-weight:bold;">📢 ${esc(d.eventType)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.country)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.title.slice(0, 70))}</span>`;
    } else if (d._kind === 'ucdp') {
      html = `<span style="color:#ff6400;font-weight:bold;">⚔ ${esc(d.country)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.sideA)} vs ${esc(d.sideB)}</span>` +
             (d.deaths ? `<br><span style="opacity:.5;">Deaths: ${d.deaths}</span>` : '');
    } else if (d._kind === 'displacement') {
      html = `<span style="color:#88bbff;font-weight:bold;">👥 Displacement</span>` +
             `<br><span style="opacity:.7;">${esc(d.origin)} → ${esc(d.asylum)}</span>` +
             `<br><span style="opacity:.5;">Refugees: ${d.refugees.toLocaleString()}</span>`;
    } else if (d._kind === 'climate') {
      const tc = d.type === 'warm' ? '#ff4400' : d.type === 'cold' ? '#44aaff' : '#88ff88';
      html = `<span style="color:${tc};font-weight:bold;">🌡 ${esc(d.type.toUpperCase())}</span>` +
             `<br><span style="opacity:.7;">${esc(d.zone)}</span>` +
             `<br><span style="opacity:.5;">ΔT: ${d.tempDelta > 0 ? '+' : ''}${d.tempDelta.toFixed(1)}°C · ${esc(d.severity)}</span>`;
    } else if (d._kind === 'gpsjam') {
      const gc = d.level === 'high' ? '#ff2020' : '#ff8800';
      html = `<span style="color:${gc};font-weight:bold;">📡 GPS Jamming</span>` +
             `<br><span style="opacity:.7;">Level: ${esc(d.level)}</span>` +
             `<br><span style="opacity:.5;">Avg satellites visible: ${d.npAvg.toFixed(1)}</span>`;
    } else if (d._kind === 'tech') {
      html = `<span style="color:#44aaff;font-weight:bold;">💻 ${esc(d.title.slice(0, 50))}</span>` +
             `<br><span style="opacity:.7;">${esc(d.country)}</span>` +
             (d.daysUntil >= 0 ? `<br><span style="opacity:.5;">In ${d.daysUntil} days</span>` : '');
    } else if (d._kind === 'conflictZone') {
      const ic = d.intensity === 'high' ? '#ff3030' : d.intensity === 'medium' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${ic};font-weight:bold;">⚔ ${esc(d.name)}</span>` +
             (d.parties.length ? `<br><span style="opacity:.7;">${d.parties.map(esc).join(', ')}</span>` : '') +
             (d.casualties ? `<br><span style="opacity:.5;">Casualties: ${esc(d.casualties)}</span>` : '');
    } else if (d._kind === 'milbase') {
      html = `<span style="color:#4488ff;font-weight:bold;">🏛 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.type)}${d.country ? ' · ' + esc(d.country) : ''}</span>`;
    } else if (d._kind === 'nuclearSite') {
      const nc = d.status === 'active' ? '#ffd700' : d.status === 'construction' ? '#ff8800' : '#888888';
      html = `<span style="color:${nc};font-weight:bold;">☢ ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.type)} · ${esc(d.status)}</span>`;
    } else if (d._kind === 'irradiator') {
      html = `<span style="color:#ff8800;font-weight:bold;">⚠ Gamma Irradiator</span>` +
             `<br><span style="opacity:.7;">${esc(d.city)}, ${esc(d.country)}</span>`;
    } else if (d._kind === 'spaceport') {
      const lc = d.launches === 'High' ? '#88ddff' : d.launches === 'Medium' ? '#44aaff' : '#aaaaaa';
      html = `<span style="color:${lc};font-weight:bold;">🚀 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.operator)} · ${esc(d.country)}</span>` +
             `<br><span style="opacity:.5;">Launch frequency: ${esc(d.launches)}</span>`;
    } else if (d._kind === 'earthquake') {
      const mc = d.magnitude >= 6 ? '#ff3030' : d.magnitude >= 4 ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${mc};font-weight:bold;">🌍 M${d.magnitude.toFixed(1)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.place.slice(0, 70))}</span>`;
    } else if (d._kind === 'economic') {
      const ec = d.type === 'exchange' ? '#ffd700' : d.type === 'central-bank' ? '#4488ff' : '#44cc88';
      html = `<span style="color:${ec};font-weight:bold;">💰 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.type)} · ${esc(d.country)}</span>` +
             (d.description ? `<br><span style="opacity:.5;white-space:normal;display:block;">${esc(d.description.slice(0, 70))}</span>` : '');
    } else if (d._kind === 'datacenter') {
      html = `<span style="color:#88aaff;font-weight:bold;">🖥 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.owner)} · ${esc(d.country)}</span>` +
             `<br><span style="opacity:.5;">${esc(d.chipType)}</span>`;
    } else if (d._kind === 'waterway') {
      html = `<span style="color:#44aadd;font-weight:bold;">⚓ ${esc(d.name)}</span>` +
             (d.description ? `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.description.slice(0, 80))}</span>` : '');
    } else if (d._kind === 'mineral') {
      const mc2 = d.status === 'producing' ? '#cc88ff' : '#8866bb';
      html = `<span style="color:${mc2};font-weight:bold;">💎 ${esc(d.mineral)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.name)} · ${esc(d.country)}</span>` +
             `<br><span style="opacity:.5;">${esc(d.status)}</span>`;
    } else if (d._kind === 'flightDelay') {
      const sc = d.severity === 'severe' ? '#ff3030' : d.severity === 'major' ? '#ff6600' : d.severity === 'moderate' ? '#ffaa00' : '#ffee44';
      html = `<span style="color:${sc};font-weight:bold;">✈ ${esc(d.iata)} — ${esc(d.severity.toUpperCase())}</span>` +
             `<br><span style="opacity:.7;">${esc(d.name)}, ${esc(d.country)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.delayType.replace(/_/g, ' '))}` +
             (d.avgDelayMinutes > 0 ? ` · avg ${d.avgDelayMinutes}min` : '') + `</span>` +
             (d.reason ? `<br><span style="opacity:.5;white-space:normal;display:block;">${esc(d.reason.slice(0, 70))}</span>` : '');
    } else if (d._kind === 'notamRing') {
      html = `<span style="color:#ff2828;font-weight:bold;">⚠ NOTAM CLOSURE</span>` +
             `<br><span style="opacity:.7;">${esc(d.name)}</span>` +
             (d.reason ? `<br><span style="opacity:.5;white-space:normal;display:block;">${esc(d.reason.slice(0, 100))}</span>` : '');
    } else if (d._kind === 'cableAdvisory') {
      const sc = d.severity === 'fault' ? '#ff2020' : '#ff8800';
      html = `<span style="color:${sc};font-weight:bold;">🔌 ${esc(d.severity.toUpperCase())} — ${esc(d.title.slice(0, 50))}</span>` +
             (d.impact ? `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.impact.slice(0, 70))}</span>` : '') +
             (d.repairEta ? `<br><span style="opacity:.5;">ETA: ${esc(d.repairEta)}</span>` : '');
    } else if (d._kind === 'repairShip') {
      const sc = d.status === 'on-station' ? '#44ff88' : '#44aaff';
      html = `<span style="color:${sc};font-weight:bold;">🚢 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.status.replace(/-/g, ' '))}${d.operator ? ' · ' + esc(d.operator) : ''}</span>` +
             (d.eta ? `<br><span style="opacity:.5;">ETA: ${esc(d.eta)}</span>` : '');
    } else if (d._kind === 'aisDisruption') {
      const sc = d.severity === 'high' ? '#ff2020' : d.severity === 'elevated' ? '#ff8800' : '#44aaff';
      const typeLabel = d.type === 'gap_spike' ? 'Gap Spike' : 'Chokepoint Congestion';
      html = `<span style="color:${sc};font-weight:bold;">⛴ ${esc(typeLabel)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.name)}</span>` +
             `<br><span style="opacity:.5;">${esc(d.severity)} · ${esc(d.description.slice(0, 60))}</span>`;
    } else if (d._kind === 'newsLocation') {
      const tc = d.threatLevel === 'critical' ? '#ff2020' : d.threatLevel === 'high' ? '#ff6600' : (d.threatLevel === 'elevated' || d.threatLevel === 'medium') ? '#ffaa00' : '#44aaff';
      html = `<span style="color:${tc};font-weight:bold;">📰 ${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.5;">${esc(d.threatLevel)}</span>`;
    } else if (d._kind === 'satellite') {
      const sc = SAT_COUNTRY_COLORS[d.country] || '#ccccff';
      const altBand = d.alt < 2000 ? 'LEO' : d.alt < 35786 ? 'MEO' : 'GEO';
      const operatorName = SAT_OPERATOR_NAME[d.country] || getCountryNameByCode(d.country) || d.country;
      const overHit = getCountryAtCoordinates(d._lat, d._lng);
      const overLabel = overHit ? overHit.name : 'Ocean';
      html = `<div style="min-width:220px;">` +
        `<span style="color:${sc};font-weight:bold;font-size:12px;">${SAT_TYPE_EMOJI[d.type] || '\u{1F6F0}'} ${esc(d.name)}</span>` +
        `<div style="opacity:.5;font-size:10px;margin:2px 0 6px;">NORAD ${esc(d.id)}</div>` +
        `<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px;">` +
        `<span style="opacity:.5;">Type</span><span>${esc(SAT_TYPE_LABEL[d.type] || d.type)}</span>` +
        `<span style="opacity:.5;">Operator</span><span style="color:${sc}">${esc(operatorName)}</span>` +
        `<span style="opacity:.5;">Over</span><span>${esc(overLabel)}</span>` +
        `<span style="opacity:.5;">Alt. band</span><span>${altBand} \u00B7 ${Math.round(d.alt)} km</span>` +
        `<span style="opacity:.5;">Incl.</span><span>${d.inclination.toFixed(1)}\u00B0</span>` +
        `<span style="opacity:.5;">Velocity</span><span>${d.velocity.toFixed(1)} km/s</span>` +
        `</div></div>`;
    } else if (d._kind === 'imageryScene') {
      html = `<span style="color:#00b4ff;font-weight:bold;">&#128752; ${esc(d.satellite)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.datetime)}</span>`;
      if (d.resolutionM != null || d.mode) {
        const rp: string[] = [];
        if (d.resolutionM != null) rp.push(`${d.resolutionM}m`);
        if (d.mode) rp.push(esc(d.mode));
        html += `<br><span style="opacity:.5;">Res: ${rp.join(' \u00B7 ')}</span>`;
      }
      if (isAllowedPreviewUrl(d.previewUrl)) {
        const safeHref = escapeHtml(new URL(d.previewUrl!).href);
        html += `<br><img src="${safeHref}" referrerpolicy="no-referrer" style="max-width:180px;max-height:120px;margin-top:4px;border-radius:4px;" class="imagery-preview">`;
      }
    } else if (d._kind === 'webcam') {
      html = '';
    } else if (d._kind === 'webcam-cluster') {
      html = '';
    }
    el.innerHTML = `<div style="padding-right:16px;position:relative;">${closeBtn}${html}</div>`;
    const wideKinds = new Set(['satellite', 'flightDelay', 'conflictZone', 'cableAdvisory']);
    if (wideKinds.has(d._kind)) el.style.maxWidth = '300px';
    el.querySelector('button')?.addEventListener('click', () => this.hideTooltip());

    if (d._kind === 'webcam') {
      const wrapper = el.firstElementChild!;
      const titleSpan = document.createElement('span');
      titleSpan.style.cssText = 'color:#00d4ff;font-weight:bold;';
      titleSpan.textContent = `\u{1F4F7} ${d.title.slice(0, 50)}`;
      wrapper.appendChild(titleSpan);

      const metaSpan = document.createElement('span');
      metaSpan.style.cssText = 'display:block;opacity:.7;font-size:11px;';
      metaSpan.textContent = `${d.country} \u00B7 ${d.category}`;
      wrapper.appendChild(metaSpan);

      const previewDiv = document.createElement('div');
      previewDiv.style.marginTop = '4px';
      const loadingSpan = document.createElement('span');
      loadingSpan.style.cssText = 'opacity:.5;font-size:11px;';
      loadingSpan.textContent = 'Loading preview...';
      previewDiv.appendChild(loadingSpan);
      wrapper.appendChild(previewDiv);

      const link = document.createElement('a');
      link.href = `https://www.windy.com/webcams/${encodeURIComponent(d.webcamId)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = 'display:block;color:#00d4ff;font-size:11px;text-decoration:none;';
      link.textContent = 'Open on Windy \u2197';
      wrapper.appendChild(link);

      const attribution = document.createElement('div');
      attribution.style.cssText = 'opacity:.4;font-size:9px;margin-top:4px;';
      attribution.textContent = 'Powered by Windy';
      wrapper.appendChild(attribution);

      import('@/services/webcams').then(({ fetchWebcamImage }) => {
        fetchWebcamImage(d.webcamId).then(img => {
          if (!el.isConnected) return;
          previewDiv.replaceChildren();
          if (img.thumbnailUrl) {
            const imgEl = document.createElement('img');
            imgEl.src = img.thumbnailUrl;
            imgEl.style.cssText = 'width:200px;border-radius:4px;margin-bottom:4px;';
            imgEl.loading = 'lazy';
            previewDiv.appendChild(imgEl);
          } else {
            const span = document.createElement('span');
            span.style.cssText = 'opacity:.5;font-size:11px;';
            span.textContent = 'Preview unavailable';
            previewDiv.appendChild(span);
          }
          const pinBtn = document.createElement('button');
          pinBtn.className = 'webcam-pin-btn';
          pinBtn.style.cssText = 'display:block;margin-top:4px;';
          if (isPinned(d.webcamId)) {
            pinBtn.classList.add('webcam-pin-btn--pinned');
            pinBtn.textContent = '\u{1F4CC} Pinned';
            pinBtn.disabled = true;
          } else {
            pinBtn.textContent = '\u{1F4CC} Pin';
            pinBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              pinWebcam({
                webcamId: d.webcamId,
                title: d.title || img.title || '',
                lat: d._lat,
                lng: d._lng,
                category: d.category || 'other',
                country: d.country || '',
                playerUrl: img.playerUrl || '',
              });
              pinBtn.classList.add('webcam-pin-btn--pinned');
              pinBtn.textContent = '\u{1F4CC} Pinned';
              pinBtn.disabled = true;
            });
          }
          wrapper.appendChild(pinBtn);
        });
      });
    } else if (d._kind === 'webcam-cluster') {
      const wrapper = el.firstElementChild!;
      const header = document.createElement('span');
      header.style.cssText = 'color:#00d4ff;font-weight:bold;';
      header.textContent = `\u{1F4F7} ${d.count} webcams`;
      wrapper.appendChild(header);
      const loadingSpan = document.createElement('span');
      loadingSpan.style.cssText = 'display:block;opacity:.5;font-size:10px;';
      loadingSpan.textContent = 'Loading list...';
      wrapper.appendChild(loadingSpan);
    }
    el.addEventListener('mouseenter', () => {
      if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; }
    });
    el.addEventListener('mouseleave', () => {
      this.tooltipHideTimer = setTimeout(() => this.hideTooltip(), 2000);
    });

    this.container.appendChild(el);

    // Position relative to container using measured dimensions
    const ar = anchor.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    const left = Math.max(4, Math.min(
      ar.left - cr.left + (anchor.offsetWidth ?? 14) + 6,
      cr.width - el.offsetWidth - 4
    ));
    const top = Math.max(4, Math.min(
      ar.top - cr.top - 8,
      cr.height - el.offsetHeight - 4
    ));
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';

    this.tooltipEl = el;
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    const richKinds = new Set(['satellite', 'flightDelay', 'cableAdvisory', 'conflictZone', 'spaceport', 'economic', 'datacenter', 'imageryScene', 'repairShip', 'aisDisruption']);
    const hideDelay = d._kind === 'webcam' ? 8000 : d._kind === 'webcam-cluster' ? 12000 : richKinds.has(d._kind) ? 6000 : 3500;
    this.tooltipHideTimer = setTimeout(() => this.hideTooltip(), hideDelay);

    if (d._kind === 'webcam-cluster') {
      const tooltipEl = el;
      const alt = this.globe?.pointOfView()?.altitude ?? 2.0;
      const approxZoom = alt >= 2.0 ? 2 : alt >= 1.0 ? 4 : alt >= 0.5 ? 6 : 8;
      import('@/services/webcams').then(({ fetchWebcams, getClusterCellSize }) => {
        const margin = Math.max(0.5, getClusterCellSize(approxZoom));
        fetchWebcams(10, {
          w: d._lng - margin, s: d._lat - margin,
          e: d._lng + margin, n: d._lat + margin,
        }).then(result => {
          if (!tooltipEl.isConnected) return;
          const webcams = result.webcams.slice(0, 20);

          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'padding-right:16px;position:relative;';

          const closeBtn2 = document.createElement('button');
          closeBtn2.style.cssText = 'position:absolute;top:4px;right:4px;background:none;border:none;color:#888;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;';
          closeBtn2.setAttribute('aria-label', 'Close');
          closeBtn2.textContent = '\u00D7';
          closeBtn2.addEventListener('click', () => this.hideTooltip());
          wrapper.appendChild(closeBtn2);

          const headerSpan = document.createElement('span');
          headerSpan.style.cssText = 'color:#00d4ff;font-weight:bold;';
          headerSpan.textContent = `\u{1F4F7} ${webcams.length} webcams`;
          wrapper.appendChild(headerSpan);

          const listDiv = document.createElement('div');
          listDiv.style.cssText = 'max-height:180px;overflow-y:auto;margin-top:4px;';

          for (const webcam of webcams) {
            const item = document.createElement('div');
            item.style.cssText = 'padding:2px 0;cursor:pointer;color:#aaa;border-bottom:1px solid rgba(255,255,255,0.08);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = webcam.title || webcam.category || 'Webcam';
            item.appendChild(nameSpan);

            if (webcam.country) {
              const countrySpan = document.createElement('span');
              countrySpan.style.cssText = 'float:right;opacity:0.4;font-size:10px;margin-left:6px;';
              countrySpan.textContent = webcam.country;
              item.appendChild(countrySpan);
            }

            item.addEventListener('mouseenter', () => { item.style.color = '#00d4ff'; });
            item.addEventListener('mouseleave', () => { item.style.color = '#aaa'; });
            item.addEventListener('click', (e) => {
              e.stopPropagation();
              const cr = this.container.getBoundingClientRect();
              const me = e as MouseEvent;
              const phantom = document.createElement('div');
              phantom.style.cssText = `position:absolute;left:${me.clientX - cr.left}px;top:${me.clientY - cr.top}px;width:1px;height:1px;pointer-events:none;`;
              this.container.appendChild(phantom);
              this.showMarkerTooltip({
                _kind: 'webcam', _lat: webcam.lat, _lng: webcam.lng,
                webcamId: webcam.webcamId, title: webcam.title,
                category: webcam.category, country: webcam.country,
              } as GlobeMarker, phantom);
              phantom.remove();
            });
            listDiv.appendChild(item);
          }

          wrapper.appendChild(listDiv);
          tooltipEl.replaceChildren(wrapper);
        });
      });
    }
  }

  private hideTooltip(): void {
    if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; }
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.popup?.hide();
  }

  // ─── Overlay UI: zoom controls & layer panel ─────────────────────────────

  private createControls(): void {
    const el = document.createElement('div');
    el.className = 'map-controls deckgl-controls';
    el.innerHTML = `
      <span class="globe-beta-badge">BETA</span>
      <div class="zoom-controls">
        <button class="map-btn zoom-in"    title="Zoom in">+</button>
        <button class="map-btn zoom-out"   title="Zoom out">-</button>
        <button class="map-btn zoom-reset" title="Reset view">&#8962;</button>
      </div>`;
    this.container.appendChild(el);
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if      (target.classList.contains('zoom-in'))    this.zoomInGlobe();
      else if (target.classList.contains('zoom-out'))   this.zoomOutGlobe();
      else if (target.classList.contains('zoom-reset')) this.setView(this.currentView);
    });
  }

  private zoomInGlobe(): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    const alt = Math.max(0.05, (pov.altitude ?? 1.8) * 0.6);
    this.globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: alt }, 500);
  }

  private zoomOutGlobe(): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    const alt = Math.min(4.0, (pov.altitude ?? 1.8) * 1.6);
    this.globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: alt }, 500);
  }

  private createLayerToggles(): void {
    const layerDefs = getLayersForVariant((SITE_VARIANT || 'full') as MapVariant, 'globe');
    const _wmKey = getSecretState('WORLDMONITOR_API_KEY').present;
    const layers = layerDefs.map(def => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
      premium: def.premium,
    }));

    const el = document.createElement('div');
    el.className = 'layer-toggles deckgl-layer-toggles';
    el.style.bottom = 'auto';
    el.style.top = '10px';
    el.innerHTML = `
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${t('components.deckgl.layerSearch')}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list" style="max-height:32vh;overflow-y:auto;scrollbar-width:thin;">
        ${layers.map(({ key, label, icon, premium }) => {
          const isLocked = premium === 'locked' && !_wmKey;
          const isEnhanced = premium === 'enhanced' && !_wmKey;
          return `
          <label class="layer-toggle${isLocked ? ' layer-toggle-locked' : ''}" data-layer="${key}">
            <input type="checkbox" ${this.layers[key] ? 'checked' : ''}${isLocked ? ' disabled' : ''}>
            <span class="toggle-icon">${icon}</span>
            <span class="toggle-label">${label}${isLocked ? ' \uD83D\uDD12' : ''}${isEnhanced ? ' <span class="layer-pro-badge">PRO</span>' : ''}</span>
          </label>`;
        }).join('')}
      </div>`;
    const authorBadge = document.createElement('div');
    authorBadge.className = 'map-author-badge';
    authorBadge.textContent = '© Elie Habib · Someone™';
    el.appendChild(authorBadge);
    this.container.appendChild(el);

    el.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) {
          const checked = (input as HTMLInputElement).checked;
          this.layers[layer] = checked;
          this.flushLayerChannels(layer);
          this.onLayerChangeCb?.(layer, checked, 'user');
          this.enforceLayerLimit();
          // Show/hide webcam marker-mode sub-row when webcam layer is toggled
          if (layer === 'webcams') {
            const modeRow = el.querySelector('.webcam-mode-row') as HTMLElement | null;
            if (modeRow) modeRow.style.display = checked ? '' : 'none';
          }
        }
      });
    });

    // ── Webcam marker-mode sub-toggle ────────────────────────────────────────
    const webcamToggleEl = el.querySelector('.layer-toggle[data-layer="webcams"]') as HTMLElement | null;
    if (webcamToggleEl) {
      const modeRow = document.createElement('div');
      modeRow.className = 'webcam-mode-row';
      modeRow.style.cssText = 'display:none;padding:2px 6px 4px 24px;font-size:10px;color:#aaa;';
      const currentMode = (): string => localStorage.getItem('wm-webcam-marker-mode') || 'icon';
      const renderModeLabel = (): string => currentMode() === 'emoji' ? '&#128247; icon mode' : '&#128512; emoji mode';
      const modeBtn = document.createElement('button');
      modeBtn.style.cssText = 'background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.3);color:#00d4ff;font-size:10px;padding:1px 6px;border-radius:3px;cursor:pointer;margin-left:2px;';
      modeBtn.title = 'Toggle webcam marker style';
      modeBtn.innerHTML = renderModeLabel();
      modeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = currentMode() === 'icon' ? 'emoji' : 'icon';
        localStorage.setItem('wm-webcam-marker-mode', next);
        this.webcamMarkerMode = next;
        modeBtn.innerHTML = renderModeLabel();
        this.flushMarkers();
      });
      const modeLabel = document.createElement('span');
      modeLabel.textContent = 'Marker: ';
      modeRow.appendChild(modeLabel);
      modeRow.appendChild(modeBtn);
      webcamToggleEl.insertAdjacentElement('afterend', modeRow);
      // Show immediately if webcam layer is already enabled
      if (this.layers.webcams) modeRow.style.display = '';
    }

    this.enforceLayerLimit();

    bindLayerSearch(el);
    const searchEl = el.querySelector('.layer-search') as HTMLElement | null;

    const collapseBtn = el.querySelector('.toggle-collapse');
    const list = el.querySelector('.toggle-list') as HTMLElement | null;
    let collapsed = false;
    collapseBtn?.addEventListener('click', () => {
      collapsed = !collapsed;
      if (list) list.style.display = collapsed ? 'none' : '';
      if (searchEl) searchEl.style.display = collapsed ? 'none' : '';
      if (collapseBtn) (collapseBtn as HTMLElement).innerHTML = collapsed ? '&#9654;' : '&#9660;';
    });

    // Intercept wheel on layer panel — scroll list, don't zoom globe
    el.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (list) list.scrollTop += e.deltaY;
    }, { passive: false });

    this.layerTogglesEl = el;
  }

  // ─── Flush all current data to globe ──────────────────────────────────────

  private flushMarkers(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    if (this.renderPaused) { this.pendingFlushWhilePaused = true; return; }

    if (!this.flushMaxTimer) {
      this.flushMaxTimer = setTimeout(() => {
        this.flushMaxTimer = null;
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        this.flushMarkersImmediate();
      }, 300);
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.flushMaxTimer) { clearTimeout(this.flushMaxTimer); this.flushMaxTimer = null; }
      this.flushMarkersImmediate();
    }, 100);
  }

  private flushMarkersImmediate(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();

    const markers: GlobeMarker[] = [];
    if (this.layers.hotspots) markers.push(...this.hotspots);
    if (this.layers.conflicts) markers.push(...this.conflictZoneMarkers);
    if (this.layers.bases) markers.push(...this.milBaseMarkers);
    if (this.layers.nuclear) markers.push(...this.nuclearSiteMarkers);
    if (this.layers.irradiators) markers.push(...this.irradiatorSiteMarkers);
    if (this.layers.spaceports) markers.push(...this.spaceportSiteMarkers);
    if (this.layers.military) {
      markers.push(...this.flights);
      markers.push(...this.vessels);
      markers.push(...this.clusterMarkers);
    }
    if (this.layers.weather) markers.push(...this.weatherMarkers);
    if (this.layers.natural) {
      markers.push(...this.naturalMarkers);
      markers.push(...this.earthquakeMarkers);
    }
    if (this.layers.radiationWatch) markers.push(...this.radiationMarkers);
    if (this.layers.economic) markers.push(...this.economicMarkers);
    if (this.layers.datacenters) markers.push(...this.datacenterMarkers);
    if (this.layers.waterways) markers.push(...this.waterwayMarkers);
    if (this.layers.minerals) markers.push(...this.mineralMarkers);
    if (this.layers.flights) {
      markers.push(...this.flightDelayMarkers);
      markers.push(...this.notamRingMarkers);
    }
    if (this.layers.ais) markers.push(...this.aisMarkers);
    if (this.layers.iranAttacks) markers.push(...this.iranMarkers);
    if (this.layers.outages) {
      markers.push(...this.outageMarkers);
      markers.push(...this.trafficAnomalyMarkers);
      markers.push(...this.ddosMarkers);
    }
    if (this.layers.cyberThreats) markers.push(...this.cyberMarkers);
    if (this.layers.fires) markers.push(...this.fireMarkers);
    if (this.layers.protests) markers.push(...this.protestMarkers);
    if (this.layers.ucdpEvents) markers.push(...this.ucdpMarkers);
    if (this.layers.displacement) markers.push(...this.displacementMarkers);
    if (this.layers.climate) markers.push(...this.climateMarkers);
    if (this.layers.gpsJamming) markers.push(...this.gpsJamMarkers);
    if (this.layers.satellites) {
      markers.push(...this.satelliteMarkers);
      markers.push(...this.satelliteFootprintMarkers);
      markers.push(...this.imagerySceneMarkers);
    }
    if (this.layers.techEvents) markers.push(...this.techMarkers);
    if (this.layers.cables) {
      markers.push(...this.cableAdvisoryMarkers);
      markers.push(...this.repairShipMarkers);
    }
    if (this.layers.webcams) markers.push(...this.webcamMarkers);
    markers.push(...this.newsLocationMarkers);
    markers.push(...this.flashMarkers);

    try {
      this.globe.htmlElementsData(markers);
    } catch (err) { if (import.meta.env.DEV) console.warn('[GlobeMap] flush error', err); }
  }

  private flushArcs(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();
    const segments = this.layers.tradeRoutes ? this.tradeRouteSegments : [];
    (this.globe as any).arcsData(segments);
  }

  private flushPaths(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();
    const showCables = this.layers.cables;
    const showPipelines = this.layers.pipelines;
    const paths = (showCables && showPipelines)
      ? this.globePaths
      : this.globePaths.filter(p => p.pathType === 'cable' ? showCables : showPipelines);
    const orbitPaths = this.layers.satellites ? this.satelliteTrailPaths : [];
    const stormPaths = this.layers.natural ? this.stormTrackPaths : [];
    (this.globe as any).pathsData([...paths, ...orbitPaths, ...stormPaths]);
  }

  private static readonly CII_GLOBE_COLORS: Record<string, string> = {
    low:      'rgba(40, 180, 60, 0.35)',
    normal:   'rgba(220, 200, 50, 0.35)',
    elevated: 'rgba(240, 140, 30, 0.40)',
    high:     'rgba(220, 50, 20, 0.45)',
    critical: 'rgba(140, 10, 0, 0.50)',
  };
  private static readonly CONFLICT_CAP: Record<string, string> = { high: 'rgba(255,40,40,0.25)', medium: 'rgba(255,120,0,0.20)', low: 'rgba(255,200,0,0.15)' };
  private static readonly CONFLICT_SIDE: Record<string, string> = { high: 'rgba(255,40,40,0.12)', medium: 'rgba(255,120,0,0.08)', low: 'rgba(255,200,0,0.06)' };
  private static readonly CONFLICT_STROKE: Record<string, string> = { high: '#ff3030', medium: '#ff8800', low: '#ffcc00' };
  private static readonly CONFLICT_ALT: Record<string, number> = { high: 0.006, medium: 0.004, low: 0.003 };

  private getReversedRing(zoneId: string, countryIso: string, ringIdx: number, ring: number[][][]): number[][][] {
    const key = `${zoneId}:${countryIso}:${ringIdx}`;
    let cached = this.reversedRingCache.get(key);
    if (!cached) {
      cached = ring.map((r: number[][]) => [...r].reverse());
      this.reversedRingCache.set(key, cached);
    }
    return cached;
  }

  private flushPolygons(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();
    const polys: GlobePolygon[] = [];

    if (this.layers.conflicts) {
      const CONFLICT_ISO: Record<string, string[]> = {
        iran: ['IR'], ukraine: ['UA'], gaza: ['PS', 'IL'], sudan: ['SD'], myanmar: ['MM'],
      };
      for (const z of CONFLICT_ZONES) {
        const isoCodes = CONFLICT_ISO[z.id];
        if (isoCodes && this.countriesGeoData) {
          for (const feat of this.countriesGeoData.features) {
            const code = feat.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
            if (!code || !isoCodes.includes(code)) continue;
            const geom = feat.geometry;
            if (!geom) continue;
            const rings = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
            for (let ri = 0; ri < rings.length; ri++) {
              polys.push({
                coords: this.getReversedRing(z.id, code, ri, rings[ri] as number[][][]),
                name: z.name,
                _kind: 'conflict',
                intensity: z.intensity ?? 'low',
                parties: z.parties,
                casualties: z.casualties,
              });
            }
          }
        }
      }
    }

    if (this.layers.ciiChoropleth && this.countriesGeoData) {
      for (const feat of this.countriesGeoData.features) {
        const code = feat.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
        const entry = code ? this.ciiScoresMap.get(code) : undefined;
        if (!entry || !code) continue;
        const geom = feat.geometry;
        if (!geom) continue;
        const rings = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        const name = (feat.properties?.name as string) ?? code;
        for (const ring of rings) {
          polys.push({ coords: ring, name, _kind: 'cii', level: entry.level, score: entry.score });
        }
      }
    }

    if (this.layers.satellites) {
      polys.push(...this.imageryFootprintPolygons);
    }

    if (this.layers.natural) {
      polys.push(...this.stormConePolygons);
    }

    (this.globe as any).polygonsData(polys);
  }

  // ─── Public data setters ──────────────────────────────────────────────────

  public setCIIScores(scores: Array<{ code: string; score: number; level: string }>): void {
    this.ciiScoresMap = new Map(scores.map(s => [s.code, { score: s.score, level: s.level }]));
    this.flushPolygons();
  }

  public setHotspots(hotspots: Hotspot[]): void {
    this.hotspots = hotspots.map(h => ({
      _kind: 'hotspot' as const,
      _lat: h.lat,
      _lng: h.lon,
      id: h.id,
      name: h.name,
      escalationScore: h.escalationScore ?? 1,
    }));
    this.flushMarkers();
  }

  private setConflictZones(): void {
    this.conflictZoneMarkers = CONFLICT_ZONES.map(z => ({
      _kind: 'conflictZone' as const,
      _lat: z.center[1],
      _lng: z.center[0],
      id: z.id,
      name: z.name,
      intensity: z.intensity ?? 'low',
      parties: z.parties ?? [],
      casualties: z.casualties,
    }));
    this.flushMarkers();
  }

  private initStaticLayers(): void {
    for (const k of Object.keys(this.layers) as (keyof MapLayers)[]) {
      if (this.layers[k]) this.ensureStaticDataForLayer(k);
    }
  }

  private ensureStaticDataForLayer(layer: keyof MapLayers): void {
    switch (layer) {
      case 'bases':
        if (!this.milBaseMarkers.length) {
          this.milBaseMarkers = (MILITARY_BASES as MilitaryBase[]).map(b => ({
            _kind: 'milbase' as const,
            _lat: b.lat,
            _lng: b.lon,
            id: b.id,
            name: b.name,
            type: b.type,
            country: b.country ?? '',
          }));
        }
        break;
      case 'nuclear':
        if (!this.nuclearSiteMarkers.length) {
          this.nuclearSiteMarkers = NUCLEAR_FACILITIES
            .filter(f => f.status !== 'decommissioned')
            .map(f => ({
              _kind: 'nuclearSite' as const,
              _lat: f.lat,
              _lng: f.lon,
              id: f.id,
              name: f.name,
              type: f.type,
              status: f.status,
            }));
        }
        break;
      case 'irradiators':
        if (!this.irradiatorSiteMarkers.length) {
          this.irradiatorSiteMarkers = (GAMMA_IRRADIATORS as GammaIrradiator[]).map(g => ({
            _kind: 'irradiator' as const,
            _lat: g.lat,
            _lng: g.lon,
            id: g.id,
            city: g.city,
            country: g.country,
          }));
        }
        break;
      case 'spaceports':
        if (!this.spaceportSiteMarkers.length) {
          this.spaceportSiteMarkers = (SPACEPORTS as Spaceport[])
            .filter(s => s.status === 'active')
            .map(s => ({
              _kind: 'spaceport' as const,
              _lat: s.lat,
              _lng: s.lon,
              id: s.id,
              name: s.name,
              country: s.country,
              operator: s.operator,
              launches: s.launches,
            }));
        }
        break;
      case 'economic':
        if (!this.economicMarkers.length) {
          this.economicMarkers = (ECONOMIC_CENTERS as EconomicCenter[]).map(c => ({
            _kind: 'economic' as const,
            _lat: c.lat,
            _lng: c.lon,
            id: c.id,
            name: c.name,
            type: c.type,
            country: c.country,
            description: c.description ?? '',
          }));
        }
        break;
      case 'datacenters':
        if (!this.datacenterMarkers.length) {
          this.datacenterMarkers = (AI_DATA_CENTERS as AIDataCenter[])
            .filter(d => d.status !== 'decommissioned')
            .map(d => ({
              _kind: 'datacenter' as const,
              _lat: d.lat,
              _lng: d.lon,
              id: d.id,
              name: d.name,
              owner: d.owner,
              country: d.country,
              chipType: d.chipType,
            }));
        }
        break;
      case 'waterways':
        if (!this.waterwayMarkers.length) {
          this.waterwayMarkers = (STRATEGIC_WATERWAYS as StrategicWaterway[]).map(w => ({
            _kind: 'waterway' as const,
            _lat: w.lat,
            _lng: w.lon,
            id: w.id,
            name: w.name,
            description: w.description ?? '',
          }));
        }
        break;
      case 'minerals':
        if (!this.mineralMarkers.length) {
          this.mineralMarkers = (CRITICAL_MINERALS as CriticalMineralProject[])
            .filter(m => m.status === 'producing' || m.status === 'development')
            .map(m => ({
              _kind: 'mineral' as const,
              _lat: m.lat,
              _lng: m.lon,
              id: m.id,
              name: m.name,
              mineral: m.mineral,
              country: m.country,
              status: m.status,
            }));
        }
        break;
      case 'tradeRoutes':
        if (!this.tradeRouteSegments.length) {
          this.tradeRouteSegments = resolveTradeRouteSegments();
        }
        break;
      case 'cables':
      case 'pipelines':
        if (!this.globePaths.length) {
          this.globePaths = [
            ...(UNDERSEA_CABLES as UnderseaCable[]).map(c => ({
              id: c.id,
              name: c.name,
              points: c.points,
              pathType: 'cable' as const,
              status: 'ok',
            })),
            ...(PIPELINES as Pipeline[]).map(p => ({
              id: p.id,
              name: p.name,
              points: p.points,
              pathType: p.type,
              status: p.status,
            })),
          ];
        }
        break;
    }
  }

  public setMilitaryFlights(flights: MilitaryFlight[]): void {
    this.flightData.clear();
    for (const f of flights) this.flightData.set(f.id, f);
    this.flights = flights.map(f => ({
      _kind: 'flight' as const,
      _lat: f.lat,
      _lng: f.lon,
      id: f.id,
      callsign: f.callsign ?? '',
      type: (f as any).aircraftType ?? (f as any).type ?? 'fighter',
      heading: (f as any).heading ?? 0,
    }));
    this.flushMarkers();
  }

  private static readonly FLIGHT_TYPE_COLORS: Record<string, string> = {
    fighter: '#ff4444', bomber: '#ff8800', recon: '#44aaff',
    tanker: '#88ff44', transport: '#aaaaff', helicopter: '#ffff44',
    drone: '#ff44ff', maritime: '#44ffff',
  };

  private static readonly VESSEL_TYPE_COLORS: Record<string, string> = {
    carrier:    '#ff4444',
    destroyer:  '#ff8800',
    frigate:    '#ffcc00',
    submarine:  '#8844ff',
    amphibious: '#44cc88',
    patrol:     '#44aaff',
    auxiliary:  '#aaaaaa',
    research:   '#44ffff',
    icebreaker: '#88ccff',
    special:    '#ff44ff',
  };

  private static readonly VESSEL_TYPE_ICONS: Record<string, string> = {
    carrier:    '\u26f4',
    destroyer:  '\u25b2',
    frigate:    '\u25b2',
    submarine:  '\u25c6',
    amphibious: '\u2b21',
    patrol:     '\u25b6',
    auxiliary:  '\u25cf',
    research:   '\u25ce',
    icebreaker: '\u2745',
    special:    '\u2605',
  };

  private static readonly CLUSTER_ACTIVITY_COLORS: Record<string, string> = {
    deployment: '#ff4444', exercise: '#ff8800', transit: '#ffcc00', unknown: '#6688aa',
  };

  private static readonly VESSEL_TYPE_LABELS: Record<string, string> = {
    carrier: 'Aircraft Carrier',
    destroyer: 'Destroyer',
    frigate: 'Frigate',
    submarine: 'Submarine',
    amphibious: 'Amphibious',
    patrol: 'Patrol',
    auxiliary: 'Auxiliary',
    research: 'Research',
    icebreaker: 'Icebreaker',
    special: 'Special Mission',
    unknown: 'Unknown',
  };

  public setMilitaryVessels(vessels: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    this.vesselData.clear();
    for (const v of vessels) this.vesselData.set(v.id, v);
    this.clusterData.clear();
    for (const c of clusters) this.clusterData.set(c.id, c);

    this.vessels = vessels.map(v => ({
      _kind: 'vessel' as const,
      _lat: v.lat,
      _lng: v.lon,
      id: v.id,
      name: v.name ?? 'vessel',
      type: v.vesselType,                                                    // raw enum — color/icon key
      typeLabel: GlobeMap.VESSEL_TYPE_LABELS[v.vesselType] ?? v.vesselType,  // display string
      hullNumber: v.hullNumber,
      operator: v.operator !== 'other' ? v.operator : undefined,
      operatorCountry: v.operatorCountry,
      isDark: v.isDark,
      usniStrikeGroup: v.usniStrikeGroup,
      usniRegion: v.usniRegion,
      usniDeploymentStatus: v.usniDeploymentStatus,
      usniHomePort: v.usniHomePort,
      usniActivityDescription: v.usniActivityDescription,
      usniArticleDate: v.usniArticleDate,
      usniSource: v.usniSource,
    }));
    this.clusterMarkers = clusters.map(c => ({
      _kind: 'cluster' as const,
      _lat: c.lat,
      _lng: c.lon,
      id: c.id,
      name: c.name,
      vesselCount: c.vesselCount,
      activityType: c.activityType,
      region: c.region,
    }));
    this.flushMarkers();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherMarkers = (alerts ?? [])
      .filter(a => a.centroid != null)
      .map(a => ({
        _kind: 'weather' as const,
        _lat: a.centroid![1],   // centroid is [lon, lat]
        _lng: a.centroid![0],
        id: a.id,
        severity: a.severity ?? 'Minor',
        headline: a.headline ?? a.event ?? '',
      }));
    this.flushMarkers();
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalMarkers = (events ?? []).map(e => ({
      _kind: 'natural' as const,
      _lat: e.lat,
      _lng: e.lon,
      id: e.id,
      category: e.category ?? '',
      title: e.title ?? '',
    }));

    const trackPaths: GlobePath[] = [];
    const conePolys: GlobePolygon[] = [];

    for (const e of events ?? []) {
      if (e.forecastTrack?.length) {
        trackPaths.push({
          id: `storm-forecast-${e.id}`,
          name: e.stormName || e.title || '',
          points: [
            [e.lon, e.lat, 0],
            ...e.forecastTrack.map(p => [p.lon, p.lat, 0]),
          ],
          pathType: 'stormTrack',
          status: 'active',
        });
      }
      if (e.pastTrack?.length) {
        let segIdx = 0;
        for (let i = 0; i < e.pastTrack.length - 1; i++) {
          const a = e.pastTrack[i]!;
          const b = e.pastTrack[i + 1]!;
          trackPaths.push({
            id: `storm-past-${e.id}-${segIdx++}`,
            name: e.stormName || e.title || '',
            points: [[a.lon, a.lat, 0], [b.lon, b.lat, 0]],
            pathType: 'stormHistory',
            status: 'active',
            windKt: b.windKt ?? a.windKt ?? 0,
          });
        }
      }
      if (e.conePolygon?.length) {
        for (const ring of e.conePolygon) {
          conePolys.push({
            coords: [ring],
            name: `${e.stormName || e.title || ''} Forecast Cone`,
            _kind: 'forecastCone',
          });
        }
      }
    }

    this.stormTrackPaths = trackPaths;
    this.stormConePolygons = conePolys;
    this.flushMarkers();
    this.flushPaths();
    this.flushPolygons();
  }

  // ─── Layer control ────────────────────────────────────────────────────────

  private static readonly LAYER_CHANNELS: Map<string, { markers: boolean; arcs: boolean; paths: boolean; polygons: boolean }> = new Map([
    ['ciiChoropleth', { markers: false, arcs: false, paths: false, polygons: true }],
    ['tradeRoutes',   { markers: false, arcs: true,  paths: false, polygons: false }],
    ['pipelines',     { markers: false, arcs: false, paths: true,  polygons: false }],
    ['conflicts',     { markers: true,  arcs: false, paths: false, polygons: true }],
    ['cables',        { markers: true,  arcs: false, paths: true,  polygons: false }],
    ['satellites',        { markers: true,  arcs: false, paths: true,  polygons: true }],

    ['natural',           { markers: true,  arcs: false, paths: true,  polygons: true }],
    ['webcams',           { markers: true,  arcs: false, paths: false, polygons: false }],
  ]);

  private flushLayerChannels(layer: keyof MapLayers): void {
    const ch = GlobeMap.LAYER_CHANNELS.get(layer);
    if (!ch) { this.flushMarkers(); return; }
    if (ch.markers)  this.flushMarkers();
    if (ch.arcs)     this.flushArcs();
    if (ch.paths)    this.flushPaths();
    if (ch.polygons) this.flushPolygons();
    if (layer === 'satellites' && this.satBeamGroup) {
      this.satBeamGroup.visible = !!this.layers.satellites;
    }
  }

  public setLayers(layers: MapLayers): void {
    const prev = this.layers;
    this.layers = { ...layers, dayNight: false };
    let needMarkers = false, needArcs = false, needPaths = false, needPolygons = false;
    for (const k of Object.keys(layers) as (keyof MapLayers)[]) {
      if (!prev[k] && layers[k]) this.ensureStaticDataForLayer(k);
      if (prev[k] === layers[k]) continue;
      const ch = GlobeMap.LAYER_CHANNELS.get(k);
      if (!ch) { needMarkers = true; continue; }
      if (ch.markers)  needMarkers = true;
      if (ch.arcs)     needArcs = true;
      if (ch.paths)    needPaths = true;
      if (ch.polygons) needPolygons = true;
    }
    if (needMarkers)  this.flushMarkers();
    if (needArcs)     this.flushArcs();
    if (needPaths)    this.flushPaths();
    if (needPolygons) this.flushPolygons();
    if (prev.satellites !== layers.satellites) {
      if (this.satBeamGroup) this.satBeamGroup.visible = !!layers.satellites;
      if (layers.satellites) {
        this.fetchImageryForViewport();
      } else {
        if (this.imageryFetchTimer) { clearTimeout(this.imageryFetchTimer); this.imageryFetchTimer = null; }
        this.lastImageryCenter = null;
        this.imageryFetchVersion++;
        this.imagerySceneMarkers = [];
        this.imageryFootprintPolygons = [];
      }
    }
  }

  public enableLayer(layer: keyof MapLayers): void {
    if (layer === 'dayNight') return;
    if (this.layers[layer]) return;
    (this.layers as any)[layer] = true;
    this.ensureStaticDataForLayer(layer);
    const toggle = this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement | null;
    if (toggle) toggle.checked = true;
    this.flushLayerChannels(layer);
    this.enforceLayerLimit();
  }

  private layerWarningShown = false;
  private lastActiveLayerCount = 0;

  private enforceLayerLimit(): void {
    if (!this.layerTogglesEl) return;
    const WARN_THRESHOLD = 13;
    const activeCount = Array.from(this.layerTogglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input'))
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

  // ─── Camera / navigation ──────────────────────────────────────────────────

  private static readonly VIEW_POVS: Record<MapView, { lat: number; lng: number; altitude: number }> = {
    global:   { lat: 20,  lng:  0,   altitude: 1.8 },
    america:  { lat: 20,  lng: -90,  altitude: 1.5 },
    mena:     { lat: 25,  lng:  40,  altitude: 1.2 },
    eu:       { lat: 50,  lng:  10,  altitude: 1.2 },
    asia:     { lat: 35,  lng: 105,  altitude: 1.5 },
    latam:    { lat: -15, lng: -60,  altitude: 1.5 },
    africa:   { lat:  5,  lng:  20,  altitude: 1.5 },
    oceania:  { lat: -25, lng: 140,  altitude: 1.5 },
  };

  public setView(view: MapView, zoom?: number): void {
    this.currentView = view;
    if (!this.globe) return;
    this.wakeGlobe();
    const preset = GlobeMap.VIEW_POVS[view] ?? GlobeMap.VIEW_POVS.global;
    let altitude = preset.altitude;
    if (zoom !== undefined) {
      if      (zoom >= 7) altitude = 0.08;
      else if (zoom >= 6) altitude = 0.15;
      else if (zoom >= 5) altitude = 0.3;
      else if (zoom >= 4) altitude = 0.5;
      else if (zoom >= 3) altitude = 0.8;
      else                altitude = 1.5;
    }
    this.globe.pointOfView({ lat: preset.lat, lng: preset.lng, altitude }, 1200);
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (!this.globe) return;
    this.wakeGlobe();
    // Map deck.gl zoom levels → globe.gl altitude
    // deck.gl: 2=world, 3=continent, 4=country, 5=region, 6+=city
    // globe.gl altitude: 1.8=full globe, 0.6=country, 0.15=city
    let altitude = 1.2;
    if (zoom !== undefined) {
      if      (zoom >= 7) altitude = 0.08;
      else if (zoom >= 6) altitude = 0.15;
      else if (zoom >= 5) altitude = 0.3;
      else if (zoom >= 4) altitude = 0.5;
      else if (zoom >= 3) altitude = 0.8;
      else                altitude = 1.5;
    }
    this.globe.pointOfView({ lat, lng: lon, altitude }, 1200);
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (!this.globe) return null;
    const pov = this.globe.pointOfView();
    return pov ? { lat: pov.lat, lon: pov.lng } : null;
  }

  public getBbox(): string | null {
    if (!this.globe) return null;
    const pov = this.globe.pointOfView();
    if (!pov) return null;
    const alt = pov.altitude ?? 2.0;
    const R = Math.min(90, Math.max(5, alt * 30));
    const south = Math.max(-90, pov.lat - R);
    const north = Math.min(90, pov.lat + R);
    const west = Math.max(-180, pov.lng - R);
    const east = Math.min(180, pov.lng + R);
    return `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`;
  }

  // ─── Resize ────────────────────────────────────────────────────────────────

  public resize(): void {
    if (!this.globe || this.destroyed) return;
    this.wakeGlobe();
    this.applyRenderQuality(undefined, this.container.clientWidth, this.container.clientHeight);
  }

  // ─── State API ────────────────────────────────────────────────────────────

  public getState(): MapContainerState {
    return {
      zoom: 1,
      pan: { x: 0, y: 0 },
      view: this.currentView,
      layers: this.layers,
      timeRange: this.timeRange,
    };
  }

  public setTimeRange(range: TimeRange): void {
    this.timeRange = range;
  }

  public getTimeRange(): TimeRange {
    return this.timeRange;
  }

  // ─── Callback setters ─────────────────────────────────────────────────────

  public setOnHotspotClick(cb: (h: Hotspot) => void): void {
    this.onHotspotClickCb = cb;
  }

  public setOnCountryClick(_cb: (c: CountryClickPayload) => void): void {
    // Globe country click not yet implemented — no-op
  }

  public setOnMapContextMenu(cb: (payload: { lat: number; lon: number; screenX: number; screenY: number }) => void): void {
    this.onMapContextMenuCb = cb;
  }

  // ─── No-op stubs (keep MapContainer happy) ────────────────────────────────
  public render(): void { this.resize(); }
  public setIsResizing(isResizing: boolean): void {
    // After drag-resize or fullscreen transition completes, re-sync dimensions
    if (!isResizing) this.resize();
  }
  public setZoom(_z: number): void {}
  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;

    if (paused) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      if (this.flushMaxTimer) { clearTimeout(this.flushMaxTimer); this.flushMaxTimer = null; }
      this.pendingFlushWhilePaused = true;
      if (this.autoRotateTimer) {
        clearTimeout(this.autoRotateTimer);
        this.autoRotateTimer = null;
      }
    }

    if (this.controls) {
      if (paused) {
        this.controlsAutoRotateBeforePause = this.controls.autoRotate;
        this.controlsDampingBeforePause = this.controls.enableDamping;
        this.controls.autoRotate = false;
        this.controls.enableDamping = false;
      } else {
        if (this.controlsAutoRotateBeforePause !== null) {
          this.controls.autoRotate = this.controlsAutoRotateBeforePause;
        }
        if (this.controlsDampingBeforePause !== null) {
          this.controls.enableDamping = this.controlsDampingBeforePause;
        }
        this.controlsAutoRotateBeforePause = null;
        this.controlsDampingBeforePause = null;
      }
    }

    if (!paused && this.pendingFlushWhilePaused) {
      this.pendingFlushWhilePaused = false;
      this.flushMarkers();
    }
  }
  public updateHotspotActivity(_news: any[]): void {}
  public updateMilitaryForEscalation(_f: any[], _v: any[]): void {}
  public getHotspotDynamicScore(_id: string) { return undefined; }
  public getHotspotLevels() { return {} as Record<string, string>; }
  public setHotspotLevels(_l: Record<string, string>): void {}
  public initEscalationGetters(): void {}
  public highlightAssets(_assets: any): void {}
  public setOnLayerChange(cb: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChangeCb = cb;
  }
  public setOnTimeRangeChange(_cb: any): void {}
  public hideLayerToggle(layer: keyof MapLayers): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.remove();
  }
  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('loading', loading);
  }
  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('no-data', !hasData);
  }
  public flashAssets(_type: string, _ids: string[]): void {}
  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    if (!this.globe || !this.initialized) return;
    const id = `flash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.flashMarkers.push({ _kind: 'flash', id, _lat: lat, _lng: lon });
    this.flushMarkers();
    setTimeout(() => {
      this.flashMarkers = this.flashMarkers.filter(m => m.id !== id);
      this.flushMarkers();
    }, durationMs);
  }
  public triggerHotspotClick(_id: string): void {}
  public triggerConflictClick(_id: string): void {}
  public triggerBaseClick(_id: string): void {}
  public triggerPipelineClick(_id: string): void {}
  public triggerCableClick(_id: string): void {}
  public triggerDatacenterClick(_id: string): void {}
  public triggerNuclearClick(_id: string): void {}
  public triggerIrradiatorClick(_id: string): void {}
  public fitCountry(code: string): void {
    if (!this.globe) return;
    const bbox = getCountryBbox(code);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lat = (minLat + maxLat) / 2;
    const lng = (minLon + maxLon) / 2;
    const span = Math.max(maxLat - minLat, maxLon - minLon);
    // Map geographic span → altitude: large country (Russia ~170°) vs small (Luxembourg ~0.5°)
    const altitude = span > 60 ? 1.0 : span > 20 ? 0.7 : span > 8 ? 0.45 : span > 3 ? 0.25 : 0.12;
    this.globe.pointOfView({ lat, lng, altitude }, 1200);
  }
  public highlightCountry(_code: string): void {}
  public clearCountryHighlight(): void {}
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakeMarkers = (earthquakes ?? [])
      .filter(e => e.location != null)
      .map(e => ({
        _kind: 'earthquake' as const,
        _lat: e.location!.latitude,
        _lng: e.location!.longitude,
        id: e.id,
        place: e.place ?? '',
        magnitude: e.magnitude ?? 0,
      }));
    this.flushMarkers();
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.radiationMarkers = (observations ?? []).map((observation) => ({
      _kind: 'radiation' as const,
      _lat: observation.lat,
      _lng: observation.lon,
      id: observation.id,
      location: observation.location,
      country: observation.country,
      source: observation.source,
      contributingSources: observation.contributingSources,
      value: observation.value,
      unit: observation.unit,
      observedAt: observation.observedAt,
      freshness: observation.freshness,
      baselineValue: observation.baselineValue,
      delta: observation.delta,
      zScore: observation.zScore,
      severity: observation.severity,
      confidence: observation.confidence,
      corroborated: observation.corroborated,
      conflictingSources: observation.conflictingSources,
      convertedFromCpm: observation.convertedFromCpm,
      sourceCount: observation.sourceCount,
    }));
    this.flushMarkers();
  }

  public setImageryScenes(scenes: ImageryScene[]): void {
    const valid = (scenes ?? []).filter(s => {
      try {
        const geom = JSON.parse(s.geometryGeojson);
        return geom?.type === 'Polygon' && geom.coordinates?.[0]?.[0];
      } catch { return false; }
    });
    this.imagerySceneMarkers = valid.map(s => {
      const geom = JSON.parse(s.geometryGeojson);
      const coords = geom.coordinates[0] as number[][];
      const lats = coords.map(c => c[1] ?? 0);
      const lons = coords.map(c => c[0] ?? 0);
      const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
      const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
      return {
        _kind: 'imageryScene' as const,
        _lat: centerLat,
        _lng: centerLon,
        satellite: s.satellite,
        datetime: s.datetime,
        resolutionM: s.resolutionM,
        mode: s.mode,
        previewUrl: s.previewUrl,
      };
    });
    this.imageryFootprintPolygons = valid.map(s => {
      const geom = JSON.parse(s.geometryGeojson);
      return {
        coords: geom.coordinates as number[][][],
        name: `${s.satellite} ${s.datetime}`,
        _kind: 'imageryFootprint' as const,
        satellite: s.satellite,
        datetime: s.datetime,
        resolutionM: s.resolutionM,
        mode: s.mode,
        previewUrl: s.previewUrl,
      };
    });
    if (this.layers.satellites) {
      this.flushMarkers();
      this.flushPolygons();
    }
  }

  private async fetchImageryForViewport(): Promise<void> {
    if (this.destroyed) return;
    const center = this.getCenter();
    if (!center) return;
    if (this.lastImageryCenter) {
      const dLat = Math.abs(center.lat - this.lastImageryCenter.lat);
      const dLon = Math.abs(center.lon - this.lastImageryCenter.lon);
      if (dLat < 2 && dLon < 2) return;
    }
    const R = 5;
    const south = Math.max(-90, center.lat - R);
    const north = Math.min(90, center.lat + R);
    const west = Math.max(-180, center.lon - R);
    const east = Math.min(180, center.lon + R);
    const bbox = `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`;
    const thisVersion = ++this.imageryFetchVersion;
    try {
      const { fetchImageryScenes } = await import('@/services/imagery');
      const scenes = await fetchImageryScenes({ bbox, limit: 20 });
      if (thisVersion !== this.imageryFetchVersion) return;
      this.setImageryScenes(scenes);
      this.lastImageryCenter = { lat: center.lat, lon: center.lon };
    } catch { /* imagery is best-effort */ }
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outageMarkers = (outages ?? []).filter(o => o.lat != null && o.lon != null).map(o => ({
      _kind: 'outage' as const,
      _lat: o.lat,
      _lng: o.lon,
      id: o.id,
      title: o.title ?? '',
      severity: o.severity ?? 'partial',
      country: o.country ?? '',
    }));
    this.flushMarkers();
  }

  public setTrafficAnomalies(anomalies: ProtoTrafficAnomaly[]): void {
    this.trafficAnomalyMarkers = (anomalies ?? [])
      .filter(a => a.latitude !== 0 || a.longitude !== 0)
      .map(a => ({
        _kind: 'trafficAnomaly' as const,
        _lat: a.latitude,
        _lng: a.longitude,
        id: a.uuid || `ta-${a.locationCode}-${a.startDate}`,
        type: a.type || '',
        locationName: a.locationName || '',
      }));
    this.flushMarkers();
  }

  public setDdosLocations(hits: DdosLocationHit[]): void {
    this.ddosMarkers = (hits ?? [])
      .filter(h => h.latitude !== 0 || h.longitude !== 0)
      .map(h => ({
        _kind: 'ddosHit' as const,
        _lat: h.latitude,
        _lng: h.longitude,
        id: `ddos-${h.countryCode}`,
        countryName: h.countryName || '',
        percentage: h.percentage || 0,
      }));
    this.flushMarkers();
  }

  public setAisData(disruptions: AisDisruptionEvent[], _density: AisDensityZone[]): void {
    // AisDensityZone requires a heatmap layer — render disruption events only
    this.aisMarkers = (disruptions ?? [])
      .filter(d => d.lat != null && d.lon != null)
      .map(d => ({
        _kind: 'aisDisruption' as const,
        _lat: d.lat,
        _lng: d.lon,
        id: d.id,
        name: d.name,
        type: d.type,
        severity: d.severity,
        description: d.description ?? '',
      }));
    this.flushMarkers();
  }
  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisoryMarkers = (advisories ?? [])
      .filter(a => a.lat != null && a.lon != null)
      .map(a => ({
        _kind: 'cableAdvisory' as const,
        _lat: a.lat,
        _lng: a.lon,
        id: a.id,
        cableId: a.cableId,
        title: a.title ?? '',
        severity: a.severity,
        impact: a.impact ?? '',
        repairEta: a.repairEta ?? '',
      }));
    this.repairShipMarkers = (repairShips ?? [])
      .filter(r => r.lat != null && r.lon != null)
      .map(r => ({
        _kind: 'repairShip' as const,
        _lat: r.lat,
        _lng: r.lon,
        id: r.id,
        name: r.name ?? '',
        status: r.status,
        eta: r.eta ?? '',
        operator: r.operator ?? '',
      }));
    this.cableFaultIds    = new Set((advisories ?? []).filter(a => a.severity === 'fault').map(a => a.cableId));
    this.cableDegradedIds = new Set((advisories ?? []).filter(a => a.severity === 'degraded').map(a => a.cableId));
    this.flushMarkers();
    this.flushPaths();
  }
  public setCableHealth(_m: any): void {}
  public setProtests(events: SocialUnrestEvent[]): void {
    this.protestMarkers = (events ?? []).filter(e => e.lat != null && e.lon != null).map(e => ({
      _kind: 'protest' as const,
      _lat: e.lat,
      _lng: e.lon,
      id: e.id,
      title: e.title ?? '',
      eventType: e.eventType ?? 'protest',
      country: e.country ?? '',
    }));
    this.flushMarkers();
  }
  public setFlightDelays(delays: AirportDelayAlert[]): void {
    this.flightDelayMarkers = (delays ?? [])
      .filter(d => d.lat != null && d.lon != null && d.severity !== 'normal')
      .map(d => ({
        _kind: 'flightDelay' as const,
        _lat: d.lat,
        _lng: d.lon,
        id: d.id,
        iata: d.iata,
        name: d.name,
        city: d.city,
        country: d.country,
        severity: d.severity,
        delayType: d.delayType,
        avgDelayMinutes: d.avgDelayMinutes,
        reason: d.reason ?? '',
      }));
    this.notamRingMarkers = (delays ?? [])
      .filter(d => d.lat != null && d.lon != null && d.delayType === 'closure')
      .map(d => ({
        _kind: 'notamRing' as const,
        _lat: d.lat,
        _lng: d.lon,
        name: d.name || d.iata,
        reason: d.reason || 'Airspace closure',
      }));
    this.flushMarkers();
  }
  public setNewsLocations(data: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }>): void {
    this.newsLocationMarkers = (data ?? [])
      .filter(d => d.lat != null && d.lon != null)
      .map((d, i) => ({
        _kind: 'newsLocation' as const,
        _lat: d.lat,
        _lng: d.lon,
        id: `news-${i}-${d.title.slice(0, 20)}`,
        title: d.title,
        threatLevel: d.threatLevel ?? 'info',
      }));
    this.flushMarkers();
  }
  public setPositiveEvents(_events: any[]): void {}
  public setKindnessData(_points: any[]): void {}
  public setHappinessScores(_data: any): void {}
  public setSpeciesRecoveryZones(_zones: any[]): void {}
  public setRenewableInstallations(_installations: any[]): void {}
  public setCyberThreats(threats: CyberThreat[]): void {
    this.cyberMarkers = (threats ?? []).filter(t => t.lat != null && t.lon != null).map(t => ({
      _kind: 'cyber' as const,
      _lat: t.lat,
      _lng: t.lon,
      id: t.id,
      indicator: t.indicator ?? '',
      severity: t.severity ?? 'low',
      type: t.type ?? 'malware_host',
    }));
    this.flushMarkers();
  }
  public setIranEvents(events: IranEvent[]): void {
    this.iranMarkers = (events ?? []).filter(e => e.latitude != null && e.longitude != null).map(e => ({
      _kind: 'iran' as const,
      _lat: e.latitude,
      _lng: e.longitude,
      id: e.id,
      title: e.title ?? '',
      category: e.category ?? '',
      severity: e.severity ?? 'moderate',
      location: e.locationName ?? '',
    }));
    this.flushMarkers();
  }
  public setFires(fires: Array<{ lat: number; lon: number; brightness: number; region: string; [key: string]: any }>): void {
    this.fireMarkers = (fires ?? []).filter(f => f.lat != null && f.lon != null).map(f => ({
      _kind: 'fire' as const,
      _lat: f.lat,
      _lng: f.lon,
      id: (f.id as string | undefined) ?? `${f.lat},${f.lon}`,
      region: f.region ?? '',
      brightness: f.brightness ?? 330,
    }));
    this.flushMarkers();
  }
  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.webcamMarkers = markers.map(m => {
      if ('count' in m) {
        return { _kind: 'webcam-cluster' as const, _lat: m.lat, _lng: m.lng, count: m.count, categories: m.categories || [] };
      }
      return { _kind: 'webcam' as const, _lat: m.lat, _lng: m.lng, webcamId: m.webcamId, title: m.title, category: m.category || 'other', country: m.country || '' };
    });
    this.flushMarkers();
  }
  public setUcdpEvents(events: UcdpGeoEvent[]): void {
    this.ucdpMarkers = (events ?? []).filter(e => e.latitude != null && e.longitude != null).map(e => ({
      _kind: 'ucdp' as const,
      _lat: e.latitude,
      _lng: e.longitude,
      id: e.id,
      sideA: e.side_a ?? '',
      sideB: e.side_b ?? '',
      deaths: e.deaths_best ?? 0,
      country: e.country ?? '',
    }));
    this.flushMarkers();
  }
  public setDisplacementFlows(flows: DisplacementFlow[]): void {
    this.displacementMarkers = (flows ?? [])
      .filter(f => f.originLat != null && f.originLon != null)
      .map(f => ({
        _kind: 'displacement' as const,
        _lat: f.originLat!,
        _lng: f.originLon!,
        id: `${f.originCode}-${f.asylumCode}`,
        origin: f.originName ?? f.originCode,
        asylum: f.asylumName ?? f.asylumCode,
        refugees: f.refugees ?? 0,
      }));
    this.flushMarkers();
  }
  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.climateMarkers = (anomalies ?? []).filter(a => a.lat != null && a.lon != null).map(a => ({
      _kind: 'climate' as const,
      _lat: a.lat,
      _lng: a.lon,
      id: `${a.zone}-${a.period}`,
      zone: a.zone ?? '',
      type: a.type ?? 'mixed',
      severity: a.severity ?? 'normal',
      tempDelta: a.tempDelta ?? 0,
    }));
    this.flushMarkers();
  }
  public setGpsJamming(hexes: GpsJamHex[]): void {
    this.gpsJamMarkers = (hexes ?? []).filter(h => h.lat != null && h.lon != null).map(h => ({
      _kind: 'gpsjam' as const,
      _lat: h.lat,
      _lng: h.lon,
      id: h.h3,
      level: h.level,
      npAvg: h.npAvg ?? 0,
    }));
    this.flushMarkers();
  }

  private static latLngAltToVec3(lat: number, lng: number, alt: number, vec3Ctor: any): any {
    const GLOBE_R = 100;
    const r = GLOBE_R * (1 + alt / 6371);
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (90 - lng) * (Math.PI / 180);
    const sinPhi = Math.sin(phi);
    return new vec3Ctor(
      r * sinPhi * Math.cos(theta),
      r * Math.cos(phi),
      r * sinPhi * Math.sin(theta),
    );
  }

  private async rebuildSatBeams(positions: SatellitePosition[]): Promise<void> {
    if (!this.globe || this.destroyed) return;
    const THREE = await import('three');
    const scene = this.globe.scene();

    if (this.satBeamGroup) {
      scene.remove(this.satBeamGroup);
      this.satBeamGroup.traverse((child: any) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    this.satBeamGroup = new THREE.Group();
    this.satBeamGroup.name = 'satBeams';

    if (!this.layers.satellites || positions.length === 0) return;

    const colorMap: Record<string, number> = {
      CN: 0xff2020, RU: 0xff8800, US: 0x4488ff, EU: 0x44cc44,
      KR: 0xaa66ff, IN: 0xff66aa, TR: 0xff4466, OTHER: 0xccccff,
    };

    const RAY_COUNT = 6;
    const GLOBE_R = 100;
    const BEAM_HEIGHT = 25;
    const GROUND_SPREAD_RAD = 4.0;

    const allRayPositions: number[] = [];
    const allRayColors: number[] = [];
    const allConePositions: number[] = [];
    const allConeColors: number[] = [];

    const tmpColor = new THREE.Color();

    for (const s of positions) {
      const groundCenter = GlobeMap.latLngAltToVec3(s.lat, s.lng, 0, THREE.Vector3);
      const beamTop = new THREE.Vector3().copy(groundCenter).normalize().multiplyScalar(GLOBE_R + BEAM_HEIGHT);

      const hex = colorMap[s.country] ?? 0xccccff;
      tmpColor.setHex(hex);
      const r = tmpColor.r, g = tmpColor.g, b = tmpColor.b;

      const dir = new THREE.Vector3().copy(groundCenter).normalize().negate();
      const up = new THREE.Vector3(0, 1, 0);
      if (Math.abs(dir.dot(up)) > 0.99) up.set(1, 0, 0);
      const right = new THREE.Vector3().crossVectors(dir, up).normalize();
      const forward = new THREE.Vector3().crossVectors(right, dir).normalize();

      const groundPts: InstanceType<typeof THREE.Vector3>[] = [];
      for (let i = 0; i < RAY_COUNT; i++) {
        const angle = (i / RAY_COUNT) * Math.PI * 2;
        const gp = new THREE.Vector3()
          .copy(groundCenter)
          .addScaledVector(right, Math.cos(angle) * GROUND_SPREAD_RAD)
          .addScaledVector(forward, Math.sin(angle) * GROUND_SPREAD_RAD)
          .normalize().multiplyScalar(GLOBE_R);
        groundPts.push(gp);
        allRayPositions.push(beamTop.x, beamTop.y, beamTop.z, gp.x, gp.y, gp.z);
        allRayColors.push(r, g, b, r * 0.3, g * 0.3, b * 0.3);
      }

      for (let i = 0; i < RAY_COUNT; i++) {
        const next = (i + 1) % RAY_COUNT;
        const gi = groundPts[i]!;
        const gn = groundPts[next]!;
        allConePositions.push(
          beamTop.x, beamTop.y, beamTop.z,
          gi.x, gi.y, gi.z,
          gn.x, gn.y, gn.z,
        );
        allConeColors.push(r, g, b, r * 0.2, g * 0.2, b * 0.2, r * 0.2, g * 0.2, b * 0.2);
      }
    }

    if (allRayPositions.length > 0) {
      const rayGeo = new THREE.BufferGeometry();
      rayGeo.setAttribute('position', new THREE.Float32BufferAttribute(allRayPositions, 3));
      rayGeo.setAttribute('color', new THREE.Float32BufferAttribute(allRayColors, 3));
      const rayMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
      });
      this.satBeamGroup.add(new THREE.LineSegments(rayGeo, rayMat));
    }

    if (allConePositions.length > 0) {
      const coneGeo = new THREE.BufferGeometry();
      coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(allConePositions, 3));
      coneGeo.setAttribute('color', new THREE.Float32BufferAttribute(allConeColors, 3));
      const coneMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.1,
        side: THREE.DoubleSide, depthWrite: false,
      });
      this.satBeamGroup.add(new THREE.Mesh(coneGeo, coneMat));
    }

    this.satBeamGroup.visible = !!this.layers.satellites;
    scene.add(this.satBeamGroup);
  }

  public setSatellites(positions: SatellitePosition[]): void {
    this.satelliteMarkers = positions.map(s => ({
      _kind: 'satellite' as const,
      _lat: s.lat,
      _lng: s.lng,
      id: s.noradId,
      name: s.name,
      country: s.country,
      type: s.type,
      alt: s.alt,
      velocity: s.velocity,
      inclination: s.inclination,
    }));

    this.satelliteFootprintMarkers = positions.map(s => ({
      _kind: 'satFootprint' as const,
      _lat: s.lat,
      _lng: s.lng,
      country: s.country,
      noradId: s.noradId,
    }));

    this.satelliteTrailPaths = positions
      .filter(s => s.trail && s.trail.length > 1)
      .map(s => ({
        id: `orbit-${s.noradId}`,
        name: s.name,
        points: [[s.lng, s.lat, s.alt], ...s.trail],
        pathType: 'orbit' as const,
        status: 'active',
        country: s.country,
      }));

    this.rebuildSatBeams(positions);
    this.flushMarkers();
    this.flushPaths();
  }
  public setTechEvents(events: Array<{ id: string; title: string; lat: number; lng: number; country: string; daysUntil: number; [key: string]: any }>): void {
    this.techMarkers = (events ?? []).filter(e => e.lat != null && e.lng != null).map(e => ({
      _kind: 'tech' as const,
      _lat: e.lat,
      _lng: e.lng,
      id: e.id,
      title: e.title ?? '',
      country: e.country ?? '',
      daysUntil: e.daysUntil ?? 0,
    }));
    this.flushMarkers();
  }
  public onHotspotClicked(cb: (h: Hotspot) => void): void { this.onHotspotClickCb = cb; }
  public onTimeRangeChanged(_cb: (r: TimeRange) => void): void {}
  public onStateChanged(_cb: (s: MapContainerState) => void): void {}
  public setOnCountry(_cb: any): void {}
  public getHotspotLevel(_id: string) { return 'low'; }

  private async applyEnhancedVisuals(): Promise<void> {
    if (!this.globe || this.destroyed) return;
    try {
      const THREE = await import('three');
      const scene = this.globe.scene();

      const oldMat = this.globe.globeMaterial();
      if (oldMat) {
        const stdMat = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 0.8, metalness: 0.1,
          emissive: new THREE.Color(0x0a1f2e), emissiveIntensity: 0.3,
        });
        if ((oldMat as any).map) stdMat.map = (oldMat as any).map;
        (this.globe as any).globeMaterial(stdMat);
      }

      this.cyanLight = new THREE.PointLight(0x00d4ff, 0.3);
      this.cyanLight.position.set(-10, -10, -10);
      scene.add(this.cyanLight);

      const outerGeo = new THREE.SphereGeometry(2.15, 24, 24);
      const outerMat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff, side: THREE.BackSide, transparent: true, opacity: 0.15,
      });
      this.outerGlow = new THREE.Mesh(outerGeo, outerMat);
      scene.add(this.outerGlow);

      const innerGeo = new THREE.SphereGeometry(2.08, 24, 24);
      const innerMat = new THREE.MeshBasicMaterial({
        color: 0x00a8cc, side: THREE.BackSide, transparent: true, opacity: 0.1,
      });
      this.innerGlow = new THREE.Mesh(innerGeo, innerMat);
      scene.add(this.innerGlow);

      const starCount = 600;
      const starPositions = new Float32Array(starCount * 3);
      const starColors = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        const r = 50 + Math.random() * 50;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        starPositions[i * 3 + 2] = r * Math.cos(phi);
        const brightness = 0.5 + Math.random() * 0.5;
        starColors[i * 3] = brightness;
        starColors[i * 3 + 1] = brightness;
        starColors[i * 3 + 2] = brightness;
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
      starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
      const starMat = new THREE.PointsMaterial({ size: 0.1, vertexColors: true, transparent: true });
      this.starField = new THREE.Points(starGeo, starMat);
      scene.add(this.starField);

      this.startExtrasLoop();
    } catch { /* cosmetic — ignore */ }
  }

  private startExtrasLoop(): void {
    if (this.extrasAnimFrameId != null) return;
    const animateExtras = () => {
      if (this.destroyed) return;
      if (this.outerGlow) this.outerGlow.rotation.y += 0.0003;
      if (this.starField) this.starField.rotation.y += 0.00005;
      this.extrasAnimFrameId = requestAnimationFrame(animateExtras);
    };
    animateExtras();
  }

  private removeEnhancedVisuals(): void {
    if (!this.globe) return;
    if (this.extrasAnimFrameId != null) {
      cancelAnimationFrame(this.extrasAnimFrameId);
      this.extrasAnimFrameId = null;
    }
    const scene = this.globe.scene();
    for (const obj of [this.outerGlow, this.innerGlow, this.starField, this.cyanLight]) {
      if (!obj) continue;
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    const mat = this.globe.globeMaterial();
    if (mat && (mat as any).isMeshStandardMaterial) {
      const texMap = (mat as any).map;
      mat.dispose();
      if (this.savedDefaultMaterial) {
        if (texMap) (this.savedDefaultMaterial as any).map = texMap;
        (this.globe as any).globeMaterial(this.savedDefaultMaterial);
      }
    }
    this.outerGlow = null;
    this.innerGlow = null;
    this.starField = null;
    this.cyanLight = null;
  }

  private applyVisualPreset(preset: GlobeVisualPreset): void {
    if (!this.globe || this.destroyed) return;
    if (preset === 'enhanced') {
      this.removeEnhancedVisuals();
      this.applyEnhancedVisuals();
    } else {
      this.removeEnhancedVisuals();
    }
  }

  // ─── Render quality & performance profile ────────────────────────────────

  private applyRenderQuality(scale?: GlobeRenderScale, width?: number, height?: number): void {
    if (!this.globe) return;
    try {
      const desktop = isDesktopRuntime();
      const pr = desktop
        ? Math.min(resolveGlobePixelRatio(scale ?? getGlobeRenderScale()), 1.25)
        : resolveGlobePixelRatio(scale ?? getGlobeRenderScale());
      const renderer = this.globe.renderer();
      renderer.setPixelRatio(pr);
      const w = (width ?? this.container.clientWidth) || window.innerWidth;
      const h = (height ?? this.container.clientHeight) || window.innerHeight;
      if (w > 0 && h > 0) this.globe.width(w).height(h);
    } catch { /* best-effort */ }
  }

  private applyPerformanceProfile(profile: GlobePerformanceProfile): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;

    const prevPulse = this._pulseEnabled;
    this._pulseEnabled = !profile.disablePulseAnimations;

    if (profile.disableDashAnimations) {
      (this.globe as any).arcDashAnimateTime(0);
      (this.globe as any).pathDashAnimateTime(0);
    } else {
      (this.globe as any).arcDashAnimateTime(5000);
      (this.globe as any).pathDashAnimateTime((d: GlobePath) => {
        if (!d) return 5000;
        if (d.pathType === 'orbit') return 0;
        if (d.pathType === 'cable') return 0;
        return 5000;
      });
    }

    if (profile.disableAtmosphere) {
      this.globe.atmosphereAltitude(0);
      if (this.outerGlow) this.outerGlow.visible = false;
      if (this.innerGlow) this.innerGlow.visible = false;
    } else {
      this.globe.atmosphereAltitude(0.18);
      if (this.outerGlow) this.outerGlow.visible = true;
      if (this.innerGlow) this.innerGlow.visible = true;
    }

    if (prevPulse !== this._pulseEnabled) {
      this.flushMarkers();
    }
  }

  // ─── Idle rendering control ──────────────────────────────────────────────
  // globe.gl runs requestAnimationFrame at 60fps continuously.
  // Pause when idle to save CPU; resume on interaction or data change.

  private wakeGlobe(): void {
    if (this.destroyed || !this.globe) return;
    if (!this.isGlobeAnimating) {
      this.isGlobeAnimating = true;
      try { (this.globe as any).resumeAnimation?.(); } catch { /* best-effort */ }
    }
    this.scheduleIdlePause();
  }

  private scheduleIdlePause(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // After 3 seconds of no interaction/data change, pause rendering
    this.idleTimer = setTimeout(() => {
      if (this.destroyed || !this.globe || this.renderPaused) return;
      // Don't pause if auto-rotate is active (user expects continuous spin)
      if (this.controls?.autoRotate) return;
      this.isGlobeAnimating = false;
      try { (this.globe as any).pauseAnimation?.(); } catch { /* best-effort */ }
    }, 3000);
  }

  private setupVisibilityHandler(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        if (this.isGlobeAnimating && this.globe) {
          this.isGlobeAnimating = false;
          try { (this.globe as any).pauseAnimation?.(); } catch { /* ignore */ }
        }
        if (this.extrasAnimFrameId != null) {
          cancelAnimationFrame(this.extrasAnimFrameId);
          this.extrasAnimFrameId = null;
        }
      } else {
        this.wakeGlobe();
        if (this.outerGlow && this.extrasAnimFrameId == null) {
          this.startExtrasLoop();
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // ─── Destroy ──────────────────────────────────────────────────────────────

  public destroy(): void {
    this.popup?.hide();
    this.popup = null;
    this.flightData.clear();
    this.vesselData.clear();
    this.clusterData.clear();
    this.container.removeEventListener('contextmenu', this.handleContextMenu);
    this.unsubscribeGlobeQuality?.();
    this.unsubscribeGlobeQuality = null;
    this.unsubscribeGlobeTexture?.();
    this.unsubscribeGlobeTexture = null;
    this.unsubscribeVisualPreset?.();
    this.unsubscribeVisualPreset = null;
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.imageryFetchTimer) { clearTimeout(this.imageryFetchTimer); this.imageryFetchTimer = null; }
    this.imageryFetchVersion++;
    if (this.controlsEndHandler && this.controls) {
      this.controls.removeEventListener('end', this.controlsEndHandler);
      this.controlsEndHandler = null;
    }
    this.destroyed = true;
    if (this.extrasAnimFrameId != null) {
      cancelAnimationFrame(this.extrasAnimFrameId);
      this.extrasAnimFrameId = null;
    }
    const scene = this.globe?.scene();
    if (this.satBeamGroup && scene) {
      scene.remove(this.satBeamGroup);
      this.satBeamGroup.traverse((child: any) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this.satBeamGroup = null;
    }
    for (const obj of [this.outerGlow, this.innerGlow, this.starField, this.cyanLight]) {
      if (!obj) continue;
      if (scene) scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    if (this.globe) {
      const mat = this.globe.globeMaterial();
      if (mat && (mat as any).isMeshStandardMaterial) mat.dispose();
    }
    this.outerGlow = null;
    this.innerGlow = null;
    this.starField = null;
    this.cyanLight = null;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.flushMaxTimer) { clearTimeout(this.flushMaxTimer); this.flushMaxTimer = null; }
    if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    this.reversedRingCache.clear();
    this.hideTooltip();
    if (this.satHoverStyle) { this.satHoverStyle.remove(); this.satHoverStyle = null; }
    this.controls = null;
    this.controlsAutoRotateBeforePause = null;
    this.controlsDampingBeforePause = null;
    this.layerTogglesEl = null;
    if (this.globe) {
      try { this.globe._destructor(); } catch { /* ignore */ }
      this.globe = null;
    }
    this.container.innerHTML = '';
    this.container.classList.remove('globe-mode');
    this.container.style.cssText = '';
  }
}
