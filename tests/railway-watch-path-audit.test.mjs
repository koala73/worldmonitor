import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditRailwayServiceConfig,
  buildRailwayEditArgs,
  buildRailwayServiceConfigPatch,
  managedRailwayServices,
  readArgument,
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
  dockerfilePath,
  variables = {},
  watchPatterns = [],
} = {}) {
  return {
    source: { repo: 'koala73/worldmonitor', rootDirectory: 'scripts' },
    build: {
      watchPatterns,
      ...(dockerfilePath === undefined ? {} : { dockerfilePath }),
    },
    deploy: { cronSchedule, startCommand: 'node seed-example.mjs' },
    variables,
  };
}

const NIXPACKS_BUILD_FILES = Object.freeze([
  'scripts/package.json',
  'scripts/package-lock.json',
  'scripts/nixpacks.toml',
]);

// walkContainerGraph only follows import/require/dynamic-import edges, so a data
// file pulled in with fs is invisible to it -- and one already is:
// scripts/seed-supply-chain-trade.mjs reads scripts/shared/un-to-iso2.json via
// readFileSync(join(__dirname, ...)). Without this extractor the closure guard
// cannot tell whether such a path is watched, which is exactly the
// silently-skipped-deployment class the registry exists to prevent.
function extractFileReadDependencies(files, repoRootDir) {
  const dependencies = new Set();
  const add = (fromFile, ...segments) => {
    const resolved = resolve(dirname(fromFile), ...segments);
    if (!resolved.startsWith(repoRootDir)) return;
    if (!existsSync(resolved)) return;
    dependencies.add(relative(repoRootDir, resolved));
  };
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    // readFileSync(join(__dirname, 'shared', 'x.json')) -- any local alias of
    // readFileSync/join (the seeders import them as _readFileSync/_join).
    for (const match of source.matchAll(
      /\b_?readFileSync\s*\(\s*_?join\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])\s*\)/gu,
    )) {
      const segments = [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((m) => m[1]);
      if (segments.length > 0) add(file, ...segments);
    }
    // readFileSync(new URL('./x.json', import.meta.url))
    for (const match of source.matchAll(
      /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
    )) {
      add(file, match[1]);
    }
  }
  return dependencies;
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

  it('treats an omitted build.watchPatterns as the empty whole-repo list', () => {
    // Railway omits the field entirely when no filter is configured, so
    // "absent" and "[]" must both satisfy an entry that expects []. This is
    // load-bearing for the always-on bootstrap publisher.
    const registry = [{ service: 'publisher', watchPatterns: [], cronSchedule: null }];
    const ids = new Map([['publisher', 'svc-publisher']]);
    const omitted = service({ cronSchedule: null });
    delete omitted.build.watchPatterns;

    assert.deepEqual(
      auditRailwayServiceConfig({ services: { 'svc-publisher': omitted } }, ids, registry),
      [],
      'omitted watchPatterns must satisfy an expected []',
    );
    assert.deepEqual(
      auditRailwayServiceConfig(
        { services: { 'svc-publisher': service({ cronSchedule: null, watchPatterns: [] }) } },
        ids,
        registry,
      ),
      [],
      'explicit [] must satisfy an expected []',
    );
    const narrowed = auditRailwayServiceConfig(
      { services: { 'svc-publisher': service({ cronSchedule: null, watchPatterns: ['scripts/**'] }) } },
      ids,
      registry,
    );
    assert.deepEqual(narrowed[0].watchPatterns, { actual: ['scripts/**'], expected: [] });
  });

  it('flags a managed entry that pins a cron without declaring watchPatterns', () => {
    const registry = [{ service: 'seed-example', cronSchedule: '*/15 * * * *' }];
    const drift = auditRailwayServiceConfig(
      { services: { 'svc-example': service({ cronSchedule: '*/15 * * * *' }) } },
      serviceIds,
      registry,
    );
    assert.equal(drift[0].missingWatchPatterns, true);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example pins a cron without watchPatterns/,
    );
  });

  it('audits Railway rootDirectory against the deployMode the registry claims', () => {
    const registry = [{
      ...managedRegistry[0],
      deployMode: 'nixpacks-root-repo', // implies rootDirectory ''
    }];
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, registry);
    assert.deepEqual(drift[0].rootDirectory, { actual: 'scripts', expected: '' });
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example rootDirectory is "scripts" but deployMode implies ""/,
    );

    const matching = [{ ...managedRegistry[0], deployMode: 'nixpacks-root-scripts' }];
    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, matching), []);
  });

  it('audits and patches a managed Dockerfile path with slash normalization', () => {
    const registry = [{
      ...managedRegistry[0],
      deployMode: 'dockerfile',
      dockerfile: 'Dockerfile.example',
      watchPatterns: [],
      cronSchedule: null,
    }];
    const ids = new Map([['seed-example', 'svc-example']]);
    const live = service({
      cronSchedule: null,
      dockerfilePath: 'Dockerfile.wrong',
      watchPatterns: [],
    });
    live.source.rootDirectory = '';

    const drift = auditRailwayServiceConfig(
      { services: { 'svc-example': live } },
      ids,
      registry,
    );
    assert.deepEqual(drift[0].dockerfilePath, {
      actual: 'Dockerfile.wrong',
      expected: 'Dockerfile.example',
    });
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: {
        'svc-example': {
          build: { dockerfilePath: 'Dockerfile.example' },
        },
      },
    });

    const normalized = service({
      cronSchedule: null,
      dockerfilePath: '/Dockerfile.example',
      watchPatterns: [],
    });
    normalized.source.rootDirectory = '';
    assert.deepEqual(
      auditRailwayServiceConfig({ services: { 'svc-example': normalized } }, ids, registry),
      [],
    );

    const missing = service({ cronSchedule: null, watchPatterns: [] });
    missing.source.rootDirectory = '';
    const missingDrift = auditRailwayServiceConfig(
      { services: { 'svc-example': missing } },
      ids,
      registry,
    );
    assert.deepEqual(missingDrift[0].dockerfilePath, {
      actual: '',
      expected: 'Dockerfile.example',
    });
  });
});

