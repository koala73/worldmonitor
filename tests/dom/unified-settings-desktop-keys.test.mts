/**
 * Settings -> API Keys: desktop keys for Pro and Pro Business (plan
 * 2026-10-25-001, U5).
 *
 * Which section the tab shows is decided by the entitlement, not the tab:
 *   - API plan (`apiAccess`)           -> the existing API key section;
 *   - Pro / Pro Business (`desktopKeyAccess`, no `apiAccess`) -> Desktop keys;
 *   - anything else signed in          -> an upgrade prompt naming desktop keys.
 * A downgraded API customer lands in the desktop branch: their old generic keys
 * are listed there, revoke only, and count toward `maxDesktopKeys`.
 *
 * Harness mirrors unified-settings-embeds-tab.test.mts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';
import type { EntitlementState } from '@/services/entitlements';
import type { ApiKeyInfo } from '@/services/api-keys';

const session: AuthSession = {
  user: { id: 'A', name: 'User A', email: 'a@example.com', role: 'pro' },
  isPending: false,
};

function proState(): EntitlementState {
  return {
    planKey: 'pro_monthly',
    features: {
      tier: 1,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 10,
      prioritySupport: false,
      exportFormats: [],
      desktopKeyAccess: true,
      maxDesktopKeys: 2,
    },
    validUntil: Date.now() + 86_400_000,
  };
}

function freeState(): EntitlementState {
  return {
    planKey: 'free',
    features: {
      tier: 0,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: [],
      desktopKeyAccess: false,
      maxDesktopKeys: 0,
    },
    validUntil: 0,
  };
}

function apiStarterState(): EntitlementState {
  return {
    planKey: 'api_starter',
    features: {
      tier: 2,
      apiAccess: true,
      apiRateLimit: 60,
      maxDashboards: 10,
      prioritySupport: false,
      exportFormats: [],
      desktopKeyAccess: false,
      maxDesktopKeys: 0,
    },
    validUntil: Date.now() + 86_400_000,
  };
}

let entitlementState: EntitlementState = proState();

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
  hasFeature: (flag: string) => Boolean((entitlementState.features as Record<string, unknown>)[flag]),
  hasEmbedAccessForAccount: () => false,
  isEntitled: () => entitlementState.planKey !== 'free',
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
vi.mock('@/config/feeds', () => ({ CANONICAL_FEEDS: {}, INTEL_SOURCES: [], SOURCE_REGION_MAP: {} }));
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

const PLAINTEXT = `wm_${'ab12cd34ef'.repeat(4)}`;
let keyRows: ApiKeyInfo[] = [];
const createApiKey = vi.fn(async (name: string, keyKind?: 'api' | 'desktop') => {
  keyRows = [
    ...keyRows,
    { id: `k_${keyRows.length + 1}`, name, keyPrefix: PLAINTEXT.slice(0, 8), createdAt: 1_756_000_000_000, keyKind: keyKind ?? 'api' },
  ];
  return { id: `k_${keyRows.length}`, name, keyPrefix: PLAINTEXT.slice(0, 8), key: PLAINTEXT };
});
const listApiKeys = vi.fn(async () => keyRows);
const revokeApiKey = vi.fn(async (keyId: string) => {
  keyRows = keyRows.map((k) => (k.id === keyId ? { ...k, revokedAt: 1_756_100_000_000 } : k));
});

vi.mock('@/services/api-keys', () => ({
  createApiKey: (name: string, keyKind?: 'api' | 'desktop') => createApiKey(name, keyKind),
  listApiKeys: () => listApiKeys(),
  revokeApiKey: (id: string) => revokeApiKey(id),
}));
vi.mock('@/services/embed-keys', () => ({
  createEmbedKey: vi.fn(),
  listEmbedKeys: vi.fn(async () => []),
  revokeEmbedKey: vi.fn(),
}));
vi.mock('@/services/api-plan-limit-notices', () => ({
  acknowledgePlanLimitNotice: vi.fn(),
  listCurrentPlanLimitNotices: vi.fn(async () => []),
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
};

let settings: InstanceType<typeof UnifiedSettings>;
let internal: SettingsInternals;

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

const panel = () => internal.overlay.querySelector<HTMLElement>('[data-panel-id="api-keys"]')!;
const createButton = () => panel().querySelector<HTMLButtonElement>('.api-keys-create-btn');
const nameInput = () => panel().querySelector<HTMLInputElement>('.api-keys-name-input');
const list = () => internal.overlay.querySelector<HTMLElement>('#usApiKeysList')!;
const count = () => panel().querySelector<HTMLElement>('[data-desktop-keys-count]');

function openApiKeysTab(): void {
  internal.render(false);
  internal.overlay.querySelector<HTMLButtonElement>('.unified-settings-tab[data-tab="api-keys"]')!.click();
}

async function keysLoaded(): Promise<void> {
  await vi.waitFor(() => expect(listApiKeys).toHaveBeenCalled());
  await vi.waitFor(() => expect(list().querySelector('.api-keys-loading')).toBeNull());
}

function desktopKey(id: string, name: string, extra: Partial<ApiKeyInfo> = {}): ApiKeyInfo {
  return { id, name, keyPrefix: `wm_${id.padStart(5, '0').slice(-5)}`, createdAt: 1_700_000_000_000, keyKind: 'desktop', ...extra };
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  session.user = { id: 'A', name: 'User A', email: 'a@example.com', role: 'pro' };
  entitlementState = proState();
  document.body.replaceChildren();
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  keyRows = [];
  createApiKey.mockClear();
  listApiKeys.mockClear();
  revokeApiKey.mockClear();
  mount();
});

afterEach(() => {
  settings.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Settings -> API Keys: which section each plan sees', () => {
  it('shows a Pro owner the Desktop keys section, not the API key form', async () => {
    openApiKeysTab();
    await keysLoaded();

    const text = panel().textContent ?? '';
    expect(text).toContain('Desktop keys');
    expect(text).toContain('for your own desktop app');
    expect(text).toContain('Shared or public deployments need an API plan');
    expect(text).not.toContain('Create API keys to access WorldMonitor data programmatically');
    expect(text).not.toContain('Upgrade to API Starter');
    expect(createButton()?.textContent).toContain('Create desktop key');
    expect(count()?.textContent).toContain('0 of 2');
  });

  it('shows an API-plan owner the existing API key section unchanged', async () => {
    entitlementState = apiStarterState();
    openApiKeysTab();
    await keysLoaded();

    const text = panel().textContent ?? '';
    expect(text).toContain('Create API keys to access WorldMonitor data programmatically');
    expect(createButton()?.textContent).toBe('Create Key');
    expect(count()).toBeNull();
    expect(text).not.toContain('Desktop keys');
  });

  it('shows a free owner an upgrade prompt naming desktop keys as a Pro feature', () => {
    session.user = { id: 'A', name: 'User A', email: 'a@example.com', role: 'free' };
    entitlementState = freeState();
    openApiKeysTab();

    const text = panel().textContent ?? '';
    expect(text).toContain('Desktop keys come with Pro');
    expect(panel().querySelector('.upgrade-pro-cta')?.textContent).toContain('Upgrade to Pro');
    expect(createButton()).toBeNull();
    expect(listApiKeys).not.toHaveBeenCalled();
  });
});

describe('Settings -> API Keys: desktop key lifecycle', () => {
  it('creates a desktop key, shows the full key once, then lists only the prefix', async () => {
    openApiKeysTab();
    await keysLoaded();

    nameInput()!.value = 'my-laptop';
    createButton()!.click();
    await vi.waitFor(() => expect(createApiKey).toHaveBeenCalledWith('my-laptop', 'desktop'));

    const banner = internal.overlay.querySelector<HTMLElement>('#usApiKeysBanner')!;
    await vi.waitFor(() => expect(banner.textContent).toContain(PLAINTEXT));
    expect(banner.textContent).toContain("won't be shown again");

    await vi.waitFor(() => expect(list().textContent).toContain('my-laptop'));
    expect(list().textContent).toContain(PLAINTEXT.slice(0, 8));
    expect(list().textContent).not.toContain(PLAINTEXT);
    expect(count()?.textContent).toContain('1 of 2');

    // The next render (tab switch, entitlement refresh) drops the plaintext.
    internal.render(false);
    expect(internal.overlay.textContent).not.toContain(PLAINTEXT);
  });

  it('disables create at the limit and names the cap', async () => {
    keyRows = [desktopKey('1', 'laptop'), desktopKey('2', 'desktop')];
    openApiKeysTab();
    await keysLoaded();

    expect(count()?.textContent).toContain('2 of 2');
    expect(createButton()!.disabled).toBe(true);
    expect(nameInput()!.disabled).toBe(true);
    expect(panel().textContent).toContain('Your plan allows 2 desktop keys');
  });

  it('keeps create disabled at the limit after a create completes', async () => {
    keyRows = [desktopKey('1', 'laptop')];
    openApiKeysTab();
    await keysLoaded();
    expect(createButton()!.disabled).toBe(false);

    nameInput()!.value = 'second';
    createButton()!.click();
    await vi.waitFor(() => expect(count()?.textContent).toContain('2 of 2'));
    await vi.waitFor(() => expect(createButton()!.textContent).toBe('Create desktop key'));
    expect(createButton()!.disabled).toBe(true);
  });

  it('revoked keys do not count toward the limit', async () => {
    keyRows = [desktopKey('1', 'laptop'), desktopKey('2', 'old', { revokedAt: 1_700_100_000_000 })];
    openApiKeysTab();
    await keysLoaded();

    expect(count()?.textContent).toContain('1 of 2');
    expect(createButton()!.disabled).toBe(false);
  });

  it('revokes a desktop key through the list', async () => {
    keyRows = [desktopKey('1', 'laptop'), desktopKey('2', 'desktop')];
    openApiKeysTab();
    await keysLoaded();
    vi.stubGlobal('confirm', () => true);

    list().querySelector<HTMLButtonElement>('.api-keys-revoke-btn[data-key-id="1"]')!.click();
    await vi.waitFor(() => expect(revokeApiKey).toHaveBeenCalledWith('1'));
    await vi.waitFor(() => expect(count()?.textContent).toContain('1 of 2'));
    expect(createButton()!.disabled).toBe(false);
  });

  it('shows a downgraded owner their old API keys as desktop access, revoke only, counted', async () => {
    // AE6: three generic keys from an API plan, now on Pro with a cap of 2.
    keyRows = [
      { id: 'a1', name: 'old-1', keyPrefix: 'wm_aaaaa', createdAt: 1, keyKind: 'api' },
      { id: 'a2', name: 'old-2', keyPrefix: 'wm_bbbbb', createdAt: 2, keyKind: 'api' },
      { id: 'a3', name: 'old-3', keyPrefix: 'wm_ccccc', createdAt: 3, keyKind: 'api' },
    ];
    openApiKeysTab();
    await keysLoaded();

    const rows = [...list().querySelectorAll<HTMLElement>('.api-keys-item')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.textContent).toContain('Desktop access');
      expect(row.querySelector('.api-keys-revoke-btn')).not.toBeNull();
    }
    expect(count()?.textContent).toContain('3 of 2');
    expect(createButton()!.disabled).toBe(true);
    expect(panel().textContent).toContain('Revoke 1 key');
  });

  it.each([
    ['DESKTOP_KEY_LIMIT_REACHED', 'Your plan allows 2 desktop keys'],
    ['DESKTOP_KEYS_DISABLED', "Desktop keys aren't available yet"],
    ['DESKTOP_KEY_ACCESS_REQUIRED', 'Desktop keys need an active Pro or Pro Business plan'],
    ['INVALID_API_KEY_SCOPES', 'Desktop keys cannot have API scopes'],
  ])('maps %s to a clear message', async (code, message) => {
    createApiKey.mockImplementationOnce(async () => {
      throw new Error(`[CONVEX M(apiKeys:createApiKey)] Uncaught ConvexError: ${code}`);
    });
    openApiKeysTab();
    await keysLoaded();

    nameInput()!.value = 'laptop';
    createButton()!.click();
    const error = internal.overlay.querySelector<HTMLElement>('#usApiKeysError')!;
    await vi.waitFor(() => expect(error.textContent).toContain(message));
    expect(error.textContent).not.toContain(code);
  });
});
