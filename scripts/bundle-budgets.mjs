#!/usr/bin/env node
/**
 * The #7111 client bundle-size gate.
 *
 * The dashboard JS payload grew +151 KB (+11.4%) in five weeks and nothing in
 * CI could see it: `pageWeight.script` only surfaced in a weekly DebugBear
 * email, long after the PRs that shipped the bytes had merged. #7045 gates
 * bootstrap *transfer* (ajax) budgets and never observes the JS bundle.
 *
 * This is the standard mirror-script pair:
 *
 *   npm run bundle:budgets   regenerate scripts/shared/bundle-budgets.json
 *                            from a fresh dist/ (write mode)
 *   npm run bundle:check     compare a fresh dist/ against the committed
 *                            snapshot (check mode; CI runs this in test.yml's
 *                            `unit` job right after the dashboard build)
 *
 * Both modes read an EXISTING dist/ and never build. The dist must come from
 * the same build CI runs, or the numbers are for a different product:
 *
 *   VITE_VARIANT=full ./node_modules/.bin/vite build
 *
 * ENV PARITY MATTERS: budgets are seeded from a build with no .env/.env.local
 * present, because that is what CI builds. Local VITE_ vars change dead-code
 * elimination, not just inlined strings — a populated .env moved the protomaps
 * chunk from 18.1 KB to 55.6 KB. When re-seeding, temporarily move .env and
 * .env.local aside (they are symlinks in worktrees) or the snapshot will fail
 * in CI.
 *
 * Scope: JS assets referenced by dist/dashboard.html — the initial /dashboard
 * payload the issue's DebugBear evidence observes. This includes the entry
 * module and Vite's modulepreload links, but not lazy chunks that are only
 * fetched after the page starts. Hashed rollup chunks aggregate under their
 * stable name; an un-hashed .js emitted there is tracked under its literal
 * filename rather than silently ignored. The /pro subapp payload
 * (dist/pro/assets, built by build:pro from pro-test/) and the embeddable
 * dist-root embed.js are DELIBERATELY out of scope here — they are separate
 * product surfaces with their own build pipelines and follow-up tracking in
 * #7119.
 *
 * Gate semantics:
 *   - RAW bytes are the only gated number. The snapshot also records the file
 *     count so code-splitting changes remain visible without storing compressed
 *     outputs that are not enforced.
 *   - Per chunk, allowed growth is max(DEFAULT_TOLERANCE_BYTES, budget.raw *
 *     DEFAULT_TOLERANCE_PCT / 100). Growth past it is the regression this gate
 *     exists for. Shrinkage past the same band is reported as a warning so an
 *     optimization does not block a PR; re-seeding can ratchet the budget down.
 *   - New chunks and vanished chunks fail until the snapshot is regenerated,
 *     so code-splitting changes surface as a reviewable JSON diff in the PR.
 *   - The initial-payload total is gated with its own tighter tolerance,
 *     max(TOTAL_TOLERANCE_BYTES, 0.25%). Legitimate growth requires the
 *     re-seed that makes it visible in the PR diff.
 *   - Tolerances are code constants. The snapshot records them for reader
 *     context, and check mode REJECTS a snapshot whose recorded tolerances
 *     disagree with the constants — a hand-edited "tolerancePct": 50 must red
 *     the gate, not silently widen it.
 *
 * Exit codes (every non-pass is nonzero — a gate that soft-fails when it
 * cannot measure is green-while-dead, see check-style-layout-budget.mjs):
 *   0  pass (or snapshot written, in write mode)
 *   1  budget violated / snapshot stale
 *   2  could not measure: dist/ or the committed snapshot is missing,
 *      unparseable, or untrustworthy (fails validateBudgetSnapshot)
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMainModule } from './lib/main-module.mjs';

export const DEFAULT_TOLERANCE_PCT = 2;
export const DEFAULT_TOLERANCE_BYTES = 2048;
// The total gets a far tighter band than any single chunk — see the header.
export const TOTAL_TOLERANCE_PCT = 0.25;
export const TOTAL_TOLERANCE_BYTES = 16384;

const DEFAULT_DIST_DIR = 'dist';
const DEFAULT_BUDGET_PATH = 'scripts/shared/bundle-budgets.json';
const BUILD_COMMAND = 'VITE_VARIANT=full ./node_modules/.bin/vite build';

/**
 * 'main-DYSz1bMh.js' -> 'main'. Vite content hashes are exactly 8 chars of
 * [A-Za-z0-9_-] and may themselves contain '-' ('_live-webcams-origin-BScNR-MD.js'),
 * so the greedy prefix keeps the longest possible chunk name and strips only
 * the final hash segment. Returns null for anything that is not a hashed JS
 * chunk (.br/.map siblings, un-hashed dist-root files, CSS).
 */
