#!/usr/bin/env node
/**
 * Desktop render-axis trace harness for /dashboard (#4536).
 *
 * Captures a Chrome trace through Playwright/CDP and summarizes the render-axis
 * work that matters for forced reflow: style/layout, rendering, script eval,
 * long-task TBT contribution, and layout events with JS stacks.
 *
 * Pure summarizers are exported for tests. Playwright is imported lazily so
 * parser tests never launch a browser.
 *
 * Usage:
 *   node scripts/measure-dashboard-render-axis.mjs [url] [--settle 10000] [--json]
 *   node scripts/measure-dashboard-render-axis.mjs [url] --trace-out /tmp/dashboard-trace.json
 *   node scripts/measure-dashboard-render-axis.mjs --compare before.json after.json --json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TBT_THRESHOLD_MS = 50;

const DEFAULT_TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'blink',
  'loading',
  'rail',
  'v8',
];

const STYLE_LAYOUT_NAMES = new Set([
  'InvalidateLayout',
  'Layout',
  'LayoutInvalidationTracking',
  'LocalFrameView::performLayout',
  'RecalculateStyles',
  'ScheduleStyleRecalculation',
  'StyleRecalcInvalidationTracking',
  'UpdateLayoutTree',
]);

const RENDERING_NAMES = new Set([
  'ActivateLayerTree',
  'CompositeLayers',
  'Layerize',
  'Paint',
  'PrePaint',
  'RasterTask',
  'Rasterize Paint',
  'UpdateLayer',
  'UpdateLayerTree',
]);

const SCRIPT_EVALUATION_NAMES = new Set([
  'EvaluateScript',
  'EventDispatch',
  'FireAnimationFrame',
  'FunctionCall',
  'RunMicrotasks',
  'TimerFire',
  'V8.CompileCode',
  'V8.Execute',
  'v8.compile',
]);

const TOP_LEVEL_TASK_NAMES = new Set([
  'RunTask',
  'ThreadControllerImpl::RunTask',
]);

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function durationMs(event) {
  return (Number(event?.dur) || 0) / 1000;
}

function traceEvents(trace) {
  if (Array.isArray(trace)) return trace;
  if (Array.isArray(trace?.traceEvents)) return trace.traceEvents;
  return [];
}

export function classifyRenderAxisEvent(name) {
  const value = String(name || '');
  if (!value || value === 'LayoutShift') return null;
  if (STYLE_LAYOUT_NAMES.has(value)) return 'styleLayout';
  if (RENDERING_NAMES.has(value)) return 'rendering';
  if (SCRIPT_EVALUATION_NAMES.has(value)) return 'scriptEvaluation';
  if (/layout|style|recalculate/i.test(value) && !/shift/i.test(value)) return 'styleLayout';
  if (/paint|composite|raster|layerize|prepaint/i.test(value)) return 'rendering';
  if (/evaluate|functioncall|eventdispatch|timerfire|microtask|compile|execute|v8/i.test(value)) {
    return 'scriptEvaluation';
  }
  return null;
}

function stackFromUnknown(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') return raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.map((frame) => {
      if (typeof frame === 'string') return frame;
      const fn = frame.functionName || frame.name || '(anonymous)';
      const url = frame.url || frame.scriptName || '';
      const line = frame.lineNumber ?? frame.line ?? '';
      const column = frame.columnNumber ?? frame.column ?? '';
      const suffix = url ? ` (${url}${line !== '' ? `:${line}` : ''}${column !== '' ? `:${column}` : ''})` : '';
      return `${fn}${suffix}`;
    }).filter(Boolean);
  }
  if (Array.isArray(raw.callFrames)) return stackFromUnknown(raw.callFrames);
  return [];
}

export function extractStackFrames(event) {
  return stackFromUnknown(
    event?.args?.beginData?.stackTrace
      || event?.args?.data?.stackTrace
      || event?.args?.data?.stack
      || event?.args?.stackTrace
      || event?.stackTrace,
  );
}

function looksForcedReflow(event) {
  const name = String(event?.name || '');
  if (/forced.*(layout|reflow)|layout.*forced|reflow/i.test(name)) return true;
  const data = event?.args?.data || event?.args?.beginData || {};
  if (data.forcedReflow || data.forcedLayout || data.isForced) return true;
  return false;
}

export function summarizeForcedReflows(events, limit = 10) {
  const stacks = new Map();
  let eventCount = 0;
  let totalMs = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.ph !== 'X' || !looksForcedReflow(event)) continue;
    const ms = durationMs(event);
    const frames = extractStackFrames(event);
    const key = frames.slice(0, 4).join(' <- ') || String(event.name || 'unknown');
    const topFrame = frames[0] || String(event.name || 'unknown');
    const current = stacks.get(key) || { topFrame, stack: frames.slice(0, 8), count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += ms;
    current.maxMs = Math.max(current.maxMs, ms);
    stacks.set(key, current);
    eventCount += 1;
    totalMs += ms;
  }

  return {
    eventCount,
    totalMs: round(totalMs),
    stacks: [...stacks.values()]
      .map((row) => ({ ...row, totalMs: round(row.totalMs), maxMs: round(row.maxMs) }))
      .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
      .slice(0, limit),
  };
}

function summarizeTopEvents(rows, limit = 12) {
  return [...rows.values()]
    .map((row) => ({ ...row, totalMs: round(row.totalMs), maxMs: round(row.maxMs) }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
    .slice(0, limit);
}

export function summarizeTraceEvents(trace) {
  const events = traceEvents(trace);
  const topEvents = new Map();
  const duration = {
    styleLayoutMs: 0,
    renderingMs: 0,
    scriptEvaluationMs: 0,
    topLevelTaskMs: 0,
    tbtMs: 0,
  };

  for (const event of events) {
    if (event?.ph !== 'X') continue;
    const ms = durationMs(event);
    if (ms <= 0) continue;

    const group = classifyRenderAxisEvent(event.name);
    if (group === 'styleLayout') duration.styleLayoutMs += ms;
    else if (group === 'rendering') duration.renderingMs += ms;
    else if (group === 'scriptEvaluation') duration.scriptEvaluationMs += ms;

    if (TOP_LEVEL_TASK_NAMES.has(String(event.name || ''))) {
      duration.topLevelTaskMs += ms;
      duration.tbtMs += Math.max(0, ms - TBT_THRESHOLD_MS);
    }

    if (group) {
      const key = `${group}:${event.name}`;
      const current = topEvents.get(key) || { group, name: String(event.name), count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += ms;
      current.maxMs = Math.max(current.maxMs, ms);
      topEvents.set(key, current);
    }
  }

  const accountedMs = duration.styleLayoutMs + duration.renderingMs + duration.scriptEvaluationMs;
  const warnings = [];
  if (events.length === 0) warnings.push('No trace events found.');
  if (events.length > 0 && accountedMs === 0) warnings.push('No render-axis duration events were recognized.');

  return {
    eventCount: events.length,
    durationMs: {
      styleLayout: round(duration.styleLayoutMs),
      rendering: round(duration.renderingMs),
      scriptEvaluation: round(duration.scriptEvaluationMs),
      topLevelTasks: round(duration.topLevelTaskMs),
      estimatedTbt: round(duration.tbtMs),
      accountedRenderAxis: round(accountedMs),
    },
    sharePct: {
      styleLayoutOfAccounted: accountedMs ? round((duration.styleLayoutMs / accountedMs) * 100) : 0,
      renderingOfAccounted: accountedMs ? round((duration.renderingMs / accountedMs) * 100) : 0,
      scriptEvaluationOfAccounted: accountedMs ? round((duration.scriptEvaluationMs / accountedMs) * 100) : 0,
    },
    forcedReflows: summarizeForcedReflows(events),
    topEvents: summarizeTopEvents(topEvents),
    warnings,
  };
}

export function buildReport(result) {
  const summary = summarizeTraceEvents(result?.traceEvents || []);
  return {
    url: result?.url,
    generatedAt: result?.generatedAt,
    viewport: result?.viewport,
    settleMs: result?.settleMs,
    tracePath: result?.tracePath || null,
    ...summary,
  };
}

export function normalizeReport(input) {
  if (input?.durationMs) return input;
  return buildReport({
    url: input?.url,
    generatedAt: input?.generatedAt,
    viewport: input?.viewport,
    settleMs: input?.settleMs,
    tracePath: input?.tracePath || null,
    traceEvents: traceEvents(input),
  });
}

export function compareReports(before, after) {
  const b = before?.durationMs || {};
  const a = after?.durationMs || {};
  const beforeStyle = Number(b.styleLayout) || 0;
  const afterStyle = Number(a.styleLayout) || 0;
  const beforeTbt = Number(b.estimatedTbt) || 0;
  const afterTbt = Number(a.estimatedTbt) || 0;
  return {
    before: before?.url || null,
    after: after?.url || null,
    deltaMs: {
      styleLayout: round(afterStyle - beforeStyle),
      rendering: round((Number(a.rendering) || 0) - (Number(b.rendering) || 0)),
      scriptEvaluation: round((Number(a.scriptEvaluation) || 0) - (Number(b.scriptEvaluation) || 0)),
      estimatedTbt: round(afterTbt - beforeTbt),
    },
    deltaPct: {
      styleLayout: beforeStyle ? round(((afterStyle - beforeStyle) / beforeStyle) * 100) : 0,
      estimatedTbt: beforeTbt ? round(((afterTbt - beforeTbt) / beforeTbt) * 100) : 0,
    },
    forcedReflowEvents: {
      before: Number(before?.forcedReflows?.eventCount) || 0,
      after: Number(after?.forcedReflows?.eventCount) || 0,
      delta: (Number(after?.forcedReflows?.eventCount) || 0) - (Number(before?.forcedReflows?.eventCount) || 0),
    },
  };
}

export function parseArgs(argv) {
  const args = {
    url: 'https://www.worldmonitor.app/dashboard',
    settle: 10000,
    width: 1365,
    height: 768,
    json: false,
    traceOut: '',
    compare: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--settle') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.settle = n;
    } else if (value === '--width') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.width = n;
    } else if (value === '--height') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.height = n;
    } else if (value === '--trace-out') {
      args.traceOut = rest[++i] || '';
    } else if (value === '--compare') {
      const before = rest[++i];
      const after = rest[++i];
      if (before && after) args.compare = { before, after };
    } else if (value === '--json') {
      args.json = true;
    } else if (!value.startsWith('--')) {
      args.url = value;
    }
  }
  return args;
}

async function readStream(client, stream) {
  let data = '';
  while (true) {
    const chunk = await client.send('IO.read', { handle: stream });
    data += chunk.data || '';
    if (chunk.eof) break;
  }
  await client.send('IO.close', { handle: stream });
  return data;
}

async function stopTracing(client) {
  const completed = new Promise((resolve) => {
    client.once('Tracing.tracingComplete', resolve);
  });
  await client.send('Tracing.end');
  const result = await completed;
  if (!result?.stream) return [];
  const raw = await readStream(client, result.stream);
  const parsed = JSON.parse(raw);
  return traceEvents(parsed);
}

async function captureTrace(url, { settleMs = 10000, width = 1365, height = 768, traceOut = '' } = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      isMobile: false,
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Tracing.start', {
      categories: DEFAULT_TRACE_CATEGORIES.join(','),
      transferMode: 'ReturnAsStream',
    });
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(settleMs);
    const events = await stopTracing(client);
    const result = {
      url,
      generatedAt: new Date().toISOString(),
      viewport: { width, height },
      settleMs,
      tracePath: traceOut || null,
      traceEvents: events,
    };
    if (traceOut) {
      await writeFile(traceOut, JSON.stringify(result, null, 2));
    }
    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function printHuman(report) {
  console.log(`\nDesktop render-axis trace - ${report.url || 'comparison'}\n`);
  if (report.deltaMs) {
    console.log(`Style/Layout delta: ${report.deltaMs.styleLayout}ms (${report.deltaPct.styleLayout}%)`);
    console.log(`Estimated TBT delta: ${report.deltaMs.estimatedTbt}ms (${report.deltaPct.estimatedTbt}%)`);
    console.log(`Forced-reflow events: ${report.forcedReflowEvents.before} -> ${report.forcedReflowEvents.after}`);
    console.log('');
    return;
  }
  const d = report.durationMs;
  console.log(`Style/Layout:     ${d.styleLayout}ms (${report.sharePct.styleLayoutOfAccounted}% of accounted render-axis)`);
  console.log(`Rendering:        ${d.rendering}ms (${report.sharePct.renderingOfAccounted}% of accounted render-axis)`);
  console.log(`Script Evaluation:${String(d.scriptEvaluation).padStart(7)}ms (${report.sharePct.scriptEvaluationOfAccounted}% of accounted render-axis)`);
  console.log(`Estimated TBT:    ${d.estimatedTbt}ms`);
  console.log(`Forced reflows:   ${report.forcedReflows.eventCount} events, ${report.forcedReflows.totalMs}ms`);
  if (report.forcedReflows.stacks.length > 0) {
    console.log('\nTop forced-reflow stacks:');
    for (const stack of report.forcedReflows.stacks) {
      console.log(`  ${stack.totalMs}ms across ${stack.count}x - ${stack.topFrame}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of report.warnings) console.log(`  ${warning}`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  let report;
  if (args.compare) {
    report = compareReports(
      normalizeReport(await readJson(args.compare.before)),
      normalizeReport(await readJson(args.compare.after)),
    );
  } else {
    report = buildReport(await captureTrace(args.url, {
      settleMs: args.settle,
      width: args.width,
      height: args.height,
      traceOut: args.traceOut,
    }));
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
