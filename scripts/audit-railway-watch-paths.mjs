#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);
const DEFAULT_ENVIRONMENT = 'production';

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasConfiguredVariable(variables, name) {
  if (!hasOwn(variables ?? {}, name)) return false;
  const entry = variables[name];
  const value = typeof entry === 'string' ? entry : entry?.value;
  return typeof value === 'string' && value.trim().length > 0;
}

// A nested array is an any-of group: the service needs at least one of those
// variables. Sources that resolve a routing value as `SOURCE_SPECIFIC || SHARED`
// (currently SZSE and Japan MOD) must declare it that way, or this gate is stricter
// than the runtime it guards and reports drift for a service that routes fine.
// Same shape the bundle runner accepts in section.requiredEnv.
export function unsatisfiedRequiredEnv(requiredEnv, variables) {
  if (!Array.isArray(requiredEnv)) return [];
  const unsatisfied = [];
  for (const requirement of requiredEnv) {
    const alternatives = Array.isArray(requirement) ? requirement : [requirement];
    if (!alternatives.some((name) => hasConfiguredVariable(variables, name))) {
      unsatisfied.push(alternatives.join(' or '));
    }
  }
  return unsatisfied;
}

function serviceIdFor(serviceIdsByName, serviceName) {
  if (serviceIdsByName instanceof Map) return serviceIdsByName.get(serviceName);
  return serviceIdsByName?.[serviceName];
}

function normalizeRootDirectory(value) {
  return typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : '';
}

function normalizeDockerfilePath(value) {
  return typeof value === 'string' ? value.replace(/^\/+/, '') : '';
}

// deployMode is the registry's claim about where Railway roots the build. It
// decides which build inputs and which shared-config prefix belong in a
// service's dependency closure, so a registry entry that claims the wrong mode
// produces watch paths that --apply then pushes to production. Auditing it
// keeps the claim honest against the live service.
export const ROOT_DIRECTORY_BY_DEPLOY_MODE = Object.freeze({
  'nixpacks-root-scripts': 'scripts',
  'nixpacks-root-repo': '',
  dockerfile: '',
});

// Every field this audit derives production mutations from is validated here,
// because the registry is hand-edited JSON with no runtime schema. A typo used
// to fail OPEN in two ways: an unknown deployMode made
// ROOT_DIRECTORY_BY_DEPLOY_MODE[...] undefined and skipped the rootDirectory
// check entirely, and a non-array watchPatterns collapsed to [] in
// sortedUniqueStrings and compared clean against a whole-repo filter — while the
// closure contract test skipped the same entry for `Array.isArray`. Both shapes
// reported "audit passed".
function assertRegistryEntry(entry) {
  const name = entry?.service ?? JSON.stringify(entry);
  if (hasOwn(entry, 'lifecycle') && !['active', 'planned'].includes(entry.lifecycle)) {
    throw new Error(
      `${name} declares unknown lifecycle ${JSON.stringify(entry.lifecycle)}; expected active or planned`,
    );
  }
  if (hasOwn(entry, 'deployMode') && !hasOwn(ROOT_DIRECTORY_BY_DEPLOY_MODE, entry.deployMode)) {
    throw new Error(
      `${name} declares unknown deployMode ${JSON.stringify(entry.deployMode)}; expected one of ${Object.keys(ROOT_DIRECTORY_BY_DEPLOY_MODE).join(', ')}`,
    );
  }
  if (hasOwn(entry, 'dockerfile')
    && (typeof entry.dockerfile !== 'string' || normalizeDockerfilePath(entry.dockerfile).length === 0)) {
    throw new Error(`${name} dockerfile must be a non-empty string`);
  }
  if (entry.deployMode === 'dockerfile' && !hasOwn(entry, 'dockerfile')) {
    throw new Error(`${name} deployMode dockerfile requires a dockerfile path`);
  }
  if (hasOwn(entry, 'watchPatterns')) {
    if (!Array.isArray(entry.watchPatterns)
      || entry.watchPatterns.some((pattern) => typeof pattern !== 'string')) {
      throw new Error(`${name} watchPatterns must be an array of strings`);
    }
    // A filter is unrepresentable rather than discouraged. Railway rejects
    // pushes that plainly match the glob: measured 2026-08-04 against every
    // repo-backed production service, 62 of 62 with a filter were running code
    // older than a push Railway had refused, while 13 of 15 without one were at
    // origin/main HEAD. The rejection is recorded only as a SKIPPED deployment
    // nobody reads, so a narrower closure does not make the filter safer — it
    // just changes which merges vanish (#6141).
    if (entry.watchPatterns.length > 0) {
      throw new Error(
        `${name} declares a watch-path filter (${entry.watchPatterns.join(', ')}); Railway silently skips pushes that match it, so the only supported value is []`,
      );
    }
  }
  if (hasOwn(entry, 'cronSchedule')
    && entry.cronSchedule !== null
    && typeof entry.cronSchedule !== 'string') {
    throw new Error(`${name} cronSchedule must be a string or null`);
  }
  if (hasOwn(entry, 'requiredEnv')) {
    if (!Array.isArray(entry.requiredEnv)) {
      throw new Error(`${name} requiredEnv must be an array`);
    }
    for (const requirement of entry.requiredEnv) {
      const alternatives = Array.isArray(requirement) ? requirement : [requirement];
      if (alternatives.length === 0) {
        throw new Error(`${name} requiredEnv contains an empty any-of group`);
      }
      for (const variable of alternatives) {
        if (typeof variable !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(variable)) {
          throw new Error(`${name} has invalid requiredEnv name ${JSON.stringify(variable)}`);
        }
      }
    }
  }
  return entry;
}

