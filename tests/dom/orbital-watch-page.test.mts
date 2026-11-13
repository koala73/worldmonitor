import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { IMAGE_CREDIT, OrbitalWatchPage, subSolarPoint, type OrbitalWatchState } from '@/components/OrbitalWatchPage';
import manifest from '../../shared/source-attribution-manifest.json';
import { openOrbitalWatch } from '@/app/orbital-watch';
import { formatOrbitalRoute, parseOrbitalRoute } from '@/app/orbital-route';

const NOW = Date.UTC(2026, 10, 13, 12);
const HOUR = 3_600_000;
const point = { lat: 25.2048, lon: 55.2708 };

let nextNorad = 40_000;
function pass(name: string, profileId: string, hoursFromNow: number, tier: PassTier): PointPass {
  return {
    noradId: nextNorad++, name, profileId, category: 'open-optical', time: new Date(NOW + hoursFromNow * HOUR).toISOString(),
    timeMs: NOW + hoursFromNow * HOUR, opportunity: hoursFromNow > 0, groundDistanceKm: 42, side: 'left', elevationDeg: 80,
    azimuthDeg: 90, incidenceDeg: 10, sunElevationDeg: 40, altitudeKm: 700, subSatellite: point, inFootprint: true,
    edgeOfSwath: false, coverage: true, tier, elementsEpochMs: NOW - 2 * HOUR, orbitAgeDays: 0.5,
  };
}

