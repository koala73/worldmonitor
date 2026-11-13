import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/orbital/pass-client', () => ({
  getOrbitalPassClient: () => ({ lookup: () => new Promise(() => {}) }),
}));

import { setOrbitalMapView } from '@/app/orbital-map-focus';
import { openOrbitalWatch } from '@/app/orbital-watch';

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
    const release = setOrbitalMapView({ rect: () => mapRect, center, project, hold });
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
    const release = setOrbitalMapView({ rect: () => rect(0, 0, 1440, 900), center, project: () => null, hold: vi.fn() });
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
});
