import type { Monitor, PanelConfig, MapLayers } from '@/types';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { openExternalUrl } from '@/services/external-navigation';
import { normalizeExclusiveChoropleths } from '@/components/resilience-choropleth-utils';
import type { AppContext } from '@/app/app-context';
import {
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
  ALL_PANELS,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  enforceFreePanelLimit,
  restoreFreeMapPanelAccess,
  restoreProGatedPanels,
  userSetPanelEnabled,
  shouldDeferFreeTierEnforcement,
  FREE_MAX_PANELS,
  FREE_MAX_SOURCES,
} from '@/config';
import {
  sanitizeLayersForVariant,
  sanitizeLockedLayers,
  sanitizeLockedLayersWithOwnership,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
  shouldSanitizeLockedLayers,
} from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { getStoredMapModePreference } from '@/services/map-mode-preference';
import {
  initDB,
  cleanOldSnapshots,
  isAisConfigured,
  initAisStream,
  isOutagesConfigured,
  disconnectAisStream,
  startFlightHistoryCleanup,
  stopFlightHistoryCleanup,
} from '@/services';
import { enableVesselRuntime, stopLoadedVesselHistoryCleanup } from '@/services/military-vessels-lazy';
import { isProUser, isProTierResolved, loadWidgets } from '@/services/widget-store';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { startLearning } from '@/services/country-instability';
import {
  isMobileDevice,
  isQuotaError,
  loadFromStorage,
  markStorageQuotaExceeded,
  parseMapUrlState,
  saveToStorage,
  showToast,
} from '@/utils';
import { clearPanelSpans, invalidatePanelStorageCacheForKeys } from '@/utils/panel-storage';
import { overlayHistory, type OverlayId } from '@/utils/overlay-history';
import type { ParsedMapUrlState } from '@/utils';
import { BreakingNewsBanner } from '@/components/BreakingNewsBanner';
import { initBreakingNewsAlerts, destroyBreakingNewsAlerts } from '@/services/breaking-news-alerts';
import { markLcpDebug } from '@/utils/lcp-debug';
import type { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { StablecoinPanel } from '@/components/StablecoinPanel';
import type { EnergyCrisisPanel } from '@/components/EnergyCrisisPanel';
import type { ETFFlowsPanel } from '@/components/ETFFlowsPanel';
import type { MacroSignalsPanel } from '@/components/MacroSignalsPanel';
import type { FearGreedPanel } from '@/components/FearGreedPanel';
import type { HormuzPanel } from '@/components/HormuzPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { StrategicRiskPanel } from '@/components/StrategicRiskPanel';
import type { GulfEconomiesPanel } from '@/components/GulfEconomiesPanel';
import type { GroceryBasketPanel } from '@/components/GroceryBasketPanel';
import type { BigMacPanel } from '@/components/BigMacPanel';
import type { FuelPricesPanel } from '@/components/FuelPricesPanel';
import type { FxPanel } from '@/components/FxPanel';
import type { FaoFoodPriceIndexPanel } from '@/components/FaoFoodPriceIndexPanel';
import type { OilInventoriesPanel } from '@/components/OilInventoriesPanel';
import type { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import type { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';
import type { FuelShortagePanel } from '@/components/FuelShortagePanel';
import type { EnergyDisruptionsPanel } from '@/components/EnergyDisruptionsPanel';
import type { EnergyRiskOverviewPanel } from '@/components/EnergyRiskOverviewPanel';
import type { ChokepointStripPanel } from '@/components/ChokepointStripPanel';
import type { ClimateNewsPanel } from '@/components/ClimateNewsPanel';
import type { ConsumerPricesPanel } from '@/components/ConsumerPricesPanel';
import type { DefensePatentsPanel } from '@/components/DefensePatentsPanel';
import type { MacroTilesPanel } from '@/components/MacroTilesPanel';
import type { FSIPanel } from '@/components/FSIPanel';
import type { YieldCurvePanel } from '@/components/YieldCurvePanel';
import type { EarningsCalendarPanel } from '@/components/EarningsCalendarPanel';
import type { EconomicCalendarPanel } from '@/components/EconomicCalendarPanel';
import type { CotPositioningPanel } from '@/components/CotPositioningPanel';
import type { LiquidityShiftsPanel } from '@/components/LiquidityShiftsPanel';
import type { PositioningPanel } from '@/components/PositioningPanel';
import type { GoldIntelligencePanel } from '@/components/GoldIntelligencePanel';
import { isDesktopRuntime, waitForSidecarReady } from '@/services/runtime';
import { hasPremiumAccess } from '@/services/panel-gating';
import { BETA_MODE } from '@/config/beta';
import { track, trackEvent, trackDeeplinkOpened, initAuthAnalytics } from '@/services/analytics';
import { preloadCountryGeometry, isCountryGeometryLoaded, getCountryNameByCode } from '@/services/country-geometry';
import { initI18n, t, I18N_RESOURCES_LOADED_EVENT, type I18nResourcesLoadedDetail } from '@/services/i18n';
import { initDeferredDashboardFonts } from '@/bootstrap/secondary-startup';

import {
  CANADA_ARCTIC_OPT_IN_SOURCES,
  computeDefaultDisabledSources,
  computeLegacyDefaultDisabledSources,
  FEEDS,
  FREE_CAP_PROTECTED_SOURCES,
  FRONTLINE_EUROPE_PROTECTED_SOURCES,
  getLocaleBoostedSources,
  getStrategicDefaultSources,
  getTotalFeedCount,
  INTEL_SOURCES,
} from '@/config/feeds';
import {
  computeCapDisabledSources,
  findFullyDisabledCategories,
  inferExactSourceGateOwnership,
  reconcileSourceGateOwnership,
  restoreGateOwnedSources,
  selectSourcesUnderCap,
  stringSetsEqual,
} from '@/services/source-cap';
import {
  applyVariantPanelLayoutTransition,
  persistGateOwnershipTransition,
  resolveAppliedPanelLayoutVariant,
} from '@/services/variant-panel-ownership';
import {
  buildPreStrategicDefaultDisabledStates,
  buildRegionalFeedRolloutMigrationTargets,
} from '@/services/regional-feed-rollout';
import {
  cancelBootstrapSlowTier,
  fetchBootstrapData,
  getBootstrapHydrationState,
  markBootstrapAsLive,
  waitForBootstrapSlowTier,
  type BootstrapHydrationState,
} from '@/services/bootstrap';
import { ensureWmSession, installWmSessionFetchInterceptor, WM_SESSION_DEGRADED_EVENT, type WmSessionDegradedDetail } from '@/services/wm-session';
import { describeWmSessionDegradation, WM_SESSION_DEGRADED_FALLBACK_COPY } from '@/services/wm-session-copy';
import { describeFreshness } from '@/services/persistent-cache';
import { DesktopUpdater } from '@/app/desktop-updater';
import { CountryIntelManager } from '@/app/country-intel';
import { registerWebMcpTools } from '@/services/webmcp';
import { refreshDataFreshnessFromHealth } from '@/services/health-freshness';
import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import type { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import {
  FreeTierGate,
  panelGateStateChanged,
  shouldRunCloudLegacyRecovery,
  sweepLegacyDisabledCustomWidgets,
} from '@/app/free-tier-gate';
import { replaceRawI18nKeyPlaceholders } from '@/app/i18n-raw-key-healer';
import { startAccountAuthHandoff } from '@/app/account-auth-handoff';
import { TierPreferenceHandoff } from '@/app/tier-preference-handoff';
import { resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';
import { showProBanner } from '@/components/ProBanner';
import { getAuthState, initAuthState, subscribeAuthState } from '@/services/auth-state';
import {
  CLOUD_PREFS_APPLIED_EVENT,
  CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
  getSyncVersion,
  hasPendingCloudPrefsRetry,
  install as installCloudPrefsSync,
  onSignIn as cloudPrefsSignIn,
  onSignOut as cloudPrefsSignOut,
  type CloudPrefsAppliedDetail,
  type CloudPrefsSignInTerminalDetail,
} from '@/utils/cloud-prefs-sync';
import {
  migrateFrontlineEuropeDefaultsV3,
  migrateStrategicDefaultsV4,
  migrateRegionalFeedRolloutDefaultsV5,
  migrateCanadaArcticOptInsV6,
} from '@/utils/cloud-prefs-migrations';
import {
  getConvexClient,
  getConvexApi,
  invalidateConvexAuthForSignOut,
  rebindConvexAuthForWatchHandoff,
  waitForConvexAuthForUser,
} from '@/services/convex-client';
import {
  assertAccountStillCurrent,
  isAccountStillCurrent,
  settleAccountOperation,
} from '@/services/account-operation';
import type { Id } from '../convex/_generated/dataModel';
import { initEntitlementSubscription, destroyEntitlementSubscription, resetEntitlementState, onEntitlementChange, getEntitlementState } from '@/services/entitlements';
import { initSubscriptionWatch, destroySubscriptionWatch } from '@/services/billing';
import {
  FREE_TIER_FOLLOW_LIMIT,
  WM_FOLLOWED_COUNTRIES_CAP_DROP,
  installFollowedCountriesAuthListener,
} from '@/services/followed-countries';
import {
  capturePendingCheckoutIntentFromUrl,
  initCheckoutWatchers,
  resumePendingCheckout,
} from '@/services/checkout';
import {
  clearStoredAnonIdentity,
  getFreshStoredAnonClaimToken,
  getStoredAnonId,
} from '@/services/anonymous-identity-storage';
import { captureReferralFromUrl } from '@/services/referral-capture';
import { nextPrimeRetryDelayMs } from '@/utils/prime-retry';

/** Look-ahead margin for viewport-gated panel priming and refresh scheduling. */
const DEFAULT_VIEWPORT_MARGIN_PX = 400;
// CorrelationEngine + its 4 adapters are dynamic-imported at the post-loadAllData
// run site (#4486) so the engine bytes stay off the eager boot graph. The TYPE is
// referenced via the inline `import(...)` type in app-context.ts (erased at build).
import type { CorrelationPanel } from '@/components/CorrelationPanel';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';
const FREE_MAP_PANEL_ACCESS_KEY = 'worldmonitor-free-map-panel-access-v1';
const CW_PRO_GATE_RECOVERY_KEY = 'worldmonitor-cw-pro-gate-recovery-v1';
const CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY = 'worldmonitor-cw-pro-gate-cloud-recovery-baseline-v1';
const CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY = 'worldmonitor-cw-pro-gate-cloud-recovery-applied-v1';
type SignalModalInstance = import('@/components/SignalModal').SignalModal;

export type { CountryBriefSignals } from '@/app/app-context';

export class App {
  private state: AppContext;
  private pendingDeepLinkCountry: string | null = null;
  private pendingDeepLinkExpanded = false;
  private pendingDeepLinkStoryCode: string | null = null;
  private pendingDeepLinkChokepoint: string | null = null;
  private chokepointDeepLinkTimer: number | null = null;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager | null = null;
  private searchManagerLoad: Promise<SearchManager> | null = null;
  private signalModalLoad: Promise<SignalModalInstance> | null = null;
  // Monotonic epoch: every openSearch() call supersedes earlier in-flight ones.
  // searchToggleDesiredOpen accumulates the net intent of rapid Cmd+K presses
  // while the lazy chunk loads (XOR: odd → open, even → cancel). (#4403 review)
  private openSearchEpoch = 0;
  private searchToggleDesiredOpen = false;
  private latestSearchAdsb: Parameters<SearchManager['updateFlightSource']>[0] = [];
  private latestSearchMilitary: Parameters<SearchManager['updateFlightSource']>[1] = [];
  private countryIntel: CountryIntelManager;
  private refreshScheduler: RefreshScheduler;
  private desktopUpdater: DesktopUpdater;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;
  private unsubFreeTier: (() => void) | null = null;
  private unsubEntitlementPremiumLoaders: (() => void) | null = null;
  // Resolves once Phase-4 UI modules have initialised so WebMCP bindings can
  // await readiness before touching nullable UI targets. Avoids the startup
  // race where an agent
  // discovers a tool via early registerTool and invokes it before the
  // target panel exists.
  private uiReady!: Promise<void>;
  private resolveUiReady!: () => void;
  // Returned by registerWebMcpTools in browser runtimes — aborting it removes
  // late-provider listeners and unregisters every accepted tool. destroy()
  // triggers it so test harnesses / same-document re-inits don't accumulate
  // duplicate registrations.
  private webMcpController: AbortController | null = null;
  private visiblePanelPrimed = new Set<string>();
  /**
   * Per-pass viewport results, or null outside a pass. See
   * {@link primeViewportNearCache}.
   */
  private viewportNearCache: Map<string, boolean> | null = null;
  /** Consecutive prime failures per key, for the retry backoff. */
  private visiblePanelPrimeFailures = new Map<string, number>();
  /** Earliest `Date.now()` at which a failed prime key may be retried. */
  private visiblePanelPrimeRetryAt = new Map<string, number>();
  private visiblePanelPrimeRaf: number | null = null;
  private viewportHydrationReady = false;
  private followedCountriesCapDropToastTimer: number | null = null;
  private bootstrapHydrationState: BootstrapHydrationState = getBootstrapHydrationState();
  private cachedModeBannerEl: HTMLElement | null = null;
  private pendingCloudRecoverySyncVersion: number | undefined;
  /** Token of the in-flight preference handoff, so the cloud-applied event can release it. */
  private pendingPreferenceHandoffGeneration: number | undefined;
  private readonly tierPreferenceHandoff = new TierPreferenceHandoff();
  private readonly handleWmSessionDegraded = (event?: Event): void => {
    if (!this.state.isDestroyed) {
      // Pre-#5674 bundles in long-lived tabs can still dispatch a plain Event
      // with no detail; fall back to the cookie wording those users used to get.
      const reason = (event as CustomEvent<WmSessionDegradedDetail> | undefined)?.detail?.reason;
      showToast(
        reason
          ? describeWmSessionDegradation(reason)
          : WM_SESSION_DEGRADED_FALLBACK_COPY,
      );
    }
  };
  private readonly handleViewportPrime = (event?: Event): void => {
    if (!this.viewportHydrationReady || this.state.isDestroyed) return;
    if (
      event?.type === 'scroll' &&
      event.target instanceof Element &&
      !event.target.matches('.main-content, .panels-grid')
    ) {
      return;
    }
    if (this.visiblePanelPrimeRaf !== null) return;
    this.visiblePanelPrimeRaf = window.requestAnimationFrame(() => {
      this.visiblePanelPrimeRaf = null;
      markLcpDebug('wm:hydration:viewport-trigger');
      void this.primeVisiblePanelData();
      // loadAllData covers panels primeVisiblePanelData does not (news,
      // markets, intelligence, fred, …). Now that bootstrap runs with
      // forceAll=false, below-fold panels need this re-trigger on scroll
      // so their data lands when they enter the viewport. Both are
      // viewport-gated and inflight-guarded — repeat invocations are
      // cheap.
      void this.dataLoader.loadAllData();
    });
  };
  private readonly handleConnectivityChange = (): void => {
    this.updateConnectivityUi();
  };
  private readonly handleI18nResourcesLoaded = (ev: Event): void => {
    const language = (ev as CustomEvent<I18nResourcesLoadedDetail>).detail?.language;
    if (language !== 'en') return;
    // Scope this to the app container: body-level modals are user-opened after
    // startup, by which point the full English bundle should already be loaded.
    replaceRawI18nKeyPlaceholders(this.state.container, t);
  };
  private readonly handleFollowedCountriesCapDrop = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ kept?: unknown; dropped?: unknown }>).detail;
    const dropped = typeof detail?.dropped === 'number' ? detail.dropped : 0;
    const kept = typeof detail?.kept === 'number' ? detail.kept : FREE_TIER_FOLLOW_LIMIT;
    if (dropped <= 0) return;
    this.showFollowedCountriesCapDropToast(kept, dropped);
  };
  private readonly handleCloudPrefsApplied = (ev: Event): void => {
    const detail = (ev as CustomEvent<CloudPrefsAppliedDetail>).detail;
    this.applyCloudSyncedPrefsToRuntime(detail?.keys ?? [], detail?.syncVersion);
  };
  private readonly handleCloudPrefsSignInTerminal = (ev: Event): void => {
    const detail = (ev as CustomEvent<CloudPrefsSignInTerminalDetail>).detail;
    const pendingGeneration = this.pendingPreferenceHandoffGeneration;
    if (
      detail?.origin !== 'sign-in'
      || pendingGeneration === undefined
      || detail.handoffGeneration !== pendingGeneration
    ) {
      return;
    }

    const currentUserId = getAuthState().user?.id ?? null;
    if (this.tierPreferenceHandoff.complete(
      pendingGeneration,
      detail.accountId,
      currentUserId,
    )) {
      this.pendingPreferenceHandoffGeneration = undefined;
      // A terminal sign-in attempt is the only handoff release signal. Run
      // one complete pass even when the cloud blob changed no local keys.
      this.reconcileTierOwnedPreferences();
    }
  };

  private applyCloudSyncedPrefsToRuntime(keys: readonly string[], cloudSyncVersion?: number): void {
    if (keys.length === 0) return;

    const keySet = new Set(keys);
    let freeTierLimitsInvoked = false;
    const tierReconciliationDeferred = this.shouldDeferTierPreferenceReconciliation();
    invalidatePanelStorageCacheForKeys(keys);

    if (keySet.has(STORAGE_KEYS.panels)) {
      // Cloud can reconcile before Clerk/Convex finishes settling. Preserve
      // the first panel-bearing cloud generation so a later Pro callback can
      // still run the bounded legacy recovery pass.
      if (cloudSyncVersion !== undefined && this.pendingCloudRecoverySyncVersion === undefined) {
        this.pendingCloudRecoverySyncVersion = cloudSyncVersion;
      }
      this.state.panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        this.state.panelSettings,
      );
      // Reconcile the freshly applied snapshot against the current
      // entitlement: a cloud blob written while the tier was unknown can carry
      // a stale free-tier clamp, and `proGated` markers travel with it, so the
      // targeted restore inside enforceFreeTierLimits puts those panels back.
      // Returns false while the tier is still unresolved — the fallback below
      // then just re-renders the snapshot, which is all this handler did
      // before reconciliation moved here.
      const reconciledPanelSettings = tierReconciliationDeferred
        ? false
        : this.enforceFreeTierLimits(cloudSyncVersion);
      freeTierLimitsInvoked = !tierReconciliationDeferred;
      if (!reconciledPanelSettings) {
        this.panelLayout.applyPanelSettings();
        this.state.unifiedSettings?.refreshPanelToggles();
      }
    }

    const panelOrderKey = this.state.PANEL_ORDER_KEY;
    if (keySet.has(panelOrderKey) || keySet.has(`${panelOrderKey}-bottom-set`)) {
      this.panelLayout.applySavedPanelOrder();
    }

    if (
      (keySet.has(STORAGE_KEYS.mapLayers) || keySet.has(STORAGE_KEYS.mapLayerGateOwnership))
      && !this.state.initialUrlState?.layers
    ) {
      let nextLayers = normalizeExclusiveChoropleths(
        sanitizeLayersForVariant(
          loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, this.state.mapLayers),
          SITE_VARIANT as MapVariant,
        ),
        this.state.mapLayers,
      );
      // #6045 — clear locked premium layers once free-tier is settled.
      // Skip while entitlement is still resolving so Pro users don't lose
      // resilienceScore during the Clerk/Convex boot window.
      if (!tierReconciliationDeferred) {
        nextLayers = this.sanitizeMapLayersForTier(nextLayers);
      }
      if (!CYBER_LAYER_ENABLED) nextLayers.cyberThreats = false;
      if (!mapLayerStatesEqual(this.state.mapLayers, nextLayers)) {
        this.state.mapLayers = nextLayers;
        this.state.map?.setLayers(nextLayers);
        this.dataLoader.syncDataFreshnessWithLayers();
      }
    }

    if (keySet.has(STORAGE_KEYS.mapMode)) {
      const mode = getStoredMapModePreference();
      if (mode === 'globe') this.state.map?.switchToGlobe();
      else this.state.map?.switchToFlat();
    }

    if (
      keySet.has(STORAGE_KEYS.disabledFeeds)
      || keySet.has(STORAGE_KEYS.sourceGateOwnership)
    ) {
      // A cloud generation can contain only source preferences. Re-run the
      // cap even when no panel snapshot arrived, then reload storage because
      // enforcement may have persisted additional auto-disabled sources.
      if (!tierReconciliationDeferred && !freeTierLimitsInvoked) {
        this.enforceFreeTierLimits(cloudSyncVersion);
      }
      this.state.disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
    }

    if (keySet.has(STORAGE_KEYS.monitors)) {
      this.state.monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);
      const monitorPanel = this.state.panels['monitors'] as MonitorPanel | undefined;
      monitorPanel?.setMonitors(this.state.monitors);
      this.dataLoader.updateMonitorResults();
    }
  }

  private isPanelNearViewport(panelId: string, marginPx = DEFAULT_VIEWPORT_MARGIN_PX): boolean {
    if (marginPx === DEFAULT_VIEWPORT_MARGIN_PX && this.viewportNearCache) {
      const cached = this.viewportNearCache.get(panelId);
      if (cached !== undefined) return cached;
    }
    const panel = this.state.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  /**
   * Read every mounted panel's viewport state in one uninterrupted pass (#4487).
   *
   * `Panel.isNearViewport` calls `getComputedStyle` AND `getBoundingClientRect`,
   * both of which force style/layout. `primeVisiblePanelData` gates ~48 panels,
   * and a passing gate synchronously enters the panel's loader, several of which
   * write DOM before their first await (`showLoading` / `renderPanel`). That made
   * the pass read → write → read → write, so each read re-flushed a layout the
   * previous write had just invalidated — up to 48 forced layouts in one task,
   * dispatched from a scroll handler's rAF.
   *
   * Reading everything first means one flush, then writes only. The results are
   * valid for the whole synchronous pass: nothing scrolls or resizes mid-task.
   */
  private primeViewportNearCache(): void {
    const cache = new Map<string, boolean>();
    for (const [id, panel] of Object.entries(this.state.panels)) {
      const near = panel as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
      cache.set(id, near?.isNearViewport?.(DEFAULT_VIEWPORT_MARGIN_PX) ?? false);
    }
    this.viewportNearCache = cache;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = DEFAULT_VIEWPORT_MARGIN_PX): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
  }

  private shouldRefreshIntelligence(): boolean {
    return this.isAnyPanelNearViewport(['cii', 'strategic-risk', 'strategic-posture'])
      || !!this.state.countryBriefPage?.isVisible();
  }

  private shouldRefreshFirms(): boolean {
    return this.isPanelNearViewport('satellite-fires');
  }

  private shouldRefreshCorrelation(): boolean {
    return this.isAnyPanelNearViewport(['military-correlation', 'escalation-correlation', 'economic-correlation', 'disaster-correlation']);
  }

  private getCachedBootstrapUpdatedAt(): number | null {
    const cachedTierTimestamps = Object.values(this.bootstrapHydrationState.tiers)
      .filter((tier) => tier.source === 'cached')
      .map((tier) => tier.updatedAt)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    if (cachedTierTimestamps.length === 0) return null;
    return Math.min(...cachedTierTimestamps);
  }

  private updateConnectivityUi(): void {
    const statusIndicator = this.state.container.querySelector('.status-indicator');
    const statusLabel = statusIndicator?.querySelector('span:last-child');
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    // Only treat a complete cache fallback (no live data at all) as "cached" for UI purposes.
    // 'mixed' means live data was partially fetched — showing "Live data unavailable" would be misleading.
    const usingCachedBootstrap = this.bootstrapHydrationState.source === 'cached';
    const cachedUpdatedAt = this.getCachedBootstrapUpdatedAt();

    let statusMode: 'live' | 'cached' | 'unavailable' = 'live';
    let bannerMessage: string | null = null;

    if (!online) {
      // Offline: show banner regardless of mixed/cached (any cached data is better than nothing)
      const hasAnyCached = this.bootstrapHydrationState.source === 'cached' || this.bootstrapHydrationState.source === 'mixed';
      if (hasAnyCached) {
        statusMode = 'cached';
        const offlineCachedAt = this.bootstrapHydrationState.tiers
          ? Math.min(...Object.values(this.bootstrapHydrationState.tiers)
              .filter((tier) => tier.source === 'cached' || tier.source === 'mixed')
              .map((tier) => tier.updatedAt)
              .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))
          : NaN;
        const freshness = Number.isFinite(offlineCachedAt) ? describeFreshness(offlineCachedAt) : t('common.cached').toLowerCase();
        bannerMessage = t('connectivity.offlineCached', { freshness });
      } else {
        statusMode = 'unavailable';
        bannerMessage = t('connectivity.offlineUnavailable');
      }
    } else if (usingCachedBootstrap) {
      statusMode = 'cached';
      const freshness = cachedUpdatedAt ? describeFreshness(cachedUpdatedAt) : t('common.cached').toLowerCase();
      bannerMessage = t('connectivity.cachedFallback', { freshness });
    }

    if (statusIndicator && statusLabel) {
      statusIndicator.classList.toggle('status-indicator--cached', statusMode === 'cached');
      statusIndicator.classList.toggle('status-indicator--unavailable', statusMode === 'unavailable');
      statusLabel.textContent = statusMode === 'live'
        ? t('header.live')
        : statusMode === 'cached'
          ? t('header.cached')
          : t('header.unavailable');
    }

    if (bannerMessage) {
      if (!this.cachedModeBannerEl) {
        this.cachedModeBannerEl = document.createElement('div');
        // CSS disables pointer events on this status-only container. Keep its descendants
        // non-interactive unless the banner interaction model is updated with it.
        this.cachedModeBannerEl.className = 'cached-mode-banner';
        this.cachedModeBannerEl.setAttribute('role', 'status');
        this.cachedModeBannerEl.setAttribute('aria-live', 'polite');

        const badge = document.createElement('span');
        badge.className = 'cached-mode-banner__badge';
        const text = document.createElement('span');
        text.className = 'cached-mode-banner__text';
        this.cachedModeBannerEl.append(badge, text);

        const header = this.state.container.querySelector('.header');
        if (header?.parentElement) {
          header.insertAdjacentElement('afterend', this.cachedModeBannerEl);
        } else {
          this.state.container.prepend(this.cachedModeBannerEl);
        }
      }

      this.cachedModeBannerEl.classList.toggle('cached-mode-banner--unavailable', statusMode === 'unavailable');
      const badge = this.cachedModeBannerEl.querySelector('.cached-mode-banner__badge')!;
      const text = this.cachedModeBannerEl.querySelector('.cached-mode-banner__text')!;
      badge.textContent = statusMode === 'cached' ? t('header.cached') : t('header.unavailable');
      text.textContent = bannerMessage;
      return;
    }

    this.cachedModeBannerEl?.remove();
    this.cachedModeBannerEl = null;
  }

  private async primeVisiblePanelData(forceAll = false): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    const now = Date.now();
    const primeTask = (key: string, task: () => Promise<unknown>): void => {
      if (this.visiblePanelPrimed.has(key) || this.state.inFlight.has(key)) return;
      // A failed prime is never recorded as primed, so without this a fast-failing
      // endpoint re-enters on every scroll frame forever (#4487).
      const retryAt = this.visiblePanelPrimeRetryAt.get(key);
      if (retryAt !== undefined && now < retryAt) return;
      const wrapped = (async () => {
        this.state.inFlight.add(key);
        try {
          await task();
          this.visiblePanelPrimed.add(key);
          this.visiblePanelPrimeFailures.delete(key);
          this.visiblePanelPrimeRetryAt.delete(key);
        } catch (err) {
          const failures = (this.visiblePanelPrimeFailures.get(key) ?? 0) + 1;
          this.visiblePanelPrimeFailures.set(key, failures);
          this.visiblePanelPrimeRetryAt.set(key, Date.now() + nextPrimeRetryDelayMs(failures));
          throw err;
        } finally {
          this.state.inFlight.delete(key);
        }
      })();
      tasks.push(wrapped);
    };

    const shouldPrime = (id: string): boolean => forceAll || this.isPanelNearViewport(id);
    const shouldPrimeAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    // Every layout read for this pass happens here, before any gate can enter a
    // loader that writes DOM. `forceAll` skips the gates entirely, so it needs no
    // reads at all.
    if (!forceAll) this.primeViewportNearCache();

    if (shouldPrime('service-status')) {
      const panel = this.state.panels['service-status'] as ServiceStatusPanel | undefined;
      if (panel) primeTask('service-status', () => panel.fetchStatus());
    }
    if (shouldPrime('macro-signals')) {
      const panel = this.state.panels['macro-signals'] as MacroSignalsPanel | undefined;
      if (panel) primeTask('macro-signals', () => panel.fetchData());
    }
    if (shouldPrime('fear-greed')) {
      const panel = this.state.panels['fear-greed'] as FearGreedPanel | undefined;
      if (panel) primeTask('fear-greed', () => panel.fetchData());
    }
    if (shouldPrime('hormuz-tracker')) {
      const panel = this.state.panels['hormuz-tracker'] as HormuzPanel | undefined;
      if (panel) primeTask('hormuz-tracker', () => panel.fetchData());
    }
    if (shouldPrime('etf-flows')) {
      const panel = this.state.panels['etf-flows'] as ETFFlowsPanel | undefined;
      if (panel) primeTask('etf-flows', () => panel.fetchData());
    }
    if (shouldPrime('stablecoins')) {
      const panel = this.state.panels.stablecoins as StablecoinPanel | undefined;
      if (panel) primeTask('stablecoins', () => panel.fetchData());
    }
    if (shouldPrime('energy-crisis')) {
      const panel = this.state.panels['energy-crisis'] as EnergyCrisisPanel | undefined;
      if (panel) primeTask('energy-crisis', () => panel.fetchData());
    }
    if (shouldPrime('telegram-intel')) {
      primeTask('telegram-intel', () => this.dataLoader.loadTelegramIntel());
    }
    if (shouldPrime('gulf-economies')) {
      const panel = this.state.panels['gulf-economies'] as GulfEconomiesPanel | undefined;
      if (panel) primeTask('gulf-economies', () => panel.fetchData());
    }
    if (shouldPrime('grocery-basket')) {
      const panel = this.state.panels['grocery-basket'] as GroceryBasketPanel | undefined;
      if (panel) primeTask('grocery-basket', () => panel.fetchData());
    }
    if (shouldPrime('bigmac')) {
      const panel = this.state.panels['bigmac'] as BigMacPanel | undefined;
      if (panel) primeTask('bigmac', () => panel.fetchData());
    }
    if (shouldPrime('fuel-prices')) {
      const panel = this.state.panels['fuel-prices'] as FuelPricesPanel | undefined;
      if (panel) primeTask('fuel-prices', () => panel.fetchData());
    }
    if (shouldPrime('fx')) {
      const panel = this.state.panels['fx'] as FxPanel | undefined;
      if (panel) primeTask('fx', () => panel.fetchData());
    }
    if (shouldPrime('fao-food-price-index')) {
      const panel = this.state.panels['fao-food-price-index'] as FaoFoodPriceIndexPanel | undefined;
      if (panel) primeTask('fao-food-price-index', () => panel.fetchData());
    }
    if (shouldPrime('oil-inventories')) {
      const panel = this.state.panels['oil-inventories'] as OilInventoriesPanel | undefined;
      if (panel) primeTask('oil-inventories', () => panel.fetchData());
    }
    // Energy Atlas panels — each self-fetches via bootstrap cache + RPC fallback
    // (scripts/seed-pipelines-{gas,oil}.mjs, seed-storage-facilities.mjs,
    // seed-fuel-shortages.mjs, seed-energy-disruptions.mjs). Without these
    // primeTask wires the panels sit at showLoading() forever because
    // Panel's constructor calls showLoading() but nothing else triggers
    // fetchData() on attach — App.ts's primeTask table is the sole
    // near-viewport kickoff path.
    if (shouldPrime('pipeline-status')) {
      const panel = this.state.panels['pipeline-status'] as PipelineStatusPanel | undefined;
      if (panel) primeTask('pipeline-status', () => panel.fetchData());
    }
    if (shouldPrime('storage-facility-map')) {
      const panel = this.state.panels['storage-facility-map'] as StorageFacilityMapPanel | undefined;
      if (panel) primeTask('storage-facility-map', () => panel.fetchData());
    }
    if (shouldPrime('fuel-shortages')) {
      const panel = this.state.panels['fuel-shortages'] as FuelShortagePanel | undefined;
      if (panel) primeTask('fuel-shortages', () => panel.fetchData());
    }
    if (shouldPrime('energy-disruptions')) {
      const panel = this.state.panels['energy-disruptions'] as EnergyDisruptionsPanel | undefined;
      if (panel) primeTask('energy-disruptions', () => panel.fetchData());
    }
    if (shouldPrime('energy-risk-overview')) {
      const panel = this.state.panels['energy-risk-overview'] as EnergyRiskOverviewPanel | undefined;
      if (panel) primeTask('energy-risk-overview', () => panel.fetchData());
    }
    if (shouldPrime('chokepoint-strip')) {
      // Without this primeTask entry the panel mounts via panel-layout.ts and
      // ENERGY_PANELS but its constructor only calls showLoading() — fetchData()
      // never fires, so the panel sits at "Loading..." forever. Hard-learned in
      // PR #3386; tracked as skill panel-stuck-loading-means-missing-primetask.
      const panel = this.state.panels['chokepoint-strip'] as ChokepointStripPanel | undefined;
      if (panel) primeTask('chokepoint-strip', () => panel.fetchData());
    }
    if (shouldPrime('climate-news')) {
      const panel = this.state.panels['climate-news'] as ClimateNewsPanel | undefined;
      if (panel) primeTask('climate-news', () => panel.fetchData());
    }
    if (shouldPrime('consumer-prices')) {
      const panel = this.state.panels['consumer-prices'] as ConsumerPricesPanel | undefined;
      if (panel) primeTask('consumer-prices', () => panel.fetchData());
    }
    if (shouldPrime('defense-patents')) {
      const panel = this.state.panels['defense-patents'] as DefensePatentsPanel | undefined;
      if (panel) primeTask('defense-patents', () => { panel.refresh(); return Promise.resolve(); });
    }
    if (shouldPrime('macro-tiles')) {
      const panel = this.state.panels['macro-tiles'] as MacroTilesPanel | undefined;
      if (panel) primeTask('macro-tiles', () => panel.fetchData());
    }
    if (shouldPrime('fsi')) {
      const panel = this.state.panels['fsi'] as FSIPanel | undefined;
      if (panel) primeTask('fsi', () => panel.fetchData());
    }
    if (shouldPrime('yield-curve')) {
      const panel = this.state.panels['yield-curve'] as YieldCurvePanel | undefined;
      if (panel) primeTask('yield-curve', () => panel.fetchData());
    }
    if (shouldPrime('earnings-calendar')) {
      const panel = this.state.panels['earnings-calendar'] as EarningsCalendarPanel | undefined;
      if (panel) primeTask('earnings-calendar', () => panel.fetchData());
    }
    if (shouldPrime('economic-calendar')) {
      const panel = this.state.panels['economic-calendar'] as EconomicCalendarPanel | undefined;
      if (panel) primeTask('economic-calendar', () => panel.fetchData());
    }
    if (shouldPrime('cot-positioning')) {
      const panel = this.state.panels['cot-positioning'] as CotPositioningPanel | undefined;
      if (panel) primeTask('cot-positioning', () => panel.fetchData());
    }
    if (shouldPrime('liquidity-shifts')) {
      const panel = this.state.panels['liquidity-shifts'] as LiquidityShiftsPanel | undefined;
      if (panel) primeTask('liquidity-shifts', () => panel.fetchData());
    }
    if (shouldPrime('positioning-247')) {
      const panel = this.state.panels['positioning-247'] as PositioningPanel | undefined;
      if (panel) primeTask('positioning-247', () => panel.fetchData());
    }
    if (shouldPrime('gold-intelligence')) {
      const panel = this.state.panels['gold-intelligence'] as GoldIntelligencePanel | undefined;
      if (panel) primeTask('gold-intelligence', () => panel.fetchData());
    }
    if (shouldPrime('aaii-sentiment')) {
      primeTask('aaiiSentiment', () => this.dataLoader.loadAaiiSentiment());
    }
    if (shouldPrime('market-breadth')) {
      primeTask('marketBreadth', () => this.dataLoader.loadMarketBreadth());
    }
    if (shouldPrimeAny(['markets', 'heatmap', 'commodities', 'crypto', 'energy-complex'])) {
      primeTask('markets', () => this.dataLoader.loadMarkets());
    }
    if (shouldPrime('polymarket')) {
      primeTask('predictions', () => this.dataLoader.loadPredictions());
    }
    if (shouldPrime('economic')) {
      primeTask('fred', () => this.dataLoader.loadFredData());
      primeTask('spending', () => this.dataLoader.loadGovernmentSpending());
      primeTask('bis', () => this.dataLoader.loadBisData());
    }
    if (shouldPrime('global-procurement') && hasPremiumAccess()) {
      primeTask('global-tenders', () => this.dataLoader.loadGlobalTenders());
    }
    if (shouldPrime('energy-complex')) {
      primeTask('oil', () => this.dataLoader.loadOilAnalytics());
    }
    // trade-policy moved into the _wmAccess block below — see fix for
    // anonymous 401 bug where loadTradePolicy fired 6 PRO-gated RPCs
    // unconditionally on every page load.
    if (shouldPrime('supply-chain')) {
      primeTask('supplyChain', () => this.dataLoader.loadSupplyChain());
    }
    if (shouldPrime('china-corridors')) {
      primeTask('chinaCorridors', () => this.dataLoader.loadChinaCorridors({ skipIfPopulated: true }));
    }
    if (shouldPrime('china-activity-nowcast')) {
      primeTask('chinaActivityNowcast', () => this.dataLoader.loadChinaActivityNowcast({ skipIfPopulated: true }));
    }
    if (shouldPrime('cross-source-signals')) {
      primeTask('crossSourceSignals', () => this.dataLoader.loadCrossSourceSignals());
    }

    const _wmAccess = hasPremiumAccess();
    if (_wmAccess) {
      if (shouldPrime('trade-policy')) {
        primeTask('tradePolicy', () => this.dataLoader.loadTradePolicy());
      }
      if (shouldPrime('stock-analysis')) {
        primeTask('stockAnalysis', () => this.dataLoader.loadStockAnalysis());
      }
      if (shouldPrime('stock-backtest')) {
        primeTask('stockBacktest', () => this.dataLoader.loadStockBacktest());
      }
      if (shouldPrime('daily-market-brief')) {
        primeTask('dailyMarketBrief', () => this.dataLoader.loadDailyMarketBrief());
      }
      if (shouldPrime('market-implications')) {
        primeTask('marketImplications', () => this.dataLoader.loadMarketImplications());
      }
    }

    // Gates are done; the cached geometry must not outlive the synchronous pass
    // or a later scroll would be gated on a stale rect.
    this.viewportNearCache = null;

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);

    this.uiReady = new Promise<void>((resolve) => {
      this.resolveUiReady = resolve;
    });

    const PANEL_ORDER_KEY = 'panel-order';
    const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';

    const isMobile = isMobileDevice();
    const isDesktopApp = isDesktopRuntime();
    const monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);

    // Use mobile-specific defaults on first load (no saved layers)
    const defaultLayers = isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;

    let mapLayers: MapLayers;
    let panelSettings: Record<string, PanelConfig>;

    // Panels that must survive variant switches: desktop config, user-created widgets, MCP panels.
    const isDynamicPanel = (k: string) => !ALL_PANELS[k] && (k === 'runtime-config' || k.startsWith('cw-') || k.startsWith('mcp-'));

    const currentVariant = SITE_VARIANT;
    let appliedPanelLayoutVariant: string | null = null;
    let storageAvailable = true;
    try {
      appliedPanelLayoutVariant = resolveAppliedPanelLayoutVariant({
        appliedVariant: localStorage.getItem(STORAGE_KEYS.panelLayoutVariant),
        legacyVariant: localStorage.getItem(STORAGE_KEYS.variant),
        currentVariant,
        validVariants: new Set(Object.keys(VARIANT_DEFAULTS)),
        persistAppliedVariant: (variant) => {
          localStorage.setItem(STORAGE_KEYS.panelLayoutVariant, variant);
          return true;
        },
      });
      const probeKey = 'wm-storage-capability-probe';
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
    } catch {
      storageAvailable = false;
    }

    // Blocked storage is a supported no-persistence mode. Seed the same
    // defaults as a first visit and skip migrations that only mutate storage.
    if (!storageAvailable) {
      mapLayers = normalizeExclusiveChoropleths(
        sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant), null,
      );
      panelSettings = { ...DEFAULT_PANELS };
    } else if (appliedPanelLayoutVariant !== currentVariant) {
      // Variant changed - reset all settings to variant defaults.
      console.log(`[App] Variant check: applied="${appliedPanelLayoutVariant}", current="${currentVariant}"`);
      // Variant changed — seed new variant's panels, disable panels not in the new variant
      console.log('[App] Variant changed - seeding new defaults, disabling cross-variant panels');
      // Reset map layers for the new variant (map layers are not user-personalized the same way)
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      // Write an explicit empty set rather than removing the key: cloud sync
      // now tolerates an ABSENT ownership sidecar (a row that predates it must
      // not delete local ownership), so a genuine variant-reset clear only
      // propagates cross-device when it is an explicit value.
      localStorage.setItem(STORAGE_KEYS.mapLayerGateOwnership, '[]');
      mapLayers = normalizeExclusiveChoropleths(
        sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant), null,
      );
      // Load existing panel prefs (if any), disable panels not belonging to the new variant
      const newVariantKeys = new Set(VARIANT_DEFAULTS[currentVariant] ?? []);
      panelSettings = applyVariantPanelLayoutTransition({
        currentVariant,
        panelSettings: loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {}),
        variantPanelKeys: newVariantKeys,
        isDynamicPanel,
        getDefaultPanel: (key) => getEffectivePanelConfig(key, currentVariant),
        // Use the throwing primitive here so the transition helper advances
        // the applied-layout marker only after the panel blob is durable.
        persistPanels: (next) => localStorage.setItem(STORAGE_KEYS.panels, JSON.stringify(next)),
        persistAppliedVariant: (variant) => {
          // Both markers advance HERE, inside the helper's success path, and
          // never after a failed panel write. Advancing the legacy key
          // unconditionally used to erase the retry: on the next boot
          // resolveAppliedPanelLayoutVariant would see a null applied marker
          // beside a legacy key already equal to the current variant, take its
          // SEEDING branch, and silently record the failed reset as applied.
          //
          // Order is load-bearing: the legacy key (read by bootstrap/theme and
          // by SITE_VARIANT on desktop) goes first, and the applied-layout
          // marker — the "this layout is durable" flag — goes last.
          localStorage.setItem(STORAGE_KEYS.variant, variant);
          localStorage.setItem(STORAGE_KEYS.panelLayoutVariant, variant);
        },
      });
    } else {
      mapLayers = normalizeExclusiveChoropleths(
        sanitizeLayersForVariant(
          loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers),
          currentVariant as MapVariant,
        ), null,
      );
      // #6045 — heal stuck locked layers from pre-gate localStorage once free
      // tier is settled. Do not run while Pro status is still resolving.
      // Persist immediately so dirty storage doesn't reintroduce the layer.
      mapLayers = this.sanitizeMapLayersForTier(mapLayers);
      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );

      // One-time migration: preserve user preferences across panel key renames.
      const PANEL_KEY_RENAMES_MIGRATION_KEY = 'worldmonitor-panel-key-renames-v2.6.8';
      if (!localStorage.getItem(PANEL_KEY_RENAMES_MIGRATION_KEY)) {
        let migrated = false;
        const keyRenames: Array<[string, string]> = [
          ['live-youtube', 'live-webcams'],
          ['pinned-webcams', 'windy-webcams'],
          ...(SITE_VARIANT === 'finance' ? [['regulation', 'fin-regulation'] as [string, string]] : []),
        ];
        // In non-finance variants, 'regulation' was dead config (no feeds). Just prune it.
        if (SITE_VARIANT !== 'finance' && panelSettings['regulation']) {
          delete panelSettings['regulation'];
          migrated = true;
        }
        for (const [legacyKey, nextKey] of keyRenames) {
          if (!panelSettings[legacyKey] || panelSettings[nextKey]) continue;
          panelSettings[nextKey] = {
            ...DEFAULT_PANELS[nextKey],
            ...panelSettings[legacyKey],
            name: DEFAULT_PANELS[nextKey]?.name ?? panelSettings[legacyKey].name,
          };
          delete panelSettings[legacyKey];
          migrated = true;
        }
        // Also migrate saved panel order/bottom-set entries for renamed keys
        for (const [legacyKey, nextKey] of keyRenames) {
          for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
            try {
              const raw = localStorage.getItem(orderKey);
              if (!raw) continue;
              const arr = JSON.parse(raw);
              if (!Array.isArray(arr)) continue;
              const idx = arr.indexOf(legacyKey);
              if (idx !== -1) { arr[idx] = nextKey; localStorage.setItem(orderKey, JSON.stringify(arr)); migrated = true; }
            } catch { /* corrupt storage, skip */ }
          }
        }
        if (migrated) saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(PANEL_KEY_RENAMES_MIGRATION_KEY, 'done');
      }

      // Merge in any panels from ALL_PANELS that didn't exist when settings were saved
      for (const key of Object.keys(ALL_PANELS)) {
        if (!(key in panelSettings)) {
          const config = getEffectivePanelConfig(key, SITE_VARIANT);
          const isInVariant = (VARIANT_DEFAULTS[SITE_VARIANT] ?? []).includes(key);
          panelSettings[key] = { ...config, enabled: isInVariant && config.enabled };
        }
      }

      // One-time migration: expose all panels to existing users (previously variant-gated)
      const UNIFIED_MIGRATION_KEY = 'worldmonitor-unified-panels-v1';
      if (!localStorage.getItem(UNIFIED_MIGRATION_KEY)) {
        const variantDefaults = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);
        for (const key of Object.keys(ALL_PANELS)) {
          if (!(key in panelSettings)) {
            const config = getEffectivePanelConfig(key, SITE_VARIANT);
            panelSettings[key] = { ...config, enabled: variantDefaults.has(key) && config.enabled };
          }
        }
        saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(UNIFIED_MIGRATION_KEY, 'done');
      }

      // One-time migration: fix happy variant sessions that got cross-variant panels enabled
      // (regression from #1911 unified panel registry which failed to disable non-variant panels on variant switch)
      const HAPPY_PANEL_FIX_KEY = 'worldmonitor-happy-panel-fix-v1';
      if (SITE_VARIANT === 'happy' && !localStorage.getItem(HAPPY_PANEL_FIX_KEY)) {
        const happyKeys = new Set(VARIANT_DEFAULTS['happy'] ?? []);
        let fixed = false;
        for (const key of Object.keys(panelSettings)) {
          const config = panelSettings[key];
          if (
            !happyKeys.has(key)
            && !isDynamicPanel(key)
            && config
            && (config.enabled || config.proGated)
          ) {
            userSetPanelEnabled(config, false);
            fixed = true;
          }
        }
        if (fixed) saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(HAPPY_PANEL_FIX_KEY, 'done');
      }

      console.log('[App] Loaded panel settings from storage:', Object.entries(panelSettings).filter(([_, v]) => !v.enabled).map(([k]) => k));

      // One-time migration: reorder panels for existing users (v1.9 panel layout)
      const PANEL_ORDER_MIGRATION_KEY = 'worldmonitor-panel-order-v1.9';
      if (!localStorage.getItem(PANEL_ORDER_MIGRATION_KEY)) {
        const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
        if (savedOrder) {
          try {
            const order: string[] = JSON.parse(savedOrder);
            const priorityPanels = ['insights', 'strategic-posture', 'cii', 'strategic-risk'];
            const filtered = order.filter(k => !priorityPanels.includes(k) && k !== 'live-news');
            const liveNewsIdx = order.indexOf('live-news');
            const newOrder = liveNewsIdx !== -1 ? ['live-news'] : [];
            newOrder.push(...priorityPanels.filter(p => order.includes(p)));
            newOrder.push(...filtered);
            localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
            console.log('[App] Migrated panel order to v1.9 layout');
          } catch {
            // Invalid saved order, will use defaults
          }
        }
        localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
      }

      // Tech variant migration: move insights to top (after live-news)
      if (currentVariant === 'tech') {
        const TECH_INSIGHTS_MIGRATION_KEY = 'worldmonitor-tech-insights-top-v1';
        if (!localStorage.getItem(TECH_INSIGHTS_MIGRATION_KEY)) {
          const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
          if (savedOrder) {
            try {
              const order: string[] = JSON.parse(savedOrder);
              const filtered = order.filter(k => k !== 'insights' && k !== 'live-news');
              const newOrder: string[] = [];
              if (order.includes('live-news')) newOrder.push('live-news');
              if (order.includes('insights')) newOrder.push('insights');
              newOrder.push(...filtered);
              localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
              console.log('[App] Tech variant: Migrated insights panel to top');
            } catch {
              // Invalid saved order, will use defaults
            }
          }
          localStorage.setItem(TECH_INSIGHTS_MIGRATION_KEY, 'done');
        }
      }
    }

    if (storageAvailable) {
      // One-time migration: prune removed panel keys from stored settings and order
      const PANEL_PRUNE_KEY = 'worldmonitor-panel-prune-v1';
      if (!localStorage.getItem(PANEL_PRUNE_KEY)) {
        const validKeys = new Set(Object.keys(ALL_PANELS));
        let pruned = false;
        for (const key of Object.keys(panelSettings)) {
          if (!validKeys.has(key) && key !== 'runtime-config') {
            delete panelSettings[key];
            pruned = true;
          }
        }
        if (pruned) saveToStorage(STORAGE_KEYS.panels, panelSettings);
        for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
          try {
            const raw = localStorage.getItem(orderKey);
            if (!raw) continue;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) continue;
            const filtered = arr.filter((k: string) => validKeys.has(k));
            if (filtered.length !== arr.length) localStorage.setItem(orderKey, JSON.stringify(filtered));
          } catch { localStorage.removeItem(orderKey); }
        }
        localStorage.setItem(PANEL_PRUNE_KEY, 'done');
      }

      // One-time migration: clear stale panel ordering and sizing state
      const LAYOUT_RESET_MIGRATION_KEY = 'worldmonitor-layout-reset-v2.5';
      if (!localStorage.getItem(LAYOUT_RESET_MIGRATION_KEY)) {
        const hadSavedOrder = !!localStorage.getItem(PANEL_ORDER_KEY);
        const hadSavedSpans = !!localStorage.getItem(PANEL_SPANS_KEY);
        if (hadSavedOrder || hadSavedSpans) {
          localStorage.removeItem(PANEL_ORDER_KEY);
          localStorage.removeItem(PANEL_ORDER_KEY + '-bottom');
          localStorage.removeItem(PANEL_ORDER_KEY + '-bottom-set');
          clearPanelSpans();
          console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
        }
        localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
      }
    }

    // Desktop key management panel must always remain accessible in Tauri.
    if (isDesktopApp) {
      if (!panelSettings['runtime-config'] || !panelSettings['runtime-config'].enabled) {
        panelSettings['runtime-config'] = {
          ...panelSettings['runtime-config'],
          name: panelSettings['runtime-config']?.name ?? 'Desktop Configuration',
          enabled: true,
          priority: panelSettings['runtime-config']?.priority ?? 2,
        };
        saveToStorage(STORAGE_KEYS.panels, panelSettings);
      }
    }

    const initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      mapLayers = normalizeExclusiveChoropleths(
        sanitizeLayersForVariant(initialUrlState.layers, currentVariant as MapVariant), null,
      );
      // #6045 — URL layer deep-links also cannot force locked layers on for free users.
      // Ephemeral: the link is a view, so it must not overwrite the stored
      // preference or touch gate ownership in either direction.
      mapLayers = this.sanitizeMapLayersForTier(mapLayers, undefined, { ephemeralSnapshot: true });
      initialUrlState.layers = mapLayers;
    }
    if (!CYBER_LAYER_ENABLED) {
      mapLayers.cyberThreats = false;
    }
    // One-time migration: reduce default-enabled sources (full variant only)
    if (currentVariant === 'full' && storageAvailable) {
      const baseKey = 'worldmonitor-sources-reduction-v3';
      if (!localStorage.getItem(baseKey)) {
        const defaultDisabled = computeDefaultDisabledSources();
        saveToStorage(STORAGE_KEYS.disabledFeeds, defaultDisabled);
        localStorage.setItem(baseKey, 'done');
        const total = getTotalFeedCount();
        console.log(`[App] Sources reduction: ${defaultDisabled.length} disabled, ${total - defaultDisabled.length} enabled`);
      }
      const userLang = this.currentSourceCapLanguage();
      // #5949 — re-enable Ukraine/Poland frontline sources for profiles that
      // still have the untouched pre-#5949 default disabled set. An exact-set
      // guard is important here: a customized disabledFeeds set is user
      // intent, and must not be rewritten by the startup migration.
      const frontlineKey = 'worldmonitor-frontline-europe-enable-v1';
      if (!localStorage.getItem(frontlineKey)) {
        const frontline = new Set<string>(FRONTLINE_EUROPE_PROTECTED_SOURCES);
        const legacyDefaultDisabled = new Set(computeLegacyDefaultDisabledSources());
        const legacyCapDisabled = computeCapDisabledSources(
          FEEDS,
          INTEL_SOURCES,
          new Set(computeDefaultDisabledSources()),
          FREE_MAX_SOURCES,
        );
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateFrontlineEuropeDefaultsV3(
          { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current) },
          legacyDefaultDisabled,
          frontline,
          legacyCapDisabled,
        );
        const updated = JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[];
        if (updated.length !== current.length) {
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(
            `[App] Frontline Europe enable (#5949): re-enabled ${current.length - updated.length} source(s)`,
          );
        }
        localStorage.setItem(frontlineKey, 'done');
      }
      // #6000 — re-enable strategic defaults for profiles created before the
      // flag became part of the canonical default set. An exact-set guard is
      // required: a customized disabledFeeds set is user intent and must not
      // be rewritten by a startup migration.
      const strategicKey = 'worldmonitor-strategic-defaults-enable-v1';
      if (!localStorage.getItem(strategicKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateStrategicDefaultsV4(
          { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current) },
          new Set(),
          getStrategicDefaultSources(),
          new Set(),
          buildPreStrategicDefaultDisabledStates(FREE_MAX_SOURCES, userLang),
        );
        const updated = JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[];
        if (updated.length !== current.length) {
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(
            `[App] Strategic defaults enable (#6000): re-enabled ${current.length - updated.length} source(s)`,
          );
        }
        localStorage.setItem(strategicKey, 'done');
      }
      // #5975/#5976/#5977/#5980 — reconcile the regional feed wave for
      // returning denylist profiles. Exact historical default/cap states are
      // the only eligible inputs; any source customization skips the migration.
      const regionalRolloutKey = 'worldmonitor-regional-feed-rollout-reconcile-v1';
      if (!localStorage.getItem(regionalRolloutKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateRegionalFeedRolloutDefaultsV5(
          { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current) },
          buildRegionalFeedRolloutMigrationTargets(FREE_MAX_SOURCES, userLang),
        );
        const updated = JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[];
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log('[App] Regional feed rollout: restored declared defaults and opt-in boundaries for an untouched profile');
        }
        localStorage.setItem(regionalRolloutKey, 'done');
      }
      // #5960 — Canada + Arctic/Nordic pack: denylist is additive-only, so newly
      // cataloged opt-in names would be implicitly enabled for every returner.
      // Insert opt-ins into any existing denylist once. CBC is intentionally
      // omitted so default-on can enable it for returners (not in old denylist).
      const canadaArcticKey = 'worldmonitor-canada-arctic-optin-v1';
      if (!localStorage.getItem(canadaArcticKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateCanadaArcticOptInsV6({
          [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current),
        }, CANADA_ARCTIC_OPT_IN_SOURCES);
        const rawUpdated = migrated[STORAGE_KEYS.disabledFeeds];
        if (typeof rawUpdated === 'string') {
          let updated: unknown;
          try { updated = JSON.parse(rawUpdated); } catch { updated = null; }
          if (
            Array.isArray(updated)
            && updated.every((name): name is string => typeof name === 'string')
            && JSON.stringify(updated) !== JSON.stringify(current)
          ) {
            saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
            console.log(
              `[App] Canada/Arctic opt-in (#5960): disabled ${updated.length - current.length} newly cataloged source(s)`,
            );
          }
        }
        localStorage.setItem(canadaArcticKey, 'done');
      }
      // Locale boost: additively enable locale-matched sources (runs once per locale).
      // Reads the explicit-choice key (`wm-locale-explicit`, written by Settings →
      // Language) before falling back to navigator. Mirrors the i18n.ts:99
      // `wmExplicit` detector — without this, a user whose browser is en-US who
      // picks Magyar in Settings never gets the locale boost (the migration's
      // first run with `userLang='en'` sets `worldmonitor-locale-boost-en` and
      // the `userLang !== 'en'` short-circuit means the boost block never re-fires
      // for any subsequent locale choice). Direct localStorage read because
      // i18next isn't initialized yet here in the constructor — `initI18n()` is
      // called later inside `init()`.
      const localeKey = `worldmonitor-locale-boost-${userLang}`;
      if (userLang !== 'en' && !localStorage.getItem(localeKey)) {
        const boosted = getLocaleBoostedSources(userLang);
        if (boosted.size > 0) {
          const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
          const updated = current.filter(name => !boosted.has(name));
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(`[App] Locale boost (${userLang}): enabled ${current.length - updated.length} sources`);
        }
        localStorage.setItem(localeKey, 'done');
      }
    }

    const disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));

    // Build shared state object
    this.state = {
      map: null,
      isMobile,
      isDesktopApp,
      container: el,
      panels: {},
      newsPanels: {},
      newsCategoryPanelKeys: new Map(),
      panelSettings,
      mapLayers,
      allNews: [],
      newsByCategory: {},
      latestMarkets: [],
      latestPredictions: [],
      latestTechEvents: [],
      latestClusters: [],
      intelligenceCache: {},
      cyberThreatsCache: null,
      disabledSources,
      currentTimeRange: '7d',
      inFlight: new Set(),
      seenGeoAlerts: new Set(),
      monitors,
      signalModal: null,
      ensureSignalModal: () => this.ensureSignalModal(),
      statusPanel: null,
      searchModal: null,
      findingsBadge: null,
      breakingBanner: null,
      playbackControl: null,
      exportPanel: null,
      unifiedSettings: null,
      pizzintIndicator: null,
      correlationEngine: null,
      llmStatusIndicator: null,
      countryBriefPage: null,
      countryTimeline: null,
      positivePanel: null,
      countersPanel: null,
      progressPanel: null,
      breakthroughsPanel: null,
      heroPanel: null,
      digestPanel: null,
      speciesPanel: null,
      renewablePanel: null,
      authModal: null,
      authHeaderWidget: null,
      tvMode: null,
      happyAllItems: [],
      isDestroyed: false,
      isPlaybackMode: false,
      isIdle: false,
      initialLoadComplete: false,
      clustersSettled: false,
      resolvedLocation: 'global',
      activeChokepoint: initialUrlState.chokepoint ?? null,
      initialUrlState,
      PANEL_ORDER_KEY,
      PANEL_SPANS_KEY,
    };

    // Instantiate modules (callbacks wired after all modules exist)
    this.refreshScheduler = new RefreshScheduler(this.state);
    this.countryIntel = new CountryIntelManager(this.state);
    this.desktopUpdater = new DesktopUpdater(this.state);

    this.dataLoader = new DataLoaderManager(this.state, {
      renderCriticalBanner: (postures) => this.panelLayout.renderCriticalBanner(postures),
      refreshOpenCountryBrief: () => this.countryIntel.refreshOpenBrief(),
    });

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: (code, name) => {
        void this.countryIntel.openCountryStory(code, name).catch((err) => {
          console.error('[CountryStory] Failed to open story:', err);
          showToast('Country story failed to open. Please try again.');
        });
      },
      openCountryBrief: (code) => {
        const name = CountryIntelManager.resolveCountryName(code);
        void this.countryIntel.openCountryBriefByCode(code, name).catch((err) => {
          console.error('[CountryBrief] Failed to open country brief:', err);
          this.state.map?.setRenderPaused(false);
          showToast('Country brief failed to open. Please try again.');
        });
      },
      openSearch: () => {
        track('search-open', { source: 'pro-onboarding' });
        void this.openSearch();
      },
      loadAllData: () => this.dataLoader.loadAllData(),
      primeVisiblePanelData: () => {
        if (!this.viewportHydrationReady || this.state.isDestroyed) return;
        void this.primeVisiblePanelData();
      },
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      loadSecurityAdvisories: () => this.dataLoader.loadSecurityAdvisories(),
      applyMapLayerChange: (layer, enabled, source) => this.eventHandlers.applyMapLayerChange(layer, enabled, source),
      isFreeTierFallbackActive: () => this.freeTierGate.authSettleDeadlineExceeded,
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      openSearch: (options) => { void this.openSearch(options); },
      updateSearchIndex: () => this.updateSearchIndexIfReady(),
      loadAllData: () => this.dataLoader.loadAllData(),
      invalidateNewsHydration: () => this.dataLoader.invalidateNewsHydration(),
      flushStaleRefreshes: () => this.refreshScheduler.flushStaleRefreshes(),
      setHiddenSince: (ts) => this.refreshScheduler.setHiddenSince(ts),
      loadDataForLayer: (layer) => { void this.dataLoader.loadDataForLayer(layer as keyof MapLayers); },
      waitForAisData: () => this.dataLoader.waitForAisData(),
      syncDataFreshnessWithLayers: () => this.dataLoader.syncDataFreshnessWithLayers(),
      applyPanelSettings: () => this.panelLayout.applyPanelSettings(),
      applySavedPanelOrder: (panelOrder?: string[]) => this.panelLayout.applySavedPanelOrder(panelOrder),
      stopLayerActivity: (layer) => this.dataLoader.stopLayerActivity(layer),
      mountLiveNewsIfReady: () => this.panelLayout.mountLiveNewsIfReady(),
      updateFlightSource: (adsb, military) => this.updateFlightSourceIfReady(adsb, military),
      isFreeTierFallbackActive: () => this.freeTierGate.authSettleDeadlineExceeded,
    });

    // Wire cross-module callback: DataLoader → SearchManager
    this.dataLoader.updateSearchIndex = () => this.updateSearchIndexIfReady();

    // Track destroy order (reverse of init)
    this.modules = [
      this.desktopUpdater,
      this.panelLayout,
      this.countryIntel,
      this.dataLoader,
      this.refreshScheduler,
      this.eventHandlers,
    ];
  }

  private ensureSignalModal(): Promise<SignalModalInstance> {
    if (this.state.signalModal) return Promise.resolve(this.state.signalModal);
    if (this.signalModalLoad) return this.signalModalLoad;

    this.signalModalLoad = import('@/components/SignalModal')
      .then(({ SignalModal }) => {
        if (this.state.isDestroyed) {
          throw new Error('App destroyed before signal modal loaded');
        }
        const signalModal = new SignalModal();
        signalModal.setLocationClickHandler((lat, lon) => {
          this.state.map?.setCenter(lat, lon, 4);
        });
        this.state.signalModal = signalModal;
        return signalModal;
      })
      .catch((err) => {
        this.signalModalLoad = null;
        throw err;
      });

    return this.signalModalLoad;
  }

  private ensureSearchManager(): Promise<SearchManager> {
    if (this.searchManager) return Promise.resolve(this.searchManager);
    if (this.searchManagerLoad) return this.searchManagerLoad;

    this.searchManagerLoad = import('@/app/search-manager')
      .then(({ SearchManager }) => {
        if (this.state.isDestroyed) {
          throw new Error('App destroyed before search manager loaded');
        }

        const manager = new SearchManager(this.state, {
          openCountryBriefByCode: (code, country) => {
            void this.countryIntel.openCountryBriefByCode(code, country).catch((err) => {
              console.error('[CountryBrief] Failed to open country brief:', err);
              this.state.map?.setRenderPaused(false);
              showToast('Country brief failed to open. Please try again.');
            });
          },
          enablePanel: (panelId) => this.eventHandlers.enablePanelById(panelId),
        });
        manager.init();
        manager.updateFlightSource(this.latestSearchAdsb, this.latestSearchMilitary);
        this.searchManager = manager;
        this.modules.push(manager);
        return manager;
      })
      .finally(() => {
        this.searchManagerLoad = null;
      });

    return this.searchManagerLoad;
  }

  private updateSearchIndexIfReady(): void {
    this.searchManager?.updateSearchIndex();
  }

  private updateFlightSourceIfReady(
    adsb: Parameters<SearchManager['updateFlightSource']>[0],
    military: Parameters<SearchManager['updateFlightSource']>[1],
  ): void {
    this.latestSearchAdsb = adsb;
    this.latestSearchMilitary = military;
    this.searchManager?.updateFlightSource(adsb, military);
  }

  private async openSearch(options: { toggle?: boolean; throwOnFailure?: boolean; replaceOverlayId?: OverlayId; historyPending?: boolean } = {}): Promise<void> {
    // Concurrency model: each press registers its intent, then claims a
    // monotonic epoch. After the lazy load resolves, only the latest epoch acts
    // — superseded presses bail. This yields one deterministic modal.open() for
    // any Cmd+K / button interleaving during the first load (replacing the prior
    // two-field pending-toggle bookkeeping), while preserving net-toggle parity:
    // the XOR flip happens BEFORE the epoch claim so every rapid Cmd+K still
    // counts (odd → open, even → cancel), even the ones that get superseded.
    let epoch = this.openSearchEpoch;
    const pendingId: OverlayId = 'search-pending';
    const pendingGate = options.historyPending
      ? overlayHistory.beginPending(pendingId, options.replaceOverlayId, () => {
          this.searchToggleDesiredOpen = false;
        })
      : null;
    try {
      await this.waitForUiReady();
      if (pendingGate && !pendingGate.isCurrent()) return;

      const existingModal = this.state.searchModal;
      if (options.toggle && existingModal?.isOpen()) {
        existingModal.close();
        return;
      }

      const togglingBeforeLoad = Boolean(options.toggle) && !this.searchManager;
      if (togglingBeforeLoad) {
        this.searchToggleDesiredOpen = !this.searchToggleDesiredOpen;
      }

      epoch = ++this.openSearchEpoch;
      const manager = await this.ensureSearchManager();
      if (this.openSearchEpoch !== epoch) return;
      if (pendingGate && !pendingGate.isCurrent()) return;

      const wantOpen = togglingBeforeLoad ? this.searchToggleDesiredOpen : true;
      if (!wantOpen) return;

      manager.updateSearchIndex();
      const modal = this.state.searchModal;
      if (!modal) throw new Error('Search modal is not initialised');
      modal.open(pendingGate ? pendingId : options.replaceOverlayId);
    } catch (error) {
      const actionWasCancelled = pendingGate !== null && !pendingGate.isCurrent();
      if (!this.state.isDestroyed && !actionWasCancelled) {
        console.warn('[search] Failed to load search manager:', error);
        if (!options.throwOnFailure) showToast('Search failed to load. Please try again.');
      }
      pendingGate?.cancel();
      if (options.throwOnFailure) throw error;
    } finally {
      // Reset the toggle accumulator once the latest press settles.
      if (this.openSearchEpoch === epoch) this.searchToggleDesiredOpen = false;
    }
  }

  private async waitForSlowBootstrapCheckpoint(): Promise<void> {
    markLcpDebug('wm:data:slow-tier-wait-start');
    try {
      const settled = await waitForBootstrapSlowTier(isDesktopRuntime() ? 8_500 : 3_500);
      markLcpDebug('wm:data:slow-tier-wait-end', { settled });
      if (this.state.isDestroyed) return;
      this.bootstrapHydrationState = getBootstrapHydrationState();
      this.updateConnectivityUi();
    } catch {
      markLcpDebug('wm:data:slow-tier-wait-error');
    }
  }

  private async preloadCountryGeometryForPostLcpWork(): Promise<void> {
    markLcpDebug('wm:data:country-geometry-start');
    try {
      await preloadCountryGeometry();
      markLcpDebug('wm:data:country-geometry-ready');
    } catch {
      markLcpDebug('wm:data:country-geometry-error');
    }
  }

  private startPostLcpIntelligence(countryGeometryReady: Promise<void>, geometryAlreadyApplied: boolean): void {
    void countryGeometryReady.finally(() => {
      if (this.state.isDestroyed) return;
      // Replay geometry-dependent country-detail data only when the fan-out ingested before
      // precision geometry was ready; otherwise the first-pass attribution is
      // already correct and a replay is a redundant compute + repaint (#4512).
      if (!geometryAlreadyApplied) {
        this.dataLoader.refreshGeometryDependentCountryData();
      }
      // Correlation and country-learning use precision geometry/name matching,
      // but they are post-initial-data work and should not hold the LCP path.
      void this.loadInitialCorrelationEngine();
      startLearning();
    });
  }

  private async loadInitialCorrelationEngine(): Promise<void> {
    try {
      const {
        CorrelationEngine,
        militaryAdapter,
        escalationAdapter,
        economicAdapter,
        disasterAdapter,
      } = await import('@/services/correlation-engine');

      if (this.state.isDestroyed) return;
      const engine = new CorrelationEngine();
      engine.registerAdapter(militaryAdapter);
      engine.registerAdapter(escalationAdapter);
      engine.registerAdapter(economicAdapter);
      engine.registerAdapter(disasterAdapter);
      this.state.correlationEngine = engine;

      await this.runCorrelationEngine();
    } catch (error) {
      console.warn('[CorrelationEngine] Initial lazy load/run failed:', error);
    }
  }

  private async runCorrelationEngine(): Promise<void> {
    const engine = this.state.correlationEngine;
    if (!engine || this.state.isDestroyed) return;

    const { fetchCorrelationRuntimeMode } = await import('@/services/correlation-runtime-mode');
    const runtimeMode = await fetchCorrelationRuntimeMode();
    if (this.state.isDestroyed) return;

    // run() reports false when it skipped because a run was already in flight.
    // Not reachable today (run() never yields), but this diff put two awaits in
    // front of it, so honour the contract rather than publishing getCards() —
    // which on a first-run overlap would write empty cards into live panels.
    const didRun = await engine.run(this.state, runtimeMode);
    if (!didRun || this.state.isDestroyed) return;
    for (const domain of ['military', 'escalation', 'economic', 'disaster'] as const) {
      const panel = this.state.panels[`${domain}-correlation`] as CorrelationPanel | undefined;
      panel?.updateCards(engine.getCards(domain));
    }
  }

  public async init(): Promise<void> {
    const initStart = performance.now();
    markLcpDebug('wm:boot:app-init-start');

    // WebMCP — register synchronously before any init awaits so agent
    // scanners (isitagentready.com, in-browser agents) find the tools on
    // their first probe. No-op in browsers without document.modelContext.
    // Bindings await `this.uiReady` (resolves after Phase-4 UI init) so
    // a tool invoked during the startup window waits for the target
    // panel to exist instead of throwing. A 10s timeout keeps a genuinely
    // broken state from hanging the caller. Store the returned controller
    // so destroy() can unregister every tool on teardown.
    this.webMcpController = registerWebMcpTools({
      openCountryBriefByCode: async (code, country) => {
        await this.waitForUiReady();
        if (!this.state.countryBriefPage) {
          throw new Error('Country brief panel is not initialised');
        }
        await this.countryIntel.openCountryBriefByCode(code, country);
      },
      resolveCountryName: (code) => CountryIntelManager.resolveCountryName(code),
      openSearch: async () => {
        // openSearch() awaits UI readiness internally and throws on failure when
        // throwOnFailure is set, so the agent receives a real success/failure.
        // (Re-checking searchModal here would spuriously throw if a concurrent
        // Cmd+K closed it between open and the check — #4403 review ADV-4.)
        await this.openSearch({ throwOnFailure: true });
      },
    });

    window.addEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleI18nResourcesLoaded);

    await initDB();
    startFlightHistoryCleanup();
    // Re-arm the lazy vessel runtime (a no-op on first boot; matters on a
    // same-document re-init after a prior App.destroy() disarmed it). The
    // history-cleanup interval itself still starts lazily on first vessel use.
    enableVesselRuntime();
    await initI18n();
    markLcpDebug('wm:boot:i18n-ready');
    initDeferredDashboardFonts();
    // Localize the static index.html shell — <title>, meta description, and
    // the accessible <h1> are baked in English before the app boots; once i18n
    // is ready we swap them to the user's locale.
    document.title = t('shell.documentTitle');
    const setMeta = (sel: string, val: string) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('content', val);
    };
    setMeta('meta[name="description"]', t('shell.metaDescription'));
    setMeta('meta[property="og:title"]', t('shell.documentTitle'));
    setMeta('meta[property="og:description"]', t('shell.metaDescription'));
    setMeta('meta[name="twitter:title"]', t('shell.documentTitle'));
    setMeta('meta[name="twitter:description"]', t('shell.metaDescription'));
    // Mirror of OG_LOCALE in pro-test/src/i18n.ts. The two packages have
    // separate Vite roots and bundlers and can't share an import — keep the
    // tables aligned by hand when adding a locale here OR there.
    const ogLocaleMap: Record<string, string> = {
      en: 'en_US', bg: 'bg_BG', cs: 'cs_CZ', fr: 'fr_FR', de: 'de_DE', el: 'el_GR',
      es: 'es_ES', hr: 'hr_HR', hu: 'hu_HU', it: 'it_IT', pl: 'pl_PL', pt: 'pt_BR',
      nl: 'nl_NL', sv: 'sv_SE', ru: 'ru_RU', uk: 'uk_UA', ar: 'ar_SA', fa: 'fa_IR', zh: 'zh_CN',
      ja: 'ja_JP', ko: 'ko_KR', ro: 'ro_RO', tr: 'tr_TR', th: 'th_TH', vi: 'vi_VN',
      hi: 'hi_IN',
    };
    const baseLang = (document.documentElement.lang || 'en').split('-')[0] || 'en';
    setMeta('meta[property="og:locale"]', ogLocaleMap[baseLang] || `${baseLang}_${baseLang.toUpperCase()}`);
    const srH1 = document.querySelector('body > h1');
    if (srH1) srH1.textContent = t('shell.documentTitle');
    const aiFlow = getAiFlowSettings();
    if (aiFlow.browserModel || isDesktopRuntime()) {
      await mlWorker.init();
      if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => { });
    }

    // Headline Memory requires Browser Local Model to be ON — `isHeadlineMemoryEnabled()`
    // ANDs both flags. Without this gate, leaving Headline Memory on while turning
    // Browser Local Model off would silently download/run an embeddings model the user
    // opted out of via the parent toggle.
    if (isHeadlineMemoryEnabled()) {
      mlWorker.init().then(ok => {
        if (ok) mlWorker.loadModel('embeddings').catch(() => { });
      }).catch(() => { });
    }

    this.unsubAiFlow = subscribeAiFlowChange((key) => {
      if (key === 'browserModel') {
        const s = getAiFlowSettings();
        if (s.browserModel) {
          mlWorker.init().then(ok => {
            // Re-honor Headline Memory's persisted value on parent re-enable.
            if (ok && isHeadlineMemoryEnabled()) {
              mlWorker.loadModel('embeddings').catch(() => { });
            }
          }).catch(() => { });
        } else if (!isDesktopRuntime()) {
          // Browser Local Model is the parent toggle for ALL local-model use,
          // including Headline Memory. Terminate unconditionally on web —
          // any persisted Headline Memory value is now non-effective.
          mlWorker.terminate();
        }
      }
      if (key === 'headlineMemory') {
        if (isHeadlineMemoryEnabled()) {
          mlWorker.init().then(ok => {
            if (ok) mlWorker.loadModel('embeddings').catch(() => { });
          }).catch(() => { });
        } else {
          mlWorker.unloadModel('embeddings').catch(() => { });
          const s = getAiFlowSettings();
          if (!s.browserModel && !isDesktopRuntime()) {
            mlWorker.terminate();
          }
        }
      }
    });

    // Check AIS configuration before init
    if (!isAisConfigured()) {
      this.state.mapLayers.ais = false;
    } else if (this.state.mapLayers.ais) {
      initAisStream();
    }

    // Wait for sidecar readiness on desktop so bootstrap hits a live server
    if (isDesktopRuntime()) {
      await waitForSidecarReady(3000);
      markLcpDebug('wm:boot:sidecar-ready');
    }

    // Anonymous browser session token (issue #3541). Server's validateApiKey
    // no longer trusts header-only signals (Origin / Referer / Sec-Fetch-Site
    // are all forgeable). Install a fetch interceptor ONCE, then mint a
    // wms_-prefixed HMAC token before the first API call. Desktop has its own
    // API key path and doesn't need this; Clerk-authenticated users will pass
    // their JWT in a Bearer header and the interceptor steps aside.
    if (!isDesktopRuntime()) {
      window.addEventListener(WM_SESSION_DEGRADED_EVENT, this.handleWmSessionDegraded);
      installWmSessionFetchInterceptor();
      await ensureWmSession();
      markLcpDebug('wm:boot:session-ready');
    }

    // Hydrate in-memory cache from bootstrap endpoint. Awaits only the fast tier; the slow
    // tier loads in the background (off the first-paint critical path, #4488) and calls back
    // when it lands so the connectivity indicator re-snapshots (no reactive emitter exists).
    await fetchBootstrapData(() => {
      if (this.state.isDestroyed) return;
      this.bootstrapHydrationState = getBootstrapHydrationState();
      this.updateConnectivityUi();
    });
    markLcpDebug('wm:boot:fast-bootstrap-ready');
    this.bootstrapHydrationState = getBootstrapHydrationState();

    // Verify OAuth OTT and hydrate auth session BEFORE any UI subscribes to auth state
    await initAuthState();
    initAuthAnalytics();
    installCloudPrefsSync(SITE_VARIANT);
    window.addEventListener(CLOUD_PREFS_APPLIED_EVENT, this.handleCloudPrefsApplied);
    window.addEventListener(
      CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      this.handleCloudPrefsSignInTerminal,
    );
    // Install the followed-countries auth listener once. Drives the
    // anon→signed-in handoff (mergeAnonymousLocal mutation) and sign-out
    // cleanup. Idempotent.
    installFollowedCountriesAuthListener();
    window.addEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, this.handleFollowedCountriesCapDrop);
    this.enforceFreeTierLimits();

    let _prevUserId: string | null = null;
    let _convexWatchHandoffGeneration = 0;
    // Track the last-seen PRO entitlement so we can re-fire PRO-gated loaders
    // ONCE on a false→true transition (user signs in / purchase lands mid-session).
    // Without this, loaders gated behind hasPremiumAccess() at init time (e.g.
    // loadTradePolicy) would sit empty until the next scheduled refresh — for
    // trade-policy that's a 10-minute wait post-sign-in. See PR #3295 review.
    let _prevHadPremium = hasPremiumAccess();
    // Pro-loader fan-out runs on EITHER Clerk auth changes OR Convex
    // entitlement changes — Pro can come from either signal (Clerk
    // user.role === 'pro' OR Convex tier >= 1 via Dodo). User-reported
    // on commodity.worldmonitor.app: Trade Policy panel stuck at "Loading…"
    // for a Pro Monthly subscriber because the original listener only
    // watched subscribeAuthState (Clerk-only); Convex Free→Pro transitions
    // never re-fired loadTradePolicy. Same root cause as PR #3409 layer-unlock.
    const firePremiumLoaders = (): void => {
      // Account sign-in replaces anonymous/local preferences asynchronously.
      // Entitlement callbacks may arrive first; defer every ownership mutation
      // until cloud prefs signals success or error for this same account.
      this.reconcileTierOwnedPreferences();
      const hadPremium = _prevHadPremium;
      const nowPremium = hasPremiumAccess();
      if (nowPremium && !hadPremium) {
        // Entitlement just resolved → fire PRO-gated initial loads that were
        // skipped at boot. Each loader early-returns if the panel isn't
        // mounted and re-checks hasPremiumAccess() internally, so these
        // calls are safe and idempotent. Without this, panels would sit empty
        // until the next scheduled refresh (10+ min for trade-policy; FOREVER
        // on the full variant for stock-analysis / stock-backtest / daily-
        // market-brief / market-implications because their schedulers are
        // gated to SITE_VARIANT === 'finance'). The audit-locking regression
        // test in tests/premium-loaders-fan-out-coverage.test.mts asserts
        // every `hasPremiumAccess() && shouldLoad('X')` gate in data-loader.ts
        // has a matching call here.
        void this.dataLoader.loadTradePolicy();
        void this.dataLoader.loadStockAnalysis();
        void this.dataLoader.loadStockBacktest();
        void this.dataLoader.loadDailyMarketBrief();
        void this.dataLoader.loadMarketImplications();
        void this.dataLoader.loadWsbTickers();
        void this.dataLoader.loadResilienceRanking();
        void this.dataLoader.loadGlobalTenders();
      } else if (!nowPremium && hadPremium) {
        // Pro data must not remain visible or available from the client cache
        // after sign-out, expiry, or downgrade.
        void this.dataLoader.clearGlobalTenders();
      }
      _prevHadPremium = nowPremium;
    };
    this.unsubEntitlementPremiumLoaders = onEntitlementChange(() => firePremiumLoaders());
    this.unsubFreeTier = subscribeAuthState((session) => {
      const userId = session.user?.id ?? null;
      const accountTransition = (
        (userId !== null && userId !== _prevUserId) ||
        (userId === null && _prevUserId !== null)
      );
      if (accountTransition) {
        // A cloud snapshot and its recovery version belong to the account that
        // was active when they arrived. Do not let a late Pro reconcile for a
        // different account consume that pending recovery opportunity.
        this.pendingCloudRecoverySyncVersion = undefined;
        this.freeTierGate.resetForAuthTransition();
      }

      if (userId !== null && userId !== _prevUserId) {
        const handoffGeneration = ++_convexWatchHandoffGeneration;
        // The token fences a LATE completion from a previous attempt for the
        // same account (sign-in A -> sign-out -> sign-in A): the queue settles
        // that stale attempt before this one runs, and an id-only guard would
        // let it release a handoff it does not own. The expiry callback is the
        // backstop for an attempt that never reaches a terminal outcome.
        const preferenceHandoffGeneration = this.tierPreferenceHandoff.begin(
          userId,
          () => { this.reconcileTierOwnedPreferences(); },
          // A 503 keeps the sign-in legitimately in flight for up to
          // Retry-After, which can outlast one grace window. Waiting beats
          // reconciling against pre-cloud state; the handoff's own ceiling
          // stops that wait from becoming indefinite.
          () => hasPendingCloudPrefsRetry(),
        );
        this.pendingPreferenceHandoffGeneration = preferenceHandoffGeneration;

        // Rebind Convex watches to the real Clerk userId (was bound to anon UUID at init)
        // destroyEntitlementSubscription deliberately PRESERVES the last
        // snapshot so a WebSocket reconnect doesn't flash paying users back to
        // locked. That preservation is wrong across an account change: until
        // the new user's first snapshot lands, getEntitlementState() still
        // describes the previous one. Anything reading it then attributes A's
        // plan to B — e.g. premium-denial's clientBelievesPro would read B's
        // legitimate 403 as A's entitlement desync and retry instead of
        // showing the upgrade CTA. Sign-out already resets for this reason;
        // an account switch carries the same hazard.
        void startAccountAuthHandoff({
          userId,
          isCurrent: () => (
            handoffGeneration === _convexWatchHandoffGeneration &&
            getAuthState().user?.id === userId
          ),
          effects: {
            destroyEntitlementSubscription,
            resetEntitlementState,
            destroySubscriptionWatch,
            rebindConvexAuthForWatchHandoff,
            initEntitlementSubscription,
            initSubscriptionWatch,
            cloudPrefsSignIn: (nextUserId) => {
              return cloudPrefsSignIn(nextUserId, SITE_VARIANT, {
                handoffGeneration: preferenceHandoffGeneration,
              });
            },
          },
        });

        // Claim any anonymous purchase made before sign-in (anon → real user migration)
        const anonId = getStoredAnonId();
        if (anonId) {
          void (async () => {
            const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
            if (!client || !api) return;
            // Wait for ConvexClient WebSocket auth handshake to complete.
            // Without this, mutations arrive at Convex before the server
            // has the JWT → "Authentication required" errors.
            const ready = await waitForConvexAuthForUser(userId, 10_000);
            if (!ready) {
              console.warn('[billing] claimSubscription skipped — Convex auth not ready');
              return;
            }
            const claimToken = getFreshStoredAnonClaimToken() ?? undefined;
            const result = await settleAccountOperation(
              userId,
              'claiming the anonymous subscription',
              () => client.mutation(api.payments.billing.claimSubscription, {
                anonId,
                ...(claimToken ? { claimToken } : {}),
              }),
            );
            assertAccountStillCurrent(userId, 'claiming the anonymous subscription');
            const claimed = result.claimed;
            const totalClaimed = claimed.subscriptions + claimed.entitlements +
                                 claimed.customers + claimed.payments;
            if (totalClaimed > 0) {
              console.log('[billing] Claimed anon subscription on sign-in:', claimed);
            }
            // Always remove after non-throwing completion — mutation is idempotent.
            // Prevents cold Convex init + mutation on every sign-in for non-purchasers.
            clearStoredAnonIdentity();
          })().catch((err: unknown) => {
            if (!isAccountStillCurrent(userId)) return;
            console.warn('[billing] claimSubscription failed:', err);
            // Non-fatal — anon ID preserved for retry on next page load
          });
        }

        // Accept a Business Pro seat invite carried in the URL (mirror of the
        // anon-claim hook). The invite link is /settings?accept-business-invite=<id>&token=<t>.
        // Runs after sign-in so the invitee's Clerk email is available server-side.
        const businessInviteGrantId = new URLSearchParams(window.location.search).get('accept-business-invite');
        const businessInviteToken = new URLSearchParams(window.location.search).get('token');
        if (businessInviteGrantId && businessInviteToken) {
          void (async () => {
            const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
            if (!client || !api) return;
            const ready = await waitForConvexAuthForUser(userId, 10_000);
            if (!ready) {
              console.warn('[business-seats] acceptBusinessInvite skipped — Convex auth not ready');
              return;
            }
            try {
              await settleAccountOperation(
                userId,
                'accepting the Business Pro seat invite',
                () => client.mutation(api.payments.businessSeats.acceptBusinessInvite, {
                  grantId: businessInviteGrantId as Id<'businessProGrants'>,
                  token: businessInviteToken,
                }),
              );
              assertAccountStillCurrent(userId, 'accepting the Business Pro seat invite');
              showToast('Pro seat activated');
            } catch (err) {
              if (!isAccountStillCurrent(userId)) return;
              const msg = err instanceof Error ? err.message : 'Failed to accept invite';
              if (msg.includes('INVITE_EMAIL_MISMATCH')) {
                showToast('This invite is for a different email address');
              } else if (msg.includes('INVITE_EXPIRED')) {
                showToast('This invite has expired');
              } else if (msg.includes('BUSINESS_NOT_ACTIVE')) {
                showToast('The Business plan that sent this invite is no longer active');
              } else if (msg.includes('INVITE_ALREADY_USED')) {
                showToast('This invite has already been used');
              } else {
                showToast('Could not accept invite');
              }
              console.warn('[business-seats] acceptBusinessInvite failed:', err);
            } finally {
              // Clear the invite params from the URL so a refresh does not retry.
              const url = new URL(window.location.href);
              url.searchParams.delete('accept-business-invite');
              url.searchParams.delete('token');
              window.history.replaceState({}, '', url.toString());
            }
          })();
        }
        void resumePendingCheckout({
          openAuth: () => this.state.authModal?.open(),
        });
      } else if (userId === null && _prevUserId !== null) {
        // Clerk's mounted UserButton signs out through the SDK directly, so
        // this observed transition is the authoritative place to invalidate
        // cached/in-flight HTTP tokens and the authenticated Convex socket.
        invalidateConvexAuthForSignOut();
        // Supersede any server-auth wait that was started for the account
        // being signed out before it gets a chance to attach user watches.
        _convexWatchHandoffGeneration++;
        destroyEntitlementSubscription();
        destroySubscriptionWatch();
        cloudPrefsSignOut();
        resetEntitlementState();
        this.tierPreferenceHandoff.clear();
        this.pendingPreferenceHandoffGeneration = undefined;
      }
      _prevUserId = userId;
      // Run after account handoff/reset so this pass cannot enforce the
      // previous user's entitlement against the new user's panels.
      firePremiumLoaders();
    });


    const geoCoordsPromise: Promise<PreciseCoordinates | null> =
      this.state.isMobile && this.state.initialUrlState?.lat === undefined && this.state.initialUrlState?.lon === undefined
        ? resolvePreciseUserCoordinates(5000)
        : Promise.resolve(null);

    const resolvedRegion = await resolveUserRegion();
    this.state.resolvedLocation = resolvedRegion;

    // Phase 1: Layout (creates map + panels — they'll find hydrated data).
    // init() is async so the dynamic MapContainer import can resolve before
    // downstream code (e.g. mobileGeoCoords→state.map.setCenter) reads ctx.map.
    markLcpDebug('wm:layout:init-start');
    await this.panelLayout.init();
    markLcpDebug('wm:layout:init-complete');
    this.eventHandlers.setupSearchControls();
    showProBanner(this.state.container);
    this.updateConnectivityUi();
    window.addEventListener('online', this.handleConnectivityChange);
    window.addEventListener('offline', this.handleConnectivityChange);

    const mobileGeoCoords = await geoCoordsPromise;
    if (mobileGeoCoords && this.state.map) {
      this.state.map.setCenter(mobileGeoCoords.lat, mobileGeoCoords.lon, 6);
    }

    // Happy variant: pre-populate panels from persistent cache for instant render
    if (SITE_VARIANT === 'happy') {
      await this.dataLoader.hydrateHappyPanelsFromCache();
    }

    // Phase 2: Shared UI components
    if (!this.state.isMobile) {
      void this.initFindingsBadge();
    }

    initBreakingNewsAlerts();
    this.state.breakingBanner = new BreakingNewsBanner();

    // Phase 3: UI setup methods
    this.eventHandlers.startHeaderClock();
    this.eventHandlers.setupPlaybackControl();
    this.eventHandlers.setupStatusPanel();
    this.eventHandlers.setupPizzIntIndicator();
    this.eventHandlers.setupLlmStatusIndicator();
    this.eventHandlers.setupExportPanel();
    this.eventHandlers.setupSearchControls();

    // Correlation engine is constructed lazily at its post-loadAllData run site
    // (Phase 6 below) so its bytes + adapters stay off the eager boot graph (#4486).
    this.eventHandlers.setupUnifiedSettings();
    this.eventHandlers.setupAuthWidget();
    // Capture any ?ref= / ?wm_referral= from the URL into localStorage
    // and strip from the visible URL. Runs BEFORE the pending-checkout
    // capture so a /dashboard?ref=X&checkoutProduct=Y landing preserves both
    // signals. Pure read of current URL — no-op when neither param is
    // present.
    captureReferralFromUrl();
    // Wire checkout-attempt lifecycle watchers (sign-out clear) before
    // any capture/resume path runs, so a stale session from a prior
    // user can't bleed into the current one.
    initCheckoutWatchers();
    // Stale attempt records are ignored by loadCheckoutAttempt() via
    // the 24h TTL — no separate sweep needed. The attempt record's
    // only consumer (the failure-retry banner) runs handleCheckoutReturn
    // synchronously during panel-layout mount, which is after the
    // captureePendingCheckoutIntentFromUrl repopulates it for any /pro
    // handoff — so no race exists that would want to sweep pre-capture.
    const pendingCheckout = capturePendingCheckoutIntentFromUrl();
    if (pendingCheckout) {
      // Checkout intent from /pro page redirect. Resume immediately if
      // already authenticated, otherwise the auth callback handles it.
      void resumePendingCheckout({
        openAuth: () => this.state.authModal?.open(),
      });
    }

    // Phase 4: MapLayerHandlers, CountryIntel. SearchManager is lazy-loaded
    // on first CMD+K/search-button open so its modal catalog stays off startup.
    this.eventHandlers.setupMapLayerHandlers();
    await this.countryIntel.init();
    // Unblock any WebMCP tool invocations that arrived during startup.
    this.resolveUiReady();

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    // Capture deep link params BEFORE URL sync overwrites them
    const initState = parseMapUrlState(window.location.search, this.state.mapLayers);
    this.pendingDeepLinkCountry = initState.country ?? null;
    this.pendingDeepLinkExpanded = initState.expanded === true;
    this.pendingDeepLinkChokepoint = initState.chokepoint ?? null;
    const earlyParams = new URLSearchParams(window.location.search);
    this.pendingDeepLinkStoryCode = earlyParams.get('c') ?? null;
    this.eventHandlers.setupUrlStateSync();
    if (import.meta.env.VITE_E2E === '1') {
      document.documentElement.dataset.wmEventHandlersReady = 'true';
    }

    this.state.countryBriefPage?.onStateChange?.(() => {
      this.eventHandlers.syncUrlState();
    });

    // Start deep link handling early — its retry loop polls hasSufficientData()
    // independently, so it must not be gated behind loadAllData() which can hang.
    this.handleDeepLinks();

    // Phase 6: Data loading
    this.dataLoader.syncDataFreshnessWithLayers();
    const slowTierReady = this.waitForSlowBootstrapCheckpoint();
    if (this.state.isDestroyed) return;
    // forceAll=false at bootstrap: data-loader's existing per-panel
    // viewport gate (shouldLoad(id) = forceAll || isPanelNearViewport(id))
    // now actually fires, cutting the ~80-request fan-out down to the
    // panels currently above the fold. IntersectionObserver wiring in
    // panel-layout.ts plus handleViewportPrime above re-trigger
    // loadAllData() as below-fold panels enter the viewport. (#3990)
    // Slow-tier hydration keys are consume-once (getHydratedData deletes on
    // read) and the visible-data consumers in loadAllData read them at task
    // start. If the fan-out runs before the slow tier settles, those reads miss
    // and fall back to per-panel RPCs that never re-read the late payload —
    // wasting the ~500 KB slow-tier bootstrap. The shell LCP element already
    // painted back in panelLayout.init() (Phase 1), so awaiting here is OFF the
    // LCP critical path; it stays bounded by waitForBootstrapSlowTier's timeout
    // (3.5 s browser / 8.5 s desktop). (#4512)
    await slowTierReady;
    if (this.state.isDestroyed) return;
    this.viewportHydrationReady = true;
    // Register viewport triggers only after the slow bootstrap tier settles.
    // Scrolls before this point are covered by the initial fan-out below, which
    // scans the current viewport after readiness. Registering earlier lets a
    // captured descendant scroll consume hydration keys before they arrive.
    window.addEventListener('scroll', this.handleViewportPrime, {
      passive: true,
      capture: true,
    });
    window.addEventListener('resize', this.handleViewportPrime);
    // Prime panel-specific data concurrently with bulk loading.
    // primeVisiblePanelData owns ETF, Stablecoins, Gulf Economies, etc. that
    // are NOT part of loadAllData. Running them in parallel prevents those
    // panels from being blocked when a loadAllData batch is slow.
    // Snapshot whether precision geometry was already loaded BEFORE the fan-out
    // (the map renderer triggers the memoized fetch early). If so, the fan-out's
    // geometry-dependent CII ingests already attributed correctly and the
    // post-LCP replay would just be a redundant second CII compute + choropleth
    // repaint, so we skip it below. (#4512)
    const geometryReadyBeforeFanout = isCountryGeometryLoaded();
    markLcpDebug('wm:data:initial-fanout-start');
    await Promise.all([
      this.dataLoader.loadAllData(),
      this.primeVisiblePanelData(),
    ]);
    markLcpDebug('wm:data:initial-fanout-complete');
    const countryGeometryReady = this.preloadCountryGeometryForPostLcpWork();

    // If bootstrap was served from cache but live data just loaded, promote the status indicator
    markBootstrapAsLive();
    this.bootstrapHydrationState = getBootstrapHydrationState();
    this.updateConnectivityUi();

    // Initial correlation engine run is post-LCP background work. Wait for
    // precision country geometry there instead of before visible data fan-out.
    this.startPostLcpIntelligence(countryGeometryReady, geometryReadyBeforeFanout);

    // Hide unconfigured layers after first data load
    if (!isAisConfigured()) {
      this.state.map?.hideLayerToggle('ais');
    }
    if (isOutagesConfigured() === false) {
      this.state.map?.hideLayerToggle('outages');
    }
    if (!CYBER_LAYER_ENABLED) {
      this.state.map?.hideLayerToggle('cyberThreats');
    }

    // Phase 7: Refresh scheduling
    this.setupRefreshIntervals();
    this.eventHandlers.setupSnapshotSaving();
    cleanOldSnapshots().catch((e) => console.warn('[Storage] Snapshot cleanup failed:', e));

    // Phase 8: Update checks
    this.desktopUpdater.init();

    // Analytics
    trackEvent('wm_app_loaded', {
      load_time_ms: Math.round(performance.now() - initStart),
      panel_count: Object.keys(this.state.panels).length,
    });
    this.eventHandlers.setupPanelViewTracking();
  }

  private shouldDeferTierPreferenceReconciliation(): boolean {
    return this.tierPreferenceHandoff.shouldDefer(getAuthState().user?.id ?? null);
  }

  /** Reconcile all gate-owned preferences against one settled account view. */
  private reconcileTierOwnedPreferences(): boolean {
    if (this.shouldDeferTierPreferenceReconciliation()) return false;
    this.enforceFreeTierLimits();
    // Stored dashboard-tab snapshots have their own panel copies.
    this.panelLayout.healStoredTabSnapshots();
    this.healLockedMapLayers(this.freeTierGate.authSettleDeadlineExceeded);
    return true;
  }

  private persistJsonStorageValue<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      if (isQuotaError(error)) markStorageQuotaExceeded();
      else console.warn(`Failed to save ${key} to storage:`, error);
      return false;
    }
  }

  /**
   * Grace-timer state for the free-tier gate. Lives in a collaborator so the
   * backstop can be driven by tests; App itself is not importable from the
   * node:test suites.
   */
  private readonly freeTierGate = new FreeTierGate(() => {
    if (this.shouldDeferTierPreferenceReconciliation()) return;
    this.enforceFreeTierLimits();
    this.panelLayout.healStoredTabSnapshots();
    // Clerk can remain pending forever when its script or key is unavailable.
    // The gate's deadline is the explicit free-tier answer in that case, so
    // heal stale locked map-layer state as well as panel/source state.
    this.healLockedMapLayers(true);
  });

  /**
   * Sanitize a map-layer snapshot only after the entitlement answer is safe to
   * treat as free. The fallback argument is deliberately explicit: pending
   * auth is not evidence that a paying user is free, but the bounded gate is.
   */
  private sanitizeMapLayersForTier(
    layers: MapLayers,
    fallbackActive = this.freeTierGate.authSettleDeadlineExceeded,
    options: { ephemeralSnapshot?: boolean } = {},
  ): MapLayers {
    // A `?layers=` deep link is a VIEW, not the user's saved preference:
    // parseMapUrlState rebuilds every LAYER_KEYS entry from the query string.
    // Treating it as durable state let a shared link overwrite the stored
    // (and cloud-synced) preference and seed gate ownership the user never
    // chose, so an ephemeral snapshot is sanitized for display only.
    const ephemeral = options.ephemeralSnapshot ?? false;
    const premium = hasPremiumAccess();
    // A Pro deep link is already entitled. Preserve the exact URL-derived
    // display snapshot and do not even read durable gate ownership: restoring
    // it here would enable layers the shared link deliberately omitted.
    if (premium && ephemeral) return layers;

    const existingOwnership = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.mapLayerGateOwnership, []),
    );

    if (premium) {
      if (existingOwnership.size === 0) return layers;
      const restored = sanitizeLayersForVariant(
        restoreGateOwnedLockedLayers(layers, existingOwnership),
        SITE_VARIANT as MapVariant,
      );
      // sanitizeLayersForVariant always returns a fresh object, so `restored
      // === layers` is never true — an identity check here silently persisted
      // on every pass. Compare by value.
      const unchanged = mapLayerStatesEqual(layers, restored);
      const persistence = persistGateOwnershipTransition(
        'pro',
        () => unchanged
          || this.persistJsonStorageValue(STORAGE_KEYS.mapLayers, restored),
        () => this.persistJsonStorageValue(STORAGE_KEYS.mapLayerGateOwnership, []),
      );
      return persistence.preferencePersisted ? restored : layers;
    }

    if (!shouldSanitizeLockedLayers(premium, isProTierResolved(), fallbackActive)) {
      return layers;
    }

    // Strip locked layers from the view without recording ownership: a shared
    // link naming a locked layer must not make that layer auto-enable if the
    // user later subscribes.
    if (ephemeral) return sanitizeLockedLayers(layers, false);

    const reconciled = sanitizeLockedLayersWithOwnership(layers, existingOwnership);
    const ownershipChanged = !stringSetsEqual(existingOwnership, reconciled.gateOwned);
    persistGateOwnershipTransition(
      'free',
      () => reconciled.layers === layers
        || this.persistJsonStorageValue(STORAGE_KEYS.mapLayers, reconciled.layers),
      () => !ownershipChanged
        || this.persistJsonStorageValue(
          STORAGE_KEYS.mapLayerGateOwnership,
          [...reconciled.gateOwned],
        ),
    );
    // Entitlement is a live safety boundary: blocked/quota-limited storage
    // must not leave a locked layer rendered. The ordered writes above retain
    // enough durable state to retry without ever persisting the destructive
    // preference before ownership.
    return reconciled.layers;
  }

  /** Heal the live map and persisted state after a downgrade or free fallback. */
  private healLockedMapLayers(
    fallbackActive = this.freeTierGate.authSettleDeadlineExceeded,
  ): void {
    const initialUrlLayers = this.state.initialUrlState?.layers;
    if (initialUrlLayers) {
      const healedUrlLayers = this.sanitizeMapLayersForTier(
        initialUrlLayers,
        fallbackActive,
        { ephemeralSnapshot: true },
      );
      if (healedUrlLayers !== initialUrlLayers && this.state.initialUrlState) {
        this.state.initialUrlState.layers = healedUrlLayers;
      }
    }
    // When the session booted from a `?layers=` link, state.mapLayers IS that
    // URL-derived view (seeded from the same local in the constructor), so this
    // heal must stay ephemeral too. The boot-time ephemeral pass usually
    // no-ops — shouldSanitizeLockedLayers is false while the tier is still
    // unresolved — which makes THIS the call that actually acts, and a
    // non-ephemeral run here would seed gate ownership from the link and write
    // it to the stored preference, undoing the deep-link fix entirely.
    const healed = this.sanitizeMapLayersForTier(
      this.state.mapLayers,
      fallbackActive,
      initialUrlLayers ? { ephemeralSnapshot: true } : {},
    );
    if (healed === this.state.mapLayers) return;
    this.state.mapLayers = healed;
    this.state.map?.setLayers(healed);
    this.dataLoader.syncDataFreshnessWithLayers();
  }

  /**
   * Put back everything the free-tier gate hid, now that we know the user is
   * Pro: the cw-* custom widgets AND the panels the count cap clamped off past
   * FREE_MAX_PANELS. Both now carry `proGated`, so the targeted restore covers
   * both; only the legacy sweep below stays widget-specific.
   *
   * Covers the free→pro upgrade, and heals users whose widgets were disabled
   * by a pre-fix build (see the one-time recovery below — those entries
   * pre-date the `proGated` marker, so they need the sweep).
   */
  private restoreProGatedPanelsForTier(cloudSyncVersion?: number): boolean {
    const panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
    let restored = restoreProGatedPanels(panelSettings);

    // ── One-time recovery for pre-`proGated` damage ───────────────────
    // Strictly once per browser. The sweep cannot tell legacy gate damage from
    // a widget the user hid on purpose (both are `enabled: false` with no
    // marker), so re-running it would silently un-hide deliberate hides. It was
    // previously re-armed on every cloud panels snapshot, which fires on
    // effectively every sign-in for a multi-device user — that re-arm is gone.
    //
    // Each device still heals itself on its first post-fix Pro reconcile, and
    // from then on `proGated` travels with the synced blob, so the targeted
    // restore above covers the cross-device case. A panel-bearing cloud
    // generation received before entitlement settles is retained in memory
    // until that Pro reconcile, so the one bounded second chance is not lost.
    //
    // The marker is burned on the first look, not the first repair: widget
    // specs are device-local (`wm-custom-widgets` is not a cloud-sync key), so
    // `loadWidgets()` is fully hydrated here and "found nothing" is a real
    // answer, not a not-yet-loaded one.
    try {
      let ownedWidgetIds: Set<string> | null = null;
      const sweepLegacy = (): void => {
        ownedWidgetIds ??= new Set(loadWidgets().map((w) => w.id));
        restored = sweepLegacyDisabledCustomWidgets(restored, ownedWidgetIds);
      };
      const recoveryMarker = localStorage.getItem(CW_PRO_GATE_RECOVERY_KEY);
      const baselineRaw = localStorage.getItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY);
      const baselineParsed = baselineRaw === null ? Number.NaN : Number.parseInt(baselineRaw, 10);
      const baselineSyncVersion = Number.isFinite(baselineParsed) ? baselineParsed : null;
      const appliedRaw = localStorage.getItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY);
      const appliedParsed = appliedRaw === null ? Number.NaN : Number.parseInt(appliedRaw, 10);
      const appliedSyncVersion = Number.isFinite(appliedParsed) ? appliedParsed : null;
      const effectiveCloudSyncVersion = cloudSyncVersion ?? this.pendingCloudRecoverySyncVersion;

      if (!recoveryMarker) {
        sweepLegacy();
        localStorage.setItem(CW_PRO_GATE_RECOVERY_KEY, 'done');
        // The current cloud snapshot was swept as part of the first recovery,
        // so mark it consumed when this call came from cloud reconciliation.
        const baseline = effectiveCloudSyncVersion ?? getSyncVersion();
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY, String(baseline));
        if (effectiveCloudSyncVersion !== undefined) {
          localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY, String(effectiveCloudSyncVersion));
        }
      } else if (baselineSyncVersion === null && effectiveCloudSyncVersion !== undefined) {
        // A browser may have burned the original marker before this bounded
        // cloud-generation guard shipped. Give its first observed cloud
        // snapshot one recovery pass, then never re-arm for later versions.
        sweepLegacy();
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY, String(effectiveCloudSyncVersion));
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY, String(effectiveCloudSyncVersion));
      } else if (baselineSyncVersion === null) {
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY, String(getSyncVersion()));
      } else if (shouldRunCloudLegacyRecovery(baselineSyncVersion, appliedSyncVersion, effectiveCloudSyncVersion)) {
        // One bounded second chance covers a pre-fix snapshot arriving after
        // the local migration marker was already consumed. Deliberate hides
        // are protected from future cloud replays by the applied marker.
        sweepLegacy();
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY, String(effectiveCloudSyncVersion));
      }
    } catch {
      // Persistence-only migration; blocked storage already uses defaults.
    }

    if (!panelGateStateChanged(panelSettings, restored)) return false;

    saveToStorage(STORAGE_KEYS.panels, restored);
    this.state.panelSettings = restored;
    this.panelLayout.applyPanelSettings();
    this.state.unifiedSettings?.refreshPanelToggles();
    console.log('[App] Pro: restored custom widget panels hidden by the free-tier gate');
    return true;
  }

  private currentSourceCapLanguage(): string {
    let explicitLocale = '';
    try { explicitLocale = localStorage.getItem('wm-locale-explicit') || ''; } catch { /* private mode */ }
    return ((explicitLocale || navigator.language || 'en').split('-')[0] ?? 'en').toLowerCase();
  }

  private sourceCapProtectedNames(userLang: string): Set<string> {
    const protectedNames = new Set<string>(FREE_CAP_PROTECTED_SOURCES);
    for (const name of getStrategicDefaultSources()) protectedNames.add(name);
    if (userLang !== 'en') {
      for (const name of getLocaleBoostedSources(userLang)) protectedNames.add(name);
    }
    return protectedNames;
  }

  /** Reconcile or restore the persisted 80-source cap without losing user intent. */
  private reconcileSourceLimitForTier(pro: boolean): boolean {
    let ownershipMetadataExists = false;
    try {
      ownershipMetadataExists = localStorage.getItem(STORAGE_KEYS.sourceGateOwnership) !== null;
    } catch { /* optional persistence */ }
    const persistedDisabled = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []),
    );
    const persistedGateOwned = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.sourceGateOwnership, []),
    );
    let gateOwned = new Set(persistedGateOwned);
    const userLang = this.currentSourceCapLanguage();
    const protectedNames = this.sourceCapProtectedNames(userLang);

    // Heal untouched profiles capped before ownership metadata existed. Exact
    // matching preserves every customized denylist.
    if (!ownershipMetadataExists) {
      const defaultUserDisabled = new Set(computeDefaultDisabledSources(userLang));
      const expectedGateOwned = selectSourcesUnderCap(
        FEEDS,
        INTEL_SOURCES,
        defaultUserDisabled,
        FREE_MAX_SOURCES,
        protectedNames,
      ).autoDisabled;
      gateOwned = inferExactSourceGateOwnership(
        persistedDisabled,
        defaultUserDisabled,
        expectedGateOwned,
      ) ?? gateOwned;
    }

    let nextDisabled: Set<string>;
    let nextGateOwned: Set<string>;
    if (pro) {
      nextDisabled = restoreGateOwnedSources(persistedDisabled, gateOwned);
      nextGateOwned = new Set();
    } else {
      const userDisabled = restoreGateOwnedSources(persistedDisabled, gateOwned);
      const nextAutoDisabled = selectSourcesUnderCap(
        FEEDS,
        INTEL_SOURCES,
        userDisabled,
        FREE_MAX_SOURCES,
        protectedNames,
      ).autoDisabled;
      const reconciled = reconcileSourceGateOwnership(
        userDisabled,
        nextAutoDisabled,
      );
      nextDisabled = reconciled.disabled;
      nextGateOwned = reconciled.gateOwned;
    }

    const disabledChanged = !stringSetsEqual(persistedDisabled, nextDisabled);
    const ownershipChanged = !ownershipMetadataExists
      || !stringSetsEqual(persistedGateOwned, nextGateOwned);
    const persistence = persistGateOwnershipTransition(
      pro ? 'pro' : 'free',
      () => !disabledChanged
        || this.persistJsonStorageValue(STORAGE_KEYS.disabledFeeds, [...nextDisabled]),
      () => !ownershipChanged
        || this.persistJsonStorageValue(
          STORAGE_KEYS.sourceGateOwnership,
          [...nextGateOwned],
        ),
    );
    const disabledPersisted = disabledChanged && persistence.preferencePersisted;
    const ownershipPersisted = ownershipChanged && persistence.ownershipPersisted;
    if (disabledChanged) {
      // The live entitlement boundary must not depend on localStorage health.
      // Durable writes remain ordered/retryable above, but free users stay
      // capped and Pro users unlock immediately even when quota is exhausted.
      this.state.disabledSources = new Set(nextDisabled);
    }
    if (disabledPersisted || ownershipPersisted) {
      console.log(pro
        ? `[App] Pro: restored ${gateOwned.size} source(s) disabled by the free-tier gate`
        : `[App] Free tier: reconciled ${nextGateOwned.size} gate-owned source disable(s)`);
    }
    return disabledPersisted || ownershipPersisted;
  }

  /**
   * Enforce free-tier panel and source limits.
   * Reads current values from storage, trims if necessary, and saves back.
   * Safe to call multiple times (idempotent) — e.g. on auth state changes.
   */
  private enforceFreeTierLimits(cloudSyncVersion?: number): boolean {
    // ── One-time v1 cap-bug recovery ──────────────────────────────────
    // Pre-2026-05-01 the source cap was enforced by Array.sort().slice(),
    // which silently auto-disabled every source past alphabetical position
    // FREE_MAX_SOURCES — catastrophically erasing late-alphabet categories
    // (Layoffs, Semiconductors, IPO, Funding, Product Hunt, …). Storage
    // didn't track auto-disabled vs user-disabled, so a heuristic that runs
    // on every load would silently undo a user who legitimately disabled
    // every source in a category — and re-undo it on every refresh forever.
    //
    // Migration approach: run findFullyDisabledCategories ONCE, gated by
    // disabledFeedsSchema version. After the migration completes, bump
    // schema → 1 so subsequent loads skip recovery entirely. Users who
    // explicitly toggle off every source in a category post-migration
    // keep that preference permanently. Trade-off: a user who BEFORE the
    // migration legitimately disabled every source in a category will lose
    // those preferences once. That's acceptable since v1 victims have been
    // suffering silent breakage and the explicit-full-category-disable
    // pattern is rare (users typically hide the whole panel instead).
    const schemaVersion = loadFromStorage<number>(STORAGE_KEYS.disabledFeedsSchema, 0);
    if (schemaVersion < 1) {
      const disabled = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
      const recoverable = findFullyDisabledCategories(FEEDS, disabled);
      if (recoverable.length > 0) {
        for (const name of recoverable) disabled.delete(name);
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(disabled));
        console.log(`[App] One-time v1-cap-bug migration: re-enabled ${recoverable.length} source(s) from fully-disabled categories. This will not run again.`);
      }
      saveToStorage(STORAGE_KEYS.disabledFeedsSchema, 1);
    }

    if (isProUser()) {
      this.freeTierGate.cancelFallback();
      const panelsChanged = this.restoreProGatedPanelsForTier(cloudSyncVersion);
      this.reconcileSourceLimitForTier(true);
      return panelsChanged;
    }

    // Pro/free is NOT knowable yet on an auth-enabled page load. initAuthState()
    // deliberately does not await Clerk (2.98 MB, loaded on requestIdleCallback
    // with a 4 s timeout) and the Convex entitlement snapshot lands later
    // still, so getAuthState() is `{ user: null, isPending: true }` here — a
    // signed-in Pro user is indistinguishable from an anonymous one at this
    // point. Builds without Clerk settle anonymous synchronously instead.
    //
    // That matters because the clamp below is a PERSISTED write and
    // enforceFreePanelLimit disables every cw-* custom widget on the free
    // tier. Running it against an unresolved session wrote `enabled: false`
    // into STORAGE_KEYS.panels for Pro users' widgets on every single refresh:
    // the specs survived in wm-custom-widgets but the panels never mounted
    // again, so custom widgets appeared to vanish the moment the page
    // reloaded. (The widget e2e suite missed it because it seeds the legacy
    // wm-widget-key, which makes isProUser() true synchronously at boot.)
    //
    // Deferring is free: firePremiumLoaders() re-runs this on the Clerk auth
    // event and on every Convex entitlement snapshot. The fallback timer
    // covers the one case where neither ever arrives — a configured Clerk
    // script fails to load and isPending stays true, so the free-tier caps
    // would otherwise never be enforced.
    //
    // The same blindness recurs after Clerk settles: the auth callback runs
    // firePremiumLoaders() before initEntitlementSubscription() rebinds, so
    // for a signed-in user getEntitlementState() is still null and
    // isEntitled() is deterministically false at that instant — a Convex-only
    // Pro subscriber would be clamped as free on every load. Defer for that
    // window too; the entitlement snapshot re-runs this and the same fallback
    // timer bounds a snapshot that never arrives.
    const session = getAuthState();
    if (
      shouldDeferFreeTierEnforcement(
        session.isPending,
        session.user !== null,
        getEntitlementState() !== null,
        this.freeTierGate.authSettleDeadlineExceeded,
      )
    ) {
      this.freeTierGate.scheduleFallback();
      return false;
    }
    // Tier is known — drop the backstop instead of letting it fire a redundant
    // enforcement pass 8 s into every session.
    this.freeTierGate.cancelFallback();

    // --- Panel limit ---
    // Delegate to the shared enforceFreePanelLimit helper so this boot path and
    // the dashboard-tab add/switch/load paths stay in lockstep (same cw-* and
    // count rules). isPro is false here — the isProUser() early-return above
    // already short-circuited pro users.
    let panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
    let panelsChanged = false;
    try {
      if (!localStorage.getItem(FREE_MAP_PANEL_ACCESS_KEY)) {
        const restoredPanels = restoreFreeMapPanelAccess(panelSettings);
        if (panelSettings.map?.enabled !== restoredPanels.map?.enabled) {
          panelSettings = restoredPanels;
          panelsChanged = true;
        }
        localStorage.setItem(FREE_MAP_PANEL_ACCESS_KEY, 'done');
      }
    } catch {
      // Persistence-only migration; blocked storage already uses defaults.
    }
    const clampedPanels = enforceFreePanelLimit(panelSettings, false);
    for (const key of Object.keys(panelSettings)) {
      if (panelSettings[key]?.enabled !== clampedPanels[key]?.enabled) {
        panelsChanged = true;
        break;
      }
    }
    if (panelsChanged) {
      saveToStorage(STORAGE_KEYS.panels, clampedPanels);
      this.state.panelSettings = clampedPanels;
      // Auth and entitlement callbacks can reach this path after the layout
      // has mounted. Persisting the clamp is not enough in that case: remove
      // now-ineligible panels from the live dashboard immediately as well.
      this.panelLayout.applyPanelSettings();
      this.state.unifiedSettings?.refreshPanelToggles();
      console.log(`[App] Free tier: enforced ${FREE_MAX_PANELS}-panel limit (disabled over-cap / cw-* panels)`);
    }

    this.reconcileSourceLimitForTier(false);
    return panelsChanged;
  }

  public destroy(): void {
    this.state.isDestroyed = true;
    this.tierPreferenceHandoff.clear();
    this.pendingPreferenceHandoffGeneration = undefined;
    this.viewportHydrationReady = false;
    cancelBootstrapSlowTier();
    window.removeEventListener('scroll', this.handleViewportPrime, { capture: true });
    window.removeEventListener('resize', this.handleViewportPrime);
    window.removeEventListener('online', this.handleConnectivityChange);
    window.removeEventListener('offline', this.handleConnectivityChange);
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleI18nResourcesLoaded);
    window.removeEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, this.handleFollowedCountriesCapDrop);
    window.removeEventListener(CLOUD_PREFS_APPLIED_EVENT, this.handleCloudPrefsApplied);
    window.removeEventListener(
      CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      this.handleCloudPrefsSignInTerminal,
    );
    if (this.visiblePanelPrimeRaf !== null) {
      window.cancelAnimationFrame(this.visiblePanelPrimeRaf);
      this.visiblePanelPrimeRaf = null;
    }
    if (this.chokepointDeepLinkTimer !== null) {
      window.clearTimeout(this.chokepointDeepLinkTimer);
      this.chokepointDeepLinkTimer = null;
    }

    // Destroy all modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      this.modules[i]!.destroy();
    }

    // Clean up subscriptions, map, AIS, and breaking news
    this.unsubAiFlow?.();
    this.unsubFreeTier?.();
    this.unsubEntitlementPremiumLoaders?.();
    this.freeTierGate.cancelFallback();
    mlWorker.terminate();
    this.state.findingsBadge?.destroy();
    this.state.findingsBadge = null;
    this.state.breakingBanner?.destroy();
    destroyBreakingNewsAlerts();
    this.cachedModeBannerEl?.remove();
    this.cachedModeBannerEl = null;
    window.removeEventListener(WM_SESSION_DEGRADED_EVENT, this.handleWmSessionDegraded);
    if (this.followedCountriesCapDropToastTimer !== null) {
      window.clearTimeout(this.followedCountriesCapDropToastTimer);
      this.followedCountriesCapDropToastTimer = null;
    }
    this.state.map?.destroy();
    disconnectAisStream();
    stopFlightHistoryCleanup();
    stopLoadedVesselHistoryCleanup();
    // Unregister every WebMCP tool so a same-document re-init (tests,
    // HMR, SPA harness) doesn't leave the browser with stale bindings
    // pointing at a disposed App.
    this.webMcpController?.abort();
    this.webMcpController = null;
  }

  private async initFindingsBadge(): Promise<void> {
    try {
      const { IntelligenceGapBadge } = await import('@/components/IntelligenceGapBadge');
      if (this.state.isDestroyed) return;
      this.state.findingsBadge = new IntelligenceGapBadge();
      this.state.findingsBadge.setOnSignalClick((signal) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (localStorage.getItem('wm-settings-open') === '1') return;
        void this.state.ensureSignalModal()
          .then((signalModal) => {
            if (!this.state.isDestroyed) signalModal.showSignal(signal);
          })
          .catch((err) => {
            console.warn('[SignalModal] Failed to show signal:', err);
          });
      });
      this.state.findingsBadge.setOnAlertClick((alert) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (localStorage.getItem('wm-settings-open') === '1') return;
        void this.state.ensureSignalModal()
          .then((signalModal) => {
            if (!this.state.isDestroyed) signalModal.showAlert(alert);
          })
          .catch((err) => {
            console.warn('[SignalModal] Failed to show alert:', err);
          });
      });
    } catch (error) {
      console.warn('[IntelligenceGapBadge] Lazy init failed:', error);
    }
  }

  private showFollowedCountriesCapDropToast(kept: number, dropped: number): void {
    if (this.followedCountriesCapDropToastTimer !== null) {
      window.clearTimeout(this.followedCountriesCapDropToastTimer);
      this.followedCountriesCapDropToastTimer = null;
    }
    document.querySelector('.wm-followed-cap-drop-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'wm-followed-cap-drop-toast update-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const body = document.createElement('div');
    body.className = 'update-toast-body';

    const title = document.createElement('div');
    title.className = 'update-toast-title';
    title.textContent = 'Follow limit reached';

    const detail = document.createElement('div');
    detail.className = 'update-toast-detail';
    const countryWord = dropped === 1 ? 'country was' : 'countries were';
    detail.textContent = `${kept} kept. ${dropped} ${countryWord} not added because the free plan supports ${FREE_TIER_FOLLOW_LIMIT} followed countries.`;

    body.append(title, detail);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'update-toast-action';
    action.dataset.action = 'upgrade';
    action.textContent = 'Upgrade';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'update-toast-dismiss';
    dismiss.dataset.action = 'dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '\u00d7';

    toast.append(body, action, dismiss);

    this.followedCountriesCapDropToastTimer = window.setTimeout(() => {
      toast.remove();
      this.followedCountriesCapDropToastTimer = null;
    }, 8000);
    toast.addEventListener('click', (e) => {
      const clickedAction = (e.target as HTMLElement)
        .closest<HTMLElement>('[data-action]')
        ?.dataset.action;
      if (clickedAction === 'upgrade') {
        // Absolute + routed: the relative form resolved against
        // tauri://localhost in the desktop WebView (#5911).
        void openExternalUrl(`${WEB_APP_ORIGIN}/pro#pricing`);
        if (this.followedCountriesCapDropToastTimer !== null) {
          window.clearTimeout(this.followedCountriesCapDropToastTimer);
          this.followedCountriesCapDropToastTimer = null;
        }
        toast.remove();
      } else if (clickedAction === 'dismiss') {
        if (this.followedCountriesCapDropToastTimer !== null) {
          window.clearTimeout(this.followedCountriesCapDropToastTimer);
          this.followedCountriesCapDropToastTimer = null;
        }
        toast.remove();
      }
    });

    document.body.appendChild(toast);
    window.requestAnimationFrame(() => toast.classList.add('visible'));
  }

  // Waits for Phase-4 UI modules to finish initialising. WebMCP bindings call
  // this before touching nullable UI
  // state so a tool invoked during startup waits rather than throwing;
  // the timeout guards against a genuinely broken init path hanging the
  // agent forever.
  private async waitForUiReady(timeoutMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`UI did not initialise within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.uiReady, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private handleDeepLinks(): void {
    const url = new URL(window.location.href);
    const DEEP_LINK_INITIAL_DELAY_MS = 1500;

    // Check for country brief deep link: ?c=IR (captured early before URL sync)
    const storyCode = this.pendingDeepLinkStoryCode ?? url.searchParams.get('c');
    this.pendingDeepLinkStoryCode = null;
    if (url.pathname === '/story' || storyCode) {
      const countryCode = storyCode;
      if (countryCode) {
        trackDeeplinkOpened('country', countryCode);
        const countryName = getCountryNameByCode(countryCode.toUpperCase()) || countryCode;
        setTimeout(() => {
          void this.countryIntel.openCountryBriefByCode(countryCode.toUpperCase(), countryName, {
            maximize: true,
          }).catch((err) => {
            console.error('[CountryBrief] Failed to open country brief:', err);
            this.state.map?.setRenderPaused(false);
            showToast('Country brief failed to open. Please try again.');
          });
          this.eventHandlers.syncUrlState();
        }, DEEP_LINK_INITIAL_DELAY_MS);
        return;
      }
    }

    // Check for country brief deep link: ?country=UA or ?country=UA&expanded=1
    const deepLinkCountry = this.pendingDeepLinkCountry;
    const deepLinkExpanded = this.pendingDeepLinkExpanded;
    this.pendingDeepLinkCountry = null;
    this.pendingDeepLinkExpanded = false;
    if (deepLinkCountry) {
      trackDeeplinkOpened('country', deepLinkCountry);
      const cName = CountryIntelManager.resolveCountryName(deepLinkCountry);
      setTimeout(() => {
        void this.countryIntel.openCountryBriefByCode(deepLinkCountry, cName, {
          maximize: deepLinkExpanded,
        }).catch((err) => {
          console.error('[CountryBrief] Failed to open country brief:', err);
          this.state.map?.setRenderPaused(false);
          showToast('Country brief failed to open. Please try again.');
        });
        this.eventHandlers.syncUrlState();
      }, DEEP_LINK_INITIAL_DELAY_MS);
    }

    // Check for chokepoint deep link: ?chokepoint=bab_el_mandeb — pans the map to
    // the waterway and opens its popup (the chokepoint equivalent of the country
    // brief deep link). openChokepoint no-ops on an unknown id.
    const deepLinkChokepoint = this.pendingDeepLinkChokepoint;
    this.pendingDeepLinkChokepoint = null;
    if (deepLinkChokepoint) {
      trackDeeplinkOpened('chokepoint', deepLinkChokepoint);
      this.state.activeChokepoint = deepLinkChokepoint;
      this.chokepointDeepLinkTimer = window.setTimeout(() => {
        this.chokepointDeepLinkTimer = null;
        if (this.state.isDestroyed) return;
        this.state.mapLayers.waterways = true;
        this.state.map?.enableLayer('waterways');
        this.state.map?.openChokepoint(deepLinkChokepoint);
        this.eventHandlers.syncUrlState();
      }, DEEP_LINK_INITIAL_DELAY_MS);
    }
  }

  private setupRefreshIntervals(): void {
    // Always refresh news for all variants
    this.refreshScheduler.scheduleRefresh('news', () => this.dataLoader.loadNews(), REFRESH_INTERVALS.feeds);
    // Registration (and its immediate first hydration) is deferred to
    // post-paint idle: freshness badges are below-the-fold decoration, so the
    // fetch must not compete with the LCP-window requests (#4907, #4890).
    scheduleAfterFirstPaint(() => {
      this.refreshScheduler.scheduleRefresh(
        'health-freshness',
        async () => { await refreshDataFreshnessFromHealth(); },
        REFRESH_INTERVALS.healthFreshness,
        undefined,
        { runImmediately: true },
      );
    });

    // Happy variant only refreshes news -- skip all geopolitical/financial/military refreshes
    if (SITE_VARIANT !== 'happy') {
      this.refreshScheduler.registerAll([
        {
          name: 'markets',
          fn: () => this.dataLoader.loadMarkets(),
          intervalMs: REFRESH_INTERVALS.markets,
          condition: () => this.isAnyPanelNearViewport(['markets', 'heatmap', 'commodities', 'crypto', 'crypto-heatmap', 'defi-tokens', 'ai-tokens', 'other-tokens']),
        },
        {
          name: 'predictions',
          fn: () => this.dataLoader.loadPredictions(),
          intervalMs: REFRESH_INTERVALS.predictions,
          condition: () => this.isPanelNearViewport('polymarket'),
        },
        {
          name: 'forecasts',
          fn: () => this.dataLoader.loadForecasts(),
          intervalMs: REFRESH_INTERVALS.forecasts,
          condition: () => this.isPanelNearViewport('forecast'),
        },
        { name: 'pizzint', fn: () => this.dataLoader.loadPizzInt(), intervalMs: REFRESH_INTERVALS.pizzint, condition: () => SITE_VARIANT === 'full' },
        { name: 'natural', fn: () => this.dataLoader.loadNatural(), intervalMs: REFRESH_INTERVALS.natural, condition: () => this.state.mapLayers.natural },
        { name: 'weather', fn: () => this.dataLoader.loadWeatherAlerts(), intervalMs: REFRESH_INTERVALS.weather, condition: () => this.state.mapLayers.weather },
        { name: 'fred', fn: () => this.dataLoader.loadFredData(), intervalMs: REFRESH_INTERVALS.fred, condition: () => this.isPanelNearViewport('economic') },
        { name: 'spending', fn: () => this.dataLoader.loadGovernmentSpending(), intervalMs: REFRESH_INTERVALS.spending, condition: () => this.isPanelNearViewport('economic') },
        { name: 'global-tenders', fn: () => this.dataLoader.loadGlobalTenders(), intervalMs: REFRESH_INTERVALS.spending, condition: () => hasPremiumAccess() && this.isPanelNearViewport('global-procurement') },
        { name: 'bis', fn: () => this.dataLoader.loadBisData(), intervalMs: REFRESH_INTERVALS.bis, condition: () => this.isPanelNearViewport('economic') },
        { name: 'oil', fn: () => this.dataLoader.loadOilAnalytics(), intervalMs: REFRESH_INTERVALS.oil, condition: () => this.isPanelNearViewport('energy-complex') },
        { name: 'firms', fn: () => this.dataLoader.loadFirmsData(), intervalMs: REFRESH_INTERVALS.firms, condition: () => this.shouldRefreshFirms() },
        { name: 'ais', fn: () => this.dataLoader.loadAisSignals(), intervalMs: REFRESH_INTERVALS.ais, condition: () => this.state.mapLayers.ais },
        { name: 'cables', fn: () => this.dataLoader.loadCableActivity(), intervalMs: REFRESH_INTERVALS.cables, condition: () => this.state.mapLayers.cables },
        { name: 'cableHealth', fn: () => this.dataLoader.loadCableHealth(), intervalMs: REFRESH_INTERVALS.cableHealth, condition: () => this.state.mapLayers.cables },
        { name: 'flights', fn: () => this.dataLoader.loadFlightDelays(), intervalMs: REFRESH_INTERVALS.flights, condition: () => this.state.mapLayers.flights },
        {
          name: 'cyberThreats', fn: () => {
            this.state.cyberThreatsCache = null;
            return this.dataLoader.loadCyberThreats();
          }, intervalMs: REFRESH_INTERVALS.cyberThreats, condition: () => CYBER_LAYER_ENABLED && this.state.mapLayers.cyberThreats
        },
      ]);
    }

    if (SITE_VARIANT === 'finance') {
      this.refreshScheduler.scheduleRefresh(
        'stock-analysis',
        () => this.dataLoader.loadStockAnalysis(),
        REFRESH_INTERVALS.stockAnalysis,
        () => hasPremiumAccess() && this.isPanelNearViewport('stock-analysis'),
      );
      this.refreshScheduler.scheduleRefresh(
        'daily-market-brief',
        () => this.dataLoader.loadDailyMarketBrief(),
        REFRESH_INTERVALS.dailyMarketBrief,
        () => hasPremiumAccess() && this.isPanelNearViewport('daily-market-brief'),
      );
      this.refreshScheduler.scheduleRefresh(
        'stock-backtest',
        () => this.dataLoader.loadStockBacktest(),
        REFRESH_INTERVALS.stockBacktest,
        () => hasPremiumAccess() && this.isPanelNearViewport('stock-backtest'),
      );
      this.refreshScheduler.scheduleRefresh(
        'market-implications',
        () => this.dataLoader.loadMarketImplications(),
        REFRESH_INTERVALS.marketImplications,
        () => hasPremiumAccess() && this.isPanelNearViewport('market-implications'),
      );
    }

    // Panel-level refreshes (moved from panel constructors into scheduler for hidden-tab awareness + jitter)
    this.refreshScheduler.scheduleRefresh(
      'service-status',
      () => (this.state.panels['service-status'] as ServiceStatusPanel).fetchStatus(),
      REFRESH_INTERVALS.serviceStatus,
      () => this.isPanelNearViewport('service-status')
    );
    this.refreshScheduler.scheduleRefresh(
      'stablecoins',
      () => (this.state.panels.stablecoins as StablecoinPanel).fetchData(),
      REFRESH_INTERVALS.stablecoins,
      () => this.isPanelNearViewport('stablecoins')
    );
    this.refreshScheduler.scheduleRefresh(
      'energy-crisis',
      () => (this.state.panels['energy-crisis'] as EnergyCrisisPanel).fetchData(),
      REFRESH_INTERVALS.energyCrisis,
      () => this.isPanelNearViewport('energy-crisis')
    );
    this.refreshScheduler.scheduleRefresh(
      'etf-flows',
      () => (this.state.panels['etf-flows'] as ETFFlowsPanel).fetchData(),
      REFRESH_INTERVALS.etfFlows,
      () => this.isPanelNearViewport('etf-flows')
    );
    this.refreshScheduler.scheduleRefresh(
      'macro-signals',
      () => (this.state.panels['macro-signals'] as MacroSignalsPanel).fetchData(),
      REFRESH_INTERVALS.macroSignals,
      () => this.isPanelNearViewport('macro-signals')
    );
    this.refreshScheduler.scheduleRefresh(
      'defense-patents',
      () => { (this.state.panels['defense-patents'] as DefensePatentsPanel).refresh(); return Promise.resolve(); },
      REFRESH_INTERVALS.defensePatents,
      () => this.isPanelNearViewport('defense-patents')
    );
    this.refreshScheduler.scheduleRefresh(
      'fear-greed',
      () => (this.state.panels['fear-greed'] as FearGreedPanel).fetchData(),
      REFRESH_INTERVALS.fearGreed,
      () => this.isPanelNearViewport('fear-greed')
    );
    this.refreshScheduler.scheduleRefresh(
      'hormuz-tracker',
      () => (this.state.panels['hormuz-tracker'] as HormuzPanel).fetchData(),
      REFRESH_INTERVALS.hormuzTracker,
      () => this.isPanelNearViewport('hormuz-tracker')
    );
    this.refreshScheduler.scheduleRefresh(
      'positioning-247',
      () => (this.state.panels['positioning-247'] as PositioningPanel).fetchData(),
      REFRESH_INTERVALS.hyperliquidFlow,
      () => this.isPanelNearViewport('positioning-247')
    );
    this.refreshScheduler.scheduleRefresh(
      'strategic-posture',
      () => (this.state.panels['strategic-posture'] as StrategicPosturePanel).refresh(),
      REFRESH_INTERVALS.strategicPosture,
      () => this.isPanelNearViewport('strategic-posture')
    );
    this.refreshScheduler.scheduleRefresh(
      'strategic-risk',
      () => (this.state.panels['strategic-risk'] as StrategicRiskPanel).refresh(),
      REFRESH_INTERVALS.strategicRisk,
      () => this.isPanelNearViewport('strategic-risk')
    );

    this.refreshScheduler.scheduleRefresh(
      'wsb-tickers',
      () => this.dataLoader.loadWsbTickers(),
      REFRESH_INTERVALS.wsbTickers,
      () => hasPremiumAccess() && this.isPanelNearViewport('wsb-ticker-scanner'),
    );

    // Server-side temporal anomalies (news + satellite_fires)
    if (SITE_VARIANT !== 'happy') {
      this.refreshScheduler.scheduleRefresh('temporalBaseline', () => this.dataLoader.refreshTemporalBaseline(), REFRESH_INTERVALS.temporalBaseline, () => this.shouldRefreshIntelligence());
    }

    // WTO trade policy data — annual data, poll every 10 min to avoid hammering upstream.
    // PRO-gated: the isNearViewport check is a visibility gate, not an entitlement gate,
    // so without hasPremiumAccess() here we'd still hit the 6 WTO RPCs every poll for
    // free users once the panel scrolled into view.
    if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance' || SITE_VARIANT === 'commodity' || SITE_VARIANT === 'energy') {
      this.refreshScheduler.scheduleRefresh('tradePolicy', () => this.dataLoader.loadTradePolicy(), REFRESH_INTERVALS.tradePolicy, () => hasPremiumAccess() && this.isPanelNearViewport('trade-policy'));
      this.refreshScheduler.scheduleRefresh('supplyChain', () => this.dataLoader.loadSupplyChain(), REFRESH_INTERVALS.supplyChain, () => this.isPanelNearViewport('supply-chain'));
      this.refreshScheduler.scheduleRefresh('chinaCorridors', () => this.dataLoader.loadChinaCorridors(), REFRESH_INTERVALS.chinaCorridors, () => this.isPanelNearViewport('china-corridors'));
      this.refreshScheduler.scheduleRefresh('chinaActivityNowcast', () => this.dataLoader.loadChinaActivityNowcast(), REFRESH_INTERVALS.chinaActivityNowcast, () => this.isPanelNearViewport('china-activity-nowcast'));
    }

    this.refreshScheduler.scheduleRefresh(
      'cross-source-signals',
      () => this.dataLoader.loadCrossSourceSignals(),
      REFRESH_INTERVALS.crossSourceSignals,
      () => this.isPanelNearViewport('cross-source-signals'),
    );

    // Telegram Intel (near real-time, 60s refresh)
    this.refreshScheduler.scheduleRefresh(
      'telegram-intel',
      () => this.dataLoader.loadTelegramIntel(),
      REFRESH_INTERVALS.telegramIntel,
      () => this.isPanelNearViewport('telegram-intel')
    );

    this.refreshScheduler.scheduleRefresh(
      'gulf-economies',
      () => (this.state.panels['gulf-economies'] as GulfEconomiesPanel).fetchData(),
      REFRESH_INTERVALS.gulfEconomies,
      () => this.isPanelNearViewport('gulf-economies')
    );

    this.refreshScheduler.scheduleRefresh(
      'grocery-basket',
      () => (this.state.panels['grocery-basket'] as GroceryBasketPanel).fetchData(),
      REFRESH_INTERVALS.groceryBasket,
      () => this.isPanelNearViewport('grocery-basket')
    );

    this.refreshScheduler.scheduleRefresh(
      'bigmac',
      () => (this.state.panels['bigmac'] as BigMacPanel).fetchData(),
      REFRESH_INTERVALS.groceryBasket,
      () => this.isPanelNearViewport('bigmac')
    );

    this.refreshScheduler.scheduleRefresh(
      'fuel-prices',
      () => (this.state.panels['fuel-prices'] as FuelPricesPanel).fetchData(),
      REFRESH_INTERVALS.fuelPrices,
      () => this.isPanelNearViewport('fuel-prices')
    );

    this.refreshScheduler.scheduleRefresh(
      'fx',
      () => (this.state.panels['fx'] as FxPanel).fetchData(),
      REFRESH_INTERVALS.fx,
      () => this.isPanelNearViewport('fx')
    );

    this.refreshScheduler.scheduleRefresh(
      'fao-food-price-index',
      () => (this.state.panels['fao-food-price-index'] as FaoFoodPriceIndexPanel).fetchData(),
      REFRESH_INTERVALS.faoFoodPriceIndex,
      () => this.isPanelNearViewport('fao-food-price-index')
    );

    this.refreshScheduler.scheduleRefresh(
      'oil-inventories',
      () => (this.state.panels['oil-inventories'] as OilInventoriesPanel).fetchData(),
      REFRESH_INTERVALS.oilInventories,
      () => this.isPanelNearViewport('oil-inventories')
    );

    this.refreshScheduler.scheduleRefresh(
      'pipeline-status',
      () => (this.state.panels['pipeline-status'] as PipelineStatusPanel).fetchData(),
      REFRESH_INTERVALS.pipelineStatus,
      () => this.isPanelNearViewport('pipeline-status')
    );

    this.refreshScheduler.scheduleRefresh(
      'storage-facility-map',
      () => (this.state.panels['storage-facility-map'] as StorageFacilityMapPanel).fetchData(),
      REFRESH_INTERVALS.storageFacilityMap,
      () => this.isPanelNearViewport('storage-facility-map')
    );

    this.refreshScheduler.scheduleRefresh(
      'fuel-shortages',
      () => (this.state.panels['fuel-shortages'] as FuelShortagePanel).fetchData(),
      REFRESH_INTERVALS.fuelShortages,
      () => this.isPanelNearViewport('fuel-shortages')
    );

    this.refreshScheduler.scheduleRefresh(
      'energy-disruptions',
      () => (this.state.panels['energy-disruptions'] as EnergyDisruptionsPanel).fetchData(),
      REFRESH_INTERVALS.energyDisruptions,
      () => this.isPanelNearViewport('energy-disruptions')
    );

    this.refreshScheduler.scheduleRefresh(
      'energy-risk-overview',
      () => (this.state.panels['energy-risk-overview'] as EnergyRiskOverviewPanel).fetchData(),
      REFRESH_INTERVALS.energyRiskOverview,
      () => this.isPanelNearViewport('energy-risk-overview')
    );

    this.refreshScheduler.scheduleRefresh(
      'chokepoint-strip',
      () => (this.state.panels['chokepoint-strip'] as ChokepointStripPanel).fetchData(),
      REFRESH_INTERVALS.chokepointStrip,
      () => this.isPanelNearViewport('chokepoint-strip')
    );

    this.refreshScheduler.scheduleRefresh(
      'climate-news',
      () => (this.state.panels['climate-news'] as ClimateNewsPanel).fetchData(),
      REFRESH_INTERVALS.climateNews,
      () => this.isPanelNearViewport('climate-news')
    );

    this.refreshScheduler.scheduleRefresh(
      'macro-tiles',
      () => (this.state.panels['macro-tiles'] as MacroTilesPanel).fetchData(),
      REFRESH_INTERVALS.macroTiles,
      () => this.isPanelNearViewport('macro-tiles')
    );
    this.refreshScheduler.scheduleRefresh(
      'fsi',
      () => (this.state.panels['fsi'] as FSIPanel).fetchData(),
      REFRESH_INTERVALS.fsi,
      () => this.isPanelNearViewport('fsi')
    );
    this.refreshScheduler.scheduleRefresh(
      'yield-curve',
      () => (this.state.panels['yield-curve'] as YieldCurvePanel).fetchData(),
      REFRESH_INTERVALS.yieldCurve,
      () => this.isPanelNearViewport('yield-curve')
    );
    this.refreshScheduler.scheduleRefresh(
      'earnings-calendar',
      () => (this.state.panels['earnings-calendar'] as EarningsCalendarPanel).fetchData(),
      REFRESH_INTERVALS.earningsCalendar,
      () => this.isPanelNearViewport('earnings-calendar')
    );
    this.refreshScheduler.scheduleRefresh(
      'economic-calendar',
      () => (this.state.panels['economic-calendar'] as EconomicCalendarPanel).fetchData(),
      REFRESH_INTERVALS.economicCalendar,
      () => this.isPanelNearViewport('economic-calendar')
    );
    this.refreshScheduler.scheduleRefresh(
      'cot-positioning',
      () => (this.state.panels['cot-positioning'] as CotPositioningPanel).fetchData(),
      REFRESH_INTERVALS.cotPositioning,
      () => this.isPanelNearViewport('cot-positioning')
    );
    this.refreshScheduler.scheduleRefresh(
      'gold-intelligence',
      () => (this.state.panels['gold-intelligence'] as GoldIntelligencePanel).fetchData(),
      REFRESH_INTERVALS.goldIntelligence,
      () => this.isPanelNearViewport('gold-intelligence')
    );
    this.refreshScheduler.scheduleRefresh(
      'aaii-sentiment',
      () => this.dataLoader.loadAaiiSentiment(),
      REFRESH_INTERVALS.aaiiSentiment,
      () => this.isPanelNearViewport('aaii-sentiment')
    );
    this.refreshScheduler.scheduleRefresh(
      'market-breadth',
      () => this.dataLoader.loadMarketBreadth(),
      REFRESH_INTERVALS.marketBreadth,
      () => this.isPanelNearViewport('market-breadth')
    );

    // Refresh intelligence signals for CII (geopolitical variant only)
    if (SITE_VARIANT === 'full') {
      this.refreshScheduler.scheduleRefresh('intelligence', () => {
        const { military, iranEvents } = this.state.intelligenceCache;
        this.state.intelligenceCache = {};
        if (military) this.state.intelligenceCache.military = military;
        if (iranEvents) this.state.intelligenceCache.iranEvents = iranEvents;
        return this.dataLoader.loadIntelligenceSignals();
      }, REFRESH_INTERVALS.intelligence, () => this.shouldRefreshIntelligence());
    }

    // Correlation engine refresh
    this.refreshScheduler.scheduleRefresh(
      'correlation-engine',
      async () => {
        await this.runCorrelationEngine();
      },
      REFRESH_INTERVALS.correlationEngine,
      () => this.shouldRefreshCorrelation(),
    );
  }
}
