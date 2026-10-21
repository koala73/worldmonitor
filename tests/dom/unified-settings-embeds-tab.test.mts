/**
 * Settings -> Embeds: self-serve `wme_` key minting.
 *
 * The gate is the point of this file. `embedAccess` and `apiAccess` are
 * different catalog flags and both Pro tiers ship `apiAccess: false`, so an
 * Embeds surface hung off the API Keys tab would be invisible to most of the
 * customers who bought embedding. These tests drive the real render/click
 * paths with each flag independently on and off.
 *
 * Harness mirrors unified-settings-theater-presets.test.mts: same module
 * mocks, same stub-config shape, same overlay activation flow.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';
import type { EntitlementState } from '@/services/entitlements';
import type { EmbedKeyInfo } from '@/services/embed-keys';

const session: AuthSession = {
  user: { id: 'A', name: 'User A', email: 'a@example.com', role: 'pro' },
  isPending: false,
};

/** Mutated per test; every hasFeature() answer is read through this. */
const features = { apiAccess: false, mcpAccess: false, embedAccess: true };

const entitlementState: EntitlementState = {
  planKey: 'pro',
  features: {
    tier: 1,
    apiAccess: false,
    apiRateLimit: 0,
    maxDashboards: 10,
    prioritySupport: true,
    exportFormats: [],
    embedAccess: true,
  },
  validUntil: Date.now() + 86_400_000,
};

const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: () => () => {},
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => entitlementState,
  getEntitlementVerificationStatus: () => 'ready',
  hasFeature: (flag: string) => Boolean((features as Record<string, boolean>)[flag]),
  hasEmbedAccessForAccount: (role: 'free' | 'pro' | undefined) => (
    role === 'pro' || features.embedAccess
  ),
  isEntitled: () => true,
  onEntitlementChange: () => () => {},
  onEntitlementVerificationChange: () => () => {},
}));

vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => true }));
vi.mock('@/services/widget-store', () => ({ isProUser: () => true }));

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

vi.mock('@/config/variant', () => ({ SITE_VARIANT: 'full' }));

vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
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

const PLAINTEXT = `wme_${'ab12cd34ef'.repeat(4)}`;
let embedKeyRows: EmbedKeyInfo[] = [];
const createEmbedKey = vi.fn(async (name: string) => {
  embedKeyRows = [
    ...embedKeyRows,
    { id: 'ek_1', name, keyPrefix: PLAINTEXT.slice(0, 9), createdAt: 1_756_000_000_000 },
  ];
  return { id: 'ek_1', name, keyPrefix: PLAINTEXT.slice(0, 9), key: PLAINTEXT };
});
const listEmbedKeys = vi.fn(async () => embedKeyRows);
const revokeEmbedKey = vi.fn(async (_keyId: string) => {});

vi.mock('@/services/embed-keys', () => ({
  createEmbedKey: (name: string) => createEmbedKey(name),
  listEmbedKeys: () => listEmbedKeys(),
  revokeEmbedKey: (id: string) => revokeEmbedKey(id),
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
  overlay: HTMLElement;
  render(loadAccountData?: boolean): void;
  handleAccountIdentityChange(userId: string): void;
};

let settings: InstanceType<typeof UnifiedSettings>;
let internal: SettingsInternals;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mount(): void {
  settings = new UnifiedSettings({
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set<string>(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key, fallback) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  } satisfies UnifiedSettingsConfig);
  internal = settings as unknown as SettingsInternals;
  internal.overlay.classList.add('active');
}

const tabButton = (id: string) =>
  internal.overlay.querySelector<HTMLButtonElement>(`.unified-settings-tab[data-tab="${id}"]`);
const panel = (id: string) =>
  internal.overlay.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);

/** Render, then reach the tab the way a user does — through switchTab. */
function openEmbedsTab(): void {
  internal.render(false);
  tabButton('embeds')!.click();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  session.user = { id: 'A', name: 'User A', email: 'a@example.com', role: 'pro' };
  document.body.replaceChildren();
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  features.apiAccess = false;
  features.mcpAccess = false;
  features.embedAccess = true;
  embedKeyRows = [];
  createEmbedKey.mockClear();
  listEmbedKeys.mockClear();
  revokeEmbedKey.mockClear();
  mount();
});

afterEach(() => {
  settings.destroy();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
});

