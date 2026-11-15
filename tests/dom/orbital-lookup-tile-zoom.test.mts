/**
 * The satellite pass lookup centres the map on the looked-up point, and the
 * point must never reach a WorldMonitor host (#10704). The basemap is PMTiles
 * on one: a tile request names the tile that holds the viewport, which at zoom
 * 11 is 0.18 degrees wide. So while the lookup is open the map must not zoom
 * past 7, where a tile is 2.8 degrees wide, however the lookup was opened and
 * however the user zooms; once it closes the old camera comes back unclamped.
 *
 * The real CountryIntelManager registers the map view, the real orbital-watch
 * module drives it, and a real DeckGLMap sits behind a MapContainer. maplibre
 * is a fake that clamps zoom to its max zoom the way maplibre does.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

type Handler = (event?: unknown) => void;
type Camera = { lat?: number; lon?: number; center?: [number, number]; zoom?: number; duration?: number };

const { FakeMap, fakeMaps } = vi.hoisted(() => {
  const DEFAULT_MAX_ZOOM = 22;
  class FakeMap {
    handlers = new Map<string, Handler[]>();
    center: { lng: number; lat: number };
    zoom: number;
    maxZoom = DEFAULT_MAX_ZOOM;
    /** Every zoom the camera has held since the last reset, so a clamp that happens after a frame still counts. */
    zoomLog: number[] = [];
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

    private holdZoom(zoom: number): void {
      this.zoom = Math.min(zoom, this.maxZoom);
      this.zoomLog.push(this.zoom);
    }
    /** maplibre clamps a flight's zoom to its max zoom and ends a zero-length one in the same call. */
    flyTo(options: Camera & { center: [number, number] }): this {
      this.center = { lng: options.center[0], lat: options.center[1] };
      if (options.zoom !== undefined) this.holdZoom(options.zoom);
      this.emit('moveend', {});
      return this;
    }
    setMaxZoom(max?: number | null): this {
      this.maxZoom = max ?? DEFAULT_MAX_ZOOM;
      if (this.zoom > this.maxZoom) this.holdZoom(this.maxZoom);
      return this;
    }
    getMaxZoom(): number { return this.maxZoom; }
    setZoom(zoom: number): this { this.holdZoom(zoom); return this; }
    zoomIn(): this { this.holdZoom(this.zoom + 1); return this; }
    zoomOut(): this { this.holdZoom(this.zoom - 1); return this; }

    getCanvas(): HTMLCanvasElement { return this.canvas; }
    getContainer(): HTMLElement { return this.canvas.parentElement ?? document.createElement('div'); }
    getCenter(): { lng: number; lat: number } { return { ...this.center }; }
    getZoom(): number { return this.zoom; }
    getBearing(): number { return 0; }
    getPitch(): number { return 0; }
    isMoving(): boolean { return false; }
    easeTo(): this { return this; }
    jumpTo(): this { return this; }
    setCenter(center: [number, number]): this { this.center = { lng: center[0], lat: center[1] }; return this; }
    fitBounds(): this { return this; }
    getBounds() {
      const { lat, lng } = this.center;
      const r = 0.1;
      return {
        getWest: () => lng - r, getSouth: () => lat - r, getEast: () => lng + r, getNorth: () => lat + r,
        getSouthWest: () => ({ lat: lat - r, lng: lng - r }), getNorthEast: () => ({ lat: lat + r, lng: lng + r }),
      };
    }
    project(): { x: number; y: number } { return { x: 720, y: 450 }; }
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
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
// The lookup's own requests are not what this test watches; they never answer.
vi.mock('@/services/orbital/pass-client', () => ({ getOrbitalPassClient: () => ({ lookup: () => new Promise(() => {}), dispose: () => {} }) }));
vi.mock('@/services/orbital/match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/match')>()),
  findArchiveEvidence: () => new Promise(() => {}),
}));
vi.mock('@/services/orbital/point-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/point-context')>()),
  loadPointContext: () => new Promise(() => {}),
}));

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import { openOrbitalShareLink } from '@/app/orbital-watch';
import { MapContainer } from '@/components/MapContainer';
import { DeckGLMap } from '@/components/DeckGLMap';
import { dismissMapContextMenu } from '@/components/MapContextMenu';
import { connectOrbitalLookupMap } from '@/services/orbital/lookup-host';

