/**
 * #5632 — the playback control's premium gate.
 *
 * `setupPlaybackControl` used to hide the control behind
 * `getAuthState().user?.role === 'pro'`. Nothing in this codebase writes Clerk
 * `publicMetadata.plan`/`role` (zero `clerkClient`/`updateUser` writers; the
 * gap is documented at src/services/panel-gating.ts, api/widget-agent.ts and
 * server/gateway.ts), so that field is `'free'` for EVERY account including
 * paying subscribers — the control rendered for nobody.
 *
 * A source grep for `evaluatePlaybackGate` would go green with the bug
 * restored verbatim, so this file drives the real `setupPlaybackControl`
 * against a minimal AppContext and asserts what the header actually contains.
 *
 * Only the reactive EDGES are stubbed — the Clerk session and the Convex
 * entitlement snapshot. `hasPremiumAccess`, `isProUser`, `readPlaybackGateInputs`
 * and `resolvePlaybackGate` all run for real, so the mapping from live state to
 * verdict is under test and not just the closure that reads it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

// Both aliased to the REAL exported interfaces rather than re-declared. A
// hand-rolled shape here would let the fixtures drift from production silently;
// this way a field added to either interface fails `npm run typecheck:dom-tests`
// until the fixtures below are updated.
type Session = import('@/services/auth-state').AuthSession;
type Entitlement = import('@/services/entitlements').EntitlementState | null;

/** Live Clerk session, mutated per case. Boot default mirrors auth-state.ts. */
let session: Session = { user: null, isPending: true };
/** Live Convex entitlement snapshot; `null` means "no snapshot has arrived". */
let entitlement: Entitlement = null;
/** Desktop runtime with WORLDMONITOR_API_KEY configured. */
let desktopKeyPresent = false;
// Kept apart, and each replayed with the argument its real emitter passes, so
// the test cannot accidentally certify a listener that only works when called
// with the other source's payload (or with none at all).
const authListeners: Array<(state: Session) => void> = [];
const entitlementListeners: Array<(state: Entitlement) => void> = [];
// Real unsubscribe counters. With the previous `() => {}` stubs, a regression
// that never pushed an unsubscriber onto `proGateUnsubscribers` — or that
// stopped calling them in destroy() — passed every assertion in this file.
let authUnsubscribed = 0;
let entitlementUnsubscribed = 0;

// Partial mocks throughout: a full replacement would turn every other export
// these modules provide into `undefined` somewhere in the event-handlers import
// graph, failing later with an unrelated-looking error.
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: (fn: (state: Session) => void) => {
    authListeners.push(fn);
    // The real one emits the current state synchronously on subscribe
    // (auth-state.ts:69). Replicated so the suite runs production's actual
    // multi-fire mount path, not a quieter one that only fires when the test
    // says so — the gate-hit latch's whole job is to survive that re-entry.
    fn(session);
    return () => authUnsubscribed++;
  },
}));

// `isEntitled` delegates to the REAL predicate rather than re-implementing it.
// The real `isEntitled()` reads a module-private `currentState` this test
// cannot write, but `isEntitlementActive` is that same rule over an injected
// snapshot — so a change to what "entitled" means cannot drift away from this
// suite. `isProUser()` (widget-store) consumes it for real, which is the path
// a paying subscriber actually takes.
vi.mock('@/services/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/entitlements')>();
  return {
    ...actual,
    getEntitlementState: () => entitlement,
    isEntitled: () => actual.isEntitlementActive(entitlement, Date.now()),
    onEntitlementChange: (fn: (state: Entitlement) => void) => {
      entitlementListeners.push(fn);
      // Real behaviour: late subscribers get the current value immediately, but
      // ONLY when a snapshot already exists (entitlements.ts:156-158).
      if (entitlement !== null) fn(entitlement);
      return () => entitlementUnsubscribed++;
    },
  };
});

