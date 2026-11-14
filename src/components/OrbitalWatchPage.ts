import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { EvidenceProgress, MatchedAcquisition, OrbitalEvidence } from '@/services/orbital/match';
import { ARCHIVE_REQUEST_TIMEOUT_MS, type ArchiveId } from '@/services/orbital/archive-result';
import { ArchiveImageError, loadArchiveImage, type ArchiveImageResult, type LoadedArchiveImage } from '@/services/orbital/archive-image';
import { hasNoDataAtPoint, MOSAIC_FALLBACK_DAYS, type CropPosition, type DailyMosaicRow } from '@/services/orbital/archive-gibs';
import { DEFAULT_CROP_HALF_SIZE_KM } from '@/services/orbital/crop-url';
import { acquisitionCredit, ORBITAL_WATCH_DOCS_URL, resultCredits, type ResultCredit } from '@/services/orbital/credits';
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';
import { iso2ToCountryName } from '@/utils/country-codes';
import type { SensorCategory } from '../../shared/orbital/sensor-profiles.js';
import { ORBIT_ELEMENTS_MAX_AGE_DAYS } from '../../shared/orbital/pass-geometry.js';
import { EVENT_RADIUS_KM, type EventSourceId, type LiveSourceId } from '@/services/orbital/point-context';
import type { PointContextState } from './OrbitalTimeline';
import '../styles/orbital-watch.css';
import type { ViewableImage } from './OrbitalImageViewer';
import { placeTimeZone, placeTimeZoneLabel, zoneAbbreviation, type PlaceTimeZone } from '@/utils/place-time-zone';

export type ArchiveState =
  | { kind: 'checking'; total: number; progress: EvidenceProgress | null }
  | { kind: 'answered'; evidence: OrbitalEvidence };

export type OrbitalWatchState =
  | { kind: 'idle' }
  | { kind: 'computing'; done: number; total: number }
  | { kind: 'unavailable' }
  | { kind: 'passes'; lookup: PointPassLookup; archives: ArchiveState };

/** Empty mount points other surfaces fill: the place search and the timeline. */
export type OrbitalSlot = 'search' | 'timeline';

/** The mobile bottom sheet's three heights; the docked desktop sheet ignores it. */
export type SheetHeight = 'collapsed' | 'half' | 'full';

export interface OrbitalWatchPageCallbacks {
  onClose: () => void;
  onRetry: () => void;
  onChangePlace?: () => void;
  /** Copies the share link (a 0.01-degree point); without it the sheet shows no share button. */
  onShare?: (button: HTMLElement) => void;
}

export const ARCHIVE_NAME: Record<ArchiveId, string> = {
  'earth-search': 'Earth Search',
  'planetary-computer': 'Microsoft Planetary Computer',
  'nasa-gibs': 'NASA GIBS',
  eumetsat: 'EUMETSAT',
};

const ARCHIVE_HOST: ReadonlyArray<[RegExp, string, ArchiveId]> = [
  [/(^|\.)planetarycomputer\.microsoft\.com$/, 'Planetary Computer', 'planetary-computer'],
  [/(^|\.)element84\.com$|amazonaws\.com$/, 'Earth Search', 'earth-search'],
  [/(^|\.)gibs\.earthdata\.nasa\.gov$/, 'NASA GIBS', 'nasa-gibs'],
  [/(^|\.)eumetsat\.int$/, 'EUMETSAT', 'eumetsat'],
];

interface RowCredit {
  short: string;
  full: string;
}

const acquisitionRowCredit = (acquisition: MatchedAcquisition): RowCredit => ({
  short: acquisition.profileId === 'landsat' ? 'USGS / Landsat' : `© Copernicus Sentinel ${new Date(acquisition.startMs).getUTCFullYear()}`,
  full: acquisitionCredit(acquisition),
});

const EARTH_RADIUS_KM = 6371;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CROP_WIDTH_KM = DEFAULT_CROP_HALF_SIZE_KM * 2;
const SCALE_BAR_KM = 2;

const passKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

/** Angle off straight down at which the satellite sees the point. */
function offNadirDeg(pass: PointPass): number {
  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + pass.altitudeKm)) * Math.cos((pass.elevationDeg * Math.PI) / 180);
  return (Math.asin(Math.min(1, ratio)) * 180) / Math.PI;
}

const lang = () => getCurrentLanguageTag();
// Typed locally: the project's `lib` predates ES2021, where ListFormat was added.
type ListFormatCtor = new (locale: string, options: { type: 'conjunction' }) => { format(items: readonly string[]): string };
function formatList(items: string[]): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  try {
    if (ListFormat) return new ListFormat(lang(), { type: 'conjunction' }).format(items);
  } catch {
    // Unsupported locale: fall through.
  }
  return items.join(', ');
}
const formatInt = (value: number) => new Intl.NumberFormat(lang()).format(value);

function formatPoint({ lat, lon }: GeoPoint, decimals = 3): string {
  return `${Math.abs(lat).toFixed(decimals)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(decimals)}°${lon >= 0 ? 'E' : 'W'}`;
}

/** The first two parts of a searched name ("Palm Jumeirah, Dubai"), which fit the header; the full name is its tooltip. */
function shortPlaceName(name: string): string {
  return name.split(',').slice(0, 2).map((part) => part.trim()).join(', ');
}

/** The zone every displayed time uses, so the whole sheet can switch to the point's local time at once. */
let displayZone = { timeZone: 'UTC', label: 'UTC' };

/** Sets the IANA zone and its short label that every displayed time uses. */
export function setOrbitalDisplayZone(timeZone: string, label: string): void {
  displayZone = { timeZone, label };
}

/** The zone the sheet shows times in, for surfaces that label their own times (the timeline header). */
export function getOrbitalDisplayZone(): { timeZone: string; label: string } {
  return displayZone;
}

