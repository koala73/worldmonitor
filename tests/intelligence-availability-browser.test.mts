import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let source: string;
let app: typeof import('../src/services/satellites') & typeof import('../src/services/security-advisories') & typeof import('../src/services/gdelt-intel');
let response: any;
let hydrated: any;
let calls = 0;
const satellite = { id: '25544', name: 'ISS', country: 'US', type: 'station', line1: '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992', line2: '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442' };
const advisory = { title: 'Travel update', link: 'https://example.com/advice', pubDate: '2026-09-15T00:00:00Z', source: 'FCDO', sourceCountry: 'UK', level: 'caution', country: 'UA' };
const article = (title: string) => ({ title, url: `https://example.com/${title}`, source: 'example.com', date: '20260915T000000Z', image: '', language: 'English', tone: 0 });

before(async () => {
  const result = await build({
    stdin: { contents: "export * from './src/services/satellites'; export * from './src/services/security-advisories'; export * from './src/services/gdelt-intel'", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', define: { 'import.meta.env': '{"DEV":false}' },
    plugins: [{ name: 'boundaries', setup(b) {
      b.onResolve({ filter: /^@\/utils$/ }, args => args.importer.endsWith('/gdelt-intel.ts') ? { path: resolve('src/utils/circuit-breaker.ts') } : undefined);
      b.onResolve({ filter: /persistent-cache$/ }, () => ({ path: 'persistence', namespace: 'persistence' }));
      b.onLoad({ filter: /.*/, namespace: 'persistence' }, () => ({ contents: `
        export const getPersistentCache = async () => { throw new Error('GDELT must use its query-keyed cache'); };
        export const setPersistentCache = getPersistentCache;
        export const deletePersistentCache = getPersistentCache;
        export const deletePersistentCacheByPrefix = getPersistentCache;
      ` }));
      b.onResolve({ filter: /^(?:@\/services\/(?:rpc-client|generated-rpc-clients|bootstrap|i18n)|\.\/data-freshness)$/ }, args => ({ path: args.path, namespace: 'boundary' }));
      b.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: `
        export const createLazyClient = () => () => new Proxy({}, { get: () => (...args) => globalThis.__availabilityCall(...args) });
        export const getRpcBaseUrl = () => '';
        export class IntelligenceServiceClient {}
        export const getHydratedData = () => globalThis.__availabilityHydrated();
        export const dataFreshness = { recordUpdate() {} };
        export const t = x => x;
      ` }));
    } }],
  });
  source = result.outputFiles[0]!.text;
});
beforeEach(async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  calls = 0; hydrated = undefined; response = undefined;
  (globalThis as any).__availabilityCall = async () => { calls++; if (response instanceof Error) throw response; return response; };
  (globalThis as any).__availabilityHydrated = () => { const value = hydrated; hydrated = undefined; return value; };
  app = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`);
});

test('satellite miss does not reset failures, last-good expires, and recovery caches confirmed empty', async t => {
  let now = 10_000; t.mock.method(Date, 'now', () => now);
  response = { satellites: [satellite] };
  assert.equal((await app.fetchSatelliteTLEs())?.length, 1);
  now += 11 * 60_000;
  response = new Error('503');
  assert.equal((await app.fetchSatelliteTLEs())?.length, 1);
  assert.equal(app.getSatelliteStatus(), 'degraded');
  response = { satellites: [null] };
  await app.fetchSatelliteTLEs();
  await app.fetchSatelliteTLEs();
  assert.equal(app.getSatelliteStatus(), 'cooldown');
  now += 60 * 60_000;
  assert.equal(await app.fetchSatelliteTLEs(), null);
  now += 11 * 60_000;
  response = { satellites: [] };
  assert.deepEqual(await app.fetchSatelliteTLEs(), []);
  assert.equal(app.getSatelliteStatus(), 'ok');
  const before = calls;
  assert.deepEqual(await app.fetchSatelliteTLEs(), []);
  assert.equal(calls, before);
});

test('advisory unavailable is not successful empty; stale data expires and malformed hydration falls through', async t => {
  let now = 10_000; t.mock.method(Date, 'now', () => now);
  response = new Error('503');
  assert.deepEqual(await app.loadAdvisoriesFromServer(), { ok: false, advisories: [] });
  hydrated = { advisories: [{ ...advisory, pubDate: 'bad' }], byCountry: {} };
  response = { advisories: [advisory], byCountry: {} };
  const good = await app.loadAdvisoriesFromServer();
  assert.equal(good.ok, true);
  assert.equal(good.advisories[0]?.pubDate.toISOString(), advisory.pubDate.replace('Z', '.000Z'));
  now += 16 * 60_000;
  response = { advisories: [null], byCountry: {} };
  assert.deepEqual(await app.loadAdvisoriesFromServer(), { ok: false, advisories: good.advisories });
  now += 60 * 60_000;
  assert.deepEqual(await app.loadAdvisoriesFromServer(), { ok: false, advisories: [] });
  response = { advisories: [], byCountry: {} };
  assert.deepEqual(await app.loadAdvisoriesFromServer(), { ok: true, advisories: [] });
  const before = calls;
  await app.loadAdvisoriesFromServer();
  assert.equal(calls, before);
});

test('confirmed empty advisory hydration avoids an RPC', async () => {
  hydrated = { advisories: [], byCountry: {} };
  response = new Error('offline');
  assert.deepEqual(await app.loadAdvisoriesFromServer(), { ok: true, advisories: [] });
  assert.equal(calls, 0);
});

for (const name of ['fetchGdeltArticles', 'fetchPositiveGdeltArticles'] as const) {
  test(`${name}: queries stay isolated; errors trip cooldown; stale ceiling and recovery remain authoritative`, async t => {
    let now = 10_000; t.mock.method(Date, 'now', () => now);
    response = { articles: [article('first')], query: 'first', error: '' };
    const first = await app[name]('first');
    response = { articles: [article('second')], query: 'second', error: '' };
    assert.equal((await app[name]('second'))[0]?.title, 'second');
    now += 6 * 60_000;
    response = { articles: [], error: 'seed-unavailable', query: 'first' };
    assert.deepEqual(await app[name]('first'), first);
    assert.deepEqual(await app[name]('first'), first);
    const before = calls;
    await assert.rejects(app[name]('uncached'), /unavailable/);
    assert.equal(calls, before, 'resolved RPC errors reached the real breaker cooldown');
    now += 60 * 60_000;
    await assert.rejects(app[name]('first'), /unavailable/);
    now += 6 * 60_000;
    response = { articles: [], error: '', query: 'first' };
    assert.deepEqual(await app[name]('first'), []);
    const recovered = calls;
    assert.deepEqual(await app[name]('first'), []);
    assert.equal(calls, recovered, 'confirmed empty is cached');
  });
}

test('GDELT accepts confirmed empty topics and expires unused hydration', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const [first, second] = app.INTEL_TOPICS;
  hydrated = { topics: [{ id: first!.id, articles: [] }, { id: second!.id, articles: [article('bootstrap')] }] };
  assert.deepEqual((await app.fetchTopicIntelligence(first!)).articles, []);
  assert.equal(calls, 0);
  now += 61 * 60_000;
  response = new Error('offline');
  await assert.rejects(app.fetchTopicIntelligence(second!), /unavailable/);
});

test('malformed GDELT hydration falls through to a recoverable RPC', async () => {
  hydrated = { topics: [null] };
  response = { articles: [article('repaired')], query: 'military', error: '' };
  assert.equal((await app.fetchTopicIntelligence(app.INTEL_TOPICS[0]!)).articles[0]?.title, 'repaired');
  assert.equal(calls, 1);
});
