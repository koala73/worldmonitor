import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function loadSession() {
  const controls = await build({
    stdin: { contents: `export * from './src/services/browser-key-session.ts'; export * from '@/services/wm-session';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'session-transport', setup(builder) {
      builder.onResolve({ filter: /services\/wm-session$/ }, () => ({ path: 'transport', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        export const calls = [];
        let result = true;
        let pending;
        export function configure(value, wait) { result = value; pending = wait; }
        export async function establishWmKeySession(keys) { calls.push(keys); if (pending) await pending; return result; }
      ` }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(controls.outputFiles[0].text + '\n//' + Math.random()).toString('base64')}`);
}

test('legacy clear waits for pending exchange and clears only the requested key', async () => {
  const mod = await loadSession();
  let finish!: () => void;
  mod.configure(true, new Promise<void>(resolve => { finish = resolve; }));
  const exchange = mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'fixture-key' });
  const clear = mod.clearBrowserKeySession('wm-pro-key');
  await Promise.resolve();
  assert.deepEqual(mod.calls, [{ proKey: 'fixture-key' }]);
  finish();
  assert.equal(await exchange, true);
  assert.equal(await clear, true);
  assert.deepEqual(mod.calls, [{ proKey: 'fixture-key' }, { proKey: '' }]);
});

test('failed clear reports failure and preserves legacy storage for retry', async () => {
  const mod = await loadSession();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let removals = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { removeItem: () => { removals++; } } });
  try {
    mod.configure(false);
    assert.equal(await mod.clearBrowserKeySession('wm-widget-key'), false);
    assert.equal(removals, 0);
    mod.configure(true);
    assert.equal(await mod.clearBrowserKeySession('wm-widget-key'), true);
    assert.equal(removals, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});