/** Formats a time in the display zone: weekday and date, date, clock, both with the zone label, or date and clock. */
export function formatOrbitalTime(ms: number, style: 'day' | 'date' | 'clock' | 'when' | 'stamp'): string {
  const { timeZone, label } = displayZone;
  const day = () => new Intl.DateTimeFormat(lang(), { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(ms);
  const clock = () => new Intl.DateTimeFormat(lang(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(ms);
  switch (style) {
    case 'day': return day();
    case 'date': return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short', timeZone }).format(ms);
    case 'clock': return clock();
    // The abbreviation follows the moment shown, so a pass across a daylight-saving change reads right.
    case 'when': return `${day()} · ${clock()} ${timeZone === 'UTC' ? label : zoneAbbreviation(timeZone, ms)}`;
    case 'stamp': return `${formatOrbitalTime(ms, 'date')} ${clock()}`;
  }
}


function formatRelative(ms: number, nowMs: number, style: Intl.RelativeTimeFormatStyle = 'long'): string {
  const diff = ms - nowMs;
  const abs = Math.abs(diff);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = abs < HOUR_MS ? [Math.round(diff / 60_000), 'minute']
    : abs < DAY_MS ? [Math.round(diff / HOUR_MS), 'hour']
    : [Math.round(diff / DAY_MS), 'day'];
  return new Intl.RelativeTimeFormat(lang(), { numeric: 'always', style }).format(value, unit);
}

function formatAge(days: number): string {
  const [value, unit] = days < 1 ? [Math.max(1, Math.round(days * 24)), 'hour'] : [Math.round(days), 'day'];
  return new Intl.NumberFormat(lang(), { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

export function archiveHost(url: string | null): { name: string; id: ArchiveId } {
  if (!url) return { name: '', id: 'earth-search' };
  try {
    const host = new URL(url).hostname;
    const match = ARCHIVE_HOST.find(([pattern]) => pattern.test(host));
    return match ? { name: match[1], id: match[2] } : { name: host, id: 'earth-search' };
  } catch {
    return { name: '', id: 'earth-search' };
  }
}

const sensorName = (platform: string) => platform.toUpperCase();

const isRadar = (acquisition: MatchedAcquisition) => acquisition.profileId === 'sentinel-1';

function conditionLabel(acquisition: MatchedAcquisition): string {
  const pct = acquisition.cloudCoverPct === null ? null : Math.round(acquisition.cloudCoverPct);
  switch (acquisition.condition) {
    // The point's pixel is clear; a cloudy scene says so, as the image can still be mostly cloud.
    case 'clear': return (acquisition.cloudCoverPct ?? 0) >= 10 ? t('orbitalWatch.caption.clearSceneCloud', { pct }) : t('orbitalWatch.caption.clear');
    case 'cloud': return t('orbitalWatch.caption.clouded', { pct: pct ?? 100 });
    case 'cloud-shadow': return t('orbitalWatch.caption.cloudShadow');
    case 'not-applicable': return t('orbitalWatch.caption.radar');
    case 'unknown': return pct === null ? t('orbitalWatch.caption.spotNotChecked') : t('orbitalWatch.caption.sceneCloud', { pct });
  }
}

type TileSize = 'hero' | 'thumb';

/** An image with a visible state at every moment: a labelled skeleton, the image, or a failure tile with retry. */
/** Earlier frames to load, in order, when the image fails; `show` is told which frame is displayed (0 is `url`). */
interface TileFallbacks {
  urls: readonly string[];
  show: (index: number) => void;
  /** Where the point sits in the frame; a frame with no data there counts as missing, for archives that serve empty pixels for days not yet imaged. */
  noDataAt?: CropPosition;
}

const NO_DATA_SAMPLE_PX = 32;
const CROP_CENTRE: CropPosition = { x: 0.5, y: 0.5 };

/** Unreadable pixels count as data, so a failed check never hides a real image. */
function noDataAtPoint(img: HTMLImageElement, at: CropPosition): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = NO_DATA_SAMPLE_PX;
    canvas.height = NO_DATA_SAMPLE_PX;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, NO_DATA_SAMPLE_PX, NO_DATA_SAMPLE_PX);
    return hasNoDataAtPoint(ctx.getImageData(0, 0, NO_DATA_SAMPLE_PX, NO_DATA_SAMPLE_PX).data, NO_DATA_SAMPLE_PX, NO_DATA_SAMPLE_PX, at);
  } catch {
    return false;
  }
}

/**
 * The open lookup's images, painted from `blob:` URLs: archive image URLs carry the point,
 * and DebugBear reports the largest painted image's URL. Each image is fetched once per
 * lookup and every blob is released when the lookup closes or a new one starts.
 */
class LookupImages {
  private controller = new AbortController();
  private readonly loaded = new Map<string, LoadedArchiveImage>();
  private readonly pending = new Map<string, Promise<ArchiveImageResult>>();
  private readonly empty = new Set<string>();

  load(archive: ArchiveId, candidates: readonly string[], timeoutMs: number): Promise<ArchiveImageResult> {
    const hit = this.loaded.get(candidates[0]!);
    if (hit) return Promise.resolve({ status: 'ok', image: { ...hit, index: 0 } });
    const key = candidates.join('\n');
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const { signal } = this.controller;
    const request = loadArchiveImage(archive, candidates, { signal, timeoutMs }).then((result): ArchiveImageResult => {
      if (signal.aborted) {
        if (result.status === 'ok') result.image.release();
        return { status: 'failed', failure: { archive, reason: 'aborted' } };
      }
      this.pending.delete(key);
      if (result.status !== 'ok') return result;
      const url = candidates[result.image.index]!;
      const kept = this.loaded.get(url);
      if (!kept) { this.loaded.set(url, result.image); return result; }
      result.image.release();
      return { status: 'ok', image: { ...kept, index: result.image.index } };
    });
    this.pending.set(key, request);
    return request;
  }

  /** Drops a frame with no data at the point and releases its blob. */
  /** The sheet's copy of an image loaded, or loading, on its own; the sheet releases it when the lookup ends, so the borrower's release does nothing. */
  lend(url: string): Promise<LoadedArchiveImage> | null {
    const hit = this.loaded.get(url);
    const request = hit ? Promise.resolve<ArchiveImageResult>({ status: 'ok', image: hit }) : this.pending.get(url);
    if (!request) return null;
    return request.then((result) => {
      if (result.status !== 'ok') throw new ArchiveImageError(result.failure);
      return { ...result.image, release: () => {} };
    });
  }

  markEmpty(url: string): void {
    this.empty.add(url);
    this.loaded.get(url)?.release();
    this.loaded.delete(url);
  }

  isEmpty(url: string): boolean {
    return this.empty.has(url);
  }

  /** Ends the lookup: stops what is in flight and releases every blob. */
  reset(): void {
    this.controller.abort();
    this.controller = new AbortController();
    for (const image of this.loaded.values()) image.release();
    this.loaded.clear();
    this.pending.clear();
    this.empty.clear();
  }
}

const lookupImages = new LookupImages();

/** Loads an image for the viewer, compare, reusing the sheet's copy so no image is fetched twice. */
export function loadLookupImage(archive: ArchiveId, url: string, signal: AbortSignal): Promise<LoadedArchiveImage> {
  return lookupImages.lend(url) ?? loadArchiveImage(archive, [url], { signal }).then((result) => {
    if (result.status === 'failed') throw new ArchiveImageError(result.failure);
    return result.image;
  });
}

/** How far ahead of the viewport a thumbnail starts loading. */
const NEAR_VIEW_MARGIN = '300px';
const nearViewObservers = new Set<IntersectionObserver>();

/** Starts a row thumbnail's fetch once it nears the viewport, as `loading="lazy"` did for `img.src`. */
function whenNearView(el: HTMLElement, start: () => void): void {
  if (typeof IntersectionObserver !== 'function') { start(); return; }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    nearViewObservers.delete(observer);
    start();
  }, { rootMargin: NEAR_VIEW_MARGIN });
  nearViewObservers.add(observer);
  observer.observe(el);
}

/** Drops the observers of thumbnails that are being removed before they came into view. */
function stopWatchingNearView(): void {
  for (const observer of nearViewObservers) observer.disconnect();
  nearViewObservers.clear();
}

const tileRetries = new WeakMap<HTMLElement, () => void>();
/** The archive URL of the frame a tile shows; its `img` holds only a `blob:` URL. */
const tileShownUrls = new WeakMap<HTMLElement, () => string>();

function imageTile(url: string | null, alt: string, sensor: string, size: TileSize, overlays: DomChild[] = [], fallbacks: TileFallbacks | null = null): HTMLElement {
  const archive = archiveHost(url);
  if (!url || !isAllowedPreviewUrl(url)) {
    return h('div', { className: `ow-tile ow-tile-${size}`, dataset: { state: 'none' } },
      h('span', { className: 'ow-tile-status ow-label' }, t('orbitalWatch.tile.noPreview')));
  }
  const frames = [url, ...(fallbacks?.urls ?? []).filter(isAllowedPreviewUrl)];
  let frame = 0;
  let attempt = 0;
  let deadline = 0;
  let built = false;
  const status = h('span', { className: 'ow-tile-status ow-label' }, size === 'hero' ? sensor : t('orbitalWatch.row.imageLoading'));
  const showFrame = (index: number) => {
    if (index !== frame && built) fallbacks?.show(index);
    frame = index;
  };
  const failed = () => {
    tile.dataset.state = 'failed';
    replaceChildren(status,
      t('orbitalWatch.tile.failed', { archive: archive.name.toUpperCase() }),
      size === 'hero' ? h('button', { type: 'button', className: 'ow-tile-retry', dataset: { action: 'retry-image' } }, t('countryBrief.retryBtn')) : null);
  };
  const noPreview = () => {
    showFrame(0);
    img.remove();
    tile.dataset.state = 'none';
    replaceChildren(status, t('orbitalWatch.tile.noPreview'));
  };
  /** Paints the first frame from `from` on that loads, skipping frames already found empty at the point. */
  const load = (from: number) => {
    const token = ++attempt;
    if (from === 0) deadline = Date.now() + ARCHIVE_REQUEST_TIMEOUT_MS;
    tile.dataset.state = 'loading';
    replaceChildren(status, size === 'hero' ? sensor : t('orbitalWatch.row.imageLoading'));
    img.removeAttribute('src');
    const indices = frames.map((_, i) => i).filter((i) => i >= from && !lookupImages.isEmpty(frames[i]!));
    if (indices.length === 0) { noPreview(); return; }
    showFrame(indices[0]!);
    void lookupImages.load(archive.id, indices.map((i) => frames[i]!), Math.max(1, deadline - Date.now())).then((result) => {
      if (token !== attempt) return;
      if (result.status === 'failed') { if (result.failure.reason !== 'aborted') failed(); return; }
      showFrame(indices[result.image.index]!);
      img.setAttribute('src', result.image.objectUrl);
    });
  };
  const img = h('img', {
    alt,
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    onLoad: () => {
      if (!fallbacks?.noDataAt || !noDataAtPoint(img, fallbacks.noDataAt)) { tile.dataset.state = 'loaded'; return; }
      lookupImages.markEmpty(frames[frame]!);
      if (frame < frames.length - 1) load(frame + 1);
      else noPreview();
    },
    onError: () => {
      if (frame < frames.length - 1) load(frame + 1);
      else failed();
    },
  }) as HTMLImageElement;
  const tile = h('div', { className: `ow-tile ow-tile-${size}`, dataset: { state: 'loading', sensor } }, img, status, ...overlays);
  tileRetries.set(tile, () => load(0));
  tileShownUrls.set(tile, () => frames[frame]!);
  if (size === 'thumb') whenNearView(tile, () => load(0));
  else load(0);
  // A frame known to be empty is skipped before the caller holds the tile, so its caption updates once it does.
  queueMicrotask(() => {
    built = true;
    if (frame !== 0) fallbacks?.show(frame);
  });
  return tile;
}

function shownTileUrl(tile: HTMLElement | null): string | null {
  return (tile && tileShownUrls.get(tile)?.()) ?? null;
}

function imageOverlays(): DomChild[] {
  return [
    h('span', { className: 'ow-reticle', 'aria-hidden': 'true' }),
    h('span', { className: 'ow-scale ow-label', 'aria-hidden': 'true' },
      h('span', { className: 'ow-scale-bar', style: `width: ${((SCALE_BAR_KM / CROP_WIDTH_KM) * 100).toFixed(2)}%` }),
      `${SCALE_BAR_KM} KM`),
    h('span', { className: 'ow-north ow-label', 'aria-hidden': 'true' }, '▲ N'),
  ];
}

/** A transparent button over an image that opens it in the image viewer. */
function viewButton(view: ViewableImage, alt: string): HTMLElement {
  return h('button', { type: 'button', className: 'ow-view-image', 'aria-label': t('orbitalWatch.viewer.open', { image: alt }), dataset: { action: 'view-image', imageKind: view.kind, imageKey: view.key } });
}

/** The four evidence tiers the sheet counts, in the plan's words. */
type CountTier = 'confirmed' | 'likely' | 'inReach' | 'capability';
const COUNT_TIERS: readonly CountTier[] = ['confirmed', 'likely', 'inReach', 'capability'];

const TIER_KEY: Record<PassTier['kind'], string> = {
  'confirmed-image': 'orbitalWatch.tier.confirmed',
  'likely-imaged': 'orbitalWatch.tier.likely',
  'within-reach': 'orbitalWatch.tier.inReach',
  'capability-overhead': 'orbitalWatch.tier.capability',
  'passed-overhead': 'orbitalWatch.tier.inRange',
  opportunity: 'orbitalWatch.tier.upcoming',
  'daily-mosaic': 'orbitalWatch.tier.mosaic',
};

type OperatingGroup = 'open' | 'commercial' | 'government' | 'military' | 'other';
const OPERATING_GROUPS: readonly OperatingGroup[] = ['open', 'commercial', 'government', 'military', 'other'];
const OPERATING_GROUP: Record<SensorCategory, OperatingGroup> = {
  'open-optical': 'open',
  'open-radar': 'open',
  'open-lidar': 'open',
  'weather-polar': 'other',
  'commercial-optical': 'commercial',
  'commercial-radar': 'commercial',
  'government-optical': 'government',
  'government-radar': 'government',
  military: 'military',
  'crewed-station': 'other',
  geostationary: 'other',
};

/** Rows a group shows before "show all". */
const GROUP_PREVIEW_ROWS = 5;
const NEXT_WINDOW_ROWS = 6;
/** Orbit data older than this still computes a pass, but the row flags its age. */
const STALE_ORBIT_DAYS = 3;
const SHEET_PAST_DAYS = 7;
const SHEET_FUTURE_HOURS = 72;
const COORD_DECIMALS = 2;
const SHEET_HEIGHTS: readonly SheetHeight[] = ['collapsed', 'half', 'full'];

interface Tally {
  /** Confirmed acquisitions, newest first. */
  confirmed: MatchedAcquisition[];
  latest: MatchedAcquisition | null;
  counts: Record<CountTier, number>;
  inRange: number;
  mosaics: number;
  frames: number;
}

/** Past passes still waiting on an archive keep their computed tier and read "checking archive". */
function pendingTest(lookup: PointPassLookup, archives: ArchiveState): (pass: PointPass) => boolean {
  if (archives.kind === 'answered') return () => false;
  const pending = archives.progress ? new Set<string>(archives.progress.pendingProfiles) : null;
  return (pass) => pass.timeMs <= lookup.nowMs
    && (pass.tier.kind === 'likely-imaged' || pass.tier.kind === 'confirmed-image')
    && (!pending || pending.has(pass.profileId));
}

function tally(lookup: PointPassLookup, passes: readonly PointPass[], evidence: OrbitalEvidence | null, isPending: (pass: PointPass) => boolean): Tally {
  const confirmed = [...(evidence?.acquisitions ?? [])].sort((a, b) => b.startMs - a.startMs);
  const counts: Record<CountTier, number> = { confirmed: confirmed.length, likely: 0, inReach: 0, capability: 0 };
  let inRange = 0;
  for (const pass of passes) {
    if (pass.timeMs > lookup.nowMs || isPending(pass)) continue;
    if (pass.tier.kind === 'likely-imaged') counts.likely++;
    else if (pass.tier.kind === 'within-reach') counts.inReach++;
    else if (pass.tier.kind === 'capability-overhead') counts.capability++;
    else if (pass.tier.kind === 'passed-overhead') inRange++;
  }
  return {
    confirmed,
    latest: confirmed.find((acquisition) => acquisition.imageUrl) ?? confirmed[0] ?? null,
    counts,
    inRange,
    mosaics: (evidence?.mosaics ?? []).filter((mosaic) => mosaic.days.some((day) => day.imageUrl)).length,
    frames: (evidence?.frames ?? []).filter((frame) => frame.latest?.imageUrl).length,
  };
}

function formatCoords({ lat, lon }: GeoPoint): string {
  return formatPoint({ lat, lon }, COORD_DECIMALS);
}

const formatStamp = (ms: number) => formatOrbitalTime(ms, 'stamp');

/** The newest day first, then the earlier days a tile falls back to when a day has no data at the point. */
function mosaicDays(mosaic: DailyMosaicRow): Array<{ date: string; imageUrl: string }> {
  return mosaic.days.flatMap((day) => (day.imageUrl ? [{ date: day.date, imageUrl: day.imageUrl }] : [])).slice(0, 1 + MOSAIC_FALLBACK_DAYS);
}

function cell(label: string, value: DomChild, className = ''): HTMLElement {
  return h('span', { className: `ies-cell ${className}`.trim(), dataset: { label } }, value);
}

function orbitAgeCell(pass: PointPass): HTMLElement {
  const stale = pass.orbitAgeDays > STALE_ORBIT_DAYS;
  return cell(t('orbitalWatch.row.orbitAge'), t('orbitalWatch.row.orbitAgeValue', { age: formatAge(pass.orbitAgeDays) }), stale ? 'ies-stale' : '');
}

function section(id: string, title: string, ...children: DomChild[]): HTMLElement {
  return h('section', { className: 'ies-section', dataset: { section: id } },
    h('h3', { className: 'ies-section-title' }, title),
    ...children);
}

interface ThumbSpec {
  key: string;
  url: string;
  caption: string;
  sensor: string;
  view: ViewableImage;
  fallbacks?: string[];
  noDataAt?: CropPosition;
  /** Radar backscatter, drawn in greyscale so it never reads as a photo. */
  radar?: boolean;
}

function thumbSpecs(confirmed: MatchedAcquisition[], latest: MatchedAcquisition | null, evidence: OrbitalEvidence | null): ThumbSpec[] {
  const specs: ThumbSpec[] = [];
  for (const acquisition of confirmed) {
    if (acquisition === latest || !acquisition.imageUrl) continue;
    specs.push({
      key: `image:${acquisition.key}`,
      url: acquisition.imageUrl,
      caption: `${sensorName(acquisition.platform)} · ${formatStamp(acquisition.startMs)}${isRadar(acquisition) ? ` · ${t('orbitalWatch.tile.radar')}` : ''}`,
      sensor: sensorName(acquisition.platform),
      view: { kind: 'acquisition', key: acquisition.key },
      radar: isRadar(acquisition),
    });
  }
  for (const mosaic of evidence?.mosaics ?? []) {
    const [newest, ...earlier] = mosaicDays(mosaic);
    if (!newest) continue;
    specs.push({
      key: `mosaic:${mosaic.layer}`,
      url: newest.imageUrl,
      caption: `${mosaic.source.toUpperCase()} · ${formatOrbitalTime(Date.parse(newest.date), 'date')} · ${t('orbitalWatch.sheet.dailyMosaic')}`,
      sensor: mosaic.source.toUpperCase(),
      view: { kind: 'mosaic', key: mosaic.layer },
      fallbacks: earlier.map((day) => day.imageUrl),
      noDataAt: mosaic.pointInCrop ?? CROP_CENTRE,
    });
  }
  for (const frame of evidence?.frames ?? []) {
    if (!frame.latest?.imageUrl) continue;
    specs.push({
      key: `frame:${frame.layer}`,
      url: frame.latest.imageUrl,
      caption: `${frame.source.toUpperCase()} · ${formatStamp(Date.parse(frame.latest.time))} · ${t('orbitalWatch.sheet.weatherFrame')}`,
      sensor: frame.source.toUpperCase(),
      view: { kind: 'frame', key: frame.layer },
      fallbacks: frame.latest.fallbacks.map((earlier) => earlier.imageUrl),
    });
  }
  return specs;
}

const EVENT_SOURCE_LIST: readonly EventSourceId[] = ['conflict', 'fires', 'unrest', 'outages'];
const LIVE_SOURCE_LIST: readonly LiveSourceId[] = ['vessels', 'military-flights', 'gps-jamming'];

export class OrbitalWatchPage {
  private readonly sheet: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly place: HTMLElement;
  private readonly coords: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly shareButton: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly kicker: HTMLElement;
  private readonly changeButton: HTMLElement;
  private readonly closeButton: HTMLElement;
  private readonly sources: HTMLDetailsElement;
  private readonly privacy: HTMLElement;
  private readonly mapMark: HTMLElement;
  private readonly slots: Record<OrbitalSlot, HTMLElement>;
  private returnFocusTo: HTMLElement | null = null;
  private point: GeoPoint | null = null;
  private placeName: string | null = null;
  private placeZone: PlaceTimeZone | null = null;
  /** Times show in the place's zone unless the reader switched to UTC. */
  private localTime = true;
  private height: SheetHeight = 'half';
  private selectedKey: string | null = null;
  private compareKey: string | null = null;
  private readonly expanded = new Set<OperatingGroup>();
  private state: OrbitalWatchState | null = null;
  private context: PointContextState = { kind: 'loading' };
  private openSeq = 0;

  constructor(private readonly callbacks: OrbitalWatchPageCallbacks) {
    const titleId = 'orbital-watch-title';
    this.place = h('h2', { id: titleId, className: 'ies-place cdp-country-name' });
    this.coords = h('span', { className: 'ies-coords' });
    this.zone = h('button', { type: 'button', className: 'ies-chip', dataset: { action: 'zone' } });
    this.shareButton = h('button', { type: 'button', className: 'ies-chip', dataset: { action: 'share' } });
    this.handle = h('button', { type: 'button', className: 'ies-handle', dataset: { action: 'height' } });
    this.kicker = h('span', { className: 'ies-kicker' });
    this.changeButton = h('button', { type: 'button', className: 'ies-chip', dataset: { action: 'change' } });
    this.closeButton = h('button', { type: 'button', className: 'ies-close cdp-close', dataset: { action: 'close' } }, '×');
    this.body = h('div', { className: 'ies-body' });
    this.sources = h('details', { className: 'ies-sources', hidden: true }) as HTMLDetailsElement;
    this.privacy = h('div', { className: 'ies-privacy' });
    this.mapMark = h('div', { className: 'ies-mapmark', 'aria-hidden': 'true', hidden: true },
      h('span', { className: 'ies-mapmark-ring' }),
      h('span', { className: 'ies-mapmark-label' }));
    this.slots = {
      search: h('div', { className: 'ies-slot', dataset: { slot: 'search' }, hidden: true }),
      timeline: h('div', { className: 'ies-slot', dataset: { slot: 'timeline' } }),
    };
    this.panel = h('div', { className: 'ies-panel' },
      this.handle,
      h('header', { className: 'ies-header cdp-header' },
        h('div', { className: 'ies-place-block' },
          this.kicker,
          this.place,
          h('div', { className: 'ies-subline cdp-country-subtitle' }, this.coords)),
        h('div', { className: 'ies-actions' },
          this.zone,
          this.shareButton,
          this.changeButton,
          this.closeButton)),
      this.slots.search,
      this.body,
      h('footer', { className: 'ies-footer' }, this.privacy, this.sources));
    this.sheet = h('section', { className: 'imagery-evidence-sheet', role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1', dataset: { height: this.height } },
      this.mapMark, this.panel);
    declareOverlay(this.sheet, { reload: 'safe' });
    this.sheet.addEventListener('keydown', this.onSheetKeydown);
    this.sheet.addEventListener('click', this.onSheetClick);
    this.sheet.addEventListener('change', this.onSheetChange);
  }

  get isOpen(): boolean {
    return this.sheet.isConnected;
  }

  slot(name: OrbitalSlot): HTMLElement {
    return this.slots[name];
  }

  /** Names the open point after the searched place, or null for its rounded coordinates. */
  setPlaceName(name: string | null): void {
    this.placeName = name && shortPlaceName(name);
    this.place.title = name ?? '';
    this.place.textContent = this.placeLabel();
    this.renderSubline();
  }

  /** Coordinates under a place name (an unnamed point already shows them as its name), then the country. */
  private renderSubline(): void {
    const code = this.context.kind === 'loaded' ? this.context.context.countryCode : null;
    this.coords.textContent = [this.placeName && this.point ? formatCoords(this.point) : null, code ? iso2ToCountryName(code) : null]
      .filter(Boolean).join(' · ');
  }

  /** The conflict, fire, unrest and outage rows near the point, shared with the timeline. */
  setPointContext(context: PointContextState): void {
    this.context = context;
    this.renderSubline();
    if (this.state) this.render(this.state);
  }

  private applyZone(): void {
    const zone = this.placeZone;
    const local = this.localTime && zone !== null;
    if (local) setOrbitalDisplayZone(zone.zone, zone.abbr);
    else setOrbitalDisplayZone('UTC', 'UTC');
    this.zone.hidden = zone === null;
    this.zone.textContent = local ? placeTimeZoneLabel(zone) : 'UTC';
    this.zone.setAttribute('aria-pressed', String(local));
    this.zone.title = t(local ? 'orbitalWatch.sheet.showUtc' : 'orbitalWatch.sheet.showLocal');
  }

  private placeLabel(): string {
    return this.placeName ?? (this.point ? formatCoords(this.point) : t('orbitalWatch.search.label'));
  }

  private setHeight(height: SheetHeight): void {
    this.height = height;
    this.sheet.dataset.height = height;
    this.handle.setAttribute('aria-label', t(`orbitalWatch.sheet.height.${height}`));
  }

  open(point: GeoPoint | null, returnFocusTo: HTMLElement | null): void {
    this.openSeq++;
    this.returnFocusTo = returnFocusTo;
    this.point = point;
    this.placeName = null;
    this.place.title = '';
    lookupImages.reset();
    stopWatchingNearView();
    this.expanded.clear();
    this.selectedKey = null;
    this.compareKey = null;
    this.context = { kind: 'loading' };
    this.place.textContent = this.placeLabel();
    this.renderSubline();
    this.placeZone = point ? placeTimeZone(point) : null;
    this.applyZone();
    this.shareButton.hidden = !this.callbacks.onShare || !point;
    this.shareButton.textContent = t('orbitalWatch.sheet.share');
    // Fixed labels are set on every open, so a language chosen since the last one shows.
    this.sheet.setAttribute('aria-label', t('orbitalWatch.sheet.heading'));
    this.kicker.textContent = t('orbitalWatch.sheet.heading');
    this.changeButton.textContent = t('orbitalWatch.sheet.change');
    this.closeButton.setAttribute('aria-label', t('countryBrief.closeBtn'));
    this.mapMark.lastElementChild!.textContent = point ? formatCoords(point) : '';
    this.setHeight('half');
    this.renderPrivacy();
    this.render(point ? { kind: 'computing', done: 0, total: 0 } : { kind: 'idle' });
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
    stopWatchingNearView();
    lookupImages.reset();
    this.state = null;
    this.selectedKey = null;
    this.callbacks.onClose();
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target?.isConnected) {
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  /**
   * Selects a pass in the list and announces it, so the timeline, the map and the globe select it too.
   * Returns false when the sheet holds no such pass.
   */
  select(key: string, { announce = true, focus = true }: { announce?: boolean; focus?: boolean } = {}): boolean {
    const state = this.state;
    if (!this.isOpen || state?.kind !== 'passes') return false;
    const pass = this.passes(state).find((p) => passKey(p) === key);
    if (!pass || pass.tier.kind === 'daily-mosaic') return false;
    this.selectedKey = key;
    const group = OPERATING_GROUP[pass.category];
    this.expanded.add(group);
    this.render(state);
    const row = this.body.querySelector<HTMLElement>(`.ies-row[data-key="pass:${key}"]`);
    if (row && focus) {
      row.scrollIntoView?.({ block: 'nearest' });
      row.focus({ preventScroll: true });
    }
    if (announce) this.sheet.dispatchEvent(new CustomEvent('orbital-watch:select', { bubbles: true, detail: { noradId: pass.noradId, timeMs: pass.timeMs } }));
    return true;
  }

  get selected(): string | null {
    return this.selectedKey;
  }

  /** The boxes the open lookup draws over the map, in client coordinates. */
  coverRects(): DOMRect[] {
    if (!this.isOpen) return [];
    const r = this.panel.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r] : [];
  }

  /** Docks the desktop panel inside the map's box, so columns beside the map (live news) stay visible. */
  dockTo(map: DOMRect | null): void {
    const style = this.sheet.style;
    if (!map) {
      for (const name of ['--ies-top', '--ies-right', '--ies-bottom']) style.removeProperty(name);
      return;
    }
    style.setProperty('--ies-top', `${Math.max(0, Math.round(map.top))}px`);
    style.setProperty('--ies-right', `${Math.max(0, Math.round(window.innerWidth - map.right))}px`);
    style.setProperty('--ies-bottom', `${Math.max(0, Math.round(window.innerHeight - map.bottom))}px`);
  }

  /** Draws the reticle at a client position on the map, or hides it. */
  placeMapMark(at: { x: number; y: number } | null): void {
    this.mapMark.hidden = !at;
    if (at) this.mapMark.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  }

  private renderPrivacy(): void {
    replaceChildren(this.privacy,
      h('p', { className: 'ies-privacy-line' }, t('orbitalWatch.privacy.line')),
      h('details', { className: 'ies-privacy-more' },
        h('summary', null, t('orbitalWatch.privacy.more')),
        h('p', null, t('orbitalWatch.privacy.body'))));
  }

  private passes(state: Extract<OrbitalWatchState, { kind: 'passes' }>): PointPass[] {
    return this.evidenceOf(state)?.passes ?? state.lookup.passes;
  }

  private evidenceOf(state: Extract<OrbitalWatchState, { kind: 'passes' }>): OrbitalEvidence | null {
    return state.archives.kind === 'answered' ? state.archives.evidence : state.archives.progress?.evidence ?? null;
  }

  render(state: OrbitalWatchState): void {
    this.state = state;
    this.sheet.dataset.state = state.kind === 'passes' ? (state.archives.kind === 'answered' ? 'answered' : 'checking') : state.kind;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = this.body.contains(active) ? active?.dataset.key ?? active?.dataset.action ?? null : null;
    // Re-attaching the timeline slot resets its sideways scroll, so carry it over.
    const timelineLeft = this.slots.timeline.scrollLeft;
    replaceChildren(this.body, ...this.renderState(state));
    this.slots.timeline.scrollLeft = timelineLeft;
    if (focusKey) {
      const again = this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"], [data-action="${CSS.escape(focusKey)}"]`);
      again?.focus({ preventScroll: true });
    }
    const evidence = state.kind === 'passes' ? this.evidenceOf(state) : null;
    this.renderSources(state.kind === 'passes' ? [...resultCredits(state.lookup, evidence), ...this.eventCredits()] : []);
  }

  private renderState(state: OrbitalWatchState): DomChild[] {
    if (state.kind === 'idle') return [h('p', { className: 'ies-empty' }, t('orbitalWatch.search.idle'))];
    if (state.kind === 'unavailable') {
      return [h('div', { className: 'ies-empty' }, h('p', null, t('orbitalWatch.status.unavailable')), this.retryButton())];
    }
    if (state.kind === 'computing') {
      return [h('p', { className: 'ies-status', role: 'status' }, state.total > 0
        ? t('orbitalWatch.status.computing', { done: state.done, total: state.total })
        : t('orbitalWatch.status.catalog'))];
    }
    return this.renderSheet(state);
  }

  private renderSheet(state: Extract<OrbitalWatchState, { kind: 'passes' }>): DomChild[] {
    const { lookup, archives } = state;
    const evidence = this.evidenceOf(state);
    const passes = this.passes(state);
    const isPending = pendingTest(lookup, archives);
    const summary = tally(lookup, passes, evidence, isPending);
    return [
      this.staleBanner(lookup),
      this.evidenceBlock(lookup, archives, summary, evidence),
      this.latestImage(summary, evidence, archives),
      this.slots.timeline,
      this.eventsSection(lookup),
      this.capabilitySection(lookup, passes, isPending),
      this.windowsSection(lookup, passes),
      h('div', { className: 'ies-alert', dataset: { section: 'alert' } },
        h('span', null, t('orbitalWatch.sheet.alert')),
        h('a', { className: 'ies-alert-cta', href: '/pro#pricing', target: '_blank', rel: 'noopener' }, t('orbitalWatch.sheet.alertCta'))),
    ];
  }

  private staleBanner(lookup: PointPassLookup): DomChild {
    if (lookup.catalog.status !== 'stale') return null;
    return h('p', { className: 'ies-note ies-stale', role: 'note' }, t('orbitalWatch.status.staleCatalog', { age: formatAge((lookup.nowMs - lookup.catalog.fetchedAt) / DAY_MS) }));
  }

  private evidenceBlock(lookup: PointPassLookup, archives: ArchiveState, summary: Tally, evidence: OrbitalEvidence | null): HTMLElement {
    const { latest, counts } = summary;
    const parts: string[] = [];
    if (counts.confirmed > 0 && latest) {
      parts.push(t('orbitalWatch.sheet.confirmedCount', { count: counts.confirmed }));
      parts.push(t('orbitalWatch.sheet.newest', { when: formatStamp(latest.startMs) }));
      parts.push(conditionLabel(latest));
    } else {
      parts.push(t(archives.kind === 'answered' ? 'orbitalWatch.sheet.noneConfirmed' : 'orbitalWatch.sheet.noneYet'));
    }
    if (archives.kind === 'checking') {
      parts.push(t('orbitalWatch.status.checking', { done: archives.progress?.settled.length ?? 0, total: archives.total }));
    }
    const failed = evidence ? [...new Set(evidence.failures.map((failure) => ARCHIVE_NAME[failure.archive]))] : [];
    const apart = [
      t('orbitalWatch.sheet.apartMosaics', { count: summary.mosaics }),
      t('orbitalWatch.sheet.apartFrames', { count: summary.frames }),
      t('orbitalWatch.sheet.apartInRange', { count: summary.inRange }),
    ].join(' · ');
    return h('div', { className: 'ies-evidence', dataset: { section: 'evidence' } },
      h('p', { className: 'ies-evidence-line', role: 'status' }, parts.join(' · ')),
      h('dl', { className: 'ies-counts' },
        ...COUNT_TIERS.map((tier) => h('div', { className: 'ies-count', dataset: { tier }, title: t(`orbitalWatch.tierDef.${tier}`) },
          h('dt', null, t(`orbitalWatch.tier.${tier}`)),
          h('dd', null, formatInt(counts[tier]))))),
      h('p', { className: 'ies-note' }, `${t('orbitalWatch.sheet.window', { days: SHEET_PAST_DAYS, hours: SHEET_FUTURE_HOURS })} · ${t('orbitalWatch.sheet.apart')} ${apart}`),
      failed.length > 0
        ? h('div', { className: 'ies-note ies-warn', role: 'note' },
          t('orbitalWatch.status.partial', { sources: formatList(failed) }), ' ', this.retryButton())
        : null,
      lookup.passes.length === 0 && counts.confirmed === 0 && archives.kind === 'answered'
        ? h('p', { className: 'ies-empty' }, t('orbitalWatch.status.empty'))
        : null);
  }

  private latestImage(summary: Tally, evidence: OrbitalEvidence | null, archives: ArchiveState): HTMLElement {
    const { latest, confirmed } = summary;
    if (!latest) {
      return section('latest', t('orbitalWatch.sheet.latest'),
        h('p', { className: 'ies-empty' }, t(archives.kind === 'answered' ? 'orbitalWatch.sheet.latestNone' : 'orbitalWatch.sheet.latestChecking')),
        this.thumbStrip(summary, evidence));
    }
    const sensor = sensorName(latest.platform);
    const alt = t('orbitalWatch.sheet.imageAlt', { sensor, time: formatStamp(latest.startMs) });
    const view: ViewableImage = { kind: 'acquisition', key: latest.key };
    const others = confirmed.filter((acquisition) => acquisition !== latest && acquisition.imageUrl && acquisition.profileId === latest.profileId);
    if (!others.some((acquisition) => acquisition.key === this.compareKey)) this.compareKey = others[0]?.key ?? null;
    const credit = acquisitionRowCredit(latest);
    const compare = others.length > 0
      ? h('div', { className: 'ies-compare' },
        h('button', { type: 'button', className: 'ies-primary', dataset: { action: 'compare' } }, t('orbitalWatch.sheet.compareWith')),
        h('select', { className: 'ies-select', 'aria-label': t('orbitalWatch.sheet.compareDate'), dataset: { role: 'compare-date' } },
          ...others.map((acquisition) => h('option', { value: acquisition.key, selected: acquisition.key === this.compareKey }, formatStamp(acquisition.startMs)))))
      : null;
    const hero = imageTile(latest.imageUrl, alt, sensor, 'hero', [...imageOverlays(), viewButton(view, alt)]);
    hero.classList.toggle('is-radar', isRadar(latest));
    return section('latest', t('orbitalWatch.sheet.latest'),
      h('figure', { className: 'ies-figure' },
        hero,
        h('figcaption', { className: 'ies-caption' },
          cell(t('orbitalWatch.row.sensor'), isRadar(latest) ? `${sensor} · ${t('orbitalWatch.tile.radar')}` : sensor),
          cell(t('orbitalWatch.row.time'), formatStamp(latest.startMs)),
          cell(t('orbitalWatch.row.point'), conditionLabel(latest)),
          cell(t('orbitalWatch.row.pixel'), `${latest.resolutionM} m`),
          cell(t('orbitalWatch.row.credit'), h('span', { title: credit.full }, credit.short)))),
      compare,
      this.thumbStrip(summary, evidence));
  }

  /** Every other image of the point; each starts loading only as it nears the viewport. */
  private thumbStrip(summary: Tally, evidence: OrbitalEvidence | null): DomChild {
    const specs = thumbSpecs(summary.confirmed, summary.latest, evidence);
    if (specs.length === 0) return null;
    return h('ul', { className: 'ies-thumbs', 'aria-label': t('orbitalWatch.sheet.moreImages') },
      ...specs.map((spec) => {
        const caption = h('span', { className: 'ies-thumb-caption' }, spec.caption);
        const fallbacks = spec.fallbacks?.length || spec.noDataAt
          ? { urls: spec.fallbacks ?? [], show: () => {}, noDataAt: spec.noDataAt }
          : null;
        const tile = imageTile(spec.url, spec.caption, spec.sensor, 'thumb', [viewButton(spec.view, spec.caption)], fallbacks);
        tile.classList.toggle('is-radar', !!spec.radar);
        return h('li', { className: 'ies-thumb', dataset: { key: spec.key } }, tile, caption);
      }));
  }

  private eventsSection(lookup: PointPassLookup): HTMLElement {
    const title = t('orbitalWatch.events.heading');
    const context = this.context;
    if (context.kind === 'loading') return section('events', title, h('p', { className: 'ies-empty' }, t('orbitalWatch.events.loading')));
    const fromMs = lookup.nowMs - SHEET_PAST_DAYS * DAY_MS;
    const rows: Array<{ timeMs: number | null; source: string; label: string; distanceKm: number | null }> = [];
    const unavailable: string[] = [];
    for (const source of EVENT_SOURCE_LIST) {
      const lane = context.context.events[source];
      if (lane.status !== 'ok') { unavailable.push(t(`orbitalWatch.events.kind.${source}`)); continue; }
      for (const event of lane.events) {
        if (event.timeMs < fromMs || event.timeMs > lookup.nowMs) continue;
        rows.push({ timeMs: event.timeMs, source, label: event.label, distanceKm: event.distanceKm });
      }
    }
    rows.sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));
    for (const source of LIVE_SOURCE_LIST) {
      const strip = context.context.live[source];
      if (strip.status !== 'ok') { unavailable.push(t(`orbitalWatch.events.kind.${source}`)); continue; }
      for (const item of strip.items) rows.unshift({ timeMs: null, source, label: item.label, distanceKm: item.distanceKm });
    }
    return section('events', title,
      rows.length === 0
        ? h('p', { className: 'ies-empty' }, t('orbitalWatch.events.none', { km: EVENT_RADIUS_KM, days: SHEET_PAST_DAYS }))
        : h('ul', { className: 'ies-table ies-events' },
          ...rows.map((row) => h('li', { className: 'ies-event', dataset: { source: row.source } },
            cell(t('orbitalWatch.row.time'), row.timeMs === null ? h('span', { className: 'ies-now' }, t('orbitalWatch.events.now')) : formatStamp(row.timeMs)),
            cell(t('orbitalWatch.events.kindLabel'), t(`orbitalWatch.events.kind.${row.source}`)),
            cell(t('orbitalWatch.events.detail'), row.label, 'ies-grow'),
            cell('', row.distanceKm === null ? '—' : `${Math.round(row.distanceKm)} km`)))),
      unavailable.length > 0 ? h('p', { className: 'ies-note' }, t('orbitalWatch.events.unavailable', { sources: formatList(unavailable) })) : null);
  }

  private passRow(pass: PointPass, pending: boolean, nowMs: number): HTMLElement {
    const key = passKey(pass);
    const tier = pending ? t('orbitalWatch.tier.checking') : t(TIER_KEY[pass.timeMs > nowMs ? 'opportunity' : pass.tier.kind]);
    return h('li', {
      className: 'ies-row',
      tabindex: '0',
      'aria-current': this.selectedKey === key ? 'true' : null,
      dataset: { key: `pass:${key}`, tier: pending ? 'pending' : pass.tier.kind },
    },
    cell(t('orbitalWatch.row.satellite'), pass.name, 'ies-grow ies-name'),
    cell(t('orbitalWatch.row.tier'), tier, 'ies-tier'),
    cell(t('orbitalWatch.row.time'), formatStamp(pass.timeMs)),
    cell(t('orbitalWatch.row.elevation'), `${Math.round(pass.elevationDeg)}°`),
    cell('', t('orbitalWatch.row.offNadir', { deg: offNadirDeg(pass).toFixed(1) })),
    orbitAgeCell(pass));
  }

  private capabilitySection(lookup: PointPassLookup, passes: PointPass[], isPending: (pass: PointPass) => boolean): HTMLElement {
    const fromMs = lookup.nowMs - SHEET_PAST_DAYS * DAY_MS;
    const toMs = lookup.nowMs + SHEET_FUTURE_HOURS * HOUR_MS;
    const groups = new Map<OperatingGroup, PointPass[]>();
    for (const pass of passes) {
      if (pass.tier.kind === 'daily-mosaic' || pass.timeMs < fromMs || pass.timeMs > toMs) continue;
      const group = OPERATING_GROUP[pass.category];
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(pass);
    }
    const tooOld = lookup.satellites.filter((satellite) => satellite.status === 'too-old').map((satellite) => satellite.name);
    return section('capability', t('orbitalWatch.capability.heading'),
      groups.size === 0 ? h('p', { className: 'ies-empty' }, t('orbitalWatch.capability.none')) : null,
      ...OPERATING_GROUPS.filter((group) => groups.has(group)).map((group) => {
        const rows = groups.get(group)!.sort((a, b) => b.timeMs - a.timeMs);
        const open = this.expanded.has(group);
        const shown = open ? rows : rows.slice(0, GROUP_PREVIEW_ROWS);
        return h('div', { className: 'ies-group', dataset: { group } },
          h('h4', { className: 'ies-group-title' }, `${t(`orbitalWatch.capability.group.${group}`)} · ${formatInt(rows.length)}`),
          h('ul', { className: 'ies-table' }, ...shown.map((pass) => this.passRow(pass, isPending(pass), lookup.nowMs))),
          rows.length > GROUP_PREVIEW_ROWS
            ? h('button', { type: 'button', className: 'ies-more', dataset: { action: 'toggle-group', group } },
              open ? t('orbitalWatch.capability.showFewer') : t('orbitalWatch.capability.showAll', { count: formatInt(rows.length) }))
            : null);
      }),
      tooOld.length > 0 ? h('p', { className: 'ies-note ies-stale', dataset: { role: 'too-old' } }, t('orbitalWatch.capability.tooOld', { names: formatList(tooOld), days: ORBIT_ELEMENTS_MAX_AGE_DAYS })) : null);
  }

  private windowsSection(lookup: PointPassLookup, passes: PointPass[]): HTMLElement {
    const toMs = lookup.nowMs + SHEET_FUTURE_HOURS * HOUR_MS;
    const next = passes
      .filter((pass) => pass.timeMs > lookup.nowMs && pass.timeMs <= toMs && (pass.category === 'open-optical' || pass.category === 'open-radar'))
      .sort((a, b) => a.timeMs - b.timeMs)
      .slice(0, NEXT_WINDOW_ROWS);
    return section('windows', t('orbitalWatch.windows.heading'),
      next.length === 0
        ? h('p', { className: 'ies-empty' }, t('orbitalWatch.windows.none', { hours: SHEET_FUTURE_HOURS }))
        : h('ul', { className: 'ies-table' }, ...next.map((pass) => {
          const key = passKey(pass);
          return h('li', { className: 'ies-row', tabindex: '0', 'aria-current': this.selectedKey === key ? 'true' : null, dataset: { key: `pass:${key}`, tier: 'opportunity' } },
            cell(t('orbitalWatch.row.time'), formatStamp(pass.timeMs)),
            cell(t('orbitalWatch.row.in'), formatRelative(pass.timeMs, lookup.nowMs, 'narrow')),
            cell(t('orbitalWatch.row.satellite'), pass.name, 'ies-grow ies-name'),
            cell(t('orbitalWatch.row.sensor'), t(pass.category === 'open-radar' ? 'orbitalWatch.windows.radar' : 'orbitalWatch.windows.optical')),
            cell(t('orbitalWatch.row.elevation'), `${Math.round(pass.elevationDeg)}°`),
            orbitAgeCell(pass));
        })));
  }

  /** The feeds behind the events rows, named only once they answered. */
  private eventCredits(): ResultCredit[] {
    if (this.context.kind !== 'loaded') return [];
    const { events, live } = this.context.context;
    const credits: ResultCredit[] = [];
    if (events.conflict.status === 'ok' || events.unrest.status === 'ok') credits.push({ source: 'GDELT · UCDP', text: t('orbitalWatch.sources.conflict') });
    if (events.fires.status === 'ok') credits.push({ source: 'NASA FIRMS', text: t('orbitalWatch.sources.fires') });
    if (events.outages.status === 'ok') credits.push({ source: 'WorldMonitor', text: t('orbitalWatch.sources.outages') });
    if (live.vessels.status === 'ok') credits.push({ source: 'AIS', text: t('orbitalWatch.sources.vessels') });
    return credits;
  }

  private renderSources(credits: ResultCredit[]): void {
    this.sources.hidden = credits.length === 0;
    replaceChildren(this.sources,
      h('summary', null, t('orbitalWatch.sources.heading', { count: credits.length })),
      h('ul', null, ...credits.map(({ source, text, href }) => h('li', null,
        href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, source) : source,
        ' · ', text))),
      h('a', { href: ORBITAL_WATCH_DOCS_URL, target: '_blank', rel: 'noopener noreferrer' }, t('orbitalWatch.sources.docs')));
  }

  private retryButton(): HTMLElement {
    return h('button', { type: 'button', className: 'ies-chip', dataset: { action: 'retry' } }, t('countryBrief.retryBtn'));
  }

  private readonly onSheetChange = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset?.role === 'compare-date') this.compareKey = target.value;
  };

  private readonly onSheetClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-action]');
    switch (actionEl?.dataset.action) {
      case 'retry': this.callbacks.onRetry(); return;
      case 'close': this.close(); return;
      case 'change': this.callbacks.onChangePlace ? this.callbacks.onChangePlace() : this.close(); return;
      case 'height': this.setHeight(SHEET_HEIGHTS[(SHEET_HEIGHTS.indexOf(this.height) + 1) % SHEET_HEIGHTS.length]!); return;
      case 'zone':
        this.localTime = !this.localTime;
        this.applyZone();
        if (this.state) this.render(this.state);
        this.sheet.dispatchEvent(new CustomEvent('orbital-watch:zone-change', { bubbles: true, detail: getOrbitalDisplayZone() }));
        return;
      case 'share': this.callbacks.onShare?.(actionEl); return;
      case 'retry-image': {
        const tile = actionEl.closest<HTMLElement>('.ow-tile');
        if (tile) tileRetries.get(tile)?.();
        return;
      }
      case 'view-image': this.openImageViewer(actionEl, null); return;
      case 'compare': {
        const hero = this.body.querySelector<HTMLElement>('[data-section="latest"] .ow-view-image');
        if (hero && this.compareKey) this.openImageViewer(hero, this.compareKey);
        return;
      }
      case 'toggle-group': {
        const group = actionEl.dataset.group as OperatingGroup;
        if (this.expanded.has(group)) this.expanded.delete(group);
        else this.expanded.add(group);
        if (this.state) this.render(this.state);
        return;
      }
    }
    const row = target.closest<HTMLElement>('.ies-row[data-key^="pass:"]');
    if (row) this.select(row.dataset.key!.slice('pass:'.length));
  };

  /** The viewer is its own lazy chunk, fetched the first time someone opens an image. */
  private openImageViewer(trigger: HTMLElement, compareKey: string | null): void {
    const state = this.state;
    if (state?.kind !== 'passes') return;
    const evidence = this.evidenceOf(state);
    if (!evidence) return;
    const { lookup } = state;
    const image = { kind: trigger.dataset.imageKind, key: trigger.dataset.imageKey } as ViewableImage;
    const returnFocusTo = trigger;
    const seq = this.openSeq;
    void import('./OrbitalImageViewer').then(({ openOrbitalImageViewer, subjectForImage }) => {
      const subject = subjectForImage(evidence, image, lookup, shownTileUrl(trigger.closest<HTMLElement>('.ow-tile')), (url) => lookupImages.isEmpty(url));
      if (subject && this.isOpen && seq === this.openSeq) openOrbitalImageViewer({ ...subject, place: this.placeName }, returnFocusTo, undefined, { compareKey });
    });
  }

  private readonly onSheetKeydown = (event: KeyboardEvent): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.ies-row');
    if (!row) return;
    if ((event.key === 'Enter' || event.key === ' ') && event.target === row) {
      event.preventDefault();
      this.select(row.dataset.key!.slice('pass:'.length));
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...this.sheet.querySelectorAll<HTMLElement>('.ies-row')];
    const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !document.querySelector('.oiv-dialog')) this.close();
  };
}
