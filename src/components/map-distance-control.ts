import { ArcLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { ScaleControl, type Map as MapLibreMap } from 'maplibre-gl';
import { t, getLocale, I18N_RESOURCES_LOADED_EVENT } from '@/services/i18n';
import { haversineKm } from '@/utils/distance';

type Coordinate = [number, number];

/** Passive projected scale and an opt-in ruler for clicked coordinates on the 2D map. */
export class MapDistanceControl {
  private readonly root = document.createElement('div');
  private readonly toggle = document.createElement('button');
  private readonly units = document.createElement('select');
  private readonly panel = document.createElement('div');
  private readonly status = document.createElement('div');
  private readonly note = document.createElement('div');
  private readonly reset = document.createElement('button');
  private readonly exit = document.createElement('button');
  private readonly scale = new ScaleControl({ maxWidth: 100, unit: 'metric' });
  private points: Coordinate[] = [];
  private active = false;
  private pointerStart: Coordinate | null = null;
  private dragged = false;
  private visibilityObserver: ResizeObserver | null = null;

  constructor(private readonly map: MapLibreMap, private readonly container: HTMLElement, private readonly changed: () => void) {
    this.root.className = 'map-distance-control';
    const toolbar = document.createElement('div');
    toolbar.className = 'map-distance-toolbar';
    this.toggle.type = this.reset.type = this.exit.type = 'button';
    this.toggle.className = 'map-distance-toggle';
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.addEventListener('click', () => this.setActive(!this.active));
    for (const unit of ['km', 'mi']) {
      const option = document.createElement('option');
      option.value = option.textContent = unit;
      this.units.append(option);
    }
    this.units.addEventListener('change', () => {
      this.refreshScale();
      this.updateLabels();
    });
    toolbar.append(this.toggle, this.units);
    this.panel.className = 'map-distance-panel';
    this.panel.hidden = true;
    this.status.className = 'map-distance-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.note.className = 'map-distance-note';
    this.reset.addEventListener('click', () => {
      this.points = [];
      this.updateLabels();
      this.changed();
      this.map.getCanvas().focus();
    });
    this.exit.addEventListener('click', () => this.setActive(false));
    const actions = document.createElement('div');
    actions.className = 'map-distance-actions';
    actions.append(this.reset, this.exit);
    this.panel.append(this.status, actions, this.note);
    // Keep MapLibre's projection-aware implementation, in our existing map chrome.
    this.root.append(this.scale.onAdd(map), toolbar, this.panel);
    container.append(this.root);
    container.addEventListener('click', this.handleClick, true);
    container.addEventListener('dblclick', this.handleClick, true);
    container.addEventListener('pointerdown', this.handlePointerDown, true);
    container.addEventListener('pointermove', this.handlePointerMove, true);
    container.addEventListener('keydown', this.handleKey, true);
    map.on('resize', this.refreshScale);
    // CSS can hide the control (the short mobile map strip). A hidden control
    // must not leave measurement armed, or canvas clicks stop opening markers.
    if (typeof ResizeObserver !== 'undefined') {
      this.visibilityObserver = new ResizeObserver(() => {
        if (this.active && this.root.getClientRects().length === 0) this.setActive(false);
      });
      this.visibilityObserver.observe(this.root);
    }
    window.addEventListener(I18N_RESOURCES_LOADED_EVENT, this.updateLabels);
    this.updateLabels();
  }

  private readonly refreshScale = (): void => {
    this.scale.setUnit(this.units.value === 'mi' ? 'imperial' : 'metric');
  };

  private setActive(active: boolean): void {
    this.active = active;
    this.points = [];
    this.panel.hidden = !active;
    this.toggle.setAttribute('aria-expanded', String(active));
    this.container.classList.toggle('map-measuring', active);
    this.updateLabels();
    this.changed();
    if (active) this.map.getCanvas().focus();
    else this.toggle.focus();
  }

  private readonly updateLabels = (): void => {
    const label = (key: string) => t(`components.deckgl.measure.${key}`);
    this.toggle.textContent = label('title');
    this.units.setAttribute('aria-label', label('units'));
    this.note.textContent = label('note');
    const resetAction = this.points.length === 1 ? 'cancel' : 'reset';
    this.reset.textContent = label(`${resetAction}Short`);
    this.reset.setAttribute('aria-label', label(resetAction));
    this.exit.textContent = label('exitShort');
    this.exit.setAttribute('aria-label', label('exit'));
    this.reset.disabled = this.points.length === 0;
    const [a, b] = this.points;
    if (a && b) {
      const km = haversineKm(a[1], a[0], b[1], b[0]);
      const value = this.units.value === 'mi' ? km / 1.609344 : km;
      this.status.textContent = `${label('geodesic')}: ${value.toLocaleString(getLocale(), { maximumFractionDigits: 1 })} ${this.units.value}`;
    } else {
      this.status.textContent = label(a ? 'pointB' : 'pointA');
    }
  };

  private select(coordinate: Coordinate): void {
    if (this.points.length === 2 || !coordinate.every(Number.isFinite) || Math.abs(coordinate[1]) > 90) return;
    this.points = [...this.points, coordinate];
    this.updateLabels();
    this.changed();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.active) return;
    this.pointerStart = [event.clientX, event.clientY];
    this.dragged = false;
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.active) return;
    if (this.pointerStart && Math.hypot(event.clientX - this.pointerStart[0], event.clientY - this.pointerStart[1]) > 5) this.dragged = true;
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (!this.active || !(event.target instanceof Element) || !event.target.closest('.maplibregl-canvas-container')) return;
    // Capture before MapLibre forwards clicks to deck.gl or DOM marker popups.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'dblclick' || event.detail > 1 || this.dragged) return;
    const rect = this.map.getCanvas().getBoundingClientRect();
    const point = this.map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    this.select([point.lng, point.lat]);
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setActive(false);
    } else if (event.key === 'Enter' && event.target === this.map.getCanvas()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const center = this.map.getCenter();
      this.select([center.lng, center.lat]);
    }
  };

  getLayers(): (ArcLayer | ScatterplotLayer | TextLayer)[] {
    if (!this.active || this.points.length === 0) return [];
    const layers: (ArcLayer | ScatterplotLayer | TextLayer)[] = [];
    const [a, b] = this.points;
    if (a && b) layers.push(new ArcLayer({
      id: 'map-distance-line', data: [{ a, b }],
      getSourcePosition: d => d.a, getTargetPosition: d => d.b,
      greatCircle: true, getHeight: 0, getWidth: 3,
      getSourceColor: [255, 190, 40], getTargetColor: [255, 190, 40],
      pickable: false, parameters: { depthCompare: 'always' },
    }));
    layers.push(new ScatterplotLayer({
      id: 'map-distance-points', data: this.points,
      getPosition: d => d, getRadius: 6, radiusUnits: 'pixels',
      getFillColor: [255, 190, 40], getLineColor: [20, 20, 20],
      stroked: true, lineWidthMinPixels: 2, pickable: false,
      parameters: { depthCompare: 'always' },
    }), new TextLayer({
      id: 'map-distance-labels', data: this.points,
      getPosition: d => d, getText: (_d, { index }) => index === 0 ? 'A' : 'B',
      getPixelOffset: [0, -18], getSize: 16, getColor: [255, 190, 40],
      outlineWidth: 2, outlineColor: [20, 20, 20], fontSettings: { sdf: true },
      pickable: false, parameters: { depthCompare: 'always' },
    }));
    return layers;
  }

  destroy(): void {
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.scale.onRemove();
    this.map.off('resize', this.refreshScale);
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.updateLabels);
    this.container.removeEventListener('click', this.handleClick, true);
    this.container.removeEventListener('dblclick', this.handleClick, true);
    this.container.removeEventListener('pointerdown', this.handlePointerDown, true);
    this.container.removeEventListener('pointermove', this.handlePointerMove, true);
    this.container.removeEventListener('keydown', this.handleKey, true);
    this.container.classList.remove('map-measuring');
    this.root.remove();
  }
}
