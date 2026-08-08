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
 *   node scripts/measure-dashboard-render-axis.mjs [url] --interact country --cpu-throttle 4 --json
 *   (use --cpu-throttle 4-6 to approximate mid-tier mobile CPU in local traces)
 *   node scripts/measure-dashboard-render-axis.mjs --compare before.json after.json --json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TBT_THRESHOLD_MS = 50;
const DEFAULT_INTERACTION_VIEWPORT = { width: 390, height: 844 };
const DEFAULT_POST_INTERACT_MS = 1200;
const DEFAULT_CPU_THROTTLE_RATE = 1;
const INTERACTION_TRACE_MARK = 'wm-interaction-start';

export const DEFAULT_TRACE_CATEGORIES = Object.freeze([
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'blink',
  'blink.user_timing',
  'disabled-by-default-gpu.debug',
  'disabled-by-default-gpu.service',
  'gpu',
  'loading',
  'rail',
  'v8',
]);

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

const CANVAS_NAMES = new Set([
  'Canvas2DLayerBridge::FlushCanvas',
  'Canvas2DLayerBridge::FinalizeFrame',
  'CanvasResourceProvider::FlushCanvas',
  'CanvasResourceProvider::RasterRecord',
  'GLES2DecoderImpl::DoCommands',
  'WebGLRenderingContextBase::commit',
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

// A JS-forced synchronous style/layout is recorded under one of these event
// names AND carries the forcing JS stack (from the timeline.stack category).
// Scheduled (end-of-frame) layouts run inside the rendering lifecycle with no
// script on the stack, so they carry no stackTrace — that presence/absence is
// exactly how DevTools separates a "Forced reflow" from an ordinary layout.
const FORCED_LAYOUT_NAMES = new Set([
  'Layout',
  'UpdateLayoutTree',
  'RecalculateStyles',
  'Blink.UpdateLayout',
]);

// Blink.ForcedStyleAndLayout(.UpdateTime) reports the aggregate forced
// style+layout TIME but carries no JS stack, so it cannot be attributed to a
// call site. It is tracked separately as an always-available fallback signal
// for traces captured without the disabled-by-default-devtools.timeline.stack
// category (e.g. some minified prod captures).
const FORCED_MARKER_NAMES = new Set([
  'Blink.ForcedStyleAndLayout',
  'Blink.ForcedStyleAndLayout.UpdateTime',
]);

const NAMED_INTERACTION_TARGETS = Object.freeze({
  country: {
    name: 'country',
    label: 'SVG country path',
    selector: '#mapSvg path.country',
    action: 'tap',
  },
  base: {
    name: 'base',
    label: 'SVG base rect',
    selector: '#mapSvg > g.map-base > rect',
    action: 'tap',
  },
  nav: {
    name: 'nav',
    label: 'mobile panel nav chip',
    selector: '#main > nav.mobile-panel-nav > button, .mobile-panel-nav-chip',
    action: 'tap',
  },
  'nav-chip': {
    name: 'nav-chip',
    label: 'mobile panel nav chip',
    selector: '#main > nav.mobile-panel-nav > button, .mobile-panel-nav-chip',
    action: 'tap',
  },
});

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
  if (CANVAS_NAMES.has(value)) return 'canvas';
  if (RENDERING_NAMES.has(value)) return 'rendering';
  if (SCRIPT_EVALUATION_NAMES.has(value)) return 'scriptEvaluation';
  if (/layout|style|recalculate/i.test(value) && !/shift/i.test(value)) return 'styleLayout';
  if (/canvas|webgl|gles2|skia/i.test(value)) return 'canvas';
  if (/paint|composite|raster|layerize|prepaint/i.test(value)) return 'rendering';
  if (/evaluate|functioncall|eventdispatch|timerfire|microtask|compile|execute|v8/i.test(value)) {
    return 'scriptEvaluation';
  }
  return null;
}

export function resolveInteractionTarget(raw = 'country') {
  const value = String(raw || 'country').trim() || 'country';
  const named = NAMED_INTERACTION_TARGETS[value];
  if (named) return { ...named };
  if (value.startsWith('selector:')) {
    return {
      name: 'custom',
      label: 'custom selector',
      selector: value.slice('selector:'.length).trim(),
      action: 'tap',
    };
  }
  return {
    name: 'custom',
    label: 'custom selector',
    selector: value,
    action: 'tap',
  };
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

export function isForcedReflow(event) {
  const data = event?.args?.data || event?.args?.beginData || {};
  // Explicitly annotated (synthetic fixtures / traces that flag the event).
  if (data.forcedReflow || data.forcedLayout || data.isForced) return true;
  // Real captures: a style/layout event is JS-forced iff it carries a stack.
  if (!FORCED_LAYOUT_NAMES.has(String(event?.name || ''))) return false;
  return extractStackFrames(event).length > 0;
}

export function summarizeForcedReflows(events, limit = 10) {
  const stacks = new Map();
  let eventCount = 0;
  let totalMs = 0;
  let markerCount = 0;
  let markerTotalMs = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.ph !== 'X') continue;
    // Aggregate the stackless browser markers separately — they carry the total
    // forced style+layout time but no call site, so they must not pollute the
    // attributed-stack ranking.
    if (FORCED_MARKER_NAMES.has(String(event.name || ''))) {
      markerCount += 1;
      markerTotalMs += durationMs(event);
      continue;
    }
    if (!isForcedReflow(event)) continue;
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
    markerCount,
    markerTotalMs: round(markerTotalMs),
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
    canvasMs: 0,
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
    else if (group === 'canvas') duration.canvasMs += ms;
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
  const accountedWithCanvasMs = accountedMs + duration.canvasMs;
  const warnings = [];
  if (events.length === 0) warnings.push('No trace events found.');
  if (events.length > 0 && accountedWithCanvasMs === 0) warnings.push('No render-axis duration events were recognized.');

  return {
    eventCount: events.length,
    durationMs: {
      styleLayout: round(duration.styleLayoutMs),
      rendering: round(duration.renderingMs),
      canvas: round(duration.canvasMs),
      scriptEvaluation: round(duration.scriptEvaluationMs),
      topLevelTasks: round(duration.topLevelTaskMs),
      estimatedTbt: round(duration.tbtMs),
      accountedRenderAxis: round(accountedWithCanvasMs),
    },
    sharePct: {
      styleLayoutOfAccounted: accountedWithCanvasMs ? round((duration.styleLayoutMs / accountedWithCanvasMs) * 100) : 0,
      renderingOfAccounted: accountedWithCanvasMs ? round((duration.renderingMs / accountedWithCanvasMs) * 100) : 0,
      canvasOfAccounted: accountedWithCanvasMs ? round((duration.canvasMs / accountedWithCanvasMs) * 100) : 0,
      scriptEvaluationOfAccounted: accountedWithCanvasMs ? round((duration.scriptEvaluationMs / accountedWithCanvasMs) * 100) : 0,
    },
    forcedReflows: summarizeForcedReflows(events),
    topEvents: summarizeTopEvents(topEvents),
    warnings,
  };
}

function summarizePhaseDurationsInWindow(trace, traceStartUs, traceEndUs) {
  const duration = {
    styleLayout: 0,
    rendering: 0,
    canvas: 0,
    scriptEvaluation: 0,
  };
  const startUs = Number(traceStartUs);
  const endUs = Number(traceEndUs);
  if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs <= startUs) {
    return {
      styleLayout: 0,
      rendering: 0,
      canvas: 0,
      scriptEvaluation: 0,
    };
  }

  for (const event of traceEvents(trace)) {
    if (event?.ph !== 'X') continue;
    const group = classifyRenderAxisEvent(event.name);
    if (!group || !hasOwn(duration, group)) continue;
    const eventStartUs = Number(event.ts);
    const eventDurationUs = Number(event.dur) || 0;
    if (!Number.isFinite(eventStartUs) || eventDurationUs <= 0) continue;
    const eventEndUs = eventStartUs + eventDurationUs;
    const overlapUs = Math.min(endUs, eventEndUs) - Math.max(startUs, eventStartUs);
    if (overlapUs <= 0) continue;
    duration[group] += overlapUs / 1000;
  }

  return {
    styleLayout: round(duration.styleLayout),
    rendering: round(duration.rendering),
    canvas: round(duration.canvas),
    scriptEvaluation: round(duration.scriptEvaluation),
  };
}

