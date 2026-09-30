import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { findReloadBlockingModal } from '@/utils/open-modal';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/live-channels-window', () => ({ initLiveChannelsWindow: vi.fn(async () => {}) }));

interface PanelInternals {
  element: HTMLElement;
  openChannelManagementModal(): void;
}

let panel: LiveNewsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function overlay(): HTMLElement | null {
  return document.querySelector('.live-channels-modal-overlay');
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    STORAGE_KEYS.liveChannels,
    JSON.stringify({ order: ['bloomberg', 'sky'], custom: [], displayNameOverrides: {} }),
  );
  panel = new LiveNewsPanel();
  document.body.appendChild(internals().element);
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
});

/**
 * The channel-management overlay is parented to document.body, and its CSS
 * base rule is `display: flex` with `opacity: 0`; `.active` only raises the
 * opacity. `checkVisibility()`, the reload guard's probe, ignores opacity, so
 * the overlay counts as open from the moment it is appended until it is
 * removed. Destroying the panel while it was open used to leave it behind:
 * a permanently visible overlay, a permanent reload block, and a `document`
 * keydown listener with nothing to close.
 */
describe('LiveNewsPanel channel-management overlay lifecycle', () => {
  it('declares itself reload-blocking while open', () => {
    internals().openChannelManagementModal();
    expect(overlay()).not.toBeNull();
    expect(findReloadBlockingModal(document)).toEqual({ label: 'live-channels-modal-overlay', policy: 'blocking' });
  });

  it('destroy() removes the overlay, so it cannot hold reloads off after the panel is gone', () => {
    internals().openChannelManagementModal();
    expect(overlay()).not.toBeNull();

    const destroyed = panel!;
    panel = undefined;
    destroyed.destroy();

    expect(overlay()).toBeNull();
    expect(findReloadBlockingModal(document)).toBeNull();
  });

  it('destroy() removes the overlay Escape listener', () => {
    internals().openChannelManagementModal();
    const destroyed = panel!;
    panel = undefined;
    // The leaked listener's close path is the only caller of this method
    // from a keydown, so a call after destroy proves the listener survived.
    const refresh = vi.spyOn(destroyed, 'refreshChannelsFromStorage');
    destroyed.destroy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(refresh).not.toHaveBeenCalled();
  });
});
