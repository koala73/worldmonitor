import assert from 'node:assert/strict';
import test from 'node:test';

// #6235: fetchLatestRelease always requests the same URL but had no Redis
// layer at all — only a CDN s-maxage on /api/version and /api/download. GitHub's
// unauthenticated API allows 60 req/hr per IP, so a CDN miss storm fails both
// public routes closed.

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

const RELEASE = { tag_name: 'v2.4.0', html_url: 'https://example.test/r/v2.4.0', prerelease: false };

function installStub({ redisAvailable = true } = {}) {
  const store = new Map();
  const githubCalls = [];

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
    if (url.startsWith('https://api.github.com/')) {
      githubCalls.push(url);
      return new Response(JSON.stringify(RELEASE), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  return { githubCalls, store };
}

test('repeat release lookups are served from Redis, not re-fetched from GitHub', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { githubCalls } = installStub();
  const { fetchLatestRelease } = await import('../api/_github-release.js');

  const first = await fetchLatestRelease('WorldMonitor-Version-Check');
  assert.equal(first.tag_name, 'v2.4.0');
  assert.equal(githubCalls.length, 1, 'first call must reach GitHub');

  const second = await fetchLatestRelease('WorldMonitor-Version-Check');
  assert.deepEqual(second, first, 'cached release must match the fresh one');
  assert.equal(githubCalls.length, 1, 'second call must be served from Redis');
});

test('a Redis outage still serves the release (fail-open on version metadata)', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { githubCalls } = installStub({ redisAvailable: false });
  const { fetchLatestRelease } = await import('../api/_github-release.js');

  const result = await fetchLatestRelease('WorldMonitor-Version-Check');
  assert.equal(result.tag_name, 'v2.4.0', 'Redis being down must not break /api/version');
  assert.equal(githubCalls.length, 1);
});

test('an unconfigured Redis still serves the release', async (t) => {
  t.after(restoreEnvironment);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const { githubCalls } = installStub();
  const { fetchLatestRelease } = await import('../api/_github-release.js');

  const result = await fetchLatestRelease('WorldMonitor-Version-Check');
  assert.equal(result.tag_name, 'v2.4.0');
  assert.equal(githubCalls.length, 1);
});
