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
 * Exit codes are split so a broken measurement can never read as a pass:
 *   0  budget respected, or the run could not measure (soft-fail, warns loudly)
 *   1  styleLayout share exceeded the budget — a real regression
 *   2  the gate itself was misused (bad args / unreadable input)
 *
 * Usage:
 *   node scripts/measure-desktop-mainthread.mjs <url> --cpu 1 --json > report.json
 *   node scripts/check-style-layout-budget.mjs report.json [--max-pct 28]
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
  const unmeasured = (reason) => ({ status: 'unmeasured', pct: null, maxPct, reason });

  if (!report || typeof report !== 'object') return unmeasured('report is not an object');

  const categories = /** @type {{ categories?: unknown }} */ (report).categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    return unmeasured('report has no categories — the trace captured nothing');
  }

  const mainThreadMs = /** @type {{ mainThreadMs?: unknown }} */ (report).mainThreadMs;
  if (typeof mainThreadMs !== 'number' || !Number.isFinite(mainThreadMs) || mainThreadMs <= 0) {
    return unmeasured('report has no positive mainThreadMs — nothing was attributed');
  }

  const entry = categories.find(
    (c) => c && typeof c === 'object' && c.category === STYLE_LAYOUT_CATEGORY,
  );
  if (!entry) {
    // A real dashboard capture always attributes some style/layout work. Its
    // absence means the decomposition is incomplete, not that reflow is free.
    return unmeasured(`no '${STYLE_LAYOUT_CATEGORY}' category in a non-empty decomposition`);
  }

  const pct = entry.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return unmeasured(`'${STYLE_LAYOUT_CATEGORY}' has a non-numeric pct`);
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
  const args = { file: null, maxPct: DEFAULT_MAX_STYLE_LAYOUT_PCT };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--max-pct') {
      const next = Number(rest[++i]);
      if (!Number.isFinite(next)) throw new Error('--max-pct requires a number');
      args.maxPct = next;
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

  const verdict = evaluateStyleLayoutBudget(report, { maxPct: args.maxPct });
  if (verdict.status === 'regressed') {
    console.error(`[style-layout-budget] REGRESSION: ${verdict.reason}`);
    console.error('[style-layout-budget] see docs/perf/desktop-mainthread-baseline-2026-07-02.md');
    process.exit(1);
  }
  if (verdict.status === 'unmeasured') {
    // Soft-fail: the page may be unreachable or the trace empty. Loud, but not a
    // red build — an environmental failure must not be indistinguishable from a
    // code regression.
    console.warn(`[style-layout-budget] WARNING — could not measure: ${verdict.reason}`);
    process.exit(0);
  }
  console.log(`[style-layout-budget] OK: ${verdict.reason}`);
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(realpathSync(process.argv[1])).href
    === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
if (invokedDirectly) main();
