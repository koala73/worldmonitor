// Page contract for the shortlist layout behind
// /compare/best-geopolitical-risk-dashboards/ (the 2026 buyer's shortlist).
//
// The generic compare renderer is covered by comparison-pages-narrative and
// crawlable-corpus. This file pins what the shortlist adds: the author byline
// and visible dates, the SEO head limits, the ranked "best for" entries, the
// use-case table, the closing CTA, the BlogPosting/ItemList/FAQPage graph with
// no rating schema, and prices that come from the product catalog or a cited
// public source.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import { COMPARISON_MATRIX_COLUMNS, COMPARISON_PAGES, __test } from '../scripts/build-comparison-pages.mjs';
import {
  SHORTLIST_LAYOUT,
  SHORTLIST_PAGE_SEEDS,
  UNPUBLISHED_PRICE_CELLS,
  USE_CASE_COLUMNS,
  shortlistPage,
} from '../scripts/comparison-shortlist.mjs';
import { computeStats } from '../scripts/docs-stats.mjs';
import { PERSON_ID, SOFTWARE_ID } from '../src/config/schema-graph-ids.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'best-geopolitical-risk-dashboards';
const BASE_URL = 'https://www.worldmonitor.app';
const LASTMOD = '2026-10-14';
const SNAPSHOT_DATE = '2026-10-13';
const EXPECTED_H1 = "Best Geopolitical Risk Intelligence Platforms in 2026: The Buyer's Shortlist";
const EXPECTED_ORDER = [
  'World Monitor',
  'Dataminr',
  'Recorded Future',
  'Seerist',
  'Crisis24',
  'Factal',
  'Liveuamap',
  'Off-Nadir Delta',
];
const AUTHOR_PATH = '/blog/authors/elie-habib/';
const PERSON_STUB = {
  '@type': 'Person',
  '@id': PERSON_ID,
  name: 'Elie Habib',
  url: BASE_URL + AUTHOR_PATH,
};
const ENTERPRISE_PRICE_CELLS = new Set([
  'Enterprise-negotiated (undisclosed)',
  'Undisclosed (enterprise-negotiated)',
]);
const RATING_TYPES = new Set(['Review', 'Rating', 'AggregateRating']);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Mirrors the corpus shell closely enough for head and graph assertions.
const tpl = {
  escapeHtml,
  breadcrumbLd(baseUrl, items) {
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      '@id': new URL(items.at(-1).path, baseUrl).href + '#breadcrumb',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: new URL(item.path, baseUrl).href,
      })),
    };
  },
  pageDocument({ title, description, body, jsonLd, breadcrumbs }) {
    const graphs = [...(Array.isArray(jsonLd) ? jsonLd : [jsonLd]), breadcrumbs].filter(Boolean);
    return [
      '<!doctype html><html lang="en"><head>',
      `<title>${escapeHtml(title)}</title>`,
      `<meta name="description" content="${escapeHtml(description)}">`,
      ...graphs.map((graph) => `<script type="application/ld+json">${JSON.stringify(graph)}</script>`),
      '</head><body><main>',
      body,
      '</main></body></html>',
    ].join('');
  },
};

const page = COMPARISON_PAGES.find((candidate) => candidate.slug === SLUG);
const html = __test.renderComparePage(page, { tpl, baseUrl: BASE_URL, lastmod: LASTMOD, snapshotDate: SNAPSHOT_DATE });
const document = (() => {
  const window = new Window();
  window.document.write(html);
  return window.document;
})();
const main = document.querySelector('main');
const text = (node) => String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const words = (value) => text({ textContent: value }).split(' ').filter(Boolean).length;
const jsonLd = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(([, raw]) => JSON.parse(raw));
const nodeOfType = (type) => jsonLd.find((entry) => entry['@type'] === type);

function typesIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) typesIn(item, found);
  } else if (value && typeof value === 'object') {
    const declared = value['@type'];
    for (const type of Array.isArray(declared) ? declared : declared ? [declared] : []) found.push(type);
    for (const child of Object.values(value)) typesIn(child, found);
  }
  return found;
}

