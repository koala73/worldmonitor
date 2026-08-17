// U2 native Railway autodeploy migration safety contract.
//
// This utility is intentionally temporary. These tests make the dangerous
// part small: an operator can preview the fleet, then change only
// source.checkSuites for at most five explicitly named services.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCheckSuitesPatch,
  executeMigration,
  MAX_BATCH_SIZE,
  parseMigrationArgs,
} from '../scripts/configure-railway-native-autodeploy.mjs';

const REPOSITORY = 'koala73/worldmonitor';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function targetStatus({ projectId = 'project-1', environments = [{ id: 'env-production', name: 'production' }] } = {}) {
  return {
    id: projectId,
    name: 'world-monitor',
    environments: {
      edges: environments.map((node) => ({ node })),
    },
  };
}

function fleetServices() {
  return [
    {
      id: 'service-a',
      name: 'seed-a',
      source: { repo: REPOSITORY, image: null },
    },
    {
      id: 'service-b',
      name: 'seed-b',
      source: { repo: REPOSITORY, image: null },
    },
    {
      id: 'service-database',
      name: 'database',
      source: { repo: null, image: 'postgres:17' },
    },
  ];
}

function fleetConfig() {
  return {
    services: {
      'service-a': {
        source: {
          repo: REPOSITORY,
          branch: 'main',
          checkSuites: true,
          rootDirectory: 'scripts',
        },
        build: { watchPatterns: ['scripts/seed-a.mjs'] },
        deploy: { cronSchedule: '0 * * * *' },
        variables: { PRIVATE_VALUE: { value: 'never-print-this' } },
      },
      'service-b': {
        source: {
          repo: REPOSITORY,
          branch: 'main',
          rootDirectory: 'scripts',
        },
        build: { watchPatterns: ['scripts/seed-b.mjs'] },
        deploy: { cronSchedule: '30 * * * *' },
        variables: { ANOTHER_PRIVATE_VALUE: { value: 'also-never-print-this' } },
      },
      'service-database': {
        source: { image: 'postgres:17' },
        build: {},
        deploy: {},
        variables: { POSTGRES_PASSWORD: { value: 'database-secret' } },
      },
    },
  };
}

function makeRailway({
  status = targetStatus(),
  services = fleetServices(),
  configs = [fleetConfig()],
  edit = () => '{}',
} = {}) {
  const calls = [];
  let configRead = 0;
  const railway = (args, options = {}) => {
    calls.push({ args: [...args], options: { ...options } });
    if (args[0] === 'status') return JSON.stringify(status);
    if (args[0] === 'service' && args[1] === 'list') return JSON.stringify(services);
    if (args[0] === 'environment' && args[1] === 'config') {
      const value = configs[Math.min(configRead, configs.length - 1)];
      configRead += 1;
      if (value instanceof Error) throw value;
      return JSON.stringify(value);
    }
    if (args[0] === 'environment' && args[1] === 'edit') return edit(args, options);
    throw new Error(`unexpected Railway call: ${args.join(' ')}`);
  };
  return { calls, railway };
}

const BASE_ARGS = ['--project-id', 'project-1', '--environment', 'production'];
const SAFE_ENV = {
  HOME: '/runner/home',
  PATH: '/runner/bin',
  RAILWAY_TOKEN: 'railway-token',
  GH_TOKEN: 'github-token',
  GITHUB_TOKEN: 'github-actions-token',
  RAILWAY_RECONCILE_MUTATION_HMAC: 'mutation-secret',
  RAILWAY_RECONCILE_OPERATOR_HMAC: 'operator-secret',
};

function execute(argv, railway, overrides = {}) {
  return executeMigration(argv, {
    railway,
    auditConfig: () => [],
    registry: [],
    env: SAFE_ENV,
    readbackAttempts: 2,
    readbackDelayMs: 0,
    sleep: async () => {},
    ...overrides,
  });
}

