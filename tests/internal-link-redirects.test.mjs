import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { buildCorpus, GENERATED_DIRS } from '../scripts/build-crawlable-corpus.mjs';
import { getRootlessDocsDestination } from '../src/config/docs-root-redirects.ts';
import { LEGAL_DOCUMENT_DIGESTS } from '../shared/legal.ts';

// #8603. Googlebot follows an internal link as a crawl signal. A link that
// redirects wastes a fetch and sends the signal to a non-canonical URL, and a
// link that 404s wastes the fetch entirely. Both are generator defects, not
// content defects: one `withUtmSource()` line put a 308 on 300+ published
// pages and one byline literal put a 307 on 275. This suite is the build-time
// half of that, so the next such line reds a PR instead of Search Console.
//
// The helpers below deliberately mirror the small readers in
// tests/crawlable-corpus.test.mjs (`read`, `generatedPageRoutes`,
// `decodeHtmlAttribute`). Those are module-private to a 7,700-line suite that
// takes about 90 seconds to import, so importing them here would run that
// suite as a side effect of this one.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW_ORIGIN = 'https://www.worldmonitor.app';

function readRepo(relative) {
  return readFileSync(join(repoRoot, relative), 'utf8');
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** The quoted string literals inside a named middleware.ts array or Set. */
function middlewareKeyList(declaration) {
  const source = readRepo('middleware.ts');
  const block = source.match(new RegExp(`const ${declaration}[^[]*\\[([\\s\\S]*?)\\]`))?.[1];
  assert.ok(block, `${declaration} extraction from middleware.ts found nothing`);
  const keys = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(keys.length > 0, `${declaration} extraction from middleware.ts found no keys`);
  return keys;
}

/**
 * Every query shape crawlerCanonicalUrl() 308s away, re-derived from
 * middleware.ts rather than copied. A hand-copied list keeps passing after
 * middleware adds a key, which is the silent-drift failure this gate exists to
 * prevent — and reading only the INDEX_NOISE_QUERY_KEYS literal inherited
 * exactly that blindness for two of the four shapes:
 *
 *  - `noiseKeys`: the explicit Set (ref, wm_referral, and seven utm_*).
 *  - `utmPrefix`: middleware also drops ANY key whose lowercase form starts
 *    with `utm_`, so `utm_id` — a standard Google Ads param absent from the
 *    Set — is a 308 the Set alone cannot see.
 *  - `legacyRootKeys`: on pathname `/` only, any of lat/lon/zoom/view/
 *    timeRange/layers/c/country/chokepoint rewrites the path to /dashboard.
 *
 * Each derivation asserts loudly rather than degrading to an empty rule, so a
 * middleware refactor reds this file instead of quietly disarming it.
 */
function middlewareBotRedirectShapes() {
  const source = readRepo('middleware.ts');
  const noiseKeys = middlewareKeyList('INDEX_NOISE_QUERY_KEYS = new Set');
  assert.ok(noiseKeys.includes('utm_source'), `expected utm_source in ${JSON.stringify(noiseKeys)}`);
  assert.ok(
    noiseKeys.includes('ref') && noiseKeys.includes('wm_referral'),
    `expected the referral keys in ${JSON.stringify(noiseKeys)}`,
  );
  // Presence of the prefix test is the derivation: the rule below models it, and
  // this fails the moment middleware stops applying it.
  assert.match(
    source,
    /key\.toLowerCase\(\)\.startsWith\('utm_'\)/,
    'middleware.ts no longer strips every utm_* key by prefix — re-derive the utmPrefix rule',
  );
  const legacyRootKeys = middlewareKeyList('LEGACY_DASHBOARD_ROOT_QUERY_KEYS');
  for (const expected of ['lat', 'lon', 'zoom', 'country', 'chokepoint', 'layers']) {
    assert.ok(legacyRootKeys.includes(expected), `expected ${expected} in ${JSON.stringify(legacyRootKeys)}`);
  }
  assert.match(
    source,
    /next\.pathname === '\/' && hasLegacyDashboardRootState/,
    'middleware.ts no longer rewrites a legacy root deep link — re-derive the legacyRootKeys rule',
  );
  return { noiseKeys, utmPrefix: /^utm_/i, legacyRootKeys };
}

/** Variant dashboard hosts, re-derived from middleware VARIANT_HOST_MAP. */
function variantHosts() {
  const source = readRepo('middleware.ts');
  const block = source.match(/const VARIANT_HOST_MAP: Record<string, string> = \{([\s\S]*?)\}/)?.[1];
  assert.ok(block, 'VARIANT_HOST_MAP extraction from middleware.ts found nothing');
  const hosts = [...block.matchAll(/'([a-z]+\.worldmonitor\.app)'/g)].map((match) => match[1]);
  assert.ok(hosts.length >= 5, `expected the variant hosts, got ${JSON.stringify(hosts)}`);
  return hosts;
}

const vercelConfig = JSON.parse(readRepo('vercel.json'));

/**
 * The legal set is content-locked by a digest in shared/legal.ts, and all four
 * documents share one TERMS_VERSION that a checkout acceptance record points
 * at. Editing one — even to retarget a hyperlink — forces a version bump that
 * tells every buyer the terms they accepted changed, so a link fix there has
 * to ride a real legal revision rather than an SEO pass. Only the
 * redirect-source rule is waived: an index-noise key or a bare variant host in
 * these documents still fails. Residual as of #8603: docs/terms.mdx links
 * https://www.worldmonitor.app/docs, a 307 to /docs/documentation.
 *
 * The four English paths only. shared/legal.ts records a digest for exactly
 * those, and tests/legal-version.test.mts iterates the same keys, so the
 * docs/zh/ mirrors carry no digest and no TERMS_VERSION coupling — waiving
 * them would waive more than the stated premise justifies. docs/zh/terms.mdx
 * was fixed in #8603 at no version cost.
 */
const DIGEST_LOCKED_DOCS = new Set(Object.keys(LEGAL_DOCUMENT_DIGESTS));

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vercel path tokens: `:name`, `:name(regex)`, and `:name*`.
 * The star repeats zero or more segments, so `/zh/:match*` matches `/zh`
 * itself, not only `/zh/something`. A required slash before `.*` missed the
 * bare prefix.
 */
function compileVercelSource(source) {
  let pattern = '';
  const token = /(\/)?(:([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\)|\*)?)/g;
  let last = 0;
  for (const match of source.matchAll(token)) {
    pattern += escapeRegex(source.slice(last, match.index));
    const slash = match[1] ?? '';
    const custom = match[4];
    if (custom === '*') pattern += slash ? `(?:${escapeRegex(slash)}.*)?` : '.*';
    else if (custom) pattern += `${escapeRegex(slash)}${custom}`;
    else pattern += `${escapeRegex(slash)}[^/]+`;
    last = match.index + match[0].length;
  }
  pattern += escapeRegex(source.slice(last));
  return new RegExp(`^${pattern}$`);
}

const sourcePatterns = new Map();
function sourcePattern(source) {
  let compiled = sourcePatterns.get(source);
  if (!compiled) {
    compiled = compileVercelSource(source);
    sourcePatterns.set(source, compiled);
  }
  return compiled;
}

function ruleAppliesToHost(rule, host) {
  const hostCondition = (rule.has ?? []).find((condition) => condition.type === 'host');
  return !hostCondition || new RegExp(hostCondition.value).test(host);
}

/**
 * A redirect fires only when its host, `has` query, and `missing` query
 * conditions all hold. `/` on a variant host 308s to /dashboard unless
 * `mode=agent` is present; that same path on www is a page.
 */
function redirectRuleMatches(rule, url) {
  if (!ruleAppliesToHost(rule, url.hostname)) return false;
  for (const condition of rule.has ?? []) {
    if (condition.type === 'query' && url.searchParams.get(condition.key) !== condition.value) return false;
  }
  for (const condition of rule.missing ?? []) {
    if (condition.type === 'query' && url.searchParams.get(condition.key) === condition.value) return false;
  }
  return sourcePattern(rule.source).test(url.pathname);
}

function paramSkeleton(source) {
  return source.replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\)|\*)?/g, ':$1');
}

