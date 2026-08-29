import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import handler from '../api/md-twin.ts';
import {
  MD_TWIN_LOOP_HEADER,
  buildMarkdownTwinResponse,
  htmlToMarkdown,
  isMarkdownTwinPath,
  resolveMarkdownTwinPath,
  siblingPathFromMarkdown,
} from '../api/_md-url-twin.ts';

describe('markdown URL-fallback helpers', () => {
  it('accepts /{page}.md paths and maps them to the sibling', () => {
    assert.equal(isMarkdownTwinPath('/dashboard.md'), true);
    assert.equal(isMarkdownTwinPath('/stocks/AAPL.md'), true);
    assert.equal(isMarkdownTwinPath('/api/health.md'), true);
    assert.equal(isMarkdownTwinPath('/dashboard'), false);
    assert.equal(isMarkdownTwinPath('/../etc.md'), false);
    assert.equal(siblingPathFromMarkdown('/dashboard.md'), '/dashboard');
    assert.equal(siblingPathFromMarkdown('/api/health.md'), '/api/health');
  });

  it('resolves /api/md-twin?path= to a sanitized .md path', () => {
    const req = new Request('https://www.worldmonitor.app/api/md-twin?path=dashboard');
    assert.equal(resolveMarkdownTwinPath(req), '/dashboard.md');
    const evil = new Request('https://www.worldmonitor.app/api/md-twin?path=https://evil.example/x');
    assert.equal(resolveMarkdownTwinPath(evil), null);
  });

  it('converts HTML to heading-led markdown', () => {
    const md = htmlToMarkdown(
      '<html><head><title>Dashboard</title></head><body><h1>Live map</h1><p>Ships and jets.</p></body></html>',
      'fallback',
    );
    assert.match(md, /^# /m);
    assert.match(md, /Live map/);
    assert.match(md, /Ships and jets/);
    assert.doesNotMatch(md, /<html/i);
  });
});

describe('api/md-twin.ts', () => {
  it('returns the deprecation policy Link on OPTIONS preflights', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', { method: 'OPTIONS' }),
      '/dashboard.md',
    );

    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
    assert.match(res.headers.get('link') ?? '', /https:\/\/www\.worldmonitor\.app\/api-versioning\.md/);
  });

  it('returns heading-led markdown for a 200 HTML sibling', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/dashboard');
      assert.equal(init?.headers instanceof Headers ? init.headers.get(MD_TWIN_LOOP_HEADER) : null, '1');
      return new Response('<html><title>World Monitor</title><h1>Dashboard</h1><p>Live globe.</p></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    try {
      const res = await handler(new Request('https://www.worldmonitor.app/api/md-twin?path=dashboard'));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.match(res.headers.get('link') ?? '', /rel="canonical"/);
      assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
      const body = await res.text();
      assert.match(body, /^# /m);
      assert.match(body, /Dashboard|World Monitor/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('documents a 302 sibling as heading-led markdown', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/api/download.md'),
      '/api/download.md',
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/koala73/worldmonitor/releases/latest' },
        }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('location'), null);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    const body = await res.text();
    assert.match(body, /^# /m);
    assert.match(body, /github\.com\/koala73\/worldmonitor\/releases\/latest/);
  });

  it('preserves a bodyless 304 sibling', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response(null, { status: 304, headers: { etag: 'dashboard-v1' } }),
    );

    assert.equal(res.status, 304);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), '');
  });

  it('uses an anonymous internal identity for the sibling request', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/api/latest-brief.md', {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'wm_session=secret',
          'user-agent': 'Googlebot/2.1',
          'x-api-key': 'api-secret',
          'x-worldmonitor-key': 'wm-secret',
        },
      }),
      '/api/latest-brief.md',
      async (_input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('user-agent'), 'WorldMonitor-MarkdownTwin/1.0');
        assert.equal(headers.get(MD_TWIN_LOOP_HEADER), '1');
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('x-api-key'), null);
        assert.equal(headers.get('x-worldmonitor-key'), null);
        return new Response('# Public brief\n');
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });

  for (const { status, headers = {}, expectedHeader, expectedValue } of [
    {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="worldmonitor"' },
      expectedHeader: 'www-authenticate',
      expectedValue: 'Bearer realm="worldmonitor"',
    },
    { status: 403 },
    {
      status: 429,
      headers: { 'retry-after': '17' },
      expectedHeader: 'retry-after',
      expectedValue: '17',
    },
    { status: 500 },
  ]) {
    it(`preserves a ${status} sibling as a non-cacheable response`, async () => {
      const res = await buildMarkdownTwinResponse(
        new Request('https://www.worldmonitor.app/api/health.md'),
        '/api/health.md',
        async () => new Response('upstream failure', { status, headers }),
      );

      assert.equal(res.status, status);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      if (expectedHeader) assert.equal(res.headers.get(expectedHeader), expectedValue);
      assert.match(await res.text(), /^# health/m);
    });
  }

  it('rejects an oversized declared sibling body without reading it', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response('small', { headers: { 'content-length': '80001' } }),
    );

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /could not be read/);
  });

  it('cancels a streamed sibling body that exceeds the byte cap', async () => {
    let canceled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(80_001));
      },
      cancel() {
        canceled = true;
      },
    });

    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response(body),
    );

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(canceled, true);
  });

  it('maps sibling body-stream failures to a non-cacheable 502', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('body failed'));
      },
    });

    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response(body),
    );

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /could not be read/);
  });

  it('uses sibling HEAD and never reads a response body', async () => {
    const unreadableBody = {
      getReader() {
        throw new Error('HEAD must not read the body');
      },
    };
    const siblingResponse = {
      body: unreadableBody,
      headers: new Headers(),
      ok: true,
      status: 200,
    };

    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', { method: 'HEAD' }),
      '/dashboard.md',
      async (_input, init) => {
        assert.equal(init?.method, 'HEAD');
        return siblingResponse;
      },
    );

    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });

  it('does not recurse when the loop header is present', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', {
        headers: { [MD_TWIN_LOOP_HEADER]: '1' },
      }),
      '/dashboard.md',
      async () => {
        throw new Error('sibling fetch must not run');
      },
    );
    assert.equal(res.status, 404);
    assert.match(await res.text(), /^# /m);
  });
});
