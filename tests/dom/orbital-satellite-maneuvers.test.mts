import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n, restoreEnglish } from './helpers/i18n.mts';

// #9110: a satellite's card and a watched site's satellite rows say when its orbit elements
// showed a candidate manoeuvre. The list is read from the public RPC; failures leave it out.
const mocks = vi.hoisted(() => ({
  listSatelliteManeuvers: vi.fn(),
  getTrackedSatelliteTle: vi.fn(() => null as unknown),
  sitesCoveredBySatellite: vi.fn(),
}));
vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/generated-rpc-clients')>(),
  OrbitalServiceClient: class { listSatelliteManeuvers(request: unknown) { return mocks.listSatelliteManeuvers(request); } },
}));
vi.mock('@/services/satellites', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/satellites')>(),
  getTrackedSatelliteTle: mocks.getTrackedSatelliteTle,
}));
vi.mock('@/services/orbital/satellite-site-coverage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/orbital/satellite-site-coverage')>(),
  loadWatchedSites: async () => [],
  sitesCoveredBySatellite: mocks.sitesCoveredBySatellite,
}));

import type { ListSatelliteManeuversResponse, ManeuverCandidate } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import { maneuverNote, renderSatelliteSites } from '@/components/orbital-satellite-sites-view';
import { siteSatellitesSection } from '@/components/orbital-site-satellites-view';
import { loadRecentManeuvers, MANEUVER_MARKER_DAYS, recentManeuvers, resetManeuverCache } from '@/services/orbital/satellite-maneuvers';

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const DAY_MS = 86_400_000;
const set = (epoch: number, semiMajorAxisKm: number) => ({ epoch, meanMotion: 14.3, semiMajorAxisKm, eccentricity: 0.0001, inclination: 98.56, raan: 28.3, bstar: 0.0001 });

function candidate(overrides: Partial<ManeuverCandidate> = {}): ManeuverCandidate {
  return {
    noradId: 40697, element: 'semiMajorAxis', unit: 'km', regime: 'leo',
    fromEpoch: Date.parse('2026-11-13T15:03:05.963Z'), toEpoch: Date.parse('2026-11-14T15:03:05.963Z'), confirmedByEpoch: Date.parse('2026-11-15T15:03:05.963Z'),
    expected: 7164.1, observed: 7165.3, residual: 1.2, threshold: 0.2,
    before: set(Date.parse('2026-11-13T15:03:05.963Z'), 7164.1), after: set(Date.parse('2026-11-14T15:03:05.963Z'), 7165.3),
    ...overrides,
  };
}

