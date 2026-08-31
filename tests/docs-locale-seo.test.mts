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
  rewriteDocsEntityGraph,
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

describe('docs entity-graph rewrite (#7459d)', () => {
  const CANONICAL_WEBSITE = 'https://www.worldmonitor.app/#website';
  const mintlifySeed = `<!DOCTYPE html><html lang="en"><head>
<link rel="canonical" href="https://www.worldmonitor.app/docs/getting-started"/>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"World Monitor","creator":{"@type":"Organization","name":"Mintlify","url":"https://mintlify.com"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://www.worldmonitor.app/#organization","name":"World Monitor"},{"@type":"WebSite","@id":"https://www.worldmonitor.app/docs#website","name":"World Monitor","url":"https://www.worldmonitor.app/docs","publisher":{"@id":"https://www.worldmonitor.app/#organization"}},{"@type":"WebPage","@id":"https://www.worldmonitor.app/docs/getting-started#webpage","isPartOf":{"@id":"https://www.worldmonitor.app/docs#website"}}]}</script>
</head><body></body></html>`;

  function jsonLdBlocks(html: string): Record<string, unknown>[] {
    return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]));
  }

  it('drops the vendor-attributed WebSite and joins docs pages to the canonical website', () => {
    const html = rewriteDocsLocaleHtml(mintlifySeed, '/docs/getting-started');
    const blocks = jsonLdBlocks(html);
    assert.equal(
      blocks.some((block) => (
        block['@type'] === 'WebSite'
        && typeof block.creator === 'object'
        && block.creator !== null
        && (block.creator as { name?: string }).name === 'Mintlify'
      )),
      false,
      'Mintlify-attributed WebSite must not survive the docs rewrite',
    );
    assert.doesNotMatch(html, /docs#website/);
    const graph = blocks.find((block) => Array.isArray(block['@graph']))?.['@graph'] as Record<string, unknown>[];
    assert.ok(graph, 'Mintlify @graph must remain');
    const website = graph.find((node) => node['@type'] === 'WebSite' || node['@id'] === CANONICAL_WEBSITE);
    assert.ok(website, 'docs graph must keep a WebSite node');
    assert.equal(website['@id'], CANONICAL_WEBSITE);
    assert.equal(website.url, undefined);
    const webPage = graph.find((node) => node['@type'] === 'WebPage');
    assert.deepEqual(webPage?.isPartOf, { '@id': CANONICAL_WEBSITE });
  });
});

// Mintlify's HTML is third-party output we do not control, so the rewrite must
// survive shapes other than the one the seed fixture happens to use. Each case
// below was verified to SURVIVE the pre-fix implementation.
describe('docs entity-graph rewrite handles alternate vendor shapes (#7459d)', () => {
  const CANONICAL_WEBSITE = 'https://www.worldmonitor.app/#website';
  const MINTLIFY = { '@type': 'Organization', name: 'Mintlify', url: 'https://mintlify.com' };

  const wrap = (payload: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(payload)}</script></head><body></body></html>`;

  const blocks = (html: string): any[] =>
    [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')));

  const survivingMintlify = (html: string): boolean => JSON.stringify(blocks(html)).includes('Mintlify');

  it('drops a vendor WebSite inside a top-level array', () => {
    const html = rewriteDocsEntityGraph(wrap([
      { '@type': 'WebSite', name: 'World Monitor', creator: MINTLIFY },
      { '@type': 'WebPage', '@id': 'https://www.worldmonitor.app/docs/x#webpage' },
    ]));
    assert.equal(survivingMintlify(html), false);
  });

  it('drops a WebSite attributed via publisher rather than creator', () => {
    const html = rewriteDocsEntityGraph(wrap({
      '@graph': [{ '@type': 'WebSite', name: 'World Monitor', publisher: MINTLIFY }],
    }));
    assert.equal(survivingMintlify(html), false);
  });

  it('drops a WebSite whose @type is an array', () => {
    const html = rewriteDocsEntityGraph(wrap({
      '@graph': [{ '@type': ['WebSite', 'Thing'], name: 'World Monitor', creator: MINTLIFY }],
    }));
    assert.equal(survivingMintlify(html), false);
  });

  it('drops a vendor WebSite nested below the first @graph level', () => {
    const html = rewriteDocsEntityGraph(wrap({
      '@type': 'WebPage',
      mainEntity: { '@type': 'WebSite', name: 'World Monitor', creator: MINTLIFY },
    }));
    assert.equal(survivingMintlify(html), false);
  });

  it('retargets the trailing-slash docs WebSite id onto the canonical node', () => {
    const html = rewriteDocsEntityGraph(wrap({
      '@graph': [{ '@type': 'WebSite', '@id': 'https://www.worldmonitor.app/docs/#website', name: 'Docs' }],
    }));
    assert.doesNotMatch(html, /docs\/?#website/);
    const graph = blocks(html)[0]['@graph'];
    assert.equal(graph[0]['@id'], CANONICAL_WEBSITE);
  });

  it('escapes < so a </script> inside a value cannot close the element early', () => {
    // Upstream escapes the sequence so its own tag survives; JSON.parse restores
    // a LITERAL '</script>', and an unescaped re-emit would terminate the script
    // element mid-payload. Build the fixture the way Mintlify actually ships it.
    const payload = JSON.stringify({
      '@type': 'WebPage',
      description: 'Use </script> to close a script tag.',
    }).replace(/</g, '\\u003c');
    const source = `<html><head><script type="application/ld+json">${payload}</script></head><body></body></html>`;

    // Precondition: the fixture has exactly one closing tag, so any extra one in
    // the output came from the rewrite.
    assert.equal(source.match(/<\/script>/g)?.length, 1);

    const html = rewriteDocsEntityGraph(source);
    assert.equal(html.match(/<\/script>/g)?.length, 1, 'rewrite must not emit a second </script>');
    const parsed = blocks(html);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].description, 'Use </script> to close a script tag.');
  });

  it('leaves an unparseable block untouched rather than dropping it', () => {
    const broken = '<html><head><script type="application/ld+json">{not json</script></head><body></body></html>';
    assert.equal(rewriteDocsEntityGraph(broken), broken);
  });
});
