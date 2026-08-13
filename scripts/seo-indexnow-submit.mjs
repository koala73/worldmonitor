#!/usr/bin/env node
/**
 * Submit worldmonitor.app URLs to IndexNow after deploy.
 *
 * The CLI verifies every host's ownership key before notifying search engines:
 *   node scripts/seo-indexnow-submit.mjs
 *   node scripts/seo-indexnow-submit.mjs --host worldmonitor.app
 *
 * IndexNow requires all URLs in one request to share the same host.
 * Submits separate batches per subdomain.
 * The committed root sitemap and blog source corpus are the submission
 * inventory, so adding a canonical page does not require a second URL list.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keys must be genuinely random (`openssl rand -hex 16`). The previous value
// (a7f3e9d1b2c44e8f9a0b1c2d3e4f5a6b) is permanently rejected by Bing with
// 403 UserForbiddedToAccessSite even though the key file served fine — never
// reuse it (#6055).
export const INDEXNOW_KEY = 'f25eec9ff48713a38c0a66a7f0628d46';
const APEX_INDEXNOW_KEY = '315df476ff0a007d587f6a7455aa3e4e';
const BLOG_DIR = new URL('../blog-site/src/content/blog/', import.meta.url);
const BLOG_AUTHORS_DIR = new URL('../blog-site/src/pages/authors/', import.meta.url);
const GLOSSARY_SOURCE = new URL('../blog-site/src/data/glossary.ts', import.meta.url);
const ROOT_SITEMAP = new URL('../public/sitemap.xml', import.meta.url);
const USER_AGENT = 'WorldMonitor-IndexNow/1.0 (+https://www.worldmonitor.app)';
// Every host is submitted sequentially inside one 10-minute job, and fetch has
// no default deadline — one unresponsive search engine would otherwise stall
// the run until the job timeout and leave later hosts unsubmitted.
const REQUEST_TIMEOUT_MS = 15_000;

function decodeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function uniqueSorted(urls) {
  return [...new Set(urls)].sort();
}

function getRootSitemapUrls() {
  const source = readFileSync(ROOT_SITEMAP, 'utf8');
  const urls = [...source.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
    .map((match) => decodeXml(match[1].trim()));
  if (urls.length === 0) throw new Error(`${ROOT_SITEMAP.pathname} contains no canonical URLs`);
  return urls;
}

const ROOT_SITEMAP_URLS = getRootSitemapUrls();

function getSitemapUrlsForHost(host) {
  const urls = ROOT_SITEMAP_URLS.filter((value) => new URL(value).hostname === host);
  if (urls.length === 0) throw new Error(`${ROOT_SITEMAP.pathname} contains no URLs for ${host}`);
  return urls;
}

function getBlogPostUrls() {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => `https://www.worldmonitor.app/blog/posts/${basename(file, '.md')}/`)
    .sort();
}

function getBlogAuthorUrls() {
  return readdirSync(BLOG_AUTHORS_DIR)
    .filter((file) => file.endsWith('.astro'))
    .map((file) => `https://www.worldmonitor.app/blog/authors/${basename(file, '.astro')}/`)
    .sort();
}

function getBlogGlossaryUrls() {
  const source = readFileSync(GLOSSARY_SOURCE, 'utf8');
  const slugs = [...source.matchAll(/^\s*slug:\s*'([^']+)'/gm)].map((match) => match[1]);
  if (slugs.length === 0) throw new Error(`${GLOSSARY_SOURCE.pathname} contains no glossary slugs`);
  return slugs.map((slug) => `https://www.worldmonitor.app/blog/glossary/${slug}/`).sort();
}

function getBlogUrls() {
  return [
    'https://www.worldmonitor.app/blog/',
    'https://www.worldmonitor.app/blog/glossary/',
    ...getBlogAuthorUrls(),
    ...getBlogGlossaryUrls(),
    ...getBlogPostUrls(),
  ];
}

const APEX_HOST = 'worldmonitor.app';
const WWW_HOST = 'www.worldmonitor.app';

const APEX_URLS = uniqueSorted(getSitemapUrlsForHost(APEX_HOST));
const WWW_URLS = uniqueSorted([
  ...getSitemapUrlsForHost(WWW_HOST),
  ...getBlogUrls(),
]);

/**
 * Every remaining host the committed sitemap publishes — today the variant
 * dashboards. Derived from the sitemap rather than restated so a new variant
 * cannot be silently omitted from IndexNow the way commodity and energy were
 * (#6563). The deploy workflow reads this export to submit each one.
 *
 * Deriving it makes this list agree with the sitemap by construction, so the
 * sitemap cannot also be its proof: tests/indexnow-submit.test.mjs pins it to
 * WEB_DASHBOARD_VARIANTS — the registry of variants the app actually serves —
 * so a variant dropped upstream in build-sitemap.mjs fails there instead of
 * quietly shrinking this list.
 */
