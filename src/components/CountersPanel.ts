import { Panel } from './Panel';
import {
  COUNTER_METRICS,
  getCounterValue,
  formatCounterValue,
  type CounterMetric,
} from '@/services/humanity-counters';
import { isDesktopRuntime } from '@/services/runtime';

/**
 * CountersPanel -- Worldometer-style ticking counters showing positive global metrics.
 *
 * Displays 6 metrics (births, trees, vaccines, graduates, books, renewable MW)
 * with values ticking via requestAnimationFrame. Values are calculated
 * from absolute time (seconds since midnight UTC * per-second rate) to avoid
 * drift across tabs, throttling, or background suspension.
 *
 * No API calls needed -- all data derived from hardcoded annual rates.
 */
export class CountersPanel extends Panel {
  private animFrameId: number | null = null;
  private valueElements: Map<string, HTMLElement> = new Map();
  private readonly desktopMode = isDesktopRuntime();
  private visibilityHandler: (() => void) | null = null;
  private lastDesktopUpdateAt = 0;
  private readonly desktopUpdateIntervalMs = 250;

  constructor() {
    super({ id: 'counters', title: 'Live Counters', trackActivity: false });
    this.createCounterGrid();
    if (this.desktopMode) {
      this.visibilityHandler = () => {
        if (document.hidden) {
          this.stopTicking();
          return;
        }
        this.lastDesktopUpdateAt = 0;
        this.startTicking();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.startTicking();
  }

  /**
   * Build the 6 counter cards and insert them into the panel content area.
   */
  private createCounterGrid(): void {
    const grid = document.createElement('div');
    grid.className = 'counters-grid';

    for (const metric of COUNTER_METRICS) {
      const card = this.createCounterCard(metric);
      grid.appendChild(card);
    }

    // Clear loading state and append the grid
    this.content.innerHTML = '';
    this.content.appendChild(grid);
  }

  /**
   * Create a single counter card with icon, value, label, and source.
   */
  private createCounterCard(metric: CounterMetric): HTMLElement {
    const card = document.createElement('div');
    card.className = 'counter-card';

    const icon = document.createElement('div');
    icon.className = 'counter-icon';
    icon.textContent = metric.icon;

    const value = document.createElement('div');
    value.className = 'counter-value';
    value.dataset.counter = metric.id;
    // Set initial value from absolute time
    value.textContent = formatCounterValue(
      getCounterValue(metric),
      metric.formatPrecision,
    );

    const label = document.createElement('div');
    label.className = 'counter-label';
    label.textContent = metric.label;

    const source = document.createElement('div');
    source.className = 'counter-source';
    source.textContent = metric.source;

    card.appendChild(icon);
    card.appendChild(value);
    card.appendChild(label);
    card.appendChild(source);

    // Store reference for fast 60fps updates
    this.valueElements.set(metric.id, value);

    return card;
  }

  /**
   * Start the requestAnimationFrame animation loop.
   * Each tick recalculates all counter values from absolute time.
   */
  public startTicking(): void {
    if (this.animFrameId !== null) return; // Already ticking
    if (this.desktopMode && document.hidden) return;
    this.animFrameId = requestAnimationFrame(this.tick);
  }

  private stopTicking(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /**
   * Animation tick -- arrow function for correct `this` binding.
   * Updates all 6 counter values using textContent (not innerHTML).
   * Desktop runtime is throttled to reduce background CPU usage.
   */
  private tick = (): void => {
    if (this.desktopMode) {
      const now = performance.now();
      if ((now - this.lastDesktopUpdateAt) < this.desktopUpdateIntervalMs) {
        this.animFrameId = requestAnimationFrame(this.tick);
        return;
      }
      this.lastDesktopUpdateAt = now;
    }

    for (const metric of COUNTER_METRICS) {
      const el = this.valueElements.get(metric.id);
      if (el) {
        const value = getCounterValue(metric);
        el.textContent = formatCounterValue(value, metric.formatPrecision);
      }
    }
    this.animFrameId = requestAnimationFrame(this.tick);
  };

  /**
   * Clean up animation frame and call parent destroy.
   */
  public destroy(): void {
    this.stopTicking();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.valueElements.clear();
    super.destroy();
  }
}
