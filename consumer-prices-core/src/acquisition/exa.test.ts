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
    expect(body.summary.schema.properties.price.type).toEqual(['number', 'null']);
    expect(body.summary.schema.required).toEqual(['productName', 'price']);
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
