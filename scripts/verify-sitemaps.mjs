#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { XMLValidator } from 'fast-xml-parser';

import { decodeHtmlEntities } from './_html-entities.mjs';

const DEFAULT_ORIGIN = 'https://www.worldmonitor.app';
const DEFAULT_TIMEOUT_MS = 15_000;
const REQUIRED_DOCS_PATHS = ['/docs/country-instability-index', '/docs/zh/country-instability-index'];
const EXPECTED_PAGE_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
]);

const decodeXml = (value) => String(value)
  .replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/&amp;/g, '&');

export function parseSitemapDocument(source) {
  const xml = String(source);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`invalid sitemap XML: ${validation.err.msg}`);
  }

  let type = null;
  if (/<sitemapindex\b/i.test(xml)) type = 'index';
  else if (/<urlset\b/i.test(xml)) type = 'urlset';
  if (!type) throw new Error('document is neither a sitemap index nor a URL set');

  const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeXml(match[1].trim()));
  if (locations.length === 0) throw new Error(`${type} contains no <loc> entries`);
  if (new Set(locations).size !== locations.length) {
    throw new Error(`${type} contains duplicate <loc> entries`);
  }
  return { type, locations };
}

export function classifySitemapUrl(value) {
  const url = new URL(value);
  const { pathname } = url;
  if (url.hostname === 'worldmonitor.app' && pathname === '/mcp') return 'mcp';
  if (pathname === '/blog' || pathname.startsWith('/blog/')) return 'blog';
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return 'docs';
  if (url.hostname !== 'www.worldmonitor.app' && pathname === '/dashboard') {
    return 'dashboard-variant';
  }
  if (pathname === '/') return 'landing';
  if (pathname === '/dashboard') return 'dashboard';
  if (pathname === '/pro') return 'product';
  if (/\.(?:md|txt)$/.test(pathname)) return 'machine-readable';
  for (const family of ['countries', 'chokepoints', 'compare', 'crises', 'tools', 'research']) {
    if (pathname === `/${family}` || pathname.startsWith(`/${family}/`)) return family;
  }
  if (pathname === '/reference' || pathname.startsWith('/reference/')) return 'reference';
  return 'other';
}

