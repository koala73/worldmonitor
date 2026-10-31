import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRegionalEnergyFeeds } from '../server/worldmonitor/intelligence/v1/_regional-energy-feeds';
import { fetchRegionalEnergyFeed, regionalEnergyContentMeta } from '../scripts/_regional-energy-source.mjs';
import { buildEnvelope } from '../scripts/_seed-envelope-source.mjs';
import { getCountryEnergyProfile } from '../server/worldmonitor/intelligence/v1/get-country-energy-profile';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { drainResponseHeaders } from '../server/_shared/response-headers';

const now = Date.parse('2026-10-29T16:00:00Z');
const snapshot = (sourceId = 'pgcb', overrides = {}) => ({
  sourceId, fetchedAt: '2026-10-29T15:00:00.000Z', observedAt: '2026-10-29T14:00:00.000Z',
  dataUrls: ['https://erp.powergrid.gov.bd/w/generations/view_generations'],
  observations: [{ metric: 'generation.solar', period: '2026-10-29T14:00:00.000Z', value: 0, unit: 'MW', area: '' }],
  ...overrides,
});

test('country profile reads only its source keys and preserves observed zero', async () => {
  const keys: string[] = [];
  const feeds = await readRegionalEnergyFeeds('BD', async key => {
    keys.push(key);
    return key.includes('pgcb') ? snapshot() : null;
  }, now);
  assert.deepEqual(keys.sort(), ['energy:regional:petrobangla:v1', 'energy:regional:pgcb:v1']);
  assert.equal(feeds[0].status, 'available');
  assert.equal(feeds[0].observations[0].value, 0);
  assert.equal(feeds[1].status, 'unavailable');
  assert.deepEqual(feeds[1].observations, []);
  assert.equal(feeds[0].fetchedAt, Date.parse('2026-10-29T15:00:00Z'));
  assert.equal(feeds[0].observedAt, Date.parse('2026-10-29T14:00:00Z'));
  assert.equal(feeds[1].fetchedAt, 0);
  assert.equal(feeds[1].observedAt, 0);
});

test('countries without these feeds perform no optional reads', async () => {
  assert.deepEqual(await readRegionalEnergyFeeds('DE', async () => { throw new Error('unexpected read'); }, now), []);
});

test('old source data stays stale after a fresh fetch', async () => {
  const feeds = await readRegionalEnergyFeeds('NG', async () => snapshot('niso', {
    observedAt: '2026-09-01T00:00:00.000Z',
    observations: [{ metric: 'generation.peak', period: '2026-09-01', value: 4000, unit: 'MW', area: '' }],
  }), now);
  assert.equal(feeds[0].status, 'stale');
  assert.equal(feeds[0].observations[0].stale, true);
});

test('a cache failure is distinct from a source with no seed and does not discard peer feeds', async () => {
  const feeds = await readRegionalEnergyFeeds('BD', async key => {
    if (key.includes('petrobangla')) throw new Error('redis unavailable');
    return snapshot();
  }, now);
  assert.equal(feeds[0].status, 'available');
  assert.equal(feeds[1].status, 'error');
  assert.equal(feeds[1].error, 'cache_read_failed');
});

test('malformed, cross-source, and future records are not served', async () => {
  for (const record of [snapshot('niso'), snapshot('pgcb', { observations: [] }), snapshot('pgcb', { fetchedAt: '2099-01-01' }), snapshot('pgcb', {
    observations: [{ metric: 'demand', period: '2099-01-01', unit: 'MW', value: 1, area: '' }],
  })]) {
    const feeds = await readRegionalEnergyFeeds('BD', async key => key.includes('pgcb') ? record : null, now);
    assert.equal(feeds[0].status, 'error');
    assert.deepEqual(feeds[0].observations, []);
  }
});

