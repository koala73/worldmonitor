/**
 * Plan & billing danger zone: signed-in users can delete the current Clerk
 * subject after typing DELETE. Invitees see the control even without Manage
 * Billing. Anonymous dashboards have no account to delete.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';
import type { SubscriptionInfo } from '@/services/billing';

let session: AuthSession = signedIn('user_self');
let mockSubscription: SubscriptionInfo | null = subscription();
let entitled = true;
let subscriptionLoaded = true;

const deletionMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));
const signOutMock = vi.hoisted(() => vi.fn(async () => {}));
const toastMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/services/clerk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/clerk')>()),
  signOut: () => signOutMock(),
  getCurrentClerkUser: () => session.user,
}));

vi.mock('@/services/account-deletion', () => ({
  requestOwnAccountDeletion: (...args: unknown[]) => deletionMocks.request(...args),
}));

vi.mock('@/utils/toast', () => ({
  showToast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => (
    entitled
      ? { planKey: 'pro_monthly', validUntil: Date.now() + 1e9 }
      : null
  ),
  getEntitlementVerificationStatus: () => 'ready',
  hasFeature: () => entitled,
  hasEmbedAccessForAccount: () => entitled,
  isEntitled: () => entitled,
  onEntitlementChange: () => () => {},
  onEntitlementVerificationChange: () => () => {},
}));

vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => entitled,
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => entitled,
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

vi.mock('@/services/billing-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing-state')>()),
  deriveBillingUxState: () => (entitled ? 'active' : 'free'),
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

let settings: InstanceType<typeof UnifiedSettings>;

function signedIn(id: string): AuthSession {
  return {
    user: { id, name: `User ${id}`, email: `${id}@example.com`, role: 'pro' },
    isPending: false,
  };
}

function anonymous(): AuthSession {
  return { user: null, isPending: false };
}

function subscription(): SubscriptionInfo {
  return {
    planKey: 'pro_monthly',
    displayName: 'Pro',
    status: 'active',
    currentPeriodEnd: Date.now() + 30 * 86_400_000,
    renewalVerificationState: null,
  };
}

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

function typePhrase(value: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-deletion-phrase]');
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event('input', { bubbles: true }));
  return input!;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  session = signedIn('user_self');
  mockSubscription = subscription();
  entitled = true;
  subscriptionLoaded = true;
  deletionMocks.request.mockReset();
  deletionMocks.request.mockResolvedValue({ status: 'complete', userIdHash: 'abc' });
  signOutMock.mockReset();
  toastMock.mockReset();
  settings = new UnifiedSettings(config());
});

afterEach(() => {
  settings?.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings account deletion', () => {
  it('shows the danger zone when signed in and hides it when anonymous', () => {
    settings.open('billing');
    expect(document.querySelector('[data-account-deletion]')).not.toBeNull();
    settings.destroy();

    session = anonymous();
    entitled = false;
    mockSubscription = null;
    settings = new UnifiedSettings(config());
    settings.open();
    expect(document.querySelector('#us-tab-billing')).toBeNull();
    expect(document.querySelector('[data-account-deletion]')).toBeNull();
  });

  it('shows Delete account for an invitee without Manage Billing', () => {
    mockSubscription = null;
    subscriptionLoaded = true;
    entitled = true;
    settings.open('billing');
    expect(document.querySelector('.manage-billing-btn')).toBeNull();
    expect(document.querySelector('[data-delete-account]')).not.toBeNull();
  });

  it('keeps confirm disabled for empty and wrong phrases', () => {
    settings.open('billing');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    expect(confirm?.disabled).toBe(true);
    typePhrase('');
    expect(confirm?.disabled).toBe(true);
    typePhrase('delete');
    expect(confirm?.disabled).toBe(true);
    typePhrase('DEL');
    expect(confirm?.disabled).toBe(true);
    expect(deletionMocks.request).not.toHaveBeenCalled();
  });

  it('signs out after a successful typed confirmation', async () => {
    settings.open('billing');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    expect(confirm?.disabled).toBe(false);
    confirm!.click();
    await vi.waitFor(() => {
      expect(deletionMocks.request).toHaveBeenCalledTimes(1);
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
    expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(
      expect.stringMatching(/Sign out on other devices/i),
    );
  });

  it('does not sign out when the account changes mid-request', async () => {
    deletionMocks.request.mockRejectedValue(
      new Error('Account changed while deleting the account. Try again.'),
    );
    settings.open('billing');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();
    await vi.waitFor(() => {
      expect(deletionMocks.request).toHaveBeenCalledTimes(1);
    });
    expect(signOutMock).not.toHaveBeenCalled();
    expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-deletion-confirm]')).toBeNull();
  });

  it('stacks the type-DELETE dialog above the settings overlay', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/main.css'), 'utf8');
    const overlayZ = Number(css.match(/\.modal-overlay \{[^}]*z-index:\s*(\d+)/)?.[1]);
    const dialogZ = Number(
      css.match(/\.account-deletion-dialog-overlay \{[^}]*z-index:\s*(\d+)/)?.[1],
    );
    expect(overlayZ).toBeGreaterThan(0);
    expect(dialogZ).toBeGreaterThan(overlayZ);
  });

  it('shows a retryable error and keeps the session on failure', async () => {
    deletionMocks.request.mockRejectedValue(new Error('Convex unavailable'));
    settings.open('billing');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-deletion-error]')?.textContent).toBe('Convex unavailable');
    });
    expect(signOutMock).not.toHaveBeenCalled();
    expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-deletion-confirm]')).not.toBeNull();
  });
});
