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
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countSectionAnchors,
  countSectionScriptKeys,
  extractBundleOption,
  extractBundleSections,
  resolveExpr,
  stripLineComments,
} from './helpers/bundle-section-parser.mjs';
import { createTempDir } from './helpers/temp-dir.mjs';

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
  const dir = createTempDir('wm-bundle-parser-');
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  writeFileSync(join(dir, 'seed-thing.mjs'), 'export const THING_TIMEOUT_MS = 300_000;\n');
  const src = "import { THING_TIMEOUT_MS } from './seed-thing.mjs';\n";
  writeFileSync(bundlePath, src);

  assert.equal(resolveExpr(src, 'THING_TIMEOUT_MS', {}, { file: bundlePath }), 300_000);
  // Without the file anchor there is nothing to resolve against.
  assert.equal(resolveExpr(src, 'THING_TIMEOUT_MS'), null);
});

test('resolver: follows a renamed named import', () => {
  const dir = createTempDir('wm-bundle-parser-');
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  writeFileSync(join(dir, 'seed-thing.mjs'), 'export const RAW_MS = 120_000;\n');
  const src = "import { RAW_MS as SECTION_MS } from './seed-thing.mjs';\n";
  writeFileSync(bundlePath, src);
  assert.equal(resolveExpr(src, 'SECTION_MS', {}, { file: bundlePath }), 120_000);
});

