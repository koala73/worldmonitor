import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveWebcamsPanel } from '@/components/LiveWebcamsPanel';
import { setStreamQuality } from '@/services/ai-flow-settings';
import { LIVE_VIDEO_TIMING } from '@/services/live-video/model';

import { createFakeYouTubeIframeApi, type FakeYouTubeIframeApi, type FakeYouTubePlayer } from './helpers/fake-youtube-iframe-api.mts';
import { initTestI18n } from './helpers/i18n.mts';

const loader = vi.hoisted(() => ({ api: null as FakeYouTubeIframeApi | null, blocked: false }));
const catalog = vi.hoisted(() => ({
  sources: {} as Record<string, readonly string[]>,
  original: {} as Record<string, readonly string[]>,
}));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(loader.blocked ? null : loader.api?.namespace ?? null),
}));

vi.mock('@/services/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/analytics')>()),
  track: analytics.track,
}));

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const { withFixtureWebcamCatalog } = await import('./helpers/webcam-catalog.mts');
  const fixture = withFixtureWebcamCatalog(await importOriginal<typeof import('@/config/live-video-sources')>());
  Object.assign(catalog.original, fixture.WEBCAM_SOURCES);
  Object.assign(catalog.sources, fixture.WEBCAM_SOURCES);
  return { ...fixture, WEBCAM_SOURCES: catalog.sources };
});

const HOUR = 60 * 60_000;
const WALL = ['Jerusalem live webcam', 'Middle East live webcam', 'Ukraine live webcam', 'Washington DC live webcam'];
const SWAPPED_WALL = ['Jerusalem live webcam', 'Middle East live webcam', 'Taipei live webcam', 'Washington DC live webcam'];
const RECORDING_VERDICT_MS = LIVE_VIDEO_TIMING.recordingConfirmMs + 3 * LIVE_VIDEO_TIMING.pollMs;

class FakeIntersectionObserver {
  readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
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
  observer: FakeIntersectionObserver | null;
  stopForIdle(idleAfterMs: number): void;
  refresh(): void;
  stopLiveMediaForClose(): void;
}

let panel: LiveWebcamsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function mountOnScreen(): void {
  panel = new LiveWebcamsPanel();
  document.body.appendChild(internals().element);
  const observer = internals().observer;
  if (!observer) throw new Error('webcam visibility observer missing');
  observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
}

function content(): HTMLElement {
  return internals().content;
}

function click(selector: string, root: ParentNode = internals().element): void {
  const target = root.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`nothing matches ${selector}`);
  target.click();
}

function contentButton(label: string): HTMLButtonElement {
  const match = Array.from(content().querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`no "${label}" button in panel content`);
  return match;
}

function playingFeeds(): string[] {
  return Array.from(content().querySelectorAll<HTMLIFrameElement>('.webcam-iframe')).map((iframe) => iframe.title).sort();
}

function cellFor(title: string): HTMLElement {
  const cell = content().querySelector(`.webcam-iframe[title="${title}"]`)?.closest<HTMLElement>('.webcam-cell');
  if (!cell) throw new Error(`no tile for ${title}`);
  return cell;
}

function cellById(feedId: string): HTMLElement {
  const cell = content().querySelector<HTMLElement>(`.webcam-cell[data-feed-id="${feedId}"]`);
  if (!cell) throw new Error(`no tile for ${feedId}`);
  return cell;
}

function gridFeedIds(): (string | undefined)[] {
  return Array.from(content().querySelectorAll<HTMLElement>('.webcam-cell'), (cell) => cell.dataset.feedId);
}

function offlineNote(): string | null {
  return content().querySelector('.webcam-offline-note')?.textContent ?? null;
}

function hasLiveDot(title: string): boolean {
  return cellFor(title).querySelector('.webcam-live-dot') !== null;
}

function api(): FakeYouTubeIframeApi {
  if (!loader.api) throw new Error('fake YouTube API not installed');
  return loader.api;
}

