import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const lookupMock = vi.hoisted(() => vi.fn());
const evidenceMock = vi.hoisted(() => vi.fn());
const catalogMock = vi.hoisted(() => vi.fn());

// The timeline's point context reads global feeds; the selection assertions need none of them.
vi.mock('@/services/orbital/point-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/point-context')>()),
  loadPointContext: () => new Promise(() => {}),
}));
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
import { openOrbitalShareLink, openOrbitalWatch, openOrbitalWatchSearch, type OrbitalTrackSurface } from '@/app/orbital-watch';
import { watchOrbitalRoute } from '@/app/orbital-route';
import { formatOrbitalTime, getOrbitalDisplayZone, setOrbitalDisplayZone } from '@/components/OrbitalWatchPage';
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
  catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 'test' }, passes, satellites: [], daylight: [], computedOn: 'worker',
});
function acquisition(p: PointPass): MatchedAcquisition {
  const platform = p.name.toLowerCase().replace(' ', '-');
  return {
    key: `${platform}:${p.timeMs}`, platform, profileId: p.profileId as MatchedAcquisition['profileId'], orbit: null, startMs: p.timeMs, endMs: p.timeMs + 20 * 60_000, items: [],
    pass: { noradId: p.noradId, timeMs: p.timeMs }, condition: 'clear', cloudCoverPct: 2, sunElevationDeg: 50, resolutionM: 10,
    imageUrl: `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/${platform}.png`,
  };
}

const evidence = (): OrbitalEvidence => ({ passes, acquisitions: passes.map(acquisition), mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] });

let tracks: Array<PassTrack | null>;
let markers: Array<TrackPoint | null>;
let targets: Array<OrbitalTarget | null>;
let surface: OrbitalTrackSurface;

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const row = (pass: PointPass) => sheet().querySelector<HTMLElement>(`.ies-row[data-key="pass:${pass.noradId}:${pass.timeMs}"]`);
const pick = (pass: PointPass) => row(pass)!.click();
const glyph = (pass: PointPass) => document.querySelector<HTMLElement>(`[data-pass="${pass.noradId}:${pass.timeMs}"]`);
const drawn = () => tracks.filter((track): track is PassTrack => track !== null);
const lastTrack = () => tracks[tracks.length - 1];
const pins = (list: Array<OrbitalTarget | null>) => list.map((target) => (target ? { lat: target.lat, lon: target.lon } : null));
const lastPin = () => targets[targets.length - 1];
async function openWithPasses(): Promise<void> {
  openOrbitalWatch(point, null, surface);
  await vi.waitFor(() => expect(row(ghost)).not.toBeNull());
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
  // The page paints archive images from blob: URLs it fetches; serve each a decodable image.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array(8)], { type: 'image/png' }))));
  vi.stubGlobal('createImageBitmap', async () => ({ close: () => {} }));
  let nextBlob = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:orbital/${nextBlob++}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  lookupMock.mockResolvedValue(lookup());
  evidenceMock.mockResolvedValue(evidence());
  catalogMock.mockResolvedValue(catalog());
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.ies-close')?.click();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.mocked(URL.createObjectURL).mockRestore();
  vi.mocked(URL.revokeObjectURL).mockRestore();
  vi.clearAllMocks();
});

