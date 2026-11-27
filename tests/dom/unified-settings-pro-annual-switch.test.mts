/**
 * The Settings billing section is the dashboard's entry point for the in-place
 * Pro Monthly -> Pro Yearly switch: ProBanner is suppressed for paying users
 * (decideProBannerMount, the fade-out and the pre-paint premium hint), so the
 * switch lives where a Pro Monthly owner already manages billing.
 *
 * Harness mirrors unified-settings-subscription-loading.test.mts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { I18N_RESOURCES_LOADED_EVENT } from '@/services/i18n';
import { ACTIVE_PROMO } from '../../shared/promo-campaign';
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
vi.mock('@/services/checkout', () => ({ startProAnnualSwitch }));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  renderUpgradeSection(): string;
  replaceUpgradeSection(): void;
  overlay: HTMLElement;
  switchPromoPricesLoad: Promise<void> | null;
  switchPromoExpiryTimer: ReturnType<typeof setTimeout> | null;
};

const PROMO = ACTIVE_PROMO!;

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

const DURING_OFFER = Date.UTC(2026, 10, 27, 12, 0, 0);
const AFTER_OFFER = Date.UTC(2026, 11, 5, 0, 0, 0);

function proSubscription(planKey: string, status: SubscriptionInfo['status'] = 'active'): SubscriptionInfo {
  return { planKey, displayName: 'Pro', status, currentPeriodEnd: Date.now() + 1e9, renewalVerificationState: null };
}

async function renderSettled(): Promise<string> {
  const internal = settings as unknown as SettingsInternals;
  internal.renderUpgradeSection();
  await internal.switchPromoPricesLoad;
  return internal.renderUpgradeSection();
}

describe('UnifiedSettings Pro Monthly -> Pro Yearly switch', () => {
  afterEach(() => { vi.useRealTimers(); startProAnnualSwitch.mockClear(); });

  it('offers the switch with the offer line while the promotion runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: DURING_OFFER });
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    const html = await renderSettled();
    expect(html).toContain('<button type="button" class="switch-to-yearly-btn">Switch to yearly</button>');
    // The 70% is against twelve monthly payments, so the monthly price sits beside it.
    expect(html).toContain('Black Friday: $12.00 a month instead of $39.99, billed yearly. That is 70% less than paying monthly for your first year. Renews at $359.99 a year. Cancel anytime.');
  });

  it('keeps the switch at list price after the promotion, without the offer line', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: AFTER_OFFER });
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    const html = await renderSettled();
    expect(html).toContain('Switch to yearly');
    expect(html).not.toContain('Black Friday');
  });

  it.each([
    ['pro_annual', 'active'],
    ['pro_business_monthly', 'active'],
    ['api_starter', 'active'],
    ['pro_monthly', 'on_hold'],
  ] as const)('does not offer the switch to %s (%s)', async (planKey, status) => {
    vi.useFakeTimers({ toFake: ['Date'], now: DURING_OFFER });
    subscriptionLoaded = true;
    mockSubscription = proSubscription(planKey, status);
    const html = await renderSettled();
    expect(html).not.toContain('switch-to-yearly-btn');
    expect(html).not.toContain('Black Friday');
  });

  it('drops the offer line at the promotion end while Settings stays open, and keeps the switch', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: PROMO.endsAtMs - 60_000 });
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    await internal.switchPromoPricesLoad;
    expect(internal.overlay.querySelector('.upgrade-pro-offer-line')).not.toBeNull();

    vi.advanceTimersByTime(60_000);

    expect(internal.overlay.querySelector('.upgrade-pro-offer-line')).toBeNull();
    expect(internal.overlay.querySelector('.switch-to-yearly-btn')).not.toBeNull();
  });

  // Settings can render before the full catalog arrives: the offer line then
  // shows its raw key, and the catalog-loaded healer only knows the template.
  // The line must be rebuilt with its prices, not left with {{placeholders}}.
  it('rebuilds the offer line with its prices when the catalog finishes loading', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: DURING_OFFER });
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    await internal.switchPromoPricesLoad;
    internal.replaceUpgradeSection();
    const line = internal.overlay.querySelector<HTMLElement>('.upgrade-pro-offer-line')!;
    line.textContent = 'settings.account.switchYearly.offerLine';
    window.dispatchEvent(new Event(I18N_RESOURCES_LOADED_EVENT));
    const healed = internal.overlay.querySelector<HTMLElement>('.upgrade-pro-offer-line')!.textContent ?? '';
    expect(healed).not.toContain('{{');
    expect(healed).toContain('$12.00 a month instead of $39.99');
  });

  it('clears the offer expiry timer when Settings closes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: PROMO.endsAtMs - 60_000 });
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    await internal.switchPromoPricesLoad;
    expect(internal.switchPromoExpiryTimer).not.toBeNull();
    settings.close();
    expect(internal.switchPromoExpiryTimer).toBeNull();
  });

  it('opens the switch flow for the subscription plan on click', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.switch-to-yearly-btn')!.click();
    await vi.waitFor(() => expect(startProAnnualSwitch).toHaveBeenCalledTimes(1));
    expect(startProAnnualSwitch.mock.calls[0]?.[0]).toBe('pro_monthly');
  });

  // The dialog takes focus; a keyboard user who dismisses it lands back on
  // the button that opened it, even after the section re-rendered.
  it('returns focus to the switch button when the switch dialog is dismissed', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.switch-to-yearly-btn')!.click();
    await vi.waitFor(() => expect(startProAnnualSwitch).toHaveBeenCalledTimes(1));
    const onDismiss = startProAnnualSwitch.mock.calls[0]?.[2];
    expect(typeof onDismiss).toBe('function');
    const original = internal.overlay.querySelector<HTMLButtonElement>('.switch-to-yearly-btn');
    (document.activeElement as HTMLElement | null)?.blur();
    internal.replaceUpgradeSection();
    onDismiss!();
    const button = internal.overlay.querySelector<HTMLButtonElement>('.switch-to-yearly-btn');
    expect(button).not.toBeNull();
    expect(button).not.toBe(original);
    expect(document.activeElement).toBe(button);
  });

  it('leaves focus alone when Settings has closed before the dialog is dismissed', async () => {
    subscriptionLoaded = true;
    mockSubscription = proSubscription('pro_monthly');
    settings.open('account');
    const internal = settings as unknown as SettingsInternals;
    internal.overlay.querySelector<HTMLButtonElement>('.switch-to-yearly-btn')!.click();
    await vi.waitFor(() => expect(startProAnnualSwitch).toHaveBeenCalledTimes(1));
    settings.close();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    startProAnnualSwitch.mock.calls[0]?.[2]?.();
    expect(document.activeElement).toBe(outside);
  });
});
