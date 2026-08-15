#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONCURRENCY,
  RAILWAY_CALL_TIMEOUT_MS,
  REPOSITORY,
  isRepositoryService,
  readArgument,
  readEnvironmentConfig,
  readExpectedRepositoryFleet,
  readServices,
  resolveRunDeadlineAt,
  runRailway,
  selectExpectedRepositoryServices,
} from './railway-cli.mjs';
import {
  ROOT_DIRECTORY_BY_DEPLOY_MODE,
  normalizeRootDirectory,
} from './railway-deploy-closure.mjs';
import {
  DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR,
  readViewerDeploymentConfig,
} from './railway-viewer-deployment-config.mjs';

// Re-exported so the existing importers of this module keep working; the
// definitions live in the shared files above so the audit, the drift check and
// the trigger cannot drift into three ideas of the same thing.
export {
  RAILWAY_CALL_TIMEOUT_MS,
  REPOSITORY,
  ROOT_DIRECTORY_BY_DEPLOY_MODE,
  isRepositoryService,
  normalizeRootDirectory,
  readArgument,
  runRailway,
};

const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);
const DEFAULT_ENVIRONMENT = 'production';
export const DEPLOYMENT_CONFIG_RUN_BUDGET_MS = 15 * 60 * 1000;

export function resolveDeploymentConfigDeadlineAt({
  jobStartedAtMs,
  epochNow = Date.now(),
  monotonicNow = performance.now(),
}) {
  return resolveRunDeadlineAt({
    budgetMs: DEPLOYMENT_CONFIG_RUN_BUDGET_MS,
    jobStartedAtMs,
    epochNow,
    monotonicNow,
  });
}

export function validateAuditMode({ apply, deploymentOnly }) {
  if (deploymentOnly && apply) {
    throw new Error('deployment-only audit forbids --apply');
  }
}

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

function mergeServiceDrift(entries) {
  const byService = new Map();
  for (const entry of entries) {
    const key = entry.serviceId ?? `name:${entry.service}`;
    const current = byService.get(key);
    if (!current) {
      byService.set(key, { ...entry });
      continue;
    }
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'service' || field === 'serviceId' || value == null) continue;
      if (field === 'missingRequiredEnv') {
        current[field] = sortedUniqueStrings([...(current[field] ?? []), ...value]);
      } else if (typeof value === 'boolean') {
        current[field] = Boolean(current[field]) || value;
      } else {
        current[field] = value;
      }
    }
  }
  return [...byService.values()].sort((left, right) => left.service.localeCompare(right.service));
}

function serviceIdFor(serviceIdsByName, serviceName) {
  if (serviceIdsByName instanceof Map) return serviceIdsByName.get(serviceName);
  return serviceIdsByName?.[serviceName];
}

function normalizeDockerfilePath(value) {
  return typeof value === 'string' ? value.replace(/^\/+/, '') : '';
}

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

// Repository-wide fallback contract for a live seeder the registry does not
// manage with an exact dependency closure. Broad watch paths over-trigger, but
// they cannot MISS a transitive helper change — which is the failure this guard
// exists to prevent (docs/solutions/integration-issues/
// railway-seeder-watch-paths-can-skip-deployments.md).
export const BROAD_WATCH_PATTERNS = Object.freeze(['scripts/**', 'shared/**']);

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

export function auditRailwayServiceConfig(
  config,
  serviceIdsByName,
  registry,
  { evaluateRequiredEnv = true, requireMainTrigger = false } = {},
) {
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

  // Live seeders the registry does not manage. Without this sweep the audit
  // only ever looks at the handful of services that opted in, and a narrow
  // watch filter on any other seeder — the "merged is not ran" failure — passes
  // silently while the summary line still reads "audit passed".
  const unmanagedDrift = Object.entries(services)
    .filter(([serviceId, service]) => !managedServiceIds.has(serviceId)
      && !plannedServiceIds.has(serviceId)
      && isSeederService(service))
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

  const repositorySourceDrift = requireMainTrigger
    ? Object.entries(services).flatMap(([serviceId, service]) => {
        if (service?.source?.repo !== REPOSITORY) return [];
        const sourceBranch = service.source.branch !== 'main'
          ? { actual: service.source.branch ?? null, expected: 'main' }
          : null;
        const checkSuites = service.source.checkSuites !== false
          ? { actual: service.source.checkSuites ?? null, expected: false }
          : null;
        if (!sourceBranch && !checkSuites) return [];
        return [{
          service: nameByServiceId.get(serviceId) ?? serviceId,
          serviceId,
          missingService: false,
          watchPatterns: null,
          cronSchedule: null,
          ...(sourceBranch ? { sourceBranch } : {}),
          ...(checkSuites ? { checkSuites } : {}),
        }];
      })
    : [];

  const managedDrift = managed
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
      const missingRequiredEnv = evaluateRequiredEnv
        ? unsatisfiedRequiredEnv(entry.requiredEnv, service?.variables)
        : [];
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
    .concat(unmanagedDrift, repositorySourceDrift);
  return mergeServiceDrift(managedDrift);
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
    'ops: reconcile registry-managed Railway seeders',
    '--json',
  ];
}

