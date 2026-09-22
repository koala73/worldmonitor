import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { getActiveLiveMedia } from '@/services/live-media-controller';

import { initTestI18n } from './helpers/i18n.mts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface LiveChannelLike {
  id: string;
  name: string;
}

interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  channels: LiveChannelLike[];
  ensurePlayerContainer(): void;
  getChannelDisplayName(channel: LiveChannelLike): string;
  switchChannel(channel: LiveChannelLike): Promise<void>;
  resolveChannelVideo(channel: LiveChannelLike): Promise<void>;
}

let panel: LiveNewsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function mount(): LiveNewsPanel {
  panel = new LiveNewsPanel();
  document.body.appendChild(internals().element);
  return panel;
}

function content(): HTMLElement {
  return internals().content;
}

function isPlaying(): boolean {
  return getActiveLiveMedia('live-news') !== null && content().querySelector('.live-news-player') !== null;
}

function notice(): HTMLElement | null {
  return content().querySelector('.live-media-shell--idle');
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(content().querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`no "${label}" button in panel content`);
  return match;
}

function playFromPlaceholder(): void {
  button('Play live feed').click();
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

function placePanelOnScreen(): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, width: 640, height: 360, right: 640, bottom: 360, toJSON: () => ({}) };
  internals().element.getBoundingClientRect = () => rect as DOMRect;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
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
  Reflect.deleteProperty(document, 'hidden');
  vi.useRealTimers();
  localStorage.clear();
});

describe('Live News idle stop', () => {
  it('keeps playing through the old five-minute stop and shows an idle notice after an hour', () => {
    mount();
    playFromPlaceholder();
    expect(isPlaying()).toBe(true);

    vi.advanceTimersByTime(5 * MINUTE);
    expect(isPlaying()).toBe(true);
    vi.advanceTimersByTime(55 * MINUTE - 1);
    expect(isPlaying()).toBe(true);
    vi.advanceTimersByTime(1);

    expect(isPlaying()).toBe(false);
    const shown = notice();
    expect(shown).not.toBeNull();
    expect(shown?.querySelector('.live-media-shell-status')?.textContent).toBe('Paused for inactivity');
    expect(shown?.querySelector('.live-media-shell-title')?.textContent).toBe('Bloomberg');
    expect(shown?.textContent).toContain('Live video stopped after 1 hour without mouse, keyboard or touch activity.');
    expect(shown?.textContent).toContain('Change this anytime in Settings › Media.');
    expect(button('Resume')).toBeTruthy();
    expect(button('Keep playing when idle')).toBeTruthy();
  });

  it('keeps the notice through later mouse and keyboard input without restarting video', () => {
    mount();
    playFromPlaceholder();
    vi.advanceTimersByTime(HOUR);

    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    vi.advanceTimersByTime(MINUTE);

    expect(isPlaying()).toBe(false);
    expect(notice()).not.toBeNull();
  });

  it('restarts playback from Resume and can idle-stop again later', () => {
    mount();
    playFromPlaceholder();
    vi.advanceTimersByTime(HOUR);

    button('Resume').click();
    expect(isPlaying()).toBe(true);
    expect(notice()).toBeNull();

    vi.advanceTimersByTime(HOUR);
    expect(isPlaying()).toBe(false);
    expect(notice()).not.toBeNull();
  });

  it('saves never from Keep playing when idle, confirms it, and keeps playing for ten hours', () => {
    mount();
    playFromPlaceholder();
    vi.advanceTimersByTime(HOUR);

    button('Keep playing when idle').click();

    expect(localStorage.getItem('wm-live-media-idle-stop')).toBe('never');
    expect(document.querySelector('.toast-notification')?.textContent)
      .toBe('Live video will keep playing when idle. Change in Settings › Media.');
    expect(isPlaying()).toBe(true);
    vi.advanceTimersByTime(10 * HOUR);
    expect(isPlaying()).toBe(true);
  });

  it('never idle-stops a legacy always-on user', () => {
    localStorage.setItem('wm-live-streams-always-on', 'true');
    mount();
    playFromPlaceholder();
    vi.advanceTimersByTime(10 * HOUR);
    expect(isPlaying()).toBe(true);
    expect(notice()).toBeNull();
  });

  it('keeps the notice on tab return for an auto-play user who chose an idle duration', () => {
    localStorage.setItem('wm-live-streams-always-on', 'true');
    localStorage.setItem('wm-live-media-idle-stop', '60');
    mount();
    placePanelOnScreen();
    playFromPlaceholder();
    vi.advanceTimersByTime(HOUR);
    expect(isPlaying()).toBe(false);
    expect(notice()).not.toBeNull();

    setHidden(true);
    setHidden(false);
    expect(isPlaying()).toBe(false);
    expect(notice()).not.toBeNull();

    button('Resume').click();
    expect(isPlaying()).toBe(true);
    expect(notice()).toBeNull();
  });

  it('shows no notice on a panel that never played', () => {
    mount();
    vi.advanceTimersByTime(2 * HOUR);
    expect(notice()).toBeNull();
    expect(content().textContent).toContain('Ready when you are');
  });

  it('does not stop or explain a native video the viewer paused', () => {
    const mounted = mount();
    playFromPlaceholder();
    (mounted as unknown as { isPlaying: boolean }).isPlaying = false;

    vi.advanceTimersByTime(2 * HOUR);

    expect(getActiveLiveMedia('live-news')).not.toBeNull();
    expect(notice()).toBeNull();
  });

  it('never idle-stops fullscreen playback', () => {
    const mounted = mount();
    playFromPlaceholder();
    mounted.setFullscreen(true);
    vi.advanceTimersByTime(3 * HOUR);
    expect(isPlaying()).toBe(true);
    expect(notice()).toBeNull();
  });

  it.each([false, true])('keeps the notice after a channel switch with auto-play %s', async (alwaysOn) => {
    localStorage.setItem('wm-live-streams-always-on', String(alwaysOn));
    localStorage.setItem('wm-live-media-idle-stop', '60');
    mount();
    placePanelOnScreen();
    playFromPlaceholder();
    vi.advanceTimersByTime(HOUR);

    const sky = internals().channels.find((channel) => channel.id === 'sky');
    if (!sky) throw new Error('seeded sky channel missing');
    vi.spyOn(internals(), 'resolveChannelVideo').mockResolvedValue(undefined);
    await internals().switchChannel(sky);

    expect(isPlaying()).toBe(false);
    expect(notice()?.querySelector('.live-media-shell-title')?.textContent)
      .toBe(internals().getChannelDisplayName(sky));

    button('Resume').click();
    expect(isPlaying()).toBe(true);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe(sky.id);
  });

  it('returns to Ready without a notice when the tab is hidden while playing', () => {
    mount();
    playFromPlaceholder();
    setHidden(true);

    expect(isPlaying()).toBe(false);
    expect(notice()).toBeNull();
    expect(content().textContent).toContain('Ready when you are');
    vi.advanceTimersByTime(2 * HOUR);
    expect(notice()).toBeNull();
  });

  it('clears the notice when the panel is closed', () => {
    const mounted = mount();
    playFromPlaceholder();
    vi.advanceTimersByTime(HOUR);

    mounted.stopLiveMediaForClose();
    expect(notice()).toBeNull();
    expect(content().textContent).toContain('Ready when you are');

    playFromPlaceholder();
    expect(isPlaying()).toBe(true);
  });
});
