/**
 * Runtime DOM coverage for the confirmed-Pro banner anti-flap path.
 *
 * The pure policy suite proves the time/state reducer. This test drives the
 * real ProBanner subscriptions, timer, reservation class, and DOM mount/remove
 * behavior so a future wiring regression cannot pass on the reducer alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRO_BANNER_DOWNGRADE_SETTLE_MS,
  PRO_BANNER_ENTITLEMENT_HINT_KEY,
  PRO_BANNER_ENTITLEMENT_HINT_VALUE,
} from '@/services/pro-banner-policy';
import { startAccountAuthHandoff } from '@/app/account-auth-handoff';
import type { EntitlementState as Entitlement } from '@/services/entitlements';

type Session = import('@/services/auth-state').AuthSession;

type EntitlementSnapshot = 'pro' | 'free' | null;

let entitlementSnapshot: EntitlementSnapshot = null;
let session: Session = {
  user: {
    id: 'user_pro',
    name: 'Pro User',
    email: 'pro@example.com',
    role: 'free',
  },
  isPending: false,
};
let clerkRole: 'free' | 'pro' = 'free';
const localUnlock = {
  apiKey: false,
  proWidget: false,
  widgetFeature: false,
};
const entitlementListeners: Array<(state: Entitlement | null) => void> = [];
const authListeners: Array<(value: Session) => void> = [];
const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

function entitlement(): Entitlement | null {
  if (entitlementSnapshot === null) return null;
  const premium = entitlementSnapshot === 'pro';
  return {
    planKey: entitlementSnapshot,
    features: {
      tier: premium ? 1 : 0,
      apiAccess: premium,
      apiRateLimit: premium ? 1_000 : 0,
      maxDashboards: premium ? 10 : 3,
      prioritySupport: false,
      exportFormats: [],
    },
    validUntil: Date.now() + 86_400_000,
  };
}

vi.mock('@/services/analytics', () => ({ trackGateHit: vi.fn() }));
vi.mock('@/services/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/entitlements')>();
  return {
    ...actual,
    getEntitlementState: () => entitlement(),
    isEntitled: () => actual.isEntitlementActive(entitlement(), Date.now()),
    onEntitlementChange: (fn: (state: Entitlement | null) => void) => {
      entitlementListeners.push(fn);
      return () => {};
    },
  };
});
vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
  onSubscriptionChange: () => () => {},
}));
// Partial so the real status-tone helpers stay available: a full stub goes
// stale the moment billing-state gains an export a rendered surface uses (#7315).
vi.mock('@/services/billing-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing-state')>()),
  deriveBillingUxState: () => 'free',
  getReactivationHref: () => '/pro#pricing',
}));
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => session,
  subscribeAuthState: (fn: (value: Session) => void) => {
    authListeners.push(fn);
    fn(session);
    return () => {};
  },
}));
vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => session.user
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: null,
        plan: clerkRole,
      }
    : null,
  isClerkAuthEnabled: () => true,
}));
vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({ present: localUnlock.apiKey }),
}));
vi.mock('@/services/widget-store', () => ({
  isProWidgetEnabled: () => localUnlock.proWidget,
  isWidgetFeatureEnabled: () => localUnlock.widgetFeature,
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

let showProBanner: typeof import('@/components/ProBanner').showProBanner;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  // Node exposes an undefined experimental `localStorage` unless a backing
  // file is configured. Supply the browser contract explicitly so ProBanner
  // exercises the same global a real page sees.
  vi.stubGlobal('localStorage', storage);
  ({ showProBanner } = await import('@/components/ProBanner'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  entitlementSnapshot = null;
  clerkRole = 'free';
  localUnlock.apiKey = false;
  localUnlock.proWidget = false;
  localUnlock.widgetFeature = false;
  document.body.replaceChildren();
  document.documentElement.classList.remove('wm-pro-banner-reserved');
  storage.clear();
  vi.setSystemTime(0);
});

function emitEntitlement(snapshot: EntitlementSnapshot, at: number): void {
  entitlementSnapshot = snapshot;
  vi.setSystemTime(at);
  const state = entitlement();
  for (const listener of entitlementListeners) listener(state);
}

function emitAuth(user: Session['user'], at: number): void {
  session = { user, isPending: false };
  vi.setSystemTime(at);
  for (const listener of authListeners) listener(session);
}

/**
 * App.ts resets the preserved Convex snapshot on an identity transition. Keep
 * that reset in the actual auth subscriber dispatch, rather than mutating the
 * snapshot around emitAuth(), so this DOM test covers either registration
 * order with ProBanner's production auth callback.
 */
