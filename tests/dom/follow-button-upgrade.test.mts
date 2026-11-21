/**
 * The follow cap is an upgrade moment. A signed-in free user who hits it goes
 * to the /pro plan picker through `openUpgradePlans`, the shared helper that
 * also carries the desktop handoff marker. A bare `/pro#pricing` open dropped
 * that marker on desktop.
 */
import { describe, expect, it, vi } from 'vitest';

const { openUpgradePlans, startCheckout, openExternalUrl, openSignIn } = vi.hoisted(() => ({
  openUpgradePlans: vi.fn(async () => {}),
  startCheckout: vi.fn(async () => true),
  openExternalUrl: vi.fn(async (_url: string) => 'opened'),
  openSignIn: vi.fn(),
}));

vi.mock('@/services/followed-countries', () => ({
  addCountry: vi.fn(async () => ({ ok: false, reason: 'FREE_CAP' })),
  removeCountry: vi.fn(async () => ({ ok: true })),
  isFollowed: () => false,
  getFollowed: () => ['US', 'DE', 'FR'],
  subscribe: () => () => {},
  serviceEntitlementState: () => 'free',
  isFollowFeatureEnabled: () => true,
  FREE_TIER_FOLLOW_LIMIT: 3,
}));
vi.mock('@/services/entitlements', () => ({ onEntitlementChange: () => () => {} }));
vi.mock('@/services/external-navigation', () => ({ openExternalUrl }));
vi.mock('@/services/analytics', () => ({ trackGateHit: vi.fn() }));
vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_free' }),
  openSignIn,
}));
vi.mock('@/services/upgrade-flow', () => ({ openUpgradePlans }));
vi.mock('@/services/checkout', () => ({ startCheckout }));

const { renderFollowButton } = await import('@/utils/follow-button');

describe('follow button at the free cap', () => {
  it('opens the plan picker through openUpgradePlans for a signed-in user', async () => {
    const handle = renderFollowButton({ countryCode: 'GB' } as Parameters<typeof renderFollowButton>[0]);
    const host = document.createElement('div');
    host.innerHTML = handle.html;
    document.body.append(host);
    const teardown = handle.attach(host);

    host.querySelector<HTMLButtonElement>('button')!.click();

    await vi.waitFor(() => expect(openUpgradePlans).toHaveBeenCalledTimes(1));
    expect(startCheckout).not.toHaveBeenCalled();
    expect(openSignIn).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
    teardown();
    host.remove();
  });
});
