import type { Monitor, PanelConfig, MapLayers } from '@/types';
import type { AppContext } from '@/app/app-context';
import {
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
} from '@/config';
import { sanitizeLayersForVariant } from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { initDB, cleanOldSnapshots, isAisConfigured, initAisStream, isOutagesConfigured, disconnectAisStream } from '@/services';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { startLearning } from '@/services/country-instability';
import { loadFromStorage, parseMapUrlState, saveToStorage, isMobileDevice } from '@/utils';
import type { ParsedMapUrlState } from '@/utils';
import { SignalModal, IntelligenceGapBadge, BreakingNewsBanner } from '@/components';
import { initBreakingNewsAlerts, destroyBreakingNewsAlerts } from '@/services/breaking-news-alerts';
import type { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import type { StablecoinPanel } from '@/components/StablecoinPanel';
import type { ETFFlowsPanel } from '@/components/ETFFlowsPanel';
import type { MacroSignalsPanel } from '@/components/MacroSignalsPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { StrategicRiskPanel } from '@/components/StrategicRiskPanel';
import type { GulfEconomiesPanel } from '@/components/GulfEconomiesPanel';
import { isDesktopRuntime, waitForSidecarReady } from '@/services/runtime';
import { getSecretState } from '@/services/runtime-config';
import { BETA_MODE } from '@/config/beta';
import { trackEvent, trackDeeplinkOpened } from '@/services/analytics';
import { preloadCountryGeometry, getCountryNameByCode } from '@/services/country-geometry';
import { initI18n } from '@/services/i18n';

import { computeDefaultDisabledSources, getLocaleBoostedSources, getTotalFeedCount } from '@/config/feeds';
import { fetchBootstrapData } from '@/services/bootstrap';
import { DesktopUpdater } from '@/app/desktop-updater';
import { CountryIntelManager } from '@/app/country-intel';
import { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import { resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';
import { showProBanner } from '@/components/ProBanner';
import {
  CorrelationEngine,
  militaryAdapter,
  escalationAdapter,
  economicAdapter,
  disasterAdapter,
} from '@/services/correlation-engine';
import type { CorrelationPanel } from '@/components/CorrelationPanel';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export type { CountryBriefSignals } from '@/app/app-context';

export class App {
  private state: AppContext;
  private pendingDeepLinkCountry: string | null = null;
  private pendingDeepLinkExpanded = false;
  private pendingDeepLinkStoryCode: string | null = null;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager;
  private countryIntel: CountryIntelManager;
  private refreshScheduler: RefreshScheduler;
  private desktopUpdater: DesktopUpdater;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;
  private visiblePanelPrimed = new Set<string>();
  private visiblePanelPrimeRaf: number | null = null;
  private readonly handleViewportPrime = (): void => {
    if (this.visiblePanelPrimeRaf !== null) return;
    this.visiblePanelPrimeRaf = window.requestAnimationFrame(() => {
      this.visiblePanelPrimeRaf = null;
      void this.primeVisiblePanelData();
    });
  };

  private isPanelNearViewport(panelId: string, marginPx = 400): boolean {
    const panel = this.state.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = 400): boolean {
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

    const shouldPrime = (id: string): boolean => forceAll || this.isPanelNearViewport(id);
    const shouldPrimeAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    if (shouldPrime('service-status')) {
      const panel = this.state.panels['service-status'] as ServiceStatusPanel | undefined;
      if (panel) primeTask('service-status', () => panel.fetchStatus());
    }
    if (shouldPrime('macro-signals')) {
      const panel = this.state.panels['macro-signals'] as MacroSignalsPanel | undefined;
      if (panel) primeTask('macro-signals', () => panel.fetchData());
    }
    if (shouldPrime('etf-flows')) {
      const panel = this.state.panels['etf-flows'] as ETFFlowsPanel | undefined;
      if (panel) primeTask('etf-flows', () => panel.fetchData());
    }
    if (shouldPrime('stablecoins')) {
      const panel = this.state.panels.stablecoins as StablecoinPanel | undefined;
      if (panel) primeTask('stablecoins', () => panel.fetchData());
    }
    if (shouldPrime('telegram-intel')) {
      primeTask('telegram-intel', () => this.dataLoader.loadTelegramIntel());
    }
    if (shouldPrime('gulf-economies')) {
      const panel = this.state.panels['gulf-economies'] as GulfEconomiesPanel | undefined;
      if (panel) primeTask('gulf-economies', () => panel.fetchData());
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
    if (shouldPrime('energy-complex')) {
      primeTask('oil', () => this.dataLoader.loadOilAnalytics());
    }
    if (shouldPrime('trade-policy')) {
      primeTask('tradePolicy', () => this.dataLoader.loadTradePolicy());
    }
    if (shouldPrime('supply-chain')) {
      primeTask('supplyChain', () => this.dataLoader.loadSupplyChain());
    }
    if (SITE_VARIANT === 'finance' && getSecretState('WORLDMONITOR_API_KEY').present) {
      if (shouldPrime('stock-analysis')) {
        primeTask('stockAnalysis', () => this.dataLoader.loadStockAnalysis());
      }
      if (shouldPrime('stock-backtest')) {
        primeTask('stockBacktest', () => this.dataLoader.loadStockBacktest());
      }
      if (shouldPrime('daily-market-brief')) {
        primeTask('dailyMarketBrief', () => this.dataLoader.loadDailyMarketBrief());
      }
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

    // Check if variant changed - reset all settings to variant defaults
    const storedVariant = localStorage.getItem('worldmonitor-variant');
    const currentVariant = SITE_VARIANT;
    console.log(`[App] Variant check: stored="${storedVariant}", current="${currentVariant}"`);
    if (storedVariant !== currentVariant) {
      // Variant changed - use defaults for new variant, clear old settings
      console.log('[App] Variant changed - resetting to defaults');
      localStorage.setItem('worldmonitor-variant', currentVariant);
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      localStorage.removeItem(STORAGE_KEYS.panels);
      localStorage.removeItem(PANEL_ORDER_KEY);
      localStorage.removeItem(PANEL_ORDER_KEY + '-bottom');
      localStorage.removeItem(PANEL_ORDER_KEY + '-bottom-set');
      localStorage.removeItem(PANEL_SPANS_KEY);
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant);
      panelSettings = { ...DEFAULT_PANELS };
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

      // Merge in any new panels that didn't exist when settings were saved
      for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
        if (!(key in panelSettings)) {
          panelSettings[key] = { ...config };
        }
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
      const validKeys = new Set(Object.keys(DEFAULT_PANELS));
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
      if (!panelSettings['runtime-config']) {
        panelSettings['runtime-config'] = {
          name: 'Desktop Configuration',
          enabled: true,
          priority: 2,
        };
        saveToStorage(STORAGE_KEYS.panels, panelSettings);
      }
    }

    const initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      mapLayers = sanitizeLayersForVariant(initialUrlState.layers, currentVariant as MapVariant);
      initialUrlState.layers = mapLayers;
    }
    if (!CYBER_LAYER_ENABLED) {
      mapLayers.cyberThreats = false;
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
    this.countryIntel = new CountryIntelManager(this.state);
    this.desktopUpdater = new DesktopUpdater(this.state);

    this.dataLoader = new DataLoaderManager(this.state, {
      renderCriticalBanner: (postures) => this.panelLayout.renderCriticalBanner(postures),
      refreshOpenCountryBrief: () => this.countryIntel.refreshOpenBrief(),
    });

    this.searchManager = new SearchManager(this.state, {
      openCountryBriefByCode: (code, country) => this.countryIntel.openCountryBriefByCode(code, country),
    });

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: (code, name) => this.countryIntel.openCountryStory(code, name),
      openCountryBrief: (code) => {
        const name = CountryIntelManager.resolveCountryName(code);
        void this.countryIntel.openCountryBriefByCode(code, name);
      },
      loadAllData: () => this.dataLoader.loadAllData(),
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      loadSecurityAdvisories: () => this.dataLoader.loadSecurityAdvisories(),
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      updateSearchIndex: () => this.searchManager.updateSearchIndex(),
      loadAllData: () => this.dataLoader.loadAllData(),
      flushStaleRefreshes: () => this.refreshScheduler.flushStaleRefreshes(),
      setHiddenSince: (ts) => this.refreshScheduler.setHiddenSince(ts),
      loadDataForLayer: (layer) => { void this.dataLoader.loadDataForLayer(layer as keyof MapLayers); },
      waitForAisData: () => this.dataLoader.waitForAisData(),
      syncDataFreshnessWithLayers: () => this.dataLoader.syncDataFreshnessWithLayers(),
      ensureCorrectZones: () => this.panelLayout.ensureCorrectZones(),
      refreshOpenCountryBrief: () => this.countryIntel.refreshOpenBrief(),
      stopLayerActivity: (layer) => this.dataLoader.stopLayerActivity(layer),
    });

    // Wire cross-module callback: DataLoader → SearchManager
    this.dataLoader.updateSearchIndex = () => this.searchManager.updateSearchIndex();

    // Track destroy order (reverse of init)
    this.modules = [
      this.desktopUpdater,
      this.panelLayout,
      this.countryIntel,
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

    // Check AIS configuration before init
    if (!isAisConfigured()) {
      this.state.mapLayers.ais = false;
    } else if (this.state.mapLayers.ais) {
      initAisStream();
    }

    // Wait for sidecar readiness on desktop so bootstrap hits a live server
    if (isDesktopRuntime()) {
      await waitForSidecarReady(3000);
    }

    // Hydrate in-memory cache from bootstrap endpoint (before panels construct and fetch)
    await fetchBootstrapData();

    const geoCoordsPromise: Promise<PreciseCoordinates | null> =
      this.state.isMobile && this.state.initialUrlState?.lat === undefined && this.state.initialUrlState?.lon === undefined
        ? resolvePreciseUserCoordinates(5000)
        : Promise.resolve(null);

    const resolvedRegion = await resolveUserRegion();
    this.state.resolvedLocation = resolvedRegion;

    // Phase 1: Layout (creates map + panels — they'll find hydrated data)
    this.panelLayout.init();
    showProBanner(this.state.container);

    const mobileGeoCoords = await geoCoordsPromise;
    if (mobileGeoCoords && this.state.map) {
      this.state.map.setCenter(mobileGeoCoords.lat, mobileGeoCoords.lon, 6);
    }

    // Happy variant: pre-populate panels from persistent cache for instant render
    if (SITE_VARIANT === 'happy') {
      await this.dataLoader.hydrateHappyPanelsFromCache();
    }

    // Phase 2: Shared UI components
    this.state.signalModal = new SignalModal();
    this.state.signalModal.setLocationClickHandler((lat, lon) => {
      this.state.map?.setCenter(lat, lon, 4);
    });
    if (!this.state.isMobile) {
      this.state.findingsBadge = new IntelligenceGapBadge();
      this.state.findingsBadge.setOnSignalClick((signal) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (localStorage.getItem('wm-settings-open') === '1') return;
        this.state.signalModal?.showSignal(signal);
      });
      this.state.findingsBadge.setOnAlertClick((alert) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (localStorage.getItem('wm-settings-open') === '1') return;
        this.state.signalModal?.showAlert(alert);
      });
    }

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

    // Correlation engine
    const correlationEngine = new CorrelationEngine();
    correlationEngine.registerAdapter(militaryAdapter);
    correlationEngine.registerAdapter(escalationAdapter);
    correlationEngine.registerAdapter(economicAdapter);
    correlationEngine.registerAdapter(disasterAdapter);
    this.state.correlationEngine = correlationEngine;
    this.eventHandlers.setupUnifiedSettings();

    // Phase 4: SearchManager, MapLayerHandlers, CountryIntel
    this.searchManager.init();
    this.eventHandlers.setupMapLayerHandlers();
    this.countryIntel.init();

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    // Capture deep link params BEFORE URL sync overwrites them
    const initState = parseMapUrlState(window.location.search, this.state.mapLayers);
    this.pendingDeepLinkCountry = initState.country ?? null;
    this.pendingDeepLinkExpanded = initState.expanded === true;
    const earlyParams = new URLSearchParams(window.location.search);
    this.pendingDeepLinkStoryCode = earlyParams.get('c') ?? null;
    this.eventHandlers.setupUrlStateSync();

    this.state.countryBriefPage?.onStateChange?.(() => {
      this.eventHandlers.syncUrlState();
    });

    // Start deep link handling early — its retry loop polls hasSufficientData()
    // independently, so it must not be gated behind loadAllData() which can hang.
    this.handleDeepLinks();

    // Phase 6: Data loading
    this.dataLoader.syncDataFreshnessWithLayers();
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

    // Initial correlation engine run
    if (this.state.correlationEngine) {
      void this.state.correlationEngine.run(this.state).then(() => {
        for (const domain of ['military', 'escalation', 'economic', 'disaster'] as const) {
          const panel = this.state.panels[`${domain}-correlation`] as CorrelationPanel | undefined;
          panel?.updateCards(this.state.correlationEngine!.getCards(domain));
        }
      });
    }

    startLearning();

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

  public destroy(): void {
    this.state.isDestroyed = true;
    window.removeEventListener('scroll', this.handleViewportPrime);
    window.removeEventListener('resize', this.handleViewportPrime);
    if (this.visiblePanelPrimeRaf !== null) {
      window.cancelAnimationFrame(this.visiblePanelPrimeRaf);
      this.visiblePanelPrimeRaf = null;
    }

    // Destroy all modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      this.modules[i]!.destroy();
    }

    // Clean up subscriptions, map, AIS, and breaking news
    this.unsubAiFlow?.();
    this.state.breakingBanner?.destroy();
    destroyBreakingNewsAlerts();
    this.state.map?.destroy();
    disconnectAisStream();
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
          this.countryIntel.openCountryBriefByCode(countryCode.toUpperCase(), countryName, {
            maximize: true,
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
        this.countryIntel.openCountryBriefByCode(deepLinkCountry, cName, {
          maximize: deepLinkExpanded,
        });
        this.eventHandlers.syncUrlState();
      }, DEEP_LINK_INITIAL_DELAY_MS);
    }
  }

  private setupRefreshIntervals(): void {
    // Always refresh news for all variants
    this.refreshScheduler.scheduleRefresh('news', () => this.dataLoader.loadNews(), REFRESH_INTERVALS.feeds);

    // Happy variant only refreshes news -- skip all geopolitical/financial/military refreshes
    if (SITE_VARIANT !== 'happy') {
      this.refreshScheduler.registerAll([
        {
          name: 'markets',
          fn: () => this.dataLoader.loadMarkets(),
          intervalMs: REFRESH_INTERVALS.markets,
          condition: () => this.isAnyPanelNearViewport(['markets', 'heatmap', 'commodities', 'crypto']),
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
        () => getSecretState('WORLDMONITOR_API_KEY').present && this.isPanelNearViewport('stock-analysis'),
      );
      this.refreshScheduler.scheduleRefresh(
        'daily-market-brief',
        () => this.dataLoader.loadDailyMarketBrief(),
        REFRESH_INTERVALS.dailyMarketBrief,
        () => getSecretState('WORLDMONITOR_API_KEY').present && this.isPanelNearViewport('daily-market-brief'),
      );
      this.refreshScheduler.scheduleRefresh(
        'stock-backtest',
        () => this.dataLoader.loadStockBacktest(),
        REFRESH_INTERVALS.stockBacktest,
        () => getSecretState('WORLDMONITOR_API_KEY').present && this.isPanelNearViewport('stock-backtest'),
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

    // Server-side temporal anomalies (news + satellite_fires)
    if (SITE_VARIANT !== 'happy') {
      this.refreshScheduler.scheduleRefresh('temporalBaseline', () => this.dataLoader.refreshTemporalBaseline(), REFRESH_INTERVALS.temporalBaseline, () => this.shouldRefreshIntelligence());
    }

    // WTO trade policy data — annual data, poll every 10 min to avoid hammering upstream
    if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance' || SITE_VARIANT === 'commodity') {
      this.refreshScheduler.scheduleRefresh('tradePolicy', () => this.dataLoader.loadTradePolicy(), REFRESH_INTERVALS.tradePolicy, () => this.isPanelNearViewport('trade-policy'));
      this.refreshScheduler.scheduleRefresh('supplyChain', () => this.dataLoader.loadSupplyChain(), REFRESH_INTERVALS.supplyChain, () => this.isPanelNearViewport('supply-chain'));
    }

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
        const engine = this.state.correlationEngine;
        if (!engine) return;
        await engine.run(this.state);
        for (const domain of ['military', 'escalation', 'economic', 'disaster'] as const) {
          const panel = this.state.panels[`${domain}-correlation`] as CorrelationPanel | undefined;
          panel?.updateCards(engine.getCards(domain));
        }
      },
      REFRESH_INTERVALS.correlationEngine,
      () => this.shouldRefreshCorrelation(),
    );
  }
}
