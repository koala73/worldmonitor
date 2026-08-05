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

const GIT_CALL_TIMEOUT_MS = 30_000;

/**
 * Run git, throwing an error that PRESERVES the exit status.
 *
 * The status is not decoration: `git merge-base --is-ancestor` answers "no"
 * with exit 1 and "that object is not here" with 128, and a caller that cannot
 * tell those apart has to collapse them into one guess. For an ancestry
 * question feeding a deploy decision, guessing "no" means deploying over a
 * commit you could not evaluate.
 *
 * maxBuffer is generous because `git diff --name-only` across a service weeks
 * behind runs to thousands of paths, and the default 1MB cap would turn that
 * into a thrown error for exactly the services that most need classifying.
 */
export function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_CALL_TIMEOUT_MS,
    ...options,
  });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout.trim();
}

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

/**
 * The environment's id, for the deploy mutation.
 *
 * `--project` is not optional on a CI runner. A clean runner has no `.railway`
 * link, and a bare `railway status --json` answers "No linked project found" —
 * which JSON.parse then fails on, at the moment of deploying. Every other call
 * this script makes (service list, environment config, deployment list) is
 * proven to work on just the project-scoped RAILWAY_TOKEN by the freshness
 * monitor that has been running them every 15 minutes; `railway status` is the
 * one call that workflow passes `--project` to, and this had been the only
 * place in the new code without that precedent.
 */
export function resolveEnvironmentId(environmentName, projectId = process.env.RAILWAY_PROJECT_ID) {
  const status = JSON.parse(runRailway([
    'status',
    ...(projectId ? ['--project', projectId] : []),
    '--environment', environmentName,
    '--json',
  ]));
  const nodes = (status?.environments?.edges ?? []).map((edge) => edge?.node).filter(Boolean);
  const match = nodes.find((node) => node.name === environmentName);
  if (!match?.id) {
    throw new Error(
      `no environment named ${environmentName} in this Railway project (saw ${nodes.map((node) => node.name).join(', ') || 'none'})`,
    );
  }
  return match.id;
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

// One page of the fleet-wide stream. 500 is what the measured 78-service fleet
// needed 6 of to surface every service's newest running deployment; larger
// pages mostly buy depth for the slow-ticking tail, which the per-service
// fallback handles more cheaply.
// Declaration order below is not call order: readDeploymentsForFleet uses
// readDeployments and mapWithConcurrency, which are hoisted function
// declarations defined further down.
export const FLEET_PAGE_SIZE = 500;

// Bounded so a pathological fleet cannot page forever. Whatever is still
// unresolved at the cap falls back to a direct read rather than being guessed.
export const FLEET_MAX_PAGES = 10;

const FLEET_QUERY = `query FleetDeployments($input: DeploymentListInput!, $first: Int, $after: String) {
  deployments(input: $input, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { id status createdAt serviceId meta } }
  }
}`;

/** Run one GraphQL document through the Railway CLI and return `data`. */
export function runRailwayApi(query, variables) {
  const stdout = runRailway(['api', query, '--variables', JSON.stringify(variables), '--compact']);
  // `railway api` can print advisory lines before the payload; the JSON document
  // is the first line that parses.
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      throw new Error(parsed.errors.map((error) => error?.message ?? String(error)).join('; '));
    }
    if (parsed?.data) return parsed.data;
  }
  throw new Error('railway api returned no JSON payload');
}

/**
 * Every repository service's recent deployment history, in a handful of calls
 * instead of one per service.
 *
 * `deployments(input: {projectId, environmentId})` is a single newest-first
 * stream across the whole environment, so the 77 per-service round trips that
 * made a sweep take ~7 minutes collapse to ~6 pages and ~16 seconds. That is
 * what makes running the reconciler often affordable.
 *
 * Returns `unresolved` for histories the stream did not prove complete; the
 * caller reads those directly. This is an optimisation with a proven fallback,
 * never a new hard dependency — a project id we cannot determine, or a query
 * that fails, degrades to the per-service path rather than to a wrong answer.
 */