export const INDEXNOW_VARIANT_HOSTS = Object.freeze(
  uniqueSorted(ROOT_SITEMAP_URLS.map((url) => new URL(url).hostname))
    .filter((host) => host !== APEX_HOST && host !== WWW_HOST),
);

function urlsForHost(host, extraUrls = []) {
  return uniqueSorted([...getSitemapUrlsForHost(host), ...extraUrls]);
}

function batch(host, urls, key = INDEXNOW_KEY) {
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urls,
  };
}

export const INDEXNOW_BATCHES = Object.freeze([
  batch(APEX_HOST, APEX_URLS, APEX_INDEXNOW_KEY),
  batch(WWW_HOST, WWW_URLS),
  // The sitemap lists each variant's canonical /dashboard; the bare root is the
  // AI-crawler stub surface middleware.ts serves, so submit both.
  ...INDEXNOW_VARIANT_HOSTS.map((host) => batch(host, urlsForHost(host, [`https://${host}/`]))),
]);

export const INDEXNOW_ENDPOINTS = Object.freeze([
  'https://api.indexnow.org/IndexNow',
  'https://www.bing.com/IndexNow',
  'https://searchadvisor.naver.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://yandex.com/indexnow',
]);

/**
 * Confirm that a batch's ownership key is served directly from its declared host.
 */
export async function verifyIndexNowKey(batchConfig, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(batchConfig.keyLocation, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'text/plain',
      'User-Agent': USER_AGENT,
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `${batchConfig.host} IndexNow key must return a direct 200 from ${batchConfig.keyLocation}; got ${response.status}`,
    );
  }
  const body = (await response.text()).trim();
  if (body !== batchConfig.key) {
    throw new Error(`${batchConfig.host} IndexNow key body does not match ${batchConfig.key}`);
  }
}

async function submit(endpoint, batchConfig, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      host: batchConfig.host,
      key: batchConfig.key,
      keyLocation: batchConfig.keyLocation,
      urlList: batchConfig.urls,
    }),
  });
  return {
    endpoint,
    host: batchConfig.host,
    status: response.status,
    ok: response.ok,
  };
}

/**
 * Verify one host and notify each configured IndexNow endpoint about its URLs.
 */
export async function submitIndexNowBatch(
  batchConfig,
  {
    endpoints = INDEXNOW_ENDPOINTS,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  await verifyIndexNowKey(batchConfig, { fetchImpl });
  return Promise.allSettled(endpoints.map((endpoint) => submit(endpoint, batchConfig, fetchImpl)));
}

/**
 * Submit all requested host batches and fail after reporting every endpoint result.
 */
export async function runIndexNowSubmission({
  batches = INDEXNOW_BATCHES,
  endpoints = INDEXNOW_ENDPOINTS,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  let failed = false;
  for (const batchConfig of batches) {
    logger.log(`\n[${batchConfig.host}] (${batchConfig.urls.length} URLs)`);
    try {
      const results = await submitIndexNowBatch(batchConfig, { endpoints, fetchImpl });
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { endpoint, ok, status } = result.value;
          failed ||= !ok;
          logger.log(`  ${ok ? '✓' : '✗'} ${endpoint.replace('https://', '')} → ${status}`);
        } else {
          failed = true;
          logger.log(`  ✗ error: ${result.reason}`);
        }
      }
    } catch (error) {
      failed = true;
      logger.error(`  ✗ ${error?.message ?? error}`);
    }
  }
  if (failed) throw new Error('one or more IndexNow submissions failed');
}

function parseHostFilter(argv) {
  const index = argv.indexOf('--host');
  if (index === -1) return null;
  const host = argv[index + 1];
  if (!host || host.startsWith('--')) throw new Error('--host requires a hostname');
  return host;
}

async function main() {
  const host = parseHostFilter(process.argv.slice(2));
  const batches = host
    ? INDEXNOW_BATCHES.filter((batchConfig) => batchConfig.host === host)
    : INDEXNOW_BATCHES;
  if (host && batches.length === 0) throw new Error(`unknown IndexNow host: ${host}`);
  await runIndexNowSubmission({ batches });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[indexnow] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
