/**
 * Search links: the "Related" block at the end of a generated landing page,
 * chosen by which pages Google shows for the same query.
 *
 * Data shape: a ledger maps a source page path to at most five `{ href, anchor }`
 * links and lists the `(source, href)` pairs the owner struck, one ledger per
 * source family (the path's first segment), because the build reads it one page
 * at a time and a family's lastmod should move only when its own links do.
 *
 * Owner rules, as encoded below. The target of a query is the page with the most
 * impressions for it and the anchor is the query. Every other generated landing
 * page Google showed for that query is a source. A page carries at most five
 * links, a target once, never itself. Targets ranking 4-15 for the query come
 * first. Struck pairs are never proposed again.
 *
 * Pure module: no file or network access. scripts/search-links.mjs reads the
 * files and owns the CLI.
 */
import { SITE_ORIGIN } from '../discover-content-corpus-pages.mjs';
import { liveTopicPageForPath } from '../live-pages/index.mjs';

/** Generated landing-page families that carry a search-links block. */
export const SEARCH_LINK_FAMILIES = Object.freeze([
  'countries',
  'country-instability-index',
  'chokepoints',
  'crises',
  'monitor-the-situation',
  'tools',
  'use-cases',
]);
export const MAX_SEARCH_LINKS = 5;
export const MAX_ANCHOR_WORDS = 10;
const PREFERRED_POSITIONS = Object.freeze({ min: 4, max: 15 });

/**
 * Links another module already decides. A search link of one of these shapes
 * would contradict that module (and the tests that pin its negatives), so the
 * selector skips it and the ledger loader rejects it.
 *
 * | source      | target      | owner                                                        |
 * |-------------|-------------|--------------------------------------------------------------|
 * | countries   | countries   | country-related-links.mjs, peer links in renderCountryAnalysis |
 * | countries   | chokepoints | shared/chokepoint-countries.js                               |
 * | countries   | crises      | formatCrisisContext in renderCountryAnalysis                 |
 * | chokepoints | countries   | shared/chokepoint-countries.js                               |
 * | chokepoints | crises      | crisisSlugs in chokepoint-page-content.mjs                   |
 * | crises      | countries   | crisis coverage in shared/crawlable-crises.json              |
 * | crises      | chokepoints | crisisSlugs in chokepoint-page-content.mjs                   |
 * | any of them | live tool   | live-pages/related-links.mjs                                 |
 */
const OWNED_SHAPES = Object.freeze([
  { source: 'countries', target: 'countries', owner: 'scripts/country-related-links.mjs and the peer links in renderCountryAnalysis' },
  { source: 'countries', target: 'chokepoints', owner: 'shared/chokepoint-countries.js' },
  { source: 'countries', target: 'crises', owner: 'formatCrisisContext in renderCountryAnalysis' },
  { source: 'countries', target: 'live-tool', owner: 'scripts/live-pages/related-links.mjs' },
  { source: 'chokepoints', target: 'countries', owner: 'shared/chokepoint-countries.js' },
  { source: 'chokepoints', target: 'crises', owner: 'crisisSlugs in scripts/chokepoint-page-content.mjs' },
  { source: 'chokepoints', target: 'live-tool', owner: 'scripts/live-pages/related-links.mjs' },
  { source: 'crises', target: 'countries', owner: 'the crisis coverage in shared/crawlable-crises.json' },
  { source: 'crises', target: 'chokepoints', owner: 'crisisSlugs in scripts/chokepoint-page-content.mjs' },
  { source: 'crises', target: 'live-tool', owner: 'scripts/live-pages/related-links.mjs' },
]);
const OWNER_BY_SHAPE = new Map(OWNED_SHAPES.map((shape) => [`${shape.source} ${shape.target}`, shape.owner]));

const BARE_PATH = /^\/(?!\/)[^\s?#]*$/;
const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/** The family a generated landing page belongs to, or null. */
export function familyOf(path) {
  const segment = /^\/([^/]+)/.exec(path)?.[1];
  return SEARCH_LINK_FAMILIES.includes(segment) ? segment : null;
}

const targetKind = (path) => (liveTopicPageForPath(path) ? 'live-tool' : familyOf(path));

const isFamilyHub = (path) => familyOf(path) !== null && path === `/${familyOf(path)}/`;

/**
 * The module that already decides links of this shape, or null. The owners
 * relate detail pages to each other, so a link to or from a family hub is open.
 */
export function ownerOf(sourcePath, href) {
  if (isFamilyHub(sourcePath) || isFamilyHub(href)) return null;
  return OWNER_BY_SHAPE.get(`${familyOf(sourcePath)} ${targetKind(href)}`) ?? null;
}

/** Every route the corpus manifest declares. */
export function manifestRoutes(manifest) {
  return new Set(Object.values(manifest.sections).flatMap((section) => [
    section.index,
    ...(section.routes ?? []),
    ...(section.paginationRoutes ?? []),
  ]));
}

/** An href as the www path it points at, or null for another origin. */
function sitePath(rawHref) {
  const href = rawHref
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  let url;
  try {
    url = new URL(href, SITE_ORIGIN);
  } catch {
    return null;
  }
  return url.origin === SITE_ORIGIN ? url.pathname : null;
}

/**
 * The www paths an HTML fragment links, fragments and query strings dropped.
 * A search-links block is left out, so a rerun does not count the ledger's own
 * links as links the page already had.
 */
export function linkedPaths(html) {
  const withoutBlock = html.replace(/<section data-search-links>[\s\S]*?<\/section>/g, '');
  const paths = new Set();
  for (const [, href] of withoutBlock.matchAll(/\shref="([^"]*)"/g)) {
    const path = sitePath(href);
    if (path !== null) paths.add(path);
  }
  return paths;
}

