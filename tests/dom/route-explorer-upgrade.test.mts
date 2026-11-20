import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasPremiumAccess,
  startCheckout,
  openUpgradePlans,
  getAuthState,
  track,
  trackGateHit,
} = vi.hoisted(() => ({
  hasPremiumAccess: vi.fn(() => false),
  startCheckout: vi.fn(async () => true),
  openUpgradePlans: vi.fn(async () => {}),
  getAuthState: vi.fn(() => ({ user: null, isPending: false })),
  track: vi.fn(),
  trackGateHit: vi.fn(),
}));

vi.mock('@/services/supply-chain', () => ({
  fetchRouteExplorerLane: vi.fn(),
  fetchRouteImpact: vi.fn(),
}));
vi.mock('@/services/resilience', () => ({ getResilienceScore: vi.fn() }));
vi.mock('@/services/auth-state', () => ({ getAuthState }));
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess }));
vi.mock('@/services/analytics', () => ({ track, trackGateHit }));
vi.mock('@/services/checkout', () => ({ startCheckout }));
vi.mock('@/services/upgrade-flow', () => ({ openUpgradePlans }));

import { RouteExplorer } from '@/components/RouteExplorer/RouteExplorer';

describe('Route Explorer free upgrade', () => {
  let explorer: RouteExplorer;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/?explorer=from:US,to:DE,hs:27');
    hasPremiumAccess.mockReset();
    hasPremiumAccess.mockReturnValue(false);
    startCheckout.mockReset();
    startCheckout.mockResolvedValue(true);
    openUpgradePlans.mockClear();
    track.mockReset();
    trackGateHit.mockReset();
    explorer = new RouteExplorer();
  });

  afterEach(() => {
    if (explorer.isOpenNow()) explorer.close();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('opens the plan picker instead of a Pro Monthly checkout', async () => {
    explorer.open();
    await vi.advanceTimersByTimeAsync(250);

    const button = document.querySelector<HTMLButtonElement>('.re-content__upgrade');
    expect(button).not.toBeNull();
    button?.click();

    await vi.waitFor(() => {
      expect(openUpgradePlans).toHaveBeenCalledTimes(1);
    });
    expect(startCheckout).not.toHaveBeenCalled();
    expect(document.querySelector('.re-content .checkout-consent')).toBeNull();
  });
});
