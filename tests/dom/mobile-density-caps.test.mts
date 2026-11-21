// #4545: the mobile overlay density caps lived as private statics on the SVG
// renderer, so they were that renderer's caps rather than the app's. A phone
// with a saved globe preference reaches `useGlobe = true` independently of
// `isMobile` (MapContainer picks the renderer from the stored preference), and
// that path handed the full uncapped sets straight to the globe.
//
// The caps now live in one place and every renderer path applies them. These
// cases drive MapContainer's real setters with a stub renderer, so they fail
// if either branch stops capping.
import { describe, expect, it, vi } from 'vitest';

import {
  MOBILE_MAX_IRAN_EVENTS,
  MOBILE_MIN_EARTHQUAKE_MAGNITUDE,
  capEarthquakesForMobile,
  capIranEventsForMobile,
} from '@/config/map-density-caps';

type GlobeStub = { setEarthquakes: ReturnType<typeof vi.fn>; setIranEvents: ReturnType<typeof vi.fn> };

const quakes = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `q${i}`,
    magnitude: i % 2 === 0 ? 6.1 : 2.4,
    lat: 0,
    lon: 0,
    time: Date.now(),
    place: 'nowhere',
  }));

const iranEvents = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `e${i}`, lat: 0, lon: 0, timestamp: Date.now() - i }));

/** MapContainer with its renderer choice and device forced, and a stub globe. */
async function containerOnGlobe({ isMobile }: { isMobile: boolean }) {
  const { MapContainer } = await import('@/components/MapContainer');
  const host = document.body.appendChild(document.createElement('div'));
  const container = new MapContainer(host, { layers: {} } as never, true);
  const globe: GlobeStub = { setEarthquakes: vi.fn(), setIranEvents: vi.fn() };
  Object.assign(container as unknown as Record<string, unknown>, {
    useGlobe: true,
    useDeckGL: false,
    isMobile,
    globeMap: globe,
  });
  return { container, globe };
}

describe('mobile overlay density caps (#4545)', () => {
  describe('the shared caps themselves', () => {
    it('drop quakes below the magnitude floor and keep the rest', () => {
      const capped = capEarthquakesForMobile(quakes(10));
      expect(capped).toHaveLength(5);
      expect(capped.every((q) => q.magnitude >= MOBILE_MIN_EARTHQUAKE_MAGNITUDE)).toBe(true);
    });

    it('keep the newest Iran events up to the cap, in order', () => {
      const all = iranEvents(MOBILE_MAX_IRAN_EVENTS + 20);
      const capped = capIranEventsForMobile(all);
      expect(capped).toHaveLength(MOBILE_MAX_IRAN_EVENTS);
      expect(capped[0]).toBe(all[0]);
    });

    it('leave a set already under the cap untouched', () => {
      const few = iranEvents(3);
      expect(capIranEventsForMobile(few)).toEqual(few);
    });
  });

  describe('the globe path, which the SVG renderer never covered', () => {
    it('caps earthquakes on a phone', async () => {
      const { container, globe } = await containerOnGlobe({ isMobile: true });
      container.setEarthquakes(quakes(10) as never);
      const drawn = globe.setEarthquakes.mock.calls[0]![0] as Array<{ magnitude: number }>;
      expect(drawn).toHaveLength(5);
      expect(drawn.every((q) => q.magnitude >= MOBILE_MIN_EARTHQUAKE_MAGNITUDE)).toBe(true);
    });

    it('caps Iran events on a phone', async () => {
      const { container, globe } = await containerOnGlobe({ isMobile: true });
      container.setIranEvents(iranEvents(MOBILE_MAX_IRAN_EVENTS + 20) as never);
      expect(globe.setIranEvents.mock.calls[0]![0]).toHaveLength(MOBILE_MAX_IRAN_EVENTS);
    });

    it('draws everything on a desktop globe, which is not capped', async () => {
      const { container, globe } = await containerOnGlobe({ isMobile: false });
      container.setEarthquakes(quakes(10) as never);
      container.setIranEvents(iranEvents(MOBILE_MAX_IRAN_EVENTS + 20) as never);
      expect(globe.setEarthquakes.mock.calls[0]![0]).toHaveLength(10);
      expect(globe.setIranEvents.mock.calls[0]![0]).toHaveLength(MOBILE_MAX_IRAN_EVENTS + 20);
    });

    it('keeps the uncapped set cached, so switching renderer restores every marker', async () => {
      const { container, globe } = await containerOnGlobe({ isMobile: true });
      const all = quakes(10);
      container.setEarthquakes(all as never);
      expect(globe.setEarthquakes.mock.calls[0]![0]).toHaveLength(5);
      const cached = (container as unknown as { cachedEarthquakes: unknown[] }).cachedEarthquakes;
      expect(cached).toHaveLength(10);
    });
  });
});
