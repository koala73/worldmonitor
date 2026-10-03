/**
 * #4546: `tests/map-mobile-feature-caps.test.mjs` reads `Map.ts` as a string
 * and asserts with regexes. That pins the source shape, not the behaviour — it
 * cannot catch an inverted `isMobile` ternary, a cap applied to the wrong
 * slice, or the zoom-button arming gap the #4541 follow-up fixed, and it breaks
 * on harmless refactors of comment markers.
 *
 * These tests run the real methods. `MapComponent` is instantiated on its
 * prototype (the pattern from map-layer-toggle-button-state) so the
 * constructor's d3/ResizeObserver/network work stays out; only the fields each
 * method reads are set, and the collaborators it reaches are spied on. The cap
 * values are read off the class, not retyped, so the assertions follow the
 * signed-off constants.
 */
import { describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type Slices = {
  quakes: readonly unknown[];
  iranEvents: readonly unknown[];
  aircraft: readonly unknown[];
  protests: readonly unknown[];
  conflictEvents: readonly unknown[];
  weather: readonly unknown[];
};

type Surface = {
  isMobile: boolean;
  mobileLabelVisibilityArmed: boolean;
  state: { zoom: number; timeRange: string; layers: Record<string, boolean>; pan: { x: number; y: number } };
  earthquakes: unknown[];
  iranEvents: unknown[];
  aircraftPositions: unknown[];
  protests: unknown[];
  conflictEvents: unknown[];
  weatherAlerts: unknown[];
  getTimeRangeMs: () => number;
  updateLabelVisibility: ReturnType<typeof vi.fn>;
  applyTransform: ReturnType<typeof vi.fn>;
  overlayFeedSlices: () => Slices;
  shouldUpdateLabelVisibility: () => boolean;
  resumeMobileLabelVisibility: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
};

const MIN_MAG = (MapComponent as unknown as { MOBILE_MIN_EARTHQUAKE_MAGNITUDE: number }).MOBILE_MIN_EARTHQUAKE_MAGNITUDE;
const MAX_IRAN = (MapComponent as unknown as { MOBILE_MAX_IRAN_EVENTS: number }).MOBILE_MAX_IRAN_EVENTS;

function createMap(isMobile: boolean): Surface {
  const map = Object.create(MapComponent.prototype) as unknown as Surface;
  map.isMobile = isMobile;
  // Mirrors the constructor: desktop measures from the start, mobile defers.
  map.mobileLabelVisibilityArmed = !isMobile;
  map.state = {
    zoom: 2,
    timeRange: 'all',
    pan: { x: 0, y: 0 },
    layers: { natural: true, iranAttacks: true, flights: false, protests: false, conflicts: false, weather: false },
  };
  map.earthquakes = [];
  map.iranEvents = [];
  map.aircraftPositions = [];
  map.protests = [];
  map.conflictEvents = [];
  map.weatherAlerts = [];
  map.updateLabelVisibility = vi.fn();
  map.applyTransform = vi.fn();
  return map;
}

const quake = (magnitude: number, ageMs = 0) => ({ magnitude, occurredAt: Date.now() - ageMs, id: `q${magnitude}-${ageMs}` });
const iranEvent = (i: number) => ({ id: `ir-${i}`, occurredAt: Date.now() - i });

describe('mobile feed caps are applied at runtime (#4546)', () => {
  it('reads real cap constants off the class', () => {
    expect(MIN_MAG).toBeGreaterThan(0);
    expect(MAX_IRAN).toBeGreaterThan(0);
  });

  it('drops earthquakes below the mobile magnitude floor, keeps the boundary, and leaves desktop uncapped', () => {
    const feed = [quake(MIN_MAG - 0.1), quake(MIN_MAG), quake(MIN_MAG + 1.5)];

    const mobile = createMap(true);
    mobile.earthquakes = feed;
    expect(mobile.overlayFeedSlices().quakes).toEqual([feed[1], feed[2]]);

    const desktop = createMap(false);
    desktop.earthquakes = feed;
    expect(desktop.overlayFeedSlices().quakes).toEqual(feed);
  });

  it('applies the magnitude floor after the time-range filter', () => {
    const map = createMap(true);
    map.state.timeRange = '1h';
    map.getTimeRangeMs = () => 60 * 60 * 1000;
    const oldStrong = quake(MIN_MAG + 2, 3 * 60 * 60 * 1000);
    const freshStrong = quake(MIN_MAG + 0.5, 5 * 60 * 1000);
    const freshWeak = quake(MIN_MAG - 1, 5 * 60 * 1000);
    map.earthquakes = [oldStrong, freshStrong, freshWeak];

    expect(map.overlayFeedSlices().quakes).toEqual([freshStrong]);
  });

  it('caps Iran events on mobile to the first MOBILE_MAX_IRAN_EVENTS in feed order, uncapped on desktop', () => {
    const feed = Array.from({ length: MAX_IRAN + 15 }, (_, i) => iranEvent(i));

    const mobile = createMap(true);
    mobile.iranEvents = feed;
    const kept = mobile.overlayFeedSlices().iranEvents;
    expect(kept).toHaveLength(MAX_IRAN);
    // The cap is a prefix cut: whatever order the feed arrives in decides
    // which events survive. A severity-first ordering, if ever wanted, has to
    // happen upstream of setIranEvents — this pins that the cap itself does
    // not reorder.
    expect(kept).toEqual(feed.slice(0, MAX_IRAN));

    const desktop = createMap(false);
    desktop.iranEvents = feed;
    expect(desktop.overlayFeedSlices().iranEvents).toHaveLength(feed.length);
  });

  it('empties a feed whose layer is off before any cap runs', () => {
    const map = createMap(true);
    map.state.layers.natural = false;
    map.state.layers.iranAttacks = false;
    map.earthquakes = [quake(MIN_MAG + 3)];
    map.iranEvents = [iranEvent(1)];

    const slices = map.overlayFeedSlices();
    expect(slices.quakes).toEqual([]);
    expect(slices.iranEvents).toEqual([]);
  });
});

describe('mobile label thinning arms through the real methods (#4546 / #4541 follow-up)', () => {
  it('is disarmed on mobile and armed on desktop before any interaction', () => {
    expect(createMap(true).shouldUpdateLabelVisibility()).toBe(false);
    expect(createMap(false).shouldUpdateLabelVisibility()).toBe(true);
  });

  it('resumeMobileLabelVisibility arms once, measures once at the current zoom, and is idempotent', () => {
    const map = createMap(true);
    map.state.zoom = 3.5;

    map.resumeMobileLabelVisibility();
    map.resumeMobileLabelVisibility();

    expect(map.shouldUpdateLabelVisibility()).toBe(true);
    expect(map.updateLabelVisibility).toHaveBeenCalledTimes(1);
    expect(map.updateLabelVisibility).toHaveBeenCalledWith(3.5);
  });

  it('resumeMobileLabelVisibility is a no-op on desktop (already armed, no extra pass)', () => {
    const map = createMap(false);
    map.resumeMobileLabelVisibility();
    expect(map.updateLabelVisibility).not.toHaveBeenCalled();
  });

  it('the on-screen zoom buttons arm thinning — the gap the #4541 follow-up closed', () => {
    // The +/- controls are excluded from the direct-interaction listeners by
    // shouldIgnoreInteractionStart, so zoomIn/zoomOut must arm on their own.
    const map = createMap(true);
    map.zoomIn();

    expect(map.state.zoom).toBe(2.5);
    expect(map.applyTransform).toHaveBeenCalledTimes(1);
    expect(map.shouldUpdateLabelVisibility()).toBe(true);
    expect(map.updateLabelVisibility).toHaveBeenCalledTimes(1);

    const out = createMap(true);
    out.zoomOut();
    expect(out.state.zoom).toBe(1.5);
    expect(out.shouldUpdateLabelVisibility()).toBe(true);
  });

  it('zoom buttons arm before the transform pass would need it (order: transform, then resume)', () => {
    // applyTransform() gates its own label pass on shouldUpdateLabelVisibility();
    // zoomIn runs it disarmed and then arms + measures via resume, so exactly
    // one measurement happens per button press, not zero and not two.
    const map = createMap(true);
    const calls: string[] = [];
    map.applyTransform = vi.fn(() => { calls.push(`transform:${map.shouldUpdateLabelVisibility()}`); });
    map.updateLabelVisibility = vi.fn(() => { calls.push('measure'); });

    map.zoomIn();

    expect(calls).toEqual(['transform:false', 'measure']);
  });
});
