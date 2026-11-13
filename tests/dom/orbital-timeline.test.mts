import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import { daylightSpans, type PointPass } from '@/services/orbital/pass-job';
import type { OrbitalEvidence } from '@/services/orbital/match';
import { loadPointContext, type EventLane, type LiveStrip, type PointContext } from '@/services/orbital/point-context';
import { OrbitalWatchPage } from '@/components/OrbitalWatchPage';

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

const evidence = (passes: PointPass[]): OrbitalEvidence =>
  ({ passes, acquisitions: [], mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] });

const ok = (events: Extract<EventLane, { status: 'ok' }>['events'] = [], retained: { startMs: number; endMs: number } | null = { startMs: WINDOW.startMs, endMs: NOW }): EventLane =>
  ({ status: 'ok', events, retained });
const liveOk = (labels: string[] = []): LiveStrip => ({ status: 'ok', items: labels.map((label, i) => ({ id: label, label, distanceKm: 10 + i })) });

function context(over: { events?: Partial<PointContext['events']>; live?: Partial<PointContext['live']> } = {}): PointContext {
  return {
    events: { conflict: ok(), fires: ok(), unrest: ok(), outages: ok(), ...over.events },
    live: { vessels: liveOk(), 'military-flights': liveOk(), 'gps-jamming': liveOk(), ...over.live },
    timeZone: 'Asia/Dubai',
  };
}

const pages: OrbitalWatchPage[] = [];
const onSelectPass = vi.fn();

function mounted(passes: PointPass[], ctx: PointContext | null, at = point): OrbitalWatchPage {
  const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn(), onSelectPass });
  pages.push(page);
  page.open(at, null);
  page.render({ kind: 'passes', lookup: lookup(passes, at), archives: { kind: 'answered', evidence: evidence(passes) } });
  if (ctx) page.setPointContext({ kind: 'loaded', context: ctx });
  return page;
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
  for (const page of pages.splice(0)) page.close();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

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
    expect(leftPct(firstDay)).toBeCloseTo(pctOf(Date.UTC(2026, 10, 6, 20)), 2);
    expect(timeline().querySelector('.ow-tl-now-label')!.textContent).toBe('now');
    expect(nowPct()).toBeCloseTo(pctOf(NOW), 2);
  });

  it('draws one glyph per pass at its time, and the many "could" passes as ticks', () => {
    const could = [pass('A', -10.2, { kind: 'within-reach' }), pass('B', -10.6, { kind: 'capability-overhead' }), pass('C', -40, { kind: 'within-reach' })];
    const photo = pass('SENTINEL-2B', -30, { kind: 'confirmed-image' });
    mounted([...could, photo], context());
    const mark = row('photo').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(mark.textContent).toBe('◆');
    expect(leftPct(mark)).toBeCloseTo(pctOf(photo.timeMs), 2);
    expect(row('could').querySelectorAll('.ow-tl-mark.is-tick')).toHaveLength(3);
    expect(listText()).toContain('Could passes, 2026-11-13 01:00 UTC to 02:00: 2');
    expect(listText()).toContain('confirmed image: SENTINEL-2B, 2026-11-12 06:00 UTC');
  });

  it('counts geostationary satellites in view on the Geo row', () => {
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    pages.push(page);
    page.open(point, null);
    const geo = { noradId: 1, name: 'METEOSAT-9', profileId: 'seviri', status: 'geostationary', visibility: { visible: true } } as unknown as PointPassLookup['satellites'][number];
    const terra = pass('TERRA', -20, { kind: 'daily-mosaic' });
    page.render({ kind: 'passes', lookup: { ...lookup([terra]), satellites: [geo] }, archives: { kind: 'answered', evidence: evidence([terra]) } });
    expect(legendKey('geo').querySelector('.ow-tl-count')!.textContent).toBe('2');
    expect(row('geo').querySelector<HTMLElement>('.ow-tl-geo-line')!.dataset.tip).toBe('Geostationary in view: METEOSAT-9');
  });

  it('shows satellite, local time and tier in a tooltip on hover', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'confirmed-image' })], context());
    const tip = timeline().querySelector<HTMLElement>('.ow-tl-tip')!;
    expect(tip.hidden).toBe(true);
    row('photo').querySelector('.ow-tl-mark')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe('SENTINEL-2B · Thu 12 Nov · 10:00 · confirmed image');
  });

  it('clicking a glyph selects the same pass in the sheet and hands it to the pass detail', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    const other = pass('LANDSAT 9', -60, { kind: 'likely-imaged' });
    mounted([likely, other], context());
    row('likely').querySelector<HTMLElement>(`[data-pass="${keyOf(likely)}"]`)!.click();
    const sheetRow = document.querySelector<HTMLElement>('.ow-row.is-selected')!;
    expect(sheetRow.querySelector('.ow-row-name')!.textContent).toBe('SENTINEL-2B');
    expect(row('likely').querySelector('.is-selected')!.getAttribute('data-pass')).toBe(keyOf(likely));
    expect(onSelectPass).toHaveBeenCalledWith(likely);
  });

  it('selecting a pass in the sheet by keyboard selects its glyph', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    mounted([likely], context());
    document.querySelector<HTMLElement>(`.ow-row[data-pass="${keyOf(likely)}"]`)!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(row('likely').querySelector(`[data-pass="${keyOf(likely)}"]`)!.classList.contains('is-selected')).toBe(true);
  });

  it('shows a pass as a photo as soon as one archive confirms it, like its sheet row', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn(), onSelectPass });
    pages.push(page);
    page.open(point, null);
    page.render({ kind: 'passes', lookup: lookup([likely]), archives: { kind: 'checking', total: 3,
      progress: { evidence: evidence([{ ...likely, tier: { kind: 'confirmed-image' } }]), settled: ['earth-search'] as never, pendingProfiles: [] } } });
    expect(row('photo').querySelector(`[data-pass="${keyOf(likely)}"]`)).not.toBeNull();
    expect(row('likely').querySelector(`[data-pass="${keyOf(likely)}"]`)).toBeNull();
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
    expect(mark.dataset.tip).toBe('Fires · 41 MW · 3 km away · Thu 12 Nov · 20:00');
    expect(eventKey('fires').textContent).toBe('Fires 1');
    expect(listText()).toContain('Fires: 41 MW, 2026-11-12 16:00 UTC, 3 km away');
  });

  it('says how far back a feed keeps history instead of drawing hatched gaps', () => {
    mounted([], context({ events: { fires: ok([], { startMs: Date.UTC(2026, 10, 12), endMs: NOW }) } }));
    expect(eventKey('fires').querySelector('.ow-tl-retained')!.textContent).toBe(' · Thu 12 Nov to Fri 13 Nov');
    expect(timeline().querySelector('.ow-tl-not-retained')).toBeNull();
    expect(listText()).toContain('Fires: not retained from 2026-11-06 12:00 UTC to 2026-11-12 00:00 UTC');
  });

  it('marks conflict history after its newest event as not retained up to now', () => {
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: NOW - 3 * DAY }) } }));
    expect(eventKey('conflict').querySelector('.ow-tl-retained')!.textContent).toBe(' · Fri 6 Nov to Tue 10 Nov');
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
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    pages.push(page);
    page.open(polar, null);
    const window = { startMs: june - 7 * DAY, endMs: june + 72 * HOUR };
    const found = { ...lookup([], polar), window, nowMs: june, daylight: daylightSpans(polar, window) };
    page.render({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence: evidence([]) } });
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
