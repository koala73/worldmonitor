import { expect, it, vi } from 'vitest';
const upstream = vi.hoisted(() => ({ value: undefined as unknown, fetch: vi.fn() }));
vi.mock('@/services/bootstrap', () => ({ ensureHydrated: async (key: string) => { upstream.fetch(key); return upstream.value; } }));
import { fetchUkmtoIncidents } from '@/services/ukmto-incidents';

it('retains and ages the last good snapshot when the bootstrap source is unavailable', async () => {
  const now = Date.now();
  upstream.value = { incidents: [], fetchedAt: now };
  expect((await fetchUkmtoIncidents()).dataAvailable).toBe(true);
  upstream.value = undefined;
  vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60000);
  expect(await fetchUkmtoIncidents()).toMatchObject({ fetchedAt: now, stale: true, dataAvailable: true });
  vi.mocked(Date.now).mockReturnValue(now + 86400001);
  expect((await fetchUkmtoIncidents()).dataAvailable).toBe(false);
  expect(upstream.fetch).toHaveBeenCalledWith('ukmtoIncidents');
  vi.restoreAllMocks();
});
