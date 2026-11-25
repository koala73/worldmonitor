import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const stubs: Record<string, string> = {
  '@/config': "export { INTEL_HOTSPOTS, CONFLICT_ZONES } from './src/config/geo'; export { PIPELINES } from './src/config/pipelines';",
  '@/services/military-base-config': 'export const preloadMilitaryBases = async () => {}; export const getMilitaryBases = () => [];',
};

async function loadRelatedAssets() {
  const result = await build({
    entryPoints: ['src/services/related-assets.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', logLevel: 'silent',
    define: { 'import.meta.env': '{"DEV":false}' },
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /^@\/(config|services\/military-base-config)$/ }, args => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'ts', resolveDir: process.cwd() }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
}

const service = await loadRelatedAssets();

async function originFor(title: string): Promise<string | undefined> {
  await service.preloadRelatedAssetTables([title]);
  return service.getClusterAssetContext({ allItems: [{ title }] })?.origin.label;
}

test('a topic word alone does not place a story at a hotspot', async () => {
  assert.equal(await originFor('Naver Cloud Teams Up with Korea Hydro & Nuclear Power, KEPCO KDN on AI Transformation of Nuclear Power... - BigGo Finance'), undefined);
  assert.equal(await originFor('Lithuania could return to building nuclear power, energy minister says - marketscreener.com'), undefined);
});

test('a story that names a hotspot place keeps its nearby assets', async () => {
  assert.equal(await originFor('Aramco Output Falls 13.7% as Pipeline Attacks Mount - houseofsaud.com'), 'Riyadh');
  assert.equal(await originFor('Silicon Valley AI data center expansion approved'), 'Silicon Valley');
  assert.equal(await originFor('Houston pipeline explosion injures workers'), 'Houston');
  assert.equal(await originFor('Congress questions Palo Alto AI data center power use'), 'Silicon Valley', 'topic words still rank hotspots that have place evidence');
});
