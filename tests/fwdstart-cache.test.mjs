import assert from 'node:assert/strict';
import test from 'node:test';

// #6235: /api/fwdstart scrapes one fixed URL on every CDN miss with no Redis
// tier — a fixed-input request-time fetch, which the gold standard says should
// be persisted rather than re-scraped.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.url == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
}

const ARCHIVE_HTML = `
<div class="embla__slide">
  <a href="/p/first-post"></a>
  <img alt="The First Post Title" />
  <span>Jan 12, 2026</span>
</div>
<div class="embla__slide">
  <a href="/p/second-post"></a>
  <img alt="The Second Post Title" />
  <span>Feb 03, 2026</span>
</div>
`;

function installStub({ redisAvailable = true } = {}) {
  const store = new Map();
  const scrapeCalls = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      if (!redisAvailable) return new Response('nope', { status: 500 });
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }
    if (url === 'https://redis.example.test/pipeline') {
      if (!redisAvailable) return new Response('nope', { status: 500 });
      const cmds = JSON.parse(String(init?.body));
      for (const cmd of cmds) if (cmd[0] === 'SET') store.set(cmd[1], cmd[2]);
      return new Response(JSON.stringify(cmds.map(() => ({ result: 'OK' }))), { status: 200 });
    }
    if (url.startsWith('https://www.fwdstart.me/')) {
      scrapeCalls.push(url);
      return new Response(ARCHIVE_HTML, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  return { scrapeCalls, store };
}

const request = () => new Request('https://worldmonitor.app/api/fwdstart');

test('repeat fwdstart requests are served from Redis, not re-scraped', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { scrapeCalls } = installStub();
  const { default: handler } = await import('../api/fwdstart.js');

  const first = await handler(request(), undefined);
  const firstBody = await first.text();
  assert.equal(first.status, 200);
  assert.match(firstBody, /The First Post Title/);
  assert.equal(scrapeCalls.length, 1, 'first request must scrape upstream');

  const second = await handler(request(), undefined);
  const secondBody = await second.text();
  assert.equal(second.status, 200);
  assert.match(secondBody, /The First Post Title/);
  assert.match(secondBody, /The Second Post Title/);
  assert.equal(scrapeCalls.length, 1, 'second request must be served from Redis');
});

test('a Redis outage still serves the feed', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { scrapeCalls } = installStub({ redisAvailable: false });
  const { default: handler } = await import('../api/fwdstart.js');

  const res = await handler(request(), undefined);
  assert.equal(res.status, 200, 'Redis being down must not break the feed');
  assert.match(await res.text(), /The First Post Title/);
  assert.equal(scrapeCalls.length, 1);
});

test('an upstream failure with no cache still returns 502, not a fake empty feed', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const store = new Map();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (url === 'https://redis.example.test/pipeline') {
      const cmds = JSON.parse(String(init?.body));
      for (const cmd of cmds) if (cmd[0] === 'SET') store.set(cmd[1], cmd[2]);
      return new Response(JSON.stringify(cmds.map(() => ({ result: 'OK' }))), { status: 200 });
    }
    if (url.startsWith('https://www.fwdstart.me/')) return new Response('down', { status: 503 });
    throw new Error(`unexpected request: ${url}`);
  };

  const { default: handler } = await import('../api/fwdstart.js');
  const res = await handler(request(), undefined);
  assert.equal(res.status, 502, 'a scrape failure with no cached items must not look like an empty feed');
  assert.equal(store.size, 0, 'a failed scrape must not write anything to the cache');
});

test('an empty extraction is not cached, so a broken parser cannot persist a hollow feed', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const store = new Map();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (url === 'https://redis.example.test/pipeline') {
      const cmds = JSON.parse(String(init?.body));
      for (const cmd of cmds) if (cmd[0] === 'SET') store.set(cmd[1], cmd[2]);
      return new Response(JSON.stringify(cmds.map(() => ({ result: 'OK' }))), { status: 200 });
    }
    // 200 OK but markup the parser no longer understands.
    if (url.startsWith('https://www.fwdstart.me/')) return new Response('<div>redesigned</div>', { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  };

  const { default: handler } = await import('../api/fwdstart.js');
  await handler(request(), undefined);
  assert.equal(store.size, 0, 'a zero-item extraction must not be persisted');
});
