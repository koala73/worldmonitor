/**
 * The satellite pass lookup centres the map on the looked-up point, and the
 * point must never reach a WorldMonitor host (#10704). Layers that send the
 * map's viewport to a WorldMonitor API would carry it: imagery footprints,
 * military bases, aircraft positions and webcams. While the lookup is open
 * those requests hold and the layers keep their last data; once it closes they
 * fetch for wherever the map is.
 *
 * The real DeckGLMap, GlobeMap and DataLoaderManager run here; maplibre,
 * deck.gl and globe.gl are recording fakes and every request goes through a
 * stubbed fetch, so each request a layer would send is visible.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

type Handler = (event?: unknown) => void;

const { FakeMap, fakeMaps } = vi.hoisted(() => {
  class FakeMap {
    handlers = new Map<string, Handler[]>();
    center: { lng: number; lat: number };
    zoom: number;
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
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    once(event: string, handler: Handler): this {
      const wrapped: Handler = (data) => { this.off(event, wrapped); handler(data); };
      return this.on(event, wrapped);
    }
    off(event: string, handler: Handler): this {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler));
      return this;
    }
    emit(event: string, data?: unknown): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
    }
    /** Puts the camera at `lat, lon` and reports the move as finished, as maplibre does after a jump or a flight. */
    moveTo(lat: number, lon: number, zoom: number): void {
      this.center = { lat, lng: lon };
      this.zoom = zoom;
      this.emit('moveend', {});
    }

    getCanvas(): HTMLCanvasElement { return this.canvas; }
    getContainer(): HTMLElement { return this.canvas.parentElement ?? document.createElement('div'); }
    getCenter(): { lng: number; lat: number } { return { ...this.center }; }
    getZoom(): number { return this.zoom; }
    getBearing(): number { return 0; }
    getPitch(): number { return 0; }
    isMoving(): boolean { return false; }
    flyTo(): this { return this; }
    easeTo(): this { return this; }
    jumpTo(): this { return this; }
    setZoom(zoom: number): this { this.zoom = zoom; return this; }
    setCenter(center: [number, number]): this { this.center = { lng: center[0], lat: center[1] }; return this; }
    fitBounds(): this { return this; }
    /** A box 0.1 degrees either side of the centre, about what zoom 11 shows. */
    getBounds() {
      const { lat, lng } = this.center;
      const r = 0.1;
      return {
        getWest: () => lng - r, getSouth: () => lat - r, getEast: () => lng + r, getNorth: () => lat + r,
        getSouthWest: () => ({ lat: lat - r, lng: lng - r }), getNorthEast: () => ({ lat: lat + r, lng: lng + r }),
      };
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
  }
  return { FakeMap, fakeMaps: [] as FakeMap[] };
});

vi.mock('maplibre-gl', () => {
  const namespace = {
    Map: FakeMap,
    setWorkerUrl: (): void => {},
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

vi.mock('@deck.gl/maplibre', () => ({
  MapLibreOverlay: class {
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
    constructor(props: Record<string, unknown> = {}) { this.props = props; this.id = props.id; }
    clone(props: Record<string, unknown>): StubLayer { return new StubLayer({ ...this.props, ...props }); }
  }
  return {
    ArcLayer: StubLayer, GeoJsonLayer: StubLayer, IconLayer: StubLayer, PathLayer: StubLayer,
    PolygonLayer: StubLayer, ScatterplotLayer: StubLayer, TextLayer: StubLayer,
  };
});

vi.mock('@/config/basemap-styles', () => ({
  getStyleForProvider: async (): Promise<string> => 'https://basemap.test/style.json',
  buildPMTilesStyle: async (): Promise<null> => null,
  registerPMTilesProtocol: async (): Promise<void> => {},
}));

vi.mock('globe.gl', () => ({ default: vi.fn() }));
vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));

import type { AppContext } from '@/app/app-context';
import { DeckGLMap } from '@/components/DeckGLMap';
import { GlobeMap } from '@/components/GlobeMap';
import { DEFAULT_MAP_LAYERS } from '@/config/panels';
import { setOrbitalLookupOpen } from '@/services/orbital/lookup-host';

type DeckMapState = ConstructorParameters<typeof DeckGLMap>[1];
type MapLayers = DeckMapState['layers'];

/** Dubai, the looked-up point. */
const POINT = { lat: 25.2048, lon: 55.2708 };
/** Where the map is once the lookup has closed. */
const AFTER = { lat: 48.8566, lon: 2.3522 };
/** A place for the no-lookup checks. */
const ELSEWHERE = { lat: -33.8688, lon: 151.2093 };

/** The WorldMonitor endpoints that take the map's viewport. */
const VIEWPORT_ENDPOINTS = ['/api/imagery/v1/search-imagery', 'list-military-bases', 'track-aircraft', 'list-webcams'] as const;

const requests: string[] = [];

function respond(url: string): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('search-imagery')) return json({ scenes: [] });
  if (url.includes('list-military-bases')) return json({ bases: [], clusters: [], totalInView: 0, truncated: false });
  if (url.includes('track-aircraft')) return json({ positions: [] });
  if (url.includes('list-webcams')) return json({ webcams: [], clusters: [], totalInView: 0 });
  return json({ type: 'FeatureCollection', features: [] });
}

