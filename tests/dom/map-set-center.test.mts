import { describe, expect, it, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => true,
}));

describe('MapContainer.setCenter', () => {
  it.each([
    ['deck.gl', { useDeckGL: true, useGlobe: false }, 'deckGLMap'],
    ['the globe', { useDeckGL: false, useGlobe: true }, 'globeMap'],
  ] as const)('jumps with no animation on %s when asked for an instant move', (_name, flags, renderer) => {
    const setCenter = vi.fn();
    const map = Object.assign(Object.create(MapContainer.prototype), {
      ...flags, [renderer]: { setCenter }, rendererReady: true, viewportActionToken: 0,
    });
    vi.spyOn(map, 'hasActiveRenderer').mockReturnValue(true);
    map.setCenter(25, 55, 9);
    expect(setCenter).toHaveBeenLastCalledWith(25, 55, 9);
    map.setCenter(25, 55, 9, { instant: true });
    expect(setCenter).toHaveBeenLastCalledWith(25, 55, 9, 0);
  });
});
