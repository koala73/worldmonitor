/**
 * The satellite imagery row of map-object popups (#10713 unit 1): the newest
 * image, its date and the next pass, with an action that opens the point lookup.
 * It renders a placeholder synchronously so popup sizing stays cheap, then fills
 * in once the seeded site record or the in-browser lookup answers. The image is
 * painted from a blob URL so the object's position never sits in `img.src`.
 */
import { ORBITAL_WATCH_ENABLED } from '@/config/orbital-watch-flag';
import { t, getCurrentLanguageTag } from '@/services/i18n';
import { loadArchiveImage } from '@/services/orbital/archive-image';
import { findEventPair, type EventPair } from '@/services/orbital/event-imagery';
import { isFirmsDetection, type FireDetectionPopupData } from '@/services/orbital/fire-mosaic';
import { loadObjectImagery, type ImageryTarget, type ObjectImagery } from '@/services/orbital/object-imagery';
import type { ConflictZone, MilitaryBase, NaturalEvent, NewsLocationMarker, NuclearFacility, Port, StrategicWaterway } from '@/types';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';

/** An image older than this is shown in the staleness colour. */
export const IMAGE_STALE_MS = 14 * 86_400_000;

interface PointData { lat: number; lon: number }
interface EventPointData { latitude: number; longitude: number; timestamp?: string | number }

/** The objects that carry an imagery row, or null for every other popup. */
export function imageryTargetFor(type: string, data: unknown): ImageryTarget | null {
  switch (type) {
    case 'base': {
      const b = data as MilitaryBase;
      return { kind: 'site', origin: { list: 'military-base', id: b.id }, point: { lat: b.lat, lon: b.lon } };
    }
    case 'port': {
      const p = data as Port;
      return { kind: 'site', origin: { list: 'port', id: p.id }, point: { lat: p.lat, lon: p.lon } };
    }
    case 'nuclear': {
      const n = data as NuclearFacility;
      return { kind: 'site', origin: { list: 'nuclear-facility', id: n.id }, point: { lat: n.lat, lon: n.lon } };
    }
    case 'waterway': {
      const w = data as StrategicWaterway;
      return { kind: 'site', origin: { list: 'chokepoint', id: w.id }, point: { lat: w.lat, lon: w.lon } };
    }
    case 'conflict': {
      const c = data as ConflictZone;
      return { kind: 'site', origin: { list: 'conflict-zone', id: c.id }, point: { lat: c.center[1], lon: c.center[0] } };
    }
    case 'reservoirLevel': {
      const r = data as PointData;
      // The reservoir card names its next ICESat-2 crossing; a second "next pass" would compete with it.
      // Its radar water extent has its own row, so the image here is the latest optical one.
      return { kind: 'point', point: { lat: r.lat, lon: r.lon }, ownNextPass: true, optical: true };
    }
    case 'iranEvent': {
      const e = data as EventPointData;
      return Number.isFinite(e.latitude) && Number.isFinite(e.longitude) ? { kind: 'point', point: { lat: e.latitude, lon: e.longitude } } : null;
    }
    case 'natEvent': {
      const e = data as NaturalEvent;
      return e.category === 'wildfires' ? { kind: 'point', point: { lat: e.lat, lon: e.lon } } : null;
    }
    case 'fireDetection': {
      const f = data as PointData;
      return isFirmsDetection(data) ? { kind: 'point', point: { lat: f.lat, lon: f.lon } } : null;
    }
    case 'news': {
      const n = data as PointData;
      return Number.isFinite(n.lat) && Number.isFinite(n.lon) ? { kind: 'point', point: { lat: n.lat, lon: n.lon } } : null;
    }
    default:
      return null;
  }
}

const validTime = (ms: number): number | null => (Number.isFinite(ms) && ms > 0 ? ms : null);

/**
 * The time a dated event happened, for the before/after around it (#10713 unit 2), or null for objects
 * with no single date: sites (conflict zones included), and every popup without an imagery row. Outages
 * have no row: their point is the country's centroid, not the place that went dark.
 */
export function eventTimeFor(type: string, data: unknown): number | null {
  if (!imageryTargetFor(type, data)) return null;
  switch (type) {
    case 'iranEvent': {
      const { timestamp } = data as EventPointData;
      return timestamp === undefined ? null : validTime(typeof timestamp === 'number' ? timestamp : Date.parse(timestamp));
    }
    case 'natEvent':
      return validTime(new Date((data as NaturalEvent).date).getTime());
    case 'fireDetection':
      return validTime((data as FireDetectionPopupData).detected_at!);
    case 'news': {
      const { timestamp } = data as NewsLocationMarker;
      return timestamp ? validTime(new Date(timestamp).getTime()) : null;
    }
    default:
      return null;
  }
}