test('fresh ANP prices do not conceal stale monthly trade', async () => {
  const feeds = await readRegionalEnergyFeeds('BR', async key => key.includes('anp') ? snapshot('anp', {
    observations: [
      { metric: 'fuel.imports', period: '2025-12', value: 500, unit: 'm3', area: 'DIESEL' },
      { metric: 'fuel.retail_price', period: '2026-10-24', value: 6.49, unit: 'BRL/l', area: 'GASOLINA COMUM' },
    ],
  }) : null, now);
  const anp = feeds.find(f => f.sourceId === 'anp')!;
  assert.equal(anp.status, 'partial');
  assert.equal(anp.observations.find(p => p.metric === 'fuel.imports')!.stale, true);
  assert.equal(anp.observations.find(p => p.metric === 'fuel.retail_price')!.stale, false);
});

test('a provider response survives publication envelope, Redis decoding and both profile paths', async t => {
  const html = readFileSync(new URL('./fixtures/regional-energy/pgcb.html', import.meta.url), 'utf8');
  const data = await fetchRegionalEnergyFeed('pgcb', {
    nowMs: now,
    fetchFn: async (url, options) => {
      assert.equal(url, 'https://erp.powergrid.gov.bd/w/generations/view_generations');
      assert.match(options.headers['User-Agent'], /WorldMonitor/);
      assert.equal(options.redirect, 'manual');
      return new Response(html);
    },
  });
  const published = buildEnvelope({ fetchedAt: now, recordCount: data.observations.length,
    sourceVersion: 'regional-energy-pgcb-v1', schemaVersion: 1, state: 'OK', data,
    ...regionalEnergyContentMeta(data), maxContentAgeMin: 720 });
  const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  delete process.env.LOCAL_API_MODE;
  for (const spine of [null, { coverage: { hasMix: true }, sources: { mixYear: 2025 }, mix: { coalShare: 10 } }]) {
    installRedis({ 'energy:regional:pgcb:v1': published, 'energy:spine:v1:BD': spine });
    const response = await getCountryEnergyProfile({ request: new Request('https://www.worldmonitor.app'), pathParams: {}, headers: {} }, { countryCode: 'BD' });
    assert.equal(response.mixAvailable, spine !== null);
    const pgcb = response.regionalEnergyFeeds.find(f => f.sourceId === 'pgcb')!;
    assert.equal(pgcb.observations.find(p => p.metric === 'generation')!.value, 15636);
    assert.equal(pgcb.observations.find(p => p.metric === 'generation.solar')!.value, 0);
    assert.equal(pgcb.observedAt, Date.parse(data.observedAt));
    assert.equal(pgcb.licence, 'Unconfirmed');
    assert.deepEqual(pgcb.dataUrls, data.dataUrls);
    assert.equal(response.regionalEnergyFeeds.find(f => f.sourceId === 'petrobangla')!.status, 'unavailable');
    assert.ok(!JSON.stringify(response).includes('"_seed"'));
  }
});

test('optional cache failures disable response caching and recovery clears the marker on both profile paths', async t => {
  const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  delete process.env.LOCAL_API_MODE;
  for (const spine of [null, { coverage: { hasMix: true }, sources: { mixYear: 2025 }, mix: { coalShare: 10 } }]) {
    const redis = installRedis({ 'energy:regional:pgcb:v1': snapshot(), 'energy:spine:v1:BD': spine });
    let failing = true;
    globalThis.fetch = async (input, init) => {
      if (failing && decodeURIComponent(String(input)).includes('/get/energy:regional:petrobangla:v1')) return new Response('unavailable', { status: 503 });
      return redis.fetchImpl(input, init);
    };
    for (const expectedError of [true, false]) {
      failing = expectedError;
      const request = new Request('https://www.worldmonitor.app');
      const response = await getCountryEnergyProfile({ request, pathParams: {}, headers: {} }, { countryCode: 'BD' });
      assert.equal(response.mixAvailable, spine !== null);
      assert.equal(response.regionalEnergyFeeds[0].sourceId, 'pgcb');
      assert.equal(response.regionalEnergyFeeds[0].error, '');
      const petrobangla = response.regionalEnergyFeeds.find(feed => feed.sourceId === 'petrobangla')!;
      assert.equal(petrobangla.error, expectedError ? 'cache_read_failed' : '');
      assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], expectedError ? '1' : undefined);
    }
  }
});