function reportEndedRecording(player: FakeYouTubePlayer): void {
  player.ready({ videoId: '-Q7FuPINDjA', isLive: false, duration: 24_181, title: 'LIVE: View of Kyiv', author: 'DW News' });
  player.setState(1);
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function playWall(): Promise<void> {
  click('.webcam-preview-play', content());
  await flush();
}

/** Plays the wall, ends Kyiv's stream as a recording, and lets Taipei take its tile live. */
async function swapOutUkraine(): Promise<void> {
  mountOnScreen();
  await playWall();
  for (const title of ['Jerusalem live webcam', 'Middle East live webcam', 'Washington DC live webcam']) api().playerFor(title).goLive();
  reportEndedRecording(api().playerFor('Ukraine live webcam'));
  await flush(RECORDING_VERDICT_MS);
  expect(playingFeeds()).toEqual(SWAPPED_WALL);
  api().playerFor('Taipei live webcam').goLive();
  await flush(LIVE_VIDEO_TIMING.pollMs);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  // Tiles carry real YouTube embed URLs; keep happy-dom from fetching them.
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  loader.api = createFakeYouTubeIframeApi();
  loader.blocked = false;
  analytics.track.mockClear();
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  for (const key of Object.keys(catalog.original)) catalog.sources[key] = catalog.original[key]!;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('Live Webcams live verification', () => {
  it('shows a neutral preview and loads no player before play intent', () => {
    mountOnScreen();
    expect(content().querySelectorAll('.webcam-preview-tile')).toHaveLength(4);
    expect(content().querySelector('.webcam-preview-status')?.textContent).toBe('Ready to play');
    expect(content().querySelector('.webcam-preview-tile .webcam-live-dot')).toBeNull();
    expect(content().querySelector('.webcam-iframe')).toBeNull();
    expect(api().players).toHaveLength(0);
  });

  it('opens the wall on the first four priority slots that have entries', () => {
    catalog.sources.kyiv = [];
    mountOnScreen();

    expect(gridFeedIds()).toEqual(['jerusalem', 'middle-east', 'washington', 'taipei']);
  });

  it('connects without a live dot until YouTube reports the stream live', async () => {
    mountOnScreen();
    await playWall();

    expect(playingFeeds()).toEqual(WALL);
    expect(content().querySelectorAll('.webcam-live-dot')).toHaveLength(0);
    expect(cellFor('Jerusalem live webcam').textContent).toContain('Connecting…');

    api().playerFor('Jerusalem live webcam').goLive();
    await flush(LIVE_VIDEO_TIMING.pollMs);

    expect(hasLiveDot('Jerusalem live webcam')).toBe(true);
    expect(cellFor('Jerusalem live webcam').textContent).not.toContain('Connecting…');
    expect(hasLiveDot('Ukraine live webcam')).toBe(false);
  });

  it('keeps the tile title when YouTube renames the frame after the video', async () => {
    mountOnScreen();
    await playWall();
    const frame = content().querySelector<HTMLIFrameElement>('.webcam-iframe[title="Jerusalem live webcam"]');
    api().playerFor('Jerusalem live webcam').goLive({ title: 'Western Wall, Temple Archaeological Park' });
    await flush(LIVE_VIDEO_TIMING.pollMs);

    expect(frame?.title).toBe('Jerusalem live webcam');
    expect(playingFeeds()).toEqual(WALL);
  });

  it('replaces an ended recording with the next feed, names the offline city, and restores the replacement after an idle stop', async () => {
    mountOnScreen();
    await playWall();
    for (const title of ['Jerusalem live webcam', 'Middle East live webcam', 'Washington DC live webcam']) api().playerFor(title).goLive();
    reportEndedRecording(api().playerFor('Ukraine live webcam'));

    await flush(LIVE_VIDEO_TIMING.pollMs * 2);
    expect(hasLiveDot('Ukraine live webcam')).toBe(false);

    await flush(RECORDING_VERDICT_MS);
    expect(playingFeeds()).toEqual(SWAPPED_WALL);
    expect(offlineNote()).toBe('Ukraine is offline right now');
    api().playerFor('Taipei live webcam').goLive();

    // The shortest idle stop (15 min) outlasts the failure memory, so Resume always comes after it expires.
    await flush(HOUR);
    contentButton('Resume').click();
    await flush();
    expect(playingFeeds()).toEqual(SWAPPED_WALL);
    expect(content().querySelector('.webcam-preview-tile')).toBeNull();
    expect(offlineNote()).toBe('Ukraine is offline right now');
  });

  it('keeps the replacement through a refresh and a stream quality change after the failure memory expires', async () => {
    await swapOutUkraine();
    await flush(LIVE_VIDEO_TIMING.failureMemoryMs + LIVE_VIDEO_TIMING.pollMs);

    internals().refresh();
    expect(playingFeeds()).toEqual(SWAPPED_WALL);
    expect(content().querySelector('.webcam-preview-tile')).toBeNull();
    expect(offlineNote()).toBe('Ukraine is offline right now');

    setStreamQuality('medium');
    expect(playingFeeds()).toEqual(SWAPPED_WALL);
    expect(content().querySelector('.webcam-preview-tile')).toBeNull();
    expect(offlineNote()).toBe('Ukraine is offline right now');
  });

  it('hands the slot to the next spare when the replacement goes offline too', async () => {
    mountOnScreen();
    await playWall();
    for (const title of ['Jerusalem live webcam', 'Middle East live webcam', 'Washington DC live webcam']) api().playerFor(title).goLive();
    reportEndedRecording(api().playerFor('Ukraine live webcam'));
    await flush(RECORDING_VERDICT_MS);

    api().playerFor('Taipei live webcam').error(150);
    await flush(LIVE_VIDEO_TIMING.pollMs);
    const chainedWall = ['Jerusalem live webcam', 'Mecca live webcam', 'Middle East live webcam', 'Washington DC live webcam'];
    expect(playingFeeds()).toEqual(chainedWall);
    expect(offlineNote()).toBe('Ukraine is offline right now');

    internals().refresh();
    expect(playingFeeds()).toEqual(chainedWall);
    expect(gridFeedIds()).toEqual(['jerusalem', 'middle-east', 'mecca', 'washington']);
  });

  it.each([
    { action: 'picking the region again', run: () => { click('.webcam-region-btn[data-region="europe"]'); click('.webcam-region-btn[data-region="all"]'); } },
    { action: 'picking the view again', run: () => { click('.webcam-view-btn[data-mode="single"]'); click('.webcam-view-btn[data-mode="grid"]'); } },
    { action: 'closing the panel', run: () => internals().stopLiveMediaForClose() },
  ])('brings the offline feed back after $action', async ({ run }) => {
    await swapOutUkraine();

    run();

    expect(gridFeedIds()).toEqual(['jerusalem', 'middle-east', 'kyiv', 'washington']);
    expect(offlineNote()).toBeNull();
  });

  it('replaces a feed YouTube refuses to embed', async () => {
    mountOnScreen();
    await playWall();

    api().playerFor('Jerusalem live webcam').error(150);
    await flush(LIVE_VIDEO_TIMING.pollMs);

    expect(playingFeeds()).toEqual(['Middle East live webcam', 'Taipei live webcam', 'Ukraine live webcam', 'Washington DC live webcam']);
    expect(content().querySelector('.webcam-offline-note')?.textContent).toBe('Jerusalem is offline right now');
    api().playerFor('Taipei live webcam').goLive();
    await flush(LIVE_VIDEO_TIMING.pollMs);
    expect(hasLiveDot('Taipei live webcam')).toBe(true);
  });

  it('never shows a live dot for a stream that reports live but never plays, and swaps it out at the deadline', async () => {
    mountOnScreen();
    await playWall();
    for (const title of ['Middle East live webcam', 'Ukraine live webcam', 'Washington DC live webcam']) api().playerFor(title).goLive();
    // A scheduled stream's waiting room: YouTube lists it as live, but the player never leaves -1.
    const scheduled = api().playerFor('Jerusalem live webcam');
    scheduled.ready({ videoId: scheduled.embeddedVideoId, isLive: true, duration: 0 });

    await flush(LIVE_VIDEO_TIMING.verdictDeadlineMs - LIVE_VIDEO_TIMING.pollMs);
    expect(hasLiveDot('Jerusalem live webcam')).toBe(false);
    expect(cellFor('Jerusalem live webcam').textContent).toContain('Connecting…');

    await flush(LIVE_VIDEO_TIMING.pollMs);
    expect(playingFeeds()).toEqual(['Middle East live webcam', 'Taipei live webcam', 'Ukraine live webcam', 'Washington DC live webcam']);
    expect(offlineNote()).toBe('Jerusalem is offline right now');
    expect(analytics.track).toHaveBeenCalledWith('live-video-attempt-failed', { slot: 'webcams/jerusalem', kind: 'video', outcome: 'not-started' });
  });

  it('keeps every tile unverified when YouTube stops reporting isLive, and reports the missing signal once', async () => {
    mountOnScreen();
    await playWall();
    for (const title of WALL) {
      const player = api().playerFor(title);
      player.ready({ videoId: player.embeddedVideoId, duration: 3_600 });
      player.setState(1);
    }

    await flush(LIVE_VIDEO_TIMING.verdictDeadlineMs);

    expect(playingFeeds()).toEqual(WALL);
    expect(offlineNote()).toBeNull();
    expect(content().querySelectorAll('.webcam-live-dot')).toHaveLength(0);
    for (const title of WALL) expect(cellFor(title).textContent).toContain('Can’t confirm this stream is live');
    const reports = analytics.track.mock.calls.filter(([event]) => event === 'live-video-signal-missing');
    expect(reports).toEqual([['live-video-signal-missing', { slot: 'webcams/jerusalem' }]]);
  });

  it('shows an offline card with Retry when no replacement feed is left', async () => {
    mountOnScreen();
    click('.webcam-region-btn[data-region="space"]');
    await playWall();
    expect(playingFeeds()).toEqual(['ISS Earth View live webcam', 'Space live webcam']);

    api().playerFor('ISS Earth View live webcam').error(150);
    await flush(LIVE_VIDEO_TIMING.pollMs);

    const iss = cellById('iss-earth');
    expect(iss.querySelector('.webcam-embed-fallback')?.textContent).toContain('ISS Earth View is offline right now');
    expect(iss.querySelector('.webcam-live-dot')).toBeNull();
    expect(iss.querySelector('.webcam-iframe')).toBeNull();

    const playersBeforeRetry = api().players.length;
    contentButton('Retry').click();
    await flush();

    expect(api().players.length).toBe(playersBeforeRetry + 1);
    expect(iss.querySelector('.webcam-embed-fallback')).toBeNull();
    expect(iss.textContent).toContain('Connecting…');
  });

  it('discloses a blocked player API instead of a live dot', async () => {
    loader.blocked = true;
    mountOnScreen();
    await playWall();
    await flush(LIVE_VIDEO_TIMING.pollMs);

    expect(playingFeeds()).toEqual(WALL);
    expect(content().querySelectorAll('.webcam-live-dot')).toHaveLength(0);
    for (const title of WALL) expect(cellFor(title).textContent).toContain('Can’t confirm this stream is live');
  });

  it('destroys every connecting session on an idle stop and resolves again on Resume', async () => {
    mountOnScreen();
    const idleTimers = vi.getTimerCount();
    await playWall();
    expect(vi.getTimerCount()).toBeGreaterThan(idleTimers);

    internals().stopForIdle(HOUR);

    expect(vi.getTimerCount()).toBe(idleTimers);
    expect(playingFeeds()).toEqual([]);
    expect(api().players.every((player) => player.destroyed)).toBe(true);

    contentButton('Resume').click();
    await flush();
    expect(playingFeeds()).toEqual(WALL);
    expect(api().players.filter((player) => !player.destroyed)).toHaveLength(4);
  });

  it('hides slots with no entries and shows an empty state for a region with none', () => {
    catalog.sources['iss-earth'] = [];
    catalog.sources['space-walk'] = [];
    mountOnScreen();

    const configured = Object.values(catalog.sources).filter((entries) => entries.length > 0).length;
    expect(internals().element.querySelector('.panel-live-count')?.textContent).toBe(String(configured));

    click('.webcam-view-btn[data-mode="single"]');
    const switcher = Array.from(content().querySelectorAll('.webcam-feed-btn')).map((button) => button.textContent);
    expect(switcher).not.toContain('Tel Aviv');
    expect(switcher).not.toContain('ISS Earth View');

    click('.webcam-view-btn[data-mode="grid"]');
    click('.webcam-region-btn[data-region="space"]');
    expect(content().querySelector('.webcam-placeholder')?.textContent).toBe('No live webcams in this region right now');
    expect(content().querySelectorAll('.webcam-preview-tile')).toHaveLength(0);
  });
});
