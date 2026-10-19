import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLocalApiServer } from '../src-tauri/sidecar/local-api-server.mjs';
import handler from './china-futures-news.js';
import { fetchShfeNotices } from '../scripts/china-futures/shfe-notices.mjs';
import { CACHE_KEY, MAX_STALE_MIN } from './_china-futures-contract.js';

const now = Date.parse('2026-10-19T12:00:00+08:00');
const fixture = readFileSync(new URL('../tests/fixtures/china-futures/shfe-notices.html', import.meta.url), 'utf8');
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let snapshot;
beforeEach(async (t) => {
  t.mock.method(Date, 'now', () => now);
  process.env.CHINA_FUTURES_NEWS_ENABLED = '1';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'fixture';
  snapshot = await fetchShfeNotices({ now, fetchImpl: async () => new Response(fixture, { headers: { 'Content-Type': 'text/html' } }) });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://redis.example/get/${encodeURIComponent(CACHE_KEY)}`);
    assert.equal(options?.method ?? 'GET', 'GET');
    return Response.json({ result: snapshot === null ? null : JSON.stringify({ _seed: { schemaVersion: 1, fetchedAt: now }, data: snapshot }) });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['CHINA_FUTURES_NEWS_ENABLED', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'LOCAL_API_TOKEN']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});
const request = (method = 'GET', headers = {}) => new Request('https://api.worldmonitor.app/api/china-futures-news', { method, headers });

test('reads seeded RSS without source fetches or writes and preserves publication identity', async () => {
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/rss\+xml/);
  const rss = await response.text();
  assert.ok(rss.includes(snapshot.items[0].sourceUrl));
  assert.ok(rss.includes(snapshot.items[0].documentId));
  assert.match(rss, /Sun, 18 Oct 2026 16:00:00 GMT/);
  assert.doesNotMatch(rss, /lastBuildDate/);
  assert.equal(await (await handler(request('HEAD'))).text(), '');
});

test('encodes untrusted titles as XML text', async () => {
  snapshot.items[0].title = '铜 & 铝 ]]><script>bad</script>';
  const rss = await (await handler(request())).text();
  assert.match(rss, /铜 &amp; 铝 \]\]&gt;&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(rss, /<script>/);
});

test('missing, stale, future or invalid snapshots fail visibly instead of publishing fresh empty RSS', async () => {
  const good = structuredClone(snapshot);
  for (const value of [null, { ...good, fetchedAt: now - MAX_STALE_MIN * 60_000 - 1 }, { ...good, fetchedAt: now + 1 }, { ...good, items: [] }, { ...good, items: [{ ...good.items[0], sourceUrl: 'https://evil.test' }] }]) {
    snapshot = value;
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /<rss/);
  }
});

test('disabled source, methods and disallowed origins never read Redis', async () => {
  globalThis.fetch = () => { throw new Error('unexpected read'); };
  assert.equal((await handler(request('POST'))).status, 405);
  assert.equal((await handler(request('OPTIONS'))).status, 204);
  assert.equal((await handler(request('GET', { Origin: 'https://evil.test' }))).status, 403);
  delete process.env.CHINA_FUTURES_NEWS_ENABLED;
  assert.equal((await handler(request())).status, 503);
});

test('Edge and Railway contract mirrors are byte-identical', () => {
  assert.equal(readFileSync(new URL('./_china-futures-contract.js', import.meta.url), 'utf8'), readFileSync(new URL('../scripts/china-futures/contract.mjs', import.meta.url), 'utf8'));
});

test('the original desktop route discovery serves the real handler over HTTP', async () => {
  process.env.LOCAL_API_TOKEN = 'fixture-local-token';
  const app = await createLocalApiServer({ port: 0, apiDir: fileURLToPath(new URL('./', import.meta.url)), cloudFallback: 'false', logger: { log() {}, warn() {}, error() {} } });
  const { port } = await app.start();
  try {
    const response = await originalFetch(`http://127.0.0.1:${port}/api/china-futures-news`, { headers: { Authorization: 'Bearer fixture-local-token' } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /中化兴中石油/);
    snapshot = null;
    assert.equal((await originalFetch(`http://127.0.0.1:${port}/api/china-futures-news`, { headers: { Authorization: 'Bearer fixture-local-token' } })).status, 503);
  } finally { await app.close(); }
});
