import type { WaterExtent, WaterReading } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import type { ReservoirLevel } from '@/services/climate';
import { loadReservoirLevelsById, loadReservoirNextPasses } from '@/services/climate/reservoir-context-loader';
import { STRATEGIC_RESERVOIR_SITES, type StrategicReservoirSite } from '@/services/climate/reservoir-context';
import { getLocale, t } from '@/services/i18n';
import type { ObjectImage } from '@/services/orbital/object-imagery';
import { reservoirNextPassExpiresAt, type ReservoirNextPass } from '@/services/orbital/reservoir-next-pass-expiry';
import { escapeHtml } from '@/utils/sanitize';
import { formatPassDate, reservoirHeadline, reservoirMeasuredShort, reservoirNextPassText, type ReservoirFormatContext } from './reservoir-levels-view';
import '../styles/reservoir-levels.css';

type Translate = ReservoirFormatContext['t'];

/** A row whose source could not be read, as opposed to one that has no reading. */
export const WATER_UNAVAILABLE = 'unavailable' as const;
type Loaded<T> = T | null | typeof WATER_UNAVAILABLE;

const OPTICAL_NAMES: Record<string, string> = { 'sentinel-2': 'Sentinel-2', landsat: 'Landsat' };

const readingDate = (reading: WaterReading, ctx: Pick<ReservoirFormatContext, 'locale' | 'nowMs'>) =>
  formatPassDate(new Date(reading.timeMs), ctx.locale, ctx.nowMs);

const number = (value: number, locale: string) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

/** "62.4% open water (318.5 km²) on 9 Nov", then the change since the last reading from the same orbit. */
export function waterExtentLines(extent: Loaded<WaterExtent>, ctx: ReservoirFormatContext): string[] {
  const { t, locale } = ctx;
  if (extent === WATER_UNAVAILABLE) return [t('components.reservoirLevels.water.unavailable')];
  const latest = extent?.latest;
  if (!latest) return [t('components.reservoirLevels.water.extentNone')];
  const lines = [t('components.reservoirLevels.water.extentValue', {
    percent: number(latest.waterPercent, locale), area: number(latest.waterKm2, locale), date: readingDate(latest, ctx),
  })];
  const previous = extent.sameOrbitPrevious;
  if (previous) {
    const delta = Math.round((latest.waterPercent - previous.waterPercent) * 10) / 10;
    const signed = `${delta > 0 ? '+' : delta < 0 ? '\u2212' : ''}${number(Math.abs(delta), locale)}`;
    lines.push(t('components.reservoirLevels.water.extentChange', { delta: signed, date: readingDate(previous, ctx) }));
  } else {
    lines.push(t('components.reservoirLevels.water.extentNoComparison'));
  }
  return lines;
}

/** The popup's radar row; filled in by `fillWaterExtentRow` once the site record answers. */
export function renderWaterExtentRow(reservoirId: string, t: Translate): string {
  return `<div class="wl-next-pass wl-water-extent" data-wl-water-extent="${escapeHtml(reservoirId)}">
      <span class="wl-next-pass-label">${escapeHtml(t('components.reservoirLevels.water.extent'))}</span>
      <span class="wl-next-pass-value">${escapeHtml(t('components.reservoirLevels.nextPass.loading'))}</span>
    </div>`;
}

export function fillWaterExtentRow(row: HTMLElement, extent: Loaded<WaterExtent>, ctx: ReservoirFormatContext): void {
  const value = row.querySelector('.wl-next-pass-value');
  if (!value) return;
  value.replaceChildren(...waterExtentLines(extent, ctx).map((line) => {
    const span = document.createElement('span');
    span.className = 'wl-water-extent-line';
    span.textContent = line;
    return span;
  }));
}

export interface WaterCardInput {
  level: Loaded<ReservoirLevel>;
  extent: Loaded<WaterExtent>;
  /** Newest optical scene of the reservoir; null when none was found. */
  optical: Loaded<ObjectImage>;
  nextPass: ReservoirNextPass | null;
}

