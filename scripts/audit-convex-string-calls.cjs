#!/usr/bin/env node
/**
 * audit-convex-string-calls — guard against silent rename / deploy mismatch
 * for Convex function calls that bypass TypeScript.
 *
 * String-cast call sites (`client.mutation('X:Y' as any, ...)` or
 * `(api as any).X.Y`) compile cleanly even when `convex/X.ts` no longer
 * exports `Y`. The runtime then produces "Could not find public function
 * for 'X:Y'" — indistinguishable in Sentry from external scanner noise
 * (WORLDMONITOR-QN/QQ/QS/QT/QV/QW/QX/QY triage 2026-05-09 surfaced this
 * risk: scanners probing non-existent function names look identical to
 * a real first-party rename bug).
 *
 * This script grep-extracts every string-form Convex call from `api/` +
 * `src/`, resolves it back to a file in `convex/`, and asserts that the
 * named export exists AND is a PUBLIC type (`query` / `mutation` /
 * `action` — not `internalQuery` / `internalMutation` / `internalAction`,
 * which would also fail at runtime). Exit non-zero on any mismatch so
 * the build / pre-push / CI catches stealth renames before they ship.
 *
 * Path conventions (Convex):
 *   - Single-file:  convex/foo.ts        → call as 'foo:bar'
 *   - Nested path:  convex/foo/baz.ts    → call as 'foo/baz:bar'
 *
 * Patterns audited:
 *   1. client.query('module:fn'        client.mutation('module:fn'
 *      client.action('module:fn'       (incl. `as any` casts)
 *   2. (api as any).module.fn          (api as any).nested.path.fn
 *
 * NOT audited:
 *   - Typed `api.module.fn` references — TypeScript catches those at
 *     build time. Only the type-erased forms (string + any-cast) need
 *     the runtime guard.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['api', 'src'];
const CONVEX_DIR = path.join(REPO_ROOT, 'convex');

const PUBLIC_FN_TYPES = new Set(['query', 'mutation', 'action', 'httpAction']);
const INTERNAL_FN_TYPES = new Set(['internalQuery', 'internalMutation', 'internalAction']);

/** Walk a directory tree and yield every .ts/.tsx file path. */
function* walkTs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '_generated') continue;
    if (entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(p);
    else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      yield p;
    }
  }
}

/**
 * Find every `export const <name> = (query|mutation|action|httpAction|internal*)({`
 * in a Convex source file. Tolerates type annotations including generic
 * defaults that contain `=` (e.g. `Foo<T = unknown>`):
 *   export const foo = mutation({...
 *   export const foo: MutationDefinition<...> = mutation({...
 *   export const foo: SomeType<T = unknown> = query({...
 *
 * Strategy: anchor on the right-hand side `= factoryName(` and walk
 * backwards from there to grab the export name. This sidesteps the
 * naive `[^=]+` annotation matcher's failure on generic defaults
 * (greptile P2 review on PR #3634).
 */
function listExports(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const exports = new Map();
  // Lazy match between `export const NAME` and the factory call site.
  // Regex engines backtrack until `\s*\(` succeeds, so an inner `=`
  // inside a generic default (e.g. `Foo<T = unknown>`) is naturally
  // skipped because `unknown` isn't followed by `(` — the engine then
  // tries the NEXT `=` until it finds one followed by `factoryName(`.
  // Works without an explicit factory allowlist; the type-filter below
  // does that job.
  const re = /export\s+const\s+(\w+)\b[\s\S]*?=\s*(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, name, factory] = m;
    if (PUBLIC_FN_TYPES.has(factory) || INTERNAL_FN_TYPES.has(factory)) {
      exports.set(name, factory);
    }
  }
  return exports;
}

/**
 * Resolve a Convex `module:fn` reference (or `nested/path:fn`) to an
 * absolute file path. Convex resolves `foo` to `foo.ts`, `foo/bar` to
 * `foo/bar.ts`, `foo.bar` to `foo/bar.ts` (dot-form is also accepted by
 * the runtime).
 */
function resolveModuleFile(moduleRef) {
  const segments = moduleRef.split(/[/.]/).filter(Boolean);
  if (segments.length === 0) return null;
  const candidate = path.join(CONVEX_DIR, ...segments) + '.ts';
  return fs.existsSync(candidate) ? candidate : null;
}

/** Collected violations across all scanned files. */
const violations = [];

/**
 * Audit one `module:fn` reference at a given source location.
 * Pushes a violation if the reference doesn't resolve to a public export.
 */
