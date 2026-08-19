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
    const body = await res.text();
    assert.match(body, /^# /m);
    assert.match(body, /github\.com\/koala73\/worldmonitor\/releases\/latest/);
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
