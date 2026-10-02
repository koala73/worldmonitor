import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { getMarketBreadthHistory } from '../server/worldmonitor/market/v1/get-market-breadth-history';
import { readPublishedPctAbove200d } from '../scripts/_sp500-breadth.mjs';
import { stripSeedEnvelope } from '../scripts/_seed-envelope-source.mjs';
import { __testing__ } from '../api/health.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KEY = 'market:breadth-history:v1';
const META = 'seed-meta:market:breadth-history';
const prior = {
  [KEY]: { _seed: { fetchedAt: Date.parse('2026-09-02T02:00:00Z'), recordCount: 1, state: 'OK', sourceVersion: 'market-breadth-v1', schemaVersion: 1 },
    data: { updatedAt: '2026-09-02T02:00:00Z', current: { pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: 80 },
      history: [{ date: '2026-09-01', pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: 80 }] } },
  [META]: { fetchedAt: Date.parse('2026-09-02T02:00:00Z'), recordCount: 1, sourceVersion: 'market-breadth-v1' },
};

function runSeed(now: string, fixtures: Record<string, unknown> = prior, failure = '') {
  const code = `
    import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
    const realDate = Date;
    globalThis.Date = class extends realDate {
      constructor(...args) { super(...(args.length ? args : [${JSON.stringify(now)}])); }
      static now() { return realDate.parse(${JSON.stringify(now)}); }
    };
    const fake = installRedis(${JSON.stringify(fixtures)});
    let scans = 0;
    globalThis.fetch = async (url, init) => {
      if (${JSON.stringify(failure)} === 'redis' && String(url).endsWith('/get/' + encodeURIComponent(${JSON.stringify(KEY)}))) return new Response('', { status: 503 });
      if (String(url) !== 'https://scanner.tradingview.com/america/scan') return fake.fetchImpl(url, init);
      scans++;
      if (${JSON.stringify(failure)} === 'http' || (${JSON.stringify(failure)} === 'transient' && scans === 1)) return new Response('', { status: 503 });
      const data = Array.from({ length: 503 }, (_, i) => ({ s: 'NYSE:T' + i, d: ['T' + i, 100, 90, 110, ${JSON.stringify(failure)} === 'partial' ? null : 90, realDate.parse('2026-09-04T13:30:00Z') / 1000] }));
      return Response.json({ totalCount: 503, data });
    };
    process.on('exit', () => console.log('RESULT ' + JSON.stringify({ scans, redis: Object.fromEntries([...fake.redis].map(([k,v]) => [k, JSON.parse(v)]).filter(([k]) => !k.includes(':staging:'))), expires: Object.fromEntries(fake.expires) })));
    await import('./scripts/seed-market-breadth.mjs');
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000,
    env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child-v8', WM_SEED_RETRY_DELAY_MS: '0' },
  });
  assert.ifError(child.error);
  const line = child.stdout.split('\n').find((line) => line.startsWith('RESULT '));
  assert.ok(line, `${child.stdout}\n${child.stderr}`);
  return { ...JSON.parse(line.slice(7)), status: child.status, output: child.stdout + child.stderr };
}

function health(fixtures: Record<string, unknown>, now: string) {
  return __testing__.classifyKey('breadthHistory', KEY, { allowOnDemand: false }, {
    keyStrens: new Map([[KEY, JSON.stringify(fixtures[KEY]).length]]), keyErrors: new Map(),
    keyMetaValues: new Map([[META, JSON.stringify(fixtures[META])]]), keyMetaErrors: new Map(), now: Date.parse(now),
  });
}

test('recovers a missed Friday close on Sunday through the real producer and readers without inventing sessions', async () => {
  assert.equal(health(prior, '2026-09-06T03:00:00Z').status, 'STALE_SEED');
  const first = runSeed('2026-09-06T08:00:00Z');
  assert.equal(first.status, 0, first.output);
  assert.equal(first.scans, 1);
  assert.deepEqual(first.redis[KEY].data.history.map((r: { date: string }) => r.date), ['2026-09-01', '2026-09-04']);
  assert.equal(first.redis[KEY]._seed.newestItemAt, Date.parse('2026-09-04T13:30:00Z'));
  assert.equal(first.redis[META].maxContentAgeMin, 7200);
  assert.equal(health(first.redis, '2026-09-06T08:00:00Z').status, 'OK');
  const second = runSeed('2026-09-07T08:00:00Z', first.redis);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.redis[KEY].data.history, first.redis[KEY].data.history);
  assert.equal(second.redis[KEY]._seed.newestItemAt, first.redis[KEY]._seed.newestItemAt);
  // 42.5h of a 120h budget: still below the 80% pre-warning threshold.
  assert.equal(health(second.redis, '2026-09-06T08:00:00Z').status, 'OK');
  // 108.5h = 90% of budget: visible pre-warning, not yet stale.
  assert.equal(health(second.redis, '2026-09-09T02:00:00Z').status, 'CONTENT_AGE_PREWARNING');
  assert.equal(health(second.redis, '2026-09-09T14:00:00Z').status, 'STALE_CONTENT');
  const fetchBefore = globalThis.fetch;
  try {
    installRedis(second.redis);
    const rpc = await getMarketBreadthHistory({} as never, {});
    assert.equal(rpc.unavailable, false);
    assert.deepEqual(rpc.history, second.redis[KEY].data.history);
    assert.equal(rpc.currentPctAbove200d, 100);
    const bootstrap = stripSeedEnvelope(second.redis[KEY]);
    assert.deepEqual(bootstrap.history, rpc.history);
    assert.equal(await readPublishedPctAbove200d({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }), rpc.currentPctAbove200d);
  } finally { globalThis.fetch = fetchBefore; }
});

for (const [failure, attempts] of [['http', 4], ['partial', 1], ['redis', 4]] as const) {
  test(`${failure} scan preserves last-good and success metadata with ${attempts} bounded attempt(s)`, () => {
    const result = runSeed('2026-09-06T08:00:00Z', prior, failure);
    assert.equal(result.status, 75, result.output);
    assert.equal(result.scans, attempts);
    assert.deepEqual(result.redis[KEY], prior[KEY]);
    assert.deepEqual(result.redis[META], prior[META]);
    assert.equal(result.expires[KEY], 2592000);
    assert.equal(health(result.redis, '2026-09-06T08:00:00Z').status, 'STALE_SEED');
  });
}

test('a restart after canonical publication but before metadata converges to one session row', () => {
  const first = runSeed('2026-09-06T08:00:00Z');
  const interrupted = { ...first.redis, [META]: prior[META] };
  const next = runSeed('2026-09-07T02:00:00Z', interrupted);
  assert.equal(next.status, 0, next.output);
  assert.deepEqual(next.redis[KEY].data.history, first.redis[KEY].data.history);
  assert.equal(next.redis[META].recordCount, 2);
  assert.equal(next.redis[META].fetchedAt, Date.parse('2026-09-07T02:00:00Z'));
});

test('a transient scan failure recovers in the same run without duplicate rows', () => {
  const result = runSeed('2026-09-06T08:00:00Z', prior, 'transient');
  assert.equal(result.status, 0, result.output);
  assert.equal(result.scans, 2);
  assert.equal(result.redis[KEY].data.history.length, 2);
});

test('a brief failed refresh remains healthy until the real source or seed budget expires', () => {
  const fresh = runSeed('2026-09-06T08:00:00Z');
  const result = runSeed('2026-09-07T02:00:00Z', fresh.redis, 'partial');
  assert.equal(result.status, 75, result.output);
  assert.deepEqual(result.redis[KEY], fresh.redis[KEY]);
  assert.deepEqual(result.redis[META], fresh.redis[META]);
  assert.equal(health(result.redis, '2026-09-07T02:00:00Z').status, 'OK');
});

test('an unchanged old source cannot keep re-anchoring success metadata', () => {
  const fresh = runSeed('2026-09-07T08:00:00Z');
  const result = runSeed('2026-09-10T02:00:00Z', fresh.redis);
  assert.equal(result.status, 75, result.output);
  assert.deepEqual(result.redis[KEY], fresh.redis[KEY]);
  assert.deepEqual(result.redis[META], fresh.redis[META]);
  assert.equal(health(result.redis, '2026-09-10T02:00:00Z').status, 'STALE_CONTENT');
});

test('the desired cron retries after a missed run or Saturday repair within 18 hours', () => {
  const registry = JSON.parse(readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
  const entries = Array.isArray(registry) ? registry : registry.services;
  const service = entries.find((s: { service: string }) => s.service === 'seed-market-breadth');
  assert.equal(service.cronSchedule, '0 2,8 * * *');
  const hours = service.cronSchedule.split(' ')[1].split(',').map(Number);
  const ticks: number[] = [];
  for (let day = 5; day <= 9; day++) for (const hour of hours) ticks.push(Date.parse(`2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`));
  for (const trigger of [Date.parse('2026-09-05T02:00:00Z'), Date.parse('2026-09-05T15:40:00Z')]) {
    assert.ok(ticks.find((time) => time > trigger)! - trigger <= 18 * 3600_000);
  }
});
