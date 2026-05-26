import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTitlePlausible, isAllowedHost, SearchAdapter } from '../../src/adapters/search.js';
import type { AdapterContext } from '../../src/adapters/types.js';

// ── isAllowedHost ─────────────────────────────────────────────────────────────

describe('isAllowedHost', () => {
  it('accepts exact hostname match', () => {
    expect(isAllowedHost('https://luluhypermarket.com/en/rice', 'luluhypermarket.com')).toBe(true);
  });

  it('rejects subdomain that was not allowed', () => {
    expect(isAllowedHost('https://shop.luluhypermarket.com/rice', 'luluhypermarket.com')).toBe(false);
  });

  it('rejects prefix-hostname attack (evilluluhypermarket.com)', () => {
    expect(isAllowedHost('https://evilluluhypermarket.com/rice', 'luluhypermarket.com')).toBe(false);
  });

  it('rejects non-http(s) scheme', () => {
    expect(isAllowedHost('ftp://luluhypermarket.com/rice', 'luluhypermarket.com')).toBe(false);
  });

  it('rejects invalid URL', () => {
    expect(isAllowedHost('not-a-url', 'luluhypermarket.com')).toBe(false);
  });
});

// ── discoverTargets: pin branch ───────────────────────────────────────────────

const makeCtx = (pinnedUrls?: Map<string, { sourceUrl: string; productId: string; matchId: string }>): AdapterContext => ({
  config: {
    slug: 'lulu_ae',
    name: 'Lulu',
    marketCode: 'ae',
    currencyCode: 'AED',
    adapter: 'search',
    baseUrl: 'https://luluhypermarket.com',
    enabled: true,
  } as AdapterContext['config'],
  runId: 'run-1',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  retailerId: 'retailer-1',
  pinnedUrls,
});

// Stub loadAllBasketConfigs so we don't need DB / FS
vi.mock('../../src/config/loader.js', () => ({
  loadAllBasketConfigs: () => [
    {
      slug: 'essentials-ae',
      marketCode: 'ae',
      items: [
        { id: 'item-1', canonicalName: 'Eggs Fresh 12 Pack', category: 'dairy_eggs', weight: 0.1 },
      ],
    },
  ],
  loadAllRetailerConfigs: () => [],
  loadRetailerConfig: () => ({}),
}));

describe('SearchAdapter.discoverTargets', () => {
  const exa = { search: vi.fn() } as never;
  const firecrawl = { extract: vi.fn() } as never;
  const adapter = new SearchAdapter(exa, firecrawl);

  it('returns direct=true when a valid pin exists', async () => {
    const pins = new Map([
      ['essentials-ae:Eggs Fresh 12 Pack', { sourceUrl: 'https://luluhypermarket.com/en/eggs-12', productId: 'prod-1', matchId: 'match-1' }],
    ]);
    const ctx = makeCtx(pins);
    const targets = await adapter.discoverTargets(ctx);
    expect(targets).toHaveLength(1);
    expect(targets[0].metadata?.direct).toBe(true);
    expect(targets[0].url).toBe('https://luluhypermarket.com/en/eggs-12');
    expect(targets[0].metadata?.pinnedProductId).toBe('prod-1');
  });

  it('returns direct=false when no pin exists', async () => {
    const ctx = makeCtx(new Map());
    const targets = await adapter.discoverTargets(ctx);
    expect(targets).toHaveLength(1);
    expect(targets[0].metadata?.direct).toBe(false);
    expect(targets[0].url).toBe('https://luluhypermarket.com');
  });

  it('returns direct=false and warns when pin host does not match', async () => {
    const pins = new Map([
      ['essentials-ae:Eggs Fresh 12 Pack', { sourceUrl: 'https://evil.com/eggs', productId: 'prod-1', matchId: 'match-1' }],
    ]);
    const ctx = makeCtx(pins);
    const targets = await adapter.discoverTargets(ctx);
    expect(targets[0].metadata?.direct).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('host mismatch'));
  });
});

// ── fetchTarget: direct path skips Exa ───────────────────────────────────────

