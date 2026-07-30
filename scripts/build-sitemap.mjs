#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTENT_CORPUS_PREFIXES,
  discoverContentCorpusPages,
} from './discover-content-corpus-pages.mjs';

export const SITE_ORIGIN = 'https://www.worldmonitor.app';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const DASHBOARD_MATERIAL_SOURCES = [
  'index.html',
  'src/App.ts',
  'src/app',
  'src/components',
  'src/config',
  'src/locales',
  'src/styles',
];

const route = (loc, family, materialSources) => ({
  loc,
  family,
  owner: 'root',
  materialSources,
});

/**
 * Canonical root-sitemap inventory.
 *
 * Blog URLs belong to Astro's /blog/sitemap-index.xml and documentation URLs
 * belong to Mintlify's /docs/sitemap.xml. Keep those page families out of this
 * manifest so their publishers remain the only inventory owners.
 *
 * materialSources are deliberately content-bearing repository paths. Their
 * latest Git commit date is the route's lastmod; build/deploy time is never an
 * input. In build contexts without complete Git history, the committed
 * generated sitemap is the deterministic fallback.
 */
export const STATIC_ROUTE_MANIFEST = Object.freeze([
  route(`${SITE_ORIGIN}/`, 'landing', [
    'pro-test/welcome.html',
    'pro-test/src/WelcomeApp.tsx',
    'pro-test/src/welcome',
    'pro-test/src/index.css',
    'pro-test/src/generated',
    'src/config/products.ts',
  ]),
  route(`${SITE_ORIGIN}/dashboard`, 'dashboard', [
    ...DASHBOARD_MATERIAL_SOURCES,
    'src/config/variants/full.ts',
  ]),
  route(`${SITE_ORIGIN}/pro`, 'product', [
    'pro-test/index.html',
    'pro-test/src/App.tsx',
    'pro-test/src/components',
    'pro-test/src/generated',
    'pro-test/src/i18n.ts',
    'pro-test/src/index.css',
    'pro-test/src/locales',
    'src/config/products.ts',
  ]),
  route(`${SITE_ORIGIN}/pricing.md`, 'machine-readable-product', ['public/pricing.md']),
  route(`${SITE_ORIGIN}/support.md`, 'machine-readable-product', ['public/support.md']),
  route(`${SITE_ORIGIN}/ai-search.md`, 'machine-readable-product', ['public/ai-search.md']),
  route(`${SITE_ORIGIN}/developers.md`, 'machine-readable-developer', ['public/developers.md']),
  route(`${SITE_ORIGIN}/mcp-server.md`, 'machine-readable-developer', ['public/mcp-server.md']),
  route(`${SITE_ORIGIN}/openapi.md`, 'machine-readable-developer', ['public/openapi.md']),
  route(`${SITE_ORIGIN}/sdks.md`, 'machine-readable-developer', ['public/sdks.md']),
  route(`${SITE_ORIGIN}/llms.txt`, 'machine-readable-developer', ['public/llms.txt']),
  route(`${SITE_ORIGIN}/llms-full.txt`, 'machine-readable-developer', ['public/llms-full.txt']),
  route(`${SITE_ORIGIN}/api/llms.txt`, 'machine-readable-developer', ['public/api/llms.txt']),
  route('https://tech.worldmonitor.app/dashboard', 'dashboard-variant', [
    ...DASHBOARD_MATERIAL_SOURCES,
    'src/config/variants/tech.ts',
  ]),
  route('https://finance.worldmonitor.app/dashboard', 'dashboard-variant', [
    ...DASHBOARD_MATERIAL_SOURCES,
    'src/config/variants/finance.ts',
  ]),
  route('https://commodity.worldmonitor.app/dashboard', 'dashboard-variant', [
    ...DASHBOARD_MATERIAL_SOURCES,
    'src/config/variants/commodity.ts',
  ]),
  route('https://happy.worldmonitor.app/dashboard', 'dashboard-variant', [
    ...DASHBOARD_MATERIAL_SOURCES,
    'src/config/variants/happy.ts',
  ]),
  route('https://energy.worldmonitor.app/dashboard', 'dashboard-variant', [
    ...DASHBOARD_MATERIAL_SOURCES,
    'src/config/variants/energy.ts',
  ]),
]);

