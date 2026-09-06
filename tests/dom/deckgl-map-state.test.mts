/**
 * DeckGLMap viewport state and state isolation, against the real class.
 *
 * Two copied suites used to cover this with stubs that re-implemented
 * `pendingCenter`, the moveend generation guard, and the constructor /
 * getState / setLayers copy logic; both passed with no production file
 * present (#7770). Here the real DeckGLMap is constructed under happy-dom
 * with maplibre and deck.gl replaced by recording fakes, so `setView`,
 * `setCenter`, `getCenter`, the `moveend` listener the constructor wires,
 * `getState` and `setLayers` are the production methods.
 *
 * Lives under tests/dom/ because DeckGLMap needs a DOM and the i18n module
 * graph, both unreachable from the `tsx --test` profile.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

type Handler = (event?: unknown) => void;
type FlyToCall = { options: { center?: [number, number]; zoom?: number }; eventData?: Record<string, unknown> };

const { FakeMap, fakeMaps } = vi.hoisted(() => {
  class FakeMap {
    handlers = new Map<string, Handler[]>();
    center: { lng: number; lat: number };
    zoom: number;
    moving = false;
    flyToCalls: FlyToCall[] = [];
    canvas = document.createElement('canvas');
    dragRotate = { disable(): void {}, enable(): void {} };
    touchZoomRotate = { disableRotation(): void {}, enableRotation(): void {} };
    keyboard = { disable(): void {}, enable(): void {} };
    scrollZoom = { disable(): void {}, enable(): void {}, setWheelZoomRate(): void {} };
    doubleClickZoom = { disable(): void {}, enable(): void {} };
    dragPan = { disable(): void {}, enable(): void {} };
    boxZoom = { disable(): void {}, enable(): void {} };
    touchPitch = { disable(): void {}, enable(): void {} };

    constructor(options: { container: HTMLElement; center: [number, number]; zoom: number }) {
      this.center = { lng: options.center[0], lat: options.center[1] };
      this.zoom = options.zoom;
      options.container.appendChild(this.canvas);
      fakeMaps.push(this);
    }

    on(event: string, handler: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, handler: Handler): this {
      const wrapped: Handler = (data) => {
        this.off(event, wrapped);
        handler(data);
      };
      return this.on(event, wrapped);
    }

    off(event: string, handler: Handler): this {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler));
      return this;
    }

    emit(event: string, data?: unknown): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
    }

    getCanvas(): HTMLCanvasElement { return this.canvas; }
    getContainer(): HTMLElement { return this.canvas.parentElement ?? document.createElement('div'); }
    getCenter(): { lng: number; lat: number } { return { ...this.center }; }
    getZoom(): number { return this.zoom; }
    getBearing(): number { return 0; }
    getPitch(): number { return 0; }
    isMoving(): boolean { return this.moving; }
    flyTo(options: FlyToCall['options'], eventData?: Record<string, unknown>): this {
      this.flyToCalls.push({ options, eventData });
      this.moving = true;
      return this;
    }
    easeTo(options: FlyToCall['options'], eventData?: Record<string, unknown>): this { return this.flyTo(options, eventData); }
    jumpTo(options: { center?: [number, number]; zoom?: number }): this {
      if (options.center) this.center = { lng: options.center[0], lat: options.center[1] };
      if (options.zoom != null) this.zoom = options.zoom;
      return this;
    }
    setZoom(zoom: number): this { this.zoom = zoom; return this; }
    setCenter(center: [number, number]): this { this.center = { lng: center[0], lat: center[1] }; return this; }
    fitBounds(): this { return this; }
    getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } {
      return { getWest: () => -180, getSouth: () => -90, getEast: () => 180, getNorth: () => 90 };
    }
    project(): { x: number; y: number } { return { x: 0, y: 0 }; }
    unproject(): { lng: number; lat: number } { return { lng: 0, lat: 0 }; }
    addControl(): this { return this; }
    removeControl(): this { return this; }
    resize(): this { return this; }
    remove(): void {}
    triggerRepaint(): void {}
    getStyle(): { layers: unknown[]; sources: Record<string, unknown> } { return { layers: [], sources: {} }; }
    setStyle(): this { return this; }
    isStyleLoaded(): boolean { return true; }
    loaded(): boolean { return true; }
    areTilesLoaded(): boolean { return true; }
    getLayer(): undefined { return undefined; }
    getSource(): undefined { return undefined; }
    addSource(): this { return this; }
    addLayer(): this { return this; }
    removeLayer(): this { return this; }
    removeSource(): this { return this; }
    moveLayer(): this { return this; }
    setPaintProperty(): this { return this; }
    setLayoutProperty(): this { return this; }
    setFilter(): this { return this; }
    setMaxPitch(): this { return this; }
    setMinZoom(): this { return this; }
    setMaxZoom(): this { return this; }
    setRenderWorldCopies(): this { return this; }
    queryRenderedFeatures(): unknown[] { return []; }
    querySourceFeatures(): unknown[] { return []; }
    hasImage(): boolean { return false; }
    addImage(): this { return this; }
    loadImage(): Promise<{ data: unknown }> { return Promise.resolve({ data: null }); }

    /** The generation production attached to the most recent flight. */
    lastFlightGeneration(): { key: string; generation: number } {
      const call = this.flyToCalls[this.flyToCalls.length - 1];
      if (!call?.eventData) throw new Error('no flight with event data recorded');
      const [key, generation] = Object.entries(call.eventData)[0] ?? [];
      if (typeof key !== 'string' || typeof generation !== 'number') throw new Error('flight carried no generation');
      return { key, generation };
    }

    /** Land at the last flight's target and emit moveend carrying its generation. */
    settleLastFlight(overrides: { zoom?: number; generation?: number } = {}): void {
      const call = this.flyToCalls[this.flyToCalls.length - 1];
      if (call?.options.center) this.center = { lng: call.options.center[0], lat: call.options.center[1] };
      if (overrides.zoom != null) this.zoom = overrides.zoom;
      else if (call?.options.zoom != null) this.zoom = call.options.zoom;
      this.moving = false;
      const { key, generation } = this.lastFlightGeneration();
      this.emit('moveend', { [key]: overrides.generation ?? generation });
    }
  }
  return { FakeMap, fakeMaps: [] as FakeMap[] };
});

