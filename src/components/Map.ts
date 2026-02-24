import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import { escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, Geometry } from 'geojson';
import type { MapLayers, Hotspot, NewsItem, InternetOutage, RelatedAsset, AssetType, AisDisruptionEvent, AisDensityZone, CableAdvisory, RepairShip, SocialUnrestEvent, MilitaryFlight, MilitaryVessel, MilitaryFlightCluster, MilitaryVesselCluster, NaturalEvent, CyberThreat, CableHealthRecord } from '@/types';
import type { AirportDelayAlert } from '@/services/aviation';
import type { Earthquake } from '@/services/earthquakes';
import type { TechHubActivity } from '@/services/tech-activity';
import type { GeoHubActivity } from '@/services/geo-activity';
import { getNaturalEventIcon } from '@/services/eonet';
import type { WeatherAlert } from '@/services/weather';
import { getSeverityColor } from '@/services/weather';
import {
  MAP_URLS,
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  MILITARY_BASES,
  UNDERSEA_CABLES,
  NUCLEAR_FACILITIES,
  GAMMA_IRRADIATORS,
  PIPELINES,
  PIPELINE_COLORS,
  SANCTIONED_COUNTRIES,
  STRATEGIC_WATERWAYS,
  APT_GROUPS,
  ECONOMIC_CENTERS,
  AI_DATA_CENTERS,
  PORTS,
  SPACEPORTS,
  CRITICAL_MINERALS,
  SITE_VARIANT,
  // Tech variant data
  STARTUP_HUBS,
  ACCELERATORS,
  TECH_HQS,
  CLOUD_REGIONS,
  // Finance variant data
  STOCK_EXCHANGES,
  FINANCIAL_CENTERS,
  CENTRAL_BANKS,
  COMMODITY_HUBS,
} from '@/config';
import { MapPopup } from './MapPopup';
import {
  updateHotspotEscalation,
  getHotspotEscalation,
  setMilitaryData,
  setCIIGetter,
  setGeoAlertGetter,
} from '@/services/hotspot-escalation';
import { getCountryScore } from '@/services/country-instability';
import { getAlertsNearLocation } from '@/services/geo-convergence';
import { t } from '@/services/i18n';

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

interface MapState {
  zoom: number;
  pan: { x: number; y: number };
  view: MapView;
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

interface WorldTopology extends Topology {
  objects: {
    countries: GeometryCollection;
  };
}

export class MapComponent {
  private static readonly LAYER_ZOOM_THRESHOLDS: Partial<
    Record<keyof MapLayers, { minZoom: number; showLabels?: number }>
  > = {
    bases: { minZoom: 3, showLabels: 5 },
    nuclear: { minZoom: 2 },
    conflicts: { minZoom: 1, showLabels: 3 },
    economic: { minZoom: 2 },
    natural: { minZoom: 1, showLabels: 2 },
  };

