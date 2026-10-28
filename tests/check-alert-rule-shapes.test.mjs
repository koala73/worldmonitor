/**
 * scripts/check-alert-rule-shapes.mjs walks the paginated internal query
 * `alertRules:listShapeViolations` through `npx convex run` and merges the
 * pages into one report: out-of-shape rows, accounts above the row cap, and
 * bytes per account. These tests drive the pager and the summary with a
 * stubbed runner so no deployment is needed.
 *
 * Run: node --test tests/check-alert-rule-shapes.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectConvexPages, collectConvexRows } from '../scripts/lib/convex-run-pages.mjs';
import { summarizeShapeAudit } from '../scripts/check-alert-rule-shapes.mjs';

function stubRunner(pages) {
  const calls = [];
  const run = (fn, args) => {
    calls.push({ fn, args });
    const index = args.cursor === null ? 0 : Number(args.cursor.replace('c', ''));
    return pages[index];
  };
  return { run, calls };
}

describe('collectConvexPages', () => {
  it('walks continueCursor until isDone and passes base args on every call', () => {
    const { run, calls } = stubRunner([
      { page: [1, 2], continueCursor: 'c1', isDone: false },
      { page: [], continueCursor: 'c2', isDone: false },
      { page: [3], continueCursor: '_end', isDone: true },
    ]);
    assert.deepEqual(collectConvexRows('alertRules:getByEnabled', { enabled: true }, { run }), [1, 2, 3]);
    assert.deepEqual(calls.map((c) => c.args), [
      { enabled: true, cursor: null },
      { enabled: true, cursor: 'c1' },
      { enabled: true, cursor: 'c2' },
    ]);
  });

  it('refuses a non-page result and a cursorless unfinished page', () => {
    assert.throws(() => collectConvexPages('x', {}, { run: () => [1, 2] }), /did not return a page/);
    assert.throws(() => collectConvexPages('x', {}, { run: () => ({ page: [], isDone: false }) }), /no continueCursor/);
  });

  it('stops at maxPages instead of looping on a cursor that never advances', () => {
    assert.throws(
      () => collectConvexPages('x', {}, { run: () => ({ page: [], continueCursor: 'same', isDone: false }), maxPages: 5 }),
      /did not finish within 5 pages/,
    );
  });
});

describe('summarizeShapeAudit', () => {
  const pages = [
    {
      page: [
        { id: 'r1', userId: 'attacker', variant: 'legacy-0', enabled: true, codes: ['VARIANT_INVALID', 'EVENT_TYPES_INVALID'], approxBytes: 900_000 },
        { id: 'r2', userId: 'attacker', variant: 'legacy-1', enabled: true, codes: ['VARIANT_INVALID', 'EVENT_TYPES_INVALID'], approxBytes: 900_000 },
      ],
      rowCounts: { attacker: 4, victim: 1 },
      rulesPerUserMax: 6,
      scanned: 5,
      continueCursor: 'c1',
      isDone: false,
    },
    {
      page: [{ id: 'r9', userId: 'dupes', variant: 'full', enabled: false, codes: ['CHANNELS_INVALID'], approxBytes: 300 }],
      rowCounts: { attacker: 3, dupes: 1 },
      rulesPerUserMax: 6,
      scanned: 4,
      continueCursor: '_end',
      isDone: true,
    },
  ];

  it('merges pages: violations, per-account row counts above the cap, bytes per account', () => {
    const report = summarizeShapeAudit(pages);
    assert.equal(report.scanned, 9);
    assert.equal(report.rulesPerUserMax, 6);
    assert.equal(report.clean, false);
    assert.deepEqual(report.violations.map((v) => v.id), ['r1', 'r2', 'r9']);
    assert.deepEqual(report.overCap, [{ userId: 'attacker', rows: 7 }]);
    assert.deepEqual(report.bytesByUser, { attacker: 1_800_000, dupes: 300 });
  });

  it('is clean when no row is out of shape and no account exceeds the cap', () => {
    const report = summarizeShapeAudit([{ page: [], rowCounts: { victim: 6 }, rulesPerUserMax: 6, scanned: 6, continueCursor: '_end', isDone: true }]);
    assert.equal(report.clean, true);
    assert.deepEqual(report.overCap, []);
  });
});
