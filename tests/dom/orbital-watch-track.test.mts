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

import { findPasses, parseOrbitElements, type OmmRecord } from '../../shared/orbital/pass-geometry.js';
import { matchSensorProfile } from '../../shared/orbital/sensor-profiles.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { MatchedAcquisition, OrbitalEvidence } from '@/services/orbital/match';
import type { OrbitalTarget, PassTrack, TrackPoint } from '@/services/orbital/track-geometry';
import { openOrbitalWatch, type OrbitalTrackSurface } from '@/app/orbital-watch';
import { watchOrbitalRoute } from '@/app/orbital-route';
import { formatOrbitalTime, setOrbitalDisplayZone } from '@/components/OrbitalWatchPage';
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
function acquisition(p: PointPass): MatchedAcquisition {
  const platform = p.name.toLowerCase().replace(' ', '-');
  return {
    key: `${platform}:${p.timeMs}`, platform, profileId: p.profileId as MatchedAcquisition['profileId'], orbit: null, startMs: p.timeMs, endMs: p.timeMs, items: [],
    pass: { noradId: p.noradId, timeMs: p.timeMs }, condition: 'clear', cloudCoverPct: 2, sunElevationDeg: 50, resolutionM: 10,
    imageUrl: `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/${platform}.png`,
  };
}

const evidence = (): OrbitalEvidence => ({ passes, acquisitions: passes.map(acquisition), mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] });

let tracks: Array<PassTrack | null>;
let markers: Array<TrackPoint | null>;
let targets: Array<OrbitalTarget | null>;
let surface: OrbitalTrackSurface;
let frames: Map<number, FrameRequestCallback>;
let reducedMotion: boolean;

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const replayButton = (pass: PointPass) => sheet().querySelector<HTMLButtonElement>(`.ow-replay[data-norad="${pass.noradId}"][data-time="${pass.timeMs}"]`);
const replay = (pass: PointPass) => replayButton(pass)!.click();
const slot = () => sheet().querySelector<HTMLElement>('[data-slot="replay-hud"]')!;
const drawn = () => tracks.filter((track): track is PassTrack => track !== null);
const lastTrack = () => tracks[tracks.length - 1];
const pins = (list: Array<OrbitalTarget | null>) => list.map((target) => (target ? { lat: target.lat, lon: target.lon } : null));
const lastPin = () => targets[targets.length - 1];
const hud = () => document.querySelector<HTMLElement>('.ow-replay-hud');
const toggle = () => document.querySelector<HTMLButtonElement>('[data-action="replay-toggle"]');
const scrub = () => document.querySelector<HTMLInputElement>('[data-action="replay-scrub"]');

