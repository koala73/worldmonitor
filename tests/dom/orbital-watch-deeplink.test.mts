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
import type { OrbitalEvidence } from '@/services/orbital/match';
import { openOrbitalWatch, openOrbitalWatchSearch } from '@/app/orbital-watch';
import { scheduleOrbitalShareLink, takeOrbitalShareLink } from '@/app/orbital-share-link';
import { EventHandlerManager } from '@/app/event-handlers';
import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { COMMANDS } from '@/config/commands';
import { connectOrbitalLookupMap, isOrbitalLookupOpen } from '@/services/orbital/lookup-host';
import { saveToStorage } from '@/utils';

const NOW = Date.UTC(2026, 10, 13, 12);
const HOUR = 3_600_000;
const EXACT = { lat: 48.858_37, lon: 2.294_48 };

function pass(noradId: number, hoursFromNow: number, tier: PassTier = { kind: 'likely-imaged' }): PointPass {
  const timeMs = NOW + hoursFromNow * HOUR + 17_000;
  return {
    noradId, name: `SAT ${noradId}`, profileId: 'sentinel-2', category: 'open-optical', time: new Date(timeMs).toISOString(), timeMs,
    opportunity: hoursFromNow > 0, groundDistanceKm: 42, side: 'left', elevationDeg: 80, azimuthDeg: 90, incidenceDeg: 10,
    sunElevationDeg: 40, altitudeKm: 700, subSatellite: EXACT, inFootprint: true, edgeOfSwath: false, coverage: true, tier,
    elementsEpochMs: NOW - 2 * HOUR, orbitAgeDays: 0.5,
  };
}

const PASSES = [pass(40697, -30), pass(48917, -60, { kind: 'passed-overhead' })];

function lookupAt(point: { lat: number; lon: number }): PointPassLookup {
  return {
    point, window: { startMs: NOW - 7 * 24 * HOUR, endMs: NOW + 72 * HOUR }, nowMs: NOW,
    catalog: { status: 'fresh', fetchedAt: NOW - HOUR, inventoryVersion: 'test' }, passes: PASSES, satellites: [], computedOn: 'worker',
  };
}

const answered = (passes: PointPass[]): OrbitalEvidence =>
  ({ passes, acquisitions: [], mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] });

const sheet = () => document.querySelector<HTMLElement>('.orbital-watch-sheet');
const text = () => sheet()?.textContent ?? '';
const input = () => sheet()!.querySelector<HTMLInputElement>('.ow-search-input')!;
const button = (selector: string) => sheet()!.querySelector<HTMLButtonElement>(selector)!;

function submitSearch(value: string): void {
  input().value = value;
  sheet()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

let fetchMock: ReturnType<typeof vi.fn>;
const setCenter = vi.fn();
const sendBeacon = vi.fn(() => true);
const writeText = vi.fn(async (_text: string) => {});

/** Every request the page made to a WorldMonitor host: same origin, relative, or a worldmonitor.app domain. */
const worldMonitorRequests = () => fetchMock.mock.calls
  .map(([input]) => String(input instanceof Request ? input.url : input))
  .filter((url) => !/^https?:/.test(url) || new URL(url).origin === location.origin || /worldmonitor\.app$/.test(new URL(url).hostname));

/** Numbers that carry the exact point at better than 0.1 degree. */
const precisePoint = (value: string) => (value.match(/-?\d+\.\d{2,}/g) ?? [])
  .filter((n) => Math.abs(Number(n) - EXACT.lat) < 0.1 || Math.abs(Number(n) - EXACT.lon) < 0.1);

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  history.replaceState(null, '', '/dashboard');
  fetchMock = vi.fn(async () => Response.json({ places: [{ name: 'Rotterdam, South Holland, Netherlands', lat: 51.92, lon: 4.48, kind: 'city' }], error: '' }));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  lookupMock.mockImplementation(async ({ point }: { point: { lat: number; lon: number } }) => lookupAt(point));
  evidenceMock.mockImplementation(async (found: PointPassLookup) => answered(found.passes));
  connectOrbitalLookupMap(() => ({ setCenter }));
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.ow-close')?.click();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  connectOrbitalLookupMap(() => null);
});

