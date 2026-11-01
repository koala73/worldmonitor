#!/usr/bin/env node
// Rehearse the monthly resilience snapshot refresh against a drifted snapshot.
//
// The refresh writes docs/snapshots/resilience-ranking-<date>.json from the
// live API, rebuilds every artifact that reads it, and verifies them. #9954
// failed CI because a corpus test pinned three figures from the previous
// snapshot (Norway's score, Taiwan's and Andorra's coverage). The pin passed on
// its own PR because that snapshot was still committed.
//
// This script moves those figures on purpose. It derives a snapshot from the
// committed one: re-dated to today, the lowest-ranked country demoted to the
// greyed-out list (so the ranked count moves, as Andorra's demotion did), and
// every country given its neighbour's numbers. Ranks, score order and
// eligibility stay valid, so the build accepts it the way it accepts a real
// capture. It then runs the refresh workflow's own rebuild-and-verify step,
// read from the workflow file. A test that reads the snapshot passes; a test
// pinned to this month's figures fails on the PR that added the pin.
//
// Usage: node scripts/rehearse-resilience-snapshot-refresh.mjs [--keep] [--base <ref>]
// It needs a clean tree and runs in a temporary checkout of HEAD; --keep runs
// in place and leaves the drifted snapshot and rebuilt artifacts for
// inspection. --base exits early when no file changed since <ref> can affect
// the refresh.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { MICROSTATE_COVERAGE_STORY_CODES } from './microstate-coverage-stories.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = 'docs/snapshots';
const SNAPSHOT_RE = /^resilience-ranking-(\d{4}-\d{2}-\d{2})\.json$/;
export const REFRESH_WORKFLOW_PATH = '.github/workflows/resilience-snapshot-refresh.yml';
export const REHEARSED_STEP = 'Rebuild and verify published artifacts';
// A record's identity. Everything else on it is this month's reading.
const IDENTITY_FIELDS = ['countryCode', 'countryName', 'identity'];
// The headline half of a greyed-out reading: the figures its page publishes,
// and the confidence flag that moves with coverage and imputation.
const GREY_HEADLINE_FIELDS = [
  'overallScore', 'overallScoreRaw', 'level', 'lowConfidence', 'dimensionCoverage', 'imputationShare',
  'baselineScore', 'stressScore', 'stressFactor', 'trend', 'change30d',
];
// Files whose change can break the refresh besides the scripts its step runs
// (refreshScripts derives those) and the tests it selects (matched by the
// workflow's SNAPSHOT_CONSUMERS pattern): the snapshot, the corpus modules
// the build imports, and this machinery.
export const REHEARSAL_TRIGGERS = [
  /^docs\/snapshots\/resilience-ranking-[^/]+\.json$/,
  /^scripts\/(crawlable-[\w-]+|microstate-coverage-stories|rehearse-resilience-snapshot-refresh)\.mjs$/,
  /^\.github\/workflows\/(resilience-snapshot-refresh|resilience-snapshot-rehearsal)\.yml$/,
];

function pick(record, fields) {
  return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
}

// Pairs 0-1, 2-3, ... so every country moves exactly one place and nothing
// wraps from the top of the table to the bottom. An odd tail rotates three.
function neighbourOrder(length) {
  if (length < 2) return Array.from({ length }, (_, index) => index);
  const order = Array.from({ length }, (_, index) => (index % 2 === 0 ? index + 1 : index - 1));
  if (length % 2 === 1) {
    const last = length - 1;
    [order[last - 2], order[last - 1], order[last]] = [last, last - 2, last - 1];
  }
  return order;
}

function redate(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => redate(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redate(item, from, to)]));
  }
  return value;
}

/**
 * Returns a copy of a committed resilience snapshot with the figures a monthly
 * refresh routinely moves moved: the capture date, the ranked count, and every
 * country's score, rank, coverage and imputation share. Pure.
 */
