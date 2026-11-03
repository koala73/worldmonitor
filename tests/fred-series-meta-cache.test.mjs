// fetchFredSeries used to issue TWO proxied requests per series on every run:
// /fred/series/observations (the data) and /fred/series (title/units/frequency).
// The second reads constants — DGS10's title does not change between hourly runs —
// so half of this seeder's traffic to api.stlouisfed.org, the largest request-count
// target on the residential proxy account, was re-reading descriptions.
//
// These tests pin the cache that removes it, and the three ways it must NOT go wrong:
// a failed description must never be cached as if real, the cache must never become
// load-bearing for the observations, and an unconfigured Redis must degrade rather
// than kill the seeder.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRED_SEED_SERIES,
  fetchFredSeries,
  normalizeFredSeriesMeta,
  readFredSeriesMetaCache,
  writeFredSeriesMetaCache,
} from '../scripts/_fred-seeder.mjs';

const realLog = console.log;
const realWarn = console.warn;
before(() => { console.log = () => {}; console.warn = () => {}; });
after(() => { console.log = realLog; console.warn = realWarn; });

process.env.FRED_API_KEY ||= 'test-key';

const isObservations = (url) => url.includes('/series/observations');
const seriesIdOf = (url) => new URL(url).searchParams.get('series_id');

/** Records every URL fetched so the test can assert on request SHAPE, not just output. */
function makeFred({ metaFails = new Set() } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const id = seriesIdOf(url);
    if (isObservations(url)) {
      return { observations: [{ date: '2026-09-01', value: '1.5' }] };
    }
    if (metaFails.has(id)) throw new Error(`meta boom for ${id}`);
    return { seriess: [{ title: `Title ${id}`, units: 'Percent', frequency: 'Daily' }] };
  };
  return {
    fn,
    calls,
    metaCallsFor: (id) => calls.filter((u) => !isObservations(u) && seriesIdOf(u) === id).length,
    metaCalls: () => calls.filter((u) => !isObservations(u)).length,
    obsCalls: () => calls.filter(isObservations).length,
  };
}

const fullCache = () => Object.fromEntries(
  FRED_SEED_SERIES.map((id) => [id, { title: `Cached ${id}`, units: 'Index', frequency: 'Monthly' }]),
);

