// Tests for scripts/seed-gie-gas-storage.mjs (EU AGSI+ aggregate).
//
// Regression target: the previously-stringified `seededAt` (e.g.
// "1715990400000") was unparseable by Date.parse(), and the payload's
// `updatedAt` field carries the GIE *data date* — not the fetch time. The
// regional-snapshot freshness classifier
// (scripts/regional-snapshot/freshness.mjs::extractTimestamp) therefore
// resolved the timestamp to the data date, which lags 24–72h every weekend
// when GIE doesn't publish. Under #3728's tighter freshness gate that
// flipped the input to STALE even on the same minute as a successful seed
// run. The fix emits a numeric `fetchedAt` (canonical first-priority field)
// and an ISO `seededAt` so the classifier resolves real fetch time.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildEuGasStoragePayload, declareRecords } from '../scripts/seed-gie-gas-storage.mjs';
import { classifyInputs } from '../scripts/regional-snapshot/freshness.mjs';
import { runSeed } from '../scripts/_seed-utils.mjs';

function makeEntries(today = '2024-05-20', yesterday = '2024-05-19') {
  return [
    { gasDayStart: today, full: '62.4', gasInStorage: '720.5' },
    { gasDayStart: yesterday, full: '61.9', gasInStorage: '714.0' },
  ];
}

describe('buildEuGasStoragePayload — freshness fields (#3728 latent bug)', () => {
  it('emits seededAt as a Date.parse()-able ISO string close to now', () => {
    const before = Date.now();
    const payload = buildEuGasStoragePayload(makeEntries());
    const after = Date.now();

    assert.equal(typeof payload.seededAt, 'string',
      'seededAt must be a string (ISO), not a stringified epoch');
    const parsed = Date.parse(payload.seededAt);
    assert.ok(Number.isFinite(parsed),
      `Date.parse(seededAt=${payload.seededAt}) must be finite — the legacy ` +
      'String(Date.now()) shape returns NaN here');
    // Within 5s of the wall clock at construction time — proves it is real
    // fetch time, not the GIE data date.
    assert.ok(parsed >= before - 5_000 && parsed <= after + 5_000,
      `seededAt (${parsed}) must be within 5s of now (${before}..${after})`);
  });

  it('emits fetchedAt as numeric epoch ms close to now', () => {
    // fetchedAt is the field extractTimestamp checks FIRST. Without it on
    // the payload, the classifier would fall to updatedAt (the data date),
    // which lags by 24–72h every weekend.
    const before = Date.now();
    const payload = buildEuGasStoragePayload(makeEntries());
    const after = Date.now();

    assert.equal(typeof payload.fetchedAt, 'number');
    assert.ok(Number.isFinite(payload.fetchedAt));
    assert.ok(payload.fetchedAt >= before && payload.fetchedAt <= after,
      `fetchedAt (${payload.fetchedAt}) must be within the build window ` +
      `(${before}..${after})`);
  });

  it('classifies as fresh through the regional-snapshot classifier even on a stale data date', () => {
    // End-to-end proof: take the actual production classifier and feed it
    // the payload. The 5-day-old `updatedAt` ("2024-05-20" vs. today)
    // would otherwise dominate and produce STALE for this key (maxAgeMin
    // = 2880 = 48h).
    const payload = buildEuGasStoragePayload(makeEntries('2024-05-20', '2024-05-19'));
    const { fresh, stale, missing } = classifyInputs({
      'economic:eu-gas-storage:v1': payload,
    });
    assert.ok(fresh.includes('economic:eu-gas-storage:v1'),
      `payload must classify FRESH; got fresh=${JSON.stringify(fresh)} ` +
      `stale=${JSON.stringify(stale)} missing=${JSON.stringify(missing)}`);
    assert.ok(!stale.includes('economic:eu-gas-storage:v1'));
  });
});

