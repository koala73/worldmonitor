import type { AppContext, AppModule } from '@/app/app-context';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { enqueuePanelCall } from '@/app/pending-panel-data';
import { markLcpDebug } from '@/utils/lcp-debug';
import { runHydrationTier, type HydrationTask } from '@/app/hydration-scheduler';
import { yieldToMain } from '@/utils/after-paint';
import { getSignalAggregator, type SignalAggregator } from '@/app/lazy-services';
import { getMilitaryVesselsModule, isVesselRuntimeStoppedError } from '@/services/military-vessels-lazy';
import type { NewsItem, MapLayers, SocialUnrestEvent, MilitaryFlight } from '@/types';
import type { MarketData } from '@/types';
import type { TimeRange } from '@/components/MapContainer';
import {
  FEEDS,
  CANONICAL_FEEDS,
  INTEL_SOURCES,
  SECTORS,
  COMMODITIES,
  MARKET_SYMBOLS,
  STOCK_CATALOG,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
  STORAGE_KEYS,
  isPanelInVariantDefaults,
} from '@/config';
import { resolveNewsCategories, enabledNewsCategoryKeys, type ResolvedCategory } from '@/config/feed-resolution';
import {
  countRepresentedSources,
  mergeRotatedNewsItems,
  nextRotationCycle,
  selectRotatingFeedWindow,
} from '@/app/news-feed-rotation';
import {
  runNewsLoadPass,
  newsWorkListSignature,
  type NewsCategoryLoadOptions,
  type NewsIntelLoadOptions,
} from '@/app/news-loader-sequencing';
import {
  countDigestCategories,
  DigestPersistenceQueue,
  digestCacheKey,
  getScopedDigest,
  retainRicherScopedDigest,
  type ScopedDigest,
} from '@/app/news-digest-acceptance';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { withTimeout } from '@/utils/with-timeout';
import {
  fetchPredictions,
  fetchEarthquakes,
  fetchWeatherAlerts,
  fetchCanadaRoads,
  CANADA_ROAD_FRESHNESS_IDS,
  getCanadaRoadSourceStates,
  fetchCanadaAlerts,
  fetchInternetOutages,
  fetchTrafficAnomalies,
  fetchDdosAttacks,
  isOutagesConfigured,
  fetchAisSignals,
  getAisStatus,
  isAisConfigured,
  fetchCableHealth,
  fetchProtestEvents,
  getProtestStatus,
  fetchMilitaryFlights,
  fetchUSNIFleetReport,
  updateBaseline,
  calculateDeviation,
  addToSignalHistory,
  analysisWorker,
  fetchPizzIntStatus,
  fetchGdeltTensions,
  fetchNaturalEvents,
  fetchRecentAwards,
  fetchSanctionsPressure,
  fetchRadiationWatch,
} from '@/services';
import {
  getCatalogSelection,
  getMarketWatchlistEntries,
  resolveEffectiveMarketWatchlist,
} from '@/services/market-watchlist';
import { fetchStockAnalysesForTargets, getStockAnalysisTargets, type StockAnalysisResult } from '@/services/stock-analysis';
import { fetchInsiderTransactions } from '@/services/insider-transactions';
import { selectCompleteHydratedMarketQuotes } from '@/services/market-hydration';
import { transitionCiiAvailability } from '@/services/cii-availability';
import {
  resolveSectorHeatmapAvailability,
  resolveStockMarketAvailability,
} from '@/services/market-availability';
import { LatestRequestGuard } from '@/utils/latest-request-guard';
import {
  fetchStockBacktestsForTargets,
  fetchStoredStockBacktests,
  getMissingOrStaleStoredStockBacktests,
  hasFreshStoredStockBacktests,
  type StockBacktestResult,
} from '@/services/stock-backtest';
import {
  fetchStockAnalysisHistory,
  getMissingOrStaleStockAnalysisSymbols,
  hasFreshStockAnalysisHistory,
  getLatestStockAnalysisSnapshots,
  mergeStockAnalysisHistory,
  type StockAnalysisHistory,
} from '@/services/stock-analysis-history';
import { checkBatchForBreakingAlerts, dispatchOrefBreakingAlert } from '@/services/breaking-news-alerts';
import { displayPubDateMs, effectivePubDateMs } from '@/services/feed-date';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { ingestProtests, ingestFlights, ingestVessels, ingestEarthquakes, detectGeoConvergence, geoConvergenceToSignal } from '@/services/geo-convergence';
import { updateAndCheck, consumeServerAnomalies, fetchLiveAnomalies } from '@/services/temporal-baseline';
import { fetchAllFires, flattenFires, computeRegionStats, toMapFires } from '@/services/wildfires';
import type { TheaterPostureSummary } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { ingestConflictsForCountryData, ingestDisplacementForCountryData, ingestClimateForCountryData, ingestGpsJammingForCountryData, isInLearningMode, type CountryScore } from '@/services/country-instability';
import { fetchGpsInterference } from '@/services/gps-interference';
import { fetchSatelliteTLEs, initSatRecs, propagatePositions, startPropagationLoop } from '@/services/satellites';
import type { SatRecEntry } from '@/services/satellites';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import type { CorrelationSignal } from '@/services/correlation';
import { fetchConflictEvents, fetchUcdpEvents, deduplicateAgainstAcled, deduplicateUcdpProjectionAggregates, fetchIranEvents } from '@/services/conflict';
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
import { debounce, getCircuitBreakerCooldownInfo, loadFromStorage, saveToStorage } from '@/utils';
import { isFeatureAvailable, isFeatureEnabled } from '@/services/runtime-config';
import { hasPremiumAccess } from '@/services/panel-gating';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';
import { filterFeedsByLanguage } from '@/services/feed-language';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { getHydratedData } from '@/services/bootstrap';
import { publicRpcFetch } from '@/services/public-rpc-fetch';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { GetSectorSummaryResponse, ListMarketQuotesResponse, ListCommodityQuotesResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import type {
  AiTokensPanel,
  CommoditiesPanel,
  CryptoHeatmapPanel,
  CryptoPanel,
  DefiTokensPanel,
  HeatmapPanel,
  MarketPanel,
  OtherTokensPanel,
  SectorValuation,
} from '@/components/MarketPanel';
import type { ChinaCorporateDisclosureSnapshot } from '@/components/market-disclosures';
import { mountCommunityWidget } from '@/components/CommunityWidget';

import type { StockAnalysisPanel } from '@/components/StockAnalysisPanel';
import type { StockBacktestPanel } from '@/components/StockBacktestPanel';
import type { PredictionPanel } from '@/components/PredictionPanel';
import type { InsightsPanel } from '@/components/InsightsPanel';
import type { InternetDisruptionsPanel } from '@/components/InternetDisruptionsPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { EconomicPanel } from '@/components/EconomicPanel';
import type { GlobalProcurementPanel } from '@/components/GlobalProcurementPanel';
import type { GlobalTenderFilters } from '@/services/global-tenders';
import type { EnergyComplexPanel } from '@/components/EnergyComplexPanel';
import type { TechReadinessPanel } from '@/components/TechReadinessPanel';
import type { UcdpEventsPanel } from '@/components/UcdpEventsPanel';
import type { TradePolicyPanel } from '@/components/TradePolicyPanel';
import type { SupplyChainPanel } from '@/components/SupplyChainPanel';
import type { ChinaCorridorPanel } from '@/components/ChinaCorridorPanel';
import type { ChinaActivityNowcastPanel } from '@/components/ChinaActivityNowcastPanel';
import type { DiseaseOutbreaksPanel } from '@/components/DiseaseOutbreaksPanel';
import type { SocialVelocityPanel } from '@/components/SocialVelocityPanel';
import type { WsbTickerScannerPanel } from '@/components/WsbTickerScannerPanel';
import type { AAIISentimentPanel } from '@/components/AAIISentimentPanel';
import type { MarketBreadthPanel } from '@/components/MarketBreadthPanel';
import type { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import { classifyNewsItem } from '@/services/positive-classifier';
import { fetchGivingSummary } from '@/services/giving';
import { fetchProgressData } from '@/services/progress-data';
import { fetchConservationWins } from '@/services/conservation-data';
// #4571: renewable-energy-data (+ its transitive economic edge) dynamic-imported
// inside loadRenewableData so it doesn't parse/execute at boot — the renewable
// panel is below-fold and its load is viewport-gated (shouldLoad('renewable')).
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
import type {
  RegimeMacroContext,
  YieldCurveContext,
  SectorBriefContext,
} from '@/services/daily-market-brief';
import { fetchCachedRiskScores, getCachedScores, toCountryScore, type CachedRiskScores } from '@/services/cached-risk-scores';
import type { ThreatLevel as ClientThreatLevel } from '@/types';
import type { NewsItem as ProtoNewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';
import { fetchMarketImplications } from '@/services/market-implications';
import { fetchDiseaseOutbreaks } from '@/services/disease-outbreaks';
import { fetchSocialVelocity } from '@/services/social-velocity';
import {
  hydrateGeoHubPanelFromClusters,
  hydrateTechHubPanelFromClusters,
} from '@/app/hub-activity-hydration';
// Tech activity remains lazy-imported by hub-activity-hydration so the
// tech-activity → tech-hub-index → ~62KB tech-geo chain stays off the eager
// dashboard critical path (#4404).
import type { GeoHubsPanel } from '@/components/GeoHubsPanel';
import type { TechHubsPanel } from '@/components/TechHubsPanel';
import { ResearchServiceClient } from '@/services/generated-rpc-clients';

// The proto-level -> label map lives in shared/news-clustering-core.js so the
// client digest loader and the server-side MCP tools cannot drift (#5697).
import { protoThreatLevelToLabel } from '../../shared/news-clustering-core.js';

const PROTO_TO_CLIENT_PHASE: Record<string, import('@/types').StoryPhase> = {
  STORY_PHASE_BREAKING:   'breaking',
  STORY_PHASE_DEVELOPING: 'developing',
  STORY_PHASE_SUSTAINED:  'sustained',
  STORY_PHASE_FADING:     'fading',
};

function protoItemToNewsItem(p: ProtoNewsItem): NewsItem {
  const level: ClientThreatLevel = protoThreatLevelToLabel(p.threat?.level);
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    importanceScore: p.importanceScore || undefined,
    credibilityScore: Number.isFinite(p.credibilityScore) ? p.credibilityScore : undefined,
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
    ...(Number.isFinite(p.credibilityScore) ? { credibilityScore: p.credibilityScore } : {}),
    ...(p.corroborationCount ? { corroborationCount: p.corroborationCount } : {}),
    // Cleaned RSS description (U3 proto field 12). Only populated when the
    // upstream feed carried a usable <description>/<content:encoded>/<summary>;
    // empty string otherwise. Consumers render the headline and fall back to
    // snippet as a secondary line when non-empty.
    ...(p.snippet ? { snippet: p.snippet } : {}),
    // Ingest-extracted tickers (#4922a, proto field 13). Runtime guard on
    // top of the generated type: persisted last-good digests from before
    // the rollout carry items without the field.
    ...(p.tickers && p.tickers.length ? { tickers: p.tickers } : {}),
  };
}

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';
// Iran-events domain sunset (war ended 2026-07). Default OFF: no fetch, even the
// CII/risk-scoring path. Set VITE_ENABLE_IRAN_ATTACKS=true to restore. Mirrors CYBER_LAYER_ENABLED.
const IRAN_ATTACKS_ENABLED = import.meta.env.VITE_ENABLE_IRAN_ATTACKS === 'true';

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: TheaterPostureSummary[]) => void;
  refreshOpenCountryBrief: () => void;
}

type HydrationTier = 1 | 2 | 3 | 4;
type DailyMarketBriefModule = typeof import('@/services/daily-market-brief');
type RssModule = Pick<typeof import('@/services/rss'), 'fetchCategoryFeeds' | 'getFeedFailures'>;
type TrendingHeadlineInput = import('@/services/trending-keywords').TrendingHeadlineInput;
type DrainTrendingSignals = typeof import('@/services/trending-keywords').drainTrendingSignals;

let dailyMarketBriefModulePromise: Promise<DailyMarketBriefModule> | null = null;
let rssModulePromise: Promise<RssModule> | null = null;
let ingestHeadlinesPromise: Promise<(headlines: TrendingHeadlineInput[]) => void> | null = null;
let drainTrendingSignalsPromise: Promise<DrainTrendingSignals> | null = null;

function getDailyMarketBriefModule(): Promise<DailyMarketBriefModule> {
  dailyMarketBriefModulePromise ??= import('@/services/daily-market-brief').catch((err) => {
    dailyMarketBriefModulePromise = null;
    throw err;
  });
  return dailyMarketBriefModulePromise;
}

function getRssModule(): Promise<RssModule> {
  rssModulePromise ??= import('@/services/rss').catch((err) => {
    rssModulePromise = null;
    throw err;
  });
  return rssModulePromise;
}

async function ingestTrendingHeadlines(headlines: TrendingHeadlineInput[]): Promise<void> {
  ingestHeadlinesPromise ??= import('@/services/trending-keywords')
    .then(module => module.ingestHeadlines)
    .catch((err) => {
      ingestHeadlinesPromise = null;
      throw err;
    });
  const ingestHeadlines = await ingestHeadlinesPromise;
  ingestHeadlines(headlines);
}

async function drainTrendingSignalQueue(): Promise<ReturnType<DrainTrendingSignals>> {
  try {
    drainTrendingSignalsPromise ??= import('@/services/trending-keywords')
      .then(module => module.drainTrendingSignals)
      .catch((err) => {
        drainTrendingSignalsPromise = null;
        throw err;
      });
    const drainTrendingSignals = await drainTrendingSignalsPromise;
    return drainTrendingSignals();
  } catch (err) {
    console.warn('[News] drainTrendingSignals failed (chunk load?):', err);
    return [];
  }
}

