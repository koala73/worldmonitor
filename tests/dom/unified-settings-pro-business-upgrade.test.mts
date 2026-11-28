/**
 * Settings → Account is the dashboard's entry point for the in-place
 * Pro → Pro Business upgrade, beside the Pro Yearly and API Starter switches.
 * Before it, the only way in was clicking a Pro Business checkout while
 * already on Pro, and no Pro owner found it.
 *
 * Harness mirrors unified-settings-api-starter-switch.test.mts.
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
const startProBusinessUpgrade = vi.hoisted(() => vi.fn(
  async (_planKey: unknown, _fallback: () => void, _onDismiss?: () => void) => {},
));
vi.mock('@/services/checkout', () => ({ startProAnnualSwitch, startApiStarterSwitch, startProBusinessUpgrade }));

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

const BUTTON = '<button type="button" class="upgrade-to-pro-business-btn">Upgrade to Pro Business</button>';

describe('UnifiedSettings Pro -> Pro Business upgrade', () => {
  afterEach(() => { startProBusinessUpgrade.mockClear(); showToast.mockClear(); });

  it.each(['pro_monthly', 'pro_monthly_mcp', 'pro_annual'])('offers the upgrade to an active %s owner', async (planKey) => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription(planKey);
    expect(await renderSettled()).toContain(BUTTON);
  });

  // The Pro Yearly offer line sits above its own button; the upgrade comes
  // after that pair so the offer never reads as a Pro Business price.
  it('sits after the Pro Yearly offer and switch, before API Starter and Manage Billing', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    const html = await renderSettled();
    expect(html.indexOf('switch-to-yearly-btn')).toBeLessThan(html.indexOf('upgrade-to-pro-business-btn'));
    expect(html.indexOf('upgrade-to-pro-business-btn')).toBeLessThan(html.indexOf('switch-to-api-starter-btn'));
    expect(html.indexOf('upgrade-to-pro-business-btn')).toBeLessThan(html.indexOf('manage-billing-btn'));
  });

  it.each([
    ['pro_business_monthly', 'active'],
    ['pro_business_annual', 'active'],
    ['api_starter', 'active'],
    ['api_business_monthly', 'active'],
    ['enterprise', 'active'],
    ['pro_monthly', 'on_hold'],
    ['pro_annual', 'cancelled'],
  ] as const)('does not offer the upgrade to %s (%s)', async (planKey, status) => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription(planKey, status);
    expect(await renderSettled()).not.toContain('upgrade-to-pro-business-btn');
  });

  it('does not offer the upgrade to a Business invitee with no own subscription', async () => {
    subscriptionLoaded = true;
    mockSubscription = null;
    expect(await renderSettled()).not.toContain('upgrade-to-pro-business-btn');
  });

  it('opens the upgrade flow for the held plan on click', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_annual');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.upgrade-to-pro-business-btn')!.click();
    await vi.waitFor(() => expect(startProBusinessUpgrade).toHaveBeenCalledTimes(1));
    expect(startProBusinessUpgrade.mock.calls[0]?.[0]).toBe('pro_annual');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says the upgrade is unavailable when no quote comes back', async () => {
    startProBusinessUpgrade.mockImplementationOnce(async (_planKey, fallback) => { fallback(); });
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.upgrade-to-pro-business-btn')!.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast.mock.calls[0]?.[0]).toMatch(/^We could not price the upgrade right now\./);
  });

  it('returns focus to the upgrade button when the dialog is dismissed', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.upgrade-to-pro-business-btn')!.click();
    await vi.waitFor(() => expect(startProBusinessUpgrade).toHaveBeenCalledTimes(1));
    const onDismiss = startProBusinessUpgrade.mock.calls[0]?.[2];
    const original = internal.overlay.querySelector<HTMLButtonElement>('.upgrade-to-pro-business-btn');
    (document.activeElement as HTMLElement | null)?.blur();
    internal.replaceUpgradeSection();
    onDismiss!();
    const button = internal.overlay.querySelector<HTMLButtonElement>('.upgrade-to-pro-business-btn');
    expect(button).not.toBeNull();
    expect(button).not.toBe(original);
    expect(document.activeElement).toBe(button);
  });
});
