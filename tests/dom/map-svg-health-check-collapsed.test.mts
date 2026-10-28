import * as d3 from 'd3';
import { describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type HealthMap = {
  runHealthCheck: () => void;
  ensureBaseLayerIntact: () => void;
  render: ReturnType<typeof vi.fn>;
};

// Phones open with the map section collapsed (display:none), so the SVG has never
// had a size to draw countries into. That is not a broken base layer.
function createMap(size: { width: number; height: number }) {
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  const svgNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const svg = d3.select(svgNode);
  const baseLayerGroup = svg.append('g').attr('class', 'map-base');
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container,
    svg,
    baseLayerGroup,
    lastContainerSize: { width: 0, height: 0 },
    countryFeatures: [{ type: 'Feature', geometry: null, properties: {} }],
    baseRendered: true,
    render: vi.fn(),
  }) as HealthMap;
  return map;
}

describe('SVG map base-layer health check', () => {
  it('skips recovery while the map is collapsed to zero size', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = createMap({ width: 0, height: 0 });

    map.runHealthCheck();
    map.ensureBaseLayerIntact();

    expect(warn).not.toHaveBeenCalled();
    expect(map.render).not.toHaveBeenCalled();
  });

  it('still recovers a visible map whose countries went missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = createMap({ width: 800, height: 400 });

    map.runHealthCheck();

    expect(warn).toHaveBeenCalledWith('[Map] Health check: Base layer missing countries, initiating recovery');
    expect(map.render).toHaveBeenCalledTimes(1);
  });
});
