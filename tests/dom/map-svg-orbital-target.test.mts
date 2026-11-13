import * as d3 from 'd3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type TargetMap = {
  renderOrbitalTarget: (projection: d3.GeoProjection) => void;
};

const PIN_X = 190;

afterEach(() => vi.restoreAllMocks());

/** jsdom has no layout: a label's box is its rect's x/width offset from the pin's screen position. */
function stubLayout(mapWidth: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rect = this.querySelector?.('rect');
    if (this.tagName.toLowerCase() === 'g' && rect) {
      const left = PIN_X + Number(rect.getAttribute('x'));
      const width = Number(rect.getAttribute('width'));
      return { left, right: left + width, width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return { left: 0, right: mapWidth, width: mapWidth, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: mapWidth });
}

function renderTarget(lines: string[]): SVGGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.append(svg);
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container: document.createElement('div'),
    dynamicLayerGroup: d3.select(svg).append('g'),
    state: { zoom: 1, pan: { x: 0, y: 0 } },
    orbitalTarget: { lat: 25.112, lon: 55.139, lines },
  }) as TargetMap;
  map.renderOrbitalTarget((() => [PIN_X, 120]) as unknown as d3.GeoProjection);
  return svg.querySelector('.orbital-target') as SVGGElement;
}

const tspans = (reticle: SVGGElement) => [...reticle.querySelectorAll('tspan')].map((node) => node.textContent);
const LINES = ['25.1120°N 55.1390°E', 'ACQUIRED Sun, 8 Nov · 07:01 UTC · 10 M'];

describe('orbital target tag on the SVG map', () => {
  it('sits right of the reticle when the map has room', () => {
    stubLayout(1440);
    const reticle = renderTarget(LINES);
    expect(reticle.querySelectorAll('rect')).toHaveLength(1);
    expect(Number(reticle.querySelector('rect')?.getAttribute('x'))).toBeGreaterThan(0);
    expect(tspans(reticle)).toEqual(LINES);
  });

  it('keeps its two lines and moves under the reticle on a phone-width map', () => {
    stubLayout(390);
    const reticle = renderTarget(LINES);
    expect(reticle.querySelectorAll('rect')).toHaveLength(1);
    const rect = reticle.querySelector('rect')!;
    expect(Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2, 'centred on the reticle').toBe(0);
    expect(reticle.querySelector('g')?.getAttribute('transform')).toMatch(/^translate\(0,\d+\)$/);
    expect(tspans(reticle)).toEqual(LINES);
  });

  it('wraps at its breaks only when even the tag under the reticle does not fit', () => {
    stubLayout(300);
    const reticle = renderTarget(LINES);
    expect(reticle.querySelectorAll('rect')).toHaveLength(1);
    expect(tspans(reticle)).toEqual(['25.1120°N 55.1390°E', 'ACQUIRED Sun, 8 Nov', '07:01 UTC · 10 M']);
  });
});