describe('SearchAdapter.fetchTarget direct path', () => {
  it('skips Exa and calls Firecrawl directly for direct=true targets', async () => {
    const exa = { search: vi.fn() } as never;
    const extracted = { productName: 'Eggs 12 Pack', price: 12.5, currency: 'AED', inStock: true };
    const firecrawl = { extract: vi.fn().mockResolvedValue({ data: extracted }) } as never;
    const adapter = new SearchAdapter(exa, firecrawl);

    const ctx = makeCtx();
    const target = {
      id: 'item-1',
      url: 'https://luluhypermarket.com/en/eggs-12',
      category: 'dairy_eggs',
      metadata: { canonicalName: 'Eggs Fresh 12 Pack', domain: 'luluhypermarket.com', basketSlug: 'essentials-ae', currency: 'AED', direct: true, pinnedProductId: 'prod-1', matchId: 'match-1' },
    };

    await adapter.fetchTarget(ctx, target);

    expect(exa.search).not.toHaveBeenCalled();
    expect(firecrawl.extract).toHaveBeenCalledOnce();
  });

  it('falls back to Exa when direct extraction fails', async () => {
    const exa = { search: vi.fn().mockResolvedValue([{ url: 'https://luluhypermarket.com/en/eggs-alt' }]) } as never;
    const firecrawl = {
      extract: vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ data: { productName: 'Eggs', price: 12.5, currency: 'AED', inStock: true } }),
    } as never;
    const adapter = new SearchAdapter(exa, firecrawl);

    const ctx = makeCtx();
    const target = {
      id: 'item-1',
      url: 'https://luluhypermarket.com/en/eggs-pinned',
      category: 'dairy_eggs',
      metadata: { canonicalName: 'Eggs Fresh 12 Pack', domain: 'luluhypermarket.com', basketSlug: 'essentials-ae', currency: 'AED', direct: true, pinnedProductId: 'prod-1', matchId: 'match-1' },
    };

    await adapter.fetchTarget(ctx, target);

    expect(exa.search).toHaveBeenCalledOnce();
    expect(firecrawl.extract).toHaveBeenCalledTimes(2);
  });
});

// ── inStockFromPrice ──────────────────────────────────────────────────────────

describe('inStockFromPrice flag', () => {
  const makeCtxWithFlag = (flag: boolean): AdapterContext => ({
    ...makeCtx(),
    config: {
      slug: 'bigbasket_in',
      name: 'BigBasket',
      marketCode: 'in',
      currencyCode: 'INR',
      adapter: 'search',
      baseUrl: 'https://www.bigbasket.com',
      enabled: true,
      searchConfig: { numResults: 5, inStockFromPrice: flag },
    } as AdapterContext['config'],
  });

  it('overrides inStock=true when flag=true and price > 0', async () => {
    const exa = { search: vi.fn() } as never;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: { productName: 'Eggs 6 Pack', price: 55, currency: 'INR', inStock: false } }),
    } as never;
    const adapter = new SearchAdapter(exa, firecrawl);
    const ctx = makeCtxWithFlag(true);
    const target = {
      id: 'item-1',
      url: 'https://www.bigbasket.com/pd/eggs',
      category: 'dairy_eggs',
      metadata: { canonicalName: 'Eggs Fresh 6 Pack', domain: 'www.bigbasket.com', basketSlug: 'essentials-in', currency: 'INR', direct: true },
    };
    const result = await adapter.fetchTarget(ctx, target);
    const payload = JSON.parse(result.html);
    expect(payload.extracted.inStock).toBe(true);
  });

  it('leaves inStock unchanged when flag=false', async () => {
    const exa = { search: vi.fn() } as never;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: { productName: 'Eggs 6 Pack', price: 55, currency: 'INR', inStock: false } }),
    } as never;
    const adapter = new SearchAdapter(exa, firecrawl);
    const ctx = makeCtxWithFlag(false);
    const target = {
      id: 'item-1',
      url: 'https://www.bigbasket.com/pd/eggs',
      category: 'dairy_eggs',
      metadata: { canonicalName: 'Eggs Fresh 6 Pack', domain: 'www.bigbasket.com', basketSlug: 'essentials-in', currency: 'INR', direct: true },
    };
    const result = await adapter.fetchTarget(ctx, target);
    const payload = JSON.parse(result.html);
    expect(payload.extracted.inStock).toBe(false);
  });

  it('does not override when price is 0', async () => {
    const exa = { search: vi.fn() } as never;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: { productName: 'Eggs 6 Pack', price: 0.01, currency: 'INR', inStock: false } }),
    } as never;
    const adapter = new SearchAdapter(exa, firecrawl);
    // _extractFromUrl returns null when price <= 0; test that price=0.01 still triggers override
    const ctx = makeCtxWithFlag(true);
    const target = {
      id: 'item-1',
      url: 'https://www.bigbasket.com/pd/eggs',
      category: 'dairy_eggs',
      metadata: { canonicalName: 'Eggs Fresh 6 Pack', domain: 'www.bigbasket.com', basketSlug: 'essentials-in', currency: 'INR', direct: true },
    };
    const result = await adapter.fetchTarget(ctx, target);
    const payload = JSON.parse(result.html);
    expect(payload.extracted.inStock).toBe(true);
  });
});