export function managedRailwayServices(registry) {
  if (!Array.isArray(registry)) {
    throw new Error('Railway service registry must be an array');
  }
  registry.forEach(assertRegistryEntry);
  // Planned entries remain in the registry so Dockerfile/source coverage and
  // field validation run before provisioning. They must not participate in a
  // live audit or --apply until an explicit lifecycle activation; otherwise a
  // scheduled audit fails on the intentionally absent service and an apply can
  // install its cron before its deployment gates have passed.
  return registry.filter(
    (entry) => entry.lifecycle !== 'planned'
      && (
        hasOwn(entry, 'watchPatterns')
        || (hasOwn(entry, 'cronSchedule') && entry.cronSchedule !== null)
      ),
  );
}

export const REPOSITORY = 'koala73/worldmonitor';

// The only supported filter, for every service in this repository. See the
// measurement in assertRegistryEntry: a watch-path filter does not select which
// pushes to skip, it randomly drops between a fifth and all of them.
export const UNFILTERED_WATCH_PATTERNS = Object.freeze([]);

// Deliberately keyed on the source repository rather than on "does this look
// like a seeder". The previous predicate matched a `node seed-*` start command
// or a `Dockerfile.seed-*` build, which excluded the relays, the workers, the
// consumer-prices trio and the collector — all of which deploy this repository
// on every merge and all of which carried a filter.
export function isRepositoryService(service) {
  return service?.source?.repo === REPOSITORY;
}

/**
 * Watch-path contract for any service deployed from this repository.
 *
 * Returns null when the service is acceptable, or the {actual, expected} shape
 * the patch builder consumes. Missing and `[]` both mean "build every push",
 * which is the contract.
 */
export function watchPatternDrift(service) {
  const watchPatterns = service?.build?.watchPatterns;
  if (watchPatterns == null) return null;
  if (!Array.isArray(watchPatterns)) {
    // Railway answered with a shape we cannot read. Treat it as a filter rather
    // than as "no filter": the whole point of this guard is that an unreadable
    // trigger config must not audit clean.
    return { actual: [], expected: [...UNFILTERED_WATCH_PATTERNS] };
  }
  if (watchPatterns.length === 0) return null;
  return { actual: watchPatterns, expected: [...UNFILTERED_WATCH_PATTERNS] };
}

