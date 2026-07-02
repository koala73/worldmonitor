#!/usr/bin/env node
/**
 * Desktop main-thread attribution harness (#4539 / #4487) — the desktop twin of
 * scripts/measure-mobile-mainthread.mjs (#4458).
 *
 * Captures a Chrome DevTools performance trace of /dashboard under a desktop
 * viewport (+ optional CPU throttle) via CDP, then decomposes renderer
 * main-thread SELF-TIME by trace-event name into categories — the point being to
 * crack open the coarse "Other" bucket (desktop: 52% / ~11s, uncharacterized —
 * #4539) into the named native events that actually compose it: forced
 * Layout/reflow, HitTest, Paint/Composite/Raster/GPU, GC, and scheduler overhead.
 *
 * Why self-time by event name (not Lighthouse's coarse groups): Lighthouse's
 * `mainthread-work-breakdown` already reports Script/Style&Layout/Other, but
 * "Other" is exactly the black box we need to open. Aggregating raw-trace
 * self-time per event name dissolves "Other" into its constituents.
 *
 * Philosophy mirrors #4458 (KTD1): local lab ABSOLUTES are host-contention
 * contaminated (#4486: the same URL scored 28/57/85), so trust the RELATIVE
 * category split this produces and take authoritative absolute desktop timings
 * from PageSpeed/Calibre. The pure attribution functions are exported and
 * unit-tested with fixtures (deterministic, CI-safe); Playwright is imported
 * lazily so importing this module for its helpers never launches a browser.
 *
 * Usage:
 *   node scripts/measure-desktop-mainthread.mjs [url] [--cpu 1] [--settle 15000] [--json]
 *   (default url: https://www.worldmonitor.app/dashboard; --cpu 1 = no throttle, matches Lighthouse desktop)
 */
import { pathToFileURL } from 'node:url';

const TBT_THRESHOLD_MS = 50;
const TRACE_COMPLETE_TIMEOUT_MS = 30000;

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Trace-event name -> main-thread work category. Names not listed fall through to
 * 'other', and every 'other' event is itemized by name in the report so the
 * bucket is never a black box. Grouping mirrors Lighthouse's taskGroups so the
 * category totals are comparable to its main-thread-work-breakdown.
 */
const CATEGORY_BY_EVENT = new Map(Object.entries({
  // scripting (eval + parse/compile + JS-driven dispatch)
  FunctionCall: 'scripting',
  EvaluateScript: 'scripting',
  'v8.evaluateModule': 'scripting',
  'V8.Execute': 'scripting',
  EventDispatch: 'scripting',
  TimerFire: 'scripting',
  FireAnimationFrame: 'scripting',
  FireIdleCallback: 'scripting',
  RunMicrotasks: 'scripting',
  XHRReadyStateChange: 'scripting',
  XHRLoad: 'scripting',
  'v8.compile': 'scripting',
  'V8.CompileCode': 'scripting',
  'V8.CompileScript': 'scripting',
  'v8.parseOnBackground': 'scripting',
  // style + layout (forced reflow lives here — shared root with #4536)
  Layout: 'styleLayout',
  'Layout::performLayout': 'styleLayout',
  UpdateLayoutTree: 'styleLayout',
  RecalculateStyles: 'styleLayout',
  ScheduleStyleRecalculation: 'styleLayout',
  InvalidateLayout: 'styleLayout',
  HitTest: 'styleLayout',
  ParseAuthorStyleSheet: 'styleLayout',
  // paint + composite + raster + GPU (Lighthouse groups layer-tree updates here, not styleLayout)
  Paint: 'paintComposite',
  UpdateLayerTree: 'paintComposite',
  UpdateLayer: 'paintComposite',
  PrePaint: 'paintComposite',
  'Composite Layers': 'paintComposite',
  CompositeLayers: 'paintComposite',
  Commit: 'paintComposite',
  RasterTask: 'paintComposite',
  Rasterize: 'paintComposite',
  ImageDecodeTask: 'paintComposite',
  Draw: 'paintComposite',
  DrawFrame: 'paintComposite',
  PaintImage: 'paintComposite',
  Decode_Image: 'paintComposite',
  DecodeImage: 'paintComposite',
  GPUTask: 'paintComposite',
  // garbage collection
  MinorGC: 'garbageCollection',
  MajorGC: 'garbageCollection',
  'V8.GCScavenger': 'garbageCollection',
  'V8.GCFinalizeMC': 'garbageCollection',
  'V8.GCFinalizeMCReduce': 'garbageCollection',
  'V8.GCIncrementalMarking': 'garbageCollection',
  'BlinkGC.AtomicPhase': 'garbageCollection',
  'ThreadState::performIdleLazySweep': 'garbageCollection',
  'ThreadState::completeSweep': 'garbageCollection',
  // parse/loading
  ParseHTML: 'parseHTML',
  CommitLoad: 'parseHTML',
  ResourceReceiveResponse: 'parseHTML',
  ResourceReceivedData: 'parseHTML',
  ResourceFinish: 'parseHTML',
  ResourceSendRequest: 'parseHTML',
}));