export function driftResilienceSnapshot(snapshot, { targetDate, keepReadings = MICROSTATE_COVERAGE_STORY_CODES }) {
  const drifted = redate(structuredClone(snapshot), snapshot.capturedAt, targetDate);

  const demoted = drifted.items.pop();
  drifted.greyedOut.push({ ...demoted, rank: null, headlineEligible: false });
  drifted.greyedOut.sort((a, b) => a.countryCode.localeCompare(b.countryCode));
  drifted.totals = { ...drifted.totals, rankedCountries: drifted.items.length, greyedOutCount: drifted.greyedOut.length };

  // Ranked readings stay in place so ranks and score order hold; countries
  // trade places with their neighbour.
  const itemIdentities = drifted.items.map((item) => pick(item, IDENTITY_FIELDS));
  const itemOrder = neighbourOrder(drifted.items.length);
  drifted.items = drifted.items.map((item, index) => ({ ...item, ...itemIdentities[itemOrder[index]] }));

  // Greyed-out rows are ordered by country code, so the headline figures move
  // instead. Each row takes the figures of a row one displayed coverage step
  // up (the top step takes the one below): every published percentage
  // changes, by the smallest step the list holds, as a real month moves them
  // (Taiwan 38% -> 40%). Dimension evidence stays with its country: which
  // sources cover it is structural (Taiwan is outside WHO), and a borrowed
  // gap list trips page-size guards a real month would not. Countries with a
  // hand-written coverage story keep their figures: the build fails by design
  // when a story stops matching its country's data, and that needs a human
  // rewrite, not a test fix.
  const greyReadings = drifted.greyedOut.map((entry) => pick(entry, GREY_HEADLINE_FIELDS));
  const percent = (reading) => Math.round(reading.dimensionCoverage * 100);
  const steps = new Map();
  greyReadings.forEach((reading, index) => {
    if (keepReadings.includes(drifted.greyedOut[index].countryCode)) return;
    steps.set(percent(reading), [...(steps.get(percent(reading)) ?? []), index]);
  });
  const levels = [...steps.keys()].sort((a, b) => a - b);
  drifted.greyedOut = drifted.greyedOut.map((entry, index) => {
    if (levels.length < 2 || keepReadings.includes(entry.countryCode)) return entry;
    const level = levels.indexOf(percent(greyReadings[index]));
    const donors = steps.get(levels[level === levels.length - 1 ? level - 1 : level + 1]);
    const donor = donors[steps.get(levels[level]).indexOf(index) % donors.length];
    return { ...entry, ...greyReadings[donor] };
  });
  return drifted;
}

/** The refresh step this rehearsal replays, with its env. */
export function readRehearsedStep(workflowText) {
  const workflow = parseYaml(workflowText);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const step = steps.find((candidate) => candidate.name === REHEARSED_STEP);
  if (!step?.run) throw new Error(`${REFRESH_WORKFLOW_PATH} has no "${REHEARSED_STEP}" step with a run script`);
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => (
    [key, /^\$\{\{.*\}\}$/s.test(String(value).trim()) ? '' : String(value)]
  )));
  return { name: step.name, run: step.run, env };
}

/**
 * The repository scripts a step's run script executes, directly or through
 * `npm run`, following package.json scripts recursively.
 */
export function refreshScripts(run, packageScripts) {
  const found = new Set();
  const visited = new Set();
  const walk = (text) => {
    for (const [, file] of text.matchAll(/\b(scripts\/[\w./-]+\.m[jt]s)\b/g)) found.add(file);
    for (const [, name] of text.matchAll(/\bnpm run (?:--silent )?([\w:-]+)/g)) {
      if (visited.has(name)) continue;
      visited.add(name);
      walk(packageScripts[name] ?? '');
    }
  };
  walk(run);
  return [...found].sort();
}

/**
 * Whether a change can break the refresh: a script its step runs, a trigger
 * file, or a test whose source the refresh would select for verification.
 */
