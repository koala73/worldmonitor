import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const lookupMock = vi.hoisted(() => vi.fn());
const evidenceMock = vi.hoisted(() => vi.fn());
const catalogMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/orbital/pass-client', () => ({ getOrbitalPassClient: () => ({ lookup: lookupMock, dispose: () => {} }) }));
vi.mock('@/services/orbital/match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/match')>()),
  findArchiveEvidence: evidenceMock,
}));
vi.mock('@/services/orbital/catalog', () => ({ loadOrbitalCatalog: catalogMock }));

import { findPasses, parseOrbitElements, type GeoPoint, type OmmRecord } from '../../shared/orbital/pass-geometry.js';
import { matchSensorProfile } from '../../shared/orbital/sensor-profiles.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { OrbitalEvidence } from '@/services/orbital/match';
import type { PassTrack, TrackPoint } from '@/services/orbital/track-geometry';
import { openOrbitalWatch, type OrbitalTrackSurface } from '@/app/orbital-watch';
import fixture from '../fixtures/orbital/celestrak-gp-2026-11-13.json';

const records = fixture.records as OmmRecord[];
const NOW = Date.parse('2026-11-13T12:00:00Z');
const HOUR = 3_600_000;
const point = { lat: 48.85, lon: 2.35 };

function passesOf(name: string): PointPass[] {
  const omm = records.find((record) => record.OBJECT_NAME === name)!;
  const elements = parseOrbitElements(omm);
  const profile = matchSensorProfile(elements.noradId, elements.name)!;
  const result = findPasses({ elements, profile, point, window: { start: NOW - 48 * HOUR, end: NOW }, now: NOW });
  return result.passes.map((pass) => ({ ...pass, tier: { kind: 'within-reach' } as const, elementsEpochMs: elements.epochMs, orbitAgeDays: 1 }));
}

const sentinel = passesOf('SENTINEL-2A')[0]!;
const landsat = passesOf('LANDSAT 9')[0]!;
const ghost: PointPass = { ...sentinel, noradId: 1, name: 'NOT IN CATALOG', timeMs: sentinel.timeMs + 1 };
const passes = [sentinel, landsat, ghost];

const catalog = () => ({
  status: 'fresh' as const, fetchedAt: NOW, inventoryVersion: 'test',
  satellites: ['SENTINEL-2A', 'LANDSAT 9'].map((name) => {
    const omm = records.find((record) => record.OBJECT_NAME === name)!;
    const elements = parseOrbitElements(omm);
    return { noradId: elements.noradId, name, profileId: matchSensorProfile(elements.noradId, name)!.id, elementSets: [omm] };
  }),
});

const lookup = (): PointPassLookup => ({
  point, window: { startMs: NOW - 48 * HOUR, endMs: NOW + 24 * HOUR }, nowMs: NOW,
  catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 'test' }, passes, satellites: [], computedOn: 'worker',
});
const evidence = (): OrbitalEvidence => ({ passes, acquisitions: [], mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] });

let tracks: Array<PassTrack | null>;
let markers: Array<TrackPoint | null>;
let targets: Array<GeoPoint | null>;
let surface: OrbitalTrackSurface;
let frames: Map<number, FrameRequestCallback>;
let reducedMotion: boolean;

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const row = (pass: PointPass) => sheet().querySelector<HTMLElement>(`.ow-row[data-pass-key="${pass.noradId}:${pass.timeMs}"]`)!;
const drawn = () => tracks.filter((track): track is PassTrack => track !== null);
const lastTrack = () => tracks[tracks.length - 1];

