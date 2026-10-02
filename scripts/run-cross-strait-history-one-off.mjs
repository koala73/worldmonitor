#!/usr/bin/env node
/**
 * Run the Cross-Strait seeder once inside a Railway sandbox.
 *
 * The sandbox receives server-side references to the deployed
 * seed-bundle-derived-signals service. It validates the complete canonical,
 * source, history, and revision contract before it fetches code or starts the
 * seeder. The command is intentionally fixed: this is not a general remote
 * command runner.
 *
 * Usage:
 *   npm run railway:cross-strait-history:force -- \
 *     --project <project-id> --environment <production-id-or-name> \
 *     --confirm-production
 */

import { spawn } from 'node:child_process';

import { createRailwayCliEnv } from './railway-cli.mjs';

const SOURCE_SERVICE = 'seed-bundle-derived-signals';
const SANDBOX_IDLE_TIMEOUT_MINUTES = 15;
const CREATE_TIMEOUT_MS = 120_000;
const PREFLIGHT_TIMEOUT_MS = 90_000;
const SEED_TIMEOUT_MS = 900_000;
const CLEANUP_TIMEOUT_MS = 90_000;
const PREFLIGHT_STATUS_MARKER = '__WM_ONE_OFF_PREFLIGHT__';
const SEED_STATUS_MARKER = '__WM_ONE_OFF_SEED__';
const SEED_FAILURE_CODES = new Set([
  'workspace_setup_failed',
  'revision_fetch_failed',
  'revision_checkout_failed',
  'revision_mismatch',
  'dependency_install_failed',
  'seed_output_overflow',
  'seed_process_failed',
  'seed_lock_unavailable',
  'seed_already_running',
  'seed_validation_failed',
  'seed_no_source',
  'seed_incomplete',
  'run_id_missing',
  'history_postflight_failed',
]);

export const CROSS_STRAIT_ONE_OFF_REQUIREMENTS = Object.freeze([
  Object.freeze({ names: Object.freeze(['UPSTASH_REDIS_REST_URL']) }),
  Object.freeze({ names: Object.freeze(['UPSTASH_REDIS_REST_TOKEN']) }),
  Object.freeze({ names: Object.freeze(['JAPAN_MOD_PROXY_URL', 'PROXY_URL']) }),
  Object.freeze({ names: Object.freeze(['CONVEX_SITE_URL', 'CONVEX_URL']) }),
  Object.freeze({ names: Object.freeze(['RELAY_SHARED_SECRET']) }),
  Object.freeze({ names: Object.freeze(['OPENROUTER_API_KEY']) }),
]);

function buildSandboxPreflightProgram() {
  const groups = JSON.stringify(CROSS_STRAIT_ONE_OFF_REQUIREMENTS);
  return `
const groups = ${groups};
const marker = '${PREFLIGHT_STATUS_MARKER}';
const usable = (value) => typeof value === 'string'
  && value.trim().length > 0
  && !value.includes('$' + '{{');
const missing = groups
  .filter((group) => {
    const effective = group.names.map((name) => process.env[name]).find(Boolean);
    return !usable(effective);
  })
  .map((group) => group.names.join(' or '));
const commit = String(process.env.WM_ONE_OFF_DEPLOYED_COMMIT ?? '').trim();
if (!/^[0-9a-f]{40}$/.test(commit)) missing.push('WM_ONE_OFF_DEPLOYED_COMMIT');
if (missing.length > 0) {
  console.log(marker + JSON.stringify({ status: 'rejected', missing }));
  process.exit(78);
}
console.log(marker + JSON.stringify({ status: 'accepted', revision: commit }));
`.trim();
}

export const SANDBOX_PREFLIGHT_PROGRAM = buildSandboxPreflightProgram();

