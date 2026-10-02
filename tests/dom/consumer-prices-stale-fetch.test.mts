/**
 * A market or range click that lands while a fetch is in flight must not be
 * dropped, and the older response must not paint over the newer selection.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function overview(index: number) {
  return {
    marketCode: 'us',
    asOf: '2026-09-01T00:00:00.000Z',
    essentialsIndex: index,
    valueBasketIndex: 100,
    wowPct: 0.2,
    momPct: 0.4,
    retailerSpreadPct: 1.5,
    coveragePct: 80,
    freshnessLagMin: 12,
    upstreamUnavailable: false,
    topCategories: [],
  };
}

function clickMarket(panel: ConsumerPricesPanel, code: string): void {
  const host = panel.getElement().querySelector('.panel-content');
  if (!host) throw new Error('panel content missing');
  const button = document.createElement('button');
  button.dataset.market = code;
  host.appendChild(button);
  button.click();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  mockFetchAllMarketsOverview.mockReset();
  mockFetchConsumerPriceOverview.mockReset();
  mockFetchConsumerPriceCategories.mockResolvedValue({ categories: [] });
  mockFetchConsumerPriceMovers.mockResolvedValue({ movers: [] });
  mockFetchRetailerPriceSpreads.mockResolvedValue({ spreads: [] });
  mockFetchConsumerPriceFreshness.mockResolvedValue({ market: 'us', freshnessLagMin: 12 });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ConsumerPricesPanel in-flight fetches', () => {
  it('lets a later market click supersede the in-flight fetch', async () => {
    const older = deferred<ReturnType<typeof overview>>();
    const current = deferred<ReturnType<typeof overview>>();
    mockFetchAllMarketsOverview.mockReturnValue(deferred<unknown[]>().promise);
    mockFetchConsumerPriceOverview.mockImplementation((market: string) => {
      if (market === 'gb') return current.promise;
      return older.promise;
    });

    const panel = new ConsumerPricesPanel();
    document.body.appendChild(panel.getElement());
    void panel.fetchData();
    clickMarket(panel, 'us');
    clickMarket(panel, 'gb');

    expect(mockFetchConsumerPriceOverview.mock.calls.map((call) => call[0])).toEqual(['us', 'gb']);

    current.resolve(overview(222.2));
    await flush();
    expect(panel.getElement().textContent).toContain('222.2');

    older.resolve(overview(111.1));
    await flush();
    expect(panel.getElement().textContent).toContain('222.2');
    expect(panel.getElement().textContent).not.toContain('111.1');
    panel.destroy();
  });

  it('shows a retryable error and allows the next fetch after a failure', async () => {
    mockFetchAllMarketsOverview.mockResolvedValue([]);
    mockFetchConsumerPriceOverview.mockRejectedValueOnce(new Error('upstream down'));

    const panel = new ConsumerPricesPanel();
    document.body.appendChild(panel.getElement());
    clickMarket(panel, 'us');
    await flush();

    expect(panel.getElement().querySelector('.panel-error-msg')).not.toBeNull();

    mockFetchConsumerPriceOverview.mockResolvedValueOnce(overview(88.8));
    clickMarket(panel, 'us');
    await flush();

    expect(panel.getElement().textContent).toContain('88.8');
    expect(panel.getElement().querySelector('.panel-error-msg')).toBeNull();
    panel.destroy();
  });
});
