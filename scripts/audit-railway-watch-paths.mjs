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

function sortedUniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string'))].sort();
}

function sameStringSet(left, right) {
  return JSON.stringify(sortedUniqueStrings(left)) === JSON.stringify(sortedUniqueStrings(right));
}

function serviceIdFor(serviceIdsByName, serviceName) {
  if (serviceIdsByName instanceof Map) return serviceIdsByName.get(serviceName);
  return serviceIdsByName?.[serviceName];
}

function normalizeRootDirectory(value) {
  return typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : '';
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
  if (hasOwn(entry, 'deployMode') && !hasOwn(ROOT_DIRECTORY_BY_DEPLOY_MODE, entry.deployMode)) {
    throw new Error(
      `${name} declares unknown deployMode ${JSON.stringify(entry.deployMode)}; expected one of ${Object.keys(ROOT_DIRECTORY_BY_DEPLOY_MODE).join(', ')}`,
    );
  }
  if (hasOwn(entry, 'watchPatterns')) {
    if (!Array.isArray(entry.watchPatterns)
      || entry.watchPatterns.some((pattern) => typeof pattern !== 'string')) {
      throw new Error(`${name} watchPatterns must be an array of strings`);
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
  return registry.filter(
    (entry) => hasOwn(entry, 'watchPatterns')
      || (hasOwn(entry, 'cronSchedule') && entry.cronSchedule !== null),
  );
}

// Repository-wide fallback contract for a live seeder the registry does not
// manage with an exact dependency closure. Broad watch paths over-trigger, but
// they cannot MISS a transitive helper change — which is the failure this guard
// exists to prevent (docs/solutions/integration-issues/
// railway-seeder-watch-paths-can-skip-deployments.md).
export const BROAD_WATCH_PATTERNS = Object.freeze(['scripts/**', 'shared/**']);

const REPOSITORY = 'koala73/worldmonitor';
const SEED_COMMAND_RE = /^node\s+(?:\.\/)?(?:scripts\/)?(?:seed-[^\s]+|fetch-gpsjam\.mjs|publish-bootstrap-tiers\.mjs)(?:\s|$)/;
const SEED_DOCKERFILE_RE = /(?:^|\/)Dockerfile\.(?:seed-[^/\s]+|digest-notifications|publish-bootstrap-tiers)$/;

function isSeederService(service) {
  return service?.source?.repo === REPOSITORY
    && (
      SEED_COMMAND_RE.test(service?.deploy?.startCommand || '')
      || SEED_DOCKERFILE_RE.test(service?.build?.dockerfilePath || '')
    );
}

/**
 * Watch-path contract for a live seeder with no registry-managed closure.
 *
 * Returns null when the service is acceptable, or the {actual, expected} shape
 * the patch builder consumes. Missing and `[]` both mean "watch the whole
 * repository", which is broader than this contract and therefore safe.
 */
export function unmanagedWatchPatternDrift(service) {
  const watchPatterns = service?.build?.watchPatterns;
  if (watchPatterns == null) return null;
  if (!Array.isArray(watchPatterns)) {
    return { actual: [], expected: [...BROAD_WATCH_PATTERNS] };
  }
  if (watchPatterns.length === 0) return null;

  const scriptsRoot = normalizeRootDirectory(service?.source?.rootDirectory) === 'scripts';
  // A scripts-rooted seeder gets exactly the two broad patterns: anything it
  // enumerates beyond them is already covered, and leaving the enumeration in
  // place is how the next helper goes missing. Repo-root and Dockerfile
  // services keep their extras — those can legitimately point outside
  // scripts/ and shared/ (a Dockerfile, a server helper).
  const expected = scriptsRoot
    ? [...BROAD_WATCH_PATTERNS]
    : [
      ...watchPatterns,
      ...BROAD_WATCH_PATTERNS.filter((pattern) => !watchPatterns.includes(pattern)),
    ];
  if (sameStringSet(watchPatterns, expected)) return null;
  return { actual: watchPatterns, expected };
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
  const nameByServiceId = new Map(
    (serviceIdsByName instanceof Map
      ? [...serviceIdsByName]
      : Object.entries(serviceIdsByName ?? {})
    ).map(([name, id]) => [id, name]),
  );

  // Live seeders the registry does not manage. Without this sweep the audit
  // only ever looks at the handful of services that opted in, and a narrow
  // watch filter on any other seeder — the "merged is not ran" failure — passes
  // silently while the summary line still reads "audit passed".
  const unmanagedDrift = Object.entries(services)
    .filter(([serviceId, service]) => !managedServiceIds.has(serviceId) && isSeederService(service))
    .flatMap(([serviceId, service]) => {
      const watchPatterns = unmanagedWatchPatternDrift(service);
      if (!watchPatterns) return [];
      return [{
        service: nameByServiceId.get(serviceId) ?? serviceId,
        serviceId,
        missingService: false,
        unmanagedSeeder: true,
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
      const missingRequiredEnv = unsatisfiedRequiredEnv(entry.requiredEnv, service?.variables);
      const expectedWatchPatterns = entry.watchPatterns;
      const actualWatchPatterns = service?.build?.watchPatterns ?? [];
      const watchPatterns = hasOwn(entry, 'watchPatterns')
        && !sameStringSet(actualWatchPatterns, expectedWatchPatterns)
        ? {
            actual: Array.isArray(actualWatchPatterns) ? actualWatchPatterns : [],
            expected: expectedWatchPatterns,
          }
        : null;

      const expectedCronSchedule = entry.cronSchedule ?? null;
      const actualCronSchedule = service?.deploy?.cronSchedule ?? null;
      const cronSchedule = hasOwn(entry, 'cronSchedule')
        && entry.cronSchedule !== null
        && actualCronSchedule !== expectedCronSchedule
        ? { actual: actualCronSchedule, expected: expectedCronSchedule }
        : null;

      if (!watchPatterns && !cronSchedule && !rootDirectory
        && !missingWatchPatterns && missingRequiredEnv.length === 0) return [];
      return [{
        service: entry.service,
        serviceId,
        missingService: false,
        watchPatterns,
        cronSchedule,
        ...(rootDirectory ? { rootDirectory } : {}),
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
    if (entry.watchPatterns) {
      patch.build = { watchPatterns: entry.watchPatterns.expected };
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
    'ops: reconcile registry-managed Railway seeders',
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

function printAudit(drift) {
  if (drift.length === 0) {
    console.log('Railway operational-config audit passed: registry-managed cron schedules and watch paths match production, and every other live seeder watches broadly enough not to miss a helper change.');
    return;
  }

  console.error(`Railway operational-config audit found ${drift.length} drifted service(s):`);
  for (const entry of drift) {
    if (entry.missingService) {
      console.error(`- ${entry.service}: service is missing from Railway production`);
      continue;
    }
    const details = [];
    if (entry.unmanagedSeeder) {
      details.push(
        `live seeder is not registry-managed, so it must watch ${BROAD_WATCH_PATTERNS.join(' + ')} (or the whole repository) — add an exact dependency closure to scripts/railway-services.json to narrow it`,
      );
    }
    if (entry.missingWatchPatterns) {
      details.push('pins a cron but declares no watchPatterns');
    }
    if (entry.watchPatterns) {
      // Name the paths, not the counts. With exact per-file lists the common
      // drift is a content difference at equal length, which a count renders as
      // two identical numbers and no way to act on it.
      const { actual, expected } = entry.watchPatterns;
      const missing = expected.filter((pattern) => !actual.includes(pattern));
      const unexpected = actual.filter((pattern) => !expected.includes(pattern));
      const parts = [];
      if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
      if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(', ')}`);
      details.push(`watch paths ${parts.join('; ') || 'differ in order only'}`);
    }
    if (entry.rootDirectory) {
      details.push(
        `rootDirectory ${JSON.stringify(entry.rootDirectory.actual)} != ${JSON.stringify(entry.rootDirectory.expected)}`,
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
