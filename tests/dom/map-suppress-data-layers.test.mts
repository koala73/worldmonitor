import { describe, expect, it, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';

const SAVED = { conflicts: true, hotspots: true, fires: false } as Record<string, boolean>;

function svgMap() {
  let layers = { ...SAVED };
  let notify: ((layer: string, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;
  return {
    setLayers: vi.fn((next: Record<string, boolean>) => { layers = { ...next }; }),
    getState: () => ({ layers, zoom: 4, view: 'global' }),
    setOnLayerChange: (callback: typeof notify) => { notify = callback; },
    enableLayer: vi.fn(),
    drawn: () => layers,
    /** The user flipping a toggle on the map's own layer panel. */
    toggle(layer: string, enabled: boolean) {
      layers = { ...layers, [layer]: enabled };
      notify?.(layer, enabled, 'user');
    },
  };
}

function container(svg: ReturnType<typeof svgMap> | null) {
  const map = Object.assign(Object.create(MapContainer.prototype), {
    useDeckGL: false, useGlobe: false, svgMap: svg, initialState: { layers: { ...SAVED } }, suppressedLayers: null,
    emergencyLayer: { setEnabled: vi.fn() }, notamAirspaceLayer: { setEnabled: vi.fn() },
    layerLoadingState: new Map(), layerReadyState: new Map(), hiddenLayerToggles: new Set(), cachedNotamAirspace: [],
    cachedOnLayerChange: null,
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

  it('starts a renderer built while the layers are hidden with nothing drawn, as on a cold full-view link', () => {
    const map = container(null);
    map.suppressDataLayers(true);
    const svg = svgMap();
    map.svgMap = svg;
    map.rehydrateActiveMap();
    expect(svg.drawn()).toEqual({ conflicts: false, hotspots: false, fires: false });
    expect(map.getState().layers).toEqual(SAVED);
    map.suppressDataLayers(false);
    expect(svg.drawn()).toEqual(SAVED);
  });

  it('keeps a toggle the user flips while suppressed, saving it and drawing it on return', () => {
    const svg = svgMap();
    const map = container(svg);
    const saved = vi.fn();
    map.setOnLayerChange(saved);
    map.suppressDataLayers(true);
    svg.toggle('fires', true);
    expect(saved).toHaveBeenCalledWith('fires', true, 'user');
    expect(svg.drawn().fires, 'the toggled layer stays hidden in the full view').toBe(false);
    expect(map.getState().layers.fires).toBe(true);
    map.suppressDataLayers(false);
    expect(svg.drawn()).toEqual({ ...SAVED, fires: true });
  });

  it('saves a layer enabled while suppressed without drawing it until the layers come back', () => {
    const svg = svgMap();
    const map = container(svg);
    const saved = vi.fn();
    map.setOnLayerChange(saved);
    map.suppressDataLayers(true);
    map.enableLayer('fires');
    expect(svg.enableLayer).not.toHaveBeenCalled();
    expect(svg.drawn().fires).toBe(false);
    expect(saved).toHaveBeenCalledWith('fires', true, 'programmatic');
    expect(map.notamAirspaceLayer.setEnabled).not.toHaveBeenCalledWith(true);
    map.suppressDataLayers(false);
    expect(svg.drawn()).toEqual({ ...SAVED, fires: true });
  });
});
