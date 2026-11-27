#!/usr/bin/env node
// Rebalances the test:e2e:ci-smoke:<n> spec lists in package.json from the
// per-test durations Playwright's list reporter prints in recent successful
// Test runs on main. Usage:
//   node scripts/balance-smoke-shards.mjs [--runs id,id] [--count 6] [--repo owner/name] [--write]
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = resolve(ROOT, 'package.json');
const COMBINED_SCRIPT = 'test:e2e:ci-smoke';
const SHARD_SCRIPT = /^test:e2e:ci-smoke:(\d+)$/;
const SHARD_JOB = /^variant-smoke \((\d+)\)$/;
const SPEC_TOKEN = /^e2e\/\S+\.spec\.[cm]?[jt]sx?$/;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
// One finished test result from the list reporter, after the optional
// Actions timestamp: "  ✓  12 [chromium] › e2e/x.spec.ts:59:3 › title (28.2s)".
// A retried test prints one line per attempt, so failed attempts count too.
const RESULT_LINE =
  /^(?:\d{4}-\d\d-\d\dT\S+Z )?\s+[✓✘]\s+\d+\s+\[[^\]]+\]\s+›\s+(e2e\/\S+?\.spec\.[cm]?[jt]sx?):\d+:\d+\s+›.*\((\d+(?:\.\d+)?)(ms|s|m|h|d)\)\s*$/;

export function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function parseDurationMs(value, unit) {
  return Math.round(Number(value) * UNIT_MS[unit]);
}

export function specSecondsFromLog(log) {
  const totals = new Map();
  for (const line of stripAnsi(log).split(/\r?\n/)) {
    const match = RESULT_LINE.exec(line);
    if (!match) continue;
    const [, spec, value, unit] = match;
    totals.set(spec, (totals.get(spec) ?? 0) + parseDurationMs(value, unit));
  }
  return totals;
}

