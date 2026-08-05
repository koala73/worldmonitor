#!/usr/bin/env node
/**
 * The #4536 styleLayout gate (#4487 render axis).
 *
 * `docs/perf/desktop-mainthread-baseline-2026-07-02.md:103` names the
 * styleLayout share as the gate for forced reflow, and nothing enforced it.
 * Worse than nothing: `tests/measure-*-mainthread.test.mts` DO run in CI via
 * `test:data`, but they exercise fixture parsing only — the Playwright harness
 * never launches and no measured number is asserted — so a green
 * "measure-desktop-mainthread" check reads as perf coverage while measuring
 * nothing.
 *
 * This consumes `scripts/measure-desktop-mainthread.mjs --json` and fails when
 * the styleLayout share of attributed main-thread self-time exceeds the budget.
 *
 * Deliberately gates the SHARE, not absolute milliseconds. KTD1 (recorded in
 * both baseline docs) is that local lab absolutes are host-contention
 * contaminated — the same URL has scored 28/57/85 — while the relative
 * decomposition is stable across throttle levels and hosts. Gating absolutes
 * would produce a flaky check that gets muted; gating the share does not.
 *
 * Exit codes are split so the reason is legible, but EVERY non-pass is nonzero:
 *   0  budget respected against a capture that satisfied the contract
 *   1  styleLayout share exceeded the budget — a real regression
 *   2  the gate itself was misused (bad args / unreadable input)
 *   3  the run did not produce a valid measurement
 *
 * Exit 3 is deliberately NOT 0. An earlier revision soft-failed here to keep
 * environmental flakiness out of the build, which reproduced the exact defect
 * this gate exists to replace: a scheduled alarm that is green while measuring
 * nothing. A scheduled workflow's only channel is pass/fail, so "I could not
 * measure" has to be visible, and a transient red that self-heals next cycle is
 * far cheaper than a permanently dead gate nobody notices.
 *
 * Usage:
 *   node scripts/measure-desktop-mainthread.mjs <url> --cpu 1 --json > report.json
 *   node scripts/check-style-layout-budget.mjs report.json [--max-pct 28] [--expect-url /dashboard]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Budget for the styleLayout share, in percent of attributed main-thread
 * self-time.
 *
 * Derived from the committed baseline, NOT invented: 2026-07-02 measured 22.1%
 * at cpu 1 and 23.3% at cpu 4, and the doc records a cross-capture range of
 * ~19-23.3%. 28 sits ~5 points above the worst observed capture — loose enough
 * that host variance alone cannot trip it, tight enough that a genuine return
 * of the forced-reflow cost does.
 */
export const DEFAULT_MAX_STYLE_LAYOUT_PCT = 28;

/**
 * Floor below which the capture is not a hydrated dashboard.
 *
 * `categorize()` in the harness SEEDS all six categories at 0, so
 * `buildDecomposition` ALWAYS emits a `styleLayout` entry — checking only for an
 * absent category is dead code against the real producer, and a fixture that
 * omits it is inert. An error page, a redirect, or an unhydrated shell still
 * attributes scripting/parseHTML work, so `mainThreadMs > 0` while styleLayout
 * sits near zero. A real `/dashboard` capture has never measured below ~19%
 * (committed range 19–23.3%), so anything under this floor means "we did not
 * measure the dashboard", not "reflow is free".
 */
export const MIN_PLAUSIBLE_STYLE_LAYOUT_PCT = 5;

/**
 * Floor for total attributed self-time. A 15 s dashboard capture attributes
 * seconds (baseline: 10.8 s at cpu 1); a few hundred ms means the page never
 * really ran.
 */
export const MIN_PLAUSIBLE_MAIN_THREAD_MS = 1000;

/** Category key emitted by `buildDecomposition` for style + layout work. */
const STYLE_LAYOUT_CATEGORY = 'styleLayout';

/**
 * Decide the gate verdict for one harness report.
 *
 * Returns `unmeasured` — never `pass` — whenever the report cannot support a
 * judgement. An empty or partial trace yields a 0% styleLayout share, and
 * reporting that as healthy is exactly how a gate goes green while dead.
 *
 * @param {unknown} report Parsed `--json` output of measure-desktop-mainthread.
 * @param {{ maxPct?: number }} [options]
 * @returns {{ status: 'pass'|'regressed'|'unmeasured', pct: number|null, maxPct: number, reason: string }}
 */
