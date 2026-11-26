/**
 * #11157: the 3D globe has its own TIME RANGE row. A choice there must reach
 * MapContainer (URL, 2D map) and must narrow the globe's clustered vessels the
 * way the 2D renderers narrow theirs.
 */
import { describe, expect, it, vi } from 'vitest';

import { GlobeMap } from '@/components/GlobeMap';

const HOUR = 60 * 60 * 1000;

type Globe = {
  container: HTMLElement;
  timeRange: string;
  setTimeRange(range: string): void;
  onTimeRangeChanged(cb: (range: string) => void): void;
  createTimeSlider(): void;
  vesselClusterInRange(cluster: unknown, cutoff: number | null): { vessels: unknown[]; vesselCount: number; lat: number; lon: number } | null;
};

function globe(timeRange = '7d'): Globe {
  // No globe instance: the flush calls setTimeRange makes return early, leaving only the slider and callback.
  return Object.assign(Object.create(GlobeMap.prototype), {
    container: document.createElement('div'),
    timeRange,
    layers: {},
    onTimeRangeChangeCb: null,
  }) as Globe;
}

const pressed = (map: Globe) => [...map.container.querySelectorAll<HTMLElement>('.globe-time-slider .time-btn')]
  .filter(btn => btn.classList.contains('active') && btn.getAttribute('aria-pressed') === 'true')
  .map(btn => btn.dataset.range);

describe('globe time range', () => {
  it('marks the current range when the row is built', () => {
    const map = globe('24h');
    map.createTimeSlider();
    expect(pressed(map)).toEqual(['24h']);
  });

  it('reports a clicked range to MapContainer and moves the selection', () => {
    const map = globe();
    const changed = vi.fn();
    map.onTimeRangeChanged(changed);
    map.createTimeSlider();
    map.container.querySelector<HTMLElement>('.time-btn[data-range="6h"]')!.click();
    expect(changed).toHaveBeenCalledWith('6h');
    expect(map.timeRange).toBe('6h');
    expect(pressed(map)).toEqual(['6h']);
  });

  it('keeps only in-range vessels in a cluster and centres it across the date line', () => {
    const now = Date.now();
    const cluster = {
      id: 'c', lat: 0, lon: 0, vesselCount: 3,
      vessels: [
        { id: 'a', lat: 10, lon: 179, lastAisUpdate: new Date(now - HOUR) },
        { id: 'b', lat: 20, lon: -179, lastAisUpdate: new Date(now - HOUR) },
        { id: 'old', lat: 0, lon: 0, lastAisUpdate: new Date(now - 72 * HOUR) },
      ],
    };
    const inRange = globe().vesselClusterInRange(cluster, now - 24 * HOUR)!;
    expect(inRange.vesselCount).toBe(2);
    expect(inRange.vessels.map(v => (v as { id: string }).id)).toEqual(['a', 'b']);
    expect(inRange.lat).toBe(15);
    expect(Math.abs(inRange.lon)).toBeCloseTo(180);
  });

  it('drops a cluster left with one vessel, which keeps its own marker, and keeps all for ALL', () => {
    const now = Date.now();
    const cluster = {
      id: 'c', lat: 0, lon: 0, vesselCount: 2,
      vessels: [
        { id: 'a', lat: 0, lon: 0, lastAisUpdate: new Date(now - HOUR) },
        { id: 'old', lat: 0, lon: 0, lastAisUpdate: new Date(now - 72 * HOUR) },
      ],
    };
    const map = globe();
    expect(map.vesselClusterInRange(cluster, now - 24 * HOUR)).toBeNull();
    expect(map.vesselClusterInRange(cluster, null)).toBe(cluster);
  });
});
