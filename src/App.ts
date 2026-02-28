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
import { initDB, cleanOldSnapshots, isAisConfigured, initAisStream, isOutagesConfigured, disconnectAisStream } from '@/services';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange } from '@/services/ai-flow-settings';
import { startLearning } from '@/services/country-instability';
import { dataFreshness } from '@/services/data-freshness';
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
import { isDesktopRuntime } from '@/services/runtime';
import { BETA_MODE } from '@/config/beta';
import { trackEvent, trackDeeplinkOpened } from '@/services/analytics';
import { preloadCountryGeometry, getCountryNameByCode } from '@/services/country-geometry';
import { initI18n } from '@/services/i18n';

import { fetchBootstrapData } from '@/services/bootstrap';
import { DesktopUpdater } from '@/app/desktop-updater';
import { CountryIntelManager } from '@/app/country-intel';
import { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export type { CountryBriefSignals } from '@/app/app-context';

export class App {
  private state: AppContext;
  private pendingDeepLinkCountry: string | null = null;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager;
  private countryIntel: CountryIntelManager;
  private refreshScheduler: RefreshScheduler;
  private desktopUpdater: DesktopUpdater;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;

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
      localStorage.removeItem(PANEL_SPANS_KEY);
      mapLayers = { ...defaultLayers };
      panelSettings = { ...DEFAULT_PANELS };
    } else {
      mapLayers = loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers);
      // Happy variant: force non-happy layers off even if localStorage has stale true values
      if (currentVariant === 'happy') {
        const unhappyLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals', 'natural', 'fires', 'outages', 'cyberThreats', 'weather', 'economic', 'cables', 'datacenters', 'ucdpEvents', 'displacement', 'climate', 'iranAttacks'];
        unhappyLayers.forEach(layer => { mapLayers[layer] = false; });
      }
      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );
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
            console.log('[App] Migrated panel order to v1.8 layout');
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

    // One-time migration: clear stale panel ordering and sizing state
    const LAYOUT_RESET_MIGRATION_KEY = 'worldmonitor-layout-reset-v2.5';
    if (!localStorage.getItem(LAYOUT_RESET_MIGRATION_KEY)) {
      const hadSavedOrder = !!localStorage.getItem(PANEL_ORDER_KEY);
      const hadSavedSpans = !!localStorage.getItem(PANEL_SPANS_KEY);
      if (hadSavedOrder || hadSavedSpans) {
        localStorage.removeItem(PANEL_ORDER_KEY);
        localStorage.removeItem(PANEL_SPANS_KEY);
        console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
      }
      localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
    }

    // Desktop key management panel must always remain accessible in Tauri.
    if (isDesktopApp) {
      const runtimePanel = panelSettings['runtime-config'] ?? {
        name: 'Desktop Configuration',
        enabled: true,
        priority: 2,
      };
      runtimePanel.enabled = true;
      panelSettings['runtime-config'] = runtimePanel;
      saveToStorage(STORAGE_KEYS.panels, panelSettings);
    }

    let initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      if (currentVariant === 'tech') {
        const geoLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals'];
        const urlLayers = initialUrlState.layers;
        geoLayers.forEach(layer => {
          urlLayers[layer] = false;
        });
      }
      // For happy variant, force off all non-happy layers (including natural events)
      if (currentVariant === 'happy') {
        const unhappyLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals', 'natural', 'fires', 'outages', 'cyberThreats', 'weather', 'economic', 'cables', 'datacenters', 'ucdpEvents', 'displacement', 'climate', 'iranAttacks'];
        const urlLayers = initialUrlState.layers;
        unhappyLayers.forEach(layer => {
          urlLayers[layer] = false;
        });
      }
      mapLayers = initialUrlState.layers;
    }
    if (!CYBER_LAYER_ENABLED) {
      mapLayers.cyberThreats = false;
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
      mobileWarningModal: null,
      pizzintIndicator: null,
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
    });

    this.searchManager = new SearchManager(this.state, {
      openCountryBriefByCode: (code, country) => this.countryIntel.openCountryBriefByCode(code, country),
    });

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: (code, name) => this.countryIntel.openCountryStory(code, name),
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
      if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => {});
    }

    this.unsubAiFlow = subscribeAiFlowChange((key) => {
      if (key === 'browserModel') {
        const s = getAiFlowSettings();
        if (s.browserModel) {
          mlWorker.init();
        } else {
          mlWorker.terminate();
        }
      }
    });

    // Check AIS configuration before init
    if (!isAisConfigured()) {
      this.state.mapLayers.ais = false;
    } else if (this.state.mapLayers.ais) {
      initAisStream();
    }

    // Hydrate in-memory cache from bootstrap endpoint (before panels construct and fetch)
    await fetchBootstrapData();

    // Phase 1: Layout (creates map + panels — they'll find hydrated data)
    this.panelLayout.init();

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
    this.eventHandlers.setupMobileWarning();
    this.eventHandlers.setupPlaybackControl();
    this.eventHandlers.setupStatusPanel();
    this.eventHandlers.setupPizzIntIndicator();
    this.eventHandlers.setupExportPanel();
    this.eventHandlers.setupUnifiedSettings();

    // Phase 4: SearchManager, MapLayerHandlers, CountryIntel
    this.searchManager.init();
    this.eventHandlers.setupMapLayerHandlers();
    this.countryIntel.init();

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    // Capture ?country= BEFORE URL sync overwrites it
    const initState = parseMapUrlState(window.location.search, this.state.mapLayers);
    this.pendingDeepLinkCountry = initState.country ?? null;
    this.eventHandlers.setupUrlStateSync();

    // Phase 6: Data loading
    this.dataLoader.syncDataFreshnessWithLayers();
    await preloadCountryGeometry();
    await this.dataLoader.loadAllData();

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

    // Phase 8: Deep links + update checks
    this.handleDeepLinks();
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
    const MAX_DEEP_LINK_RETRIES = 60;
    const DEEP_LINK_RETRY_INTERVAL_MS = 500;
    const DEEP_LINK_INITIAL_DELAY_MS = 2000;

    // Check for story deep link: /story?c=UA&t=ciianalysis
    if (url.pathname === '/story' || url.searchParams.has('c')) {
      const countryCode = url.searchParams.get('c');
      if (countryCode) {
        trackDeeplinkOpened('story', countryCode);
        const countryName = getCountryNameByCode(countryCode.toUpperCase()) || countryCode;

        let attempts = 0;
        const checkAndOpen = () => {
          if (dataFreshness.hasSufficientData() && this.state.latestClusters.length > 0) {
            this.countryIntel.openCountryStory(countryCode.toUpperCase(), countryName);
            return;
          }
          attempts += 1;
          if (attempts >= MAX_DEEP_LINK_RETRIES) {
            this.eventHandlers.showToast('Data not available');
            return;
          } else {
            setTimeout(checkAndOpen, DEEP_LINK_RETRY_INTERVAL_MS);
          }
        };
        setTimeout(checkAndOpen, DEEP_LINK_INITIAL_DELAY_MS);

        history.replaceState(null, '', '/');
        return;
      }
    }

    // Check for country brief deep link: ?country=UA
    const deepLinkCountry = this.pendingDeepLinkCountry;
    this.pendingDeepLinkCountry = null;
    if (deepLinkCountry) {
      trackDeeplinkOpened('country', deepLinkCountry);
      const cName = CountryIntelManager.resolveCountryName(deepLinkCountry);
      let attempts = 0;
      const checkAndOpenBrief = () => {
        if (dataFreshness.hasSufficientData()) {
          this.countryIntel.openCountryBriefByCode(deepLinkCountry, cName);
          return;
        }
        attempts += 1;
        if (attempts >= MAX_DEEP_LINK_RETRIES) {
          this.eventHandlers.showToast('Data not available');
          return;
        } else {
          setTimeout(checkAndOpenBrief, DEEP_LINK_RETRY_INTERVAL_MS);
        }
      };
      setTimeout(checkAndOpenBrief, DEEP_LINK_INITIAL_DELAY_MS);
    }
  }

  private setupRefreshIntervals(): void {
    // Always refresh news for all variants
    this.refreshScheduler.scheduleRefresh('news', () => this.dataLoader.loadNews(), REFRESH_INTERVALS.feeds);

    // Happy variant only refreshes news -- skip all geopolitical/financial/military refreshes
    if (SITE_VARIANT !== 'happy') {
      this.refreshScheduler.registerAll([
        { name: 'markets', fn: () => this.dataLoader.loadMarkets(), intervalMs: REFRESH_INTERVALS.markets },
        { name: 'predictions', fn: () => this.dataLoader.loadPredictions(), intervalMs: REFRESH_INTERVALS.predictions },
        { name: 'pizzint', fn: () => this.dataLoader.loadPizzInt(), intervalMs: 10 * 60 * 1000 },
        { name: 'natural', fn: () => this.dataLoader.loadNatural(), intervalMs: 5 * 60 * 1000, condition: () => this.state.mapLayers.natural },
        { name: 'weather', fn: () => this.dataLoader.loadWeatherAlerts(), intervalMs: 10 * 60 * 1000, condition: () => this.state.mapLayers.weather },
        { name: 'fred', fn: () => this.dataLoader.loadFredData(), intervalMs: 30 * 60 * 1000 },
        { name: 'oil', fn: () => this.dataLoader.loadOilAnalytics(), intervalMs: 30 * 60 * 1000 },
        { name: 'spending', fn: () => this.dataLoader.loadGovernmentSpending(), intervalMs: 60 * 60 * 1000 },
        { name: 'bis', fn: () => this.dataLoader.loadBisData(), intervalMs: 60 * 60 * 1000 },
        { name: 'firms', fn: () => this.dataLoader.loadFirmsData(), intervalMs: 30 * 60 * 1000 },
        { name: 'ais', fn: () => this.dataLoader.loadAisSignals(), intervalMs: REFRESH_INTERVALS.ais, condition: () => this.state.mapLayers.ais },
        { name: 'cables', fn: () => this.dataLoader.loadCableActivity(), intervalMs: 30 * 60 * 1000, condition: () => this.state.mapLayers.cables },
        { name: 'cableHealth', fn: () => this.dataLoader.loadCableHealth(), intervalMs: 5 * 60 * 1000, condition: () => this.state.mapLayers.cables },
        { name: 'flights', fn: () => this.dataLoader.loadFlightDelays(), intervalMs: 10 * 60 * 1000, condition: () => this.state.mapLayers.flights },
        { name: 'cyberThreats', fn: () => {
          this.state.cyberThreatsCache = null;
          return this.dataLoader.loadCyberThreats();
        }, intervalMs: 10 * 60 * 1000, condition: () => CYBER_LAYER_ENABLED && this.state.mapLayers.cyberThreats },
      ]);
    }

    // Panel-level refreshes (moved from panel constructors into scheduler for hidden-tab awareness + jitter)
    this.refreshScheduler.scheduleRefresh(
      'service-status',
      () => (this.state.panels['service-status'] as ServiceStatusPanel).fetchStatus(),
      60_000,
      () => !!this.state.panels['service-status']
    );
    this.refreshScheduler.scheduleRefresh(
      'stablecoins',
      () => (this.state.panels['stablecoins'] as StablecoinPanel).fetchData(),
      3 * 60_000,
      () => !!this.state.panels['stablecoins']
    );
    this.refreshScheduler.scheduleRefresh(
      'etf-flows',
      () => (this.state.panels['etf-flows'] as ETFFlowsPanel).fetchData(),
      3 * 60_000,
      () => !!this.state.panels['etf-flows']
    );
    this.refreshScheduler.scheduleRefresh(
      'macro-signals',
      () => (this.state.panels['macro-signals'] as MacroSignalsPanel).fetchData(),
      3 * 60_000,
      () => !!this.state.panels['macro-signals']
    );
    this.refreshScheduler.scheduleRefresh(
      'strategic-posture',
      () => (this.state.panels['strategic-posture'] as StrategicPosturePanel).refresh(),
      15 * 60_000,
      () => !!this.state.panels['strategic-posture']
    );
    this.refreshScheduler.scheduleRefresh(
      'strategic-risk',
      () => (this.state.panels['strategic-risk'] as StrategicRiskPanel).refresh(),
      5 * 60_000,
      () => !!this.state.panels['strategic-risk']
    );

    // WTO trade policy data — annual data, poll every 10 min to avoid hammering upstream
    if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance') {
      this.refreshScheduler.scheduleRefresh('tradePolicy', () => this.dataLoader.loadTradePolicy(), 10 * 60 * 1000);
      this.refreshScheduler.scheduleRefresh('supplyChain', () => this.dataLoader.loadSupplyChain(), 10 * 60 * 1000);
    }

    // Refresh intelligence signals for CII (geopolitical variant only)
    if (SITE_VARIANT === 'full') {
      this.refreshScheduler.scheduleRefresh('intelligence', () => {
        const { military, iranEvents } = this.state.intelligenceCache;
        this.state.intelligenceCache = {};
        if (military) this.state.intelligenceCache.military = military;
        if (iranEvents) this.state.intelligenceCache.iranEvents = iranEvents;
        return this.dataLoader.loadIntelligenceSignals();
      }, 15 * 60 * 1000);
    }
  }
}
