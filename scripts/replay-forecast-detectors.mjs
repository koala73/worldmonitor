#!/usr/bin/env node
// Replays one forecast run from its archived input snapshot (#9058, #7073).
//
//   node scripts/replay-forecast-detectors.mjs --entry-key=<ledger key>
//   node scripts/replay-forecast-detectors.mjs --run-id=<run id> [--generated-at=<ms>]
//   node scripts/replay-forecast-detectors.mjs --snapshot=<local file>
//   options: --code=recorded|current|<sha>  --candidate
//
// Two lanes, chosen by the snapshot's shape:
// - detector: a seed-forecasts deep-snapshot.json. Reruns the legacy
//   detectors and scoring on `inputs` and compares every legacy detector
//   probability and horizon projection with `fullRunPredictions`.
// - bets: a seed-forecast-bets bets-input-snapshot.json. Reruns
//   buildBetsSnapshot and compares every baselineProbability. Ensemble
//   probabilities come from an LLM and are recorded outputs, not replayed.
//
// The first pass runs the code the run recorded (`deployRevision`), checked
// out into a scratch git worktree. `--candidate` adds a second pass on this
// checkout, labeled separately: its differences are code changes, not
// snapshot failures. Each pass runs in a child process with no credentials,
// no network and the clock frozen at the snapshot's generatedAt.
//
// Snapshots hold licensed third-party data (ACLED events, news). They are
// read with the private R2 trace credentials, kept in a 0600 temp file that
// is deleted afterwards, and never printed. The report lists forecast ids
// and numbers only.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serializeR2JsonBody, sha256Hex } from './_r2-storage.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const LEDGER_KEY = 'forecast:resolutions:v1';
const DETECTOR_ORIGINS = new Set(['legacy_detector', '', undefined, null]);
// A run's id is minted a few seconds before its generatedAt (median 2.6 s in
// the #7073 sample). Entries from before #9058 carry no runId, so the run is
// found by listing the day's run prefixes and taking the latest one minted
// at most this long before the entry was generated.
export const LEGACY_RUN_MATCH_WINDOW_MS = 15 * 60 * 1000;
const MAX_REPORTED_DIFFS = 20;
const PROBABILITY_TOLERANCE = 1e-9;
const HORIZON_KEYS = ['h24', 'd7', 'd30'];

export function parseReplayArgs(argv = []) {
  const values = new Map();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    values.set(key, rest.length > 0 ? rest.join('=') : 'true');
  }
  return {
    child: values.get('child') === 'true',
    codeRoot: values.get('code-root') || '',
    out: values.get('out') || '',
    entryKey: values.get('entry-key') || '',
    runId: values.get('run-id') || '',
    generatedAt: Number(values.get('generated-at')) || null,
    snapshot: values.get('snapshot') || '',
    code: values.get('code') || 'recorded',
    candidate: values.get('candidate') === 'true',
  };
}

export function snapshotLane(snapshot) {
  if (Array.isArray(snapshot?.fullRunPredictions) && snapshot?.inputs && typeof snapshot.inputs === 'object') return 'detector';
  if (snapshot?.feedsByKey && typeof snapshot.feedsByKey === 'object') return 'bets';
  return null;
}

/** The digest of the bytes the run wrote: parsing and serializing again reproduces them. */
export function snapshotDigest(snapshot) {
  return sha256Hex(serializeR2JsonBody(snapshot));
}

/**
 * The publication a run scored with. Snapshots from before #9058 carry none;
 * the live mode was raw until #7070 activated, so they replay raw.
 */
export function publicationFromArchive(archive) {
  if (!archive || typeof archive !== 'object') {
    return { map: null, decision: { mode: 'raw', reason: 'not_archived', mapVersion: null } };
  }
  return {
    map: archive.map ?? null,
    decision: { mode: archive.mode, reason: archive.reason, mapVersion: archive.mapVersion ?? null },
  };
}

