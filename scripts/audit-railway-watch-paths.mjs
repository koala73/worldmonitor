#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_WATCH_PATTERNS = Object.freeze(['scripts/**', 'shared/**']);

const REPOSITORY = 'koala73/worldmonitor';
const SEED_COMMAND_RE = /^node\s+(?:\.\/)?(?:scripts\/)?(?:seed-[^\s]+|fetch-gpsjam\.mjs|publish-bootstrap-tiers\.mjs)(?:\s|$)/;
const SEED_DOCKERFILE_RE = /(?:^|\/)Dockerfile\.(?:seed-[^/\s]+|digest-notifications|publish-bootstrap-tiers)$/;

function normalizeRootDirectory(value) {
  return typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : '';
}

function isSeederService(service) {
  return service?.source?.repo === REPOSITORY
    && (
      SEED_COMMAND_RE.test(service?.deploy?.startCommand || '')
      || SEED_DOCKERFILE_RE.test(service?.build?.dockerfilePath || '')
    );
}

export function auditRailwayWatchPaths(config) {
  const services = config?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error('Railway environment config must contain a services object');
  }

  return Object.entries(services)
    .filter(([, service]) => isSeederService(service))
    .flatMap(([serviceId, service]) => {
      const watchPatterns = service?.build?.watchPatterns;
      // Railway omits this field when no filter is configured. Missing and an
      // explicit [] both mean "watch the whole repository".
      if (watchPatterns == null) return [];
      if (!Array.isArray(watchPatterns)) {
        return [{
          serviceId,
          startCommand: service?.deploy?.startCommand || '',
          missingPatterns: [...REQUIRED_WATCH_PATTERNS],
          extraPatterns: [],
        }];
      }

      // An empty list means Railway watches the whole repository, which is
      // broader than this contract and therefore cannot miss a helper change.
      if (watchPatterns.length === 0) return [];

      const missingPatterns = REQUIRED_WATCH_PATTERNS.filter(
        (pattern) => !watchPatterns.includes(pattern),
      );
      const scriptsRoot = normalizeRootDirectory(service?.source?.rootDirectory) === 'scripts';
      const extraPatterns = scriptsRoot
        ? watchPatterns.filter((pattern) => !REQUIRED_WATCH_PATTERNS.includes(pattern))
        : [];
      const canonicalScriptsRoot = scriptsRoot
        && watchPatterns.length === REQUIRED_WATCH_PATTERNS.length
        && missingPatterns.length === 0;
      if (missingPatterns.length === 0 && (!scriptsRoot || canonicalScriptsRoot)) return [];

      return [{
        serviceId,
        startCommand: service?.deploy?.startCommand || service?.build?.dockerfilePath || '',
        missingPatterns,
        extraPatterns,
      }];
    })
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}

export function buildRailwayWatchPathPatch(config) {
  const services = Object.fromEntries(
    auditRailwayWatchPaths(config).map(({ serviceId }) => [
      serviceId,
      {
        build: {
          watchPatterns:
            normalizeRootDirectory(config.services[serviceId]?.source?.rootDirectory) === 'scripts'
              ? [...REQUIRED_WATCH_PATTERNS]
              : [
                ...(Array.isArray(config.services[serviceId]?.build?.watchPatterns)
                  ? config.services[serviceId].build.watchPatterns
                  : []),
                ...REQUIRED_WATCH_PATTERNS.filter(
                  (pattern) => !config.services[serviceId]?.build?.watchPatterns?.includes?.(pattern),
                ),
              ],
        },
      },
    ]),
  );
  return { services };
}

export function buildRailwayEditArgs(config) {
  // Calling audit here keeps this helper honest: an empty patch must not be
  // sent through the mutation path.
  if (auditRailwayWatchPaths(config).length === 0) return [];
  return [
    'environment',
    'edit',
    '--message',
    'ops: enforce broad seeder watch paths (#5288)',
    '--json',
  ];
}

export function serializeRailwayWatchPathPatch(config) {
  // Railway's JSON stdin parser requires a record terminator before it moves
  // on to the apply confirmation. Without the newline it exits 0 with a no-op.
  return `${JSON.stringify(buildRailwayWatchPathPatch(config))}\n`;
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

function readEnvironmentConfig() {
  return JSON.parse(runRailway(['environment', 'config', '--json']));
}

export async function waitForRailwayWatchPathConvergence(
  readConfig,
  {
    attempts = 5,
    delayMs = 1_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let remaining = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    remaining = auditRailwayWatchPaths(readConfig());
    if (remaining.length === 0 || attempt === attempts) return remaining;
    await sleep(delayMs);
  }
  return remaining;
}

function printAudit(drift) {
  if (drift.length === 0) {
    console.log('Railway watch-path audit passed: every scoped seeder watches scripts/** and shared/** (or the whole repository).');
    return;
  }

  console.error(`Railway watch-path audit found ${drift.length} narrow seeder service(s):`);
  for (const entry of drift) {
    const details = [
      entry.missingPatterns.length > 0 ? `missing ${entry.missingPatterns.join(', ')}` : '',
      entry.extraPatterns.length > 0 ? `replace enumerated ${entry.extraPatterns.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    console.error(
      `- ${entry.serviceId} (${entry.startCommand}): ${details}`,
    );
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const config = readEnvironmentConfig();
  const drift = auditRailwayWatchPaths(config);
  printAudit(drift);

  if (drift.length === 0) return;
  if (!apply) {
    process.exitCode = 1;
    return;
  }

  runRailway(buildRailwayEditArgs(config), {
    input: serializeRailwayWatchPathPatch(config),
  });

  const remaining = await waitForRailwayWatchPathConvergence(readEnvironmentConfig);
  if (remaining.length > 0) {
    printAudit(remaining);
    throw new Error('Railway accepted the patch but watch-path drift remains');
  }
  console.log(`Applied and verified broad watch paths for ${drift.length} Railway seeder service(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
