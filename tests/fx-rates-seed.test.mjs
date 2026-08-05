import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  SHARED_FX_FALLBACKS,
  fetchYahooFxRatesWithProvenance,
  getSharedFxRates,
} from '../scripts/_seed-utils.mjs';
import {
  ALL_CURRENCIES,
  buildFxRatesPayload,
  declareRecords,
  validateFxPayload,
} from '../scripts/seed-fx-rates.mjs';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

describe('shared FX fallback provenance', () => {
  test('Yahoo fetches identify every quote that used a constant fallback', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          chart: { result: [{ meta: { regularMarketPrice: 1.087654321 } }] },
        }), { status: 200 });
      }
      return new Response('rate limited', { status: 429 });
    };

    const result = await fetchYahooFxRatesWithProvenance({
      USD: 'USDUSD=X',
      EUR: 'EURUSD=X',
      KRW: 'KRWUSD=X',
    }, SHARED_FX_FALLBACKS);

    assert.deepEqual(result.rates, {
      USD: 1,
      EUR: 1.087654321,
      KRW: SHARED_FX_FALLBACKS.KRW,
    });
    assert.deepEqual(result.fallbackCurrencies, ['KRW']);
  });

  test('the canonical payload nulls fallback quotes and rejects an all-fallback run', () => {
    const rates = Object.fromEntries(ALL_CURRENCIES.map((currency) => [currency, 0.5]));
    rates.USD = 1;

    const partial = buildFxRatesPayload({
      rates,
      fallbackCurrencies: ['KRW', 'VND'],
    });
    assert.equal(partial.KRW, null);
    assert.equal(partial.VND, null);
    assert.deepEqual(partial.fallbackCurrencies, ['KRW', 'VND']);
    assert.equal(declareRecords(partial), ALL_CURRENCIES.length - 3);
    assert.equal(validateFxPayload(partial), true);

    const allFallback = buildFxRatesPayload({
      rates,
      fallbackCurrencies: ALL_CURRENCIES.filter((currency) => currency !== 'USD'),
    });
    assert.equal(declareRecords(allFallback), 0);
    assert.equal(validateFxPayload(allFallback), false);
  });

  test('the publish gate counts live quotes rather than fallback-filled keys', () => {
    const rates = Object.fromEntries(ALL_CURRENCIES.map((currency) => [currency, 0.5]));
    rates.USD = 1;
    const nonUsd = ALL_CURRENCIES.filter((currency) => currency !== 'USD');

    const tenLive = buildFxRatesPayload({
      rates,
      fallbackCurrencies: nonUsd.slice(10),
    });
    assert.equal(declareRecords(tenLive), 10);
    assert.equal(validateFxPayload(tenLive), false);

    const elevenLive = buildFxRatesPayload({
      rates,
      fallbackCurrencies: nonUsd.slice(11),
    });
    assert.equal(declareRecords(elevenLive), 11);
    assert.equal(validateFxPayload(elevenLive), true);
  });

  test('conversion consumers retry canonical gaps and retain fallback provenance', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      if (String(url).startsWith('https://redis.example/get/')) {
        return new Response(JSON.stringify({
          result: JSON.stringify({
            _seed: {
              fetchedAt: Date.now(),
              recordCount: 1,
              sourceVersion: 'yahoo-fx-shared',
              schemaVersion: 2,
              state: 'OK',
            },
            data: { USD: 1, KRW: null, fallbackCurrencies: ['KRW'] },
          }),
        }), { status: 200 });
      }
      return new Response('rate limited', { status: 429 });
    };

    const result = await getSharedFxRates(
      { USD: 'USDUSD=X', KRW: 'KRWUSD=X' },
      SHARED_FX_FALLBACKS,
    );

    assert.equal(calls, 2);
    assert.equal(result.USD, 1);
    assert.equal(result.KRW, SHARED_FX_FALLBACKS.KRW);
    assert.deepEqual(result.fallbackCurrencies, ['KRW']);
  });

  test('a successful point-of-use retry clears the canonical fallback marker', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://redis.example/get/')) {
        return new Response(JSON.stringify({
          result: JSON.stringify({ USD: 1, KRW: null, fallbackCurrencies: ['KRW'] }),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: 0.0007212345 } }] },
      }), { status: 200 });
    };

    const result = await getSharedFxRates(
      { USD: 'USDUSD=X', KRW: 'KRWUSD=X' },
      SHARED_FX_FALLBACKS,
    );

    assert.equal(result.KRW, 0.0007212345);
    assert.deepEqual(result.fallbackCurrencies, []);
  });

  test('point-of-use recovery caps Yahoo requests and marks unattempted gaps as fallbacks', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const currencies = ['EUR', 'JPY', 'KRW', 'AUD', 'CAD', 'NZD', 'CNY'];
    let yahooCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://redis.example/get/')) {
        return new Response(JSON.stringify({
          result: JSON.stringify({
            USD: 1,
            ...Object.fromEntries(currencies.map(currency => [currency, null])),
            fallbackCurrencies: currencies,
          }),
        }), { status: 200 });
      }
      yahooCalls += 1;
      return new Response(JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: 0.5 } }] },
      }), { status: 200 });
    };

    const result = await getSharedFxRates(
      Object.fromEntries(['USD', ...currencies].map(currency => [currency, `${currency}USD=X`])),
      SHARED_FX_FALLBACKS,
    );

    assert.equal(yahooCalls, 5);
    assert.deepEqual(result.fallbackCurrencies, ['NZD', 'CNY']);
    assert.equal(result.EUR, 0.5);
    assert.equal(result.NZD, SHARED_FX_FALLBACKS.NZD);
    assert.equal(result.CNY, SHARED_FX_FALLBACKS.CNY);
  });

  test('markerless legacy cache values are retried and returned with fallback provenance', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    let yahooCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://redis.example/get/')) {
        return new Response(JSON.stringify({
          result: JSON.stringify({ USD: 1, KRW: SHARED_FX_FALLBACKS.KRW }),
        }), { status: 200 });
      }
      yahooCalls += 1;
      return new Response('rate limited', { status: 429 });
    };

    const result = await getSharedFxRates(
      { USD: 'USDUSD=X', KRW: 'KRWUSD=X' },
      SHARED_FX_FALLBACKS,
    );

    assert.equal(yahooCalls, 1);
    assert.equal(result.KRW, SHARED_FX_FALLBACKS.KRW);
    assert.deepEqual(result.fallbackCurrencies, ['KRW']);
  });
});