export function validateHistoryPostflightRecord(record, runId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('history ingest health record is missing or malformed');
  }
  if (record.lastRunId !== runId) {
    throw new Error('history ingest health does not belong to this seed run');
  }
  const counters = [
    record.lastChunks,
    record.lastAbandoned,
    record.lastFailedChunks,
    record.lastInputRecords,
    record.lastNormalizedRecords,
    record.lastDroppedRecords,
    record.lastAcceptedRecords,
    record.lastInserted,
    record.lastDeduped,
    record.lastRetracted,
  ];
  if (record.state !== 'healthy'
    || counters.some((value) => !Number.isSafeInteger(value) || value < 0)
    || record.lastChunks < 1
    || record.lastAbandoned !== 0
    || record.lastFailedChunks !== 0
    || record.lastDroppedRecords !== 0
    || record.lastInputRecords !== record.lastNormalizedRecords
    || record.lastInserted + record.lastDeduped !== record.lastAcceptedRecords
    || record.lastAcceptedRecords + record.lastRetracted !== record.lastNormalizedRecords) {
    throw new Error('history ingest did not complete without record loss');
  }
}

export const HISTORY_POSTFLIGHT_PROGRAM = `
const validate = ${validateHistoryPostflightRecord.toString()};
const runId = String(process.argv[1] ?? '');
const url = String(process.env.UPSTASH_REDIS_REST_URL ?? '');
const token = String(process.env.UPSTASH_REDIS_REST_TOKEN ?? '');
const key = 'intel-history:ingest-health:military:cross-strait-activity:v1:run:' + runId;
const response = await fetch(url + '/get/' + encodeURIComponent(key), {
  headers: {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'WorldMonitor-Cross-Strait-One-Off/1.0',
  },
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error('history ingest health read failed');
const body = await response.json();
let record;
try { record = JSON.parse(body?.result); } catch { record = null; }
validate(record, runId);
console.log('[cross-strait-one-off] history postflight accepted for run ' + runId);
`.trim();

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const SEED_SUPERVISOR_PROGRAM = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const outputPath = String(process.argv[1] ?? '');
const overflowPath = String(process.argv[2] ?? '');
const limit = 1024 * 1024;
const output = fs.openSync(outputPath, 'wx', 0o600);
let child;
let written = 0;
let outcome;
let killTimer;
const stop = (nextOutcome) => {
  if (outcome) return;
  if (nextOutcome === 'overflow') {
    try {
      fs.writeFileSync(overflowPath, '', { flag: 'wx', mode: 0o600 });
    } catch {
      nextOutcome = 'io_error';
    }
  }
  outcome = nextOutcome;
  if (child) {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child?.kill('SIGKILL'), 5000);
  }
};
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop('signal'));
}
child = spawn('node', ['seed-cross-strait-activity.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const capture = (chunk) => {
  if (outcome) return;
  const kept = Math.min(chunk.length, limit - written);
  try {
    if (kept > 0) fs.writeSync(output, chunk, 0, kept);
  } catch {
    stop('io_error');
    return;
  }
  written += kept;
  if (kept === chunk.length) return;
  stop('overflow');
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.stdout.on('error', () => stop('io_error'));
child.stderr.on('error', () => stop('io_error'));
child.once('error', () => stop('spawn_error'));
child.once('close', (code) => {
  clearTimeout(killTimer);
  try {
    fs.closeSync(output);
  } catch {
    outcome ||= 'io_error';
  }
  if (outcome === 'overflow') process.exitCode = 75;
  else if (outcome === 'signal') process.exitCode = 143;
  else if (outcome) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
`.trim();

export const SANDBOX_SEED_PROGRAM = `
set -eu
workspace="$(mktemp -d)"
seed_pid=''
emit_seed_result() {
  printf '%s{"status":"%s","code":"%s"}\\n' '${SEED_STATUS_MARKER}' "$1" "$2"
}
reject_seed() {
  emit_seed_result rejected "$1"
  exit "\${2:-75}"
}
cleanup_workspace() {
  rm -rf "$workspace"
}
handle_signal() {
  trap '' HUP INT TERM
  if [ -n "$seed_pid" ]; then
    kill -TERM "$seed_pid" 2>/dev/null || true
    remaining=7
    while kill -0 "$seed_pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
      sleep 1
      remaining=$((remaining - 1))
    done
    if kill -0 "$seed_pid" 2>/dev/null; then
      kill -KILL "$seed_pid" 2>/dev/null || true
    fi
    wait "$seed_pid" 2>/dev/null || true
  fi
  exit 143
}
trap cleanup_workspace EXIT
trap handle_signal HUP INT TERM
git init --quiet "$workspace" >/dev/null 2>&1 || reject_seed workspace_setup_failed 75
git -C "$workspace" remote add origin https://github.com/koala73/worldmonitor.git >/dev/null 2>&1 || reject_seed workspace_setup_failed 75
git -C "$workspace" fetch --quiet --depth=1 origin "$WM_ONE_OFF_DEPLOYED_COMMIT" >/dev/null 2>&1 || reject_seed revision_fetch_failed 75
git -C "$workspace" checkout --quiet --detach FETCH_HEAD >/dev/null 2>&1 || reject_seed revision_checkout_failed 75
if ! actual_commit="$(git -C "$workspace" rev-parse HEAD 2>/dev/null)"; then
  reject_seed revision_mismatch 78
fi
if [ "$actual_commit" != "$WM_ONE_OFF_DEPLOYED_COMMIT" ]; then
  reject_seed revision_mismatch 78
fi
cd "$workspace/scripts"
npm ci --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null 2>&1 || reject_seed dependency_install_failed 75
seed_output="$workspace/seed-output.log"
overflow_marker="$workspace/seed-output.overflow"
set +e
WM_ONE_OFF_HISTORY_RECEIPT=1 node --eval ${shellSingleQuote(SEED_SUPERVISOR_PROGRAM)} "$seed_output" "$overflow_marker" supervisor &
seed_pid=$!
wait "$seed_pid"
exit_code=$?
seed_pid=''
set -e
if [ -f "$overflow_marker" ]; then
  reject_seed seed_output_overflow 75
fi
if [ "$exit_code" -ne 0 ]; then
  reject_seed seed_process_failed "$exit_code"
fi
grep -q 'SKIPPED: Redis unavailable during lock acquisition' "$seed_output" && reject_seed seed_lock_unavailable 75
grep -q 'SKIPPED: another seed run in progress' "$seed_output" && reject_seed seed_already_running 75
grep -q 'SKIPPED: validation failed' "$seed_output" && reject_seed seed_validation_failed 75
grep -q 'NO SOURCE:' "$seed_output" && reject_seed seed_no_source 75
grep -q 'RETRY:' "$seed_output" && reject_seed seed_incomplete 75
run_id="$(sed -n 's/^[[:space:]]*Run ID:[[:space:]]*//p' "$seed_output" | head -n 1)"
if [ -z "$run_id" ]; then
  reject_seed run_id_missing 75
fi
if ! node --eval ${shellSingleQuote(HISTORY_POSTFLIGHT_PROGRAM)} "$run_id" >/dev/null 2>&1; then
  reject_seed history_postflight_failed 1
fi
emit_seed_result accepted accepted
`.trim();

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} must be an explicit Railway name or ID`);
  }
  return value;
}

function targetArgs({ project, environment }) {
  return [
    '--project', requireIdentifier(project, 'project'),
    '--environment', requireIdentifier(environment, 'environment'),
  ];
}

export function buildSandboxCreateArgs({ project, environment }) {
  const variables = CROSS_STRAIT_ONE_OFF_REQUIREMENTS
    .flatMap((group) => group.names)
    .flatMap((name) => ['--variable', `${name}=${SOURCE_SERVICE}.${name}`]);
  return [
    'sandbox', 'create',
    ...targetArgs({ project, environment }),
    '--idle-timeout-minutes', String(SANDBOX_IDLE_TIMEOUT_MINUTES),
    '--json',
    ...variables,
    '--variable', `WM_ONE_OFF_DEPLOYED_COMMIT=${SOURCE_SERVICE}.RAILWAY_GIT_COMMIT_SHA`,
  ];
}

function buildSandboxExecArgs({ project, environment, sandboxId, timeoutSeconds, command }) {
  return [
    'sandbox', 'exec',
    ...targetArgs({ project, environment }),
    '--id', requireIdentifier(sandboxId, 'sandbox ID'),
    '--timeout', String(timeoutSeconds),
    '--',
    ...command,
  ];
}

function buildSandboxDestroyArgs({ project, environment, sandboxId }) {
  return [
    'sandbox', 'destroy',
    ...targetArgs({ project, environment }),
    '--id', requireIdentifier(sandboxId, 'sandbox ID'),
  ];
}

function parseSandboxId(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Railway sandbox create returned invalid JSON; the 15-minute server idle timeout remains active');
  }
  if (typeof parsed?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parsed.id)) {
    throw new Error('Railway sandbox create returned no valid sandbox ID; the 15-minute server idle timeout remains active');
  }
  return parsed.id;
}

