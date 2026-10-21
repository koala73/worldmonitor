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

    assert.equal(
      PREMIUM_RPC_PATHS.has('/api/news/v1/summarize-article'),
      false,
      'the path stays out of PREMIUM_RPC_PATHS so translateText remains available to existing free callers',
    );

    let importsPremiumFetch = false;
    let premiumClientForcesPremiumFetch = false;
    let publicClientUsesRawFetch = false;

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
        const parent = node.parent;
        const variableName = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
          ? parent.name.text
          : '';
        const options = node.arguments[1];
        if (variableName === 'premiumNewsClient' && ts.isObjectLiteralExpression(options)) {
          premiumClientForcesPremiumFetch = options.properties.some((property) => {
            if (!ts.isPropertyAssignment(property)) return false;
            return (
              property.name.getText(ast) === 'fetch' &&
              property.initializer.getText(ast).includes('premiumFetch') &&
              property.initializer.getText(ast).includes('forcePremium: true')
            );
          });
        }
        if (variableName === 'newsClient' && ts.isObjectLiteralExpression(options)) {
          publicClientUsesRawFetch = options.properties.some((property) => {
            if (!ts.isPropertyAssignment(property)) return false;
            return (
              property.name.getText(ast) === 'fetch' &&
              property.initializer.getText(ast).includes('globalThis.fetch')
            );
          });
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(ast);

    assert.equal(importsPremiumFetch, true, 'summarization.ts should import premiumFetch');
    assert.equal(premiumClientForcesPremiumFetch, true, 'summary client should force premiumFetch auth');
    assert.equal(publicClientUsesRawFetch, true, 'translation/cache client should keep raw fetch behavior');
  });
});
