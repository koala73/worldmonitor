// /pro must expose pricing copy and robots directives in the raw HTML that
// Google's renderer actually reads (#7458). An earlier check treated
// <noscript> as visible text; Google executes JS and discards noscript, so
// this suite strips script/style/noscript before any word or $ assertion.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { crawlerVisibleHtml } from './_lib/crawler-visible-html.mjs';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';
import { INDEXABLE_ROBOTS_CONTENT } from '../shared/seo-robots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

const CATALOG_PRICES = [
  ['Free', { monthly: '$0', annual: '$0' }],
  ['Pro', { monthly: '$39.99', annual: '$359.99' }],
  ['Pro Business', { monthly: '$49.99', annual: '$449.99' }],
  ['API Starter', { monthly: '$99.99', annual: '$899.99' }],
  ['API Pro', { monthly: '$299.99', annual: '$2,699.99' }],
];

const ROBOTS_META = new RegExp(
  `name="robots" content="${INDEXABLE_ROBOTS_CONTENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
);

function parsePricingRows(html) {
  const visible = crawlerVisibleHtml(html);
  const table = visible.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
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
  const visible = crawlerVisibleHtml(html);
  assert.match(visible, /How much does World Monitor Pro cost\?/, `${label} must ask the pricing question outside noscript`);
  const rows = parsePricingRows(html);
  assert.deepEqual(
    Object.keys(rows).sort(),
    CATALOG_PRICES.map(([name]) => name).sort(),
    `${label} crawler-visible pricing table rows must match the catalog-backed named plans`,
  );
  for (const [name, prices] of CATALOG_PRICES) {
    assert.equal(rows[name].monthly, prices.monthly, `${label} ${name} monthly must be ${prices.monthly} outside noscript`);
    assert.equal(rows[name].annual, prices.annual, `${label} ${name} annual must be ${prices.annual} outside noscript`);
    assert.match(visible, new RegExp(prices.monthly.replace(/[$.]/g, '\\$&')));
    assert.match(visible, new RegExp(prices.annual.replace(/[$.]/g, '\\$&')));
  }
}

function assertIndexableRobots(html, label) {
  assert.match(html, ROBOTS_META, `${label} must emit ${INDEXABLE_ROBOTS_CONTENT}`);
}

guardProBuiltOutput();

describe('crawler-visible HTML must not count noscript (#7458)', () => {
  it('treats a noscript-only pricing table as invisible', () => {
    const noscriptOnly = `<!doctype html>
<html lang="en">
  <head>
    <title>World Monitor Pro</title>
    <meta name="robots" content="${INDEXABLE_ROBOTS_CONTENT}" />
  </head>
  <body>
    <div id="root"><h1>World Monitor Pro</h1></div>
    <noscript>
      <h2>How much does World Monitor Pro cost?</h2>
      <table>
        <tbody>
          <tr><td>Free</td><td>$0</td><td>$0</td></tr>
          <tr><td>Pro</td><td>$39.99</td><td>$359.99</td></tr>
          <tr><td>Pro Business</td><td>$49.99</td><td>$449.99</td></tr>
          <tr><td>API Starter</td><td>$99.99</td><td>$899.99</td></tr>
          <tr><td>API Pro</td><td>$299.99</td><td>$2,699.99</td></tr>
        </tbody>
      </table>
    </noscript>
  </body>
</html>`;
    const visible = crawlerVisibleHtml(noscriptOnly);
    assert.doesNotMatch(visible, /\$39\.99/);
    assert.doesNotMatch(visible, /How much does World Monitor Pro cost\?/);
    assert.throws(
      () => assertVisibleCatalogPrices(noscriptOnly, 'noscript-only fixture'),
      /outside noscript|pricing table/,
    );
  });

  it('does not treat JSON-LD Offer prices as visible body copy', () => {
    const jsonLdOnly = `<!doctype html>
<html lang="en">
  <body>
    <div id="root"><h1>World Monitor Pro</h1></div>
    <script type="application/ld+json">
      {"@type":"Offer","name":"Pro","price":"39.99","priceCurrency":"USD"}
    </script>
  </body>
</html>`;
    const visible = crawlerVisibleHtml(jsonLdOnly);
    assert.doesNotMatch(visible, /39\.99/);
    assert.throws(
      () => assertVisibleCatalogPrices(jsonLdOnly, 'json-ld-only fixture'),
      /outside noscript|pricing table/,
    );
  });
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
