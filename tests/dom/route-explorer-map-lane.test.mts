/**
 * The route explorer highlights the country pair's own lane on the map, not
 * the whole trade route through to its fixed end port. Subscribers get the
 * lane from the server response; free visitors get the same lane computed in
 * the browser. Saudi Arabia to India sails only through Hormuz, so the map
 * must not pulse Malacca or run on to Singapore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetRouteExplorerLaneResponse } from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import { computeLane } from '../../server/worldmonitor/supply-chain/v1/get-route-explorer-lane';

const {
  fetchRouteExplorerLane,
  fetchRouteImpact,
  getResilienceScore,
  hasPremiumAccess,
} = vi.hoisted(() => ({
  fetchRouteExplorerLane: vi.fn(),
  fetchRouteImpact: vi.fn(),
  getResilienceScore: vi.fn(),
  hasPremiumAccess: vi.fn(() => true),
}));

vi.mock('@/services/supply-chain', () => ({ fetchRouteExplorerLane, fetchRouteImpact }));
vi.mock('@/services/resilience', () => ({ getResilienceScore }));
vi.mock('@/services/auth-state', () => ({ getAuthState: () => ({ user: null, isPending: false }) }));
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess }));
vi.mock('@/services/analytics', () => ({ track: vi.fn(), trackGateHit: vi.fn() }));

import { RouteExplorer } from '@/components/RouteExplorer/RouteExplorer';

type MapLane = { routeId: string; path: [number, number][]; chokepointIds: string[] };

function fakeMap() {
  return {
    highlightRoute: vi.fn(),
    highlightLane: vi.fn<(lane: MapLane, occluder?: { left: number; right: number }) => void>(),
    clearHighlightedRoute: vi.fn(),
    setBypassRoutes: vi.fn(),
    clearBypassRoutes: vi.fn(),
    zoomToRoutes: vi.fn(),
  };
}

// Inside India's bounding box, west of the Malacca strait (lon 101.5).
const inIndia = ([lon, lat]: [number, number]): boolean => lon > 68 && lon < 98 && lat > 6 && lat < 36;

describe('RouteExplorer map lane', () => {
  let explorer: RouteExplorer;
  let map: ReturnType<typeof fakeMap>;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/?explorer=from:SA,to:IN,hs:27');
    fetchRouteExplorerLane.mockReset();
    fetchRouteImpact.mockReset().mockResolvedValue(null);
    getResilienceScore.mockReset().mockResolvedValue(null);
    explorer = new RouteExplorer();
    map = fakeMap();
    explorer.setMap(map);
  });

  afterEach(() => {
    if (explorer.isOpenNow()) explorer.close();
    hasPremiumAccess.mockReturnValue(true);
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('draws the server lane for subscribers, and Space redraws the lane, not the whole route', async () => {
    const response: GetRouteExplorerLaneResponse = await computeLane(
      { fromIso2: 'SA', toIso2: 'IN', hs2: '27', cargoType: 'tanker' },
      new Map(),
    );
    fetchRouteExplorerLane.mockResolvedValue(response);

    explorer.open();
    await vi.runAllTimersAsync();

    expect(map.highlightLane).toHaveBeenCalledOnce();
    const lane = map.highlightLane.mock.calls[0]![0];
    expect(lane.routeId).toBe('gulf-asia-oil');
    expect(lane.chokepointIds).toEqual(['hormuz_strait']);
    expect(inIndia(lane.path[lane.path.length - 1]!)).toBe(true);
    expect(map.highlightRoute).not.toHaveBeenCalled();

    // Shortcuts are ignored while a picker input has focus.
    (document.activeElement as HTMLElement | null)?.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(map.highlightLane).toHaveBeenCalledTimes(2);
    expect(map.highlightRoute).not.toHaveBeenCalled();
  });

  it('draws the same lane for free visitors without a lane response', async () => {
    hasPremiumAccess.mockReturnValue(false);

    explorer.open();
    await vi.runAllTimersAsync();

    expect(fetchRouteExplorerLane).not.toHaveBeenCalled();
    expect(map.highlightLane).toHaveBeenCalledOnce();
    const lane = map.highlightLane.mock.calls[0]![0];
    expect(lane.routeId).toBe('gulf-asia-oil');
    expect(lane.chokepointIds).toEqual(['hormuz_strait']);
    expect(inIndia(lane.path[lane.path.length - 1]!)).toBe(true);
    expect(map.highlightRoute).not.toHaveBeenCalled();
  });
});
