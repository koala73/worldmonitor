#!/usr/bin/env node
// Build a deterministic, static HTML corpus for crawlable pages that should
// live outside the SPA catch-all. Inputs are committed repo data only: no
// network calls, no env files, and no live secrets.

import { execFileSync } from 'node:child_process';

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUT_DIR = join(DEFAULT_ROOT, 'public');
const DEFAULT_BASE_URL = 'https://www.worldmonitor.app';
const RESILIENCE_SNAPSHOT_PATH = 'docs/snapshots/resilience-ranking-2026-05-28.json';
const COUNTRY_NAMES_PATH = 'shared/country-names.json';
const CHOKEPOINT_REGISTRY_PATH = 'src/config/chokepoint-registry.ts';
const GLOSSARY_DATA_PATH = 'blog-site/src/data/glossary.ts';
const CHANGELOG_PATH = 'CHANGELOG.md';
const CHANGELOG_PAGE_SIZE = 2;

const GENERATED_DIRS = [
  'countries',
  'chokepoints',
  'reference/changelog',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function repoPath(rootDir, relativePath) {
  return join(rootDir, relativePath);
}

function readText(rootDir, relativePath) {
  return readFileSync(repoPath(rootDir, relativePath), 'utf8');
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readText(rootDir, relativePath));
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function absoluteUrl(baseUrl, pathname) {
  return `${normalizeBaseUrl(baseUrl)}${pathname}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsonScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
}

function uniqueSlug(preferred, code, seen) {
  const base = slugify(preferred || code);
  const fallback = slugify(code);
  let slug = base || fallback;
  if (!seen.has(slug)) {
    seen.add(slug);
    return slug;
  }
  slug = `${base || 'page'}-${String(code).toLowerCase()}`;
  let i = 2;
  while (seen.has(slug)) {
    slug = `${base || 'page'}-${String(code).toLowerCase()}-${i}`;
    i += 1;
  }
  seen.add(slug);
  return slug;
}

function titleCaseName(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function reverseCountryNames(forward) {
  const reverse = new Map();
  for (const [name, code] of Object.entries(forward || {})) {
    const iso2 = String(code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2) || reverse.has(iso2)) continue;
    reverse.set(iso2, titleCaseName(name));
  }
  return reverse;
}

function prettyDate(isoDate) {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(isoDate || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'not available';
  return `${Math.round(numeric * 100)}%`;
}

function formatScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'not ranked';
  return numeric.toFixed(1).replace(/\.0$/, '');
}

async function importRepoModule(rootDir, relativePath) {
  return import(pathToFileURL(repoPath(rootDir, relativePath)).href);
}

function normalizeGlossaryTerms(terms) {
  return (terms || [])
    .map((term) => ({
      slug: term.slug,
      term: term.term,
      abbr: term.abbr || undefined,
      short: term.short,
    }))
    .filter((term) => term.slug && term.term)
    .sort((a, b) => a.term.localeCompare(b.term));
}

function normalizeChokepoints(entries) {
  return (entries || [])
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      baselineId: entry.baselineId,
      shockModelSupported: Boolean(entry.shockModelSupported),
      routeIds: Array.isArray(entry.routeIds) ? [...entry.routeIds] : [],
      lat: Number(entry.lat),
      lon: Number(entry.lon),
      slug: slugify(entry.displayName || entry.id),
    }))
    .filter((entry) => entry.id && entry.displayName)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function normalizeCountries(snapshot, reverseNames) {
  const seen = new Set();
  const ranked = (snapshot.items || []).map((item) => {
    const code = String(item.countryCode || '').toUpperCase();
    const name = item.countryName || reverseNames.get(code) || code;
    return {
      code,
      name,
      slug: uniqueSlug(name, code, seen),
      rank: Number(item.rank),
      overallScore: item.overallScore,
      level: item.level || 'unclassified',
      lowConfidence: Boolean(item.lowConfidence),
      dimensionCoverage: item.dimensionCoverage ?? item.overallCoverage ?? null,
      headlineEligible: item.headlineEligible !== false,
      sourceStatus: 'ranked',
    };
  });

  const rankedCodes = new Set(ranked.map((country) => country.code));
  const greyedOut = (snapshot.greyedOut || [])
    .filter((item) => !rankedCodes.has(String(item.countryCode || '').toUpperCase()))
    .map((item) => {
      const code = String(item.countryCode || '').toUpperCase();
      const name = item.countryName || reverseNames.get(code) || code;
      return {
        code,
        name,
        slug: uniqueSlug(name, code, seen),
        rank: null,
        overallScore: item.overallScore ?? null,
        level: item.level || 'low-confidence',
        lowConfidence: true,
        dimensionCoverage: item.overallCoverage ?? item.dimensionCoverage ?? null,
        headlineEligible: item.headlineEligible === true,
        sourceStatus: 'low-confidence',
      };
    });

  return [...ranked, ...greyedOut].sort((a, b) => {
    if (a.rank == null && b.rank == null) return a.name.localeCompare(b.name);
    if (a.rank == null) return 1;
    if (b.rank == null) return -1;
    return a.rank - b.rank;
  });
}

function stripMarkdownInline(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChangelog(source) {
  const matches = [...source.matchAll(/^## \[([^\]]+)\](?: - ([0-9-]+))?\s*$/gm)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const body = source.slice(match.index + match[0].length, next ? next.index : source.length);
    const bulletItems = [];
    let currentBullet = null;
    for (const line of body.split(/\r?\n/)) {
      const bulletMatch = line.match(/^- (.+)$/);
      if (bulletMatch) {
        if (currentBullet) bulletItems.push(currentBullet.join(' '));
        currentBullet = [bulletMatch[1]];
      } else if (currentBullet && /^\s{2,}\S/.test(line)) {
        currentBullet.push(line.trim());
      } else if (currentBullet && line.trim() === '') {
        continue;
      } else if (currentBullet) {
        bulletItems.push(currentBullet.join(' '));
        currentBullet = null;
      }
    }
    if (currentBullet) bulletItems.push(currentBullet.join(' '));
    const bullets = bulletItems
      .map((line) => stripMarkdownInline(line))
      .filter(Boolean)
      .slice(0, 8);
    const headings = [...body.matchAll(/^###\s+(.+)$/gm)]
      .map(([, heading]) => stripMarkdownInline(heading))
      .filter(Boolean);
    return {
      label: match[1],
      date: match[2] || null,
      slug: slugify(match[1] === 'Unreleased' ? 'unreleased' : match[1]),
      headings,
      bullets,
    };
  }).filter((release) => release.label && release.bullets.length > 0);
}

function latestDatedChangelogRelease(changelog) {
  const dates = changelog
    .map((release) => release.date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))
    .sort();
  return dates[dates.length - 1] || null;
}

function gitFileLastmod(rootDir, relativePath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', relativePath], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export async function loadCorpusData({ rootDir = DEFAULT_ROOT } = {}) {
  const resilience = readJson(rootDir, RESILIENCE_SNAPSHOT_PATH);
  const reverseNames = reverseCountryNames(readJson(rootDir, COUNTRY_NAMES_PATH));
  const [{ CHOKEPOINT_REGISTRY }, { GLOSSARY_TERMS }] = await Promise.all([
    importRepoModule(rootDir, CHOKEPOINT_REGISTRY_PATH),
    importRepoModule(rootDir, GLOSSARY_DATA_PATH),
  ]);
  const countries = normalizeCountries(resilience, reverseNames);
  const chokepoints = normalizeChokepoints(CHOKEPOINT_REGISTRY);
  const glossaryTerms = normalizeGlossaryTerms(GLOSSARY_TERMS);
  const changelog = parseChangelog(readText(rootDir, CHANGELOG_PATH));
  const changelogLastmod = gitFileLastmod(rootDir, CHANGELOG_PATH)
    || latestDatedChangelogRelease(changelog)
    || resilience.capturedAt;
  const chokepointsLastmod = gitFileLastmod(rootDir, CHOKEPOINT_REGISTRY_PATH)
    || resilience.capturedAt;

  return {
    sources: {
      resilienceSnapshot: RESILIENCE_SNAPSHOT_PATH,
      countryNames: COUNTRY_NAMES_PATH,
      chokepointRegistry: CHOKEPOINT_REGISTRY_PATH,
      glossaryData: GLOSSARY_DATA_PATH,
      changelog: CHANGELOG_PATH,
    },
    lastmod: {
      changelog: changelogLastmod,
      chokepoints: chokepointsLastmod,
    },
    resilience,
    countries,
    chokepoints,
    glossaryTerms,
    changelog,
  };
}

function breadcrumbLd(baseUrl, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(baseUrl, item.path),
    })),
  };
}

function pageDocument({
  baseUrl,
  path,
  title,
  description,
  lastmod,
  paginationLinks = [],
  jsonLd,
  breadcrumbs,
  body,
}) {
  const canonical = absoluteUrl(baseUrl, path);
  const ld = [jsonLd, breadcrumbs].filter(Boolean);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    ${lastmod ? `<meta name="lastmod" content="${escapeHtml(lastmod)}">` : []}
    ${paginationLinks.map((link) => `<link rel="${escapeHtml(link.rel)}" href="${escapeHtml(absoluteUrl(baseUrl, link.path))}">`).join(String.fromCharCode(10) + "    ")}
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:site_name" content="World Monitor">
    ${ld.map((entry) => `<script type="application/ld+json">${escapeJsonScript(entry)}</script>`).join('\n    ')}
    <style>
      :root { color-scheme: dark; --bg: #050807; --panel: #0c1210; --text: #eef8f0; --muted: #a8b8ad; --line: #1b2b22; --accent: #4ade80; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 20px; }
      header { padding-top: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
      nav { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; }
      main { padding-top: 36px; padding-bottom: 52px; }
      h1 { font-size: clamp(32px, 5vw, 54px); line-height: 1; margin: 0 0 16px; letter-spacing: 0; }
      h2 { margin-top: 36px; font-size: 22px; }
      p { color: var(--muted); }
      .lede { font-size: 18px; max-width: 760px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 24px; }
      .card, .metric { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
      .metric strong { display: block; font-size: 28px; color: var(--text); }
      .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; font-weight: 700; }
      .source { margin-top: 34px; font-size: 13px; color: var(--muted); }
      footer { border-top: 1px solid var(--line); padding-top: 20px; padding-bottom: 28px; color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <header>
      <nav aria-label="Primary">
        <a href="/">World Monitor</a>
        <a href="/countries/">Countries</a>
        <a href="/chokepoints/">Chokepoints</a>
        <a href="/reference/changelog/">Changelog</a>
        <a href="/blog/glossary/">Glossary</a>
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer>World Monitor static reference corpus. Built from committed methodology and data snapshots.</footer>
  </body>
</html>
`;
}

function renderCountriesIndex({ countries, baseUrl, capturedAt }) {
  const path = '/countries/';
  const description = `Country risk and resilience pages built from World Monitor's committed ${capturedAt} resilience ranking snapshot.`;
  const body = `      <p class="eyebrow">Country corpus</p>
      <h1>Country risk and resilience</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
${countries.map((country) => `        <a class="card" href="/countries/${country.slug}/"><strong>${escapeHtml(country.name)}</strong><br><span>${country.rank == null ? 'Low-confidence listing' : `Rank ${country.rank}`} &middot; ${escapeHtml(country.code)}</span></a>`).join('\n')}
      </div>
      <p class="source">Source: ${RESILIENCE_SNAPSHOT_PATH} (${escapeHtml(prettyDate(capturedAt))}).</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Country Risk and Resilience | World Monitor',
    description,
    lastmod: capturedAt,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Country risk and resilience',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Countries', path },
    ]),
    body,
  });
}

function renderCountryPage({ country, baseUrl, capturedAt, methodologyFormula }) {
  const path = `/countries/${country.slug}/`;
  const rankText = country.rank == null ? 'not ranked in the headline table' : `ranked #${country.rank}`;
  const description = `${country.name} is ${rankText} in the ${capturedAt} World Monitor Country Resilience Index snapshot.`;
  const body = `      <p class="eyebrow">Country &middot; ${escapeHtml(country.code)}</p>
      <h1>${escapeHtml(country.name)} country risk and resilience</h1>
      <p class="lede">${escapeHtml(description)} The page is a static, dated reference built from committed data, not a live score.</p>
      <section class="grid" aria-label="Country resilience metrics">
        <div class="metric"><span>Rank</span><strong>${escapeHtml(country.rank == null ? 'Not ranked' : `#${country.rank}`)}</strong></div>
        <div class="metric"><span>Overall score</span><strong>${escapeHtml(formatScore(country.overallScore))}</strong></div>
        <div class="metric"><span>Dimension coverage</span><strong>${escapeHtml(formatPercent(country.dimensionCoverage))}</strong></div>
        <div class="metric"><span>Confidence</span><strong>${country.lowConfidence ? 'Low' : 'Standard'}</strong></div>
      </section>
      <h2>How to read this page</h2>
      <p>World Monitor's Country Resilience Index is a 0-100 structural resilience score. This page records the committed ${escapeHtml(prettyDate(capturedAt))} snapshot using the ${escapeHtml(methodologyFormula)} methodology tag.</p>
      <p>Use it as a crawlable reference and stable landing page. For current operational data, use the dashboard or API.</p>
      <p class="source">Source: ${RESILIENCE_SNAPSHOT_PATH}. Captured ${escapeHtml(capturedAt)}.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: `${country.name} Country Risk and Resilience | World Monitor`,
    description,
    lastmod: capturedAt,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `${country.name} country risk and resilience`,
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      about: {
        '@type': 'Country',
        name: country.name,
        identifier: country.code,
      },
      mainEntity: {
        '@type': 'Dataset',
        name: `World Monitor Country Resilience snapshot for ${country.name}`,
        datePublished: capturedAt,
        measurementTechnique: methodologyFormula,
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Countries', path: '/countries/' },
      { name: country.name, path },
    ]),
    body,
  });
}

