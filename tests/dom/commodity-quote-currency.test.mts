/**
 * #11269: grains, softs and cotton quote in US cents and TTF gas in euros, so
 * their cards must not carry the dollar sign every other commodity gets.
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

function priceText(el: HTMLElement, name: string): string | null | undefined {
  const card = Array.from(el.querySelectorAll('.commodity-item'))
    .find((c) => c.querySelector('.commodity-name')?.textContent === name);
  return card?.querySelector('.commodity-price')?.textContent;
}

describe('commodity card price currency', () => {
  it('shows each contract in its quote currency', async () => {
    const panel = new CommoditiesPanel();
    document.body.appendChild(panel.getElement());
    const quote = (symbol: string, display: string, price: number) => ({ symbol, display, price, change: 0.1, sparkline: [] });
    panel.renderCommodities([
      quote('GC=F', 'GOLD', 4012.3),
      quote('HG=F', 'COPPER', 5.447),
      quote('ZW=F', 'WHEAT', 585.75),
      quote('ZS=F', 'SOYBEANS', 1225.75),
      quote('KC=F', 'COFFEE', 260.4),
      quote('SB=F', 'SUGAR', 17.7),
      quote('CT=F', 'COTTON', 82.34),
      quote('ZR=F', 'RICE', 18.835),
      quote('TTF=F', 'TTF GAS', 90.405),
    ]);
    await flush();
    const el = panel.getElement();
    expect(priceText(el, 'GOLD')).toBe('$4,012');
    expect(priceText(el, 'COPPER')).toBe('$5.45');
    expect(priceText(el, 'WHEAT')).toBe('585.75¢');
    expect(priceText(el, 'SOYBEANS')).toBe('1,226¢');
    expect(priceText(el, 'COFFEE')).toBe('260.40¢');
    expect(priceText(el, 'SUGAR')).toBe('17.70¢');
    expect(priceText(el, 'COTTON')).toBe('82.34¢');
    expect(priceText(el, 'RICE')).toBe('$18.84');
    expect(priceText(el, 'TTF GAS')).toBe('€90.41');
  });
});
