/**
 * The settings modal owns account-scoped plaintext and lists. Exercise the
 * real class and its real subscribeAuthState wiring so removing the
 * constructor subscription cannot leave account A's data rendered for B.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { ApiKeyInfo, CreateApiKeyResult } from '@/services/api-keys';
import type { ApiPlanLimitNotice } from '@/services/api-plan-limit-notices';
import type { AuthSession } from '@/services/auth-state';
import type {
  EntitlementState,
  EntitlementVerificationStatus,
} from '@/services/entitlements';
import type { McpClientInfo, McpQuota } from '@/services/mcp-clients';

let session: AuthSession = signedIn('A');
const authListeners: Array<(state: AuthSession) => void> = [];

const apiKeyMocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
}));
const noticeMocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  list: vi.fn(),
}));
const mcpMocks = vi.hoisted(() => ({
  list: vi.fn(),
  quota: vi.fn(),
  revoke: vi.fn(),
}));
const entitlementMocks = vi.hoisted(() => ({
  state: null as EntitlementState | null,
  listeners: [] as Array<(state: EntitlementState | null) => void>,
  verificationStatus: 'idle' as EntitlementVerificationStatus,
  verificationListeners: [] as Array<(status: EntitlementVerificationStatus) => void>,
}));
const panelGatingMocks = vi.hoisted(() => ({
  hasPremiumAccess: true,
}));
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
  subscribeAuthState: (listener: (state: AuthSession) => void) => {
    authListeners.push(listener);
    listener(session);
    return () => {
      const index = authListeners.indexOf(listener);
      if (index >= 0) authListeners.splice(index, 1);
    };
  },
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => entitlementMocks.state,
  getEntitlementVerificationStatus: () => entitlementMocks.verificationStatus,
  hasFeature: (feature: string) => Boolean(
    (entitlementMocks.state?.features as Record<string, unknown> | undefined)?.[feature],
  ),
  isEntitled: (planKey?: string) => (
    entitlementMocks.state !== null
    && (planKey === undefined || entitlementMocks.state.planKey === planKey)
  ),
  onEntitlementChange: (listener: (state: EntitlementState | null) => void) => {
    entitlementMocks.listeners.push(listener);
    if (entitlementMocks.state !== null) listener(entitlementMocks.state);
    return () => {
      const index = entitlementMocks.listeners.indexOf(listener);
      if (index >= 0) entitlementMocks.listeners.splice(index, 1);
    };
  },
  onEntitlementVerificationChange: (
    listener: (status: EntitlementVerificationStatus) => void,
  ) => {
    entitlementMocks.verificationListeners.push(listener);
    listener(entitlementMocks.verificationStatus);
    return () => {
      const index = entitlementMocks.verificationListeners.indexOf(listener);
      if (index >= 0) entitlementMocks.verificationListeners.splice(index, 1);
    };
  },
}));

vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => panelGatingMocks.hasPremiumAccess,
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => true,
}));

vi.mock('@/services/preferences-content', () => ({
  renderPreferences: () => ({
    html: '',
    attach: () => () => {},
  }),
}));

vi.mock('@/services/notifications-settings', () => ({
  renderNotificationsSettings: () => ({
    html: '',
    attach: () => () => {},
  }),
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
  deriveBillingUxState: () => 'active',
  getReactivationHref: () => '/pro#pricing',
}));

vi.mock('@/services/api-keys', () => ({
  createApiKey: (...args: unknown[]) => apiKeyMocks.create(...args),
  listApiKeys: (...args: unknown[]) => apiKeyMocks.list(...args),
  revokeApiKey: (...args: unknown[]) => apiKeyMocks.revoke(...args),
}));

vi.mock('@/services/api-plan-limit-notices', () => ({
  acknowledgePlanLimitNotice: (...args: unknown[]) => noticeMocks.acknowledge(...args),
  listCurrentPlanLimitNotices: (...args: unknown[]) => noticeMocks.list(...args),
}));

vi.mock('@/services/mcp-clients', () => ({
  listMcpClients: (...args: unknown[]) => mcpMocks.list(...args),
  fetchMcpQuota: (...args: unknown[]) => mcpMocks.quota(...args),
  revokeMcpClient: (...args: unknown[]) => mcpMocks.revoke(...args),
}));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  overlay: HTMLElement;
  activeTab: 'api-keys' | 'mcp-clients';
  accountDataGeneration: number;
  accountEntitlementRefreshPending: boolean;
  apiKeys: ApiKeyInfo[];
  apiKeysLoading: boolean;
  apiKeysError: string;
  newlyCreatedKey: string | null;
  planLimitNotices: ApiPlanLimitNotice[];
  planLimitNoticesLoading: boolean;
  planLimitNoticesError: string;
  mcpClients: McpClientInfo[];
  mcpClientsLoading: boolean;
  mcpClientsError: string;
  mcpQuota: McpQuota | null;
  render(loadAccountData?: boolean): void;
  renderApiKeysList(): void;
  renderMcpClientsList(): void;
  renderMcpQuotaInPlace(): void;
  showCreatedBanner(key: string): void;
  loadApiKeys(): Promise<void>;
  loadPlanLimitNotices(): Promise<void>;
  loadMcpClients(): Promise<void>;
  refreshMcpQuota(): Promise<void>;
  handleCreateApiKey(): Promise<void>;
  handleRevokeApiKey(keyId: string): Promise<void>;
  handleAcknowledgePlanLimitNotice(noticeId: string): Promise<void>;
  handleRevokeMcpClient(tokenId: string): Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function signedIn(id: string): AuthSession {
  return {
    user: {
      id,
      name: `User ${id}`,
      email: `${id.toLowerCase()}@example.com`,
      role: 'pro',
    },
    isPending: false,
  };
}

function emitAccount(id: string): void {
  session = signedIn(id);
  for (const listener of [...authListeners]) listener(session);
}

function entitlement(options: {
  planKey: string;
  apiAccess: boolean;
  mcpAccess: boolean;
}): EntitlementState {
  return {
    planKey: options.planKey,
    features: {
      tier: options.planKey === 'free' ? 0 : 1,
      apiAccess: options.apiAccess,
      apiRateLimit: options.apiAccess ? 10_000 : 0,
      maxDashboards: options.planKey === 'free' ? 1 : 10,
      prioritySupport: options.planKey !== 'free',
      exportFormats: options.apiAccess ? ['json'] : [],
      mcpAccess: options.mcpAccess,
    },
    validUntil: Date.now() + 86_400_000,
  };
}

function emitEntitlement(state: EntitlementState | null): void {
  entitlementMocks.state = state;
  for (const listener of [...entitlementMocks.listeners]) listener(state);
}

function emitEntitlementVerification(status: EntitlementVerificationStatus): void {
  entitlementMocks.verificationStatus = status;
  for (const listener of [...entitlementMocks.verificationListeners]) listener(status);
}

function apiKey(id = 'key-a'): ApiKeyInfo {
  return {
    id,
    name: 'A private key',
    keyPrefix: 'wm_A_PREFIX',
    createdAt: Date.now(),
  };
}

function notice(id = 'notice-a'): ApiPlanLimitNotice {
  return {
    _id: id,
    userId: 'A',
    planKey: 'api_business',
    dimension: 'api_daily_requests',
    state: 'warning',
    windowKey: 'A private window',
    usage: 90,
    limit: 100,
    usageRatio: 0.9,
    ctaKind: 'none',
  };
}

function mcpClient(id = 'client-a', name = 'A private MCP client'): McpClientInfo {
  return {
    id,
    name,
    createdAt: Date.now(),
  };
}

const config: UnifiedSettingsConfig = {
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

let settings: InstanceType<typeof UnifiedSettings>;
let internal: SettingsInternals;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  authListeners.length = 0;
  entitlementMocks.listeners.length = 0;
  entitlementMocks.verificationListeners.length = 0;
  entitlementMocks.state = entitlement({
    planKey: 'api_business',
    apiAccess: true,
    mcpAccess: true,
  });
  entitlementMocks.verificationStatus = 'ready';
  panelGatingMocks.hasPremiumAccess = true;
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  session = signedIn('A');
  apiKeyMocks.create.mockReset().mockResolvedValue({
    id: 'default',
    name: 'default',
    keyPrefix: 'wm_default',
    key: 'wm_default_plaintext',
  });
  apiKeyMocks.list.mockReset().mockResolvedValue([]);
  apiKeyMocks.revoke.mockReset().mockResolvedValue(undefined);
  noticeMocks.acknowledge.mockReset().mockResolvedValue(undefined);
  noticeMocks.list.mockReset().mockResolvedValue([]);
  mcpMocks.list.mockReset().mockResolvedValue([]);
  mcpMocks.quota.mockReset().mockResolvedValue({
    used: 0,
    limit: 50,
    resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  mcpMocks.revoke.mockReset().mockResolvedValue(undefined);

  settings = new UnifiedSettings(config);
  internal = settings as unknown as SettingsInternals;
  internal.overlay.classList.add('active');
  internal.activeTab = 'api-keys';
});

afterEach(() => {
  settings.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings real auth-subscription handoff', () => {
  it('keeps checking past 12 seconds while entitlement verification is still in flight', () => {
    vi.useFakeTimers();
    panelGatingMocks.hasPremiumAccess = false;
    entitlementMocks.state = null;
    entitlementMocks.verificationStatus = 'pending';

    try {
      settings.open('billing');
      expect(internal.overlay.textContent).toContain('Checking your plan');

      vi.advanceTimersByTime(12_000);

      expect(internal.overlay.textContent).toContain('Checking your plan');
      expect(internal.overlay.textContent).not.toContain('Plan status unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows retry only after entitlement verification becomes unavailable', () => {
    panelGatingMocks.hasPremiumAccess = false;
    entitlementMocks.state = null;
    entitlementMocks.verificationStatus = 'pending';
    settings.open('billing');

    expect(internal.overlay.textContent).toContain('Checking your plan');
    expect(internal.overlay.querySelector('.retry-plan-status-btn')).toBeNull();

    emitEntitlementVerification('unavailable');

    expect(internal.overlay.textContent).toContain('Plan status unavailable');
    expect(internal.overlay.querySelector('.retry-plan-status-btn')).not.toBeNull();
  });

  it('synchronously purges A plaintext and rendered account lists when auth emits B', () => {
    internal.apiKeys = [apiKey()];
    internal.planLimitNotices = [notice()];
    internal.mcpClients = [mcpClient()];
    internal.mcpQuota = {
      used: 41,
      limit: 50,
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    internal.render(false);
    internal.showCreatedBanner('wm_A_PLAINTEXT_SECRET');
    internal.renderApiKeysList();
    internal.renderMcpClientsList();
    internal.renderMcpQuotaInPlace();

    expect(internal.overlay.textContent).toContain('wm_A_PLAINTEXT_SECRET');
    expect(internal.overlay.textContent).toContain('A private key');
    expect(internal.overlay.textContent).toContain('A private MCP client');
    expect(internal.overlay.textContent).toContain('A private window');
    expect(internal.overlay.textContent).toContain('41 / 50');

    emitAccount('B');

    expect(internal.accountDataGeneration).toBe(1);
    expect(internal.apiKeys).toEqual([]);
    expect(internal.planLimitNotices).toEqual([]);
    expect(internal.mcpClients).toEqual([]);
    expect(internal.mcpQuota).toBeNull();
    expect(internal.newlyCreatedKey).toBeNull();
    expect(internal.overlay.textContent).not.toContain('wm_A_PLAINTEXT_SECRET');
    expect(internal.overlay.textContent).not.toContain('A private key');
    expect(internal.overlay.textContent).not.toContain('A private MCP client');
    expect(internal.overlay.textContent).not.toContain('A private window');
    expect(internal.overlay.textContent).not.toContain('41 / 50');
  });

  it('drops every deferred A settlement after the real auth subscription selects B', async () => {
    const listKeys = deferred<ApiKeyInfo[]>();
    const createKey = deferred<CreateApiKeyResult>();
    const revokeKey = deferred<void>();
    const listNotices = deferred<ApiPlanLimitNotice[]>();
    const acknowledgeNotice = deferred<void>();
    const listClients = deferred<McpClientInfo[]>();
    const quota = deferred<McpQuota>();
    const revokeClient = deferred<void>();

    apiKeyMocks.list.mockReturnValue(listKeys.promise);
    apiKeyMocks.create.mockReturnValue(createKey.promise);
    apiKeyMocks.revoke.mockReturnValue(revokeKey.promise);
    noticeMocks.list.mockReturnValue(listNotices.promise);
    noticeMocks.acknowledge.mockReturnValue(acknowledgeNotice.promise);
    mcpMocks.list.mockReturnValue(listClients.promise);
    mcpMocks.quota.mockReturnValue(quota.promise);
    mcpMocks.revoke.mockReturnValue(revokeClient.promise);
    vi.stubGlobal('confirm', vi.fn(() => true));

    internal.apiKeys = [apiKey()];
    internal.planLimitNotices = [notice()];
    internal.mcpClients = [mcpClient()];
    internal.render(false);
    internal.renderApiKeysList();
    const input = internal.overlay.querySelector<HTMLInputElement>('.api-keys-name-input');
    expect(input).not.toBeNull();
    input!.value = 'A create request';

    const pending = [
      internal.loadApiKeys(),
      internal.loadPlanLimitNotices(),
      internal.loadMcpClients(),
      internal.refreshMcpQuota(),
      internal.handleCreateApiKey(),
      internal.handleRevokeApiKey('key-a'),
      internal.handleAcknowledgePlanLimitNotice('notice-a'),
      internal.handleRevokeMcpClient('client-a'),
    ];

    emitAccount('B');

    listKeys.resolve([apiKey('late-key-a')]);
    createKey.resolve({
      id: 'created-a',
      name: 'A create request',
      keyPrefix: 'wm_A_CREATED',
      key: 'wm_A_LATE_PLAINTEXT',
    });
    revokeKey.reject(new Error('A key revoke detail'));
    listNotices.resolve([notice('late-notice-a')]);
    acknowledgeNotice.reject(new Error('A notice detail'));
    listClients.resolve([mcpClient('late-client-a')]);
    quota.resolve({
      used: 49,
      limit: 50,
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    revokeClient.reject(new Error('A MCP revoke detail'));
    await Promise.all(pending);

    expect(internal.apiKeys).toEqual([]);
    expect(internal.planLimitNotices).toEqual([]);
    expect(internal.mcpClients).toEqual([]);
    expect(internal.mcpQuota).toBeNull();
    expect(internal.newlyCreatedKey).toBeNull();
    expect(internal.apiKeysError).toBe('');
    expect(internal.planLimitNoticesError).toBe('');
    expect(internal.mcpClientsError).toBe('');
    expect(internal.overlay.textContent).not.toContain('wm_A_LATE_PLAINTEXT');
    expect(internal.overlay.textContent).not.toContain('late-key-a');
    expect(internal.overlay.textContent).not.toContain('late-notice-a');
    expect(internal.overlay.textContent).not.toContain('late-client-a');
    expect(internal.overlay.textContent).not.toContain('49 / 50');
    expect(document.querySelector('.toast-notification')).toBeNull();
    expect(apiKeyMocks.list).toHaveBeenCalledTimes(1);
    expect(mcpMocks.list).toHaveBeenCalledTimes(1);
  });

  it('preserves notices and renders a current-account authentication error', async () => {
    internal.planLimitNotices = [notice()];
    internal.render(false);
    noticeMocks.list.mockRejectedValue(
      new Error('Authentication unavailable while loading API plan-limit notices. Try again.'),
    );

    await internal.loadPlanLimitNotices();

    expect(internal.planLimitNotices).toEqual([notice()]);
    expect(internal.planLimitNoticesError).toBe(
      'Authentication unavailable while loading API plan-limit notices. Try again.',
    );
    expect(internal.overlay.textContent).toContain('A private window');
    expect(internal.overlay.textContent).toContain(
      'Authentication unavailable while loading API plan-limit notices. Try again.',
    );
  });

  it('rebuilds MCP capability from B across reset, free, and Pro snapshots', async () => {
    mcpMocks.list.mockResolvedValue([mcpClient('client-b', 'B private MCP client')]);
    settings.open('api-keys');
    expect(internal.overlay.querySelector('[data-tab="mcp-clients"]')).not.toBeNull();

    emitAccount('B');
    expect(internal.accountEntitlementRefreshPending).toBe(true);

    emitEntitlement(null);
    expect(internal.accountEntitlementRefreshPending).toBe(true);
    expect(internal.overlay.querySelector('[data-tab="mcp-clients"]')).toBeNull();
    expect(mcpMocks.list).not.toHaveBeenCalled();

    emitEntitlement(entitlement({
      planKey: 'free',
      apiAccess: false,
      mcpAccess: false,
    }));
    expect(internal.accountEntitlementRefreshPending).toBe(false);
    expect(internal.overlay.querySelector('[data-tab="mcp-clients"]')).toBeNull();
    expect(mcpMocks.list).not.toHaveBeenCalled();

    emitEntitlement(entitlement({
      planKey: 'pro',
      apiAccess: false,
      mcpAccess: true,
    }));
    const mcpTab = internal.overlay.querySelector<HTMLButtonElement>('[data-tab="mcp-clients"]');
    expect(mcpTab).not.toBeNull();
    mcpTab!.click();

    await vi.waitFor(() => {
      expect(mcpMocks.list).toHaveBeenCalledTimes(1);
      expect(internal.overlay.textContent).toContain('B private MCP client');
    });
  });
});
