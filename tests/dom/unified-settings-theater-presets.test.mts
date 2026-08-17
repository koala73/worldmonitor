/**
 * Theater coverage presets in Settings → Sources (#5956). Drive the real
 * UnifiedSettings overlay click delegation into the real applyCoveragePreset
 * so each behavior-bearing branch is locked against the stub-config contract:
 *
 *   (a) apply        — chip click enables exactly the preset's currently-
 *                      disabled resolvable sources, re-renders the grid, and
 *                      toasts the applied count;
 *   (b) idempotent   — a second click toasts alreadyApplied and does NOT call
 *                      setSourcesEnabled again;
 *   (c) free-cap     — a setSourcesEnabled that no-ops (free source cap keeps
 *                      the disabled set unchanged) produces no applied toast
 *                      and no grid re-render (size-delta guard);
 *   (d) unknown id   — a chip with an unrecognised data-preset-id is a silent
 *                      no-op.
 *
 * Harness mirrors unified-settings-account-handoff.test.mts: same module
 * mocks, same stub-config shape, same overlay activation flow.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { initTestI18n, tt } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';
import type { EntitlementState } from '@/services/entitlements';

const session: AuthSession = {
  user: { id: 'A', name: 'User A', email: 'a@example.com', role: 'pro' },
  isPending: false,
};

const entitlementState: EntitlementState = {
  planKey: 'pro',
  features: {
    tier: 1,
    apiAccess: true,
    apiRateLimit: 10_000,
    maxDashboards: 10,
    prioritySupport: true,
    exportFormats: ['json'],
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
const { getTheaterPreset } = await import('@/config/theater-presets');

type SettingsInternals = {
  overlay: HTMLElement;
  render(loadAccountData?: boolean): void;
};

// The 'ukraine-war' preset lists 11 sources; the stub catalog knows all of
// them plus one unrelated source, so resolution drops nothing and the only
// filter left is the disabled-set membership under test.
const PRESET_ID = 'ukraine-war';
const UNRELATED_SOURCE = 'Unrelated Stub Source';
// Resolved lazily: tt() only works after initTestI18n() in beforeAll.
const presetLabel = (): string => tt('theaterPresets.ukraineWar.label');

const ukrainePreset = getTheaterPreset(PRESET_ID);
if (!ukrainePreset) throw new Error(`[dom-harness] missing ${PRESET_ID} preset`);
const PRESET_SOURCES = [...ukrainePreset.sourceNames];
const ALL_SOURCES = [...PRESET_SOURCES, UNRELATED_SOURCE];

// Disabled subset in preset-list order: Kyiv Independent (idx 0), Meduza
// (idx 6), ISW (idx 10). Asserted literally below so the expected enable
// list cannot drift into a re-implementation of getTheaterPresetEnableList.
const INITIALLY_DISABLED = ['Kyiv Independent', 'Meduza', 'ISW'];

let disabledSources: Set<string>;
let setSourcesEnabled: Mock<(names: string[], enabled: boolean) => void>;
let config: UnifiedSettingsConfig;
let settings: InstanceType<typeof UnifiedSettings>;
let internal: SettingsInternals;

function sourceButton(name: string): HTMLButtonElement | null {
  return internal.overlay.querySelector<HTMLButtonElement>(
    `#usSourceToggles .source-toggle-item[data-source="${name}"]`,
  );
}

function chip(presetId: string): HTMLButtonElement {
  const el = internal.overlay.querySelector<HTMLButtonElement>(
    `.unified-settings-preset-chip[data-preset-id="${presetId}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function toastText(): string | null {
  return document.querySelector('.toast-notification')?.textContent ?? null;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);

  disabledSources = new Set(INITIALLY_DISABLED);
  // Default apply semantics: enabling removes names from the disabled set,
  // mirroring the real config's worldmonitor-disabled-feeds persistence.
  setSourcesEnabled = vi.fn<(names: string[], enabled: boolean) => void>((names, enabled) => {
    for (const name of names) {
      if (enabled) disabledSources.delete(name);
      else disabledSources.add(name);
    }
  });
  config = {
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => disabledSources,
    toggleSource: () => {},
    setSourcesEnabled: (names, enabled) => setSourcesEnabled(names, enabled),
    getAllSourceNames: () => ALL_SOURCES,
    getLocalizedPanelName: (_key, fallback) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  };

  settings = new UnifiedSettings(config);
  internal = settings as unknown as SettingsInternals;
  internal.overlay.classList.add('active');
  internal.render(false);
});

afterEach(() => {
  settings.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings theater coverage presets', () => {
  it('(a) chip click enables exactly the preset sources that were disabled, re-renders the grid, and toasts the count', () => {
    // Pre-condition: the grid renders the disabled sources as not active.
    expect(sourceButton('Kyiv Independent')?.classList.contains('active')).toBe(false);
    expect(sourceButton('Meduza')?.classList.contains('active')).toBe(false);
    expect(sourceButton('ISW')?.classList.contains('active')).toBe(false);

    chip(PRESET_ID).click();

    expect(setSourcesEnabled).toHaveBeenCalledTimes(1);
    expect(setSourcesEnabled).toHaveBeenCalledWith(INITIALLY_DISABLED, true);

    // Grid re-rendered from the mutated disabled set: applied sources flip to
    // active, sources the preset never touched keep their prior state.
    expect(sourceButton('Kyiv Independent')?.classList.contains('active')).toBe(true);
    expect(sourceButton('Meduza')?.classList.contains('active')).toBe(true);
    expect(sourceButton('ISW')?.classList.contains('active')).toBe(true);
    expect(sourceButton('Ukrinform')?.classList.contains('active')).toBe(true);
    expect(sourceButton(UNRELATED_SOURCE)?.classList.contains('active')).toBe(true);
    expect(internal.overlay.querySelector('#usSourcesCounter')?.textContent).toBe(
      tt('header.sourcesEnabled', { enabled: String(ALL_SOURCES.length), total: String(ALL_SOURCES.length) }),
    );

    expect(toastText()).toBe(
      tt('theaterPresets.applied', { preset: presetLabel(), count: '3' }),
    );
  });

  it('(b) a second chip click toasts alreadyApplied and does not call setSourcesEnabled again', () => {
    chip(PRESET_ID).click();
    expect(setSourcesEnabled).toHaveBeenCalledTimes(1);
    document.querySelector('.toast-notification')?.remove();

    chip(PRESET_ID).click();

    expect(setSourcesEnabled).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe(
      tt('theaterPresets.alreadyApplied', { preset: presetLabel() }),
    );
  });

  it('(c) a setSourcesEnabled no-op (free-cap) yields no applied toast and no grid re-render', () => {
    // Free source cap: the bulk primitive refuses without mutating the
    // disabled set, so the size-delta guard must suppress the success path.
    setSourcesEnabled.mockImplementation(() => {});
    const gridSpy = vi.spyOn(
      UnifiedSettings.prototype as unknown as { renderSourcesGrid(): void },
      'renderSourcesGrid',
    );

    chip(PRESET_ID).click();

    expect(setSourcesEnabled).toHaveBeenCalledTimes(1);
    expect(setSourcesEnabled).toHaveBeenCalledWith(INITIALLY_DISABLED, true);
    expect(gridSpy).not.toHaveBeenCalled();
    expect(toastText()).toBeNull();
    expect(disabledSources).toEqual(new Set(INITIALLY_DISABLED));
  });

  it('(d) a chip with an unknown data-preset-id is a silent no-op', () => {
    const bogus = document.createElement('button');
    bogus.type = 'button';
    bogus.className = 'unified-settings-preset-chip';
    bogus.dataset.presetId = 'no-such-theater';
    internal.overlay.appendChild(bogus);

    bogus.click();

    expect(setSourcesEnabled).not.toHaveBeenCalled();
    expect(toastText()).toBeNull();
    expect(disabledSources).toEqual(new Set(INITIALLY_DISABLED));
  });

  it('(e) a chip click with no resolvable sources at apply time shows unavailable toast', () => {
    config.getAllSourceNames = () => [UNRELATED_SOURCE];

    chip(PRESET_ID).click();

    expect(setSourcesEnabled).not.toHaveBeenCalled();
    expect(toastText()).toBe(
      tt('theaterPresets.unavailable', { preset: presetLabel() }),
    );
  });

  it('(f) no presets row renders when zero presets resolve', () => {
    config.getAllSourceNames = () => [UNRELATED_SOURCE];
    internal.render(false);

    const chips = internal.overlay.querySelectorAll('.unified-settings-preset-chip');
    expect(chips.length).toBe(0);
    expect(internal.overlay.querySelector('#usCoveragePresets')).toBeNull();
  });
});
