import type { AppContext, AppModule } from '@/app/app-context';
import { normalizeExclusiveChoropleths } from '@/components/resilience-choropleth-utils';
import { replayPendingCalls, clearAllPendingCalls } from '@/app/pending-panel-data';
import {
  createDeferredPanelShell,
  getDeferredPanelShellFootprint as resolveDeferredPanelShellFootprint,
  reconcileDeferredPanelShellColSpan,
  shouldDeferInitialPanelMount,
  type DeferredPanelShellFootprint,
} from '@/app/panel-mount-deferral';
import {
  addResponsiveZoneListener,
  removeResponsiveZoneListener,
  type ResponsiveZoneListener,
} from '@/app/responsive-zone-listener';
import { getAlertsNearLocation } from '@/services/geo-convergence';
import { effectivePubDateMs } from '@/services/feed-date';
import type { ClusteredEvent, MapLayers, PanelConfig } from '@/types';
import type { RelatedAsset } from '@/types';
import type { TheaterPostureSummary } from '@/services/military-surge';
import type { NewsPanel } from '@/components/NewsPanel';
import type { AviationCommandBar } from '@/components/AviationCommandBar';
import { MobilePanelNav } from '@/components/MobilePanelNav';
import { debounce, loadFromStorage, saveToStorage } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import {
  FEEDS,
  CANONICAL_FEEDS,
  INTEL_SOURCES,
  STORAGE_KEYS,
  SITE_VARIANT,
  ALL_PANELS,
  VARIANT_DEFAULTS,
  isPanelInVariantDefaults,
  getEffectivePanelConfig,
  isPanelEntitled,
  enforceFreePanelLimit,
} from '@/config';
import { resolveNewsCategories, enabledNewsCategoryKeys } from '@/config/feed-resolution';
import { BETA_MODE } from '@/config/beta';
import { t } from '@/services/i18n';
import { getCurrentTheme } from '@/utils';
import { trackCriticalBannerAction, trackCheckoutSuccess, trackCheckoutFailed, replayPendingCheckoutSuccess, replayPendingProFunnelEvents } from '@/services/analytics';
import { getStoredMapModePreference } from '@/services/map-mode-preference';
import { loadWidgets, saveWidget, isProUser } from '@/services/widget-store';
import type { CustomWidgetSpec } from '@/services/widget-store';
import { initEntitlementSubscription, destroyEntitlementSubscription, isEntitled, hasTier, getEntitlementState, onEntitlementChange, shouldReloadOnEntitlementChange } from '@/services/entitlements';
import { initSubscriptionWatch, destroySubscriptionWatch } from '@/services/billing';
import { initPaymentFailureBanner } from '@/components/payment-failure-banner';
import { handleCheckoutReturn } from '@/services/checkout-return';
import { registerCheckoutSuccessCallback, destroyCheckoutOverlay, showCheckoutSuccess, consumePostCheckoutFlag, clearCheckoutAttempt } from '@/services/checkout';
import { showCheckoutFailureBanner } from '@/components/checkout-failure-banner';
import { PanelTabBar } from '@/components/PanelTabBar';
import {
  loadTabsState,
  saveTabsState,
  generateTabId,
  buildDefaultTabPanels,
} from '@/services/tab-store';
import type { PanelTab, TabsState } from '@/services/tab-store';
import { showToast } from '@/utils';
import { loadMcpPanels, saveMcpPanel } from '@/services/mcp-store';
import type { McpPanelSpec } from '@/services/mcp-store';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import type { AuthSession } from '@/services/auth-state';
import { PanelGateReason, getPanelGateReason, hasPremiumAccess } from '@/services/panel-gating';
import { markLcpDebug } from '@/utils/lcp-debug';
import type { Panel } from '@/components/Panel';
import type { SupplyChainPanel } from '@/components/SupplyChainPanel';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { loadPanelCollapsed, loadPanelColSpans, loadPanelSpans } from '@/utils/panel-storage';
import { measure, mutate } from '@/utils/layout-batch';

function readSessionStorageValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorageValue(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Banner dismissal remains functional for this render even without persistence.
  }
}

/**
 * Panels that require premium access on web. Auth-based gating applies to
 * these — `updatePanelGating()` calls `Panel.showGatedCta()` to render
 * "Sign In to Unlock" / "Upgrade to Pro" for non-premium users.
 *
 * INVARIANT: every panel listed in `apiKeyPanels` (src/config/panels.ts
 * `isPanelEntitled`) MUST appear here. If it's API-key-entitled but missing
 * from this set, anonymous/free-Clerk users see the panel mount and run
 * its loader (which writes empty/loading/error UI directly into the body)
 * instead of the lock CTA. The PRO badge in the title still renders, so
 * the symptom is "PRO badge + panel-internal loading or empty copy"
 * which looks broken (e.g. Regional Intelligence rendering its empty-state
 * "is being refreshed" message to anonymous users — see todo #257 item 8).
 *
 * The static test in tests/panel-config-guardrails.test.mjs enforces
 * `apiKeyPanels ⊆ WEB_PREMIUM_PANELS` so this drift can't recur silently.
 */
const WEB_PREMIUM_PANELS = new Set([
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'market-implications',
  'deduction',
  'chat-analyst',
  'wsb-ticker-scanner',
  'latest-brief',
  'regional-intelligence',
  'trade-policy',
]);

/**
 * Panels that require a Clerk-authenticated PRO account specifically.
 * Desktop API key / browser tester keys do NOT satisfy the gate because
 * these panels are bound to a Clerk userId server-side (e.g. the Brief
 * is stored at brief:{clerkUserId}:{date} in Redis — no Clerk user, no
 * brief to fetch).
 *
 * Without this extra gate, API-key + free-Clerk users would see the
 * panel "unlocked" by hasPremiumAccess() and then hit a 403 when the
 * server re-checks entitlement from the JWT. This set promotes the
 * inconsistency to the layout gating layer so the user sees the
 * correct "Upgrade to Pro" CTA instead of a doomed fetch.
 */
const WEB_CLERK_PRO_ONLY_PANELS = new Set([
  'latest-brief',
]);

const COLLIDING_NEWS_PANEL_KEYS = new Set(['markets', 'crypto', 'economic']);

// TEMPORARY MIRROR of each panel constructor's footprint (`defaultRowSpan` /
// `className: 'panel-wide'`, declared in src/components/*Panel.ts). A deferred
// shell never instantiates its component, so it cannot read that footprint
// directly and must reproduce it here to reserve the right grid space.
//
// This duplicates the authoritative per-component declaration. Two guards keep
// it honest: `tests/panel-config-guardrails.test.mjs` fails CI on drift, and
// `warnOnDeferredFootprintDrift` (below) logs in dev if a hydrated panel ends
// up wider/taller than its reserved shell. The intended long-term fix is to
// lift these defaults into one shared table imported by both the `Panel`
// constructor and this map, removing the duplication entirely (see #4490).
export const DEFERRED_PANEL_NATURAL_FOOTPRINTS: Readonly<Record<string, DeferredPanelShellFootprint>> = {
  cii: { rowSpan: 2 },
  'chat-analyst': { rowSpan: 2 },
  'consumer-prices': { rowSpan: 2 },
  displacement: { rowSpan: 2 },
  economic: { rowSpan: 2 },
  'energy-complex': { rowSpan: 2 },
  'energy-crisis': { rowSpan: 2 },
  'energy-disruptions': { rowSpan: 2 },
  'fuel-shortages': { rowSpan: 2 },
  'gdelt-intel': { rowSpan: 2 },
  'internet-disruptions': { rowSpan: 2 },
  'live-news': { className: 'panel-wide' },
  'live-webcams': { className: 'panel-wide' },
  'oil-inventories': { rowSpan: 2 },
  'pipeline-status': { rowSpan: 2 },
  'sanctions-pressure': { rowSpan: 2 },
  'security-advisories': { rowSpan: 2 },
  'storage-facility-map': { rowSpan: 2 },
  'strategic-posture': { rowSpan: 2 },
  'supply-chain': { rowSpan: 2 },
  'telegram-intel': { rowSpan: 2 },
  'threat-timeline': { rowSpan: 2 },
  'trade-policy': { rowSpan: 2 },
  'ucdp-events': { rowSpan: 2 },
  'windy-webcams': { className: 'panel-wide' },
};

const DEFERRED_DYNAMIC_PANEL_FOOTPRINTS: Readonly<Record<string, DeferredPanelShellFootprint>> = {
  'cw-': { rowSpan: 2 },
  'mcp-': { rowSpan: 2 },
};

const DEFERRED_PANEL_RETRY_DELAY_MS = 1_000;
const DEFERRED_PANEL_MAX_RETRY_ATTEMPTS = 3;

function readRowSpanClass(element: HTMLElement): number {
  if (element.classList.contains('span-4')) return 4;
  if (element.classList.contains('span-3')) return 3;
  if (element.classList.contains('span-2')) return 2;
  return 1;
}

function readColSpanFootprint(element: HTMLElement): number {
  if (element.classList.contains('col-span-3')) return 3;
  if (element.classList.contains('col-span-2')) return 2;
  if (element.classList.contains('col-span-1')) return 1;
  return element.classList.contains('panel-wide') ? 2 : 1;
}

// Dev-only guard: if a hydrated panel ends up taller/wider than the shell we
// reserved for it, the registry above drifted from the panel constructor and
// the deferred shell just caused the layout shift it exists to prevent. Surface
// it in the app (CI also catches drift via panel-config-guardrails).
function warnOnDeferredFootprintDrift(key: string, placeholder: HTMLElement, real: HTMLElement): void {
  const reservedRows = readRowSpanClass(placeholder);
  const reservedCols = readColSpanFootprint(placeholder);
  const realRows = readRowSpanClass(real);
  const realCols = readColSpanFootprint(real);
  if (realRows > reservedRows || realCols > reservedCols) {
    console.warn(
      `[PanelLayoutManager] Deferred shell footprint drift for "${key}": reserved ` +
        `${reservedCols}x${reservedRows} (col x row) but panel hydrated to ${realCols}x${realRows}. ` +
        'Update DEFERRED_PANEL_NATURAL_FOOTPRINTS to match the panel constructor.',
    );
  }
}

type BootShellFootprintKey = 'header' | 'tabs' | 'main' | 'map' | 'grid';

type BootShellFootprintBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type BootShellFootprintSnapshot = Partial<Record<BootShellFootprintKey, BootShellFootprintBox>>;

const BOOT_SHELL_FOOTPRINT_TARGETS: ReadonlyArray<{
  key: BootShellFootprintKey;
  shellSelector: string;
  appSelector: string;
}> = [
  { key: 'header', shellSelector: '.skeleton-header', appSelector: '.header' },
  { key: 'tabs', shellSelector: '.skeleton-tabs', appSelector: '#panelTabsMount' },
  { key: 'main', shellSelector: '.skeleton-main', appSelector: '#main' },
  { key: 'map', shellSelector: '.skeleton-map', appSelector: '#mapSection' },
  { key: 'grid', shellSelector: '.skeleton-grid', appSelector: '#panelsGrid' },
];

function readFootprintBox(root: ParentNode, selector: string): BootShellFootprintBox | null {
  const el = root.querySelector<Element>(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

function captureBootShellFootprint(root: ParentNode): BootShellFootprintSnapshot | null {
  if (!root.querySelector('.skeleton-shell')) return null;
  const snapshot: BootShellFootprintSnapshot = {};
  for (const target of BOOT_SHELL_FOOTPRINT_TARGETS) {
    const box = readFootprintBox(root, target.shellSelector);
    if (box) snapshot[target.key] = box;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function formatFootprintDelta(before: BootShellFootprintBox, after: BootShellFootprintBox): string {
  const delta = (field: keyof BootShellFootprintBox) => Math.round((after[field] - before[field]) * 10) / 10;
  return `dx=${delta('x')}, dy=${delta('y')}, dw=${delta('width')}, dh=${delta('height')}`;
}

function warnOnBootShellFootprintDrift(snapshot: BootShellFootprintSnapshot): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const drifts: string[] = [];
      for (const target of BOOT_SHELL_FOOTPRINT_TARGETS) {
        const before = snapshot[target.key];
        const after = readFootprintBox(document, target.appSelector);
        if (!before || !after) continue;
        const maxDelta = Math.max(
          Math.abs(after.x - before.x),
          Math.abs(after.y - before.y),
          Math.abs(after.width - before.width),
          Math.abs(after.height - before.height),
        );
        if (maxDelta > 2) {
          drifts.push(`${target.key} ${formatFootprintDelta(before, after)}`);
        }
      }
      if (drifts.length === 0) return;
      console.warn(
        '[PanelLayoutManager] Boot shell footprint drift during skeleton->app swap: ' +
          `${drifts.join('; ')}. Keep index.html skeleton dimensions in parity with the first hydrated dashboard frame.`,
      );
    });
  });
}

export interface PanelLayoutManagerCallbacks {
  openCountryStory: (code: string, name: string) => void;
  openCountryBrief: (code: string) => void;
  loadAllData: (forceAll?: boolean) => Promise<void>;
  updateMonitorResults: () => void;
  loadSecurityAdvisories?: () => Promise<void>;
  applyMapLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'programmatic') => void;
}

interface DeferredPanelMount {
  panel: Panel | null;
  placeholder: HTMLElement | null;
  observer: IntersectionObserver | null;
  mounted: boolean;
  loading: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempts: number;
  failed: boolean;
}

interface LazyPanelRegistration {
  load: () => Promise<Panel | null>;
  loading: Promise<Panel | null> | null;
}

type AnyPanelConstructor = new (...args: any[]) => Panel;
type PanelExport<M, K extends keyof M> = M[K] extends AnyPanelConstructor ? M[K] : never;
type ImportedPanel<M, K extends keyof M> = InstanceType<PanelExport<M, K>>;

type HydrationSchedulePhase = 'visible' | 'near';

export class PanelLayoutManager implements AppModule {
  private ctx: AppContext;
  private callbacks: PanelLayoutManagerCallbacks;
  private panelDragCleanupHandlers: Array<() => void> = [];
  private deferredPanelMounts: Map<string, DeferredPanelMount> = new Map();
  private lazyPanelRegistrations: Map<string, LazyPanelRegistration> = new Map();
  private observedHydrationPanels = new WeakSet<Panel>();
  private initiallyMountedEnabledPanelCount = 0;
  private resolvedPanelOrder: string[] = [];
  private bottomSetMemory: Set<string> = new Set();
  private criticalBannerEl: HTMLElement | null = null;
  private mobilePanelNav: MobilePanelNav | null = null;
  private mobileMapCollapseBtn: HTMLButtonElement | null = null;
  private panelTabBar: PanelTabBar | null = null;
  private tabsState: TabsState | null = null;
  private aviationCommandBar: AviationCommandBar | null = null;
  private readonly applyTimeRangeFilterDebounced: (() => void) & { cancel(): void };
  private unsubscribeAuth: (() => void) | null = null;
  private proBlockUnsubscribe: (() => void) | null = null;
  private proBlockEntitlementUnsubscribe: (() => void) | null = null;
  private boundWidgetCreatorHandler: ((e: Event) => void) | null = null;
  private unsubscribeEntitlementChange: (() => void) | null = null;
  private unsubscribePaymentFailureBanner: (() => void) | null = null;
  private scheduledLoadAllRaf: number | null = null;
  private scheduledLoadAllIdle: number | null = null;
  private responsiveZoneListener: ResponsiveZoneListener | null = null;

