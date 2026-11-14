import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { ArchiveFailure } from '@/services/orbital/archive-result';
import type { LoadedArchiveImage } from '@/services/orbital/archive-image';
import {
  MIN_TIMELAPSE_FRAMES,
  preloadFrames,
  withPointData,
  type PaintedFrame,
  searchYearlyLooks,
  type LoadImage,
  type YearlyLook,
  type YearlyLooks,
} from '@/services/orbital/timelapse';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';
import { ARCHIVE_NAME, IMAGE_CREDIT, loadLookupImage } from './OrbitalWatchPage';
import '../styles/orbital-image-viewer.css';

export interface TimelapseSubject {
  point: GeoPoint;
  nowMs: number;
  /** The place name, or the rounded point when the lookup has no name. */
  place: string;
}

export interface TimelapseDependencies {
  searchLooks?: typeof searchYearlyLooks;
  loadImage?: LoadImage;
  prefersReducedMotion?: () => boolean;
}

type PageState =
  | { kind: 'searching' }
  | { kind: 'loading'; looks: YearlyLook[]; failures: ArchiveFailure[]; loaded: number }
  | { kind: 'failed'; failure: ArchiveFailure }
  | { kind: 'too-few'; count: number; failures: ArchiveFailure[] }
  | { kind: 'ready'; frames: PaintedFrame<YearlyLook>[]; failures: ArchiveFailure[]; index: number; playing: boolean };

const FRAME_INTERVAL_MS = 1_000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

const dayMonth = (ms: number) => {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};
const pad2 = (n: number) => String(n).padStart(2, '0');
const platformName = (look: YearlyLook) => look.platform.toUpperCase();

