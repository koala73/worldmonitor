/**
 * Bounded extraction candidates for #6182.
 *
 * Discovery breadth and extraction cost were the same knob: `numResults` set
 * how many URLs Exa returned AND how many the adapter would extract from,
 * each with up to two providers. A retailer whose live route ranks low needs a
 * WIDE search, but widening it multiplied paid calls on exactly the pages that
 * never yield a price — JioMart reached 16 provider calls on a single basket
 * item. #6182 requires retry/provider-error volume to stay bounded, so the two
 * concerns are separated: search as wide as discovery needs, extract from at
 * most `maxExtractionCandidates` of the survivors.
 */
import { describe, expect, it, vi } from 'vitest';
import { SearchAdapter, SearchTargetError } from './search.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { AdapterContext } from './types.js';
import type { RetailerConfig } from '../config/types.js';

function makeConfig(overrides: Partial<NonNullable<RetailerConfig['searchConfig']>> = {}): RetailerConfig {
  return {
    slug: 'jiomart_in',
    name: 'JioMart India',
    marketCode: 'in',
    currencyCode: 'INR',
    adapter: 'search',
    baseUrl: 'https://www.jiomart.com',
    enabled: true,
    discovery: { mode: 'search', seeds: [], maxPages: 20 },
    searchConfig: { numResults: 10, urlPathContains: '/product/', ...overrides },
  } as RetailerConfig;
}

function makeContext(config: RetailerConfig): AdapterContext {
  return { config, runId: 'run-1', logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

function makeTarget() {
  return {
    id: 'onions_1kg',
    url: 'https://www.jiomart.com',
    category: 'onions',
    metadata: {
      canonicalName: 'Onions 1kg',
      domain: 'www.jiomart.com',
      currency: 'INR',
      basketSlug: 'essentials-in',
      itemConstraints: { baseUnit: 'g', minBaseQty: 800, maxBaseQty: 1200 },
      direct: false,
    },
  };
}

/** Eight distinct in-policy URLs, none of which will yield a price. */
const EIGHT_URLS = Array.from({ length: 8 }, (_, i) => ({ url: `https://www.jiomart.com/product/onion-${i}` }));

function priceless() {
  return {
    search: vi.fn().mockResolvedValue(EIGHT_URLS),
    extract: vi.fn().mockResolvedValue({ data: { productName: 'Onion 1 kg', currency: 'INR', sizeText: '1 kg' } }),
  } as unknown as ExaProvider & { extract: ReturnType<typeof vi.fn> };
}

describe('searchConfig.maxExtractionCandidates', () => {
  it('stops extracting after the configured number of candidates', async () => {
    const exa = priceless();
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: { productName: 'Onion 1 kg', currency: 'INR', sizeText: '1 kg' } }),
    } as unknown as FirecrawlProvider & { extract: ReturnType<typeof vi.fn> };
    const config = makeConfig({ maxExtractionCandidates: 3 });

    await expect(
      new SearchAdapter(exa, firecrawl).fetchTarget(makeContext(config), makeTarget()),
    ).rejects.toBeInstanceOf(SearchTargetError);

    // 8 URLs discovered, only 3 attempted.
    expect((firecrawl as unknown as { extract: ReturnType<typeof vi.fn> }).extract).toHaveBeenCalledTimes(3);
  });

  it('leaves retailers without the bound attempting every discovered URL', async () => {
    const exa = priceless();
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: { productName: 'Onion 1 kg', currency: 'INR', sizeText: '1 kg' } }),
    } as unknown as FirecrawlProvider & { extract: ReturnType<typeof vi.fn> };

    await expect(
      new SearchAdapter(exa, firecrawl).fetchTarget(makeContext(makeConfig()), makeTarget()),
    ).rejects.toBeInstanceOf(SearchTargetError);

    expect((firecrawl as unknown as { extract: ReturnType<typeof vi.fn> }).extract).toHaveBeenCalledTimes(8);
  });

  it('does not truncate before a later candidate that would have succeeded', async () => {
    // The bound must not silently drop a winning page: with the bound at 3 the
    // third URL still gets its chance.
    const exa = priceless();
    const firecrawl = {
      extract: vi
        .fn()
        .mockResolvedValueOnce({ data: { productName: 'Onion 1 kg', currency: 'INR', sizeText: '1 kg' } })
        .mockResolvedValueOnce({ data: { productName: 'Onion 1 kg', currency: 'INR', sizeText: '1 kg' } })
        .mockResolvedValue({ data: { productName: 'Onion 1 kg', price: 37, currency: 'INR', sizeText: '1 kg' } }),
    } as unknown as FirecrawlProvider;
    const config = makeConfig({ maxExtractionCandidates: 3 });

    const result = await new SearchAdapter(exa, firecrawl).fetchTarget(makeContext(config), makeTarget());

    expect(JSON.parse(result.html).extracted.price).toBe(37);
  });
});