/** Category for a trace-event name; unmapped names are 'other' (and itemized). */
export function categoryOf(name) {
  return CATEGORY_BY_EVENT.get(String(name)) || 'other';
}

/**
 * Normalize raw traceEvents into duration-bearing complete events
 * ({name, ts, dur, pid, tid}). `X` (complete) events are taken directly; `B`/`E`
 * (begin/end) pairs are matched per (pid,tid) via a stack. Instant + metadata
 * events are dropped. ts/dur stay in the trace's native microseconds.
 */
export function normalizeCompleteEvents(events) {
  const out = [];
  const stacks = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.ph !== 'string') continue;
    if (e.ph === 'X') {
      if (typeof e.ts === 'number' && typeof e.dur === 'number') {
        out.push({ name: String(e.name || 'unknown'), ts: e.ts, dur: e.dur, pid: e.pid, tid: e.tid });
      }
    } else if (e.ph === 'B') {
      const key = `${e.pid}:${e.tid}`;
      if (!stacks.has(key)) stacks.set(key, []);
      stacks.get(key).push(e);
    } else if (e.ph === 'E') {
      const st = stacks.get(`${e.pid}:${e.tid}`);
      if (st && st.length) {
        const b = st.pop();
        if (typeof b.ts === 'number' && typeof e.ts === 'number') {
          out.push({ name: String(b.name || 'unknown'), ts: b.ts, dur: e.ts - b.ts, pid: b.pid, tid: b.tid });
        }
      }
    }
  }
  return out;
}

/**
 * Identify the busiest CrRendererMain (pid:tid) — the target page's renderer main
 * thread. Picking the busiest among threads named CrRendererMain excludes worker
 * threads (they are named differently), but a cross-origin iframe or prerender
 * runs its own CrRendererMain, so this assumes the top-level dashboard frame is
 * the busiest renderer (true in practice; a heavy third-party embed out-busying
 * the top frame is a known limitation). Returns "pid:tid" or null when none found.
 */
export function pickRendererMainThread(events) {
  const list = Array.isArray(events) ? events : [];
  const candidates = new Set();
  for (const e of list) {
    if (e && e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') {
      candidates.add(`${e.pid}:${e.tid}`);
    }
  }
  if (candidates.size === 0) return null;
  const durByThread = new Map();
  for (const e of normalizeCompleteEvents(list)) {
    const key = `${e.pid}:${e.tid}`;
    if (!candidates.has(key)) continue;
    if (typeof e.dur === 'number') durByThread.set(key, (durByThread.get(key) || 0) + e.dur);
  }
  let best = null;
  let bestDur = -1;
  for (const [key, d] of durByThread) {
    if (d > bestDur) { bestDur = d; best = key; }
  }
  return best;
}

/**
 * Self-time by event name for a set of same-thread complete events. Self-time =
 * a node's duration minus the duration of its direct children (properly nested
 * per thread in Chrome traces). Unit-agnostic: returns the same unit as the input
 * `dur`. Negative self (malformed overlap) is clamped to 0.
 */
