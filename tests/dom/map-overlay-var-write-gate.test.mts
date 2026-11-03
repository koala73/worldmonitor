import { describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type TransformMap = {
  applyTransform: () => void;
  state: { zoom: number; pan: { x: number; y: number } };
};

describe('map overlay counter-scale writes', () => {
  it('updates scales when zoom changes and avoids redundant writes during pan or redraw', () => {
    const wrapper = document.createElement('div');
    const map = Object.assign(Object.create(MapComponent.prototype), {
      wrapper,
      state: { zoom: 2, pan: { x: 0, y: 0 } },
      getKnownContainerSize: () => ({ width: 800, height: 600 }),
      overlayBudgetPlanIsStale: () => false,
      shouldUpdateLabelVisibility: () => false,
      updateZoomLayerVisibility: () => false,
      emitStateChange: () => {},
    }) as TransformMap;
    const write = vi.spyOn(wrapper.style, 'setProperty');
    const overlayWrites = () => write.mock.calls
      .filter(([name]) => name.startsWith('--'))
      .sort(([left], [right]) => left.localeCompare(right));

    map.applyTransform();
    expect(overlayWrites()).toEqual([
      ['--label-scale', '0.75'],
      ['--marker-scale', '0.5'],
      ['--zoom', '2'],
    ]);
    expect(wrapper.style.getPropertyValue('--marker-scale')).toBe('0.5');
    write.mockClear();

    map.applyTransform();
    map.state.pan = { x: 10, y: 20 };
    map.applyTransform();
    expect(wrapper.style.transform).toBe('translate(-380px, -260px) scale(2)');
    map.state.zoom = 2.00001;
    map.applyTransform();
    expect(overlayWrites()).toEqual([]);

    map.state.zoom = 4;
    map.applyTransform();
    expect(overlayWrites()).toEqual([
      ['--label-scale', '0.375'],
      ['--marker-scale', '0.25'],
      ['--zoom', '4'],
    ]);
    expect(wrapper.style.getPropertyValue('--label-scale')).toBe('0.375');
    expect(wrapper.style.getPropertyValue('--marker-scale')).toBe('0.25');
    expect(wrapper.style.getPropertyValue('--zoom')).toBe('4');
    write.mockClear();

    map.applyTransform();
    expect(overlayWrites()).toEqual([]);
    map.state.zoom = 2;
    map.applyTransform();
    expect(wrapper.style.getPropertyValue('--zoom')).toBe('2');
    expect(overlayWrites()).toHaveLength(3);
  });
});