describe('buildEuGasStoragePayload — shape and derivations', () => {
  it('throws when entries is empty', () => {
    assert.throws(() => buildEuGasStoragePayload([]), /empty data array/);
  });

  it('throws when entries is not an array', () => {
    assert.throws(() => buildEuGasStoragePayload(null), /empty data array/);
  });

  it('throws on out-of-range fillPct', () => {
    assert.throws(
      () => buildEuGasStoragePayload([{ gasDayStart: '2024-05-20', full: '120' }]),
      /invalid fillPct/,
    );
    assert.throws(
      () => buildEuGasStoragePayload([{ gasDayStart: '2024-05-20', full: '0' }]),
      /invalid fillPct/,
    );
  });

  it('sorts entries by gasDayStart descending and picks the most recent', () => {
    const out = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-18', full: '60.0', gasInStorage: '700' },
      { gasDayStart: '2024-05-20', full: '62.5', gasInStorage: '720' },
      { gasDayStart: '2024-05-19', full: '61.0', gasInStorage: '710' },
    ]);
    assert.equal(out.updatedAt, '2024-05-20');
    assert.equal(out.fillPct, 62.5);
    assert.equal(out.history[0].date, '2024-05-20');
  });

  it('derives trend from 1d change', () => {
    const inj = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-20', full: '62.5' },
      { gasDayStart: '2024-05-19', full: '62.0' },
    ]);
    assert.equal(inj.trend, 'injecting');

    const wd = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-20', full: '60.0' },
      { gasDayStart: '2024-05-19', full: '62.0' },
    ]);
    assert.equal(wd.trend, 'withdrawing');

    const stable = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-20', full: '62.0' },
      { gasDayStart: '2024-05-19', full: '62.0' },
    ]);
    assert.equal(stable.trend, 'stable');
  });

  it('does not mutate the caller-provided entries array', () => {
    const entries = [
      { gasDayStart: '2024-05-18', full: '60' },
      { gasDayStart: '2024-05-20', full: '62' },
    ];
    const snapshot = entries.map((e) => ({ ...e }));
    buildEuGasStoragePayload(entries);
    assert.deepEqual(entries, snapshot,
      'buildEuGasStoragePayload must not sort the caller array in place');
  });
});

