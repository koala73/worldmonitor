import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/orbital/pass-client', () => ({
  getOrbitalPassClient: () => ({ lookup: () => new Promise(() => {}) }),
}));

import { isMapUrlCentreClaimed, setOrbitalMapView } from '@/app/orbital-map-focus';
import { leaveOrbitalFullView, openOrbitalWatch } from '@/app/orbital-watch';

const PALM = { lat: 25.112, lon: 55.139 };
const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
const frames = (n = 20) => new Promise<void>((done) => {
  const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
  step(n);
});

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('orbital watch map focus', () => {
  it('centres the point in the map area the sheet leaves visible and keeps the reticle on it', async () => {
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('ow-panel') ? rect(988, 64, 440, 824) : original.call(this);
    });
    const center = vi.fn(() => true);
    const project = vi.fn(() => ({ x: 494, y: 450 }));
    let mapRect = rect(0, 0, 1440, 900);
    const hold = vi.fn();
    const release = setOrbitalMapView({ rect: () => mapRect, center, project, hold, suppressLayers: vi.fn() });
    try {
      openOrbitalWatch(PALM, null);
      await frames(40);
      expect(center).toHaveBeenCalledWith(PALM, { x: -226, y: 0 });
      expect(hold, 'the idle globe spin would carry the point away').toHaveBeenLastCalledWith(true);
      const mark = document.querySelector<HTMLElement>('.ow-mapmark')!;
      expect(mark.hidden).toBe(false);
      expect(mark.style.transform).toBe('translate(494px, 450px)');

      project.mockReturnValue({ x: 1200, y: 450 });
      await frames();
      expect(mark.hidden, 'a point under the panel is not marked').toBe(true);
      expect(center, 'a map the user moved after landing is left where it is').toHaveBeenCalledTimes(1);

      mapRect = rect(0, 0, 1600, 1000);
      await frames();
      expect(center, 'a resized map is centred again').toHaveBeenNthCalledWith(2, PALM, { x: -306, y: 0 });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(hold, 'closing lets the globe spin again').toHaveBeenLastCalledWith(false);
    } finally {
      release();
    }
  });

  it('keeps trying to centre until a booting map can move', async () => {
    let ready = false;
    const center = vi.fn(() => ready);
    const release = setOrbitalMapView({ rect: () => rect(0, 0, 1440, 900), center, project: () => null, hold: vi.fn(), suppressLayers: vi.fn() });
    try {
      openOrbitalWatch(PALM, null);
      await frames();
      const tries = center.mock.calls.length;
      expect(tries, 'a refused centre is retried, not taken as done').toBeGreaterThan(1);
      ready = true;
      await frames();
      const settled = center.mock.calls.length;
      await frames();
      expect(center, 'a landed centre is not repeated').toHaveBeenCalledTimes(settled);
    } finally {
      release();
    }
  });

  it('keeps the picked point out of the page URL until the user moves the map', () => {
    const map = document.createElement('div');
    map.id = 'mapContainer';
    const outside = document.createElement('button');
    document.body.append(map, outside);
    expect(isMapUrlCentreClaimed()).toBe(false);
    openOrbitalWatch(PALM, null);
    expect(isMapUrlCentreClaimed()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.orbital-watch-sheet')).toBeNull();
    expect(isMapUrlCentreClaimed()).toBe(true);
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(isMapUrlCentreClaimed()).toBe(true);
    map.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(isMapUrlCentreClaimed()).toBe(false);
  });

  it('claims the URL centre again when a new lookup opens before the user moves the map', () => {
    const map = document.createElement('div');
    map.id = 'mapContainer';
    document.body.append(map);
    openOrbitalWatch(PALM, null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    openOrbitalWatch({ lat: 25.003, lon: 54.99 }, null);
    map.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(isMapUrlCentreClaimed()).toBe(true);
  });

  it('hides the dashboard layers only while the full view owns the map', () => {
    const suppressLayers = vi.fn();
    const release = setOrbitalMapView({ rect: () => rect(0, 0, 1440, 900), center: () => true, project: () => null, hold: vi.fn(), suppressLayers });
    try {
      openOrbitalWatch(PALM, null);
      expect(suppressLayers, 'the sheet leaves the dashboard layers alone').not.toHaveBeenCalledWith(true);
      openOrbitalWatch(PALM, null, 'full');
      expect(suppressLayers).toHaveBeenLastCalledWith(true);
      leaveOrbitalFullView();
      expect(suppressLayers).toHaveBeenLastCalledWith(false);
      openOrbitalWatch(PALM, null, 'full');
      expect(suppressLayers).toHaveBeenLastCalledWith(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(document.querySelector('.orbital-watch-sheet')).toBeNull();
      expect(suppressLayers, 'closing from the full view brings the layers back').toHaveBeenLastCalledWith(false);
    } finally {
      release();
    }
  });
});
