import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { countryHistoryDays, bindCountryHistoryAccess } from '../server/_shared/country-history-access';
import { getCountryHistory } from '../server/worldmonitor/intelligence/v1/get-country-history';
import { getFeaturesForPlan, mergeEntitlementFeatures } from '../convex/lib/entitlements';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';

const now = Date.now();
const day = Math.floor(now / 86400000);
const row = (offset = 0, version = 'v11') => ({ countryCode: 'US', date: new Date((day + offset) * 86400000).toISOString().slice(0, 10), capturedAt: now + offset * 86400000, cii: { score: 25, version, observedAt: now + offset * 86400000 }, topEvents: [], keySignals: [] });
const fetchOriginal = globalThis.fetch;
const envOriginal = { ...process.env };
afterEach(() => { globalThis.fetch = fetchOriginal; process.env = { ...envOriginal }; __resetKeyPrefixCacheForTests(); });

test('catalog and legacy read-time merge give free 7, Pro 90, API and Enterprise 365 days', () => {
  for (const [plan, expected] of [['free', 7], ['pro_monthly', 90], ['api_starter', 365], ['enterprise', 365]] as const) {
    const features = getFeaturesForPlan(plan);
    assert.equal(features.historyDays, expected, plan);
    assert.equal(countryHistoryDays({ features, validUntil: now + 60000 }), expected);
  }
  const legacy = { ...getFeaturesForPlan('pro_monthly') };
  delete (legacy as Partial<typeof legacy>).historyDays;
  assert.equal(mergeEntitlementFeatures('pro_monthly', legacy).historyDays, 90);
  assert.equal(countryHistoryDays({ features: { tier: 3, historyDays: 365 }, validUntil: now - 1 }), 7);
  assert.equal(countryHistoryDays({ features: { tier: 3, historyDays: 365 }, validUntil: now + 60000, billingStatus: 'subscription_lapsed' }), 7);
  assert.equal(countryHistoryDays(null), 7);
});

test('reader clamps before Redis, preserves gaps and annotates formula breaks', async () => {
  Object.assign(process.env, { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'fixture-preview', UPSTASH_REDIS_REST_URL: 'https://history.test', UPSTASH_REDIS_REST_TOKEN: 'fixture' });
  __resetKeyPrefixCacheForTests();
  const commands: unknown[][][] = [];
  globalThis.fetch = (async (_url, init) => {
    const batch = JSON.parse(String(init?.body));
    commands.push(batch);
    return Response.json(batch.map((cmd: string[]) => ({ result: cmd[0] === 'ZRANGEBYSCORE' ? [JSON.stringify(row(-6, 'v10')), JSON.stringify(row(-2)), JSON.stringify(row())] : JSON.stringify({ fetchedAt: now, recordCount: 196 }) })));
  }) as typeof fetch;
  const request = new Request('https://example.test/api/intelligence/v1/get-country-history?country=US&days=365', { headers: { 'x-history-days': '365', 'x-user-id': 'spoofed' } });
  const ctx = { request, pathParams: {}, headers: {} };
  const result = await getCountryHistory(ctx, { country: 'US', days: 365 });
  assert.equal(result.allowedDays, 7);
  assert.equal(result.effectiveDays, 7);
  assert.equal(result.points.length, 3);
  assert.equal(result.points[1].ciiVersionBreak, true);
  assert.equal(commands[0][0][1], 'history:country:US');
  assert.equal(commands[0][1][1], 'seed-meta:history:country');
  assert.equal(commands[0][0][2], day - 6);
  bindCountryHistoryAccess(request, 90);
  const paid = await getCountryHistory(ctx, { country: 'US', days: 365 });
  assert.equal(paid.allowedDays, 90);
  assert.equal(commands[1][0][2], day - 89);
});

test('reader rejects invalid requests before I/O and distinguishes failed storage from valid empty history', async () => {
  const ctx = { request: new Request('https://example.test'), pathParams: {}, headers: {} };
  let reads = 0;
  globalThis.fetch = (async () => { reads++; return Response.json([{ result: [] }, { result: JSON.stringify({ fetchedAt: now, recordCount: 196 }) }]); }) as typeof fetch;
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://history.test', UPSTASH_REDIS_REST_TOKEN: 'fixture' });
  for (const req of [{ country: 'ZZ', days: 7 }, { country: 'US', days: -1 }, { country: 'US', days: 1.5 }]) await assert.rejects(getCountryHistory(ctx, req));
  assert.equal(reads, 0);
  const empty = await getCountryHistory(ctx, { country: 'US', days: 7 });
  assert.equal(empty.upstreamUnavailable, false);
  assert.deepEqual(empty.points, []);
  globalThis.fetch = (async () => { throw new Error('transport down'); }) as typeof fetch;
  assert.equal((await getCountryHistory(ctx, { country: 'US', days: 7 })).upstreamUnavailable, true);
});
