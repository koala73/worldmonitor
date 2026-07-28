import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditRailwayServiceConfig,
  buildRailwayEditArgs,
  buildRailwayServiceConfigPatch,
  serializeRailwayServiceConfigPatch,
  waitForRailwayServiceConfigConvergence,
} from '../scripts/audit-railway-watch-paths.mjs';
import {
  extractBundleMembers,
  stripComments,
  walkContainerGraph,
} from './_lib/import-graph-walk.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function service({
  cronSchedule = '0 * * * *',
  variables = {},
  watchPatterns = [],
} = {}) {
  return {
    source: { repo: 'koala73/worldmonitor', rootDirectory: 'scripts' },
    build: { watchPatterns },
    deploy: { cronSchedule, startCommand: 'node seed-example.mjs' },
    variables,
  };
}

function extractSharedConfigDependencies(files, deployMode) {
  const prefix = deployMode === 'nixpacks-root-scripts'
    ? 'scripts/shared'
    : 'shared';
  const dependencies = new Set();
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/\bloadSharedConfig\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      dependencies.add(`${prefix}/${match[1]}`);
    }
  }
  return dependencies;
}

const managedRegistry = [
  {
    entry: 'scripts/seed-example.mjs',
    service: 'seed-example',
    watchPatterns: [
      'scripts/seed-example.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
      'scripts/package-lock.json',
      'scripts/nixpacks.toml',
    ],
    cronSchedule: '*/15 * * * *',
  },
];
const serviceIds = new Map([['seed-example', 'svc-example']]);

describe('Railway operational-config audit', () => {
  it('audits always-on services without reconciling their cron', () => {
    const registry = [{
      service: 'publisher',
      watchPatterns: ['scripts/publish.mjs'],
      cronSchedule: null,
    }];
    assert.deepEqual(
      auditRailwayServiceConfig(
        {
          services: {
            'svc-publisher': service({
              cronSchedule: '*/5 * * * *',
              watchPatterns: ['scripts/**'],
            }),
          },
        },
        new Map([['publisher', 'svc-publisher']]),
        registry,
      ),
      [{
        service: 'publisher',
        serviceId: 'svc-publisher',
        missingService: false,
        watchPatterns: {
          actual: ['scripts/**'],
          expected: ['scripts/publish.mjs'],
        },
        cronSchedule: null,
      }],
    );
  });

  it('flags broad or missing watch paths and cron drift against the registry', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: ['scripts/**', 'shared/**'],
          cronSchedule: '0 * * * *',
        }),
      },
    };

    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, managedRegistry), [
      {
        service: 'seed-example',
        serviceId: 'svc-example',
        missingService: false,
        watchPatterns: {
          actual: ['scripts/**', 'shared/**'],
          expected: managedRegistry[0].watchPatterns,
        },
        cronSchedule: {
          actual: '0 * * * *',
          expected: '*/15 * * * *',
        },
      },
    ]);
  });

  it('builds a minimal patch containing only drifted fields', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: '0 * * * *',
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, managedRegistry);

    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: {
        'svc-example': {
          deploy: { cronSchedule: '*/15 * * * *' },
        },
      },
    });
    assert.deepEqual(buildRailwayEditArgs(drift), [
      'environment',
      'edit',
      '--environment',
      'production',
      '--message',
      'ops: reconcile registry-managed Railway seeders',
      '--json',
    ]);
    assert.ok(serializeRailwayServiceConfigPatch(drift).endsWith('\n'));
    assert.deepEqual(
      JSON.parse(serializeRailwayServiceConfigPatch(drift)),
      buildRailwayServiceConfigPatch(drift),
    );
  });

  it('refuses to apply when a registry-managed production service is absent', () => {
    const drift = auditRailwayServiceConfig(
      { services: {} },
      new Map(),
      managedRegistry,
    );

    assert.equal(drift[0].missingService, true);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example.*not present in Railway production/,
    );
  });

  it('refuses to mutate config while required source routing is absent', () => {
    const registry = [{
      ...managedRegistry[0],
      requiredEnv: ['SOURCE_PROXY_URL'],
    }];
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: ['scripts/**'],
          cronSchedule: '0 * * * *',
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, registry);

    assert.deepEqual(drift[0].missingRequiredEnv, ['SOURCE_PROXY_URL']);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example missing required environment: SOURCE_PROXY_URL/,
    );

    const emptyConfig = {
      services: {
        'svc-example': service({
          variables: { SOURCE_PROXY_URL: { value: '   ' } },
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
      },
    };
    assert.deepEqual(
      auditRailwayServiceConfig(emptyConfig, serviceIds, registry)[0].missingRequiredEnv,
      ['SOURCE_PROXY_URL'],
    );

    const configured = {
      services: {
        'svc-example': service({
          variables: { SOURCE_PROXY_URL: { value: '${{shared.PROXY_URL}}' } },
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(configured, serviceIds, registry), []);
  });

  it('allows Railway config read-back to converge after a patch', async () => {
    const broad = {
      services: {
        'svc-example': service({
          watchPatterns: ['scripts/**', 'shared/**'],
          cronSchedule: '0 * * * *',
        }),
      },
    };
    const converged = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: '*/15 * * * *',
        }),
      },
    };
    const snapshots = [broad, broad, converged];
    let reads = 0;
    let sleeps = 0;

    const remaining = await waitForRailwayServiceConfigConvergence(
      () => snapshots[Math.min(reads++, snapshots.length - 1)],
      serviceIds,
      managedRegistry,
      { attempts: 3, delayMs: 0, sleep: async () => { sleeps += 1; } },
    );

    assert.deepEqual(remaining, []);
    assert.equal(reads, 3);
    assert.equal(sleeps, 2);
  });
});