export function auditRailwayServiceConfig(config, serviceIdsByName, registry) {
  const services = config?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error('Railway environment config must contain a services object');
  }

  const managed = managedRailwayServices(registry);
  const managedServiceIds = new Set(
    managed.map((entry) => serviceIdFor(serviceIdsByName, entry.service)).filter(Boolean),
  );
  const plannedServiceIds = new Set(
    registry
      .filter((entry) => entry.lifecycle === 'planned')
      .map((entry) => serviceIdFor(serviceIdsByName, entry.service))
      .filter(Boolean),
  );
  const nameByServiceId = new Map(
    (serviceIdsByName instanceof Map
      ? [...serviceIdsByName]
      : Object.entries(serviceIdsByName ?? {})
    ).map(([name, id]) => [id, name]),
  );

  // Every live service deployed from this repository, whether or not the
  // registry manages it. Without this sweep the audit only ever looks at the
  // handful of services that opted in, and a filter on any of the other ~65 —
  // the "merged is not ran" failure — passes silently while the summary line
  // still reads "audit passed".
  const unmanagedDrift = Object.entries(services)
    .filter(([serviceId, service]) => !managedServiceIds.has(serviceId)
      && !plannedServiceIds.has(serviceId)
      && isRepositoryService(service))
    .flatMap(([serviceId, service]) => {
      const watchPatterns = watchPatternDrift(service);
      if (!watchPatterns) return [];
      return [{
        service: nameByServiceId.get(serviceId) ?? serviceId,
        serviceId,
        missingService: false,
        unregisteredService: true,
        watchPatterns,
        cronSchedule: null,
      }];
    });

  return managed
    .flatMap((entry) => {
      const serviceId = serviceIdFor(serviceIdsByName, entry.service);
      if (!serviceId || !services[serviceId]) {
        return [{
          service: entry.service,
          serviceId: serviceId ?? null,
          missingService: true,
          watchPatterns: null,
          cronSchedule: null,
        }];
      }

      const service = services[serviceId];
      // A managed entry that pins a cron but omits watchPatterns is only half a
      // contract: cron drift is reconciled while the deployment trigger this
      // registry exists to control is never checked. Surface it rather than
      // letting it pass clean.
      const missingWatchPatterns = !hasOwn(entry, 'watchPatterns');
      // assertRegistryEntry has already rejected an unknown deployMode, so an
      // absent expectation here means the entry genuinely declares none.
      const expectedRootDirectory = hasOwn(entry, 'deployMode')
        ? ROOT_DIRECTORY_BY_DEPLOY_MODE[entry.deployMode]
        : undefined;
      const actualRootDirectory = normalizeRootDirectory(service?.source?.rootDirectory);
      const rootDirectory = expectedRootDirectory !== undefined
        && actualRootDirectory !== expectedRootDirectory
        ? { actual: actualRootDirectory, expected: expectedRootDirectory }
        : null;
      const expectedDockerfilePath = hasOwn(entry, 'dockerfile')
        ? normalizeDockerfilePath(entry.dockerfile)
        : undefined;
      const actualDockerfilePath = normalizeDockerfilePath(service?.build?.dockerfilePath);
      const dockerfilePath = expectedDockerfilePath !== undefined
        && actualDockerfilePath !== expectedDockerfilePath
        ? { actual: actualDockerfilePath, expected: expectedDockerfilePath }
        : null;
      const missingRequiredEnv = unsatisfiedRequiredEnv(entry.requiredEnv, service?.variables);
      // Registered and unregistered services share one contract, so they share
      // one predicate. A registry entry cannot declare anything but [] (see
      // assertRegistryEntry), so re-deriving the expectation from the entry only
      // creates a second definition of "clean" that can drift from the first.
      const watchPatterns = hasOwn(entry, 'watchPatterns')
        ? watchPatternDrift(service)
        : null;

      const expectedCronSchedule = entry.cronSchedule ?? null;
      const actualCronSchedule = service?.deploy?.cronSchedule ?? null;
      const cronSchedule = hasOwn(entry, 'cronSchedule')
        && entry.cronSchedule !== null
        && actualCronSchedule !== expectedCronSchedule
        ? { actual: actualCronSchedule, expected: expectedCronSchedule }
        : null;

      if (!watchPatterns && !cronSchedule && !rootDirectory && !dockerfilePath
        && !missingWatchPatterns && missingRequiredEnv.length === 0) return [];
      return [{
        service: entry.service,
        serviceId,
        missingService: false,
        watchPatterns,
        cronSchedule,
        ...(rootDirectory ? { rootDirectory } : {}),
        ...(dockerfilePath ? { dockerfilePath } : {}),
        ...(missingWatchPatterns ? { missingWatchPatterns } : {}),
        ...(missingRequiredEnv.length > 0 ? { missingRequiredEnv } : {}),
      }];
    })
    .concat(unmanagedDrift)
    .sort((left, right) => left.service.localeCompare(right.service));
}

