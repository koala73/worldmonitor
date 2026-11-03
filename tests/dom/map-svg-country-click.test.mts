import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/country-geometry', () => ({
  getCountryAtCoordinates: vi.fn(() => ({ code: 'FR', name: 'France' })),
  getCountryBbox: vi.fn(),
}));

import { MapComponent } from '@/components/Map';
import { getCountryAtCoordinates } from '@/services/country-geometry';

const controllers: AbortController[] = [];

function createMap() {
  const container = document.createElement('div');
  document.body.append(container);
  const listenerAbort = new AbortController();
  controllers.push(listenerAbort);
  const onCountryClick = vi.fn();
  const invert = vi.fn(() => [2, 48]);
  const rect = vi.spyOn(container, 'getBoundingClientRect');
  const width = vi.fn(() => 800);
  Object.defineProperty(container, 'clientWidth', { get: width });
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container,
    listenerAbort,
    state: { zoom: 1, pan: { x: 0, y: 0 } },
    onCountryClick,
    getProjection: () => ({ invert }),
  });
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  map.setupZoomHandlers();
  return { container, onCountryClick, invert, rect, width };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  document.body.replaceChildren();
  vi.mocked(getCountryAtCoordinates).mockClear();
});

describe('SVG country click routing', () => {
  it.each([
    '<div class="time-slider"><button class="time-btn"><span>1h</span></button></div>',
    '<div class="map-controls"><span>Zoom</span></div>',
    '<div class="layer-toggles"><label><input type="checkbox"></label></div>',
    '<div class="map-legend"><span>Legend</span></div>',
    '<div class="layer-help-popup"><span>Help</span></div>',
    '<div class="layer-explanation-popup"><div class="layer-explanation-content"><span>Explanation</span></div></div>',
    '<div class="map-popup"><span>Details</span></div>',
    '<button><span>Action</span></button>',
    '<select><option>Region</option></select>',
    '<textarea>Search</textarea>',
    '<a href="#"><span>Link</span></a>',
  ])('does not read map layout or select a country for control %s', (html) => {
    const map = createMap();
    map.container.innerHTML = html;
    const target = map.container.querySelector('span, input, select, textarea')!;
    const controlAction = vi.fn();
    target.addEventListener('click', controlAction);

    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 100 }));

    expect(controlAction).toHaveBeenCalledOnce();
    expect(map.rect).not.toHaveBeenCalled();
    expect(map.width).not.toHaveBeenCalled();
    expect(map.invert).not.toHaveBeenCalled();
    expect(getCountryAtCoordinates).not.toHaveBeenCalled();
    expect(map.onCountryClick).not.toHaveBeenCalled();
  });

  it('still selects a country from a click on the map surface', () => {
    const map = createMap();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    map.container.append(svg);

    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 100 }));

    expect(map.rect).toHaveBeenCalledOnce();
    expect(map.invert).toHaveBeenCalledWith([200, 100]);
    expect(getCountryAtCoordinates).toHaveBeenCalledWith(48, 2);
    expect(map.onCountryClick).toHaveBeenCalledWith({ lat: 48, lon: 2, code: 'FR', name: 'France' });
  });
});
