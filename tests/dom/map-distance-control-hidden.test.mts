/**
 * #10472: CSS hides the distance control on the short mobile map strip. A
 * hidden control must drop out of measuring, or canvas clicks keep being
 * captured and markers cannot open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  t: (key: string) => key,
  getLocale: () => 'en',
  I18N_RESOURCES_LOADED_EVENT: 'i18n-loaded',
}));
vi.mock('maplibre-gl', () => ({
  ScaleControl: class {
    setUnit() {}
    onAdd() { return document.createElement('div'); }
    onRemove() {}
  },
}));

import { MapDistanceControl } from '@/components/map-distance-control';

let fire: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) { fire = cb; }
  observe() {}
  disconnect() {}
}

afterEach(() => { fire = null; vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('MapDistanceControl visibility', () => {
  it('stops measuring when the control stops being rendered', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const container = document.createElement('div');
    document.body.append(container);
    const canvas = document.createElement('canvas');
    const map = { on() {}, off() {}, getCanvas: () => canvas, getCenter: () => ({ lng: 0, lat: 0 }) };
    new MapDistanceControl(map as never, container, () => {});

    const root = container.querySelector<HTMLElement>('.map-distance-control')!;
    container.querySelector<HTMLButtonElement>('.map-distance-toggle')!.click();
    expect(container.classList.contains('map-measuring')).toBe(true);

    // jsdom has no layout: model "rendered" vs display:none through getClientRects.
    let rendered = true;
    root.getClientRects = () => (rendered ? [{}] : []) as unknown as DOMRectList;
    fire!();
    expect(container.classList.contains('map-measuring')).toBe(true);

    rendered = false;
    fire!();
    expect(container.classList.contains('map-measuring')).toBe(false);
  });
});