async function runSignalAggregator(
  statusPanel: AppContext['statusPanel'] | undefined,
  context: string,
  ingest: (aggregator: SignalAggregator) => void,
): Promise<void> {
  try {
    ingest(await getSignalAggregator());
    statusPanel?.updateApi('Signal Aggregator', { status: 'ok', errorMessage: undefined });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[SignalAggregator] ${context} skipped:`, err);
    statusPanel?.updateApi('Signal Aggregator', {
      status: 'error',
      errorMessage: `${context}: ${errorMessage}`,
    });
  }
}

const HYDRATION_TIER_ONE = new Set(['news', 'markets', 'intelligence']);
const HYDRATION_TIER_TWO = new Set([
  'natural',
  'firms',
  'weather',
  'ais',
  'flights',
  'cyberThreats',
  'iranAttacks',
  'techEvents',
  'satellites',
  'webcams',
  'cables',
  'cableHealth',
  'diseaseOutbreaks',
  'socialVelocity',
  'economicStress',
  'sanctions',
  'resilienceRanking',
  'radiation',
]);
const HYDRATION_TIER_FOUR = new Set([
  'stockAnalysis',
  'stockBacktest',
  'dailyMarketBrief',
  'predictions',
  'forecasts',
  'simulation-outcome',
  'pizzint',
  'marketImplications',
  'wsbTickers',
  'techReadiness',
  'thermalEscalation',
  'crossSourceSignals',
]);
const HYDRATION_TIERS: HydrationTier[] = [1, 2, 3, 4];

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

  private panelHasRetainedData(key: string): boolean {
    const panel = this.ctx.panels[key] as { hasData?: () => boolean } | undefined;
    return typeof panel?.hasData === 'function' && panel.hasData();
  }

  private showColdLoadError(key: string): void {
    if (this.panelHasRetainedData(key)) return;
    this.callPanel(key, 'showError');
  }

  private boundMarketWatchlistHandler: (() => void) | null = null;
  private satellitePropagationCleanup: (() => void) | null = null;
  private dailyBriefGeneration = 0;
  private _stockAnalysisGeneration = 0;
  private readonly marketLoadGuard = new LatestRequestGuard();
  private globalTenderGeneration = 0;
  private globalTenderFilters: GlobalTenderFilters = {};
  private activeGlobalTenderScopedGeneration: number | null = null;
  private dailyBriefFrameworkUnsubscribe: (() => void) | null = null;
  private marketImplicationsFrameworkUnsubscribe: (() => void) | null = null;
  private cachedSatRecs: SatRecEntry[] | null = null;
  private loadAllDataPromise: Promise<void> | null = null;
  private loadAllDataRerunRequested = false;
  private loadAllDataQueuedForceAll = false;

  private digestBreaker = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, cooldownUntil: 0 };
  private readonly digestRequestTimeoutMs = 8000;
  private readonly digestFirstPaintGraceMs = 1500;
  private readonly digestBreakerCooldownMs = 5 * 60 * 1000;
  private readonly persistedDigestMaxAgeMs = 6 * 60 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackIntelFeedLimit = 6;
  private readonly perFeedFallbackBatchSize = 2;
  /**
   * Ceiling on a custom category's ACCUMULATED item set (#5873).
   *
   * A custom category rotates through its sources `perFeedFallbackCategoryFeedLimit`
   * at a time and merges each cycle into what the panel already shows, so unlike
   * every other path its item set is not one snapshot. 40 is twice the server
   * digest's `MAX_ITEMS_PER_CATEGORY` (20) — enough headroom for a full rotation
   * lap of a ten-source category to stay represented at once, while keeping the
   * panel, `ctx.allNews` and the clustering input the same order of magnitude as
   * a digest-backed category.
   */
  private readonly customCategoryMergedItemLimit = 40;
  /**
   * Reachable source count for custom categories.
   *
   * Coverage is derived when the category is rendered, after the active time
   * range has filtered its items. Keeping only the denominator here prevents a
   * stale pre-filter count from surviving time-range changes.
   */
  private readonly customNewsSourceTotals = new Map<string, number>();
  private lastGoodDigest: ScopedDigest<ListFeedDigestResponse> | null = null;
  private readonly digestPersistenceQueue = new DigestPersistenceQueue<ListFeedDigestResponse>({
    cacheMaxAgeMs: this.persistedDigestMaxAgeMs,
    read: (key) => getPersistentCache<ListFeedDigestResponse>(key),
    write: (key, data) => setPersistentCache(key, data),
    onSkipPersist: (fetchedCategoryCount, cachedCategoryCount) => {
      console.warn(
        `[News] Digest covers ${fetchedCategoryCount} categories, fewer than the ` +
        `${cachedCategoryCount} already cached — keeping the cached last-good digest`,
      );
    },
  });
  /**
   * Work-list signature of the last news load that actually landed data, or
   * `null` if none has. Gates loadAllData()'s `news` task — see
   * `shouldHydrateNews`. Left unset when a load throws or comes back empty with
   * no usable digest, so a failed load stays retryable.
   */
  private loadedNewsSignature: string | null = null;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  private getHydrationTier(name: string): HydrationTier {
    if (HYDRATION_TIER_ONE.has(name)) return 1;
    if (HYDRATION_TIER_TWO.has(name)) return 2;
    if (HYDRATION_TIER_FOUR.has(name)) return 4;
    return 3;
  }

  private markHydration(label: string): void {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
    performance.mark(label);
  }

  private async runHydrationTasks(tasks: HydrationTask[], forceAll: boolean): Promise<void> {
    const prioritized = tasks
      .map((task, order) => ({ ...task, order, tier: this.getHydrationTier(task.name) }))
      .sort((a, b) => a.tier - b.tier || a.order - b.order);

    // On the mobile profile, starting several panel loaders in the same task
    // lets their dynamic-import evaluation and synchronous render work merge
    // into one long task. Keep desktop concurrency, but give the browser a
    // scheduling boundary between every mobile panel in a tier. (#5165)
    const maxConcurrency = this.ctx.isMobile ? 1 : (forceAll ? 6 : 3);
    const failures: Array<{ name: string; reason: unknown }> = [];
    this.markHydration(`wm:hydration:${forceAll ? 'force' : 'viewport'}:start`);

    for (const tier of HYDRATION_TIERS) {
      const tierTasks = prioritized.filter(task => task.tier === tier);
      if (tierTasks.length === 0) continue;

      this.markHydration(`wm:hydration:tier-${tier}:start`);
      await runHydrationTier({
        tasks: tierTasks,
        maxConcurrency,
        yieldToMain,
        onFailure: (name, reason) => failures.push({ name, reason }),
      });
      this.markHydration(`wm:hydration:tier-${tier}:end`);
      if (tier < 4 && prioritized.some(task => task.tier > tier)) await yieldToMain();
    }

    this.markHydration(`wm:hydration:${forceAll ? 'force' : 'viewport'}:end`);
    failures.forEach(({ name, reason }) => {
      console.error(`[App] ${name} load failed:`, reason);
    });
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
    this.globalTenderGeneration += 1;
    this.activeGlobalTenderScopedGeneration = null;
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

  private getAuthoritativeCachedRiskScores(): CachedRiskScores | null {
    const cached = getCachedScores();
    return cached?.cii.length ? cached : null;
  }

  private appliedCiiState: CachedRiskScores | null | undefined;

  private applyCiiScoresToMap(scores: CountryScore[]): void {
    this.ctx.map?.setCIIScores(scores.map(s => ({ code: s.code, score: s.score, level: s.level })));
    this.ctx.map?.setLayerReady('ciiChoropleth', scores.length > 0);
  }

  private refreshCiiAndBrief(): void {
    const cached = this.getAuthoritativeCachedRiskScores();
    const transition = transitionCiiAvailability(this.appliedCiiState, cached);
    this.appliedCiiState = transition.nextState;

    if (transition.render === 'cached' && cached) {
      this.callPanel('cii', 'renderFromCached', cached);
      this.applyCiiScoresToMap(cached.cii.map(toCountryScore));
    } else if (transition.render === 'unavailable') {
      this.callPanel('cii', 'renderUnavailable');
      this.applyCiiScoresToMap([]);
    }

    if (transition.refreshBrief) this.callbacks.refreshOpenCountryBrief();
  }

  public refreshGeometryDependentCountryData(): void {
    markLcpDebug('wm:data:country-geometry-replay-start');
    const cache = this.ctx.intelligenceCache;
    // GPS rows have no country hint, so replay them after precision geometry
    // becomes available for the country-detail jamming count.
    if (cache.gpsJamming?.length) {
      ingestGpsJammingForCountryData(cache.gpsJamming);
    }

    markLcpDebug('wm:data:country-geometry-replay-ready', { replayed: cache.gpsJamming?.length ? 1 : 0 });
  }

  private async tryFetchDigest(): Promise<ListFeedDigestResponse | null> {
    const now = Date.now();
    // Capture request and persistence scope together. Sampling the language again
    // after the response would let an old-language request populate the new
    // language's cache when the user switches languages in flight.
    const requestLanguage = getCurrentLanguage();
    const requestKey = this.digestCacheKey(requestLanguage);

    if (this.digestBreaker.state === 'open') {
      if (now < this.digestBreaker.cooldownUntil) {
        return this.getRetainedDigest(requestKey) ?? await this.loadPersistedDigest(requestKey);
      }
      this.digestBreaker.state = 'half-open';
    }

    try {
      markLcpDebug('wm:data:feed-digest-start');
      const resp = await publicRpcFetch(
        toApiUrl(`/api/news/v1/list-feed-digest?variant=${SITE_VARIANT}&lang=${requestLanguage}`),
        { signal: AbortSignal.timeout(this.digestRequestTimeoutMs) },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as ListFeedDigestResponse;
      const catCount = countDigestCategories(data);
      // A 200 carrying no categories is an outage wearing a success status: every
      // preset category renders empty behind it, because per-feed fallback is off
      // on web. Throwing routes it into the catch below, which is the whole point
      // — the breaker counts it, `lastGoodDigest` keeps the real digest it had, and
      // `digest:last-good` is left alone instead of being poisoned for 6 hours with
      // the empty body the fallback exists to survive (#5877).
      if (catCount === 0) throw new Error('digest returned 0 categories');
      markLcpDebug('wm:data:feed-digest-ready', { categories: catCount });
      console.info(`[News] Digest fetched: ${catCount} categories`);
      this.persistDigest(requestKey, data);
      this.digestBreaker = { state: 'closed', failures: 0, cooldownUntil: 0 };

      const currentKey = this.digestCacheKey();
      if (currentKey !== requestKey) {
        // The response is valid for the scope it requested and may refresh that
        // scope's persistent cache, but it must not become live data or an
        // in-memory fallback for the language now active.
        return this.getRetainedDigest(currentKey) ?? await this.loadPersistedDigest(currentKey);
      }
      this.lastGoodDigest = retainRicherScopedDigest(this.lastGoodDigest, requestKey, data);
      return data;
    } catch (e) {
      markLcpDebug('wm:data:feed-digest-error');
      console.warn('[News] Digest fetch failed, using fallback:', e);
      this.digestBreaker.failures++;
      if (this.digestBreaker.failures >= 2) {
        this.digestBreaker.state = 'open';
        this.digestBreaker.cooldownUntil = now + this.digestBreakerCooldownMs;
      }
      const currentKey = this.digestCacheKey();
      return this.getRetainedDigest(currentKey) ?? await this.loadPersistedDigest(currentKey);
    }
  }

  /**
   * Write the fresh digest to `digest:last-good`, unless that would shrink it.
   *
   * A PARTIAL digest is the second degraded shape (#5877): a 200 that covers
   * some categories but fewer than the entry already cached. The response is
   * real data, so the caller uses it for this load — but overwriting a richer
   * `digest:last-good` with it is a strict loss for the NEXT page load, which is
   * the one that falls back to this entry when the digest is unreachable.
   *
   * Deliberately fire-and-forget and off the fetch path: the comparison needs a
   * persistent-cache READ, and `tryFetchDigest` sits on the news first-paint
   * path, so awaiting an IndexedDB round trip there would buy correctness for
   * the fallback at the cost of the load it is protecting. A read failure is
   * treated as "nothing cached" and the write proceeds — the previous behaviour.
   */
  private persistDigest(key: string, data: ListFeedDigestResponse): void {
    this.digestPersistenceQueue.enqueue(key, data);
  }

  /**
   * Cache key for the last-good digest, scoped exactly like the request that
   * produced it.
   *
   * The digest is fetched per `variant` and `lang`, but the entry used to be
   * stored under one global key — so a variant or language switch compared, and
   * fell back to, a digest built for a different category set entirely. That was
   * survivable while every successful fetch overwrote the entry unconditionally;
   * it is not survivable now that coverage decides whether to overwrite, because
   * a wider digest from the OTHER variant would veto persisting the current
   * one's for up to 6 hours (#5877).
   *
   * Scoping also retires every entry written under the old key, which is the
   * migration path for a cache already poisoned by a degraded digest: those
   * entries simply become unreachable rather than needing to be detected.
   */
  private digestCacheKey(language = getCurrentLanguage()): string {
    return digestCacheKey(SITE_VARIANT, language);
  }

  private getRetainedDigest(key = this.digestCacheKey()): ListFeedDigestResponse | null {
    return getScopedDigest(this.lastGoodDigest, key);
  }

  private async loadPersistedDigest(key = this.digestCacheKey()): Promise<ListFeedDigestResponse | null> {
    try {
      const envelope = await getPersistentCache<ListFeedDigestResponse>(key);
      if (!envelope) return null;
      if (Date.now() - envelope.updatedAt > this.persistedDigestMaxAgeMs) return null;
      // Do not let an IndexedDB read started for a previous language complete
      // into the new language's in-memory fallback.
      if (key !== this.digestCacheKey()) return null;
      this.lastGoodDigest = retainRicherScopedDigest(this.lastGoodDigest, key, envelope.data);
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
    return [...staleItems].sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a));
  }

  private selectLimitedFeeds<T>(feeds: T[], maxFeeds: number): T[] {
    if (feeds.length <= maxFeeds) return feeds;
    return feeds.slice(0, maxFeeds);
  }

  /**
   * Rotation cycle of a custom category's capped per-feed window, persisted so
   * it survives a reload (#5873).
   *
   * In-memory-only state would restart every custom category at window 0 on
   * every page load, which for the common short session is indistinguishable
   * from the fixed prefix this replaced: sources 4..N would still never be
   * fetched. Reads are defensive — a hand-edited or older-schema value must not
   * reach `selectRotatingFeedWindow` as a NaN start.
   */
  private readNewsRotationCycles(): Record<string, number> {
    const stored = loadFromStorage<Record<string, number>>(STORAGE_KEYS.newsFeedRotation, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  private newsRotationCycle(category: string): number {
    const cycle = this.readNewsRotationCycles()[category];
    return typeof cycle === 'number' && Number.isFinite(cycle) && cycle >= 0 ? Math.trunc(cycle) : 0;
  }

  /**
   * Advance and persist a custom category's rotation cycle.
   *
   * Written AFTER the window for this cycle has been selected, and pruned to
   * the custom categories still in the work-list so a panel the user has since
   * removed can't leave its entry behind forever.
   */
  private advanceNewsRotationCycle(category: string, feedCount: number): void {
    const keep = new Set(
      this.resolveEnabledNewsCategories()
        .filter(({ isCustom }) => isCustom)
        .map(({ key }) => key),
    );
    keep.add(category);

    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.readNewsRotationCycles())) {
      if (keep.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        next[key] = Math.trunc(value);
      }
    }
    next[category] = nextRotationCycle(this.newsRotationCycle(category), feedCount);
    saveToStorage(STORAGE_KEYS.newsFeedRotation, next);
  }

  private shouldShowIntelligenceNotifications(): boolean {
    return !this.ctx.isMobile && !!this.ctx.findingsBadge?.isPopupEnabled();
  }

  private showSignalNotification(signals: CorrelationSignal[], context: string): void {
    void this.ctx.ensureSignalModal()
      .then((signalModal) => {
        if (!this.ctx.isDestroyed) signalModal.show(signals);
      })
      .catch((err) => {
        console.warn(`[SignalModal] ${context} notification skipped:`, err);
      });
  }

  private isPanelNearViewport(panelId: string, marginPx = 400): boolean {
    const panel = this.ctx.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = 400): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
  }

  async loadAllData(forceAll = false): Promise<void> {
    if (this.loadAllDataPromise) {
      this.loadAllDataRerunRequested = true;
      this.loadAllDataQueuedForceAll = this.loadAllDataQueuedForceAll || forceAll;
      return this.loadAllDataPromise;
    }

    this.loadAllDataRerunRequested = true;
    this.loadAllDataQueuedForceAll = forceAll;
    this.loadAllDataPromise = this.drainLoadAllDataQueue();
    return this.loadAllDataPromise;
  }

  private async drainLoadAllDataQueue(): Promise<void> {
    try {
      while (this.loadAllDataRerunRequested && !this.ctx.isDestroyed) {
        const forceAll = this.loadAllDataQueuedForceAll;
        this.loadAllDataRerunRequested = false;
        this.loadAllDataQueuedForceAll = false;
        await this.runLoadAllData(forceAll);
      }
    } finally {
      this.loadAllDataPromise = null;
      this.loadAllDataRerunRequested = false;
      this.loadAllDataQueuedForceAll = false;
    }
  }

  private async runLoadAllData(forceAll: boolean): Promise<void> {
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

    const tasks: HydrationTask[] = [];
    if (this.shouldHydrateNews(forceAll)) {
      tasks.push({ name: 'news', task: () => runGuarded('news', () => this.loadNews()) });
    }

    // Happy variant only loads news data -- skip all geopolitical/financial/military data
    if (SITE_VARIANT !== 'happy') {
      if (shouldLoadAny(['markets', 'heatmap', 'commodities', 'crypto', 'energy-complex', 'crypto-heatmap', 'defi-tokens', 'ai-tokens', 'other-tokens'])) {
        tasks.push({ name: 'markets', task: () => runGuarded('markets', () => this.loadMarkets()) });
      }
      if (hasPremiumAccess() && shouldLoad('stock-analysis')) {
        tasks.push({ name: 'stockAnalysis', task: () => runGuarded('stockAnalysis', () => this.loadStockAnalysis()) });
      }
      if (hasPremiumAccess() && shouldLoad('stock-backtest')) {
        tasks.push({ name: 'stockBacktest', task: () => runGuarded('stockBacktest', () => this.loadStockBacktest()) });
      }
      // The daily market brief is loaded by the post-hydration pass below
      // (search for `loadDailyMarketBrief()`), which calls it directly.
      // loadDailyMarketBrief already self-guards on the shared inFlight set, so
      // an earlier hydration task that re-locked the same key here always
      // returned immediately — a guaranteed no-op. Removed (#6770); the direct
      // post-pass call is the single source of truth.
      if (shouldLoad('polymarket')) {
        tasks.push({ name: 'predictions', task: () => runGuarded('predictions', () => this.loadPredictions()) });
      }
      if (shouldLoad('forecast')) {
        tasks.push({ name: 'forecasts', task: () => runGuarded('forecasts', () => this.loadForecasts()) });
        tasks.push({ name: 'simulation-outcome', task: () => runGuarded('simulation-outcome', () => this.loadSimulationOutcome()) });
      }
      if (SITE_VARIANT === 'full') tasks.push({ name: 'pizzint', task: () => runGuarded('pizzint', () => this.loadPizzInt()) });
      if (shouldLoad('economic')) {
        tasks.push({ name: 'fred', task: () => runGuarded('fred', () => this.loadFredData()) });
        tasks.push({ name: 'spending', task: () => runGuarded('spending', () => this.loadGovernmentSpending()) });
        tasks.push({ name: 'bis', task: () => runGuarded('bis', () => this.loadBisData()) });
        tasks.push({ name: 'bls', task: () => runGuarded('bls', () => this.loadBlsData()) });
      }
      if (hasPremiumAccess() && shouldLoad('global-procurement')) {
        tasks.push({ name: 'global-tenders', task: () => runGuarded('global-tenders', () => this.loadGlobalTenders()) });
      }
      if (shouldLoad('energy-complex')) {
        tasks.push({ name: 'oil', task: () => runGuarded('oil', () => this.loadOilAnalytics()) });
      }

      // Trade policy + supply-chain data (FULL, FINANCE, COMMODITY, ENERGY variants use supply-chain surface)
      if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance' || SITE_VARIANT === 'commodity' || SITE_VARIANT === 'energy') {
        if (shouldLoad('trade-policy')) {
          tasks.push({ name: 'tradePolicy', task: () => runGuarded('tradePolicy', () => this.loadTradePolicy()) });
        }
        if (shouldLoad('supply-chain')) {
          tasks.push({ name: 'supplyChain', task: () => runGuarded('supplyChain', () => this.loadSupplyChain()) });
        }
        if (shouldLoad('china-corridors')) {
          tasks.push({ name: 'chinaCorridors', task: () => runGuarded('chinaCorridors', () => this.loadChinaCorridors({ skipIfPopulated: true })) });
        }
        if (shouldLoad('china-activity-nowcast')) {
          tasks.push({ name: 'chinaActivityNowcast', task: () => runGuarded('chinaActivityNowcast', () => this.loadChinaActivityNowcast({ skipIfPopulated: true })) });
        }
      }
    }

    // Progress charts data (happy variant only)
    if (SITE_VARIANT === 'happy') {
      if (shouldLoad('progress')) {
        tasks.push({
          name: 'progress',
          task: () => runGuarded('progress', () => this.loadProgressData()),
        });
      }
      if (shouldLoad('species')) {
        tasks.push({
          name: 'species',
          task: () => runGuarded('species', () => this.loadSpeciesData()),
        });
      }
      tasks.push({
        name: 'happinessMap',
        task: () => runGuarded('happinessMap', async () => {
          const data = await fetchHappinessScores();
          this.ctx.map?.setHappinessScores(data);
        }),
      });
      tasks.push({
        name: 'renewableMap',
        task: () => runGuarded('renewableMap', async () => {
          const installations = await fetchRenewableInstallations();
          this.ctx.map?.setRenewableInstallations(installations);
        }),
      });
    }

    // Renewable panel is shared by happy and energy variants.
    if (shouldLoad('renewable')) {
      tasks.push({
        name: 'renewable',
        task: () => runGuarded('renewable', () => this.loadRenewableData()),
      });
    }

    if (shouldLoad('giving')) {
      tasks.push({
        name: 'giving',
        task: () => runGuarded('giving', async () => {
          const givingResult = await fetchGivingSummary();
          if (!givingResult.ok) {
            dataFreshness.recordError('giving', 'Giving data unavailable (retaining prior state)');
            this.showColdLoadError('giving');
            return;
          }
          const data = givingResult.data;
          this.callPanel('giving', 'setData', data);
          if (givingResult.state === 'cached-refresh-unavailable') {
            dataFreshness.recordError('giving', `Giving refresh unavailable (${givingResult.refreshFailure ?? 'unknown'})`);
          } else if (data.platforms.length > 0) {
            dataFreshness.recordUpdate('giving', data.platforms.length);
          }
        }),
      });
    }

    if (SITE_VARIANT === 'full') {
      try {
        const cached = await fetchCachedRiskScores().catch(() => null);
        if (cached && cached.cii.length > 0) {
          this.refreshCiiAndBrief();
        }
      } catch { /* non-fatal */ }
    }
    // Intelligence signals: run for any variant that shows these panels
    if (shouldLoadAny(['cii', 'strategic-risk', 'strategic-posture', 'climate', 'population-exposure', 'security-advisories', 'radiation-watch', 'displacement', 'ucdp-events', 'satellite-fires', 'oref-sirens'])) {
      tasks.push({ name: 'intelligence', task: () => runGuarded('intelligence', () => this.loadIntelligenceSignals()) });
    }

    if (SITE_VARIANT === 'full' && (shouldLoad('satellite-fires') || this.ctx.mapLayers.natural)) {
      // Lock under the map-layer key ('fires') so a hydration load and a
      // loadDataForLayer('fires') toggle one-flight each other instead of
      // double-fetching (loadFirmsData has no internal guard). `name` stays
      // 'firms' for hydration tiering (#6770).
      tasks.push({ name: 'firms', task: () => runGuarded('fires', () => this.loadFirmsData()) });
    }
    if (this.ctx.mapLayers.natural) tasks.push({ name: 'natural', task: () => runGuarded('natural', () => this.loadNatural()) });
    if (this.ctx.mapLayers.diseaseOutbreaks || shouldLoad('disease-outbreaks')) tasks.push({ name: 'diseaseOutbreaks', task: () => runGuarded('diseaseOutbreaks', () => this.loadDiseaseOutbreaks()) });
    if (shouldLoad('social-velocity')) tasks.push({ name: 'socialVelocity', task: () => runGuarded('socialVelocity', () => this.loadSocialVelocity()) });
    if (hasPremiumAccess() && shouldLoad('wsb-ticker-scanner')) tasks.push({ name: 'wsbTickers', task: () => runGuarded('wsbTickers', () => this.loadWsbTickers()) });
    if (shouldLoad('economic')) tasks.push({ name: 'economicStress', task: () => runGuarded('economicStress', () => this.loadEconomicStress()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.weather) tasks.push({ name: 'weather', task: () => runGuarded('weather', () => this.loadWeatherAlerts()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.canadaRoads) tasks.push({ name: 'canadaRoads', task: () => runGuarded('canadaRoads', () => this.loadCanadaRoads()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.canadaAlerts) tasks.push({ name: 'canadaAlerts', task: () => runGuarded('canadaAlerts', () => this.loadCanadaAlerts()) });
    if (SITE_VARIANT !== 'happy' && !isDesktopRuntime() && this.ctx.mapLayers.ais) tasks.push({ name: 'ais', task: () => runGuarded('ais', () => this.loadAisSignals()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.cables) tasks.push({ name: 'cables', task: () => runGuarded('cables', () => this.loadCableActivity()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.cables) tasks.push({ name: 'cableHealth', task: () => runGuarded('cableHealth', () => this.loadCableHealth()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.flights) tasks.push({ name: 'flights', task: () => runGuarded('flights', () => this.loadFlightDelays()) });
    if (SITE_VARIANT !== 'happy' && CYBER_LAYER_ENABLED && this.ctx.mapLayers.cyberThreats) tasks.push({ name: 'cyberThreats', task: () => runGuarded('cyberThreats', () => this.loadCyberThreats()) });
    if (IRAN_ATTACKS_ENABLED && SITE_VARIANT !== 'happy' && !isDesktopRuntime() && (this.ctx.mapLayers.iranAttacks || shouldLoadAny(['cii', 'strategic-risk', 'strategic-posture']))) tasks.push({ name: 'iranAttacks', task: () => runGuarded('iranAttacks', () => this.loadIranEvents()) });
    if (SITE_VARIANT !== 'happy' && (this.ctx.mapLayers.techEvents || SITE_VARIANT === 'tech')) tasks.push({ name: 'techEvents', task: () => runGuarded('techEvents', () => this.loadTechEvents()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.satellites && this.ctx.map?.isGlobeMode?.()) tasks.push({ name: 'satellites', task: () => runGuarded('satellites', () => this.loadSatellites()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.webcams) tasks.push({ name: 'webcams', task: () => runGuarded('webcams', () => this.loadWebcams()) });
    if (SITE_VARIANT !== 'happy' && (shouldLoad('sanctions-pressure') || this.ctx.mapLayers.sanctions)) {
      tasks.push({ name: 'sanctions', task: () => runGuarded('sanctions', () => this.loadSanctionsPressure()) });
    }
    if (this.ctx.mapLayers.resilienceScore) {
      if (hasPremiumAccess()) {
        tasks.push({ name: 'resilienceRanking', task: () => runGuarded('resilienceRanking', () => this.loadResilienceRanking()) });
      } else {
        this.ctx.map?.setResilienceRanking([]);
        this.ctx.map?.setLayerReady('resilienceScore', false);
      }
    }
    if (SITE_VARIANT !== 'happy' && (shouldLoad('radiation-watch') || this.ctx.mapLayers.radiationWatch)) {
      // Lock under the map-layer key ('radiationWatch') so a hydration load and
      // a loadDataForLayer('radiationWatch') toggle one-flight each other
      // (loadRadiationWatch has no internal guard). `name` stays 'radiation' for
      // hydration tiering (#6770).
      tasks.push({ name: 'radiation', task: () => runGuarded('radiationWatch', () => this.loadRadiationWatch()) });
    }

    // tech-readiness is only seeded on full + tech variants (api/bootstrap.js +
    // scripts/seed-wb-indicators.mjs); on commodity/finance/energy the 5s fetch
    // at services/economic/index.ts:694 just times out. shouldLoad() alone is
    // not enough — loadAllData(true) on boot (App.ts:1226) bypasses the viewport
    // check via forceAll. Gate on variant defaults so this only fires where the
    // seed actually exists.
    if (isPanelInVariantDefaults('tech-readiness') && shouldLoad('tech-readiness')) {
      tasks.push({ name: 'techReadiness', task: () => runGuarded('techReadiness', () => (this.ctx.panels['tech-readiness'] as TechReadinessPanel)?.refresh()) });
    }
    if (SITE_VARIANT !== 'happy' && shouldLoad('thermal-escalation')) {
      tasks.push({ name: 'thermalEscalation', task: () => runGuarded('thermalEscalation', () => this.loadThermalEscalations()) });
    }
    if (SITE_VARIANT !== 'happy' && shouldLoad('cross-source-signals')) {
      tasks.push({ name: 'crossSourceSignals', task: () => runGuarded('crossSourceSignals', () => this.loadCrossSourceSignals()) });
    }

    await this.runHydrationTasks(tasks, forceAll);

    this.updateSearchIndex();

    if (hasPremiumAccess()) {
      await Promise.allSettled([
        this.loadDailyMarketBrief(),
        this.loadMarketImplications(),
      ]);
    }

    const bootstrapTemporal = consumeServerAnomalies();
    if (bootstrapTemporal.anomalies.length > 0 || bootstrapTemporal.trackedTypes.length > 0) {
      await runSignalAggregator(this.ctx.statusPanel, 'bootstrap temporal anomalies', (aggregator) => aggregator.ingestTemporalAnomalies(bootstrapTemporal.anomalies, bootstrapTemporal.trackedTypes));
    } else {
      this.refreshTemporalBaseline().catch(() => {});
    }
  }

  async refreshTemporalBaseline(): Promise<void> {
    const { anomalies, trackedTypes } = await fetchLiveAnomalies();
    await runSignalAggregator(this.ctx.statusPanel, 'temporal baseline anomalies', (aggregator) => aggregator.ingestTemporalAnomalies(anomalies, trackedTypes));
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
        case 'canadaRoads':
          await this.loadCanadaRoads();
          break;
        case 'canadaAlerts':
          await this.loadCanadaAlerts();
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
    try {
      this.cachedSatRecs = await initSatRecs(data);
    } catch (err) {
      console.error('[satellites] failed to initialize satellite propagation', err);
      this.cachedSatRecs = [];
      this.ctx.map?.setSatellites([]);
      return;
    }
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
      // effectivePubDateMs returns 0 for items that cannot claim a real
      // freshness rank: pubDateMissing items (the U3 contract) AND items
      // whose pubDate is NaN/Infinity/Invalid Date (the helper's value-
      // sanitization branch). All such items are EXCLUDED from positive-
      // window ranges. Previous behavior wrapped raw pubDate.getTime() in
      // Number.isFinite() and fell through to `true` on non-finite — that
      // included corrupt-stamp items in time-range views, arguably a bug.
      // The current shape treats untrustworthy timestamps uniformly: they
      // never claim freshness and never appear in a "last 24h" view.
      return effectivePubDateMs(item) >= cutoff;
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

  private newsPanelKey(category: string): string {
    return this.ctx.newsCategoryPanelKeys.get(category) ?? category;
  }

  private clearNewsSourceCoverage(category: string): void {
    this.customNewsSourceTotals.delete(category);
    this.callPanel(this.newsPanelKey(category), 'setSourceCoverage', null);
  }

  private setNewsRefreshDegraded(category: string, degraded: boolean): void {
    this.callPanel(this.newsPanelKey(category), 'setRefreshDegraded', degraded);
  }

  renderNewsForCategory(category: string, items: NewsItem[]): void {
    this.ctx.newsByCategory[category] = items;
    const filteredItems = this.filterItemsByTimeRange(items);
    const sourceTotal = this.customNewsSourceTotals.get(category);
    if (sourceTotal !== undefined) {
      this.callPanel(this.newsPanelKey(category), 'setSourceCoverage', {
        covered: countRepresentedSources(filteredItems),
        total: sourceTotal,
      });
    }

    const panel = this.ctx.newsPanels[category];
    if (!panel) return;
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

  // `isCustom` marks a category from a user-added panel that isn't in the
  // active variant's preset. The per-variant server digest never carries it, so
  // it skips the digest-availability gate and fetches directly client-side —
  // still capped by perFeedFallbackCategoryFeedLimit like any other per-feed
  // fallback, because nothing bounds how many custom categories a session has
  // (#5376). The cost is borne only by users who customize.
  //
  // That cap is a degraded-mode ceiling for a preset category but the STEADY
  // STATE for a custom one, so the two diverge in how they spend it (#5873):
  // a custom category rotates its window across cycles and merges each cycle
  // into what the panel already shows, and reports the resulting source
  // coverage on the panel badge. A preset category keeps the fixed prefix and
  // whole-set replace — it is digest-backed in the normal case, and its
  // fallback lasts only as long as the outage.
  private async loadNewsCategory(
    category: string,
    feeds: typeof FEEDS.politics,
    digest?: ListFeedDigestResponse | null,
    isCustom = false,
    options: NewsCategoryLoadOptions = { allowDigestPendingFallback: false, recordBaselineSample: true },
  ): Promise<NewsItem[]> {
    try {
      const panel = this.ctx.newsPanels[category];

      const enabledFeeds = (feeds ?? []).filter(f => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        this.clearNewsSourceCoverage(category);
        if (panel) {
          panel.showError(t('common.allSourcesDisabled'));
        }
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }
      const enabledNames = new Set(enabledFeeds.map(f => f.name));

      // The feeds a direct fetch would actually attempt. `fetchCategoryFeeds`
      // drops feeds whose declared `lang` isn't the current UI language, so for
      // a rotating custom category the enabled set is the wrong denominator on
      // both counts: `europe` declares 47 feeds but only 6 are fetchable for an
      // English user, so rotating over all 47 would spend ~7 of every 8
      // twenty-minute cycles fetching nothing, and the coverage badge would sit
      // at "6/47 sources" permanently — a fresh version of the same lie #5873 is
      // about. Preset categories keep the full enabled set: they are
      // digest-backed, and `enabledNames` (which filters digest items by source)
      // must stay language-blind because the server does not language-filter.
      const reachableFeeds = isCustom ? filterFeedsByLanguage(enabledFeeds, getCurrentLanguage()) : enabledFeeds;
      if (isCustom) {
        this.customNewsSourceTotals.set(category, reachableFeeds.length);
      }

      // Digest branch: server already aggregated feeds — map proto items to client types
      if (digest?.categories && category in digest.categories) {
        // The digest carries every enabled source for the category, so there is
        // no partial coverage to disclose — clear any badge a prior custom-path
        // load left behind.
        this.clearNewsSourceCoverage(category);
        this.setNewsRefreshDegraded(category, false);
        const items = (digest.categories[category]?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledNames.has(i.source));

        void ingestTrendingHeadlines(items.map(i => ({
          title: i.title,
          pubDate: i.pubDate,
          pubDateMissing: i.pubDateMissing,
          source: i.source,
          link: i.link,
        })))
          .catch((err) => {
            console.warn('[News] ingestTrendingHeadlines failed (chunk load?):', err);
          });

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

        if (panel && options.recordBaselineSample) {
          try {
            const baseline = await updateBaseline(`news:${category}`, items.length);
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
        }

        return items;
      }

      // Preset categories: serve last-known-good while the digest is briefly
      // unavailable. Custom categories are NEVER in the digest, so this branch
      // would fire on every refresh after the first load — getStaleNewsItems
      // reads ctx.newsByCategory, which the prior cycle's direct fetch already
      // populated — and freeze the panel on stale headlines. Skip it for them
      // and fall through to the direct fetch; the panel keeps showing its
      // current batch until fresh data lands (no blank flash).
      const staleItems = this.getStaleNewsItems(category).filter(i => enabledNames.has(i.source));

      // For a custom category that same set is not "stale headlines to freeze
      // on" but the CARRY-OVER this cycle accumulates onto: the rotation window
      // only ever fetches perFeedFallbackCategoryFeedLimit sources, so the
      // sources it did NOT fetch this time live here (#5873). Snapshotted here,
      // before any render — renderNewsForCategory overwrites
      // ctx.newsByCategory, which is what getStaleNewsItems reads, so reading
      // it later would fold each partial render back into itself.
      const carryOver = isCustom ? staleItems : [];

      /**
       * What to actually paint for a given set of freshly fetched items.
       *
       * Identity for a preset category — its fallback replaces wholesale, as
       * before. For a custom one it merges onto the carry-over. Source coverage
       * is published by renderNewsForCategory after time-range filtering, so
       * the badge describes what is actually visible.
       */
      const mergeForRender = (freshItems: NewsItem[]): NewsItem[] => {
        if (!isCustom) return freshItems;
        return mergeRotatedNewsItems(carryOver, freshItems, {
          maxItems: this.customCategoryMergedItemLimit,
          enabledSources: enabledNames,
        });
      };

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
        // Merge BEFORE queueing, not at flush time: rendering the raw partial
        // would blank the carried-over sources for one frame and then bring
        // them back, which is the churn the merge exists to avoid.
        pendingItems = mergeForRender(partialItems);
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

      if (!isCustom && staleItems.length > 0) {
        console.warn(`[News] Digest missing for "${category}", serving stale headlines (${staleItems.length})`);
        this.renderNewsForCategory(category, staleItems);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: staleItems.length,
        });
        return staleItems;
      }

      // The per-feed-fallback flag is the kill switch for the digest-down
      // thundering herd (every preset category fetching at once), so it does NOT
      // apply to custom categories: those are NEVER in the digest by design and
      // direct fetch is their only path — gating them here would leave a
      // customized panel permanently empty rather than degraded. Their blast
      // radius is bounded by the feed cap below instead.
      if (!isCustom && !this.isPerFeedFallbackEnabled() && !options.allowDigestPendingFallback) {
        console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
        this.renderNewsForCategory(category, []);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'error',
          errorMessage: 'Digest unavailable',
        });
        return [];
      }

      // Every per-feed fallback is capped, custom categories included. They used
      // to fetch their full feed set on the theory that a handful of customized
      // panels carried "no thundering-herd risk" — three of them firing on every
      // load, uncapped, was 19 direct proxy round-trips (#5376). Nothing bounds
      // how many custom categories a session can have, so the cap has to be
      // unconditional.
      //
      // WHICH feeds the cap buys is where the two diverge. A preset category
      // takes the fixed prefix: its fallback is transient, and re-fetching the
      // same feeds is what makes an outage's repeated attempts idempotent. A
      // custom category is the ONLY consumer of its feeds and is never in the
      // digest, so a fixed prefix made the cap PERMANENT — feeds 4..N were
      // unreachable on every load and every refresh (#5873). It rotates
      // instead: same request budget, advanced by the cap each cycle, so every
      // source is reached within ceil(N / cap) cycles.
      const rotationCycle = isCustom ? this.newsRotationCycle(category) : 0;
      const fallbackFeeds = isCustom
        ? selectRotatingFeedWindow(reachableFeeds, this.perFeedFallbackCategoryFeedLimit, rotationCycle)
        : this.selectLimitedFeeds(enabledFeeds, this.perFeedFallbackCategoryFeedLimit);
      if (isCustom) {
        // Advanced as soon as the window is claimed rather than after the fetch
        // resolves, so a cycle that fails outright still moves on instead of
        // retrying the same failing window forever.
        this.advanceNewsRotationCycle(category, reachableFeeds.length);
        console.warn(`[News] Custom category "${category}" (not in variant preset), fetching ${fallbackFeeds.length}/${reachableFeeds.length} feeds directly (rotation cycle ${rotationCycle})`);
      } else if (options.allowDigestPendingFallback) {
        console.warn(`[News] Digest still pending for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else if (fallbackFeeds.length < enabledFeeds.length) {
        console.warn(`[News] Digest missing for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else {
        console.warn(`[News] Digest missing for "${category}", using per-feed fallback (${fallbackFeeds.length} feeds)`);
      }

      const { fetchCategoryFeeds, getFeedFailures } = await getRssModule();
      const fetchedItems = await fetchCategoryFeeds(fallbackFeeds, {
        batchSize: this.perFeedFallbackBatchSize,
        onBatch: (partialItems) => {
          scheduleRender(partialItems);
          // Map flashes and breaking-news alerts fire on the FRESH batch only.
          // Feeding them the merged set would re-flash and re-alert on every
          // rotation cycle for headlines the user has already seen.
          this.flashMapForNews(partialItems);
          checkBatchForBreakingAlerts(partialItems);
        },
      });

      // Everything downstream — render, empty-state, baseline, status count and
      // the value that lands in ctx.allNews — reads the MERGED set, because for
      // a custom category that is what the panel actually shows. Using the raw
      // fetch would report this cycle's three sources as the whole category and
      // hand clustering a set the user isn't looking at.
      const items = mergeForRender(fetchedItems);
      const failures = getFeedFailures();
      const failedFeeds = fallbackFeeds.filter(f => failures.has(f.name));
      const windowFailed = fallbackFeeds.length > 0 && failedFeeds.length === fallbackFeeds.length;
      this.setNewsRefreshDegraded(category, windowFailed);
      this.renderNewsForCategory(category, items);
      if (panel) {
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = null;
          pendingItems = null;
        }

        if (items.length === 0 && failedFeeds.length > 0) {
          const names = failedFeeds.map(f => f.name).join(', ');
          panel.showError(`${t('common.noNewsAvailable')} (${names} failed)`);
        }

        if (options.recordBaselineSample && !windowFailed) {
          try {
            const baseline = await updateBaseline(`news:${category}`, items.length);
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
        }
      }

      const feedLabel = category.charAt(0).toUpperCase() + category.slice(1);
      if (windowFailed) {
        const names = failedFeeds.map(f => f.name).join(', ');
        this.ctx.statusPanel?.updateFeed(feedLabel, {
          status: 'error',
          itemCount: items.length,
          errorMessage: `${names} failed`,
        });
        this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      } else {
        this.ctx.statusPanel?.updateFeed(feedLabel, {
          status: 'ok',
          itemCount: items.length,
        });
        this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });
      }

      return items;
    } catch (error) {
      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      // A preset category drops its items: its next successful load replaces
      // them wholesale from the digest, so holding stale ones only risks
      // presenting them as current.
      //
      // A custom category's stored items are its ACCUMULATED rotation coverage,
      // built one capped window per 20-minute cycle (#5873). Dropping them
      // sends the next cycle back to carry-over-less, so a single transient
      // error — a chunk-load hiccup is enough — silently restarts the hour it
      // takes to cover a ten-source panel. Keep them: the next cycle merges
      // onto them, and the status panel already reports the error.
      if (!isCustom) {
        delete this.ctx.newsByCategory[category];
        return [];
      }

      this.setNewsRefreshDegraded(category, true);
      const enabledNames = new Set(
        (feeds ?? [])
          .filter(feed => !this.ctx.disabledSources.has(feed.name))
          .map(feed => feed.name),
      );
      return this.getStaleNewsItems(category).filter(item => enabledNames.has(item.source));
    }
  }

  private async loadIntelNews(
    digest: ListFeedDigestResponse | null,
    allowDigestPendingFallback: boolean,
    options: NewsIntelLoadOptions = { recordBaselineSample: true },
  ): Promise<NewsItem[]> {
    const enabledIntelSources = INTEL_SOURCES.filter(f => !this.ctx.disabledSources.has(f.name));
    const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
    const intelPanel = this.ctx.newsPanels['intel'];
    if (enabledIntelSources.length === 0) {
      delete this.ctx.newsByCategory['intel'];
      if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
      this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      return [];
    }

    if (digest?.categories && 'intel' in digest.categories) {
      // Digest branch for intel
      const intel = (digest.categories['intel']?.items ?? [])
        .map(protoItemToNewsItem)
        .filter(i => enabledIntelNames.has(i.source));
      checkBatchForBreakingAlerts(intel);
      this.renderNewsForCategory('intel', intel);
      if (intelPanel && options.recordBaselineSample) {
        try {
          const baseline = await updateBaseline('news:intel', intel.length);
          const deviation = calculateDeviation(intel.length, baseline);
          intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
        } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
      }
      this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
      this.flashMapForNews(intel);
      return intel;
    }

    const staleIntel = this.getStaleNewsItems('intel').filter(i => enabledIntelNames.has(i.source));
    if (staleIntel.length > 0) {
      console.warn(`[News] Intel digest missing, serving stale headlines (${staleIntel.length})`);
      this.renderNewsForCategory('intel', staleIntel);
      if (intelPanel && options.recordBaselineSample) {
        try {
          const baseline = await updateBaseline('news:intel', staleIntel.length);
          const deviation = calculateDeviation(staleIntel.length, baseline);
          intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
        } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
      }
      this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: staleIntel.length });
      return staleIntel;
    }

    if (!this.isPerFeedFallbackEnabled() && !allowDigestPendingFallback) {
      console.warn('[News] Intel digest missing, limited per-feed fallback disabled');
      delete this.ctx.newsByCategory['intel'];
      this.ctx.statusPanel?.updateFeed('Intel', { status: 'error', errorMessage: 'Digest unavailable' });
      return [];
    }

    const fallbackIntelFeeds = this.selectLimitedFeeds(enabledIntelSources, this.perFeedFallbackIntelFeedLimit);
    if (allowDigestPendingFallback) {
      console.warn(`[News] Intel digest still pending, using limited per-feed fallback (${fallbackIntelFeeds.length}/${enabledIntelSources.length} feeds)`);
    } else if (fallbackIntelFeeds.length < enabledIntelSources.length) {
      console.warn(`[News] Intel digest missing, using limited per-feed fallback (${fallbackIntelFeeds.length}/${enabledIntelSources.length} feeds)`);
    }

    let intel: NewsItem[];
    try {
      const { fetchCategoryFeeds } = await getRssModule();
      intel = await fetchCategoryFeeds(fallbackIntelFeeds, { batchSize: this.perFeedFallbackBatchSize });
    } catch (e) {
      delete this.ctx.newsByCategory['intel'];
      console.error('[App] Intel feed failed:', e);
      return [];
    }

    checkBatchForBreakingAlerts(intel);
    this.renderNewsForCategory('intel', intel);
    if (intelPanel && options.recordBaselineSample) {
      try {
        const baseline = await updateBaseline('news:intel', intel.length);
        const deviation = calculateDeviation(intel.length, baseline);
        intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
      } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
    }
    this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
    this.flashMapForNews(intel);
    return intel;
  }

  /**
   * Panel-driven, not variant-driven: the active variant's preset categories
   * PLUS any extra categories required by enabled news panels the user added
   * beyond the preset (e.g. Tech panels customized into `full`). Custom
   * categories aren't in the per-variant server digest, so they're flagged
   * `isCustom` and fetched directly client-side in loadNewsCategory().
   */
  private resolveEnabledNewsCategories(): ResolvedCategory[] {
    return resolveNewsCategories(
      FEEDS,
      CANONICAL_FEEDS,
      enabledNewsCategoryKeys(this.ctx.newsCategoryPanelKeys, this.ctx.panelSettings),
    );
  }

  /**
   * Whether loadAllData() should (re)run the news load.
   *
   * Unlike every other hydration task, the news load is NOT viewport-gated — it
   * always loaded everything — so an unconditional `news` task meant each of
   * loadAllData()'s many triggers re-fetched the digest. Boot alone fires two
   * (panel-layout's hydration trigger, then App.ts's bootstrap fan-out) and the
   * drain loop turns overlapping calls into a second full run: two
   * `list-feed-digest` requests per page load, plus a second round of per-feed
   * fetches (#5376).
   *
   * The category set is what the load actually keys on, so re-run when it has
   * changed (tab switch, mission preset, panel toggle) and skip when it has not
   * (viewport entry, scroll, playback exit). Periodic refresh stays owned by
   * RefreshScheduler's `news` loop at REFRESH_INTERVALS.feeds, which calls
   * loadNews() directly and is unaffected by this gate.
   */
  private shouldHydrateNews(forceAll: boolean): boolean {
    if (forceAll || this.loadedNewsSignature === null) return true;
    const current = newsWorkListSignature(this.resolveEnabledNewsCategories(), this.ctx.disabledSources);
    return current !== this.loadedNewsSignature;
  }

  /**
   * Drop the record of what the last news load covered, so the next
   * loadAllData() reloads news even though the category set is unchanged.
   *
   * Callers are the paths that take the rendered headlines away without
   * changing the work-list — playback replay puts every news panel back into a
   * loading state and relies on the exit calling loadAllData() to refill them.
   */
  invalidateNewsHydration(): void {
    this.loadedNewsSignature = null;
  }

  async loadNews(): Promise<void> {
    // Reset happy variant accumulator for fresh pipeline run
    if (SITE_VARIANT === 'happy') {
      this.ctx.happyAllItems = [];
    }

    // Fire digest fetch early, but do not let a slow digest stall the category
    // first paint. Fast digests still take the optimized digest-backed path.
    const digestPromise = this.tryFetchDigest().catch((error) => {
      console.warn('[News] Digest fetch failed before category load:', error);
      return null;
    });
    const fallbackKey = this.digestCacheKey();
    const fallbackDigest = this.getRetainedDigest(fallbackKey) ?? await this.loadPersistedDigest(fallbackKey);

    const categories = this.resolveEnabledNewsCategories();
    // Snapshot beside the categories: `ctx.disabledSources` is mutated IN PLACE by
    // the settings source toggle, so reading it after the await would record the
    // post-toggle set for a load that used the pre-toggle one.
    const disabledAtLoadStart = new Set(this.ctx.disabledSources);

    const maxCategoryConcurrency = SITE_VARIANT === 'tech' ? 4 : 5;
    const categoryConcurrency = Math.max(1, Math.min(maxCategoryConcurrency, categories.length));
    const newsPass = await runNewsLoadPass(
      {
        categories,
        categoryConcurrency,
        digestPromise,
        fallbackDigest,
        digestGraceMs: this.digestFirstPaintGraceMs,
        allowPendingPerFeedFallback: this.isPerFeedFallbackEnabled(),
        hasDigestCategory: (digest, key) => Boolean(digest.categories && key in digest.categories),
        loadCategory: ({ key, feeds, isCustom }, digest, options) => this.loadNewsCategory(key, feeds, digest, isCustom, options),
        loadIntel: SITE_VARIANT === 'full'
          ? (digest, allowDigestPendingFallback, options) => this.loadIntelNews(digest, allowDigestPendingFallback, options)
          : undefined,
        onCategoryError: (key, reason) => {
          console.error(`[App] News category ${key ?? 'unknown'} failed:`, reason);
        },
        onDigestRefreshError: (key, reason) => {
          console.error(`[App] Digest refresh for news category ${key ?? 'unknown'} failed:`, reason);
        },
      },
    );
    const { categoryItemsByKey, intelItems } = newsPass;

    const collectedNews: NewsItem[] = [];
    for (const { key } of categories) {
      const items = categoryItemsByKey.get(key) ?? [];
      // Tag items with content categories for happy variant
      if (SITE_VARIANT === 'happy') {
        for (const item of items) {
          item.happyCategory = classifyNewsItem(item.source, item.title);
        }
        // Accumulate curated items for the positive news pipeline
        this.ctx.happyAllItems = this.ctx.happyAllItems.concat(items);
      }
      collectedNews.push(...items);
    }

    if (SITE_VARIANT === 'full') {
      collectedNews.push(...intelItems);
    }

    this.ctx.allNews = collectedNews;
    // Record what this run covered — but only when it actually landed something for
    // the gate to protect. A run counts as landed when the digest COVERED at least
    // one preset category (authoritative even where that bucket came back empty),
    // when items arrived by any path, or when there are no categories to retry.
    //
    // A digest outage lands none of those, and it has two shapes. The obvious one
    // is a failed request. The one that bites is a 200 carrying an empty or partial
    // `categories` map — non-null, so a plain null check would call it landed. Both
    // render every preset category empty on web (`newsPerFeedFallback` is off), and
    // recording either would make the gate treat an empty dashboard as "already
    // loaded" and suppress every retry until RefreshScheduler's 20-minute tick.
    // Leaving the signature unset keeps the next trigger a real retry — the recovery
    // the pre-gate double-load provided by accident, now deliberate.
    //
    // Coverage is measured over PRESET categories only: a custom category succeeds
    // on its own direct-fetch path, so counting it would let one customized panel
    // mask an outage for every other category in the work-list.
    //
    // Set here rather than in a `finally` so a load that threw on the way in stays
    // retryable too, and before the post-load intelligence tail so a failure there
    // doesn't force a re-fetch of news that already arrived. The disabled-source set
    // is the one snapshotted at load start, so a source toggled mid-load compares
    // unequal on the next trigger instead of being swallowed.
    const digestCategories = newsPass.finalDigest?.categories ?? {};
    const digestCovered = categories.some(({ key, isCustom }) => !isCustom && key in digestCategories);
    const anyItemsCollected = collectedNews.length > 0;
    const noCategoriesToLoad = categories.length === 0;
    const landed = digestCovered || anyItemsCollected || noCategoriesToLoad;
    if (landed) this.loadedNewsSignature = newsWorkListSignature(categories, disabledAtLoadStart);
    this.ctx.initialLoadComplete = true;
    mountCommunityWidget();

    this.ctx.map?.updateHotspotActivity(this.ctx.allNews);

    this.updateMonitorResults();

    try {
      this.ctx.latestClusters = mlWorker.isAvailable
        ? await clusterNewsHybrid(this.ctx.allNews)
        : await analysisWorker.clusterNews(this.ctx.allNews);
      // Only now is an empty cluster set a real answer. Set inside the try, after
      // the assignment, so a pass that threw leaves late-mounting hub panels on
      // their loading skeleton instead of asserting "no active hubs".
      this.ctx.clustersSettled = true;

      // callPanel(), not `panels[key]?.method()`: both panels are deferred, and
      // on a phone the IntersectionObserver margin is 700px — they are usually
      // still unmounted shells when this pass completes. An optional-chained
      // call drops the clustering result on the floor and the panel mounts
      // minutes later onto its constructor's empty state, permanently (neither
      // has a scheduled refresh). callPanel() queues instead, and panel-layout
      // replays on lazy load. Both renders are safe while detached.
      this.callPanel('insights', 'updateInsights', this.ctx.latestClusters);
      if (isPanelInVariantDefaults('threat-timeline')) {
        this.callPanel('threat-timeline', 'refresh', this.ctx.latestClusters);
      }

      hydrateGeoHubPanelFromClusters(
        this.ctx.panels['geo-hubs'] as GeoHubsPanel | undefined,
        this.ctx.latestClusters,
        { allowEmpty: true },
      );
      this.applyTechHubActivities();

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
      this.callPanel('insights', 'updateInsights', []);
      if (isPanelInVariantDefaults('threat-timeline')) {
        this.callPanel('threat-timeline', 'refresh', []);
      }
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

    // Bump generation so any in-flight insider fetch from a prior invocation
    // of loadStockAnalysis no-ops instead of re-rendering stale snapshots on
    // top of the current render.
    const generation = ++this._stockAnalysisGeneration;

    try {
      const targets = getStockAnalysisTargets();
      const targetSymbols = targets.map((target) => target.symbol);
      const storedHistory = await fetchStockAnalysisHistory(targets.length);
      const cachedSnapshots = getLatestStockAnalysisSnapshots(storedHistory, targets.length);
      const historyIsFresh = hasFreshStockAnalysisHistory(storedHistory, targetSymbols);

      if (cachedSnapshots.length > 0) {
        panel.renderAnalyses(cachedSnapshots, storedHistory, 'cached');
      }

      if (historyIsFresh) {
        // No live fetch coming — safe to enrich the cached render with
        // insiders now. This is the only cached-path insider fetch; when a
        // live fetch is about to run we defer insider enrichment until after
        // the live render so we never re-render stale cached snapshots over
        // fresh live data.
        if (cachedSnapshots.length > 0) {
          void this.loadInsiderDataForPanel(panel, targetSymbols, cachedSnapshots, storedHistory, 'cached', generation)
            .catch((error) => console.error('[StockAnalysis] insider fetch failed:', error));
        }
        return;
      }

      const staleSymbols = getMissingOrStaleStockAnalysisSymbols(storedHistory, targetSymbols);
      const staleTargets = targets.filter((target) => staleSymbols.includes(target.symbol));
      const results = await fetchStockAnalysesForTargets(staleTargets);
      if (results.length === 0) {
        if (cachedSnapshots.length === 0) {
          panel.showRetrying('Stock analysis is waiting for eligible watchlist symbols.');
          return;
        }
        // Live fetch returned nothing but we already rendered cachedSnapshots
        // above. Enrich the displayed cached snapshots with insider data so
        // the user still sees the insider section.
        void this.loadInsiderDataForPanel(panel, targetSymbols, cachedSnapshots, storedHistory, 'cached', generation)
          .catch((error) => console.error('[StockAnalysis] insider fetch failed:', error));
        return;
      }
      const nextHistory = mergeStockAnalysisHistory(storedHistory, results);
      // Build a combined view so a partial refetch does not shrink the panel:
      // preserve still-fresh cached snapshots for symbols we did NOT refetch,
      // and use live results for symbols we did. Watchlist order is preserved.
      const resultBySymbol = new Map(results.map((r) => [r.symbol, r]));
      const combined: StockAnalysisResult[] = [];
      for (const target of targets) {
        const live = resultBySymbol.get(target.symbol);
        if (live) {
          combined.push(live);
          continue;
        }
        const cached = storedHistory[target.symbol]?.[0];
        if (cached?.available) combined.push(cached);
      }
      const snapshotsToRender = combined.length > 0 ? combined : results;
      panel.renderAnalyses(snapshotsToRender, nextHistory, 'live');
      void this.loadInsiderDataForPanel(panel, targetSymbols, snapshotsToRender, nextHistory, 'live', generation)
        .catch((error) => console.error('[StockAnalysis] insider fetch failed:', error));
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

  private async loadInsiderDataForPanel(
    panel: StockAnalysisPanel,
    symbols: string[],
    snapshotsToReRender: StockAnalysisResult[],
    historyForReRender: StockAnalysisHistory,
    source: 'live' | 'cached',
    generation: number,
  ): Promise<void> {
    const results = await Promise.allSettled(symbols.map(s => fetchInsiderTransactions(s)));
    // If another loadStockAnalysis invocation has started while this fetch
    // was in flight, drop the result entirely — both setInsiderData and the
    // re-render would clobber the current state.
    if (generation !== this._stockAnalysisGeneration) return;
    for (let i = 0; i < symbols.length; i++) {
      const r = results[i];
      if (r && r.status === 'fulfilled') {
        panel.setInsiderData(symbols[i]!, r.value);
      } else {
        panel.setInsiderData(symbols[i]!, { unavailable: true, symbol: symbols[i]!, totalBuys: 0, totalSells: 0, netValue: 0, transactions: [], fetchedAt: '' });
      }
    }
    // Re-render the panel so the insider section becomes visible now that
    // setInsiderData has populated insiderBySymbol. Guard once more in case
    // something awaited between the setInsiderData calls above.
    if (generation !== this._stockAnalysisGeneration) return;
    panel.renderAnalyses(snapshotsToReRender, historyForReRender, source);
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
      // Build a combined view so a partial refetch does not shrink the panel:
      // keep still-fresh cached backtests for symbols we did NOT refetch, swap
      // in live results for the ones we did. Watchlist order is preserved.
      const resultBySymbol = new Map(results.map((r) => [r.symbol, r]));
      const storedBySymbol = new Map(stored.map((s) => [s.symbol, s]));
      const combined: StockBacktestResult[] = [];
      for (const target of targets) {
        const live = resultBySymbol.get(target.symbol);
        if (live) {
          combined.push(live);
          continue;
        }
        const cached = storedBySymbol.get(target.symbol);
        if (cached) combined.push(cached);
      }
      panel.renderBacktests(combined.length > 0 ? combined : results);
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
    const generation = this.marketLoadGuard.begin();
    const isCurrent = () => this.marketLoadGuard.isCurrent(generation);
    // Method-scoped so all of loadMarkets' try blocks (stocks/sectors/commodities +
    // crypto/defi/ai/other) see these; market is dynamic-imported off eager main.js (#4571).
    // Guarded: loadMarkets must not reject (the init() watchlist handler calls it
    // unguarded), so a chunk-load failure skips this cycle like the per-block catches do.
    let marketMod: typeof import('@/services/market');
    try {
      marketMod = await import('@/services/market');
    } catch (e) {
      // Persistent failure mode: a stale-deploy chunk 404 would otherwise skip the
      // whole markets/crypto/commodities cycle with no signal. Log so it's traceable,
      // and mirror the downstream failure states before returning.
      console.warn('[DataLoader] market chunk load failed', e);
      if (isCurrent()) {
        this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
        this.ctx.statusPanel?.updateApi('CoinGecko', { status: 'error' });
        (this.ctx.panels['markets'] as MarketPanel | undefined)?.showRetrying(t('common.failedMarketData'));
        (this.ctx.panels['heatmap'] as HeatmapPanel | undefined)?.showRetrying(t('common.failedSectorData'));
        (this.ctx.panels['commodities'] as CommoditiesPanel | undefined)?.showRetrying(t('common.failedCommodities'));
        (this.ctx.panels['energy-complex'] as EnergyComplexPanel | undefined)?.showRetrying(t('common.failedCommodities'));
        (this.ctx.panels['crypto'] as CryptoPanel | undefined)?.showRetrying(t('common.failedCryptoData'));
        (this.ctx.panels['crypto-heatmap'] as CryptoHeatmapPanel | undefined)?.showRetrying(t('common.failedCryptoData'));
        (this.ctx.panels['defi-tokens'] as DefiTokensPanel | undefined)?.showRetrying(t('common.failedCryptoData'));
        (this.ctx.panels['ai-tokens'] as AiTokensPanel | undefined)?.showRetrying(t('common.failedCryptoData'));
        (this.ctx.panels['other-tokens'] as OtherTokensPanel | undefined)?.showRetrying(t('common.failedCryptoData'));
      }
      return;
    }
    const {
      fetchMultipleStocks, fetchCommodityQuotes, fetchPhysicalPremiums, fetchSectors, warmCommodityCache, warmSectorCache,
      fetchCrypto, fetchCryptoSectors, fetchDefiTokens, fetchAiTokens, fetchOtherTokens,
    } = marketMod;
    try {
      const customEntries = getMarketWatchlistEntries();
      const effectiveSymbols = resolveEffectiveMarketWatchlist(
        STOCK_CATALOG,
        MARKET_SYMBOLS,
        getCatalogSelection(),
        customEntries,
      ).symbols;

      // Hydrate markets from bootstrap (same pattern as sectors) — instant data on page load
      const hydratedMarkets = getHydratedData('marketQuotes') as ListMarketQuotesResponse | undefined;
      let stocksResult: Awaited<ReturnType<typeof fetchMultipleStocks>>;
      const marketsPanel = this.ctx.panels['markets'] as MarketPanel | undefined;
      const hydratedDisclosures = getHydratedData('chinaCorporateDisclosures') as
        ChinaCorporateDisclosureSnapshot | undefined;
      if (hydratedDisclosures !== undefined) {
        marketsPanel?.renderDisclosures(hydratedDisclosures);
      }

      const selectedHydratedQuotes = selectCompleteHydratedMarketQuotes(
        effectiveSymbols,
        hydratedMarkets?.quotes,
      );
      if (selectedHydratedQuotes) {
        const symbolMetaMap = new Map(effectiveSymbols.map((s) => [s.symbol, s]));
        const data = selectedHydratedQuotes.map((q) => ({
          symbol: q.symbol,
          name: symbolMetaMap.get(q.symbol)?.name || q.name,
          display: symbolMetaMap.get(q.symbol)?.display || q.display || q.symbol,
          price: q.price != null ? q.price : null,
          change: q.change ?? null,
          sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
        }));
        if (isCurrent()) {
          this.ctx.latestMarkets = data;
          marketsPanel?.renderMarkets(data);
        }
        stocksResult = {
          data,
          skipped: hydratedMarkets?.finnhubSkipped || undefined,
          rateLimited: hydratedMarkets?.rateLimited || undefined,
        };
      } else {
        stocksResult = await fetchMultipleStocks(effectiveSymbols, {
          onBatch: (partialStocks) => {
            if (!isCurrent()) return;
            this.ctx.latestMarkets = partialStocks;
            marketsPanel?.renderMarkets(partialStocks);
          },
        });
        if (isCurrent()) {
          this.ctx.latestMarkets = stocksResult.data;
          marketsPanel?.renderMarkets(stocksResult.data, stocksResult.rateLimited, stocksResult.unavailableSymbols);
        }
      }

      const stockAvailability = resolveStockMarketAvailability({
        stockCount: stocksResult.data.length,
        finnhubSkipped: stocksResult.skipped,
        rateLimited: stocksResult.rateLimited,
      });

      if (!isCurrent()) {
        // A newer selection/load owns all market writes and any premium reload.
      } else if (stockAvailability.rateLimitError) {
        this.ctx.panels['commodities']?.showError(stockAvailability.rateLimitError);
      } else if (stockAvailability.finnhubStatus) {
        this.ctx.statusPanel?.updateApi('Finnhub', { status: stockAvailability.finnhubStatus });
        if (stockAvailability.marketsConfigError) {
          this.ctx.panels['markets']?.showConfigError(stockAvailability.marketsConfigError);
        }
      }

      // Sector heatmap: always attempt loading regardless of market rate-limit status
      // Symbols whose valuation was replayed from the seeder's last-good snapshot
      // rather than fetched this cycle. Without this the panel would present
      // records up to 7 days old as current.
      const readStaleValuationSymbols = (resp: unknown): string[] => {
        const coverage = (resp as { valuationCoverage?: { staleValuationSymbols?: unknown } })?.valuationCoverage;
        const symbols = coverage?.staleValuationSymbols;
        return Array.isArray(symbols) ? symbols.filter((s): s is string => typeof s === 'string') : [];
      };
      const hydratedSectors = getHydratedData('sectors') as (GetSectorSummaryResponse & { valuations?: Record<string, SectorValuation> }) | undefined;
      const heatmapPanel = this.ctx.panels['heatmap'] as HeatmapPanel | undefined;
      const sectorNameMap = new Map(SECTORS.map((s) => [s.symbol, s.name]));
      const toHeatmapItem = (s: { symbol: string; name: string; change: number }) => ({
        symbol: s.symbol,
        name: sectorNameMap.get(s.symbol) ?? s.name,
        change: s.change,
      });
      const toSectorBar = (s: { symbol?: string; name: string; change: number | null }) =>
        s.symbol && Number.isFinite(s.change) ? { symbol: s.symbol, name: s.name, change1d: s.change as number } : null;
      // Defensive: a pre-PR bootstrap payload may have `sectors` but lack the
      // new `valuations` field entirely. Treat that shape as a cache miss and
      // fall through to a live fetch so the valuations tab can populate.
      const hydratedHasValuationsField = hydratedSectors
        ? Object.prototype.hasOwnProperty.call(hydratedSectors, 'valuations')
        : false;
      if (hydratedSectors?.sectors?.length && hydratedHasValuationsField) {
        warmSectorCache(hydratedSectors);
        const items = hydratedSectors.sectors.map(toHeatmapItem);
        const sectorBars = items.map(toSectorBar).filter((s): s is NonNullable<typeof s> => s !== null);
        heatmapPanel?.renderHeatmap(items, sectorBars.length ? sectorBars : undefined);
        heatmapPanel?.updateValuations(
          hydratedSectors.valuations,
          readStaleValuationSymbols(hydratedSectors),
        );
      } else {
        // If hydrated had sectors but no valuations field, render performance
        // tiles immediately so users see heatmap data while the live fetch runs.
        if (hydratedSectors?.sectors?.length) {
          const items = hydratedSectors.sectors.map(toHeatmapItem);
          const sectorBars = items.map(toSectorBar).filter((s): s is NonNullable<typeof s> => s !== null);
          heatmapPanel?.renderHeatmap(items, sectorBars.length ? sectorBars : undefined);
        }
        const sectorsResp = await fetchSectors() as GetSectorSummaryResponse & { valuations?: Record<string, SectorValuation> };
        if (sectorsResp.sectors.length > 0) {
          const items = sectorsResp.sectors.map(toHeatmapItem);
          const sectorBars = items.map(toSectorBar).filter((s): s is NonNullable<typeof s> => s !== null);
          heatmapPanel?.renderHeatmap(items, sectorBars.length ? sectorBars : undefined);
          // Only push valuations when the response actually has the field — a
          // payload without `valuations` must NOT clear prior valuations that
          // may already be rendered from a previous (successful) fetch.
          if (Object.prototype.hasOwnProperty.call(sectorsResp, 'valuations')) {
            heatmapPanel?.updateValuations(
              sectorsResp.valuations,
              readStaleValuationSymbols(sectorsResp),
            );
          }
        } else {
          const heatmapAvailability = resolveSectorHeatmapAvailability({
            sectorCount: sectorsResp.sectors.length,
            finnhubSkipped: stocksResult.skipped,
          });
          if (heatmapAvailability.configError) {
            this.ctx.panels['heatmap']?.showConfigError(heatmapAvailability.configError);
          }
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
        const skipFetch = stockAvailability.skipCommodityFetch;
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

      if (commoditiesPanel) {
        try {
          const physicalPremiums = await fetchPhysicalPremiums();
          if (isCurrent()) commoditiesPanel.updatePhysicalPremiums(physicalPremiums);
        } catch {
          // The physical comparison is an optional tab; a failure must not
          // downgrade the existing commodity tape or its provider status.
        }
      }

      // Load ECB FX rates for CommoditiesPanel FX tab
      if (commoditiesPanel) {
        try {
          const { getEcbFxRatesData, toEurSpotRows } = await import('@/services/economic');
          const fxResp = await getEcbFxRatesData();
          if (!fxResp.unavailable && fxResp.rates?.length) {
            // Shared with the FX panel (#6199) so the pair list and its display
            // order live in one place. This tab previously kept a private
            // EUR_FX_ORDER literal; the two would have drifted the moment the
            // seeder published an eighth pair.
            commoditiesPanel.updateFxRates(toEurSpotRows(fxResp.rates));
          }
        } catch {
          // FX tab is optional, ignore failures
        }
      }
    } catch {
      if (isCurrent()) this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
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
    let dailyMarketBrief: DailyMarketBriefModule | null = null;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      dailyMarketBrief = await getDailyMarketBriefModule();
      // Bound the IndexedDB cache read so a hung persistent-cache layer
      // can't keep the panel on its default Loading state forever — fall
      // through to "build from scratch" instead.
      const cached = await withTimeout(
        dailyMarketBrief.getCachedDailyMarketBrief(timezone),
        3_000,
        'daily-brief-cache-read',
      ).catch(() => null);

      if (cached?.available) {
        this.callPanel('daily-market-brief', 'renderBrief', cached, 'cached');
      }

      if (!force && cached && !dailyMarketBrief.shouldRefreshDailyBrief(cached, timezone)) {
        return;
      }

      if (!cached) {
        this.callPanel('daily-market-brief', 'showLoading', 'Building daily market brief...');
      }

      // Each context collector calls a generated RPC client without its
      // own timeout (`getFearGreedIndex`, `getFredSeriesBatch`); the
      // `try { ... } catch` inside each collector only handles rejections
      // — a hung RPC sits forever and `Promise.allSettled` waits with it.
      // That's the same hang-class this PR was opened to fix; an earlier
      // commit missed these three call sites because they were two layers
      // up from the `summaryProvider` await I was hunting. 8s per
      // collector is generous for an RPC and leaves >36s of the outer
      // 60s budget for the actual LLM call.
      // `_collectSectorContext` is sync (reads only hydrated data) so it
      // needs no wrapping; allSettled accepts non-promises directly.
      const [r0, r1, r2, r3] = await Promise.allSettled([
        withTimeout(this._collectRegimeContext(), 8_000, 'daily-brief-regime-context'),
        withTimeout(this._collectYieldCurveContext(), 8_000, 'daily-brief-yield-context'),
        this._collectSectorContext(),
        withTimeout(this._collectEarningsContext(), 8_000, 'daily-brief-earnings-context'),
      ]);
      const regimeContext = r0.status === 'fulfilled' ? r0.value : undefined;
      const yieldCurveContext = r1.status === 'fulfilled' ? r1.value : undefined;
      const sectorContext = r2.status === 'fulfilled' ? r2.value : undefined;
      const earningsContext = r3.status === 'fulfilled' ? r3.value : undefined;

      // Wall-clock budget on the whole build. The inner summarizer has its
      // own 45s cap (SUMMARIZER_TIMEOUT_MS in daily-market-brief.ts) and
      // falls back to rules-based output, so this outer 60s budget only
      // fires if the rules-based path itself hangs (shouldn't, but defensive
      // — covers e.g. a getDefaultSummarizer() dynamic-import that never
      // resolves). On timeout the existing catch below serves the cached
      // version or shows an error, never letting the panel stay stuck.
      const brief = await withTimeout(
        dailyMarketBrief.buildDailyMarketBrief({
          markets: this.ctx.latestMarkets,
          newsByCategory: this.ctx.newsByCategory,
          timezone,
          regimeContext,
          yieldCurveContext,
          sectorContext,
          earningsContext,
          frameworkAppend: getActiveFrameworkForPanel('daily-market-brief')?.systemPromptAppend,
          newsCategories: SITE_VARIANT === 'commodity'
            ? ['commodity-news', 'gold-silver', 'mining-news', 'energy', 'critical-minerals']
            : SITE_VARIANT === 'energy'
              ? ['live-news', 'energy', 'supply-chain']
              : undefined,
        }),
        60_000,
        'daily-brief-total-build',
      );

      if (this.dailyBriefGeneration !== gen) return;

      if (!brief.available) {
        if (!cached?.available) {
          this.callPanel('daily-market-brief', 'showUnavailable');
        }
        return;
      }

      // Render first, persist after. The previous order `await
      // dailyMarketBrief.cacheDailyMarketBrief(brief); render(brief)` meant a hung
      // IndexedDB / Tauri-Store write blocked the panel from ever
      // displaying the finished brief — the build budget proved nothing
      // by itself. Now: user sees the brief immediately; the cache write
      // runs fire-and-forget with its own 5s budget so a hung backend
      // becomes "no warmup for tomorrow's load" instead of "panel stuck
      // on Building forever."
      this.callPanel('daily-market-brief', 'renderBrief', brief, 'live');
      void withTimeout(
        dailyMarketBrief.cacheDailyMarketBrief(brief),
        5_000,
        'daily-brief-cache-write',
      ).catch((err) => {
        console.warn('[DailyBrief] cache write failed or timed out:', (err as Error).message);
      });
    } catch (error) {
      console.warn('[DailyBrief] Failed to build daily market brief:', error);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      // Same 3s cap as the upfront cache read above — covers the
      // "build hung AND IndexedDB also degraded" double-failure mode
      // (Greptile #3718 P2): without this guard the recovery path can
      // itself hang, leaving the panel stuck on whatever the previous
      // state was. .catch(() => null) absorbs both the TimeoutError and
      // any persistent-cache read failure into the same null-result
      // branch that the existing showError fallback already handles.
      const cached = dailyMarketBrief
        ? await withTimeout(
          dailyMarketBrief.getCachedDailyMarketBrief(timezone),
          3_000,
          'daily-brief-cache-read-recovery',
        ).catch(() => null)
        : null;
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

  /** #4922 (c): recent earnings surprises + upcoming density for the brief.
   * RPC-backed (earnings are not bootstrap-hydrated); failures degrade to
   * undefined — the brief simply omits the earnings block. */
  private async _collectEarningsContext(): Promise<import('@/services/daily-market-brief').EarningsBriefContext | undefined> {
    try {
      const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const today = new Date();
      const past = new Date(today.getTime() - 7 * 86400_000);
      const future = new Date(today.getTime() + 14 * 86400_000);
      const resp = await client.listEarningsCalendar({
        fromDate: past.toISOString().slice(0, 10),
        toDate: future.toISOString().slice(0, 10),
      });
      const earnings = resp.earnings ?? [];
      if (resp.unavailable || earnings.length === 0) return undefined;
      const { buildEarningsBriefContext } = await import('@/services/daily-market-brief');
      return buildEarningsBriefContext(earnings, today.toISOString().slice(0, 10));
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
      const hydrated = getHydratedData('forecasts') as { predictions?: import('@/generated/client/worldmonitor/forecast/v1/service_client').Forecast[]; generatedAt?: number } | undefined;
      if (hydrated?.predictions?.length) {
        this.callPanel('forecast', 'updateForecasts', hydrated.predictions, {
          generatedAt: hydrated.generatedAt || 0,
          degraded: false,
          stale: false,
          error: '',
        });
        return;
      }
      const { fetchForecastFeed } = await import('@/services/forecast');
      const feed = await fetchForecastFeed();
      this.callPanel('forecast', 'updateForecasts', feed.forecasts, {
        generatedAt: feed.generatedAt,
        degraded: feed.degraded,
        stale: feed.stale,
        error: feed.error,
      });
    } catch {
      this.callPanel('forecast', 'updateForecasts', [], {
        generatedAt: 0,
        degraded: false,
        stale: false,
        error: 'forecast_request_failed',
      });
    }
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

      this.ctx.latestTechEvents = mapEvents;
      this.ctx.map?.setTechEvents(mapEvents);
      this.ctx.map?.setLayerReady('techEvents', mapEvents.length > 0);
      this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'ok', itemCount: mapEvents.length });

      this.updateSearchIndex();
    } catch (error) {
      console.error('[App] Failed to load tech events:', error);
      this.ctx.latestTechEvents = [];
      this.ctx.map?.setTechEvents([]);
      this.ctx.map?.setLayerReady('techEvents', false);
      this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'error', errorMessage: String(error) });
    }
  }

  async loadCanadaRoads(): Promise<void> {
    try {
      const records = await fetchCanadaRoads();
      const sourceStates = getCanadaRoadSourceStates();
      const degradedSources = Object.entries(sourceStates)
        .filter(([, state]) => state === 'unavailable' || state === 'malformed')
        .map(([key]) => key);
      this.ctx.map?.setCanadaRoads(records);
      this.ctx.map?.setLayerReady('canadaRoads', records.length > 0);
      this.ctx.statusPanel?.updateFeed('Canada Roads', {
        status: degradedSources.length > 0 ? 'warning' : 'ok',
        itemCount: records.length,
        errorMessage: degradedSources.length > 0
          ? `Partial coverage: ${degradedSources.join(', ')}`
          : undefined,
      });
      // Per source, not one blanket ontario_511. Four feeds union onto this
      // layer, and attributing all of them to Ontario meant an Alberta, Toronto
      // or BC outage either read as an Ontario failure or — for the two with no
      // id at all — never reached the freshness panel. getCanadaRoadSourceStates
      // already knows which one is degraded; this just stops discarding it.
      for (const { key, freshnessId } of CANADA_ROAD_FRESHNESS_IDS) {
        const state = sourceStates[key];
        if (state === 'unavailable' || state === 'malformed') {
          dataFreshness.recordError(freshnessId, `${key}: ${state}`);
        } else {
          dataFreshness.recordUpdate(freshnessId, records.length);
        }
      }
    } catch (error) {
      this.ctx.map?.setLayerReady('canadaRoads', false);
      this.ctx.statusPanel?.updateFeed('Canada Roads', { status: 'error' });
      // The whole fetch failed, so every source is unknown — not just Ontario.
      for (const { freshnessId } of CANADA_ROAD_FRESHNESS_IDS) {
        dataFreshness.recordError(freshnessId, String(error));
      }
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

  async loadCanadaAlerts(): Promise<void> {
    try {
      const alerts = await fetchCanadaAlerts();
      this.ctx.map?.setCanadaAlerts(alerts);
      this.ctx.map?.setLayerReady('canadaAlerts', alerts.length > 0);
      this.ctx.statusPanel?.updateFeed('Canada alerts', { status: 'ok', itemCount: alerts.length });
    } catch (error) {
      this.ctx.map?.setLayerReady('canadaAlerts', false);
      this.ctx.statusPanel?.updateFeed('Canada alerts', { status: 'error' });
    }
  }

  async loadIntelligenceSignals(): Promise<void> {
    const _desktopLocked = isDesktopRuntime() && !hasPremiumAccess();
    const tasks: Promise<void>[] = [];

    tasks.push((async () => {
      try {
        const outages = await fetchInternetOutages();
        this.ctx.intelligenceCache.outages = outages;
        await runSignalAggregator(this.ctx.statusPanel, 'outages', (aggregator) => aggregator.ingestOutages(outages));
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
        await runSignalAggregator(this.ctx.statusPanel, 'protests', (aggregator) => aggregator.ingestProtests(protestData.events));
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
        this.ctx.intelligenceCache.conflicts = conflictData.events;
        ingestConflictsForCountryData(conflictData.events);
        if (conflictData.count > 0) dataFreshness.recordUpdate('acled_conflict', conflictData.count);
      } catch (error) {
        console.error('[Intelligence] Conflict events fetch failed:', error);
        dataFreshness.recordError('acled_conflict', String(error));
      }
    })());

    const hydratedUcdp = getHydratedData('ucdpEvents') as import('@/services/conflict').HydratedUcdpPayload | undefined;

    tasks.push((async () => {
      try {
        const militaryVessels = await getMilitaryVesselsModule();
        if (militaryVessels.isMilitaryVesselTrackingConfigured()) {
          militaryVessels.initMilitaryVesselStream();
        }
        const [flightData, vesselData] = await Promise.all([
          fetchMilitaryFlights(),
          militaryVessels.fetchMilitaryVessels(),
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
        await runSignalAggregator(this.ctx.statusPanel, 'military tracks', (aggregator) => {
          aggregator.ingestFlights(flightData.flights);
          aggregator.ingestVessels(vesselData.vessels);
        });
        dataFreshness.recordUpdate('opensky', flightData.flights.length);
        updateAndCheck([
          { type: 'military_flights', region: 'global', count: flightData.flights.length },
          { type: 'vessels', region: 'global', count: vesselData.vessels.length },
        ]).then(async anomalies => {
          if (anomalies.length > 0) {
            await runSignalAggregator(this.ctx.statusPanel, 'temporal anomalies', (aggregator) => aggregator.ingestTemporalAnomalies(anomalies));
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
          await this.runMilitarySurgeAnalysis(flightData.flights);
        }
      } catch (error) {
        // A teardown that races an in-flight vessel load is a deliberate
        // cancellation, not a real fetch failure — don't pollute freshness.
        if (isVesselRuntimeStoppedError(error)) return;
        console.error('[Intelligence] Military fetch failed:', error);
        dataFreshness.recordError('opensky', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const protestEvents = await protestsTask;
        // The bootstrap payload is a dashboard projection (#5300) — 150 rows, not
        // 2,000. The panel is fine with that (it renders 50/tab and takes its
        // counts from the precomputed aggregates), but the map draws every event.
        // When its layer is on, skip hydration so fetchUcdpEvents goes to the RPC
        // and returns the full set.
        const wantsFullUcdpSet = this.ctx.mapLayers.ucdpEvents;
        const result = await fetchUcdpEvents(wantsFullUcdpSet ? undefined : hydratedUcdp);
        if (!result.success) {
          // listUcdpEvents is a pure Redis-read (gold standard). Retrying returns
          // the same empty result until the Railway seed refreshes the key.
          dataFreshness.recordError('ucdp_events', 'UCDP events unavailable (retaining prior event state)');
          this.showColdLoadError('ucdp-events');
          return;
        }
        const acledEvents = protestEvents.map(e => ({
          latitude: e.lat, longitude: e.lon, event_date: e.time.toISOString(), fatalities: e.fatalities ?? 0,
        }));
        const events = deduplicateAgainstAcled(result.data, acledEvents);
        const aggregates = !wantsFullUcdpSet && hydratedUcdp?.aggregates && hydratedUcdp.dedupeIndex
          ? deduplicateUcdpProjectionAggregates(hydratedUcdp.aggregates, hydratedUcdp.dedupeIndex, acledEvents)
          : undefined;
        (this.ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(
          events,
          aggregates,
        );
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
          this.showColdLoadError('displacement');
          return;
        }
        const data = unhcrResult.data;
        this.callPanel('displacement', 'setData', data);
        ingestDisplacementForCountryData(data.countries);
        if (this.ctx.mapLayers.displacement && data.topFlows) {
          this.ctx.map?.setDisplacementFlows(data.topFlows);
        }
        if (data.countries.length > 0) dataFreshness.recordUpdate('unhcr', data.countries.length);
      } catch (error) {
        console.error('[Intelligence] UNHCR displacement fetch failed:', error);
        this.showColdLoadError('displacement');
        dataFreshness.recordError('unhcr', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          this.showColdLoadError('climate');
          return;
        }
        const anomalies = climateResult.anomalies;
        this.callPanel('climate', 'setAnomalies', anomalies);
        ingestClimateForCountryData(anomalies);
        if (this.ctx.mapLayers.climate) {
          this.ctx.map?.setClimateAnomalies(anomalies);
        }
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        this.showColdLoadError('climate');
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
          this.ctx.intelligenceCache.orefAlerts = { alertCount, historyCount24h };
          if (data.alerts?.length) dispatchOrefBreakingAlert(data.alerts);
          onOrefAlertsUpdate((update) => {
            this.callPanel('oref-sirens', 'setData', update);
            const updAlerts = update.alerts?.length ?? 0;
            const updHistory = update.historyCount24h ?? 0;
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
            this.ctx.intelligenceCache.gpsJamming = [];
            ingestGpsJammingForCountryData([]);
            this.ctx.map?.setLayerReady('gpsJamming', false);
            return;
          }
          this.ctx.intelligenceCache.gpsJamming = data.hexes;
          ingestGpsJammingForCountryData(data.hexes);
          if (this.ctx.mapLayers.gpsJamming) {
            await this.ctx.map?.setGpsJamming(data.hexes);
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

    this.refreshCiiAndBrief();
    console.log('[Intelligence] All signals loaded; canonical CII state refreshed');
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
      await runSignalAggregator(this.ctx.statusPanel, 'outages', (aggregator) => aggregator.ingestOutages(outages));
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
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: this.ctx.cyberThreatsCache.length });
      return;
    }

    try {
      const { fetchCyberThreats } = await import('@/services/cyber');
      const threats = await fetchCyberThreats({ limit: 500, days: 14 });
      this.ctx.cyberThreatsCache = threats;
      this.ctx.map?.setCyberThreats(threats);
      this.ctx.map?.setLayerReady('cyberThreats', threats.length > 0);
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
    if (!IRAN_ATTACKS_ENABLED) {
      this.ctx.map?.setLayerReady('iranAttacks', false);
      return;
    }
    try {
      const events = await fetchIranEvents();
      this.ctx.intelligenceCache.iranEvents = events;
      this.ctx.map?.setIranEvents(events);
      this.ctx.map?.setLayerReady('iranAttacks', events.length > 0);
      const coerced = events.map(e => ({ ...e, timestamp: Number(e.timestamp) || 0 }));
      await runSignalAggregator(this.ctx.statusPanel, 'iran conflict events', (aggregator) => aggregator.ingestConflictEvents(coerced));
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
      this.ctx.intelligenceCache.aisDisruptions = disruptions;
      await runSignalAggregator(this.ctx.statusPanel, 'AIS disruptions', (aggregator) => aggregator.ingestAisDisruptions(disruptions));
      updateAndCheck([
        { type: 'ais_gaps', region: 'global', count: disruptions.length },
      ]).then(async anomalies => {
        if (anomalies.length > 0) {
          await runSignalAggregator(this.ctx.statusPanel, 'temporal anomalies', (aggregator) => aggregator.ingestTemporalAnomalies(anomalies));
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
      const { fetchCableActivity } = await import('@/services/cable-activity');
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
      await runSignalAggregator(this.ctx.statusPanel, 'protests', (aggregator) => aggregator.ingestProtests(protestData.events));
      const protestCount = protestData.sources.acled + protestData.sources.gdelt;
      if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
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
      const { fetchFlightDelays } = await import('@/services/aviation');
      const delays = await fetchFlightDelays();
      this.ctx.map?.setFlightDelays(delays);
      this.ctx.map?.setLayerReady('flights', delays.length > 0);
      this.ctx.intelligenceCache.flightDelays = delays;
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
      const militaryVessels = await getMilitaryVesselsModule();
      if (militaryVessels.isMilitaryVesselTrackingConfigured()) {
        militaryVessels.initMilitaryVesselStream();
      }
      const [flightData, vesselData] = await Promise.all([
        fetchMilitaryFlights(),
        militaryVessels.fetchMilitaryVessels(),
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
      await runSignalAggregator(this.ctx.statusPanel, 'military tracks', (aggregator) => {
        aggregator.ingestFlights(flightData.flights);
        aggregator.ingestVessels(vesselData.vessels);
      });
      updateAndCheck([
        { type: 'military_flights', region: 'global', count: flightData.flights.length },
        { type: 'vessels', region: 'global', count: vesselData.vessels.length },
      ]).then(async anomalies => {
        if (anomalies.length > 0) {
          await runSignalAggregator(this.ctx.statusPanel, 'temporal anomalies', (aggregator) => aggregator.ingestTemporalAnomalies(anomalies));
        }
      }).catch(() => { });
      this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
      if (!isInLearningMode()) {
        await this.runMilitarySurgeAnalysis(flightData.flights);
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
      // A teardown that races an in-flight vessel load is a deliberate
      // cancellation, not a real fetch failure — leave feed/api state intact.
      if (isVesselRuntimeStoppedError(error)) return;
      this.ctx.map?.setLayerReady('military', false);
      this.ctx.statusPanel?.updateFeed('Military', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'error' });
      dataFreshness.recordError('opensky', String(error));
    }
  }

  private async runMilitarySurgeAnalysis(flights: MilitaryFlight[]): Promise<void> {
    try {
      // military-surge pulls bases-expanded, so keep it off the eager boot graph
      // and make its optional enrichment non-fatal to the military fetch path.
      const { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal } = await import('@/services/military-surge');
      const surgeAlerts = analyzeFlightsForSurge(flights);
      if (surgeAlerts.length > 0) {
        const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
        addToSignalHistory(surgeSignals);
        if (this.shouldShowIntelligenceNotifications()) this.showSignalNotification(surgeSignals, 'Military surge');
      }
      const foreignAlerts = detectForeignMilitaryPresence(flights);
      if (foreignAlerts.length > 0) {
        const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
        addToSignalHistory(foreignSignals);
        if (this.shouldShowIntelligenceNotifications()) this.showSignalNotification(foreignSignals, 'Foreign presence');
      }
    } catch (error) {
      console.warn('[Intelligence] Military surge analysis skipped:', error);
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
      const { fetchFredData } = await import('@/services/economic');
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
      const {
        fetchOilAnalytics, fetchCrudeInventoriesRpc, fetchNatGasStorageRpc,
        getEuGasStorageData, getOilStocksAnalysisData, fetchLngVulnerability,
      } = await import('@/services/economic');
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

  async loadGlobalTenders(filters?: GlobalTenderFilters, append = false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const procurementPanel = this.ctx.panels['global-procurement'] as GlobalProcurementPanel | undefined;
    if (!procurementPanel) return;
    if (
      filters === undefined
      && signal === undefined
      && this.activeGlobalTenderScopedGeneration !== null
    ) return;
    const requestGeneration = ++this.globalTenderGeneration;
    this.activeGlobalTenderScopedGeneration = signal ? requestGeneration : null;
    const previousGlobalTenderFilters = { ...this.globalTenderFilters };
    const requestFilters = filters ?? this.globalTenderFilters;
    this.globalTenderFilters = { ...requestFilters, cursor: '' };
    let canceledFiltersRestored = false;
    const releaseScopedRequest = () => {
      if (this.activeGlobalTenderScopedGeneration === requestGeneration) {
        this.activeGlobalTenderScopedGeneration = null;
      }
    };
    const restoreCanceledFilters = () => {
      if (
        canceledFiltersRestored
        || signal?.aborted !== true
        || requestGeneration !== this.globalTenderGeneration
      ) return;
      canceledFiltersRestored = true;
      this.globalTenderFilters = previousGlobalTenderFilters;
    };
    signal?.addEventListener('abort', () => {
      restoreCanceledFilters();
      releaseScopedRequest();
    }, { once: true });
    const isCanceledOrStale = () => {
      restoreCanceledFilters();
      return signal?.aborted === true || requestGeneration !== this.globalTenderGeneration;
    };
    try {
      procurementPanel.setRequestHandler((nextFilters, shouldAppend, requestSignal) => {
        return this.loadGlobalTenders(nextFilters, shouldAppend, requestSignal);
      });
      if (!hasPremiumAccess()) {
        if (isCanceledOrStale()) return;
        procurementPanel.clear();
        return;
      }
      if (isCanceledOrStale()) return;
      procurementPanel.setLoading(true, append);
      try {
        const { fetchGlobalTenders } = await import('@/services/global-tenders');
        if (isCanceledOrStale()) return;
        const data = await fetchGlobalTenders(requestFilters, signal);
        if (isCanceledOrStale()) return;
        if (!hasPremiumAccess()) {
          if (isCanceledOrStale()) return;
          procurementPanel.clear();
          return;
        }
        if (isCanceledOrStale()) return;
        procurementPanel.update(data, append);
        if (isCanceledOrStale()) return;
        this.ctx.statusPanel?.updateApi('Global Procurement', {
          status: !data.dataAvailable ? 'error' : ['partial', 'stale'].includes(data.availability) ? 'warning' : 'ok',
        });
      } catch (error) {
        if (isCanceledOrStale() || !hasPremiumAccess()) return;
        console.warn('[App] Global tenders failed:', error);
        if (isCanceledOrStale()) return;
        procurementPanel.showUnavailable();
        if (isCanceledOrStale()) return;
        this.ctx.statusPanel?.updateApi('Global Procurement', { status: 'error' });
      }
    } finally {
      releaseScopedRequest();
    }
  }

  async clearGlobalTenders(): Promise<void> {
    this.globalTenderGeneration += 1;
    this.activeGlobalTenderScopedGeneration = null;
    this.globalTenderFilters = {};
    const procurementPanel = this.ctx.panels['global-procurement'] as GlobalProcurementPanel | undefined;
    procurementPanel?.clear();
    // The only call site is fire-and-forget — `void this.dataLoader
    // .clearGlobalTenders()` in App.ts on the premium->free transition — so an
    // unguarded rejection here does not degrade one panel, it lands as an
    // unhandled rejection (WORLDMONITOR-100, reported by Sentry with mechanism
    // `onunhandledrejection`).
    //
    // Swallowing does NOT weaken the "Pro data must not survive a downgrade"
    // guarantee this method exists to enforce. Everything user-visible — the
    // generation bump, the filter reset, the panel clear — already ran above,
    // synchronously, before the import. And the cache this clears lives on the
    // module's own `tenderBreaker` (`persistCache: false`, so in-memory only):
    // if the import fails the module never evaluated in this page, so there is
    // no breaker and no cached Pro data to clear; if it ever did evaluate, the
    // specifier resolves from the module registry and cannot fail. A failure
    // here therefore implies an empty cache, not an unclearable one.
    try {
      const { clearGlobalTenderCache } = await import('@/services/global-tenders');
      clearGlobalTenderCache();
    } catch (e) {
      console.warn('[App] Global tender cache clear failed:', e);
    }
  }

  async loadBisData(): Promise<void> {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    try {
      const { fetchBisData } = await import('@/services/economic');
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
      const { fetchBlsData } = await import('@/services/economic');
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
    // Trade-policy is PRO-gated. Short-circuit for anonymous/free users so
    // we don't fire 6 RPCs that all 401 on every page load — fixes the
    // console-noise + Sentry-noise bug from the 2026-04-22 trace.
    if (!hasPremiumAccess()) return;
    const tradePanel = this.ctx.panels['trade-policy'] as TradePolicyPanel | undefined;
    if (!tradePanel) return;

    try {
      const {
        fetchTradeRestrictions, fetchTariffTrends, fetchTradeFlows,
        fetchTradeBarriers, fetchCustomsRevenue, fetchComtradeFlows,
      } = await import('@/services/trade');
      const [restrictions, tariffs, flows, barriers, revenue, comtrade] = await Promise.allSettled([
        fetchTradeRestrictions([], 50),
        fetchTariffTrends('840', '156', '', 10),
        // Partner '000' is World. This asked for '156' (China) until #6309:
        // WTO's ITS_MTV_AX/AM indicators publish a World total only and answer
        // 204 for any other partner, so the flows tab requested a combination
        // the seed could never hold and rendered the upstream-unavailable
        // banner on every load.
        fetchTradeFlows('840', '000', 10),
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
      const {
        fetchShippingRates, fetchChokepointStatus, fetchCriticalMinerals, fetchMineralProduction, fetchShippingStress,
      } = await import('@/services/supply-chain');
      const [shipping, chokepoints, minerals, mineralProduction, stress] = await Promise.allSettled([
        fetchShippingRates(),
        fetchChokepointStatus(),
        fetchCriticalMinerals(),
        fetchMineralProduction(),
        fetchShippingStress(),
      ]);

      const shippingData = shipping.status === 'fulfilled' ? shipping.value : null;
      const chokepointData = chokepoints.status === 'fulfilled' ? chokepoints.value : null;
      const mineralsData = minerals.status === 'fulfilled' ? minerals.value : null;
      const mineralProductionData = mineralProduction.status === 'fulfilled' ? mineralProduction.value : null;
      const stressData = stress.status === 'fulfilled' ? stress.value : null;

      if (shippingData) scPanel.updateShippingRates(shippingData);
      if (chokepointData) scPanel.updateChokepointStatus(chokepointData);
      if (chokepointData) this.ctx.map?.setChokepointData(chokepointData);
      if (mineralsData) scPanel.updateCriticalMinerals(mineralsData);
      if (mineralProductionData) scPanel.updateMineralProduction(mineralProductionData);
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

  async loadChinaCorridors(options?: { skipIfPopulated?: boolean }): Promise<void> {
    const panel = this.ctx.panels['china-corridors'] as ChinaCorridorPanel | undefined;
    if (!panel) return;
    // The scroll-driven loadAllData pass re-enters this on every scroll event,
    // and the corridor service deliberately has no client cache (cacheTtlMs: 0)
    // — so a repeat here is a full RPC. The 15-min refresh scheduler owns
    // updates once the panel is populated.
    if (options?.skipIfPopulated && panel.hasData()) return;
    try {
      await panel.fetchData();
    } catch (error) {
      console.error('[App] China corridors failed:', error);
      panel.showError('China corridor data unavailable', () => void this.loadChinaCorridors());
    }
  }

  async loadChinaActivityNowcast(options?: { skipIfPopulated?: boolean }): Promise<void> {
    const panel = this.ctx.panels['china-activity-nowcast'] as ChinaActivityNowcastPanel | undefined;
    if (!panel) return;
    // Same contract as loadChinaCorridors: scroll re-entries must not refire
    // the uncached nowcast RPC once the panel is populated.
    if (options?.skipIfPopulated && panel.hasData()) return;
    try {
      await panel.fetchData();
    } catch (error) {
      console.error('[App] China activity nowcast failed:', error);
      panel.showError('China activity comparison unavailable', () => void this.loadChinaActivityNowcast());
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
    // Queued, for the same reason as the cluster fan-out above: the boot call
    // site is inside loadNews, which runs ONCE per work-list signature. Monitors
    // is an opt-in panel, so it is always enabled mid-session and always mounts
    // after that pass — an optional-chained call left its results area blank,
    // which reads as "your keywords matched nothing" rather than as a panel that
    // never got the news. The other two call sites (monitor edited, monitors
    // list changed) run with the panel mounted and take callPanel's direct path.
    this.callPanel('monitors', 'renderResults', this.ctx.allNews);
  }

  // Lazy-load the tech-activity service (→ tech-hub-index → the ~62KB tech-geo
  // table) only when the lazy tech-hubs panel is mounted, so the table stays off
  // the eager dashboard critical path. Non-critical panel data — the panel keeps
  // its previous contents on load failure, but the failure is logged: a silent
  // swallow here leaves the panel on "Loading..." with no way to diagnose it. (#4404)
  private applyTechHubActivities(): void {
    const techHubsPanel = this.ctx.panels['tech-hubs'] as TechHubsPanel | undefined;
    if (!techHubsPanel) return;
    void hydrateTechHubPanelFromClusters(techHubsPanel, this.ctx.latestClusters, { allowEmpty: true })
      .catch((err) => {
        console.error('[App] tech-hub activity hydration failed:', err);
      });
  }

  async runCorrelationAnalysis(): Promise<void> {
    try {
      if (this.ctx.latestClusters.length === 0 && this.ctx.allNews.length > 0) {
        this.ctx.latestClusters = mlWorker.isAvailable
          ? await clusterNewsHybrid(this.ctx.allNews)
          : await analysisWorker.clusterNews(this.ctx.allNews);
        this.ctx.clustersSettled = true;
      }

      if (this.ctx.latestClusters.length > 0) {
        dataFreshness.recordUpdate('gdelt', this.ctx.latestClusters.length);
        hydrateGeoHubPanelFromClusters(
          this.ctx.panels['geo-hubs'] as GeoHubsPanel | undefined,
          this.ctx.latestClusters,
          { allowEmpty: true },
        );
        this.applyTechHubActivities();
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

      const keywordSpikeSignals = await drainTrendingSignalQueue();
      const allSignals = [...signals, ...geoSignals, ...keywordSpikeSignals];
      if (allSignals.length > 0) {
        addToSignalHistory(allSignals);
        if (this.shouldShowIntelligenceNotifications()) this.showSignalNotification(allSignals, 'Correlation');
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

        this.ctx.intelligenceCache.satelliteFires = satelliteFires;
        await runSignalAggregator(this.ctx.statusPanel, 'satellite fires', (aggregator) => aggregator.ingestSatelliteFires(satelliteFires));

        this.ctx.map?.setFires(toMapFires(flat));

        (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update(stats, totalCount);

        dataFreshness.recordUpdate('firms', totalCount);
      } else {
        this.ctx.intelligenceCache.satelliteFires = [];
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

  // Bumped to v2 alongside src/services/rss.ts CACHE_PREFIX (`feed:` →
  // `feed:v2:`). Pre-v2 entries here serialize NewsItem WITHOUT the new
  // `pubDateMissing` flag — on hydrate they get `undefined`, which
  // `effectivePubDateMs` treats as `false`, so items that previously had
  // synthesized `Date.now()` stamps would fraudulently claim freshness
  // for the 24h gate window. Pre-v2 entries are left to TTL out (no
  // explicit invalidation needed).
  private static readonly HAPPY_ITEMS_CACHE_KEY = 'happy-all-items:v2';

  async hydrateHappyPanelsFromCache(): Promise<void> {
    try {
      type CachedItem = Omit<NewsItem, 'pubDate'> & { pubDate?: number };
      const entry = await getPersistentCache<CachedItem[]>(DataLoaderManager.HAPPY_ITEMS_CACHE_KEY);
      if (!entry || !entry.data || entry.data.length === 0) return;
      if (Date.now() - entry.updatedAt > 24 * 60 * 60 * 1000) return;

      const items: NewsItem[] = entry.data.map(item => ({
        ...item,
        pubDate: new Date(displayPubDateMs(item)),
      }));

      const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
      this.callPanel('breakthroughs', 'setItems',
        items.filter(item => scienceSources.includes(item.source) || item.happyCategory === 'science-health')
      );
      this.callPanel('spotlight', 'setHeroStory',
        items.filter(item => item.happyCategory === 'humanity-kindness')
          .sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a))[0]
      );
      this.callPanel('digest', 'setStories',
        [...items].sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a)).slice(0, 5)
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
      merged.sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a));
      this.callPanel('positive-feed', 'renderPositiveNews', merged);
    }

    const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
    const scienceItems = this.ctx.happyAllItems.filter(item =>
      scienceSources.includes(item.source) || item.happyCategory === 'science-health'
    );
    this.callPanel('breakthroughs', 'setItems', scienceItems);

    const heroItem = this.ctx.happyAllItems
      .filter(item => item.happyCategory === 'humanity-kindness')
      .sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a))[0];
    this.callPanel('spotlight', 'setHeroStory', heroItem);

    const digestItems = [...this.ctx.happyAllItems]
      .sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a))
      .slice(0, 5);
    this.callPanel('digest', 'setStories', digestItems);

    setPersistentCache(
      DataLoaderManager.HAPPY_ITEMS_CACHE_KEY,
      this.ctx.happyAllItems.map(item => ({
        ...item,
        pubDate: displayPubDateMs(item),
      }))
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
    const result = await fetchProgressData();
    this.callPanel('progress', 'setData', result);
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
    const { fetchRenewableEnergyData, fetchEnergyCapacity } = await import('@/services/renewable-energy-data');
    const result = await fetchRenewableEnergyData();
    this.callPanel('renewable', 'setData', result);
    if (SITE_VARIANT === 'happy' && result.state === 'live' && result.data?.globalPercentage) {
      checkMilestones({
        renewablePercent: result.data.globalPercentage,
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
      await runSignalAggregator(this.ctx.statusPanel, 'sanctions pressure', (aggregator) => aggregator.ingestSanctionsPressure(result.countries));
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
      await runSignalAggregator(this.ctx.statusPanel, 'radiation observations', (aggregator) => aggregator.ingestRadiationObservations(result.observations));
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

  async loadAaiiSentiment(): Promise<void> {
    const panel = this.ctx.panels['aaii-sentiment'] as AAIISentimentPanel | undefined;
    if (!panel) return;
    try {
      await panel.fetchData();
    } catch (e) {
      console.error('[App] AAII sentiment load failed:', e);
    }
  }

  async loadMarketBreadth(): Promise<void> {
    const panel = this.ctx.panels['market-breadth'] as MarketBreadthPanel | undefined;
    if (!panel) return;
    try {
      await panel.fetchData();
    } catch (e) {
      console.error('[App] Market breadth load failed:', e);
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