// PR #3788 review round 2: seeder-boundary test.
//
// The pure-builder tests above prove buildEuGasStoragePayload itself emits
// fetchedAt + seededAt. But the production publish path goes through
// runSeed → atomicPublish → Redis SET. A future refactor that wraps the
// fetcher output (e.g. publishTransform, post-fetch normalizer) could strip
// fetchedAt before publish, leaving the pure tests green while production
// silently regresses to STALE — the exact gap that produced #3728.
//
// This test exercises the full runSeed publish path with the same options
// the production seeder uses, mocks Upstash via globalThis.fetch, and
// asserts the bytes actually written to Redis carry both freshness fields
// on the canonical key AND on the seed-meta key.
describe('runSeed boundary — publish-path freshness fields (#3788 review round 2)', () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_EXIT = process.exit;
  const ORIGINAL_ENV = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  /** @type {Array<{url:string, method:string, body:unknown}>} */
  let recordedCalls;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    recordedCalls = [];

    globalThis.fetch = async (url, opts = {}) => {
      const body = opts?.body
        ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })()
        : null;
      recordedCalls.push({ url: String(url), method: opts?.method || 'GET', body });
      // Pipeline (array-of-arrays) → array of {result}. Used by extendExistingTtl
      // and any other batched ops.
      if (Array.isArray(body) && Array.isArray(body[0])) {
        return new Response(JSON.stringify(body.map(() => ({ result: 0 }))), { status: 200 });
      }
      // Default: SET / EVAL / DEL → {result:'OK'}.
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };

    // runSeed exits 0 on the success path; convert to a throw so the test
    // can resume and inspect recordedCalls.
    process.exit = (code) => {
      const e = new Error(`__test_exit__:${code}`);
      // @ts-expect-error attaching exitCode for diagnostics
      e.exitCode = code;
      throw e;
    };
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.exit = ORIGINAL_EXIT;
    if (ORIGINAL_ENV.UPSTASH_REDIS_REST_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL;
    if (ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN;
  });

  async function runWithExitTrap(fn) {
    try {
      await fn();
    } catch (err) {
      if (!String(err.message).startsWith('__test_exit__:')) throw err;
    }
  }

  /** Find the last `SET <key> <payload> ...` call body for a given key. */
  function lastSetBodyFor(key) {
    const matches = recordedCalls.filter(c =>
      Array.isArray(c.body) && c.body[0] === 'SET' && c.body[1] === key,
    );
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    try { return JSON.parse(last.body[2]); } catch { return null; }
  }

  it('writes fetchedAt + seededAt on the canonical key payload (data inside envelope)', async () => {
    const before = Date.now();
    await runWithExitTrap(() =>
      runSeed(
        'economic',
        'eu-gas-storage',
        'economic:eu-gas-storage:v1',
        // Substitute the real GIE network fetch with the actual pure builder
        // output — same shape production publishes. If a future change wraps
        // this output and drops fetchedAt before atomicPublish, the
        // assertions below fire even though the pure-builder tests stay green.
        async () => buildEuGasStoragePayload([
          { gasDayStart: '2024-05-20', full: '62.4', gasInStorage: '720.5' },
          { gasDayStart: '2024-05-19', full: '61.9', gasInStorage: '714.0' },
        ]),
        {
          validateFn: (d) => typeof d?.fillPct === 'number' && d.fillPct > 0 && d.fillPct <= 100,
          ttlSeconds: 259200,
          sourceVersion: 'gie-agsi-plus',
          declareRecords,
          schemaVersion: 1,
          maxStaleMin: 2880,
        },
      ),
    );
    const after = Date.now();

    const canonical = lastSetBodyFor('economic:eu-gas-storage:v1');
    assert.ok(canonical, 'expected a SET on economic:eu-gas-storage:v1 — runSeed did not reach publish');

    // Contract mode wraps the payload: {_seed, data}. The freshness fields
    // we care about live on the INNER `data` because that is what survives
    // unwrapEnvelope at read time and what regional-snapshot/freshness.mjs
    // classifies when the registry has no metaKey.
    assert.ok(canonical._seed && canonical.data,
      'canonical payload must be the contract envelope {_seed, data}');

    const data = canonical.data;
    assert.equal(typeof data.fetchedAt, 'number',
      'payload.fetchedAt must be a numeric epoch — extractTimestamp checks it FIRST');
    assert.ok(Number.isFinite(data.fetchedAt));
    assert.ok(data.fetchedAt >= before && data.fetchedAt <= after,
      `payload.fetchedAt (${data.fetchedAt}) must be within the run window (${before}..${after})`);

    assert.equal(typeof data.seededAt, 'string',
      'payload.seededAt must be an ISO string, not a stringified epoch (the legacy #3728 bug)');
    const parsedSeededAt = Date.parse(data.seededAt);
    assert.ok(Number.isFinite(parsedSeededAt),
      `Date.parse(payload.seededAt=${data.seededAt}) must be finite`);
  });

  it('writes numeric fetchedAt on seed-meta:economic:eu-gas-storage', async () => {
    const before = Date.now();
    await runWithExitTrap(() =>
      runSeed(
        'economic',
        'eu-gas-storage',
        'economic:eu-gas-storage:v1',
        async () => buildEuGasStoragePayload([
          { gasDayStart: '2024-05-20', full: '62.4', gasInStorage: '720.5' },
          { gasDayStart: '2024-05-19', full: '61.9', gasInStorage: '714.0' },
        ]),
        {
          validateFn: (d) => typeof d?.fillPct === 'number' && d.fillPct > 0 && d.fillPct <= 100,
          ttlSeconds: 259200,
          sourceVersion: 'gie-agsi-plus',
          declareRecords,
          schemaVersion: 1,
          maxStaleMin: 2880,
        },
      ),
    );
    const after = Date.now();

    // freshness.mjs now references this metaKey (defense-in-depth); confirm
    // the seeder actually writes it with a real numeric fetchedAt.
    const meta = lastSetBodyFor('seed-meta:economic:eu-gas-storage');
    assert.ok(meta, 'expected runSeed to write seed-meta:economic:eu-gas-storage');
    assert.equal(typeof meta.fetchedAt, 'number',
      'seed-meta.fetchedAt must be a numeric epoch — classifyInputs() reads it directly');
    assert.ok(meta.fetchedAt >= before && meta.fetchedAt <= after,
      `seed-meta.fetchedAt (${meta.fetchedAt}) must be within the run window (${before}..${after})`);
    assert.equal(meta.recordCount, 1,
      'declareRecords returns 1 for any valid payload; seed-meta must mirror it');
  });
});
