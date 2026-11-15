import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n, tt } from './helpers/i18n.mts';

const lookupMock = vi.hoisted(() => vi.fn());
const evidenceMock = vi.hoisted(() => vi.fn());
const coverage = vi.hoisted(() => ({
  sites: vi.fn(),
  covering: vi.fn(),
  tracked: vi.fn(),
  fetchTles: vi.fn(),
}));

vi.mock('@/services/orbital/point-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/point-context')>()),
  loadPointContext: () => new Promise(() => {}),
}));
vi.mock('@/services/orbital/pass-client', () => ({ getOrbitalPassClient: () => ({ lookup: lookupMock, dispose: () => {} }) }));
vi.mock('@/services/orbital/match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/match')>()),
  findArchiveEvidence: evidenceMock,
}));
vi.mock('@/services/orbital/catalog', () => ({ loadOrbitalCatalog: async () => ({ satellites: [] }) }));
vi.mock('@/services/orbital/satellite-site-coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/satellite-site-coverage')>()),
  loadWatchedSites: coverage.sites,
  satellitesCoveringSite: coverage.covering,
}));
vi.mock('@/services/satellites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/satellites')>()),
  getTrackedSatelliteTles: coverage.tracked,
  fetchSatelliteTLEs: coverage.fetchTles,
}));

import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { OrbitalEvidence } from '@/services/orbital/match';
import type { SiteSatellite } from '@/services/orbital/satellite-site-coverage';
import { openOrbitalWatch, type OrbitalTrackSurface } from '@/app/orbital-watch';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const HOUR = 3_600_000;
const site = { id: 'military-bases:abc', name: 'Test Air Base', lat: 48.85, lon: 2.35, countryCode: 'FR' };
const sitePoint = { lat: 48.85, lon: 2.35 };
const tle = { noradId: '40697', name: 'SENTINEL-2A', line1: '1', line2: '2', type: 'civil', country: 'ESA' };

const pointPass = (noradId: number, name: string, timeMs: number): PointPass => ({
  noradId, name, profileId: 'sentinel-2', category: 'open-optical', timeMs, elevationDeg: 70, rangeKm: 800,
  groundDistanceKm: 40, inFootprint: true, coverage: true, direction: 'descending', sunElevationDeg: 40,
  tier: { kind: 'opportunity' }, elementsEpochMs: NOW - HOUR, orbitAgeDays: 0.1,
} as unknown as PointPass);
const sentinelPass = pointPass(40697, 'SENTINEL-2A', NOW + 3 * HOUR);
const passes = [sentinelPass];

const lookup = (point = sitePoint): PointPassLookup => ({
  point, window: { startMs: NOW - 48 * HOUR, endMs: NOW + 24 * HOUR }, nowMs: NOW,
  catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 'test' }, passes, satellites: [], daylight: [], computedOn: 'worker',
});
const evidence = (): OrbitalEvidence => ({ passes, acquisitions: [], mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] });

const covering = (noradId: string, name: string, timeMs: number): SiteSatellite => ({
  noradId, name, sensor: { profileId: 'sentinel-2', family: 'Sentinel-2', category: 'open-optical' },
  passes: [{ timeMs, groundDistanceKm: 41.6, edgeOfSwath: false, direction: 'descending', tier: 'opportunity' }],
});

