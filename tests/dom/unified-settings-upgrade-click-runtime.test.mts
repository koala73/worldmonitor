/**
 * #5911 — Settings' "Upgrade to Pro" click must reach the OS browser on
 * desktop.
 *
 * `handleUpgradeClick` already branched on `isDesktopApp` (desktop skips
 * in-app checkout and sends the user to pricing), but did it with a bare
 * `window.open`, which inside Tauri only opens another WebView window rather
 * than the user's real browser — the same divergence from
 * `invokeTauri('open_url')` that `components/Panel.ts` and
 * `components/ResilienceWidget.ts` already avoid.
 *
 * `external-navigation` is deliberately REAL here; only `isDesktopRuntime`
 * is overridden, so what is asserted is the observable effect (a bridge
 * invocation vs a `window.open`), not that some helper was called.
 *
 * Harness mirrors unified-settings-theater-presets.test.mts: same module
 * mocks, same stub-config shape.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';
import type { SubscriptionInfo } from '@/services/billing';

const session: AuthSession = {
  user: { id: 'A', name: 'User A', email: 'a@example.com', role: 'free' },
  isPending: false,
};

/** Flipped per case; read lazily by the runtime mock below. */
let desktopRuntime = false;
let signedIn = true;
let billingUxState: 'free' | 'lapsed' = 'free';
let mockSubscription: SubscriptionInfo | null = null;

const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => desktopRuntime,
}));

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => signedIn ? session : { ...session, user: null },
  subscribeAuthState: () => () => {},
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => null,
  getEntitlementVerificationStatus: () => 'ready',
  hasFeature: () => false,
  hasEmbedAccessForAccount: () => false,
  // Free tier: the upgrade branch, not the manage-billing branch.
  isEntitled: () => false,
  onEntitlementChange: () => () => {},
  onEntitlementVerificationChange: () => () => {},
}));

vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => false,
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => false,
}));

vi.mock('@/services/preferences-content', () => ({
  renderPreferences: () => ({ html: '', attach: () => () => {} }),
}));

vi.mock('@/services/notifications-settings', () => ({
  renderNotificationsSettings: () => ({ html: '', attach: () => () => {} }),
}));

vi.mock('@/config/feeds', () => ({
  CANONICAL_FEEDS: {},
  INTEL_SOURCES: [],
  SOURCE_REGION_MAP: {},
}));

vi.mock('@/config/panels', () => ({
  PANEL_CATEGORY_MAP: {},
  ALL_PANELS: {},
  VARIANT_DEFAULTS: { full: [] },
  getEffectivePanelConfig: () => ({ name: '', enabled: false }),
  getVariantPanelCategories: () => [],
  isPanelEntitled: () => true,
  FREE_MAX_PANELS: 3,
  countFreePanelCapUsage: () => 0,
  isFreePanelCapCounted: () => false,
}));

vi.mock('@/config/variant', () => ({
  SITE_VARIANT: 'full',
}));

vi.mock('@/services/billing', () => ({
  getSubscription: () => mockSubscription,
  onSubscriptionChange: () => () => {},
  openBillingPortal: async () => ({ outcome: 'no-customer' as const }),
  prereserveBillingPortalTab: () => null,
  listBusinessSeats: async () => ({
    businessSubscriptionId: null,
    ownerDomain: null,
    ownerIsCorporateDomain: false,
    seats: [],
  }),
  inviteBusinessSeats: async () => ({ invited: [] }),
  removeBusinessSeat: async () => ({ status: 'removed' as const }),
}));

// Partial so the real status-tone helpers stay available: a full stub goes
// stale the moment billing-state gains an export the panel renders (#7315).
vi.mock('@/services/billing-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing-state')>()),
  deriveBillingUxState: () => billingUxState,
  getReactivationHref: (planKey: string | null | undefined) => planKey
    ? `/pro?wm_reactivate_plan=${planKey}#pricing`
    : '/pro#pricing',
}));

vi.mock('@/services/api-keys', () => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('@/services/api-plan-limit-notices', () => ({
  acknowledgePlanLimitNotice: vi.fn(),
  listCurrentPlanLimitNotices: vi.fn(),
}));

vi.mock('@/services/mcp-clients', () => ({
  listMcpClients: vi.fn(),
  fetchMcpQuota: vi.fn(),
  revokeMcpClient: vi.fn(),
}));

// The CTA opens the /pro plan picker; it must never start a checkout itself.
const startCheckout = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/services/checkout', () => ({ startCheckout }));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  handleUpgradeClick(): void;
  overlay: HTMLElement;
  render(loadAccountData?: boolean): void;
};

