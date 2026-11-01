#!/usr/bin/env node
// Rehearse the weekly crawlable-pulse refresh against a drifted capture.
//
// The refresh replaces docs/snapshots/crawlable-live-pulse-<date>.json with a
// new live capture, rebuilds the corpus, and runs a verify suite. Six refreshes
// failed in verify on a test pinned to something the old capture happened to
// contain: a dated filename, Hormuz's score and transit count, a CII
// methodology version (#7533, #7884, #8345, #8417, #9115, #9693). Each pin
// passed on its own PR because the capture it pinned was still committed, and
// failed weeks later, when the live value moved, on a bot PR nobody was
// watching.
//
// This script moves those values on purpose, before the live data does. It
// derives a capture from the committed one: re-dated to today, every
// methodology version bumped, CII scores rotated across the scored countries,
// chokepoint readings rotated across chokepoints, and PortWatch days all
// published or all withheld. Every record keeps its
// shape, so the build accepts it the way it accepts a real capture. It then
// runs the refresh workflow's own "Rebuild published artifacts" and "Verify
// published artifacts" steps, read from the workflow file so the two cannot
// drift apart. A test that reads the pulse it is given passes; a test that
// pinned last week's values fails here, on the PR that added the pin.
//
// Usage: node scripts/rehearse-crawlable-pulse-refresh.mjs [--keep]
// Locally it needs a clean tree and restores it afterwards; --keep leaves the
// drifted capture and rebuilt artifacts in place for debugging.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = 'docs/snapshots';
const LIVE_PULSE_SNAPSHOT_RE = /^crawlable-live-pulse-(\d{4}-\d{2}-\d{2})\.json$/;
export const REFRESH_WORKFLOW_PATH = '.github/workflows/crawlable-pulse-refresh.yml';
export const REHEARSED_STEPS = ['Rebuild published artifacts', 'Verify published artifacts'];

const DAY_MS = 86_400_000;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const METHODOLOGY_VERSION_RE = /^v(\d+)$/;
// The reading half of a CII record. Advisory, sanctions and developments name
// the country itself, so moving them would publish one country's text under
// another's heading rather than a different week's numbers.
const CII_READING_FIELDS = ['score', 'band', 'trend', 'geoConvergence'];
// A chokepoint's description is its identity; everything else is this week's
// reading.
const CHOKEPOINT_IDENTITY_FIELDS = new Set(['description']);
// The IMF PortWatch day a chokepoint page publishes or, when absent, withholds.
const PORTWATCH_DAY_FIELDS = ['officialLatestDate', 'officialLatestTotal', 'officialAvg7d'];

function rotate(values) {
  return values.length < 2 ? values : [...values.slice(1), values[0]];
}

function shiftTimestamps(value, deltaMs, capturedAt, targetDate) {
  if (typeof value === 'string') {
    if (value === capturedAt) return targetDate;
    if (ISO_TIMESTAMP_RE.test(value)) return new Date(Date.parse(value) + deltaMs).toISOString();
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => shiftTimestamps(item, deltaMs, capturedAt, targetDate));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftTimestamps(item, deltaMs, capturedAt, targetDate)]),
    );
  }
  return value;
}

function bumpMethodologyVersions(value) {
  if (Array.isArray(value)) return value.map(bumpMethodologyVersions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const match = key === 'methodologyVersion' && typeof item === 'string' ? item.match(METHODOLOGY_VERSION_RE) : null;
    return [key, match ? `v${Number(match[1]) + 1}` : bumpMethodologyVersions(item)];
  }));
}

/**
 * Returns a copy of a committed live-pulse capture with every value a weekly
 * refresh routinely moves moved, so tests pinned to the committed values fail.
 * Pure; `targetDate` is the YYYY-MM-DD the drifted capture claims.
 */
