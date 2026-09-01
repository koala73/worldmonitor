/**
 * Behavioral coverage for the ResilienceWidget entitlement gate
 * (WORLDMONITOR-NY).
 *
 * Production sequence this replays: Clerk resolves first and flips
 * `AuthSession.isPending` to false, but for a signed-in user the Convex
 * entitlement snapshot lands seconds later. In that window
 * `getPanelGateReason` reads FREE_TIER for a PAYING subscriber, so the widget
 * rendered "Upgrade to Pro". Clicking it POSTs /api/create-checkout, which
 * answers 409 ACTIVE_SUBSCRIPTION_EXISTS — 28 events across 15 accounts since
 * April, breadcrumb `button.panel-locked-cta.resilience-widget__cta`.
 *
 * The widget also subscribed to auth state ONLY, so the late snapshot fired no
 * listener and the wrong CTA stayed on screen rather than merely flickering.
 *
 * The gate uses the real `getPanelGateReason` / `isProTierResolved`; only the
 * reactive auth and entitlement inputs are controlled so the ordering can be
 * replayed deterministically.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Session = import('@/services/auth-state').AuthSession;

let session: Session = { user: null, isPending: true };
let entitlementTier: number | null = null;
let verificationStatus: 'idle' | 'pending' | 'ready' | 'unavailable' = 'idle';
const authListeners: Array<(state: Session) => void> = [];
const entitlementListeners: Array<(state: unknown) => void> = [];
const verificationListeners: Array<(status: string) => void> = [];
let entitlementUnsubscribed = 0;
let verificationUnsubscribed = 0;

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => session,
  subscribeAuthState: (listener: (state: Session) => void) => {
    authListeners.push(listener);
    listener(session);
    return () => {
      const index = authListeners.indexOf(listener);
      if (index >= 0) authListeners.splice(index, 1);
    };
  },
}));

function entitlementState() {
  if (entitlementTier === null) return null;
  return {
    planKey: entitlementTier > 0 ? 'pro' : 'free',
    features: {
      tier: entitlementTier,
      apiAccess: entitlementTier > 0,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: [],
    },
    validUntil: Date.now() + 86_400_000,
  };
}

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => entitlementState(),
  isEntitled: () => entitlementTier !== null && entitlementTier > 0,
  onEntitlementChange: (listener: (state: unknown) => void) => {
    entitlementListeners.push(listener);
    return () => {
      entitlementUnsubscribed++;
      const index = entitlementListeners.indexOf(listener);
      if (index >= 0) entitlementListeners.splice(index, 1);
    };
  },
  getEntitlementVerificationStatus: () => verificationStatus,
  onEntitlementVerificationChange: (listener: (status: string) => void) => {
    verificationListeners.push(listener);
    // The real implementation replays the current status on subscribe.
    listener(verificationStatus);
    return () => {
      verificationUnsubscribed++;
      const index = verificationListeners.indexOf(listener);
      if (index >= 0) verificationListeners.splice(index, 1);
    };
  },
}));

// panel-gating still imports billing; stub the module so this suite does not
// pull the live watcher. The widget itself no longer subscribes here.
vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
  onSubscriptionChange: () => () => {},
  openBillingPortal: async () => {},
  prereserveBillingPortalTab: () => {},
}));

vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({ present: false, valid: false, source: 'missing' }),
}));

// The real widget-store drags in layout/storage machinery; only the two
// entitlement readers the gate consults matter here, and both are derived from
// the same controlled inputs the production implementations read.
vi.mock('@/services/widget-store', () => ({
  isProUser: () => session.user?.role === 'pro' || (entitlementTier !== null && entitlementTier > 0),
  isProTierResolved: () => {
    if (session.user?.role === 'pro' || (entitlementTier !== null && entitlementTier > 0)) return true;
    if (session.isPending) return false;
    return session.user === null || entitlementTier !== null;
  },
}));

const getResilienceScore = vi.fn(async () => ({
  countryCode: 'US',
  overallScore: 73,
  baselineScore: 82,
  stressScore: 58,
  stressFactor: 0.21,
  level: 'high',
  domains: [],
  trend: 'rising',
  change30d: 2.4,
  lowConfidence: false,
  imputationShare: 0,
  dataVersion: '2026-04-03',
}));

vi.mock('@/services/resilience', () => ({ getResilienceScore }));

const { ResilienceWidget } = await import('@/components/ResilienceWidget');

const PAYING_USER: Session = {
  user: { id: 'user_paying', name: 'Paying', email: 'p@example.com', role: 'free' },
  isPending: false,
};

beforeEach(() => {
  session = { user: null, isPending: true };
  entitlementTier = null;
  verificationStatus = 'idle';
  authListeners.length = 0;
  entitlementListeners.length = 0;
  verificationListeners.length = 0;
  entitlementUnsubscribed = 0;
  verificationUnsubscribed = 0;
  getResilienceScore.mockClear();
  document.body.replaceChildren();
});

function emitAuth(next: Session): void {
  session = next;
  for (const listener of [...authListeners]) listener(session);
}

function emitEntitlement(tier: number | null): void {
  entitlementTier = tier;
  verificationStatus = 'ready';
  for (const listener of [...entitlementListeners]) listener(undefined);
}

/**
 * A terminal verification outcome. Mirrors `markEntitlementVerificationUnavailable`
 * in src/services/entitlements.ts: it moves ONLY the verification status and
 * leaves `currentState` null, so `onEntitlementChange` never fires.
 */
