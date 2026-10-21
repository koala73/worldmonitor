// Regression test for #8424: a seed-meta key override must be a DISTINCT
// `seed-meta:*` key, never the data key it describes.
//
// `writeSeedMeta` used whatever override it was handed. scripts/seed-bls-series.mjs
// passed its own data key (`bls:series:<id>`) as the override, so every daily run
// wrote the series and then immediately overwrote it with the 44-byte
// `{fetchedAt, recordCount}` heartbeat, on the 7-day meta TTL. api/health.js
// watched the canonical key and `seed-meta:economic:bls-series`, both written
// correctly by runSeed, so the seeder read HEALTHY for six months while the RPC
// served an empty body — and a 503 storm once #8360 stopped swallowing the miss.
//
// The invariant below is structural: a colliding or un-namespaced override
// fails BEFORE any byte is written, on every path that resolves a meta key
// (plain, atomic, and runSeed extraKeys). Every override in the tree is
// `seed-meta:`-prefixed, so nothing legitimate trips it.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const {
  writeExtraKeyWithMeta,
  writeExtraKeyWithMetaAtomically,
  writeSeedMeta,
  resolveSeedMetaKey,
  runSeed,
} = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;
const originalRetryDelayMs = process.env.WM_SEED_RETRY_DELAY_MS;

/** The exact call shape that shipped in scripts/seed-bls-series.mjs:115 until #8424. */
const BLS_DATA_KEY = 'bls:series:USPRIV';
const BLS_DATA_TTL = 259_200; // 72h, the seeder's CACHE_TTL
const BLS_PAYLOAD = { series: { seriesId: 'USPRIV', observations: [{ year: '2026', period: 'M08', value: '1' }] } };

let sets;
let transactions;

beforeEach(() => {
  sets = [];
  transactions = [];
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
  globalThis.fetch = async (url, opts = {}) => {
    const command = opts?.body ? JSON.parse(opts.body) : null;
    if (String(url).endsWith('/multi-exec')) {
      transactions.push(command);
      return Response.json(command.map(() => ({ result: 'OK' })));
    }
    if (Array.isArray(command) && command[0] === 'SET') sets.push(command);
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRetryDelayMs === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
  else process.env.WM_SEED_RETRY_DELAY_MS = originalRetryDelayMs;
});

test('writeExtraKeyWithMeta: the shipped bls call shape is refused before any write', async () => {
  await assert.rejects(
    () => writeExtraKeyWithMeta(BLS_DATA_KEY, BLS_PAYLOAD, BLS_DATA_TTL, 1, BLS_DATA_KEY),
    /seed-meta/,
  );
  assert.equal(sets.length, 0, 'a colliding pair must not write the data key either — the run fails, the key stays intact');
});

test('writeExtraKeyWithMeta: an override outside the seed-meta: namespace is refused before any write', async () => {
  await assert.rejects(
    () => writeExtraKeyWithMeta(BLS_DATA_KEY, BLS_PAYLOAD, BLS_DATA_TTL, 1, 'economic:bls-series:meta'),
    /seed-meta/,
  );
  assert.equal(sets.length, 0);
});

test('writeExtraKeyWithMeta: no override derives a distinct seed-meta key and publishes the pair', async () => {
  await writeExtraKeyWithMeta(BLS_DATA_KEY, BLS_PAYLOAD, BLS_DATA_TTL, 1);

  assert.deepEqual(sets.map((c) => c[1]), [BLS_DATA_KEY, 'seed-meta:bls:series:USPRIV']);
  assert.deepEqual(JSON.parse(sets[0][2]), BLS_PAYLOAD, 'the data key holds the payload, not the heartbeat');
  assert.ok(Number.isFinite(JSON.parse(sets[1][2]).fetchedAt), 'the heartbeat lands on the meta key');
});

test('writeExtraKeyWithMeta: a namespaced override still publishes the pair', async () => {
  await writeExtraKeyWithMeta(BLS_DATA_KEY, BLS_PAYLOAD, BLS_DATA_TTL, 1, 'seed-meta:economic:bls-series:USPRIV');

  assert.deepEqual(sets.map((c) => c[1]), [BLS_DATA_KEY, 'seed-meta:economic:bls-series:USPRIV']);
  assert.deepEqual(JSON.parse(sets[0][2]), BLS_PAYLOAD);
});

test('writeExtraKeyWithMetaAtomically: a colliding override is refused and no transaction is sent', async () => {
  await assert.rejects(
    () => writeExtraKeyWithMetaAtomically({ key: BLS_DATA_KEY, data: BLS_PAYLOAD, ttlSeconds: BLS_DATA_TTL, recordCount: 1, metaKey: BLS_DATA_KEY }),
    /seed-meta/,
  );
  assert.equal(transactions.length, 0);
});

test('writeSeedMeta: a colliding override is refused', async () => {
  await assert.rejects(() => writeSeedMeta(BLS_DATA_KEY, 1, BLS_DATA_KEY), /seed-meta/);
  assert.equal(sets.length, 0);
});

test('resolveSeedMetaKey: derives when absent, accepts the namespace, rejects everything else', () => {
  assert.equal(resolveSeedMetaKey('economic:crude-inventories:v1'), 'seed-meta:economic:crude-inventories');
  assert.equal(resolveSeedMetaKey('bls:series:USPRIV', undefined), 'seed-meta:bls:series:USPRIV');
  assert.equal(resolveSeedMetaKey('bls:series:USPRIV', ''), 'seed-meta:bls:series:USPRIV');
  assert.equal(resolveSeedMetaKey('aviation:notam:closures:v2', 'seed-meta:aviation:notam'), 'seed-meta:aviation:notam');
  assert.throws(() => resolveSeedMetaKey('bls:series:USPRIV', 'bls:series:USPRIV'), /seed-meta/);
  assert.throws(() => resolveSeedMetaKey('bls:series:USPRIV', 'bls:series:meta'), /seed-meta/);
  assert.throws(() => resolveSeedMetaKey('bls:series:USPRIV', 42), /seed-meta/);
  // The only input that exercises the distinct-from-data-key clause on its own:
  // every other rejection above also fails the namespace check.
  assert.throws(() => resolveSeedMetaKey('seed-meta:economic:bls-series', 'seed-meta:economic:bls-series'), /distinct/);
});

test('runSeed: a colliding extraKeys metaKey exits 1 at config time, before the provider is called', async () => {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors = [];
  let fetchCalls = 0;
  let exitCode = null;
  process.exit = (code) => {
    const err = new Error(`__test_exit__:${code}`);
    err.exitCode = code;
    throw err;
  };
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await runSeed(
      'test',
      'meta-key-guard',
      'test:meta-key-guard:v1',
      async () => { fetchCalls += 1; return { items: [1] }; },
      { ttlSeconds: 600, extraKeys: [{ key: 'test:meta-key-guard:extra:v1', metaKey: 'test:meta-key-guard:extra:v1', transform: () => ({}) }] },
    );
  } catch (err) {
    if (!String(err.message).startsWith('__test_exit__:')) throw err;
    exitCode = err.exitCode;
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  assert.equal(exitCode, 1);
  assert.equal(fetchCalls, 0, 'the run must fail before the provider is called');
  assert.equal(sets.length, 0, 'nothing is written');
  assert.match(errors.join('\n'), /CONTRACT VIOLATION.*seed-meta/);
});
