import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryOf,
  normalizeCompleteEvents,
  pickRendererMainThread,
  computeSelfTimeByName,
  categorize,
  buildDecomposition,
  buildReport,
} from '../scripts/measure-desktop-mainthread.mjs';

// Deterministic fixture (CI-safe, no browser): a CrRendererMain thread (1:1) with
// nested tasks, plus a quieter second CrRendererMain (1:2) that must be excluded.
// Durations in microseconds, mirroring a real Chrome trace.
function fixtureTraceEvents() {
  return [
    { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'CrRendererMain' } },
    { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
    // main thread 1:1 — two top-level RunTasks (scheduler 'other') with nested work
    { ph: 'X', name: 'RunTask', pid: 1, tid: 1, ts: 0, dur: 1000 },
    { ph: 'X', name: 'Layout', pid: 1, tid: 1, ts: 100, dur: 300 },
    { ph: 'X', name: 'UpdateLayoutTree', pid: 1, tid: 1, ts: 150, dur: 100 },
    { ph: 'X', name: 'FunctionCall', pid: 1, tid: 1, ts: 500, dur: 300 },
    { ph: 'X', name: 'RunTask', pid: 1, tid: 1, ts: 1000, dur: 500 },
    { ph: 'X', name: 'MinorGC', pid: 1, tid: 1, ts: 1100, dur: 200 },
    // quieter thread 1:2 — must be filtered out of the main-thread decomposition
    { ph: 'X', name: 'FunctionCall', pid: 1, tid: 2, ts: 0, dur: 50 },
  ];
}

test('categoryOf maps known events and defaults unknowns to other (#4539)', () => {
  assert.equal(categoryOf('FunctionCall'), 'scripting');
  assert.equal(categoryOf('Layout'), 'styleLayout');
  assert.equal(categoryOf('UpdateLayoutTree'), 'styleLayout');
  assert.equal(categoryOf('MinorGC'), 'garbageCollection');
  assert.equal(categoryOf('Paint'), 'paintComposite');
  assert.equal(categoryOf('RunTask'), 'other');
  assert.equal(categoryOf('SomeNativeThingWeDoNotMap'), 'other');
});

test('normalizeCompleteEvents keeps X events and pairs B/E into durations (#4539)', () => {
  const norm = normalizeCompleteEvents([
    { ph: 'X', name: 'Layout', pid: 1, tid: 1, ts: 10, dur: 40 },
    { ph: 'B', name: 'FunctionCall', pid: 1, tid: 1, ts: 100 },
    { ph: 'E', name: 'FunctionCall', pid: 1, tid: 1, ts: 175 },
    { ph: 'I', name: 'Instant', pid: 1, tid: 1, ts: 200 },
    { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'CrRendererMain' } },
  ]);
  assert.equal(norm.length, 2);
  const fn = norm.find((e) => e.name === 'FunctionCall');
  assert.equal(fn.dur, 75, 'B/E pair yields end-start duration');
  assert.ok(norm.some((e) => e.name === 'Layout' && e.dur === 40));
});

test('pickRendererMainThread picks the busiest CrRendererMain (#4539)', () => {
  assert.equal(pickRendererMainThread(fixtureTraceEvents()), '1:1');
});

test('computeSelfTimeByName subtracts nested children from parents (#4539)', () => {
  const main = normalizeCompleteEvents(fixtureTraceEvents()).filter((e) => `${e.pid}:${e.tid}` === '1:1');
  const { byName, total } = computeSelfTimeByName(main);
  assert.equal(byName.get('RunTask'), 700, 'RunTask self = 1000-300-300 (task1) + 500-200 (task2)');
  assert.equal(byName.get('Layout'), 200, 'Layout self = 300 - 100 (UpdateLayoutTree)');
  assert.equal(byName.get('UpdateLayoutTree'), 100);
  assert.equal(byName.get('FunctionCall'), 300);
  assert.equal(byName.get('MinorGC'), 200);
  assert.equal(total, 1500, 'total self = sum of top-level task durations');
});

test('categorize folds names into categories and itemizes other (#4539)', () => {
  const main = normalizeCompleteEvents(fixtureTraceEvents()).filter((e) => `${e.pid}:${e.tid}` === '1:1');
  const { byName } = computeSelfTimeByName(main);
  const { total, byCategory, otherBreakdown } = categorize(byName);
  assert.equal(total, 1500);
  assert.equal(byCategory.other, 700, 'RunTask scheduler self-time is the black box');
  assert.equal(byCategory.styleLayout, 300);
  assert.equal(byCategory.scripting, 300);
  assert.equal(byCategory.garbageCollection, 200);
  assert.equal(byCategory.paintComposite, 0);
  assert.deepEqual(otherBreakdown, [{ name: 'RunTask', amount: 700 }]);
});

test('buildDecomposition reports ms + shares, other cracked open (#4539)', () => {
  const main = normalizeCompleteEvents(fixtureTraceEvents()).filter((e) => `${e.pid}:${e.tid}` === '1:1');
  const { byName } = computeSelfTimeByName(main);
  const decomp = buildDecomposition(byName);
  assert.equal(decomp.mainThreadMs, 1.5);
  const other = decomp.categories.find((c) => c.category === 'other');
  assert.deepEqual(other, { category: 'other', ms: 0.7, pct: 46.7 });
  assert.equal(decomp.categories[0].category, 'other', 'sorted by ms desc');
  assert.deepEqual(decomp.other[0], { name: 'RunTask', ms: 0.7, pct: 46.7 });
});

test('buildReport filters to the main thread and decomposes end to end (#4539)', () => {
  const report = buildReport({ url: 'x', cpu: 1, trace: { traceEvents: fixtureTraceEvents() }, longtasks: [] });
  assert.equal(report.mainThread, '1:1');
  assert.equal(report.mainThreadMs, 1.5, 'the 1:2 FunctionCall is excluded');
  assert.equal(report.categories.find((c) => c.category === 'scripting').ms, 0.3);
});
