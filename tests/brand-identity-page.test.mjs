import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const BRAND_PAGE = 'public/world-monitor.md';
const BRAND_URL = 'https://worldmonitor.app/world-monitor.md';
const WWW_BRAND_URL = 'https://www.worldmonitor.app/world-monitor.md';

function organizationBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]))
    .filter((block) => block['@type'] === 'Organization');
}

describe('World Monitor brand-identity page', () => {
  it('opens with the brand-named H1 and a NAP table crawlers can quote', () => {
    const body = read(BRAND_PAGE);
    assert.ok(body.startsWith('# World Monitor\n'), 'world-monitor.md must open with "# World Monitor"');
    assert.match(body, /## Official identity \(NAP\)/);
    assert.match(body, /\|\s*Name\s*\|\s*World Monitor\s*\|/);
    assert.match(body, /https:\/\/www\.worldmonitor\.app/);
    assert.match(body, /https:\/\/worldmonitor\.app \(permanent redirect to www\)/);
    assert.match(body, /support@worldmonitor\.app/);
    assert.match(body, /enterprise@worldmonitor\.app/);
    assert.match(body, /\|\s*Locality\s*\|\s*Dubai\s*\|/);
    assert.match(body, /\|\s*Country\s*\|\s*AE \(United Arab Emirates\)\s*\|/);
    assert.match(body, /does not publish a street address or telephone number/i);
    assert.doesNotMatch(body, /streetAddress|tel:|\bfaxNumber\b|\+\d{8,}/);
    assert.doesNotMatch(body, /\|\s*Telephone\s*\|/i);
    assert.doesNotMatch(body, /\|\s*Street\s*\|/i);
  });

  it('cites press mentions that already name World Monitor and link the product', () => {
    const body = read(BRAND_PAGE);
    assert.match(body, /www\.wired\.com\/story\/world-monitor-elie-habib/);
    assert.match(body, /mena\.entrepreneur\.com/);
    assert.match(body, /siliconcanals\.com/);
    assert.match(body, /lorientlejour\.com/);
  });

  it('is advertised on catalog, llms, agents, and sitemap discovery surfaces', () => {
    const catalog = JSON.parse(read('public/.well-known/api-catalog'));
    const hrefs = catalog.linkset.flatMap((ctx) =>
      Object.values(ctx).flatMap((value) => (Array.isArray(value) ? value.map((entry) => entry.href) : [])),
    );
    assert.ok(hrefs.includes(BRAND_URL), 'api-catalog must advertise world-monitor.md');

    for (const path of ['public/llms.txt', 'public/llms-full.txt', 'public/agents.md', 'public/home.md']) {
      assert.ok(read(path).includes('/world-monitor.md'), `${path} must link world-monitor.md`);
    }

    const sitemap = read('public/sitemap.xml');
    assert.ok(sitemap.includes(`<loc>${WWW_BRAND_URL}</loc>`), 'sitemap.xml must register the www brand page');
  });
});

describe('Organization JSON-LD NAP alignment', () => {
  it('keeps index.html linked to the canonical Organization without redeclaring it', () => {
    const orgs = organizationBlocks(read('index.html'));
    assert.equal(orgs.length, 0, 'the dashboard must not redeclare Organization');
    const html = read('index.html');
    assert.match(html, /"publisher": \{\s*"@id": "https:\/\/www\.worldmonitor\.app\/#organization"\s*\}/);
  });

  it('keeps the canonical welcome Organization NAP aligned', () => {
    const welcome = organizationBlocks(read('pro-test/welcome.html'));
    assert.equal(welcome.length, 1, 'welcome.html must declare one Organization');
    for (const org of welcome) {
      assert.equal(org.address?.addressLocality, 'Dubai');
      assert.equal(org.address?.addressCountry, 'AE');
      assert.equal(org.address?.streetAddress, undefined);
      assert.equal(org.telephone, undefined);
      assert.ok(org.sameAs.includes('https://x.com/eliehabib'));
    }
    assert.match(
      read('pro-test/welcome.html'),
      /rel="alternate" type="text\/markdown" href="\/world-monitor\.md"/,
    );
    assert.doesNotMatch(read('pro-test/prerender.mjs'), /Organization JSON-LD|ORGANIZATION_JSONLD/);
  });
});
