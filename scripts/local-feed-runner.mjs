#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KILL_GRACE_MS = 5_000;

// Cadences follow existing producers, not a blanket refresh interval. Execution
// budgets bound hung children independently of the providers' cache freshness.
export const LOCAL_FEED_JOBS = Object.freeze([
  Object.freeze({
    id: 'aviation', script: 'seed-aviation.mjs', intervalMs: 30 * MINUTE, timeoutMs: 5 * MINUTE,
    description: 'FAA delays and aviation news; ICAO and AviationStack only with configured keys.',
    // seed-aviation.mjs: 30min cron, NEWS_TTL=40min, FAA_TTL=2h.
    requiredCredentials: [], optionalCredentials: ['ICAO_API_KEY', 'AVIATIONSTACK_API'],
  }),
  Object.freeze({
    id: 'military-flights', script: 'seed-military-flights.mjs', intervalMs: 5 * MINUTE, timeoutMs: 2 * MINUTE,
    description: 'Public adsb.lol military observations and optional Wingbits enrichment; OpenSky seeding stays disabled.',
    // seed-military-flights.mjs: */5 cron, LIVE_TTL=600s, lock=120s.
    requiredCredentials: [], optionalCredentials: ['WINGBITS_API_KEY'],
  }),
  Object.freeze({
    id: 'webcams', script: 'seed-webcams.mjs', intervalMs: 12 * HOUR, timeoutMs: 15 * MINUTE,
    description: 'Windy webcam metadata and spatial index; does not collect camera video.',
    // docs/webcam-layer.mdx: every 12–18h; seed-webcams.mjs GEO_TTL=24h.
    requiredCredentials: ['WINDY_API_KEY'], optionalCredentials: [],
  }),
  Object.freeze({
    id: 'portwatch', script: 'seed-portwatch.mjs', intervalMs: 6 * HOUR, timeoutMs: 5 * MINUTE,
    description: 'PortWatch chokepoint transit aggregates; upstream observations are daily, not live vessel positions.',
    // seed-bundle-portwatch.mjs PW-Main: 6h cadence, 300s budget; data TTL=12h.
    requiredCredentials: [], optionalCredentials: [],
  }),
]);

export function selectLocalFeedJobs(raw) {
  const names = typeof raw === 'string' ? raw.split(',').map((name) => name.trim()) : raw;
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => !name)) {
    throw new Error('Select feeds with --jobs or LOCAL_FEED_JOBS; use --list to see the allowlist.');
  }
  return [...new Set(names)].map((name) => {
    const job = LOCAL_FEED_JOBS.find((candidate) => candidate.id === name);
    if (!job) throw new Error('Unknown feed job; use --list to see the allowlist.');
    return job;
  });
}

