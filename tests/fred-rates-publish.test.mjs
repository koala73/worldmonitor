import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

import { fetchAndPublishFred } from '../scripts/seed-fred-rates.mjs';
import { upstashCommand } from '../scripts/_upstash-rest.mjs';
import { writeSeedMeta } from '../scripts/_seed-utils.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const VALID_SERIES = {
  FEDFUNDS: { seriesId: 'FEDFUNDS', observations: [{ date: '2031-01-01', value: 4.5 }] },
};

describe('FRED publication gates', () => {
  it('publishes only series with observations and reports the usable count', async () => {
    const writes = [];
    const result = await fetchAndPublishFred({
      fetchFredSeriesImpl: async () => ({
        ...VALID_SERIES,
        EMPTY: { seriesId: 'EMPTY', observations: [] },
      }),
      fetchGscpiFromRedisImpl: async () => null,
      computeStressIndexImpl: () => null,
      writeExtraKeyWithMetaImpl: async (...args) => {
        writes.push(args);
        return true;
      },
    });

    assert.equal(result.seriesCount, 1);
    assert.deepEqual(result.seriesIds, ['FEDFUNDS']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 'economic:fred:v1:FEDFUNDS:0');
    assert.equal(writes[0][3], 1);
  });

  it('rejects a batch with no usable series before writing anything', async () => {
    let writes = 0;
    await assert.rejects(
      fetchAndPublishFred({
        fetchFredSeriesImpl: async () => ({ EMPTY: { observations: [] } }),
        writeExtraKeyWithMetaImpl: async () => { writes += 1; return true; },
      }),
      /no usable series/,
    );
    assert.equal(writes, 0);
  });

  it('fails the batch when a component seed-meta write is not confirmed', async () => {
    await assert.rejects(
      fetchAndPublishFred({
        fetchFredSeriesImpl: async () => VALID_SERIES,
        fetchGscpiFromRedisImpl: async () => null,
        computeStressIndexImpl: () => null,
        writeExtraKeyWithMetaImpl: async () => false,
      }),
      /FEDFUNDS seed-meta write failed/,
    );
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
