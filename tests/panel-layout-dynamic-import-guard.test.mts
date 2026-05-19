import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

// Regression coverage for WORLDMONITOR-R4: dynamic `import(...).then(({ Foo }) => new Foo(...))`
// must guard against the destructured named export resolving to `undefined`, and must attach
// a `.catch()` to avoid an unhandled-rejection event when the browser's module loader returns
// an incomplete module (Safari ESM cache, proxy truncation, etc.).
//
// The two call sites at src/app/panel-layout.ts:1041 (DeductionPanel) and :1059
// (RegionalIntelligenceBoard) are the only ones in the file that use the destructure-and-
// construct pattern; any sibling that adopts the same shape should add the same guards.

// Note: we deliberately do NOT strip comments before grepping — panel-layout.ts contains
// regex literals like `/\/\*.../` that would defeat a naive block-comment stripper. The
// patterns we assert below (literal `import('@/components/Foo').then(...)` with a typeof
// guard inside the callback) won't false-match inside a comment in practice.

// Walk forward from the start of a `.then(arg => { ... })` callback, tracking brace depth,
// and return [openIdx, closeIdx] for the callback body. Lets us assert on the body in
// isolation even when it contains nested `if (...) { ... }` blocks that would defeat a
// lazy `[\s\S]*?` regex.
function findCallbackBody(source: string, callbackHeader: RegExp): { body: string; afterIdx: number } | null {
  const headerMatch = callbackHeader.exec(source);
  if (!headerMatch) return null;
  const openIdx = source.indexOf('{', headerMatch.index + headerMatch[0].length - 1);
  if (openIdx < 0) return null;
  let depth = 1;
  for (let i = openIdx + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(openIdx + 1, i), afterIdx: i + 1 };
    }
  }
  return null;
}

function assertGuardedDynamicImport(source: string, modulePath: string, exportName: string) {
  const callbackHeader = new RegExp(
    `import\\(['"]${modulePath.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\$&')}['"]\\)\\.then\\(\\(\\{\\s*${exportName}\\s*\\}\\)\\s*=>\\s*\\{`,
  );
  const callback = findCallbackBody(source, callbackHeader);
  assert.ok(callback, `${exportName} dynamic import not found at expected call site`);
  assert.match(
    callback.body,
    new RegExp(`typeof\\s+${exportName}\\s*!==?\\s*['"]function['"]\\s*\\)\\s*return`),
    `${exportName} .then() must early-return if the destructured class is not a function`,
  );
  // After the closing `}` of the .then callback, `.catch(` must appear before any
  // newline-then-non-whitespace (i.e. before the next statement in the function body).
  const tail = source.slice(callback.afterIdx, callback.afterIdx + 200);
  assert.match(
    tail,
    /^\s*\)\s*\.catch\(/,
    `${exportName} dynamic import must chain .catch(...) onto its .then(...) callback`,
  );
}

describe('panel-layout dynamic-import guard (WORLDMONITOR-R4)', () => {
  const filePath = new URL('../src/app/panel-layout.ts', import.meta.url);

  it('RegionalIntelligenceBoard import has typeof guard + .catch', async () => {
    const source = await readFile(filePath, 'utf8');
    assertGuardedDynamicImport(source, '@/components/RegionalIntelligenceBoard', 'RegionalIntelligenceBoard');
  });

  it('DeductionPanel import has typeof guard + .catch', async () => {
    const source = await readFile(filePath, 'utf8');
    assertGuardedDynamicImport(source, '@/components/DeductionPanel', 'DeductionPanel');
  });
});