/** Destination is the source plus one trailing slash, literals and `:slug` alike. */
function isTrailingSlashRedirect(rule) {
  if (rule.destination.startsWith('http')) return false;
  return paramSkeleton(rule.destination) === `${paramSkeleton(rule.source)}/`;
}

/**
 * Slashless pathnames that actually 308. Generated directory routes are not
 * all slash-normalised: vercel.json adds the slash only for named families,
 * and `trailingSlash` is unset, so `/sources/geopolitics` answers 200.
 */
function slashlessRedirectForms(routes) {
  const forms = new Set();
  for (const rule of vercelConfig.redirects) {
    if (!ruleAppliesToHost(rule, 'www.worldmonitor.app')) continue;
    if (!isTrailingSlashRedirect(rule)) continue;
    if (!rule.source.includes(':')) {
      forms.add(rule.source);
      continue;
    }
    const destination = sourcePattern(rule.destination);
    for (const route of routes) {
      if (route.endsWith('/') && route !== '/' && destination.test(route)) {
        forms.add(route.slice(0, -1));
      }
    }
  }
  return forms;
}

/** Every path the generated corpus actually writes: `/a/b/` for index.html, `/a/b.json` for a file. */
function generatedRoutes(outDir) {
  const routes = new Set();
  const visit = (relative) => {
    for (const entry of readdirSync(join(outDir, relative), { withFileTypes: true })) {
      const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.name === 'index.html') routes.add(`/${relative === '.' ? '' : `${relative}/`}`);
      else routes.add(`/${child}`);
    }
  };
  visit('.');
  return routes;
}