function installAppEntitlementResetListener(
  order: 'before-pro-banner' | 'after-pro-banner',
): () => void {
  let previousUserId = session.user?.id ?? null;
  const appListener = (next: Session): void => {
    const userId = next.user?.id ?? null;
    if (userId !== previousUserId) {
      previousUserId = userId;
      if (userId === null) {
        entitlementSnapshot = null;
        const state = entitlement();
        for (const listener of entitlementListeners) listener(state);
        return;
      }
      void startAccountAuthHandoff({
        userId,
        isCurrent: () => session.user?.id === userId,
        effects: {
          destroyEntitlementSubscription: () => {},
          beginEntitlementVerification: () => {},
          resetEntitlementState: () => {
            entitlementSnapshot = null;
            const state = entitlement();
            for (const listener of entitlementListeners) listener(state);
          },
          markEntitlementVerificationUnavailable: () => {},
          destroySubscriptionWatch: () => {},
          rebindConvexAuthForWatchHandoff: async () => false,
          initEntitlementSubscription: () => {},
          initSubscriptionWatch: () => {},
          cloudPrefsSignIn: () => {},
        },
      });
    }
  };

  if (order === 'before-pro-banner') {
    authListeners.unshift(appListener);
  } else {
    authListeners.push(appListener);
  }
  return () => {
    const index = authListeners.indexOf(appListener);
    if (index >= 0) authListeners.splice(index, 1);
  };
}