// The registry is hand-edited JSON with no runtime schema, and every field the
// audit reads decides what --apply pushes to production. Each shape below used
// to fail OPEN: the audit returned [] and printed "audit passed".
describe('registry shape validation', () => {
  const liveConfig = {
    services: { 'svc-example': service({ watchPatterns: managedRegistry[0].watchPatterns }) },
  };

  it('rejects an unknown deployMode instead of skipping the rootDirectory audit', () => {
    const typo = [{ ...managedRegistry[0], deployMode: 'nixpacks-root-scrpits' }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, typo),
      /unknown deployMode "nixpacks-root-scrpits"/,
    );
  });

  it('rejects an unknown lifecycle instead of silently auditing it', () => {
    const typo = [{ ...managedRegistry[0], lifecycle: 'planed' }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, typo),
      /unknown lifecycle "planed"; expected active or planned/,
    );
  });

  it('rejects a non-array watchPatterns instead of comparing it clean', () => {
    // sortedUniqueStrings() collapses a non-array to [], which compares equal to
    // a whole-repo filter — and the closure contract test skips the same entry
    // on `Array.isArray`, so this shape escaped BOTH gates.
    const asString = [{ ...managedRegistry[0], watchPatterns: 'scripts/seed-example.mjs' }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, asString),
      /watchPatterns must be an array of strings/,
    );
    const withNonString = [{ ...managedRegistry[0], watchPatterns: ['scripts/a.mjs', 42] }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, withNonString),
      /watchPatterns must be an array of strings/,
    );
  });

  it('rejects a malformed cronSchedule or requiredEnv declaration', () => {
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, [{ ...managedRegistry[0], cronSchedule: 15 }]),
      /cronSchedule must be a string or null/,
    );
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, [{ ...managedRegistry[0], requiredEnv: [[]] }]),
      /empty any-of group/,
    );
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, [{ ...managedRegistry[0], requiredEnv: ['lower_case'] }]),
      /invalid requiredEnv name/,
    );
  });

  it('rejects malformed Dockerfile declarations', () => {
    assert.throws(
      () => auditRailwayServiceConfig(
        liveConfig,
        serviceIds,
        [{ ...managedRegistry[0], deployMode: 'dockerfile' }],
      ),
      /deployMode dockerfile requires a dockerfile path/,
    );
    assert.throws(
      () => auditRailwayServiceConfig(
        liveConfig,
        serviceIds,
        [{ ...managedRegistry[0], dockerfile: 42 }],
      ),
      /dockerfile must be a non-empty string/,
    );
  });
});

