import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { build } from 'esbuild';

let source: string;
before(async () => {
  const result = await build({
    entryPoints: ['src/services/consumer-prices/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', define: { 'import.meta.env': '{"DEV":false}' },
    plugins: [{ name: 'hydration-fixture', setup(b) {
      b.onLoad({filter: /src\/services\/bootstrap\.ts$/}, () => ({
        contents: 'export function getHydratedData(){return undefined}', loader: 'ts',
      }));
    } }], logLevel: 'silent',
  });
  source = result.outputFiles[0]!.text;
});

const methods = [
  'fetchConsumerPriceOverview', 'fetchConsumerPriceBasketSeries',
  'fetchConsumerPriceCategories', 'fetchConsumerPriceMovers',
  'fetchRetailerPriceSpreads', 'fetchConsumerPriceFreshness', 'fetchAllMarketsOverview',
];
for (const method of methods) {
  test(`${method} excludes unavailable responses but caches valid empty snapshots`, async (t) => {
    const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${method}`);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let unavailable = true;
    let asOf = '1';
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return Response.json({ upstreamUnavailable: unavailable, asOf, marketCode: 'ae',
        categories: [], risers: [], fallers: [], retailers: [], essentialsSeries: [], valueSeries: [], topCategories: [] });
    });
    const read = () => client[method]('ae');
    const unwrap = (value: any) => Array.isArray(value) ? value : [value];
    assert.ok(unwrap(await read()).every((r: any) => r.upstreamUnavailable));
    const failedRequests = requests;
    unavailable = false;
    const good = await read();
    assert.ok(requests > failedRequests, 'unavailable response must not hold its TTL');
    assert.ok(unwrap(good).every((r: any) => !r.upstreamUnavailable && r.asOf === '1'));
    const successfulRequests = requests;
    assert.deepEqual(await read(), good);
    assert.equal(requests, successfulRequests, 'available empty snapshots are cacheable');
    unavailable = true;
    now += 61 * 60 * 1000;
    await read();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(await read(), good, 'unavailable refresh must retain last-good');
    await new Promise(r => setImmediate(r));
    unavailable = false;
    asOf = '2';
    now += 61 * 60 * 1000;
    // The all-market cache wraps per-market SWR; permit both layers to refresh.
    await read();
    await new Promise(r => setImmediate(r));
    now += 61 * 60 * 1000;
    await read();
    await new Promise(r => setImmediate(r));
    assert.ok(unwrap(await read()).every((r: any) => r.asOf === '2'));
  });
}
