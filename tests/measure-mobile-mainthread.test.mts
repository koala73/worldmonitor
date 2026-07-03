import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attributeDomNodes,
  buildReport,
  parseArgs,
  rankLongTasks,
  summarizeLcpDebug,
  summarizeLongTasks,
  tbtContribution,
} from '../scripts/measure-mobile-mainthread.mjs';

describe('measure-mobile-mainthread attribution', () => {
  it('tbtContribution subtracts the 50ms floor, clamped at 0', () => {
    assert.equal(tbtContribution(40), 0);
    assert.equal(tbtContribution(50), 0);
    assert.equal(tbtContribution(130), 80);
  });

  it('ranks long tasks by TBT contribution, descending, grouped by source', () => {
    const fixture = [
      { name: 'self', duration: 60, attribution: [{ containerName: 'panels' }] },
      { name: 'self', duration: 200, attribution: [{ containerName: 'Map' }] },
      { name: 'self', duration: 120, attribution: [{ containerName: 'Map' }] },
    ];
    const ranked = rankLongTasks(fixture);
    assert.equal(ranked[0].source, 'Map');
    assert.equal(ranked[0].count, 2);
    assert.equal(ranked[0].tbtMs, 220); // (200-50) + (120-50)
    assert.equal(ranked[0].maxMs, 200);
    assert.equal(ranked[1].source, 'panels');
    assert.equal(ranked[1].tbtMs, 10);
  });

  it('falls back to the entry name when attribution is absent', () => {
    const ranked = rankLongTasks([{ name: 'unattributed', duration: 90 }]);
    assert.equal(ranked[0].source, 'unattributed');
    assert.equal(ranked[0].tbtMs, 40);
  });

  it('summarizeLongTasks counts only tasks over the 50ms floor as long tasks', () => {
    const s = summarizeLongTasks([{ duration: 40 }, { duration: 200 }, { duration: 60 }]);
    assert.equal(s.taskCount, 3);
    assert.equal(s.longTaskCount, 2);
    assert.equal(s.totalMs, 300);
    assert.equal(s.tbtMs, 160); // (200-50) + (60-50)
  });

  it('handles an empty / missing trace without throwing', () => {
    assert.deepEqual(summarizeLongTasks([]), {
      taskCount: 0,
      longTaskCount: 0,
      totalMs: 0,
      tbtMs: 0,
      ranked: [],
    });
    assert.equal(rankLongTasks([]).length, 0);
    assert.equal(rankLongTasks(undefined).length, 0);
    assert.equal(summarizeLongTasks(undefined).taskCount, 0);
  });


  it('summarizes LCP debug candidate and resource groups', () => {
    const summary = summarizeLcpDebug({
      context: { viewport: { width: 360, height: 780 }, devicePixelRatio: 2.63, variant: 'tech', theme: 'dark', visibilityState: 'visible' },
      entries: [{
        context: { viewport: { width: 360, height: 780 }, devicePixelRatio: 2.63, variant: 'tech', theme: 'dark', visibilityState: 'visible' },
        element: { closest: 'map-container', selector: 'section#mapSection', tagName: 'section' },
        resources: [
          { category: 'map-topology', count: 1, encodedBodySize: 1000.4, transferSize: 1200.6 },
          { category: 'feed-digest', count: 1, encodedBodySize: 800, transferSize: 900 },
        ],
        size: 12345,
        startTime: 987.65,
        url: '',
      }],
      resources: [],
    });
    assert.equal(summary.entryCount, 1);
    assert.equal(summary.candidate?.closest, 'map-container');
    assert.equal(summary.candidate?.startTime, 987.7);
    assert.equal(summary.resources[0].category, 'map-topology');
    assert.equal(summary.resources[0].transferSize, 1200.6);
    assert.equal(summary.context?.variant, 'tech');
  });

  it('summarizes missing LCP debug data without throwing', () => {
    const summary = summarizeLcpDebug(null);
    assert.equal(summary.candidate, null);
    assert.equal(summary.entryCount, 0);
    assert.deepEqual(summary.resources, []);
  });

  it('attributeDomNodes computes share percentages and sorts by node count desc', () => {
    const { total, rows } = attributeDomNodes({ total: 1000, mapSvg: 100, panels: 800 });
    assert.equal(total, 1000);
    assert.equal(rows[0].source, 'panels');
    assert.equal(rows[0].sharePct, 80);
    assert.equal(rows[1].source, 'mapSvg');
    assert.equal(rows[1].sharePct, 10);
  });

  it('attributeDomNodes derives total when not provided and tolerates empty input', () => {
    const derived = attributeDomNodes({ mapSvg: 200, panels: 300 });
    assert.equal(derived.total, 500);
    assert.equal(derived.rows[0].source, 'panels');
    assert.deepEqual(attributeDomNodes({}).rows, []);
    assert.deepEqual(attributeDomNodes(undefined).rows, []);
  });

  it('attributeDomNodes honours an explicit total of 0 instead of deriving it', () => {
    // A real page never reports total:0 with non-zero subtrees, but the contract
    // must not silently override an explicit total.
    const { total, rows } = attributeDomNodes({ total: 0, mapSvg: 100 });
    assert.equal(total, 0);
    assert.equal(rows[0].sharePct, 0); // no divide-by-zero
  });
});

