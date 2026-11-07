import type { GeoProjection } from 'd3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type CenterMap = {
  pendingCenter: { lat: number; lon: number } | null;
  wrapper: HTMLDivElement;
  boundVisibilityHandler: () => void;
  state: { zoom: number; pan: { x: number; y: number } };
  getProjection: (width: number, height: number) => GeoProjection;
  setupResizeObserver: () => void;
  setIsResizing: (value: boolean) => void;
  resize: () => void;
  setCenter: (lat: number, lon: number) => void;
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
});
