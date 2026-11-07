/**
 * #5892 — the tab-cap guarantees, driven on a live PanelLayoutManager.
 *
 * `tests/tab-cap.test.mts`'s `tab-cap wiring` block guarded three real
 * guarantees with `assert.match` over panel-layout.ts SOURCE TEXT — the
 * grep-shape the repo has been burned by before (a grep proves a name exists
 * in a file; it never drives the decision — see docs/solutions/logic-errors/
 * playback-control-gated-on-a-clerk-role-field-with-no-writer.md). Nothing
 * mounted the class because its constructor runs checkout-return handling and
 * the Pro-activation controller on the way up; this harness stubs exactly
 * those boot side effects and asserts the guarantees behaviourally:
 *
 *   - a blocked addTab() leaves tabsState.tabs byte-identical, fires
 *     trackGateHit('dashboard-tab') exactly once, and persists nothing
 *   - an allowed addTab() appends exactly one tab and never reorders or
 *     drops an existing one
 *   - an auth emission and an entitlement emission each re-run the cap
 *     (the auth-only-subscription bug the guard was written for)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@/services/auth-state';
import type { EntitlementState } from '@/services/entitlements';

let authState: AuthSession;
let entitlement: EntitlementState | null = null;

const authListeners: Array<(state: AuthSession) => void> = [];
const entitlementListeners: Array<(state: EntitlementState | null) => void> = [];
const subscriptionListeners: Array<() => void> = [];

const trackGateHit = vi.fn();
const saveTabsState = vi.fn((..._args: unknown[]) => ({ persisted: true }));
const showToast = vi.fn();

const capEvaluations = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => authState,
  subscribeAuthState: (listener: (state: AuthSession) => void) => {
    authListeners.push(listener);
    return () => {};
  },
}));

vi.mock('@/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/entitlements')>()),
  getEntitlementState: () => entitlement,
  onEntitlementChange: (listener: (state: EntitlementState | null) => void) => {
    entitlementListeners.push(listener);
    return () => {};
  },
  initEntitlementSubscription: async () => {},
  destroyEntitlementSubscription: () => {},
}));

vi.mock('@/services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing')>()),
  getSubscription: () => null,
  onSubscriptionChange: (listener: () => void) => {
    subscriptionListeners.push(listener);
    return () => {};
  },
  initSubscriptionWatch: async () => {},
  destroySubscriptionWatch: () => {},
}));

// The catalog probe would go to the network; the gate itself stays active so
// cap verdicts are real.
vi.mock('@/services/gates/export-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/gates/export-resolver')>()),
  isExportGateActive: () => true,
  primeExportGateActivation: async () => false,
}));

// Count every cap resolution while keeping the REAL resolver — the counter is
// what proves an emission re-ran the cap; the verdict logic stays untouched.
vi.mock('@/services/gates/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gates/export')>();
  return {
    ...actual,
    evaluateTabCap: (...args: Parameters<typeof actual.evaluateTabCap>) => {
      capEvaluations.count += 1;
      return actual.evaluateTabCap(...args);
    },
  };
});

vi.mock('@/services/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/analytics')>()),
  trackGateHit: (...args: unknown[]) => trackGateHit(...args),
  trackCheckoutSuccess: () => {},
  trackCheckoutFailed: () => {},
  replayPendingCheckoutSuccess: () => {},
  replayPendingProFunnelEvents: () => {},
  replayPendingConversionEvents: () => {},
}));

vi.mock('@/services/tab-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tab-store')>()),
  loadTabsState: () => null,
  saveTabsState: (...args: unknown[]) => saveTabsState(...args),
}));

vi.mock('@/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils')>()),
  showToast: (...args: unknown[]) => showToast(...args),
}));

// Boot side effects the issue names, stubbed at the module boundary.
vi.mock('@/services/checkout-return', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/checkout-return')>()),
  handleCheckoutReturn: () => ({ kind: 'none' }),
  resolveCheckoutReturnRouting: () => ({ kind: 'none' }),
}));

vi.mock('@/services/checkout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/checkout')>()),
  consumePostCheckoutFlag: () => false,
  loadCheckoutAttempt: () => null,
  clearCheckoutAttempt: () => {},
  registerCheckoutSuccessCallback: () => {},
  showCheckoutSuccess: () => {},
}));

vi.mock('@/app/pro-activation-controller', () => ({
  ProActivationController: class {
    init(): void {}
    destroy(): void {}
  },
  markProActivationPending: () => {},
}));

vi.mock('@/app/passkey-offer-boot', () => ({
  PasskeyOfferBoot: class {
    init(): void {}
    destroy(): void {}
  },
}));

vi.mock('@/components/payment-failure-banner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/payment-failure-banner')>()),
  initPaymentFailureBanner: () => () => {},
}));

const { PanelLayoutManager } = await import('@/app/panel-layout');

const SIGNED_IN = { isPending: false, user: { id: 'user_1' } } as unknown as AuthSession;
const SIGNED_OUT = { isPending: false, user: null } as unknown as AuthSession;

function snapshot(maxDashboards: number): EntitlementState {
  return {
    planKey: 'pro',
    validUntil: Date.now() + 86_400_000,
    features: {
      tier: 1,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards,
      prioritySupport: false,
      exportFormats: [],
      dataExport: false,
    },
  } as unknown as EntitlementState;
}

type TabsStateShape = {
  activeTabId: string;
  tabs: Array<{ id: string; name: string; panelSettings: object; panelOrder: string[]; bottomSet: string[] }>;
};

type ManagerInternals = {
  tabsState: TabsStateShape | null;
  addTab(): void;
  renderLayout(): Promise<void>;
};

function makeManager(): { manager: InstanceType<typeof PanelLayoutManager>; internals: ManagerInternals } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = {
    container,
    panels: {},
    panelSettings: {},
    isMobile: false,
    isDesktopApp: false,
    isDestroyed: false,
    authModal: null,
    unifiedSettings: null,
    PANEL_ORDER_KEY: 'test-panel-order',
  } as never;
  const callbacks = {
    openCountryStory: () => {},
    openCountryBrief: () => {},
    openSearch: () => {},
    loadAllData: async () => {},
    primeVisiblePanelData: () => {},
    updateMonitorResults: () => {},
  } as never;
  const manager = new PanelLayoutManager(ctx, callbacks);
  return { manager, internals: manager as unknown as ManagerInternals };
}

function seedTabs(internals: ManagerInternals, ids: string[]): void {
  internals.tabsState = {
    activeTabId: ids[0]!,
    tabs: ids.map((id) => ({ id, name: `Tab ${id}`, panelSettings: {}, panelOrder: [], bottomSet: [] })),
  };
}

beforeEach(() => {
  authState = SIGNED_OUT;
  entitlement = null;
  authListeners.length = 0;
  entitlementListeners.length = 0;
  subscriptionListeners.length = 0;
  trackGateHit.mockClear();
  saveTabsState.mockClear();
  showToast.mockClear();
  capEvaluations.count = 0;
  document.body.innerHTML = '';
});

describe('PanelLayoutManager tab cap, driven live (#5892)', () => {
  it('a blocked addTab() leaves tabsState byte-identical and fires trackGateHit exactly once', () => {
    const { internals } = makeManager();
    authState = SIGNED_IN;
    entitlement = snapshot(2);
    seedTabs(internals, ['t1', 't2']);
    const before = JSON.stringify(internals.tabsState);

    internals.addTab();

    expect(JSON.stringify(internals.tabsState)).toBe(before);
    expect(trackGateHit).toHaveBeenCalledTimes(1);
    expect(trackGateHit).toHaveBeenCalledWith('dashboard-tab');
    expect(saveTabsState).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('an allowed addTab() appends exactly one tab and never reorders or drops an existing one', () => {
    const { internals } = makeManager();
    authState = SIGNED_IN;
    entitlement = snapshot(7);
    seedTabs(internals, ['t1', 't2']);

    internals.addTab();

    const tabs = internals.tabsState!.tabs;
    expect(tabs.length).toBe(3);
    expect(tabs.slice(0, 2).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(internals.tabsState!.activeTabId).toBe(tabs[2]!.id);
    expect(saveTabsState).toHaveBeenCalled();
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('an auth emission re-runs the cap', async () => {
    const { manager, internals } = makeManager();
    seedTabs(internals, ['t1']);
    // renderLayout builds the whole dashboard; the subscription wiring under
    // test lives in init() AFTER it, so replace only the render.
    internals.renderLayout = async () => {};
    await manager.init();
    expect(authListeners.length).toBeGreaterThan(0);

    const before = capEvaluations.count;
    authState = SIGNED_IN;
    entitlement = snapshot(7);
    for (const listener of authListeners) listener(SIGNED_IN);

    expect(capEvaluations.count).toBeGreaterThan(before);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('an entitlement emission re-runs the cap even with no auth emission', () => {
    const { internals } = makeManager();
    seedTabs(internals, ['t1']);
    expect(entitlementListeners.length).toBeGreaterThan(0);

    authState = SIGNED_IN;
    entitlement = snapshot(7);
    const before = capEvaluations.count;
    for (const listener of entitlementListeners) listener(snapshot(7));

    expect(capEvaluations.count).toBeGreaterThan(before);
  });

  it('a subscription-row emission re-runs the cap too (#4771 billing transitions)', () => {
    const { internals } = makeManager();
    seedTabs(internals, ['t1']);
    expect(subscriptionListeners.length).toBeGreaterThan(0);

    authState = SIGNED_IN;
    entitlement = snapshot(7);
    const before = capEvaluations.count;
    for (const listener of subscriptionListeners) listener();

    expect(capEvaluations.count).toBeGreaterThan(before);
  });
});
