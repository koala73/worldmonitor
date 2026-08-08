// Drift check for the seed-envelope helpers + unit coverage for the
// verifier's extractor.
//
// `scripts/verify-seed-envelope-parity.mjs` diffs function bodies between:
//   - scripts/_seed-envelope-source.mjs  (source of truth)
//   - api/_seed-envelope.js              (edge-safe mirror)
//
// Running the verifier in-process fails on drift so CI catches hand-edits to
// api/_seed-envelope.js that the source didn't receive. Additional unit tests
// below cover the extractor's robustness against unbalanced-brace string
// literals, line/block comments, and template-literal interpolation — all
// regressions the verifier's older brace-only counter would have hit.
//
// The TS mirror at server/_shared/seed-envelope.ts is validated by
// `npm run typecheck` and reviewed manually (see header comment in that file).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFunctions, scanBalanced } from '../scripts/verify-seed-envelope-parity.mjs';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const verifier = resolve(here, '..', 'scripts', 'verify-seed-envelope-parity.mjs');

test('seed-envelope parity: source ↔ edge mirror stay in sync', async () => {
  const { stdout, stderr } = await execFileP(process.execPath, [verifier], {
    timeout: 10_000,
  });
  assert.match(stdout, /parity: OK/);
  assert.equal(stderr.trim(), '');
});

// ─── Body extractor: brace/string/comment robustness ───────────────────────

test('extractFunctions: tolerates unbalanced braces inside string literals', () => {
  const src = `
    export function trickyBraces(x) {
      const open = '{';
      const close = '}';
      return open + x + close;
    }
  `;
  const fns = extractFunctions(src);
  // If the brace counter were raw, the '{' inside the string literal would
  // have pushed depth to 2 and the first '}' would have closed back to 1 —
  // body would truncate early. We verify the WHOLE body was captured.
  const body = fns.get('trickyBraces');
  assert.ok(body, 'trickyBraces body should be extracted');
  assert.match(body, /open = '\{'/);
  assert.match(body, /close = '\}'/);
  assert.match(body, /return open \+ x \+ close/);
});

test('extractFunctions: tolerates unbalanced braces inside template literals', () => {
  const src = `
    export function tmpl(a) {
      return \`prefix {\${a}} suffix\`;
    }
  `;
  const fns = extractFunctions(src);
  const body = fns.get('tmpl');
  assert.ok(body);
  assert.match(body, /prefix/);
  assert.match(body, /suffix/);
});

test('extractFunctions: tolerates braces inside block comments', () => {
  const src = `
    export function withComment(x) {
      /* example: { a: 1, b: 2 } */
      return x + 1;
    }
  `;
  const fns = extractFunctions(src);
  const body = fns.get('withComment');
  assert.ok(body);
  assert.match(body, /return x \+ 1/);
});

test('extractFunctions: tolerates braces inside line comments', () => {
  const src = `
    export function withLineComment(x) {
      // sample map: { k: v }
      return x;
    }
  `;
  const fns = extractFunctions(src);
  const body = fns.get('withLineComment');
  assert.ok(body);
  assert.match(body, /return x/);
});

test('scanBalanced: respects escape sequences in strings', () => {
  // Without escape handling, '\\'' would terminate the string early and the
  // following ' would reopen a fresh string, leaving braces afterward
  // miscounted.
  const src = `{ const s = 'a\\'b{'; const t = 'c'; }`;
  const end = scanBalanced(src, 0, '{', '}');
  // end should point just past the final '}'.
  assert.equal(src.slice(end - 1, end), '}');
  assert.equal(end, src.length);
});

test('scanBalanced: template-literal ${} with unbalanced braces inside', () => {
  const src = `{ const x = \`a\${ {a:1} }b\`; }`;
  const end = scanBalanced(src, 0, '{', '}');
  assert.equal(src.slice(end - 1, end), '}');
  assert.equal(end, src.length);
});
