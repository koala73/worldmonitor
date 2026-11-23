import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { getActiveLiveMedia } from '@/services/live-media-controller';
import { PANEL_COLLAPSED_KEY, invalidatePanelStorageCacheForKeys } from '@/utils/panel-storage';

import { initTestI18n } from './helpers/i18n.mts';

// Switching to another tab used to stop Live News whatever the viewer was
// doing with it. A stream someone was listening to from another tab went
// silent, and one the viewer had started needed starting again on return.
//
// With the sound on it now plays through. Muted, it still stops while hidden
// (the browser pauses muted video in a background tab anyway, and a kept
// player resumes minutes behind live), and what the viewer started comes back
// by itself on return. The same reasoning spares an audible stream from the
// idle stop.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  ensurePlayerContainer(): void;
}

let panel: LiveNewsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function mount(): void {
  panel = new LiveNewsPanel();
  const element = internals().element;
  const rect = { x: 0, y: 0, top: 0, left: 0, width: 640, height: 360, right: 640, bottom: 360, toJSON: () => ({}) };
  element.getBoundingClientRect = () => rect as DOMRect;
  document.body.appendChild(element);
}

/** Default autoplay: the panel scrolls into view and starts by itself, muted. */
function mountAutoplaying(): void {
  mount();
  FakeIntersectionObserver.latest?.intersect();
  vi.advanceTimersByTime(1100);
  expect(isPlaying()).toBe(true);
}

/** The viewer presses play on a panel that has autoplay switched off. */
function mountAndPressPlay(): void {
  localStorage.setItem('wm-live-news-autoplay', 'false');
  mount();
  const play = Array.from(internals().content.querySelectorAll('button')).find((b) => b.textContent === 'Play live feed');
  if (!play) throw new Error('no play button');
  play.click();
  expect(isPlaying()).toBe(true);
}

function player(): Element | null {
  return internals().content.querySelector('.live-news-player');
}

function isPlaying(): boolean {
  return getActiveLiveMedia('live-news') !== null && player() !== null;
}

function notice(): HTMLElement | null {
  return internals().content.querySelector('.live-media-shell--idle');
}

function toggleSound(): void {
  const btn = [...internals().element.querySelectorAll<HTMLButtonElement>('.live-mute-btn')].find((b) => b.title === 'Toggle sound');
  if (!btn) throw new Error('no sound button');
  btn.click();
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelIdleCallback', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  localStorage.clear();
  invalidatePanelStorageCacheForKeys([PANEL_COLLAPSED_KEY]);
  localStorage.setItem(
    STORAGE_KEYS.liveChannels,
    JSON.stringify({ order: ['bloomberg', 'sky'], custom: [], displayNameOverrides: {} }),
  );
  const prototype = LiveNewsPanel.prototype as unknown as { renderPlayer(): void };
  vi.spyOn(prototype, 'renderPlayer').mockImplementation(function (this: PanelInternals) {
    this.ensurePlayerContainer();
  });
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  FakeIntersectionObserver.latest = null;
  Reflect.deleteProperty(document, 'hidden');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  invalidatePanelStorageCacheForKeys([PANEL_COLLAPSED_KEY]);
});

describe('Live News in a hidden tab', () => {
  it('stops muted autoplay when the tab is hidden and starts it again on return', () => {
    mountAutoplaying();

    setHidden(true);
    expect(isPlaying()).toBe(false);

    setHidden(false);
    expect(isPlaying()).toBe(true);
  });

  it('stops a muted stream the viewer started, and restarts it on return without a click', () => {
    // Autoplay is off here, so nothing but the viewer's own start can explain the restart.
    mountAndPressPlay();

    setHidden(true);
    expect(isPlaying()).toBe(false);

    setHidden(false);
    expect(isPlaying()).toBe(true);
  });

  it('keeps what restarted as the viewer\'s own, through a second hidden tab', () => {
    mountAndPressPlay();
    setHidden(true);
    setHidden(false);
    setHidden(true);
    setHidden(false);
    expect(isPlaying()).toBe(true);
  });

  it('does not restart a stream the viewer paused before hiding the tab', () => {
    mountAndPressPlay();
    const pause = [...internals().element.querySelectorAll<HTMLButtonElement>('.live-mute-btn')].find((b) => b.title === 'Toggle playback');
    pause?.click();
    expect(isPlaying()).toBe(false);

    setHidden(true);
    setHidden(false);
    expect(isPlaying()).toBe(false);
  });

  it('does not restart into a panel that was closed while the tab was hidden', () => {
    mountAndPressPlay();
    setHidden(true);
    panel?.stopLiveMediaForClose();
    setHidden(false);
    expect(isPlaying()).toBe(false);
  });

  it('keeps playing with the sound on, and does not rebuild the player on return', () => {
    mountAutoplaying();
    toggleSound();
    const before = player();

    setHidden(true);
    expect(isPlaying()).toBe(true);
    expect(player()).toBe(before);

    setHidden(false);
    expect(player()).toBe(before);
  });

  it('keeps a stream the viewer started and unmuted', () => {
    mountAndPressPlay();
    toggleSound();
    const before = player();

    setHidden(true);
    setHidden(false);
    expect(player()).toBe(before);
  });

  it('stops autoplay the viewer unmuted and then muted again', () => {
    mountAutoplaying();
    toggleSound();
    toggleSound();

    setHidden(true);
    expect(isPlaying()).toBe(false);
  });

  it('does not start a hidden panel that was never playing', () => {
    localStorage.setItem('wm-live-news-autoplay', 'false');
    mount();
    setHidden(true);
    setHidden(false);
    expect(isPlaying()).toBe(false);
  });
});

describe('Live News idle stop and sound', () => {
  it('never idle-stops a stream playing with sound', () => {
    mountAndPressPlay();
    toggleSound();

    vi.advanceTimersByTime(10 * HOUR);
    expect(isPlaying()).toBe(true);
    expect(notice()).toBeNull();
  });

  it('idle-stops after the usual hour once the viewer mutes it', () => {
    mountAndPressPlay();
    toggleSound();
    vi.advanceTimersByTime(3 * HOUR);
    expect(isPlaying()).toBe(true);

    // Muting is itself activity, so the hour starts here.
    toggleSound();
    vi.advanceTimersByTime(HOUR - MINUTE);
    expect(isPlaying()).toBe(true);
    vi.advanceTimersByTime(MINUTE);
    expect(isPlaying()).toBe(false);
    expect(notice()).not.toBeNull();
  });

  it('still idle-stops a muted stream the viewer started', () => {
    mountAndPressPlay();
    vi.advanceTimersByTime(HOUR);
    expect(isPlaying()).toBe(false);
    expect(notice()).not.toBeNull();
  });
});
