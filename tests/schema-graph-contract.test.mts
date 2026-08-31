import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import middleware from '../middleware';
import {
  WEB_DASHBOARD_VARIANTS,
  renderVariantDashboardHtml,
} from '../src/config/variant-dashboard-html';
import { VARIANT_META } from '../src/config/variant-meta';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

const ORGANIZATION_ID = 'https://www.worldmonitor.app/#organization';
const WEBSITE_ID = 'https://www.worldmonitor.app/#website';
const SOFTWARE_ID = 'https://www.worldmonitor.app/#software';
const SOURCE_ID = 'https://www.worldmonitor.app/#source';
const PERSON_ID = 'https://www.worldmonitor.app/blog/authors/elie-habib/#person';
const CANONICAL_ORIGIN = 'https://www.worldmonitor.app/';
const PERSON_ENTITY_SAME_AS = [
  'https://www.linkedin.com/in/eliashabib',
  'https://www.wikidata.org/wiki/Q121365724',
  'https://www.crunchbase.com/person/elie-habib-2',
];

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function jsonLdBlocks(html: string): Record<string, any>[] {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

function blocksOfType(blocks: Record<string, any>[], type: string): Record<string, any>[] {
  return blocks.filter((block) => block['@type'] === type);
}

describe('canonical schema graph', () => {
  guardProBuiltOutput();

  it('declares one canonical Organization and leaves every other product surface as a reference', {
    skip: shouldSkipProBuiltOutput(),
  }, () => {
    const welcomeBlocks = jsonLdBlocks(read('public/pro/welcome.html'));
    const proBlocks = jsonLdBlocks(read('public/pro/index.html'));
    const dashboardBlocks = jsonLdBlocks(read('index.html'));

    const organizations = blocksOfType(welcomeBlocks, 'Organization');
    assert.equal(organizations.length, 1, 'the canonical welcome page must declare Organization once');
    assert.equal(organizations[0]['@id'], ORGANIZATION_ID);
    assert.equal(organizations[0].url, CANONICAL_ORIGIN);
    assert.deepEqual(organizations[0].founder, { '@id': PERSON_ID });
    assert.equal(organizations[0].foundingDate, '2026-01');
    assert.equal(blocksOfType(proBlocks, 'Organization').length, 0, '/pro must reference the canonical Organization');
    assert.equal(blocksOfType(dashboardBlocks, 'Organization').length, 0, '/dashboard must reference the canonical Organization');

    const dashboardApp = blocksOfType(dashboardBlocks, 'WebApplication')[0];
    const dashboardSite = blocksOfType(dashboardBlocks, 'WebSite')[0];
    const proApp = blocksOfType(proBlocks, 'SoftwareApplication')[0];
    assert.deepEqual(dashboardApp.publisher, { '@id': ORGANIZATION_ID });
    assert.deepEqual(dashboardSite.publisher, { '@id': ORGANIZATION_ID });
    assert.deepEqual(proApp.publisher, { '@id': ORGANIZATION_ID });
    assert.doesNotMatch(read('pro-test/prerender.mjs'), /ORGANIZATION_JSONLD|inject Organization JSON-LD/);
  });

  it('keeps canonical search, product, page, and source-code nodes connected', () => {
    const welcomeBlocks = jsonLdBlocks(read('pro-test/welcome.html'));
    const webSite = blocksOfType(welcomeBlocks, 'WebSite')[0];
    const application = blocksOfType(welcomeBlocks, 'SoftwareApplication')[0];
    const sourceCode = blocksOfType(welcomeBlocks, 'SoftwareSourceCode')[0];

    assert.equal(webSite['@id'], WEBSITE_ID);
    assert.deepEqual(webSite.publisher, { '@id': ORGANIZATION_ID });
    assert.equal(webSite.potentialAction?.['@type'], 'SearchAction');
    assert.equal(
      webSite.potentialAction?.target?.urlTemplate,
      'https://www.worldmonitor.app/dashboard?q={search_term_string}',
    );
    assert.equal(application['@id'], SOFTWARE_ID);
    assert.deepEqual(application.isBasedOn, { '@id': SOURCE_ID });
    assert.equal(sourceCode['@id'], SOURCE_ID);
    assert.equal(sourceCode.codeRepository, 'https://github.com/koala73/worldmonitor');
    assert.equal(sourceCode.license, 'https://www.gnu.org/licenses/agpl-3.0.html');
    assert.deepEqual(sourceCode.targetProduct, { '@id': SOFTWARE_ID });
  });

  it('serves every variant dashboard identically to browsers and AI crawlers', () => {
    const dashboardHtml = read('index.html');

    for (const variant of WEB_DASHBOARD_VARIANTS) {
      const renderedBlocks = jsonLdBlocks(renderVariantDashboardHtml(dashboardHtml, variant));
      const application = blocksOfType(renderedBlocks, 'WebApplication')[0];
      assert.ok(application, `${variant} must retain its WebApplication schema`);
      assert.equal(blocksOfType(renderedBlocks, 'Organization').length, 0, `${variant} must not redeclare Organization`);
      assert.equal(blocksOfType(renderedBlocks, 'WebSite').length, 0, `${variant} must not claim the canonical WebSite`);
      assert.deepEqual(application.publisher, { '@id': ORGANIZATION_ID });
      assert.deepEqual(application.isPartOf, { '@id': WEBSITE_ID });
      assert.deepEqual(application.author, { '@id': PERSON_ID });

      const webPage = blocksOfType(renderedBlocks, 'WebPage')[0];
      const crumbs = blocksOfType(renderedBlocks, 'BreadcrumbList')[0];
      assert.ok(webPage, `${variant} must declare a WebPage that joins the canonical graph`);
      assert.equal(webPage['@id'], `${VARIANT_META[variant].url}#webpage`);
      assert.deepEqual(webPage.isPartOf, { '@id': WEBSITE_ID });
      assert.deepEqual(webPage.publisher, { '@id': ORGANIZATION_ID });
      assert.deepEqual(webPage.mainEntity, { '@id': `${VARIANT_META[variant].url}#software` });
      assert.equal(webPage.speakable?.['@type'], 'SpeakableSpecification');
      assert.ok(Array.isArray(webPage.speakable?.cssSelector) && webPage.speakable.cssSelector.includes('h1'));
      assert.ok(crumbs, `${variant} must declare BreadcrumbList`);
      assert.equal(crumbs.itemListElement?.[0]?.item, CANONICAL_ORIGIN);

      const host = new URL(VARIANT_META[variant].url).hostname;
      const browser = middleware(new Request(`https://${host}/`, {
        headers: { 'user-agent': 'Mozilla/5.0' },
      }));
      const crawler = middleware(new Request(`https://${host}/`, {
        headers: { 'user-agent': 'Mozilla/5.0 GPTBot/1.1' },
      }));
      assert.equal(browser, undefined, `${variant} browser must continue to the production redirect`);
      assert.equal(crawler, undefined, `${variant} crawler must continue to the same production redirect`);
    }
  });

  it('binds the Pro page to the canonical site and product with speakable content', () => {
    const blocks = jsonLdBlocks(read('pro-test/index.html'));
    const application = blocksOfType(blocks, 'SoftwareApplication')[0];
    const webPage = blocksOfType(blocks, 'WebPage')[0];

    assert.equal(application['@id'], SOFTWARE_ID);
    assert.deepEqual(application.publisher, { '@id': ORGANIZATION_ID });
    assert.deepEqual(application.author, { '@id': PERSON_ID });
    assert.equal(webPage['@id'], 'https://www.worldmonitor.app/pro#webpage');
    assert.deepEqual(webPage.isPartOf, { '@id': WEBSITE_ID });
    assert.deepEqual(webPage.mainEntity, { '@id': SOFTWARE_ID });
    assert.equal(webPage.speakable?.['@type'], 'SpeakableSpecification');
    assert.ok(webPage.speakable.cssSelector.includes('h1'));
  });

  it('uses bare publisher references in the blog and includes author breadcrumbs', () => {
    for (const path of [
      'blog-site/src/pages/index.astro',
      'blog-site/src/layouts/BlogPost.astro',
      'blog-site/src/pages/authors/elie-habib.astro',
    ]) {
      const source = read(path);
      assert.doesNotMatch(source, /['"]@type['"]:\s*['"]Organization['"]/, `${path} must not redeclare Organization`);
      assert.match(source, new RegExp(`['"]@id['"]:\\s*['"]${ORGANIZATION_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
    }
    assert.match(read('blog-site/src/pages/authors/elie-habib.astro'), /['"]@type['"]:\s*['"]BreadcrumbList['"]/);
  });

  it('overrides Mintlify publisher metadata with the canonical Organization', () => {
    const docs = JSON.parse(read('docs/docs.json'));
    assert.deepEqual(docs.seo.organization, {
      id: ORGANIZATION_ID,
      name: 'World Monitor',
      url: CANONICAL_ORIGIN,
      logo: 'https://www.worldmonitor.app/favico/apple-touch-icon.png',
      sameAs: [
        'https://github.com/koala73/worldmonitor',
        'https://www.npmjs.com/package/worldmonitor',
        'https://x.com/worldmonitorai',
        'https://x.com/eliehabib',
        'https://discord.gg/re63kWKxaz',
        'https://www.wired.com/story/world-monitor-elie-habib/',
      ],
    });
  });

  it('puts the strongest Person anchors on the addressable #person node (#7459a)', () => {
    const authorPage = read('blog-site/src/pages/authors/elie-habib.astro');
    const personMatch = authorPage.match(/'@type': 'Person',[\s\S]*?sameAs:\s*\[([\s\S]*?)\]/);
    assert.ok(personMatch, 'author page must declare the canonical Person sameAs list');
    for (const url of PERSON_ENTITY_SAME_AS) {
      assert.ok(personMatch[1].includes(url), `canonical #person must include ${url}`);
    }

    for (const path of ['index.html', 'pro-test/index.html', 'pro-test/welcome.html']) {
      const html = read(path);
      assert.match(
        html,
        /"author": \{\s*"@id": "https:\/\/www\.worldmonitor\.app\/blog\/authors\/elie-habib\/#person"\s*\}/,
        `${path} must replace anonymous Person authors with the canonical @id`,
      );
      assert.doesNotMatch(
        html,
        /"@type": "Person"/,
        `${path} must not emit an anonymous or competing Person node`,
      );
      for (const url of PERSON_ENTITY_SAME_AS) {
        assert.doesNotMatch(
          html,
          new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${path} must not keep ${url} on an unreachable author object`,
        );
      }
    }
  });

  it('points DataCatalog and Dataset roles at the canonical Organization (#7459b)', () => {
    const generator = read('scripts/build-crawlable-corpus.mjs');
    assert.match(
      generator,
      /WORLD_MONITOR_ORG = Object\.freeze\(\{\s*'@id': 'https:\/\/www\.worldmonitor\.app\/#organization',\s*\}\)/,
    );
    assert.doesNotMatch(
      generator,
      /creator: \{ '@type': 'Organization', name: 'World Monitor'/,
      'corpus Datasets must not inline an anonymous Organization creator',
    );

    const reports = read('scripts/build-research-reports.mjs');
    assert.match(reports, /publisher: \{ '@id': 'https:\/\/www\.worldmonitor\.app\/#organization' \}/);
    assert.match(reports, /creator: \{ '@id': 'https:\/\/www\.worldmonitor\.app\/#organization' \}/);
  });

  it('grounds the source Organization with founder and foundingDate (#7459e)', () => {
    const welcome = blocksOfType(jsonLdBlocks(read('pro-test/welcome.html')), 'Organization')[0];
    assert.deepEqual(welcome.founder, { '@id': PERSON_ID });
    assert.equal(welcome.foundingDate, '2026-01');
  });
});