function row(name: string, label: string, lines: string[]): HTMLElement {
  const node = document.createElement('div');
  node.className = 'wl-water-row';
  node.dataset.row = name;
  const key = document.createElement('span');
  key.className = 'wl-water-label';
  key.textContent = label;
  const value = document.createElement('span');
  value.className = 'wl-water-value';
  for (const line of lines) {
    const span = document.createElement('span');
    span.textContent = line;
    value.append(span);
  }
  node.append(key, value);
  return node;
}

/**
 * The water card (#10714): lidar level change, radar water extent, latest optical image and the next
 * lidar pass, each with the date it was measured or is due. Context only; no value here is scored.
 */
export function waterCard(name: string, input: WaterCardInput, ctx: ReservoirFormatContext): HTMLElement {
  const { t, locale, nowMs } = ctx;
  const card = document.createElement('section');
  card.className = 'wl-water-card';
  card.dataset.section = 'water';
  const title = document.createElement('div');
  title.className = 'wl-water-title';
  title.textContent = t('components.reservoirLevels.water.heading', { name });
  const { level, extent, optical, nextPass } = input;
  const pass = nextPass && reservoirNextPassExpiresAt(nextPass) > nowMs ? nextPass : null;
  const unavailable = [t('components.reservoirLevels.water.unavailable')];
  const note = document.createElement('p');
  note.className = 'wl-water-note';
  note.textContent = t('components.reservoirLevels.water.note');
  card.append(
    title,
    row('level', t('components.reservoirLevels.water.level'), level === WATER_UNAVAILABLE ? unavailable
      : level?.latest ? [reservoirHeadline(level, ctx), reservoirMeasuredShort(level, ctx)]
      : [t('components.reservoirLevels.noPass')]),
    row('extent', t('components.reservoirLevels.water.extent'), waterExtentLines(extent, ctx)),
    row('optical', t('components.reservoirLevels.water.optical'), optical === WATER_UNAVAILABLE ? unavailable
      : optical ? [`${formatPassDate(new Date(optical.datetime), locale, nowMs)} · ${OPTICAL_NAMES[optical.profileId] ?? optical.profileId}`]
      : [t('components.reservoirLevels.water.opticalNone')]),
    row('pass', t('components.reservoirLevels.nextPass.label'), [pass ? reservoirNextPassText(pass, t, locale) : t('components.reservoirLevels.nextPass.unavailable')]),
    note,
  );
  return card;
}

/**
 * Loads the four rows for a reservoir and builds its card. Every read is keyed by the public registry:
 * the level and crossing by reservoir id, the radar extent by watched-site id, the optical image at the
 * centre of the reservoir's core box, so the user's own point is not sent anywhere.
 */
export async function loadWaterCard(site: StrategicReservoirSite, signal: AbortSignal): Promise<HTMLElement> {
  const [w, s, e, n] = site.core;
  const centre = { lat: Math.round(((s + n) / 2) * 100) / 100, lon: Math.round(((w + e) / 2) * 100) / 100 };
  // The imagery loader is imported here, not at the top: the map popup imports this module on every visit.
  const imageryModule = import('@/services/orbital/object-imagery');
  const [levels, extent, imagery, passes] = await Promise.all([
    loadReservoirLevelsById().catch(() => WATER_UNAVAILABLE),
    imageryModule.then(m => m.loadReservoirWaterExtent(site.id, signal)).catch(() => WATER_UNAVAILABLE),
    imageryModule.then(m => m.loadObjectImagery({ kind: 'point', point: centre, ownNextPass: true, optical: true }, signal)).catch(() => WATER_UNAVAILABLE),
    loadReservoirNextPasses(STRATEGIC_RESERVOIR_SITES, { signal }).catch(() => null),
  ]);
  signal.throwIfAborted();
  const ctx = { t, locale: getLocale(), nowMs: Date.now() };
  const level = levels === WATER_UNAVAILABLE ? levels : levels.get(site.id) ?? null;
  const optical = imagery === WATER_UNAVAILABLE || (!imagery.latest && imagery.imageSearchFailed) ? WATER_UNAVAILABLE : imagery.latest;
  const name = level === WATER_UNAVAILABLE ? site.name : level?.name ?? site.name;
  return waterCard(name, { level, extent, optical, nextPass: passes?.get(site.id) ?? null }, ctx);
}
