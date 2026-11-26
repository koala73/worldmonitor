import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetAudibleMediaForTests, isAudibleMediaPlaying, softReloadHold, SOFT_RELOAD_MIN_PAGE_AGE_MS } from '@/bootstrap/soft-reload-policy';
import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { PANEL_COLLAPSED_KEY, invalidatePanelStorageCacheForKeys } from '@/utils/panel-storage';

import { initTestI18n } from './helpers/i18n.mts';

// A reload cannot bring sound back: browsers block unmuted autoplay. So Live
// News tells the update reloader when it is playing with sound, and a deploy
// that old tabs can live with never reloads over it.

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
  ensurePlayerContainer(): void;
}

let panel: LiveNewsPanel | undefined;

function element(): HTMLElement {
  if (!panel) throw new Error('panel not mounted');
  return (panel as unknown as PanelInternals).element;
}

function button(title: string): HTMLButtonElement {
  const found = [...element().querySelectorAll<HTMLButtonElement>('.live-mute-btn')].find((btn) => btn.title === title);
  if (!found) throw new Error(`no "${title}" button`);
  return found;
}

/** Mounts the panel and lets default autoplay start it, muted. */
function mountPlaying(): void {
  panel = new LiveNewsPanel();
  const rect = { x: 0, y: 0, top: 0, left: 0, width: 640, height: 40, right: 640, bottom: 40, toJSON: () => ({}) };
  element().getBoundingClientRect = () => rect as DOMRect;
  document.body.appendChild(element());
  FakeIntersectionObserver.latest?.intersect();
  vi.advanceTimersByTime(1100);
}

/** What the reloader decides for a hidden tab that has been open long enough. */
function holdForOldHiddenTab() {
  return softReloadHold({
    visibilityState: 'hidden',
    pageAgeMs: SOFT_RELOAD_MIN_PAGE_AGE_MS,
    audibleMedia: isAudibleMediaPlaying(),
  });
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
  _resetAudibleMediaForTests();
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
  _resetAudibleMediaForTests();
});

describe('Live News and the update reload', () => {
  it('muted autoplay does not hold a reload', () => {
    mountPlaying();
    expect(isAudibleMediaPlaying()).toBe(false);
    expect(holdForOldHiddenTab()).toBeNull();
  });

  it('holds the reload while it plays with sound, and releases it when muted again', () => {
    mountPlaying();
    button('Toggle sound').click();
    expect(holdForOldHiddenTab()).toBe('audible-media');

    button('Toggle sound').click();
    expect(holdForOldHiddenTab()).toBeNull();
  });

  it('releases the hold when the viewer pauses an unmuted stream', () => {
    mountPlaying();
    button('Toggle sound').click();
    expect(isAudibleMediaPlaying()).toBe(true);

    button('Toggle playback').click();
    expect(isAudibleMediaPlaying()).toBe(false);
  });

  it('releases the hold when the panel is destroyed while playing with sound', () => {
    mountPlaying();
    button('Toggle sound').click();
    expect(isAudibleMediaPlaying()).toBe(true);

    panel?.destroy();
    panel = undefined;
    expect(isAudibleMediaPlaying()).toBe(false);
  });
});