/**
 * Runs timers for `ms`, then lets lazily imported request modules load and
 * their requests go out, so a request that would leak is recorded before the
 * test looks.
 */
async function settle(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 3; i += 1) {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
  }
}

const viewportRequests = (endpoint?: (typeof VIEWPORT_ENDPOINTS)[number]) =>
  requests.filter((r) => (endpoint ? [endpoint] : VIEWPORT_ENDPOINTS).some((e) => r.includes(e)));

/** The midpoint of an imagery request's `bbox=west,south,east,north`. */
function imageryMidpoint(request: string): { lat: number; lon: number } {
  const bbox = new URL(request, 'http://localhost').searchParams.get('bbox');
  const [w, s, e, n] = (bbox ?? '').split(',').map(Number);
  return { lat: (s! + n!) / 2, lon: (w! + e!) / 2 };
}

/** The AE8 threshold: a box centred within 0.1 degrees of the point carries the point. */
const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.abs(a.lat - b.lat) <= 0.1 && Math.abs(a.lon - b.lon) <= 0.1;

function layersOn(keys: (keyof MapLayers)[]): MapLayers {
  const layers = Object.fromEntries(Object.keys(DEFAULT_MAP_LAYERS).map((key) => [key, false])) as unknown as MapLayers;
  for (const key of keys) layers[key] = true;
  return layers;
}

beforeAll(async () => {
  await initTestI18n();
});

const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  fakeMaps.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    return respond(url);
  }));
});

afterEach(() => {
  // Tear the maps down first, so closing the lookup cannot start a refetch that lands in the next test.
  for (const cleanup of cleanups.splice(0)) cleanup();
  setOrbitalLookupOpen(false);
  document.body.innerHTML = '';
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DeckGLMap viewport layers while the satellite pass lookup is open', () => {
  async function deckMap() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const map = new DeckGLMap(container, {
      zoom: 5, pan: { x: 0, y: 0 }, view: 'global', timeRange: '24h',
      layers: layersOn(['satellites', 'bases', 'flights']),
    }, { chrome: false });
    cleanups.push(() => map.destroy());
    await map.whenReady();
    const fake = fakeMaps[fakeMaps.length - 1]!;
    fake.emit('load');
    // The constructor does not start the 120 s aircraft poll; the layer path does.
    map.setLayers(layersOn(['satellites', 'bases', 'flights']));
    // Let the start-up fetches go out, then watch only what the lookup causes.
    fake.moveTo(10, 10, 5);
    await settle(2000);
    requests.length = 0;
    return { map, fake };
  }

  it('sends no viewport to WorldMonitor when the lookup centres the map on the point, even across the aircraft poll', async () => {
    const { fake } = await deckMap();
    setOrbitalLookupOpen(true);

    fake.moveTo(POINT.lat, POINT.lon, 11);
    await settle(2000);
    // A pan while the lookup is open is still a viewport near the point.
    fake.moveTo(POINT.lat + 0.05, POINT.lon - 0.05, 12);
    await settle(125_000);

    expect(viewportRequests()).toEqual([]);
  });

  it('fetches every held layer for where the map is once the lookup closes', async () => {
    const { fake } = await deckMap();
    setOrbitalLookupOpen(true);
    fake.moveTo(POINT.lat, POINT.lon, 11);
    await settle(2000);
    expect(viewportRequests()).toEqual([]);

    // The map is somewhere else when the lookup closes, with no move event after the close.
    fake.center = { lat: AFTER.lat, lng: AFTER.lon };
    fake.zoom = 6;
    setOrbitalLookupOpen(false);
    await settle(2000);

    const imagery = viewportRequests('/api/imagery/v1/search-imagery');
    expect(imagery).toHaveLength(1);
    expect(near(imageryMidpoint(imagery[0]!), AFTER)).toBe(true);
    expect(viewportRequests('list-military-bases')).toHaveLength(1);
    expect(viewportRequests('track-aircraft')).toHaveLength(1);
    expect(viewportRequests().some((r) => r.includes(String(POINT.lat)))).toBe(false);
  });

  it('keeps fetching on map moves while no lookup is open', async () => {
    const { fake } = await deckMap();
    // Somewhere no other test has fetched, so the services' own caches cannot answer.
    fake.moveTo(ELSEWHERE.lat, ELSEWHERE.lon, 11);
    await settle(2000);

    const imagery = viewportRequests('/api/imagery/v1/search-imagery');
    expect(imagery).toHaveLength(1);
    expect(near(imageryMidpoint(imagery[0]!), ELSEWHERE)).toBe(true);
    expect(viewportRequests('list-military-bases')).toHaveLength(1);
    expect(viewportRequests('track-aircraft')).toHaveLength(1);
  });
});

