/**
 * Prompt-anchoring regression for #6182.
 *
 * The extraction prompt carried a worked example — 'like "3" and ".95" next to
 * "AED" — combine them to get 3.95'. On a page with NO price the extractor
 * returned that literal as the price and echoed the canonical name as the
 * product name. Measured on JioMart's retired route (a 200 response whose body
 * is a "We couldn't find the page" shell), varying ONLY the example:
 *
 *   example 3.95  -> {"productName":"Eggs Fresh 12 Pack","price":3.95,...}
 *   example 7.31  -> {"productName":"Eggs Fresh 12 Pack","price":7.31,...}
 *   example 12.48 -> {"productName":"Eggs Fresh 12 Pack","price":12.48,...}
 *
 * The fabricated row survives every downstream gate: price > 0 passes, the
 * currency matches, and because productName echoes canonicalName the title
 * check and the strict validator both score a perfect token overlap. That is
 * worse than a missing page — it is a fabricated observation in a price index.
 *
 * Any numeric literal in the prompt is an anchor the model can emit verbatim,
 * so assert there is none rather than blocklisting the one value we caught.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchAdapter } from './search.js';
import { ExaProvider } from '../acquisition/exa.js';
import { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { ExtractSchema } from '../acquisition/types.js';
import type { AdapterContext } from './types.js';
import type { RetailerConfig } from '../config/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function captureSchema(canonicalName: string): Promise<ExtractSchema> {
  const captured: { schema?: ExtractSchema } = {};
  const firecrawl = {
    extract: vi.fn().mockImplementation((_url: string, schema: ExtractSchema) => {
      captured.schema = schema;
      return Promise.resolve({ data: { productName: canonicalName, price: 4.2, currency: 'AED', sizeText: '1L' } });
    }),
  } as unknown as InstanceType<typeof FirecrawlProvider>;
  const exa = {
    search: vi.fn().mockResolvedValue([{ url: 'https://www.noon.com/uae-en/milk/p/' }]),
    extract: vi.fn(),
  } as unknown as InstanceType<typeof ExaProvider>;

  const config = {
    slug: 'noon_grocery_ae',
    name: 'Noon Grocery UAE',
    marketCode: 'ae',
    currencyCode: 'AED',
    adapter: 'search',
    baseUrl: 'https://www.noon.com',
    enabled: true,
    discovery: { mode: 'search', seeds: [], maxPages: 20 },
    searchConfig: {
      numResults: 3,
      urlPathContains: '/p/',
      inStockFromPrice: false,
      extractionFallback: 'none',
      requireStrictValidator: false,
    },
  } as RetailerConfig;

  const ctx: AdapterContext = { config, runId: 'r', logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  const target = {
    id: 'milk',
    url: config.baseUrl,
    category: 'dairy',
    metadata: {
      canonicalName,
      domain: 'www.noon.com',
      currency: 'AED',
      basketSlug: 'essentials_ae',
      itemConstraints: { baseUnit: 'ml', minBaseQty: 900, maxBaseQty: 1100 },
      direct: false,
    },
  };

  await new SearchAdapter(exa, firecrawl).fetchTarget(ctx, target);
  if (!captured.schema) throw new Error('SearchAdapter did not send an extraction schema');
  return captured.schema;
}

describe('extraction prompt', () => {
  it('contains no numeric price example the model can emit verbatim', async () => {
    const schema = await captureSchema('Full Fat Fresh Milk 1L');
    const prompt = schema.prompt ?? '';

    // Anti-vacuity: an uncaptured prompt is the empty string, which trivially
    // contains no decimal literal and would make the assertion below pass while
    // proving nothing. Anchor on real content first.
    expect(prompt).toContain('Extract the retail price');
    expect(prompt.length).toBeGreaterThan(200);

    // Strip the canonical-name and size clauses: those legitimately carry the
    // ITEM's own numbers ("1L", "approx. 1000ml") and are not price anchors.
    const withoutItemNumbers = prompt
      .replace(/You are looking for "[^"]*"\./g, '')
      .replace(/The product MUST be [^.]*\./g, '');

    const decimalLiterals = withoutItemNumbers.match(/\d+\.\d+/g) ?? [];
    expect(decimalLiterals).toEqual([]);
  });

  it('keeps numeric examples out of the serialized Exa request', async () => {
    const productName = 'Full Fat Fresh Milk';
    const schema = await captureSchema(productName);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ summary: { productName, price: null, currency: 'AED' } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new ExaProvider('test-key').extract('https://www.noon.com/uae-en/milk/p/', schema);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      summary: { query: string; schema: { properties: Record<string, { description: string }> } };
    };
    expect(body.summary.query).toContain('Extract the retail price');
    expect(body.summary.query).toContain('price (number)');
    expect(body.summary.query.match(/\d/g) ?? []).toEqual([]);
    expect(JSON.stringify(body.summary.schema.properties).match(/\d/g) ?? []).toEqual([]);
  });

  it('keeps numeric examples out of the serialized Firecrawl request', async () => {
    const productName = 'Full Fat Fresh Milk';
    const schema = await captureSchema(productName);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { extract: { productName, price: null } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FirecrawlProvider('test-key').extract('https://www.noon.com/uae-en/milk/p/', schema);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      extract: { prompt: string; schema: { properties: Record<string, { description: string }> } };
    };
    const fieldDescriptions = Object.values(body.extract.schema.properties)
      .map((property) => property.description)
      .join(' ');
    expect(body.extract.prompt).toBe(schema.prompt);
    expect(body.extract.prompt).toContain('Extract the retail price');
    expect(fieldDescriptions).toContain('Retail price');
    expect(`${body.extract.prompt} ${fieldDescriptions}`.match(/\d/g) ?? []).toEqual([]);
  });

  it('still tells the extractor how to handle a split price', async () => {
    const prompt = (await captureSchema('Full Fat Fresh Milk 1L')).prompt ?? '';
    expect(prompt.toLowerCase()).toContain('split');
  });
});
