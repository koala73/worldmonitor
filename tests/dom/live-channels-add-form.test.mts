import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPTIONAL_LIVE_CHANNELS, getFilteredChannelRegions, getFilteredOptionalChannels } from '@/services/live-channels';
import { STORAGE_KEYS } from '@/config';
import { LIVE_NEWS_SOURCES, type LiveNewsSlotId } from '@/config/live-video-sources';
import { initLiveChannelsWindow } from '@/live-channels-window';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/utils/user-location', () => ({ resolveUserCountryCode: async () => null }));

interface StoredChannels {
  order?: string[];
  custom?: Array<Record<string, unknown>>;
}

let fetchSpy: ReturnType<typeof vi.fn>;

function stored(): StoredChannels {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.liveChannels) ?? '{}') as StoredChannels;
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

async function add(fields: { source?: string; hls?: string; name?: string }): Promise<void> {
  input('liveChannelsHandle').value = fields.source ?? '';
  input('liveChannelsHlsUrl').value = fields.hls ?? '';
  input('liveChannelsName').value = fields.name ?? '';
  document.getElementById('liveChannelsAddBtn')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function hint(): HTMLElement | null {
  return document.getElementById('liveChannelsHandleHint');
}

function requestedUrls(): string[] {
  return fetchSpy.mock.calls.map(([url]) => String(url));
}

/** Opens channel management again over the given saved channels. */
async function reopen(order: string[], custom: Array<Record<string, unknown>>): Promise<void> {
  document.body.innerHTML = '';
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order, custom, displayNameOverrides: {} }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  await initLiveChannelsWindow(container);
}

/** Opens a channel's edit form, fills the given fields and presses Save. Returns the row's edit form. */
function saveEdit(id: string, fields: { source?: string; name?: string }): HTMLElement {
  document.querySelector<HTMLElement>(`.live-news-manage-row[data-channel-id="${id}"] .live-news-manage-row-name`)?.click();
  const row = document.querySelector<HTMLElement>('.live-news-manage-row-editing');
  if (!row) throw new Error(`edit form for ${id} did not open`);
  const source = row.querySelector<HTMLInputElement>('.live-news-manage-edit-handle');
  const name = row.querySelector<HTMLInputElement>('.live-news-manage-edit-name');
  if (fields.source !== undefined && source) source.value = fields.source;
  if (fields.name !== undefined && name) name.value = fields.name;
  row.querySelector<HTMLButtonElement>('.live-news-manage-save')?.click();
  return row;
}

