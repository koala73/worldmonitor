// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { listWorldBankIndicators } from '../worldmonitor/economic/v1/list-world-bank-indicators';
import { __resetKeyPrefixCacheForTests } from '../_shared/redis';
import { __resetRateLimitForTest } from '../_shared/rate-limit';
import { createDomainGateway } from '../gateway';
import { createEconomicServiceRoutes, type EconomicServiceHandler } from '../../src/generated/server/worldmonitor/economic/v1/service_server';
import { issueSessionToken } from '../../api/_session.js';
import type { ListWorldBankIndicatorsRequest, ServerContext } from '../../src/generated/server/worldmonitor/economic/v1/service_server';

const ctx = {} as ServerContext;
const indicator = 'NY.GDP.MKTP.CD';
const env = { ...process.env };
let cache: Map<string, string>;
let reads: string[];
let writes: unknown[][];
let providerUrls: URL[];
let providerStatus: number;
const record = (code: string) => ({ countryiso3code: code, country: { value: code }, indicator: { value: 'GDP' }, date: '2024', value: 42 });

beforeEach(() => {
  cache = new Map(); reads = []; writes = []; providerUrls = []; providerStatus = 200;
  process.env.UPSTASH_REDIS_REST_URL = 'https://wb-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.VERCEL_ENV = 'production';
  process.env.WM_SESSION_SECRET = 'synthetic-world-bank-session-secret';
  delete process.env.LOCAL_API_MODE;
  delete process.env.AXIOM_TOKEN;
  __resetKeyPrefixCacheForTests();
  __resetRateLimitForTest();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.worldbank.org') {
      providerUrls.push(url);
      expect(new Headers(init?.headers).get('User-Agent')).toBeTruthy();
      const countries = decodeURIComponent(url.pathname.split('/')[3]!);
      return Response.json([{}, [record(countries === 'all' ? 'AFG' : 'USA')]], { status: providerStatus });
    }
    expect(url.hostname).toBe('wb-redis.invalid');
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      reads.push(key);
      return Response.json({ result: cache.get(key) ?? null });
    }
    const command = JSON.parse(String(init?.body));
    if (Array.isArray(command[0])) {
      return Response.json(command.map((entry: unknown[]) => {
        expect(String(entry[0])).toMatch(/^eval(sha)?$/i);
        expect(String(entry[3])).toContain('rl:ep:/api/economic/v1/list-world-bank-indicators:ip:');
        expect(Number(entry[3 + Number(entry[2])])).toBe(30);
        return { result: [29, 30] };
      }));
    }
    expect(command[0]).toBe('SET');
    writes.push(command);
    cache.set(command[1], command[2]);
    return Response.json({ result: 'OK' });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  __resetKeyPrefixCacheForTests();
});
function request(overrides: Partial<ListWorldBankIndicatorsRequest> = {}) {
  return listWorldBankIndicators(ctx, { indicatorCode: indicator, countryCode: '', year: 0, pageSize: 0, cursor: '', ...overrides });
}

