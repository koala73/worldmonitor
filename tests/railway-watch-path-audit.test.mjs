import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditRailwayServiceConfig,
  buildRailwayEditArgs,
  buildRailwayServiceConfigPatch,
  isRepositoryService,
  managedRailwayServices,
  readArgument,
  serializeRailwayServiceConfigPatch,
  waitForRailwayServiceConfigConvergence,
  watchPatternDrift,
} from '../scripts/audit-railway-watch-paths.mjs';

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

const managedRegistry = [
  {
    entry: 'scripts/seed-example.mjs',
    service: 'seed-example',
    watchPatterns: [],
    cronSchedule: '*/15 * * * *',
  },
];
const serviceIds = new Map([['seed-example', 'svc-example']]);

describe('Railway operational-config audit', () => {
  it('audits always-on services without reconciling their cron', () => {
    const registry = [{
      service: 'publisher',
      watchPatterns: [],
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
          expected: [],
        },
        cronSchedule: null,
      }],
    );
  });

  it('flags any watch-path filter and cron drift against the registry', () => {
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
          expected: [],
        },
        cronSchedule: {
          actual: '0 * * * *',
          expected: '*/15 * * * *',
        },
      },
    ]);
  });

  // An exact per-file closure is the shape this registry used to ship. It is
  // no safer than the broad one — Railway skipped merges under both — so it
  // must read as drift rather than as a narrower contract to preserve.
  it('flags an exact per-file closure exactly as it flags a glob', () => {
    const closure = [
      'scripts/seed-example.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
    ];
    const drift = auditRailwayServiceConfig(
      {
        services: {
          'svc-example': service({
            watchPatterns: closure,
            cronSchedule: managedRegistry[0].cronSchedule,
          }),
        },
      },
      serviceIds,
      managedRegistry,
    );
    assert.deepEqual(drift[0].watchPatterns, { actual: closure, expected: [] });
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: { 'svc-example': { build: { watchPatterns: [] } } },
    });
  });

  it('builds a minimal patch containing only drifted fields', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: [],
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
      'ops: clear watch-path filters and reconcile registry-managed config',
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
    // sortedUniqueStrings() collapsed a non-array to [], which compared equal to
    // a whole-repo filter — and the closure contract test skipped the same entry
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

  // The registry is where a filter would be reintroduced — a reviewer reads an
  // exact per-file closure as care, not as the mechanism that drops merges. Make
  // the shape unrepresentable rather than discouraged, so --apply can never
  // push a filter back to production.
  it('rejects a registry entry that declares any watch-path filter', () => {
    for (const watchPatterns of [['scripts/**'], ['scripts/seed-example.mjs']]) {
      assert.throws(
        () => auditRailwayServiceConfig(
          liveConfig,
          serviceIds,
          [{ ...managedRegistry[0], watchPatterns }],
        ),
        /declares a watch-path filter.*only supported value is \[\]/s,
      );
    }
    assert.deepEqual(
      auditRailwayServiceConfig(
        {
          services: {
            'svc-example': service({ cronSchedule: managedRegistry[0].cronSchedule }),
          },
        },
        serviceIds,
        managedRegistry,
      ),
      [],
      'an entry declaring [] must still audit clean',
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
    watchPatterns: [],
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
      { service: 'seed-other', deployMode: 'nixpacks-root-scripts', watchPatterns: [], cronSchedule: '0 * * * *' },
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
      expected: [],
    });
  });
});

