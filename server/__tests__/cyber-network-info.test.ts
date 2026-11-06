import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { cache, limiter } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  limiter: vi.fn(async (_scope: string, _limit: number, _window: string, _identifier: string) => ({ allowed: true, degraded: false })),
}));
vi.mock('../_shared/rate-limit', () => ({ checkScopedRateLimit: limiter }));
vi.mock('../_shared/redis', () => ({
  cachedFetchJson: vi.fn(async (key: string, _ttl: number, fetcher: () => Promise<unknown>) => {
    if (!cache.has(key)) cache.set(key, await fetcher());
    return cache.get(key);
  }),
}));
import { getNetworkInfo } from '../worldmonitor/cyber/v1/get-network-info';
const ctx = {} as Parameters<typeof getNetworkInfo>[0];
const prefix = { status: 'ok', data: { resource: '2.248.0.0/14', is_less_specific: true,
  query_time: '2026-11-06T08:00:00', asns: [{ asn: 3301, holder: 'Telia Company AB' }, { asn: 1234, holder: null }] } };

beforeEach(() => {
  cache.clear();
  vi.stubEnv('RIPESTAT_NETWORK_INFO_ENABLED', 'true');
  limiter.mockResolvedValue({ allowed: true, degraded: false });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
    url.includes('prefix-overview') ? prefix : { status: 'ok', data: { result: ['example.telia.com.', 'second.example.net'], error: '' } },
  )));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('passive cyber network context', () => {
  it('is disabled without explicit provider authorization', async () => {
    vi.stubEnv('RIPESTAT_NETWORK_INFO_ENABLED', '');
    expect((await getNetworkInfo(ctx, { ip: '2.249.90.120' })).status).toBe('disabled');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['example.com', 'https://1.1.1.1/', '127.0.0.1', '10.0.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '999.1.1.1', '1.1.1.1?foo=bar', '01.1.1.1', '2001:db8::1'])('rejects %s without lookup', async (ip) => {
    expect((await getNetworkInfo(ctx, { ip })).status).toBe('invalid');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns all routing origins and preserves source lookup time on cache hits', async () => {
    const first = await getNetworkInfo(ctx, { ip: '2.249.90.120' });
    expect(first).toMatchObject({ status: 'available', prefix: '2.248.0.0/14', isLessSpecific: true,
      asns: [{ asn: 3301, holder: 'Telia Company AB' }, { asn: 1234, holder: '' }], hostnames: ['example.telia.com', 'second.example.net'], routingAt: '2026-11-06T08:00:00.000Z' });
    expect(first.lookupAt).toMatch(/^\d{4}-/);
    expect(await getNetworkInfo(ctx, { ip: '2.249.90.120' })).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(limiter).toHaveBeenCalledTimes(2);
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://stat.ripe.net');
      expect(options).toMatchObject({ redirect: 'error', headers: { 'User-Agent': expect.any(String) }, signal: expect.any(AbortSignal) });
    }
  });
  it('canonicalizes IPv6 so equivalent inputs share a cache key', async () => {
    await getNetworkInfo(ctx, { ip: '2606:4700:4700:0000:0000:0000:0000:1111' });
    await getNetworkInfo(ctx, { ip: '2606:4700:4700::1111' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([{ allowed: false, degraded: false }, { allowed: true, degraded: true }])('fails closed on a rejected/degraded provider budget', async (decision) => {
    limiter.mockResolvedValue(decision);
    expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('rate_limited');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps routing results when reverse DNS fails', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes('reverse-dns')) throw new DOMException('Timed out', 'TimeoutError');
      return Response.json(prefix);
    });
    expect(await getNetworkInfo(ctx, { ip: '2.249.90.120' })).toMatchObject({ status: 'partial', hostnames: [], asns: [{ asn: 3301, holder: 'Telia Company AB' }, { asn: 1234, holder: '' }] });
  });
  it('distinguishes a successful empty result from a provider outage', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ status: 'ok', data: { asns: [], result: [], error: 'NXDOMAIN' } }));
    expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('no_data');
    cache.clear();
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('unavailable');
  });
  it('rejects provider maintenance and malformed payloads', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'maintenance', data: prefix.data }));
    expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('unavailable');
  });
});

it('keeps the daily and minute provider counters distinct and denies the daily ceiling', async () => {
  limiter.mockResolvedValueOnce({ allowed: true, degraded: false }).mockResolvedValueOnce({ allowed: false, degraded: false });
  expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('rate_limited');
  expect(limiter.mock.calls[0]).toEqual(['cyber-network-provider:60 s', 4, '60 s', 'global']);
  expect(limiter.mock.calls[1]).toEqual(['cyber-network-provider:1 d', 450, '1 d', 'global']);
  expect(fetch).not.toHaveBeenCalled();
});

it('treats a malformed routing payload as unavailable instead of a successful empty lookup', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ status: 'ok', data: { asns: ['bad'], unexpected: true } }));
  expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('unavailable');
});

it('round-trips the real generated client and cyber route', async () => {
  const { createCyberServiceRoutes } = await import('../../src/generated/server/worldmonitor/cyber/v1/service_server');
  const { CyberServiceClient } = await import('../../src/generated/client/worldmonitor/cyber/v1/service_client');
  const { cyberHandler } = await import('../worldmonitor/cyber/v1/handler');
  const routes = createCyberServiceRoutes(cyberHandler);
  const client = new CyberServiceClient('https://worldmonitor.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const route = routes.find(route => route.path === new URL(request.url).pathname && route.method === request.method);
      if (!route) throw new Error('Unknown cyber RPC route');
      return route.handler(request);
    },
  });
  const result = await client.getNetworkInfo({ ip: '2.249.90.120' });
  expect(result).toMatchObject({ status: 'available', ip: '2.249.90.120', asns: [{ asn: 3301, holder: 'Telia Company AB' }, { asn: 1234, holder: '' }] });
});