const section = () => document.querySelector<HTMLElement>('[data-section="site-satellites"]');
let tracks: unknown[];
let surface: OrbitalTrackSurface;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  tracks = [];
  surface = { setOrbitalTrack: (track) => tracks.push(track), setOrbitalTrackMarker: () => {}, setOrbitalTarget: () => {} };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array(8)], { type: 'image/png' }))));
  vi.stubGlobal('createImageBitmap', async () => ({ close: () => {} }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:orbital/0');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  lookupMock.mockResolvedValue(lookup());
  evidenceMock.mockResolvedValue(evidence());
  coverage.sites.mockResolvedValue([site]);
  coverage.tracked.mockReturnValue([tle]);
  coverage.fetchTles.mockResolvedValue(null);
  coverage.covering.mockResolvedValue([
    // The layer's element set puts the approach a minute off the lookup's catalog pass.
    covering('40697', 'SENTINEL-2A', sentinelPass.timeMs + 60_000),
    covering('99001', 'LAYER-ONLY SAT', NOW + 5 * HOUR),
  ]);
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.ies-close')?.click();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('#10713 unit 3: a watched site links back to the satellites covering it', () => {
  it('lists the tracked satellites over the site, and a row selects its pass in the sheet and on the map', async () => {
    openOrbitalWatch(sitePoint, null, surface);
    await vi.waitFor(() => expect(section()?.dataset.state).toBe('ok'));
    expect(coverage.covering).toHaveBeenCalledWith(expect.objectContaining({ site, tles: [tle] }));
    expect(section()!.querySelector('.ies-section-title')!.textContent).toBe(tt('orbitalWatch.siteSatellites.heading', { hours: 24 }));

    const linked = section()!.querySelector<HTMLElement>(`.ies-row[data-key="pass:40697:${sentinelPass.timeMs}"]`)!;
    expect(linked.textContent).toContain('SENTINEL-2A');
    expect(linked.textContent).toContain('Sentinel-2');
    const unlisted = section()!.querySelector<HTMLElement>('[data-norad-id="99001"]')!;
    expect(unlisted.classList.contains('ies-static-row')).toBe(true);
    expect(unlisted.hasAttribute('tabindex')).toBe(false);

    linked.click();
    await vi.waitFor(() => expect(section()!.querySelector(`[data-key="pass:40697:${sentinelPass.timeMs}"]`)!.getAttribute('aria-current')).toBe('true'));
    expect(document.querySelectorAll(`[data-section="capability"] .ies-row[aria-current="true"], [data-section="windows"] .ies-row[aria-current="true"]`).length).toBeGreaterThan(0);
  });

  it('adds no section to a point that is not a watched site', async () => {
    const other = { lat: 10, lon: 20 };
    lookupMock.mockResolvedValue(lookup(other));
    openOrbitalWatch(other, null, surface);
    await vi.waitFor(() => expect(document.querySelector('[data-section="windows"]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(section()).toBeNull();
    expect(coverage.covering).not.toHaveBeenCalled();
  });

  it('says the orbit elements did not load when neither the layer nor the feed has them', async () => {
    coverage.tracked.mockReturnValue([]);
    openOrbitalWatch(sitePoint, null, surface);
    await vi.waitFor(() => expect(section()?.dataset.state).toBe('not-loaded'));
    expect(coverage.fetchTles).toHaveBeenCalled();
    expect(section()!.textContent).toContain(tt('orbitalWatch.siteSatellites.notLoaded'));
  });

  it('folds a busy site after the first rows, and keeps the fold open when the sheet redraws', async () => {
    const many = Array.from({ length: 9 }, (_, i) => covering(String(99100 + i), `SAT-${i}`, NOW + (i + 4) * HOUR));
    coverage.covering.mockResolvedValue(many);
    let answer!: (value: OrbitalEvidence) => void;
    evidenceMock.mockReturnValue(new Promise<OrbitalEvidence>((resolve) => { answer = resolve; }));
    openOrbitalWatch(sitePoint, null, surface);
    await vi.waitFor(() => expect(section()?.dataset.state).toBe('ok'));
    const visible = () => [...section()!.querySelectorAll<HTMLElement>('[data-norad-id]')].filter((row) => !row.hidden).length;
    expect(visible()).toBe(6);
    const more = section()!.querySelector<HTMLButtonElement>('.ies-more')!;
    expect(more.textContent).toBe(tt('orbitalWatch.capability.showAll', { count: 9 }));
    more.click();
    expect(visible()).toBe(9);
    answer(evidence());
    await vi.waitFor(() => expect(evidenceMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(visible()).toBe(9);
    expect(section()!.querySelector('.ies-more')!.textContent).toBe(tt('orbitalWatch.capability.showFewer'));
  });

  it('says no tracked satellite covers the site in the window', async () => {
    coverage.covering.mockResolvedValue([]);
    openOrbitalWatch(sitePoint, null, surface);
    await vi.waitFor(() => expect(section()?.dataset.state).toBe('ok'));
    expect(section()!.textContent).toContain(tt('orbitalWatch.siteSatellites.none', { hours: 24 }));
  });
});