export function needsRehearsal(changedFiles, { consumers, readSource, entryScripts = [] }) {
  const pattern = new RegExp(consumers);
  return changedFiles.some((file) => {
    if (entryScripts.includes(file)) return true;
    if (REHEARSAL_TRIGGERS.some((trigger) => trigger.test(file))) return true;
    if (!/^tests\/[^/]+\.test\.m[jt]s$/.test(file)) return false;
    const source = readSource(file);
    return source != null && pattern.test(source);
  });
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function readOrNull(path) {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const baseIndex = args.indexOf('--base');
  const step = readRehearsedStep(readFileSync(join(REPO_ROOT, REFRESH_WORKFLOW_PATH), 'utf8'));

  if (baseIndex !== -1) {
    const base = args[baseIndex + 1];
    const changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
    const entryScripts = refreshScripts(step.run, JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts);
    if (!needsRehearsal(changed, { consumers: step.env.SNAPSHOT_CONSUMERS, readSource: readOrNull, entryScripts })) {
      console.log(`[rehearse-resilience] no change since ${base} reaches the monthly refresh; skipping`);
      return;
    }
  }
  if (!keep && git(['status', '--porcelain']).trim()) {
    throw new Error('rehearsal runs on a temporary checkout of HEAD; commit local changes first (or pass --keep to run in place)');
  }

  // The rebuild also writes ignored outputs (country pages, the corpus JSON,
  // inventory facts) that git restore cannot reset, so a normal run happens
  // in a throwaway checkout of HEAD and leaves no invented figures behind.
  // --keep runs in place and leaves everything for inspection.
  const workDir = keep ? REPO_ROOT : mkdtempSync(join(tmpdir(), 'wm-resilience-rehearsal-'));
  if (!keep) {
    git(['worktree', 'add', '--detach', '--quiet', workDir, 'HEAD']);
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(workDir, 'node_modules'), 'dir');
  }

  let failed = false;
  try {
    const committed = readdirSync(join(workDir, SNAPSHOT_DIR)).filter((name) => SNAPSHOT_RE.test(name)).sort().at(-1);
    if (!committed) throw new Error(`no resilience-ranking snapshot in ${SNAPSHOT_DIR}`);
    const snapshot = JSON.parse(readFileSync(join(workDir, SNAPSHOT_DIR, committed), 'utf8'));
    // Today, as the refresh dates its capture. On the day of a refresh the
    // date cannot move, so the drifted snapshot replaces the committed one.
    const targetDate = new Date().toISOString().slice(0, 10);
    const drifted = driftResilienceSnapshot(snapshot, { targetDate });
    const driftedName = `resilience-ranking-${targetDate}.json`;
    writeFileSync(join(workDir, SNAPSHOT_DIR, driftedName), `${JSON.stringify(drifted, null, 2)}\n`);
    console.log(
      `[rehearse-resilience] ${committed} -> ${driftedName} (ranked ${snapshot.items.length} -> ${drifted.items.length}, `
      + 'every country given a neighbour\'s figures)',
    );
    console.log(`[rehearse-resilience] ${step.name}`);
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
      cwd: workDir,
      stdio: 'inherit',
      env: { ...process.env, ...step.env },
    });
    failed = result.status !== 0;
  } finally {
    if (!keep) git(['worktree', 'remove', '--force', workDir]);
  }

  if (failed) {
    console.error(
      `[rehearse-resilience] "${step.name}" failed against a drifted snapshot. A test or generator is pinned to a `
      + 'figure the committed snapshot happens to hold, and the next monthly refresh will fail the same way. Read '
      + 'the figure from the snapshot the build used (manifest.sources.resilienceSnapshot, loadCorpusData().resilience). '
      + 'See docs/solutions/test-failures/tests-pinned-to-the-rolling-pulse-capture-fail-the-weekly-refresh.md.',
    );
    process.exit(1);
  }
  console.log('[rehearse-resilience] refresh rebuild and verify pass against a drifted snapshot');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
