import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  INTERNAL_FN_TYPES,
  PUBLIC_FN_TYPES,
  convexMissingPublicFunctionPattern,
  listInternalConvexFunctionExports,
  listInternalMissingPublicFunctionPatterns,
  listPublicConvexFunctionExports,
  listConvexFunctionExports,
} from '../scripts/lib/convex-function-exports.mjs';
import {
  LEGACY_TUTORIAL_PROBE_FILTERS,
  PROTECTED_ERROR_MESSAGE_FILTERS,
  assertPublicFunctionsRemainVisible,
  expectedInternalPatternsFromSource,
  formatCommittedFilterList,
  mergeErrorMessageFilters,
  parseCommittedFilterList,
  splitErrorMessageFilters,
} from '../scripts/sync-sentry-convex-probe-filters.mjs';

const REPO_CONVEX = join(process.cwd(), 'convex');

describe('convex-function-exports enumerator', () => {
  it('does not attribute a preceding constant to a later internal factory', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-exports-'));
    try {
      writeFileSync(
        join(root, 'sample.ts'),
        [
          'export const TOUCH_DEBOUNCE_MS = 60_000;',
          'export const onlyInternal = internalQuery({',
          '  args: {},',
          '  handler: async () => null,',
          '});',
          'export const onlyPublic = query({',
          '  args: {},',
          '  handler: async () => null,',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );

      const exports = listConvexFunctionExports(join(root, 'sample.ts'));
      assert.equal(exports.has('TOUCH_DEBOUNCE_MS'), false);
      assert.equal(exports.get('onlyInternal'), 'internalQuery');
      assert.equal(exports.get('onlyPublic'), 'query');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps typed exports whose type annotations contain semicolons', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-typed-exports-'));
    try {
      writeFileSync(
        join(root, 'typed.ts'),
        [
          'type Payload = { a: string; b: number };',
          'export const typedInternal: import("./_generated/server").InternalQuery<',
          '  { args: { id: string }; returns: Payload | null },',
          '  Payload | null',
          '> = internalQuery({',
          '  args: {},',
          '  handler: async (): Promise<Payload | null> => null,',
          '});',
          'export const typedPublic: QueryGeneric<{ x: string; y: number }> = query({',
          '  args: {},',
          '  handler: async () => ({ x: "a", y: 1 }),',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );

      const exports = listConvexFunctionExports(join(root, 'typed.ts'));
      assert.equal(exports.get('typedInternal'), 'internalQuery');
      assert.equal(exports.get('typedPublic'), 'query');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enumerates real convex/ internals and publics as disjoint sets', () => {
    const internals = listInternalConvexFunctionExports(REPO_CONVEX);
    const publics = listPublicConvexFunctionExports(REPO_CONVEX);

    assert.ok(internals.length > 100, `expected many internals, got ${internals.length}`);
    assert.ok(publics.length > 20, `expected several publics, got ${publics.length}`);

    for (const entry of internals) {
      assert.ok(INTERNAL_FN_TYPES.has(entry.factory), entry.factory);
    }
    for (const entry of publics) {
      assert.ok(PUBLIC_FN_TYPES.has(entry.factory), entry.factory);
      assert.notEqual(entry.factory, 'httpAction');
    }

    const internalKeys = new Set(internals.map((e) => `${e.moduleRef}:${e.name}`));
    const publicKeys = new Set(publics.map((e) => `${e.moduleRef}:${e.name}`));
    for (const key of publicKeys) {
      assert.equal(internalKeys.has(key), false, `overlap on ${key}`);
    }
  });
});

describe('sentry convex probe filter merge', () => {
  it('appends generated patterns without dropping protected incumbents', () => {
    const current = [
      ...LEGACY_TUTORIAL_PROBE_FILTERS,
      ...PROTECTED_ERROR_MESSAGE_FILTERS,
    ];
    const generated = [
      "*Could not find public function for 'users:getCurrentUserInternal'*",
      "*Could not find public function for 'alertRules:setAlertRulesForUser'*",
    ];

    const { merged, appended, removed } = mergeErrorMessageFilters(current, generated);

    for (const line of PROTECTED_ERROR_MESSAGE_FILTERS) {
      assert.ok(merged.includes(line), `missing protected ${line}`);
    }
    for (const line of generated) {
      assert.ok(merged.includes(line), `missing generated ${line}`);
    }
    for (const line of LEGACY_TUTORIAL_PROBE_FILTERS) {
      assert.equal(merged.includes(line), false, `legacy survived: ${line}`);
    }
    assert.deepEqual(appended, generated);
    assert.ok(removed.length >= LEGACY_TUTORIAL_PROBE_FILTERS.length);
  });

  it('preserves unrelated non-Convex-probe filter lines', () => {
    const current = [
      'SomeOtherNoise*',
      ...PROTECTED_ERROR_MESSAGE_FILTERS,
    ];
    const generated = ["*Could not find public function for 'entitlements:getEntitlementsByUserId'*"];
    const { merged, preservedOther } = mergeErrorMessageFilters(current, generated);
    assert.deepEqual(preservedOther, ['SomeOtherNoise*']);
    assert.ok(merged.includes('SomeOtherNoise*'));
  });

  it('split/join round-trips newline-joined Sentry option strings', () => {
    const text = `${PROTECTED_ERROR_MESSAGE_FILTERS.join('\n')}\n`;
    const lines = splitErrorMessageFilters(text);
    assert.deepEqual(lines, [...PROTECTED_ERROR_MESSAGE_FILTERS]);
  });
});

describe('sentry convex probe filter safety invariant', () => {
  it('generated patterns cover every internal* and no public function', () => {
    const patterns = expectedInternalPatternsFromSource(REPO_CONVEX);
    const internals = listInternalConvexFunctionExports(REPO_CONVEX);
    assert.equal(patterns.length, internals.length);

    const patternSet = new Set(patterns);
    for (const entry of internals) {
      const expected = convexMissingPublicFunctionPattern(entry.moduleRef, entry.name);
      assert.ok(patternSet.has(expected), expected);
    }

    // Explicit deploy-skew preservation: a public name must not be filtered,
    // including names that exist today and would stop existing after a rename.
    assert.doesNotThrow(() => assertPublicFunctionsRemainVisible(REPO_CONVEX, patterns));
    for (const entry of listPublicConvexFunctionExports(REPO_CONVEX)) {
      const pattern = convexMissingPublicFunctionPattern(entry.moduleRef, entry.name);
      assert.equal(
        patternSet.has(pattern),
        false,
        `public ${entry.moduleRef}:${entry.name} must remain visible`,
      );
    }
  });

  it('committed list parser ignores header comments', () => {
    const patterns = listInternalMissingPublicFunctionPatterns(REPO_CONVEX).slice(0, 3);
    const text = formatCommittedFilterList(patterns);
    assert.match(text, /^# Generated by/);
    assert.deepEqual(parseCommittedFilterList(text), patterns);
  });

  it('detects drift when a new internal export is added without regenerating', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-probe-drift-'));
    try {
      mkdirSync(join(root, 'mod'), { recursive: true });
      writeFileSync(
        join(root, 'mod', 'handlers.ts'),
        [
          'export const hidden = internalMutation({',
          '  args: {},',
          '  handler: async () => null,',
          '});',
          'export const visible = mutation({',
          '  args: {},',
          '  handler: async () => null,',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );

      const patterns = listInternalMissingPublicFunctionPatterns(root);
      assert.deepEqual(patterns, [
        "*Could not find public function for 'mod/handlers:hidden'*",
      ]);

      // Simulating "forgot to regenerate": committed list empty → missing pattern.
      const committed = parseCommittedFilterList('# empty\n');
      const missing = patterns.filter((line) => !committed.includes(line));
      assert.deepEqual(missing, patterns);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
