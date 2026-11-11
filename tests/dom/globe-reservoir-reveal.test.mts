import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobeMap } from '@/components/GlobeMap';

const reservoir = (id: string, lat: number, lon: number) => ({ id, name: id, lat, lon, series: [] });

function fakeGlobe() {
  return Object.assign(Object.create(GlobeMap.prototype), {
    globe: {},
    destroyed: false,
    popup: { show: vi.fn() },
    setCenter: vi.fn(),
    hideTooltip: vi.fn(),
    container: document.createElement('div'),
    reservoirRevealSeq: 0,
  });
}

describe('globe reservoir reveal from a panel row', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens the reservoir popup after the camera turns', () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    expect(map.popup.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(map.popup.show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'reservoirLevel', data: expect.objectContaining({ id: 'mead' }) }));
  });

  it('does not replace a marker the user clicked before the delayed popup fires', () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    const other = reservoir('powell', 37.1, -110.9);
    map.handleMarkerClick({ _kind: 'reservoirLevel', _lat: other.lat, _lng: other.lon, id: other.id, reservoir: other }, document.createElement('div'));
    vi.advanceTimersByTime(1200);
    expect(map.popup.show).toHaveBeenCalledTimes(1);
    expect(map.popup.show.mock.calls[0][0].data.id).toBe('powell');
  });

  it('only the latest of two quick row clicks opens', () => {
    vi.useFakeTimers();
    const map = fakeGlobe();
    map.openReservoir(reservoir('mead', 36.1, -114.4));
    map.openReservoir(reservoir('gerd', 11.2, 35.1));
    vi.advanceTimersByTime(1200);
    expect(map.popup.show).toHaveBeenCalledTimes(1);
    expect(map.popup.show.mock.calls[0][0].data.id).toBe('gerd');
  });
});
