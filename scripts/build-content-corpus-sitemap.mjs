#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_ORIGIN = 'https://www.worldmonitor.app';
export const CONTENT_CORPUS_PREFIXES = ['countries', 'chokepoints', 'reference', 'changelog'];
export const CONTENT_CORPUS_START_MARKER = '<!-- content-corpus:start -->';
export const CONTENT_CORPUS_END_MARKER = '<!-- content-corpus:end -->';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX_METADATA = {
  countries: { changefreq: 'weekly', priority: '0.6' },
  chokepoints: { changefreq: 'daily', priority: '0.7' },
  reference: { changefreq: 'weekly', priority: '0.6' },
  changelog: { changefreq: 'weekly', priority: '0.6' },
};

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const escapeRegExp = (value) => value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

const getAttribute = (tag, name) => {
  const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*("[^"]*"|\\\'[^\\\']*\\\'|[^\\s>]+)', 'i'));
  if (!match) return null;
  const value = match[1];
  return value.replace(/^['"]|['"]$/g, '');
};

const getLinkHref = (html, rel) => {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const relValue = getAttribute(tag, 'rel');
    if (!relValue) continue;
    const relTokens = relValue.toLowerCase().split(/\s+/);
    if (!relTokens.includes(rel.toLowerCase())) continue;
    return getAttribute(tag, 'href');
  }
  return null;
};

const getMetaContent = (html, attrName, attrValue) => {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const value = getAttribute(tag, attrName);
    if (value?.toLowerCase() !== attrValue.toLowerCase()) continue;
    return getAttribute(tag, 'content');
  }
  return null;
};

const getLastmod = (html) => {
  const candidates = [
    getMetaContent(html, 'name', 'lastmod'),
    getMetaContent(html, 'name', 'modified'),
    getMetaContent(html, 'property', 'article:modified_time'),
    getMetaContent(html, 'itemprop', 'dateModified'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const date = candidate.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  }
  return null;
};

const hasNoIndex = (html) => {
  const robots = getMetaContent(html, 'name', 'robots');
  return /(?:^|,)\s*noindex\b/i.test(robots ?? '');
};

const toPublicPath = (relativePath) => {
  const normalized = relativePath.split(sep).join('/');
  if (normalized.endsWith('/index.html')) {
    return '/' + normalized.slice(0, -'index.html'.length);
  }
  return '/' + normalized;
};

const normalizeHref = (href) => new URL(href, SITE_ORIGIN).href;

const walkHtmlFiles = (dir) => {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkHtmlFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(child);
  }
  return files;
};

const assertCanonicalMatchesFile = ({ canonical, relativePath, prefix }) => {
  const url = new URL(canonical);
  if (url.origin !== SITE_ORIGIN) {
    throw new Error(relativePath + ' canonical must use ' + SITE_ORIGIN + ', saw ' + url.origin);
  }
  if (url.search || url.hash) {
    throw new Error(relativePath + ' canonical must not include query or hash');
  }
  if (!(url.pathname === '/' + prefix || url.pathname.startsWith('/' + prefix + '/'))) {
    throw new Error(relativePath + ' canonical must stay under /' + prefix + '/');
  }

  const publicPath = toPublicPath(relativePath);
  const htmlPath = '/' + relativePath.split(sep).join('/');
  const allowedPaths = relativePath.endsWith('/index.html') ? [publicPath] : [htmlPath];
  if (!allowedPaths.includes(url.pathname)) {
    throw new Error(relativePath + ' canonical ' + url.pathname + ' does not match raw static path ' + allowedPaths[0]);
  }
};

const buildPageRecord = ({ file, publicDir }) => {
  const relativePath = relative(publicDir, file);
  const normalizedRelative = relativePath.split(sep).join('/');
  const prefix = normalizedRelative.split('/')[0];
  const html = readFileSync(file, 'utf8');

  if (hasNoIndex(html)) {
    throw new Error(normalizedRelative + ' is noindex but would be added to sitemap');
  }

  const canonicalHref = getLinkHref(html, 'canonical');
  if (!canonicalHref) {
    throw new Error(normalizedRelative + ' is missing a canonical link');
  }

  const canonical = normalizeHref(canonicalHref);
  assertCanonicalMatchesFile({ canonical, relativePath: normalizedRelative, prefix });

  return {
    loc: canonical,
    prefix,
    file: normalizedRelative,
    lastmod: getLastmod(html),
    prevHref: getLinkHref(html, 'prev') ? normalizeHref(getLinkHref(html, 'prev')) : null,
    nextHref: getLinkHref(html, 'next') ? normalizeHref(getLinkHref(html, 'next')) : null,
  };
};

