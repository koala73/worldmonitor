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

  // Panel summary feature
  private summaryBtn: HTMLButtonElement | null = null;
  private summaryContainer: HTMLElement | null = null;
  private currentHeadlines: string[] = [];
  private isSummarizing = false;

  constructor(id: string, title: string) {
    super({ id, title, showCount: true, trackActivity: true });
    this.createDeviationIndicator();
    this.createSummarizeButton();
    this.setupActivityTracking();
    this.initWindowedList();
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

  private createSummarizeButton(): void {
    // Create summary container (inserted between header and content)
    this.summaryContainer = document.createElement('div');
    this.summaryContainer.className = 'panel-summary';
    this.summaryContainer.style.display = 'none';
    this.element.insertBefore(this.summaryContainer, this.content);

    // Create summarize button
    this.summaryBtn = document.createElement('button');
    this.summaryBtn.className = 'panel-summarize-btn';
    this.summaryBtn.innerHTML = '✨';
    this.summaryBtn.title = t('components.newsPanel.summarize');
    this.summaryBtn.addEventListener('click', () => this.handleSummarize());

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

    try {
      const result = await generateSummary(this.currentHeadlines.slice(0, 8), undefined, undefined, currentLang);
      if (result?.summary) {
        this.setCachedSummary(cacheKey, result.summary);
        this.showSummary(result.summary);
      } else {
        this.summaryContainer.innerHTML = '<div class="panel-summary-error">Could not generate summary</div>';
        setTimeout(() => this.hideSummary(), 3000);
      }
    } catch {
      this.summaryContainer.innerHTML = '<div class="panel-summary-error">Summary failed</div>';
      setTimeout(() => this.hideSummary(), 3000);
    } finally {
      this.isSummarizing = false;
      this.summaryBtn.innerHTML = '✨';
      this.summaryBtn.disabled = false;
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
      console.error('Translation failed', e);
      element.innerHTML = '文';
    } finally {
      element.style.pointerEvents = 'auto';
    }
  }

  private showSummary(summary: string): void {
    if (!this.summaryContainer) return;
    this.summaryContainer.style.display = 'block';
    this.summaryContainer.innerHTML = `
      <div class="panel-summary-content">
        <span class="panel-summary-text">${escapeHtml(summary)}</span>
        <button class="panel-summary-close" title="${t('components.newsPanel.close')}">×</button>
      </div>
    `;
    this.summaryContainer.querySelector('.panel-summary-close')?.addEventListener('click', () => this.hideSummary());
  }

  private hideSummary(): void {
    if (!this.summaryContainer) return;
    this.summaryContainer.style.display = 'none';
    this.summaryContainer.innerHTML = '';
  }

  private getCachedSummary(key: string): string | null {
    try {
      const cached = localStorage.getItem(key);
      if (!cached) return null;
      const { summary, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp > SUMMARY_CACHE_TTL) {
        localStorage.removeItem(key);
        return null;
      }
      return summary;
    } catch {
      return null;
    }
  }

  private setCachedSummary(key: string, summary: string): void {
    try {
      localStorage.setItem(key, JSON.stringify({ summary, timestamp: Date.now() }));
    } catch {
      // Storage full, ignore
    }
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
    this.setDataBadge('live');
    this.setCount(0);
    this.relatedAssetContext.clear();
    this.currentHeadlines = [];
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
      console.error('[NewsPanel] Failed to cluster news:', error);
      this.showError(t('common.failedClusterNews'));
    }
  }

  private renderFlat(items: NewsItem[]): void {
    this.setCount(items.length);

    const html = items
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
    // Sort by threat priority, then by time within same level
    const sorted = [...clusters].sort((a, b) => {
      const pa = THREAT_PRIORITY[a.threat?.level ?? 'info'];
      const pb = THREAT_PRIORITY[b.threat?.level ?? 'info'];
      if (pb !== pa) return pb - pa;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    const totalItems = sorted.reduce((sum, c) => sum + c.sourceCount, 0);
    this.setCount(totalItems);
    this.relatedAssetContext.clear();

    // Store headlines for summarization
    this.currentHeadlines = sorted.slice(0, 10).map(c => c.primaryTitle);

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
      this.bindRelatedAssetEvents();
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

  private bindRelatedAssetEvents(): void {
    const containers = this.content.querySelectorAll<HTMLDivElement>('.related-assets');
    containers.forEach((container) => {
      const clusterId = container.dataset.clusterId;
      if (!clusterId) return;
      const context = this.relatedAssetContext.get(clusterId);
      if (!context) return;

      container.addEventListener('mouseenter', () => {
        this.onRelatedAssetsFocus?.(context.assets, context.origin.label);
      });

      container.addEventListener('mouseleave', () => {
        this.onRelatedAssetsClear?.();
      });
    });

    const assetButtons = this.content.querySelectorAll<HTMLButtonElement>('.related-asset');
    assetButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const clusterId = button.dataset.clusterId;
        const assetId = button.dataset.assetId;
        const assetType = button.dataset.assetType as RelatedAsset['type'] | undefined;
        if (!clusterId || !assetId || !assetType) return;
        const context = this.relatedAssetContext.get(clusterId);
        const asset = context?.assets.find(item => item.id === assetId && item.type === assetType);
        if (asset) {
          this.onRelatedAssetClick?.(asset);
        }
      });
    });

    // Translation buttons
    const translateBtns = this.content.querySelectorAll<HTMLElement>('.item-translate-btn');
    translateBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = btn.dataset.text;
        if (text) this.handleTranslate(btn, text);
      });
    });
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
