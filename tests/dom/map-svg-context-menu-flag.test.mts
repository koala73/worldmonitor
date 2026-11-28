import { afterEach, describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ ORBITAL_WATCH_ENABLED: false }));
vi.mock('@/config/orbital-watch-flag', () => flag);

import { MapContainer } from '@/components/MapContainer';

function svgContainer() {
  const svg = { setOnMapContextMenu: vi.fn() };
  const map = Object.assign(Object.create(MapContainer.prototype), { useDeckGL: false, useGlobe: false, svgMap: svg }) as MapContainer;
  return { map, svg };
}

afterEach(() => {
  flag.ORBITAL_WATCH_ENABLED = false;
});

describe('SVG flat map context menu while the point lookup is dark', () => {
  it('leaves the SVG map without a context menu when the lookup is off', () => {
    const { map, svg } = svgContainer();
    map.onMapContextMenu(() => {});
    expect(svg.setOnMapContextMenu).not.toHaveBeenCalled();
  });

  it('gives the SVG map its context menu when the lookup is on', () => {
    flag.ORBITAL_WATCH_ENABLED = true;
    const { map, svg } = svgContainer();
    const callback = () => {};
    map.onMapContextMenu(callback);
    expect(svg.setOnMapContextMenu).toHaveBeenCalledExactlyOnceWith(callback);
  });
});
