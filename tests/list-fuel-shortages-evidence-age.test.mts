/**
 * The seeder republishes the hand-curated fuel-shortage registry every day,
 * so the registry's updatedAt is always fresh. ListFuelShortages must date the
 * response by the newest row confirmation instead.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
delete process.env.LOCAL_API_MODE;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://upstash.test/get/')) {
    return Response.json({ result: JSON.stringify(registry) });
  }
  throw new Error(`unexpected global fetch: ${url}`);
}) as typeof fetch;

const { listFuelShortages } = await import('../server/worldmonitor/supply-chain/v1/list-fuel-shortages');

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

const row = (id: string, country: string, lastConfirmed: string) => ({
  id, country, product: 'diesel', severity: 'confirmed', firstSeen: '2026-01-01T00:00:00Z',
  lastConfirmed, resolvedAt: null, impactTypes: [], causeChain: [], shortDescription: '',
});

const registry = {
  updatedAt: '2026-11-24T07:32:26.870Z',
  classifierVersion: 'v1',
  shortages: {
    pk: row('pk', 'PK', '2026-04-15T00:00:00Z'),
    cu: row('cu', 'CU', '2026-04-20T00:00:00Z'),
  },
};

const ALL = { country: '', product: '', severity: '' };

describe('listFuelShortages dates the response by evidence, not by registry republish', () => {
  it('reports the newest lastConfirmed as fetchedAt, not the fresh registry updatedAt', async () => {
    const res = await listFuelShortages(null, ALL);
    assert.equal(res.shortages.length, 2);
    assert.equal(res.fetchedAt, '2026-04-20T00:00:00Z');
  });

  it('dates a filtered response by the rows it returns', async () => {
    const res = await listFuelShortages(null, { ...ALL, country: 'PK' });
    assert.deepEqual(res.shortages.map(s => s.id), ['pk']);
    assert.equal(res.fetchedAt, '2026-04-15T00:00:00Z');
  });

  it('falls back to the registry updatedAt when no row matches', async () => {
    const res = await listFuelShortages(null, { ...ALL, country: 'NZ' });
    assert.equal(res.shortages.length, 0);
    assert.equal(res.fetchedAt, '2026-11-24T07:32:26.870Z');
  });
});
