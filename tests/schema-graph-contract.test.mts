import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import middleware from '../middleware';
import { WORLD_MONITOR_ORG } from '../scripts/build-crawlable-corpus.mjs';
import {
  SOFTWARE_SHARED_PROPERTIES,
  WEBSITE_SHARED_PROPERTIES,
} from '../src/config/schema-graph-ids';
import {
  WEB_DASHBOARD_VARIANTS,
  renderVariantDashboardHtml,
} from '../src/config/variant-dashboard-html';
import { VARIANT_META } from '../src/config/variant-meta';
import {
  guardProBuiltOutput,
  shouldSkipProBuiltOutput,
  withoutUnbuiltProPaths,
} from './_lib/pro-built-output.mjs';

const ORGANIZATION_ID = 'https://www.worldmonitor.app/#organization';
const WEBSITE_ID = 'https://www.worldmonitor.app/#website';
const SOFTWARE_ID = 'https://www.worldmonitor.app/#software';
const SOURCE_ID = 'https://www.worldmonitor.app/#source';
const PERSON_ID = 'https://www.worldmonitor.app/blog/authors/elie-habib/#person';
const CANONICAL_ORIGIN = 'https://www.worldmonitor.app/';
const PRODUCT_WIKIDATA_URL = 'https://www.wikidata.org/wiki/Q141237754';
// Person role filler: anchored on the canonical @id AND self-describing, so the
// reference resolves inside a single document (#7459a). The strong sameAs
// anchors stay on the canonical node only.
const PERSON_ROLE = {
  '@id': PERSON_ID,
  '@type': 'Person',
  name: 'Elie Habib',
};
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

/**
 * Every node of `type` at any depth in a page's JSON-LD. Role fillers such as
 * `author` and `founder` are nested inside their parent node, so a top-level
 * scan cannot see them.
 */
function collectNodesOfType(html: string, type: string): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, any>;
    const declared = node['@type'];
    if (declared === type || (Array.isArray(declared) && declared.includes(type))) {
      found.push(node);
    }
    Object.values(node).forEach(walk);
  };
  jsonLdBlocks(html).forEach(walk);
  return found;
}

/**
 * Every node that DECLARES `id` -- carries the identity plus a body -- as
 * opposed to the bare `{ '@id': ... }` fillers that merely reference it. Walks
 * nested values so a declaration wrapped in `@graph` is not missed, which a
 * top-level scan would sail straight past (#7611).
 */
function declarationsOf(html: string, id: string): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, any>;
    if (node['@id'] === id && Object.keys(node).some((key) => key !== '@id' && key !== '@context')) {
      found.push(node);
    }
    Object.values(node).forEach(walk);
  };
  jsonLdBlocks(html).forEach(walk);
  return found;
}

/**
 * Every HTML document that could carry JSON-LD: the committed entry points
 * plus anything generated under public/ (both the crawlable corpus and the
 * /pro build write there). DISCOVERING this population is the point -- a
 * hand-listed one cannot notice a NEW surface claiming a canonical `@id`,
 * which is precisely the bug #7611 fixed. Not covered: blog-site/ Astro
 * templates and dist/, neither of which declares a canonical product node
 * today.
 */
function jsonLdDocumentPaths(): string[] {
  const root = new URL('../', import.meta.url);
  const found: string[] = [];
  const collect = (relativeDir: string, recurse: boolean): void => {
    for (const entry of readdirSync(new URL(relativeDir, root), { withFileTypes: true })) {
      const relativePath = `${relativeDir}${entry.name}`;
      if (entry.isDirectory()) {
        if (recurse && entry.name !== 'node_modules') collect(`${relativePath}/`, true);
      } else if (entry.name.endsWith('.html')) {
        found.push(relativePath);
      }
    }
  };
  collect('', false);
  collect('pro-test/', false);
  collect('public/', true);
  return found.sort();
}

