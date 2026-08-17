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

/**
 * The single sanctioned exception, and why it cannot be a blanket one.
 *
 * `noopener` (and `noreferrer`, which implies it) makes `window.open` return
 * `null` PER SPEC while still opening the tab. `external-navigation.ts` reads
 * that handle to answer "did it actually open?" — the answer drives the
 * checkout handoff message, the billing-portal outcome, and whether a blocked
 * popup falls back to a same-tab navigation. Passing the features there made
 * every success look like a blocked popup, so one click opened a tab AND
 * navigated the app away (#6137).
 *
 * The exemption is therefore conditional: it holds ONLY while that file still
 * severs the opener itself. `mitigation` is asserted separately below, so if
 * the `opener = null` line is ever dropped this guard goes red rather than
 * silently permitting a real reverse-tabnabbing vector.
 */
const OPENER_SEVERED_MANUALLY = [
  {
    file: 'src/services/external-navigation.ts',
    mitigation: /\bwin\.opener\s*=\s*null\b/,
    reason: 'openWindowWithHandle() needs the handle; it nulls opener instead',
  },
];

describe('window.open reverse-tabnabbing guard', () => {
  it('requires noopener,noreferrer for _blank browser windows', () => {
    const exemptFiles = new Set(OPENER_SEVERED_MANUALLY.map((e) => e.file));
    const unsafe = walkTsFiles(srcDir)
      .flatMap(collectUnsafeWindowOpenCalls)
      .filter((location) => !exemptFiles.has(location.split(':')[0]));
    assert.deepEqual(
      unsafe,
      [],
      `window.open(..., '_blank') calls must pass 'noopener,noreferrer':\n${unsafe.join('\n')}`,
    );
  });

  // Without this, the exemption above degrades into a permanent hole the
  // moment someone edits the helper: the file would keep its pass while no
  // longer doing the thing that earned it.
  it('only exempts a file that still severs opener itself', () => {
    for (const { file, mitigation, reason } of OPENER_SEVERED_MANUALLY) {
      const source = readFileSync(join(root, file), 'utf-8');
      assert.match(
        source,
        mitigation,
        `${file} is exempt from the noopener rule because ${reason} — but the `
          + 'opener-severing line is gone, so the exemption is no longer earned. '
          + 'Restore it, or drop the exemption and pass noopener,noreferrer.',
      );
    }
  });
});