const STATIC_LOCATIONS = new Set(STATIC_ROUTE_MANIFEST.map((entry) => entry.loc));
const ALLOWED_HOSTS = new Set(STATIC_ROUTE_MANIFEST.map((entry) => new URL(entry.loc).hostname));
const CORPUS_PATH_PREFIXES = CONTENT_CORPUS_PREFIXES.map((prefix) => `/${prefix}/`);

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const unescapeXml = (value) => String(value)
  .replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/&amp;/g, '&');

const isIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

const laterDate = (...values) => values
  .filter(isIsoDate)
  .sort()
  .at(-1) ?? null;

export function parseExistingSitemapLastmods(source) {
  const dates = new Map();
  for (const match of String(source ?? '').matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g)) {
    const loc = match[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = match[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    if (loc && isIsoDate(lastmod)) dates.set(unescapeXml(loc), lastmod);
  }
  return dates;
}

// Git's local env vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...) override
// `cwd`, so a build running inside a git hook would silently resolve these
// queries against the hook's repository instead of the repoRoot it was given.
// Strip them, and render dates in UTC (see gitLastmod).
let gitLocalEnvVars = null;
function gitEnvForRoot() {
  if (gitLocalEnvVars === null) {
    try {
      gitLocalEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n');
    } catch {
      gitLocalEnvVars = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];
    }
  }
  const env = { ...process.env, TZ: 'UTC' };
  for (const name of gitLocalEnvVars) delete env[name];
  return env;
}

function gitLastmod(repoRoot, materialSources) {
  try {
    // Render the committer date in UTC, not the commit's recorded timezone:
    // %cs of a commit recorded at 01:21+04:00 reads as "tomorrow" relative to
    // a UTC build clock, and the future-lastmod guard would reject it even
    // though the commit is in the past (Vercel deploy failure, 2026-07-27).
    const value = execFileSync(
      'git',
      ['log', '-1', '--date=format-local:%Y-%m-%d', '--format=%cd', '--', ...materialSources],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: gitEnvForRoot(),
      },
    ).trim();
    return isIsoDate(value) ? value : null;
  } catch {
    return null;
  }
}

function hasCompleteGitHistory(repoRoot) {
  try {
    return execFileSync(
      'git',
      ['rev-parse', '--is-shallow-repository'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: gitEnvForRoot(),
      },
    ).trim() === 'false';
  } catch {
    return false;
  }
}

function assertMaterialSourcesExist(repoRoot, manifestEntry) {
  for (const sourcePath of manifestEntry.materialSources) {
    if (!existsSync(join(repoRoot, sourcePath))) {
      throw new Error(`${manifestEntry.loc} material source does not exist: ${sourcePath}`);
    }
  }
}

export function createMaterialLastmodResolver({
  repoRoot = REPO_ROOT,
  existingSitemapSource = '',
} = {}) {
  const existingLastmods = parseExistingSitemapLastmods(existingSitemapSource);
  const canResolveGitLastmods = hasCompleteGitHistory(repoRoot);
  return (manifestEntry) => (
    (canResolveGitLastmods ? gitLastmod(repoRoot, manifestEntry.materialSources) : null)
    ?? existingLastmods.get(manifestEntry.loc)
    ?? null
  );
}

