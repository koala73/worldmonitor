/**
 * Market, crypto, and token rows must not paint a positive price as $0 (#9705).
 *
 * The three panels are the presentation paths named in the report. They render
 * through the real panel classes so a later inline `toLocaleString()` cannot
 * pass a formatter-only test while the DOM still shows zero.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { CryptoData, MarketData, TokenData } from '@/types';

const { AiTokensPanel, CryptoPanel, MarketPanel } = await import('@/components/MarketPanel');

const CONTENT_DEBOUNCE_MS = 150;
const numberToLocaleString = Number.prototype.toLocaleString;

const PRICES = [0.00024, 1e-8, 1e-12, -0.00024, -1e-12, 0, 0.123456, 0.5, 12.5, 1500, -0.5] as const;

const EXPECTED = [
  '$0.00024',
  '$0.00000001',
  '<$0.00000001',
  '$-0.00024',
  '>-$0.00000001',
  '$0.00',
  '$0.123456',
  '$0.50',
  '$12.50',
  '$1,500',
  '$-0.50',
];

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

function priceTexts(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.market-price'), (el) => el.textContent ?? '');
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales, options) {
    return numberToLocaleString.call(this, locales ?? 'en-US', options);
  });
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('sub-cent asset prices stay visible (#9705)', () => {
  it('preserves ordinary crypto and token quote precision', async () => {
    const crypto = new CryptoPanel();
    const tokens = new AiTokensPanel();
    document.body.append(crypto.getElement(), tokens.getElement());

    const prices = [3200.75, 12.345, NaN, Infinity, -Infinity];
    crypto.renderCrypto(prices.map((price) => ({ name: 'Coin', symbol: 'C', price, change: 0 })));
    tokens.renderTokens(prices.map((price) => ({ name: 'Token', symbol: 'T', price, change24h: 0, change7d: 0 })));
    await flush();

    expect(priceTexts(crypto.getElement())).toEqual(['$3,200.75', '$12.345', '--', '--', '--']);
    expect(priceTexts(tokens.getElement())).toEqual(['$3,200.75', '$12.35', '--', '--', '--']);
  });

  it('keeps sub-cent prices visible across the market, crypto, and token panels', async () => {
    const markets = new MarketPanel();
    const crypto = new CryptoPanel();
    const tokens = new AiTokensPanel();
    document.body.append(markets.getElement(), crypto.getElement(), tokens.getElement());

    const marketRows: MarketData[] = PRICES.map((price, index) => ({
      symbol: `M${index}`,
      name: `Market ${index}`,
      display: `M${index}`,
      price,
      change: 0,
    }));
    const cryptoRows: CryptoData[] = PRICES.map((price, index) => ({
      name: `Coin ${index}`,
      symbol: `C${index}`,
      price,
      change: 0,
    }));
    const tokenRows: TokenData[] = PRICES.map((price, index) => ({
      name: `Token ${index}`,
      symbol: `T${index}`,
      price,
      change24h: 0,
      change7d: 0,
    }));

    markets.renderMarkets(marketRows);
    crypto.renderCrypto(cryptoRows);
    tokens.renderTokens(tokenRows);
    await flush();

    expect(priceTexts(markets.getElement())).toEqual(EXPECTED);
    const assetExpected = [...EXPECTED];
    assetExpected[8] = '$12.5';
    expect(priceTexts(crypto.getElement())).toEqual(assetExpected);
    expect(priceTexts(tokens.getElement())).toEqual(assetExpected);

    for (const text of [...priceTexts(markets.getElement()), ...priceTexts(crypto.getElement()), ...priceTexts(tokens.getElement())]) {
      expect(text.length).toBeLessThanOrEqual(16);
    }
  });
});
