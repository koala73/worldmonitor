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
  catalog: { fetchedAt: 1, inventoryVersion: 'v1' },
}));

vi.mock('@/services/orbital/pass-client', () => ({
  createOrbitalPassClient: () => ({ lookup: (query: unknown, options?: WithSignal) => harness.lookup(query, options), dispose: () => {} }),
}));
vi.mock('@/services/orbital/catalog', () => ({ loadOrbitalCatalog: async () => ({ ...harness.catalog }) }));
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

import { forgetNextPasses, LATEST_IMAGE_DAYS, loadObjectImagery, NEXT_PASS_HOURS, type ImageryTarget, type ObjectImagery } from '@/services/orbital/object-imagery';

const HOUR = 3_600_000;
const point = { lat: 25.12, lon: 51.31 };
const site: ImageryTarget = { kind: 'site', origin: { list: 'military-base', id: 'al_udeid' }, point };
const unregistered: ImageryTarget = { kind: 'site', origin: { list: 'port', id: 'not_in_registry' }, point };

const passLookup = (passes: Array<{ name: string; timeMs: number; inFootprint?: boolean }>) => ({
  point,
  window: { startMs: Date.now() - 30 * 24 * HOUR, endMs: Date.now() + 72 * HOUR },
  nowMs: Date.now(),
  catalog: { status: 'ok', ...harness.catalog },
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
  forgetNextPasses();
  harness.catalog = { fetchedAt: 1, inventoryVersion: 'v1' };
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

  it('keeps the painted record image when a newer pass lookup supersedes this one', async () => {
    harness.siteRead.mockImplementation(async () => record({ nextPass: undefined }));
    // The shared pass client rejects a superseded lookup with AbortError although this popup never closed.
    harness.lookup.mockImplementation(async () => { throw new DOMException('Superseded by a newer pass lookup', 'AbortError'); });
    const open = new AbortController();
    const result = await loadObjectImagery(site, open.signal);

    expect(open.signal.aborted).toBe(false);
    expect(result.latest?.datetime).toBe('2026-11-13T07:00:00Z');
    expect(result.nextPass).toBeNull();
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
    expect(harness.lookup).toHaveBeenCalledWith({ point, pastDays: 0, futureHours: NEXT_PASS_HOURS }, expect.anything());
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
    // The loader reads the clock once between these two readings, so its window is bracketed by them.
    const before = Date.now();
    await loadObjectImagery({ kind: 'point', point });
    const after = Date.now();

    const { window } = harness.stac.mock.calls[0]![1] as { window: { startMs: number; endMs: number } };
    expect(window.endMs - window.startMs).toBe(LATEST_IMAGE_DAYS * 24 * HOUR);
    expect(window.endMs).toBeGreaterThanOrEqual(before);
    expect(window.endMs).toBeLessThanOrEqual(after);
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

describe('#10758 item 1: the popup pass work', () => {
  it('starts no pass job for a reservoir, which names its own next measurement', async () => {
    const result = await loadObjectImagery({ kind: 'point', point, ownNextPass: true });

    expect(harness.lookup).not.toHaveBeenCalled();
    expect(result.latest).toMatchObject({ candidates: [browserImage] });
    expect(result.nextPass).toBeNull();
  });

  it('asks the pass worker for the future window only', async () => {
    await loadObjectImagery({ kind: 'point', point });
    expect(harness.lookup.mock.calls[0]![0]).toEqual({ point, pastDays: 0, futureHours: NEXT_PASS_HOURS });
  });

  it('hands the image over before the pass worker answers', async () => {
    let answerPasses!: (value: unknown) => void;
    harness.lookup.mockImplementation(() => new Promise((resolve) => { answerPasses = resolve; }));
    const early: ObjectImagery[] = [];
    const pending = loadObjectImagery({ kind: 'point', point }, undefined, (imagery) => early.push(imagery));
    await vi.waitFor(() => expect(early).toHaveLength(1));

    expect(early[0]).toMatchObject({ latest: { candidates: [browserImage] }, nextPass: null, nextPassPending: true });
    answerPasses(passLookup([{ name: 'LANDSAT 9', timeMs: Date.now() + 2 * HOUR }]));
    expect((await pending).nextPass?.satellite).toBe('LANDSAT 9');
  });

  it('keeps a failed archive unavailable when no pass job runs', async () => {
    harness.evidence.mockImplementation(() => ({ acquisitions: [], failures: [{ archive: 'earth-search', reason: 'timeout' }] }));
    const result = await loadObjectImagery({ kind: 'point', point, ownNextPass: true });
    expect(result).toMatchObject({ latest: null, imageSearchFailed: true });
  });
});

describe('#10758 item 3: the next pass is shared in browser memory', () => {
  it('reopening the same popup reuses the next pass until it happens', async () => {
    await loadObjectImagery({ kind: 'point', point });
    const again = await loadObjectImagery({ kind: 'point', point });

    expect(harness.lookup).toHaveBeenCalledTimes(1);
    expect(again.nextPass?.satellite).toBe('LANDSAT 9');
  });

  it('looks again once the remembered pass has happened', async () => {
    const startMs = Date.now();
    let clockMs = startMs;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    harness.lookup.mockImplementationOnce(async () => passLookup([{ name: 'SOON', timeMs: startMs + HOUR }]));
    let again: ObjectImagery;
    try {
      expect((await loadObjectImagery({ kind: 'point', point })).nextPass?.satellite).toBe('SOON');
      clockMs = startMs + HOUR + 1;
      again = await loadObjectImagery({ kind: 'point', point });
    } finally {
      clock.mockRestore();
    }

    expect(harness.lookup).toHaveBeenCalledTimes(2);
    expect(again.nextPass?.satellite).toBe('LANDSAT 9');
  });

  it('looks again when the catalog revision changed since the pass was remembered', async () => {
    expect((await loadObjectImagery({ kind: 'point', point })).nextPass?.satellite).toBe('LANDSAT 9');
    harness.catalog = { fetchedAt: 2, inventoryVersion: 'v2' };
    harness.lookup.mockImplementation(async () => passLookup([{ name: 'SENTINEL-2B', timeMs: Date.now() + 3 * HOUR }]));
    const again = await loadObjectImagery({ kind: 'point', point });

    expect(harness.lookup).toHaveBeenCalledTimes(2);
    expect(again.nextPass?.satellite).toBe('SENTINEL-2B');
  });

  it('a lookup that finishes after its entry was forgotten does not put it back', async () => {
    let answerPasses!: (value: unknown) => void;
    harness.lookup.mockImplementationOnce(() => new Promise((resolve) => { answerPasses = resolve; }));
    const first = loadObjectImagery({ kind: 'point', point });
    await vi.waitFor(() => expect(harness.lookup).toHaveBeenCalledTimes(1));
    forgetNextPasses();
    answerPasses(passLookup([{ name: 'LANDSAT 9', timeMs: Date.now() + 2 * HOUR }]));
    await first;
    await loadObjectImagery({ kind: 'point', point });

    expect(harness.lookup).toHaveBeenCalledTimes(2);
  });

  it('looks again after a failed pass lookup', async () => {
    harness.lookup.mockImplementationOnce(async () => { throw new Error('worker crashed'); });
    expect((await loadObjectImagery({ kind: 'point', point })).nextPass).toBeNull();
    expect((await loadObjectImagery({ kind: 'point', point })).nextPass?.satellite).toBe('LANDSAT 9');
    expect(harness.lookup).toHaveBeenCalledTimes(2);
  });

  it('overlapping popups share one pass job, and closing one does not cancel the other', async () => {
    let answerPasses!: (value: unknown) => void;
    let jobSignal: AbortSignal | undefined;
    harness.lookup.mockImplementation((_query, options) => {
      jobSignal = options?.signal;
      return new Promise((resolve) => { answerPasses = resolve; });
    });
    const closed = new AbortController();
    const first = loadObjectImagery({ kind: 'point', point }, closed.signal);
    const second = loadObjectImagery({ kind: 'point', point });
    await vi.waitFor(() => expect(harness.lookup).toHaveBeenCalledTimes(1));
    closed.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    expect(jobSignal?.aborted).toBe(false);
    answerPasses(passLookup([{ name: 'LANDSAT 9', timeMs: Date.now() + 2 * HOUR }]));
    expect((await second).nextPass?.satellite).toBe('LANDSAT 9');
    expect(harness.lookup).toHaveBeenCalledTimes(1);
  });
});