const PRO_URL = 'https://worldmonitor.app/pro';
const PLANS_URL = 'https://worldmonitor.app/pro#pricing';
const DESKTOP_PLANS_URL = 'https://worldmonitor.app/pro?wm_checkout_handoff=desktop#pricing';
const RUNTIMES = [
  ['web', false],
  ['desktop', true],
] as const;

let invocations: Array<{ command: string; payload?: Record<string, unknown> }>;
let settings: InstanceType<typeof UnifiedSettings>;

function config(isDesktopApp: boolean): UnifiedSettingsConfig {
  return {
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key, fallback) => fallback,
    resetLayout: () => {},
    isDesktopApp,
  };
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  invocations = [];
  startCheckout.mockClear();
  signedIn = true;
  billingUxState = 'free';
  mockSubscription = null;
  // The bridge `tauri-bridge.ts` looks for. Present in both cases, so a
  // desktop assertion cannot pass merely because the web case lacked it.
  vi.stubGlobal('__TAURI_INTERNALS__', {
    invoke: async (command: string, payload?: Record<string, unknown>) => {
      invocations.push({ command, payload });
    },
  });
});

afterEach(() => {
  settings?.destroy();
  desktopRuntime = false;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings upgrade click (#5911)', () => {
  it('hands pricing to the OS browser on desktop, opening no WebView window', async () => {
    desktopRuntime = true;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    settings = new UnifiedSettings(config(true));

    (settings as unknown as SettingsInternals).handleUpgradeClick();
    await vi.waitFor(() => expect(invocations.length).toBe(1));

    expect(invocations[0]).toEqual({ command: 'open_url', payload: { url: DESKTOP_PLANS_URL } });
    expect(openSpy).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it('opens the plan picker on the web, not a Pro Monthly checkout', async () => {
    desktopRuntime = false;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    settings = new UnifiedSettings(config(false));

    (settings as unknown as SettingsInternals).handleUpgradeClick();
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());

    expect(openSpy).toHaveBeenCalledWith(PLANS_URL, '_blank');
    expect(startCheckout).not.toHaveBeenCalled();
    expect(invocations).toEqual([]);
  });
});

describe('UnifiedSettings desktop Plan & billing parity (#6108)', () => {
  it.each(RUNTIMES)('renders the signed-in billing tab and canonical fallback plan href on %s', (_runtime, isDesktopApp) => {
    desktopRuntime = isDesktopApp;
    settings = new UnifiedSettings(config(isDesktopApp));
    const internal = settings as unknown as SettingsInternals;

    internal.render(false);

    expect(internal.overlay.querySelector('[data-tab="billing"]')).not.toBeNull();
    expect(internal.overlay.querySelector<HTMLAnchorElement>('.upgrade-pro-cta-link')?.href)
      .toBe(PRO_URL);
  });

  it.each(RUNTIMES)('renders the canonical reactivation href on %s', (_runtime, isDesktopApp) => {
    desktopRuntime = isDesktopApp;
    billingUxState = 'lapsed';
    mockSubscription = {
      planKey: 'pro_annual',
      displayName: 'Pro Annual',
      status: 'cancelled',
      currentPeriodEnd: Date.now() - 1_000,
      renewalVerificationState: null,
    };
    settings = new UnifiedSettings(config(isDesktopApp));
    const internal = settings as unknown as SettingsInternals;

    internal.render(false);

    expect(internal.overlay.querySelector<HTMLAnchorElement>('.upgrade-pro-cta-link')?.href)
      .toBe(`${PRO_URL}?wm_reactivate_plan=pro_annual#pricing`);
  });

  it('keeps the billing tab hidden for a signed-out desktop session', () => {
    desktopRuntime = true;
    signedIn = false;
    settings = new UnifiedSettings(config(true));
    const internal = settings as unknown as SettingsInternals;

    internal.render(false);

    expect(internal.overlay.querySelector('[data-tab="billing"]')).toBeNull();
  });
});
