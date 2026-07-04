import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = join(root, 'src');

function walkTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function staticStringValue(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isWindowOpenCall(node) {
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'open' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'window';
}

function hasSafeBlankFeatures(node) {
  const target = staticStringValue(node.arguments[1]);
  if (target !== '_blank') return true;
  const features = staticStringValue(node.arguments[2]);
  if (!features) return false;
  const tokens = new Set(features.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean));
  return tokens.has('noopener') && tokens.has('noreferrer');
}

function collectUnsafeWindowOpenCalls(file) {
  const source = readFileSync(file, 'utf-8');
  if (!source.includes('window.open')) return [];
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const unsafe = [];

  function visit(node) {
    if (isWindowOpenCall(node) && !hasSafeBlankFeatures(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      unsafe.push(`${relative(root, file)}:${line + 1}:${character + 1}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return unsafe;
}

describe('window.open reverse-tabnabbing guard', () => {
  it('requires noopener,noreferrer for _blank browser windows', () => {
    const unsafe = walkTsFiles(srcDir).flatMap(collectUnsafeWindowOpenCalls);
    assert.deepEqual(
      unsafe,
      [],
      `window.open(..., '_blank') calls must pass 'noopener,noreferrer':\n${unsafe.join('\n')}`,
    );
  });
});
