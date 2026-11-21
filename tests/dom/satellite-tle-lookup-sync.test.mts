/**
 * The satellite card reads its element set through getTrackedSatelliteTle(). That
 * lookup must follow the records the layer draws (DataLoaderManager.cachedSatRecs),
 * not the last fetch: between a fetch and initSatRecs() resolving, the layer still
 * draws the old records, and when initSatRecs() throws the layer is cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ initSatRecs: vi.fn() }));
vi.mock('@/services/satellites', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/satellites')>(),
  initSatRecs: mocks.initSatRecs,
}));

const { DataLoaderManager } = await import('@/app/data-loader');
const { getTrackedSatelliteTle } = await import('@/services/satellites');

const LINE1 = '1 39084U 13008A   26317.24430503  .00000327  00000-0  82611-4 0  9990';
const LINE2 = '2 39084  98.2148  25.4778 0001233  90.6356 269.4984 14.57111049719607';
const sat = (name: string, line2 = LINE2) => ({ id: '39084', name, country: 'US', type: 'optical', alt: 705, velocity: 7.5, inclination: 98.2, line1: LINE1, line2 });
const entry = (name: string) => ({ satrec: {}, meta: { noradId: '39084', name, type: 'optical', country: 'US' } });

let served: unknown[] = [];
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ satellites: served }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

function fakeLoader() {
  const setSatellites = vi.fn();
  const loader = {
    ctx: { map: { setSatellites } },
    cachedSatRecs: [] as unknown[],
    satellitePropagationCleanup: null,
    stopSatellitePropagation: vi.fn(),
  };
  return { loader, setSatellites };
}
const load = (loader: object) => DataLoaderManager.prototype.loadSatellites.call(loader as never);

// fetchSatelliteTLEs caches for 10 minutes; step the clock past that so every load refetches.
let clock = Date.UTC(2026, 10, 15, 12, 0);
const nextFetchWindow = () => { clock += 11 * 60_000; vi.setSystemTime(clock); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  nextFetchWindow();
  vi.stubGlobal('fetch', fetchMock);
  mocks.initSatRecs.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tracked satellite element-set lookup', () => {
  it('keeps answering with the drawn element set until the new records replace it', async () => {
    const { loader } = fakeLoader();
    served = [sat('LANDSAT 8 OLD')];
    mocks.initSatRecs.mockResolvedValueOnce([entry('LANDSAT 8 OLD')]);
    await load(loader);
    expect(getTrackedSatelliteTle('39084')?.name).toBe('LANDSAT 8 OLD');

    nextFetchWindow();
    served = [sat('LANDSAT 8 NEW')];
    let finish!: (recs: unknown[]) => void;
    mocks.initSatRecs.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = load(loader);
    await vi.waitFor(() => expect(mocks.initSatRecs).toHaveBeenCalledTimes(2));
    // The layer still draws the old records, so the card must still read them.
    expect(getTrackedSatelliteTle('39084')?.name).toBe('LANDSAT 8 OLD');

    finish([entry('LANDSAT 8 NEW')]);
    await pending;
    expect(getTrackedSatelliteTle('39084')?.name).toBe('LANDSAT 8 NEW');
  });

  it('forgets the element sets when the layer is cleared because initSatRecs throws', async () => {
    const { loader, setSatellites } = fakeLoader();
    served = [sat('LANDSAT 8 BROKEN')];
    mocks.initSatRecs.mockRejectedValueOnce(new Error('satellite.js failed to load'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await load(loader);
    expect(setSatellites).toHaveBeenLastCalledWith([]);
    expect(getTrackedSatelliteTle('39084')).toBeNull();
  });

  it('forgets the element sets when the layer is cleared for missing data', async () => {
    const { loader, setSatellites } = fakeLoader();
    served = [sat('LANDSAT 8')];
    mocks.initSatRecs.mockResolvedValueOnce([entry('LANDSAT 8')]);
    await load(loader);
    expect(getTrackedSatelliteTle('39084')).not.toBeNull();

    // Past the one-hour last-good limit with every refetch failing: no data, layer cleared.
    clock += 61 * 60_000;
    vi.setSystemTime(clock);
    fetchMock.mockImplementationOnce(async () => new Response('down', { status: 503 }));
    await load(loader);
    expect(setSatellites).toHaveBeenLastCalledWith([]);
    expect(getTrackedSatelliteTle('39084')).toBeNull();
  });

  it('only answers for satellites that have a drawn record', async () => {
    const { loader } = fakeLoader();
    served = [sat('LANDSAT 8'), { ...sat('BAD'), id: '99999', line1: LINE1.replace('39084', '99999'), line2: LINE2.replace('39084', '99999') }];
    mocks.initSatRecs.mockResolvedValueOnce([entry('LANDSAT 8')]);
    await load(loader);
    expect(getTrackedSatelliteTle('39084')?.name).toBe('LANDSAT 8');
    expect(getTrackedSatelliteTle('99999')).toBeNull();
  });
});