export function dominantRenderPhase(duration = {}) {
  const labels = {
    styleLayout: 'style/layout',
    rendering: 'paint/composite/raster',
    canvas: 'canvas/webgl',
    scriptEvaluation: 'script/evaluation',
  };
  const phases = ['styleLayout', 'rendering', 'canvas', 'scriptEvaluation'];
  const [phase, ms] = phases
    .map((key) => [key, Number(duration[key]) || 0])
    .sort((a, b) => b[1] - a[1])
    .find(([, value]) => value > 0) || ['none', 0];
  return { phase, label: labels[phase] || 'none', ms: round(ms) };
}

export function summarizeInteractionTimings(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const startTime = Number(entry?.startTime) || 0;
      const duration = Number(entry?.duration) || 0;
      const processingStart = Number(entry?.processingStart) || startTime;
      const processingEnd = Number(entry?.processingEnd) || processingStart;
      return {
        name: String(entry?.name || 'event'),
        selector: String(entry?.selector || ''),
        startTime: round(startTime),
        durationMs: round(duration),
        inputDelayMs: round(Math.max(0, processingStart - startTime)),
        processingMs: round(Math.max(0, processingEnd - processingStart)),
        presentationDelayMs: round(Math.max(0, startTime + duration - processingEnd)),
      };
    })
    .filter((row) => row.durationMs > 0 || row.processingMs > 0 || row.presentationDelayMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs || b.presentationDelayMs - a.presentationDelayMs);

  return {
    eventCount: rows.length,
    worst: rows[0] || null,
    events: rows.slice(0, 8),
  };
}