const HTTPS_HINT = 'Browsers block insecure (http) streams. Paste a secure (https) stream URL';
const CHANNEL_URL_HINT = 'Paste a channel URL (youtube.com/channel/UC…) or a live video URL';

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order: ['bloomberg'], custom: [], displayNameOverrides: {} }));
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ channelName: 'DW News', title: 'DW News livestream' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const container = document.createElement('div');
  document.body.appendChild(container);
  await initLiveChannelsWindow(container);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Live channels add form', () => {
  it('stores a pasted channel URL as a channel id, without resolving anything', async () => {
    await add({ source: 'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg', name: 'DW' });

    expect(stored().custom).toEqual([{ id: 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg', name: 'DW', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }]);
    expect(stored().order).toEqual(['bloomberg', 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg']);
    expect(requestedUrls()).toEqual([]);
  });

  it.each(['@CNN', 'https://www.youtube.com/@CNN', 'https://www.youtube.com/c/CNN', 'CNN'])(
    'asks for a channel or video URL instead of looking up %s',
    async (source) => {
      await add({ source });

      expect(hint()?.hidden).toBe(false);
      expect(hint()?.textContent).toBe('Paste a channel URL (youtube.com/channel/UC…) or a live video URL');
      expect(input('liveChannelsHandle').classList.contains('invalid')).toBe(true);
      expect(stored().custom).toEqual([]);
      expect(requestedUrls().some((url) => url.includes('/api/youtube/live?channel='))).toBe(false);
    },
  );

  it('stores a pasted video URL as a video id and names it from the video', async () => {
    await add({ source: 'https://www.youtube.com/watch?v=LuKwFajn37U' });

    expect(requestedUrls()).toEqual([expect.stringContaining('/api/youtube/live?videoId=LuKwFajn37U')]);
    expect(stored().custom).toEqual([{ id: 'custom-vid-LuKwFajn37U', name: 'DW News', videoId: 'LuKwFajn37U' }]);
    expect(hint()?.hidden).toBe(true);
  });

  it('keeps an edit open and explains an unusable source instead of dropping the change', async () => {
    await add({ source: 'https://www.youtube.com/watch?v=LuKwFajn37U' });
    document.querySelector<HTMLElement>('.live-news-manage-row[data-channel-id="custom-vid-LuKwFajn37U"] .live-news-manage-row-name')?.click();
    const source = document.querySelector<HTMLInputElement>('.live-news-manage-row-editing .live-news-manage-edit-handle');
    if (!source) throw new Error('edit form did not open');
    source.value = '@CNN';
    document.querySelector<HTMLButtonElement>('.live-news-manage-row-editing .live-news-manage-save')?.click();

    const editing = document.querySelector<HTMLElement>('.live-news-manage-row-editing');
    expect(editing).not.toBeNull();
    const editHint = editing?.querySelector<HTMLElement>('.live-news-manage-hint');
    expect(editHint?.hidden).toBe(false);
    expect(editHint?.textContent).toBe('Paste a channel URL (youtube.com/channel/UC…) or a live video URL');
    expect(source.classList.contains('invalid')).toBe(true);
    expect(stored().custom).toEqual([{ id: 'custom-vid-LuKwFajn37U', name: 'DW News', videoId: 'LuKwFajn37U' }]);
  });

  it('rejects an http:// stream URL', async () => {
    await add({ hls: 'http://tv.example/live.m3u8', name: 'Local TV' });

    expect(input('liveChannelsHlsUrl').classList.contains('invalid')).toBe(true);
    expect(stored().custom).toEqual([]);
  });

  it('stores an https:// stream URL', async () => {
    await add({ hls: 'https://tv.example/live.m3u8', name: 'Local TV' });

    const custom = stored().custom ?? [];
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8' });
    expect(String(custom[0]?.id)).toMatch(/^custom-hls-/);
  });

  it('asks for the https URL of an http:// stream pasted in either field, and for a channel URL otherwise', async () => {
    await add({ source: 'http://tv.example/live.m3u8' });
    expect(hint()?.hidden).toBe(false);
    expect(hint()?.textContent).toBe(HTTPS_HINT);

    await add({ hls: 'http://tv.example/live.m3u8', name: 'Local TV' });
    expect(hint()?.hidden).toBe(false);
    expect(hint()?.textContent).toBe(HTTPS_HINT);
    expect(input('liveChannelsHlsUrl').classList.contains('invalid')).toBe(true);

    await add({ source: 'https://www.youtube.com/watch?v=tooShort' });
    expect(hint()?.textContent).toBe(CHANNEL_URL_HINT);
    expect(stored().custom).toEqual([]);
  });

  it('asks for the https URL when an edit changes a stream to http://', async () => {
    await reopen(['custom-hls-1'], [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8' }]);
    const row = saveEdit('custom-hls-1', { source: 'http://tv.example/live.m3u8' });

    const editHint = row.querySelector<HTMLElement>('.live-news-manage-hint');
    expect(row.isConnected).toBe(true);
    expect(editHint?.hidden).toBe(false);
    expect(editHint?.textContent).toBe(HTTPS_HINT);
    expect(stored().custom).toEqual([{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8' }]);
  });

  it('replaces an edited stream URL in place, keeping the stream channel id and position', async () => {
    await reopen(['bloomberg', 'custom-hls-1', 'cnn'], [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/old.m3u8' }]);
    saveEdit('custom-hls-1', { source: 'https://tv.example/new.m3u8' });

    expect(stored().order).toEqual(['bloomberg', 'custom-hls-1', 'cnn']);
    expect(stored().custom).toEqual([{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/new.m3u8' }]);
  });

  it('turns a saved handle channel into a channel URL channel in the same position', async () => {
    await reopen(['bloomberg', 'custom-foo-news', 'cnn'], [{ id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews' }]);
    saveEdit('custom-foo-news', { source: 'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg' });

    expect(stored().order).toEqual(['bloomberg', 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg', 'cnn']);
    expect(stored().custom).toEqual([{ id: 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg', name: 'Foo News', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }]);
  });

  it('renames a saved handle channel without touching its id or source', async () => {
    await reopen(['custom-foo-news'], [{ id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews' }]);
    saveEdit('custom-foo-news', { name: 'Foo 24' });

    expect(stored().order).toEqual(['custom-foo-news']);
    expect(stored().custom).toEqual([{ id: 'custom-foo-news', name: 'Foo 24', handle: '@FooNews' }]);
  });

  it('lists only built-in channels with a configured stream under Available channels', () => {
    const hasStreams = (id: string) => LIVE_NEWS_SOURCES[id as LiveNewsSlotId].length > 0;
    const playable = OPTIONAL_LIVE_CHANNELS.filter((channel) => hasStreams(channel.id));
    const streamless = OPTIONAL_LIVE_CHANNELS.filter((channel) => !hasStreams(channel.id));
    // Both kinds must exist, or this test would pass with the filter gone.
    expect(playable.length).toBeGreaterThan(0);
    expect(streamless.length).toBeGreaterThan(0);

    const cardNames = Array.from(document.querySelectorAll('.live-news-manage-card-name'), (element) => element.textContent);
    expect([...cardNames].sort()).toEqual(playable.map((channel) => channel.name).sort());
    const listedIds = getFilteredChannelRegions(null).flatMap((region) => region.channelIds);
    expect(listedIds.filter((id) => !hasStreams(id))).toEqual([]);
  });

  it('offers BBC News only where its UK-only stream plays', () => {
    const ids = (country: string) => getFilteredOptionalChannels(country).map((channel) => channel.id);
    expect(ids('GB')).toContain('bbc-news');
    expect(ids('US')).not.toContain('bbc-news');
  });
});
