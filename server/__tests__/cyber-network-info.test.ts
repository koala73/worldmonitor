import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { cache, limiter } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  limiter: vi.fn(async (_scope: string, _limit: number, _window: string, _identifier: string) => ({ allowed: true, degraded: false })),
}));
vi.mock('../_shared/rate-limit', () => ({ checkScopedRateLimit: limiter,
  getClientRateLimitKey: (request: Request) => request.headers.get('x-test-principal') || 'fixture',
}));
vi.mock('../_shared/redis', () => ({
  cachedFetchJsonWithMeta: vi.fn(async (key: string, _ttl: number, fetcher: () => Promise<unknown>) => {
    if (!cache.has(key)) cache.set(key, await fetcher());
    return { data: cache.get(key), source: 'fresh', leader: true };
  }),
}));
import { getNetworkInfo } from '../worldmonitor/cyber/v1/get-network-info';
import { cachedFetchJsonWithMeta } from '../_shared/redis';
const ctx = { request: new Request('https://worldmonitor.test') } as Parameters<typeof getNetworkInfo>[0];
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
    expect(limiter).toHaveBeenCalledTimes(3);
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
  limiter.mockResolvedValueOnce({ allowed: true, degraded: false }).mockResolvedValueOnce({ allowed: true, degraded: false }).mockResolvedValueOnce({ allowed: false, degraded: false });
  expect((await getNetworkInfo(ctx, { ip: '1.1.1.1' })).status).toBe('rate_limited');
  expect(limiter.mock.calls[0]).toEqual(['cyber-network-provider:caller', 6, '1 h', 'fixture']);
  expect(limiter.mock.calls[1]).toEqual(['cyber-network-provider:60 s', 4, '60 s', 'global']);
  expect(limiter.mock.calls[2]).toEqual(['cyber-network-provider:1 d', 450, '1 d', 'global']);
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

it('uses the real cache short cooldown for empty routing plus DNS failure and recovers after expiry', async () => {
  const realRedis = await vi.importActual<typeof import('../_shared/redis')>('../_shared/redis');
  vi.mocked(cachedFetchJsonWithMeta).mockImplementationOnce(realRedis.cachedFetchJsonWithMeta);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fixture');
  vi.stubEnv('LOCAL_API_MODE', '');
  const writes: unknown[][] = [];
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let recovered = false;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/')) {
      if (options?.method === 'POST') {
        writes.push(JSON.parse(String(options.body)));
        return Response.json({ result: 'OK' });
      }
      // Expired/missing entry on each read, as after the short cooldown.
      return Response.json({ result: null });
    }
    if (recovered) return Response.json(url.includes('prefix-overview') ? prefix : { status: 'ok', data: { result: [], error: 'NXDOMAIN' } });
    if (url.includes('prefix-overview')) return Response.json({ status: 'ok', data: { asns: [] } });
    throw new Error('provider outage with private diagnostic text');
  });
  try {
    expect((await getNetworkInfo(ctx, { ip: '9.9.9.9' })).status).toBe('unavailable');
    expect(writes[0]?.slice(2)).toEqual([JSON.stringify('__WM_NEG__'), 'EX', '120']);
    expect(warning).toHaveBeenCalledWith('[cyber-network-provider] incomplete lookup', { routing: 'ok', reverseDns: 'unavailable' });
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/9\.9\.9\.9|private diagnostic/);
    recovered = true;
    vi.mocked(cachedFetchJsonWithMeta).mockImplementationOnce(realRedis.cachedFetchJsonWithMeta);
    expect((await getNetworkInfo(ctx, { ip: '9.9.9.9' })).status).toBe('available');
    expect(writes[1]?.slice(3)).toEqual(['EX', '86400']);
  } finally {
    warning.mockRestore();
  }
});

it('limits one caller before global budgets without caching its refusal for another caller', async () => {
  const counts = new Map<string, number>();
  limiter.mockImplementation(async (scope, limit, _window, identifier) => {
    if (scope !== 'cyber-network-provider:caller') return { allowed: true, degraded: false };
    const count = (counts.get(identifier) || 0) + 1;
    counts.set(identifier, count);
    return { allowed: count <= limit, degraded: false };
  });
  const caller = (id: string) => ({ request: new Request('https://worldmonitor.test', {
    headers: { 'x-test-principal': id },
  }) }) as Parameters<typeof getNetworkInfo>[0];
  for (let i = 1; i <= 6; i++) {
    expect((await getNetworkInfo(caller('a'), { ip: `8.8.4.${i}` })).status).toBe('available');
  }
  const realRedis = await vi.importActual<typeof import('../_shared/redis')>('../_shared/redis');
  vi.mocked(cachedFetchJsonWithMeta).mockImplementationOnce(realRedis.cachedFetchJsonWithMeta)
    .mockImplementationOnce(realRedis.cachedFetchJsonWithMeta);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fixture');
  vi.stubEnv('LOCAL_API_MODE', '');
  const writes: unknown[][] = [];
  vi.mocked(fetch).mockClear().mockImplementation(async (input, options) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/')) {
      if (options?.method === 'POST') {
        writes.push(JSON.parse(String(options.body)));
        return Response.json({ result: 'OK' });
      }
      return Response.json({ result: null });
    }
    return Response.json(url.includes('prefix-overview') ? prefix : { status: 'ok', data: { result: [], error: 'NXDOMAIN' } });
  });
  limiter.mockClear();
  expect((await getNetworkInfo(caller('a'), { ip: '9.9.9.10' })).status).toBe('rate_limited');
  expect(limiter.mock.calls).toEqual([['cyber-network-provider:caller', 6, '1 h', 'a']]);
  expect(writes).toEqual([]);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('https://redis.test/'))).toBe(true);
  expect((await getNetworkInfo(caller('b'), { ip: '9.9.9.10' })).status).toBe('available');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.slice(3)).toEqual(['EX', '86400']);
});
