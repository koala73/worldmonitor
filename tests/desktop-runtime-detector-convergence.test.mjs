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
//   - index.html                       (inline prepaint FOUC detector; it
//     cannot import the module, so it inlines the same signals)
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
  'index.html',
]);

const DESKTOP_RUNTIME_CALL = /(?:^|[^.$\w])isDesktopRuntime\s*\(/m;

function sourceWithoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function hasDesktopRuntimeCall(src) {
  return DESKTOP_RUNTIME_CALL.test(sourceWithoutComments(src));
}

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

function collectTauriHits(rel, src) {
  const hits = [];
  for (const [lineNo, line] of src.split('\n').entries()) {
    if (line.includes('__TAURI')) hits.push(`${rel}:${lineNo + 1}: ${line.trim()}`);
  }
  return hits;
}

describe('desktop-runtime detector convergence (#5912)', () => {
  it('does not treat a comment mention as a call', () => {
    assert.equal(
      hasDesktopRuntimeCall('// if (isDesktopRuntime()) return stored;\nconst x = 1;\n'),
      false,
    );
    assert.equal(
      hasDesktopRuntimeCall('/* isDesktopRuntime() */\nconst x = 1;\n'),
      false,
    );
    assert.equal(
      hasDesktopRuntimeCall("import { isDesktopRuntime } from '@/config/desktop-runtime';\n"),
      false,
    );
    assert.equal(
      hasDesktopRuntimeCall('if (isDesktopRuntime()) return stored;\n'),
      true,
    );
    assert.equal(
      hasDesktopRuntimeCall('enabled: Boolean(dsn) && !isDesktopRuntime(),\n'),
      true,
    );
  });

  it('no raw __TAURI__ sniff outside the detector, the bridge accessor, and prepaint', () => {
    const offending = [];
    for (const file of walk(srcRoot)) {
      const rel = relative(repoRoot, file);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf-8');
      if (src.includes('__TAURI')) offending.push(...collectTauriHits(rel, src));
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
      assert.ok(
        hasDesktopRuntimeCall(src),
        `${rel} no longer calls isDesktopRuntime() — a comment mention is not enough`,
      );
    }
  });

  it('prepaint applies the stored variant on tauri-like hosts and UA, not only globals', () => {
    const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf-8');
    const script = indexHtml.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.match(script, /tauri\.localhost/);
    assert.match(script, /ua\.indexOf\('Tauri'\)/);
    assert.match(script, /proto==='tauri:'/);
    assert.match(script, /worldmonitor-variant/);
  });
});
