/**
 * Sentry WORLDMONITOR-1D7: on Safari < 16 and Chrome < 103 the news digest
 * never loaded. `AbortSignal.timeout` does not exist there, so the digest
 * request threw `TypeError: AbortSignal.timeout is not a function` before
 * fetch ran, was classified as a network failure, retried, and threw again
 * 4 ms later. The news panels stayed empty.
 *
 * The digest was one of 76 bare `AbortSignal.timeout` calls in src/ (12 more
 * call `AbortSignal.any`, missing before Safari 17.4 and Chrome 116). Each
 * HTML entry installs fallbacks for both before anything else runs, so every
 * call site works on those engines.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAbortSignalFallbacks } from '../src/bootstrap/abort-signal-fallbacks.ts';
import { combineAbortSignals, createTimeoutSignal } from '../src/services/timeout-signal.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run `fn` with `AbortSignal.timeout` and `AbortSignal.any` removed, as on Safari 15. */
async function onOldEngine<T>(fn: () => T | Promise<T>): Promise<T> {
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  // @ts-expect-error intentional removal for old-engine coverage
  delete AbortSignal.timeout;
  // @ts-expect-error intentional removal for old-engine coverage
  delete AbortSignal.any;
  try {
    assert.equal(typeof AbortSignal.timeout, 'undefined');
    assert.equal(typeof AbortSignal.any, 'undefined');
    return await fn();
  } finally {
    if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout);
    if (any) Object.defineProperty(AbortSignal, 'any', any);
  }
}

function abortReason(signal: AbortSignal): Promise<unknown> {
  return new Promise((done) => {
    signal.addEventListener('abort', () => done(signal.reason), { once: true });
  });
}

describe('installAbortSignalFallbacks on an engine without timeout/any', () => {
  it('the digest request shape throws before fetch without it (the production failure)', async () => {
    await onOldEngine(() => {
      assert.throws(() => ({ signal: AbortSignal.timeout(25_000) }), /AbortSignal\.timeout is not a function/);
    });
  });

  it('defines AbortSignal.timeout, which aborts with a TimeoutError after the budget', { timeout: 1_000 }, async () => {
    await onOldEngine(async () => {
      installAbortSignalFallbacks();
      const signal = AbortSignal.timeout(20);
      assert.equal(signal.aborted, false, 'a pre-aborted signal would cancel every request');
      const reason = await abortReason(signal);
      assert.equal((reason as DOMException).name, 'TimeoutError');
    });
  });

  it('defines AbortSignal.any, which follows the first input to abort', { timeout: 1_000 }, async () => {
    await onOldEngine(async () => {
      installAbortSignalFallbacks();
      const a = new AbortController();
      const b = new AbortController();
      const combined = AbortSignal.any([a.signal, b.signal]);
      assert.equal(combined.aborted, false);
      const pending = abortReason(combined);
      b.abort(new Error('second'));
      assert.equal(((await pending) as Error).message, 'second');
      assert.equal(combined.aborted, true);
    });
  });

  it('AbortSignal.any returns an aborted signal when an input is already aborted', async () => {
    await onOldEngine(() => {
      installAbortSignalFallbacks();
      const done = new AbortController();
      done.abort(new Error('earlier'));
      const combined = AbortSignal.any([new AbortController().signal, done.signal]);
      assert.equal(combined.aborted, true);
      assert.equal((combined.reason as Error).message, 'earlier');
    });
  });

  it('AbortSignal.any accepts a timeout signal from the fallback, the most common call shape', { timeout: 1_000 }, async () => {
    await onOldEngine(async () => {
      installAbortSignalFallbacks();
      const combined = AbortSignal.any([new AbortController().signal, AbortSignal.timeout(10)]);
      assert.equal(((await abortReason(combined)) as DOMException).name, 'TimeoutError');
    });
  });

  it('the shared helpers still work once the fallbacks are installed (no recursion)', { timeout: 1_000 }, async () => {
    await onOldEngine(async () => {
      installAbortSignalFallbacks();
      const deadline = createTimeoutSignal(10);
      const combined = combineAbortSignals([new AbortController().signal, deadline]);
      assert.equal(((await abortReason(combined)) as DOMException).name, 'TimeoutError');
    });
  });
});

describe('installAbortSignalFallbacks on a current engine', () => {
  it('leaves native timeout and any untouched', () => {
    const timeout = AbortSignal.timeout;
    const any = AbortSignal.any;
    installAbortSignalFallbacks();
    assert.equal(AbortSignal.timeout, timeout);
    assert.equal(AbortSignal.any, any);
  });
});

/** The module path of each page script referenced by a root HTML entry. */
function entryScripts(): string[] {
  const scripts = new Set<string>();
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(resolve(root, file), 'utf-8');
    for (const match of html.matchAll(/<script[^>]*type="module"[^>]*src="\/(src\/[^"]+\.ts)"/g)) {
      scripts.add(match[1]!);
    }
  }
  return [...scripts].sort();
}

/**
 * The first script import in a module, skipping comments, stylesheets and the
 * Zod CSP bootstrap. deploy-config.test.mjs requires zod-csp to come first in
 * the entries that use it; it and the fallbacks import nothing from each other.
 */
function firstImport(source: string): string | undefined {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
    .map((match) => match[1]!)
    .find((specifier) => !specifier.endsWith('.css') && specifier !== './bootstrap/zod-csp');
}

describe('every page entry installs the fallbacks first', () => {
  const scripts = entryScripts();

  it('finds the page entries', () => {
    // Without this, a broken HTML scan would leave the check below vacuously green.
    assert.ok(scripts.length >= 10, `expected at least 10 entry scripts, found ${scripts.join(', ')}`);
    assert.ok(scripts.includes('src/main.ts'));
  });

  it('reads the first import, ignoring comments', () => {
    assert.equal(firstImport("/** x\n import 'no' */\n// import 'no'\nimport { a } from './b';"), './b');
    assert.equal(firstImport("import './side-effect';\nimport x from 'y';"), './side-effect');
    assert.equal(firstImport("import './a.css';\nimport './bootstrap/zod-csp';\nimport './late';"), './late');
  });

  it('keeps the fallback module free of imports that could run code first', () => {
    // It runs before the app graph, and after zod-csp only by convention:
    // its one import must stay a dependency-free leaf.
    const imports = (file: string) =>
      [...readFileSync(resolve(root, file), 'utf-8').matchAll(/^import\s(?:[^'";]*?\sfrom\s)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(imports('src/bootstrap/abort-signal-fallbacks.ts'), ['@/services/timeout-signal']);
    assert.deepEqual(imports('src/services/timeout-signal.ts'), []);
  });

  it('imports bootstrap/abort-signal-fallbacks before any other module', () => {
    // ES modules evaluate in import order. An earlier import that calls
    // AbortSignal.timeout during its own evaluation would run before the
    // fallback exists.
    const offenders = scripts.filter((script) => {
      const specifier = firstImport(readFileSync(resolve(root, script), 'utf-8'));
      return specifier !== './bootstrap/abort-signal-fallbacks' && specifier !== '@/bootstrap/abort-signal-fallbacks';
    });
    assert.deepEqual(offenders, [], `first import must be './bootstrap/abort-signal-fallbacks' in: ${offenders.join(', ')}`);
  });
});
