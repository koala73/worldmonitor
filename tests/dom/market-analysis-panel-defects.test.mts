/**
 * Market analysis panel defects (#11271): crypto sector period label, ETF
 * volume order, non-negative news-volume axis, and rounded-zero positioning.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { hydrated } = vi.hoisted(() => ({ hydrated: new Map<string, unknown>() }));

vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/bootstrap')>(),
  getHydratedData: (key: string) => hydrated.get(key),
}));

vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/generated-rpc-clients')>(),
  MarketServiceClient: class {
    async listEtfFlows() { return { etfs: [] }; }
    async getHyperliquidFlow() { return { unavailable: true, assets: [] }; }
  },
}));

import { CryptoHeatmapPanel } from '@/components/MarketPanel';
import { ETFFlowsPanel } from '@/components/ETFFlowsPanel';
import { buildNewsMarketChart } from '@/components/NewsMarketCorrelationPanel';
import { PositioningPanel } from '@/components/PositioningPanel';

const CONTENT_DEBOUNCE_MS = 150;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  hydrated.clear();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('CryptoHeatmapPanel', () => {
  it('labels sector changes with their 24-hour period', () => {
    const panel = new CryptoHeatmapPanel();
    document.body.appendChild(panel.getElement());
    panel.renderSectors([{ id: 'layer-1', name: 'Layer 1', change: -2.914362 }]);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const element = panel.getElement();
    expect(element.querySelector('.heatmap-period')?.textContent).toBe('24h Chg');
    expect(element.querySelector('.sector-change')?.textContent).toBe('-2.91%');
  });
});

describe('ETFFlowsPanel', () => {
  it('renders rows by descending volume even when the cached array is unsorted', async () => {
    const etf = (ticker: string, volume: number) => ({
      ticker, issuer: ticker, price: 50, priceChange: -2.45, volume, avgVolume: volume,
      volumeRatio: 1, direction: 'outflow', estFlow: -volume * 5,
    });
    hydrated.set('etfFlows', {
      timestamp: '2026-11-25T00:00:00.000Z',
      summary: { etfCount: 4, totalVolume: 4_099_500, totalEstFlow: -1, netDirection: 'NET OUTFLOW', inflowCount: 0, outflowCount: 4 },
      etfs: [etf('GBTC', 1_365_400), etf('HODL', 2_530_100), etf('BRRR', 47_900), etf('EZBC', 156_100)],
      rateLimited: false,
    });
    const panel = new ETFFlowsPanel();
    document.body.appendChild(panel.getElement());
    await panel.fetchData();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const tickers = [...panel.getElement().querySelectorAll('.etf-ticker')].map((cell) => cell.textContent);
    expect(tickers).toEqual(['HODL', 'GBTC', 'EZBC', 'BRRR']);
  });
});

describe('buildNewsMarketChart', () => {
  it('keeps the news-volume axis at or above zero', () => {
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse('2026-11-18T00:00:00.000Z');
    const at = (i: number, value: number) => ({ timestamp: new Date(start + i * day).toISOString(), value });
    const news = [1, 12, 38, 20, 5, 9, 14, 3].map((value, i) => at(i, value));
    const market = [100, 101, 99, 102, 103, 101, 104, 105].map((value, i) => at(i, value));

    const host = document.createElement('div');
    host.innerHTML = buildNewsMarketChart(news, market, 168);
    const newsTicks = [...host.querySelectorAll('text[fill="#f59e0b"]')].map((label) => label.textContent ?? '');

    expect(newsTicks).toHaveLength(5);
    expect(newsTicks[newsTicks.length - 1]).toBe('0.00');
    expect(newsTicks.some((tick) => tick.startsWith('-'))).toBe(false);
  });
});

describe('PositioningPanel', () => {
  it('shows tiny negative funding and OI changes as unsigned zero', async () => {
    const sparkOi = [...Array.from({ length: 12 }, () => 1_000_000), 999_999.9];
    hydrated.set('hyperliquidFlow', {
      assets: [{ symbol: 'BTC', display: 'BTC', group: 'crypto', funding: -0.0000047493, composite: 9, sparkOi }],
    });
    const panel = new PositioningPanel();
    document.body.appendChild(panel.getElement());
    await panel.fetchData();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const [funding, oi] = [...panel.getElement().querySelectorAll('.pos-card__metrics span')];
    expect(funding?.textContent).toBe('0.000%');
    expect(funding?.className).toBe('change-positive');
    expect(oi?.textContent).toBe('+0.0%');
    expect(oi?.className).toBe('change-positive');
  });
});
