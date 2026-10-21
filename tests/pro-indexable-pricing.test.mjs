// /pro must expose pricing copy and robots directives in the raw HTML that
// Google's renderer actually reads (#7458). An earlier check treated
// <noscript> as visible text; Google executes JS and discards noscript, so
// this suite strips script/style/noscript before any word or $ assertion.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { crawlerDocumentSnapshot } from './_lib/crawler-visible-html.mjs';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';
import { INDEXABLE_ROBOTS_CONTENT } from '../shared/seo-robots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

const CATALOG_PRICES = [
  ['Free', { monthly: '$0', annual: '$0' }],
  ['Pro', { monthly: '$39.99', annual: '$359.99' }],
  ['Pro Business', { monthly: '$49.99', annual: '$449.99' }],
  ['API Starter', { monthly: '$99.99', annual: '$899.99' }],
  ['API Business', { monthly: '$299.99', annual: '$2,699.99' }],
];

function parsePricingRows(visibleRootMarkup) {
  const table = visibleRootMarkup.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
  assert.ok(table, 'crawler-visible HTML must include a pricing table');
  const rows = [...table.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<\/tr>/gi)].map(
    (match) => ({
      name: match[1].trim(),
      monthly: match[2].trim(),
      annual: match[3].trim(),
    }),
  );
  assert.ok(rows.length > 0, 'crawler-visible pricing table must include named monthly/annual rows');
  return Object.fromEntries(rows.map((row) => [row.name, row]));
}

function assertVisibleCatalogPrices(html, label) {
  const { visibleRootMarkup } = crawlerDocumentSnapshot(html);
  assert.match(visibleRootMarkup, /How much does World Monitor Pro cost\?/, `${label} must ask the pricing question inside #root`);
  const rows = parsePricingRows(visibleRootMarkup);
  assert.deepEqual(
    Object.keys(rows).sort(),
    CATALOG_PRICES.map(([name]) => name).sort(),
    `${label} crawler-visible pricing table rows must match the catalog-backed named plans`,
  );
  for (const [name, prices] of CATALOG_PRICES) {
    assert.equal(rows[name].monthly, prices.monthly, `${label} ${name} monthly must be ${prices.monthly} outside noscript`);
    assert.equal(rows[name].annual, prices.annual, `${label} ${name} annual must be ${prices.annual} outside noscript`);
    assert.match(visibleRootMarkup, new RegExp(prices.monthly.replace(/[$.]/g, '\\$&')));
    assert.match(visibleRootMarkup, new RegExp(prices.annual.replace(/[$.]/g, '\\$&')));
  }
}

function normalizeRobotsContent(content) {
  return content.split(',').map((directive) => directive.trim().toLowerCase()).sort();
}

function assertIndexableRobots(html, label) {
  const { headRobotsContents } = crawlerDocumentSnapshot(html);
  assert.equal(
    headRobotsContents.length,
    1,
    `${label} must emit exactly one active robots directive`,
  );
  assert.deepEqual(
    normalizeRobotsContent(headRobotsContents[0]),
    normalizeRobotsContent(INDEXABLE_ROBOTS_CONTENT),
    `${label} active robots directive must have the shared content`,
  );
}

const PRICING_COPY = `<h2>How much does World Monitor Pro cost?</h2>
<table><tbody>
  <tr><td>Free</td><td>$0</td><td>$0</td></tr>
  <tr><td>Pro</td><td>$39.99</td><td>$359.99</td></tr>
  <tr><td>Pro Business</td><td>$49.99</td><td>$449.99</td></tr>
  <tr><td>API Starter</td><td>$99.99</td><td>$899.99</td></tr>
  <tr><td>API Business</td><td>$299.99</td><td>$2,699.99</td></tr>
</tbody></table>`;

function htmlFixture({ head = '', root = '', sibling = '' }) {
  return `<!doctype html><html><head>${head}</head><body><div id="root">${root}</div>${sibling}</body></html>`;
}

