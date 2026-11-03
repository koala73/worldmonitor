/**
 * Heatmap tab switches must commit in the user's action (#7775).
 *
 * `setSafeContent` coalesces background ticks behind a 150 ms timer. The
 * Heatmap Performance/Valuations buttons used that path, so a click rebuilt
 * markup only after the timer and replaced the focused button. These cases
 * drive the real `HeatmapPanel` buttons and require the new tab's body
 * without advancing that timer.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HeatmapPanel } from '@/components/MarketPanel';
import type { SectorValuation } from '@/components/MarketPanel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const CONTENT_DEBOUNCE_MS = 150;

const SECTORS = [
  { symbol: 'XLK', name: 'Technology', change: 1.25 },
  { symbol: 'XLE', name: 'Energy', change: -0.4 },
];

const BARS = [
  { symbol: 'XLK', name: 'Technology', change1d: 1.25 },
  { symbol: 'XLE', name: 'Energy', change1d: -0.4 },
];

const VALUATIONS: Record<string, SectorValuation> = {
  XLK: {
    trailingPE: 28.1,
    forwardPE: 24.4,
    beta: 1.12,
    ytdReturn: 0.18,
    threeYearReturn: 0.42,
    fiveYearReturn: 0.91,
  },
  XLE: {
    trailingPE: 14.2,
    forwardPE: 12.6,
    beta: 0.88,
    ytdReturn: -0.05,
    threeYearReturn: 0.11,
    fiveYearReturn: 0.2,
  },
};

interface PanelContentInternals {
  content: HTMLElement;
  contentDebounceTimer: ReturnType<typeof setTimeout> | null;
  pendingContentCallback: (() => void) | null;
  pendingContentHtml: string | null;
}

let panel: HeatmapPanel;

function internals(): PanelContentInternals {
  return panel as unknown as PanelContentInternals;
}

function content(): HTMLElement {
  return internals().content;
}

function tabButton(tab: 'performance' | 'valuations'): HTMLButtonElement {
  const btn = content().querySelector<HTMLButtonElement>(`.panel-tab[data-tab="${tab}"]`);
  if (!btn) throw new Error(`missing ${tab} tab button`);
  return btn;
}

function isPerformance(): boolean {
  return content().querySelector('.heatmap') !== null && content().querySelector('table') === null;
}

function isValuations(): boolean {
  return content().querySelector('table') !== null && content().querySelector('.heatmap') === null;
}

function activeTab(): string | undefined {
  return content().querySelector<HTMLElement>('.panel-tab.active')?.dataset.tab;
}

function populate(flushInitial: boolean): void {
  panel.renderHeatmap(SECTORS, BARS);
  panel.updateValuations(VALUATIONS);
  if (flushInitial) vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

function activate(tab: 'performance' | 'valuations', via: 'click' | 'Enter' | ' '): void {
  const btn = tabButton(tab);
  btn.focus();
  if (via === 'click') {
    btn.click();
    return;
  }
  const event = new KeyboardEvent('keydown', { key: via, bubbles: true, cancelable: true });
  btn.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  if (via === ' ') {
    btn.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  panel = new HeatmapPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('Heatmap tab commit (#7775)', () => {
  it('commits Valuations on click without the 150 ms background timer', () => {
    populate(true);
    expect(isPerformance()).toBe(true);

    activate('valuations', 'click');

    expect(internals().contentDebounceTimer).toBeNull();
    expect(isValuations()).toBe(true);
    expect(activeTab()).toBe('valuations');
    expect(document.activeElement).toBe(tabButton('valuations'));
  });

  it.each(['Enter', ' '] as const)(
    'selects Valuations with %s and keeps focus on the replacement button',
    (key) => {
      populate(true);
      activate('valuations', key);

      expect(internals().contentDebounceTimer).toBeNull();
      expect(isValuations()).toBe(true);
      expect(activeTab()).toBe('valuations');
      expect(document.activeElement).toBe(tabButton('valuations'));
    },
  );

  it('selects Performance with Enter after Valuations and keeps focus', () => {
    populate(true);
    activate('valuations', 'click');
    activate('performance', 'Enter');

    expect(internals().contentDebounceTimer).toBeNull();
    expect(isPerformance()).toBe(true);
    expect(activeTab()).toBe('performance');
    expect(document.activeElement).toBe(tabButton('performance'));
  });

  it('keeps background updates on the 150 ms coalescing timer', () => {
    populate(false);

    expect(content().querySelector('.heatmap')).toBeNull();
    expect(internals().contentDebounceTimer).not.toBeNull();

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS - 1);
    expect(content().querySelector('.heatmap')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(isPerformance()).toBe(true);
  });

  it('rapid Performance/Valuations/Performance settles on the last tab', () => {
    populate(true);

    activate('valuations', 'click');
    activate('performance', 'click');
    activate('valuations', 'click');
    activate('performance', 'click');

    expect(isPerformance()).toBe(true);
    expect(activeTab()).toBe('performance');
    expect(internals().contentDebounceTimer).toBeNull();
    expect(document.activeElement).toBe(tabButton('performance'));

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);
    expect(isPerformance()).toBe(true);
    expect(activeTab()).toBe('performance');
  });

  it('a refresh queued before a click cannot restore the older tab', () => {
    populate(true);
    panel.renderHeatmap(
      [
        { symbol: 'XLK', name: 'Queued Technology', change: 3.5 },
        { symbol: 'XLE', name: 'Queued Energy', change: 1.1 },
      ],
      BARS,
    );
    expect(internals().contentDebounceTimer).not.toBeNull();
    expect(isPerformance()).toBe(true);

    const superseded = vi.fn();
    internals().pendingContentCallback = superseded;

    activate('valuations', 'click');

    expect(isValuations()).toBe(true);
    expect(superseded).not.toHaveBeenCalled();
    expect(internals().pendingContentCallback).toBeNull();
    expect(content().querySelector('.heatmap')).toBeNull();

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);
    expect(isValuations()).toBe(true);
    expect(content().querySelector('.heatmap')).toBeNull();
    expect(superseded).not.toHaveBeenCalled();
  });

  it('a refresh arriving after a click renders the selected tab, not the previous one', () => {
    populate(true);
    activate('valuations', 'click');
    expect(isValuations()).toBe(true);

    panel.renderHeatmap(
      [
        { symbol: 'XLK', name: 'Refreshed Technology', change: 0.5 },
        { symbol: 'XLE', name: 'Refreshed Energy', change: 0.1 },
      ],
      BARS,
    );

    expect(isValuations()).toBe(true);
    expect(content().textContent).not.toContain('Refreshed Technology');

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(isValuations()).toBe(true);
    expect(content().textContent).toContain('Refreshed Technology');
    expect(content().querySelector('.heatmap')).toBeNull();
  });

  it('does not move focus onto a tab during a background refresh', () => {
    populate(true);
    const probe = document.createElement('button');
    probe.id = 'outside-focus-probe';
    document.body.appendChild(probe);
    probe.focus();
    expect(document.activeElement).toBe(probe);

    panel.renderHeatmap(SECTORS, BARS);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(isPerformance()).toBe(true);
    expect(document.activeElement).toBe(probe);
  });

  it('a queued refresh cannot paint over a lock, including after the timer', () => {
    populate(true);
    panel.renderHeatmap(
      [
        { symbol: 'XLK', name: 'Locked Technology', change: 2 },
        { symbol: 'XLE', name: 'Locked Energy', change: 1 },
      ],
      BARS,
    );
    expect(internals().contentDebounceTimer).not.toBeNull();
    panel.showLocked(['Heatmap']);
    expect(content().querySelector('.panel-locked-state')).not.toBeNull();

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);

    expect(content().querySelector('.panel-locked-state')).not.toBeNull();
    expect(content().querySelector('.heatmap')).toBeNull();
    expect(content().querySelector('table')).toBeNull();
    expect(content().textContent).not.toContain('Locked Technology');
  });

  it('unlock restoration keeps the pre-lock body and ignores a later timer', () => {
    populate(true);
    expect(isPerformance()).toBe(true);
    panel.renderHeatmap(
      [
        { symbol: 'XLK', name: 'Post-lock Technology', change: 2 },
        { symbol: 'XLE', name: 'Post-lock Energy', change: 1 },
      ],
      BARS,
    );
    panel.showLocked(['Heatmap']);
    panel.unlockPanel();

    expect(isPerformance()).toBe(true);
    expect(content().textContent).toContain('Technology');
    expect(content().textContent).not.toContain('Post-lock Technology');

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);
    expect(isPerformance()).toBe(true);
    expect(content().querySelector('.panel-locked-state')).toBeNull();
    expect(content().textContent).not.toContain('Post-lock Technology');
  });
});
