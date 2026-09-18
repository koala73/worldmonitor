import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcRoot = join(root, 'src');

/**
 * #5912: two desktop-runtime detectors used to coexist. `isDesktopRuntime()`
 * (VITE_DESKTOP_RUNTIME, bridge globals, UA, tauri:/asset: schemes,
 * *.tauri.localhost, secure loopback) served ~130 call sites, while six files
 * read the raw bridge globals directly. The raw sites answered "web" during
 * `desktop:dev` early boot and in VITE_DESKTOP_RUNTIME=1 browser builds, so
 * SITE_VARIANT ignored the variant the switcher had just stored, the service
 * worker registered inside the desktop shell, and the circuit breaker's
 * offline stale-cache path never engaged.
 *
 * Only two modules may touch the globals by name: the detector itself, and
 * the bridge, which needs the `invoke` function rather than a boolean.
 */
const ALLOWED_RAW_GLOBAL_READERS = new Set([
  'src/services/desktop-runtime.ts',
  'src/services/tauri-bridge.ts',
]);

const CONVERGED_CALL_SITES = [
  'src/config/variant.ts',
  'src/config/basemap.ts',
  'src/main.ts',
  'src/services/push-notifications.ts',
  'src/utils/circuit-breaker.ts',
  'src/bootstrap/sentry-init.ts',
];

// A read of the global, not a mention of it in prose: `'__TAURI__' in window`,
// `window.__TAURI__`, `(window as …).__TAURI__`, `globalThis.__TAURI_INTERNALS__`.
const RAW_GLOBAL_READ = /(?:['"]__TAURI(?:_INTERNALS)?__['"]\s+in\s+\w+)|(?:[\w)\]]\s*\.\s*__TAURI(?:_INTERNALS)?__\b)/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      yield* walk(absolute);
      continue;
    }
    if (!absolute.endsWith('.ts') || absolute.endsWith('.d.ts')) continue;
    yield absolute;
  }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('desktop runtime detection has one owner (#5912)', () => {
  it('no client module outside the detector and the bridge reads the Tauri globals by name', () => {
    const offenders = [];
    for (const file of walk(srcRoot)) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (ALLOWED_RAW_GLOBAL_READERS.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (RAW_GLOBAL_READ.test(code)) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `these files re-implement desktop detection on the raw bridge globals; call isDesktopRuntime() (or hasExplicitDesktopSignals()) from src/services/desktop-runtime.ts instead`,
    );
  });

  it('the six formerly split-brained call sites import the shared detector', () => {
    for (const rel of CONVERGED_CALL_SITES) {
      const code = readFileSync(join(root, rel), 'utf-8');
      assert.match(
        code,
        /import \{[^}]*\bisDesktopRuntime\b[^}]*\} from '@\/services\/desktop-runtime';/,
        `${rel} must import isDesktopRuntime from the dependency-free leaf, not re-derive it`,
      );
      assert.match(code, /\bisDesktopRuntime\(\)/, `${rel} must actually call isDesktopRuntime()`);
    }
  });

  it('the detector regex recognises the shapes the six sites used to carry', () => {
    // Guards the test itself: if the pattern silently stopped matching, the
    // first assertion would pass on an unconverged tree.
    for (const sample of [
      "const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;",
      "if (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window) && swContainer) {",
      'const hasTauri = Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);',
      "enabled: Boolean(dsn) && !('__TAURI_INTERNALS__' in window),",
    ]) {
      assert.match(sample, RAW_GLOBAL_READ, sample);
    }
    assert.doesNotMatch("import { isDesktopRuntime } from '@/services/desktop-runtime';", RAW_GLOBAL_READ);
  });
});
