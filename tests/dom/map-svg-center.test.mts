import type { GeoProjection } from 'd3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type CenterMap = {
  container: HTMLDivElement;
  pendingCenter: { lat: number; lon: number } | null;
  wrapper: HTMLDivElement;
  boundVisibilityHandler: () => void;
  state: { zoom: number; pan: { x: number; y: number } };
  getProjection: (width: number, height: number) => GeoProjection;
  setupResizeObserver: () => void;
  setIsResizing: (value: boolean) => void;
  resize: () => void;
  setCenter: (lat: number, lon: number) => void;
  setZoom: (zoom: number) => void;
  centerForOffset: (lat: number, lon: number, zoom: number, offset: { x: number; y: number }) => { lat: number; lon: number };
  projectToClient: (lat: number, lon: number) => { x: number; y: number } | null;
  getCenter: () => { lat: number; lon: number } | null;
  setView: (view: 'global') => void;
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals();
});

function createMap() {
  const size = { width: 0, height: 0 };
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  let notify: ResizeObserverCallback;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe() {}
  });
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container,
    wrapper: document.createElement('div'),
    naturalEventTexts: [],
    state: { zoom: 4, pan: { x: 0, y: 0 } },
    pendingCenter: null,
    lastContainerSize: { width: 0, height: 0 },
    isResizing: false,
    scheduleRender: vi.fn(),
    render: vi.fn(),
    ensureBaseLayerIntact: vi.fn(),
    overlayBudgetPlanIsStale: () => false,
    shouldUpdateLabelVisibility: () => false,
    updateZoomLayerVisibility: () => false,
    emitStateChange: vi.fn(),
  }) as CenterMap;
  map.setupResizeObserver();
  cleanup.push(() => document.removeEventListener('visibilitychange', map.boundVisibilityHandler));
  return {
    map,
    size,
    reveal() { Object.assign(size, { width: 800, height: 400 }); },
    observe() { notify([{ contentRect: { ...size } } as ResizeObserverEntry], {} as ResizeObserver); },
  };
}

function expectRenderedCenter(map: CenterMap, size: { width: number; height: number }, lat: number, lon: number) {
  expect(map.pendingCenter).toBeNull();
  const projected = map.getProjection(size.width, size.height)([lon, lat])!;
  const transform = map.wrapper.style.transform.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/)!;
  expect(transform).not.toBeNull();
  const x = Number(transform[1]);
  const y = Number(transform[2]);
  const zoom = Number(transform[3]);
  expect(projected[0] * zoom + x).toBeCloseTo(size.width / 2, 6);
  expect(projected[1] * zoom + y).toBeCloseTo(size.height / 2, 6);
  expect(map.getCenter()?.lat).toBeCloseTo(lat, 6);
  expect(map.getCenter()?.lon).toBeCloseTo(lon, 6);
}

