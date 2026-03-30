import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getPrimarySavedPlace, getSavedPlace, getSavedPlaces } from '@/services/saved-places';
import {
  fetchLocalLogistics,
  getCachedLocalLogistics,
  LOCAL_LOGISTICS_CATEGORIES,
  LOCAL_LOGISTICS_CATEGORY_LABELS,
  selectTopLocalLogisticsNodes,
  type LocalLogisticsSnapshot,
  type LogisticsCategory,
  type LogisticsNode,
} from '@/services/local-logistics';

interface LocalLogisticsPanelOptions {
  focusNode: (lat: number, lon: number) => void;
}

type LocalLogisticsFilter = 'all' | LogisticsCategory;

function formatUpdatedAt(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDistance(distanceKm: number): string {
  if (distanceKm < 10) return `${distanceKm.toFixed(1)} km`;
  return `${Math.round(distanceKm)} km`;
}

function formatStatus(node: LogisticsNode): string {
  if (node.status === 'open') return 'likely open';
  if (node.status === 'limited') return 'hours listed';
  return 'status unknown';
}

export class LocalLogisticsPanel extends Panel {
  private readonly options: LocalLogisticsPanelOptions;
  private activePlaceId: string | null = null;
  private activeFilter: LocalLogisticsFilter = 'all';
  private snapshot: LocalLogisticsSnapshot | null = null;
  private error: string | null = null;
  private readonly nodeLookup = new Map<string, LogisticsNode>();

  constructor(options: LocalLogisticsPanelOptions) {
    super({
      id: 'local-logistics',
      title: 'Local Logistics',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Nearby shelter, care, fuel, and water options for the selected or primary saved place. Cached snapshots remain visible when connectivity degrades.',
    });
    this.options = options;
    this.showLoading('Loading local logistics…');

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const filterButton = target?.closest<HTMLElement>('[data-logistics-filter]');
      if (filterButton) {
        this.activeFilter = (filterButton.dataset.logisticsFilter ?? 'all') as LocalLogisticsFilter;
        this.render();
        return;
      }

      if (target?.closest('[data-logistics-refresh]')) {
        void this.refresh();
        return;
      }

      const nodeButton = target?.closest<HTMLElement>('[data-logistics-node-id]');
      const nodeId = nodeButton?.dataset.logisticsNodeId;
      if (!nodeId) return;
      const node = this.nodeLookup.get(nodeId);
      if (!node) return;
      this.options.focusNode(node.lat, node.lon);
    });
  }

  public setPlaceId(placeId: string | null): void {
    this.activePlaceId = placeId;
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    const place = this.resolvePlace();
    this.nodeLookup.clear();
    if (!place) {
      this.snapshot = null;
      this.error = null;
      this.setCount(0);
      this.setContent('<div class="panel-empty">Save a place to unlock nearby logistics.</div>');
      return;
    }

    this.activePlaceId = place.id;
    this.showLoading(`Loading logistics near ${place.name}…`);
    try {
      this.snapshot = await fetchLocalLogistics(place);
      this.error = null;
    } catch (error) {
      this.snapshot = getCachedLocalLogistics(place.id);
      this.error = error instanceof Error ? error.message : 'Failed to load local logistics';
    }

    this.render();
  }

  private resolvePlace() {
    if (this.activePlaceId) {
      const active = getSavedPlace(this.activePlaceId);
      if (active) return active;
    }
    return getPrimarySavedPlace() ?? getSavedPlaces()[0] ?? null;
  }

  private render(): void {
    const place = this.resolvePlace();
    if (!place) {
      this.setCount(0);
      this.setContent('<div class="panel-empty">Save a place to unlock nearby logistics.</div>');
      return;
    }

    if (!this.snapshot) {
      if (this.error) {
        this.showError(this.error);
        return;
      }
      this.showLoading(`Loading logistics near ${place.name}…`);
      return;
    }

    const categories = this.snapshot.categories.length > 0
      ? this.snapshot.categories
      : [...LOCAL_LOGISTICS_CATEGORIES];
    const nodes = selectTopLocalLogisticsNodes(this.snapshot, this.activeFilter, this.activeFilter === 'all' ? 12 : 6);
    this.setCount(nodes.length);
    for (const node of this.snapshot.nodes) {
      this.nodeLookup.set(node.id, node);
    }

    const headerHtml = `
      <div class="watchlist-card-top" style="margin-bottom:10px;">
        <div>
          <div class="watchlist-country">${escapeHtml(place.name)}</div>
          <div class="watchlist-scenario">Radius ${place.radiusKm.toLocaleString()} km • Updated ${escapeHtml(formatUpdatedAt(this.snapshot.fetchedAt))}</div>
        </div>
        <button class="sa-refresh-btn" data-logistics-refresh="1" type="button">Refresh</button>
      </div>
    `;

    const staleHtml = this.snapshot.isStale
      ? `<div class="panel-empty" style="margin-bottom:10px;">Showing cached logistics from ${escapeHtml(formatUpdatedAt(this.snapshot.fetchedAt))}.</div>`
      : '';

    const filtersHtml = `
      <div class="sa-filters">
        <button class="sa-filter ${this.activeFilter === 'all' ? 'sa-filter-active' : ''}" data-logistics-filter="all" type="button">All</button>
        ${categories.map((category) => `
          <button
            class="sa-filter ${this.activeFilter === category ? 'sa-filter-active' : ''}"
            data-logistics-filter="${escapeHtml(category)}"
            type="button"
          >${escapeHtml(LOCAL_LOGISTICS_CATEGORY_LABELS[category])}</button>
        `).join('')}
      </div>
    `;

    const listHtml = nodes.length === 0
      ? '<div class="panel-empty">No nearby logistics nodes matched this place yet. Try refresh or widen the place radius.</div>'
      : `
        <div class="watchlist-list">
          ${nodes.map((node) => this.renderNode(node)).join('')}
        </div>
      `;

    const errorHtml = this.error
      ? `<div class="watchlist-scenario" style="margin-top:10px;">${escapeHtml(this.error)}</div>`
      : '';

    this.setContent(`
      <div class="sa-panel-content">
        ${headerHtml}
        ${staleHtml}
        ${filtersHtml}
        ${listHtml}
        ${errorHtml}
      </div>
    `);
  }

  private renderNode(node: LogisticsNode): string {
    const chips = [
      `<span class="watchlist-panel-chip">${escapeHtml(LOCAL_LOGISTICS_CATEGORY_LABELS[node.category])}</span>`,
      `<span class="watchlist-panel-chip">${escapeHtml(formatStatus(node))}</span>`,
      node.url ? '<span class="watchlist-panel-chip">Directory</span>' : '',
    ].filter(Boolean).join('');

    const sourceLine = node.url
      ? `<a href="${sanitizeUrl(node.url)}" target="_blank" rel="noopener" class="sa-title">${escapeHtml(node.source)}</a>`
      : escapeHtml(node.source);

    return `
      <button class="watchlist-card" data-logistics-node-id="${escapeHtml(node.id)}" type="button">
        <div class="watchlist-card-top">
          <div>
            <div class="watchlist-country">${escapeHtml(node.name)}</div>
            <div class="watchlist-scenario">${escapeHtml(formatDistance(node.distanceKm))} • ${escapeHtml(node.hazardCompatibility)}</div>
          </div>
        </div>
        <div class="watchlist-summary">${escapeHtml(node.address ?? 'No street address published')}</div>
        <div class="watchlist-card-bottom">
          <div class="watchlist-panels">${chips}</div>
          <div class="watchlist-scenario">${sourceLine}</div>
        </div>
      </button>
    `;
  }
}
