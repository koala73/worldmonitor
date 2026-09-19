import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMilitaryBases } = vi.hoisted(() => ({ listMilitaryBases: vi.fn() }));
vi.mock('@/services/rpc-client', () => ({ getRpcBaseUrl: () => '' }));
vi.mock('@/services/generated-rpc-clients', () => ({ MilitaryServiceClient: class { listMilitaryBases = listMilitaryBases; } }));

async function service() {
  vi.resetModules();
  return (await import('@/services/military-bases')).fetchMilitaryBases;
}
function deferred() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof response>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(id: string) {
  return { bases: [{ id, name: id, latitude: 10, longitude: 20 }], clusters: [], totalInView: 1, truncated: false };
}
beforeEach(() => { listMilitaryBases.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('military base request identity', () => {
  it('isolates concurrent viewports completed in reverse order and shares identical keys', async () => {
    const fetchBases = await service();
    const a = deferred(); const b = deferred();
    listMilitaryBases.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = fetchBases(0, 0, 10, 10, 5);
    const same = fetchBases(0, 0, 10, 10, 5);
    const second = fetchBases(30, 30, 40, 40, 5);
    expect(listMilitaryBases).toHaveBeenCalledTimes(2);
    b.resolve(response('B'));
    expect((await second)?.bases[0]?.id).toBe('B');
    a.resolve(response('A'));
    expect((await first)?.bases[0]?.id).toBe('A');
    expect(await same).toBe(await first);
    expect(await fetchBases(0, 0, 10, 10, 5)).toBe(await first);
    expect(listMilitaryBases).toHaveBeenCalledTimes(2);
  });

  it('separates zoom and every filter dimension', async () => {
    const fetchBases = await service();
    listMilitaryBases.mockResolvedValue(response('base'));
    await Promise.all([
      fetchBases(0, 0, 10, 10, 5), fetchBases(0, 0, 10, 10, 6),
      fetchBases(0, 0, 10, 10, 5, { type: 'naval' }),
      fetchBases(0, 0, 10, 10, 5, { kind: 'base' }),
      fetchBases(0, 0, 10, 10, 5, { country: 'US' }),
    ]);
    expect(listMilitaryBases).toHaveBeenCalledTimes(5);
  });

  it('never falls back across viewports and releases failed keys for retry', async () => {
    const fetchBases = await service();
    listMilitaryBases.mockResolvedValueOnce(response('A'));
    await fetchBases(0, 0, 10, 10, 5);
    const failed = deferred();
    listMilitaryBases.mockReturnValueOnce(failed.promise);
    const b = fetchBases(30, 30, 40, 40, 5);
    const sameB = fetchBases(30, 30, 40, 40, 5);
    failed.reject(new Error('offline'));
    expect(await b).toBeNull(); expect(await sameB).toBeNull();
    listMilitaryBases.mockResolvedValueOnce(response('B'));
    expect((await fetchBases(30, 30, 40, 40, 5))?.bases[0]?.id).toBe('B');
    expect(listMilitaryBases).toHaveBeenCalledTimes(3);
  });

  it('treats handler empty-200 as a miss so the key can retry', async () => {
    const fetchBases = await service();
    listMilitaryBases.mockResolvedValueOnce({ bases: [], clusters: [], totalInView: 0, truncated: false });
    expect(await fetchBases(0, 0, 10, 10, 5)).toBeNull();
    listMilitaryBases.mockResolvedValueOnce(response('recovered'));
    expect((await fetchBases(0, 0, 10, 10, 5))?.bases[0]?.id).toBe('recovered');
    expect(listMilitaryBases).toHaveBeenCalledTimes(2);
  });
});

it('shares normalized requests that cover every original viewport edge', async () => {
  const fetchBases = await service();
  const pending = deferred();
  listMilitaryBases.mockReturnValue(pending.promise);
  const a = fetchBases(10.1, 20.1, 30.1, 40.1, 7.9);
  const b = fetchBases(10.2, 20.2, 30.2, 40.2, 7.9);
  expect(listMilitaryBases).toHaveBeenCalledTimes(1);
  expect(listMilitaryBases).toHaveBeenCalledWith({ swLat: 10, swLon: 20, neLat: 31, neLon: 41, zoom: 7, type: '', kind: '', country: '' });
  pending.resolve(response('shared-grid'));
  expect(await a).toBe(await b);
});