export function formatPoint(point: GeoPoint): string {
  const lat = `${Math.abs(point.lat).toFixed(3)}°${point.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.lon).toFixed(3)}°${point.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

/** The yearly time-lapse of one place: one clear Sentinel-2 look per year, shown full screen. */
export class OrbitalTimelapsePage {
  private readonly root: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly body: HTMLElement;
  private readonly controller = new AbortController();
  private readonly deps: Required<TimelapseDependencies>;
  private state: PageState = { kind: 'searching' };
  private stepping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The loaded frames, kept while the page plays them in a loop and released when it closes or searches again. */
  private held: LoadedArchiveImage[] = [];

  constructor(private readonly subject: TimelapseSubject, private readonly returnFocusTo: HTMLElement | null, deps: TimelapseDependencies = {}) {
    this.deps = {
      searchLooks: deps.searchLooks ?? searchYearlyLooks,
      loadImage: deps.loadImage ?? withPointData(loadLookupImage),
      prefersReducedMotion: deps.prefersReducedMotion ?? (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    };
    const titleId = 'orbital-timelapse-title';
    this.body = h('div', { className: 'oiv-main' });
    this.dialog = h('section', { className: 'oiv-page otl-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('header', { className: 'oiv-bar' },
        h('h2', { id: titleId, className: 'oiv-crumb' }, h('span', null, t('orbitalWatch.timelapse.heading')), ' / ', h('span', { className: 'oiv-crumb-place' }, subject.place)),
        closeButton()),
      this.body);
    this.root = h('div', { className: 'oiv-backdrop' }, this.dialog);
    declareOverlay(this.root, { reload: 'safe' });
    this.root.addEventListener('keydown', this.onKeydown);
    this.root.addEventListener('click', this.onClick);
  }

  open(): void {
    document.body.appendChild(this.root);
    this.render();
    this.dialog.focus();
    void this.search();
  }

  get isOpen(): boolean {
    return this.root.isConnected;
  }

  close(): void {
    if (!this.isOpen) return;
    this.controller.abort();
    this.stopTimer();
    this.releaseHeld();
    this.root.remove();
    const target = this.returnFocusTo?.isConnected ? this.returnFocusTo : document.querySelector<HTMLElement>('.orbital-watch-sheet');
    target?.focus({ preventScroll: true });
  }

  private async search(): Promise<void> {
    const { signal } = this.controller;
    this.releaseHeld();
    this.state = { kind: 'searching' };
    this.render();
    let result: YearlyLooks;
    try {
      await afterDebugBearRequestWindow(signal);
      result = await this.deps.searchLooks(this.subject.point, this.subject.nowMs, { signal });
    } catch {
      return;
    }
    if (signal.aborted) return;
    if (result.looks.length === 0 && result.failures[0]) {
      this.state = { kind: 'failed', failure: result.failures[0] };
      this.render();
      return;
    }
    const looks = result.looks.filter((look) => look.imageUrl !== null && isAllowedPreviewUrl(look.imageUrl));
    this.state = { kind: 'loading', looks, failures: result.failures, loaded: 0 };
    this.render();
    const { frames, failures: unloaded } = await preloadFrames(looks, 'planetary-computer', signal, (loaded) => {
      if (this.state.kind !== 'loading') return;
      this.state = { ...this.state, loaded };
      this.render();
    }, this.deps.loadImage);
    if (signal.aborted) return;
    const failures = [...result.failures, ...unloaded];
    this.held = frames.map((frame) => frame.paint);
    if (frames.length < MIN_TIMELAPSE_FRAMES) {
      this.releaseHeld();
      this.state = { kind: 'too-few', count: frames.length, failures };
      this.render();
      return;
    }
    const playing = !this.deps.prefersReducedMotion();
    this.state = { kind: 'ready', frames, failures, index: 0, playing };
    if (playing) this.startTimer();
    this.render();
  }

  private releaseHeld(): void {
    for (const paint of this.held) paint.release();
    this.held = [];
  }

  private render(): void {
    const focusedAction = (document.activeElement as HTMLElement | null)?.dataset?.action;
    const focusedIndex = (document.activeElement as HTMLElement | null)?.dataset?.index;
    const shown = this.body.querySelector<HTMLImageElement>('.oiv-stage .oiv-image:not(.oiv-pending)');
    replaceChildren(this.body, ...this.renderState());
    const fresh = this.body.querySelector<HTMLImageElement>('.oiv-stage .oiv-image');
    // A re-render (pause, resume) keeps the decoded frame rather than making the browser fetch it again.
    if (shown && fresh && fresh.src === shown.src) fresh.replaceWith(shown);
    const selector = focusedIndex !== undefined ? `[data-action="${focusedAction}"][data-index="${focusedIndex}"]` : `[data-action="${focusedAction}"]`;
    if (focusedAction) this.body.querySelector<HTMLElement>(selector)?.focus();
    if (!this.dialog.contains(document.activeElement)) this.dialog.focus({ preventScroll: true });
  }

  private renderState(): DomChild[] {
    const state = this.state;
    switch (state.kind) {
      case 'searching':
        return [skeleton(t('orbitalWatch.timelapse.searching', { archive: ARCHIVE_NAME['planetary-computer'] })), this.side(null)];
      case 'loading':
        return [skeleton(t('orbitalWatch.timelapse.loading', { loaded: state.loaded, total: state.looks.length })), this.side(null, state.looks)];
      case 'failed': {
        const key = state.failure.reason === 'timeout' ? 'orbitalWatch.timelapse.timeout' : 'orbitalWatch.timelapse.failed';
        return [h('div', { className: 'oiv-column' },
          h('div', { className: 'oiv-stage oiv-stage-empty', role: 'alert' },
            h('p', null, t(key, { archive: ARCHIVE_NAME[state.failure.archive] })),
            h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'retry' } }, t('countryBrief.retryBtn')))), this.side(null)];
      }
      case 'too-few':
        return [h('div', { className: 'oiv-column' },
          h('div', { className: 'oiv-stage oiv-stage-empty', dataset: { timelapse: 'insufficient' } },
            h('p', null, t('orbitalWatch.timelapse.tooFew', { count: state.count, min: MIN_TIMELAPSE_FRAMES })),
            state.failures.length > 0
              ? h('p', { className: 'oiv-note', role: 'note' }, t('orbitalWatch.timelapse.partial', { count: state.failures.length, archive: ARCHIVE_NAME[state.failures[0]!.archive] }))
              : null,
            state.failures.length > 0
              ? h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'retry' } }, t('countryBrief.retryBtn'))
              : null)), this.side(null)];
      case 'ready':
        return [this.player(state), this.side(state)];
    }
  }

  private player(state: Extract<PageState, { kind: 'ready' }>): HTMLElement {
    const frame = state.frames[state.index]!;
    const reduced = this.deps.prefersReducedMotion();
    const first = state.frames[0]!.timeMs;
    const span = Math.max(1, state.frames[state.frames.length - 1]!.timeMs - first);
    const toggle = reduced
      ? h('button', { type: 'button', className: 'oiv-play', 'aria-label': t('orbitalWatch.viewer.next'), dataset: { action: 'frame-next' } }, '›')
      : h('button', { type: 'button', className: 'oiv-play', 'aria-label': state.playing ? t('orbitalWatch.viewer.pause') : t('orbitalWatch.viewer.resume'), 'aria-pressed': String(state.playing), dataset: { action: 'toggle' } }, state.playing ? '❚❚' : '▶');
    return h('div', { className: 'oiv-column' },
      h('div', { className: 'oiv-stage', dataset: { timelapse: reduced ? 'stepper' : 'autoplay' } },
        h('span', { className: 'otl-stage-loading oiv-label', 'aria-hidden': 'true' }, `${t('orbitalWatch.row.imageLoading')} ${frame.year} · ${platformName(frame)}`),
        frameImage(frame),
        reticle(),
        h('span', { className: 'oiv-counter', 'aria-hidden': 'true' }, `${pad2(state.index + 1)} / ${pad2(state.frames.length)}`),
        h('div', { className: 'otl-year', 'aria-live': 'polite' },
          h('span', { className: 'otl-year-number' }, String(frame.year)),
          h('span', { className: 'otl-year-detail' }, `${dayMonth(frame.timeMs)} ${frame.year} · ${platformName(frame)}`))),
      h('div', { className: 'otl-scrub' },
        toggle,
        h('div', { className: 'otl-track', role: 'group', 'aria-label': t('orbitalWatch.timelapse.years') },
          ...state.frames.map((look, i) => h('button', {
            type: 'button',
            className: 'otl-tick',
            style: `left: ${((look.timeMs - first) / span) * 100}%`,
            'aria-label': `${look.year}, ${dayMonth(look.timeMs)}`,
            'aria-current': i === state.index ? 'true' : null,
            dataset: { action: 'frame', index: String(i), side: i % 2 === 0 ? 'below' : 'above' },
          }, h('span', { className: 'otl-tick-label' }, String(look.year).slice(2)))))),
      h('p', { className: 'oiv-label otl-total' }, t('orbitalWatch.timelapse.total', { count: state.frames.length })));
  }

  private side(state: Extract<PageState, { kind: 'ready' }> | null, pending: YearlyLook[] = []): HTMLElement {
    const looks = state?.frames ?? pending;
    const years = looks.map((look) => look.year);
    const credit = years.length > 0
      ? IMAGE_CREDIT.copernicus(Math.min(...years) === Math.max(...years) ? Math.min(...years) : `${Math.min(...years)}–${Math.max(...years)}`)
      : null;
    const failures = state?.failures ?? [];
    return h('aside', { className: 'oiv-side' },
      h('div', { className: 'oiv-actions' },
        h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'share' } }, '⇪ ', t('orbitalWatch.timelapse.share'))),
      looks.length > 0
        ? h('ol', { className: 'otl-list' }, ...looks.map((look, i) => h('li', null, h('button', {
          type: 'button',
          className: 'otl-row',
          disabled: !state,
          'aria-current': state && i === state.index ? 'true' : null,
          dataset: { action: 'frame', index: String(i) },
        }, h('span', { className: 'otl-row-year' }, String(look.year)), h('span', null, dayMonth(look.timeMs)), h('span', { className: 'otl-row-sat' }, look.platformCode)))))
        : null,
      failures.length > 0
        ? h('p', { className: 'oiv-note', role: 'note' }, t('orbitalWatch.timelapse.partial', { count: failures.length, archive: ARCHIVE_NAME[failures[0]!.archive] }))
        : null,
      h('p', { className: 'oiv-method' }, t('orbitalWatch.timelapse.method')),
      credit ? h('p', { className: 'oiv-credit' }, credit) : null);
  }

  /** Shows a frame only once it has decoded, swapping the existing image so the box never redraws. */
  private async show(index: number): Promise<void> {
    if (this.state.kind !== 'ready' || this.stepping) return;
    const frames = this.state.frames;
    const target = (index + frames.length) % frames.length;
    const frame = frames[target]!;
    const next = frameImage(frame) as HTMLImageElement | null;
    if (!next) return;
    this.stepping = true;
    try {
      await (typeof next.decode === 'function' ? next.decode() : Promise.resolve()).catch(() => undefined);
    } finally {
      this.stepping = false;
    }
    if (this.controller.signal.aborted || this.state.kind !== 'ready' || this.state.frames !== frames) return;
    const loading = this.body.querySelector('.otl-stage-loading');
    if (loading) loading.textContent = `${t('orbitalWatch.row.imageLoading')} ${frame.year} · ${platformName(frame)}`;
    this.state = { ...this.state, index: target };
    const image = this.body.querySelector<HTMLImageElement>('.oiv-image');
    if (!image) {
      this.render();
      return;
    }
    next.classList.remove('oiv-pending');
    image.replaceWith(next);
    this.body.querySelector('.otl-year-number')!.textContent = String(frame.year);
    this.body.querySelector('.otl-year-detail')!.textContent = `${dayMonth(frame.timeMs)} ${frame.year} · ${platformName(frame)}`;
    this.body.querySelector('.oiv-counter')!.textContent = `${pad2(target + 1)} / ${pad2(frames.length)}`;
    this.body.querySelectorAll<HTMLElement>('[data-action="frame"]').forEach((element) => {
      if (element.dataset.index === String(target)) element.setAttribute('aria-current', 'true');
      else element.removeAttribute('aria-current');
    });
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.state.kind === 'ready') void this.show(this.state.index + 1);
    }, FRAME_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async share(): Promise<void> {
    // The same `#orbital=<lat>,<lon>` route the lookup sheet reads, so the link opens this place.
    const { lat, lon } = this.subject.point;
    const url = `${location.origin}${location.pathname}${location.search}#orbital=${lat.toFixed(4)},${lon.toFixed(4)}`;
    const title = `${t('orbitalWatch.timelapse.heading')} / ${this.subject.place}`;
    try {
      if (typeof navigator.share === 'function') await navigator.share({ title, url });
      else await navigator.clipboard?.writeText(url);
    } catch {
      // The person dismissed the share sheet.
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (event.target === this.root) {
      this.close();
      return;
    }
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    switch (action?.dataset.action) {
      case 'close':
        this.close();
        return;
      case 'retry':
        void this.search();
        return;
      case 'share':
        void this.share();
        return;
      case 'toggle':
        if (this.state.kind !== 'ready') return;
        this.state = { ...this.state, playing: !this.state.playing };
        if (this.state.playing) this.startTimer();
        else this.stopTimer();
        this.render();
        return;
      case 'frame-next':
        if (this.state.kind === 'ready') void this.show(this.state.index + 1);
        return;
      case 'frame':
        if (this.state.kind !== 'ready') return;
        if (this.state.playing) {
          this.state = { ...this.state, playing: false };
          this.stopTimer();
          this.render();
        }
        void this.show(Number(action.dataset.index));
        return;
    }
  };

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      this.close();
      return;
    }
    if (this.state.kind === 'ready' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !(event.target as HTMLElement).closest('input')) {
      event.preventDefault();
      void this.show(this.state.index + (event.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    trapTab(event, this.dialog);
  };
}

export function closeButton(): HTMLElement {
  return h('button', { type: 'button', className: 'oiv-close', 'aria-label': t('orbitalWatch.viewer.close'), dataset: { action: 'close' } },
    h('span', { className: 'oiv-label' }, t('orbitalWatch.viewer.closeLabel')), h('kbd', null, 'ESC'), h('span', { 'aria-hidden': 'true' }, '×'));
}

export function reticle(): HTMLElement {
  return h('span', { className: 'oiv-reticle', 'aria-hidden': 'true' });
}

/** Paints the frame's loaded copy: its archive URL carries the point, and DebugBear reports the largest painted image's URL. */
function frameImage(look: PaintedFrame<YearlyLook>): DomChild {
  if (!look.imageUrl || !isAllowedPreviewUrl(look.imageUrl)) return null;
  const image = h('img', {
    className: 'oiv-image',
    src: look.paint.objectUrl,
    alt: t('orbitalWatch.viewer.imageAlt', { name: platformName(look), time: `${dayMonth(look.timeMs)} ${look.year}` }),
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    crossorigin: 'anonymous',
    draggable: 'false',
  }) as HTMLImageElement;
  if (!image.complete) {
    image.classList.add('oiv-pending');
    image.addEventListener('load', () => image.classList.remove('oiv-pending'), { once: true });
  }
  return image;
}

function skeleton(label: string): HTMLElement {
  return h('div', { className: 'oiv-column' },
    h('div', { className: 'oiv-stage oiv-skeleton', role: 'status' }, h('span', { className: 'oiv-label' }, label)));
}

export function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

let current: OrbitalTimelapsePage | null = null;

export function openOrbitalTimelapse(subject: TimelapseSubject, returnFocusTo: HTMLElement | null, deps?: TimelapseDependencies): OrbitalTimelapsePage {
  current?.close();
  current = new OrbitalTimelapsePage(subject, returnFocusTo, deps);
  current.open();
  return current;
}
