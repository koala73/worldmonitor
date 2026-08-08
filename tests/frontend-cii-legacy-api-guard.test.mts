import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(repoRoot, 'src');
const legacyEnginePath = join(srcRoot, 'services', 'country-instability.ts');
const legacyProductApis = new Set([
  'calculateCII',
  'getTopUnstableCountries',
  'getCountryScore',
  'getLearningProgress',
]);

function* walkTypeScriptFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTypeScriptFiles(path);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield path;
    }
  }
}

function lineFor(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

describe('legacy local CII product API guard', () => {
  it('keeps product modules on canonical server-backed CII scores', () => {
    const offenders: string[] = [];

    for (const path of walkTypeScriptFiles(srcRoot)) {
      if (path === legacyEnginePath) continue;

      const source = readFileSync(path, 'utf8');
      // Cheap superset pre-filter: an import of the legacy engine must contain
      // this literal in its module specifier, so files without the substring
      // cannot be offenders. Full TS parsing of all of src/ took ~12 s; only
      // the handful of candidate files need an AST.
      if (!source.includes('country-instability')) continue;
      const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const relativePath = relative(repoRoot, path).replaceAll('\\', '/');

      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && /(?:^|\/)country-instability(?:\.ts)?$/.test(node.moduleSpecifier.text)) {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const specifier of bindings.elements) {
              const importedName = specifier.propertyName?.text ?? specifier.name.text;
              if (legacyProductApis.has(importedName)) {
                offenders.push(`${relativePath}:${lineFor(sourceFile, specifier)} imports ${importedName}`);
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    assert.deepEqual(
      offenders,
      [],
      'product modules must use canonical server-backed CII scores from cached-risk-scores',
    );
  });
});