for (const first of ['', 'all']) {
  test(`default and explicit all stay isolated when ${first || 'default'} primes the cache`, async () => {
    await request({ countryCode: first });
    const all = await request({ countryCode: 'all' });
    const curated = await request();
    expect(all.data[0]?.countryCode).toBe('AFG');
    expect(curated.data[0]?.countryCode).toBe('USA');
    expect(providerUrls).toHaveLength(2);
    expect(new Set(reads).size).toBe(2);
    expect(reads.some(key => key.includes(':__default__:'))).toBe(true);
    expect(writes.every(command => command[3] === 'EX' && command[4] === '86400')).toBe(true);
  });
}
test('does not reuse either payload from the ambiguous v1 cache', async () => {
  cache.set(`economic:worldbank:v1:${indicator}:all:0`, JSON.stringify({ data: [{ countryCode: 'POISON' }] }));
  expect((await request()).data[0]?.countryCode).toBe('USA');
  expect((await request({ countryCode: 'all' })).data[0]?.countryCode).toBe('AFG');
  expect(providerUrls).toHaveLength(2);
});
test('canonicalizes ISO2/ISO3 country lists, case, duplicates and order before cache lookup', async () => {
  await request({ countryCode: ' us ; DEU;USA ', year: 5 });
  await request({ countryCode: 'DE;US', year: 0 });
  expect(providerUrls).toHaveLength(1);
  expect(new Set(reads).size).toBe(1);
  expect(decodeURIComponent(providerUrls[0]!.pathname.split('/')[3]!)).toBe('DEU;USA');
  expect(providerUrls[0]!.pathname).toContain('DEU%3BUSA');
});
test('keeps the public response envelope and no-op pagination contract', async () => {
  const result = await request({ countryCode: 'US', pageSize: 1, cursor: 'ignored' });
  expect(result).toEqual({ data: [{ countryCode: 'USA', countryName: 'USA', indicatorCode: indicator, indicatorName: 'GDP', year: 2024, value: 42 }], pagination: undefined });
});
for (const countryCode of ['BQ', 'GF', 'GP', 'MQ', 'RE']) {
  test(`preserves documented alpha-2 filter absent from the alias map: ${countryCode}`, async () => {
    expect((await request({ countryCode })).data).toHaveLength(1);
    expect(decodeURIComponent(providerUrls[0]!.pathname.split('/')[3]!)).toBe(countryCode);
  });
}
test('preserves first-party session access through the gateway and existing rate policy', async () => {
  const path = '/api/economic/v1/list-world-bank-indicators';
  const routes = createEconomicServiceRoutes({ listWorldBankIndicators } as EconomicServiceHandler).filter(route => route.path === path);
  const gateway = createDomainGateway(routes);
  const token = (await issueSessionToken()).token;
  const response = await gateway(new Request(`https://worldmonitor.app${path}?indicator_code=${indicator}&country_code=US`, {
    headers: { Cookie: `wm-session=${token}`, 'x-real-ip': '192.0.2.52' },
  }), { waitUntil: () => {} });
  expect(response.status).toBe(200);
  expect((await response.json()).data[0].countryCode).toBe('USA');
  expect(providerUrls).toHaveLength(1);
});
for (const code of ['IT.NET.USER.ZS', 'IT.CEL.SETS.P2', 'IT.NET.BBND.P2', 'IT.NET.SECR.P6', 'GB.XPD.RSDV.GD.ZS', 'IP.PAT.RESD', 'IP.PAT.NRES', 'IP.TMK.TOTL', 'TX.VAL.TECH.MF.ZS', 'BX.GSR.CCIS.ZS', 'TM.VAL.ICTG.ZS.UN', 'SE.TER.ENRR', 'SE.XPD.TOTL.GD.ZS', 'NY.GDP.MKTP.KD.ZG', 'NY.GDP.PCAP.CD', 'NE.EXP.GNFS.ZS', 'NY.GDP.MKTP.CD']) {
  test(`supports the catalogue or documented indicator ${code}`, async () => {
    expect((await request({ indicatorCode: code })).data).toHaveLength(1);
    expect(providerUrls[0]!.pathname.endsWith(`/indicator/${encodeURIComponent(code)}`)).toBe(true);
  });
}
for (const countryCode of ['__default__', '../all', 'all?x=1', 'US/indicator/X', 'US;all', 'ZZZ', 'US;;DE', 'US#fragment', 'USA'.repeat(400), Array(251).fill('US').join(';')]) {
  test(`rejects invalid country input before cache/provider I/O: ${countryCode.slice(0, 30)}`, async () => {
    expect(await request({ countryCode })).toEqual({ data: [], pagination: undefined });
    expect(reads).toHaveLength(0); expect(providerUrls).toHaveLength(0); expect(writes).toHaveLength(0);
  });
}
for (const indicatorCode of ['', '../country/all', 'NY.GDP?date=1900', 'NY.GDP#fragment', 'NY.GDP:all', 'NY.GDP/other', 'A'.repeat(65)]) {
  test(`rejects invalid indicator before cache/provider I/O: ${indicatorCode.slice(0, 30)}`, async () => {
    expect(await request({ indicatorCode })).toEqual({ data: [], pagination: undefined });
    expect(reads).toHaveLength(0); expect(providerUrls).toHaveLength(0); expect(writes).toHaveLength(0);
  });
}
test('bounds lookback and canonicalizes equivalent defaults', async () => {
  await request({ year: 0 }); await request({ year: -1 }); await request({ year: 5 });
  await request({ year: 30 }); await request({ year: 2147483647 });
  expect(providerUrls).toHaveLength(2);
  const currentYear = new Date().getFullYear();
  expect(providerUrls.map(url => url.searchParams.get('date'))).toEqual([`${currentYear - 5}:${currentYear}`, `${currentYear - 30}:${currentYear}`]);
});
test('retains the empty response on provider failure', async () => {
  providerStatus = 503;
  expect(await request()).toEqual({ data: [], pagination: undefined });
});
for (const year of [NaN, Infinity, 1.5]) {
  test(`rejects non-integer lookback ${year} before I/O`, async () => {
    expect(await request({ year })).toEqual({ data: [], pagination: undefined });
    expect(reads).toHaveLength(0); expect(providerUrls).toHaveLength(0);
  });
}