  constructor(ctx: AppContext, callbacks: PanelLayoutManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.applyTimeRangeFilterDebounced = debounce(() => {
      this.applyTimeRangeFilterToNewsPanels();
    }, 120);

    // Dodo Payments: entitlement subscription + billing watch for ALL users.
    // Free users need the subscription active so they receive real-time
    // entitlement updates after purchasing (P1: newly upgraded users must
    // see their premium access without a manual page reload).
    //
    // Two return paths need to seed the transition detector as post-checkout:
    //   1. Full-page Dodo redirect — handleCheckoutReturn() reads
    //      subscription_id/status URL params and cleans them.
    //   2. Dodo overlay success — setTimeout(reload) with no URL params;
    //      we stash a session flag before the reload and consume it here.
    const returnResult = handleCheckoutReturn();
    const returnedFromOverlay = consumePostCheckoutFlag();
    const returnedFromCheckout = returnResult.kind === 'success' || returnedFromOverlay;
    if (returnedFromCheckout) {
      // Funnel (#4931): the purchase-complete signal on the client side.
      // Queued by the analytics facade until Umami loads after first paint.
      trackCheckoutSuccess(returnResult.kind === 'success' ? 'url-return' : 'overlay-flag');
      // Full-page return cleared its URL params; belt-and-braces clear
      // of the attempt record here catches the success path where the
      // overlay handler never ran (direct Dodo redirect).
      clearCheckoutAttempt('success');
      // waitForEntitlement: true keeps the banner mounted across the
      // entitlement-watcher reload (post-PR-4 the watcher is the single
      // reload source). If the user is already entitled on mount the
      // banner goes straight to the "active" state; otherwise it waits
      // up to 30s for the transition before surfacing a manual-refresh
      // CTA. `email` is read from auth-state (authoritative on the main
      // app) and masked in the banner before rendering to keep the raw
      // address out of screenshots / screen-shares of the banner.
      showCheckoutSuccess({
        waitForEntitlement: true,
        email: getAuthState().user?.email ?? null,
      });
    } else if (returnResult.kind === 'failed') {
      trackCheckoutFailed(returnResult.rawStatus);
      showCheckoutFailureBanner(returnResult.rawStatus);
    }
    if (!returnedFromCheckout) {
      // #4934 round-2 F2: the entitlement watcher reloads the page the
      // moment Pro lands — often before the deferred Umami queue flushes,
      // which would silently drop the terminal checkout-success event.
      // This boot-time replay re-queues it from the durable marker the
      // pre-reload track left behind (no-op on ordinary loads).
      replayPendingCheckoutSuccess();
    }
    // #4934 round-5: /pro checkout-start events that died with the Dodo
    // redirect are mirrored in sessionStorage; the buyer lands back here
    // in the same tab — on BOTH the checkout-return and ordinary branches —
    // so this replay is unconditional (no-op when nothing is pending).
    replayPendingProFunnelEvents();

    // Always register the payment-failure-banner listener — onSubscriptionChange
    // is an in-memory listener registry, doesn't open any network connection,
    // and survives the destroy/reinit cycle on auth transitions (see
    // billing.ts:124-126). Registering once here means the banner reacts when
    // a user signs in mid-session and the App.ts auth-state subscription
    // (App.ts:995-1006) starts the Convex subscription watch.
    this.unsubscribePaymentFailureBanner = initPaymentFailureBanner();

    // Defer Convex subscriptions until a real Clerk identity exists.
    //
    // `getUserId()` (user-identity.ts) always returns truthy for browser
    // users — it falls back to an auto-generated `wm-anon-id` UUID — so the
    // previous `if (userId)` gate never short-circuited. That meant every
    // anonymous visitor opened a Convex WebSocket via getConvexClient()
    // with `setAuth(getClerkToken)` returning null, which the Convex SDK
    // could not authenticate, producing a constant
    //   `WebSocket connection to wss://…/api/1.34.0/sync failed`
    // reconnect loop in DevTools (todo #257 item 4). The subscriptions
    // themselves never delivered useful state for anon users either:
    //   - getEntitlementsForUser returns FREE_TIER_DEFAULTS without auth
    //   - getSubscriptionForUser returns null without auth
    // — so the loop was pure noise.
    //
    // For users who sign in mid-session, App.ts:1003-1006 destroys and
    // re-initializes both subscriptions against the real Clerk userId, so
    // skipping here is a no-op for the signed-in path.
    //
    // Note: PanelLayoutManager is constructed before initAuthState() awaits
    // Clerk, so getAuthState().user is null even for users who will silently
    // restore a Clerk session on this page load. Those users are picked up
    // by subscribeAuthState a few hundred ms later via the same App.ts
    // rebind path. Constructor-time anon is the common case.
    if (getAuthState().user) {
      const userId = getAuthState().user!.id;
      initEntitlementSubscription(userId).catch(() => {});
      initSubscriptionWatch(userId).catch(() => {});
    }

    // Overlay success fires BEFORE the entitlement-watcher reload. The
    // banner stays mounted through the reload via waitForEntitlement so
    // the user sees visual continuity from "Payment received!" through
    // "Premium activated" without a blank intermediate state. Read the
    // email lazily at fire-time (not at register-time) so a just-signed-
    // in buyer who completes checkout in the same session still sees
    // the receipt acknowledgement.
    registerCheckoutSuccessCallback(() => showCheckoutSuccess({
      waitForEntitlement: true,
      email: getAuthState().user?.email ?? null,
    }));

    // Reload only on a free→pro transition. Legacy-pro users whose first
    // snapshot is already pro (lastEntitled === null) must not trigger a
    // reload loop, but a user who pays mid-session (false → true) must see
    // their panels unlock without manual refresh.
    //
    // When we just returned from a Dodo full-page redirect checkout, seed
    // lastEntitled = false instead of null. The webhook may have already
    // landed by the time the user's browser comes back, so the first
    // entitlement snapshot can arrive as pro. Without this seed the
    // transition detector would swallow that snapshot as "legacy-pro" and
    // the user would see locked panels until a manual refresh — exactly the
    // symptom that caused the 2026-04-17/18 duplicate-subscription incident.
    //
    // REQUIRES_SKIP_INITIAL_SNAPSHOT_BEHAVIOR — the watcher is the SOLE
    // automatic reload source for post-checkout success (the overlay
    // handler in checkout.ts deliberately does NOT reload). If PR #3163's
    // fix to `skipInitialSnapshot` is ever reverted, this detector
    // swallows the activation silently and users see locked panels for
    // 30s until the extended-unlock timeout fires a manual-refresh CTA.
    // Regression guard: tests/entitlement-transition.test.mts locks the
    // "incident sequence" semantics; see mirror marker in checkout.ts.
    let lastEntitled: boolean | null = returnedFromCheckout ? false : null;
    this.unsubscribeEntitlementChange = onEntitlementChange(() => {
      const entitled = isEntitled();
      const reload = shouldReloadOnEntitlementChange(lastEntitled, entitled);
      lastEntitled = entitled;
      if (reload) {
        console.log('[entitlements] Subscription activated — reloading to unlock panels');
        window.location.reload();
        return;
      }
      // Re-run panel gating on every entitlement snapshot. hasPremiumAccess()
      // now consults isEntitled(), so a legacy-pro user whose first snapshot
      // is already pro (null→true — intentionally not reloaded to avoid a
      // loop) still needs the paywall overlay lifted; likewise on WS reconnect
      // or entitlement revocation, the lock state must follow the current
      // snapshot synchronously rather than waiting for the next auth event.
      this.updatePanelGating(getAuthState());
    });
  }

