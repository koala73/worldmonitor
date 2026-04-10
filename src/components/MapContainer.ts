/**
 * MapContainer - Conditional map renderer
 * Renders DeckGLMap (WebGL) on desktop, fallback to D3/SVG MapComponent on mobile.
 * Supports an optional 3D globe mode (globe.gl) selectable from Settings.
 */
import { isMobileDevice } from '@/utils';
import { MapComponent } from './Map';
import { DeckGLMap, type DeckMapView, type CountryClickPayload } from './DeckGLMap';
import { GlobeMap } from './GlobeMap';
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
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  NaturalEvent,
  UcdpGeoEvent,
  CyberThreat,
  CableHealthRecord,
} from '@/types';
import type { AirportDelayAlert, PositionSample } from '@/services/aviation';
import type { DisplacementFlow } from '@/services/displacement';
import type { Earthquake } from '@/services/earthquakes';
import type { ClimateAnomaly } from '@/services/climate';
import type { WeatherAlert } from '@/services/weather';
import type { PositiveGeoEvent } from '@/services/positive-events-geo';
import type { KindnessPoint } from '@/services/kindness-data';
import type { HappinessData } from '@/services/happiness-data';
import type { SpeciesRecovery } from '@/services/conservation-data';
import type { RenewableInstallation } from '@/services/renewable-installations';
import type { ResilienceRankingItem } from '@/services/resilience';
import type { RadiationObservation } from '@/services/radiation';
import type { GpsJamHex } from '@/services/gps-interference';
import type { SatellitePosition } from '@/services/satellites';
import type { IranEvent } from '@/services/conflict';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { DiseaseOutbreakItem } from '@/services/disease-outbreaks';
import type { GetChokepointStatusResponse } from '@/services/supply-chain';
import type { ScenarioVisualState, ScenarioResult } from '@/config/scenario-templates';
import { getAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { trackGateHit } from '@/services/analytics';

export type { ScenarioVisualState, ScenarioResult };

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

export interface MapContainerState {
  zoom: number;
  pan: { x: number; y: number };
  view: MapView;
  layers: MapLayers;
  timeRange: TimeRange;
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

type FireMarker = { lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string };
type NewsLocationMarker = { lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date };
type CIIScore = { code: string; score: number; level: string };

/**
 * Unified map interface that delegates to either DeckGLMap or MapComponent
 * based on device capabilities
 */
export class MapContainer {
  private container: HTMLElement;
  private isMobile: boolean;
  private deckGLMap: DeckGLMap | null = null;
  private svgMap: MapComponent | null = null;
  private globeMap: GlobeMap | null = null;
  private supplyChainPanel: import('@/components/SupplyChainPanel').SupplyChainPanel | null = null;
  private initialState: MapContainerState;
  private useDeckGL: boolean;
  private useGlobe: boolean;
  private isResizingInternal = false;
  private resizeObserver: ResizeObserver | null = null;

  // ─── Callback cache (survives map mode switches) ───────────────────────────
  private cachedOnStateChanged: ((state: MapContainerState) => void) | null = null;
  private cachedOnLayerChange: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;
  private cachedOnTimeRangeChanged: ((range: TimeRange) => void) | null = null;
  private cachedOnCountryClicked: ((country: CountryClickPayload) => void) | null = null;
  private cachedOnHotspotClicked: ((hotspot: Hotspot) => void) | null = null;
  private cachedOnAircraftPositionsUpdate: ((positions: PositionSample[]) => void) | null = null;
  private cachedOnMapContextMenu: ((payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void) | null = null;

  // ─── Data cache (survives map mode switches) ───────────────────────────────
  private cachedEarthquakes: Earthquake[] | null = null;
  private cachedWeatherAlerts: WeatherAlert[] | null = null;
  private cachedOutages: InternetOutage[] | null = null;
  private cachedAisDisruptions: AisDisruptionEvent[] | null = null;
  private cachedAisDensity: AisDensityZone[] | null = null;
  private cachedCableAdvisories: CableAdvisory[] | null = null;
  private cachedRepairShips: RepairShip[] | null = null;
  private cachedCableHealth: Record<string, CableHealthRecord> | null = null;
  private cachedProtests: SocialUnrestEvent[] | null = null;
  private cachedFlightDelays: AirportDelayAlert[] | null = null;
  private cachedAircraftPositions: PositionSample[] | null = null;
  private cachedMilitaryFlights: MilitaryFlight[] | null = null;
  private cachedMilitaryFlightClusters: MilitaryFlightCluster[] | null = null;
  private cachedMilitaryVessels: MilitaryVessel[] | null = null;
  private cachedMilitaryVesselClusters: MilitaryVesselCluster[] | null = null;
  private cachedNaturalEvents: NaturalEvent[] | null = null;
  private cachedFires: FireMarker[] | null = null;
  private cachedTechEvents: TechEventMarker[] | null = null;
  private cachedUcdpEvents: UcdpGeoEvent[] | null = null;
  private cachedDisplacementFlows: DisplacementFlow[] | null = null;
  private cachedClimateAnomalies: ClimateAnomaly[] | null = null;
  private cachedRadiationObservations: RadiationObservation[] | null = null;
  private cachedGpsJamming: GpsJamHex[] | null = null;
  private cachedSatellites: SatellitePosition[] | null = null;
  private cachedDiseaseOutbreaks: DiseaseOutbreakItem[] | null = null;
  private cachedCyberThreats: CyberThreat[] | null = null;
  private cachedIranEvents: IranEvent[] | null = null;
  private cachedNewsLocations: NewsLocationMarker[] | null = null;
  private cachedPositiveEvents: PositiveGeoEvent[] | null = null;
  private cachedKindnessData: KindnessPoint[] | null = null;
  private cachedHappinessScores: HappinessData | null = null;
  private cachedCIIScores: CIIScore[] | null = null;
  private cachedResilienceRanking: ResilienceRankingItem[] | null = null;
  private cachedResilienceGreyedOut: ResilienceRankingItem[] = [];
  private cachedSpeciesRecovery: SpeciesRecovery[] | null = null;
  private cachedRenewableInstallations: RenewableInstallation[] | null = null;
  private cachedHotspotActivity: NewsItem[] | null = null;
  private cachedEscalationFlights: MilitaryFlight[] | null = null;
  private cachedEscalationVessels: MilitaryVessel[] | null = null;
  private cachedImageryScenes: ImageryScene[] | null = null;
  private cachedWebcams: Array<WebcamEntry | WebcamCluster> | null = null;

  constructor(container: HTMLElement, initialState: MapContainerState, preferGlobe = false) {
    this.container = container;
    this.initialState = initialState;
    this.isMobile = isMobileDevice();
    this.useGlobe = preferGlobe && this.hasWebGLSupport();

    this.useDeckGL = !this.useGlobe && this.shouldUseDeckGL();

    if (!this.useDeckGL && this.initialState.layers?.resilienceScore) {
      this.initialState = { ...this.initialState, layers: { ...this.initialState.layers, resilienceScore: false } };
    }

    this.init();
  }

  private hasWebGLSupport(): boolean {
    try {
      const canvas = document.createElement('canvas');
      // deck.gl + maplibre rely on WebGL2 features in desktop mode.
      // Some Linux WebKitGTK builds expose only WebGL1, which can lead to
      // an empty/black render surface instead of a usable map.
      const gl2 = canvas.getContext('webgl2');
      return !!gl2;
    } catch {
      return false;
    }
  }

  private shouldUseDeckGL(): boolean {
    if (!this.hasWebGLSupport()) return false;
    if (!this.isMobile) return true;
    const mem = (navigator as any).deviceMemory;
    if (mem !== undefined && mem < 3) return false;
    return true;
  }

  private initSvgMap(logMessage: string): void {
    console.log(logMessage);
    this.useDeckGL = false;
    this.deckGLMap = null;
    this.container.classList.remove('deckgl-mode');
    this.container.classList.add('svg-mode');
    // DeckGLMap mutates DOM early during construction. If initialization throws,
    // clear partial deck.gl nodes before creating the SVG fallback.
    this.container.innerHTML = '';
    this.svgMap = new MapComponent(this.container, this.initialState);
  }

  private init(): void {
    if (this.useGlobe) {
      console.log('[MapContainer] Initializing 3D globe (globe.gl mode)');
      this.globeMap = new GlobeMap(this.container, this.initialState);
    } else if (this.useDeckGL) {
      console.log('[MapContainer] Initializing deck.gl map (desktop mode)');
      try {
        this.container.classList.add('deckgl-mode');
        this.deckGLMap = new DeckGLMap(this.container, {
          ...this.initialState,
          view: this.initialState.view as DeckMapView,
        });
      } catch (error) {
        console.warn('[MapContainer] DeckGL initialization failed, falling back to SVG map', error);
        this.initSvgMap('[MapContainer] Initializing SVG map (DeckGL fallback mode)');
      }
    } else {
      this.initSvgMap('[MapContainer] Initializing SVG map (mobile/fallback mode)');
    }

    // Automatic resize on container change (fixes gaps on load/layout shift)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        // Skip if we are already handling resize manually via drag handlers
        if (this.isResizingInternal) return;
        this.resize();
      });
      this.resizeObserver.observe(this.container);
    }
  }

  /** Switch to 3D globe mode at runtime (called from Settings). */
  public switchToGlobe(): void {
    if (this.useGlobe) return;
    const snapshot = this.getState();
    const center = this.getCenter();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.destroyFlatMap();
    this.useGlobe = true;
    this.useDeckGL = false;
    this.globeMap = new GlobeMap(this.container, this.initialState);
    this.restoreViewport(snapshot, center);
    this.rehydrateActiveMap();
  }

  /** Reload basemap style (called when map provider changes in Settings). */
  public reloadBasemap(): void {
    this.deckGLMap?.reloadBasemap();
  }

  /** Switch back to flat map at runtime (called from Settings). */
  public switchToFlat(): void {
    if (!this.useGlobe) return;
    const snapshot = this.getState();
    const center = this.getCenter();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.globeMap?.destroy();
    this.globeMap = null;
    this.useGlobe = false;
    this.useDeckGL = this.shouldUseDeckGL();
    this.init();
    this.restoreViewport(snapshot, center);
    this.rehydrateActiveMap();
  }

  private restoreViewport(snapshot: MapContainerState, center: { lat: number; lon: number } | null): void {
    this.setLayers(snapshot.layers);
    this.setTimeRange(snapshot.timeRange);
    this.setView(snapshot.view);
    if (center) this.setCenter(center.lat, center.lon, snapshot.zoom);
  }

  private rehydrateActiveMap(): void {
    // 1. Re-wire callbacks (through own public methods for adapter safety)
    if (this.cachedOnStateChanged) this.onStateChanged(this.cachedOnStateChanged);
    if (this.cachedOnLayerChange) this.setOnLayerChange(this.cachedOnLayerChange);
    if (this.cachedOnTimeRangeChanged) this.onTimeRangeChanged(this.cachedOnTimeRangeChanged);
    if (this.cachedOnCountryClicked) this.onCountryClicked(this.cachedOnCountryClicked);
    if (this.cachedOnHotspotClicked) this.onHotspotClicked(this.cachedOnHotspotClicked);
    if (this.cachedOnAircraftPositionsUpdate) this.setOnAircraftPositionsUpdate(this.cachedOnAircraftPositionsUpdate);
    if (this.cachedOnMapContextMenu) this.onMapContextMenu(this.cachedOnMapContextMenu);

    // 2. Re-push all cached data
    if (this.cachedEarthquakes) this.setEarthquakes(this.cachedEarthquakes);
    if (this.cachedWeatherAlerts) this.setWeatherAlerts(this.cachedWeatherAlerts);
    if (this.cachedOutages) this.setOutages(this.cachedOutages);
    if (this.cachedAisDisruptions != null && this.cachedAisDensity != null) this.setAisData(this.cachedAisDisruptions, this.cachedAisDensity);
    if (this.cachedCableAdvisories != null && this.cachedRepairShips != null) this.setCableActivity(this.cachedCableAdvisories, this.cachedRepairShips);
    if (this.cachedCableHealth) this.setCableHealth(this.cachedCableHealth);
    if (this.cachedProtests) this.setProtests(this.cachedProtests);
    if (this.cachedFlightDelays) this.setFlightDelays(this.cachedFlightDelays);
    if (this.cachedAircraftPositions) this.setAircraftPositions(this.cachedAircraftPositions);
    if (this.cachedMilitaryFlights) this.setMilitaryFlights(this.cachedMilitaryFlights, this.cachedMilitaryFlightClusters ?? []);
    if (this.cachedMilitaryVessels) this.setMilitaryVessels(this.cachedMilitaryVessels, this.cachedMilitaryVesselClusters ?? []);
    if (this.cachedNaturalEvents) this.setNaturalEvents(this.cachedNaturalEvents);
    if (this.cachedFires) this.setFires(this.cachedFires);
    if (this.cachedTechEvents) this.setTechEvents(this.cachedTechEvents);
    if (this.cachedUcdpEvents) this.setUcdpEvents(this.cachedUcdpEvents);
    if (this.cachedDisplacementFlows) this.setDisplacementFlows(this.cachedDisplacementFlows);
    if (this.cachedClimateAnomalies) this.setClimateAnomalies(this.cachedClimateAnomalies);
    if (this.cachedRadiationObservations) this.setRadiationObservations(this.cachedRadiationObservations);
    if (this.cachedGpsJamming) this.setGpsJamming(this.cachedGpsJamming);
    if (this.cachedSatellites) this.setSatellites(this.cachedSatellites);
    if (this.cachedDiseaseOutbreaks) this.setDiseaseOutbreaks(this.cachedDiseaseOutbreaks);
    if (this.cachedCyberThreats) this.setCyberThreats(this.cachedCyberThreats);
    if (this.cachedIranEvents) this.setIranEvents(this.cachedIranEvents);
    if (this.cachedNewsLocations) this.setNewsLocations(this.cachedNewsLocations);
    if (this.cachedPositiveEvents) this.setPositiveEvents(this.cachedPositiveEvents);
    if (this.cachedKindnessData) this.setKindnessData(this.cachedKindnessData);
    if (this.cachedHappinessScores) this.setHappinessScores(this.cachedHappinessScores);
    if (this.cachedCIIScores) this.setCIIScores(this.cachedCIIScores);
    if (this.cachedResilienceRanking) this.setResilienceRanking(this.cachedResilienceRanking, this.cachedResilienceGreyedOut);
    if (this.cachedSpeciesRecovery) this.setSpeciesRecoveryZones(this.cachedSpeciesRecovery);
    if (this.cachedRenewableInstallations) this.setRenewableInstallations(this.cachedRenewableInstallations);
    if (this.cachedHotspotActivity) this.updateHotspotActivity(this.cachedHotspotActivity);
    if (this.cachedEscalationFlights && this.cachedEscalationVessels) this.updateMilitaryForEscalation(this.cachedEscalationFlights, this.cachedEscalationVessels);
    if (this.cachedImageryScenes) this.setImageryScenes(this.cachedImageryScenes);
    if (this.cachedWebcams) {
      if (this.useGlobe) this.globeMap?.setWebcams(this.cachedWebcams);
      else if (this.useDeckGL) this.deckGLMap?.setWebcams(this.cachedWebcams);
      else this.svgMap?.setWebcams(this.cachedWebcams);
    }
  }

  public isGlobeMode(): boolean {
    return this.useGlobe;
  }

  public isDeckGLActive(): boolean {
    return this.useDeckGL;
  }

  private destroyFlatMap(): void {
    this.deckGLMap?.destroy();
    this.deckGLMap = null;
    this.svgMap?.destroy();
    this.svgMap = null;
    this.container.innerHTML = '';
    this.container.classList.remove('deckgl-mode', 'svg-mode');
  }

  // ─── Unified public API - delegates to active map implementation ────────────

  public render(): void {
    if (this.useGlobe) { this.globeMap?.render(); return; }
    if (this.useDeckGL) { this.deckGLMap?.render(); } else { this.svgMap?.render(); }
  }

  public resize(): void {
    if (this.useGlobe) {
      this.globeMap?.resize();
      return;
    }
    if (this.useDeckGL) {
      this.deckGLMap?.resize();
    } else {
      this.svgMap?.resize();
    }
  }

  public setIsResizing(isResizing: boolean): void {
    this.isResizingInternal = isResizing;
    if (this.useGlobe) { this.globeMap?.setIsResizing(isResizing); return; }
    if (this.useDeckGL) { this.deckGLMap?.setIsResizing(isResizing); } else { this.svgMap?.setIsResizing(isResizing); }
  }

  public setView(view: MapView, zoom?: number): void {
    if (this.useGlobe) { this.globeMap?.setView(view, zoom); return; }
    if (this.useDeckGL) { this.deckGLMap?.setView(view as DeckMapView, zoom); } else { this.svgMap?.setView(view, zoom); }
  }

  public setZoom(zoom: number): void {
    if (this.useGlobe) { this.globeMap?.setZoom(zoom); return; }
    if (this.useDeckGL) { this.deckGLMap?.setZoom(zoom); } else { this.svgMap?.setZoom(zoom); }
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (this.useGlobe) { this.globeMap?.setCenter(lat, lon, zoom); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCenter(lat, lon, zoom);
    } else {
      this.svgMap?.setCenter(lat, lon);
      if (zoom != null) this.svgMap?.setZoom(zoom);
    }
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (this.useGlobe) return this.globeMap?.getCenter() ?? null;
    if (this.useDeckGL) return this.deckGLMap?.getCenter() ?? null;
    return this.svgMap?.getCenter() ?? null;
  }

  public setTimeRange(range: TimeRange): void {
    if (this.useGlobe) { this.globeMap?.setTimeRange(range); return; }
    if (this.useDeckGL) { this.deckGLMap?.setTimeRange(range); } else { this.svgMap?.setTimeRange(range); }
  }

  public getTimeRange(): TimeRange {
    if (this.useGlobe) return this.globeMap?.getTimeRange() ?? '7d';
    if (this.useDeckGL) return this.deckGLMap?.getTimeRange() ?? '7d';
    return this.svgMap?.getTimeRange() ?? '7d';
  }

  public setLayers(layers: MapLayers): void {
    const sanitized = !this.useDeckGL && layers.resilienceScore ? { ...layers, resilienceScore: false } : layers;
    if (this.useGlobe) { this.globeMap?.setLayers(sanitized); return; }
    if (this.useDeckGL) { this.deckGLMap?.setLayers(sanitized); } else { this.svgMap?.setLayers(sanitized); }
  }

  public getState(): MapContainerState {
    if (this.useGlobe) return this.globeMap?.getState() ?? this.initialState;
    if (this.useDeckGL) {
      const state = this.deckGLMap?.getState();
      return state ? { ...state, view: state.view as MapView } : this.initialState;
    }
    return this.svgMap?.getState() ?? this.initialState;
  }

  // ─── Data setters ────────────────────────────────────────────────────────────

  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.cachedEarthquakes = earthquakes;
    if (this.useGlobe) { this.globeMap?.setEarthquakes(earthquakes); return; }
    if (this.useDeckGL) { this.deckGLMap?.setEarthquakes(earthquakes); } else { this.svgMap?.setEarthquakes(earthquakes); }
  }

  public setImageryScenes(scenes: ImageryScene[]): void {
    this.cachedImageryScenes = scenes;
    if (this.useGlobe) { this.globeMap?.setImageryScenes(scenes); return; }
    if (this.useDeckGL) { this.deckGLMap?.setImageryScenes(scenes); }
  }

  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.cachedWebcams = markers;
    if (this.useGlobe) { this.globeMap?.setWebcams(markers); return; }
    if (this.useDeckGL) { this.deckGLMap?.setWebcams(markers); }
    else { this.svgMap?.setWebcams(markers); }
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.cachedWeatherAlerts = alerts;
    if (this.useGlobe) { this.globeMap?.setWeatherAlerts(alerts); return; }
    if (this.useDeckGL) { this.deckGLMap?.setWeatherAlerts(alerts); } else { this.svgMap?.setWeatherAlerts(alerts); }
  }

  public setOutages(outages: InternetOutage[]): void {
    this.cachedOutages = outages;
    if (this.useGlobe) { this.globeMap?.setOutages(outages); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOutages(outages); } else { this.svgMap?.setOutages(outages); }
  }

  public setTrafficAnomalies(anomalies: ProtoTrafficAnomaly[]): void {
    if (this.useGlobe) { this.globeMap?.setTrafficAnomalies(anomalies); return; }
    if (this.useDeckGL) { this.deckGLMap?.setTrafficAnomalies(anomalies); }
  }

  public setDdosLocations(hits: DdosLocationHit[]): void {
    if (this.useGlobe) { this.globeMap?.setDdosLocations(hits); return; }
    if (this.useDeckGL) { this.deckGLMap?.setDdosLocations(hits); }
  }

  public setAisData(disruptions: AisDisruptionEvent[], density: AisDensityZone[]): void {
    this.cachedAisDisruptions = disruptions;
    this.cachedAisDensity = density;
    if (this.useGlobe) { this.globeMap?.setAisData(disruptions, density); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setAisData(disruptions, density);
    } else {
      this.svgMap?.setAisData(disruptions, density);
    }
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cachedCableAdvisories = advisories;
    this.cachedRepairShips = repairShips;
    if (this.useGlobe) { this.globeMap?.setCableActivity(advisories, repairShips); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCableActivity(advisories, repairShips);
    } else {
      this.svgMap?.setCableActivity(advisories, repairShips);
    }
  }

  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    this.cachedCableHealth = healthMap;
    if (this.useGlobe) { this.globeMap?.setCableHealth(healthMap); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCableHealth(healthMap);
    } else {
      this.svgMap?.setCableHealth(healthMap);
    }
  }

  public setProtests(events: SocialUnrestEvent[]): void {
    this.cachedProtests = events;
    if (this.useGlobe) { this.globeMap?.setProtests(events); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setProtests(events);
    } else {
      this.svgMap?.setProtests(events);
    }
  }

  public setFlightDelays(delays: AirportDelayAlert[]): void {
    this.cachedFlightDelays = delays;
    if (this.useGlobe) { this.globeMap?.setFlightDelays(delays); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setFlightDelays(delays);
    } else {
      this.svgMap?.setFlightDelays(delays);
    }
  }

  public setAircraftPositions(positions: PositionSample[]): void {
    this.cachedAircraftPositions = positions;
    if (this.useDeckGL) {
      this.deckGLMap?.setAircraftPositions(positions);
    } else {
      this.svgMap?.setAircraftPositions(positions);
    }
  }

  public setMilitaryFlights(flights: MilitaryFlight[], clusters: MilitaryFlightCluster[] = []): void {
    this.cachedMilitaryFlights = flights;
    this.cachedMilitaryFlightClusters = clusters;
    if (this.useGlobe) { this.globeMap?.setMilitaryFlights(flights); return; }
    if (this.useDeckGL) { this.deckGLMap?.setMilitaryFlights(flights, clusters); } else { this.svgMap?.setMilitaryFlights(flights, clusters); }
  }

  public setMilitaryVessels(vessels: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    this.cachedMilitaryVessels = vessels;
    this.cachedMilitaryVesselClusters = clusters;
    if (this.useGlobe) { this.globeMap?.setMilitaryVessels(vessels, clusters); return; }
    if (this.useDeckGL) { this.deckGLMap?.setMilitaryVessels(vessels, clusters); } else { this.svgMap?.setMilitaryVessels(vessels, clusters); }
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.cachedNaturalEvents = events;
    if (this.useGlobe) { this.globeMap?.setNaturalEvents(events); return; }
    if (this.useDeckGL) { this.deckGLMap?.setNaturalEvents(events); } else { this.svgMap?.setNaturalEvents(events); }
  }

  public setFires(fires: FireMarker[]): void {
    this.cachedFires = fires;
    if (this.useGlobe) { this.globeMap?.setFires(fires); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setFires(fires);
    } else {
      this.svgMap?.setFires(fires);
    }
  }

  public setTechEvents(events: TechEventMarker[]): void {
    this.cachedTechEvents = events;
    if (this.useGlobe) { this.globeMap?.setTechEvents(events); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setTechEvents(events);
    } else {
      this.svgMap?.setTechEvents(events);
    }
  }

  public setUcdpEvents(events: UcdpGeoEvent[]): void {
    this.cachedUcdpEvents = events;
    if (this.useGlobe) { this.globeMap?.setUcdpEvents(events); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setUcdpEvents(events);
    }
  }

  public setDisplacementFlows(flows: DisplacementFlow[]): void {
    this.cachedDisplacementFlows = flows;
    if (this.useGlobe) { this.globeMap?.setDisplacementFlows(flows); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setDisplacementFlows(flows);
    }
  }

  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.cachedClimateAnomalies = anomalies;
    if (this.useGlobe) { this.globeMap?.setClimateAnomalies(anomalies); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setClimateAnomalies(anomalies);
    }
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.cachedRadiationObservations = observations;
    if (this.useGlobe) { this.globeMap?.setRadiationObservations(observations); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setRadiationObservations(observations);
    } else {
      this.svgMap?.setRadiationObservations(observations);
    }
  }

  public setGpsJamming(hexes: GpsJamHex[]): void {
    this.cachedGpsJamming = hexes;
    if (this.useGlobe) { this.globeMap?.setGpsJamming(hexes); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setGpsJamming(hexes);
    }
  }

  public setSatellites(positions: SatellitePosition[]): void {
    this.cachedSatellites = positions;
    if (this.useGlobe) { this.globeMap?.setSatellites(positions); return; }
  }

  public setDiseaseOutbreaks(outbreaks: DiseaseOutbreakItem[]): void {
    this.cachedDiseaseOutbreaks = outbreaks;
    if (this.useGlobe) return; // TODO: add globe support for disease outbreaks layer
    if (this.useDeckGL) this.deckGLMap?.setDiseaseOutbreaks(outbreaks);
  }

  public setCyberThreats(threats: CyberThreat[]): void {
    this.cachedCyberThreats = threats;
    if (this.useGlobe) { this.globeMap?.setCyberThreats(threats); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCyberThreats(threats);
    } else {
      this.svgMap?.setCyberThreats(threats);
    }
  }

  public setIranEvents(events: IranEvent[]): void {
    this.cachedIranEvents = events;
    if (this.useGlobe) { this.globeMap?.setIranEvents(events); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setIranEvents(events);
    } else {
      this.svgMap?.setIranEvents(events);
    }
  }

  public setNewsLocations(data: NewsLocationMarker[]): void {
    this.cachedNewsLocations = data;
    if (this.useGlobe) { this.globeMap?.setNewsLocations(data); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setNewsLocations(data);
    } else {
      this.svgMap?.setNewsLocations(data);
    }
  }

  public setPositiveEvents(events: PositiveGeoEvent[]): void {
    this.cachedPositiveEvents = events;
    if (this.useGlobe) { this.globeMap?.setPositiveEvents(events); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setPositiveEvents(events);
    }
    // SVG map does not support positive events layer
  }

  public setKindnessData(points: KindnessPoint[]): void {
    this.cachedKindnessData = points;
    if (this.useGlobe) { this.globeMap?.setKindnessData(points); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setKindnessData(points);
    }
    // SVG map does not support kindness layer
  }

  public setHappinessScores(data: HappinessData): void {
    this.cachedHappinessScores = data;
    if (this.useGlobe) { this.globeMap?.setHappinessScores(data); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setHappinessScores(data);
    }
    // SVG map does not support choropleth overlay
  }

  public setChokepointData(data: GetChokepointStatusResponse | null): void {
    if (this.useGlobe) { this.globeMap?.setChokepointData(data); return; }
    if (this.useDeckGL) { this.deckGLMap?.setChokepointData(data); return; }
    this.svgMap?.setChokepointData(data);
  }

  public setCIIScores(scores: CIIScore[]): void {
    this.cachedCIIScores = scores;
    if (this.useGlobe) { this.globeMap?.setCIIScores(scores); return; }
    if (this.useDeckGL) { this.deckGLMap?.setCIIScores(scores); }
  }

  public setResilienceRanking(items: ResilienceRankingItem[], greyedOut: ResilienceRankingItem[] = []): void {
    this.cachedResilienceRanking = items;
    this.cachedResilienceGreyedOut = greyedOut;
    if (this.useDeckGL) {
      this.deckGLMap?.setResilienceRanking(items, greyedOut);
    }
  }

  public setSpeciesRecoveryZones(species: SpeciesRecovery[]): void {
    this.cachedSpeciesRecovery = species;
    if (this.useGlobe) { this.globeMap?.setSpeciesRecoveryZones(species); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setSpeciesRecoveryZones(species);
    }
    // SVG map does not support species recovery layer
  }

  public setRenewableInstallations(installations: RenewableInstallation[]): void {
    this.cachedRenewableInstallations = installations;
    if (this.useGlobe) { this.globeMap?.setRenewableInstallations(installations); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setRenewableInstallations(installations);
    }
    // SVG map does not support renewable installations layer
  }

  public updateHotspotActivity(news: NewsItem[]): void {
    this.cachedHotspotActivity = news;
    if (this.useDeckGL) {
      this.deckGLMap?.updateHotspotActivity(news);
    } else {
      this.svgMap?.updateHotspotActivity(news);
    }
  }

  public updateMilitaryForEscalation(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
    this.cachedEscalationFlights = flights;
    this.cachedEscalationVessels = vessels;
    if (this.useDeckGL) {
      this.deckGLMap?.updateMilitaryForEscalation(flights, vessels);
    } else {
      this.svgMap?.updateMilitaryForEscalation(flights, vessels);
    }
  }

  public getHotspotDynamicScore(hotspotId: string) {
    if (this.useDeckGL) {
      return this.deckGLMap?.getHotspotDynamicScore(hotspotId);
    }
    return this.svgMap?.getHotspotDynamicScore(hotspotId);
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    if (this.useDeckGL) {
      this.deckGLMap?.highlightAssets(assets);
    } else {
      this.svgMap?.highlightAssets(assets);
    }
  }

  // ─── Callback setters ────────────────────────────────────────────────────────

  public onHotspotClicked(callback: (hotspot: Hotspot) => void): void {
    this.cachedOnHotspotClicked = callback;
    if (this.useGlobe) { this.globeMap?.setOnHotspotClick(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnHotspotClick(callback); } else { this.svgMap?.onHotspotClicked(callback); }
  }

  public onTimeRangeChanged(callback: (range: TimeRange) => void): void {
    this.cachedOnTimeRangeChanged = callback;
    if (this.useGlobe) { this.globeMap?.onTimeRangeChanged(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnTimeRangeChange(callback); } else { this.svgMap?.onTimeRangeChanged(callback); }
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.cachedOnLayerChange = callback;
    if (this.useGlobe) { this.globeMap?.setOnLayerChange(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnLayerChange(callback); } else { this.svgMap?.setOnLayerChange(callback); }
  }

  public setOnAircraftPositionsUpdate(callback: (positions: PositionSample[]) => void): void {
    this.cachedOnAircraftPositionsUpdate = callback;
    if (this.useDeckGL) {
      this.deckGLMap?.setOnAircraftPositionsUpdate(callback);
    }
  }

  public getBbox(): string | null {
    if (this.useDeckGL) return this.deckGLMap?.getBbox() ?? null;
    if (this.useGlobe) return this.globeMap?.getBbox() ?? null;
    return null;
  }

  public onStateChanged(callback: (state: MapContainerState) => void): void {
    this.cachedOnStateChanged = callback;
    if (this.useGlobe) { this.globeMap?.onStateChanged(callback); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setOnStateChange((state) => {
        callback({ ...state, view: state.view as MapView });
      });
    } else {
      this.svgMap?.onStateChanged(callback);
    }
  }

  public getHotspotLevels(): Record<string, string> {
    if (this.useDeckGL) {
      return this.deckGLMap?.getHotspotLevels() ?? {};
    }
    return this.svgMap?.getHotspotLevels() ?? {};
  }

  public setHotspotLevels(levels: Record<string, string>): void {
    if (this.useDeckGL) {
      this.deckGLMap?.setHotspotLevels(levels);
    } else {
      this.svgMap?.setHotspotLevels(levels);
    }
  }

  public initEscalationGetters(): void {
    if (this.useDeckGL) {
      this.deckGLMap?.initEscalationGetters();
    } else {
      this.svgMap?.initEscalationGetters();
    }
  }

  // UI visibility methods
  public hideLayerToggle(layer: keyof MapLayers): void {
    if (this.useGlobe) { this.globeMap?.hideLayerToggle(layer); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.hideLayerToggle(layer);
    } else {
      this.svgMap?.hideLayerToggle(layer);
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    if (this.useGlobe) { this.globeMap?.setLayerLoading(layer, loading); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setLayerLoading(layer, loading);
    } else {
      this.svgMap?.setLayerLoading(layer, loading);
    }
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    if (this.useGlobe) { this.globeMap?.setLayerReady(layer, hasData); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setLayerReady(layer, hasData);
    } else {
      this.svgMap?.setLayerReady(layer, hasData);
    }
  }

  public flashAssets(assetType: AssetType, ids: string[]): void {
    if (this.useDeckGL) {
      this.deckGLMap?.flashAssets(assetType, ids);
    }
    // SVG map doesn't have flashAssets - only supported in deck.gl mode
  }

  // Layer enable/disable and trigger methods
  public enableLayer(layer: keyof MapLayers): void {
    if (layer === 'resilienceScore' && !this.useDeckGL) return;
    if (this.useGlobe) { this.globeMap?.enableLayer(layer); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.enableLayer(layer);
    } else {
      this.svgMap?.enableLayer(layer);
    }
  }

  public triggerHotspotClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerHotspotClick(id);
    } else {
      this.svgMap?.triggerHotspotClick(id);
    }
  }

  public triggerConflictClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerConflictClick(id);
    } else {
      this.svgMap?.triggerConflictClick(id);
    }
  }

  public triggerBaseClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerBaseClick(id);
    } else {
      this.svgMap?.triggerBaseClick(id);
    }
  }

  public triggerPipelineClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerPipelineClick(id);
    } else {
      this.svgMap?.triggerPipelineClick(id);
    }
  }

  public triggerCableClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerCableClick(id);
    } else {
      this.svgMap?.triggerCableClick(id);
    }
  }

  public triggerDatacenterClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerDatacenterClick(id);
    } else {
      this.svgMap?.triggerDatacenterClick(id);
    }
  }

  public triggerNuclearClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerNuclearClick(id);
    } else {
      this.svgMap?.triggerNuclearClick(id);
    }
  }

  public triggerIrradiatorClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerIrradiatorClick(id);
    } else {
      this.svgMap?.triggerIrradiatorClick(id);
    }
  }

  public flashLocation(lat: number, lon: number, durationMs?: number): void {
    if (this.useGlobe) { this.globeMap?.flashLocation(lat, lon, durationMs); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.flashLocation(lat, lon, durationMs);
    } else {
      this.svgMap?.flashLocation(lat, lon, durationMs);
    }
  }

  public onCountryClicked(callback: (country: CountryClickPayload) => void): void {
    this.cachedOnCountryClicked = callback;
    if (this.useGlobe) { this.globeMap?.setOnCountryClick(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnCountryClick(callback); } else { this.svgMap?.setOnCountryClick(callback); }
  }

  public onMapContextMenu(callback: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void): void {
    this.cachedOnMapContextMenu = callback;
    if (this.useGlobe) { this.globeMap?.setOnMapContextMenu(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnMapContextMenu(callback); }
  }

  public fitCountry(code: string): void {
    if (this.useGlobe) { this.globeMap?.fitCountry(code); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.fitCountry(code);
    } else {
      this.svgMap?.fitCountry(code);
    }
  }

  public highlightCountry(code: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.highlightCountry(code);
    }
  }

  public clearCountryHighlight(): void {
    if (this.useDeckGL) {
      this.deckGLMap?.clearCountryHighlight();
    }
  }

  public setRenderPaused(paused: boolean): void {
    if (this.useDeckGL) {
      this.deckGLMap?.setRenderPaused(paused);
    }
  }

  // ─── Route Highlight ─────────────────────────────────────────────────────────

  public highlightRoute(routeIds: string[]): void {
    this.deckGLMap?.highlightRoute(routeIds);
  }

  public clearHighlightedRoute(): void {
    this.deckGLMap?.clearHighlightedRoute();
  }

  public zoomToRoutes(routeIds: string[]): void {
    this.deckGLMap?.zoomToRoutes(routeIds);
  }

  // ─── Scenario Engine ─────────────────────────────────────────────────────────

  public setSupplyChainPanel(panel: import('@/components/SupplyChainPanel').SupplyChainPanel): void {
    this.supplyChainPanel = panel;
  }

  /**
   * Activate a scenario across all active renderers.
   * PRO-gated — free users trigger `trackGateHit('scenario-engine')` only.
   *
   * @param scenarioId  Template ID from scenario-templates.ts
   * @param result      Computed result from the scenario worker
   */
  public activateScenario(scenarioId: string, result: ScenarioResult): void {
    if (!hasPremiumAccess(getAuthState())) {
      trackGateHit('scenario-engine');
      return;
    }
    const state: ScenarioVisualState = {
      scenarioId,
      disruptedChokepointIds: result.affectedChokepointIds,
      affectedIso2s: result.topImpactCountries.map((c: { iso2: string }) => c.iso2),
    };
    this.deckGLMap?.setScenarioState(state);
    this.svgMap?.setScenarioState(state);
    this.globeMap?.setScenarioState(state);
    this.supplyChainPanel?.showScenarioSummary(scenarioId, result);
  }

  /**
   * Deactivate the current scenario and restore normal visual state.
   */
  public deactivateScenario(): void {
    this.deckGLMap?.setScenarioState(null);
    this.svgMap?.setScenarioState(null);
    this.globeMap?.setScenarioState(null);
    this.supplyChainPanel?.hideScenarioSummary();
  }

  // Utility methods
  public isDeckGLMode(): boolean {
    return this.useDeckGL;
  }

  public isMobileMode(): boolean {
    return this.isMobile;
  }

  public destroy(): void {
    this.resizeObserver?.disconnect();
    this.globeMap?.destroy();
    this.deckGLMap?.destroy();
    this.svgMap?.destroy();
    this.clearCache();
  }

  private clearCache(): void {
    this.cachedOnStateChanged = null;
    this.cachedOnLayerChange = null;
    this.cachedOnTimeRangeChanged = null;
    this.cachedOnCountryClicked = null;
    this.cachedOnHotspotClicked = null;
    this.cachedOnAircraftPositionsUpdate = null;
    this.cachedOnMapContextMenu = null;
    this.cachedEarthquakes = null;
    this.cachedWeatherAlerts = null;
    this.cachedOutages = null;
    this.cachedAisDisruptions = null;
    this.cachedAisDensity = null;
    this.cachedCableAdvisories = null;
    this.cachedRepairShips = null;
    this.cachedCableHealth = null;
    this.cachedProtests = null;
    this.cachedFlightDelays = null;
    this.cachedAircraftPositions = null;
    this.cachedMilitaryFlights = null;
    this.cachedMilitaryFlightClusters = null;
    this.cachedMilitaryVessels = null;
    this.cachedMilitaryVesselClusters = null;
    this.cachedNaturalEvents = null;
    this.cachedFires = null;
    this.cachedTechEvents = null;
    this.cachedUcdpEvents = null;
    this.cachedDisplacementFlows = null;
    this.cachedClimateAnomalies = null;
    this.cachedRadiationObservations = null;
    this.cachedGpsJamming = null;
    this.cachedSatellites = null;
    this.cachedDiseaseOutbreaks = null;
    this.cachedCyberThreats = null;
    this.cachedIranEvents = null;
    this.cachedNewsLocations = null;
    this.cachedPositiveEvents = null;
    this.cachedKindnessData = null;
    this.cachedHappinessScores = null;
    this.cachedCIIScores = null;
    this.cachedSpeciesRecovery = null;
    this.cachedRenewableInstallations = null;
    this.cachedHotspotActivity = null;
    this.cachedEscalationFlights = null;
    this.cachedEscalationVessels = null;
    this.cachedImageryScenes = null;
  }
}
