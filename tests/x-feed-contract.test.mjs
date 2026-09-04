import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listXFeed } from '../server/worldmonitor/intelligence/v1/list-x-feed.ts';
import { issueSessionToken } from '../api/_session.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

const SESSION_SECRET = 'x'.repeat(48);

/**
 * What a real first-party panel call looks like on the wire: an allowed Origin
 * PLUS the wms_ session token the browser mints at boot and the wm-session
 * interceptor attaches to every /api/ call (src/services/wm-session.ts).
 * Origin alone is no longer sufficient — see the R4 boundary suite below.
 */
async function makeRequest(path = '/api/x-feed?limit=50') {
  const { token } = await issueSessionToken();
  return new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  });
}

describe('api/x-feed contract normalization', () => {
  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    process.env.WM_SESSION_SECRET = SESSION_SECRET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('normalizes items[] into the first-party panel contract and ignores a stale count field', async () => {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/x\/feed\?limit=50$/);
      assert.equal(options?.headers?.Authorization, 'Bearer test-secret');
      assert.equal(options?.headers?.['User-Agent'], 'WorldMonitor-X-Feed/1.0');
      return new Response(JSON.stringify({
        enabled: true,
        source: 'relay',
        earlySignal: false,
        updatedAt: '2026-08-18T12:00:00Z',
        count: 0,
        lastHealthyAt: '2026-08-18T11:55:00Z',
        coverage: { expected: 64, polled: 61, failed: 3, attempted: 64, complete: false },
        items: [{
          id: 'Reuters:123',
          postId: '123',
          account: 'Reuters',
          accountTitle: 'Reuters',
          accountId: '1652541',
          timestampMs: 1_744_000_000_000,
          url: 'javascript:alert(1)',
          text: 'Port disruption reported',
          topic: 'breaking',
          tags: [42, 'urgent'],
          hasMedia: true,
          lang: 'en',
          contentState: 'active',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 200);
    // The payload is credential-gated now, so it must never be stored by a
    // shared cache: a CDN hit precedes handler auth and would answer an
    // unauthenticated caller with the authorized bodies.
    const cacheControl = res.headers.get('cache-control') || '';
    assert.match(cacheControl, /private/);
    assert.doesNotMatch(cacheControl, /public|s-maxage/);
    assert.match(res.headers.get('vary') || '', /X-WorldMonitor-Key/);

    const data = await res.json();
    assert.equal(data.source, 'relay');
    assert.equal(data.count, 1);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].source, 'x');
    assert.equal(data.items[0].account, 'Reuters');
    assert.equal(data.items[0].accountTitle, 'Reuters');
    assert.equal(data.items[0].url, '');
    assert.equal(data.items[0].text, 'Port disruption reported');
    assert.equal(data.items[0].ts, new Date(1_744_000_000_000).toISOString());
    assert.deepEqual(data.items[0].tags, ['42', 'urgent']);
    assert.equal(data.degraded, true);
    assert.deepEqual(data.coverage, { expected: 64, polled: 61, failed: 3, attempted: 64, complete: false });
    assert.equal(data.lastHealthyAt, '2026-08-18T11:55:00Z');
  });

  it('drops tombstoned posts from the first-party panel payload', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:1',
        account: 'Reuters',
        url: 'https://x.com/Reuters/status/1',
        text: '',
        contentState: 'deleted',
      }, {
        id: 'Reuters:2',
        account: 'Reuters',
        url: 'https://x.com/Reuters/status/2',
        text: 'live post',
        contentState: 'active',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    const data = await res.json();
    assert.equal(data.count, 1);
    assert.equal(data.items[0].id, 'Reuters:2');
  });
});

