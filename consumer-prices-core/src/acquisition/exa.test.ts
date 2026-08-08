import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExaProvider } from './exa.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExaProvider.extract', () => {
  const schema = {
    prompt: 'Extract the grocery price.',
    fields: {
      productName: { type: 'string' as const, description: 'Product title' },
      price: { type: 'number' as const, nullable: true, description: 'Retail price' },
      inStock: { type: 'boolean' as const, required: false, description: 'Availability' },
    },
  };

  it('requests structured summary output and parses the JSON summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ summary: '{"productName":"White Bread","price":4.95}' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ExaProvider('test-key').extract('https://retailer.example/p/bread', schema, { timeout: 1000 });

    expect(result.data).toEqual({ productName: 'White Bread', price: 4.95 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.exa.ai/contents');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({ 'x-api-key': 'test-key', 'User-Agent': 'worldmonitor-consumer-prices/1.0' });
    const body = JSON.parse(String(request.body)) as {
      summary: {
        query: string;
        schema: { properties: Record<string, { type: string | string[] }>; required: string[] };
      };
    };
    expect(body.summary.query).toContain('Extract the grocery price.');
    expect(body.summary.schema.properties.price).toEqual({
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'Retail price',
    });
    expect(body.summary.schema.required).toEqual(['productName', 'price']);
  });

  // Regression lock for #6182. Exa's /contents validator requires `type` to be a
  // scalar; a `type: ['number','null']` array is rejected with
  // HTTP 400 INVALID_REQUEST_BODY ("expected \"string\" at
  // summary.schema.properties.price.type or ... or expected \"null\" at ...").
  // Because every nullable field emits that array, EVERY Exa extraction call
  // 400s, and two consecutive failures open the per-scrape Exa cooldown — so the
  // opt-in fallback for the priority retailers never ran once. Verified live:
  // the array form returns 400 while this anyOf form returns 200 with a real
  // null price. A mocked fetch cannot see that 400, so assert the wire shape.
  it('never emits an array-valued "type" that Exa rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ summary: '{"productName":"x","price":null}' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new ExaProvider('test-key').extract('https://retailer.example/p/bread', schema);

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as unknown;
    const arrayTypes: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'type' && Array.isArray(value)) arrayTypes.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };
    walk(body, '$');
    expect(arrayTypes).toEqual([]);
  });

  it('maps bounded Exa search results and forwards the host policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ url: 'https://retailer.example/p/bread', title: 'White Bread', score: 0.9 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const results = await new ExaProvider('test-key').search('white bread', {
      numResults: 3,
      includeDomains: ['retailer.example'],
      timeout: 1000,
    });

    expect(results).toEqual([{ url: 'https://retailer.example/p/bread', title: 'White Bread', score: 0.9 }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.exa.ai/search');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      query: 'white bread',
      numResults: 3,
      includeDomains: ['retailer.example'],
    });
  });

  it('surfaces malformed structured summaries as provider errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ summary: 'not-json' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new ExaProvider('test-key').extract('https://retailer.example/p/bread', schema)).rejects.toThrow(
      'malformed structured summary',
    );
  });

  it('propagates the abort timeout when the Exa request does not finish', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new ExaProvider('test-key').extract('https://retailer.example/p/bread', schema, { timeout: 5 }),
    ).rejects.toThrow();
  });
});
