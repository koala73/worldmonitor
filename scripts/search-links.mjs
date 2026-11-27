#!/usr/bin/env node
/**
 * Propose and load the search-links ledgers (scripts/lib/search-links.mjs has
 * the rules).
 *
 *   npm run build:crawlable-corpus
 *   node scripts/search-links.mjs                 # print the proposal table
 *   node scripts/search-links.mjs --write         # rewrite changed ledgers
 *   node scripts/search-links.mjs --snapshot docs/research/seo-ai-visibility/gsc/<date>.json
 *
 * The evidence is a committed weekly Search Console snapshot, so a proposal can
 * be rerun from the repository alone and needs no credential. The default is the
 * newest committed snapshot that carries `performance.queryPages`. To strike a
 * proposed link, add `{ "source", "href" }` to that family's `exclusions` and
 * rerun with --write.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';
import {
  SEARCH_LINK_FAMILIES,
  buildLedgers,
  familyOf,
  formatLedger,
  linkedPaths,
  mainOf,
  manifestRoutes,
  parseExclusions,
  parseLedger,
  readQueryPages,
  selectSearchLinks,
} from './lib/search-links.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = 'docs/research/seo-ai-visibility/gsc';

export const searchLinksPath = (family) => `scripts/data/search-links/${family}.json`;

/**
 * Mintlify serves every docs page file that docs/.mintignore does not exclude.
 * The file holds only exact paths and `dir/` prefixes.
 */
function createDocsPageResolver(rootDir) {
  const ignoreFile = join(rootDir, 'docs/.mintignore');
  const patterns = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : [];
  if (patterns.some((pattern) => /[*?[\]!]/.test(pattern))) throw new Error('docs/.mintignore gained a glob; teach search-links to match it');
  return (href) => {
    if (!/^\/docs\/[a-z0-9][a-z0-9/-]*$/.test(href)) return false;
    const page = href.slice('/docs/'.length);
    return ['.mdx', '.md'].some((ext) => existsSync(join(rootDir, 'docs', `${page}${ext}`))
      && !patterns.some((pattern) => (pattern.endsWith('/') ? page.startsWith(pattern) : pattern === `${page}${ext}`)));
  };
}

/** True for a page the site publishes: a corpus route, a blog post or a docs page. */
export function createTargetResolver({ rootDir, manifest, blogPostPaths }) {
  const routes = manifestRoutes(manifest);
  const docsPageExists = createDocsPageResolver(rootDir);
  return (href) => routes.has(href) || blogPostPaths.has(href) || docsPageExists(href);
}

