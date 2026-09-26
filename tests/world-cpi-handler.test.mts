import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getWorldCpiMonthly } from '../server/worldmonitor/economic/v1/get-world-cpi-monthly';
import { WORLD_CPI_CANONICAL_KEYS, WORLD_CPI_LATEST_KEYS } from '../server/worldmonitor/economic/v1/world-cpi-monthly';

// Mirrors the US CPI handler test: capture fetch, capture the Redis env, and
// serve Upstash REST `{result}` envelopes. The handler reads through
// `getCachedJsonBatch`, which is a single POST to `${url}/pipeline`.
const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalLocalApiMode = process.env.LOCAL_API_MODE;

function redisEnv() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  delete process.env.LOCAL_API_MODE;
}

function envelope(data) {
  return JSON.stringify({
    _seed: {
      fetchedAt: Date.now(),
      recordCount: 1,
      sourceVersion: 'test',
      schemaVersion: 1,
      state: 'OK',
    },
    data,
  });
}

function payload(seriesByCountry) {
  return envelope({ countries: seriesByCountry });
}

/** Serve a pipeline response from a `{ key: data }` map. */
function redisPipelineMock(valuesByKey) {
  return async (url, init) => {
    assert.match(String(url), /\/pipeline$/);
    const pipeline = JSON.parse(init.body);
    const results = pipeline.map(([, key]) => ({
      result: valuesByKey[key] != null ? envelope(valuesByKey[key]) : null,
    }));
    return new Response(JSON.stringify(results));
  };
}

function months(entries) {
  return { frequency: 'M', indexBase: '2020=100', points: entries.map(([date, value]) => ({ date, value })) };
}

beforeEach(() => {
  redisEnv();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalLocalApiMode === undefined) delete process.env.LOCAL_API_MODE;
  else process.env.LOCAL_API_MODE = originalLocalApiMode;
});

describe('getWorldCpiMonthly handler', () => {
  it('reads the latest keys and returns one period per country', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(JSON.parse(init.body).map(([, key]) => key));
      return redisPipelineMock({
        [WORLD_CPI_LATEST_KEYS['imf-cpi']]: {
          countries: {
            US: months([['2025-08', 152], ['2026-08', 153.4]]),
            JP: months([['2026-08', 113.6]]),
          },
        },
      })(url, init);
    };

    const result = await getWorldCpiMonthly({} as never, { history: false, country: '' });
    assert.equal(result.unavailable, false);
    assert.deepEqual(result.countries.map((country) => country.country), ['JP', 'US']);
    for (const country of result.countries) assert.equal(country.periods.length, 1);
    // The latest read must not touch the canonical history keys.
    assert.equal(seen.length, 1);
    assert.ok(seen[0].every((key) => key.endsWith(':latest:v1')));
  });

  it('computes year-over-year from the windowed tail', async () => {
    globalThis.fetch = redisPipelineMock({
      [WORLD_CPI_LATEST_KEYS['imf-cpi']]: { countries: { US: months([['2025-08', 150], ['2026-08', 153]]) } },
    });
    const result = await getWorldCpiMonthly({} as never, { history: false, country: '' });
    const us = result.countries.find((country) => country.country === 'US');
    assert.ok(us);
    assert.equal(us.periods[0].reading?.index, 153);
    assert.equal(us.periods[0].reading?.yearOverYear?.percent, 2);
  });

  it('reads the canonical keys for history and returns every stored period', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(JSON.parse(init.body).map(([, key]) => key));
      return redisPipelineMock({
        [WORLD_CPI_CANONICAL_KEYS['imf-cpi']]: {
          countries: { US: months([['2025-08', 150], ['2026-07', 152], ['2026-08', 153]]) },
        },
      })(url, init);
    };
    const result = await getWorldCpiMonthly({} as never, { history: true, country: '' });
    const us = result.countries.find((country) => country.country === 'US');
    assert.ok(us);
    assert.equal(us.periods.length, 3);
    assert.ok(seen[0].every((key) => key.endsWith(':v1')));
  });

  it('falls through a stalled Eurostat overlay to the fresher IMF harmonised series', async () => {
    globalThis.fetch = redisPipelineMock({
      // Eurostat dissemination measured 9 months behind the IMF feed.
      [WORLD_CPI_LATEST_KEYS['eurostat-hicp']]: { countries: { DE: months([['2025-12', 132.8]]) } },
      [WORLD_CPI_LATEST_KEYS['imf-cpi']]: {
        countries: { DE: { frequency: 'M', indexBase: '2020=100', points: [{ date: '2026-08', value: 125.8 }] } },
        harmonised: { DE: { frequency: 'M', indexBase: '2020=100', points: [{ date: '2026-08', value: 136.34 }] } },
      },
    });
    const result = await getWorldCpiMonthly({} as never, { history: false, country: 'DE' });
    const de = result.countries.find((country) => country.country === 'DE');
    assert.ok(de);
    assert.equal(de.source, 'imf-hicp');
    assert.equal(de.periods[0].reading?.index, 136.34);
  });

  it('returns unavailable when every source misses', async () => {
    globalThis.fetch = redisPipelineMock({});
    const result = await getWorldCpiMonthly({} as never, { history: false, country: '' });
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.countries, []);
  });

  it('returns unavailable when Redis itself fails, not an empty dataset', async () => {
    globalThis.fetch = async () => {
      throw new Error('network unavailable');
    };
    const result = await getWorldCpiMonthly({} as never, { history: true, country: '' });
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.countries, []);
  });

  it('does not report a source outage for an unmatched country', async () => {
    globalThis.fetch = redisPipelineMock({
      [WORLD_CPI_LATEST_KEYS['imf-cpi']]: { countries: { US: months([['2026-08', 153]]) } },
    });
    const result = await getWorldCpiMonthly({} as never, { history: false, country: 'ZZ' });
    assert.deepEqual(result.countries, []);
    assert.equal(result.unavailable, false);
  });

  it('filters to one country and omits the rest', async () => {
    globalThis.fetch = redisPipelineMock({
      [WORLD_CPI_LATEST_KEYS['imf-cpi']]: {
        countries: { US: months([['2026-08', 153]]), JP: months([['2026-08', 113]]) },
      },
    });
    const result = await getWorldCpiMonthly({} as never, { history: false, country: 'jp' });
    assert.deepEqual(result.countries.map((country) => country.country), ['JP']);
  });
});