export function median(values) {
  if (values.length === 0) throw new Error('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// runs: one Map<spec, ms> per run. Specs with no measurement get the median
// of the measured specs' medians, flagged so the output can say so.
export function estimateSpecs(specs, runs) {
  const measured = new Map();
  for (const spec of specs) {
    const samples = runs.filter((run) => run.has(spec)).map((run) => run.get(spec));
    if (samples.length) measured.set(spec, { ms: median(samples), samples, estimated: false });
  }
  const fallback = measured.size ? median([...measured.values()].map((entry) => entry.ms)) : 1000;
  return new Map(
    specs.map((spec) => [spec, measured.get(spec) ?? { ms: fallback, samples: [], estimated: true }]),
  );
}

export function shardLoads(shards, msBySpec) {
  return shards.map((shard) => shard.reduce((sum, spec) => sum + msBySpec.get(spec), 0));
}

// Lexicographic order on loads sorted descending: lowering the largest shard
// wins first, and ties on the max are broken by the next largest.
function compareLoadVectors(a, b) {
  const x = [...a].sort((p, q) => q - p);
  const y = [...b].sort((p, q) => q - p);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function longestFirst(specs, msBySpec) {
  return [...specs].sort((a, b) => msBySpec.get(b) - msBySpec.get(a) || a.localeCompare(b));
}

function placeLongestFirst(shards, specs, msBySpec) {
  const loads = shardLoads(shards, msBySpec);
  for (const spec of longestFirst(specs, msBySpec)) {
    const target = loads.indexOf(Math.min(...loads));
    shards[target].push(spec);
    loads[target] += msBySpec.get(spec);
  }
  return shards;
}

// Repeats the single move or pairwise swap that most improves the load
// vector until none does or the largest shard is within goodEnoughMs. Each
// accepted step strictly decreases the vector, so this ends.
function improve(start, msBySpec, goodEnoughMs) {
  let shards = start.map((shard) => [...shard].sort());
  for (;;) {
    let best = null;
    let bestLoads = shardLoads(shards, msBySpec);
    if (Math.max(...bestLoads) <= goodEnoughMs) return shards;
    const consider = (candidate) => {
      const loads = shardLoads(candidate, msBySpec);
      if (compareLoadVectors(loads, bestLoads) < 0) {
        best = candidate;
        bestLoads = loads;
      }
    };
    for (let from = 0; from < shards.length; from++) {
      for (const spec of shards[from]) {
        for (let to = 0; to < shards.length; to++) {
          if (to === from || shards[from].length === 1) continue;
          const next = shards.map((shard) => [...shard]);
          next[from] = next[from].filter((s) => s !== spec);
          next[to] = [...next[to], spec].sort();
          consider(next);
        }
        for (let other = from + 1; other < shards.length; other++) {
          for (const swapWith of shards[other]) {
            const next = shards.map((shard) => [...shard]);
            next[from] = [...next[from].filter((s) => s !== spec), swapWith].sort();
            next[other] = [...next[other].filter((s) => s !== swapWith), spec].sort();
            consider(next);
          }
        }
      }
    }
    if (!best) return shards;
    shards = best;
  }
}

function assertPartition(shards, specs, label) {
  const flat = shards.flat();
  const expected = [...specs].sort();
  const actual = [...flat].sort();
  if (new Set(flat).size !== flat.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: shards do not partition the smoke spec set exactly`);
  }
  if (shards.some((shard) => shard.length === 0)) throw new Error(`${label}: a shard is empty`);
}

// A spec's median still moves several percent between six-run windows, so a
// split within this fraction of the best possible max is as good as optimal.
const GOOD_ENOUGH_FRACTION = 0.01;

// Packs specs into shardCount lists. Two starts are improved: longest
// processing time first, and the current split. The current split wins unless
// the other start lowers the max further than it can, so a drift moves few specs.
export function packShards(specs, msBySpec, shardCount, current = []) {
  if (specs.length < shardCount) throw new Error(`need at least ${shardCount} specs, have ${specs.length}`);
  const inventory = new Set(specs);
  const durations = specs.map((spec) => msBySpec.get(spec));
  const lowerBound = Math.max(durations.reduce((a, b) => a + b, 0) / shardCount, ...durations);
  const goodEnoughMs = lowerBound * (1 + GOOD_ENOUGH_FRACTION);
  const fromLpt = improve(
    placeLongestFirst(Array.from({ length: shardCount }, () => []), specs, msBySpec),
    msBySpec,
    goodEnoughMs,
  );
  const kept = Array.from({ length: shardCount }, (_, i) => (current[i] ?? []).filter((s) => inventory.has(s)));
  const placed = new Set(kept.flat());
  const fromCurrent = improve(
    placeLongestFirst(kept, specs.filter((s) => !placed.has(s)), msBySpec),
    msBySpec,
    goodEnoughMs,
  );
  const maxOf = (shards) => Math.max(...shardLoads(shards, msBySpec));
  const currentIsEnough = maxOf(fromCurrent) <= Math.max(goodEnoughMs, maxOf(fromLpt));
  const shards = (currentIsEnough ? fromCurrent : fromLpt).map((shard) => [...shard].sort());
  assertPartition(shards, specs, 'packShards');
  return shards;
}

export function readSmokeScripts(scripts) {
  const combined = scripts[COMBINED_SCRIPT];
  if (!combined) throw new Error(`package.json has no ${COMBINED_SCRIPT} script`);
  const specs = combined.split(/\s+/).filter((token) => SPEC_TOKEN.test(token));
  const shardNames = Object.keys(scripts)
    .filter((name) => SHARD_SCRIPT.test(name))
    .sort((a, b) => Number(SHARD_SCRIPT.exec(a)[1]) - Number(SHARD_SCRIPT.exec(b)[1]));
  const shards = shardNames.map((name) => scripts[name].split(/\s+/).filter((token) => SPEC_TOKEN.test(token)));
  const unknown = shards.flat().filter((spec) => !specs.includes(spec));
  if (unknown.length) throw new Error(`shard scripts name specs missing from ${COMBINED_SCRIPT}: ${unknown.join(' ')}`);
  return { specs, shardNames, shards };
}

// Rewrites only the shard script values in the package.json text, keeping each
// script's non-spec prefix and suffix, the key order and the file formatting.
export function rewriteShardScripts(packageText, shardNames, shards) {
  const scripts = JSON.parse(packageText).scripts;
  let text = packageText;
  shardNames.forEach((name, i) => {
    const tokens = scripts[name].split(' ');
    const first = tokens.findIndex((token) => SPEC_TOKEN.test(token));
    const last = tokens.findLastIndex((token) => SPEC_TOKEN.test(token));
    if (first < 0) throw new Error(`${name} names no spec paths`);
    if (tokens.slice(first, last + 1).some((token) => !SPEC_TOKEN.test(token))) {
      throw new Error(`${name} interleaves options with spec paths; rewrite it by hand`);
    }
    const value = [...tokens.slice(0, first), ...shards[i], ...tokens.slice(last + 1)].join(' ');
    const before = `${JSON.stringify(name)}: ${JSON.stringify(scripts[name])}`;
    if (text.split(before).length !== 2) throw new Error(`could not locate ${name} in package.json`);
    text = text.replace(before, () => `${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  });
  return text;
}

function parseArgs(argv) {
  const args = { count: 6, repo: 'koala73/worldmonitor', runs: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--write') args.write = true;
    else if (flag === '--runs') args.runs = argv[++i].split(',').map((id) => id.trim()).filter(Boolean);
    else if (flag === '--count') args.count = Number(argv[++i]);
    else if (flag === '--repo') args.repo = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(args.count) || args.count < 1) throw new Error('--count must be a positive integer');
  return args;
}

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function smokeJobs(repo, runId, shardCount) {
  const out = await gh([
    'api', '--paginate', `repos/${repo}/actions/runs/${runId}/jobs`,
    '--jq', '.jobs[] | [.id, .name, .conclusion] | @tsv',
  ]);
  const jobs = out.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
    .filter(([, name]) => SHARD_JOB.test(name))
    .map(([id, name, conclusion]) => ({ id, shard: Number(SHARD_JOB.exec(name)[1]), conclusion }));
  const ok = jobs.filter((job) => job.conclusion === 'success');
  return ok.length === shardCount ? ok : null;
}

async function measureRun(repo, runId, shardCount) {
  const jobs = await smokeJobs(repo, runId, shardCount);
  if (!jobs) return null;
  const run = new Map();
  for (const job of jobs) {
    const log = await gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.id}/logs`]);
    const perSpec = specSecondsFromLog(log);
    if (perSpec.size === 0) throw new Error(`run ${runId} shard ${job.shard}: no list-reporter result lines parsed`);
    for (const [spec, ms] of perSpec) run.set(spec, (run.get(spec) ?? 0) + ms);
  }
  return run;
}

async function collectRuns(args, shardCount) {
  const candidates = args.runs ?? JSON.parse(await gh([
    'run', 'list', '-R', args.repo, '-w', 'Test', '-b', 'main', '--event', 'push', '--status', 'success',
    '-L', String(args.count * 4), '--json', 'databaseId',
  ])).map((run) => String(run.databaseId));
  const used = [];
  for (const runId of candidates) {
    if (!args.runs && used.length === args.count) break;
    const run = await measureRun(args.repo, runId, shardCount);
    if (run) used.push({ runId, run });
    else if (args.runs) throw new Error(`run ${runId} has no ${shardCount} successful variant-smoke shard jobs`);
    else console.error(`skip run ${runId}: variant-smoke shards did not all run`);
  }
  if (used.length === 0) throw new Error('no usable runs');
  return used;
}

const seconds = (ms) => (ms / 1000).toFixed(1);

function describe(label, shards, msBySpec) {
  const loads = shardLoads(shards, msBySpec);
  const total = loads.reduce((a, b) => a + b, 0);
  console.log(`${label}: ${loads.map(seconds).join(' / ')} test-seconds (max ${seconds(Math.max(...loads))} of ${seconds(total)})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageText = readFileSync(PACKAGE_JSON, 'utf8');
  const { specs, shardNames, shards: current } = readSmokeScripts(JSON.parse(packageText).scripts);
  const used = await collectRuns(args, shardNames.length);
  const estimates = estimateSpecs(specs, used.map((entry) => entry.run));
  const msBySpec = new Map([...estimates].map(([spec, entry]) => [spec, entry.ms]));

  console.log(`runs (${used.length}): ${used.map((entry) => entry.runId).join(',')}`);
  for (const { runId, run } of used) {
    const observed = current.map((shard) => shard.reduce((sum, spec) => sum + (run.get(spec) ?? 0), 0));
    console.log(`  run ${runId} measured on the current split: ${observed.map(seconds).join(' / ')}`);
  }
  console.log('\nper-spec median test-seconds (min-max over runs):');
  for (const spec of longestFirst(specs, msBySpec)) {
    const { ms, samples, estimated } = estimates.get(spec);
    const spread = samples.length ? `${seconds(Math.min(...samples))}-${seconds(Math.max(...samples))}, n=${samples.length}` : 'unmeasured';
    console.log(`  ${seconds(ms).padStart(7)}  ${spec}  (${spread})${estimated ? '  ESTIMATE: no measurement, using the median spec' : ''}`);
  }

  const next = packShards(specs, msBySpec, shardNames.length, current);
  console.log('');
  describe('before', current, msBySpec);
  describe('after ', next, msBySpec);
  next.forEach((shard, i) => console.log(`  ${shardNames[i]}: ${shard.join(' ')}`));

  if (args.write) {
    writeFileSync(PACKAGE_JSON, rewriteShardScripts(packageText, shardNames, next));
    const written = readSmokeScripts(JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts);
    assertPartition(written.shards, specs, 'package.json after --write');
    console.log(`\nwrote ${shardNames.join(', ')} to package.json`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