describe('Settings -> Embeds tab gating', () => {
  it('shows the tab for a plan with embedAccess but no apiAccess', () => {
    // The load-bearing case: Pro sells embedding without REST access, and the
    // API Keys tab renders an upgrade CTA for exactly this account.
    internal.render(false);

    expect(tabButton('embeds')).not.toBeNull();
    expect(panel('embeds')).not.toBeNull();
    expect(panel('embeds')?.textContent).toContain('Create Embed Key');
    expect(panel('api-keys')?.textContent).toContain('Upgrade to API Starter');
  });

  it('shows the tab for a verified Clerk PRO role before Convex entitlement hydration', () => {
    features.embedAccess = false;
    internal.render(false);

    expect(tabButton('embeds')).not.toBeNull();
    expect(panel('embeds')?.textContent).toContain('Create Embed Key');
  });

  it('hides the tab entirely without embedAccess, even with apiAccess', () => {
    session.user = { id: 'A', name: 'User A', email: 'a@example.com', role: 'free' };
    features.embedAccess = false;
    features.apiAccess = true;
    internal.render(false);

    expect(tabButton('embeds')).toBeNull();
    expect(panel('embeds')).toBeNull();
    expect(tabButton('api-keys')).not.toBeNull();
  });

  it('states that an embed key is meant to be published, unlike an API key', () => {
    internal.render(false);
    const note = panel('embeds')?.querySelector('.embed-keys-note')?.textContent ?? '';

    expect(note).toContain('meant to be public');
    expect(note).toContain('wm_');
    expect(note).toContain('REST allowance');
  });

  it('distinguishes new reads, rendered panels, and existing map grants on revocation', () => {
    internal.render(false);
    const note = panel('embeds')?.querySelector('.embed-keys-note')?.textContent ?? '';

    expect(note).toContain('New reads with a revoked key are denied within about a minute');
    expect(note).toContain('Already rendered paid-only panels remain visible until reload');
    expect(note).toContain('30 more minutes');
  });

  it('says the key is shown once BEFORE anyone clicks create', () => {
    // The banner says it after the fact, which is too late to be a warning.
    internal.render(false);
    const desc = panel('embeds')?.querySelector('.embed-keys-desc')?.textContent ?? '';

    expect(desc).toContain('shown once at creation');
  });
});

