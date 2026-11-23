import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveWebcamsPanel } from '@/components/LiveWebcamsPanel';

import { createFakeYouTubeIframeApi, type FakeYouTubeIframeApi } from './helpers/fake-youtube-iframe-api.mts';
import { initTestI18n } from './helpers/i18n.mts';

// Switching to another tab tears down every webcam: they are silent, so nothing
// is lost while nobody can see them. A wall the viewer had started used to come
// back as preview tiles that needed starting again. It now comes back playing.

const loader = vi.hoisted(() => ({ api: null as FakeYouTubeIframeApi | null }));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(loader.api?.namespace ?? null),
}));

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const { withFixtureWebcamCatalog } = await import('./helpers/webcam-catalog.mts');
  return withFixtureWebcamCatalog(await importOriginal<typeof import('@/config/live-video-sources')>());
});

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
  takeRecords(): IntersectionObserverEntry[] { return []; }
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

function mountOnScreen(): void {
  panel = new LiveWebcamsPanel();
  document.body.appendChild(internals().element);
  setOnScreen(true);
}

function iframes(): HTMLIFrameElement[] {
  return Array.from(internals().content.querySelectorAll<HTMLIFrameElement>('.webcam-iframe'));
}

function playingFeeds(): string[] {
  return iframes().map((iframe) => iframe.title).sort();
}

function previewTileCount(): number {
  return internals().content.querySelectorAll('.webcam-preview-tile').length;
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

describe('Live Webcams in a hidden tab', () => {
  it('stops a wall the viewer started while hidden, and brings it back playing on return', async () => {
    mountOnScreen();
    playFromPreview();
    await vi.advanceTimersByTimeAsync(1000);
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);

    setHidden(true);
    expect(playingFeeds()).toEqual([]);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
    expect(previewTileCount()).toBe(0);
  });

  it('stops the auto-play wall while hidden and starts it again on return', async () => {
    localStorage.setItem('wm-live-streams-always-on', 'true');
    mountOnScreen();
    await vi.advanceTimersByTimeAsync(1000);
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);

    setHidden(true);
    expect(playingFeeds()).toEqual([]);

    setHidden(false);
    expect(playingFeeds()).toEqual(ALL_REGIONS_WALL);
  });

  it('shows the preview tiles on return when nothing was playing', () => {
    mountOnScreen();
    setHidden(true);
    setHidden(false);
    expect(playingFeeds()).toEqual([]);
    expect(previewTileCount()).toBe(4);
  });

  it('still stops a wall the viewer started when the panel scrolls out of view', async () => {
    mountOnScreen();
    playFromPreview();
    await vi.advanceTimersByTimeAsync(1000);

    setOnScreen(false);
    expect(playingFeeds()).toEqual([]);
  });
});
