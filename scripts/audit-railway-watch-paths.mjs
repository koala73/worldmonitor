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

export function managedRailwayServices(registry) {
  if (!Array.isArray(registry)) {
    throw new Error('Railway service registry must be an array');
  }
  return registry.filter(
    (entry) => hasOwn(entry, 'watchPatterns')
      || (hasOwn(entry, 'cronSchedule') && entry.cronSchedule !== null),
  );
}

export function auditRailwayServiceConfig(config, serviceIdsByName, registry) {
  const services = config?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error('Railway environment config must contain a services object');
  }

  return managedRailwayServices(registry)
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
      const missingRequiredEnv = Array.isArray(entry.requiredEnv)
        ? entry.requiredEnv.filter(
            (name) => !hasConfiguredVariable(service?.variables, name),
          )
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

      if (!watchPatterns && !cronSchedule && missingRequiredEnv.length === 0) return [];
      return [{
        service: entry.service,
        serviceId,
        missingService: false,
        watchPatterns,
        cronSchedule,
        ...(missingRequiredEnv.length > 0 ? { missingRequiredEnv } : {}),
      }];
    })
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
  const statuses = JSON.parse(runRailway([
    'service',
    'status',
    '--all',
    '--environment',
    environment,
    '--json',
  ]));
  if (!Array.isArray(statuses)) {
    throw new Error('railway service status --all must return an array');
  }
  return new Map(statuses.map((service) => [service.name, service.id]));
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
    console.log('Railway operational-config audit passed: registry-managed cron schedules and watch paths match production.');
    return;
  }

  console.error(`Railway operational-config audit found ${drift.length} drifted service(s):`);
  for (const entry of drift) {
    if (entry.missingService) {
      console.error(`- ${entry.service}: service is missing from Railway production`);
      continue;
    }
    const details = [];
    if (entry.watchPatterns) {
      details.push(
        `watch paths ${entry.watchPatterns.actual.length} actual != ${entry.watchPatterns.expected.length} expected`,
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

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const environment = readArgument('--environment', DEFAULT_ENVIRONMENT);
  const registry = readRegistry();
  const serviceIdsByName = readServiceIds(environment);
  const readConfig = () => readEnvironmentConfig(environment);
  const drift = auditRailwayServiceConfig(
    readConfig(),
    serviceIdsByName,
    registry,
  );
  printAudit(drift);

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
    throw new Error('Railway accepted the patch but operational-config drift remains');
  }
  console.log(`Applied and verified registry-managed config for ${drift.length} Railway service(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
