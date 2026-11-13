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
const track = (lane: string) => timeline().querySelector<HTMLElement>(`.ow-tl-track[data-lane="${lane}"]`)!;
const leftPct = (el: Element) => Number((el as HTMLElement).style.left.replace('%', ''));
const pctOf = (ms: number) => ((ms - WINDOW.startMs) / (WINDOW.endMs - WINDOW.startMs)) * 100;
const nowPct = () => leftPct(timeline().querySelector('.ow-tl-now')!);
const listText = () => timeline().querySelector('.ow-tl-list')!.textContent ?? '';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  for (const page of pages.splice(0)) page.close();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('orbital timeline', () => {
  it('draws a fire 3 km from the point yesterday in the fire lane at that time, and lists it', () => {
    const at = NOW - 20 * HOUR;
    mounted([], context({ events: { fires: ok([{ id: 'f1', timeMs: at, label: '41 MW', distanceKm: 3 }], { startMs: Date.UTC(2026, 10, 12), endMs: NOW }) } }));
    const mark = track('fires').querySelector('.ow-tl-event')!;
    expect(leftPct(mark)).toBeCloseTo(pctOf(at), 2);
    expect(listText()).toContain('Fires: 41 MW, 2026-11-12 16:00 UTC, 3 km from ground track');
  });

  it('marks the days beyond the fire feed as not retained instead of drawing an empty lane', () => {
    mounted([], context({ events: { fires: ok([], { startMs: Date.UTC(2026, 10, 12), endMs: NOW }) } }));
    const gap = track('fires').querySelector<HTMLElement>('.ow-tl-not-retained')!;
    expect(gap.title).toBe('not retained');
    expect(leftPct(gap)).toBe(0);
    expect(Number(gap.style.width.replace('%', ''))).toBeCloseTo(pctOf(Date.UTC(2026, 10, 12)), 2);
    expect(listText()).toContain('Fires: not retained from 2026-11-06 12:00 UTC to 2026-11-12 00:00 UTC');
  });

  it('marks conflict history after its newest event as not retained up to now', () => {
    const newest = NOW - 3 * DAY;
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: newest }) } }));
    const gap = track('conflict').querySelector<HTMLElement>('.ow-tl-not-retained')!;
    expect(leftPct(gap)).toBeCloseTo(pctOf(newest), 2);
    expect(leftPct(gap) + Number(gap.style.width.replace('%', ''))).toBeCloseTo(nowPct(), 2);
  });

  it('marks the whole history as not retained when the conflict feed ends before the window starts', () => {
    mounted([], context({ events: { conflict: ok([], { startMs: NOW - 400 * DAY, endMs: NOW - 30 * DAY }) } }));
    const gaps = track('conflict').querySelectorAll<HTMLElement>('.ow-tl-not-retained');
    expect(gaps).toHaveLength(1);
    expect(leftPct(gaps[0]!)).toBeCloseTo(0, 2);
    expect(leftPct(gaps[0]!) + Number(gaps[0]!.style.width.replace('%', ''))).toBeCloseTo(nowPct(), 2);
    expect(listText()).toContain('Conflict: not retained from 2026-11-06 12:00 UTC to 2026-11-13 12:00 UTC');
  });

  it('selecting a timeline mark highlights the same pass in the list and hands it to the map', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    const other = pass('LANDSAT 9', -60, { kind: 'likely-imaged' });
    mounted([likely, other], context());
    track('likely').querySelector<HTMLElement>(`[data-pass="${likely.noradId}:${likely.timeMs}"]`)!.click();
    const row = document.querySelector<HTMLElement>('.ow-row.is-selected')!;
    expect(row.querySelector('.ow-row-name')!.textContent).toBe('SENTINEL-2B');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(track('likely').querySelector('.is-selected')!.getAttribute('data-pass')).toBe(`${likely.noradId}:${likely.timeMs}`);
    expect(onSelectPass).toHaveBeenCalledWith(likely);
  });

  it('selecting a pass in the list selects it on the timeline, and the list equivalent selects by keyboard', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    mounted([likely], context());
    const key = `${likely.noradId}:${likely.timeMs}`;
    const row = document.querySelector<HTMLElement>(`.ow-row[data-pass="${key}"]`)!;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(track('likely').querySelector(`[data-pass="${key}"]`)!.classList.contains('is-selected')).toBe(true);
    expect(document.activeElement?.getAttribute('data-pass')).toBe(key);
    const button = timeline().querySelector<HTMLButtonElement>(`.ow-tl-list button[data-pass="${key}"]`)!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('likely imaged: SENTINEL-2B, 2026-11-12 06:00 UTC');
  });

  it('draws an upcoming pass right of the now marker as an opportunity', () => {
    const soon = pass('SENTINEL-1C', 5, { kind: 'opportunity' });
    mounted([soon], context());
    const mark = track('opportunity').querySelector<HTMLElement>('.ow-tl-mark')!;
    expect(mark.classList.contains('is-opportunity')).toBe(true);
    expect(leftPct(mark)).toBeGreaterThan(nowPct());
  });

  it('draws in-range and passed-overhead passes as hourly density with a list equivalent', () => {
    const inRange = [pass('A', -10.2, { kind: 'within-reach' }), pass('B', -10.6, { kind: 'capability-overhead' }), pass('C', -40, { kind: 'within-reach' })];
    const passed = [pass('D', -70, { kind: 'passed-overhead' })];
    mounted([...inRange, ...passed], context());
    expect(track('inRange').querySelectorAll('.ow-tl-mark')).toHaveLength(0);
    expect([...track('inRange').querySelectorAll<HTMLElement>('.ow-tl-bin')].map((bin) => bin.dataset.count)).toEqual(['1', '2']);
    expect(track('passed').querySelectorAll('.ow-tl-bin')).toHaveLength(1);
    expect(listText()).toContain('in range passes, 2026-11-13 01:00 UTC to 02:00: 2');
    expect(timeline().querySelector('.ow-tl-chart')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a failed source as unavailable and still draws the passes', () => {
    const likely = pass('SENTINEL-2B', -30, { kind: 'likely-imaged' });
    mounted([likely], context({ events: { unrest: { status: 'unavailable' } }, live: { 'gps-jamming': { status: 'unavailable' } } }));
    expect(track('unrest').dataset.state).toBe('unavailable');
    expect(track('unrest').textContent).toBe('unavailable');
    expect(track('likely').querySelectorAll('.ow-tl-mark')).toHaveLength(1);
    expect(timeline().querySelector('[data-live="gps-jamming"]')!.textContent).toContain('unavailable');
  });

  it('shows the event lanes as loading until the context arrives', () => {
    mounted([pass('SENTINEL-2B', -30, { kind: 'likely-imaged' })], null);
    expect(track('fires').dataset.state).toBe('loading');
    expect(track('likely').querySelectorAll('.ow-tl-mark')).toHaveLength(1);
  });

  it('shows vessel and GPS-jamming context only in the now strip', () => {
    mounted([], context({ live: { vessels: liveOk(['Strait of Hormuz']), 'gps-jamming': liveOk(['38%']) } }));
    const strip = timeline().querySelector('.ow-now-strip')!;
    expect(strip.querySelector('[data-live="vessels"]')!.textContent).toBe('Shipping traffic within 100 km: 1, nearest Strait of Hormuz');
    expect(strip.querySelector('[data-live="gps-jamming"]')!.textContent).toContain('nearest 38%');
    expect(timeline().querySelector('.ow-tl-chart')!.textContent).not.toMatch(/EVER GIVEN|38%/);
    expect(listText()).not.toMatch(/EVER GIVEN|38%/);
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
