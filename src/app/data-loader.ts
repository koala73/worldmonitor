import type { AppContext, AppModule } from '@/app/app-context';
import { enqueuePanelCall } from '@/app/pending-panel-data';
import type { NewsItem, MapLayers, ThreatLevel, EventCategory } from '@/types';
import type { TimeRange } from '@/components';
import {
  FEEDS,
  SITE_VARIANT,
} from '@/config';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import {
  fetchCategoryFeeds,
  getFeedFailures,
  updateBaseline,
  calculateDeviation,
  fetchReitQuotes,
  fetchReitCorrelation,
  fetchReitProperties,
  fetchReitSocial,
} from '@/services';
import { clusterNewsHybrid } from '@/services/clustering';
import { dataFreshness } from '@/services/data-freshness';
import { debounce } from '@/utils';
import { isFeatureEnabled } from '@/services/runtime-config';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';

// ---------- Digest types (formerly from generated proto client) ----------
interface DigestNewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: string;
  isAlert: boolean;
  locationName?: string;
  location?: { latitude: number; longitude: number };
  threat?: {
    level?: string;
    category?: string;
    confidence?: number;
    source?: string;
  };
}

interface DigestCategory {
  items?: DigestNewsItem[];
}

interface ListFeedDigestResponse {
  categories?: Record<string, DigestCategory>;
}

const DIGEST_LEVEL_MAP: Record<string, ThreatLevel> = {
  THREAT_LEVEL_UNSPECIFIED: 'info',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_CRITICAL: 'critical',
};

function digestItemToNewsItem(p: DigestNewsItem): NewsItem {
  const level = DIGEST_LEVEL_MAP[p.threat?.level ?? 'THREAT_LEVEL_UNSPECIFIED'] ?? 'info';
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    threat: p.threat ? {
      level,
      category: (p.threat.category ?? 'unknown') as EventCategory,
      confidence: p.threat.confidence ?? 0,
      source: (p.threat.source || 'keyword') as 'keyword' | 'ml' | 'llm',
    } : undefined,
    ...(p.locationName && { locationName: p.locationName }),
    ...(p.location && { lat: p.location.latitude, lon: p.location.longitude }),
  };
}

