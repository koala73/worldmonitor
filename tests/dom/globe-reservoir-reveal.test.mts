import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobeMap } from '@/components/GlobeMap';

const reservoir = (id: string, lat: number, lon: number) => ({ id, name: id, lat, lon, series: [] });

// Mirrors GlobeMap's movement contract: setCenter starts a tracked movement whose
// whenViewportSettled() promise resolves true after the 1200 ms rotation, or false
// when a drag or a later camera command interrupts it.
function fakeGlobe() {
  let settle: ((completed: boolean) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const map = Object.assign(Object.create(GlobeMap.prototype), {
    globe: {},
    destroyed: false,
    popup: { show: vi.fn(), hide: vi.fn() },
    tooltipEl: null,
    tooltipHideTimer: null,
    container: document.createElement('div'),
    reservoirRevealSeq: 0,
    viewportSettledPromise: Promise.resolve(true),
    interruptViewport() {
      if (timer) clearTimeout(timer);
      timer = null;
      const resolve = settle;
      settle = null;
      resolve?.(false);
    },
  });
  map.setCenter = vi.fn(() => {
    map.interruptViewport();
    map.viewportSettledPromise = new Promise<boolean>((resolve) => { settle = resolve; });
    timer = setTimeout(() => { const resolve = settle; settle = null; resolve?.(true); }, 1200);
  });
  return map;
}

describe('globe reservoir reveal from a panel row', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens the reservoir popup after the camera turns', async () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    expect(map.popup.show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(map.popup.show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'reservoirLevel', data: expect.objectContaining({ id: 'mead' }) }));
  });

  it('does not replace a marker the user clicked before the delayed popup fires', async () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    const other = reservoir('powell', 37.1, -110.9);
    map.handleMarkerClick({ _kind: 'reservoirLevel', _lat: other.lat, _lng: other.lon, id: other.id, reservoir: other }, document.createElement('div'));
    await vi.advanceTimersByTimeAsync(1200);
    expect(map.popup.show).toHaveBeenCalledTimes(1);
    expect(map.popup.show.mock.calls[0][0].data.id).toBe('powell');
  });

  it('only the latest of two quick row clicks opens', async () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    map.openReservoir(reservoir('gerd', 11.2, 35.1));
    await vi.advanceTimersByTimeAsync(1200);
    expect(map.popup.show).toHaveBeenCalledTimes(1);
    expect(map.popup.show.mock.calls[0][0].data.id).toBe('gerd');
  });

  it('an open marker tooltip timer cannot close the reservoir popup after it opens', async () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    // A marker tooltip is open and will dismiss itself (and the popup) in 3.5 s.
    map.tooltipHideTimer = setTimeout(() => map.hideTooltip(), 3500);
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    await vi.advanceTimersByTimeAsync(5000);
    expect(map.popup.show).toHaveBeenCalledTimes(1);
    const lastHide = Math.max(0, ...map.popup.hide.mock.invocationCallOrder);
    expect(lastHide).toBeLessThan(map.popup.show.mock.invocationCallOrder[0]);
  });

  it('does not open when the user drags the globe mid-rotation', async () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    await vi.advanceTimersByTimeAsync(400);
    map.interruptViewport();
    await vi.advanceTimersByTimeAsync(2000);
    expect(map.popup.show).not.toHaveBeenCalled();
  });

  it('does not open when a later camera command supersedes the rotation', async () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    await vi.advanceTimersByTimeAsync(400);
    map.setCenter(0, 0, 3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(map.popup.show).not.toHaveBeenCalled();
  });
});
