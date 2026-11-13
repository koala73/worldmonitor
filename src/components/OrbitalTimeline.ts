import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { MatchedAcquisition } from '@/services/orbital/match';
import {
  EVENT_SOURCES,
  LIVE_RADIUS_KM,
  LIVE_SOURCES,
  type EventLane,
  type EventSourceId,
  type LiveSourceId,
  type LiveStrip,
  type PointContext,
} from '@/services/orbital/point-context';
import { t } from '@/services/i18n';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

type PassLaneId = 'confirmed' | 'likely' | 'opportunity' | 'inRange' | 'passed';

/** Rare, decisive passes draw as marks; the many in-range and overhead passes draw as hourly density. */
const PASS_LANES: ReadonlyArray<{ id: PassLaneId; tiers: ReadonlyArray<PassTier['kind']>; draw: 'marks' | 'density'; labelKey: string }> = [
  { id: 'confirmed', tiers: ['confirmed-image'], draw: 'marks', labelKey: 'orbitalWatch.tier.confirmed' },
  { id: 'likely', tiers: ['likely-imaged'], draw: 'marks', labelKey: 'orbitalWatch.tier.likely' },
  { id: 'opportunity', tiers: ['opportunity'], draw: 'marks', labelKey: 'orbitalWatch.tier.opportunity' },
  { id: 'inRange', tiers: ['within-reach', 'capability-overhead', 'daily-mosaic'], draw: 'density', labelKey: 'orbitalWatch.inRange' },
  { id: 'passed', tiers: ['passed-overhead'], draw: 'density', labelKey: 'orbitalWatch.tier.passedOverhead' },
];

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
  node: HTMLElement;
}

interface HourBin {
  startMs: number;
  count: number;
}

function hourlyBins(passes: PointPass[]): HourBin[] {
  const bins = new Map<number, number>();
  for (const pass of passes) {
    const startMs = Math.floor(pass.timeMs / HOUR_MS) * HOUR_MS;
    bins.set(startMs, (bins.get(startMs) ?? 0) + 1);
  }
  return [...bins].map(([startMs, count]) => ({ startMs, count })).sort((a, b) => a.startMs - b.startMs);
}