/**
 * Published documentation routes. Mintlify serves `/docs/<page>` only when the
 * page is BOTH a file on disk and listed in docs.json navigation, so the
 * intersection is the route set — a nav entry with no file 404s, and this repo
 * currently has three of those.
 */
function docsRoutes() {
  const config = JSON.parse(readRepo('docs/docs.json'));
  const navPages = [];
  const walk = (node) => {
    if (typeof node === 'string') navPages.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(config.navigation);
  assert.ok(navPages.length > 100, `docs.json navigation extraction found ${navPages.length} pages`);
  const files = new Set();
  const visit = (relative) => {
    for (const entry of readdirSync(join(repoRoot, 'docs', relative), { withFileTypes: true })) {
      const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      // Mintlify renders .md as well as .mdx: three methodology/* nav entries
      // are .md-only, and reading .mdx alone reported them as 404.
      else if (entry.name.endsWith('.mdx')) files.add(child.slice(0, -'.mdx'.length));
      else if (entry.name.endsWith('.md')) files.add(child.slice(0, -'.md'.length));
    }
  };
  visit('.');
  return new Set(navPages.filter((page) => files.has(page)).map((page) => `/docs/${page}`));
}

/** Astro blog routes: the index pages plus one route per post, author and glossary term. */
function blogRoutes(manifest) {
  // `/blog` answers 200 without the trailing slash as well (probed).
  const routes = new Set(['/blog', '/blog/', '/blog/glossary/']);
  for (const file of readdirSync(join(repoRoot, 'blog-site/src/content/blog'))) {
    if (file.endsWith('.md')) routes.add(`/blog/posts/${file.slice(0, -'.md'.length)}/`);
  }
  // Each .astro under pages/authors/ is one static author route.
  const authors = readdirSync(join(repoRoot, 'blog-site/src/pages/authors')).filter((file) => file.endsWith('.astro'));
  assert.ok(authors.length > 0, 'blog author page extraction found nothing');
  for (const file of authors) routes.add(`/blog/authors/${file.slice(0, -'.astro'.length)}/`);
  for (const route of manifest.sections.glossary.routes) routes.add(route);
  assert.ok(routes.size > 50, `blog route extraction found ${routes.size} routes`);
  return routes;
}

/**
 * Application routes the SPA answers directly. Taken from vercel.json
 * `rewrites` (a parameter-free rewrite source is by definition a 200), plus
 * `/` — the homepage is only ever a CONDITIONAL rewrite source, so it never
 * appears in that list even though it is the most-linked page on the site.
 */
function appRoutes() {
  const routes = new Set(vercelConfig.rewrites
    .map((rule) => rule.source)
    .filter((source) => !source.includes(':')));
  routes.add('/');
  return routes;
}

/**
 * Root static files Vercel serves straight out of public/, which is where the
 * agent artifacts live and what they link to each other by (`/llms.txt`,
 * `/world-monitor.md`, `/pricing.md`). Top level only: public/ also holds the
 * generated corpus subtree, and folding a locally-built copy of that into the
 * route set would make the 404 rule pass or fail on stale build state instead
 * of on generatedRoutes(), which this run builds fresh.
 */
function publicFileRoutes() {
  const files = readdirSync(join(repoRoot, 'public'), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${entry.name}`);
  assert.ok(files.includes('/llms.txt'), 'public/ file extraction found no llms.txt');
  return new Set(files);
}

function knownRoutes(outDir, manifest) {
  return new Set([
    ...generatedRoutes(outDir),
    ...docsRoutes(),
    ...blogRoutes(manifest),
    ...appRoutes(),
    ...publicFileRoutes(),
  ]);
}

/**
 * Every same-site href in the generated corpus, as {page, href, url}. Anchors
 * only (`<a href>`): a `<link rel>` or an asset src is not a crawl signal of
 * this kind.
 */
function* corpusHrefs(outDir) {
  const pages = readdirSync(outDir, { recursive: true }).map(String).filter((path) => path.endsWith('.html'));
  for (const page of pages) {
    const html = readFileSync(join(outDir, page), 'utf8');
    for (const [, raw] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const href = decodeHtmlAttribute(raw);
      if (/^(?:mailto:|tel:|#)/.test(href)) continue;
      let url;
      try {
        url = new URL(href, WWW_ORIGIN);
      } catch {
        continue;
      }
      if (!/(^|\.)worldmonitor\.app$/.test(url.hostname)) continue;
      yield { page, href, url };
    }
  }
}

/**
 * Markdown links and raw anchors in an authored source file. Fenced and
 * inline-code URLs are deliberately NOT matched: a fenced
 * `https://tech.worldmonitor.app` in the WebMCP allow-list, or a `/tmp/x.json`
 * in a shell example, is documentation OF a string, not a link to it, and
 * rewriting it would falsify the document. That is also the structural limit of
 * this gate — most of the harvested 404 family in #8602 came out of fences,
 * where Google synthesised a URL from a string that was never a link, so no
 * build-time link rule can see them.
 */
function authoredLinkTargets(source) {
  // Track the opening marker so shorter or different fences inside an example
  // cannot expose its contents. An unclosed fence consumes the remaining lines.
  let fence = null;
  const prose = source.split(/\r?\n/).map((line) => {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      return '';
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && (opening[1][0] === '~' || !opening[2].includes('`'))) {
      fence = opening[1];
      return '';
    }
    return line;
  }).join('\n');
  // Inline code uses matching backtick runs, including across line breaks.
  // Leave unmatched runs alone: they do not turn the rest of a paragraph into code.
  source = prose.replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, ' ');
  return [
    // A title after the URL (`](/docs "Docs")`) is still a link. Requiring `)`
    // immediately after the URL dropped those.
    ...[...source.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g)].map((match) => match[1]),
    // MDX components (`<Card href="...">`) are anchors too. `<a` alone missed them.
    ...[...source.matchAll(/<[A-Za-z][\w.]*\b[^>]*\bhref=["']([^"']+)["']/g)].map((match) => decodeHtmlAttribute(match[1])),
  ];
}

