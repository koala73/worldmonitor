import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { getActiveLiveMedia } from '@/services/live-media-controller';
import { PANEL_COLLAPSED_KEY, invalidatePanelStorageCacheForKeys } from '@/utils/panel-storage';

import { initTestI18n } from './helpers/i18n.mts';

// Live News autoplays by default. A viewer who collapsed the panel keeps its
// header on screen, so the on-screen checks alone would start a video inside
// hidden content: network and decode work nobody can see.

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
  const rect = { x: 0, y: 0, top: 0, left: 0, width: 640, height: 40, right: 640, bottom: 40, toJSON: () => ({}) };
  element.getBoundingClientRect = () => rect as DOMRect;
  document.body.appendChild(element);
}

function isPlaying(): boolean {
  return getActiveLiveMedia('live-news') !== null && internals().content.querySelector('.live-news-player') !== null;
}

function setCollapsedPreference(collapsed: boolean): void {
  localStorage.setItem(PANEL_COLLAPSED_KEY, JSON.stringify({ 'live-news': collapsed }));
  invalidatePanelStorageCacheForKeys([PANEL_COLLAPSED_KEY]);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  invalidatePanelStorageCacheForKeys([PANEL_COLLAPSED_KEY]);
});

describe('Live News autoplay and a collapsed panel', () => {
  it('autoplays an expanded panel once it scrolls into view', () => {
    mount();
    FakeIntersectionObserver.latest?.intersect();
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(true);
  });

  it('does not autoplay inside a collapsed panel, and starts when the viewer expands it', () => {
    setCollapsedPreference(true);
    mount();
    expect(panel?.isCollapsed()).toBe(true);

    FakeIntersectionObserver.latest?.intersect();
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(false);

    panel?.setCollapsed(false);
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(true);
  });

  it('does not start a scheduled autoplay when the viewer collapses the panel first', () => {
    mount();
    FakeIntersectionObserver.latest?.intersect();
    panel?.setCollapsed(true);
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(false);

    panel?.setCollapsed(false);
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(true);
  });

  it('waits for the panel to return when the viewer scrolls it away before the start', () => {
    mount();
    const observerAtScrollIn = FakeIntersectionObserver.latest;
    observerAtScrollIn?.intersect();
    const offscreen = { x: 0, y: 2000, top: 2000, left: 0, width: 640, height: 40, right: 640, bottom: 2040, toJSON: () => ({}) };
    internals().element.getBoundingClientRect = () => offscreen as DOMRect;
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(false);

    const rearmed = FakeIntersectionObserver.latest;
    expect(rearmed).not.toBe(observerAtScrollIn);
    const onscreen = { x: 0, y: 0, top: 0, left: 0, width: 640, height: 40, right: 640, bottom: 40, toJSON: () => ({}) };
    internals().element.getBoundingClientRect = () => onscreen as DOMRect;
    rearmed?.intersect();
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(true);
  });

  it('does not autoplay a collapsed panel when the tab becomes visible again', () => {
    setCollapsedPreference(true);
    mount();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(false);
    Reflect.deleteProperty(document, 'hidden');
  });

  it('does not autoplay on expand when the viewer turned autoplay off', () => {
    localStorage.setItem('wm-live-news-autoplay', 'false');
    setCollapsedPreference(true);
    mount();
    panel?.setCollapsed(false);
    vi.advanceTimersByTime(1100);
    expect(isPlaying()).toBe(false);
  });
});