const trackGateHit = vi.fn<(feature: string) => void>();
vi.mock('@/services/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/analytics')>()),
  trackGateHit: (feature: string) => trackGateHit(feature),
}));

// Snapshot store, so a test can actually ENTER playback. The real one opens
// IndexedDB, which happy-dom does not provide.
const SNAPSHOT_TS = 1_700_000_000_000;
vi.mock('@/services/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/storage')>()),
  getSnapshotTimestamps: async () => [SNAPSHOT_TS],
  getSnapshotAt: async () => ({
    timestamp: SNAPSHOT_TS,
    events: [],
    marketPrices: {},
    predictions: [],
    hotspotLevels: {},
  }),
}));

// The desktop runtime's WORLDMONITOR_API_KEY branch of `hasPremiumAccess`.
// Without this the suite reaches `premiumAccess` ONLY through `isEntitled()`,
// so dropping the desktop-key path from `readPlaybackGateInputs` would go
// unnoticed. Everything else keeps the real (absent-secret) behaviour.
vi.mock('@/services/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/runtime-config')>();
  return {
    ...actual,
    getSecretState: (key: string) =>
      key === 'WORLDMONITOR_API_KEY' && desktopKeyPresent
        ? { present: true, valid: true, source: 'env' as const }
        : actual.getSecretState(key as Parameters<typeof actual.getSecretState>[0]),
  };
});

const { EventHandlerManager } = await import('@/app/event-handlers');

let container: HTMLElement;
let manager: InstanceType<typeof EventHandlerManager>;
let ctx: ConstructorParameters<typeof EventHandlerManager>[0];
let loadAllData: Mock<() => void>;

const control = () => container.querySelector<HTMLElement>('.playback-control');
const isVisible = () => control()!.style.display !== 'none';

/** A signed-in Clerk session. `role` is ALWAYS 'free' — nothing writes 'pro'. */
function signedIn(): Session {
  return {
    user: { id: 'user_1', name: 'A', email: 'a@example.com', role: 'free' },
    isPending: false,
  };
}

/** Feature blocks matching the real `EntitlementState['features']` contract. */
function features(tier: number): NonNullable<Entitlement>['features'] {
  return {
    tier,
    apiAccess: tier >= 1,
    apiRateLimit: tier >= 1 ? 1000 : 0,
    maxDashboards: tier >= 1 ? 10 : 3,
    prioritySupport: false,
    exportFormats: [],
  };
}

const PRO_SNAPSHOT: Entitlement = {
  planKey: 'pro',
  features: features(1),
  validUntil: Date.now() + 86_400_000,
};

const FREE_SNAPSHOT: Entitlement = {
  planKey: 'free',
  features: features(0),
  validUntil: Date.now() + 86_400_000,
};

/** Replay a Clerk session change through the auth subscription. */
function emitAuth(): void {
  for (const fn of [...authListeners]) fn(session);
}

