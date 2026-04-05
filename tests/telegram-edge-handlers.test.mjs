import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import telegramChannelHandler from '../api/telegram-channel.js';
import telegramResolveHandler from '../api/telegram-resolve.js';

const originalFetch = globalThis.fetch;
const originalRelayUrl = process.env.WS_RELAY_URL;

beforeEach(() => {
  process.env.WS_RELAY_URL = 'https://relay.example.com';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.WS_RELAY_URL = originalRelayUrl;
});

describe('telegram edge handlers', () => {
  it('rejects invalid usernames before touching the relay', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('should not be called');
    };

    const response = await telegramResolveHandler(new Request('https://worldmonitor.app/api/telegram-resolve?username=bad handle'));
    assert.equal(response.status, 400);
    assert.equal(called, false);
  });

  it('forwards valid resolve requests to the relay with long cache headers', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        username: 'ukraine_news',
        title: 'Ukraine News',
        memberCount: 123456,
        url: 'https://t.me/ukraine_news',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await telegramResolveHandler(new Request('https://worldmonitor.app/api/telegram-resolve?username=@ukraine_news'));
    const body = await response.json();

    assert.equal(requestedUrl, 'https://relay.example.com/telegram/resolve?username=@ukraine_news');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200, stale-if-error=86400');
    assert.equal(body.title, 'Ukraine News');
  });

  it('normalizes telegram channel limit before forwarding to the relay', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        source: 'telegram',
        earlySignal: true,
        enabled: true,
        count: 0,
        updatedAt: null,
        items: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await telegramChannelHandler(new Request('https://worldmonitor.app/api/telegram-channel?username=ukraine_news&limit=500'));

    assert.equal(response.status, 200);
    assert.equal(requestedUrl, 'https://relay.example.com/telegram/channel?username=ukraine_news&limit=50');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=30, s-maxage=60, stale-while-revalidate=30, stale-if-error=60');
  });
});