/** Whether a popup of this type and data gets the row in this build. */
export function hasImageryRow(type: string, data: unknown, enabled = ORBITAL_WATCH_ENABLED): boolean {
  return enabled && imageryTargetFor(type, data) !== null;
}

const label = (key: string, params?: Record<string, string>) => escapeHtml(t(`orbitalWatch.popup.${key}`, params));

export function renderImageryRow(): string {
  return `<div class="popup-section popup-imagery" data-orbital-imagery aria-live="polite">
    <span class="section-label">${label('title')}</span>
    <div class="popup-imagery-body"><span class="popup-imagery-status">${label('loading')}</span></div>
  </div>`;
}

/**
 * Seam for the change-flag row. Flags stay in shadow until #10708, so this
 * renders nothing; the row goes here once confirmed flags are public.
 */
export function renderChangeFlagRow(_imagery: ObjectImagery): string {
  return '';
}

export const formatUtc = (ms: number) => new Intl.DateTimeFormat(getCurrentLanguageTag(), {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
}).format(ms);

const PROFILE_NAMES: Record<string, string> = { 'sentinel-2': 'Sentinel-2', 'sentinel-1': 'Sentinel-1 radar', landsat: 'Landsat' };
const profileName = (id: string) => PROFILE_NAMES[id] ?? id;

function renderNextPass(imagery: ObjectImagery): string {
  if (imagery.nextPassPending) return '…';
  return imagery.nextPass
    ? `${escapeHtml(formatUtc(imagery.nextPass.timeMs))}<span class="popup-imagery-source">${escapeHtml(imagery.nextPass.satellite)}</span>`
    : label('noPass');
}