// Detectors as the harness knew them, for revisions before detectAllScenarios
// was exported. detectInfraScenarios ran in July 2026 and was retired later.
function legacyDetectorList(m, inputs, risk) {
  return [
    ...m.detectConflictScenarios(inputs, risk),
    ...m.detectMarketScenarios(inputs),
    ...m.detectSupplyChainScenarios(inputs),
    ...m.detectPoliticalScenarios(inputs),
    ...m.detectMilitaryScenarios(inputs),
    ...(typeof m.detectInfraScenarios === 'function' ? m.detectInfraScenarios(inputs) : []),
    ...m.detectUcdpConflictZones(inputs, risk),
    ...m.detectCyberScenarios(inputs),
    ...m.detectGpsJammingScenarios(inputs),
    ...m.detectFromPredictionMarkets(inputs),
  ];
}

/** Pure given the modules: the detector stage and its scoring, on a copy of the inputs. */
export function replayDetectorStage(seedModule, emaModule, snapshot) {
  const inputs = structuredClone(snapshot.inputs || {});
  let priorWindows = new Map();
  try {
    if (inputs.emaWindowsRaw) priorWindows = new Map(Object.entries(JSON.parse(inputs.emaWindowsRaw)));
  } catch { /* cold start, as in the seeder */ }
  const ucdp = Array.isArray(inputs.ucdpEvents) ? inputs.ucdpEvents : (inputs.ucdpEvents?.events ?? []);
  const risk = emaModule.computeRisk24h(emaModule.computeEmaWindows(priorWindows, inputs.acledEvents ?? [], ucdp, snapshot.generatedAt));
  const predictions = typeof seedModule.detectAllScenarios === 'function'
    ? seedModule.detectAllScenarios(inputs, risk)
    : legacyDetectorList(seedModule, inputs, risk);
  if (typeof seedModule.scoreDetectedPredictions === 'function') {
    seedModule.scoreDetectedPredictions(predictions, {
      inputs,
      prior: null,
      calibrationPublication: publicationFromArchive(snapshot.calibrationPublication),
      cascadeRules: typeof seedModule.loadCascadeRules === 'function' ? seedModule.loadCascadeRules() : [],
    });
  } else {
    seedModule.attachNewsContext(predictions, inputs.newsInsights, inputs.newsDigest);
    seedModule.calibrateWithMarkets(predictions, inputs.predictionMarkets);
    if (typeof seedModule.computeConfidence === 'function') seedModule.computeConfidence(predictions);
    if (typeof seedModule.computeProjections === 'function') seedModule.computeProjections(predictions);
  }
  return predictions.map((pred) => ({
    id: pred.id,
    probability: pred.probability,
    projections: pred.projections ?? null,
    generationOrigin: pred.generationOrigin ?? null,
  }));
}

export function replayBetsStage(betsModule, snapshot) {
  const { predictions } = betsModule.buildBetsSnapshot(snapshot.feedsByKey || {}, snapshot.generatedAt, snapshot.priorSeries || {});
  return predictions.map((bet) => ({ id: bet.id, baselineProbability: bet.baselineProbability }));
}

function sameProbability(a, b) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < PROBABILITY_TOLERANCE;
}

/** Recorded predictions of the lane and the field compared on each. */
function recordedPredictions(snapshot, lane) {
  if (lane === 'bets') return (snapshot.predictions || []).map((bet) => ({ id: bet.id, value: bet.baselineProbability }));
  return (snapshot.fullRunPredictions || [])
    .filter((pred) => DETECTOR_ORIGINS.has(pred.generationOrigin))
    .map((pred) => ({ id: pred.id, value: pred.probability, projections: pred.projections ?? null }));
}

export function compareReplay(snapshot, replayed, lane = snapshotLane(snapshot)) {
  const field = lane === 'bets' ? 'baselineProbability' : 'probability';
  const recorded = new Map(recordedPredictions(snapshot, lane).map((row) => [row.id, row]));
  const byId = new Map(replayed.map((row) => [row.id, row]));
  const report = { recorded: recorded.size, replayed: byId.size, exact: 0, differing: 0, missing: 0, extra: 0, diffs: [] };
  if (lane === 'detector') report.projections = { exact: 0, differing: 0 };
  for (const [id, row] of recorded) {
    const replay = byId.get(id);
    if (!replay) {
      report.missing += 1;
      continue;
    }
    if (sameProbability(row.value, replay[field])) report.exact += 1;
    else {
      report.differing += 1;
      if (report.diffs.length < MAX_REPORTED_DIFFS) report.diffs.push({ id, recorded: row.value, replayed: replay[field] });
    }
    if (lane === 'detector' && row.projections) {
      if (JSON.stringify(row.projections) === JSON.stringify(replay.projections)) report.projections.exact += 1;
      else report.projections.differing += 1;
    }
  }
  for (const id of byId.keys()) if (!recorded.has(id)) report.extra += 1;
  return report;
}

