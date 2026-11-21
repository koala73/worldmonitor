/**
 * #10463 ask 6: a commodity with a price but no sparkline (MTF=F publishes an
 * empty series) must keep its card aligned with its neighbours. The chart row
 * is replaced by an empty, aria-hidden slot rather than collapsing, so the
 * price does not jump up the card.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { CommoditiesPanel } = await import('@/components/MarketPanel');

const flush = () => vi.advanceTimersByTimeAsync(151);

beforeAll(async () => {
  await initTestI18n();
});
beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function card(el: HTMLElement, name: string): Element | undefined {
  return Array.from(el.querySelectorAll('.commodity-item')).find((c) => c.querySelector('.commodity-name')?.textContent === name);
}

describe('commodity card without a sparkline', () => {
  it('reserves the chart slot and draws no chart', async () => {
    const panel = new CommoditiesPanel();
    document.body.appendChild(panel.getElement());
    panel.renderCommodities([
      { symbol: 'GC=F', display: 'GOLD', price: 4000, change: 0.5, sparkline: [1, 2, 3], sparklineIntervalSeconds: 300, sparklineStartAt: Date.now() - 3_600_000 },
      { symbol: 'MTF=F', display: 'COKING COAL', price: 200, change: 0.1, sparkline: [] },
    ]);
    await flush();
    const el = panel.getElement();
    const empty = card(el, 'COKING COAL')!;
    expect(empty.querySelector('svg')).toBeNull();
    const slot = empty.querySelector('.commodity-spark-empty');
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.textContent).toBe('');
    expect(card(el, 'GOLD')!.querySelector('.commodity-spark-empty')).toBeNull();
  });
});