/** Dubai, the looked-up point. */
const POINT = { lat: 25.2048, lon: 55.2708 };
/** The camera before the lookup: zoomed in on Paris, past the cap. */
const BEFORE = { lat: 48.8566, lon: 2.3522, zoom: 9 };
/** The deepest zoom whose tile is wider than AE8's 0.1 degree box. */
const MAX_LOOKUP_ZOOM = 7;
/** Width in degrees of one tile at a zoom. */
const tileDegrees = (zoom: number) => 360 / 2 ** Math.floor(zoom);

type ContextMenuPayload = { lat: number; lon: number; screenX: number; screenY: number };

let menuHandler: ((payload: ContextMenuPayload) => void) | null = null;
const cleanups: (() => void)[] = [];

async function settle(ms = 500): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  }
}

/** A dashboard map: the real DeckGLMap behind the real MapContainer methods, with the real view registered by CountryIntelManager. */
async function dashboard(options: { hash?: string } = {}) {
  history.replaceState(null, '', `/dashboard${options.hash ?? ''}`);
  const mapEl = document.createElement('div');
  mapEl.id = 'mapContainer';
  mapEl.getBoundingClientRect = () => new DOMRect(0, 0, 1440, 900);
  document.body.append(mapEl);

  const deck = new DeckGLMap(mapEl, {
    zoom: BEFORE.zoom, pan: { x: 0, y: 0 }, view: 'global', timeRange: '24h', layers: {} as never,
  }, { chrome: false });
  cleanups.push(() => deck.destroy());
  await deck.whenReady();
  const fake = fakeMaps[fakeMaps.length - 1]!;
  fake.emit('load');
  fake.center = { lat: BEFORE.lat, lng: BEFORE.lon };
  fake.zoom = BEFORE.zoom;

  const map = Object.assign(Object.create(MapContainer.prototype), {
    container: mapEl,
    useGlobe: false,
    useDeckGL: true,
    deckGLMap: deck,
    svgMap: null,
    globeMap: null,
    rendererReady: true,
    viewportActionToken: 0,
    pendingViewportActions: [],
    initialState: { zoom: BEFORE.zoom, layers: {} },
    suppressedLayers: null,
    autoRotateHeld: false,
    zoomCap: null,
    emergencyLayer: { setEnabled: () => {} },
    notamAirspaceLayer: { setEnabled: () => {} },
    cachedNotamAirspace: [],
    renderUkmtoStatus: () => {},
    onCountryClicked: () => {},
    onMapContextMenu: (cb: (payload: ContextMenuPayload) => void) => { menuHandler = cb; },
  }) as MapContainer;
  Object.assign(map, { getState: () => deck.getState() });

  const manager = new CountryIntelManager({ map, isDestroyed: false } as unknown as AppContext);
  connectOrbitalLookupMap(() => ({ getCenter: () => deck.getCenter() }));
  await manager.init();
  cleanups.push(() => manager.destroy());

  fake.zoomLog.length = 0;
  return { fake, deck, map };
}

const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label);
const closeLookup = () => document.querySelector<HTMLButtonElement>('.ies-close')!.click();

async function openFromContextMenu(): Promise<void> {
  menuHandler!({ ...POINT, screenX: 10, screenY: 10 });
  menuItem('Satellite passes here')!.click();
  await settle();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  fakeMaps.length = 0;
  menuHandler = null;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ places: [], error: '' })));
});