  async init(): Promise<void> {
    await this.renderLayout();
    if (this.ctx.isDestroyed) return;

    // Subscribe to auth state for reactive panel gating on web
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.updatePanelGating(state);
    });

    // Handle analyst action chip "Create chart widget →" click
    this.boundWidgetCreatorHandler = ((e: CustomEvent<{ initialMessage?: string }>) => {
      void import('@/components/WidgetChatModal').then((m) => m.openWidgetChatModal({
        mode: 'create',
        tier: 'pro',
        initialMessage: e.detail.initialMessage,
        onComplete: (spec) => this.addCustomWidget(spec),
      })).catch((err) => console.error('[widget-chat] failed to lazy-load WidgetChatModal', err));
    }) as EventListener;
    this.ctx.container.addEventListener('wm:open-widget-creator', this.boundWidgetCreatorHandler);
  }

  destroy(): void {
    clearAllPendingCalls();
    this.applyTimeRangeFilterDebounced.cancel();
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.proBlockUnsubscribe?.();
    this.proBlockUnsubscribe = null;
    this.proBlockEntitlementUnsubscribe?.();
    this.proBlockEntitlementUnsubscribe = null;

    const destroyedTargets = new Set<{ destroy?: () => void }>();
    const destroyOnce = (target: { destroy?: () => void } | null | undefined): void => {
      if (!target || destroyedTargets.has(target)) return;
      destroyedTargets.add(target);
      // Isolate each destroy(): teardown runs over every registered panel, so a
      // single panel throwing must not abort the remaining panel/subscription/
      // overlay cleanup below (nor the rest of App.destroy(), which iterates
      // modules without its own try/catch).
      try {
        target.destroy?.();
      } catch (err) {
        console.error('[panel] destroy() threw during teardown', err);
      }
    };
    if (this.boundWidgetCreatorHandler) {
      this.ctx.container.removeEventListener('wm:open-widget-creator', this.boundWidgetCreatorHandler);
      this.boundWidgetCreatorHandler = null;
    }
    this.panelDragCleanupHandlers.forEach((cleanup) => cleanup());
    this.panelDragCleanupHandlers = [];
    for (const deferred of this.deferredPanelMounts.values()) {
      deferred.observer?.disconnect();
      if (deferred.retryTimer !== null) {
        clearTimeout(deferred.retryTimer);
      }
    }
    this.deferredPanelMounts.clear();
    this.lazyPanelRegistrations.clear();
    this.initiallyMountedEnabledPanelCount = 0;
    this.cancelScheduledLoadAllIdle();
    if (this.scheduledLoadAllRaf !== null) {
      cancelAnimationFrame(this.scheduledLoadAllRaf);
      this.scheduledLoadAllRaf = null;
    }
    if (this.criticalBannerEl) {
      this.criticalBannerEl.remove();
      this.criticalBannerEl = null;
    }
    this.mobilePanelNav?.destroy();
    this.mobilePanelNav = null;
    this.mobileMapCollapseBtn = null;
    this.panelTabBar?.destroy();
    this.panelTabBar = null;
    // Clean up happy variant panels
    destroyOnce(this.ctx.tvMode);
    this.ctx.tvMode = null;
    destroyOnce(this.ctx.countersPanel);
    this.ctx.countersPanel = null;
    destroyOnce(this.ctx.progressPanel);
    this.ctx.progressPanel = null;
    destroyOnce(this.ctx.breakthroughsPanel);
    this.ctx.breakthroughsPanel = null;
    destroyOnce(this.ctx.heroPanel);
    this.ctx.heroPanel = null;
    destroyOnce(this.ctx.digestPanel);
    this.ctx.digestPanel = null;
    destroyOnce(this.ctx.speciesPanel);
    this.ctx.speciesPanel = null;
    destroyOnce(this.ctx.positivePanel);
    this.ctx.positivePanel = null;
    destroyOnce(this.ctx.renewablePanel);
    this.ctx.renewablePanel = null;

    // Clean up aviation components
    destroyOnce(this.aviationCommandBar);
    this.aviationCommandBar = null;

    // Destroy every registered panel exactly once, including lazy-created
    // and self-fetching panels that own subscriptions, intervals, or aborts.
    for (const panel of Object.values(this.ctx.panels)) {
      destroyOnce(panel);
    }
    for (const key of Object.keys(this.ctx.panels)) {
      delete this.ctx.panels[key];
    }
    // News panels are the same instances just destroyed above; drop the
    // secondary index so it never hands out a torn-down panel post-destroy.
    for (const key of Object.keys(this.ctx.newsPanels)) {
      delete this.ctx.newsPanels[key];
    }

    // Clean up billing subscription watch + entitlement subscription
    destroySubscriptionWatch();
    destroyEntitlementSubscription();

    // Clean up entitlement change listener
    this.unsubscribeEntitlementChange?.();
    this.unsubscribeEntitlementChange = null;

    // Clean up payment failure banner subscription
    this.unsubscribePaymentFailureBanner?.();
    this.unsubscribePaymentFailureBanner = null;

    // Reset checkout overlay so next layout init can register its callback
    destroyCheckoutOverlay();

    removeResponsiveZoneListener(this.responsiveZoneListener);
    this.responsiveZoneListener = null;
  }

  /** Reactively update premium panel gating based on auth state. */
  private updatePanelGating(state: AuthSession): void {
    for (const [key, panel] of Object.entries(this.ctx.panels)) {
      const isPremium = WEB_PREMIUM_PANELS.has(key);
      let reason = getPanelGateReason(state, isPremium);

      // Clerk-pro-only panels: even when hasPremiumAccess() returns
      // true via API/tester key, these panels need a Clerk userId
      // bound to a PRO entitlement. We DO NOT trust client-side
      // entitlement state as an authoritative gate — the server-side
      // /api/latest-brief check is authoritative. We only downgrade
      // the gate reason here as AFFIRMATIVE DENIAL: when we KNOW
      // (snapshot loaded AND tier < 1) the user is free. In every
      // other case — snapshot not yet loaded, Convex subscription
      // skipped, transient failure — we leave the panel unlocked
      // and let the server 403 path drive the upgrade CTA inside
      // the panel's refresh() catch block.
      //
      // Prior iterations of this code tried the opposite — gating
      // positively on hasTier(1) — and locked legitimate Pro users
      // out whenever the Convex snapshot was late, skipped, or
      // failed. Affirmative-denial-only is the right shape: never
      // over-gate, accept the one-doomed-fetch-per-session cost
      // for API-key-only + free-Clerk users as the lesser harm.
      if (
        reason === PanelGateReason.NONE &&
        WEB_CLERK_PRO_ONLY_PANELS.has(key) &&
        getEntitlementState() !== null &&
        !hasTier(1)
      ) {
        reason = state.user ? PanelGateReason.FREE_TIER : PanelGateReason.ANONYMOUS;
      }

      if (reason === PanelGateReason.NONE) {
        // User has access -- unlock if previously locked
        (panel as Panel).unlockPanel();
      } else {
        // User does NOT have access -- show appropriate CTA
        const onAction = this.getGateAction(reason);
        (panel as Panel).showGatedCta(reason, onAction);
      }
    }
  }

  /** Return the action callback for a given gate reason. */
  private getGateAction(reason: PanelGateReason): () => void {
    switch (reason) {
      case PanelGateReason.ANONYMOUS:
        return () => this.ctx.authModal?.open();
      case PanelGateReason.FREE_TIER:
        return () => window.open('https://worldmonitor.app/pro', '_blank', 'noopener,noreferrer');
      default:
        return () => {};
    }
  }

  /** #5159/#5205 review: storage access can throw (blocked cookies, sandboxed
   *  iframe) and this runs BEFORE the shell installs — an uncaught throw would
   *  strand users on the boot skeleton. loadFromStorage is try/catch-guarded;
   *  default is expanded. Wire format stays 'true'/'false' (JSON booleans),
   *  identical to the previous String(isCollapsed) writes. */
  private static isMobileMapCollapsedPreferred(): boolean {
    return loadFromStorage<boolean>('mobile-map-collapsed', false) === true;
  }

  async renderLayout(): Promise<void> {
    const isGlobeMode = getStoredMapModePreference() === 'globe';
    // #5159: the collapsed-map cohort's #mapSection must be CREATED with
    // .collapsed — main.css sets the expanded mobile height with !important
    // inside a cascade layer, and layered !important beats any unlayered
    // pre-paint override (inverse of the normal-declaration rule), so the
    // html.wm-map-collapsed critical CSS can only cover the boot SKELETON.
    // Seeding the class here makes the runtime collapsed rule apply from the
    // section's first frame instead of ~150ms later via setupMobileMapToggle
    // (which shoved #panelsGrid up 698px, field CLS ~0.62 for this cohort).
    const mapStartsCollapsed = this.ctx.isMobile && PanelLayoutManager.isMobileMapCollapsedPreferred();
    const bootShellFootprint = import.meta.env.DEV ? captureBootShellFootprint(this.ctx.container) : null;

    markLcpDebug('wm:layout:render-start');
    document.documentElement.classList.add('wm-layout-hydrated');
    setTrustedHtml(this.ctx.container, trustedHtml(`
      ${this.ctx.isDesktopApp ? '<div class="tauri-titlebar" data-tauri-drag-region></div>' : ''}
      <a href="#main" class="skip-link">Skip to main content</a>
      <div id="proBannerSlot" class="pro-banner-slot" aria-live="polite"></div>
      <div class="header">
        <div class="header-left">
          <button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div class="variant-switcher">${(() => {
        const local = this.ctx.isDesktopApp || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const inIframe = window.self !== window.top;
        const vHref = (v: string, prod: string) => local || SITE_VARIANT === v ? '#' : prod;
        const vTarget = (v: string) => !local && SITE_VARIANT !== v && inIframe ? 'target="_blank" rel="noopener"' : '';
        return `
            <a href="${vHref('full', 'https://worldmonitor.app/dashboard')}"
               class="variant-option ${SITE_VARIANT === 'full' ? 'active' : ''}"
               data-variant="full"
               ${vTarget('full')}
               title="${t('header.world')}${SITE_VARIANT === 'full' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">🌍</span>
              <span class="variant-label">${t('header.world')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('tech', 'https://tech.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'tech' ? 'active' : ''}"
               data-variant="tech"
               ${vTarget('tech')}
               title="${t('header.tech')}${SITE_VARIANT === 'tech' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">💻</span>
              <span class="variant-label">${t('header.tech')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('finance', 'https://finance.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'finance' ? 'active' : ''}"
               data-variant="finance"
               ${vTarget('finance')}
               title="${t('header.finance')}${SITE_VARIANT === 'finance' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">📈</span>
              <span class="variant-label">${t('header.finance')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('commodity', 'https://commodity.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'commodity' ? 'active' : ''}"
               data-variant="commodity"
               ${vTarget('commodity')}
               title="${t('header.commodity')}${SITE_VARIANT === 'commodity' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">⛏️</span>
              <span class="variant-label">${t('header.commodity')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('energy', 'https://energy.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'energy' ? 'active' : ''}"
               data-variant="energy"
               ${vTarget('energy')}
               title="${t('header.energy')}${SITE_VARIANT === 'energy' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">⚡</span>
              <span class="variant-label">${t('header.energy')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('happy', 'https://happy.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'happy' ? 'active' : ''}"
               data-variant="happy"
               ${vTarget('happy')}
               title="Good News${SITE_VARIANT === 'happy' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">☀️</span>
              <span class="variant-label">Good News</span>
            </a>`;
      })()}</div>
          <span class="logo">MONITOR</span><span class="logo-mobile">World Monitor</span><span class="version">v${__APP_VERSION__}</span>${BETA_MODE ? '<span class="beta-badge">BETA</span>' : ''}
          <a href="https://x.com/eliehabib" target="_blank" rel="noopener" class="credit-link">
            <svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            <span class="credit-text">@eliehabib</span>
          </a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener" class="github-link" title="${t('header.viewOnGitHub')}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>
          <button class="mobile-settings-btn" id="mobileSettingsBtn" title="${t('header.settings')}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>${t('header.live')}</span>
          </div>
          <div class="region-selector">
            <select id="regionSelect" class="region-select" aria-label="${t('header.selectRegion')}">
              <option value="global">${t('components.deckgl.views.global')}</option>
              <option value="america">${t('components.deckgl.views.americas')}</option>
              <option value="mena">${t('components.deckgl.views.mena')}</option>
              <option value="eu">${t('components.deckgl.views.europe')}</option>
              <option value="asia">${t('components.deckgl.views.asia')}</option>
              <option value="latam">${t('components.deckgl.views.latam')}</option>
              <option value="africa">${t('components.deckgl.views.africa')}</option>
              <option value="oceania">${t('components.deckgl.views.oceania')}</option>
            </select>
          </div>
          <span id="missionPresetMount" class="mission-preset-mount"></span>
          <button class="mobile-search-btn" id="mobileSearchBtn" aria-label="${t('header.search')}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </div>
        <div class="header-right">
          <button class="search-btn" id="searchBtn"><kbd>⌘K</kbd> ${t('header.search')}</button>
          ${this.ctx.isDesktopApp ? '' : `<button class="copy-link-btn" id="copyLinkBtn">${t('header.copyLink')}</button>`}
          ${this.ctx.isDesktopApp ? '' : `<button class="copy-link-btn embed-link-btn" id="embedLinkBtn">${t('header.embed')}</button>`}
          ${this.ctx.isDesktopApp ? '' : `<button class="fullscreen-btn" id="fullscreenBtn" title="${t('header.fullscreen')}">⛶</button>`}
          ${SITE_VARIANT === 'happy' ? `<button class="tv-mode-btn" id="tvModeBtn" title="TV Mode (Shift+T)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>` : ''}
          <span id="unifiedSettingsMount"></span>
          <span id="authWidgetMount" class="auth-widget-mount"></span>
        </div>
      </div>
      <div class="mobile-menu-overlay" id="mobileMenuOverlay"></div>
      <nav class="mobile-menu" id="mobileMenu">
        <div class="mobile-menu-header">
          <span class="mobile-menu-title">WORLD MONITOR</span>
          <button class="mobile-menu-close" id="mobileMenuClose" aria-label="Close menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="mobile-menu-divider"></div>
        ${(() => {
        const variants = [
          { key: 'full', icon: '🌍', label: t('header.world') },
          { key: 'tech', icon: '💻', label: t('header.tech') },
          { key: 'finance', icon: '📈', label: t('header.finance') },
          { key: 'commodity', icon: '⛏️', label: t('header.commodity') },
          { key: 'energy', icon: '⚡', label: t('header.energy') },
          { key: 'happy', icon: '☀️', label: 'Good News' },
        ];
        return variants.map(v =>
          `<button class="mobile-menu-item mobile-menu-variant ${v.key === SITE_VARIANT ? 'active' : ''}" data-variant="${v.key}">
            <span class="mobile-menu-item-icon">${v.icon}</span>
            <span class="mobile-menu-item-label">${v.label}</span>
            ${v.key === SITE_VARIANT ? '<span class="mobile-menu-check">✓</span>' : ''}
          </button>`
        ).join('');
      })()}
        <div class="mobile-menu-divider"></div>
        <button class="mobile-menu-item" id="mobileMenuRegion">
          <span class="mobile-menu-item-icon">🌐</span>
          <span class="mobile-menu-item-label">${t('components.deckgl.views.global')}</span>
          <span class="mobile-menu-chevron">▸</span>
        </button>
        <button class="mobile-menu-item" id="mobileMenuMission">
          <span class="mobile-menu-item-icon">◎</span>
          <span class="mobile-menu-item-label">Mission</span>
          <span class="mobile-menu-chevron">▸</span>
        </button>
        <div class="mobile-menu-divider"></div>
        <button class="mobile-menu-item" id="mobileMenuSettings">
          <span class="mobile-menu-item-icon">⚙️</span>
          <span class="mobile-menu-item-label">${t('header.settings')}</span>
        </button>
        <button class="mobile-menu-item" id="mobileMenuTheme">
          <span class="mobile-menu-item-icon">${getCurrentTheme() === 'dark' ? '☀️' : '🌙'}</span>
          <span class="mobile-menu-item-label">${getCurrentTheme() === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
        <a class="mobile-menu-item" href="https://x.com/eliehabib" target="_blank" rel="noopener">
          <span class="mobile-menu-item-icon"><svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></span>
          <span class="mobile-menu-item-label">@eliehabib</span>
        </a>
        <div class="mobile-menu-divider"></div>
        <div class="mobile-menu-footer-links">
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/pro' : 'https://www.worldmonitor.app/pro'}" target="_blank" rel="noopener">Pro</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/blog/' : 'https://www.worldmonitor.app/blog/'}" target="_blank" rel="noopener">Blog</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/docs' : 'https://www.worldmonitor.app/docs'}" target="_blank" rel="noopener">Docs</a>
          <a href="https://status.worldmonitor.app/" target="_blank" rel="noopener">Status</a>
        </div>
        <div class="mobile-menu-version">v${__APP_VERSION__}</div>
      </nav>
      <div class="region-sheet-backdrop" id="regionSheetBackdrop"></div>
      <div class="region-bottom-sheet" id="regionBottomSheet">
        <div class="region-sheet-header">${t('header.selectRegion')}</div>
        <div class="region-sheet-divider"></div>
        ${[
        { value: 'global', label: t('components.deckgl.views.global') },
        { value: 'america', label: t('components.deckgl.views.americas') },
        { value: 'mena', label: t('components.deckgl.views.mena') },
        { value: 'eu', label: t('components.deckgl.views.europe') },
        { value: 'asia', label: t('components.deckgl.views.asia') },
        { value: 'latam', label: t('components.deckgl.views.latam') },
        { value: 'africa', label: t('components.deckgl.views.africa') },
        { value: 'oceania', label: t('components.deckgl.views.oceania') },
      ].map(r =>
        `<button class="region-sheet-option ${r.value === 'global' ? 'active' : ''}" data-region="${r.value}">
          <span>${r.label}</span>
          <span class="region-sheet-check">${r.value === 'global' ? '✓' : ''}</span>
        </button>`
      ).join('')}
      </div>
      <div class="dashboard-tabs-mount" id="panelTabsMount"></div>
      <main id="main" tabindex="-1" class="main-content${this.ctx.isDesktopApp ? ' desktop-grid' : ''}">
        <div class="map-section${mapStartsCollapsed ? ' collapsed' : ''}" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">${SITE_VARIANT === 'tech' ? t('panels.techMap') : SITE_VARIANT === 'happy' ? 'Good News Map' : t('panels.map')}</span>
            </div>
            <span class="header-clock" id="headerClock" translate="no"></span>
            <div class="map-header-actions">
              <div class="map-dimension-toggle" id="mapDimensionToggle">
                <button class="map-dim-btn${isGlobeMode ? '' : ' active'}" data-mode="flat" title="2D Map">2D</button>
                <button class="map-dim-btn${isGlobeMode ? ' active' : ''}" data-mode="globe" title="3D Globe">3D</button>
              </div>
              <button class="map-pin-btn" id="mapFullscreenBtn" title="Fullscreen">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
              </button>
              <button class="map-pin-btn" id="mapPinBtn" title="${t('header.pinMap')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 1 1 0 001-1V4a1 1 0 00-1-1H8a1 1 0 00-1 1v1a1 1 0 001 1 1 1 0 011 1v3.76z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="map-container" id="mapContainer"></div>
          ${SITE_VARIANT === 'happy' ? '<button class="tv-exit-btn" id="tvExitBtn">Exit TV Mode</button>' : ''}
          <div class="map-resize-handle" id="mapResizeHandle"></div>
          <div class="map-bottom-grid" id="mapBottomGrid"></div>
        </div>
        <div class="map-width-resize-handle" id="mapWidthResizeHandle"></div>
        <div class="panels-grid" id="panelsGrid" role="tabpanel"></div>
        <button class="search-mobile-fab" id="searchMobileFab" aria-label="Search">\u{1F50D}</button>
      </main>
      <footer class="site-footer">
        <div class="site-footer-brand">
          <img src="/favico/android-chrome-96x96.png" alt="" width="28" height="28" loading="lazy" decoding="async" class="site-footer-icon" />
          <div class="site-footer-brand-text">
            <span class="site-footer-name">WORLD MONITOR</span>
            <span class="site-footer-sub">v${__APP_VERSION__} &middot; <a href="https://x.com/eliehabib" target="_blank" rel="noopener" class="site-footer-credit">@eliehabib</a></span>
          </div>
        </div>
        <nav>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/pro' : 'https://www.worldmonitor.app/pro'}" target="_blank" rel="noopener">Pro</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/blog/' : 'https://www.worldmonitor.app/blog/'}" target="_blank" rel="noopener">Blog</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/docs' : 'https://www.worldmonitor.app/docs'}" target="_blank" rel="noopener">Docs</a>
          <a href="https://status.worldmonitor.app/" target="_blank" rel="noopener">Status</a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener">GitHub</a>
          <a href="https://discord.gg/re63kWKxaz" target="_blank" rel="noopener">Discord</a>
          <a href="https://x.com/worldmonitorai" target="_blank" rel="noopener">X</a>
          ${this.ctx.isDesktopApp ? '' : `<span id="footerDownloadMount"></span>`}
        </nav>
        <span class="site-footer-copy">&copy; ${new Date().getFullYear()} World Monitor</span>
      </footer>
    `, "legacy direct innerHTML migration"));
    // Mark AFTER the innerHTML swap so the timestamp reflects when the new shell
    // DOM is actually live — placing it before setTrustedHtml recorded a time
    // earlier than any LCP candidate in the new shell, making it useless for
    // ordering the LCP element against the shell swap (PR #4512 review).
    markLcpDebug('wm:layout:shell-replaced');

    // Skip link: explicitly move focus to <main> on activation. Native
    // fragment focus on a tabindex="-1" target is inconsistent across
    // browsers, so drive it directly to guarantee keyboard users land in the
    // main content (WCAG 2.4.1).
    this.ctx.container.querySelector('.skip-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      const main = document.getElementById('main');
      if (main) {
        main.focus();
        main.scrollIntoView({ block: 'start' });
      }
    });

    await this.createPanels();

    this.initPanelTabs();
    if (import.meta.env.DEV && bootShellFootprint) warnOnBootShellFootprintDrift(bootShellFootprint);

    if (this.ctx.isMobile) {
      this.setupMobileMapToggle();
      this.setupMobilePanelNav();
    }
  }

  // ============================================
  // Dashboard tabs — named, persistent panel workspaces
  // ============================================

  private initPanelTabs(): void {
    const mount = document.getElementById('panelTabsMount');
    if (!mount) return;

    let state = loadTabsState();
    if (!state) {
      // First run — wrap the user's current layout in an initial tab so
      // nothing changes visually until they create a second tab.
      const initial: PanelTab = {
        id: generateTabId(),
        name: t('dashboardTabs.defaultName'),
        ...this.captureCurrentTabState(),
      };
      state = { activeTabId: initial.id, tabs: [initial] };
      saveTabsState(state);
    } else {
      // Clamp stored snapshots to the current free-tier cap so a workspace
      // saved while Pro (or persisted before the cap existed) can't re-enable
      // an over-cap layout when the user later switches to it. applyTabPanelState
      // re-clamps on apply too; this keeps the persisted store self-healing.
      const pro = isProUser();
      let healedSnapshots = false;
      for (const tab of state.tabs) {
        const clamped = enforceFreePanelLimit(tab.panelSettings, pro);
        if (this.panelSettingsEnabledStateChanged(tab.panelSettings, clamped)) {
          healedSnapshots = true;
        }
        tab.panelSettings = clamped;
      }
      if (healedSnapshots) saveTabsState(state);
    }
    this.tabsState = state;

    this.panelTabBar = new PanelTabBar(() => this.tabsState!, {
      onSelect: (id) => this.switchToTab(id),
      onAdd: () => this.addTab(),
      onRename: (id, name) => this.renameTab(id, name),
      onDelete: (id) => this.deleteTab(id),
    });
    mount.appendChild(this.panelTabBar.getElement());
  }

  private panelSettingsEnabledStateChanged(
    before: Record<string, PanelConfig>,
    after: Record<string, PanelConfig>,
  ): boolean {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (before[key]?.enabled !== after[key]?.enabled) return true;
    }
    return false;
  }

  /** Capture the live panel state (settings + order) for a tab snapshot. */
  private captureCurrentTabState(): Pick<PanelTab, 'panelSettings' | 'panelOrder' | 'bottomSet'> {
    // Persist the live DOM order first so the snapshot reflects any drags.
    this.savePanelOrder();
    return {
      panelSettings: JSON.parse(JSON.stringify(this.ctx.panelSettings)) as Record<string, PanelConfig>,
      panelOrder: [...this.resolvedPanelOrder],
      bottomSet: Array.from(this.bottomSetMemory),
    };
  }

  /** Refresh the active tab's snapshot from live state (called on switch-away). */
  private snapshotActiveTab(): void {
    if (!this.tabsState) return;
    const active = this.tabsState.tabs.find((t) => t.id === this.tabsState!.activeTabId);
    if (!active) return;
    Object.assign(active, this.captureCurrentTabState());
  }

  private switchToTab(tabId: string): void {
    if (!this.tabsState || tabId === this.tabsState.activeTabId) return;
    const target = this.tabsState.tabs.find((t) => t.id === tabId);
    if (!target) return;

    this.snapshotActiveTab();
    this.tabsState.activeTabId = tabId;
    saveTabsState(this.tabsState);

    this.applyTabPanelState(target.panelSettings, target.panelOrder, target.bottomSet);
    this.panelTabBar?.refresh();
  }

  private addTab(): void {
    if (!this.tabsState) return;
    this.snapshotActiveTab();

    const defaults = buildDefaultTabPanels(this.ctx.panelSettings);
    // The variant default set can exceed FREE_MAX_PANELS (e.g. 81 panels in the
    // full variant); clamp it to the free-tier cap so a new tab can't bypass
    // the limit that settings/search/boot all enforce.
    const tab: PanelTab = {
      id: generateTabId(),
      name: t('dashboardTabs.newTabName'),
      panelSettings: enforceFreePanelLimit(defaults.panelSettings, isProUser()),
      panelOrder: defaults.panelOrder,
      bottomSet: [],
    };
    this.tabsState.tabs.push(tab);
    this.tabsState.activeTabId = tab.id;
    saveTabsState(this.tabsState);

    this.applyTabPanelState(tab.panelSettings, tab.panelOrder, tab.bottomSet);
    this.panelTabBar?.refresh();
    showToast(t('dashboardTabs.newTabCreated'));
  }

  private renameTab(tabId: string, name: string): void {
    if (!this.tabsState) return;
    const tab = this.tabsState.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.name = name;
    saveTabsState(this.tabsState);
    this.panelTabBar?.refresh();
  }

  private deleteTab(tabId: string): void {
    if (!this.tabsState || this.tabsState.tabs.length <= 1) return;
    const idx = this.tabsState.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const wasActive = this.tabsState.activeTabId === tabId;
    const [removed] = this.tabsState.tabs.splice(idx, 1);

    if (wasActive) {
      const fallback = this.tabsState.tabs[Math.max(0, idx - 1)]!;
      this.tabsState.activeTabId = fallback.id;
      saveTabsState(this.tabsState);
      this.applyTabPanelState(fallback.panelSettings, fallback.panelOrder, fallback.bottomSet);
    } else {
      saveTabsState(this.tabsState);
    }
    this.panelTabBar?.refresh();
    showToast(t('dashboardTabs.tabDeleted', { name: removed!.name }));
  }

  /**
   * Load a tab's panel snapshot into the live global state and re-apply
   * the layout. Mirrors the mission-preset apply pipeline (panels only —
   * map layers, view, and time range stay global across tabs).
   */
  private applyTabPanelState(
    panelSettings: Record<string, PanelConfig>,
    panelOrder: string[],
    bottomSet: string[],
  ): void {
    const isDynamicPanel = (k: string) =>
      !ALL_PANELS[k] && (k === 'runtime-config' || k.startsWith('cw-') || k.startsWith('mcp-'));

    const next: Record<string, PanelConfig> = {};
    for (const [key, config] of Object.entries(panelSettings)) {
      next[key] = { ...config };
    }
    // Carry over panels missing from the snapshot: dynamic panels (custom
    // widgets / MCP / desktop config created after the snapshot) keep their
    // current config so they don't get orphaned visible-but-untracked;
    // panels added to the app since the snapshot seed from variant defaults
    // (same formula as the App.ts settings merge).
    for (const [key, config] of Object.entries(this.ctx.panelSettings)) {
      if (next[key]) continue;
      if (isDynamicPanel(key)) {
        next[key] = { ...config };
      } else {
        const effective = getEffectivePanelConfig(key, SITE_VARIANT);
        next[key] = { ...effective, enabled: isPanelInVariantDefaults(key) && effective.enabled };
      }
    }

    // Final free-tier guarantee: this is the only path that writes a tab's
    // panel selection into STORAGE_KEYS.panels, so clamping here means no tab
    // operation (add / switch / delete-fallback) can ever persist an over-cap
    // workspace, regardless of how the snapshot was produced.
    const capped = enforceFreePanelLimit(next, isProUser());

    this.ctx.panelSettings = capped;
    saveToStorage(STORAGE_KEYS.panels, capped);
    saveToStorage(this.ctx.PANEL_ORDER_KEY, panelOrder);
    saveToStorage(this.ctx.PANEL_ORDER_KEY + '-bottom-set', bottomSet);

    this.applyPanelSettings();
    this.applySavedPanelOrder();
    this.ctx.unifiedSettings?.refreshPanelToggles();
    this.mountLiveNewsIfReady();
    this.scheduleLoadAllData();
  }

  private setupMobilePanelNav(): void {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;
    this.mobilePanelNav = new MobilePanelNav(() => this.ctx.panelSettings);
    grid.before(this.mobilePanelNav.getElement());
    this.mobilePanelNav.refresh();
  }

  private updateMobileMapCollapseBtn(isCollapsed: boolean): void {
    if (!this.mobileMapCollapseBtn) return;
    this.mobileMapCollapseBtn.textContent = isCollapsed
      ? `▶ ${t('components.map.showMap')}`
      : `▼ ${t('components.map.hideMap')}`;
  }

  private setupMobileMapToggle(): void {
    // This is a boot-shell-only marker. The hydrated map owns the persistent
    // collapsed state on #mapSection, so do not leak it into runtime styling.
    document.documentElement.classList.remove('wm-map-collapsed');
    const mapSection = document.getElementById('mapSection');
    const headerLeft = mapSection?.querySelector('.panel-header-left');
    if (!mapSection || !headerLeft) return;

    const collapsed = PanelLayoutManager.isMobileMapCollapsedPreferred();
    if (collapsed) mapSection.classList.add('collapsed');

    const btn = document.createElement('button');
    btn.className = 'map-collapse-btn';
    headerLeft.after(btn);
    this.mobileMapCollapseBtn = btn;
    this.updateMobileMapCollapseBtn(collapsed);

    btn.addEventListener('click', () => {
      const isCollapsed = mapSection.classList.toggle('collapsed');
      this.updateMobileMapCollapseBtn(isCollapsed);
      saveToStorage('mobile-map-collapsed', isCollapsed);
      if (!isCollapsed) window.dispatchEvent(new Event('resize'));
    });
  }

  /** Expand the mobile map (no-op if already expanded) so a banner's
   *  "View Region" fly-to is actually visible, then scroll it into view. */
  private revealMobileMap(): void {
    const mapSection = document.getElementById('mapSection');
    if (!mapSection) return;
    // Map panel disabled in settings — nothing to reveal; scrolling to an
    // empty top would read as the tap doing nothing.
    if (mapSection.classList.contains('hidden')) return;
    if (mapSection.classList.contains('collapsed')) {
      mapSection.classList.remove('collapsed');
      saveToStorage('mobile-map-collapsed', false);
      this.updateMobileMapCollapseBtn(false);
      window.dispatchEvent(new Event('resize'));
    }
    document.querySelector('.main-content')?.scrollTo({ top: 0 });
  }

  renderCriticalBanner(postures: TheaterPostureSummary[]): void {
    const dismissedAt = readSessionStorageValue('banner-dismissed');
    if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < 30 * 60 * 1000) {
      return;
    }

    const critical = postures.filter(
      (p) => p.postureLevel === 'critical' || (p.postureLevel === 'elevated' && p.strikeCapable)
    );

    if (critical.length === 0) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
        document.body.classList.remove('has-critical-banner');
      }
      return;
    }

    const top = critical[0]!;
    const isCritical = top.postureLevel === 'critical';

    if (!this.criticalBannerEl) {
      this.criticalBannerEl = document.createElement('div');
      this.criticalBannerEl.className = 'critical-posture-banner';
      const header = document.querySelector('.header');
      if (header) header.insertAdjacentElement('afterend', this.criticalBannerEl);
    }

    document.body.classList.add('has-critical-banner');
    this.criticalBannerEl.className = `critical-posture-banner ${isCritical ? 'severity-critical' : 'severity-elevated'}`;
    setTrustedHtml(this.criticalBannerEl, trustedHtml(`
      <div class="banner-content">
        <span class="banner-icon">${isCritical ? '🚨' : '⚠️'}</span>
        <span class="banner-headline">${escapeHtml(top.headline)}</span>
        <span class="banner-stats">${top.totalAircraft} aircraft • ${escapeHtml(top.summary)}</span>
        ${top.strikeCapable ? '<span class="banner-strike">STRIKE CAPABLE</span>' : ''}
      </div>
      <button class="banner-view" data-lat="${top.centerLat}" data-lon="${top.centerLon}">View Region</button>
      <button class="banner-dismiss">×</button>
    `, "legacy direct innerHTML migration"));

    this.criticalBannerEl.querySelector('.banner-view')?.addEventListener('click', () => {
      console.log('[Banner] View Region clicked:', top.theaterId, 'lat:', top.centerLat, 'lon:', top.centerLon);
      trackCriticalBannerAction('view', top.theaterId);
      if (typeof top.centerLat === 'number' && typeof top.centerLon === 'number') {
        if (this.ctx.isMobile) this.revealMobileMap();
        this.ctx.map?.setCenter(top.centerLat, top.centerLon, 4);
      } else {
        console.error('[Banner] Missing coordinates for', top.theaterId);
      }
    });

    this.criticalBannerEl.querySelector('.banner-dismiss')?.addEventListener('click', () => {
      trackCriticalBannerAction('dismiss', top.theaterId);
      this.criticalBannerEl?.classList.add('dismissed');
      document.body.classList.remove('has-critical-banner');
      writeSessionStorageValue('banner-dismissed', Date.now().toString());
    });
  }

  applyPanelSettings(): void {
    Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
          const mainContent = document.querySelector('.main-content');
          if (mainContent) {
            mainContent.classList.toggle('map-hidden', !config.enabled);
          }
          this.ensureCorrectZones();
        }
        return;
      }
      const deferred = this.deferredPanelMounts.get(key);
      const placeholderWasHidden = deferred?.placeholder?.classList.contains('hidden') ?? false;
      let mountedFromDeferred = false;
      if (config.enabled && deferred && !deferred.mounted && (!deferred.placeholder || placeholderWasHidden)) {
        mountedFromDeferred = this.mountDeferredPanel(key);
      } else if (deferred?.placeholder) {
        deferred.placeholder.classList.toggle('hidden', !config.enabled);
      }
      const panel = this.ctx.panels[key];
      const liveMediaPanel = panel as { stopLiveMediaForClose?: () => void; resumeLiveMediaForShow?: () => void } | undefined;
      if (!config.enabled) {
        liveMediaPanel?.stopLiveMediaForClose?.();
      }
      if (!mountedFromDeferred) {
        panel?.toggle(config.enabled);
      }
      if (config.enabled) {
        liveMediaPanel?.resumeLiveMediaForShow?.();
      }
    });
    this.mobilePanelNav?.refresh();
  }

  /**
   * Lazily instantiates and mounts LiveNewsPanel when channels become available
   * mid-session (e.g. user adds channels via the standalone manager on a variant
   * whose defaults are empty). No-op if the panel already exists or still has no
   * channels. Called from the liveChannels storage event handler.
   */
  mountLiveNewsIfReady(): void {
    if (this.ctx.panels['live-news']) return;
    const grid = document.getElementById('panelsGrid');
    if (this.lazyPanelRegistrations.has('live-news') && grid) {
      this.mountLazyPanel('live-news', grid);
      return;
    }
    void this.importPanel(
      'live-news',
      () => import('@/components/LiveNewsPanel'),
      'LiveNewsPanel',
      (LiveNewsPanel, module) => {
        const liveNewsModule = module as typeof import('@/components/LiveNewsPanel');
        if (liveNewsModule.getDefaultLiveChannels().length === 0 && liveNewsModule.loadChannelsFromStorage().length === 0) return null;
        return new LiveNewsPanel();
      },
    ).then((panel) => {
      if (this.ctx.isDestroyed) return;
      if (this.ctx.panels['live-news'] || !panel) return;
      this.ctx.panels['live-news'] = panel;
      const el = panel.getElement();
      this.makeDraggable(el, 'live-news');
      if (grid) {
        const addBlock = grid.querySelector('.add-panel-block');
        if (addBlock) grid.insertBefore(el, addBlock);
        else grid.appendChild(el);
      }
      this.applyPanelSettings();
      this.afterPanelMounted('live-news', panel);
    }).catch((err) => {
      console.error('[panel] failed to lazy-load "live-news"', err);
    });
  }

  private shouldCreatePanel(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.ctx.panelSettings, key);
  }

  private static readonly NEWS_PANEL_TOOLTIPS: Record<string, string> = {
    centralbanks: t('components.centralBankWatch.infoTooltip'),
  };

  private createNewsPanel(key: string, labelKey: string): void {
    this.createNewsPanelWithLabel(key, t(labelKey), PanelLayoutManager.NEWS_PANEL_TOOLTIPS[key], key);
  }

  private createNewsPanelWithLabel(
    panelKey: string,
    label: string,
    tooltip?: string,
    categoryKey = panelKey,
  ): void {
    if (!this.shouldCreatePanel(panelKey)) return;
    this.lazyImportedPanel(panelKey, () => import('@/components/NewsPanel'), 'NewsPanel', (NewsPanel) => {
      const panel = new NewsPanel(panelKey, label, tooltip);
      this.attachRelatedAssetHandlers(panel);
      panel.setRiskScoreGetter(PanelLayoutManager.computeEventRisk);
      this.ctx.newsPanels[categoryKey] = panel;
      const existingItems = this.ctx.newsByCategory[categoryKey];
      if (existingItems?.length) {
        const filteredItems = this.filterItemsByTimeRange(existingItems);
        if (filteredItems.length === 0) {
          panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
        } else {
          panel.renderNews(filteredItems);
        }
      }
      return panel;
    });
  }

  // 0-100 event risk score: 0.40×severity + 0.30×geoConvergence + 0.30×CII
  // CII component omitted until lat/lon→country lookup is added; weights rebalanced to 0.57+0.43
  private static computeEventRisk(cluster: ClusteredEvent): number | null {
    if (!cluster.threat) return null;
    const levelScore: Record<string, number> = { critical: 95, high: 75, medium: 50, low: 25, info: 10 };
    const severity = (levelScore[cluster.threat.level] ?? 10) * (cluster.threat.confidence ?? 1);

    const geoAlert = (cluster.lat != null && cluster.lon != null)
      ? getAlertsNearLocation(cluster.lat, cluster.lon, 500)
      : null;
    const geoScore = geoAlert?.score ?? 0;

    // Rebalanced (CII pending): 0.57×severity + 0.43×geoConvergence
    return Math.round(0.57 * severity + 0.43 * geoScore);
  }

  private shouldMountPanelImmediately(key: string): boolean {
    const config = this.ctx.panelSettings[key];
    if (!config?.enabled) return false;
    if (shouldDeferInitialPanelMount({
      enabled: config.enabled,
      mountedEnabledCount: this.initiallyMountedEnabledPanelCount,
      isMobile: this.ctx.isMobile,
    })) {
      return false;
    }
    this.initiallyMountedEnabledPanelCount += 1;
    return true;
  }

  private insertInitialPanel(grid: HTMLElement, key: string, panel: Panel): void {
    if (this.shouldMountPanelImmediately(key)) {
      if (this.mountPanelElement(grid, key, panel)) {
        this.afterPanelMounted(key, panel);
      }
      return;
    }

    this.deferPanelMount(key, panel, grid, this.ctx.panelSettings[key]?.enabled === true);
  }

  private insertInitialPanelByKey(grid: HTMLElement, key: string): void {
    const panel = this.ctx.panels[key];
    if (panel && !panel.getElement().parentElement) {
      this.insertInitialPanel(grid, key, panel);
      return;
    }
    if (panel || !this.lazyPanelRegistrations.has(key)) return;
    if (this.shouldMountPanelImmediately(key)) {
      this.mountLazyPanel(key, grid);
      return;
    }
    this.deferPanelMount(key, null, grid, this.ctx.panelSettings[key]?.enabled === true);
  }

  private mountPanelElement(grid: HTMLElement, key: string, panel: Panel, placeholder?: HTMLElement | null): boolean {
    const el = panel.getElement();
    if (el.parentElement) return false;
    this.makeDraggable(el, key);
    if (placeholder?.parentNode) {
      if (import.meta.env.DEV) warnOnDeferredFootprintDrift(key, placeholder, el);
      placeholder.parentNode.replaceChild(el, placeholder);
    } else {
      this.insertByOrder(grid, el, key);
    }
    this.mobilePanelNav?.applyToNewPanel(el);
    panel.notifyConnected();
    return true;
  }

  private getDeferredPanelShellFootprint(key: string): DeferredPanelShellFootprint {
    return resolveDeferredPanelShellFootprint({
      panelId: key,
      naturalFootprints: DEFERRED_PANEL_NATURAL_FOOTPRINTS,
      dynamicFootprints: DEFERRED_DYNAMIC_PANEL_FOOTPRINTS,
      savedRowSpans: loadPanelSpans(),
      savedColSpans: loadPanelColSpans(),
      savedCollapsed: loadPanelCollapsed(),
    });
  }

  private deferPanelMount(key: string, panel: Panel | null, grid: HTMLElement | null, withShell: boolean): void {
    const placeholder = withShell && grid
      ? createDeferredPanelShell(key, this.ctx.panelSettings[key]?.name ?? key, this.getDeferredPanelShellFootprint(key))
      : null;
    if (placeholder && grid) {
      this.insertByOrder(grid, placeholder, key);
      reconcileDeferredPanelShellColSpan(placeholder);
      this.mobilePanelNav?.applyToNewPanel(placeholder);
    }
    const existing = this.deferredPanelMounts.get(key);
    existing?.observer?.disconnect();
    if (existing?.retryTimer !== null && existing?.retryTimer !== undefined) {
      clearTimeout(existing.retryTimer);
    }
    if (existing?.placeholder && existing.placeholder !== placeholder) {
      existing.placeholder.remove();
    }
    const deferred: DeferredPanelMount = {
      panel,
      placeholder,
      observer: null,
      mounted: false,
      loading: null,
      retryTimer: null,
      retryAttempts: 0,
      failed: false,
    };
    this.deferredPanelMounts.set(key, deferred);
    if (placeholder) {
      this.observeDeferredPanelShell(key, deferred);
    }
  }

  private observeDeferredPanelShell(key: string, deferred: DeferredPanelMount): void {
    const { placeholder } = deferred;
    if (!placeholder) return;
    if (deferred.retryTimer !== null) {
      clearTimeout(deferred.retryTimer);
      deferred.retryTimer = null;
    }
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      const ric = typeof window !== 'undefined'
        ? (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
        : undefined;
      if (typeof ric === 'function') ric(() => this.mountDeferredPanel(key));
      else setTimeout(() => this.mountDeferredPanel(key), 0);
      return;
    }

    const rootMargin = this.ctx.isMobile ? '700px 0px' : '900px 0px';
    deferred.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.mountDeferredPanel(key);
      }
    }, { rootMargin });
    deferred.observer.observe(placeholder);
  }

  private getPanelMountGrid(key: string): HTMLElement | null {
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (bottomGrid && this.getEffectiveUltraWide() && this.bottomSetMemory.has(key)) {
      return bottomGrid;
    }
    return document.getElementById('panelsGrid');
  }

  private scheduleDeferredPanelRetry(key: string, deferred: DeferredPanelMount): void {
    if (this.ctx.isDestroyed || deferred.mounted || deferred.failed || deferred.retryTimer !== null) return;
    if (!deferred.placeholder?.parentNode) return;
    if (!deferred.panel && !this.lazyPanelRegistrations.has(key)) return;
    if (deferred.retryAttempts >= DEFERRED_PANEL_MAX_RETRY_ATTEMPTS) {
      // Give up after a bounded number of attempts so a permanently failing
      // dynamic import (offline, stale chunk) cannot spin a 1s retry loop forever.
      // The shell stays in place as a quiet fallback, matching the prior fail-safe.
      deferred.failed = true;
      return;
    }
    deferred.retryAttempts += 1;
    deferred.retryTimer = setTimeout(() => {
      deferred.retryTimer = null;
      if (this.deferredPanelMounts.get(key) !== deferred || deferred.mounted || this.ctx.isDestroyed) return;
      this.observeDeferredPanelShell(key, deferred);
    }, DEFERRED_PANEL_RETRY_DELAY_MS);
  }

  private mountDeferredPanel(key: string): boolean {
    const deferred = this.deferredPanelMounts.get(key);
    if (!deferred || deferred.mounted || deferred.loading || deferred.failed) return false;
    const grid = this.getPanelMountGrid(key);
    if (!grid && !deferred.placeholder?.parentNode) return false;

    markLcpDebug('wm:panel:deferred-mount-start', { panel: key });

    deferred.observer?.disconnect();
    deferred.observer = null;
    if (deferred.retryTimer !== null) {
      clearTimeout(deferred.retryTimer);
      deferred.retryTimer = null;
    }
    const targetGrid = grid ?? (deferred.placeholder!.parentNode as HTMLElement);
    const finish = (panel: Panel | null): void => {
      const current = this.deferredPanelMounts.get(key);
      if (current !== deferred || deferred.mounted) return;
      deferred.loading = null;
      if (!panel || this.ctx.isDestroyed) {
        markLcpDebug('wm:panel:deferred-mount-unavailable', { panel: key });
        this.scheduleDeferredPanelRetry(key, deferred);
        return;
      }
      const placeholder = deferred.placeholder;
      const mounted = this.mountPanelElement(targetGrid, key, panel, placeholder);
      if (mounted) {
        this.afterPanelMounted(key, panel);
      }
      deferred.mounted = true;
      deferred.placeholder = null;
      this.deferredPanelMounts.delete(key);
      markLcpDebug('wm:panel:deferred-mount-ready', { mounted, panel: key });
    };

    if (deferred.panel) {
      finish(deferred.panel);
      return true;
    }
    deferred.loading = this.loadRegisteredPanel(key).then(finish, () => finish(null));
    return true;
  }

  private mountLazyPanel(key: string, grid: HTMLElement, placeholder?: HTMLElement | null): void {
    void this.loadRegisteredPanel(key).then((panel) => {
      if (!panel || this.ctx.isDestroyed) return;
      const targetGrid = placeholder?.parentNode ? (placeholder.parentNode as HTMLElement) : grid;
      if (this.mountPanelElement(targetGrid, key, panel, placeholder)) {
        this.afterPanelMounted(key, panel);
      }
    });
  }

  private scheduleHydrationForPanelElement(element: HTMLElement, fallbackPhase: HydrationSchedulePhase = 'near'): void {
    if (typeof window === 'undefined') {
      this.scheduleLoadAllData(fallbackPhase);
      return;
    }

    measure(() => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const phase: HydrationSchedulePhase = rect.top < viewportHeight && rect.bottom > 0 ? 'visible' : 'near';
      mutate(() => {
        if (this.ctx.isDestroyed) return;
        this.scheduleLoadAllData(phase);
      });
    });
  }

  private observePanelForHydration(panel: Panel): void {
    if (this.observedHydrationPanels.has(panel)) return;
    this.observedHydrationPanels.add(panel);
    panel.observeNearViewport(() => {
      this.scheduleHydrationForPanelElement(panel.getElement(), 'near');
    }, 200);
  }

  private afterPanelMounted(key: string, panel: Panel): void {
    const config = this.ctx.panelSettings[key];
    if (config) panel.toggle(config.enabled);
    this.observePanelForHydration(panel);
    if (config?.enabled) {
      this.scheduleHydrationForPanelElement(panel.getElement(), 'near');
    }
  }

  private getPanelElementForOrdering(key: string): HTMLElement | null {
    const deferred = this.deferredPanelMounts.get(key);
    if (deferred && !deferred.mounted) {
      if (deferred.placeholder) return deferred.placeholder;
      if (!this.ctx.panelSettings[key]?.enabled) return null;
      this.mountDeferredPanel(key);
    }
    return this.ctx.panels[key]?.getElement() ?? null;
  }

  private async createPanels(): Promise<void> {
    const panelsGrid = document.getElementById('panelsGrid')!;
    this.initiallyMountedEnabledPanelCount = 0;

    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    const preferGlobe = getStoredMapModePreference() === 'globe';
    // Dynamic import: keeps maplibre-gl + @deck.gl/* + @loaders.gl + @luma.gl out of
    // the entry chunk.
    //
    // U3 (#4459): kick off the map chunk fetch HERE but await it only after the ~730
    // lines of panel registration below, so registration runs concurrently with the
    // fetch instead of serialized behind it. This is the restructure the prior canary
    // comment called for: panel setup is map-tolerant: callback uses are `?.`-guarded,
    // and the one eager bridge (SupplyChainPanel -> MapContainer) is replayed below.
    // ctx.currentTimeRange already defaults to '7d' (App.ts:899). The map's direct
    // uses — construction, the supply-chain bridge replay, the resilienceScore tweak,
    // initEscalationGetters/getTimeRange and onTimeRangeChanged — are grouped together
    // after the registration block (just before the onTimeRangeChanged wiring).
    // Failed-fetch reload guard: src/main.ts:285-290 (installChunkReloadGuard).
    const mapModulePromise = import('@/components/MapContainer');

    this.createNewsPanel('politics', 'panels.politics');
    this.createNewsPanel('tech', 'panels.tech');
    this.createNewsPanel('finance', 'panels.finance');

    this.lazyDefaultPanel('heatmap', () => import('@/components/MarketPanel'), 'HeatmapPanel');
    this.lazyDefaultPanel('markets', () => import('@/components/MarketPanel'), 'MarketPanel');
    this.lazyDefaultPanel('stock-analysis', () => import('@/components/StockAnalysisPanel'), 'StockAnalysisPanel');
    this.lazyDefaultPanel('stock-backtest', () => import('@/components/StockBacktestPanel'), 'StockBacktestPanel');
    // Web premium gating for stock-analysis and stock-backtest is handled
    // reactively by updatePanelGating() via auth state subscription.

    this.lazyImportedPanel('monitors', () => import('@/components/MonitorPanel'), 'MonitorPanel', (MonitorPanel) => {
      const monitorPanel = new MonitorPanel(this.ctx.monitors);
      monitorPanel.onChanged((monitors) => {
        this.ctx.monitors = monitors;
        saveToStorage(STORAGE_KEYS.monitors, monitors);
        this.callbacks.updateMonitorResults();
      });
      return monitorPanel;
    });

    // Latest Brief — reads /api/latest-brief and opens the hosted
    // magazine on click. Self-fetching (no data-loader integration);
    // PRO gating handled by the base Panel class via premium: 'locked'.
    this.lazyDefaultPanel('latest-brief', () => import('@/components/LatestBriefPanel'), 'LatestBriefPanel');

    this.lazyDefaultPanel('commodities', () => import('@/components/MarketPanel'), 'CommoditiesPanel');
    this.lazyDefaultPanel('energy-complex', () => import('@/components/EnergyComplexPanel'), 'EnergyComplexPanel');
    this.lazyDefaultPanel('oil-inventories', () => import('@/components/OilInventoriesPanel'), 'OilInventoriesPanel');
    this.lazyDefaultPanel('energy-crisis', () => import('@/components/EnergyCrisisPanel'), 'EnergyCrisisPanel');
    this.lazyDefaultPanel('chokepoint-strip', () => import('@/components/ChokepointStripPanel'), 'ChokepointStripPanel');
    this.lazyPanel('pipeline-status', () =>
      this.importPanel('pipeline-status', () => import('@/components/PipelineStatusPanel'), 'PipelineStatusPanel', (PipelineStatusPanel) => new PipelineStatusPanel()),
    );
    this.lazyPanel('storage-facility-map', () =>
      this.importPanel('storage-facility-map', () => import('@/components/StorageFacilityMapPanel'), 'StorageFacilityMapPanel', (StorageFacilityMapPanel) => new StorageFacilityMapPanel()),
    );
    this.lazyPanel('fuel-shortages', () =>
      this.importPanel('fuel-shortages', () => import('@/components/FuelShortagePanel'), 'FuelShortagePanel', (FuelShortagePanel) => new FuelShortagePanel()),
    );
    this.lazyPanel('energy-disruptions', () =>
      this.importPanel('energy-disruptions', () => import('@/components/EnergyDisruptionsPanel'), 'EnergyDisruptionsPanel', (EnergyDisruptionsPanel) => new EnergyDisruptionsPanel()),
    );
    this.lazyPanel('energy-risk-overview', () =>
      this.importPanel('energy-risk-overview', () => import('@/components/EnergyRiskOverviewPanel'), 'EnergyRiskOverviewPanel', (EnergyRiskOverviewPanel) => new EnergyRiskOverviewPanel()),
    );
    this.lazyDefaultPanel('polymarket', () => import('@/components/PredictionPanel'), 'PredictionPanel');

    this.createNewsPanel('gov', 'panels.gov');
    this.createNewsPanel('intel', 'panels.intel');

    this.lazyDefaultPanel('crypto', () => import('@/components/MarketPanel'), 'CryptoPanel');
    this.lazyDefaultPanel('crypto-heatmap', () => import('@/components/MarketPanel'), 'CryptoHeatmapPanel');
    this.lazyDefaultPanel('defi-tokens', () => import('@/components/MarketPanel'), 'DefiTokensPanel');
    this.lazyDefaultPanel('ai-tokens', () => import('@/components/MarketPanel'), 'AiTokensPanel');
    this.lazyDefaultPanel('other-tokens', () => import('@/components/MarketPanel'), 'OtherTokensPanel');
    this.createNewsPanel('middleeast', 'panels.middleeast');
    this.createNewsPanel('layoffs', 'panels.layoffs');
    this.createNewsPanel('ai', 'panels.ai');
    this.createNewsPanel('startups', 'panels.startups');
    this.createNewsPanel('vcblogs', 'panels.vcblogs');
    this.createNewsPanel('regionalStartups', 'panels.regionalStartups');
    this.createNewsPanel('unicorns', 'panels.unicorns');
    this.createNewsPanel('accelerators', 'panels.accelerators');
    this.createNewsPanel('funding', 'panels.funding');
    this.createNewsPanel('producthunt', 'panels.producthunt');
    this.createNewsPanel('security', 'panels.security');
    this.createNewsPanel('policy', 'panels.policy');
    this.createNewsPanel('hardware', 'panels.hardware');
    this.createNewsPanel('cloud', 'panels.cloud');
    this.createNewsPanel('dev', 'panels.dev');
    this.createNewsPanel('github', 'panels.github');
    this.createNewsPanel('ipo', 'panels.ipo');
    this.createNewsPanel('thinktanks', 'panels.thinktanks');
    this.lazyDefaultPanel('economic', () => import('@/components/EconomicPanel'), 'EconomicPanel');
    this.lazyDefaultPanel('consumer-prices', () => import('@/components/ConsumerPricesPanel'), 'ConsumerPricesPanel');

    this.lazyDefaultPanel('trade-policy', () => import('@/components/TradePolicyPanel'), 'TradePolicyPanel');
    this.lazyDefaultPanel('sanctions-pressure', () => import('@/components/SanctionsPressurePanel'), 'SanctionsPressurePanel');
    this.lazyImportedPanel('supply-chain', () => import('@/components/SupplyChainPanel'), 'SupplyChainPanel', (SupplyChainPanel) => {
      const supplyChainPanel = new SupplyChainPanel();
      supplyChainPanel.setOnScenarioActivate((id, result) => {
        this.ctx.map?.activateScenario(id, result);
      });
      supplyChainPanel.setOnDismissScenario(() => {
        this.ctx.map?.deactivateScenario();
      });
      this.ctx.map?.setSupplyChainPanel(supplyChainPanel);
      return supplyChainPanel;
    });

    this.createNewsPanel('africa', 'panels.africa');
    this.createNewsPanel('latam', 'panels.latam');
    this.createNewsPanel('asia', 'panels.asia');
    this.createNewsPanel('energy', 'panels.energy');

    // Iterate CANONICAL_FEEDS (union of all variants), not just the active
    // variant's FEEDS preset — so a news panel the user customized in from
    // another variant (e.g. Finance `forex` added to a `full` session) still
    // gets a NewsPanel created. The panelSettings gate below ensures only
    // panels the user actually enabled are instantiated.
    for (const key of Object.keys(CANONICAL_FEEDS)) {
      if (this.ctx.newsPanels[key]) continue;
      if (!Array.isArray((CANONICAL_FEEDS as Record<string, unknown>)[key])) continue;
      // 'live-news' is the dedicated LiveNewsPanel (24/7 video) key, registered
      // lazily below — NOT a generic RSS feed panel. CANONICAL_FEEDS['live-news']
      // exists only to feed the energy variant's headlines; if we let it spawn a
      // NewsPanel here it registers first and lazyPanel()'s dedup guard then
      // blocks the real video panel (regression #4382 → "LIVE NEWS / No items in
      // the last 7 days" on the live dashboard). Skip it so the video panel owns
      // the key on every variant (happy has no 'live-news' panel at all).
      if (key === 'live-news') continue;
      const panelKey = COLLIDING_NEWS_PANEL_KEYS.has(key) && !this.ctx.newsPanels[key] ? `${key}-news` : key;
      if (this.ctx.panels[panelKey]) continue;
      // Gate on panelKey, NOT key. When `key` collided with a non-news data
      // panel (panelKey became `${key}-news` — e.g. `markets`/`crypto`/`economic`
      // in the full variant), that data panel's own settings entry must NOT
      // spawn a phantom news panel: the remapped key has to be explicitly
      // enabled. When there's no collision, panelKey === key so this is unchanged.
      const panelConfig = this.ctx.panelSettings[panelKey];
      if (!panelConfig) continue;
      const label = panelConfig.name ?? key.charAt(0).toUpperCase() + key.slice(1);
      const tooltip = PanelLayoutManager.NEWS_PANEL_TOOLTIPS[panelKey] ?? PanelLayoutManager.NEWS_PANEL_TOOLTIPS[key];
      this.createNewsPanelWithLabel(panelKey, label, tooltip, key);
    }

    this.lazyDefaultPanel('gdelt-intel', () => import('@/components/GdeltIntelPanel'), 'GdeltIntelPanel');

    this.lazyPanel('deduction', () =>
      this.importPanel(
        'deduction',
        () => import('@/components/DeductionPanel'),
        'DeductionPanel',
        (DeductionPanel) => new DeductionPanel(() => this.ctx.allNews),
      ),
    );
    this.lazyPanel('regional-intelligence', () =>
      this.importPanel(
        'regional-intelligence',
        () => import('@/components/RegionalIntelligenceBoard'),
        'RegionalIntelligenceBoard',
        (RegionalIntelligenceBoard) => new RegionalIntelligenceBoard(),
      ),
    );

    this.lazyImportedPanel('cii', () => import('@/components/CIIPanel'), 'CIIPanel', (CIIPanel) => {
      const ciiPanel = new CIIPanel();
      ciiPanel.setShareStoryHandler((code, name) => {
        this.callbacks.openCountryStory(code, name);
      });
      ciiPanel.setCountryClickHandler((code) => {
        this.callbacks.openCountryBrief(code);
      });
      return ciiPanel;
    });

    this.lazyDefaultPanel('cascade', () => import('@/components/CascadePanel'), 'CascadePanel');
    this.lazyDefaultPanel('satellite-fires', () => import('@/components/SatelliteFiresPanel'), 'SatelliteFiresPanel');

    this.lazyDefaultPanel('defense-patents', () => import('@/components/DefensePatentsPanel'), 'DefensePatentsPanel');

    // Correlation engine panels
    this.lazyImportedPanel('military-correlation', () => import('@/components/MilitaryCorrelationPanel'), 'MilitaryCorrelationPanel', (MilitaryCorrelationPanel) => {
      const p = new MilitaryCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 6); });
      return p;
    });
    this.lazyImportedPanel('escalation-correlation', () => import('@/components/EscalationCorrelationPanel'), 'EscalationCorrelationPanel', (EscalationCorrelationPanel) => {
      const p = new EscalationCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 4); });
      return p;
    });
    this.lazyImportedPanel('economic-correlation', () => import('@/components/EconomicCorrelationPanel'), 'EconomicCorrelationPanel', (EconomicCorrelationPanel) => {
      const p = new EconomicCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 4); });
      return p;
    });
    this.lazyImportedPanel('disaster-correlation', () => import('@/components/DisasterCorrelationPanel'), 'DisasterCorrelationPanel', (DisasterCorrelationPanel) => {
      const p = new DisasterCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 5); });
      return p;
    });

    this.lazyImportedPanel('strategic-risk', () => import('@/components/StrategicRiskPanel'), 'StrategicRiskPanel', (StrategicRiskPanel) => {
      const strategicRiskPanel = new StrategicRiskPanel();
      strategicRiskPanel.setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      return strategicRiskPanel;
    });

    this.lazyImportedPanel('strategic-posture', () => import('@/components/StrategicPosturePanel'), 'StrategicPosturePanel', (StrategicPosturePanel) => {
      const strategicPosturePanel = new StrategicPosturePanel(() => this.ctx.allNews);
      strategicPosturePanel.setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      return strategicPosturePanel;
    });

    this.lazyImportedPanel('ucdp-events', () => import('@/components/UcdpEventsPanel'), 'UcdpEventsPanel', (UcdpEventsPanel) => {
      const ucdpEventsPanel = new UcdpEventsPanel();
      ucdpEventsPanel.setEventClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 5);
      });
      return ucdpEventsPanel;
    });

    this.lazyDefaultPanel('disease-outbreaks', () => import('@/components/DiseaseOutbreaksPanel'), 'DiseaseOutbreaksPanel');
    this.lazyDefaultPanel('social-velocity', () => import('@/components/SocialVelocityPanel'), 'SocialVelocityPanel');
    this.lazyDefaultPanel('wsb-ticker-scanner', () => import('@/components/WsbTickerScannerPanel'), 'WsbTickerScannerPanel');

    this.lazyImportedPanel('displacement', () => import('@/components/DisplacementPanel'), 'DisplacementPanel', (DisplacementPanel) => {
      const p = new DisplacementPanel();
      p.setCountryClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
      return p;
    });

    this.lazyImportedPanel('climate', () => import('@/components/ClimateAnomalyPanel'), 'ClimateAnomalyPanel', (ClimateAnomalyPanel) => {
      const p = new ClimateAnomalyPanel();
      p.setZoneClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
      return p;
    });

    this.lazyDefaultPanel('population-exposure', () => import('@/components/PopulationExposurePanel'), 'PopulationExposurePanel');

    this.lazyImportedPanel('security-advisories', () => import('@/components/SecurityAdvisoriesPanel'), 'SecurityAdvisoriesPanel', (SecurityAdvisoriesPanel) => {
      const p = new SecurityAdvisoriesPanel();
      p.setRefreshHandler(() => { void this.callbacks.loadSecurityAdvisories?.(); });
      return p;
    });

    this.lazyImportedPanel('radiation-watch', () => import('@/components/RadiationWatchPanel'), 'RadiationWatchPanel', (RadiationWatchPanel) => {
      const p = new RadiationWatchPanel();
      p.setLocationClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
      return p;
    });

    this.lazyImportedPanel('thermal-escalation', () => import('@/components/ThermalEscalationPanel'), 'ThermalEscalationPanel', (ThermalEscalationPanel) => {
      const p = new ThermalEscalationPanel();
      p.setLocationClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
      return p;
    });

    const _lockPanels = this.ctx.isDesktopApp && !hasPremiumAccess();

    this.lazyDefaultPanel('daily-market-brief', () => import('@/components/DailyMarketBriefPanel'), 'DailyMarketBriefPanel');

    this.lazyDefaultPanel('market-implications', () => import('@/components/MarketImplicationsPanel'), 'MarketImplicationsPanel');
    // Gating for daily-market-brief, market-implications, and chat-analyst is handled
    // reactively by updatePanelGating() via auth state subscription (all in WEB_PREMIUM_PANELS).

    this.lazyImportedPanel('chat-analyst', () => import('@/components/ChatAnalystPanel'), 'ChatAnalystPanel', (ChatAnalystPanel) => {
      // agent-bus-applier (and its zod-backed shared/agent-bus-actions schemas, ~69KB)
      // is only reachable through this lazy panel's action handler. Start loading it
      // here so it stays off the eager main entry, but do not make plain chat depend
      // on the optional dashboard-control chunk being available.
      const panel = new ChatAnalystPanel();
      void import('@/app/agent-bus-applier')
        .then(({ applyAgentBusAction }) => {
          panel.setDashboardActionHandler((action) => applyAgentBusAction(this.ctx, action, {
            getPanelConfig: (panelId) => getEffectivePanelConfig(panelId, SITE_VARIANT),
            isPanelAllowed: (panelId, config) => isPanelEntitled(panelId, config, hasPremiumAccess(getAuthState())),
            hasPremiumAccess: () => hasPremiumAccess(getAuthState()),
            applyLayerChange: this.callbacks.applyMapLayerChange,
          }));
        })
        .catch((err) => {
          console.error('[panel] failed to lazy-load "chat-analyst" dashboard action handler', err);
        });
      return panel;
    });

    this.lazyDefaultPanel(
      'forecast',
      () => import('@/components/ForecastPanel'),
      'ForecastPanel',
      undefined,
      _lockPanels ? ['AI-powered geopolitical forecasts', 'Cross-domain cascade predictions', 'Prediction market calibration'] : undefined,
    );

    this.lazyDefaultPanel(
      'oref-sirens',
      () => import('@/components/OrefSirensPanel'),
      'OrefSirensPanel',
      undefined,
      _lockPanels ? [t('premium.features.orefSirens1'), t('premium.features.orefSirens2')] : undefined,
    );

    this.lazyDefaultPanel(
      'telegram-intel',
      () => import('@/components/TelegramIntelPanel'),
      'TelegramIntelPanel',
      undefined,
      _lockPanels ? [t('premium.features.telegramIntel1'), t('premium.features.telegramIntel2')] : undefined,
    );

    this.lazyPanel('gcc-investments', async () => {
      const { focusInvestmentOnMap } = await import('@/services/investments-focus');
      return this.importPanel('gcc-investments', () => import('@/components/InvestmentsPanel'), 'InvestmentsPanel', (InvestmentsPanel) =>
        new InvestmentsPanel((inv) => {
          focusInvestmentOnMap(this.ctx.map, this.ctx.mapLayers, inv.lat, inv.lon);
        }),
      );
    });

    this.lazyDefaultPanel('world-clock', () => import('@/components/WorldClockPanel'), 'WorldClockPanel');

    this.lazyImportedPanel('airline-intel', () => import('@/components/AirlineIntelPanel'), 'AirlineIntelPanel', (AirlineIntelPanel) => {
      const panel = new AirlineIntelPanel();
      void import('@/components/AviationCommandBar')
        .then(({ AviationCommandBar }) => {
          if (!this.ctx.isDestroyed) this.aviationCommandBar = new AviationCommandBar();
        })
        .catch((err) => {
          console.error('[panel] failed to lazy-load "airline-intel" command bar', err);
        });
      return panel;
    });

    this.lazyPanel('gulf-economies', () =>
      this.importPanel('gulf-economies', () => import('@/components/GulfEconomiesPanel'), 'GulfEconomiesPanel', (GulfEconomiesPanel) => new GulfEconomiesPanel()),
    );
    this.lazyPanel('grocery-basket', () =>
      this.importPanel('grocery-basket', () => import('@/components/GroceryBasketPanel'), 'GroceryBasketPanel', (GroceryBasketPanel) => new GroceryBasketPanel()),
    );
    this.lazyPanel('bigmac', () =>
      this.importPanel('bigmac', () => import('@/components/BigMacPanel'), 'BigMacPanel', (BigMacPanel) => new BigMacPanel()),
    );
    this.lazyPanel('fuel-prices', () =>
      this.importPanel('fuel-prices', () => import('@/components/FuelPricesPanel'), 'FuelPricesPanel', (FuelPricesPanel) => new FuelPricesPanel()),
    );
    this.lazyPanel('fao-food-price-index', () =>
      this.importPanel('fao-food-price-index', () => import('@/components/FaoFoodPriceIndexPanel'), 'FaoFoodPriceIndexPanel', (FaoFoodPriceIndexPanel) => new FaoFoodPriceIndexPanel()),
    );
    this.lazyPanel('climate-news', () =>
      this.importPanel('climate-news', () => import('@/components/ClimateNewsPanel'), 'ClimateNewsPanel', (ClimateNewsPanel) => new ClimateNewsPanel()),
    );

    this.lazyImportedPanel('live-news', () => import('@/components/LiveNewsPanel'), 'LiveNewsPanel', (LiveNewsPanel, module) => {
      const liveNewsModule = module as typeof import('@/components/LiveNewsPanel');
      if (liveNewsModule.getDefaultLiveChannels().length === 0 && liveNewsModule.loadChannelsFromStorage().length === 0) return null;
      return new LiveNewsPanel();
    });

    this.lazyDefaultPanel('live-webcams', () => import('@/components/LiveWebcamsPanel'), 'LiveWebcamsPanel');
    this.lazyDefaultPanel('windy-webcams', () => import('@/components/PinnedWebcamsPanel'), 'PinnedWebcamsPanel');

    this.lazyPanel('events', () =>
      this.importPanel(
        'events',
        () => import('@/components/TechEventsPanel'),
        'TechEventsPanel',
        (TechEventsPanel) => new TechEventsPanel('events', () => this.ctx.allNews),
      ),
    );
    this.lazyDefaultPanel('internet-disruptions', () => import('@/components/InternetDisruptionsPanel'), 'InternetDisruptionsPanel');
    this.lazyDefaultPanel('service-status', () => import('@/components/ServiceStatusPanel'), 'ServiceStatusPanel');

    this.lazyImportedPanel('tech-readiness', () => import('@/components/TechReadinessPanel'), 'TechReadinessPanel', (TechReadinessPanel) => {
      const p = new TechReadinessPanel();
      // Only auto-refresh on variants whose bootstrap seeds techReadiness
      // (full + tech). On commodity/finance/energy the seed key is empty
      // and the 5s fetch at services/economic/index.ts:694 just times out.
      // The panel is still created so users who opt-in via settings can
      // trigger a manual refresh from its UI.
      if (isPanelInVariantDefaults('tech-readiness')) {
        void p.refresh();
      }
      return p;
    });

    this.lazyImportedPanel('national-debt', () => import('@/components/NationalDebtPanel'), 'NationalDebtPanel', (NationalDebtPanel) => {
      const p = new NationalDebtPanel();
      void p.refresh();
      return p;
    });

    this.lazyDefaultPanel('cross-source-signals', () => import('@/components/CrossSourceSignalsPanel'), 'CrossSourceSignalsPanel');

    this.lazyImportedPanel('geo-hubs', () => import('@/components/GeoHubsPanel'), 'GeoHubsPanel', (GeoHubsPanel) => {
      const p = new GeoHubsPanel();
      p.setOnHubClick((hub) => { this.ctx.map?.setCenter(hub.lat, hub.lon, 4); });
      return p;
    });

    this.lazyImportedPanel('tech-hubs', () => import('@/components/TechHubsPanel'), 'TechHubsPanel', (TechHubsPanel) => {
      const p = new TechHubsPanel();
      p.setOnHubClick((hub) => { this.ctx.map?.setCenter(hub.lat, hub.lon, 4); });
      return p;
    });

    this.lazyImportedPanel('ai-regulation', () => import('@/components/RegulationPanel'), 'RegulationPanel', (RegulationPanel) => new RegulationPanel('ai-regulation'));

    this.lazyPanel('macro-signals', () =>
      this.importPanel('macro-signals', () => import('@/components/MacroSignalsPanel'), 'MacroSignalsPanel', (MacroSignalsPanel) => new MacroSignalsPanel()),
    );
    this.lazyDefaultPanel('fear-greed', () => import('@/components/FearGreedPanel'), 'FearGreedPanel');
    this.lazyDefaultPanel('aaii-sentiment', () => import('@/components/AAIISentimentPanel'), 'AAIISentimentPanel');
    this.lazyDefaultPanel('market-breadth', () => import('@/components/MarketBreadthPanel'), 'MarketBreadthPanel');
    this.lazyDefaultPanel('macro-tiles', () => import('@/components/MacroTilesPanel'), 'MacroTilesPanel');
    this.lazyDefaultPanel('fsi', () => import('@/components/FSIPanel'), 'FSIPanel');
    this.lazyDefaultPanel('yield-curve', () => import('@/components/YieldCurvePanel'), 'YieldCurvePanel');
    this.lazyDefaultPanel('earnings-calendar', () => import('@/components/EarningsCalendarPanel'), 'EarningsCalendarPanel');
    this.lazyDefaultPanel('economic-calendar', () => import('@/components/EconomicCalendarPanel'), 'EconomicCalendarPanel');
    this.lazyDefaultPanel('cot-positioning', () => import('@/components/CotPositioningPanel'), 'CotPositioningPanel');
    this.lazyDefaultPanel('liquidity-shifts', () => import('@/components/LiquidityShiftsPanel'), 'LiquidityShiftsPanel');
    this.lazyDefaultPanel('positioning-247', () => import('@/components/PositioningPanel'), 'PositioningPanel');
    this.lazyDefaultPanel('gold-intelligence', () => import('@/components/GoldIntelligencePanel'), 'GoldIntelligencePanel');
    this.lazyDefaultPanel('hormuz-tracker', () => import('@/components/HormuzPanel'), 'HormuzPanel');
    this.lazyDefaultPanel('etf-flows', () => import('@/components/ETFFlowsPanel'), 'ETFFlowsPanel');
    this.lazyDefaultPanel('stablecoins', () => import('@/components/StablecoinPanel'), 'StablecoinPanel');

    if (this.ctx.isDesktopApp) {
      this.lazyImportedPanel('runtime-config', () => import('@/components/RuntimeConfigPanel'), 'RuntimeConfigPanel', (RuntimeConfigPanel) => new RuntimeConfigPanel({ mode: 'alert' }));
    }

    this.lazyDefaultPanel('insights', () => import('@/components/InsightsPanel'), 'InsightsPanel');
    if (isPanelInVariantDefaults('threat-timeline')) {
      this.lazyDefaultPanel('threat-timeline', () => import('@/components/ThreatTimelinePanel'), 'ThreatTimelinePanel');
    }

    // Global Giving panel (all variants)
    this.lazyDefaultPanel('giving', () => import('@/components/GivingPanel'), 'GivingPanel');

    // Happy variant panels (lazy-loaded — only relevant for happy variant)
    if (SITE_VARIANT === 'happy') {
      this.lazyImportedPanel('positive-feed', () => import('@/components/PositiveNewsFeedPanel'), 'PositiveNewsFeedPanel', (PositiveNewsFeedPanel) => {
        const p = new PositiveNewsFeedPanel();
        this.ctx.positivePanel = p;
        return p;
      });

      this.lazyImportedPanel('counters', () => import('@/components/CountersPanel'), 'CountersPanel', (CountersPanel) => {
        const p = new CountersPanel();
        p.startTicking();
        this.ctx.countersPanel = p;
        return p;
      });

      this.lazyImportedPanel('progress', () => import('@/components/ProgressChartsPanel'), 'ProgressChartsPanel', (ProgressChartsPanel) => {
        const p = new ProgressChartsPanel();
        this.ctx.progressPanel = p;
        return p;
      });

      this.lazyImportedPanel('breakthroughs', () => import('@/components/BreakthroughsTickerPanel'), 'BreakthroughsTickerPanel', (BreakthroughsTickerPanel) => {
        const p = new BreakthroughsTickerPanel();
        this.ctx.breakthroughsPanel = p;
        return p;
      });

      this.lazyImportedPanel('spotlight', () => import('@/components/HeroSpotlightPanel'), 'HeroSpotlightPanel', (HeroSpotlightPanel) => {
        const p = new HeroSpotlightPanel();
        p.onLocationRequest = (lat: number, lon: number) => {
          this.ctx.map?.setCenter(lat, lon, 4);
          this.ctx.map?.flashLocation(lat, lon, 3000);
        };
        this.ctx.heroPanel = p;
        return p;
      });

      this.lazyImportedPanel('digest', () => import('@/components/GoodThingsDigestPanel'), 'GoodThingsDigestPanel', (GoodThingsDigestPanel) => {
        const p = new GoodThingsDigestPanel();
        this.ctx.digestPanel = p;
        return p;
      });

      this.lazyImportedPanel('species', () => import('@/components/SpeciesComebackPanel'), 'SpeciesComebackPanel', (SpeciesComebackPanel) => {
        const p = new SpeciesComebackPanel();
        this.ctx.speciesPanel = p;
        return p;
      });

    }

    // Renewable Energy is shared by happy and energy variants.
    if (this.shouldCreatePanel('renewable')) {
      this.lazyImportedPanel('renewable', () => import('@/components/RenewableEnergyPanel'), 'RenewableEnergyPanel', (RenewableEnergyPanel) => {
        const p = new RenewableEnergyPanel();
        this.ctx.renewablePanel = p;
        return p;
      });
    }

    // Always load custom widgets — Pro gating is handled reactively by auth state.
    for (const spec of loadWidgets()) {
      if (!this.ctx.panelSettings[spec.id]) {
        this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
      }
      const capturedSpec = spec;
      this.lazyPanel(spec.id, () =>
        this.importPanel(
          spec.id,
          () => import('@/components/CustomWidgetPanel'),
          'CustomWidgetPanel',
          (CustomWidgetPanel) => new CustomWidgetPanel(capturedSpec),
        ),
      );
    }

    for (const spec of loadMcpPanels()) {
      if (!this.ctx.panelSettings[spec.id]) {
        this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
      }
      const capturedSpec = spec;
      this.lazyPanel(spec.id, () =>
        this.importPanel(
          spec.id,
          () => import('@/components/McpDataPanel'),
          'McpDataPanel',
          (McpDataPanel) => new McpDataPanel(capturedSpec),
        ),
      );
    }

    const variantOrder = (VARIANT_DEFAULTS[SITE_VARIANT] ?? VARIANT_DEFAULTS['full'] ?? []).filter(k => k !== 'map');
    const activePanelSet = new Set(Object.keys(this.ctx.panelSettings));
    const crossVariantKeys = Object.keys(this.ctx.panelSettings).filter(k => !variantOrder.includes(k) && k !== 'map');
    const defaultOrder = [...variantOrder.filter(k => activePanelSet.has(k)), ...crossVariantKeys];
    const activePanelKeys = Object.keys(this.ctx.panelSettings).filter(k => k !== 'map');
    const bottomSet = this.getSavedBottomSet();
    const savedOrder = this.getSavedPanelOrder();
    this.bottomSetMemory = bottomSet;
    const effectiveUltraWide = this.getEffectiveUltraWide();
    this.wasUltraWide = effectiveUltraWide;

    const hasSavedOrder = savedOrder.length > 0;
    let allOrder: string[];

    if (hasSavedOrder) {
      const valid = savedOrder.filter(k => activePanelKeys.includes(k));
      const missing = activePanelKeys.filter(k => !valid.includes(k));

      missing.forEach(k => {
        if (k === 'monitors') return;
        const defaultIdx = defaultOrder.indexOf(k);
        if (defaultIdx === -1) { valid.push(k); return; }
        let inserted = false;
        for (let i = defaultIdx + 1; i < defaultOrder.length; i++) {
          const afterIdx = valid.indexOf(defaultOrder[i]!);
          if (afterIdx !== -1) { valid.splice(afterIdx, 0, k); inserted = true; break; }
        }
        if (!inserted) valid.push(k);
      });

      const monitorsIdx = valid.indexOf('monitors');
      if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1);
      if (SITE_VARIANT !== 'happy') valid.push('monitors');
      allOrder = valid;
    } else {
      allOrder = [...defaultOrder];

      if (SITE_VARIANT !== 'happy') {
        const liveNewsIdx = allOrder.indexOf('live-news');
        if (liveNewsIdx > 0) {
          allOrder.splice(liveNewsIdx, 1);
          allOrder.unshift('live-news');
        }

        const webcamsIdx = allOrder.indexOf('live-webcams');
        if (webcamsIdx !== -1 && webcamsIdx !== allOrder.indexOf('live-news') + 1) {
          allOrder.splice(webcamsIdx, 1);
          const afterNews = allOrder.indexOf('live-news') + 1;
          allOrder.splice(afterNews, 0, 'live-webcams');
        }
      }

      if (this.ctx.isDesktopApp) {
        const runtimeIdx = allOrder.indexOf('runtime-config');
        if (runtimeIdx > 1) {
          allOrder.splice(runtimeIdx, 1);
          allOrder.splice(1, 0, 'runtime-config');
        } else if (runtimeIdx === -1) {
          allOrder.splice(1, 0, 'runtime-config');
        }
      }
    }

    this.resolvedPanelOrder = allOrder;

    const sidebarOrder = effectiveUltraWide
      ? allOrder.filter(k => !this.bottomSetMemory.has(k))
      : allOrder;
    const bottomOrder = effectiveUltraWide
      ? allOrder.filter(k => this.bottomSetMemory.has(k))
      : [];

    sidebarOrder.forEach((key: string) => {
      this.insertInitialPanelByKey(panelsGrid, key);
    });

    // "+" Add Panel block at the end of the grid
    const addPanelBlock = document.createElement('button');
    addPanelBlock.className = 'add-panel-block';
    addPanelBlock.setAttribute('aria-label', t('components.panel.addPanel'));
    const addIcon = document.createElement('span');
    addIcon.className = 'add-panel-block-icon';
    addIcon.textContent = '+';
    const addLabel = document.createElement('span');
    addLabel.className = 'add-panel-block-label';
    addLabel.textContent = t('components.panel.addPanel');
    addPanelBlock.appendChild(addIcon);
    addPanelBlock.appendChild(addLabel);
    addPanelBlock.addEventListener('click', () => {
      this.ctx.unifiedSettings?.open('panels');
    });
    panelsGrid.appendChild(addPanelBlock);

    // Always create Pro and MCP add-panel blocks — show/hide reactively via auth state.
    const proBlock = document.createElement('button');
    proBlock.className = 'add-panel-block ai-widget-block ai-widget-block-pro';
    proBlock.setAttribute('aria-label', t('widgets.createInteractive'));
    const proIcon = document.createElement('span');
    proIcon.className = 'add-panel-block-icon';
    proIcon.textContent = '\u26a1';
    const proLabel = document.createElement('span');
    proLabel.className = 'add-panel-block-label';
    proLabel.textContent = t('widgets.createInteractive');
    const proBadge = document.createElement('span');
    proBadge.className = 'widget-pro-badge';
    proBadge.textContent = t('widgets.proBadge');
    proBlock.appendChild(proIcon);
    proBlock.appendChild(proLabel);
    proBlock.appendChild(proBadge);
    proBlock.addEventListener('click', () => {
      void import('@/components/WidgetChatModal').then((m) => m.openWidgetChatModal({
        mode: 'create',
        tier: 'pro',
        onComplete: (spec) => this.addCustomWidget(spec),
      })).catch((err) => console.error('[widget-chat] failed to lazy-load WidgetChatModal', err));
    });
    panelsGrid.appendChild(proBlock);

    const mcpBlock = document.createElement('button');
    mcpBlock.className = 'add-panel-block mcp-panel-block';
    mcpBlock.setAttribute('aria-label', t('mcp.connectPanel'));
    const mcpIcon = document.createElement('span');
    mcpIcon.className = 'add-panel-block-icon';
    mcpIcon.textContent = '\u26a1';
    const mcpLabel = document.createElement('span');
    mcpLabel.className = 'add-panel-block-label';
    mcpLabel.textContent = t('mcp.connectPanel');
    const mcpBadge = document.createElement('span');
    mcpBadge.className = 'widget-pro-badge';
    mcpBadge.textContent = t('widgets.proBadge');
    mcpBlock.appendChild(mcpIcon);
    mcpBlock.appendChild(mcpLabel);
    mcpBlock.appendChild(mcpBadge);
    mcpBlock.addEventListener('click', () => {
      void import('@/components/McpConnectModal').then((m) => m.openMcpConnectModal({
        onComplete: (spec) => this.addMcpPanel(spec),
      })).catch((err) => console.error('[mcp-connect] failed to lazy-load McpConnectModal', err));
    });
    panelsGrid.appendChild(mcpBlock);

    // Reactively show/hide Pro-only UI blocks ("Create Interactive Widget" +
    // "Connect MCP" CTAs) based on premium access.
    //
    // hasPremiumAccess() folds in isEntitled() (Convex Dodo entitlement) per
    // panel-gating.ts:11-27 — so a paying subscriber whose Clerk publicMetadata
    // is never written by the webhook still resolves to true once the Convex
    // snapshot lands. BUT: the snapshot lands AFTER auth state stabilises, and
    // Convex updates do NOT necessarily fire a fresh subscribeAuthState event.
    // Subscribing only to subscribeAuthState meant these CTAs stayed
    // display:none for the whole page lifetime for paying users — exactly the
    // shape PR #3505 chased on the server side, repeated here on the client.
    //
    // Subscribe to BOTH auth state and entitlement changes; whichever fires
    // last (typically entitlements) is the one that flips the CTAs visible.
    // Mirrors the same dual-subscription wiring used by updatePanelGating
    // for existing panels (see lines ~259 and ~282).
    const proBlocks = [proBlock, mcpBlock];
    const applyProBlockGating = (isPro: boolean) => {
      for (const block of proBlocks) {
        block.style.display = isPro ? '' : 'none';
      }
    };
    const reapply = () => applyProBlockGating(hasPremiumAccess(getAuthState()));
    reapply();
    this.proBlockUnsubscribe = subscribeAuthState(reapply);
    this.proBlockEntitlementUnsubscribe = onEntitlementChange(reapply);

    const bottomGrid = document.getElementById('mapBottomGrid');
    if (bottomGrid) {
      bottomOrder.forEach(key => {
        this.insertInitialPanelByKey(bottomGrid, key);
      });
    }

    removeResponsiveZoneListener(this.responsiveZoneListener);
    this.responsiveZoneListener = addResponsiveZoneListener(
      window,
      this.getUltraWideMinWidth(),
      () => this.ensureCorrectZones(),
    );

    // Map's direct-deref block (kept here, after panel registration, by U3 #4459):
    // awaited only after registration so the chunk fetch overlaps it. Everything above
    // that touches the map does so via `?.` at mount/click time, so the map can be
    // constructed here without breaking registration. The responsive zone listener is
    // wired above (before this await) so a destroy() during the fetch tears it down;
    // the isDestroyed guard below also stops a destroyed manager from building a map.
    const { MapContainer } = await mapModulePromise;
    if (this.ctx.isDestroyed) return;
    markLcpDebug('wm:map:container-construct');
    this.ctx.map = new MapContainer(mapContainer, {
      zoom: this.ctx.isMobile ? 2.5 : 1.0,
      pan: { x: 0, y: 0 },
      view: this.ctx.isMobile ? this.ctx.resolvedLocation : 'global',
      layers: this.ctx.mapLayers,
      timeRange: '7d',
    }, preferGlobe);

    const eagerSupplyChainPanel = this.ctx.panels['supply-chain'] as SupplyChainPanel | undefined;
    if (eagerSupplyChainPanel) {
      this.ctx.map.setSupplyChainPanel(eagerSupplyChainPanel);
    }

    if (this.ctx.mapLayers.resilienceScore && !this.ctx.map.isDeckGLActive?.()) {
      this.ctx.mapLayers = { ...this.ctx.mapLayers, resilienceScore: false };
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
    }

    this.ctx.map.initEscalationGetters();
    this.ctx.currentTimeRange = this.ctx.map.getTimeRange();
    markLcpDebug('wm:map:container-ready');

    this.ctx.map.onTimeRangeChanged((range) => {
      this.ctx.currentTimeRange = range;
      this.applyTimeRangeFilterDebounced();
    });

    this.applyPanelSettings();
    this.applyInitialUrlState();

    // Observe each panel for viewport entry. As soon as a panel scrolls
    // within ~200px of the viewport it fires loadAllData() once
    // (debounced via rAF to coalesce above-the-fold panels that all
    // intersect on the first tick), so below-fold panels get their
    // viewport-gated data without waiting on the scroll listener.
    // Bootstrap already ran loadAllData() with forceAll=false, so this
    // is purely the lazy-scroll trigger. (#3990)
    this.observePanelsForViewport();

    if (import.meta.env.DEV) {
      const configured = new Set(Object.keys(ALL_PANELS).filter(k => k !== 'map'));
      const created = new Set(Object.keys(this.ctx.panels));
      const extra = [...created].filter(k => !configured.has(k) && k !== 'runtime-config' && !k.startsWith('cw-') && !k.startsWith('mcp-'));
      if (extra.length) console.warn('[PanelLayoutManager] Panels created but not in ALL_PANELS:', extra);
    }
  }

  private cancelScheduledLoadAllIdle(): void {
    if (this.scheduledLoadAllIdle === null || typeof window === 'undefined') return;
    const cancelIdle = window.cancelIdleCallback as ((handle: number) => void) | undefined;
    cancelIdle?.(this.scheduledLoadAllIdle);
    this.scheduledLoadAllIdle = null;
  }

  private scheduleLoadAllData(phase: HydrationSchedulePhase = 'near'): void {
    if (typeof window === 'undefined') {
      void this.callbacks.loadAllData();
      return;
    }
    const mark = (label: string) => {
      if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
        performance.mark(label);
      }
    };
    if (phase === 'near') {
      if (this.scheduledLoadAllIdle !== null || this.scheduledLoadAllRaf !== null) return;
      const idle = window.requestIdleCallback as ((cb: IdleRequestCallback, opts?: IdleRequestOptions) => number) | undefined;
      if (idle) {
        this.scheduledLoadAllIdle = idle(() => {
          this.scheduledLoadAllIdle = null;
          mark('wm:hydration:near-trigger');
          void this.callbacks.loadAllData();
        }, { timeout: 300 });
        return;
      }
    } else {
      this.cancelScheduledLoadAllIdle();
      if (this.scheduledLoadAllRaf !== null) return;
    }
    if (this.scheduledLoadAllRaf !== null) {
      return;
    }
    this.scheduledLoadAllRaf = window.requestAnimationFrame(() => {
      this.scheduledLoadAllRaf = null;
      mark(`wm:hydration:${phase}-trigger`);
      void this.callbacks.loadAllData();
    });
  }

  private observePanelsForViewport(): void {
    for (const panel of Object.values(this.ctx.panels)) {
      this.observePanelForHydration(panel);
    }
  }

  private applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      const panel = this.ctx.newsPanels[category];
      if (!panel) return;
      const filtered = this.filterItemsByTimeRange(items);
      if (filtered.length === 0 && items.length > 0) {
        panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
        return;
      }
      panel.renderNews(filtered);
    });
  }

  private filterItemsByTimeRange(items: import('@/types').NewsItem[], range: import('@/components/MapContainer').TimeRange = this.ctx.currentTimeRange): import('@/types').NewsItem[] {
    if (range === 'all') return items;
    const ranges: Record<string, number> = {
      '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000, '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000, 'all': Infinity,
    };
    const cutoff = Date.now() - (ranges[range] ?? Infinity);
    return items.filter((item) => {
      // Recency gate routed through effectivePubDateMs so pubDateMissing
      // items fail the cutoff check rather than falsely claiming freshness.
      // Items with NaN/Infinity/Invalid Date pubDates are ALSO excluded
      // (the helper sanitizes them to 0); previous behavior fell through
      // to `true` on non-finite, which included corrupt-stamp items in
      // narrow time windows. Treating untrustworthy timestamps uniformly
      // is the intentional shift — see data-loader.filterItemsByTimeRange.
      return effectivePubDateMs(item) >= cutoff;
    });
  }

  private getTimeRangeLabel(): string {
    const labels: Record<string, string> = {
      '1h': 'the last hour', '6h': 'the last 6 hours',
      '24h': 'the last 24 hours', '48h': 'the last 48 hours',
      '7d': 'the last 7 days', 'all': 'all time',
    };
    return labels[this.ctx.currentTimeRange] ?? 'the last 7 days';
  }

  private applyInitialUrlState(): void {
    if (!this.ctx.initialUrlState || !this.ctx.map) return;

    const { view, zoom, lat, lon, timeRange, layers } = this.ctx.initialUrlState;

    if (view) {
      // Pass URL zoom so the preset's default zoom doesn't overwrite it.
      this.ctx.map.setView(view, zoom);
    }

    if (timeRange) {
      this.ctx.map.setTimeRange(timeRange);
    }

    if (layers) {
      let normalized = normalizeExclusiveChoropleths(layers, this.ctx.mapLayers);
      if (normalized.resilienceScore && !this.ctx.map.isDeckGLActive?.()) {
        normalized = { ...normalized, resilienceScore: false };
      }
      this.ctx.mapLayers = normalized;
      saveToStorage(STORAGE_KEYS.mapLayers, normalized);
      this.ctx.map.setLayers(normalized);
    }

    if (lat !== undefined && lon !== undefined) {
      // Always honour URL lat/lon regardless of zoom level.
      this.ctx.map.setCenter(lat, lon, zoom);
    } else if (!view && zoom !== undefined) {
      // zoom-only without a view preset: apply directly.
      this.ctx.map.setZoom(zoom);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    const currentView = this.ctx.map.getState().view;
    if (regionSelect && currentView) {
      regionSelect.value = currentView;
    }
  }

  private addDynamicPanel(key: string, panel: Panel): void {
    this.ctx.panels[key] = panel;
    const el = panel.getElement();
    this.makeDraggable(el, key);
    const grid = document.getElementById('panelsGrid');
    if (grid) {
      const addBlock = grid.querySelector('.add-panel-block');
      if (addBlock) {
        grid.insertBefore(el, addBlock);
      } else {
        grid.appendChild(el);
      }
      this.mobilePanelNav?.applyToNewPanel(el);
      panel.notifyConnected();
      this.afterPanelMounted(key, panel);
    }
    this.savePanelOrder();
    this.applyPanelSettings();
  }

  addCustomWidget(spec: CustomWidgetSpec): void {
    saveWidget(spec);
    this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
    saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
    void this.importPanel(
      spec.id,
      () => import('@/components/CustomWidgetPanel'),
      'CustomWidgetPanel',
      (CustomWidgetPanel) => new CustomWidgetPanel(spec),
    ).then((panel) => {
      if (panel) this.addDynamicPanel(spec.id, panel);
    });
  }

  addMcpPanel(spec: McpPanelSpec): void {
    saveMcpPanel(spec);
    this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
    saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
    void this.importPanel(
      spec.id,
      () => import('@/components/McpDataPanel'),
      'McpDataPanel',
      (McpDataPanel) => new McpDataPanel(spec),
    ).then((panel) => {
      if (panel) this.addDynamicPanel(spec.id, panel);
    });
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY);
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v: unknown) => typeof v === 'string') as string[];
    } catch {
      return [];
    }
  }

  public applySavedPanelOrder(panelOrder?: string[]): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    const activePanelKeys = Object.keys(this.ctx.panelSettings).filter(k => k !== 'map');
    const savedOrder = (panelOrder ?? this.getSavedPanelOrder()).filter(k => activePanelKeys.includes(k));
    if (savedOrder.length === 0) return;

    const seen = new Set<string>();
    const allOrder: string[] = [];
    const appendUnique = (key: string) => {
      if (seen.has(key) || !activePanelKeys.includes(key)) return;
      seen.add(key);
      allOrder.push(key);
    };
    savedOrder.forEach(appendUnique);
    this.resolvedPanelOrder.forEach(appendUnique);
    activePanelKeys.forEach(appendUnique);

    this.bottomSetMemory = panelOrder ? new Set<string>() : this.getSavedBottomSet();
    this.resolvedPanelOrder = allOrder;

    const effectiveUltraWide = this.getEffectiveUltraWide();
    this.wasUltraWide = effectiveUltraWide;
    const sidebarOrder = effectiveUltraWide
      ? allOrder.filter(k => !this.bottomSetMemory.has(k))
      : allOrder;
    const bottomOrder = effectiveUltraWide
      ? allOrder.filter(k => this.bottomSetMemory.has(k))
      : [];

    const firstAddBlock = grid.querySelector('.add-panel-block');
    sidebarOrder.forEach((key) => {
      const el = this.getPanelElementForOrdering(key);
      if (!el) return;
      if (firstAddBlock) grid.insertBefore(el, firstAddBlock);
      else grid.appendChild(el);
    });

    bottomOrder.forEach((key) => {
      const el = this.getPanelElementForOrdering(key);
      if (el) bottomGrid.appendChild(el);
    });
  }

  savePanelOrder(): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    const sidebarIds = Array.from(grid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    const bottomIds = Array.from(bottomGrid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    const allOrder = this.buildUnifiedOrder(sidebarIds, bottomIds);
    this.resolvedPanelOrder = allOrder;
    saveToStorage(this.ctx.PANEL_ORDER_KEY, allOrder);
    saveToStorage(this.ctx.PANEL_ORDER_KEY + '-bottom-set', Array.from(this.bottomSetMemory));
  }

  private buildUnifiedOrder(sidebarIds: string[], bottomIds: string[]): string[] {
    const presentIds = [...sidebarIds, ...bottomIds];
    const uniqueIds: string[] = [];
    const seen = new Set<string>();

    presentIds.forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      uniqueIds.push(id);
    });

    const previousOrder = new Map<string, number>();
    this.resolvedPanelOrder.forEach((id, index) => {
      if (seen.has(id) && !previousOrder.has(id)) {
        previousOrder.set(id, index);
      }
    });
    uniqueIds.forEach((id, index) => {
      if (!previousOrder.has(id)) {
        previousOrder.set(id, this.resolvedPanelOrder.length + index);
      }
    });

    const edges = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    uniqueIds.forEach((id) => {
      edges.set(id, new Set());
      indegree.set(id, 0);
    });

    const addConstraints = (ids: string[]) => {
      for (let i = 1; i < ids.length; i++) {
        const prev = ids[i - 1]!;
        const next = ids[i]!;
        if (prev === next || !seen.has(prev) || !seen.has(next)) continue;
        const nextIds = edges.get(prev);
        if (!nextIds || nextIds.has(next)) continue;
        nextIds.add(next);
        indegree.set(next, (indegree.get(next) ?? 0) + 1);
      }
    };

    addConstraints(sidebarIds);
    addConstraints(bottomIds);

    const compareIds = (a: string, b: string) =>
      (previousOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (previousOrder.get(b) ?? Number.MAX_SAFE_INTEGER);

    const available = uniqueIds
      .filter((id) => (indegree.get(id) ?? 0) === 0)
      .sort(compareIds);
    const merged: string[] = [];

    while (available.length > 0) {
      const current = available.shift()!;
      merged.push(current);

      edges.get(current)?.forEach((next) => {
        const nextIndegree = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, nextIndegree);
        if (nextIndegree === 0) {
          available.push(next);
        }
      });
      available.sort(compareIds);
    }

    return merged.length === uniqueIds.length
      ? merged
      : uniqueIds.sort(compareIds);
  }

  private getSavedBottomSet(): Set<string> {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY + '-bottom-set');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((v: unknown) => typeof v === 'string'));
        }
      }
    } catch { /* ignore */ }
    try {
      const legacy = localStorage.getItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (Array.isArray(parsed)) {
          const bottomIds = parsed.filter((v: unknown) => typeof v === 'string') as string[];
          const set = new Set(bottomIds);
          // Merge old sidebar + bottom into unified PANEL_ORDER_KEY
          const sidebarOrder = this.getSavedPanelOrder();
          const seen = new Set(sidebarOrder);
          const unified = [...sidebarOrder];
          for (const id of bottomIds) {
            if (!seen.has(id)) { unified.push(id); seen.add(id); }
          }
          localStorage.setItem(this.ctx.PANEL_ORDER_KEY, JSON.stringify(unified));
          localStorage.setItem(this.ctx.PANEL_ORDER_KEY + '-bottom-set', JSON.stringify([...set]));
          localStorage.removeItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
          return set;
        }
      }
    } catch { /* ignore */ }
    return new Set();
  }

  private getUltraWideMinWidth(): number {
    return this.ctx.isDesktopApp ? 900 : 1600;
  }

  private getEffectiveUltraWide(): boolean {
    const mapSection = document.getElementById('mapSection');
    const mapEnabled = !mapSection?.classList.contains('hidden');
    return window.innerWidth >= this.getUltraWideMinWidth() && mapEnabled;
  }

  private insertByOrder(grid: HTMLElement, el: HTMLElement, key: string): void {
    const idx = this.resolvedPanelOrder.indexOf(key);
    if (idx === -1) { grid.appendChild(el); return; }
    for (let i = idx + 1; i < this.resolvedPanelOrder.length; i++) {
      const nextKey = this.resolvedPanelOrder[i]!;
      const nextEl = grid.querySelector(`[data-panel="${CSS.escape(nextKey)}"]`);
      // `parentNode === grid` guard: querySelector returns nodes that match
      // ANY descendant, but a concurrent DOM mutation (browser extension,
      // overlapping resize event mid-iteration) can move/remove nextEl
      // between this read and the insertBefore call below — at which point
      // insertBefore throws `NotFoundError: The node before which the new
      // node is to be inserted is not a child of this node.`
      // (WORLDMONITOR-Q6). If the reference moved, fall through to the
      // appendChild path so the panel still lands in the grid.
      if (nextEl && nextEl.parentNode === grid) { grid.insertBefore(el, nextEl); return; }
    }
    grid.appendChild(el);
  }

  private wasUltraWide = false;

  public ensureCorrectZones(): void {
    const effectiveUltraWide = this.getEffectiveUltraWide();

    if (effectiveUltraWide === this.wasUltraWide) return;
    this.wasUltraWide = effectiveUltraWide;

    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    if (!effectiveUltraWide) {
      const panelsInBottom = Array.from(bottomGrid.querySelectorAll('.panel')) as HTMLElement[];
      panelsInBottom.forEach(panelEl => {
        const id = panelEl.dataset.panel;
        if (!id) return;
        this.insertByOrder(grid, panelEl, id);
      });
    } else {
      this.bottomSetMemory.forEach(id => {
        const el = grid.querySelector(`[data-panel="${CSS.escape(id)}"]`);
        if (el) {
          this.insertByOrder(bottomGrid, el as HTMLElement, id);
        }
      });
    }
  }

  private attachRelatedAssetHandlers(panel: NewsPanel): void {
    panel.setRelatedAssetHandlers({
      onRelatedAssetClick: (asset) => this.handleRelatedAssetClick(asset),
      onRelatedAssetsFocus: (assets) => this.ctx.map?.highlightAssets(assets),
      onRelatedAssetsClear: () => this.ctx.map?.highlightAssets(null),
    });
  }

  private handleRelatedAssetClick(asset: RelatedAsset): void {
    if (!this.ctx.map) return;

    switch (asset.type) {
      case 'pipeline':
        this.ctx.map.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerPipelineClick(asset.id);
        break;
      case 'cable':
        this.ctx.map.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerCableClick(asset.id);
        break;
      case 'datacenter':
        this.ctx.map.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerDatacenterClick(asset.id);
        break;
      case 'base':
        this.ctx.map.enableLayer('bases');
        this.ctx.mapLayers.bases = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerBaseClick(asset.id);
        break;
      case 'nuclear':
        this.ctx.map.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerNuclearClick(asset.id);
        break;
    }
  }

  private importPanel<M extends object, K extends keyof M & string>(
    key: string,
    importer: () => Promise<M>,
    exportName: K,
    createPanel: (PanelClass: PanelExport<M, K>, module: M) => ImportedPanel<M, K> | null,
  ): Promise<ImportedPanel<M, K> | null> {
    return importer().then((module) => {
      const PanelClass = module[exportName];
      if (typeof PanelClass !== 'function') {
        console.error(`[panel] ${exportName} export unavailable for "${key}"`);
        return null;
      }
      return createPanel(PanelClass as PanelExport<M, K>, module);
    }, (err) => {
      console.error(`[panel] failed to lazy-load "${key}"`, err);
      return null;
    });
  }

  private lazyImportedPanel<M extends object, K extends keyof M & string>(
    key: string,
    importer: () => Promise<M>,
    exportName: K,
    createPanel: (PanelClass: PanelExport<M, K>, module: M) => ImportedPanel<M, K> | null,
    setup?: (panel: ImportedPanel<M, K>) => void,
    lockedFeatures?: string[],
  ): void {
    this.lazyPanel(
      key,
      () => this.importPanel(key, importer, exportName, createPanel),
      setup,
      lockedFeatures,
    );
  }

  private lazyDefaultPanel<M extends object, K extends keyof M & string>(
    key: string,
    importer: () => Promise<M>,
    exportName: K,
    setup?: (panel: ImportedPanel<M, K>) => void,
    lockedFeatures?: string[],
  ): void {
    this.lazyImportedPanel(key, importer, exportName, (PanelClass) => new PanelClass() as ImportedPanel<M, K>, setup, lockedFeatures);
  }

  private lazyPanel<T extends Panel>(
    key: string,
    loader: () => Promise<T | null>,
    setup?: (panel: T) => void,
    lockedFeatures?: string[],
  ): void {
    if (!this.shouldCreatePanel(key)) return;
    if (this.ctx.panels[key] || this.lazyPanelRegistrations.has(key)) return;
    this.lazyPanelRegistrations.set(key, {
      loading: null,
      load: async () => {
        if (this.ctx.isDestroyed) return null;
        const panel = await loader();
        if (!panel) return null;
        const basePanel = panel;
        if (this.ctx.isDestroyed) {
          basePanel.destroy?.();
          return null;
        }
        this.ctx.panels[key] = basePanel;
        if (lockedFeatures) {
          basePanel.showLocked(lockedFeatures);
        } else {
          // Re-apply auth gating for panels that load after the initial auth state fire.
          this.updatePanelGating(getAuthState());
          await replayPendingCalls(key, panel);
          if (this.ctx.isDestroyed) {
            basePanel.destroy?.();
            return null;
          }
          if (setup) setup(panel);
        }
        return basePanel;
      },
    });
  }

  private async loadRegisteredPanel(key: string): Promise<Panel | null> {
    const existing = this.ctx.panels[key];
    if (existing) return existing;
    const registration = this.lazyPanelRegistrations.get(key);
    if (!registration) return null;
    if (!registration.loading) {
      registration.loading = registration.load()
        .then((panel) => {
          if (panel) {
            this.lazyPanelRegistrations.delete(key);
          } else {
            registration.loading = null;
          }
          return panel;
        })
        .catch((err) => {
          registration.loading = null;
          console.error(`[panel] failed to lazy-load "${key}"`, err);
          return null;
        });
    }
    return registration.loading;
  }

  private makeDraggable(el: HTMLElement, key: string): void {
    type DropPosition = {
      grid: HTMLElement;
      panel: HTMLElement | null;
      insertBefore: boolean;
    };

    el.dataset.panel = key;
    let isDragging = false;
    let dragStarted = false;
    let startX = 0;
    let startY = 0;
    let rafId = 0;
    let ghostEl: HTMLElement | null = null;
    let dropIndicator: HTMLElement | null = null;
    let originalParent: HTMLElement | null = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let originalIndex = -1;
    let originalRect: DOMRect | null = null;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
    const DRAG_THRESHOLD = 8;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (el.dataset.resizing === 'true') return;
      if (
        target.classList?.contains('panel-resize-handle') ||
        target.closest?.('.panel-resize-handle') ||
        target.classList?.contains('panel-col-resize-handle') ||
        target.closest?.('.panel-col-resize-handle')
      ) return;
      if (target.closest('button, a, input, select, textarea')) return;

      isDragging = true;
      dragStarted = false;
      startX = e.clientX;
      startY = e.clientY;
      
      // Calculate offset within the element for smooth dragging
      const rect = el.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      
      e.preventDefault();
    };

    const createGhostElement = (): HTMLElement => {
      const ghost = el.cloneNode(true) as HTMLElement;
      // Strip iframes to prevent duplicate network requests and postMessage handlers
      ghost.querySelectorAll('iframe').forEach(ifr => ifr.remove());
      ghost.classList.add('panel-drag-ghost');
      ghost.style.position = 'fixed';
      ghost.style.pointerEvents = 'none';
      ghost.style.zIndex = '10000';
      ghost.style.opacity = '0.8';
      ghost.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.3)';
      ghost.style.transform = 'scale(1.02)';
      
      // Copy dimensions from original
      const rect = el.getBoundingClientRect();
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      
      document.body.appendChild(ghost);
      return ghost;
    };

    const createDropIndicator = (): HTMLElement => {
      const indicator = document.createElement('div');
      indicator.classList.add('panel-drop-indicator');
      // overlay on body so it doesn't shift grid children
      indicator.style.position = 'fixed';
      indicator.style.pointerEvents = 'none';
      indicator.style.zIndex = '9999';
      document.body.appendChild(indicator);
      return indicator;
    };

    const isWithinOriginalRect = (clientX: number, clientY: number) =>
      !!originalRect &&
      clientX >= originalRect.left &&
      clientX <= originalRect.right &&
      clientY >= originalRect.top &&
      clientY <= originalRect.bottom;

    const getAppendReference = (grid: HTMLElement): ChildNode | null => {
      if (grid.id !== 'panelsGrid') return null;
      return grid.querySelector('.add-panel-block');
    };

    const canAppendToGrid = (grid: HTMLElement, clientY: number): boolean => {
      if (grid !== originalParent) return true;
      const panelBottoms = Array.from(grid.children)
        .filter((child): child is HTMLElement =>
          child instanceof HTMLElement &&
          child !== el &&
          child.classList.contains('panel') &&
          !child.classList.contains('hidden'),
        )
        .map((panel) => panel.getBoundingClientRect().bottom);
      if (panelBottoms.length === 0) return false;
      return clientY > Math.max(...panelBottoms);
    };

    const commitDrop = (dropPos: DropPosition, clientX: number, clientY: number): boolean => {
      const { grid, panel, insertBefore } = dropPos;

      if (panel) {
        if (panel === el || panel.parentElement !== grid) return false;

        if (insertBefore) {
          if (el.nextSibling === panel) return false;
        } else {
          if (panel.nextSibling === el) return false;
        }

        const referenceNode = insertBefore ? panel : panel.nextSibling;
        if (referenceNode && referenceNode.parentNode !== grid) return false;

        grid.insertBefore(el, referenceNode);
        return true;
      }

      if (grid === originalParent && isWithinOriginalRect(clientX, clientY)) {
        return false;
      }
      if (!canAppendToGrid(grid, clientY)) return false;

      const referenceNode = getAppendReference(grid);
      if (referenceNode && referenceNode.parentNode !== grid) return false;
      if (referenceNode === el) return false;
      if (el.parentElement === grid && el.nextSibling === referenceNode) return false;

      grid.insertBefore(el, referenceNode);
      return true;
    };

    const updateGhostPosition = (clientX: number, clientY: number) => {
      if (!ghostEl) return;
      ghostEl.style.left = (clientX - dragOffsetX) + 'px';
      ghostEl.style.top = (clientY - dragOffsetY) + 'px';
    };

    const findDropPosition = (clientX: number, clientY: number): DropPosition | null => {
      const grid = document.getElementById('panelsGrid');
      const bottomGrid = document.getElementById('mapBottomGrid');
      if (!grid || !bottomGrid) return null;

      // Temporarily hide the ghost to get accurate hit detection
      const prevPointerEvents = ghostEl?.style.pointerEvents;
      if (ghostEl) ghostEl.style.pointerEvents = 'none';
      const target = document.elementFromPoint(clientX, clientY);
      if (ghostEl && typeof prevPointerEvents === 'string') ghostEl.style.pointerEvents = prevPointerEvents;

      if (!target) return null;

      const targetGrid = (target.closest('.panels-grid') || target.closest('.map-bottom-grid')) as HTMLElement | null;
      const targetPanel = target.closest('.panel') as HTMLElement | null;

      if (!targetGrid && !targetPanel) return null;

      const currentTargetGrid = targetGrid || (targetPanel ? targetPanel.parentElement as HTMLElement : null);
      if (!currentTargetGrid || (currentTargetGrid !== grid && currentTargetGrid !== bottomGrid)) return null;
      const panel = targetPanel && targetPanel !== el ? targetPanel : null;
      let insertBefore = false;
      if (panel) {
        const panelRect = panel.getBoundingClientRect();
        insertBefore = clientY < panelRect.top + panelRect.height / 2;
      }

      return {
        grid: currentTargetGrid,
        panel,
        insertBefore,
      };
    };

    let lastTargetPanel: HTMLElement | null = null;

    const updateDropIndicator = (clientX: number, clientY: number) => {
      const dropPos = findDropPosition(clientX, clientY);
      if (!dropPos) {
        if (dropIndicator) dropIndicator.style.opacity = '0';
        if (lastTargetPanel) {
          lastTargetPanel.classList.remove('panel-drop-target');
          lastTargetPanel = null;
        }
        return;
      }

      const { grid, panel, insertBefore } = dropPos;
      if (!dropIndicator) return;

      const noOpEmptyDrop = !panel &&
        ((grid === originalParent && isWithinOriginalRect(clientX, clientY)) || !canAppendToGrid(grid, clientY));
      if (noOpEmptyDrop) {
        dropIndicator.style.opacity = '0';
        if (lastTargetPanel) {
          lastTargetPanel.classList.remove('panel-drop-target');
          lastTargetPanel = null;
        }
        return;
      }

      // highlight hovered panel
      if (panel !== lastTargetPanel) {
        if (lastTargetPanel) lastTargetPanel.classList.remove('panel-drop-target');
        if (panel) panel.classList.add('panel-drop-target');
        lastTargetPanel = panel;
      }

      // compute absolute coordinates for the indicator
      let top = 0;
      let left = 0;
      let width = 0;

      if (panel) {
        const panelRect = panel.getBoundingClientRect();
        width = panelRect.width;
        left = panelRect.left;
        top = insertBefore ? panelRect.top - 4 : panelRect.bottom;
      } else {
        // dropping into empty grid: position at grid bottom
        const gridRect = grid.getBoundingClientRect();
        width = gridRect.width;
        left = gridRect.left;
        top = gridRect.bottom;
      }

      dropIndicator.style.width = width + 'px';
      dropIndicator.style.left = left + 'px';
      dropIndicator.style.top = top + 'px';
      dropIndicator.style.opacity = '0.8';
    };

    let lastX = 0;
    let lastY = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (!dragStarted) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        dragStarted = true;
        
        // Initialize drag visualization
        document.body.classList.add('panel-drag-active');
        el.classList.add('dragging-source');
        originalParent = el.parentElement as HTMLElement;
        originalIndex = Array.from(originalParent.children).indexOf(el);
        originalRect = el.getBoundingClientRect();
        ghostEl = createGhostElement();
        dropIndicator = createDropIndicator();
        onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            // Cancel drag and restore original position
            document.body.classList.remove('panel-drag-active');
            el.classList.remove('dragging-source');
            if (ghostEl) {
              ghostEl.style.opacity = '0';
              const g = ghostEl;
              setTimeout(() => g.remove(), 200);
              ghostEl = null;
            }
            if (dropIndicator) {
              dropIndicator.style.opacity = '0';
              const d = dropIndicator;
              setTimeout(() => d.remove(), 200);
              dropIndicator = null;
            }
            if (lastTargetPanel) {
              lastTargetPanel.classList.remove('panel-drop-target');
              lastTargetPanel = null;
            }

            if (originalParent && originalIndex >= 0) {
              const children = Array.from(originalParent.children);
              const insertBefore = children[originalIndex];
              if (insertBefore) {
                originalParent.insertBefore(el, insertBefore);
              } else {
                originalParent.appendChild(el);
              }
            }

            document.removeEventListener('keydown', onKeyDown!, true);
            onKeyDown = null;
            isDragging = false;
            dragStarted = false;
            originalRect = null;
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
      }

      lastX = e.clientX;
      lastY = e.clientY;
      const cx = e.clientX;
      const cy = e.clientY;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (dragStarted) {
          updateGhostPosition(cx, cy);
          updateDropIndicator(cx, cy);
        }
        rafId = 0;
      });
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      
      if (dragStarted) {
        // Find final drop position using most recent cursor coords
        const dropPos = findDropPosition(lastX, lastY);
        const moved = dropPos ? commitDrop(dropPos, lastX, lastY) : false;
        
        // Clean up drag visualization (panel-drag-active is cleared unconditionally below)
        el.classList.remove('dragging-source');
        if (ghostEl) {
          ghostEl.style.opacity = '0';
          const g = ghostEl;
          setTimeout(() => g.remove(), 200);
          ghostEl = null;
        }
        if (dropIndicator) {
          dropIndicator.style.opacity = '0';
          const d = dropIndicator;
          setTimeout(() => d.remove(), 200);
          dropIndicator = null;
        }
        if (lastTargetPanel) {
          lastTargetPanel.classList.remove('panel-drop-target');
          lastTargetPanel = null;
        }
        
        if (moved) {
          const isInBottom = !!el.closest('.map-bottom-grid');
          if (isInBottom) {
            this.bottomSetMemory.add(key);
          } else {
            this.bottomSetMemory.delete(key);
          }
          this.savePanelOrder();
        }
      }
      dragStarted = false;
      document.body.classList.remove('panel-drag-active');
      originalRect = null;
      if (onKeyDown) {
        document.removeEventListener('keydown', onKeyDown, true);
        onKeyDown = null;
      }
    };

    el.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.panelDragCleanupHandlers.push(() => {
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (onKeyDown) {
        document.removeEventListener('keydown', onKeyDown, true);
        onKeyDown = null;
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (ghostEl) ghostEl.remove();
      if (dropIndicator) dropIndicator.remove();
      isDragging = false;
      dragStarted = false;
      document.body.classList.remove('panel-drag-active');
      originalRect = null;
      el.classList.remove('dragging-source');
    });
  }

  getLocalizedPanelName(panelKey: string, fallback: string): string {
    if (panelKey === 'runtime-config') {
      return t('modals.runtimeConfig.title');
    }
    const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    const lookup = `panels.${key}`;
    const localized = t(lookup);
    return localized === lookup ? fallback : localized;
  }

  getAllSourceNames(): string[] {
    const sources = new Set<string>();
    // Preset feeds + sources from any custom news panels the user added, so
    // the source manager stays in sync with what loadNews() actually fetches.
    const categories = resolveNewsCategories(FEEDS, CANONICAL_FEEDS, enabledNewsCategoryKeys(this.ctx.newsPanels, this.ctx.panels, this.ctx.panelSettings, Object.keys(CANONICAL_FEEDS)));
    categories.forEach(({ feeds }) => feeds.forEach(f => sources.add(f.name)));
    INTEL_SOURCES.forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }
}