function traceMarkerNames(event) {
  return [
    event?.name,
    event?.args?.data?.name,
    event?.args?.name,
  ]
    .map((value) => String(value || ''))
    .filter(Boolean);
}

function findTraceMarkerTimeUs(trace, markerName = INTERACTION_TRACE_MARK) {
  for (const event of traceEvents(trace)) {
    if (!traceMarkerNames(event).includes(markerName)) continue;
    const ts = Number(event.ts);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function resolveInteractionTimeAnchor(trace, anchor) {
  const performanceTimeMs = Number(anchor?.performanceTimeMs);
  const markerName = String(anchor?.markName || INTERACTION_TRACE_MARK);
  const rawTraceTimeUs = anchor?.traceTimeUs;
  let traceTimeUs = rawTraceTimeUs == null ? NaN : Number(rawTraceTimeUs);
  if (!Number.isFinite(traceTimeUs)) {
    const markerTraceTimeUs = findTraceMarkerTimeUs(trace, markerName);
    traceTimeUs = markerTraceTimeUs == null ? NaN : Number(markerTraceTimeUs);
  }
  if (!Number.isFinite(performanceTimeMs) || !Number.isFinite(traceTimeUs)) return null;
  return { performanceTimeMs, traceTimeUs };
}

export function summarizeInteractionEventWindow(trace, worstTiming, anchor) {
  const resolvedAnchor = resolveInteractionTimeAnchor(trace, anchor);
  const startTime = Number(worstTiming?.startTime);
  const duration = Number(worstTiming?.durationMs ?? worstTiming?.duration);
  if (!resolvedAnchor || !Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  const traceStartUs = Math.round(
    resolvedAnchor.traceTimeUs + ((startTime - resolvedAnchor.performanceTimeMs) * 1000),
  );
  const traceEndUs = Math.round(traceStartUs + (duration * 1000));
  const durationMsByPhase = summarizePhaseDurationsInWindow(trace, traceStartUs, traceEndUs);
  return {
    startTime: round(startTime),
    durationMs: round(duration),
    traceStartUs,
    traceEndUs,
    dominantPhase: dominantRenderPhase(durationMsByPhase),
    durationMsByPhase,
  };
}

export function buildReport(result) {
  const summary = summarizeTraceEvents(result?.traceEvents || []);
  const report = {
    url: result?.url,
    generatedAt: result?.generatedAt,
    viewport: result?.viewport,
    settleMs: result?.settleMs,
    cpuThrottleRate: Number(result?.cpuThrottleRate) || DEFAULT_CPU_THROTTLE_RATE,
    tracePath: result?.tracePath || null,
    ...summary,
  };
  if (result?.interaction) {
    const interactionWarnings = [];
    if (result.interaction?.targetInfo?.tapPoint?.matchedTop === false) {
      interactionWarnings.push(
        `Interaction target ${result.interaction.name || 'custom'} used a fallback tap point that did not hit the requested selector.`,
      );
    }
    const timings = summarizeInteractionTimings(result?.eventTimings);
    const eventWindow = timings.worst
      ? summarizeInteractionEventWindow(result?.traceEvents || [], timings.worst, result?.interactionTimeAnchor)
      : null;
    if (timings.worst && !eventWindow) {
      interactionWarnings.push(
        'Unable to scope dominant phase to the worst Event Timing row because the interaction trace clock anchor is unavailable. Re-run with a trace captured by this tool version.',
      );
    }
    report.interaction = {
      target: result.interaction,
      timings,
      dominantPhase: dominantRenderPhase(summary.durationMs),
      eventWindow,
      traceWindow: {
        postInteractMs: Number(result.interaction?.postInteractMs) || DEFAULT_POST_INTERACT_MS,
        dominantPhaseScope: 'full-post-interaction-trace-window',
      },
      warnings: interactionWarnings,
    };
    report.warnings = [...report.warnings, ...interactionWarnings];
  }
  return report;
}

export function normalizeReport(input) {
  const events = traceEvents(input);
  // A stored summary (has durationMs, no raw traceEvents) is returned as-is.
  // But whenever traceEvents are present, recompute with the CURRENT detector
  // rather than trusting a stored forcedReflows summary — a summary written by
  // an older tool version carries the marker-based totalMs, which would make a
  // --compare mix two different quantities under the same field name.
  if (input?.durationMs && !events.length) return input;
  return buildReport({
    url: input?.url,
    generatedAt: input?.generatedAt,
    viewport: input?.viewport,
    settleMs: input?.settleMs,
    cpuThrottleRate: input?.cpuThrottleRate,
    tracePath: input?.tracePath || null,
    traceEvents: events,
    interaction: input?.interaction || null,
    eventTimings: input?.eventTimings || [],
    interactionTimeAnchor: input?.interactionTimeAnchor || null,
  });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}

function legacySummaryForcedReflows(report) {
  const forced = report?.forcedReflows;
  return Boolean(
    report?.durationMs
      && forced
      && !hasOwn(forced, 'markerTotalMs')
      && !hasOwn(forced, 'markerCount'),
  );
}

function compareForcedReflowMetrics(report) {
  const forced = report?.forcedReflows || {};
  const legacySummary = legacySummaryForcedReflows(report);
  const totalMs = Number(forced.totalMs) || 0;
  return {
    attributedMs: legacySummary ? 0 : totalMs,
    markerMs: legacySummary ? totalMs : Number(forced.markerTotalMs) || 0,
    legacySummary,
  };
}

export function compareReports(before, after) {
  const b = before?.durationMs || {};
  const a = after?.durationMs || {};
  const beforeStyle = Number(b.styleLayout) || 0;
  const afterStyle = Number(a.styleLayout) || 0;
  const beforeCanvas = Number(b.canvas) || 0;
  const afterCanvas = Number(a.canvas) || 0;
  const beforeTbt = Number(b.estimatedTbt) || 0;
  const afterTbt = Number(a.estimatedTbt) || 0;
  const beforeForced = compareForcedReflowMetrics(before);
  const afterForced = compareForcedReflowMetrics(after);
  const beforeAttribMs = beforeForced.attributedMs;
  const afterAttribMs = afterForced.attributedMs;
  const beforeMarkerMs = beforeForced.markerMs;
  const afterMarkerMs = afterForced.markerMs;
  // A side with forced style+layout marker time but ZERO attributed stacks was
  // captured without the timeline.stack category — its attributed forcedReflowMs
  // is ~0 and would pass the <=200ms gate trivially while the real forced cost
  // (markers) is unmeasured. Carry the marker aggregate + a warning into the
  // compare so the gate view cannot go falsely green on a stackless capture.
  const warnings = [];
  if (beforeForced.legacySummary || afterForced.legacySummary) {
    warnings.push(
      'Legacy stored forcedReflows.totalMs lacks marker fields; treating it as '
      + 'Blink.ForcedStyleAndLayout marker fallback. Re-run the capture or keep '
      + 'raw traceEvents before gating on attributed forcedReflowMs.',
    );
  }
  if ((beforeMarkerMs > 0 && beforeAttribMs === 0) || (afterMarkerMs > 0 && afterAttribMs === 0)) {
    warnings.push(
      'Attributed forced-reflow ms is 0 on a side with non-zero Blink.ForcedStyleAndLayout markers — '
      + 'that capture lacks JS stacks; gate on forcedStyleLayoutMarkerMs, not forcedReflowMs.',
    );
  }
  return {
    before: before?.url || null,
    after: after?.url || null,
    deltaMs: {
      styleLayout: round(afterStyle - beforeStyle),
      rendering: round((Number(a.rendering) || 0) - (Number(b.rendering) || 0)),
      canvas: round(afterCanvas - beforeCanvas),
      scriptEvaluation: round((Number(a.scriptEvaluation) || 0) - (Number(b.scriptEvaluation) || 0)),
      estimatedTbt: round(afterTbt - beforeTbt),
    },
    deltaPct: {
      styleLayout: beforeStyle ? round(((afterStyle - beforeStyle) / beforeStyle) * 100) : 0,
      canvas: beforeCanvas ? round(((afterCanvas - beforeCanvas) / beforeCanvas) * 100) : 0,
      estimatedTbt: beforeTbt ? round(((afterTbt - beforeTbt) / beforeTbt) * 100) : 0,
    },
    forcedReflowEvents: {
      before: Number(before?.forcedReflows?.eventCount) || 0,
      after: Number(after?.forcedReflows?.eventCount) || 0,
      delta: (Number(after?.forcedReflows?.eventCount) || 0) - (Number(before?.forcedReflows?.eventCount) || 0),
    },
    forcedReflowMs: {
      before: round(beforeAttribMs),
      after: round(afterAttribMs),
      delta: round(afterAttribMs - beforeAttribMs),
    },
    forcedStyleLayoutMarkerMs: {
      before: round(beforeMarkerMs),
      after: round(afterMarkerMs),
      delta: round(afterMarkerMs - beforeMarkerMs),
    },
    warnings,
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
    interact: null,
    postInteract: DEFAULT_POST_INTERACT_MS,
    cpuThrottleRate: DEFAULT_CPU_THROTTLE_RATE,
  };
  let widthExplicit = false;
  let heightExplicit = false;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--settle') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.settle = n;
    } else if (value === '--width') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) {
        args.width = n;
        widthExplicit = true;
      }
    } else if (value === '--height') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) {
        args.height = n;
        heightExplicit = true;
      }
    } else if (value === '--trace-out') {
      args.traceOut = rest[++i] || '';
    } else if (value === '--interact') {
      const next = rest[i + 1];
      const target = next && !next.startsWith('--') ? rest[++i] : 'country';
      args.interact = resolveInteractionTarget(target);
    } else if (value === '--post-interact') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.postInteract = n;
    } else if (value === '--cpu-throttle') {
      const n = Number(rest[++i]);
      if (Number.isFinite(n) && n >= 1) args.cpuThrottleRate = n;
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
  if (args.interact) {
    if (!widthExplicit) args.width = DEFAULT_INTERACTION_VIEWPORT.width;
    if (!heightExplicit) args.height = DEFAULT_INTERACTION_VIEWPORT.height;
  }
  return args;
}