/**
 * A ledger window against the replay. It is scored on the probability it
 * opened with, so the replay is compared with firstSeenProbability (#8990):
 * an older row's `probability` may have moved to a later sighting.
 */
export function compareEntry(entry, replayed, lane) {
  if (!entry) return null;
  const replay = replayed.find((row) => row.id === entry.id);
  const horizon = entry.parentKey ? HORIZON_KEYS.find((key) => String(entry.key).endsWith(`@${key}`)) : null;
  let expected;
  let actual;
  if (lane === 'bets') {
    expected = entry.baselineProbability;
    actual = replay?.baselineProbability;
  } else {
    expected = entry.firstSeenProbability ?? entry.probability;
    actual = horizon ? replay?.projections?.[horizon] : replay?.probability;
  }
  return {
    key: entry.key,
    field: lane === 'bets' ? 'baselineProbability' : (horizon ? `projections.${horizon}` : 'probability'),
    expected: expected ?? null,
    replayed: actual ?? null,
    match: Boolean(replay) && sameProbability(expected, actual),
  };
}

export function passSucceeded(pass) {
  const { comparison, entry } = pass;
  return comparison.differing === 0 && comparison.missing === 0 && comparison.extra === 0
    && (!comparison.projections || comparison.projections.differing === 0)
    && (!entry || entry.match);
}

// ── Child pass: no credentials, no network, frozen clock ─────────────────

function freezeClock(nowMs) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }

    static now() {
      return nowMs;
    }
  }
  globalThis.Date = FrozenDate;
}

const CREDENTIAL_ENV = /UPSTASH|CLOUDFLARE|^R2_|TOKEN|SECRET|API_KEY|ACCESS_KEY/i;

// The pass must not be able to reach production: a credential in the
// environment, before or after the code under replay loads, aborts it.
function assertNoCredentials(stage) {
  const found = Object.keys(process.env).filter((name) => CREDENTIAL_ENV.test(name));
  if (found.length) throw new Error(`credentials in the replay environment ${stage}: ${found.join(', ')}`);
}

function blockNetwork() {
  globalThis.fetch = async () => { throw new Error('network disabled during replay'); };
}

async function runChildPass({ codeRoot, snapshot: snapshotPath, out }) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const lane = snapshotLane(snapshot);
  assertNoCredentials('at start');
  freezeClock(Number(snapshot.generatedAt));
  blockNetwork();
  const scripts = pathToFileURL(join(resolve(codeRoot), 'scripts/')).href;
  let replayed;
  if (lane === 'bets') {
    replayed = replayBetsStage(await import(`${scripts}seed-forecast-bets.mjs`), snapshot);
  } else if (lane === 'detector') {
    const [seedModule, emaModule] = await Promise.all([
      import(`${scripts}seed-forecasts.mjs`),
      import(`${scripts}_ema-threat-engine.mjs`),
    ]);
    replayed = replayDetectorStage(seedModule, emaModule, snapshot);
  } else {
    throw new Error('unrecognized snapshot shape');
  }
  assertNoCredentials('after loading the code');
  writeFileSync(out, JSON.stringify(replayed));
}

/** Runs one pass in a child process whose environment holds no credentials. */
export function runReplayPass({ codeRoot, snapshotPath, scratchDir }) {
  const out = join(scratchDir, `replay-${Math.random().toString(36).slice(2)}.json`);
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--child', `--code-root=${codeRoot}`, `--snapshot=${snapshotPath}`, `--out=${out}`], {
    cwd: codeRoot,
    env: { PATH: process.env.PATH || '', TZ: 'UTC' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || !existsSync(out)) {
    throw new Error(`replay pass failed at ${codeRoot}: ${(result.stderr || '').split('\n').filter(Boolean).slice(-5).join(' | ')}`);
  }
  const replayed = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  return replayed;
}

// ── Code checkout ────────────────────────────────────────────────────────

