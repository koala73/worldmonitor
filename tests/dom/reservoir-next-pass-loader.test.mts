import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: true,
  scan: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('@/config/orbital-watch-flag', () => ({ get ORBITAL_WATCH_ENABLED() { return mocks.enabled; } }));
vi.mock('@/services/climate/index', () => ({ fetchReservoirLevels: async () => ({ snapshot: null }) }));
vi.mock('@/services/orbital/catalog', () => ({
  loadOrbitalCatalog: async () => ({
    status: 'fresh', fetchedAt: 0, inventoryVersion: 't',
    satellites: [
      { noradId: 1, name: 'OTHER', profileId: 'landsat', elementSets: [] },
      { noradId: 43613, name: 'ICESAT-2', profileId: 'icesat-2', elementSets: [] },
    ],
  }),
}));
vi.mock('@/services/orbital/pass-client', () => ({ getOrbitalPassClient: () => ({ reservoirNextPasses: mocks.scan }) }));
vi.mock('@/services/orbital/reservoir-next-pass', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orbital/reservoir-next-pass')>()),
  computeReservoirNextPasses: mocks.sync,
}));

const sites = [{ id: 'a', core: [0, 0, 1, 1] as const }];
const prediction = new Map([['a', { status: 'none' as const, windowEndMs: Date.now() + 1e9, elementsEpochMs: 0 }]]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function freshLoader() {
  vi.resetModules();
  return import('@/services/climate/reservoir-context-loader');
}

beforeEach(() => {
  mocks.enabled = true;
  mocks.scan.mockReset();
  mocks.sync.mockReset().mockImplementation(() => { throw new Error('the synchronous scan must not run on the calling thread'); });
});

describe('loadReservoirNextPasses', () => {
  it('hands the ICESat-2 elements to the off-thread client and never runs the synchronous scan', async () => {
    mocks.scan.mockResolvedValue(prediction);
    const { loadReservoirNextPasses } = await freshLoader();
    expect(await loadReservoirNextPasses(sites)).toBe(prediction);
    expect(mocks.sync).not.toHaveBeenCalled();
    const [scanInput] = mocks.scan.mock.calls[0]!;
    expect(scanInput.satellites.map((s: { profileId: string }) => s.profileId)).toEqual(['icesat-2']);
    expect(scanInput.sites).toEqual(sites);
  });

  it('stays dark without Orbital Watch and starts no scan', async () => {
    mocks.enabled = false;
    const { loadReservoirNextPasses } = await freshLoader();
    expect(await loadReservoirNextPasses(sites)).toBeNull();
    expect(mocks.scan).not.toHaveBeenCalled();
  });

  it('cancels the scan when the only caller goes away, and resolves that caller with null', async () => {
    let workSignal: AbortSignal | undefined;
    mocks.scan.mockImplementation((_input, options: { signal: AbortSignal }) => new Promise((_, reject) => {
      workSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { loadReservoirNextPasses } = await freshLoader();
    const caller = new AbortController();
    const result = loadReservoirNextPasses(sites, { signal: caller.signal });
    await flush();
    caller.abort();
    expect(await result).toBeNull();
    await flush();
    expect(workSignal?.aborted).toBe(true);
    // The aborted scan is forgotten, so the next caller starts a fresh one.
    mocks.scan.mockResolvedValue(prediction);
    expect(await loadReservoirNextPasses(sites)).toBe(prediction);
  });

  it('keeps the shared scan running while another caller still waits', async () => {
    let finish!: (value: typeof prediction) => void;
    let workSignal: AbortSignal | undefined;
    mocks.scan.mockImplementation((_input, options: { signal: AbortSignal }) => new Promise((resolve) => { workSignal = options.signal; finish = resolve; }));
    const { loadReservoirNextPasses } = await freshLoader();
    const leaving = new AbortController();
    const first = loadReservoirNextPasses(sites, { signal: leaving.signal });
    const second = loadReservoirNextPasses(sites);
    await flush();
    leaving.abort();
    expect(await first).toBeNull();
    expect(workSignal?.aborted).toBe(false);
    finish(prediction);
    expect(await second).toBe(prediction);
    expect(mocks.scan).toHaveBeenCalledTimes(1);
  });

  it('resolves null for an already aborted caller without starting a scan', async () => {
    const { loadReservoirNextPasses } = await freshLoader();
    expect(await loadReservoirNextPasses(sites, { signal: AbortSignal.abort() })).toBeNull();
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});
