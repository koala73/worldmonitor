import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORAGE_KEYS } from '@/config/variants/base';
import { customChannelEntry, loadChannelsFromStorage, saveChannelsToStorage } from '@/services/live-channels';

/**
 * The live-channels record exactly as main's channel management (src/live-channels-window.ts before the
 * live video session) wrote it: builtin ids in order, and custom channels in each shape it pushed.
 */
const MAIN_STORED = {
  order: ['bloomberg', 'custom-foo-news', 'custom-vid-AbCdEfGhIjK', 'custom-hls-1726000000000-abc', 'custom-ucxyz', 'dw'],
  custom: [
    // Handle channel. The old panel also saved the video it last scraped for it.
    { id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews', videoId: 'ScrapedVid1', isLive: true },
    // Pasted video URL.
    { id: 'custom-vid-AbCdEfGhIjK', name: 'My stream', handle: '@video', fallbackVideoId: 'AbCdEfGhIjK', useFallbackOnly: true },
    // HLS stream.
    { id: 'custom-hls-1726000000000-abc', name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8', useFallbackOnly: true },
    // Pasted /channel/UC… URL, which main saved as a handle.
    { id: 'custom-ucxyz', name: 'Channel', handle: '@UCabcdefghijklmnopqrstuv' },
  ],
  displayNameOverrides: { dw: 'Deutsche Welle' },
};

function stored(): unknown {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.liveChannels) ?? 'null');
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify(MAIN_STORED));
});

afterEach(() => {
  localStorage.clear();
});

describe('live channels saved by main', () => {
  it('load in the saved order with builtin renames kept', () => {
    const channels = loadChannelsFromStorage();

    expect(channels.map((c) => c.id)).toEqual(MAIN_STORED.order);
    expect(channels.find((c) => c.id === 'dw')?.name).toBe('Deutsche Welle');
  });

  it('play what the user added, not a stale scraped video', () => {
    const entries = Object.fromEntries(loadChannelsFromStorage().map((c) => [c.id, customChannelEntry(c)]));

    expect(entries['custom-foo-news']).toBe('@FooNews');
    expect(entries['custom-vid-AbCdEfGhIjK']).toBe('https://www.youtube.com/watch?v=AbCdEfGhIjK');
    expect(entries['custom-hls-1726000000000-abc']).toBe('https://tv.example/live.m3u8');
    expect(entries['custom-ucxyz']).toBe('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv');
  });

  it('save back in the new shape and reload unchanged', () => {
    const upgraded = loadChannelsFromStorage();
    saveChannelsToStorage(upgraded);

    expect(stored()).toMatchObject({
      order: MAIN_STORED.order,
      displayNameOverrides: { dw: 'Deutsche Welle' },
      custom: [
        { id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews' },
        { id: 'custom-vid-AbCdEfGhIjK', name: 'My stream', videoId: 'AbCdEfGhIjK' },
        { id: 'custom-hls-1726000000000-abc', name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8' },
        { id: 'custom-ucxyz', name: 'Channel', channelId: 'UCabcdefghijklmnopqrstuv' },
      ],
    });
    expect(loadChannelsFromStorage()).toEqual(upgraded);
  });
});
