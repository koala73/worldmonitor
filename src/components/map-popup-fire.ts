/**
 * The popup of a NASA FIRMS fire detection (#10713). A detection is itself a
 * satellite observation with an exact position and time, so the popup states
 * those facts and, when NASA GIBS holds the daily mosaic of that instrument for
 * that date, shows it. A date with no mosaic shows no image: a mosaic is a
 * composite of the day's passes, so it never proves the fire is visible.
 * The imagery row of every point popup (`map-popup-imagery`) is appended by
 * `MapPopup`, so a detection also gets the newest scene and the next pass.
 */
import { ORBITAL_WATCH_ENABLED } from '@/config/orbital-watch-flag';
import { t, getCurrentLanguageTag } from '@/services/i18n';
import { loadArchiveImage } from '@/services/orbital/archive-image';
import { IMAGE_CREDIT } from '@/services/orbital/credits';
import { instrumentOf, isFirmsDetection, loadFireMosaic, type FireDetectionPopupData, type FireMosaic } from '@/services/orbital/fire-mosaic';
import { noDataAtPoint } from '@/services/orbital/image-no-data';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { formatUtc } from './map-popup-imagery';

export type { FireDetectionPopupData } from '@/services/orbital/fire-mosaic';

/** The data a fire popup opens with, or null when this build has no fire popup or the fire is not a satellite detection. */
export function fireDetectionPopupData(fire: unknown, enabled = ORBITAL_WATCH_ENABLED): FireDetectionPopupData | null {
  return enabled && isFirmsDetection(fire) ? fire : null;
}

const label = (key: string, params?: Record<string, string>) => escapeHtml(t(`orbitalWatch.popup.fire.${key}`, params));

function confidenceLabel(confidence: number): string | null {
  if (confidence >= 80) return label('confidenceHigh');
  if (confidence >= 50) return label('confidenceNominal');
  return confidence > 0 ? label('confidenceLow') : null;
}

function stat(name: string, value: string): string {
  return `<div class="popup-stat"><span class="stat-label">${label(name)}</span><span class="stat-value">${value}</span></div>`;
}

export function renderFireDetectionPopup(fire: FireDetectionPopupData): string {
  const instrument = instrumentOf(fire.satellite);
  const confidence = confidenceLabel(fire.confidence);
  const power = Number.isFinite(fire.frp) && fire.frp > 0 ? label('powerValue', { value: fire.frp.toFixed(1) }) : null;
  return `
    <div class="popup-header fire-detection">
      <span class="popup-title">${label('title')}</span>
      <button class="popup-close" aria-label="${escapeHtml(t('common.close'))}">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-stats">
        ${stat('detected', escapeHtml(formatUtc(fire.detected_at ?? NaN)))}
        ${instrument.label ? stat('satellite', escapeHtml(instrument.label)) : ''}
        ${confidence ? stat('confidence', confidence) : ''}
        ${power ? stat('power', power) : ''}
        ${fire.region ? stat('region', escapeHtml(fire.region)) : ''}
        ${stat('source', label('sourceCredit'))}
      </div>
      <div class="popup-section popup-fire-mosaic" data-fire-mosaic aria-live="polite">
        <span class="section-label">${label('mosaicTitle')}</span>
        <div class="popup-fire-mosaic-body"><span class="popup-imagery-status">${label('mosaicLoading')}</span></div>
      </div>
    </div>`;
}

const mosaicNote = (text: string) => `<span class="popup-imagery-status">${escapeHtml(text)}</span>`;

/** An ISO date (a UTC day) as the user's locale writes it. */
const formatDay = (isoDate: string) => new Intl.DateTimeFormat(getCurrentLanguageTag(), {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(Date.parse(`${isoDate}T00:00:00Z`));

function mosaicNoneText(mosaic: Extract<FireMosaic, { status: 'none' }>): string {
  return mosaic.reason === 'no-layer'
    ? t('orbitalWatch.popup.fire.mosaicNoLayer')
    : t('orbitalWatch.popup.fire.mosaicNone', { source: mosaic.source ?? '', date: formatDay(mosaic.date) });
}

export interface FireMosaicHooks {
  onLayout: () => void;
  load?: (point: { lat: number; lon: number }, detectedAtMs: number, satellite: string | undefined, options: { signal?: AbortSignal }) => Promise<FireMosaic>;
}

/** Fills the mosaic section in place; the returned dispose aborts the lookup and frees the image. */
export function mountFireMosaic(root: HTMLElement, fire: FireDetectionPopupData, hooks: FireMosaicHooks): () => void {
  const controller = new AbortController();
  let release = () => {};
  const body = root.querySelector<HTMLElement>('[data-fire-mosaic] .popup-fire-mosaic-body');
  if (!body) return () => {};
  const say = (text: string) => {
    setTrustedHtml(body, trustedHtml(mosaicNote(text), 'locale string, escaped'));
    hooks.onLayout();
  };
  const load = hooks.load ?? loadFireMosaic;
  void load({ lat: fire.lat, lon: fire.lon }, fire.detected_at ?? NaN, fire.satellite, { signal: controller.signal }).then(async (mosaic) => {
    if (controller.signal.aborted) return;
    if (mosaic.status === 'failed') return say(t('orbitalWatch.popup.fire.mosaicUnavailable'));
    if (mosaic.status === 'none') return say(mosaicNoneText(mosaic));
    const date = formatDay(mosaic.date);
    const result = await loadArchiveImage(mosaic.archive, mosaic.candidates, { signal: controller.signal });
    if (controller.signal.aborted) {
      if (result.status === 'ok') result.image.release();
      return;
    }
    if (result.status !== 'ok') return say(t('orbitalWatch.popup.fire.mosaicUnavailable'));
    release = result.image.release;
    const img = document.createElement('img');
    img.alt = t('orbitalWatch.popup.fire.mosaicAlt', { source: mosaic.source, date });
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (controller.signal.aborted || !noDataAtPoint(img, mosaic.pointInCrop)) return;
      release();
      release = () => {};
      say(t('orbitalWatch.popup.fire.mosaicNone', { source: mosaic.source, date }));
    });
    img.src = result.image.objectUrl;
    setTrustedHtml(body, trustedHtml(`<div class="popup-imagery-frame" data-fire-mosaic-image></div>
      <span class="popup-imagery-status">${escapeHtml(t('orbitalWatch.popup.fire.mosaicCaption', { source: mosaic.source, date }))}</span>
      <span class="popup-imagery-source">${escapeHtml(IMAGE_CREDIT.gibs)}</span>`, 'locale strings, escaped'));
    body.querySelector('[data-fire-mosaic-image]')?.appendChild(img);
    hooks.onLayout();
  }).catch(() => {
    if (!controller.signal.aborted) say(t('orbitalWatch.popup.fire.mosaicUnavailable'));
  });
  return () => {
    controller.abort();
    release();
  };
}
