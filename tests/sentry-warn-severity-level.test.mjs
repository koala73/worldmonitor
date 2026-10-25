/**
 * Every server capture tagged `severity: 'warn'` must also pass
 * `level: 'warning'`. buildEnvelope (api/_sentry-common.js) reads only
 * `level`; the `severity` tag is a filterable label and never changes the
 * event level, so a warn-intent capture without `level` ships at `error`.
 * WORLDMONITOR-18C: a handled brief-why-matters cache-read timeout (treated
 * as a cache miss) reached Sentry as an error-level issue.
 *
 * Run: node --test tests/sentry-warn-severity-level.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield path;
  }
}

function propertyNamed(objectLiteral, name) {
  return objectLiteral.properties.find((p) => ts.isPropertyAssignment(p)
    && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
}

function stringValue(property) {
  return property && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
}

// Returns the 1-based lines of captureSilentError calls (bare or as a member,
// e.g. deps.captureSilentError) whose options tag severity 'warn' but do not
// pass level 'warning'.
function warnCapturesMissingLevel(fileName, src) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = [];
  let checked = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      const opts = node.arguments[1];
      if (name === 'captureSilentError' && opts && ts.isObjectLiteralExpression(opts)) {
        const tags = propertyNamed(opts, 'tags');
        if (tags && ts.isObjectLiteralExpression(tags.initializer)
          && stringValue(propertyNamed(tags.initializer, 'severity')) === 'warn') {
          checked++;
          if (stringValue(propertyNamed(opts, 'level')) !== 'warning') {
            lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { lines, checked };
}

describe('warn-severity Sentry captures', () => {
  it('detects the shapes a text scan would miss', () => {
    const src = [
      "captureSilentError(new Error('timeout)'), { tags: { severity: 'warn' } });",
      'captureSilentError(err, { tags: { severity: "warn" } });',
      'deps.captureSilentError(err, { tags: { severity: `warn` } });',
      'captureSilentError(err, { level: "warning", tags: { severity: "warn" } });',
      "captureSilentError(err, { tags: { severity: 'info' } });",
      "captureSilentError(err, { tags: { 'severity': 'warn' } });",
      "captureSilentError(err, { 'level': 'warning', tags: { severity: 'warn' } });",
    ].join('\n');
    assert.deepEqual(warnCapturesMissingLevel('fixture.ts', src), { lines: [1, 2, 3, 6], checked: 6 });
  });

  it('pass level: warning alongside the severity: warn tag', () => {
    const offenders = [];
    let checked = 0;
    for (const dir of ['api', 'server']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const result = warnCapturesMissingLevel(file, readFileSync(file, 'utf8'));
        checked += result.checked;
        for (const line of result.lines) offenders.push(`${relative(ROOT, file)}:${line}`);
      }
    }
    assert.ok(checked > 0, 'expected at least one severity: warn capture to check');
    assert.deepEqual(offenders, []);
  });
});
