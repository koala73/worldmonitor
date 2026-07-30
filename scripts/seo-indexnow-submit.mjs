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
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const INDEXNOW_KEY = 'a7f3e9d1b2c44e8f9a0b1c2d3e4f5a6b';
const APEX_INDEXNOW_KEY = '315df476ff0a007d587f6a7455aa3e4e';
const BLOG_DIR = new URL('../blog-site/src/content/blog/', import.meta.url);
const USER_AGENT = 'WorldMonitor-IndexNow/1.0 (+https://www.worldmonitor.app)';

function getBlogPostUrls() {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => `https://www.worldmonitor.app/blog/posts/${basename(file, '.md')}/`)
    .sort();
}

const WWW_URLS = [
  'https://www.worldmonitor.app/',
  'https://www.worldmonitor.app/pro',
  'https://www.worldmonitor.app/blog/',
  ...getBlogPostUrls(),
];

function batch(host, urls, key = INDEXNOW_KEY) {
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urls,
  };
}

export const INDEXNOW_BATCHES = Object.freeze([
  batch('worldmonitor.app', ['https://worldmonitor.app/mcp'], APEX_INDEXNOW_KEY),
  batch('www.worldmonitor.app', WWW_URLS),
  batch('tech.worldmonitor.app', ['https://tech.worldmonitor.app/']),
  batch('finance.worldmonitor.app', ['https://finance.worldmonitor.app/']),
  batch('happy.worldmonitor.app', ['https://happy.worldmonitor.app/']),
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