describe('planned Railway service lifecycle', () => {
  const planned = {
    service: 'umami-retention',
    deployMode: 'dockerfile',
    dockerfile: 'Dockerfile.umami-retention',
    lifecycle: 'planned',
    requiredEnv: ['PGHOST'],
    watchPatterns: ['scripts/umami-retention.sql', 'Dockerfile.umami-retention'],
    cronSchedule: '7,22,37,52 * * * *',
  };

  it('does not report an intentionally absent planned service', () => {
    assert.deepEqual(
      auditRailwayServiceConfig({ services: {} }, new Map(), [planned]),
      [],
    );
    assert.deepEqual(managedRailwayServices([planned]), []);
  });

  it('starts auditing the service after an explicit activation transition', () => {
    const active = { ...planned, lifecycle: 'active' };
    const drift = auditRailwayServiceConfig({ services: {} }, new Map(), [active]);

    assert.equal(drift.length, 1);
    assert.equal(drift[0].service, 'umami-retention');
    assert.equal(drift[0].missingService, true);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /umami-retention.*not present in Railway production/,
    );
  });

  it('never reconciles a planned cron even when the live service already exists', () => {
    const active = { ...managedRegistry[0], service: 'seed-example' };
    const liveRetention = service({
      cronSchedule: '0 * * * *',
      watchPatterns: ['scripts/**'],
      variables: { PGHOST: 'db.internal' },
    });
    liveRetention.source.rootDirectory = '';
    const drift = auditRailwayServiceConfig(
      {
        services: {
          'svc-example': service({
            cronSchedule: '0 * * * *',
            watchPatterns: active.watchPatterns,
          }),
          'svc-retention': liveRetention,
        },
      },
      new Map([
        ['seed-example', 'svc-example'],
        ['umami-retention', 'svc-retention'],
      ]),
      [active, planned],
    );

    assert.deepEqual(drift.map((entry) => entry.service), ['seed-example']);
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: {
        'svc-example': { deploy: { cronSchedule: active.cronSchedule } },
      },
    });
  });
});

describe('requiredEnv any-of groups', () => {
  // SZSE and Japan MOD resolve `SOURCE_SPECIFIC || PROXY_URL`. Declared
  // as two flat entries the audit demanded BOTH, so configuring only the
  // source-specific exit — the independently-replaceable state the per-source
  // split exists to deliver — reported drift and threw out of the patch builder,
  // vetoing reconciliation for every OTHER service in the same run.
  const anyOfRegistry = [{
    ...managedRegistry[0],
    requiredEnv: [['SZSE_PROXY_URL', 'PROXY_URL']],
  }];

  it('is satisfied by the source-specific variable alone', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
          variables: { SZSE_PROXY_URL: 'http://exit-a' },
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, anyOfRegistry), []);
  });

  it('is satisfied by the shared fallback alone', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
          variables: { PROXY_URL: 'http://shared' },
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, anyOfRegistry), []);
  });

  it('still fails when no alternative in the group is configured', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
          variables: { UNRELATED: 'x' },
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, anyOfRegistry);
    assert.deepEqual(drift[0].missingRequiredEnv, ['SZSE_PROXY_URL or PROXY_URL']);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /missing required environment: SZSE_PROXY_URL or PROXY_URL/,
    );
  });

  it('one unroutable service does not hide another service\'s real drift', () => {
    // The env veto is deliberately fail-closed, but the audit REPORT must still
    // name every drifted service so an operator sees the whole picture.
    const registry = [
      { ...managedRegistry[0], requiredEnv: [['SZSE_PROXY_URL', 'PROXY_URL']] },
      { service: 'seed-other', deployMode: 'nixpacks-root-scripts', watchPatterns: ['scripts/seed-other.mjs'], cronSchedule: '0 * * * *' },
    ];
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
        'svc-other': service({ watchPatterns: ['scripts/WRONG.mjs'], cronSchedule: '0 * * * *' }),
      },
    };
    const drift = auditRailwayServiceConfig(
      config,
      new Map([['seed-example', 'svc-example'], ['seed-other', 'svc-other']]),
      registry,
    );
    assert.deepEqual(drift.map((entry) => entry.service), ['seed-example', 'seed-other']);
    assert.deepEqual(drift[1].watchPatterns, {
      actual: ['scripts/WRONG.mjs'],
      expected: ['scripts/seed-other.mjs'],
    });
  });
});

