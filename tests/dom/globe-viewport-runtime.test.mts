import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('globe.gl', () => ({ default: vi.fn() }));
vi.mock('@/services/country-geometry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-geometry')>(),
  getCountryBbox: () => [10, 20, 30, 40],
}));
import { GlobeMap } from '@/components/GlobeMap';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// Exercise real camera commands and settlement; only graphics and frame timing
// are fake, so the suite needs no GPU or globe.gl animation implementation.
function camera() {
  let pov = { lat: 0, lng: 0, altitude: 1.8 };
  const map = Object.create(GlobeMap.prototype);
  const controls = { autoRotate: true, enableDamping: true, update: vi.fn() };
  Object.assign(map, {
    globe: { pointOfView: (next?: typeof pov) => { if (next) pov = { ...next }; return { ...pov }; } },
    controls, destroyed: false, renderPaused: false,
    viewportAnimationFrame: null, viewportMovementGeneration: 0,
    viewportAutoRotateBeforeMove: null, controlsAutoRotateBeforePause: null,
    resolveViewportSettled: null, viewportSettledPromise: Promise.resolve(true),
    viewportTarget: null, viewportSettleTimer: null, viewportSettleDeadline: 0,
    currentView: 'global', layers: {}, timeRange: '24h',
    wakeGlobe: vi.fn(), reselectMarkersForViewport: vi.fn(),
  });
  return { map, controls, pov: () => pov };
}

describe('Globe viewport runtime', () => {
  it.each(['setView', 'setCenter', 'setZoom', 'zoomInGlobe', 'zoomOutGlobe', 'fitCountry'])('%s owns an asynchronous move and publishes settled state', async method => {
    const { map, controls, pov } = camera();
    const changed = vi.fn();
    map.onStateChanged(changed);
    const before = pov();
    const args: Record<string, unknown[]> = {
      setView: ['eu'], setCenter: [41, 29, 6], setZoom: [6],
      zoomInGlobe: [], zoomOutGlobe: [], fitCountry: ['XX'],
    };
    map[method](...args[method]!);
    let settled = false;
    const movement = map.whenViewportSettled().then((completed: boolean) => { settled = true; return completed; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(controls.autoRotate).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
    await expect(movement).resolves.toBe(true);
    expect(pov()).not.toEqual(before);
    expect(controls.autoRotate).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(map.getState());
    if (method === 'setCenter') expect(map.getCenter()).toEqual({ lat: 41, lon: 29 });
    if (method === 'fitCountry') expect(map.getCenter()).toEqual({ lat: 30, lon: 20 });
  });

  it('interrupts a superseded move without restoring rotation during its replacement', async () => {
    const { map, controls } = camera();
    map.setCenter(10, 20, 4);
    const first = map.whenViewportSettled();
    await vi.advanceTimersByTimeAsync(100);
    map.setCenter(40, 50, 6);
    await expect(first).resolves.toBe(false);
    expect(controls.autoRotate).toBe(false);
    const second = map.whenViewportSettled();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(second).resolves.toBe(true);
    expect(map.getCenter()).toEqual({ lat: 40, lon: 50 });
    expect(controls.autoRotate).toBe(true);
  });

  it.each([false, true])('restores saved rotation after settlement (renderPaused=%s)', async paused => {
    const { map, controls } = camera();
    map.setCenter(10, 20);
    const movement = map.whenViewportSettled();
    map.renderPaused = paused;
    map.controlsAutoRotateBeforePause = paused ? false : null;
    if (paused) {
      await vi.advanceTimersByTimeAsync(1500);
      expect(map.viewportTarget).not.toBeNull();
      expect(controls.autoRotate).toBe(false);
      map.settleViewportMovement(false);
      await expect(movement).resolves.toBe(false);
      expect(map.controlsAutoRotateBeforePause).toBe(true);
      expect(controls.autoRotate).toBe(false);
    } else {
      await vi.advanceTimersByTimeAsync(1500);
      await expect(movement).resolves.toBe(true);
      expect(controls.autoRotate).toBe(true);
    }
  });

  it('allows a state subscriber to start a new move during settlement', async () => {
    const { map } = camera();
    let next: Promise<boolean> | undefined;
    map.onStateChanged(() => {
      if (!next) {
        map.setCenter(30, 40);
        next = map.whenViewportSettled();
      }
    });
    map.setCenter(10, 20);
    const first = map.whenViewportSettled();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(first).resolves.toBe(true);
    expect(next).toBeDefined();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(next).resolves.toBe(true);
    expect(map.getCenter()).toEqual({ lat: 30, lon: 40 });
  });

  it.each([false, true])('defers a chokepoint pan and popup until ready (destroyed=%s)', async destroyed => {
    let release!: () => void;
    const map = Object.create(GlobeMap.prototype);
    const setCenter = vi.fn();
    const show = vi.fn();
    Object.assign(map, {
      globe: null, destroyed: false,
      initPromise: new Promise<void>(resolve => { release = resolve; }),
      container: { getBoundingClientRect: () => ({ width: 100, height: 60 }) },
      setCenter, popup: { show },
    });
    map.openChokepoint('hormuz_strait');
    expect(setCenter).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    map.globe = {};
    map.destroyed = destroyed;
    release();
    await Promise.resolve();
    expect(setCenter).toHaveBeenCalledTimes(destroyed ? 0 : 1);
    if (!destroyed) expect(setCenter).toHaveBeenCalledWith(26.5, 56.5, 5);
    expect(show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(show).toHaveBeenCalledTimes(destroyed ? 0 : 1);
    if (!destroyed) expect(show).toHaveBeenCalledWith(expect.objectContaining({ type: 'waterway', x: 50, y: 30 }));
  });
});
