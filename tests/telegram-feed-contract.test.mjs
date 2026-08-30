import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listTelegramFeed } from '../server/worldmonitor/intelligence/v1/list-telegram-feed.ts';
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
 * Origin alone is no longer sufficient — see the first-party boundary suite.
 */
async function makeRequest(path = '/api/telegram-feed?limit=50') {
  const { token } = await issueSessionToken();
  return new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  });
}

describe('api/telegram-feed contract normalization', () => {
  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    process.env.WM_SESSION_SECRET = SESSION_SECRET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('normalizes messages[] into the browser UI contract and ignores a stale count field', async () => {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/telegram\/feed\?limit=50$/);
      assert.equal(options?.headers?.Authorization, 'Bearer test-secret');
      assert.equal(options?.headers?.['User-Agent'], 'WorldMonitor/1.0');
      return new Response(JSON.stringify({
        enabled: true,
        source: 'relay',
        earlySignal: false,
        updatedAt: '2026-04-06T12:00:00Z',
        count: 0,
        messages: [{
          id: 123,
          channelName: 'warintel',
          channelTitle: 'War Intel',
          timestampMs: 1_744_000_000_000,
          sourceUrl: 'javascript:alert(1)',
          text: 'Missile launches reported',
          topic: 'conflict',
          tags: [42, 'urgent'],
          mediaUrls: ['https://cdn.example.com/image.jpg', 88, 'javascript:evil()'],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
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
    assert.equal(data.items[0].source, 'telegram');
    assert.equal(data.items[0].channel, 'warintel');
    assert.equal(data.items[0].channelTitle, 'War Intel');
    assert.equal(data.items[0].url, '');
    assert.equal(data.items[0].ts, new Date(1_744_000_000_000).toISOString());
    assert.deepEqual(data.items[0].tags, ['42', 'urgent']);
    assert.deepEqual(data.items[0].mediaUrls, ['https://cdn.example.com/image.jpg']);
  });

  it('synthesises distinct ids for same-second messages sharing a 32-char prefix (#7210)', async () => {
    const sharedPrefix = 'BREAKING: air raid alert issued for';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      messages: [
        // No upstream id, same channel, same whole-second timestamp, first 32
        // chars identical — the exact collision triple. Bot/templated feeds
        // produce this shape routinely.
        { channelName: 'warintel', timestamp: 1_744_000_000, text: `${sharedPrefix} Kharkiv oblast` },
        { channelName: 'warintel', timestamp: 1_744_000_000, text: `${sharedPrefix} Odesa oblast` },
        // Byte-identical duplicate of the first — a REAL duplicate that must
        // still collapse to the same id.
        { channelName: 'warintel', timestamp: 1_744_000_000, text: `${sharedPrefix} Kharkiv oblast` },
        // Upstream-supplied id must pass through untouched.
        { id: 'relay-42', channelName: 'warintel', timestamp: 1_744_000_000, text: `${sharedPrefix} Kherson oblast` },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 200);
    const data = await res.json();
    const [kharkiv, odesa, duplicate, withId] = data.items;

    assert.notEqual(
      kharkiv.id,
      odesa.id,
      'messages differing past the 32nd character must not collide',
    );
    assert.equal(kharkiv.id, duplicate.id, 'byte-identical messages still collapse');
    assert.equal(withId.id, 'relay-42', 'an upstream id is never synthesised over');
  });

  it('uses private max-age=0 when the normalized feed is empty', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 200);
    const cacheControl = res.headers.get('cache-control') || '';
    assert.equal(cacheControl, 'private, max-age=0');
    assert.doesNotMatch(cacheControl, /public|s-maxage/);
    const data = await res.json();
    assert.equal(data.count, 0);
    assert.deepEqual(data.items, []);
  });

  it('keeps the private cache posture on the raw-body fallthrough when normalization throws', async () => {
    // The one 200 path that returns the UN-normalized relay body. JSON.parse
    // succeeds on `null`, then normalizeTelegramFeed dereferences `parsed.messages`
    // and throws, so execution falls through to the raw-body return. That branch
    // carries its own Cache-Control/Vary pair; without this case, deleting either
    // one (or restoring `public, s-maxage=...` there) leaves the suite green.
    globalThis.fetch = async () => new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 200);
    const cacheControl = res.headers.get('cache-control') || '';
    // no-store, not max-age=30: reaching this branch means the handler already
    // reported the body to Sentry as un-normalizable, so caching it would keep
    // serving a payload we just flagged as invalid.
    assert.equal(cacheControl, 'no-store');
    assert.doesNotMatch(cacheControl, /public|s-maxage/);
    // Assert the FULL Vary value, not just one member: a substring check on
    // X-WorldMonitor-Key alone stays green if Origin is dropped, which would make
    // the per-Origin Access-Control-Allow-Origin unsafe for any intermediary
    // that stores the response.
    assert.equal(res.headers.get('vary'), 'Origin, Cookie, X-WorldMonitor-Key, X-Api-Key, Authorization');
    // Proves the fallthrough actually ran: the body is the raw relay payload,
    // not a normalized envelope.
    assert.equal(await res.text(), 'null');
  });

  it('returns a non-null timestamp string when relay items omit timestamps', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'abc',
        channel: 'osint',
        url: 'https://t.me/osint/1',
        text: 'No timestamp on this relay item',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    const data = await res.json();
    assert.equal(data.count, 1);
    assert.equal(data.items[0].ts, '1970-01-01T00:00:00.000Z');
  });

  it('treats an exact 1e12 timestamp value as milliseconds, not seconds', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'boundary',
        channel: 'osint',
        timestampMs: 1_000_000_000_000,
        url: 'https://t.me/osint/2',
        text: 'Boundary timestamp',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    const data = await res.json();
    assert.equal(data.items[0].ts, new Date(1_000_000_000_000).toISOString());
  });

  it('passes through relay JSON error responses without normalizing them as empty feeds', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'rate_limited',
      retryAfter: 30,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('retry-after'), '30');

    const data = await res.json();
    assert.deepEqual(data, {
      error: 'rate_limited',
      retryAfter: 30,
    });
  });

  it('wraps non-JSON relay error responses while preserving the upstream status', async () => {
    globalThis.fetch = async () => new Response('temporary overload', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const data = await res.json();
    assert.deepEqual(data, {
      error: 'Upstream error: HTTP 503',
      status: 503,
    });
  });

  it('resolves a public channel through the existing credentialed feed route', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        username: 'Ukraine_News',
        title: 'Ukraine News',
        memberCount: null,
        url: 'javascript:alert(1)',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest('/api/telegram-feed?mode=resolve&username=%40Ukraine_News'));
    const data = await res.json();

    assert.equal(requestedUrl, 'https://relay.example.com/telegram/resolve?username=ukraine_news');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
    assert.match(res.headers.get('vary') || '', /X-WorldMonitor-Key/);
    assert.deepEqual(data, {
      username: 'ukraine_news',
      title: 'Ukraine News',
      memberCount: null,
      url: 'https://t.me/ukraine_news',
    });
  });

  it('fetches a custom channel through the same normalized feed contract and cache posture', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        enabled: true,
        items: [{
          id: 'ukraine_news:1',
          channel: 'ukraine_news',
          channelTitle: 'Ukraine News',
          url: 'https://t.me/ukraine_news/1',
          ts: '2026-08-29T12:00:00.000Z',
          text: 'Update',
          topic: 'osint',
          tags: [],
          earlySignal: true,
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest('/api/telegram-feed?mode=channel&username=ukraine_news&limit=500'));
    const data = await res.json();

    assert.equal(requestedUrl, 'https://relay.example.com/telegram/channel?username=ukraine_news&limit=50');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=30');
    assert.equal(data.count, 1);
    assert.equal(data.items[0].id, 'ukraine_news:1');
  });

  it('rejects an invalid custom-channel username before contacting the relay', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('should not be called');
    };

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest('/api/telegram-feed?mode=resolve&username=bad%20handle'));

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(called, false);
  });

  it('rejects an unsupported mode before contacting the relay', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('should not be called');
    };

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest('/api/telegram-feed?mode=private&username=warintel'));

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'Invalid Telegram feed mode' });
    assert.equal(called, false);
  });

  it('fails closed when the relay returns an invalid channel preview', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      username: 'bad handle',
      title: 'Untrusted shape',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest('/api/telegram-feed?mode=resolve&username=warintel'));

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'Invalid Telegram channel response' });
  });
});

