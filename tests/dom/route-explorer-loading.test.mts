import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetRouteExplorerLaneResponse } from '@/generated/server/worldmonitor/supply_chain/v1/service_server';

const {
  fetchRouteExplorerLane,
  fetchRouteImpact,
  getResilienceScore,
  getAuthState,
  hasPremiumAccess,
  track,
  trackGateHit,
} = vi.hoisted(() => ({
  fetchRouteExplorerLane: vi.fn(),
  fetchRouteImpact: vi.fn(),
  getResilienceScore: vi.fn(),
  getAuthState: vi.fn(() => ({ user: null, isPending: false })),
  hasPremiumAccess: vi.fn(() => true),
  track: vi.fn(),
  trackGateHit: vi.fn(),
}));

vi.mock('@/services/supply-chain', () => ({
  fetchRouteExplorerLane,
  fetchRouteImpact,
}));

vi.mock('@/services/resilience', () => ({ getResilienceScore }));
vi.mock('@/services/auth-state', () => ({ getAuthState }));
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess }));
vi.mock('@/services/analytics', () => ({ track, trackGateHit }));

import { RouteExplorer } from '@/components/RouteExplorer/RouteExplorer';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function laneFixture(): GetRouteExplorerLaneResponse {
  return {
    fromIso2: 'US',
    toIso2: 'DE',
    hs2: '27',
    cargoType: 'EXPLORER_CARGO_CONTAINER',
    primaryRouteId: '',
    primaryRouteGeometry: [],
    chokepointExposures: [],
    bypassOptions: [],
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    disruptionScore: 12,
    estTransitDaysRange: { min: 14, max: 18 },
    estFreightUsdPerTeuRange: { min: 1800, max: 2400 },
    noModeledLane: false,
    fetchedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('RouteExplorer loading lifecycle', () => {
  let explorer: RouteExplorer;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/?explorer=from:US,to:DE,hs:27');
    fetchRouteExplorerLane.mockReset();
    fetchRouteImpact.mockReset();
    getResilienceScore.mockReset();
    track.mockReset();
    trackGateHit.mockReset();
    explorer = new RouteExplorer();
  });

  afterEach(() => {
    if (explorer.isOpenNow()) explorer.close();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('clears loading across close-before-settle and reopen', async () => {
    const firstLoad = deferred<GetRouteExplorerLaneResponse>();
    const secondLoad = deferred<GetRouteExplorerLaneResponse>();
    fetchRouteExplorerLane
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);

    explorer.open();
    await vi.advanceTimersByTimeAsync(250);

    expect(fetchRouteExplorerLane).toHaveBeenCalledOnce();
    expect(explorer.isLoading).toBe(true);
    expect(document.querySelector('.re-content__loading')).not.toBeNull();

    explorer.close();
    expect(explorer.isLoading).toBe(false);
    explorer.open();
    await vi.advanceTimersByTimeAsync(250);

    expect(fetchRouteExplorerLane).toHaveBeenCalledTimes(2);
    expect(explorer.isLoading).toBe(true);
    expect(document.querySelector('.re-content__loading')).not.toBeNull();

    firstLoad.resolve(laneFixture());
    await vi.runAllTimersAsync();

    expect(explorer.isOpenNow()).toBe(true);
    expect(explorer.isLoading).toBe(true);
    expect(document.querySelector('.re-content__loading')).not.toBeNull();

    secondLoad.resolve(laneFixture());
    await vi.runAllTimersAsync();

    expect(explorer.isLoading).toBe(false);
    expect(document.querySelector('.re-content__loading')).toBeNull();
    expect(document.querySelector('.re-current__summary')).not.toBeNull();
  });
});