function faqHeadings() {
  const heading = [...main.querySelectorAll('h2')].find((node) => text(node) === 'Frequently asked questions');
  assert.ok(heading, 'page must keep the "Frequently asked questions" H2');
  const questions = [];
  let node = heading.nextElementSibling;
  while (node && node.tagName !== 'H2') {
    if (node.tagName === 'H3') questions.push(text(node));
    node = node.nextElementSibling;
  }
  return questions;
}

function seedWith(overrides) {
  const seed = structuredClone(SHORTLIST_PAGE_SEEDS.find((candidate) => candidate.slug === SLUG));
  return overrides(seed) ?? seed;
}

describe('the 2026 buyer\'s shortlist page contract', () => {
  it('registers the shortlist layout at the existing route in brief order', () => {
    assert.ok(page, `${SLUG} must stay in COMPARISON_PAGES`);
    assert.equal(page.layout, SHORTLIST_LAYOUT);
    assert.equal(page.path, '/compare/best-geopolitical-risk-dashboards/');
    assert.equal(page.h1, EXPECTED_H1);
    assert.deepEqual(page.itemList.map((item) => item.name), EXPECTED_ORDER);
    assert.deepEqual(page.itemList.map((item) => item.position), EXPECTED_ORDER.map((_, index) => index + 1));
    assert.equal(text(main.querySelector('h1')), EXPECTED_H1);
  });

  it('keeps the head inside the SEO limits without dashes', () => {
    const title = text(document.querySelector('title'));
    const description = document.querySelector('meta[name="description"]').getAttribute('content');
    assert.equal(title, page.title);
    assert.ok([...title].length < 60, `title must be under 60 chars, got ${[...title].length}`);
    assert.match(title, /World Monitor/);
    const length = [...description].length;
    assert.ok(length >= 150 && length <= 160, `meta description must be 150-160 chars, got ${length}`);
    for (const value of [title, description, page.h1]) {
      assert.doesNotMatch(value, /[\u2013\u2014]/, `no em or en dash in "${value}"`);
    }
  });

  it('shows the author byline, both dates, and a 95-word intro that names World Monitor', () => {
    const byline = main.querySelector('p.author-byline');
    assert.ok(byline, 'byline paragraph must render');
    const author = byline.querySelector(`a[rel="author"][href="${AUTHOR_PATH}"]`);
    assert.equal(text(author), 'Elie Habib');
    assert.match(text(byline), /Published 2026-09-04/);
    assert.match(text(byline), new RegExp(`Updated ${LASTMOD}`));
    assert.equal(byline.querySelector('time[data-updated]').getAttribute('datetime'), LASTMOD);
    const intro = main.querySelector('p.lede[data-intro]');
    assert.ok(words(intro.textContent) <= 95, `intro must be 95 words or fewer, got ${words(intro.textContent)}`);
    assert.match(text(intro), /World Monitor/);
    assert.match(text(intro), /geopolitical risk intelligence platforms/i);
  });

  it('renders five key takeaways, numbered "best for" entries, and a best-suited-for line per entry', () => {
    assert.equal(main.querySelectorAll('ul[data-key-takeaways] > li').length, 5);
    assert.ok(main.querySelectorAll('ol[data-ranking-criteria] > li').length >= 4);
    const ranked = [...main.querySelectorAll('h3[data-rank]')].map(text);
    assert.deepEqual(
      ranked,
      page.entries.map((entry, index) => `${index + 1}. ${entry.name}, best for ${entry.bestFor}`),
    );
    assert.deepEqual(ranked.map((heading) => heading.replace(/^\d+\. /, '').split(', best for ')[0]), EXPECTED_ORDER);
    const suited = [...main.querySelectorAll('p > strong')].filter((node) => text(node) === 'Best suited for:');
    assert.equal(suited.length, EXPECTED_ORDER.length);
  });

  it('renders the side-by-side matrix with the universal columns first and a six-row use-case table', () => {
    const matrix = main.querySelector('table[data-shortlist-matrix]');
    const headers = [...matrix.querySelectorAll('thead th')].map(text);
    assert.deepEqual(headers.slice(0, COMPARISON_MATRIX_COLUMNS.length), COMPARISON_MATRIX_COLUMNS);
    assert.deepEqual(headers.slice(COMPARISON_MATRIX_COLUMNS.length), ['Pricing model', 'Free tier or trial', 'Seats / team plan']);
    const rows = [...matrix.querySelectorAll('tbody tr')];
    assert.deepEqual(rows.map((row) => text(row.querySelector('td'))), EXPECTED_ORDER);
    for (const row of rows) assert.equal(row.querySelectorAll('td').length, headers.length);

    const useCases = main.querySelector('table[data-use-case-table]');
    assert.deepEqual([...useCases.querySelectorAll('thead th')].map(text), USE_CASE_COLUMNS);
    const useCaseRows = [...useCases.querySelectorAll('tbody tr')];
    assert.equal(useCaseRows.length, 6);
    for (const row of useCaseRows) {
      const link = row.querySelector('td a');
      assert.match(link.getAttribute('href'), /^\/blog\/best\/[a-z0-9-]+\/$/);
      assert.equal(row.querySelectorAll('td').length, 4);
    }
  });

  it('closes with the free-trial CTA as the last element', () => {
    const cta = main.querySelector('h2[data-cta]');
    assert.equal(text(cta), 'Try World Monitor for free (no credit card required)');
    let node = cta.nextElementSibling;
    const sentences = [];
    while (node) {
      assert.notEqual(node.tagName, 'H2', 'nothing may follow the CTA section');
      if (node.tagName === 'P' && !node.classList.contains('cta-links')) sentences.push(...text(node).split(/(?<=[.!?])\s+/));
      node = node.nextElementSibling;
    }
    assert.ok(sentences.length >= 5 && sentences.length <= 6, `CTA must be 5-6 sentences, got ${sentences.length}`);
    const last = main.lastElementChild;
    assert.ok(last.classList.contains('cta-links'), 'CTA links must be the last element');
    assert.ok(last.querySelector('a[href="/pro#pricing"]'), 'CTA must link /pro#pricing');
    assert.ok(last.querySelector('a[href="/docs/mcp-quickstart"]'), 'CTA must link the MCP quickstart');
  });

  it('emits BlogPosting, WebPage, ItemList, FAQPage and BreadcrumbList with the author Person and no rating schema', () => {
    const posting = nodeOfType('BlogPosting');
    assert.ok(posting, 'BlogPosting must be emitted');
    assert.equal(posting.headline, EXPECTED_H1);
    assert.deepEqual(posting.author, PERSON_STUB);
    assert.equal(posting.dateModified, LASTMOD);
    assert.equal(posting.datePublished, '2026-09-04');
    assert.deepEqual(posting.publisher, { '@id': 'https://www.worldmonitor.app/#organization' });
    const webPage = nodeOfType('WebPage');
    assert.deepEqual(webPage.author, PERSON_STUB);
    assert.equal(webPage.dateModified, LASTMOD);

    const itemList = nodeOfType('ItemList');
    assert.equal(itemList.itemListOrder, 'https://schema.org/ItemListOrderAscending');
    assert.equal(itemList.numberOfItems, EXPECTED_ORDER.length);
    assert.deepEqual(itemList.itemListElement.map((item) => item.name), EXPECTED_ORDER);
    assert.deepEqual(itemList.itemListElement.map((item) => item.position), EXPECTED_ORDER.map((_, index) => index + 1));
    assert.equal(itemList.itemListElement[0].item['@id'], SOFTWARE_ID);
    assert.equal(itemList.itemListElement[0].item['@type'], 'SoftwareApplication');

    const faq = nodeOfType('FAQPage');
    assert.deepEqual(faq.mainEntity.map((question) => question.name), faqHeadings());
    assert.ok(faq.mainEntity.length >= 6 && faq.mainEntity.length <= 8, `FAQ must have 6-8 questions, got ${faq.mainEntity.length}`);
    assert.deepEqual(faq.author, PERSON_STUB);

    assert.ok(nodeOfType('BreadcrumbList'), 'BreadcrumbList must be emitted');
    const types = typesIn(jsonLd);
    assert.deepEqual(types.filter((type) => RATING_TYPES.has(type)), []);
    assert.doesNotMatch(html, /aggregateRating|reviewRating|ratingValue/i);
    assert.doesNotMatch(main.textContent, /★|\bstars?\b|review count/i);
  });

  it('prices World Monitor from the product catalog and cites or withholds every competitor price', () => {
    const facts = JSON.parse(readFileSync(join(repoRoot, 'shared/product-facts.generated.json'), 'utf8'));
    const plan = (key) => facts.plans.find((candidate) => candidate.planKey === key);
    const worldMonitor = page.entries[0];
    assert.equal(worldMonitor.name, 'World Monitor');
    assert.ok(worldMonitor.pricing.published);
    for (const key of ['pro_monthly', 'api_starter']) {
      assert.ok(
        worldMonitor.pricing.cell.includes(`$${plan(key).price.toFixed(2)}/mo`),
        `World Monitor price cell must carry the catalog ${key} price`,
      );
    }
    const offerPrices = worldMonitor.pricing.offers.map((offer) => offer.price);
    assert.deepEqual(
      offerPrices,
      ['pro_monthly', 'pro_business_monthly', 'api_starter', 'api_business'].map((key) => plan(key).price.toFixed(2)),
    );
    const mcpTools = computeStats().mcpToolCount;
    assert.match(html, new RegExp(`\\b${mcpTools} MCP tools\\b`), 'MCP tool count must come from computeStats()');

    for (const entry of page.entries.slice(1)) {
      if (ENTERPRISE_PRICE_CELLS.has(entry.pricing.cell)) {
        assert.equal(entry.pricing.published, false, `${entry.name} enterprise cell must not claim a published price`);
      }
      if (!entry.pricing.published) {
        assert.ok(UNPUBLISHED_PRICE_CELLS.includes(entry.pricing.cell), `${entry.name} unpublished cell "${entry.pricing.cell}"`);
        assert.doesNotMatch(entry.pricing.cell, /\$/);
        assert.equal(entry.pricing.offers, undefined, `${entry.name} must not carry offers without a published price`);
      } else {
        assert.ok(entry.pricing.sources.length >= 1, `${entry.name} needs a cited source for its published price`);
      }
      for (const source of entry.pricing.sources ?? []) {
        assert.match(source.url, /^https:\/\//);
        assert.ok(html.includes(`href="${escapeHtml(source.url)}"`), `${entry.name} must link its price source ${source.url}`);
      }
    }
    for (const name of ['Dataminr', 'Recorded Future', 'Crisis24']) {
      const entry = page.entries.find((candidate) => candidate.name === name);
      assert.ok(ENTERPRISE_PRICE_CELLS.has(entry.pricing.cell), `${name} price cell must stay undisclosed`);
    }
  });

  it('rejects seeds that break the brief', () => {
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.keyTakeaways.pop(); })), /5 key takeaways/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.title = 'Best Geopolitical Risk Intelligence Platforms in 2026 | World Monitor'; })), /under 60/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.metaDescription = seed.metaDescription.slice(0, 120); })), /150-160/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.metaDescription = seed.metaDescription.replace(/[,.]/, '\u2014'); })), /dash/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.entries[1].pricing.cell = '$65,000/yr'; })), /published/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.entries.reverse(); })), /World Monitor/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.useCases.pop(); })), /use case/i);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.intro = `${seed.intro} ${'word '.repeat(60)}`; })), /95 words/);
  });

  it('rejects price claims the brief does not allow', () => {
    const published = (seed) => seed.entries.find((entry) => entry.name !== 'World Monitor' && entry.pricing.published);
    const unpublished = (seed) => seed.entries.find((entry) => !entry.pricing.published);
    assert.throws(() => shortlistPage(seedWith((seed) => { published(seed).pricing.sources = []; })), /cited (price )?source/);
    assert.throws(() => shortlistPage(seedWith((seed) => { published(seed).pricing.sources[0].url = 'http://example.com/pricing'; })), /https URL/);
    assert.throws(() => shortlistPage(seedWith((seed) => { unpublished(seed).pricing.offers = []; })), /offers/);
    assert.throws(() => shortlistPage(seedWith((seed) => { unpublished(seed).pricing.sources = []; })), /in prose without a cited price source/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.entries[0].paragraphs[0] += ' Pro costs $1.99/mo.'; })), /World Monitor prose prices/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.useCases[0].href = '/blog/vs/dataminr/'; })), /\/blog\/best\//);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.faqs = seed.faqs.slice(0, 5); })), /6-8 FAQs/);
    assert.throws(() => shortlistPage(seedWith((seed) => { seed.keyTakeaways[0] += ' See [the plans](http://example.com).'; })), /site path or https URL/);
  });
});
