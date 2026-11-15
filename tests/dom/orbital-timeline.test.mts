import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import { daylightSpans, type PointPass } from '@/services/orbital/pass-job';
import { loadPointContext, type EventLane, type LiveStrip, type PointContext } from '@/services/orbital/point-context';
import { OrbitalTimeline, type OrbitalTimelineInput } from '@/components/OrbitalTimeline';
import { setOrbitalDisplayZone } from '@/components/OrbitalWatchPage';

const NOW = Date.UTC(2026, 10, 13, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = { startMs: NOW - 7 * DAY, endMs: NOW + 72 * HOUR };
const point = { lat: 25.2048, lon: 55.2708 };

let nextNorad = 50_000;
function pass(name: string, hoursFromNow: number, tier: PassTier): PointPass {
  return {
    noradId: nextNorad++, name, profileId: 'sentinel-2', category: 'open-optical', time: new Date(NOW + hoursFromNow * HOUR).toISOString(),
    timeMs: NOW + hoursFromNow * HOUR, opportunity: hoursFromNow > 0, groundDistanceKm: 42, side: 'left', direction: 'ascending', elevationDeg: 80,
    azimuthDeg: 90, incidenceDeg: 10, sunElevationDeg: 40, altitudeKm: 700, subSatellite: point, inFootprint: true,
    edgeOfSwath: false, coverage: true, tier, elementsEpochMs: NOW - 2 * HOUR, orbitAgeDays: 0.5,
  };
}

function lookup(passes: PointPass[], at = point): PointPassLookup {
  return {
    point: at, window: WINDOW, nowMs: NOW,
    catalog: { status: 'fresh', fetchedAt: NOW - HOUR, inventoryVersion: 'test' },
    passes, satellites: [], daylight: daylightSpans(at, WINDOW), computedOn: 'worker',
  };
}

const ok = (events: Extract<EventLane, { status: 'ok' }>['events'] = [], retained: { startMs: number; endMs: number } | null = { startMs: WINDOW.startMs, endMs: NOW }): EventLane =>
  ({ status: 'ok', events, retained });
const liveOk = (labels: string[] = []): LiveStrip => ({ status: 'ok', items: labels.map((label, i) => ({ id: label, label, distanceKm: 10 + i })) });

function context(over: { events?: Partial<PointContext['events']>; live?: Partial<PointContext['live']> } = {}): PointContext {
  return {
    events: { conflict: ok(), fires: ok(), unrest: ok(), outages: ok(), ...over.events },
    live: { vessels: liveOk(), 'military-flights': liveOk(), 'gps-jamming': liveOk(), ...over.live },
  };
}

const onSelect = vi.fn();

function mounted(passes: PointPass[], ctx: PointContext | null, options: { at?: typeof point; selectedKey?: string; found?: PointPassLookup } = {}): OrbitalTimeline {
  const dock = new OrbitalTimeline(onSelect);
  document.body.append(dock.element);
  setOrbitalDisplayZone('Asia/Dubai', 'GST');
  dock.update({
    lookup: options.found ?? lookup(passes, options.at),
    passes,
    acquisitions: [],
    context: ctx ? { kind: 'loaded', context: ctx } : { kind: 'loading' },
    selectedKey: options.selectedKey ?? null,
  });
  return dock;
}

const timeline = () => document.querySelector<HTMLElement>('.ow-timeline')!;
const row = (id: string) => timeline().querySelector<HTMLElement>(`.ow-tl-row[data-row="${id}"]`)!;
const legendKey = (id: string) => timeline().querySelector<HTMLElement>(`.ow-tl-key[data-row="${id}"]`)!;
const eventKey = (id: string) => timeline().querySelector<HTMLElement>(`.ow-tl-event-key[data-source="${id}"]`)!;
const leftPct = (el: Element) => Number((el as HTMLElement).style.left.replace('%', ''));
const pctOf = (ms: number) => ((ms - WINDOW.startMs) / (WINDOW.endMs - WINDOW.startMs)) * 100;
const nowPct = () => leftPct(timeline().querySelector('.ow-tl-now')!);
const listText = () => timeline().querySelector('.ow-tl-sr')!.textContent ?? '';
/** What a sighted user reads: everything but the visually hidden list. */
const visibleText = () => {
  const copy = timeline().cloneNode(true) as HTMLElement;
  copy.querySelector('.ow-tl-sr')!.remove();
  return copy.textContent ?? '';
};
const keyOf = (p: PointPass) => `${p.noradId}:${p.timeMs}`;

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => setOrbitalDisplayZone('UTC', 'UTC'));

