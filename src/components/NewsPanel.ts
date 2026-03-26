import { Panel } from './Panel';
import { WindowedList } from './VirtualList';
import type { NewsItem, ClusteredEvent, DeviationLevel, RelatedAsset, RelatedAssetContext } from '@/types';
import { THREAT_PRIORITY } from '@/services/threat-classifier';
import { formatTime, getCSSColor } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { analysisWorker, enrichWithVelocityML, getClusterAssetContext, MAX_DISTANCE_KM, activityTracker, generateSummary, translateText } from '@/services';
import { getSourcePropagandaRisk, getSourceTier, getSourceType } from '@/config/feeds';
import { SITE_VARIANT } from '@/config';
import { t, getCurrentLanguage } from '@/services/i18n';
import { track } from '@/services/analytics';

type SortMode = 'relevance' | 'newest';

/** Threshold for enabling virtual scrolling */
const VIRTUAL_SCROLL_THRESHOLD = 15;

/** Summary cache TTL in milliseconds (10 minutes) */
const SUMMARY_CACHE_TTL = 10 * 60 * 1000;

/** Prepared cluster data for rendering */
interface PreparedCluster {
  cluster: ClusteredEvent;
  isNew: boolean;
  shouldHighlight: boolean;
  showNewTag: boolean;
}

export class NewsPanel extends Panel {
  private clusteredMode = true;
  private deviationEl: HTMLElement | null = null;
  private relatedAssetContext = new Map<string, RelatedAssetContext>();
  private onRelatedAssetClick?: (asset: RelatedAsset) => void;
  private onRelatedAssetsFocus?: (assets: RelatedAsset[], originLabel: string) => void;
  private onRelatedAssetsClear?: () => void;
  private isFirstRender = true;
  private windowedList: WindowedList<PreparedCluster> | null = null;
  private useVirtualScroll = true;
  private renderRequestId = 0;
  private boundScrollHandler: (() => void) | null = null;
  private boundClickHandler: (() => void) | null = null;

  // Sort mode toggle (#107)
  private sortMode!: SortMode;
  private sortBtn: HTMLButtonElement | null = null;
  private lastRawClusters: ClusteredEvent[] | null = null;
  private lastRawItems: NewsItem[] | null = null;

  // Panel summary feature
  private summaryBtn: HTMLButtonElement | null = null;
  private summaryContainer: HTMLElement | null = null;
  private currentHeadlines: string[] = [];
  private lastHeadlineSignature = '';
  private isSummarizing = false;

  // Optional risk score getter: computes 0-100 score per cluster for badge display
  private riskScoreGetter: ((cluster: ClusteredEvent) => number | null) | null = null;

  public setRiskScoreGetter(fn: (cluster: ClusteredEvent) => number | null): void {
    this.riskScoreGetter = fn;
  }

  constructor(id: string, title: string, infoTooltip?: string) {
    super({ id, title, showCount: true, trackActivity: true, infoTooltip });
    this.sortMode = this.loadSortMode();
    this.createDeviationIndicator();
    this.createSortToggle();
    this.createSummarizeButton();
    this.setupActivityTracking();
    this.initWindowedList();
    this.setupContentDelegation();
  }

  private initWindowedList(): void {
    this.windowedList = new WindowedList<PreparedCluster>(
      {
        container: this.content,
        chunkSize: 8, // Render 8 items per chunk
        bufferChunks: 1, // 1 chunk buffer above/below
      },
      (prepared) => this.renderClusterHtmlSafely(
        prepared.cluster,
        prepared.isNew,
        prepared.shouldHighlight,
        prepared.showNewTag
      ),
      () => this.bindRelatedAssetEvents()
    );
  }

  private setupActivityTracking(): void {
    // Register with activity tracker
    activityTracker.register(this.panelId);

    // Listen for new count changes
    activityTracker.onChange(this.panelId, (newCount) => {
      // Pulse if there are new items
      this.setNewBadge(newCount, newCount > 0);
    });

    // Mark as seen when panel content is scrolled
    this.boundScrollHandler = () => {
      activityTracker.markAsSeen(this.panelId);
    };
    this.content.addEventListener('scroll', this.boundScrollHandler);

    // Mark as seen on click anywhere in panel
    this.boundClickHandler = () => {
      activityTracker.markAsSeen(this.panelId);
    };
    this.element.addEventListener('click', this.boundClickHandler);
  }

