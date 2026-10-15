import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { runSeed } from '../scripts/_seed-utils.mjs';
import { seedOptions } from '../scripts/seed-displacement-summary.mjs';
import { getDisplacementSummary } from '../server/worldmonitor/displacement/v1/get-displacement-summary.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalNow = Date.now;
const originalEnv = { ...process.env };
const originalListeners = new Set(process.rawListeners('SIGTERM'));
const year = new Date().getUTCFullYear();
const key = `displacement:summary:v1:${year}`;
const metaKey = 'seed-meta:displacement:summary';
const publishedAt = Date.parse(`${year}-10-06T01:00:00Z`);
let now: number;
let failMetadata: boolean;
let redis: ReturnType<typeof installRedis>;

function payload(refugees: number, countries = 100) {
  return { summary: {
    year: year - 1,
    globalTotals: { refugees, asylumSeekers: 7, idps: 90, stateless: 8, total: refugees + 105 },
    countries: Array.from({ length: countries }, (_, index) => ({ code: index === 0 ? 'SYR' : `X${index}`, name: `Fixture ${index}`, refugees: index === 0 ? refugees : 0, asylumSeekers: index === 0 ? 7 : 0, idps: 0, stateless: 0, totalDisplaced: 0, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0 })),
    topFlows: [],
  } };
}

beforeEach(() => {
  now = publishedAt;
  failMetadata = false;
  Date.now = () => now;
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
  for (const name of ['LOCAL_API_MODE', 'BUNDLE_COMPLETION_META_KEY', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA']) delete process.env[name];
  redis = installRedis({}, { now: () => now });
  globalThis.fetch = (async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'redis.example', 'No real service calls are allowed');
    const command = init?.body ? JSON.parse(String(init.body)) : null;
    if (Array.isArray(command) && command[0] === 'SET' && command[1] === metaKey) {
      if (failMetadata) return Response.json({ error: 'controlled metadata refusal' }, { status: 400 });
    }
    const response = await redis.fetchImpl(input, init);
    if (Array.isArray(command) && command[0] === 'SET' && command[1] === key) now += 250;
    return response;
  }) as typeof fetch;
  process.exit = ((code: number) => { throw Object.assign(new Error('controlled seed exit'), { exitCode: code }); }) as never;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  Date.now = originalNow;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  for (const listener of process.rawListeners('SIGTERM')) if (!originalListeners.has(listener)) process.removeListener('SIGTERM', listener);
});

async function publish(fetcher: () => Promise<unknown>) {
  try { await runSeed('displacement', 'summary', key, fetcher, seedOptions); }
  catch (error) {
    if ((error as Error).message !== 'controlled seed exit') throw error;
    return (error as Error & { exitCode: number }).exitCode;
  }
  assert.fail('Expected real seeder termination');
}

async function read() {
  return getDisplacementSummary({} as never, { year: 0, countryLimit: 0, flowLimit: 0 });
}

test('successful, fetch-failed, validation-failed and recovered attempts keep the original cohort clock', async () => {
  assert.equal(await publish(async () => payload(120)), 0);
  const canonical = redis.redis.get(key)!;
  const metadata = redis.redis.get(metaKey)!;
  const initial = await read();
  assert.equal(initial.fetchedAt, JSON.parse(canonical)._seed.fetchedAt);
  assert.equal(initial.summary?.year, year - 1);
  now = publishedAt + 3600000;
  assert.notEqual(await publish(async () => { throw new Error('controlled provider failure'); }), 0);
  assert.equal(redis.redis.get(key), canonical);
  assert.equal(redis.redis.get(metaKey), metadata);
  assert.equal(redis.expires.get(key), 86400);
  assert.deepEqual(await read(), initial);
  now = publishedAt + 7200000;
  assert.equal(await publish(async () => payload(999, 1)), 1);
  assert.equal(redis.redis.get(key), canonical);
  assert.equal(redis.redis.get(metaKey), metadata);
  assert.deepEqual(await read(), initial);
  now = publishedAt + 10800000;
  assert.equal(await publish(async () => payload(200)), 0);
  const recovered = await read();
  assert.equal(recovered.fetchedAt, JSON.parse(redis.redis.get(key)!)._seed.fetchedAt);
  assert.equal(recovered.fetchedAt, publishedAt + 10800000);
  assert.equal(recovered.summary?.countries[0]?.refugees, 200);
  assert.equal(recovered.dataAvailable, true);
});

test('a failed metadata write cannot attach the prior cohort clock to newly published country data', async () => {
  assert.equal(await publish(async () => payload(120)), 0);
  const oldMetadata = redis.redis.get(metaKey)!;
  now = publishedAt + 3600000;
  failMetadata = true;
  assert.equal(await publish(async () => payload(200)), 0);
  assert.equal(redis.redis.get(metaKey), oldMetadata);
  const currentEnvelope = JSON.parse(redis.redis.get(key)!);
  const result = await read();
  assert.equal(result.summary?.countries[0]?.refugees, 200);
  assert.equal(result.fetchedAt, currentEnvelope._seed.fetchedAt);
  assert.notEqual(result.fetchedAt, JSON.parse(oldMetadata).fetchedAt);
});

test('missing and expired data remains unavailable instead of inventing a source clock', async () => {
  const missing = await read();
  assert.equal(missing.dataAvailable, false);
  assert.equal(missing.fetchedAt, 0);
  assert.equal(await publish(async () => payload(120)), 0);
  now = publishedAt + 86400000;
  const expired = await read();
  assert.equal(expired.dataAvailable, false);
  assert.equal(expired.fetchedAt, 0);
  assert.deepEqual(expired.summary?.countries, []);
});
