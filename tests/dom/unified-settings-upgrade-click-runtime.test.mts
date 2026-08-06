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

const session: AuthSession = {
  user: { id: 'A', name: 'User A', email: 'a@example.com', role: 'free' },
  isPending: false,
};

/** Flipped per case; read lazily by the runtime mock below. */
let desktopRuntime = false;

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
  getAuthState: () => session,
  subscribeAuthState: () => () => {},
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => null,
  hasFeature: () => false,
  // Free tier: the upgrade branch, not the manage-billing branch.
  isEntitled: () => false,
  onEntitlementChange: () => () => {},
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
  getSubscription: () => null,
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

vi.mock('@/services/billing-state', () => ({
  deriveBillingUxState: () => 'free',
  getReactivationHref: () => '/pro#pricing',
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

// Force the web branch down its `.catch(...)` fallback deterministically.
// Without this the web case asserted nothing: startCheckout would take over
// and no window.open would ever happen, which the old `.every(...)` check
// reported as a pass.
vi.mock('@/services/checkout', () => ({
  startCheckout: () => Promise.reject(new Error('checkout unavailable in test')),
}));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  handleUpgradeClick(): void;
};

const PRO_URL = 'https://worldmonitor.app/pro';

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

    expect(invocations[0]).toEqual({ command: 'open_url', payload: { url: PRO_URL } });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('leaves the web path on window.open and never touches the native bridge', async () => {
    desktopRuntime = false;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    settings = new UnifiedSettings(config(false));

    (settings as unknown as SettingsInternals).handleUpgradeClick();
    // The web branch reaches its fallback only after the lazy checkout import
    // rejects (mocked at module scope above), so wait for the real call.
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());

    // Positive assertion on purpose: the earlier `.every(...)` form was
    // vacuously true on an empty call list, so it passed whether or not the
    // web branch ran at all.
    expect(openSpy).toHaveBeenCalledWith(PRO_URL, '_blank');
    expect(invocations).toEqual([]);
  });
});
