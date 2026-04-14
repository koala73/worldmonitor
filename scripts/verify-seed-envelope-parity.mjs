#!/usr/bin/env node
// Verify that the three seed-envelope helper files stay in sync.
//
// The source of truth is scripts/_seed-envelope-source.mjs. Two mirrored copies
// live at:
//   - api/_seed-envelope.js            (edge-safe, for api/*.js)
//   - server/_shared/seed-envelope.ts  (TypeScript, for server/ and scripts/)
//
// The TypeScript copy carries additional type declarations, so the check is
// function-by-function: every function exported from the source must appear in
// both copies with identical runtime body (after normalizing TS annotations).
//
// Exit 1 with a diff on drift.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// Parity scope.
//
// Source of truth: scripts/_seed-envelope-source.mjs (plain JS, hand-authored).
// Must-match copy:  api/_seed-envelope.js           (plain JS, hand-authored).
//
// The TypeScript copy at server/_shared/seed-envelope.ts is type-checked by
// `tsc` and reviewed manually. It is NOT diffed here because TS-specific casts
// (`as any`, `as SeedMeta`, etc.) can't be stripped without introducing their
// own bug class. The drift risk on the TS file is mitigated by (a) this header
// comment in that file forbidding direct edits, (b) the typecheck guard, and
// (c) code review. If we ever need stricter enforcement, a separate AST-aware
// comparator can run over the TS file.
const SOURCE = resolve(repoRoot, 'scripts/_seed-envelope-source.mjs');
const EDGE = resolve(repoRoot, 'api/_seed-envelope.js');

/**
 * Extract bare function bodies from a source file, keyed by name.
 * Returns a Map<name, body> where body is the function's implementation with
 * TypeScript type annotations stripped and whitespace normalized.
 *
 * Exported so tests can exercise brace/string edge cases directly.
 */
export function extractFunctions(source) {
  const fns = new Map();
  // Match: export function NAME<generics?>(args): returnType? { body }
  // We capture NAME and the brace-balanced body.
  const pattern = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) != null) {
    const name = match[1];
    const afterParen = match.index + match[0].length;
    // Find matching close paren for args
    // Balance the arg-list parens, skipping string / template / comment bodies.
    // scanBalanced expects `start` to point at (or before) the opening
    // delimiter; `afterParen` is one past it, so step back.
    let i = scanBalanced(source, afterParen - 1, '(', ')');
    // Skip to opening { (may cross return-type annotations that contain `:`).
    while (i < source.length && source[i] !== '{') i++;
    if (i >= source.length) continue;
    // Balance the function body's braces using the same string/comment-aware
    // scanner. Raw `{` inside a string literal like `const marker = '{'` used
    // to drop `depth` past zero and either truncate or overrun the body.
    const bodyStart = i + 1;
    // `i` points at the opening `{`, which is exactly what scanBalanced wants.
    i = scanBalanced(source, i, '{', '}');
    const bodyEnd = i - 1;
    const body = source.slice(bodyStart, bodyEnd);
    // Bodies must be VERBATIM identical across the three files (parity rule).
    // Type annotations are only permitted OUTSIDE function bodies — signatures,
    // top-level interfaces, etc. We compare normalized (whitespace/comments
    // collapsed) bodies but never strip characters from inside them.
    fns.set(name, normalize(body));
  }
  return fns;
}

/**
 * Scan from `start` (which must point AT or just before the opening delimiter),
 * balancing `open`/`close` while skipping characters inside line comments,
 * block comments, and string / template literals. Returns the index one past
 * the matching close delimiter. If input is malformed we return `source.length`
 * so the caller still produces a (truncated) body rather than an infinite loop.
 */
export function scanBalanced(source, start, open, close) {
  let i = start;
  // Align `i` to the opening delimiter if it isn't already.
  while (i < source.length && source[i] !== open) i++;
  if (i >= source.length) return source.length;
  let depth = 1;
  i++;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const c = source.indexOf('*/', i + 2);
      i = c < 0 ? source.length : c + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\' && j + 1 < source.length) { j += 2; continue; }
        // Template-literal interpolation `${ ... }` — recurse to skip matched
        // braces inside the interpolation so an expression like `${{a:1}}`
        // doesn't leak a stray `}` into our outer body balance.
        if (ch === '`' && source[j] === '$' && source[j + 1] === '{') {
          j = scanBalanced(source, j + 1, '{', '}');
          continue;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return i;
}

function normalize(s) {
  return s
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXPECTED_EXPORTS = ['unwrapEnvelope', 'stripSeedEnvelope', 'buildEnvelope'];

async function main() {
  const [sourceSrc, edgeSrc] = await Promise.all([
    readFile(SOURCE, 'utf8'),
    readFile(EDGE, 'utf8'),
  ]);

  const sourceFns = extractFunctions(sourceSrc);
  const edgeFns = extractFunctions(edgeSrc);

  const errors = [];

  for (const name of EXPECTED_EXPORTS) {
    if (!sourceFns.has(name)) errors.push(`source missing export: ${name}`);
    if (!edgeFns.has(name)) errors.push(`api/_seed-envelope.js missing export: ${name}`);
  }

  if (errors.length) {
    console.error('Missing exports:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  for (const name of EXPECTED_EXPORTS) {
    const src = sourceFns.get(name);
    const edge = edgeFns.get(name);
    if (src !== edge) {
      errors.push(`drift: api/_seed-envelope.js::${name} differs from source.\n  source: ${src}\n  edge:   ${edge}`);
    }
  }

  if (errors.length) {
    console.error('Seed-envelope parity check FAILED:');
    for (const e of errors) console.error(`\n  ${e}`);
    process.exit(1);
  }

  console.log('seed-envelope parity: OK (3 exports verified across source + edge). TS mirror checked by tsc.');
}

// isMain guard — only run the verifier when invoked directly as a CLI. Tests
// import this module to exercise extractFunctions/scanBalanced in isolation,
// and running main() on import would trigger process.exit from the test
// process.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  main().catch((err) => {
    console.error('verify-seed-envelope-parity: unexpected error', err);
    process.exit(1);
  });
}