describe('native autodeploy migration argument contract', () => {
  it('is preview-only by default and permits an inventory preview without selection', () => {
    assert.deepEqual(parseMigrationArgs(BASE_ARGS), {
      mode: 'preview',
      projectId: 'project-1',
      environment: 'production',
      services: [],
      json: false,
    });
  });

  it('requires explicit project and environment for every mode', () => {
    assert.throws(
      () => parseMigrationArgs(['--environment', 'production']),
      /--project-id is required/,
    );
    assert.throws(
      () => parseMigrationArgs(['--project-id', 'project-1']),
      /--environment is required/,
    );
  });

  it('requires explicit service selection for mutation and rejects conflicting modes', () => {
    assert.throws(() => parseMigrationArgs([...BASE_ARGS, '--apply']), /at least one --service/);
    assert.throws(() => parseMigrationArgs([...BASE_ARGS, '--rollback']), /at least one --service/);
    assert.throws(
      () => parseMigrationArgs([...BASE_ARGS, '--service', 'seed-a', '--apply', '--rollback']),
      /mutually exclusive/,
    );
  });

  it('rejects duplicate selections, oversized batches, duplicate scalar flags, and unknown arguments', () => {
    assert.throws(
      () => parseMigrationArgs([...BASE_ARGS, '--service', 'seed-a', '--service=seed-a', '--apply']),
      /duplicate service seed-a/,
    );
    const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) => [
      '--service',
      `seed-${index}`,
    ]).flat();
    assert.throws(
      () => parseMigrationArgs([...BASE_ARGS, ...tooMany, '--apply']),
      new RegExp(`at most ${MAX_BATCH_SIZE}`),
    );
    assert.throws(
      () => parseMigrationArgs([...BASE_ARGS, '--project-id', 'project-2']),
      /--project-id may be provided only once/,
    );
    assert.throws(() => parseMigrationArgs([...BASE_ARGS, '--surprise']), /unknown argument/);
  });
});

describe('native autodeploy migration target preflight', () => {
  it('previews the full repository cohort without editing Railway or exposing config values', async () => {
    const { calls, railway } = makeRailway();
    const result = await execute(BASE_ARGS, railway);

    assert.deepEqual(result.inventory, {
      repositoryServices: 2,
      checkSuites: { true: 1, false: 0, missing: 1 },
    });
    assert.deepEqual(result.selected, []);
    assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
    assert.deepEqual(calls[0].args, [
      'status',
      '--project',
      'project-1',
      '--environment',
      'production',
      '--json',
    ]);
    assert.deepEqual(calls[1].args, [
      'service',
      'list',
      '--project',
      'project-1',
      '--environment',
      'env-production',
      '--json',
    ]);
    assert.deepEqual(calls[2].args, [
      'environment',
      'config',
      '--environment',
      'env-production',
      '--json',
    ]);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /never-print-this|also-never-print-this|database-secret/);
    assert.doesNotMatch(serialized, /PRIVATE_VALUE|POSTGRES_PASSWORD/);
  });

  it('previews a selected apply batch as before -> false without editing Railway', async () => {
    const { calls, railway } = makeRailway();
    const result = await execute([...BASE_ARGS, '--service', 'seed-a'], railway);
    assert.deepEqual(result.selected, [
      { name: 'seed-a', id: 'service-a', before: true, after: false },
    ]);
    assert.equal(result.mutated, false);
    assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
  });

  it('fails before config read or edit when status cannot prove the exact project', async () => {
    const { calls, railway } = makeRailway({ status: targetStatus({ projectId: 'wrong-project' }) });
    await assert.rejects(execute(BASE_ARGS, railway), /project id wrong-project.*project-1/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'status');
  });

  it('fails before config read or edit when the requested environment is missing or ambiguous', async () => {
    for (const environments of [
      [{ id: 'env-staging', name: 'staging' }],
      [
        { id: 'env-a', name: 'production' },
        { id: 'env-b', name: 'production' },
      ],
    ]) {
      const { calls, railway } = makeRailway({ status: targetStatus({ environments }) });
      await assert.rejects(execute(BASE_ARGS, railway), /environment production/);
      assert.equal(calls.length, 1);
    }
  });

  it('fails before config read or edit on malformed or non-JSON Railway status', async () => {
    for (const rawStatus of [{}, 'not-json']) {
      const calls = [];
      const railway = (args) => {
        calls.push(args);
        if (args[0] === 'status') {
          return typeof rawStatus === 'string' ? rawStatus : JSON.stringify(rawStatus);
        }
        throw new Error('must not continue after an unreadable target');
      };
      await assert.rejects(execute(BASE_ARGS, railway), /Railway status|JSON/);
      assert.equal(calls.length, 1);
    }
  });

  it('forbids mutation from CI or GitHub Actions while leaving preview read-only', async () => {
    for (const marker of [
      { CI: 'true' },
      { CI: '1' },
      { CI: 'yes' },
      { GITHUB_ACTIONS: 'TRUE' },
      { GITHUB_ACTIONS: '1' },
    ]) {
      const blocked = makeRailway();
      await assert.rejects(
        execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], blocked.railway, {
          env: { ...SAFE_ENV, ...marker },
        }),
        /trusted operator shell.*forbidden/,
      );
      assert.equal(blocked.calls.length, 0);

      const preview = makeRailway();
      const result = await execute(BASE_ARGS, preview.railway, {
        env: { ...SAFE_ENV, ...marker },
      });
      assert.equal(result.mutated, false);
    }
  });

  it('rejects ambiguous Railway credentials before making any CLI call', async () => {
    const { calls, railway } = makeRailway();
    await assert.rejects(
      execute(BASE_ARGS, railway, {
        env: { ...SAFE_ENV, RAILWAY_API_TOKEN: 'second-token' },
      }),
      /at most one Railway credential/,
    );
    assert.equal(calls.length, 0);
  });

  it('sanitizes Railway command failures instead of forwarding child stderr', async () => {
    await assert.rejects(
      execute(BASE_ARGS, () => {
        throw new Error('command failed with SUPER_SECRET_VALUE');
      }),
      (error) => {
        assert.match(error.message, /Railway status command failed/);
        assert.doesNotMatch(error.message, /SUPER_SECRET_VALUE/);
        return true;
      },
    );
  });
});

