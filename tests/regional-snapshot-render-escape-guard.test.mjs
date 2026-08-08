// Render-side discipline guard for the regional intelligence board.
//
// Issue #3730: snapshot string fields originate in upstream Redis feeds. The
// writer strips angle brackets (see _sanitize.mjs) as defense-in-depth, but
// the PRIMARY control is that every interpolation in the renderer
// (src/components/regional-intelligence-board-utils.ts) is wrapped in
// `escapeHtml`. This test scans the renderer file as text and asserts that
// invariant — if a future PR adds a raw `${snapshot.foo.bar}` interpolation
// inside an HTML template literal without `escapeHtml`, this test fails
// loudly.
//
// HOW TO UPDATE THIS TEST WHEN THE FILE GROWS:
//
//   1. If you legitimately need to add a new interpolated upstream string,
//      wrap it in `escapeHtml(...)` in the renderer — the guard will pass.
//   2. If you add a new value that is provably safe (e.g. a number .toFixed,
//      a hard-coded enum literal, an internal computed string), the regex
//      below may flag it as a false positive. Either:
//        a) compute it into a local `const` outside the template literal so
//           the guard does not see the suspicious shape inside `${...}`, or
//        b) add the literal expression to SAFE_INTERPOLATION_ALLOWLIST below
//           with a one-line comment explaining why it is safe.
//   3. Never add a wholesale `/* eslint-disable */` to bypass the guard —
//      the whole point is to catch drift without relying on reviewers.
//
// Run via: npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'components',
  'regional-intelligence-board-utils.ts',
);

// Field names from snapshot/narrative payloads that carry upstream strings
// and must always be HTML-escaped when interpolated into markup. Matches the
// shape `snapshot.x` / `narrative.y` / `meta.z` / `t.id` / `cp.name` etc.
// Update this list (with intent) only when adding a NEW snapshot string
// field that is interpolated raw. Adding to the list opts out of the guard,
// so prefer wrapping in escapeHtml() instead.
const SUSPECT_FIELD_NAMES = [
  'description',
  'summary',
  'name',
  'title',
  'region',
  'theater',
  'corridor',
  'label',
  'text',
  'mechanism',
  'severity',
  'start',
  'end',
  'previousLabel',
  'transitionDriver',
  'situationRecap',
  'regimeTrajectory',
  'riskOutlook',
  'narrativeProvider',
  'narrativeModel',
  'scoringVersion',
  'geographyVersion',
];

// Expressions inside `${...}` interpolations that are KNOWN safe even though
// they reference one of SUSPECT_FIELD_NAMES. The current matcher only flags
// property-access shapes (`.summary`, `?.summary`, `["summary"]`), so most
// pre-computed locals do not need an allowlist entry. If you DO need to add
// one, include a one-line comment explaining the safety argument.
const SAFE_INTERPOLATION_ALLOWLIST = new Set([
  // Examples (left commented as documentation):
  // 'narrativeSrc', // Pre-computed HTML string built from escapeHtml() pieces.
]);

describe('regional-intelligence-board-utils render discipline', () => {
  const src = readFileSync(RENDERER_PATH, 'utf8');
  const lines = src.split('\n');

  it('imports escapeHtml from the sanitize utility', () => {
    assert.match(
      src,
      /import\s*\{\s*escapeHtml\s*\}\s*from\s*['"]@\/utils\/sanitize['"]/,
      'renderer must import escapeHtml from @/utils/sanitize',
    );
  });

  it('never assigns to innerHTML or outerHTML', () => {
    // The whole point of this builder is to RETURN HTML strings (consumed by
    // Panel.setContent). Direct innerHTML/outerHTML assignment from inside
    // here would bypass any caller-side sanitization layer. Forbid it.
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      assert.ok(
        !/\binnerHTML\s*=/.test(line),
        `line ${i + 1}: direct innerHTML assignment is forbidden in the renderer:\n  ${line.trim()}`,
      );
      assert.ok(
        !/\bouterHTML\s*=/.test(line),
        `line ${i + 1}: direct outerHTML assignment is forbidden in the renderer:\n  ${line.trim()}`,
      );
    }
  });

  it('every ${...} interpolation that references an upstream snapshot string field is wrapped in escapeHtml', () => {
    // For each `${...}` expression in the file, if it references any of the
    // SUSPECT_FIELD_NAMES via property access (`.summary`, `?.summary`,
    // `["summary"]`), assert the expression also calls escapeHtml(.
    //
    // We deliberately exclude interpolations that contain a backtick — those
    // are nested template literals and we want to scan their INNER ${...}s
    // independently, not as one giant blob (which produces noisy substring
    // false positives like `text-transform`).
    //
    // The cost of a false negative (missed XSS) is much higher than the cost
    // of a false positive (developer adds to the allowlist with a comment
    // explaining the safety argument).
    const interpRe = /\$\{([^{}`]+)\}/g;

    const violations = [];
    let match;
    while ((match = interpRe.exec(src)) !== null) {
      const expr = match[1].trim();
      if (!expr) continue;

      // Identify the line for clearer error messages.
      const upto = src.slice(0, match.index);
      const lineNumber = upto.split('\n').length;
      const line = lines[lineNumber - 1] ?? '';

      // Skip if the expression itself is on the safe allowlist.
      if (SAFE_INTERPOLATION_ALLOWLIST.has(expr)) continue;

      // Detect whether the expression references a suspect field name via
      // property access. We require an access form (`.x`, `?.x`, `["x"]`)
      // rather than bare-identifier substring matching so that strings like
      // `text-transform` inside CSS do not produce false positives.
      const referencesSuspect = SUSPECT_FIELD_NAMES.some((field) => {
        const propRe = new RegExp(`(?:\\.|\\?\\.|\\[['"])${field}(?:['"]\\])?\\b`);
        return propRe.test(expr);
      });

      if (!referencesSuspect) continue;

      // Suspect references must be wrapped in escapeHtml(. At least one
      // escapeHtml( appearance in the expression is required.
      if (!/escapeHtml\s*\(/.test(expr)) {
        violations.push(`line ${lineNumber}: \`\${${expr}}\` references a suspect upstream field but is not wrapped in escapeHtml(...). Line:\n  ${line.trim()}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `Render-side escape discipline violations:\n${violations.join('\n')}`,
    );
  });
});
