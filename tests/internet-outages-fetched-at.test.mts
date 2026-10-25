import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { listInternetOutages } from '../server/worldmonitor/infrastructure/v1/list-internet-outages';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const FETCHED_AT = Date.parse('2026-10-18T09:00:00Z');
const OUTAGES = { outages: [{ id: 'a', country: 'Iran', detectedAt: FETCHED_AT }] };

function serve(fixtures: Record<string, unknown>) {
  globalThis.fetch = createRedisFetch(fixtures).fetchImpl;
}

function call() {
  return listInternetOutages({} as never, { start: 0, end: 0, pageSize: 0, cursor: '', country: '' });
}

describe('listInternetOutages fetchedAt', () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = 'production';
    process.env.UPSTASH_REDIS_REST_URL = 'https://cache-redis.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  });
  after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  // Retention extends a payload whose Radar refresh failed without advancing
  // seed-meta, so the meta clock is the only honest age of the list.
  it('reports when the seeder last fetched the list, from seed-meta', async () => {
    serve({ 'infra:outages:v1': OUTAGES, 'seed-meta:infra:outages': { fetchedAt: FETCHED_AT, recordCount: 1 } });
    const response = await call();
    assert.equal(response.fetchedAt, FETCHED_AT);
    assert.equal(response.outages.length, 1);
  });

  it('reports 0 when the fetch time is unknown, still serving the list', async () => {
    serve({ 'infra:outages:v1': OUTAGES });
    const response = await call();
    assert.equal(response.fetchedAt, 0);
    assert.equal(response.outages.length, 1);
  });
});
