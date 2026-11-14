import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const lookupMock = vi.hoisted(() => vi.fn());
const evidenceMock = vi.hoisted(() => vi.fn());

const desktop = vi.hoisted(() => ({ value: false }));
vi.mock('@/config/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/desktop-runtime')>()),
  isDesktopRuntime: () => desktop.value,
}));
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
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
import { setOrbitalMapView } from '@/app/orbital-map-focus';
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
const center = vi.fn((_point: { lat: number; lon: number }, _offset: { x: number; y: number }) => true);
let mapCentre: { lat: number; lon: number } | null = null;
let releaseMapView = () => {};
/** The points the map was centred on, rounded to 0.01 degree for comparison. */
const centredOn = () => center.mock.calls.map(([p]) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`);
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
  mapCentre = null;
  connectOrbitalLookupMap(() => ({ getCenter: () => mapCentre }));
  releaseMapView = setOrbitalMapView({ rect: () => new DOMRect(0, 0, 1440, 900), center, project: () => null, hold: () => {}, suppressLayers: () => {}, camera: () => null, restore: () => {} });
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.ow-close')?.click();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  connectOrbitalLookupMap(() => null);
  releaseMapView();
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
    expect(text()).toContain('48.858°N 2.295°E');
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

  it('opens the device location only after the click, rounds it to the share grid, and sends it nowhere', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) => ok({ coords: { latitude: EXACT.lat, longitude: EXACT.lon } } as GeolocationPosition));
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
    openOrbitalWatchSearch(null);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    button('.ow-locate').click();
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 48.86, lon: 2.29 } }, expect.anything()));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a device location that arrives after the reader closed the sheet', async () => {
    let answer: PositionCallback | null = null;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok: PositionCallback) => { answer = ok; } } });
    openOrbitalWatchSearch(null);
    button('.ow-locate').click();
    await vi.waitFor(() => expect(answer).not.toBeNull());
    mapCentre = { lat: 20, lon: 10 };
    sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    answer!({ coords: { latitude: EXACT.lat, longitude: EXACT.lon } } as GeolocationPosition);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookupMock).not.toHaveBeenCalled();
    mapCentre = { lat: 21, lon: 10 };
    expect(isOrbitalLookupOpen()).toBe(false);
  });
});

describe('the search row', () => {
  it('opens from CHANGE, and a picked place recentres the map and names the completed results', async () => {
    openOrbitalWatch(EXACT, null);
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
    expect(sheet()!.querySelector<HTMLElement>('.ow-search-slot')!.hidden).toBe(true);
    expect(sheet()!.querySelector('.ow-zone')!.textContent).toBe('EUROPE/PARIS · UTC+1');
    button('.ow-change').click();
    expect(sheet()!.querySelector<HTMLElement>('.ow-search-slot')!.hidden).toBe(false);
    expect(document.activeElement).toBe(input());
    submitSearch('Rotterdam');
    await vi.waitFor(() => expect(sheet()!.querySelectorAll('.ow-search-result')).toHaveLength(1));
    button('.ow-search-result').click();
    expect(sheet()!.querySelector<HTMLElement>('.ow-search-slot')!.hidden).toBe(true);
    await vi.waitFor(() => expect(centredOn()).toContain('51.92,4.48'));
    expect(sheet()!.querySelector('.ow-place')!.textContent).toBe('Rotterdam, South Holland');
    expect(sheet()!.querySelector<HTMLElement>('.ow-place')!.title).toBe('Rotterdam, South Holland, Netherlands');
    expect(sheet()!.querySelector('.ow-zone')!.textContent).toBe('EUROPE/AMSTERDAM · UTC+1');
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')?.textContent).toContain('Rotterdam, South Holland.'));
  });

  it('shows pass times in the place\'s zone, and switches them to UTC', async () => {
    const zoneChange = vi.fn();
    document.addEventListener('orbital-watch:zone-change', (event) => zoneChange((event as CustomEvent).detail), { once: true });
    openOrbitalWatch(EXACT, null, 'full');
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
    expect(text()).toMatch(/\d\d:\d\d UTC\+1/);
    button('.ow-zone').click();
    expect(zoneChange).toHaveBeenCalledWith({ timeZone: 'UTC', label: 'UTC' });
    expect(button('.ow-zone').textContent).toBe('UTC');
    expect(button('.ow-zone').getAttribute('aria-pressed')).toBe('false');
    expect(text()).not.toMatch(/UTC\+1/);
    button('.ow-zone').click();
    expect(button('.ow-zone').textContent).toBe('EUROPE/PARIS · UTC+1');
  });

  it('keeps the full view when a place is picked from it', async () => {
    openOrbitalWatch(EXACT, null, 'full');
    button('.ow-change').click();
    submitSearch('10, 20');
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 10, lon: 20 } }, expect.anything()));
    expect(sheet()!.dataset.view).toBe('full');
    expect(sheet()!.querySelector('.ow-place')!.textContent).toBe('10.000°N 20.000°E');
  });
});

describe('satellite pass share link', () => {
  it('copies a link with the point at 0.01-degree precision in the fragment', async () => {
    openOrbitalWatch(EXACT, null);
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
    button('.ow-share').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link = new URL(writeText.mock.calls[0]![0]);
    expect(link.search).toBe('');
    expect(link.hash).toBe('#orbital=48.86,2.29');
    expect(text()).toContain('Link copied');
  });

  it('keeps the full view in the link copied from it', async () => {
    openOrbitalWatch(EXACT, null, 'full');
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
    button('.ow-share').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(new URL(writeText.mock.calls[0]![0]).hash).toBe('#orbital=48.86,2.29&view=full');
  });

  it('shows the link to copy by hand when the clipboard refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    openOrbitalWatch(EXACT, null);
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
    button('.ow-share').click();
    await vi.waitFor(() => expect(sheet()!.querySelector<HTMLInputElement>('.ow-share-link')!.hidden).toBe(false));
    expect(sheet()!.querySelector<HTMLInputElement>('.ow-share-link')!.value).toMatch(/#orbital=48\.86,2\.29$/);
    expect(sheet()!.querySelector<HTMLElement>('.ow-search-slot')!.hidden).toBe(false);
  });

  it('points a desktop share link at the public dashboard, not the local WebView origin', async () => {
    desktop.value = true;
    try {
      openOrbitalWatch(EXACT, null);
      await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
      button('.ow-share').click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText.mock.calls[0]![0]).toBe('https://www.worldmonitor.app/dashboard#orbital=48.86,2.29');
    } finally {
      desktop.value = false;
    }
  });

  it('opens the full view from a view=full link', async () => {
    history.replaceState(null, '', '/dashboard#orbital=48.86,2.29&view=full');
    scheduleOrbitalShareLink(takeOrbitalShareLink()!, 0, () => false);
    await vi.waitFor(() => expect(sheet()?.dataset.view).toBe('full'));
    expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 48.86, lon: 2.29 } }, expect.anything());
    // Raising the map to full screen resizes it, so the centre is set again once that has happened.
    await vi.waitFor(() => expect(centredOn()).toContain('48.86,2.29'));
  });

  it('opens a valid link after the map has had time to render, at the rounded point, and selects its pass', async () => {
    vi.useFakeTimers();
    const linked = vi.fn();
    document.addEventListener('orbital-watch:select', (event) => linked((event as CustomEvent).detail), { once: true });
    history.replaceState(null, '', '/dashboard?view=eu#orbital=48.86,2.29;40697-202611120600');
    const link = takeOrbitalShareLink();
    expect(location.hash).toBe('');
    expect(location.search).toBe('?view=eu');
    scheduleOrbitalShareLink(link!, 1500, () => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sheet()).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    await vi.waitFor(() => expect(linked).toHaveBeenCalledTimes(1));
    expect(lookupMock).toHaveBeenCalledWith({ point: { lat: 48.86, lon: 2.29 } }, expect.anything());
    expect(linked.mock.calls[0]![0]).toEqual({ noradId: 40697, timeMs: PASSES[0]!.timeMs });
    await vi.waitFor(() => expect(centredOn()).toContain('48.86,2.29'));
  });

  it('copies the selected pass into the shared link', async () => {
    const selected = vi.fn();
    document.addEventListener('orbital-watch:select', selected, { once: true });
    history.replaceState(null, '', '/dashboard#orbital=48.86,2.29;40697-202611120600');
    scheduleOrbitalShareLink(takeOrbitalShareLink()!, 0, () => false);
    await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    button('.ow-share').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const minute = new Date(PASSES[0]!.timeMs).toISOString().slice(0, 16).replace(/[-T:]/g, '');
    expect(new URL(writeText.mock.calls[0]![0]).hash).toBe(`#orbital=48.86,2.29;40697-${minute}&view=full`);
  });

  it('notes a linked pass the sheet cannot select instead of failing silently', async () => {
    const mosaic = { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS', layer: 'MODIS_Terra', noradId: 40697, days: [] } as unknown as PassTier;
    evidenceMock.mockImplementationOnce(async (found: PointPassLookup) =>
      answered(found.passes.map((p) => (p.noradId === 40697 ? { ...p, tier: mosaic } : p))));
    const selected = vi.fn();
    document.addEventListener('orbital-watch:select', selected, { once: true });
    history.replaceState(null, '', '/dashboard#orbital=48.86,2.29;40697-202611120600');
    scheduleOrbitalShareLink(takeOrbitalShareLink()!, 0, () => false);
    await vi.waitFor(() => expect(text()).toContain('linked pass was not found'));
    expect(selected).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(sheet()!.querySelector('.ow-headline')).not.toBeNull());
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
    await vi.waitFor(() => expect(centredOn()).toContain('48.86,2.29'));
    expect(isOrbitalLookupOpen()).toBe(true);
    const url = new URL(manager.getShareUrl()!);
    expect(url.searchParams.has('lat')).toBe(false);
    expect(url.searchParams.has('lon')).toBe(false);
    expect(precisePoint(url.href)).toEqual([]);
    mapCentre = { lat: 48.8584, lon: 2.2945 };
    button('.ow-close').click();
    expect(isOrbitalLookupOpen(), 'the map still sits on the typed point after closing').toBe(true);
    expect(new URL(manager.getShareUrl()!).searchParams.has('lat')).toBe(false);
    mapCentre = { lat: 48.8584, lon: 40 };
    expect(isOrbitalLookupOpen(), 'a globe spinning on after closing still carries the typed latitude').toBe(true);
    mapCentre = { lat: 50, lon: 3 };
    expect(isOrbitalLookupOpen(), 'a map moved after closing writes its centre again').toBe(false);
  });

  it('anchors the closed-lookup URL guard where a camera still flying to the point stops, and holds it while the camera cannot say', async () => {
    let settle!: () => void;
    connectOrbitalLookupMap(() => ({ getCenter: () => mapCentre, whenViewportSettled: () => new Promise<void>((resolve) => { settle = resolve; }) }));
    openOrbitalWatchSearch(null);
    submitSearch('48.8584, 2.2945');
    await vi.waitFor(() => expect(centredOn()).toContain('48.86,2.29'));
    mapCentre = { lat: 30, lon: 2 };
    button('.ow-close').click();
    mapCentre = { lat: 48.8584, lon: 2.2945 };
    expect(isOrbitalLookupOpen(), 'the camera is still in flight').toBe(true);
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(isOrbitalLookupOpen(), 'anchored on the settled point, not the mid-flight latitude').toBe(true);
    mapCentre = null;
    expect(isOrbitalLookupOpen(), 'a camera that cannot report its centre keeps the guard').toBe(true);
    mapCentre = { lat: 50, lon: 3 };
    expect(isOrbitalLookupOpen()).toBe(false);
  });
});
