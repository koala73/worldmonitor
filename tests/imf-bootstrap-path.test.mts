import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { before, beforeEach, afterEach, test } from 'node:test';
import { build } from 'esbuild';
import { isPublicOnDemandBootstrapRequest } from '../api/_bootstrap-public-tier.js';

let source: string;
let app: typeof import('../src/services/imf-country-data') & { bootstrap: typeof import('../src/services/bootstrap').__testing__ };
const originalFetch = globalThis.fetch;
const stamp = '2026-09-01T00:00:00Z';
const datasets: Record<string, unknown> = {
  imfMacro: { countries: { UA: { inflationPct: 4, year: 2026 } }, seededAt: stamp },
  imfGrowth: { countries: { UA: { realGdpGrowthPct: 2, year: 2026 } }, seededAt: stamp },
  imfLabor: { countries: { UA: { unemploymentPct: 7, year: 2026 } }, seededAt: stamp },
  imfExternal: { countries: { UA: { currentAccountUsd: -3, year: 2026 } }, seededAt: stamp },
};
before(async () => {
  const result = await build({ stdin: { contents: "export * from './src/services/imf-country-data.ts'; export { __testing__ as bootstrap } from './src/services/bootstrap.ts'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', define: { 'import.meta.env': '{"DEV":false}' } });
  source = result.outputFiles[0].text;
});
beforeEach(async () => { app = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`); });
afterEach(() => { globalThis.fetch = originalFetch; });

test('uses public credential-less per-key URLs, coalesces consumers, and preserves source time', async () => {
  const keys: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://worldmonitor.app');
    assert.equal(isPublicOnDemandBootstrapRequest(new Request(url)), true);
    assert.equal(init?.credentials, 'omit');
    const key = url.searchParams.get('keys')!; keys.push(key);
    return Response.json({ data: { [key]: datasets[key] } });
  };
  const [a, b] = await Promise.all([app.getImfCountryBundle('ua'), app.getImfCountryBundle('UA')]);
  assert.deepEqual(a, b); assert.equal(a.macro?.inflationPct, 4);
  assert.equal(a.fetchedAt, Date.parse(stamp));
  assert.deepEqual(a.datasetStatus, { macro: 'available', growth: 'available', labor: 'available', external: 'available' });
  await app.getAllCountriesInflation();
  const missing = await app.getImfCountryBundle('ZZ');
  assert.equal(missing.datasetStatus.macro, 'missing');
  assert.equal(keys.length, 4);
});

test('empty/private 200s and malformed datasets remain retryable without invented freshness', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  const empty = await app.getImfCountryBundle('UA');
  assert.equal(empty.fetchedAt, 0);
  assert.equal(empty.datasetStatus.macro, 'unavailable');
  await app.getImfCountryBundle('UA'); assert.equal(calls, 8);
  for (const invalid of [{}, { countries: {} }, { countries: [] }, { countries: { UA: null } }, { countries: { UA: { inflationPct: '<img>' } } }, { ...datasets.imfMacro as object, error: 'offline' }]) {
    globalThis.fetch = async (input) => { const key = new URL(String(input), 'https://worldmonitor.app').searchParams.get('keys')!; return Response.json({ data: { [key]: invalid } }); };
    assert.equal((await app.getImfCountryBundle('UA')).macro, null);
  }
});

test('partial failures retry only failed themes and recover while good themes are reused', async () => {
  const counts: Record<string, number> = {};
  let fail = true;
  globalThis.fetch = async (input) => {
    const key = new URL(String(input), 'https://worldmonitor.app').searchParams.get('keys')!;
    counts[key] = (counts[key] ?? 0) + 1;
    if (key === 'imfLabor' && fail) throw new Error('offline');
    return Response.json({ data: { [key]: datasets[key] } });
  };
  const partial = await app.getImfCountryBundle('UA');
  assert.equal(partial.macro?.inflationPct, 4); assert.equal(partial.labor, null);
  assert.equal(partial.datasetStatus.labor, 'unavailable');
  fail = false;
  assert.equal((await app.getImfCountryBundle('UA')).labor?.unemploymentPct, 7);
  assert.deepEqual(counts, { imfMacro: 1, imfGrowth: 1, imfLabor: 2, imfExternal: 1 });
});


test('cache expiry retries failures and missing source time stays unknown', async () => {
  const realNow = Date.now;
  let now = realNow();
  let calls = 0;
  Date.now = () => now;
  try {
    globalThis.fetch = async (input) => {
      calls++;
      const key = new URL(String(input), 'https://worldmonitor.app').searchParams.get('keys')!;
      return Response.json({ data: { [key]: { ...datasets[key] as object, seededAt: undefined } } });
    };
    assert.equal((await app.getImfCountryBundle('UA')).fetchedAt, 0);
    now += 11 * 60_000;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
    const expired = await app.getImfCountryBundle('UA');
    assert.equal(expired.macro, null); assert.equal(expired.datasetStatus.macro, 'unavailable');
    assert.equal(calls, 8);
  } finally { Date.now = realNow; }
});


test('concurrent readers share existing hydration without a failed second request', async () => {
  app.bootstrap.seedHydrationCacheForTests(datasets);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  const [a, b] = await Promise.all([app.getImfCountryBundle('UA'), app.getImfCountryBundle('UA')]);
  assert.deepEqual(a, b); assert.equal(a.macro?.inflationPct, 4); assert.equal(calls, 0);
});

test('browser and edge IMF validators stay identical', () => {
  assert.equal(readFileSync('shared/imf-dataset.js', 'utf8'), readFileSync('api/_imf-dataset.js', 'utf8'));
});
