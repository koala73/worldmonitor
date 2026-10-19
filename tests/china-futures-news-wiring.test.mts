import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchAndParseRss } from '../server/worldmonitor/news/v1/list-feed-digest';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { fetchShfeNotices } from '../scripts/china-futures/shfe-notices.mjs';

test('opt-in source appears in the existing Asia category without changing the default catalog', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-shfe-'));
  try {
    const off = await bundleFeedsModule<any>({ repoRoot: resolve(import.meta.dirname, '..'), tempDir, outfileName: 'off.mjs' });
    const on = await bundleFeedsModule<any>({ repoRoot: resolve(import.meta.dirname, '..'), tempDir, outfileName: 'on.mjs', env: { VITE_ENABLE_CHINA_FUTURES_NEWS: '1' } });
    assert.equal(off.FULL_FEEDS.asia.some((feed: any) => feed.name === 'SHFE (China)'), false);
    assert.deepEqual(on.FULL_FEEDS.asia.filter((feed: any) => feed.name !== 'SHFE (China)'), off.FULL_FEEDS.asia);
    assert.equal(on.getSourcePanelId('SHFE (China)'), 'asia');
    assert.equal(on.FULL_FEEDS.asia.find((feed: any) => feed.name === 'SHFE (China)').url, '/api/china-futures-news');
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test('digest consumes the same seeded RSS, with no official-host or relay fallback', async (t) => {
  const now = Date.parse('2026-10-19T12:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  const html = readFileSync(new URL('./fixtures/china-futures/shfe-notices.html', import.meta.url), 'utf8');
  const snapshot = await fetchShfeNotices({ now, fetchImpl: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) });
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.CHINA_FUTURES_NEWS_ENABLED = '1';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  let missing = false;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    assert.equal(String(url), 'https://redis.example/get/news%3Achina-futures%3Ashfe%3Anotices%3Av1');
    return Response.json({ result: missing ? null : JSON.stringify(snapshot) });
  };
  const feed = { name: 'SHFE (China)', url: '/api/china-futures-news', lang: 'zh' };
  try {
    const result = await fetchAndParseRss(feed, 'full', new AbortController().signal);
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].title, /中化兴中石油/);
    assert.equal(result.items[0].source, feed.name);
    assert.equal(result.items[0].link, snapshot.items[0].sourceUrl);
    missing = true;
    const failed = await fetchAndParseRss(feed, 'full', new AbortController().signal);
    assert.equal(failed.items.length, 0);
    assert.equal(failed.attempt?.failure, 'direct-error');
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ['CHINA_FUTURES_NEWS_ENABLED', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
