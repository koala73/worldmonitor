/**
 * Playback control when the browser blocks site storage (follow-up to the
 * Sentry WORLDMONITOR-1D1 boot repair).
 *
 * A refused IndexedDB used to leave the playback panel showing an empty
 * slider with no explanation. The control now checks storage each time it
 * opens, explains the block, and disables the controls that have nothing to
 * step through. Only the storage edge is mocked; the real control and the
 * real English dictionary render.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

let storageAvailable = true;
let timestamps: number[] = [];
const getSnapshotTimestamps = vi.fn(async () => timestamps);

vi.mock('@/services/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/storage')>()),
  isStorageAvailable: vi.fn(async () => storageAvailable),
  getSnapshotTimestamps: () => getSnapshotTimestamps(),
  getSnapshotAt: vi.fn(async () => null),
}));

const { PlaybackControl } = await import('@/components/PlaybackControl');
const { t } = await import('@/services/i18n');

function mount() {
  const control = new PlaybackControl();
  const root = control.getElement();
  document.body.replaceChildren(root);
  return {
    root,
    notice: root.querySelector<HTMLElement>('.playback-notice')!,
    slider: root.querySelector<HTMLInputElement>('.playback-slider')!,
    stepButtons: [...root.querySelectorAll<HTMLButtonElement>('.playback-btn:not(.playback-live)')],
    liveButton: root.querySelector<HTMLButtonElement>('.playback-live')!,
    toggle: root.querySelector<HTMLButtonElement>('.playback-toggle')!,
    close: root.querySelector<HTMLButtonElement>('.playback-close')!,
  };
}

async function open(toggle: HTMLButtonElement): Promise<void> {
  toggle.click();
  // The mocked storage calls settle as microtasks, so one macrotask turn lets
  // loadTimestamps apply its result.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  storageAvailable = true;
  timestamps = [];
  getSnapshotTimestamps.mockClear();
});

describe('PlaybackControl storage notice', () => {
  it('explains a blocked database and disables stepping, keeping Live and close usable', async () => {
    storageAvailable = false;
    const ui = mount();
    await open(ui.toggle);

    expect(ui.notice.hidden).toBe(false);
    expect(ui.notice.getAttribute('role')).toBe('status');
    expect(ui.notice.textContent).toBe(t('components.playback.storageUnavailable'));
    expect(ui.notice.textContent).toMatch(/site storage/);
    expect(ui.slider.disabled).toBe(true);
    expect(ui.stepButtons).toHaveLength(4);
    for (const button of ui.stepButtons) expect(button.disabled).toBe(true);
    expect(ui.liveButton.disabled).toBe(false);
    expect(ui.close.disabled).toBe(false);
    expect(getSnapshotTimestamps).not.toHaveBeenCalled();
  });

  it('clears the notice when storage is allowed on a later open', async () => {
    storageAvailable = false;
    const ui = mount();
    await open(ui.toggle);
    expect(ui.notice.hidden).toBe(false);

    ui.toggle.click(); // close
    storageAvailable = true;
    timestamps = [1_000, 2_000];
    await open(ui.toggle);

    expect(ui.notice.hidden).toBe(true);
    expect(ui.slider.disabled).toBe(false);
    for (const button of ui.stepButtons) expect(button.disabled).toBe(false);
    expect(ui.slider.max).toBe('1');
  });

  it('positive control: available storage with no snapshots shows no notice', async () => {
    const ui = mount();
    await open(ui.toggle);

    expect(ui.notice.hidden).toBe(true);
    expect(ui.slider.disabled).toBe(false);
    expect(getSnapshotTimestamps).toHaveBeenCalledTimes(1);
  });
});