function lookup(passes: PointPass[], catalog: PointPassLookup['catalog']['status'] = 'fresh'): PointPassLookup {
  return {
    point, window: { startMs: NOW - 30 * 24 * HOUR, endMs: NOW + 48 * HOUR }, nowMs: NOW,
    catalog: { status: catalog, fetchedAt: NOW - 3 * 24 * HOUR, inventoryVersion: 'test' },
    passes, satellites: [], computedOn: 'worker',
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
const callbacks = { onClose: vi.fn(), onRetry: vi.fn(), onViewChange: vi.fn() };

function mounted(state?: OrbitalWatchState, returnFocusTo: HTMLElement | null = null, view: 'sheet' | 'full' = 'sheet'): OrbitalWatchPage {
  const page = new OrbitalWatchPage(callbacks);
  pages.push(page);
  page.open(point, returnFocusTo, view);
  if (state) page.render(state);
  return page;
}

const page = () => pages[pages.length - 1]!;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const text = () => sheet().textContent ?? '';
const group = (id: string) => sheet().querySelector<HTMLElement>(`.ow-group[data-group="${id}"]`);
const rowNames = (id: string) => [...group(id)!.querySelectorAll('.ow-row-name')].map((n) => n.textContent);
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
const meteosat = { kind: 'geostationary', archive: 'eumetsat', source: 'Meteosat-10', layer: 'x', noradId: 38552, cadenceMinutes: 15, latest: { time: '2026-11-13T11:45:00Z', imageUrl: 'https://view.eumetsat.int/x.png' } } as OrbitalEvidence['frames'][number];

const cards = () => [...sheet().querySelectorAll<HTMLElement>('.ow-card')];
const rowOf = (name: string) => [...sheet().querySelectorAll<HTMLElement>('.ow-row')].find((r) => r.querySelector('.ow-row-name')?.firstChild?.textContent === name)!;
const click = (selector: string) => sheet().querySelector<HTMLElement>(selector)!.click();

const progress = (settled: EvidenceProgress['settled'], pendingProfiles: EvidenceProgress['pendingProfiles'], passes: PointPass[]): EvidenceProgress =>
  ({ settled, pendingProfiles, evidence: evidence(passes, { status: 'partial' }) });

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  for (const page of pages.splice(0)) page.close();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('satellite pass lookup sheet', () => {
  it('opens as a focused, labelled dialog that shows its compute steps and where the point goes', () => {
    mounted();
    expect(document.activeElement).toBe(sheet());
    expect(sheet().getAttribute('aria-label')).toBe('Satellite passes here');
    expect(document.getElementById(sheet().getAttribute('aria-labelledby')!)?.textContent).toBe('25.205°N 55.271°E');
    expect(sheet().querySelectorAll('.ow-step')).toHaveLength(4);
    expect(text()).toContain('Catalog · loading');
    expect(text()).not.toContain('Checking archives');
    expect(text()).toContain('This point stays in your browser');
    for (const archive of ['Earth Search', 'Microsoft Planetary Computer', 'NASA GIBS', 'EUMETSAT']) expect(text()).toContain(archive);
    expect(text()).toContain('Searching by place name is the one exception');
  });

  it('steps through the catalog, orbit propagation and archive answers before showing results', () => {
    mounted({ kind: 'computing', done: 12, total: 48 });
    const status = (n: number) => sheet().querySelectorAll<HTMLElement>('.ow-step')[n]!.dataset.status;
    expect(text()).toContain('Catalog · 48 imaging satellites');
    expect(text()).toContain('Propagating orbits · 12 / 48');
    expect([status(0), status(1), status(2)]).toEqual(['ok', 'running', 'pending']);
    const { all } = tiered();
    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: progress(['gibs-daily-mosaics', 'eumetsat'], ['sentinel-2'], all) } });
    expect(text()).toContain('Archives · 2 / 5 answered');
    expect(text()).toContain(`Matching scenes to ${all.length} passes`);
    expect(status(1)).toBe('ok');
    expect(sheet().querySelector('.ow-headline')).toBeNull();
    expect(sheet().querySelector('.ow-row')).toBeNull();
    expect(Number(sheet().querySelector('.ow-progress')!.getAttribute('aria-valuenow'))).toBeGreaterThan(60);
  });

  it('headlines how many satellites passed, how many images went public, and the four tier counts', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)], mosaics: [modis], frames: [meteosat] }));
    expect(sheet().querySelector('.ow-headline')!.textContent).toBe('In the last 30 days, 6 satellites passed over 25.205°N 55.271°E.');
    expect(sheet().querySelector('.ow-headline strong')!.textContent).toBe('6 satellites');
    expect(sheet().querySelector('.ow-subline')!.textContent).toBe('3 images were made public.');
    const cell = (id: string) => sheet().querySelector<HTMLElement>(`.ow-tier-cell[data-group="${id}"]`)!;
    expect(cell('watched').querySelector('.ow-tier-number')!.textContent).toBe('2');
    expect(cell('likely').querySelector('.ow-tier-number')!.textContent).toBe('1');
    expect(cell('could').querySelector('.ow-tier-number')!.textContent).toBe('2');
    expect(cell('overhead').querySelector('.ow-tier-number')!.textContent).toBe('1');
    expect(cell('watched').textContent).toContain('A public archive holds an image of this spot.');
    expect(cell('could').textContent).toContain("the operator doesn't say if it looked");
  });

  it('leads the hero carousel with the closest look and pages through the rest', () => {
    const { all, confirmedNew, confirmedOld } = tiered();
    const best = acquisition(confirmedOld, { condition: 'cloud', cloudCoverPct: 69 });
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew), best], bestView: best, mosaics: [modis] }));
    expect(cards().map((c) => c.querySelector('.ow-card-tag')!.textContent)).toEqual(['Closest look', 'SENTINEL-2C', 'MODIS TERRA']);
    const [first] = cards();
    const lines = [...first!.querySelectorAll('.ow-caption-lines span')].map((l) => l.textContent);
    expect(lines[0]).toMatch(/^LANDSAT 9 · .* UTC$/);
    expect(lines[1]).toBe('10 M · 8d ago · Clouded · 69%');
    expect(first!.querySelector('.ow-image-credit')!.textContent).toBe('USGS / Landsat');
    expect(first!.querySelector<HTMLElement>('.ow-image-credit')!.title).toBe(IMAGE_CREDIT.usgs);
    for (const overlay of ['.ow-reticle', '.ow-scale', '.ow-north', '.ow-expand']) expect(first!.querySelector(overlay)).not.toBeNull();
    expect(first!.querySelector('.ow-scale')!.textContent).toBe('2 KM');
    expect(cards()[2]!.querySelector('.ow-caption-lines')!.textContent).toContain('Daily mosaic · 250 M');
    expect(cards()[2]!.querySelector('.ow-image-credit')!.textContent).toBe('NASA GIBS / EOSDIS');
    expect(sheet().querySelector('.ow-pager-count')!.textContent).toBe('1 / 3');
    click('.ow-pager-btn[data-action="next"]');
    expect(sheet().querySelector('.ow-pager-count')!.textContent).toBe('2 / 3');
    click('.ow-tab[data-tab="weather"]');
    expect(cards().map((c) => c.dataset.tab)).toEqual(['weather']);
    expect([...sheet().querySelectorAll('.ow-tab')].map((tab) => tab.textContent)).toEqual(['All', 'Detailed', 'Weather']);
  });

  it('says what kind of cloud read a scene had and labels radar as radar', () => {
    const { all, confirmedNew, soon } = tiered();
    const radarPass = { ...soon, timeMs: NOW - 5 * HOUR, tier: { kind: 'confirmed-image' } as PassTier };
    mounted(answered([...all, radarPass], { acquisitions: [acquisition(confirmedNew, { condition: 'unknown', cloudCoverPct: 12 }), acquisition(radarPass, { profileId: 'sentinel-1', condition: 'not-applicable', cloudCoverPct: null, imageUrl: null })] }));
    const bottom = (i: number) => cards()[i]!.querySelectorAll('.ow-caption-lines span')[1]!.textContent;
    expect(bottom(0)).toContain('Radar · VV · 10 M');
    expect(bottom(1)).toContain('Scene cloud 12% · spot not checked');
    expect(cards()[1]!.querySelector('.ow-image-credit')!.textContent).toBe('© Copernicus Sentinel 2026');
    expect(cards()[1]!.querySelector<HTMLElement>('.ow-image-credit')!.title).toBe('Contains modified Copernicus Sentinel data 2026');
  });

  it('shows every image as a labelled skeleton, then the image or a failure tile with retry', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)] }));
    const tile = () => cards()[0]!.querySelector<HTMLElement>('.ow-tile')!;
    expect(tile().dataset.state).toBe('loading');
    expect(tile().querySelector('.ow-tile-status')!.textContent).toBe('SENTINEL-2C');
    tile().querySelector('img')!.dispatchEvent(new Event('error'));
    expect(tile().dataset.state).toBe('failed');
    expect(tile().querySelector('.ow-tile-status')!.textContent).toContain('Image unavailable · PLANETARY COMPUTER');
    tile().querySelector<HTMLButtonElement>('[data-action="retry-image"]')!.click();
    expect(tile().dataset.state).toBe('loading');
    tile().querySelector('img')!.dispatchEvent(new Event('load'));
    expect(tile().dataset.state).toBe('loaded');
  });

  it('never leaves a blank box for a scene without a preview', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew, { imageUrl: null })] }));
    const tile = cards()[0]!.querySelector<HTMLElement>('.ow-tile')!;
    expect(tile.dataset.state).toBe('none');
    expect(tile.textContent).toBe('The archive has no preview of this scene yet');
  });

  it('asks the globe to replay a pass that has one', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)] }));
    const replay = vi.fn();
    document.addEventListener('orbital-watch:replay', replay);
    click('.ow-replay');
    document.removeEventListener('orbital-watch:replay', replay);
    expect((replay.mock.calls[0]![0] as CustomEvent).detail).toEqual({ noradId: confirmedNew.noradId, timeMs: confirmedNew.timeMs });
  });

  it('opens the full view with the pass list, the status bar and empty slots for the dock, detail and replay HUD', () => {
    const { all, confirmedNew, confirmedOld, soon, later } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)] }));
    expect(sheet().querySelector('.ow-passes')).toBeNull();
    click('[data-action="open-full"]');
    expect(sheet().dataset.view).toBe('full');
    expect(callbacks.onViewChange).toHaveBeenCalledWith('full');
    expect(sheet().querySelector('.ow-passes .ow-section-head')!.textContent).toBe('02 / Passes');
    expect(group('watched')!.querySelector('.ow-group-toggle')!.textContent).toBe('◆2passes watched· Closest look, then newest');
    expect(rowNames('watched').map((n) => n?.replace(/confirmed image$/, ''))).toEqual([confirmedNew.name, confirmedOld.name]);
    expect(rowNames('upcoming').map((n) => n?.replace(/upcoming pass$/, ''))).toEqual([soon.name, later.name]);
    expect(rowOf(confirmedNew.name).querySelector('.ow-tile-thumb')).not.toBeNull();
    expect(rowOf(confirmedOld.name).querySelector('.ow-glyph-tile')).not.toBeNull();
    for (const row of sheet().querySelectorAll('.ow-row')) expect(row.querySelector('.ow-tier-label')?.textContent?.trim()).not.toBe('');
    for (const slot of ['timeline', 'pass-detail', 'replay-hud', 'timelapse']) {
      expect(page().slot(slot as 'timeline').dataset.slot).toBe(slot);
      expect(page().slot(slot as 'timeline').childElementCount).toBe(0);
    }
    expect(sheet().querySelector('.ow-statusbar')!.textContent).toMatch(/^0 imaging satellites · CelesTrak GP · Fetched \d{4}-\d\d-\d\d \d\d:\d\dZ · 3 days ago/);
    expect(sheet().querySelector('.ow-statusbar')!.textContent).toMatch(/Sun \d+\.\d°[NS] \d+\.\d°[EW] · sub-solar point · \d\d:\d\d:\d\d UTC$/);
    expect(sheet().querySelector('[data-action="open-full"].ow-primary')).toBeNull();
  });

  it('keeps could-have-pointed, passed-overhead and weather groups collapsed and unrendered until opened', () => {
    const { all, military, commercial } = tiered();
    mounted(answered(all, { mosaics: [modis, viirs] }), null, 'full');
    for (const id of ['could', 'overhead', 'weather']) {
      expect(group(id)!.querySelector('.ow-group-toggle')!.getAttribute('aria-expanded')).toBe('false');
      expect(group(id)!.querySelectorAll('.ow-row')).toHaveLength(0);
    }
    group('could')!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.click();
    expect(group('could')!.querySelectorAll('.ow-row')).toHaveLength(2);
    const militaryRow = rowOf(military.name);
    expect(militaryRow.querySelector('.ow-tier-label')?.textContent).toBe('capability overhead');
    expect(militaryRow.querySelector('.ow-badges')!.textContent).toContain('capability overhead');
    expect(militaryRow.querySelector('img')).toBeNull();
    expect(rowOf(commercial.name).textContent).toContain('42 KM');
    group('weather')!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.click();
    expect(group('weather')!.querySelectorAll('.ow-row')).toHaveLength(1);
    expect(group('weather')!.textContent).toContain('No recent days in the archive: VIIRS Suomi NPP');
  });

  it('leaves 900 in-range rows unrendered in the full view', () => {
    const passes = [
      ...Array.from({ length: 30 }, (_, i) => pass(`LIKELY ${i}`, 'sentinel-2', -20 - i, { kind: 'likely-imaged' })),
      ...Array.from({ length: 900 }, (_, i) => pass(`REACH ${i}`, 'worldview', -1 - i / 10, { kind: 'within-reach' })),
    ];
    mounted(answered(passes), null, 'full');
    expect(group('could')!.querySelector('.ow-group-count')!.textContent).toBe('900');
    expect(sheet().querySelectorAll('.ow-row')).toHaveLength(30);
  });

  it('selects a pass by key: opens the full view, expands its group, marks and focuses its row and announces it', () => {
    const { all, commercial } = tiered();
    mounted(answered(all));
    const announced = vi.fn();
    sheet().addEventListener('orbital-watch:select', (event) => announced((event as CustomEvent).detail));
    expect(page().select(`${commercial.noradId}:${commercial.timeMs}`)).toBe(true);
    expect(sheet().dataset.view).toBe('full');
    expect(callbacks.onViewChange).toHaveBeenCalledWith('full');
    expect(group('could')!.querySelector('.ow-group-toggle')!.getAttribute('aria-expanded')).toBe('true');
    const row = rowOf(commercial.name);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(announced).toHaveBeenCalledWith({ noradId: commercial.noradId, timeMs: commercial.timeMs });
    expect(page().select('0:0')).toBe(false);
  });

  it('keeps the timeline dock on phones as a full-width, horizontally scrolling strip above the panel', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/orbital-watch.css'), 'utf8');
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    const dock = mobile.slice(mobile.indexOf('[data-view="full"] .ow-dock {'));
    const rule = dock.slice(0, dock.indexOf('}'));
    expect(rule).toMatch(/left: 0;/);
    expect(rule).toMatch(/right: 0;/);
    expect(rule).toMatch(/top: -\d+px;/);
    expect(rule).toMatch(/overflow-x: auto;/);
    expect(mobile).not.toMatch(/\.ow-dock[^{]*\{[^}]*display: none/);
    mounted(answered(tiered().all), null, 'full');
    page().slot('timeline').append(document.createElement('canvas'));
    const slot = sheet().querySelector<HTMLElement>('.ow-dock[data-slot="timeline"]')!;
    expect(slot.parentElement).toBe(sheet());
    expect(slot.querySelector('canvas')).not.toBeNull();
  });

  it('filters the full list to a tier from the count grid', () => {
    const { all, notInArchive } = tiered();
    mounted(answered(all));
    click('.ow-tier-cell[data-group="overhead"]');
    expect(sheet().dataset.view).toBe('full');
    expect([...sheet().querySelectorAll('.ow-group')].map((g) => (g as HTMLElement).dataset.group)).toEqual(['overhead']);
    expect(rowOf(notInArchive.name).textContent).toContain('No image in the archive');
    click('[data-action="clear-filter"]');
    expect(sheet().querySelectorAll('.ow-group').length).toBeGreaterThan(1);
  });

  it('marks a satellite that passed more than once in a group', () => {
    const first = pass('SENTINEL-2B', 'sentinel-2', -30, { kind: 'likely-imaged' });
    const second = { ...pass('SENTINEL-2B', 'sentinel-2', -130, { kind: 'likely-imaged' }), noradId: first.noradId };
    mounted(answered([first, second]), null, 'full');
    expect([...group('likely')!.querySelectorAll('.ow-repeat')].map((r) => r.textContent)).toEqual(['×2', '×2']);
  });

  it('shows its fixed labels in the language chosen since it was last opened', async () => {
    i18next.addResourceBundle('de', 'translation', { contextMenu: { satellitePasses: 'Satellitenüberflüge hier' }, countryBrief: { closeBtn: 'Schließen' }, orbitalWatch: { privacy: 'Dieser Punkt bleibt in Ihrem Browser.', ui: { change: 'Ändern' } } }, true, true);
    const reused = mounted();
    reused.close();
    await i18next.changeLanguage('de');
    try {
      reused.open(point, null);
      pages.push(reused);
      expect(sheet().getAttribute('aria-label')).toBe('Satellitenüberflüge hier');
      expect(sheet().querySelector('.ow-close')?.getAttribute('aria-label')).toBe('Schließen');
      expect(sheet().querySelector('.ow-change')?.textContent).toBe('Ändern');
      expect(text()).toContain('Dieser Punkt bleibt in Ihrem Browser.');
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('words its credits as the source attribution manifest does', () => {
    const attributions = (manifest as { entries: Array<{ attribution?: string }> }).entries.map((e) => e.attribution ?? '').join('\n');
    for (const credit of [IMAGE_CREDIT.copernicus(2026).replace(' 2026', ''), IMAGE_CREDIT.usgs, IMAGE_CREDIT.eumetsat, IMAGE_CREDIT.gibsAcknowledgement]) {
      expect(attributions).toContain(credit);
    }
  });

  it('credits weather frames by their archive', () => {
    const { all } = tiered();
    mounted(answered(all, { frames: [meteosat] }));
    expect(cards()[0]!.querySelector('.ow-image-credit')!.textContent).toBe('© EUMETSAT');
    expect(cards()[0]!.querySelector<HTMLElement>('.ow-image-credit')!.title).toBe('Contains EUMETSAT Meteosat imagery');
    expect(cards()[0]!.querySelector('.ow-caption-lines')!.textContent).toContain('Geostationary · every 15 min');
  });

  it('names the archives that failed and retries on request', () => {
    const { all } = tiered();
    mounted(answered(all, { status: 'partial', failures: [{ archive: 'planetary-computer', reason: 'http-status', httpStatus: 503 }], unansweredProfiles: ['landsat'] }));
    expect(text()).toContain('Microsoft Planetary Computer did not answer');
    click('[data-action="retry"]');
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
  });

  it('names a layer that timed out while its archive answered other layers', () => {
    const { all } = tiered();
    mounted(answered(all, { status: 'partial', failures: [{ archive: 'earth-search', reason: 'timeout' }, { archive: 'nasa-gibs', reason: 'timeout', source: 'GOES-West' }] }));
    expect(text()).toContain('Earth Search and NASA GIBS (GOES-West) did not answer');
    expect(sheet().querySelector('[data-action="retry"]')).not.toBeNull();
  });

  it.each([
    [['earth-search'], 'Earth Search did not answer'],
    [['earth-search', 'planetary-computer'], 'Earth Search and Microsoft Planetary Computer did not answer'],
    [['earth-search', 'planetary-computer', 'eumetsat'], 'Earth Search, Microsoft Planetary Computer, and EUMETSAT did not answer'],
  ] as const)('joins %j failed archives as a sentence', (archives, sentence) => {
    const { all } = tiered();
    mounted(answered(all, { status: 'partial', failures: archives.map((archive) => ({ archive, reason: 'timeout' as const })) }));
    expect(sheet().querySelector('.ow-banner-partial p')!.textContent).toBe(`${sentence}, so some passes may be missing their images.`);
  });

  it('warns about stale orbit data with its age, while computing and after', () => {
    const { all } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all, 'stale'), archives: { kind: 'checking', total: 5, progress: null } });
    expect(text()).toContain('Orbit data is stale. The satellite catalog is 3 days old');
    page().render(answered(all, {}, 'stale'));
    expect(text()).toContain('Orbit data is stale. The satellite catalog is 3 days old');
  });

  it('explains an empty result', () => {
    mounted(answered([]));
    expect(text()).toContain('In the last 30 days, 0 satellites passed over');
    expect(text()).toContain('No profiled imaging satellite passed over this point in the last 30 days or will in the next 48 hours.');
    expect(text()).toContain('This point stays in your browser');
  });

  it('keeps the point note to one line that opens to the full note and every source credit', () => {
    mounted(answered([]));
    const note = sheet().querySelector<HTMLDetailsElement>('.ow-privacy')!;
    expect(note.tagName).toBe('DETAILS');
    expect(note.open).toBe(false);
    expect(note.querySelector('summary')!.textContent).toBe('Point stays in your browser · How ›');
    const sources = [...note.querySelectorAll('.ow-sources li')].map((li) => li.textContent);
    expect(sources).toEqual([IMAGE_CREDIT.copernicus(new Date().getUTCFullYear()), IMAGE_CREDIT.usgs, IMAGE_CREDIT.eumetsat, IMAGE_CREDIT.gibsAcknowledgement]);
  });

  it('counts the satellite behind every image it shows and labels images with no computed pass as archive scenes', () => {
    const s2 = { ...acquisition(pass('SENTINEL-2A', 'sentinel-2', -40, { kind: 'confirmed-image' })), pass: null };
    const l8 = { ...acquisition(pass('LANDSAT 8', 'landsat', -90, { kind: 'confirmed-image' })), pass: null };
    mounted(answered([], { acquisitions: [s2, l8], bestView: s2 }), null, 'full');
    expect(sheet().querySelector('.ow-headline')!.textContent).toBe('In the last 30 days, 2 satellites passed over 25.205°N 55.271°E.');
    expect(text()).not.toContain('No profiled imaging satellite passed over this point');
    expect(text()).toContain('shown as archive scenes');
    expect(cards()[0]!.querySelectorAll('.ow-caption-lines span')[1]!.textContent).toMatch(/^Archive scene · /);
    expect([...sheet().querySelectorAll('.ow-row[data-tier="confirmed-image"]')].map((row) => row.querySelector('.ow-badge')?.textContent)).toEqual(['Archive scene', 'Archive scene']);
  });

  it('keeps each pass row line short: a compact age and a one-line credit with the full credit on hover', () => {
    const { all, confirmedNew } = tiered();
    mounted(answered(all, { acquisitions: [acquisition(confirmedNew)] }), null, 'full');
    const row = rowOf('SENTINEL-2C');
    expect(row.querySelectorAll('.ow-row-meta')[0]!.textContent).toMatch(/ · \d+[mhd] ago$/);
    const credit = row.querySelector<HTMLElement>('.ow-row-credit')!;
    expect(credit.textContent).toBe('© Copernicus Sentinel 2026');
    expect(credit.title).toBe(IMAGE_CREDIT.copernicus(2026));
    const css = readFileSync(resolve(process.cwd(), 'src/styles/orbital-watch.css'), 'utf8');
    expect(css).toMatch(/\.ow-row-meta, \.ow-row-credit \{ white-space: nowrap;/);
  });

  it('gives every tier cell a one-line definition on narrow screens', () => {
    const { all } = tiered();
    mounted(answered(all));
    expect([...sheet().querySelectorAll('.ow-tier-cell .ow-tier-short')].map((d) => d.textContent))
      .toEqual(['Image in a public archive', 'Covered, no image yet', 'Steerable sensor in reach', 'Overhead, no image']);
    const css = readFileSync(resolve(process.cwd(), 'src/styles/orbital-watch.css'), 'utf8');
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobile).toContain('.ow-tier-short { display: block; }');
  });

  it('takes the whole screen in the full view and marks the point on the map', () => {
    const { all } = tiered();
    const reused = mounted(answered(all));
    expect(document.body.classList.contains('orbital-full-view')).toBe(false);
    reused.setView('full');
    expect(document.body.classList.contains('orbital-full-view')).toBe(true);
    expect(sheet().querySelector('.ow-mapmark-label')!.textContent).toBe('25.205°N 55.271°E');
    reused.setView('sheet');
    expect(document.body.classList.contains('orbital-full-view')).toBe(false);
    reused.setView('full');
    reused.close();
    expect(document.body.classList.contains('orbital-full-view')).toBe(false);
  });

  it('walks pass rows with the arrow keys and keeps focus on a row across renders', () => {
    const { all } = tiered();
    mounted(answered(all), null, 'full');
    const rows = [...sheet().querySelectorAll<HTMLElement>('.ow-row')];
    rows[0]!.focus();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);
    const key = rows[0]!.dataset.key;
    page().render(answered(all));
    expect((document.activeElement as HTMLElement).dataset.key).toBe(key);
  });

  it('steps back from the full view on Escape, then closes and hands focus back to the map', () => {
    const map = document.createElement('div');
    document.body.append(map);
    mounted(undefined, map, 'full');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sheet().dataset.view).toBe('sheet');
    expect(callbacks.onViewChange).toHaveBeenLastCalledWith('sheet');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(map);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it('puts the sun over the tropics, moving west through the day', () => {
    const noon = subSolarPoint(Date.UTC(2026, 5, 21, 12));
    expect(noon.lat).toBeCloseTo(23.4, 0);
    expect(Math.abs(noon.lon)).toBeLessThan(3);
    expect(subSolarPoint(Date.UTC(2026, 5, 21, 18)).lon).toBeCloseTo(noon.lon - 90, 0);
  });
});

