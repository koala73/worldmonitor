/**
 * LiveNewsPanel channel keyboard reorder + offline retry.
 *
 * ArrowLeft/Right must persist through applyChannelOrderFromDom. Offline Retry
 * must re-request playback for the already-active channel (switchChannel
 * returns immediately on a matching id).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import * as liveMedia from '@/services/live-media-controller';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const SEEDED_ORDER = ['bloomberg', 'sky', 'cnbc'] as const;

let panel: LiveNewsPanel;

function element(): HTMLElement {
  return (panel as unknown as { element: HTMLElement }).element;
}

function content(): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function channelButtons(): HTMLButtonElement[] {
  return Array.from(element().querySelectorAll<HTMLButtonElement>('.live-channel-btn'));
}

function channelIds(): string[] {
  return channelButtons().map((btn) => btn.dataset.channelId ?? '');
}

function persistedOrder(): string[] {
  const raw = localStorage.getItem(STORAGE_KEYS.liveChannels);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { order?: string[] };
  return parsed.order ?? [];
}

function dispatchArrow(target: HTMLElement, key: 'ArrowLeft' | 'ArrowRight'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    STORAGE_KEYS.liveChannels,
    JSON.stringify({ order: [...SEEDED_ORDER], custom: [], displayNameOverrides: {} }),
  );
  panel = new LiveNewsPanel();
  document.body.appendChild(element());
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
});

describe('LiveNewsPanel channel keyboard reorder', () => {
  it('moves the focused channel one slot right and persists order', () => {
    const buttons = channelButtons();
    expect(buttons.map((btn) => btn.dataset.channelId)).toEqual([...SEEDED_ORDER]);
    const first = buttons[0];
    expect(first).toBeDefined();
    first?.focus();

    dispatchArrow(first as HTMLButtonElement, 'ArrowRight');

    expect(channelIds()).toEqual(['sky', 'bloomberg', 'cnbc']);
    expect(document.activeElement).toBe(first);
    expect(persistedOrder()).toEqual(['sky', 'bloomberg', 'cnbc']);
  });

  it('leaves order unchanged on ArrowRight at the last channel and does not preventDefault', () => {
    const buttons = channelButtons();
    const last = buttons[buttons.length - 1];
    expect(last).toBeDefined();
    last?.focus();

    const event = dispatchArrow(last as HTMLButtonElement, 'ArrowRight');

    expect(channelIds()).toEqual([...SEEDED_ORDER]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('LiveNewsPanel offline retry', () => {
  it('re-requests playback for the already-active channel and has no inline onclick', () => {
    const requestSpy = vi.spyOn(liveMedia, 'requestLiveMediaPlayback').mockImplementation(() => {});
    const internals = panel as unknown as {
      activeChannel: { id: string; name: string };
      showOfflineMessage: (channel: { id: string; name: string }) => void;
    };

    internals.showOfflineMessage(internals.activeChannel);

    const retry = content().querySelector<HTMLButtonElement>('[data-live-retry]');
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute('onclick')).toBeNull();

    retry?.click();

    expect(requestSpy).toHaveBeenCalled();
    const args = requestSpy.mock.calls[0];
    expect(args?.[0]).toBe('live-news');
    expect(args?.[1]).toBe(internals.activeChannel.id);
  });
});
