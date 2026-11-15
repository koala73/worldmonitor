/**
 * #10713 unit 1: `loadObjectImagery` reads a watched site's seeded record by site
 * id and falls back to the in-browser lookup (pass worker + public archives) when
 * the record is missing, stale or unreachable. A lookup for a closed popup must
 * never start on the shared pass client, which would cancel the open popup's.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type WithSignal = { signal?: AbortSignal };
const harness = vi.hoisted(() => ({
  lookup: null as unknown as Mock<(query: unknown, options?: WithSignal) => Promise<unknown>>,
  siteRead: null as unknown as Mock<(request: unknown, options?: WithSignal) => Promise<unknown>>,
  stac: null as unknown as Mock<(archive: string, query?: unknown) => Promise<unknown>>,
  evidence: null as unknown as Mock<(input?: unknown) => unknown>,
}));

vi.mock('@/services/orbital/pass-client', () => ({
  createOrbitalPassClient: () => ({ lookup: (query: unknown, options?: WithSignal) => harness.lookup(query, options), dispose: () => {} }),
}));
vi.mock('@/services/orbital/archive-stac', () => ({ searchStacArchive: (archive: string, query: unknown) => harness.stac(archive, query) }));
vi.mock('@/services/orbital/match', () => ({ assembleEvidence: (input: unknown) => harness.evidence(input) }));
vi.mock('@/services/rpc-client', () => ({
  getRpcBaseUrl: () => '',
  createLazyClient: <T,>(make: () => T) => { let client: T | null = null; return () => (client ??= make()); },
}));
vi.mock('@/services/generated-rpc-clients', () => ({
  OrbitalServiceClient: class { getWatchedSiteImagery(request: unknown, options?: WithSignal) { return harness.siteRead(request, options); } },
}));
vi.mock('../../shared/watched-sites', () => ({
  composeWatchedSites: () => [{ id: 'military-base:al_udeid', origins: [{ list: 'military-base', id: 'al_udeid' }] }],
}));

import { LATEST_IMAGE_DAYS, loadObjectImagery, type ImageryTarget } from '@/services/orbital/object-imagery';

const HOUR = 3_600_000;
const point = { lat: 25.12, lon: 51.31 };
const site: ImageryTarget = { kind: 'site', origin: { list: 'military-base', id: 'al_udeid' }, point };
const unregistered: ImageryTarget = { kind: 'site', origin: { list: 'port', id: 'not_in_registry' }, point };

const passLookup = (passes: Array<{ name: string; timeMs: number; inFootprint?: boolean }>) => ({
  point,
  window: { startMs: Date.now() - 30 * 24 * HOUR, endMs: Date.now() + 72 * HOUR },
  nowMs: Date.now(),
  passes: passes.map((p) => ({ profileId: 'sentinel-2', inFootprint: true, ...p })),
});
const record = (over: Record<string, unknown> = {}) => ({
  siteId: 'military-base:al_udeid', name: 'Al Udeid', lat: point.lat, lon: point.lon, evaluatedAt: Date.now(), stale: false,
  latestImage: { itemId: 'S2B_MSIL2A_X', collection: 'sentinel-2-l2a', profileId: 'sentinel-2', datetime: '2026-11-13T07:00:00Z' },
  nextPass: { satellite: 'SENTINEL-2A', profileId: 'sentinel-2', time: new Date(Date.now() + 5 * HOUR).toISOString() },
  ...over,
});
const browserImage = 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_X/thumbnail.jpg';

beforeEach(() => {
  harness.lookup = vi.fn<(query: unknown, options?: WithSignal) => Promise<unknown>>(async () => passLookup([{ name: 'LANDSAT 9', timeMs: Date.now() + 2 * HOUR }]));
  harness.siteRead = vi.fn<(request: unknown, options?: WithSignal) => Promise<unknown>>(async () => record());
  harness.stac = vi.fn<(archive: string, query?: unknown) => Promise<unknown>>(async (archive) => ({ status: 'ok', archive, items: [] }));
  harness.evidence = vi.fn<(input?: unknown) => unknown>(() => ({
    acquisitions: [{ startMs: Date.parse('2026-11-12T10:00:00Z'), profileId: 'sentinel-2', imageUrl: browserImage }],
    failures: [],
  }));
});

describe('loadObjectImagery: watched-site record', () => {
  it('serves a fresh record by site id without a browser lookup', async () => {
    const result = await loadObjectImagery(site);

    expect(harness.siteRead).toHaveBeenCalledWith({ siteId: 'military-base:al_udeid' }, expect.anything());
    expect(harness.lookup).not.toHaveBeenCalled();
    expect(harness.stac).not.toHaveBeenCalled();
    expect(result.latest).toMatchObject({ datetime: '2026-11-13T07:00:00Z', archive: 'planetary-computer' });
    expect(result.nextPass?.satellite).toBe('SENTINEL-2A');
  });

  it('keeps the record image and finds the next pass locally when the cached pass has passed', async () => {
    harness.siteRead.mockImplementation(async () => record({ nextPass: { satellite: 'SENTINEL-2A', profileId: 'sentinel-2', time: new Date(Date.now() - HOUR).toISOString() } }));
    const result = await loadObjectImagery(site);

    expect(harness.lookup).toHaveBeenCalledTimes(1);
    expect(harness.stac).not.toHaveBeenCalled();
    expect(result.latest?.datetime).toBe('2026-11-13T07:00:00Z');
    expect(result.nextPass?.satellite).toBe('LANDSAT 9');
  });

  it('keeps the record image with no next pass when the local pass lookup fails', async () => {
    harness.siteRead.mockImplementation(async () => record({ nextPass: undefined }));
    harness.lookup.mockImplementation(async () => { throw new Error('catalog unavailable'); });
    const result = await loadObjectImagery(site);

    expect(result.latest?.datetime).toBe('2026-11-13T07:00:00Z');
    expect(result.nextPass).toBeNull();
  });
});

describe('loadObjectImagery: fallback to the in-browser lookup', () => {
  const expectBrowserAnswer = (result: Awaited<ReturnType<typeof loadObjectImagery>>) => {
    expect(harness.lookup).toHaveBeenCalledWith({ point }, expect.anything());
    expect(harness.stac.mock.calls.map(([archive]) => archive).sort()).toEqual(['earth-search', 'planetary-computer']);
    expect(result.latest).toMatchObject({ datetime: '2026-11-12T10:00:00.000Z', archive: 'earth-search', candidates: [browserImage] });
    expect(result.nextPass?.satellite).toBe('LANDSAT 9');
    expect(result.imageSearchFailed).toBe(false);
  };

  it('falls back when the site record is stale', async () => {
    harness.siteRead.mockImplementation(async () => ({ siteId: 'military-base:al_udeid', name: '', lat: 0, lon: 0, evaluatedAt: 0, stale: true }));
    expectBrowserAnswer(await loadObjectImagery(site));
  });

  it('falls back when the site read fails', async () => {
    harness.siteRead.mockImplementation(async () => { throw new Error('503'); });
    expectBrowserAnswer(await loadObjectImagery(site));
  });

  it('falls back without a server read when the object is not a registry site', async () => {
    expectBrowserAnswer(await loadObjectImagery(unregistered));
    expect(harness.siteRead).not.toHaveBeenCalled();
  });

  it('answers a plain point in the browser only', async () => {
    expectBrowserAnswer(await loadObjectImagery({ kind: 'point', point }));
    expect(harness.siteRead).not.toHaveBeenCalled();
  });

  it('reports a failed archive search as unavailable rather than as no image', async () => {
    harness.siteRead.mockImplementation(async () => { throw new Error('503'); });
    harness.evidence.mockImplementation(() => ({ acquisitions: [], failures: [{ archive: 'earth-search', reason: 'timeout' }] }));
    const result = await loadObjectImagery(site);

    expect(result.latest).toBeNull();
    expect(result.imageSearchFailed).toBe(true);
  });
});

describe('loadObjectImagery: the latest-image search', () => {
  const point7Days = () => ({ ...passLookup([]), window: { startMs: Date.now() - 7 * 24 * HOUR, endMs: Date.now() + 72 * HOUR } });

  it('still searches the archives when the pass lookup fails, and names no next pass', async () => {
    harness.lookup.mockImplementation(async () => { throw new Error('pass worker init timeout'); });
    const result = await loadObjectImagery({ kind: 'point', point });

    expect(harness.stac.mock.calls.map(([archive]) => archive).sort()).toEqual(['earth-search', 'planetary-computer']);
    expect(result.latest).toMatchObject({ candidates: [browserImage] });
    expect(result.nextPass).toBeNull();
  });

  it('looks back LATEST_IMAGE_DAYS, not the seven-day pass window', async () => {
    harness.lookup.mockImplementation(async () => point7Days());
    const before = Date.now();
    await loadObjectImagery({ kind: 'point', point });

    const { window } = harness.stac.mock.calls[0]![1] as { window: { startMs: number; endMs: number } };
    expect(before - window.startMs).toBeGreaterThanOrEqual(LATEST_IMAGE_DAYS * 24 * HOUR);
    expect(before - window.startMs).toBeLessThan(LATEST_IMAGE_DAYS * 24 * HOUR + 60_000);
    expect(window.endMs).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the stale colour reachable: the search reaches past IMAGE_STALE_MS', () => {
    expect(LATEST_IMAGE_DAYS * 24 * HOUR).toBeGreaterThan(14 * 24 * HOUR);
  });

  it('still rejects when the popup closed during the pass lookup', async () => {
    const closed = new AbortController();
    harness.lookup.mockImplementation(async () => { closed.abort(); throw new DOMException('aborted', 'AbortError'); });
    await expect(loadObjectImagery({ kind: 'point', point }, closed.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('loadObjectImagery: a closed popup', () => {
  it('never starts a pass lookup once its signal is aborted, so it cannot cancel the open popup', async () => {
    const closed = new AbortController();
    harness.siteRead.mockImplementation(async (_req, opts) => {
      closed.abort();
      opts?.signal?.throwIfAborted();
      return record();
    });

    await expect(loadObjectImagery(site, closed.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.lookup).not.toHaveBeenCalled();
    expect(harness.stac).not.toHaveBeenCalled();
  });

  it('does not refresh a cached pass for a popup that closed during the site read', async () => {
    const closed = new AbortController();
    harness.siteRead.mockImplementation(async () => {
      closed.abort();
      return record({ nextPass: undefined });
    });

    await loadObjectImagery(site, closed.signal);
    expect(harness.lookup).not.toHaveBeenCalled();
  });
});
