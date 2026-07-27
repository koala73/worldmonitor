#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { XMLValidator } from 'fast-xml-parser';

import { getHtmlAttribute } from './discover-content-corpus-pages.mjs';

const DEFAULT_ORIGIN = 'https://www.worldmonitor.app';
const DEFAULT_TIMEOUT_MS = 15_000;
const EXPECTED_PAGE_HOSTS = new Set([
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
  if (pathname === '/blog' || pathname.startsWith('/blog/')) return 'blog';
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return 'docs';
  if (url.hostname !== 'www.worldmonitor.app' && pathname === '/dashboard') {
    return 'dashboard-variant';
  }
  if (pathname === '/') return 'landing';
  if (pathname === '/dashboard') return 'dashboard';
  if (pathname === '/pro') return 'product';
  if (/\.(?:md|txt)$/.test(pathname)) return 'machine-readable';
  for (const family of ['countries', 'chokepoints', 'crises', 'tools', 'research']) {
    if (pathname === `/${family}` || pathname.startsWith(`/${family}/`)) return family;
  }
  if (pathname === '/reference' || pathname.startsWith('/reference/')) return 'reference';
  return 'other';
}

export function inspectIndexability({ url, headers, body }) {
  const headerRobots = headers.get('x-robots-tag') ?? '';
  const linkHeader = headers.get('link') ?? '';
  const headerCanonical = linkHeader.match(
    /<([^>]+)>\s*;\s*rel=(?:"canonical"|'canonical'|canonical)/i,
  )?.[1] ?? null;
  const contentType = headers.get('content-type') ?? '';

  let htmlCanonical = null;
  let metaRobots = '';
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const linkTags = String(body).match(/<link\b[^>]*>/gi) ?? [];
    for (const tag of linkTags) {
      const rel = getHtmlAttribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
      if (rel.includes('canonical')) {
        htmlCanonical = getHtmlAttribute(tag, 'href');
        break;
      }
    }

    const metaTags = String(body).match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metaTags) {
      if (getHtmlAttribute(tag, 'name')?.toLowerCase() === 'robots') {
        metaRobots = getHtmlAttribute(tag, 'content') ?? '';
        break;
      }
    }
  }

  let canonical = null;
  if (headerCanonical) canonical = new URL(headerCanonical, url).href;
  else if (htmlCanonical) canonical = new URL(htmlCanonical, url).href;
  return {
    canonical,
    indexable: !/\bnoindex\b/i.test(`${headerRobots},${metaRobots}`),
    robots: [headerRobots, metaRobots].filter(Boolean).join(', ') || null,
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
  if (url.hostname !== 'www.worldmonitor.app' && url.pathname !== '/dashboard') {
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

async function fetchSitemapTree(rootSitemaps, fetchImpl, origin) {
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
    documents.push({
      url: sitemapUrl,
      status: response.status,
      contentType: response.headers.get('content-type'),
      type: parsed.type,
      locationCount: parsed.locations.length,
    });

    if (parsed.type === 'index') {
      for (const childUrl of parsed.locations) {
        const childError = validateSitemapDocumentUrl(childUrl, { origin, owner });
        if (childError) inventoryErrors.push(childError);
        else pending.push({ url: childUrl, owner });
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
    if (count >= samplePerFamily) continue;
    selected.add(url);
    counts.set(family, count + 1);
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
      const canonicalMatches = !sampled || inspection.canonical === url;
      const indexable = !sampled || inspection.indexable;
      if (!direct) errors.push(`${url} returned ${response.status}, expected direct HTTP 200`);
      if (!canonicalMatches) {
        errors.push(`${url} canonical mismatch: ${inspection.canonical ?? '(missing)'}`);
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
