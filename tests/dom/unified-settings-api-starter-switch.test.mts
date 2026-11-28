/**
 * Settings → Account is the dashboard's entry point for the in-place
 * individual Pro → API Starter switch, next to the Pro Yearly switch.
 *
 * Harness mirrors unified-settings-pro-annual-switch.test.mts.
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
  hasEmbedAccessForAccount: () => true,
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
  renderPreferenceSection: () => ({ html: '', attach: () => () => {} }),
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
  openBillingPortal,
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

// Partial: only the UX-state verdict is pinned for this file's cases. The
// status-tone helpers stay real so a new billing-state export cannot silently
// leave this stub short (#7315).
vi.mock('@/services/billing-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing-state')>()),
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

const startProAnnualSwitch = vi.hoisted(() => vi.fn(
  async (_planKey: unknown, _fallback: () => void, _onDismiss?: () => void) => {},
));
const startApiStarterSwitch = vi.hoisted(() => vi.fn(
  async (_onDismiss?: () => void): Promise<'shown' | 'not-switchable'> => 'shown',
));
vi.mock('@/services/checkout', () => ({ startProAnnualSwitch, startApiStarterSwitch }));

const openBillingPortal = vi.hoisted(() => vi.fn(async (_win?: unknown) => ({ outcome: 'opened' as const })));

const showToast = vi.hoisted(() => vi.fn((_message: string) => {}));
vi.mock('@/utils/toast', () => ({ showToast }));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  planLimitNotices: unknown[];
  handlePlanLimitNoticeCta(noticeId: string): void;
  renderUpgradeSection(): string;
  replaceUpgradeSection(): void;
  overlay: HTMLElement;
  switchPromoPricesLoad: Promise<void> | null;
  switchPromoExpiryTimer: ReturnType<typeof setTimeout> | null;
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

function proSubscription(planKey: string, status: SubscriptionInfo['status'] = 'active'): SubscriptionInfo {
  return { planKey, displayName: 'Pro', status, currentPeriodEnd: Date.now() + 1e9, renewalVerificationState: null };
}

async function renderSettled(): Promise<string> {
  const internal = settings as unknown as SettingsInternals;
  internal.renderUpgradeSection();
  await internal.switchPromoPricesLoad;
  return internal.renderUpgradeSection();
}

const BUTTON = '<button type="button" class="switch-to-api-starter-btn">Switch to API Starter</button>';

describe('UnifiedSettings Pro -> API Starter switch', () => {
  afterEach(() => { startApiStarterSwitch.mockClear(); showToast.mockClear(); openBillingPortal.mockClear(); });

  it.each(['pro_monthly', 'pro_monthly_mcp', 'pro_annual'])('offers the switch to an active %s owner', async (planKey) => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription(planKey);
    expect(await renderSettled()).toContain(BUTTON);
  });

  it('sits beside the Pro Yearly switch for a Pro Monthly owner', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    const html = await renderSettled();
    expect(html).toContain('switch-to-yearly-btn');
    expect(html.indexOf('switch-to-yearly-btn')).toBeLessThan(html.indexOf('switch-to-api-starter-btn'));
    expect(html.indexOf('switch-to-api-starter-btn')).toBeLessThan(html.indexOf('manage-billing-btn'));
  });

  it.each([
    ['api_starter', 'active'],
    ['api_starter_annual', 'active'],
    ['api_business_monthly', 'active'],
    ['pro_business_monthly', 'active'],
    ['enterprise', 'active'],
    ['pro_monthly', 'on_hold'],
    ['pro_annual', 'cancelled'],
  ] as const)('does not offer the switch to %s (%s)', async (planKey, status) => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription(planKey, status);
    expect(await renderSettled()).not.toContain('switch-to-api-starter-btn');
  });

  it('does not offer the switch to a Pro Business invitee with no own subscription', async () => {
    subscriptionLoaded = true;
    mockSubscription = null;
    expect(await renderSettled()).not.toContain('switch-to-api-starter-btn');
  });

  it('opens the switch flow on click', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_annual');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.switch-to-api-starter-btn')!.click();
    await vi.waitFor(() => expect(startApiStarterSwitch).toHaveBeenCalledTimes(1));
    expect(typeof startApiStarterSwitch.mock.calls[0]?.[0]).toBe('function');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says the switch is unavailable when no quote comes back', async () => {
    startApiStarterSwitch.mockResolvedValueOnce('not-switchable');
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.switch-to-api-starter-btn')!.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast.mock.calls[0]?.[0]).toMatch(/^We could not price the switch right now\./);
  });

  it('returns focus to the switch button when the switch dialog is dismissed', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.switch-to-api-starter-btn')!.click();
    await vi.waitFor(() => expect(startApiStarterSwitch).toHaveBeenCalledTimes(1));
    const onDismiss = startApiStarterSwitch.mock.calls[0]?.[0];
    const original = internal.overlay.querySelector<HTMLButtonElement>('.switch-to-api-starter-btn');
    (document.activeElement as HTMLElement | null)?.blur();
    internal.replaceUpgradeSection();
    onDismiss!();
    const button = internal.overlay.querySelector<HTMLButtonElement>('.switch-to-api-starter-btn');
    expect(button).not.toBeNull();
    expect(button).not.toBe(original);
    expect(document.activeElement).toBe(button);
  });

  // A capped Pro caller is told to buy API Starter; the billing portal cannot
  // move Pro to API Starter, so an individual Pro owner gets the switch.
  const CAPPED = {
    _id: 'n1', userId: 'A', planKey: 'pro_monthly', dimension: 'mcpCallsPerDay', state: 'limit',
    windowKey: 'w', usage: 50, limit: 50, usageRatio: 1, upgradeTargetPlanKey: 'api_starter', ctaKind: 'checkout',
  };

  it('opens the switch from a capped plan-limit notice for an individual Pro owner', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_annual');
    const internal = settings as unknown as SettingsInternals;
    internal.planLimitNotices = [CAPPED];
    internal.handlePlanLimitNoticeCta('n1');
    await vi.waitFor(() => expect(startApiStarterSwitch).toHaveBeenCalledTimes(1));
    expect(openBillingPortal).not.toHaveBeenCalled();
  });

  it('keeps the billing portal for an entitled caller the server would not switch', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_business_monthly');
    const internal = settings as unknown as SettingsInternals;
    internal.planLimitNotices = [{ ...CAPPED, planKey: 'pro_business_monthly' }];
    internal.handlePlanLimitNoticeCta('n1');
    await vi.waitFor(() => expect(openBillingPortal).toHaveBeenCalledTimes(1));
    expect(startApiStarterSwitch).not.toHaveBeenCalled();
  });
});
