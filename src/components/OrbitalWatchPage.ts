import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import { describePointCondition, type EvidenceProgress, type MatchedAcquisition, type OrbitalEvidence } from '@/services/orbital/match';
import type { ArchiveId } from '@/services/orbital/archive-result';
import type { DailyMosaicRow, GeostationaryRow } from '@/services/orbital/archive-gibs';
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';
import type { ViewableImage } from './OrbitalImageViewer';
import '../styles/orbital-watch.css';

export type ArchiveState =
  | { kind: 'checking'; total: number; progress: EvidenceProgress | null }
  | { kind: 'answered'; evidence: OrbitalEvidence };

export type OrbitalWatchState =
  | { kind: 'computing'; done: number; total: number }
  | { kind: 'unavailable' }
  | { kind: 'passes'; lookup: PointPassLookup; archives: ArchiveState };

export interface OrbitalWatchPageCallbacks {
  onClose: () => void;
  onRetry: () => void;
}

type GroupId = 'confirmed' | 'likely' | 'checking' | 'upcoming' | 'mosaic' | 'frames' | 'inRange' | 'passed';

interface GroupSpec {
  id: GroupId;
  expanded: boolean;
  order: 'newest' | 'soonest';
}

const GROUPS: readonly GroupSpec[] = [
  { id: 'checking', expanded: true, order: 'newest' },
  { id: 'confirmed', expanded: true, order: 'newest' },
  { id: 'likely', expanded: true, order: 'newest' },
  { id: 'upcoming', expanded: true, order: 'soonest' },
  { id: 'mosaic', expanded: false, order: 'newest' },
  { id: 'frames', expanded: false, order: 'newest' },
  { id: 'inRange', expanded: false, order: 'newest' },
  { id: 'passed', expanded: false, order: 'newest' },
];

const GROUP_OF_TIER: Record<PassTier['kind'], GroupId> = {
  'confirmed-image': 'confirmed',
  'likely-imaged': 'likely',
  opportunity: 'upcoming',
  'daily-mosaic': 'mosaic',
  'within-reach': 'inRange',
  'capability-overhead': 'inRange',
  'passed-overhead': 'passed',
};

const GROUP_LABEL_KEY: Record<GroupId, string> = {
  checking: 'orbitalWatch.tier.checking',
  confirmed: 'orbitalWatch.tier.confirmed',
  likely: 'orbitalWatch.tier.likely',
  upcoming: 'orbitalWatch.tier.opportunity',
  mosaic: 'orbitalWatch.dailyMosaics',
  frames: 'orbitalWatch.weatherFrames',
  inRange: 'orbitalWatch.inRange',
  passed: 'orbitalWatch.tier.passedOverhead',
};

const TIER_LABEL_KEY: Record<PassTier['kind'], string> = {
  'confirmed-image': 'orbitalWatch.tier.confirmed',
  'likely-imaged': 'orbitalWatch.tier.likely',
  opportunity: 'orbitalWatch.tier.opportunity',
  'daily-mosaic': 'orbitalWatch.tier.dailyMosaic',
  'within-reach': 'orbitalWatch.tier.withinReach',
  'capability-overhead': 'orbitalWatch.tier.capabilityOverhead',
  'passed-overhead': 'orbitalWatch.tier.passedOverhead',
};

export const ARCHIVE_NAME: Record<ArchiveId, string> = {
  'earth-search': 'Earth Search',
  'planetary-computer': 'Microsoft Planetary Computer',
  'nasa-gibs': 'NASA GIBS',
  eumetsat: 'EUMETSAT',
};

/** Credit lines the archives ask for, worded as in the source attribution manifest. */
export const IMAGE_CREDIT = {
  copernicus: (year: number | string) => `Contains modified Copernicus Sentinel data ${year}`,
  usgs: 'Landsat imagery courtesy of the U.S. Geological Survey',
  eumetsat: 'Contains EUMETSAT Meteosat imagery',
  gibsAcknowledgement: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
} as const;

