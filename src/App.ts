import type { NewsItem, Monitor, PanelConfig, MapLayers, RelatedAsset, InternetOutage, SocialUnrestEvent, MilitaryFlight, MilitaryVessel, MilitaryFlightCluster, MilitaryVesselCluster, CyberThreat } from '@/types';
import {
  FEEDS,
  INTEL_SOURCES,
  SECTORS,
  COMMODITIES,
  MARKET_SYMBOLS,
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
} from '@/config';
import { fetchCategoryFeeds, fetchMultipleStocks, fetchCrypto, fetchPredictions, fetchEarthquakes, fetchWeatherAlerts, fetchFredData, fetchInternetOutages, isOutagesConfigured, fetchAisSignals, initAisStream, getAisStatus, disconnectAisStream, isAisConfigured, fetchCableActivity, fetchProtestEvents, getProtestStatus, fetchFlightDelays, fetchMilitaryFlights, fetchMilitaryVessels, initMilitaryVesselStream, isMilitaryVesselTrackingConfigured, initDB, updateBaseline, calculateDeviation, addToSignalHistory, saveSnapshot, cleanOldSnapshots, analysisWorker, fetchPizzIntStatus, fetchGdeltTensions, fetchNaturalEvents, fetchRecentAwards, fetchOilAnalytics, fetchCyberThreats, drainTrendingSignals } from '@/services';
import { fetchCountryMarkets } from '@/services/polymarket';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { ingestProtests, ingestFlights, ingestVessels, ingestEarthquakes, detectGeoConvergence, geoConvergenceToSignal } from '@/services/geo-convergence';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck } from '@/services/temporal-baseline';
import { fetchAllFires, flattenFires, computeRegionStats } from '@/services/firms-satellite';
import { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal, type TheaterPostureSummary } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { ingestProtestsForCII, ingestMilitaryForCII, ingestNewsForCII, ingestOutagesForCII, ingestConflictsForCII, ingestUcdpForCII, ingestHapiForCII, ingestDisplacementForCII, ingestClimateForCII, startLearning, isInLearningMode, calculateCII, getCountryData, TIER1_COUNTRIES } from '@/services/country-instability';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { focusInvestmentOnMap } from '@/services/investments-focus';
import { fetchConflictEvents } from '@/services/conflicts';
import { fetchUcdpClassifications } from '@/services/ucdp';
import { fetchHapiSummary } from '@/services/hapi';
import { fetchUcdpEvents, deduplicateAgainstAcled } from '@/services/ucdp-events';
import { fetchUnhcrPopulation } from '@/services/unhcr';
import { fetchClimateAnomalies } from '@/services/climate';
import { enrichEventsWithExposure } from '@/services/population-exposure';
import { buildMapUrl, debounce, loadFromStorage, parseMapUrlState, saveToStorage, ExportPanel, getCircuitBreakerCooldownInfo, isMobileDevice, setTheme, getCurrentTheme } from '@/utils';
import { reverseGeocode } from '@/utils/reverse-geocode';
import { CountryBriefPage } from '@/components/CountryBriefPage';
import { maybeShowDownloadBanner } from '@/components/DownloadBanner';
import { CountryTimeline, type TimelineEvent } from '@/components/CountryTimeline';
import { escapeHtml } from '@/utils/sanitize';
import type { ParsedMapUrlState } from '@/utils';
import {
  MapContainer,
  type MapView,
  type TimeRange,
  NewsPanel,
  MarketPanel,
  HeatmapPanel,
  CommoditiesPanel,
  CryptoPanel,
  PredictionPanel,
  MonitorPanel,
  Panel,
  SignalModal,
  PlaybackControl,
  StatusPanel,
  EconomicPanel,
  SearchModal,
  MobileWarningModal,
  PizzIntIndicator,
  GdeltIntelPanel,
  LiveNewsPanel,
  CIIPanel,
  CascadePanel,
  StrategicRiskPanel,
  StrategicPosturePanel,
  IntelligenceGapBadge,
  TechEventsPanel,
  ServiceStatusPanel,
  RuntimeConfigPanel,
  InsightsPanel,
  TechReadinessPanel,
  MacroSignalsPanel,
  ETFFlowsPanel,
  StablecoinPanel,
  UcdpEventsPanel,
  DisplacementPanel,
  ClimateAnomalyPanel,
  PopulationExposurePanel,
  InvestmentsPanel,
} from '@/components';
import type { SearchResult } from '@/components/SearchModal';
import { collectStoryData } from '@/services/story-data';
import { renderStoryToCanvas } from '@/services/story-renderer';
import { openStoryModal } from '@/components/StoryModal';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, MILITARY_BASES, UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { STOCK_EXCHANGES, FINANCIAL_CENTERS, CENTRAL_BANKS, COMMODITY_HUBS } from '@/config/finance-geo';
import { isDesktopRuntime } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import { invokeTauri } from '@/services/tauri-bridge';
import { getCountryAtCoordinates, hasCountryGeometry, isCoordinateInCountry, preloadCountryGeometry } from '@/services/country-geometry';
import { initI18n, t, changeLanguage, getCurrentLanguage, LANGUAGES } from '@/services/i18n';

import type { PredictionMarket, MarketData, ClusteredEvent } from '@/types';

type IntlDisplayNamesCtor = new (
  locales: string | string[],
  options: { type: 'region' }
) => { of: (code: string) => string | undefined };

interface DesktopRuntimeInfo {
  os: string;
  arch: string;
}

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export interface CountryBriefSignals {
  protests: number;
  militaryFlights: number;
  militaryVessels: number;
  outages: number;
  earthquakes: number;
  displacementOutflow: number;
  climateStress: number;
  conflictEvents: number;
  isTier1: boolean;
}

