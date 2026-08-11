import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

import {
  CANONICAL_KEY,
  runFredRatesSeed,
} from '../scripts/seed-fred-rates.mjs';
import {
  FRED_SEED_SERIES,
  STRESS_INDEX_KEY,
  STRESS_INDEX_TTL,
} from '../scripts/_fred-seeder.mjs';
import { upstashCommand } from '../scripts/_upstash-rest.mjs';
import { writeSeedMeta } from '../scripts/_seed-utils.mjs';

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
    await options.beforePublish(batch, { canonicalKey: key });
    events.push('canonical');
    await options.afterPublish(batch, { canonicalKey: key });
    return { skipped: false, batch, canonical };
  };
}

describe('FRED publication gates', () => {
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
      writeExtraKeyWithMetaImpl: async (...args) => {
        writes.push(args);
        return true;
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
      writeExtraKeyWithMetaImpl: async (...args) => {
        events.push(`side:${args[0]}`);
        writes.push(args);
        return true;
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
    assert.equal(writes.length, 18);
    const canonicalIndex = events.indexOf('canonical');
    assert.ok(events.filter((event) => event.startsWith('side:')).every((event) => events.indexOf(event) < canonicalIndex));
    assert.equal(events.at(-1), 'activation');
  });

  it('retries component metadata locally without refetching upstream', async () => {
    const events = [];
    let upstreamCalls = 0;
    let firstKeyAttempts = 0;
    const firstKey = `economic:fred:v1:${FRED_SEED_SERIES[0]}:0`;
    const result = await runFredRatesSeed({
      runSeedImpl: makeRunSeedHarness(events),
      fetchFredSeriesImpl: async () => {
        upstreamCalls += 1;
        return makeSeriesMap(18);
      },
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => null,
      writeExtraKeyWithMetaImpl: async (key) => {
        if (key !== firstKey) return true;
        firstKeyAttempts += 1;
        return firstKeyAttempts >= 3;
      },
      markFredRatesActivatedImpl: async () => {},
    });

    assert.equal(result.skipped, false);
    assert.equal(firstKeyAttempts, 3);
    assert.equal(upstreamCalls, 1);
  });

  it('publishes a computed stress index in beforePublish', async () => {
    const events = [];
    const writes = [];
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
      writeExtraKeyWithMetaImpl: async (...args) => {
        writes.push(args);
        return true;
      },
      markFredRatesActivatedImpl: async () => {},
    });

    const stressWrite = writes.find(([key]) => key === STRESS_INDEX_KEY);
    assert.ok(stressWrite);
    assert.equal(stressWrite[1], stress);
    assert.equal(stressWrite[2], STRESS_INDEX_TTL);
    assert.equal(stressWrite[3], 2);
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
      writeExtraKeyWithMetaImpl: async (key) => {
        writtenKeys.push(key);
        return true;
      },
      markFredRatesActivatedImpl: async () => {},
    });

    assert.equal(result.skipped, false);
    assert.equal(writtenKeys.length, 18);
    assert.equal(writtenKeys.includes(STRESS_INDEX_KEY), false);
  });

  it('fails before canonical publication when stress metadata cannot be confirmed', async () => {
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
      writeExtraKeyWithMetaImpl: async (key) => {
        if (key !== STRESS_INDEX_KEY) return true;
        stressAttempts += 1;
        return false;
      },
      markFredRatesActivatedImpl: async () => {
        events.push('activation');
      },
    }), /FRED stress-index seed-meta write failed/);

    assert.equal(upstreamCalls, 1);
    assert.equal(stressAttempts, 3);
    assert.equal(events.includes('canonical'), false);
    assert.equal(events.includes('activation'), false);
  });
});

describe('Upstash command error handling', () => {
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
