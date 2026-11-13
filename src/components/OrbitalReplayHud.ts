import type { PassTrack } from '@/services/orbital/track-geometry';
import type { ReplayFrame } from '@/services/orbital/track-replay';
import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';

const SCRUB_STEPS = 1000;

export interface ReplayHudCallbacks {
  onToggle: () => void;
  onSeek: (progress: number) => void;
}

/** The readout floating over the map and the scrubber in the sheet for one pass replay. */
export interface ReplayHud {
  /** Floats over the map, top right: the acquiring satellite and the countdown to acquisition. */
  readonly overlay: HTMLElement;
  /** Sits in the sheet: play or pause, the scrubber and the countdown. */
  readonly controls: HTMLElement;
  update(frame: ReplayFrame): void;
}

/** `T−00:00:07` until acquisition, `T−00:07` in the short form; never negative. */
export function formatCountdown(remainingMs: number, short = false): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const seconds = pad(total % 60);
  const minutes = Math.floor(total / 60);
  return short && minutes < 60
    ? `T\u2212${pad(minutes)}:${seconds}`
    : `T\u2212${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${seconds}`;
}

export function createReplayHud(track: PassTrack, reducedMotion: boolean, callbacks: ReplayHudCallbacks): ReplayHud {
  const reducedLabel = () => h('span', { className: 'ow-hud-reduced' }, t('orbitalWatch.replay.reducedMotion'));
  const countdown = h('div', { className: 'ow-hud-countdown' }, formatCountdown(0));
  const overlay = h('div', { className: 'ow-replay-hud', role: 'status', 'aria-live': 'off', dataset: { passKey: track.key } },
    h('div', { className: 'ow-hud-label' }, t('orbitalWatch.replay.acquisition', { name: track.name.toUpperCase() })),
    countdown,
    reducedMotion ? reducedLabel() : null);
  const toggle = h('button', {
    type: 'button',
    className: 'ow-hud-toggle',
    dataset: { action: 'replay-toggle' },
    'aria-label': t('orbitalWatch.replay.play'),
  }) as HTMLButtonElement;
  const scrub = h('input', {
    type: 'range',
    className: 'ow-hud-scrub',
    min: '0',
    max: String(SCRUB_STEPS),
    step: '1',
    value: String(SCRUB_STEPS),
    dataset: { action: 'replay-scrub' },
    'aria-label': t('orbitalWatch.replay.scrub'),
  }) as HTMLInputElement;
  const shortCountdown = h('span', { className: 'ow-hud-short' }, formatCountdown(0, true));
  const controls = h('div', { className: 'ow-replay-controls', dataset: { reducedMotion: String(reducedMotion) } },
    toggle, scrub, shortCountdown, reducedMotion ? reducedLabel() : null);
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    callbacks.onToggle();
  });
  scrub.addEventListener('input', () => callbacks.onSeek(Number(scrub.value) / SCRUB_STEPS));
  scrub.addEventListener('click', (event) => event.stopPropagation());
  scrub.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation();
  });
  const setPlaying = (playing: boolean) => {
    toggle.dataset.playing = String(playing);
    toggle.textContent = playing ? '\u275a\u275a' : '\u25b6';
    toggle.setAttribute('aria-label', t(playing ? 'orbitalWatch.replay.pause' : 'orbitalWatch.replay.play'));
  };
  setPlaying(false);
  return {
    overlay,
    controls,
    update(frame) {
      const remaining = track.closest.timeMs - frame.point.timeMs;
      countdown.textContent = formatCountdown(remaining);
      shortCountdown.textContent = formatCountdown(remaining, true);
      scrub.value = String(Math.round(frame.progress * SCRUB_STEPS));
      setPlaying(frame.playing);
    },
  };
}
