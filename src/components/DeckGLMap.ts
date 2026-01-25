/**
 * DeckGLMap - WebGL-accelerated map visualization for desktop
 * Uses deck.gl for high-performance rendering of large datasets
 * Mobile devices gracefully degrade to the D3/SVG-based Map component
 */
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, LayersList, PickingInfo } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, PathLayer, IconLayer } from '@deck.gl/layers';
import maplibregl from 'maplibre-gl';
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
  AirportDelayAlert,
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  NaturalEvent,
} from '@/types';
import type { WeatherAlert } from '@/services/weather';
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
} from '@/config';
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

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type DeckMapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

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

// Color constants matching the dark theme
const COLORS = {
  hotspotHigh: [255, 68, 68, 200] as [number, number, number, number],
  hotspotElevated: [255, 165, 0, 200] as [number, number, number, number],
  hotspotLow: [255, 255, 0, 180] as [number, number, number, number],
  conflict: [255, 0, 0, 100] as [number, number, number, number],
  base: [0, 150, 255, 200] as [number, number, number, number],
  nuclear: [255, 215, 0, 200] as [number, number, number, number],
  datacenter: [0, 255, 200, 180] as [number, number, number, number],
  cable: [0, 200, 255, 150] as [number, number, number, number],
  cableHighlight: [255, 100, 100, 200] as [number, number, number, number],
  earthquake: [255, 100, 50, 200] as [number, number, number, number],
  vesselMilitary: [255, 100, 100, 220] as [number, number, number, number],
  flightMilitary: [255, 50, 50, 220] as [number, number, number, number],
  protest: [255, 150, 0, 200] as [number, number, number, number],
  outage: [255, 50, 50, 180] as [number, number, number, number],
  weather: [100, 150, 255, 180] as [number, number, number, number],
  startupHub: [0, 255, 150, 200] as [number, number, number, number],
  techHQ: [100, 200, 255, 200] as [number, number, number, number],
  accelerator: [255, 200, 0, 200] as [number, number, number, number],
  cloudRegion: [150, 100, 255, 180] as [number, number, number, number],
};

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
  private aisDensity: AisDensityZone[] = [];
  private protests: SocialUnrestEvent[] = [];
  private militaryFlights: MilitaryFlight[] = [];
  private militaryVessels: MilitaryVessel[] = [];
  private naturalEvents: NaturalEvent[] = [];
  private techEvents: TechEventMarker[] = [];
  private flightDelays: AirportDelayAlert[] = [];

  // Callbacks
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
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

  private timestampIntervalId: ReturnType<typeof setInterval> | null = null;
  private renderScheduled = false;

  constructor(container: HTMLElement, initialState: DeckMapState) {
    this.container = container;
    this.state = initialState;
    this.hotspots = [...INTEL_HOTSPOTS];

    // Create wrapper structure
    this.setupDOM();
    this.popup = new MapPopup(container);

    // Initialize deck.gl and MapLibre
    this.initMapLibre();
    this.initDeck();

    // Create controls
    this.createControls();
    this.createTimeSlider();
    this.createLayerToggles();
    this.createLegend();
    this.createTimestamp();
  }

  // Cluster overlay container
  private clusterOverlay: HTMLElement | null = null;

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

    // HTML overlay container for cluster markers (rendered on top of deck.gl)
    this.clusterOverlay = document.createElement('div');
    this.clusterOverlay.id = 'deckgl-cluster-overlay';
    this.clusterOverlay.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10;';
    wrapper.appendChild(this.clusterOverlay);

    this.container.appendChild(wrapper);
  }

  private initMapLibre(): void {
    const preset = VIEW_PRESETS[this.state.view];

    this.maplibreMap = new maplibregl.Map({
      container: 'deckgl-basemap',
      style: {
        version: 8,
        name: 'Dark',
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
          },
        },
        layers: [
          {
            // Background layer to prevent transparent gaps while tiles load
            id: 'background',
            type: 'background',
            paint: {
              'background-color': '#0a0f0c',
            },
          },
          {
            id: 'carto-dark-layer',
            type: 'raster',
            source: 'carto-dark',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      },
      center: [preset.longitude, preset.latitude],
      zoom: preset.zoom,
      attributionControl: false,
      interactive: true,
    });
    // MapboxOverlay handles all view state sync automatically
  }

  private initDeck(): void {
    if (!this.maplibreMap) return;

    // Use MapboxOverlay for proper integration with MapLibre
    // This renders deck.gl layers directly into MapLibre's WebGL context
    // No manual view state sync needed - it's handled automatically
    this.deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: this.buildLayers(),
      getTooltip: (info: PickingInfo) => this.getTooltip(info),
      onClick: (info: PickingInfo) => this.handleClick(info),
    });

    this.maplibreMap.addControl(this.deckOverlay as unknown as maplibregl.IControl);

    // Update cluster overlays when map moves/zooms
    this.maplibreMap.on('move', () => this.renderClusterOverlays());
    this.maplibreMap.on('zoom', () => this.renderClusterOverlays());
  }

  // Generic marker clustering - groups markers within pixelRadius into clusters
  // groupKey function ensures only items with same key can cluster (e.g., same city)
  private clusterMarkers<T extends { lat: number; lon?: number; lng?: number }>(
    items: T[],
    pixelRadius: number,
    getGroupKey?: (item: T) => string
  ): Array<{ items: T[]; center: [number, number]; screenPos: [number, number] }> {
    if (!this.maplibreMap) return [];

    const clusters: Array<{ items: T[]; center: [number, number]; screenPos: [number, number] }> = [];
    const assigned = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;

      const item = items[i]!;
      const itemLon = item.lon ?? item.lng ?? 0;
      const pos = this.maplibreMap.project([itemLon, item.lat]);
      if (!pos) continue;

      const cluster: T[] = [item];
      assigned.add(i);
      const itemKey = getGroupKey?.(item);

      // Find nearby items (must share same group key if provided)
      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(j)) continue;

        const other = items[j]!;
        const otherKey = getGroupKey?.(other);

        // Skip if group keys don't match
        if (itemKey !== undefined && otherKey !== undefined && itemKey !== otherKey) continue;

        const otherLon = other.lon ?? other.lng ?? 0;
        const otherPos = this.maplibreMap.project([otherLon, other.lat]);
        if (!otherPos) continue;

        const dist = Math.sqrt(
          Math.pow(pos.x - otherPos.x, 2) + Math.pow(pos.y - otherPos.y, 2)
        );

        if (dist <= pixelRadius) {
          cluster.push(other);
          assigned.add(j);
        }
      }

      // Calculate cluster center
      let sumLat = 0, sumLon = 0;
      for (const c of cluster) {
        sumLat += c.lat;
        sumLon += c.lon ?? c.lng ?? 0;
      }
      const centerLat = sumLat / cluster.length;
      const centerLon = sumLon / cluster.length;
      const centerPos = this.maplibreMap.project([centerLon, centerLat]);

      clusters.push({
        items: cluster,
        center: [centerLon, centerLat],
        screenPos: centerPos ? [centerPos.x, centerPos.y] : [pos.x, pos.y],
      });
    }

    return clusters;
  }

  // Render HTML cluster overlays on top of deck.gl
  private renderClusterOverlays(): void {
    if (!this.clusterOverlay || !this.maplibreMap) return;
    this.clusterOverlay.innerHTML = '';

    const zoom = this.maplibreMap.getZoom();

    // Only cluster in tech variant
    if (SITE_VARIANT === 'tech') {
      // Tech HQs clustering
      if (this.state.layers.techHQs) {
        const clusterRadius = zoom >= 4 ? 15 : zoom >= 3 ? 25 : 40;
        const clusters = this.clusterMarkers(TECH_HQS, clusterRadius, hq => hq.city);
        this.renderTechHQClusters(clusters);
      }

      // Tech Events clustering
      if (this.state.layers.techEvents && this.techEvents.length > 0) {
        const clusterRadius = zoom >= 4 ? 15 : zoom >= 3 ? 25 : 40;
        const eventsWithLon = this.techEvents.map(e => ({ ...e, lon: e.lng }));
        const clusters = this.clusterMarkers(eventsWithLon, clusterRadius, e => e.location);
        this.renderTechEventClusters(clusters);
      }
    }

    // Protests clustering (both variants)
    if (this.state.layers.protests && this.protests.length > 0) {
      const clusterRadius = zoom >= 4 ? 12 : zoom >= 3 ? 20 : 35;
      const significantProtests = this.protests.filter(p => p.severity === 'high' || p.eventType === 'riot');
      const clusters = this.clusterMarkers(significantProtests, clusterRadius, p => p.country);
      this.renderProtestClusters(clusters);
    }
  }

  private renderTechHQClusters(clusters: Array<{ items: typeof TECH_HQS; center: [number, number]; screenPos: [number, number] }>): void {
    const zoom = this.maplibreMap?.getZoom() || 2;

    clusters.forEach(cluster => {
      if (cluster.items.length === 0) return;

      const div = document.createElement('div');
      const primaryItem = cluster.items[0]!;
      const isCluster = cluster.items.length > 1;
      const unicornCount = cluster.items.filter(h => h.type === 'unicorn').length;
      const faangCount = cluster.items.filter(h => h.type === 'faang').length;

      div.className = `tech-hq-marker ${primaryItem.type} ${isCluster ? 'cluster' : ''}`;
      div.style.cssText = `position: absolute; left: ${cluster.screenPos[0]}px; top: ${cluster.screenPos[1]}px; transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer;`;

      const icon = document.createElement('div');
      icon.className = 'tech-hq-icon';
      icon.textContent = faangCount > 0 ? '🏛️' : unicornCount > 0 ? '🦄' : '🏢';
      div.appendChild(icon);

      if (isCluster) {
        const badge = document.createElement('div');
        badge.className = 'cluster-badge';
        badge.textContent = String(cluster.items.length);
        div.appendChild(badge);
        div.title = cluster.items.map(h => h.company).join(', ');
      } else {
        // Single item - show label at higher zoom
        if (zoom >= 3 || primaryItem.type === 'faang') {
          const label = document.createElement('div');
          label.className = 'tech-hq-label';
          label.textContent = primaryItem.company;
          div.appendChild(label);
        }
        div.title = primaryItem.company;
      }

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        if (isCluster) {
          this.popup.show({
            type: 'techHQCluster',
            data: { items: cluster.items, city: primaryItem.city, country: primaryItem.country },
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        } else {
          this.popup.show({
            type: 'techHQ',
            data: primaryItem,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        }
      });

      this.clusterOverlay?.appendChild(div);
    });
  }

  private renderTechEventClusters(clusters: Array<{ items: Array<TechEventMarker & { lon: number }>; center: [number, number]; screenPos: [number, number] }>): void {
    clusters.forEach(cluster => {
      if (cluster.items.length === 0) return;

      const div = document.createElement('div');
      const primaryEvent = cluster.items[0]!;
      const isCluster = cluster.items.length > 1;
      const hasUpcomingSoon = cluster.items.some(e => e.daysUntil <= 14);

      div.className = `tech-event-marker ${hasUpcomingSoon ? 'upcoming-soon' : ''} ${isCluster ? 'cluster' : ''}`;
      div.style.cssText = `position: absolute; left: ${cluster.screenPos[0]}px; top: ${cluster.screenPos[1]}px; transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer;`;

      // Calendar icon
      const icon = document.createElement('div');
      icon.className = 'tech-event-icon';
      icon.textContent = '📅';
      div.appendChild(icon);

      if (isCluster) {
        const badge = document.createElement('div');
        badge.className = 'cluster-badge';
        badge.textContent = String(cluster.items.length);
        div.appendChild(badge);
        div.title = cluster.items.map(e => e.title).join(', ');
      } else {
        div.title = primaryEvent.title;
      }

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        if (isCluster) {
          this.popup.show({
            type: 'techEventCluster',
            data: { items: cluster.items.map(({ lon, ...rest }) => rest), location: primaryEvent.location, country: primaryEvent.country },
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        } else {
          this.popup.show({
            type: 'techEvent',
            data: primaryEvent,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        }
      });

      this.clusterOverlay?.appendChild(div);
    });
  }

  private renderProtestClusters(clusters: Array<{ items: SocialUnrestEvent[]; center: [number, number]; screenPos: [number, number] }>): void {
    clusters.forEach(cluster => {
      if (cluster.items.length === 0) return;

      const div = document.createElement('div');
      const primaryEvent = cluster.items[0]!;
      const isCluster = cluster.items.length > 1;
      const hasRiot = cluster.items.some(e => e.eventType === 'riot');
      const hasHighSeverity = cluster.items.some(e => e.severity === 'high');

      div.className = `protest-marker ${hasHighSeverity ? 'high' : primaryEvent.severity} ${hasRiot ? 'riot' : primaryEvent.eventType} ${isCluster ? 'cluster' : ''}`;
      div.style.cssText = `position: absolute; left: ${cluster.screenPos[0]}px; top: ${cluster.screenPos[1]}px; transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer;`;

      const icon = document.createElement('div');
      icon.className = 'protest-icon';
      icon.textContent = hasRiot ? '🔥' : primaryEvent.eventType === 'strike' ? '✊' : '📢';
      div.appendChild(icon);

      if (isCluster) {
        const badge = document.createElement('div');
        badge.className = 'cluster-badge';
        badge.textContent = String(cluster.items.length);
        div.appendChild(badge);
        div.title = `${primaryEvent.country}: ${cluster.items.length} events`;
      } else {
        div.title = `${primaryEvent.city || primaryEvent.country} - ${primaryEvent.eventType} (${primaryEvent.severity})`;
        if (primaryEvent.validated) {
          div.classList.add('validated');
        }
      }

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        if (isCluster) {
          this.popup.show({
            type: 'protestCluster',
            data: { items: cluster.items, country: primaryEvent.country },
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        } else {
          this.popup.show({
            type: 'protest',
            data: primaryEvent,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        }
      });

      this.clusterOverlay?.appendChild(div);
    });
  }

  private buildLayers(): LayersList {
    const layers: (Layer | null | false)[] = [];
    const { layers: mapLayers } = this.state;

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

    // Military bases layer
    if (mapLayers.bases) {
      layers.push(this.createBasesLayer());
    }

    // Nuclear facilities layer - HEXAGON icons
    if (mapLayers.nuclear) {
      layers.push(this.createNuclearLayer());
    }

    // Gamma irradiators layer
    if (mapLayers.irradiators) {
      layers.push(this.createIrradiatorsLayer());
    }

    // Spaceports layer
    if (mapLayers.spaceports) {
      layers.push(this.createSpaceportsLayer());
    }

    // Hotspots layer
    if (mapLayers.hotspots) {
      layers.push(this.createHotspotsLayer());
    }

    // Datacenters layer - SQUARE icons
    if (mapLayers.datacenters) {
      layers.push(this.createDatacentersLayer());
    }

    // Earthquakes layer
    if (mapLayers.natural && this.earthquakes.length > 0) {
      layers.push(this.createEarthquakesLayer());
    }

    // Natural events layer
    if (mapLayers.natural && this.naturalEvents.length > 0) {
      layers.push(this.createNaturalEventsLayer());
    }

    // Weather alerts layer
    if (mapLayers.weather && this.weatherAlerts.length > 0) {
      layers.push(this.createWeatherLayer());
    }

    // Internet outages layer
    if (mapLayers.outages && this.outages.length > 0) {
      layers.push(this.createOutagesLayer());
    }

    // AIS density layer
    if (mapLayers.ais && this.aisDensity.length > 0) {
      layers.push(this.createAisDensityLayer());
    }

    // Strategic ports layer (shown with AIS)
    if (mapLayers.ais) {
      layers.push(this.createPortsLayer());
    }

    // Flight delays layer
    if (mapLayers.flights && this.flightDelays.length > 0) {
      layers.push(this.createFlightDelaysLayer());
    }

    // Protests layer - rendered via HTML overlays in renderClusterOverlays() for clustering support

    // Military vessels layer
    if (mapLayers.military && this.militaryVessels.length > 0) {
      layers.push(this.createMilitaryVesselsLayer());
    }

    // Military flights layer
    if (mapLayers.military && this.militaryFlights.length > 0) {
      layers.push(this.createMilitaryFlightsLayer());
    }

    // Strategic waterways layer
    if (mapLayers.waterways) {
      layers.push(this.createWaterwaysLayer());
    }

    // Economic centers layer
    if (mapLayers.economic) {
      layers.push(this.createEconomicCentersLayer());
    }

    // Tech variant layers
    // Note: techHQs and techEvents are rendered via HTML overlays for clustering support
    if (SITE_VARIANT === 'tech') {
      if (mapLayers.startupHubs) {
        layers.push(this.createStartupHubsLayer());
      }
      // techHQs rendered via HTML overlays in renderClusterOverlays()
      if (mapLayers.accelerators) {
        layers.push(this.createAcceleratorsLayer());
      }
      if (mapLayers.cloudRegions) {
        layers.push(this.createCloudRegionsLayer());
      }
      // techEvents rendered via HTML overlays in renderClusterOverlays()
    }

    return layers.filter(Boolean) as LayersList;
  }

  // Layer creation methods
  private createCablesLayer(): PathLayer {
    const highlightedCables = this.highlightedAssets.cable;

    return new PathLayer({
      id: 'cables-layer',
      data: UNDERSEA_CABLES,
      // Points are already [lon, lat] which is what deck.gl expects
      getPath: (d) => d.points,
      getColor: (d) =>
        highlightedCables.has(d.id) ? COLORS.cableHighlight : COLORS.cable,
      getWidth: (d) => highlightedCables.has(d.id) ? 3 : 1,
      widthMinPixels: 1,
      widthMaxPixels: 5,
      pickable: true,
    });
  }

  private createPipelinesLayer(): PathLayer {
    const highlightedPipelines = this.highlightedAssets.pipeline;

    return new PathLayer({
      id: 'pipelines-layer',
      data: PIPELINES,
      // Points are already [lon, lat] which is what deck.gl expects
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
    });
  }

  private createConflictZonesLayer(): GeoJsonLayer {
    const geojsonData = {
      type: 'FeatureCollection' as const,
      features: CONFLICT_ZONES.map(zone => ({
        type: 'Feature' as const,
        properties: { id: zone.id, name: zone.name, intensity: zone.intensity },
        geometry: {
          type: 'Polygon' as const,
          // Coords are already [lon, lat] which is GeoJSON standard
          coordinates: [zone.coords],
        },
      })),
    };

    return new GeoJsonLayer({
      id: 'conflict-zones-layer',
      data: geojsonData,
      filled: true,
      stroked: true,
      getFillColor: () => COLORS.conflict,
      getLineColor: () => [255, 0, 0, 180] as [number, number, number, number],
      getLineWidth: 2,
      lineWidthMinPixels: 1,
      pickable: true,
    });
  }

  private createBasesLayer(): IconLayer {
    const highlightedBases = this.highlightedAssets.base;

    // Base colors by operator type - semi-transparent for layering
    const getBaseColor = (type: string): [number, number, number, number] => {
      switch (type) {
        case 'us-nato': return [68, 136, 255, 160];   // Blue
        case 'russia': return [255, 68, 68, 160];     // Red
        case 'china': return [255, 136, 68, 160];    // Orange
        case 'uk': return [68, 170, 255, 160];       // Light blue
        case 'france': return [0, 85, 164, 160];     // French blue
        case 'india': return [255, 153, 51, 160];    // Saffron
        case 'japan': return [188, 0, 45, 160];      // Rising sun red
        default: return [136, 136, 136, 160];        // Gray
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
      getRadius: 5000,
      getFillColor: [0, 200, 255, 160] as [number, number, number, number], // Cyan
      radiusMinPixels: 3,
      radiusMaxPixels: 8,
      pickable: true,
    });
  }

  private createFlightDelaysLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'flight-delays-layer',
      data: this.flightDelays,
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

  private createHotspotsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'hotspots-layer',
      data: this.hotspots,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        const score = d.escalationScore || 1;
        return 10000 + score * 5000;
      },
      getFillColor: (d) => {
        const score = d.escalationScore || 1;
        if (score >= 4) return COLORS.hotspotHigh;
        if (score >= 2) return COLORS.hotspotElevated;
        return COLORS.hotspotLow;
      },
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
      stroked: true,
      getLineColor: (d) =>
        d.hasBreaking ? [255, 255, 255, 255] as [number, number, number, number] : [0, 0, 0, 0] as [number, number, number, number],
      lineWidthMinPixels: 2,
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

  private createEarthquakesLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'earthquakes-layer',
      data: this.earthquakes,
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

  private createNaturalEventsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'natural-events-layer',
      data: this.naturalEvents,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: [255, 150, 50, 200] as [number, number, number, number],
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createWeatherLayer(): ScatterplotLayer {
    // Filter weather alerts that have coordinates
    const alertsWithCoords = this.weatherAlerts.filter(a =>
      'lat' in a && 'lon' in a && typeof (a as unknown as { lat: number }).lat === 'number'
    );

    return new ScatterplotLayer({
      id: 'weather-layer',
      data: alertsWithCoords,
      getPosition: (d) => [(d as unknown as { lon: number }).lon, (d as unknown as { lat: number }).lat],
      getRadius: 15000,
      getFillColor: (d) => {
        if (d.severity === 'Extreme') return [255, 0, 0, 180] as [number, number, number, number];
        if (d.severity === 'Severe') return [255, 100, 0, 180] as [number, number, number, number];
        return COLORS.weather;
      },
      radiusMinPixels: 5,
      radiusMaxPixels: 15,
      pickable: true,
    });
  }

  private createOutagesLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'outages-layer',
      data: this.outages,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 20000,
      getFillColor: COLORS.outage,
      radiusMinPixels: 6,
      radiusMaxPixels: 18,
      pickable: true,
    });
  }

  private createAisDensityLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'ais-density-layer',
      data: this.aisDensity,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 5000 + d.intensity * 2000,
      getFillColor: (d) => {
        const alpha = Math.min(50 + d.intensity * 20, 200);
        return [100, 200, 255, alpha] as [number, number, number, number];
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 20,
      pickable: true,
    });
  }

  // Note: Protests layer now rendered via HTML overlays in renderProtestClusters()

  private createMilitaryVesselsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'military-vessels-layer',
      data: this.militaryVessels,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: COLORS.vesselMilitary,
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  private createMilitaryFlightsLayer(): ScatterplotLayer {
    // Render military flights as scatter points (simpler than arcs)
    return new ScatterplotLayer({
      id: 'military-flights-layer',
      data: this.militaryFlights,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: COLORS.flightMilitary,
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
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

  // Note: Tech HQs layer now rendered via HTML overlays in renderTechHQClusters()

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

  // Note: Tech Events layer now rendered via HTML overlays in renderTechEventClusters()

  // Tooltip and click handlers
  private getTooltip(info: PickingInfo): { html: string } | null {
    if (!info.object) return null;

    const layerId = info.layer?.id || '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = info.object as any;

    if (layerId === 'hotspots-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.subtext || ''}</div>` };
    }

    if (layerId === 'earthquakes-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>M${(obj.magnitude || 0).toFixed(1)} Earthquake</strong><br/>${obj.place || ''}</div>` };
    }

    if (layerId === 'military-vessels-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.operatorCountry || ''}</div>` };
    }

    if (layerId === 'military-flights-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.callsign || obj.registration || 'Military Aircraft'}</strong><br/>${obj.type || ''}</div>` };
    }

    if (layerId === 'protests-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.title || ''}</strong><br/>${obj.country || ''}</div>` };
    }

    if (layerId === 'bases-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.country || ''}</div>` };
    }

    if (layerId === 'nuclear-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.type || ''}</div>` };
    }

    if (layerId === 'datacenters-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.owner || ''}</div>` };
    }

    if (layerId === 'cables-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>Undersea Cable</div>` };
    }

    if (layerId === 'pipelines-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.type || ''} Pipeline</div>` };
    }

    if (layerId === 'conflict-zones-layer') {
      const props = obj.properties || obj;
      return { html: `<div class="deckgl-tooltip"><strong>${props.name || ''}</strong><br/>Conflict Zone</div>` };
    }

    if (layerId === 'natural-events-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.title || ''}</strong><br/>${obj.category || 'Natural Event'}</div>` };
    }

    if (layerId === 'weather-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.event || 'Weather Alert'}</strong><br/>${obj.severity || ''}</div>` };
    }

    if (layerId === 'outages-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.asn || 'Internet Outage'}</strong><br/>${obj.country || ''}</div>` };
    }

    if (layerId === 'ais-density-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>Ship Traffic</strong><br/>Intensity: ${obj.intensity || ''}</div>` };
    }

    if (layerId === 'waterways-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>Strategic Waterway</div>` };
    }

    if (layerId === 'economic-centers-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.country || ''}</div>` };
    }

    if (layerId === 'startup-hubs-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.city || ''}</strong><br/>${obj.country || ''}</div>` };
    }

    if (layerId === 'tech-hqs-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.company || ''}</strong><br/>${obj.city || ''}</div>` };
    }

    if (layerId === 'accelerators-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.city || ''}</div>` };
    }

    if (layerId === 'cloud-regions-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.provider || ''}</strong><br/>${obj.region || ''}</div>` };
    }

    if (layerId === 'tech-events-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.title || ''}</strong><br/>${obj.location || ''}</div>` };
    }

    if (layerId === 'irradiators-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.type || 'Gamma Irradiator'}</div>` };
    }

    if (layerId === 'spaceports-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.country || 'Spaceport'}</div>` };
    }

    if (layerId === 'ports-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.name || ''}</strong><br/>${obj.country || 'Port'}</div>` };
    }

    if (layerId === 'flight-delays-layer') {
      return { html: `<div class="deckgl-tooltip"><strong>${obj.airport || ''}</strong><br/>${obj.severity || ''}: ${obj.reason || ''}</div>` };
    }

    return null;
  }

  private handleClick(info: PickingInfo): void {
    if (!info.object) return;

    const layerId = info.layer?.id || '';

    // Hotspots have their own click handler - don't show popup
    if (layerId === 'hotspots-layer') {
      if (this.onHotspotClick) {
        this.onHotspotClick(info.object as Hotspot);
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
      'protests-layer': 'protest',
      'military-flights-layer': 'militaryFlight',
      'military-vessels-layer': 'militaryVessel',
      'natural-events-layer': 'natEvent',
      'waterways-layer': 'waterway',
      'economic-centers-layer': 'economic',
      'spaceports-layer': 'spaceport',
      'ports-layer': 'port',
      'flight-delays-layer': 'flight',
      'startup-hubs-layer': 'startupHub',
      'tech-hqs-layer': 'techHQ',
      'accelerators-layer': 'accelerator',
      'cloud-regions-layer': 'cloudRegion',
      'tech-events-layer': 'techEvent',
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
        <button class="map-btn zoom-in" title="Zoom In">+</button>
        <button class="map-btn zoom-out" title="Zoom Out">-</button>
        <button class="map-btn zoom-reset" title="Reset View">&#8962;</button>
      </div>
      <div class="view-selector">
        <select class="view-select">
          <option value="global">Global</option>
          <option value="america">Americas</option>
          <option value="mena">MENA</option>
          <option value="eu">Europe</option>
          <option value="asia">Asia</option>
          <option value="latam">Latin America</option>
          <option value="africa">Africa</option>
          <option value="oceania">Oceania</option>
        </select>
      </div>
    `;

    this.container.appendChild(controls);

    // Bind events
    controls.querySelector('.zoom-in')?.addEventListener('click', () => this.zoomIn());
    controls.querySelector('.zoom-out')?.addEventListener('click', () => this.zoomOut());
    controls.querySelector('.zoom-reset')?.addEventListener('click', () => this.resetView());

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
        <button class="time-btn ${this.state.timeRange === 'all' ? 'active' : ''}" data-range="all">All</button>
      </div>
    `;

    this.container.appendChild(slider);

    slider.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = (btn as HTMLElement).dataset.range as TimeRange;
        this.setTimeRange(range);
        slider.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  private createLayerToggles(): void {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles deckgl-layer-toggles';

    const layerConfig = SITE_VARIANT === 'tech'
      ? [
          { key: 'startupHubs', label: 'Startup Hubs', icon: '&#128640;' },
          { key: 'techHQs', label: 'Tech HQs', icon: '&#127970;' },
          { key: 'accelerators', label: 'Accelerators', icon: '&#9889;' },
          { key: 'cloudRegions', label: 'Cloud Regions', icon: '&#9729;' },
          { key: 'datacenters', label: 'AI Data Centers', icon: '&#128421;' },
          { key: 'cables', label: 'Undersea Cables', icon: '&#128268;' },
          { key: 'outages', label: 'Internet Outages', icon: '&#128225;' },
          { key: 'techEvents', label: 'Tech Events', icon: '&#128197;' },
          { key: 'natural', label: 'Natural Events', icon: '&#127755;' },
        ]
      : [
          { key: 'hotspots', label: 'Intel Hotspots', icon: '&#127919;' },
          { key: 'conflicts', label: 'Conflict Zones', icon: '&#9876;' },
          { key: 'bases', label: 'Military Bases', icon: '&#127963;' },
          { key: 'nuclear', label: 'Nuclear Sites', icon: '&#9762;' },
          { key: 'cables', label: 'Undersea Cables', icon: '&#128268;' },
          { key: 'pipelines', label: 'Pipelines', icon: '&#128738;' },
          { key: 'datacenters', label: 'AI Data Centers', icon: '&#128421;' },
          { key: 'military', label: 'Military Activity', icon: '&#9992;' },
          { key: 'ais', label: 'Ship Traffic', icon: '&#128674;' },
          { key: 'protests', label: 'Protests', icon: '&#128226;' },
          { key: 'weather', label: 'Weather Alerts', icon: '&#9928;' },
          { key: 'outages', label: 'Internet Outages', icon: '&#128225;' },
          { key: 'natural', label: 'Natural Events', icon: '&#127755;' },
          { key: 'waterways', label: 'Strategic Waterways', icon: '&#9875;' },
          { key: 'economic', label: 'Economic Centers', icon: '&#128176;' },
        ];

    toggles.innerHTML = `
      <div class="toggle-header">
        <span>Layers</span>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <div class="toggle-list">
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
          this.updateLayers();
          this.onLayerChange?.(layer, (input as HTMLInputElement).checked);
        }
      });
    });

    // Collapse toggle
    const collapseBtn = toggles.querySelector('.toggle-collapse');
    const toggleList = toggles.querySelector('.toggle-list');
    collapseBtn?.addEventListener('click', () => {
      toggleList?.classList.toggle('collapsed');
      if (collapseBtn) collapseBtn.innerHTML = toggleList?.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
    });
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

    const legendItems = SITE_VARIANT === 'tech'
      ? [
          { shape: shapes.circle('rgb(0, 255, 150)'), label: 'Startup Hub' },
          { shape: shapes.circle('rgb(100, 200, 255)'), label: 'Tech HQ' },
          { shape: shapes.circle('rgb(255, 200, 0)'), label: 'Accelerator' },
          { shape: shapes.circle('rgb(150, 100, 255)'), label: 'Cloud Region' },
          { shape: shapes.square('rgb(136, 68, 255)'), label: 'Datacenter' },
        ]
      : [
          { shape: shapes.circle('rgb(255, 68, 68)'), label: 'High Alert' },
          { shape: shapes.circle('rgb(255, 165, 0)'), label: 'Elevated' },
          { shape: shapes.circle('rgb(255, 255, 0)'), label: 'Monitoring' },
          { shape: shapes.triangle('rgb(68, 136, 255)'), label: 'Base' },
          { shape: shapes.hexagon('rgb(255, 220, 0)'), label: 'Nuclear' },
          { shape: shapes.square('rgb(136, 68, 255)'), label: 'Datacenter' },
        ];

    legend.innerHTML = `
      <span class="legend-label-title">LEGEND</span>
      ${legendItems.map(({ shape, label }) => `<span class="legend-item">${shape}<span class="legend-label">${label}</span></span>`).join('')}
    `;

    this.container.appendChild(legend);
  }

  private createTimestamp(): void {
    const timestamp = document.createElement('div');
    // Only use deckgl-timestamp class - map-timestamp has conflicting positioning
    timestamp.className = 'deckgl-timestamp';
    timestamp.id = 'deckglTimestamp';
    this.container.appendChild(timestamp);

    this.updateTimestamp();
    this.timestampIntervalId = setInterval(() => this.updateTimestamp(), 1000);
  }

  private updateTimestamp(): void {
    const el = document.getElementById('deckglTimestamp');
    if (el) {
      const now = new Date();
      el.textContent = `${now.toUTCString().replace('GMT', 'UTC')}`;
    }
  }

  // Public API methods (matching MapComponent interface)
  public render(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;

    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.updateLayers();
    });
  }

  private updateLayers(): void {
    if (this.deckOverlay) {
      this.deckOverlay.setProps({ layers: this.buildLayers() });
    }
    // Update cluster overlays as well
    this.renderClusterOverlays();
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

  public setCenter(lat: number, lon: number): void {
    if (this.maplibreMap) {
      this.maplibreMap.flyTo({
        center: [lon, lat],
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
    this.onTimeRangeChange?.(range);
    this.updateLayers();
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setLayers(layers: MapLayers): void {
    this.state.layers = layers;
    this.updateLayers();

    // Update toggle checkboxes
    Object.entries(layers).forEach(([key, value]) => {
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${key}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = value;
    });
  }

  public getState(): DeckMapState {
    return { ...this.state };
  }

  // Zoom controls
  private zoomIn(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomIn();
    }
  }

  private zoomOut(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomOut();
    }
  }

  private resetView(): void {
    this.setView('global');
  }

  // Data setters
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.updateLayers();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.updateLayers();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.updateLayers();
  }

  public setAisData(_disruptions: AisDisruptionEvent[], density: AisDensityZone[]): void {
    this.aisDensity = density;
    this.updateLayers();
  }

  public setCableActivity(_advisories: CableAdvisory[], _repairShips: RepairShip[]): void {
    // Cable activity stored for reference
    this.updateLayers();
  }

  public setProtests(events: SocialUnrestEvent[]): void {
    this.protests = events;
    this.updateLayers();
  }

  public setFlightDelays(delays: AirportDelayAlert[]): void {
    this.flightDelays = delays;
    this.updateLayers();
  }

  public setMilitaryFlights(flights: MilitaryFlight[], _clusters: MilitaryFlightCluster[] = []): void {
    this.militaryFlights = flights;
    this.updateLayers();
  }

  public setMilitaryVessels(vessels: MilitaryVessel[], _clusters: MilitaryVesselCluster[] = []): void {
    this.militaryVessels = vessels;
    this.updateLayers();
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalEvents = events;
    this.updateLayers();
  }

  public setTechEvents(events: TechEventMarker[]): void {
    this.techEvents = events;
    this.updateLayers();
  }

  public updateHotspotActivity(news: NewsItem[]): void {
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

    this.updateLayers();
  }

  public updateMilitaryForEscalation(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
    setMilitaryData(flights, vessels);
  }

  public getHotspotDynamicScore(hotspotId: string) {
    return getHotspotEscalation(hotspotId);
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    // Clear previous highlights
    Object.values(this.highlightedAssets).forEach(set => set.clear());

    if (assets) {
      assets.forEach(asset => {
        this.highlightedAssets[asset.type].add(asset.id);
      });
    }

    this.updateLayers();
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
      levels[h.id] = h.level || 'low';
    });
    return levels;
  }

  public setHotspotLevels(levels: Record<string, string>): void {
    this.hotspots.forEach(h => {
      if (levels[h.id]) {
        h.level = levels[h.id] as 'low' | 'elevated' | 'high';
      }
    });
    this.updateLayers();
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
    if (toggle) {
      toggle.classList.remove('loading');
      toggle.classList.toggle('has-data', hasData);
    }
  }

  public flashAssets(assetType: AssetType, ids: string[]): void {
    // Temporarily highlight assets
    ids.forEach(id => this.highlightedAssets[assetType].add(id));
    this.updateLayers();

    setTimeout(() => {
      ids.forEach(id => this.highlightedAssets[assetType].delete(id));
      this.updateLayers();
    }, 3000);
  }

  // Enable layer programmatically
  public enableLayer(layer: keyof MapLayers): void {
    if (!this.state.layers[layer]) {
      this.state.layers[layer] = true;
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = true;
      this.updateLayers();
      this.onLayerChange?.(layer, true);
    }
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
    if (hotspot) {
      // Don't pan - just trigger the callback (popup will show at screen position)
      this.onHotspotClick?.(hotspot);
    }
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

  public destroy(): void {
    if (this.timestampIntervalId) {
      clearInterval(this.timestampIntervalId);
    }

    this.deckOverlay?.finalize();
    this.maplibreMap?.remove();

    this.container.innerHTML = '';
  }
}