function sanitizedPreflightFailure(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .findLast((candidate) => candidate.startsWith(PREFLIGHT_STATUS_MARKER));
  if (!line) return '';
  let parsed;
  try {
    parsed = JSON.parse(line.slice(PREFLIGHT_STATUS_MARKER.length));
  } catch {
    return '';
  }
  const allowed = new Set([
    ...CROSS_STRAIT_ONE_OFF_REQUIREMENTS.map((group) => group.names.join(' or ')),
    'WM_ONE_OFF_DEPLOYED_COMMIT',
  ]);
  const missing = Array.isArray(parsed?.missing)
    ? parsed.missing.filter((name) => allowed.has(name))
    : [];
  return parsed?.status === 'rejected' && missing.length > 0
    ? `; missing ${missing.join(', ')}`
    : '';
}

function sanitizedSeedResult(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .findLast((candidate) => candidate.startsWith(SEED_STATUS_MARKER));
  if (!line) return null;
  let parsed;
  try {
    parsed = JSON.parse(line.slice(SEED_STATUS_MARKER.length));
  } catch {
    return null;
  }
  if (parsed?.status === 'accepted' && parsed?.code === 'accepted') {
    return { status: 'accepted' };
  }
  if (parsed?.status === 'rejected' && SEED_FAILURE_CODES.has(parsed?.code)) {
    return { status: 'rejected', code: parsed.code };
  }
  return null;
}

