/**
 * #6772 — An entitled Pro owner whose subscription watch has not settled yet
 * (getSubscription() === null because isSubscriptionLoaded() is still false)
 * must NOT be shown the Business-invitee copy "Billing is managed by your plan
 * owner" — that hides Manage Billing from a paying owner. The unresolved window
 * renders the same "Checking your plan…" pending state the pre-entitlement
 * guard uses; the invitee copy is reserved for a *settled* null.
 *
 * Harness mirrors unified-settings-upgrade-click-runtime.test.mts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';
import type { SubscriptionInfo } from '@/services/billing';

const session: AuthSession = {
  user: { id: 'A', name: 'Owner A', email: 'owner@example.com', role: 'pro' },
  isPending: false,
};

/** Both flipped per case; read lazily by the billing mock below. */
let subscriptionLoaded = false;
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
  isDesktopRuntime: () => false,
}));

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: () => () => {},
}));

// Entitled, and the entitlement snapshot has already resolved (non-null), so
// the pre-entitlement "Checking your plan…" guard is skipped — any pending
// render in these cases must come from the new subscription-unresolved guard.
vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => ({ planKey: 'pro_monthly', validUntil: Date.now() + 1e9 }),
  getEntitlementVerificationStatus: () => 'ready',
  hasFeature: () => true,
  isEntitled: () => true,
  onEntitlementChange: () => () => {},
  onEntitlementVerificationChange: () => () => {},
}));

vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => true,
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => true,
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
  isSubscriptionLoaded: () => subscriptionLoaded,
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
  deriveBillingUxState: () => 'active',
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

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  renderUpgradeSection(): string;
};

let settings: InstanceType<typeof UnifiedSettings>;

function config(): UnifiedSettingsConfig {
  return {
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key, fallback) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  };
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  settings = new UnifiedSettings(config());
});

afterEach(() => {
  settings?.destroy();
  subscriptionLoaded = false;
  mockSubscription = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings subscription loaded-vs-absent (#6772)', () => {
  it('shows the pending state (not invitee copy) while the subscription watch is unresolved', () => {
    subscriptionLoaded = false;
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();
    expect(html).toContain('Checking your plan');
    expect(html).not.toContain('managed by your plan owner');
  });

  it('shows the Business-invitee copy once the watch settles to a null subscription', () => {
    subscriptionLoaded = true;
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();
    expect(html).toContain('Billing is managed by your plan owner');
    expect(html).not.toContain('Checking your plan');
  });

  it('shows the active plan and Manage Billing when the watch settles to a present subscription', () => {
    // The guard is scoped to `sub === null`: a settled owner WITH a subscription
    // must reach the active render (and its Manage Billing CTA), never pending
    // or invitee copy. Guards against a future widening that drops `sub === null`.
    subscriptionLoaded = true;
    mockSubscription = {
      planKey: 'pro_monthly',
      displayName: 'Pro',
      status: 'active',
      currentPeriodEnd: Date.now() + 1e9,
      renewalVerificationState: null,
    };
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();
    expect(html).toContain('Manage Billing');
    expect(html).not.toContain('Checking your plan');
    expect(html).not.toContain('managed by your plan owner');
  });
});
