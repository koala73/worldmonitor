// Unit tests for scripts/lib/followed-countries-fetch.cjs.
//
// Locks in the contract that `fetchFollowedCountries(userId)` returns
// `string[]` on EVERY soft failure path (missing env, 4xx/5xx,
// transport error, malformed JSON, wrong shape) so the brief composer
// can call it without wrapping in try/catch. The bias is purely a
// soft uplift (R10 hard contract: never a hard filter); a transient
// fetch failure must degrade to today's behavior, not block the brief.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalConsoleWarn = console.warn;

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
}

// Mute console.warn output during tests — every soft-failure path
// emits a [followed-countries-fetch] line by design.
function withMutedWarn(fn) {
  return async (...args) => {
    console.warn = () => {};
    try {
      return await fn(...args);
    } finally {
      console.warn = originalConsoleWarn;
    }
  };
}

// Re-require the helper after env mutation so CONVEX_SITE_URL /
// RELAY_SECRET captures the test env. Using delete-from-cache so each
// test gets a fresh module-level constant capture.
function freshHelper() {
  const path = require.resolve('../scripts/lib/followed-countries-fetch.cjs');
  delete require.cache[path];
  return require(path);
}

describe('fetchFollowedCountries', () => {
  beforeEach(() => {
    process.env.CONVEX_SITE_URL = 'https://test.convex.site';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalConsoleWarn;
    restoreEnv();
  });

  it('happy path: 200 with {countries:["US","GB"]} → ["US","GB"]', async () => {
    let captured = null;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ countries: ['US', 'GB'] }), { status: 200 });
    };
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, ['US', 'GB']);
    assert.equal(captured.url, 'https://test.convex.site/relay/followed-countries');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-secret');
    assert.equal(captured.options.headers['Content-Type'], 'application/json');
    assert.equal(JSON.parse(captured.options.body).userId, 'user_abc');
  });

  it('happy empty: 200 with {countries:[]} → []', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ countries: [] }), { status: 200 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  });

  it('404 → [] without warn', withMutedWarn(async () => {
    globalThis.fetch = async () => new Response('', { status: 404 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  }));

  it('500 → [] (warns)', withMutedWarn(async () => {
    let warned = false;
    console.warn = (msg) => {
      if (typeof msg === 'string' && msg.includes('500')) warned = true;
    };
    globalThis.fetch = async () => new Response('boom', { status: 500 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
    assert.equal(warned, true);
  }));

  it('401 → [] (warns)', withMutedWarn(async () => {
    globalThis.fetch = async () => new Response('', { status: 401 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  }));

  it('transport error / timeout → [] (does NOT throw)', withMutedWarn(async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  }));

  it('malformed JSON → []', withMutedWarn(async () => {
    globalThis.fetch = async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  }));

  it('wrong shape: {countries:"foo"} → []', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ countries: 'foo' }), { status: 200 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  });

  it('wrong shape: top-level array → []', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(['US', 'GB']), { status: 200 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  });

  it('wrong shape: null → []', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(null), { status: 200 });
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  });

  it('non-string entries in array filtered out', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ countries: ['US', 42, null, '', 'GB', { foo: 'bar' }] }),
        { status: 200 },
      );
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, ['US', 'GB']);
  });

  it('missing CONVEX_SITE_URL → [] (no fetch attempted)', withMutedWarn(async () => {
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_URL;
    let attempted = false;
    globalThis.fetch = async () => { attempted = true; return new Response('', { status: 200 }); };
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
    assert.equal(attempted, false, 'no fetch attempted when env missing');
  }));

  it('missing RELAY_SHARED_SECRET → [] (no fetch attempted)', withMutedWarn(async () => {
    delete process.env.RELAY_SHARED_SECRET;
    let attempted = false;
    globalThis.fetch = async () => { attempted = true; return new Response('', { status: 200 }); };
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
    assert.equal(attempted, false);
  }));

  it('CONVEX_URL fallback (replaces .convex.cloud → .convex.site)', async () => {
    delete process.env.CONVEX_SITE_URL;
    process.env.CONVEX_URL = 'https://tacit-curlew-777.convex.cloud';
    let captured = null;
    globalThis.fetch = async (url) => {
      captured = url;
      return new Response(JSON.stringify({ countries: ['US'] }), { status: 200 });
    };
    const { fetchFollowedCountries } = freshHelper();
    await fetchFollowedCountries('user_abc');
    assert.equal(captured, 'https://tacit-curlew-777.convex.site/relay/followed-countries');
  });

  it('empty userId → [] (no fetch attempted)', withMutedWarn(async () => {
    let attempted = false;
    globalThis.fetch = async () => { attempted = true; return new Response('', { status: 200 }); };
    const { fetchFollowedCountries } = freshHelper();
    const result = await fetchFollowedCountries('');
    assert.deepEqual(result, []);
    assert.equal(attempted, false);
  }));

  it('non-string userId → [] (no fetch attempted)', withMutedWarn(async () => {
    let attempted = false;
    globalThis.fetch = async () => { attempted = true; return new Response('', { status: 200 }); };
    const { fetchFollowedCountries } = freshHelper();
    // @ts-expect-error testing defensive coercion
    const result = await fetchFollowedCountries(12345);
    assert.deepEqual(result, []);
    assert.equal(attempted, false);
  }));
});
