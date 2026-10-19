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

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield path;
  }
}

// Returns the full argument text of the captureSilentError call enclosing
// `index`, or null when the tag sits outside one.
function enclosingCapture(src, index) {
  const start = src.lastIndexOf('captureSilentError(', index);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i > index ? src.slice(start, i + 1) : null;
  }
  return null;
}

describe('warn-severity Sentry captures', () => {
  it('pass level: warning alongside the severity: warn tag', () => {
    const offenders = [];
    let checked = 0;
    for (const dir of ['api', 'server']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const src = readFileSync(file, 'utf8');
        for (const match of src.matchAll(/severity: 'warn'/g)) {
          const call = enclosingCapture(src, match.index);
          if (call === null) continue;
          checked++;
          if (!/level: 'warning'/.test(call)) {
            const line = src.slice(0, match.index).split('\n').length;
            offenders.push(`${relative(ROOT, file)}:${line}`);
          }
        }
      }
    }
    assert.ok(checked > 0, 'expected at least one severity: warn capture to check');
    assert.deepEqual(offenders, []);
  });
});