describe('the orbital route', () => {
  it('reads and writes #orbital=<lat>,<lon>&view=full', () => {
    expect(parseOrbitalRoute('#orbital=25.112,55.139&view=full')).toEqual({ point: { lat: 25.112, lon: 55.139 }, view: 'full' });
    expect(parseOrbitalRoute('#orbital=-33.9,151.2')).toEqual({ point: { lat: -33.9, lon: 151.2 }, view: 'sheet' });
    expect(parseOrbitalRoute('#orbital=95,10')).toBeNull();
    expect(parseOrbitalRoute('#view=full')).toBeNull();
    expect(formatOrbitalRoute({ lat: 25.112, lon: 55.139 }, 'full')).toBe('#orbital=25.1120,55.1390&view=full');
  });
});

describe('opening the lookup for a point', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    evidenceMock.mockReset();
  });
  afterEach(() => {
    document.querySelector<HTMLButtonElement>('.ow-close')?.click();
    document.querySelector<HTMLButtonElement>('.ow-close')?.click();
    history.replaceState(null, '', '/');
  });

  it('computes passes, then reports archive progress, then the answer', async () => {
    const { all } = tiered();
    const found = lookup(all);
    lookupMock.mockImplementation(async (_query, options) => {
      options.onProgress(3, 9);
      expect(text()).toContain('Propagating orbits · 3 / 9');
      return found;
    });
    let finish!: (value: OrbitalEvidence) => void;
    evidenceMock.mockImplementation((_lookup, options) => {
      options.onProgress(progress(['earth-search'], ['landsat'], all));
      return new Promise((resolve) => { finish = resolve; });
    });
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(text()).toContain('Archives · 1 / 5 answered'));
    expect(lookupMock).toHaveBeenCalledWith({ point }, expect.anything());
    finish(evidence(all));
    await vi.waitFor(() => expect(text()).toContain('In the last 30 days, 6 satellites passed over'));
  });

  it('writes the full-view route while it is open and clears it on the way back', async () => {
    lookupMock.mockReturnValue(new Promise(() => {}));
    openOrbitalWatch(point, null, 'full');
    expect(location.hash).toBe('#orbital=25.2048,55.2708&view=full');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(location.hash).toBe('');
    expect(sheet().dataset.view).toBe('sheet');
  });

  it('cancels in-flight work when the sheet closes', async () => {
    let signal!: AbortSignal;
    lookupMock.mockImplementation((_query, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    document.querySelector<HTMLButtonElement>('.ow-close')!.click();
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says the catalog is unavailable when it has no satellites, and retries', async () => {
    lookupMock.mockResolvedValueOnce(lookup([], 'empty'));
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(text()).toContain('The satellite catalog could not be loaded'));
    expect(sheet().querySelector('.ow-step')!.getAttribute('data-status')).toBe('failed');
    expect(evidenceMock).not.toHaveBeenCalled();
    lookupMock.mockResolvedValueOnce(lookup([]));
    evidenceMock.mockResolvedValueOnce(evidence([]));
    click('[data-action="retry"]');
    await vi.waitFor(() => expect(text()).toContain('No profiled imaging satellite passed over this point'));
  });
});
