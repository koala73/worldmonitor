import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const lookupMock = vi.hoisted(() => vi.fn());
const evidenceMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/orbital/pass-client', () => ({ getOrbitalPassClient: () => ({ lookup: lookupMock, dispose: () => {} }) }));
vi.mock('@/services/orbital/match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/match')>()),
  findArchiveEvidence: evidenceMock,
}));

import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { EvidenceProgress, MatchedAcquisition, OrbitalEvidence } from '@/services/orbital/match';
import { formatOrbitalTime, OrbitalWatchPage, setOrbitalDisplayZone, type OrbitalWatchState } from '@/components/OrbitalWatchPage';
import { IMAGE_CREDIT, ORBITAL_WATCH_DOCS_URL } from '@/services/orbital/credits';
import manifest from '../../shared/source-attribution-manifest.json';
import { openOrbitalWatch } from '@/app/orbital-watch';

const NOW = Date.UTC(2026, 10, 13, 12);
const HOUR = 3_600_000;
const point = { lat: 25.2048, lon: 55.2708 };

let nextNorad = 40_000;
function pass(name: string, profileId: string, hoursFromNow: number, tier: PassTier): PointPass {
  return {
    noradId: nextNorad++, name, profileId, category: 'open-optical', time: new Date(NOW + hoursFromNow * HOUR).toISOString(),
    timeMs: NOW + hoursFromNow * HOUR, opportunity: hoursFromNow > 0, groundDistanceKm: 42, side: 'left', direction: 'ascending', elevationDeg: 80,
    azimuthDeg: 90, incidenceDeg: 10, sunElevationDeg: 40, altitudeKm: 700, subSatellite: point, inFootprint: true,
    edgeOfSwath: false, coverage: true, tier, elementsEpochMs: NOW - 2 * HOUR, orbitAgeDays: 0.5,
  };
}

function lookup(passes: PointPass[], catalog: PointPassLookup['catalog']['status'] = 'fresh'): PointPassLookup {
  return {
    point, window: { startMs: NOW - 30 * 24 * HOUR, endMs: NOW + 48 * HOUR }, nowMs: NOW,
    catalog: { status: catalog, fetchedAt: NOW - 3 * 24 * HOUR, inventoryVersion: 'test' },
    passes, satellites: [], daylight: [], computedOn: 'worker',
  };
}

function evidence(passes: PointPass[], over: Partial<OrbitalEvidence> = {}): OrbitalEvidence {
  return { passes, acquisitions: [], mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [], ...over };
}

const tiered = () => {
  const likely = pass('SENTINEL-2B', 'sentinel-2', -30, { kind: 'likely-imaged' });
  const confirmedOld = pass('LANDSAT 9', 'landsat', -200, { kind: 'confirmed-image' });
  const confirmedNew = pass('SENTINEL-2C', 'sentinel-2', -50, { kind: 'confirmed-image' });
  const soon = pass('SENTINEL-1C', 'sentinel-1', 3, { kind: 'opportunity' });
  const later = pass('SENTINEL-2A', 'sentinel-2', 20, { kind: 'opportunity' });
  const military = { ...pass('USA 245', 'keyhole', -10, { kind: 'capability-overhead' }), category: 'military' as const };
  const commercial = pass('WORLDVIEW-3', 'worldview', -12, { kind: 'within-reach' });
  const notInArchive = pass('LANDSAT 8', 'landsat', -400, { kind: 'passed-overhead', note: 'not-in-archive' });
  return { likely, confirmedOld, confirmedNew, soon, later, military, commercial, notInArchive, all: [later, likely, confirmedOld, military, soon, confirmedNew, commercial, notInArchive] };
};

const pages: OrbitalWatchPage[] = [];
const callbacks = { onClose: vi.fn(), onRetry: vi.fn() };

