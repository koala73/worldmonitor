import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReport,
  classifyRenderAxisEvent,
  compareReports,
  extractStackFrames,
  isForcedReflow,
  normalizeReport,
  parseArgs,
  summarizeForcedReflows,
  summarizeTraceEvents,
} from '../scripts/measure-dashboard-render-axis.mjs';

describe('measure-dashboard-render-axis trace parsing', () => {
  it('classifies render-axis events by Chrome trace name', () => {
    assert.equal(classifyRenderAxisEvent('Layout'), 'styleLayout');
    assert.equal(classifyRenderAxisEvent('UpdateLayoutTree'), 'styleLayout');
    assert.equal(classifyRenderAxisEvent('Paint'), 'rendering');
    assert.equal(classifyRenderAxisEvent('EvaluateScript'), 'scriptEvaluation');
    assert.equal(classifyRenderAxisEvent('LayoutShift'), null);
  });

  it('summarizes style/layout, rendering, script, and estimated TBT durations', () => {
    const summary = summarizeTraceEvents({
      traceEvents: [
        { ph: 'X', name: 'Layout', dur: 4000 },
        { ph: 'X', name: 'Paint', dur: 2000 },
        { ph: 'X', name: 'EvaluateScript', dur: 6000 },
        { ph: 'X', name: 'RunTask', dur: 90000 },
        { ph: 'I', name: 'Layout', dur: 100000 },
      ],
    });

    assert.equal(summary.eventCount, 5);
    assert.equal(summary.durationMs.styleLayout, 4);
    assert.equal(summary.durationMs.rendering, 2);
    assert.equal(summary.durationMs.scriptEvaluation, 6);
    assert.equal(summary.durationMs.topLevelTasks, 90);
    assert.equal(summary.durationMs.estimatedTbt, 40);
    assert.equal(summary.sharePct.styleLayoutOfAccounted, 33.3);
  });

  it('extracts and ranks explicitly forced reflow stacks', () => {
    const events = [
      {
        ph: 'X',
        name: 'Layout',
        dur: 8000,
        args: { beginData: { forcedLayout: true, stackTrace: [{ functionName: 'renderMap', url: 'src/components/Map.ts', lineNumber: 100 }] } },
      },
      {
        ph: 'X',
        name: 'UpdateLayoutTree',
        dur: 2000,
        args: { data: { forcedReflow: true, stackTrace: [{ functionName: 'hydratePanel', url: 'src/app/panel-layout.ts', lineNumber: 50 }] } },
      },
      { ph: 'X', name: 'Paint', dur: 1000 },
    ];

    assert.deepEqual(extractStackFrames(events[0]).slice(0, 1), ['renderMap (src/components/Map.ts:100)']);
    const forced = summarizeForcedReflows(events);
    assert.equal(forced.eventCount, 2);
    assert.equal(forced.totalMs, 10);
    assert.equal(forced.stacks[0].topFrame, 'renderMap (src/components/Map.ts:100)');
    assert.equal(forced.stacks[0].totalMs, 8);
  });

  it('attributes real-capture forced reflows: Layout/UpdateLayoutTree events that carry a JS stack', () => {
    // Real Chrome traces (disabled-by-default-devtools.timeline.stack category)
    // do NOT flag forced reflows; instead a JS-forced synchronous layout is a
    // Layout/UpdateLayoutTree event that CARRIES the forcing stack. This mirrors
    // the #5049 /dashboard capture where flashLocation()'s readContainerSize()
    // forced hundreds of base-map layouts.
    const forced = summarizeForcedReflows([
      {
        ph: 'X',
        name: 'Layout',
        dur: 8000,
        args: { beginData: { stackTrace: [
          { functionName: 'readContainerSize', url: 'https://x/assets/Map.js', lineNumber: 62, columnNumber: 5478 },
          { functionName: 'flashLocation', url: 'https://x/assets/Map.js', lineNumber: 67 },
        ] } },
      },
      {
        ph: 'X',
        name: 'UpdateLayoutTree',
        dur: 2000,
        args: { data: { stackTrace: [{ functionName: 'measureLabelVisibility', url: 'https://x/assets/Map.js', lineNumber: 67 }] } },
      },
    ]);

    assert.equal(forced.eventCount, 2);
    assert.equal(forced.totalMs, 10);
    assert.match(forced.stacks[0].topFrame, /readContainerSize/);
    assert.equal(forced.stacks[0].totalMs, 8);
    // Every name in FORCED_LAYOUT_NAMES is a forced reflow when it carries a stack.
    assert.equal(isForcedReflow({ name: 'Layout', args: { beginData: { stackTrace: [{ functionName: 'readContainerSize' }] } } }), true);
    assert.equal(isForcedReflow({ name: 'RecalculateStyles', args: { beginData: { stackTrace: [{ functionName: 'f' }] } } }), true);
    assert.equal(isForcedReflow({ name: 'Blink.UpdateLayout', args: { data: { stackTrace: [{ functionName: 'g' }] } } }), true);
  });

  it('excludes scheduled (end-of-frame) style/layout events that carry no JS stack', () => {
    const forced = summarizeForcedReflows([
      { ph: 'X', name: 'Layout', dur: 8000 },
      { ph: 'X', name: 'UpdateLayoutTree', dur: 2000, args: { beginData: {} } },
    ]);

    assert.equal(forced.eventCount, 0);
    assert.equal(forced.totalMs, 0);
    assert.deepEqual(forced.stacks, []);
    assert.equal(isForcedReflow({ name: 'Layout', dur: 8000 }), false);
    // An explicitly annotated event is forced regardless of name/stack (all
    // three synonyms), for synthetic fixtures and traces that flag the event.
    assert.equal(isForcedReflow({ name: 'X', args: { data: { isForced: true } } }), true);
    assert.equal(isForcedReflow({ name: 'X', args: { beginData: { forcedLayout: true } } }), true);
  });

  it('aggregates stackless Blink.ForcedStyleAndLayout markers separately as a fallback signal', () => {
    // These markers report the aggregate forced style+layout TIME but carry no
    // call site, so they must not pollute the attributed-stack ranking — they
    // are reported as markerCount/markerTotalMs for captures without the stack
    // category (the old detector wrongly bucketed all of these as one reflow).
    const forced = summarizeForcedReflows([
      { ph: 'X', name: 'Blink.ForcedStyleAndLayout.UpdateTime', dur: 4000 },
      { ph: 'X', name: 'Blink.ForcedStyleAndLayout.UpdateTime', dur: 2000 },
      { ph: 'X', name: 'Blink.ForcedStyleAndLayout', dur: 1000 },
    ]);

    assert.equal(forced.eventCount, 0);
    assert.deepEqual(forced.stacks, []);
    assert.equal(forced.markerCount, 3);
    assert.equal(forced.markerTotalMs, 7);
  });

  it('handles missing trace data with warnings instead of throwing', () => {
    const summary = summarizeTraceEvents(null);
    assert.equal(summary.eventCount, 0);
    assert.equal(summary.durationMs.styleLayout, 0);
    assert.deepEqual(summary.forcedReflows.stacks, []);
    assert.deepEqual(summary.warnings, ['No trace events found.']);
  });
});