describe('orbital timeline dock', () => {
  it('draws three lanes, images, events and passes, each with a label and a count, zero included', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], context());
    const keys = [...timeline().querySelectorAll<HTMLElement>('.ow-tl-key')].map((key) => [
      key.dataset.row, key.querySelector('.ow-tl-key-label')!.textContent, key.querySelector('.ow-tl-count')!.textContent]);
    expect(keys).toEqual([['images', 'Images', '1'], ['events', 'Events', '0'], ['passes', 'Passes', '0']]);
    expect([...timeline().querySelectorAll<HTMLElement>('.ow-tl-row')].map((r) => r.dataset.row)).toEqual(['images', 'events', 'passes']);
  });

  it('reads in the place\'s local time: zone in the header, local day labels and a NOW marker', () => {
    mounted([], context());
    expect(timeline().querySelector('.ow-tl-head')!.textContent).toContain('7 d back · 72 h ahead · Asia/Dubai · UTC+4');
    const firstDay = timeline().querySelector<HTMLElement>('.ow-tl-day')!;
    expect(firstDay.textContent).toBe('Sat 7 Nov');
    expect(leftPct(firstDay)).toBeCloseTo(pctOf(Date.UTC(2026, 10, 7, 8)), 2);
    expect(timeline().querySelector('.ow-tl-flags .ow-tl-now-label')!.textContent).toBe('now');
    expect(nowPct()).toBeCloseTo(pctOf(NOW), 2);
  });

  it('labels every whole day in the window, today and tomorrow included, with NOW on its own flag row', () => {
    mounted([], context());
    const days = [...timeline().querySelectorAll('.ow-tl-axis .ow-tl-day')].map((day) => day.textContent);
    expect(days).toEqual(['Sat 7 Nov', 'Sun 8 Nov', 'Mon 9 Nov', 'Tue 10 Nov', 'Wed 11 Nov', 'Thu 12 Nov', 'Fri 13 Nov', 'Sat 14 Nov', 'Sun 15 Nov', 'Mon 16 Nov']);
    expect(timeline().querySelector('.ow-tl-axis .ow-tl-now-label')).toBeNull();
  });

  it('draws in-range and in-reach passes as hourly density bars, and confirmed images as glyphs', () => {
    const dense = [pass('A', -10.2, { kind: 'within-reach' }), pass('B', -10.6, { kind: 'passed-overhead' }), pass('C', -40, { kind: 'within-reach' }), pass('D', -10.4, { kind: 'capability-overhead' })];
    const photo = pass('SENTINEL-2B', -30, { kind: 'confirmed-image' });
    mounted([...dense, photo], context());
    const mark = row('images').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(mark.textContent).toBe('◆');
    expect(leftPct(mark)).toBeCloseTo(pctOf(photo.timeMs), 2);
    expect(row('passes').querySelectorAll('.ow-tl-mark'), 'dense tiers draw no glyphs').toHaveLength(0);
    const bars = [...row('passes').querySelectorAll<HTMLElement>('.ow-tl-bar')];
    expect(bars.map((bar) => bar.dataset.count)).toEqual(['1', '3']);
    expect(leftPct(bars[1]!)).toBeCloseTo(pctOf(Math.floor((NOW - 10.2 * HOUR) / HOUR) * HOUR), 2);
    expect(bars[1]!.dataset.tip).toBe('3 passes from 2026-11-13 01:00 UTC · B, D, A');
    expect(listText()).toContain('Passes, 2026-11-13 01:00 UTC to 02:00: 3');
    expect(listText()).toContain('confirmed: SENTINEL-2B, 2026-11-12 06:00 UTC');
  });

  it('merges likely passes closer than a glyph into one glyph with a ×n count', () => {
    mounted([pass('A', -10.2, { kind: 'likely-imaged' }), pass('B', -10.25, { kind: 'likely-imaged' }), pass('C', -40, { kind: 'likely-imaged' })], context());
    const marks = [...row('passes').querySelectorAll<HTMLElement>('.ow-tl-mark')];
    expect(marks.map((m) => [m.textContent, m.dataset.count])).toEqual([['◇', '1'], ['◇', '2']]);
    expect(marks[1]!.dataset.tip!.split('\n')[0]).toBe('×2 · likely');
  });

  it('reaches every mark, bar and event by keyboard, and selects a pass with Enter or Space', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    const near = pass('A', -10.2, { kind: 'within-reach' });
    mounted([likely, near], context({ events: { fires: ok([{ id: 'f1', timeMs: NOW - 5 * HOUR, label: '41 MW', distanceKm: 3 }]) } }));
    const focusable = [...timeline().querySelectorAll<HTMLElement>('.ow-tl-mark, .ow-tl-bar, .ow-tl-event')];
    expect(focusable).toHaveLength(3);
    for (const el of focusable) {
      expect(el.tabIndex).toBe(0);
      expect(el.getAttribute('aria-label')).toBeTruthy();
    }
    expect(timeline().querySelector('.ow-tl-plot')!.getAttribute('aria-hidden')).toBeNull();
    row('passes').querySelector<HTMLElement>('.ow-tl-bar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith(keyOf(near));
    row('passes').querySelector<HTMLElement>('.ow-tl-mark')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith(keyOf(likely));
    const event = timeline().querySelector<HTMLElement>('.ow-tl-event')!;
    event.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(timeline().querySelector<HTMLElement>('.ow-tl-tip')!.hidden, 'focus shows the tooltip as hover does').toBe(false);
  });

  it('counts geostationary satellites in view on the images lane', () => {
    const geo = { noradId: 1, name: 'METEOSAT-9', profileId: 'seviri', status: 'geostationary', visibility: { visible: true } } as unknown as PointPassLookup['satellites'][number];
    const terra = pass('TERRA', -20, { kind: 'daily-mosaic' });
    mounted([terra], context(), { found: { ...lookup([terra]), satellites: [geo] } });
    expect(legendKey('images').querySelector('.ow-tl-count')!.textContent).toBe('2');
    expect(row('images').querySelector<HTMLElement>('.ow-tl-geo-line')!.dataset.tip).toBe('Geostationary view: METEOSAT-9');
  });

  it('keeps keyboard focus on a mark when the timeline updates', () => {
    const p = pass('SENTINEL-2A', -20, { kind: 'likely-imaged' });
    const dock = mounted([p], context());
    const mark = timeline().querySelector<HTMLElement>(`[data-pass="${keyOf(p)}"]`)!;
    mark.focus();
    dock.update({ lookup: lookup([p]), passes: [p], acquisitions: [], context: { kind: 'loaded', context: context() }, selectedKey: null });
    expect(document.activeElement).not.toBe(mark);
    expect((document.activeElement as HTMLElement).dataset.pass).toBe(keyOf(p));
  });

  it('puts an archive image with no computed pass on the images lane and counts it', () => {
    const dock = new OrbitalTimeline(onSelect);
    document.body.append(dock.element);
    setOrbitalDisplayZone('Asia/Dubai', 'GST');
    const image = { startMs: NOW - 30 * HOUR, platform: 'sentinel-2c', pass: null } as unknown as OrbitalTimelineInput['acquisitions'][number];
    dock.update({ lookup: lookup([]), passes: [], acquisitions: [image], context: { kind: 'loaded', context: context() }, selectedKey: null });
    expect(legendKey('images').querySelector('.ow-tl-count')!.textContent).toBe('1');
    const mark = row('images').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(leftPct(mark)).toBeCloseTo(pctOf(image.startMs), 2);
    expect(mark.dataset.tip).toBe('SENTINEL-2C · Thu, Nov 12 · 10:00 · image without computed pass');
    expect(mark.tabIndex, 'reachable by keyboard like every other mark').toBe(0);
    expect(mark.getAttribute('aria-label')).toBe(mark.dataset.tip);
    expect(listText()).toContain('image without computed pass: SENTINEL-2C, 2026-11-12 06:00 UTC');
  });

  it('shows satellite, local time and tier in a tooltip on hover, and highlights the glyph', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], context());
    const tip = timeline().querySelector<HTMLElement>('.ow-tl-tip')!;
    expect(tip.hidden).toBe(true);
    const mark = row('images').querySelector<HTMLElement>('.ow-tl-mark')!;
    mark.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe('SENTINEL-2B · Thu, Nov 12 · 10:00 · confirmed');
    expect(mark.classList.contains('is-hover')).toBe(true);
    expect(tip.style.getPropertyValue('--tip-arrow')).toMatch(/px$/);
    timeline().querySelector('.ow-tl-plot')!.dispatchEvent(new Event('pointerleave'));
    expect(mark.classList.contains('is-hover')).toBe(false);
  });

  it('keeps the tooltip inside the visible part of a sideways-scrolled dock', () => {
    const dock = document.createElement('div');
    dock.getBoundingClientRect = () => ({ left: 0, right: 390, top: 0, bottom: 110, width: 390, height: 110 } as DOMRect);
    const timelineDock = new OrbitalTimeline(onSelect);
    dock.append(timelineDock.element);
    document.body.append(dock);
    timelineDock.update({ lookup: lookup([]), passes: [pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], acquisitions: [], context: { kind: 'loading' }, selectedKey: null });
    timelineDock.element.getBoundingClientRect = () => ({ left: -200, right: 800, top: 0, bottom: 110, width: 1000, height: 110 } as DOMRect);
    dock.querySelector<HTMLElement>('.ow-tl-plot')!.getBoundingClientRect = () => ({ left: -100, right: 800, top: 10, bottom: 100, width: 900, height: 90 } as DOMRect);
    const mark = dock.querySelector<HTMLElement>('.ow-tl-row[data-row="images"] .ow-tl-mark')!;
    mark.getBoundingClientRect = () => ({ left: 370, right: 380, top: 60, bottom: 70, width: 10, height: 10 } as DOMRect);
    const tip = dock.querySelector<HTMLElement>('.ow-tl-tip')!;
    Object.defineProperty(tip, 'offsetWidth', { value: 200 });
    Object.defineProperty(tip, 'offsetHeight', { value: 20 });
    mark.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(tip.style.maxWidth).toBe('382px');
    const left = parseFloat(tip.style.left) - 200;
    expect(left - 100).toBeGreaterThanOrEqual(0);
    expect(left + 100).toBeLessThanOrEqual(390);
    expect(parseFloat(tip.style.getPropertyValue('--tip-arrow'))).toBeGreaterThan(100);
  });

  it('flips an event tooltip below the lane so it never covers the dock header', () => {
    const at = NOW - 2 * DAY;
    mounted([], context({ events: { conflict: ok([{ id: 'c1', timeMs: at, label: 'A – B', distanceKm: 2 }], { startMs: at, endMs: NOW }) } }));
    const rect = (top: number, bottom: number, left = 0, right = 640) => (() => ({ left, right, top, bottom, width: right - left, height: bottom - top }) as DOMRect);
    const dock = timeline();
    dock.getBoundingClientRect = rect(0, 270);
    dock.parentElement!.getBoundingClientRect = rect(0, 270);
    dock.querySelector<HTMLElement>('.ow-tl-head')!.getBoundingClientRect = rect(0, 24);
    dock.querySelector<HTMLElement>('.ow-tl-plot')!.getBoundingClientRect = rect(30, 160, 130, 630);
    const mark = dock.querySelector<HTMLElement>('.ow-tl-strip .ow-tl-event')!;
    mark.getBoundingClientRect = rect(60, 68, 330, 338);
    const tip = dock.querySelector<HTMLElement>('.ow-tl-tip')!;
    Object.defineProperty(tip, 'offsetWidth', { value: 480 });
    Object.defineProperty(tip, 'offsetHeight', { value: 40 });
    mark.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(tip.dataset.place).toBe('below');
    expect(parseFloat(tip.style.top) + 6).toBeGreaterThanOrEqual(68);
  });

  it('opens a dock narrower than the timeline scrolled so NOW sits about 70% across', async () => {
    const dock = document.createElement('div');
    Object.defineProperty(dock, 'scrollWidth', { value: 1000 });
    Object.defineProperty(dock, 'clientWidth', { value: 400 });
    const timelineDock = new OrbitalTimeline(onSelect);
    dock.append(timelineDock.element);
    document.body.append(dock);
    timelineDock.update({ lookup: lookup([]), passes: [], acquisitions: [], context: { kind: 'loading' }, selectedKey: null });
    const now = dock.querySelector<HTMLElement>('.ow-tl-now')!;
    now.getBoundingClientRect = () => ({ left: 900 } as DOMRect);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(dock.scrollLeft).toBe(900 - 400 * 0.7);
  });

  it('clicking a glyph hands its pass to the selection, and marks the selected glyph', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    const other = pass('LANDSAT 9', -60, { kind: 'likely-imaged' });
    mounted([likely, other], context());
    row('passes').querySelector<HTMLElement>(`[data-pass="${keyOf(likely)}"]`)!.click();
    expect(onSelect).toHaveBeenCalledWith(keyOf(likely));
    document.body.replaceChildren();
    mounted([likely, other], context(), { selectedKey: keyOf(likely) });
    expect([...row('passes').querySelectorAll('.is-selected')].map((el) => el.getAttribute('data-pass'))).toEqual([keyOf(likely)]);
  });

  it('draws an upcoming pass right of NOW on the passes lane, styled as an opportunity', () => {
    const soon = pass('SENTINEL-1C', 5, { kind: 'opportunity' });
    mounted([soon], context());
    const mark = row('passes').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(mark.classList.contains('is-opportunity')).toBe(true);
    expect(leftPct(mark)).toBeGreaterThan(nowPct());
  });

  it('puts a fire 3 km away yesterday on the events lane at its time, with its category legend', () => {
    const at = NOW - 20 * HOUR;
    mounted([], context({ events: { fires: ok([{ id: 'f1', timeMs: at, label: '41 MW', distanceKm: 3 }], { startMs: WINDOW.startMs, endMs: NOW }) } }));
    const mark = row('events').querySelector<HTMLElement>('.ow-tl-event[data-source="fires"]')!;
    expect(leftPct(mark)).toBeCloseTo(pctOf(at), 2);
    expect(mark.dataset.tip).toBe('Fire · 41 MW · 3 km · Thu, Nov 12 · 20:00');
    expect(eventKey('fires').textContent).toBe('Fire 1');
    expect(legendKey('events').querySelector('.ow-tl-count')!.textContent).toBe('1');
    expect(listText()).toContain('Fire: 41 MW, 2026-11-12 16:00 UTC, 3 km');
  });

  it('places an outage by its distance, and marks one with no location as country-wide', () => {
    mounted([], context({ events: { outages: ok([{ id: 'o1', timeMs: NOW - DAY, label: 'Mobile data', distanceKm: 12 }, { id: 'o2', timeMs: NOW - 2 * DAY, label: 'National', distanceKm: null }]) } }));
    const tips = [...row('events').querySelectorAll<HTMLElement>('.ow-tl-event[data-source="outages"]')].map((m) => m.dataset.tip);
    expect(tips[0]).toContain('Mobile data · 12 km');
    expect(tips[1]).toContain('National · whole country');
  });

  it('says how far back a feed keeps history instead of drawing hatched gaps', () => {
    mounted([], context({ events: { fires: ok([], { startMs: Date.UTC(2026, 10, 12), endMs: NOW }) } }));
    expect(eventKey('fires').querySelector('.ow-tl-retained')!.textContent).toBe(' · history Thu, Nov 12 to Fri, Nov 13');
    expect(listText()).toContain('Fire: feed has no history 2026-11-06 12:00 UTC to 2026-11-12 00:00 UTC');
  });

  it('marks conflict history after its newest event as having no data up to now', () => {
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: NOW - 3 * DAY }) } }));
    expect(eventKey('conflict').querySelector('.ow-tl-retained')!.textContent).toBe(' · history Fri, Nov 6 to Tue, Nov 10');
    expect(listText()).toContain('Conflict: feed has no history 2026-11-10 12:00 UTC to 2026-11-13 12:00 UTC');
  });

  it('says the week has no history when the conflict feed ends before the window starts', () => {
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: NOW - 30 * DAY }) } }));
    expect(eventKey('conflict').querySelector('.ow-tl-retained')!.textContent).toBe(' · feed keeps no history');
  });

  it('shows a healthy feed that answered with nothing as a quiet zero, never as a gap', () => {
    mounted([], context({ events: { outages: ok([], null) } }));
    expect(eventKey('outages').textContent).toBe('Outage 0');
    expect(eventKey('outages').querySelector('.ow-tl-retained')).toBeNull();
    expect(listText()).not.toContain('Outage: feed has no history');
    expect(timeline().textContent).not.toMatch(/not retained/i);
  });

  it('never says "no history" beside a counted event when the feed holds that one event', () => {
    const at = NOW - 2 * DAY;
    mounted([], context({ events: { conflict: ok([{ id: 'c1', timeMs: at, label: 'A – B', distanceKm: 2 }], { startMs: at, endMs: at }) } }));
    expect(eventKey('conflict').textContent).toBe('Conflict 1 · history Wed, Nov 11 only');
    expect(eventKey('conflict').textContent).not.toMatch(/no history/);
  });

  it('keeps a failed source quiet in the legend and still draws the passes', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], context({ events: { unrest: { status: 'unavailable' } }, live: { 'gps-jamming': { status: 'unavailable' } } }));
    expect(eventKey('unrest').dataset.state).toBe('unavailable');
    expect(eventKey('unrest').querySelector('.ow-tl-count')!.textContent).toBe('–');
    expect(visibleText()).not.toMatch(/unavailable/i);
    expect(listText()).toContain('Unrest: unavailable');
    expect(row('passes').querySelectorAll('.ow-tl-mark')).toHaveLength(1);
    expect(timeline().querySelector('[data-live="gps-jamming"]')).toBeNull();
  });

  it('shows the event legend as loading until the context arrives, with passes already drawn', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], null);
    expect(eventKey('fires').dataset.state).toBe('loading');
    expect(eventKey('fires').querySelector('.ow-tl-count')!.textContent).toBe('…');
    expect(legendKey('events').querySelector('.ow-tl-count')!.textContent).toBe('…');
    expect(row('passes').querySelectorAll('.ow-tl-mark')).toHaveLength(1);
  });

  it('shows shipping and GPS-jamming context only in the now strip', () => {
    mounted([], context({ live: { vessels: liveOk(['Strait of Hormuz']), 'gps-jamming': liveOk(['38%']) } }));
    const strip = timeline().querySelector('.ow-now-strip')!;
    const vessels = strip.querySelector<HTMLElement>('[data-live="vessels"]')!;
    expect(vessels.textContent).toBe('Shipping 1');
    expect(vessels.title).toBe('Strait of Hormuz · 10 km');
    expect(strip.querySelector('[data-live="gps-jamming"]')!.textContent).toBe('GPS jamming 1');
    expect(timeline().querySelector('.ow-tl-plot')!.textContent).not.toMatch(/Hormuz|38%/);
    expect(listText()).not.toMatch(/Hormuz|38%/);
  });

  it('has no visible raw list of passes, and says everything in a hidden list for screen readers', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], context());
    expect(timeline().querySelector('details, .ow-tl-list')).toBeNull();
    expect(listText()).toContain('likely: SENTINEL-2B, 2026-11-12 06:00 UTC');
    expect(listText()).toContain('Now: 2026-11-13 12:00 UTC');
  });

  it('draws one unbroken daylight band for a polar point in continuous daylight', () => {
    const june = Date.UTC(2026, 5, 21);
    const polar = { lat: 80, lon: 15 };
    const window = { startMs: june - 7 * DAY, endMs: june + 72 * HOUR };
    const found = { ...lookup([], polar), window, nowMs: june, daylight: daylightSpans(polar, window) };
    mounted([], context(), { found });
    const bands = timeline().querySelectorAll<HTMLElement>('.ow-tl-daylight');
    expect(bands).toHaveLength(1);
    expect(bands[0]!.style.left).toBe('0.000%');
    expect(bands[0]!.style.width).toBe('100.000%');
  });
});

describe('point context requests', () => {
  it('never carry the exact point', async () => {
    const exact = { lat: 25.2049, lon: 55.2708 };
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url} ${String(init?.body ?? '')}`);
      return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    }));
    const result = await loadPointContext(exact, WINDOW, NOW);
    expect(Object.keys(result.events)).toEqual(['conflict', 'fires', 'unrest', 'outages']);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/25\.2|55\.27/);
    }
  });
});

describe('timeline zone', () => {
  it('reads its labels in the sheet display zone when none is injected', () => {
    setOrbitalDisplayZone('Asia/Dubai', 'GST');
    const dock = new OrbitalTimeline(vi.fn());
    document.body.append(dock.element);
    dock.update({ lookup: lookup([]), passes: [], acquisitions: [], context: { kind: 'loading' }, selectedKey: null });
    expect(dock.element.querySelector('.ow-tl-head')!.textContent).toContain('Asia/Dubai · UTC+4');
  });
});
