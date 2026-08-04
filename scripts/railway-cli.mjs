// The Railway CLI calls this repository's operational scripts share.
//
// Three scripts talk to the same production project — the watch-path audit, the
// deploy-drift check and the deploy trigger — and they had begun to carry
// private copies of the same invocations. A duplicated `railway deployment
// list` is not a style problem: the flags encode the WINDOW each script reads,
// and two copies that drift read different amounts of history and answer
// "which deployment is running" differently.
//
// I/O only. The meaning of what comes back lives in
// scripts/railway-deployments.mjs (record semantics) and
// scripts/railway-deploy-closure.mjs (what a change can reach), both pure.

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REPOSITORY = 'koala73/worldmonitor';

// A hung Railway call must not consume the whole job budget: these run inside
// scheduled workflows with a wall-clock timeout, and a subprocess with no bound
// turns one unresponsive API call into a cancelled monitor.
export const RAILWAY_CALL_TIMEOUT_MS = 60_000;

// One `railway deployment list` per service, run serially, took over ten
// minutes against the 77-service production fleet — longer than the interval
// these checks run on. The calls are independent read-only round trips, so they
// fan out; the cap keeps us from opening 77 CLI processes and being rate
// limited or starved of file descriptors.
export const DEFAULT_CONCURRENCY = 8;

export function runRailway(args, options = {}) {
  const result = spawnSync('railway', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: RAILWAY_CALL_TIMEOUT_MS,
    ...options,
  });
  if (result.signal) {
    throw new Error(`railway ${args.join(' ')} timed out after ${RAILWAY_CALL_TIMEOUT_MS}ms`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `railway ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// Every live service Railway builds from this repository, which is a broader
// set than the seeders: it also covers the relays, the workers, the
// consumer-prices trio and the collector. One definition of "ours", so the
// audit, the drift check and the trigger cannot each have their own idea of
// which services count.
export function isRepositoryService(service) {
  return service?.source?.repo === REPOSITORY;
}

/** Every service in the environment, unfiltered. */
export function readServices(environment) {
  const services = JSON.parse(runRailway(['service', 'list', '--environment', environment, '--json']));
  if (!Array.isArray(services)) throw new Error('railway service list must return an array');
  return services;
}

/** Just the ones this repository deploys. */
export function readRepositoryServices(environment) {
  return readServices(environment).filter(isRepositoryService);
}

/**
 * The environment's service configuration, keyed by service id.
 *
 * Fails closed on an unexpected payload. A `?? {}` here would turn a renamed
 * key or a CLI output-shape change into "no live service is described", which
 * resolveServiceClosure reads as "watches everything" — widening every closure,
 * which reports the whole fleet behind and would make the trigger deploy it.
 */
export function readEnvironmentConfig(environment) {
  const config = JSON.parse(runRailway([
    'environment', 'config', '--environment', environment, '--json',
  ]));
  if (!config?.services || typeof config.services !== 'object' || Array.isArray(config.services)) {
    throw new Error('Railway environment config must contain a services object');
  }
  return config;
}

/** One service's deployment history, newest first, up to `window` records. */
export async function readDeployments(service, environment, window) {
  const { stdout } = await execFileAsync('railway', [
    'deployment',
    'list',
    '--service',
    service.id ?? service.name,
    '--environment',
    environment,
    '--limit',
    String(window),
    '--json',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RAILWAY_CALL_TIMEOUT_MS });
  return JSON.parse(stdout);
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// Accepts both `--flag value` and `--flag=value`. The equals form matters: an
// exact indexOf match silently misses it, and this value selects which Railway
// environment a mutating run targets, so a missed `--environment=staging` would
// patch production with no error and no signal.
export function readArgument(argv, name, fallback) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  }
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