export function computeSelfTimeByName(events) {
  const evs = [...(Array.isArray(events) ? events : [])]
    .filter((e) => e && typeof e.ts === 'number' && typeof e.dur === 'number' && e.dur >= 0)
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const nodes = [];
  const stack = [];
  for (const e of evs) {
    const end = e.ts + e.dur;
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
    const node = { name: e.name, self: e.dur, end };
    if (stack.length) stack[stack.length - 1].self -= e.dur;
    stack.push(node);
    nodes.push(node);
  }
  const byName = new Map();
  let total = 0;
  for (const n of nodes) {
    const s = Math.max(0, n.self);
    total += s;
    byName.set(n.name, (byName.get(n.name) || 0) + s);
  }
  return { byName, total };
}

/**
 * Fold a self-time-by-name map into category totals plus an itemized breakdown
 * of the 'other' bucket (the point of the harness). Input/output share the
 * caller's unit; the report layer converts microseconds to milliseconds.
 */
export function categorize(byName) {
  const byCategory = {
    scripting: 0,
    styleLayout: 0,
    paintComposite: 0,
    garbageCollection: 0,
    parseHTML: 0,
    other: 0,
  };
  const otherByName = new Map();
  let total = 0;
  for (const [name, amount] of byName instanceof Map ? byName : new Map(Object.entries(byName || {}))) {
    const cat = categoryOf(name);
    byCategory[cat] += amount;
    total += amount;
    if (cat === 'other') otherByName.set(name, (otherByName.get(name) || 0) + amount);
  }
  const otherBreakdown = [...otherByName.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  return { total, byCategory, otherBreakdown };
}

/** Convert a raw (microsecond) category decomposition into a shares-first report block. */
export function buildDecomposition(byName, { topOther = 15 } = {}) {
  const { total, byCategory, otherBreakdown } = categorize(byName);
  const pct = (v) => (total ? round((v / total) * 100) : 0);
  const categories = Object.entries(byCategory)
    .map(([category, us]) => ({ category, ms: round(us / 1000), pct: pct(us) }))
    .sort((a, b) => b.ms - a.ms);
  const other = otherBreakdown
    .slice(0, topOther)
    .map(({ name, amount }) => ({ name, ms: round(amount / 1000), pct: pct(amount) }));
  return { mainThreadMs: round(total / 1000), categories, other };
}

/* ---- long-task attribution (bonus cross-check, mirrors #4458) ---- */

function tbtContribution(durationMs) {
  return Math.max(0, (Number(durationMs) || 0) - TBT_THRESHOLD_MS);
}

export function summarizeLongTasks(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const totalMs = list.reduce((s, e) => s + (Number(e?.duration) || 0), 0);
  const tbtMs = list.reduce((s, e) => s + tbtContribution(e?.duration), 0);
  const longTaskCount = list.filter((e) => (Number(e?.duration) || 0) > TBT_THRESHOLD_MS).length;
  return { taskCount: list.length, longTaskCount, totalMs: round(totalMs), tbtMs: round(tbtMs) };
}

export function parseArgs(argv) {
  const args = { url: 'https://www.worldmonitor.app/dashboard', cpu: 1, settle: 15000, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--cpu') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.cpu = n;
    } else if (a === '--settle') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.settle = n;
    } else if (a === '--json') {
      args.json = true;
    } else if (!a.startsWith('--')) {
      args.url = a;
    }
  }
  return args;
}

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'v8',
  'v8.execute',
  'blink.user_timing',
  'toplevel',
  'latencyInfo',
];

/** Read a CDP IO stream to completion, decoding base64 chunks when flagged. */
async function readTraceStream(client, handle) {
  let data = '';
  let eof = false;
  while (!eof) {
    const chunk = await client.send('IO.read', { handle, size: 1024 * 1024 });
    data += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
    eof = chunk.eof;
  }
  await client.send('IO.close', { handle });
  return data;
}

