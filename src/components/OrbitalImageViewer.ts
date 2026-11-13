import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { ArchiveFailure } from '@/services/orbital/archive-result';
import type { ImagingProfileId } from '@/services/orbital/archive-stac';
import type { DailyMosaicRow, GeostationaryRow } from '@/services/orbital/archive-gibs';
import { DEFAULT_CROP_HALF_SIZE_KM, EUMETSAT_WMS_ENDPOINT, GIBS_WMS_ENDPOINT } from '@/services/orbital/crop-url';
import { describePointCondition, type MatchedAcquisition, type OrbitalEvidence } from '@/services/orbital/match';
import {
  CLEAR_LOOK_CLOUD_PCT,
  defaultCompareScene,
  isClearScene,
  HISTORY_DAYS,
  searchSceneHistory,
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
import { closeButton, formatPoint, reticle, trapTab } from './OrbitalTimelapse';
import '../styles/orbital-image-viewer.css';

/** How the image's pixels sit against the ground: a geographic grid is north-up; a raw quick-look is not georeferenced. */
export type ImageGrid = 'north-up' | 'unreferenced';

export interface ViewerScene extends DatedScene {
  /** Scenes compare only within one collection: a mission, or one mosaic or frame layer. */
  collection: string;
  name: string;
  dateLabel: string;
  credit: string;
  conditionText: string | null;
  grid: ImageGrid;
  /** Ground size of one pixel, when the archive states it. */
  resolutionM: number | null;
  sunElevationDeg: number | null;
}

export interface ImageViewerSubject {
  point: GeoPoint;
  nowMs: number;
  selected: ViewerScene;
  /** Other scenes of the same collection the lookup already holds. */
  scenes: ViewerScene[];
  /** The mission whose earlier scenes are searched for compare and time-lapse; null for mosaics and frames. */
  historyProfile: ImagingProfileId | null;
  /** The place name, or null to show the rounded point. */
  place?: string | null;
}

export interface ViewerDependencies {
  searchHistory?: typeof searchSceneHistory;
  loadImage?: LoadImage;
  prefersReducedMotion?: () => boolean;
}

/** Crops this lookup builds span 6 km, so a 2 km bar is a third of the frame. */
const CROP_WIDTH_KM = 2 * DEFAULT_CROP_HALF_SIZE_KM;
const SCALE_BAR_KM = 2;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
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
    conditionText: describePointCondition(acquisition),
    grid: imageUrl ? imageGrid(imageUrl) : 'unreferenced',
    resolutionM: acquisition.resolutionM,
    sunElevationDeg: acquisition.sunElevationDeg,
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
      credit: IMAGE_CREDIT.gibsAcknowledgement,
      conditionText: null,
      grid: url ? imageGrid(url) : 'unreferenced',
      resolutionM: null,
      sunElevationDeg: null,
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
    credit: eumetsat ? IMAGE_CREDIT.eumetsat : IMAGE_CREDIT.gibsAcknowledgement,
    conditionText: null,
    grid: url ? imageGrid(url) : 'unreferenced',
    resolutionM: null,
    sunElevationDeg: null,
  };
}

type HistoryState =
  | { kind: 'none' }
  | { kind: 'searching' }
  | { kind: 'failed'; failure: ArchiveFailure }
  | { kind: 'answered' };

type ViewerMode = 'image' | 'change';

/** One acquisition per sensing time, since the lookup and the history search can return the same one. Only crops requested for this point's box in a latitude-longitude grid line up, so only they compare. */
function mergeScenes(collection: string, ...sources: ViewerScene[][]): ViewerScene[] {
  const merged: ViewerScene[] = [];
  for (const scene of sources.flat()) {
    if (scene.collection !== collection || !scene.imageUrl || scene.grid !== 'north-up') continue;
    if (merged.some((seen) => seen.key === scene.key || (seen.name === scene.name && Math.abs(seen.timeMs - scene.timeMs) < 10 * 60_000))) continue;
    merged.push(scene);
  }
  return merged.sort((a, b) => b.timeMs - a.timeMs);
}


const pad2 = (n: number) => String(n).padStart(2, '0');
const shortDate = (ms: number) => {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};
const chipDate = (ms: number) => {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};
const clock = (ms: number) => {
  const date = new Date(ms);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
};

function ago(ms: number, nowMs: number): string {
  const hours = Math.max(0, (nowMs - ms) / 3_600_000);
  if (hours < 1) return t('orbitalWatch.viewer.agoNow');
  if (hours < 48) return t('orbitalWatch.viewer.agoHours', { count: Math.round(hours) });
  return t('orbitalWatch.viewer.agoDays', { count: Math.round(hours / 24) });
}

