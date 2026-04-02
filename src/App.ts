import type { Monitor, PanelConfig, MapLayers } from '@/types';
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
  FREE_MAX_PANELS,
  FREE_MAX_SOURCES,
} from '@/config';
import { sanitizeLayersForVariant } from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { initDB, cleanOldSnapshots } from '@/services';
import { isProUser } from '@/services/widget-store';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { loadFromStorage, parseMapUrlState, saveToStorage, isMobileDevice } from '@/utils';
import type { ParsedMapUrlState } from '@/utils';
import { BreakingNewsBanner } from '@/components';
import { initBreakingNewsAlerts, destroyBreakingNewsAlerts } from '@/services/breaking-news-alerts';
import { isDesktopRuntime, waitForSidecarReady } from '@/services/runtime';
import { BETA_MODE } from '@/config/beta';
import { trackEvent, initAuthAnalytics } from '@/services/analytics';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { initI18n, t } from '@/services/i18n';

import { computeDefaultDisabledSources, getLocaleBoostedSources, getTotalFeedCount, FEEDS, INTEL_SOURCES } from '@/config/feeds';
import { fetchBootstrapData, getBootstrapHydrationState, markBootstrapAsLive, type BootstrapHydrationState } from '@/services/bootstrap';
import { describeFreshness } from '@/services/persistent-cache';
import { DesktopUpdater } from '@/app/desktop-updater';
import { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import { resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';
import { showProBanner } from '@/components/ProBanner';
import { initAuthState, subscribeAuthState } from '@/services/auth-state';
import { install as installCloudPrefsSync, onSignIn as cloudPrefsSignIn, onSignOut as cloudPrefsSignOut } from '@/utils/cloud-prefs-sync';

export class App {
  private state: AppContext;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager;
  private refreshScheduler: RefreshScheduler;
  private desktopUpdater: DesktopUpdater;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;
  private unsubFreeTier: (() => void) | null = null;
  private visiblePanelPrimed = new Set<string>();
  private visiblePanelPrimeRaf: number | null = null;
  private bootstrapHydrationState: BootstrapHydrationState = getBootstrapHydrationState();
  private cachedModeBannerEl: HTMLElement | null = null;
  private readonly handleViewportPrime = (): void => {
    if (this.visiblePanelPrimeRaf !== null) return;
    this.visiblePanelPrimeRaf = window.requestAnimationFrame(() => {
      this.visiblePanelPrimeRaf = null;
      void this.primeVisiblePanelData();
    });
  };
  private readonly handleConnectivityChange = (): void => {
    this.updateConnectivityUi();
  };

  private isPanelNearViewport(panelId: string, marginPx = 400): boolean {
    const panel = this.state.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = 400): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
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
    const primeTask = (key: string, task: () => Promise<unknown>): void => {
      if (this.visiblePanelPrimed.has(key) || this.state.inFlight.has(key)) return;
      const wrapped = (async () => {
        this.state.inFlight.add(key);
        try {
          await task();
          this.visiblePanelPrimed.add(key);
        } finally {
          this.state.inFlight.delete(key);
        }
      })();
      tasks.push(wrapped);
    };

    const shouldPrimeAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    // REIT data priming
    if (shouldPrimeAny(['reits', 'reit-correlation', 'reit-social'])) {
      primeTask('reits', () => this.dataLoader.loadReits());
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);

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
    const isDynamicPanel = (k: string) => k === 'runtime-config' || k.startsWith('cw-') || k.startsWith('mcp-');

    // Check if variant changed - reset all settings to variant defaults
    const storedVariant = localStorage.getItem('worldmonitor-variant');
    const currentVariant = SITE_VARIANT;
    console.log(`[App] Variant check: stored="${storedVariant}", current="${currentVariant}"`);
    if (storedVariant !== currentVariant) {
      // Variant changed — seed new variant's panels, disable panels not in the new variant
      console.log('[App] Variant changed - seeding new defaults, disabling cross-variant panels');
      localStorage.setItem('worldmonitor-variant', currentVariant);
      // Reset map layers for the new variant (map layers are not user-personalized the same way)
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant);
      // Load existing panel prefs (if any), disable panels not belonging to the new variant
      panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
      const newVariantKeys = new Set(VARIANT_DEFAULTS[currentVariant] ?? []);
      for (const key of Object.keys(panelSettings)) {
        if (!newVariantKeys.has(key) && !isDynamicPanel(key) && panelSettings[key]) {
          panelSettings[key] = { ...panelSettings[key]!, enabled: false };
        }
      }
      for (const key of newVariantKeys) {
        if (!(key in panelSettings)) {
          panelSettings[key] = { ...getEffectivePanelConfig(key, currentVariant) };
        }
      }
    } else {
      mapLayers = sanitizeLayersForVariant(
        loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers),
        currentVariant as MapVariant,
      );
      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );

      // One-time migration: preserve user preferences across panel key renames.
      const PANEL_KEY_RENAMES_MIGRATION_KEY = 'worldmonitor-panel-key-renames-v2.6';
      if (!localStorage.getItem(PANEL_KEY_RENAMES_MIGRATION_KEY)) {
        const keyRenames: Array<[string, string]> = [
          ['live-youtube', 'live-webcams'],
          ['pinned-webcams', 'windy-webcams'],
        ];
        let migrated = false;
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
          if (!happyKeys.has(key) && !isDynamicPanel(key) && panelSettings[key]?.enabled) {
            panelSettings[key] = { ...panelSettings[key]!, enabled: false };
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
        localStorage.removeItem(PANEL_SPANS_KEY);
        console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
      }
      localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
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
      mapLayers = sanitizeLayersForVariant(initialUrlState.layers, currentVariant as MapVariant);
      initialUrlState.layers = mapLayers;
    }
    // One-time migration: reduce default-enabled sources (full variant only)
    if (currentVariant === 'full') {
      const baseKey = 'worldmonitor-sources-reduction-v3';
      if (!localStorage.getItem(baseKey)) {
        const defaultDisabled = computeDefaultDisabledSources();
        saveToStorage(STORAGE_KEYS.disabledFeeds, defaultDisabled);
        localStorage.setItem(baseKey, 'done');
        const total = getTotalFeedCount();
        console.log(`[App] Sources reduction: ${defaultDisabled.length} disabled, ${total - defaultDisabled.length} enabled`);
      }
      // Locale boost: additively enable locale-matched sources (runs once per locale)
      const userLang = ((navigator.language ?? 'en').split('-')[0] ?? 'en').toLowerCase();
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
      panelSettings,
      mapLayers,
      allNews: [],
      newsByCategory: {},
      latestMarkets: [],
      latestPredictions: [],
      latestClusters: [],
      intelligenceCache: {},
      cyberThreatsCache: null,
      disabledSources,
      currentTimeRange: '7d',
      inFlight: new Set(),
      seenGeoAlerts: new Set(),
      monitors,
      signalModal: null,
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
      resolvedLocation: 'global',
      initialUrlState,
      PANEL_ORDER_KEY,
      PANEL_SPANS_KEY,
    };

    // Instantiate modules (callbacks wired after all modules exist)
    this.refreshScheduler = new RefreshScheduler(this.state);
    this.desktopUpdater = new DesktopUpdater(this.state);

    this.dataLoader = new DataLoaderManager(this.state, {
      renderCriticalBanner: (_postures) => { /* no-op in REITs mode */ },
      refreshOpenCountryBrief: () => { /* no-op in REITs mode */ },
    });

    this.searchManager = new SearchManager(this.state, {
      openCountryBriefByCode: (_code: string, _country: string) => { /* no-op in REITs mode */ },
    });

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: (_code: string, _name: string) => { /* no-op in REITs mode */ },
      openCountryBrief: (_code: string) => { /* no-op in REITs mode */ },
      loadAllData: () => this.dataLoader.loadAllData(),
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      loadSecurityAdvisories: () => Promise.resolve(),
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      updateSearchIndex: () => this.searchManager.updateSearchIndex(),
      loadAllData: () => this.dataLoader.loadAllData(),
      flushStaleRefreshes: () => this.refreshScheduler.flushStaleRefreshes(),
      setHiddenSince: (ts: number) => this.refreshScheduler.setHiddenSince(ts),
      loadDataForLayer: (layer: string) => { void this.dataLoader.loadDataForLayer(layer as keyof MapLayers); },
      waitForAisData: () => Promise.resolve(),
      syncDataFreshnessWithLayers: () => { /* no-op in REITs mode */ },
      ensureCorrectZones: () => this.panelLayout.ensureCorrectZones(),
      refreshOpenCountryBrief: () => { /* no-op in REITs mode */ },
      stopLayerActivity: (layer: keyof MapLayers) => this.dataLoader.stopLayerActivity(layer),
      mountLiveNewsIfReady: () => this.panelLayout.mountLiveNewsIfReady(),
      updateFlightSource: (_adsb: unknown, _military: unknown) => { /* no-op in REITs mode */ },
    });

    // Wire cross-module callback: DataLoader → SearchManager
    this.dataLoader.updateSearchIndex = () => this.searchManager.updateSearchIndex();

    // Track destroy order (reverse of init)
    this.modules = [
      this.desktopUpdater,
      this.panelLayout,
      this.searchManager,
      this.dataLoader,
      this.refreshScheduler,
      this.eventHandlers,
    ];
  }

  public async init(): Promise<void> {
    const initStart = performance.now();
    await initDB();
    await initI18n();
    const aiFlow = getAiFlowSettings();
    if (aiFlow.browserModel || isDesktopRuntime()) {
      await mlWorker.init();
      if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => { });
    }

    if (aiFlow.headlineMemory) {
      mlWorker.init().then(ok => {
        if (ok) mlWorker.loadModel('embeddings').catch(() => { });
      }).catch(() => { });
    }

    this.unsubAiFlow = subscribeAiFlowChange((key) => {
      if (key === 'browserModel') {
        const s = getAiFlowSettings();
        if (s.browserModel) {
          mlWorker.init();
        } else if (!isHeadlineMemoryEnabled()) {
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

    // Wait for sidecar readiness on desktop so bootstrap hits a live server
    if (isDesktopRuntime()) {
      await waitForSidecarReady(3000);
    }

    // Hydrate in-memory cache from bootstrap endpoint (before panels construct and fetch)
    await fetchBootstrapData();
    this.bootstrapHydrationState = getBootstrapHydrationState();

    // Verify OAuth OTT and hydrate auth session BEFORE any UI subscribes to auth state
    await initAuthState();
    if (isProUser()) {
      initAuthAnalytics();
    }
    installCloudPrefsSync(SITE_VARIANT);
    this.enforceFreeTierLimits();

    let _prevUserId: string | null = null;
    this.unsubFreeTier = subscribeAuthState((session) => {
      this.enforceFreeTierLimits();
      const userId = session.user?.id ?? null;
      if (userId !== null && userId !== _prevUserId) {
        void cloudPrefsSignIn(userId, SITE_VARIANT);
      } else if (userId === null && _prevUserId !== null) {
        cloudPrefsSignOut();
      }
      _prevUserId = userId;
    });


    const geoCoordsPromise: Promise<PreciseCoordinates | null> =
      this.state.isMobile && this.state.initialUrlState?.lat === undefined && this.state.initialUrlState?.lon === undefined
        ? resolvePreciseUserCoordinates(5000)
        : Promise.resolve(null);

    const resolvedRegion = await resolveUserRegion();
    this.state.resolvedLocation = resolvedRegion;

    // Phase 1: Layout (creates map + panels — they'll find hydrated data)
    this.panelLayout.init();
    showProBanner(this.state.container);
    this.updateConnectivityUi();
    window.addEventListener('online', this.handleConnectivityChange);
    window.addEventListener('offline', this.handleConnectivityChange);

    const mobileGeoCoords = await geoCoordsPromise;
    if (mobileGeoCoords && this.state.map) {
      this.state.map.setCenter(mobileGeoCoords.lat, mobileGeoCoords.lon, 6);
    }

    // Phase 2: Shared UI components
    if (!this.state.isMobile) {
      initBreakingNewsAlerts();
      this.state.breakingBanner = new BreakingNewsBanner();
    }

    // Phase 3: UI setup methods
    this.eventHandlers.startHeaderClock();
    this.eventHandlers.setupPlaybackControl();
    this.eventHandlers.setupStatusPanel();
    this.eventHandlers.setupPizzIntIndicator();
    this.eventHandlers.setupLlmStatusIndicator();
    this.eventHandlers.setupExportPanel();

    this.eventHandlers.setupUnifiedSettings();
    if (isProUser()) this.eventHandlers.setupAuthWidget();

    // Phase 4: SearchManager, MapLayerHandlers
    this.searchManager.init();
    this.eventHandlers.setupMapLayerHandlers();

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    this.eventHandlers.setupUrlStateSync();
    this.handleDeepLinks();

    // Phase 6: Data loading
    await preloadCountryGeometry();
    // Prime panel-specific data concurrently with bulk loading.
    // primeVisiblePanelData owns ETF, Stablecoins, Gulf Economies, etc. that
    // are NOT part of loadAllData. Running them in parallel prevents those
    // panels from being blocked when a loadAllData batch is slow.
    window.addEventListener('scroll', this.handleViewportPrime, { passive: true });
    window.addEventListener('resize', this.handleViewportPrime);
    await Promise.all([
      this.dataLoader.loadAllData(true),
      this.primeVisiblePanelData(true),
    ]);

    // If bootstrap was served from cache but live data just loaded, promote the status indicator
    markBootstrapAsLive();
    this.bootstrapHydrationState = getBootstrapHydrationState();
    this.updateConnectivityUi();

    // No correlation engine or layer hiding needed in REITs-only mode

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

  /**
   * Enforce free-tier panel and source limits.
   * Reads current values from storage, trims if necessary, and saves back.
   * Safe to call multiple times (idempotent) — e.g. on auth state changes.
   */
  private enforceFreeTierLimits(): void {
    if (isProUser()) return;

    // --- Panel limit ---
    const panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
    let cwDisabled = false;
    for (const key of Object.keys(panelSettings)) {
      if (key.startsWith('cw-') && panelSettings[key]?.enabled) {
        panelSettings[key] = { ...panelSettings[key]!, enabled: false };
        cwDisabled = true;
      }
    }
    const enabledKeys = Object.entries(panelSettings)
      .filter(([k, v]) => v.enabled && !k.startsWith('cw-'))
      .sort(([ka, a], [kb, b]) => (a.priority ?? 99) - (b.priority ?? 99) || ka.localeCompare(kb))
      .map(([k]) => k);
    const needsTrim = enabledKeys.length > FREE_MAX_PANELS;
    if (needsTrim) {
      for (const key of enabledKeys.slice(FREE_MAX_PANELS)) {
        panelSettings[key] = { ...panelSettings[key]!, enabled: false };
      }
      console.log(`[App] Free tier: trimmed ${enabledKeys.length - FREE_MAX_PANELS} panel(s) to enforce ${FREE_MAX_PANELS}-panel limit`);
    }
    if (cwDisabled || needsTrim) saveToStorage(STORAGE_KEYS.panels, panelSettings);

    // --- Source limit ---
    const disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
    const allSourceNames = (() => {
      const s = new Set<string>();
      Object.values(FEEDS).forEach(feeds => feeds?.forEach(f => s.add(f.name)));
      INTEL_SOURCES.forEach(f => s.add(f.name));
      return Array.from(s).sort((a, b) => a.localeCompare(b));
    })();
    const currentlyEnabled = allSourceNames.filter(n => !disabledSources.has(n));
    const enabledCount = currentlyEnabled.length;
    if (enabledCount > FREE_MAX_SOURCES) {
      const toDisable = enabledCount - FREE_MAX_SOURCES;
      for (const name of currentlyEnabled.slice(FREE_MAX_SOURCES)) {
        disabledSources.add(name);
      }
      saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(disabledSources));
      console.log(`[App] Free tier: disabled ${toDisable} source(s) to enforce ${FREE_MAX_SOURCES}-source limit`);
    }
  }

  public destroy(): void {
    this.state.isDestroyed = true;
    window.removeEventListener('scroll', this.handleViewportPrime);
    window.removeEventListener('resize', this.handleViewportPrime);
    window.removeEventListener('online', this.handleConnectivityChange);
    window.removeEventListener('offline', this.handleConnectivityChange);
    if (this.visiblePanelPrimeRaf !== null) {
      window.cancelAnimationFrame(this.visiblePanelPrimeRaf);
      this.visiblePanelPrimeRaf = null;
    }

    // Destroy all modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      this.modules[i]!.destroy();
    }

    // Clean up subscriptions, map, and breaking news
    this.unsubAiFlow?.();
    this.unsubFreeTier?.();
    this.state.breakingBanner?.destroy();
    destroyBreakingNewsAlerts();
    this.cachedModeBannerEl?.remove();
    this.cachedModeBannerEl = null;
    this.state.map?.destroy();
  }

  private handleDeepLinks(): void {
    // Deep links for country briefs not available in REITs-only mode
  }

  private setupRefreshIntervals(): void {
    // Always refresh news
    this.refreshScheduler.scheduleRefresh('news', () => this.dataLoader.loadNews(), REFRESH_INTERVALS.feeds);

    // REIT data refresh
    this.refreshScheduler.scheduleRefresh(
      'reits',
      () => this.dataLoader.loadReits(),
      REFRESH_INTERVALS.markets,
      () => this.isAnyPanelNearViewport(['reits', 'reit-correlation', 'reit-social']),
    );
  }
}