const changelogPageNumber = (page) => {
  const path = new URL(page.loc).pathname;
  if (path === '/reference/changelog/' || path === '/changelog/') return 1;
  const match = path.match(/^\/(?:reference\/)?changelog\/page\/(\d+)\/$/);
  return match ? Number(match[1]) : null;
};

const validateChangelogPagination = (pages) => {
  const byNumber = new Map();
  for (const page of pages) {
    const number = changelogPageNumber(page);
    if (number != null) byNumber.set(number, page);
  }

  const relPaginationImplemented = [...byNumber.values()].some((page) => page.prevHref || page.nextHref);
  if (!relPaginationImplemented) return;

  for (const [number, page] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    const prev = byNumber.get(number - 1);
    const next = byNumber.get(number + 1);
    if (prev && page.prevHref !== prev.loc) {
      throw new Error(page.file + ' missing rel="prev" pagination link to ' + prev.loc);
    }
    if (next && page.nextHref !== next.loc) {
      throw new Error(page.file + ' missing rel="next" pagination link to ' + next.loc);
    }
  }
};

export function discoverContentCorpusPages({ publicDir = join(REPO_ROOT, 'public') } = {}) {
  const pages = [];
  for (const prefix of CONTENT_CORPUS_PREFIXES) {
    const prefixDir = join(publicDir, prefix);
    for (const file of walkHtmlFiles(prefixDir)) {
      pages.push(buildPageRecord({ file, publicDir }));
    }
  }

  pages.sort((a, b) => a.loc.localeCompare(b.loc));
  validateChangelogPagination(pages);
  return pages;
}

export function buildContentCorpusSitemapBlock(pages) {
  const lines = [
    '  ' + CONTENT_CORPUS_START_MARKER,
    '  <!-- Generated by npm run build:content-corpus. Do not edit this block by hand. -->',
  ];

  for (const page of pages) {
    const metadata = PREFIX_METADATA[page.prefix] ?? { changefreq: 'weekly', priority: '0.5' };
    lines.push('  <url>');
    lines.push('    <loc>' + escapeXml(page.loc) + '</loc>');
    if (page.lastmod) lines.push('    <lastmod>' + escapeXml(page.lastmod) + '</lastmod>');
    lines.push('    <changefreq>' + metadata.changefreq + '</changefreq>');
    lines.push('    <priority>' + metadata.priority + '</priority>');
    lines.push('  </url>');
  }

  lines.push('  ' + CONTENT_CORPUS_END_MARKER);
  return lines.join('\n');
}

export function injectContentCorpusSitemapBlock(sitemapSource, pages) {
  const block = '\n' + buildContentCorpusSitemapBlock(pages) + '\n';
  const markerPattern = new RegExp(
    '\\n?\\s*' + escapeRegExp(CONTENT_CORPUS_START_MARKER) + '[\\s\\S]*?' + escapeRegExp(CONTENT_CORPUS_END_MARKER) + '\\s*\\n?',
    'm'
  );

  if (markerPattern.test(sitemapSource)) {
    return sitemapSource.replace(markerPattern, block);
  }

  if (!sitemapSource.includes('</urlset>')) {
    throw new Error('public/sitemap.xml is missing </urlset>');
  }
  return sitemapSource.replace(/\n<\/urlset>\s*$/, block + '</urlset>\n');
}

export function buildContentCorpusSitemap({ publicDir = join(REPO_ROOT, 'public'), sitemapPath = join(publicDir, 'sitemap.xml') } = {}) {
  const pages = discoverContentCorpusPages({ publicDir });
  const current = readFileSync(sitemapPath, 'utf8');
  const next = injectContentCorpusSitemapBlock(current, pages);
  if (next !== current) writeFileSync(sitemapPath, next);
  return { pages, changed: next !== current };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { pages, changed } = buildContentCorpusSitemap();
    const verb = changed ? 'updated' : 'checked';
    console.log('[content-corpus] ' + verb + ' public/sitemap.xml with ' + pages.length + ' generated page(s)');
  } catch (error) {
    console.error('[content-corpus] ' + (error?.message ?? error));
    process.exit(1);
  }
}