export function buildRailwayServiceConfigPatch(drift) {
  const missing = drift.filter((entry) => entry.missingService);
  if (missing.length > 0) {
    throw new Error(
      `${missing.map((entry) => entry.service).join(', ')} not present in Railway production; refusing a partial config apply`,
    );
  }
  const missingEnv = drift.filter((entry) => entry.missingRequiredEnv?.length > 0);
  if (missingEnv.length > 0) {
    throw new Error(
      missingEnv
        .map((entry) => `${entry.service} missing required environment: ${entry.missingRequiredEnv.join(', ')}`)
        .join('; '),
    );
  }
  // Both of these mean the registry's own claims are untrustworthy for this
  // service, so the watch paths derived from them must not be pushed.
  const incomplete = drift.filter((entry) => entry.missingWatchPatterns);
  if (incomplete.length > 0) {
    throw new Error(
      `${incomplete.map((entry) => entry.service).join(', ')} pins a cron without watchPatterns; refusing a partial config apply`,
    );
  }
  const wrongRoot = drift.filter((entry) => entry.rootDirectory);
  if (wrongRoot.length > 0) {
    throw new Error(
      wrongRoot
        .map((entry) => `${entry.service} rootDirectory is ${JSON.stringify(entry.rootDirectory.actual)} but deployMode implies ${JSON.stringify(entry.rootDirectory.expected)}`)
        .join('; '),
    );
  }

  const services = {};
  for (const entry of drift) {
    const patch = {};
    if (entry.watchPatterns || entry.dockerfilePath) {
      patch.build = {};
      if (entry.watchPatterns) {
        patch.build.watchPatterns = entry.watchPatterns.expected;
      }
      if (entry.dockerfilePath) {
        patch.build.dockerfilePath = entry.dockerfilePath.expected;
      }
    }
    if (entry.cronSchedule) {
      patch.deploy = { cronSchedule: entry.cronSchedule.expected };
    }
    if (Object.keys(patch).length > 0) services[entry.serviceId] = patch;
  }
  return { services };
}

export function buildRailwayEditArgs(
  drift,
  environment = DEFAULT_ENVIRONMENT,
) {
  if (drift.length === 0) return [];
  buildRailwayServiceConfigPatch(drift);
  return [
    'environment',
    'edit',
    '--environment',
    environment,
    '--message',
    'ops: clear watch-path filters and reconcile registry-managed config',
    '--json',
  ];
}

export function serializeRailwayServiceConfigPatch(drift) {
  // Railway's JSON stdin parser requires a record terminator before it moves
  // on to commit the patch. Without the newline it can exit 0 with a no-op.
  return `${JSON.stringify(buildRailwayServiceConfigPatch(drift))}\n`;
}

