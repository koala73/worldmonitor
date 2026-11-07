/**
 * The SVG map's world topology fetch retries twice with jittered backoff, and
 * a map destroyed during a backoff never fetches again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type TopologyMap = {
  destroyed: boolean;
  isMobile: boolean;
  worldData: unknown;
  baseRendered: boolean;
  render: () => void;
  scheduleRender: () => void;
  loadMapData: () => Promise<void>;
};

function createMap(): TopologyMap {
  return Object.assign(Object.create(MapComponent.prototype), {
    destroyed: false,
    isMobile: false,
    worldData: null,
    baseRendered: true,
    render: vi.fn(),
    scheduleRender: vi.fn(),
  }) as TopologyMap;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1); // the upper end of the jitter: 500ms, then 1000ms
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MapComponent topology load', () => {
  it('retries a failed fetch twice, then renders the topology that arrives', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockResolvedValueOnce(Response.json({ type: 'Topology', objects: { countries: { type: 'GeometryCollection', geometries: [] } }, arcs: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const map = createMap();

    const load = map.loadMapData();
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await load;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(map.worldData).not.toBeNull();
    expect(map.render).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('gives up after the third failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const map = createMap();

    const load = map.loadMapData();
    await vi.advanceTimersByTimeAsync(10_000);
    await load;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(map.render).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Failed to load map data:', expect.any(TypeError));
  });

  it('stops retrying once the map is destroyed during a backoff', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const map = createMap();

    const load = map.loadMapData();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    map.destroyed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await load;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });
});