function acquisitionCredit(acquisition: MatchedAcquisition): string {
  return acquisition.profileId === 'landsat' ? IMAGE_CREDIT.usgs : IMAGE_CREDIT.copernicus(new Date(acquisition.startMs).getUTCFullYear());
}

const frameCredit = (archive: ArchiveId) => (archive === 'eumetsat' ? IMAGE_CREDIT.eumetsat : IMAGE_CREDIT.gibsAcknowledgement);

const EARTH_RADIUS_KM = 6371;
const DAY_MS = 86_400_000;

const passKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

/** Angle off straight down at which the satellite sees the point. */
function offNadirDeg(pass: PointPass): number {
  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + pass.altitudeKm)) * Math.cos((pass.elevationDeg * Math.PI) / 180);
  return (Math.asin(Math.min(1, ratio)) * 180) / Math.PI;
}

function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function formatPoint({ lat, lon }: GeoPoint): string {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
}

function formatAgeDays(days: number): string {
  const [value, unit] = days < 1 ? [Math.max(1, Math.round(days * 24)), 'hour'] : [Math.round(days), 'day'];
  return new Intl.NumberFormat(getCurrentLanguageTag(), { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

interface Row {
  sortMs: number;
  render: () => HTMLElement;
}

interface Group {
  spec: GroupSpec;
  rows: Row[];
}

/**
 * A pass is still checking while an archive its mission uses has not answered and the pass
 * could have been imaged, so it never reads "no image" before the archives have spoken.
 */
function groupPasses(lookup: PointPassLookup, archives: ArchiveState): Map<GroupId, Group> {
  const evidence = archives.kind === 'answered' ? archives.evidence : archives.progress?.evidence ?? null;
  const pendingProfiles = new Set(archives.kind === 'answered' ? [] : archives.progress?.pendingProfiles ?? lookup.passes.map((p) => p.profileId));
  const candidates = new Set(lookup.passes.filter((p) => p.tier.kind === 'likely-imaged').map(passKey));
  const acquisitionByPass = new Map<string, MatchedAcquisition>();
  for (const acquisition of evidence?.acquisitions ?? []) if (acquisition.pass) acquisitionByPass.set(passKey(acquisition.pass), acquisition);

  const groups = new Map<GroupId, Group>(GROUPS.map((spec) => [spec.id, { spec, rows: [] }]));
  for (const pass of evidence?.passes ?? lookup.passes) {
    const checking = pendingProfiles.has(pass.profileId) && candidates.has(passKey(pass)) && pass.tier.kind !== 'confirmed-image';
    const group = checking ? 'checking' : GROUP_OF_TIER[pass.tier.kind];
    groups.get(group)!.rows.push({ sortMs: pass.timeMs, render: () => passRow(pass, checking, acquisitionByPass.get(passKey(pass)) ?? null) });
  }
  for (const acquisition of evidence?.acquisitions ?? []) {
    if (!acquisition.pass) groups.get('confirmed')!.rows.push({ sortMs: acquisition.startMs, render: () => unmatchedImageRow(acquisition) });
  }
  for (const mosaic of evidence?.mosaics ?? []) {
    groups.get('mosaic')!.rows.push({ sortMs: mosaic.days[0] ? Date.parse(mosaic.days[0].date) : 0, render: () => mosaicRow(mosaic) });
  }
  for (const frame of evidence?.frames ?? []) {
    groups.get('frames')!.rows.push({ sortMs: frame.latest ? Date.parse(frame.latest.time) : 0, render: () => frameRow(frame) });
  }
  for (const group of groups.values()) group.rows.sort((a, b) => (group.spec.order === 'newest' ? b.sortMs - a.sortMs : a.sortMs - b.sortMs));
  return groups;
}

function imageFigure(url: string | null, alt: string, condition: string | null, credit: string, view: ViewableImage): DomChild {
  if (!url || !isAllowedPreviewUrl(url)) return null;
  const status = h('span', { className: 'ow-image-status' }, t('orbitalWatch.row.imageLoading'));
  const frame = h('div', { className: 'ow-image-frame', dataset: { state: 'loading' } },
    h('img', {
      src: url,
      alt,
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
      onLoad: () => { frame.dataset.state = 'loaded'; },
      onError: () => {
        frame.dataset.state = 'failed';
        status.textContent = t('orbitalWatch.row.imageFailed');
      },
    }),
    status);
  return h('figure', { className: 'ow-row-image' },
    h('button', { type: 'button', className: 'ow-view-image', 'aria-label': t('orbitalWatch.viewer.open', { image: alt }), dataset: { action: 'view-image', imageKind: view.kind, imageKey: view.key } },
      frame),
    h('figcaption', null, condition ? h('span', { className: 'ow-image-condition' }, condition) : null, h('span', { className: 'ow-image-credit' }, credit)));
}

function imageSlot(acquisition: MatchedAcquisition | null, alt: string): DomChild {
  if (!acquisition) return null;
  return imageFigure(acquisition.imageUrl, alt, describePointCondition(acquisition), acquisitionCredit(acquisition), { kind: 'acquisition', key: acquisition.key })
    ?? h('p', { className: 'ow-row-note' }, t('orbitalWatch.row.noPreview'));
}

function bestViewButton(acquisition: MatchedAcquisition): HTMLElement {
  return h('button', { type: 'button', className: 'ow-retry ow-best-view', dataset: { action: 'view-image', imageKind: 'acquisition', imageKey: acquisition.key } },
    t('orbitalWatch.viewer.bestView', { name: acquisition.platform.toUpperCase(), time: formatUtc(acquisition.startMs) }));
}

function sourceRow(tier: string, name: string, tierLabel: string, time: string | null, detail: string | null, image: DomChild): HTMLElement {
  return h('li', { className: 'ow-row', tabindex: '0', dataset: { tier, key: `source:${name}` } },
    h('div', { className: 'ow-row-head' },
      h('span', { className: 'ow-row-name' }, name),
      h('span', { className: 'ow-tier-label' }, tierLabel)),
    time ? h('div', { className: 'ow-row-time' }, time) : null,
    detail ? h('div', { className: 'ow-row-detail' }, detail) : null,
    image);
}

function mosaicRow(mosaic: DailyMosaicRow): HTMLElement {
  const latest = mosaic.days[0];
  if (!latest) return sourceRow('unavailable', mosaic.source, t('orbitalWatch.tier.unavailable'), null, t('orbitalWatch.row.sourceUnavailable'), null);
  return sourceRow('daily-mosaic', mosaic.source, t('orbitalWatch.tier.dailyMosaic'), latest.date, t('orbitalWatch.row.mosaicDays', { count: mosaic.days.length }),
    imageFigure(latest.imageUrl, t('orbitalWatch.row.imageAlt', { name: mosaic.source, time: latest.date }), null, IMAGE_CREDIT.gibsAcknowledgement, { kind: 'mosaic', key: mosaic.layer }));
}

function frameRow(frame: GeostationaryRow): HTMLElement {
  if (!frame.latest) return sourceRow('unavailable', frame.source, t('orbitalWatch.tier.unavailable'), null, t('orbitalWatch.row.sourceUnavailable'), null);
  const time = formatUtc(Date.parse(frame.latest.time));
  return sourceRow('weather-frame', frame.source, t('orbitalWatch.tier.weatherFrame'), time,
    frame.cadenceMinutes === null ? null : t('orbitalWatch.row.cadence', { minutes: frame.cadenceMinutes }),
    imageFigure(frame.latest.imageUrl, t('orbitalWatch.row.imageAlt', { name: frame.source, time }), null, frameCredit(frame.archive), { kind: 'frame', key: frame.layer }));
}

function passRow(pass: PointPass, checking: boolean, acquisition: MatchedAcquisition | null): HTMLElement {
  const tierLabel = checking ? t('orbitalWatch.tier.checking') : t(TIER_LABEL_KEY[pass.tier.kind]);
  const military = pass.tier.kind === 'capability-overhead';
  const details = [
    t('orbitalWatch.row.offNadir', { deg: Math.round(offNadirDeg(pass)) }),
    t('orbitalWatch.row.distance', { km: Math.round(pass.groundDistanceKm) }),
    t('orbitalWatch.row.orbitAge', { age: formatAgeDays(pass.orbitAgeDays) }),
  ];
  const notes = [
    pass.edgeOfSwath ? t('orbitalWatch.row.edgeOfSwath') : null,
    !checking && pass.tier.kind === 'passed-overhead' && pass.tier.note === 'not-in-archive' ? t('orbitalWatch.row.notInArchive') : null,
  ].filter((note): note is string => note !== null);
  return h('li', { className: 'ow-row', tabindex: '0', dataset: { tier: checking ? 'checking' : pass.tier.kind, key: `pass:${passKey(pass)}` } },
    h('div', { className: 'ow-row-head' },
      h('span', { className: 'ow-row-name' }, pass.name),
      h('span', { className: 'ow-tier-label' }, tierLabel)),
    h('div', { className: 'ow-row-time' }, formatUtc(pass.timeMs)),
    h('div', { className: 'ow-row-detail' }, details.join(' · ')),
    ...notes.map((note) => h('div', { className: 'ow-row-note' }, note)),
    military ? null : imageSlot(acquisition, t('orbitalWatch.row.imageAlt', { name: pass.name, time: formatUtc(pass.timeMs) })));
}

function unmatchedImageRow(acquisition: MatchedAcquisition): HTMLElement {
  const name = acquisition.platform.toUpperCase();
  return h('li', { className: 'ow-row', tabindex: '0', dataset: { tier: 'confirmed-image', key: `image:${acquisition.platform}:${acquisition.startMs}` } },
    h('div', { className: 'ow-row-head' },
      h('span', { className: 'ow-row-name' }, name),
      h('span', { className: 'ow-tier-label' }, t('orbitalWatch.tier.unmatchedImage'))),
    h('div', { className: 'ow-row-time' }, formatUtc(acquisition.startMs)),
    imageSlot(acquisition, t('orbitalWatch.row.imageAlt', { name, time: formatUtc(acquisition.startMs) })));
}

/** The lookup sheet: docked beside the map on desktop, rising from the bottom on narrow screens. */
export class OrbitalWatchPage {
  private readonly sheet: HTMLElement;
  private readonly body: HTMLElement;
  private readonly pointLabel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly closeButton: HTMLElement;
  private readonly privacy: HTMLElement;
  private returnFocusTo: HTMLElement | null = null;
  /** Groups the user opened or closed, against their default. */
  private readonly toggled = new Set<GroupId>();
  private state: OrbitalWatchState | null = null;

  constructor(private readonly callbacks: OrbitalWatchPageCallbacks) {
    const titleId = 'orbital-watch-title';
    this.pointLabel = h('p', { className: 'ow-point' });
    this.body = h('div', { className: 'ow-body' });
    this.title = h('h2', { id: titleId });
    this.closeButton = h('button', { type: 'button', className: 'ow-close', onClick: () => this.close() }, '×');
    this.privacy = h('p', { className: 'ow-privacy' });
    this.sheet = h('section', { className: 'orbital-watch-sheet', role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1' },
      h('header', { className: 'ow-header' }, h('div', null, this.title, this.pointLabel), this.closeButton),
      this.body,
      this.privacy);
    declareOverlay(this.sheet, { reload: 'safe' });
    this.sheet.addEventListener('keydown', this.onSheetKeydown);
    this.sheet.addEventListener('click', this.onSheetClick);
  }

  get isOpen(): boolean {
    return this.sheet.isConnected;
  }

  open(point: GeoPoint, returnFocusTo: HTMLElement | null): void {
    this.returnFocusTo = returnFocusTo;
    this.toggled.clear();
    this.title.textContent = t('contextMenu.satellitePasses');
    this.closeButton.setAttribute('aria-label', t('countryBrief.closeBtn'));
    this.privacy.textContent = t('orbitalWatch.privacy');
    this.pointLabel.textContent = formatPoint(point);
    this.render({ kind: 'computing', done: 0, total: 0 });
    if (!this.isOpen) {
      document.body.appendChild(this.sheet);
      document.addEventListener('keydown', this.onDocumentKeydown);
    }
    this.sheet.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    document.removeEventListener('keydown', this.onDocumentKeydown);
    this.sheet.remove();
    this.state = null;
    this.callbacks.onClose();
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target?.isConnected) {
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  render(state: OrbitalWatchState): void {
    this.state = state;
    const focused = document.activeElement instanceof HTMLElement && this.body.contains(document.activeElement) ? document.activeElement : null;
    const selector = focused?.dataset.key ? `.ow-row[data-key="${CSS.escape(focused.dataset.key)}"]`
      : focused?.dataset.group ? `.ow-group-toggle[data-group="${focused.dataset.group}"]`
      : null;
    replaceChildren(this.body, ...this.renderState(state));
    if (focused) ((selector ? this.body.querySelector<HTMLElement>(selector) : null) ?? this.sheet).focus();
  }

  private renderState(state: OrbitalWatchState): DomChild[] {
    switch (state.kind) {
      case 'computing':
        return [h('p', { className: 'ow-status', role: 'status' }, state.total > 0
          ? t('orbitalWatch.computingProgress', { done: state.done, total: state.total })
          : t('orbitalWatch.computing'))];
      case 'unavailable':
        return [h('div', { className: 'ow-empty' }, h('p', null, t('orbitalWatch.unavailable')), this.retryButton())];
      case 'passes':
        return this.renderPasses(state.lookup, state.archives);
    }
  }

  private renderPasses(lookup: PointPassLookup, archives: ArchiveState): DomChild[] {
    const evidence = archives.kind === 'answered' ? archives.evidence : null;
    const groups = groupPasses(lookup, archives);
    const stale = lookup.catalog.status === 'stale'
      ? h('p', { className: 'ow-banner ow-banner-stale', role: 'note' }, t('orbitalWatch.stale', { age: formatAgeDays((lookup.nowMs - lookup.catalog.fetchedAt) / DAY_MS) }))
      : null;
    const empty = lookup.passes.length === 0
      ? h('p', { className: 'ow-empty' }, t('orbitalWatch.empty', { pastDays: Math.round((lookup.nowMs - lookup.window.startMs) / DAY_MS), futureHours: Math.round((lookup.window.endMs - lookup.nowMs) / 3_600_000) }))
      : null;
    const list = GROUPS.map(({ id }) => groups.get(id)!).filter((group) => group.rows.length > 0).map((group) => this.renderGroup(group));
    return [stale, this.renderSummary(archives, groups, evidence), empty, ...list];
  }

  private renderSummary(archives: ArchiveState, groups: Map<GroupId, Group>, evidence: OrbitalEvidence | null): HTMLElement {
    const inRange = groups.get('inRange')!.rows.length;
    if (!evidence) {
      const settled = archives.kind === 'checking' ? archives.progress?.settled.length ?? 0 : 0;
      const total = archives.kind === 'checking' ? archives.total : 0;
      return h('div', { className: 'ow-summary' },
        h('p', { className: 'ow-headline', role: 'status' }, t('orbitalWatch.checkingArchives', { done: settled, total })),
        h('p', { className: 'ow-counts' }, t('orbitalWatch.counts.inRange', { count: inRange })));
    }
    const failedNames = [...new Set(evidence.failures.map((failure) => (failure.source ? `${ARCHIVE_NAME[failure.archive]} (${failure.source})` : ARCHIVE_NAME[failure.archive])))];
    return h('div', { className: 'ow-summary' },
      h('p', { className: 'ow-headline', role: 'status' }, t('orbitalWatch.confirmedCount', { count: evidence.acquisitions.length })),
      h('p', { className: 'ow-counts' }, [
        t('orbitalWatch.counts.mosaics', { count: evidence.mosaics.filter((m) => m.days.length > 0).length }),
        t('orbitalWatch.counts.frames', { count: evidence.frames.filter((f) => f.latest).length }),
        t('orbitalWatch.counts.inRange', { count: inRange }),
      ].join(' · ')),
      evidence.bestView ? bestViewButton(evidence.bestView) : null,
      failedNames.length > 0
        ? h('div', { className: 'ow-banner ow-banner-partial', role: 'note' },
          h('p', null, t('orbitalWatch.partial', { sources: failedNames.join(', ') })),
          this.retryButton())
        : null);
  }

  private renderGroup(group: Group): HTMLElement {
    const { id } = group.spec;
    const expanded = group.spec.expanded !== this.toggled.has(id);
    const listId = `orbital-watch-group-${id}`;
    const toggle = h('button', { type: 'button', className: 'ow-group-toggle', 'aria-expanded': String(expanded), 'aria-controls': listId, dataset: { group: id } },
      h('span', null, t(GROUP_LABEL_KEY[id])),
      h('span', { className: 'ow-group-count' }, String(group.rows.length)));
    const list = h('ul', { className: 'ow-rows', id: listId, hidden: !expanded });
    if (expanded) list.append(...group.rows.map((row) => row.render()));
    return h('section', { className: 'ow-group', dataset: { group: id } }, toggle, list);
  }

  private retryButton(): HTMLElement {
    return h('button', { type: 'button', className: 'ow-retry', dataset: { action: 'retry' } }, t('countryBrief.retryBtn'));
  }

  private readonly onSheetClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="retry"]')) {
      this.callbacks.onRetry();
      return;
    }
    const view = target.closest<HTMLElement>('[data-action="view-image"]');
    if (view) {
      this.openImageViewer(view);
      return;
    }
    const toggle = target.closest<HTMLElement>('.ow-group-toggle');
    const id = toggle?.dataset.group as GroupId | undefined;
    if (!id || !this.state) return;
    if (this.toggled.has(id)) this.toggled.delete(id);
    else this.toggled.add(id);
    toggle!.focus();
    this.render(this.state);
  };

  /** The viewer is its own lazy chunk, fetched the first time someone opens an image. */
  private openImageViewer(trigger: HTMLElement): void {
    if (this.state?.kind !== 'passes') return;
    const { lookup, archives } = this.state;
    const evidence = archives.kind === 'answered' ? archives.evidence : archives.progress?.evidence;
    const image = { kind: trigger.dataset.imageKind, key: trigger.dataset.imageKey } as ViewableImage;
    const returnFocusTo = trigger.closest<HTMLElement>('.ow-row') ?? trigger;
    if (!evidence) return;
    void import('./OrbitalImageViewer').then(({ openOrbitalImageViewer, subjectForImage }) => {
      const subject = subjectForImage(evidence, image, lookup);
      if (subject && this.isOpen) openOrbitalImageViewer(subject, returnFocusTo);
    });
  }

  private readonly onSheetKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const row = (event.target as HTMLElement).closest('.ow-row');
    if (!row) return;
    const rows = [...this.sheet.querySelectorAll<HTMLElement>('.ow-row')];
    const next = rows[rows.indexOf(row as HTMLElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };
}