// ---------- DataLoader interface ----------

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: unknown[]) => void;
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;
  /** Kept for interface compatibility (App.ts passes callbacks to constructor). */
  public readonly callbacks: DataLoaderCallbacks;

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

  private digestBreaker = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, cooldownUntil: 0 };
  private readonly digestRequestTimeoutMs = 8000;
  private readonly digestBreakerCooldownMs = 5 * 60 * 1000;
  private readonly persistedDigestMaxAgeMs = 6 * 60 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackBatchSize = 2;
  private lastGoodDigest: ListFeedDigestResponse | null = null;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    // No market watchlist or framework subscriptions needed in REITs-only mode
  }

  destroy(): void {
    this.applyTimeRangeFilterToNewsPanelsDebounced.cancel();
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

  private isPanelNearViewport(panelId: string, marginPx = 400): boolean {
    const panel = this.ctx.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
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

    const tasks: Array<{ name: string; task: Promise<void> }> = [
      { name: 'news', task: runGuarded('news', () => this.loadNews()) },
    ];

    // REIT data
    if (shouldLoad('reits') || shouldLoad('reit-correlation') || shouldLoad('reit-social')) {
      tasks.push({ name: 'reits', task: runGuarded('reits', () => this.loadReits()) });
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
  }

  async loadDataForLayer(_layer: keyof MapLayers): Promise<void> {
    // REITs-only mode: map layers are handled by the REIT properties layer
    // which is loaded as part of loadReits(). No per-layer loading needed.
  }

  stopLayerActivity(_layer: keyof MapLayers): void {
    // No layer-specific activity to stop in REITs-only mode
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

  private async loadNewsCategory(category: string, feeds: typeof FEEDS[keyof typeof FEEDS], digest?: ListFeedDigestResponse | null): Promise<NewsItem[]> {
    try {
      const panel = this.ctx.newsPanels[category];

      const feedsArray = feeds as Array<{ name: string; url: string }>;
      const enabledFeeds = (feedsArray ?? []).filter((f: { name: string }) => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }
      const enabledNames = new Set(enabledFeeds.map((f: { name: string }) => f.name));

      // Digest branch: server already aggregated feeds — map items to client types
      if (digest?.categories && category in digest.categories) {
        const items = (digest.categories[category]?.items ?? [])
          .map(digestItemToNewsItem)
          .filter((i: NewsItem) => enabledNames.has(i.source));

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

      const staleItems = this.getStaleNewsItems(category).filter((i: NewsItem) => enabledNames.has(i.source));
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
        onBatch: (partialItems: NewsItem[]) => {
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

        if (items.length === 0) {
          const failures = getFeedFailures();
          const failedFeeds = fallbackFeeds.filter((f: { name: string }) => failures.has(f.name));
          if (failedFeeds.length > 0) {
            const names = failedFeeds.map((f: { name: string }) => f.name).join(', ');
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
    // Localhost mock — RSS proxy not available on dev server
    if (import.meta.env?.DEV && SITE_VARIANT === 'reits') {
      const now = new Date();
      type MockArticle = { title: string; url: string; source: string; pubDate: string };
      const mockNews: Record<string, MockArticle[]> = {
        'reit-us': [
          { title: 'Prologis Reports Record Industrial REIT Occupancy at 97.2% in Q1 2026', url: '#', source: 'REIT.com', pubDate: new Date(now.getTime() - 2 * 3600000).toISOString() },
          { title: 'Simon Property Group Announces $500M Mall Renovation Program', url: '#', source: 'Nareit', pubDate: new Date(now.getTime() - 4 * 3600000).toISOString() },
          { title: 'Office REITs Face Headwinds as Remote Work Persists — Vacancy Hits 18.5%', url: '#', source: 'GlobeSt', pubDate: new Date(now.getTime() - 6 * 3600000).toISOString() },
          { title: 'Digital Realty Expands Ashburn Data Center Campus with $2B Investment', url: '#', source: 'Bisnow', pubDate: new Date(now.getTime() - 8 * 3600000).toISOString() },
          { title: 'Realty Income Dividend Yield Reaches 5.4% — Analysts Say Buy', url: '#', source: 'Commercial Observer', pubDate: new Date(now.getTime() - 12 * 3600000).toISOString() },
          { title: 'Fed Rate Decision Sparks Rally in Rate-Sensitive REITs', url: '#', source: 'REIT News', pubDate: new Date(now.getTime() - 18 * 3600000).toISOString() },
        ],
        'reit-china': [
          { title: '华夏中海商业REIT分红率达4.0% 佛山映月湖环宇城出租率稳定', url: '#', source: '赢商网', pubDate: new Date(now.getTime() - 1 * 3600000).toISOString() },
          { title: '华润万象生活发布2025年报 青岛万象城营收增长12%', url: '#', source: '观点地产', pubDate: new Date(now.getTime() - 3 * 3600000).toISOString() },
          { title: '首批消费REITs业绩亮眼 物美超市客流量同比增8%', url: '#', source: '公募REITs', pubDate: new Date(now.getTime() - 5 * 3600000).toISOString() },
          { title: '上海城投宽庭长租公寓出租率达95% 江湾社区满租', url: '#', source: '商业地产', pubDate: new Date(now.getTime() - 7 * 3600000).toISOString() },
          { title: '深圳保障性租赁住房REITs扩募获批 新增龙华区项目', url: '#', source: '保障房', pubDate: new Date(now.getTime() - 10 * 3600000).toISOString() },
          { title: '首创奥特莱斯昆山店国庆客流破纪录 日均3.5万人次', url: '#', source: '赢商网', pubDate: new Date(now.getTime() - 24 * 3600000).toISOString() },
        ],
        'property-markets': [
          { title: 'CBRE: Global Commercial Real Estate Investment Volumes Rise 15% in Q1', url: '#', source: 'CBRE Research', pubDate: new Date(now.getTime() - 2 * 3600000).toISOString() },
          { title: 'JLL: Asia-Pacific Office Market Stabilizing — Shanghai and Singapore Lead Recovery', url: '#', source: 'JLL', pubDate: new Date(now.getTime() - 6 * 3600000).toISOString() },
          { title: '30-Year Mortgage Rate Falls to 6.2% — Lowest Since 2024', url: '#', source: 'Mortgage Rates', pubDate: new Date(now.getTime() - 10 * 3600000).toISOString() },
          { title: 'US Industrial Vacancy Rate Remains Near Historic Lows at 4.8%', url: '#', source: 'Property Markets', pubDate: new Date(now.getTime() - 14 * 3600000).toISOString() },
        ],
      };
      // Wait for panels to be created by panel-layout, then inject
      const renderMockHtml = (items: MockArticle[]) => items.map(item =>
        `<div class="news-item" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:12px;color:var(--text);line-height:1.4">${item.title}</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:3px">${item.source} · ${new Date(item.pubDate).toLocaleTimeString()}</div>
        </div>`
      ).join('');

      const doInject = () => {
        for (const [category, items] of Object.entries(mockNews)) {
          const panel = this.ctx.newsPanels[category] ?? this.ctx.panels[category];
          if (panel) {
            // Bypass setContent debounce — write directly to DOM
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const el = (panel as any).content || (panel as any).getElement()?.querySelector('.panel-content');
            if (el) {
              el.innerHTML = renderMockHtml(items);
              // Clear loading state
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const panelEl = (panel as any).element || (panel as any).getElement();
              panelEl?.classList?.remove('panel-loading', 'panel-error');
            }
          }
        }
      };
      setTimeout(doInject, 2000);
      setTimeout(doInject, 5000);
      return;
    }

    // Fire digest fetch early (non-blocking) — await before category loop
    const digestPromise = this.tryFetchDigest();

    const categories = Object.entries(FEEDS)
      .filter((entry): entry is [string, typeof FEEDS[keyof typeof FEEDS]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const digest = await digestPromise;

    const maxCategoryConcurrency = 5;
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
        collectedNews.push(...result.value);
      } else {
        console.error(`[App] News category ${categories[idx]?.key} failed:`, result.reason);
      }
    });

    this.ctx.allNews = collectedNews;
    this.ctx.initialLoadComplete = true;

    this.ctx.map?.updateHotspotActivity(this.ctx.allNews);

    this.updateMonitorResults();

    try {
      this.ctx.latestClusters = await clusterNewsHybrid(this.ctx.allNews);

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
    }
  }

  async loadReits(): Promise<void> {
    const reitsPanel = this.ctx.panels['reits'] as import('@/components/REITPanel').REITPanel | undefined;
    const corrPanel = this.ctx.panels['reit-correlation'] as import('@/components/REITCorrelationPanel').REITCorrelationPanel | undefined;
    const socialPanel = this.ctx.panels['reit-social'] as import('@/components/REITSocialPanel').REITSocialPanel | undefined;

    try {
      // Fetch all REIT data in parallel
      const [quotesData, corrData, socialData, propsData] = await Promise.all([
        fetchReitQuotes(),
        fetchReitCorrelation(),
        fetchReitSocial(),
        fetchReitProperties(),
      ]);

      // Update REIT quotes panel
      reitsPanel?.renderQuotes(
        quotesData.quotes,
        quotesData.regime,
        quotesData.aiBriefing,
        quotesData.sectorRotation,
        quotesData.stale,
      );

      // Update correlation panel
      corrPanel?.renderCorrelation(corrData);

      // Update social panel
      socialPanel?.renderSocial(socialData);

      // Feed property data to map layer
      this.callPanel('deckgl-map', 'setReitPropertyData', propsData.properties, propsData.exposureSummaries);

      // Update detail panel with all data + default to 华夏中海商业
      const detailPanel = this.ctx.panels['reit-detail'] as import('@/components/REITDetailPanel').REITDetailPanel | undefined;
      if (detailPanel) {
        detailPanel.setData(quotesData.quotes, socialData.sentiments, propsData.exposureSummaries);
        detailPanel.showReit('180607.SZ');
      }

      // Status updates
      const hasQuotes = quotesData.quotes.length > 0;
      this.ctx.statusPanel?.updateApi('REIT Quotes', { status: hasQuotes ? 'ok' : 'error' });
      this.ctx.statusPanel?.updateApi('REIT Social', { status: socialData.stale ? 'error' : 'ok' });

      if (hasQuotes) {
        dataFreshness.recordUpdate('reits', quotesData.quotes.length);
      }
    } catch (e) {
      console.error('[App] REIT data load failed:', e);
      this.ctx.statusPanel?.updateApi('REIT Quotes', { status: 'error' });
      dataFreshness.recordError('reits', String(e));
    }
  }

  updateMonitorResults(): void {
    // Monitor panel renders keyword-matched news results
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monitorPanel = this.ctx.panels['monitors'] as { renderResults?: (items: NewsItem[]) => void } | undefined;
    monitorPanel?.renderResults?.(this.ctx.allNews);
  }
}
