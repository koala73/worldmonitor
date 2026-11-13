import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { ArchiveFailure } from '@/services/orbital/archive-result';
import type { ImagingProfileId } from '@/services/orbital/archive-stac';
import type { DailyMosaicRow, GeostationaryRow } from '@/services/orbital/archive-gibs';
import { EUMETSAT_WMS_ENDPOINT, GIBS_WMS_ENDPOINT } from '@/services/orbital/crop-url';
import { describePointCondition, type MatchedAcquisition, type OrbitalEvidence } from '@/services/orbital/match';
import {
  defaultCompareScene,
  HISTORY_DAYS,
  MIN_TIMELAPSE_FRAMES,
  preloadFrames,
  searchSceneHistory,
  timelapseFrames,
  type DatedScene,
  type LoadImage,
  type SceneHistory,
} from '@/services/orbital/timelapse';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';
import { ARCHIVE_NAME, IMAGE_CREDIT } from './OrbitalWatchPage';
import '../styles/orbital-image-viewer.css';

/** How the image's pixels sit against the ground: a geographic grid is north-up; a raw quick-look is not georeferenced. */
export type ImageGrid = 'north-up' | 'unreferenced';

export interface ViewerScene extends DatedScene {
  /** Scenes compare only within one collection: a mission, or one mosaic or frame layer. */
  collection: string;
  name: string;
  dateLabel: string;
  credit: string;
  acknowledgement: string | null;
  conditionText: string | null;
  grid: ImageGrid;
}

export interface ImageViewerSubject {
  point: GeoPoint;
  nowMs: number;
  selected: ViewerScene;
  /** Other scenes of the same collection the lookup already holds. */
  scenes: ViewerScene[];
  /** The mission whose earlier scenes are searched for compare and time-lapse; null for mosaics and frames. */
  historyProfile: ImagingProfileId | null;
}

export interface ViewerDependencies {
  searchHistory?: typeof searchSceneHistory;
  loadImage?: LoadImage;
  prefersReducedMotion?: () => boolean;
}

const FRAME_INTERVAL_MS = 800;
const PLANETARY_COMPUTER_CROP_PATH = '/api/data/v1/item/bbox/';

const formatUtc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Crops this lookup builds are all requested in a latitude-longitude grid, so north is up. */
export function imageGrid(url: string): ImageGrid {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'planetarycomputer.microsoft.com' && parsed.pathname.startsWith(PLANETARY_COMPUTER_CROP_PATH)) return 'north-up';
    const base = `${parsed.origin}${parsed.pathname}`;
    if ((base === GIBS_WMS_ENDPOINT || base === EUMETSAT_WMS_ENDPOINT) && parsed.searchParams.get('CRS') === 'EPSG:4326') return 'north-up';
  } catch {
    return 'unreferenced';
  }
  return 'unreferenced';
}

const viewable = (url: string | null): string | null => (url && isAllowedPreviewUrl(url) ? url : null);

export function sceneFromAcquisition(acquisition: MatchedAcquisition): ViewerScene {
  const imageUrl = viewable(acquisition.imageUrl);
  return {
    key: acquisition.key,
    collection: acquisition.profileId,
    name: acquisition.platform.toUpperCase(),
    timeMs: acquisition.startMs,
    dateLabel: formatUtc(acquisition.startMs),
    imageUrl,
    cloudCoverPct: acquisition.cloudCoverPct,
    cloudApplies: acquisition.profileId !== 'sentinel-1',
    credit: acquisition.profileId === 'landsat' ? IMAGE_CREDIT.usgs : IMAGE_CREDIT.copernicus(new Date(acquisition.startMs).getUTCFullYear()),
    acknowledgement: null,
    conditionText: describePointCondition(acquisition),
    grid: imageUrl ? imageGrid(imageUrl) : 'unreferenced',
  };
}

export function scenesFromMosaic(mosaic: DailyMosaicRow): ViewerScene[] {
  return mosaic.days.map(({ date, imageUrl }) => {
    const url = viewable(imageUrl);
    return {
      key: `${mosaic.layer}:${date}`,
      collection: mosaic.layer,
      name: mosaic.source,
      timeMs: Date.parse(date),
      dateLabel: date,
      imageUrl: url,
      cloudCoverPct: null,
      cloudApplies: false,
      credit: IMAGE_CREDIT.gibs,
      acknowledgement: IMAGE_CREDIT.gibsAcknowledgement,
      conditionText: null,
      grid: url ? imageGrid(url) : 'unreferenced',
    };
  });
}

