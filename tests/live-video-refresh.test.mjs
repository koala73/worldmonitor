import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CATALOG } from '../scripts/check-live-video-sources.mjs';
import { MAX_REFRESH_CHANNELS, refreshChannels } from '../scripts/lib/live-video-refresh.mjs';

const channel = (id) => `https://www.youtube.com/channel/${id}`;
const ID = (n) => `UC${String(n).padStart(22, '0')}`;

describe('refreshChannels', () => {
  const catalog = {
    webcams: { kyiv: ['https://www.youtube.com/watch?v=e2gC37ILQmk', channel(ID(1))] },
    news: {
      bloomberg: ['https://bloomberg.com/media-manifest/streams/us.m3u8', 'https://www.youtube.com/watch?v=QB5BNdBFujE', channel(ID(2))],
      aljazeera: [channel(ID(3))],
      'aljazeera-copy': [channel(ID(3))],
      broken: ['@handle', 'not-a-url'],
    },
    canaries: [channel(ID(3)), channel(ID(4))],
  };

  it('lists each channel a slot lists once, in catalog order, with every slot that lists it', () => {
    assert.deepEqual(refreshChannels(catalog), [
      { channelId: ID(1), slots: ['webcams/kyiv'] },
      { channelId: ID(2), slots: ['live-news/bloomberg'] },
      { channelId: ID(3), slots: ['live-news/aljazeera', 'live-news/aljazeera-copy'] },
    ]);
  });

  it('adds the canaries only when asked, marked as canaries', () => {
    assert.deepEqual(refreshChannels(catalog, { includeCanaries: true }), [
      { channelId: ID(1), slots: ['webcams/kyiv'] },
      { channelId: ID(2), slots: ['live-news/bloomberg'] },
      { channelId: ID(3), slots: ['live-news/aljazeera', 'live-news/aljazeera-copy', 'canary/1'] },
      { channelId: ID(4), slots: ['canary/2'] },
    ]);
  });

  it('refuses a catalog with more channels than the cap', () => {
    const news = Object.fromEntries(Array.from({ length: MAX_REFRESH_CHANNELS + 1 }, (_, n) => [`slot-${n}`, [channel(ID(n))]]));
    assert.throws(() => refreshChannels({ webcams: {}, news, canaries: [] }), new RegExp(`more than ${MAX_REFRESH_CHANNELS}`));
    const atCap = Object.fromEntries(Object.entries(news).slice(0, MAX_REFRESH_CHANNELS));
    assert.equal(refreshChannels({ webcams: {}, news: atCap, canaries: [] }).length, MAX_REFRESH_CHANNELS);
  });

  it('reads the shipped catalog: every channel once, canaries only through their slots', () => {
    const channels = refreshChannels(DEFAULT_CATALOG);
    assert.ok(channels.length > 0 && channels.length <= MAX_REFRESH_CHANNELS);
    assert.equal(new Set(channels.map((entry) => entry.channelId)).size, channels.length);
    for (const { channelId, slots } of channels) {
      assert.match(channelId, /^UC[A-Za-z0-9_-]{22}$/);
      assert.ok(slots.length > 0 && slots.every((slot) => /^(webcams|live-news)\//.test(slot)), channelId);
    }
    const withCanaries = refreshChannels(DEFAULT_CATALOG, { includeCanaries: true });
    assert.ok(withCanaries.some((entry) => entry.slots.includes('canary/1')));
    assert.ok(withCanaries.some((entry) => entry.slots.includes('canary/2')));
  });
});