vi.mock('maplibre-gl', () => {
  const namespace = {
    Map: FakeMap,
    getRTLTextPluginStatus: (): string => 'loaded',
    setRTLTextPlugin: (): void => {},
    addProtocol: (): void => {},
    removeProtocol: (): void => {},
    NavigationControl: class {},
    AttributionControl: class {},
    ScaleControl: class {},
    Popup: class {},
    Marker: class {},
    LngLat: class {},
    LngLatBounds: class {},
  };
  return { default: namespace, ...namespace };
});

vi.mock('@deck.gl/mapbox', () => ({
  MapboxOverlay: class {
    props: Record<string, unknown>;
    constructor(props: Record<string, unknown>) { this.props = props; }
    setProps(props: Record<string, unknown>): void { Object.assign(this.props, props); }
    finalize(): void {}
    onAdd(): HTMLElement { return document.createElement('div'); }
    onRemove(): void {}
    pickObject(): null { return null; }
    pickMultipleObjects(): unknown[] { return []; }
  },
}));

vi.mock('@deck.gl/layers', () => {
  class StubLayer {
    props: Record<string, unknown>;
    id: unknown;
    constructor(props: Record<string, unknown> = {}) {
      this.props = props;
      this.id = props.id;
    }
    clone(props: Record<string, unknown>): StubLayer { return new StubLayer({ ...this.props, ...props }); }
  }
  return {
    ArcLayer: StubLayer,
    GeoJsonLayer: StubLayer,
    IconLayer: StubLayer,
    PathLayer: StubLayer,
    PolygonLayer: StubLayer,
    ScatterplotLayer: StubLayer,
    TextLayer: StubLayer,
  };
});