export function blogPostPathsIn(rootDir) {
  return new Set(readdirSync(join(rootDir, 'blog-site/src/content/blog'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `/blog/posts/${file.slice(0, -3)}/`));
}

function readLedgerFiles(rootDir) {
  const ledgers = {};
  for (const family of SEARCH_LINK_FAMILIES) {
    const file = join(rootDir, searchLinksPath(family));
    if (!existsSync(file)) continue;
    try {
      ledgers[family] = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${searchLinksPath(family)} is not valid JSON: ${error.message}`);
    }
  }
  return ledgers;
}

/** Source page path -> links, every ledger validated. A missing file is empty. */
export function loadSearchLinks({ rootDir, resolves }) {
  const links = new Map();
  for (const [family, ledger] of Object.entries(readLedgerFiles(rootDir))) {
    for (const [source, rows] of parseLedger(family, ledger, { resolves })) links.set(source, rows);
  }
  return links;
}

// A pre-push hook exports GIT_DIR, which would override -C and read another repository.
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (rootDir, args) => execFileSync('git', ['-C', rootDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });

/** A repository path whose committed content is what is on disk. */
function isCommitted(rootDir, path) {
  try {
    git(rootDir, ['ls-files', '--error-unmatch', '--', path]);
    git(rootDir, ['diff', '--quiet', 'HEAD', '--', path]);
    return true;
  } catch {
    return false;
  }
}

function resolveSnapshot(rootDir, requested) {
  if (requested) {
    const path = relative(rootDir, resolve(rootDir, requested));
    if (path.startsWith('..') || isAbsolute(path)) throw new Error(`--snapshot ${requested} is outside the repository`);
    if (!isCommitted(rootDir, path)) throw new Error(`--snapshot ${path} is not committed as it is on disk`);
    return { path, snapshot: JSON.parse(readFileSync(join(rootDir, path), 'utf8')) };
  }
  const names = readdirSync(join(rootDir, SNAPSHOT_DIR))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of names) {
    const path = `${SNAPSHOT_DIR}/${name}`;
    if (!isCommitted(rootDir, path)) continue;
    const snapshot = JSON.parse(readFileSync(join(rootDir, path), 'utf8'));
    if (snapshot.performance?.queryPages?.status === 'available') return { path, snapshot };
  }
  throw new Error(`no committed snapshot in ${SNAPSHOT_DIR} carries performance.queryPages yet; the weekly Search Console collector adds it`);
}

/** Built landing pages -> the paths their `<main>` already links. */
function readSources(rootDir, manifest) {
  const sources = new Map();
  for (const route of manifestRoutes(manifest)) {
    if (!familyOf(route)) continue;
    const file = join(rootDir, 'public', route, 'index.html');
    // A missing page would drop its links from --write output without a word.
    if (!existsSync(file)) throw new Error(`public${route}index.html is missing; run npm run build:crawlable-corpus first`);
    sources.set(route, linkedPaths(mainOf(readFileSync(file, 'utf8'))));
  }
  return sources;
}

const cell = (value) => String(value ?? 'n/a').replaceAll('|', '\\|');

function renderTable(chosen) {
  const lines = [
    '| source | anchor | target | target position | target impressions | source impressions |',
    '|---|---|---|---|---|---|',
  ];
  const rows = [...chosen].sort((left, right) => left.source.localeCompare(right.source, 'en-US'));
  for (const link of rows) {
    lines.push(`| ${cell(link.source)} | ${cell(link.anchor)} | ${cell(link.href)} | ${cell(link.targetPosition)} | ${link.targetImpressions} | ${link.sourceImpressions} |`);
  }
  return lines.join('\n');
}

// A ledger with no links and no exclusions is not committed: an empty file
// would still move its pages' lastmod.
const isEmptyLedger = (ledger) => !ledger
  || (Object.keys(ledger.pages ?? {}).length === 0 && (ledger.exclusions ?? []).length === 0);

const sameLinks = (left, right) => (isEmptyLedger(right)
  ? !left
  : JSON.stringify({ pages: left?.pages, exclusions: left?.exclusions })
    === JSON.stringify({ pages: right.pages, exclusions: right.exclusions }));

export function parseArgs(argv) {
  const options = { snapshot: null, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') options.write = true;
    else if (arg === '--snapshot') options.snapshot = argv[++index] ?? null;
    else if (arg.startsWith('--snapshot=')) options.snapshot = arg.slice('--snapshot='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.snapshot === '') options.snapshot = null;
  return options;
}

export function runCli(argv, { rootDir = REPO_ROOT, log = console.log } = {}) {
  const options = parseArgs(argv);
  const manifestFile = join(rootDir, 'public/crawlable-corpus.json');
  if (!existsSync(manifestFile)) throw new Error('public/crawlable-corpus.json is missing; run npm run build:crawlable-corpus first');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const { path: snapshotPath, snapshot } = resolveSnapshot(rootDir, options.snapshot);
  const resolves = createTargetResolver({ rootDir, manifest, blogPostPaths: blogPostPathsIn(rootDir) });
  const current = readLedgerFiles(rootDir);
  const exclusionsByFamily = Object.fromEntries(
    Object.entries(current).map(([family, ledger]) => [family, parseExclusions(family, ledger.exclusions ?? [])]),
  );
  const chosen = selectSearchLinks({
    queryPages: readQueryPages(snapshot, snapshotPath),
    sources: readSources(rootDir, manifest),
    exclusions: Object.values(exclusionsByFamily).flat(),
    resolves,
  });
  const ledgers = buildLedgers(chosen, { snapshot: snapshotPath, exclusionsByFamily });
  log(`Search links from ${snapshotPath}: ${chosen.length} links on ${new Set(chosen.map((link) => link.source)).size} pages.`);
  log(renderTable(chosen));
  const changed = SEARCH_LINK_FAMILIES.filter((family) => !sameLinks(current[family], ledgers[family]));
  if (!options.write) {
    log(changed.length ? `Would rewrite: ${changed.map(searchLinksPath).join(', ')}. Rerun with --write.` : 'Every ledger is current.');
    return { chosen, ledgers, changed, written: [] };
  }
  for (const family of changed) {
    const file = join(rootDir, searchLinksPath(family));
    if (isEmptyLedger(ledgers[family])) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, formatLedger(ledgers[family]));
  }
  log(changed.length ? `Wrote ${changed.map(searchLinksPath).join(', ')}.` : 'Every ledger is current.');
  return { chosen, ledgers, changed, written: changed.map(searchLinksPath) };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
