import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('keeps capability claims aligned with generated repository facts', () => {
    const stats = JSON.parse(readFileSync(resolve(root, 'docs/generated/stats.json'), 'utf8'));
    const corpus = posts.map((post) => post.source).join('\n');
    assert.doesNotMatch(corpus, /\b435\+ RSS|\b45\+ data layers|\b92 Global Stock|\b111 mapped|\b39 live geopolitical|\b21-language support/i);
    assert.match(corpus, new RegExp(`\\b${stats.layerDefinitions} map layers\\b`));
    assert.match(corpus, new RegExp(`\\b${stats.locales} languages\\b`));
    assert.match(corpus, new RegExp(`\\b${stats.stockExchangeCount} stock exchanges\\b`));
    assert.match(corpus, new RegExp(`\\b${stats.centralBankInstitutionCount} central banks\\b`));
    assert.match(corpus, new RegExp(`\\b${stats.mcpToolCount} (?:live )?(?:geopolitical intelligence )?tools\\b`));
  });

  it('keeps crawl, entity, and citation signals in the shared templates', () => {
    const base = readFileSync(resolve(root, 'blog-site/src/layouts/Base.astro'), 'utf8');
    const post = readFileSync(resolve(root, 'blog-site/src/layouts/BlogPost.astro'), 'utf8');
    assert.match(base, /max-image-preview:large/);
    assert.match(base, /max-snippet:-1/);
    assert.match(base, /og:image:type/);
    assert.match(post, /article-dek/);
    assert.match(post, /"@type": "Audience"/);
    assert.match(post, /"citation": citations/);
    assert.match(post, /\/blog\/authors\/elie-habib\//);
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
});
