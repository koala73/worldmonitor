import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

it('reports ok for an answered RPC even when the dataset has no readings yet', async () => {
  const fetchMock = vi.fn(async () => json({ reservoirs: [], fetchedAt: 0, dataAvailable: false, methodology: '' }));
  vi.stubGlobal('fetch', fetchMock);
  const { fetchReservoirLevels } = await import('@/services/climate');
  await expect(fetchReservoirLevels()).resolves.toEqual({ ok: true, snapshot: null });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('reports not ok when the RPC fails and nothing is cached', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'boom' }, 500)));
  const { fetchReservoirLevels } = await import('@/services/climate');
  await expect(fetchReservoirLevels()).resolves.toEqual({ ok: false, snapshot: null });
});
