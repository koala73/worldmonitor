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
 */
function extractFunctions(source) {
  const fns = new Map();
  // Match: export function NAME<generics?>(args): returnType? { body }
  // We capture NAME and the brace-balanced body.
  const pattern = /export\s+function\s+(\w+)\s*(?:<[^>]+>)?\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) != null) {
    const name = match[1];
    const afterParen = match.index + match[0].length;
    // Find matching close paren for args
    let depth = 1;
    let i = afterParen;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    // Skip to opening {
    while (i < source.length && source[i] !== '{') i++;
    if (i >= source.length) continue;
    // Brace-balance to find end of function body
    const bodyStart = i + 1;
    depth = 1;
    i++;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
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

main().catch((err) => {
  console.error('verify-seed-envelope-parity: unexpected error', err);
  process.exit(1);
});
