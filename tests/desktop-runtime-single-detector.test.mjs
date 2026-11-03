import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
const DETECTOR = 'src/config/desktop-runtime.ts';
const SERVICE_REEXPORT = 'src/services/desktop-runtime.ts';

const ALLOWED_RAW_GLOBAL_READERS = new Set([
  DETECTOR,
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

// Config sits below services (scripts/lint-boundaries.mjs), so these two take
// the detector from its config home rather than the services re-export.
const CONFIG_CALL_SITES = ['src/config/variant.ts', 'src/config/basemap.ts'];

/**
 * Every code token that names a bridge global: identifiers (`window.__TAURI__`,
 * `{ __TAURI__?: unknown }`), string and template literals
 * (`'__TAURI__' in window`, `window['__TAURI__']`,
 * `Object.hasOwn(window, '__TAURI__')`, `Reflect.has(globalThis, '__TAURI__')`)
 * and regex literals. Parsing with the TypeScript compiler drops comments as
 * trivia, so prose about the globals is allowed and a `/*` inside a string
 * cannot hide the code after it.
 */
function rawGlobalReads(source, fileName = 'sample.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const hits = [];
  const visit = (node) => {
    if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
        || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node))
      && /__TAURI/.test(node.text)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push(`${fileName}:${line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      yield* walk(absolute);
      continue;
    }
    if (!/\.(?:ts|tsx|js|mjs)$/.test(absolute) || absolute.endsWith('.d.ts')) continue;
    yield absolute;
  }
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf-8');
}

describe('desktop runtime detection has one owner (#5912)', () => {
  it('no client module outside the detector and the bridge reads the Tauri globals by name', () => {
    const offenders = [];
    for (const file of walk(srcRoot)) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (ALLOWED_RAW_GLOBAL_READERS.has(rel)) continue;
      offenders.push(...rawGlobalReads(readFileSync(file, 'utf-8'), rel));
    }
    assert.deepEqual(
      offenders,
      [],
      `these files re-implement desktop detection on the raw bridge globals; call isDesktopRuntime() (or hasExplicitDesktopSignals()) from ${DETECTOR} instead`,
    );
  });

  it('the six formerly split-brained call sites import the shared detector', () => {
    for (const rel of CONVERGED_CALL_SITES) {
      const code = read(rel);
      assert.match(
        code,
        /import \{[^}]*\bisDesktopRuntime\b[^}]*\} from '@\/(?:config|services)\/desktop-runtime';/,
        `${rel} must import isDesktopRuntime from the dependency-free detector, not re-derive it`,
      );
      assert.match(code, /\bisDesktopRuntime\(\)/, `${rel} must actually call isDesktopRuntime()`);
    }
  });

  it('the raw-read scan recognises every shape a bridge-global read can take', () => {
    // Guards the test itself: if the scan silently stopped matching, the first
    // assertion would pass on an unconverged tree.
    for (const sample of [
      // The shapes the six sites used to carry.
      "const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;",
      "if (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window) && swContainer) {}",
      'const hasTauri = Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);',
      "const opts = { enabled: Boolean(dsn) && !('__TAURI_INTERNALS__' in window) };",
      // Bracket access, optional chaining and reflective checks.
      "const a = window['__TAURI__'];",
      'const b = window["__TAURI_INTERNALS__"];',
      "const c = globalThis?.['__TAURI__'];",
      'const d = window[`__TAURI__`];',
      "const e = Object.hasOwn(window, '__TAURI__');",
      "const f = Reflect.has(globalThis, '__TAURI_INTERNALS__');",
      'const g = globalThis.__TAURI_INTERNALS__;',
      // A `/*` inside a string must not swallow the read after it.
      "const h = '/*'; const i = window.__TAURI__; const j = '*/';",
    ]) {
      assert.notDeepEqual(rawGlobalReads(sample), [], sample);
    }
    for (const sample of [
      "import { isDesktopRuntime } from '@/config/desktop-runtime';",
      '// a comment about window.__TAURI__ is prose, not a read',
      "/* '__TAURI_INTERNALS__' in window */ const k = isDesktopRuntime();",
    ]) {
      assert.deepEqual(rawGlobalReads(sample), [], sample);
    }
  });
});

describe('the detector lives in a layer config may import (#5912)', () => {
  it('config modules take the detector from @/config/desktop-runtime', () => {
    for (const rel of CONFIG_CALL_SITES) {
      const code = read(rel);
      assert.match(code, /from '@\/config\/desktop-runtime';/, `${rel} must import the config-layer detector`);
      assert.doesNotMatch(
        code,
        /from '@\/services\//,
        `${rel} is config; importing services reverses the layer direction`,
      );
    }
  });

  it('the services module is a pure re-export of every public detector symbol', () => {
    const detector = ts.createSourceFile(DETECTOR, read(DETECTOR), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const service = ts.createSourceFile(SERVICE_REEXPORT, read(SERVICE_REEXPORT), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

    const isExported = (node) => ts.canHaveModifiers(node)
      && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const detectorExports = new Set();
    for (const statement of detector.statements) {
      if (!isExported(statement)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) detectorExports.add(decl.name.getText(detector));
      } else if (statement.name) {
        detectorExports.add(statement.name.text);
      }
    }
    assert.ok(detectorExports.has('isDesktopRuntime'), `${DETECTOR} must export isDesktopRuntime`);

    const reexported = new Set();
    for (const statement of service.statements) {
      assert.ok(
        ts.isExportDeclaration(statement)
          && statement.moduleSpecifier
          && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === '@/config/desktop-runtime',
        `${SERVICE_REEXPORT} may only re-export from @/config/desktop-runtime; found: ${statement.getText(service)}`,
      );
      assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause), 'use named re-exports');
      for (const element of statement.exportClause.elements) reexported.add(element.name.text);
    }
    assert.deepEqual(
      [...reexported].sort(),
      [...detectorExports].sort(),
      `${SERVICE_REEXPORT} must re-export exactly the detector's public symbols, so existing importers and stubs keep working`,
    );
  });
});