describe('Settings -> Embeds key lifecycle', () => {
  const input = () => panel('embeds')!.querySelector<HTMLInputElement>('.embed-keys-name-input')!;
  const button = () => panel('embeds')!.querySelector<HTMLButtonElement>('.embed-keys-create-btn')!;
  const enter = (name = 'marketing-site') => {
    input().value = name;
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  it('keeps one mint pending across repeated Enter and a rerender', async () => {
    const pending = deferred<Awaited<ReturnType<typeof createEmbedKey>>>();
    createEmbedKey.mockImplementationOnce(() => pending.promise);
    openEmbedsTab();
    enter();
    enter();
    expect(createEmbedKey).toHaveBeenCalledTimes(1);
    internal.render(false);
    expect(button().disabled).toBe(true);
    enter();
    expect(createEmbedKey).toHaveBeenCalledTimes(1);

    pending.resolve({ id: 'ek_1', name: 'marketing-site', keyPrefix: PLAINTEXT.slice(0, 9), key: PLAINTEXT });
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(input().value).toBe('');
    expect(internal.overlay.querySelector('#usEmbedKeysBanner')?.textContent).toContain(PLAINTEXT);
  });

  it('allows retry after a failed mint, including a rerender while pending', async () => {
    const pending = deferred<Awaited<ReturnType<typeof createEmbedKey>>>();
    createEmbedKey.mockImplementationOnce(() => pending.promise);
    openEmbedsTab();
    enter();
    internal.render(false);
    pending.reject(new Error('Temporary failure'));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(internal.overlay.querySelector('#usEmbedKeysError')?.textContent).toContain('Temporary failure');
    enter();
    await vi.waitFor(() => expect(createEmbedKey).toHaveBeenCalledTimes(2));
  });

  it('does not let an old account completion unlock a new account mint or expose its key', async () => {
    const first = deferred<Awaited<ReturnType<typeof createEmbedKey>>>();
    const second = deferred<Awaited<ReturnType<typeof createEmbedKey>>>();
    createEmbedKey.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    openEmbedsTab();
    enter('account-a');
    session.user = { id: 'B', name: 'User B', email: 'b@example.com', role: 'pro' };
    internal.handleAccountIdentityChange('B');
    enter('account-b');
    expect(createEmbedKey).toHaveBeenCalledTimes(2);
    first.resolve({ id: 'a', name: 'account-a', keyPrefix: 'wme_a', key: 'wme_account_a' });
    await first.promise;
    await Promise.resolve();
    expect(button().disabled).toBe(true);
    enter('account-b');
    expect(createEmbedKey).toHaveBeenCalledTimes(2);
    expect(internal.overlay.textContent).not.toContain('wme_account_a');
    second.resolve({ id: 'b', name: 'account-b', keyPrefix: 'wme_b', key: 'wme_account_b' });
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(internal.overlay.querySelector('#usEmbedKeysBanner')?.textContent).toContain('wme_account_b');
  });

  it('mints a key, shows the plaintext once, and keeps it out of the list', async () => {
    openEmbedsTab();
    const input = panel('embeds')!.querySelector<HTMLInputElement>('.embed-keys-name-input')!;
    input.value = 'marketing-site';

    panel('embeds')!.querySelector<HTMLButtonElement>('.embed-keys-create-btn')!.click();
    await vi.waitFor(() => expect(listEmbedKeys).toHaveBeenCalled());

    expect(createEmbedKey).toHaveBeenCalledWith('marketing-site');

    const banner = internal.overlay.querySelector<HTMLElement>('#usEmbedKeysBanner')!;
    expect(banner.style.display).toBe('block');
    expect(banner.textContent).toContain(PLAINTEXT);
    expect(banner.textContent).toContain("won't be shown again");

    await vi.waitFor(() => {
      const list = internal.overlay.querySelector<HTMLElement>('#usEmbedKeysList')!;
      expect(list.textContent).toContain('marketing-site');
    });
    const list = internal.overlay.querySelector<HTMLElement>('#usEmbedKeysList')!;
    // The row shows the 9-char display prefix and nothing more; the plaintext
    // exists only in the banner and only until the next render.
    expect(list.textContent).toContain(PLAINTEXT.slice(0, 9));
    expect(list.textContent).not.toContain(PLAINTEXT);
    expect(input.value).toBe('');
  });

  it('revokes through the real click delegation once confirmed', async () => {
    embedKeyRows = [{ id: 'ek_9', name: 'old-site', keyPrefix: 'wme_00001', createdAt: 1 }];
    openEmbedsTab();
    await vi.waitFor(() => expect(listEmbedKeys).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(internal.overlay.querySelector('.embed-keys-revoke-btn')).not.toBeNull(),
    );

    vi.stubGlobal('confirm', () => false);
    internal.overlay.querySelector<HTMLButtonElement>('.embed-keys-revoke-btn')!.click();
    expect(revokeEmbedKey).not.toHaveBeenCalled();

    const confirmRevoke = vi.fn((_message: string) => true);
    vi.stubGlobal('confirm', confirmRevoke);
    internal.overlay.querySelector<HTMLButtonElement>('.embed-keys-revoke-btn')!.click();
    await vi.waitFor(() => expect(revokeEmbedKey).toHaveBeenCalledWith('ek_9'));
    expect(confirmRevoke.mock.calls[0]?.[0]).toContain('New reads with this key will be denied within about a minute');
    expect(confirmRevoke.mock.calls[0]?.[0]).toContain('Already rendered paid-only panels remain visible until reload');
  });

  it('never sends a revoke to the API-key service, or a mint to the embed one', async () => {
    // The two tabs share a layout and a shape of handler. They must not share
    // a service: revoking here must not touch userApiKeys.
    const apiKeys = await import('@/services/api-keys');
    embedKeyRows = [{ id: 'ek_9', name: 'old-site', keyPrefix: 'wme_00001', createdAt: 1 }];
    openEmbedsTab();
    await vi.waitFor(() =>
      expect(internal.overlay.querySelector('.embed-keys-revoke-btn')).not.toBeNull(),
    );

    vi.stubGlobal('confirm', () => true);
    internal.overlay.querySelector<HTMLButtonElement>('.embed-keys-revoke-btn')!.click();
    await vi.waitFor(() => expect(revokeEmbedKey).toHaveBeenCalled());

    expect(apiKeys.revokeApiKey).not.toHaveBeenCalled();
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });
});
