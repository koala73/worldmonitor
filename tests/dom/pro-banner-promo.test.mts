/**
 * Free users see the running promotion in the dashboard's Pro strip, with
 * figures from the catalog and its own dismissal. The clock is pinned on both
 * sides of the end instant so these cases do not change when the offer ends.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_PROMO } from '../../shared/promo-campaign';

type Session = import('@/services/auth-state').AuthSession;

const signedOut: Session = { user: null, isPending: false };
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
// A lapsed subscriber gets the resubscribe strip, never the offer.
const billing = vi.hoisted(() => ({ subscription: null as Record<string, unknown> | null }));
vi.mock('@/services/billing', () => ({
  getSubscription: () => billing.subscription,
  onSubscriptionChange: () => () => {},
}));
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => signedOut,
  subscribeAuthState: (fn: (value: Session) => void) => {
    fn(signedOut);
    return () => {};
  },
}));
vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => null,
  isClerkAuthEnabled: () => true,
}));
vi.mock('@/services/runtime-config', () => ({ getSecretState: () => ({ present: false }) }));
vi.mock('@/services/widget-store', () => ({
  isProWidgetEnabled: () => false,
  isWidgetFeatureEnabled: () => false,
}));
// Echo the key and its values so assertions see which copy and figures render.
vi.mock('@/services/i18n', () => ({
  t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  getLocale: () => 'en-US',
}));

const PROMO = ACTIVE_PROMO!;
const DURING = PROMO.endsAtMs - 2 * 24 * 60 * 60 * 1000;
const PROMO_DISMISSED_UNTIL_KEY = 'wm-pro-banner-promo-dismissed-until';
const REGULAR_DISMISS_KEY = 'wm-pro-banner-launched-dismissed';

vi.stubGlobal('localStorage', storage);

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date'] });
  storage.clear();
  billing.subscription = null;
  document.body.replaceChildren();
  vi.resetModules();
});

function lapsedSubscription(): Record<string, unknown> {
  return {
    planKey: 'pro_monthly',
    displayName: 'Pro',
    status: 'cancelled',
    currentPeriodEnd: DURING - 10 * 24 * 60 * 60 * 1000,
    renewalVerificationState: null,
  };
}

function mountContainer(): HTMLElement {
  const container = document.createElement('main');
  const slot = document.createElement('div');
  slot.id = 'proBannerSlot';
  container.appendChild(slot);
  document.body.appendChild(container);
  return container;
}

async function showAt(now: number): Promise<HTMLElement> {
  vi.setSystemTime(now);
  const { showProBanner } = await import('@/components/ProBanner');
  const container = mountContainer();
  showProBanner(container);
  // The promotion's catalog figures load on demand, then the mount reruns.
  await vi.waitFor(() => expect(container.querySelector('.pro-banner')).not.toBeNull());
  return container;
}

describe('dashboard Pro strip during the promotion', () => {
  it('shows the offer with the catalog figures to a free visitor', async () => {
    const container = await showAt(DURING);
    const banner = container.querySelector<HTMLElement>('.pro-banner')!;
    expect(banner.dataset.promo).toBe(PROMO.id);
    const text = banner.textContent ?? '';
    expect(text).toContain('components.proBanner.promoHeadline {"savings":70}');
    // The 70% is against paying monthly: the tagline names that price.
    expect(text).toContain('"perMonth":"$12.00","monthly":"$39.99"');
    expect(text).toContain('components.proBanner.promoTagline');
    expect(banner.querySelector('.pro-banner-cta')?.getAttribute('href')).toBe('/pro#pricing');
  });

  it('still shows the offer to someone who closed the regular strip this week', async () => {
    storage.setItem(REGULAR_DISMISS_KEY, String(DURING - 60_000));
    const container = await showAt(DURING);
    expect(container.querySelector<HTMLElement>('.pro-banner')?.dataset.promo).toBe(PROMO.id);
  });

  it('closing the offer records its own dismissal, bounded by the end, and not the regular one', async () => {
    const container = await showAt(DURING);
    container.querySelector<HTMLButtonElement>('.pro-banner-close')!.click();
    const until = Number(storage.getItem(PROMO_DISMISSED_UNTIL_KEY));
    expect(until).toBe(PROMO.endsAtMs);
    expect(storage.getItem(REGULAR_DISMISS_KEY)).toBeNull();
  });

  it('a closed offer stays closed on the next load', async () => {
    storage.setItem(PROMO_DISMISSED_UNTIL_KEY, String(PROMO.endsAtMs));
    vi.setSystemTime(DURING);
    const { showProBanner } = await import('@/components/ProBanner');
    const container = mountContainer();
    showProBanner(container);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.pro-banner')).toBeNull();
  });

  it('replaces an open offer with the regular strip at the end instant', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const container = await showAt(PROMO.endsAtMs - 5_000);
    expect(container.querySelector<HTMLElement>('.pro-banner')?.dataset.promo).toBe(PROMO.id);

    vi.advanceTimersByTime(5_000);

    const banner = container.querySelector<HTMLElement>('.pro-banner');
    expect(banner?.dataset.promo).toBeUndefined();
    expect(banner?.textContent).toContain('components.proBanner.headline');
  });

  it('a lapsed subscriber gets the resubscribe strip during the offer', async () => {
    billing.subscription = lapsedSubscription();
    const container = await showAt(DURING);
    const banner = container.querySelector<HTMLElement>('.pro-banner')!;
    expect(banner.dataset.billingState).toBe('lapsed');
    expect(banner.dataset.promo).toBeUndefined();
    expect(storage.getItem('wm-pro-banner-lapsed')).toBe('1');
  });

  // The resubscribe strip is the one that renders, so its own dismissal decides.
  it('a lapsed subscriber who closed the resubscribe strip does not see it again during the offer', async () => {
    billing.subscription = lapsedSubscription();
    storage.setItem(REGULAR_DISMISS_KEY, String(DURING - 60_000));
    vi.setSystemTime(DURING);
    const { showProBanner } = await import('@/components/ProBanner');
    const container = mountContainer();
    showProBanner(container);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.pro-banner')).toBeNull();
  });

  it('shows the regular strip once the offer has ended', async () => {
    storage.setItem(PROMO_DISMISSED_UNTIL_KEY, String(PROMO.endsAtMs));
    const container = await showAt(PROMO.endsAtMs);
    const banner = container.querySelector<HTMLElement>('.pro-banner')!;
    expect(banner.dataset.promo).toBeUndefined();
    expect(banner.textContent).toContain('components.proBanner.headline');
  });
});
