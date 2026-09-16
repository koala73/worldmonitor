import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { getActiveLiveMedia } from '@/services/live-media-controller';
import { LIVE_VIDEO_TIMING } from '@/services/live-video/model';

import { createFakeYouTubeIframeApi, type FakeYouTubeIframeApi } from './helpers/fake-youtube-iframe-api.mts';
import { initTestI18n } from './helpers/i18n.mts';

interface FakeHlsInstance {
  url: string;
  destroyed: boolean;
  emit(event: string, data: unknown): void;
}

const loader = vi.hoisted(() => ({ api: null as FakeYouTubeIframeApi | null, blocked: false }));
const hlsState = vi.hoisted(() => ({ instances: [] as FakeHlsInstance[] }));
const catalog = vi.hoisted(() => ({
  news: {} as Record<string, readonly string[]>,
  original: {} as Record<string, readonly string[]>,
}));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(loader.blocked ? null : loader.api?.namespace ?? null),
}));

vi.mock('hls.js', () => {
  class FakeHls {
    static readonly Events = { LEVEL_LOADED: 'hlsLevelLoaded', ERROR: 'hlsError' };
    static isSupported(): boolean {
      return true;
    }

    url = '';
    destroyed = false;
    private readonly handlers = new Map<string, (event: string, data: unknown) => void>();

    constructor() {
      hlsState.instances.push(this);
    }

    on(event: string, handler: (event: string, data: unknown) => void): void {
      this.handlers.set(event, handler);
    }

    loadSource(url: string): void {
      this.url = url;
    }

    attachMedia(): void {}

    destroy(): void {
      this.destroyed = true;
    }

    emit(event: string, data: unknown): void {
      this.handlers.get(event)?.(event, data);
    }
  }
  return { default: FakeHls };
});

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/config/live-video-sources')>();
  Object.assign(catalog.original, real.LIVE_NEWS_SOURCES);
  Object.assign(catalog.news, real.LIVE_NEWS_SOURCES);
  return { ...real, LIVE_NEWS_SOURCES: catalog.news };
});

const HOUR = 60 * 60_000;
const POLL = LIVE_VIDEO_TIMING.pollMs;
const RECORDING_VERDICT_MS = LIVE_VIDEO_TIMING.recordingConfirmMs + 3 * LIVE_VIDEO_TIMING.pollMs;
const BLOOMBERG_HLS = 'https://streams.example/bloomberg/live.m3u8';

class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | null = null;
  readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.latest = this;
  }

  intersect(): void {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  channels: Array<{ id: string }>;
  switchChannel(channel: { id: string }): void;
}

let panel: LiveNewsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function mount(order: string[], options: { custom?: unknown[]; active?: string } = {}): void {
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order, custom: options.custom ?? [], displayNameOverrides: {} }));
  if (options.active) localStorage.setItem(STORAGE_KEYS.activeChannel, JSON.stringify(options.active));
  panel = new LiveNewsPanel();
  document.body.appendChild(internals().element);
}

function content(): HTMLElement {
  return internals().content;
}

/** Saves the one custom stream the way channel management does after an edit that keeps its id. */
function saveCustomStream(hlsUrl: string, name = 'Local TV'): void {
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order: ['custom-hls-1'], custom: [{ id: 'custom-hls-1', name, hlsUrl }], displayNameOverrides: {} }));
}

function contentButton(label: string): HTMLButtonElement {
  const match = Array.from(content().querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`no "${label}" button in panel content`);
  return match;
}

function headerButton(title: string): HTMLButtonElement {
  const match = internals().element.querySelector<HTMLButtonElement>(`.panel-header button[title="${title}"]`);
  if (!match) throw new Error(`no "${title}" header button`);
  return match;
}

function channelButton(id: string): HTMLButtonElement {
  const match = internals().element.querySelector<HTMLButtonElement>(`.live-channel-btn[data-channel-id="${id}"]`);
  if (!match) throw new Error(`no channel button for ${id}`);
  return match;
}

function status(): HTMLElement | null {
  return content().querySelector('.live-news-status');
}

function offlineText(): string | null | undefined {
  return content().querySelector('.live-offline .offline-text')?.textContent;
}

function savedActiveChannel(): unknown {
  const raw = localStorage.getItem(STORAGE_KEYS.activeChannel);
  return raw === null ? null : JSON.parse(raw);
}