async function startTracing(client) {
  await client.send('Tracing.start', {
    categories: DEFAULT_TRACE_CATEGORIES.join(','),
    transferMode: 'ReturnAsStream',
  });
}

export async function setCpuThrottle(client, rate) {
  const throttleRate = Number(rate) || DEFAULT_CPU_THROTTLE_RATE;
  if (throttleRate <= DEFAULT_CPU_THROTTLE_RATE) return;
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttleRate });
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

async function installInteractionTimingObserver(page) {
  await page.addInitScript(() => {
    const selectorFor = (node) => {
      try {
        if (!(node instanceof Element)) return '';
        if (node.id) return `#${CSS.escape(node.id)}`;
        const className = typeof node.className === 'string'
          ? node.className
          : (node.className?.baseVal || '');
        const firstClass = className.trim().split(/\s+/).filter(Boolean)[0];
        return `${node.tagName.toLowerCase()}${firstClass ? `.${CSS.escape(firstClass)}` : ''}`;
      } catch {
        return '';
      }
    };
    window.__wmInteractionTimings = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__wmInteractionTimings.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            processingStart: entry.processingStart,
            processingEnd: entry.processingEnd,
            interactionId: entry.interactionId || 0,
            selector: selectorFor(entry.target),
          });
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 0 });
    } catch {
      /* Event Timing unavailable in this browser — trace phases still work. */
    }
  });
}

