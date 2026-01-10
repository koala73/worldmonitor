import { Panel } from './Panel';
import { WindowedList } from './VirtualList';
import type { NewsItem, ClusteredEvent, DeviationLevel, RelatedAsset, RelatedAssetContext } from '@/types';
import { formatTime } from '@/utils';
import { clusterNews, enrichWithVelocity, getClusterAssetContext, getAssetLabel, MAX_DISTANCE_KM, activityTracker } from '@/services';

/** Threshold for enabling virtual scrolling */
const VIRTUAL_SCROLL_THRESHOLD = 15;

/** Prepared cluster data for rendering */
interface PreparedCluster {
  cluster: ClusteredEvent;
  isNew: boolean;
  shouldHighlight: boolean;
  showNewTag: boolean;
  html: string;
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

  constructor(id: string, title: string) {
    super({ id, title, showCount: true, trackActivity: true });
    this.createDeviationIndicator();
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
      (prepared) => prepared.html,
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
    this.content.addEventListener('scroll', () => {
      activityTracker.markAsSeen(this.panelId);
    });

    // Mark as seen on click anywhere in panel
    this.element.addEventListener('click', () => {
      activityTracker.markAsSeen(this.panelId);
    });
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
      this.showError('No news available');
      return;
    }

    if (this.clusteredMode) {
      const clusters = clusterNews(items);
      const enriched = enrichWithVelocity(clusters);
      this.renderClusters(enriched);
    } else {
      this.renderFlat(items);
    }
  }

  private renderFlat(items: NewsItem[]): void {
    this.setCount(items.length);

    const html = items
      .map(
        (item) => `
      <div class="item ${item.isAlert ? 'alert' : ''}" ${item.monitorColor ? `style="border-left-color: ${item.monitorColor}"` : ''}>
        <div class="item-source">
          ${item.source}
          ${item.isAlert ? '<span class="alert-tag">ALERT</span>' : ''}
        </div>
        <a class="item-title" href="${item.link}" target="_blank" rel="noopener">${item.title}</a>
        <div class="item-time">${formatTime(item.pubDate)}</div>
      </div>
    `
      )
      .join('');

    this.setContent(html);
  }

  private renderClusters(clusters: ClusteredEvent[]): void {
    const totalItems = clusters.reduce((sum, c) => sum + c.sourceCount, 0);
    this.setCount(totalItems);
    this.relatedAssetContext.clear();

    // Track items with activity tracker (skip first render to avoid marking everything as "new")
    const clusterIds = clusters.map(c => c.id);
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

    // Prepare all clusters with their rendering data
    const prepared: PreparedCluster[] = clusters.map(cluster => {
      const isNew = newItemIds.has(cluster.id);
      const shouldHighlight = activityTracker.shouldHighlight(this.panelId, cluster.id);
      const showNewTag = activityTracker.isNewItem(this.panelId, cluster.id) && isNew;

      return {
        cluster,
        isNew,
        shouldHighlight,
        showNewTag,
        html: this.renderClusterHtml(cluster, isNew, shouldHighlight, showNewTag),
      };
    });

    // Use windowed rendering for large lists, direct render for small
    if (this.useVirtualScroll && clusters.length > VIRTUAL_SCROLL_THRESHOLD && this.windowedList) {
      this.windowedList.setItems(prepared);
    } else {
      // Direct render for small lists
      const html = prepared.map(p => p.html).join('');
      this.setContent(html);
      this.bindRelatedAssetEvents();
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
      ? `<span class="source-count">${cluster.sourceCount} sources</span>`
      : '';

    const velocity = cluster.velocity;
    const velocityBadge = velocity && velocity.level !== 'normal' && cluster.sourceCount > 1
      ? `<span class="velocity-badge ${velocity.level}">${velocity.trend === 'rising' ? '↑' : ''}+${velocity.sourcesPerHour}/hr</span>`
      : '';

    const sentimentIcon = velocity?.sentiment === 'negative' ? '⚠' : velocity?.sentiment === 'positive' ? '✓' : '';
    const sentimentBadge = sentimentIcon && Math.abs(velocity?.sentimentScore || 0) > 2
      ? `<span class="sentiment-badge ${velocity?.sentiment}">${sentimentIcon}</span>`
      : '';

    const newTag = showNewTag ? '<span class="new-tag">NEW</span>' : '';

    const topSourcesHtml = cluster.topSources
      .map(s => `<span class="top-source tier-${s.tier}">${s.name}</span>`)
      .join('');

    const assetContext = getClusterAssetContext(cluster);
    if (assetContext && assetContext.assets.length > 0) {
      this.relatedAssetContext.set(cluster.id, assetContext);
    }

    const relatedAssetsHtml = assetContext && assetContext.assets.length > 0
      ? `
        <div class="related-assets" data-cluster-id="${cluster.id}">
          <div class="related-assets-header">
            Related assets near ${assetContext.origin.label}
            <span class="related-assets-range">(${MAX_DISTANCE_KM}km)</span>
          </div>
          <div class="related-assets-list">
            ${assetContext.assets.map(asset => `
              <button class="related-asset" data-cluster-id="${cluster.id}" data-asset-id="${asset.id}" data-asset-type="${asset.type}">
                <span class="related-asset-type">${getAssetLabel(asset.type)}</span>
                <span class="related-asset-name">${asset.name}</span>
                <span class="related-asset-distance">${Math.round(asset.distanceKm)}km</span>
              </button>
            `).join('')}
          </div>
        </div>
      `
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
      <div class="${itemClasses}" ${cluster.monitorColor ? `style="border-left-color: ${cluster.monitorColor}"` : ''} data-cluster-id="${cluster.id}" data-news-id="${cluster.primaryLink}">
        <div class="item-source">
          ${cluster.primarySource}
          ${newTag}
          ${sourceBadge}
          ${velocityBadge}
          ${sentimentBadge}
          ${cluster.isAlert ? '<span class="alert-tag">ALERT</span>' : ''}
        </div>
        <a class="item-title" href="${cluster.primaryLink}" target="_blank" rel="noopener">${cluster.primaryTitle}</a>
        <div class="cluster-meta">
          <span class="top-sources">${topSourcesHtml}</span>
          <span class="item-time">${formatTime(cluster.lastUpdated)}</span>
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
  }
}
