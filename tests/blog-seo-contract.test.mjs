import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeStats, validateCategoryExplainerCopy } from '../scripts/docs-stats.mjs';
import { GLOSSARY_TERMS } from '../blog-site/src/data/glossary.ts';
import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';
import { RESEARCH_REPORTS } from '../shared/research-reports/index.mjs';

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

const RESTRICTED_VENDOR_PRICE_ALLOWLIST = new Map();
const UNSUPPORTED_VENDOR_PRICE_SOURCE = String.raw`(?:\$\s*\d[\d,.]*(?:[KM])?\+?|\b\d[\d,.]*(?:[KM])\b\+?|multi[- ]?million|six[- ]?figures?)`;
const UNSUPPORTED_VENDOR_PRICE_TERMS = new RegExp(UNSUPPORTED_VENDOR_PRICE_SOURCE, 'i');
const DISALLOWED_COMPARISON_PRICE_TERMS = /\$1M\+|\$100K\+|multi[- ]?million|six[- ]?figures?/i;
const RESTRICTED_VENDORS = ['Palantir', 'Dataminr', 'Recorded Future', 'Crisis24', 'Everbridge'];

function markdownTableCells(line) {
  if (!line.startsWith('|') || !line.endsWith('|')) return [];
  return line.slice(1, -1).split('|').map((cell) => cell.trim());
}

