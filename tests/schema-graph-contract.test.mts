import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import middleware from '../middleware';
import { rewriteDocsLocaleHtml } from '../src/config/docs-locale-seo';
import { DOCS_PAGE_DATES } from '../src/config/docs-page-dates.generated';
import {
  buildCorpus,
  PAGE_TYPES_WITH_ATTRIBUTION,
  WORLD_MONITOR_ORG,
} from '../scripts/build-crawlable-corpus.mjs';
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

/**
 * The generated corpus, built once and shared by every test below. CI does not
 * prebuild it, so the real generator runs in a temporary directory; the build
 * costs seconds, so memoize rather than paying it per test.
 */
let generatedCorpusPromise: Promise<Map<string, string>> | null = null;
function generatedCorpusDocuments(): Promise<Map<string, string>> {
  generatedCorpusPromise ??= (async () => {
    const documents = new Map<string, string>();
    const corpusDir = mkdtempSync(join(tmpdir(), 'wm-schema-corpus-'));
    try {
      await buildCorpus({ outDir: corpusDir });
      for (const path of readdirSync(corpusDir, { recursive: true }) as string[]) {
        if (path.endsWith('.html')) documents.set(`public/${path}`, readFileSync(join(corpusDir, path), 'utf8'));
      }
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
    return documents;
  })();
  return generatedCorpusPromise;
}

/**
 * Nodes that stand for the page itself, as opposed to the Dataset/Place/
 * Question nodes hanging off them. Driven from the generator's own set so the
 * guard cannot drift from what it guards, plus the Article-family types the
 * docs surface states its page body with (those never reach the corpus).
 *
 * A hand-listed set was the first version of this guard and it was already
 * wrong: it omitted FAQPage, so 227 pages carried an unattributed
 * rich-result node the guard could not see. Importing the set is what keeps a
 * newly-attributed type in step; ORPHAN_PAGE_BODY_RE below is what catches a
 * type nobody attributed at all.
 */
const PAGE_BODY_TYPES = [
  ...PAGE_TYPES_WITH_ATTRIBUTION,
  'TechArticle',
  'NewsArticle',
];

/**
 * A top-level node whose type NAMES it a page — the escape the imported set
 * cannot close. If a future family emits `ProfilePage` or `QAPage` and nobody
 * adds it to PAGE_TYPES_WITH_ATTRIBUTION, importing that set would happily
 * agree the page is fine. Matching on the name instead fails loudly and asks
 * for a deliberate decision.
 */
const ORPHAN_PAGE_BODY_RE = /Page$/;

// Single quotes, mixed case, and whitespace around `=` are all valid on the
// type attribute. A double-quote-only matcher lets a conflicting block hide
// from the producer discovery below simply by being written differently, so
// match the same shape the rest of the repo's JSON-LD readers accept.
function jsonLdBlocks(html: string): Record<string, any>[] {
  return [...html.matchAll(
    /<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi,
  )].map((match) => JSON.parse(match[1]));
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

function assertSelfDescribingAuthor(path: string, author: Record<string, unknown> | undefined): void {
  assert.ok(author, `${path}: must carry an author`);
  assert.ok(
    author['@id'] === ORGANIZATION_ID || author['@id'] === PERSON_ID,
    `${path}: author must reference the canonical Organization or Person, got ${JSON.stringify(author['@id'])}`,
  );
  // A bare `@id` is an unresolvable stub for the naive extractors this
  // signal is for: no generated page declares the canonical node, and
  // parsers resolve `@id` within one document (#7459b, #8073).
  assert.ok(
    typeof author['@type'] === 'string' && typeof author.name === 'string',
    `${path}: author reference must carry @type and name so it resolves in-document`,
  );
  if (author['@id'] === ORGANIZATION_ID) {
    assert.deepEqual(
      author,
      WORLD_MONITOR_ORG,
      `${path}: Organization author must be the typed WORLD_MONITOR_ORG stub`,
    );
  }
}

/**
 * Docs middleware output for every dated slug, both upstream shapes.
 * Shared by the body-consistency test and the author guard so a new docs
 * page cannot join one population and skip the other (#8073).
 */
let docsMiddlewareDocumentsMemo: Map<string, string> | null = null;
function docsMiddlewareDocuments(): Map<string, string> {
  docsMiddlewareDocumentsMemo ??= (() => {
    const documents = new Map<string, string>();
    for (const slug of Object.keys(DOCS_PAGE_DATES)) {
      for (const type of ['WebPage', ['Article', 'TechArticle']]) {
        const html = `<html><head><script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org', '@type': type, name: slug, headline: slug,
          url: `https://www.worldmonitor.app/docs/${slug}`,
        })}</script></head><body></body></html>`;
        const rewritten = rewriteDocsLocaleHtml(
          rewriteDocsLocaleHtml(html, `/docs/${slug}`),
          `/docs/${slug}`,
        );
        assert.equal(collectNodesOfType(rewritten, 'Article').length, 1, `${slug} must emit an Article`);
        documents.set(`docs/${slug} (${JSON.stringify(type)} middleware output)`, rewritten);
      }
    }
    return documents;
  })();
  return docsMiddlewareDocumentsMemo;
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
// they may legitimately hold DIFFERENT values per surface: the dashboard lists
// its own alternateName/keywords, /pro advertises the Business and API tiers on
// top of the shared offers, and featureList is rewritten per variant by
// variant-dashboard-html.ts.
//
// Every other property must agree wherever two surfaces both state it. Note
// that this is about conflicting VALUES, not presence: a surface may still omit
// a property entirely (welcome.html carries no `isPartOf`, index.html no
// `datePublished`), and the check below only compares surfaces that both carry
// it. Two stated values for one `@id` is the contradiction #7611 is about, so
// `isPartOf`, `datePublished` and `dateModified` deliberately stay OUT of this
// set even though they are absent on one surface each.
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
  it('serves consistent product, Organization and Dataset bodies across every surface (#7611, #7861)', async () => {
    const documents = new Map(jsonLdDocumentPaths().map((path) => [path, read(path)]));
    // CI does not prebuild the corpus. Exercise its real generator in isolation.
    for (const [path, html] of await generatedCorpusDocuments()) documents.set(path, html);
    const docsOrganization = JSON.parse(read('docs/docs.json')).seo.organization;
    const { id, logo, ...properties } = docsOrganization;
    const docsHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Organization', '@id': id, ...properties, logo: { '@type': 'ImageObject', url: logo } }],
    })}</script></head><body></body></html>`;
    documents.set('docs/about (middleware output)', rewriteDocsLocaleHtml(docsHtml, '/docs/about'));
    for (const [path, html] of docsMiddlewareDocuments()) documents.set(path, html);
    for (const [path, html] of documents) {
      const articles = ['Article', 'TechArticle', 'BlogPosting', 'NewsArticle']
        .flatMap((type) => collectNodesOfType(html, type));
      for (const article of articles) {
        for (const field of ['datePublished', 'dateModified']) {
          assert.equal(typeof article[field], 'string', `${path}: Article must carry ${field}`);
          assert.ok(Number.isFinite(Date.parse(article[field])), `${path}: invalid ${field}`);
        }
      }
    }
    const datasetIds = new Set([...documents.values()].flatMap((html) =>
      collectNodesOfType(html, 'Dataset').map((node) => node['@id']).filter((id): id is string => typeof id === 'string')));
    assert.ok(datasetIds.size > 0, 'build the corpus before checking Dataset identities');
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
      [ORGANIZATION_ID, {}, ['pro-test/welcome.html']],
      // #7980 put a Person body on the docs middleware output too, so the
      // "one `@id`, one body" invariant has to cover it: if the canonical
      // node at /blog/authors/elie-habib/ is ever renamed or retyped, the
      // docs and product stubs must not silently keep the old name.
      [PERSON_ID, {}, []],
      ...[...datasetIds].map((id): [string, Record<string, unknown>, string[]] => [id, {}, []]),
    ];

    for (const [id, expected, required] of pinned) {
      // Discovered, not hand-listed: a surface that starts declaring the shared
      // identity is caught here rather than quietly exempted. The hand-listed
      // paths are the FLOOR -- they also catch a surface dropping the node.
      const emitters = new Map<string, Record<string, any>>();
      for (const [path, html] of documents) {
        if (!html.includes(id)) continue;
        const declarations = declarationsOf(html, id);
        if (declarations.length === 0) continue;
        if (id === SOFTWARE_ID || id === WEBSITE_ID) {
          assert.equal(declarations.length, 1, `${path} must declare ${id} exactly once`);
        }
        declarations.forEach((node, index) => emitters.set(index === 0 ? path : `${path} (node ${index + 1})`, node));
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
          if (property === '@context') continue;
          if ((id === SOFTWARE_ID || id === WEBSITE_ID) && MAY_DIVERGE_ACROSS_SURFACES.has(property)) continue;
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

  // #7980: every generated page publishes a risk score, a ranking, or a
  // reference claim, and none of them named anyone who stands behind it --
  // `author` was absent at any depth on all 240. `publisher` alone does not
  // encode that signal, and the docs family already proves the shape. The
  // population is DISCOVERED from the generator's own output, so a new page
  // family cannot ship unattributed.
  it('attributes every generated page body to a canonical author (#7980)', async () => {
    const corpus = await generatedCorpusDocuments();
    assert.ok(corpus.size > 200, 'the generated corpus must be built before checking attribution');

    let checked = 0;
    for (const [path, html] of corpus) {
      const bodies = PAGE_BODY_TYPES.flatMap((type) => collectNodesOfType(html, type));
      assert.ok(bodies.length > 0, `${path}: no page-shaped JSON-LD body to attribute`);
      // The escape hatch check: a top-level node NAMED a page that no one
      // taught the generator to attribute. Runs over the raw blocks, not the
      // type list, so it sees what the list does not.
      for (const block of jsonLdBlocks(html)) {
        const declared = block['@type'];
        const types = Array.isArray(declared) ? declared : declared ? [declared] : [];
        if (!types.some((type: string) => ORPHAN_PAGE_BODY_RE.test(type))) continue;
        assert.ok(
          block.author,
          `${path}: ${JSON.stringify(declared)} names itself a page but carries no author — `
            + 'add it to PAGE_TYPES_WITH_ATTRIBUTION or exempt it deliberately',
        );
      }
      for (const body of bodies) {
        checked += 1;
        assertSelfDescribingAuthor(`${path}: ${JSON.stringify(body['@type'])}`, body.author);
      }
    }
    assert.ok(checked > 200, `expected the whole generated corpus to be checked, saw ${checked} bodies`);
  });

  // #8073: the #7980 author guard discovered its population from the corpus
  // generator, so 465 docs Articles shipped a bare `#organization` reference
  // the guard could not see. The docs family is synthesized through the real
  // rewrite, the same way the date and body-consistency tests already do.
  it('attributes every docs Article to a self-describing canonical author (#8073)', () => {
    const documents = docsMiddlewareDocuments();
    assert.equal(documents.size, Object.keys(DOCS_PAGE_DATES).length * 2);

    let checked = 0;
    for (const [path, html] of documents) {
      const articles = collectNodesOfType(html, 'Article');
      assert.equal(articles.length, 1, `${path}: expected one Article`);
      checked += 1;
      assertSelfDescribingAuthor(path, articles[0].author);
    }
    assert.equal(checked, documents.size, 'every synthesized docs document must contribute an Article author');
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
        /worldmonitor\.io/.test(disambiguation) && /world-monitor\.app/.test(disambiguation)
          && /world-monitor\.com/.test(disambiguation),
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
