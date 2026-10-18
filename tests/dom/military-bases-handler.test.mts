import { expect, it, vi } from 'vitest';

const { cachedFetchJson, geoSearchByBox } = vi.hoisted(() => ({
  cachedFetchJson: vi.fn(async (_key: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher()),
  geoSearchByBox: vi.fn(async () => []),
}));
vi.mock('../../server/_shared/redis', () => ({ cachedFetchJson, geoSearchByBox,
  getCachedJson: async () => 'fixture-version', getHashFieldsBatch: vi.fn(),
}));
import { listMilitaryBases } from '../../server/worldmonitor/military/v1/list-military-bases';

it('uses identical normalized query bounds for requests in the same server cache bucket', async () => {
  const req = { swLat: 10.1, swLon: 20.1, neLat: 30.1, neLon: 40.1, zoom: 7, type: '', kind: '', country: '' };
  const ctx = { request: new Request('https://example.com') } as Parameters<typeof listMilitaryBases>[0];
  await listMilitaryBases(ctx, req);
  await listMilitaryBases(ctx, { ...req, swLat: 10.2, swLon: 20.2, neLat: 30.2, neLon: 40.2 });
  expect(cachedFetchJson).toHaveBeenCalledTimes(2);
  expect(cachedFetchJson.mock.calls[0]?.[0]).toBe('military:bases:v2:10:20:31:41:7::::fixture-version');
  expect(cachedFetchJson.mock.calls[1]?.[0]).toBe(cachedFetchJson.mock.calls[0]?.[0]);
  expect(geoSearchByBox).toHaveBeenCalledTimes(2);
  expect(geoSearchByBox.mock.calls[0]).toEqual(geoSearchByBox.mock.calls[1]);
});
