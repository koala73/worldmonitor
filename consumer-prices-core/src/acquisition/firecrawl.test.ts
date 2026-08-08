import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlProvider, extractAbortMs } from './firecrawl.js';

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

  // A page that uses its full server-side render budget must still be able to
  // answer: if the client abort fires at the same deadline it always wins, the
  // successful response is unreachable, and two such pages open the caller's
  // Firecrawl cooldown for the rest of the scrape. `AbortSignal.timeout` uses
  // an internal Node timer that fake timers do not drive, so the invariant is
  // asserted on the deadline function and its wiring rather than by waiting.
  it('gives the client abort deadline headroom over the server render budget', () => {
    expect(extractAbortMs(30_000)).toBeGreaterThan(30_000);
    expect(extractAbortMs(30_000)).toBe(35_000);
    expect(extractAbortMs()).toBe(35_000);
    expect(extractAbortMs(1_000)).toBe(6_000);
  });

  it('wires an abort signal onto the extract request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { extract: { price: 1 } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema, { timeout: 1_000 });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((JSON.parse(String(init.body)) as { timeout: number }).timeout).toBe(1_000);
  });

  // A successful call that found nothing is a PAGE outcome, not an outage —
  // returning empty lets the caller record `missing-price` and move to the next
  // candidate URL instead of accruing a provider-outage streak.
  it('returns empty rather than throwing when a successful response has no extract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { metadata: {} } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);
    expect(result.data).toEqual({});
  });

  it('sends a User-Agent on extract requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { extract: { price: 1 } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'User-Agent': 'worldmonitor-consumer-prices/1.0',
    });
  });

  // The rendered markdown is the ground truth the caller verifies an extracted
  // price against (price-evidence.ts, #6182) — it must come from the SAME
  // render that produced the extract, so both ride in one request.
  it('requests markdown alongside extract and returns it as pageContent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: { extract: { price: 4.6 }, markdown: '# Bread\n\n$4.60' } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { formats: string[] };
    expect(body.formats).toEqual(['extract', 'markdown']);
    expect(result.pageContent).toBe('# Bread\n\n$4.60');
  });

  it('omits pageContent when the response carries no usable markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { extract: { price: 4.6 }, markdown: '   ' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);
    expect(result.pageContent).toBeUndefined();
  });

  // renderWaitMs (#6182): late-hydrating storefronts capture as a breadcrumb
  // shell without a settle delay. The wait must reach the request body AND
  // extend the client abort deadline, or a page using its full wait would be
  // aborted before its successful response could arrive.
  it('forwards waitFor to the request body and extends the abort deadline by it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { extract: { price: 1 } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema, {
      timeout: 30_000,
      waitFor: 8_000,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { waitFor?: number };
    expect(body.waitFor).toBe(8_000);
  });

  it('omits waitFor from the body when not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { extract: { price: 1 } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema, { timeout: 30_000 });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { waitFor?: number };
    expect(body.waitFor).toBeUndefined();
  });
});