function getHtmlAttribute(tag, name) {
  for (const match of tag.matchAll(/\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    if (match[1].toLowerCase() === name) return decodeHtmlEntities(match[2] ?? match[3] ?? match[4]);
  }
  return null;
}

export function inspectIndexability({ url, headers, body }) {
  const headerRobots = headers.get('x-robots-tag') ?? '';
  const linkHeader = headers.get('link') ?? '';
  const contentType = headers.get('content-type') ?? '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
  const isDocs = classifySitemapUrl(url) === 'docs';
  const canonicalDeclarations = [];
  const canonicalErrors = [];
  const metaRobots = [];

  const addCanonical = (source, href) => {
    let resolved = null;
    if (!href?.trim()) {
      canonicalErrors.push(`${source} canonical has missing href`);
    } else {
      try {
        const target = new URL(href, url);
        if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash) {
          throw new Error('invalid canonical URL');
        }
        resolved = target.href;
        if (isDocs && !/^https?:\/\//i.test(href)) {
          canonicalErrors.push(`${source} docs canonical must be absolute: ${href}`);
        }
      } catch {
        canonicalErrors.push(`${source} canonical has invalid URL: ${href}`);
      }
    }
    canonicalDeclarations.push({ source, href, url: resolved });
  };

  for (const entry of linkHeader.match(/(?:<[^>]*>|"(?:\\.|[^"\\])*"|'[^']*'|[^,])+/g) ?? []) {
    const target = entry.match(/^\s*<([^>]*)>([\s\S]*)$/);
    const rel = [...(target?.[2] ?? entry).matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^;\s,]+))/g)]
      .find((parameter) => parameter[1].toLowerCase() === 'rel');
    if (!(rel?.[2] ?? rel?.[3] ?? rel?.[4] ?? '').toLowerCase().split(/\s+/).includes('canonical')) continue;
    addCanonical('http', target?.[1] ?? null);
  }

  if (isHtml) {
    const markup = String(body).replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(markup);
    for (const match of markup.matchAll(/<(?:link|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      const tag = match[0];
      const inHead = head && match.index >= head.index && match.index < head.index + head[0].length;
      if (/^<link\b/i.test(tag)) {
        const rel = getHtmlAttribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
        if (!rel.includes('canonical')) continue;
        if (!inHead) {
          canonicalErrors.push('HTML canonical is outside the head');
          continue;
        }
        const href = getHtmlAttribute(tag, 'href');
        addCanonical('html', href);
      } else if (inHead && ['robots', 'googlebot'].includes(getHtmlAttribute(tag, 'name')?.toLowerCase())) {
        metaRobots.push(getHtmlAttribute(tag, 'content') ?? '');
      }
    }
  }

  for (const source of ['html', 'http']) {
    const count = canonicalDeclarations.filter(entry => entry.source === source).length;
    if (count > 1) canonicalErrors.push(`duplicate ${source} canonical declarations: ${count}`);
    if (source === 'html' && isHtml && isDocs && count === 0) {
      canonicalErrors.push('missing HTML canonical in docs head');
    }
  }
  const targets = new Set(canonicalDeclarations.map(entry => entry.url).filter(Boolean));
  if (targets.size > 1) canonicalErrors.push(`conflicting canonical targets: ${[...targets].join(', ')}`);
  if (canonicalDeclarations.length === 0) canonicalErrors.push('missing canonical');

  let robot = '*';
  const effectiveRobots = [...metaRobots];
  for (const part of headerRobots.split(',')) {
    const scope = /^\s*([\w-]+):\s*(.*)$/.exec(part);
    const scoped = scope && !/^(?:unavailable_after|max-image-preview|max-snippet|max-video-preview)$/i.test(scope[1]);
    if (scoped) robot = scope[1].toLowerCase();
    if (robot === '*' || robot === 'googlebot') effectiveRobots.push(scoped ? scope[2] : part);
  }
  return {
    canonical: canonicalErrors.length === 0 ? [...targets][0] ?? null : null,
    canonicalDeclarations,
    canonicalErrors,
    indexable: !effectiveRobots.some(value => value.split(',').some(directive => /^(?:noindex|none)$/i.test(directive.trim()))),
    robots: [headerRobots, ...metaRobots].filter(Boolean).join(', ') || null,
  };
}

async function fetchDirect(url, { method = 'GET', fetchImpl = globalThis.fetch } = {}) {
  return fetchImpl(url, {
    method,
    redirect: 'manual',
    headers: {
      Accept: method === 'HEAD'
        ? '*/*'
        : 'application/xml,text/xml,text/html,text/markdown,text/plain;q=0.9,*/*;q=0.8',
      'User-Agent': 'WorldMonitor-Sitemap-Verifier/1.0 (+https://www.worldmonitor.app)',
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}

async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await callback(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const sitemapOwner = (value) => {
  const { pathname } = new URL(value);
  if (pathname === '/blog/sitemap-index.xml' || pathname.startsWith('/blog/')) return 'blog';
  if (pathname === '/docs/sitemap.xml' || pathname.startsWith('/docs/')) return 'docs';
  return 'root';
};

const expectedRootSitemaps = (origin) => [
  { url: `${origin}/sitemap.xml`, owner: 'root' },
  { url: `${origin}/blog/sitemap-index.xml`, owner: 'blog' },
  { url: `${origin}/docs/sitemap.xml`, owner: 'docs' },
];

const expectedRootIndexMembers = (origin) => [
  `${origin}/sitemap-main.xml`,
  `${origin}/blog/sitemap-index.xml`,
  `${origin}/docs/sitemap.xml`,
];

function validateCanonicalRootIndex(sitemapUrl, parsed, origin) {
  if (sitemapUrl !== `${origin}/sitemap.xml`) return [];
  if (parsed.type !== 'index') return [`${sitemapUrl} must be a sitemap index`];

  const expected = expectedRootIndexMembers(origin);
  const actual = new Set(parsed.locations);
  const missing = expected.filter((url) => !actual.has(url));
  const unexpected = parsed.locations.filter((url) => !expected.includes(url));
  const errors = [];
  if (missing.length > 0) {
    errors.push(`${sitemapUrl} is missing canonical index members: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    errors.push(`${sitemapUrl} contains unexpected index members: ${unexpected.join(', ')}`);
  }
  return errors;
}

function validateSitemapDocumentUrl(value, { origin, owner }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `malformed sitemap document URL: ${value}`;
  }
  if (url.origin !== origin || url.href !== value) {
    return `sitemap document must stay on ${origin}: ${value}`;
  }
  if (sitemapOwner(value) !== owner) {
    return `${owner} sitemap index points outside its owned path family: ${value}`;
  }
  return null;
}

function validatePageLocation(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `malformed sitemap page URL: ${value}`;
  }
  if (
    url.protocol !== 'https:'
    || !EXPECTED_PAGE_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || url.href !== value
  ) {
    return `sitemap page URL is not an allowed canonical WorldMonitor URL: ${value}`;
  }
  if (url.hostname === 'worldmonitor.app' && url.pathname !== '/mcp') {
    return `apex sitemap URL must be the canonical MCP endpoint: ${value}`;
  }
  if (
    url.hostname !== 'www.worldmonitor.app'
    && url.hostname !== 'worldmonitor.app'
    && url.pathname !== '/dashboard'
  ) {
    return `variant sitemap URL must be its canonical dashboard: ${value}`;
  }
  if (classifySitemapUrl(value) === 'other') {
    return `sitemap page URL is outside the declared discovery families: ${value}`;
  }
  return null;
}

function validatePageOwner(value, owner) {
  const family = classifySitemapUrl(value);
  if (owner === 'blog' && family !== 'blog') {
    return `blog sitemap owns a non-blog URL: ${value}`;
  }
  if (owner === 'docs' && family !== 'docs') {
    return `docs sitemap owns a non-docs URL: ${value}`;
  }
  if (owner === 'root' && (family === 'blog' || family === 'docs')) {
    return `root sitemap overlaps the ${family} inventory: ${value}`;
  }
  return null;
}

export async function fetchSitemapTree(rootSitemaps, fetchImpl, origin) {
  const pending = [...rootSitemaps];
  const seen = new Set();
  const documents = [];
  const urls = new Map();
  const locationSources = new Map();
  const inventoryErrors = [];

  while (pending.length > 0) {
    const { url: sitemapUrl, owner } = pending.shift();
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);

    const sitemapUrlError = validateSitemapDocumentUrl(sitemapUrl, { origin, owner });
    if (sitemapUrlError) {
      inventoryErrors.push(sitemapUrlError);
      continue;
    }

    const response = await fetchDirect(sitemapUrl, { fetchImpl });
    const body = await response.text();
    if (response.status !== 200) {
      throw new Error(`${sitemapUrl} returned ${response.status}, expected direct HTTP 200`);
    }
    const parsed = parseSitemapDocument(body);
    inventoryErrors.push(...validateCanonicalRootIndex(sitemapUrl, parsed, origin));
    documents.push({
      url: sitemapUrl,
      status: response.status,
      contentType: response.headers.get('content-type'),
      type: parsed.type,
      locationCount: parsed.locations.length,
    });

    if (parsed.type === 'index') {
      for (const childUrl of parsed.locations) {
        // The canonical root delegates to the three owned sitemap families.
        // Nested indexes remain in their inherited family.
        const childOwner = sitemapUrl === `${origin}/sitemap.xml`
          ? sitemapOwner(childUrl)
          : owner;
        const childError = validateSitemapDocumentUrl(childUrl, { origin, owner: childOwner });
        if (childError) inventoryErrors.push(childError);
        else pending.push({ url: childUrl, owner: childOwner });
      }
    } else {
      for (const loc of parsed.locations) {
        const locationError = validatePageLocation(loc);
        if (locationError) {
          inventoryErrors.push(locationError);
          continue;
        }
        const ownerError = validatePageOwner(loc, owner);
        if (ownerError) inventoryErrors.push(ownerError);

        const sources = locationSources.get(loc) ?? [];
        sources.push(sitemapUrl);
        locationSources.set(loc, sources);
        if (!urls.has(loc)) urls.set(loc, sitemapUrl);
      }
    }
  }

  const ownershipOverlaps = [...locationSources.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([url, sources]) => ({ url, sitemaps: sources }));
  return {
    documents,
    urls,
    ownershipOverlaps,
    inventoryErrors,
  };
}

function selectSamples(urls, samplePerFamily) {
  const selected = new Set();
  const counts = new Map();
  for (const url of [...urls].sort()) {
    const family = classifySitemapUrl(url);
    const count = counts.get(family) ?? 0;
    const ciiDocs = REQUIRED_DOCS_PATHS.includes(new URL(url).pathname);
    if (count >= samplePerFamily && !ciiDocs) continue;
    selected.add(url);
    if (count < samplePerFamily) counts.set(family, count + 1);
  }
  return selected;
}

export async function verifyProductionSitemaps({
  origin = DEFAULT_ORIGIN,
  samplePerFamily = 1,
  concurrency = 8,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedOrigin = origin.replace(/\/+$/, '');
  const robotsUrl = `${normalizedOrigin}/robots.txt`;
  const robotsResponse = await fetchDirect(robotsUrl, { fetchImpl });
  const robots = await robotsResponse.text();
  if (robotsResponse.status !== 200) {
    throw new Error(`${robotsUrl} returned ${robotsResponse.status}`);
  }

  const rootSitemaps = [...robots.matchAll(/^Sitemap:\s*(\S+)\s*$/gmi)]
    .map((match) => match[1]);
  if (rootSitemaps.length === 0) throw new Error(`${robotsUrl} advertises no sitemaps`);

  const expectedSitemaps = expectedRootSitemaps(normalizedOrigin);
  const expectedUrls = new Set(expectedSitemaps.map(({ url }) => url));
  const errors = [];
  for (const { url } of expectedSitemaps) {
    const count = rootSitemaps.filter((candidate) => candidate === url).length;
    if (count !== 1) errors.push(`${robotsUrl} must advertise ${url} exactly once, saw ${count}`);
  }
  for (const url of new Set(rootSitemaps)) {
    if (!expectedUrls.has(url)) errors.push(`${robotsUrl} advertises an unexpected sitemap: ${url}`);
  }

  const {
    documents,
    urls,
    ownershipOverlaps,
    inventoryErrors,
  } = await fetchSitemapTree(
    expectedSitemaps.filter(({ url }) => rootSitemaps.includes(url)),
    fetchImpl,
    normalizedOrigin,
  );
  errors.push(...inventoryErrors);
  const allUrls = [...urls.keys()];
  for (const path of REQUIRED_DOCS_PATHS) {
    const requiredUrl = `${normalizedOrigin}${path}`;
    if (!urls.has(requiredUrl)) errors.push(`required docs page missing from sitemap: ${requiredUrl}`);
  }
  const samples = selectSamples(allUrls, samplePerFamily);
  errors.push(...ownershipOverlaps.map(
    ({ url, sitemaps }) => `${url} is owned by multiple sitemap documents: ${sitemaps.join(', ')}`,
  ));

  const checks = await mapConcurrent(allUrls, concurrency, async (url) => {
    const sampled = samples.has(url);
    try {
      let response = await fetchDirect(url, {
        method: sampled ? 'GET' : 'HEAD',
        fetchImpl,
      });
      if (!sampled && response.status === 405) {
        response = await fetchDirect(url, { fetchImpl });
      }

      let body = '';
      if (sampled) {
        body = await response.text();
      } else {
        await response.body?.cancel();
      }

      const direct = response.status === 200;
      const inspection = sampled
        ? inspectIndexability({ url, headers: response.headers, body })
        : null;
      const canonicalMatches = !sampled || (inspection.canonical === url && inspection.canonicalErrors.length === 0);
      const indexable = !sampled || inspection.indexable;
      if (!direct) errors.push(`${url} returned ${response.status}, expected direct HTTP 200`);
      if (!canonicalMatches) {
        errors.push(`${url} canonical mismatch: ${inspection.canonical ?? '(missing)'}`);
        errors.push(...inspection.canonicalErrors.map(error => `${url} ${error}`));
      }
      if (!indexable) errors.push(`${url} is noindex`);

      return {
        url,
        family: classifySitemapUrl(url),
        sitemap: urls.get(url),
        sampled,
        status: response.status,
        location: response.headers.get('location'),
        canonical: inspection?.canonical ?? null,
        canonicalDeclarations: inspection?.canonicalDeclarations ?? null,
        canonicalErrors: inspection?.canonicalErrors ?? null,
        indexable: inspection?.indexable ?? null,
        robots: inspection?.robots ?? null,
        ok: direct && canonicalMatches && indexable,
      };
    } catch (error) {
      errors.push(`${url} failed: ${error?.message ?? error}`);
      return {
        url,
        family: classifySitemapUrl(url),
        sitemap: urls.get(url),
        sampled,
        status: null,
        canonical: null,
        indexable: null,
        ok: false,
        error: error?.message ?? String(error),
      };
    }
  });

  const familySummary = {};
  for (const check of checks) {
    const summary = familySummary[check.family] ?? {
      urls: 0,
      sampled: 0,
      passed: 0,
    };
    summary.urls += 1;
    if (check.sampled) summary.sampled += 1;
    if (check.ok) summary.passed += 1;
    familySummary[check.family] = summary;
  }

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    origin: normalizedOrigin,
    robots: {
      url: robotsUrl,
      status: robotsResponse.status,
      sitemapReferences: rootSitemaps,
    },
    sitemapDocuments: documents,
    ownershipOverlaps,
    familySummary,
    urlCount: checks.length,
    sampledCount: samples.size,
    passed: errors.length === 0,
    errors,
    checks,
  };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--origin=')) options.origin = arg.slice('--origin='.length);
    else if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length);
    else if (arg.startsWith('--sample-per-family=')) {
      options.samplePerFamily = Number(arg.slice('--sample-per-family='.length));
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = Number(arg.slice('--concurrency='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (
    options.samplePerFamily != null
    && (!Number.isInteger(options.samplePerFamily) || options.samplePerFamily < 1)
  ) {
    throw new Error('--sample-per-family must be a positive integer');
  }
  if (
    options.concurrency != null
    && (!Number.isInteger(options.concurrency) || options.concurrency < 1)
  ) {
    throw new Error('--concurrency must be a positive integer');
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { report, ...options } = parseArgs(process.argv.slice(2));
    const result = await verifyProductionSitemaps(options);
    if (report) writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      `[sitemap-verify] ${result.passed ? 'passed' : 'failed'}: `
      + `${result.sitemapDocuments.length} sitemap document(s), `
      + `${result.urlCount} URL status checks, ${result.sampledCount} canonical/indexability samples`,
    );
    if (!result.passed) {
      for (const error of result.errors) console.error(`[sitemap-verify] ${error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[sitemap-verify] ${error?.message ?? error}`);
    process.exit(1);
  }
}