describe('SVG map centers requested while hidden', () => {
  it('applies the center on the first visible observer notification', () => {
    const { map, size, reveal, observe } = createMap();
    map.setCenter(48.86, 2.35);
    reveal();
    observe();
    expectRenderedCenter(map, size, 48.86, 2.35);
  });

  it('applies the center when resizing ends after a suppressed reveal notification', () => {
    const { map, size, reveal, observe } = createMap();
    map.setIsResizing(true);
    map.setCenter(48.86, 2.35);
    reveal();
    observe();
    map.setIsResizing(false);
    expectRenderedCenter(map, size, 48.86, 2.35);
  });

  it('retains the latest hidden request until an explicit visible resize', () => {
    const { map, size, reveal } = createMap();
    map.setCenter(48.86, 2.35);
    map.resize();
    map.setCenter(0, 0);
    map.resize();
    expect(map.getCenter()).toEqual({ lat: 0, lon: 0 });
    reveal();
    map.resize();
    expectRenderedCenter(map, size, 0, 0);
  });

  it('discards the hidden request when a region preset replaces it', () => {
    const { map, reveal } = createMap();
    map.setCenter(48.86, 2.35);
    map.setView('global');
    reveal();
    map.resize();
    expect(map.pendingCenter).toBeNull();
    expect(map.state.pan).toEqual({ x: 0, y: 0 });
  });

  it('draws a point at a screen offset from the centre, where the reticle projects it', () => {
    const { map, size, reveal } = createMap();
    reveal();
    map.container.getBoundingClientRect = () => new DOMRect(10, 20, size.width, size.height);
    const offset = { x: -120, y: -60 };
    const centre = map.centerForOffset(25.112, 55.139, 11, offset);
    map.setCenter(centre.lat, centre.lon);
    map.setZoom(11);
    const at = map.projectToClient(25.112, 55.139)!;
    expect(at.x).toBeCloseTo(10 + size.width / 2 + offset.x, 6);
    expect(at.y).toBeCloseTo(20 + size.height / 2 + offset.y, 6);
  });

  it('keeps the lookup point and the centre it derives out of every console call', () => {
    const METHODS = ['log', 'debug', 'info', 'warn', 'error', 'trace'] as const;
    const spies = METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    cleanup.push(() => spies.forEach((spy) => spy.mockRestore()));
    const { map, size, reveal, observe } = createMap();
    const point = { lat: 25.112, lon: 55.139 };
    map.setCenter(point.lat, point.lon);
    reveal();
    observe();
    map.container.getBoundingClientRect = () => new DOMRect(0, 0, size.width, size.height);
    const centre = map.centerForOffset(point.lat, point.lon, 11, { x: -120, y: -60 });
    map.setCenter(centre.lat, centre.lon);
    map.setZoom(11);
    map.projectToClient(point.lat, point.lon);
    const near = (value: number) => [point.lat, point.lon, centre.lat, centre.lon].some((c) => Math.abs(value - c) < 0.01);
    const carriesCoordinate = (value: unknown): boolean => {
      if (typeof value === 'number') return near(value);
      if (typeof value === 'string') return (value.match(/-?\d+\.\d+/g) ?? []).some((n) => near(Number(n)));
      if (value && typeof value === 'object') return Object.values(value).some(carriesCoordinate);
      return false;
    };
    const leaks = spies.flatMap((spy, i) => spy.mock.calls.filter((args) => args.some(carriesCoordinate)).map((args) => [METHODS[i], ...args]));
    expect(leaks).toEqual([]);
  });

  describe('base re-render at a new size', () => {
    type ResizeMap = CenterMap & {
      baseRendered: boolean;
      baseWidth: number;
      baseHeight: number;
      panBasis: { width: number; height: number } | null;
      keepCenterAcrossResize: (width: number, height: number) => void;
    };
    // The pan is pixels of the size it was set for; return the place it draws at the centre, unwrapped.
    const centredAt = (map: ResizeMap, width: number, height: number) => {
      const pxPerDegree = map.getProjection(width, height).scale() * Math.PI / 180;
      return { lon: -map.state.pan.x / pxPerDegree, lat: 8 + map.state.pan.y / pxPerDegree };
    };
    const renderedAt = (width: number, height: number) => {
      const map = createMap().map as ResizeMap;
      Object.assign(map, { baseRendered: true, baseWidth: width, baseHeight: height, panBasis: null });
      return map;
    };

    it('keeps the same place centred when the width changes', () => {
      const map = renderedAt(388, 221);
      const pos = map.getProjection(388, 221)([135, -25])!;
      map.state.pan = { x: 194 - pos[0], y: 110.5 - pos[1] };
      map.keepCenterAcrossResize(320, 221);
      expect(centredAt(map, 320, 221).lon).toBeCloseTo(135, 6);
      expect(centredAt(map, 320, 221).lat).toBeCloseTo(-25, 6);
    });

    it('does not jump a world width when the centre was panned past the antimeridian', () => {
      // Panned east of the map's edge (clampPan allows it once zoom > 1.25), then the phone URL bar changes the height.
      const map = renderedAt(388, 221);
      map.state.pan = { x: -234, y: 0 };
      const before = centredAt(map, 388, 221);
      expect(before.lon).toBeGreaterThan(180);
      map.keepCenterAcrossResize(388, 180);
      expect(centredAt(map, 388, 180).lon).toBeCloseTo(before.lon, 6);
      expect(map.state.pan.x).toBeCloseTo(-234, 6);
    });

    it('rescales the pan when the base was invalidated (theme change, topology load) before the resize render', () => {
      const map = renderedAt(388, 221);
      map.baseRendered = false;
      const pos = map.getProjection(388, 221)([105, 35])!;
      map.state.pan = { x: 194 - pos[0], y: 110.5 - pos[1] };
      map.keepCenterAcrossResize(320, 221);
      expect(centredAt(map, 320, 221).lon).toBeCloseTo(105, 6);
      expect(centredAt(map, 320, 221).lat).toBeCloseTo(35, 6);
    });
  });

  it('keeps a point near the antimeridian in the drawn world when the offset would push the centre past it', () => {
    const { map, size, reveal } = createMap();
    reveal();
    map.container.getBoundingClientRect = () => new DOMRect(0, 0, size.width, size.height);
    const centre = map.centerForOffset(10, 179, 1, { x: -200, y: 0 });
    expect(centre.lon).toBeGreaterThan(179);
    expect(centre.lon).toBeLessThanOrEqual(180);
    map.setCenter(centre.lat, centre.lon);
    map.setZoom(1);
    const at = map.projectToClient(10, 179)!;
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.x).toBeLessThan(size.width / 2);
  });
});