guardProBuiltOutput();

describe('crawler-visible HTML must not count noscript (#7458)', () => {
  it('treats a noscript-only pricing table as invisible', () => {
    const noscriptOnly = htmlFixture({
      head: `<meta name="robots" content="${INDEXABLE_ROBOTS_CONTENT}">`,
      root: `<h1>World Monitor Pro</h1><noscript>${PRICING_COPY}</noscript>`,
    });
    const visible = crawlerDocumentSnapshot(noscriptOnly).visibleRootMarkup;
    assert.doesNotMatch(visible, /\$39\.99/);
    assert.doesNotMatch(visible, /How much does World Monitor Pro cost\?/);
    assert.throws(
      () => assertVisibleCatalogPrices(noscriptOnly, 'noscript-only fixture'),
      /inside #root|pricing table/,
    );
  });

  it('does not treat JSON-LD Offer prices as visible body copy', () => {
    const jsonLdOnly = htmlFixture({
      root: `<h1>World Monitor Pro</h1><script type="application/ld+json">
        {"@type":"Offer","name":"Pro","price":"39.99","priceCurrency":"USD"}
      </script>`,
    });
    const visible = crawlerDocumentSnapshot(jsonLdOnly).visibleRootMarkup;
    assert.doesNotMatch(visible, /39\.99/);
    assert.throws(
      () => assertVisibleCatalogPrices(jsonLdOnly, 'json-ld-only fixture'),
      /inside #root|pricing table/,
    );
  });

  for (const [name, fixture] of [
    ['template', htmlFixture({ root: `<template>${PRICING_COPY}</template>` })],
    ['comment', htmlFixture({ root: `<!-- ${PRICING_COPY} -->` })],
    ['body sibling', htmlFixture({ sibling: PRICING_COPY })],
  ]) {
    it(`does not treat ${name} pricing as visible #root copy`, () => {
      assert.throws(
        () => assertVisibleCatalogPrices(fixture, `${name} fixture`),
        /inside #root|pricing table/,
      );
    });
  }
});

describe('/pro robots metadata must be active and unambiguous (#7458)', () => {
  const indexable = `<meta name="robots" content="${INDEXABLE_ROBOTS_CONTENT}">`;
  const invalidFixtures = [
    ['missing', htmlFixture({})],
    ['duplicate', htmlFixture({ head: `${indexable}${indexable}` })],
    ['conflicting', htmlFixture({ head: `${indexable}<meta name="robots" content="noindex">` })],
    ['body-only', htmlFixture({ root: indexable })],
    ['script-only', htmlFixture({ head: `<script>const robots = '${indexable}'</script>` })],
    ['comment-only', htmlFixture({ head: `<!-- ${indexable} -->` })],
  ];

  for (const [name, fixture] of invalidFixtures) {
    it(`rejects ${name} robots metadata`, () => {
      assert.throws(
        () => assertIndexableRobots(fixture, `${name} fixture`),
        /must emit|exactly one active robots directive/,
      );
    });
  }
});

describe('/pro raw HTML is indexable (#7458)', () => {
  it('exposes catalog USD prices outside noscript in pro-test/index.html', () => {
    assertVisibleCatalogPrices(read('pro-test/index.html'), 'pro-test/index.html');
  });

  it('emits the shared indexable robots directive on /pro', () => {
    assertIndexableRobots(read('pro-test/index.html'), 'pro-test/index.html');
  });

  it('exposes catalog USD prices outside noscript in the built /pro page', {
    skip: shouldSkipProBuiltOutput(),
  }, () => {
    assertVisibleCatalogPrices(read('public/pro/index.html'), 'public/pro/index.html');
  });

  it('emits the shared indexable robots directive on the built /pro page', {
    skip: shouldSkipProBuiltOutput(),
  }, () => {
    assertIndexableRobots(read('public/pro/index.html'), 'public/pro/index.html');
  });
});
