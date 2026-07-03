import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

describe('summarize-article premium client wiring', () => {
  it('uses premiumFetch so Pro browser sessions attach Bearer auth', () => {
    const src = readFileSync(resolve(repoRoot, 'src/services/summarization.ts'), 'utf8');
    const ast = ts.createSourceFile('summarization.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    assert.ok(PREMIUM_RPC_PATHS.has('/api/news/v1/summarize-article'));

    let importsPremiumFetch = false;
    let newsClientUsesPremiumFetch = false;

    function visit(node: ts.Node): void {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier.getText(ast) === "'@/services/premium-fetch'" &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        importsPremiumFetch = node.importClause.namedBindings.elements.some(
          (element) => element.name.text === 'premiumFetch',
        );
      }

      if (
        ts.isNewExpression(node) &&
        node.expression.getText(ast) === 'NewsServiceClient' &&
        node.arguments?.length === 2
      ) {
        const options = node.arguments[1];
        if (ts.isObjectLiteralExpression(options)) {
          newsClientUsesPremiumFetch = options.properties.some((property) => {
            if (!ts.isPropertyAssignment(property)) return false;
            return property.name.getText(ast) === 'fetch' && property.initializer.getText(ast) === 'premiumFetch';
          });
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(ast);

    assert.equal(importsPremiumFetch, true, 'summarization.ts should import premiumFetch');
    assert.equal(newsClientUsesPremiumFetch, true, 'NewsServiceClient should be constructed with fetch: premiumFetch');
  });
});