describe('measure-dashboard-render-axis reporting', () => {
  it('builds a JSON-safe report from capture results', () => {
    const report = buildReport({
      url: 'http://127.0.0.1:4173/dashboard',
      generatedAt: '2026-06-30T00:00:00.000Z',
      viewport: { width: 1365, height: 768 },
      settleMs: 1000,
      tracePath: '/tmp/trace.json',
      traceEvents: [{ ph: 'X', name: 'Layout', dur: 1500 }],
    });

    assert.equal(report.url, 'http://127.0.0.1:4173/dashboard');
    assert.equal(report.viewport.width, 1365);
    assert.equal(report.tracePath, '/tmp/trace.json');
    assert.equal(report.durationMs.styleLayout, 1.5);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
  });

  it('normalizes raw trace files before comparison', () => {
    const report = normalizeReport({
      url: 'http://127.0.0.1:4175/dashboard',
      tracePath: '/tmp/raw-trace.json',
      traceEvents: [
        { ph: 'X', name: 'Layout', dur: 1000 },
        { ph: 'X', name: 'Paint', dur: 2000 },
      ],
    });

    assert.equal(report.url, 'http://127.0.0.1:4175/dashboard');
    assert.equal(report.tracePath, '/tmp/raw-trace.json');
    assert.equal(report.durationMs.styleLayout, 1);
    assert.equal(report.durationMs.rendering, 2);
    assert.equal(report.forcedReflows.eventCount, 0);
  });

  it('compares before/after reports with absolute and relative deltas', () => {
    const comparison = compareReports(
      { url: 'before', durationMs: { styleLayout: 100, rendering: 20, scriptEvaluation: 10, estimatedTbt: 50 }, forcedReflows: { eventCount: 4, totalMs: 246, markerCount: 0, markerTotalMs: 0 } },
      { url: 'after', durationMs: { styleLayout: 60, rendering: 15, scriptEvaluation: 11, estimatedTbt: 35 }, forcedReflows: { eventCount: 1, totalMs: 171, markerCount: 0, markerTotalMs: 0 } },
    );

    assert.equal(comparison.deltaMs.styleLayout, -40);
    assert.equal(comparison.deltaPct.styleLayout, -40);
    assert.equal(comparison.deltaMs.estimatedTbt, -15);
    assert.equal(comparison.forcedReflowEvents.delta, -3);
    // The ≤200ms #4487 acceptance target tracks attributed forced-reflow ms.
    assert.equal(comparison.forcedReflowMs.before, 246);
    assert.equal(comparison.forcedReflowMs.after, 171);
    assert.equal(comparison.forcedReflowMs.delta, -75);
    assert.deepEqual(comparison.warnings, []);
  });

  it('treats legacy summary-only forcedReflows.totalMs as marker fallback', () => {
    // Older stored summaries had durationMs but no raw traceEvents/marker fields,
    // and their forcedReflows.totalMs came from Blink.ForcedStyleAndLayout markers.
    // Do not compare that old stackless marker total as attributed forced-reflow ms.
    const comparison = compareReports(
      { url: 'before', durationMs: { styleLayout: 100 }, forcedReflows: { eventCount: 4, totalMs: 460 } },
      { url: 'after', durationMs: { styleLayout: 90 }, forcedReflows: { eventCount: 1, totalMs: 171, markerCount: 0, markerTotalMs: 0 } },
    );

    assert.equal(comparison.forcedReflowMs.before, 0);
    assert.equal(comparison.forcedReflowMs.after, 171);
    assert.equal(comparison.forcedStyleLayoutMarkerMs.before, 460);
    assert.equal(comparison.forcedStyleLayoutMarkerMs.after, 0);
    assert.match(comparison.warnings.join('\\n'), /Legacy stored forcedReflows.totalMs/);
  });

  it('carries the marker fallback and warns when a compare side has stackless captures', () => {
    // Both sides captured without the timeline.stack category: attributed
    // totalMs is 0 (no JS stacks) but the real forced style+layout cost lives in
    // the markers. The compare must surface the markers and warn, so the gate
    // view cannot go falsely green on forcedReflowMs 0 -> 0.
    const comparison = compareReports(
      { url: 'before', durationMs: { styleLayout: 100 }, forcedReflows: { eventCount: 0, totalMs: 0, markerTotalMs: 460 } },
      { url: 'after', durationMs: { styleLayout: 90 }, forcedReflows: { eventCount: 0, totalMs: 0, markerTotalMs: 300 } },
    );

    assert.equal(comparison.forcedReflowMs.delta, 0);
    assert.equal(comparison.forcedStyleLayoutMarkerMs.before, 460);
    assert.equal(comparison.forcedStyleLayoutMarkerMs.after, 300);
    assert.equal(comparison.forcedStyleLayoutMarkerMs.delta, -160);
    assert.equal(comparison.warnings.length, 1);
    assert.match(comparison.warnings[0], /lacks JS stacks/);
  });
});

