/**
 * RecencyFilter — persistent time-range selector.
 *
 * Renders a compact dropdown/chip bar that lets users filter
 * news, map events, and insights by recency (1h, 6h, 24h, 3d, 7d, all).
 *
 * Integrates with:
 *  - URL parameter `?recency=…`  (shareable, embed bridge control)
 *  - Embed bridge inbound `wm:set-recency`
 *  - DataLoaderManager filtering pipeline
 */

import { type RecencyRange, RECENCY_OPTIONS, getRecencyLabel, parseRecencyParam, isRecencyRange } from '@/utils/recency';
import { SITE_VARIANT } from '@/config/variant';

export type RecencyChangeHandler = (range: RecencyRange) => void;

export class RecencyFilter {
  private element: HTMLElement;
  private currentRange: RecencyRange;
  private onChange: RecencyChangeHandler | null = null;

  constructor() {
    // Initialise from URL or default
    this.currentRange = parseRecencyParam(window.location.search);

    this.element = document.createElement('div');
    this.element.className = 'recency-filter';
    if (SITE_VARIANT === 'codexes') {
      this.element.classList.add('recency-filter--embedded');
    }
    this.render();
    this.setupListeners();
  }

  /** Mount into a parent container. */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.element);
  }

  /** Remove from DOM. */
  unmount(): void {
    this.element.remove();
  }

  /** Register a change handler. */
  onRangeChange(handler: RecencyChangeHandler): void {
    this.onChange = handler;
  }

  /** Programmatically set the range (e.g. from embed bridge). */
  setRange(range: RecencyRange): void {
    if (range === this.currentRange) return;
    this.currentRange = range;
    this.render();
    this.syncUrl();
    this.onChange?.(range);
  }

  /** Current active range. */
  getRange(): RecencyRange {
    return this.currentRange;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  // ------------------------------------------------------------------

  private render(): void {
    this.element.innerHTML = '';

    for (const opt of RECENCY_OPTIONS) {
      const chip = document.createElement('button');
      chip.className = 'recency-chip';
      if (opt === this.currentRange) chip.classList.add('recency-chip--active');
      chip.textContent = getRecencyLabel(opt);
      chip.dataset.range = opt;
      this.element.appendChild(chip);
    }
  }

  private setupListeners(): void {
    this.element.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.recency-chip');
      if (!target?.dataset.range) return;
      const range = target.dataset.range;
      if (isRecencyRange(range)) {
        this.setRange(range);
      }
    });
  }

  private syncUrl(): void {
    const url = new URL(window.location.href);
    if (this.currentRange === 'all') {
      url.searchParams.delete('recency');
    } else {
      url.searchParams.set('recency', this.currentRange);
    }
    window.history.replaceState(null, '', url.toString());
  }
}