function mounted(state?: OrbitalWatchState, returnFocusTo: HTMLElement | null = null): OrbitalWatchPage {
  const page = new OrbitalWatchPage(callbacks);
  pages.push(page);
  page.open(point, returnFocusTo);
  if (state) page.render(state);
  return page;
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const text = () => sheet().textContent ?? '';
const sectionOf = (id: string) => sheet().querySelector<HTMLElement>(`[data-section="${id}"]`)!;
const group = (id: string) => sheet().querySelector<HTMLElement>(`.ies-group[data-group="${id}"]`);
const rowNames = (id: string) => [...group(id)!.querySelectorAll('.ies-name')].map((n) => n.textContent);
const countOf = (tier: string) => sheet().querySelector(`.ies-count[data-tier="${tier}"] dd`)!.textContent;
const evidenceLine = () => sheet().querySelector('.ies-evidence-line')!.textContent ?? '';
function acquisition(p: PointPass, over: Record<string, unknown> = {}): MatchedAcquisition {
  const platform = p.name.toLowerCase().replace(' ', '-');
  return {
    key: `${platform}:${p.timeMs}`, platform, profileId: p.profileId, orbit: null, startMs: p.timeMs, endMs: p.timeMs, items: [],
    pass: { noradId: p.noradId, timeMs: p.timeMs }, condition: 'clear', cloudCoverPct: 2, sunElevationDeg: 50, resolutionM: 10,
    imageUrl: `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/${platform}.png`, ...over,
  } as MatchedAcquisition;
}

const answered = (passes: PointPass[], over: Partial<OrbitalEvidence> = {}, status: PointPassLookup['catalog']['status'] = 'fresh'): OrbitalWatchState =>
  ({ kind: 'passes', lookup: lookup(passes, status), archives: { kind: 'answered', evidence: evidence(passes, over) } });

const modis = { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS Terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', noradId: 25994, days: [{ date: '2026-11-12', imageUrl: 'https://gibs.earthdata.nasa.gov/m.jpg' }] } as OrbitalEvidence['mosaics'][number];
const viirs = { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'VIIRS Suomi NPP', layer: 'v', noradId: 37849, days: [] } as OrbitalEvidence['mosaics'][number];
const meteosat = { kind: 'geostationary', archive: 'eumetsat', source: 'Meteosat-10', layer: 'x', noradId: 38552, cadenceMinutes: 15, latest: { time: '2026-11-13T11:45:00Z', imageUrl: 'https://view.eumetsat.int/x.png', fallbacks: [] } } as OrbitalEvidence['frames'][number];

const rowOf = (name: string, within = sheet()) => [...within.querySelectorAll<HTMLElement>('.ies-row')].find((r) => r.querySelector('.ies-name')?.textContent === name)!;
const click = (selector: string) => sheet().querySelector<HTMLElement>(selector)!.click();

const progress = (settled: EvidenceProgress['settled'], pendingProfiles: EvidenceProgress['pendingProfiles'], passes: PointPass[]): EvidenceProgress =>
  ({ settled, pendingProfiles, evidence: evidence(passes, { status: 'partial' }) });

/** Archive image fetches: the page paints each one from a blob: URL. */
const failing = new Set<string>();
const fetched: string[] = [];
const sources: string[] = [];
const revoked = new Set<string>();
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  failing.clear();
  fetched.length = 0;
  sources.length = 0;
  revoked.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    fetched.push(url);
    if (failing.has(url)) return new Response('', { status: 503 });
    sources.push(url);
    return new Response(new Blob([new Uint8Array(sources.length - 1)], { type: 'image/jpeg' }));
  }));
  vi.stubGlobal('createImageBitmap', async () => ({ close: () => {} }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:orbital/${(blob as Blob).size}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.add(url); });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  });});


afterEach(() => {
  for (const page of pages.splice(0)) page.close();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.mocked(URL.createObjectURL).mockRestore();
  vi.mocked(URL.revokeObjectURL).mockRestore();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const en = JSON.parse(readFileSync(resolve(__dirname, '../../src/locales/en.json'), 'utf8')).orbitalWatch;
const flat = (o: Record<string, unknown>, p = ''): Array<[string, string]> => Object.entries(o)
  .flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]));

