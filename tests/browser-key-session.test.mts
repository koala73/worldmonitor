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
        export async function establishWmKeySessionOutcome(keys) {
          calls.push(keys);
          if (pending) await pending;
          if (typeof result === 'function') return result(keys);
          if (typeof result === 'object') return result;
          return result ? { ok: true } : { ok: false, rejected: false };
        }
        export async function establishWmKeySession(keys) { return (await establishWmKeySessionOutcome(keys)).ok; }
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

test('a legacy key the server rejects is cleared; a transport failure keeps it for retry', async () => {
  const mod = await loadSession();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const removed: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { removeItem: (k: string) => { removed.push(k); } } });
  try {
    mod.configure({ ok: false, rejected: false });
    assert.equal(await mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'stale-key' }), false);
    assert.deepEqual(removed, []);

    mod.configure({ ok: false, rejected: true });
    assert.equal(await mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'stale-key', widgetKey: 'stale-widget' }), false);
    assert.deepEqual(removed, ['wm-widget-key', 'wm-pro-key']);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});

test('keys are exchanged one at a time so a stale widget key cannot delete a valid pro key', async () => {
  const mod = await loadSession();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const removed: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { removeItem: (k: string) => { removed.push(k); } } });
  try {
    mod.configure((keys: { widgetKey?: string; proKey?: string }) =>
      keys.widgetKey ? { ok: false, rejected: true } : { ok: true });
    assert.equal(await mod.migrateLegacyKeysToHttpOnlySession({ widgetKey: 'revoked-widget', proKey: 'valid-pro' }), false);
    assert.deepEqual(mod.calls, [{ widgetKey: 'revoked-widget' }, { proKey: 'valid-pro' }]);
    assert.deepEqual(removed, ['wm-widget-key', 'wm-pro-key']);

    removed.length = 0;
    mod.calls.length = 0;
    mod.configure((keys: { widgetKey?: string; proKey?: string }) =>
      keys.proKey ? { ok: false, rejected: false } : { ok: true });
    assert.equal(await mod.migrateLegacyKeysToHttpOnlySession({ widgetKey: 'valid-widget', proKey: 'unreachable-pro' }), false);
    assert.deepEqual(removed, ['wm-widget-key'], 'the pro key stays for retry after a transport failure');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});
