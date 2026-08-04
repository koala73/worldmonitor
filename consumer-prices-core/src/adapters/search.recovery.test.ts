import { describe, expect, it, vi } from 'vitest';
import { SearchAdapter, SearchTargetError } from './search.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { AdapterContext } from './types.js';
import type { RetailerConfig } from '../config/types.js';
import { loadRetailerConfig } from '../config/loader.js';

function makeConfig(overrides: Partial<RetailerConfig['searchConfig']> = {}): RetailerConfig {
  return {
    slug: 'coldstorage_sg',
    name: 'Cold Storage Singapore',
    marketCode: 'sg',
    currencyCode: 'SGD',
    adapter: 'search',
    baseUrl: 'https://coldstorage.com.sg',
    enabled: true,
    discovery: { mode: 'search', seeds: [], maxPages: 20 },
    searchConfig: {
      numResults: 3,
      extractionFallback: 'exa',
      requireStrictValidator: true,
      ...overrides,
    },
  } as RetailerConfig;
}

function makeContext(config: RetailerConfig): AdapterContext {
  return {
    config,
    runId: 'run-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function makeTarget() {
  return {
    id: 'bread_white',
    url: 'https://coldstorage.com.sg',
    category: 'bread',
    metadata: {
      canonicalName: 'White Sandwich Bread 400g',
      domain: 'coldstorage.com.sg',
      currency: 'SGD',
      basketSlug: 'essentials-sg',
      itemConstraints: { baseUnit: 'g', minBaseQty: 350, maxBaseQty: 450 },
      direct: false,
    },
  };
}

describe('SearchAdapter recovery path', () => {
  it('falls back to Exa when Firecrawl confuses quantity with price', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue({
        data: {
          productName: 'Meadows Enriched White Bread',
          price: 4.95,
          currency: 'SGD',
          inStock: true,
          sizeText: '400g',
        },
      }),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: {
          productName: 'Meadows Enriched White Bread',
          price: 400,
          currency: 'SGD',
          inStock: true,
          sizeText: '400g',
        },
      }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const config = makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] });
    const context = makeContext(config);
    const result = await adapter.fetchTarget(context, makeTarget());
    const products = await adapter.parseListing(context, result);

    expect(firecrawl.extract).toHaveBeenCalledOnce();
    expect(exa.extract).toHaveBeenCalledOnce();
    expect(exa.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ includeDomains: ['coldstorage.com.sg', 'www.coldstorage.com.sg'] }),
    );
    expect(products[0]?.price).toBe(4.95);
    expect(products[0]?.rawPayload.extractionProvider).toBe('exa');
  });

  it('does not retry a failed pinned URL when Exa returns it again', async () => {
    const duplicateUrl = 'https://coldstorage.com.sg/en/p/bread/i/1.html';
    const replacementUrl = 'https://coldstorage.com.sg/en/p/bread/i/2.html';
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: duplicateUrl }, { url: replacementUrl }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({
          data: {
            productName: 'Meadows Enriched White Bread',
            price: 4.95,
            currency: 'SGD',
            sizeText: '400g',
          },
        }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ extractionFallback: 'none', requireStrictValidator: false }));
    const target = {
      ...makeTarget(),
      url: duplicateUrl,
      metadata: { ...makeTarget().metadata, direct: true },
    };

    const result = await adapter.fetchTarget(context, target);

    expect(firecrawl.extract).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(replacementUrl);
  });

  it('opens a Firecrawl cooldown after repeated provider errors while keeping fallback bounded', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([
        { url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' },
        { url: 'https://coldstorage.com.sg/en/p/bread/i/2.html' },
        { url: 'https://coldstorage.com.sg/en/p/bread/i/3.html' },
      ]),
      extract: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockRejectedValue(new Error('HTTP 503')),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    await expect(adapter.fetchTarget(makeContext(makeConfig()), makeTarget())).rejects.toThrow('failed extraction');

    expect(firecrawl.extract).toHaveBeenCalledTimes(2);
    expect(exa.extract).toHaveBeenCalledTimes(3);
  });

  it('opens an Exa cooldown after repeated fallback provider errors', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([
        { url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' },
        { url: 'https://coldstorage.com.sg/en/p/bread/i/2.html' },
        { url: 'https://coldstorage.com.sg/en/p/bread/i/3.html' },
      ]),
      extract: vi.fn().mockRejectedValue(new Error('Exa HTTP 503')),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    await expect(adapter.fetchTarget(makeContext(makeConfig()), makeTarget())).rejects.toThrow('failed extraction');

    expect(exa.extract).toHaveBeenCalledTimes(2);
    expect(firecrawl.extract).toHaveBeenCalledTimes(3);
  });

  it('keeps Exa extraction cooldown independent from successful discovery', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockRejectedValue(new Error('Exa extraction timeout')),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig());

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('extraction cooldown');

    expect(exa.search).toHaveBeenCalledTimes(2);
    expect(exa.extract).toHaveBeenCalledTimes(2);
  });

  it('does not rediscover after Firecrawl cooldown when no extraction fallback is configured', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockRejectedValue(new Error('Firecrawl HTTP 503')),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ extractionFallback: 'none' }));

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('Firecrawl extraction cooldown');

    expect(exa.search).toHaveBeenCalledTimes(2);
    expect(firecrawl.extract).toHaveBeenCalledTimes(2);
  });

  it('opens an Exa discovery cooldown after repeated search errors', async () => {
    const exa = {
      search: vi.fn().mockRejectedValue(new Error('Exa search HTTP 503')),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ extractionFallback: 'none' }));

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toMatchObject({
      name: 'SearchTargetError',
      rejectedCount: 0,
    });
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toMatchObject({
      name: 'SearchTargetError',
      rejectedCount: 0,
    });
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('discovery cooldown');

    expect(exa.search).toHaveBeenCalledTimes(2);
  });

  it('reports a strict final rejection once all providers return the wrong size', async () => {
    const wrongSize = {
      data: {
        productName: 'Meadows Enriched White Bread',
        price: 9.95,
        currency: 'SGD',
        sizeText: '2kg',
      },
    };
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue(wrongSize),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue(wrongSize),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const error = await adapter.fetchTarget(makeContext(makeConfig()), makeTarget()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SearchTargetError);
    expect(error).toMatchObject({ rejectedCount: 1 });
    expect((error as SearchTargetError).failures.map(({ reason }) => reason)).toEqual([
      'validator-rejected',
      'validator-rejected',
    ]);
  });

  it('keeps shadow-mode admission for an unaffected retailer when strict validation is off', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: {
          productName: 'Meadows Enriched White Bread',
          price: 9.95,
          currency: 'SGD',
          sizeText: '2kg',
        },
      }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ extractionFallback: 'none', requireStrictValidator: false }));

    const result = await adapter.fetchTarget(context, makeTarget());
    const products = await adapter.parseListing(context, result);

    expect(products[0]?.price).toBe(9.95);
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[search:shadow-reject]'));
  });

  it('loads the diagnosed retailer route policies from YAML', () => {
    const recoveryPolicies = [
      ['jiomart_in', '/p/groceries/', 'www.jiomart.com'],
      ['noon_grocery_ae', '/uae-en/', 'minutes.noon.com'],
      ['noon_sa', '/saudi-en/', 'minutes.noon.com'],
      ['carrefour_sa', '/p/', 'www.carrefourksa.com'],
      ['coldstorage_sg', '/p/', 'www.coldstorage.com.sg'],
    ] as const;

    for (const [slug, path, alias] of recoveryPolicies) {
      const searchConfig = loadRetailerConfig(slug).searchConfig;
      expect(searchConfig?.extractionFallback, slug).toBe('exa');
      expect(searchConfig?.requireStrictValidator, slug).toBe(true);
      expect(searchConfig?.urlPathContains, slug).toBe(path);
      expect(searchConfig?.allowedHosts, slug).toContain(alias);
    }

    expect(loadRetailerConfig('carrefour_ae').searchConfig?.allowedHosts).toContain('carrefouruae.com');
  });

  it('admits representative product URLs through each diagnosed host/path policy', async () => {
    const fixtures = [
      {
        slug: 'jiomart_in',
        baseUrl: 'https://www.jiomart.com',
        marketCode: 'in',
        currencyCode: 'INR',
        path: '/p/groceries/',
        alias: 'www.jiomart.com',
        url: 'https://www.jiomart.com/p/groceries/milk/1',
      },
      {
        slug: 'noon_grocery_ae',
        baseUrl: 'https://www.noon.com',
        marketCode: 'ae',
        currencyCode: 'AED',
        path: '/uae-en/',
        alias: 'minutes.noon.com',
        url: 'https://minutes.noon.com/uae-en/now-product/milk-1',
      },
      {
        slug: 'noon_sa',
        baseUrl: 'https://www.noon.com/saudi-en',
        marketCode: 'sa',
        currencyCode: 'SAR',
        path: '/saudi-en/',
        alias: 'minutes.noon.com',
        url: 'https://minutes.noon.com/saudi-en/now-product/milk-1',
      },
      {
        slug: 'carrefour_sa',
        baseUrl: 'https://www.carrefourksa.com/mafsau/en',
        marketCode: 'sa',
        currencyCode: 'SAR',
        path: '/p/',
        alias: 'www.carrefourksa.com',
        url: 'https://www.carrefourksa.com/p/milk/1',
      },
      {
        slug: 'coldstorage_sg',
        baseUrl: 'https://coldstorage.com.sg',
        marketCode: 'sg',
        currencyCode: 'SGD',
        path: '/p/',
        alias: 'www.coldstorage.com.sg',
        url: 'https://www.coldstorage.com.sg/en/p/milk/i/1.html',
      },
    ] as const;

    for (const fixture of fixtures) {
      const config = {
        ...makeConfig(),
        slug: fixture.slug,
        baseUrl: fixture.baseUrl,
        marketCode: fixture.marketCode,
        currencyCode: fixture.currencyCode,
        searchConfig: {
          numResults: 1,
          urlPathContains: fixture.path,
          allowedHosts: [fixture.alias],
          extractionFallback: 'none' as const,
          requireStrictValidator: true,
        },
      } as RetailerConfig;
      const exa = {
        search: vi.fn().mockResolvedValue([{ url: fixture.url }]),
      } as unknown as ExaProvider;
      const firecrawl = {
        extract: vi.fn().mockResolvedValue({
          data: {
            productName: 'Fresh Milk 1L',
            price: 5.95,
            currency: fixture.currencyCode,
            sizeText: '1L',
          },
        }),
      } as unknown as FirecrawlProvider;
      const adapter = new SearchAdapter(exa, firecrawl);
      const context = makeContext(config);
      const target = {
        ...makeTarget(),
        url: fixture.baseUrl,
        category: 'dairy',
        metadata: {
          ...makeTarget().metadata,
          canonicalName: 'Milk 1L',
          domain: new URL(fixture.baseUrl).hostname,
          currency: fixture.currencyCode,
          itemConstraints: { baseUnit: 'ml', minBaseQty: 500, maxBaseQty: 1500 },
          direct: false,
        },
      };

      const result = await adapter.fetchTarget(context, target);

      expect(result.url, fixture.slug).toBe(fixture.url);
    }
  });
});
