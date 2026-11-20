/**
 * The Pro banner slot reserves 40px before paint so a free user's upsell does
 * not shift the page. For a signed-in user that reservation waits on the
 * first entitlement snapshot. When that snapshot can never arrive (no Convex
 * configured, the Convex auth wait timed out, the query failed) the slot must
 * release instead of leaving an empty band above the header for the session.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginEntitlementVerification,
  markEntitlementVerificationUnavailable,
  resetEntitlementVerification,
} from '@/services/entitlements';

type Session = import('@/services/auth-state').AuthSession;

const session: Session = {
  user: { id: 'user_signed_in', name: 'Signed In', email: 'user@example.com', role: 'free' },
  isPending: false,
};
const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

vi.mock('@/services/analytics', () => ({ trackGateHit: vi.fn(), trackProBannerClick: vi.fn() }));
vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
  onSubscriptionChange: () => () => {},
}));
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => session,
  subscribeAuthState: (fn: (value: Session) => void) => {
    fn(session);
    return () => {};
  },
}));
vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => session.user
    ? { id: session.user.id, name: session.user.name, email: session.user.email, image: null, plan: 'free' }
    : null,
  isClerkAuthEnabled: () => true,
}));
vi.mock('@/services/runtime-config', () => ({ getSecretState: () => ({ present: false }) }));
vi.mock('@/services/widget-store', () => ({
  isProWidgetEnabled: () => false,
  isWidgetFeatureEnabled: () => false,
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

let showProBanner: typeof import('@/components/ProBanner').showProBanner;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage);
  ({ showProBanner } = await import('@/components/ProBanner'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  resetEntitlementVerification();
  storage.clear();
  document.body.replaceChildren();
  // index.html adds this class before paint for every visitor without a
  // dismissal or a Pro hint.
  document.documentElement.classList.add('wm-pro-banner-reserved');
});

function mountContainer(): HTMLElement {
  const container = document.createElement('main');
  const slot = document.createElement('div');
  slot.id = 'proBannerSlot';
  container.appendChild(slot);
  document.body.appendChild(container);
  return container;
}

const reserved = (): boolean => document.documentElement.classList.contains('wm-pro-banner-reserved');

describe('Pro banner slot for a signed-in user whose plan has not loaded', () => {
  it('keeps the slot reserved while the plan is still loading', () => {
    const container = mountContainer();
    beginEntitlementVerification();
    showProBanner(container);
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(reserved()).toBe(true);
  });

  it('releases the slot when the plan load gives up after the banner was evaluated', () => {
    const container = mountContainer();
    beginEntitlementVerification();
    showProBanner(container);
    expect(reserved()).toBe(true);

    markEntitlementVerificationUnavailable();
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(reserved()).toBe(false);
  });

  it('releases the slot when the plan could not load before the banner was evaluated', () => {
    const container = mountContainer();
    markEntitlementVerificationUnavailable();
    showProBanner(container);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(reserved()).toBe(false);
  });
});
