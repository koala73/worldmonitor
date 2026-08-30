import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOCS_PUBLIC_ORIGIN,
  DOCS_UPSTREAM_TIMEOUT_MS,
  DOCS_ZH_HREFLANG,
  ROUTING_MIDDLEWARE_RESPONSE_DEADLINE_MS,
  buildDocsHreflangLinkTags,
  isDocsFullDocumentRequest,
  isDocsHtmlDocumentPath,
  resolveDocsLocalePair,
  rewriteDocsLocaleHtml,
  shouldTransformDocsUpstreamHtml,
} from '../src/config/docs-locale-seo.ts';

describe('docs locale SEO path gating', () => {
  it('accepts document paths and rejects Mintlify assets', () => {
    assert.equal(isDocsHtmlDocumentPath('/docs/about'), true);
    assert.equal(isDocsHtmlDocumentPath('/docs/zh/about'), true);
    assert.equal(isDocsHtmlDocumentPath('/docs/_next/static/chunk.js'), false);
    assert.equal(isDocsHtmlDocumentPath('/docs/sitemap.xml'), false);
    assert.equal(isDocsHtmlDocumentPath('/docs/about.md'), false);
    assert.equal(isDocsHtmlDocumentPath('/docs/mcp'), false);
  });

  it('skips RSC / flight requests', () => {
    assert.equal(
      isDocsFullDocumentRequest(
        new Request('https://www.worldmonitor.app/docs/zh/about', {
          headers: { accept: 'text/html', rsc: '1' },
        }),
      ),
      false,
    );
    assert.equal(
      isDocsFullDocumentRequest(
        new Request('https://www.worldmonitor.app/docs/zh/about', {
          headers: { accept: 'text/html' },
        }),
      ),
      true,
    );
    assert.equal(
      isDocsFullDocumentRequest(
        new Request('https://www.worldmonitor.app/docs/zh/about', {
          headers: { accept: '*/*' },
        }),
      ),
      true,
    );
  });
});

describe('docs locale pair + hreflang cluster', () => {
  it('maps en and zh document paths onto each other', () => {
    assert.deepEqual(resolveDocsLocalePair('/docs/about'), {
      enPath: '/docs/about',
      zhPath: '/docs/zh/about',
      active: 'en',
    });
    assert.deepEqual(resolveDocsLocalePair('/docs/zh/about'), {
      enPath: '/docs/about',
      zhPath: '/docs/zh/about',
      active: 'zh',
    });
  });

  it('emits reciprocal en / zh-Hans / x-default link tags', () => {
    const tags = buildDocsHreflangLinkTags('/docs/zh/about');
    assert.deepEqual(tags, [
      `<link rel="alternate" hreflang="x-default" href="${DOCS_PUBLIC_ORIGIN}/docs/about" />`,
      `<link rel="alternate" hreflang="en" href="${DOCS_PUBLIC_ORIGIN}/docs/about" />`,
      `<link rel="alternate" hreflang="${DOCS_ZH_HREFLANG}" href="${DOCS_PUBLIC_ORIGIN}/docs/zh/about" />`,
    ]);
    assert.deepEqual(
      buildDocsHreflangLinkTags('/docs/about'),
      tags,
    );
  });
});

describe('rewriteDocsLocaleHtml', () => {
  const zhSeed = `<!DOCTYPE html><html lang="en" class="x"><head>
<meta name="og:locale" content="en_US"/>
<link rel="canonical" href="https://www.worldmonitor.app/docs/zh/about"/>
<title>关于</title>
</head><body></body></html>`;

  const enSeed = `<!DOCTYPE html><html lang="en"><head>
<meta name="og:locale" content="en_US"/>
<link rel="canonical" href="https://www.worldmonitor.app/docs/about"/>
<title>About</title>
</head><body></body></html>`;

  it('forces zh-Hans lang and reciprocal hreflang on Chinese docs HTML', () => {
    const html = rewriteDocsLocaleHtml(zhSeed, '/docs/zh/about');
    assert.match(html, /<html[^>]*\blang="zh-Hans"/);
    assert.match(html, /name="og:locale"[^>]*content="zh_CN"/);
    assert.match(
      html,
      /hreflang="zh-Hans" href="https:\/\/www\.worldmonitor\.app\/docs\/zh\/about"/,
    );
    assert.match(
      html,
      /hreflang="en" href="https:\/\/www\.worldmonitor\.app\/docs\/about"/,
    );
    assert.match(
      html,
      /hreflang="x-default" href="https:\/\/www\.worldmonitor\.app\/docs\/about"/,
    );
  });

  it('keeps English lang and adds the zh-Hans alternate on English docs HTML', () => {
    const html = rewriteDocsLocaleHtml(enSeed, '/docs/about');
    assert.match(html, /<html[^>]*\blang="en"/);
    assert.match(
      html,
      /hreflang="zh-Hans" href="https:\/\/www\.worldmonitor\.app\/docs\/zh\/about"/,
    );
    assert.match(
      html,
      /hreflang="en" href="https:\/\/www\.worldmonitor\.app\/docs\/about"/,
    );
  });

  it('replaces a broken Mintlify hreflang set instead of duplicating it', () => {
    const seeded = enSeed.replace(
      '</head>',
      '<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/docs/about"></head>',
    );
    const html = rewriteDocsLocaleHtml(seeded, '/docs/about');
    const matches = html.match(/rel="alternate" hreflang=/g) ?? [];
    assert.equal(matches.length, 3);
  });

  it('keeps the Mintlify fetch timeout below the routing-middleware deadline', () => {
    assert.ok(DOCS_UPSTREAM_TIMEOUT_MS > 0);
    assert.ok(DOCS_UPSTREAM_TIMEOUT_MS < ROUTING_MIDDLEWARE_RESPONSE_DEADLINE_MS);
  });

  it('only transforms HTML content types for document paths', () => {
    assert.equal(
      shouldTransformDocsUpstreamHtml('/docs/zh/about', 'text/html; charset=utf-8'),
      true,
    );
    assert.equal(
      shouldTransformDocsUpstreamHtml('/docs/zh/about', 'application/javascript'),
      false,
    );
    assert.equal(
      shouldTransformDocsUpstreamHtml('/docs/_next/static/x.js', 'text/html'),
      false,
    );
  });
});
