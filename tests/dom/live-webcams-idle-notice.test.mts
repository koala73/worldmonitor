import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveWebcamsPanel } from '@/components/LiveWebcamsPanel';

import { createFakeYouTubeIframeApi, type FakeYouTubeIframeApi } from './helpers/fake-youtube-iframe-api.mts';
import { initTestI18n } from './helpers/i18n.mts';

const loader = vi.hoisted(() => ({ api: null as FakeYouTubeIframeApi | null }));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(loader.api?.namespace ?? null),
}));

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const { withFixtureWebcamCatalog } = await import('./helpers/webcam-catalog.mts');
  return withFixtureWebcamCatalog(await importOriginal<typeof import('@/config/live-video-sources')>());
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ALL_REGIONS_WALL = [
  'Jerusalem live webcam',
  'Middle East live webcam',
  'Ukraine live webcam',
  'Washington DC live webcam',
];

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
}

let panel: LiveWebcamsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function setOnScreen(isIntersecting: boolean): void {
  const observer = internals().observer;
  if (!observer) throw new Error('webcam visibility observer missing');
  observer.callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
}

function mountOnScreen(): LiveWebcamsPanel {
  panel = new LiveWebcamsPanel();
  document.body.appendChild(internals().element);
  setOnScreen(true);
  return panel;
}

function playingFeeds(): string[] {
  return Array.from(internals().content.querySelectorAll<HTMLIFrameElement>('.webcam-iframe'))
    .map((iframe) => iframe.title)
    .sort();
}

function previewTileCount(): number {
  return internals().content.querySelectorAll('.webcam-preview-tile').length;
}

function notice(): HTMLElement | null {
  return internals().content.querySelector('.live-media-shell--idle');
}

function contentButton(label: string): HTMLButtonElement {
  const match = Array.from(internals().content.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`no "${label}" button in panel content`);
  return match;
}

function clickPanelControl(selector: string): void {
  const control = internals().element.querySelector<HTMLButtonElement>(selector);
  if (!control) throw new Error(`no control matching ${selector}`);
  control.click();
}

function playFromPreview(): void {
  const play = internals().content.querySelector<HTMLButtonElement>('.webcam-preview-play');
  if (!play) throw new Error('no preview play button');
  play.click();
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

// Every tile is a live session now; advance async so the player API and live verdicts settle.
const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  // Tiles carry real YouTube embed URLs; keep happy-dom from fetching them.
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  loader.api = createFakeYouTubeIframeApi({ autoLive: true });
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'hidden');
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('Live Webcams idle stop', () => {
  it('leaves preview tiles untouched when nothing is playing', async () => {
    mountOnScreen();
    await elapse(2 * HOUR);
    expect(notice()).toBeNull();
    expect(previewTileCount()).toBe(4);
  });

  it('keeps the wall playing past five minutes and replaces it with a notice after an hour', async () => {
    mountOnScreen();
    playFromPreview();
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);

    await elapse(5 * MINUTE);
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
    await elapse(55 * MINUTE);

    expect(playingFeeds()).toEqual([]);
    const shown = notice();
    expect(shown?.querySelector('.live-media-shell-title')?.textContent).toBe('Live Webcams');
    expect(shown?.textContent).toContain('Live video stopped after 1 hour without mouse, keyboard or touch activity.');
  });

  it('keeps the notice through later mouse input', async () => {
    mountOnScreen();
    playFromPreview();
    await elapse(HOUR);

    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await elapse(MINUTE);

    expect(playingFeeds()).toEqual([]);
    expect(notice()).not.toBeNull();
  });

  it('restores the whole wall from Resume', async () => {
    mountOnScreen();
    playFromPreview();
    await elapse(HOUR);

    contentButton('Resume').click();

    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
    expect(notice()).toBeNull();
  });

  it('restores only the tile that was playing instead of lighting the whole wall', async () => {
    mountOnScreen();
    clickPanelControl('.webcam-view-btn[data-mode="single"]');
    playFromPreview();
    clickPanelControl('.webcam-view-btn[data-mode="grid"]');
    expect(playingFeeds()).toEqual(['Jerusalem live webcam']);
    expect(previewTileCount()).toBe(3);

    await elapse(HOUR);
    expect(notice()).not.toBeNull();
    contentButton('Resume').click();

    expect(playingFeeds()).toEqual(['Jerusalem live webcam']);
    expect(previewTileCount()).toBe(3);
  });

  it('keeps the notice across a region change, refresh, and scrolling away and back, then plays the new region', async () => {
    const mounted = mountOnScreen();
    playFromPreview();
    await elapse(HOUR);

    clickPanelControl('.webcam-region-btn[data-region="europe"]');
    expect(notice()).not.toBeNull();
    mounted.refresh();
    expect(notice()).not.toBeNull();
    setOnScreen(false);
    setOnScreen(true);
    expect(notice()).not.toBeNull();
    expect(playingFeeds()).toEqual([]);

    contentButton('Resume').click();
    expect(playingFeeds()).toEqual([
      'London live webcam',
      'Paris live webcam',
      'St. Petersburg live webcam',
      'Ukraine live webcam',
    ]);
  });

  it('keeps the notice and what was playing across a hidden tab', async () => {
    mountOnScreen();
    playFromPreview();
    await elapse(HOUR);

    setHidden(true);
    setHidden(false);
    expect(notice()).not.toBeNull();

    contentButton('Resume').click();
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
  });

  it('keeps the notice on tab return and scroll-back for an auto-play user who chose an idle duration', async () => {
    localStorage.setItem('wm-live-streams-always-on', 'true');
    localStorage.setItem('wm-live-media-idle-stop', '60');
    mountOnScreen();
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
    await elapse(HOUR);
    expect(playingFeeds()).toEqual([]);
    expect(notice()).not.toBeNull();

    setHidden(true);
    setHidden(false);
    expect(playingFeeds()).toEqual([]);
    expect(notice()).not.toBeNull();

    setOnScreen(false);
    setOnScreen(true);
    expect(playingFeeds()).toEqual([]);
    expect(notice()).not.toBeNull();

    contentButton('Resume').click();
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
    expect(notice()).toBeNull();
  });

  it('never idle-stops a fullscreen wall', async () => {
    const mounted = mountOnScreen();
    playFromPreview();
    mounted.setFullscreen(true);
    await elapse(3 * HOUR);
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
    expect(notice()).toBeNull();
  });

  it('clears the notice when the panel is closed', async () => {
    const mounted = mountOnScreen();
    playFromPreview();
    await elapse(HOUR);

    mounted.stopLiveMediaForClose();

    expect(notice()).toBeNull();
    expect(previewTileCount()).toBe(4);
  });
});
