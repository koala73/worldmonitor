#!/usr/bin/env node

// Freeze and reconcile forecast evaluation cohorts (#7066). Operator tool, not
// a Railway service. It only reads production Redis (GET and LRANGE) and
// writes the manifest to a local file, which is committed for review.
//
//   node scripts/forecast-cohort.mjs freeze --id <cohort-id> --start <iso> [--end <iso>]
//        [--origin a,b] [--domain a,b] [--note "..."] [--out data/forecast-cohorts/<id>.json]
//        [--carry-code-versions data/forecast-cohorts/<earlier-id>.json]
//   node scripts/forecast-cohort.mjs reconcile --manifest data/forecast-cohorts/<id>.json [--json]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRedisCredentials, loadEnvFile, redisCommand } from './_seed-utils.mjs';
import { BETS_HISTORY_KEY } from './_forecast-bets-keys.mjs';
import { HISTORY_KEY, RESOLUTIONS_KEY } from './seed-forecast-resolutions.mjs';
import { formatReconciliationMarkdown, freezeCohort, reconcileCohort } from './_forecast-cohort.mjs';

// Written by seed-forecasts once per run; each pointer's triggerContext
// records the deploy SHA of that run.
const TRACE_RUNS_KEY = 'forecast:trace:runs:v1';
// The resolver reads the newest 200 runs of each history list; the freeze reads
// the same, so it projects exactly the windows the resolver can open.
const HISTORY_READ_LIMIT = 200;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'json') { flags.json = true; continue; }
    const value = rest[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    flags[name] = value;
    i += 1;
  }
  return { command, flags };
}

function parseTime(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`--${name} is not a date: ${value}`);
  return ms;
}

function list(value) {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : null;
}

async function readJson(url, token, key) {
  const { result } = await redisCommand(url, token, ['GET', key]);
  return result == null ? null : JSON.parse(result);
}

// limit 0 reads the whole list.
async function readList(url, token, key, limit = 0) {
  const { result } = await redisCommand(url, token, ['LRANGE', key, 0, limit - 1]);
  return (Array.isArray(result) ? result : []).map((row) => {
    try { return JSON.parse(row); } catch { return null; }
  }).filter(Boolean);
}

async function freeze(flags) {
  if (!flags.id || !flags.start) throw new Error('freeze needs --id and --start');
  const { url, token } = getRedisCredentials();
  const nowMs = Date.now();
  const [ledger, historySnapshots, betsSnapshots, traceRuns] = await Promise.all([
    readJson(url, token, RESOLUTIONS_KEY),
    readList(url, token, HISTORY_KEY, HISTORY_READ_LIMIT),
    readList(url, token, BETS_HISTORY_KEY, HISTORY_READ_LIMIT),
    readList(url, token, TRACE_RUNS_KEY),
  ]);
  if (!ledger) throw new Error(`${RESOLUTIONS_KEY} is empty; refusing to freeze against no ledger`);
  const ledgerWrittenAt = Number(ledger?._seed?.fetchedAt);
  const manifest = freezeCohort({
    cohortId: flags.id,
    startMs: parseTime(flags.start, 'start'),
    endMs: flags.end ? parseTime(flags.end, 'end') : nowMs,
    nowMs,
    ledger,
    historySnapshots,
    betsSnapshots,
    traceRuns,
    origins: list(flags.origin),
    domains: list(flags.domain),
    note: flags.note || '',
    priorManifest: flags['carry-code-versions']
      ? JSON.parse(readFileSync(resolve(REPO_ROOT, flags['carry-code-versions']), 'utf8'))
      : null,
    sources: {
      ledgerKey: RESOLUTIONS_KEY,
      ledgerWrittenAt: Number.isFinite(ledgerWrittenAt) ? new Date(ledgerWrittenAt).toISOString() : null,
      historyKey: HISTORY_KEY,
      betsHistoryKey: BETS_HISTORY_KEY,
      traceRunsKey: TRACE_RUNS_KEY,
    },
  });
  const out = resolve(REPO_ROOT, flags.out || `data/forecast-cohorts/${flags.id}.json`);
  writeManifestFile(out, manifest);
  console.log(`Froze ${manifest.counts.entries} windows (${manifest.counts.registeredAtFreeze} already in the ledger) to ${out}`);
  console.log(JSON.stringify(manifest.counts, null, 2));
}

// A frozen manifest is never replaced: a second freeze reads a later ledger
// and history and would write a different entry set with a matching hash.
export function writeManifestFile(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`${path} exists; a frozen cohort is never replaced, choose a new --id`);
    throw err;
  }
}

async function reconcile(flags) {
  if (!flags.manifest) throw new Error('reconcile needs --manifest');
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, flags.manifest), 'utf8'));
  const { url, token } = getRedisCredentials();
  const ledger = await readJson(url, token, RESOLUTIONS_KEY);
  if (!ledger) throw new Error(`${RESOLUTIONS_KEY} is empty; refusing to report every entry missing`);
  const report = reconcileCohort(manifest, ledger, Date.now());
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatReconciliationMarkdown(report));
}

// A file URL percent-encodes spaces and non-ASCII; compare paths instead.
const DIRECT_RUN = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (DIRECT_RUN) {
  loadEnvFile(import.meta.url);
  const { command, flags } = parseArgs(process.argv.slice(2));
  const run = command === 'freeze' ? freeze : command === 'reconcile' ? reconcile : null;
  if (!run) {
    console.error('usage: forecast-cohort.mjs freeze --id <id> --start <iso> [--end <iso>] | reconcile --manifest <path> [--json]');
    process.exit(2);
  }
  run(flags).catch((err) => {
    console.error(`forecast-cohort: ${err?.message || err}`);
    process.exit(1);
  });
}

export { parseArgs };
