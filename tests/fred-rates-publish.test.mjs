import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

import {
  CANONICAL_KEY,
  publishFredCohortAtomically,
  runFredRatesSeed,
} from '../scripts/seed-fred-rates.mjs';
import {
  FRED_SEED_SERIES,
  FRED_KEY_PREFIX,
  FRED_TTL,
  STRESS_INDEX_KEY,
  STRESS_INDEX_TTL,
} from '../scripts/_fred-seeder.mjs';
import { upstashCommand } from '../scripts/_upstash-rest.mjs';
import { GRACEFUL_FETCH_FAILURE_EXIT_CODE, runSeed, writeSeedMeta } from '../scripts/_seed-utils.mjs';

const originalFetch = globalThis.fetch;
const originalRetryDelay = process.env.WM_SEED_RETRY_DELAY_MS;

beforeEach(() => {
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRetryDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
  else process.env.WM_SEED_RETRY_DELAY_MS = originalRetryDelay;
});

function makeSeriesMap(count) {
  return Object.fromEntries(
    FRED_SEED_SERIES.slice(0, count).map((seriesId, index) => [seriesId, {
      seriesId,
      observations: [{ date: '2031-01-01', value: index + 1 }],
    }]),
  );
}

const SEED_META_TTL = 7 * 24 * 60 * 60;
const MIN_SERIES_COUNT = Math.ceil(FRED_SEED_SERIES.length * 0.75);

function companionMetaKey(key) {
  return `seed-meta:${key.replace(/:v\d+$/, '')}`;
}

function msetEntries(command) {
  assert.equal(command?.[0], 'MSET');
  return new Map(Array.from({ length: (command.length - 1) / 2 }, (_, index) => [
    command[index * 2 + 1],
    command[index * 2 + 2],
  ]));
}

function expectedFredSidePreservationTargets() {
  return [
    { key: 'seed-meta:economic:fred-rates', ttlSeconds: SEED_META_TTL },
    ...FRED_SEED_SERIES.flatMap((seriesId) => {
      const key = `${FRED_KEY_PREFIX}:${seriesId}:0`;
      return [
        { key, ttlSeconds: FRED_TTL },
        { key: companionMetaKey(key), ttlSeconds: SEED_META_TTL },
      ];
    }),
    { key: STRESS_INDEX_KEY, ttlSeconds: STRESS_INDEX_TTL },
    { key: companionMetaKey(STRESS_INDEX_KEY), ttlSeconds: SEED_META_TTL },
  ];
}

async function captureFredSeedOptions() {
  let captured;
  await runFredRatesSeed({
    runSeedImpl: async (...args) => {
      captured = args;
    },
  });
  return {
    domain: captured[0],
    resource: captured[1],
    canonicalKey: captured[2],
    options: captured[4],
  };
}

function clone(value) {
  return structuredClone(value);
}

async function trapSeedExit(fn) {
  const originalExit = process.exit;
  const originalListeners = new Set(process.rawListeners('SIGTERM'));
  process.exit = (code) => {
    const error = new Error(`__fred_seed_exit__:${code}`);
    error.exitCode = code;
    throw error;
  };
  try {
    await fn();
    return null;
  } catch (error) {
    if (!String(error.message).startsWith('__fred_seed_exit__:')) throw error;
    return error.exitCode;
  } finally {
    process.exit = originalExit;
    for (const listener of process.rawListeners('SIGTERM')) {
      if (!originalListeners.has(listener)) process.removeListener('SIGTERM', listener);
    }
  }
}

function installExpiryAwareRedis(clock, entries, pipelines) {
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (String(url).endsWith('/pipeline')) {
      const result = body.map((command) => {
        const [, key, ttlSeconds] = command;
        const entry = entries.get(key);
        if (!entry || entry.expiresAt <= clock.now) {
          entries.delete(key);
          return { result: 0 };
        }
        entry.expiresAt = clock.now + Number(ttlSeconds) * 1000;
        return { result: 1 };
      });
      pipelines.push({ at: clock.now, commands: clone(body) });
      return Response.json(result);
    }
    return Response.json({ result: 'OK' });
  };
}

