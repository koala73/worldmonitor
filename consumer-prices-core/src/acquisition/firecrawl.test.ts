import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlProvider } from './firecrawl.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const schema = {
  fields: {
    productName: { type: 'string' as const, description: 'Product title' },
    price: { type: 'number' as const, description: 'Retail price' },
  },
};

describe('FirecrawlProvider.extract', () => {
  it('treats an unsuccessful HTTP-200 response as a provider error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'extract quota exhausted' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema)).rejects.toThrow(
      'extract quota exhausted',
    );
  });

  it('aborts a stalled extraction request', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema, { timeout: 5 }),
    ).rejects.toThrow();
  });
});
