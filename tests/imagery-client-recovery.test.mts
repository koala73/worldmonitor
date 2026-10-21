import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

test('failed imagery searches preserve scenes and honor quota cooldown before recovery', async t => {
  const bundled = await build({
    entryPoints: ['src/services/imagery.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'runtime-fixture', setup(build) {
      build.onResolve({ filter: /^@\/services\/runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const toApiUrl = path => path;' }));
    } }],
  });
  const service = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`);
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { value: { location: { origin: 'https://example.test' } }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true }));
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let response = Response.json({ scenes: [{ id: 'existing' }] });
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response; });
  let displayed = await service.fetchImageryScenes({ bbox: '0,0,1,1' });
  response = new Response('', { status: 429, headers: { 'Retry-After': '2' } });
  await assert.rejects(async () => { displayed = await service.fetchImageryScenes({ bbox: '1,1,2,2' }); });
  assert.equal(displayed[0].id, 'existing');
  await assert.rejects(service.fetchImageryScenes({ bbox: '2,2,3,3' }));
  assert.equal(calls, 2);
  now += 2000;
  response = new Response('', { status: 503 });
  await assert.rejects(service.fetchImageryScenes({ bbox: '2,2,3,3' }));
  response = Response.json({ scenes: [] });
  displayed = await service.fetchImageryScenes({ bbox: '2,2,3,3' });
  assert.deepEqual(displayed, []);
  assert.equal(calls, 4);
});
