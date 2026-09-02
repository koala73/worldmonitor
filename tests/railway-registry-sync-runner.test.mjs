import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRegistrySyncArgs,
  runRailwayRegistrySync,
} from '../scripts/run-railway-registry-sync.mjs';

const baseEnv = {
  PATH: '/usr/bin',
  RAILWAY_PROJECT_ID: 'project-1',
};

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
      /verify failed after 3 attempts/,
    );
    assert.equal(calls, 3);
  });
});