async function describeInteractionTarget(page, target) {
  const first = page.locator(target.selector).first();
  await first.waitFor({ state: 'visible', timeout: 15000 });
  await first.scrollIntoViewIfNeeded();
  const info = await page.evaluate((selector) => {
    const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;
    const inViewport = (x, y) => (
      Number.isFinite(x)
      && Number.isFinite(y)
      && x >= 0
      && y >= 0
      && x <= window.innerWidth
      && y <= window.innerHeight
    );
    const rectInfo = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
      };
    };
    const topMatches = (el, x, y) => {
      const top = document.elementFromPoint(x, y);
      if (!top) return false;
      if (top === el || el.contains(top)) return true;
      try {
        return top.closest(selector) === el;
      } catch {
        return false;
      }
    };
    const screenPoint = (el, point) => {
      const ctm = typeof el.getScreenCTM === 'function' ? el.getScreenCTM() : null;
      if (!ctm) return null;
      return {
        x: point.x * ctm.a + point.y * ctm.c + ctm.e,
        y: point.x * ctm.b + point.y * ctm.d + ctm.f,
      };
    };
    const candidatePoints = (el) => {
      const points = [];
      if (typeof el.getTotalLength === 'function' && typeof el.getPointAtLength === 'function') {
        try {
          const length = el.getTotalLength();
          if (Number.isFinite(length) && length > 0) {
            for (let i = 1; i < 24; i++) {
              const point = screenPoint(el, el.getPointAtLength((length * i) / 24));
              if (point) points.push(point);
            }
          }
        } catch {
          /* Some SVG nodes expose geometry methods but throw for invalid paths. */
        }
      }
      const rect = el.getBoundingClientRect();
      const visibleLeft = Math.max(0, rect.left);
      const visibleRight = Math.min(window.innerWidth, rect.right);
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(window.innerHeight, rect.bottom);
      if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
        for (const xRatio of [0.5, 0.15, 0.3, 0.7, 0.85]) {
          for (const yRatio of [0.5, 0.15, 0.3, 0.7, 0.85]) {
            points.push({
              x: visibleLeft + (visibleRight - visibleLeft) * xRatio,
              y: visibleTop + (visibleBottom - visibleTop) * yRatio,
            });
          }
        }
      }
      return points;
    };
    const describe = (el, point, matchedTop) => ({
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      rect: rectInfo(el),
      tapPoint: point ? { x: round1(point.x), y: round1(point.y), matchedTop } : null,
    });

    const candidates = [...document.querySelectorAll(selector)];
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      for (const point of candidatePoints(el)) {
        if (!inViewport(point.x, point.y)) continue;
        if (topMatches(el, point.x, point.y)) return describe(el, point, true);
      }
    }

    const fallback = candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!fallback) return null;
    const rect = fallback.getBoundingClientRect();
    const point = {
      x: Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1),
      y: Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1),
    };
    return describe(fallback, point, false);
  }, target.selector);
  if (!info?.tapPoint) {
    throw new Error(`No visible interaction target matched ${target.selector}`);
  }
  return info;
}

