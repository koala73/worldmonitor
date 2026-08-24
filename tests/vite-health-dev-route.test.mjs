import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viteConfig = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('Vite dev server executes dashboard Edge handlers before source transforms', () => {
  assert.match(viteConfig, /function legacyEdgeApiPlugin\(\): Plugin/);
  assert.match(viteConfig, /server\.ssrLoadModule\(modulePath\)/);
  for (const route of [
    '/api/bootstrap',
    '/api/correlation-runtime-mode',
    '/api/geo',
    '/api/health',
    '/api/product-catalog',
    '/api/wm-session',
  ]) {
    assert.match(viteConfig, new RegExp(`\\['${route.replaceAll('/', '\\/')}'`));
  }

  const edgePluginIndex = viteConfig.indexOf('legacyEdgeApiPlugin(),');
  const sebufPluginIndex = viteConfig.indexOf('sebufApiPlugin(),');
  assert.ok(edgePluginIndex >= 0, 'legacy Edge plugin must be registered');
  assert.ok(sebufPluginIndex > edgePluginIndex, 'legacy Edge routes must run before the API router');
});
