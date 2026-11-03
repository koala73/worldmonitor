import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import handler, { parseMiitNews, renderMiitRss } from './miit-news.js';

const NOW = Date.parse('2026-10-03T17:00:00Z');
const ARTICLE = 'https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2026/art_7d2e760b4be94217b8f55caec840b30d.html';
const TITLE = '四部门关于开展2026年度享受增值税加计抵减政策的集成电路企业清单制定工作的通知';
const row = (day, href, title = TITLE) => `<li><span>${day}</span><p><a href="${href}" title="${title}">${title}</a></p></li>`;
const listing = row('2026-09-30', ARTICLE.replace('https:', 'http:'));
const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
beforeEach((t) => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  t.mock.method(Date, 'now', () => NOW);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

test('official MIIT listing supplies dated articles independently of Google News', () => {
  const items = parseMiitNews(listing + row('2026-09-30', ARTICLE), NOW);
  assert.deepEqual(items, [{ title: TITLE, link: ARTICLE, date: '2026-09-29T16:00:00.000Z' }]);
  const rss = renderMiitRss(items);
  assert.match(rss, /<pubDate>Tue, 29 Sep 2026 16:00:00 GMT<\/pubDate>/);
  assert.ok(rss.includes(`<link>${ARTICLE}</link>`));
  assert.ok(rss.includes(TITLE));
  assert.doesNotMatch(rss, /lastBuildDate/);
});

test('MIIT adapter rejects missing, invalid or future dates and nonofficial article links', () => {
  const rejected = [
    // 2026-09-18 is 15 China calendar days before NOW (2026-10-03) — outside the 14-day window.
    row('', ARTICLE), row('2026-02-30', ARTICLE), row('2026-10-05', ARTICLE), row('2026-09-18', ARTICLE),
    row('2026-09-30', 'https://foreign.example/article.html'),
    row('2026-09-30', 'https://www.miit.gov.cn.foreign.example/art/2026/art_a.html'),
    row('2026-09-30', 'https://user@www.miit.gov.cn/zwgk/art/2026/art_a.html'),
    row('2026-09-30', 'https://www.miit.gov.cn/'),
    row('2026-09-30', ARTICLE, ''),
  ].join('');
  assert.deepEqual(parseMiitNews(rejected, NOW), []);
});

test('MIIT listing keeps China-calendar fourteen-day articles past the old ms seven-day cliff', () => {
  // Event WORLDMONITOR-17K fired at 2026-10-06T16:03Z — the first minutes of
  // 2026-10-07 in Asia/Shanghai — when Sept 30 rows aged just past 7*86400000 ms
  // from listing midnight +08 even though the official markup still listed them.
  const cliff = Date.parse('2026-10-06T16:03:49Z');
  const items = parseMiitNews(listing, cliff);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, ARTICLE);
  assert.equal(items[0].date, '2026-09-29T16:00:00.000Z');
});

test('MIIT titles decode source entities and cannot terminate their RSS text section', () => {
  const items = parseMiitNews(row('2026-09-30', ARTICLE, 'A &amp; B &#x4E2D; ]]&gt;&lt;script&gt;'), NOW);
  assert.equal(items[0].title, 'A & B 中 ]]><script>');
  const rss = renderMiitRss(items);
  assert.ok(rss.includes(']]]]><![CDATA[>'));
  assert.doesNotMatch(rss, /\]\]><script>/);
});

test('fallback listing titles remove markup recreated by nested malformed tags', () => {
  const html = `<li><span>2026-09-30</span><a href="${ARTICLE}"><scr<script>ipt>Notice</script></a></li>`;
  assert.equal(parseMiitNews(html, NOW)[0].title, 'Notice');
});

test('MIIT endpoint serves official RSS with original dates', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (url !== 'https://www.miit.gov.cn/') throw new Error('No cache credentials in this test');
    calls.push({ url, options });
    return new Response(listing);
  };
  const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
  assert.match(await response.text(), /Tue, 29 Sep 2026 16:00:00 GMT/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.headers['User-Agent']);
});

test('upstream failure or empty parsing with no last-good copy fails without minting RSS', async () => {
  for (const upstream of [new Response('failure', { status: 503 }), new Response(null, { status: 302, headers: { Location: 'https://foreign.example' } }), new Response('<html>challenge</html>')]) {
    globalThis.fetch = async (url) => {
      if (url !== 'https://www.miit.gov.cn/') throw new Error('Cache unavailable');
      return upstream;
    };
    const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /<rss|pubDate/);
  }
});