export async function readFleetDeployments({
  projectId,
  environmentId,
  serviceIds,
  notBefore,
  pageSize = FLEET_PAGE_SIZE,
  maxPages = FLEET_MAX_PAGES,
  api = runRailwayApi,
  accumulatorFactory,
}) {
  const accumulator = accumulatorFactory({ serviceIds, notBefore });
  let after = null;
  let pages = 0;
  let records = 0;
  while (pages < maxPages) {
    const data = api(FLEET_QUERY, {
      input: { projectId, environmentId },
      first: pageSize,
      ...(after ? { after } : {}),
    });
    const connection = data?.deployments;
    if (!connection?.edges) throw new Error('railway api returned no deployments connection');
    pages += 1;
    records += connection.edges.length;
    accumulator.absorb(connection.edges.map((edge) => edge?.node).filter(Boolean));
    if (!connection.pageInfo?.hasNextPage) {
      accumulator.markExhausted();
      break;
    }
    if (accumulator.done) break;
    after = connection.pageInfo.endCursor;
  }
  const result = accumulator.result();
  const complete = accumulator.done;
  return {
    ...result,
    // Reaching the page cap without satisfying the stopping rule proves
    // nothing about ANY service, including one that appeared with a RUNNING
    // record. A later page may still contain its head/refusal record or a
    // newer running record, so the caller must use the proven direct path for
    // every partial history rather than silently accepting an incomplete one.
    unresolved: complete ? result.unresolved : [...serviceIds],
    pages,
    records,
  };
}

/**
 * Deployment history for every service, by whichever route is available.
 *
 * Tries the one-query fleet stream, then fills any gap with direct per-service
 * reads. Both callers use this so neither carries its own fetch strategy — the
 * duplication that had already let them disagree about which record is running.
 *
 * Returns a Map of serviceId -> { deployments, error }. `error` non-null means
 * that service could not be read at all; callers must report it rather than
 * treat it as an empty history.
 */
export async function readDeploymentsForFleet({
  services,
  environment,
  environmentId = null,
  projectId = process.env.RAILWAY_PROJECT_ID,
  window,
  concurrency = DEFAULT_CONCURRENCY,
  notBefore = Number.NEGATIVE_INFINITY,
  accumulatorFactory,
  onRoute = () => {},
}) {
  const byId = new Map(services.map((service) => [service.id, service]));
  const results = new Map();
  let needDirect = services;

  if (projectId && environmentId && accumulatorFactory) {
    try {
      const fleet = await readFleetDeployments({
        projectId,
        environmentId,
        serviceIds: [...byId.keys()],
        notBefore,
        accumulatorFactory,
      });
      if (fleet.unresolved.length === byId.size) {
        // A capped, non-exhausted stream leaves every history partial. Release
        // those records before the direct fallback fan-out; none is safe to
        // classify or worth retaining while the proven path reads them again.
        fleet.byService.clear();
      } else {
        for (const [serviceId, deployments] of fleet.byService) {
          if (fleet.unresolved.includes(serviceId)) continue;
          // Trim to the SAME per-service window the direct read uses. The fleet
          // stream is bounded globally, not per service, so a busy service can
          // arrive with hundreds of records where `readDeployments` would have
          // returned `window`. Leaving them in silently changes what the
          // classifier sees — and every extra SKIPPED record costs a `git show`,
          // which is what actually dominates a sweep's wall clock.
          results.set(serviceId, { deployments: deployments.slice(0, window), error: null });
        }
      }
      needDirect = fleet.unresolved.map((serviceId) => byId.get(serviceId)).filter(Boolean);
      onRoute({ route: 'fleet', pages: fleet.pages, records: fleet.records, fellBack: needDirect.length });
    } catch (error) {
      // The proven path is still there. Degrade to it rather than to a guess.
      onRoute({ route: 'per-service', reason: error instanceof Error ? error.message : String(error) });
      needDirect = services;
      results.clear();
    }
  } else {
    onRoute({ route: 'per-service', reason: 'no project/environment id available' });
  }

  await mapWithConcurrency(needDirect, concurrency, async (service) => {
    try {
      results.set(service.id, { deployments: await readDeployments(service, environment, window), error: null });
    } catch (error) {
      results.set(service.id, {
        deployments: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return results;
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