describe('ProBanner confirmed-Pro stability', () => {
  it('stabilizes same-user flaps, quarantines cross-account snapshots, and respects safe premium sources', () => {
    const container = document.createElement('main');
    const slot = document.createElement('div');
    slot.id = 'proBannerSlot';
    container.appendChild(slot);
    document.body.appendChild(container);

    // A pre-paint reservation must survive ordinary signed-in hydration while
    // the first entitlement is still unknown. Clearing it here would recreate
    // the layout shift the reservation exists to prevent.
    document.documentElement.classList.add('wm-pro-banner-reserved');
    showProBanner(container);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(true);

    emitEntitlement('free', 100);
    expect(container.querySelector('.pro-banner')).not.toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(true);

    emitEntitlement('pro', 200);
    vi.advanceTimersByTime(300);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(false);

    emitEntitlement('free', 500);
    expect(container.querySelector('.pro-banner')).toBeNull();

    emitEntitlement('pro', 1_000);
    emitEntitlement('free', 1_500);
    expect(container.querySelector('.pro-banner')).toBeNull();

    vi.advanceTimersByTime(1_999);
    expect(container.querySelector('.pro-banner')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(container.querySelector('.pro-banner')).not.toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(true);

    emitEntitlement('pro', 4_000);
    vi.advanceTimersByTime(300);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(false);

    // ProBanner can receive the Clerk callback before App's auth subscriber
    // resets the old Convex snapshot. It must quarantine A's unscoped Pro
    // evidence, defer B's banner through reset, then mount only after B's
    // current free snapshot arrives.
    const removeAfterProBannerReset = installAppEntitlementResetListener('after-pro-banner');
    emitAuth({
      id: 'user_free',
      name: 'Free User',
      email: 'free@example.com',
      role: 'free',
    }, 4_500);
    expect(storage.getItem(PRO_BANNER_ENTITLEMENT_HINT_KEY)).toBeNull();

    // App's subscriber published null during the auth dispatch above. The
    // reset alone is deliberately not free evidence: B's snapshot is needed.
    expect(container.querySelector('.pro-banner')).toBeNull();
    emitEntitlement('free', 4_600);
    expect(container.querySelector('.pro-banner')).not.toBeNull();

    // A mounted free banner belongs to B. Switching directly to a Convex-only
    // Pro C must remove that old account's upgrade UI throughout C's unknown
    // window, then keep it absent once C's own Pro snapshot arrives.
    emitAuth({
      id: 'user_convex_pro',
      name: 'Convex Pro User',
      email: 'convex-pro@example.com',
      role: 'free',
    }, 4_700);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(false);

    emitEntitlement('pro', 4_800);
    expect(container.querySelector('.pro-banner')).toBeNull();

    removeAfterProBannerReset();

    // Exercise the reverse dispatch order. App clears A's snapshot before
    // ProBanner observes the new Clerk identity; B's current Pro snapshot is
    // still accepted and remains banner-suppressing.
    emitEntitlement('pro', 9_700);
    const removeBeforeProBannerReset = installAppEntitlementResetListener('before-pro-banner');
    emitAuth({
      id: 'user_pro_next',
      name: 'Next Pro User',
      email: 'next-pro@example.com',
      role: 'free',
    }, 9_800);
    expect(container.querySelector('.pro-banner')).toBeNull();
    emitEntitlement('pro', 10_300);
    vi.advanceTimersByTime(300);
    expect(container.querySelector('.pro-banner')).toBeNull();
    removeBeforeProBannerReset();

    // A current Clerk role is identity-bound and may suppress the banner and
    // seed the UX-only hint, even while the previous account's Convex Pro
    // snapshot is quarantined during a direct switch.
    const removeClerkReset = installAppEntitlementResetListener('after-pro-banner');
    storage.clear();
    clerkRole = 'pro';
    emitAuth({
      id: 'clerk_pro',
      name: 'Clerk Pro',
      email: 'clerk-pro@example.com',
      role: 'free',
    }, 10_700);
    vi.advanceTimersByTime(300);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(storage.getItem(PRO_BANNER_ENTITLEMENT_HINT_KEY)).toBe(PRO_BANNER_ENTITLEMENT_HINT_VALUE);

    // Each local unlock is safe only for the present device/session. It must
    // suppress the banner while cross-account Convex evidence is quarantined,
    // but never write the cross-session account hint.
    const localUnlockCases: Array<{
      name: string;
      enable: () => void;
      disable: () => void;
    }> = [
      {
        name: 'API key',
        enable: () => { localUnlock.apiKey = true; },
        disable: () => { localUnlock.apiKey = false; },
      },
      {
        name: 'Pro widget',
        enable: () => { localUnlock.proWidget = true; },
        disable: () => { localUnlock.proWidget = false; },
      },
      {
        name: 'widget feature',
        enable: () => { localUnlock.widgetFeature = true; },
        disable: () => { localUnlock.widgetFeature = false; },
      },
    ];
    for (const [index, unlock] of localUnlockCases.entries()) {
      clerkRole = 'free';
      emitEntitlement('pro', 14_000 + index * 1_000);
      storage.clear();
      unlock.enable();
      emitAuth({
        id: `local_unlock_${index}`,
        name: unlock.name,
        email: `local-unlock-${index}@example.com`,
        role: 'free',
      }, 14_100 + index * 1_000);
      vi.advanceTimersByTime(300);
      expect(container.querySelector('.pro-banner')).toBeNull();
      expect(storage.getItem(PRO_BANNER_ENTITLEMENT_HINT_KEY)).toBeNull();
      unlock.disable();
    }

    // Confirm the final signed-in account through its current Convex
    // snapshot, start a downgrade, then sign out. Sign-out owns the
    // transition and must bypass the remaining settle window.
    emitEntitlement('pro', 18_000);
    emitEntitlement('free', 18_100);
    expect(container.querySelector('.pro-banner')).toBeNull();
    emitAuth(null, 18_200);
    expect(container.querySelector('.pro-banner')).not.toBeNull();
    expect(storage.getItem(PRO_BANNER_ENTITLEMENT_HINT_KEY)).toBeNull();
    vi.advanceTimersByTime(PRO_BANNER_DOWNGRADE_SETTLE_MS);
    expect(container.querySelector('.pro-banner')).not.toBeNull();
    removeClerkReset();
  });
});
