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
    timeMs: NOW + hoursFromNow * HOUR, opportunity: hoursFromNow > 0, groundDistanceKm: 42, side: 'left', elevationDeg: 80,
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
  it('always shows the five tier rows with a glyph, a whole label and a count, zero included', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], context());
    const keys = [...timeline().querySelectorAll<HTMLElement>('.ow-tl-key')].map((key) => [
      key.querySelector('.ow-tl-glyph')!.textContent, key.querySelector('.ow-tl-key-label')!.textContent, key.querySelector('.ow-tl-count')!.textContent]);
    expect(keys).toEqual([['○', 'Geo', '0'], ['◆', 'Photo', '1'], ['◇', 'Likely', '0'], ['□', 'Could', '0'], ['+', 'Overhead', '0']]);
    expect(timeline().querySelectorAll('.ow-tl-row')).toHaveLength(5);
  });

  it('reads in the place\'s local time: zone in the header, local day labels and a NOW marker', () => {
    mounted([], context());
    expect(timeline().querySelector('.ow-tl-head')!.textContent).toContain('7 days · next 72 h · Asia/Dubai · UTC+4');
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

  it('draws every row with its legend glyph, and passes closer than a glyph as one glyph with a ×n count', () => {
    const could = [pass('A', -10.2, { kind: 'within-reach' }), pass('B', -10.6, { kind: 'within-reach' }), pass('C', -40, { kind: 'within-reach' }), pass('D', -10.4, { kind: 'capability-overhead' })];
    const photo = pass('SENTINEL-2B', -30, { kind: 'confirmed-image' });
    mounted([...could, photo], context());
    const mark = row('photo').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(mark.textContent).toBe('◆');
    expect(leftPct(mark)).toBeCloseTo(pctOf(photo.timeMs), 2);
    const coulds = [...row('could').querySelectorAll<HTMLElement>('.ow-tl-mark')];
    expect(coulds.map((m) => [m.textContent, m.dataset.count, m.dataset.tier])).toEqual([['□', '1', 'within-reach'], ['□', '2', 'within-reach'], ['□', '1', 'capability-overhead']]);
    expect(coulds[1]!.dataset.tip!.split('\n')[0]).toBe('×2 · within reach');
    expect(listText()).toContain('Could passes, 2026-11-13 01:00 UTC to 02:00: 3');
    expect(listText()).toContain('confirmed image: SENTINEL-2B, 2026-11-12 06:00 UTC');
  });

  it('counts geostationary satellites in view on the Geo row', () => {
    const geo = { noradId: 1, name: 'METEOSAT-9', profileId: 'seviri', status: 'geostationary', visibility: { visible: true } } as unknown as PointPassLookup['satellites'][number];
    const terra = pass('TERRA', -20, { kind: 'daily-mosaic' });
    mounted([terra], context(), { found: { ...lookup([terra]), satellites: [geo] } });
    expect(legendKey('geo').querySelector('.ow-tl-count')!.textContent).toBe('2');
    expect(row('geo').querySelector<HTMLElement>('.ow-tl-geo-line')!.dataset.tip).toBe('Geostationary in view: METEOSAT-9');
  });

  it('puts an archive image with no computed pass on the Photo row and counts it', () => {
    const dock = new OrbitalTimeline(onSelect);
    document.body.append(dock.element);
    setOrbitalDisplayZone('Asia/Dubai', 'GST');
    const image = { startMs: NOW - 30 * HOUR, platform: 'sentinel-2c', pass: null } as unknown as OrbitalTimelineInput['acquisitions'][number];
    dock.update({ lookup: lookup([]), passes: [], acquisitions: [image], context: { kind: 'loaded', context: context() }, selectedKey: null });
    expect(legendKey('photo').querySelector('.ow-tl-count')!.textContent).toBe('1');
    const mark = row('photo').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(leftPct(mark)).toBeCloseTo(pctOf(image.startMs), 2);
    expect(mark.dataset.tip).toBe('SENTINEL-2C · Thu, Nov 12 · 10:00 · image, no computed pass');
    expect(listText()).toContain('image, no computed pass: SENTINEL-2C, 2026-11-12 06:00 UTC');
  });

  it('shows satellite, local time and tier in a tooltip on hover', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], context());
    const tip = timeline().querySelector<HTMLElement>('.ow-tl-tip')!;
    expect(tip.hidden).toBe(true);
    row('photo').querySelector('.ow-tl-mark')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe('SENTINEL-2B · Thu, Nov 12 · 10:00 · confirmed image');
  });

  it('anchors the tooltip over the plot, points it at the hovered glyph and highlights that glyph', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], context());
    const mark = row('photo').querySelector<HTMLElement>('.ow-tl-mark')!;
    mark.dispatchEvent(new Event('pointerover', { bubbles: true }));
    const tip = timeline().querySelector<HTMLElement>('.ow-tl-tip')!;
    expect(mark.classList.contains('is-hover')).toBe(true);
    expect(tip.dataset.place).toBeDefined();
    expect(tip.style.getPropertyValue('--ow-tip-arrow')).toMatch(/px$/);
    timeline().querySelector('.ow-tl-plot')!.dispatchEvent(new Event('pointerleave'));
    expect(mark.classList.contains('is-hover')).toBe(false);
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
    row('likely').querySelector<HTMLElement>(`[data-pass="${keyOf(likely)}"]`)!.click();
    expect(onSelect).toHaveBeenCalledWith(keyOf(likely));
    document.body.replaceChildren();
    mounted([likely, other], context(), { selectedKey: keyOf(likely) });
    expect([...row('likely').querySelectorAll('.is-selected')].map((el) => el.getAttribute('data-pass'))).toEqual([keyOf(likely)]);
  });

  it('draws an upcoming pass right of NOW on the overhead row, styled as an opportunity', () => {
    const soon = pass('SENTINEL-1C', 5, { kind: 'opportunity' });
    mounted([soon], context());
    const mark = row('overhead').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(mark.classList.contains('is-opportunity')).toBe(true);
    expect(leftPct(mark)).toBeGreaterThan(nowPct());
  });

  it('puts a fire 3 km away yesterday on the event strip at its time, with its category legend', () => {
    const at = NOW - 20 * HOUR;
    mounted([], context({ events: { fires: ok([{ id: 'f1', timeMs: at, label: '41 MW', distanceKm: 3 }], { startMs: WINDOW.startMs, endMs: NOW }) } }));
    const mark = timeline().querySelector<HTMLElement>('.ow-tl-strip .ow-tl-event[data-source="fires"]')!;
    expect(leftPct(mark)).toBeCloseTo(pctOf(at), 2);
    expect(mark.dataset.tip).toBe('Fires · 41 MW · 3 km away · Thu, Nov 12 · 20:00');
    expect(eventKey('fires').textContent).toBe('Fires 1');
    expect(listText()).toContain('Fires: 41 MW, 2026-11-12 16:00 UTC, 3 km away');
  });

  it('says how far back a feed keeps history instead of drawing hatched gaps', () => {
    mounted([], context({ events: { fires: ok([], { startMs: Date.UTC(2026, 10, 12), endMs: NOW }) } }));
    expect(eventKey('fires').querySelector('.ow-tl-retained')!.textContent).toBe(' · Thu, Nov 12 to Fri, Nov 13');
    expect(timeline().querySelector('.ow-tl-not-retained')).toBeNull();
    expect(listText()).toContain('Fires: not retained from 2026-11-06 12:00 UTC to 2026-11-12 00:00 UTC');
  });

  it('marks conflict history after its newest event as not retained up to now', () => {
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: NOW - 3 * DAY }) } }));
    expect(eventKey('conflict').querySelector('.ow-tl-retained')!.textContent).toBe(' · Fri, Nov 6 to Tue, Nov 10');
    expect(listText()).toContain('Conflict: not retained from 2026-11-10 12:00 UTC to 2026-11-13 12:00 UTC');
  });

  it('marks the whole history as not retained when the conflict feed ends before the window starts', () => {
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: NOW - 30 * DAY }) } }));
    expect(eventKey('conflict').querySelector('.ow-tl-retained')!.textContent).toBe(' · not retained');
    expect(listText()).toContain('Conflict: not retained from 2026-11-06 12:00 UTC to 2026-11-13 12:00 UTC');
  });

  it('keeps a failed source quiet in the legend and still draws the passes', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], context({ events: { unrest: { status: 'unavailable' } }, live: { 'gps-jamming': { status: 'unavailable' } } }));
    expect(eventKey('unrest').dataset.state).toBe('unavailable');
    expect(eventKey('unrest').querySelector('.ow-tl-count')!.textContent).toBe('–');
    expect(visibleText()).not.toMatch(/unavailable/i);
    expect(listText()).toContain('Unrest: unavailable');
    expect(row('likely').querySelectorAll('.ow-tl-mark')).toHaveLength(1);
    expect(timeline().querySelector('[data-live="gps-jamming"]')).toBeNull();
  });

  it('shows the event legend as loading until the context arrives, with passes already drawn', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], null);
    expect(eventKey('fires').dataset.state).toBe('loading');
    expect(eventKey('fires').querySelector('.ow-tl-count')!.textContent).toBe('…');
    expect(row('likely').querySelectorAll('.ow-tl-mark')).toHaveLength(1);
  });

  it('shows shipping and GPS-jamming context only in the now strip', () => {
    mounted([], context({ live: { vessels: liveOk(['Strait of Hormuz']), 'gps-jamming': liveOk(['38%']) } }));
    const strip = timeline().querySelector('.ow-now-strip')!;
    const vessels = strip.querySelector<HTMLElement>('[data-live="vessels"]')!;
    expect(vessels.textContent).toBe('Shipping traffic 1');
    expect(vessels.title).toBe('Strait of Hormuz · 10 km away');
    expect(strip.querySelector('[data-live="gps-jamming"]')!.textContent).toBe('GPS jamming 1');
    expect(timeline().querySelector('.ow-tl-plot')!.textContent).not.toMatch(/Hormuz|38%/);
    expect(listText()).not.toMatch(/Hormuz|38%/);
  });

  it('has no visible raw list of passes, and says everything in a hidden list for screen readers', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], context());
    expect(timeline().querySelector('details, .ow-tl-list')).toBeNull();
    expect(timeline().querySelector('.ow-tl-plot')!.getAttribute('aria-hidden')).toBe('true');
    expect(listText()).toContain('likely imaged: SENTINEL-2B, 2026-11-12 06:00 UTC');
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