/** Replay a Convex entitlement push through the entitlement subscription. */
function emitEntitlement(): void {
  for (const fn of [...entitlementListeners]) fn(entitlement);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  authListeners.length = 0;
  entitlementListeners.length = 0;
  authUnsubscribed = 0;
  entitlementUnsubscribed = 0;
  trackGateHit.mockClear();
  session = { user: null, isPending: true };
  entitlement = null;
  desktopKeyPresent = false;
  loadAllData = vi.fn<() => void>();

  container = document.createElement('div');
  const headerRight = document.createElement('div');
  headerRight.className = 'header-right';
  container.appendChild(headerRight);
  document.body.appendChild(container);

  ctx = {
    container,
    isDestroyed: false,
    isPlaybackMode: false,
    panels: {},
    newsPanels: {},
  } as unknown as ConstructorParameters<typeof EventHandlerManager>[0];

  manager = new EventHandlerManager(ctx, {
    loadAllData,
  } as unknown as ConstructorParameters<typeof EventHandlerManager>[1]);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('setupPlaybackControl — entitlement gate (#5632)', () => {
  it('shows the control to a paying subscriber whose Clerk role is still "free"', () => {
    // The whole bug: Clerk `role` is never written to 'pro', so the old gate
    // hid the control from the exact users who paid for it.
    session = signedIn();
    entitlement = PRO_SNAPSHOT;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('keeps the control visible for a signed-in user with NO entitlement snapshot', () => {
    // Never over-gate. A late, failed or skipped Convex subscription is an
    // UNKNOWN, not a denial — `initEntitlementSubscription` gives up entirely
    // when Convex auth misses its 10s window or VITE_CONVEX_URL is unset, so a
    // fail-closed branch here would be a permanent lockout, not a boot blip
    // (post-mortem: src/app/panel-layout.ts:710-735).
    session = signedIn();
    entitlement = null;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('hides the control from a signed-in free user once the snapshot proves it', () => {
    session = signedIn();
    entitlement = FREE_SNAPSHOT;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(false);
    expect(trackGateHit).toHaveBeenCalledWith('playback');
  });

  it('hides the control from an anonymous visitor once auth settles', () => {
    session = { user: null, isPending: false };

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(false);
    expect(trackGateHit).toHaveBeenCalledWith('playback');
  });

  it('hides the control while auth is still pending WITHOUT recording a gate hit', () => {
    // `isPending` is the boot default and resolves within Clerk's bounded ~4s
    // idle window, so hiding costs a signed-in Pro user a brief delay instead
    // of flashing a Pro control at every anonymous visitor. It is an unknown,
    // though — counting it as a denial would drown the funnel metric in boot
    // noise from users who were never gated.
    session = { user: null, isPending: true };

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(false);
    expect(trackGateHit).not.toHaveBeenCalled();
    // Pins the `isPlaybackMode` guard inside exitPlayback: this hidden verdict
    // happens on EVERY page load, and an unguarded exit would fire a full
    // data reload each time.
    expect(loadAllData).not.toHaveBeenCalled();
  });

  it('reveals the control when the entitlement snapshot lands after boot', () => {
    // The post-checkout unlock path. Auth state does not re-emit when Convex
    // pushes a new entitlement row, so an auth-only subscription leaves a
    // freshly-upgraded subscriber staring at a hidden control until reload.
    session = signedIn();
    entitlement = FREE_SNAPSHOT;

    manager.setupPlaybackControl();
    expect(isVisible()).toBe(false);

    entitlement = PRO_SNAPSHOT;
    emitEntitlement();

    expect(isVisible()).toBe(true);
  });

  it('reveals the control when a pending session resolves to a subscriber', () => {
    session = { user: null, isPending: true };
    entitlement = null;

    manager.setupPlaybackControl();
    expect(isVisible()).toBe(false);

    session = signedIn();
    entitlement = PRO_SNAPSHOT;
    emitAuth();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('records the playback gate hit at most once per session', () => {
    session = { user: null, isPending: false };

    manager.setupPlaybackControl();
    emitAuth();
    emitEntitlement();

    expect(trackGateHit).toHaveBeenCalledTimes(1);
  });
});

describe('setupPlaybackControl — revocation (#5632)', () => {
  it('hides the control when a subscriber signs out', () => {
    // The security-relevant direction. Every other reveal case proves the
    // control can APPEAR; a regression that leaves the previous account's
    // premium control mounted would pass all of them.
    session = signedIn();
    entitlement = PRO_SNAPSHOT;

    manager.setupPlaybackControl();
    expect(isVisible()).toBe(true);

    session = { user: null, isPending: false };
    entitlement = null;
    emitEntitlement();
    emitAuth();

    expect(isVisible()).toBe(false);
  });

  it('hides the control when the entitlement lapses without a sign-out', () => {
    session = signedIn();
    entitlement = PRO_SNAPSHOT;

    manager.setupPlaybackControl();
    expect(isVisible()).toBe(true);

    entitlement = FREE_SNAPSHOT;
    emitEntitlement();

    expect(isVisible()).toBe(false);
  });

  it('keeps the control up across an account switch until the new snapshot lands', () => {
    // App.ts resets the entitlement snapshot on a userId change while the NEW
    // user is already signed in, so the chain sees signedIn + no snapshot and
    // fails open. Pinned deliberately: it is the widest fail-open window in
    // the design, and any future narrowing should be a conscious change.
    session = signedIn();
    entitlement = PRO_SNAPSHOT;
    manager.setupPlaybackControl();

    session = {
      user: { id: 'user_2', name: 'B', email: 'b@example.com', role: 'free' },
      isPending: false,
    };
    entitlement = null;
    emitEntitlement();
    emitAuth();

    expect(isVisible()).toBe(true);

    entitlement = FREE_SNAPSHOT;
    emitEntitlement();

    expect(isVisible()).toBe(false);
  });
});

describe('setupPlaybackControl — non-Convex premium paths (#5632)', () => {
  it('shows the control on a desktop API key with no session and no snapshot', () => {
    // `hasPremiumAccess` short-circuits on WORLDMONITOR_API_KEY before any
    // Clerk or Convex signal. Without this case the suite reaches
    // `premiumAccess` only through isEntitled(), so dropping the desktop-key
    // path from readPlaybackGateInputs would go unnoticed.
    desktopKeyPresent = true;
    session = { user: null, isPending: false };
    entitlement = null;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });
});

describe('setupPlaybackControl — teardown and active playback (#5632)', () => {
  it('releases BOTH subscriptions on destroy', () => {
    // Two emitters means two leaks if either unsubscriber is dropped, and a
    // leaked listener keeps writing to a detached element for the rest of the
    // page's life.
    session = signedIn();
    entitlement = PRO_SNAPSHOT;
    manager.setupPlaybackControl();

    expect(authUnsubscribed).toBe(0);
    expect(entitlementUnsubscribed).toBe(0);

    manager.destroy();

    expect(authUnsubscribed).toBe(1);
    expect(entitlementUnsubscribed).toBe(1);
  });

  it('stops touching the control once the manager is destroyed', () => {
    session = signedIn();
    entitlement = PRO_SNAPSHOT;
    manager.setupPlaybackControl();
    expect(isVisible()).toBe(true);

    (ctx as { isDestroyed: boolean }).isDestroyed = true;
    session = { user: null, isPending: false };
    entitlement = null;
    emitAuth();

    // The guard leaves the last verdict in place rather than writing to a
    // control whose owner is tearing down.
    expect(isVisible()).toBe(true);
  });

  it('leaves playback mode when access is revoked mid-replay', async () => {
    // Reachable in ordinary use, not just on downgrade: a signed-in free user
    // is shown the control during the never-over-gate window (Clerk hydrated,
    // Convex snapshot still in flight for up to 10s) and can enter playback
    // before the snapshot lands and denies them. Hiding the element alone
    // strands the dashboard on historical data — the "Live" button is INSIDE
    // the element being hidden, so there is no way back.
    session = signedIn();
    entitlement = PRO_SNAPSHOT;
    manager.setupPlaybackControl();

    const el = control()!;
    el.querySelector<HTMLButtonElement>('.playback-toggle')!.click();
    await vi.waitFor(() => {
      expect(el.querySelector<HTMLInputElement>('.playback-slider')!.max).toBe('0');
    });
    el.querySelector<HTMLButtonElement>('.playback-btn[data-action="start"]')!.click();
    await vi.waitFor(() => {
      expect(document.body.classList.contains('playback-mode')).toBe(true);
    });

    entitlement = FREE_SNAPSHOT;
    emitEntitlement();

    expect(isVisible()).toBe(false);
    expect(document.body.classList.contains('playback-mode')).toBe(false);
    expect(loadAllData).toHaveBeenCalled();
  });
});
