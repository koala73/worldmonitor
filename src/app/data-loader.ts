import type { AppContext, AppModule } from '@/app/app-context';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { enqueuePanelCall } from '@/app/pending-panel-data';
import type { NewsItem, MapLayers, SocialUnrestEvent } from '@/types';
import type { MarketData } from '@/types';
import type { TimeRange } from '@/components';
import {
  FEEDS,
  INTEL_SOURCES,
  SECTORS,
  COMMODITIES,
  MARKET_SYMBOLS,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
} from '@/config';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import {
  fetchCategoryFeeds,
  getFeedFailures,
  fetchMultipleStocks,
  fetchCommodityQuotes,
  fetchSectors,
  warmCommodityCache,
  warmSectorCache,
  fetchCrypto,
  fetchCryptoSectors,
  fetchDefiTokens,
  fetchAiTokens,
  fetchOtherTokens,
  fetchPredictions,
  fetchEarthquakes,
  fetchWeatherAlerts,
  fetchFredData,
  fetchInternetOutages,
  fetchTrafficAnomalies,
  fetchDdosAttacks,
  isOutagesConfigured,
  fetchAisSignals,
  getAisStatus,
  isAisConfigured,
  fetchCableActivity,
  fetchCableHealth,
  fetchProtestEvents,
  getProtestStatus,
  fetchFlightDelays,
  fetchMilitaryFlights,
  fetchMilitaryVessels,
  initMilitaryVesselStream,
  isMilitaryVesselTrackingConfigured,
  fetchUSNIFleetReport,
  updateBaseline,
  calculateDeviation,
  addToSignalHistory,
  analysisWorker,
  fetchPizzIntStatus,
  fetchGdeltTensions,
  fetchNaturalEvents,
  fetchRecentAwards,
  fetchOilAnalytics,
  fetchCrudeInventoriesRpc,
  fetchNatGasStorageRpc,
  getEuGasStorageData,
  getOilStocksAnalysisData,
  fetchLngVulnerability,
  getEcbFxRatesData,
  fetchBisData,
  fetchBlsData,
  fetchCyberThreats,
  drainTrendingSignals,
  fetchTradeRestrictions,
  fetchTariffTrends,
  fetchTradeFlows,
  fetchComtradeFlows,
  fetchTradeBarriers,
  fetchCustomsRevenue,
  fetchShippingRates,
  fetchChokepointStatus,
  fetchCriticalMinerals,
  fetchSanctionsPressure,
  fetchRadiationWatch,
} from '@/services';
import { getMarketWatchlistEntries } from '@/services/market-watchlist';
import { fetchStockAnalysesForTargets, getStockAnalysisTargets } from '@/services/stock-analysis';
import {
  fetchStockBacktestsForTargets,
  fetchStoredStockBacktests,
  getMissingOrStaleStoredStockBacktests,
  hasFreshStoredStockBacktests,
} from '@/services/stock-backtest';
import {
  fetchStockAnalysisHistory,
  getMissingOrStaleStockAnalysisSymbols,
  hasFreshStockAnalysisHistory,
  getLatestStockAnalysisSnapshots,
  mergeStockAnalysisHistory,
} from '@/services/stock-analysis-history';
import { checkBatchForBreakingAlerts, dispatchOrefBreakingAlert } from '@/services/breaking-news-alerts';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { ingestProtests, ingestFlights, ingestVessels, ingestEarthquakes, detectGeoConvergence, geoConvergenceToSignal } from '@/services/geo-convergence';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck, consumeServerAnomalies, fetchLiveAnomalies } from '@/services/temporal-baseline';
import { fetchAllFires, flattenFires, computeRegionStats, toMapFires } from '@/services/wildfires';
import { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal, type TheaterPostureSummary } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { ingestProtestsForCII, ingestMilitaryForCII, ingestNewsForCII, ingestOutagesForCII, ingestConflictsForCII, ingestUcdpForCII, ingestHapiForCII, ingestDisplacementForCII, ingestClimateForCII, ingestStrikesForCII, ingestOrefForCII, ingestAviationForCII, ingestAdvisoriesForCII, ingestGpsJammingForCII, ingestAisDisruptionsForCII, ingestSatelliteFiresForCII, ingestCyberThreatsForCII, ingestTemporalAnomaliesForCII, ingestEarthquakesForCII, ingestSanctionsForCII, isInLearningMode, resetHotspotActivity, setIntelligenceSignalsLoaded, hasAnyIntelligenceData, calculateCII } from '@/services/country-instability';
import { fetchGpsInterference } from '@/services/gps-interference';
import { fetchSatelliteTLEs, initSatRecs, propagatePositions, startPropagationLoop } from '@/services/satellites';
import type { SatRecEntry } from '@/services/satellites';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled, fetchIranEvents } from '@/services/conflict';
import { fetchUnhcrPopulation } from '@/services/displacement';
import { fetchClimateAnomalies } from '@/services/climate';
import { fetchSecurityAdvisories } from '@/services/security-advisories';
import { fetchThermalEscalations } from '@/services/thermal-escalation';
import { fetchCrossSourceSignals } from '@/services/cross-source-signals';
import { fetchTelegramFeed } from '@/services/telegram-intel';
import { fetchOrefAlerts, startOrefPolling, stopOrefPolling, onOrefAlertsUpdate } from '@/services/oref-alerts';
import { getResilienceRanking } from '@/services/resilience';
import { buildResilienceChoroplethMap } from '@/components/resilience-choropleth-utils';
import { enrichEventsWithExposure } from '@/services/population-exposure';
import { debounce, getCircuitBreakerCooldownInfo } from '@/utils';
import { isFeatureAvailable, isFeatureEnabled } from '@/services/runtime-config';
import { hasPremiumAccess } from '@/services/panel-gating';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { getHydratedData } from '@/services/bootstrap';
import { ingestHeadlines } from '@/services/trending-keywords';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { GetSectorSummaryResponse, ListMarketQuotesResponse, ListCommodityQuotesResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import { mountCommunityWidget } from '@/components/CommunityWidget';
import { ResearchServiceClient } from '@/generated/client/worldmonitor/research/v1/service_client';
import {
  MarketPanel,
  StockAnalysisPanel,
  StockBacktestPanel,
  HeatmapPanel,
  CommoditiesPanel,
  CryptoPanel,
  CryptoHeatmapPanel,
  DefiTokensPanel,
  AiTokensPanel,
  OtherTokensPanel,
  PredictionPanel,
  MonitorPanel,
  InsightsPanel,
  CIIPanel,
  InternetDisruptionsPanel,
  StrategicPosturePanel,
  EconomicPanel,
  EnergyComplexPanel,
  TechReadinessPanel,
  UcdpEventsPanel,
  TradePolicyPanel,
  SupplyChainPanel,
  DiseaseOutbreaksPanel,
  SocialVelocityPanel,
  WsbTickerScannerPanel,
} from '@/components';
import { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import { classifyNewsItem } from '@/services/positive-classifier';
import { fetchGivingSummary } from '@/services/giving';
import { fetchProgressData } from '@/services/progress-data';
import { fetchConservationWins } from '@/services/conservation-data';
import { fetchRenewableEnergyData, fetchEnergyCapacity } from '@/services/renewable-energy-data';
import { checkMilestones } from '@/services/celebration';
import { fetchHappinessScores } from '@/services/happiness-data';
import { fetchRenewableInstallations } from '@/services/renewable-installations';
import { filterBySentiment } from '@/services/sentiment-gate';
import { fetchAllPositiveTopicIntelligence } from '@/services/gdelt-intel';
import { fetchPositiveGeoEvents, geocodePositiveNewsItems, type PositiveGeoEvent } from '@/services/positive-events-geo';
import type { HappyContentCategory } from '@/services/positive-classifier';
import { fetchKindnessData } from '@/services/kindness-data';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { getActiveFrameworkForPanel, subscribeFrameworkChange } from '@/services/analysis-framework-store';
import {
  buildDailyMarketBrief,
  cacheDailyMarketBrief,
  getCachedDailyMarketBrief,
  shouldRefreshDailyBrief,
  type RegimeMacroContext,
  type YieldCurveContext,
  type SectorBriefContext,
} from '@/services/daily-market-brief';
import { fetchCachedRiskScores } from '@/services/cached-risk-scores';
import type { ThreatLevel as ClientThreatLevel } from '@/types';
import type { NewsItem as ProtoNewsItem, ThreatLevel as ProtoThreatLevel } from '@/generated/client/worldmonitor/news/v1/service_client';
import { fetchMarketImplications } from '@/services/market-implications';
import { fetchDiseaseOutbreaks } from '@/services/disease-outbreaks';
import { fetchSocialVelocity } from '@/services/social-velocity';
import { fetchShippingStress } from '@/services/supply-chain';
import { getTopActiveGeoHubs } from '@/services/geo-activity';
import { getTopActiveHubs } from '@/services/tech-activity';
import type { GeoHubsPanel } from '@/components/GeoHubsPanel';
import type { TechHubsPanel } from '@/components/TechHubsPanel';

const PROTO_TO_CLIENT_LEVEL: Record<ProtoThreatLevel, ClientThreatLevel> = {
  THREAT_LEVEL_UNSPECIFIED: 'info',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_CRITICAL: 'critical',
};

const PROTO_TO_CLIENT_PHASE: Record<string, import('@/types').StoryPhase> = {
  STORY_PHASE_BREAKING:   'breaking',
  STORY_PHASE_DEVELOPING: 'developing',
  STORY_PHASE_SUSTAINED:  'sustained',
  STORY_PHASE_FADING:     'fading',
};

function protoItemToNewsItem(p: ProtoNewsItem): NewsItem {
  const level = PROTO_TO_CLIENT_LEVEL[p.threat?.level ?? 'THREAT_LEVEL_UNSPECIFIED'];
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    importanceScore: p.importanceScore || undefined,
    corroborationCount: p.corroborationCount || undefined,
    storyMeta: p.storyMeta && p.storyMeta.phase !== 'STORY_PHASE_UNSPECIFIED' ? {
      firstSeen:    p.storyMeta.firstSeen,
      mentionCount: p.storyMeta.mentionCount,
      sourceCount:  p.storyMeta.sourceCount,
      phase: PROTO_TO_CLIENT_PHASE[p.storyMeta.phase] ?? 'breaking',
    } : undefined,
    threat: p.threat ? {
      level,
      category: p.threat.category as import('@/services/threat-classifier').EventCategory,
      confidence: p.threat.confidence,
      source: (p.threat.source || 'keyword') as 'keyword' | 'ml' | 'llm',
    } : undefined,
    ...(p.locationName && { locationName: p.locationName }),
    ...(p.location && { lat: p.location.latitude, lon: p.location.longitude }),
    ...(p.importanceScore ? { importanceScore: p.importanceScore } : {}),
    ...(p.corroborationCount ? { corroborationCount: p.corroborationCount } : {}),
  };
}

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: TheaterPostureSummary[]) => void;
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;
  private callbacks: DataLoaderCallbacks;

  private mapFlashCache: Map<string, number> = new Map();
  private readonly MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;
  private readonly applyTimeRangeFilterToNewsPanelsDebounced = debounce(() => {
    this.applyTimeRangeFilterToNewsPanels();
  }, 120);

  public updateSearchIndex: () => void = () => {};

  private callPanel(key: string, method: string, ...args: unknown[]): void {
    const panel = this.ctx.panels[key];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = panel as any;
    if (obj && typeof obj[method] === 'function') {
      obj[method](...args);
      return;
    }
    enqueuePanelCall(key, method, args);
  }

  private boundMarketWatchlistHandler: (() => void) | null = null;
  private satellitePropagationCleanup: (() => void) | null = null;
  private dailyBriefGeneration = 0;
  private dailyBriefFrameworkUnsubscribe: (() => void) | null = null;
  private marketImplicationsFrameworkUnsubscribe: (() => void) | null = null;
  private cachedSatRecs: SatRecEntry[] | null = null;

  private digestBreaker = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, cooldownUntil: 0 };
  private readonly digestRequestTimeoutMs = 8000;
  private readonly digestBreakerCooldownMs = 5 * 60 * 1000;
  private readonly persistedDigestMaxAgeMs = 6 * 60 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackIntelFeedLimit = 6;
  private readonly perFeedFallbackBatchSize = 2;
  private lastGoodDigest: ListFeedDigestResponse | null = null;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.boundMarketWatchlistHandler = () => {
      void this.loadMarkets().then(async () => {
        if (hasPremiumAccess()) {
          await this.loadStockAnalysis();
          await this.loadStockBacktest();
          await this.loadDailyMarketBrief(true);
        }
      });
    };
    window.addEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);

    this.dailyBriefFrameworkUnsubscribe = subscribeFrameworkChange('daily-market-brief', () => {
      void this.loadDailyMarketBrief(true);
    });
    this.marketImplicationsFrameworkUnsubscribe = subscribeFrameworkChange('market-implications', () => {
      void this.loadMarketImplications();
    });
  }

  destroy(): void {
    this.stopSatellitePropagation();
    if (this.imageryRetryTimer) { clearTimeout(this.imageryRetryTimer); this.imageryRetryTimer = null; }
    this.applyTimeRangeFilterToNewsPanelsDebounced.cancel();
    stopOrefPolling();
    if (this.boundMarketWatchlistHandler) {
      window.removeEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
      this.boundMarketWatchlistHandler = null;
    }
    this.dailyBriefFrameworkUnsubscribe?.();
    this.dailyBriefFrameworkUnsubscribe = null;
    this.marketImplicationsFrameworkUnsubscribe?.();
    this.marketImplicationsFrameworkUnsubscribe = null;
  }

  private refreshCiiAndBrief(forceLocal = false): void {
    (this.ctx.panels['cii'] as CIIPanel)?.refresh(forceLocal);
    this.callbacks.refreshOpenCountryBrief();
    const scores = calculateCII();
    this.ctx.map?.setCIIScores(scores.map(s => ({ code: s.code, score: s.score, level: s.level })));
    this.ctx.map?.setLayerReady('ciiChoropleth', scores.length > 0);
  }

  private async tryFetchDigest(): Promise<ListFeedDigestResponse | null> {
    const now = Date.now();

    if (this.digestBreaker.state === 'open') {
      if (now < this.digestBreaker.cooldownUntil) {
        return this.lastGoodDigest ?? await this.loadPersistedDigest();
      }
      this.digestBreaker.state = 'half-open';
    }

    try {
      const resp = await fetch(
        toApiUrl(`/api/news/v1/list-feed-digest?variant=${SITE_VARIANT}&lang=${getCurrentLanguage()}`),
        { cache: 'no-cache', signal: AbortSignal.timeout(this.digestRequestTimeoutMs) },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as ListFeedDigestResponse;
      const catCount = Object.keys(data.categories ?? {}).length;
      console.info(`[News] Digest fetched: ${catCount} categories`);
      this.lastGoodDigest = data;
      this.persistDigest(data);
      this.digestBreaker = { state: 'closed', failures: 0, cooldownUntil: 0 };
      return data;
    } catch (e) {
      console.warn('[News] Digest fetch failed, using fallback:', e);
      this.digestBreaker.failures++;
      if (this.digestBreaker.failures >= 2) {
        this.digestBreaker.state = 'open';
        this.digestBreaker.cooldownUntil = now + this.digestBreakerCooldownMs;
      }
      return this.lastGoodDigest ?? await this.loadPersistedDigest();
    }
  }

  private persistDigest(data: ListFeedDigestResponse): void {
    setPersistentCache('digest:last-good', data).catch(() => {});
  }

  private async loadPersistedDigest(): Promise<ListFeedDigestResponse | null> {
    try {
      const envelope = await getPersistentCache<ListFeedDigestResponse>('digest:last-good');
      if (!envelope) return null;
      if (Date.now() - envelope.updatedAt > this.persistedDigestMaxAgeMs) return null;
      this.lastGoodDigest = envelope.data;
      return envelope.data;
    } catch { return null; }
  }

  private isPerFeedFallbackEnabled(): boolean {
    // Desktop: server digest has fewer categories than client FEEDS config.
    // Enable per-feed RSS fallback so missing categories fetch directly.
    if (isDesktopRuntime()) return true;
    return isFeatureEnabled('newsPerFeedFallback');
  }

  private getStaleNewsItems(category: string): NewsItem[] {
    const staleItems = this.ctx.newsByCategory[category];
    if (!Array.isArray(staleItems) || staleItems.length === 0) return [];
    return [...staleItems].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  }

  private selectLimitedFeeds<T>(feeds: T[], maxFeeds: number): T[] {
    if (feeds.length <= maxFeeds) return feeds;
    return feeds.slice(0, maxFeeds);
  }

  private shouldShowIntelligenceNotifications(): boolean {
    return !this.ctx.isMobile && !!this.ctx.findingsBadge?.isPopupEnabled();
  }

  private isPanelNearViewport(panelId: string, marginPx = 400): boolean {
    const panel = this.ctx.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = 400): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
  }

  async loadAllData(forceAll = false): Promise<void> {
    const runGuarded = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (this.ctx.isDestroyed || this.ctx.inFlight.has(name)) return;
      this.ctx.inFlight.add(name);
      try {
        await fn();
      } catch (e) {
        if (!this.ctx.isDestroyed) console.error(`[App] ${name} failed:`, e);
      } finally {
        this.ctx.inFlight.delete(name);
      }
    };

    const shouldLoad = (id: string): boolean => forceAll || this.isPanelNearViewport(id);
    const shouldLoadAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    const tasks: Array<{ name: string; task: Promise<void> }> = [
      { name: 'news', task: runGuarded('news', () => this.loadNews()) },
    ];

    // Happy variant only loads news data -- skip all geopolitical/financial/military data
    if (SITE_VARIANT !== 'happy') {
      if (shouldLoadAny(['markets', 'heatmap', 'commodities', 'crypto', 'energy-complex', 'crypto-heatmap', 'defi-tokens', 'ai-tokens', 'other-tokens'])) {
        tasks.push({ name: 'markets', task: runGuarded('markets', () => this.loadMarkets()) });
      }
      if (hasPremiumAccess() && shouldLoad('stock-analysis')) {
        tasks.push({ name: 'stockAnalysis', task: runGuarded('stockAnalysis', () => this.loadStockAnalysis()) });
      }
      if (hasPremiumAccess() && shouldLoad('stock-backtest')) {
        tasks.push({ name: 'stockBacktest', task: runGuarded('stockBacktest', () => this.loadStockBacktest()) });
      }
      if (hasPremiumAccess() && shouldLoad('daily-market-brief')) {
        tasks.push({ name: 'dailyMarketBrief', task: runGuarded('dailyMarketBrief', () => this.loadDailyMarketBrief()) });
      }
      if (shouldLoad('polymarket')) {
        tasks.push({ name: 'predictions', task: runGuarded('predictions', () => this.loadPredictions()) });
      }
      if (shouldLoad('forecast')) {
        tasks.push({ name: 'forecasts', task: runGuarded('forecasts', () => this.loadForecasts()) });
        tasks.push({ name: 'simulation-outcome', task: runGuarded('simulation-outcome', () => this.loadSimulationOutcome()) });
      }
      if (SITE_VARIANT === 'full') tasks.push({ name: 'pizzint', task: runGuarded('pizzint', () => this.loadPizzInt()) });
      if (shouldLoad('economic')) {
        tasks.push({ name: 'fred', task: runGuarded('fred', () => this.loadFredData()) });
        tasks.push({ name: 'spending', task: runGuarded('spending', () => this.loadGovernmentSpending()) });
        tasks.push({ name: 'bis', task: runGuarded('bis', () => this.loadBisData()) });
        tasks.push({ name: 'bls', task: runGuarded('bls', () => this.loadBlsData()) });
      }
      if (shouldLoad('energy-complex')) {
        tasks.push({ name: 'oil', task: runGuarded('oil', () => this.loadOilAnalytics()) });
      }

      // Trade policy data (FULL and FINANCE only)
      if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance' || SITE_VARIANT === 'commodity') {
        if (shouldLoad('trade-policy')) {
          tasks.push({ name: 'tradePolicy', task: runGuarded('tradePolicy', () => this.loadTradePolicy()) });
        }
        if (shouldLoad('supply-chain')) {
          tasks.push({ name: 'supplyChain', task: runGuarded('supplyChain', () => this.loadSupplyChain()) });
        }
      }
    }

    // Progress charts data (happy variant only)
    if (SITE_VARIANT === 'happy') {
      if (shouldLoad('progress')) {
        tasks.push({
          name: 'progress',
          task: runGuarded('progress', () => this.loadProgressData()),
        });
      }
      if (shouldLoad('species')) {
        tasks.push({
          name: 'species',
          task: runGuarded('species', () => this.loadSpeciesData()),
        });
      }
      if (shouldLoad('renewable')) {
        tasks.push({
          name: 'renewable',
          task: runGuarded('renewable', () => this.loadRenewableData()),
        });
      }
      tasks.push({
        name: 'happinessMap',
        task: runGuarded('happinessMap', async () => {
          const data = await fetchHappinessScores();
          this.ctx.map?.setHappinessScores(data);
        }),
      });
      tasks.push({
        name: 'renewableMap',
        task: runGuarded('renewableMap', async () => {
          const installations = await fetchRenewableInstallations();
          this.ctx.map?.setRenewableInstallations(installations);
        }),
      });
    }

    if (shouldLoad('giving')) {
      tasks.push({
        name: 'giving',
        task: runGuarded('giving', async () => {
          const givingResult = await fetchGivingSummary();
          if (!givingResult.ok) {
            dataFreshness.recordError('giving', 'Giving data unavailable (retaining prior state)');
            return;
          }
          const data = givingResult.data;
          this.callPanel('giving', 'setData', data);
          if (data.platforms.length > 0) dataFreshness.recordUpdate('giving', data.platforms.length);
        }),
      });
    }

    if (SITE_VARIANT === 'full') {
      try {
        const cached = await fetchCachedRiskScores().catch(() => null);
        if (cached && cached.cii.length > 0) {
          (this.ctx.panels['cii'] as CIIPanel)?.renderFromCached(cached);
          this.ctx.map?.setCIIScores(cached.cii.map(s => ({ code: s.code, score: s.score, level: s.level })));
          this.ctx.map?.setLayerReady('ciiChoropleth', true);
        }
      } catch { /* non-fatal */ }
    }
    // Intelligence signals: run for any variant that shows these panels
    if (shouldLoadAny(['cii', 'strategic-risk', 'strategic-posture', 'climate', 'population-exposure', 'security-advisories', 'radiation-watch', 'displacement', 'ucdp-events', 'satellite-fires', 'oref-sirens'])) {
      tasks.push({ name: 'intelligence', task: runGuarded('intelligence', () => this.loadIntelligenceSignals()) });
    }

    if (SITE_VARIANT === 'full' && (shouldLoad('satellite-fires') || this.ctx.mapLayers.natural)) {
      tasks.push({ name: 'firms', task: runGuarded('firms', () => this.loadFirmsData()) });
    }
    if (this.ctx.mapLayers.natural) tasks.push({ name: 'natural', task: runGuarded('natural', () => this.loadNatural()) });
    if (this.ctx.mapLayers.diseaseOutbreaks || shouldLoad('disease-outbreaks')) tasks.push({ name: 'diseaseOutbreaks', task: runGuarded('diseaseOutbreaks', () => this.loadDiseaseOutbreaks()) });
    if (shouldLoad('social-velocity')) tasks.push({ name: 'socialVelocity', task: runGuarded('socialVelocity', () => this.loadSocialVelocity()) });
    if (hasPremiumAccess() && shouldLoad('wsb-ticker-scanner')) tasks.push({ name: 'wsbTickers', task: runGuarded('wsbTickers', () => this.loadWsbTickers()) });
    if (shouldLoad('economic')) tasks.push({ name: 'economicStress', task: runGuarded('economicStress', () => this.loadEconomicStress()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.weather) tasks.push({ name: 'weather', task: runGuarded('weather', () => this.loadWeatherAlerts()) });
    if (SITE_VARIANT !== 'happy' && !isDesktopRuntime() && this.ctx.mapLayers.ais) tasks.push({ name: 'ais', task: runGuarded('ais', () => this.loadAisSignals()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.cables) tasks.push({ name: 'cables', task: runGuarded('cables', () => this.loadCableActivity()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.cables) tasks.push({ name: 'cableHealth', task: runGuarded('cableHealth', () => this.loadCableHealth()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.flights) tasks.push({ name: 'flights', task: runGuarded('flights', () => this.loadFlightDelays()) });
    if (SITE_VARIANT !== 'happy' && CYBER_LAYER_ENABLED && this.ctx.mapLayers.cyberThreats) tasks.push({ name: 'cyberThreats', task: runGuarded('cyberThreats', () => this.loadCyberThreats()) });
    if (SITE_VARIANT !== 'happy' && !isDesktopRuntime() && (this.ctx.mapLayers.iranAttacks || shouldLoadAny(['cii', 'strategic-risk', 'strategic-posture']))) tasks.push({ name: 'iranAttacks', task: runGuarded('iranAttacks', () => this.loadIranEvents()) });
    if (SITE_VARIANT !== 'happy' && (this.ctx.mapLayers.techEvents || SITE_VARIANT === 'tech')) tasks.push({ name: 'techEvents', task: runGuarded('techEvents', () => this.loadTechEvents()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.satellites && this.ctx.map?.isGlobeMode?.()) tasks.push({ name: 'satellites', task: runGuarded('satellites', () => this.loadSatellites()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.webcams) tasks.push({ name: 'webcams', task: runGuarded('webcams', () => this.loadWebcams()) });
    if (SITE_VARIANT !== 'happy' && (shouldLoad('sanctions-pressure') || this.ctx.mapLayers.sanctions)) {
      tasks.push({ name: 'sanctions', task: runGuarded('sanctions', () => this.loadSanctionsPressure()) });
    }
    if (this.ctx.mapLayers.resilienceScore) {
      if (hasPremiumAccess()) {
        tasks.push({ name: 'resilienceRanking', task: runGuarded('resilienceRanking', () => this.loadResilienceRanking()) });
      } else {
        this.ctx.map?.setResilienceRanking([]);
        this.ctx.map?.setLayerReady('resilienceScore', false);
      }
    }
    if (SITE_VARIANT !== 'happy' && (shouldLoad('radiation-watch') || this.ctx.mapLayers.radiationWatch)) {
      tasks.push({ name: 'radiation', task: runGuarded('radiation', () => this.loadRadiationWatch()) });
    }

    if (SITE_VARIANT !== 'happy') {
      tasks.push({ name: 'techReadiness', task: runGuarded('techReadiness', () => (this.ctx.panels['tech-readiness'] as TechReadinessPanel)?.refresh()) });
    }
    if (SITE_VARIANT !== 'happy' && shouldLoad('thermal-escalation')) {
      tasks.push({ name: 'thermalEscalation', task: runGuarded('thermalEscalation', () => this.loadThermalEscalations()) });
    }
    if (SITE_VARIANT !== 'happy' && shouldLoad('cross-source-signals')) {
      tasks.push({ name: 'crossSourceSignals', task: runGuarded('crossSourceSignals', () => this.loadCrossSourceSignals()) });
    }

    // Stagger startup: run tasks in small batches to avoid hammering upstreams
    const BATCH_SIZE = 4;
    const BATCH_DELAY_MS = 300;
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(t => t.task));
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          console.error(`[App] ${batch[idx]?.name} load failed:`, result.reason);
        }
      });
      if (i + BATCH_SIZE < tasks.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    this.updateSearchIndex();

    if (hasPremiumAccess()) {
      await Promise.allSettled([
        this.loadDailyMarketBrief(),
        this.loadMarketImplications(),
      ]);
    }

    const bootstrapTemporal = consumeServerAnomalies();
    if (bootstrapTemporal.anomalies.length > 0 || bootstrapTemporal.trackedTypes.length > 0) {
      signalAggregator.ingestTemporalAnomalies(bootstrapTemporal.anomalies, bootstrapTemporal.trackedTypes);
      ingestTemporalAnomaliesForCII(bootstrapTemporal.anomalies);
      this.refreshCiiAndBrief();
    } else {
      this.refreshTemporalBaseline().catch(() => {});
    }
  }

  async refreshTemporalBaseline(): Promise<void> {
    const { anomalies, trackedTypes } = await fetchLiveAnomalies();
    signalAggregator.ingestTemporalAnomalies(anomalies, trackedTypes);
    ingestTemporalAnomaliesForCII(anomalies);
    this.refreshCiiAndBrief();
  }

  async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    if (this.ctx.isDestroyed || this.ctx.inFlight.has(layer)) return;
    this.ctx.inFlight.add(layer);
    this.ctx.map?.setLayerLoading(layer, true);
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
          await Promise.all([this.loadCableActivity(), this.loadCableHealth()]);
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
        case 'positiveEvents':
          await this.loadPositiveEvents();
          break;
        case 'kindness':
          this.loadKindnessData();
          break;
        case 'iranAttacks':
          await this.loadIranEvents();
          break;
        case 'satellites': {
          await this.loadSatellites();
          this.loadImageryFootprints();
          break;
        }
        case 'webcams':
          await this.loadWebcams();
          break;
        case 'sanctions':
          await this.loadSanctionsPressure();
          break;
        case 'radiationWatch':
          await this.loadRadiationWatch();
          break;
        case 'ucdpEvents':
        case 'displacement':
        case 'climate':
        case 'gpsJamming':
          await this.loadIntelligenceSignals();
          break;
        case 'diseaseOutbreaks':
          await this.loadDiseaseOutbreaks();
          break;
        case 'resilienceScore':
          await this.loadResilienceRanking();
          break;
      }
    } finally {
      this.ctx.inFlight.delete(layer);
      this.ctx.map?.setLayerLoading(layer, false);
    }
  }

  async loadSatellites(): Promise<void> {
    this.stopSatellitePropagation();
    const data = await fetchSatelliteTLEs();
    if (!data || data.length === 0) return;
    this.cachedSatRecs = initSatRecs(data);
    const positions = propagatePositions(this.cachedSatRecs);
    this.ctx.map?.setSatellites(positions);
    this.satellitePropagationCleanup = startPropagationLoop(this.cachedSatRecs, (pos) => {
      this.ctx.map?.setSatellites(pos);
    }, 3000);
  }

  private stopSatellitePropagation(): void {
    this.satellitePropagationCleanup?.();
    this.satellitePropagationCleanup = null;
  }

  private imageryRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private loadImageryFootprints(retries = 2): void {
    if (!this.ctx.mapLayers.satellites) return;
    if (this.ctx.map?.isGlobeMode()) return;
    const bbox = this.ctx.map?.getBbox();
    if (!bbox) {
      if (retries > 0) {
        this.imageryRetryTimer = setTimeout(() => this.loadImageryFootprints(retries - 1), 1500);
      }
      return;
    }
    void import('@/services/imagery').then(async ({ fetchImageryScenes }) => {
      try {
        const scenes = await fetchImageryScenes({ bbox, limit: 20 });
        if (!this.ctx.mapLayers.satellites) return;
        if (this.ctx.map?.isGlobeMode()) return;
        this.ctx.map?.setImageryScenes(scenes);
      } catch { /* imagery is best-effort */ }
    });
  }

  stopLayerActivity(layer: keyof MapLayers): void {
    if (layer === 'satellites') {
      this.stopSatellitePropagation();
      if (this.imageryRetryTimer) { clearTimeout(this.imageryRetryTimer); this.imageryRetryTimer = null; }
    }
  }

  private findFlashLocation(title: string): { lat: number; lon: number } | null {
    const tokens = tokenizeForMatch(title);
    let bestMatch: { lat: number; lon: number; matches: number } | null = null;

    const countKeywordMatches = (keywords: string[] | undefined): number => {
      if (!keywords) return 0;
      let matches = 0;
      for (const keyword of keywords) {
        const cleaned = keyword.trim().toLowerCase();
        if (cleaned.length >= 3 && matchKeyword(tokens, cleaned)) {
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
    if (!this.ctx.map || !this.ctx.initialLoadComplete) return;
    if (!getAiFlowSettings().mapNewsFlash) return;
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

      this.ctx.map.flashLocation(location.lat, location.lon);
      this.mapFlashCache.set(cacheKey, now);
    }
  }

  getTimeRangeWindowMs(range: TimeRange): number {
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

  filterItemsByTimeRange(items: NewsItem[], range: TimeRange = this.ctx.currentTimeRange): NewsItem[] {
    if (range === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeWindowMs(range);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  getTimeRangeLabel(range: TimeRange = this.ctx.currentTimeRange): string {
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

  renderNewsForCategory(category: string, items: NewsItem[]): void {
    this.ctx.newsByCategory[category] = items;
    const panel = this.ctx.newsPanels[category];
    if (!panel) return;
    const filteredItems = this.filterItemsByTimeRange(items);
    if (filteredItems.length === 0 && items.length > 0) {
      panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
      return;
    }
    panel.renderNews(filteredItems);
  }

  applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      this.renderNewsForCategory(category, items);
    });
  }

  applyTimeRangeFilterDebounced(): void {
    this.applyTimeRangeFilterToNewsPanelsDebounced();
  }

  private async loadNewsCategory(category: string, feeds: typeof FEEDS.politics, digest?: ListFeedDigestResponse | null): Promise<NewsItem[]> {
    try {
      const panel = this.ctx.newsPanels[category];

      const enabledFeeds = (feeds ?? []).filter(f => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }
      const enabledNames = new Set(enabledFeeds.map(f => f.name));

      // Digest branch: server already aggregated feeds — map proto items to client types
      if (digest?.categories && category in digest.categories) {
        const items = (digest.categories[category]?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledNames.has(i.source));

        ingestHeadlines(items.map(i => ({ title: i.title, pubDate: i.pubDate, source: i.source, link: i.link })));

        // Skip client-side AI reclassification for digest items.
        // The server already ran enrichWithAiCache() which checks the same Redis keys
        // that classifyEvent writes to. Re-firing classifyEvent from every client wastes
        // edge requests even when they're Redis cache hits.

        checkBatchForBreakingAlerts(items);
        this.flashMapForNews(items);
        this.renderNewsForCategory(category, items);

        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: items.length,
        });

        if (panel) {
          try {
            const baseline = await updateBaseline(`news:${category}`, items.length);
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
        }

        return items;
      }

      // Per-feed fallback: fetch each feed individually (first load or digest unavailable)
      const renderIntervalMs = 100;
      let lastRenderTime = 0;
      let renderTimeout: ReturnType<typeof setTimeout> | null = null;
      let pendingItems: NewsItem[] | null = null;

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

      const staleItems = this.getStaleNewsItems(category).filter(i => enabledNames.has(i.source));
      if (staleItems.length > 0) {
        console.warn(`[News] Digest missing for "${category}", serving stale headlines (${staleItems.length})`);
        this.renderNewsForCategory(category, staleItems);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: staleItems.length,
        });
        return staleItems;
      }

      if (!this.isPerFeedFallbackEnabled()) {
        console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
        this.renderNewsForCategory(category, []);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'error',
          errorMessage: 'Digest unavailable',
        });
        return [];
      }

      const fallbackFeeds = this.selectLimitedFeeds(enabledFeeds, this.perFeedFallbackCategoryFeedLimit);
      if (fallbackFeeds.length < enabledFeeds.length) {
        console.warn(`[News] Digest missing for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else {
        console.warn(`[News] Digest missing for "${category}", using per-feed fallback (${fallbackFeeds.length} feeds)`);
      }

      const items = await fetchCategoryFeeds(fallbackFeeds, {
        batchSize: this.perFeedFallbackBatchSize,
        onBatch: (partialItems) => {
          scheduleRender(partialItems);
          this.flashMapForNews(partialItems);
          checkBatchForBreakingAlerts(partialItems);
        },
      });

      this.renderNewsForCategory(category, items);
      if (panel) {
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = null;
          pendingItems = null;
        }

        if (items.length === 0) {
          const failures = getFeedFailures();
          const failedFeeds = fallbackFeeds.filter(f => failures.has(f.name));
          if (failedFeeds.length > 0) {
            const names = failedFeeds.map(f => f.name).join(', ');
            panel.showError(`${t('common.noNewsAvailable')} (${names} failed)`);
          }
        }

        try {
          const baseline = await updateBaseline(`news:${category}`, items.length);
          const deviation = calculateDeviation(items.length, baseline);
          panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
        } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
      }

      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });

      return items;
    } catch (error) {
      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      delete this.ctx.newsByCategory[category];
      return [];
    }
  }

  async loadNews(): Promise<void> {
    // Reset happy variant accumulator for fresh pipeline run
    if (SITE_VARIANT === 'happy') {
      this.ctx.happyAllItems = [];
    }

    // Fire digest fetch early (non-blocking) — await before category loop
    const digestPromise = this.tryFetchDigest();

    const categories = Object.entries(FEEDS)
      .filter((entry): entry is [string, typeof FEEDS[keyof typeof FEEDS]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const digest = await digestPromise;

    const maxCategoryConcurrency = SITE_VARIANT === 'tech' ? 4 : 5;
    const categoryConcurrency = Math.max(1, Math.min(maxCategoryConcurrency, categories.length));
    const categoryResults: PromiseSettledResult<NewsItem[]>[] = [];
    for (let i = 0; i < categories.length; i += categoryConcurrency) {
      const chunk = categories.slice(i, i + categoryConcurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(({ key, feeds }) => this.loadNewsCategory(key, feeds, digest))
      );
      categoryResults.push(...chunkResults);
    }

    const collectedNews: NewsItem[] = [];
    categoryResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        const items = result.value;
        // Tag items with content categories for happy variant
        if (SITE_VARIANT === 'happy') {
          for (const item of items) {
            item.happyCategory = classifyNewsItem(item.source, item.title);
          }
          // Accumulate curated items for the positive news pipeline
          this.ctx.happyAllItems = this.ctx.happyAllItems.concat(items);
        }
        collectedNews.push(...items);
      } else {
        console.error(`[App] News category ${categories[idx]?.key} failed:`, result.reason);
      }
    });

    if (SITE_VARIANT === 'full') {
      const enabledIntelSources = INTEL_SOURCES.filter(f => !this.ctx.disabledSources.has(f.name));
      const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
      const intelPanel = this.ctx.newsPanels['intel'];
      if (enabledIntelSources.length === 0) {
        delete this.ctx.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else if (digest?.categories && 'intel' in digest.categories) {
        // Digest branch for intel
        const intel = (digest.categories['intel']?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledIntelNames.has(i.source));
        checkBatchForBreakingAlerts(intel);
        this.renderNewsForCategory('intel', intel);
        if (intelPanel) {
          try {
            const baseline = await updateBaseline('news:intel', intel.length);
            const deviation = calculateDeviation(intel.length, baseline);
            intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
        }
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
        collectedNews.push(...intel);
        this.flashMapForNews(intel);
      } else {
        const staleIntel = this.getStaleNewsItems('intel').filter(i => enabledIntelNames.has(i.source));
        if (staleIntel.length > 0) {
          console.warn(`[News] Intel digest missing, serving stale headlines (${staleIntel.length})`);
          this.renderNewsForCategory('intel', staleIntel);
          if (intelPanel) {
            try {
              const baseline = await updateBaseline('news:intel', staleIntel.length);
              const deviation = calculateDeviation(staleIntel.length, baseline);
              intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
            } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
          }
          this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: staleIntel.length });
          collectedNews.push(...staleIntel);
        } else if (!this.isPerFeedFallbackEnabled()) {
          console.warn('[News] Intel digest missing, limited per-feed fallback disabled');
          delete this.ctx.newsByCategory['intel'];
          this.ctx.statusPanel?.updateFeed('Intel', { status: 'error', errorMessage: 'Digest unavailable' });
        } else {
          const fallbackIntelFeeds = this.selectLimitedFeeds(enabledIntelSources, this.perFeedFallbackIntelFeedLimit);
          if (fallbackIntelFeeds.length < enabledIntelSources.length) {
            console.warn(`[News] Intel digest missing, using limited per-feed fallback (${fallbackIntelFeeds.length}/${enabledIntelSources.length} feeds)`);
          }

          const intelResult = await Promise.allSettled([
            fetchCategoryFeeds(fallbackIntelFeeds, { batchSize: this.perFeedFallbackBatchSize }),
          ]);
          if (intelResult[0]?.status === 'fulfilled') {
            const intel = intelResult[0].value;
            checkBatchForBreakingAlerts(intel);
            this.renderNewsForCategory('intel', intel);
            if (intelPanel) {
              try {
                const baseline = await updateBaseline('news:intel', intel.length);
                const deviation = calculateDeviation(intel.length, baseline);
                intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
              } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
            }
            this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
            collectedNews.push(...intel);
            this.flashMapForNews(intel);
          } else {
            delete this.ctx.newsByCategory['intel'];
            console.error('[App] Intel feed failed:', intelResult[0]?.reason);
          }
        }
      }
    }

    this.ctx.allNews = collectedNews;
    this.ctx.initialLoadComplete = true;
    mountCommunityWidget();

    this.ctx.map?.updateHotspotActivity(this.ctx.allNews);

    this.updateMonitorResults();

    try {
      this.ctx.latestClusters = mlWorker.isAvailable
        ? await clusterNewsHybrid(this.ctx.allNews)
        : await analysisWorker.clusterNews(this.ctx.allNews);

      const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.updateInsights(this.ctx.latestClusters);

      (this.ctx.panels['geo-hubs'] as GeoHubsPanel | undefined)
        ?.setActivities(getTopActiveGeoHubs(this.ctx.latestClusters));
      (this.ctx.panels['tech-hubs'] as TechHubsPanel | undefined)
        ?.setActivities(getTopActiveHubs(this.ctx.latestClusters));

      const geoLocated = this.ctx.latestClusters
        .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
        .map(c => ({
          lat: c.lat,
          lon: c.lon,
          title: c.primaryTitle,
          threatLevel: c.threat?.level ?? 'info',
          timestamp: c.lastUpdated,
        }));
      if (geoLocated.length > 0) {
        this.ctx.map?.setNewsLocations(geoLocated);
      }
    } catch (error) {
      console.error('[App] Clustering failed, clusters unchanged:', error);
      const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.updateInsights([]);
    }

    // Happy variant: run multi-stage positive news pipeline + map layers
    if (SITE_VARIANT === 'happy') {
      await this.loadHappySupplementaryAndRender();
      await Promise.allSettled([
        this.ctx.mapLayers.positiveEvents ? this.loadPositiveEvents() : Promise.resolve(),
        this.ctx.mapLayers.kindness ? Promise.resolve(this.loadKindnessData()) : Promise.resolve(),
      ]);
    }
  }

  async loadStockAnalysis(): Promise<void> {
    const panel = this.ctx.panels['stock-analysis'] as StockAnalysisPanel | undefined;
    if (!panel) return;

    try {
      const targets = getStockAnalysisTargets();
      const targetSymbols = targets.map((target) => target.symbol);
      const storedHistory = await fetchStockAnalysisHistory(targets.length);
      const cachedSnapshots = getLatestStockAnalysisSnapshots(storedHistory, targets.length);
      if (cachedSnapshots.length > 0) {
        panel.renderAnalyses(cachedSnapshots, storedHistory, 'cached');
      }

      if (hasFreshStockAnalysisHistory(storedHistory, targetSymbols)) {
        return;
      }

      const staleSymbols = getMissingOrStaleStockAnalysisSymbols(storedHistory, targetSymbols);
      const staleTargets = targets.filter((target) => staleSymbols.includes(target.symbol));
      const results = await fetchStockAnalysesForTargets(staleTargets);
      if (results.length === 0) {
        if (cachedSnapshots.length === 0) {
          panel.showRetrying('Stock analysis is waiting for eligible watchlist symbols.');
        }
        return;
      }
      const nextHistory = mergeStockAnalysisHistory(storedHistory, results);
      panel.renderAnalyses(results, nextHistory, 'live');
    } catch (error) {
      console.error('[StockAnalysis] failed:', error);
      const cachedHistory = await fetchStockAnalysisHistory().catch(() => ({}));
      const cachedSnapshots = getLatestStockAnalysisSnapshots(cachedHistory);
      if (cachedSnapshots.length > 0) {
        panel.renderAnalyses(cachedSnapshots, cachedHistory, 'cached');
        return;
      }
      panel.showError('Premium stock analysis is temporarily unavailable.');
    }
  }

  async loadStockBacktest(): Promise<void> {
    const panel = this.ctx.panels['stock-backtest'] as StockBacktestPanel | undefined;
    if (!panel) return;

    try {
      const targets = getStockAnalysisTargets();
      const targetSymbols = targets.map((target) => target.symbol);
      const stored = await fetchStoredStockBacktests(targets.length);
      if (stored.length > 0) {
        panel.renderBacktests(stored, 'cached');
      }
      if (hasFreshStoredStockBacktests(stored, targetSymbols)) {
        return;
      }

      const staleSymbols = getMissingOrStaleStoredStockBacktests(stored, targetSymbols);
      const staleTargets = targets.filter((target) => staleSymbols.includes(target.symbol));
      const results = await fetchStockBacktestsForTargets(staleTargets);
      if (results.length === 0) {
        if (stored.length === 0) {
          panel.showRetrying('Backtesting is waiting for eligible watchlist symbols.');
        }
        return;
      }
      panel.renderBacktests(results);
    } catch (error) {
      console.error('[StockBacktest] failed:', error);
      const stored = await fetchStoredStockBacktests().catch(() => []);
      if (stored.length > 0) {
        panel.renderBacktests(stored, 'cached');
        return;
      }
      panel.showError('Premium stock backtesting is temporarily unavailable.');
    }
  }

  async loadMarkets(): Promise<void> {
    try {
      const customEntries = getMarketWatchlistEntries();
      const effectiveSymbols = (() => {
        if (customEntries.length === 0) return MARKET_SYMBOLS;
        const base = MARKET_SYMBOLS.slice();
        const seen = new Set(base.map((s) => s.symbol));
        for (const entry of customEntries) {
          const sym = entry.symbol;
          if (!sym || seen.has(sym)) continue;
          seen.add(sym);
          base.push({ symbol: sym, name: entry.name || sym, display: entry.display || sym });
          if (base.length >= 50) break;
        }
        return base;
      })();


      // Hydrate markets from bootstrap (same pattern as sectors) — instant data on page load
      const hydratedMarkets = getHydratedData('marketQuotes') as ListMarketQuotesResponse | undefined;
      let stocksResult: Awaited<ReturnType<typeof fetchMultipleStocks>>;
      const marketsPanel = this.ctx.panels['markets'] as MarketPanel | undefined;

      if (customEntries.length === 0 && hydratedMarkets?.quotes?.length) {
        const symbolMetaMap = new Map(effectiveSymbols.map((s) => [s.symbol, s]));
        const data = hydratedMarkets.quotes.map((q) => ({
          symbol: q.symbol,
          name: symbolMetaMap.get(q.symbol)?.name || q.name,
          display: symbolMetaMap.get(q.symbol)?.display || q.display || q.symbol,
          price: q.price != null ? q.price : null,
          change: q.change ?? null,
          sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
        }));
        this.ctx.latestMarkets = data;
        marketsPanel?.renderMarkets(data);
        stocksResult = { data, skipped: hydratedMarkets.finnhubSkipped || undefined, rateLimited: hydratedMarkets.rateLimited || undefined };
      } else {
        stocksResult = await fetchMultipleStocks(effectiveSymbols, {
          onBatch: (partialStocks) => {
            this.ctx.latestMarkets = partialStocks;
            marketsPanel?.renderMarkets(partialStocks);
          },
        });
        this.ctx.latestMarkets = stocksResult.data;
        marketsPanel?.renderMarkets(stocksResult.data, stocksResult.rateLimited);
      }

      const finnhubConfigMsg = 'FINNHUB_API_KEY not configured — add in Settings';

      if (stocksResult.rateLimited && stocksResult.data.length === 0) {
        const rlMsg = 'Market data temporarily unavailable (rate limited) — retrying shortly';
        this.ctx.panels['commodities']?.showError(rlMsg);
      } else if (stocksResult.skipped) {
        this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
        if (stocksResult.data.length === 0) {
          this.ctx.panels['markets']?.showConfigError(finnhubConfigMsg);
        }
      } else {
        this.ctx.statusPanel?.updateApi('Finnhub', { status: 'ok' });
      }

      // Sector heatmap: always attempt loading regardless of market rate-limit status
      const hydratedSectors = getHydratedData('sectors') as GetSectorSummaryResponse | undefined;
      const heatmapPanel = this.ctx.panels['heatmap'] as HeatmapPanel | undefined;
      const sectorNameMap = new Map(SECTORS.map((s) => [s.symbol, s.name]));
      const toHeatmapItem = (s: { symbol: string; name: string; change: number }) => ({
        symbol: s.symbol,
        name: sectorNameMap.get(s.symbol) ?? s.name,
        change: s.change,
      });
      const toSectorBar = (s: { symbol?: string; name: string; change: number | null }) =>
        s.symbol && Number.isFinite(s.change) ? { symbol: s.symbol, name: s.name, change1d: s.change as number } : null;
      if (hydratedSectors?.sectors?.length) {
        warmSectorCache(hydratedSectors);
        const items = hydratedSectors.sectors.map(toHeatmapItem);
        const sectorBars = items.map(toSectorBar).filter((s): s is NonNullable<typeof s> => s !== null);
        heatmapPanel?.renderHeatmap(items, sectorBars.length ? sectorBars : undefined);
      } else {
        const sectorsResp = await fetchSectors();
        if (sectorsResp.sectors.length > 0) {
          const items = sectorsResp.sectors.map(toHeatmapItem);
          const sectorBars = items.map(toSectorBar).filter((s): s is NonNullable<typeof s> => s !== null);
          heatmapPanel?.renderHeatmap(items, sectorBars.length ? sectorBars : undefined);
        } else if (stocksResult.skipped) {
          this.ctx.panels['heatmap']?.showConfigError(finnhubConfigMsg);
        }
      }

      const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel | undefined;
      const energyPanel = this.ctx.panels['energy-complex'] as EnergyComplexPanel | undefined;
      const mapCommodity = (c: MarketData) => ({ symbol: c.symbol, display: c.display, price: c.price, change: c.change, sparkline: c.sparkline });
      const energySymbols = new Set(['CL=F', 'BZ=F', 'NG=F']);
      const filterCommodityTape = (data: MarketData[]) => data.filter((item) => item.symbol !== '^VIX' && !energySymbols.has(item.symbol));
      const filterEnergyTape = (data: MarketData[]) => data.filter((item) => energySymbols.has(item.symbol));

      if (commoditiesPanel || energyPanel) {
        // Hydrate commodities from bootstrap (same pattern as sectors/markets)
        const hydratedCommodities = getHydratedData('commodityQuotes') as ListCommodityQuotesResponse | undefined;
        const skipFetch = stocksResult.rateLimited && stocksResult.data.length === 0;
        let metalsLoaded = skipFetch;
        let energyLoaded = skipFetch;

        if (!(metalsLoaded && energyLoaded) && hydratedCommodities?.quotes?.length) {
          // Warm the circuit-breaker cache so SWR serves stale data if the
          // first scheduled live call fails (bootstrap hydration bypasses the RPC).
          warmCommodityCache(hydratedCommodities);
          const symbolMetaMap = new Map(COMMODITIES.map((s) => [s.symbol, s]));
          const data = hydratedCommodities.quotes.map((q) => ({
            symbol: q.symbol,
            name: symbolMetaMap.get(q.symbol)?.name || q.name,
            display: symbolMetaMap.get(q.symbol)?.display || q.display || q.symbol,
            price: q.price != null ? q.price : null,
            change: q.change ?? null,
            sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
          }));
          const commodityMapped = filterCommodityTape(data).map(mapCommodity);
          const energyMapped = filterEnergyTape(data);
          if (commoditiesPanel && commodityMapped.some(d => d.price !== null)) {
            commoditiesPanel.renderCommodities(commodityMapped);
            metalsLoaded = true;
          }
          if (energyMapped.some(d => d.price !== null)) {
            energyPanel?.updateTape(energyMapped);
            energyLoaded = true;
          }
        }

        for (let attempt = 0; attempt < 1 && (!metalsLoaded || !energyLoaded); attempt++) {
          const commoditiesResult = await fetchCommodityQuotes(COMMODITIES, {
            onBatch: (partial) => {
              const commodityMapped = filterCommodityTape(partial).map(mapCommodity);
              const energyMapped = filterEnergyTape(partial);
              if (commoditiesPanel) commoditiesPanel.renderCommodities(commodityMapped);
              energyPanel?.updateTape(energyMapped);
            },
          });
          const commodityMapped = filterCommodityTape(commoditiesResult.data).map(mapCommodity);
          const energyMapped = filterEnergyTape(commoditiesResult.data);
          if (commoditiesPanel && commodityMapped.some(d => d.price !== null)) {
            commoditiesPanel.renderCommodities(commodityMapped);
            metalsLoaded = true;
          }
          if (energyMapped.some(d => d.price !== null)) {
            energyPanel?.updateTape(energyMapped);
            energyLoaded = true;
          }
        }
        if (!metalsLoaded) commoditiesPanel?.renderCommodities([]);
        if (!energyLoaded) energyPanel?.updateTape([]);
      }

      // Load ECB FX rates for CommoditiesPanel FX tab
      if (commoditiesPanel) {
        try {
          const fxResp = await getEcbFxRatesData();
          if (!fxResp.unavailable && fxResp.rates?.length) {
            const EUR_FX_ORDER = ['USD', 'GBP', 'JPY', 'CHF', 'CAD', 'CNY', 'AUD'];
            const orderedRates = EUR_FX_ORDER
              .map(ccy => fxResp.rates.find(r => r.pair === `EUR${ccy}`))
              .filter((r): r is NonNullable<typeof r> => r != null);
            commoditiesPanel.updateFxRates(orderedRates.map(r => ({
              currency: r.pair.slice(3), // EURUSD -> USD
              rate: r.rate,
              change1d: r.change1d ?? null,
            })));
          }
        } catch {
          // FX tab is optional, ignore failures
        }
      }
    } catch {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
    }

    try {
      const cryptoPanel = this.ctx.panels['crypto'] as CryptoPanel | undefined;
      const crypto = await fetchCrypto();
      cryptoPanel?.renderCrypto(crypto);
      this.ctx.statusPanel?.updateApi('CoinGecko', { status: crypto.length > 0 ? 'ok' : 'error' });
    } catch {
      this.ctx.statusPanel?.updateApi('CoinGecko', { status: 'error' });
    }

    const cryptoHeatmapPanel = this.ctx.panels['crypto-heatmap'] as CryptoHeatmapPanel | undefined;
    const defiPanel = this.ctx.panels['defi-tokens'] as DefiTokensPanel | undefined;
    const aiPanel = this.ctx.panels['ai-tokens'] as AiTokensPanel | undefined;
    const otherPanel = this.ctx.panels['other-tokens'] as OtherTokensPanel | undefined;

    if (cryptoHeatmapPanel || defiPanel || aiPanel || otherPanel) {
      try {
        const [sectors, defi, ai, other] = await Promise.all([
          cryptoHeatmapPanel ? fetchCryptoSectors() : Promise.resolve([]),
          defiPanel ? fetchDefiTokens() : Promise.resolve([]),
          aiPanel ? fetchAiTokens() : Promise.resolve([]),
          otherPanel ? fetchOtherTokens() : Promise.resolve([]),
        ]);
        cryptoHeatmapPanel?.renderSectors(sectors);
        defiPanel?.renderTokens(defi);
        aiPanel?.renderTokens(ai);
        otherPanel?.renderTokens(other);
      } catch (err) {
        console.warn('[DataLoader] Token panel load failed:', err);
        cryptoHeatmapPanel?.showRetrying(t('common.failedCryptoData'));
        defiPanel?.showRetrying(t('common.failedCryptoData'));
        aiPanel?.showRetrying(t('common.failedCryptoData'));
        otherPanel?.showRetrying(t('common.failedCryptoData'));
      }
    }
  }

  async loadDailyMarketBrief(force = false): Promise<void> {
    if (!hasPremiumAccess()) return;
    if (this.ctx.isDestroyed || this.ctx.inFlight.has('dailyMarketBrief')) return;

    this.dailyBriefGeneration++;
    const gen = this.dailyBriefGeneration;
    this.ctx.inFlight.add('dailyMarketBrief');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const cached = await getCachedDailyMarketBrief(timezone);

      if (cached?.available) {
        this.callPanel('daily-market-brief', 'renderBrief', cached, 'cached');
      }

      if (!force && cached && !shouldRefreshDailyBrief(cached, timezone)) {
        return;
      }

      if (!cached) {
        this.callPanel('daily-market-brief', 'showLoading', 'Building daily market brief...');
      }

      const [r0, r1, r2] = await Promise.allSettled([
        this._collectRegimeContext(),
        this._collectYieldCurveContext(),
        this._collectSectorContext(),
      ]);
      const regimeContext = r0.status === 'fulfilled' ? r0.value : undefined;
      const yieldCurveContext = r1.status === 'fulfilled' ? r1.value : undefined;
      const sectorContext = r2.status === 'fulfilled' ? r2.value : undefined;

      const brief = await buildDailyMarketBrief({
        markets: this.ctx.latestMarkets,
        newsByCategory: this.ctx.newsByCategory,
        timezone,
        regimeContext,
        yieldCurveContext,
        sectorContext,
        frameworkAppend: getActiveFrameworkForPanel('daily-market-brief')?.systemPromptAppend,
        newsCategories: SITE_VARIANT === 'commodity'
          ? ['commodity-news', 'gold-silver', 'mining-news', 'energy', 'critical-minerals']
          : undefined,
      });

      if (this.dailyBriefGeneration !== gen) return;

      if (!brief.available) {
        if (!cached?.available) {
          this.callPanel('daily-market-brief', 'showUnavailable');
        }
        return;
      }

      await cacheDailyMarketBrief(brief);
      this.callPanel('daily-market-brief', 'renderBrief', brief, 'live');
    } catch (error) {
      console.warn('[DailyBrief] Failed to build daily market brief:', error);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const cached = await getCachedDailyMarketBrief(timezone).catch(() => null);
      if (cached?.available) {
        this.callPanel('daily-market-brief', 'renderBrief', cached, 'cached');
        return;
      }
      this.callPanel('daily-market-brief', 'showError', 'Failed to build daily market brief. Retrying later.');
    } finally {
      this.ctx.inFlight.delete('dailyMarketBrief');
    }
  }

  private async _collectRegimeContext(): Promise<RegimeMacroContext | undefined> {
    try {
      const hydrated = getHydratedData('fearGreedIndex') as Record<string, unknown> | undefined;
      if (hydrated && !hydrated.unavailable && Number(hydrated.compositeScore) > 0) {
        const comp = hydrated.composite as Record<string, unknown> | undefined;
        const cats = (hydrated.categories ?? {}) as Record<string, Record<string, unknown>>;
        const hdr = (hydrated.headerMetrics ?? {}) as Record<string, Record<string, unknown> | null>;
        return {
          compositeScore: Number(comp?.score ?? hydrated.compositeScore ?? 0),
          compositeLabel: String(comp?.label ?? hydrated.compositeLabel ?? ''),
          fsiValue: Number(hdr?.fsi?.value ?? 0),
          fsiLabel: String(hdr?.fsi?.label ?? ''),
          vix: Number(hdr?.vix?.value ?? 0),
          hySpread: Number(hdr?.hySpread?.value ?? 0),
          cnnFearGreed: Number(hdr?.cnnFearGreed?.value ?? 0),
          cnnLabel: String(hdr?.cnnFearGreed?.label ?? ''),
          momentum: cats.momentum ? { score: Number(cats.momentum.score ?? 0) } : undefined,
          sentiment: cats.sentiment ? { score: Number(cats.sentiment.score ?? 0) } : undefined,
        };
      }
      const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getFearGreedIndex({});
      if (resp.unavailable || resp.compositeScore <= 0) return undefined;
      return {
        compositeScore: resp.compositeScore,
        compositeLabel: resp.compositeLabel,
        fsiValue: resp.fsiValue ?? 0,
        fsiLabel: resp.fsiLabel ?? '',
        vix: resp.vix ?? 0,
        hySpread: resp.hySpread ?? 0,
        cnnFearGreed: resp.cnnFearGreed ?? 0,
        cnnLabel: resp.cnnLabel ?? '',
        momentum: resp.momentum ? { score: resp.momentum.score } : undefined,
        sentiment: resp.sentiment ? { score: resp.sentiment.score } : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private async _collectYieldCurveContext(): Promise<YieldCurveContext | undefined> {
    try {
      const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getFredSeriesBatch({ seriesIds: ['DGS2', 'DGS10', 'DGS30'], limit: 1 });
      const lastVal = (id: string): number => {
        const obs = resp.results[id]?.observations;
        if (!obs?.length) return 0;
        return obs[obs.length - 1]?.value ?? 0;
      };
      const rate2y = lastVal('DGS2');
      const rate10y = lastVal('DGS10');
      const rate30y = lastVal('DGS30');
      if (!rate10y) return undefined;
      const spread2s10s = rate2y > 0 ? Math.round((rate10y - rate2y) * 100) : 0;
      return { inverted: spread2s10s < 0, spread2s10s, rate2y, rate10y, rate30y };
    } catch {
      return undefined;
    }
  }

  private _collectSectorContext(): SectorBriefContext | undefined {
    try {
      const hydratedSectors = getHydratedData('sectors') as GetSectorSummaryResponse | undefined;
      const sectors = hydratedSectors?.sectors;
      if (!sectors?.length) return undefined;
      const sorted = [...sectors].sort((a, b) => b.change - a.change);
      const countPositive = sorted.filter(s => s.change > 0).length;
      const top = sorted[0];
      const worst = sorted[sorted.length - 1];
      if (!top || !worst) return undefined;
      return {
        topName: top.name,
        topChange: top.change,
        worstName: worst.name,
        worstChange: worst.change,
        countPositive,
        total: sorted.length,
      };
    } catch {
      return undefined;
    }
  }

  async loadMarketImplications(): Promise<void> {
    if (!hasPremiumAccess()) return;
    if (this.ctx.isDestroyed || this.ctx.inFlight.has('marketImplications')) return;
    this.ctx.inFlight.add('marketImplications');
    try {
      const data = await fetchMarketImplications(getActiveFrameworkForPanel('market-implications')?.id ?? '');
      if (!data) {
        this.callPanel('market-implications', 'showUnavailable');
        return;
      }
      if (data.degraded || data.cards.length === 0) {
        this.callPanel('market-implications', 'showUnavailable');
        return;
      }
      this.callPanel('market-implications', 'renderImplications', data, 'live');
    } catch {
      this.callPanel('market-implications', 'showUnavailable');
    } finally {
      this.ctx.inFlight.delete('marketImplications');
    }
  }

  async loadPredictions(): Promise<void> {
    try {
      const predictions = await fetchPredictions({ region: this.ctx.resolvedLocation });
      this.ctx.latestPredictions = predictions;
      (this.ctx.panels['polymarket'] as PredictionPanel | undefined)?.renderPredictions(predictions);

      this.ctx.statusPanel?.updateFeed('Polymarket', { status: 'ok', itemCount: predictions.length });
      this.ctx.statusPanel?.updateApi('Polymarket', { status: 'ok' });
      dataFreshness.recordUpdate('polymarket', predictions.length);
      dataFreshness.recordUpdate('predictions', predictions.length);

      void this.runCorrelationAnalysis();
    } catch (error) {
      this.ctx.statusPanel?.updateFeed('Polymarket', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('Polymarket', { status: 'error' });
      dataFreshness.recordError('polymarket', String(error));
      dataFreshness.recordError('predictions', String(error));
    }
  }

  async loadForecasts(): Promise<void> {
    try {
      const hydrated = getHydratedData('forecasts') as { predictions?: import('@/generated/client/worldmonitor/forecast/v1/service_client').Forecast[] } | undefined;
      if (hydrated?.predictions?.length) {
        this.callPanel('forecast', 'updateForecasts', hydrated.predictions);
        return;
      }
      const { fetchForecasts } = await import('@/services/forecast');
      const forecasts = await fetchForecasts();
      this.callPanel('forecast', 'updateForecasts', forecasts);
    } catch { /* premium feature, silent fail */ }
  }

  async loadSimulationOutcome(): Promise<void> {
    try {
      const { fetchSimulationOutcome } = await import('@/services/forecast');
      const json = await fetchSimulationOutcome();
      if (json) this.callPanel('forecast', 'updateSimulation', json);
    } catch { /* silent fail — simulation data is supplementary */ }
  }

  async loadNatural(): Promise<void> {
    const [earthquakeResult, eonetResult] = await Promise.allSettled([
      fetchEarthquakes(),
      fetchNaturalEvents(30),
    ]);

    if (earthquakeResult.status === 'fulfilled') {
      this.ctx.intelligenceCache.earthquakes = earthquakeResult.value;
      this.ctx.map?.setEarthquakes(earthquakeResult.value);
      ingestEarthquakes(earthquakeResult.value);
      ingestEarthquakesForCII(earthquakeResult.value);
      this.ctx.statusPanel?.updateApi('USGS', { status: 'ok' });
      dataFreshness.recordUpdate('usgs', earthquakeResult.value.length);
    } else {
      this.ctx.intelligenceCache.earthquakes = [];
      this.ctx.map?.setEarthquakes([]);
      this.ctx.statusPanel?.updateApi('USGS', { status: 'error' });
      dataFreshness.recordError('usgs', String(earthquakeResult.reason));
    }

    if (eonetResult.status === 'fulfilled') {
      this.ctx.map?.setNaturalEvents(eonetResult.value);
      this.ctx.statusPanel?.updateFeed('EONET', {
        status: 'ok',
        itemCount: eonetResult.value.length,
      });
      this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'ok' });
    } else {
      this.ctx.map?.setNaturalEvents([]);
      this.ctx.statusPanel?.updateFeed('EONET', { status: 'error', errorMessage: String(eonetResult.reason) });
      this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'error' });
    }

    const hasEarthquakes = earthquakeResult.status === 'fulfilled' && earthquakeResult.value.length > 0;
    const hasEonet = eonetResult.status === 'fulfilled' && eonetResult.value.length > 0;
    this.ctx.map?.setLayerReady('natural', hasEarthquakes || hasEonet);
  }

  async loadTechEvents(): Promise<void> {
    console.log('[loadTechEvents] Called. SITE_VARIANT:', SITE_VARIANT, 'techEvents layer:', this.ctx.mapLayers.techEvents);
    if (SITE_VARIANT !== 'tech' && !this.ctx.mapLayers.techEvents) {
      console.log('[loadTechEvents] Skipping - not tech variant and layer disabled');
      return;
    }

    try {
      // Try hydrated bootstrap data first (instant, no RPC)
      const hydrated = getHydratedData('techEvents') as { events?: Array<{ id: string; title: string; type: string; location: string; coords?: { lat: number; lng: number; country: string; virtual?: boolean }; startDate: string; endDate: string; url: string }> } | undefined;
      let events = hydrated?.events;

      if (!events?.length) {
        // Fallback: RPC call
        const client = new ResearchServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
        const data = await client.listTechEvents({
          type: 'conference',
          mappable: true,
          days: 90,
          limit: 50,
        });
        if (!data.success) throw new Error(data.error || 'Unknown error');
        events = data.events;
      } else {
        // Filter hydrated data to match map layer needs (conferences, mappable, 90 days)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + 90);
        events = events.filter(e =>
          e.type === 'conference' &&
          e.coords && !e.coords.virtual &&
          new Date(e.startDate) <= cutoff,
        ).slice(0, 50);
      }

      const now = new Date();
      const mapEvents = (events || []).map((e: any) => ({
        id: e.id,
        title: e.title,
        location: e.location,
        lat: e.coords?.lat ?? 0,
        lng: e.coords?.lng ?? 0,
        country: e.coords?.country ?? '',
        startDate: e.startDate,
        endDate: e.endDate,
        url: e.url,
        daysUntil: Math.ceil((new Date(e.startDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      }));

      this.ctx.map?.setTechEvents(mapEvents);
      this.ctx.map?.setLayerReady('techEvents', mapEvents.length > 0);
      this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'ok', itemCount: mapEvents.length });

      if (SITE_VARIANT === 'tech' && this.ctx.searchModal) {
        this.ctx.searchModal.registerSource('techevent', mapEvents.map((e: { id: string; title: string; location: string; startDate: string }) => ({
          id: e.id,
          title: e.title,
          subtitle: `${e.location} • ${new Date(e.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          data: e,
        })));
      }
    } catch (error) {
      console.error('[App] Failed to load tech events:', error);
      this.ctx.map?.setTechEvents([]);
      this.ctx.map?.setLayerReady('techEvents', false);
      this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'error', errorMessage: String(error) });
    }
  }

  async loadWeatherAlerts(): Promise<void> {
    try {
      const alerts = await fetchWeatherAlerts();
      this.ctx.map?.setWeatherAlerts(alerts);
      this.ctx.map?.setLayerReady('weather', alerts.length > 0);
      this.ctx.statusPanel?.updateFeed('Weather', { status: 'ok', itemCount: alerts.length });
      dataFreshness.recordUpdate('weather', alerts.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('weather', false);
      this.ctx.statusPanel?.updateFeed('Weather', { status: 'error' });
      dataFreshness.recordError('weather', String(error));
    }
  }

  async loadIntelligenceSignals(): Promise<void> {
    resetHotspotActivity();
    const _desktopLocked = isDesktopRuntime() && !hasPremiumAccess();
    const tasks: Promise<void>[] = [];

    tasks.push((async () => {
      try {
        const outages = await fetchInternetOutages();
        this.ctx.intelligenceCache.outages = outages;
        ingestOutagesForCII(outages);
        signalAggregator.ingestOutages(outages);
        dataFreshness.recordUpdate('outages', outages.length);
        if (this.ctx.mapLayers.outages) {
          this.ctx.map?.setOutages(outages);
          this.ctx.map?.setLayerReady('outages', outages.length > 0);
          this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
        }
        (this.ctx.panels['internet-disruptions'] as InternetDisruptionsPanel)?.setOutages(outages);
        fetchTrafficAnomalies().then(r => {
          this.ctx.map?.setTrafficAnomalies(r.anomalies);
          (this.ctx.panels['internet-disruptions'] as InternetDisruptionsPanel)?.setAnomalies(r.anomalies);
        }).catch(() => {});
        fetchDdosAttacks().then(r => {
          this.ctx.map?.setDdosLocations(r.topTargetLocations ?? []);
          (this.ctx.panels['internet-disruptions'] as InternetDisruptionsPanel)?.setDdos(r);
        }).catch(() => {});
      } catch (error) {
        console.error('[Intelligence] Outages fetch failed:', error);
        dataFreshness.recordError('outages', String(error));
      }
    })());

    const protestsTask = (async (): Promise<SocialUnrestEvent[]> => {
      try {
        const protestData = await fetchProtestEvents();
        this.ctx.intelligenceCache.protests = protestData;
        ingestProtests(protestData.events);
        ingestProtestsForCII(protestData.events);
        signalAggregator.ingestProtests(protestData.events);
        const protestCount = protestData.sources.acled + protestData.sources.gdelt;
        if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
        if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
        if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
        if (this.ctx.mapLayers.protests) {
          this.ctx.map?.setProtests(protestData.events);
          this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
          const status = getProtestStatus();
          this.ctx.statusPanel?.updateFeed('Protests', {
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

    const hydratedUcdp = getHydratedData('ucdpEvents') as import('@/generated/client/worldmonitor/conflict/v1/service_client').ListUcdpEventsResponse | undefined;

    tasks.push((async () => {
      try {
        const classifications = await fetchUcdpClassifications(hydratedUcdp);
        ingestUcdpForCII(classifications);
        if (classifications.size > 0) dataFreshness.recordUpdate('ucdp', classifications.size);
      } catch (error) {
        console.error('[Intelligence] UCDP fetch failed:', error);
        dataFreshness.recordError('ucdp', String(error));
      }
    })());

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

    tasks.push((async () => {
      try {
        if (isMilitaryVesselTrackingConfigured()) {
          initMilitaryVesselStream();
        }
        const [flightData, vesselData] = await Promise.all([
          fetchMilitaryFlights(),
          fetchMilitaryVessels(),
        ]);
        this.ctx.intelligenceCache.military = {
          flights: flightData.flights,
          flightClusters: flightData.clusters,
          vessels: vesselData.vessels,
          vesselClusters: vesselData.clusters,
        };
        fetchUSNIFleetReport().then((report) => {
          if (report) this.ctx.intelligenceCache.usniFleet = report;
        }).catch(() => {});
        ingestFlights(flightData.flights);
        ingestVessels(vesselData.vessels);
        ingestMilitaryForCII(flightData.flights, vesselData.vessels);
        signalAggregator.ingestFlights(flightData.flights);
        signalAggregator.ingestVessels(vesselData.vessels);
        dataFreshness.recordUpdate('opensky', flightData.flights.length);
        updateAndCheck([
          { type: 'military_flights', region: 'global', count: flightData.flights.length },
          { type: 'vessels', region: 'global', count: vesselData.vessels.length },
        ]).then(anomalies => {
          if (anomalies.length > 0) {
            signalAggregator.ingestTemporalAnomalies(anomalies);
            ingestTemporalAnomaliesForCII(anomalies);
            this.refreshCiiAndBrief();
          }
        }).catch(() => { });
        if (this.ctx.mapLayers.military) {
          this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
          this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
          this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
          const militaryCount = flightData.flights.length + vesselData.vessels.length;
          this.ctx.statusPanel?.updateFeed('Military', {
            status: militaryCount > 0 ? 'ok' : 'warning',
            itemCount: militaryCount,
          });
        }
        if (!isInLearningMode()) {
          const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
          if (surgeAlerts.length > 0) {
            const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
            addToSignalHistory(surgeSignals);
            if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(surgeSignals);
          }
          const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
          if (foreignAlerts.length > 0) {
            const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
            addToSignalHistory(foreignSignals);
            if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(foreignSignals);
          }
        }
      } catch (error) {
        console.error('[Intelligence] Military fetch failed:', error);
        dataFreshness.recordError('opensky', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const protestEvents = await protestsTask;
        const result = await fetchUcdpEvents(hydratedUcdp);
        if (!result.success) {
          // listUcdpEvents is a pure Redis-read (gold standard). Retrying returns
          // the same empty result until the Railway seed refreshes the key.
          dataFreshness.recordError('ucdp_events', 'UCDP events unavailable (retaining prior event state)');
          return;
        }
        const acledEvents = protestEvents.map(e => ({
          latitude: e.lat, longitude: e.lon, event_date: e.time.toISOString(), fatalities: e.fatalities ?? 0,
        }));
        const events = deduplicateAgainstAcled(result.data, acledEvents);
        (this.ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(events);
        if (this.ctx.mapLayers.ucdpEvents) {
          this.ctx.map?.setUcdpEvents(events);
        }
        if (events.length > 0) dataFreshness.recordUpdate('ucdp_events', events.length);
      } catch (error) {
        console.error('[Intelligence] UCDP events fetch failed:', error);
        dataFreshness.recordError('ucdp_events', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const unhcrResult = await fetchUnhcrPopulation();
        if (!unhcrResult.ok) {
          dataFreshness.recordError('unhcr', 'UNHCR displacement unavailable (retaining prior displacement state)');
          return;
        }
        const data = unhcrResult.data;
        this.callPanel('displacement', 'setData', data);
        ingestDisplacementForCII(data.countries);
        if (this.ctx.mapLayers.displacement && data.topFlows) {
          this.ctx.map?.setDisplacementFlows(data.topFlows);
        }
        if (data.countries.length > 0) dataFreshness.recordUpdate('unhcr', data.countries.length);
      } catch (error) {
        console.error('[Intelligence] UNHCR displacement fetch failed:', error);
        this.callPanel('displacement', 'showError');
        dataFreshness.recordError('unhcr', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          return;
        }
        const anomalies = climateResult.anomalies;
        this.callPanel('climate', 'setAnomalies', anomalies);
        ingestClimateForCII(anomalies);
        if (this.ctx.mapLayers.climate) {
          this.ctx.map?.setClimateAnomalies(anomalies);
        }
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        this.callPanel('climate', 'showError');
        dataFreshness.recordError('climate', String(error));
      }
    })());

    // Security advisories
    tasks.push(this.loadSecurityAdvisories());

    // Telegram Intel (premium-locked on desktop without API key)
    if (!_desktopLocked) {
      tasks.push(this.loadTelegramIntel());
    }

    // OREF sirens (premium-locked on desktop without API key)
    if (!_desktopLocked) {
      tasks.push((async () => {
        try {
          const data = await fetchOrefAlerts();
          this.callPanel('oref-sirens', 'setData', data);
          const alertCount = data.alerts?.length ?? 0;
          const historyCount24h = data.historyCount24h ?? 0;
          ingestOrefForCII(alertCount, historyCount24h);
          this.ctx.intelligenceCache.orefAlerts = { alertCount, historyCount24h };
          if (data.alerts?.length) dispatchOrefBreakingAlert(data.alerts);
          onOrefAlertsUpdate((update) => {
            this.callPanel('oref-sirens', 'setData', update);
            const updAlerts = update.alerts?.length ?? 0;
            const updHistory = update.historyCount24h ?? 0;
            ingestOrefForCII(updAlerts, updHistory);
            this.ctx.intelligenceCache.orefAlerts = { alertCount: updAlerts, historyCount24h: updHistory };
            if (update.alerts?.length) dispatchOrefBreakingAlert(update.alerts);
          });
          startOrefPolling();
        } catch (error) {
          console.error('[Intelligence] OREF alerts fetch failed:', error);
          this.callPanel('oref-sirens', 'showError');
        }
      })());
    }

    // GPS/GNSS jamming (cloud-only — seeded by Wingbits API via fetch-gpsjam.mjs)
    if (!isDesktopRuntime()) {
      tasks.push((async () => {
        try {
          const data = await fetchGpsInterference();
          if (!data) {
            ingestGpsJammingForCII([]);
            this.ctx.map?.setLayerReady('gpsJamming', false);
            return;
          }
          ingestGpsJammingForCII(data.hexes);
          if (this.ctx.mapLayers.gpsJamming) {
            this.ctx.map?.setGpsJamming(data.hexes);
            this.ctx.map?.setLayerReady('gpsJamming', data.hexes.length > 0);
          }
          this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'ok', itemCount: data.hexes.length });
          dataFreshness.recordUpdate('gpsjam', data.hexes.length);
        } catch (error) {
          this.ctx.map?.setLayerReady('gpsJamming', false);
          this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'error' });
          dataFreshness.recordError('gpsjam', String(error));
        }
      })());
    }

    await Promise.allSettled(tasks);

    try {
      const ucdpEvts = (this.ctx.panels['ucdp-events'] as UcdpEventsPanel)?.getEvents?.() || [];
      const events = [
        ...(this.ctx.intelligenceCache.protests?.events || []).slice(0, 10).map(e => ({
          id: e.id, lat: e.lat, lon: e.lon, type: 'conflict' as const, name: e.title || 'Protest',
        })),
        ...ucdpEvts.slice(0, 10).map(e => ({
          id: e.id, lat: e.latitude, lon: e.longitude, type: e.type_of_violence as string, name: `${e.side_a} vs ${e.side_b}`,
        })),
      ];
      if (events.length > 0) {
        const exposures = await enrichEventsWithExposure(events);
        this.callPanel('population-exposure', 'setExposures', exposures);
        if (exposures.length > 0) dataFreshness.recordUpdate('worldpop', exposures.length);
      } else {
        this.callPanel('population-exposure', 'setExposures', []);
      }
    } catch (error) {
      console.error('[Intelligence] Population exposure fetch failed:', error);
      this.callPanel('population-exposure', 'showError');
      dataFreshness.recordError('worldpop', String(error));
    }

    if (hasAnyIntelligenceData()) {
      setIntelligenceSignalsLoaded();
    }
    this.refreshCiiAndBrief(true);
    console.log('[Intelligence] All signals loaded for CII calculation');
  }

  async loadOutages(): Promise<void> {
    if (this.ctx.intelligenceCache.outages) {
      const outages = this.ctx.intelligenceCache.outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      return;
    }
    try {
      const outages = await fetchInternetOutages();
      this.ctx.intelligenceCache.outages = outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      ingestOutagesForCII(outages);
      signalAggregator.ingestOutages(outages);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      dataFreshness.recordUpdate('outages', outages.length);
      (this.ctx.panels['internet-disruptions'] as InternetDisruptionsPanel)?.setOutages(outages);
      fetchTrafficAnomalies().then(r => {
        this.ctx.map?.setTrafficAnomalies(r.anomalies);
        (this.ctx.panels['internet-disruptions'] as InternetDisruptionsPanel)?.setAnomalies(r.anomalies);
      }).catch(() => {});
      fetchDdosAttacks().then(r => {
        this.ctx.map?.setDdosLocations(r.topTargetLocations ?? []);
        (this.ctx.panels['internet-disruptions'] as InternetDisruptionsPanel)?.setDdos(r);
      }).catch(() => {});
    } catch (error) {
      this.callPanel('internet-disruptions', 'showError');
      this.ctx.map?.setLayerReady('outages', false);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
      dataFreshness.recordError('outages', String(error));
    }
  }

  async loadCyberThreats(): Promise<void> {
    if (!CYBER_LAYER_ENABLED) {
      this.ctx.mapLayers.cyberThreats = false;
      this.ctx.map?.setLayerReady('cyberThreats', false);
      return;
    }

    if (this.ctx.cyberThreatsCache) {
      this.ctx.map?.setCyberThreats(this.ctx.cyberThreatsCache);
      this.ctx.map?.setLayerReady('cyberThreats', this.ctx.cyberThreatsCache.length > 0);
      ingestCyberThreatsForCII(this.ctx.cyberThreatsCache);
      this.refreshCiiAndBrief();
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: this.ctx.cyberThreatsCache.length });
      return;
    }

    try {
      const threats = await fetchCyberThreats({ limit: 500, days: 14 });
      this.ctx.cyberThreatsCache = threats;
      this.ctx.map?.setCyberThreats(threats);
      this.ctx.map?.setLayerReady('cyberThreats', threats.length > 0);
      ingestCyberThreatsForCII(threats);
      this.refreshCiiAndBrief();
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: threats.length });
      this.ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'ok' });
      dataFreshness.recordUpdate('cyber_threats', threats.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('cyberThreats', false);
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'error' });
      dataFreshness.recordError('cyber_threats', String(error));
    }
  }

  async loadIranEvents(): Promise<void> {
    try {
      const events = await fetchIranEvents();
      this.ctx.intelligenceCache.iranEvents = events;
      this.ctx.map?.setIranEvents(events);
      this.ctx.map?.setLayerReady('iranAttacks', events.length > 0);
      const coerced = events.map(e => ({ ...e, timestamp: Number(e.timestamp) || 0 }));
      signalAggregator.ingestConflictEvents(coerced);
      ingestStrikesForCII(coerced);
      this.refreshCiiAndBrief();
    } catch {
      this.ctx.map?.setLayerReady('iranAttacks', false);
    }
  }

  async loadAisSignals(): Promise<void> {
    try {
      const { disruptions, density } = await fetchAisSignals();
      const aisStatus = getAisStatus();
      console.log('[Ships] Events:', { disruptions: disruptions.length, density: density.length, vessels: aisStatus.vessels });
      this.ctx.map?.setAisData(disruptions, density);
      signalAggregator.ingestAisDisruptions(disruptions);
      ingestAisDisruptionsForCII(disruptions);
      this.refreshCiiAndBrief();
      updateAndCheck([
        { type: 'ais_gaps', region: 'global', count: disruptions.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) {
          signalAggregator.ingestTemporalAnomalies(anomalies);
          ingestTemporalAnomaliesForCII(anomalies);
          this.refreshCiiAndBrief();
        }
      }).catch(() => { });

      const hasData = disruptions.length > 0 || density.length > 0;
      this.ctx.map?.setLayerReady('ais', hasData);

      const shippingCount = disruptions.length + density.length;
      const shippingStatus = shippingCount > 0 ? 'ok' : (aisStatus.connected ? 'warning' : 'error');
      this.ctx.statusPanel?.updateFeed('Shipping', {
        status: shippingStatus,
        itemCount: shippingCount,
        errorMessage: !aisStatus.connected && shippingCount === 0 ? 'AIS snapshot unavailable' : undefined,
      });
      this.ctx.statusPanel?.updateApi('AISStream', {
        status: aisStatus.connected ? 'ok' : 'warning',
      });
      if (hasData) {
        dataFreshness.recordUpdate('ais', shippingCount);
      }
    } catch (error) {
      this.ctx.map?.setLayerReady('ais', false);
      this.ctx.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('AISStream', { status: 'error' });
      dataFreshness.recordError('ais', String(error));
    }
  }

  waitForAisData(): void {
    const maxAttempts = 30;
    let attempts = 0;

    const checkData = () => {
      if (this.ctx.isDestroyed) return;
      attempts++;
      const status = getAisStatus();

      if (status.vessels > 0 || status.connected) {
        this.loadAisSignals();
        this.ctx.map?.setLayerLoading('ais', false);
        return;
      }

      if (attempts >= maxAttempts) {
        this.ctx.map?.setLayerLoading('ais', false);
        this.ctx.map?.setLayerReady('ais', false);
        this.ctx.statusPanel?.updateFeed('Shipping', {
          status: 'error',
          errorMessage: 'Connection timeout'
        });
        return;
      }

      setTimeout(checkData, 1000);
    };

    checkData();
  }

  async loadCableActivity(): Promise<void> {
    try {
      const activity = await fetchCableActivity();
      this.ctx.map?.setCableActivity(activity.advisories, activity.repairShips);
      const itemCount = activity.advisories.length + activity.repairShips.length;
      this.ctx.statusPanel?.updateFeed('CableOps', { status: 'ok', itemCount });
    } catch {
      this.ctx.statusPanel?.updateFeed('CableOps', { status: 'error' });
    }
  }

  async loadCableHealth(): Promise<void> {
    try {
      const healthData = await fetchCableHealth();
      this.ctx.map?.setCableHealth(healthData.cables);
      const cableIds = Object.keys(healthData.cables);
      const faultCount = cableIds.filter((id) => healthData.cables[id]?.status === 'fault').length;
      const degradedCount = cableIds.filter((id) => healthData.cables[id]?.status === 'degraded').length;
      this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'ok', itemCount: faultCount + degradedCount });
    } catch {
      this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'error' });
    }
  }

  async loadProtests(): Promise<void> {
    if (this.ctx.intelligenceCache.protests) {
      const protestData = this.ctx.intelligenceCache.protests;
      this.ctx.map?.setProtests(protestData.events);
      this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
      const status = getProtestStatus();
      this.ctx.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
      return;
    }
    try {
      const protestData = await fetchProtestEvents();
      this.ctx.intelligenceCache.protests = protestData;
      this.ctx.map?.setProtests(protestData.events);
      this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
      ingestProtests(protestData.events);
      ingestProtestsForCII(protestData.events);
      signalAggregator.ingestProtests(protestData.events);
      const protestCount = protestData.sources.acled + protestData.sources.gdelt;
      if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
      this.refreshCiiAndBrief();
      const status = getProtestStatus();
      this.ctx.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
    } catch (error) {
      this.ctx.map?.setLayerReady('protests', false);
      this.ctx.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('ACLED', { status: 'error' });
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'error' });
      dataFreshness.recordError('gdelt_doc', String(error));
    }
  }

  private lastWebcamBbox: { w: number; s: number; e: number; n: number; zoom: number } | null = null;
  private lastWebcamFetchAt = 0;

  async loadWebcams(): Promise<void> {
    if (!this.ctx.map) return;
    try {
      const map = this.ctx.map;
      const zoom = Math.max(2, map.getState().zoom ?? 3);

      const now = Date.now();
      if (now - this.lastWebcamFetchAt < 1000) return;

      const bboxStr = map.getBbox();
      const parts = bboxStr ? bboxStr.split(',').map(Number) : [-180, -90, 180, 90];
      const w = parts[0] ?? -180;
      const s = parts[1] ?? -90;
      const e = parts[2] ?? 180;
      const n = parts[3] ?? 90;

      if (this.lastWebcamBbox && this.lastWebcamBbox.zoom === zoom) {
        const prev = this.lastWebcamBbox;
        const overlapW = Math.max(0, Math.min(prev.e, e) - Math.max(prev.w, w));
        const overlapH = Math.max(0, Math.min(prev.n, n) - Math.max(prev.s, s));
        const overlapArea = overlapW * overlapH;
        const currentArea = Math.max(0.001, (e - w) * (n - s));
        if (overlapArea / currentArea > 0.8) return;
      }

      this.lastWebcamFetchAt = now;
      this.lastWebcamBbox = { w, s, e, n, zoom };

      const { fetchWebcams } = await import('@/services/webcams');
      const result = await fetchWebcams(zoom, { w, s, e, n });

      const allMarkers = [...result.webcams, ...result.clusters];
      map.setWebcams(allMarkers);
      map.setLayerReady('webcams', allMarkers.length > 0);
    } catch (err) {
      console.warn('[data-loader] webcams failed:', err);
      this.ctx.map?.setLayerReady('webcams', false);
    }
  }

  async loadFlightDelays(): Promise<void> {
    try {
      const delays = await fetchFlightDelays();
      this.ctx.map?.setFlightDelays(delays);
      this.ctx.map?.setLayerReady('flights', delays.length > 0);
      this.ctx.intelligenceCache.flightDelays = delays;
      const severe = delays.filter(d => d.severity === 'major' || d.severity === 'severe' || d.delayType === 'closure');
      if (severe.length > 0) ingestAviationForCII(severe);
      this.ctx.statusPanel?.updateFeed('Flights', {
        status: 'ok',
        itemCount: delays.length,
      });
      this.ctx.statusPanel?.updateApi('FAA', { status: 'ok' });
    } catch (error) {
      this.ctx.map?.setLayerReady('flights', false);
      this.ctx.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('FAA', { status: 'error' });
    }
  }

  async loadMilitary(): Promise<void> {
    if (this.ctx.intelligenceCache.military) {
      const { flights, flightClusters, vessels, vesselClusters } = this.ctx.intelligenceCache.military;
      this.ctx.map?.setMilitaryFlights(flights, flightClusters);
      this.ctx.map?.setMilitaryVessels(vessels, vesselClusters);
      this.ctx.map?.updateMilitaryForEscalation(flights, vessels);
      this.loadCachedPosturesForBanner();
      const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.setMilitaryFlights(flights);
      const hasData = flights.length > 0 || vessels.length > 0;
      this.ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flights.length + vessels.length;
      this.ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
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
      this.ctx.intelligenceCache.military = {
        flights: flightData.flights,
        flightClusters: flightData.clusters,
        vessels: vesselData.vessels,
        vesselClusters: vesselData.clusters,
      };
      fetchUSNIFleetReport().then((report) => {
        if (report) this.ctx.intelligenceCache.usniFleet = report;
      }).catch(() => {});
      this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
      this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
      ingestFlights(flightData.flights);
      ingestVessels(vesselData.vessels);
      ingestMilitaryForCII(flightData.flights, vesselData.vessels);
      signalAggregator.ingestFlights(flightData.flights);
      signalAggregator.ingestVessels(vesselData.vessels);
      updateAndCheck([
        { type: 'military_flights', region: 'global', count: flightData.flights.length },
        { type: 'vessels', region: 'global', count: vesselData.vessels.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) {
          signalAggregator.ingestTemporalAnomalies(anomalies);
          ingestTemporalAnomaliesForCII(anomalies);
          this.refreshCiiAndBrief();
        }
      }).catch(() => { });
      this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
      this.refreshCiiAndBrief();
      if (!isInLearningMode()) {
        const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
        if (surgeAlerts.length > 0) {
          const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
          addToSignalHistory(surgeSignals);
          if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(surgeSignals);
        }
        const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
        if (foreignAlerts.length > 0) {
          const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
          addToSignalHistory(foreignSignals);
          if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(foreignSignals);
        }
      }

      this.loadCachedPosturesForBanner();
      const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.setMilitaryFlights(flightData.flights);

      const hasData = flightData.flights.length > 0 || vesselData.vessels.length > 0;
      this.ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flightData.flights.length + vesselData.vessels.length;
      this.ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      dataFreshness.recordUpdate('opensky', flightData.flights.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('military', false);
      this.ctx.statusPanel?.updateFeed('Military', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'error' });
      dataFreshness.recordError('opensky', String(error));
    }
  }

  private async loadCachedPosturesForBanner(): Promise<void> {
    try {
      const data = await fetchCachedTheaterPosture();
      if (data && data.postures.length > 0) {
        this.callbacks.renderCriticalBanner(data.postures);
        const posturePanel = this.ctx.panels['strategic-posture'] as StrategicPosturePanel | undefined;
        posturePanel?.updatePostures(data);
      }
    } catch (error) {
      console.warn('[App] Failed to load cached postures for banner:', error);
    }
  }

  async loadFredData(): Promise<void> {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    const cbInfo = getCircuitBreakerCooldownInfo('FRED Batch');
    if (cbInfo.onCooldown) {
      economicPanel?.setFredRetrying(cbInfo.remainingSeconds);
      this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
      return;
    }

    try {
      economicPanel?.setLoading(true);
      const data = await fetchFredData();

      const postInfo = getCircuitBreakerCooldownInfo('FRED Batch');
      if (postInfo.onCooldown) {
        economicPanel?.setFredRetrying(postInfo.remainingSeconds);
        this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      if (data.length === 0) {
        if (!isFeatureAvailable('economicFred')) {
          economicPanel?.setFredError(t('components.economic.fredKeyMissing'));
          this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
          return;
        }
        economicPanel?.setFredError(t('common.upstreamUnavailable'));
        this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      economicPanel?.update(data);
      this.ctx.statusPanel?.updateApi('FRED', { status: 'ok' });
      dataFreshness.recordUpdate('economic', data.length);
    } catch {
      this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
      economicPanel?.setFredError(t('common.failedToLoad'));
    }
  }

  async loadOilAnalytics(): Promise<void> {
    const energyPanel = this.ctx.panels['energy-complex'] as EnergyComplexPanel | undefined;
    try {
      const [data, crudeResp, natGasResp, euGasResp, oilStocksResp] = await Promise.allSettled([
        fetchOilAnalytics(),
        fetchCrudeInventoriesRpc(),
        fetchNatGasStorageRpc(),
        getEuGasStorageData(),
        getOilStocksAnalysisData(),
      ]);
      if (data.status === 'fulfilled') {
        energyPanel?.updateAnalytics(data.value);
        const hasData = !!(data.value.wtiPrice || data.value.brentPrice || data.value.usProduction || data.value.usInventory);
        this.ctx.statusPanel?.updateApi('EIA', { status: hasData ? 'ok' : 'error' });
        if (hasData) {
          const metricCount = [data.value.wtiPrice, data.value.brentPrice, data.value.usProduction, data.value.usInventory].filter(Boolean).length;
          dataFreshness.recordUpdate('oil', metricCount || 1);
        } else {
          dataFreshness.recordError('oil', 'Oil analytics returned no values');
        }
      } else {
        console.error('[App] Oil analytics failed:', data.reason);
        this.ctx.statusPanel?.updateApi('EIA', { status: 'error' });
        dataFreshness.recordError('oil', String(data.reason));
      }
      if (crudeResp.status === 'fulfilled' && crudeResp.value.weeks.length > 0) {
        energyPanel?.updateCrudeInventories(crudeResp.value.weeks);
      } else if (crudeResp.status === 'rejected') {
        console.warn('[App] Crude inventories fetch failed:', crudeResp.reason);
      }
      if (natGasResp.status === 'fulfilled' && natGasResp.value.weeks.length > 0) {
        energyPanel?.updateNatGas(natGasResp.value.weeks);
      }
      if (euGasResp.status === 'fulfilled' && !euGasResp.value.unavailable) {
        energyPanel?.updateEuGasStorage(euGasResp.value);
      }
      if (oilStocksResp.status === 'fulfilled' && !oilStocksResp.value.unavailable) {
        energyPanel?.setOilStocksAnalysis(oilStocksResp.value);
      }
      // Fire-and-forget: LNG vulnerability is hydration-only today (no network fallback).
      // Decoupled so a future fetch path does not delay core energy panel rendering.
      fetchLngVulnerability().then(lngData => {
        energyPanel?.updateLngVulnerability(lngData);
      }).catch(() => {
        energyPanel?.updateLngVulnerability(null);
      });
    } catch (e) {
      console.error('[App] Oil analytics failed:', e);
      this.callPanel('energy-complex', 'showError', undefined, () => void this.loadOilAnalytics());
      this.ctx.statusPanel?.updateApi('EIA', { status: 'error' });
      dataFreshness.recordError('oil', String(e));
    }
  }

  async loadGovernmentSpending(): Promise<void> {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    try {
      const data = await fetchRecentAwards();
      economicPanel?.updateSpending(data);
      this.ctx.statusPanel?.updateApi('USASpending', { status: data.awards?.length > 0 ? 'ok' : 'error' });
      if (data.awards?.length > 0) {
        dataFreshness.recordUpdate('spending', data.awards.length);
      } else {
        dataFreshness.recordError('spending', 'No awards returned');
      }
    } catch (e) {
      console.error('[App] Government spending failed:', e);
      this.ctx.statusPanel?.updateApi('USASpending', { status: 'error' });
      dataFreshness.recordError('spending', String(e));
    }
  }

  async loadBisData(): Promise<void> {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    try {
      const data = await fetchBisData();
      economicPanel?.updateBis(data);
      const hasData = data.policyRates?.length > 0;
      this.ctx.statusPanel?.updateApi('BIS', { status: hasData ? 'ok' : 'error' });
      if (hasData) {
        dataFreshness.recordUpdate('bis', data.policyRates?.length ?? 0);
      }
    } catch (e) {
      console.error('[App] BIS data failed:', e);
      this.ctx.statusPanel?.updateApi('BIS', { status: 'error' });
      dataFreshness.recordError('bis', String(e));
    }
  }

  async loadBlsData(): Promise<void> {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    try {
      const data = await fetchBlsData();
      if (data.length > 0) {
        economicPanel?.updateBls(data);
        this.ctx.statusPanel?.updateApi('BLS-Series', { status: 'ok' });
        dataFreshness.recordUpdate('bls', data.length);
      } else {
        this.ctx.statusPanel?.updateApi('BLS-Series', { status: 'error' });
      }
    } catch (e) {
      console.error('[App] BLS data failed:', e);
      this.ctx.statusPanel?.updateApi('BLS-Series', { status: 'error' });
      dataFreshness.recordError('bls', String(e));
    }
  }

  async loadTradePolicy(): Promise<void> {
    const tradePanel = this.ctx.panels['trade-policy'] as TradePolicyPanel | undefined;
    if (!tradePanel) return;

    try {
      const [restrictions, tariffs, flows, barriers, revenue, comtrade] = await Promise.allSettled([
        fetchTradeRestrictions([], 50),
        fetchTariffTrends('840', '156', '', 10),
        fetchTradeFlows('840', '156', 10),
        fetchTradeBarriers([], '', 50),
        fetchCustomsRevenue(),
        fetchComtradeFlows(),
      ]);

      const r = restrictions.status === 'fulfilled' ? restrictions.value : null;
      const ta = tariffs.status === 'fulfilled' ? tariffs.value : null;
      const fl = flows.status === 'fulfilled' ? flows.value : null;
      const ba = barriers.status === 'fulfilled' ? barriers.value : null;
      const rev = revenue.status === 'fulfilled' ? revenue.value : null;
      const ct = comtrade.status === 'fulfilled' ? comtrade.value : null;

      if (r) tradePanel.updateRestrictions(r);
      if (ta) tradePanel.updateTariffs(ta);
      if (fl) tradePanel.updateFlows(fl);
      if (ba) tradePanel.updateBarriers(ba);
      if (rev) tradePanel.updateRevenue(rev);
      if (ct) tradePanel.updateComtradeFlows(ct);

      const wtoItems = (r?.restrictions?.length ?? 0) + (ta?.datapoints?.length ?? 0) + (fl?.flows?.length ?? 0) + (ba?.barriers?.length ?? 0);
      const anyUnavailable = r?.upstreamUnavailable || ta?.upstreamUnavailable || fl?.upstreamUnavailable || ba?.upstreamUnavailable;

      this.ctx.statusPanel?.updateApi('WTO', { status: anyUnavailable ? 'warning' : wtoItems > 0 ? 'ok' : 'error' });

      if (wtoItems > 0) {
        dataFreshness.recordUpdate('wto_trade', wtoItems);
      } else if (anyUnavailable) {
        dataFreshness.recordError('wto_trade', 'WTO upstream temporarily unavailable');
      }
      if (rev?.months?.length) {
        dataFreshness.recordUpdate('treasury_revenue', rev.months.length);
      }
    } catch (e) {
      console.error('[App] Trade policy failed:', e);
      this.callPanel('trade-policy', 'showError', undefined, () => void this.loadTradePolicy());
      this.ctx.statusPanel?.updateApi('WTO', { status: 'error' });
      dataFreshness.recordError('wto_trade', String(e));
    }
  }

  async loadSupplyChain(): Promise<void> {
    const scPanel = this.ctx.panels['supply-chain'] as SupplyChainPanel | undefined;
    if (!scPanel) return;

    try {
      const [shipping, chokepoints, minerals, stress] = await Promise.allSettled([
        fetchShippingRates(),
        fetchChokepointStatus(),
        fetchCriticalMinerals(),
        fetchShippingStress(),
      ]);

      const shippingData = shipping.status === 'fulfilled' ? shipping.value : null;
      const chokepointData = chokepoints.status === 'fulfilled' ? chokepoints.value : null;
      const mineralsData = minerals.status === 'fulfilled' ? minerals.value : null;
      const stressData = stress.status === 'fulfilled' ? stress.value : null;

      if (shippingData) scPanel.updateShippingRates(shippingData);
      if (chokepointData) scPanel.updateChokepointStatus(chokepointData);
      if (chokepointData) this.ctx.map?.setChokepointData(chokepointData);
      if (mineralsData) scPanel.updateCriticalMinerals(mineralsData);
      if (stressData) scPanel.updateShippingStress(stressData);

      const totalItems = (shippingData?.indices.length || 0) + (chokepointData?.chokepoints.length || 0) + (mineralsData?.minerals.length || 0);
      const anyUnavailable = shippingData?.upstreamUnavailable || chokepointData?.upstreamUnavailable || mineralsData?.upstreamUnavailable;

      this.ctx.statusPanel?.updateApi('SupplyChain', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });

      if (totalItems > 0) {
        dataFreshness.recordUpdate('supply_chain', totalItems);
      } else if (anyUnavailable) {
        dataFreshness.recordError('supply_chain', 'Supply chain upstream temporarily unavailable');
      }
    } catch (e) {
      console.error('[App] Supply chain failed:', e);
      this.callPanel('supply-chain', 'showError', undefined, () => void this.loadSupplyChain());
      this.ctx.statusPanel?.updateApi('SupplyChain', { status: 'error' });
      dataFreshness.recordError('supply_chain', String(e));
    }
  }

  async loadDiseaseOutbreaks(): Promise<void> {
    try {
      const data = await fetchDiseaseOutbreaks();
      if (data.outbreaks?.length) {
        const panel = this.ctx.panels['disease-outbreaks'] as DiseaseOutbreaksPanel | undefined;
        panel?.updateData(data.outbreaks);
        this.ctx.map?.setDiseaseOutbreaks(data.outbreaks);
        this.ctx.map?.setLayerReady('diseaseOutbreaks', true);
      }
    } catch (e) {
      console.error('[App] Disease outbreaks load failed:', e);
    }
  }

  async loadSocialVelocity(): Promise<void> {
    try {
      const data = await fetchSocialVelocity();
      if (data.posts?.length) {
        const panel = this.ctx.panels['social-velocity'] as SocialVelocityPanel | undefined;
        panel?.updateData(data.posts);
      }
    } catch (e) {
      console.error('[App] Social velocity load failed:', e);
    }
  }

  async loadWsbTickers(): Promise<void> {
    const panel = this.ctx.panels['wsb-ticker-scanner'] as WsbTickerScannerPanel | undefined;
    if (!panel) return;
    try {
      await panel.fetchData();
    } catch (e) {
      console.error('[App] WSB tickers load failed:', e);
    }
  }

  async loadEconomicStress(): Promise<void> {
    try {
      const economicPanel = this.ctx.panels['economic'] as EconomicPanel | undefined;
      if (!economicPanel) return;

      const hydrated = getHydratedData('economicStress') as import('@/generated/client/worldmonitor/economic/v1/service_client').GetEconomicStressResponse | undefined;
      if (hydrated && !hydrated.unavailable && Number.isFinite(hydrated.compositeScore)) {
        economicPanel.updateStress(hydrated);
        return;
      }

      const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
      const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getEconomicStress({});
      if (!resp.unavailable && Number.isFinite(resp.compositeScore)) {
        economicPanel.updateStress(resp);
      }
    } catch (e) {
      console.error('[App] Economic stress load failed:', e);
    }
  }

  updateMonitorResults(): void {
    const monitorPanel = this.ctx.panels['monitors'] as MonitorPanel | undefined;
    monitorPanel?.renderResults(this.ctx.allNews);
  }

  async runCorrelationAnalysis(): Promise<void> {
    try {
      if (this.ctx.latestClusters.length === 0 && this.ctx.allNews.length > 0) {
        this.ctx.latestClusters = mlWorker.isAvailable
          ? await clusterNewsHybrid(this.ctx.allNews)
          : await analysisWorker.clusterNews(this.ctx.allNews);
      }

      if (this.ctx.latestClusters.length > 0) {
        ingestNewsForCII(this.ctx.latestClusters);
        dataFreshness.recordUpdate('gdelt', this.ctx.latestClusters.length);
        this.refreshCiiAndBrief();
        (this.ctx.panels['geo-hubs'] as GeoHubsPanel | undefined)
          ?.setActivities(getTopActiveGeoHubs(this.ctx.latestClusters));
        (this.ctx.panels['tech-hubs'] as TechHubsPanel | undefined)
          ?.setActivities(getTopActiveHubs(this.ctx.latestClusters));
      }

      const signals = await analysisWorker.analyzeCorrelations(
        this.ctx.latestClusters,
        this.ctx.latestPredictions,
        this.ctx.latestMarkets
      );

      let geoSignals: ReturnType<typeof geoConvergenceToSignal>[] = [];
      if (!isInLearningMode()) {
        const geoAlerts = detectGeoConvergence(this.ctx.seenGeoAlerts);
        geoSignals = geoAlerts.map(geoConvergenceToSignal);
      }

      const keywordSpikeSignals = drainTrendingSignals();
      const allSignals = [...signals, ...geoSignals, ...keywordSpikeSignals];
      if (allSignals.length > 0) {
        addToSignalHistory(allSignals);
        if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(allSignals);
      }
    } catch (error) {
      console.error('[App] Correlation analysis failed:', error);
    }
  }

  async loadFirmsData(): Promise<void> {
    try {
      const fireResult = await fetchAllFires(1);
      if (fireResult.skipped) {
        this.ctx.panels['satellite-fires']?.showConfigError(t('panels.satelliteFires.noData'));
        this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
        return;
      }
      const { regions, totalCount } = fireResult;
      if (totalCount > 0) {
        const flat = flattenFires(regions);
        const stats = computeRegionStats(regions);
        const satelliteFires = flat.map(f => ({
          lat: f.location?.latitude ?? 0,
          lon: f.location?.longitude ?? 0,
          brightness: f.brightness,
          frp: f.frp,
          region: f.region,
          acq_date: new Date(f.detectedAt).toISOString().slice(0, 10),
        }));

        signalAggregator.ingestSatelliteFires(satelliteFires);
        ingestSatelliteFiresForCII(satelliteFires);
        this.refreshCiiAndBrief();

        this.ctx.map?.setFires(toMapFires(flat));

        (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update(stats, totalCount);

        dataFreshness.recordUpdate('firms', totalCount);
      } else {
        ingestSatelliteFiresForCII([]);
        this.refreshCiiAndBrief();
        (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update([], 0);
      }
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
    } catch (e) {
      console.warn('[App] FIRMS load failed:', e);
      this.callPanel('satellite-fires', 'showError');
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
      dataFreshness.recordError('firms', String(e));
    }
  }

  async loadPizzInt(): Promise<void> {
    try {
      const [status, tensions] = await Promise.all([
        fetchPizzIntStatus(),
        fetchGdeltTensions()
      ]);

      if (status.locationsMonitored === 0) {
        this.ctx.pizzintIndicator?.hide();
        this.ctx.statusPanel?.updateApi('PizzINT', { status: 'error' });
        dataFreshness.recordError('pizzint', 'No monitored locations returned');
        return;
      }

      this.ctx.pizzintIndicator?.show();
      this.ctx.pizzintIndicator?.updateStatus(status);
      this.ctx.pizzintIndicator?.updateTensions(tensions);
      this.ctx.statusPanel?.updateApi('PizzINT', { status: 'ok' });
      dataFreshness.recordUpdate('pizzint', Math.max(status.locationsMonitored, tensions.length));
    } catch (error) {
      console.error('[App] PizzINT load failed:', error);
      this.ctx.pizzintIndicator?.hide();
      this.ctx.statusPanel?.updateApi('PizzINT', { status: 'error' });
      dataFreshness.recordError('pizzint', String(error));
    }
  }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
      const enabled = this.ctx.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }

    if (!isAisConfigured()) {
      dataFreshness.setEnabled('ais', false);
    }
    if (isOutagesConfigured() === false) {
      dataFreshness.setEnabled('outages', false);
    }
  }

  private static readonly HAPPY_ITEMS_CACHE_KEY = 'happy-all-items';

  async hydrateHappyPanelsFromCache(): Promise<void> {
    try {
      type CachedItem = Omit<NewsItem, 'pubDate'> & { pubDate: number };
      const entry = await getPersistentCache<CachedItem[]>(DataLoaderManager.HAPPY_ITEMS_CACHE_KEY);
      if (!entry || !entry.data || entry.data.length === 0) return;
      if (Date.now() - entry.updatedAt > 24 * 60 * 60 * 1000) return;

      const items: NewsItem[] = entry.data.map(item => ({
        ...item,
        pubDate: new Date(item.pubDate),
      }));

      const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
      this.callPanel('breakthroughs', 'setItems',
        items.filter(item => scienceSources.includes(item.source) || item.happyCategory === 'science-health')
      );
      this.callPanel('spotlight', 'setHeroStory',
        items.filter(item => item.happyCategory === 'humanity-kindness')
          .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0]
      );
      this.callPanel('digest', 'setStories',
        [...items].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime()).slice(0, 5)
      );
      this.callPanel('positive-feed', 'renderPositiveNews', items);
    } catch (err) {
      console.warn('[App] Happy panel cache hydration failed:', err);
    }
  }

  private async loadHappySupplementaryAndRender(): Promise<void> {
    const curated = [...this.ctx.happyAllItems];
    this.callPanel('positive-feed', 'renderPositiveNews', curated);

    let supplementary: NewsItem[] = [];
    try {
      const gdeltTopics = await fetchAllPositiveTopicIntelligence();
      const gdeltItems: NewsItem[] = gdeltTopics.flatMap(topic =>
        topic.articles.map(article => ({
          source: 'GDELT',
          title: article.title,
          link: article.url,
          pubDate: article.date ? new Date(article.date) : new Date(),
          isAlert: false,
          imageUrl: article.image || undefined,
          happyCategory: classifyNewsItem('GDELT', article.title),
        }))
      );

      supplementary = await filterBySentiment(gdeltItems);
    } catch (err) {
      console.warn('[App] Happy supplementary pipeline failed, using curated only:', err);
    }

    if (supplementary.length > 0) {
      const merged = [...curated, ...supplementary];
      merged.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
      this.callPanel('positive-feed', 'renderPositiveNews', merged);
    }

    const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
    const scienceItems = this.ctx.happyAllItems.filter(item =>
      scienceSources.includes(item.source) || item.happyCategory === 'science-health'
    );
    this.callPanel('breakthroughs', 'setItems', scienceItems);

    const heroItem = this.ctx.happyAllItems
      .filter(item => item.happyCategory === 'humanity-kindness')
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0];
    this.callPanel('spotlight', 'setHeroStory', heroItem);

    const digestItems = [...this.ctx.happyAllItems]
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, 5);
    this.callPanel('digest', 'setStories', digestItems);

    setPersistentCache(
      DataLoaderManager.HAPPY_ITEMS_CACHE_KEY,
      this.ctx.happyAllItems.map(item => ({ ...item, pubDate: item.pubDate.getTime() }))
    ).catch(() => {});
  }

  private async loadPositiveEvents(): Promise<void> {
    const hydrated = getHydratedData('positiveGeoEvents') as { events?: Array<{ latitude: number; longitude: number; name: string; category: string; count: number; timestamp: number }> } | undefined;
    let gdeltEvents: PositiveGeoEvent[];
    if (hydrated?.events?.length) {
      gdeltEvents = hydrated.events.map(e => ({
        lat: e.latitude, lon: e.longitude, name: e.name,
        category: (e.category || 'humanity-kindness') as HappyContentCategory,
        count: e.count, timestamp: e.timestamp,
      }));
    } else {
      gdeltEvents = await fetchPositiveGeoEvents();
    }
    const rssEvents = geocodePositiveNewsItems(
      this.ctx.happyAllItems.map(item => ({
        title: item.title,
        category: item.happyCategory,
      }))
    );
    const seen = new Set<string>();
    const merged = [...gdeltEvents, ...rssEvents].filter(e => {
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      return true;
    });
    this.ctx.map?.setPositiveEvents(merged);
  }

  private loadKindnessData(): void {
    const kindnessItems = fetchKindnessData(
      this.ctx.happyAllItems.map(item => ({
        title: item.title,
        happyCategory: item.happyCategory,
      }))
    );
    this.ctx.map?.setKindnessData(kindnessItems);
  }

  private async loadProgressData(): Promise<void> {
    const datasets = await fetchProgressData();
    this.callPanel('progress', 'setData', datasets);
  }

  private async loadSpeciesData(): Promise<void> {
    const species = await fetchConservationWins();
    this.callPanel('species', 'setData', species);
    this.ctx.map?.setSpeciesRecoveryZones(species);
    if (SITE_VARIANT === 'happy' && species.length > 0) {
      checkMilestones({
        speciesRecoveries: species.map(s => ({ name: s.commonName, status: s.recoveryStatus })),
        newSpeciesCount: species.length,
      });
    }
  }

  private async loadRenewableData(): Promise<void> {
    const data = await fetchRenewableEnergyData();
    this.callPanel('renewable', 'setData', data);
    if (SITE_VARIANT === 'happy' && data?.globalPercentage) {
      checkMilestones({
        renewablePercent: data.globalPercentage,
      });
    }
    try {
      const capacity = await fetchEnergyCapacity();
      this.callPanel('renewable', 'setCapacityData', capacity);
    } catch {
      // EIA failure does not break the existing World Bank gauge
    }
  }

  async loadSecurityAdvisories(): Promise<void> {
    try {
      const result = await fetchSecurityAdvisories();
      if (result.ok) {
        this.callPanel('security-advisories', 'setData', result.advisories);
        this.ctx.intelligenceCache.advisories = result.advisories;
        ingestAdvisoriesForCII(result.advisories);
      }
    } catch (error) {
      console.error('[App] Security advisories fetch failed:', error);
      this.callPanel('security-advisories', 'showError');
    }
  }

  async loadSanctionsPressure(): Promise<void> {
    try {
      const result = await fetchSanctionsPressure();
      this.callPanel('sanctions-pressure', 'setData', result);
      this.ctx.intelligenceCache.sanctions = result;
      signalAggregator.ingestSanctionsPressure(result.countries);
      ingestSanctionsForCII(result.countries);
      if (result.totalCount > 0) {
        dataFreshness.recordUpdate('sanctions_pressure', result.totalCount);
        this.ctx.statusPanel?.updateApi('OFAC', { status: result.newEntryCount > 0 ? 'warning' : 'ok' });
      } else {
        this.ctx.statusPanel?.updateApi('OFAC', { status: 'error' });
      }
    } catch (error) {
      console.error('[App] Sanctions pressure fetch failed:', error);
      this.callPanel('sanctions-pressure', 'showError');
      dataFreshness.recordError('sanctions_pressure', String(error));
      this.ctx.statusPanel?.updateApi('OFAC', { status: 'error' });
    }
  }

  async loadResilienceRanking(): Promise<void> {
    if (!hasPremiumAccess() || !this.ctx.map?.isDeckGLActive?.()) {
      this.ctx.map?.setResilienceRanking([]);
      this.ctx.map?.setLayerReady('resilienceScore', false);
      return;
    }

    try {
      const result = await getResilienceRanking();
      this.ctx.map?.setResilienceRanking(result.items, result.greyedOut ?? []);
      const displayable = buildResilienceChoroplethMap(result.items, result.greyedOut ?? []);
      this.ctx.map?.setLayerReady('resilienceScore', displayable.size > 0);
    } catch (error) {
      console.error('[App] Resilience ranking fetch failed:', error);
      this.ctx.map?.setResilienceRanking([]);
      this.ctx.map?.setLayerReady('resilienceScore', false);
    }
  }

  async loadRadiationWatch(): Promise<void> {
    try {
      const result = await fetchRadiationWatch();
      const anomalies = result.observations.filter((observation) => observation.severity !== 'normal');
      this.callPanel('radiation-watch', 'setData', result);
      this.ctx.intelligenceCache.radiation = result;
      signalAggregator.ingestRadiationObservations(result.observations);
      this.ctx.map?.setRadiationObservations(anomalies);
      this.ctx.map?.setLayerReady('radiationWatch', anomalies.length > 0);
      if (result.observations.length > 0) {
        dataFreshness.recordUpdate('radiation', result.observations.length);
      }
    } catch (error) {
      console.error('[App] Radiation watch fetch failed:', error);
      this.callPanel('radiation-watch', 'showError');
      this.ctx.map?.setLayerReady('radiationWatch', false);
      dataFreshness.recordError('radiation', String(error));
    }
  }

  async loadTelegramIntel(): Promise<void> {
    if (isDesktopRuntime() && !hasPremiumAccess()) return;
    try {
      const result = await fetchTelegramFeed();
      this.callPanel('telegram-intel', 'setData', result);
    } catch (error) {
      console.error('[App] Telegram intel fetch failed:', error);
      this.callPanel('telegram-intel', 'setData', {
        source: 'telegram', enabled: false, count: 0, updatedAt: null, items: [],
      });
    }
  }

  async loadThermalEscalations(): Promise<void> {
    try {
      const result = await fetchThermalEscalations();
      this.ctx.intelligenceCache.thermalEscalation = result;
      this.callPanel('thermal-escalation', 'setData', result);
      dataFreshness.recordUpdate('thermal-escalation' as DataSourceId, result.clusters.length);
    } catch (error) {
      console.error('[App] Thermal escalation fetch failed:', error);
      this.callPanel('thermal-escalation', 'showError');
    }
  }

  async loadCrossSourceSignals(): Promise<void> {
    try {
      const result = await fetchCrossSourceSignals();
      this.callPanel('cross-source-signals', 'setData', result);
      dataFreshness.recordUpdate('cross-source-signals' as DataSourceId, result.signals?.length ?? 0);
    } catch (error) {
      console.error('[App] Cross-source signals fetch failed:', error);
      this.callPanel('cross-source-signals', 'showFetchError');
    }
  }
}
