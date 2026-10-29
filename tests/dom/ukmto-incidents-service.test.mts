import { expect, it, vi } from 'vitest';
const upstream = vi.hoisted(() => ({ value: undefined as unknown, fetch: vi.fn() }));
vi.mock('@/services/bootstrap', () => ({ ensureHydrated: async (key: string) => { upstream.fetch(key); return upstream.value; } }));
import { fetchUkmtoIncidents } from '@/services/ukmto-incidents';

it('retains and ages the last good snapshot when the bootstrap source is unavailable', async () => {
  const now = Date.now();
  upstream.value = { incidents: [], fetchedAt: now, dataAvailable: true };
  expect((await fetchUkmtoIncidents()).dataAvailable).toBe(true);
  upstream.value = undefined;
  // The publisher refreshes every 30 minutes, so one missed run is still current.
  vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60000);
  expect(await fetchUkmtoIncidents()).toMatchObject({ fetchedAt: now, stale: false, dataAvailable: true });
  vi.mocked(Date.now).mockReturnValue(now + 76 * 60000);
  expect(await fetchUkmtoIncidents()).toMatchObject({ fetchedAt: now, stale: true, dataAvailable: true });
  vi.mocked(Date.now).mockReturnValue(now + 86400001);
  expect((await fetchUkmtoIncidents()).dataAvailable).toBe(false);
  expect(upstream.fetch).toHaveBeenCalledWith('ukmtoIncidents');
  vi.restoreAllMocks();
});

it('accepts incidents whose publication time the source does not carry', async () => {
  const now = Date.now();
  const incident = { id: 'ukmto-186', incidentNumber: 186, incidentType: 'Attack', place: 'Strait of Hormuz',
    description: 'Tanker struck.', occurredAt: now - 3600000, reportedAt: 0, location: { latitude: 26.38, longitude: 56.33 } };
  upstream.value = { incidents: [incident], fetchedAt: now, dataAvailable: true };
  expect(await fetchUkmtoIncidents()).toMatchObject({ incidents: [incident], dataAvailable: true });
  upstream.value = { incidents: [{ ...incident, reportedAt: -1 }], fetchedAt: now + 1, dataAvailable: true };
  expect((await fetchUkmtoIncidents()).fetchedAt).toBe(now);
});

it('keeps a fresh snapshot available when the browser clock runs behind the producer', async () => {
  const now = Date.now();
  upstream.value = { incidents: [], fetchedAt: now + 10 * 60000, dataAvailable: true };
  vi.spyOn(Date, 'now').mockReturnValue(now);
  expect(await fetchUkmtoIncidents()).toMatchObject({ fetchedAt: now + 10 * 60000, dataAvailable: true, stale: false });
  vi.restoreAllMocks();
});
