import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  clearTelegramIntelCache,
  fetchTelegramFeed,
  fetchTelegramChannelFeed,
  fetchTelegramChannelPreview,
} from '../src/services/telegram-intel';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearTelegramIntelCache();
  let previewCalls = 0;
  let channelCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/api/telegram-feed?mode=resolve')) {
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

    if (url.includes('/api/telegram-feed?mode=channel')) {
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

  it('rejects malformed preview responses before caching them', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      username: 'bad handle',
      title: 'Invalid',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    await assert.rejects(fetchTelegramChannelPreview('invalid_preview'), /Invalid Telegram channel preview/);
  });

  it('rejects malformed channel items before applying watchlist metadata', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      source: 'telegram',
      enabled: true,
      items: { id: 'not-an-array' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    await assert.rejects(fetchTelegramChannelFeed('invalid_channel', 20), /Invalid Telegram feed response/);
  });

  it('drops a single malformed item instead of discarding the whole feed', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      source: 'telegram',
      enabled: true,
      items: [
        {
          id: 'partial_channel:1',
          channel: 'partial_channel',
          channelTitle: 'Partial Channel',
          url: 'https://t.me/partial_channel/1',
          ts: '2026-08-30T09:00:00.000Z',
          text: 'Good post',
          topic: 'osint',
          tags: [],
        },
        // Shape drift in ONE post used to throw out of the whole parse, so the
        // panel fell back to stale and then to a disabled empty state — losing
        // intel that was on screen a moment earlier.
        { id: 'partial_channel:2', channel: 'partial_channel', ts: 12345 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const feed = await fetchTelegramChannelFeed('partial_channel', 20);

    assert.equal(feed.count, 1);
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0]?.text, 'Good post');
  });

  it('treats an omitted enabled flag as enabled rather than as a dead relay', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      source: 'telegram',
      items: [{
        id: 'quiet_channel:1',
        channel: 'quiet_channel',
        channelTitle: 'Quiet Channel',
        url: 'https://t.me/quiet_channel/1',
        ts: '2026-08-30T09:00:00.000Z',
        text: 'Still live',
        topic: 'osint',
        tags: [],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const feed = await fetchTelegramChannelFeed('quiet_channel', 20);

    // `enabled === true` would render a permanent "relay not active" state over
    // a feed that is demonstrably serving posts.
    assert.equal(feed.enabled, true);
    assert.equal(feed.items.length, 1);
  });

  it('surfaces the HTTP status so transient failures read differently from bad input', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Telegram lookup is rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    })) as typeof fetch;

    await assert.rejects(
      fetchTelegramChannelPreview('busy_channel'),
      (error: unknown) => {
        const typed = error as { status?: number; retryAfterMs?: number };
        assert.equal(typed.status, 429);
        assert.equal(typed.retryAfterMs, 30_000);
        return true;
      },
    );
  });

  it('normalizes a pasted t.me URL rather than sending it to the edge verbatim', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        username: 'pasted_channel',
        title: 'Pasted Channel',
        memberCount: 10,
        url: 'https://t.me/pasted_channel',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const preview = await fetchTelegramChannelPreview('https://t.me/Pasted_Channel/');

    assert.equal(preview.username, 'pasted_channel');
    assert.match(requestedUrl, /username=pasted_channel(&|$)/);
    assert.doesNotMatch(requestedUrl, /t\.me/);
  });
});


describe('Telegram cache access generation', () => {
  for (const kind of ['feed', 'preview', 'channel'] as const) {
    it(`discards late ${kind} responses and keeps the replacement request deduplicated`, async () => {
      const payload = kind === 'preview'
        ? { username: 'epoch_channel', title: 'Fresh preview' }
        : { source: 'telegram', enabled: true, items: [] };
      const load = () => kind === 'feed' ? fetchTelegramFeed()
        : kind === 'preview' ? fetchTelegramChannelPreview('epoch_channel')
        : fetchTelegramChannelFeed('epoch_channel');
      const pending: Array<(response: Response) => void> = [];
      globalThis.fetch = (() => new Promise<Response>(resolve => pending.push(resolve))) as typeof fetch;
      const old = load();
      const rejected = assert.rejects(old, { name: 'AbortError' });
      clearTelegramIntelCache();
      const fresh = load();
      pending[0]!(Response.json(payload));
      await rejected;
      const shared = kind === 'feed' ? fresh : load();
      assert.equal(pending.length, 2);
      pending[1]!(Response.json(payload));
      await Promise.all([fresh, shared]);
      await load();
      assert.equal(pending.length, 2, 'only the fresh response populates cache');
    });
  }

  it('does not serve a captured stale channel fallback after invalidation', async () => {
    const originalNow = Date.now;
    const start = originalNow();
    try {
      globalThis.fetch = (async () => Response.json({ enabled: true, items: [] })) as typeof fetch;
      await fetchTelegramChannelFeed('stale_epoch');
      Date.now = () => start + 100_000;
      let reject!: (error: Error) => void;
      globalThis.fetch = (() => new Promise<Response>((_resolve, fail) => { reject = fail; })) as typeof fetch;
      const pending = fetchTelegramChannelFeed('stale_epoch');
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      clearTelegramIntelCache();
      reject(new Error('offline'));
      await rejected;
    } finally { Date.now = originalNow; }
  });
});