describe('parseArgs', () => {
  it('defaults url/cpu/settle/json when no args are given', () => {
    const a = parseArgs(['node', 'script']);
    assert.equal(a.url, 'https://worldmonitor.app/dashboard');
    assert.equal(a.cpu, 4);
    assert.equal(a.settle, 15000);
    assert.equal(a.json, false);
  });

  it('accepts a positional url and flags', () => {
    const a = parseArgs(['node', 'script', 'http://127.0.0.1:4173/dashboard', '--cpu', '6', '--settle', '8000', '--json']);
    assert.equal(a.url, 'http://127.0.0.1:4173/dashboard');
    assert.equal(a.cpu, 6);
    assert.equal(a.settle, 8000);
    assert.equal(a.json, true);
  });

  it('honours --cpu 0 / --settle 0 as real values (not falsy-coerced to default)', () => {
    const a = parseArgs(['node', 'script', '--cpu', '0', '--settle', '0']);
    assert.equal(a.cpu, 0);
    assert.equal(a.settle, 0);
  });

  it('keeps the default when a numeric flag has a missing or non-numeric value', () => {
    assert.equal(parseArgs(['node', 'script', '--cpu']).cpu, 4);
    assert.equal(parseArgs(['node', 'script', '--cpu', 'fast']).cpu, 4);
  });
});

describe('buildReport', () => {
  it('produces a JSON-serializable report from a measure() result', () => {
    const report = buildReport({
      url: 'http://x/dashboard',
      cpu: 4,
      longtasks: [{ duration: 200, attribution: [{ containerName: 'Map' }] }],
      lcpDebug: { entries: [{ element: { closest: 'shell-lcp' }, resources: [], size: 100, startTime: 500 }], resources: [] },
      nodeCounts: { total: 1000, mapSvg: 100, panels: 800 },
    });
    assert.equal(report.url, 'http://x/dashboard');
    assert.equal(report.cpu, 4);
    assert.equal(report.lcp.candidate?.closest, 'shell-lcp');
    assert.equal(report.tasks.tbtMs, 150);
    assert.equal(report.nodes.rows[0].source, 'panels');
    // round-trips cleanly for `--json | jq`
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
  });

  it("decomposes mobile trace self-time into categories and Other events (#4443)", () => {
    const report = buildReport({
      url: "http://x/dashboard",
      cpu: 4,
      trace: {
        traceEvents: [
          { ph: "M", name: "thread_name", pid: 7, tid: 11, args: { name: "CrRendererMain" } },
          { ph: "M", name: "thread_name", pid: 7, tid: 12, args: { name: "CrRendererMain" } },
          { ph: "X", name: "RunTask", pid: 7, tid: 11, ts: 0, dur: 1000 },
          { ph: "X", name: "Layerize", pid: 7, tid: 11, ts: 100, dur: 500 },
          { ph: "X", name: "FunctionCall", pid: 7, tid: 11, ts: 700, dur: 200 },
          { ph: "X", name: "FunctionCall", pid: 7, tid: 12, ts: 0, dur: 50 },
        ],
      },
      longtasks: [],
      nodeCounts: { total: 1000, mapSvg: 100, panels: 800 },
    });

    assert.equal(report.mainThread, "7:11");
    assert.equal(report.mainThreadMs, 1);
    assert.deepEqual(report.categories.find((c) => c.category === "other"), {
      category: "other",
      ms: 0.8,
      pct: 80,
    });
    assert.deepEqual(report.categories.find((c) => c.category === "scripting"), {
      category: "scripting",
      ms: 0.2,
      pct: 20,
    });
    assert.deepEqual(report.other[0], { name: "Layerize", ms: 0.5, pct: 50 });
    assert.deepEqual(report.other[1], { name: "RunTask", ms: 0.3, pct: 30 });
    assert.equal(report.warning, undefined);
  });

  it("refuses trace attribution when CrRendererMain metadata is missing (#4443)", () => {
    const report = buildReport({
      url: "http://x/dashboard",
      cpu: 4,
      trace: { traceEvents: [{ ph: "X", name: "RunTask", pid: 1, tid: 1, ts: 0, dur: 1000 }] },
      longtasks: [{ duration: 80 }],
    });

    assert.equal(report.mainThread, null);
    assert.equal(report.mainThreadMs, 0);
    assert.deepEqual(report.categories, []);
    assert.deepEqual(report.other, []);
    assert.match(report.warning, /no CrRendererMain/);
    assert.equal(report.tasks.longTaskCount, 1);
  });
});