describe('GlobeMap imagery while the satellite pass lookup is open', () => {
  function globeAt(at: { lat: number; lon: number }) {
    const globe = new GlobeMap(document.createElement('div'), {
      zoom: 1, pan: { x: 0, y: 0 }, view: 'global', timeRange: '24h', layers: layersOn(['satellites']),
    } as unknown as ConstructorParameters<typeof GlobeMap>[1]);
    globe.whenReady().catch(() => {});
    cleanups.push(() => { Reflect.set(globe, 'globe', null); globe.destroy(); });
    let pov = { lat: at.lat, lng: at.lon, altitude: 0.1 };
    // globe.gl is mocked out, so stand in the camera the imagery fetch reads.
    Reflect.set(globe, 'globe', { pointOfView: () => ({ ...pov }), scene: () => null });
    Reflect.set(globe, 'setImageryScenes', () => {});
    const fetchForViewport = () => (Reflect.get(globe, 'fetchImageryForViewport') as () => Promise<void>).call(globe);
    return { globe, fetchForViewport, moveTo: (next: { lat: number; lon: number }) => { pov = { lat: next.lat, lng: next.lon, altitude: 0.1 }; } };
  }

  it('holds the imagery search while the lookup is open and runs it for the current view on close', async () => {
    const { fetchForViewport, moveTo } = globeAt(POINT);
    setOrbitalLookupOpen(true);

    // The camera-settled handler and the layer toggle both call this.
    await fetchForViewport();
    await settle(1000);
    expect(viewportRequests()).toEqual([]);

    moveTo(AFTER);
    setOrbitalLookupOpen(false);
    await settle(1000);

    const imagery = viewportRequests('/api/imagery/v1/search-imagery');
    expect(imagery).toHaveLength(1);
    expect(near(imageryMidpoint(imagery[0]!), AFTER)).toBe(true);
  });

  it('searches imagery for the view while no lookup is open', async () => {
    const { fetchForViewport } = globeAt(POINT);
    await fetchForViewport();
    const imagery = viewportRequests('/api/imagery/v1/search-imagery');
    expect(imagery).toHaveLength(1);
    expect(near(imageryMidpoint(imagery[0]!), POINT)).toBe(true);
  });
});

describe('data loader viewport requests while the satellite pass lookup is open', () => {
  interface LoaderInternals {
    init(): void;
    destroy(): void;
    loadWebcams(): Promise<void>;
    loadImageryFootprints(): void;
  }

  async function loader() {
    let bbox = `${POINT.lon - 0.1},${POINT.lat - 0.1},${POINT.lon + 0.1},${POINT.lat + 0.1}`;
    const map = {
      getState: () => ({ zoom: 11 }),
      getBbox: () => bbox,
      isGlobeMode: () => false,
      setWebcams: vi.fn(),
      setLayerReady: vi.fn(),
      setImageryScenes: vi.fn(),
    };
    const ctx = { map, mapLayers: { webcams: true, satellites: true } } as unknown as AppContext;
    const { DataLoaderManager } = await import('@/app/data-loader');
    const manager = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined }) as unknown as LoaderInternals;
    manager.init();
    cleanups.push(() => manager.destroy());
    return {
      manager,
      map,
      moveTo: (at: { lat: number; lon: number }) => { bbox = `${at.lon - 0.1},${at.lat - 0.1},${at.lon + 0.1},${at.lat + 0.1}`; },
    };
  }

  it('holds the webcam and imagery footprint requests while the lookup is open', async () => {
    const { manager } = await loader();
    setOrbitalLookupOpen(true);

    await manager.loadWebcams();
    manager.loadImageryFootprints();
    await settle(5000);

    expect(viewportRequests()).toEqual([]);
  });

  it('reloads webcams for the current view when the lookup closes', async () => {
    const { manager, map, moveTo } = await loader();
    setOrbitalLookupOpen(true);
    await manager.loadWebcams();
    await settle(2000);

    moveTo(AFTER);
    setOrbitalLookupOpen(false);
    await settle(2000);

    const webcams = viewportRequests('list-webcams');
    expect(webcams).toHaveLength(1);
    expect(webcams[0]).toContain(String(AFTER.lat - 0.1).slice(0, 6));
    expect(webcams[0]).not.toContain(String(POINT.lat - 0.1).slice(0, 6));
    expect(map.setWebcams).toHaveBeenCalled();
  });

  it('loads webcams and imagery footprints for the view while no lookup is open', async () => {
    const { manager } = await loader();
    await manager.loadWebcams();
    manager.loadImageryFootprints();
    await settle(1000);

    expect(viewportRequests('list-webcams')).toHaveLength(1);
    expect(viewportRequests('/api/imagery/v1/search-imagery')).toHaveLength(1);
  });
});