export function sceneFromFrame(frame: GeostationaryRow): ViewerScene | null {
  if (!frame.latest) return null;
  const url = viewable(frame.latest.imageUrl);
  const timeMs = Date.parse(frame.latest.time);
  const eumetsat = frame.archive === 'eumetsat';
  return {
    key: `${frame.layer}:${frame.latest.time}`,
    collection: frame.layer,
    name: frame.source,
    timeMs,
    dateLabel: formatUtc(timeMs),
    imageUrl: url,
    cloudCoverPct: null,
    cloudApplies: false,
    credit: eumetsat ? IMAGE_CREDIT.eumetsat : IMAGE_CREDIT.gibs,
    acknowledgement: eumetsat ? null : IMAGE_CREDIT.gibsAcknowledgement,
    conditionText: null,
    grid: url ? imageGrid(url) : 'unreferenced',
  };
}

type HistoryState =
  | { kind: 'none' }
  | { kind: 'searching' }
  | { kind: 'failed'; failure: ArchiveFailure }
  | { kind: 'answered' };

type TimelapseState =
  | { kind: 'idle' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'too-few-loaded'; loaded: number }
  | { kind: 'ready'; frames: ViewerScene[]; index: number; playing: boolean };

/** One acquisition per sensing time: the lookup's scenes and the history search can return the same acquisition. */
function mergeScenes(collection: string, ...sources: ViewerScene[][]): ViewerScene[] {
  const merged: ViewerScene[] = [];
  for (const scene of sources.flat()) {
    if (scene.collection !== collection || !scene.imageUrl) continue;
    if (merged.some((seen) => seen.key === scene.key || (seen.name === scene.name && Math.abs(seen.timeMs - scene.timeMs) < 10 * 60_000))) continue;
    merged.push(scene);
  }
  return merged.sort((a, b) => b.timeMs - a.timeMs);
}

