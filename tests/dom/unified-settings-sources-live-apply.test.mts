/**
 * Settings → SOURCES must tell the host when the user is done and the source
 * selection actually moved (#6380).
 *
 * Source toggles apply to `ctx.disabledSources` on click — no draft/Save step
 * like panels — but nothing subscribed to that write, so a change first reached
 * the dashboard at RefreshScheduler's `news` tick (REFRESH_INTERVALS.feeds, 20
 * minutes) or on reload. `onSourcesChanged` is that subscription, and this file
 * pins the two halves of when it fires:
 *
 *   (a) toggled + closed              → fires exactly once, after teardown;
 *   (b) closed untouched              → silent;
 *   (c) toggled off and back on       → silent (net change is nil);
 *   (d) toggle the host refused       → silent (free-tier source cap);
 *   (e) one multi-word source swapped for two that concatenate to the same
 *       text                          → fires (separator-collision guard);
 *   (f) second session, nothing moved → silent (the baseline re-arms on open).
 *
 * (b)-(d) are the request-budget half: the overlay covers the dashboard, so a
 * per-click refetch would be a storm the user cannot even see — the budget
 * guarded by e2e/dashboard-news-request-budget.spec.ts. Firing once per session
 * only when the set genuinely moved is what keeps that budget intact.
 *
 * Harness mirrors unified-settings-theater-presets.test.mts: same module mocks,
 * same stub-config shape. Unlike that file this one drives the real open() and
 * close() rather than render() directly, because the baseline snapshot and the
 * teardown comparison are exactly what is under test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
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

type SettingsInternals = { overlay: HTMLElement };

// Deliberately space-bearing, and deliberately overlapping: "Reuters World"
// against "Reuters" + "World" is the pair that collides under any separator a
// source name can itself contain. Real feed names look exactly like this.
const COMBINED_SOURCE = 'Reuters World';
const FIRST_HALF_SOURCE = 'Reuters';
const SECOND_HALF_SOURCE = 'World';
const PLAIN_SOURCE = 'BBC World';
const ALL_SOURCES = [COMBINED_SOURCE, FIRST_HALF_SOURCE, SECOND_HALF_SOURCE, PLAIN_SOURCE];

let disabledSources: Set<string>;
let onSourcesChanged: Mock<() => void>;
let overlayActiveAtNotification: boolean | null;
let toggleSourceImpl: (name: string) => void;
let config: UnifiedSettingsConfig;
let settings: InstanceType<typeof UnifiedSettings>;
let internal: SettingsInternals;

function sourceButton(name: string): HTMLButtonElement {
  const el = internal.overlay.querySelector<HTMLButtonElement>(
    `#usSourceToggles .source-toggle-item[data-source="${name}"]`,
  );
  expect(el, `expected a source toggle for "${name}"`).not.toBeNull();
  return el!;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);

  disabledSources = new Set<string>();
  // Real toggleSource semantics (event-handlers.ts setupUnifiedSettings):
  // membership in ctx.disabledSources flips in place on click.
  toggleSourceImpl = (name: string) => {
    if (disabledSources.has(name)) disabledSources.delete(name);
    else disabledSources.add(name);
  };
  overlayActiveAtNotification = null;
  onSourcesChanged = vi.fn<() => void>(() => {
    overlayActiveAtNotification = internal.overlay.classList.contains('active');
  });
  config = {
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => disabledSources,
    toggleSource: (name) => toggleSourceImpl(name),
    setSourcesEnabled: (names, enabled) => {
      for (const name of names) {
        if (enabled) disabledSources.delete(name);
        else disabledSources.add(name);
      }
    },
    getAllSourceNames: () => ALL_SOURCES,
    getLocalizedPanelName: (_key, fallback) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
    onSourcesChanged: () => onSourcesChanged(),
  };

  settings = new UnifiedSettings(config);
  internal = settings as unknown as SettingsInternals;
});

afterEach(() => {
  settings.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings source selection live apply (#6380)', () => {
  it('(a) a source toggle followed by close notifies the host exactly once, after teardown', () => {
    settings.open('sources');
    expect(sourceButton(PLAIN_SOURCE).classList.contains('active')).toBe(true);

    sourceButton(PLAIN_SOURCE).click();

    // The click alone must not notify: the overlay still covers the dashboard,
    // and one refetch per click is the storm the request budget forbids.
    expect(onSourcesChanged).not.toHaveBeenCalled();
    expect(disabledSources.has(PLAIN_SOURCE)).toBe(true);
    expect(sourceButton(PLAIN_SOURCE).classList.contains('active')).toBe(false);

    settings.close();

    expect(onSourcesChanged).toHaveBeenCalledTimes(1);
    // Ordering matters: the host reloads data in response, and the user cannot
    // see that land while the overlay is still up.
    expect(
      overlayActiveAtNotification,
      'the overlay must already be torn down when the host is told to reload',
    ).toBe(false);
  });

  it('(a2) several toggles in one session still notify only once', () => {
    settings.open('sources');
    sourceButton(PLAIN_SOURCE).click();
    sourceButton(COMBINED_SOURCE).click();
    sourceButton(FIRST_HALF_SOURCE).click();
    settings.close();

    expect(
      onSourcesChanged,
      'working through the source grid must cost one refresh, not one per click',
    ).toHaveBeenCalledTimes(1);
  });

  it('(b) closing without touching sources does not notify', () => {
    settings.open('sources');
    settings.close();

    expect(onSourcesChanged).not.toHaveBeenCalled();
  });

  it('(c) toggling a source off and back on again does not notify', () => {
    settings.open('sources');
    sourceButton(PLAIN_SOURCE).click();
    sourceButton(PLAIN_SOURCE).click();

    expect(disabledSources.has(PLAIN_SOURCE)).toBe(false);
    settings.close();

    expect(
      onSourcesChanged,
      'the net change is nil, so the work-list did not move and no reload is owed',
    ).not.toHaveBeenCalled();
  });

  it('(d) a toggle the host refuses (free-tier source cap) does not notify', () => {
    // The real toggleSource returns early with a cap toast and leaves the set
    // untouched. A "was a toggle clicked" flag would fire here; a signature
    // comparison correctly does not.
    toggleSourceImpl = () => {};

    settings.open('sources');
    sourceButton(PLAIN_SOURCE).click();
    expect(disabledSources.size).toBe(0);
    settings.close();

    expect(onSourcesChanged).not.toHaveBeenCalled();
  });

  it('(e) swapping one multi-word source for two that concatenate identically still notifies', () => {
    // Baseline {"Reuters World"} → end state {"Reuters", "World"}. Joined on a
    // space — or on anything a source name may contain — both sides render as
    // "Reuters World" and the change is invisible.
    disabledSources = new Set([COMBINED_SOURCE]);

    settings.open('sources');
    sourceButton(COMBINED_SOURCE).click();
    sourceButton(FIRST_HALF_SOURCE).click();
    sourceButton(SECOND_HALF_SOURCE).click();
    expect(disabledSources).toEqual(new Set([FIRST_HALF_SOURCE, SECOND_HALF_SOURCE]));

    settings.close();

    expect(
      onSourcesChanged,
      'a different source set must be detected even when its names concatenate to the same text',
    ).toHaveBeenCalledTimes(1);
  });

  it('(e2) a re-entrant open() mid-session does not swallow an earlier toggle', () => {
    // open() is callable on an overlay that is already up — the deep-dive
    // "Notify me about this country" jump lands on the notifications tab that
    // way. Re-snapshotting there would adopt the post-toggle set as the
    // baseline and close() would see no movement at all.
    settings.open('sources');
    sourceButton(PLAIN_SOURCE).click();

    settings.open('notifications');
    settings.close();

    expect(
      onSourcesChanged,
      'a source change made before a re-entrant open() must still reach the dashboard',
    ).toHaveBeenCalledTimes(1);
  });

  it('(f) a second session that changes nothing does not re-notify', () => {
    settings.open('sources');
    sourceButton(PLAIN_SOURCE).click();
    settings.close();
    expect(onSourcesChanged).toHaveBeenCalledTimes(1);

    settings.open('sources');
    settings.close();

    expect(
      onSourcesChanged,
      'the baseline re-arms on open, so a quiet session must not replay the previous one',
    ).toHaveBeenCalledTimes(1);
  });
});