async function openWithPasses(): Promise<void> {
  openOrbitalWatch(point, null, 'sheet', surface);
  await vi.waitFor(() => expect(replayButton(ghost)).not.toBeNull());
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

describe('replayed pass ground track', () => {
  it('draws the replayed pass on the map and mounts the HUD into the replay slot', async () => {
    await openWithPasses();
    expect(slot().childElementCount).toBe(0);
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    const track = drawn()[0]!;
    expect(track.key).toBe(`${sentinel.noradId}:${sentinel.timeMs}`);
    expect(track.segments.flat().length).toBeGreaterThan(10);
    expect(track.footprint.length).toBeGreaterThan(0);
    expect(track.swath.length).toBeGreaterThan(0);
    expect(slot().contains(hud())).toBe(true);
    expect(slot().contains(toggle())).toBe(true);
    expect(toggle()?.getAttribute('aria-label')).toBe('Pause replay');
    expect(scrub()?.value).toBe('0');
    expect(slot().querySelector('.ow-hud-reduced')).toBeNull();
    expect(hud()?.querySelector('.ow-hud-label')?.textContent).toBe(`ACQUISITION · ${sentinel.name.toUpperCase()}`);
    expect(hud()?.querySelector('.ow-hud-countdown')?.textContent).toMatch(/^T\u2212\d\d:\d\d:\d\d$/);
    expect(frames.size).toBe(1);
  });

  it('counts down to acquisition, pauses, and seeks from the scrubber', async () => {
    await openWithPasses();
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    toggle()!.click();
    expect(frames.size).toBe(0);
    expect(toggle()?.getAttribute('aria-label')).toBe('Play replay');
    scrub()!.value = '1000';
    scrub()!.dispatchEvent(new Event('input'));
    expect(markers[markers.length - 1]?.timeMs).toBe(sentinel.timeMs);
    expect(hud()?.querySelector('.ow-hud-countdown')?.textContent).toBe('T\u221200:00:00');
    expect(slot().querySelector('.ow-hud-short')?.textContent).toBe('T\u221200:00');
    toggle()!.click();
    expect(frames.size).toBe(1);
  });

  it('labels the pin with the coordinates, and adds the acquisition once a pass is replayed', async () => {
    await openWithPasses();
    expect(lastPin()?.lines).toEqual(['48.8500\u00b0N 2.3500\u00b0E']);
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    expect(lastPin()?.lines[0]).toBe('48.8500\u00b0N 2.3500\u00b0E');
    expect(lastPin()?.lines[1]).toBe(`ACQUIRED ${formatOrbitalTime(sentinel.timeMs, 'when')} · 10 M`);
  });

  it('stamps the acquisition in the zone the sheet displays', async () => {
    setOrbitalDisplayZone('Asia/Dubai', 'GST');
    try {
      await openWithPasses();
      replay(sentinel);
      await vi.waitFor(() => expect(drawn()).toHaveLength(1));
      expect(lastPin()?.lines[1]).toMatch(/ GST · 10 M$/);
    } finally {
      setOrbitalDisplayZone('UTC', 'UTC');
    }
  });

  it('pins the looked-up point while the sheet is open and removes the pin on close', async () => {
    await openWithPasses();
    expect(pins(targets)).toEqual([point]);
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    expect(pins(targets).every((pin) => pin?.lat === point.lat && pin.lon === point.lon)).toBe(true);
    sheet().querySelector<HTMLButtonElement>('.ow-close')!.click();
    expect(lastPin()).toBeNull();
    expect(hud()).toBeNull();
  });

  it('moves the pin to another map when the sheet reopens there', async () => {
    await openWithPasses();
    const other: Array<OrbitalTarget | null> = [];
    const next = { lat: -17.7, lon: 178.5 };
    openOrbitalWatch(next, null, 'sheet', { setOrbitalTrack: () => {}, setOrbitalTrackMarker: () => {}, setOrbitalTarget: (target) => other.push(target) });
    expect(pins(targets)).toEqual([point, null]);
    expect(pins(other)).toEqual([next]);
  });

  it('replaces the first pass when a second is replayed', async () => {
    await openWithPasses();
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    replay(landsat);
    await vi.waitFor(() => expect(drawn()).toHaveLength(2));
    expect(lastTrack()?.key).toBe(`${landsat.noradId}:${landsat.timeMs}`);
    expect(tracks.slice(tracks.indexOf(drawn()[0]!) + 1)[0]).toBeNull();
    expect(slot().querySelectorAll('.ow-replay-hud')).toHaveLength(1);
    expect(hud()?.querySelector('.ow-hud-label')?.textContent).toBe(`ACQUISITION · ${landsat.name.toUpperCase()}`);
    expect(frames.size).toBe(1);
  });

  it('closes the sheet on Escape from the scrubber, but keeps arrow keys on the scrubber', async () => {
    await openWithPasses();
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    const reachedDocument: string[] = [];
    const listen = (event: KeyboardEvent) => reachedDocument.push(event.key);
    document.addEventListener('keydown', listen);
    scrub()!.focus();
    scrub()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    scrub()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', listen);
    expect(reachedDocument).toEqual(['Escape']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(lastTrack()).toBeNull();
  });

  it('replays a pass on the map after opening from a shared link', async () => {
    history.replaceState(null, '', `#orbital=${point.lat},${point.lon}`);
    const unwatch = watchOrbitalRoute(() => surface);
    try {
      await vi.waitFor(() => expect(replayButton(sentinel)).not.toBeNull());
      replay(sentinel);
      await vi.waitFor(() => expect(drawn()).toHaveLength(1));
      expect(hud()).not.toBeNull();
    } finally {
      unwatch();
      history.replaceState(null, '', window.location.pathname);
    }
  });

  it('removes the track and stops the replay when the sheet closes', async () => {
    await openWithPasses();
    replay(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    sheet().querySelector<HTMLButtonElement>('.ow-close')!.click();
    expect(lastTrack()).toBeNull();
    expect(frames.size).toBe(0);
    expect(hud()).toBeNull();
  });

  it('offers replay controls only once the track is on the map', async () => {
    let release!: () => void;
    catalogMock.mockReturnValue(new Promise((resolve) => { release = () => resolve(catalog()); }));
    await openWithPasses();
    replay(sentinel);
    expect(toggle()).toBeNull();
    release();
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
  });

  it('says the track could not be drawn when the catalog fails to load', async () => {
    catalogMock.mockRejectedValue(new Error('offline'));
    await openWithPasses();
    replay(sentinel);
    await vi.waitFor(() => expect(slot().textContent).toContain("This pass's ground track couldn't be drawn"));
    expect(toggle()).toBeNull();
    expect(drawn()).toHaveLength(0);
  });

  it('drops a track that finishes loading after the sheet closed', async () => {
    let release!: () => void;
    catalogMock.mockReturnValue(new Promise((resolve) => { release = () => resolve(catalog()); }));
    await openWithPasses();
    replay(sentinel);
    sheet().querySelector<HTMLButtonElement>('.ow-close')!.click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn()).toHaveLength(0);
  });

  it('places the marker at closest approach without animating under reduced motion, and labels the state', async () => {
    reducedMotion = true;
    await openWithPasses();
    replay(sentinel);
    await vi.waitFor(() => expect(markers).toHaveLength(1));
    expect(markers[0]).toEqual({ lon: sentinel.subSatellite.lon, lat: sentinel.subSatellite.lat, timeMs: sentinel.timeMs });
    expect(frames.size).toBe(0);
    expect(slot().querySelector('.ow-replay-controls .ow-hud-reduced')?.textContent).toBe('REDUCED MOTION');
    expect(hud()?.querySelector('.ow-hud-reduced')?.textContent).toBe('REDUCED MOTION');
    expect(hud()?.querySelector('.ow-hud-countdown')?.textContent).toBe('T\u221200:00:00');
    expect(scrub()?.value).toBe('1000');
    toggle()!.click();
    expect(markers).toHaveLength(2);
    expect(markers[1]).toEqual(markers[0]);
    expect(frames.size).toBe(0);
  });

  it('draws nothing and reports no error for a pass with no orbit to trace', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openWithPasses();
    replay(ghost);
    await vi.waitFor(() => expect(slot().textContent).toContain("This pass's ground track couldn't be drawn"));
    expect(drawn()).toHaveLength(0);
    expect(toggle()).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