test('cached MIIT articles retain the original dates without another source fetch or cache write', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const commands = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith('https://redis.example/get/'));
    commands.push({ url, method: options.method ?? 'GET' });
    return Response.json({ result: JSON.stringify(parseMiitNews(listing, NOW)) });
  };
  const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Tue, 29 Sep 2026 16:00:00 GMT/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].method, 'GET');
});

test('empty official listing never publishes a cache record', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const commands = [];
  globalThis.fetch = async (url, options) => {
    if (url === 'https://www.miit.gov.cn/') return new Response('<html></html>');
    if (url.startsWith('https://redis.example/get/')) {
      commands.push({ url, method: options.method ?? 'GET' });
      return Response.json({ result: null });
    }
    if (url === 'https://redis.example/pipeline') {
      commands.push({ url, method: 'POST' });
      return Response.json([{ result: 'OK' }]);
    }
    throw new Error('Unexpected test fetch');
  };
  const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
  assert.equal(response.status, 502);
  // Short-cache read, then the last-good read; never a write.
  assert.deepEqual(commands.map((c) => c.method), ['GET', 'GET']);
});

test('listing TimeoutError with no last-good copy fails closed with 502 and does not mint RSS', async () => {
  globalThis.fetch = async (url) => {
    if (url !== 'https://www.miit.gov.cn/') throw new Error('Cache unavailable');
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const response = await handler(new Request('https://example.test/api/miit-news'));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(await response.text(), /<rss|pubDate/);
});

function redisWithLastGood(lastGood) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const commands = [];
  const redis = (url, options) => {
    if (url.startsWith('https://redis.example/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example/get/'.length));
      commands.push({ op: 'GET', key });
      return Response.json({ result: key.endsWith('miit:news-listing:last-good:v1') && lastGood ? JSON.stringify(lastGood) : null });
    }
    if (url === 'https://redis.example/pipeline') {
      for (const command of JSON.parse(options.body)) commands.push({ op: command[0], key: command[1], ttl: command[4] });
      return Response.json([{ result: 'OK' }]);
    }
    return null;
  };
  return { commands, redis };
}

test('listing timeout serves the last-good official listing instead of a 502', async () => {
  const { commands, redis } = redisWithLastGood(parseMiitNews(listing, NOW));
  globalThis.fetch = async (url, options) => {
    const cached = redis(url, options);
    if (cached) return cached;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=60');
  assert.match(await response.text(), /Tue, 29 Sep 2026 16:00:00 GMT/);
  assert.deepEqual(commands.filter((c) => c.op !== 'GET'), [], 'stale fallback must not rewrite either cache key');
});

test('empty parse and upstream HTTP errors also fall back to the last-good listing', async () => {
  for (const upstream of [() => new Response('<html>challenge</html>'), () => new Response('failure', { status: 503 })]) {
    const { redis } = redisWithLastGood(parseMiitNews(listing, NOW));
    globalThis.fetch = async (url, options) => redis(url, options) ?? upstream();
    const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<rss/);
  }
});

test('last-good fallback drops articles that aged out of the listing window', async () => {
  // Stored while Sept 30 was current; served 15 China calendar days later.
  const { redis } = redisWithLastGood(parseMiitNews(listing, NOW));
  globalThis.fetch = async (url, options) => redis(url, options)
    ?? (() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); })();
  Date.now.mock.mockImplementation(() => Date.parse('2026-10-15T17:00:00Z'));
  const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /<rss|pubDate/);
});

test('fresh official listing refreshes both the short cache and the last-good copy', async () => {
  const { commands, redis } = redisWithLastGood(null);
  globalThis.fetch = async (url, options) => redis(url, options) ?? new Response(listing);
  const response = await handler(new Request('https://api.worldmonitor.app/api/miit-news'));
  assert.equal(response.status, 200);
  const writes = commands.filter((c) => c.op === 'SET').map((c) => [c.key.replace(/^.*?(miit:)/, '$1'), c.ttl]);
  assert.deepEqual(writes.sort(), [['miit:news-listing:last-good:v1', '1209600'], ['miit:news-listing:v1', '300']]);
});

test('listing TimeoutError / AbortError capture is downgraded to warning', () => {
  // captureSilentError is a no-op under NODE_TEST_CONTEXT, so pin the gate in
  // source the same way oauth/token contract tests pin capture shape. Real
  // envelope delivery stays covered by api/_sentry-common.test.mjs.
  const src = readFileSync(new URL('./miit-news.js', import.meta.url), 'utf8');
  assert.match(src, /errName === 'AbortError' \|\| errName === 'TimeoutError'/);
  assert.match(src, /isTransientTimeout \? \{ level: 'warning' \} : \{\}/);
});