describe('api/telegram-feed first-party boundary', () => {
  // A LIVE relay stub, so every rejection below is proven against a route that
  // WOULD have served bodies. Without it a 502 would satisfy the "no text"
  // assertions for the wrong reason and the suite would be inert.
  const RELAY_BODY = JSON.stringify({
    enabled: true,
    source: 'relay',
    messages: [{
      id: 'warintel:1',
      channel: 'warintel',
      url: 'https://t.me/warintel/1',
      text: 'SECRET BODY must not leave the panel route',
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
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    return handler(new Request('https://worldmonitor.app/api/telegram-feed?limit=200', {
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
    // so `curl https://worldmonitor.app/api/telegram-feed?limit=200` collected
    // every body. CORS is browser-enforced only and never gated this.
    const res = await get({});
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that forges an allowed Origin', async () => {
    // The reason the gate is not Origin-based: Origin is client-controlled at
    // the wire level, so an Origin-only fix costs an attacker one curl -H.
    const res = await get({ origin: 'https://worldmonitor.app' });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('applies the same credential boundary to custom-channel reads', async () => {
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(new Request(
      'https://worldmonitor.app/api/telegram-feed?mode=channel&username=warintel',
      { headers: { origin: 'https://worldmonitor.app' } },
    ));

    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that forges Sec-Fetch-Site: same-origin', async () => {
    // Issue #3541 / closed PR #3554: no header-only browser signal is trusted.
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
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(new Request('https://worldmonitor.app/api/telegram-feed', {
      method: 'OPTIONS',
      headers: { origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 204);
  });
});

describe('server listTelegramFeed relay normalization', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('maps alternate relay field names into the public intelligence API contract', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      count: 0,
      items: [{
        id: 'msg-1',
        channelTitle: 'OSINT Watch',
        ts: '2026-04-06T12:30:00Z',
        url: 'https://t.me/osintwatch/1',
        text: 'Port disruption reported',
        topic: 'geopolitics',
        mediaUrls: [91, 'https://cdn.example.com/chart.png'],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.enabled, true);
    assert.equal(response.count, 1);
    assert.equal(response.messages.length, 1);
    assert.equal(response.messages[0].channelName, 'OSINT Watch');
    assert.equal(response.messages[0].sourceUrl, 'https://t.me/osintwatch/1');
    assert.equal(
      response.messages[0].timestampMs,
      Date.parse('2026-04-06T12:30:00Z'),
    );
    assert.deepEqual(response.messages[0].mediaUrls, ['https://cdn.example.com/chart.png']);
  });

  it('normalizes numeric Unix-second timestamps in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'msg-seconds',
        channel: 'osint',
        ts: 1_744_000_000,
        url: 'https://t.me/osint/seconds',
        text: 'Numeric seconds timestamp',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.count, 1);
    assert.equal(response.messages[0].timestampMs, 1_744_000_000_000);
  });

  it('filters unsafe source and media URLs in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      messages: [{
        id: 'msg-unsafe-url',
        channel: 'osint',
        timestampMs: 1_744_000_000_000,
        sourceUrl: 'javascript:alert(1)',
        text: 'Unsafe URLs should not leave the server contract',
        mediaUrls: [
          'https://cdn.example.com/photo.jpg',
          'javascript:alert(2)',
          'ftp://cdn.example.com/file.jpg',
          'not a url',
          42,
        ],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.count, 1);
    assert.equal(response.messages[0].sourceUrl, '');
    assert.deepEqual(response.messages[0].mediaUrls, ['https://cdn.example.com/photo.jpg']);
  });
});
