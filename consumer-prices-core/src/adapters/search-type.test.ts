/**
 * Discovery search-mode plumbing for #6182.
 *
 * Exa defaults to neural search, which ranks by semantic similarity over its
 * crawled index and therefore keeps returning URLs a retailer has since
 * retired. Measured against JioMart on 2026-08-05 over five basket items:
 *
 *   neural  n=5   →  0 live /product/ URLs, 22 retired /p/groceries/  (0/5 items)
 *   neural  n=15  →  2 live,               66 retired                 (2/5 items)
 *   keyword n=15  → 33 live,               13 retired                 (5/5 items)
 *
 * Keyword search matches the retailer's current pages, so a retailer whose
 * routes have moved needs it. The mode has to be per-retailer config, not a
 * global default, because neural still wins where the index is current.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildExaDiscoveryRequest, SearchAdapter } from './search.js';
import { loadRetailerConfig } from '../config/loader.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { AdapterContext } from './types.js';
import type { RetailerConfig } from '../config/types.js';

function makeAdapter(searchMock: ReturnType<typeof vi.fn>) {
  const exa = { search: searchMock, extract: vi.fn().mockResolvedValue({ data: {} }) } as unknown as ExaProvider;
  const firecrawl = {
    extract: vi.fn().mockResolvedValue({
      data: { productName: 'Onion 1 kg', price: 37, currency: 'INR', inStock: true, sizeText: '1 kg' },
    }),
  } as unknown as FirecrawlProvider;
  return new SearchAdapter(exa, firecrawl);
}

function contextFor(config: RetailerConfig): AdapterContext {
  return { config, runId: 'run-1', logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

function targetFor(config: RetailerConfig) {
  return {
    id: 'onions_1kg',
    url: config.baseUrl,
    category: 'onions',
    metadata: {
      canonicalName: 'Onions 1kg',
      domain: new URL(config.baseUrl).hostname,
      currency: config.currencyCode,
      basketSlug: 'essentials-in',
      itemConstraints: { baseUnit: 'g', minBaseQty: 800, maxBaseQty: 1200 },
      direct: false,
    },
  };
}

describe('searchConfig.searchType', () => {
  it('builds one request contract for production and discovery diagnostics', () => {
    const config = loadRetailerConfig('jiomart_in');

    const request = buildExaDiscoveryRequest({
      searchConfig: config.searchConfig,
      canonicalName: 'Onions 1kg',
      category: 'onions',
      currency: config.currencyCode,
      marketName: 'India',
      includeDomains: ['www.jiomart.com'],
    });

    expect(request).toEqual({
      query: 'Onions 1kg onions grocery food India INR price',
      options: {
        numResults: 10,
        includeDomains: ['www.jiomart.com'],
        type: 'keyword',
        timeout: 30_000,
      },
    });
  });

  it('forwards the configured search mode to Exa discovery', async () => {
    const config = loadRetailerConfig('jiomart_in');
    const search = vi.fn().mockResolvedValue([{ url: 'https://www.jiomart.com/product/onion-1-kg-pack-mffneb-7550741' }]);

    await makeAdapter(search).fetchTarget(contextFor(config), targetFor(config));

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[1]).toMatchObject({ type: 'keyword' });
  });

  it('leaves the provider default in place when a retailer does not set it', async () => {
    const config = loadRetailerConfig('bigbasket_in');
    const search = vi.fn().mockResolvedValue([{ url: 'https://www.bigbasket.com/pd/12345/onion-1kg/' }]);

    await makeAdapter(search).fetchTarget(contextFor(config), targetFor(config));

    expect(search.mock.calls[0]?.[1]).not.toHaveProperty('type', 'keyword');
  });

  it('pins jiomart_in to keyword search so discovery reaches the live route', () => {
    expect(loadRetailerConfig('jiomart_in').searchConfig?.searchType).toBe('keyword');
  });
});
