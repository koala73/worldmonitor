#!/usr/bin/env node
// Regenerates every committed derived file (product facts, docs stats, llms,
// AI search, catalogs, locales, legal digests, …) whose freshness check
// fails. Stale derived files were over half of CI test failures, and fixing
// one meant finding which of these generators the failing test wanted.
//
//   npm run generate          # rewrite whatever is stale
//   npm run generate:check    # exit 1 and list the stale steps
//
// Each step runs its own --check first and writes only when that fails, so
// generators that stamp today's date or rebuild PDFs do not churn files that
// are already current. Generators read each other's outputs, so passes repeat
// until every check is green.
//
// Not covered: `make generate` (proto + OpenAPI; the pre-push hook runs it),
// app translations (scripts/translate-locales.mjs needs ANTHROPIC_API_KEY),
// scripts/internal-links.mjs (needs TYPESAFE_API_KEY), and the sitemap and
// docs page dates, which follow main's commit dates and are refreshed on
// schedule and at build time rather than per branch.
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const TSX = [NODE, '--import', 'tsx'];
const MAX_PASSES = 3;
// The --check commands only read, so they run side by side. Four workers took
// the pre-push check from 6.5-7.1 s to about 2 s on an 18-core Mac; eight was
// no faster. Writes stay sequential because generators read each other's output.
const CHECK_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism()));

// [name, command, write flag]. Every command also accepts --check. Order
// follows the data flow: the product config feeds the facts, which feed AI
// search and the crawlable pages.
export const STEPS = [
  ['browser news catalog', [...TSX, 'scripts/generate-browser-news-catalog.mjs']],
  ['product facts', [...TSX, 'scripts/generate-public-product-facts.mjs']],
  ['entitlement crosswalk', [NODE, 'scripts/generate-entitlement-crosswalk.mjs']],
  ['country corpus slugs', [...TSX, 'scripts/generate-country-corpus-slugs.mjs']],
  ['llms.txt', [...TSX, 'scripts/build-llms-full.mjs']],
  ['AI search', [...TSX, 'scripts/build-ai-search.mjs']],
  ['welcome teasers', [NODE, 'scripts/build-welcome-teasers.mjs']],
  ['resilience coverage', [...TSX, 'scripts/sync-resilience-coverage.mjs']],
  ['agent skills index', [NODE, 'scripts/build-agent-skills-index.mjs']],
  ['source attribution', [NODE, 'scripts/source-attribution.mjs'], '--write'],
  ['MCP source providers', [NODE, 'scripts/generate-mcp-source-providers.mjs']],
  ['locale keys', [NODE, 'scripts/sync-locale-keys.mjs']],
  ['zh-TW locales', ['python3', 'scripts/convert-zh-tw.py']],
  ['bootstrap tier keys', [NODE, 'scripts/sync-bootstrap-tier-keys.mjs']],
  ['live video channels', [...TSX, 'scripts/sync-live-video-refresh-channels.mjs']],
  ['TUI catalog', [...TSX, 'scripts/sync-tui-catalog.mjs']],
  ['sandbox fixtures', [NODE, 'scripts/generate-sandbox-fixtures.mjs']],
  ['population density boundaries', [...TSX, 'scripts/generate-population-density-boundaries.mjs']],
  ['scorecard edge mirrors', [NODE, 'scripts/generate-scorecard-edge-mirrors.mjs']],
  ['Sentry Convex probe filters', [NODE, 'scripts/sync-sentry-convex-probe-filters.mjs'], '--write'],
  ['legal digests', [NODE, 'scripts/legal-digests.mjs']],
  ['legal PDFs', [NODE, 'scripts/build-legal-pdfs.mjs']],
  ['story phase fading study', [NODE, 'scripts/study-story-phase-fading.mjs']],
  ['desktop version', [NODE, 'scripts/sync-desktop-version.mjs']],
];

function run([cmd, ...args], flag) {
  const result = spawnSync(cmd, flag ? [...args, flag] : args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`.trim() };
}

function runAsync([cmd, ...args], flag) {
  return new Promise((done) => {
    let output = '';
    const child = spawn(cmd, flag ? [...args, flag] : args, { cwd: ROOT });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    // A command that cannot start emits 'error' and may never emit 'close'.
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; done({ ok, output: output.trim() }); } };
    child.on('error', (error) => { output += error.message; settle(false); });
    child.on('close', (status) => settle(status === 0));
  });
}

// Runs each step's --check with at most `concurrency` at once. Returns the stale
// steps, with their output, in the order STEPS declares them.
export async function checkSteps(steps, { concurrency = CHECK_CONCURRENCY, runner = (command) => runAsync(command, '--check') } = {}) {
  const results = new Array(steps.length);
  let next = 0;
  const worker = async () => {
    while (next < steps.length) {
      const index = next++;
      results[index] = await runner(steps[index][1]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, steps.length) }, worker));
  return steps.flatMap(([name, command, writeFlag], index) => (
    results[index].ok ? [] : [[name, command, writeFlag, results[index].output]]
  ));
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  // The product config has no --check; it is cheap and deterministic, so the
  // write mode always runs it (the pre-push pro-test gate checks it).
  if (!checkOnly) {
    const config = run([...TSX, 'scripts/generate-product-config.mjs']);
    if (!config.ok) {
      console.error(`generate: product config failed:\n${config.output}`);
      return 1;
    }
  }
  const hasOpenCC = spawnSync('python3', ['-c', 'import opencc'], { stdio: 'ignore' }).status === 0;
  const steps = STEPS.filter(([name]) => name !== 'zh-TW locales' || hasOpenCC);
  if (!hasOpenCC) console.warn('generate: skipped zh-TW locales (pip install opencc-python-reimplemented==0.1.7)');

  const regenerated = new Set();
  for (let pass = 0; ; pass++) {
    // Inventory facts are gitignored, read by later steps, and derived from the
    // product facts, so every pass refreshes them before checking.
    const inventory = run([NODE, 'scripts/generate-inventory-facts.mjs']);
    if (!inventory.ok) {
      console.error(`generate: inventory facts failed:\n${inventory.output}`);
      return 1;
    }
    const stale = await checkSteps(steps);
    if (stale.length === 0) {
      console.log(regenerated.size ? `generate: regenerated ${[...regenerated].join(', ')}` : 'generate: all derived files are current');
      return 0;
    }
    if (checkOnly) {
      for (const [name, , , output] of stale) console.error(`generate: ${name} is stale:\n${output}\n`);
      console.error('Run `npm run generate` and commit the result.');
      return 1;
    }
    if (pass === MAX_PASSES) {
      console.error(`generate: still stale after ${MAX_PASSES} passes: ${stale.map(([name]) => name).join(', ')}`);
      return 1;
    }
    for (const [name, command, writeFlag] of stale) {
      const result = run(command, writeFlag);
      if (!result.ok) {
        console.error(`generate: ${name} failed:\n${result.output}`);
        return 1;
      }
      regenerated.add(name);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
