import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listTelegramFeed } from '../server/worldmonitor/intelligence/v1/list-telegram-feed.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(path = '/api/telegram-feed?limit=50') {
  return new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app' },
  });
}

describe('api/telegram-feed contract normalization', () => {
  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('normalizes messages[] into the browser UI contract and ignores a stale count field', async () => {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/telegram\/feed\?limit=50$/);
      assert.equal(options?.headers?.Authorization, 'Bearer test-secret');
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
    const res = await handler(makeRequest());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=120/);

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
    const res = await handler(makeRequest());
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
    const res = await handler(makeRequest());
    const data = await res.json();
    assert.equal(data.items[0].ts, new Date(1_000_000_000_000).toISOString());
  });

  it('passes through relay JSON error responses without normalizing them as empty feeds', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'rate_limited',
      retryAfter: 30,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('cache-control'), 'no-store');

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
    const res = await handler(makeRequest());
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const data = await res.json();
    assert.deepEqual(data, {
      error: 'Upstream error: HTTP 503',
      status: 503,
    });
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
