/**
 * Regression tests for owner-checked deep-forecast task cleanup.
 *
 * completeDeepForecastTask / releaseDeepForecastTask previously deleted the
 * claim lock unconditionally. A worker whose FORECAST_DEEP_LOCK_TTL_SECONDS
 * (20 min) expired mid-run could then delete a lock re-claimed by another
 * worker, letting a third worker double-run the same runId. The fix mirrors
 * _SIM_TASK_COMPLETE_LUA / _SIM_LOCK_RELEASE_LUA: only the lock OWNER may
 * clean up.
 *
 * Run: node --test tests/deep-forecast-lock-owner.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __setRedisStoreForTests,
  completeDeepForecastTask,
  createDeepForecastLeaseGuard,
  releaseDeepForecastTask,
  renewDeepForecastTaskLease,
} from '../scripts/seed-forecasts.mjs';

const QUEUE_KEY = 'forecast:deep-task-queue:v1';
const taskKey = (runId) => `forecast:deep-task:v1:${runId}`;
const lockKey = (runId) => `forecast:deep-lock:v1:${runId}`;
const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

describe('owner-checked deep-forecast cleanup', () => {
  beforeEach(() => {
    __setRedisStoreForTests(null);
  });

  afterEach(() => {
    __setRedisStoreForTests(null);
    globalThis.fetch = originalFetch;
    if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  });

  it('completes when the caller still owns the lock', async () => {
    const store = {
      [QUEUE_KEY]: ['run-1'],
      [taskKey('run-1')]: '{"runId":"run-1"}',
      [lockKey('run-1')]: 'worker-A',
    };
    __setRedisStoreForTests(store);

    await completeDeepForecastTask('run-1', 'worker-A');

    assert.equal(store[QUEUE_KEY].includes('run-1'), false);
    assert.equal(store[taskKey('run-1')], undefined);
    assert.equal(store[lockKey('run-1')], undefined);
  });

  it('refuses to clean up a lock owned by another worker (double-run guard)', async () => {
    const store = {
      [QUEUE_KEY]: ['run-1'],
      [taskKey('run-1')]: '{"runId":"run-1"}',
      // Lock expired, then worker-B re-claimed it; stale worker-A finishes.
      [lockKey('run-1')]: 'worker-B',
    };
    __setRedisStoreForTests(store);

    await completeDeepForecastTask('run-1', 'worker-A');

    // Everything must be preserved for the current owner's lifecycle.
    assert.equal(store[QUEUE_KEY].includes('run-1'), true);
    assert.equal(store[taskKey('run-1')], '{"runId":"run-1"}');
    assert.equal(store[lockKey('run-1')], 'worker-B');
  });

  it('leaves the task re-claimable when the lock expired with no new claimant', async () => {
    const store = {
      [QUEUE_KEY]: ['run-1'],
      [taskKey('run-1')]: '{"runId":"run-1"}',
    };
    __setRedisStoreForTests(store);

    await completeDeepForecastTask('run-1', 'worker-A');

    assert.equal(store[QUEUE_KEY].includes('run-1'), true);
    assert.equal(store[taskKey('run-1')], '{"runId":"run-1"}');
    assert.equal(store[lockKey('run-1')], undefined);
  });

  it('releases its own lock but never another worker\u2019s', async () => {
    const own = { [lockKey('run-1')]: 'worker-A' };
    __setRedisStoreForTests(own);
    await releaseDeepForecastTask('run-1', 'worker-A');
    assert.equal(own[lockKey('run-1')], undefined);

    const other = { [lockKey('run-2')]: 'worker-B' };
    __setRedisStoreForTests(other);
    await releaseDeepForecastTask('run-2', 'worker-A');
    assert.equal(other[lockKey('run-2')], 'worker-B');
  });

  it('keeps legacy unconditional behavior when no workerId is passed', async () => {
    const store = {
      [QUEUE_KEY]: ['run-1'],
      [taskKey('run-1')]: '{"runId":"run-1"}',
      [lockKey('run-1')]: 'someone-else',
    };
    __setRedisStoreForTests(store);

    await completeDeepForecastTask('run-1');

    assert.equal(store[QUEUE_KEY].includes('run-1'), false);
    assert.equal(store[taskKey('run-1')], undefined);
    assert.equal(store[lockKey('run-1')], undefined);
  });

  it('fails closed when ownership changes before publication', async () => {
    const store = {
      [lockKey('run-1')]: 'worker-A',
    };
    __setRedisStoreForTests(store);
    const guard = createDeepForecastLeaseGuard('run-1', 'worker-A', {
      heartbeatIntervalMs: 60_000,
    });

    await guard.assertOwned();
    store[lockKey('run-1')] = 'worker-B';

    await assert.rejects(
      guard.assertOwned(),
      (error) => error?.code === 'DEEP_FORECAST_LEASE_LOST'
        && error?.lockStatus === 'OWNED_BY_OTHER',
    );
    await guard.stop();
  });

  it('renews the lease on the heartbeat interval and stops cleanly', { timeout: 1_000 }, async () => {
    let renewals = 0;
    let resolveFirstRenewal;
    const firstRenewal = new Promise((resolve) => {
      resolveFirstRenewal = resolve;
    });
    const guard = createDeepForecastLeaseGuard('run-1', 'worker-A', {
      heartbeatIntervalMs: 2,
      renewLease: async () => {
        renewals += 1;
        resolveFirstRenewal();
        return 'EXTENDED';
      },
    });

    await firstRenewal;
    assert.ok(renewals >= 1, `expected a timer-driven renewal, received ${renewals}`);

    await guard.stop();
    const stoppedAt = renewals;
    await new Promise((resolve) => setTimeout(resolve, 8));
    assert.equal(renewals, stoppedAt);
  });

  it('sends owner-fenced cleanup and renewal through the production EVAL contract', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
    const commands = [];
    const results = ['COMPLETED', 'DELETED', 'EXTENDED'];
    globalThis.fetch = async (_url, init = {}) => {
      commands.push(JSON.parse(String(init.body || '[]')));
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: results.shift() }),
        text: async () => '',
      };
    };

    await completeDeepForecastTask('run-1', 'worker-A');
    await releaseDeepForecastTask('run-1', 'worker-A');
    assert.equal(await renewDeepForecastTaskLease('run-1', 'worker-A'), 'EXTENDED');

    assert.deepEqual(commands.map((command) => command.slice(0, 3)), [
      ['EVAL', commands[0][1], '3'],
      ['EVAL', commands[1][1], '1'],
      ['EVAL', commands[2][1], '1'],
    ]);
    assert.deepEqual(commands[0].slice(3), [
      QUEUE_KEY,
      taskKey('run-1'),
      lockKey('run-1'),
      'worker-A',
      'run-1',
    ]);
    assert.deepEqual(commands[1].slice(3), [lockKey('run-1'), 'worker-A']);
    assert.deepEqual(commands[2].slice(3), [lockKey('run-1'), 'worker-A', '1200']);
    assert.match(commands[0][1], /ZREM/);
    assert.match(commands[1][1], /OWNED_BY_OTHER/);
    assert.match(commands[2][1], /EXPIRE/);
  });
});