function auditReference({ moduleRef, fnName, sourceFile, sourceLine, callShape }) {
  const moduleFile = resolveModuleFile(moduleRef);
  if (!moduleFile) {
    violations.push({
      sourceFile, sourceLine, callShape,
      reason: `Module not found: convex/${moduleRef.replace(/\./g, '/')}.ts`,
      ref: `${moduleRef}:${fnName}`,
    });
    return;
  }
  const exports = listExports(moduleFile);
  const factory = exports.get(fnName);
  if (!factory) {
    violations.push({
      sourceFile, sourceLine, callShape,
      reason: `Module exists but no export named '${fnName}'. Available exports: ${[...exports.keys()].join(', ') || '(none)'}`,
      ref: `${moduleRef}:${fnName}`,
    });
    return;
  }
  if (INTERNAL_FN_TYPES.has(factory)) {
    violations.push({
      sourceFile, sourceLine, callShape,
      reason: `'${fnName}' is ${factory} (not callable from outside Convex). Only query/mutation/action/httpAction are callable from edge / browser.`,
      ref: `${moduleRef}:${fnName}`,
    });
  }
}

/**
 * Scan one source file for type-erased Convex call sites and audit each.
 *
 * Two patterns:
 *
 * (a) String form. Captures the literal name passed to client.X(...):
 *       client.query('userPreferences:getPreferences' as any, ...)
 *       client.mutation("foo/bar:baz", { ... })
 *
 * (b) `as any` form on a typed `api` reference:
 *       (api as any).apiKeys.listApiKeys
 *       (api as any).foo.bar.baz   →  module='foo/bar', fn='baz'
 */
function scanFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(REPO_ROOT, filePath);
  const lines = src.split('\n');

  // (a) Pattern: client.<rpc>('module:fn'  | client.<rpc>("module:fn"
  const reString = /client\.(?:query|mutation|action)\s*\(\s*['"]([\w/.]+):(\w+)['"]/g;
  let m;
  while ((m = reString.exec(src)) !== null) {
    const lineIdx = src.slice(0, m.index).split('\n').length;
    auditReference({
      moduleRef: m[1],
      fnName: m[2],
      sourceFile: rel,
      sourceLine: lineIdx,
      callShape: lines[lineIdx - 1].trim(),
    });
  }

  // (b) Pattern: (api as any).<segment>(.<segment>)+
  // The LAST segment is the function name; preceding segments form the module path.
  //
  // Scoped to files that consume the Convex `api` binding. Otherwise any
  // unrelated `api` object (REST clients, OpenAPI clients, Tauri IPC
  // `window.api`) cast through `any` would produce a spurious
  // "Module not found" violation against convex/. Greptile P2 review on
  // PR #3634. Signals (any one is sufficient):
  //   - direct generated-api import (`_generated/api`)
  //   - convex-client helper import (`getConvexApi` / `getConvexClient` /
  //     `convex-client` path)
  //   - the file already uses string-form Convex client calls
  //     (`client.query(` / `client.mutation(` / `client.action(`)
  const importsConvexApi =
    /_generated\/api\b/.test(src)
    || /\b(getConvexApi|getConvexClient)\b/.test(src)
    || /\bconvex-client\b/.test(src)
    || /\bclient\.(?:query|mutation|action)\s*\(/.test(src);
  if (importsConvexApi) {
    const reAsAny = /\(\s*api\s+as\s+any\s*\)((?:\.\w+)+)/g;
    while ((m = reAsAny.exec(src)) !== null) {
      const lineIdx = src.slice(0, m.index).split('\n').length;
      const segments = m[1].split('.').filter(Boolean);
      if (segments.length < 2) continue; // need at least module.fn
      const fnName = segments.pop();
      const moduleRef = segments.join('/');
      auditReference({
        moduleRef,
        fnName,
        sourceFile: rel,
        sourceLine: lineIdx,
        callShape: lines[lineIdx - 1].trim(),
      });
    }
  }
}

// Run
for (const dir of SCAN_DIRS) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walkTs(abs)) scanFile(file);
}

if (violations.length === 0) {
  console.log('audit-convex-string-calls: PASS — every type-erased Convex call resolves to a public export.');
  process.exit(0);
}

console.error(`audit-convex-string-calls: ${violations.length} violation(s) found.\n`);
for (const v of violations) {
  console.error(`  ${v.sourceFile}:${v.sourceLine}  →  ${v.ref}`);
  console.error(`    ${v.reason}`);
  console.error(`    ${v.callShape}`);
  console.error('');
}
console.error(
  'These are type-erased Convex calls (`as any` or string form) that bypass TypeScript.\n' +
  'A renamed/removed function in convex/ produces "Could not find public function for ..."\n' +
  'at runtime — looks identical to scanner noise in Sentry. Update the call site to match\n' +
  'the current convex/ source, or remove the type erasure so TS catches the next rename.\n',
);
process.exit(1);
