import type { ReservoirLevel } from '@/services/climate';
import { reservoirNextPassExpiresAt, type ReservoirNextPass } from '@/services/orbital/reservoir-next-pass';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { isBeyondSeasonalBaseline } from '../../shared/country-signal-observations';
import {
  formatPassDate,
  reservoirChipTone,
  reservoirHeadline,
  reservoirMeasuredShort,
  reservoirNextPassShort,
  reservoirNextPassText,
  reservoirSparkline,
  statusLabel,
  type ReservoirFormatContext,
} from './reservoir-levels-view';
import '../styles/reservoir-levels.css';

export interface ReservoirCardOptions {
  /** Predicted crossing for this reservoir; omit where Orbital Watch is off. Expired predictions are dropped. */
  nextPass?: ReservoirNextPass | null;
  /** Popup form: no crossing row and a smaller sparkline. */
  compact?: boolean;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One Strategic Water Levels reservoir as a card: name and river, status chip, delta vs the
 * usual level for the month, 36-month sparkline with the seasonal baseline, measured date and,
 * when given, the predicted ICESat-2 crossing. Every value is from a dated lidar pass.
 */
export function reservoirCard(r: ReservoirLevel, ctx: ReservoirFormatContext, opts: ReservoirCardOptions = {}): HTMLElement {
  const card = el('div', `wl-card wl-tone-${reservoirChipTone(r.status)}${opts.compact ? ' wl-card-compact' : ''}`);
  card.dataset.reservoirId = r.id;
  card.dataset.status = r.status;

  const id = el('div', 'wl-card-id');
  id.append(el('span', 'wl-card-name', r.name));
  if (r.river) id.append(el('span', 'wl-card-river', r.river));
  card.append(id, el('span', 'wl-chip', statusLabel(r, ctx.t)), el('span', 'wl-card-delta', reservoirHeadline(r, ctx)));

  const measured = el('span', 'wl-card-measured', reservoirMeasuredShort(r, ctx));
  measured.title = 'NASA ICESat-2 ATL13 / ATL06 (NSIDC)';
  card.append(measured);

  const svg = opts.compact ? reservoirSparkline(r, 72, 24) : reservoirSparkline(r, 96, 28);
  if (svg) {
    const spark = el('span', 'wl-card-spark');
    spark.setAttribute('role', 'img');
    spark.setAttribute('aria-label', ctx.t('components.reservoirLevels.card.sparkline'));
    setTrustedHtml(spark, trustedHtml(svg, 'miniSparkline builds the SVG from numbers only'));
    card.append(spark);
  }

  const pass = opts.compact ? null : opts.nextPass;
  if (pass && reservoirNextPassExpiresAt(pass) > ctx.nowMs) {
    const next = el('div', 'wl-card-next');
    next.title = reservoirNextPassText(pass, ctx.t, ctx.locale);
    next.append(
      el('span', 'wl-card-next-label', `${ctx.t('components.reservoirLevels.card.crossing')}:`),
      document.createTextNode(` ${reservoirNextPassShort(pass, ctx.t, ctx.locale)}`),
    );
    card.append(next);
  }
  return card;
}

/** "2 of 3 reservoirs beyond seasonal baseline · latest ICESat-2 pass 6 Sep"; wraps only at the separator. */
export function reservoirSummaryLine(reservoirs: readonly ReservoirLevel[], ctx: ReservoirFormatContext): HTMLElement {
  const line = el('p', 'wl-summary');
  const beyond = reservoirs.filter(r => r.status !== 'no_recent_data' && isBeyondSeasonalBaseline(r.seasonalZ)).length;
  line.append(el('span', 'wl-summary-part', ctx.t('components.reservoirLevels.card.summary', { beyond, total: reservoirs.length })));
  const latest = reservoirs.reduce<Date | null>((best, r) => (r.latest && (!best || r.latest.observedAt > best) ? r.latest.observedAt : best), null);
  if (latest) {
    line.append(
      el('span', 'wl-summary-sep', ' · '),
      el('span', 'wl-summary-part', ctx.t('components.reservoirLevels.card.latestPass', { date: formatPassDate(latest, ctx.locale, ctx.nowMs) })),
    );
  }
  return line;
}

/** Hydropower and beyond-baseline reservoirs first, then by name. */
export function sortReservoirCards(reservoirs: readonly ReservoirLevel[]): ReservoirLevel[] {
  return [...reservoirs].sort((a, b) =>
    Number(isBeyondSeasonalBaseline(b.seasonalZ)) - Number(isBeyondSeasonalBaseline(a.seasonalZ))
    || Number(b.tags.includes('hydropower')) - Number(a.tags.includes('hydropower'))
    || a.name.localeCompare(b.name));
}
