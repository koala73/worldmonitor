import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

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
    assert.deepEqual(webPage?.speakable, {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1'],
    });
  });

  // Mintlify emits the docs page node as ["Article","TechArticle"] with
  // dateModified and publisher but no author, which Google requires — the docs
  // were rich-result ineligible (#7530). Use the real upstream shape.
  const articleSeed = `<!DOCTYPE html><html lang="en"><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":["Article","TechArticle"],"@id":"https://www.worldmonitor.app/docs/about#article","headline":"About World Monitor","dateModified":"2026-08-30T00:00:00Z","publisher":{"@id":"https://www.worldmonitor.app/#organization"}}]}</script>
</head><body></body></html>`;

  it('attributes the docs Article to the canonical Organization', () => {
    const graph = jsonLdBlocks(rewriteDocsLocaleHtml(articleSeed, '/docs/about'))
      .find((block) => Array.isArray(block['@graph']))?.['@graph'] as Record<string, unknown>[];
    const article = graph.find((node) => Array.isArray(node['@type']));
    assert.ok(article, 'the Article node must survive the rewrite');
    assert.deepEqual(article.author, { '@id': 'https://www.worldmonitor.app/#organization' });
    assert.deepEqual(article.publisher, { '@id': 'https://www.worldmonitor.app/#organization' });
    assert.equal(article.dateModified, '2026-08-30T00:00:00Z');
    // Not synthesised: no per-page publication date exists in frontmatter,
    // docs.json, or any manifest, and copying dateModified into it would
    // assert a date we do not know.
    assert.equal(article.datePublished, undefined);
  });

  it('attributes a singular TechArticle and never overwrites an existing author', () => {
    const singular = articleSeed.replace('["Article","TechArticle"]', '"TechArticle"');
    const graph = jsonLdBlocks(rewriteDocsLocaleHtml(singular, '/docs/about'))
      .find((block) => Array.isArray(block['@graph']))?.['@graph'] as Record<string, unknown>[];
    assert.deepEqual(
      graph.find((node) => node['@type'] === 'TechArticle')?.author,
      { '@id': 'https://www.worldmonitor.app/#organization' },
    );

    const byline = articleSeed.replace(
      '"publisher"',
      '"author":{"@type":"Person","name":"A Named Author"},"publisher"',
    );
    const bylineGraph = jsonLdBlocks(rewriteDocsLocaleHtml(byline, '/docs/about'))
      .find((block) => Array.isArray(block['@graph']))?.['@graph'] as Record<string, unknown>[];
    assert.deepEqual(
      bylineGraph.find((node) => Array.isArray(node['@type']))?.author,
      { '@type': 'Person', name: 'A Named Author' },
      'an upstream byline must win over the Organization fallback',
    );
  });

  it('does not attribute a non-Article node', () => {
    const graph = jsonLdBlocks(rewriteDocsLocaleHtml(mintlifySeed, '/docs/getting-started'))
      .find((block) => Array.isArray(block['@graph']))?.['@graph'] as Record<string, unknown>[];
    for (const node of graph) {
      assert.equal(node.author, undefined, `${String(node['@type'])} must not gain an author`);
    }
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

// Live upstream emits a bare WebPage with no Article node (verified against
// production /docs/architecture); the rewrite injects the article from the
// page node plus the build-time date manifest (#7616 U6).
describe('docs article injection for bare WebPage output', () => {
  const ORG_ID = 'https://www.worldmonitor.app/#organization';

  const seed = (page: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(page)}</script></head><body></body></html>`;

  const flatNodes = (html: string): Record<string, unknown>[] =>
    [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .flatMap((m) => {
        const parsed = JSON.parse((m[1] as string).replace(/\\u003c/g, '<')) as unknown;
        const blocks = Array.isArray(parsed) ? parsed : [parsed];
        return blocks.flatMap((block) =>
          Array.isArray((block as Record<string, unknown>)['@graph'])
            ? (block as Record<string, unknown>)['@graph'] as Record<string, unknown>[]
            : [block as Record<string, unknown>],
        );
      });

  const isArticle = (node: Record<string, unknown>) => {
    const type = node['@type'];
    return type === 'Article' || type === 'TechArticle'
      || (Array.isArray(type) && (type.includes('Article') || type.includes('TechArticle')));
  };

  it('injects an Article node with manifest date, publisher, and author', async () => {
    const { DOCS_PAGE_DATES } = await import('../src/config/docs-page-dates.generated.ts');
    const html = rewriteDocsEntityGraph(seed({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': 'https://www.worldmonitor.app/docs/architecture#webpage',
      name: 'Design Philosophy - World Monitor',
      url: 'https://www.worldmonitor.app/docs/architecture',
    }), '/docs/architecture');
    const article = flatNodes(html).find(isArticle);
    assert.ok(article, 'a bare WebPage must gain an Article node');
    assert.equal(article?.dateModified, DOCS_PAGE_DATES['architecture']);
    assert.deepEqual(article?.publisher, { '@id': ORG_ID });
    assert.deepEqual(article?.author, { '@id': ORG_ID });
    assert.equal(article?.datePublished, undefined, 'publication dates are never synthesised');
  });

  it('never invents an article when the slug has no manifest date', () => {
    const html = rewriteDocsEntityGraph(seed({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': 'https://www.worldmonitor.app/docs/no-such-page#webpage',
      name: 'Nowhere',
      url: 'https://www.worldmonitor.app/docs/no-such-page',
    }), '/docs/no-such-page');
    assert.equal(flatNodes(html).filter(isArticle).length, 0);
  });

  it('covers every committed docs slug in the date manifest', async () => {
    const { DOCS_PAGE_DATES } = await import('../src/config/docs-page-dates.generated.ts');
    const slugs: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
        else if (entry.name.endsWith('.mdx')) slugs.push(`${prefix}${entry.name.slice(0, -'.mdx'.length)}`);
      }
    };
    walk('docs', '');
    for (const slug of slugs) {
      assert.match(
        DOCS_PAGE_DATES[slug] ?? '',
        /^\d{4}-\d{2}-\d{2}$/,
        `date manifest must carry a real date for docs/${slug}.mdx — run npm run docs:dates`,
      );
    }
    for (const slug of Object.keys(DOCS_PAGE_DATES)) {
      assert.equal(
        existsSync(join(repoRoot, `docs/${slug}.mdx`)),
        true,
        `date manifest must not retain removed page docs/${slug}.mdx`,
      );
    }
  });
});
