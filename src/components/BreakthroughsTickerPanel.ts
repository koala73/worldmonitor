import { Panel } from './Panel';
import type { NewsItem } from '@/types';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';

/**
 * BreakthroughsTickerPanel -- Horizontally scrolling ticker of science breakthroughs.
 *
 * Displays a continuously scrolling strip of science news items. The animation
 * is driven entirely by CSS (added in plan 06-03). The JS builds the DOM with
 * doubled content for seamless infinite scroll. Hover-pause and tab-hidden
 * pause are handled by CSS (:hover rule and .animations-paused body class).
 */
export class BreakthroughsTickerPanel extends Panel {
  private tickerTrack: HTMLElement | null = null;

  constructor() {
    super({ id: 'breakthroughs', title: 'Breakthroughs', trackActivity: false });
    this.createTickerDOM();
  }

  /**
   * Create the ticker wrapper and track elements.
   */
  private createTickerDOM(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'breakthroughs-ticker-wrapper';

    const track = document.createElement('div');
    track.className = 'breakthroughs-ticker-track';

    wrapper.appendChild(track);
    this.tickerTrack = track;

    // Clear loading state and append the ticker
    this.content.innerHTML = '';
    this.content.appendChild(wrapper);
  }

  /**
   * Receive science news items and populate the ticker track.
   * Content is doubled for seamless infinite CSS scroll animation.
   */
  public setItems(items: NewsItem[]): void {
    if (!this.tickerTrack) return;

    if (items.length === 0) {
      this.tickerTrack.innerHTML =
        `<span class="ticker-item ticker-placeholder">${t('components.breakthroughsTicker.noData')}</span>`;
      return;
    }

    // Build HTML for one set of items
    const itemsHtml = items
      .map(
        (item) =>
          `<a class="ticker-item" href="${sanitizeUrl(item.link)}" target="_blank" rel="noopener">` +
          `<span class="ticker-item-source">${escapeHtml(item.source)}</span>` +
          `<span class="ticker-item-title">${escapeHtml(item.title)}</span>` +
          `</a>`,
      )
      .join('');

    // Double the content for seamless infinite scroll
    this.tickerTrack.innerHTML = itemsHtml + itemsHtml;
  }

  /**
   * Clean up animation and call parent destroy.
   */
  public destroy(): void {
    if (this.tickerTrack) {
      this.tickerTrack.style.animationPlayState = 'paused';
      this.tickerTrack = null;
    }
    super.destroy();
  }
}