export function createRailwayExecutor(spawnImpl = spawn, env = process.env) {
  let activeInterrupt = null;
  const execute = (args, { stage, timeoutMs }) => new Promise((resolve, reject) => {
    const captureResponse = stage === 'create' || stage === 'preflight' || stage === 'seed';
    const child = spawnImpl('railway', args, {
      env: createRailwayCliEnv(env),
      stdio: captureResponse ? ['ignore', 'pipe', 'ignore'] : 'ignore',
    });
    let stdout = '';
    let stdoutBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let timer = null;
    let forceKillTimer = null;
    const terminate = () => {
      child.kill('SIGTERM');
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        forceKillTimer.unref?.();
      }
    };
    activeInterrupt = terminate;
    const finish = (error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (activeInterrupt === terminate) activeInterrupt = null;
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (outputLimitExceeded) return;
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 1024 * 1024) {
        outputLimitExceeded = true;
        stdout = '';
        terminate();
      }
    });
    child.once('error', (error) => {
      finish(new Error(`Railway ${stage} could not start; remote output suppressed`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`Railway ${stage} timed out; remote output suppressed`));
      } else if (outputLimitExceeded) {
        finish(new Error(`Railway ${stage} response exceeded the output limit; remote output suppressed`));
      } else if (signal) {
        finish(new Error(`Railway ${stage} stopped by ${signal}; remote output suppressed`));
      } else if (code !== 0) {
        const seedResult = stage === 'seed' ? sanitizedSeedResult(stdout) : null;
        const detail = stage === 'preflight'
          ? sanitizedPreflightFailure(stdout)
          : seedResult?.status === 'rejected'
            ? `; reason ${seedResult.code}`
            : '';
        finish(new Error(`Railway ${stage} failed (exit ${code})${detail}; remote output suppressed`));
      } else if (stage === 'seed' && sanitizedSeedResult(stdout)?.status !== 'accepted') {
        finish(new Error('Railway seed returned no accepted status; remote output suppressed'));
      } else {
        finish(null, stage === 'create' || stage === 'preflight' ? stdout : '');
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
  });
  execute.interrupt = () => {
    activeInterrupt?.();
  };
  return execute;
}