describe('imagery evidence sheet', () => {
  it('opens as a focused, labelled dialog with a visible privacy line that names the archives and the name search', () => {
    mounted();
    expect(document.activeElement).toBe(sheet());
    expect(sheet().getAttribute('aria-label')).toBe('Imagery evidence');
    expect(sheet().querySelector('.cdp-header'), 'Country Brief header chrome').not.toBeNull();
    const line = sheet().querySelector<HTMLElement>('.ies-privacy-line')!;
    expect(line.closest('details'), 'the line itself is never folded away').toBeNull();
    for (const name of ['Earth Search', 'Planetary Computer', 'NASA GIBS', 'EUMETSAT', 'WorldMonitor', 'OSM']) expect(line.textContent).toContain(name);
    expect(text()).toContain('Loading the satellite catalogue');
  });

  it('keeps the privacy line in every sheet height', () => {
    mounted(answered(tiered().all));
    for (const height of ['half', 'full', 'collapsed']) {
      expect(sheet().dataset.height).toBe(height);
      expect(sheet().querySelector<HTMLElement>('.ies-privacy-line')!.hidden).toBe(false);
      click('[data-action="height"]');
    }
    expect(sheet().dataset.height).toBe('half');
  });

  it('lays the sheet out image first: evidence, latest image, timeline, events, capability, windows, alert', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)] }));
    const order = [...sheet().querySelector('.ies-body')!.children].map((el) => (el as HTMLElement).dataset.section ?? (el as HTMLElement).dataset.slot);
    expect(order).toEqual(['evidence', 'latest', 'timeline', 'events', 'capability', 'windows', 'alert']);
    expect(sectionOf('alert').querySelector('a')!.getAttribute('href')).toBe('/pro#pricing');
  });

  it('lists computed passes at once, reading "checking archive" until their archive answers, then moves them to their tier', () => {
    const { all, likely, confirmedNew, military } = tiered();
    const page = mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: null } });
    expect(sheet().dataset.state).toBe('checking');
    expect(rowOf(likely.name).querySelector('.ies-tier')!.textContent).toBe('checking archive');
    expect(rowOf(confirmedNew.name).dataset.tier).toBe('pending');
    expect(rowOf(military.name).querySelector('.ies-tier')!.textContent, 'geometry tiers need no archive').toBe('could image');
    expect(evidenceLine()).toContain('Archives answered: 0 of 5');
    page.render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: progress(['planetary-computer'], ['landsat'], all) } });
    expect(rowOf(likely.name).querySelector('.ies-tier')!.textContent, 'a Sentinel-2 pass leaves pending once its archive answered').toBe('likely');
    page.render(answered(all, { acquisitions: [acquisition(confirmedNew)] }));
    expect(rowOf(confirmedNew.name).querySelector('.ies-tier')!.textContent).toBe('confirmed');
    expect(sheet().querySelectorAll('[data-tier="pending"]')).toHaveLength(0);
  });

  it('heads the sheet with one line of data: confirmed acquisitions, the newest date and its cloud at the point', () => {
    const { all, confirmedNew } = tiered();
    const second = { ...confirmedNew, noradId: confirmedNew.noradId, timeMs: confirmedNew.timeMs - 24 * HOUR };
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(second, { key: 'sentinel-2c:second', startMs: second.timeMs })] }));
    const line = sheet().querySelector<HTMLElement>('.ies-evidence-line')!;
    expect(line.tagName).toBe('P');
    expect(line.textContent, 'two acquisitions of one platform count twice').toMatch(/^2 confirmed images · newest /);
    expect(line.textContent).toMatch(/no cloud over the point/i);
    expect(sheet().querySelector('h1, .ow-headline')).toBeNull();
  });

  it('shows the four tier counts and keeps mosaics, weather frames and in-range passes apart', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)], mosaics: [modis, viirs], frames: [meteosat] }));
    expect([...sheet().querySelectorAll('.ies-count dt')].map((dt) => dt.textContent)).toEqual(['confirmed', 'likely', 'in reach', 'could image']);
    expect([countOf('confirmed'), countOf('likely'), countOf('inReach'), countOf('capability')]).toEqual(['1', '1', '1', '1']);
    const note = sectionOf('evidence').querySelector('.ies-note')!.textContent!;
    expect(note).toContain('1 daily mosaic');
    expect(note, 'VIIRS has no day with an image').not.toContain('2 daily mosaics');
    expect(note).toContain('1 weather-satellite frame');
    expect(note).toContain('1 pass in range');
  });

  it('offers compare only when a second scene of the same sensor exists', () => {
    const { all, confirmedNew, confirmedOld } = tiered();
    const page = mounted(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(confirmedOld)] }));
    expect(sectionOf('latest').querySelector('[data-action="compare"]'), 'Landsat is no baseline for Sentinel-2').toBeNull();
    const earlier = { ...confirmedNew, timeMs: confirmedNew.timeMs - 48 * HOUR };
    page.render(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(earlier, { key: 'sentinel-2c:earlier', startMs: earlier.timeMs })] }));
    expect(sectionOf('latest').querySelector('[data-action="compare"]')).not.toBeNull();
    expect(sectionOf('latest').querySelectorAll('select option')).toHaveLength(1);
    const cloudy = acquisition(earlier, { key: 'sentinel-2c:cloudy', startMs: earlier.timeMs, cloudCoverPct: 80 });
    page.render(answered(all, { acquisitions: [acquisition(confirmedNew), cloudy] }));
    expect(sectionOf('latest').querySelector('[data-action="compare"]'), 'a cloudy scene would only compare cloud').toBeNull();
    const unreferenced = acquisition(earlier, { key: 'sentinel-2c:unreferenced', startMs: earlier.timeMs, imageUrl: 'https://planetarycomputer.microsoft.com/api/data/v1/item/preview.png' });
    page.render(answered(all, { acquisitions: [acquisition(confirmedNew), unreferenced] }));
    expect(sectionOf('latest').querySelector('[data-action="compare"]'), 'a whole-scene preview does not line up').toBeNull();
  });

  it('says the archives found no scene instead of showing an empty image', () => {
    mounted(answered(tiered().all));
    expect(sectionOf('latest').textContent).toContain('Archives returned nothing for this point and period.');
    expect(sectionOf('latest').querySelector('img')).toBeNull();
  });

  it('starts a thumbnail only as its row nears the viewport, with one root margin for every thumbnail', () => {
    const observed: Array<{ target: Element; margin: string | undefined; fire: () => void }> = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: IntersectionObserverCallback, private readonly options?: IntersectionObserverInit) {}
      observe(target: Element) {
        observed.push({ target, margin: this.options?.rootMargin, fire: () => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) });
      }
      disconnect() {}
    });
    const { all, confirmedNew, likely } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(likely)], mosaics: [modis], frames: [meteosat] }));
    expect(observed.length, 'every other image is a thumbnail').toBe(3);
    expect(new Set(observed.map((o) => o.margin))).toEqual(new Set(['300px']));
    expect(fetched, 'only the latest image is fetched up front').toEqual([acquisition(likely).imageUrl]);
    observed[0]!.fire();
    expect(fetched).toHaveLength(2);
  });

  it('names the earlier day a mosaic thumbnail falls back to in its caption, alt text and view label', async () => {
    const { all, confirmedNew, likely } = tiered();
    const twoDays = { ...modis, layer: 'fallback-layer', days: [{ date: '2026-11-12', imageUrl: 'https://gibs.earthdata.nasa.gov/fb-new.jpg' }, { date: '2026-11-11', imageUrl: 'https://gibs.earthdata.nasa.gov/fb-old.jpg' }] } as OrbitalEvidence['mosaics'][number];
    failing.add('https://gibs.earthdata.nasa.gov/fb-new.jpg');
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(likely)], mosaics: [twoDays] }));
    await settle();
    const thumb = sheet().querySelector<HTMLElement>('[data-key="mosaic:fallback-layer"]')!;
    const caption = thumb.querySelector('.ies-thumb-caption')!.textContent!;
    expect(caption).toMatch(/Nov 11/);
    expect(caption).not.toMatch(/Nov 12/);
    expect(thumb.querySelector('img')!.getAttribute('alt')).toBe(caption);
    expect(thumb.querySelector('.ow-view-image')!.getAttribute('aria-label')).toContain(caption);
  });

  it('drops the near-view watch of thumbnails a re-render replaces', () => {
    const live = new Set<object>();
    vi.stubGlobal('IntersectionObserver', class {
      observe() { live.add(this); }
      disconnect() { live.delete(this); }
    });
    const { all, confirmedNew, likely } = tiered();
    const state = answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(likely)], mosaics: [modis], frames: [meteosat] });
    const page = mounted(state);
    expect(live.size).toBe(3);
    page.render(state);
    page.render(state);
    expect(live.size, 'one watch per thumbnail on screen').toBe(3);
  });

  it('dates the evidence line by the newest image even when only an older one has a preview', () => {
    const { all, confirmedNew, likely } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(likely, { imageUrl: null })] }));
    const newest = formatOrbitalTime(likely.timeMs, 'stamp');
    expect(evidenceLine()).toContain(newest);
    expect(sectionOf('latest').querySelector('.ies-note')!.textContent).toContain(newest);
    expect(sectionOf('latest').querySelector('.ies-caption')!.textContent).toContain(formatOrbitalTime(confirmedNew.timeMs, 'stamp'));
  });

  it('keeps focus in collection windows when a pass listed there is chosen', () => {
    const { all, soon } = tiered();
    mounted(answered(all));
    const key = `pass:${soon.noradId}:${soon.timeMs}`;
    expect(sheet().querySelectorAll(`.ies-row[data-key="${key}"]`).length, 'listed under capability and windows').toBeGreaterThan(1);
    sectionOf('windows').querySelector<HTMLElement>(`.ies-row[data-key="${key}"]`)!.click();
    expect(sectionOf('windows').contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.key).toBe(key);
  });

  it('captions a mosaic with its archive day in a display zone west of UTC', () => {
    setOrbitalDisplayZone('America/New_York', 'ET');
    onTestFinished(() => setOrbitalDisplayZone('UTC', 'UTC'));
    const { all, confirmedNew, likely } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(likely)], mosaics: [modis] }));
    const caption = sheet().querySelector(`[data-key="mosaic:${modis.layer}"] .ies-thumb-caption`)!.textContent!;
    expect(caption).toMatch(/Nov 12/);
  });

  it('paints point-bearing images only from blob: URLs and releases them when the lookup ends', async () => {
    const { all, confirmedNew, likely } = tiered();
    const state = answered(all, { acquisitions: [acquisition(confirmedNew), acquisition(likely)], mosaics: [modis], frames: [meteosat] });
    const page = mounted(state);
    await settle();
    const srcs = [...sheet().querySelectorAll('img')].map((img) => img.getAttribute('src')).filter((src): src is string => !!src);
    expect(srcs.length).toBe(4);
    expect(srcs.every((src) => src.startsWith('blob:'))).toBe(true);
    expect(sheet().innerHTML).not.toContain('planetarycomputer.microsoft.com');
    page.close();
    expect(srcs.every((src) => revoked.has(src)), 'closing releases every blob').toBe(true);
  });

  it('shows orbit-data age on every pass row, flags stale elements and names satellites too old to compute', () => {
    const { all, likely } = tiered();
    const stale = { ...likely, noradId: 1, name: 'OLD ORBIT', timeMs: likely.timeMs - HOUR, orbitAgeDays: 5 };
    const found = { ...lookup([...all, stale]), satellites: [{ noradId: 2, name: 'GONE-1', profileId: 'sentinel-2', status: 'too-old' as const }] };
    mounted({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence: evidence([...all, stale]) } });
    const rows = [...sheet().querySelectorAll<HTMLElement>('.ies-row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.querySelector('[data-label="Orbit data"]'), row.textContent!).not.toBeNull();
    expect(rowOf('OLD ORBIT').querySelector('.ies-stale')).not.toBeNull();
    expect(rowOf(likely.name).querySelector('.ies-stale')).toBeNull();
    expect(sheet().querySelector('[data-role="too-old"]')!.textContent).toContain('GONE-1');
  });

  it('groups the passes that could image the point by operating state', () => {
    const { all, military, likely } = tiered();
    mounted(answered(all));
    const groups = [...sectionOf('capability').querySelectorAll<HTMLElement>('.ies-group')].map((g) => g.dataset.group);
    expect(groups).toEqual(['open', 'military']);
    expect(rowNames('military')).toEqual([military.name]);
    expect(rowNames('open')).toContain(likely.name);
    expect(group('open')!.querySelector('.ies-group-title')!.textContent).toMatch(/^Open data · \d+$/);
  });

  it('lists the next open optical and radar windows soonest first, leaving out passes that cannot image the point', () => {
    const { all, soon, later } = tiered();
    const radar = { ...soon, category: 'open-radar' as const, sunElevationDeg: -30 };
    const at = (hours: number, name: string, over: Partial<PointPass>) => ({ ...later, noradId: nextNorad++, name, timeMs: soon.timeMs + hours * HOUR, ...over });
    const unusable = [
      at(1, 'NIGHT OPTICAL', { sunElevationDeg: -20 }),
      at(2, 'OFF FOOTPRINT', { inFootprint: false }),
      at(3, 'NOT COVERED', { coverage: false }),
    ];
    mounted(answered([...all.map((p) => (p === soon ? radar : p)), ...unusable]));
    const rows = [...sectionOf('windows').querySelectorAll<HTMLElement>('.ies-row')];
    expect(rows.map((r) => r.querySelector('.ies-name')!.textContent)).toEqual([soon.name, later.name]);
    expect(rows[0]!.textContent).toContain('Open radar');
    expect(rows[1]!.textContent).toContain('Open optical');
  });

  it('lists the events near the point with live context marked now, and says when the feeds hold none', () => {
    const { all } = tiered();
    const page = mounted(answered(all));
    expect(sectionOf('events').textContent).toContain('Loading event feeds');
    const ok = (events: unknown[] = []) => ({ status: 'ok' as const, events, retained: null });
    page.setPointContext({ kind: 'loaded', context: {
      events: { conflict: ok(), fires: ok([{ id: 'f', timeMs: NOW - 5 * HOUR, label: 'Fire 3 km NE', distanceKm: 3 }]), unrest: ok(), outages: { status: 'unavailable' as const } },
      live: { vessels: { status: 'ok' as const, items: [{ id: 'v', label: 'Tanker ALPHA', distanceKm: 4 }] }, 'military-flights': { status: 'ok' as const, items: [] }, 'gps-jamming': { status: 'ok' as const, items: [] } },
    } as never });
    const rows = [...sectionOf('events').querySelectorAll<HTMLElement>('.ies-event')];
    expect(rows.map((r) => r.dataset.source)).toEqual(['vessels', 'fires']);
    expect(rows[0]!.querySelector('.ies-now')!.textContent).toBe('now');
    expect(rows[1]!.textContent).toContain('3 km');
    expect(sectionOf('events').textContent).toContain('Not available: Outage');
    expect(text()).not.toMatch(/not retained/i);
    page.setPointContext({ kind: 'loaded', context: {
      events: { conflict: ok(), fires: ok(), unrest: ok(), outages: ok() },
      live: { vessels: { status: 'ok' as const, items: [] }, 'military-flights': { status: 'ok' as const, items: [] }, 'gps-jamming': { status: 'ok' as const, items: [] } },
    } as never });
    expect(sectionOf('events').textContent).toMatch(/No events within \d+ km over the past 7 days\./);
  });

  it('selects a pass from its row: marks it, opens its group and announces it for the timeline and the maps', () => {
    const { all, likely } = tiered();
    mounted(answered(all));
    const announced: unknown[] = [];
    sheet().addEventListener('orbital-watch:select', (e) => announced.push((e as CustomEvent).detail));
    rowOf(likely.name).click();
    expect(rowOf(likely.name).getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(rowOf(likely.name));
    expect(announced).toEqual([{ noradId: likely.noradId, timeMs: likely.timeMs }]);
  });

  it('walks pass rows with the arrow keys and selects with Enter', () => {
    const { all } = tiered();
    const page = mounted(answered(all));
    const rows = [...sheet().querySelectorAll<HTMLElement>('.ies-row')];
    rows[0]!.focus();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(page.selected).toBe(rows[1]!.dataset.key!.slice('pass:'.length));
  });

  it('closes on Escape and hands focus back to the map', () => {
    const map = document.body.appendChild(document.createElement('div'));
    mounted(answered(tiered().all), map);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(map);
    expect(callbacks.onClose).toHaveBeenCalled();
  });

  it('names the archives that failed and retries on request', () => {
    const { all } = tiered();
    mounted(answered(all, { status: 'partial', failures: [{ archive: 'earth-search', reason: 'timeout' }] as OrbitalEvidence['failures'] }));
    expect(text()).toContain('No answer from Earth Search. Counts may be low.');
    click('[data-action="retry"]');
    expect(callbacks.onRetry).toHaveBeenCalled();
  });

  it('warns about stale orbit data with its age', () => {
    mounted(answered(tiered().all, {}, 'stale'));
    expect(sheet().querySelector('.ies-note.ies-stale')!.textContent).toBe('Catalogue is 3 days old; predicted times can drift.');
  });

  it('words its credits as the source attribution manifest does', () => {
    const attributions = (manifest as { entries: Array<{ attribution?: string }> }).entries.map((e) => e.attribution ?? '').join('\n');
    for (const credit of [IMAGE_CREDIT.copernicus(2026).replace(' 2026', ''), IMAGE_CREDIT.usgs, IMAGE_CREDIT.eumetsat, IMAGE_CREDIT.celestrak]) {
      expect(attributions).toContain(credit);
    }
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)] }));
    const sources = sheet().querySelector<HTMLElement>('.ies-sources')!;
    expect(sources.hidden).toBe(false);
    expect(sources.querySelector(`a[href="${ORBITAL_WATCH_DOCS_URL}"]`)).not.toBeNull();
  });

  it('shows its fixed labels in the language chosen since it was last opened', async () => {
    i18next.addResourceBundle('de', 'translation', { countryBrief: { closeBtn: 'Schließen' }, orbitalWatch: { sheet: { heading: 'Bildnachweise', change: 'Ort ändern' }, privacy: { line: 'Punkt bleibt auf diesem Gerät.' } } }, true, true);
    const reused = mounted();
    reused.close();
    await i18next.changeLanguage('de');
    onTestFinished(async () => { await i18next.changeLanguage('en'); });
    reused.open(point, null);
    pages.push(reused);
    expect(sheet().getAttribute('aria-label')).toBe('Bildnachweise');
    expect(sheet().querySelector('.ies-close')?.getAttribute('aria-label')).toBe('Schließen');
    expect(sheet().querySelector('.ies-privacy-line')?.textContent).toBe('Punkt bleibt auf diesem Gerät.');
    expect(sheet().querySelector('[data-action="change"]')?.textContent).toBe('Ort ändern');
  });
});

