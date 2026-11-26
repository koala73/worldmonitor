import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const {
  mockFetchAllMarketsOverview,
  mockFetchConsumerPriceOverview,
  mockFetchConsumerPriceCategories,
  mockFetchConsumerPriceMovers,
  mockFetchRetailerPriceSpreads,
  mockFetchConsumerPriceFreshness,
} = vi.hoisted(() => ({
  mockFetchAllMarketsOverview: vi.fn(),
  mockFetchConsumerPriceOverview: vi.fn(),
  mockFetchConsumerPriceCategories: vi.fn(),
  mockFetchConsumerPriceMovers: vi.fn(),
  mockFetchRetailerPriceSpreads: vi.fn(),
  mockFetchConsumerPriceFreshness: vi.fn(),
}));

vi.mock('@/services/consumer-prices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/consumer-prices')>();
  return {
    ...actual,
    fetchAllMarketsOverview: mockFetchAllMarketsOverview,
    fetchConsumerPriceOverview: mockFetchConsumerPriceOverview,
    fetchConsumerPriceCategories: mockFetchConsumerPriceCategories,
    fetchConsumerPriceMovers: mockFetchConsumerPriceMovers,
    fetchRetailerPriceSpreads: mockFetchRetailerPriceSpreads,
    fetchConsumerPriceFreshness: mockFetchConsumerPriceFreshness,
  };
});

vi.mock('@/services/imf-country-data', () => ({
  getAllCountriesInflation: vi.fn(async () => []),
}));

import { ConsumerPricesPanel } from '@/components/ConsumerPricesPanel';

const CONTENT_DEBOUNCE_MS = 150;

const BASE = { upstreamUnavailable: false, asOf: '2026-11-25T00:00:00.000Z' };

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

function click(panel: ConsumerPricesPanel, attrs: Record<string, string>): void {
  const host = panel.getElement().querySelector('.panel-content');
  if (!host) throw new Error('panel content missing');
  const button = document.createElement('button');
  Object.assign(button.dataset, attrs);
  host.appendChild(button);
  button.click();
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('names mover categories and retailers the way shoppers know them', async () => {
  localStorage.clear();
  vi.useFakeTimers();
  mockFetchAllMarketsOverview.mockResolvedValue([]);
  mockFetchConsumerPriceOverview.mockResolvedValue({
    ...BASE, marketCode: 'ae', currencyCode: 'AED', essentialsIndex: 111.2, valueBasketIndex: 100,
    wowPct: 0, momPct: 0, retailerSpreadPct: 20, coveragePct: 80, freshnessLagMin: 90, topCategories: [],
  });
  mockFetchConsumerPriceCategories.mockResolvedValue({ ...BASE, categories: [] });
  mockFetchConsumerPriceMovers.mockResolvedValue({
    ...BASE, marketCode: 'ae', range: '30d', fallers: [],
    risers: [{ productId: 'p1', title: 'Sunflower Oil 1.8L', category: 'cooking_oil', retailerSlug: 'lulu_ae', changePct: 12.5, currentPrice: 19.5, currencyCode: 'AED' }],
  });
  mockFetchRetailerPriceSpreads.mockResolvedValue({ ...BASE, marketCode: 'ae', basketSlug: 'essentials-ae', currencyCode: 'AED', retailers: [], spreadPct: 0 });
  mockFetchConsumerPriceFreshness.mockResolvedValue({
    ...BASE, marketCode: 'ae', overallFreshnessMin: 90, stalledCount: 0,
    retailers: [{ slug: 'lulu_ae', name: 'Lulu Hypermarket UAE', lastRunAt: '2026-11-25T00:00:00.000Z', status: 'ok', parseSuccessRate: 1, freshnessMin: 90 }],
  });

  const panel = new ConsumerPricesPanel();
  document.body.appendChild(panel.getElement());
  click(panel, { market: 'ae' });
  await flush();
  panel.getElement().querySelector<HTMLElement>('.panel-tab[data-tab="movers"]')?.click();
  await flush();

  const meta = panel.getElement().querySelector('.cp-mover-meta')?.textContent ?? '';
  expect(meta).toContain('Cooking Oil');
  expect(meta).toContain('Lulu Hypermarket UAE');
  expect(meta).not.toContain('cooking_oil');
  expect(meta).not.toContain('lulu_ae');
  panel.destroy();
});