function runRailway(args, options = {}) {
  const result = spawnSync('railway', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `railway ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function readEnvironmentConfig(environment) {
  return JSON.parse(runRailway([
    'environment',
    'config',
    '--environment',
    environment,
    '--json',
  ]));
}

function readServiceIds(environment) {
  const services = JSON.parse(runRailway([
    'service',
    'list',
    '--environment',
    environment,
    '--json',
  ]));
  if (!Array.isArray(services)) {
    throw new Error('railway service list must return an array');
  }
  return new Map(services.map((service) => [service.name, service.id]));
}

function readRegistry() {
  return JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
}

export async function waitForRailwayServiceConfigConvergence(
  readConfig,
  serviceIdsByName,
  registry,
  {
    attempts = 5,
    delayMs = 1_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let remaining = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    remaining = auditRailwayServiceConfig(
      readConfig(),
      serviceIdsByName,
      registry,
    );
    if (remaining.length === 0 || attempt === attempts) return remaining;
    await sleep(delayMs);
  }
  return remaining;
}

const MAX_REPORTED_PATTERNS = 6;

function printAudit(drift) {
  if (drift.length === 0) {
    console.log('Railway operational-config audit passed: registry-managed Dockerfile paths and cron schedules match production, and no service deployed from this repository carries a watch-path filter that could skip a merge.');
    return;
  }

  console.error(`Railway operational-config audit found ${drift.length} drifted service(s):`);
  for (const entry of drift) {
    if (entry.missingService) {
      console.error(`- ${entry.service}: service is missing from Railway production`);
      continue;
    }
    const details = [];
    if (entry.unregisteredService) {
      details.push('live service deploys this repository but is not in scripts/railway-services.json');
    }
    if (entry.missingWatchPatterns) {
      details.push('pins a cron but does not declare watchPatterns: []');
    }
    if (entry.watchPatterns) {
      // Name the patterns — they are what an operator deletes in the dashboard
      // when the apply path is unavailable — but cap the list. One service
      // carried 50 of them, and an unreadable audit is one nobody reads.
      const { actual } = entry.watchPatterns;
      const shown = actual.slice(0, MAX_REPORTED_PATTERNS).join(', ');
      const overflow = actual.length - MAX_REPORTED_PATTERNS;
      const named = actual.length === 0
        ? '(unreadable)'
        : overflow > 0 ? `${shown} (+${overflow} more)` : shown;
      details.push(
        `watch-path filter ${named} must be cleared — Railway skips pushes that match it`,
      );
    }
    if (entry.rootDirectory) {
      details.push(
        `rootDirectory ${JSON.stringify(entry.rootDirectory.actual)} != ${JSON.stringify(entry.rootDirectory.expected)}`,
      );
    }
    if (entry.dockerfilePath) {
      details.push(
        `dockerfilePath ${JSON.stringify(entry.dockerfilePath.actual)} != ${JSON.stringify(entry.dockerfilePath.expected)}`,
      );
    }
    if (entry.cronSchedule) {
      details.push(
        `cron ${JSON.stringify(entry.cronSchedule.actual)} != ${JSON.stringify(entry.cronSchedule.expected)}`,
      );
    }
    if (entry.missingRequiredEnv?.length > 0) {
      details.push(`missing required environment ${entry.missingRequiredEnv.join(', ')}`);
    }
    console.error(`- ${entry.service}: ${details.join('; ')}`);
  }
}

// Accepts both `--flag value` and `--flag=value`. The equals form matters: an
// exact indexOf match silently misses it, and this value selects which Railway
// environment --apply mutates, so a missed `--environment=staging` would patch
// production with no error and no signal.
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

async function main() {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const registry = readRegistry();
  const serviceIdsByName = readServiceIds(environment);
  const readConfig = () => readEnvironmentConfig(environment);
  const drift = auditRailwayServiceConfig(
    readConfig(),
    serviceIdsByName,
    registry,
  );
  // Always name the target. --apply mutates live infrastructure and the
  // environment is resolved from argv, so it must never be implicit.
  console.log(`Railway operational-config audit: environment=${environment} mode=${apply ? 'apply' : 'audit'}`);
  if (asJson) console.log(JSON.stringify({ environment, apply, drift }, null, 2));
  else printAudit(drift);

  if (drift.length === 0) return;
  if (!apply) {
    process.exitCode = 1;
    return;
  }

  runRailway(buildRailwayEditArgs(drift, environment), {
    input: serializeRailwayServiceConfigPatch(drift),
  });

  const remaining = await waitForRailwayServiceConfigConvergence(
    readConfig,
    serviceIdsByName,
    registry,
  );
  if (remaining.length > 0) {
    printAudit(remaining);
    throw new Error(`Railway accepted the patch but operational-config drift remains in ${environment}`);
  }
  console.log(`Applied and verified registry-managed config for ${drift.length} Railway service(s) in ${environment}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