// Properties a consumer merges by UNION rather than reading as one value, so
// they may legitimately differ per surface: the dashboard lists its own
// alternateName/keywords, /pro advertises the Business and API tiers on top of
// the shared offers, and featureList is rewritten per variant by
// variant-dashboard-html.ts. Everything else on a shared `@id` must agree.
const MAY_DIVERGE_ACROSS_SURFACES = new Set(['alternateName', 'featureList', 'keywords', 'offers']);

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
    assert.deepEqual(organizations[0].founder, PERSON_ROLE);
    assert.equal(organizations[0].foundingDate, '2026-01');
    assert.equal(blocksOfType(proBlocks, 'Organization').length, 0, '/pro must reference the canonical Organization');
    assert.equal(blocksOfType(dashboardBlocks, 'Organization').length, 0, '/dashboard must reference the canonical Organization');

    const dashboardApp = blocksOfType(dashboardBlocks, 'SoftwareApplication')[0];
    const dashboardSite = blocksOfType(dashboardBlocks, 'WebSite')[0];
    const proApp = blocksOfType(proBlocks, 'SoftwareApplication')[0];
    const welcomeApp = blocksOfType(welcomeBlocks, 'SoftwareApplication')[0];
    assert.deepEqual(dashboardApp.publisher, { '@id': ORGANIZATION_ID });
    assert.deepEqual(dashboardSite.publisher, { '@id': ORGANIZATION_ID });
    assert.deepEqual(proApp.publisher, { '@id': ORGANIZATION_ID });
    assert.ok(proApp.sameAs.includes(PRODUCT_WIKIDATA_URL));
    assert.ok(welcomeApp.sameAs.includes(PRODUCT_WIKIDATA_URL));
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
    const webPage = blocksOfType(welcomeBlocks, 'WebPage')[0];
    const crumbs = blocksOfType(welcomeBlocks, 'BreadcrumbList')[0];
    assert.equal(webPage['@id'], `${CANONICAL_ORIGIN}#webpage`);
    assert.deepEqual(webPage.breadcrumb, { '@id': `${CANONICAL_ORIGIN}#breadcrumb` });
    assert.equal(crumbs['@id'], `${CANONICAL_ORIGIN}#breadcrumb`);
    assert.equal(application['@id'], SOFTWARE_ID);
    assert.deepEqual(application.isBasedOn, { '@id': SOURCE_ID });
    assert.equal(sourceCode['@id'], SOURCE_ID);
    assert.equal(sourceCode.codeRepository, 'https://github.com/koala73/worldmonitor');
    assert.equal(sourceCode.license, 'https://www.gnu.org/licenses/agpl-3.0.html');
    assert.deepEqual(sourceCode.targetProduct, { '@id': SOFTWARE_ID });
  });

  it('connects the canonical dashboard page to its product graph and visible SEO content', () => {
    const blocks = jsonLdBlocks(read('index.html'));
    const application = blocksOfType(blocks, 'SoftwareApplication')[0];
    const webSite = blocksOfType(blocks, 'WebSite')[0];
    const webPage = blocksOfType(blocks, 'WebPage')[0];
    const crumbs = blocksOfType(blocks, 'BreadcrumbList')[0];
    const dashboardUrl = 'https://www.worldmonitor.app/dashboard';

    assert.equal(application['@id'], SOFTWARE_ID);
    assert.equal(webSite['@id'], WEBSITE_ID);
    assert.equal(webPage['@id'], `${dashboardUrl}#webpage`);
    assert.equal(webPage.url, dashboardUrl);
    assert.deepEqual(webPage.mainEntity, { '@id': SOFTWARE_ID });
    assert.deepEqual(webPage.isPartOf, { '@id': WEBSITE_ID });
    assert.deepEqual(webPage.publisher, { '@id': ORGANIZATION_ID });
    assert.deepEqual(webPage.speakable, {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', '.app-seo-summary'],
    });
    assert.deepEqual(webPage.breadcrumb, { '@id': `${dashboardUrl}#breadcrumb` });
    assert.equal(crumbs['@id'], `${dashboardUrl}#breadcrumb`);
    assert.deepEqual(crumbs.itemListElement, [
      { '@type': 'ListItem', position: 1, name: 'World Monitor', item: CANONICAL_ORIGIN },
      { '@type': 'ListItem', position: 2, name: 'Dashboard', item: dashboardUrl },
    ]);
  });

  it('binds every canonical product surface to the World Monitor Wikidata item (#7373)', () => {
    const dashboardBlocks = jsonLdBlocks(read('index.html'));
    const proBlocks = jsonLdBlocks(read('pro-test/index.html'));
    const welcomeBlocks = jsonLdBlocks(read('pro-test/welcome.html'));
    const productNodes = [
      ['dashboard', blocksOfType(dashboardBlocks, 'SoftwareApplication')[0]],
      ['Pro', blocksOfType(proBlocks, 'SoftwareApplication')[0]],
      ['welcome', blocksOfType(welcomeBlocks, 'SoftwareApplication')[0]],
    ] as const;

    for (const [surface, product] of productNodes) {
      assert.ok(product, `${surface} must declare its product node`);
      assert.deepEqual(
        product.sameAs?.filter((url: string) => url === PRODUCT_WIKIDATA_URL),
        [PRODUCT_WIKIDATA_URL],
        `${surface} must identify the product with Q141237754 exactly once`,
      );
    }

    const organization = blocksOfType(welcomeBlocks, 'Organization')[0];
    assert.ok(
      !organization.sameAs?.includes(PRODUCT_WIKIDATA_URL),
      'the web-application Wikidata item must not be attached to the distinct Organization node',
    );
  });

  // Double entry (#7611). The surfaces are asserted against
  // schema-graph-ids.ts below, so the module itself needs a second, independent
  // statement of the values that carry the product decision -- otherwise a wrong
  // edit to the module, faithfully copied into every surface, passes. The rest
  // of the shared node is prose and links, where a silently-mirrored typo is not
  // a realistic failure; these four are the ones #7611 found actually wrong.
  it('states the decision-bearing product values independently of the module (#7611)', () => {
    assert.equal(SOFTWARE_SHARED_PROPERTIES['@type'], 'SoftwareApplication');
    assert.equal(SOFTWARE_SHARED_PROPERTIES.applicationCategory, 'BusinessApplication');
    assert.equal(SOFTWARE_SHARED_PROPERTIES.url, CANONICAL_ORIGIN);
    assert.equal(WEBSITE_SHARED_PROPERTIES.url, CANONICAL_ORIGIN);
  });

  // #7611: pinning the `@id` strings and the cross-node references still left
  // every surface free to build its own body under a shared identity, so a
  // consumer merging by `@id` received two `applicationCategory` values for one
  // entity. Enumerating the properties that were wrong in Sept 2026 would only
  // freeze those; the invariant is "one `@id`, one body", so this asserts the
  // pinned values AND that no unpinned property diverges either.
  it('serves one set of #software and #website property values across every surface (#7611)', () => {
    const documents = jsonLdDocumentPaths();
    const pinned: Array<[string, Record<string, unknown>, string[]]> = [
      [SOFTWARE_ID, SOFTWARE_SHARED_PROPERTIES, withoutUnbuiltProPaths([
        'index.html',
        'pro-test/index.html',
        'pro-test/welcome.html',
        'public/pro/index.html',
        'public/pro/welcome.html',
      ])],
      [WEBSITE_ID, WEBSITE_SHARED_PROPERTIES, withoutUnbuiltProPaths([
        'index.html',
        'pro-test/welcome.html',
        'public/pro/welcome.html',
      ])],
    ];

    for (const [id, expected, required] of pinned) {
      // Discovered, not hand-listed: a surface that starts declaring the shared
      // identity is caught here rather than quietly exempted. The hand-listed
      // paths are the FLOOR -- they also catch a surface dropping the node.
      const emitters = new Map<string, Record<string, any>>();
      for (const path of documents) {
        const html = read(path);
        if (!html.includes(id)) continue;
        const declarations = declarationsOf(html, id);
        if (declarations.length === 0) continue;
        assert.equal(declarations.length, 1, `${path} must declare ${id} exactly once`);
        emitters.set(path, declarations[0]);
      }
      for (const path of required) {
        assert.ok(emitters.has(path), `${path} must still declare ${id}`);
      }

      for (const [path, node] of emitters) {
        for (const [property, value] of Object.entries(expected)) {
          assert.deepEqual(
            node[property],
            value,
            `${path} ${id} "${property}" must match schema-graph-ids.ts`,
          );
        }
      }

      // Every property two emitters both carry must agree, pinned or not.
      const carriers = new Map<string, Array<[string, unknown]>>();
      for (const [path, node] of emitters) {
        for (const [property, value] of Object.entries(node)) {
          if (MAY_DIVERGE_ACROSS_SURFACES.has(property)) continue;
          const seen = carriers.get(property) ?? [];
          seen.push([path, value]);
          carriers.set(property, seen);
        }
      }
      for (const [property, entries] of carriers) {
        const [firstPath, firstValue] = entries[0];
        for (const [path, value] of entries.slice(1)) {
          assert.deepEqual(
            value,
            firstValue,
            `${id} "${property}" differs between ${firstPath} and ${path}`,
          );
        }
      }
    }
  });

  it('serves every variant dashboard identically to browsers and AI crawlers', () => {
    const dashboardHtml = read('index.html');

    for (const variant of WEB_DASHBOARD_VARIANTS) {
      const renderedBlocks = jsonLdBlocks(renderVariantDashboardHtml(dashboardHtml, variant));
      const application = blocksOfType(renderedBlocks, 'SoftwareApplication')[0];
      assert.ok(application, `${variant} must retain its SoftwareApplication schema`);
      assert.equal(blocksOfType(renderedBlocks, 'Organization').length, 0, `${variant} must not redeclare Organization`);
      assert.equal(blocksOfType(renderedBlocks, 'WebSite').length, 0, `${variant} must not claim the canonical WebSite`);
      assert.deepEqual(application.publisher, { '@id': ORGANIZATION_ID });
      assert.deepEqual(application.isPartOf, { '@id': WEBSITE_ID });
      assert.deepEqual(application.author, PERSON_ROLE);
      assert.ok(application.sameAs.includes(PRODUCT_WIKIDATA_URL));

      const webPage = blocksOfType(renderedBlocks, 'WebPage')[0];
      const crumbs = blocksOfType(renderedBlocks, 'BreadcrumbList')[0];
      assert.equal(blocksOfType(renderedBlocks, 'WebPage').length, 1, `${variant} must replace the canonical WebPage`);
      assert.equal(blocksOfType(renderedBlocks, 'BreadcrumbList').length, 1, `${variant} must replace the canonical BreadcrumbList`);
      assert.ok(webPage, `${variant} must declare a WebPage that joins the canonical graph`);
      assert.equal(webPage['@id'], `${VARIANT_META[variant].url}#webpage`);
      assert.deepEqual(webPage.isPartOf, { '@id': WEBSITE_ID });
      assert.deepEqual(webPage.publisher, { '@id': ORGANIZATION_ID });
      assert.deepEqual(webPage.mainEntity, { '@id': `${VARIANT_META[variant].url}#software` });
      assert.equal(webPage.speakable?.['@type'], 'SpeakableSpecification');
      assert.ok(Array.isArray(webPage.speakable?.cssSelector) && webPage.speakable.cssSelector.includes('h1'));
      assert.deepEqual(webPage.breadcrumb, { '@id': `${VARIANT_META[variant].url}#breadcrumb` });
      assert.ok(crumbs, `${variant} must declare BreadcrumbList`);
      assert.equal(crumbs['@id'], `${VARIANT_META[variant].url}#breadcrumb`);
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
    assert.deepEqual(application.author, PERSON_ROLE);
    assert.equal(webPage['@id'], 'https://www.worldmonitor.app/pro#webpage');
    assert.deepEqual(webPage.isPartOf, { '@id': WEBSITE_ID });
    assert.deepEqual(webPage.mainEntity, { '@id': SOFTWARE_ID });
    assert.deepEqual(webPage.speakable, {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', 'main > p:first-of-type'],
    });
    assert.match(
      read('pro-test/index.html'),
      /<main[^>]*>\s*<p>/,
      'the Pro speakable paragraph selector must match the static main content',
    );
    assert.deepEqual(webPage.breadcrumb, { '@id': 'https://www.worldmonitor.app/pro#breadcrumb' });
    const crumbs = blocksOfType(blocks, 'BreadcrumbList')[0];
    assert.equal(crumbs['@id'], 'https://www.worldmonitor.app/pro#breadcrumb');
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
    const authorPage = read('blog-site/src/pages/authors/elie-habib.astro');
    assert.match(authorPage, /['"]@type['"]:\s*['"]BreadcrumbList['"]/);
    assert.match(
      authorPage,
      /'@type': 'ProfilePage',[\s\S]*?speakable: \{\s*'@type': 'SpeakableSpecification',\s*cssSelector: \['h1', '\.author-page-bio'\]/,
      'the author ProfilePage must target its static h1 and biography content',
    );
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
        /"author": \{\s*"@id": "https:\/\/www\.worldmonitor\.app\/blog\/authors\/elie-habib\/#person"/,
        `${path} must anchor the author on the canonical @id`,
      );
      // Every Person node must carry the canonical @id. Banning the literal
      // '"@type": "Person"' outright would also forbid the anchored typed stub
      // that makes the @id resolve within this document — the shape
      // blog-site/src/layouts/BlogPost.astro already uses. What must not appear
      // is an UNANCHORED Person, so assert over the parsed graph.
      for (const person of collectNodesOfType(html, 'Person')) {
        assert.equal(
          person['@id'],
          PERSON_ID,
          `${path} Person nodes must carry the canonical @id, got ${JSON.stringify(person['@id'])}`,
        );
      }
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
    // Assert the generator's runtime VALUE, not its source formatting: a
    // behaviour-preserving reflow must not red the gate, and a source regex
    // cannot see what the generator actually emits.
    assert.deepEqual(WORLD_MONITOR_ORG, {
      '@id': ORGANIZATION_ID,
      '@type': 'Organization',
      name: 'World Monitor',
      url: CANONICAL_ORIGIN,
    });
    // The role filler must stay RESOLVABLE: `@id` alone would reference a node
    // no generated corpus page declares (#7459b).
    assert.equal(WORLD_MONITOR_ORG['@type'], 'Organization');
    assert.ok(WORLD_MONITOR_ORG.name, 'role filler must carry a name so the reference resolves');
  });

  it('disambiguates the Organization from the live name collisions (#7373)', () => {
    // Four live confusables share the name: worldmonitor.io, world-monitor.app,
    // an impersonating "World Monitor Pro" GitHub repo, and three App Store
    // apps. `alternateName` alone cannot separate them -- it only adds a second
    // string that all four also match. `disambiguatingDescription` is the
    // property schema.org defines for exactly this, and it must state the
    // canonical domain rather than repeat the marketing description.
    for (const path of withoutUnbuiltProPaths(['pro-test/welcome.html', 'public/pro/welcome.html'])) {
      const organization = blocksOfType(jsonLdBlocks(read(path)), 'Organization')[0];
      const disambiguation = organization.disambiguatingDescription;

      assert.equal(typeof disambiguation, 'string', `${path} must carry disambiguatingDescription`);
      assert.ok(
        disambiguation.includes('www.worldmonitor.app'),
        `${path} disambiguation must name the canonical domain, since the collision is on the name`,
      );
      assert.ok(
        disambiguation.includes('Q141237754'),
        `${path} disambiguation must name the World Monitor product Wikidata item`,
      );
      assert.ok(
        disambiguation !== organization.description,
        `${path} disambiguatingDescription must distinguish, not restate description`,
      );
      assert.ok(
        /worldmonitor\.io/.test(disambiguation) && /world-monitor\.app/.test(disambiguation),
        `${path} disambiguation must name the colliding domains it is disclaiming`,
      );
      assert.match(
        disambiguation,
        /World Monitor Pro/,
        `${path} disambiguation must disclaim the similarly named repository`,
      );
      assert.match(
        disambiguation,
        /unrelated mobile applications/,
        `${path} disambiguation must disclaim the similarly named mobile applications`,
      );
      assert.equal(organization.alternateName, 'WorldMonitor');
      assert.equal(organization.interactionStatistic, undefined);
    }
  });

  it('grounds the source Organization with founder and foundingDate (#7459e)', () => {
    const welcome = blocksOfType(jsonLdBlocks(read('pro-test/welcome.html')), 'Organization')[0];
    assert.deepEqual(welcome.founder, PERSON_ROLE);
    assert.equal(welcome.foundingDate, '2026-01');
  });
});
