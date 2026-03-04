/**
 * GlobeMap - 3D interactive globe using globe.gl
 *
 * Matches WorldMonitor's MapContainer API so it can be used as a drop-in
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
import { INTEL_HOTSPOTS, CONFLICT_ZONES, GEOPOLITICAL_BOUNDARIES, MILITARY_BASES, NUCLEAR_FACILITIES, SPACEPORTS, ECONOMIC_CENTERS, STRATEGIC_WATERWAYS, CRITICAL_MINERALS, UNDERSEA_CABLES } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { t } from '@/services/i18n';
import { SITE_VARIANT } from '@/config/variant';
import { getGlobeRenderScale, resolveGlobePixelRatio, subscribeGlobeRenderScaleChange, type GlobeRenderScale } from '@/services/globe-render-settings';
import { getLayersForVariant, resolveLayerLabel, type MapVariant } from '@/config/map-layer-definitions';
import { resolveTradeRouteSegments, type TradeRouteSegment } from '@/config/trade-routes';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { getCountryBbox } from '@/services/country-geometry';
import type { MapLayers, Hotspot, MilitaryFlight, MilitaryVessel, NaturalEvent, InternetOutage, CyberThreat, SocialUnrestEvent, UcdpGeoEvent, MilitaryBase, GammaIrradiator, Spaceport, EconomicCenter, StrategicWaterway, CriticalMineralProject, AIDataCenter, UnderseaCable, Pipeline, CableAdvisory, RepairShip, AisDisruptionEvent, AisDensityZone, AisDisruptionType } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { AirportDelayAlert } from '@/services/aviation';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { WeatherAlert } from '@/services/weather';
import type { IranEvent } from '@/services/conflict';
import type { DisplacementFlow } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';

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
  type: string;
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
  pct: number;
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
interface GlobePath {
  id: string;
  name: string;
  points: [number, number][];
  pathType: 'cable' | 'oil' | 'gas' | 'products';
  status: string;
}
type GlobeMarker =
  | ConflictMarker | HotspotMarker | FlightMarker | VesselMarker
  | WeatherMarker | NaturalMarker | IranMarker | OutageMarker
  | CyberMarker | FireMarker | ProtestMarker
  | UcdpMarker | DisplacementMarker | ClimateMarker | GpsJamMarker | TechMarker
  | ConflictZoneMarker | MilBaseMarker | NuclearSiteMarker | IrradiatorSiteMarker | SpaceportSiteMarker
  | EarthquakeMarker | EconomicMarker | DatacenterMarker | WaterwayMarker | MineralMarker
  | FlightDelayMarker | CableAdvisoryMarker | RepairShipMarker | AisDisruptionMarker
  | NewsLocationMarker | FlashMarker;

interface GlobeControlsLike {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enablePan: boolean;
  enableZoom: boolean;
  zoomSpeed: number;
  minDistance: number;
  maxDistance: number;
  enableDamping: boolean;
}

export class GlobeMap {
  private container: HTMLElement;
  private globe: GlobeInstance | null = null;
  private unsubscribeGlobeQuality: (() => void) | null = null;
  private controls: GlobeControlsLike | null = null;
  private renderPaused = false;
  private pendingFlushWhilePaused = false;
  private controlsAutoRotateBeforePause: boolean | null = null;
  private controlsDampingBeforePause: boolean | null = null;

  private initialized = false;
  private destroyed = false;
  private flushTimer: ReturnType<typeof requestAnimationFrame> | null = null;

  // Current data
  private hotspots: HotspotMarker[] = [];
  private flights: FlightMarker[] = [];
  private vessels: VesselMarker[] = [];
  private weatherMarkers: WeatherMarker[] = [];
  private naturalMarkers: NaturalMarker[] = [];
  private iranMarkers: IranMarker[] = [];
  private outageMarkers: OutageMarker[] = [];
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
  private economicMarkers: EconomicMarker[] = [];
  private datacenterMarkers: DatacenterMarker[] = [];
  private waterwayMarkers: WaterwayMarker[] = [];
  private mineralMarkers: MineralMarker[] = [];
  private flightDelayMarkers: FlightDelayMarker[] = [];
  private newsLocationMarkers: NewsLocationMarker[] = [];
  private flashMarkers: FlashMarker[] = [];
  private cableAdvisoryMarkers: CableAdvisoryMarker[] = [];
  private repairShipMarkers: RepairShipMarker[] = [];
  private aisMarkers: AisDisruptionMarker[] = [];
  private tradeRouteSegments: TradeRouteSegment[] = [];
  private globePaths: GlobePath[] = [];
  private cableFaultIds = new Set<string>();
  private cableDegradedIds = new Set<string>();

  // Current layers state
  private layers: MapLayers;
  private timeRange: TimeRange;
  private currentView: MapView = 'global';

  // Click callbacks
  private onHotspotClickCb: ((h: Hotspot) => void) | null = null;

  // Auto-rotate timer (like Sentinel: resume after 60 s idle)
  private autoRotateTimer: ReturnType<typeof setTimeout> | null = null;

  // ResizeObserver keeps the canvas in sync with the container
  private resizeObserver: ResizeObserver | null = null;

  // Overlay UI elements
  private layerTogglesEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;

  // Callbacks
  private onLayerChangeCb: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;

  constructor(container: HTMLElement, initialState: MapContainerState) {
    this.container = container;
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

    const applyRenderQuality = (scale?: GlobeRenderScale, width?: number, height?: number) => {
      try {
        const pr = desktop
          ? Math.min(resolveGlobePixelRatio(scale ?? getGlobeRenderScale()), 1.25)
          : resolveGlobePixelRatio(scale ?? getGlobeRenderScale());
        const renderer = globe.renderer();
        renderer.setPixelRatio(pr);
        const w = (width ?? this.container.clientWidth) || window.innerWidth;
        const h = (height ?? this.container.clientHeight) || window.innerHeight;
        if (w > 0 && h > 0) globe.width(w).height(h);
      } catch {
        // best-effort
      }
    };

    applyRenderQuality(initialScale);
    this.unsubscribeGlobeQuality?.();
    this.unsubscribeGlobeQuality = subscribeGlobeRenderScaleChange((scale) => applyRenderQuality(scale));

    // Initial sizing: use container dimensions, fall back to window if not yet laid out
    const initW = this.container.clientWidth || window.innerWidth;
    const initH = this.container.clientHeight || window.innerHeight;

    globe
      .globeImageUrl('/textures/earth-topo-bathy.jpg')
      .backgroundImageUrl('/textures/night-sky.png')
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

    // Force the canvas to visually fill the container so it expands with CSS transitions.
    // globe.gl sets explicit width/height attributes; we override the CSS so the canvas
    // always covers the full container even before the next renderer resize fires.
    const glCanvas = this.container.querySelector('canvas');
    if (glCanvas) {
      (glCanvas as HTMLElement).style.cssText =
        'position:absolute;top:0;left:0;width:100% !important;height:100% !important;';
    }

    // ResizeObserver: whenever the container grows or shrinks (fullscreen toggle,
    // drag-resize, window resize), update the globe.gl renderer dimensions.
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.globe || this.destroyed) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      applyRenderQuality(undefined, w, h);
    });
    this.resizeObserver.observe(this.container);

    // Load specular/water map for ocean shimmer
    setTimeout(async () => {
      try {
        const material = globe.globeMaterial();
        if (material) {
          const { TextureLoader, Color } = await import('three');
          new TextureLoader().load('/textures/earth-water.png', (tex: any) => {
            (material as any).specularMap = tex;
            (material as any).specular = new Color(2767434);
            (material as any).shininess = 30;
            material.needsUpdate = true;
          });
          (material as any).bumpScale = 3;
          material.needsUpdate = true;
        }
      } catch {
        // specular map is cosmetic — ignore
      }
    }, 800);

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
      canvas.addEventListener('mousedown', pauseAutoRotate);
      canvas.addEventListener('touchstart', pauseAutoRotate, { passive: true });
      canvas.addEventListener('mouseup', scheduleResumeAutoRotate);
      canvas.addEventListener('touchend', scheduleResumeAutoRotate);
    }

    // Wire HTML marker layer
    globe
      .htmlElementsData([])
      .htmlLat((d: object) => (d as GlobeMarker)._lat)
      .htmlLng((d: object) => (d as GlobeMarker)._lng)
      .htmlAltitude((d: object) => {
        const m = d as GlobeMarker;
        if (m._kind === 'flight' || m._kind === 'vessel') return 0.012;
        if (m._kind === 'hotspot') return 0.005;
        return 0.003;
      })
      .htmlElement((d: object) => this.buildMarkerElement(d as GlobeMarker));

    this.globe = globe;
    this.initialized = true;

    // Add overlay UI (zoom controls + layer panel)
    this.createControls();
    this.createLayerToggles();

    // Load static datasets
    this.setHotspots(INTEL_HOTSPOTS);
    this.initStaticLayers();
    this.setConflictZones();

    // Navigate to initial view
    this.setView(this.currentView);

    // dayNight toggle excluded by catalog (renderers: ['flat'])

    // Flush any data that arrived before init completed
    this.flushMarkers();
  }

  // ─── Marker element builder ────────────────────────────────────────────────

  private buildMarkerElement(d: GlobeMarker): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'pointer-events:auto;cursor:pointer;user-select:none;';

    if (d._kind === 'conflict') {
      const size = Math.min(12, 6 + (d.fatalities ?? 0) * 0.4);
      el.innerHTML = `
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
            animation:globe-pulse 2s ease-out infinite;
          "></div>
        </div>`;
      el.title = `${d.location}`;
    } else if (d._kind === 'hotspot') {
      const colors: Record<number, string> = { 5: '#ff2020', 4: '#ff6600', 3: '#ffaa00', 2: '#ffdd00', 1: '#88ff44' };
      const c = colors[d.escalationScore] ?? '#ffaa00';
      el.innerHTML = `
        <div style="
          width:10px;height:10px;
          background:${c};
          border:1.5px solid rgba(255,255,255,0.6);
          clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);
          box-shadow:0 0 8px 2px ${c}88;
        "></div>`;
      el.title = d.name;
    } else if (d._kind === 'flight') {
      const heading = d.heading ?? 0;
      const typeColors: Record<string, string> = {
        fighter: '#ff4444', bomber: '#ff8800', recon: '#44aaff',
        tanker: '#88ff44', transport: '#aaaaff', helicopter: '#ffff44',
        drone: '#ff44ff', maritime: '#44ffff',
      };
      const color = typeColors[d.type] ?? '#cccccc';
      el.innerHTML = `
        <div style="transform:rotate(${heading}deg);font-size:11px;color:${color};text-shadow:0 0 4px ${color}88;line-height:1;">
          ✈
        </div>`;
      el.title = `${d.callsign} (${d.type})`;
    } else if (d._kind === 'vessel') {
      const typeColors: Record<string, string> = {
        carrier: '#ff4444', destroyer: '#ff8800', submarine: '#8844ff',
        frigate: '#44aaff', amphibious: '#88ff44', support: '#aaaaaa',
      };
      const c = typeColors[d.type] ?? '#44aaff';
      el.innerHTML = `<div style="font-size:10px;color:${c};text-shadow:0 0 4px ${c}88;">⛴</div>`;
      el.title = `${d.name} (${d.type})`;
    } else if (d._kind === 'weather') {
      const severityColors: Record<string, string> = {
        Extreme: '#ff0044', Severe: '#ff6600', Moderate: '#ffaa00', Minor: '#88aaff',
      };
      const c = severityColors[d.severity] ?? '#88aaff';
      el.innerHTML = `<div style="font-size:9px;color:${c};text-shadow:0 0 4px ${c}88;font-weight:bold;">⚡</div>`;
      el.title = d.headline;
    } else if (d._kind === 'natural') {
      const typeIcons: Record<string, string> = {
        earthquakes: '〽', volcanoes: '🌋', severeStorms: '🌀',
        floods: '💧', wildfires: '🔥', drought: '☀',
      };
      const icon = typeIcons[d.category] ?? '⚠';
      el.innerHTML = `<div style="font-size:11px;">${icon}</div>`;
      el.title = d.title;
    } else if (d._kind === 'iran') {
      const sc = d.severity === 'high' ? '#ff3030' : d.severity === 'medium' ? '#ff8800' : '#ffcc00';
      el.innerHTML = `
        <div style="position:relative;width:9px;height:9px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${sc};border:1.5px solid rgba(255,255,255,0.5);box-shadow:0 0 5px 2px ${sc}88;"></div>
          <div style="position:absolute;inset:-4px;border-radius:50%;background:${sc}33;animation:globe-pulse 2s ease-out infinite;"></div>
        </div>`;
      el.title = d.title;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      el.innerHTML = `<div style="font-size:12px;color:${sc};text-shadow:0 0 4px ${sc}88;">📡</div>`;
      el.title = `${d.country}: ${d.title}`;
    } else if (d._kind === 'cyber') {
      const sc = d.severity === 'critical' ? '#ff0044' : d.severity === 'high' ? '#ff4400' : d.severity === 'medium' ? '#ffaa00' : '#44aaff';
      el.innerHTML = `<div style="font-size:10px;color:${sc};text-shadow:0 0 4px ${sc}88;font-weight:bold;">🛡</div>`;
      el.title = `${d.type}: ${d.indicator}`;
    } else if (d._kind === 'fire') {
      const intensity = d.brightness > 400 ? '#ff2020' : d.brightness > 330 ? '#ff6600' : '#ffaa00';
      el.innerHTML = `<div style="font-size:10px;color:${intensity};text-shadow:0 0 4px ${intensity}88;">🔥</div>`;
      el.title = `Fire — ${d.region}`;
    } else if (d._kind === 'protest') {
      const typeColors: Record<string, string> = {
        riot: '#ff3030', protest: '#ffaa00', strike: '#44aaff',
        demonstration: '#88ff44', civil_unrest: '#ff6600',
      };
      const c = typeColors[d.eventType] ?? '#ffaa00';
      el.innerHTML = `<div style="font-size:11px;color:${c};text-shadow:0 0 4px ${c}88;">📢</div>`;
      el.title = d.title;
    } else if (d._kind === 'ucdp') {
      const size = Math.min(10, 5 + (d.deaths || 0) * 0.3);
      el.innerHTML = `
        <div style="position:relative;width:${size}px;height:${size}px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:rgba(255,100,0,0.85);border:1.5px solid rgba(255,160,80,0.9);box-shadow:0 0 5px 2px rgba(255,100,0,0.5);"></div>
        </div>`;
      el.title = `${d.sideA} vs ${d.sideB}`;
    } else if (d._kind === 'displacement') {
      el.innerHTML = `<div style="font-size:11px;color:#88bbff;text-shadow:0 0 4px #88bbff88;">👥</div>`;
      el.title = `${d.origin} → ${d.asylum}`;
    } else if (d._kind === 'climate') {
      const typeColors: Record<string, string> = { warm: '#ff4400', cold: '#44aaff', wet: '#00ccff', dry: '#ff8800', mixed: '#88ff88' };
      const c = typeColors[d.type] ?? '#88ff88';
      el.innerHTML = `<div style="font-size:10px;color:${c};text-shadow:0 0 4px ${c}88;">🌡</div>`;
      el.title = `${d.zone} (${d.type})`;
    } else if (d._kind === 'gpsjam') {
      const c = d.level === 'high' ? '#ff2020' : '#ff8800';
      el.innerHTML = `<div style="font-size:10px;color:${c};text-shadow:0 0 4px ${c}88;">📡</div>`;
      el.title = `GPS Jamming (${d.level})`;
    } else if (d._kind === 'tech') {
      el.innerHTML = `<div style="font-size:10px;color:#44aaff;text-shadow:0 0 4px #44aaff88;">💻</div>`;
      el.title = d.title;
    } else if (d._kind === 'conflictZone') {
      const intColor = d.intensity === 'high' ? '#ff2020' : d.intensity === 'medium' ? '#ff8800' : '#ffcc00';
      el.innerHTML = `
        <div style="position:relative;width:28px;height:28px;">
          <div style="
            position:absolute;inset:0;border-radius:50%;
            background:${intColor}33;
            border:2px solid ${intColor}99;
            box-shadow:0 0 10px 4px ${intColor}44;
          "></div>
          <div style="
            position:absolute;inset:-6px;border-radius:50%;
            background:${intColor}11;
            border:1px solid ${intColor}44;
            animation:globe-pulse 2.5s ease-out infinite;
          "></div>
          <div style="
            position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
            font-size:11px;line-height:1;color:${intColor};
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
      el.innerHTML = `
        <div style="
          width:0;height:0;
          border-left:5px solid transparent;
          border-right:5px solid transparent;
          border-bottom:9px solid ${c};
          filter:drop-shadow(0 0 3px ${c}88);
        "></div>`;
      el.title = `${d.name}${d.country ? ' · ' + d.country : ''}`;
    } else if (d._kind === 'nuclearSite') {
      el.innerHTML = `<div style="font-size:11px;color:#ffd700;text-shadow:0 0 4px #ffd70088;">☢</div>`;
      el.title = `${d.name} (${d.type})`;
    } else if (d._kind === 'irradiator') {
      el.innerHTML = `<div style="font-size:10px;color:#ff8800;text-shadow:0 0 3px #ff880088;">⚠</div>`;
      el.title = `${d.city}, ${d.country}`;
    } else if (d._kind === 'spaceport') {
      el.innerHTML = `<div style="font-size:11px;color:#88ddff;text-shadow:0 0 4px #88ddff88;">🚀</div>`;
      el.title = `${d.name} (${d.operator})`;
    } else if (d._kind === 'earthquake') {
      const mc = d.magnitude >= 6 ? '#ff2020' : d.magnitude >= 4 ? '#ff8800' : '#ffcc00';
      const sz = Math.max(8, Math.min(18, Math.round(d.magnitude * 2.5)));
      el.innerHTML = `<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${mc}44;border:2px solid ${mc};box-shadow:0 0 6px 2px ${mc}55;"></div>`;
      el.title = `M${d.magnitude.toFixed(1)} — ${d.place}`;
    } else if (d._kind === 'economic') {
      const ec = d.type === 'exchange' ? '#ffd700' : d.type === 'central-bank' ? '#4488ff' : '#44cc88';
      el.innerHTML = `<div style="font-size:11px;color:${ec};text-shadow:0 0 4px ${ec}88;">💰</div>`;
      el.title = `${d.name} · ${d.country}`;
    } else if (d._kind === 'datacenter') {
      el.innerHTML = `<div style="font-size:10px;color:#88aaff;text-shadow:0 0 3px #88aaff88;">🖥</div>`;
      el.title = `${d.name} (${d.owner})`;
    } else if (d._kind === 'waterway') {
      el.innerHTML = `<div style="font-size:10px;color:#44aadd;text-shadow:0 0 3px #44aadd88;">⚓</div>`;
      el.title = d.name;
    } else if (d._kind === 'mineral') {
      el.innerHTML = `<div style="font-size:10px;color:#cc88ff;text-shadow:0 0 3px #cc88ff88;">💎</div>`;
      el.title = `${d.mineral} — ${d.name}`;
    } else if (d._kind === 'flightDelay') {
      const sc = d.severity === 'severe' ? '#ff2020' : d.severity === 'major' ? '#ff6600' : d.severity === 'moderate' ? '#ffaa00' : '#ffee44';
      el.innerHTML = `<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">✈</div>`;
      el.title = `${d.iata} — ${d.severity}`;
    } else if (d._kind === 'cableAdvisory') {
      const sc = d.severity === 'fault' ? '#ff2020' : '#ff8800';
      el.innerHTML = `<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">🔌</div>`;
      el.title = `${d.title} (${d.severity})`;
    } else if (d._kind === 'repairShip') {
      const sc = d.status === 'on-station' ? '#44ff88' : '#44aaff';
      el.innerHTML = `<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">🚢</div>`;
      el.title = d.name;
    } else if (d._kind === 'newsLocation') {
      const tc = d.threatLevel === 'critical' ? '#ff2020'
               : d.threatLevel === 'high'     ? '#ff6600'
               : d.threatLevel === 'elevated' ? '#ffaa00'
               : '#44aaff';
      el.innerHTML = `
        <div style="position:relative;width:16px;height:16px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${tc}44;border:1.5px solid ${tc};box-shadow:0 0 5px 2px ${tc}55;"></div>
          <div style="position:absolute;inset:-5px;border-radius:50%;background:${tc}22;animation:globe-pulse 1.8s ease-out infinite;"></div>
        </div>`;
      el.title = d.title;
    } else if (d._kind === 'aisDisruption') {
      const sc = d.severity === 'high' ? '#ff2020' : d.severity === 'elevated' ? '#ff8800' : '#44aaff';
      el.innerHTML = `<div style="font-size:11px;color:${sc};text-shadow:0 0 4px ${sc}88;">⛴</div>`;
      el.title = d.name;
    } else if (d._kind === 'flash') {
      el.style.pointerEvents = 'none';
      el.innerHTML = `
        <div style="position:relative;width:0;height:0;">
          <div style="position:absolute;width:44px;height:44px;border-radius:50%;
            border:2px solid rgba(255,255,255,0.9);background:rgba(255,255,255,0.2);
            left:-22px;top:-22px;
            animation:globe-pulse 0.7s ease-out infinite;"></div>
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
      'font-family:monospace',
      'color:#d4d4d4',
      'max-width:240px',
      'z-index:1000',
      'pointer-events:none',
      'line-height:1.5',
    ].join(';');

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let html = '';
    if (d._kind === 'conflict') {
      html = `<span style="color:#ff5050;font-weight:bold;">⚔ ${esc(d.location)}</span>` +
             (d.fatalities ? `<br><span style="opacity:.7;">Casualties: ${d.fatalities}</span>` : '');
    } else if (d._kind === 'hotspot') {
      const sc = ['', '#88ff44', '#ffdd00', '#ffaa00', '#ff6600', '#ff2020'][d.escalationScore] ?? '#ffaa00';
      html = `<span style="color:${sc};font-weight:bold;">🎯 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">Escalation: ${d.escalationScore}/5</span>`;
    } else if (d._kind === 'flight') {
      html = `<span style="font-weight:bold;">✈ ${esc(d.callsign)}</span><br><span style="opacity:.7;">${esc(d.type)}</span>`;
    } else if (d._kind === 'vessel') {
      html = `<span style="font-weight:bold;">⛴ ${esc(d.name)}</span><br><span style="opacity:.7;">${esc(d.type)}</span>`;
    } else if (d._kind === 'weather') {
      const wc = d.severity === 'Extreme' ? '#ff0044' : d.severity === 'Severe' ? '#ff6600' : '#88aaff';
      html = `<span style="color:${wc};font-weight:bold;">⚡ ${esc(d.severity)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.headline.slice(0, 90))}</span>`;
    } else if (d._kind === 'natural') {
      html = `<span style="font-weight:bold;">${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.7;">${esc(d.category)}</span>`;
    } else if (d._kind === 'iran') {
      const sc = d.severity === 'high' ? '#ff3030' : d.severity === 'medium' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${sc};font-weight:bold;">🎯 ${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.7;">${esc(d.category)}${d.location ? ' · ' + esc(d.location) : ''}</span>`;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${sc};font-weight:bold;">📡 ${d.severity.toUpperCase()} Outage</span>` +
             `<br><span style="opacity:.7;">${esc(d.country)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.title.slice(0, 70))}</span>`;
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
             `<br><span style="opacity:.5;">${d.pct.toFixed(0)}% affected</span>`;
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
      const tc = d.threatLevel === 'critical' ? '#ff2020' : d.threatLevel === 'high' ? '#ff6600' : d.threatLevel === 'elevated' ? '#ffaa00' : '#44aaff';
      html = `<span style="color:${tc};font-weight:bold;">📰 ${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.5;">${esc(d.threatLevel)}</span>`;
    }
    el.innerHTML = html;

    // Position relative to container
    const ar = anchor.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    let left = ar.left - cr.left + (anchor.offsetWidth ?? 14) + 6;
    let top  = ar.top  - cr.top  - 8;
    left = Math.max(4, Math.min(left, cr.width  - 248));
    top  = Math.max(4, Math.min(top,  cr.height - 80));
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';

    this.container.appendChild(el);
    this.tooltipEl = el;
    setTimeout(() => this.hideTooltip(), 3500);
  }

  private hideTooltip(): void {
    this.tooltipEl?.remove();
    this.tooltipEl = null;
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
    const layers = layerDefs.map(def => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
    }));

    const el = document.createElement('div');
    el.className = 'layer-toggles deckgl-layer-toggles';
    // Override deckgl-layer-toggles CSS which places at bottom; globe needs top-left
    el.style.bottom = 'auto';
    el.style.top = '10px';
    el.innerHTML = `
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <div class="toggle-list" style="max-height:32vh;overflow-y:auto;scrollbar-width:thin;">
        ${layers.map(({ key, label, icon }) => `
          <label class="layer-toggle" data-layer="${key}">
            <input type="checkbox" ${this.layers[key] ? 'checked' : ''}>
            <span class="toggle-icon">${icon}</span>
            <span class="toggle-label">${label}</span>
          </label>`).join('')}
      </div>`;
    this.container.appendChild(el);

    el.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) {
          const checked = (input as HTMLInputElement).checked;
          this.layers[layer] = checked;
          this.flushMarkers();
          this.onLayerChangeCb?.(layer, checked, 'user');
        }
      });
    });

    const collapseBtn = el.querySelector('.toggle-collapse');
    const list = el.querySelector('.toggle-list') as HTMLElement | null;
    let collapsed = false;
    collapseBtn?.addEventListener('click', () => {
      collapsed = !collapsed;
      if (list) list.style.display = collapsed ? 'none' : '';
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
    if (!this.globe || !this.initialized || this.destroyed) return;
    if (this.renderPaused) {
      this.pendingFlushWhilePaused = true;
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = requestAnimationFrame(() => {
      this.flushTimer = null;
      this.flushMarkersImmediate();
    });
  }

  private flushMarkersImmediate(): void {
    if (!this.globe || !this.initialized || this.destroyed) return;

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
    }
    if (this.layers.weather) markers.push(...this.weatherMarkers);
    if (this.layers.natural) {
      markers.push(...this.naturalMarkers);
      markers.push(...this.earthquakeMarkers);
    }
    if (this.layers.economic) markers.push(...this.economicMarkers);
    if (this.layers.datacenters) markers.push(...this.datacenterMarkers);
    if (this.layers.waterways) markers.push(...this.waterwayMarkers);
    if (this.layers.minerals) markers.push(...this.mineralMarkers);
    if (this.layers.flights) markers.push(...this.flightDelayMarkers);
    if (this.layers.ais) markers.push(...this.aisMarkers);
    if (this.layers.iranAttacks) markers.push(...this.iranMarkers);
    if (this.layers.outages) markers.push(...this.outageMarkers);
    if (this.layers.cyberThreats) markers.push(...this.cyberMarkers);
    if (this.layers.fires) markers.push(...this.fireMarkers);
    if (this.layers.protests) markers.push(...this.protestMarkers);
    if (this.layers.ucdpEvents) markers.push(...this.ucdpMarkers);
    if (this.layers.displacement) markers.push(...this.displacementMarkers);
    if (this.layers.climate) markers.push(...this.climateMarkers);
    if (this.layers.gpsJamming) markers.push(...this.gpsJamMarkers);
    if (this.layers.techEvents) markers.push(...this.techMarkers);
    if (this.layers.cables) {
      markers.push(...this.cableAdvisoryMarkers);
      markers.push(...this.repairShipMarkers);
    }
    markers.push(...this.newsLocationMarkers);
    markers.push(...this.flashMarkers);

    try {
      this.globe.htmlElementsData(markers);
      this.flushArcs();
      this.flushPaths();
      this.flushPolygons();
    } catch (err) { if (import.meta.env.DEV) console.warn('[GlobeMap] flush error', err); }
  }

  private flushArcs(): void {
    if (!this.globe || !this.initialized || this.destroyed) return;
    const segments = this.layers.tradeRoutes ? this.tradeRouteSegments : [];
    (this.globe as any)
      .arcsData(segments)
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
  }

  private flushPaths(): void {
    if (!this.globe || !this.initialized || this.destroyed) return;
    const paths: GlobePath[] = [];
    if (this.layers.cables)    paths.push(...this.globePaths.filter(p => p.pathType === 'cable'));
    if (this.layers.pipelines) paths.push(...this.globePaths.filter(p => p.pathType !== 'cable'));
    (this.globe as any)
      .pathsData(paths)
      .pathPoints((d: GlobePath) => d.points)
      .pathPointLat((p: [number, number]) => p[1])
      .pathPointLng((p: [number, number]) => p[0])
      .pathColor((d: GlobePath) => {
        if (d.pathType === 'cable') {
          if (this.cableFaultIds.has(d.id))    return '#ff3030';
          if (this.cableDegradedIds.has(d.id)) return '#ff8800';
          return 'rgba(0,200,255,0.65)';
        }
        if (d.pathType === 'oil')   return 'rgba(255,140,0,0.6)';
        if (d.pathType === 'gas')   return 'rgba(80,220,120,0.6)';
        return 'rgba(180,160,255,0.6)';
      })
      .pathStroke((d: GlobePath) => d.pathType === 'cable' ? 0.3 : 0.6)
      .pathDashLength((d: GlobePath) => d.pathType === 'cable' ? 1 : 0.6)
      .pathDashGap((d: GlobePath) => d.pathType === 'cable' ? 0 : 0.25)
      .pathDashAnimateTime((d: GlobePath) => d.pathType === 'cable' ? 0 : 5000)
      .pathLabel((d: GlobePath) => d.name);
  }

  private flushPolygons(): void {
    if (!this.globe || !this.initialized || this.destroyed) return;
    const polys = this.layers.conflicts
      ? GEOPOLITICAL_BOUNDARIES.map(b => ({
          coords: [b.coords],
          name: b.name,
          boundaryType: b.boundaryType,
        }))
      : [];
    (this.globe as any)
      .polygonsData(polys)
      .polygonCapColor(() => 'rgba(255, 60, 60, 0.15)')
      .polygonSideColor(() => 'rgba(255, 60, 60, 0.08)')
      .polygonStrokeColor(() => '#ff4444')
      .polygonAltitude(0.005)
      .polygonLabel((d: { name: string }) => d.name);
  }

  // ─── Public data setters ──────────────────────────────────────────────────

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
    this.milBaseMarkers = (MILITARY_BASES as MilitaryBase[]).map(b => ({
      _kind: 'milbase' as const,
      _lat: b.lat,
      _lng: b.lon,
      id: b.id,
      name: b.name,
      type: b.type,
      country: b.country ?? '',
    }));
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
    this.irradiatorSiteMarkers = (GAMMA_IRRADIATORS as GammaIrradiator[]).map(g => ({
      _kind: 'irradiator' as const,
      _lat: g.lat,
      _lng: g.lon,
      id: g.id,
      city: g.city,
      country: g.country,
    }));
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
    this.waterwayMarkers = (STRATEGIC_WATERWAYS as StrategicWaterway[]).map(w => ({
      _kind: 'waterway' as const,
      _lat: w.lat,
      _lng: w.lon,
      id: w.id,
      name: w.name,
      description: w.description ?? '',
    }));
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
    this.tradeRouteSegments = resolveTradeRouteSegments();
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

  public setMilitaryFlights(flights: MilitaryFlight[]): void {
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

  public setMilitaryVessels(vessels: MilitaryVessel[]): void {
    this.vessels = vessels.map(v => ({
      _kind: 'vessel' as const,
      _lat: v.lat,
      _lng: v.lon,
      id: v.id,
      name: (v as any).name ?? 'vessel',
      type: (v as any).vesselType ?? 'destroyer',
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
    this.flushMarkers();
  }

  // ─── Layer control ────────────────────────────────────────────────────────

  public setLayers(layers: MapLayers): void {
    // dayNight toggle excluded by catalog — harmless if true in memory
    this.layers = { ...layers };
    this.flushMarkers();
  }

  public enableLayer(layer: keyof MapLayers): void {
    // dayNight toggle excluded by catalog — no guard needed
    (this.layers as any)[layer] = true;
    this.flushMarkers();
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

  public setView(view: MapView): void {
    this.currentView = view;
    if (!this.globe) return;
    const pov = GlobeMap.VIEW_POVS[view] ?? GlobeMap.VIEW_POVS.global;
    this.globe.pointOfView(pov, 1200);
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (!this.globe) return;
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

  // ─── Resize ────────────────────────────────────────────────────────────────

  public resize(): void {
    if (!this.globe || this.destroyed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w > 0 && h > 0) this.globe.width(w).height(h);
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
      if (this.flushTimer) {
        cancelAnimationFrame(this.flushTimer);
        this.flushTimer = null;
      }
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
      severity: e.severity ?? 'medium',
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
      pct: h.pct ?? 0,
    }));
    this.flushMarkers();
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

  // ─── Destroy ──────────────────────────────────────────────────────────────

  public destroy(): void {
    this.unsubscribeGlobeQuality?.();
    this.unsubscribeGlobeQuality = null;
    this.destroyed = true;
    if (this.flushTimer) { cancelAnimationFrame(this.flushTimer); this.flushTimer = null; }
    if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.hideTooltip();
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
