import type { NewsItem, Monitor, PanelConfig, MapLayers, RelatedAsset } from '@/types';
import {
  FEEDS,
  INTEL_SOURCES,
  SECTORS,
  COMMODITIES,
  MARKET_SYMBOLS,
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
} from '@/config';
import { fetchCategoryFeeds, fetchMultipleStocks, fetchCrypto, fetchPredictions, fetchEarthquakes, fetchWeatherAlerts, fetchFredData, fetchInternetOutages, isOutagesConfigured, fetchAisSignals, initAisStream, getAisStatus, disconnectAisStream, isAisConfigured, fetchCableActivity, fetchProtestEvents, getProtestStatus, fetchFlightDelays, initDB, updateBaseline, calculateDeviation, addToSignalHistory, saveSnapshot, cleanOldSnapshots, analysisWorker } from '@/services';
import { buildMapUrl, debounce, loadFromStorage, parseMapUrlState, saveToStorage, ExportPanel, getCircuitBreakerCooldownInfo } from '@/utils';
import type { ParsedMapUrlState } from '@/utils';
import {
  MapComponent,
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
} from '@/components';
import type { SearchResult } from '@/components/SearchModal';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, MILITARY_BASES, UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import type { PredictionMarket, MarketData, ClusteredEvent } from '@/types';