test('resolver: a bare package specifier is not followed', () => {
  const dir = createTempDir('wm-bundle-parser-');
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

// ── Anti-vacuity: the script-key count must be independent of the anchor ──

test('a section whose label is not the first key is still counted', () => {
  // The hole a self-comparing check cannot see. The anchor regex requires
  // `{` immediately before `label:`, so this section is invisible to it —
  // and if the gate derived its "nothing was dropped" count from that same
  // regex, both sides would read 0 and the gate would pass on a bundle it
  // never parsed. The independent `script:` count is what catches it.
  const sample = "const S = [{ script: 'seed-a.mjs', label: 'LabelSecond', intervalMs: 1000, timeoutMs: 60_000 }];\n";
  const stripped = stripLineComments(sample);
  assert.equal(countSectionAnchors(stripped), 0, 'anchor regex cannot see this shape');
  assert.equal(extractBundleSections(sample).length, 0, 'extractor cannot see it either');
  assert.equal(countSectionScriptKeys(stripped), 1, 'the independent count must still see it');
});

test('a double-quoted label is parsed rather than silently dropped', () => {
  const sample = 'const S = [{ label: "DoubleQuoted", script: "seed-a.mjs", intervalMs: 1000, timeoutMs: 60_000 }];\n';
  const sections = extractBundleSections(sample);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, 'DoubleQuoted');
  assert.equal(sections[0].script, 'seed-a.mjs');
  assert.equal(sections[0].timeoutMsExpr, '60_000');
  assert.equal(countSectionScriptKeys(stripLineComments(sample)), 1);
});

test('countSectionScriptKeys ignores a script-like key inside a longer name', () => {
  // `postScript:` must not inflate the count, or the gate fails on a healthy
  // bundle — a false alarm is its own kind of broken guard.
  const sample = "const S = [{ label: 'A', script: 'seed-a.mjs', postScript: 'x', intervalMs: 1 }];\n";
  assert.equal(countSectionScriptKeys(stripLineComments(sample)), 1);
});

test('a shorthand or spread timeout is dropped rather than defaulted', () => {
  // Both shapes make the scanner find NO `timeoutMs:` and fall back to the
  // runner's 300s default — a number nobody wrote, and a smaller one than the
  // real 900s, so a budget gate would pass a section that cannot fit.
  const shorthand = "const timeoutMs = 900_000;\nconst S = [{ label: 'A', script: 'seed-a.mjs', intervalMs: 1, timeoutMs }];\n";
  assert.equal(extractBundleSections(shorthand).length, 0, 'shorthand timeout must not be defaulted');
  assert.equal(countSectionScriptKeys(stripLineComments(shorthand)), 1, 'the count still sees it, so the gate fails loudly');

  const spread = "const COMMON = { timeoutMs: 900_000 };\nconst S = [{ label: 'A', script: 'seed-a.mjs', intervalMs: 1, ...COMMON }];\n";
  assert.equal(extractBundleSections(spread).length, 0, 'spread config must not be defaulted');
  assert.equal(countSectionScriptKeys(stripLineComments(spread)), 1);
});

test('a section declaring a nested timeoutMs is dropped rather than mis-read', () => {
  // Reading the FIRST timeoutMs in the block would take the nested retry
  // budget as the section's own — a smaller number that a budget gate would
  // happily pass. Fail closed: drop it so the caller's count check fires.
  const sample = [
    "const S = [{",
    "  label: 'Nested', script: 'seed-a.mjs', intervalMs: 1000,",
    "  retry: { timeoutMs: 500 },",
    "  timeoutMs: 300_000,",
    "}];",
  ].join('\n');
  const stripped = stripLineComments(sample);
  assert.equal(extractBundleSections(sample).length, 0, 'ambiguous timeout must not be guessed');
  assert.equal(countSectionScriptKeys(stripped), 1, 'the count still sees the section, so the gate fails loudly');
});

// ── #6562 item 5: scanner residuals ──────────────────────────────────────

test('stripLineComments: a regex literal containing // is not a line comment', () => {
  // The exact shape from the issue: `const RE = /[//]/` used to truncate the
  // file at the first slash pair, and the count cross-check blamed a
  // commented-out section.
  const src = [
    "const RE = /[//]/;",
    "const N = 5;",
  ].join('\n');
  const out = stripLineComments(src);
  assert.match(out, /\/\[\/\/\]\//, 'the regex literal survives verbatim');
  assert.match(out, /const N = 5;/, 'source after the regex literal survives');
});

test('stripLineComments: division and keyword-prefixed regexes stay intact', () => {
  const src = [
    'const half = 10 / 2 / 1;',
    'function f(s) { return /[//]+$/g.test(s); }',
    "const U = 'https://example.com//path';",
  ].join('\n');
  const out = stripLineComments(src);
  assert.ok(out.includes('10 / 2 / 1'), 'division slashes are untouched');
  assert.ok(out.includes('return /[//]+$/g.test(s)'), 'keyword-prefixed regex survives');
  assert.match(out, /https:\/\/example\.com\/\/path/, 'URL in string survives');
});

test('resolver: follows a named import from a default-plus-named statement', () => {
  // `import def, { X } from './y.mjs'` used to be invisible to the resolver.
  const dir = createTempDir('wm-bundle-parser-');
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  writeFileSync(join(dir, 'seed-thing.mjs'), 'export const THING_MS = 90_000;\n');
  const src = "import defaultThing from './other.mjs';\nimport base, { THING_MS } from './seed-thing.mjs';\n";
  writeFileSync(bundlePath, src);
  assert.equal(resolveExpr(src, 'THING_MS', {}, { file: bundlePath }), 90_000);
});

test('resolver: follows an `export { X } from` re-export', () => {
  const dir = createTempDir('wm-bundle-parser-');
  const bundlePath = join(dir, 'seed-bundle-sample.mjs');
  writeFileSync(join(dir, 'origin.mjs'), 'export const ORIGIN_MS = 45_000;\n');
  writeFileSync(join(dir, 'middle.mjs'), "export { ORIGIN_MS as SHARED_MS } from './origin.mjs';\n");
  const src = "import { SHARED_MS } from './middle.mjs';\n";
  writeFileSync(bundlePath, src);
  assert.equal(resolveExpr(src, 'SHARED_MS', {}, { file: bundlePath }), 45_000);
});

test('extractBundleOption requires a word boundary before the key', () => {
  // Without the boundary, `fooMaxBundleMs:` satisfied a `maxBundleMs` lookup.
  const sample = '], { fooMaxBundleMs: 999_000 });';
  assert.equal(extractBundleOption(sample, 'maxBundleMs'), null);
  const real = '], { maxBundleMs: 570_000 });';
  assert.equal(extractBundleOption(real, 'maxBundleMs'), '570_000');
});
