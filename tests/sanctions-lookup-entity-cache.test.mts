import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupSanctionEntity } from '../server/worldmonitor/sanctions/v1/lookup-entity.ts';

const index = [
  { id: 'SDN:1', name: 'Test Person', et: 'individual', cc: ['RU'], pr: ['SDN'], al: ['Unrelated Alias'], sl: ['SDN', 'SEMA'] },
  { id: 'CONSOLIDATED:2', name: 'Cargo Vessel', et: 'vessel', cc: ['IR'], pr: ['IRAN'], ids: ['imo:1234567'], sl: ['CONSOLIDATED'] },
];

function installIndex(t: test.TestContext, raw: unknown = index, fail = false) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.screen.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    assert.equal(url, 'https://redis.screen.test/get/sanctions%3Aentities%3Av1', 'lookup must only read the seeded index');
    if (fail) throw new Error('Redis unavailable');
    return new Response(JSON.stringify({ result: JSON.stringify(raw) }));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });
  return requests;
}

async function lookup(q: string, maxResults = 10) {
  return lookupSanctionEntity({} as never, { q, maxResults });
}

test('REST screens aliases and IMO against the index and never calls OpenSanctions', async t => {
  const requests = installIndex(t);
  const alias = await lookup('Unrelated Alias');
  assert.equal(alias.results[0]?.id, 'SDN:1');
  assert.equal(alias.source, 'CONSOLIDATED, SDN, SEMA');
  assert.equal((await lookup('IMO 1234567')).results[0]?.id, 'CONSOLIDATED:2');
  assert.equal(requests.length, 2);
});

test('REST applies shared name normalization, returns total before limiting, and rereads the index', async t => {
  const rows = [...index, { ...index[0], id: 'SDN:3' }];
  const requests = installIndex(t, rows);
  const first = await lookup('  TEST person ', 1);
  assert.equal(first.results.length, 1);
  assert.equal(first.total, 2);
  assert.deepEqual((await lookup('Test Person', 50)).results.map(r => r.id), ['SDN:1', 'SDN:3']);
  assert.equal(requests.length, 2, 'new seed data must not be hidden behind a per-query cache');
});

test('REST screens US Consolidated Screening List rows and names their list in source', async t => {
  const csl = { id: 'CSL-EL:ab12', name: 'Acme Electronics', et: 'unspecified', cc: ['CN'], pr: [], sl: ['CSL-EL'] };
  installIndex(t, [...index, csl]);
  const response = await lookup('Acme Electronics');
  assert.equal(response.results[0]?.id, 'CSL-EL:ab12');
  assert.equal(response.source, 'CONSOLIDATED, CSL-EL, SDN, SEMA');
});

test('REST rejects out-of-bounds queries without reading Redis', async t => {
  const requests = installIndex(t);
  for (const q of ['', 'x', 'x'.repeat(201)]) assert.equal((await lookup(q)).total, 0);
  assert.equal(requests.length, 0);
});

test('REST missing index or read failure reports unavailable source coverage', async t => {
  installIndex(t, null);
  const response = await lookup('Test Person');
  assert.deepEqual(response.results, []);
  assert.equal(response.source, 'unavailable');
});

test('REST Redis failure never makes a provider request', async t => {
  const requests = installIndex(t, null, true);
  const response = await lookup('Test Person');
  assert.deepEqual(response.results, []);
  assert.equal(response.source, 'unavailable');
  assert.ok(requests.every(url => url.startsWith('https://redis.screen.test/')));
});

test('REST empty index reports unavailable source coverage', async t => {
  installIndex(t, []);
  assert.equal((await lookup('Test Person')).source, 'unavailable');
});
