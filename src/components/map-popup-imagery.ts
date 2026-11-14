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
import { loadObjectImagery, type ImageryTarget, type ObjectImagery } from '@/services/orbital/object-imagery';
import type { ConflictZone, MilitaryBase, NaturalEvent, NuclearFacility, Port, StrategicWaterway } from '@/types';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';

/** An image older than this is shown in the staleness colour. */
export const IMAGE_STALE_MS = 14 * 86_400_000;

interface PointData { lat: number; lon: number }
interface EventPointData { latitude: number; longitude: number }

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
      return { kind: 'point', point: { lat: r.lat, lon: r.lon } };
    }
    case 'iranEvent': {
      const e = data as EventPointData;
      return Number.isFinite(e.latitude) && Number.isFinite(e.longitude) ? { kind: 'point', point: { lat: e.latitude, lon: e.longitude } } : null;
    }
    case 'natEvent': {
      const e = data as NaturalEvent;
      return e.category === 'wildfires' ? { kind: 'point', point: { lat: e.lat, lon: e.lon } } : null;
    }
    default:
      return null;
  }
}

/** Whether a popup of this type and data gets the row in this build. */
export function hasImageryRow(type: string, data: unknown, enabled = ORBITAL_WATCH_ENABLED): boolean {
  return enabled && imageryTargetFor(type, data) !== null;
}

const label = (key: string) => escapeHtml(t(`orbitalWatch.popup.${key}`));

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

const formatUtc = (ms: number) => new Intl.DateTimeFormat(getCurrentLanguageTag(), {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
}).format(ms);

const PROFILE_NAMES: Record<string, string> = { 'sentinel-2': 'Sentinel-2', 'sentinel-1': 'Sentinel-1 radar', landsat: 'Landsat' };
const profileName = (id: string) => PROFILE_NAMES[id] ?? id;

export function renderImageryDetails(imagery: ObjectImagery, nowMs: number): string {
  const latestMs = imagery.latest ? Date.parse(imagery.latest.datetime) : NaN;
  const stale = Number.isFinite(latestMs) && nowMs - latestMs > IMAGE_STALE_MS;
  const latest = imagery.latest && Number.isFinite(latestMs)
    ? `${escapeHtml(formatUtc(latestMs))}<span class="popup-imagery-source">${escapeHtml(profileName(imagery.latest.profileId))}</span>`
    : label(imagery.imageSearchFailed ? 'unavailable' : 'noImage');
  const next = imagery.nextPass
    ? `${escapeHtml(formatUtc(imagery.nextPass.timeMs))}<span class="popup-imagery-source">${escapeHtml(imagery.nextPass.satellite)}</span>`
    : label('noPass');
  return `${imagery.latest ? '<div class="popup-imagery-frame" data-orbital-image></div>' : ''}
    <div class="popup-stats popup-imagery-stats">
      <div class="popup-stat${stale ? ' popup-imagery-stale' : ''}"><span class="stat-label">${label('latest')}</span><span class="stat-value">${latest}</span></div>
      <div class="popup-stat"><span class="stat-label">${label('nextPass')}</span><span class="stat-value">${next}</span></div>
    </div>
    ${renderChangeFlagRow(imagery)}
    <button type="button" class="popup-imagery-open" data-orbital-open-evidence>${label('openEvidence')}</button>`;
}

export interface ImageryRowHooks {
  onOpenEvidence: (target: ImageryTarget) => void;
  onLayout: () => void;
  load?: typeof loadObjectImagery;
  now?: () => number;
}

/** Fills the row in place; the returned dispose aborts the lookup and frees the image. */
export function mountImageryRow(root: HTMLElement, target: ImageryTarget, hooks: ImageryRowHooks): () => void {
  const controller = new AbortController();
  let release = () => {};
  const body = root.querySelector<HTMLElement>('.popup-imagery-body');
  const load = hooks.load ?? loadObjectImagery;
  if (!body) return () => {};
  void load(target, controller.signal).then(async (imagery) => {
    if (controller.signal.aborted) return;
    setTrustedHtml(body, trustedHtml(renderImageryDetails(imagery, (hooks.now ?? Date.now)()), 'imagery row markup escapes every value'));
    body.querySelector('[data-orbital-open-evidence]')?.addEventListener('click', () => hooks.onOpenEvidence(target));
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