function primeFredConsumerCohort(clock) {
  const entries = new Map();
  const put = (key, value, ttlSeconds) => entries.set(key, {
    value: clone(value),
    expiresAt: clock.now + ttlSeconds * 1000,
  });
  put(CANONICAL_KEY, { seeded: 'batch' }, FRED_TTL);
  put('seed-meta:economic:fred-rates', { fetchedAt: 1, recordCount: 24 }, SEED_META_TTL);
  for (const seriesId of FRED_SEED_SERIES) {
    const key = `${FRED_KEY_PREFIX}:${seriesId}:0`;
    put(key, { series: { seriesId, observations: [{ date: '2031-01-01', value: 1 }] } }, FRED_TTL);
    put(companionMetaKey(key), { fetchedAt: 1, recordCount: 1 }, SEED_META_TTL);
  }
  put(STRESS_INDEX_KEY, { seededAt: '2031-01-01T00:00:00.000Z', components: [] }, STRESS_INDEX_TTL);
  put(companionMetaKey(STRESS_INDEX_KEY), { fetchedAt: 1, recordCount: 0 }, SEED_META_TTL);
  return entries;
}

function assertCohortContentAndTtl(entries, before, clock) {
  for (const [key, value] of before) {
    assert.deepEqual(entries.get(key)?.value, value, `${key} content must not be rewritten by retention`);
    assert.ok(entries.get(key)?.expiresAt > clock.now, `${key} must survive failed refreshes`);
  }
}

function makeFredBatch(count) {
  const seriesById = makeSeriesMap(count);
  const seriesIds = Object.keys(seriesById);
  return {
    fetchedAt: '2031-01-01T00:00:00.000Z',
    seriesCount: count,
    seriesIds,
    missingSeriesIds: FRED_SEED_SERIES.filter((seriesId) => !seriesById[seriesId]),
    seriesById,
    stress: null,
  };
}

function makeRunSeedHarness(events) {
  return async (domain, resource, key, fetchFn, options) => {
    events.push('runSeed');
    assert.equal(domain, 'economic');
    assert.equal(resource, 'fred-rates');
    assert.equal(key, CANONICAL_KEY);

    const batch = await fetchFn();
    const canonical = options.publishTransform(batch);
    assert.equal(options.recordCount(canonical), canonical.seriesCount);
    assert.equal(options.declareRecords(canonical), canonical.seriesCount);
    if (!options.validateFn(canonical)) {
      events.push('rejected');
      return { skipped: true, batch, canonical };
    }

    events.push('validated');
    await options.publishAtomically(batch, {
      canonicalKey: key,
      payload: JSON.stringify(canonical),
      payloadValue: canonical,
      ttlSeconds: FRED_TTL,
    });
    events.push('canonical');
    await options.afterPublish(batch, { canonicalKey: key });
    return { skipped: false, batch, canonical };
  };
}

