import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const TEST_KEY = 'rss-proxy-test-key';

process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { default: handler } = await import('./rss-proxy.js');

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(feedUrl) {
  return new Request(`https://api.worldmonitor.app/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`, {
    headers: {
      Origin: 'https://worldmonitor.app',
      'X-WorldMonitor-Key': TEST_KEY,
    },
  });
}

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WS_RELAY_URL;
  delete process.env.RELAY_SHARED_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test('rejects allowlisted redirect chains that escape the RSS domain allowlist on a later hop', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    if (calls.length === 1) {
      return new Response('', {
        status: 302,
        headers: { Location: 'https://www.techcrunch.com/feed' },
      });
    }
    if (calls.length === 2) {
      return new Response('', {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      });
    }
    throw new Error(`unexpected fetch after disallowed redirect: ${input}`);
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'Redirect to disallowed domain');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://techcrunch.com/feed',
    'https://www.techcrunch.com/feed',
  ]);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual']);
});

test('allows legitimate apex to www RSS canonical redirects', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    if (calls.length === 1) {
      return new Response('', {
        status: 301,
        headers: { Location: 'https://www.techcrunch.com/feed' },
      });
    }
    return new Response('<rss><channel><title>ok</title></channel></rss>', {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml' },
    });
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/rss+xml');
  assert.match(await res.text(), /<rss>/);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://techcrunch.com/feed',
    'https://www.techcrunch.com/feed',
  ]);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual']);
});

test('rejects redirects that switch away from http or https', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    return new Response('', {
      status: 302,
      headers: { Location: 'file:///etc/passwd' },
    });
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'Redirect protocol not allowed');
  assert.deepEqual(calls, [{ url: 'https://techcrunch.com/feed', redirect: 'manual' }]);
});

test('rejects direct RSS fetches that exceed the redirect limit', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    return new Response('', {
      status: 302,
      headers: { Location: `https://www.techcrunch.com/feed-hop-${calls.length}` },
    });
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 502);
  assert.equal(body.error, 'Too many redirects');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://techcrunch.com/feed',
    'https://www.techcrunch.com/feed-hop-1',
    'https://www.techcrunch.com/feed-hop-2',
    'https://www.techcrunch.com/feed-hop-3',
  ]);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual', 'manual', 'manual']);
});

test('preserves Railway relay fallback for direct-fetch transport failures', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), headers: init.headers });
    if (calls.length === 1) {
      throw new Error('direct fetch failed');
    }
    return new Response('<rss><channel><title>relay</title></channel></rss>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  };

  const feedUrl = 'https://techcrunch.com/feed';
  const res = await handler(makeRequest(feedUrl));

  assert.equal(res.status, 200);
  assert.match(await res.text(), /relay/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, feedUrl);
  assert.equal(calls[1].url, `https://relay.example.com/rss?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(calls[1].headers['x-relay-key'], 'relay-secret');
});
