// #5912 — one desktop-runtime detector, no raw __TAURI__ sniffs.
//
// Two detectors used to coexist and disagree: isDesktopRuntime()
// (src/config/desktop-runtime.ts) answers "is this the desktop product?"
// from env flag + globals + UA + tauri-like origins, while six call sites
// sniffed the raw bridge globals — which are ABSENT during desktop:dev early
// boot and in VITE_DESKTOP_RUNTIME=1 browser builds. Concrete split-brain:
// SITE_VARIANT resolved on the raw check while the variant switcher wrote
// the stored variant on isDesktopRuntime().
//
// This locks the convergence: the token __TAURI may appear ONLY in
//   - src/config/desktop-runtime.ts    (the detector itself)
//   - src/services/tauri-bridge.ts     (the IPC accessor: it does not ask
//     "is this the desktop?", it reads window.__TAURI__.core.invoke — the
//     one legitimate "is the bridge attached RIGHT NOW?" consumer)
// Anywhere else, use isDesktopRuntime() (or detectDesktopRuntime with an
// explicit probe). A new raw sniff reintroduces the early-boot split-brain.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const srcRoot = join(repoRoot, 'src');

const ALLOWED = new Set([
  'src/config/desktop-runtime.ts',
  'src/services/tauri-bridge.ts',
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated') continue; // codegen output, not hand-written call sites
      yield* walk(full);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('desktop-runtime detector convergence (#5912)', () => {
  it('no raw __TAURI__ sniff outside the detector and the bridge accessor', () => {
    const offending = [];
    for (const file of walk(srcRoot)) {
      const rel = relative(repoRoot, file);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf-8');
      if (src.includes('__TAURI')) {
        for (const [lineNo, line] of src.split('\n').entries()) {
          if (line.includes('__TAURI')) offending.push(`${rel}:${lineNo + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offending,
      [],
      'raw __TAURI__ checks found outside the allow-list — use isDesktopRuntime() ' +
        '(src/config/desktop-runtime.ts) instead; it stays true during desktop:dev ' +
        `early boot and in VITE_DESKTOP_RUNTIME=1 browser builds:\n${offending.join('\n')}`,
    );
  });

  it('keeps the canonical detector in a layer config modules may import', () => {
    const variant = readFileSync(join(repoRoot, 'src/config/variant.ts'), 'utf-8');
    const basemap = readFileSync(join(repoRoot, 'src/config/basemap.ts'), 'utf-8');
    const serviceCompatibility = readFileSync(join(repoRoot, 'src/services/desktop-runtime.ts'), 'utf-8');

    assert.match(variant, /from ['"]@\/config\/desktop-runtime['"]/);
    assert.match(basemap, /from ['"]@\/config\/desktop-runtime['"]/);
    assert.match(serviceCompatibility, /from ['"]@\/config\/desktop-runtime['"]/);
    assert.doesNotMatch(serviceCompatibility, /function (?:detect|is)DesktopRuntime/);
  });

  it('the previously split-brained call sites resolve through isDesktopRuntime', () => {
    const CONVERGED = [
      'src/config/variant.ts',
      'src/config/basemap.ts',
      'src/main.ts',
      'src/services/push-notifications.ts',
      'src/utils/circuit-breaker.ts',
      'src/bootstrap/sentry-init.ts',
    ];
    for (const rel of CONVERGED) {
      const src = readFileSync(join(repoRoot, rel), 'utf-8');
      assert.match(
        src,
        /isDesktopRuntime/,
        `${rel} no longer calls isDesktopRuntime() — if desktop detection moved, update this list`,
      );
    }
  });
});
