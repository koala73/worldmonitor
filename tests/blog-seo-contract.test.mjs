import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeStats, validateCategoryExplainerCopy } from '../scripts/docs-stats.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const blogDir = resolve(root, 'blog-site/src/content/blog');
const postFiles = readdirSync(blogDir).filter((name) => name.endsWith('.md')).sort();

function parsePost(file) {
  const source = readFileSync(join(blogDir, file), 'utf8');
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, `${file}: missing frontmatter`);
  const field = (name) => {
    const match = frontmatter[1].match(new RegExp(`^${name}:\\s*(?:"([^"]*)"|'([^']*)')$`, 'm'));
    return match?.[1] ?? match?.[2];
  };
  return { file, source, body: source.slice(frontmatter[0].length), field };
}

const posts = postFiles.map(parsePost);

describe('blog SEO and GEO corpus contract', () => {
  it('keeps every post complete, unique, current, and answer-first', () => {
    assert.ok(posts.length >= 53, 'expected the complete published blog corpus');
    const titles = new Set();
    const metaTitles = new Set();
    const descriptions = new Set();

    for (const post of posts) {
      for (const key of ['title', 'description', 'metaTitle', 'keywords', 'audience', 'heroImage', 'pubDate']) {
        assert.ok(post.field(key), `${post.file}: missing ${key}`);
      }
      const title = post.field('title');
      const metaTitle = post.field('metaTitle');
      const description = post.field('description');
      assert.ok(metaTitle.length >= 30 && metaTitle.length <= 65, `${post.file}: metaTitle is ${metaTitle.length} chars`);
      assert.ok(description.length >= 110 && description.length <= 165, `${post.file}: description is ${description.length} chars`);
      assert.ok(!titles.has(title), `${post.file}: duplicate title`);
      assert.ok(!metaTitles.has(metaTitle), `${post.file}: duplicate metaTitle`);
      assert.ok(!descriptions.has(description), `${post.file}: duplicate description`);
      titles.add(title);
      metaTitles.add(metaTitle);
      descriptions.add(description);

      assert.doesNotMatch(post.body, /^#\s/m, `${post.file}: layout owns the sole H1`);
      assert.match(post.body, /^## Frequently Asked Questions$/m, `${post.file}: missing FAQ section`);
      assert.match(
        post.body,
        /\[[^\]]+\]\((?:https:\/\/www\.worldmonitor\.app)?\/blog\/posts\//,
        `${post.file}: missing contextual internal link`,
      );

      const offsiteLinks = [...post.body.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)/g)]
        .map((match) => new URL(match[1]))
        .filter((url) => !/(^|\.)worldmonitor\.app$/.test(url.hostname));
      assert.ok(offsiteLinks.length > 0, `${post.file}: add an authoritative external citation`);

      const published = new Date(post.field('pubDate'));
      const modified = post.field('modifiedDate') ? new Date(post.field('modifiedDate')) : published;
      assert.ok(modified >= published, `${post.file}: modifiedDate predates pubDate`);

      let previousLevel = 1;
      for (const heading of post.body.matchAll(/^(#{2,6})\s+/gm)) {
        const level = heading[1].length;
        assert.ok(level <= previousLevel + 1, `${post.file}: heading level jumps from H${previousLevel} to H${level}`);
        previousLevel = level;
      }
    }
  });

  it('does not reintroduce volatile aggregate inventory claims', () => {
    const corpus = posts.map((post) => post.source).join('\n');
    assert.doesNotMatch(corpus, /\b435\+ RSS|\b45\+ data layers|\b92 Global Stock|\b111 mapped|\b39 live geopolitical|\b21-language support/i);
    assert.doesNotMatch(
      corpus,
      /\b(?:58 map layers|28 languages|29 stock exchanges|14 central banks|63 (?:live )?(?:geopolitical intelligence )?tools)\b/i,
    );
  });

  // The explainer's own contract lives in scripts/docs-stats.mjs — its numeric
  // counts as claims() entries, its answer-first shape as
  // validateCategoryExplainerCopy — because the `unit` job that runs this file
  // is gated on changes.code, whose filter drops every .md path. Asserting it
  // here as well is what let a markdown-only edit bypass the guard entirely.
  // This delegates instead of restating, so there is one contract, checked in
  // the always-on docs-stats job and exercised again by the unit suite.
  it('keeps the first-party category explainer answer-first and fact-consistent', () => {
    const explainer = posts.find((post) => post.file === 'what-is-worldmonitor-real-time-global-intelligence.md');
    assert.ok(explainer, 'missing first-party World Monitor category explainer');
    assert.deepEqual(validateCategoryExplainerCopy(computeStats()), []);
  });

  it('keeps crawl, entity, and citation signals in the shared templates', () => {
    const base = readFileSync(resolve(root, 'blog-site/src/layouts/Base.astro'), 'utf8');
    const post = readFileSync(resolve(root, 'blog-site/src/layouts/BlogPost.astro'), 'utf8');
    const index = readFileSync(resolve(root, 'blog-site/src/pages/index.astro'), 'utf8');
    assert.match(base, /max-image-preview:large/);
    assert.match(base, /max-snippet:-1/);
    assert.match(base, /og:image:type/);
    assert.match(post, /article-dek/);
    assert.match(post, /"@type": "Audience"/);
    assert.match(post, /"citation": citations/);
    assert.match(post, /\/blog\/authors\/elie-habib\//);
    assert.match(post, /"@type": "SpeakableSpecification"/);
    assert.match(index, /"@type": "CollectionPage"/);
    assert.match(index, /"@type": "BreadcrumbList"/);
    assert.match(index, /"@type": "SpeakableSpecification"/);
  });

  // blog-site is a live JSON-LD emitter separate from the crawlable corpus: the
  // #7502 sweep in tests/crawlable-corpus.test.mjs walks built corpus output
  // and asserts a resolvable @context on every block, and use-cases/research
  // ride along only because buildCrawlableCorpus writes them into the same
  // outDir. Nothing covered blog-site's eleven producers, each of which
  // hand-wrote its own @context — a block that omitted one would have shipped
  // silently and been ignored by every consumer (#7530). Every producer now
  // routes through one serialiser that stamps a resolvable context; assert both
  // the seam's behaviour and that no producer bypasses it.
  describe('blog-site JSON-LD @context', () => {
    const jsonLdModule = resolve(root, 'blog-site/src/lib/json-ld.ts');
    const jsonLdSource = readFileSync(jsonLdModule, 'utf8');

    // Astro templates cannot be imported here, so exercise the seam by
    // evaluating the module's exported logic against the same cases the corpus
    // guard uses.
    const resolvable = (context) => {
      const urls = new Set(['https://schema.org', 'http://schema.org']);
      const check = (value) => {
        if (typeof value === 'string') return urls.has(value.replace(/\/$/, ''));
        if (Array.isArray(value)) return value.some(check);
        if (value && typeof value === 'object') return check(value['@vocab']);
        return false;
      };
      return check(context);
    };

    it('stamps a resolvable context on a node that omits one', async () => {
      const { withSchemaContext, stringifyJsonLd } = await import(
        pathToFileURL(jsonLdModule).href
      );
      assert.equal(withSchemaContext({ '@type': 'BlogPosting' })['@context'], 'https://schema.org');
      assert.ok(resolvable(JSON.parse(stringifyJsonLd({ '@type': 'FAQPage' }))['@context']));
    });

    it('preserves a context that already resolves, including richer forms', async () => {
      const { withSchemaContext } = await import(pathToFileURL(jsonLdModule).href);
      const array = ['https://schema.org', { wm: 'https://www.worldmonitor.app/#' }];
      assert.deepEqual(withSchemaContext({ '@context': array, '@type': 'Person' })['@context'], array);
      assert.equal(
        withSchemaContext({ '@context': 'http://schema.org', '@type': 'Person' })['@context'],
        'http://schema.org',
      );
    });

    it('replaces a context that does not resolve to schema.org', async () => {
      const { withSchemaContext } = await import(pathToFileURL(jsonLdModule).href);
      assert.equal(
        withSchemaContext({ '@context': 'https://example.invalid/ctx', '@type': 'Thing' })['@context'],
        'https://schema.org',
      );
    });

    it('escapes a closing script tag so a block cannot break out', async () => {
      const { stringifyJsonLd } = await import(pathToFileURL(jsonLdModule).href);
      const serialised = stringifyJsonLd({ '@type': 'Thing', name: '</script><img>' });
      assert.ok(!serialised.includes('</script>'), 'the raw closing tag must be escaped');
      assert.equal(JSON.parse(serialised).name, '</script><img>');
    });

    it('routes every JSON-LD producer through the shared serialiser', () => {
      // The injection sites live in Base.astro. If a template ever emits its own
      // ld+json script tag, it bypasses the stamp entirely.
      const emitters = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name.endsWith('.astro')) emitters.push(path);
        }
      };
      walk(resolve(root, 'blog-site/src'));
      assert.ok(emitters.length > 0, 'expected .astro templates to scan');

      const base = resolve(root, 'blog-site/src/layouts/Base.astro');
      for (const file of emitters) {
        const source = readFileSync(file, 'utf8');
        if (!/application\/ld\+json/.test(source)) continue;
        assert.equal(
          file,
          base,
          `${file} emits its own ld+json script tag, bypassing the shared @context stamp in Base.astro`,
        );
        assert.match(
          source,
          /set:html=\{stringifyJsonLd\(/,
          'Base.astro must serialise every block through stringifyJsonLd',
        );
        assert.match(
          source,
          /from '\.\.\/lib\/json-ld'/,
          'Base.astro must import the shared serialiser, not redefine one locally',
        );
      }

      assert.doesNotMatch(
        readFileSync(base, 'utf8'),
        /function stringifyJsonLd/,
        'a locally redefined serialiser would silently drop the shared @context stamp',
      );
      assert.match(jsonLdSource, /export function withSchemaContext/);
    });
  });

  it('keeps author archives and blog JSON-LD attribution accurate', () => {
    const authorPage = readFileSync(resolve(root, 'blog-site/src/pages/authors/elie-habib.astro'), 'utf8');
    const blogIndex = readFileSync(resolve(root, 'blog-site/src/pages/index.astro'), 'utf8');

    assert.ok(
      authorPage.includes('.filter((post) => (post.data.author || DEFAULT_AUTHOR) === DEFAULT_AUTHOR)'),
      'Elie author archive must exclude posts that resolve to a custom author',
    );
    assert.ok(
      blogIndex.includes('const authorName = post.data.author || DEFAULT_AUTHOR;'),
      'blog JSON-LD must resolve the default author per post',
    );
    assert.ok(
      blogIndex.includes(
        'const authorUrl = post.data.authorUrl || (authorName === DEFAULT_AUTHOR ? DEFAULT_AUTHOR_URL : undefined);',
      ),
      'blog JSON-LD must honor a custom authorUrl without assigning Elie’s URL to custom authors',
    );
    assert.ok(
      blogIndex.includes('...(authorName === DEFAULT_AUTHOR ? { "@id": DEFAULT_AUTHOR_ID } : {})'),
      'blog JSON-LD must assign Elie’s stable Person ID only to the default author',
    );
  });

  it('stamps glossary and author sitemap URLs with lastmod (#7382)', async () => {
    const { buildPostDateMap } = await import('../blog-site/astro.config.mjs');
    const dates = buildPostDateMap();
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    for (const key of [
      '/blog/glossary/',
      'https://www.worldmonitor.app/blog/glossary/',
      '/blog/glossary/strait-of-hormuz/',
      'https://www.worldmonitor.app/blog/glossary/strait-of-hormuz/',
      '/blog/authors/elie-habib/',
      'https://www.worldmonitor.app/blog/authors/elie-habib/',
    ]) {
      assert.match(dates.get(key) ?? '', iso, `${key} must receive a YYYY-MM-DD lastmod`);
    }
  });
});
