/**
 * `SITE_VARIANT` must survive storage being unavailable.
 *
 * src/config/variant.ts resolves the active variant at IMPORT time, and
 * essentially every module imports it. An exception thrown while it is being
 * evaluated happens before a single pixel is drawn and takes the whole
 * application down — there is no error boundary early enough to catch it.
 *
 * The subtle part is that `localStorage` does not merely return null when
 * storage is unavailable: the ACCESSOR ITSELF THROWS. That happens in Safari
 * with "Block All Cookies", in a third-party iframe whose storage has been
 * partitioned away, and in some webview privacy modes. The self-hosted branch
 * in variant.ts was written for an OpenEye iframe, which is exactly one of
 * those contexts.
 *
 * Two distinct failure modes, so two tests: `localStorage` missing entirely
 * (node, SSR) and `localStorage` present but hostile.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, '../src/config/variant.ts');
const moduleUrl = pathToFileURL(modulePath).href;

/**
 * Install globals for one import, then put the originals back.
 *
 * `await fn()` matters: an earlier version returned the promise and restored
 * the globals in `finally` before the dynamic import had resolved, so the
 * module evaluated with the REAL environment and every assertion below was
 * vacuously testing the no-window path.
 */
async function withGlobals(values, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value, configurable: true, writable: true, enumerable: true,
    });
  }
  try {
    return await fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Import with a cache-busting query so each case re-evaluates the module. */
function importFresh(tag) {
  return import(`${moduleUrl}?variant-guard=${tag}`);
}

describe('SITE_VARIANT resolution', () => {
  it('resolves when there is no window at all', async () => {
    const mod = await importFresh('no-window');
    assert.equal(typeof mod.SITE_VARIANT, 'string');
    assert.ok(mod.SITE_VARIANT.length > 0);
  });

  it('resolves when localStorage.getItem throws', async () => {
    // Safari "Block All Cookies" and partitioned third-party iframes both
    // throw here rather than returning null.
    const hostileStorage = {
      getItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      setItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    };
    const mod = await withGlobals(
      {
        window: { location: { hostname: '192.168.1.40' } },
        location: { hostname: '192.168.1.40' },
        localStorage: hostileStorage,
      },
      () => importFresh('hostile-storage'),
    );
    assert.equal(typeof mod.SITE_VARIANT, 'string',
      'a throwing localStorage must not take the module down');
    assert.ok(mod.SITE_VARIANT.length > 0);
  });

  it('still honours a stored override when storage works', async () => {
    // The guard must not have turned the feature off along with the crash.
    const mod = await withGlobals(
      {
        window: { location: { hostname: '192.168.1.40' } },
        location: { hostname: '192.168.1.40' },
        localStorage: { getItem: (k) => (k === 'worldmonitor-variant' ? 'tech' : null) },
      },
      () => importFresh('stored-override'),
    );
    assert.equal(mod.SITE_VARIANT, 'tech');
  });

  it('ignores a stored value that is not a real variant', async () => {
    const mod = await withGlobals(
      {
        window: { location: { hostname: '192.168.1.40' } },
        location: { hostname: '192.168.1.40' },
        localStorage: { getItem: () => 'not-a-variant' },
      },
      () => importFresh('bogus-override'),
    );
    assert.notEqual(mod.SITE_VARIANT, 'not-a-variant');
  });

  it('reads storage only through the guarded helper', () => {
    // A future edit that reaches for localStorage directly reintroduces the
    // crash, and it would only show up on a browser nobody tests on.
    const src = readFileSync(modulePath, 'utf-8');
    const reads = [...src.matchAll(/localStorage\s*\./g)];
    assert.equal(reads.length, 1,
      'variant.ts should touch localStorage in exactly one place: storedVariant()');
    const helper = src.slice(src.indexOf('function storedVariant'));
    assert.match(helper.slice(0, 400), /try\s*\{/,
      'the one localStorage read must be inside a try/catch');
  });
});