function git(args, options = {}) {
  return execFileSync('git', ['-C', REPO_ROOT, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

/** The recorded revision in a scratch worktree that shares this checkout's node_modules. */
function checkoutRevision(revision, scratchDir) {
  if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error(`not a commit sha: ${revision}`);
  try {
    git(['cat-file', '-e', `${revision}^{commit}`]);
  } catch {
    git(['fetch', '--quiet', 'origin', revision]);
  }
  const dir = join(scratchDir, `code-${revision.slice(0, 12)}`);
  git(['worktree', 'add', '--detach', '--quiet', dir, revision]);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  return {
    dir,
    cleanup: () => {
      try { git(['worktree', 'remove', '--force', dir]); } catch { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

// ── Production reads (read-only, private credentials) ───────────────────

async function readLedgerEntry(entryKey) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const resp = await fetch(`${url}/get/${encodeURIComponent(LEDGER_KEY)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'worldmonitor-replay/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Redis GET ${LEDGER_KEY} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload?.error || payload?.result == null) throw new Error(`Redis GET ${LEDGER_KEY} returned no ledger`);
  const { unwrapEnvelope } = await import('./_seed-envelope-source.mjs');
  const data = unwrapEnvelope(JSON.parse(payload.result)).data;
  const entries = Array.isArray(data) ? data : Object.values(data || {});
  const entry = entries.find((row) => row?.key === entryKey);
  if (!entry) throw new Error(`no ledger entry ${entryKey}`);
  return entry;
}

async function listRunIdsForDay(storageConfig, generatedAt) {
  if (storageConfig.mode !== 's3') throw new Error('locating a run without a runId needs the S3 trace credentials');
  const { getR2StorageClient } = await import('./_r2-storage.mjs');
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const client = await getR2StorageClient(storageConfig);
  const day = new Date(generatedAt).toISOString().slice(0, 10).replace(/-/g, '/');
  const prefix = `${storageConfig.basePrefix}/${day}/`;
  const runIds = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: storageConfig.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
    for (const item of page.CommonPrefixes || []) runIds.push(item.Prefix.slice(prefix.length).replace(/\/$/, ''));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return runIds;
}

/** Run ids minted shortly before `generatedAt`, latest first. */
export function legacyRunCandidates(runIds, generatedAt) {
  return runIds
    .map((runId) => ({ runId, mintedAt: Number(String(runId).split('-')[0]) }))
    .filter(({ runId, mintedAt }) => !runId.endsWith('-bets') && Number.isFinite(mintedAt) && mintedAt <= generatedAt && generatedAt - mintedAt < LEGACY_RUN_MATCH_WINDOW_MS)
    .sort((a, b) => b.mintedAt - a.mintedAt)
    .map(({ runId }) => runId);
}

async function fetchSnapshot({ runId, generatedAt, lane, storageConfig }) {
  const { getR2JsonObject } = await import('./_r2-storage.mjs');
  if (lane === 'bets') {
    const { buildBetsInputSnapshotKey } = await import('./_forecast-bets-keys.mjs');
    return getR2JsonObject(storageConfig, buildBetsInputSnapshotKey(runId, Number(String(runId).split('-')[0]), storageConfig.basePrefix));
  }
  const { buildDeepForecastSnapshotKey } = await import('./seed-forecasts.mjs');
  return getR2JsonObject(storageConfig, buildDeepForecastSnapshotKey(runId, generatedAt, storageConfig.basePrefix));
}

async function locateSnapshot({ entry, runId, generatedAt }) {
  const { resolveR2StorageConfig } = await import('./_r2-storage.mjs');
  const storageConfig = resolveR2StorageConfig();
  if (!storageConfig) throw new Error('R2 trace storage is not configured');
  const lane = entry?.generationOrigin === 'bet_engine' || String(runId).endsWith('-bets') ? 'bets' : 'detector';
  const at = Number(entry?.generatedAt ?? generatedAt);
  const id = entry?.runId || runId;
  if (id) {
    if (lane === 'detector' && !Number.isFinite(at)) throw new Error('--generated-at is required with a detector --run-id');
    return { snapshot: await fetchSnapshot({ runId: id, generatedAt: at, lane, storageConfig }), runId: id, located: 'run_id' };
  }
  if (lane === 'bets') throw new Error('bet_engine entries from before #9058 have no archived inputs');
  for (const candidate of legacyRunCandidates(await listRunIdsForDay(storageConfig, at), at)) {
    const snapshot = await fetchSnapshot({ runId: candidate, generatedAt: at, lane, storageConfig });
    if (Number(snapshot?.generatedAt) === at) return { snapshot, runId: candidate, located: 'generated_at_match' };
  }
  return { snapshot: null, runId: '', located: 'not_found' };
}

// ── Orchestration ────────────────────────────────────────────────────────

export async function replayForecastRun(options, { log = console.log } = {}) {
  let entry = null;
  let snapshot;
  let runId = options.runId;
  let located = 'local_file';
  if (options.snapshot) {
    snapshot = JSON.parse(readFileSync(options.snapshot, 'utf8'));
    runId = snapshot.runId || runId;
  } else {
    if (options.entryKey) entry = await readLedgerEntry(options.entryKey);
    ({ snapshot, runId, located } = await locateSnapshot({ entry, runId, generatedAt: options.generatedAt }));
  }
  if (!snapshot) return { status: 'snapshot_missing', runId, located, entry: entry?.key ?? null };
  const lane = snapshotLane(snapshot);
  if (!lane) return { status: 'snapshot_unrecognized', runId, located };

  const computedSha256 = snapshotDigest(snapshot);
  const recordedSha256 = entry?.snapshotSha256 ?? null;
  const report = {
    status: 'replayed',
    lane,
    runId,
    located,
    generatedAt: snapshot.generatedAt,
    snapshot: { sha256: computedSha256, recordedSha256, digestMatch: recordedSha256 ? recordedSha256 === computedSha256 : null },
    passes: [],
  };
  if (recordedSha256 && recordedSha256 !== computedSha256) {
    report.status = 'snapshot_digest_mismatch';
    return report;
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'wm-replay-'));
  chmodSync(scratchDir, 0o700);
  const cleanups = [];
  try {
    const snapshotPath = join(scratchDir, 'snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    const recordedRevision = lane === 'bets' ? snapshot.deployRevision : snapshot.triggerContext?.deployRevision;
    const firstRevision = options.code === 'recorded' ? recordedRevision : options.code;
    const plans = [];
    if (firstRevision && firstRevision !== 'current') plans.push({ label: options.code === 'recorded' ? 'recorded' : 'pinned', revision: firstRevision });
    else if (options.code === 'current') plans.push({ label: 'current', revision: 'current' });
    else return { ...report, status: 'revision_unknown' };
    if (options.candidate && plans[0].revision !== 'current') plans.push({ label: 'candidate', revision: 'current' });

    for (const plan of plans) {
      let codeRoot = REPO_ROOT;
      if (plan.revision !== 'current') {
        const checkout = checkoutRevision(plan.revision, scratchDir);
        cleanups.push(checkout.cleanup);
        codeRoot = checkout.dir;
      }
      log(`  [replay] ${plan.label} pass at ${plan.revision === 'current' ? 'this checkout' : plan.revision.slice(0, 12)}`);
      const replayed = runReplayPass({ codeRoot, snapshotPath, scratchDir });
      const pass = { label: plan.label, revision: plan.revision, comparison: compareReplay(snapshot, replayed, lane), entry: compareEntry(entry, replayed, lane) };
      pass.exact = passSucceeded(pass);
      report.passes.push(pass);
    }
    return report;
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH;
if (isDirectRun) {
  const options = parseReplayArgs(process.argv.slice(2));
  if (options.child) {
    await runChildPass(options);
  } else {
    if (!options.snapshot) {
      const { loadEnvFile } = await import('./_seed-utils.mjs');
      loadEnvFile(import.meta.url);
    }
    if (!options.snapshot && !options.entryKey && !options.runId) {
      console.error('usage: replay-forecast-detectors.mjs --entry-key=<key> | --run-id=<id> [--generated-at=<ms>] | --snapshot=<file> [--code=recorded|current|<sha>] [--candidate]');
      process.exit(2);
    }
    const report = await replayForecastRun(options, { log: (line) => console.error(line) });
    console.log(JSON.stringify(report, null, 2));
    const first = report.passes?.[0];
    process.exit(report.status === 'replayed' && first?.exact ? 0 : 1);
  }
}