export function driftLivePulseCapture(capture, { targetDate }) {
  const deltaMs = Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${capture.capturedAt}T00:00:00Z`);
  const drifted = bumpMethodologyVersions(shiftTimestamps(capture, deltaMs, capture.capturedAt, targetDate));
  if (typeof drifted.capturedAtMs === 'number') drifted.capturedAtMs += deltaMs;
  if (typeof drifted.forecastScorecard?.attemptedAtMs === 'number') {
    drifted.forecastScorecard.attemptedAtMs += deltaMs;
  }

  const scored = Object.keys(drifted.countries).sort().filter((code) => drifted.countries[code].partial === false);
  const ciiReadings = rotate(scored.map((code) => CII_READING_FIELDS.map((field) => drifted.countries[code][field])));
  scored.forEach((code, index) => {
    CII_READING_FIELDS.forEach((field, fieldIndex) => { drifted.countries[code][field] = ciiReadings[index][fieldIndex]; });
  });

  const chokepointIds = Object.keys(drifted.chokepoints).sort();
  const chokepointReadings = rotate(chokepointIds.map((id) => Object.fromEntries(
    Object.entries(drifted.chokepoints[id]).filter(([field]) => !CHOKEPOINT_IDENTITY_FIELDS.has(field)),
  )));
  chokepointIds.forEach((id, index) => {
    const identity = Object.fromEntries(
      Object.entries(drifted.chokepoints[id]).filter(([field]) => CHOKEPOINT_IDENTITY_FIELDS.has(field)),
    );
    drifted.chokepoints[id] = { ...chokepointReadings[index], ...identity };
  });
  // Rotation keeps the mix of published and withheld PortWatch days, so a
  // test that needs one of each still passes until a week has none of one:
  // 2026-10-19 withheld every day, 2026-10-26 published every day (#9693).
  // Empty the side the capture holds fewer of, so such a test fails here.
  const readings = chokepointIds.map((id) => drifted.chokepoints[id]);
  const published = readings.filter((reading) => reading.officialLatestTotal != null);
  const withheldCount = readings.length - published.length;
  if (withheldCount > 0 && (published.length === 0 || withheldCount <= published.length)) {
    // With no published day to copy, a plausible one: PortWatch lags about a week.
    const day = published[0] ?? {
      officialLatestDate: new Date(Date.parse(`${targetDate}T00:00:00Z`) - 8 * DAY_MS).toISOString().slice(0, 10),
      officialLatestTotal: 40,
      officialAvg7d: 41.3,
    };
    for (const reading of readings) {
      if (reading.officialLatestTotal != null) continue;
      for (const field of PORTWATCH_DAY_FIELDS) reading[field] = day[field];
    }
  } else {
    for (const reading of published) {
      for (const field of PORTWATCH_DAY_FIELDS) reading[field] = null;
    }
  }
  return drifted;
}

/**
 * The run scripts of the refresh workflow steps this rehearsal replays, in
 * workflow order, with each step's env (expressions resolve to empty, as an
 * unset workflow_dispatch input does on the schedule).
 */
export function readRehearsedSteps(workflowText) {
  const workflow = parseYaml(workflowText);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  return REHEARSED_STEPS.map((name) => {
    const step = steps.find((candidate) => candidate.name === name);
    if (!step?.run) throw new Error(`${REFRESH_WORKFLOW_PATH} has no "${name}" step with a run script`);
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => (
      [key, /^\$\{\{.*\}\}$/s.test(String(value).trim()) ? '' : String(value)]
    )));
    return { name, run: step.run, env };
  });
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function main() {
  const keep = process.argv.includes('--keep');
  if (!keep && git(['status', '--porcelain']).trim()) {
    throw new Error('rehearsal rewrites committed artifacts and restores them afterwards; commit or set aside local changes first (or pass --keep)');
  }

  const snapshots = readdirSync(join(REPO_ROOT, SNAPSHOT_DIR))
    .filter((filename) => LIVE_PULSE_SNAPSHOT_RE.test(filename))
    .sort();
  const committed = snapshots.at(-1);
  if (!committed) throw new Error(`no crawlable live-pulse capture in ${SNAPSHOT_DIR}`);
  const capture = JSON.parse(readFileSync(join(REPO_ROOT, SNAPSHOT_DIR, committed), 'utf8'));
  // Today, as the refresh dates its capture. On the day the refresh itself
  // merged the date cannot move without claiming a capture from the future,
  // so only the values drift.
  const targetDate = new Date().toISOString().slice(0, 10);
  const drifted = driftLivePulseCapture(capture, { targetDate });
  const driftedName = `crawlable-live-pulse-${targetDate}.json`;

  const steps = readRehearsedSteps(readFileSync(join(REPO_ROOT, REFRESH_WORKFLOW_PATH), 'utf8'));
  let failed = null;
  try {
    for (const filename of snapshots) rmSync(join(REPO_ROOT, SNAPSHOT_DIR, filename));
    writeFileSync(join(REPO_ROOT, SNAPSHOT_DIR, driftedName), `${JSON.stringify(drifted, null, 2)}\n`);
    console.log(`[rehearse-pulse] ${committed} -> ${driftedName} (methodology bumped, CII and chokepoint readings rotated, PortWatch days moved to one side)`);
    for (const step of steps) {
      console.log(`[rehearse-pulse] ${step.name}`);
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...step.env },
      });
      if (result.status !== 0) {
        failed = step.name;
        break;
      }
    }
  } finally {
    if (!keep) {
      git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
      git(['clean', '-fdq', '--', SNAPSHOT_DIR]);
    }
  }

  if (failed) {
    console.error(
      `[rehearse-pulse] "${failed}" failed against a drifted capture. A test or generator is pinned to a value `
      + 'the committed capture happens to hold, and the next weekly refresh will fail the same way. Read the value '
      + 'from the capture the build used (clock.livePulse, resolveLatestLivePulseSnapshotPath) or inject '
      + 'tests/fixtures/crawlable-live-pulse-fixture.json through livePulseSnapshotPath. See '
      + 'docs/solutions/test-failures/tests-pinned-to-the-rolling-pulse-capture-fail-the-weekly-refresh.md.',
    );
    process.exit(1);
  }
  console.log('[rehearse-pulse] refresh build and verify pass against a drifted capture');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
