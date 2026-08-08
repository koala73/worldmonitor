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

  it('retains failed pin classifications when the Exa fallback also fails', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/2.html' }]),
      extract: vi.fn(),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            productName: 'Garden Sunflower Seeds 1kg',
            price: 9.95,
            currency: 'SGD',
            sizeText: '400g',
          },
        })
        .mockResolvedValueOnce({ data: {} }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(
      makeConfig({ allowedHosts: ['www.coldstorage.com.sg'], extractionFallback: 'none' }),
    );
    const target = {
      ...makeTarget(),
      metadata: { ...makeTarget().metadata, direct: true },
    };

    const error = await adapter.fetchTarget(context, target).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SearchTargetError);
    expect((error as SearchTargetError).failures.map(({ reason }) => reason)).toEqual([
      'title-mismatch',
      'missing-price',
    ]);
    expect(exa.extract).not.toHaveBeenCalled();
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

  // An Exa EXTRACTION cooldown must not abort the target: Exa is only the
  // fallback there, and Firecrawl — the primary extractor — is often healthy.
  // Aborting would turn a fallback outage into a whole-basket loss.
  it('keeps discovery and Firecrawl running after the Exa extraction cooldown opens', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockRejectedValue(new Error('Exa extraction timeout')),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] }));

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');
    // Third target still runs discovery and still reaches Firecrawl; only the
    // cooled-down fallback is skipped.
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');

    expect(exa.search).toHaveBeenCalledTimes(3);
    expect(firecrawl.extract).toHaveBeenCalledTimes(3);
    expect(exa.extract).toHaveBeenCalledTimes(2);
  });

  // Exa is the ONLY discovery provider, so its discovery cooldown does abort.
  it('still aborts the target when the Exa discovery cooldown is open', async () => {
    const exa = {
      search: vi.fn().mockRejectedValue(new Error('Exa search HTTP 503')),
      extract: vi.fn(),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] }));

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('Exa search failed');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('Exa search failed');
    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('discovery cooldown');

    expect(exa.search).toHaveBeenCalledTimes(2);
  });

  it('carries the provider error detail into the thrown discovery message', async () => {
    const exa = { search: vi.fn().mockRejectedValue(new Error('Exa search HTTP 401 unauthorized')) } as unknown as ExaProvider;
    const adapter = new SearchAdapter(exa, { extract: vi.fn() } as unknown as FirecrawlProvider);

    await expect(
      adapter.fetchTarget(makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] })), makeTarget()),
    ).rejects.toThrow('HTTP 401 unauthorized');
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
    // One rejection, not two: the validator judged the PAGE wrong, and both
    // extractors read the same page, so escalating would just double the cost.
    expect((error as SearchTargetError).failures.map(({ reason }) => reason)).toEqual(['validator-rejected']);
    expect(exa.extract).not.toHaveBeenCalled();
  });

  // rejected_count was structurally always 0 for non-pin search targets before
  // this adapter change, so only opted-in retailers may start reporting it.
  it('reports rejectedCount only for retailers that opted into strict validation', async () => {
    // Use title-mismatch: it fires for every retailer regardless of strict
    // mode, so `requireStrictValidator` is the only variable between the two.
    const wrongProduct = {
      data: { productName: 'Garden Sunflower Seeds 1kg', price: 9.95, currency: 'SGD', sizeText: '400g' },
    };
    const build = (requireStrictValidator: boolean) => {
      const exa = {
        search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
        extract: vi.fn().mockResolvedValue(wrongProduct),
      } as unknown as ExaProvider;
      const firecrawl = { extract: vi.fn().mockResolvedValue(wrongProduct) } as unknown as FirecrawlProvider;
      return {
        adapter: new SearchAdapter(exa, firecrawl),
        context: makeContext(
          makeConfig({ allowedHosts: ['www.coldstorage.com.sg'], requireStrictValidator, extractionFallback: 'none' }),
        ),
      };
    };

    const strict = build(true);
    const strictErr = await strict.adapter.fetchTarget(strict.context, makeTarget()).catch((e: unknown) => e);
    expect((strictErr as SearchTargetError).rejectedCount).toBe(1);

    const shadow = build(false);
    const shadowErr = await shadow.adapter.fetchTarget(shadow.context, makeTarget()).catch((e: unknown) => e);
    expect((shadowErr as SearchTargetError).rejectedCount).toBe(0);
  });

  it('rejects a quantity-like price when the extractor omits sizeText', async () => {
    const extracted = {
      data: {
        productName: 'Meadows Enriched White Bread',
        price: 400,
        currency: 'SGD',
      },
    };
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue(extracted),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue(extracted),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const error = await adapter.fetchTarget(makeContext(makeConfig()), makeTarget()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SearchTargetError);
    expect((error as SearchTargetError).failures.map(({ reason }) => reason)).toEqual([
      'quantity-as-price',
      'quantity-as-price',
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
    // Routes verified live against each retailer on 2026-08-05 (#6182).
    // jiomart_in moved OFF `/p/groceries/`, which now answers 200 with a
    // "We couldn't find the page" SPA shell on every sampled URL; coldstorage_sg
    // serves a second legacy `/product/<slug>` route alongside the catalogue one.
    const recoveryPolicies = [
      ['jiomart_in', '/product/', 'www.jiomart.com'],
      ['noon_grocery_ae', ['/p/', '/now-product/'], 'minutes.noon.com'],
      ['noon_sa', ['/p/', '/now-product/'], 'minutes.noon.com'],
      ['carrefour_sa', '/p/', 'www.carrefourksa.com'],
      ['coldstorage_sg', ['/p/', '/product/'], 'www.coldstorage.com.sg'],
    ] as const;

    for (const [slug, path, alias] of recoveryPolicies) {
      const searchConfig = loadRetailerConfig(slug).searchConfig;
      expect(searchConfig?.extractionFallback, slug).toBe('exa');
      expect(searchConfig?.requireStrictValidator, slug).toBe(true);
      expect(searchConfig?.urlPathContains, slug).toEqual(path);
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
        path: ['/p/', '/now-product/'],
        alias: 'minutes.noon.com',
        url: 'https://minutes.noon.com/uae-en/now-product/milk-1',
      },
      {
        slug: 'noon_sa',
        baseUrl: 'https://www.noon.com/saudi-en',
        marketCode: 'sa',
        currencyCode: 'SAR',
        path: ['/p/', '/now-product/'],
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

  it('rejects Noon search and category routes before extraction', async () => {
    for (const fixture of [
      { slug: 'noon_grocery_ae', locale: 'uae-en' },
      { slug: 'noon_sa', locale: 'saudi-en' },
    ]) {
      const exa = {
        search: vi.fn().mockResolvedValue([
          { url: `https://minutes.noon.com/${fixture.locale}/search?q=milk` },
          { url: `https://minutes.noon.com/${fixture.locale}/category/grocery` },
        ]),
      } as unknown as ExaProvider;
      const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;
      const adapter = new SearchAdapter(exa, firecrawl);
      const config = makeConfig({
        allowedHosts: ['minutes.noon.com'],
        urlPathContains: ['/p/', '/now-product/'],
        extractionFallback: 'none',
      });
      config.slug = fixture.slug;
      const context = makeContext(config);

      await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('host/path check');
      expect(firecrawl.extract).not.toHaveBeenCalled();
    }
  });

  // noon.com serves several storefronts from one host pair. The route filters
  // (`/p/`, `/now-product/`) are an OR, so they cannot also express "and only
  // the SA storefront" — `urlPathMustContain` carries that market scope.
  // Both fixture URLs are host-allowed and route-allowed here, so the locale
  // segment is the only thing that can reject them.
  function noonTarget() {
    const target = makeTarget();
    return { ...target, metadata: { ...target.metadata, domain: 'www.noon.com' } };
  }

  function noonConfig(market: string) {
    const config = makeConfig({
      allowedHosts: ['minutes.noon.com'],
      urlPathContains: ['/p/', '/now-product/'],
      urlPathMustContain: [market],
      extractionFallback: 'none',
    });
    config.baseUrl = 'https://www.noon.com';
    return config;
  }

  it('rejects cross-storefront Noon product URLs for the configured market', async () => {
    for (const fixture of [
      { slug: 'noon_sa', market: '/saudi-en/', foreign: 'uae-en' },
      { slug: 'noon_grocery_ae', market: '/uae-en/', foreign: 'saudi-en' },
    ]) {
      const exa = {
        search: vi.fn().mockResolvedValue([
          { url: `https://www.noon.com/${fixture.foreign}/fresh-milk/N123/p/` },
          { url: `https://minutes.noon.com/${fixture.foreign}/now-product/milk-1` },
        ]),
      } as unknown as ExaProvider;
      const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;
      const adapter = new SearchAdapter(exa, firecrawl);
      const config = noonConfig(fixture.market);
      config.slug = fixture.slug;

      await expect(adapter.fetchTarget(makeContext(config), noonTarget())).rejects.toThrow('host/path check');
      expect(firecrawl.extract, fixture.slug).not.toHaveBeenCalled();
    }
  });

  it('still admits same-storefront Noon product URLs on both hosts', async () => {
    for (const url of [
      'https://www.noon.com/saudi-en/fresh-milk/N123/p/',
      'https://minutes.noon.com/saudi-en/now-product/milk-1',
    ]) {
      const exa = { search: vi.fn().mockResolvedValue([{ url }]) } as unknown as ExaProvider;
      const firecrawl = {
        extract: vi.fn().mockResolvedValue({
          data: { productName: 'Meadows Enriched White Bread', price: 4.95, currency: 'SGD', sizeText: '400g' },
        }),
      } as unknown as FirecrawlProvider;
      const adapter = new SearchAdapter(exa, firecrawl);

      const result = await adapter.fetchTarget(makeContext(noonConfig('/saudi-en/')), noonTarget());
      expect(result.url, url).toBe(url);
    }
  });

  // A locale segment in the query string must not satisfy the market scope.
  it('matches the market segment against the pathname, not the query string', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://www.noon.com/uae-en/milk/N1/p/?ref=/saudi-en/' }]),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);

    await expect(adapter.fetchTarget(makeContext(noonConfig('/saudi-en/')), noonTarget())).rejects.toThrow(
      'host/path check',
    );
    expect(firecrawl.extract).not.toHaveBeenCalled();
  });

  it('pins the shipped Noon market scope in YAML', () => {
    expect(loadRetailerConfig('noon_sa').searchConfig?.urlPathMustContain).toEqual(['/saudi-en/']);
    expect(loadRetailerConfig('noon_grocery_ae').searchConfig?.urlPathMustContain).toEqual(['/uae-en/']);
  });

  // The opt-in boundary itself: without this, deleting the
  // `extractionFallback === 'exa'` guard leaves the whole suite green while
  // every non-opted-in retailer starts paying for a second provider.
  it('never calls the fallback extractor when extractionFallback is none', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn().mockResolvedValue({ data: {} }) } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'], extractionFallback: 'none' }));

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow('failed extraction');

    expect(firecrawl.extract).toHaveBeenCalledOnce();
    expect(exa.extract).not.toHaveBeenCalled();
  });

  it('rejects a strict-mode hit whose size is missing everywhere', async () => {
    const extracted = { data: { productName: 'Fresh Bread', price: 4.95, currency: 'SGD' } };
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue(extracted),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn().mockResolvedValue(extracted) } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const target = { ...makeTarget(), metadata: { ...makeTarget().metadata, canonicalName: 'Fresh Bread' } };

    const error = await adapter
      .fetchTarget(makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] })), target)
      .catch((err: unknown) => err);

    expect((error as SearchTargetError).failures.map(({ detail }) => detail)).toContain('missing-size');
  });

  it('rejects a foreign-currency page and does not escalate to the fallback', async () => {
    const extracted = {
      data: { productName: 'Meadows Enriched White Bread', price: 4.95, currency: 'AED', sizeText: '400g' },
    };
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue(extracted),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn().mockResolvedValue(extracted) } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);

    const error = await adapter
      .fetchTarget(makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] })), makeTarget())
      .catch((err: unknown) => err);

    expect((error as SearchTargetError).failures.map(({ reason }) => reason)).toEqual(['currency-mismatch']);
    // The page is priced in AED; a second extractor reading it cannot help.
    expect(exa.extract).not.toHaveBeenCalled();
  });

  it('rejects a strict-mode hit whose currency the extractor omitted', async () => {
    const extracted = { data: { productName: 'Meadows Enriched White Bread', price: 4.95, sizeText: '400g' } };
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://coldstorage.com.sg/en/p/bread/i/1.html' }]),
      extract: vi.fn().mockResolvedValue(extracted),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn().mockResolvedValue(extracted) } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);

    const error = await adapter
      .fetchTarget(makeContext(makeConfig({ allowedHosts: ['www.coldstorage.com.sg'] })), makeTarget())
      .catch((err: unknown) => err);

    expect((error as SearchTargetError).failures.map(({ detail }) => detail)).toEqual([
      'missing-currency',
      'missing-currency',
    ]);
  });

  it("rejects a non-grocery JioMart /p/ URL under the shipped policy", async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://www.jiomart.com/p/electronics/television-55-inch/123' }]),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const config = loadRetailerConfig('jiomart_in');
    const target = {
      ...makeTarget(),
      metadata: { ...makeTarget().metadata, domain: 'www.jiomart.com', currency: 'INR' },
    };

    await expect(adapter.fetchTarget(makeContext(config), target)).rejects.toThrow('host/path check');
    expect(firecrawl.extract).not.toHaveBeenCalled();
  });

  // Pins bypass discovery entirely, so a pin stored on a foreign storefront
  // while the scope was missing would keep being scraped directly.
  it('drops a stored pin that points at another storefront', async () => {
    const adapter = new SearchAdapter({} as unknown as ExaProvider, {} as unknown as FirecrawlProvider);
    const config = loadRetailerConfig('noon_sa');
    const context = makeContext(config);
    const pinKey = 'essentials-sa:Eggs Fresh 12 Pack';

    const foreign = await adapter.discoverTargets({
      ...context,
      pinnedUrls: new Map([[pinKey, { sourceUrl: 'https://minutes.noon.com/uae-en/now-product/eggs-1', productId: 'p1', matchId: 'm1' }]]),
    } as unknown as AdapterContext);
    const foreignTarget = foreign.find((t) => t.metadata?.canonicalName === 'Eggs Fresh 12 Pack');
    expect(foreignTarget?.metadata?.direct).toBe(false);
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('market scope'));

    const native = await adapter.discoverTargets({
      ...makeContext(config),
      pinnedUrls: new Map([[pinKey, { sourceUrl: 'https://minutes.noon.com/saudi-en/now-product/eggs-1', productId: 'p1', matchId: 'm1' }]]),
    } as unknown as AdapterContext);
    const nativeTarget = native.find((t) => t.metadata?.canonicalName === 'Eggs Fresh 12 Pack');
    expect(nativeTarget?.metadata?.direct).toBe(true);
    expect(nativeTarget?.url).toBe('https://minutes.noon.com/saudi-en/now-product/eggs-1');
  });
});