function cloudWord(scene: ViewerScene): string | null {
  if (!scene.cloudApplies) return null;
  if (scene.cloudCoverPct === null) return null;
  return scene.cloudCoverPct < CLEAR_LOOK_CLOUD_PCT ? t('orbitalWatch.viewer.clear') : t('orbitalWatch.viewer.clouded', { pct: Math.round(scene.cloudCoverPct) });
}

function sceneImage(scene: ViewerScene, className: string): DomChild {
  const url = viewable(scene.imageUrl);
  if (!url) return null;
  return h('img', { className, src: url, alt: t('orbitalWatch.viewer.imageAlt', { name: scene.name, time: scene.dateLabel }), decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
}

function metaCell(label: string, value: string, unit: string | null = null): HTMLElement {
  return h('div', null, h('dt', null, label), h('dd', { className: /\d/.test(value) ? undefined : 'oiv-meta-text' }, value, unit ? h('small', null, unit) : null));
}

/** A full-screen viewer over the lookup sheet: one large crop with its metadata, and a before/after slider. */
export class OrbitalImageViewer {
  private readonly root: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly body: HTMLElement;
  private readonly controller = new AbortController();
  private readonly historyProfile: ImagingProfileId | null;
  private history: HistoryState;
  private scenes: ViewerScene[];
  private mode: ViewerMode = 'image';
  private showCloudy = false;
  private pickedCompareKey: string | null = null;
  private dividerPct = 50;
  /** Images known to have decoded, or failed, in this viewer. */
  private readonly loadedUrls = new Set<string>();
  private readonly failedUrls = new Set<string>();
  private readonly pendingUrls = new Set<string>();
  private readonly deps: Required<ViewerDependencies>;

  constructor(private readonly subject: ImageViewerSubject, private readonly returnFocusTo: HTMLElement | null, deps: ViewerDependencies = {}) {
    this.deps = {
      searchHistory: deps.searchHistory ?? searchSceneHistory,
      loadImage: deps.loadImage ?? ((url, signal) => import('@/services/orbital/timelapse').then((m) => m.loadImageElement(url, signal))),
      prefersReducedMotion: deps.prefersReducedMotion ?? (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    };
    this.scenes = mergeScenes(subject.selected.collection, [subject.selected], subject.scenes);
    this.historyProfile = subject.selected.grid === 'north-up' ? subject.historyProfile : null;
    this.history = this.historyProfile ? { kind: 'searching' } : { kind: 'none' };
    const titleId = 'orbital-image-viewer-title';
    this.body = h('div', { className: 'oiv-main' });
    this.dialog = h('section', { className: 'oiv-page oiv-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('header', { className: 'oiv-bar' },
        h('h2', { id: titleId, className: 'oiv-crumb' }, subject.selected.name, ' / ', h('span', { className: 'oiv-crumb-place' }, this.place)),
        closeButton()),
      this.body);
    this.root = h('div', { className: 'oiv-backdrop' }, this.dialog);
    declareOverlay(this.root, { reload: 'safe' });
    this.root.addEventListener('keydown', this.onKeydown);
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
  }

  private get place(): string {
    return this.subject.place ?? formatPoint(this.subject.point);
  }

  open(): void {
    document.body.appendChild(this.root);
    this.render();
    this.dialog.focus();
    if (this.historyProfile) void this.loadHistory(this.historyProfile);
  }

  get isOpen(): boolean {
    return this.root.isConnected;
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.controller.abort();
    this.root.remove();
    if (!restoreFocus) return;
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
    }
    this.render();
  }

  /** Scenes that can sit beside the selected one; cloudy dates are left out unless asked for, since they would only compare cloud. */
  private get compareCandidates(): ViewerScene[] {
    if (this.subject.selected.grid !== 'north-up') return [];
    return this.scenes.filter((scene) => scene.key !== this.subject.selected.key && (this.showCloudy || isClearScene(scene)) && !this.failedUrls.has(scene.imageUrl!));
  }

  private get hiddenCloudyCount(): number {
    return this.scenes.filter((scene) => scene.key !== this.subject.selected.key && !isClearScene(scene)).length;
  }

  private get compareKey(): string | null {
    const candidates = this.compareCandidates;
    if (this.pickedCompareKey && candidates.some((scene) => scene.key === this.pickedCompareKey)) return this.pickedCompareKey;
    return defaultCompareScene(this.subject.selected, candidates)?.key ?? null;
  }

  /** Counts how many of the images have decoded, starting a load for each one not yet requested. */
  private ensureLoaded(urls: string[]): number {
    const { signal } = this.controller;
    for (const url of urls) {
      if (this.loadedUrls.has(url) || this.failedUrls.has(url) || this.pendingUrls.has(url)) continue;
      this.pendingUrls.add(url);
      this.deps.loadImage(url, signal).then(
        () => this.loadedUrls.add(url),
        () => this.failedUrls.add(url),
      ).finally(() => {
        this.pendingUrls.delete(url);
        if (!signal.aborted) this.render();
      });
    }
    return urls.filter((url) => this.loadedUrls.has(url)).length;
  }

  private get canCompare(): boolean {
    const { selected } = this.subject;
    return selected.grid === 'north-up' && !this.failedUrls.has(selected.imageUrl!);
  }

  private render(): void {
    const active = document.activeElement as HTMLElement | null;
    const focusedAction = this.dialog.contains(active) ? active?.dataset?.action : undefined;
    const focusedKey = active?.dataset?.key;
    if (this.mode === 'change' && !this.canCompare) this.mode = 'image';
    replaceChildren(this.body,
      this.mode === 'change' ? this.renderCompareStage() : this.renderImageStage(),
      this.renderSide());
    if (focusedAction) {
      const selector = focusedKey ? `[data-action="${focusedAction}"][data-key="${CSS.escape(focusedKey)}"]` : `[data-action="${focusedAction}"]`;
      (this.body.querySelector<HTMLElement>(selector) ?? this.body.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`))?.focus();
    }
    if (!this.dialog.contains(document.activeElement)) this.dialog.focus({ preventScroll: true });
  }

  private overlays(scene: ViewerScene): DomChild[] {
    if (scene.grid !== 'north-up') return [];
    return [
      reticle(),
      h('span', { className: 'oiv-scale oiv-label', style: `width: ${(SCALE_BAR_KM / CROP_WIDTH_KM) * 100}%` }, `${SCALE_BAR_KM} KM`, h('span', { className: 'oiv-scale-bar', 'aria-hidden': 'true' })),
      h('span', { className: 'oiv-north', role: 'img', 'aria-label': t('orbitalWatch.viewer.northUp') }, '▲ N'),
    ];
  }

  private renderImageStage(): HTMLElement {
    const scene = this.subject.selected;
    const second = [
      scene.resolutionM !== null ? `${Math.round(scene.resolutionM)} M` : null,
      ago(scene.timeMs, this.subject.nowMs),
      cloudWord(scene),
    ].filter(Boolean).join(' · ');
    return h('figure', { className: 'oiv-column oiv-figure' },
      h('div', { className: 'oiv-stage' }, sceneImage(scene, 'oiv-image'), ...this.overlays(scene)),
      h('figcaption', { className: 'oiv-caption' },
        h('span', null, `${scene.name} · ${shortDate(scene.timeMs)} · ${clock(scene.timeMs)}`),
        h('span', null, second)),
      scene.grid === 'north-up' ? null : h('p', { className: 'oiv-note' }, t('orbitalWatch.viewer.unreferenced')),
      h('p', { className: 'oiv-credit' }, scene.credit));
  }

  private renderCompareStage(): HTMLElement {
    const { selected } = this.subject;
    const others = this.compareCandidates;
    const stillSearching = this.history.kind === 'searching' && !this.pickedCompareKey;
    const other = stillSearching ? undefined : others.find((scene) => scene.key === this.compareKey);
    if (!other) {
      const message = this.history.kind === 'searching'
        ? t('orbitalWatch.viewer.searching', { days: HISTORY_DAYS })
        : t('orbitalWatch.viewer.compareNone');
      return h('div', { className: 'oiv-column oiv-compare' },
        h('div', { className: `oiv-stage ${this.history.kind === 'searching' ? 'oiv-skeleton' : 'oiv-stage-empty'}`, role: 'status' }, h('span', { className: 'oiv-label' }, message)));
    }
    const [before, after] = other.timeMs < selected.timeMs ? [other, selected] : [selected, other];
    const pair = [before.imageUrl!, after.imageUrl!];
    const loaded = this.ensureLoaded(pair);
    if (loaded < pair.length) {
      return h('div', { className: 'oiv-column oiv-compare' },
        h('div', { className: 'oiv-stage oiv-skeleton', role: 'status' }, h('span', { className: 'oiv-label' }, t('orbitalWatch.viewer.loading', { loaded, total: pair.length }))));
    }
    return h('div', { className: 'oiv-column oiv-compare' },
      h('div', { className: 'oiv-stage oiv-slider', style: `--oiv-divider: ${this.dividerPct}%` },
        sceneImage(before, 'oiv-image oiv-before'),
        sceneImage(after, 'oiv-image oiv-after'),
        reticle(),
        h('span', { className: 'oiv-chip oiv-chip-before' }, chipDate(before.timeMs)),
        h('span', { className: 'oiv-chip oiv-chip-after' }, chipDate(after.timeMs))),
      h('input', { type: 'range', min: '0', max: '100', value: String(this.dividerPct), className: 'oiv-divider', 'aria-label': t('orbitalWatch.viewer.divider'), dataset: { action: 'divider' } }),
      h('p', { className: 'oiv-credit' }, before.credit === after.credit ? after.credit : `${before.credit} · ${after.credit}`));
  }

  private renderHistoryNote(): DomChild {
    if (this.history.kind !== 'failed') return null;
    const { failure } = this.history;
    const key = failure.reason === 'timeout' ? 'orbitalWatch.viewer.historyTimeout' : 'orbitalWatch.viewer.historyFailed';
    return h('div', { className: 'oiv-note', role: 'note' },
      h('p', null, t(key, { archive: ARCHIVE_NAME[failure.archive] })),
      h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'retry-history' } }, t('countryBrief.retryBtn')));
  }

  private renderSide(): HTMLElement {
    const scene = this.subject.selected;
    const tab = (mode: ViewerMode, label: string) => h('button', {
      type: 'button',
      role: 'tab',
      className: 'oiv-tab',
      'aria-selected': String(this.mode === mode),
      dataset: { action: 'mode', mode },
    }, label);
    const tabs = this.canCompare
      ? h('div', { className: 'oiv-tabs', role: 'tablist' }, tab('image', t('orbitalWatch.viewer.tabImage')), tab('change', t('orbitalWatch.viewer.tabChange')))
      : null;
    const timelapse = this.historyProfile === 'sentinel-2' || this.historyProfile === 'landsat'
      ? h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'timelapse' } }, '▸ ', t('orbitalWatch.timelapse.heading'))
      : null;
    return h('aside', { className: 'oiv-side' },
      tabs,
      ...(this.mode === 'change' ? this.renderDates() : [this.renderMeta(scene)]),
      this.renderHistoryNote(),
      timelapse ? h('div', { className: 'oiv-actions' }, timelapse) : null);
  }

  private renderMeta(scene: ViewerScene): HTMLElement {
    return h('dl', { className: 'oiv-meta' },
      metaCell(t('orbitalWatch.viewer.metaAcquired'), clock(scene.timeMs)),
      metaCell(t('orbitalWatch.viewer.metaDate'), shortDate(scene.timeMs)),
      scene.resolutionM !== null ? metaCell(t('orbitalWatch.viewer.metaPixel'), String(Math.round(scene.resolutionM)), 'M') : null,
      scene.cloudApplies ? metaCell(t('orbitalWatch.viewer.metaSpot'), scene.conditionText ?? '—') : null,
      scene.cloudApplies && scene.cloudCoverPct !== null ? metaCell(t('orbitalWatch.viewer.metaScene'), String(Math.round(scene.cloudCoverPct)), '%') : null,
      scene.sunElevationDeg !== null ? metaCell(t('orbitalWatch.viewer.metaSun'), scene.sunElevationDeg.toFixed(0), '°') : null);
  }

  private renderDates(): DomChild[] {
    const others = this.compareCandidates;
    const pickedKey = this.compareKey;
    const hidden = this.hiddenCloudyCount;
    return [
      h('p', { className: 'oiv-label', style: 'margin: 0 0 8px; color: var(--oiv-dim)' }, t('orbitalWatch.viewer.compareDates')),
      others.length > 0
        ? h('ul', { className: 'oiv-dates', role: 'group', 'aria-label': t('orbitalWatch.viewer.compareDates') }, ...others.map((scene) => h('li', null, h('button', {
          type: 'button',
          className: 'oiv-date',
          'aria-pressed': String(scene.key === pickedKey),
          dataset: { action: 'compare-date', key: scene.key },
        }, h('span', null, chipDate(scene.timeMs)), cloudWord(scene) ? h('span', { className: 'oiv-date-cloud' }, cloudWord(scene)!) : null))))
        : null,
      hidden > 0 || this.showCloudy
        ? h('button', { type: 'button', className: 'oiv-toggle', 'aria-pressed': String(this.showCloudy), dataset: { action: 'show-cloudy' } }, t('orbitalWatch.viewer.showCloudy', { count: hidden }))
        : null,
    ];
  }

  private openTimelapse(): void {
    const { point, nowMs } = this.subject;
    const place = this.place;
    const returnFocusTo = this.returnFocusTo;
    this.close(false);
    void import('./OrbitalTimelapse').then(({ openOrbitalTimelapse }) => openOrbitalTimelapse({ point, nowMs, place }, returnFocusTo));
  }

  private readonly onClick = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    switch (action?.dataset.action) {
      case 'close':
        this.close();
        return;
      case 'retry-history':
        if (this.historyProfile) void this.loadHistory(this.historyProfile);
        return;
      case 'mode':
        this.mode = action.dataset.mode === 'change' ? 'change' : 'image';
        this.render();
        return;
      case 'show-cloudy':
        this.showCloudy = !this.showCloudy;
        this.render();
        return;
      case 'compare-date':
        this.pickedCompareKey = action.dataset.key ?? null;
        this.render();
        return;
      case 'timelapse':
        this.openTimelapse();
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
    trapTab(event, this.dialog);
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