function assertNoUnsupportedVendorPrice(post, vendor) {
  const namedPriceSource = RESTRICTED_VENDOR_PRICE_ALLOWLIST.get(`${post.file}:${vendor}`);
  if (namedPriceSource) {
    assert.ok(post.source.includes(namedPriceSource), `${post.file}: ${vendor} allowlist entry must name its price source`);
    return;
  }

  const vendorPattern = new RegExp(`\\b${vendor}\\b`, 'i');
  const directPricePattern = new RegExp(
    `(?:\\b${vendor}\\b[^\\n.]{0,120}${UNSUPPORTED_VENDOR_PRICE_SOURCE}|${UNSUPPORTED_VENDOR_PRICE_SOURCE}(?:\\s+[\\w/-]+){0,3}\\s+\\b${vendor}\\b)`,
    'i',
  );
  assert.doesNotMatch(
    post.source,
    directPricePattern,
    `${post.file}: ${vendor} pricing needs a named source before publication`,
  );

  for (const section of post.source.split(/(?=^#{1,6}\s)/m)) {
    const heading = section.split('\n', 1)[0];
    if (vendorPattern.test(heading)) {
      assert.doesNotMatch(
        section,
        UNSUPPORTED_VENDOR_PRICE_TERMS,
        `${post.file}: ${vendor} pricing needs a named source before publication`,
      );
    }
  }

  const lines = post.source.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length - 2; lineIndex += 1) {
    const header = markdownTableCells(lines[lineIndex]);
    const vendorColumn = header.findIndex((cell) => vendorPattern.test(cell));
    if (vendorColumn === -1 || !/^\\|(?:\\s*:?-{3,}:?\\s*\\|)+\\s*$/.test(lines[lineIndex + 1])) continue;

    for (let rowIndex = lineIndex + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownTableCells(lines[rowIndex]);
      if (!row.length) break;
      if (/^price$/i.test(row[0])) {
        assert.doesNotMatch(
          row[vendorColumn] ?? '',
          UNSUPPORTED_VENDOR_PRICE_TERMS,
          `${post.file}: ${vendor} table price needs a named source before publication`,
        );
      }
    }
  }
}

describe('blog SEO and GEO corpus contract', () => {
  it('connects the worked editorial examples to their country, crisis, and waterway pages', () => {
    const expectedLinks = JSON.parse(readFileSync(join(root, 'tests/fixtures/editorial-corpus-links.json'), 'utf8'));
    for (const [slug, targets] of Object.entries(expectedLinks)) {
      const article = posts.find((post) => post.file === `${slug}.md`);
      const prose = article.body.replace(/```[\s\S]*?```/g, '');
      for (const target of targets) {
        const href = `https://www.worldmonitor.app${target}`;
        assert.equal(prose.split(`](${href})`).length - 1, 1, `${slug} links ${target} once outside code examples`);
      }
    }
  });
  it('links all thirteen waterways from the maritime explainer and the existing glossary entries', () => {
    const article = posts.find((post) => post.file === 'what-is-a-maritime-chokepoint.md');
    const routes = [
      'strait-of-hormuz', 'strait-of-malacca', 'suez-canal', 'bab-el-mandeb',
      'panama-canal', 'taiwan-strait', 'cape-of-good-hope', 'strait-of-gibraltar',
      'bosporus-strait', 'korea-strait', 'dover-strait', 'kerch-strait', 'lombok-strait',
    ];
    for (const route of routes) {
      const href = `https://www.worldmonitor.app/chokepoints/${route}/`;
      assert.equal(article.body.split(`](${href})`).length - 1, 1, `maritime explainer links ${route} once`);
    }
    for (const slug of ['suez-canal', 'strait-of-malacca']) {
      const term = GLOSSARY_TERMS.find((entry) => entry.slug === slug);
      assert.equal(term.learnMore?.filter((link) => link.href === `https://www.worldmonitor.app/chokepoints/${slug}/`).length ?? 0, 1);
    }
  });
  it('connects the Hormuz glossary, energy article, and methodology to existing trackers and research', () => {
    const tracker = 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/';
    const report = RESEARCH_REPORTS.find((entry) => entry.focusChokepointId === 'hormuz_strait');
    assert.ok(CHOKEPOINT_REGISTRY.some((entry) => entry.id === report.focusChokepointId));
    const term = GLOSSARY_TERMS.find((entry) => entry.slug === 'strait-of-hormuz');
    assert.equal(term.learnMore.filter((link) => link.href === tracker).length, 1);
    const article = posts.find((post) => post.file === 'energy-shock-monitoring-chokepoints-worldmonitor.md');
    const reportUrl = `https://www.worldmonitor.app/research/${report.slug}/`;
    for (const href of [tracker, reportUrl]) {
      assert.ok(article.body.includes(`](${href})`), `article content links ${href}`);
    }
    assert.match(article.body, /historical.*July 2026/i);
    const methodology = readFileSync(join(root, 'docs/methodology/chokepoints.mdx'), 'utf8');
    assert.ok(methodology.includes(`](${tracker})`));
  });
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

  it('does not publish unsupported prices for enterprise-negotiated vendors', () => {
    for (const post of posts) {
      for (const vendor of RESTRICTED_VENDORS) {
        assertNoUnsupportedVendorPrice(post, vendor);
      }
    }

    for (const source of [
      '---\ntitle: Pricing fixture\n---\n\nThis preamble is not a vendor heading.\n\n### World Monitor vs. Dataminr\n\n- Price: free vs. six-figure annual licenses',
      '| Product | Dataminr |\n| --- | --- |\n| Price | $50K |',
      'A $100K+ Palantir license',
      'A Palantir license costs 100K+ annually',
    ]) {
      assert.throws(
        () => assertNoUnsupportedVendorPrice({ file: 'price-claim-fixture.md', source }, source.includes('Palantir') ? 'Palantir' : 'Dataminr'),
        /pricing needs a named source|table price needs a named source/,
      );
    }

    const comparison = posts.find((post) => post.file === 'worldmonitor-vs-traditional-intelligence-tools.md');
    assert.ok(comparison, 'missing the traditional intelligence comparison post');
    assert.match(
      comparison.source,
      /Quartz reported in 2022[^\n]*\$24,000 per year/,
      'the Bloomberg figure must name its published source and year',
    );
    assert.match(
      comparison.source,
      /\| Price \| \$24K\/yr \(Quartz, 2022\) \| Undisclosed \(enterprise-negotiated\) \| Undisclosed \(enterprise-negotiated\) \| Undisclosed \(enterprise-negotiated\) \| Free \|/,
      'the price row must not turn negotiated vendor prices into estimates',
    );
    assert.doesNotMatch(comparison.source, DISALLOWED_COMPARISON_PRICE_TERMS);
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

  it('keeps glossary and profile pages distinct from editorial articles', () => {
    const glossary = readFileSync(resolve(root, 'blog-site/src/pages/glossary/[slug].astro'), 'utf8');
    const author = readFileSync(resolve(root, 'blog-site/src/pages/authors/elie-habib.astro'), 'utf8');
    const post = readFileSync(resolve(root, 'blog-site/src/layouts/BlogPost.astro'), 'utf8');
    const base = readFileSync(resolve(root, 'blog-site/src/layouts/Base.astro'), 'utf8');

    assert.match(glossary, /ogType="website"/);
    assert.match(glossary, /'@type': 'DefinedTerm'/);
    assert.match(author, /ogType="profile"/);
    assert.match(author, /'@type': 'ProfilePage'/);
    for (const page of [glossary, author]) {
      assert.doesNotMatch(page, /['"]@type['"]:\s*['"](?:Article|BlogPosting|NewsArticle)['"]/);
    }
    assert.match(post, /ogType="article"/);
    assert.match(post, /"@type": "BlogPosting"/);
    for (const field of ['headline', 'datePublished', 'dateModified', 'author', 'image']) {
      assert.ok(post.includes(`"${field}":`), `posts retain ${field}`);
    }
    const articleBlock = base.match(/\{resolvedOgType === 'article' && \(\s*<>([\s\S]*?)<\/>\s*\)\}/);
    assert.ok(articleBlock, 'article metadata must be gated by the page type');
    assert.doesNotMatch(base.replace(articleBlock[0], ''), /property="article:/);
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

    it('does not claim a replaced context retains the caller narrow type', () => {
      assert.doesNotMatch(
        jsonLdSource,
        /withSchemaContext<T extends Record<string, unknown>>\(node: T\): T/,
        'a replacement can change @context and must not be typed as the original T',
      );
      assert.doesNotMatch(
        jsonLdSource,
        /as unknown as T/,
        'the replacement return type must not be forced back to T',
      );
      assert.match(
        jsonLdSource,
        /type WithResolvableSchemaContext<T extends Record<string, unknown>> = Omit<T, '@context'> & \{[\s\S]*'@context': unknown;/,
        'the result type must retain other fields while widening the replaced context',
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
    // post-dates.mjs, not astro.config.mjs: this workspace is installed only by
    // the blog build now, so importing the config would need astro/config here.
    const { buildPostDateMap } = await import('../blog-site/post-dates.mjs');
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