async function openWithPasses(): Promise<void> {
  openOrbitalWatch(point, null, surface);
  await vi.waitFor(() => expect(sheet().textContent).toContain('Confirmed images: 0'));
  sheet().querySelector<HTMLButtonElement>('.ow-group-toggle[data-group="inRange"]')!.click();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  tracks = [];
  markers = [];
  targets = [];
  surface = {
    setOrbitalTrack: (track) => tracks.push(track),
    setOrbitalTrackMarker: (marker) => markers.push(marker),
    setOrbitalTarget: (target) => targets.push(target),
  };
  frames = new Map();
  let nextFrame = 1;
  reducedMotion = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(nextFrame, callback); return nextFrame++; });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames.delete(handle); });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reducedMotion && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
  lookupMock.mockResolvedValue(lookup());
  evidenceMock.mockResolvedValue(evidence());
  catalogMock.mockResolvedValue(catalog());
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.ow-close')?.click();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('selected pass ground track', () => {
  it('draws the chosen pass on the map, marks its row and offers a replay', async () => {
    await openWithPasses();
    row(sentinel).click();
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    const track = drawn()[0]!;
    expect(track.key).toBe(`${sentinel.noradId}:${sentinel.timeMs}`);
    expect(track.segments.flat().length).toBeGreaterThan(10);
    expect(track.footprint.length).toBeGreaterThan(0);
    expect(row(sentinel).getAttribute('aria-current')).toBe('true');
    expect(row(sentinel).textContent).toContain('Ground track and footprint shown on the map');
    expect(row(sentinel).querySelector('[data-action="replay"]')?.textContent).toBe('Replay pass');
    expect(row(sentinel).querySelector('.ow-track-motion')).toBeNull();
    expect(frames.size).toBe(1);
  });

  it('pins the looked-up point while the sheet is open and removes the pin on close', async () => {
    await openWithPasses();
    expect(targets).toEqual([point]);
    row(sentinel).click();
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    expect(targets).toEqual([point]);
    sheet().querySelector<HTMLButtonElement>('.ow-close')!.click();
    expect(targets).toEqual([point, null]);
  });

  it('moves the pin to another map when the sheet reopens there', async () => {
    await openWithPasses();
    const other: Array<GeoPoint | null> = [];
    const next = { lat: -17.7, lon: 178.5 };
    openOrbitalWatch(next, null, { setOrbitalTrack: () => {}, setOrbitalTrackMarker: () => {}, setOrbitalTarget: (target) => other.push(target) });
    expect(targets).toEqual([point, null]);
    expect(other).toEqual([next]);
  });

  it('replaces the first pass when a second is chosen', async () => {
    await openWithPasses();
    row(sentinel).click();
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    row(landsat).click();
    await vi.waitFor(() => expect(drawn()).toHaveLength(2));
    expect(lastTrack()?.key).toBe(`${landsat.noradId}:${landsat.timeMs}`);
    expect(tracks.slice(tracks.indexOf(drawn()[0]!) + 1)[0]).toBeNull();
    expect(sheet().querySelectorAll('.ow-row[aria-current="true"]')).toHaveLength(1);
    expect(row(landsat).getAttribute('aria-current')).toBe('true');
  });

  it('selects a pass from the keyboard', async () => {
    await openWithPasses();
    row(landsat).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(lastTrack()?.key).toBe(`${landsat.noradId}:${landsat.timeMs}`));
    expect(document.activeElement).toBe(row(landsat));
  });

  it('removes the track and stops the replay when the sheet closes', async () => {
    await openWithPasses();
    row(sentinel).click();
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    sheet().querySelector<HTMLButtonElement>('.ow-close')!.click();
    expect(lastTrack()).toBeNull();
    expect(frames.size).toBe(0);
  });

  it('offers a replay only once the track is on the map', async () => {
    let release!: () => void;
    catalogMock.mockReturnValue(new Promise((resolve) => { release = () => resolve(catalog()); }));
    await openWithPasses();
    row(sentinel).click();
    expect(row(sentinel).getAttribute('aria-current')).toBe('true');
    expect(row(sentinel).querySelector('[data-action="replay"]')).toBeNull();
    expect(row(sentinel).textContent).not.toContain('Ground track and footprint shown on the map');
    release();
    await vi.waitFor(() => expect(row(sentinel).querySelector('[data-action="replay"]')).not.toBeNull());
  });

  it('says the track could not be drawn when the catalog fails to load', async () => {
    catalogMock.mockRejectedValue(new Error('offline'));
    await openWithPasses();
    row(sentinel).click();
    await vi.waitFor(() => expect(row(sentinel).textContent).toContain("This pass's ground track couldn't be drawn"));
    expect(row(sentinel).querySelector('[data-action="replay"]')).toBeNull();
    expect(drawn()).toHaveLength(0);
  });

  it('drops a track that finishes loading after the sheet closed', async () => {
    let release!: () => void;
    catalogMock.mockReturnValue(new Promise((resolve) => { release = () => resolve(catalog()); }));
    await openWithPasses();
    row(sentinel).click();
    sheet().querySelector<HTMLButtonElement>('.ow-close')!.click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn()).toHaveLength(0);
  });

  it('places the marker at closest approach without animating under reduced motion, and on replay', async () => {
    reducedMotion = true;
    await openWithPasses();
    row(sentinel).click();
    await vi.waitFor(() => expect(markers).toHaveLength(1));
    expect(markers[0]).toEqual({ lon: sentinel.subSatellite.lon, lat: sentinel.subSatellite.lat, timeMs: sentinel.timeMs });
    expect(frames.size).toBe(0);
    expect(row(sentinel).querySelector('.ow-track-motion')?.textContent).toBe('Reduced motion is on: the marker stays at closest approach');
    row(sentinel).querySelector<HTMLButtonElement>('[data-action="replay"]')!.click();
    expect(markers).toHaveLength(2);
    expect(markers[1]).toEqual(markers[0]);
    expect(frames.size).toBe(0);
  });

  it('draws nothing and reports no error for a pass with no orbit to trace', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openWithPasses();
    row(ghost).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn()).toHaveLength(0);
    expect(row(ghost).getAttribute('aria-current')).toBe('true');
    expect(row(ghost).textContent).toContain("This pass's ground track couldn't be drawn");
    expect(row(ghost).querySelector('[data-action="replay"]')).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