describe('FRED publication gates', () => {
  it('retains every FRED consumer payload and its unchanged companion metadata across repeated source failures', async () => {
    const captured = await captureFredSeedOptions();
    assert.equal(captured.domain, 'economic');
    assert.equal(captured.resource, 'fred-rates');
    assert.equal(captured.canonicalKey, CANONICAL_KEY);
    assert.deepEqual(captured.options.preserveKeyTtls, expectedFredSidePreservationTargets());
    assert.equal(captured.options.emptyDataIsFailure, true);

    const clock = { now: 1_700_000_000_000 };
    const entries = primeFredConsumerCohort(clock);
    const missingKey = `${FRED_KEY_PREFIX}:${FRED_SEED_SERIES.at(-1)}:0`;
    const missingMetaKey = companionMetaKey(missingKey);
    entries.delete(missingKey);
    entries.delete(missingMetaKey);
    const before = new Map([...entries].map(([key, entry]) => [key, clone(entry.value)]));
    const pipelines = [];
    installExpiryAwareRedis(clock, entries, pipelines);

    for (const advanceMs of [0, 5, 10, 15, 20, 25, 30].map((hours) => hours * 60 * 60 * 1000)) {
      clock.now = 1_700_000_000_000 + advanceMs;
      const exitCode = await trapSeedExit(() => runSeed(
        captured.domain,
        captured.resource,
        captured.canonicalKey,
        async () => {
          throw Object.assign(new Error('FRED upstream unavailable'), { nonRetryable: true });
        },
        captured.options,
      ));
      assert.equal(exitCode, GRACEFUL_FETCH_FAILURE_EXIT_CODE);
    }

    assertCohortContentAndTtl(entries, before, clock);
    assert.equal(entries.has(missingKey), false, 'retention must not recreate a missing FRED payload');
    assert.equal(entries.has(missingMetaKey), false, 'retention must not recreate metadata for a missing FRED payload');

    const latestGroups = new Map(
      pipelines.slice(-3).map(({ commands }) => [
        commands[0][2],
        commands.map(([, key]) => key).sort(),
      ]),
    );
    assert.deepEqual(latestGroups, new Map([
      [FRED_TTL, [
        CANONICAL_KEY,
        ...FRED_SEED_SERIES.map((seriesId) => `${FRED_KEY_PREFIX}:${seriesId}:0`),
      ].sort()],
      [STRESS_INDEX_TTL, [STRESS_INDEX_KEY]],
      [SEED_META_TTL, [
        'seed-meta:economic:fred-rates',
        ...FRED_SEED_SERIES.map((seriesId) => companionMetaKey(`${FRED_KEY_PREFIX}:${seriesId}:0`)),
        companionMetaKey(STRESS_INDEX_KEY),
      ].sort()],
    ]));
  });

  it('retains the FRED cohort without rewriting metadata on validation or atomic publication failure', async () => {
    const captured = await captureFredSeedOptions();
    assert.deepEqual(captured.options.preserveKeyTtls, expectedFredSidePreservationTargets());
    assert.equal(captured.options.emptyDataIsFailure, true);

    const cases = [
      {
        name: 'partial validation failure',
        run: async () => {
          const exitCode = await trapSeedExit(() => runSeed(
            captured.domain,
            captured.resource,
            captured.canonicalKey,
            async () => makeFredBatch(MIN_SERIES_COUNT - 1),
            captured.options,
          ));
          assert.equal(exitCode, 1);
        },
      },
      {
        name: 'atomic publication failure',
        run: async () => assert.rejects(
          runSeed(
            captured.domain,
            captured.resource,
            captured.canonicalKey,
            async () => makeFredBatch(MIN_SERIES_COUNT),
            {
              ...captured.options,
              publishAtomically: async () => {
                throw new Error('FRED cohort publication failed');
              },
            },
          ),
          /FRED cohort publication failed/,
        ),
      },
    ];

    for (const failure of cases) {
      const clock = { now: 1_700_000_000_000 };
      const entries = primeFredConsumerCohort(clock);
      const before = new Map([...entries].map(([key, entry]) => [key, clone(entry.value)]));
      const pipelines = [];
      installExpiryAwareRedis(clock, entries, pipelines);

      await failure.run();
      assertCohortContentAndTtl(entries, before, clock);
      assert.equal(pipelines.length, 3, `${failure.name} must extend each TTL cohort once`);
    }
  });

  it('publishes every FRED value and aggregate freshness metadata as one atomic value command', async () => {
    const batch = makeFredBatch(MIN_SERIES_COUNT);
    batch.stress = { components: [{ id: 'A' }], seededAt: '2031-01-01T00:00:00.000Z' };
    const payloadValue = {
      _seed: { fetchedAt: 1, recordCount: batch.seriesCount, sourceVersion: 'fred-v1' },
      data: { seriesCount: batch.seriesCount },
    };
    const transactions = [];

    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (String(url).endsWith('/multi-exec')) {
        transactions.push(body);
        return Response.json(body.map((command) => command[0] === 'MSET'
          ? { error: 'ERR simulated cohort value failure' }
          : { result: 1 }));
      }
      return Response.json({ result: 'OK' });
    };

    await assert.rejects(
      publishFredCohortAtomically(batch, {
        payload: JSON.stringify(payloadValue),
        payloadValue,
      }),
      /command result/i,
    );

    const published = msetEntries(transactions[0][0]);
    assert.deepEqual([...published.keys()], [
      ...batch.seriesIds.flatMap((seriesId) => {
        const key = `${FRED_KEY_PREFIX}:${seriesId}:0`;
        return [key, companionMetaKey(key)];
      }),
      STRESS_INDEX_KEY,
      companionMetaKey(STRESS_INDEX_KEY),
      'seed-meta:economic:fred-rates',
      CANONICAL_KEY,
    ]);
    const aggregateMeta = JSON.parse(published.get('seed-meta:economic:fred-rates'));
    assert.equal(aggregateMeta.fetchedAt, payloadValue._seed.fetchedAt);
    assert.equal(aggregateMeta.recordCount, batch.seriesCount);
    assert.equal(aggregateMeta.sourceVersion, 'fred-v1');
    const ttlByKey = new Map(transactions[0].slice(1).map(([, key, ttl]) => [key, ttl]));
    for (const seriesId of batch.seriesIds) {
      const key = `${FRED_KEY_PREFIX}:${seriesId}:0`;
      assert.equal(ttlByKey.get(key), FRED_TTL);
      assert.equal(ttlByKey.get(companionMetaKey(key)), SEED_META_TTL);
    }
    assert.equal(ttlByKey.get(STRESS_INDEX_KEY), STRESS_INDEX_TTL);
    assert.equal(ttlByKey.get(companionMetaKey(STRESS_INDEX_KEY)), SEED_META_TTL);
    assert.equal(ttlByKey.get('seed-meta:economic:fred-rates'), SEED_META_TTL);
    assert.equal(ttlByKey.get(CANONICAL_KEY), FRED_TTL);
  });

  it('publishes every consumer key and activation after a retained source failure recovers', async () => {
    const captured = await captureFredSeedOptions();
    const clock = { now: 1_700_000_000_000 };
    const entries = primeFredConsumerCohort(clock);
    installExpiryAwareRedis(clock, entries, []);
    const exitCode = await trapSeedExit(() => runSeed(
      captured.domain,
      captured.resource,
      captured.canonicalKey,
      async () => {
        throw Object.assign(new Error('FRED upstream unavailable'), { nonRetryable: true });
      },
      captured.options,
    ));
    assert.equal(exitCode, GRACEFUL_FETCH_FAILURE_EXIT_CODE);

    const events = [];
    const writtenKeys = [];
    await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => makeSeriesMap(FRED_SEED_SERIES.length),
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => ({ components: [{ id: 'stress' }] }),
      publishFredCohortImpl: async (batch) => {
        writtenKeys.push(...batch.seriesIds.map((seriesId) => `${FRED_KEY_PREFIX}:${seriesId}:0`));
        if (batch.stress) writtenKeys.push(STRESS_INDEX_KEY);
      },
      markFredRatesActivatedImpl: async () => {
        events.push('activation');
      },
    });

    assert.deepEqual(
      writtenKeys.slice(0, -1),
      FRED_SEED_SERIES.map((seriesId) => `${FRED_KEY_PREFIX}:${seriesId}:0`),
    );
    assert.equal(writtenKeys.at(-1), STRESS_INDEX_KEY);
    assert.equal(events.at(-1), 'activation');
  });

  it('rejects 17/24 before side writes or activation', async () => {
    const events = [];
    const writes = [];
    let upstreamCalls = 0;
    let activations = 0;
    const result = await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => {
        upstreamCalls += 1;
        events.push('fetch:upstream');
        return makeSeriesMap(17);
      },
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => null,
      publishFredCohortImpl: async (...args) => {
        writes.push(args);
      },
      markFredRatesActivatedImpl: async () => {
        activations += 1;
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.canonical.seriesCount, 17);
    assert.equal(result.canonical.missingSeriesIds.length, 7);
    assert.equal(upstreamCalls, 1);
    assert.deepEqual(writes, []);
    assert.equal(activations, 0);
    assert.deepEqual(events, ['runSeed', 'fetch:upstream', 'rejected']);
  });

  it('accepts 18/24, publishes side keys before canonical, and activates last', async () => {
    const events = [];
    const writes = [];
    const result = await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => {
        events.push('fetch:upstream');
        return makeSeriesMap(18);
      },
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => null,
      publishFredCohortImpl: async (...args) => {
        events.push('cohort');
        writes.push(args);
      },
      markFredRatesActivatedImpl: async () => {
        events.push('activation');
      },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.canonical.seriesCount, 18);
    assert.deepEqual(result.canonical.seriesIds, FRED_SEED_SERIES.slice(0, 18));
    assert.deepEqual(result.canonical.missingSeriesIds, FRED_SEED_SERIES.slice(18));
    assert.deepEqual(Object.keys(result.canonical), [
      'fetchedAt',
      'seriesCount',
      'seriesIds',
      'missingSeriesIds',
    ]);
    assert.equal('seriesById' in result.canonical, false);
    assert.equal('stress' in result.canonical, false);
    assert.equal(writes.length, 1);
    const canonicalIndex = events.indexOf('canonical');
    assert.ok(events.indexOf('cohort') < canonicalIndex);
    assert.equal(events.at(-1), 'activation');
  });

  it('publishes one atomic cohort without refetching upstream', async () => {
    const events = [];
    let upstreamCalls = 0;
    let cohortCalls = 0;
    const result = await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => {
        upstreamCalls += 1;
        return makeSeriesMap(18);
      },
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => null,
      publishFredCohortImpl: async () => {
        cohortCalls += 1;
      },
      markFredRatesActivatedImpl: async () => {},
    });

    assert.equal(result.skipped, false);
    assert.equal(cohortCalls, 1);
    assert.equal(upstreamCalls, 1);
  });

  it('includes a computed stress index in the atomic cohort', async () => {
    const events = [];
    let publishedBatch;
    const stress = {
      compositeScore: 42,
      label: 'Elevated',
      components: [{ id: 'A' }, { id: 'B' }],
      unavailable: false,
    };
    await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => makeSeriesMap(18),
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => stress,
      publishFredCohortImpl: async (batch) => {
        publishedBatch = batch;
      },
      markFredRatesActivatedImpl: async () => {},
    });

    assert.equal(publishedBatch.stress, stress);
    assert.equal(publishedBatch.stress.components.length, 2);
  });

  it('keeps stress computation failure non-fatal', async () => {
    const events = [];
    const writtenKeys = [];
    const result = await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => makeSeriesMap(18),
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => {
        throw new Error('missing stress component');
      },
      publishFredCohortImpl: async (batch) => {
        writtenKeys.push(...batch.seriesIds.map((seriesId) => `${FRED_KEY_PREFIX}:${seriesId}:0`));
        if (batch.stress) writtenKeys.push(STRESS_INDEX_KEY);
      },
      markFredRatesActivatedImpl: async () => {},
    });

    assert.equal(result.skipped, false);
    assert.equal(writtenKeys.length, 18);
    assert.equal(writtenKeys.includes(STRESS_INDEX_KEY), false);
  });

  it('does not activate when the atomic cohort publication fails', async () => {
    const events = [];
    let upstreamCalls = 0;
    let stressAttempts = 0;
    await assert.rejects(() => runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => {
        upstreamCalls += 1;
        return makeSeriesMap(18);
      },
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => ({ components: [{ id: 'A' }] }),
      publishFredCohortImpl: async () => {
        stressAttempts += 1;
        throw new Error('FRED atomic publication returned an invalid command result');
      },
      markFredRatesActivatedImpl: async () => {
        events.push('activation');
      },
    }), /FRED atomic publication returned an invalid command result/);

    assert.equal(upstreamCalls, 1);
    assert.equal(stressAttempts, 1);
    assert.equal(events.includes('canonical'), false);
    assert.equal(events.includes('activation'), false);
  });
});

