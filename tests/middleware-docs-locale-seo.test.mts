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
  it('replaces canonical Organization bodies with references throughout upstream JSON-LD (#7861)', async () => {
    const id = 'https://www.worldmonitor.app/#organization';
    const organization = {
      '@id': id,
      '@type': ['Organization'],
      name: 'World Monitor',
      logo: { '@type': 'ImageObject', url: 'https://www.worldmonitor.app/logo.png' },
      sameAs: ['https://github.com/koala73/worldmonitor'],
    };
    const otherOrganization = { '@type': 'Organization', '@id': 'https://example.org/#organization', name: 'Source' };
    const upstream = `<html><head><script TYPE = 'application/ld+json'>${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [organization, { '@type': 'Article', publisher: organization, author: { '@id': id }, provider: otherOrganization }],
    })}</script></head><body>Docs</body></html>`;
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async () => new Response(upstream, { headers: { 'content-type': 'text/html' } }));
    try {
      for (const path of ['/docs/about', '/docs/zh/about']) {
        const response = await middleware(new Request(`https://www.worldmonitor.app${path}`, { headers: { accept: 'text/html' } }));
        assert.ok(response instanceof Response);
        const html = await response.text();
        const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1])['@graph'];
        assert.deepEqual(graph[0], { '@id': id });
        assert.deepEqual(graph[1].publisher, { '@id': id });
        assert.deepEqual(graph[1].author, {
          '@id': id,
          '@type': 'Organization',
          name: 'World Monitor',
          url: 'https://www.worldmonitor.app/',
        });
        assert.deepEqual(graph[1].provider, otherOrganization);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the official canonical and excludes copied deployments from indexing', async () => {
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async () => new Response(
      '<html><head><link rel="canonical" href="https://copy.example/docs/zh/about"></head><body>关于</body></html>',
      { headers: { 'content-type': 'text/html', 'x-robots-tag': 'bingbot: noarchive', vary: 'Accept-Encoding' } },
    ));
    try {
      for (const [host, noindex] of [
        ['www.worldmonitor.app', false],
        ['WWW.WORLDMONITOR.APP:443', false],
        ['copy.example', true],
        ['worldmonitor-preview.vercel.app', true],
        ['www.worldmonitor.app.copy.example', true],
      ] as const) {
        const request = new Request('https://copy.example/docs/zh/about?ref=test', {
          headers: { accept: 'text/html', host, 'x-forwarded-host': 'www.worldmonitor.app' },
        });
        const response = await middleware(request);
        assert.ok(response instanceof Response);
        assert.equal(response.headers.get('x-robots-tag'), noindex ? 'noindex, bingbot: noarchive' : 'bingbot: noarchive');
        assert.match(response.headers.get('vary') ?? '', /host/);
        assert.match(response.headers.get('vary') ?? '', /accept-encoding/);
        const body = await response.text();
        assert.match(body, /rel="canonical" href="https:\/\/www\.worldmonitor\.app\/docs\/zh\/about"/);
        assert.doesNotMatch(body, /copy\.example/);
      }
      assert.equal(globalThis.fetch.mock.calls.length, 5, 'one upstream fetch per document');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('applies the same indexing policy to HEAD and conditional 304 responses without reading a body', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const status of [200, 304]) {
        for (const host of ['www.worldmonitor.app', 'copy.example']) {
          const upstream = new Response(null, {
            status,
            headers: { ...(status === 200 ? { 'content-type': 'text/html' } : {}), etag: '"docs"' },
          });
          mock.method(upstream, 'text', () => { throw new Error('must not read body'); });
          mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
            assert.equal(new Headers(init.headers).get('if-none-match'), '"docs"');
            return upstream;
          });
          const response = await middleware(new Request(`https://${host}/docs/zh/about`, {
            method: status === 200 ? 'HEAD' : 'GET',
            headers: { accept: 'text/html', 'if-none-match': '"docs"' },
          }));
          assert.ok(response instanceof Response);
          assert.equal(response.status, status);
          assert.equal(response.headers.get('x-robots-tag'), host === 'copy.example' ? 'noindex' : null);
          assert.equal(response.headers.get('etag'), '"docs"');
          assert.match(response.headers.get('vary') ?? '', /host/);
          assert.equal(upstream.text.mock.calls.length, 0);
          assert.equal(await response.text(), '');
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves redirects, errors and non-HTML responses on copied deployments', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const [status, contentType] of [[308, 'text/html'], [404, 'text/html'], [500, 'text/html'], [200, 'text/plain']] as const) {
        const upstream = new Response('<html><head></head><body>unchanged</body></html>', {
          status, headers: { 'content-type': contentType, location: '/docs/about' },
        });
        mock.method(globalThis, 'fetch', async () => upstream);
        const response = await middleware(new Request('https://copy.example/docs/zh/about', { headers: { accept: 'text/html' } }));
        assert.equal(response, upstream);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