export function chunkNameFromFileName(fileName) {
  const match = /^(.+)-[A-Za-z0-9_-]{8}\.js$/.exec(fileName);
  return match ? match[1] : null;
}

export function initialDashboardAssetNames(distDir) {
  const dashboardPath = join(distDir, 'dashboard.html');
  let html;
  try {
    html = readFileSync(dashboardPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${dashboardPath} — run: ${BUILD_COMMAND}: ${error.message}`);
  }

  const assets = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js(?:[?#][^"']*)?)["']/gi)) {
    const url = match[1].split(/[?#]/, 1)[0];
    const marker = url.lastIndexOf('/assets/');
    const fileName = marker >= 0
      ? url.slice(marker + '/assets/'.length)
      : url.startsWith('assets/')
        ? url.slice('assets/'.length)
        : null;
    if (fileName && !fileName.includes('/')) assets.add(fileName);
  }
  if (assets.size === 0) {
    throw new Error(`no initial JS assets referenced by ${dashboardPath} — run: ${BUILD_COMMAND}`);
  }
  return [...assets].sort();
}

export function measureDistChunks(distDir) {
  const assetsDir = join(distDir, 'assets');
  const entries = initialDashboardAssetNames(distDir);

  // Several rollup chunks can legitimately share a stable name in ONE build
  // (a real `VITE_VARIANT=full` build emits nine distinct `index-*.js`), so
  // same-name chunks aggregate: sizes sum and the file count is tracked, and a
  // count change forces a re-seed just like a renamed chunk does. Stale mixed
  // dist/ trees are not a concern — vite empties outDir on every build.
  //
  // Null prototype: a chunk named after an Object.prototype key ("toString",
  // "constructor") would otherwise hit the inherited property, skip the ??=
  // assignment, and be silently mismeasured.
  const chunks = Object.create(null);
  for (const fileName of entries) {
    // An UN-hashed .js in dist/assets (a plugin emitting a fixed-name asset)
    // still ships to users, so it is tracked under its literal filename
    // rather than silently ignored. .js.br / .js.map siblings stay excluded.
    const name = chunkNameFromFileName(fileName)
      ?? (fileName.endsWith('.js') ? fileName : null);
    if (!name) continue;
    const filePath = join(assetsDir, fileName);
    let fileStat;
    try {
      fileStat = statSync(filePath);
    } catch (error) {
      throw new Error(`dashboard entry references missing ${filePath} — ${error.message}`);
    }
    if (!fileStat.isFile()) {
      throw new Error(`dashboard entry references non-file asset ${filePath}`);
    }
    const buffer = readFileSync(filePath);
    const entry = (chunks[name] ??= { raw: 0, files: 0 });
    entry.files += 1;
    entry.raw += buffer.length;
  }

  const names = Object.keys(chunks);
  const total = { raw: 0 };
  for (const name of names) {
    total.raw += chunks[name].raw;
  }
  return { chunks, total };
}

export function buildBudgetSnapshot(measured) {
  const chunks = Object.create(null);
  for (const name of Object.keys(measured.chunks).sort()) {
    const { raw, files } = measured.chunks[name];
    chunks[name] = { raw, files };
  }
  return {
    comment:
      'Initial /dashboard bundle-size budgets (#7111). Gated on raw bytes: per chunk '
      + `±max(${DEFAULT_TOLERANCE_BYTES} B, ${DEFAULT_TOLERANCE_PCT}%), total `
      + `±max(${TOTAL_TOLERANCE_BYTES} B, ${TOTAL_TOLERANCE_PCT}%). Tolerance fields here are `
      + 'informational — the gate enforces its own constants and rejects a snapshot that disagrees. '
      + `Regenerate after "${BUILD_COMMAND}" with: npm run bundle:budgets`,
    variant: 'full',
    tolerancePct: DEFAULT_TOLERANCE_PCT,
    toleranceBytes: DEFAULT_TOLERANCE_BYTES,
    totalTolerancePct: TOTAL_TOLERANCE_PCT,
    totalToleranceBytes: TOTAL_TOLERANCE_BYTES,
    total: { raw: measured.total.raw },
    chunks,
  };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function slackFor(budgetRaw, tolerancePct, toleranceBytes) {
  return Math.max(toleranceBytes, Math.round((budgetRaw * tolerancePct) / 100));
}

const isByteCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Structural validation of the committed snapshot, run before any comparison.
 * A snapshot the gate cannot fully trust must be a loud failure, never a
 * quietly narrower check: a hand-deleted `files` field would disable the
 * code-splitting guard, a non-numeric `raw` would NaN-pass every byte gate,
 * and a hand-inflated `total` would decouple the total gate from the chunks
 * it claims to sum. Returns a list of problems; empty means trustworthy.
 */
export function validateBudgetSnapshot(budget) {
  const problems = [];
  if (!budget || typeof budget !== 'object' || !budget.chunks || typeof budget.chunks !== 'object'
    || !budget.total || typeof budget.total !== 'object') {
    return ['snapshot is missing its "chunks" and/or "total" sections'];
  }
  let chunkSum = 0;
  for (const [name, entry] of Object.entries(budget.chunks)) {
    if (!entry || !isByteCount(entry.raw) || !Number.isSafeInteger(entry.files) || entry.files < 1) {
      problems.push(`chunk "${name}" needs a non-negative integer "raw" and a positive integer "files"`);
      continue;
    }
    chunkSum += entry.raw;
  }
  if (!isByteCount(budget.total.raw)) {
    problems.push('"total.raw" must be a non-negative integer');
  } else if (problems.length === 0 && budget.total.raw !== chunkSum) {
    problems.push(
      `"total.raw" (${budget.total.raw}) does not equal the sum of chunk raw sizes (${chunkSum})`,
    );
  }
  // Tolerances are code constants; the snapshot merely records them. A
  // snapshot claiming different tolerances is stale or hand-edited, and the
  // gate must not read as agreeing with numbers it does not enforce.
  if (budget.tolerancePct !== DEFAULT_TOLERANCE_PCT || budget.toleranceBytes !== DEFAULT_TOLERANCE_BYTES
    || budget.totalTolerancePct !== TOTAL_TOLERANCE_PCT || budget.totalToleranceBytes !== TOTAL_TOLERANCE_BYTES) {
    problems.push(
      'recorded tolerance fields do not match the gate\'s constants — the gate enforces only its own constants',
    );
  }
  return problems;
}

export function compareBundleBudgets(measured, budget) {
  const failures = [];
  const warnings = [];
  const reseed = 'rerun the build above, then `npm run bundle:budgets`, and commit the snapshot diff';

  for (const problem of validateBudgetSnapshot(budget)) {
    failures.push(`snapshot invalid: ${problem} — ${reseed}`);
  }
  if (failures.length > 0) return { ok: false, failures, warnings };

  for (const [name, budgeted] of Object.entries(budget.chunks)) {
    const built = Object.hasOwn(measured.chunks, name) ? measured.chunks[name] : undefined;
    if (!built) {
      failures.push(`chunk "${name}" is in the budget but missing from the build — if it was renamed or removed, ${reseed}`);
      continue;
    }
    if (built.files !== budgeted.files) {
      failures.push(
        `chunk "${name}" is now ${built.files} file(s), budgeted as ${budgeted.files} — code splitting changed; ${reseed}`,
      );
    }
    const slack = slackFor(budgeted.raw, DEFAULT_TOLERANCE_PCT, DEFAULT_TOLERANCE_BYTES);
    const delta = built.raw - budgeted.raw;
    if (delta > slack) {
      failures.push(
        `chunk "${name}" grew ${kb(delta)}: ${kb(budgeted.raw)} budgeted -> ${kb(built.raw)} built `
        + `(allowed drift ${kb(slack)}). If the growth is intended, ${reseed}`,
      );
    } else if (-delta > slack) {
      warnings.push(
        `chunk "${name}" shrank ${kb(-delta)}: ${kb(budgeted.raw)} budgeted -> ${kb(built.raw)} built. `
        + `Ratchet the budget down so the headroom cannot silently refill — ${reseed}`,
      );
    }
  }

  for (const name of Object.keys(measured.chunks)) {
    if (!Object.hasOwn(budget.chunks, name)) {
      failures.push(
        `chunk "${name}" (${kb(measured.chunks[name].raw)}) is in the build but not in the budget — ${reseed}`,
      );
    }
  }

  const totalSlack = slackFor(budget.total.raw, TOTAL_TOLERANCE_PCT, TOTAL_TOLERANCE_BYTES);
  const totalDelta = measured.total.raw - budget.total.raw;
  if (totalDelta > totalSlack) {
    failures.push(
      `total JS payload grew ${kb(totalDelta)}: ${kb(budget.total.raw)} budgeted -> `
      + `${kb(measured.total.raw)} built (allowed drift ${kb(totalSlack)}) — ${reseed}`,
    );
  } else if (-totalDelta > totalSlack) {
    warnings.push(
      `total JS payload shrank ${kb(-totalDelta)}: ${kb(budget.total.raw)} budgeted -> `
      + `${kb(measured.total.raw)} built (allowed drift ${kb(totalSlack)}) — Ratchet the budget down — ${reseed}`,
    );
  }

  return { ok: failures.length === 0, failures, warnings };
}

function parseArgs(argv) {
  const args = { check: false, dist: DEFAULT_DIST_DIR, budget: DEFAULT_BUDGET_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--dist') args.dist = argv[(i += 1)];
    else if (arg === '--budget') args.budget = argv[(i += 1)];
    else {
      console.error(`bundle-budgets: unknown argument "${arg}"`);
      process.exit(2);
    }
  }
  if (!args.dist || !args.budget) {
    console.error('bundle-budgets: --dist and --budget need a value');
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let measured;
  try {
    measured = measureDistChunks(resolve(args.dist));
  } catch (error) {
    console.error(`bundle-budgets: ${error.message}`);
    process.exit(2);
  }

  if (!args.check) {
    // Env parity nudge (see header): a dist/ built with local .env/.env.local
    // present diverges from CI's env-clean build via dead-code elimination.
    // The script cannot prove how dist/ was built, so this is a warning, not a
    // refusal — a bad seed still fails loudly on the PR's own CI run.
    if (existsSync('.env') || existsSync('.env.local')) {
      console.warn(
        'bundle-budgets: WARNING — .env/.env.local present; if dist/ was built with them, '
        + 'the snapshot will not match CI. Move them aside and rebuild before seeding.',
      );
    }
    const snapshot = buildBudgetSnapshot(measured);
    writeFileSync(resolve(args.budget), `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `bundle-budgets: wrote ${Object.keys(snapshot.chunks).length} chunk budgets `
      + `(initial payload ${kb(snapshot.total.raw)} raw) to ${args.budget}`,
    );
    return;
  }

  let budget;
  try {
    budget = JSON.parse(readFileSync(resolve(args.budget), 'utf8'));
  } catch (error) {
    console.error(`bundle-budgets: cannot read budget ${args.budget}: ${error.message}`);
    process.exit(2);
  }

  // An untrustworthy snapshot is "cannot measure" (exit 2), not a size
  // violation — the numbers it would gate against are not credible.
  const snapshotProblems = validateBudgetSnapshot(budget);
  if (snapshotProblems.length > 0) {
    console.error(`bundle:check cannot trust ${args.budget}:`);
    for (const problem of snapshotProblems) console.error(`  - ${problem}`);
    console.error('  regenerate it: npm run bundle:budgets (against a fresh CI-parity build)');
    process.exit(2);
  }

  const result = compareBundleBudgets(measured, budget);
  if (!result.ok) {
    console.error(`bundle:check FAILED — ${result.failures.length} violation(s):`);
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  for (const warning of result.warnings) console.warn(`bundle:check WARNING — ${warning}`);
  console.log(
    `bundle:check OK — ${Object.keys(budget.chunks).length} chunks within `
    + `±max(${DEFAULT_TOLERANCE_BYTES} B, ${DEFAULT_TOLERANCE_PCT}%), total within `
    + `±max(${TOTAL_TOLERANCE_BYTES} B, ${TOTAL_TOLERANCE_PCT}%) (${kb(measured.total.raw)} raw)`,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
