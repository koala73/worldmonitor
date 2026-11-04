/**
 * Settings -> Desktop key on a self-hosted dashboard (plan 2026-11-04-001, U6).
 *
 * The section renders only when the verdict service has seen the sidecar's
 * /api/selfhost-key route; worldmonitor.app answers 404 there. The real
 * self-host-key service runs against a scripted route, so these tests also
 * pin the POST and DELETE requests the Settings form sends.
 *
 * Harness mirrors unified-settings-desktop-keys.test.mts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';

const session: AuthSession = { user: null, isPending: false };

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
  getEntitlementState: () => null,
  getEntitlementVerificationStatus: () => 'ready',
  hasFeature: () => false,
  hasEmbedAccessForAccount: () => false,
  isEntitled: () => false,
  onEntitlementChange: () => () => {},
  onEntitlementVerificationChange: () => () => {},
}));
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => false }));
vi.mock('@/services/widget-store', () => ({ isProUser: () => false }));
vi.mock('@/services/preferences-content', () => ({
  renderPreferences: () => ({ html: '<div data-prefs-stub></div>', attach: () => () => {} }),
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
  listBusinessSeats: async () => ({ businessSubscriptionId: null, ownerDomain: null, ownerIsCorporateDomain: false, seats: [] }),
  inviteBusinessSeats: async () => ({ invited: [] }),
  removeBusinessSeat: async () => ({ status: 'removed' as const }),
}));
vi.mock('@/services/api-keys', () => ({ createApiKey: vi.fn(), listApiKeys: vi.fn(async () => []), revokeApiKey: vi.fn() }));
vi.mock('@/services/embed-keys', () => ({ createEmbedKey: vi.fn(), listEmbedKeys: vi.fn(async () => []), revokeEmbedKey: vi.fn() }));
vi.mock('@/services/api-plan-limit-notices', () => ({
  acknowledgePlanLimitNotice: vi.fn(),
  listCurrentPlanLimitNotices: vi.fn(async () => []),
}));
vi.mock('@/services/mcp-clients', () => ({ listMcpClients: vi.fn(), fetchMcpQuota: vi.fn(), revokeMcpClient: vi.fn() }));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');
const selfHostKey = await import('@/services/self-host-key');

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const KEY = `wm_${'ab12cd34ef'.repeat(4)}`;

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

let routeCalls: Array<{ method: string; body: unknown; contentType: string | null }>;
let onGet: Route;
let onPost: Route;
let onDelete: Route;

function verdict(status: string, extra: Record<string, unknown> = {}, httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ enabled: status !== 'disabled', status, stale: false, verifiedAt: NOW, ...extra }),
    { status: httpStatus, headers: { 'Content-Type': 'application/json' } },
  );
}

function installRoute(): void {
  selfHostKey._resetSelfHostKeyForTests({
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      routeCalls.push({
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        contentType: new Headers(init?.headers).get('Content-Type'),
      });
      if (method === 'POST') return onPost(init);
      if (method === 'DELETE') return onDelete(init);
      return onGet(init);
    }) as typeof fetch,
    now: () => NOW,
    setInterval: () => 1,
    clearInterval: () => {},
    canRun: () => true,
  });
}

let settings: InstanceType<typeof UnifiedSettings>;
let overlay: HTMLElement;

async function mount(): Promise<void> {
  // App.init starts the verdict service before Settings can be opened.
  selfHostKey.startSelfHostKeyService();
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
  overlay = (settings as unknown as { overlay: HTMLElement }).overlay;
  settings.open('settings');
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const section = () => overlay.querySelector<HTMLDetailsElement>('[data-selfhost-key-section]');
const input = () => section()!.querySelector<HTMLInputElement>('[data-selfhost-key-input]');
const saveButton = () => section()!.querySelector<HTMLButtonElement>('[data-selfhost-key-save]');
const removeButton = () => section()!.querySelector<HTMLButtonElement>('[data-selfhost-key-remove]');
const status = () => section()!.querySelector<HTMLElement>('[data-selfhost-key-status]');
const posts = () => routeCalls.filter((call) => call.method === 'POST');

async function enterAndSave(value: string): Promise<void> {
  input()!.focus();
  input()!.value = value;
  saveButton()!.click();
  await settle();
}

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  routeCalls = [];
  onGet = () => verdict('none', { verifiedAt: null });
  onPost = () => verdict('active');
  onDelete = () => verdict('none', { verifiedAt: null });
  setSecureContext(true);
  installRoute();
});

afterEach(() => {
  settings?.destroy();
  selfHostKey._resetSelfHostKeyForTests({ canRun: () => false });
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Settings -> Desktop key on a self-hosted install', () => {
  it('renders on a self-hosted install with the relay and trust copy', async () => {
    await mount();
    expect(section()).not.toBeNull();
    const text = section()!.textContent ?? '';
    expect(text).toContain('Desktop key');
    expect(text).toContain("this install's server");
    expect(text).toContain('forwards your Pro requests to World Monitor');
    expect(text).toContain('desktop key allowance');
    expect(text).toContain('Settings → API Keys → Create desktop key');
    expect(text).toContain('separate desktop key');
    expect(text).toContain('revoke');
    expect(status()!.dataset.state).toBe('none');
    expect(status()!.textContent).toContain('No key');
    expect(input()!.type).toBe('password');
    expect(input()!.getAttribute('autocomplete')).toBe('off');
    expect(removeButton()).toBeNull();
  });

  it('does not render on worldmonitor.app (the route answers 404)', async () => {
    onGet = () => new Response('{}', { status: 404 });
    await mount();
    expect(section()).toBeNull();
    expect(overlay.querySelector('[data-prefs-stub]')).not.toBeNull();
  });

  it('appears when the verdict arrives after Settings opened', async () => {
    let release!: (res: Response) => void;
    onGet = () => new Promise<Response>((resolve) => { release = resolve; });
    await mount();
    expect(section()).toBeNull();
    release(verdict('active'));
    await settle();
    expect(status()!.dataset.state).toBe('active');
  });

  it('a poll keeps a collapsed section collapsed and leaves an unchanged section in place', async () => {
    onGet = () => verdict('active');
    await mount();
    section()!.open = false;
    const before = section();

    await selfHostKey.refreshSelfHostKey();
    await settle();
    expect(section()).toBe(before);

    onGet = () => verdict('lapsed');
    await selfHostKey.refreshSelfHostKey();
    await settle();
    expect(status()!.dataset.state).toBe('lapsed');
    expect(section()!.open).toBe(false);
  });

  it('a full re-render resets the section cache so the next refresh is not skipped', async () => {
    await mount();
    const internals = settings as unknown as { render(): void; selfHostKeyMessage: string; refreshSelfHostKeySection(): void };
    await enterAndSave('   ');
    const message = () => section()!.querySelector<HTMLElement>('[data-selfhost-key-message]')!;
    expect(message().hidden).toBe(false);
    const shown = internals.selfHostKeyMessage;

    // A full render draws the section without the message; the refresh cache
    // still holds the with-message markup.
    internals.selfHostKeyMessage = '';
    internals.render();
    expect(message().hidden).toBe(true);

    // State returns to the cached markup: the refresh must still redraw.
    internals.selfHostKeyMessage = shown;
    internals.refreshSelfHostKeySection();
    expect(message().hidden).toBe(false);
  });

  it('saving a key the server reports active shows the active state', async () => {
    await mount();
    await enterAndSave(`  ${KEY}  `);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({ key: KEY });
    expect(posts()[0]!.contentType).toBe('application/json');
    expect(status()!.dataset.state).toBe('active');
    expect(status()!.textContent).toContain('Active');
    expect(input()!.value).toBe('');
    expect(removeButton()).not.toBeNull();
    expect(selfHostKey.isSelfHostKeyUnlocked()).toBe(true);
  });

  it('saving an invalid key shows the invalid state and keeps focus in the field', async () => {
    onPost = () => verdict('invalid', { verifiedAt: null, error: 'malformed_key' }, 400);
    await mount();
    await enterAndSave('wm_wrong');

    expect(status()!.dataset.state).toBe('invalid');
    expect(status()!.textContent).toContain('not valid or has been revoked');
    expect(document.activeElement).toBe(input());
    expect(input()!.value).toBe('wm_wrong');
    expect(input()!.getAttribute('aria-invalid')).toBe('true');
    expect(selfHostKey.isSelfHostKeyUnlocked()).toBe(false);
  });

  it('an empty field posts nothing', async () => {
    await mount();
    await enterAndSave('   ');
    expect(posts()).toHaveLength(0);
    expect(section()!.querySelector('[data-selfhost-key-message]')!.textContent).toContain('Enter a desktop key');
  });

  it.each([
    ['not_desktop_key', 'API key'],
    ['over_cap', 'more desktop keys than its plan allows'],
    ['lapsed', 'Pro plan is not active'],
    ['unavailable', 'Could not reach World Monitor'],
  ])('shows the %s state', async (state, copy) => {
    onGet = () => verdict(state, state === 'unavailable' ? { verifiedAt: null } : {});
    await mount();
    expect(status()!.dataset.state).toBe(state);
    expect(status()!.textContent).toContain(copy);
    expect(input()).not.toBeNull();
  });

  it('a failed re-check keeps an active key active and says the check failed', async () => {
    onGet = () => verdict('active', { stale: true, verifiedAt: NOW - 60 * 60 * 1000 });
    await mount();
    expect(status()!.dataset.state).toBe('active');
    expect(status()!.textContent).toContain('could not reach World Monitor');
  });

  it('a server that reports disabled shows the operator message and no input', async () => {
    onGet = () => new Response(
      JSON.stringify({ enabled: false, status: 'disabled', stale: false, verifiedAt: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    await mount();
    expect(section()!.textContent).toContain('turned off desktop keys');
    expect(status()!.dataset.state).toBe('disabled');
    expect(input()).toBeNull();
    expect(saveButton()).toBeNull();
  });

  it('on an insecure origin warns and posts nothing until confirmed', async () => {
    setSecureContext(false);
    await mount();
    expect(section()!.querySelector('[data-selfhost-key-insecure]')!.textContent)
      .toContain('unencrypted');

    await enterAndSave(KEY);
    const dialog = document.querySelector<HTMLElement>('.confirm-dialog-overlay');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('unencrypted');
    expect(posts()).toHaveLength(0);

    dialog!.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')!.click();
    await settle();
    expect(posts()).toHaveLength(0);
    expect(status()!.dataset.state).toBe('none');

    saveButton()!.click();
    await settle();
    document.querySelector<HTMLButtonElement>('.confirm-dialog-overlay .confirm-dialog-confirm')!.click();
    await settle();
    expect(posts()).toHaveLength(1);
    expect(status()!.dataset.state).toBe('active');
  });

  it('a secure origin shows no warning and asks no confirmation', async () => {
    await mount();
    expect(section()!.querySelector('[data-selfhost-key-insecure]')).toBeNull();
    await enterAndSave(KEY);
    expect(document.querySelector('.confirm-dialog-overlay')).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it('remove clears the state to "no key"', async () => {
    onGet = () => verdict('active');
    await mount();
    expect(status()!.dataset.state).toBe('active');

    removeButton()!.click();
    await settle();

    const deletes = routeCalls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.contentType).toBe('application/json');
    expect(deletes[0]!.body).toBeUndefined();
    expect(status()!.dataset.state).toBe('none');
    expect(status()!.textContent).toContain('No key');
    expect(selfHostKey.isSelfHostKeyUnlocked()).toBe(false);
  });

  it('a rate-limited save says when to try again', async () => {
    onPost = () => new Response('{}', { status: 429, headers: { 'Retry-After': '40' } });
    await mount();
    await enterAndSave(KEY);
    expect(section()!.querySelector('[data-selfhost-key-message]')!.textContent).toContain('40 seconds');
    expect(status()!.dataset.state).toBe('none');
  });
});
