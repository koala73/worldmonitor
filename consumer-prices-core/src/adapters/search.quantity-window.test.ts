import { describe, expect, it, vi } from 'vitest';
import { SearchAdapter } from './search.js';
import { loadRetailerConfig } from '../config/loader.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { ExtractSchema } from '../acquisition/types.js';
import type { AdapterContext } from './types.js';

describe('basket quantity window in extraction', () => {
  it('sends the existing chicken quantity window rather than requiring exactly one kilogram', async () => {
    const config = loadRetailerConfig('bigbasket_in');
    const context: AdapterContext = {
      config,
      runId: 'quantity-window',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const extract = vi.fn().mockResolvedValue({
      data: {
        productName: 'fresho! Whole Chicken With Skin, 900 g',
        price: 701,
        currency: 'INR',
        inStock: true,
        sizeText: '900 g',
      },
      pageContent: 'fresho! Whole Chicken With Skin, 900 g\nPrice: ₹701',
    });
    const adapter = new SearchAdapter(
      { search: vi.fn() } as unknown as ExaProvider,
      { extract } as unknown as FirecrawlProvider,
    );
    const target = (await adapter.discoverTargets(context)).find((target) => target.id === 'chicken_whole_1kg');
    expect(target).toBeDefined();
    const result = await adapter.fetchTarget(context, {
      ...target!,
      url: 'https://www.bigbasket.com/pd/30000889/fresho-chicken-whole-with-skin-antibiotic-residue-free-1-pc-1-kg/',
      metadata: { ...target!.metadata, direct: true },
    });
    const schema = extract.mock.calls[0][1] as ExtractSchema;
    expect(schema.prompt).toContain('between 800g and 1200g');
    expect(schema.prompt).toContain('Convert equivalent displayed units to g before comparing the quantity');
    expect(schema.prompt).toContain('an incompatible measurement type');
    expect(schema.prompt).toContain('Keep the requested pack count of 1');
    expect(schema.prompt).toContain('a different pack count, or a bulk case, return null for price');
    expect(schema.prompt).not.toContain('The product MUST be 1kg');
    const products = await adapter.parseListing(context, result);
    expect(products[0]).toMatchObject({ price: 701, rawSizeText: '900 g' });
    expect(products[0].rawPayload.validator).toMatchObject({ ok: true });
    expect(products[0].rawPayload.priceEvidence).toBe('verified');
  });
});
