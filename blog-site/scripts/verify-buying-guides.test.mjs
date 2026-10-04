import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
const content = new URL('../src/content/guides/', import.meta.url);
const categories = { vs: 5, alternatives: 5, best: 10 };
const site = 'https://www.worldmonitor.app';
const hub = readFileSync(new URL('guides/index.html', dist), 'utf8');
const llms = readFileSync(new URL('llms.txt', dist), 'utf8');
const sitemap = readFileSync(new URL('sitemap-0.xml', dist), 'utf8');

test('guide index structured data matches the displayed card order', () => {
  const cards = [...hub.matchAll(/<a\b[^>]*class="post-card"[^>]*href="([^"]+)"/g)]
    .map(match => `${site}${match[1]}`);
  const nodes = [...hub.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
    .map(match => JSON.parse(match[1]));
  const items = nodes.find(node => node['@type'] === 'CollectionPage').mainEntity.itemListElement;
  assert.equal(cards.length, 20);
  assert.deepEqual(items.map(item => item.url), cards);
  assert.deepEqual(items.map(item => item.position), cards.map((_, index) => index + 1));
});

test('guide updates date the guide and hub without redating the author archive', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'guide-dates-'));
  const root = join(fixture, 'blog-site');
  try {
    for (const path of ['src/content/blog', 'src/content/guides/vs', 'src/data', 'src/pages/authors']) {
      await mkdir(join(root, path), { recursive: true });
    }
    await writeFile(join(root, 'post-dates.mjs'), readFileSync(new URL('../post-dates.mjs', import.meta.url)));
    await writeFile(join(root, 'src/content/blog/example.md'), '---\npubDate: "2026-06-11"\n---\n');
    await writeFile(join(root, 'src/content/guides/vs/example.md'), '---\npubDate: "2026-10-02"\nmodifiedDate: "2030-01-01"\n---\n');
    await writeFile(join(root, 'src/data/glossary.ts'), '');
    await writeFile(join(root, 'src/pages/authors/elie-habib.astro'), '');
    const { buildPostDateMap } = await import(pathToFileURL(join(root, 'post-dates.mjs')).href);
    const dates = buildPostDateMap();
    assert.equal(dates.get('/blog/vs/example/'), '2030-01-01');
    assert.equal(dates.get('/blog/guides/'), '2030-01-01');
    assert.equal(dates.get('/blog/'), '2030-01-01');
    assert.equal(dates.get('/blog/authors/elie-habib/'), '2026-06-11');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

for (const [category, count] of Object.entries(categories)) {
  const files = readdirSync(new URL(`${category}/`, content)).filter(file => file.endsWith('.md'));
  test(`${category} exposes ${count} canonical guides`, () => assert.equal(files.length, count));

  for (const file of files) {
    const slug = file.slice(0, -3);
    const path = `/blog/${category}/${slug}/`;
    test(path, () => {
      const html = readFileSync(new URL(`${category}/${slug}/index.html`, dist), 'utf8');
      const markdown = readFileSync(new URL(`${category}/${file}`, content), 'utf8');
      const date = JSON.parse(markdown.match(/^pubDate: (.+)$/m)[1]);
      const modifiedDate = JSON.parse(markdown.match(/^modifiedDate: (.+)$/m)?.[1] ?? JSON.stringify(date));
      assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1, 'one page title');
      assert.ok(html.includes(`<link rel="canonical" href="${site}${path}"`), 'canonical route');
      assert.ok(html.includes('<table>') && html.includes('<thead>') && html.includes('<tbody>'), 'rendered comparison table');
      assert.ok(html.includes('World Monitor editorial team'), 'disclosed publisher');
      const visibleDate = new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
      assert.ok(html.includes(`>${visibleDate}</time>`), 'visible date agrees with metadata');
      assert.ok(html.includes('not a hands-on benchmark'), 'evaluation limits');
      assert.ok(hub.includes(`href="${path}"`), 'linked from the guide hub');
      assert.ok(llms.includes(`${site}${path}`), 'listed for agents');
      const sitemapEntry = [...sitemap.matchAll(/<url>(.*?)<\/url>/gs)]
        .map(match => match[1]).find(entry => entry.includes(`<loc>${site}${path}</loc>`));
      assert.equal(sitemapEntry?.match(/<lastmod>(.*?)<\/lastmod>/)?.[1].slice(0, 10), modifiedDate, 'dated sitemap entry');

      const nodes = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
        .map(match => JSON.parse(match[1]));
      const article = nodes.find(node => node['@type'] === 'BlogPosting');
      assert.equal(article?.url, `${site}${path}`, 'article URL agrees with canonical');
      assert.equal(article?.author.name, 'World Monitor editorial team');
      assert.equal(article?.author['@type'], 'Organization', 'editorial team is not a person');
      assert.ok(article?.citation.length > 0, 'official sources included in structured data');
      const faq = nodes.find(node => node['@type'] === 'FAQPage');
      assert.equal(faq?.mainEntity.length, 3, 'visible FAQ is machine-readable');
      for (const question of faq.mainEntity) {
        assert.ok(html.includes(question.name), 'FAQ question appears on the page');
        assert.ok(question.acceptedAnswer.text.length > 30, 'FAQ has a substantive answer');
      }

      for (const match of html.matchAll(/href="(\/blog\/[^"?]*)"/g)) {
        const [target, fragment] = match[1].split('#');
        const relative = target.slice('/blog/'.length);
        const targetFile = new URL(relative.endsWith('/') ? `${relative}index.html` : relative, dist);
        assert.ok(existsSync(targetFile), `internal destination exists: ${target}`);
        if (fragment) {
          const targetHtml = readFileSync(targetFile, 'utf8');
          assert.ok(targetHtml.includes(`id="${fragment}"`), `fragment exists: ${match[1]}`);
        }
      }
    });
  }
}