function emitVerificationUnavailable(): void {
  verificationStatus = 'unavailable';
  for (const listener of [...verificationListeners]) listener(verificationStatus);
}

function upgradeCta(root: HTMLElement): HTMLElement | null {
  return root.querySelector('.resilience-widget__cta');
}

function isCheckingAccess(root: HTMLElement): boolean {
  return /Checking access/.test(root.textContent ?? '');
}

describe('ResilienceWidget entitlement gate (WORLDMONITOR-NY)', () => {
  it('does not offer checkout to a signed-in user before the entitlement snapshot lands', () => {
    const widget = new ResilienceWidget('US');
    document.body.appendChild(widget.getElement());

    // Clerk resolves. The Convex entitlement snapshot has NOT arrived, so
    // nothing yet distinguishes a free user from a paying one.
    emitAuth(PAYING_USER);

    // Asserted positively: "no CTA" alone would also hold for a blank or
    // errored body, so the waiting state has to be named.
    expect(upgradeCta(widget.getElement())).toBeNull();
    expect(isCheckingAccess(widget.getElement())).toBe(true);
    widget.destroy();
  });

  it('unlocks when the entitlement snapshot arrives after auth, with no auth event', async () => {
    const widget = new ResilienceWidget('US');
    document.body.appendChild(widget.getElement());
    emitAuth(PAYING_USER);

    // The snapshot lands on its own channel — production fires no second auth
    // event here, which is why an auth-only subscription left the wrong CTA up.
    emitEntitlement(1);
    await vi.waitFor(() => expect(getResilienceScore).toHaveBeenCalledWith('US'));

    // Both halves matter: the CTA must be gone AND the widget must have moved
    // off the waiting state. Checking only the CTA would pass while the widget
    // sat on "Checking access…" forever, which is the failure the pending gate
    // introduces if the snapshot never re-renders it.
    expect(upgradeCta(widget.getElement())).toBeNull();
    expect(isCheckingAccess(widget.getElement())).toBe(false);
    widget.destroy();
  });

  it('still offers upgrade to a settled free user', () => {
    const widget = new ResilienceWidget('US');
    document.body.appendChild(widget.getElement());
    emitAuth(PAYING_USER);
    emitEntitlement(0);

    const cta = upgradeCta(widget.getElement());
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toBe('Upgrade to Pro');
    widget.destroy();
  });

  it('still offers sign-in to an anonymous visitor', () => {
    const widget = new ResilienceWidget('US');
    document.body.appendChild(widget.getElement());
    emitAuth({ user: null, isPending: false });

    const cta = upgradeCta(widget.getElement());
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toBe('Sign In');
    widget.destroy();
  });

  it('releases the entitlement and verification subscriptions on destroy', () => {
    const widget = new ResilienceWidget('US');
    document.body.appendChild(widget.getElement());
    emitAuth(PAYING_USER);

    widget.destroy();

    expect(entitlementUnsubscribed).toBe(1);
    expect(verificationUnsubscribed).toBe(1);
  });

  // A snapshot that never arrives is NOT the same as one that is still coming.
  // `markEntitlementVerificationUnavailable` (entitlements.ts) publishes the
  // terminal outcome on the verification channel ONLY — `currentState` stays
  // null and `onEntitlementChange` never fires — so waiting on
  // `isProTierResolved()` alone parks the widget on "Checking access…" forever
  // and denies the panel to free and paying users alike. UnifiedSettings.ts
  // pairs the same wait with an idle/pending check for exactly this reason.
  describe('terminal entitlement failure', () => {
    it('stops waiting when verification ends without a snapshot', () => {
      const widget = new ResilienceWidget('US');
      document.body.appendChild(widget.getElement());
      emitAuth(PAYING_USER);
      expect(isCheckingAccess(widget.getElement())).toBe(true);

      emitVerificationUnavailable();

      expect(isCheckingAccess(widget.getElement())).toBe(false);
      widget.destroy();
    });

    it('falls back to the gate verdict rather than a dead panel', () => {
      const widget = new ResilienceWidget('US');
      document.body.appendChild(widget.getElement());
      emitAuth(PAYING_USER);
      emitVerificationUnavailable();

      // Same verdict main shows in this state — the terminal case is left no
      // worse than before this PR, while the common pending→ready case is fixed.
      const cta = upgradeCta(widget.getElement());
      expect(cta).not.toBeNull();
      expect(cta?.textContent).toBe('Upgrade to Pro');
      widget.destroy();
    });

    it('keeps waiting while verification is merely pending', () => {
      const widget = new ResilienceWidget('US');
      document.body.appendChild(widget.getElement());
      verificationStatus = 'pending';
      emitAuth(PAYING_USER);

      // The bounded Clerk/Convex retries are still running; converting that
      // into a verdict is what the pending gate exists to prevent.
      expect(isCheckingAccess(widget.getElement())).toBe(true);
      expect(upgradeCta(widget.getElement())).toBeNull();
      widget.destroy();
    });

    it('still unlocks a Pro user whose verification later recovers', async () => {
      const widget = new ResilienceWidget('US');
      document.body.appendChild(widget.getElement());
      emitAuth(PAYING_USER);
      emitVerificationUnavailable();
      emitEntitlement(1);
      await vi.waitFor(() => expect(getResilienceScore).toHaveBeenCalledWith('US'));

      expect(upgradeCta(widget.getElement())).toBeNull();
      expect(isCheckingAccess(widget.getElement())).toBe(false);
      widget.destroy();
    });
  });
});