describe('place search in the satellite pass lookup', () => {
  it('opens from the command palette focused on the search field', async () => {
    const command = COMMANDS.find((c) => c.id === 'orbital:search')!;
    expect(command.label).toBe('Satellite passes: find a place');
    const dispatcher = new SearchSelectionDispatcher({
      ctx: { mapLayers: {}, map: null, panelSettings: {}, newsPanels: {} } as never,
      getVariant: () => 'full', hasPremiumAccess: () => false, openCountryBriefByCode: vi.fn(() => true), enablePanel: vi.fn(() => false),
      trackSearchResultSelected: vi.fn(), trackCountrySelected: vi.fn(), runWithAgentAnalyticsSuppressed: (callback) => callback(),
      suppressNextAgentPanelView: vi.fn(), resolveExecutableNewsPanel: vi.fn(() => null), saveToStorage, setTheme: vi.fn(),
      setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (timer) => clearTimeout(timer),
    });
    dispatcher.handleCommand(command);
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    expect(text()).toContain('Search a place by name or coordinates');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('states that a searched name goes to WorldMonitor and OpenStreetMap', () => {
    openOrbitalWatchSearch(null);
    const hint = document.getElementById(input().getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain('WorldMonitor');
    expect(hint.textContent).toContain('OpenStreetMap');
  });

  it('resolves typed coordinates to that point with no network request', async () => {
    openOrbitalWatchSearch(null);
    submitSearch('48.8584, 2.2945');
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledTimes(1));
    expect(lookupMock.mock.calls[0]![0]).toEqual({ point: { lat: 48.8584, lon: 2.2945 } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text()).toContain('48.858°N, 2.295°E');
  });

  it('keeps coordinates outside the globe out of the name search', async () => {
    openOrbitalWatchSearch(null);
    submitSearch('95.5, 200');
    await vi.waitFor(() => expect(text()).toContain('outside the globe'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no request while the reader types', () => {
    openOrbitalWatchSearch(null);
    for (const value of ['R', 'Ro', 'Rotterdam']) {
      input().value = value;
      input().dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the place search route once for a submitted name and lists the matches', async () => {
    openOrbitalWatchSearch(null);
    submitSearch('Rotterdam');
    await vi.waitFor(() => expect(sheet()!.querySelectorAll('.ow-search-result')).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), location.origin);
    expect(url.pathname).toBe('/api/infrastructure/v1/search-place');
    expect(url.searchParams.get('q')).toBe('Rotterdam');
    expect(text()).toContain('Rotterdam, South Holland, Netherlands');
    button('.ow-search-result').click();
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 51.92, lon: 4.48 } }, expect.anything()));
  });

  it('shows a message when location permission is denied and keeps the lookup usable', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) => fail({ code: 1, message: 'denied' } as GeolocationPositionError) },
    });
    openOrbitalWatchSearch(null);
    button('.ow-locate').click();
    await vi.waitFor(() => expect(text()).toContain('Location permission was denied'));
    expect(lookupMock).not.toHaveBeenCalled();
    submitSearch('10, 20');
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 10, lon: 20 } }, expect.anything()));
  });

  it('opens the device location only after the click, and sends it nowhere', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) => ok({ coords: { latitude: EXACT.lat, longitude: EXACT.lon } } as GeolocationPosition));
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
    openOrbitalWatchSearch(null);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    button('.ow-locate').click();
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledWith({ point: EXACT }, expect.anything()));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('satellite pass share link', () => {
  it('copies a link with the point at 0.01-degree precision in the fragment', async () => {
    openOrbitalWatch(EXACT, null);
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-row[data-pass]')).not.toBeNull());
    button('.ow-share').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link = new URL(writeText.mock.calls[0]![0]);
    expect(link.search).toBe('');
    expect(link.hash).toBe('#orbital=48.86,2.29');
    expect(text()).toContain('Link copied');
  });

  it('includes the selected pass, to the minute', async () => {
    openOrbitalWatch(EXACT, null);
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-row[data-pass]')).not.toBeNull());
    sheet()!.querySelector<HTMLElement>(`.ow-row[data-pass^="40697:"]`)!.click();
    expect(sheet()!.querySelector('.ow-row[aria-current="true"]')?.textContent).toContain('SAT 40697');
    button('.ow-share').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(new URL(writeText.mock.calls[0]![0]).hash).toBe('#orbital=48.86,2.29;40697-202611120600');
  });

  it('opens a valid link after the map has had time to render, at the rounded point with its pass selected', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/dashboard?view=eu#orbital=48.86,2.29;40697-202611120600');
    const link = takeOrbitalShareLink();
    expect(location.hash).toBe('');
    expect(location.search).toBe('?view=eu');
    scheduleOrbitalShareLink(link!, 1500, () => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sheet()).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-row[aria-current="true"]')).not.toBeNull());
    expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 48.86, lon: 2.29 } }, expect.anything());
    expect(sheet()!.querySelector('.ow-row[aria-current="true"]')!.textContent).toContain('SAT 40697');
    expect(setCenter).toHaveBeenCalledWith(48.9, 2.3, expect.any(Number));
  });

  it('opens for a free user at the panel cap, because the lookup is an overlay and never a grid panel', async () => {
    history.replaceState(null, '', '/dashboard#orbital=48.86,2.29');
    scheduleOrbitalShareLink(takeOrbitalShareLink()!, 0, () => false);
    await vi.waitFor(() => expect(sheet()?.getAttribute('role')).toBe('dialog'));
    expect(sheet()!.parentElement).toBe(document.body);
  });

  it('ignores a malformed link and leaves the dashboard as it was', async () => {
    history.replaceState(null, '', '/dashboard?view=eu#orbital=48.8584,2.2945');
    expect(takeOrbitalShareLink()).toBeNull();
    expect(location.href).toBe(`${location.origin}/dashboard?view=eu`);
    expect(sheet()).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('notes a linked pass outside the current window and opens the place with no pass selected', async () => {
    history.replaceState(null, '', '/dashboard#orbital=48.86,2.29;40697-202610010600');
    scheduleOrbitalShareLink(takeOrbitalShareLink()!, 0, () => false);
    await vi.waitFor(() => expect(text()).toContain('The linked pass is outside the current window'));
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-row[data-pass]')).not.toBeNull());
    expect(sheet()!.querySelector('.ow-row[aria-current="true"]')).toBeNull();
    sheet()!.querySelector<HTMLButtonElement>('.ow-note-dismiss')!.click();
    expect(sheet()!.querySelector<HTMLElement>('.ow-note')!.hidden).toBe(true);
  });

  it('sends the point to no WorldMonitor host and no analytics beacon, and keeps it out of the page URL', async () => {
    history.replaceState(null, '', `/dashboard#orbital=48.86,2.29`);
    scheduleOrbitalShareLink(takeOrbitalShareLink()!, 0, () => false);
    await vi.waitFor(() => expect(evidenceMock).toHaveBeenCalled());
    openOrbitalWatch(EXACT, null);
    await vi.waitFor(() => expect(evidenceMock).toHaveBeenCalledTimes(2));
    for (const url of worldMonitorRequests()) expect(precisePoint(url), url).toEqual([]);
    for (const [, body] of sendBeacon.mock.calls as unknown as Array<[string, unknown]>) expect(precisePoint(String(body))).toEqual([]);
    expect(precisePoint(location.href)).toEqual([]);
    expect(location.hash).toBe('');
  });

  it('leaves a recentred looked-up point out of the map URL query string while the lookup is open', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const map = {
      getState: () => ({ view: 'global', zoom: 6, timeRange: '24h', layers: {} }),
      getCenter: () => ({ lat: 48.9, lon: 2.3 }),
    };
    const manager = new EventHandlerManager({ container, isDesktopApp: false, panels: {}, panelSettings: {}, mapLayers: {}, map } as never, {} as never);
    expect(new URL(manager.getShareUrl()!).searchParams.get('lat')).toBe('48.9000');
    openOrbitalWatchSearch(null);
    submitSearch('48.8584, 2.2945');
    await vi.waitFor(() => expect(setCenter).toHaveBeenCalledWith(48.9, 2.3, expect.any(Number)));
    expect(isOrbitalLookupOpen()).toBe(true);
    const url = new URL(manager.getShareUrl()!);
    expect(url.searchParams.has('lat')).toBe(false);
    expect(url.searchParams.has('lon')).toBe(false);
    expect(precisePoint(url.href)).toEqual([]);
    button('.ow-close').click();
    expect(isOrbitalLookupOpen()).toBe(false);
  });
});
