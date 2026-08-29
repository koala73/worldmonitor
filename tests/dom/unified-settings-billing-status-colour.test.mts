/**
 * #7315 — A paid-through cancellation must not be painted in the same red as a
 * dead `expired` account. A subscriber who cancelled with weeks of Pro left saw
 * a red dot, red plan name and red-tinted card above small text saying "access
 * until <date>"; the colour won, and support got a refund demand 13 minutes
 * after the cancellation.
 *
 * These assertions are on the COLOUR, deliberately: the copy was already
 * correct before the fix, so a copy-only test passed against the bug.
 *
 * Harness mirrors unified-settings-subscription-loading.test.mts, except that
 * `@/services/billing-state` is NOT stubbed — the point of the fix is that the
 * panel and the real coverage predicate cannot drift.
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

const DAY = 86_400_000;

/** Read lazily by the billing mock below; set per case. */
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

// Entitled with a settled entitlement snapshot, so renderUpgradeSection reaches
// the plan-status render rather than either "Checking your plan…" guard.
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
  isSubscriptionLoaded: () => true,
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

function subscription(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    planKey: 'pro_monthly',
    displayName: 'Pro',
    status: 'active',
    currentPeriodEnd: Date.now() + 30 * DAY,
    renewalVerificationState: null,
    ...overrides,
  };
}

/**
 * The plan card's billing tone — the class/token the 13px plan name reads.
 * Matched off the rendered markup so a change to the dot/border alone cannot
 * fake this pass. Hex contrast is locked in tests/contrast.test.mts against
 * the theme tokens; this file locks which tone the coverage predicate picks.
 */
function planTone(html: string): string | null {
  return html.match(/data-billing-tone="([a-z]+)"/)?.[1] ?? null;
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
  mockSubscription = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings billing status colour (#7315)', () => {
  it('paints a paid-through cancellation non-red and keeps the access-until copy', () => {
    mockSubscription = subscription({
      status: 'cancelled',
      currentPeriodEnd: Date.now() + 30 * DAY,
    });
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();

    expect(html).toContain('access until');
    expect(html).toContain('class="upgrade-pro-plan-name"');
    expect(planTone(html)).toBe('ending');
    // Not the ended tone — the dot, the plan name, the border and the
    // background tint all derive from the same data-billing-tone.
    expect(html).not.toContain('data-billing-tone="ended"');
  });

  it('paints a cancellation past its paid period red', () => {
    mockSubscription = subscription({
      status: 'cancelled',
      currentPeriodEnd: Date.now() - DAY,
    });
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();

    expect(planTone(html)).toBe('ended');
  });

  it('paints expired red, even with a future period end', () => {
    mockSubscription = subscription({
      status: 'expired',
      currentPeriodEnd: Date.now() + 30 * DAY,
    });
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();

    expect(planTone(html)).toBe('ended');
  });

  it('leaves active green and on_hold yellow', () => {
    mockSubscription = subscription({ status: 'active' });
    expect(planTone((settings as unknown as SettingsInternals).renderUpgradeSection()))
      .toBe('active');

    mockSubscription = subscription({ status: 'on_hold' });
    expect(planTone((settings as unknown as SettingsInternals).renderUpgradeSection()))
      .toBe('attention');
  });

  it('paints a Business-grant invitee (no own subscription row) green', () => {
    // The invitee holds a grant, not a subscription row. Pre-#7315 the panel
    // defaulted the missing status to 'active' to dodge the red trailing else;
    // the tone mapping must keep that user green.
    mockSubscription = null;
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();

    expect(html).toContain('managed by your plan owner');
    expect(planTone(html)).toBe('active');
  });

  it('paints an unrecognised provider status neutral, not red', () => {
    // Dodo adding a status we do not model must not tell an entitled user their
    // plan is dead — the trailing `else` that swallowed every unknown status
    // into red is the "branch on known strings, mishandle the rest" gotcha.
    mockSubscription = subscription({ status: 'paused' as unknown as 'active' });
    const html = (settings as unknown as SettingsInternals).renderUpgradeSection();

    expect(planTone(html)).toBe('unknown');
    expect(html).not.toContain('data-billing-tone="ended"');
    // Asserting the colour alone would let the card ship as a bare grey dot
    // with no sentence at all, which is what the old trailing `else` produced.
    expect(html).toContain('See Manage Billing for your current plan details.');
  });
});