function showsPlayIcon(): boolean {
  return headerButton('Toggle playback').querySelector('polygon') !== null;
}

function api(): FakeYouTubeIframeApi {
  if (!loader.api) throw new Error('fake YouTube API not installed');
  return loader.api;
}

function latestHls(): FakeHlsInstance {
  const instance = hlsState.instances[hlsState.instances.length - 1];
  if (!instance) throw new Error('no HLS stream was loaded');
  return instance;
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function playFromPlaceholder(): Promise<void> {
  contentButton('Play live feed').click();
  await flush();
}

function mediaVideo(): HTMLVideoElement {
  const video = content().querySelector<HTMLVideoElement>('video.live-news-media');
  if (!video) throw new Error('no HLS video element mounted');
  return video;
}

/** A live playlist counts as live only once the media clock has played a full second. */
async function playHlsLive(): Promise<void> {
  latestHls().emit('hlsLevelLoaded', { details: { live: true } });
  await flush(POLL);
  mediaVideo().currentTime += 1;
  await flush(POLL);
}

/** Bloomberg live, then an explicit switch to CNN that ends offline: its button is marked and its failure remembered. */
async function cnnGoesOffline(): Promise<void> {
  await playFromPlaceholder();
  await playHlsLive();
  channelButton('cnn').click();
  await flush();
  api().playerFor('CNN live feed').error(150);
  await flush(POLL);
  expect(channelButton('cnn').classList.contains('offline')).toBe(true);
}

/** Bloomberg's only entry fails, so its offline card lists the channels it is still willing to try. */
async function bloombergOfflineActions(): Promise<(string | null)[]> {
  channelButton('bloomberg').click();
  await flush();
  latestHls().emit('hlsError', { fatal: true, details: 'manifestLoadError' });
  await flush(POLL);
  return Array.from(content().querySelectorAll('button')).map((button) => button.textContent);
}

let clock = Date.UTC(2030, 0, 1);

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  // Players carry real YouTube embed URLs; keep happy-dom from fetching them.
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  // Failure memory is page-wide, so start each test a day past anything an earlier test remembered.
  clock += 24 * HOUR;
  vi.setSystemTime(clock);
  localStorage.clear();
  loader.api = createFakeYouTubeIframeApi();
  loader.blocked = false;
  hlsState.instances.length = 0;
  catalog.news.bloomberg = [BLOOMBERG_HLS, 'https://www.youtube.com/watch?v=QB5BNdBFujE'];
  catalog.news.cnn = ['https://www.youtube.com/watch?v=GotlA1KKWoo'];
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  for (const key of Object.keys(catalog.original)) catalog.news[key] = catalog.original[key]!;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('Live News live verification', () => {
  it('loads no player or stream before play intent', () => {
    mount(['bloomberg', 'cnn']);
    expect(api().players).toHaveLength(0);
    expect(hlsState.instances).toHaveLength(0);
    expect(content().textContent).toContain('Ready when you are');
  });

  it('plays a broadcaster HLS stream natively and clears the connecting cover only once it is live', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();

    const video = content().querySelector<HTMLVideoElement>('video.live-news-media');
    expect(video?.title).toBe('Bloomberg live feed');
    expect(api().players).toHaveLength(0);
    expect(latestHls().url).toBe(BLOOMBERG_HLS);
    expect(status()?.textContent).toBe('Connecting to Bloomberg…');

    // A live playlist alone is not enough: the media clock has to play a full second.
    latestHls().emit('hlsLevelLoaded', { details: { live: true } });
    await flush(LIVE_VIDEO_TIMING.pollMs);
    expect(status()?.textContent).toBe('Connecting to Bloomberg…');
    mediaVideo().currentTime += 1;
    await flush(LIVE_VIDEO_TIMING.pollMs);

    expect(status()).toBeNull();
    expect(channelButton('bloomberg').classList.contains('offline')).toBe(false);
  });

  it('falls back to the verified YouTube stream when the HLS stream fails, and keeps the frame title', async () => {
    mount(['bloomberg']);
    await playFromPlaceholder();

    latestHls().emit('hlsError', { fatal: true, details: 'manifestLoadError' });
    await flush(POLL);

    expect(content().querySelector('video.live-news-media')).toBeNull();
    const player = api().playerFor('Bloomberg live feed');
    expect(player.embeddedVideoId).toBe('QB5BNdBFujE');
    player.goLive({ title: 'Bloomberg Business News Live' });
    await flush(POLL);

    expect(status()).toBeNull();
    expect(player.iframe.title).toBe('Bloomberg live feed');
  });

  it('explains why an explicitly chosen channel is offline and offers Retry, the next channel and YouTube', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();
    await playHlsLive();

    channelButton('cnn').click();
    await flush();
    expect(channelButton('cnn').getAttribute('aria-busy')).toBe('true');
    api().playerFor('CNN live feed').error(150);
    await flush(POLL);

    expect(channelButton('cnn').getAttribute('aria-busy')).toBeNull();
    expect(offlineText()).toBe('YouTube won’t play CNN inside other sites right now');
    expect(content().querySelector<HTMLAnchorElement>('.live-offline a.offline-retry')?.href).toBe('https://www.youtube.com/watch?v=GotlA1KKWoo');
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);
    expect(showsPlayIcon()).toBe(true);
    expect(savedActiveChannel()).toBe('cnn');

    const playersBeforeRetry = api().players.length;
    contentButton('Retry').click();
    await flush();
    expect(api().players.length).toBe(playersBeforeRetry + 1);
    expect(status()?.textContent).toBe('Connecting to CNN…');

    api().playerFor('CNN live feed').error(150);
    await flush(POLL);
    contentButton('Play next channel').click();
    await flush();
    expect(channelButton('bloomberg').classList.contains('active')).toBe(true);
    expect(savedActiveChannel()).toBe('bloomberg');
  });

  it('skips an offline channel on an implicit start without saving the channel it lands on', async () => {
    mount(['cnn', 'bloomberg'], { active: 'cnn' });
    await playFromPlaceholder();

    api().playerFor('CNN live feed').error(150);
    await flush(POLL);

    expect(content().querySelector('.live-offline')).toBeNull();
    expect(channelButton('bloomberg').classList.contains('active')).toBe(true);
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('bloomberg');
    expect(content().querySelector('video.live-news-media')?.getAttribute('title')).toBe('Bloomberg live feed');
    expect(savedActiveChannel()).toBe('cnn');
  });

  it('keeps offline channel marks when switching without playback intent', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();
    await playHlsLive();

    channelButton('cnn').click();
    await flush();
    api().playerFor('CNN live feed').error(150);
    await flush(POLL);
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);

    // Stop ownership so the next switch is preview-only (no playback intent).
    headerButton('Toggle playback').click();
    await flush();

    const bloomberg = internals().channels.find((channel) => channel.id === 'bloomberg');
    if (!bloomberg) throw new Error('bloomberg channel missing');
    internals().switchChannel(bloomberg);
    await flush();

    expect(channelButton('bloomberg').classList.contains('active')).toBe(true);
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);
  });

  it('keeps connecting and offline marks when the switcher is rebuilt from storage', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();
    await playHlsLive();

    channelButton('cnn').click();
    await flush();
    panel?.refreshChannelsFromStorage();
    expect(channelButton('cnn').getAttribute('aria-busy')).toBe('true');

    api().playerFor('CNN live feed').error(150);
    await flush(POLL);
    panel?.refreshChannelsFromStorage();
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);
  });

  it('forgets a channel found offline once it comes back unverified', async () => {
    catalog.news.bloomberg = [BLOOMBERG_HLS];
    mount(['bloomberg', 'cnn']);
    await cnnGoesOffline();

    // CNN plays again, but a tracking-protection browser blocks the player API, so it stays unverified.
    loader.blocked = true;
    contentButton('Retry').click();
    await flush(POLL);
    expect(status()?.textContent).toContain('Can’t confirm this stream is live');
    expect(channelButton('cnn').classList.contains('offline')).toBe(false);

    expect(await bloombergOfflineActions()).toContain('Play next channel');
  });

  it('forgets a channel found offline once it comes back as a recording', async () => {
    catalog.news.bloomberg = [BLOOMBERG_HLS];
    // Only a user-added video plays on as a recording, so the recovering channel is a custom one.
    mount(['bloomberg', 'custom-vid-AbCdEfGhIjK'], {
      custom: [{ id: 'custom-vid-AbCdEfGhIjK', name: 'My stream', handle: '@video', fallbackVideoId: 'AbCdEfGhIjK', useFallbackOnly: true }],
    });
    await playFromPlaceholder();
    await playHlsLive();

    channelButton('custom-vid-AbCdEfGhIjK').click();
    await flush();
    api().playerFor('My stream live feed').error(150);
    await flush(POLL);
    expect(channelButton('custom-vid-AbCdEfGhIjK').classList.contains('offline')).toBe(true);

    contentButton('Retry').click();
    await flush();
    const player = api().playerFor('My stream live feed');
    player.ready({ videoId: 'AbCdEfGhIjK', isLive: false, duration: 5_400, title: 'Yesterday' });
    player.setState(1);
    await flush(RECORDING_VERDICT_MS);
    expect(status()?.textContent).toBe('Recording');

    expect(await bloombergOfflineActions()).toContain('Play next channel');
  });

  it('never plays a next channel that was removed while the offline card was showing', async () => {
    mount(['bloomberg', 'cnn']);
    await cnnGoesOffline();
    expect(contentButton('Play next channel')).toBeTruthy();

    // The viewer removes Bloomberg in Manage channels while CNN's offline card is up.
    localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order: ['cnn'], custom: [], displayNameOverrides: {} }));
    panel?.refreshChannelsFromStorage();
    await flush();
    contentButton('Play next channel').click();
    await flush();

    expect(savedActiveChannel()).toBe('cnn');
    expect(content().querySelector('video.live-news-media')).toBeNull();
  });

  it('plays a legacy custom channel saved as a handle that is really a channel id', async () => {
    mount(['custom-ucknlredhrcp1aegomqraczg'], {
      custom: [{ id: 'custom-ucknlredhrcp1aegomqraczg', name: 'DW', handle: '@UCknLrEdhRCp1aegoMqRaCZg' }],
    });
    await playFromPlaceholder();

    expect(content().querySelector('.live-offline')).toBeNull();
    expect(api().playerFor('DW live feed').embeddedVideoId).toBe('live_stream');
  });

  it('asks for a channel URL for a saved handle-only custom channel, without resolving the handle', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mount(['custom-foo-news'], { custom: [{ id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews' }] });
    await playFromPlaceholder();

    expect(offlineText()).toBe('Add Foo News again with its channel URL (youtube.com/channel/UC…) or a live video URL');
    expect(contentButton('Manage channels')).toBeTruthy();
    expect(api().players).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a saved handle channel whose id carries a stream, video or channel prefix, and asks for its channel URL', async () => {
    // Before channel URLs, a handle was saved as custom-<handle>, so @hls-news became custom-hls-news.
    for (const [id, name, handle] of [
      ['custom-hls-news', 'HLS News', '@hls-news'],
      ['custom-vid-x', 'Vid X', '@vid-x'],
      ['custom-uc-desk', 'UC Desk', '@uc-desk'],
    ] as const) {
      panel?.destroy();
      document.body.innerHTML = '';
      mount([id], { custom: [{ id, name, handle }] });
      expect(channelButton(id)).toBeTruthy();

      await playFromPlaceholder();
      expect(offlineText()).toBe(`Add ${name} again with its channel URL (youtube.com/channel/UC…) or a live video URL`);
    }
    expect(hlsState.instances).toHaveLength(0);
    expect(api().players).toHaveLength(0);
  });

  it('plays a user-added ended video labelled as a recording, never as live', async () => {
    mount(['custom-vid-AbCdEfGhIjK'], {
      custom: [{ id: 'custom-vid-AbCdEfGhIjK', name: 'My stream', handle: '@video', fallbackVideoId: 'AbCdEfGhIjK', useFallbackOnly: true }],
    });
    await playFromPlaceholder();

    const player = api().playerFor('My stream live feed');
    player.ready({ videoId: 'AbCdEfGhIjK', isLive: false, duration: 5_400, title: 'Yesterday' });
    player.setState(1);
    await flush(RECORDING_VERDICT_MS);

    expect(status()?.textContent).toBe('Recording');
    expect(player.destroyed).toBe(false);
    expect(content().querySelector('.live-offline')).toBeNull();
  });

  it('refuses a user-added http:// stream with an explanation', async () => {
    mount(['custom-hls-1'], { custom: [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'http://tv.example/live.m3u8', useFallbackOnly: true }] });
    await playFromPlaceholder();

    expect(offlineText()).toBe('Local TV uses an insecure (http) stream, which browsers block. Add it again with a secure (https) stream URL');
    expect(hlsState.instances).toHaveLength(0);
  });

  it('unmutes the player from the header sound button', async () => {
    catalog.news.bloomberg = ['https://www.youtube.com/watch?v=QB5BNdBFujE'];
    mount(['bloomberg']);
    await playFromPlaceholder();
    const player = api().playerFor('Bloomberg live feed');
    player.goLive();
    await flush(POLL);

    headerButton('Toggle sound').click();

    expect(player.muted).toBe(false);
  });

  it('leaves a stream the viewer paused alone at the idle stop', async () => {
    mount(['bloomberg']);
    await playFromPlaceholder();
    await playHlsLive();

    content().querySelector('video.live-news-media')?.dispatchEvent(new Event('pause'));
    await flush(2 * HOUR);

    expect(content().querySelector('.live-media-shell--idle')).toBeNull();
    expect(getActiveLiveMedia('live-news')).not.toBeNull();
    expect(showsPlayIcon()).toBe(true);
  });

  it('discloses a blocked player API instead of claiming the stream is live', async () => {
    loader.blocked = true;
    mount(['cnn']);
    await playFromPlaceholder();
    await flush(POLL);

    expect(status()?.textContent).toContain('Can’t confirm this stream is live');
    expect(content().querySelector('iframe[title="CNN live feed"]')).not.toBeNull();
  });

  it('destroys the previous channel’s player when switching to another channel', async () => {
    mount(['cnn', 'bloomberg'], { active: 'cnn' });
    await playFromPlaceholder();
    const cnn = api().playerFor('CNN live feed');
    cnn.goLive();
    await flush(POLL);

    channelButton('bloomberg').click();
    await flush();

    expect(cnn.destroyed).toBe(true);
    expect(content().querySelectorAll('iframe, video.live-news-media')).toHaveLength(1);
    expect(content().querySelector('video.live-news-media')?.getAttribute('title')).toBe('Bloomberg live feed');

    // A verdict the replaced player reports late belongs to a channel the viewer already left.
    await playHlsLive();
    cnn.error(150);
    await flush(POLL);
    expect(status()).toBeNull();
    expect(content().querySelector('.live-offline')).toBeNull();
    expect(channelButton('cnn').classList.contains('offline')).toBe(false);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('bloomberg');
  });

  it('offers the next channel but no Retry for a channel with no stream set up', async () => {
    catalog.news.cnn = [];
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();
    await playHlsLive();

    channelButton('cnn').click();
    await flush();

    expect(offlineText()).toBe('No live stream is set up for CNN yet');
    const labels = Array.from(content().querySelectorAll('button')).map((button) => button.textContent);
    expect(labels).not.toContain('Retry');
    expect(labels).toContain('Play next channel');
  });

  it('keeps focus on a channel button while its stream connects and ignores repeat clicks', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();
    await playHlsLive();

    const cnn = channelButton('cnn');
    cnn.focus();
    cnn.click();
    await flush();

    expect(document.activeElement).toBe(cnn);
    expect(cnn.disabled).toBe(false);
    expect(cnn.getAttribute('aria-busy')).toBe('true');
    expect(cnn.getAttribute('aria-disabled')).toBe('true');
    const players = api().players.length;
    cnn.click();
    await flush();
    expect(api().players.length).toBe(players);

    api().playerFor('CNN live feed').goLive();
    await flush(POLL);
    expect(cnn.getAttribute('aria-busy')).toBeNull();
    expect(cnn.getAttribute('aria-disabled')).toBeNull();
  });

  it('moves playback to the next channel when the playing channel is removed from saved channels', async () => {
    mount(['cnn', 'bloomberg'], { active: 'cnn' });
    await playFromPlaceholder();
    const cnn = api().playerFor('CNN live feed');
    cnn.goLive();
    await flush(POLL);

    localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order: ['bloomberg'], custom: [], displayNameOverrides: {} }));
    panel?.refreshChannelsFromStorage();
    await flush();

    expect(cnn.destroyed).toBe(true);
    expect(internals().element.querySelector('.live-channel-btn[data-channel-id="cnn"]')).toBeNull();
    expect(channelButton('bloomberg').classList.contains('active')).toBe(true);
    expect(savedActiveChannel()).toBe('bloomberg');
    expect(latestHls().url).toBe(BLOOMBERG_HLS);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('bloomberg');
  });

  it('restarts a playing custom stream on its new URL when an edit keeps the channel id', async () => {
    mount(['custom-hls-1'], { custom: [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/old.m3u8' }] });
    await playFromPlaceholder();
    await playHlsLive();
    const old = latestHls();

    // A rename leaves the running stream alone.
    saveCustomStream('https://tv.example/old.m3u8', 'Local TV 2');
    panel?.refreshChannelsFromStorage();
    await flush();
    expect(old.destroyed).toBe(false);
    expect(hlsState.instances).toHaveLength(1);

    saveCustomStream('https://tv.example/new.m3u8');
    panel?.refreshChannelsFromStorage();
    await flush();

    expect(old.destroyed).toBe(true);
    expect(latestHls().url).toBe('https://tv.example/new.m3u8');
    expect(content().querySelectorAll('video.live-news-media')).toHaveLength(1);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('custom-hls-1');
  });

  it('plays the edited URL next time without starting a stopped custom stream', async () => {
    mount(['custom-hls-1'], { custom: [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/old.m3u8' }] });

    saveCustomStream('https://tv.example/new.m3u8');
    panel?.refreshChannelsFromStorage();
    await flush();
    expect(hlsState.instances).toHaveLength(0);

    await playFromPlaceholder();
    expect(latestHls().url).toBe('https://tv.example/new.m3u8');
  });

  it('keeps an idle stop when the panel scrolls back into view for an auto-play user', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal('cancelIdleCallback', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    localStorage.setItem('wm-live-streams-always-on', 'true');
    localStorage.setItem('wm-live-media-idle-stop', '60');
    mount(['bloomberg']);
    await playFromPlaceholder();
    await playHlsLive();

    await flush(HOUR);
    expect(content().querySelector('.live-media-shell--idle')).not.toBeNull();
    const loads = hlsState.instances.length + api().players.length;

    // Off screen, so showing the panel again waits for it to scroll into view.
    panel?.resumeLiveMediaForShow();
    FakeIntersectionObserver.latest?.intersect();
    await flush(2_000);

    expect(hlsState.instances.length + api().players.length).toBe(loads);
    expect(getActiveLiveMedia('live-news')).toBeNull();
    expect(content().querySelector('.live-media-shell--idle')).not.toBeNull();
  });

  it('never clears the cover for a live playlist that does not play, and falls through to the next entry', async () => {
    mount(['bloomberg']);
    await playFromPlaceholder();
    // hls.js reports a live playlist, but the media clock never moves (a codec the browser cannot decode).
    latestHls().emit('hlsLevelLoaded', { details: { live: true } });

    for (let elapsed = POLL; elapsed < LIVE_VIDEO_TIMING.verdictDeadlineMs; elapsed += POLL) {
      await flush(POLL);
      expect(status()?.textContent).toBe('Connecting to Bloomberg…');
    }
    await flush(POLL);

    expect(content().querySelector('video.live-news-media')).toBeNull();
    const player = api().playerFor('Bloomberg live feed');
    expect(player.embeddedVideoId).toBe('QB5BNdBFujE');
    expect(status()?.textContent).toBe('Connecting to Bloomberg…');

    player.goLive();
    await flush(POLL);
    expect(status()).toBeNull();
  });

  it('plays the edited channel in its place when an edit from its offline card changes the channel id', async () => {
    mount(['bloomberg', 'custom-foo-news'], { custom: [{ id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews' }] });
    await playFromPlaceholder();
    await playHlsLive();
    channelButton('custom-foo-news').click();
    await flush();
    expect(offlineText()).toBe('Add Foo News again with its channel URL (youtube.com/channel/UC…) or a live video URL');

    // Manage channels replaces the handle with a channel URL, which gives the row a new id.
    const replacementId = 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg';
    localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({
      order: ['bloomberg', replacementId],
      custom: [{ id: replacementId, name: 'Foo News', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }],
      displayNameOverrides: {},
    }));
    panel?.refreshChannelsFromStorage();
    await flush();

    expect(channelButton(replacementId).classList.contains('active')).toBe(true);
    expect(savedActiveChannel()).toBe(replacementId);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe(replacementId);
    expect(api().playerFor('Foo News live feed').embeddedVideoId).toBe('live_stream');
    expect(content().querySelector('.live-offline')).toBeNull();
  });

  it('replaces the insecure-stream card with the stream once an edit gives it an https URL', async () => {
    mount(['custom-hls-1'], { custom: [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'http://tv.example/live.m3u8' }] });
    await playFromPlaceholder();
    expect(offlineText()).toBe('Local TV uses an insecure (http) stream, which browsers block. Add it again with a secure (https) stream URL');

    saveCustomStream('https://tv.example/live.m3u8');
    panel?.refreshChannelsFromStorage();
    await flush();

    expect(content().querySelector('.live-offline')).toBeNull();
    expect(latestHls().url).toBe('https://tv.example/live.m3u8');
    expect(content().querySelectorAll('video.live-news-media')).toHaveLength(1);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('custom-hls-1');
  });

  it('asks for a channel URL for a saved handle channel that older versions stored with a resolved video or YouTube manifest', async () => {
    // Older versions wrote the video and manifest they scraped for a handle onto the saved channel.
    for (const [record, name] of [
      [{ id: 'custom-foo', name: 'Foo', handle: '@Foo', videoId: 'AbCdEfGhIjK', isLive: true }, 'Foo'],
      [{ id: 'custom-bar', handle: '@Bar', hlsUrl: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8' }, '@Bar'],
    ] as const) {
      panel?.destroy();
      document.body.innerHTML = '';
      mount([record.id], { custom: [record] });
      await playFromPlaceholder();

      expect(offlineText()).toBe(`Add ${name} again with its channel URL (youtube.com/channel/UC…) or a live video URL`);
    }
    expect(api().players).toHaveLength(0);
    expect(hlsState.instances).toHaveLength(0);
  });

  it('still plays a video and a stream that older versions saved with their fallback fields', async () => {
    mount(['custom-vid-AbCdEfGhIjK'], {
      custom: [{ id: 'custom-vid-AbCdEfGhIjK', name: 'My stream', handle: '@video', fallbackVideoId: 'AbCdEfGhIjK', useFallbackOnly: true, videoId: 'AbCdEfGhIjK', isLive: false }],
    });
    await playFromPlaceholder();
    expect(api().playerFor('My stream live feed').embeddedVideoId).toBe('AbCdEfGhIjK');

    panel?.destroy();
    document.body.innerHTML = '';
    mount(['custom-hls-1'], { custom: [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8', useFallbackOnly: true }] });
    await playFromPlaceholder();
    expect(latestHls().url).toBe('https://tv.example/live.m3u8');
    expect(content().querySelector('.live-offline')).toBeNull();
  });

  it('makes the channel an implicit start landed on the viewer’s choice when its button is clicked, without restarting it', async () => {
    catalog.news.bloomberg = [BLOOMBERG_HLS];
    mount(['cnn', 'bloomberg', 'dw'], { active: 'cnn' });
    await playFromPlaceholder();
    api().playerFor('CNN live feed').error(150);
    await flush(POLL);
    const video = mediaVideo();
    const streams = hlsState.instances.length;

    channelButton('bloomberg').click();
    await flush();

    expect(savedActiveChannel()).toBe('bloomberg');
    expect(mediaVideo()).toBe(video);
    expect(hlsState.instances).toHaveLength(streams);

    // Chosen explicitly now, so going offline explains itself instead of moving on to DW.
    latestHls().emit('hlsError', { fatal: true, details: 'manifestLoadError' });
    await flush(POLL);
    expect(offlineText()).toBe('Bloomberg can’t be played right now');
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('bloomberg');
    expect(hlsState.instances).toHaveLength(streams);
  });

  it('hands an implicit start past a channel with no stream to the next one in the same call, leaving one player', async () => {
    catalog.news.cnn = [];
    mount(['cnn', 'bloomberg'], { active: 'cnn' });
    await playFromPlaceholder();

    const media = content().querySelectorAll('iframe, video.live-news-media');
    expect(media).toHaveLength(1);
    expect(media[0]?.getAttribute('title')).toBe('Bloomberg live feed');
    expect(latestHls().url).toBe(BLOOMBERG_HLS);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('bloomberg');
    expect(savedActiveChannel()).toBe('cnn');
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);

    const stream = latestHls();
    headerButton('Toggle playback').click();
    await flush();
    expect(stream.destroyed).toBe(true);
    expect(content().querySelectorAll('iframe, video.live-news-media')).toHaveLength(0);
  });
});