describe('orbitalWatch copy', () => {
  it('uses the plan tiers and never the verb "watched"', () => {
    const entries = flat(en);
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.filter(([, v]) => /\bwatch(ed|es|ing)?\b/i.test(v)).map(([k]) => k)).toEqual([]);
    expect(en.tier).toMatchObject({ confirmed: 'confirmed', likely: 'likely', inReach: 'in reach', capability: 'could image' });
  });
});

describe('opening the lookup for a point', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    evidenceMock.mockReset();
  });
  afterEach(() => {
    document.querySelector<HTMLButtonElement>('.ies-close')?.click();
    history.replaceState(null, '', '/');
  });

  it('computes passes, lists them while archives answer, then shows the answer', async () => {
    const { all, confirmedNew } = tiered();
    const found = lookup(all);
    lookupMock.mockImplementation(async (_query, options) => {
      options.onProgress(3, 9);
      expect(text()).toContain('Computing passes · satellite 3 of 9');
      return found;
    });
    let finish!: (value: OrbitalEvidence) => void;
    evidenceMock.mockImplementation((_lookup, options) => {
      options.onProgress(progress(['earth-search'], ['landsat'], all));
      return new Promise((resolve) => { finish = resolve; });
    });
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(evidenceLine()).toContain('Archives answered: 1 of'));
    expect(sheet().querySelectorAll('.ies-row').length, 'rows render before the archives finish').toBeGreaterThan(0);
    expect(lookupMock).toHaveBeenCalledWith({ point }, expect.anything());
    finish(evidence(all, { acquisitions: [acquisition(confirmedNew)] }));
    await vi.waitFor(() => expect(evidenceLine()).toMatch(/^1 confirmed image · newest /));
  });

  it('keeps the page URL free of the picked point', async () => {
    lookupMock.mockReturnValue(new Promise(() => {}));
    openOrbitalWatch(point, null);
    expect(location.href).not.toContain('25.2048');
    expect(location.href).not.toContain('55.2708');
  });

  it('cancels in-flight work when the sheet closes', async () => {
    let signal!: AbortSignal;
    lookupMock.mockImplementation((_query, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    document.querySelector<HTMLButtonElement>('.ies-close')!.click();
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says pass data is unavailable when the catalog has no satellites, and retries', async () => {
    lookupMock.mockResolvedValueOnce(lookup([], 'empty'));
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(text()).toContain('Pass data is unavailable'));
    expect(evidenceMock).not.toHaveBeenCalled();
    lookupMock.mockResolvedValueOnce(lookup([]));
    evidenceMock.mockResolvedValueOnce(evidence([]));
    click('[data-action="retry"]');
    await vi.waitFor(() => expect(text()).toContain('No satellite came within reach of this point during this period.'));
  });
});