/** The inside of a built page's `<main>`. */
export function mainOf(document) {
  const match = /<main>([\s\S]*?)<\/main>/.exec(document);
  if (!match) throw new Error('page has no <main>');
  return match[1];
}

/**
 * The snapshot's `performance.queryPages` rows. This is the boundary: anything
 * the selector reads is checked here once.
 */
export function readQueryPages(snapshot, label = 'snapshot') {
  const list = snapshot?.performance?.queryPages;
  if (!list) throw new Error(`${label} has no performance.queryPages; the weekly Search Console collector adds it`);
  if (list.status !== 'available') throw new Error(`${label} queryPages is ${list.status}: ${list.reason}`);
  return list.rows.map((row) => {
    const paths = new Set();
    const pages = (row.pages ?? []).map((page) => {
      const valid = typeof page?.path === 'string' && BARE_PATH.test(page.path)
        && Number.isFinite(page.impressions) && (page.position === null || Number.isFinite(page.position));
      if (!valid || paths.has(page.path)) throw new Error(`${label}: "${row.query}" has a malformed or repeated page`);
      paths.add(page.path);
      return { path: page.path, impressions: page.impressions, position: page.position };
    });
    if (typeof row.query !== 'string' || !row.query.trim() || pages.length === 0) {
      throw new Error(`${label}: a queryPages row has no query or no page`);
    }
    for (let index = 1; index < pages.length; index += 1) {
      if (pages[index].impressions > pages[index - 1].impressions) {
        throw new Error(`${label}: "${row.query}" pages are not ordered by impressions`);
      }
    }
    if (typeof row.likelyAutomated !== 'boolean') {
      throw new Error(`${label}: "${row.query}" has no likelyAutomated flag, so automated searches cannot be set aside`);
    }
    return { query: row.query, likelyAutomated: row.likelyAutomated, pages };
  });
}

const anchorFor = (query) => query.charAt(0).toUpperCase() + query.slice(1);
const inPreferredBand = (position) => position !== null
  && position >= PREFERRED_POSITIONS.min && position <= PREFERRED_POSITIONS.max;
const byPriority = (left, right) => left.tier - right.tier
  || right.targetImpressions - left.targetImpressions
  || right.sourceImpressions - left.sourceImpressions
  || left.query.localeCompare(right.query, 'en-US');

/**
 * Propose every page's links from the query evidence.
 *
 * `sources` maps each built landing page to the paths its `<main>` already
 * links; `resolves` says whether a target is a page the site publishes.
 * Queries flagged `likelyAutomated` are set aside, as the snapshot README
 * says, because their impressions are not people.
 *
 * Returns the chosen links in priority order, each with its evidence.
 */
export function selectSearchLinks({ queryPages, sources, exclusions = [], resolves }) {
  const struck = new Set(exclusions.map(({ source, href }) => `${source} ${href}`));
  const candidates = [];
  for (const { query, likelyAutomated, pages } of queryPages) {
    if (likelyAutomated || wordCount(query) > MAX_ANCHOR_WORDS) continue;
    const [target, ...others] = pages;
    if (!resolves(target.path)) continue;
    for (const source of others) {
      const linked = sources.get(source.path);
      if (!linked || linked.has(target.path) || ownerOf(source.path, target.path)) continue;
      if (struck.has(`${source.path} ${target.path}`)) continue;
      candidates.push({
        source: source.path,
        href: target.path,
        anchor: anchorFor(query),
        query,
        tier: inPreferredBand(target.position) ? 0 : 1,
        targetPosition: target.position,
        targetImpressions: target.impressions,
        sourceImpressions: source.impressions,
      });
    }
  }
  const chosen = [];
  const perSource = new Map();
  for (const candidate of candidates.sort(byPriority)) {
    const hrefs = perSource.get(candidate.source) ?? new Set();
    if (hrefs.size >= MAX_SEARCH_LINKS || hrefs.has(candidate.href)) continue;
    hrefs.add(candidate.href);
    perSource.set(candidate.source, hrefs);
    chosen.push(candidate);
  }
  return chosen;
}

