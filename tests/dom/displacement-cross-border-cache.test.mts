import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GetCrossBorderMovementsResponse } from '@/generated/client/worldmonitor/displacement/v1/service_client';

const { getMovements } = vi.hoisted(() => ({ getMovements: vi.fn() }));
vi.mock('@/services/generated-rpc-clients', () => ({
  DisplacementServiceClient: class { getCrossBorderMovements = getMovements; },
}));
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async () => null,
  setPersistentCache: async () => {},
  deletePersistentCache: async () => {},
}));
vi.mock('@/utils', async () => ({
  ...await import('@/utils/circuit-breaker'),
  getCSSColor: () => '',
}));

let fetchCrossBorderArrivals: typeof import('@/services/displacement').fetchCrossBorderArrivals;

const START = Date.parse('2026-10-20T12:00:00Z');
function response(fetchedAt: number, asOf = '2026-10-19'): GetCrossBorderMovementsResponse {
  return {
    dataAvailable: true,
    sources: [{ id: 'uk', name: 'UK Home Office', status: 'ok', fetchedAt, contentAt: Date.parse(asOf), maxContentAgeMin: 4320 }],
    movements: [{ id: 'english-channel', route: 'english-channel', name: 'Channel', kind: 'arrival', measure: 'daily',
      countryCode: 'GB', originCode: '', asOf, period: 'day', count: 1000, surge: true, stale: false,
      source: 'UK Home Office', sourceUrl: 'https://www.gov.uk/', license: 'OGL v3.0', licenseUrl: '', notice: '', stockChangeSince: '',
      location: { latitude: 51, longitude: 1 } }],
  };
}
beforeEach(async () => {
  vi.resetModules();
  ({ fetchCrossBorderArrivals } = await import('@/services/displacement'));
  vi.useFakeTimers();
  vi.setSystemTime(START);
  getMovements.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

it('expires source clocks during a fresh browser cache hit without mutating the saved report', async () => {
  const snapshot = response(START - 48 * 3600000 + 60000);
  getMovements.mockResolvedValue(snapshot);
  expect((await fetchCrossBorderArrivals()).points).toHaveLength(1);
  vi.setSystemTime(START + 120000);
  const expired = await fetchCrossBorderArrivals();
  expect(getMovements).toHaveBeenCalledTimes(1);
  expect(expired.points).toHaveLength(0);
  expect(expired.situations[0]).toMatchObject({ stale: true, accelerating: false, total: 1000 });
  expect(expired.sources?.[0]?.status).toBe('stale');
  expect(snapshot.movements[0]?.stale).toBe(false);
  expect(snapshot.sources[0]?.fetchedAt).toBe(START - 48 * 3600000 + 60000);
});

it('ages retained reports after failed refreshes while preserving a healthy source', async () => {
  const snapshot = response(START - 47 * 3600000);
  const source = { id: 'cbp', name: 'US CBP', status: 'ok', fetchedAt: START, contentAt: Date.parse('2026-09-30'), maxContentAgeMin: 108000 };
  snapshot.sources.push(source);
  snapshot.movements.push({ ...snapshot.movements[0]!, id: 'cbp', source: source.name, kind: 'encounter', measure: 'monthly', asOf: '2026-09-30', surge: false });
  getMovements.mockResolvedValueOnce(snapshot).mockRejectedValue(new Error('controlled outage'));
  expect((await fetchCrossBorderArrivals()).points).toHaveLength(2);
  vi.setSystemTime(START + 2 * 3600000);
  const retained = await fetchCrossBorderArrivals();
  expect(retained.points.map(point => point.source)).toEqual(['US CBP']);
  expect(retained.situations[0]?.accelerating).toBe(false);
  expect(retained.sources?.map(item => item.status)).toEqual(['stale', 'ok']);
  await vi.advanceTimersByTimeAsync(0);
  expect(getMovements).toHaveBeenCalledTimes(2);
});

it('expires the per-report age while the producer fetch clock remains fresh', async () => {
  vi.setSystemTime(Date.parse('2026-10-20T23:59:00Z'));
  getMovements.mockResolvedValue(response(START, '2026-10-18'));
  expect((await fetchCrossBorderArrivals()).points).toHaveLength(1);
  vi.setSystemTime(Date.parse('2026-10-21T00:01:00Z'));
  const expired = await fetchCrossBorderArrivals();
  expect(getMovements).toHaveBeenCalledTimes(1);
  expect(expired.points).toHaveLength(0);
  expect(expired.situations[0]?.stale).toBe(true);
});
