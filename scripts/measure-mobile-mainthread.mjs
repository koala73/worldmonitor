#!/usr/bin/env node
/**
 * Mobile main-thread attribution harness (#4443 / U2).
 *
 * Loads /dashboard under mobile emulation + CPU throttle and attributes:
 *   - long tasks (PerformanceObserver 'longtask') by source, with TBT contribution
 *   - DOM-node counts per source (map SVG subtree vs panels)
 *
 * The pure attribution functions are exported and unit-tested with fixtures
 * (deterministic, CI-safe). Playwright is loaded lazily so importing this module
 * for its helpers never launches a browser.
 *
 * Why this exists (KTD1, #4443): local mobile Lighthouse is untrustworthy — its
 * `simulate` throttling 4x-amplifies host-CPU contention (the same URL has scored
 * 28/57/85). Long-task *structure* and DOM-node *counts* are stable run-to-run, so
 * this script is the deterministic per-PR R3 signal (reduce vs reorder). Take the
 * authoritative absolute mobile timings from PageSpeed Insights (pagespeed.web.dev).
 *
 * Usage:
 *   node scripts/measure-mobile-mainthread.mjs [url] [--cpu 4] [--settle 15000] [--json]
 *   (default url: https://worldmonitor.app/dashboard)
 */
import { pathToFileURL } from 'node:url';

const TBT_THRESHOLD_MS = 50;

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** TBT contribution of a single task = max(0, duration - 50ms). */
export function tbtContribution(durationMs) {
  return Math.max(0, (Number(durationMs) || 0) - TBT_THRESHOLD_MS);
}

/** First attribution container name (or the entry name) used to bucket a long task. */
function longTaskSource(entry) {
  const attr = Array.isArray(entry?.attribution) ? entry.attribution[0] : null;
  return String(
    attr?.containerName || attr?.containerSrc || attr?.name || entry?.name || 'unknown',
  );
}

/**
 * Group long-task entries by attributed source, summing duration + TBT contribution.
 * Returns rows sorted by TBT contribution (then total duration), descending.
 */
export function rankLongTasks(entries) {
  const bySource = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const dur = Number(entry?.duration) || 0;
    const key = longTaskSource(entry);
    const acc = bySource.get(key) || { source: key, count: 0, totalMs: 0, tbtMs: 0, maxMs: 0 };
    acc.count += 1;
    acc.totalMs += dur;
    acc.tbtMs += tbtContribution(dur);
    acc.maxMs = Math.max(acc.maxMs, dur);
    bySource.set(key, acc);
  }
  return [...bySource.values()]
    .map((r) => ({ ...r, totalMs: round(r.totalMs), tbtMs: round(r.tbtMs), maxMs: round(r.maxMs) }))
    .sort((a, b) => b.tbtMs - a.tbtMs || b.totalMs - a.totalMs);
}

/** Headline long-task summary: counts, total ms, TBT ms, and the per-source ranking. */
export function summarizeLongTasks(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const totalMs = list.reduce((s, e) => s + (Number(e?.duration) || 0), 0);
  const tbtMs = list.reduce((s, e) => s + tbtContribution(e?.duration), 0);
  const longTaskCount = list.filter((e) => (Number(e?.duration) || 0) > TBT_THRESHOLD_MS).length;
  return {
    taskCount: list.length,
    longTaskCount,
    totalMs: round(totalMs),
    tbtMs: round(tbtMs),
    ranked: rankLongTasks(list),
  };
}

/**
 * Attribute DOM nodes across named sources (e.g. { total, mapSvg, panels }).
 * Returns the total plus per-source rows with share %, sorted by node count desc.
 */
export function attributeDomNodes(counts) {
  const entries = Object.entries(counts || {}).filter(([k]) => k !== 'total');
  const total =
    counts && counts.total !== undefined
      ? Number(counts.total) || 0
      : entries.reduce((s, [, v]) => s + (Number(v) || 0), 0);
  const rows = entries
    .map(([source, n]) => ({
      source,
      nodes: Number(n) || 0,
      sharePct: total ? round(((Number(n) || 0) / total) * 100) : 0,
    }))
    .sort((a, b) => b.nodes - a.nodes);
  return { total, rows };
}

export function parseArgs(argv) {
  const args = { url: 'https://worldmonitor.app/dashboard', cpu: 4, settle: 15000, json: false };
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

/** Live capture (best-effort). Loads the URL under mobile emulation + CPU throttle. */
async function measure(url, { cpu = 4, settle = 15000, device = 'iPhone 14 Pro Max' } = {}) {
  const { chromium, devices } = await import('@playwright/test');
  if (!devices[device]) throw new Error(`Unknown Playwright device: ${device}`);
  const browser = await chromium.launch();
  try {
    const { defaultBrowserType, ...descriptor } = devices[device];
    const context = await browser.newContext({ ...descriptor });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    try {
      await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    } catch {
      /* CDP throttle unavailable — continue at host speed */
    }
    await page.addInitScript(() => {
      window.__longtasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longtasks.push({
              name: e.name,
              duration: e.duration,
              startTime: e.startTime,
              attribution: (e.attribution || []).map((a) => ({
                name: a.name,
                containerType: a.containerType,
                containerName: a.containerName,
                containerSrc: a.containerSrc,
              })),
            });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* longtask unsupported */
      }
    });
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(settle);
    const longtasks = await page.evaluate(() => window.__longtasks || []);
    const nodeCounts = await page.evaluate(() => {
      // Count each element at most once. Summing per-match subtrees would double-count
      // a .panel nested inside another .panel; the `, sel *` union keeps it unique.
      const uniqueCount = (sel) => {
        try {
          return document.querySelectorAll(sel).length;
        } catch {
          return 0;
        }
      };
      return {
        total: document.querySelectorAll('*').length,
        mapSvg: uniqueCount('#mapContainer svg, #mapContainer svg *'),
        panels: uniqueCount('.panel, .panel *'),
      };
    });
    return { url, cpu, longtasks, nodeCounts };
  } finally {
    await browser.close();
  }
}

/** Build the structured report (pure — exported for tests). */
export function buildReport(result) {
  return {
    url: result?.url,
    cpu: result?.cpu,
    tasks: summarizeLongTasks(result?.longtasks),
    nodes: attributeDomNodes(result?.nodeCounts),
  };
}

function printHuman(report) {
  const { tasks, nodes } = report;
  console.log(`\nMobile main-thread attribution — ${report.url} (CPU ${report.cpu}x)\n`);
  console.log(
    `Long tasks: ${tasks.taskCount} (${tasks.longTaskCount} >50ms) · total ${tasks.totalMs}ms · TBT ${tasks.tbtMs}ms`,
  );
  for (const r of tasks.ranked) {
    console.log(`  ${String(r.source).padEnd(28)} TBT ${String(r.tbtMs).padStart(7)}ms  (${r.count}× · max ${r.maxMs}ms)`);
  }
  console.log(`\nDOM nodes: ${nodes.total} total`);
  for (const r of nodes.rows) {
    console.log(`  ${r.source.padEnd(28)} ${String(r.nodes).padStart(7)}  (${r.sharePct}%)`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await measure(args.url, { cpu: args.cpu, settle: args.settle });
  const report = buildReport(result);
  // --json emits JSON-only on stdout so `| jq` works; human text is suppressed.
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
