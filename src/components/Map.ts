import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { MapLayers, Hotspot, NewsItem, Earthquake, InternetOutage, RelatedAsset, AssetType, AisDisruptionEvent, AisDensityZone, CableAdvisory, RepairShip, SocialUnrestEvent, AirportDelayAlert } from '@/types';
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
  COUNTRY_LABELS,
  ECONOMIC_CENTERS,
  AI_DATA_CENTERS,
} from '@/config';
import { MapPopup } from './MapPopup';

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type MapView = 'global' | 'us' | 'mena';

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

interface WorldTopology extends Topology {
  objects: {
    countries: GeometryCollection;
  };
}

interface USTopology extends Topology {
  objects: {
    states: GeometryCollection;
  };
}

export class MapComponent {
  private static readonly LAYER_ZOOM_THRESHOLDS: Partial<
    Record<keyof MapLayers, { minZoom: number; showLabels?: number }>
  > = {
    bases: { minZoom: 3, showLabels: 5 },
    nuclear: { minZoom: 2, showLabels: 4 },
    conflicts: { minZoom: 1, showLabels: 3 },
    economic: { minZoom: 2, showLabels: 4 },
    earthquakes: { minZoom: 1, showLabels: 2 },
  };

  private container: HTMLElement;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private wrapper: HTMLElement;
  private overlays: HTMLElement;
  private clusterCanvas: HTMLCanvasElement;
  private clusterGl: WebGLRenderingContext | null = null;
  private state: MapState;
  private worldData: WorldTopology | null = null;
  private usData: USTopology | null = null;
  private hotspots: HotspotWithBreaking[];
  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private outages: InternetOutage[] = [];
  private aisDisruptions: AisDisruptionEvent[] = [];
  private aisDensity: AisDensityZone[] = [];
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private protests: SocialUnrestEvent[] = [];
  private flightDelays: AirportDelayAlert[] = [];
  private news: NewsItem[] = [];
  private popup: MapPopup;
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean) => void;
  private layerZoomOverrides: Partial<Record<keyof MapLayers, boolean>> = {};
  private onStateChange?: (state: MapState) => void;
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    base: new Set(),
    nuclear: new Set(),
  };

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
    container.appendChild(this.createTimestamp());

    this.svg = d3.select(svgElement);
    this.popup = new MapPopup(container);
    this.initClusterRenderer();

    this.setupZoomHandlers();
    this.loadMapData();
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

  private filterByTime<T extends { time?: Date }>(items: T[]): T[] {
    if (this.state.timeRange === 'all') return items;
    const now = Date.now();
    const cutoff = now - this.getTimeRangeMs();
    return items.filter((item) => {
      if (!item.time) return true;
      return item.time.getTime() >= cutoff;
    });
  }

  private createLayerToggles(): HTMLElement {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles';
    toggles.id = 'layerToggles';

    // Grouped: geopolitical | military | infrastructure | transport | natural | economic | labels
    const layers: (keyof MapLayers)[] = [
      'conflicts', 'hotspots', 'sanctions', 'protests',  // geopolitical
      'bases', 'nuclear', 'irradiators',                 // military/strategic
      'cables', 'pipelines', 'outages', 'datacenters',   // infrastructure
      'ais', 'flights',                                   // transport
      'earthquakes', 'weather',                           // natural
      'economic',                                         // economic
      'countries', 'waterways',                           // labels
    ];
    const layerLabels: Partial<Record<keyof MapLayers, string>> = {
      ais: 'Ships',
    };

    layers.forEach((layer) => {
      const btn = document.createElement('button');
      btn.className = `layer-toggle ${this.state.layers[layer] ? 'active' : ''}`;
      btn.dataset.layer = layer;
      btn.textContent = layerLabels[layer] || layer;
      btn.addEventListener('click', () => this.toggleLayer(layer));
      toggles.appendChild(btn);
    });

    return toggles;
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
    legend.innerHTML = `
      <div class="map-legend-item"><span class="legend-dot high"></span>HIGH ALERT</div>
      <div class="map-legend-item"><span class="legend-dot elevated"></span>ELEVATED</div>
      <div class="map-legend-item"><span class="legend-dot low"></span>MONITORING</div>
      <div class="map-legend-item"><span class="map-legend-icon conflict">⚔</span>CONFLICT</div>
      <div class="map-legend-item"><span class="map-legend-icon earthquake">●</span>EARTHQUAKE</div>
      <div class="map-legend-item"><span class="map-legend-icon apt">⚠</span>APT</div>
    `;
    return legend;
  }

  private createTimestamp(): HTMLElement {
    const timestamp = document.createElement('div');
    timestamp.className = 'map-timestamp';
    timestamp.id = 'mapTimestamp';
    this.updateTimestamp(timestamp);
    setInterval(() => this.updateTimestamp(timestamp), 60000);
    return timestamp;
  }

  private updateTimestamp(el: HTMLElement): void {
    const now = new Date();
    el.innerHTML = `LAST UPDATE: ${now.toUTCString().replace('GMT', 'UTC')}`;
  }

  private setupZoomHandlers(): void {
    let isDragging = false;
    let lastPos = { x: 0, y: 0 };
    let lastTouchDist = 0;
    let lastTouchCenter = { x: 0, y: 0 };

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
      const [worldResponse, usResponse] = await Promise.all([
        fetch(MAP_URLS.world),
        fetch(MAP_URLS.us),
      ]);

      this.worldData = await worldResponse.json();
      this.usData = await usResponse.json();

      this.render();
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

  public render(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    // Simple viewBox matching container - keeps SVG and overlays aligned
    this.svg.attr('viewBox', `0 0 ${width} ${height}`);
    this.svg.selectAll('*').remove();

    // Background
    this.svg
      .append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', '#020a08');

    // Grid
    this.renderGrid(width, height);

    // Setup projection
    const projection = this.getProjection(width, height);
    const path = d3.geoPath().projection(projection);

    // Graticule
    this.renderGraticule(path);

    // Countries
    this.renderCountries(path);

    // Layers (show on global and mena views)
    const showGlobalLayers = this.state.view === 'global' || this.state.view === 'mena';
    if (this.state.layers.cables && showGlobalLayers) {
      this.renderCables(projection);
    }

    if (this.state.layers.pipelines && showGlobalLayers) {
      this.renderPipelines(projection);
    }

    if (this.state.layers.conflicts && showGlobalLayers) {
      this.renderConflicts(projection);
    }

    if (this.state.layers.ais && showGlobalLayers) {
      this.renderAisDensity(projection);
    }

    if (this.state.layers.sanctions && showGlobalLayers) {
      this.renderSanctions();
    }

    // GPU-accelerated cluster markers (LOD)
    this.renderClusterLayer(projection);

    // Overlays
    this.renderOverlays(projection);

    this.applyTransform();
  }

  private renderGrid(width: number, height: number, yStart = 0): void {
    const gridGroup = this.svg.append('g').attr('class', 'grid');

    for (let x = 0; x < width; x += 20) {
      gridGroup
        .append('line')
        .attr('x1', x)
        .attr('y1', yStart)
        .attr('x2', x)
        .attr('y2', yStart + height)
        .attr('stroke', '#0a2a20')
        .attr('stroke-width', 0.5);
    }

    for (let y = yStart; y < yStart + height; y += 20) {
      gridGroup
        .append('line')
        .attr('x1', 0)
        .attr('y1', y)
        .attr('x2', width)
        .attr('y2', y)
        .attr('stroke', '#0a2a20')
        .attr('stroke-width', 0.5);
    }
  }

  private getProjection(width: number, height: number): d3.GeoProjection {
    if (this.state.view === 'global' || this.state.view === 'mena') {
      // Scale by width to fill horizontally, center vertically
      return d3
        .geoEquirectangular()
        .scale(width / (2 * Math.PI))
        .center([0, 0])
        .translate([width / 2, height / 2]);
    }

    return d3
      .geoAlbersUsa()
      .scale(width * 1.3)
      .translate([width / 2, height / 2]);
  }

  private renderGraticule(path: d3.GeoPath): void {
    const graticule = d3.geoGraticule();
    this.svg
      .append('path')
      .datum(graticule())
      .attr('class', 'graticule')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', '#1a5045')
      .attr('stroke-width', 0.4);
  }

  private renderCountries(path: d3.GeoPath): void {
    if ((this.state.view === 'global' || this.state.view === 'mena') && this.worldData) {
      const countries = topojson.feature(
        this.worldData,
        this.worldData.objects.countries
      );

      const features = 'features' in countries ? countries.features : [countries];

      this.svg
        .selectAll('.country')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'country')
        .attr('d', path as unknown as string)
        .attr('fill', '#0d3028')
        .attr('stroke', '#1a8060')
        .attr('stroke-width', 0.7);
    } else if (this.state.view === 'us' && this.usData) {
      const states = topojson.feature(
        this.usData,
        this.usData.objects.states
      );

      const features = 'features' in states ? states.features : [states];

      this.svg
        .selectAll('.state')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'state')
        .attr('d', path as unknown as string)
        .attr('fill', '#0d3028')
        .attr('stroke', '#1a8060')
        .attr('stroke-width', 0.7);
    }
  }

  private renderCables(projection: d3.GeoProjection): void {
    const cableGroup = this.svg.append('g').attr('class', 'cables');

    UNDERSEA_CABLES.forEach((cable) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal);

      const isHighlighted = this.highlightedAssets.cable.has(cable.id);
      const cableAdvisory = this.getCableAdvisory(cable.id);
      const advisoryClass = cableAdvisory ? `cable-${cableAdvisory.severity}` : '';
      const highlightClass = isHighlighted ? 'asset-highlight asset-highlight-cable' : '';

      const path = cableGroup
        .append('path')
        .attr('class', `cable-path ${advisoryClass} ${highlightClass}`.trim())
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
    const pipelineGroup = this.svg.append('g').attr('class', 'pipelines');

    PIPELINES.forEach((pipeline) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal.tension(0.5));

      const color = PIPELINE_COLORS[pipeline.type] || '#888888';
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
    const conflictGroup = this.svg.append('g').attr('class', 'conflicts');

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

  private renderConflictLabels(projection: d3.GeoProjection): void {
    CONFLICT_ZONES.forEach((zone) => {
      const centerPos = projection(zone.center as [number, number]);
      if (!centerPos) return;

      const div = document.createElement('div');
      div.className = 'conflict-label-overlay';
      div.style.left = `${centerPos[0]}px`;
      div.style.top = `${centerPos[1]}px`;
      div.textContent = zone.name;

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'conflict',
          data: zone,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });

      this.overlays.appendChild(div);
    });
  }

  private renderSanctions(): void {
    if (!this.worldData) return;

    const sanctionColors: Record<string, string> = {
      severe: 'rgba(255, 0, 0, 0.35)',
      high: 'rgba(255, 100, 0, 0.25)',
      moderate: 'rgba(255, 200, 0, 0.2)',
    };

    this.svg.selectAll('.country').each(function () {
      const el = d3.select(this);
      const id = el.datum() as { id?: number };
      if (id?.id !== undefined && SANCTIONED_COUNTRIES[id.id]) {
        const level = SANCTIONED_COUNTRIES[id.id];
        if (level) {
          el.attr('fill', sanctionColors[level] || '#0a2018');
        }
      }
    });
  }

  private renderOverlays(projection: d3.GeoProjection): void {
    this.overlays.innerHTML = '';

    const isGlobalOrMena = this.state.view === 'global' || this.state.view === 'mena';

    // Global/MENA only overlays
    if (isGlobalOrMena) {
      // Country labels (rendered first so they appear behind other overlays)
      if (this.state.layers.countries) {
        this.renderCountryLabels(projection);
      }

      // Conflict zone labels (HTML overlay with counter-scaling)
      if (this.state.layers.conflicts) {
        this.renderConflictLabels(projection);
      }

      // Strategic waterways
      if (this.state.layers.waterways) {
        this.renderWaterways(projection);
      }

      if (this.state.layers.ais) {
        this.renderAisDisruptions(projection);
      }

      // APT groups
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

        const label = document.createElement('div');
        label.className = 'nuclear-label';
        label.textContent = facility.name;
        div.appendChild(label);

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

    // Gamma irradiators (IAEA DIIF)
    if (this.state.layers.irradiators) {
      GAMMA_IRRADIATORS.forEach((irradiator) => {
        const pos = projection([irradiator.lon, irradiator.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = 'irradiator-marker';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${irradiator.city}, ${irradiator.country}`;

        const label = document.createElement('div');
        label.className = 'irradiator-label';
        label.textContent = irradiator.city;
        div.appendChild(label);

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

        const breakingBadge = spot.hasBreaking
          ? '<div class="hotspot-breaking">BREAKING</div>'
          : '';

        const subtextHtml = spot.subtext
          ? `<div class="hotspot-subtext">${spot.subtext}</div>`
          : '';

        div.innerHTML = `
          ${breakingBadge}
          <div class="hotspot-marker ${spot.level || 'low'}"></div>
          <div class="hotspot-label">${spot.name}</div>
          ${subtextHtml}
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

    // Earthquakes (magnitude-based sizing)
    if (this.state.layers.earthquakes) {
      console.log('[Map] Rendering earthquakes. Total:', this.earthquakes.length, 'Layer enabled:', this.state.layers.earthquakes);
      const filteredQuakes = this.filterByTime(this.earthquakes);
      console.log('[Map] After time filter:', filteredQuakes.length, 'earthquakes. TimeRange:', this.state.timeRange);
      let rendered = 0;
      filteredQuakes.forEach((eq) => {
        const pos = projection([eq.lon, eq.lat]);
        if (!pos) {
          console.log('[Map] Earthquake position null for:', eq.place, eq.lon, eq.lat);
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

        const label = document.createElement('div');
        label.className = 'economic-label';
        label.textContent = center.name;
        div.appendChild(label);

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

        const label = document.createElement('div');
        label.className = 'weather-label';
        label.textContent = alert.event;
        div.appendChild(label);

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
    if (this.state.layers.cables && isGlobalOrMena) {
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

        const label = document.createElement('div');
        label.className = 'datacenter-label';
        label.textContent = dc.owner;
        div.appendChild(label);

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

    // Protests / Social Unrest Events (severity colors + icons)
    if (this.state.layers.protests) {
      this.protests.forEach((event) => {
        const pos = projection([event.lon, event.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `protest-marker ${event.severity} ${event.eventType}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'protest-icon';
        icon.textContent = event.eventType === 'riot' ? '🔥' : event.eventType === 'strike' ? '✊' : '📢';
        div.appendChild(icon);

        if (this.state.zoom >= 4) {
          const label = document.createElement('div');
          label.className = 'protest-label';
          label.textContent = event.city || event.country;
          div.appendChild(label);
        }

        if (event.validated) {
          div.classList.add('validated');
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'protest',
            data: event,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
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
  }

  private renderCountryLabels(projection: d3.GeoProjection): void {
    COUNTRY_LABELS.forEach((country) => {
      const pos = projection([country.lon, country.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = 'country-label';
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;
      div.textContent = country.name;
      div.dataset.countryId = String(country.id);

      this.overlays.appendChild(div);
    });
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
    const densityGroup = this.svg.append('g').attr('class', 'ais-density');

    this.aisDensity.forEach((zone) => {
      const pos = projection([zone.lon, zone.lat]);
      if (!pos) return;

      const intensity = Math.min(Math.max(zone.intensity, 0.15), 1);
      const radius = 18 + intensity * 45;
      const isCongested = zone.deltaPct >= 15;
      const color = isCongested ? '#ffb703' : '#00d1ff';
      const fillOpacity = 0.08 + intensity * 0.22;

      densityGroup
        .append('circle')
        .attr('class', 'ais-density-spot')
        .attr('cx', pos[0])
        .attr('cy', pos[1])
        .attr('r', radius)
        .attr('fill', color)
        .attr('fill-opacity', fillOpacity)
        .attr('stroke', color)
        .attr('stroke-opacity', 0.35)
        .attr('stroke-width', 1);
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
        <div class="apt-label">${apt.name}</div>
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
    });

    this.render();
  }

  public setView(view: MapView): void {
    this.state.view = view;
    // Reset zoom when changing views for better UX
    this.state.zoom = view === 'mena' ? 2.5 : 1;
    this.state.pan = view === 'mena' ? { x: -180, y: 60 } : { x: 0, y: 0 };
    this.applyTransform();
    this.render();
  }

  public toggleLayer(layer: keyof MapLayers): void {
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

    const btn = document.querySelector(`[data-layer="${layer}"]`);
    btn?.classList.toggle('active');

    this.onLayerChange?.(layer, this.state.layers[layer]);
    // Defer render to next frame to avoid blocking the click handler
    requestAnimationFrame(() => this.render());
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean) => void): void {
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
      this.onLayerChange?.(layer, true);
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
    const mapHeight = width / 2; // Equirectangular 2:1 ratio

    // Horizontal: at zoom 1, no pan. At higher zooms, allow proportional pan
    const maxPanX = ((zoom - 1) / zoom) * (width / 2);

    // Vertical: allow panning to see poles if map extends beyond container
    const extraVertical = Math.max(0, (mapHeight - height) / 2);
    const zoomPanY = ((zoom - 1) / zoom) * (height / 2);
    const maxPanY = extraVertical + zoomPanY;

    this.state.pan.x = Math.max(-maxPanX, Math.min(maxPanX, this.state.pan.x));
    this.state.pan.y = Math.max(-maxPanY, Math.min(maxPanY, this.state.pan.y));
  }

  private applyTransform(): void {
    this.clampPan();
    const zoom = this.state.zoom;
    this.wrapper.style.transform = `scale(${zoom}) translate(${this.state.pan.x}px, ${this.state.pan.y}px)`;

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
    const labels = this.overlays.querySelectorAll('.hotspot-label, .earthquake-label, .nuclear-label, .weather-label, .apt-label');
    const labelRects: { el: Element; rect: DOMRect; priority: number }[] = [];

    // Collect all label bounds with priority
    labels.forEach((label) => {
      const el = label as HTMLElement;
      const parent = el.closest('.hotspot, .earthquake-marker, .nuclear-marker, .weather-marker, .apt-marker');

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
      } else if (parent?.classList.contains('nuclear-marker')) {
        if (parent.classList.contains('contested')) priority = 5;
        else priority = 3;
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
  }

  public setCenter(lat: number, lon: number): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const projection = this.getProjection(width, height);
    const pos = projection([lon, lat]);
    if (!pos) return;
    const zoom = this.state.zoom;
    this.state.pan = {
      x: width / (2 * zoom) - pos[0],
      y: height / (2 * zoom) - pos[1],
    };
    this.applyTransform();
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

  public setProtests(events: SocialUnrestEvent[]): void {
    this.protests = events;
    this.render();
  }

  public setFlightDelays(delays: AirportDelayAlert[]): void {
    this.flightDelays = delays;
    this.render();
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