vi.mock('@/config/basemap-styles', () => ({
  getStyleForProvider: async (): Promise<string> => 'https://basemap.test/style.json',
  buildPMTilesStyle: async (): Promise<null> => null,
  registerPMTilesProtocol: async (): Promise<void> => {},
}));

import { DeckGLMap } from '@/components/DeckGLMap';
import { DEFAULT_MAP_LAYERS } from '@/config/panels';

type DeckMapState = ConstructorParameters<typeof DeckGLMap>[1];
type MapLayers = DeckMapState['layers'];

const emptyJson = (): Response => new Response('{"type":"FeatureCollection","features":[]}', {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function allLayersOff(): MapLayers {
  return Object.fromEntries(Object.keys(DEFAULT_MAP_LAYERS).map((key) => [key, false])) as unknown as MapLayers;
}

function initialState(overrides: Partial<DeckMapState> = {}): DeckMapState {
  return {
    zoom: 1.5,
    pan: { x: 10, y: 20 },
    view: 'global',
    layers: { ...allLayersOff(), hotspots: true, conflicts: true },
    timeRange: '24h',
    ...overrides,
  };
}

async function createMap(state: DeckMapState = initialState()): Promise<{ map: DeckGLMap; fake: InstanceType<typeof FakeMap> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const map = new DeckGLMap(container, state, { chrome: false });
  await map.whenReady();
  const fake = fakeMaps[fakeMaps.length - 1];
  if (!fake) throw new Error('DeckGLMap did not construct a maplibre map');
  // The constructor registers movestart/moveend/move/zoom once the style
  // loads; the fake never loads on its own.
  fake.emit('load');
  return { map, fake };
}

beforeAll(async () => {
  await initTestI18n();
});

let maps: DeckGLMap[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => emptyJson()));
  fakeMaps.length = 0;
  maps = [];
});