describe('native autodeploy service selection', () => {
  it('fails closed on unknown, non-repository, and non-main selected services', async () => {
    const cases = [
      { name: 'missing', expected: /unknown Railway service missing/ },
      { name: 'database', expected: /database.*not sourced from koala73\/worldmonitor/ },
      {
        name: 'seed-a',
        expected: /seed-a.*branch.*feature/,
        mutateConfig(config) {
          config.services['service-a'].source.branch = 'feature';
        },
      },
    ];
    for (const testCase of cases) {
      const config = fleetConfig();
      testCase.mutateConfig?.(config);
      const { calls, railway } = makeRailway({ configs: [config] });
      await assert.rejects(
        execute([...BASE_ARGS, '--service', testCase.name, '--apply'], railway),
        testCase.expected,
      );
      assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
    }
  });

  it('rejects an unselected foreign repository present in both Railway payloads', async () => {
    const services = fleetServices();
    services[1].source.repo = 'someone/else';
    const config = fleetConfig();
    config.services['service-b'].source.repo = 'someone/else';
    const { calls, railway } = makeRailway({ services, configs: [config] });

    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
      /seed-b.*source repository.*koala73\/worldmonitor/,
    );
    assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
  });

  it('fails closed on duplicate live names and malformed service/config payloads', async () => {
    const duplicateServices = fleetServices();
    duplicateServices.push({
      id: 'service-a-shadow',
      name: 'seed-a',
      source: { repo: REPOSITORY, image: null },
    });
    const malformedCases = [
      { services: duplicateServices, configs: [fleetConfig()], expected: /duplicate live service name seed-a/ },
      { services: {}, configs: [fleetConfig()], expected: /service list must return an array/ },
      { services: fleetServices(), configs: [{}], expected: /environment config must contain a services object/ },
      {
        services: fleetServices(),
        configs: [(() => {
          const config = fleetConfig();
          config.services['service-a'].source.checkSuites = 'yes';
          return config;
        })()],
        expected: /seed-a.*checkSuites.*boolean/,
      },
      {
        services: (() => {
          const services = fleetServices();
          services[0].source.repo = 'someone/else';
          return services;
        })(),
        configs: [fleetConfig()],
        expected: /seed-a source repository differs/,
      },
      {
        services: fleetServices(),
        configs: [(() => {
          const config = fleetConfig();
          config.services['service-a'].source.image = 'postgres:17';
          return config;
        })()],
        expected: /seed-a has contradictory repository and image sources in Railway config/,
      },
    ];
    for (const testCase of malformedCases) {
      const { calls, railway } = makeRailway(testCase);
      await assert.rejects(
        execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
        testCase.expected,
      );
      assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
    }
  });

  it('refuses mutation when the existing registry/config audit is nonzero', async () => {
    const { calls, railway } = makeRailway();
    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway, {
        auditConfig: () => [{ service: 'seed-a' }],
      }),
      /operational-config audit.*seed-a/,
    );
    assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
  });
});

