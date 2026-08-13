// Sanity tests for tests/helpers/bundle-section-parser.mjs — the static
// reader behind the two repo-wide bundle gates
// (tests/seeder-canonical-ttl-vs-cron.test.mjs and
// tests/bundle-budget-admission.test.mjs).
//
// Both gates fail-closed on anything the parser cannot read, so a parser bug
// shows up as a broken build rather than a silent pass. These tests keep it
// honest about the two ways it could quietly under-report: dropping a section
// it cannot brace-balance, and reading configuration out of a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countSectionAnchors,
  extractBundleOption,
  extractBundleSections,
  resolveExpr,
  stripLineComments,
} from './helpers/bundle-section-parser.mjs';

// ── Resolver ─────────────────────────────────────────────────────────────

test('resolver: numeric literal', () => {
  assert.equal(resolveExpr('', '43200'), 43200);
});

test('resolver: numeric literal with underscores (7_200, 86_400)', () => {
  assert.equal(resolveExpr('', '7_200'), 7200);
  assert.equal(resolveExpr('', '86_400'), 86400);
});

test('resolver: simple multiplication', () => {
  assert.equal(resolveExpr('', '35 * 24 * 3600'), 35 * 24 * 3600);
});

test('resolver: preseeded HOUR/DAY/WEEK constants', () => {
  assert.equal(resolveExpr('', '12 * HOUR'), 12 * 3600 * 1000);
  assert.equal(resolveExpr('', '7 * DAY'), 7 * 24 * 3600 * 1000);
  assert.equal(resolveExpr('', 'WEEK'), 7 * 24 * 3600 * 1000);
});

test('resolver: const declared in src (with underscored numeric)', () => {
  const src = 'const TTL_SECONDS = 86_400;\n';
  assert.equal(resolveExpr(src, 'TTL_SECONDS'), 86400);
});

test('resolver: export const declared in src', () => {
  const src = 'export const CACHE_TTL_SECONDS = 2700;\n';
  assert.equal(resolveExpr(src, 'CACHE_TTL_SECONDS'), 2700);
});

test('resolver: const expression mixing identifiers + arithmetic', () => {
  const src = 'const TTL = 35 * 24 * 3600;\n';
  assert.equal(resolveExpr(src, 'TTL'), 35 * 24 * 3600);
});

test('resolver: returns null on unresolvable identifier', () => {
  assert.equal(resolveExpr('', 'COMPLETELY_UNKNOWN'), null);
});

test('resolver: rejects unsafe input', () => {
  assert.equal(resolveExpr('', 'process.env.X'), null);
  assert.equal(resolveExpr('', 'someFunction()'), null);
});

test('resolver: follows a relative named import to a sibling module', () => {
  // seed-bundle-macro.mjs declares its Education section timeout as an
  // imported constant. Without import-following the budget gate cannot read
  // that section at all. The cycle guard must key on the FILE, not its
  // directory, or importing from a sibling in the same folder looks like a
  // self-reference and resolves to null.
  const dir = mkdtempSync(join(tmpdir(), 'wm-bundle-parser-'));
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  writeFileSync(join(dir, 'seed-thing.mjs'), 'export const THING_TIMEOUT_MS = 300_000;\n');
  const src = "import { THING_TIMEOUT_MS } from './seed-thing.mjs';\n";
  writeFileSync(bundlePath, src);

  assert.equal(resolveExpr(src, 'THING_TIMEOUT_MS', {}, { file: bundlePath }), 300_000);
  // Without the file anchor there is nothing to resolve against.
  assert.equal(resolveExpr(src, 'THING_TIMEOUT_MS'), null);
});

test('resolver: follows a renamed named import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-bundle-parser-'));
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  writeFileSync(join(dir, 'seed-thing.mjs'), 'export const RAW_MS = 120_000;\n');
  const src = "import { RAW_MS as SECTION_MS } from './seed-thing.mjs';\n";
  writeFileSync(bundlePath, src);
  assert.equal(resolveExpr(src, 'SECTION_MS', {}, { file: bundlePath }), 120_000);
});

test('resolver: a bare package specifier is not followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-bundle-parser-'));
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  const src = "import { SOME_MS } from 'some-package';\n";
  writeFileSync(bundlePath, src);
  assert.equal(resolveExpr(src, 'SOME_MS', {}, { file: bundlePath }), null);
});

// ── Comment stripping ────────────────────────────────────────────────────