function renderChokepointsIndex({ chokepoints, baseUrl, lastmod }) {
  const path = '/chokepoints/';
  const description = 'Static reference pages for World Monitor maritime chokepoints and waterways.';
  const body = `      <p class="eyebrow">Maritime corpus</p>
      <h1>Chokepoints and waterways</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
${chokepoints.map((cp) => `        <a class="card" href="/chokepoints/${cp.slug}/"><strong>${escapeHtml(cp.displayName)}</strong><br><span>${escapeHtml(cp.id)} &middot; ${cp.routeIds.length} route${cp.routeIds.length === 1 ? '' : 's'}</span></a>`).join('\n')}
      </div>
      <p class="source">Source: ${CHOKEPOINT_REGISTRY_PATH}.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Maritime Chokepoints | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Maritime chokepoints and waterways',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Chokepoints', path },
    ]),
    body,
  });
}

function renderChokepointPage({ chokepoint, baseUrl, lastmod }) {
  const path = `/chokepoints/${chokepoint.slug}/`;
  const description = `${chokepoint.displayName} is one of the 13 canonical maritime chokepoints tracked by World Monitor.`;
  const modelText = chokepoint.shockModelSupported
    ? 'This chokepoint has an energy shock model in the committed registry.'
    : 'This chokepoint is monitored as a waterway reference; it does not currently have an energy shock model flag in the registry.';
  const body = `      <p class="eyebrow">Chokepoint</p>
      <h1>${escapeHtml(chokepoint.displayName)} chokepoint</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <section class="grid" aria-label="Chokepoint registry fields">
        <div class="metric"><span>Canonical ID</span><strong>${escapeHtml(chokepoint.id)}</strong></div>
        <div class="metric"><span>Trade routes</span><strong>${chokepoint.routeIds.length}</strong></div>
        <div class="metric"><span>Energy baseline</span><strong>${escapeHtml(chokepoint.baselineId || 'None')}</strong></div>
        <div class="metric"><span>Coordinates</span><strong>${escapeHtml(`${chokepoint.lat}, ${chokepoint.lon}`)}</strong></div>
      </section>
      <h2>Operational context</h2>
      <p>${escapeHtml(modelText)}</p>
      <p>Canonical ID: ${escapeHtml(chokepoint.id)}. Route IDs: ${escapeHtml(chokepoint.routeIds.length ? chokepoint.routeIds.join(', ') : 'none configured')}.</p>
      <p class="source">Source: ${CHOKEPOINT_REGISTRY_PATH}.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: `${chokepoint.displayName} Chokepoint | World Monitor`,
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `${chokepoint.displayName} chokepoint`,
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      about: {
        '@type': 'Place',
        name: chokepoint.displayName,
        identifier: chokepoint.id,
        geo: Number.isFinite(chokepoint.lat) && Number.isFinite(chokepoint.lon)
          ? {
              '@type': 'GeoCoordinates',
              latitude: chokepoint.lat,
              longitude: chokepoint.lon,
            }
          : undefined,
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Chokepoints', path: '/chokepoints/' },
      { name: chokepoint.displayName, path },
    ]),
    body,
  });
}

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function changelogPagePath(index) {
  return index === 0 ? '/reference/changelog/' : `/reference/changelog/page/${index + 1}/`;
}