export function serializeRailwayServiceConfigPatch(drift) {
  // Railway's JSON stdin parser requires a record terminator before it moves
  // on to commit the patch. Without the newline it can exit 0 with a no-op.
  return `${JSON.stringify(buildRailwayServiceConfigPatch(drift))}\n`;
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
      await readConfig(),
      serviceIdsByName,
      registry,
    );
    if (remaining.length === 0 || attempt === attempts) return remaining;
    await sleep(delayMs);
  }
  return remaining;
}

export function printAudit(drift) {
  if (drift.length === 0) {
    console.log('Railway operational-config audit passed: live Railway configuration matches repository policy.');
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
    if (entry.dockerfilePath) {
      details.push(
        `dockerfilePath ${JSON.stringify(entry.dockerfilePath.actual)} != ${JSON.stringify(entry.dockerfilePath.expected)}`,
      );
    }
    if (entry.sourceBranch) {
      details.push(
        `source branch ${JSON.stringify(entry.sourceBranch.actual)} != ${JSON.stringify(entry.sourceBranch.expected)}`,
      );
    }
    if (entry.checkSuites) {
      details.push(
        `source checkSuites ${JSON.stringify(entry.checkSuites.actual)} != ${JSON.stringify(entry.checkSuites.expected)}`,
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


async function main() {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');
  const deploymentOnly = process.argv.includes('--deployment-only');
  validateAuditMode({ apply, deploymentOnly });
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const concurrency = Number(readArgument(process.argv, '--concurrency', String(DEFAULT_CONCURRENCY)));
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('--concurrency must be a positive integer');
  }
  const deploymentDeadlineAt = deploymentOnly
    ? resolveDeploymentConfigDeadlineAt({
        jobStartedAtMs: Number(process.env.RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS),
      })
    : Number.POSITIVE_INFINITY;
  if (deploymentOnly && performance.now() >= deploymentDeadlineAt) {
    throw new Error(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR);
  }
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (deploymentOnly && !projectId) {
    throw new Error('RAILWAY_PROJECT_ID is required for the Viewer deployment projection');
  }
  const registry = readRegistry();
  const inventory = readServices(environment, { projectId });
  if (deploymentOnly && performance.now() >= deploymentDeadlineAt) {
    throw new Error(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR);
  }
  const services = deploymentOnly
    ? selectExpectedRepositoryServices(inventory, readExpectedRepositoryFleet())
    : inventory;
  const serviceIdsByName = new Map(services.map((service) => [service.name, service.id]));
  const readConfig = deploymentOnly
    ? () => readViewerDeploymentConfig(environment, services, {
        projectId,
        concurrency,
        deadlineAt: deploymentDeadlineAt,
      })
    : () => readEnvironmentConfig(environment);
  const drift = auditRailwayServiceConfig(
    await readConfig(),
    serviceIdsByName,
    registry,
    {
      evaluateRequiredEnv: !deploymentOnly,
      requireMainTrigger: deploymentOnly,
    },
  );
  // Always name the target. --apply mutates live infrastructure and the
  // environment is resolved from argv, so it must never be implicit.
  console.log(`Railway operational-config audit: environment=${environment} mode=${deploymentOnly ? 'deployment-only' : apply ? 'apply' : 'audit'}`);
  if (deploymentOnly) {
    console.log('Required environment variables were not evaluated: the Viewer projection cannot request their values.');
  }
  if (asJson) {
    console.log(JSON.stringify({
      environment,
      apply,
      deploymentOnly,
      requiredEnvironmentEvaluated: !deploymentOnly,
      drift,
    }, null, 2));
  }
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