// The sweep that makes "audit passed" mean the whole fleet. Registry coverage
// is opt-in — 41 entries against 80 live services — so a contract enforced only
// on registered services leaves the majority free to carry the filter that
// skips merges.
describe('live services this repository deploys', () => {
  const registry = [managedRegistry[0]];
  const ids = new Map([['seed-example', 'svc-example'], ['seed-forecasts', 'svc-forecasts']]);

  function unregisteredService({
    watchPatterns,
    rootDirectory = 'scripts',
    repo = 'koala73/worldmonitor',
    startCommand = 'node seed-forecasts.mjs',
  }) {
    return {
      source: { repo, rootDirectory },
      build: { watchPatterns },
      deploy: { startCommand },
      variables: {},
    };
  }

  // The managed service must be present in every fixture, otherwise it reports
  // missingService and drowns out what these cases are actually asserting.
  const managedService = () => service({
    watchPatterns: managedRegistry[0].watchPatterns,
    cronSchedule: managedRegistry[0].cronSchedule,
  });

  it('flags a watch filter on a service the registry does not manage', () => {
    const config = {
      services: {
        'svc-example': managedService(),
        'svc-forecasts': unregisteredService({ watchPatterns: ['scripts/seed-forecasts.mjs'] }),
      },
    };
    const drift = auditRailwayServiceConfig(config, ids, registry);
    assert.deepEqual(drift, [{
      service: 'seed-forecasts',
      serviceId: 'svc-forecasts',
      missingService: false,
      unregisteredService: true,
      watchPatterns: {
        actual: ['scripts/seed-forecasts.mjs'],
        expected: [],
      },
      cronSchedule: null,
    }]);
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: { 'svc-forecasts': { build: { watchPatterns: [] } } },
    });
  });

  it('accepts an unfiltered service, however Railway expresses it', () => {
    for (const watchPatterns of [[], undefined]) {
      const config = {
        services: {
          'svc-example': managedService(),
          'svc-forecasts': unregisteredService({ watchPatterns }),
        },
      };
      assert.deepEqual(auditRailwayServiceConfig(config, ids, registry), []);
    }
  });

  // The old contract accepted these two: `scripts/** + shared/**` was the
  // broad floor, and a repo-rooted service kept its extras. Both were measured
  // to skip merges, so both must now read as drift.
  it('flags the broad filter and a Dockerfile extra that used to be accepted', () => {
    for (const watchPatterns of [['scripts/**', 'shared/**'], ['Dockerfile.seed-forecasts']]) {
      const config = {
        services: {
          'svc-example': managedService(),
          'svc-forecasts': unregisteredService({ watchPatterns, rootDirectory: '' }),
        },
      };
      const drift = auditRailwayServiceConfig(config, ids, registry);
      assert.deepEqual(drift[0].watchPatterns, { actual: watchPatterns, expected: [] });
    }
  });

  // The old sweep keyed on `node seed-*` / `Dockerfile.seed-*`, which excluded
  // the relays, the workers and the consumer-prices trio. All of them deploy
  // this repository on every merge, and all of them carried a filter.
  it('covers every service in this repository, not only the ones named seed-*', () => {
    const config = {
      services: {
        'svc-example': managedService(),
        'svc-relay': unregisteredService({
          watchPatterns: ['scripts/notification-relay.cjs'],
          startCommand: 'node notification-relay.cjs',
        }),
      },
    };
    const drift = auditRailwayServiceConfig(
      config,
      new Map([['seed-example', 'svc-example'], ['notification-relay', 'svc-relay']]),
      registry,
    );
    assert.deepEqual(drift.map((entry) => entry.service), ['notification-relay']);
  });

  it('leaves services this repository does not deploy alone', () => {
    const foreign = {
      services: {
        'svc-example': managedService(),
        'svc-vendor': unregisteredService({
          repo: 'someone-else/other-repo',
          watchPatterns: ['src/**'],
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(foreign, ids, registry), []);

    // A database service has no source at all.
    const database = {
      services: {
        'svc-example': managedService(),
        'svc-pg': { build: { watchPatterns: [] }, deploy: {}, variables: {} },
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(database, ids, registry), []);
  });

  // Railway answering with a shape we cannot read must not audit clean: the
  // old code ran it through sortedUniqueStrings, which collapsed a non-array
  // to [] and compared it equal to "no filter".
  it('treats an unreadable watchPatterns as a filter, not as no filter', () => {
    assert.deepEqual(
      watchPatternDrift({ source: { repo: 'koala73/worldmonitor' }, build: { watchPatterns: 'scripts/**' } }),
      { actual: [], expected: [] },
    );
    assert.equal(isRepositoryService({ source: { repo: 'koala73/worldmonitor' } }), true);
    assert.equal(isRepositoryService({ source: { repo: 'other/repo' } }), false);
    assert.equal(isRepositoryService({}), false);
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

  it('every cron pin names a service the registry manages', () => {
    const managedNames = new Set(managedRailwayServices(registry).map((entry) => entry.service));
    for (const serviceName of expected.keys()) {
      assert.ok(managedNames.has(serviceName), `${serviceName} must be registry-managed`);
    }
  });

  it('pins the cron of every service this contract names', () => {
    for (const [serviceName, cronSchedule] of expected) {
      const entry = registry.find((candidate) => candidate.service === serviceName);
      assert.ok(entry, `${serviceName} must be registered`);
      assert.equal(entry.cronSchedule, cronSchedule, `${serviceName} cron pin`);
    }
  });

  // The contract that replaced the per-service dependency closures. Enumerating
  // a closure was never the safe option — it was the option whose cost is paid
  // by whoever adds the next helper — and a filter of any width skips merges,
  // so no entry may declare one.
  it('no registry entry declares a watch-path filter', () => {
    const filtered = registry
      .filter((entry) => entry.watchPatterns?.length > 0)
      .map((entry) => entry.service);
    assert.deepEqual(filtered, [], 'watch-path filters silently skip merges (#6141)');
  });

  // Registry coverage is opt-in and always has been: 30 of 41 entries exist for
  // Dockerfile/source coverage and name bundle members rather than services.
  // The fleet-wide guarantee therefore cannot come from the registry — it comes
  // from the live sweep over every service whose source is this repository,
  // which is what the suite above pins.
  it('states the unfiltered contract for every entry it does audit-manage', () => {
    const undeclared = managedRailwayServices(registry)
      .filter((entry) => !Array.isArray(entry.watchPatterns))
      .map((entry) => entry.service);
    assert.deepEqual(undeclared, []);
  });
});