describe('Upstash command error handling', () => {
  it('caps delta-seconds and HTTP-date Retry-After delays on HTTP errors', async () => {
    globalThis.fetch = async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '2' },
    });
    const deltaError = await upstashCommand(
      { restUrl: 'https://redis.test', token: 'fake-token' },
      ['GET', 'key'],
    ).then(() => null, (error) => error);
    assert.equal(deltaError?.status, 429);
    assert.equal(deltaError?.retryAfterMs, 2000);

    const retryAt = new Date(Date.now() + 5000).toUTCString();
    globalThis.fetch = async () => new Response('', {
      status: 503,
      headers: { 'Retry-After': retryAt },
    });
    const dateError = await upstashCommand(
      { restUrl: 'https://redis.test', token: 'fake-token' },
      ['GET', 'key'],
    ).then(() => null, (error) => error);
    assert.equal(dateError?.status, 503);
    assert.equal(dateError?.retryAfterMs, 2000);

    globalThis.fetch = async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '86400' },
    });
    const oversizedError = await upstashCommand(
      { restUrl: 'https://redis.test', token: 'fake-token' },
      ['GET', 'key'],
    ).then(() => null, (error) => error);
    assert.equal(oversizedError?.retryAfterMs, 2000);

    globalThis.fetch = async () => new Response('', {
      status: 503,
      headers: { 'Retry-After': 'not-a-delay' },
    });
    const invalidError = await upstashCommand(
      { restUrl: 'https://redis.test', token: 'fake-token' },
      ['GET', 'key'],
    ).then(() => null, (error) => error);
    assert.equal(invalidError?.retryAfterMs, undefined);
  });

  it('rejects HTTP-200 Redis command errors in writeSeedMeta', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'READONLY simulated' }),
    });

    await assert.rejects(
      writeSeedMeta('economic:fred:v1:FEDFUNDS:0', 1),
      /seed-meta .* rejected by Upstash: READONLY simulated/,
    );
  });

  it('rejects HTTP-200 Redis command errors in activation writes', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'READONLY simulated' }),
    });

    await assert.rejects(
      upstashCommand({ restUrl: 'https://redis.test', token: 'fake-token' }, ['SET', 'activation', '1', 'NX']),
      /Upstash rejected command: READONLY simulated/,
    );
  });
});
