import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * WORLDMONITOR-100 — `TypeError: n is not a function. (In 'n()', 'n' is
 * undefined)`, Safari, culprit `clearGlobalTenders(assets/main-*)`, Sentry
 * mechanism `auto.browser.global_handlers.onunhandledrejection`.
 *
 * `DataLoader.clearGlobalTenders` ends in a dynamic `import()` whose resolved
 * binding it calls immediately. Its ONLY call site is fire-and-forget —
 * `void this.dataLoader.clearGlobalTenders()` in `src/App.ts`, on the
 * premium->free entitlement transition — so nothing attaches a rejection
 * handler. Any failure in that import therefore escapes as an unhandled
 * rejection instead of degrading a single panel, which is exactly the
 * mechanism Sentry recorded.
 *
 * `src/app/data-loader.ts` cannot be imported under Node (it pulls Vite-only
 * `@/workers/ml.worker?worker` specifiers), so this asserts the guard
 * structurally, over the real parsed AST rather than a regex over source text.
 * The fixture cases below are the anti-vacuity controls: they prove the
 * checker actually discriminates guarded from unguarded, so a broken checker
 * cannot make the production assertion pass by accident.
 */

/** True when `node` sits inside a `try` block without crossing a function boundary. */
function insideTryBlock(node: ts.Node): boolean {
  let prev: ts.Node = node;
  for (let p: ts.Node | undefined = node.parent; p; prev = p, p = p.parent) {
    if (ts.isTryStatement(p) && p.tryBlock === prev) return true;
    // A `try` outside an intervening function does not protect this call: the
    // inner function's rejection is delivered to ITS caller, not to that try.
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

/** Every dynamic `import()` inside the named method, with its guarded-ness. */
function dynamicImportsIn(source: string, methodName: string): { specifier: string; guarded: boolean }[] {
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const found: { specifier: string; guarded: boolean }[] = [];

  const enclosingMethodName = (n: ts.Node): string | null => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) return p.name?.getText() ?? null;
    }
    return null;
  };

  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (enclosingMethodName(n) === methodName) {
        found.push({
          specifier: n.arguments[0]?.getText().replace(/['"]/g, '') ?? '',
          guarded: insideTryBlock(n),
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

describe('AST checker controls (anti-vacuity)', () => {
  it('reports an unguarded dynamic import as unguarded', () => {
    const found = dynamicImportsIn(
      `class C { async m() { const { x } = await import('@/mod'); x(); } }`,
      'm',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].guarded, false);
  });

  it('reports a try-wrapped dynamic import as guarded', () => {
    const found = dynamicImportsIn(
      `class C { async m() { try { const { x } = await import('@/mod'); x(); } catch {} } }`,
      'm',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].guarded, true);
  });

  // The `catch` block is NOT a guard for anything it contains, and a `try` that
  // sits outside an intervening function does not protect the inner call.
  it('does not count a try that is separated by a function boundary', () => {
    const found = dynamicImportsIn(
      `class C { async m() { try { setTimeout(async () => { await import('@/mod'); }); } catch {} } }`,
      'm',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].guarded, false, 'an inner arrow function must not inherit the outer try');
  });
});

describe('clearGlobalTenders cannot reject into the void call site (WORLDMONITOR-100)', () => {
  const loader = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');

  it('guards its dynamic import of @/services/global-tenders', () => {
    const found = dynamicImportsIn(loader, 'clearGlobalTenders');
    assert.equal(found.length, 1, 'expected exactly one dynamic import in clearGlobalTenders');
    assert.equal(found[0].specifier, '@/services/global-tenders');
    assert.equal(
      found[0].guarded,
      true,
      'clearGlobalTenders is called as `void ...()`; an unguarded import() rejection ' +
        'becomes an unhandled rejection (WORLDMONITOR-100)',
    );
  });

  // Pins the premise the guard rests on. If a future refactor gives the call
  // site its own rejection handler, this test's rationale changes and should be
  // re-derived rather than silently kept.
  it('is still invoked fire-and-forget, with no rejection handler', () => {
    const app = readFileSync(resolve(root, 'src/App.ts'), 'utf8');
    assert.match(
      app,
      /void this\.dataLoader\.clearGlobalTenders\(\);/,
      'expected the fire-and-forget call site that makes the guard necessary',
    );
    assert.doesNotMatch(app, /clearGlobalTenders\(\)\s*\.\s*catch/);
  });

  // The user-visible half of the downgrade guarantee must stay ahead of the
  // import, so a swallowed import failure can never leave Pro data on screen.
  it('clears the panel before the guarded import, not after', () => {
    const body = loader.slice(loader.indexOf('async clearGlobalTenders('));
    const end = body.indexOf('\n  async ', 1);
    const method = body.slice(0, end === -1 ? body.length : end);
    assert.ok(
      method.indexOf('procurementPanel?.clear()') < method.indexOf('await import('),
      'the panel clear must run before the import that can fail',
    );
    assert.ok(method.indexOf('this.globalTenderFilters = {}') < method.indexOf('await import('));
  });
});