  private container: HTMLElement;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private wrapper: HTMLElement;
  private overlays: HTMLElement;
  private clusterCanvas: HTMLCanvasElement;
  private clusterGl: WebGLRenderingContext | null = null;
  private state: MapState;
  private worldData: WorldTopology | null = null;
  private countryFeatures: Feature<Geometry>[] | null = null;
  private baseLayerGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private dynamicLayerGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private baseRendered = false;
  private baseWidth = 0;
  private baseHeight = 0;
  private hotspots: HotspotWithBreaking[];
  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private outages: InternetOutage[] = [];
  private aisDisruptions: AisDisruptionEvent[] = [];
  private aisDensity: AisDensityZone[] = [];
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private healthByCableId: Record<string, CableHealthRecord> = {};
  private protests: SocialUnrestEvent[] = [];
  private flightDelays: AirportDelayAlert[] = [];
  private militaryFlights: MilitaryFlight[] = [];
  private militaryFlightClusters: MilitaryFlightCluster[] = [];
  private militaryVessels: MilitaryVessel[] = [];
  private militaryVesselClusters: MilitaryVesselCluster[] = [];
  private naturalEvents: NaturalEvent[] = [];
  private firmsFireData: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }> = [];
  private techEvents: TechEventMarker[] = [];
  private techActivities: TechHubActivity[] = [];
  private geoActivities: GeoHubActivity[] = [];
  private news: NewsItem[] = [];
  private onTechHubClick?: (hub: TechHubActivity) => void;
  private onGeoHubClick?: (hub: GeoHubActivity) => void;
  private popup: MapPopup;
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void;
  private layerZoomOverrides: Partial<Record<keyof MapLayers, boolean>> = {};
  private onStateChange?: (state: MapState) => void;
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    base: new Set(),
    nuclear: new Set(),
  };
  private boundVisibilityHandler!: () => void;
  private renderScheduled = false;
  private lastRenderTime = 0;
  private readonly MIN_RENDER_INTERVAL_MS = 100;
  private healthCheckIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement, initialState: MapState) {
    this.container = container;
    this.state = initialState;
    this.hotspots = [...INTEL_HOTSPOTS];

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'map-wrapper';
    this.wrapper.id = 'mapWrapper';

    const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgElement.classList.add('map-svg');
    svgElement.id = 'mapSvg';
    this.wrapper.appendChild(svgElement);

    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.className = 'map-cluster-canvas';
    this.clusterCanvas.id = 'mapClusterCanvas';
    this.wrapper.appendChild(this.clusterCanvas);

    // Overlays inside wrapper so they transform together on zoom/pan
    this.overlays = document.createElement('div');
    this.overlays.id = 'mapOverlays';
    this.wrapper.appendChild(this.overlays);

    container.appendChild(this.wrapper);
    container.appendChild(this.createControls());
    container.appendChild(this.createTimeSlider());
    container.appendChild(this.createLayerToggles());
    container.appendChild(this.createLegend());
    this.healthCheckIntervalId = setInterval(() => this.runHealthCheck(), 30000);

    this.svg = d3.select(svgElement);
    this.baseLayerGroup = this.svg.append('g').attr('class', 'map-base');
    this.dynamicLayerGroup = this.svg.append('g').attr('class', 'map-dynamic');
    this.popup = new MapPopup(container);
    this.initClusterRenderer();

    this.setupZoomHandlers();
    this.loadMapData();
    this.setupResizeObserver();

    window.addEventListener('theme-changed', () => {
      this.baseRendered = false;
      this.render();
    });
  }

  private setupResizeObserver(): void {
    let lastWidth = 0;
    let lastHeight = 0;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
          lastWidth = width;
          lastHeight = height;
          requestAnimationFrame(() => this.render());
        }
      }
    });
    resizeObserver.observe(this.container);

    // Re-render when page becomes visible again (after browser throttling)
    this.boundVisibilityHandler = () => {
      if (!document.hidden) {
        requestAnimationFrame(() => this.render());
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  public destroy(): void {
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
  }

  private createControls(): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'map-controls';
    controls.innerHTML = `
      <button class="map-control-btn" data-action="zoom-in">+</button>
      <button class="map-control-btn" data-action="zoom-out">−</button>
      <button class="map-control-btn" data-action="reset">⟲</button>
    `;

    controls.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.dataset.action;
      if (action === 'zoom-in') this.zoomIn();
      else if (action === 'zoom-out') this.zoomOut();
      else if (action === 'reset') this.reset();
    });

    return controls;
  }

  private createTimeSlider(): HTMLElement {
    const slider = document.createElement('div');
    slider.className = 'time-slider';
    slider.id = 'timeSlider';

    const ranges: { value: TimeRange; label: string }[] = [
      { value: '1h', label: '1H' },
      { value: '6h', label: '6H' },
      { value: '24h', label: '24H' },
      { value: '48h', label: '48H' },
      { value: '7d', label: '7D' },
      { value: 'all', label: 'ALL' },
    ];

    slider.innerHTML = `
      <span class="time-slider-label">TIME RANGE</span>
      <div class="time-slider-buttons">
        ${ranges
          .map(
            (r) =>
              `<button class="time-btn ${this.state.timeRange === r.value ? 'active' : ''}" data-range="${r.value}">${r.label}</button>`
          )
          .join('')}
      </div>
    `;

    slider.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('time-btn')) {
        const range = target.dataset.range as TimeRange;
        this.setTimeRange(range);
        slider.querySelectorAll('.time-btn').forEach((btn) => btn.classList.remove('active'));
        target.classList.add('active');
      }
    });

    return slider;
  }

  private updateTimeSliderButtons(): void {
    const slider = this.container.querySelector('#timeSlider');
    if (!slider) return;
    slider.querySelectorAll('.time-btn').forEach((btn) => {
      const range = (btn as HTMLElement).dataset.range as TimeRange | undefined;
      btn.classList.toggle('active', range === this.state.timeRange);
    });
  }

  public setTimeRange(range: TimeRange): void {
    this.state.timeRange = range;
    this.onTimeRangeChange?.(range);
    this.updateTimeSliderButtons();
    this.render();
  }

  private getTimeRangeMs(): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[this.state.timeRange];
  }



  private createLayerToggles(): HTMLElement {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles';
    toggles.id = 'layerToggles';

    // Variant-aware layer buttons
    const fullLayers: (keyof MapLayers)[] = [
      'conflicts', 'hotspots', 'sanctions', 'protests',  // geopolitical
      'bases', 'nuclear', 'irradiators',                 // military/strategic
      'military',                                         // military tracking (flights + vessels)
      'cables', 'pipelines', 'outages', 'datacenters',   // infrastructure
      // cyberThreats is intentionally hidden on SVG/mobile fallback (DeckGL desktop only)
      'ais', 'flights',                                   // transport
      'natural', 'weather',                               // natural
      'economic',                                         // economic
      'waterways',                                        // labels
    ];
    const techLayers: (keyof MapLayers)[] = [
      'cables', 'datacenters', 'outages',                // tech infrastructure
      'startupHubs', 'cloudRegions', 'accelerators', 'techHQs', 'techEvents', // tech ecosystem
      'natural', 'weather',                               // natural events
      'economic',                                         // economic/geographic
    ];
    const financeLayers: (keyof MapLayers)[] = [
      'stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', // finance ecosystem
      'cables', 'pipelines', 'outages',                   // infrastructure
      'sanctions', 'economic', 'waterways',               // geopolitical/economic
      'natural', 'weather',                               // natural events
    ];
    const layers = SITE_VARIANT === 'tech' ? techLayers : SITE_VARIANT === 'finance' ? financeLayers : fullLayers;
    const layerLabelKeys: Partial<Record<keyof MapLayers, string>> = {
      hotspots: 'components.deckgl.layers.intelHotspots',
      conflicts: 'components.deckgl.layers.conflictZones',
      bases: 'components.deckgl.layers.militaryBases',
      nuclear: 'components.deckgl.layers.nuclearSites',
      irradiators: 'components.deckgl.layers.gammaIrradiators',
      military: 'components.deckgl.layers.militaryActivity',
      cables: 'components.deckgl.layers.underseaCables',
      pipelines: 'components.deckgl.layers.pipelines',
      outages: 'components.deckgl.layers.internetOutages',
      datacenters: 'components.deckgl.layers.aiDataCenters',
      ais: 'components.deckgl.layers.shipTraffic',
      flights: 'components.deckgl.layers.flightDelays',
      natural: 'components.deckgl.layers.naturalEvents',
      weather: 'components.deckgl.layers.weatherAlerts',
      economic: 'components.deckgl.layers.economicCenters',
      waterways: 'components.deckgl.layers.strategicWaterways',
      startupHubs: 'components.deckgl.layers.startupHubs',
      cloudRegions: 'components.deckgl.layers.cloudRegions',
      accelerators: 'components.deckgl.layers.accelerators',
      techHQs: 'components.deckgl.layers.techHQs',
      techEvents: 'components.deckgl.layers.techEvents',
      stockExchanges: 'components.deckgl.layers.stockExchanges',
      financialCenters: 'components.deckgl.layers.financialCenters',
      centralBanks: 'components.deckgl.layers.centralBanks',
      commodityHubs: 'components.deckgl.layers.commodityHubs',
      gulfInvestments: 'components.deckgl.layers.gulfInvestments',
    };
    const getLayerLabel = (layer: keyof MapLayers): string => {
      if (layer === 'sanctions') return t('components.deckgl.layerHelp.labels.sanctions');
      const key = layerLabelKeys[layer];
      return key ? t(key) : layer;
    };

    layers.forEach((layer) => {
      const btn = document.createElement('button');
      btn.className = `layer-toggle ${this.state.layers[layer] ? 'active' : ''}`;
      btn.dataset.layer = layer;
      btn.textContent = getLayerLabel(layer);
      btn.addEventListener('click', () => this.toggleLayer(layer));
      toggles.appendChild(btn);
    });

    // Add help button
    const helpBtn = document.createElement('button');
    helpBtn.className = 'layer-help-btn';
    helpBtn.textContent = '?';
    helpBtn.title = t('components.deckgl.layerGuide');
    helpBtn.addEventListener('click', () => this.showLayerHelp());
    toggles.appendChild(helpBtn);

    return toggles;
  }

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
        <button class="layer-help-close">×</button>
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
        ])}
        ${helpSection('macroContext', [
          helpItem(label('economicCenters'), 'economicCenters'),
          helpItem(label('strategicWaterways'), 'macroWaterways'),
          helpItem(label('weatherAlerts'), 'weatherAlertsMarket'),
          helpItem(label('naturalEvents'), 'naturalEventsMacro'),
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
        ${helpSection('labels', [
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

  private syncLayerButtons(): void {
    this.container.querySelectorAll<HTMLButtonElement>('.layer-toggle').forEach((btn) => {
      const layer = btn.dataset.layer as keyof MapLayers | undefined;
      if (!layer) return;
      btn.classList.toggle('active', this.state.layers[layer]);
    });
  }

  private createLegend(): HTMLElement {
    const legend = document.createElement('div');
    legend.className = 'map-legend';

    if (SITE_VARIANT === 'tech') {
      // Tech variant legend
      legend.innerHTML = `
        <div class="map-legend-item"><span class="legend-dot" style="background:#8b5cf6"></span>${escapeHtml(t('components.deckgl.layers.techHQs').toUpperCase())}</div>
        <div class="map-legend-item"><span class="legend-dot" style="background:#06b6d4"></span>${escapeHtml(t('components.deckgl.layers.startupHubs').toUpperCase())}</div>
        <div class="map-legend-item"><span class="legend-dot" style="background:#f59e0b"></span>${escapeHtml(t('components.deckgl.layers.cloudRegions').toUpperCase())}</div>
        <div class="map-legend-item"><span class="map-legend-icon" style="color:#a855f7">📅</span>${escapeHtml(t('components.deckgl.layers.techEvents').toUpperCase())}</div>
        <div class="map-legend-item"><span class="map-legend-icon" style="color:#4ecdc4">💾</span>${escapeHtml(t('components.deckgl.layers.aiDataCenters').toUpperCase())}</div>
      `;
    } else {
      // Geopolitical variant legend
      legend.innerHTML = `
        <div class="map-legend-item"><span class="legend-dot high"></span>${escapeHtml((t('popups.hotspot.levels.high') ?? 'HIGH').toUpperCase())}</div>
        <div class="map-legend-item"><span class="legend-dot elevated"></span>${escapeHtml((t('popups.hotspot.levels.elevated') ?? 'ELEVATED').toUpperCase())}</div>
        <div class="map-legend-item"><span class="legend-dot low"></span>${escapeHtml((t('popups.monitoring') ?? 'MONITORING').toUpperCase())}</div>
        <div class="map-legend-item"><span class="map-legend-icon conflict">⚔</span>${escapeHtml(t('modals.search.types.conflict').toUpperCase())}</div>
        <div class="map-legend-item"><span class="map-legend-icon earthquake">●</span>${escapeHtml(t('modals.search.types.earthquake').toUpperCase())}</div>
        <div class="map-legend-item"><span class="map-legend-icon apt">⚠</span>APT</div>
      `;
    }
    return legend;
  }

  private runHealthCheck(): void {
    // Skip if page is hidden (no need to check while user isn't looking)
    if (document.hidden) return;

    const svgNode = this.svg.node();
    if (!svgNode) return;

    // Verify base layer exists and has content
    const baseGroup = svgNode.querySelector('.map-base');
    const countryCount = baseGroup?.querySelectorAll('.country').length ?? 0;

    // If we have country data but no rendered countries, something is wrong
    if (this.countryFeatures && this.countryFeatures.length > 0 && countryCount === 0) {
      console.warn('[Map] Health check: Base layer missing countries, initiating recovery');
      this.baseRendered = false;
      // Also check if d3 selection is stale
      if (baseGroup && this.baseLayerGroup?.node() !== baseGroup) {
        console.warn('[Map] Health check: Stale d3 selection detected');
      }
      this.render();
    }
  }

  private setupZoomHandlers(): void {
    let isDragging = false;
    let lastPos = { x: 0, y: 0 };
    let lastTouchDist = 0;
    let lastTouchCenter = { x: 0, y: 0 };
    const shouldIgnoreInteractionStart = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return Boolean(
        target.closest(
          '.map-controls, .time-slider, .layer-toggles, .map-legend, .layer-help-popup, .map-popup, button, select, input, textarea, a'
        )
      );
    };

    // Wheel zoom with smooth delta
    this.container.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();

        // Check if this is a pinch gesture (ctrlKey is set for trackpad pinch)
        if (e.ctrlKey) {
          // Pinch-to-zoom on trackpad
          const zoomDelta = -e.deltaY * 0.01;
          this.state.zoom = Math.max(1, Math.min(10, this.state.zoom + zoomDelta));
        } else {
          // Two-finger scroll for pan, regular scroll for zoom
          if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 || e.shiftKey) {
            // Horizontal scroll or shift+scroll = pan
            const panSpeed = 2 / this.state.zoom;
            this.state.pan.x -= e.deltaX * panSpeed;
            this.state.pan.y -= e.deltaY * panSpeed;
          } else {
            // Vertical scroll = zoom
            const zoomDelta = e.deltaY > 0 ? -0.15 : 0.15;
            this.state.zoom = Math.max(1, Math.min(10, this.state.zoom + zoomDelta));
          }
        }
        this.applyTransform();
      },
      { passive: false }
    );

    // Mouse drag for panning
    this.container.addEventListener('mousedown', (e) => {
      if (shouldIgnoreInteractionStart(e.target)) return;
      if (e.button === 0) { // Left click
        isDragging = true;
        lastPos = { x: e.clientX, y: e.clientY };
        this.container.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const dx = e.clientX - lastPos.x;
      const dy = e.clientY - lastPos.y;

      const panSpeed = 1 / this.state.zoom;
      this.state.pan.x += dx * panSpeed;
      this.state.pan.y += dy * panSpeed;

      lastPos = { x: e.clientX, y: e.clientY };
      this.applyTransform();
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.container.style.cursor = 'grab';
      }
    });

    // Touch events for mobile and trackpad
    this.container.addEventListener('touchstart', (e) => {
      if (shouldIgnoreInteractionStart(e.target)) return;
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      if (e.touches.length === 2 && touch1 && touch2) {
        e.preventDefault();
        lastTouchDist = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        lastTouchCenter = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2,
        };
      } else if (e.touches.length === 1 && touch1) {
        isDragging = true;
        lastPos = { x: touch1.clientX, y: touch1.clientY };
      }
    }, { passive: false });

    this.container.addEventListener('touchmove', (e) => {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      if (e.touches.length === 2 && touch1 && touch2) {
        e.preventDefault();

        // Pinch zoom
        const dist = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        const scale = dist / lastTouchDist;
        this.state.zoom = Math.max(1, Math.min(10, this.state.zoom * scale));
        lastTouchDist = dist;

        // Two-finger pan
        const center = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2,
        };
        const panSpeed = 1 / this.state.zoom;
        this.state.pan.x += (center.x - lastTouchCenter.x) * panSpeed;
        this.state.pan.y += (center.y - lastTouchCenter.y) * panSpeed;
        lastTouchCenter = center;

        this.applyTransform();
      } else if (e.touches.length === 1 && isDragging && touch1) {
        const dx = touch1.clientX - lastPos.x;
        const dy = touch1.clientY - lastPos.y;

        const panSpeed = 1 / this.state.zoom;
        this.state.pan.x += dx * panSpeed;
        this.state.pan.y += dy * panSpeed;

        lastPos = { x: touch1.clientX, y: touch1.clientY };
        this.applyTransform();
      }
    }, { passive: false });

    this.container.addEventListener('touchend', () => {
      isDragging = false;
      lastTouchDist = 0;
    });

    // Set initial cursor
    this.container.style.cursor = 'grab';
  }

  private async loadMapData(): Promise<void> {
    try {
      const worldResponse = await fetch(MAP_URLS.world);
      this.worldData = await worldResponse.json();
      if (this.worldData) {
        const countries = topojson.feature(
          this.worldData,
          this.worldData.objects.countries
        );
        this.countryFeatures = 'features' in countries ? countries.features : [countries];
      }
      this.baseRendered = false;
      this.render();
      // Re-render after layout stabilizes to catch full container width
      requestAnimationFrame(() => requestAnimationFrame(() => this.render()));
    } catch (e) {
      console.error('Failed to load map data:', e);
    }
  }

  private initClusterRenderer(): void {
    // WebGL clustering disabled - just get context for clearing canvas
    const gl = this.clusterCanvas.getContext('webgl');
    if (!gl) return;
    this.clusterGl = gl;
  }

  private clearClusterCanvas(): void {
    if (!this.clusterGl) return;
    this.clusterGl.clearColor(0, 0, 0, 0);
    this.clusterGl.clear(this.clusterGl.COLOR_BUFFER_BIT);
  }

  private renderClusterLayer(_projection: d3.GeoProjection): void {
    // WebGL clustering disabled - all layers use HTML markers for visual fidelity
    // (severity colors, emoji icons, magnitude sizing, animations)
    this.wrapper.classList.toggle('cluster-active', false);
    this.clearClusterCanvas();
  }

  public scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  public render(): void {
    const now = performance.now();
    if (now - this.lastRenderTime < this.MIN_RENDER_INTERVAL_MS) {
      this.scheduleRender();
      return;
    }
    this.lastRenderTime = now;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    // Skip render if container has no dimensions (tab throttled, hidden, etc.)
    if (width === 0 || height === 0) {
      return;
    }

    // Simple viewBox matching container - keeps SVG and overlays aligned
    if (!this.svg) return;
    this.svg.attr('viewBox', `0 0 ${width} ${height}`);

    // CRITICAL: Always refresh d3 selections from actual DOM to prevent stale references
    // D3 selections can become stale if the DOM is modified externally
    const svgNode = this.svg.node();
    if (!svgNode) return;

    // Query DOM directly for layer groups
    const existingBase = svgNode.querySelector('.map-base') as SVGGElement | null;
    const existingDynamic = svgNode.querySelector('.map-dynamic') as SVGGElement | null;

    // Recreate layer groups if missing or if d3 selections are stale
    const baseStale = !existingBase || this.baseLayerGroup?.node() !== existingBase;
    const dynamicStale = !existingDynamic || this.dynamicLayerGroup?.node() !== existingDynamic;

    if (baseStale || dynamicStale) {
      // Clear any orphaned groups and create fresh ones
      svgNode.querySelectorAll('.map-base, .map-dynamic').forEach(el => el.remove());
      this.baseLayerGroup = this.svg.append('g').attr('class', 'map-base');
      this.dynamicLayerGroup = this.svg.append('g').attr('class', 'map-dynamic');
      this.baseRendered = false;
      console.warn('[Map] Layer groups recreated - baseStale:', baseStale, 'dynamicStale:', dynamicStale);
    }

    // Double-check selections are valid after recreation
    if (!this.baseLayerGroup?.node() || !this.dynamicLayerGroup?.node()) {
      console.error('[Map] Failed to create layer groups');
      return;
    }

    // Check if base layer has actual country content (not just empty group)
    const countryCount = this.baseLayerGroup.node()!.querySelectorAll('.country').length;
    const shouldRenderBase = !this.baseRendered || countryCount === 0 || width !== this.baseWidth || height !== this.baseHeight;

    // Debug: log when base layer needs re-render
    if (shouldRenderBase && countryCount === 0 && this.baseRendered) {
      console.warn('[Map] Base layer missing countries, forcing re-render. countryFeatures:', this.countryFeatures?.length ?? 'null');
    }

    if (shouldRenderBase) {
      this.baseWidth = width;
      this.baseHeight = height;
      // Use native DOM clear for guaranteed effect
      const baseNode = this.baseLayerGroup.node()!;
      while (baseNode.firstChild) baseNode.removeChild(baseNode.firstChild);

      // Background - extend well beyond viewBox to cover pan/zoom transforms
      // 3x size in each direction ensures no black bars when panning
      this.baseLayerGroup
        .append('rect')
        .attr('x', -width)
        .attr('y', -height)
        .attr('width', width * 3)
        .attr('height', height * 3)
        .attr('fill', getCSSColor('--map-bg'));

      // Grid
      this.renderGrid(this.baseLayerGroup, width, height);

      // Setup projection for base elements
      const baseProjection = this.getProjection(width, height);
      const basePath = d3.geoPath().projection(baseProjection);

      // Graticule
      this.renderGraticule(this.baseLayerGroup, basePath);

      // Countries
      this.renderCountries(this.baseLayerGroup, basePath);
      this.baseRendered = true;
    }

    // Always rebuild dynamic layer - use native DOM clear for reliability
    const dynamicNode = this.dynamicLayerGroup.node()!;
    while (dynamicNode.firstChild) dynamicNode.removeChild(dynamicNode.firstChild);
    // Create overlays-svg group for SVG-based overlays (military tracks, etc.)
    this.dynamicLayerGroup.append('g').attr('class', 'overlays-svg');

    // Setup projection for dynamic elements
    const projection = this.getProjection(width, height);

    // Update country fills (sanctions toggle without rebuilding geometry)
    this.updateCountryFills();

    // Render dynamic map layers
    if (this.state.layers.cables) {
      this.renderCables(projection);
    }

    if (this.state.layers.pipelines) {
      this.renderPipelines(projection);
    }

    if (this.state.layers.conflicts) {
      this.renderConflicts(projection);
    }

    if (this.state.layers.ais) {
      this.renderAisDensity(projection);
    }

    // GPU-accelerated cluster markers (LOD)
    this.renderClusterLayer(projection);

    // Overlays
    this.renderOverlays(projection);

    // POST-RENDER VERIFICATION: Ensure base layer actually rendered
    // This catches silent failures where d3 operations didn't stick
    if (this.baseRendered && this.countryFeatures && this.countryFeatures.length > 0) {
      const verifyCount = this.baseLayerGroup?.node()?.querySelectorAll('.country').length ?? 0;
      if (verifyCount === 0) {
        console.error('[Map] POST-RENDER: Countries failed to render despite baseRendered=true. Forcing full rebuild.');
        this.baseRendered = false;
        // Schedule a retry on next frame instead of immediate recursion
        requestAnimationFrame(() => this.render());
        return;
      }
    }

    this.applyTransform();
  }

  private renderGrid(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    width: number,
    height: number,
    yStart = 0
  ): void {
    const gridGroup = group.append('g').attr('class', 'grid');

    for (let x = 0; x < width; x += 20) {
      gridGroup
        .append('line')
        .attr('x1', x)
        .attr('y1', yStart)
        .attr('x2', x)
        .attr('y2', yStart + height)
        .attr('stroke', getCSSColor('--map-grid'))
        .attr('stroke-width', 0.5);
    }

    for (let y = yStart; y < yStart + height; y += 20) {
      gridGroup
        .append('line')
        .attr('x1', 0)
        .attr('y1', y)
        .attr('x2', width)
        .attr('y2', y)
        .attr('stroke', getCSSColor('--map-grid'))
        .attr('stroke-width', 0.5);
    }
  }

  private getProjection(width: number, height: number): d3.GeoProjection {
    // Equirectangular with cropped latitude range (72°N to 56°S = 128°)
    // Shows Greenland/Iceland while trimming extreme polar regions
    const LAT_NORTH = 72;  // Includes Greenland (extends to ~83°N but 72 shows most)
    const LAT_SOUTH = -56; // Just below Tierra del Fuego
    const LAT_RANGE = LAT_NORTH - LAT_SOUTH; // 128°
    const LAT_CENTER = (LAT_NORTH + LAT_SOUTH) / 2; // 8°N

    // Scale to fit: 360° longitude in width, 128° latitude in height
    const scaleForWidth = width / (2 * Math.PI);
    const scaleForHeight = height / (LAT_RANGE * Math.PI / 180);
    const scale = Math.min(scaleForWidth, scaleForHeight);

    return d3
      .geoEquirectangular()
      .scale(scale)
      .center([0, LAT_CENTER])
      .translate([width / 2, height / 2]);
  }

  private renderGraticule(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    path: d3.GeoPath
  ): void {
    const graticule = d3.geoGraticule();
    group
      .append('path')
      .datum(graticule())
      .attr('class', 'graticule')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', getCSSColor('--map-stroke'))
      .attr('stroke-width', 0.4);
  }

  private renderCountries(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    path: d3.GeoPath
  ): void {
    if (!this.countryFeatures) return;

    group
      .selectAll('.country')
      .data(this.countryFeatures)
      .enter()
      .append('path')
      .attr('class', 'country')
      .attr('d', path as unknown as string)
      .attr('fill', getCSSColor('--map-country'))
      .attr('stroke', getCSSColor('--map-stroke'))
      .attr('stroke-width', 0.7);
  }

  private renderCables(projection: d3.GeoProjection): void {
    if (!this.dynamicLayerGroup) return;
    const cableGroup = this.dynamicLayerGroup.append('g').attr('class', 'cables');

    UNDERSEA_CABLES.forEach((cable) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal);

      const isHighlighted = this.highlightedAssets.cable.has(cable.id);
      const cableAdvisory = this.getCableAdvisory(cable.id);
      const advisoryClass = cableAdvisory ? `cable-${cableAdvisory.severity}` : '';
      const healthRecord = this.healthByCableId[cable.id];
      const healthClass = healthRecord?.status === 'fault' ? 'cable-health-fault' : healthRecord?.status === 'degraded' ? 'cable-health-degraded' : '';
      const highlightClass = isHighlighted ? 'asset-highlight asset-highlight-cable' : '';

      const path = cableGroup
        .append('path')
        .attr('class', `cable-path ${advisoryClass} ${healthClass} ${highlightClass}`.trim())
        .attr('d', lineGenerator(cable.points));

      path.append('title').text(cable.name);

      path.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'cable',
          data: cable,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      });
    });
  }

  private renderPipelines(projection: d3.GeoProjection): void {
    if (!this.dynamicLayerGroup) return;
    const pipelineGroup = this.dynamicLayerGroup.append('g').attr('class', 'pipelines');

    PIPELINES.forEach((pipeline) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal.tension(0.5));

      const color = PIPELINE_COLORS[pipeline.type] || getCSSColor('--text-dim');
      const opacity = 0.85;
      const dashArray = pipeline.status === 'construction' ? '4,2' : 'none';

      const isHighlighted = this.highlightedAssets.pipeline.has(pipeline.id);
      const path = pipelineGroup
        .append('path')
        .attr('class', `pipeline-path pipeline-${pipeline.type} pipeline-${pipeline.status}${isHighlighted ? ' asset-highlight asset-highlight-pipeline' : ''}`)
        .attr('d', lineGenerator(pipeline.points))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2.5)
        .attr('stroke-opacity', opacity)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round');

      if (dashArray !== 'none') {
        path.attr('stroke-dasharray', dashArray);
      }

      path.append('title').text(`${pipeline.name} (${pipeline.type.toUpperCase()})`);

      path.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'pipeline',
          data: pipeline,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      });
    });
  }

  private renderConflicts(projection: d3.GeoProjection): void {
    if (!this.dynamicLayerGroup) return;
    const conflictGroup = this.dynamicLayerGroup.append('g').attr('class', 'conflicts');

    CONFLICT_ZONES.forEach((zone) => {
      const points = zone.coords
        .map((c) => projection(c as [number, number]))
        .filter((p): p is [number, number] => p !== null);

      if (points.length > 0) {
        conflictGroup
          .append('polygon')
          .attr('class', 'conflict-zone')
          .attr('points', points.map((p) => p.join(',')).join(' '));
        // Labels are now rendered as HTML overlays in renderConflictLabels()
      }
    });
  }


  private updateCountryFills(): void {
    if (!this.baseLayerGroup || !this.countryFeatures) return;

    const sanctionColors: Record<string, string> = {
      severe: 'rgba(255, 0, 0, 0.35)',
      high: 'rgba(255, 100, 0, 0.25)',
      moderate: 'rgba(255, 200, 0, 0.2)',
    };
    const defaultFill = getCSSColor('--map-country');
    const useSanctions = this.state.layers.sanctions;

    this.baseLayerGroup.selectAll('.country').each(function (datum) {
      const el = d3.select(this);
      const id = datum as { id?: number };
      if (!useSanctions) {
        el.attr('fill', defaultFill);
        return;
      }
      if (id?.id !== undefined && SANCTIONED_COUNTRIES[id.id]) {
        const level = SANCTIONED_COUNTRIES[id.id];
        if (level) {
          el.attr('fill', sanctionColors[level] || defaultFill);
          return;
        }
      }
      el.attr('fill', defaultFill);
    });
  }

  // Generic marker clustering - groups markers within pixelRadius into clusters
  // groupKey function ensures only items with same key can cluster (e.g., same city)
  private clusterMarkers<T extends { lat: number; lon: number }>(
    items: T[],
    projection: d3.GeoProjection,
    pixelRadius: number,
    getGroupKey?: (item: T) => string
  ): Array<{ items: T[]; center: [number, number]; pos: [number, number] }> {
    const clusters: Array<{ items: T[]; center: [number, number]; pos: [number, number] }> = [];
    const assigned = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;

      const item = items[i]!;
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      const pos = projection([item.lon, item.lat]);
      if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) continue;

      const cluster: T[] = [item];
      assigned.add(i);
      const itemKey = getGroupKey?.(item);

      // Find nearby items (must share same group key if provided)
      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(j)) continue;
        const other = items[j]!;

        // Skip if different group keys (e.g., different cities)
        if (getGroupKey && getGroupKey(other) !== itemKey) continue;

        if (!Number.isFinite(other.lat) || !Number.isFinite(other.lon)) continue;
        const otherPos = projection([other.lon, other.lat]);
        if (!otherPos || !Number.isFinite(otherPos[0]) || !Number.isFinite(otherPos[1])) continue;

        const dx = pos[0] - otherPos[0];
        const dy = pos[1] - otherPos[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= pixelRadius) {
          cluster.push(other);
          assigned.add(j);
        }
      }

      // Calculate cluster center
      let sumLat = 0, sumLon = 0;
      for (const c of cluster) {
        sumLat += c.lat;
        sumLon += c.lon;
      }
      const centerLat = sumLat / cluster.length;
      const centerLon = sumLon / cluster.length;
      const centerPos = projection([centerLon, centerLat]);
      const finalPos = (centerPos && Number.isFinite(centerPos[0]) && Number.isFinite(centerPos[1]))
        ? centerPos : pos;

      clusters.push({
        items: cluster,
        center: [centerLon, centerLat],
        pos: finalPos,
      });
    }

    return clusters;
  }

  private renderOverlays(projection: d3.GeoProjection): void {
    this.overlays.innerHTML = '';

    // Strategic waterways
    if (this.state.layers.waterways) {
      this.renderWaterways(projection);
    }

    if (this.state.layers.ais) {
      this.renderAisDisruptions(projection);
      this.renderPorts(projection);
    }

    // APT groups (geopolitical variant only)
    if (SITE_VARIANT !== 'tech') {
      this.renderAPTMarkers(projection);
    }

    // Nuclear facilities (always HTML - shapes convey status)
    if (this.state.layers.nuclear) {
      NUCLEAR_FACILITIES.forEach((facility) => {
        const pos = projection([facility.lon, facility.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        const isHighlighted = this.highlightedAssets.nuclear.has(facility.id);
        div.className = `nuclear-marker ${facility.status}${isHighlighted ? ' asset-highlight asset-highlight-nuclear' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${facility.name} (${facility.type})`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'nuclear',
            data: facility,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Gamma irradiators (IAEA DIIF) - no labels, click to see details
    if (this.state.layers.irradiators) {
      GAMMA_IRRADIATORS.forEach((irradiator) => {
        const pos = projection([irradiator.lon, irradiator.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = 'irradiator-marker';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${irradiator.city}, ${irradiator.country}`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'irradiator',
            data: irradiator,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Conflict zone click areas
    if (this.state.layers.conflicts) {
      CONFLICT_ZONES.forEach((zone) => {
        const centerPos = projection(zone.center as [number, number]);
        if (!centerPos) return;

        const clickArea = document.createElement('div');
        clickArea.className = 'conflict-click-area';
        clickArea.style.left = `${centerPos[0] - 40}px`;
        clickArea.style.top = `${centerPos[1] - 20}px`;
        clickArea.style.width = '80px';
        clickArea.style.height = '40px';
        clickArea.style.cursor = 'pointer';

        clickArea.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'conflict',
            data: zone,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(clickArea);
      });
    }

    // Hotspots (always HTML - level colors and BREAKING badges)
    if (this.state.layers.hotspots) {
      this.hotspots.forEach((spot) => {
        const pos = projection([spot.lon, spot.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = 'hotspot';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        div.innerHTML = `
          <div class="hotspot-marker ${escapeHtml(spot.level || 'low')}"></div>
        `;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const relatedNews = this.getRelatedNews(spot);
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'hotspot',
            data: spot,
            relatedNews,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          this.popup.loadHotspotGdeltContext(spot);
          this.onHotspotClick?.(spot);
        });

        this.overlays.appendChild(div);
      });
    }

    // Military bases (always HTML - nation colors matter)
    if (this.state.layers.bases) {
      MILITARY_BASES.forEach((base) => {
        const pos = projection([base.lon, base.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        const isHighlighted = this.highlightedAssets.base.has(base.id);
        div.className = `base-marker ${base.type}${isHighlighted ? ' asset-highlight asset-highlight-base' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const label = document.createElement('div');
        label.className = 'base-label';
        label.textContent = base.name;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'base',
            data: base,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Earthquakes (magnitude-based sizing) - part of NATURAL layer
    if (this.state.layers.natural) {
      console.log('[Map] Rendering earthquakes. Total:', this.earthquakes.length, 'Layer enabled:', this.state.layers.natural);
      const filteredQuakes = this.state.timeRange === 'all'
        ? this.earthquakes
        : this.earthquakes.filter((eq) => eq.occurredAt >= Date.now() - this.getTimeRangeMs());
      console.log('[Map] After time filter:', filteredQuakes.length, 'earthquakes. TimeRange:', this.state.timeRange);
      let rendered = 0;
      filteredQuakes.forEach((eq) => {
        const pos = projection([eq.location?.longitude ?? 0, eq.location?.latitude ?? 0]);
        if (!pos) {
          console.log('[Map] Earthquake position null for:', eq.place, eq.location?.longitude, eq.location?.latitude);
          return;
        }
        rendered++;

        const size = Math.max(8, eq.magnitude * 3);
        const div = document.createElement('div');
        div.className = 'earthquake-marker';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.width = `${size}px`;
        div.style.height = `${size}px`;
        div.title = `M${eq.magnitude.toFixed(1)} - ${eq.place}`;

        const label = document.createElement('div');
        label.className = 'earthquake-label';
        label.textContent = `M${eq.magnitude.toFixed(1)}`;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'earthquake',
            data: eq,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
      console.log('[Map] Actually rendered', rendered, 'earthquake markers');
    }

    // Economic Centers (always HTML - emoji icons for type distinction)
    if (this.state.layers.economic) {
      ECONOMIC_CENTERS.forEach((center) => {
        const pos = projection([center.lon, center.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `economic-marker ${center.type}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'economic-icon';
        icon.textContent = center.type === 'exchange' ? '📈' : center.type === 'central-bank' ? '🏛' : '💰';
        div.appendChild(icon);
        div.title = center.name;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'economic',
            data: center,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Weather Alerts (severity icons)
    if (this.state.layers.weather) {
      this.weatherAlerts.forEach((alert) => {
        if (!alert.centroid) return;
        const pos = projection(alert.centroid);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `weather-marker ${alert.severity.toLowerCase()}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.borderColor = getSeverityColor(alert.severity);

        const icon = document.createElement('div');
        icon.className = 'weather-icon';
        icon.textContent = '⚠';
        div.appendChild(icon);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'weather',
            data: alert,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Internet Outages (severity colors)
    if (this.state.layers.outages) {
      this.outages.forEach((outage) => {
        const pos = projection([outage.lon, outage.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `outage-marker ${outage.severity}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'outage-icon';
        icon.textContent = '📡';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'outage-label';
        label.textContent = outage.country;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'outage',
            data: outage,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Cable advisories & repair ships
    if (this.state.layers.cables) {
      this.cableAdvisories.forEach((advisory) => {
        const pos = projection([advisory.lon, advisory.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `cable-advisory-marker ${advisory.severity}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'cable-advisory-icon';
        icon.textContent = advisory.severity === 'fault' ? '⚡' : '⚠';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'cable-advisory-label';
        label.textContent = this.getCableName(advisory.cableId);
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'cable-advisory',
            data: advisory,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });

      this.repairShips.forEach((ship) => {
        const pos = projection([ship.lon, ship.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `repair-ship-marker ${ship.status}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'repair-ship-icon';
        icon.textContent = '🚢';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'repair-ship-label';
        label.textContent = ship.name;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'repair-ship',
            data: ship,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // AI Data Centers (always HTML - 🖥️ icons, filter to ≥10k GPUs)
    const MIN_GPU_COUNT = 10000;
    if (this.state.layers.datacenters) {
      AI_DATA_CENTERS.filter(dc => (dc.chipCount || 0) >= MIN_GPU_COUNT).forEach((dc) => {
        const pos = projection([dc.lon, dc.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        const isHighlighted = this.highlightedAssets.datacenter.has(dc.id);
        div.className = `datacenter-marker ${dc.status}${isHighlighted ? ' asset-highlight asset-highlight-datacenter' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'datacenter-icon';
        icon.textContent = '🖥️';
        div.appendChild(icon);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'datacenter',
            data: dc,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Spaceports (🚀 icon)
    if (this.state.layers.spaceports) {
      SPACEPORTS.forEach((port) => {
        const pos = projection([port.lon, port.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `spaceport-marker ${port.status}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'spaceport-icon';
        icon.textContent = '🚀';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'spaceport-label';
        label.textContent = port.name;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'spaceport',
            data: port,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Critical Minerals (💎 icon)
    if (this.state.layers.minerals) {
      CRITICAL_MINERALS.forEach((mine) => {
        const pos = projection([mine.lon, mine.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `mineral-marker ${mine.status}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'mineral-icon';
        // Select icon based on mineral type
        icon.textContent = mine.mineral === 'Lithium' ? '🔋' : mine.mineral === 'Rare Earths' ? '🧲' : '💎';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'mineral-label';
        label.textContent = `${mine.mineral} - ${mine.name}`;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'mineral',
            data: mine,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // === TECH VARIANT LAYERS ===

    // Startup Hubs (🚀 icon by tier)
    if (this.state.layers.startupHubs) {
      STARTUP_HUBS.forEach((hub) => {
        const pos = projection([hub.lon, hub.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `startup-hub-marker ${hub.tier}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'startup-hub-icon';
        icon.textContent = hub.tier === 'mega' ? '🦄' : hub.tier === 'major' ? '🚀' : '💡';
        div.appendChild(icon);

        if (this.state.zoom >= 2 || hub.tier === 'mega') {
          const label = document.createElement('div');
          label.className = 'startup-hub-label';
          label.textContent = hub.name;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'startupHub',
            data: hub,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Cloud Regions (☁️ icons by provider)
    if (this.state.layers.cloudRegions) {
      CLOUD_REGIONS.forEach((region) => {
        const pos = projection([region.lon, region.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `cloud-region-marker ${region.provider}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'cloud-region-icon';
        // Provider-specific icons
        const icons: Record<string, string> = { aws: '🟠', gcp: '🔵', azure: '🟣', cloudflare: '🟡' };
        icon.textContent = icons[region.provider] || '☁️';
        div.appendChild(icon);

        if (this.state.zoom >= 3) {
          const label = document.createElement('div');
          label.className = 'cloud-region-label';
          label.textContent = region.provider.toUpperCase();
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'cloudRegion',
            data: region,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Tech HQs (🏢 icons by company type) - with clustering by city
    if (this.state.layers.techHQs) {
      // Cluster radius depends on zoom - tighter clustering when zoomed out
      const clusterRadius = this.state.zoom >= 4 ? 15 : this.state.zoom >= 3 ? 25 : 40;
      // Group by city to prevent clustering companies from different cities
      const clusters = this.clusterMarkers(TECH_HQS, projection, clusterRadius, hq => hq.city);

      clusters.forEach((cluster) => {
        if (cluster.items.length === 0) return;
        const div = document.createElement('div');
        const isCluster = cluster.items.length > 1;
        const primaryItem = cluster.items[0]!; // Use first item for styling

        div.className = `tech-hq-marker ${primaryItem.type} ${isCluster ? 'cluster' : ''}`;
        div.style.left = `${cluster.pos[0]}px`;
        div.style.top = `${cluster.pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'tech-hq-icon';

        if (isCluster) {
          // Show count for clusters
          const unicornCount = cluster.items.filter(h => h.type === 'unicorn').length;
          const faangCount = cluster.items.filter(h => h.type === 'faang').length;
          icon.textContent = faangCount > 0 ? '🏛️' : unicornCount > 0 ? '🦄' : '🏢';

          const badge = document.createElement('div');
          badge.className = 'cluster-badge';
          badge.textContent = String(cluster.items.length);
          div.appendChild(badge);

          div.title = cluster.items.map(h => h.company).join(', ');
        } else {
          icon.textContent = primaryItem.type === 'faang' ? '🏛️' : primaryItem.type === 'unicorn' ? '🦄' : '🏢';
        }
        div.appendChild(icon);

        // Show label at higher zoom or for single FAANG markers
        if (!isCluster && (this.state.zoom >= 3 || primaryItem.type === 'faang')) {
          const label = document.createElement('div');
          label.className = 'tech-hq-label';
          label.textContent = primaryItem.company;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          if (isCluster) {
            // Show cluster popup with list of companies
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

        this.overlays.appendChild(div);
      });
    }

    // Accelerators (🎯 icons)
    if (this.state.layers.accelerators) {
      ACCELERATORS.forEach((acc) => {
        const pos = projection([acc.lon, acc.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `accelerator-marker ${acc.type}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'accelerator-icon';
        icon.textContent = acc.type === 'accelerator' ? '🎯' : acc.type === 'incubator' ? '🔬' : '🎨';
        div.appendChild(icon);

        if (this.state.zoom >= 3) {
          const label = document.createElement('div');
          label.className = 'accelerator-label';
          label.textContent = acc.name;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'accelerator',
            data: acc,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Tech Events / Conferences (📅 icons) - with clustering
    if (this.state.layers.techEvents && this.techEvents.length > 0) {
      const mapWidth = this.container.clientWidth;
      const mapHeight = this.container.clientHeight;

      // Map events to have lon property for clustering, filter visible
      const visibleEvents = this.techEvents
        .map(e => ({ ...e, lon: e.lng }))
        .filter(e => {
          const pos = projection([e.lon, e.lat]);
          return pos && pos[0] >= 0 && pos[0] <= mapWidth && pos[1] >= 0 && pos[1] <= mapHeight;
        });

      const clusterRadius = this.state.zoom >= 4 ? 15 : this.state.zoom >= 3 ? 25 : 40;
      // Group by location to prevent clustering events from different cities
      const clusters = this.clusterMarkers(visibleEvents, projection, clusterRadius, e => e.location);

      clusters.forEach((cluster) => {
        if (cluster.items.length === 0) return;
        const div = document.createElement('div');
        const isCluster = cluster.items.length > 1;
        const primaryEvent = cluster.items[0]!;
        const hasUpcomingSoon = cluster.items.some(e => e.daysUntil <= 14);

        div.className = `tech-event-marker ${hasUpcomingSoon ? 'upcoming-soon' : ''} ${isCluster ? 'cluster' : ''}`;
        div.style.left = `${cluster.pos[0]}px`;
        div.style.top = `${cluster.pos[1]}px`;

        if (isCluster) {
          const badge = document.createElement('div');
          badge.className = 'cluster-badge';
          badge.textContent = String(cluster.items.length);
          div.appendChild(badge);
          div.title = cluster.items.map(e => e.title).join(', ');
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          if (isCluster) {
            this.popup.show({
              type: 'techEventCluster',
              data: { items: cluster.items, location: primaryEvent.location, country: primaryEvent.country },
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

        this.overlays.appendChild(div);
      });
    }

    // Stock Exchanges (🏛️ icon by tier)
    if (this.state.layers.stockExchanges) {
      STOCK_EXCHANGES.forEach((exchange) => {
        const pos = projection([exchange.lon, exchange.lat]);
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;

        const icon = exchange.tier === 'mega' ? '🏛️' : exchange.tier === 'major' ? '📊' : '📈';
        const div = document.createElement('div');
        div.className = `map-marker exchange-marker tier-${exchange.tier}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.zIndex = exchange.tier === 'mega' ? '50' : '40';
        div.textContent = icon;
        div.title = `${exchange.shortName} (${exchange.city})`;

        if ((this.state.zoom >= 2 && exchange.tier === 'mega') || this.state.zoom >= 3) {
          const label = document.createElement('span');
          label.className = 'marker-label';
          label.textContent = exchange.shortName;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'stockExchange',
            data: exchange,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Financial Centers (💰 icon by type)
    if (this.state.layers.financialCenters) {
      FINANCIAL_CENTERS.forEach((center) => {
        const pos = projection([center.lon, center.lat]);
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;

        const icon = center.type === 'global' ? '💰' : center.type === 'regional' ? '🏦' : '🏝️';
        const div = document.createElement('div');
        div.className = `map-marker financial-center-marker type-${center.type}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.zIndex = center.type === 'global' ? '45' : '35';
        div.textContent = icon;
        div.title = `${center.name} Financial Center`;

        if ((this.state.zoom >= 2 && center.type === 'global') || this.state.zoom >= 3) {
          const label = document.createElement('span');
          label.className = 'marker-label';
          label.textContent = center.name;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'financialCenter',
            data: center,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Central Banks (🏛️ icon by type)
    if (this.state.layers.centralBanks) {
      CENTRAL_BANKS.forEach((bank) => {
        const pos = projection([bank.lon, bank.lat]);
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;

        const icon = bank.type === 'supranational' ? '🌐' : bank.type === 'major' ? '🏛️' : '🏦';
        const div = document.createElement('div');
        div.className = `map-marker central-bank-marker type-${bank.type}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.zIndex = bank.type === 'supranational' ? '48' : bank.type === 'major' ? '42' : '38';
        div.textContent = icon;
        div.title = `${bank.shortName} - ${bank.name}`;

        if ((this.state.zoom >= 2 && (bank.type === 'major' || bank.type === 'supranational')) || this.state.zoom >= 3) {
          const label = document.createElement('span');
          label.className = 'marker-label';
          label.textContent = bank.shortName;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'centralBank',
            data: bank,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Commodity Hubs (⛽ icon by type)
    if (this.state.layers.commodityHubs) {
      COMMODITY_HUBS.forEach((hub) => {
        const pos = projection([hub.lon, hub.lat]);
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;

        const icon = hub.type === 'exchange' ? '📦' : hub.type === 'port' ? '🚢' : '⛽';
        const div = document.createElement('div');
        div.className = `map-marker commodity-hub-marker type-${hub.type}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.zIndex = '38';
        div.textContent = icon;
        div.title = `${hub.name} (${hub.city})`;

        if (this.state.zoom >= 3) {
          const label = document.createElement('span');
          label.className = 'marker-label';
          label.textContent = hub.name;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'commodityHub',
            data: hub,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Tech Hub Activity Markers (shows activity heatmap for tech hubs with news activity)
    if (SITE_VARIANT === 'tech' && this.techActivities.length > 0) {
      this.techActivities.forEach((activity) => {
        const pos = projection([activity.lon, activity.lat]);
        if (!pos) return;

        // Only show markers for hubs with actual activity
        if (activity.newsCount === 0) return;

        const div = document.createElement('div');
        div.className = `tech-activity-marker ${activity.activityLevel}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.zIndex = activity.activityLevel === 'high' ? '60' : activity.activityLevel === 'elevated' ? '50' : '40';
        div.title = `${activity.city}: ${activity.newsCount} stories`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onTechHubClick?.(activity);
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'techActivity',
            data: activity,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);

        // Add label for high/elevated activity hubs at sufficient zoom
        if ((activity.activityLevel === 'high' || (activity.activityLevel === 'elevated' && this.state.zoom >= 2)) && this.state.zoom >= 1.5) {
          const label = document.createElement('div');
          label.className = 'tech-activity-label';
          label.textContent = activity.city;
          label.style.left = `${pos[0]}px`;
          label.style.top = `${pos[1] + 14}px`;
          this.overlays.appendChild(label);
        }
      });
    }

    // Geo Hub Activity Markers (shows activity heatmap for geopolitical hubs - full variant)
    if (SITE_VARIANT === 'full' && this.geoActivities.length > 0) {
      this.geoActivities.forEach((activity) => {
        const pos = projection([activity.lon, activity.lat]);
        if (!pos) return;

        // Only show markers for hubs with actual activity
        if (activity.newsCount === 0) return;

        const div = document.createElement('div');
        div.className = `geo-activity-marker ${activity.activityLevel}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.zIndex = activity.activityLevel === 'high' ? '60' : activity.activityLevel === 'elevated' ? '50' : '40';
        div.title = `${activity.name}: ${activity.newsCount} stories`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onGeoHubClick?.(activity);
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'geoActivity',
            data: activity,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Protests / Social Unrest Events (severity colors + icons) - with clustering
    // Filter to show only significant events on map (all events still used for CII analysis)
    if (this.state.layers.protests) {
      const significantProtests = this.protests.filter((event) => {
        // Only show riots and high severity (red markers)
        // All protests still counted in CII analysis
        return event.eventType === 'riot' || event.severity === 'high';
      });

      const clusterRadius = this.state.zoom >= 4 ? 12 : this.state.zoom >= 3 ? 20 : 35;
      const clusters = this.clusterMarkers(significantProtests, projection, clusterRadius, p => p.country);

      clusters.forEach((cluster) => {
        if (cluster.items.length === 0) return;
        const div = document.createElement('div');
        const isCluster = cluster.items.length > 1;
        const primaryEvent = cluster.items[0]!;
        const hasRiot = cluster.items.some(e => e.eventType === 'riot');
        const hasHighSeverity = cluster.items.some(e => e.severity === 'high');

        div.className = `protest-marker ${hasHighSeverity ? 'high' : primaryEvent.severity} ${hasRiot ? 'riot' : primaryEvent.eventType} ${isCluster ? 'cluster' : ''}`;
        div.style.left = `${cluster.pos[0]}px`;
        div.style.top = `${cluster.pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'protest-icon';
        icon.textContent = hasRiot ? '🔥' : primaryEvent.eventType === 'strike' ? '✊' : '📢';
        div.appendChild(icon);

        if (isCluster) {
          const badge = document.createElement('div');
          badge.className = 'cluster-badge';
          badge.textContent = String(cluster.items.length);
          div.appendChild(badge);
          div.title = `${primaryEvent.country}: ${cluster.items.length} ${t('popups.events')}`;
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

        this.overlays.appendChild(div);
      });
    }

    // Flight Delays (delay severity colors + ✈️ icons)
    if (this.state.layers.flights) {
      this.flightDelays.forEach((delay) => {
        const pos = projection([delay.lon, delay.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `flight-delay-marker ${delay.severity}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'flight-delay-icon';
        icon.textContent = delay.delayType === 'ground_stop' ? '🛑' : delay.severity === 'severe' ? '✈️' : '🛫';
        div.appendChild(icon);

        if (this.state.zoom >= 3) {
          const label = document.createElement('div');
          label.className = 'flight-delay-label';
          label.textContent = `${delay.iata} ${delay.avgDelayMinutes > 0 ? `+${delay.avgDelayMinutes}m` : ''}`;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'flight',
            data: delay,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Military Tracking (flights and vessels)
    if (this.state.layers.military) {
      // Render individual flights
      this.militaryFlights.forEach((flight) => {
        const pos = projection([flight.lon, flight.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `military-flight-marker ${flight.operator} ${flight.aircraftType}${flight.isInteresting ? ' interesting' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        // Crosshair icon - rotates with heading
        const icon = document.createElement('div');
        icon.className = `military-flight-icon ${flight.aircraftType}`;
        icon.style.transform = `rotate(${flight.heading}deg)`;
        // CSS handles the crosshair rendering
        div.appendChild(icon);

        // Show callsign at higher zoom levels
        if (this.state.zoom >= 3) {
          const label = document.createElement('div');
          label.className = 'military-flight-label';
          label.textContent = flight.callsign;
          div.appendChild(label);
        }

        // Show altitude indicator
        if (flight.altitude > 0) {
          const alt = document.createElement('div');
          alt.className = 'military-flight-altitude';
          alt.textContent = `FL${Math.round(flight.altitude / 100)}`;
          div.appendChild(alt);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'militaryFlight',
            data: flight,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);

        // Render flight track if available
        if (flight.track && flight.track.length > 1 && this.state.zoom >= 2) {
          const trackLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          const points = flight.track
            .map((p) => {
              const pt = projection([p[1], p[0]]);
              return pt ? `${pt[0]},${pt[1]}` : null;
            })
            .filter(Boolean)
            .join(' ');

          if (points) {
            trackLine.setAttribute('points', points);
            trackLine.setAttribute('class', `military-flight-track ${flight.operator}`);
            trackLine.setAttribute('fill', 'none');
            trackLine.setAttribute('stroke-width', '1.5');
            trackLine.setAttribute('stroke-dasharray', '4,2');
            this.dynamicLayerGroup?.select('.overlays-svg').append(() => trackLine);
          }
        }
      });

      // Render flight clusters
      this.militaryFlightClusters.forEach((cluster) => {
        const pos = projection([cluster.lon, cluster.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `military-cluster-marker flight-cluster ${cluster.activityType || 'unknown'}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const count = document.createElement('div');
        count.className = 'cluster-count';
        count.textContent = String(cluster.flightCount);
        div.appendChild(count);

        const label = document.createElement('div');
        label.className = 'cluster-label';
        label.textContent = cluster.name;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'militaryFlightCluster',
            data: cluster,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });

      // Military Vessels (warships, carriers, submarines)
      // Render individual vessels
      this.militaryVessels.forEach((vessel) => {
        const pos = projection([vessel.lon, vessel.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `military-vessel-marker ${vessel.operator} ${vessel.vesselType}${vessel.isDark ? ' dark-vessel' : ''}${vessel.isInteresting ? ' interesting' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = `military-vessel-icon ${vessel.vesselType}`;
        icon.style.transform = `rotate(${vessel.heading}deg)`;
        // CSS handles the diamond/anchor rendering
        div.appendChild(icon);

        // Dark vessel warning indicator
        if (vessel.isDark) {
          const darkIndicator = document.createElement('div');
          darkIndicator.className = 'dark-vessel-indicator';
          darkIndicator.textContent = '⚠️';
          darkIndicator.title = 'AIS Signal Lost';
          div.appendChild(darkIndicator);
        }

        // Show vessel name at higher zoom
        if (this.state.zoom >= 3) {
          const label = document.createElement('div');
          label.className = 'military-vessel-label';
          label.textContent = vessel.name;
          div.appendChild(label);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'militaryVessel',
            data: vessel,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);

        // Render vessel track if available
        if (vessel.track && vessel.track.length > 1 && this.state.zoom >= 2) {
          const trackLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          const points = vessel.track
            .map((p) => {
              const pt = projection([p[1], p[0]]);
              return pt ? `${pt[0]},${pt[1]}` : null;
            })
            .filter(Boolean)
            .join(' ');

          if (points) {
            trackLine.setAttribute('points', points);
            trackLine.setAttribute('class', `military-vessel-track ${vessel.operator}`);
            trackLine.setAttribute('fill', 'none');
            trackLine.setAttribute('stroke-width', '2');
            this.dynamicLayerGroup?.select('.overlays-svg').append(() => trackLine);
          }
        }
      });

      // Render vessel clusters
      this.militaryVesselClusters.forEach((cluster) => {
        const pos = projection([cluster.lon, cluster.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `military-cluster-marker vessel-cluster ${cluster.activityType || 'unknown'}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const count = document.createElement('div');
        count.className = 'cluster-count';
        count.textContent = String(cluster.vesselCount);
        div.appendChild(count);

        const label = document.createElement('div');
        label.className = 'cluster-label';
        label.textContent = cluster.name;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'militaryVesselCluster',
            data: cluster,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Natural Events (NASA EONET) - part of NATURAL layer
    if (this.state.layers.natural) {
      this.naturalEvents.forEach((event) => {
        const pos = projection([event.lon, event.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `nat-event-marker ${event.category}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'nat-event-icon';
        icon.textContent = getNaturalEventIcon(event.category);
        div.appendChild(icon);

        if (this.state.zoom >= 2) {
          const label = document.createElement('div');
          label.className = 'nat-event-label';
          label.textContent = event.title.length > 25 ? event.title.slice(0, 25) + '…' : event.title;
          div.appendChild(label);
        }

        if (event.magnitude) {
          const mag = document.createElement('div');
          mag.className = 'nat-event-magnitude';
          mag.textContent = `${event.magnitude}${event.magnitudeUnit ? ` ${event.magnitudeUnit}` : ''}`;
          div.appendChild(mag);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'natEvent',
            data: event,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }

    // Satellite Fires (NASA FIRMS) - separate fires layer
    if (this.state.layers.fires) {
      this.firmsFireData.forEach((fire) => {
        const pos = projection([fire.lon, fire.lat]);
        if (!pos) return;

        const color = fire.brightness > 400 ? getCSSColor('--semantic-critical') : fire.brightness > 350 ? getCSSColor('--semantic-high') : getCSSColor('--semantic-elevated');
        const size = Math.max(4, Math.min(10, (fire.frp || 1) * 0.5));

        const dot = document.createElement('div');
        dot.className = 'fire-dot';
        dot.style.left = `${pos[0]}px`;
        dot.style.top = `${pos[1]}px`;
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
        dot.style.backgroundColor = color;
        dot.title = `${fire.region} — ${Math.round(fire.brightness)}K, ${fire.frp}MW`;

        this.overlays.appendChild(dot);
      });
    }
  }

  private renderWaterways(projection: d3.GeoProjection): void {
    STRATEGIC_WATERWAYS.forEach((waterway) => {
      const pos = projection([waterway.lon, waterway.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = 'waterway-marker';
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;
      div.title = waterway.name;

      const diamond = document.createElement('div');
      diamond.className = 'waterway-diamond';
      div.appendChild(diamond);

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'waterway',
          data: waterway,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });

      this.overlays.appendChild(div);
    });
  }

  private renderAisDisruptions(projection: d3.GeoProjection): void {
    this.aisDisruptions.forEach((event) => {
      const pos = projection([event.lon, event.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = `ais-disruption-marker ${event.severity} ${event.type}`;
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;

      const icon = document.createElement('div');
      icon.className = 'ais-disruption-icon';
      icon.textContent = event.type === 'gap_spike' ? '🛰️' : '🚢';
      div.appendChild(icon);

      const label = document.createElement('div');
      label.className = 'ais-disruption-label';
      label.textContent = event.name;
      div.appendChild(label);

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'ais',
          data: event,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });

      this.overlays.appendChild(div);
    });
  }

  private renderAisDensity(projection: d3.GeoProjection): void {
    if (!this.dynamicLayerGroup) return;
    const densityGroup = this.dynamicLayerGroup.append('g').attr('class', 'ais-density');

    this.aisDensity.forEach((zone) => {
      const pos = projection([zone.lon, zone.lat]);
      if (!pos) return;

      const intensity = Math.min(Math.max(zone.intensity, 0.15), 1);
      const radius = 4 + intensity * 8;  // Small dots (4-12px)
      const isCongested = zone.deltaPct >= 15;
      const color = isCongested ? getCSSColor('--semantic-elevated') : getCSSColor('--semantic-info');
      const fillOpacity = 0.15 + intensity * 0.25;  // More visible individual dots

      densityGroup
        .append('circle')
        .attr('class', 'ais-density-spot')
        .attr('cx', pos[0])
        .attr('cy', pos[1])
        .attr('r', radius)
        .attr('fill', color)
        .attr('fill-opacity', fillOpacity)
        .attr('stroke', 'none');
    });
  }

  private renderPorts(projection: d3.GeoProjection): void {
    PORTS.forEach((port) => {
      const pos = projection([port.lon, port.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = `port-marker port-${port.type}`;
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;

      const icon = document.createElement('div');
      icon.className = 'port-icon';
      icon.textContent = port.type === 'naval' ? '⚓' : port.type === 'oil' || port.type === 'lng' ? '🛢️' : '🏭';
      div.appendChild(icon);

      const label = document.createElement('div');
      label.className = 'port-label';
      label.textContent = port.name;
      div.appendChild(label);

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'port',
          data: port,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });

      this.overlays.appendChild(div);
    });
  }

  private renderAPTMarkers(projection: d3.GeoProjection): void {
    APT_GROUPS.forEach((apt) => {
      const pos = projection([apt.lon, apt.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = 'apt-marker';
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;
      div.innerHTML = `
        <div class="apt-icon">⚠</div>
        <div class="apt-label">${escapeHtml(apt.name)}</div>
      `;

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'apt',
          data: apt,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });

      this.overlays.appendChild(div);
    });
  }

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

  public updateHotspotActivity(news: NewsItem[]): void {
    this.news = news; // Store for related news lookup

    this.hotspots.forEach((spot) => {
      let score = 0;
      let hasBreaking = false;
      let matchedCount = 0;

      news.forEach((item) => {
        const titleLower = item.title.toLowerCase();
        const matches = spot.keywords.filter((kw) => titleLower.includes(kw.toLowerCase()));

        if (matches.length > 0) {
          matchedCount++;
          // Base score per match
          score += matches.length * 2;

          // Breaking news is critical
          if (item.isAlert) {
            score += 5;
            hasBreaking = true;
          }

          // Recent news (last 6 hours) weighted higher
          if (item.pubDate) {
            const hoursAgo = (Date.now() - item.pubDate.getTime()) / (1000 * 60 * 60);
            if (hoursAgo < 1) score += 3; // Last hour
            else if (hoursAgo < 6) score += 2; // Last 6 hours
            else if (hoursAgo < 24) score += 1; // Last day
          }
        }
      });

      spot.hasBreaking = hasBreaking;

      // Dynamic level calculation - sensitive to real activity
      // HIGH: Breaking news OR 4+ matching articles OR score >= 10
      // ELEVATED: 2+ matching articles OR score >= 4
      // LOW: Default when no significant activity
      if (hasBreaking || matchedCount >= 4 || score >= 10) {
        spot.level = 'high';
        spot.status = hasBreaking ? 'BREAKING NEWS' : 'High activity';
      } else if (matchedCount >= 2 || score >= 4) {
        spot.level = 'elevated';
        spot.status = 'Elevated activity';
      } else if (matchedCount >= 1) {
        spot.level = 'low';
        spot.status = 'Recent mentions';
      } else {
        spot.level = 'low';
        spot.status = 'Monitoring';
      }

      // Update dynamic escalation score
      const velocity = matchedCount > 0 ? score / matchedCount : 0;
      updateHotspotEscalation(spot.id, matchedCount, hasBreaking, velocity);
    });

    this.render();
  }

  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;

    const projection = this.getProjection(width, height);
    const pos = projection([lon, lat]);
    if (!pos) return;

    const flash = document.createElement('div');
    flash.className = 'map-flash';
    flash.style.left = `${pos[0]}px`;
    flash.style.top = `${pos[1]}px`;
    flash.style.setProperty('--flash-duration', `${durationMs}ms`);
    this.overlays.appendChild(flash);

    window.setTimeout(() => {
      flash.remove();
    }, durationMs);
  }

  public initEscalationGetters(): void {
    setCIIGetter(getCountryScore);
    setGeoAlertGetter(getAlertsNearLocation);
  }

  public updateMilitaryForEscalation(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
    setMilitaryData(flights, vessels);
  }

  public getHotspotDynamicScore(hotspotId: string) {
    return getHotspotEscalation(hotspotId);
  }

  public setView(view: MapView): void {
    this.state.view = view;

    // Region-specific zoom and pan settings
    // Pan: +x = west, -x = east, +y = north, -y = south
    const viewSettings: Record<MapView, { zoom: number; pan: { x: number; y: number } }> = {
      global: { zoom: 1, pan: { x: 0, y: 0 } },
      america: { zoom: 1.8, pan: { x: 180, y: 30 } },
      mena: { zoom: 3.5, pan: { x: -100, y: 50 } },
      eu: { zoom: 2.4, pan: { x: -30, y: 100 } },
      asia: { zoom: 2.0, pan: { x: -320, y: 40 } },
      latam: { zoom: 2.0, pan: { x: 120, y: -100 } },
      africa: { zoom: 2.2, pan: { x: -40, y: -30 } },
      oceania: { zoom: 2.2, pan: { x: -420, y: -100 } },
    };

    const settings = viewSettings[view];
    this.state.zoom = settings.zoom;
    this.state.pan = settings.pan;
    this.applyTransform();
    this.render();
  }

  private static readonly ASYNC_DATA_LAYERS: Set<keyof MapLayers> = new Set([
    'natural', 'weather', 'outages', 'ais', 'protests', 'flights', 'military', 'techEvents',
  ]);

  public toggleLayer(layer: keyof MapLayers, source: 'user' | 'programmatic' = 'user'): void {
    console.log(`[Map.toggleLayer] ${layer}: ${this.state.layers[layer]} -> ${!this.state.layers[layer]}`);
    this.state.layers[layer] = !this.state.layers[layer];
    if (this.state.layers[layer]) {
      const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
      if (thresholds && this.state.zoom < thresholds.minZoom) {
        this.layerZoomOverrides[layer] = true;
      } else {
        delete this.layerZoomOverrides[layer];
      }
    } else {
      delete this.layerZoomOverrides[layer];
    }

    const btn = this.container.querySelector(`[data-layer="${layer}"]`);
    const isEnabled = this.state.layers[layer];
    const isAsyncLayer = MapComponent.ASYNC_DATA_LAYERS.has(layer);

    if (isEnabled && isAsyncLayer) {
      // Async layers: start in loading state, will be set to active when data arrives
      btn?.classList.remove('active');
      btn?.classList.add('loading');
    } else {
      // Static layers or disabling: toggle active immediately
      btn?.classList.toggle('active', isEnabled);
      btn?.classList.remove('loading');
    }

    this.onLayerChange?.(layer, this.state.layers[layer], source);
    // Defer render to next frame to avoid blocking the click handler
    requestAnimationFrame(() => this.render());
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChange = callback;
  }

  public hideLayerToggle(layer: keyof MapLayers): void {
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (btn) {
      (btn as HTMLElement).style.display = 'none';
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (btn) {
      btn.classList.toggle('loading', loading);
    }
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (!btn) return;

    btn.classList.remove('loading');
    if (this.state.layers[layer] && hasData) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }

  public onStateChanged(callback: (state: MapState) => void): void {
    this.onStateChange = callback;
  }

  public zoomIn(): void {
    this.state.zoom = Math.min(this.state.zoom + 0.5, 10);
    this.applyTransform();
  }

  public zoomOut(): void {
    this.state.zoom = Math.max(this.state.zoom - 0.5, 1);
    this.applyTransform();
  }

  public reset(): void {
    this.state.zoom = 1;
    this.state.pan = { x: 0, y: 0 };
    if (this.state.view !== 'global') {
      this.state.view = 'global';
      this.render();
    } else {
      this.applyTransform();
    }
  }

  public triggerHotspotClick(id: string): void {
    const hotspot = this.hotspots.find(h => h.id === id);
    if (!hotspot) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([hotspot.lon, hotspot.lat]);
    if (!pos) return;

    const relatedNews = this.getRelatedNews(hotspot);
    this.popup.show({
      type: 'hotspot',
      data: hotspot,
      relatedNews,
      x: pos[0],
      y: pos[1],
    });
    this.popup.loadHotspotGdeltContext(hotspot);
    this.onHotspotClick?.(hotspot);
  }

  public triggerConflictClick(id: string): void {
    const conflict = CONFLICT_ZONES.find(c => c.id === id);
    if (!conflict) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection(conflict.center as [number, number]);
    if (!pos) return;

    this.popup.show({
      type: 'conflict',
      data: conflict,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerBaseClick(id: string): void {
    const base = MILITARY_BASES.find(b => b.id === id);
    if (!base) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([base.lon, base.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'base',
      data: base,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerPipelineClick(id: string): void {
    const pipeline = PIPELINES.find(p => p.id === id);
    if (!pipeline || pipeline.points.length === 0) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const midPoint = pipeline.points[Math.floor(pipeline.points.length / 2)] as [number, number];
    const pos = projection(midPoint);
    if (!pos) return;

    this.popup.show({
      type: 'pipeline',
      data: pipeline,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerCableClick(id: string): void {
    const cable = UNDERSEA_CABLES.find(c => c.id === id);
    if (!cable || cable.points.length === 0) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const midPoint = cable.points[Math.floor(cable.points.length / 2)] as [number, number];
    const pos = projection(midPoint);
    if (!pos) return;

    this.popup.show({
      type: 'cable',
      data: cable,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerDatacenterClick(id: string): void {
    const dc = AI_DATA_CENTERS.find(d => d.id === id);
    if (!dc) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([dc.lon, dc.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'datacenter',
      data: dc,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerNuclearClick(id: string): void {
    const facility = NUCLEAR_FACILITIES.find(n => n.id === id);
    if (!facility) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([facility.lon, facility.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'nuclear',
      data: facility,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerIrradiatorClick(id: string): void {
    const irradiator = GAMMA_IRRADIATORS.find(i => i.id === id);
    if (!irradiator) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([irradiator.lon, irradiator.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'irradiator',
      data: irradiator,
      x: pos[0],
      y: pos[1],
    });
  }

  public enableLayer(layer: keyof MapLayers): void {
    if (!this.state.layers[layer]) {
      this.state.layers[layer] = true;
      const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
      if (thresholds && this.state.zoom < thresholds.minZoom) {
        this.layerZoomOverrides[layer] = true;
      } else {
        delete this.layerZoomOverrides[layer];
      }
      const btn = document.querySelector(`[data-layer="${layer}"]`);
      btn?.classList.add('active');
      this.onLayerChange?.(layer, true, 'programmatic');
      this.render();
    }
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    (Object.keys(this.highlightedAssets) as AssetType[]).forEach((type) => {
      this.highlightedAssets[type].clear();
    });

    if (assets) {
      assets.forEach((asset) => {
        this.highlightedAssets[asset.type].add(asset.id);
      });
    }

    this.render();
  }

  private clampPan(): void {
    const zoom = this.state.zoom;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    // Allow generous panning - maps should be explorable
    // Scale limits with zoom to allow reaching edges at higher zoom
    const maxPanX = (width / 2) * Math.max(1, zoom * 0.8);
    const maxPanY = (height / 2) * Math.max(1, zoom * 0.8);

    this.state.pan.x = Math.max(-maxPanX, Math.min(maxPanX, this.state.pan.x));
    this.state.pan.y = Math.max(-maxPanY, Math.min(maxPanY, this.state.pan.y));
  }

  private applyTransform(): void {
    this.clampPan();
    const zoom = this.state.zoom;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    // With transform-origin: 0 0, we need to offset to keep center in view
    // Formula: translate first to re-center, then scale
    const centerOffsetX = (width / 2) * (1 - zoom);
    const centerOffsetY = (height / 2) * (1 - zoom);
    const tx = centerOffsetX + this.state.pan.x * zoom;
    const ty = centerOffsetY + this.state.pan.y * zoom;

    this.wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;

    // Set CSS variable for counter-scaling labels/markers
    // Labels: max 1.5x scale, so counter-scale = min(1.5, zoom) / zoom
    // Markers: fixed size, so counter-scale = 1 / zoom
    const labelScale = Math.min(1.5, zoom) / zoom;
    const markerScale = 1 / zoom;
    this.wrapper.style.setProperty('--label-scale', String(labelScale));
    this.wrapper.style.setProperty('--marker-scale', String(markerScale));
    this.wrapper.style.setProperty('--zoom', String(zoom));

    // Smart label hiding based on zoom level and overlap
    this.updateLabelVisibility(zoom);
    this.updateZoomLayerVisibility();
    this.emitStateChange();
  }

  private updateZoomLayerVisibility(): void {
    const zoom = this.state.zoom;
    (Object.keys(MapComponent.LAYER_ZOOM_THRESHOLDS) as (keyof MapLayers)[]).forEach((layer) => {
      const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
      if (!thresholds) return;

      const enabled = this.state.layers[layer];
      const override = Boolean(this.layerZoomOverrides[layer]);
      const isVisible = enabled && (override || zoom >= thresholds.minZoom);
      const labelZoom = thresholds.showLabels ?? thresholds.minZoom;
      const labelsVisible = enabled && zoom >= labelZoom;
      const hiddenAttr = `data-layer-hidden-${layer}`;
      const labelsHiddenAttr = `data-labels-hidden-${layer}`;

      if (isVisible) {
        this.wrapper.removeAttribute(hiddenAttr);
      } else {
        this.wrapper.setAttribute(hiddenAttr, 'true');
      }

      if (labelsVisible) {
        this.wrapper.removeAttribute(labelsHiddenAttr);
      } else {
        this.wrapper.setAttribute(labelsHiddenAttr, 'true');
      }

      const btn = document.querySelector(`[data-layer="${layer}"]`);
      const autoHidden = enabled && !override && zoom < thresholds.minZoom;
      btn?.classList.toggle('auto-hidden', autoHidden);
    });
  }

  private emitStateChange(): void {
    this.onStateChange?.(this.getState());
  }

  private updateLabelVisibility(zoom: number): void {
    const labels = this.overlays.querySelectorAll('.hotspot-label, .earthquake-label, .weather-label, .apt-label');
    const labelRects: { el: Element; rect: DOMRect; priority: number }[] = [];

    // Collect all label bounds with priority
    labels.forEach((label) => {
      const el = label as HTMLElement;
      const parent = el.closest('.hotspot, .earthquake-marker, .weather-marker, .apt-marker');

      // Assign priority based on parent type and level
      let priority = 1;
      if (parent?.classList.contains('hotspot')) {
        const marker = parent.querySelector('.hotspot-marker');
        if (marker?.classList.contains('high')) priority = 5;
        else if (marker?.classList.contains('elevated')) priority = 3;
        else priority = 2;
      } else if (parent?.classList.contains('earthquake-marker')) {
        priority = 4; // Earthquakes are important
      } else if (parent?.classList.contains('weather-marker')) {
        if (parent.classList.contains('extreme')) priority = 5;
        else if (parent.classList.contains('severe')) priority = 4;
        else priority = 2;
      }

      // Reset visibility first
      el.style.opacity = '1';

      // Get bounding rect (accounting for transforms)
      const rect = el.getBoundingClientRect();
      labelRects.push({ el, rect, priority });
    });

    // Sort by priority (highest first)
    labelRects.sort((a, b) => b.priority - a.priority);

    // Hide overlapping labels (keep higher priority visible)
    const visibleRects: DOMRect[] = [];
    const minDistance = 30 / zoom; // Minimum pixel distance between labels

    labelRects.forEach(({ el, rect, priority }) => {
      const overlaps = visibleRects.some((vr) => {
        const dx = Math.abs((rect.left + rect.width / 2) - (vr.left + vr.width / 2));
        const dy = Math.abs((rect.top + rect.height / 2) - (vr.top + vr.height / 2));
        return dx < (rect.width + vr.width) / 2 + minDistance &&
               dy < (rect.height + vr.height) / 2 + minDistance;
      });

      if (overlaps && zoom < 2) {
        // Hide overlapping labels when zoomed out, but keep high priority visible
        (el as HTMLElement).style.opacity = priority >= 4 ? '0.7' : '0';
      } else {
        visibleRects.push(rect);
      }
    });
  }

  public onHotspotClicked(callback: (hotspot: Hotspot) => void): void {
    this.onHotspotClick = callback;
  }

  public onTimeRangeChanged(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public getState(): MapState {
    return { ...this.state };
  }

  public getCenter(): { lat: number; lon: number } | null {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    if (!projection.invert) return null;
    const zoom = this.state.zoom;
    const centerX = width / (2 * zoom) - this.state.pan.x;
    const centerY = height / (2 * zoom) - this.state.pan.y;
    const coords = projection.invert([centerX, centerY]);
    if (!coords) return null;
    return { lon: coords[0], lat: coords[1] };
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setZoom(zoom: number): void {
    this.state.zoom = Math.max(1, Math.min(10, zoom));
    this.applyTransform();
    // Ensure base layer is intact after zoom change
    this.ensureBaseLayerIntact();
  }

  private ensureBaseLayerIntact(): void {
    // Query DOM directly instead of relying on cached d3 selection
    const svgNode = this.svg.node();
    const domBaseGroup = svgNode?.querySelector('.map-base');
    const selectionNode = this.baseLayerGroup?.node();

    // Check for stale selection (d3 reference doesn't match DOM)
    if (domBaseGroup && selectionNode !== domBaseGroup) {
      console.warn('[Map] Stale base layer selection detected, forcing full rebuild');
      this.baseRendered = false;
      this.render();
      return;
    }

    // Check for missing countries
    const countryCount = domBaseGroup?.querySelectorAll('.country').length ?? 0;
    if (countryCount === 0 && this.countryFeatures && this.countryFeatures.length > 0) {
      console.warn('[Map] Base layer missing countries, triggering recovery render');
      this.baseRendered = false;
      this.render();
    }
  }

  public setCenter(lat: number, lon: number): void {
    console.log('[Map] setCenter called:', { lat, lon });
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([lon, lat]);
    console.log('[Map] projected pos:', pos, 'container:', { width, height }, 'zoom:', this.state.zoom);
    if (!pos) return;
    // Pan formula: after applyTransform() computes tx = centerOffset + pan*zoom,
    // and transform is translate(tx,ty) scale(zoom), to center on pos:
    // pos*zoom + tx = width/2 → tx = width/2 - pos*zoom
    // Solving: (width/2)(1-zoom) + pan*zoom = width/2 - pos*zoom
    // → pan = width/2 - pos (independent of zoom)
    this.state.pan = {
      x: width / 2 - pos[0],
      y: height / 2 - pos[1],
    };
    this.applyTransform();
    // Ensure base layer is intact after pan
    this.ensureBaseLayerIntact();
  }

  public setLayers(layers: MapLayers): void {
    this.state.layers = { ...layers };
    this.syncLayerButtons();
    this.render();
  }

  public setEarthquakes(earthquakes: Earthquake[]): void {
    console.log('[Map] setEarthquakes called with', earthquakes.length, 'earthquakes');
    if (earthquakes.length > 0 || this.earthquakes.length === 0) {
      this.earthquakes = earthquakes;
    } else {
      console.log('[Map] Keeping existing', this.earthquakes.length, 'earthquakes (new data was empty)');
    }
    this.render();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.render();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
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
    this.popup.setCableActivity(advisories, repairShips);
    this.render();
  }

  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    this.healthByCableId = healthMap;
    this.render();
  }

  public setProtests(events: SocialUnrestEvent[]): void {
    this.protests = events;
    this.render();
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
    this.render();
  }

  public setCyberThreats(_threats: CyberThreat[]): void {
    // SVG/mobile fallback intentionally does not render this layer to stay lightweight.
  }

  public setNewsLocations(_data: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }>): void {
    // SVG fallback: news locations rendered as simple circles
    // For now, skip on SVG map to keep mobile lightweight
  }

  public setTechActivity(activities: TechHubActivity[]): void {
    this.techActivities = activities;
    this.render();
  }

  public setOnTechHubClick(handler: (hub: TechHubActivity) => void): void {
    this.onTechHubClick = handler;
  }

  public setGeoActivity(activities: GeoHubActivity[]): void {
    this.geoActivities = activities;
    this.render();
  }

  public setOnGeoHubClick(handler: (hub: GeoHubActivity) => void): void {
    this.onGeoHubClick = handler;
  }

  private getCableAdvisory(cableId: string): CableAdvisory | undefined {
    const advisories = this.cableAdvisories.filter((advisory) => advisory.cableId === cableId);
    return advisories.reduce<CableAdvisory | undefined>((latest, advisory) => {
      if (!latest) return advisory;
      return advisory.reported.getTime() > latest.reported.getTime() ? advisory : latest;
    }, undefined);
  }

  private getCableName(cableId: string): string {
    return UNDERSEA_CABLES.find((cable) => cable.id === cableId)?.name || cableId;
  }

  public getHotspotLevels(): Record<string, string> {
    const levels: Record<string, string> = {};
    this.hotspots.forEach(spot => {
      levels[spot.name] = spot.level || 'low';
    });
    return levels;
  }

  public setHotspotLevels(levels: Record<string, string>): void {
    this.hotspots.forEach(spot => {
      if (levels[spot.name]) {
        spot.level = levels[spot.name] as 'high' | 'elevated' | 'low';
      }
    });
    this.render();
  }
}