describe('native autodeploy mutation and readback', () => {
  it('builds exact selected-service patches for apply and rollback', () => {
    const selected = [
      { id: 'service-a', name: 'seed-a' },
      { id: 'service-b', name: 'seed-b' },
    ];
    assert.deepEqual(buildCheckSuitesPatch(selected, false), {
      services: {
        'service-a': { source: { checkSuites: false } },
        'service-b': { source: { checkSuites: false } },
      },
    });
    assert.deepEqual(buildCheckSuitesPatch(selected, true), {
      services: {
        'service-a': { source: { checkSuites: true } },
        'service-b': { source: { checkSuites: true } },
      },
    });
  });

  it('applies only checkSuites=false and converges a missing value explicitly', async () => {
    const before = fleetConfig();
    const after = clone(before);
    after.services['service-a'].source.checkSuites = false;
    after.services['service-b'].source.checkSuites = false;
    const { calls, railway } = makeRailway({ configs: [before, before, after] });

    const result = await execute([
      ...BASE_ARGS,
      '--service',
      'seed-a',
      '--service',
      'seed-b',
      '--apply',
      '--json',
    ], railway);

    const edit = calls.find(({ args }) => args[0] === 'environment' && args[1] === 'edit');
    assert.ok(edit);
    assert.deepEqual(edit.args, [
      'environment',
      'edit',
      '--project',
      'project-1',
      '--environment',
      'env-production',
      '--message',
      'ops: migrate selected services to native Railway autodeploy',
      '--json',
    ]);
    assert.equal(edit.options.input, `${JSON.stringify({
      services: {
        'service-a': { source: { checkSuites: false } },
        'service-b': { source: { checkSuites: false } },
      },
    })}\n`);
    assert.deepEqual(result.selected, [
      { name: 'seed-a', id: 'service-a', before: true, after: false },
      { name: 'seed-b', id: 'service-b', before: 'missing', after: false },
    ]);
    assert.equal(result.mutated, true);
    assert.equal(JSON.stringify(result).includes('never-print-this'), false);
    assert.deepEqual(edit.options.env, {
      HOME: '/runner/home',
      PATH: '/runner/bin',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_TOKEN: 'railway-token',
    });
  });

  it('returns verified success when an edit error is followed by exact convergence', async () => {
    const before = fleetConfig();
    const after = clone(before);
    after.services['service-a'].source.checkSuites = false;
    const { calls, railway } = makeRailway({
      configs: [before, before, after],
      edit() {
        throw new Error('transport failed after commit with PRIVATE_VALUE');
      },
    });

    const result = await execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway);

    assert.deepEqual(result.selected, [
      { name: 'seed-a', id: 'service-a', before: true, after: false },
    ]);
    assert.equal(result.mutated, true);
    assert.equal(
      calls.filter(({ args }) => args[0] === 'environment' && args[1] === 'config').length,
      3,
    );
    assert.equal(JSON.stringify(result).includes('PRIVATE_VALUE'), false);
  });

  it('reports an ambiguous outcome when an edit error remains unchanged or partially converged', async () => {
    const before = fleetConfig();
    const partial = clone(before);
    partial.services['service-a'].source.checkSuites = false;
    const cases = [
      { configs: [before, before, before, before], services: ['seed-a'] },
      { configs: [before, before, partial, partial], services: ['seed-a', 'seed-b'] },
    ];

    for (const testCase of cases) {
      const { calls, railway } = makeRailway({
        configs: testCase.configs,
        edit() {
          throw new Error('transport failed with PRIVATE_VALUE');
        },
      });
      const serviceArgs = testCase.services.flatMap((service) => ['--service', service]);

      await assert.rejects(
        execute([...BASE_ARGS, ...serviceArgs, '--apply'], railway),
        (error) => {
          assert.equal(
            error.message,
            'Railway environment edit: ambiguous edit outcome; run preview before retrying',
          );
          return true;
        },
      );
      assert.equal(
        calls.filter(({ args }) => args[0] === 'environment' && args[1] === 'config').length,
        4,
      );
      assert.equal(
        calls.filter(({ args }) => args[0] === 'environment' && args[1] === 'edit').length,
        1,
      );
    }
  });

  it('sanitizes readback failure after an edit error', async () => {
    const before = fleetConfig();
    const { calls, railway } = makeRailway({
      configs: [before, before, new Error('readback failed with PRIVATE_VALUE')],
      edit() {
        throw new Error('edit failed with ANOTHER_PRIVATE_VALUE');
      },
    });

    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
      (error) => {
        assert.equal(
          error.message,
          'Railway environment edit: ambiguous edit outcome; run preview before retrying',
        );
        return true;
      },
    );
    assert.equal(
      calls.filter(({ args }) => args[0] === 'environment' && args[1] === 'config').length,
      3,
    );
  });

  it('sanitizes out-of-scope drift after an edit error', async () => {
    const before = fleetConfig();
    const drifted = clone(before);
    drifted.services['service-a'].source.checkSuites = false;
    drifted.services['service-b'].variables.ANOTHER_PRIVATE_VALUE.value = 'changed-secret';
    const { calls, railway } = makeRailway({
      configs: [before, before, drifted],
      edit() {
        throw new Error('edit failed with ANOTHER_PRIVATE_VALUE');
      },
    });

    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
      (error) => {
        assert.equal(
          error.message,
          'Railway environment edit: ambiguous edit outcome; run preview before retrying',
        );
        return true;
      },
    );
    assert.equal(
      calls.filter(({ args }) => args[0] === 'environment' && args[1] === 'config').length,
      3,
    );
  });

  it('rolls back only the selected service to checkSuites=true', async () => {
    const before = fleetConfig();
    before.services['service-a'].source.checkSuites = false;
    const after = clone(before);
    after.services['service-a'].source.checkSuites = true;
    const { calls, railway } = makeRailway({ configs: [before, before, after] });

    const result = await execute([
      ...BASE_ARGS,
      '--service=seed-a',
      '--rollback',
    ], railway);
    const edit = calls.find(({ args }) => args[0] === 'environment' && args[1] === 'edit');
    assert.deepEqual(JSON.parse(edit.options.input), {
      services: { 'service-a': { source: { checkSuites: true } } },
    });
    assert.deepEqual(result.selected, [
      { name: 'seed-a', id: 'service-a', before: false, after: true },
    ]);
  });

  it('returns nonzero on partial convergence and names only affected services', async () => {
    const before = fleetConfig();
    const { railway } = makeRailway({ configs: [before, before, before, before] });
    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
      (error) => {
        assert.match(error.message, /did not converge.*seed-a/);
        assert.doesNotMatch(error.message, /never-print-this|PRIVATE_VALUE/);
        return true;
      },
    );
  });

  it('fails when Railway changes another selected field or any unselected service', async () => {
    for (const mutate of [
      (config) => config.services['service-a'].build.watchPatterns.push('scripts/unexpected.mjs'),
      (config) => { config.services['service-b'].deploy.cronSchedule = '15 * * * *'; },
    ]) {
      const before = fleetConfig();
      const after = clone(before);
      after.services['service-a'].source.checkSuites = false;
      mutate(after);
      const { railway } = makeRailway({ configs: [before, before, after] });
      await assert.rejects(
        execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
        /outside selected source\.checkSuites|unselected service/,
      );
    }
  });

  it('fails on transient out-of-scope drift even if a later read would look clean', async () => {
    const before = fleetConfig();
    const intermediate = clone(before);
    intermediate.services['service-b'].deploy.cronSchedule = '15 * * * *';
    const converged = clone(before);
    converged.services['service-a'].source.checkSuites = false;
    const { calls, railway } = makeRailway({
      configs: [before, before, intermediate, converged],
    });

    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
      /changed unselected service service-b/,
    );
    assert.equal(
      calls.filter(({ args }) => args[0] === 'environment' && args[1] === 'config').length,
      3,
    );
  });

  it('rejects config drift between preflight and the edit', async () => {
    const before = fleetConfig();
    const changed = clone(before);
    changed.services['service-b'].deploy.cronSchedule = '15 * * * *';
    const { calls, railway } = makeRailway({ configs: [before, changed] });

    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], railway),
      /config changed during mutation preflight/,
    );
    assert.equal(calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);
  });

  it('rejects apply for an already-migrated service and rollback without a migrated state', async () => {
    const alreadyMigrated = fleetConfig();
    alreadyMigrated.services['service-a'].source.checkSuites = false;
    const apply = makeRailway({ configs: [alreadyMigrated] });
    await assert.rejects(
      execute([...BASE_ARGS, '--service', 'seed-a', '--apply'], apply.railway),
      /already source\.checkSuites=false.*not eligible for apply/,
    );
    assert.equal(apply.calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'), false);

    for (const state of ['true', 'missing']) {
      const notMigrated = fleetConfig();
      if (state === 'missing') delete notMigrated.services['service-a'].source.checkSuites;
      const rollback = makeRailway({ configs: [notMigrated] });
      await assert.rejects(
        execute([...BASE_ARGS, '--service', 'seed-a', '--rollback'], rollback.railway),
        /must be source\.checkSuites=false before rollback/,
      );
      assert.equal(
        rollback.calls.some(({ args }) => args[0] === 'environment' && args[1] === 'edit'),
        false,
      );
    }
  });
});