/** Group chosen links into one ledger per family, every family present. */
export function buildLedgers(chosen, { snapshot, exclusionsByFamily = {} }) {
  const ledgers = Object.fromEntries(SEARCH_LINK_FAMILIES.map((family) => [family, {
    snapshot: null,
    pages: {},
    exclusions: exclusionsByFamily[family] ?? [],
  }]));
  for (const link of chosen) {
    const ledger = ledgers[familyOf(link.source)];
    ledger.snapshot = snapshot;
    (ledger.pages[link.source] ??= []).push({ href: link.href, anchor: link.anchor });
  }
  for (const ledger of Object.values(ledgers)) {
    ledger.pages = Object.fromEntries(Object.entries(ledger.pages).sort(([left], [right]) => left.localeCompare(right, 'en-US')));
  }
  return ledgers;
}

export const formatLedger = (ledger) => `${JSON.stringify(ledger, null, 2)}\n`;

/** The `(source, href)` pairs the owner struck from one family's proposals. */
export function parseExclusions(family, exclusions, label = `scripts/data/search-links/${family}.json`) {
  if (!Array.isArray(exclusions)) throw new Error(`${label}: exclusions must be an array`);
  for (const exclusion of exclusions) {
    if (familyOf(exclusion?.source) !== family || !BARE_PATH.test(exclusion?.href ?? '')) {
      throw new Error(`${label}: exclusion ${JSON.stringify(exclusion)} needs a ${family} source and a bare href`);
    }
  }
  return exclusions.map(({ source, href }) => ({ source, href }));
}

/**
 * Validate one family's ledger and return source path -> links. Throws on
 * anything the build would otherwise render wrong: a malformed row, a dead or
 * non-bare href, a self link, a repeated href, more than five links, a link of
 * an owned shape, a struck link, or a source outside the family.
 */
export function parseLedger(family, ledger, { resolves, label = `scripts/data/search-links/${family}.json` }) {
  const fail = (message) => {
    throw new Error(`${label}: ${message}; rerun node scripts/search-links.mjs`);
  };
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) fail('must be an object');
  const { snapshot, pages, exclusions } = ledger;
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) fail('pages must be an object');
  const entries = Object.entries(pages);
  if (snapshot !== null && typeof snapshot !== 'string') fail('snapshot must be a path or null');
  if (entries.length > 0 && typeof snapshot !== 'string') fail('a ledger with links must name its snapshot');
  const struck = new Set(parseExclusions(family, exclusions, label).map(({ source, href }) => `${source} ${href}`));
  const out = new Map();
  for (const [source, rows] of entries) {
    if (familyOf(source) !== family) fail(`${source} is not a ${family} page`);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_SEARCH_LINKS) {
      fail(`${source} must list 1-${MAX_SEARCH_LINKS} links`);
    }
    const hrefs = new Set();
    for (const row of rows) {
      const { href, anchor } = row ?? {};
      if (typeof href !== 'string' || !BARE_PATH.test(href)) fail(`${source} links ${JSON.stringify(href)}, not a bare path`);
      if (typeof anchor !== 'string' || !anchor.trim() || wordCount(anchor) > MAX_ANCHOR_WORDS) {
        fail(`${source} -> ${href} needs an anchor of 1-${MAX_ANCHOR_WORDS} words`);
      }
      if (href === source) fail(`${source} links itself`);
      if (hrefs.has(href)) fail(`${source} links ${href} twice`);
      const owner = ownerOf(source, href);
      if (owner) fail(`${source} -> ${href} is decided by ${owner}`);
      if (struck.has(`${source} ${href}`)) fail(`${source} -> ${href} is struck in exclusions`);
      if (!resolves(href)) fail(`${source} links ${href}, which the site does not publish`);
      hrefs.add(href);
    }
    out.set(source, rows.map(({ href, anchor }) => ({ href, anchor })));
  }
  return out;
}

/**
 * The search-links block for one page, or '' when nothing survives. `mainHtml`
 * is the page's composed `<main>`, so a target the page already links, a self
 * link and anything past five are dropped here whatever the ledger says.
 */
export function placeSearchLinks(mainHtml, path, rows, escapeHtml) {
  if (!rows?.length) return '';
  const linked = linkedPaths(mainHtml);
  const kept = rows.filter((row) => row.href !== path && !linked.has(row.href)).slice(0, MAX_SEARCH_LINKS);
  if (kept.length === 0) return '';
  return `      <section data-search-links>
      <h2>Related</h2>
      <ul class="related">
${kept.map((row) => `        <li><a href="${escapeHtml(row.href)}">${escapeHtml(row.anchor)}</a></li>`).join('\n')}
      </ul>
      </section>`;
}
