// GHSA-gxj5-54wh-7vgr. The record-baseline-snapshot RPC writes shared,
// 90-day statistical state and is reachable with a freely-mintable anonymous
// session token. These tests pin the guards that stand between a caller and
// that state: what reaches a Redis key, what counts as a usable observation,
// and how often one baseline can be sampled.
//
// Redis is a fetch stub rather than a mock module, because both the write
// helpers (server/_shared/redis.ts) and mgetJson speak the Upstash REST
// protocol over global fetch. Driving that seam exercises the real command
// sequence the handler issues, including the SET NX claim.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { recordBaselineSnapshot } from '../server/worldmonitor/infrastructure/v1/record-baseline-snapshot.ts';

const ctx = {} as never;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** In-memory Upstash stand-in. Records every command so tests can assert the sequence. */
function installFakeRedis() {
  const store = new Map<string, string>();
  const commands: string[][] = [];

  globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    const command = JSON.parse(init.body ?? '[]') as string[];
    commands.push(command);
    const [op] = command;

    if (op === 'MGET') {
      return jsonResponse({ result: command.slice(1).map(key => store.get(key) ?? null) });
    }
    if (op === 'SET') {
      const [, key, value] = command;
      if (command.includes('NX') && store.has(key!)) return jsonResponse({ result: null });
      store.set(key!, value!);
      return jsonResponse({ result: 'OK' });
    }
    return jsonResponse({ result: null });
  }) as typeof globalThis.fetch;

  return {
    store,
    commands,
    keysWritten: () => commands.filter(c => c[0] === 'SET').map(c => c[1]!),
    baselineKeys: () => commands
      .filter(c => c[0] === 'SET' && !c[1]!.endsWith(':sample'))
      .map(c => c[1]!),
  };
}

const validUpdate = (over: Record<string, unknown> = {}) => ({
  type: 'military_flights',
  region: 'global',
  count: 42,
  ...over,
});

describe('recordBaselineSnapshot — write guards (GHSA-gxj5-54wh-7vgr)', () => {
  let redis: ReturnType<typeof installFakeRedis>;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    redis = installFakeRedis();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => { if (!(k in originalEnv)) delete process.env[k]; });
    Object.assign(process.env, originalEnv);
  });

  it('accepts a well-formed observation and records one sample', async () => {
    const res = await recordBaselineSnapshot(ctx, { updates: [validUpdate()] } as never);
    assert.equal(res.updated, 1);
    assert.equal(res.error, '');

    const written = redis.baselineKeys();
    assert.equal(written.length, 1);
    assert.match(written[0]!, /^baseline:v1:military_flights:global:\d:\d+$/);
  });

  it('rejects an unrecognised region before it can become a Redis key', async () => {
    // region was interpolated straight into a key with a 90-day TTL, so an open
    // value set let one caller mint arbitrary long-lived keys.
    const res = await recordBaselineSnapshot(ctx, {
      updates: [validUpdate({ region: 'attacker-chosen-region' })],
    } as never);

    assert.equal(res.updated, 0);
    assert.equal(res.error, 'No valid updates');
    assert.deepEqual(redis.commands, [], 'an invalid region must not reach Redis at all');
  });

  it('rejects a non-finite count', async () => {
    // JSON.parse('{"count":1e999}') yields Infinity, which is typeof 'number'
    // and not NaN, so the previous check passed it through. One infinite sample
    // permanently poisons the Welford mean and variance, and the resulting NaN
    // serialises to null.
    for (const count of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const res = await recordBaselineSnapshot(ctx, { updates: [validUpdate({ count })] } as never);
      assert.equal(res.updated, 0, `count ${count} must be rejected`);
    }
    assert.deepEqual(redis.commands, [], 'a non-finite count must not reach Redis');
  });

  it('rejects a negative or implausibly large count', async () => {
    for (const count of [-1, -1000, 1_000_001]) {
      const res = await recordBaselineSnapshot(ctx, { updates: [validUpdate({ count })] } as never);
      assert.equal(res.updated, 0, `count ${count} must be rejected`);
    }
    assert.deepEqual(redis.commands, [], 'an out-of-range count must not reach Redis');
  });

  it('rejects an unknown metric type', async () => {
    const res = await recordBaselineSnapshot(ctx, {
      updates: [validUpdate({ type: 'not_a_metric' })],
    } as never);
    assert.equal(res.updated, 0);
    assert.deepEqual(redis.commands, []);
  });

  it('samples a baseline at most once per interval', async () => {
    // Every page load used to add another observation, so the statistics
    // tracked visitor volume and a single caller could drive the mean by
    // repeating one request. The interval claim caps everyone at one sample.
    const first = await recordBaselineSnapshot(ctx, { updates: [validUpdate()] } as never);
    assert.equal(first.updated, 1);

    for (let i = 0; i < 25; i++) {
      const repeat = await recordBaselineSnapshot(ctx, { updates: [validUpdate({ count: 999 })] } as never);
      assert.equal(repeat.updated, 0, 'a repeat inside the interval must not add a sample');
    }

    assert.equal(redis.baselineKeys().length, 1, 'exactly one baseline write for the interval');
  });

  it('keeps the sample count exact when callers race', async () => {
    // The old path issued MGET, computed Welford in the edge function, then
    // fired independent SETs with no lock, so simultaneous callers read the
    // same prior value and overwrote one another. The claim makes one caller
    // the sole writer.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        recordBaselineSnapshot(ctx, { updates: [validUpdate()] } as never)),
    );

    const applied = results.reduce((total, r) => total + r.updated, 0);
    assert.equal(applied, 1, 'ten concurrent reports must yield exactly one sample');

    const stored = JSON.parse(redis.store.get(redis.baselineKeys()[0]!)!) as { sampleCount: number };
    assert.equal(stored.sampleCount, 1, 'no lost update and no double count');
  });

  it('drops invalid entries but still applies the valid ones in the same batch', async () => {
    const res = await recordBaselineSnapshot(ctx, {
      updates: [
        validUpdate({ region: 'bogus' }),
        validUpdate({ type: 'vessels' }),
        validUpdate({ count: Number.POSITIVE_INFINITY }),
      ],
    } as never);

    assert.equal(res.updated, 1, 'the one usable observation still lands');
    const written = redis.baselineKeys();
    assert.equal(written.length, 1);
    assert.match(written[0]!, /^baseline:v1:vessels:global:/);
  });
});
