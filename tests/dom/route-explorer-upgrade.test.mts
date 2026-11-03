import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DODO_PRODUCTS } from '@/config/products';

const {
  hasPremiumAccess,
  startCheckout,
  getAuthState,
  track,
  trackGateHit,
} = vi.hoisted(() => ({
  hasPremiumAccess: vi.fn(() => false),
  startCheckout: vi.fn(async () => true),
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
    track.mockReset();
    trackGateHit.mockReset();
    explorer = new RouteExplorer();
  });

  afterEach(() => {
    if (explorer.isOpenNow()) explorer.close();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('passes the Pro Monthly Dodo product id to checkout', async () => {
    explorer.open();
    await vi.advanceTimersByTimeAsync(250);

    const button = document.querySelector<HTMLButtonElement>('.re-content__upgrade');
    expect(button).not.toBeNull();
    button?.click();

    await vi.waitFor(() => {
      expect(startCheckout).toHaveBeenCalledTimes(1);
    });
    expect(startCheckout).toHaveBeenCalledWith(DODO_PRODUCTS.PRO_MONTHLY);
  });
});