export function evaluateStyleLayoutBudget(report, options = {}) {
  const maxPct = typeof options.maxPct === 'number' && Number.isFinite(options.maxPct)
    ? options.maxPct
    : DEFAULT_MAX_STYLE_LAYOUT_PCT;
  const expectedUrlSuffix = typeof options.expectedUrlSuffix === 'string'
    ? options.expectedUrlSuffix
    : null;
  const unmeasured = (reason) => ({ status: 'unmeasured', pct: null, maxPct, reason });

  if (!report || typeof report !== 'object') return unmeasured('report is not an object');

  // The harness sets this when it refuses to attribute (no CrRendererMain thread).
  const warning = /** @type {{ warning?: unknown }} */ (report).warning;
  if (typeof warning === 'string' && warning.length > 0) {
    return unmeasured(`harness declined to attribute: ${warning}`);
  }

  // Wrong page: a redirect, an error page, or an auth wall still produces a
  // perfectly numeric trace, so the URL is part of the capture contract.
  const url = /** @type {{ url?: unknown }} */ (report).url;
  if (expectedUrlSuffix) {
    if (typeof url !== 'string' || url.length === 0) {
      return unmeasured('report carries no url — cannot confirm what was captured');
    }
    const path = url.split('?')[0].split('#')[0].replace(/\/$/, '');
    if (!path.endsWith(expectedUrlSuffix)) {
      return unmeasured(`captured ${url}, expected a URL ending in '${expectedUrlSuffix}'`);
    }
  }

  const categories = /** @type {{ categories?: unknown }} */ (report).categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    return unmeasured('report has no categories — the trace captured nothing');
  }

  const mainThreadMs = /** @type {{ mainThreadMs?: unknown }} */ (report).mainThreadMs;
  if (typeof mainThreadMs !== 'number' || !Number.isFinite(mainThreadMs)) {
    return unmeasured('report has no numeric mainThreadMs — nothing was attributed');
  }
  if (mainThreadMs < MIN_PLAUSIBLE_MAIN_THREAD_MS) {
    return unmeasured(
      `only ${mainThreadMs}ms of attributed main-thread self-time (floor ${MIN_PLAUSIBLE_MAIN_THREAD_MS}ms) — the page never really ran`,
    );
  }

  const entry = categories.find(
    (c) => c && typeof c === 'object' && c.category === STYLE_LAYOUT_CATEGORY,
  );
  if (!entry) {
    // The real producer seeds every category, so absence means a hand-made or
    // truncated report rather than zero reflow.
    return unmeasured(`no '${STYLE_LAYOUT_CATEGORY}' category in a non-empty decomposition`);
  }

  const pct = entry.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return unmeasured(`'${STYLE_LAYOUT_CATEGORY}' has a non-numeric pct`);
  }

  if (pct < MIN_PLAUSIBLE_STYLE_LAYOUT_PCT) {
    // The dangerous direction: 0% reads as "perfect" but means the dashboard
    // never rendered. Never a pass.
    return unmeasured(
      `styleLayout is only ${pct}% (floor ${MIN_PLAUSIBLE_STYLE_LAYOUT_PCT}%) — implausible for a hydrated /dashboard capture`,
    );
  }

  if (pct > maxPct) {
    return {
      status: 'regressed',
      pct,
      maxPct,
      reason: `styleLayout is ${pct}% of attributed main-thread self-time, over the ${maxPct}% budget`,
    };
  }

  return { status: 'pass', pct, maxPct, reason: `styleLayout ${pct}% is within the ${maxPct}% budget` };
}

function parseArgs(argv) {
  const args = { file: null, maxPct: DEFAULT_MAX_STYLE_LAYOUT_PCT, expectedUrlSuffix: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--max-pct') {
      const next = Number(rest[++i]);
      if (!Number.isFinite(next)) throw new Error('--max-pct requires a number');
      args.maxPct = next;
    } else if (a === '--expect-url') {
      const next = rest[++i];
      if (!next || next.startsWith('--')) throw new Error('--expect-url requires a path suffix');
      args.expectedUrlSuffix = next;
    } else if (!a.startsWith('--') && args.file === null) {
      args.file = a;
    }
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`[style-layout-budget] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (!args.file) {
    console.error('[style-layout-budget] usage: check-style-layout-budget.mjs <report.json> [--max-pct N]');
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (err) {
    console.error(`[style-layout-budget] cannot read ${args.file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const verdict = evaluateStyleLayoutBudget(report, {
    maxPct: args.maxPct,
    expectedUrlSuffix: args.expectedUrlSuffix,
  });
  if (verdict.status === 'regressed') {
    console.error(`[style-layout-budget] REGRESSION: ${verdict.reason}`);
    console.error('[style-layout-budget] see docs/perf/desktop-mainthread-baseline-2026-07-02.md');
    process.exit(1);
  }
  if (verdict.status === 'unmeasured') {
    // Nonzero on purpose — see the exit-code note at the top of this file.
    console.error(`[style-layout-budget] NO VALID MEASUREMENT: ${verdict.reason}`);
    console.error('[style-layout-budget] the capture contract was not satisfied; this is not a pass');
    process.exit(3);
  }
  console.log(`[style-layout-budget] OK: ${verdict.reason}`);
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(realpathSync(process.argv[1])).href
    === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
if (invokedDirectly) main();