const WELCOME_HREF = /href[=:]\s*[{`'"]*((?:\$\{DASHBOARD_PATH\}|DASHBOARD_PATH|https:\/\/[a-z.]*worldmonitor\.app|\/)(?:[^`'"\s,}]|\s*\+\s*['"][^'"]*['"])*)/g;

/** Turn a welcome JSX href into the URL a browser would open. */
function expandWelcomeHref(raw) {
  return raw
    .replace(/^(?:\$\{DASHBOARD_PATH\}|DASHBOARD_PATH)/, '/dashboard')
    .replace(/\s*\+\s*(['"])(.*?)\1/g, '$2');
}

function welcomeHrefTargets(source) {
  return [...source.matchAll(WELCOME_HREF)].map((match) => expandWelcomeHref(match[1]));
}

/**
 * Every way a same-site href fails to answer 200, as human-readable strings.
 * Returned rather than asserted per href so a red run names every offender at
 * once instead of one per re-run.
 *
 * `waiveRedirectRule` exists only for the digest-locked legal set; every other
 * rule still applies to it.
 */
function linkViolations({ page, href, url }, context, { waiveRedirectRule = false } = {}) {
  const { shapes, hosts, routes, slashlessCorpusForms } = context;
  const violations = [];
  const where = `${page}: ${href}`;
  const keys = [...url.searchParams.keys()];

  const carried = keys.filter((key) => shapes.noiseKeys.includes(key));
  if (carried.length > 0) {
    violations.push(`${where} — carries index-noise query key(s) ${carried.join(', ')} (middleware 308s them away)`);
  }
  // Separate from the Set above so the message names the reason: middleware
  // drops utm_* by prefix, so a key absent from the Set is still a 308.
  const prefixed = keys.filter((key) => shapes.utmPrefix.test(key) && !shapes.noiseKeys.includes(key));
  if (prefixed.length > 0) {
    violations.push(`${where} — carries utm_* query key(s) ${prefixed.join(', ')} that middleware strips by prefix`);
  }
  if (url.pathname === '/') {
    const legacy = keys.filter((key) => shapes.legacyRootKeys.includes(key));
    if (legacy.length > 0) {
      violations.push(`${where} — legacy root deep link (${legacy.join(', ')}) 308s to /dashboard; link /dashboard directly`);
    }
  }
  if (
    hosts.includes(url.hostname)
    && (url.pathname === '/' || url.pathname === '')
    && url.searchParams.get('mode') !== 'agent'
  ) {
    violations.push(`${where} — links a bare variant host (308 to /dashboard); link the /dashboard path directly`);
  }
  if (!waiveRedirectRule && vercelConfig.redirects.some((rule) => redirectRuleMatches(rule, url))) {
    violations.push(`${where} — matches a vercel.json redirect, so it never answers 200`);
  }
  const rootlessDocs = getRootlessDocsDestination(url.pathname);
  if (rootlessDocs) {
    violations.push(`${where} — rootless docs path 308s to ${new URL(rootlessDocs).pathname}; link that path`);
  }
  if (slashlessCorpusForms.has(url.pathname)) {
    violations.push(`${where} — slashless form of a slash-normalised corpus route; link ${url.pathname}/`);
  }
  // A generated route stored with its trailing slash still answers 200 at the
  // slashless form when vercel does not redirect that family. Counting the
  // slashed route as published stops the 404 rule from re-banning it.
  const publishedRoute = routes.has(url.pathname)
    || (routes.has(`${url.pathname}/`) && !slashlessCorpusForms.has(url.pathname));
  // Variant and api hosts serve a different application from a different
  // route table, so only www hrefs are resolved against the www route set.
  if (url.hostname === 'www.worldmonitor.app' && modelsRoutesUnder(url.pathname) && !publishedRoute) {
    violations.push(`${where} — resolves to no published route (404)`);
  }
  return violations;
}

/**
 * Whether the route set above is COMPLETE for this path, which is the
 * precondition for calling a miss a 404. It is complete for the generated
 * corpus families (built fresh in this run), for `/blog/*` (derived from the
 * Astro content and page dirs) and for `/docs/<page>` (docs.json nav
 * intersected with the .md/.mdx files on disk).
 *
 * Everything else is skipped, because the model genuinely does not know it and
 * a miss there is a false positive, not a defect. Each of these was verified
 * live at 200 while the first draft of this rule reported it as a 404:
 *
 *  - `/api/*` handlers (/api/product-catalog), `/.well-known/*`, `/legal/*.pdf`
 *  - `/openapi.yaml`, `/openapi.json`, and other root assets outside public/
 *  - `/docs/api-reference/**`, which Mintlify generates from the OpenAPI specs
 *    rather than from a page file
 *  - anything with a file extension, including the `/:path.md` twin rewrite
 *    (/docs/terms.md) and /docs/changelog/rss.xml
 */
function modelsRoutesUnder(pathname) {
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  if (pathname.startsWith('/docs/api-reference/')) return false;
  if (pathname.startsWith('/docs/')) return true;
  if (pathname === '/blog' || pathname.startsWith('/blog/')) return true;
  return GENERATED_DIRS.some((dir) => pathname === `/${dir}` || pathname.startsWith(`/${dir}/`));
}

/**
 * One corpus build shared by every case here. buildCorpus() is the expensive
 * step and all three cases need the route set it produces, so it runs once.
 */
let fixture = null;
async function corpusFixture() {
  if (fixture) return fixture;
  const outDir = mkdtempSync(join(tmpdir(), 'wm-internal-links-'));
  const manifest = await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: WWW_ORIGIN });
  fixture = {
    outDir,
    context: {
      shapes: middlewareBotRedirectShapes(),
      hosts: variantHosts(),
      routes: knownRoutes(outDir, manifest),
      slashlessCorpusForms: slashlessRedirectForms(generatedRoutes(outDir)),
    },
  };
  return fixture;
}

it('excludes code examples while preserving authored links', () => {
  const realLinks = '[Actual page](/docs/algorithms) <a href="/countries/norway/">Norway</a>';
  const example = '[Example](/not-a-page) <a href="/docs">example</a>';
  for (const code of [
    `\`\`\`md\n${example}\n\`\`\``,
    `~~~html\n${example}\n~~~`,
    `  \`\`\`\`md\n\`\`\`\n${example}\n\`\`\`\`\``,
    `\`${example}\``,
    `\`\`${example} with a \` backtick\`\``,
    `\`a multiline\n${example}\``,
  ]) {
    assert.deepEqual(authoredLinkTargets(`${realLinks}\n${code}\n${realLinks}`), [
      '/docs/algorithms', '/docs/algorithms', '/countries/norway/', '/countries/norway/',
    ], code);
  }
  assert.deepEqual(authoredLinkTargets(`${realLinks}\n\`\`\`md\n${example}`), [
    '/docs/algorithms', '/countries/norway/',
  ], 'an unclosed fence runs to the end of the document');
  assert.deepEqual(authoredLinkTargets(`An unmatched \` leaves ${realLinks}`), [
    '/docs/algorithms', '/countries/norway/',
  ], 'an unmatched inline delimiter is prose');
  assert.deepEqual(authoredLinkTargets(`Unmatched \`\n\n${realLinks}\n\nAnother \``), [
    '/docs/algorithms', '/countries/norway/',
  ], 'inline code cannot cross a paragraph boundary');
  assert.deepEqual(authoredLinkTargets('[Titled](/docs/algorithms "Algorithms") <Card href=\'/countries/norway/\' />'), [
    '/docs/algorithms', '/countries/norway/',
  ]);
  assert.deepEqual(authoredLinkTargets('```md\n<Card href="/docs" />\n```\n[Kept](/blog/ "Blog")'), [
    '/blog/',
  ], 'a fenced component href is an example, not a link');
  assert.deepEqual(
    welcomeHrefTargets("href={DASHBOARD_PATH + '?utm_source=welcome'}"),
    ['/dashboard?utm_source=welcome'],
  );
  assert.deepEqual(welcomeHrefTargets('href={DASHBOARD_PATH}'), ['/dashboard']);
});

describe('internal links never redirect or 404 (#8603)', () => {
  after(() => {
    if (fixture) rmSync(fixture.outDir, { recursive: true, force: true });
    fixture = null;
  });

  it('publishes no corpus href that redirects, 404s, or carries index noise', async () => {
    const { outDir, context } = await corpusFixture();
    const violations = [];
    let scanned = 0;
    for (const href of corpusHrefs(outDir)) {
      scanned += 1;
      violations.push(...linkViolations(href, context));
    }
    // A floor, because the scan must not silently cover nothing: the corpus
    // publishes thousands of same-site anchors across ~280 pages.
    assert.ok(scanned > 5000, `expected the whole corpus to be scanned, saw ${scanned} same-site hrefs`);
    // Deduplicated by shape so 196 identical country CTAs read as one line.
    const unique = [...new Set(violations.map((line) => line.replace(/^[^:]+: /, '')))];
    assert.deepEqual(
      unique,
      [],
      `${violations.length} internal links do not answer 200:\n${unique.slice(0, 40).join('\n')}`,
    );
  });

  it('publishes no docs, blog or agent-artifact link that redirects or 404s', async () => {
    const { context } = await corpusFixture();
    const docs = [];
    const published = docsRoutes();
    const visit = (relative) => {
      for (const entry of readdirSync(join(repoRoot, 'docs', relative), { withFileTypes: true })) {
        const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(child);
        else {
          // docsRoutes() counts .md as published because Mintlify renders it;
          // scanning only .mdx left three .md-only methodology pages published
          // but never link-checked.
          const ext = entry.name.endsWith('.mdx') ? '.mdx' : entry.name.endsWith('.md') ? '.md' : null;
          if (ext && published.has(`/docs/${child.slice(0, -ext.length)}`)) docs.push(`docs/${child}`);
        }
      }
    };
    visit('.');
    const blog = readdirSync(join(repoRoot, 'blog-site/src/content/blog'))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `blog-site/src/content/blog/${file}`);
    // The root agent artifacts. public/llms.txt is hand-authored, and
    // llms-full.txt's brief above `## Generated corpus` is hand-authored too
    // (scripts/build-llms-full.mjs), so no regeneration will ever repair a bad
    // link in them — this gate is the only thing that can. They are also the
    // primary AI-crawler surface: llms.txt links world-monitor.md by name.
    // Nested on purpose: public/developers/llms.txt and public/api/llms.txt
    // are published agent files, and a top-level readdir never sees them.
    // Skip generated corpus roots so a local `public/countries` build cannot
    // change the scan. Those pages are checked from the fresh corpus build.
    const generatedRoots = new Set(GENERATED_DIRS.map((dir) => dir.split('/')[0]));
    const artifacts = [];
    const visitPublic = (relative) => {
      const directory = relative === '' ? join(repoRoot, 'public') : join(repoRoot, 'public', relative);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (relative === '' && generatedRoots.has(entry.name)) continue;
          visitPublic(child);
        } else if (/\.(?:md|txt)$/.test(entry.name)) {
          artifacts.push(`public/${child}`);
        }
      }
    };
    visitPublic('');
    // Per surface, not a total: a single floor over the sum keeps passing if
    // the blog moves to .mdx and its filter matches nothing.
    assert.ok(docs.length > 200, `expected the published docs pages, saw ${docs.length}`);
    assert.ok(blog.length > 40, `expected the blog posts, saw ${blog.length}`);
    assert.ok(artifacts.length > 10, `expected the public agent artifacts, saw ${artifacts.length}`);
    assert.ok(artifacts.includes('public/developers/llms.txt'), 'the developer briefing must be scanned');
    assert.ok(artifacts.includes('public/api/llms.txt'), 'the API section briefing must be scanned');

    const violations = [];
    for (const file of [...docs, ...blog, ...artifacts]) {
      const source = readRepo(file);
      // Mintlify resolves a root-relative link in an .mdx against the docs
      // base path, so `[Terms](/terms)` renders as href="/docs/terms" (probed
      // on www.worldmonitor.app/docs/dpa, 2026-09-24). Judging those against
      // the site root would report every one of them as a redirect it is not.
      // A public/ artifact is served from the root, so it needs no such shift.
      const base = file.startsWith('docs/') ? `${WWW_ORIGIN}/docs/` : WWW_ORIGIN;
      for (const target of authoredLinkTargets(source)) {
        let url;
        try {
          url = new URL(target.startsWith('/') ? `.${target}` : target, base);
        } catch {
          continue;
        }
        if (!/(^|\.)worldmonitor\.app$/.test(url.hostname)) continue;
        violations.push(...linkViolations(
          { page: file, href: target, url },
          context,
          { waiveRedirectRule: DIGEST_LOCKED_DOCS.has(file) },
        ));
      }
    }
    assert.deepEqual(violations, [], `${violations.length} docs, blog or artifact links do not answer 200:\n${violations.join('\n')}`);
  });

  it('publishes no welcome-page href that redirects or 404s', async () => {
    const { context } = await corpusFixture();
    const welcomeDir = join(repoRoot, 'pro-test/src/welcome');
    const sectionFiles = readdirSync(welcomeDir).filter((file) => file.endsWith('.tsx'));
    assert.ok(sectionFiles.length > 0, 'expected welcome section sources to scan');
    // WelcomeApp renders Footer and LegalFooterNav outside pro-test/src/welcome.
    // PressFooterNav is third-party press URLs and stays out.
    const files = [
      ...sectionFiles.map((file) => `pro-test/src/welcome/${file}`),
      'pro-test/src/components/Footer.tsx',
      'pro-test/src/components/LegalFooterNav.tsx',
    ];
    const aboutDocsPath = readRepo('shared/press.ts').match(/export const ABOUT_DOCS_PATH = '([^']+)'/)?.[1];
    assert.equal(aboutDocsPath, '/docs/about');
    const legalSource = readRepo('shared/legal.ts');
    const legalBlock = legalSource.match(/export const LEGAL_FOOTER_LINKS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1];
    assert.ok(legalBlock, 'LEGAL_FOOTER_LINKS extraction found nothing');
    const legalPaths = [...legalBlock.matchAll(/path:\s*([A-Z_]+)/g)].map((match) => {
      const path = legalSource.match(new RegExp(`export const ${match[1]} = '([^']+)'`))?.[1];
      assert.ok(path, `${match[1]} has no string path`);
      return path;
    });
    assert.ok(legalPaths.length >= 5, `expected the legal footer paths, saw ${legalPaths.length}`);
    const violations = [];
    let scanned = 0;
    for (const file of files) {
      const source = readFileSync(join(repoRoot, file), 'utf8').replaceAll('ABOUT_DOCS_PATH', aboutDocsPath);
      // DASHBOARD_PATH is the one template hole in these hrefs and always
      // expands to a path, so substituting it keeps the URL parseable. Both
      // spellings are matched: `href={DASHBOARD_PATH}` is the shape every CTA
      // took once #8603 dropped its query, and requiring the interpolated
      // `${DASHBOARD_PATH}` form alone made this scan skip all twelve of them.
      const targets = welcomeHrefTargets(source);
      // LegalFooterNav stores the href on the shared link list, not next to
      // the JSX attribute, so the regex above sees nothing in that file.
      if (source.includes('href={link.path}')) targets.push(...legalPaths);
      for (const target of targets) {
        let url;
        try {
          url = new URL(target, WWW_ORIGIN);
        } catch {
          continue;
        }
        if (!/(^|\.)worldmonitor\.app$/.test(url.hostname)) continue;
        scanned += 1;
        violations.push(...linkViolations(
          { page: file, href: target, url },
          context,
        ));
      }
    }
    // Exact, not a floor: the twelve dashboard CTAs plus the other same-site
    // hrefs these sections publish. A CTA that drops out of the scan — moved
    // behind a helper, or re-pointed at a host this regex does not spell —
    // reads as covered under a floor. tests/deploy-config.test.mjs pins the
    // twelve dashboard CTAs by shape; this pins every welcome href by URL
    // semantics, which is what catches a bare variant host or a redirect
    // source that a tail-only shape check cannot see.
    // 33 welcome-section hrefs, 10 Footer anchors (including status.worldmonitor.app),
    // and the 5 LEGAL_FOOTER_LINKS paths. Exact, so a footer href that drops
    // out of the scan does not hide behind the section count.
    assert.equal(scanned, 48, `expected every welcome same-site href to be scanned, saw ${scanned}`);
    assert.deepEqual(violations, [], `${violations.length} welcome links do not answer 200:\n${violations.join('\n')}`);
  });

  // Positive control. Every rule above currently has nothing to catch, so
  // without this the whole file would keep passing after a refactor silently
  // disarmed one of them. Each case is a shape middleware really does 308,
  // and the middle two are the ones a Set-only reading of
  // INDEX_NOISE_QUERY_KEYS cannot see.
  it('fires on every bot-308 and 404 shape it claims to cover', async () => {
    const { context } = await corpusFixture();
    const reasonFor = (href) => {
      const url = new URL(href, WWW_ORIGIN);
      return linkViolations({ page: 'probe', href, url }, context)
        .map((line) => line.replace('probe: ', ''));
    };
    const cases = [
      ['/dashboard?utm_source=x', /index-noise query key\(s\) utm_source/],
      // Absent from the Set; middleware drops it by prefix. A standard Google
      // Ads param, so this is the realistic drift case, not a contrived one.
      ['/dashboard?utm_id=abc', /utm_\* query key\(s\) utm_id that middleware strips by prefix/],
      // Legacy root deep link: pathname `/` plus any bounded map-state key.
      ['/?country=US', /legacy root deep link \(country\)/],
      ['https://tech.worldmonitor.app', /links a bare variant host/],
      ['/docs', /matches a vercel\.json redirect/],
      ['/api-reference/supplychainservice/listfuelshortages', /matches a vercel\.json redirect/],
      // `:match*` is zero or more segments. A pattern that requires the slash
      // misses the bare prefix, which still 308s.
      ['/api-reference', /matches a vercel\.json redirect/],
      ['/zh', /matches a vercel\.json redirect/],
      ['/zh/terms', /matches a vercel\.json redirect/],
      ['https://tech.worldmonitor.app/sources/geopolitics/', /matches a vercel\.json redirect/],
      ['https://api.worldmonitor.app', /matches a vercel\.json redirect/],
      ['/corrections', /rootless docs path 308s to \/docs\/corrections/],
      ['/countries/norway', /slashless form of a slash-normalised corpus route/],
      ['/countries/not-a-country/', /resolves to no published route \(404\)/],
      ['/docs/not-a-page', /resolves to no published route \(404\)/],
    ];
    for (const [href, expected] of cases) {
      const reasons = reasonFor(href);
      assert.ok(
        reasons.some((reason) => expected.test(reason)),
        `${href} must be rejected by ${expected} — got ${JSON.stringify(reasons)}`,
      );
    }
    assert.equal(context.slashlessCorpusForms.has('/countries/norway'), true);
    assert.equal(context.slashlessCorpusForms.has('/sources/geopolitics'), false);
    assert.equal(context.slashlessCorpusForms.has('/reference/changelog/page/2'), false);
    // Negative control: the shapes that legitimately answer 200 must stay
    // silent, or the rules above would pass by rejecting everything.
    for (const href of [
      '/dashboard',
      '/dashboard?country=NO&expanded=1',
      '/pro?wm_content_source=worldmonitor-use-cases',
      'https://tech.worldmonitor.app/dashboard',
      'https://tech.worldmonitor.app/?mode=agent',
      '/countries/norway/',
      '/docs/algorithms',
      '/docs/corrections',
      '/docs/api-reference/supplychainservice/listfuelshortages',
      '/blog/glossary/suez-canal/',
      '/llms.txt',
      '/api/product-catalog',
    ]) {
      assert.deepEqual(reasonFor(href), [], `${href} answers 200 and must not be rejected`);
    }
  });
});