export class App {
  private container: HTMLElement;
  private map: MapComponent | null = null;
  private panels: Record<string, Panel> = {};
  private newsPanels: Record<string, NewsPanel> = {};
  private allNews: NewsItem[] = [];
  private monitors: Monitor[];
  private panelSettings: Record<string, PanelConfig>;
  private mapLayers: MapLayers;
  private signalModal: SignalModal | null = null;
  private playbackControl: PlaybackControl | null = null;
  private statusPanel: StatusPanel | null = null;
  private exportPanel: ExportPanel | null = null;
  private economicPanel: EconomicPanel | null = null;
  private searchModal: SearchModal | null = null;
  private mobileWarningModal: MobileWarningModal | null = null;
  private latestPredictions: PredictionMarket[] = [];
  private latestMarkets: MarketData[] = [];
  private latestClusters: ClusteredEvent[] = [];
  private isPlaybackMode = false;
  private initialUrlState: ParsedMapUrlState | null = null;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);
    this.container = el;

    this.monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);
    this.panelSettings = loadFromStorage<Record<string, PanelConfig>>(
      STORAGE_KEYS.panels,
      DEFAULT_PANELS
    );
    this.mapLayers = loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, DEFAULT_MAP_LAYERS);
    this.initialUrlState = parseMapUrlState(window.location.search, this.mapLayers);
    if (this.initialUrlState.layers) {
      this.mapLayers = this.initialUrlState.layers;
    }
  }

  public async init(): Promise<void> {
    await initDB();

    // Check AIS configuration before init
    if (!isAisConfigured()) {
      this.mapLayers.ais = false;
    } else if (this.mapLayers.ais) {
      initAisStream();
    }

    this.renderLayout();
    this.signalModal = new SignalModal();
    this.setupMobileWarning();
    this.setupPlaybackControl();
    this.setupStatusPanel();
    this.setupExportPanel();
    this.setupEconomicPanel();
    this.setupSearchModal();
    this.setupEventListeners();
    this.setupUrlStateSync();
    await this.loadAllData();

    // Hide unconfigured layers after first data load
    if (!isAisConfigured()) {
      this.map?.hideLayerToggle('ais');
    }
    if (isOutagesConfigured() === false) {
      this.map?.hideLayerToggle('outages');
    }

    this.setupRefreshIntervals();
    this.setupSnapshotSaving();
    cleanOldSnapshots();
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

  private setupEconomicPanel(): void {
    const economicContainer = document.createElement('div');
    economicContainer.className = 'economic-panel-container';
    economicContainer.id = 'economicPanel';
    this.economicPanel = new EconomicPanel(economicContainer);

    // Apply initial visibility from layer settings
    if (!this.mapLayers.economic) {
      economicContainer.classList.add('hidden');
    }

    const main = this.container.querySelector('.main-content');
    if (main) {
      main.appendChild(economicContainer);
    }

    // Listen for layer toggle changes
    this.map?.setOnLayerChange((layer, enabled) => {
      if (layer === 'economic') {
        economicContainer.classList.toggle('hidden', !enabled);
      }
      // Save layer settings
      this.mapLayers[layer] = enabled;
      saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);

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

  private setupSearchModal(): void {
    this.searchModal = new SearchModal(this.container);

    // Register static sources (hotspots, conflicts, bases)
    // Include keywords in subtitle for better searchability
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

    // Register pipelines
    this.searchModal.registerSource('pipeline', PIPELINES.map(p => ({
      id: p.id,
      title: p.name,
      subtitle: `${p.type} ${p.operator || ''} ${p.countries?.join(' ') || ''}`.trim(),
      data: p,
    })));

    // Register undersea cables
    this.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
      id: c.id,
      title: c.name,
      subtitle: c.major ? 'Major cable' : '',
      data: c,
    })));

    // Register AI datacenters
    this.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
      id: d.id,
      title: d.name,
      subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
      data: d,
    })));

    // Register nuclear facilities
    this.searchModal.registerSource('nuclear', NUCLEAR_FACILITIES.map(n => ({
      id: n.id,
      title: n.name,
      subtitle: `${n.type} ${n.operator || ''}`.trim(),
      data: n,
    })));

    // Register gamma irradiators
    this.searchModal.registerSource('irradiator', GAMMA_IRRADIATORS.map(g => ({
      id: g.id,
      title: `${g.city}, ${g.country}`,
      subtitle: g.organization || '',
      data: g,
    })));

    // Handle result selection
    this.searchModal.setOnSelect((result) => this.handleSearchResult(result));

    // Global keyboard shortcut
    document.addEventListener('keydown', (e) => {
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
    });
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

    // Update news sources (use link as unique id)
    this.searchModal.registerSource('news', this.allNews.slice(0, 200).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    })));

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
      if (this.isPlaybackMode) return;

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
    setInterval(saveCurrentSnapshot, 15 * 60 * 1000);
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
    this.container.innerHTML = `
      <div class="header">
        <div class="header-left">
          <span class="logo">WORLD MONITOR</span>
          <span class="credit">by Elie Habib</span>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener" class="github-link" title="View on GitHub">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>LIVE</span>
          </div>
        </div>
        <div class="header-center">
          <button class="view-btn active" data-view="global">GLOBAL</button>
          <button class="view-btn" data-view="us">US</button>
          <button class="view-btn" data-view="mena">MENA</button>
        </div>
        <div class="header-right">
          <button class="search-btn" id="searchBtn"><kbd>⌘K</kbd> Search</button>
          <button class="copy-link-btn" id="copyLinkBtn">Copy Link</button>
          <span class="time-display" id="timeDisplay">--:--:-- UTC</span>
          <button class="settings-btn" id="settingsBtn">⚙ PANELS</button>
        </div>
      </div>
      <div class="main-content">
        <div class="map-section" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">Global Situation</span>
            </div>
          </div>
          <div class="map-container" id="mapContainer"></div>
          <div class="map-resize-handle" id="mapResizeHandle"></div>
        </div>
        <div class="panels-grid" id="panelsGrid"></div>
      </div>
      <div class="modal-overlay" id="settingsModal">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Panel Settings</span>
            <button class="modal-close" id="modalClose">×</button>
          </div>
          <div class="panel-toggle-grid" id="panelToggles"></div>
        </div>
      </div>
    `;

    this.createPanels();
    this.renderPanelToggles();
    this.updateTime();
    setInterval(() => this.updateTime(), 1000);
  }

  private createPanels(): void {
    const panelsGrid = document.getElementById('panelsGrid')!;

    // Initialize map in the map section
    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    this.map = new MapComponent(mapContainer, {
      zoom: 1.5,
      pan: { x: 0, y: 0 },
      view: 'global',
      layers: this.mapLayers,
      timeRange: '7d',
    });

    // Create all panels
    const politicsPanel = new NewsPanel('politics', 'World / Geopolitical');
    this.attachRelatedAssetHandlers(politicsPanel);
    this.newsPanels['politics'] = politicsPanel;
    this.panels['politics'] = politicsPanel;

    const techPanel = new NewsPanel('tech', 'Technology / AI');
    this.attachRelatedAssetHandlers(techPanel);
    this.newsPanels['tech'] = techPanel;
    this.panels['tech'] = techPanel;

    const financePanel = new NewsPanel('finance', 'Financial News');
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

    const govPanel = new NewsPanel('gov', 'Government / Policy');
    this.attachRelatedAssetHandlers(govPanel);
    this.newsPanels['gov'] = govPanel;
    this.panels['gov'] = govPanel;

    const intelPanel = new NewsPanel('intel', 'Intel Feed');
    this.attachRelatedAssetHandlers(intelPanel);
    this.newsPanels['intel'] = intelPanel;
    this.panels['intel'] = intelPanel;

    const cryptoPanel = new CryptoPanel();
    this.panels['crypto'] = cryptoPanel;

    const middleeastPanel = new NewsPanel('middleeast', 'Middle East / MENA');
    this.attachRelatedAssetHandlers(middleeastPanel);
    this.newsPanels['middleeast'] = middleeastPanel;
    this.panels['middleeast'] = middleeastPanel;

    const layoffsPanel = new NewsPanel('layoffs', 'Layoffs Tracker');
    this.attachRelatedAssetHandlers(layoffsPanel);
    this.newsPanels['layoffs'] = layoffsPanel;
    this.panels['layoffs'] = layoffsPanel;

    const congressPanel = new NewsPanel('congress', 'Congress Trades');
    this.attachRelatedAssetHandlers(congressPanel);
    this.newsPanels['congress'] = congressPanel;
    this.panels['congress'] = congressPanel;

    const aiPanel = new NewsPanel('ai', 'AI / ML');
    this.attachRelatedAssetHandlers(aiPanel);
    this.newsPanels['ai'] = aiPanel;
    this.panels['ai'] = aiPanel;

    const thinktanksPanel = new NewsPanel('thinktanks', 'Think Tanks');
    this.attachRelatedAssetHandlers(thinktanksPanel);
    this.newsPanels['thinktanks'] = thinktanksPanel;
    this.panels['thinktanks'] = thinktanksPanel;

    // Add panels to grid in saved order
    const defaultOrder = ['politics', 'middleeast', 'tech', 'ai', 'finance', 'layoffs', 'congress', 'heatmap', 'markets', 'commodities', 'crypto', 'polymarket', 'gov', 'thinktanks', 'intel', 'monitors'];
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

    panelOrder.forEach((key: string) => {
      const panel = this.panels[key];
      if (panel) {
        const el = panel.getElement();
        this.makeDraggable(el, key);
        panelsGrid.appendChild(el);
      }
    });

    this.applyPanelSettings();
    this.applyInitialUrlState();
  }

  private applyInitialUrlState(): void {
    if (!this.initialUrlState || !this.map) return;

    const { view, zoom, lat, lon, timeRange, layers } = this.initialUrlState;

    if (view) {
      this.map.setView(view);
      this.setActiveViewButton(view);
    }

    if (timeRange) {
      this.map.setTimeRange(timeRange);
    }

    if (layers) {
      this.mapLayers = layers;
      saveToStorage(STORAGE_KEYS.mapLayers, this.mapLayers);
      this.map.setLayers(layers);
    }

    if (zoom !== undefined) {
      this.map.setZoom(zoom);
    }

    if (lat !== undefined && lon !== undefined) {
      this.map.setCenter(lat, lon);
    }
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem('panel-order');
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
    localStorage.setItem('panel-order', JSON.stringify(order));
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
    // View buttons
    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = (btn as HTMLElement).dataset.view as 'global' | 'us' | 'mena';
        this.setActiveViewButton(view);
        this.map?.setView(view);
      });
    });

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
        (e.target as HTMLElement).classList.remove('active');
      }
    });

    // Window resize
    window.addEventListener('resize', () => {
      this.map?.render();
    });

    // Map section resize handle
    this.setupMapResize();
  }

  private setupUrlStateSync(): void {
    if (!this.map) return;
    const update = debounce(() => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      history.replaceState(null, '', shareUrl);
    }, 250);

    this.map.onStateChanged((state) => {
      update();
      this.setActiveViewButton(state.view);
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

  private setActiveViewButton(view: 'global' | 'us' | 'mena'): void {
    document.querySelectorAll('.view-btn').forEach((btn) => {
      const isActive = (btn as HTMLElement).dataset.view === view;
      btn.classList.toggle('active', isActive);
    });
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
      const newHeight = Math.max(400, Math.min(startHeight + deltaY, window.innerHeight * 0.85));
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

  private renderPanelToggles(): void {
    const container = document.getElementById('panelToggles')!;
    container.innerHTML = Object.entries(this.panelSettings)
      .map(
        ([key, panel]) => `
        <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}" data-panel="${key}">
          <div class="panel-toggle-checkbox">${panel.enabled ? '✓' : ''}</div>
          <span class="panel-toggle-label">${panel.name}</span>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.panel-toggle-item').forEach((item) => {
      item.addEventListener('click', () => {
        const panelKey = (item as HTMLElement).dataset.panel!;
        const config = this.panelSettings[panelKey];
        if (config) {
          config.enabled = !config.enabled;
          saveToStorage(STORAGE_KEYS.panels, this.panelSettings);
          this.renderPanelToggles();
          this.applyPanelSettings();
        }
      });
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

  private updateTime(): void {
    const now = new Date();
    const el = document.getElementById('timeDisplay');
    if (el) {
      el.textContent = now.toUTCString().split(' ')[4] + ' UTC';
    }
  }

  private async loadAllData(): Promise<void> {
    const tasks: Promise<void>[] = [
      this.loadNews(),
      this.loadMarkets(),
      this.loadPredictions(),
    ];

    // Conditionally load based on layer settings
    if (this.mapLayers.earthquakes) tasks.push(this.loadEarthquakes());
    if (this.mapLayers.weather) tasks.push(this.loadWeatherAlerts());
    if (this.mapLayers.economic) tasks.push(this.loadFredData());
    if (this.mapLayers.outages) tasks.push(this.loadOutages());
    if (this.mapLayers.ais) tasks.push(this.loadAisSignals());
    if (this.mapLayers.cables) tasks.push(this.loadCableActivity());
    if (this.mapLayers.protests) tasks.push(this.loadProtests());
    if (this.mapLayers.flights) tasks.push(this.loadFlightDelays());

    await Promise.all(tasks);

    // Update search index after all data loads
    this.updateSearchIndex();
  }

  private async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    this.map?.setLayerLoading(layer, true);
    try {
      switch (layer) {
        case 'earthquakes':
          await this.loadEarthquakes();
          break;
        case 'weather':
          await this.loadWeatherAlerts();
          break;
        case 'economic':
          await this.loadFredData();
          break;
        case 'outages':
          await this.loadOutages();
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
      }
    } finally {
      this.map?.setLayerLoading(layer, false);
    }
  }

  private async loadNewsCategory(category: string, feeds: typeof FEEDS.politics): Promise<NewsItem[]> {
    try {
      const panel = this.newsPanels[category];
      const items = await fetchCategoryFeeds(feeds ?? [], {
        onBatch: (partialItems) => {
          if (panel) {
            panel.renderNews(partialItems);
          }
        },
      });

      if (panel) {
        panel.renderNews(items);

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
      return [];
    }
  }

  private async loadNews(): Promise<void> {
    this.allNews = [];

    const categories = [
      { key: 'politics', feeds: FEEDS.politics },
      { key: 'tech', feeds: FEEDS.tech },
      { key: 'finance', feeds: FEEDS.finance },
      { key: 'gov', feeds: FEEDS.gov },
      { key: 'middleeast', feeds: FEEDS.middleeast },
      { key: 'layoffs', feeds: FEEDS.layoffs },
      { key: 'congress', feeds: FEEDS.congress },
      { key: 'ai', feeds: FEEDS.ai },
      { key: 'thinktanks', feeds: FEEDS.thinktanks },
    ];

    for (const { key, feeds } of categories) {
      const items = await this.loadNewsCategory(key, feeds);
      this.allNews.push(...items);
    }

    // Intel (uses different source)
    const intel = await fetchCategoryFeeds(INTEL_SOURCES);
    const intelPanel = this.newsPanels['intel'];
    if (intelPanel) {
      intelPanel.renderNews(intel);
      const baseline = await updateBaseline('news:intel', intel.length);
      const deviation = calculateDeviation(intel.length, baseline);
      intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
    }
    this.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
    this.allNews.push(...intel);

    // Update map hotspots
    this.map?.updateHotspotActivity(this.allNews);

    // Update monitors
    this.updateMonitorResults();

    // Update clusters for correlation analysis (off main thread via Web Worker)
    try {
      this.latestClusters = await analysisWorker.clusterNews(this.allNews);
    } catch (error) {
      console.error('[App] Worker clustering failed, clusters unchanged:', error);
    }
  }

  private async loadMarkets(): Promise<void> {
    try {
      // Stocks
      const stocks = await fetchMultipleStocks(MARKET_SYMBOLS, {
        onBatch: (partialStocks) => {
          this.latestMarkets = partialStocks;
          (this.panels['markets'] as MarketPanel).renderMarkets(partialStocks);
        },
      });
      this.latestMarkets = stocks;
      (this.panels['markets'] as MarketPanel).renderMarkets(stocks);
      this.statusPanel?.updateApi('Alpha Vantage', { status: 'ok' });

      // Sectors
      const sectors = await fetchMultipleStocks(
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
        sectors.map((s) => ({ name: s.name, change: s.change }))
      );

      // Commodities
      const commodities = await fetchMultipleStocks(COMMODITIES, {
        onBatch: (partialCommodities) => {
          (this.panels['commodities'] as CommoditiesPanel).renderCommodities(
            partialCommodities.map((c) => ({
              display: c.display,
              price: c.price,
              change: c.change,
            }))
          );
        },
      });
      (this.panels['commodities'] as CommoditiesPanel).renderCommodities(
        commodities.map((c) => ({ display: c.display, price: c.price, change: c.change }))
      );
    } catch {
      this.statusPanel?.updateApi('Alpha Vantage', { status: 'error' });
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

      // Run correlation analysis in background (fire-and-forget via Web Worker)
      void this.runCorrelationAnalysis();
    } catch (error) {
      this.statusPanel?.updateFeed('Polymarket', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('Polymarket', { status: 'error' });
    }
  }

  private async loadEarthquakes(): Promise<void> {
    try {
      const earthquakes = await fetchEarthquakes();
      this.map?.setEarthquakes(earthquakes);
      this.statusPanel?.updateApi('USGS', { status: 'ok' });
    } catch {
      this.statusPanel?.updateApi('USGS', { status: 'error' });
    }
  }

  private async loadWeatherAlerts(): Promise<void> {
    try {
      const alerts = await fetchWeatherAlerts();
      this.map?.setWeatherAlerts(alerts);
      this.statusPanel?.updateFeed('Weather', { status: 'ok', itemCount: alerts.length });
    } catch {
      this.statusPanel?.updateFeed('Weather', { status: 'error' });
    }
  }

  private async loadOutages(): Promise<void> {
    try {
      const outages = await fetchInternetOutages();
      this.map?.setOutages(outages);
      this.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
    } catch {
      this.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
    }
  }

  private async loadAisSignals(): Promise<void> {
    try {
      const { disruptions, density } = await fetchAisSignals();
      const aisStatus = getAisStatus();
      console.log('[Ships] Events:', { disruptions: disruptions.length, density: density.length, vessels: aisStatus.vessels });
      this.map?.setAisData(disruptions, density);

      this.statusPanel?.updateFeed('Ships', {
        status: aisStatus.connected ? 'ok' : 'error',
        itemCount: disruptions.length + density.length,
        errorMessage: !aisStatus.connected ? 'WebSocket disconnected' : undefined,
      });
      this.statusPanel?.updateApi('AISStream', {
        status: aisStatus.connected ? 'ok' : 'error',
      });
    } catch (error) {
      this.statusPanel?.updateFeed('Ships', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('AISStream', { status: 'error' });
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
        this.statusPanel?.updateFeed('Ships', {
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
    try {
      const protestData = await fetchProtestEvents();
      this.map?.setProtests(protestData.events);
      const status = getProtestStatus();

      this.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: !status.acledConfigured ? 'ACLED not configured - using GDELT only' : undefined,
      });

      if (status.acledConfigured) {
        this.statusPanel?.updateApi('ACLED', { status: 'ok' });
      }
      this.statusPanel?.updateApi('GDELT', { status: 'ok' });
    } catch (error) {
      this.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('ACLED', { status: 'error' });
      this.statusPanel?.updateApi('GDELT', { status: 'error' });
    }
  }

  private async loadFlightDelays(): Promise<void> {
    try {
      const delays = await fetchFlightDelays();
      this.map?.setFlightDelays(delays);
      this.statusPanel?.updateFeed('Flights', {
        status: 'ok',
        itemCount: delays.length,
      });
      this.statusPanel?.updateApi('FAA', { status: 'ok' });
    } catch (error) {
      this.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('FAA', { status: 'error' });
    }
  }

  private async loadFredData(): Promise<void> {
    const cbInfo = getCircuitBreakerCooldownInfo('FRED Economic');
    if (cbInfo.onCooldown) {
      this.economicPanel?.setErrorState(true, `Temporarily unavailable (retry in ${cbInfo.remainingSeconds}s)`);
      this.statusPanel?.updateApi('FRED', { status: 'error' });
      return;
    }

    try {
      this.economicPanel?.setLoading(true);
      const data = await fetchFredData();

      // Check if circuit breaker tripped after fetch
      const postInfo = getCircuitBreakerCooldownInfo('FRED Economic');
      if (postInfo.onCooldown) {
        this.economicPanel?.setErrorState(true, `Temporarily unavailable (retry in ${postInfo.remainingSeconds}s)`);
        this.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      if (data.length === 0) {
        // Data fetch failed but not yet on cooldown - show error state
        this.economicPanel?.setErrorState(true, 'Failed to load economic data');
        this.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      this.economicPanel?.setErrorState(false);
      this.economicPanel?.update(data);
      this.statusPanel?.updateApi('FRED', { status: 'ok' });
    } catch {
      this.statusPanel?.updateApi('FRED', { status: 'error' });
      this.economicPanel?.setErrorState(true, 'Failed to load data');
      this.economicPanel?.setLoading(false);
    }
  }

  private updateMonitorResults(): void {
    const monitorPanel = this.panels['monitors'] as MonitorPanel;
    monitorPanel.renderResults(this.allNews);
  }

  private async runCorrelationAnalysis(): Promise<void> {
    try {
      // Ensure we have clusters (compute via worker if needed)
      if (this.latestClusters.length === 0 && this.allNews.length > 0) {
        this.latestClusters = await analysisWorker.clusterNews(this.allNews);
      }

      // Run correlation analysis off main thread via Web Worker
      const signals = await analysisWorker.analyzeCorrelations(
        this.latestClusters,
        this.latestPredictions,
        this.latestMarkets
      );

      if (signals.length > 0) {
        addToSignalHistory(signals);
        this.signalModal?.show(signals);
      }
    } catch (error) {
      console.error('[App] Correlation analysis failed:', error);
    }
  }

  private setupRefreshIntervals(): void {
    // Always refresh news, markets, predictions
    setInterval(() => this.loadNews(), REFRESH_INTERVALS.feeds);
    setInterval(() => this.loadMarkets(), REFRESH_INTERVALS.markets);
    setInterval(() => this.loadPredictions(), REFRESH_INTERVALS.predictions);

    // Only refresh layer data if layer is enabled
    setInterval(() => {
      if (this.mapLayers.earthquakes) this.loadEarthquakes();
    }, 5 * 60 * 1000);
    setInterval(() => {
      if (this.mapLayers.weather) this.loadWeatherAlerts();
    }, 10 * 60 * 1000);
    setInterval(() => {
      if (this.mapLayers.economic) this.loadFredData();
    }, 30 * 60 * 1000);
    setInterval(() => {
      if (this.mapLayers.outages) this.loadOutages();
    }, 60 * 60 * 1000);
    setInterval(() => {
      if (this.mapLayers.ais) this.loadAisSignals();
    }, REFRESH_INTERVALS.ais);
    setInterval(() => {
      if (this.mapLayers.cables) this.loadCableActivity();
    }, 30 * 60 * 1000);
    setInterval(() => {
      if (this.mapLayers.protests) this.loadProtests();
    }, 15 * 60 * 1000);
    setInterval(() => {
      if (this.mapLayers.flights) this.loadFlightDelays();
    }, 10 * 60 * 1000);
  }
}
