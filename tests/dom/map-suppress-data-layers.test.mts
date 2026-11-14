import { describe, expect, it, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';

const SAVED = { conflicts: true, hotspots: true, fires: false } as Record<string, boolean>;

function svgMap() {
  let layers = { ...SAVED };
  return {
    setLayers: vi.fn((next: Record<string, boolean>) => { layers = { ...next }; }),
    getState: () => ({ layers, zoom: 4, view: 'global' }),
    drawn: () => layers,
  };
}

function container(svg: ReturnType<typeof svgMap>) {
  const map = Object.assign(Object.create(MapContainer.prototype), {
    useDeckGL: false, useGlobe: false, svgMap: svg, initialState: { layers: { ...SAVED } }, suppressedLayers: null,
    emergencyLayer: { setEnabled: vi.fn() }, notamAirspaceLayer: { setEnabled: vi.fn() },
  });
  vi.spyOn(map, 'renderUkmtoStatus').mockImplementation(() => {});
  return map;
}

describe('MapContainer.suppressDataLayers', () => {
  it('draws no data layer while suppressed and restores the exact layers, never reporting the hidden state', () => {
    localStorage.setItem('worldmonitor-layers', JSON.stringify(SAVED));
    const svg = svgMap();
    const map = container(svg);

    map.suppressDataLayers(true);
    expect(svg.drawn()).toEqual({ conflicts: false, hotspots: false, fires: false });
    expect(map.getState().layers, 'the share URL and saved toggles read the real layers').toEqual(SAVED);
    expect(map.emergencyLayer.setEnabled).toHaveBeenLastCalledWith(false);

    map.suppressDataLayers(true);
    expect(svg.setLayers).toHaveBeenCalledTimes(1);

    map.suppressDataLayers(false);
    expect(svg.drawn()).toEqual(SAVED);
    expect(map.getState().layers).toEqual(SAVED);
    expect(localStorage.getItem('worldmonitor-layers')).toBe(JSON.stringify(SAVED));
  });

  it('applies a layer change made while suppressed when the layers come back', () => {
    const svg = svgMap();
    const map = container(svg);
    map.suppressDataLayers(true);
    map.setLayers({ ...SAVED, fires: true }, { bypassEntitlementSanitization: true });
    expect(svg.drawn().fires, 'nothing is drawn while suppressed').toBe(false);
    expect(map.getState().layers.fires).toBe(true);
    map.suppressDataLayers(false);
    expect(svg.drawn()).toEqual({ ...SAVED, fires: true });
  });
});