export async function runCrossStraitHistoryOneOff({
  project,
  environment,
  executeRailway = createRailwayExecutor(),
  log = console.log,
  processSignals = process,
}) {
  requireIdentifier(project, 'project');
  requireIdentifier(environment, 'environment');

  let sandboxId;
  let primaryError;
  let cleanupError;
  let interruptedSignal;
  let cleanupInProgress = false;
  const handleInterrupt = (signal) => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    if (!cleanupInProgress) executeRailway.interrupt?.();
  };
  processSignals.on('SIGHUP', handleInterrupt);
  processSignals.on('SIGINT', handleInterrupt);
  processSignals.on('SIGTERM', handleInterrupt);
  try {
    log('[cross-strait-one-off] creating bounded Railway sandbox');
    const created = await executeRailway(
      buildSandboxCreateArgs({ project, environment }),
      { stage: 'create', timeoutMs: CREATE_TIMEOUT_MS },
    );
    sandboxId = parseSandboxId(created);
    if (interruptedSignal) {
      throw new Error(`${interruptedSignal} received; stopping before sandbox preflight`);
    }

    log(`[cross-strait-one-off] validating configuration in sandbox ${sandboxId}`);
    await executeRailway(buildSandboxExecArgs({
      project,
      environment,
      sandboxId,
      timeoutSeconds: Math.floor(PREFLIGHT_TIMEOUT_MS / 1000),
      command: ['node', '--eval', SANDBOX_PREFLIGHT_PROGRAM],
    }), { stage: 'preflight', timeoutMs: PREFLIGHT_TIMEOUT_MS });
    if (interruptedSignal) {
      throw new Error(`${interruptedSignal} received; stopping before the seeder`);
    }

    log('[cross-strait-one-off] running the Cross-Strait seeder at the deployed revision');
    await executeRailway(buildSandboxExecArgs({
      project,
      environment,
      sandboxId,
      timeoutSeconds: Math.floor(SEED_TIMEOUT_MS / 1000) - 10,
      command: ['/bin/sh', '-lc', SANDBOX_SEED_PROGRAM],
    }), { stage: 'seed', timeoutMs: SEED_TIMEOUT_MS });
  } catch (error) {
    primaryError = error;
  }

  if (sandboxId) {
    cleanupInProgress = true;
    try {
      log(`[cross-strait-one-off] destroying sandbox ${sandboxId}`);
      await executeRailway(
        buildSandboxDestroyArgs({ project, environment, sandboxId }),
        { stage: 'cleanup', timeoutMs: CLEANUP_TIMEOUT_MS },
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  processSignals.off('SIGHUP', handleInterrupt);
  processSignals.off('SIGINT', handleInterrupt);
  processSignals.off('SIGTERM', handleInterrupt);

  if (!primaryError && interruptedSignal) {
    primaryError = new Error(cleanupError
      ? `${interruptedSignal} received during sandbox cleanup`
      : `${interruptedSignal} received; sandbox was cleaned up before exit`);
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Cross-Strait one-off failed and explicit sandbox cleanup also failed; the server idle timeout remains active',
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  log('[cross-strait-one-off] completed and cleaned up');
}

export function formatCliError(error) {
  const message = error?.message || String(error);
  if (!(error instanceof AggregateError)) return message;
  return [message, ...error.errors.map((item) => item?.message || String(item))].join('; ');
}

function parseArgs(argv) {
  const parsed = { project: null, environment: null, confirmed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm-production') {
      parsed.confirmed = true;
      continue;
    }
    if (arg === '--project' || arg === '--environment') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.confirmed) throw new Error('--confirm-production is required');
  return {
    project: requireIdentifier(parsed.project, 'project'),
    environment: requireIdentifier(parsed.environment, 'environment'),
  };
}

if (process.argv[1]?.endsWith('run-cross-strait-history-one-off.mjs')) {
  try {
    await runCrossStraitHistoryOneOff(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[cross-strait-one-off] ${formatCliError(error)}`);
    process.exitCode = 1;
  }
}
