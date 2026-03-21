/**
 * BreakingNewsTickerPanel
 *
 * Horizontally scrolling ticker for high-priority news (P0/P1).
 * Displays funding rounds, acquisitions, major research announcements.
 *
 * Features:
 * - CSS-driven infinite scroll animation
 * - Hover-pause
 * - Click to open article
 * - Auto-hide when no high-priority news
 * - 5-minute refresh interval
 * - Self-managed DOM container (inserted after header)
 */

import type { NewsItem } from '@/types';
import type { PriorityArticle } from '@/services/news-priority';
import {
  filterHighPriorityNews,
  NewsPriority,
} from '@/services/news-priority';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ITEMS = 10;

/**
 * Priority badge configuration
 */
const PRIORITY_CONFIG = {
  [NewsPriority.P0]: {
    emoji: '🔴',
    label: 'BREAKING',
    className: 'priority-p0',
  },
  [NewsPriority.P1]: {
    emoji: '🟡',
    label: 'HOT',
    className: 'priority-p1',
  },
  [NewsPriority.P2]: {
    emoji: '',
    label: '',
    className: '',
  },
};

/**
 * Standalone breaking news ticker component.
 * Self-manages its DOM container and lifecycle.
 */
export class BreakingNewsTickerPanel {
  private container: HTMLElement;
  private tickerTrack: HTMLElement | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private currentItems: PriorityArticle[] = [];
  private boundOnRefreshRequest: () => void;

  constructor() {
    // Create and insert container into DOM
    this.container = document.createElement('div');
    this.container.id = 'breaking-news-ticker-root';
    this.container.className = 'breaking-news-ticker-root';
    this.container.style.display = 'none'; // Hidden until we have items

    // Insert after header
    const header = document.querySelector('.app-header, header, .header');
    if (header?.parentNode) {
      header.parentNode.insertBefore(this.container, header.nextSibling);
    } else {
      // Fallback: insert at top of body
      document.body.insertBefore(this.container, document.body.firstChild);
    }

    this.createTickerDOM();
    this.startRefreshTimer();

    // Listen for refresh requests
    this.boundOnRefreshRequest = () => this.onRefreshRequest();
    document.addEventListener(
      'breaking-news-ticker:refresh-request',
      this.boundOnRefreshRequest,
    );
  }

  /**
   * Create the ticker wrapper and track elements
   */
  private createTickerDOM(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'breaking-news-ticker-wrapper';

    // Header with fire icon
    const header = document.createElement('div');
    header.className = 'breaking-news-ticker-header';
    header.innerHTML = `
      <span class="ticker-icon">🔥</span>
      <span class="ticker-label">BREAKING</span>
    `;

    // Scrolling track
    const track = document.createElement('div');
    track.className = 'breaking-news-ticker-track';

    wrapper.appendChild(header);
    wrapper.appendChild(track);
    this.tickerTrack = track;

    this.container.appendChild(wrapper);
  }

  /**
   * Set news items and filter for high priority
   */
  public setItems(items: NewsItem[]): void {
    const priorityItems = filterHighPriorityNews(items, MAX_ITEMS);
    this.currentItems = priorityItems;

    if (!this.tickerTrack) return;

    // Hide container if no high-priority news
    if (priorityItems.length === 0) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = '';
    this.renderItems(priorityItems);
  }

  /**
   * Render priority items into the ticker track
   */
  private renderItems(items: PriorityArticle[]): void {
    if (!this.tickerTrack) return;

    const itemsHtml = items.map((item) => this.renderItem(item)).join('');

    // Double content for seamless infinite scroll
    this.tickerTrack.innerHTML = itemsHtml + itemsHtml;
  }

  /**
   * Render a single news item card
   */
  private renderItem(item: PriorityArticle): string {
    const config = PRIORITY_CONFIG[item.priority];
    const timeAgo = this.formatTimeAgo(item.pubDate);
    const category = this.inferCategory(item.title);

    return `
      <a class="breaking-news-card ${config.className}" 
         href="${sanitizeUrl(item.link)}" 
         target="_blank" 
         rel="noopener noreferrer">
        <span class="priority-badge">
          ${config.emoji} ${config.label}
        </span>
        <span class="news-title">${escapeHtml(item.title)}</span>
        <span class="news-meta">
          <span class="news-source">${escapeHtml(item.source)}</span>
          <span class="separator">•</span>
          <span class="news-time">${timeAgo}</span>
          <span class="separator">•</span>
          <span class="news-category">${category}</span>
        </span>
      </a>
    `;
  }

  /**
   * Format publication date as relative time
   */
  private formatTimeAgo(pubDate: Date): string {
    const now = Date.now();
    const then = new Date(pubDate).getTime();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  /**
   * Infer category from article title
   */
  private inferCategory(title: string): string {
    const text = title.toLowerCase();

    if (
      text.includes('funding') ||
      text.includes('raises') ||
      text.includes('series')
    ) {
      return 'Funding';
    }
    if (
      text.includes('acquisition') ||
      text.includes('acquires') ||
      text.includes('m&a')
    ) {
      return 'M&A';
    }
    if (text.includes('research') || text.includes('breakthrough')) {
      return 'Research';
    }
    if (text.includes('summit') || text.includes('conference')) {
      return 'Event';
    }
    if (text.includes('ipo') || text.includes('public')) {
      return 'IPO';
    }

    return 'Tech';
  }

  /**
   * Start auto-refresh timer
   */
  private startRefreshTimer(): void {
    this.refreshTimer = setInterval(() => {
      // Emit event to request fresh news data
      document.dispatchEvent(
        new CustomEvent('breaking-news-ticker:refresh-request'),
      );
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Handle refresh request event (can be overridden by data loader)
   */
  private onRefreshRequest(): void {
    // This is a placeholder - the actual data refresh is handled
    // by the data loader listening to this event
  }

  /**
   * Get current items count (for testing)
   */
  public getItemCount(): number {
    return this.currentItems.length;
  }

  /**
   * Get container element (for testing)
   */
  public getContainer(): HTMLElement {
    return this.container;
  }

  /**
   * Clean up on destroy
   */
  public destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    document.removeEventListener(
      'breaking-news-ticker:refresh-request',
      this.boundOnRefreshRequest,
    );
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.tickerTrack = null;
  }
}