function response(candidates: ManeuverCandidate[], stale = false): ListSatelliteManeuversResponse {
  return { candidates, satellites: [], evaluatedSatellites: candidates.length, generatedAt: NOW, detectionVersion: 1, methodNote: '', stale };
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(async () => {
  await restoreEnglish();
  document.body.replaceChildren();
  resetManeuverCache();
  mocks.listSatelliteManeuvers.mockReset();
  mocks.getTrackedSatelliteTle.mockReset().mockReturnValue(null);
  mocks.sitesCoveredBySatellite.mockReset();
});

describe('recentManeuvers', () => {
  it('keeps each satellite\'s newest candidate from the last two weeks', () => {
    const older = candidate({ toEpoch: Date.parse('2026-11-10T00:00:00Z'), element: 'inclination' });
    const newest = candidate();
    const expired = candidate({ noradId: 1, toEpoch: NOW - (MANEUVER_MARKER_DAYS + 1) * DAY_MS });
    const map = recentManeuvers(response([older, newest, expired]), NOW);
    expect([...map.keys()]).toEqual(['40697']);
    expect(map.get('40697')).toBe(newest);
  });

  it('marks nothing from a stale list', () => {
    expect(recentManeuvers(response([candidate()], true), NOW).size).toBe(0);
  });
});

describe('loadRecentManeuvers', () => {
  it('shares one read, and turns a failure into no marker that is retried next time', async () => {
    mocks.listSatelliteManeuvers.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(response([candidate()]));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await loadRecentManeuvers(NOW)).size).toBe(0);
    vi.setSystemTime(NOW);
    const first = loadRecentManeuvers(NOW);
    expect(loadRecentManeuvers(NOW + 60_000)).toBe(first);
    expect((await first).has('40697')).toBe(true);
    expect(mocks.listSatelliteManeuvers).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('maneuverNote', () => {
  it('names the day and the change, and says it is a candidate', () => {
    const node = maneuverNote(candidate());
    expect(node.textContent).toBe('Candidate maneuver 2026-11-14: orbit raised 1.2 km');
    expect(node.title).toMatch(/candidate, not a confirmed maneuver/);
    expect(node.dataset.element).toBe('semiMajorAxis');
    expect(maneuverNote(candidate({ residual: -0.6 })).textContent).toBe('Candidate maneuver 2026-11-14: orbit lowered 0.6 km');
    expect(maneuverNote(candidate({ element: 'inclination', unit: 'deg', residual: -0.031 })).textContent)
      .toBe('Candidate maneuver 2026-11-14: inclination changed 0.031°');
    expect(maneuverNote(candidate({ element: 'raan', unit: 'deg', residual: 0.15 })).textContent)
      .toBe('Candidate maneuver 2026-11-14: orbit plane shifted 0.15°');
  });
});

describe('satellite card', () => {
  const tle = { name: 'SENTINEL-2A', line1: '1 40697U', line2: '2 40697' };
  const coverage = { status: 'ok' as const, sensor: { profileId: 'sentinel-2', family: 'Sentinel-2', category: 'open-optical' as const }, windowStartMs: NOW, windowEndMs: NOW + DAY_MS, orbitAgeDays: 0.4, sites: [] };

  it('draws the sites without waiting for the candidate read, then adds the line when it answers', async () => {
    mocks.getTrackedSatelliteTle.mockReturnValue(tle);
    const pass = { timeMs: Date.now() + 30 * 60_000, groundDistanceKm: 12, edgeOfSwath: false, direction: 'ascending' as const, tier: 'opportunity' as const };
    const site = (id: string, name: string) => ({ site: { id, name, lat: 0, lon: 0, countryCode: 'XX' }, passes: [pass] });
    mocks.sitesCoveredBySatellite.mockResolvedValue({ ...coverage, sites: [site('a', 'Alpha Base'), site('b', 'Bravo Port')] });
    let answer!: (value: ListSatelliteManeuversResponse) => void;
    mocks.listSatelliteManeuvers.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const host = document.createElement('div');
    document.body.append(host);
    await renderSatelliteSites(host, '40697', 'SENTINEL-2A');
    expect(host.dataset.coverage).toBe('ok');
    // The populated list is on screen while the candidate read is still pending.
    const names = () => [...host.querySelectorAll('li.osat-site .osat-site-name')].map((el) => el.textContent);
    expect(names()).toEqual(['Alpha Base', 'Bravo Port']);
    expect(host.querySelector('.osat-sites-maneuver')).toBeNull();
    answer(response([candidate({ toEpoch: Date.now() - DAY_MS })]));
    await vi.waitFor(() => expect(host.querySelector('.osat-sites-maneuver')).not.toBeNull());
    expect(host.children[1]!.classList.contains('osat-sites-maneuver')).toBe(true);
    expect(names()).toEqual(['Alpha Base', 'Bravo Port']);
  });

  it('puts the candidate line under the heading, and leaves it out when the list is unavailable', async () => {
    mocks.getTrackedSatelliteTle.mockReturnValue(tle);
    mocks.sitesCoveredBySatellite.mockResolvedValue(coverage);
    mocks.listSatelliteManeuvers.mockResolvedValue(response([candidate({ toEpoch: Date.now() - DAY_MS })]));
    const host = document.createElement('div');
    document.body.append(host);
    await renderSatelliteSites(host, '40697', 'SENTINEL-2A');
    await vi.waitFor(() => expect(host.children[1]!.classList.contains('osat-sites-maneuver')).toBe(true));
    expect(host.querySelector('.osat-sites-maneuver')!.textContent).toMatch(/^Candidate maneuver \d{4}-\d{2}-\d{2}: orbit raised 1\.2 km$/);

    resetManeuverCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.listSatelliteManeuvers.mockRejectedValue(new Error('HTTP 503'));
    const other = document.createElement('div');
    document.body.append(other);
    await renderSatelliteSites(other, '40697', 'SENTINEL-2A');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(other.querySelector('.osat-sites-maneuver')).toBeNull();
    expect(other.dataset.coverage).toBe('ok');
  });
});

describe('site satellite rows', () => {
  it('says which satellite over the site had a candidate maneuver', () => {
    const site = { id: 'site-1', name: 'Alpha Base', lat: 0, lon: 0, countryCode: 'XX' };
    const sensor = { profileId: 'sentinel-2', family: 'Sentinel-2', category: 'open-optical' as const };
    const pass = { timeMs: NOW + 30 * 60_000, groundDistanceKm: 12, edgeOfSwath: false, direction: 'ascending' as const, tier: 'opportunity' as const };
    const satellites = [
      { noradId: '40697', name: 'SENTINEL-2A', sensor, passes: [pass] },
      { noradId: '42063', name: 'SENTINEL-2B', sensor, passes: [pass] },
    ];
    const section = siteSatellitesSection(site, { kind: 'ok', satellites } as never, {
      nowMs: NOW, passKey: () => null, selectedKey: null, maneuvers: new Map([['40697', candidate()]]),
    });
    const rows = [...section.querySelectorAll<HTMLElement>('li')];
    expect(rows[0]!.dataset.maneuver).toBe('semiMajorAxis');
    expect(rows[0]!.textContent).toContain('candidate maneuver 2026-11-14');
    expect(rows[1]!.dataset.maneuver).toBeUndefined();
    expect(rows[1]!.textContent).not.toContain('candidate maneuver');
  });
});
