import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getCountryIntelBrief } from '../server/worldmonitor/intelligence/v1/get-country-intel-brief.ts';
import { getCountryCoverage, type CountryCoverageDependencies } from '../server/worldmonitor/intelligence/v1/get-country-coverage.ts';
import { getCountryFacts } from '../server/worldmonitor/intelligence/v1/get-country-facts.ts';
import { getCountryStockIndex } from '../server/worldmonitor/market/v1/get-country-stock-index.ts';
import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import { getResilienceIndicators } from '../server/worldmonitor/resilience/v1/get-resilience-indicators.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { validationFailure } from './helpers/validation-failure.mts';

const UNASSIGNED = ['ZZ', 'zz', 'XX', 'AA', 'QQ', 'UK', 'EU', 'UN'];

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

let fetched: string[];

beforeEach(() => {
  delete process.env.LOCAL_API_MODE;
  const redis = installRedis({});
  fetched = [];
  globalThis.fetch = (async (input, init) => {
    fetched.push(String(input));
    if (new URL(String(input)).host === 'redis.example') return redis.fetchImpl(input, init);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const ctxFor = (path: string) => ({
  request: new Request(`https://api.worldmonitor.app${path}`),
  pathParams: {},
  headers: {},
});

describe('get-country-intel-brief', () => {
  const read = (countryCode: string) => getCountryIntelBrief(
    ctxFor(`/api/intelligence/v1/get-country-intel-brief?country_code=${countryCode}`),
    { countryCode, framework: '' },
  );

  it('rejects unassigned codes on country_code before any Redis, upstream or LLM call', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('country_code', /ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(fetched, []);
  });

  it('rejects an empty country_code', async () => {
    await assert.rejects(read(''), validationFailure('country_code'));
    assert.deepEqual(fetched, []);
  });

  it('names an assigned territory instead of echoing its code', async () => {
    const response = await read('BV');
    assert.equal(response.countryName, 'Bouvet Island');
  });
});

describe('get-country-coverage', () => {
  let calls: string[];
  const deps: CountryCoverageDependencies = {
    fetchCoverage: async (...args) => {
      calls.push(`coverage:${args[1]}`);
      throw new Error('coverage stub');
    },
    collectStructured: async (input) => {
      calls.push(`structured:${input.code}`);
      return [];
    },
    now: () => Date.parse('2026-10-17T00:00:00Z'),
  };
  beforeEach(() => { calls = []; });
  const read = (countryCode: string) => getCountryCoverage(
    ctxFor('/api/intelligence/v1/get-country-coverage'),
    { countryCode, windowHours: 0, limit: 0 },
    deps,
  );

  it('rejects unassigned codes on country_code before fetching coverage', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('country_code', /assigned ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(fetched, []);
  });

  it('still serves assigned codes, including territories and Kosovo', async () => {
    for (const [code, name] of [['IQ', 'Iraq'], ['XK', 'Kosovo'], ['RE', 'Réunion'], ['BV', 'Bouvet Island']] as const) {
      const response = await read(code);
      assert.equal(response.countryCode, code);
      assert.equal(response.countryName, name);
    }
  });
});

describe('get-country-facts', () => {
  const read = (countryCode: string) => getCountryFacts(
    ctxFor('/api/intelligence/v1/get-country-facts'),
    { countryCode },
  );

  it('rejects unassigned codes on country_code before any Wikidata, Wikipedia or Redis call', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('country_code', /ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(fetched, []);
  });

  it('rejects an empty country_code', async () => {
    await assert.rejects(read(''), validationFailure('country_code'));
    assert.deepEqual(fetched, []);
  });
});

describe('get-country-stock-index', () => {
  const read = (countryCode: string) => getCountryStockIndex(
    ctxFor('/api/market/v1/get-country-stock-index'),
    { countryCode },
  );

  it('rejects unassigned codes on country_code instead of answering available: false', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('country_code', /ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(fetched, []);
  });

  it('rejects an empty country_code', async () => {
    await assert.rejects(read(''), validationFailure('country_code'));
  });

  it('keeps available: false for an assigned country with no tracked index', async () => {
    const response = await read('BV');
    assert.equal(response.available, false);
    assert.equal(response.code, 'BV');
    assert.deepEqual(fetched, []);
  });
});

describe('get-resilience-score', () => {
  const read = (countryCode: string) => getResilienceScore(
    ctxFor('/api/resilience/v1/get-resilience-score'),
    { countryCode },
  );

  it('rejects unassigned codes on countryCode before scoring or caching anything', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('countryCode', /assigned ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(fetched, []);
  });

  it('keeps the required-field violation for an empty code', async () => {
    await assert.rejects(read(''), validationFailure('countryCode', /required/));
  });
});

describe('get-resilience-indicators', () => {
  const read = (countryCode: string) => getResilienceIndicators(
    ctxFor('/api/resilience/v1/get-resilience-indicators'),
    { countryCode },
  );

  it('rejects unassigned codes on countryCode before scoring or caching anything', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('countryCode', /assigned ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(fetched, []);
  });
});