// Restores the coverage the registry rewrite dropped. Before this sweep the
// audit only ever looked at registry-managed services, so a narrow watch filter
// on any of the ~30 other live seeders — the "merged is not ran" failure this
// guard exists to prevent — returned [] and printed "audit passed".
describe('unmanaged live seeders', () => {
  const registry = [managedRegistry[0]];
  const ids = new Map([['seed-example', 'svc-example'], ['seed-forecasts', 'svc-forecasts']]);

  function unmanagedSeeder({ watchPatterns, rootDirectory = 'scripts' }) {
    return {
      source: { repo: 'koala73/worldmonitor', rootDirectory },
      build: { watchPatterns },
      deploy: { startCommand: 'node seed-forecasts.mjs' },
      variables: {},
    };
  }

  // The managed service must be present in every fixture, otherwise it reports
  // missingService and drowns out what these cases are actually asserting.
  const managedService = () => service({
    watchPatterns: managedRegistry[0].watchPatterns,
    cronSchedule: managedRegistry[0].cronSchedule,
  });

  it('flags a narrow watch filter on a seeder the registry does not manage', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
        'svc-forecasts': unmanagedSeeder({ watchPatterns: ['scripts/seed-forecasts.mjs'] }),
      },
    };
    const drift = auditRailwayServiceConfig(config, ids, registry);
    assert.deepEqual(drift, [{
      service: 'seed-forecasts',
      serviceId: 'svc-forecasts',
      missingService: false,
      unmanagedSeeder: true,
      watchPatterns: {
        actual: ['scripts/seed-forecasts.mjs'],
        expected: ['scripts/**', 'shared/**'],
      },
      cronSchedule: null,
    }]);
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: { 'svc-forecasts': { build: { watchPatterns: ['scripts/**', 'shared/**'] } } },
    });
  });

  it('accepts a whole-repository filter, however it is expressed', () => {
    for (const watchPatterns of [[], undefined]) {
      const config = {
        services: {
          'svc-example': managedService(),
          'svc-forecasts': unmanagedSeeder({ watchPatterns }),
        },
      };
      assert.deepEqual(auditRailwayServiceConfig(config, ids, registry), []);
    }
  });

  it('accepts the broad contract and preserves extras outside scripts/ and shared/', () => {
    const broad = {
      services: {
        'svc-example': managedService(),
        'svc-forecasts': unmanagedSeeder({ watchPatterns: ['scripts/**', 'shared/**'] }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(broad, ids, registry), []);

    // A repo-rooted service can legitimately watch a Dockerfile or a server
    // helper; the fix must ADD the broad patterns, not replace those.
    const repoRooted = {
      services: {
        'svc-example': managedService(),
        'svc-forecasts': unmanagedSeeder({
          rootDirectory: '',
          watchPatterns: ['Dockerfile.seed-forecasts'],
        }),
      },
    };
    const drift = auditRailwayServiceConfig(repoRooted, ids, registry);
    assert.deepEqual(drift[0].watchPatterns.expected, [
      'Dockerfile.seed-forecasts',
      'scripts/**',
      'shared/**',
    ]);
  });

  it('does not second-guess a managed service or a non-seeder', () => {
    // A managed seeder's exact closure is intentionally narrow; the broad
    // contract must not fight it.
    assert.deepEqual(
      auditRailwayServiceConfig({ services: { 'svc-example': managedService() } }, ids, registry),
      [],
    );

    const notASeeder = {
      services: {
        'svc-example': managedService(),
        'svc-web': {
          source: { repo: 'koala73/worldmonitor', rootDirectory: '' },
          build: { watchPatterns: ['src/**'] },
          deploy: { startCommand: 'npm run start' },
          variables: {},
        },
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(notASeeder, ids, registry), []);
  });
});

describe('audit CLI argument parsing', () => {
  // The value this resolves selects which Railway environment --apply mutates.
  it('accepts both the space-separated and equals forms', () => {
    assert.equal(readArgument(['node', 's', '--environment', 'staging'], '--environment', 'production'), 'staging');
    assert.equal(readArgument(['node', 's', '--environment=staging'], '--environment', 'production'), 'staging');
    assert.equal(readArgument(['node', 's', '--apply', '--environment=staging'], '--environment', 'production'), 'staging');
  });

  it('falls back only when the flag is genuinely absent', () => {
    assert.equal(readArgument(['node', 's', '--apply'], '--environment', 'production'), 'production');
  });

  it('refuses a flag with no value instead of silently defaulting', () => {
    assert.throws(() => readArgument(['node', 's', '--environment'], '--environment', 'production'), /requires a value/);
    assert.throws(() => readArgument(['node', 's', '--environment', '--apply'], '--environment', 'production'), /requires a value/);
    assert.throws(() => readArgument(['node', 's', '--environment='], '--environment', 'production'), /requires a value/);
  });
});

describe('critical ingestion Railway registry contract', () => {
  const registry = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
  );
  // Cron pins stay an explicit literal: these are production schedules and a
  // silent edit to one should fail loudly rather than be rubber-stamped by
  // reading the same file the change lives in.
  const expected = new Map([
    ['seed-conflict-intel', '*/15 * * * *'],
    ['seed-gdelt-intel', '*/15 * * * *'],
    ['seed-supply-chain-trade', '0 */6 * * *'],
    ['seed-comtrade-bilateral-hs4', '0 6 1 * *'],
    ['seed-bundle-market-backup', '*/5 * * * *'],
    ['seed-bundle-derived-signals', '*/5 * * * *'],
    ['seed-bundle-portwatch', '0 */1 * * *'],
    ['seed-bundle-portwatch-port-activity', '0 */12 * * *'],
  ]);

  // Closure coverage is DERIVED from the same predicate the audit uses to decide
  // what --apply pushes to Railway. A hardcoded list here would let a future
  // registry entry ship narrow watch paths to production with its dependency
  // closure never verified.
  const closureManaged = managedRailwayServices(registry)
    .filter((entry) => Array.isArray(entry.watchPatterns) && entry.watchPatterns.length > 0);

  it('audit-manages the always-on Umami collector with whole-repository rebuilds', () => {
    const collector = registry.find((entry) => entry.service === 'umami');
    assert.ok(collector, 'umami must be registered');
    assert.deepEqual(
      collector.watchPatterns,
      [],
      'empty watch paths intentionally rebuild Umami for any repository change',
    );
    assert.ok(
      managedRailwayServices(registry).includes(collector),
      'Umami must participate in the live operational-config audit',
    );

    const liveCollector = service({
      cronSchedule: null,
      dockerfilePath: 'Dockerfile.umami',
      watchPatterns: [],
      variables: { DATABASE_URL: 'postgres://configured' },
    });
    const drift = auditRailwayServiceConfig(
      { services: { 'svc-umami': liveCollector } },
      new Map([['umami', 'svc-umami']]),
      [collector],
    );
    assert.deepEqual(drift, [{
      service: 'umami',
      serviceId: 'svc-umami',
      missingService: false,
      watchPatterns: null,
      cronSchedule: null,
      rootDirectory: { actual: 'scripts', expected: '' },
      missingRequiredEnv: ['APP_SECRET'],
    }]);
  });

  it('every cron pin names a service that is registry-managed', () => {
    const managedNames = new Set(closureManaged.map((entry) => entry.service));
    for (const serviceName of expected.keys()) {
      assert.ok(managedNames.has(serviceName), `${serviceName} must be registry-managed`);
    }
  });

  it('covers every managed service with watch paths', () => {
    assert.ok(closureManaged.length >= expected.size);
  });

  for (const entry of closureManaged) {
    const serviceName = entry.service;
    it(`${serviceName} pins its cron and complete runtime dependency closure`, () => {
      if (expected.has(serviceName)) {
        assert.equal(entry.cronSchedule, expected.get(serviceName));
      }
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
        ...extractFileReadDependencies(visited, repoRoot),
      ]);
      const missingRuntimeFiles = [...runtimeFiles]
        .filter((file) => !watched.has(file))
        .sort();
      assert.deepEqual(
        missingRuntimeFiles,
        [],
        `${serviceName} watchPatterns omit runtime dependencies`,
      );

      // The reverse direction. Without it a watch path that drops out of the
      // import graph lingers forever in a hand-typed 44-entry array, rebuilding
      // the service on changes it no longer depends on -- the exact cost the
      // exact-path registry was introduced to eliminate.
      const staleWatchedFiles = [...watched]
        .filter((file) => !runtimeFiles.has(file)
          && file !== entry.dockerfile
          && !NIXPACKS_BUILD_FILES.includes(file))
        .sort();
      assert.deepEqual(
        staleWatchedFiles,
        [],
        `${serviceName} watchPatterns contain paths that are no longer runtime dependencies`,
      );

      if (entry.deployMode === 'nixpacks-root-scripts') {
        for (const buildFile of NIXPACKS_BUILD_FILES) {
          assert.ok(watched.has(buildFile), `${serviceName} must watch ${buildFile}`);
        }
      }
      if (entry.dockerfile) {
        assert.ok(watched.has(entry.dockerfile), `${serviceName} must watch its Dockerfile`);
      }
    });
  }
});