describe('critical ingestion Railway registry contract', () => {
  const registry = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
  );
  const expected = new Map([
    ['seed-conflict-intel', '*/15 * * * *'],
    ['seed-gdelt-intel', '0 */4 * * *'],
    ['seed-supply-chain-trade', '0 */6 * * *'],
    ['seed-comtrade-bilateral-hs4', '0 6 1 * *'],
    ['seed-bundle-market-backup', '*/5 * * * *'],
    ['seed-bundle-derived-signals', '*/5 * * * *'],
    ['seed-bundle-portwatch', '0 */1 * * *'],
    ['seed-bundle-portwatch-port-activity', '0 */12 * * *'],
  ]);

  for (const [serviceName, cronSchedule] of expected) {
    it(`${serviceName} pins its cron and complete runtime dependency closure`, () => {
      const entry = registry.find((candidate) => candidate.service === serviceName);
      assert.ok(entry, `${serviceName} must be present in railway-services.json`);
      assert.equal(entry.cronSchedule, cronSchedule);
      assert.ok(Array.isArray(entry.watchPatterns), `${serviceName} must declare watchPatterns`);
      assert.ok(entry.watchPatterns.length > 0, `${serviceName} watchPatterns must not be empty`);
      assert.equal(
        new Set(entry.watchPatterns).size,
        entry.watchPatterns.length,
        `${serviceName} watchPatterns must not contain duplicates`,
      );
      assert.ok(!entry.watchPatterns.includes('scripts/**'), `${serviceName} must not watch every seeder`);
      assert.ok(!entry.watchPatterns.includes('shared/**'), `${serviceName} must not watch all shared data`);
      for (const watchedPath of entry.watchPatterns) {
        assert.ok(!watchedPath.includes('*'), `${serviceName} must use exact watch paths`);
        assert.ok(
          existsSync(resolve(repoRoot, watchedPath)),
          `${serviceName} watchPatterns references missing ${watchedPath}`,
        );
      }

      const entryPath = resolve(repoRoot, entry.entry);
      const source = readFileSync(entryPath, 'utf8');
      const roots = [
        entryPath,
        ...extractBundleMembers(source).map((member) => resolve(repoRoot, 'scripts', member)),
      ];
      const scriptsDir = resolve(repoRoot, 'scripts');
      const { visited, unresolved } = walkContainerGraph(roots, {
        repoRoot,
        copyRootDirs: [scriptsDir, repoRoot],
        dynamicRootDirs: [scriptsDir],
        installedPackages: new Set(),
        hasTsx: false,
      });
      assert.deepEqual(unresolved, [], `${serviceName} runtime graph must resolve`);

      const watched = new Set(entry.watchPatterns);
      const runtimeFiles = new Set([
        ...[...visited].map((file) => relative(repoRoot, file)),
        ...extractSharedConfigDependencies(visited, entry.deployMode),
      ]);
      const missingRuntimeFiles = [...runtimeFiles]
        .filter((file) => !watched.has(file))
        .sort();
      assert.deepEqual(
        missingRuntimeFiles,
        [],
        `${serviceName} watchPatterns omit runtime dependencies`,
      );

      if (entry.deployMode === 'nixpacks-root-scripts') {
        for (const buildFile of [
          'scripts/package.json',
          'scripts/package-lock.json',
          'scripts/nixpacks.toml',
        ]) {
          assert.ok(watched.has(buildFile), `${serviceName} must watch ${buildFile}`);
        }
      }
      if (entry.dockerfile) {
        assert.ok(watched.has(entry.dockerfile), `${serviceName} must watch its Dockerfile`);
      }
    });
  }
});
