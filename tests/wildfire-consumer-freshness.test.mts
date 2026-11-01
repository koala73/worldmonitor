import assert from 'node:assert/strict';
import { afterEach, before, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
type ConsumerContext = {
  intelligenceCache: { satelliteFires: unknown[] };
  map: { setFires: (fires: unknown[]) => void };
  panels: { 'satellite-fires': { update: (...args: unknown[]) => void; showConfigError: (error: unknown) => void } };
  statusPanel: { updateApi: (...args: unknown[]) => void };
};
type Harness = {
  Loader: new (ctx: ConsumerContext) => { loadFirmsData: () => Promise<void> };
  bootstrapTesting: { seedHydrationCacheForTests: (data: Record<string, unknown>) => void };
  calls: { errors: unknown[][]; updates: unknown[][]; signals: unknown[][] };
};
let harness: Harness;

before(async () => {
  const path = resolve(root, 'src/app/data-loader.ts');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const manager = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'DataLoaderManager') as ts.ClassDeclaration;
  const method = manager.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'loadFirmsData');
  assert.ok(method, 'exercise the actual application loader method');
  const result = await build({
    stdin: {
      contents: `
        import { fetchAllFires, flattenFires, computeRegionStats, toMapFires } from './src/services/wildfires/index.ts';
        export { __testing__ as bootstrapTesting } from './src/services/bootstrap.ts';
        export const calls = { errors: [], updates: [], signals: [] };
        const dataFreshness = {
          recordError(...args) { calls.errors.push(args); },
          recordUpdate(...args) { calls.updates.push(args); },
        };
        const t = key => key;
        async function runSignalAggregator(_panel, _label, callback) {
          callback({ ingestSatelliteFires(fires) { calls.signals.push(fires); } });
        }
        export class Loader {
          constructor(ctx) { this.ctx = ctx; }
          callPanel(...args) { throw new Error('unexpected loader failure: ' + args); }
          ${method.getText(source)}
        }
      `,
      loader: 'ts', resolveDir: root,
    },
    bundle: true, format: 'esm', platform: 'node', target: 'node24', write: false,
    define: { 'import.meta.env': '{"DEV":false}' },
  });
  harness = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

it('fresh to expired to recovered clears every wildfire consumer before reporting unavailable', async () => {
  const now = Date.now();
  Date.now = () => now;
  const fire = {
    id: 'synthetic-fire', region: 'BR', brightness: 330, frp: 12,
    confidence: 'FIRE_CONFIDENCE_HIGH', location: { latitude: -10, longitude: -55 },
    detectedAt: now - 60_000, dayNight: 'N',
  };
  let snapshot = { fireDetections: [fire], fetchedAt: now, dataAvailable: true };
  globalThis.fetch = (async () => new Response(JSON.stringify(snapshot), {
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  harness.bootstrapTesting.seedHydrationCacheForTests({ wildfires: snapshot });
  const mapCalls: unknown[][] = [];
  const panelCalls: unknown[][] = [];
  const statusCalls: unknown[][] = [];
  const errors: unknown[] = [];
  const ctx = {
    intelligenceCache: { satelliteFires: [] },
    map: { setFires: (fires: unknown[]) => mapCalls.push(fires) },
    panels: { 'satellite-fires': {
      update: (...args: unknown[]) => panelCalls.push(args),
      showConfigError: (error: unknown) => errors.push(error),
    } },
    statusPanel: { updateApi: (...args: unknown[]) => statusCalls.push(args) },
  };
  const loader = new harness.Loader(ctx);
  await loader.loadFirmsData();
  assert.equal(mapCalls.at(-1)?.length, 1);
  assert.equal(ctx.intelligenceCache.satelliteFires.length, 1);
  assert.equal(harness.calls.signals.at(-1)?.length, 1);
  assert.equal(harness.calls.updates.length, 1);

  Date.now = () => now + 6 * 60 * 60 * 1000 + 1;
  await loader.loadFirmsData();
  assert.deepEqual(mapCalls.at(-1), []);
  assert.deepEqual(ctx.intelligenceCache.satelliteFires, []);
  assert.deepEqual(harness.calls.signals.at(-1), []);
  assert.deepEqual(panelCalls.at(-1), [[], 0]);
  assert.deepEqual(statusCalls.at(-1), ['FIRMS', { status: 'error' }]);
  assert.deepEqual(errors, ['common.noData']);
  assert.deepEqual(harness.calls.errors, [['firms', 'stale_data']]);
  assert.equal(harness.calls.updates.length, 1, 'expired detections cannot renew the freshness clock');

  snapshot = { ...snapshot, fetchedAt: Date.now() };
  await loader.loadFirmsData();
  assert.equal(mapCalls.at(-1)?.length, 1);
  assert.equal(ctx.intelligenceCache.satelliteFires.length, 1);
  assert.equal(harness.calls.signals.at(-1)?.length, 1);
  assert.deepEqual(statusCalls.at(-1), ['FIRMS', { status: 'ok' }]);
  assert.equal(harness.calls.updates.length, 2);
});