export function validateSitemapEntries(entries, { today = TODAY } = {}) {
  if (!isIsoDate(today)) throw new Error(`validation today must be YYYY-MM-DD, saw ${today}`);

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.loc)) throw new Error(`duplicate sitemap URL: ${entry.loc}`);
    seen.add(entry.loc);

    let url;
    try {
      url = new URL(entry.loc);
    } catch {
      throw new Error(`malformed sitemap URL: ${entry.loc}`);
    }

    if (url.protocol !== 'https:') throw new Error(`sitemap URL must use https: ${entry.loc}`);
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`sitemap URL uses an inconsistent host: ${entry.loc}`);
    }
    if (url.username || url.password || url.port) {
      throw new Error(`sitemap URL must not include credentials or a port: ${entry.loc}`);
    }
    if (url.search || url.hash) {
      throw new Error(`canonical sitemap URL must not include a query or fragment: ${entry.loc}`);
    }
    if (url.href !== entry.loc) {
      throw new Error(`sitemap URL is not in canonical form: ${entry.loc}`);
    }

    if (entry.family === 'content-corpus') {
      if (
        !url.pathname.endsWith('/')
        || !CORPUS_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
      ) {
        throw new Error(`content-corpus URL has a noncanonical trailing slash form: ${entry.loc}`);
      }
    } else if (!STATIC_LOCATIONS.has(entry.loc)) {
      throw new Error(`static sitemap URL is not in the canonical route manifest: ${entry.loc}`);
    }

    if (!isIsoDate(entry.lastmod)) {
      throw new Error(`${entry.loc} lastmod must be a real YYYY-MM-DD date`);
    }
    if (entry.lastmod > today) {
      throw new Error(`${entry.loc} has a future lastmod ${entry.lastmod}`);
    }
  }

  return entries;
}

export function buildSitemapEntries({
  repoRoot = REPO_ROOT,
  publicDir = join(repoRoot, 'public'),
  existingSitemapSource = existsSync(join(publicDir, 'sitemap.xml'))
    ? readFileSync(join(publicDir, 'sitemap.xml'), 'utf8')
    : '',
  resolveMaterialLastmod = createMaterialLastmodResolver({
    repoRoot,
    existingSitemapSource,
  }),
  requireCompleteCorpus = true,
  today = TODAY,
} = {}) {
  const existingLastmods = parseExistingSitemapLastmods(existingSitemapSource);
  const entries = STATIC_ROUTE_MANIFEST.map((manifestEntry) => {
    assertMaterialSourcesExist(repoRoot, manifestEntry);
    return {
      loc: manifestEntry.loc,
      lastmod: resolveMaterialLastmod(manifestEntry),
      family: manifestEntry.family,
      owner: manifestEntry.owner,
    };
  });

  const corpusPages = discoverContentCorpusPages({ publicDir });
  if (requireCompleteCorpus) {
    for (const prefix of ['/countries/', '/chokepoints/', '/crises/', '/tools/', '/research/', '/reference/']) {
      if (!corpusPages.some((page) => new URL(page.loc).pathname.startsWith(prefix))) {
        throw new Error(
          `generated content corpus is incomplete: no ${prefix} pages; `
          + 'run npm run build:crawlable-corpus before npm run build:sitemap',
        );
      }
    }
  }

  for (const page of corpusPages) {
    entries.push({
      loc: page.loc,
      lastmod: laterDate(page.lastmod, existingLastmods.get(page.loc)),
      family: 'content-corpus',
      owner: 'root',
    });
  }

  validateSitemapEntries(entries, { today });
  return entries;
}

export function generateSitemapXml(entries) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <!-- Generated by npm run build:sitemap. Do not edit by hand. -->',
  ];

  for (const entry of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    lines.push(`    <lastmod>${entry.lastmod}</lastmod>`);
    lines.push('  </url>');
  }

  lines.push('</urlset>', '');
  return lines.join('\n');
}

export function buildSitemap({
  repoRoot = REPO_ROOT,
  publicDir = join(repoRoot, 'public'),
  sitemapPath = join(publicDir, 'sitemap.xml'),
  check = false,
  today = TODAY,
} = {}) {
  const current = existsSync(sitemapPath) ? readFileSync(sitemapPath, 'utf8') : '';
  const entries = buildSitemapEntries({
    repoRoot,
    publicDir,
    existingSitemapSource: current,
    today,
  });
  const next = generateSitemapXml(entries);
  const changed = next !== current;

  if (check && changed) {
    throw new Error('public/sitemap.xml is out of date; run npm run build:sitemap');
  }
  if (!check && changed) writeFileSync(sitemapPath, next);
  return { entries, changed, source: next };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const check = process.argv.slice(2).includes('--check');
    const { entries, changed } = buildSitemap({ check });
    const verb = check ? 'verified' : changed ? 'updated' : 'checked';
    console.log(`[sitemap] ${verb} public/sitemap.xml with ${entries.length} canonical URL(s)`);
  } catch (error) {
    console.error(`[sitemap] ${error?.message ?? error}`);
    process.exit(1);
  }
}