/** Pass, image and event lanes over the lookup window, drawn against daylight at the point, with a list that says the same. */
export class OrbitalTimeline {
  readonly element: HTMLElement;
  private readonly chart: HTMLElement;
  private readonly now: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly onSelect: (key: string) => void) {
    this.chart = h('div', { className: 'ow-tl-chart', 'aria-hidden': 'true' });
    this.now = h('div', { className: 'ow-now-strip' });
    this.list = h('ol', { className: 'ow-tl-list' });
    this.element = h('section', { className: 'ow-timeline', 'aria-label': t('orbitalWatch.timeline.heading') },
      h('h3', { className: 'ow-tl-title' }, t('orbitalWatch.timeline.heading')),
      this.chart,
      h('details', { className: 'ow-tl-list-wrap' }, h('summary', null, t('orbitalWatch.timeline.asList')), this.list),
      this.now);
    this.element.addEventListener('click', this.onClick);
  }

  update(input: OrbitalTimelineInput): void {
    const { window } = input.lookup;
    const pct = (ms: number) => ((Math.min(Math.max(ms, window.startMs), window.endMs) - window.startMs) / (window.endMs - window.startMs)) * 100;
    const at = (ms: number) => `left:${pct(ms).toFixed(3)}%`;
    const between = (startMs: number, endMs: number) => `left:${pct(startMs).toFixed(3)}%;width:${Math.max(0, pct(endMs) - pct(startMs)).toFixed(3)}%`;
    const entries: ListEntry[] = [];
    const labels: HTMLElement[] = [];
    const tracks: HTMLElement[] = [];
    const lane = (id: string, label: string, marks: DomChild[], state?: string) => {
      labels.push(h('div', { className: 'ow-tl-label', title: label, dataset: { lane: id } }, label));
      tracks.push(h('div', { className: 'ow-tl-track', dataset: { lane: id, ...(state ? { state } : {}) } }, ...marks));
    };

    for (const spec of PASS_LANES) {
      const passes = input.passes.filter((pass) => spec.tiers.includes(pass.tier.kind));
      const label = t(spec.labelKey);
      if (spec.draw === 'marks') {
        lane(spec.id, label, passes.map((pass) => this.passMark(pass, input.selectedKey, at(pass.timeMs))));
        for (const pass of passes) entries.push({ timeMs: pass.timeMs, node: this.passEntry(pass, label, input.selectedKey) });
        continue;
      }
      const bins = hourlyBins(passes);
      const peak = Math.max(1, ...bins.map((bin) => bin.count));
      lane(spec.id, label, bins.map((bin) => h('span', {
        className: 'ow-tl-bin',
        style: `${between(bin.startMs, bin.startMs + HOUR_MS)};opacity:${(0.25 + 0.75 * (bin.count / peak)).toFixed(2)}`,
        dataset: { count: String(bin.count) },
      })));
      for (const bin of bins) {
        entries.push({ timeMs: bin.startMs, node: h('li', { dataset: { lane: spec.id } },
          t('orbitalWatch.timeline.density', { label, count: bin.count, start: formatUtc(bin.startMs), end: formatHour(bin.startMs + HOUR_MS) })) });
      }
    }

    const images = input.acquisitions;
    const imageLabel = t('orbitalWatch.timeline.images');
    lane('images', imageLabel, images.map((acquisition) => {
      const key = acquisition.pass ? passKey(acquisition.pass) : null;
      return h('span', { className: `ow-tl-mark ow-tl-image${key && key === input.selectedKey ? ' is-selected' : ''}`, style: at(acquisition.startMs), dataset: key ? { pass: key } : {} });
    }));
    for (const acquisition of images) {
      entries.push({ timeMs: acquisition.startMs, node: h('li', { dataset: { lane: 'images' } }, `${imageLabel}: ${acquisition.platform.toUpperCase()}, ${formatUtc(acquisition.startMs)}`) });
    }

    for (const id of EVENT_SOURCES) this.eventLane(id, input, lane, entries, between, at);

    const { nowMs } = input.lookup;
    const daylight = input.lookup.daylight.map((span) => h('span', { className: 'ow-tl-daylight', style: between(span.startMs, span.endMs) }));
    for (const span of input.lookup.daylight) {
      entries.push({ timeMs: span.startMs, node: h('li', { dataset: { lane: 'daylight' } }, t('orbitalWatch.timeline.daylight', { start: formatUtc(span.startMs), end: formatUtc(span.endMs) })) });
    }
    const days: HTMLElement[] = [];
    for (let day = Math.ceil(window.startMs / DAY_MS) * DAY_MS; day < window.endMs; day += DAY_MS) {
      days.push(h('span', { className: 'ow-tl-day', style: at(day) }, new Date(day).toISOString().slice(8, 10)));
    }
    replaceChildren(this.chart,
      h('div', { className: 'ow-tl-labels' }, ...labels),
      h('div', { className: 'ow-tl-tracks' },
        h('div', { className: 'ow-tl-backdrop' }, ...daylight, ...days, h('span', { className: 'ow-tl-now', style: at(nowMs) }, t('orbitalWatch.timeline.now'))),
        ...tracks));

    entries.push({ timeMs: nowMs, node: h('li', { className: 'ow-tl-list-now', dataset: { lane: 'now' } }, t('orbitalWatch.timeline.nowAt', { time: formatUtc(nowMs) })) });
    entries.sort((a, b) => a.timeMs - b.timeMs);
    replaceChildren(this.list, ...entries.map((entry) => entry.node));
    this.renderNow(input.context);
  }

  private passMark(pass: PointPass, selectedKey: string | null, style: string): HTMLElement {
    const key = passKey(pass);
    const future = pass.tier.kind === 'opportunity';
    return h('span', {
      className: `ow-tl-mark${future ? ' is-opportunity' : ''}${key === selectedKey ? ' is-selected' : ''}`,
      style,
      title: `${pass.name} ${formatUtc(pass.timeMs)}`,
      dataset: { pass: key, tier: pass.tier.kind },
    });
  }

  private passEntry(pass: PointPass, label: string, selectedKey: string | null): HTMLElement {
    const key = passKey(pass);
    return h('li', { dataset: { lane: pass.tier.kind } },
      h('button', { type: 'button', className: 'ow-tl-select', 'aria-pressed': String(key === selectedKey), dataset: { pass: key } },
        `${label}: ${pass.name}, ${formatUtc(pass.timeMs)}`));
  }

  private eventLane(
    id: EventSourceId,
    input: OrbitalTimelineInput,
    lane: (id: string, label: string, marks: DomChild[], state?: string) => void,
    entries: ListEntry[],
    between: (startMs: number, endMs: number) => string,
    at: (ms: number) => string,
  ): void {
    const label = t(EVENT_LABEL_KEY[id]);
    const { window, nowMs } = input.lookup;
    const state: EventLane | null = input.context.kind === 'loaded' ? input.context.context.events[id] : null;
    if (!state || state.status === 'unavailable') {
      const text = state ? t('orbitalWatch.timeline.unavailable') : t('orbitalWatch.timeline.loading');
      lane(id, label, [h('span', { className: 'ow-tl-lane-note' }, text)], state ? 'unavailable' : 'loading');
      if (state) entries.push({ timeMs: window.startMs, node: h('li', { dataset: { lane: id } }, `${label}: ${text}`) });
      return;
    }
    const coveredStart = state.retained ? Math.max(window.startMs, state.retained.startMs) : nowMs;
    const coveredEnd = state.retained ? Math.min(nowMs, state.retained.endMs) : nowMs;
    const gaps: Array<[number, number]> = [];
    if (coveredEnd <= coveredStart) gaps.push([window.startMs, nowMs]);
    else {
      if (coveredStart > window.startMs) gaps.push([window.startMs, coveredStart]);
      if (coveredEnd < nowMs) gaps.push([coveredEnd, nowMs]);
    }
    const notRetained = t('orbitalWatch.timeline.notRetained');
    lane(id, label, [
      ...gaps.map(([startMs, endMs]) => h('span', { className: 'ow-tl-not-retained', style: between(startMs, endMs), title: notRetained })),
      ...state.events.map((event) => h('span', { className: 'ow-tl-event', style: at(event.timeMs), title: event.label })),
    ]);
    for (const [startMs, endMs] of gaps) {
      entries.push({ timeMs: startMs, node: h('li', { className: 'ow-tl-list-gap', dataset: { lane: id } },
        t('orbitalWatch.timeline.notRetainedSpan', { label, start: formatUtc(startMs), end: formatUtc(endMs) })) });
    }
    for (const event of state.events) {
      const where = event.distanceKm === null ? t('orbitalWatch.timeline.countryWide') : t('orbitalWatch.row.distance', { km: Math.round(event.distanceKm) });
      entries.push({ timeMs: event.timeMs, node: h('li', { dataset: { lane: id } }, `${label}: ${event.label}, ${formatUtc(event.timeMs)}, ${where}`) });
    }
  }

  private renderNow(context: PointContextState): void {
    const rows = LIVE_SOURCES.map((id) => {
      const strip: LiveStrip | null = context.kind === 'loaded' ? context.context.live[id] : null;
      const text = !strip
        ? t('orbitalWatch.timeline.loading')
        : strip.status === 'unavailable'
          ? t('orbitalWatch.timeline.unavailable')
          : strip.items.length === 0
            ? t('orbitalWatch.timeline.liveNone', { km: LIVE_RADIUS_KM })
            : t('orbitalWatch.timeline.liveCount', { count: strip.items.length, km: LIVE_RADIUS_KM, nearest: strip.items[0]!.label });
      return h('li', { dataset: { live: id, state: strip ? strip.status : 'loading' } },
        h('span', { className: 'ow-now-label' }, t(LIVE_LABEL_KEY[id])), ' ', h('span', null, text));
    });
    replaceChildren(this.now, h('h4', { className: 'ow-now-title' }, t('orbitalWatch.timeline.nowTitle')), h('ul', null, ...rows));
  }

  private readonly onClick = (event: MouseEvent): void => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-pass]')?.dataset.pass;
    if (key) this.onSelect(key);
  };
}
