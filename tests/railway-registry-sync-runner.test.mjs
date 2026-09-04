import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MODE_ATTEMPT_TIMEOUT_MS,
  parseRegistrySyncArgs,
  runRailwayRegistrySync,
} from '../scripts/run-railway-registry-sync.mjs';
import { CONFIGURATION_DRIFT_EXIT_CODE } from '../scripts/audit-railway-watch-paths.mjs';

const baseEnv = {
  PATH: '/usr/bin',
  RAILWAY_PROJECT_ID: 'project-1',
};
const runnerPath = fileURLToPath(new URL('../scripts/run-railway-registry-sync.mjs', import.meta.url));

describe('Railway registry sync runner', () => {
  it('accepts one closed apply or verify mode', () => {
    assert.equal(parseRegistrySyncArgs(['--mode', 'apply']), 'apply');
    assert.equal(parseRegistrySyncArgs(['--mode=verify']), 'verify');
    assert.throws(() => parseRegistrySyncArgs([]), /--mode is required/);
    assert.throws(() => parseRegistrySyncArgs(['--mode', 'repair']), /expected apply or verify/);
    assert.throws(() => parseRegistrySyncArgs(['--mode', 'apply', '--extra']), /unknown argument/);
  });

  it('requires one credential and rejects credential overlap', async () => {
    await assert.rejects(
      runRailwayRegistrySync({ mode: 'apply', env: baseEnv }),
      /apply mode requires RAILWAY_TOKEN/,
    );
    await assert.rejects(
      runRailwayRegistrySync({
        mode: 'apply',
        env: { ...baseEnv, RAILWAY_API_TOKEN: 'viewer', RAILWAY_TOKEN: 'mutation' },
      }),
      /apply mode forbids RAILWAY_API_TOKEN/,
    );
    await assert.rejects(
      runRailwayRegistrySync({ mode: 'verify', env: baseEnv }),
      /verify mode requires RAILWAY_API_TOKEN/,
    );
    await assert.rejects(
      runRailwayRegistrySync({
        mode: 'verify',
        env: { ...baseEnv, RAILWAY_API_TOKEN: 'viewer', RAILWAY_TOKEN: 'mutation' },
      }),
      /verify mode forbids RAILWAY_TOKEN/,
    );
  });

  it('maps each mode to the existing audit without forwarding unrelated secrets', async () => {
    const calls = [];
    const spawnImpl = (...args) => {
      calls.push(args);
      return { status: 0, signal: null, error: null };
    };

    await runRailwayRegistrySync({
      mode: 'apply',
      env: {
        ...baseEnv,
        RAILWAY_TOKEN: 'mutation',
        UNRELATED_SECRET: 'must-not-cross',
      },
      spawnImpl,
    });
    await runRailwayRegistrySync({
      mode: 'verify',
      env: {
        ...baseEnv,
        RAILWAY_API_TOKEN: 'viewer',
        RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS: '1234',
        UNRELATED_SECRET: 'must-not-cross',
      },
      spawnImpl,
    });

    assert.match(calls[0][1][0], /audit-railway-watch-paths\.mjs$/);
    assert.deepEqual(calls[0][1].slice(1), ['--apply', '--environment', 'production']);
    assert.deepEqual(calls[1][1].slice(1), [
      '--deployment-only',
      '--environment',
      'production',
      '--concurrency',
      '2',
    ]);
    assert.equal(calls[0][2].env.RAILWAY_TOKEN, 'mutation');
    assert.equal(calls[1][2].env.RAILWAY_API_TOKEN, 'viewer');
    assert.equal(calls[1][2].env.RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS, '1234');
    assert.equal(calls[0][2].env.UNRELATED_SECRET, undefined);
    assert.equal(calls[1][2].env.UNRELATED_SECRET, undefined);
    assert.equal(calls[0][2].stdio, 'inherit');
    assert.equal(calls[1][2].stdio, 'inherit');
    assert.equal(calls[0][2].timeout, MODE_ATTEMPT_TIMEOUT_MS.apply);
    assert.equal(calls[1][2].timeout, MODE_ATTEMPT_TIMEOUT_MS.verify);
    assert.equal(calls[0][2].killSignal, 'SIGTERM');
    assert.equal(calls[1][2].killSignal, 'SIGTERM');
  });

  it('retries a failed idempotent operation and stops after convergence', async () => {
    const statuses = [1, 1, 0];
    const sleeps = [];
    let calls = 0;

    await runRailwayRegistrySync({
      mode: 'apply',
      env: { ...baseEnv, RAILWAY_TOKEN: 'mutation' },
      retryDelaysMs: [5, 15],
      spawnImpl: () => ({ status: statuses[calls++], signal: null, error: null }),
      sleepImpl: async (delayMs) => sleeps.push(delayMs),
    });

    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [5, 15]);
  });

  it('fails after the bounded retry budget', async () => {
    let calls = 0;
    await assert.rejects(
      runRailwayRegistrySync({
        mode: 'verify',
        env: { ...baseEnv, RAILWAY_API_TOKEN: 'viewer' },
        retryDelaysMs: [0, 0],
        spawnImpl: () => {
          calls += 1;
          return { status: 1, signal: null, error: null };
        },
        sleepImpl: async () => {},
      }),
      /verify failed after 3 attempts \(last failure: exit 1\)/,
    );
    assert.equal(calls, 3);
  });

  it('does not retry a configuration-drift verdict', async () => {
    let calls = 0;
    const sleeps = [];
    await assert.rejects(
      runRailwayRegistrySync({
        mode: 'verify',
        env: { ...baseEnv, RAILWAY_API_TOKEN: 'viewer' },
        retryDelaysMs: [5, 15],
        spawnImpl: () => {
          calls += 1;
          return { status: CONFIGURATION_DRIFT_EXIT_CODE, signal: null, error: null };
        },
        sleepImpl: async (delayMs) => sleeps.push(delayMs),
      }),
      /reported configuration drift \(exit 2\); verdicts are not retried/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });

  it('does not retry an apply-mode patch refusal', async () => {
    let calls = 0;
    await assert.rejects(
      runRailwayRegistrySync({
        mode: 'apply',
        env: { ...baseEnv, RAILWAY_TOKEN: 'mutation' },
        retryDelaysMs: [5, 15],
        spawnImpl: () => {
          calls += 1;
          return { status: CONFIGURATION_DRIFT_EXIT_CODE, signal: null, error: null };
        },
        sleepImpl: async () => {
          throw new Error('a refused patch must not be retried');
        },
      }),
      /apply reported configuration drift \(exit 2\); verdicts are not retried/,
    );
    assert.equal(calls, 1);
  });

  it('retries a timed-out or signalled attempt and names each cause', async (t) => {
    const errorLog = t.mock.method(console, 'error', () => {});
    const results = [
      {
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      },
      { status: null, signal: 'SIGKILL', error: null },
      { status: 0, signal: null, error: null },
    ];

    await runRailwayRegistrySync({
      mode: 'apply',
      env: { ...baseEnv, RAILWAY_TOKEN: 'mutation' },
      retryDelaysMs: [0, 0],
      spawnImpl: () => results.shift(),
      sleepImpl: async () => {},
    });

    assert.equal(results.length, 0);
    const logged = errorLog.mock.calls.map((call) => String(call.arguments[0]));
    assert.match(logged[0], /attempt 1 failed \(spawn error: spawnSync node ETIMEDOUT\)/);
    assert.match(logged[1], /attempt 2 failed \(signal SIGKILL\)/);
  });

  it('runs its CLI entrypoint through a symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'railway-registry-sync-'));
    const symlinkPath = join(directory, 'registry-sync.mjs');
    try {
      symlinkSync(runnerPath, symlinkPath);
      const result = spawnSync(process.execPath, [symlinkPath], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--mode is required/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
