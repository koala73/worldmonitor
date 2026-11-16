import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { LoadedArchiveImage } from '@/services/orbital/archive-image';
import type { ArchiveFailure } from '@/services/orbital/archive-result';
import type { ImagingProfileId } from '@/services/orbital/archive-stac';
import type { DailyMosaicRow, GeostationaryRow } from '@/services/orbital/archive-gibs';
import type { EventPair } from '@/services/orbital/event-imagery';
import { DEFAULT_CROP_HALF_SIZE_KM } from '@/services/orbital/crop-url';
import { describePointCondition, type MatchedAcquisition, type OrbitalEvidence } from '@/services/orbital/match';
import {
  CLEAR_LOOK_CLOUD_PCT,
  defaultCompareScene,
  isClearScene,
  HISTORY_ARCHIVE,
  HISTORY_DAYS,
  searchSceneHistory,
  type DatedScene,
  type LoadImage,
  type SceneHistory,
  imageGrid,
  type ImageGrid,
} from '@/services/orbital/scene-history';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';
import { IMAGE_CREDIT } from '@/services/orbital/credits';
import { ARCHIVE_NAME, archiveHost, loadLookupImage } from './OrbitalWatchPage';
import { closeButton, formatPoint, reticle, trapTab } from './orbital-dialog';
import '../styles/orbital-image-viewer.css';

export interface ViewerScene extends DatedScene {
  /** Scenes compare only within one collection: a mission, or one mosaic or frame layer. */
  collection: string;
  name: string;
  dateLabel: string;
  credit: string;
  conditionText: string | null;
  /** How the pixels sit against the ground: a geographic grid is north-up; a raw quick-look is not georeferenced. */
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
  /** The mission whose earlier scenes are searched for compare; null for mosaics and frames. */
  historyProfile: ImagingProfileId | null;
  /** The place name, or null to show the rounded point. */
  place?: string | null;
  /** Where the compare history window ends; `nowMs` when absent. Set when the window is anchored on an event. */
  historyEndMs?: number;
  /** The time of the map event the before/after is anchored on. */
  eventMs?: number;
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

const formatUtc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';


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
      credit: IMAGE_CREDIT.gibs,
      conditionText: null,
      grid: url ? imageGrid(url) : 'unreferenced',
      resolutionM: null,
      sunElevationDeg: null,
    };
  });
}

/** The newest frame first, then the earlier ones the archive keeps in case it advertised the newest before serving it. */
export function scenesFromFrame(frame: GeostationaryRow): ViewerScene[] {
  if (!frame.latest) return [];
  const eumetsat = frame.archive === 'eumetsat';
  return [frame.latest, ...frame.latest.fallbacks].map(({ time, imageUrl }) => {
    const url = viewable(imageUrl);
    const timeMs = Date.parse(time);
    return {
      key: `${frame.layer}:${time}`,
      collection: frame.layer,
      name: frame.source,
      timeMs,
      dateLabel: formatUtc(timeMs),
      imageUrl: url,
      cloudCoverPct: null,
      cloudApplies: false,
      credit: eumetsat ? IMAGE_CREDIT.eumetsat : IMAGE_CREDIT.gibs,
      conditionText: null,
      grid: url ? imageGrid(url) : 'unreferenced',
      resolutionM: null,
      sunElevationDeg: null,
    };
  });
}

type HistoryState =
  | { kind: 'none' }
  /** The mission's earlier scenes are searched only once Compare is chosen. */
  | { kind: 'idle' }
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

