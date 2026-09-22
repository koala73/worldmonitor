// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { KEY_PREFIX } from '../../scripts/seed-trade-flows.mjs';
import { writeExtraKey } from '../../scripts/_seed-utils.mjs';
import type { ComtradeFlowRecord, ServerContext } from '../../src/generated/server/worldmonitor/trade/v1/service_server';

vi.mock('../_shared/premium-check', () => ({ isCallerPremium: vi.fn(async () => true) }));

const key = `${KEY_PREFIX}:842:2709`;
const fetchedAt = '2026-09-01T00:00:00Z';
const older: ComtradeFlowRecord = {
  reporterCode: '842', reporterName: 'United States', partnerCode: '124', partnerName: 'Canada',
  cmdCode: '2709', cmdDesc: 'Crude petroleum', year: 2023, tradeValueUsd: 1000,
  netWeightKg: 100, yoyChange: 50, isAnomaly: true,
};
const newer = { ...older, year: 2024, yoyChange: 10, isAnomaly: false };
const request = { reporterCode: '842', cmdCode: '2709', anomaliesOnly: false };
const ctx = { request: new Request('https://worldmonitor.app/api/trade/v1/list-comtrade-flows') } as ServerContext;
let store: Map<string, string>;
let reads: string[];
let writes: string[];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic-token');
  vi.stubEnv('LOCAL_API_MODE', '');
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'deadbeef12345678');
  store = new Map();
  reads = [];
  writes = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body)) as string[][];
      return Response.json(commands.map(([command, cacheKey]) => {
        expect(command).toBe('GET');
        reads.push(cacheKey);
        return { result: store.get(cacheKey) ?? null };
      }));
    }
    expect(String(input)).toBe('https://redis.test');
    const [command, cacheKey, payload] = JSON.parse(String(init?.body)) as string[];
    expect(command).toBe('SET');
    writes.push(cacheKey);
    store.set(cacheKey, payload);
    return Response.json({ result: 'OK' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test.each(['preview', 'development', 'production'])('reads seeder-owned keys in %s', async (env) => {
  vi.stubEnv('VERCEL_ENV', env);
  await writeExtraKey(key, { flows: [older, newer], fetchedAt }, 3600);
  const { listComtradeFlows } = await import('../worldmonitor/trade/v1/list-comtrade-flows');
  const result = await listComtradeFlows(ctx, request);
  expect(writes).toEqual([key]);
  expect(reads).toEqual([key]);
  expect(result).toEqual({ flows: [newer, older], fetchedAt, upstreamUnavailable: false });
});

test('preserves anomaly filtering and missing-data response', async () => {
  const { listComtradeFlows } = await import('../worldmonitor/trade/v1/list-comtrade-flows');
  expect(await listComtradeFlows(ctx, request)).toEqual({ flows: [], fetchedAt: '', upstreamUnavailable: true });
  await writeExtraKey(key, { flows: [older, newer], fetchedAt }, 3600);
  expect(await listComtradeFlows(ctx, { ...request, anomaliesOnly: true })).toEqual({
    flows: [older], fetchedAt, upstreamUnavailable: false,
  });
});

test('premium denial still returns no data without reading Redis', async () => {
  const { isCallerPremium } = await import('../_shared/premium-check');
  vi.mocked(isCallerPremium).mockResolvedValueOnce(false);
  const { listComtradeFlows } = await import('../worldmonitor/trade/v1/list-comtrade-flows');
  expect(await listComtradeFlows(ctx, request)).toEqual({ flows: [], fetchedAt: '', upstreamUnavailable: true });
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
});
