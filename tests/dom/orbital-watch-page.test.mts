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
import { OrbitalWatchPage, type OrbitalWatchState } from '@/components/OrbitalWatchPage';
import { IMAGE_CREDIT } from '@/services/orbital/credits';
import manifest from '../../shared/source-attribution-manifest.json';
import { openOrbitalWatch } from '@/app/orbital-watch';

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
const callbacks = { onClose: vi.fn(), onRetry: vi.fn() };

function mounted(state?: OrbitalWatchState, returnFocusTo: HTMLElement | null = null): OrbitalWatchPage {
  const page = new OrbitalWatchPage(callbacks);
  pages.push(page);
  page.open(point, returnFocusTo);
  if (state) page.render(state);
  return page;
}

const page = () => pages[pages.length - 1]!;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const text = () => sheet().textContent ?? '';
const group = (id: string) => sheet().querySelector<HTMLElement>(`.ow-group[data-group="${id}"]`);
const rowNames = (id: string) => [...group(id)!.querySelectorAll('.ow-row-name')].map((n) => n.textContent);
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
  it('opens as a focused, labelled dialog that states where the point goes', () => {
    mounted();
    expect(document.activeElement).toBe(sheet());
    expect(document.getElementById(sheet().getAttribute('aria-labelledby')!)?.textContent).toBe('Satellite passes here');
    expect(text()).toContain('25.205°N, 55.271°E');
    expect(text()).toContain('Loading the satellite catalog');
    expect(text()).toContain('This point stays in your browser');
    for (const archive of ['Earth Search', 'Microsoft Planetary Computer', 'NASA GIBS', 'EUMETSAT']) expect(text()).toContain(archive);
    expect(text()).toContain('Searching by place name is the one exception');
  });

  it('shows pass computation progress', () => {
    mounted({ kind: 'computing', done: 12, total: 48 });
    expect(text()).toContain('Computing passes: 12 of 48 satellites');
  });

  it('never states a confirmed-image count or "no image" while archives are still answering', () => {
    const { all, likely } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: progress(['gibs-daily-mosaics', 'eumetsat'], ['sentinel-2', 'landsat'], all) } });
    expect(text()).toContain('Checking archives: 2 of 5 answered');
    expect(text()).not.toContain('Confirmed images');
    expect(rowNames('checking')).toContain(likely.name);
    const likelyRow = [...group('checking')!.querySelectorAll('.ow-row')].find((r) => r.textContent?.includes(likely.name))!;
    expect(likelyRow.querySelector('.ow-tier-label')?.textContent).toBe('checking archive');
    expect(likelyRow.textContent).not.toContain('No image');
  });

  it('keeps the confirmed headline back while a matched image is already listed', () => {
    const { all, confirmedNew } = tiered();
    const early = evidence(all, { status: 'partial', acquisitions: [{ platform: 'sentinel-2c', profileId: 'sentinel-2', startMs: confirmedNew.timeMs, pass: { noradId: confirmedNew.noradId, timeMs: confirmedNew.timeMs }, imageUrl: 'https://earth-search.aws.element84.com/a.jpg', condition: 'clear', cloudCoverPct: 2 }] as unknown as MatchedAcquisition[] });
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: { settled: ['earth-search'], pendingProfiles: ['landsat'], evidence: early } } });
    expect(sheet().querySelector('.ow-headline')?.textContent).toBe('Checking archives: 1 of 5 answered');
    expect(text()).not.toContain('Confirmed images:');
    expect(rowNames('confirmed')).toContain(confirmedNew.name);
  });

  it('does not say "no image in the archive" for a pass another archive has yet to answer', () => {
    const likely = pass('LANDSAT 9', 'landsat', -30, { kind: 'likely-imaged' });
    const answeredOne = { ...likely, tier: { kind: 'passed-overhead', note: 'not-in-archive' } as PassTier };
    mounted({ kind: 'passes', lookup: lookup([likely]), archives: { kind: 'checking', total: 5, progress: progress(['earth-search'], ['landsat'], [answeredOne]) } });
    expect(rowNames('checking')).toEqual([likely.name]);
    expect(group('checking')!.textContent).not.toContain('No image in the archive');
  });

  it('acknowledges NASA GIBS beside its mosaics as soon as an early answer brings them', () => {
    const { all } = tiered();
    const mosaics = [{ kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS Terra', layer: 'm', noradId: 25994, days: [{ date: '2026-11-12', imageUrl: 'https://gibs.earthdata.nasa.gov/m.jpg' }] }] as OrbitalEvidence['mosaics'];
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: { settled: ['gibs-daily-mosaics'], pendingProfiles: ['sentinel-2', 'landsat'], evidence: evidence(all, { status: 'partial', mosaics }) } } });
    group('mosaic')!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.click();
    const modis = [...group('mosaic')!.querySelectorAll('.ow-row')].find((r) => r.textContent?.includes('MODIS Terra'))!;
    expect(modis.querySelector('figure .ow-image-credit')?.textContent).toBe(IMAGE_CREDIT.gibsAcknowledgement);
  });

  it('shows each image loading, then the image or a visible failure', () => {
    const { all, confirmedNew, confirmedOld } = tiered();
    const acquisitions = [
      { platform: 'sentinel-2c', profileId: 'sentinel-2', startMs: confirmedNew.timeMs, pass: { noradId: confirmedNew.noradId, timeMs: confirmedNew.timeMs }, imageUrl: 'https://earth-search.aws.element84.com/a.jpg', condition: 'clear', cloudCoverPct: 2 },
      { platform: 'landsat-9', profileId: 'landsat', startMs: confirmedOld.timeMs, pass: { noradId: confirmedOld.noradId, timeMs: confirmedOld.timeMs }, imageUrl: 'https://planetarycomputer.microsoft.com/api/data/v1/b.png', condition: 'clear', cloudCoverPct: 4 },
    ] as unknown as MatchedAcquisition[];
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all, { acquisitions }) } });
    const frame = (name: string) => [...sheet().querySelectorAll('.ow-row')].find((r) => r.textContent?.includes(name))!.querySelector<HTMLElement>('.ow-image-frame')!;

    for (const name of [confirmedNew.name, confirmedOld.name]) {
      expect(frame(name).dataset.state).toBe('loading');
      expect(frame(name).textContent).toBe('Loading image…');
    }
    frame(confirmedNew.name).querySelector('img')!.dispatchEvent(new Event('load'));
    frame(confirmedOld.name).querySelector('img')!.dispatchEvent(new Event('error'));
    expect(frame(confirmedNew.name).dataset.state).toBe('loaded');
    expect(frame(confirmedOld.name).dataset.state).toBe('failed');
    expect(frame(confirmedOld.name).textContent).toBe('Image did not load. The archive may be slow or down.');
  });

  it('says when a confirmed scene has no preview yet instead of leaving the image area blank', () => {
    const { all, confirmedNew } = tiered();
    const acquisitions = [
      { platform: 'sentinel-2c', profileId: 'sentinel-2', startMs: confirmedNew.timeMs, pass: { noradId: confirmedNew.noradId, timeMs: confirmedNew.timeMs }, imageUrl: null, condition: 'unknown', cloudCoverPct: 2 },
    ] as unknown as MatchedAcquisition[];
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all, { acquisitions }) } });
    const row = [...sheet().querySelectorAll('.ow-row')].find((r) => r.textContent?.includes(confirmedNew.name))!;
    expect(row.querySelector('.ow-image-frame')).toBeNull();
    expect(row.querySelector('.ow-row-note')?.textContent).toBe('The archive has no preview of this scene yet.');
  });

  it('keeps keyboard focus on the same row while archives keep answering', () => {
    const { all, soon } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: progress(['eumetsat'], ['sentinel-2', 'landsat'], all) } });
    const focusedRow = () => [...sheet().querySelectorAll<HTMLElement>('.ow-row')].find((r) => r.textContent?.includes(soon.name))!;
    focusedRow().focus();
    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'checking', total: 5, progress: progress(['eumetsat', 'earth-search'], ['landsat'], all) } });
    expect(document.activeElement).toBe(focusedRow());
    group('upcoming')!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.focus();
    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all) } });
    expect(document.activeElement).toBe(group('upcoming')!.querySelector('.ow-group-toggle'));
  });

  it('shows its fixed labels in the language chosen since it was last opened', async () => {
    i18next.addResourceBundle('de', 'translation', { contextMenu: { satellitePasses: 'Satellitenüberflüge hier' }, countryBrief: { closeBtn: 'Schließen' }, orbitalWatch: { privacy: 'Dieser Punkt bleibt in Ihrem Browser.' } }, true, true);
    const reused = mounted();
    reused.close();
    await i18next.changeLanguage('de');
    try {
      reused.open(point, null);
      pages.push(reused);
      expect(document.getElementById(sheet().getAttribute('aria-labelledby')!)?.textContent).toBe('Satellitenüberflüge hier');
      expect(sheet().querySelector('.ow-close')?.getAttribute('aria-label')).toBe('Schließen');
      expect(text()).toContain('Dieser Punkt bleibt in Ihrem Browser.');
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('groups answered passes by tier with text labels, newest images first and soonest opportunities first', () => {
    const { all, confirmedNew, confirmedOld, soon, later } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all) } });
    expect(text()).toContain('Confirmed images: 0');
    expect(text()).toContain('Daily mosaics: 0 · Weather frames: 0 · Passes in range: 2');
    expect(rowNames('confirmed')).toEqual([confirmedNew.name, confirmedOld.name]);
    expect(rowNames('upcoming')).toEqual([soon.name, later.name]);
    for (const row of sheet().querySelectorAll('.ow-row')) expect(row.querySelector('.ow-tier-label')?.textContent?.trim()).not.toBe('');
  });

  it('keeps in-range and passed-overhead groups collapsed and unrendered until opened', () => {
    const { all, military, commercial } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all) } });
    for (const id of ['inRange', 'passed']) {
      const toggle = group(id)!.querySelector<HTMLButtonElement>('.ow-group-toggle')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(group(id)!.querySelectorAll('.ow-row')).toHaveLength(0);
    }
    group('inRange')!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.click();
    expect(group('inRange')!.querySelector('.ow-group-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(rowNames('inRange')).toEqual([military.name, commercial.name]);
    const militaryRow = group('inRange')!.querySelector<HTMLElement>(`.ow-row[data-tier="capability-overhead"]`)!;
    expect(militaryRow.querySelector('.ow-tier-label')?.textContent).toBe('capability overhead');
    expect(militaryRow.querySelector('img')).toBeNull();
  });

  it('headlines the confirmed count of a large result and leaves 900 in-range rows unrendered', () => {
    const passes = [
      ...Array.from({ length: 2 }, (_, i) => pass(`CONFIRMED ${i}`, 'sentinel-2', -10 - i, { kind: 'confirmed-image' })),
      ...Array.from({ length: 30 }, (_, i) => pass(`LIKELY ${i}`, 'sentinel-2', -20 - i, { kind: 'likely-imaged' })),
      ...Array.from({ length: 900 }, (_, i) => pass(`REACH ${i}`, 'worldview', -1 - i / 10, { kind: 'within-reach' })),
    ];
    mounted({ kind: 'passes', lookup: lookup(passes), archives: { kind: 'checking', total: 5, progress: progress(['earth-search', 'planetary-computer', 'gibs-daily-mosaics', 'gibs-geostationary'], [], passes) } });
    expect(text()).toContain('Checking archives: 4 of 5 answered');
    expect(text()).not.toMatch(/Confirmed images: \d/);

    const acquisitions = passes.slice(0, 2).map((p) => ({ platform: p.name, startMs: p.timeMs, pass: { noradId: p.noradId, timeMs: p.timeMs }, imageUrl: null }) as unknown as MatchedAcquisition);
    page().render({ kind: 'passes', lookup: lookup(passes), archives: { kind: 'answered', evidence: evidence(passes, { acquisitions }) } });
    expect(text()).toContain('Confirmed images: 2');
    expect(text()).toContain('Passes in range: 900');
    expect(rowNames('confirmed')).toHaveLength(2);
    expect(rowNames('likely')).toHaveLength(30);
    expect(group('inRange')!.querySelectorAll('.ow-row')).toHaveLength(0);
  });

  it('credits every image, labels a scene-wide cloud read, and lists empty sources as unavailable', () => {
    const { all, confirmedNew, confirmedOld } = tiered();
    const acquisitions = [
      { platform: 'sentinel-2c', profileId: 'sentinel-2', startMs: confirmedNew.timeMs, pass: { noradId: confirmedNew.noradId, timeMs: confirmedNew.timeMs }, imageUrl: 'https://earth-search.aws.element84.com/a.jpg', condition: 'unknown', cloudCoverPct: 12 },
      { platform: 'landsat-9', profileId: 'landsat', startMs: confirmedOld.timeMs, pass: { noradId: confirmedOld.noradId, timeMs: confirmedOld.timeMs }, imageUrl: 'https://planetarycomputer.microsoft.com/api/data/v1/b.png', condition: 'clear', cloudCoverPct: 40 },
    ] as unknown as MatchedAcquisition[];
    const mosaics = [
      { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS Terra', layer: 'm', noradId: 25994, days: [{ date: '2026-11-12', imageUrl: 'https://gibs.earthdata.nasa.gov/m.jpg' }] },
      { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'VIIRS Suomi NPP', layer: 'v', noradId: 37849, days: [] },
    ] as OrbitalEvidence['mosaics'];
    const frames = [{ kind: 'geostationary', archive: 'eumetsat', source: 'Meteosat-10', layer: 'x', noradId: 38552, cadenceMinutes: 15, latest: { time: '2026-11-13T11:45:00Z', imageUrl: 'https://view.eumetsat.int/x.png' } }] as OrbitalEvidence['frames'];
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all, { acquisitions, mosaics, frames }) } });

    const figure = (name: string) => [...sheet().querySelectorAll('.ow-row')].find((r) => r.textContent?.includes(name))!.querySelector('figure')!.textContent;
    expect(figure(confirmedNew.name)).toContain('12% cloud across the scene, this spot not checked');
    expect(figure(confirmedNew.name)).toContain('Contains modified Copernicus Sentinel data 2026');
    expect(figure(confirmedOld.name)).toContain('Landsat imagery courtesy of the U.S. Geological Survey');
    expect(text()).toContain('Daily mosaics: 1 · Weather frames: 1');

    for (const id of ['mosaic', 'frames']) group(id)!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.click();
    expect(figure('MODIS Terra')).toContain(IMAGE_CREDIT.gibsAcknowledgement);
    expect(figure('Meteosat-10')).toContain('Contains EUMETSAT Meteosat imagery');
    const viirs = [...group('mosaic')!.querySelectorAll<HTMLElement>('.ow-row')].find((r) => r.textContent?.includes('VIIRS Suomi NPP'))!;
    expect(viirs.querySelector('.ow-tier-label')?.textContent).toBe('unavailable');
    expect(viirs.querySelector('img')).toBeNull();
    expect(figure('Meteosat-10')).not.toContain('NASA');
    expect([...sheet().querySelectorAll('.ow-image-credit')].filter((c) => c.textContent === IMAGE_CREDIT.gibsAcknowledgement)).toHaveLength(1);
  });

  it('words its credits as the source attribution manifest does', () => {
    const attributions = (manifest as { entries: Array<{ attribution?: string }> }).entries.map((e) => e.attribution ?? '').join('\n');
    for (const credit of [IMAGE_CREDIT.copernicus(2026).replace(' 2026', ''), IMAGE_CREDIT.usgs, IMAGE_CREDIT.eumetsat, IMAGE_CREDIT.gibsAcknowledgement, IMAGE_CREDIT.celestrak]) {
      expect(attributions).toContain(credit);
    }
  });

  it('credits only the sources present in the current result', () => {
    const credits = () => [...sheet().querySelectorAll('.ow-credits li')].map((li) => li.textContent);
    const { all, confirmedNew, confirmedOld } = tiered();

    mounted({ kind: 'passes', lookup: lookup([]), archives: { kind: 'answered', evidence: evidence([]) } });
    expect(sheet().querySelector('.ow-credits')).toBeNull();

    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all) } });
    expect(credits()).toEqual([IMAGE_CREDIT.celestrak]);
    expect(sheet().querySelector<HTMLAnchorElement>('.ow-credits a')?.href).toBe('https://celestrak.org/');

    const acquisitions = [
      { platform: 'sentinel-2c', profileId: 'sentinel-2', startMs: confirmedNew.timeMs, pass: null, imageUrl: null, condition: 'clear', cloudCoverPct: 0 },
      { platform: 'sentinel-1a', profileId: 'sentinel-1', startMs: Date.UTC(2025, 11, 30), pass: null, imageUrl: null, condition: 'not-applicable', cloudCoverPct: null },
      { platform: 'landsat-9', profileId: 'landsat', startMs: confirmedOld.timeMs, pass: null, imageUrl: null, condition: 'clear', cloudCoverPct: 0 },
    ] as unknown as MatchedAcquisition[];
    const mosaics = [{ kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS Terra', layer: 'm', noradId: 25994, days: [{ date: '2026-11-12', imageUrl: null }] }] as OrbitalEvidence['mosaics'];
    const frames = [{ kind: 'geostationary', archive: 'eumetsat', source: 'Meteosat-10', layer: 'x', noradId: 38552, cadenceMinutes: 15, latest: { time: '2026-11-13T11:45:00Z', imageUrl: null } }] as OrbitalEvidence['frames'];
    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all, { acquisitions, mosaics, frames }) } });
    expect(credits()).toEqual([
      IMAGE_CREDIT.celestrak,
      'Contains modified Copernicus Sentinel data 2025-2026',
      IMAGE_CREDIT.usgs,
      IMAGE_CREDIT.gibsAcknowledgement,
      IMAGE_CREDIT.eumetsat,
    ]);

    const emptySources = [{ ...mosaics[0]!, days: [] }];
    const gibsFrame = [{ ...frames[0]!, archive: 'nasa-gibs', source: 'GOES-East' }] as OrbitalEvidence['frames'];
    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all, { mosaics: emptySources, frames: [{ ...frames[0]!, latest: null }] }) } });
    expect(credits()).toEqual([IMAGE_CREDIT.celestrak]);
    page().render({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all, { frames: gibsFrame }) } });
    expect(credits()).toEqual([IMAGE_CREDIT.celestrak, IMAGE_CREDIT.gibsAcknowledgement]);
  });

  it('says an aged-out open-mission pass is not in the archive only once the archives answered', () => {
    const { all, notInArchive } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all) } });
    group('passed')!.querySelector<HTMLButtonElement>('.ow-group-toggle')!.click();
    expect(rowNames('passed')).toEqual([notInArchive.name]);
    expect(group('passed')!.textContent).toContain('No image in the archive');
  });

  it('names the archives that failed and retries on request', () => {
    const { all } = tiered();
    const partial = evidence(all, { status: 'partial', failures: [{ archive: 'planetary-computer', reason: 'http-status', httpStatus: 503 }], unansweredProfiles: ['landsat'] });
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: partial } });
    expect(text()).toContain('Microsoft Planetary Computer did not answer');
    sheet().querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
  });

  it('names a layer that timed out while its archive answered other layers', () => {
    const { all } = tiered();
    const partial = evidence(all, {
      status: 'partial',
      failures: [
        { archive: 'earth-search', reason: 'timeout' },
        { archive: 'nasa-gibs', reason: 'timeout', source: 'GOES-West' },
      ],
    });
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: partial } });
    expect(text()).toContain('Earth Search, NASA GIBS (GOES-West) did not answer');
    expect(sheet().querySelector('[data-action="retry"]')).not.toBeNull();
  });

  it('warns about stale orbit data with its age', () => {
    const { all } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all, 'stale'), archives: { kind: 'answered', evidence: evidence(all) } });
    expect(text()).toContain('Orbit data is stale. The satellite catalog is 3 days old');
  });

  it('explains an empty result', () => {
    mounted({ kind: 'passes', lookup: lookup([]), archives: { kind: 'answered', evidence: evidence([]) } });
    expect(text()).toContain('No profiled imaging satellite passed over this point in the last 30 days or will in the next 48 hours.');
    expect(text()).toContain('This point stays in your browser');
  });

  it('walks pass rows with the arrow keys', () => {
    const { all } = tiered();
    mounted({ kind: 'passes', lookup: lookup(all), archives: { kind: 'answered', evidence: evidence(all) } });
    const rows = [...sheet().querySelectorAll<HTMLElement>('.ow-row')];
    rows[0]!.focus();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);
  });

  it('closes on Escape and hands focus back to the map', () => {
    const map = document.createElement('div');
    document.body.append(map);
    mounted(undefined, map);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(map);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('opening the lookup for a point', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    evidenceMock.mockReset();
  });
  afterEach(() => {
    document.querySelector<HTMLButtonElement>('.ow-close')?.click();
  });

  it('computes passes, then reports archive progress, then the answer', async () => {
    const { all } = tiered();
    const found = lookup(all);
    lookupMock.mockImplementation(async (_query, options) => {
      options.onProgress(3, 9);
      expect(text()).toContain('Computing passes: 3 of 9 satellites');
      return found;
    });
    let finish!: (value: OrbitalEvidence) => void;
    evidenceMock.mockImplementation((_lookup, options) => {
      options.onProgress(progress(['earth-search'], ['landsat'], all));
      return new Promise((resolve) => { finish = resolve; });
    });
    openOrbitalWatch(point, null);
    await vi.waitFor(() => expect(text()).toContain('Checking archives: 1 of 5 answered'));
    expect(lookupMock).toHaveBeenCalledWith({ point }, expect.anything());
    finish(evidence(all));
    await vi.waitFor(() => expect(text()).toContain('Confirmed images: 0'));
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
    expect(evidenceMock).not.toHaveBeenCalled();
    lookupMock.mockResolvedValueOnce(lookup([]));
    evidenceMock.mockResolvedValueOnce(evidence([]));
    sheet().querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    await vi.waitFor(() => expect(text()).toContain('No profiled imaging satellite passed over this point'));
  });
});