function waitForTraceComplete(client, timeoutMs = TRACE_COMPLETE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timer;
    const onComplete = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
    timer = setTimeout(() => {
      if (typeof client.off === 'function') client.off('Tracing.tracingComplete', onComplete);
      reject(new Error(`Timed out waiting ${timeoutMs}ms for Tracing.tracingComplete`));
    }, timeoutMs);
    client.once('Tracing.tracingComplete', onComplete);
  });
}

/** Live capture (best-effort). Loads the URL under a desktop viewport + optional CPU throttle and records a trace. */
async function measure(url, { cpu = 1, settle = 15000 } = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1350, height: 940 },
      deviceScaleFactor: 1,
      isMobile: false,
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    if (cpu > 1) {
      try {
        await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      } catch {
        /* CDP throttle unavailable — continue at host speed */
      }
    }
    await page.addInitScript(() => {
      window.__longtasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longtasks.push({ name: e.name, duration: e.duration, startTime: e.startTime });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* longtask unsupported */
      }
    });
    await client.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      // recordAsMuchAsPossible (not recordUntilFull): don't stop at the first ring-buffer
      // fill over a busy 15s settle, which would drop late paint/interaction events and
      // bias the *relative* split toward early-load parse/script work.
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATEGORIES },
    });
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(settle);
    const completePromise = waitForTraceComplete(client);
    await client.send('Tracing.end');
    const { stream } = await completePromise;
    if (!stream) throw new Error('Tracing completed without an IO stream');
    const raw = await readTraceStream(client, stream);
    const trace = JSON.parse(raw);
    const longtasks = await page.evaluate(() => window.__longtasks || []);
    return { url, cpu, trace, longtasks };
  } finally {
    await browser.close();
  }
}

/** Build the structured report (pure — exported for tests). */
export function buildReport(result) {
  const events = result?.trace?.traceEvents || (Array.isArray(result?.trace) ? result.trace : []);
  const mainThread = pickRendererMainThread(events);
  const longTasks = summarizeLongTasks(result?.longtasks);
  if (!mainThread) {
    // No CrRendererMain metadata - we cannot isolate one properly-nested thread.
    // Mixing all threads' concurrent events into the self-time stack would violate
    // its precondition, so refuse to attribute rather than emit a plausible but
    // wrong split.
    return {
      url: result?.url,
      cpu: result?.cpu,
      mainThread: null,
      mainThreadMs: 0,
      categories: [],
      other: [],
      longTasks,
      warning: 'no CrRendererMain thread found in trace; not attributing',
    };
  }
  const complete = normalizeCompleteEvents(events).filter((e) => `${e.pid}:${e.tid}` === mainThread);
  const { byName } = computeSelfTimeByName(complete);
  return {
    url: result?.url,
    cpu: result?.cpu,
    mainThread,
    ...buildDecomposition(byName),
    longTasks,
  };
}

function printHuman(report) {
  console.log(`\nDesktop main-thread attribution — ${report.url} (CPU ${report.cpu}x)\n`);
  console.log(`Main-thread self-time total: ${report.mainThreadMs}ms  (thread ${report.mainThread || 'unknown'})`);
  console.log(
    `Long tasks: ${report.longTasks.taskCount} (${report.longTasks.longTaskCount} >50ms)`
    + ` · total ${report.longTasks.totalMs}ms · TBT ${report.longTasks.tbtMs}ms\n`,
  );
  console.log('By category (share of attributed main-thread self-time):');
  for (const c of report.categories) {
    console.log(`  ${c.category.padEnd(20)} ${String(c.ms).padStart(9)}ms  (${c.pct}%)`);
  }
  console.log('\n"Other" decomposed (top events — this is the #4539 black box):');
  for (const o of report.other) {
    console.log(`  ${o.name.padEnd(36)} ${String(o.ms).padStart(9)}ms  (${o.pct}%)`);
  }
  if (report.warning) {
    console.log('\nWarnings:');
    console.log('  ' + report.warning);
  }
  console.log('\nNote: absolute ms is host-contention-sensitive (#4486). Trust the RELATIVE');
  console.log('shares here; take authoritative absolute desktop timings from PageSpeed/Calibre.\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await measure(args.url, { cpu: args.cpu, settle: args.settle });
  const report = buildReport(result);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
