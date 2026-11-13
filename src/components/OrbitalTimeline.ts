import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { MatchedAcquisition } from '@/services/orbital/match';
import { zonedClock, type ZonedClock } from '@/services/orbital/local-time';
import {
  EVENT_SOURCES,
  LIVE_RADIUS_KM,
  LIVE_SOURCES,
  type EventSourceId,
  type LiveSourceId,
  type PointContext,
} from '@/services/orbital/point-context';
import { getLocale, t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Passes closer than this share of the width draw as one glyph, so a busy row stays readable. */
const CLUSTER_PCT = 0.4;
const TIP_NAMES = 4;

export const passKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

export type PointContextState = { kind: 'loading' } | { kind: 'loaded'; context: PointContext };

export interface OrbitalTimelineInput {
  lookup: PointPassLookup;
  /** Passes with their archive-resolved tiers once archives answer, else the computed ones. */
  passes: PointPass[];
  acquisitions: MatchedAcquisition[];
  context: PointContextState;
  selectedKey: string | null;
}

type RowId = 'geo' | 'photo' | 'likely' | 'could' | 'overhead';

/** Five fixed rows, one glyph each, the same glyphs that mark these tiers everywhere else. The many "could" passes draw as ticks. */
const ROWS: ReadonlyArray<{ id: RowId; glyph: string; tiers: ReadonlyArray<PassTier['kind']>; dense?: true }> = [
  { id: 'geo', glyph: '○', tiers: ['daily-mosaic'] },
  { id: 'photo', glyph: '◆', tiers: ['confirmed-image'] },
  { id: 'likely', glyph: '◇', tiers: ['likely-imaged'] },
  { id: 'could', glyph: '□', tiers: ['within-reach', 'capability-overhead'], dense: true },
  { id: 'overhead', glyph: '+', tiers: ['passed-overhead', 'opportunity'] },
];

const TIER_LABEL_KEY: Record<PassTier['kind'], string> = {
  'confirmed-image': 'orbitalWatch.tier.confirmed',
  'likely-imaged': 'orbitalWatch.tier.likely',
  'within-reach': 'orbitalWatch.tier.withinReach',
  'capability-overhead': 'orbitalWatch.tier.capabilityOverhead',
  'daily-mosaic': 'orbitalWatch.tier.dailyMosaic',
  'passed-overhead': 'orbitalWatch.tier.passedOverhead',
  opportunity: 'orbitalWatch.tier.opportunity',
};

const EVENT_LABEL_KEY: Record<EventSourceId, string> = {
  conflict: 'orbitalWatch.timeline.source.conflict',
  fires: 'orbitalWatch.timeline.source.fires',
  unrest: 'orbitalWatch.timeline.source.unrest',
  outages: 'orbitalWatch.timeline.source.outages',
};

const LIVE_LABEL_KEY: Record<LiveSourceId, string> = {
  vessels: 'orbitalWatch.timeline.live.vessels',
  'military-flights': 'orbitalWatch.timeline.live.militaryFlights',
  'gps-jamming': 'orbitalWatch.timeline.live.gpsJamming',
};

const formatUtc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const formatHour = (ms: number) => new Date(ms).toISOString().slice(11, 16);

interface ListEntry {
  timeMs: number;
  text: string;
}

function hourlyBins(passes: PointPass[]): Array<{ startMs: number; count: number }> {
  const bins = new Map<number, number>();
  for (const pass of passes) {
    const startMs = Math.floor(pass.timeMs / HOUR_MS) * HOUR_MS;
    bins.set(startMs, (bins.get(startMs) ?? 0) + 1);
  }
  return [...bins].map(([startMs, count]) => ({ startMs, count })).sort((a, b) => a.startMs - b.startMs);
}

/** Where a source's kept history leaves part of the past window uncovered. */
function uncovered(retained: { startMs: number; endMs: number } | null, startMs: number, nowMs: number): Array<[number, number]> {
  const coveredStart = retained ? Math.max(startMs, retained.startMs) : nowMs;
  const coveredEnd = retained ? Math.min(nowMs, retained.endMs) : nowMs;
  if (coveredEnd <= coveredStart) return [[startMs, nowMs]];
  const gaps: Array<[number, number]> = [];
  if (coveredStart > startMs) gaps.push([startMs, coveredStart]);
  if (coveredEnd < nowMs) gaps.push([coveredEnd, nowMs]);
  return gaps;
}

/**
 * The timeline dock: five tier rows over the lookup window in the place's local time, daylight at the point,
 * nearby events on a strip above, and live-only context at the foot. A visually hidden list says the same in text.
 */
export class OrbitalTimeline {
  readonly element: HTMLElement;
  private readonly head = h('header', { className: 'ow-tl-head' });
  private readonly legend = h('ul', { className: 'ow-tl-legend' });
  private readonly plot = h('div', { className: 'ow-tl-plot', 'aria-hidden': 'true' });
  private readonly tip = h('div', { className: 'ow-tl-tip', role: 'tooltip' });
  private readonly foot = h('div', { className: 'ow-tl-foot' });
  private readonly list = h('ol', { className: 'ow-tl-sr' });

  constructor(private readonly onSelect: (key: string) => void) {
    this.tip.hidden = true;
    this.element = h('section', { className: 'ow-timeline' },
      this.head,
      h('div', { className: 'ow-tl-body' }, this.legend, h('div', { className: 'ow-tl-plot-wrap' }, this.plot)),
      this.foot,
      this.tip,
      this.list);
    this.element.addEventListener('click', this.onClick);
    this.plot.addEventListener('pointerover', this.onPointerOver);
    this.plot.addEventListener('pointerleave', this.hideTip);
  }

  update(input: OrbitalTimelineInput): void {
    const { window, nowMs } = input.lookup;
    const context = input.context.kind === 'loaded' ? input.context.context : null;
    const clock = zonedClock(context?.timeZone ?? null, getLocale(), nowMs);
    const when = (ms: number) => `${clock.day(ms)} · ${clock.time(ms)}`;
    const pct = (ms: number) => ((Math.min(Math.max(ms, window.startMs), window.endMs) - window.startMs) / (window.endMs - window.startMs)) * 100;
    const at = (ms: number) => `left:${pct(ms).toFixed(3)}%`;
    const between = (startMs: number, endMs: number) => `left:${pct(startMs).toFixed(3)}%;width:${Math.max(0, pct(endMs) - pct(startMs)).toFixed(3)}%`;
    const count = (n: number) => n.toLocaleString(getLocale());
    const entries: ListEntry[] = [];

    const span = `${t('orbitalWatch.timeline.span', { days: Math.round((nowMs - window.startMs) / DAY_MS), hours: Math.round((window.endMs - nowMs) / HOUR_MS) })} · ${clock.timeZone} · ${clock.abbreviation}`;
    this.element.setAttribute('aria-label', `${t('orbitalWatch.timeline.title')}, ${span}`);
    replaceChildren(this.head,
      h('h3', { className: 'ow-tl-title' }, h('span', { className: 'ow-tl-num' }, '03 / '), t('orbitalWatch.timeline.title')),
      h('span', { className: 'ow-tl-span' }, span),
      h('span', { className: 'ow-tl-daylight-key' }, h('span', { className: 'ow-tl-swatch' }), t('orbitalWatch.timeline.daylightHere')));

    const geostationary = input.lookup.satellites.filter((s) => s.status === 'geostationary' && s.visibility.visible);
    const keys: HTMLElement[] = [h('li', { className: 'ow-tl-key-spacer', 'aria-hidden': 'true' })];
    const rows: HTMLElement[] = [];
    for (const row of ROWS) {
      const passes = input.passes.filter((pass) => row.tiers.includes(pass.tier.kind));
      const label = t(`orbitalWatch.timeline.row.${row.id}`);
      const geoLine = row.id === 'geo' && geostationary.length > 0
        ? h('span', { className: 'ow-tl-geo-line', style: between(window.startMs, window.endMs), dataset: { tip: t('orbitalWatch.timeline.geoLine', { names: geostationary.map((s) => s.name).join(', ') }) } })
        : null;
      keys.push(h('li', { className: 'ow-tl-key', dataset: { row: row.id } },
        h('span', { className: 'ow-tl-glyph', 'aria-hidden': 'true' }, row.glyph),
        h('span', { className: 'ow-tl-key-label' }, label),
        h('span', { className: 'ow-tl-count' }, count(passes.length + (row.id === 'geo' ? geostationary.length : 0)))));
      rows.push(h('div', { className: 'ow-tl-row', dataset: { row: row.id } }, geoLine, ...this.marks(passes, row, input.selectedKey, pct, when)));
      if (row.dense) {
        for (const bin of hourlyBins(passes)) {
          entries.push({ timeMs: bin.startMs, text: t('orbitalWatch.timeline.density', { label, count: bin.count, start: formatUtc(bin.startMs), end: formatHour(bin.startMs + HOUR_MS) }) });
        }
      } else {
        for (const pass of passes) entries.push({ timeMs: pass.timeMs, text: `${t(TIER_LABEL_KEY[pass.tier.kind])}: ${pass.name}, ${formatUtc(pass.timeMs)}` });
      }
    }
    replaceChildren(this.legend, ...keys);

    const eventMarks: HTMLElement[] = [];
    const eventKeys = EVENT_SOURCES.map((id) => {
      const label = t(EVENT_LABEL_KEY[id]);
      const lane = context?.events[id];
      if (!lane || lane.status === 'unavailable') {
        if (lane) entries.push({ timeMs: window.startMs, text: `${label}: ${t('orbitalWatch.timeline.unavailable')}` });
        return h('li', { className: 'ow-tl-event-key', dataset: { source: id, state: lane ? 'unavailable' : 'loading' } },
          h('span', { className: 'ow-tl-dot' }), label, ' ', h('span', { className: 'ow-tl-count' }, lane ? '–' : '…'));
      }
      for (const event of lane.events) {
        const where = event.distanceKm === null ? t('orbitalWatch.timeline.countryWide') : t('orbitalWatch.timeline.away', { km: Math.round(event.distanceKm) });
        eventMarks.push(h('span', { className: 'ow-tl-event', style: at(event.timeMs), dataset: { source: id, tip: `${label} · ${event.label} · ${where} · ${when(event.timeMs)}` } }));
        entries.push({ timeMs: event.timeMs, text: `${label}: ${event.label}, ${formatUtc(event.timeMs)}, ${where}` });
      }
      const gaps = uncovered(lane.retained, window.startMs, nowMs);
      for (const [startMs, endMs] of gaps) {
        entries.push({ timeMs: startMs, text: t('orbitalWatch.timeline.notRetainedSpan', { label, start: formatUtc(startMs), end: formatUtc(endMs) }) });
      }
      const whole = gaps.length === 1 && gaps[0]![0] === window.startMs && gaps[0]![1] === nowMs;
      const kept = whole
        ? t('orbitalWatch.timeline.notRetained')
        : gaps.length > 0 && lane.retained
          ? t('orbitalWatch.timeline.retained', { start: clock.day(Math.max(window.startMs, lane.retained.startMs)), end: clock.day(Math.min(nowMs, lane.retained.endMs)) })
          : null;
      return h('li', { className: 'ow-tl-event-key', dataset: { source: id, state: 'ok' } },
        h('span', { className: 'ow-tl-dot' }), label, ' ', h('span', { className: 'ow-tl-count' }, count(lane.events.length)),
        kept ? h('span', { className: 'ow-tl-retained' }, ` · ${kept}`) : null);
    });

    const midnights = clock.midnights(window.startMs, window.endMs);
    const nowPct = pct(nowMs);
    replaceChildren(this.plot,
      h('div', { className: 'ow-tl-backdrop' },
        ...input.lookup.daylight.map((band) => h('span', { className: 'ow-tl-daylight', style: between(band.startMs, band.endMs) })),
        ...midnights.map((ms) => h('span', { className: 'ow-tl-midnight', style: at(ms) })),
        h('span', { className: 'ow-tl-now', style: at(nowMs) })),
      h('div', { className: 'ow-tl-strip' }, ...eventMarks),
      ...rows,
      h('div', { className: 'ow-tl-axis' },
        ...midnights.filter((ms) => Math.abs(pct(ms) - nowPct) > 4).map((ms) => this.dayLabel(clock, ms, at(ms))),
        h('span', { className: 'ow-tl-now-label', style: at(nowMs) }, t('orbitalWatch.timeline.now'))));
    this.hideTip();

    for (const band of input.lookup.daylight) {
      entries.push({ timeMs: band.startMs, text: t('orbitalWatch.timeline.daylight', { start: formatUtc(band.startMs), end: formatUtc(band.endMs) }) });
    }
    entries.push({ timeMs: nowMs, text: t('orbitalWatch.timeline.nowAt', { time: formatUtc(nowMs) }) });
    entries.sort((a, b) => a.timeMs - b.timeMs);
    replaceChildren(this.list, ...entries.map((entry) => h('li', null, entry.text)));

    replaceChildren(this.foot, h('ul', { className: 'ow-tl-event-keys' }, ...eventKeys), this.renderLive(context));
  }

  private marks(passes: PointPass[], row: (typeof ROWS)[number], selectedKey: string | null, pct: (ms: number) => number, when: (ms: number) => string): HTMLElement[] {
    const groups: PointPass[][] = [];
    for (const pass of [...passes].sort((a, b) => a.timeMs - b.timeMs)) {
      const last = groups[groups.length - 1];
      const joins = !row.dense && last && pct(pass.timeMs) - pct(last[0]!.timeMs) < CLUSTER_PCT
        && (pass.tier.kind === 'opportunity') === (last[0]!.tier.kind === 'opportunity');
      if (joins) last.push(pass);
      else groups.push([pass]);
    }
    return groups.map((group) => {
      const first = group[0]!;
      const tier = t(TIER_LABEL_KEY[first.tier.kind]);
      const tip = group.length === 1
        ? `${first.name} · ${when(first.timeMs)} · ${tier}`
        : [...group.slice(0, TIP_NAMES).map((pass) => `${pass.name} · ${when(pass.timeMs)}`), ...(group.length > TIP_NAMES ? [`+${group.length - TIP_NAMES}`] : []), tier].join('\n');
      const classes = ['ow-tl-mark', row.dense ? 'is-tick' : '', first.tier.kind === 'opportunity' ? 'is-opportunity' : '',
        group.some((pass) => passKey(pass) === selectedKey) ? 'is-selected' : ''];
      return h('span', {
        className: classes.filter(Boolean).join(' '),
        style: `left:${pct(first.timeMs).toFixed(3)}%`,
        dataset: { pass: passKey(first), tier: first.tier.kind, count: String(group.length), tip },
      }, row.dense ? '' : row.glyph);
    });
  }

  private dayLabel(clock: ZonedClock, ms: number, style: string): HTMLElement {
    const { weekday, day, month } = clock.dayParts(ms);
    return h('span', { className: 'ow-tl-day', style },
      h('span', { className: 'ow-tl-weekday' }, weekday), ' ', day, h('span', { className: 'ow-tl-month' }, ` ${month}`));
  }

  private renderLive(context: PointContext | null): HTMLElement | null {
    const items = context ? LIVE_SOURCES.flatMap((id) => {
      const strip = context.live[id];
      if (strip.status !== 'ok') return [];
      const nearest = strip.items[0];
      return [h('li', { dataset: { live: id }, title: nearest ? `${nearest.label} · ${t('orbitalWatch.timeline.away', { km: Math.round(nearest.distanceKm) })}` : '' },
        `${t(LIVE_LABEL_KEY[id])} ${strip.items.length}`)];
    }) : [];
    if (items.length === 0) return null;
    return h('ul', { className: 'ow-now-strip', 'aria-label': `${t('orbitalWatch.timeline.now')}, ${LIVE_RADIUS_KM} km` },
      h('li', { className: 'ow-now-title' }, `${t('orbitalWatch.timeline.now')} · ${LIVE_RADIUS_KM} km`), ...items);
  }

  private readonly onPointerOver = (event: PointerEvent): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!target) return this.hideTip();
    const frame = this.element.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    this.tip.textContent = target.dataset.tip ?? '';
    this.tip.hidden = false;
    const half = this.tip.offsetWidth / 2;
    const x = (target.classList.contains('ow-tl-geo-line') ? event.clientX : box.left + box.width / 2) - frame.left;
    this.tip.style.left = `${Math.min(Math.max(x, half), Math.max(half, frame.width - half))}px`;
    this.tip.style.top = `${box.top - frame.top}px`;
  };

  private readonly hideTip = (): void => {
    this.tip.hidden = true;
  };

  private readonly onClick = (event: MouseEvent): void => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-pass]')?.dataset.pass;
    if (key) this.onSelect(key);
  };
}