export function localFeedReadiness(job, env) {
  const missing = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
    .filter((name) => !env[name]?.trim());
  if (missing.length) return { ready: false, status: 'failed', reason: `Missing ${missing.join(', ')}` };
  try {
    const url = new URL(env.UPSTASH_REDIS_REST_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  } catch {
    return { ready: false, status: 'failed', reason: 'Invalid UPSTASH_REDIS_REST_URL' };
  }
  const unavailable = job.requiredCredentials.filter((name) => !env[name]?.trim());
  if (unavailable.length) return { ready: false, status: 'skipped', reason: `Missing ${unavailable.join(', ')}` };
  return { ready: true };
}

function terminateProcess(child, signal) {
  try {
    // Each seeder has its own group, so cancellation also reaches a descendant
    // it started. Windows does not support POSIX process-group signals.
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function createLocalFeedRunner({
  jobs, env = process.env, once = false, maxConcurrent = 2,
  spawnProcess = spawn, killProcess = terminateProcess,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  logger = (event) => console.log(`[local-feeds] ${JSON.stringify(event)}`),
} = {}) {
  const selected = selectLocalFeedJobs(jobs);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
    throw new Error('Feed concurrency must be between 1 and 4.');
  }
  const states = selected.map((job) => ({ job, nextDue: 0, attempted: false, running: null }));
  const results = new Map();
  let stopped = false;
  let started = false;
  let wakeTimer = null;
  let finish;
  const done = new Promise((resolveDone) => { finish = resolveDone; });
  const activeCount = () => states.filter((state) => state.running).length;
  const eligible = (state) => !state.running && (!once || !state.attempted);

  function report(result) {
    results.set(result.job, result);
    logger(result);
  }
  function completeIfDone() {
    if (activeCount() === 0 && (stopped || (once && states.every((state) => state.attempted)))) {
      finish([...results.values()]);
      return true;
    }
    return false;
  }
  function stopChild(running, reason) {
    if (running.stopReason) return;
    running.stopReason = reason;
    running.killTimer = setTimer(() => {
      try { killProcess(running.child, 'SIGKILL'); } catch { logger({ job: running.job.id, status: 'signal-error' }); }
    }, KILL_GRACE_MS);
    try { killProcess(running.child, 'SIGTERM'); } catch { logger({ job: running.job.id, status: 'signal-error' }); }
  }
  function launch(state) {
    state.attempted = true;
    const startedAt = now();
    state.nextDue = startedAt + state.job.intervalMs;
    const readiness = localFeedReadiness(state.job, env);
    if (!readiness.ready) {
      report({ job: state.job.id, status: readiness.status, reason: readiness.reason });
      return;
    }
    const running = { job: state.job, child: null, timeout: null, killTimer: null, stopReason: null };
    state.running = running;
    const settle = (status, extra = {}) => {
      if (state.running !== running) return;
      clearTimer(running.timeout);
      clearTimer(running.killTimer);
      state.running = null;
      report({ job: state.job.id, status, durationMs: now() - startedAt, ...extra });
      queueMicrotask(tick);
    };
    try {
      running.child = spawnProcess(process.execPath, [join(scriptsDirectory, state.job.script)], {
        cwd: join(scriptsDirectory, '..'),
        // Do not let the military collector expand this opt-in job list by
        // launching the forecast seeder through its optional chaining hook.
        env: { ...env, CHAIN_FORECAST_SEED_ON_MILITARY: '0' },
        shell: false, detached: process.platform !== 'win32', stdio: 'inherit',
      });
      running.child.once('error', () => settle('failed', { reason: 'Unable to start seeder' }));
      running.child.once('close', (code, signal) => settle(
        running.stopReason || (code === 0 ? 'completed' : 'failed'), { code, signal },
      ));
      running.timeout = setTimer(() => stopChild(running, 'timed-out'), state.job.timeoutMs);
      logger({ job: state.job.id, status: 'started', intervalMs: state.job.intervalMs, timeoutMs: state.job.timeoutMs });
    } catch {
      settle('failed', { reason: 'Unable to start seeder' });
    }
  }
  function tick() {
    clearTimer(wakeTimer);
    wakeTimer = null;
    if (!stopped) {
      for (const state of states) {
        if (activeCount() >= maxConcurrent) break;
        if (eligible(state) && state.nextDue <= now()) launch(state);
      }
    }
    if (completeIfDone() || stopped || activeCount() >= maxConcurrent) return;
    const due = states.filter(eligible).map((state) => state.nextDue);
    if (due.length) wakeTimer = setTimer(tick, Math.max(0, Math.min(...due) - now()));
  }

  return {
    start() { if (!started) { started = true; tick(); } return done; },
    stop() {
      stopped = true;
      clearTimer(wakeTimer);
      wakeTimer = null;
      for (const state of states) if (state.running) stopChild(state.running, 'stopped');
      completeIfDone();
      return done;
    },
    done,
  };
}

export function parseLocalFeedArgs(args, env = process.env) {
  let jobs = env.LOCAL_FEED_JOBS;
  let once = false;
  let list = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--once') once = true;
    else if (arg === '--list') list = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--jobs' && args[i + 1] && !args[i + 1].startsWith('--')) jobs = args[++i];
    else if (arg.startsWith('--jobs=')) jobs = arg.slice('--jobs='.length);
    else throw new Error('Unknown or incomplete option; use --help.');
  }
  if (!help && !list) selectLocalFeedJobs(jobs);
  return { jobs, once, list, help };
}

export async function main(args = process.argv.slice(2)) {
  loadEnvFile(import.meta.url);
  const options = parseLocalFeedArgs(args);
  if (options.help) {
    console.log('Usage: node scripts/local-feed-runner.mjs --jobs aviation,military-flights [--once]\n'
      + '       node scripts/local-feed-runner.mjs --list\n'
      + 'LOCAL_FEED_JOBS may supply the comma-separated opt-in list. No jobs run by default.\n'
      + 'Without --once the runner stays in the foreground. SIGINT/SIGTERM stop its children.');
    return 0;
  }
  if (options.list) {
    console.log(JSON.stringify(LOCAL_FEED_JOBS.map((job) => ({
      ...job, readiness: localFeedReadiness(job, process.env),
      configuredOptionalCredentials: job.optionalCredentials.filter((name) => process.env[name]?.trim()),
    })), null, 2));
    return 0;
  }
  const runner = createLocalFeedRunner(options);
  const shutdown = () => { void runner.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const results = await runner.start();
    return results.some((result) => ['failed', 'timed-out'].includes(result.status)) ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[local-feeds] ${error.message}`);
    process.exitCode = 1;
  });
}
