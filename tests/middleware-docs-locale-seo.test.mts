import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';
import {
  DOCS_UPSTREAM_TIMEOUT_MS,
  ROUTING_MIDDLEWARE_RESPONSE_DEADLINE_MS,
} from '../src/config/docs-locale-seo.ts';

function docsHtmlRequest(): Request {
  return new Request('https://www.worldmonitor.app/docs/zh/about', {
    headers: {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    },
  });
}

describe('middleware docs locale SEO proxy', () => {
  it('rewrites Chinese docs HTML lang and injects reciprocal hreflang', async () => {
    const upstreamHtml = `<!DOCTYPE html><html lang="en"><head>
<meta name="og:locale" content="en_US"/>
<link rel="canonical" href="https://www.worldmonitor.app/docs/zh/about"/>
<title>关于</title>
</head><body>ok</body></html>`;

    const originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async () =>
      new Response(upstreamHtml, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    try {
      const res = await middleware(docsHtmlRequest());
      assert.ok(res instanceof Response, 'docs HTML requests must be handled by middleware');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-wm-docs-locale-seo'), '1');
      const body = await res.text();
      assert.match(body, /<html[^>]*\blang="zh-Hans"/);
      assert.match(body, /hreflang="zh-Hans" href="https:\/\/www\.worldmonitor\.app\/docs\/zh\/about"/);
      assert.match(body, /hreflang="en" href="https:\/\/www\.worldmonitor\.app\/docs\/about"/);
      assert.match(body, /hreflang="x-default" href="https:\/\/www\.worldmonitor\.app\/docs\/about"/);
      assert.match(
        String(globalThis.fetch.mock.calls[0].arguments[0]),
        /^https:\/\/worldmonitor\.mintlify\.dev\/docs\/zh\/about$/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('strips hop-by-hop framing after decoding a Brotli HTML body', async () => {
    const upstreamHtml = `<!DOCTYPE html><html lang="en"><head>
<meta name="og:locale" content="en_US"/>
<link rel="canonical" href="https://www.worldmonitor.app/docs/zh/about"/>
<title>关于</title>
</head><body>ok</body></html>`;

    const originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async () =>
      new Response(upstreamHtml, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'br',
          'content-length': '64',
          'transfer-encoding': 'chunked',
          connection: 'keep-alive',
        },
      }),
    );

    try {
      const req = new Request('https://www.worldmonitor.app/docs/zh/about', {
        headers: {
          accept: 'text/html',
          'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        },
      });
      const res = await middleware(req);
      assert.ok(res instanceof Response, 'docs HTML requests must be handled by middleware');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-wm-docs-locale-seo'), '1');
      assert.equal(res.headers.get('content-encoding'), null);
      assert.equal(res.headers.get('content-length'), null);
      assert.equal(res.headers.get('transfer-encoding'), null);
      assert.equal(res.headers.get('connection'), null);
      const body = await res.text();
      assert.match(body, /<html[^>]*\blang="zh-Hans"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves RSC flight requests on the Mintlify rewrite path', () => {
    const req = new Request('https://www.worldmonitor.app/docs/zh/about', {
      headers: {
        accept: 'text/x-component',
        rsc: '1',
        'user-agent': 'Mozilla/5.0',
      },
    });
    const res = middleware(req);
    assert.equal(res, undefined, 'RSC requests must fall through to vercel.json Mintlify rewrite');
  });

  it('supplies AbortSignal.timeout below the routing-middleware deadline', async () => {
    const originalTimeout = AbortSignal.timeout;
    const originalFetch = globalThis.fetch;
    const seenMs: number[] = [];
    let timeoutSignal: AbortSignal | undefined;
    let fetchSignal: AbortSignal | undefined;

    AbortSignal.timeout = (ms) => {
      seenMs.push(ms);
      timeoutSignal = originalTimeout.call(AbortSignal, ms);
      return timeoutSignal;
    };
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response('<!DOCTYPE html><html lang="en"><head></head><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    try {
      const res = await middleware(docsHtmlRequest());
      assert.ok(res instanceof Response);
      assert.deepEqual(seenMs, [DOCS_UPSTREAM_TIMEOUT_MS]);
      assert.ok(
        DOCS_UPSTREAM_TIMEOUT_MS < ROUTING_MIDDLEWARE_RESPONSE_DEADLINE_MS,
        'docs upstream timeout must stay below the routing-middleware response deadline',
      );
      assert.equal(fetchSignal, timeoutSignal, 'fetch must receive the timeout signal');
      assert.equal(fetchSignal?.aborted, false);
    } finally {
      AbortSignal.timeout = originalTimeout;
      globalThis.fetch = originalFetch;
    }
  });

  it('maps a rejected transformed-body read to 502', async () => {
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('upstream body reset'));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    try {
      const res = await middleware(docsHtmlRequest());
      assert.ok(res instanceof Response);
      assert.equal(res.status, 502);
      assert.equal(await res.text(), 'Docs upstream unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