  public setRelatedAssetHandlers(options: {
    onRelatedAssetClick?: (asset: RelatedAsset) => void;
    onRelatedAssetsFocus?: (assets: RelatedAsset[], originLabel: string) => void;
    onRelatedAssetsClear?: () => void;
  }): void {
    this.onRelatedAssetClick = options.onRelatedAssetClick;
    this.onRelatedAssetsFocus = options.onRelatedAssetsFocus;
    this.onRelatedAssetsClear = options.onRelatedAssetsClear;
  }

  private createDeviationIndicator(): void {
    const header = this.getElement().querySelector('.panel-header-left');
    if (header) {
      this.deviationEl = document.createElement('span');
      this.deviationEl.className = 'deviation-indicator';
      header.appendChild(this.deviationEl);
    }
  }

  // --- Sort toggle (#107) ---
  private get sortStorageKey(): string {
    return `wm_sort_${SITE_VARIANT}_${this.panelId}`;
  }

  private loadSortMode(): SortMode {
    try {
      const v = localStorage.getItem(this.sortStorageKey);
      return v === 'newest' ? 'newest' : 'relevance';
    } catch { return 'relevance'; }
  }

  private saveSortMode(): void {
    try { localStorage.setItem(this.sortStorageKey, this.sortMode); } catch { /* storage full */ }
  }

  private createSortToggle(): void {
    this.sortBtn = document.createElement('button');
    this.sortBtn.className = 'panel-sort-btn';
    this.updateSortButtonLabel();
    this.sortBtn.addEventListener('click', () => {
      this.sortMode = this.sortMode === 'relevance' ? 'newest' : 'relevance';
      track('news-sort-toggle', { mode: this.sortMode });
      this.saveSortMode();
      this.updateSortButtonLabel();
      // Re-render with cached data
      if (this.lastRawClusters) {
        this.renderClusters(this.lastRawClusters);
      } else if (this.lastRawItems) {
        this.renderFlat(this.lastRawItems);
      }
    });

    const countEl = this.header.querySelector('.panel-count');
    if (countEl) {
      this.header.insertBefore(this.sortBtn, countEl);
    } else {
      this.header.appendChild(this.sortBtn);
    }
  }

  private updateSortButtonLabel(): void {
    if (!this.sortBtn) return;
    // SVG icons for cross-platform consistency
    const icon = this.sortMode === 'newest'
      ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><polyline points="8,4 8,8 11,10"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M4 7l4 4 4-4"/><line x1="3" y1="14" x2="13" y2="14"/></svg>';
    const label = this.sortMode === 'newest'
      ? t('components.newsPanel.sortNewest') || 'Newest'
      : t('components.newsPanel.sortRelevance') || 'Relevance';
    const tooltip = `${t('components.newsPanel.sortBy') || 'Sort by'}: ${label}`;
    this.sortBtn.innerHTML = icon;
    this.sortBtn.title = tooltip;
    this.sortBtn.setAttribute('aria-label', tooltip);
  }

