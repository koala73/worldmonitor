import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  fetchTelegramChannelFeed,
  fetchTelegramChannelPreview,
} from '../src/services/telegram-intel';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  let previewCalls = 0;
  let channelCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/api/telegram-resolve')) {
      previewCalls++;
      return new Response(JSON.stringify({
        username: 'ukraine_news',
        title: 'Ukraine News',
        memberCount: 123456,
        url: 'https://t.me/ukraine_news',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/api/telegram-channel')) {
      channelCalls++;
      return new Response(JSON.stringify({
        source: 'telegram',
        earlySignal: true,
        enabled: true,
        count: 1,
        updatedAt: '2026-03-25T10:00:00.000Z',
        items: [{
          id: 'ukraine_news:1',
          source: 'telegram',
          channel: 'ukraine_news',
          channelTitle: 'Ukraine News',
          url: 'https://t.me/ukraine_news/1',
          ts: '2026-03-25T10:00:00.000Z',
          text: 'Update',
          topic: '',
          tags: [],
          earlySignal: true,
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  Reflect.set(globalThis, '__telegramPreviewCalls', () => previewCalls);
  Reflect.set(globalThis, '__telegramChannelCalls', () => channelCalls);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, '__telegramPreviewCalls');
  Reflect.deleteProperty(globalThis, '__telegramChannelCalls');
});

describe('telegram-intel service', () => {
  it('caches channel previews for the same username', async () => {
    const first = await fetchTelegramChannelPreview('ukraine_news');
    const second = await fetchTelegramChannelPreview('ukraine_news');

    assert.equal(first.title, 'Ukraine News');
    assert.equal(second.memberCount, 123456);
    assert.equal((Reflect.get(globalThis, '__telegramPreviewCalls') as () => number)(), 1);
  });

  it('marks watchlist channel items and defaults them to osint topic', async () => {
    const feed = await fetchTelegramChannelFeed('ukraine_news', 20);

    assert.equal(feed.count, 1);
    assert.equal(feed.items[0]?.watchlist, true);
    assert.equal(feed.items[0]?.topic, 'osint');
    assert.equal((Reflect.get(globalThis, '__telegramChannelCalls') as () => number)(), 1);
  });
});