describe('FRED series-metadata cache', () => {
  it('makes ZERO /fred/series calls when every series is cached — the whole point', async () => {
    const fred = makeFred();
    let wrote = false;
    const out = await fetchFredSeries({
      fredFetchFn: fred.fn,
      proxyAuth: null,
      readMetaCache: async () => fullCache(),
      writeMetaCache: async () => { wrote = true; },
    });

    assert.equal(fred.metaCalls(), 0, 'a warm cache must not re-read series descriptions');
    assert.equal(fred.obsCalls(), FRED_SEED_SERIES.length, 'observations must still be fetched every run');
    assert.equal(wrote, false, 'nothing was fetched, so nothing should be written back');
    assert.equal(out.DGS10.title, 'Cached DGS10');
    assert.equal(out.DGS10.units, 'Index');
    assert.equal(out.DGS10.frequency, 'Monthly');
  });

  it('halves the request count versus a cold cache', async () => {
    const cold = makeFred();
    await fetchFredSeries({ fredFetchFn: cold.fn, proxyAuth: null, readMetaCache: async () => ({}), writeMetaCache: async () => {} });

    const warm = makeFred();
    await fetchFredSeries({ fredFetchFn: warm.fn, proxyAuth: null, readMetaCache: async () => fullCache(), writeMetaCache: async () => {} });

    assert.equal(cold.calls.length, FRED_SEED_SERIES.length * 2);
    assert.equal(warm.calls.length, FRED_SEED_SERIES.length);
  });

  it('writes back only what it actually fetched, and never the seriesId fallback', async () => {
    // BAMLC0A0CM's description fetch fails. The seeder still publishes it (title falls
    // back to the series id), but caching that placeholder would pin a wrong title for
    // the full 30-day TTL — the failure would outlive itself by a month.
    const fred = makeFred({ metaFails: new Set(['BAMLC0A0CM']) });
    let written = null;
    const out = await fetchFredSeries({
      fredFetchFn: fred.fn,
      proxyAuth: null,
      readMetaCache: async () => ({}),
      writeMetaCache: async (m) => { written = m; },
    });

    assert.equal(out.BAMLC0A0CM.title, 'BAMLC0A0CM', 'the historical fallback must be unchanged');
    assert.ok(written, 'the successful descriptions must still be cached');
    assert.equal(written.BAMLC0A0CM, undefined, 'a FAILED description must never be cached');
    assert.equal(written.DGS10.title, 'Title DGS10');
    assert.equal(Object.keys(written).length, FRED_SEED_SERIES.length - 1);
  });

  it('retries the failed description on the next run instead of pinning it', async () => {
    const first = makeFred({ metaFails: new Set(['GDP']) });
    let cache = {};
    await fetchFredSeries({
      fredFetchFn: first.fn, proxyAuth: null,
      readMetaCache: async () => cache, writeMetaCache: async (m) => { cache = m; },
    });

    const second = makeFred();
    const out = await fetchFredSeries({
      fredFetchFn: second.fn, proxyAuth: null,
      readMetaCache: async () => cache, writeMetaCache: async (m) => { cache = m; },
    });

    assert.equal(second.metaCallsFor('GDP'), 1, 'the uncached series must be retried');
    assert.equal(second.metaCalls(), 1, 'and only that one');
    assert.equal(out.GDP.title, 'Title GDP');
  });

  it('never lets the cache become load-bearing for observations', async () => {
    // A cached description must not make a series publishable when its data is gone.
    const fred = {
      fn: async (url) => {
        if (isObservations(url)) return { observations: [] };
        return { seriess: [{ title: 'x', units: '', frequency: '' }] };
      },
    };
    const out = await fetchFredSeries({
      fredFetchFn: fred.fn, proxyAuth: null,
      readMetaCache: async () => fullCache(), writeMetaCache: async () => {},
    });
    assert.deepEqual(out, {}, 'no observations means no published series, cache or not');
  });

  it('does not leak the internal metaSource marker into published records', async () => {
    const fred = makeFred();
    const out = await fetchFredSeries({
      fredFetchFn: fred.fn, proxyAuth: null,
      readMetaCache: async () => ({}), writeMetaCache: async () => {},
    });
    assert.deepEqual(
      Object.keys(out.DGS10).sort(),
      ['frequency', 'observations', 'seriesId', 'title', 'units'],
      'metaSource is bookkeeping and must not reach the published key',
    );
  });

  it('degrades to a cold cache when Upstash is unconfigured — must not exit the process', async () => {
    // getRedisCredentials() calls process.exit(1) on missing credentials, which no
    // try/catch can contain: reaching for it here would kill the seeder outright.
    // This test passing at all is the guard — an exit takes the whole file down.
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      assert.deepEqual(await readFredSeriesMetaCache(), {});
      await writeFredSeriesMetaCache({ DGS10: { title: 't', units: '', frequency: '' } });
    } finally {
      if (url !== undefined) process.env.UPSTASH_REDIS_REST_URL = url;
      if (token !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = token;
    }
  });

  it('sends a User-Agent on the cache read — AGENTS.md server-fetch contract', async () => {
    // redisCommand (the write path) already sends CHROME_UA; this raw GET has to set it
    // itself, and a recurring seeder request with only an Authorization header is
    // exactly the unidentifiable traffic that contract exists to prevent.
    const seen = [];
    const realFetch = globalThis.fetch;
    const realUrl = process.env.UPSTASH_REDIS_REST_URL;
    const realToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async (url, init) => {
      seen.push(init?.headers || {});
      return { ok: true, json: async () => ({ result: null }) };
    };
    try {
      await readFredSeriesMetaCache();
    } finally {
      globalThis.fetch = realFetch;
      if (realUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = realUrl;
      if (realToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = realToken;
    }
    assert.equal(seen.length, 1, 'the cache read must have issued exactly one fetch');
    assert.ok(seen[0]['User-Agent'], 'the cache read must carry a User-Agent header');
  });

  it('normalizeFredSeriesMeta accepts only a real description', () => {
    assert.deepEqual(
      normalizeFredSeriesMeta({ title: '10-Year Treasury', units: 'Percent', frequency: 'Daily', extra: 'dropped' }),
      { title: '10-Year Treasury', units: 'Percent', frequency: 'Daily' },
    );
    assert.equal(normalizeFredSeriesMeta({ title: '   ' }), null, 'a blank title is not a description');
    assert.equal(normalizeFredSeriesMeta({ units: 'Percent' }), null, 'units alone is not a description');
    assert.equal(normalizeFredSeriesMeta(null), null);
    assert.equal(normalizeFredSeriesMeta('DGS10'), null);
    assert.deepEqual(
      normalizeFredSeriesMeta({ title: 'T', units: 7, frequency: null }),
      { title: 'T', units: '', frequency: '' },
      'non-string fields collapse to empty, matching the historical shape',
    );
  });
});