test('stripLineComments: removes line and block comments, keeps string literals', () => {
  const src = [
    "const URL = 'https://example.com/a//b';     // trailing comment",
    '/* block',
    '   comment */',
    'const N = 5;',
  ].join('\n');
  const out = stripLineComments(src);
  assert.match(out, /https:\/\/example\.com\/a\/\/b/, 'a URL inside a string is not a comment');
  assert.doesNotMatch(out, /trailing comment/);
  assert.doesNotMatch(out, /block/);
  assert.match(out, /const N = 5;/);
});

test('a commented-out section is not reported as live configuration', () => {
  // The doc-parity extractor trap: a guard that binds to a commented-out
  // declaration reports on code that does not run.
  const sample = [
    "const SECTIONS = [",
    "  { label: 'Live', script: 'seed-live.mjs', intervalMs: 1000, timeoutMs: 60_000 },",
    "  // { label: 'Retired', script: 'seed-retired.mjs', intervalMs: 1000, timeoutMs: 900_000 },",
    "];",
  ].join('\n');
  const sections = extractBundleSections(sample);
  assert.deepEqual(sections.map((s) => s.label), ['Live']);
  assert.equal(countSectionAnchors(stripLineComments(sample)), 1);
});

test('extractBundleOption ignores a budget quoted in a comment', () => {
  const sample = [
    '// Historically this bundle ran with maxBundleMs: 999_000 before #6556.',
    '], { maxBundleMs: 570_000 });',
  ].join('\n');
  assert.equal(extractBundleOption(sample, 'maxBundleMs'), '570_000');
});

test('extractBundleOption returns null for an unbudgeted bundle', () => {
  assert.equal(extractBundleOption("await runBundle('x', []);\n", 'maxBundleMs'), null);
});

// ── Section extraction ───────────────────────────────────────────────────

test('extractBundleSections: catches sections with intervalMs and timeoutMs', () => {
  const sample = `
const HOUR = 60 * 60 * 1000;
export const SECTIONS = [
  { label: 'A', script: 'seed-a.mjs', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'B', script: 'seed-b.mjs', canonicalKey: 'foo', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
];
`;
  const sections = extractBundleSections(sample);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].label, 'A');
  assert.equal(sections[0].timeoutMsExpr, '120_000');
  assert.equal(sections[1].intervalMsExpr, '12 * HOUR');
  assert.equal(countSectionAnchors(stripLineComments(sample)), 2);
});

test('extractBundleSections: reports a missing timeoutMs as null, not as a default', () => {
  // runBundle falls back to DEFAULT_SECTION_TIMEOUT_MS; the parser must not
  // invent a number, so callers can tell "omitted" from "declared".
  const sample = "const S = [{ label: 'A', script: 'seed-a.mjs', intervalMs: 1000 }];\n";
  assert.equal(extractBundleSections(sample)[0].timeoutMsExpr, null);
});

test('extractBundleSections: handles sections with nested objects (Greptile P2)', () => {
  // Pre-fix the regex `\{ ... \}` non-greedy match would END at the first
  // inner `}` (the close of `{ 'X-Auth': '...' }`), leaving the outer
  // section's `script:` and `intervalMs:` outside the captured block →
  // section silently dropped → real new violation could slip past the guard.
  const sample = `
const HOUR = 60 * 60 * 1000;
export const SECTIONS = [
  {
    label: 'WithNested',
    script: 'seed-with-nested.mjs',
    extraHeaders: { 'X-Auth': 'Bearer xxx', 'Content-Type': 'application/json' },
    intervalMs: 6 * HOUR,
    timeoutMs: 300_000,
  },
];
`;
  const sections = extractBundleSections(sample);
  assert.equal(sections.length, 1, 'section with nested object must be detected');
  assert.equal(sections[0].label, 'WithNested');
  assert.equal(sections[0].script, 'seed-with-nested.mjs');
  assert.equal(sections[0].intervalMsExpr, '6 * HOUR');
});

test('extractBundleSections: handles strings containing braces', () => {
  // Defensive: if a string literal contains `{` or `}`, brace-counting
  // must not be confused.
  const sample = `
const SECTIONS = [
  { label: 'StrWithBrace', script: 'seed-str.mjs', regexFilter: 'foo\\\\{bar}', intervalMs: 1000 },
];
`;
  const sections = extractBundleSections(sample);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].script, 'seed-str.mjs');
  assert.equal(sections[0].intervalMsExpr, '1000');
});

test('countSectionAnchors exceeds parsed sections when one cannot be read', () => {
  // The anti-vacuity contract the budget gate relies on: an anchor the
  // extractor drops must remain visible in the anchor count.
  const sample = "const S = [{ label: 'NoScript', intervalMs: 1000 }];\n";
  assert.equal(extractBundleSections(sample).length, 0);
  assert.equal(countSectionAnchors(stripLineComments(sample)), 1);
});