export class App {
  private container: HTMLElement;
  private readonly PANEL_ORDER_KEY = 'panel-order';
  private map: MapContainer | null = null;
  private panels: Record<string, Panel> = {};
  private newsPanels: Record<string, NewsPanel> = {};
  private allNews: NewsItem[] = [];
  private newsByCategory: Record<string, NewsItem[]> = {};
  private currentTimeRange: TimeRange = '7d';
  private monitors: Monitor[];
  private panelSettings: Record<string, PanelConfig>;
  private mapLayers: MapLayers;
  private signalModal: SignalModal | null = null;
  private playbackControl: PlaybackControl | null = null;
  private statusPanel: StatusPanel | null = null;
  private exportPanel: ExportPanel | null = null;
  private searchModal: SearchModal | null = null;
  private mobileWarningModal: MobileWarningModal | null = null;
  private pizzintIndicator: PizzIntIndicator | null = null;
  private latestPredictions: PredictionMarket[] = [];
  private latestMarkets: MarketData[] = [];
  private latestClusters: ClusteredEvent[] = [];
  private readonly applyTimeRangeFilterToNewsPanelsDebounced = debounce(() => {
    this.applyTimeRangeFilterToNewsPanels();
  }, 120);
  private isPlaybackMode = false;
  private initialUrlState: ParsedMapUrlState | null = null;
  private inFlight: Set<string> = new Set();
  private isMobile: boolean;
  private seenGeoAlerts: Set<string> = new Set();
  private snapshotIntervalId: ReturnType<typeof setInterval> | null = null;
  private refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isDestroyed = false;
  private boundKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundFullscreenHandler: (() => void) | null = null;
  private boundResizeHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private boundIdleResetHandler: (() => void) | null = null;
  private isIdle = false;
  private readonly IDLE_PAUSE_MS = 2 * 60 * 1000; // 2 minutes - pause animations when idle
  private disabledSources: Set<string> = new Set();
  private mapFlashCache: Map<string, number> = new Map();
  private readonly MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;
  private initialLoadComplete = false;
  private criticalBannerEl: HTMLElement | null = null;
  private countryBriefPage: CountryBriefPage | null = null;
  private countryTimeline: CountryTimeline | null = null;
  private pendingDeepLinkCountry: string | null = null;
  private briefRequestToken = 0;
  private readonly isDesktopApp = isDesktopRuntime();

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);
    this.container = el;

    this.isMobile = isMobileDevice();
    this.monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);

    // Use mobile-specific defaults on first load (no saved layers)
    const defaultLayers = this.isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;

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
      localStorage.removeItem(this.PANEL_ORDER_KEY);
      this.mapLayers = { ...defaultLayers };
      this.panelSettings = { ...DEFAULT_PANELS };
    } else {
      this.mapLayers = loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers);
      this.panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );
      console.log('[App] Loaded panel settings from storage:', Object.entries(this.panelSettings).filter(([_, v]) => !v.enabled).map(([k]) => k));

      // One-time migration: reorder panels for existing users (v1.9 panel layout)
      // Puts live-news, insights, strategic-posture, cii, strategic-risk at the top
      const PANEL_ORDER_MIGRATION_KEY = 'worldmonitor-panel-order-v1.9';
      if (!localStorage.getItem(PANEL_ORDER_MIGRATION_KEY)) {
        const savedOrder = localStorage.getItem(this.PANEL_ORDER_KEY);
        if (savedOrder) {
          try {
            const order: string[] = JSON.parse(savedOrder);
            // Priority panels that should be at the top (after live-news which is handled separately)
            const priorityPanels = ['insights', 'strategic-posture', 'cii', 'strategic-risk'];
            // Remove priority panels from their current positions
            const filtered = order.filter(k => !priorityPanels.includes(k) && k !== 'live-news');
            // Find live-news position (should be first, but just in case)
            const liveNewsIdx = order.indexOf('live-news');
            // Build new order: live-news first, then priority panels, then rest
            const newOrder = liveNewsIdx !== -1 ? ['live-news'] : [];
            newOrder.push(...priorityPanels.filter(p => order.includes(p)));
            newOrder.push(...filtered);
            localStorage.setItem(this.PANEL_ORDER_KEY, JSON.stringify(newOrder));
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
          const savedOrder = localStorage.getItem(this.PANEL_ORDER_KEY);
          if (savedOrder) {
            try {
              const order: string[] = JSON.parse(savedOrder);
              // Remove insights from current position
              const filtered = order.filter(k => k !== 'insights' && k !== 'live-news');
              // Build new order: live-news, insights, then rest
              const newOrder: string[] = [];
              if (order.includes('live-news')) newOrder.push('live-news');
              if (order.includes('insights')) newOrder.push('insights');
              newOrder.push(...filtered);
              localStorage.setItem(this.PANEL_ORDER_KEY, JSON.stringify(newOrder));
              console.log('[App] Tech variant: Migrated insights panel to top');
            } catch {
              // Invalid saved order, will use defaults
            }
          }
          localStorage.setItem(TECH_INSIGHTS_MIGRATION_KEY, 'done');
        }
      }
    }

    // Desktop key management panel must always remain accessible in Tauri.
    if (this.isDesktopApp) {
      const runtimePanel = this.panelSettings['runtime-config'] ?? {
        name: 'Desktop Configuration',
        enabled: true,
        priority: 2,
      };
      runtimePanel.enabled = true;
      this.panelSettings['runtime-config'] = runtimePanel;
      saveToStorage(STORAGE_KEYS.panels, this.panelSettings);
    }

    this.initialUrlState = parseMapUrlState(window.location.search, this.mapLayers);
    if (this.initialUrlState.layers) {
      // For tech variant, filter out geopolitical layers from URL
      if (currentVariant === 'tech') {
        const geoLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals'];
        const urlLayers = this.initialUrlState.layers;
        geoLayers.forEach(layer => {
          urlLayers[layer] = false;
        });
      }
      this.mapLayers = this.initialUrlState.layers;
    }
    if (!CYBER_LAYER_ENABLED) {
      this.mapLayers.cyberThreats = false;
    }
    this.disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
  }

  public async init(): Promise<void> {
    await initDB();
    await initI18n();

    // Initialize ML worker (desktop only - automatically disabled on mobile)
    await mlWorker.init();

    // Check AIS configuration before init
    if (!isAisConfigured()) {
      this.mapLayers.ais = false;
    } else if (this.mapLayers.ais) {
      initAisStream();
    }

    this.renderLayout();
    this.startHeaderClock();
    this.signalModal = new SignalModal();
    this.signalModal.setLocationClickHandler((lat, lon) => {
      this.map?.setCenter(lat, lon, 4);
    });
    const findingsBadge = new IntelligenceGapBadge();
    findingsBadge.setOnSignalClick((signal) => {
      if (this.countryBriefPage?.isVisible()) return;
      this.signalModal?.showSignal(signal);
    });
    findingsBadge.setOnAlertClick((alert) => {
      if (this.countryBriefPage?.isVisible()) return;
      this.signalModal?.showAlert(alert);
    });
    this.setupMobileWarning();
    this.setupPlaybackControl();
    this.setupStatusPanel();
    this.setupPizzIntIndicator();
    this.setupExportPanel();
    this.setupSearchModal();
    this.setupMapLayerHandlers();
    this.setupCountryIntel();
    this.setupEventListeners();
    // Capture ?country= BEFORE URL sync overwrites it
    const initState = parseMapUrlState(window.location.search, this.mapLayers);
    this.pendingDeepLinkCountry = initState.country ?? null;
    this.setupUrlStateSync();
    this.syncDataFreshnessWithLayers();
    await preloadCountryGeometry();
    await this.loadAllData();

    // Start CII learning mode after first data load
    startLearning();

    // Hide unconfigured layers after first data load
    if (!isAisConfigured()) {
      this.map?.hideLayerToggle('ais');
    }
    if (isOutagesConfigured() === false) {
      this.map?.hideLayerToggle('outages');
    }
    if (!CYBER_LAYER_ENABLED) {
      this.map?.hideLayerToggle('cyberThreats');
    }

    this.setupRefreshIntervals();
    this.setupSnapshotSaving();
    cleanOldSnapshots();

    // Handle deep links for story sharing
    this.handleDeepLinks();

    if (this.isDesktopApp) {
      setTimeout(() => this.checkForUpdate(), 5000);
    }
  }

  private handleDeepLinks(): void {
    const url = new URL(window.location.href);

    // Check for story deep link: /story?c=UA&t=ciianalysis
    if (url.pathname === '/story' || url.searchParams.has('c')) {
      const countryCode = url.searchParams.get('c');
      if (countryCode) {
        const countryNames: Record<string, string> = {
          UA: 'Ukraine', RU: 'Russia', CN: 'China', US: 'United States',
          IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
          SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
          FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
          SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
        };
        const countryName = countryNames[countryCode.toUpperCase()] || countryCode;

        // Wait for data to load, then open story
        const checkAndOpen = () => {
          if (dataFreshness.hasSufficientData() && this.latestClusters.length > 0) {
            this.openCountryStory(countryCode.toUpperCase(), countryName);
          } else {
            setTimeout(checkAndOpen, 500);
          }
        };
        setTimeout(checkAndOpen, 2000);

        // Update URL without reload
        history.replaceState(null, '', '/');
        return;
      }
    }

    // Check for country brief deep link: ?country=UA (captured before URL sync)
    const deepLinkCountry = this.pendingDeepLinkCountry;
    this.pendingDeepLinkCountry = null;
    if (deepLinkCountry) {
      const cName = App.resolveCountryName(deepLinkCountry);
      const checkAndOpenBrief = () => {
        if (dataFreshness.hasSufficientData()) {
          this.openCountryBriefByCode(deepLinkCountry, cName);
        } else {
          setTimeout(checkAndOpenBrief, 500);
        }
      };
      setTimeout(checkAndOpenBrief, 2000);
    }
  }

  private async checkForUpdate(): Promise<void> {
    try {
      const res = await fetch('https://worldmonitor.app/api/version');
      if (!res.ok) return;
      const data = await res.json();
      const remote = data.version as string;
      if (!remote) return;

      const current = __APP_VERSION__;
      if (!this.isNewerVersion(remote, current)) return;

      const dismissKey = `wm-update-dismissed-${remote}`;
      if (localStorage.getItem(dismissKey)) return;

      const releaseUrl = typeof data.url === 'string' && data.url
        ? data.url
        : 'https://github.com/koala73/worldmonitor/releases/latest';
      await this.showUpdateBadge(remote, releaseUrl);
    } catch { /* silent */ }
  }

  private isNewerVersion(remote: string, current: string): boolean {
    const r = remote.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < Math.max(r.length, c.length); i++) {
      const rv = r[i] ?? 0;
      const cv = c[i] ?? 0;
      if (rv > cv) return true;
      if (rv < cv) return false;
    }
    return false;
  }

  private mapDesktopDownloadPlatform(os: string, arch: string): string | null {
    const normalizedOs = os.toLowerCase();
    const normalizedArch = arch.toLowerCase()
      .replace('amd64', 'x86_64')
      .replace('x64', 'x86_64')
      .replace('arm64', 'aarch64');

    if (normalizedOs === 'windows') {
      return normalizedArch === 'x86_64' ? 'windows-exe' : null;
    }

    if (normalizedOs === 'macos' || normalizedOs === 'darwin') {
      if (normalizedArch === 'aarch64') return 'macos-arm64';
      if (normalizedArch === 'x86_64') return 'macos-x64';
      return null;
    }

    return null;
  }

  private async resolveUpdateDownloadUrl(releaseUrl: string): Promise<string> {
    try {
      const runtimeInfo = await invokeTauri<DesktopRuntimeInfo>('get_desktop_runtime_info');
      const platform = this.mapDesktopDownloadPlatform(runtimeInfo.os, runtimeInfo.arch);
      if (platform) {
        return `https://worldmonitor.app/api/download?platform=${platform}`;
      }
    } catch {
      // Silent fallback to release page when desktop runtime info is unavailable.
    }
    return releaseUrl;
  }

  private async showUpdateBadge(version: string, releaseUrl: string): Promise<void> {
    const versionSpan = this.container.querySelector('.version');
    if (!versionSpan) return;
    const href = await this.resolveUpdateDownloadUrl(releaseUrl);

    const badge = document.createElement('a');
    badge.className = 'update-badge';
    badge.href = href;
    badge.target = '_blank';
    badge.rel = 'noopener';
    badge.textContent = `UPDATE v${version}`;

    const dismiss = document.createElement('span');
    dismiss.className = 'update-badge-dismiss';
    dismiss.textContent = '\u00d7';
    dismiss.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      localStorage.setItem(`wm-update-dismissed-${version}`, '1');
      badge.remove();
    });

    badge.appendChild(dismiss);
    versionSpan.insertAdjacentElement('afterend', badge);
  }

  private startHeaderClock(): void {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toUTCString().replace('GMT', 'UTC');
    };
    tick();
    setInterval(tick, 1000);
  }

  private setupMobileWarning(): void {
    if (MobileWarningModal.shouldShow()) {
      this.mobileWarningModal = new MobileWarningModal();
      this.mobileWarningModal.show();
    }
  }

  private setupStatusPanel(): void {
    this.statusPanel = new StatusPanel();
    const headerLeft = this.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.statusPanel.getElement());
    }
  }

  private setupPizzIntIndicator(): void {
    // Skip DEFCON indicator for tech/startup and finance variants
    if (SITE_VARIANT === 'tech' || SITE_VARIANT === 'finance') return;

    this.pizzintIndicator = new PizzIntIndicator();
    const headerLeft = this.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.pizzintIndicator.getElement());
    }
  }

  private async loadPizzInt(): Promise<void> {
    try {
      const [status, tensions] = await Promise.all([
        fetchPizzIntStatus(),
        fetchGdeltTensions()
      ]);

      // Hide indicator if no valid data (API returned default/empty)
      if (status.locationsMonitored === 0) {
        this.pizzintIndicator?.hide();
        this.statusPanel?.updateApi('PizzINT', { status: 'error' });
        return;
      }

      this.pizzintIndicator?.show();
      this.pizzintIndicator?.updateStatus(status);
      this.pizzintIndicator?.updateTensions(tensions);
      this.statusPanel?.updateApi('PizzINT', { status: 'ok' });
    } catch (error) {
      console.error('[App] PizzINT load failed:', error);
      this.pizzintIndicator?.hide();
      this.statusPanel?.updateApi('PizzINT', { status: 'error' });
    }
  }

  private setupExportPanel(): void {
    this.exportPanel = new ExportPanel(() => ({
      news: this.latestClusters.length > 0 ? this.latestClusters : this.allNews,
      markets: this.latestMarkets,
      predictions: this.latestPredictions,
      timestamp: Date.now(),
    }));

    const headerRight = this.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.exportPanel.getElement(), headerRight.firstChild);
    }
  }

  private syncDataFreshnessWithLayers(): void {
    // Map layer toggles to data source IDs
    const layerToSource: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
      military: ['opensky', 'wingbits'],
      ais: ['ais'],
      natural: ['usgs'],
      weather: ['weather'],
      outages: ['outages'],
      cyberThreats: ['cyber_threats'],
      protests: ['acled'],
      ucdpEvents: ['ucdp_events'],
      displacement: ['unhcr'],
      climate: ['climate'],
    };

    for (const [layer, sourceIds] of Object.entries(layerToSource)) {
      const enabled = this.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }

    // Mark sources as disabled if not configured
    if (!isAisConfigured()) {
      dataFreshness.setEnabled('ais', false);
    }
    if (isOutagesConfigured() === false) {
      dataFreshness.setEnabled('outages', false);
    }
  }

  private setupMapLayerHandlers(): void {
    this.map?.setOnLayerChange((layer, enabled) => {
      console.log(`[App.onLayerChange] ${layer}: ${enabled}`);
      // Save layer settings
      this.mapLayers[layer] = enabled;
      saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);

      // Sync data freshness tracker
      const layerToSource: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
        military: ['opensky', 'wingbits'],
        ais: ['ais'],
        natural: ['usgs'],
        weather: ['weather'],
        outages: ['outages'],
        cyberThreats: ['cyber_threats'],
        protests: ['acled'],
        ucdpEvents: ['ucdp_events'],
        displacement: ['unhcr'],
        climate: ['climate'],
      };
      const sourceIds = layerToSource[layer];
      if (sourceIds) {
        for (const sourceId of sourceIds) {
          dataFreshness.setEnabled(sourceId, enabled);
        }
      }

      // Handle AIS WebSocket connection
      if (layer === 'ais') {
        if (enabled) {
          this.map?.setLayerLoading('ais', true);
          initAisStream();
          this.waitForAisData();
        } else {
          disconnectAisStream();
        }
        return;
      }

      // Load data when layer is enabled (if not already loaded)
      if (enabled) {
        this.loadDataForLayer(layer);
      }
    });
  }

  private setupCountryIntel(): void {
    if (!this.map) return;
    this.countryBriefPage = new CountryBriefPage();
    this.countryBriefPage.setShareStoryHandler((code, name) => {
      this.countryBriefPage?.hide();
      this.openCountryStory(code, name);
    });
    this.countryBriefPage.setExportImageHandler(async (code, name) => {
      try {
        const signals = this.getCountrySignals(code, name);
        const cluster = signalAggregator.getCountryClusters().find(c => c.country === code);
        const regional = signalAggregator.getRegionalConvergence().filter(r => r.countries.includes(code));
        const convergence = cluster ? {
          score: cluster.convergenceScore,
          signalTypes: [...cluster.signalTypes],
          regionalDescriptions: regional.map(r => r.description),
        } : null;
        const posturePanel = this.panels['strategic-posture'] as import('@/components/StrategicPosturePanel').StrategicPosturePanel | undefined;
        const postures = posturePanel?.getPostures() || [];
        const data = collectStoryData(code, name, this.latestClusters, postures, this.latestPredictions, signals, convergence);
        const canvas = await renderStoryToCanvas(data);
        const dataUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `country-brief-${code.toLowerCase()}-${Date.now()}.png`;
        a.click();
      } catch (err) {
        console.error('[CountryBrief] Image export failed:', err);
      }
    });

    this.map.onCountryClicked(async (countryClick) => {
      if (countryClick.code && countryClick.name) {
        this.openCountryBriefByCode(countryClick.code, countryClick.name);
      } else {
        this.openCountryBrief(countryClick.lat, countryClick.lon);
      }
    });

    this.countryBriefPage.onClose(() => {
      this.briefRequestToken++; // invalidate any in-flight reverse-geocode
      this.map?.clearCountryHighlight();
      this.map?.setRenderPaused(false);
      this.countryTimeline?.destroy();
      this.countryTimeline = null;
      // Force URL rewrite to drop ?country= immediately
      const shareUrl = this.getShareUrl();
      if (shareUrl) history.replaceState(null, '', shareUrl);
    });
  }

  public async openCountryBrief(lat: number, lon: number): Promise<void> {
    if (!this.countryBriefPage) return;
    const token = ++this.briefRequestToken;
    this.countryBriefPage.showLoading();
    this.map?.setRenderPaused(true);

    const localGeo = getCountryAtCoordinates(lat, lon);
    if (localGeo) {
      if (token !== this.briefRequestToken) return; // superseded by newer click
      this.openCountryBriefByCode(localGeo.code, localGeo.name);
      return;
    }

    const geo = await reverseGeocode(lat, lon);
    if (token !== this.briefRequestToken) return; // superseded by newer click
    if (!geo) {
      this.countryBriefPage.hide();
      this.map?.setRenderPaused(false);
      return;
    }

    this.openCountryBriefByCode(geo.code, geo.country);
  }

  public async openCountryBriefByCode(code: string, country: string): Promise<void> {
    if (!this.countryBriefPage) return;
    this.map?.setRenderPaused(true);

    // Normalize to canonical name (GeoJSON may use "United States of America" etc.)
    const canonicalName = TIER1_COUNTRIES[code] || App.resolveCountryName(code);
    if (canonicalName !== code) country = canonicalName;

    const scores = calculateCII();
    const score = scores.find((s) => s.code === code) ?? null;
    const signals = this.getCountrySignals(code, country);

    this.countryBriefPage.show(country, code, score, signals);
    this.map?.highlightCountry(code);

    // Force URL to include ?country= immediately
    const shareUrl = this.getShareUrl();
    if (shareUrl) history.replaceState(null, '', shareUrl);

    const stockPromise = fetch(`/api/stock-index?code=${encodeURIComponent(code)}`)
      .then((r) => r.json())
      .catch(() => ({ available: false }));

    stockPromise.then((stock) => {
      if (this.countryBriefPage?.getCode() === code) this.countryBriefPage.updateStock(stock);
    });

    fetchCountryMarkets(country)
      .then((markets) => {
        if (this.countryBriefPage?.getCode() === code) this.countryBriefPage.updateMarkets(markets);
      })
      .catch(() => {
        if (this.countryBriefPage?.getCode() === code) this.countryBriefPage.updateMarkets([]);
      });

    // Pass evidence headlines
    const searchTerms = App.getCountrySearchTerms(country, code);
    const otherCountryTerms = App.getOtherCountryTerms(code);
    const matchingNews = this.allNews.filter((n) => {
      const t = n.title.toLowerCase();
      return searchTerms.some((term) => t.includes(term));
    });
    const filteredNews = matchingNews.filter((n) => {
      const t = n.title.toLowerCase();
      const ourPos = App.firstMentionPosition(t, searchTerms);
      const otherPos = App.firstMentionPosition(t, otherCountryTerms);
      return ourPos !== Infinity && (otherPos === Infinity || ourPos <= otherPos);
    });
    if (filteredNews.length > 0) {
      this.countryBriefPage.updateNews(filteredNews.slice(0, 8));
    }

    // Infrastructure exposure
    this.countryBriefPage.updateInfrastructure(code);

    // Timeline
    this.mountCountryTimeline(code, country);

    try {
      const context: Record<string, unknown> = {};
      if (score) {
        context.score = score.score;
        context.level = score.level;
        context.trend = score.trend;
        context.components = score.components;
        context.change24h = score.change24h;
      }
      Object.assign(context, signals);

      const countryCluster = signalAggregator.getCountryClusters().find((c) => c.country === code);
      if (countryCluster) {
        context.convergenceScore = countryCluster.convergenceScore;
        context.signalTypes = [...countryCluster.signalTypes];
      }

      const convergences = signalAggregator.getRegionalConvergence()
        .filter((r) => r.countries.includes(code));
      if (convergences.length) {
        context.regionalConvergence = convergences.map((r) => r.description);
      }

      const headlines = filteredNews.slice(0, 15).map((n) => n.title);
      if (headlines.length) context.headlines = headlines;

      const stockData = await stockPromise;
      if (stockData.available) {
        const pct = parseFloat(stockData.weekChangePercent);
        context.stockIndex = `${stockData.indexName}: ${stockData.price} (${pct >= 0 ? '+' : ''}${stockData.weekChangePercent}% week)`;
      }

      let data: Record<string, unknown> | null = null;
      try {
        const res = await fetch('/api/country-intel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ country, code, context }),
        });
        data = await res.json();
      } catch { /* server unreachable */ }

      if (data && data.brief && !data.skipped) {
        this.countryBriefPage!.updateBrief({ ...data, code } as Parameters<typeof this.countryBriefPage.updateBrief>[0]);
      } else {
        const briefHeadlines = (context.headlines as string[] | undefined) || [];
        let fallbackBrief = '';
        if (briefHeadlines.length >= 2 && mlWorker.isAvailable) {
          try {
            const prompt = `Summarize the current situation in ${country} based on these headlines: ${briefHeadlines.slice(0, 8).join('. ')}`;
            const [summary] = await mlWorker.summarize([prompt]);
            if (summary && summary.length > 20) fallbackBrief = summary;
          } catch { /* T5 failed */ }
        }

        if (fallbackBrief) {
          this.countryBriefPage!.updateBrief({ brief: fallbackBrief, country, code, fallback: true });
        } else {
          const lines: string[] = [];
          if (score) lines.push(`**Instability Index: ${score.score}/100** (${score.level}, ${score.trend})`);
          if (signals.protests > 0) lines.push(`${signals.protests} active protests detected`);
          if (signals.militaryFlights > 0) lines.push(`${signals.militaryFlights} military aircraft tracked`);
          if (signals.militaryVessels > 0) lines.push(`${signals.militaryVessels} military vessels tracked`);
          if (signals.outages > 0) lines.push(`${signals.outages} internet outages`);
          if (signals.earthquakes > 0) lines.push(`${signals.earthquakes} recent earthquakes`);
          if (context.stockIndex) lines.push(`Stock index: ${context.stockIndex}`);
          if (briefHeadlines.length > 0) {
            lines.push('', '**Recent headlines:**');
            briefHeadlines.slice(0, 5).forEach(h => lines.push(`• ${h}`));
          }
          if (lines.length > 0) {
            this.countryBriefPage!.updateBrief({ brief: lines.join('\n'), country, code, fallback: true });
          } else {
            this.countryBriefPage!.updateBrief({ brief: '', country, code, error: 'No AI service available. Configure GROQ_API_KEY in Settings for full briefs.' });
          }
        }
      }
    } catch (err) {
      console.error('[CountryBrief] fetch error:', err);
      this.countryBriefPage!.updateBrief({ brief: '', country, code, error: 'Failed to generate brief' });
    }
  }

  private mountCountryTimeline(code: string, country: string): void {
    this.countryTimeline?.destroy();
    this.countryTimeline = null;

    const mount = this.countryBriefPage?.getTimelineMount();
    if (!mount) return;

    const events: TimelineEvent[] = [];
    const countryLower = country.toLowerCase();
    const hasGeoShape = hasCountryGeometry(code) || !!App.COUNTRY_BOUNDS[code];
    const inCountry = (lat: number, lon: number) => hasGeoShape && this.isInCountry(lat, lon, code);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    if (this.intelligenceCache.protests?.events) {
      for (const e of this.intelligenceCache.protests.events) {
        if (e.country?.toLowerCase() === countryLower || inCountry(e.lat, e.lon)) {
          events.push({
            timestamp: new Date(e.time).getTime(),
            lane: 'protest',
            label: e.title || `${e.eventType} in ${e.city || e.country}`,
            severity: e.severity === 'high' ? 'high' : e.severity === 'medium' ? 'medium' : 'low',
          });
        }
      }
    }

    if (this.intelligenceCache.earthquakes) {
      for (const eq of this.intelligenceCache.earthquakes) {
        if (inCountry(eq.lat, eq.lon) || eq.place?.toLowerCase().includes(countryLower)) {
          events.push({
            timestamp: new Date(eq.time).getTime(),
            lane: 'natural',
            label: `M${eq.magnitude.toFixed(1)} ${eq.place}`,
            severity: eq.magnitude >= 6 ? 'critical' : eq.magnitude >= 5 ? 'high' : eq.magnitude >= 4 ? 'medium' : 'low',
          });
        }
      }
    }

    if (this.intelligenceCache.military) {
      for (const f of this.intelligenceCache.military.flights) {
        if (hasGeoShape ? this.isInCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code) {
          events.push({
            timestamp: new Date(f.lastSeen).getTime(),
            lane: 'military',
            label: `${f.callsign} (${f.aircraftModel || f.aircraftType})`,
            severity: f.isInteresting ? 'high' : 'low',
          });
        }
      }
      for (const v of this.intelligenceCache.military.vessels) {
        if (hasGeoShape ? this.isInCountry(v.lat, v.lon, code) : v.operatorCountry?.toUpperCase() === code) {
          events.push({
            timestamp: new Date(v.lastAisUpdate).getTime(),
            lane: 'military',
            label: `${v.name} (${v.vesselType})`,
            severity: v.isDark ? 'high' : 'low',
          });
        }
      }
    }

    const ciiData = getCountryData(code);
    if (ciiData?.conflicts) {
      for (const c of ciiData.conflicts) {
        events.push({
          timestamp: new Date(c.time).getTime(),
          lane: 'conflict',
          label: `${c.eventType}: ${c.location || c.country}`,
          severity: c.fatalities > 0 ? 'critical' : 'high',
        });
      }
    }

    this.countryTimeline = new CountryTimeline(mount);
    this.countryTimeline.render(events.filter(e => e.timestamp >= sevenDaysAgo));
  }

  private static COUNTRY_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
    IR: { n: 40, s: 25, e: 63, w: 44 }, IL: { n: 33.3, s: 29.5, e: 35.9, w: 34.3 },
    SA: { n: 32, s: 16, e: 55, w: 35 }, AE: { n: 26.1, s: 22.6, e: 56.4, w: 51.6 },
    IQ: { n: 37.4, s: 29.1, e: 48.6, w: 38.8 }, SY: { n: 37.3, s: 32.3, e: 42.4, w: 35.7 },
    YE: { n: 19, s: 12, e: 54.5, w: 42 }, LB: { n: 34.7, s: 33.1, e: 36.6, w: 35.1 },
    CN: { n: 53.6, s: 18.2, e: 134.8, w: 73.5 }, TW: { n: 25.3, s: 21.9, e: 122, w: 120 },
    JP: { n: 45.5, s: 24.2, e: 153.9, w: 122.9 }, KR: { n: 38.6, s: 33.1, e: 131.9, w: 124.6 },
    KP: { n: 43.0, s: 37.7, e: 130.7, w: 124.2 }, IN: { n: 35.5, s: 6.7, e: 97.4, w: 68.2 },
    PK: { n: 37, s: 24, e: 77, w: 61 }, AF: { n: 38.5, s: 29.4, e: 74.9, w: 60.5 },
    UA: { n: 52.4, s: 44.4, e: 40.2, w: 22.1 }, RU: { n: 82, s: 41.2, e: 180, w: 19.6 },
    BY: { n: 56.2, s: 51.3, e: 32.8, w: 23.2 }, PL: { n: 54.8, s: 49, e: 24.1, w: 14.1 },
    EG: { n: 31.7, s: 22, e: 36.9, w: 25 }, LY: { n: 33, s: 19.5, e: 25, w: 9.4 },
    SD: { n: 22, s: 8.7, e: 38.6, w: 21.8 }, US: { n: 49, s: 24.5, e: -66.9, w: -125 },
    GB: { n: 58.7, s: 49.9, e: 1.8, w: -8.2 }, DE: { n: 55.1, s: 47.3, e: 15.0, w: 5.9 },
    FR: { n: 51.1, s: 41.3, e: 9.6, w: -5.1 }, TR: { n: 42.1, s: 36, e: 44.8, w: 26 },
    BR: { n: 5.3, s: -33.8, e: -34.8, w: -73.9 },
  };

  private static COUNTRY_ALIASES: Record<string, string[]> = {
    IL: ['israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'idf', 'west bank', 'tel aviv', 'jerusalem'],
    IR: ['iran', 'iranian', 'tehran', 'persian', 'irgc', 'khamenei'],
    RU: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'ukraine war'],
    UA: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'zelenskyy'],
    CN: ['china', 'chinese', 'beijing', 'taiwan strait', 'south china sea', 'xi jinping'],
    TW: ['taiwan', 'taiwanese', 'taipei'],
    KP: ['north korea', 'pyongyang', 'kim jong'],
    KR: ['south korea', 'seoul'],
    SA: ['saudi', 'riyadh', 'mbs'],
    SY: ['syria', 'syrian', 'damascus', 'assad'],
    YE: ['yemen', 'houthi', 'sanaa'],
    IQ: ['iraq', 'iraqi', 'baghdad'],
    AF: ['afghanistan', 'afghan', 'kabul', 'taliban'],
    PK: ['pakistan', 'pakistani', 'islamabad'],
    IN: ['india', 'indian', 'new delhi', 'modi'],
    EG: ['egypt', 'egyptian', 'cairo', 'suez'],
    LB: ['lebanon', 'lebanese', 'beirut'],
    TR: ['turkey', 'turkish', 'ankara', 'erdogan', 'türkiye'],
    US: ['united states', 'american', 'washington', 'pentagon', 'white house'],
    GB: ['united kingdom', 'british', 'london', 'uk '],
    BR: ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro'],
    AE: ['united arab emirates', 'uae', 'emirati', 'dubai', 'abu dhabi'],
  };

  private static otherCountryTermsCache: Map<string, string[]> = new Map();

  private static firstMentionPosition(text: string, terms: string[]): number {
    let earliest = Infinity;
    for (const term of terms) {
      const idx = text.indexOf(term);
      if (idx !== -1 && idx < earliest) earliest = idx;
    }
    return earliest;
  }

  private static getOtherCountryTerms(code: string): string[] {
    const cached = App.otherCountryTermsCache.get(code);
    if (cached) return cached;

    const dedup = new Set<string>();
    Object.entries(App.COUNTRY_ALIASES).forEach(([countryCode, aliases]) => {
      if (countryCode === code) return;
      aliases.forEach((alias) => {
        const normalized = alias.toLowerCase();
        if (normalized.trim().length > 0) dedup.add(normalized);
      });
    });

    const terms = [...dedup];
    App.otherCountryTermsCache.set(code, terms);
    return terms;
  }

  private static resolveCountryName(code: string): string {
    if (TIER1_COUNTRIES[code]) return TIER1_COUNTRIES[code];

    try {
      const displayNamesCtor = (Intl as unknown as { DisplayNames?: IntlDisplayNamesCtor }).DisplayNames;
      if (!displayNamesCtor) return code;
      const displayNames = new displayNamesCtor(['en'], { type: 'region' });
      const resolved = displayNames.of(code);
      if (resolved && resolved.toUpperCase() !== code) return resolved;
    } catch {
      // Intl.DisplayNames unavailable in older runtimes.
    }

    return code;
  }

  private static getCountrySearchTerms(country: string, code: string): string[] {
    const aliases = App.COUNTRY_ALIASES[code];
    if (aliases) return aliases;
    if (/^[A-Z]{2}$/i.test(country.trim())) return [];
    return [country.toLowerCase()];
  }

  private isInCountry(lat: number, lon: number, code: string): boolean {
    const precise = isCoordinateInCountry(lat, lon, code);
    if (precise != null) return precise;
    const b = App.COUNTRY_BOUNDS[code];
    if (!b) return false;
    return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
  }

  private getCountrySignals(code: string, country: string): CountryBriefSignals {
    const countryLower = country.toLowerCase();
    const hasGeoShape = hasCountryGeometry(code) || !!App.COUNTRY_BOUNDS[code];

    let protests = 0;
    if (this.intelligenceCache.protests?.events) {
      protests = this.intelligenceCache.protests.events.filter((e) =>
        e.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(e.lat, e.lon, code))
      ).length;
    }

    let militaryFlights = 0;
    let militaryVessels = 0;
    if (this.intelligenceCache.military) {
      militaryFlights = this.intelligenceCache.military.flights.filter((f) =>
        hasGeoShape ? this.isInCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code
      ).length;
      militaryVessels = this.intelligenceCache.military.vessels.filter((v) =>
        hasGeoShape ? this.isInCountry(v.lat, v.lon, code) : v.operatorCountry?.toUpperCase() === code
      ).length;
    }

    let outages = 0;
    if (this.intelligenceCache.outages) {
      outages = this.intelligenceCache.outages.filter((o) =>
        o.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(o.lat, o.lon, code))
      ).length;
    }

    let earthquakes = 0;
    if (this.intelligenceCache.earthquakes) {
      earthquakes = this.intelligenceCache.earthquakes.filter((eq) => {
        if (hasGeoShape) return this.isInCountry(eq.lat, eq.lon, code);
        return eq.place?.toLowerCase().includes(countryLower);
      }).length;
    }

    const ciiData = getCountryData(code);
    const isTier1 = !!TIER1_COUNTRIES[code];

    return {
      protests,
      militaryFlights,
      militaryVessels,
      outages,
      earthquakes,
      displacementOutflow: ciiData?.displacementOutflow ?? 0,
      climateStress: ciiData?.climateStress ?? 0,
      conflictEvents: ciiData?.conflicts?.length ?? 0,
      isTier1,
    };
  }

  private openCountryStory(code: string, name: string): void {
    if (!dataFreshness.hasSufficientData() || this.latestClusters.length === 0) {
      this.showToast('Data still loading — try again in a moment');
      return;
    }
    const posturePanel = this.panels['strategic-posture'] as StrategicPosturePanel | undefined;
    const postures = posturePanel?.getPostures() || [];
    const signals = this.getCountrySignals(code, name);
    const cluster = signalAggregator.getCountryClusters().find(c => c.country === code);
    const regional = signalAggregator.getRegionalConvergence().filter(r => r.countries.includes(code));
    const convergence = cluster ? {
      score: cluster.convergenceScore,
      signalTypes: [...cluster.signalTypes],
      regionalDescriptions: regional.map(r => r.description),
    } : null;
    const data = collectStoryData(code, name, this.latestClusters, postures, this.latestPredictions, signals, convergence);
    openStoryModal(data);
  }

  private showToast(msg: string): void {
    document.querySelector('.toast-notification')?.remove();
    const el = document.createElement('div');
    el.className = 'toast-notification';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  private setupSearchModal(): void {
    const searchOptions = SITE_VARIANT === 'tech'
      ? {
        placeholder: t('modals.search.placeholderTech'),
        hint: t('modals.search.hintTech'),
      }
      : SITE_VARIANT === 'finance'
      ? {
          placeholder: t('modals.search.placeholderFinance'),
          hint: t('modals.search.hintFinance'),
        }
      : {
        placeholder: t('modals.search.placeholder'),
        hint: t('modals.search.hint'),
      };
    this.searchModal = new SearchModal(this.container, searchOptions);

    if (SITE_VARIANT === 'tech') {
      // Tech variant: tech-specific sources
      this.searchModal.registerSource('techcompany', TECH_COMPANIES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.sector} ${c.city} ${c.keyProducts?.join(' ') || ''}`.trim(),
        data: c,
      })));

      this.searchModal.registerSource('ailab', AI_RESEARCH_LABS.map(l => ({
        id: l.id,
        title: l.name,
        subtitle: `${l.type} ${l.city} ${l.focusAreas?.join(' ') || ''}`.trim(),
        data: l,
      })));

      this.searchModal.registerSource('startup', STARTUP_ECOSYSTEMS.map(s => ({
        id: s.id,
        title: s.name,
        subtitle: `${s.ecosystemTier} ${s.topSectors?.join(' ') || ''} ${s.notableStartups?.join(' ') || ''}`.trim(),
        data: s,
      })));

      this.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major internet backbone' : 'Undersea cable',
        data: c,
      })));

      // Register Tech HQs (unicorns, FAANG, public companies from map)
      this.searchModal.registerSource('techhq', TECH_HQS.map(h => ({
        id: h.id,
        title: h.company,
        subtitle: `${h.type === 'faang' ? 'Big Tech' : h.type === 'unicorn' ? 'Unicorn' : 'Public'} • ${h.city}, ${h.country}`,
        data: h,
      })));

      // Register Accelerators
      this.searchModal.registerSource('accelerator', ACCELERATORS.map(a => ({
        id: a.id,
        title: a.name,
        subtitle: `${a.type} • ${a.city}, ${a.country}${a.notable ? ` • ${a.notable.slice(0, 2).join(', ')}` : ''}`,
        data: a,
      })));
    } else {
      // Full variant: geopolitical sources
      this.searchModal.registerSource('hotspot', INTEL_HOTSPOTS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.subtext || ''} ${h.keywords?.join(' ') || ''} ${h.description || ''}`.trim(),
        data: h,
      })));

      this.searchModal.registerSource('conflict', CONFLICT_ZONES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.parties?.join(' ') || ''} ${c.keywords?.join(' ') || ''} ${c.description || ''}`.trim(),
        data: c,
      })));

      this.searchModal.registerSource('base', MILITARY_BASES.map(b => ({
        id: b.id,
        title: b.name,
        subtitle: `${b.type} ${b.description || ''}`.trim(),
        data: b,
      })));

      this.searchModal.registerSource('pipeline', PIPELINES.map(p => ({
        id: p.id,
        title: p.name,
        subtitle: `${p.type} ${p.operator || ''} ${p.countries?.join(' ') || ''}`.trim(),
        data: p,
      })));

      this.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major cable' : '',
        data: c,
      })));

      this.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.searchModal.registerSource('nuclear', NUCLEAR_FACILITIES.map(n => ({
        id: n.id,
        title: n.name,
        subtitle: `${n.type} ${n.operator || ''}`.trim(),
        data: n,
      })));

      this.searchModal.registerSource('irradiator', GAMMA_IRRADIATORS.map(g => ({
        id: g.id,
        title: `${g.city}, ${g.country}`,
        subtitle: g.organization || '',
        data: g,
      })));
    }

    if (SITE_VARIANT === 'finance') {
      // Finance variant: market-specific sources
      this.searchModal.registerSource('exchange', STOCK_EXCHANGES.map(e => ({
        id: e.id,
        title: `${e.shortName} - ${e.name}`,
        subtitle: `${e.tier} • ${e.city}, ${e.country}${e.marketCap ? ` • $${e.marketCap}T` : ''}`,
        data: e,
      })));

      this.searchModal.registerSource('financialcenter', FINANCIAL_CENTERS.map(f => ({
        id: f.id,
        title: f.name,
        subtitle: `${f.type} financial center${f.gfciRank ? ` • GFCI #${f.gfciRank}` : ''}${f.specialties ? ` • ${f.specialties.slice(0, 3).join(', ')}` : ''}`,
        data: f,
      })));

      this.searchModal.registerSource('centralbank', CENTRAL_BANKS.map(b => ({
        id: b.id,
        title: `${b.shortName} - ${b.name}`,
        subtitle: `${b.type}${b.currency ? ` • ${b.currency}` : ''} • ${b.city}, ${b.country}`,
        data: b,
      })));

      this.searchModal.registerSource('commodityhub', COMMODITY_HUBS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.type} • ${h.city}, ${h.country}${h.commodities ? ` • ${h.commodities.slice(0, 3).join(', ')}` : ''}`,
        data: h,
      })));
    }

    // Register countries for all variants
    this.searchModal.registerSource('country', this.buildCountrySearchItems());

    // Handle result selection
    this.searchModal.setOnSelect((result) => this.handleSearchResult(result));

    // Global keyboard shortcut
    this.boundKeydownHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (this.searchModal?.isOpen()) {
          this.searchModal.close();
        } else {
          // Update search index with latest data before opening
          this.updateSearchIndex();
          this.searchModal?.open();
        }
      }
    };
    document.addEventListener('keydown', this.boundKeydownHandler);
  }

  private handleSearchResult(result: SearchResult): void {
    switch (result.type) {
      case 'news': {
        // Find and scroll to the news panel containing this item
        const item = result.data as NewsItem;
        this.scrollToPanel('politics');
        this.highlightNewsItem(item.link);
        break;
      }
      case 'hotspot': {
        // Trigger map popup for hotspot
        const hotspot = result.data as typeof INTEL_HOTSPOTS[0];
        this.map?.setView('global');
        setTimeout(() => {
          this.map?.triggerHotspotClick(hotspot.id);
        }, 300);
        break;
      }
      case 'conflict': {
        const conflict = result.data as typeof CONFLICT_ZONES[0];
        this.map?.setView('global');
        setTimeout(() => {
          this.map?.triggerConflictClick(conflict.id);
        }, 300);
        break;
      }
      case 'market': {
        this.scrollToPanel('markets');
        break;
      }
      case 'prediction': {
        this.scrollToPanel('polymarket');
        break;
      }
      case 'base': {
        const base = result.data as typeof MILITARY_BASES[0];
        this.map?.setView('global');
        setTimeout(() => {
          this.map?.triggerBaseClick(base.id);
        }, 300);
        break;
      }
      case 'pipeline': {
        const pipeline = result.data as typeof PIPELINES[0];
        this.map?.setView('global');
        this.map?.enableLayer('pipelines');
        this.mapLayers.pipelines = true;
        setTimeout(() => {
          this.map?.triggerPipelineClick(pipeline.id);
        }, 300);
        break;
      }
      case 'cable': {
        const cable = result.data as typeof UNDERSEA_CABLES[0];
        this.map?.setView('global');
        this.map?.enableLayer('cables');
        this.mapLayers.cables = true;
        setTimeout(() => {
          this.map?.triggerCableClick(cable.id);
        }, 300);
        break;
      }
      case 'datacenter': {
        const dc = result.data as typeof AI_DATA_CENTERS[0];
        this.map?.setView('global');
        this.map?.enableLayer('datacenters');
        this.mapLayers.datacenters = true;
        setTimeout(() => {
          this.map?.triggerDatacenterClick(dc.id);
        }, 300);
        break;
      }
      case 'nuclear': {
        const nuc = result.data as typeof NUCLEAR_FACILITIES[0];
        this.map?.setView('global');
        this.map?.enableLayer('nuclear');
        this.mapLayers.nuclear = true;
        setTimeout(() => {
          this.map?.triggerNuclearClick(nuc.id);
        }, 300);
        break;
      }
      case 'irradiator': {
        const irr = result.data as typeof GAMMA_IRRADIATORS[0];
        this.map?.setView('global');
        this.map?.enableLayer('irradiators');
        this.mapLayers.irradiators = true;
        setTimeout(() => {
          this.map?.triggerIrradiatorClick(irr.id);
        }, 300);
        break;
      }
      case 'earthquake':
      case 'outage':
        // These are dynamic, just switch to map view
        this.map?.setView('global');
        break;
      case 'techcompany': {
        const company = result.data as typeof TECH_COMPANIES[0];
        this.map?.setView('global');
        this.map?.enableLayer('techHQs');
        this.mapLayers.techHQs = true;
        setTimeout(() => {
          this.map?.setCenter(company.lat, company.lon, 4);
        }, 300);
        break;
      }
      case 'ailab': {
        const lab = result.data as typeof AI_RESEARCH_LABS[0];
        this.map?.setView('global');
        setTimeout(() => {
          this.map?.setCenter(lab.lat, lab.lon, 4);
        }, 300);
        break;
      }
      case 'startup': {
        const ecosystem = result.data as typeof STARTUP_ECOSYSTEMS[0];
        this.map?.setView('global');
        this.map?.enableLayer('startupHubs');
        this.mapLayers.startupHubs = true;
        setTimeout(() => {
          this.map?.setCenter(ecosystem.lat, ecosystem.lon, 4);
        }, 300);
        break;
      }
      case 'techevent':
        this.map?.setView('global');
        this.map?.enableLayer('techEvents');
        this.mapLayers.techEvents = true;
        break;
      case 'techhq': {
        const hq = result.data as typeof TECH_HQS[0];
        this.map?.setView('global');
        this.map?.enableLayer('techHQs');
        this.mapLayers.techHQs = true;
        setTimeout(() => {
          this.map?.setCenter(hq.lat, hq.lon, 4);
        }, 300);
        break;
      }
      case 'accelerator': {
        const acc = result.data as typeof ACCELERATORS[0];
        this.map?.setView('global');
        this.map?.enableLayer('accelerators');
        this.mapLayers.accelerators = true;
        setTimeout(() => {
          this.map?.setCenter(acc.lat, acc.lon, 4);
        }, 300);
        break;
      }
      case 'exchange': {
        const exchange = result.data as typeof STOCK_EXCHANGES[0];
        this.map?.setView('global');
        this.map?.enableLayer('stockExchanges');
        this.mapLayers.stockExchanges = true;
        setTimeout(() => {
          this.map?.setCenter(exchange.lat, exchange.lon, 4);
        }, 300);
        break;
      }
      case 'financialcenter': {
        const fc = result.data as typeof FINANCIAL_CENTERS[0];
        this.map?.setView('global');
        this.map?.enableLayer('financialCenters');
        this.mapLayers.financialCenters = true;
        setTimeout(() => {
          this.map?.setCenter(fc.lat, fc.lon, 4);
        }, 300);
        break;
      }
      case 'centralbank': {
        const bank = result.data as typeof CENTRAL_BANKS[0];
        this.map?.setView('global');
        this.map?.enableLayer('centralBanks');
        this.mapLayers.centralBanks = true;
        setTimeout(() => {
          this.map?.setCenter(bank.lat, bank.lon, 4);
        }, 300);
        break;
      }
      case 'commodityhub': {
        const hub = result.data as typeof COMMODITY_HUBS[0];
        this.map?.setView('global');
        this.map?.enableLayer('commodityHubs');
        this.mapLayers.commodityHubs = true;
        setTimeout(() => {
          this.map?.setCenter(hub.lat, hub.lon, 4);
        }, 300);
        break;
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        this.openCountryBriefByCode(code, name);
        break;
      }
    }
  }

  private scrollToPanel(panelId: string): void {
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel.classList.add('flash-highlight');
      setTimeout(() => panel.classList.remove('flash-highlight'), 1500);
    }
  }

  private highlightNewsItem(itemId: string): void {
    setTimeout(() => {
      const item = document.querySelector(`[data-news-id="${itemId}"]`);
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.classList.add('flash-highlight');
        setTimeout(() => item.classList.remove('flash-highlight'), 1500);
      }
    }, 100);
  }

  private updateSearchIndex(): void {
    if (!this.searchModal) return;

    // Keep country CII labels fresh with latest ingested signals.
    this.searchModal.registerSource('country', this.buildCountrySearchItems());

    // Update news sources (use link as unique id) - index up to 500 items for better search coverage
    const newsItems = this.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.allNews.length})`);
    this.searchModal.registerSource('news', newsItems);

    // Update predictions if available
    if (this.latestPredictions.length > 0) {
      this.searchModal.registerSource('prediction', this.latestPredictions.map(p => ({
        id: p.title,
        title: p.title,
        subtitle: `${(p.yesPrice * 100).toFixed(0)}% probability`,
        data: p,
      })));
    }

    // Update markets if available
    if (this.latestMarkets.length > 0) {
      this.searchModal.registerSource('market', this.latestMarkets.map(m => ({
        id: m.symbol,
        title: `${m.symbol} - ${m.name}`,
        subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
        data: m,
      })));
    }
  }

  private buildCountrySearchItems(): { id: string; title: string; subtitle: string; data: { code: string; name: string } }[] {
    const panelScores = (this.panels['cii'] as CIIPanel | undefined)?.getScores() ?? [];
    const scores = panelScores.length > 0 ? panelScores : calculateCII();
    const ciiByCode = new Map(scores.map((score) => [score.code, score]));
    return Object.entries(TIER1_COUNTRIES).map(([code, name]) => {
      const score = ciiByCode.get(code);
      return {
        id: code,
        title: `${App.toFlagEmoji(code)} ${name}`,
        subtitle: score ? `CII: ${score.score}/100 • ${score.level}` : 'Country Brief',
        data: { code, name },
      };
    });
  }

  private static toFlagEmoji(code: string): string {
    const upperCode = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(upperCode)) return '🏳️';
    return upperCode
      .split('')
      .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
      .join('');
  }

  private setupPlaybackControl(): void {
    this.playbackControl = new PlaybackControl();
    this.playbackControl.onSnapshot((snapshot) => {
      if (snapshot) {
        this.isPlaybackMode = true;
        this.restoreSnapshot(snapshot);
      } else {
        this.isPlaybackMode = false;
        this.loadAllData();
      }
    });

    const headerRight = this.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.playbackControl.getElement(), headerRight.firstChild);
    }
  }

  private setupSnapshotSaving(): void {
    const saveCurrentSnapshot = async () => {
      if (this.isPlaybackMode || this.isDestroyed) return;

      const marketPrices: Record<string, number> = {};
      this.latestMarkets.forEach(m => {
        if (m.price !== null) marketPrices[m.symbol] = m.price;
      });

      await saveSnapshot({
        timestamp: Date.now(),
        events: this.latestClusters,
        marketPrices,
        predictions: this.latestPredictions.map(p => ({
          title: p.title,
          yesPrice: p.yesPrice
        })),
        hotspotLevels: this.map?.getHotspotLevels() ?? {}
      });
    };

    saveCurrentSnapshot();
    this.snapshotIntervalId = setInterval(saveCurrentSnapshot, 15 * 60 * 1000);
  }

  private restoreSnapshot(snapshot: import('@/services/storage').DashboardSnapshot): void {
    for (const panel of Object.values(this.newsPanels)) {
      panel.showLoading();
    }

    const events = snapshot.events as ClusteredEvent[];
    this.latestClusters = events;

    const predictions = snapshot.predictions.map((p, i) => ({
      id: `snap-${i}`,
      title: p.title,
      yesPrice: p.yesPrice,
      noPrice: 1 - p.yesPrice,
      volume24h: 0,
      liquidity: 0,
    }));
    this.latestPredictions = predictions;
    (this.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);

    this.map?.setHotspotLevels(snapshot.hotspotLevels);
  }

  private renderLayout(): void {
    const currentLang = getCurrentLanguage();
    const langOptions = LANGUAGES.map(l =>
      `<option value="${l.code}" ${l.code === currentLang ? 'selected' : ''}>${l.flag} ${l.code.toUpperCase()}</option>`
    ).join('');

    this.container.innerHTML = `
      <div class="header">
        <div class="header-left">
          <div class="variant-switcher">
            <a href="${this.isDesktopApp ? '#' : (SITE_VARIANT === 'full' ? '#' : 'https://worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'full' ? 'active' : ''}"
               data-variant="full"
               ${!this.isDesktopApp && SITE_VARIANT !== 'full' ? 'target="_blank" rel="noopener"' : ''}
               title="${t('header.world')}${SITE_VARIANT === 'full' ? ' (current)' : ''}">
              <span class="variant-icon">🌍</span>
              <span class="variant-label">${t('header.world')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${this.isDesktopApp ? '#' : (SITE_VARIANT === 'tech' ? '#' : 'https://tech.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'tech' ? 'active' : ''}"
               data-variant="tech"
               ${!this.isDesktopApp && SITE_VARIANT !== 'tech' ? 'target="_blank" rel="noopener"' : ''}
               title="${t('header.tech')}${SITE_VARIANT === 'tech' ? ' (current)' : ''}">
              <span class="variant-icon">💻</span>
              <span class="variant-label">${t('header.tech')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${this.isDesktopApp ? '#' : (SITE_VARIANT === 'finance' ? '#' : 'https://finance.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'finance' ? 'active' : ''}"
               data-variant="finance"
               ${!this.isDesktopApp && SITE_VARIANT !== 'finance' ? 'target="_blank" rel="noopener"' : ''}
               title="${t('header.finance')}${SITE_VARIANT === 'finance' ? ' (current)' : ''}">
              <span class="variant-icon">📈</span>
              <span class="variant-label">${t('header.finance')}</span>
            </a>
          </div>
          <span class="logo">MONITOR</span><span class="version">v${__APP_VERSION__}</span>
          <a href="https://x.com/eliehabib" target="_blank" rel="noopener" class="credit-link">
            <svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            <span class="credit-text">@eliehabib</span>
          </a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener" class="github-link" title="${t('header.viewOnGitHub')}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>${t('header.live')}</span>
          </div>
          <div class="region-selector">
            <select id="regionSelect" class="region-select">
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
        </div>
        <div class="header-right">
          <select id="langSelect" class="lang-select">
            ${langOptions}
          </select>
          <button class="search-btn" id="searchBtn"><kbd>⌘K</kbd> ${t('header.search')}</button>
          ${this.isDesktopApp ? '' : `<button class="copy-link-btn" id="copyLinkBtn">${t('header.copyLink')}</button>`}
          <button class="theme-toggle-btn" id="headerThemeToggle" title="${t('header.toggleTheme')}">
            ${getCurrentTheme() === 'dark'
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'}
          </button>
          <span class="time-display" id="timeDisplay">--:--:-- UTC</span>
          ${this.isDesktopApp ? '' : `<button class="fullscreen-btn" id="fullscreenBtn" title="${t('header.fullscreen')}">⛶</button>`}
          <button class="settings-btn" id="settingsBtn">⚙ ${t('header.settings')}</button>
          <button class="sources-btn" id="sourcesBtn">📡 ${t('header.sources')}</button>
        </div>
      </div>
      <div class="main-content">
        <div class="map-section" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">${SITE_VARIANT === 'tech' ? t('panels.techMap') : t('panels.map')}</span>
            </div>
            <span class="header-clock" id="headerClock"></span>
            <button class="map-pin-btn" id="mapPinBtn" title="${t('header.pinMap')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 1 1 0 001-1V4a1 1 0 00-1-1H8a1 1 0 00-1 1v1a1 1 0 001 1 1 1 0 011 1v3.76z"/>
              </svg>
            </button>
          </div>
          <div class="map-container" id="mapContainer"></div>
          <div class="map-resize-handle" id="mapResizeHandle"></div>
        </div>
        <div class="panels-grid" id="panelsGrid"></div>
      </div>
      <div class="modal-overlay" id="settingsModal">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">${t('header.settings')}</span>
            <button class="modal-close" id="modalClose">×</button>
          </div>
          <div class="panel-toggle-grid" id="panelToggles"></div>
        </div>
      </div>
      <div class="modal-overlay" id="sourcesModal">
        <div class="modal sources-modal">
          <div class="modal-header">
            <span class="modal-title">${t('header.sources')}</span>
            <span class="sources-counter" id="sourcesCounter"></span>
            <button class="modal-close" id="sourcesModalClose">×</button>
          </div>
          <div class="sources-search">
            <input type="text" id="sourcesSearch" placeholder="${t('header.filterSources')}" />
          </div>
          <div class="sources-toggle-grid" id="sourceToggles"></div>
          <div class="sources-footer">
            <button class="sources-select-all" id="sourcesSelectAll">${t('common.selectAll')}</button>
            <button class="sources-select-none" id="sourcesSelectNone">${t('common.selectNone')}</button>
          </div>
        </div>
      </div>
    `;

    this.createPanels();
    this.renderPanelToggles();
  }

  /**
   * Render critical military posture banner when buildup detected
   */
  private renderCriticalBanner(postures: TheaterPostureSummary[]): void {
    // Check if banner was dismissed this session
    const dismissedAt = sessionStorage.getItem('banner-dismissed');
    if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < 30 * 60 * 1000) {
      return; // Stay dismissed for 30 minutes
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

    // Always ensure body class is set when showing banner
    document.body.classList.add('has-critical-banner');
    this.criticalBannerEl.className = `critical-posture-banner ${isCritical ? 'severity-critical' : 'severity-elevated'}`;
    this.criticalBannerEl.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon">${isCritical ? '🚨' : '⚠️'}</span>
        <span class="banner-headline">${top.headline}</span>
        <span class="banner-stats">${top.totalAircraft} aircraft • ${top.summary}</span>
        ${top.strikeCapable ? '<span class="banner-strike">STRIKE CAPABLE</span>' : ''}
      </div>
      <button class="banner-view" data-lat="${top.centerLat}" data-lon="${top.centerLon}">View Region</button>
      <button class="banner-dismiss">×</button>
    `;

    // Event handlers
    this.criticalBannerEl.querySelector('.banner-view')?.addEventListener('click', () => {
      console.log('[Banner] View Region clicked:', top.theaterId, 'lat:', top.centerLat, 'lon:', top.centerLon);
      // Use typeof check - truthy check would fail for coordinate 0
      if (typeof top.centerLat === 'number' && typeof top.centerLon === 'number') {
        this.map?.setCenter(top.centerLat, top.centerLon, 4);
      } else {
        console.error('[Banner] Missing coordinates for', top.theaterId);
      }
    });

    this.criticalBannerEl.querySelector('.banner-dismiss')?.addEventListener('click', () => {
      this.criticalBannerEl?.classList.add('dismissed');
      document.body.classList.remove('has-critical-banner');
      sessionStorage.setItem('banner-dismissed', Date.now().toString());
    });
  }

  /**
   * Clean up resources (for HMR/testing)
   */
  public destroy(): void {
    this.isDestroyed = true;

    // Clear snapshot saving interval
    if (this.snapshotIntervalId) {
      clearInterval(this.snapshotIntervalId);
      this.snapshotIntervalId = null;
    }

    // Clear all refresh timeouts
    for (const timeoutId of this.refreshTimeoutIds.values()) {
      clearTimeout(timeoutId);
    }
    this.refreshTimeoutIds.clear();

    // Remove global event listeners
    if (this.boundKeydownHandler) {
      document.removeEventListener('keydown', this.boundKeydownHandler);
      this.boundKeydownHandler = null;
    }
    if (this.boundFullscreenHandler) {
      document.removeEventListener('fullscreenchange', this.boundFullscreenHandler);
      this.boundFullscreenHandler = null;
    }
    if (this.boundResizeHandler) {
      window.removeEventListener('resize', this.boundResizeHandler);
      this.boundResizeHandler = null;
    }
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }

    // Clean up idle detection
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.boundIdleResetHandler) {
      ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
        document.removeEventListener(event, this.boundIdleResetHandler!);
      });
      this.boundIdleResetHandler = null;
    }

    // Clean up map and AIS
    this.map?.destroy();
    disconnectAisStream();
  }

  private createPanels(): void {
    const panelsGrid = document.getElementById('panelsGrid')!;

    // Initialize map in the map section
    // Default to MENA view on mobile for better focus
    // Uses deck.gl (WebGL) on desktop, falls back to D3/SVG on mobile
    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    this.map = new MapContainer(mapContainer, {
      zoom: this.isMobile ? 2.5 : 1.0,
      pan: { x: 0, y: 0 },  // Centered view to show full world
      view: this.isMobile ? 'mena' : 'global',
      layers: this.mapLayers,
      timeRange: '7d',
    });

    // Initialize escalation service with data getters
    this.map.initEscalationGetters();
    this.currentTimeRange = this.map.getTimeRange();

    // Create all panels
    const politicsPanel = new NewsPanel('politics', t('panels.politics'));
    this.attachRelatedAssetHandlers(politicsPanel);
    this.newsPanels['politics'] = politicsPanel;
    this.panels['politics'] = politicsPanel;

    const techPanel = new NewsPanel('tech', t('panels.tech'));
    this.attachRelatedAssetHandlers(techPanel);
    this.newsPanels['tech'] = techPanel;
    this.panels['tech'] = techPanel;

    const financePanel = new NewsPanel('finance', t('panels.finance'));
    this.attachRelatedAssetHandlers(financePanel);
    this.newsPanels['finance'] = financePanel;
    this.panels['finance'] = financePanel;

    const heatmapPanel = new HeatmapPanel();
    this.panels['heatmap'] = heatmapPanel;

    const marketsPanel = new MarketPanel();
    this.panels['markets'] = marketsPanel;

    const monitorPanel = new MonitorPanel(this.monitors);
    this.panels['monitors'] = monitorPanel;
    monitorPanel.onChanged((monitors) => {
      this.monitors = monitors;
      saveToStorage(STORAGE_KEYS.monitors, monitors);
      this.updateMonitorResults();
    });

    const commoditiesPanel = new CommoditiesPanel();
    this.panels['commodities'] = commoditiesPanel;

    const predictionPanel = new PredictionPanel();
    this.panels['polymarket'] = predictionPanel;

    const govPanel = new NewsPanel('gov', t('panels.gov'));
    this.attachRelatedAssetHandlers(govPanel);
    this.newsPanels['gov'] = govPanel;
    this.panels['gov'] = govPanel;

    const intelPanel = new NewsPanel('intel', t('panels.intel'));
    this.attachRelatedAssetHandlers(intelPanel);
    this.newsPanels['intel'] = intelPanel;
    this.panels['intel'] = intelPanel;

    const cryptoPanel = new CryptoPanel();
    this.panels['crypto'] = cryptoPanel;

    const middleeastPanel = new NewsPanel('middleeast', t('panels.middleeast'));
    this.attachRelatedAssetHandlers(middleeastPanel);
    this.newsPanels['middleeast'] = middleeastPanel;
    this.panels['middleeast'] = middleeastPanel;

    const layoffsPanel = new NewsPanel('layoffs', t('panels.layoffs'));
    this.attachRelatedAssetHandlers(layoffsPanel);
    this.newsPanels['layoffs'] = layoffsPanel;
    this.panels['layoffs'] = layoffsPanel;

    const aiPanel = new NewsPanel('ai', t('panels.ai'));
    this.attachRelatedAssetHandlers(aiPanel);
    this.newsPanels['ai'] = aiPanel;
    this.panels['ai'] = aiPanel;

    // Tech variant panels
    const startupsPanel = new NewsPanel('startups', t('panels.startups'));
    this.attachRelatedAssetHandlers(startupsPanel);
    this.newsPanels['startups'] = startupsPanel;
    this.panels['startups'] = startupsPanel;

    const vcblogsPanel = new NewsPanel('vcblogs', t('panels.vcblogs'));
    this.attachRelatedAssetHandlers(vcblogsPanel);
    this.newsPanels['vcblogs'] = vcblogsPanel;
    this.panels['vcblogs'] = vcblogsPanel;

    const regionalStartupsPanel = new NewsPanel('regionalStartups', t('panels.regionalStartups'));
    this.attachRelatedAssetHandlers(regionalStartupsPanel);
    this.newsPanels['regionalStartups'] = regionalStartupsPanel;
    this.panels['regionalStartups'] = regionalStartupsPanel;

    const unicornsPanel = new NewsPanel('unicorns', t('panels.unicorns'));
    this.attachRelatedAssetHandlers(unicornsPanel);
    this.newsPanels['unicorns'] = unicornsPanel;
    this.panels['unicorns'] = unicornsPanel;

    const acceleratorsPanel = new NewsPanel('accelerators', t('panels.accelerators'));
    this.attachRelatedAssetHandlers(acceleratorsPanel);
    this.newsPanels['accelerators'] = acceleratorsPanel;
    this.panels['accelerators'] = acceleratorsPanel;

    const fundingPanel = new NewsPanel('funding', t('panels.funding'));
    this.attachRelatedAssetHandlers(fundingPanel);
    this.newsPanels['funding'] = fundingPanel;
    this.panels['funding'] = fundingPanel;

    const producthuntPanel = new NewsPanel('producthunt', t('panels.producthunt'));
    this.attachRelatedAssetHandlers(producthuntPanel);
    this.newsPanels['producthunt'] = producthuntPanel;
    this.panels['producthunt'] = producthuntPanel;

    const securityPanel = new NewsPanel('security', t('panels.security'));
    this.attachRelatedAssetHandlers(securityPanel);
    this.newsPanels['security'] = securityPanel;
    this.panels['security'] = securityPanel;

    const policyPanel = new NewsPanel('policy', t('panels.policy'));
    this.attachRelatedAssetHandlers(policyPanel);
    this.newsPanels['policy'] = policyPanel;
    this.panels['policy'] = policyPanel;

    const hardwarePanel = new NewsPanel('hardware', t('panels.hardware'));
    this.attachRelatedAssetHandlers(hardwarePanel);
    this.newsPanels['hardware'] = hardwarePanel;
    this.panels['hardware'] = hardwarePanel;

    const cloudPanel = new NewsPanel('cloud', t('panels.cloud'));
    this.attachRelatedAssetHandlers(cloudPanel);
    this.newsPanels['cloud'] = cloudPanel;
    this.panels['cloud'] = cloudPanel;

    const devPanel = new NewsPanel('dev', t('panels.dev'));
    this.attachRelatedAssetHandlers(devPanel);
    this.newsPanels['dev'] = devPanel;
    this.panels['dev'] = devPanel;

    const githubPanel = new NewsPanel('github', t('panels.github'));
    this.attachRelatedAssetHandlers(githubPanel);
    this.newsPanels['github'] = githubPanel;
    this.panels['github'] = githubPanel;

    const ipoPanel = new NewsPanel('ipo', t('panels.ipo'));
    this.attachRelatedAssetHandlers(ipoPanel);
    this.newsPanels['ipo'] = ipoPanel;
    this.panels['ipo'] = ipoPanel;

    const thinktanksPanel = new NewsPanel('thinktanks', t('panels.thinktanks'));
    this.attachRelatedAssetHandlers(thinktanksPanel);
    this.newsPanels['thinktanks'] = thinktanksPanel;
    this.panels['thinktanks'] = thinktanksPanel;

    const economicPanel = new EconomicPanel();
    this.panels['economic'] = economicPanel;

    // New Regional Panels
    const africaPanel = new NewsPanel('africa', t('panels.africa'));
    this.attachRelatedAssetHandlers(africaPanel);
    this.newsPanels['africa'] = africaPanel;
    this.panels['africa'] = africaPanel;

    const latamPanel = new NewsPanel('latam', t('panels.latam'));
    this.attachRelatedAssetHandlers(latamPanel);
    this.newsPanels['latam'] = latamPanel;
    this.panels['latam'] = latamPanel;

    const asiaPanel = new NewsPanel('asia', t('panels.asia'));
    this.attachRelatedAssetHandlers(asiaPanel);
    this.newsPanels['asia'] = asiaPanel;
    this.panels['asia'] = asiaPanel;

    const energyPanel = new NewsPanel('energy', t('panels.energy'));
    this.attachRelatedAssetHandlers(energyPanel);
    this.newsPanels['energy'] = energyPanel;
    this.panels['energy'] = energyPanel;

    // Dynamically create NewsPanel instances for any FEEDS category.
    // If a category key collides with an existing data panel key (e.g. markets),
    // create a separate `${key}-news` panel to avoid clobbering the data panel.
    for (const key of Object.keys(FEEDS)) {
      if (this.newsPanels[key]) continue;
      if (!Array.isArray((FEEDS as Record<string, unknown>)[key])) continue;
      const panelKey = this.panels[key] && !this.newsPanels[key] ? `${key}-news` : key;
      if (this.panels[panelKey]) continue;
      const panelConfig = DEFAULT_PANELS[panelKey] ?? DEFAULT_PANELS[key];
      const label = panelConfig?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
      const panel = new NewsPanel(panelKey, label);
      this.attachRelatedAssetHandlers(panel);
      this.newsPanels[key] = panel;
      this.panels[panelKey] = panel;
    }

    // Geopolitical-only panels (not needed for tech variant)
    if (SITE_VARIANT === 'full') {
      const gdeltIntelPanel = new GdeltIntelPanel();
      this.panels['gdelt-intel'] = gdeltIntelPanel;

      const ciiPanel = new CIIPanel();
      ciiPanel.setShareStoryHandler((code, name) => {
        this.openCountryStory(code, name);
      });
      this.panels['cii'] = ciiPanel;

      const cascadePanel = new CascadePanel();
      this.panels['cascade'] = cascadePanel;

      const satelliteFiresPanel = new SatelliteFiresPanel();
      this.panels['satellite-fires'] = satelliteFiresPanel;

      const strategicRiskPanel = new StrategicRiskPanel();
      strategicRiskPanel.setLocationClickHandler((lat, lon) => {
        this.map?.setCenter(lat, lon, 4);
      });
      this.panels['strategic-risk'] = strategicRiskPanel;

      const strategicPosturePanel = new StrategicPosturePanel();
      strategicPosturePanel.setLocationClickHandler((lat, lon) => {
        console.log('[App] StrategicPosture handler called:', { lat, lon, hasMap: !!this.map });
        this.map?.setCenter(lat, lon, 4);
      });
      this.panels['strategic-posture'] = strategicPosturePanel;

      const ucdpEventsPanel = new UcdpEventsPanel();
      ucdpEventsPanel.setEventClickHandler((lat, lon) => {
        this.map?.setCenter(lat, lon, 5);
      });
      this.panels['ucdp-events'] = ucdpEventsPanel;

      const displacementPanel = new DisplacementPanel();
      displacementPanel.setCountryClickHandler((lat, lon) => {
        this.map?.setCenter(lat, lon, 4);
      });
      this.panels['displacement'] = displacementPanel;

      const climatePanel = new ClimateAnomalyPanel();
      climatePanel.setZoneClickHandler((lat, lon) => {
        this.map?.setCenter(lat, lon, 4);
      });
      this.panels['climate'] = climatePanel;

      const populationExposurePanel = new PopulationExposurePanel();
      this.panels['population-exposure'] = populationExposurePanel;
    }

    // GCC Investments Panel (finance variant)
    if (SITE_VARIANT === 'finance') {
      const investmentsPanel = new InvestmentsPanel((inv) => {
        focusInvestmentOnMap(this.map, this.mapLayers, inv.lat, inv.lon);
      });
      this.panels['gcc-investments'] = investmentsPanel;
    }

    const liveNewsPanel = new LiveNewsPanel();
    this.panels['live-news'] = liveNewsPanel;

    // Tech Events Panel (tech variant only - but create for all to allow toggling)
    this.panels['events'] = new TechEventsPanel('events');

    // Service Status Panel (primarily for tech variant)
    const serviceStatusPanel = new ServiceStatusPanel();
    this.panels['service-status'] = serviceStatusPanel;

    if (this.isDesktopApp) {
      const runtimeConfigPanel = new RuntimeConfigPanel({ mode: 'alert' });
      this.panels['runtime-config'] = runtimeConfigPanel;
    }

    // Tech Readiness Panel (tech variant only - World Bank tech indicators)
    const techReadinessPanel = new TechReadinessPanel();
    this.panels['tech-readiness'] = techReadinessPanel;

    // Crypto & Market Intelligence Panels
    this.panels['macro-signals'] = new MacroSignalsPanel();
    this.panels['etf-flows'] = new ETFFlowsPanel();
    this.panels['stablecoins'] = new StablecoinPanel();

    // AI Insights Panel (desktop only - hides itself on mobile)
    const insightsPanel = new InsightsPanel();
    this.panels['insights'] = insightsPanel;

    // Add panels to grid in saved order
    // Use DEFAULT_PANELS keys for variant-aware panel order
    const defaultOrder = Object.keys(DEFAULT_PANELS).filter(k => k !== 'map');
    const savedOrder = this.getSavedPanelOrder();
    // Merge saved order with default to include new panels
    let panelOrder = defaultOrder;
    if (savedOrder.length > 0) {
      // Add any missing panels from default that aren't in saved order
      const missing = defaultOrder.filter(k => !savedOrder.includes(k));
      // Remove any saved panels that no longer exist
      const valid = savedOrder.filter(k => defaultOrder.includes(k));
      // Insert missing panels after 'politics' (except monitors which goes at end)
      const monitorsIdx = valid.indexOf('monitors');
      if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1); // Remove monitors temporarily
      const insertIdx = valid.indexOf('politics') + 1 || 0;
      const newPanels = missing.filter(k => k !== 'monitors');
      valid.splice(insertIdx, 0, ...newPanels);
      valid.push('monitors'); // Always put monitors last
      panelOrder = valid;
    }

    // CRITICAL: live-news MUST be first for CSS Grid layout (spans 2 columns)
    // Move it to position 0 if it exists and isn't already first
    const liveNewsIdx = panelOrder.indexOf('live-news');
    if (liveNewsIdx > 0) {
      panelOrder.splice(liveNewsIdx, 1);
      panelOrder.unshift('live-news');
    }

    // Desktop configuration should stay easy to reach in Tauri builds.
    if (this.isDesktopApp) {
      const runtimeIdx = panelOrder.indexOf('runtime-config');
      if (runtimeIdx > 1) {
        panelOrder.splice(runtimeIdx, 1);
        panelOrder.splice(1, 0, 'runtime-config');
      } else if (runtimeIdx === -1) {
        panelOrder.splice(1, 0, 'runtime-config');
      }
    }

    panelOrder.forEach((key: string) => {
      const panel = this.panels[key];
      if (panel) {
        const el = panel.getElement();
        this.makeDraggable(el, key);
        panelsGrid.appendChild(el);
      }
    });

    this.map.onTimeRangeChanged((range) => {
      this.currentTimeRange = range;
      this.applyTimeRangeFilterToNewsPanelsDebounced();
    });

    this.applyPanelSettings();
    this.applyInitialUrlState();

  }

  private applyInitialUrlState(): void {
    if (!this.initialUrlState || !this.map) return;

    const { view, zoom, lat, lon, timeRange, layers } = this.initialUrlState;

    if (view) {
      this.map.setView(view);
    }

    if (timeRange) {
      this.map.setTimeRange(timeRange);
    }

    if (layers) {
      this.mapLayers = layers;
      saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
      this.map.setLayers(layers);
    }

    // Only apply custom lat/lon/zoom if NO view preset is specified
    // When a view is specified (eu, mena, etc.), use the preset's positioning
    if (!view) {
      if (zoom !== undefined) {
        this.map.setZoom(zoom);
      }

      // Only apply lat/lon if user has zoomed in significantly (zoom > 2)
      // At default zoom (~1-1.5), show centered global view to avoid clipping issues
      if (lat !== undefined && lon !== undefined && zoom !== undefined && zoom > 2) {
        this.map.setCenter(lat, lon);
      }
    }

    // Sync header region selector with initial view
    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    const currentView = this.map.getState().view;
    if (regionSelect && currentView) {
      regionSelect.value = currentView;
    }
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.PANEL_ORDER_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  private savePanelOrder(): void {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;
    const order = Array.from(grid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);
    localStorage.setItem(this.PANEL_ORDER_KEY, JSON.stringify(order));
  }

  private attachRelatedAssetHandlers(panel: NewsPanel): void {
    panel.setRelatedAssetHandlers({
      onRelatedAssetClick: (asset) => this.handleRelatedAssetClick(asset),
      onRelatedAssetsFocus: (assets) => this.map?.highlightAssets(assets),
      onRelatedAssetsClear: () => this.map?.highlightAssets(null),
    });
  }

  private handleRelatedAssetClick(asset: RelatedAsset): void {
    if (!this.map) return;

    switch (asset.type) {
      case 'pipeline':
        this.map.enableLayer('pipelines');
        this.mapLayers.pipelines = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
        this.map.triggerPipelineClick(asset.id);
        break;
      case 'cable':
        this.map.enableLayer('cables');
        this.mapLayers.cables = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
        this.map.triggerCableClick(asset.id);
        break;
      case 'datacenter':
        this.map.enableLayer('datacenters');
        this.mapLayers.datacenters = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
        this.map.triggerDatacenterClick(asset.id);
        break;
      case 'base':
        this.map.enableLayer('bases');
        this.mapLayers.bases = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
        this.map.triggerBaseClick(asset.id);
        break;
      case 'nuclear':
        this.map.enableLayer('nuclear');
        this.mapLayers.nuclear = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
        this.map.triggerNuclearClick(asset.id);
        break;
    }
  }

  private makeDraggable(el: HTMLElement, key: string): void {
    el.draggable = true;
    el.dataset.panel = key;

    el.addEventListener('dragstart', (e) => {
      const target = e.target as HTMLElement;
      // Don't start drag if panel is being resized
      if (el.dataset.resizing === 'true') {
        e.preventDefault();
        return;
      }
      // Don't start drag if target is the resize handle
      if (target.classList.contains('panel-resize-handle') || target.closest('.panel-resize-handle')) {
        e.preventDefault();
        return;
      }
      el.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', key);
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      this.savePanelOrder();
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = document.querySelector('.dragging');
      if (!dragging || dragging === el) return;

      const grid = document.getElementById('panelsGrid');
      if (!grid) return;

      const siblings = Array.from(grid.children).filter((c) => c !== dragging);
      const nextSibling = siblings.find((sibling) => {
        const rect = sibling.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2;
      });

      if (nextSibling) {
        grid.insertBefore(dragging, nextSibling);
      } else {
        grid.appendChild(dragging);
      }
    });
  }

  private setupEventListeners(): void {
    // Search button
    document.getElementById('searchBtn')?.addEventListener('click', () => {
      this.updateSearchIndex();
      this.searchModal?.open();
    });

    // Copy link button
    document.getElementById('copyLinkBtn')?.addEventListener('click', async () => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      const button = document.getElementById('copyLinkBtn');
      try {
        await this.copyToClipboard(shareUrl);
        this.setCopyLinkFeedback(button, 'Copied!');
      } catch (error) {
        console.warn('Failed to copy share link:', error);
        this.setCopyLinkFeedback(button, 'Copy failed');
      }
    });

    // Settings modal
    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.add('active');
    });

    document.getElementById('modalClose')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.remove('active');
    });

    document.getElementById('settingsModal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
        document.getElementById('settingsModal')?.classList.remove('active');
      }
    });


    // Header theme toggle button
    document.getElementById('headerThemeToggle')?.addEventListener('click', () => {
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      this.updateHeaderThemeIcon();
    });

    // Sources modal
    this.setupSourcesModal();

    // Variant switcher: switch variant locally on desktop (reload with new config)
    if (this.isDesktopApp) {
      this.container.querySelectorAll<HTMLAnchorElement>('.variant-option').forEach(link => {
        link.addEventListener('click', (e) => {
          const variant = link.dataset.variant;
          if (variant && variant !== SITE_VARIANT) {
            e.preventDefault();
            localStorage.setItem('worldmonitor-variant', variant);
            window.location.reload();
          }
        });
      });
    }

    // Fullscreen toggle
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (!this.isDesktopApp && fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
      this.boundFullscreenHandler = () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '⛶' : '⛶';
        fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
      };
      document.addEventListener('fullscreenchange', this.boundFullscreenHandler);
    }

    // Region selector
    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    regionSelect?.addEventListener('change', () => {
      this.map?.setView(regionSelect.value as MapView);
    });

    // Language selector
    const langSelect = document.getElementById('langSelect') as HTMLSelectElement;
    langSelect?.addEventListener('change', () => {
      void changeLanguage(langSelect.value);
    });

    // Window resize
    this.boundResizeHandler = () => {
      this.map?.render();
    };
    window.addEventListener('resize', this.boundResizeHandler);

    // Map section resize handle
    this.setupMapResize();

    // Map pin toggle
    this.setupMapPin();

    // Pause animations when tab is hidden, unload ML models to free memory
    this.boundVisibilityHandler = () => {
      document.body.classList.toggle('animations-paused', document.hidden);
      if (document.hidden) {
        mlWorker.unloadOptionalModels();
      } else {
        this.resetIdleTimer();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // Refresh CII when focal points are ready (ensures focal point urgency is factored in)
    window.addEventListener('focal-points-ready', () => {
      (this.panels['cii'] as CIIPanel)?.refresh(true); // forceLocal to use focal point data
    });

    // Re-render components with baked getCSSColor() values on theme change
    window.addEventListener('theme-changed', () => {
      this.map?.render();
      this.updateHeaderThemeIcon();
    });

    // Idle detection - pause animations after 2 minutes of inactivity
    this.setupIdleDetection();
  }

  private setupIdleDetection(): void {
    this.boundIdleResetHandler = () => {
      // User is active - resume animations if we were idle
      if (this.isIdle) {
        this.isIdle = false;
        document.body.classList.remove('animations-paused');
      }
      this.resetIdleTimer();
    };

    // Track user activity
    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.addEventListener(event, this.boundIdleResetHandler!, { passive: true });
    });

    // Start the idle timer
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
    }
    this.idleTimeoutId = setTimeout(() => {
      if (!document.hidden) {
        this.isIdle = true;
        document.body.classList.add('animations-paused');
        console.log('[App] User idle - pausing animations to save resources');
      }
    }, this.IDLE_PAUSE_MS);
  }

  private setupUrlStateSync(): void {
    if (!this.map) return;
    const update = debounce(() => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      history.replaceState(null, '', shareUrl);
    }, 250);

    this.map.onStateChanged(() => {
      update();
      // Sync header region selector with map view
      const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
      if (regionSelect && this.map) {
        const state = this.map.getState();
        if (regionSelect.value !== state.view) {
          regionSelect.value = state.view;
        }
      }
    });
    update();
  }

  private getShareUrl(): string | null {
    if (!this.map) return null;
    const state = this.map.getState();
    const center = this.map.getCenter();
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return buildMapUrl(baseUrl, {
      view: state.view,
      zoom: state.zoom,
      center,
      timeRange: state.timeRange,
      layers: state.layers,
      country: this.countryBriefPage?.isVisible() ? (this.countryBriefPage.getCode() ?? undefined) : undefined,
    });
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  private setCopyLinkFeedback(button: HTMLElement | null, message: string): void {
    if (!button) return;
    const originalText = button.textContent ?? '';
    button.textContent = message;
    button.classList.add('copied');
    window.setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }

  private setupMapResize(): void {
    const mapSection = document.getElementById('mapSection');
    const resizeHandle = document.getElementById('mapResizeHandle');
    if (!mapSection || !resizeHandle) return;

    // Load saved height
    const savedHeight = localStorage.getItem('map-height');
    if (savedHeight) {
      mapSection.style.height = savedHeight;
    }

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = mapSection.offsetHeight;
      mapSection.classList.add('resizing');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const deltaY = e.clientY - startY;
      const newHeight = Math.max(400, Math.min(startHeight + deltaY, window.innerHeight - 60));
      mapSection.style.height = `${newHeight}px`;
      this.map?.render();
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      mapSection.classList.remove('resizing');
      document.body.style.cursor = '';
      // Save height preference
      localStorage.setItem('map-height', mapSection.style.height);
      this.map?.render();
    });
  }

  private setupMapPin(): void {
    const mapSection = document.getElementById('mapSection');
    const pinBtn = document.getElementById('mapPinBtn');
    if (!mapSection || !pinBtn) return;

    // Load saved pin state
    const isPinned = localStorage.getItem('map-pinned') === 'true';
    if (isPinned) {
      mapSection.classList.add('pinned');
      pinBtn.classList.add('active');
    }

    pinBtn.addEventListener('click', () => {
      const nowPinned = mapSection.classList.toggle('pinned');
      pinBtn.classList.toggle('active', nowPinned);
      localStorage.setItem('map-pinned', String(nowPinned));
    });
  }

  private renderPanelToggles(): void {
    const container = document.getElementById('panelToggles')!;
    container.innerHTML = Object.entries(this.panelSettings)
      .filter(([key]) => key !== 'runtime-config' || this.isDesktopApp)
      .map(
        ([key, panel]) => `
        <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}" data-panel="${key}">
          <div class="panel-toggle-checkbox">${panel.enabled ? '✓' : ''}</div>
          <span class="panel-toggle-label">${this.getLocalizedPanelName(key, panel.name)}</span>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.panel-toggle-item').forEach((item) => {
      item.addEventListener('click', () => {
        const panelKey = (item as HTMLElement).dataset.panel!;
        const config = this.panelSettings[panelKey];
        console.log('[Panel Toggle] Clicked:', panelKey, 'Current enabled:', config?.enabled);
        if (config) {
          config.enabled = !config.enabled;
          console.log('[Panel Toggle] New enabled:', config.enabled);
          saveToStorage(STORAGE_KEYS.panels, this.panelSettings);
          this.renderPanelToggles();
          this.applyPanelSettings();
          console.log('[Panel Toggle] After apply - config.enabled:', this.panelSettings[panelKey]?.enabled);
        }
      });
    });
  }

  private getLocalizedPanelName(panelKey: string, fallback: string): string {
    if (panelKey === 'runtime-config') {
      return t('modals.runtimeConfig.title');
    }
    const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    const lookup = `panels.${key}`;
    const localized = t(lookup);
    return localized === lookup ? fallback : localized;
  }

  private getAllSourceNames(): string[] {
    const sources = new Set<string>();
    Object.values(FEEDS).forEach(feeds => {
      if (feeds) feeds.forEach(f => sources.add(f.name));
    });
    INTEL_SOURCES.forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }

  private renderSourceToggles(filter = ''): void {
    const container = document.getElementById('sourceToggles')!;
    const allSources = this.getAllSourceNames();
    const filterLower = filter.toLowerCase();
    const filteredSources = filter
      ? allSources.filter(s => s.toLowerCase().includes(filterLower))
      : allSources;

    container.innerHTML = filteredSources.map(source => {
      const isEnabled = !this.disabledSources.has(source);
      const escaped = escapeHtml(source);
      return `
        <div class="source-toggle-item ${isEnabled ? 'active' : ''}" data-source="${escaped}">
          <div class="source-toggle-checkbox">${isEnabled ? '✓' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.source-toggle-item').forEach(item => {
      item.addEventListener('click', () => {
        const sourceName = (item as HTMLElement).dataset.source!;
        if (this.disabledSources.has(sourceName)) {
          this.disabledSources.delete(sourceName);
        } else {
          this.disabledSources.add(sourceName);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.disabledSources));
        this.renderSourceToggles(filter);
      });
    });

    // Update counter
    const enabledCount = allSources.length - this.disabledSources.size;
    const counterEl = document.getElementById('sourcesCounter');
    if (counterEl) {
      counterEl.textContent = t('header.sourcesEnabled', { enabled: String(enabledCount), total: String(allSources.length) });
    }
  }

  private setupSourcesModal(): void {
    document.getElementById('sourcesBtn')?.addEventListener('click', () => {
      document.getElementById('sourcesModal')?.classList.add('active');
      // Clear search and show all sources on open
      const searchInput = document.getElementById('sourcesSearch') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';
      this.renderSourceToggles();
    });

    document.getElementById('sourcesModalClose')?.addEventListener('click', () => {
      document.getElementById('sourcesModal')?.classList.remove('active');
    });

    document.getElementById('sourcesModal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
        document.getElementById('sourcesModal')?.classList.remove('active');
      }
    });

    document.getElementById('sourcesSearch')?.addEventListener('input', (e) => {
      const filter = (e.target as HTMLInputElement).value;
      this.renderSourceToggles(filter);
    });

    document.getElementById('sourcesSelectAll')?.addEventListener('click', () => {
      this.disabledSources.clear();
      saveToStorage(STORAGE_KEYS.disabledFeeds, []);
      const filter = (document.getElementById('sourcesSearch') as HTMLInputElement)?.value || '';
      this.renderSourceToggles(filter);
    });

    document.getElementById('sourcesSelectNone')?.addEventListener('click', () => {
      const allSources = this.getAllSourceNames();
      this.disabledSources = new Set(allSources);
      saveToStorage(STORAGE_KEYS.disabledFeeds, allSources);
      const filter = (document.getElementById('sourcesSearch') as HTMLInputElement)?.value || '';
      this.renderSourceToggles(filter);
    });
  }

  private applyPanelSettings(): void {
    Object.entries(this.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
        }
        return;
      }
      const panel = this.panels[key];
      panel?.toggle(config.enabled);
    });
  }

  private updateHeaderThemeIcon(): void {
    const btn = document.getElementById('headerThemeToggle');
    if (!btn) return;
    const isDark = getCurrentTheme() === 'dark';
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  }

  private async loadAllData(): Promise<void> {
    const runGuarded = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (this.inFlight.has(name)) return;
      this.inFlight.add(name);
      try {
        await fn();
      } finally {
        this.inFlight.delete(name);
      }
    };

    const tasks: Array<{ name: string; task: Promise<void> }> = [
      { name: 'news', task: runGuarded('news', () => this.loadNews()) },
      { name: 'markets', task: runGuarded('markets', () => this.loadMarkets()) },
      { name: 'predictions', task: runGuarded('predictions', () => this.loadPredictions()) },
      { name: 'pizzint', task: runGuarded('pizzint', () => this.loadPizzInt()) },
      { name: 'fred', task: runGuarded('fred', () => this.loadFredData()) },
      { name: 'oil', task: runGuarded('oil', () => this.loadOilAnalytics()) },
      { name: 'spending', task: runGuarded('spending', () => this.loadGovernmentSpending()) },
    ];

    // Load intelligence signals for CII calculation (protests, military, outages)
    // Only for geopolitical variant - tech variant doesn't need CII/focal points
    if (SITE_VARIANT === 'full') {
      tasks.push({ name: 'intelligence', task: runGuarded('intelligence', () => this.loadIntelligenceSignals()) });
    }

    // Conditionally load non-intelligence layers
    // NOTE: outages, protests, military are handled by loadIntelligenceSignals() above
    // They update the map when layers are enabled, so no duplicate tasks needed here
    if (SITE_VARIANT === 'full') tasks.push({ name: 'firms', task: runGuarded('firms', () => this.loadFirmsData()) });
    if (this.mapLayers.natural) tasks.push({ name: 'natural', task: runGuarded('natural', () => this.loadNatural()) });
    if (this.mapLayers.weather) tasks.push({ name: 'weather', task: runGuarded('weather', () => this.loadWeatherAlerts()) });
    if (this.mapLayers.ais) tasks.push({ name: 'ais', task: runGuarded('ais', () => this.loadAisSignals()) });
    if (this.mapLayers.cables) tasks.push({ name: 'cables', task: runGuarded('cables', () => this.loadCableActivity()) });
    if (this.mapLayers.flights) tasks.push({ name: 'flights', task: runGuarded('flights', () => this.loadFlightDelays()) });
    if (CYBER_LAYER_ENABLED && this.mapLayers.cyberThreats) tasks.push({ name: 'cyberThreats', task: runGuarded('cyberThreats', () => this.loadCyberThreats()) });
    if (this.mapLayers.techEvents || SITE_VARIANT === 'tech') tasks.push({ name: 'techEvents', task: runGuarded('techEvents', () => this.loadTechEvents()) });

    // Tech Readiness panel (tech variant only)
    if (SITE_VARIANT === 'tech') {
      tasks.push({ name: 'techReadiness', task: runGuarded('techReadiness', () => (this.panels['tech-readiness'] as TechReadinessPanel)?.refresh()) });
    }

    // Use allSettled to ensure all tasks complete and search index always updates
    const results = await Promise.allSettled(tasks.map(t => t.task));

    // Log any failures but don't block
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        console.error(`[App] ${tasks[idx]?.name} load failed:`, result.reason);
      }
    });

    // Always update search index regardless of individual task failures
    this.updateSearchIndex();
  }

  private async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    if (this.inFlight.has(layer)) return;
    this.inFlight.add(layer);
    this.map?.setLayerLoading(layer, true);
    try {
      switch (layer) {
        case 'natural':
          await this.loadNatural();
          break;
        case 'fires':
          await this.loadFirmsData();
          break;
        case 'weather':
          await this.loadWeatherAlerts();
          break;
        case 'outages':
          await this.loadOutages();
          break;
        case 'cyberThreats':
          await this.loadCyberThreats();
          break;
        case 'ais':
          await this.loadAisSignals();
          break;
        case 'cables':
          await this.loadCableActivity();
          break;
        case 'protests':
          await this.loadProtests();
          break;
        case 'flights':
          await this.loadFlightDelays();
          break;
        case 'military':
          await this.loadMilitary();
          break;
        case 'techEvents':
          console.log('[loadDataForLayer] Loading techEvents...');
          await this.loadTechEvents();
          console.log('[loadDataForLayer] techEvents loaded');
          break;
        case 'ucdpEvents':
        case 'displacement':
        case 'climate':
          await this.loadIntelligenceSignals();
          break;
      }
    } finally {
      this.inFlight.delete(layer);
      this.map?.setLayerLoading(layer, false);
    }
  }

  private findFlashLocation(title: string): { lat: number; lon: number } | null {
    const titleLower = title.toLowerCase();
    let bestMatch: { lat: number; lon: number; matches: number } | null = null;

    const countKeywordMatches = (keywords: string[] | undefined): number => {
      if (!keywords) return 0;
      let matches = 0;
      for (const keyword of keywords) {
        const cleaned = keyword.trim().toLowerCase();
        if (cleaned.length >= 3 && titleLower.includes(cleaned)) {
          matches++;
        }
      }
      return matches;
    };

    for (const hotspot of INTEL_HOTSPOTS) {
      const matches = countKeywordMatches(hotspot.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: hotspot.lat, lon: hotspot.lon, matches };
      }
    }

    for (const conflict of CONFLICT_ZONES) {
      const matches = countKeywordMatches(conflict.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: conflict.center[1], lon: conflict.center[0], matches };
      }
    }

    return bestMatch;
  }

  private flashMapForNews(items: NewsItem[]): void {
    if (!this.map || !this.initialLoadComplete) return;
    const now = Date.now();

    for (const [key, timestamp] of this.mapFlashCache.entries()) {
      if (now - timestamp > this.MAP_FLASH_COOLDOWN_MS) {
        this.mapFlashCache.delete(key);
      }
    }

    for (const item of items) {
      const cacheKey = `${item.source}|${item.link || item.title}`;
      const lastSeen = this.mapFlashCache.get(cacheKey);
      if (lastSeen && now - lastSeen < this.MAP_FLASH_COOLDOWN_MS) {
        continue;
      }

      const location = this.findFlashLocation(item.title);
      if (!location) continue;

      this.map.flashLocation(location.lat, location.lon);
      this.mapFlashCache.set(cacheKey, now);
    }
  }

  private getTimeRangeWindowMs(range: TimeRange): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[range];
  }

  private filterItemsByTimeRange(items: NewsItem[], range: TimeRange = this.currentTimeRange): NewsItem[] {
    if (range === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeWindowMs(range);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  private getTimeRangeLabel(range: TimeRange = this.currentTimeRange): string {
    const labels: Record<TimeRange, string> = {
      '1h': 'the last hour',
      '6h': 'the last 6 hours',
      '24h': 'the last 24 hours',
      '48h': 'the last 48 hours',
      '7d': 'the last 7 days',
      'all': 'all time',
    };
    return labels[range];
  }

  private renderNewsForCategory(category: string, items: NewsItem[]): void {
    this.newsByCategory[category] = items;
    const panel = this.newsPanels[category];
    if (!panel) return;
    const filteredItems = this.filterItemsByTimeRange(items);
    if (filteredItems.length === 0 && items.length > 0) {
      panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
      return;
    }
    panel.renderNews(filteredItems);
  }

  private applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.newsByCategory).forEach(([category, items]) => {
      this.renderNewsForCategory(category, items);
    });
  }

  private async loadNewsCategory(category: string, feeds: typeof FEEDS.politics): Promise<NewsItem[]> {
    try {
      const panel = this.newsPanels[category];
      const renderIntervalMs = 250;
      let lastRenderTime = 0;
      let renderTimeout: ReturnType<typeof setTimeout> | null = null;
      let pendingItems: NewsItem[] | null = null;

      // Filter out disabled sources
      const enabledFeeds = (feeds ?? []).filter(f => !this.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.newsByCategory[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        this.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }

      const flushPendingRender = () => {
        if (!pendingItems) return;
        this.renderNewsForCategory(category, pendingItems);
        pendingItems = null;
        lastRenderTime = Date.now();
      };

      const scheduleRender = (partialItems: NewsItem[]) => {
        if (!panel) return;
        pendingItems = partialItems;
        const elapsed = Date.now() - lastRenderTime;
        if (elapsed >= renderIntervalMs) {
          if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
          }
          flushPendingRender();
          return;
        }

        if (!renderTimeout) {
          renderTimeout = setTimeout(() => {
            renderTimeout = null;
            flushPendingRender();
          }, renderIntervalMs - elapsed);
        }
      };

      const items = await fetchCategoryFeeds(enabledFeeds, {
        onBatch: (partialItems) => {
          scheduleRender(partialItems);
          this.flashMapForNews(partialItems);
        },
      });

      this.renderNewsForCategory(category, items);
      if (panel) {
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = null;
          pendingItems = null;
        }

        const baseline = await updateBaseline(`news:${category}`, items.length);
        const deviation = calculateDeviation(items.length, baseline);
        panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
      }

      this.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });
      this.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });

      return items;
    } catch (error) {
      this.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      this.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      delete this.newsByCategory[category];
      return [];
    }
  }

  private async loadNews(): Promise<void> {
    // Build categories dynamically from whatever feeds the current variant exports
    const categories = Object.entries(FEEDS)
      .filter((entry): entry is [string, typeof FEEDS[keyof typeof FEEDS]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    // Stage category fetches to avoid startup bursts and API pressure in all variants.
    const maxCategoryConcurrency = SITE_VARIANT === 'finance' ? 3 : SITE_VARIANT === 'tech' ? 4 : 5;
    const categoryConcurrency = Math.max(1, Math.min(maxCategoryConcurrency, categories.length));
    const categoryResults: PromiseSettledResult<NewsItem[]>[] = [];
    for (let i = 0; i < categories.length; i += categoryConcurrency) {
      const chunk = categories.slice(i, i + categoryConcurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(({ key, feeds }) => this.loadNewsCategory(key, feeds))
      );
      categoryResults.push(...chunkResults);
    }

    // Collect successful results
    const collectedNews: NewsItem[] = [];
    categoryResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        collectedNews.push(...result.value);
      } else {
        console.error(`[App] News category ${categories[idx]?.key} failed:`, result.reason);
      }
    });

    // Intel (uses different source) - full variant only (defense/military news)
    if (SITE_VARIANT === 'full') {
      const enabledIntelSources = INTEL_SOURCES.filter(f => !this.disabledSources.has(f.name));
      const intelPanel = this.newsPanels['intel'];
      if (enabledIntelSources.length === 0) {
        delete this.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        this.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else {
        const intelResult = await Promise.allSettled([fetchCategoryFeeds(enabledIntelSources)]);
        if (intelResult[0]?.status === 'fulfilled') {
          const intel = intelResult[0].value;
          this.renderNewsForCategory('intel', intel);
          if (intelPanel) {
            const baseline = await updateBaseline('news:intel', intel.length);
            const deviation = calculateDeviation(intel.length, baseline);
            intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          }
          this.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
          collectedNews.push(...intel);
          this.flashMapForNews(intel);
        } else {
          delete this.newsByCategory['intel'];
          console.error('[App] Intel feed failed:', intelResult[0]?.reason);
        }
      }
    }

    this.allNews = collectedNews;
    this.initialLoadComplete = true;
    maybeShowDownloadBanner();
    // Temporal baseline: report news volume
    updateAndCheck([
      { type: 'news', region: 'global', count: collectedNews.length },
    ]).then(anomalies => {
      if (anomalies.length > 0) signalAggregator.ingestTemporalAnomalies(anomalies);
    }).catch(() => { });

    // Update map hotspots
    this.map?.updateHotspotActivity(this.allNews);

    // Update monitors
    this.updateMonitorResults();

    // Update clusters for correlation analysis (hybrid: semantic + Jaccard when ML available)
    try {
      this.latestClusters = mlWorker.isAvailable
        ? await clusterNewsHybrid(this.allNews)
        : await analysisWorker.clusterNews(this.allNews);

      // Update AI Insights panel with new clusters (if ML available)
      if (mlWorker.isAvailable && this.latestClusters.length > 0) {
        const insightsPanel = this.panels['insights'] as InsightsPanel | undefined;
        insightsPanel?.updateInsights(this.latestClusters);
      }

      // Push geo-located news clusters to map
      const geoLocated = this.latestClusters
        .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
        .map(c => ({
          lat: c.lat,
          lon: c.lon,
          title: c.primaryTitle,
          threatLevel: c.threat?.level ?? 'info',
          timestamp: c.lastUpdated,
        }));
      if (geoLocated.length > 0) {
        this.map?.setNewsLocations(geoLocated);
      }
    } catch (error) {
      console.error('[App] Clustering failed, clusters unchanged:', error);
    }
  }

  private async loadMarkets(): Promise<void> {
    try {
      const stocksResult = await fetchMultipleStocks(MARKET_SYMBOLS, {
        onBatch: (partialStocks) => {
          this.latestMarkets = partialStocks;
          (this.panels['markets'] as MarketPanel).renderMarkets(partialStocks);
        },
      });

      const finnhubConfigMsg = 'FINNHUB_API_KEY not configured — add in Settings';
      this.latestMarkets = stocksResult.data;
      (this.panels['markets'] as MarketPanel).renderMarkets(stocksResult.data);

      if (stocksResult.skipped) {
        this.statusPanel?.updateApi('Finnhub', { status: 'error' });
        if (stocksResult.data.length === 0) {
          this.panels['markets']?.showConfigError(finnhubConfigMsg);
        }
        this.panels['heatmap']?.showConfigError(finnhubConfigMsg);
      } else {
        this.statusPanel?.updateApi('Finnhub', { status: 'ok' });

        const sectorsResult = await fetchMultipleStocks(
          SECTORS.map((s) => ({ ...s, display: s.name })),
          {
            onBatch: (partialSectors) => {
              (this.panels['heatmap'] as HeatmapPanel).renderHeatmap(
                partialSectors.map((s) => ({ name: s.name, change: s.change }))
              );
            },
          }
        );
        (this.panels['heatmap'] as HeatmapPanel).renderHeatmap(
          sectorsResult.data.map((s) => ({ name: s.name, change: s.change }))
        );
      }

      const commoditiesResult = await fetchMultipleStocks(COMMODITIES, {
        onBatch: (partialCommodities) => {
          (this.panels['commodities'] as CommoditiesPanel).renderCommodities(
            partialCommodities.map((c) => ({
              display: c.display,
              price: c.price,
              change: c.change,
              sparkline: c.sparkline,
            }))
          );
        },
      });
      (this.panels['commodities'] as CommoditiesPanel).renderCommodities(
        commoditiesResult.data.map((c) => ({ display: c.display, price: c.price, change: c.change, sparkline: c.sparkline }))
      );
    } catch {
      this.statusPanel?.updateApi('Finnhub', { status: 'error' });
    }

    try {
      // Crypto
      const crypto = await fetchCrypto();
      (this.panels['crypto'] as CryptoPanel).renderCrypto(crypto);
      this.statusPanel?.updateApi('CoinGecko', { status: 'ok' });
    } catch {
      this.statusPanel?.updateApi('CoinGecko', { status: 'error' });
    }
  }

  private async loadPredictions(): Promise<void> {
    try {
      const predictions = await fetchPredictions();
      this.latestPredictions = predictions;
      (this.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);

      this.statusPanel?.updateFeed('Polymarket', { status: 'ok', itemCount: predictions.length });
      this.statusPanel?.updateApi('Polymarket', { status: 'ok' });
      dataFreshness.recordUpdate('polymarket', predictions.length);

      // Run correlation analysis in background (fire-and-forget via Web Worker)
      void this.runCorrelationAnalysis();
    } catch (error) {
      this.statusPanel?.updateFeed('Polymarket', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('Polymarket', { status: 'error' });
      dataFreshness.recordError('polymarket', String(error));
    }
  }

  private async loadNatural(): Promise<void> {
    // Load both USGS earthquakes and NASA EONET natural events in parallel
    const [earthquakeResult, eonetResult] = await Promise.allSettled([
      fetchEarthquakes(),
      fetchNaturalEvents(30),
    ]);

    // Handle earthquakes (USGS)
    if (earthquakeResult.status === 'fulfilled') {
      this.intelligenceCache.earthquakes = earthquakeResult.value;
      this.map?.setEarthquakes(earthquakeResult.value);
      ingestEarthquakes(earthquakeResult.value);
      this.statusPanel?.updateApi('USGS', { status: 'ok' });
      dataFreshness.recordUpdate('usgs', earthquakeResult.value.length);
    } else {
      this.intelligenceCache.earthquakes = [];
      this.map?.setEarthquakes([]);
      this.statusPanel?.updateApi('USGS', { status: 'error' });
      dataFreshness.recordError('usgs', String(earthquakeResult.reason));
    }

    // Handle natural events (EONET - storms, fires, volcanoes, etc.)
    if (eonetResult.status === 'fulfilled') {
      this.map?.setNaturalEvents(eonetResult.value);
      this.statusPanel?.updateFeed('EONET', {
        status: 'ok',
        itemCount: eonetResult.value.length,
      });
      this.statusPanel?.updateApi('NASA EONET', { status: 'ok' });
    } else {
      this.map?.setNaturalEvents([]);
      this.statusPanel?.updateFeed('EONET', { status: 'error', errorMessage: String(eonetResult.reason) });
      this.statusPanel?.updateApi('NASA EONET', { status: 'error' });
    }

    // Set layer ready based on combined data
    const hasEarthquakes = earthquakeResult.status === 'fulfilled' && earthquakeResult.value.length > 0;
    const hasEonet = eonetResult.status === 'fulfilled' && eonetResult.value.length > 0;
    this.map?.setLayerReady('natural', hasEarthquakes || hasEonet);
  }

  private async loadTechEvents(): Promise<void> {
    console.log('[loadTechEvents] Called. SITE_VARIANT:', SITE_VARIANT, 'techEvents layer:', this.mapLayers.techEvents);
    // Only load for tech variant or if techEvents layer is enabled
    if (SITE_VARIANT !== 'tech' && !this.mapLayers.techEvents) {
      console.log('[loadTechEvents] Skipping - not tech variant and layer disabled');
      return;
    }

    try {
      const res = await fetch('/api/tech-events?type=conference&mappable=true&days=90&limit=50');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Unknown error');

      // Transform events for map markers
      const now = new Date();
      const mapEvents = data.events.map((e: {
        id: string;
        title: string;
        location: string;
        coords: { lat: number; lng: number; country: string };
        startDate: string;
        endDate: string;
        url: string | null;
      }) => ({
        id: e.id,
        title: e.title,
        location: e.location,
        lat: e.coords.lat,
        lng: e.coords.lng,
        country: e.coords.country,
        startDate: e.startDate,
        endDate: e.endDate,
        url: e.url,
        daysUntil: Math.ceil((new Date(e.startDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      }));

      this.map?.setTechEvents(mapEvents);
      this.map?.setLayerReady('techEvents', mapEvents.length > 0);
      this.statusPanel?.updateFeed('Tech Events', { status: 'ok', itemCount: mapEvents.length });

      // Register tech events as searchable source
      if (SITE_VARIANT === 'tech' && this.searchModal) {
        this.searchModal.registerSource('techevent', mapEvents.map((e: { id: string; title: string; location: string; startDate: string }) => ({
          id: e.id,
          title: e.title,
          subtitle: `${e.location} • ${new Date(e.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          data: e,
        })));
      }
    } catch (error) {
      console.error('[App] Failed to load tech events:', error);
      this.map?.setTechEvents([]);
      this.map?.setLayerReady('techEvents', false);
      this.statusPanel?.updateFeed('Tech Events', { status: 'error', errorMessage: String(error) });
    }
  }

  private async loadWeatherAlerts(): Promise<void> {
    try {
      const alerts = await fetchWeatherAlerts();
      this.map?.setWeatherAlerts(alerts);
      this.map?.setLayerReady('weather', alerts.length > 0);
      this.statusPanel?.updateFeed('Weather', { status: 'ok', itemCount: alerts.length });
      dataFreshness.recordUpdate('weather', alerts.length);
    } catch (error) {
      this.map?.setLayerReady('weather', false);
      this.statusPanel?.updateFeed('Weather', { status: 'error' });
      dataFreshness.recordError('weather', String(error));
    }
  }

  // Cache for intelligence data - allows CII to work even when layers are disabled
  private intelligenceCache: {
    outages?: InternetOutage[];
    protests?: { events: SocialUnrestEvent[]; sources: { acled: number; gdelt: number } };
    military?: { flights: MilitaryFlight[]; flightClusters: MilitaryFlightCluster[]; vessels: MilitaryVessel[]; vesselClusters: MilitaryVesselCluster[] };
    earthquakes?: import('@/types').Earthquake[];
  } = {};
  private cyberThreatsCache: CyberThreat[] | null = null;

  /**
   * Load intelligence-critical signals for CII/focal point calculation
   * This runs ALWAYS, regardless of layer visibility
   * Map rendering is separate and still gated by layer visibility
   */
  private async loadIntelligenceSignals(): Promise<void> {
    const tasks: Promise<void>[] = [];

    // Always fetch outages for CII (internet blackouts = major instability signal)
    tasks.push((async () => {
      try {
        const outages = await fetchInternetOutages();
        this.intelligenceCache.outages = outages;
        ingestOutagesForCII(outages);
        signalAggregator.ingestOutages(outages);
        dataFreshness.recordUpdate('outages', outages.length);
        // Update map only if layer is visible
        if (this.mapLayers.outages) {
          this.map?.setOutages(outages);
          this.map?.setLayerReady('outages', outages.length > 0);
          this.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
        }
      } catch (error) {
        console.error('[Intelligence] Outages fetch failed:', error);
        dataFreshness.recordError('outages', String(error));
      }
    })());

    // Always fetch protests for CII (unrest = core instability metric)
    // This task is also used by UCDP deduplication, so keep it as a shared promise.
    const protestsTask = (async (): Promise<SocialUnrestEvent[]> => {
      try {
        const protestData = await fetchProtestEvents();
        this.intelligenceCache.protests = protestData;
        ingestProtests(protestData.events);
        ingestProtestsForCII(protestData.events);
        signalAggregator.ingestProtests(protestData.events);
        const protestCount = protestData.sources.acled + protestData.sources.gdelt;
        if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
        if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
        // Update map only if layer is visible
        if (this.mapLayers.protests) {
          this.map?.setProtests(protestData.events);
          this.map?.setLayerReady('protests', protestData.events.length > 0);
          const status = getProtestStatus();
          this.statusPanel?.updateFeed('Protests', {
            status: 'ok',
            itemCount: protestData.events.length,
            errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
          });
        }
        return protestData.events;
      } catch (error) {
        console.error('[Intelligence] Protests fetch failed:', error);
        dataFreshness.recordError('acled', String(error));
        return [];
      }
    })();
    tasks.push(protestsTask.then(() => undefined));

    // Fetch armed conflict events (battles, explosions, violence) for CII
    tasks.push((async () => {
      try {
        const conflictData = await fetchConflictEvents();
        ingestConflictsForCII(conflictData.events);
        if (conflictData.count > 0) dataFreshness.recordUpdate('acled_conflict', conflictData.count);
      } catch (error) {
        console.error('[Intelligence] Conflict events fetch failed:', error);
        dataFreshness.recordError('acled_conflict', String(error));
      }
    })());

    // Fetch UCDP conflict classifications (war vs minor vs none)
    tasks.push((async () => {
      try {
        const classifications = await fetchUcdpClassifications();
        ingestUcdpForCII(classifications);
        if (classifications.size > 0) dataFreshness.recordUpdate('ucdp', classifications.size);
      } catch (error) {
        console.error('[Intelligence] UCDP fetch failed:', error);
        dataFreshness.recordError('ucdp', String(error));
      }
    })());

    // Fetch HDX HAPI aggregated conflict data (fallback/validation)
    tasks.push((async () => {
      try {
        const summaries = await fetchHapiSummary();
        ingestHapiForCII(summaries);
        if (summaries.size > 0) dataFreshness.recordUpdate('hapi', summaries.size);
      } catch (error) {
        console.error('[Intelligence] HAPI fetch failed:', error);
        dataFreshness.recordError('hapi', String(error));
      }
    })());

    // Always fetch military for CII (security = core instability metric)
    tasks.push((async () => {
      try {
        if (isMilitaryVesselTrackingConfigured()) {
          initMilitaryVesselStream();
        }
        const [flightData, vesselData] = await Promise.all([
          fetchMilitaryFlights(),
          fetchMilitaryVessels(),
        ]);
        this.intelligenceCache.military = {
          flights: flightData.flights,
          flightClusters: flightData.clusters,
          vessels: vesselData.vessels,
          vesselClusters: vesselData.clusters,
        };
        ingestFlights(flightData.flights);
        ingestVessels(vesselData.vessels);
        ingestMilitaryForCII(flightData.flights, vesselData.vessels);
        signalAggregator.ingestFlights(flightData.flights);
        signalAggregator.ingestVessels(vesselData.vessels);
        dataFreshness.recordUpdate('opensky', flightData.flights.length);
        // Temporal baseline: report counts and check for anomalies
        updateAndCheck([
          { type: 'military_flights', region: 'global', count: flightData.flights.length },
          { type: 'vessels', region: 'global', count: vesselData.vessels.length },
        ]).then(anomalies => {
          if (anomalies.length > 0) signalAggregator.ingestTemporalAnomalies(anomalies);
        }).catch(() => { });
        // Update map only if layer is visible
        if (this.mapLayers.military) {
          this.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
          this.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
          this.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
          const militaryCount = flightData.flights.length + vesselData.vessels.length;
          this.statusPanel?.updateFeed('Military', {
            status: militaryCount > 0 ? 'ok' : 'warning',
            itemCount: militaryCount,
          });
        }
        // Detect military airlift surges and foreign presence (suppress during learning mode)
        if (!isInLearningMode()) {
          const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
          if (surgeAlerts.length > 0) {
            const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
            addToSignalHistory(surgeSignals);
            this.signalModal?.show(surgeSignals);
          }
          const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
          if (foreignAlerts.length > 0) {
            const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
            addToSignalHistory(foreignSignals);
            this.signalModal?.show(foreignSignals);
          }
        }
      } catch (error) {
        console.error('[Intelligence] Military fetch failed:', error);
        dataFreshness.recordError('opensky', String(error));
      }
    })());

    // Fetch UCDP georeferenced events (battles, one-sided violence, non-state conflict)
    tasks.push((async () => {
      try {
        const [result, protestEvents] = await Promise.all([
          fetchUcdpEvents(),
          protestsTask,
        ]);
        if (!result.success) {
          dataFreshness.recordError('ucdp_events', 'UCDP events unavailable (retaining prior event state)');
          return;
        }
        const acledEvents = protestEvents.map(e => ({
          latitude: e.lat, longitude: e.lon, event_date: e.time.toISOString(), fatalities: e.fatalities ?? 0,
        }));
        const events = deduplicateAgainstAcled(result.data, acledEvents);
        (this.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(events);
        if (this.mapLayers.ucdpEvents) {
          this.map?.setUcdpEvents(events);
        }
        if (events.length > 0) dataFreshness.recordUpdate('ucdp_events', events.length);
      } catch (error) {
        console.error('[Intelligence] UCDP events fetch failed:', error);
        dataFreshness.recordError('ucdp_events', String(error));
      }
    })());

    // Fetch UNHCR displacement data (refugees, asylum seekers, IDPs)
    tasks.push((async () => {
      try {
        const unhcrResult = await fetchUnhcrPopulation();
        if (!unhcrResult.ok) {
          dataFreshness.recordError('unhcr', 'UNHCR displacement unavailable (retaining prior displacement state)');
          return;
        }
        const data = unhcrResult.data;
        (this.panels['displacement'] as DisplacementPanel)?.setData(data);
        ingestDisplacementForCII(data.countries);
        if (this.mapLayers.displacement && data.topFlows) {
          this.map?.setDisplacementFlows(data.topFlows);
        }
        if (data.countries.length > 0) dataFreshness.recordUpdate('unhcr', data.countries.length);
      } catch (error) {
        console.error('[Intelligence] UNHCR displacement fetch failed:', error);
        dataFreshness.recordError('unhcr', String(error));
      }
    })());

    // Fetch climate anomalies (temperature/precipitation deviations)
    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          return;
        }
        const anomalies = climateResult.anomalies;
        (this.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
        ingestClimateForCII(anomalies);
        if (this.mapLayers.climate) {
          this.map?.setClimateAnomalies(anomalies);
        }
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        dataFreshness.recordError('climate', String(error));
      }
    })());

    await Promise.allSettled(tasks);

    // Fetch population exposure estimates after upstream intelligence loads complete.
    // This avoids race conditions where UCDP/protest data is still in-flight.
    try {
      const ucdpEvts = (this.panels['ucdp-events'] as UcdpEventsPanel)?.getEvents?.() || [];
      const events = [
        ...(this.intelligenceCache.protests?.events || []).slice(0, 10).map(e => ({
          id: e.id, lat: e.lat, lon: e.lon, type: 'conflict' as const, name: e.title || 'Protest',
        })),
        ...ucdpEvts.slice(0, 10).map(e => ({
          id: e.id, lat: e.latitude, lon: e.longitude, type: e.type_of_violence as string, name: `${e.side_a} vs ${e.side_b}`,
        })),
      ];
      if (events.length > 0) {
        const exposures = await enrichEventsWithExposure(events);
        (this.panels['population-exposure'] as PopulationExposurePanel)?.setExposures(exposures);
        if (exposures.length > 0) dataFreshness.recordUpdate('worldpop', exposures.length);
      }
    } catch (error) {
      console.error('[Intelligence] Population exposure fetch failed:', error);
      dataFreshness.recordError('worldpop', String(error));
    }

    // Now trigger CII refresh with all intelligence data
    (this.panels['cii'] as CIIPanel)?.refresh();
    console.log('[Intelligence] All signals loaded for CII calculation');
  }

  private async loadOutages(): Promise<void> {
    // Use cached data if available
    if (this.intelligenceCache.outages) {
      const outages = this.intelligenceCache.outages;
      this.map?.setOutages(outages);
      this.map?.setLayerReady('outages', outages.length > 0);
      this.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      return;
    }
    try {
      const outages = await fetchInternetOutages();
      this.intelligenceCache.outages = outages;
      this.map?.setOutages(outages);
      this.map?.setLayerReady('outages', outages.length > 0);
      ingestOutagesForCII(outages);
      signalAggregator.ingestOutages(outages);
      this.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      dataFreshness.recordUpdate('outages', outages.length);
    } catch (error) {
      this.map?.setLayerReady('outages', false);
      this.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
      dataFreshness.recordError('outages', String(error));
    }
  }

  private async loadCyberThreats(): Promise<void> {
    if (!CYBER_LAYER_ENABLED) {
      this.mapLayers.cyberThreats = false;
      this.map?.setLayerReady('cyberThreats', false);
      return;
    }

    if (this.cyberThreatsCache) {
      this.map?.setCyberThreats(this.cyberThreatsCache);
      this.map?.setLayerReady('cyberThreats', this.cyberThreatsCache.length > 0);
      this.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: this.cyberThreatsCache.length });
      return;
    }

    try {
      const threats = await fetchCyberThreats({ limit: 500, days: 14 });
      this.cyberThreatsCache = threats;
      this.map?.setCyberThreats(threats);
      this.map?.setLayerReady('cyberThreats', threats.length > 0);
      this.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: threats.length });
      dataFreshness.recordUpdate('cyber_threats', threats.length);
    } catch (error) {
      this.map?.setLayerReady('cyberThreats', false);
      this.statusPanel?.updateFeed('Cyber Threats', { status: 'error', errorMessage: String(error) });
      dataFreshness.recordError('cyber_threats', String(error));
    }
  }

  private async loadAisSignals(): Promise<void> {
    try {
      const { disruptions, density } = await fetchAisSignals();
      const aisStatus = getAisStatus();
      console.log('[Ships] Events:', { disruptions: disruptions.length, density: density.length, vessels: aisStatus.vessels });
      this.map?.setAisData(disruptions, density);
      signalAggregator.ingestAisDisruptions(disruptions);
      // Temporal baseline: report AIS gap counts
      updateAndCheck([
        { type: 'ais_gaps', region: 'global', count: disruptions.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) signalAggregator.ingestTemporalAnomalies(anomalies);
      }).catch(() => { });

      const hasData = disruptions.length > 0 || density.length > 0;
      this.map?.setLayerReady('ais', hasData);

      const shippingCount = disruptions.length + density.length;
      const shippingStatus = shippingCount > 0 ? 'ok' : (aisStatus.connected ? 'warning' : 'error');
      this.statusPanel?.updateFeed('Shipping', {
        status: shippingStatus,
        itemCount: shippingCount,
        errorMessage: !aisStatus.connected && shippingCount === 0 ? 'AIS snapshot unavailable' : undefined,
      });
      this.statusPanel?.updateApi('AISStream', {
        status: aisStatus.connected ? 'ok' : 'warning',
      });
      if (hasData) {
        dataFreshness.recordUpdate('ais', shippingCount);
      }
    } catch (error) {
      this.map?.setLayerReady('ais', false);
      this.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('AISStream', { status: 'error' });
      dataFreshness.recordError('ais', String(error));
    }
  }

  private waitForAisData(): void {
    const maxAttempts = 30;
    let attempts = 0;

    const checkData = () => {
      attempts++;
      const status = getAisStatus();

      if (status.vessels > 0 || status.connected) {
        this.loadAisSignals();
        this.map?.setLayerLoading('ais', false);
        return;
      }

      if (attempts >= maxAttempts) {
        this.map?.setLayerLoading('ais', false);
        this.map?.setLayerReady('ais', false);
        this.statusPanel?.updateFeed('Shipping', {
          status: 'error',
          errorMessage: 'Connection timeout'
        });
        return;
      }

      setTimeout(checkData, 1000);
    };

    checkData();
  }

  private async loadCableActivity(): Promise<void> {
    try {
      const activity = await fetchCableActivity();
      this.map?.setCableActivity(activity.advisories, activity.repairShips);
      const itemCount = activity.advisories.length + activity.repairShips.length;
      this.statusPanel?.updateFeed('CableOps', { status: 'ok', itemCount });
    } catch {
      this.statusPanel?.updateFeed('CableOps', { status: 'error' });
    }
  }

  private async loadProtests(): Promise<void> {
    // Use cached data if available (from loadIntelligenceSignals)
    if (this.intelligenceCache.protests) {
      const protestData = this.intelligenceCache.protests;
      this.map?.setProtests(protestData.events);
      this.map?.setLayerReady('protests', protestData.events.length > 0);
      const status = getProtestStatus();
      this.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.statusPanel?.updateApi('GDELT', { status: 'ok' });
      return;
    }
    try {
      const protestData = await fetchProtestEvents();
      this.intelligenceCache.protests = protestData;
      this.map?.setProtests(protestData.events);
      this.map?.setLayerReady('protests', protestData.events.length > 0);
      ingestProtests(protestData.events);
      ingestProtestsForCII(protestData.events);
      signalAggregator.ingestProtests(protestData.events);
      const protestCount = protestData.sources.acled + protestData.sources.gdelt;
      if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
      (this.panels['cii'] as CIIPanel)?.refresh();
      const status = getProtestStatus();
      this.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.statusPanel?.updateApi('GDELT', { status: 'ok' });
    } catch (error) {
      this.map?.setLayerReady('protests', false);
      this.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('ACLED', { status: 'error' });
      this.statusPanel?.updateApi('GDELT', { status: 'error' });
    }
  }

  private async loadFlightDelays(): Promise<void> {
    try {
      const delays = await fetchFlightDelays();
      this.map?.setFlightDelays(delays);
      this.map?.setLayerReady('flights', delays.length > 0);
      this.statusPanel?.updateFeed('Flights', {
        status: 'ok',
        itemCount: delays.length,
      });
      this.statusPanel?.updateApi('FAA', { status: 'ok' });
    } catch (error) {
      this.map?.setLayerReady('flights', false);
      this.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('FAA', { status: 'error' });
    }
  }

  private async loadMilitary(): Promise<void> {
    // Use cached data if available (from loadIntelligenceSignals)
    if (this.intelligenceCache.military) {
      const { flights, flightClusters, vessels, vesselClusters } = this.intelligenceCache.military;
      this.map?.setMilitaryFlights(flights, flightClusters);
      this.map?.setMilitaryVessels(vessels, vesselClusters);
      this.map?.updateMilitaryForEscalation(flights, vessels);
      // Fetch cached postures for banner (posture panel fetches its own data)
      this.loadCachedPosturesForBanner();
      const insightsPanel = this.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.setMilitaryFlights(flights);
      const hasData = flights.length > 0 || vessels.length > 0;
      this.map?.setLayerReady('military', hasData);
      const militaryCount = flights.length + vessels.length;
      this.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      return;
    }
    try {
      if (isMilitaryVesselTrackingConfigured()) {
        initMilitaryVesselStream();
      }
      const [flightData, vesselData] = await Promise.all([
        fetchMilitaryFlights(),
        fetchMilitaryVessels(),
      ]);
      this.intelligenceCache.military = {
        flights: flightData.flights,
        flightClusters: flightData.clusters,
        vessels: vesselData.vessels,
        vesselClusters: vesselData.clusters,
      };
      this.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
      this.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
      ingestFlights(flightData.flights);
      ingestVessels(vesselData.vessels);
      ingestMilitaryForCII(flightData.flights, vesselData.vessels);
      signalAggregator.ingestFlights(flightData.flights);
      signalAggregator.ingestVessels(vesselData.vessels);
      // Temporal baseline: report counts from standalone military load
      updateAndCheck([
        { type: 'military_flights', region: 'global', count: flightData.flights.length },
        { type: 'vessels', region: 'global', count: vesselData.vessels.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) signalAggregator.ingestTemporalAnomalies(anomalies);
      }).catch(() => { });
      this.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
      (this.panels['cii'] as CIIPanel)?.refresh();
      if (!isInLearningMode()) {
        const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
        if (surgeAlerts.length > 0) {
          const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
          addToSignalHistory(surgeSignals);
          this.signalModal?.show(surgeSignals);
        }
        const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
        if (foreignAlerts.length > 0) {
          const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
          addToSignalHistory(foreignSignals);
          this.signalModal?.show(foreignSignals);
        }
      }

      // Fetch cached postures for banner (posture panel fetches its own data)
      this.loadCachedPosturesForBanner();
      const insightsPanel = this.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.setMilitaryFlights(flightData.flights);

      const hasData = flightData.flights.length > 0 || vesselData.vessels.length > 0;
      this.map?.setLayerReady('military', hasData);
      const militaryCount = flightData.flights.length + vesselData.vessels.length;
      this.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      dataFreshness.recordUpdate('opensky', flightData.flights.length);
    } catch (error) {
      this.map?.setLayerReady('military', false);
      this.statusPanel?.updateFeed('Military', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('OpenSky', { status: 'error' });
      dataFreshness.recordError('opensky', String(error));
    }
  }

  /**
   * Load cached theater postures for banner display
   * Uses server-side cached data to avoid redundant calculation per user
   */
  private async loadCachedPosturesForBanner(): Promise<void> {
    try {
      const data = await fetchCachedTheaterPosture();
      if (data && data.postures.length > 0) {
        this.renderCriticalBanner(data.postures);
        // Also update posture panel with shared data (saves a duplicate fetch)
        const posturePanel = this.panels['strategic-posture'] as StrategicPosturePanel | undefined;
        posturePanel?.updatePostures(data);
      }
    } catch (error) {
      console.warn('[App] Failed to load cached postures for banner:', error);
    }
  }


  private async loadFredData(): Promise<void> {
    const economicPanel = this.panels['economic'] as EconomicPanel;
    const cbInfo = getCircuitBreakerCooldownInfo('FRED Economic');
    if (cbInfo.onCooldown) {
      economicPanel?.setErrorState(true, `Temporarily unavailable (retry in ${cbInfo.remainingSeconds}s)`);
      this.statusPanel?.updateApi('FRED', { status: 'error' });
      return;
    }

    try {
      economicPanel?.setLoading(true);
      const data = await fetchFredData();

      // Check if circuit breaker tripped after fetch
      const postInfo = getCircuitBreakerCooldownInfo('FRED Economic');
      if (postInfo.onCooldown) {
        economicPanel?.setErrorState(true, `Temporarily unavailable (retry in ${postInfo.remainingSeconds}s)`);
        this.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      if (data.length === 0) {
        const reason = isFeatureAvailable('economicFred')
          ? 'FRED data temporarily unavailable — will retry'
          : 'FRED_API_KEY not configured — add in Settings';
        economicPanel?.setErrorState(true, reason);
        this.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      economicPanel?.setErrorState(false);
      economicPanel?.update(data);
      this.statusPanel?.updateApi('FRED', { status: 'ok' });
      dataFreshness.recordUpdate('economic', data.length);
    } catch {
      this.statusPanel?.updateApi('FRED', { status: 'error' });
      economicPanel?.setErrorState(true, 'FRED data temporarily unavailable — will retry');
      economicPanel?.setLoading(false);
    }
  }

  private async loadOilAnalytics(): Promise<void> {
    const economicPanel = this.panels['economic'] as EconomicPanel;
    try {
      const data = await fetchOilAnalytics();
      economicPanel?.updateOil(data);
    } catch (e) {
      console.error('[App] Oil analytics failed:', e);
    }
  }

  private async loadGovernmentSpending(): Promise<void> {
    const economicPanel = this.panels['economic'] as EconomicPanel;
    try {
      const data = await fetchRecentAwards({ daysBack: 7, limit: 15 });
      economicPanel?.updateSpending(data);
    } catch (e) {
      console.error('[App] Government spending failed:', e);
    }
  }

  private updateMonitorResults(): void {
    const monitorPanel = this.panels['monitors'] as MonitorPanel;
    monitorPanel.renderResults(this.allNews);
  }

  private async runCorrelationAnalysis(): Promise<void> {
    try {
      // Ensure we have clusters (hybrid: semantic + Jaccard when ML available)
      if (this.latestClusters.length === 0 && this.allNews.length > 0) {
        this.latestClusters = mlWorker.isAvailable
          ? await clusterNewsHybrid(this.allNews)
          : await analysisWorker.clusterNews(this.allNews);
      }

      // Ingest news clusters for CII
      if (this.latestClusters.length > 0) {
        ingestNewsForCII(this.latestClusters);
        dataFreshness.recordUpdate('gdelt', this.latestClusters.length);
        (this.panels['cii'] as CIIPanel)?.refresh();
      }

      // Run correlation analysis off main thread via Web Worker
      const signals = await analysisWorker.analyzeCorrelations(
        this.latestClusters,
        this.latestPredictions,
        this.latestMarkets
      );

      // Detect geographic convergence (suppress during learning mode)
      let geoSignals: ReturnType<typeof geoConvergenceToSignal>[] = [];
      if (!isInLearningMode()) {
        const geoAlerts = detectGeoConvergence(this.seenGeoAlerts);
        geoSignals = geoAlerts.map(geoConvergenceToSignal);
      }

      const keywordSpikeSignals = drainTrendingSignals();
      const allSignals = [...signals, ...geoSignals, ...keywordSpikeSignals];
      if (allSignals.length > 0) {
        addToSignalHistory(allSignals);
        this.signalModal?.show(allSignals);
      }
    } catch (error) {
      console.error('[App] Correlation analysis failed:', error);
    }
  }

  private async loadFirmsData(): Promise<void> {
    try {
      const fireResult = await fetchAllFires(1);
      if (fireResult.skipped) {
        this.panels['satellite-fires']?.showConfigError('NASA_FIRMS_API_KEY not configured — add in Settings');
        this.statusPanel?.updateApi('FIRMS', { status: 'error' });
        return;
      }
      const { regions, totalCount } = fireResult;
      if (totalCount > 0) {
        const flat = flattenFires(regions);
        const stats = computeRegionStats(regions);

        // Feed signal aggregator
        signalAggregator.ingestSatelliteFires(flat.map(f => ({
          lat: f.lat,
          lon: f.lon,
          brightness: f.brightness,
          frp: f.frp,
          region: f.region,
          acq_date: f.acq_date,
        })));

        // Feed map layer
        this.map?.setFires(flat);

        // Feed panel
        (this.panels['satellite-fires'] as SatelliteFiresPanel)?.update(stats, totalCount);

        dataFreshness.recordUpdate('firms', totalCount);

        // Report to temporal baseline (fire-and-forget)
        updateAndCheck([
          { type: 'satellite_fires', region: 'global', count: totalCount },
        ]).then(anomalies => {
          if (anomalies.length > 0) {
            signalAggregator.ingestTemporalAnomalies(anomalies);
          }
        }).catch(() => { });
      } else {
        // Still update panel so it exits loading spinner
        (this.panels['satellite-fires'] as SatelliteFiresPanel)?.update([], 0);
      }
      this.statusPanel?.updateApi('FIRMS', { status: 'ok' });
    } catch (e) {
      console.warn('[App] FIRMS load failed:', e);
      (this.panels['satellite-fires'] as SatelliteFiresPanel)?.update([], 0);
      this.statusPanel?.updateApi('FIRMS', { status: 'error' });
      dataFreshness.recordError('firms', String(e));
    }
  }

  private scheduleRefresh(
    name: string,
    fn: () => Promise<void>,
    intervalMs: number,
    condition?: () => boolean
  ): void {
    const HIDDEN_REFRESH_MULTIPLIER = 4;
    const JITTER_FRACTION = 0.1;
    const MIN_REFRESH_MS = 1000;
    const computeDelay = (baseMs: number, isHidden: boolean) => {
      const adjusted = baseMs * (isHidden ? HIDDEN_REFRESH_MULTIPLIER : 1);
      const jitterRange = adjusted * JITTER_FRACTION;
      const jittered = adjusted + (Math.random() * 2 - 1) * jitterRange;
      return Math.max(MIN_REFRESH_MS, Math.round(jittered));
    };
    const scheduleNext = (delay: number) => {
      if (this.isDestroyed) return;
      const timeoutId = setTimeout(run, delay);
      this.refreshTimeoutIds.set(name, timeoutId);
    };
    const run = async () => {
      if (this.isDestroyed) return;
      const isHidden = document.visibilityState === 'hidden';
      if (isHidden) {
        scheduleNext(computeDelay(intervalMs, true));
        return;
      }
      if (condition && !condition()) {
        scheduleNext(computeDelay(intervalMs, false));
        return;
      }
      if (this.inFlight.has(name)) {
        scheduleNext(computeDelay(intervalMs, false));
        return;
      }
      this.inFlight.add(name);
      try {
        await fn();
      } catch (e) {
        console.error(`[App] Refresh ${name} failed:`, e);
      } finally {
        this.inFlight.delete(name);
        scheduleNext(computeDelay(intervalMs, false));
      }
    };
    scheduleNext(computeDelay(intervalMs, document.visibilityState === 'hidden'));
  }

  private setupRefreshIntervals(): void {
    // Always refresh news, markets, predictions, pizzint
    this.scheduleRefresh('news', () => this.loadNews(), REFRESH_INTERVALS.feeds);
    this.scheduleRefresh('markets', () => this.loadMarkets(), REFRESH_INTERVALS.markets);
    this.scheduleRefresh('predictions', () => this.loadPredictions(), REFRESH_INTERVALS.predictions);
    this.scheduleRefresh('pizzint', () => this.loadPizzInt(), 10 * 60 * 1000);

    // Only refresh layer data if layer is enabled
    this.scheduleRefresh('natural', () => this.loadNatural(), 5 * 60 * 1000, () => this.mapLayers.natural);
    this.scheduleRefresh('weather', () => this.loadWeatherAlerts(), 10 * 60 * 1000, () => this.mapLayers.weather);
    this.scheduleRefresh('fred', () => this.loadFredData(), 30 * 60 * 1000);
    this.scheduleRefresh('oil', () => this.loadOilAnalytics(), 30 * 60 * 1000);
    this.scheduleRefresh('spending', () => this.loadGovernmentSpending(), 60 * 60 * 1000);

    // Refresh intelligence signals for CII (geopolitical variant only)
    // This handles outages, protests, military - updates map when layers enabled
    if (SITE_VARIANT === 'full') {
      this.scheduleRefresh('intelligence', () => {
        this.intelligenceCache = {}; // Clear cache to force fresh fetch
        return this.loadIntelligenceSignals();
      }, 5 * 60 * 1000);
    }

    // Non-intelligence layer refreshes only
    // NOTE: outages, protests, military are refreshed by intelligence schedule above
    this.scheduleRefresh('firms', () => this.loadFirmsData(), 30 * 60 * 1000);
    this.scheduleRefresh('ais', () => this.loadAisSignals(), REFRESH_INTERVALS.ais, () => this.mapLayers.ais);
    this.scheduleRefresh('cables', () => this.loadCableActivity(), 30 * 60 * 1000, () => this.mapLayers.cables);
    this.scheduleRefresh('flights', () => this.loadFlightDelays(), 10 * 60 * 1000, () => this.mapLayers.flights);
    this.scheduleRefresh('cyberThreats', () => {
      this.cyberThreatsCache = null;
      return this.loadCyberThreats();
    }, 10 * 60 * 1000, () => CYBER_LAYER_ENABLED && this.mapLayers.cyberThreats);
  }
}