describe('api/x-feed R4 first-party boundary', () => {
  // A LIVE relay stub, so every rejection below is proven against a route that
  // WOULD have served bodies. Without it a 502 would satisfy the "no text"
  // assertions for the wrong reason and the suite would be inert.
  const RELAY_BODY = JSON.stringify({
    enabled: true,
    source: 'relay',
    items: [{
      id: 'Reuters:1',
      account: 'Reuters',
      url: 'https://x.com/Reuters/status/1',
      text: 'SECRET BODY must not leave the panel route',
      contentState: 'active',
    }],
  });

  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    process.env.WM_SESSION_SECRET = SESSION_SECRET;
    globalThis.fetch = async () => new Response(RELAY_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  async function get(headers) {
    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    return handler(new Request('https://api.worldmonitor.app/api/x-feed?limit=200', {
      method: 'GET',
      headers,
    }));
  }

  // Positive control for every rejection below: the same stub, a real
  // credential, and the bodies DO come back. If this ever goes red the
  // rejections stop proving anything.
  it('serves post bodies to a credentialed first-party caller', async () => {
    const { token } = await issueSessionToken();
    const res = await get({ origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that sends no Origin at all', async () => {
    // The reported hole: isDisallowedOrigin returns false on an absent Origin,
    // so `curl https://worldmonitor.app/api/x-feed?limit=200` collected every
    // body. CORS is browser-enforced only and never gated this.
    const res = await get({});
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that forges an allowed Origin', async () => {
    // The reason the gate is not Origin-based: Origin is client-controlled at
    // the wire level, so an Origin-only fix costs an attacker one curl -H.
    const res = await get({ origin: 'https://worldmonitor.app' });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that forges Sec-Fetch-Site: same-origin', async () => {
    // Issue #3541 / closed PR #3554: no header-only browser signal is trusted.
    // The desktop sidecar strips sec-fetch-* on the way through in any case
    // (src-tauri/sidecar/local-api-server.mjs toHeaders), so trusting it would
    // admit only forgeries.
    const res = await get({ origin: 'https://worldmonitor.app', 'sec-fetch-site': 'same-origin' });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a tampered session token', async () => {
    const { token } = await issueSessionToken();
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    const res = await get({ origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': tampered });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('still answers the CORS preflight without a credential', async () => {
    // The gate sits after the OPTIONS branch on purpose: a browser cannot
    // attach credentials to a preflight, so gating it would break the panel.
    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(new Request('https://api.worldmonitor.app/api/x-feed', {
      method: 'OPTIONS',
      headers: { origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 204);
  });
});

describe('server listXFeed relay normalization', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('maps relay items into permalink + facts and never returns tweet bodies', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url)).searchParams.get('includeDeleted'), '1');
      return new Response(JSON.stringify({
      enabled: true,
      count: 0,
      items: [{
        id: 'Reuters:123',
        accountId: '1652541',
        accountTitle: 'Reuters',
        account: 'Reuters',
        ts: '2026-08-18T12:30:00Z',
        url: 'https://x.com/Reuters/status/123',
        text: 'SECRET BODY must not leave the intelligence RPC',
        topic: 'breaking',
        hasMedia: true,
        lang: 'en',
        contentState: 'active',
      }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.enabled, true);
    assert.equal(response.count, 1);
    assert.equal(response.posts.length, 1);
    assert.equal(response.posts[0].accountName, 'Reuters');
    assert.equal(response.posts[0].permalink, 'https://x.com/Reuters/status/123');
    assert.equal(response.posts[0].timestampMs, Date.parse('2026-08-18T12:30:00Z'));
    assert.ok(response.posts[0].facts.length > 0);
    assert.equal('text' in response.posts[0], false);
    assert.doesNotMatch(JSON.stringify(response), /SECRET BODY/);
  });

  it('preserves relay tombstones for RPC consumers', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:deleted',
        account: 'Reuters',
        topic: 'breaking',
        url: 'https://x.com/Reuters/status/deleted',
        text: '',
        contentState: 'deleted',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.count, 1);
    assert.equal(response.posts[0].contentState, 'deleted');
    assert.equal('text' in response.posts[0], false);
  });

  it('derives RPC facts instead of trusting relay-provided facts', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:124',
        account: 'Reuters',
        topic: 'breaking',
        url: 'https://x.com/Reuters/status/124',
        facts: ['SECRET BODY injected through relay facts'],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.deepEqual(response.posts[0].facts, [
      'Reuters posted a breaking update',
      'https://x.com/Reuters/status/124',
    ]);
    assert.doesNotMatch(JSON.stringify(response), /SECRET BODY/);
  });

  it('filters unsafe permalinks in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:unsafe',
        account: 'Reuters',
        timestampMs: 1_744_000_000_000,
        url: 'javascript:alert(1)',
        text: 'should not leak',
        topic: 'breaking',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.count, 1);
    assert.equal(response.posts[0].permalink, '');
    assert.doesNotMatch(JSON.stringify(response), /should not leak/);
  });
});