function sceneImage(scene: ViewerScene, className: string): DomChild {
  const url = viewable(scene.imageUrl);
  if (!url) return null;
  return h('img', { className, src: url, alt: t('orbitalWatch.viewer.imageAlt', { name: scene.name, time: scene.dateLabel }), decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal viewer over the lookup sheet: one image with its credit, a before/after slider, and a time-lapse. */
export class OrbitalImageViewer {
  private readonly root: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly body: HTMLElement;
  private readonly controller = new AbortController();
  private history: HistoryState;
  private scenes: ViewerScene[];
  private compareKey: string | null = null;
  private dividerPct = 50;
  private timelapse: TimelapseState = { kind: 'idle' };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: Required<ViewerDependencies>;

  constructor(private readonly subject: ImageViewerSubject, private readonly returnFocusTo: HTMLElement | null, deps: ViewerDependencies = {}) {
    this.deps = {
      searchHistory: deps.searchHistory ?? searchSceneHistory,
      loadImage: deps.loadImage ?? ((url, signal) => import('@/services/orbital/timelapse').then((m) => m.loadImageElement(url, signal))),
      prefersReducedMotion: deps.prefersReducedMotion ?? (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    };
    this.scenes = mergeScenes(subject.selected.collection, [subject.selected], subject.scenes);
    this.history = subject.historyProfile ? { kind: 'searching' } : { kind: 'none' };
    const titleId = 'orbital-image-viewer-title';
    this.body = h('div', { className: 'oiv-body' });
    this.dialog = h('section', { className: 'oiv-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('header', { className: 'oiv-header' },
        h('h2', { id: titleId }, subject.selected.name, ' ', h('span', { className: 'oiv-heading-date' }, subject.selected.dateLabel)),
        h('button', { type: 'button', className: 'oiv-close', 'aria-label': t('orbitalWatch.viewer.close'), dataset: { action: 'close' } }, '×')),
      this.body);
    this.root = h('div', { className: 'oiv-backdrop' }, this.dialog);
    declareOverlay(this.root, { reload: 'safe' });
    this.root.addEventListener('keydown', this.onKeydown);
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
  }

  open(): void {
    document.body.appendChild(this.root);
    this.compareKey = defaultCompareScene(this.subject.selected, this.scenes)?.key ?? null;
    this.render();
    this.dialog.focus();
    if (this.subject.historyProfile) void this.loadHistory(this.subject.historyProfile);
  }

  get isOpen(): boolean {
    return this.root.isConnected;
  }

  close(): void {
    if (!this.isOpen) return;
    this.controller.abort();
    this.stopTimer();
    this.root.remove();
    const target = this.returnFocusTo?.isConnected ? this.returnFocusTo : document.querySelector<HTMLElement>('.orbital-watch-sheet');
    target?.focus({ preventScroll: true });
  }

  private async loadHistory(profileId: ImagingProfileId): Promise<void> {
    const { signal } = this.controller;
    this.history = { kind: 'searching' };
    this.render();
    let result: SceneHistory;
    try {
      await afterDebugBearRequestWindow(signal);
      result = await this.deps.searchHistory(this.subject.point, profileId, this.subject.nowMs, { signal });
    } catch {
      return;
    }
    if (signal.aborted) return;
    if (result.status === 'failed') {
      this.history = { kind: 'failed', failure: result.failure };
    } else {
      this.history = { kind: 'answered' };
      this.scenes = mergeScenes(this.subject.selected.collection, this.scenes, result.scenes.map(sceneFromAcquisition));
      if (!this.compareKey) this.compareKey = defaultCompareScene(this.subject.selected, this.scenes)?.key ?? null;
    }
    this.render();
  }

  private render(): void {
    const focusedAction = (document.activeElement as HTMLElement | null)?.dataset?.action;
    const { selected } = this.subject;
    replaceChildren(this.body,
      this.renderImage(selected),
      h('p', { className: 'oiv-credit' }, selected.credit),
      selected.acknowledgement ? h('p', { className: 'oiv-credit oiv-acknowledgement' }, selected.acknowledgement) : null,
      this.renderHistoryNote(),
      this.renderCompare(),
      this.renderTimelapse());
    if (focusedAction) this.body.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`)?.focus();
  }

  private renderImage(scene: ViewerScene): HTMLElement {
    const north = scene.grid === 'north-up'
      ? h('span', { className: 'oiv-north', role: 'img', 'aria-label': t('orbitalWatch.viewer.northUp') }, h('span', { 'aria-hidden': 'true' }, '▲'), 'N')
      : h('span', { className: 'oiv-orientation' }, t('orbitalWatch.viewer.unreferenced'));
    const caption = [scene.dateLabel, scene.conditionText].filter(Boolean).join(' · ');
    return h('figure', { className: 'oiv-figure' },
      h('div', { className: 'oiv-frame' }, sceneImage(scene, 'oiv-image'), north),
      h('figcaption', null, caption));
  }

  private renderHistoryNote(): DomChild {
    switch (this.history.kind) {
      case 'none':
      case 'answered':
        return null;
      case 'searching':
        return h('p', { className: 'oiv-status', role: 'status' }, t('orbitalWatch.viewer.searching', { days: HISTORY_DAYS }));
      case 'failed': {
        const { failure } = this.history;
        const key = failure.reason === 'timeout' ? 'orbitalWatch.viewer.historyTimeout' : 'orbitalWatch.viewer.historyFailed';
        return h('div', { className: 'ow-banner ow-banner-partial', role: 'note' },
          h('p', null, t(key, { archive: ARCHIVE_NAME[failure.archive] })),
          h('button', { type: 'button', className: 'ow-retry', dataset: { action: 'retry-history' } }, t('countryBrief.retryBtn')));
      }
    }
  }

  private renderCompare(): DomChild {
    const others = this.scenes.filter((scene) => scene.key !== this.subject.selected.key);
    if (others.length === 0) {
      return this.history.kind === 'searching' || this.history.kind === 'failed' ? null : h('p', { className: 'oiv-note' }, t('orbitalWatch.viewer.compareNone'));
    }
    const other = others.find((scene) => scene.key === this.compareKey) ?? others[0]!;
    const [before, after] = other.timeMs < this.subject.selected.timeMs ? [other, this.subject.selected] : [this.subject.selected, other];
    const strip = h('div', { className: 'oiv-strip', role: 'group', 'aria-label': t('orbitalWatch.viewer.compareDates') },
      ...others.map((scene) => h('button', {
        type: 'button',
        className: 'oiv-date',
        'aria-pressed': String(scene.key === other.key),
        dataset: { action: 'compare-date', key: scene.key },
      }, scene.dateLabel.slice(0, 10), scene.cloudApplies && scene.cloudCoverPct !== null ? h('span', { className: 'oiv-date-cloud' }, t('orbitalWatch.viewer.cloud', { pct: Math.round(scene.cloudCoverPct) })) : null)));
    return h('section', { className: 'oiv-section oiv-compare', 'aria-label': t('orbitalWatch.viewer.compare') },
      h('h3', null, t('orbitalWatch.viewer.compare')),
      h('div', { className: 'oiv-slider', style: `--oiv-divider: ${this.dividerPct}%` },
        sceneImage(before, 'oiv-image oiv-before'),
        sceneImage(after, 'oiv-image oiv-after'),
        h('span', { className: 'oiv-slider-label oiv-slider-label-before' }, before.dateLabel.slice(0, 10)),
        h('span', { className: 'oiv-slider-label oiv-slider-label-after' }, after.dateLabel.slice(0, 10))),
      h('input', { type: 'range', min: '0', max: '100', value: String(this.dividerPct), className: 'oiv-divider', 'aria-label': t('orbitalWatch.viewer.divider'), dataset: { action: 'divider' } }),
      strip);
  }

  private renderTimelapse(): DomChild {
    if (!this.subject.historyProfile || this.history.kind !== 'answered') return null;
    const candidates = timelapseFrames(this.scenes, this.subject.nowMs);
    const heading = h('h3', null, t('orbitalWatch.viewer.timelapse'));
    const section = (...children: DomChild[]) => h('section', { className: 'oiv-section oiv-timelapse', 'aria-label': t('orbitalWatch.viewer.timelapse') }, heading, ...children);
    if (candidates.length < MIN_TIMELAPSE_FRAMES) {
      return section(h('p', { className: 'oiv-note', dataset: { timelapse: 'insufficient' } }, t('orbitalWatch.viewer.notEnough', { count: candidates.length, min: MIN_TIMELAPSE_FRAMES, days: HISTORY_DAYS })));
    }
    const state = this.timelapse;
    switch (state.kind) {
      case 'idle':
        return section(h('button', { type: 'button', className: 'ow-retry', dataset: { action: 'timelapse-start' } }, t('orbitalWatch.viewer.play', { count: candidates.length })));
      case 'loading':
        return section(h('p', { className: 'oiv-status', role: 'status' }, t('orbitalWatch.viewer.loading', { loaded: state.loaded, total: state.total })));
      case 'too-few-loaded':
        return section(h('p', { className: 'oiv-note', dataset: { timelapse: 'insufficient' } }, t('orbitalWatch.viewer.tooFewLoaded', { count: state.loaded, min: MIN_TIMELAPSE_FRAMES })));
      case 'ready': {
        const frame = state.frames[state.index]!;
        const reduced = this.deps.prefersReducedMotion();
        const controls = reduced
          ? [
            h('button', { type: 'button', className: 'ow-retry', 'aria-label': t('orbitalWatch.viewer.previous'), dataset: { action: 'frame-previous' } }, '‹'),
            h('button', { type: 'button', className: 'ow-retry', 'aria-label': t('orbitalWatch.viewer.next'), dataset: { action: 'frame-next' } }, '›'),
          ]
          : [h('button', { type: 'button', className: 'ow-retry', dataset: { action: 'timelapse-toggle' } }, state.playing ? t('orbitalWatch.viewer.pause') : t('orbitalWatch.viewer.resume'))];
        return section(
          h('div', { className: 'oiv-frame', dataset: { timelapse: reduced ? 'stepper' : 'autoplay' } }, sceneImage(frame, 'oiv-image oiv-timelapse-frame')),
          h('p', { className: 'oiv-frame-label', 'aria-live': 'polite' }, t('orbitalWatch.viewer.frame', { index: state.index + 1, total: state.frames.length, date: frame.dateLabel.slice(0, 10) })),
          h('div', { className: 'oiv-controls' }, ...controls));
      }
    }
  }

  private async startTimelapse(): Promise<void> {
    const { signal } = this.controller;
    const candidates = timelapseFrames(this.scenes, this.subject.nowMs);
    this.timelapse = { kind: 'loading', loaded: 0, total: candidates.length };
    this.render();
    const frames = await preloadFrames(candidates, signal, (loaded, total) => {
      this.timelapse = { kind: 'loading', loaded, total };
      this.render();
    }, this.deps.loadImage);
    if (signal.aborted) return;
    if (frames.length < MIN_TIMELAPSE_FRAMES) {
      this.timelapse = { kind: 'too-few-loaded', loaded: frames.length };
      this.render();
      return;
    }
    const playing = !this.deps.prefersReducedMotion();
    this.timelapse = { kind: 'ready', frames, index: 0, playing };
    if (playing) this.startTimer();
    this.render();
  }

  private step(delta: number): void {
    if (this.timelapse.kind !== 'ready') return;
    const { frames } = this.timelapse;
    this.timelapse = { ...this.timelapse, index: (this.timelapse.index + delta + frames.length) % frames.length };
    this.render();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.step(1), FRAME_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
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
      case 'retry-history':
        if (this.subject.historyProfile) void this.loadHistory(this.subject.historyProfile);
        return;
      case 'compare-date':
        this.compareKey = action.dataset.key ?? null;
        this.render();
        this.body.querySelector<HTMLElement>(`[data-action="compare-date"][data-key="${CSS.escape(this.compareKey ?? '')}"]`)?.focus();
        return;
      case 'timelapse-start':
        void this.startTimelapse();
        return;
      case 'timelapse-toggle':
        if (this.timelapse.kind !== 'ready') return;
        this.timelapse = { ...this.timelapse, playing: !this.timelapse.playing };
        if (this.timelapse.playing) this.startTimer();
        else this.stopTimer();
        this.render();
        return;
      case 'frame-previous':
        this.step(-1);
        return;
      case 'frame-next':
        this.step(1);
        return;
    }
  };

  private readonly onInput = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.action !== 'divider') return;
    this.dividerPct = Number(input.value);
    this.body.querySelector<HTMLElement>('.oiv-slider')?.style.setProperty('--oiv-divider', `${this.dividerPct}%`);
  };

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === this.dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

let current: OrbitalImageViewer | null = null;

/** Opens the viewer, replacing any viewer already open. */
export function openOrbitalImageViewer(subject: ImageViewerSubject, returnFocusTo: HTMLElement | null, deps?: ViewerDependencies): OrbitalImageViewer {
  current?.close();
  current = new OrbitalImageViewer(subject, returnFocusTo, deps);
  current.open();
  return current;
}

export type ViewableImage = { kind: 'acquisition' | 'mosaic' | 'frame'; key: string };

/** Builds the viewer subject for an image the lookup sheet shows, or null when that image is gone. */
export function subjectForImage(evidence: OrbitalEvidence, image: ViewableImage, lookup: { point: GeoPoint; nowMs: number }): ImageViewerSubject | null {
  const base = { point: lookup.point, nowMs: lookup.nowMs };
  switch (image.kind) {
    case 'acquisition': {
      const acquisition = evidence.acquisitions.find((candidate) => candidate.key === image.key);
      if (!acquisition) return null;
      const scenes = evidence.acquisitions.filter((candidate) => candidate.profileId === acquisition.profileId).map(sceneFromAcquisition);
      return { ...base, selected: sceneFromAcquisition(acquisition), scenes, historyProfile: acquisition.profileId };
    }
    case 'mosaic': {
      const mosaic = evidence.mosaics.find((candidate) => candidate.layer === image.key);
      const scenes = mosaic ? scenesFromMosaic(mosaic) : [];
      return scenes[0] ? { ...base, selected: scenes[0], scenes, historyProfile: null } : null;
    }
    case 'frame': {
      const frame = evidence.frames.find((candidate) => candidate.layer === image.key);
      const scene = frame ? sceneFromFrame(frame) : null;
      return scene ? { ...base, selected: scene, scenes: [], historyProfile: null } : null;
    }
  }
}