async function performInteraction(page, targetInfo) {
  const point = targetInfo?.tapPoint;
  if (!point) throw new Error('Interaction target did not include a tap point');
  await page.touchscreen.tap(point.x, point.y);
}

async function readInteractionTimings(page) {
  return page.evaluate(() => window.__wmInteractionTimings || []);
}

async function resetInteractionTimings(page) {
  await page.evaluate(() => {
    window.__wmInteractionTimings = [];
  });
}

async function captureTrace(url, {
  settleMs = 10000,
  width = 1365,
  height = 768,
  traceOut = '',
  interaction = null,
  postInteractMs = DEFAULT_POST_INTERACT_MS,
  cpuThrottleRate = DEFAULT_CPU_THROTTLE_RATE,
} = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const mobileInteraction = Boolean(interaction);
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: mobileInteraction ? 3 : 1,
      isMobile: mobileInteraction,
      hasTouch: mobileInteraction,
    });
    const page = await context.newPage();
    if (interaction) await installInteractionTimingObserver(page);
    const client = await context.newCDPSession(page);
    await setCpuThrottle(client, cpuThrottleRate);
    let eventTimings = [];
    let interactionTarget = null;
    let interactionTimeAnchor = null;

    if (interaction) {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(settleMs);
      const targetInfo = await describeInteractionTarget(page, interaction);
      interactionTarget = {
        ...interaction,
        postInteractMs,
        targetInfo,
      };
      await resetInteractionTimings(page);
      await startTracing(client);
      const performanceTimeMs = await page.evaluate((markName) => {
        const now = performance.now();
        performance.mark?.(markName);
        return now;
      }, INTERACTION_TRACE_MARK);
      await performInteraction(page, targetInfo);
      await page.waitForTimeout(postInteractMs);
      eventTimings = await readInteractionTimings(page);
      interactionTimeAnchor = {
        performanceTimeMs,
        markName: INTERACTION_TRACE_MARK,
      };
    } else {
      await startTracing(client);
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(settleMs);
    }

    const events = await stopTracing(client);
    const interactionTraceTimeUs = findTraceMarkerTimeUs(events, INTERACTION_TRACE_MARK);
    const result = {
      url,
      generatedAt: new Date().toISOString(),
      viewport: { width, height },
      settleMs,
      cpuThrottleRate: Number(cpuThrottleRate) || DEFAULT_CPU_THROTTLE_RATE,
      tracePath: traceOut || null,
      traceEvents: events,
      interaction: interactionTarget,
      eventTimings,
      interactionTimeAnchor: interactionTimeAnchor
        ? {
          ...interactionTimeAnchor,
          ...(interactionTraceTimeUs == null ? {} : { traceTimeUs: interactionTraceTimeUs }),
        }
        : null,
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
    console.log(`Canvas/WebGL delta: ${report.deltaMs.canvas}ms (${report.deltaPct.canvas}%)`);
    console.log(`Estimated TBT delta: ${report.deltaMs.estimatedTbt}ms (${report.deltaPct.estimatedTbt}%)`);
    console.log(`Forced-reflow events: ${report.forcedReflowEvents.before} -> ${report.forcedReflowEvents.after}`);
    if (report.forcedReflowMs) {
      console.log(`Attributed forced-reflow ms: ${report.forcedReflowMs.before} -> ${report.forcedReflowMs.after} (${report.forcedReflowMs.delta}ms)`);
    }
    if (report.forcedStyleLayoutMarkerMs) {
      console.log(`Blink.ForcedStyleAndLayout marker ms: ${report.forcedStyleLayoutMarkerMs.before} -> ${report.forcedStyleLayoutMarkerMs.after} (${report.forcedStyleLayoutMarkerMs.delta}ms — stackless fallback)`);
    }
    for (const w of report.warnings || []) console.log(`  ! ${w}`);
    console.log('');
    return;
  }
  const d = report.durationMs;
  if ((report.cpuThrottleRate || DEFAULT_CPU_THROTTLE_RATE) > DEFAULT_CPU_THROTTLE_RATE) {
    console.log(`CPU Throttle:     ${report.cpuThrottleRate}x`);
  }
  console.log(`Style/Layout:     ${d.styleLayout}ms (${report.sharePct.styleLayoutOfAccounted}% of accounted render-axis)`);
  console.log(`Rendering:        ${d.rendering}ms (${report.sharePct.renderingOfAccounted}% of accounted render-axis)`);
  console.log(`Canvas/WebGL:     ${d.canvas}ms (${report.sharePct.canvasOfAccounted}% of accounted render-axis)`);
  console.log(`Script Evaluation:${String(d.scriptEvaluation).padStart(7)}ms (${report.sharePct.scriptEvaluationOfAccounted}% of accounted render-axis)`);
  console.log(`Estimated TBT:    ${d.estimatedTbt}ms`);
  if (report.interaction) {
    const { target, timings, dominantPhase, eventWindow } = report.interaction;
    console.log(`Interaction:      ${target.name} (${target.selector})`);
    if (timings.worst) {
      const selector = timings.worst.selector ? ` on ${timings.worst.selector}` : '';
      console.log(
        `Event Timing:     ${timings.worst.name}${selector} ${timings.worst.durationMs}ms `
        + `(input ${timings.worst.inputDelayMs}ms, processing ${timings.worst.processingMs}ms, `
        + `presentation ${timings.worst.presentationDelayMs}ms)`,
      );
    } else {
      console.log('Event Timing:     unavailable (browser did not emit Event Timing entries)');
    }
    console.log(`Dominant phase:   ${dominantPhase.label} (${dominantPhase.ms}ms over whole ${report.interaction.traceWindow.postInteractMs}ms post-interaction trace window)`);
    if (eventWindow?.dominantPhase) {
      console.log(`Worst-event phase: ${eventWindow.dominantPhase.label} (${eventWindow.dominantPhase.ms}ms over ${eventWindow.durationMs}ms Event Timing window)`);
    }
    for (const warning of report.interaction.warnings || []) console.log(`  ! ${warning}`);
  }
  console.log(`Forced reflows:   ${report.forcedReflows.eventCount} attributed events, ${report.forcedReflows.totalMs}ms`);
  console.log(`  (Blink.ForcedStyleAndLayout markers: ${report.forcedReflows.markerCount ?? 0}, ${report.forcedReflows.markerTotalMs ?? 0}ms — stackless fallback)`);
  if (report.forcedReflows.stacks.length > 0) {
    console.log('\nTop forced-reflow stacks:');
    for (const stack of report.forcedReflows.stacks) {
      console.log(`  ${stack.totalMs}ms across ${stack.count}x - ${stack.topFrame}`);
    }
  } else if (report.forcedReflows.markerCount) {
    console.log('\nNo JS-attributed forced reflows (capture lacks the timeline.stack category);');
    console.log('only the stackless Blink.ForcedStyleAndLayout aggregate above is available.');
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
      interaction: args.interact,
      postInteractMs: args.postInteract,
      cpuThrottleRate: args.cpuThrottleRate,
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
