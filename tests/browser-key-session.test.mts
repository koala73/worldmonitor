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
        export const statusCalls = [];
        let result = true;
        let pending;
        let status = null;
        export function configure(value, wait) { result = value; pending = wait; }
        export function configureStatus(value) { status = value; }
        export async function fetchWmKeySessionStatus() {
          statusCalls.push(1);
          return typeof status === 'function' ? status() : status;
        }
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
  assert.equal((await exchange).ok, true);
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
    assert.deepEqual(await mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'stale-key' }), { ok: false, pro: 'failed' });
    assert.deepEqual(removed, []);

    mod.configure({ ok: false, rejected: true });
    assert.deepEqual(
      await mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'stale-key', widgetKey: 'stale-widget' }),
      { ok: false, widget: 'rejected', pro: 'rejected' },
    );
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
    assert.deepEqual(
      await mod.migrateLegacyKeysToHttpOnlySession({ widgetKey: 'revoked-widget', proKey: 'valid-pro' }),
      { ok: false, widget: 'rejected', pro: 'accepted' },
    );
    assert.deepEqual(mod.calls, [{ widgetKey: 'revoked-widget' }, { proKey: 'valid-pro' }]);
    assert.deepEqual(removed, ['wm-widget-key', 'wm-pro-key']);

    removed.length = 0;
    mod.calls.length = 0;
    mod.configure((keys: { widgetKey?: string; proKey?: string }) =>
      keys.proKey ? { ok: false, rejected: false } : { ok: true });
    assert.deepEqual(
      await mod.migrateLegacyKeysToHttpOnlySession({ widgetKey: 'valid-widget', proKey: 'unreachable-pro' }),
      { ok: false, widget: 'accepted', pro: 'failed' },
    );
    assert.deepEqual(removed, ['wm-widget-key'], 'the pro key stays for retry after a transport failure');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});

function installStorage(initial: Record<string, string> = {}): { values: Map<string, string>; restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => { values.set(k, String(v)); },
      removeItem: (k: string) => { values.delete(k); },
    },
  });
  return {
    values,
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as Record<string, unknown>).localStorage;
    },
  };
}

test('an empty exchange asks the server nothing and reports no verdicts', async () => {
  const mod = await loadSession();
  assert.deepEqual(await mod.migrateLegacyKeysToHttpOnlySession({ widgetKey: '  ', proKey: '' }), { ok: false });
  assert.deepEqual(mod.calls, []);
});

test('only an accepted exchange records that a key session may exist', async () => {
  const mod = await loadSession();
  const storage = installStorage({ 'wm-pro-key': 'legacy' });
  try {
    mod.configure({ ok: false, rejected: true });
    await mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'bad' });
    mod.configure({ ok: false, rejected: false });
    await mod.migrateLegacyKeysToHttpOnlySession({ widgetKey: 'unreachable' });
    assert.equal(storage.values.has(mod.KEY_SESSION_MARKER), false, 'rejected and failed exchanges leave no marker');

    mod.configure(true);
    assert.deepEqual(await mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'good' }), { ok: true, pro: 'accepted' });
    assert.equal(storage.values.get(mod.KEY_SESSION_MARKER), '1');
    for (const value of storage.values.values()) assert.notEqual(value, 'good', 'the marker never stores the key');
  } finally {
    storage.restore();
  }
});

test('status read skips the network when no key session was ever accepted in this browser', async () => {
  const mod = await loadSession();
  const storage = installStorage();
  try {
    mod.configureStatus({ widget: false, pro: true });
    assert.equal(await mod.readBrowserKeySessionStatus(), null);
    assert.equal(mod.statusCalls.length, 0);
  } finally {
    storage.restore();
  }
});

test('status read reports the server verdict and forgets the marker once no session is valid', async () => {
  const mod = await loadSession();
  const storage = installStorage();
  try {
    storage.values.set(mod.KEY_SESSION_MARKER, '1');
    mod.configureStatus({ widget: false, pro: true });
    assert.deepEqual(await mod.readBrowserKeySessionStatus(), { widget: false, pro: true });
    assert.equal(storage.values.get(mod.KEY_SESSION_MARKER), '1');

    mod.configureStatus(null);
    assert.equal(await mod.readBrowserKeySessionStatus(), null, 'an unreadable status is unknown, not false');
    assert.equal(storage.values.get(mod.KEY_SESSION_MARKER), '1', 'a transport failure keeps the marker for the next boot');

    mod.configureStatus({ widget: false, pro: false });
    assert.deepEqual(await mod.readBrowserKeySessionStatus(), { widget: false, pro: false });
    assert.equal(storage.values.has(mod.KEY_SESSION_MARKER), false);
    assert.equal(mod.statusCalls.length, 3);
  } finally {
    storage.restore();
  }
});

test('status read waits for a pending exchange so it reports the cookie that exchange set', async () => {
  const mod = await loadSession();
  const storage = installStorage();
  try {
    let finish!: () => void;
    mod.configure(true, new Promise<void>(resolve => { finish = resolve; }));
    // The server holds the cookie once the exchange has answered.
    let cookieSet = false;
    mod.configureStatus(() => ({ widget: false, pro: cookieSet }));
    const exchange = mod.migrateLegacyKeysToHttpOnlySession({ proKey: 'good' });
    const status = mod.readBrowserKeySessionStatus();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(mod.statusCalls.length, 0, 'status must not be sent while the exchange is in flight');
    cookieSet = true;
    finish();
    await exchange;
    assert.deepEqual(await status, { widget: false, pro: true });
  } finally {
    storage.restore();
  }
});