afterEach(() => {
  for (const map of maps) map.destroy();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mapWith(state?: DeckMapState): Promise<{ map: DeckGLMap; fake: InstanceType<typeof FakeMap> }> {
  const created = await createMap(state);
  maps.push(created.map);
  return created;
}

describe('DeckGLMap pendingCenter — eager center cache', () => {
  it('setView caches the preset centre and writes view and zoom synchronously', async () => {
    const { map, fake } = await mapWith();
    map.setView('mena');
    expect(map.getCenter()).toEqual({ lat: 28, lon: 45 });
    expect(map.getState().view).toBe('mena');
    expect(map.getState().zoom).toBe(3.5);
    const flight = fake.flyToCalls[fake.flyToCalls.length - 1];
    expect(flight?.options.center).toEqual([45, 28]);
    expect(flight?.options.zoom).toBe(3.5);
    expect(typeof fake.lastFlightGeneration().generation).toBe('number');
  });

  it('an explicit zoom overrides the preset zoom but not its centre', async () => {
    const { map, fake } = await mapWith();
    map.setView('mena', 4);
    expect(map.getState().zoom).toBe(4);
    expect(map.getCenter()).toEqual({ lat: 28, lon: 45 });
    expect(fake.flyToCalls[fake.flyToCalls.length - 1]?.options.zoom).toBe(4);
  });

  it('getCenter reports the pending target while the flight is in progress, not the camera', async () => {
    const { map, fake } = await mapWith();
    map.setView('eu');
    expect(fake.getCenter()).toEqual({ lng: 0, lat: 20 });
    expect(map.getCenter()).toEqual({ lat: 50, lon: 15 });
  });

  it('moveend for the current flight clears the cache and adopts the settled zoom', async () => {
    const { map, fake } = await mapWith();
    map.setView('mena', 4);
    fake.settleLastFlight({ zoom: 4.02 });
    expect(map.getCenter()).toEqual({ lat: 28, lon: 45 });
    expect(map.getState().zoom).toBe(4.02);
    // The cache is gone: a later camera position is what getCenter reports.
    fake.jumpTo({ center: [1, 2] });
    expect(map.getCenter()).toEqual({ lat: 2, lon: 1 });
  });

  it('consecutive setView calls retarget the cache', async () => {
    const { map } = await mapWith();
    map.setView('mena');
    map.setView('eu');
    expect(map.getCenter()).toEqual({ lat: 50, lon: 15 });
  });

  it('ignores a stale moveend from a superseded flight', async () => {
    const { map, fake } = await mapWith();
    map.setView('mena');
    const first = fake.lastFlightGeneration();
    map.setView('eu');
    const second = fake.lastFlightGeneration();
    expect(second.generation).not.toBe(first.generation);

    // MapLibre emits the old flight's moveend when the second flyTo stops it.
    fake.center = { lng: 45, lat: 28 };
    fake.emit('moveend', { [first.key]: first.generation });
    expect(map.getCenter()).toEqual({ lat: 50, lon: 15 });

    fake.settleLastFlight();
    expect(map.getCenter()).toEqual({ lat: 50, lon: 15 });
    fake.jumpTo({ center: [3, 4] });
    expect(map.getCenter()).toEqual({ lat: 4, lon: 3 });
  });

  it('a user-driven moveend with no generation clears the cache', async () => {
    const { map, fake } = await mapWith();
    map.setView('america');
    fake.center = { lng: -100, lat: 40 };
    fake.emit('moveend', {});
    expect(map.getCenter()).toEqual({ lat: 40, lon: -100 });
  });

  it('setCenter caches the requested coordinates and zoom', async () => {
    const { map, fake } = await mapWith();
    map.setCenter(41, 29, 6);
    expect(map.getCenter()).toEqual({ lat: 41, lon: 29 });
    expect(map.getState().zoom).toBe(6);
    expect(fake.flyToCalls[fake.flyToCalls.length - 1]?.options.center).toEqual([29, 41]);
  });

  it('a view-only initial URL leaves the preset centre available to the URL builder', async () => {
    const { map } = await mapWith();
    map.setView('mena');
    const center = map.getCenter();
    expect(center).not.toBeNull();
    expect(center?.lat).toBe(28);
    expect(center?.lon).toBe(45);
    expect(map.getState().zoom).toBe(3.5);
  });
});

describe('DeckGLMap state isolation', () => {
  it('the constructor copies pan and layers so caller mutations do not reach internal state', async () => {
    const state = initialState();
    const { map } = await mapWith(state);
    state.layers.hotspots = false;
    state.pan.x = 999;
    expect(map.getState().layers.hotspots).toBe(true);
    expect(map.getState().pan.x).toBe(10);
  });

  it('getState returns fresh pan and layers objects each call', async () => {
    const { map } = await mapWith();
    const first = map.getState();
    const second = map.getState();
    expect(first.layers).not.toBe(second.layers);
    expect(first.pan).not.toBe(second.pan);
    first.layers.hotspots = false;
    first.pan.x = 999;
    expect(map.getState().layers.hotspots).toBe(true);
    expect(map.getState().pan.x).toBe(10);
  });

  it('setLayers copies its input, so later mutations of the caller object are not observed', async () => {
    const { map } = await mapWith();
    const input = { ...allLayersOff(), hotspots: true, conflicts: false };
    map.setLayers(input);
    expect(map.getState().layers.hotspots).toBe(true);
    expect(map.getState().layers.conflicts).toBe(false);
    input.hotspots = false;
    expect(map.getState().layers.hotspots).toBe(true);
    map.getState().layers.conflicts = true;
    expect(map.getState().layers.conflicts).toBe(false);
  });

  it('onStateChange receives a copy, and mutating it does not reach internal state', async () => {
    const { map } = await mapWith();
    let received: DeckMapState | null = null;
    map.setOnStateChange((state) => { received = state; });
    map.setView('eu');
    expect(received).not.toBeNull();
    const snapshot = received as unknown as DeckMapState;
    expect(snapshot.view).toBe('eu');
    snapshot.layers.hotspots = false;
    snapshot.pan.x = 999;
    expect(map.getState().layers.hotspots).toBe(true);
    expect(map.getState().pan.x).toBe(10);
  });
});