/** Paints from the loaded copy: an archive image URL carries the point, and DebugBear reports the largest painted image's URL. */
function sceneImage(scene: ViewerScene, className: string, paint: LoadedArchiveImage): DomChild {
  return h('img', { className, src: paint.objectUrl, alt: t('orbitalWatch.viewer.imageAlt', { name: scene.name, time: scene.dateLabel }), decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
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
  /** Set by the last render when the compare stage itself states the history outcome. */
  private stageStatesHistory = false;
  /** Images loaded for painting, by archive URL, and those that failed, in this viewer. */
  private readonly painted = new Map<string, LoadedArchiveImage>();
  /** The archive URLs the last render shows; every other loaded image is released. */
  private readonly shownUrls = new Set<string>();
  private readonly failedUrls = new Set<string>();
  private readonly pendingUrls = new Set<string>();
  private readonly deps: Required<ViewerDependencies>;

  constructor(private readonly subject: ImageViewerSubject, private readonly returnFocusTo: HTMLElement | null, deps: ViewerDependencies = {}) {
    this.deps = {
      searchHistory: deps.searchHistory ?? searchSceneHistory,
      loadImage: deps.loadImage ?? loadLookupImage,
      prefersReducedMotion: deps.prefersReducedMotion ?? (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    };
    this.scenes = mergeScenes(subject.selected.collection, [subject.selected], subject.scenes);
    this.historyProfile = subject.selected.grid === 'north-up' ? subject.historyProfile : null;
    this.history = this.historyProfile ? { kind: 'idle' } : { kind: 'none' };
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
    if (this.mode === 'change') this.ensureHistory();
  }

  get isOpen(): boolean {
    return this.root.isConnected;
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.controller.abort();
    this.root.remove();
    for (const paint of this.painted.values()) paint.release();
    this.painted.clear();
    if (!restoreFocus) return;
    const target = this.returnFocusTo?.isConnected ? this.returnFocusTo : document.querySelector<HTMLElement>('.imagery-evidence-sheet');
    target?.focus({ preventScroll: true });
  }

  private ensureHistory(): void {
    if (this.historyProfile && this.history.kind === 'idle') void this.loadHistory(this.historyProfile);
  }

  private async loadHistory(profileId: ImagingProfileId): Promise<void> {
    const { signal } = this.controller;
    this.history = { kind: 'searching' };
    this.render();
    let result: SceneHistory;
    try {
      await afterDebugBearRequestWindow(signal);
      result = await this.deps.searchHistory(this.subject.point, profileId, this.subject.historyEndMs ?? this.subject.nowMs, { signal });
    } catch {
      if (signal.aborted) return;
      // An unexpected throw would otherwise leave Compare searching forever with no retry.
      result = { status: 'failed', failure: { archive: HISTORY_ARCHIVE[profileId], reason: 'invalid-response' } };
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

  /** Counts how many of the images have loaded, starting a load for each one not yet requested. The render shows them, so they are kept. */
  private ensureLoaded(urls: string[]): number {
    const { signal } = this.controller;
    for (const url of urls) {
      this.shownUrls.add(url);
      if (this.painted.has(url) || this.failedUrls.has(url) || this.pendingUrls.has(url)) continue;
      this.pendingUrls.add(url);
      this.deps.loadImage(archiveHost(url).id, url, signal).then(
        (paint) => {
          if (signal.aborted) paint.release();
          else this.painted.set(url, paint);
        },
        () => {
          if (!signal.aborted) this.failedUrls.add(url);
        },
      ).finally(() => {
        this.pendingUrls.delete(url);
        if (!signal.aborted) this.render();
      });
    }
    return urls.filter((url) => this.painted.has(url)).length;
  }

  /** Releases every loaded image the current render does not show: a compare date left, or cloudy dates hidden again. */
  private releaseUnshown(): void {
    for (const [url, paint] of this.painted) {
      if (this.shownUrls.has(url)) continue;
      paint.release();
      this.painted.delete(url);
    }
  }

  /**
   * Compare is offered once a second scene of the collection exists, clear or hidden as cloudy, or while the
   * mission's history has not answered yet. Once chosen it stays, so an empty or failed history says so in place.
   */
  private get canCompare(): boolean {
    const { selected } = this.subject;
    return selected.grid === 'north-up' && !this.failedUrls.has(selected.imageUrl!)
      && (this.compareCandidates.length > 0 || this.hiddenCloudyCount > 0
        || this.history.kind === 'idle' || this.history.kind === 'searching'
        || (this.mode === 'change' && this.history.kind !== 'none'));
  }

  startCompare(key: string): void {
    this.pickedCompareKey = key;
    this.mode = 'change';
    if (this.isOpen) this.ensureHistory();
  }

  private render(): void {
    const active = document.activeElement as HTMLElement | null;
    const focusedAction = this.dialog.contains(active) ? active?.dataset?.action : undefined;
    const focusedKey = active?.dataset?.key;
    if (this.mode === 'change' && !this.canCompare) this.mode = 'image';
    this.shownUrls.clear();
    this.stageStatesHistory = false;
    replaceChildren(this.body,
      this.mode === 'change' ? this.renderCompareStage() : this.renderImageStage(),
      this.renderSide());
    this.releaseUnshown();
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
      this.imageStage(scene),
      h('figcaption', { className: 'oiv-caption' },
        h('span', null, `${scene.name} · ${shortDate(scene.timeMs)} · ${clock(scene.timeMs)}`),
        h('span', null, second)),
      scene.grid === 'north-up' ? null : h('p', { className: 'oiv-note' }, t('orbitalWatch.viewer.unreferenced')),
      h('p', { className: 'oiv-credit' }, scene.credit));
  }

  private imageStage(scene: ViewerScene): HTMLElement {
    const url = viewable(scene.imageUrl);
    if (!url) return h('div', { className: 'oiv-stage oiv-stage-empty' }, h('span', { className: 'oiv-label' }, t('orbitalWatch.tile.noPreview')));
    this.ensureLoaded([url]);
    const paint = this.painted.get(url);
    if (paint) return h('div', { className: 'oiv-stage' }, sceneImage(scene, 'oiv-image', paint), ...this.overlays(scene));
    if (this.failedUrls.has(url)) {
      return h('div', { className: 'oiv-stage oiv-stage-empty', role: 'alert' },
        h('span', { className: 'oiv-label' }, t('orbitalWatch.tile.failed', { archive: archiveHost(url).name.toUpperCase() })),
        h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'retry-image', url } }, t('countryBrief.retryBtn')));
    }
    return h('div', { className: 'oiv-stage oiv-skeleton', role: 'status' }, h('span', { className: 'oiv-label' }, t('orbitalWatch.row.imageLoading')));
  }

  private renderCompareStage(): HTMLElement {
    const { selected } = this.subject;
    const others = this.compareCandidates;
    const searching = this.history.kind === 'searching' || this.history.kind === 'idle';
    const other = searching && !this.pickedCompareKey ? undefined : others.find((scene) => scene.key === this.compareKey);
    if (!other) {
      const failure = this.history.kind === 'failed' ? this.history.failure : null;
      this.stageStatesHistory = true;
      // The selected scene is one side of whichever pair the history yields, so it stays loaded meanwhile.
      if (searching) this.ensureLoaded([selected.imageUrl!]);
      const message = searching
        ? t('orbitalWatch.viewer.searching', { days: HISTORY_DAYS })
        : failure ? this.historyFailureText(failure) : t('orbitalWatch.viewer.compareNone');
      return h('div', { className: 'oiv-column oiv-compare' },
        h('div', { className: `oiv-stage ${searching ? 'oiv-skeleton' : 'oiv-stage-empty'}`, role: 'status' },
          h('span', { className: 'oiv-label' }, message),
          failure ? this.retryHistoryButton() : null));
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
        sceneImage(before, 'oiv-image oiv-before', this.painted.get(pair[0]!)!),
        sceneImage(after, 'oiv-image oiv-after', this.painted.get(pair[1]!)!),
        reticle(),
        h('span', { className: 'oiv-chip oiv-chip-before' }, chipDate(before.timeMs)),
        h('span', { className: 'oiv-chip oiv-chip-after' }, chipDate(after.timeMs))),
      this.subject.eventMs === undefined ? null : h('p', { className: 'oiv-label oiv-event' }, this.eventMark),
      h('input', { type: 'range', min: '0', max: '100', value: String(this.dividerPct), className: 'oiv-divider', 'aria-label': t('orbitalWatch.viewer.divider'), dataset: { action: 'divider' } }),
      h('p', { className: 'oiv-credit' }, before.credit === after.credit ? after.credit : `${before.credit} · ${after.credit}`));
  }

  private historyFailureText(failure: ArchiveFailure): string {
    const key = failure.reason === 'timeout' ? 'orbitalWatch.viewer.historyTimeout' : 'orbitalWatch.viewer.historyFailed';
    return t(key, { archive: ARCHIVE_NAME[failure.archive] });
  }

  private retryHistoryButton(): HTMLElement {
    return h('button', { type: 'button', className: 'oiv-button', dataset: { action: 'retry-history' } }, t('countryBrief.retryBtn'));
  }

  /** Beside the compare stage when it still shows a pair; an empty stage states the failure itself. */
  private renderHistoryNote(): DomChild {
    if (this.history.kind !== 'failed' || this.stageStatesHistory) return null;
    return h('div', { className: 'oiv-note', role: 'note' },
      h('p', null, this.historyFailureText(this.history.failure)),
      this.retryHistoryButton());
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
    return h('aside', { className: 'oiv-side' },
      tabs,
      ...(this.mode === 'change' ? this.renderDates() : [this.renderMeta(scene)]),
      this.renderHistoryNote());
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

  private get eventMark(): string {
    return t('orbitalWatch.viewer.eventMark', { date: chipDate(this.subject.eventMs!) });
  }

  private renderDates(): DomChild[] {
    const others = this.compareCandidates;
    const pickedKey = this.compareKey;
    const hidden = this.hiddenCloudyCount;
    const { eventMs } = this.subject;
    const items: DomChild[] = others.map((scene) => h('li', null, h('button', {
      type: 'button',
      className: 'oiv-date',
      'aria-pressed': String(scene.key === pickedKey),
      dataset: { action: 'compare-date', key: scene.key },
    }, h('span', null, chipDate(scene.timeMs)), cloudWord(scene) ? h('span', { className: 'oiv-date-cloud' }, cloudWord(scene)!) : null)));
    if (eventMs !== undefined && others.length > 0) {
      // Dates run newest first; the event mark sits where the list crosses the event time.
      const at = others.findIndex((scene) => scene.timeMs < eventMs);
      items.splice(at === -1 ? items.length : at, 0, h('li', { className: 'oiv-date-event', role: 'separator' }, this.eventMark));
    }
    return [
      h('p', { className: 'oiv-label oiv-side-label' }, t('orbitalWatch.viewer.compareDates')),
      others.length > 0
        ? h('ul', { className: 'oiv-dates', role: 'group', 'aria-label': t('orbitalWatch.viewer.compareDates') }, ...items)
        : null,
      hidden > 0 || this.showCloudy
        ? h('button', { type: 'button', className: 'oiv-toggle', 'aria-pressed': String(this.showCloudy), dataset: { action: 'show-cloudy' } }, t('orbitalWatch.viewer.showCloudy', { count: hidden }))
        : null,
    ];
  }

  private readonly onClick = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    switch (action?.dataset.action) {
      case 'close':
        this.close();
        return;
      case 'retry-image':
        this.failedUrls.delete(action.dataset.url ?? '');
        this.render();
        return;
      case 'retry-history':
        if (this.historyProfile) void this.loadHistory(this.historyProfile);
        return;
      case 'mode':
        this.mode = action.dataset.mode === 'change' ? 'change' : 'image';
        this.render();
        if (this.mode === 'change') this.ensureHistory();
        return;
      case 'show-cloudy':
        this.showCloudy = !this.showCloudy;
        this.render();
        return;
      case 'compare-date':
        this.pickedCompareKey = action.dataset.key ?? null;
        this.render();
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
export interface ViewerOpenOptions {
  /** Opens on the before/after compare against this scene of the same collection. */
  compareKey?: string | null;
}

export function openOrbitalImageViewer(subject: ImageViewerSubject, returnFocusTo: HTMLElement | null, deps?: ViewerDependencies, options: ViewerOpenOptions = {}): OrbitalImageViewer {
  current?.close();
  current = new OrbitalImageViewer(subject, returnFocusTo, deps);
  if (options.compareKey) current.startCompare(options.compareKey);
  current.open();
  return current;
}

export type ViewableImage = { kind: 'acquisition' | 'mosaic' | 'frame'; key: string };

/** The viewer subject for a before/after anchored on a map event: it opens on the scene after the event, beside the one before. */
export function subjectForEvent(point: GeoPoint, eventMs: number, pair: Extract<EventPair, { status: 'ok' }>, nowMs: number): ImageViewerSubject {
  return {
    point,
    nowMs,
    selected: sceneFromAcquisition(pair.after),
    scenes: pair.scenes.map(sceneFromAcquisition),
    historyProfile: pair.profileId,
    historyEndMs: pair.windowEndMs,
    eventMs,
  };
}

/**
 * Builds the viewer subject for an image the lookup sheet shows, or null when that image is gone.
 * `shownUrl` is the frame a thumbnail fell back to; `isEmpty` names the days the sheet found blank at the point, which compare skips.
 */
export function subjectForImage(
  evidence: OrbitalEvidence,
  image: ViewableImage,
  lookup: { point: GeoPoint; nowMs: number },
  shownUrl: string | null = null,
  isEmpty: (url: string) => boolean = () => false,
): ImageViewerSubject | null {
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
      const scenes = (mosaic ? scenesFromMosaic(mosaic) : []).filter((scene) => scene.imageUrl === shownUrl || !scene.imageUrl || !isEmpty(scene.imageUrl));
      const selected = scenes.find((scene) => scene.imageUrl === shownUrl) ?? scenes[0];
      return selected ? { ...base, selected, scenes, historyProfile: null } : null;
    }
    case 'frame': {
      const frame = evidence.frames.find((candidate) => candidate.layer === image.key);
      const scenes = frame ? scenesFromFrame(frame) : [];
      const selected = scenes.find((scene) => scene.imageUrl === shownUrl) ?? scenes[0];
      return selected ? { ...base, selected, scenes: scenes.length > 1 ? scenes : [], historyProfile: null } : null;
    }
  }
}
