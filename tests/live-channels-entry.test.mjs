import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chunkNameFromFileName } from '../scripts/bundle-budgets.mjs';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './_lib/built-output-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'dist/live-channels.html');

describe('built standalone channel management', { skip: shouldSkipBuiltOutput(htmlPath) }, () => {
  guardBuiltOutput(htmlPath);

  it('does not load dashboard startup or panel bundles via static or dynamic imports', () => {
    const html = readFileSync(htmlPath, 'utf8');
    const entry = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"/)?.[1];
    assert.ok(entry, 'standalone page must have a module entry');
    const visited = new Set();
    function visit(path) {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(path, 'utf8');
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const follow = (specifier) => {
        if (specifier && ts.isStringLiteral(specifier)) {
          visit(resolve(dirname(path), specifier.text));
        }
      };
      function walk(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          follow(node.moduleSpecifier);
        }
        if (
          ts.isCallExpression(node)
          && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length > 0
        ) {
          follow(node.arguments[0]);
        }
        ts.forEachChild(node, walk);
      }
      walk(ast);
    }
    visit(resolve(root, 'dist', entry.replace(/^\//, '')));
    const dashboardChunks = [...visited].filter(path => {
      const name = chunkNameFromFileName(basename(path));
      return name === 'main' || name === 'App' || name === 'panels' || name?.startsWith('panels-');
    });
    assert.deepEqual(dashboardChunks, []);
  });
});
