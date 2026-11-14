import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/country-geometry', () => ({
  getCountryAtCoordinates: vi.fn(() => ({ code: 'AE', name: 'United Arab Emirates' })),
  getCountryBbox: vi.fn(),
}));

import { MapComponent, type MapContextMenuPayload } from '@/components/Map';

const controllers: AbortController[] = [];

function createMap() {
  const container = document.createElement('div');
  document.body.append(container);
  const listenerAbort = new AbortController();
  controllers.push(listenerAbort);
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 800, 400));
  Object.defineProperty(container, 'clientWidth', { get: () => 800 });
  Object.defineProperty(container, 'clientHeight', { get: () => 400 });
  const invert = vi.fn((xy: [number, number]) => [xy[0] / 10, xy[1] / 10] as [number, number]);
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container,
    listenerAbort,
    state: { zoom: 1, pan: { x: 0, y: 0 } },
    getProjection: () => ({ invert }),
  }) as MapComponent;
  (map as unknown as { setupZoomHandlers: () => void }).setupZoomHandlers();
  const menus: MapContextMenuPayload[] = [];
  map.setOnMapContextMenu((payload) => menus.push(payload));
  return { container, menus, invert };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('SVG flat map point lookup entry', () => {
  it('opens the map context menu for the point under a right-click, with its country', () => {
    const { container, menus, invert } = createMap();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 650, clientY: 300 });
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(invert).toHaveBeenCalledWith([550, 250]);
    expect(menus).toEqual([{ lat: 25, lon: 55, screenX: 650, screenY: 300, countryCode: 'AE', countryName: 'United Arab Emirates' }]);
  });

  it('opens the same menu from a touch long-press, as phones get the SVG map in 2D', () => {
    vi.useFakeTimers();
    const { container, menus } = createMap();
    container.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 650, clientY: 300, bubbles: true }));
    vi.advanceTimersByTime(700);
    expect(menus).toHaveLength(1);
    expect([menus[0]!.lat, menus[0]!.lon]).toEqual([25, 55]);
  });

  it('leaves a right-click on a map control to the browser', () => {
    const { container, menus } = createMap();
    container.innerHTML = '<div class="map-controls"><button>Zoom</button></div>';
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 650, clientY: 300 });
    container.querySelector('button')!.dispatchEvent(event);
    expect(menus).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening once the map tears down its handlers', () => {
    const { container, menus } = createMap();
    controllers.splice(0).forEach((controller) => controller.abort());
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 650, clientY: 300 }));
    expect(menus).toEqual([]);
  });
});
