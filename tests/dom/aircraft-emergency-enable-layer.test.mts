import { describe, expect, it, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';

describe('programmatic aircraft emergency enable', () => {
  it('goes through the renderer so its layer-change listener persists the layer, then starts the feed', () => {
    const layers: Record<string, boolean> = {};
    const svg = {
      enableLayer: vi.fn((layer: string) => { layers[layer] = true; }),
      getState: () => ({ layers }),
    };
    const emergencyLayer = { setEnabled: vi.fn() };
    const map = Object.assign(Object.create(MapContainer.prototype), {
      useDeckGL: false, useGlobe: false, svgMap: svg, emergencyLayer, initialState: { layers: {} },
    });
    map.enableLayer('aircraftEmergencies');
    expect(svg.enableLayer).toHaveBeenCalledExactlyOnceWith('aircraftEmergencies');
    expect(emergencyLayer.setEnabled).toHaveBeenLastCalledWith(true);
    expect(map.initialState.layers.aircraftEmergencies).toBe(true);
  });
});