describe('one pass selection for the list, the timeline and the maps', () => {
  it('draws a pass picked in the list on the map, with its footprint and the satellite at closest approach', async () => {
    await openWithPasses();
    expect(drawn()).toHaveLength(0);
    pick(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    const track = drawn()[0]!;
    expect(track.key).toBe(`${sentinel.noradId}:${sentinel.timeMs}`);
    expect(track.segments.flat().length).toBeGreaterThan(10);
    expect(track.footprint.length).toBeGreaterThan(0);
    expect(markers[markers.length - 1]).toEqual(track.closest);
    expect(row(sentinel)!.getAttribute('aria-current')).toBe('true');
    await vi.waitFor(() => expect(glyph(sentinel)?.classList.contains('is-selected'), 'the timeline marks the same pass').toBe(true));
  });

  it('selects a pass picked on the timeline in the list and on the map', async () => {
    await openWithPasses();
    const mark = () => document.querySelector<HTMLElement>('.ow-tl-bar[data-pass], .ow-tl-mark[data-pass]');
    await vi.waitFor(() => expect(mark()).not.toBeNull());
    const key = mark()!.dataset.pass!;
    mark()!.click();
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    expect(lastTrack()?.key).toBe(key);
    expect(sheet().querySelector(`.ies-row[data-key="pass:${key}"]`)!.getAttribute('aria-current')).toBe('true');
  });

  it('selects from the timeline by keyboard', async () => {
    await openWithPasses();
    await vi.waitFor(() => expect(glyph(sentinel)).not.toBeNull());
    expect(glyph(sentinel)!.tabIndex).toBe(0);
    glyph(sentinel)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    expect(row(sentinel)!.getAttribute('aria-current')).toBe('true');
  });

  it('replaces the first pass when a second is selected', async () => {
    await openWithPasses();
    pick(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    pick(landsat);
    await vi.waitFor(() => expect(drawn()).toHaveLength(2));
    expect(lastTrack()?.key).toBe(`${landsat.noradId}:${landsat.timeMs}`);
    expect(tracks.slice(tracks.indexOf(drawn()[0]!) + 1)[0]).toBeNull();
    expect(row(sentinel)!.hasAttribute('aria-current')).toBe(false);
  });

  it('labels the pin with the coordinates, and adds the acquisition once a pass is selected', async () => {
    await openWithPasses();
    expect(lastPin()?.lines).toEqual(['48.8500\u00b0N 2.3500\u00b0E']);
    pick(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    expect(lastPin()?.lines[1]).toBe(`ACQUIRED ${formatOrbitalTime(sentinel.timeMs, 'when')} · 10 M`);
  });

  it('stamps the acquisition in the zone the sheet displays', async () => {
    try {
      await openWithPasses();
      const { label } = getOrbitalDisplayZone();
      expect(label).not.toBe('UTC');
      pick(sentinel);
      await vi.waitFor(() => expect(drawn()).toHaveLength(1));
      expect(lastPin()?.lines[1]).toMatch(new RegExp(` ${label.replace(/[+]/g, '\\+')} · 10 M$`));
    } finally {
      setOrbitalDisplayZone('UTC', 'UTC');
    }
  });

  it('pins the looked-up point while the sheet is open and removes the pin and track on close', async () => {
    await openWithPasses();
    expect(pins(targets)).toEqual([point]);
    pick(sentinel);
    await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    sheet().querySelector<HTMLButtonElement>('.ies-close')!.click();
    expect(lastPin()).toBeNull();
    expect(lastTrack()).toBeNull();
    expect(markers[markers.length - 1]).toBeNull();
  });

  it('moves the pin to another map when the sheet reopens there', async () => {
    await openWithPasses();
    const other: Array<OrbitalTarget | null> = [];
    const next = { lat: -17.7, lon: 178.5 };
    openOrbitalWatch(next, null, { setOrbitalTrack: () => {}, setOrbitalTrackMarker: () => {}, setOrbitalTarget: (target) => other.push(target) });
    expect(pins(targets)).toEqual([point, null]);
    expect(pins(other)).toEqual([next]);
  });

  it('pins a shared link and a searched lookup on the map they were opened from', async () => {
    await openWithPasses();
    const shared: Array<OrbitalTarget | null> = [];
    const surfaceFor = (sink: Array<OrbitalTarget | null>): OrbitalTrackSurface =>
      ({ setOrbitalTrack: () => {}, setOrbitalTrackMarker: () => {}, setOrbitalTarget: (target) => sink.push(target) });
    const next = { lat: -17.7, lon: 178.5 };
    openOrbitalShareLink({ point: next, pass: null, view: 'sheet' }, null, surfaceFor(shared));
    expect(pins(shared)).toEqual([next]);
    const searched: Array<OrbitalTarget | null> = [];
    openOrbitalWatchSearch(null, surfaceFor(searched));
    expect(pins(shared)).toEqual([next, null]);
    expect(pins(searched)).toEqual([next]);
  });

  it('draws a pass on the map after opening from a shared link', async () => {
    history.replaceState(null, '', `#orbital=${point.lat},${point.lon}`);
    const unwatch = watchOrbitalRoute(() => surface);
    try {
      await vi.waitFor(() => expect(row(sentinel)).not.toBeNull());
      pick(sentinel);
      await vi.waitFor(() => expect(drawn()).toHaveLength(1));
    } finally {
      unwatch();
      history.replaceState(null, '', window.location.pathname);
    }
  });

  it('draws no track when the catalog fails to load, and keeps the selection', async () => {
    catalogMock.mockRejectedValue(new Error('offline'));
    await openWithPasses();
    pick(sentinel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn()).toHaveLength(0);
    expect(row(sentinel)!.getAttribute('aria-current')).toBe('true');
  });

  it('drops a track that finishes loading after the sheet closed', async () => {
    let release!: () => void;
    catalogMock.mockReturnValue(new Promise((resolve) => { release = () => resolve(catalog()); }));
    await openWithPasses();
    pick(sentinel);
    sheet().querySelector<HTMLButtonElement>('.ies-close')!.click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn()).toHaveLength(0);
  });

  it('draws nothing and reports no error for a pass with no orbit to trace', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openWithPasses();
    pick(ghost);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn()).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