describe('measure-dashboard-render-axis parseArgs', () => {
  it('uses desktop dashboard defaults', () => {
    const args = parseArgs(['node', 'script']);
    assert.equal(args.url, 'https://www.worldmonitor.app/dashboard');
    assert.equal(args.settle, 10000);
    assert.equal(args.width, 1365);
    assert.equal(args.height, 768);
    assert.equal(args.json, false);
  });

  it('accepts positional url and collection flags', () => {
    const args = parseArgs([
      'node',
      'script',
      'http://localhost:4173/dashboard',
      '--settle',
      '250',
      '--width',
      '1440',
      '--height',
      '900',
      '--trace-out',
      '/tmp/trace.json',
      '--json',
    ]);
    assert.equal(args.url, 'http://localhost:4173/dashboard');
    assert.equal(args.settle, 250);
    assert.equal(args.width, 1440);
    assert.equal(args.height, 900);
    assert.equal(args.traceOut, '/tmp/trace.json');
    assert.equal(args.json, true);
  });

  it('accepts before/after comparison inputs', () => {
    const args = parseArgs(['node', 'script', '--compare', 'before.json', 'after.json', '--json']);
    assert.deepEqual(args.compare, { before: 'before.json', after: 'after.json' });
    assert.equal(args.json, true);
  });
});