  private createSummarizeButton(): void {
    // Create summary container (inserted between header and content)
    this.summaryContainer = document.createElement('div');
    this.summaryContainer.className = 'panel-summary';
    this.summaryContainer.style.display = 'none';
    this.element.insertBefore(this.summaryContainer, this.content);

    // Event delegation: handle close button clicks inside summaryContainer
    // regardless of how many times innerHTML is replaced by showSummary()
    this.summaryContainer.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.panel-summary-close')) {
        this.hideSummary();
      }
    });

    // Create summarize button
    this.summaryBtn = document.createElement('button');
    this.summaryBtn.className = 'panel-summarize-btn';
    this.summaryBtn.innerHTML = '✨';
    this.summaryBtn.title = t('components.newsPanel.summarize');
    this.summaryBtn.addEventListener('click', () => {
      track('news-summarize', { panelId: this.panelId });
      this.handleSummarize();
    });

    // Insert before count element (use inherited this.header directly)
    const countEl = this.header.querySelector('.panel-count');
    if (countEl) {
      this.header.insertBefore(this.summaryBtn, countEl);
    } else {
      this.header.appendChild(this.summaryBtn);
    }
  }

  private async handleSummarize(): Promise<void> {
    if (this.isSummarizing || !this.summaryContainer || !this.summaryBtn) return;
    if (this.currentHeadlines.length === 0) return;

    // Check cache first (include variant, version, and language)
    const currentLang = getCurrentLanguage();
    const cacheKey = `panel_summary_v3_${SITE_VARIANT}_${this.panelId}_${currentLang}`;
    const cached = this.getCachedSummary(cacheKey);
    if (cached) {
      this.showSummary(cached);
      return;
    }

    // Show loading state
    this.isSummarizing = true;
    this.summaryBtn.innerHTML = '<span class="panel-summarize-spinner"></span>';
    this.summaryBtn.disabled = true;
    this.summaryContainer.style.display = 'block';
    this.summaryContainer.innerHTML = `<div class="panel-summary-loading">${t('components.newsPanel.generatingSummary')}</div>`;

    const sigAtStart = this.lastHeadlineSignature;

    try {
      const result = await generateSummary(this.currentHeadlines.slice(0, 8), undefined, this.panelId, currentLang);
      if (!this.element?.isConnected) return;
      if (this.lastHeadlineSignature !== sigAtStart) {
        this.hideSummary();
        return;
      }
      if (result?.summary) {
        this.setCachedSummary(cacheKey, result.summary);
        this.showSummary(result.summary);
      } else {
        this.summaryContainer.innerHTML = `<div class="panel-summary-error">${t('components.newsPanel.summaryError')}</div>`;
        setTimeout(() => this.hideSummary(), 3000);
      }
    } catch {
      if (!this.element?.isConnected) return;
      this.summaryContainer.innerHTML = `<div class="panel-summary-error">${t('components.newsPanel.summaryFailed')}</div>`;
      setTimeout(() => this.hideSummary(), 3000);
    } finally {
      this.isSummarizing = false;
      if (this.summaryBtn) {
        this.summaryBtn.innerHTML = '✨';
        this.summaryBtn.disabled = false;
      }
    }
  }

  private async handleTranslate(element: HTMLElement, text: string): Promise<void> {
    const currentLang = getCurrentLanguage();
    if (currentLang === 'en') return; // Assume news is mostly English, no need to translate if UI is English (or add detection later)

    const titleEl = element.closest('.item')?.querySelector('.item-title') as HTMLElement;
    if (!titleEl) return;

    const originalText = titleEl.textContent || '';

    // Visual feedback
    element.innerHTML = '...';
    element.style.pointerEvents = 'none';

    try {
      const translated = await translateText(text, currentLang);
      if (!this.element?.isConnected) return;
      if (translated) {
        titleEl.textContent = translated;
        titleEl.dataset.original = originalText;
        element.innerHTML = '✓';
        element.title = 'Original: ' + originalText;
        element.classList.add('translated');
      } else {
        element.innerHTML = '文';
        // Shake animation or error state could be added here
      }
    } catch (e) {
      if (!this.element?.isConnected) return;
      console.error('Translation failed', e);
      element.innerHTML = '文';
    } finally {
      if (element.isConnected) {
        element.style.pointerEvents = 'auto';
      }
    }
  }

  private showSummary(summary: string): void {
    if (!this.summaryContainer || !this.element?.isConnected) return;
    this.summaryContainer.style.display = 'block';
    this.summaryContainer.innerHTML = `
      <div class="panel-summary-content">
        <span class="panel-summary-text">${escapeHtml(summary)}</span>
        <button class="panel-summary-close" title="${t('components.newsPanel.close')}" aria-label="${t('components.newsPanel.close')}">×</button>
      </div>
    `;
    // Close button click is handled via event delegation on summaryContainer (set up in constructor)
  }

  private hideSummary(): void {
    if (!this.summaryContainer) return;
    this.summaryContainer.style.display = 'none';
    this.summaryContainer.innerHTML = '';
  }

  private getHeadlineSignature(): string {
    return JSON.stringify(this.currentHeadlines.slice(0, 5).sort());
  }

  private updateHeadlineSignature(): void {
    const newSig = this.getHeadlineSignature();
    if (newSig !== this.lastHeadlineSignature) {
      this.lastHeadlineSignature = newSig;
      if (this.summaryContainer?.style.display === 'block') {
        this.hideSummary();
      }
    }
  }

  private getCachedSummary(key: string): string | null {
    try {
      const cached = localStorage.getItem(key);
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      if (!parsed.headlineSignature) { localStorage.removeItem(key); return null; }
      if (parsed.headlineSignature !== this.lastHeadlineSignature) return null;
      if (Date.now() - parsed.timestamp > SUMMARY_CACHE_TTL) { localStorage.removeItem(key); return null; }
      return parsed.summary;
    } catch {
      return null;
    }
  }

  private setCachedSummary(key: string, summary: string): void {
    try {
      localStorage.setItem(key, JSON.stringify({
        headlineSignature: this.lastHeadlineSignature,
        summary,
        timestamp: Date.now(),
      }));
    } catch { /* storage full */ }
  }

  public setDeviation(zScore: number, percentChange: number, level: DeviationLevel): void {
    if (!this.deviationEl) return;

    if (level === 'normal') {
      this.deviationEl.textContent = '';
      this.deviationEl.className = 'deviation-indicator';
      return;
    }

    const arrow = zScore > 0 ? '↑' : '↓';
    const sign = percentChange > 0 ? '+' : '';
    this.deviationEl.textContent = `${arrow}${sign}${percentChange}%`;
    this.deviationEl.className = `deviation-indicator ${level}`;
    this.deviationEl.title = `z-score: ${zScore} (vs 7-day avg)`;
  }

  public override showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    this.lastRawClusters = null;
    this.lastRawItems = null;
    super.showError(message, onRetry, autoRetrySeconds);
  }

  public renderNews(items: NewsItem[]): void {
    if (items.length === 0) {
      this.renderRequestId += 1; // Cancel in-flight clustering from previous renders.
      this.setDataBadge('unavailable');
      this.showError(t('common.noNewsAvailable'));
      return;
    }

    this.setDataBadge('live');

    // Always show flat items immediately for instant visual feedback,
    // then upgrade to clustered view in the background when ready.
    this.renderFlat(items);

    if (this.clusteredMode) {
      void this.renderClustersAsync(items);
    }
  }

  public renderFilteredEmpty(message: string): void {
    this.renderRequestId += 1; // Cancel in-flight clustering from previous renders.
    this.lastRawClusters = null;
    this.lastRawItems = null;
    this.setDataBadge('live');
    this.setCount(0);
    this.relatedAssetContext.clear();
    this.currentHeadlines = [];
    this.updateHeadlineSignature();
    this.setContent(`<div class="panel-empty">${escapeHtml(message)}</div>`);
  }

  private async renderClustersAsync(items: NewsItem[]): Promise<void> {
    const requestId = ++this.renderRequestId;

    try {
      const clusters = await analysisWorker.clusterNews(items);
      if (requestId !== this.renderRequestId) return;
      const enriched = await enrichWithVelocityML(clusters);
      this.renderClusters(enriched);
    } catch (error) {
      if (requestId !== this.renderRequestId) return;
      // Keep already-rendered flat list visible when clustering fails.
      console.warn('[NewsPanel] Failed to cluster news, keeping flat list:', error);
    }
  }

  private renderFlat(items: NewsItem[]): void {
    this.lastRawItems = items;

    let sorted: NewsItem[];
    if (this.sortMode === 'newest') {
      sorted = [...items].sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
    } else {
      sorted = items;
    }

    this.setCount(sorted.length);
    this.currentHeadlines = sorted
      .slice(0, 5)
      .map(item => item.title)
      .filter((title): title is string => typeof title === 'string' && title.trim().length > 0);

    this.updateHeadlineSignature();

    const html = sorted
      .map(
        (item) => `
      <div class="item ${item.isAlert ? 'alert' : ''}" ${item.monitorColor ? `style="border-inline-start-color: ${escapeHtml(item.monitorColor)}"` : ''}>
        <div class="item-source">
          ${escapeHtml(item.source)}
          ${item.lang && item.lang !== getCurrentLanguage() ? `<span class="lang-badge">${item.lang.toUpperCase()}</span>` : ''}
          ${item.isAlert ? '<span class="alert-tag">ALERT</span>' : ''}
        </div>
        <a class="item-title" href="${sanitizeUrl(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
        <div class="item-time">
          ${formatTime(item.pubDate)}
          ${getCurrentLanguage() !== 'en' ? `<button class="item-translate-btn" title="Translate" data-text="${escapeHtml(item.title)}">文</button>` : ''}
        </div>
      </div>
    `
      )
      .join('');

    this.setContent(html);
  }

  private renderClusters(clusters: ClusteredEvent[]): void {
    this.lastRawClusters = clusters;
    this.lastRawItems = null;

    // Sort based on user preference (#107)
    const sorted = [...clusters].sort((a, b) => {
      if (this.sortMode === 'newest') {
        // Pure chronological, newest first
        return b.lastUpdated.getTime() - a.lastUpdated.getTime();
      }
      // Default: threat priority first, then recency within same level
      const pa = THREAT_PRIORITY[a.threat?.level ?? 'info'];
      const pb = THREAT_PRIORITY[b.threat?.level ?? 'info'];
      if (pb !== pa) return pb - pa;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    const totalItems = sorted.reduce((sum, c) => sum + c.sourceCount, 0);
    this.setCount(totalItems);
    this.relatedAssetContext.clear();

    // Store headlines for summarization (cap at 5 to reduce entity conflation in small models)
    this.currentHeadlines = sorted.slice(0, 5).map(c => c.primaryTitle);

    this.updateHeadlineSignature();

    const clusterIds = sorted.map(c => c.id);
    let newItemIds: Set<string>;

    if (this.isFirstRender) {
      // First render: mark all items as seen
      activityTracker.updateItems(this.panelId, clusterIds);
      activityTracker.markAsSeen(this.panelId);
      newItemIds = new Set();
      this.isFirstRender = false;
    } else {
      // Subsequent renders: track new items
      const newIds = activityTracker.updateItems(this.panelId, clusterIds);
      newItemIds = new Set(newIds);
    }

    // Prepare all clusters with their rendering data (defer HTML creation)
    const prepared: PreparedCluster[] = sorted.map(cluster => {
      const isNew = newItemIds.has(cluster.id);
      const shouldHighlight = activityTracker.shouldHighlight(this.panelId, cluster.id);
      const showNewTag = activityTracker.isNewItem(this.panelId, cluster.id) && isNew;

      return {
        cluster,
        isNew,
        shouldHighlight,
        showNewTag,
      };
    });

    // Use windowed rendering for large lists, direct render for small
    if (this.useVirtualScroll && sorted.length > VIRTUAL_SCROLL_THRESHOLD && this.windowedList) {
      this.windowedList.setItems(prepared);
    } else {
      // Direct render for small lists
      const html = prepared
        .map(p => this.renderClusterHtmlSafely(p.cluster, p.isNew, p.shouldHighlight, p.showNewTag))
        .join('');
      this.setContent(html);
    }
  }

  private renderClusterHtmlSafely(
    cluster: ClusteredEvent,
    isNew: boolean,
    shouldHighlight: boolean,
    showNewTag: boolean
  ): string {
    try {
      return this.renderClusterHtml(cluster, isNew, shouldHighlight, showNewTag);
    } catch (error) {
      console.error('[NewsPanel] Failed to render cluster card:', error, cluster);
      const clusterId = typeof cluster?.id === 'string' ? cluster.id : 'unknown-cluster';
      return `
        <div class="item clustered item-render-error" data-cluster-id="${escapeHtml(clusterId)}">
          <div class="item-source">${t('common.error')}</div>
          <div class="item-title">Failed to display this cluster.</div>
        </div>
      `;
    }
  }

  /**
   * Render a single cluster to HTML string
   */
  private renderClusterHtml(
    cluster: ClusteredEvent,
    isNew: boolean,
    shouldHighlight: boolean,
    showNewTag: boolean
  ): string {
    const sourceBadge = cluster.sourceCount > 1
      ? `<span class="source-count">${t('components.newsPanel.sources', { count: String(cluster.sourceCount) })}</span>`
      : '';

    const velocity = cluster.velocity;
    const velocityBadge = velocity && velocity.level !== 'normal' && cluster.sourceCount > 1
      ? `<span class="velocity-badge ${velocity.level}">${velocity.trend === 'rising' ? '↑' : ''}+${velocity.sourcesPerHour}/hr</span>`
      : '';

    const sentimentIcon = velocity?.sentiment === 'negative' ? '⚠' : velocity?.sentiment === 'positive' ? '✓' : '';
    const sentimentBadge = sentimentIcon && Math.abs(velocity?.sentimentScore || 0) > 2
      ? `<span class="sentiment-badge ${velocity?.sentiment}">${sentimentIcon}</span>`
      : '';

    const newTag = showNewTag ? `<span class="new-tag">${t('common.new')}</span>` : '';
    const langBadge = cluster.lang && cluster.lang !== getCurrentLanguage()
      ? `<span class="lang-badge">${cluster.lang.toUpperCase()}</span>`
      : '';

    // Propaganda risk indicator for primary source
    const primaryPropRisk = getSourcePropagandaRisk(cluster.primarySource);
    const primaryPropBadge = primaryPropRisk.risk !== 'low'
      ? `<span class="propaganda-badge ${primaryPropRisk.risk}" title="${escapeHtml(primaryPropRisk.note || `State-affiliated: ${primaryPropRisk.stateAffiliated || 'Unknown'}`)}">${primaryPropRisk.risk === 'high' ? '⚠ State Media' : '! Caution'}</span>`
      : '';

    // Source credibility badge for primary source (T1=Wire, T2=Verified outlet)
    const primaryTier = getSourceTier(cluster.primarySource);
    const primaryType = getSourceType(cluster.primarySource);
    const tierLabel = primaryTier === 1 ? 'Wire' : ''; // Don't show "Major" - confusing with story importance
    const tierBadge = primaryTier <= 2
      ? `<span class="tier-badge tier-${primaryTier}" title="${primaryType === 'wire' ? 'Wire Service - Highest reliability' : primaryType === 'gov' ? 'Official Government Source' : 'Verified News Outlet'}">${primaryTier === 1 ? '★' : '●'}${tierLabel ? ` ${tierLabel}` : ''}</span>`
      : '';

    // Build "Also reported by" section for multi-source confirmation
    const otherSources = cluster.topSources.filter(s => s.name !== cluster.primarySource);
    const topSourcesHtml = otherSources.length > 0
      ? `<span class="also-reported">Also:</span>` + otherSources
        .map(s => {
          const propRisk = getSourcePropagandaRisk(s.name);
          const propBadge = propRisk.risk !== 'low'
            ? `<span class="propaganda-badge ${propRisk.risk}" title="${escapeHtml(propRisk.note || `State-affiliated: ${propRisk.stateAffiliated || 'Unknown'}`)}">${propRisk.risk === 'high' ? '⚠' : '!'}</span>`
            : '';
          return `<span class="top-source tier-${s.tier}">${escapeHtml(s.name)}${propBadge}</span>`;
        })
        .join('')
      : '';

    const assetContext = getClusterAssetContext(cluster);
    if (assetContext && assetContext.assets.length > 0) {
      this.relatedAssetContext.set(cluster.id, assetContext);
    }

    const relatedAssetsHtml = assetContext && assetContext.assets.length > 0
      ? `
        <div class="related-assets" data-cluster-id="${escapeHtml(cluster.id)}">
          <div class="related-assets-header">
            ${t('components.newsPanel.relatedAssetsNear', { location: escapeHtml(assetContext.origin.label) })}
            <span class="related-assets-range">(${MAX_DISTANCE_KM}km)</span>
          </div>
          <div class="related-assets-list">
            ${assetContext.assets.map(asset => `
              <button class="related-asset" data-cluster-id="${escapeHtml(cluster.id)}" data-asset-id="${escapeHtml(asset.id)}" data-asset-type="${escapeHtml(asset.type)}">
                <span class="related-asset-type">${escapeHtml(this.getLocalizedAssetLabel(asset.type))}</span>
                <span class="related-asset-name">${escapeHtml(asset.name)}</span>
                <span class="related-asset-distance">${Math.round(asset.distanceKm)}km</span>
              </button>
            `).join('')}
          </div>
        </div>
      `
      : '';

    // Category tag from threat classification
    const cat = cluster.threat?.category;
    const catLabel = cat && cat !== 'general' ? cat.charAt(0).toUpperCase() + cat.slice(1) : '';
    const threatVarMap: Record<string, string> = { critical: '--threat-critical', high: '--threat-high', medium: '--threat-medium', low: '--threat-low', info: '--threat-info' };
    const catColor = cluster.threat ? getCSSColor(threatVarMap[cluster.threat.level] || '--text-dim') : '';
    const categoryBadge = catLabel
      ? `<span class="category-tag" style="color:${catColor};border-color:${catColor}40;background:${catColor}20">${catLabel}</span>`
      : '';

    // Numeric risk score badge (0-100): from external getter or fallback to threat-level derivation
    const riskScore = this.riskScoreGetter
      ? this.riskScoreGetter(cluster)
      : (() => {
          if (!cluster.threat) return null;
          const levelScore: Record<string, number> = { critical: 95, high: 75, medium: 50, low: 25, info: 10 };
          const base = levelScore[cluster.threat.level] ?? 10;
          return Math.round(base * (cluster.threat.confidence ?? 1));
        })();
    const riskBadge = riskScore !== null && riskScore >= 50
      ? `<span class="risk-score-badge" style="color:${catColor || getCSSColor('--text-dim')};border-color:${catColor ? catColor + '40' : 'var(--border)'};background:${catColor ? catColor + '15' : 'transparent'}" title="Event risk score">${riskScore}</span>`
      : '';

    // Build class list for item
    const itemClasses = [
      'item',
      'clustered',
      cluster.isAlert ? 'alert' : '',
      shouldHighlight ? 'item-new-highlight' : '',
      isNew ? 'item-new' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${itemClasses}" ${cluster.monitorColor ? `style="border-inline-start-color: ${escapeHtml(cluster.monitorColor)}"` : ''} data-cluster-id="${escapeHtml(cluster.id)}" data-news-id="${escapeHtml(cluster.primaryLink)}">
        <div class="item-source">
          ${tierBadge}
          ${escapeHtml(cluster.primarySource)}
          ${primaryPropBadge}
          ${langBadge}
          ${newTag}
          ${sourceBadge}
          ${velocityBadge}
          ${sentimentBadge}
          ${cluster.isAlert ? '<span class="alert-tag">ALERT</span>' : ''}
          ${categoryBadge}
          ${riskBadge}
        </div>
        <a class="item-title" href="${sanitizeUrl(cluster.primaryLink)}" target="_blank" rel="noopener">${escapeHtml(cluster.primaryTitle)}</a>
        <div class="cluster-meta">
          <span class="top-sources">${topSourcesHtml}</span>
          <span class="item-time">${formatTime(cluster.lastUpdated)}</span>
          ${getCurrentLanguage() !== 'en' ? `<button class="item-translate-btn" title="Translate" data-text="${escapeHtml(cluster.primaryTitle)}">文</button>` : ''}
        </div>
        ${relatedAssetsHtml}
      </div>
    `;
  }

  private setupContentDelegation(): void {
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const assetBtn = target.closest<HTMLElement>('.related-asset');
      if (assetBtn) {
        e.stopPropagation();
        const clusterId = assetBtn.dataset.clusterId;
        const assetId = assetBtn.dataset.assetId;
        const assetType = assetBtn.dataset.assetType as RelatedAsset['type'] | undefined;
        if (!clusterId || !assetId || !assetType) return;
        const context = this.relatedAssetContext.get(clusterId);
        const asset = context?.assets.find(item => item.id === assetId && item.type === assetType);
        if (asset) this.onRelatedAssetClick?.(asset);
        return;
      }

      const translateBtn = target.closest<HTMLElement>('.item-translate-btn');
      if (translateBtn) {
        e.stopPropagation();
        const text = translateBtn.dataset.text;
        if (text) this.handleTranslate(translateBtn, text);
        return;
      }
    });

    this.content.addEventListener('mouseover', (e) => {
      const container = (e.target as HTMLElement).closest<HTMLElement>('.related-assets');
      if (!container) return;
      const related = (e as MouseEvent).relatedTarget as Node | null;
      if (related && container.contains(related)) return;
      const context = this.relatedAssetContext.get(container.dataset.clusterId ?? '');
      if (context) this.onRelatedAssetsFocus?.(context.assets, context.origin.label);
    });

    this.content.addEventListener('mouseout', (e) => {
      const container = (e.target as HTMLElement).closest<HTMLElement>('.related-assets');
      if (!container) return;
      const related = (e as MouseEvent).relatedTarget as Node | null;
      if (related && container.contains(related)) return;
      this.onRelatedAssetsClear?.();
    });
  }

  private bindRelatedAssetEvents(): void {
    // Event delegation is set up in setupContentDelegation() — this is now a no-op
    // kept for WindowedList callback compatibility
  }

  private getLocalizedAssetLabel(type: RelatedAsset['type']): string {
    const keyMap: Record<RelatedAsset['type'], string> = {
      pipeline: 'modals.countryBrief.infra.pipeline',
      cable: 'modals.countryBrief.infra.cable',
      datacenter: 'modals.countryBrief.infra.datacenter',
      base: 'modals.countryBrief.infra.base',
      nuclear: 'modals.countryBrief.infra.nuclear',
    };
    return t(keyMap[type]);
  }

  /**
   * Returns true if this panel contains a news item with the given link
   * (either as a cluster primary or secondary article).
   */
  public hasNewsItem(link: string): boolean {
    if (this.lastRawClusters) {
      return this.lastRawClusters.some(
        c => c.primaryLink === link || c.allItems.some(i => i.link === link)
      );
    }
    if (this.lastRawItems) {
      return this.lastRawItems.some(i => i.link === link);
    }
    return false;
  }

  /**
   * Scroll the panel to the item with the given link and flash-highlight it.
   * For virtual-scrolled panels, renders the containing chunk first.
   */
  public scrollToNewsItem(link: string): void {
    // In clustered mode, scroll via windowedList so off-screen chunks are rendered first
    if (this.lastRawClusters && this.windowedList) {
      const found = this.windowedList.scrollToItem(
        (p: { cluster: ClusteredEvent }) =>
          p.cluster.primaryLink === link || p.cluster.allItems.some((i: { link: string }) => i.link === link)
      );
      if (found) {
        setTimeout(() => {
          const el = this.content.querySelector(`[data-news-id="${CSS.escape(link)}"]`)
            ?? this.content.querySelector(`a[href="${CSS.escape(link)}"]`);
          if (el) this.flashHighlight(el);
        }, 350);
        return;
      }
    }
    // Flat mode or small lists rendered directly in DOM
    const el = this.content.querySelector(`[data-news-id="${CSS.escape(link)}"]`)
      ?? this.content.querySelector(`a[href="${CSS.escape(link)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flashHighlight(el);
    }
  }

  private flashHighlight(el: Element): void {
    el.classList.remove('search-highlight');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('search-highlight');
    setTimeout(() => el.classList.remove('search-highlight'), 3100);
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    // Clean up windowed list
    this.windowedList?.destroy();
    this.windowedList = null;

    // Remove activity tracking listeners
    if (this.boundScrollHandler) {
      this.content.removeEventListener('scroll', this.boundScrollHandler);
      this.boundScrollHandler = null;
    }
    if (this.boundClickHandler) {
      this.element.removeEventListener('click', this.boundClickHandler);
      this.boundClickHandler = null;
    }

    // Unregister from activity tracker
    activityTracker.unregister(this.panelId);

    // Call parent destroy
    super.destroy();
  }
}
