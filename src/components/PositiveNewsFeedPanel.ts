import { Panel } from './Panel';
import type { NewsItem } from '@/types';
import type { HappyContentCategory } from '@/services/positive-classifier';
import { HAPPY_CATEGORY_ALL, HAPPY_CATEGORY_LABELS } from '@/services/positive-classifier';
import { shareHappyCard } from '@/services/happy-share-renderer';
import { formatTime } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';

/**
 * PositiveNewsFeedPanel -- scrolling positive news feed with category filter bar
 * and rich image cards. Primary visible panel for the happy variant.
 */
export class PositiveNewsFeedPanel extends Panel {
  private activeFilter: HappyContentCategory | 'all' = 'all';
  private allItems: NewsItem[] = [];
  private filteredItems: NewsItem[] = [];
  private filterButtons: Map<string, HTMLButtonElement> = new Map();
  private filterClickHandlers: Map<HTMLButtonElement, () => void> = new Map();

  constructor() {
    super({ id: 'positive-feed', title: 'Good News Feed', showCount: true, trackActivity: true });
    this.createFilterBar();
  }

  /**
   * Create the category filter bar with "All" + per-category buttons.
   * Inserted between panel header and content area.
   */
  private createFilterBar(): void {
    const filterBar = document.createElement('div');
    filterBar.className = 'positive-feed-filters';

    // "All" button (active by default)
    const allBtn = document.createElement('button');
    allBtn.className = 'positive-filter-btn active';
    allBtn.textContent = 'All';
    allBtn.dataset.category = 'all';
    const allHandler = () => this.setFilter('all');
    allBtn.addEventListener('click', allHandler);
    this.filterClickHandlers.set(allBtn, allHandler);
    this.filterButtons.set('all', allBtn);
    filterBar.appendChild(allBtn);

    // Per-category buttons
    for (const category of HAPPY_CATEGORY_ALL) {
      const btn = document.createElement('button');
      btn.className = 'positive-filter-btn';
      btn.textContent = HAPPY_CATEGORY_LABELS[category];
      btn.dataset.category = category;
      const handler = () => this.setFilter(category);
      btn.addEventListener('click', handler);
      this.filterClickHandlers.set(btn, handler);
      this.filterButtons.set(category, btn);
      filterBar.appendChild(btn);
    }

    // Insert filter bar before content
    this.element.insertBefore(filterBar, this.content);
  }

  /**
   * Update the active filter and re-render.
   */
  private setFilter(filter: HappyContentCategory | 'all'): void {
    this.activeFilter = filter;

    // Update button active states
    for (const [key, btn] of this.filterButtons) {
      if (key === filter) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }

    this.applyFilter();
  }

  /**
   * Public method to receive new positive news items.
   * Preserves the current filter selection across data refreshes.
   */
  public renderPositiveNews(items: NewsItem[]): void {
    this.allItems = items;
    this.setCount(items.length);
    this.applyFilter();
  }

  /**
   * Filter items by current active filter and render cards.
   */
  private applyFilter(): void {
    const filtered = this.activeFilter === 'all'
      ? this.allItems
      : this.allItems.filter(item => item.happyCategory === this.activeFilter);

    this.renderCards(filtered);
  }

  /**
   * Render the card list from a filtered set of items.
   * Attaches a delegated click handler for share buttons.
   */
  private renderCards(items: NewsItem[]): void {
    this.filteredItems = items;

    if (items.length === 0) {
      this.content.innerHTML = `<div class="positive-feed-empty">${escapeHtml(t('components.positiveNewsFeed.noStories'))}</div>`;
      return;
    }

    this.content.innerHTML = items.map((item, idx) => this.renderCard(item, idx)).join('');

    // Delegated click handler for share buttons (remove first to avoid stacking)
    this.content.removeEventListener('click', this.handleShareClick);
    this.content.addEventListener('click', this.handleShareClick);
  }

  /**
   * Delegated click handler for .positive-card-share buttons.
   */
  private handleShareClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const shareBtn = target.closest('.positive-card-share') as HTMLButtonElement | null;
    if (!shareBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const idx = parseInt(shareBtn.dataset.idx ?? '', 10);
    const item = this.filteredItems[idx];
    if (!item) return;

    // Fire-and-forget share
    shareHappyCard(item).catch(() => {});

    // Brief visual feedback
    shareBtn.classList.add('shared');
    setTimeout(() => shareBtn.classList.remove('shared'), 1500);
  };

  /**
   * Render a single positive news card as an HTML string.
   * Card is an <a> tag so the entire card is clickable.
   * Share button inside the card body prevents link navigation via delegated handler.
   */
  private renderCard(item: NewsItem, idx: number): string {
    const imageHtml = item.imageUrl
      ? `<div class="positive-card-image"><img src="${sanitizeUrl(item.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
      : '';

    const categoryLabel = item.happyCategory ? HAPPY_CATEGORY_LABELS[item.happyCategory] : '';
    const categoryBadgeHtml = item.happyCategory
      ? `<span class="positive-card-category cat-${escapeHtml(item.happyCategory)}">${escapeHtml(categoryLabel)}</span>`
      : '';

    return `<a class="positive-card" href="${sanitizeUrl(item.link)}" target="_blank" rel="noopener" data-category="${escapeHtml(item.happyCategory || '')}">
  ${imageHtml}
  <div class="positive-card-body">
    <div class="positive-card-meta">
      <span class="positive-card-source">${escapeHtml(item.source)}</span>
      ${categoryBadgeHtml}
    </div>
    <span class="positive-card-title">${escapeHtml(item.title)}</span>
    <span class="positive-card-time">${formatTime(item.pubDate)}</span>
    <button class="positive-card-share" aria-label="Share this story" data-idx="${idx}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>
        <polyline points="16 6 12 2 8 6"/>
        <line x1="12" y1="2" x2="12" y2="15"/>
      </svg>
    </button>
  </div>
</a>`;
  }

  /**
   * Clean up event listeners and call parent destroy.
   */
  public destroy(): void {
    for (const [btn, handler] of this.filterClickHandlers) {
      btn.removeEventListener('click', handler);
    }
    this.filterClickHandlers.clear();
    this.filterButtons.clear();
    super.destroy();
  }
}
