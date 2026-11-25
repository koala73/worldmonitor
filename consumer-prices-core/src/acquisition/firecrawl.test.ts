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
  it('preserves the retailer HTTP status inside a successful provider response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        json: { productName: 'Full Fat Fresh Milk 1L', price: null },
        metadata: { statusCode: 403 },
        markdown: '# 403 Forbidden',
      },
    }), { status: 200 })));

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/milk', schema);

    expect(result).toMatchObject({ sourceStatusCode: 403, data: { price: null } });
  });

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
      new Response(JSON.stringify({ success: true, data: { json: { price: 1 } } }), { status: 200 }),
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
  it('returns empty rather than throwing when a successful response has no JSON extraction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { metadata: {} } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);
    expect(result.data).toEqual({});
  });

  it('sends a User-Agent on extract requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { json: { price: 1 } } }), { status: 200 }),
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
        JSON.stringify({ success: true, data: { json: { price: 4.6 }, markdown: '# Bread\n\n$4.60' } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.firecrawl.dev/v2/scrape');
    const body = JSON.parse(String(init.body));
    expect(body.formats).toEqual([
      { type: 'json', schema: {
        type: 'object',
        properties: {
          productName: { type: 'string', description: 'Product title' },
          price: { type: 'number', description: 'Retail price' },
        },
      } },
      'markdown',
    ]);
    expect(body).not.toHaveProperty('extract');
    expect(body.maxAge).toBe(0);
    expect(result).toMatchObject({ data: { price: 4.6 }, pageContent: '# Bread\n\n$4.60' });
  });

  it('omits pageContent when the response carries no usable markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { json: { price: 4.6 }, markdown: '   ' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);
    expect(result.pageContent).toBeUndefined();
  });

  it.each([
    [{ 'og:title': 'Fresh White Bread 400G', 'twitter:title': 'ignored' }, 'Fresh White Bread 400G'],
    [{ ogTitle: 'Fresh White Bread 400G' }, 'Fresh White Bread 400G'],
    [{ 'twitter:title': 'Feinkristallzucker IP Suisse' }, 'Feinkristallzucker IP Suisse'],
  ])('returns the page-declared product title from metadata %o', async (metadata, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { json: { price: 4.6 }, metadata } }), { status: 200 })),
    );

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema);
    expect(result.pageTitle).toBe(expected);
  });

  it('keeps a bare document title apart from the declared product title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { json: { price: 4.6 }, metadata: { title: 'Fresh Milk' } } }), { status: 200 }),
      ),
    );

    const result = await new FirecrawlProvider('test-key').extract('https://retailer.example/dairy/fresh-milk', schema);
    expect(result.pageTitle).toBeUndefined();
    expect(result.documentTitle).toBe('Fresh Milk');
  });

  // renderWaitMs (#6182): late-hydrating storefronts capture as a breadcrumb
  // shell without a settle delay. The wait must reach the request body AND
  // extend the client abort deadline, or a page using its full wait would be
  // aborted before its successful response could arrive.
  it('forwards waitFor to the request body and extends the abort deadline by it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { json: { price: 1 } } }), { status: 200 }),
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
      new Response(JSON.stringify({ success: true, data: { json: { price: 1 } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FirecrawlProvider('test-key').extract('https://retailer.example/p/bread', schema, { timeout: 30_000 });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { waitFor?: number };
    expect(body.waitFor).toBeUndefined();
  });
});

describe('FirecrawlProvider fetch, search and validate', () => {
  const base = 'https://api.firecrawl.dev/v2';
  const url = 'https://retailer.example/p/bread';

  it('reads HTML and markdown and validates through the v2 scrape endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        success: true, data: { html: '<p>Bread</p>', markdown: 'Bread', metadata: { statusCode: 200 } },
      }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { markdown: 'Example' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FirecrawlProvider('test-key');

    await expect(provider.fetch(url)).resolves.toMatchObject({
      url, html: '<p>Bread</p>', markdown: 'Bread', metadata: { statusCode: 200 },
    });
    await expect(provider.validate()).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([`${base}/scrape`, `${base}/scrape`]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject({
      url, formats: ['html', 'markdown'], maxAge: 0,
    });
  });

  it('reads web matches from the v2 search response and retains domain scoping', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      success: true,
      data: { web: [
        { url, title: 'Bread', description: 'Fresh bread', markdown: '# Breadcrumbs' },
        { url: url + '/nutrition', title: 'Nutrition', markdown: 'Nutrition label' },
      ] },
    })).mockResolvedValueOnce(Response.json({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FirecrawlProvider('test-key');

    await expect(provider.search('bread', { numResults: 2, includeDomains: ['retailer.example'] })).resolves.toEqual([
      { url, title: 'Bread', text: 'Fresh bread' },
      { url: url + '/nutrition', title: 'Nutrition', text: 'Nutrition label' },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${base}/search`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject({
      query: 'bread', limit: 2, includeDomains: ['retailer.example'],
      scrapeOptions: { formats: ['markdown'], maxAge: 0 },
    });
    // v2 defaults to 60 s; the server must give up before the 30 s client abort.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body)).timeout).toBeLessThan(30_000);
    await expect(provider.search('missing')).resolves.toEqual([]);
  });
});