afterEach(() => {
  if (document.querySelector('.ies-close')) closeLookup();
  dismissMapContextMenu();
  for (const cleanup of cleanups.splice(0)) cleanup();
  connectOrbitalLookupMap(() => null);
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the map while the satellite pass lookup is open', () => {
  const ways: [string, () => Promise<void>, { hash?: string }][] = [
    ['the map context menu', async () => { await openFromContextMenu(); }, {}],
    ['a share link', async () => {
      openOrbitalShareLink({ point: POINT, pass: null, view: 'sheet' }, document.getElementById('mapContainer'), null);
      await settle();
    }, {}],
    ['a #orbital= route in the page URL at load', async () => { await settle(); }, { hash: `#orbital=${POINT.lat},${POINT.lon}` }],
    ['a #orbital=...&view=full route in the page URL at load', async () => { await settle(); }, { hash: `#orbital=${POINT.lat},${POINT.lon}&view=full` }],
    ['a #orbital= route followed in the same tab', async () => {
      window.location.hash = `#orbital=${POINT.lat},${POINT.lon}`;
      await settle();
    }, {}],
  ];

  it.each(ways)('never zooms past 7, and a tile there is wider than the 0.1 degree leak box, when opened from %s', async (_way, open, options) => {
    const { fake } = await dashboard(options);
    await open();

    expect(document.querySelector('.imagery-evidence-sheet')).not.toBeNull();
    expect(fake.zoomLog.length, 'the lookup moved the map').toBeGreaterThan(0);
    expect(Math.max(...fake.zoomLog)).toBeLessThanOrEqual(MAX_LOOKUP_ZOOM);
    expect(fake.getZoom()).toBeLessThanOrEqual(MAX_LOOKUP_ZOOM);
    expect(tileDegrees(fake.getZoom())).toBeGreaterThan(0.2);
  });

  it('holds the map at zoom 7 against every way the user can zoom in', async () => {
    const { fake, deck } = await dashboard();
    await openFromContextMenu();

    for (let i = 0; i < 6; i += 1) deck.zoomIn();
    fake.setZoom(12);
    deck.setZoom(12);
    deck.setCenter(POINT.lat, POINT.lon, 14);
    await settle();

    expect(fake.zoomLog.every((zoom) => zoom <= MAX_LOOKUP_ZOOM)).toBe(true);
    expect(fake.getZoom()).toBe(MAX_LOOKUP_ZOOM);
    expect(fake.getMaxZoom()).toBe(MAX_LOOKUP_ZOOM);
  });

  it('lifts the cap on close and returns to the camera from before, past the cap, with no point in it', async () => {
    const { fake } = await dashboard();
    await openFromContextMenu();
    expect(fake.getZoom()).toBeLessThanOrEqual(MAX_LOOKUP_ZOOM);

    closeLookup();
    await settle();

    expect(fake.getMaxZoom(), 'the map has its own max zoom back').toBe(22);
    expect(fake.getZoom()).toBe(BEFORE.zoom);
    expect(fake.getCenter().lat).toBeCloseTo(BEFORE.lat, 6);
    expect(fake.getCenter().lng).toBeCloseTo(BEFORE.lon, 6);
  });

  it('caps a map whose basemap is built after the lookup opened, as on a cold link', async () => {
    const mapEl = document.createElement('div');
    document.body.append(mapEl);
    const deck = new DeckGLMap(mapEl, {
      zoom: 3, pan: { x: 0, y: 0 }, view: 'global', timeRange: '24h', layers: {} as never,
    }, { chrome: false });
    cleanups.push(() => deck.destroy());
    deck.setZoomCap(MAX_LOOKUP_ZOOM);
    await deck.whenReady();

    expect(fakeMaps[fakeMaps.length - 1]!.getMaxZoom()).toBe(MAX_LOOKUP_ZOOM);
    deck.setZoomCap(null);
    expect(fakeMaps[fakeMaps.length - 1]!.getMaxZoom()).toBe(22);
  });
});
