import { describe, expect, it, vi } from 'vitest';
import { SearchAdapter, SearchTargetError } from './search.js';
import { loadRetailerConfig } from '../config/loader.js';
import { classifyMatchAdmission } from '../jobs/scrape-coverage.js';
import { unitPrice } from '../normalizers/size.js';
import type { ValidatorResult } from './validator.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { ExtractSchema } from '../acquisition/types.js';
import type { AdapterContext } from './types.js';

describe('basket quantity window in extraction', () => {
  const fixtures = [
    { slug: 'spinneys_ae', basket: 'essentials_ae', itemId: 'eggs_12', name: 'Eggs Fresh 12 Pack', size: '12 Pack', price: 16.25, qty: 12, unit: 'ct' },
    { slug: 'morrisons_gb', basket: 'essentials_gb', itemId: 'milk_1l', name: 'Morrisons British Semi Skimmed Milk 2 Pint', size: '2 Pint', price: 1.2, qty: 1136.5225, unit: 'ml' },
  ];
  const quantityGaps = [' ', '  ', '\n\n', '  \n', '\u00a0\u00a0'];
  const quantityLayouts = [
    [' **', '**'], ['-', ''], [' | ', ''], [' _', '_'], [' __', '__'],
    ['\n\n', ' Fresh'], ['\n\n', ' Semi Skimmed'], ['\n\n-', ''], ['\n\n | ', ''],
    ['\n\n _', '_'], ['\n\n __', '__'],
  ] as const;

  async function acquire(fixture: typeof fixtures[number], size: string | undefined, name = fixture.name, sourceContent?: string) {
    const config = loadRetailerConfig(fixture.slug);
    config.searchConfig = { ...config.searchConfig!, requireStrictValidator: true, extractionFallback: 'none' };
    const context: AdapterContext = {
      config, runId: 'retained-quantity',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const extract = vi.fn().mockResolvedValue({
      data: { productName: name, price: fixture.price, currency: config.currencyCode, inStock: true, sizeText: size },
      pageContent: sourceContent ?? `${name}\n${config.currencyCode} ${fixture.price}`,
    });
    const adapter = new SearchAdapter(
      { search: vi.fn().mockResolvedValue([]) } as unknown as ExaProvider,
      { extract } as unknown as FirecrawlProvider,
    );
    const target = (await adapter.discoverTargets(context)).find(t => t.id === fixture.itemId)!;
    expect(target).toBeDefined();
    const result = await adapter.fetchTarget(context, { ...target, url: `${config.baseUrl}/quantity-fixture`, metadata: { ...target.metadata, direct: true } });
    return { products: await adapter.parseListing(context, result), extract };
  }

  it.each(fixtures)('admits retained $slug quantity and preserves its unit-price basis', async fixture => {
    const { products, extract } = await acquire(fixture, fixture.size);
    expect(products).toHaveLength(1);
    const product = products[0];
    expect(product.rawSizeText).toBe(fixture.size);
    expect(product.normalizedSize).toMatchObject({ baseUnit: fixture.unit, packCount: 1 });
    expect(product.normalizedSize?.baseQuantity).toBeCloseTo(fixture.qty);
    expect(unitPrice(product.price, product.normalizedSize!)).toBeCloseTo(fixture.price / fixture.qty);
    const validator = product.rawPayload.validator as ValidatorResult;
    expect(validator.signals.sizeWindow).toBe('pass');
    expect(validator.signals.extractedBaseQty).toBeCloseTo(fixture.qty);
    expect(classifyMatchAdmission(validator).status).toBe('auto');
    expect(product.rawPayload.priceEvidence).toBe('verified');
    const schema = extract.mock.calls[0][1] as ExtractSchema;
    expect(schema.prompt).toContain(`You are looking for "${product.rawPayload.canonicalName}"`);
  });

  it.each(fixtures)('requires a separate price beside the supported $size quantity', async fixture => {
    const pricedFixture = { ...fixture, price: fixture.unit === 'ct' ? 12 : 2 };
    for (const gap of quantityGaps) {
      const size = fixture.size.replace(' ', gap);
      const content = fixture.name.replace(fixture.size, size);
      const error = await acquire(pricedFixture, size, fixture.name, content).catch(e => e);
      expect(error).toBeInstanceOf(SearchTargetError);
      expect(error.failures).toContainEqual(expect.objectContaining({ reason: 'price-evidence-missing' }));
    }
  });

  it.each(fixtures)('accepts a separately rendered price equal to the $size quantity', async fixture => {
    const price = fixture.unit === 'ct' ? 12 : 2;
    const priceText = fixture.unit === 'ct' ? 'AED12' : '£2';
    for (const gap of quantityGaps) {
      const size = fixture.size.replace(' ', gap);
      const content = fixture.name.replace(fixture.size, size);
      const { products } = await acquire({ ...fixture, price }, size, fixture.name, `${content}\n${priceText}`);
      expect(products[0].price).toBe(price);
      expect(products[0].rawPayload.priceEvidence).toBe('verified');
      expect(classifyMatchAdmission(products[0].rawPayload.validator as ValidatorResult).status).toBe('auto');
    }
  });

  it.each(fixtures)('does not assemble a decimal price from $size and another price fraction', async fixture => {
    const price = (fixture.unit === 'ct' ? 12 : 2) + 0.5;
    for (const gap of quantityGaps) {
      const size = fixture.size.replace(' ', gap);
      const content = `${fixture.name.replace(fixture.size, size)}\n${fixture.unit === 'ct' ? 'AED1' : '£1'}\n.50`;
      const error = await acquire({ ...fixture, price }, size, fixture.name, content).catch(e => e);
      expect(error).toBeInstanceOf(SearchTargetError);
      expect(error.failures).toContainEqual(expect.objectContaining({ reason: 'price-evidence-missing' }));
    }
  });

  it.each(fixtures)('accepts a separate split decimal price beside $size', async fixture => {
    const whole = fixture.unit === 'ct' ? 12 : 2;
    const price = whole + 0.5;
    for (const gap of quantityGaps) {
      const size = fixture.size.replace(' ', gap);
      const content = `${fixture.name.replace(fixture.size, size)}\n${fixture.unit === 'ct' ? 'AED' : '£'}${whole}\n.50`;
      const { products } = await acquire({ ...fixture, price }, size, fixture.name, content);
      expect(products[0].price).toBe(price);
      expect(products[0].rawPayload.priceEvidence).toBe('verified');
      expect(classifyMatchAdmission(products[0].rawPayload.validator as ValidatorResult).status).toBe('auto');
    }
  });

  it.each(fixtures)('does not admit Markdown $size quantities as integer or split prices', async fixture => {
    const whole = fixture.unit === 'ct' ? 12 : 2;
    for (const [separator, closing] of quantityLayouts) {
      const content = fixture.name.replace(fixture.size, fixture.size.replace(' ', separator) + closing);
      for (const price of [whole, whole + 0.5]) {
        const page = price === whole ? content : `${content}\n${fixture.unit === 'ct' ? 'AED1' : '£1'}\n.50`;
        const error = await acquire({ ...fixture, price }, fixture.size, fixture.name, page).catch(e => e);
        expect.soft(error).toBeInstanceOf(SearchTargetError);
        expect.soft(error.failures).toContainEqual(expect.objectContaining({ reason: 'price-evidence-missing' }));
      }
    }
  });

  it.each(fixtures)('accepts independent prices beside Markdown $size and preserves normalized basis', async fixture => {
    const whole = fixture.unit === 'ct' ? 12 : 2;
    for (const [separator, closing] of quantityLayouts) {
      const content = fixture.name.replace(fixture.size, fixture.size.replace(' ', separator) + closing);
      for (const price of [whole, whole + 0.5]) {
        const page = `${content}\n${fixture.unit === 'ct' ? 'AED' : '£'}${whole}${price === whole ? '' : '\n.50'}`;
        const { products } = await acquire({ ...fixture, price }, fixture.size, fixture.name, page);
        const product = products[0];
        expect(product.price).toBe(price);
        expect(product.rawPayload.priceEvidence).toBe('verified');
        expect(classifyMatchAdmission(product.rawPayload.validator as ValidatorResult).status).toBe('auto');
        expect(product.rawSizeText).toBe(fixture.size);
        expect(product.normalizedSize?.baseQuantity).toBeCloseTo(fixture.qty);
        expect(product.normalizedSize?.baseUnit).toBe(fixture.unit);
        expect(unitPrice(product.price, product.normalizedSize!)).toBeCloseTo(price / fixture.qty);
      }
    }
  });

  it.each(fixtures)('accepts a genuine price before the Pack size heading for $slug', async fixture => {
    const price = fixture.unit === 'ct' ? 12 : 2;
    const page = `${fixture.name}\nPrice\n${fixture.unit === 'ct' ? 'AED12' : '£2'}\n\nPack size\n${fixture.size}`;
    const { products } = await acquire({ ...fixture, price }, fixture.size, fixture.name, page);
    const product = products[0];
    expect(product.price).toBe(price);
    expect(product.rawPayload.priceEvidence).toBe('verified');
    expect(classifyMatchAdmission(product.rawPayload.validator as ValidatorResult).status).toBe('auto');
    expect(product.normalizedSize?.baseQuantity).toBeCloseTo(fixture.qty);
    expect(product.normalizedSize?.baseUnit).toBe(fixture.unit);
    expect(unitPrice(price, product.normalizedSize!)).toBeCloseTo(price / fixture.qty);
  });

  it('preserves automatic admission of an existing metric product before a Pack size heading', async () => {
    const fixture = { ...fixtures[1], name: 'Morrisons British Semi Skimmed Milk 1L', size: '1L', price: 3, qty: 1000 };
    const page = `${fixture.name}\nPrice\n£3\n\nPack size\n1L`;
    const { products } = await acquire(fixture, fixture.size, fixture.name, page);
    const product = products[0];
    expect(product.price).toBe(3);
    expect(product.rawPayload.priceEvidence).toBe('verified');
    expect(classifyMatchAdmission(product.rawPayload.validator as ValidatorResult).status).toBe('auto');
    expect(product.normalizedSize?.baseQuantity).toBe(1000);
    expect(product.normalizedSize?.baseUnit).toBe('ml');
    expect(unitPrice(product.price, product.normalizedSize!)).toBe(0.003);
  });

  it('keeps plural package counts below automatic admission without an observation basis', async () => {
    const { products } = await acquire(fixtures[0], '12 Packs', 'Eggs Fresh 12 Packs');
    expect(products).toHaveLength(1);
    const product = products[0];
    const validator = product.rawPayload.validator as ValidatorResult;
    expect(validator.signals.sizeWindow).toBe('unverified');
    expect(validator.signals.extractedBaseQty).toBeNull();
    expect(classifyMatchAdmission(validator).status).toBe('candidate');
    expect(product.normalizedSize).toBeUndefined();
  });

  it.each(fixtures)('keeps strict missing-size protection for $slug', async fixture => {
    const error = await acquire(fixture, undefined).catch(e => e);
    expect(error).toBeInstanceOf(SearchTargetError);
    expect(error.failures).toContainEqual(expect.objectContaining({ reason: 'validator-rejected', detail: 'missing-size' }));
  });

  it.each([
    { fixture: fixtures[0], size: '6 Pack' }, { fixture: fixtures[0], size: '30 Pack' },
    { fixture: fixtures[1], size: '4 Pint' },
  ])('rejects wrong retained-basket quantity $size', async ({ fixture, size }) => {
    const error = await acquire(fixture, size).catch(e => e);
    expect(error).toBeInstanceOf(SearchTargetError);
    expect(error.failures).toContainEqual(expect.objectContaining({ reason: 'validator-rejected' }));
  });

  it.each([
    { fixture: fixtures[0], size: '2x6 Pack' }, { fixture: fixtures[1], size: '2x2 Pint' },
    { fixture: fixtures[0], size: '12 ml' }, { fixture: fixtures[1], size: '12 ct' },
  ])('keeps ambiguous bulk or incompatible $size below automatic admission', async ({ fixture, size }) => {
    const { products } = await acquire(fixture, size);
    expect(classifyMatchAdmission(products[0].rawPayload.validator as ValidatorResult).status).toBe('candidate');
  });

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