function renderChangelogPage({ releases, pageIndex, totalPages, baseUrl, lastmod }) {
  const path = changelogPagePath(pageIndex);
  const paginationLinks = [
    pageIndex > 0 ? { rel: 'prev', path: changelogPagePath(pageIndex - 1) } : null,
    pageIndex + 1 < totalPages ? { rel: 'next', path: changelogPagePath(pageIndex + 1) } : null,
  ].filter(Boolean);
  const title = pageIndex === 0
    ? 'World Monitor Changelog | World Monitor'
    : `World Monitor Changelog Page ${pageIndex + 1} | World Monitor`;
  const description = 'Paginated static release notes for World Monitor, built from the committed CHANGELOG.md file.';
  const body = `      <p class="eyebrow">Release notes</p>
      <h1>World Monitor changelog</h1>
      <p class="lede">${escapeHtml(description)}</p>
${releases.map((release) => `      <article class="card">
        <h2>${escapeHtml(release.label)}${release.date ? ` <small>${escapeHtml(release.date)}</small>` : ''}</h2>
        ${release.headings.length ? `<p>${escapeHtml(release.headings.join(' / '))}</p>` : ''}
        <ul>
${release.bullets.map((bullet) => `          <li>${escapeHtml(bullet)}</li>`).join('\n')}
        </ul>
      </article>`).join('\n')}
      <nav class="grid" aria-label="Changelog pagination">
        ${pageIndex > 0 ? `<a class="card" href="${changelogPagePath(pageIndex - 1)}">Previous page</a>` : ''}
        ${pageIndex + 1 < totalPages ? `<a class="card" href="${changelogPagePath(pageIndex + 1)}">Next page</a>` : ''}
      </nav>
      <p class="source">Source: ${CHANGELOG_PATH}. Page ${pageIndex + 1} of ${totalPages}.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title,
    description,
    lastmod,
    paginationLinks,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'World Monitor changelog',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      isPartOf: {
        '@type': 'CreativeWorkSeries',
        name: 'World Monitor release notes',
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Changelog', path: '/reference/changelog/' },
    ]),
    body,
  });
}

function writeGeneratedFile(outDir, relativePath, content) {
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function routeFile(pathname) {
  const withoutLeading = pathname.replace(/^\/+/, '');
  return join(withoutLeading, 'index.html');
}

function buildManifest({ data, baseUrl, changelogPageCount }) {
  const countryRoutes = data.countries.map((country) => `/countries/${country.slug}/`);
  const chokepointRoutes = data.chokepoints.map((chokepoint) => `/chokepoints/${chokepoint.slug}/`);
  const changelogRoutes = Array.from({ length: changelogPageCount }, (_, index) => changelogPagePath(index));
  const glossaryRoutes = data.glossaryTerms.map((term) => `/blog/glossary/${term.slug}/`);
  return {
    schemaVersion: 1,
    baseUrl: normalizeBaseUrl(baseUrl),
    sources: data.sources,
    sections: {
      countries: {
        count: countryRoutes.length,
        index: '/countries/',
        routes: countryRoutes,
        sourceCapturedAt: data.resilience.capturedAt,
      },
      chokepoints: {
        count: chokepointRoutes.length,
        index: '/chokepoints/',
        routes: chokepointRoutes,
      },
      changelog: {
        count: changelogRoutes.length,
        index: '/reference/changelog/',
        routes: changelogRoutes,
        sourceLastmod: data.lastmod.changelog,
      },
      glossary: {
        count: glossaryRoutes.length,
        index: '/blog/glossary/',
        routes: glossaryRoutes,
        generatedBy: 'blog-site Astro build',
      },
    },
  };
}

export async function buildCorpus({
  rootDir = DEFAULT_ROOT,
  outDir = DEFAULT_OUT_DIR,
  baseUrl = DEFAULT_BASE_URL,
  clean = true,
} = {}) {
  const data = await loadCorpusData({ rootDir });
  if (clean) {
    for (const dir of GENERATED_DIRS) {
      rmSync(join(outDir, dir), { recursive: true, force: true });
    }
  }

  writeGeneratedFile(
    outDir,
    'countries/index.html',
    renderCountriesIndex({
      countries: data.countries,
      baseUrl,
      capturedAt: data.resilience.capturedAt,
    }),
  );
  for (const country of data.countries) {
    writeGeneratedFile(
      outDir,
      routeFile(`/countries/${country.slug}/`),
      renderCountryPage({
        country,
        baseUrl,
        capturedAt: data.resilience.capturedAt,
        methodologyFormula: data.resilience.methodologyFormula || 'unknown',
      }),
    );
  }

  writeGeneratedFile(
    outDir,
    'chokepoints/index.html',
    renderChokepointsIndex({
      chokepoints: data.chokepoints,
      baseUrl,
      lastmod: data.lastmod.chokepoints,
    }),
  );
  for (const chokepoint of data.chokepoints) {
    writeGeneratedFile(
      outDir,
      routeFile(`/chokepoints/${chokepoint.slug}/`),
      renderChokepointPage({
        chokepoint,
        baseUrl,
        lastmod: data.lastmod.chokepoints,
      }),
    );
  }

  const changelogPages = chunk(data.changelog, CHANGELOG_PAGE_SIZE);
  changelogPages.forEach((releases, pageIndex) => {
    writeGeneratedFile(
      outDir,
      routeFile(changelogPagePath(pageIndex)),
      renderChangelogPage({
        releases,
        pageIndex,
        totalPages: changelogPages.length,
        baseUrl,
        lastmod: data.lastmod.changelog,
      }),
    );
  });

  const manifest = buildManifest({
    data,
    baseUrl,
    changelogPageCount: changelogPages.length,
  });
  writeGeneratedFile(outDir, 'crawlable-corpus.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const options = {
    rootDir: DEFAULT_ROOT,
    outDir: DEFAULT_OUT_DIR,
    baseUrl: DEFAULT_BASE_URL,
    clean: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-clean') {
      options.clean = false;
    } else if (arg === '--out-dir') {
      options.outDir = resolve(argv[++i]);
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = resolve(arg.slice('--out-dir='.length));
    } else if (arg === '--root-dir') {
      options.rootDir = resolve(argv[++i]);
    } else if (arg.startsWith('--root-dir=')) {
      options.rootDir = resolve(arg.slice('--root-dir='.length));
    } else if (arg === '--base-url') {
      options.baseUrl = argv[++i];
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildCorpus(options);
  process.stdout.write(
    `Wrote crawlable corpus: ${manifest.sections.countries.count} countries, `
    + `${manifest.sections.chokepoints.count} chokepoints, `
    + `${manifest.sections.changelog.count} changelog pages. `
    + `Glossary manifest references ${manifest.sections.glossary.count} existing blog pages.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