export const formatDay = (ms: number) => new Intl.DateTimeFormat(getCurrentLanguageTag(), {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(ms);

/** Before/after is Pro (#10713 tier table): Pro opens it, everyone else sees where it is unlocked. */
export type EventCompareAccess = 'open' | 'locked';

function renderEventCompare(access: EventCompareAccess | null): string {
  if (access === 'open') {
    return `<button type="button" class="popup-imagery-open popup-imagery-compare" data-orbital-event-compare>${label('compareEvent')}</button>
      <span class="popup-imagery-status" data-orbital-event-status hidden></span>`;
  }
  if (access === 'locked') {
    return `<a class="popup-imagery-compare-locked" href="/pro#pricing" target="_blank" rel="noopener" data-orbital-event-compare-locked>${label('compareEventLocked')}</a>`;
  }
  return '';
}

export function renderImageryDetails(imagery: ObjectImagery, nowMs: number, showNextPass = true, eventCompare: EventCompareAccess | null = null): string {
  const latestMs = imagery.latest ? Date.parse(imagery.latest.datetime) : NaN;
  const stale = Number.isFinite(latestMs) && nowMs - latestMs > IMAGE_STALE_MS;
  const latest = imagery.latest && Number.isFinite(latestMs)
    ? `${escapeHtml(formatUtc(latestMs))}<span class="popup-imagery-source">${escapeHtml(profileName(imagery.latest.profileId))}</span>`
    : label(imagery.imageSearchFailed ? 'unavailable' : 'noImage');
  const next = renderNextPass(imagery);
  return `${imagery.latest ? '<div class="popup-imagery-frame" data-orbital-image></div>' : ''}
    <div class="popup-stats popup-imagery-stats">
      <div class="popup-stat${stale ? ' popup-imagery-stale' : ''}"><span class="stat-label">${label('latest')}</span><span class="stat-value">${latest}</span></div>
      ${showNextPass ? `<div class="popup-stat"><span class="stat-label">${label('nextPass')}</span><span class="stat-value" data-orbital-next-pass>${next}</span></div>` : ''}
    </div>
    ${renderChangeFlagRow(imagery)}
    <div class="popup-imagery-actions">
      <button type="button" class="popup-imagery-open" data-orbital-open-evidence>${label('openEvidence')}</button>
      ${renderEventCompare(eventCompare)}
    </div>`;
}

export interface EventCompareHooks {
  eventMs: number;
  access: EventCompareAccess;
  onOpen: (target: ImageryTarget, eventMs: number, pair: Extract<EventPair, { status: 'ok' }>) => void;
  findPair?: typeof findEventPair;
}

export interface ImageryRowHooks {
  onOpenEvidence: (target: ImageryTarget) => void;
  onLayout: () => void;
  load?: typeof loadObjectImagery;
  now?: () => number;
  /** The before/after around a dated event; absent for objects without one. */
  eventCompare?: EventCompareHooks;
}

/** Searches the archive around the event from the popup, then hands the pair to the viewer, or says in place what is missing. */
function bindEventCompare(body: HTMLElement, target: ImageryTarget, hooks: ImageryRowHooks, signal: AbortSignal): void {
  const compare = hooks.eventCompare;
  const button = body.querySelector<HTMLButtonElement>('[data-orbital-event-compare]');
  const status = body.querySelector<HTMLElement>('[data-orbital-event-status]');
  if (!compare || !button || !status) return;
  const date = formatDay(compare.eventMs);
  const say = (text: string) => {
    status.textContent = text;
    status.hidden = false;
    hooks.onLayout();
  };
  button.addEventListener('click', () => {
    button.disabled = true;
    say(t('orbitalWatch.popup.compareSearching', { date }));
    const find = compare.findPair ?? findEventPair;
    void find(target.point, compare.eventMs, (hooks.now ?? Date.now)(), { signal }).catch((): EventPair => ({ status: 'failed' })).then((pair) => {
      if (signal.aborted) return;
      button.disabled = false;
      if (pair.status === 'ok') {
        status.hidden = true;
        compare.onOpen(target, compare.eventMs, pair);
        return;
      }
      say(pair.status === 'none'
        ? t(pair.missing === 'after' ? 'orbitalWatch.popup.compareNoAfter' : 'orbitalWatch.popup.compareNoBefore', { date })
        : t('orbitalWatch.popup.compareFailed'));
    });
  });
}

/** Fills the row in place; the returned dispose aborts the lookup and frees the image. */
export function mountImageryRow(root: HTMLElement, target: ImageryTarget, hooks: ImageryRowHooks): () => void {
  const controller = new AbortController();
  let release = () => {};
  const body = root.querySelector<HTMLElement>('.popup-imagery-body');
  const load = hooks.load ?? loadObjectImagery;
  if (!body) return () => {};
  const showNextPass = !(target.kind === 'point' && target.ownNextPass);
  let early: ObjectImagery | null = null;
  const paint = async (imagery: ObjectImagery) => {
    setTrustedHtml(body, trustedHtml(renderImageryDetails(imagery, (hooks.now ?? Date.now)(), showNextPass, hooks.eventCompare?.access ?? null), 'imagery row markup escapes every value'));
    body.querySelector('[data-orbital-open-evidence]')?.addEventListener('click', () => hooks.onOpenEvidence(target));
    bindEventCompare(body, target, hooks, controller.signal);
    hooks.onLayout();
    const frame = body.querySelector<HTMLElement>('[data-orbital-image]');
    if (!frame || !imagery.latest) return;
    const result = await loadArchiveImage(imagery.latest.archive, imagery.latest.candidates, { signal: controller.signal });
    if (result.status !== 'ok') {
      frame.remove();
      hooks.onLayout();
      return;
    }
    if (controller.signal.aborted) return result.image.release();
    release = result.image.release;
    const img = document.createElement('img');
    img.alt = t('orbitalWatch.popup.imageAlt', { source: profileName(imagery.latest.profileId) });
    img.decoding = 'async';
    img.src = result.image.objectUrl;
    frame.appendChild(img);
    hooks.onLayout();
  };
  // The image paints as soon as it is known; the next pass fills its stat when the pass worker answers.
  let earlyPaint: Promise<void> = Promise.resolve();
  const onImageReady = (imagery: ObjectImagery) => {
    if (controller.signal.aborted) return;
    early = imagery;
    earlyPaint = paint(imagery);
  };
  void load(target, controller.signal, onImageReady).then(async (imagery) => {
    if (controller.signal.aborted) return;
    const nextPassCell = body.querySelector<HTMLElement>('[data-orbital-next-pass]');
    if (early && early.latest === imagery.latest && early.imageSearchFailed === imagery.imageSearchFailed && (nextPassCell || !showNextPass)) {
      if (nextPassCell) setTrustedHtml(nextPassCell, trustedHtml(renderNextPass(imagery), 'next pass markup escapes every value'));
      hooks.onLayout();
      return earlyPaint;
    }
    return paint(imagery);
  }).catch(() => {
    if (controller.signal.aborted) return;
    setTrustedHtml(body, trustedHtml(`<span class="popup-imagery-status">${label('unavailable')}</span>`, 'static locale string'));
    hooks.onLayout();
  });
  return () => {
    controller.abort();
    release();
  };
}
