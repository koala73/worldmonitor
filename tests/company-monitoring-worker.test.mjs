import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPANY_MONITORING_WORKER_ACTIVATION_KEY,
  COMPANY_MONITORING_WORKER_HEALTH_KEY,
  COMPANY_MONITORING_WORKER_META_KEY,
  createCompanyMonitoringWorker,
  createConvexFetch,
  createRedisHealthPublisher,
} from '../scripts/company-monitoring-worker.mjs';

const CLAIM = {
  status: 'claimed',
  work: {
    ownerAccountId: 'account-private',
    workId: 'work-1',
    cohortKey: 'cohort-private',
    source: 'exa',
    windowStart: 100,
    windowEnd: 200,
    queryVersion: 1,
    resultCap: 50,
    attempt: 1,
    leaseToken: 'lease-1',
    leaseExpiresAt: 500,
    obligations: [{ companyId: 'company-private' }],
  },
};

const COMPLETE_RESULT = {
  type: 'result',
  returnedRange: { startAt: 100, endAt: 200 },
  itemCount: 1,
  hasMore: false,
  coverage: 'complete',
  emptyValidated: false,
  checkpoint: 'checkpoint-1',
  costUsdMicros: 12,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function convexClient(responses, calls = []) {
  return {
    async mutation(_fn, args) {
      calls.push(args);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(args) : next;
    },
  };
}

describe('company monitoring Railway worker', () => {
  it('bounds Convex requests and identifies the server-side worker', async () => {
    let captured;
    const guardedFetch = createConvexFetch(async (_input, init) => {
      captured = init;
      return new Response('{}', { status: 200 });
    });

    await guardedFetch('https://convex.example/api/mutation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.equal(captured.headers.get('User-Agent'), 'worldmonitor-company-monitoring-worker/1.0');
    assert.ok(captured.signal instanceof AbortSignal);
  });

  it('claims without accepting a tenant target and continues when Redis health is down', async () => {
    const calls = [];
    const client = convexClient([
      CLAIM,
      { status: 'completed', reason: 'complete', receipt: {} },
    ], calls);
    const worker = createCompanyMonitoringWorker({
      client,
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeClaim: async () => COMPLETE_RESULT,
      publishHealth: async () => { throw new Error('redis unavailable'); },
    });

    const outcome = await worker.tick();

    assert.equal(outcome, 'completed');
    assert.deepEqual(calls[0], { secret: 'worker-secret', workerId: 'worker-a' });
    assert.deepEqual(calls[1], {
      secret: 'worker-secret',
      workerId: 'worker-a',
      workId: 'work-1',
      leaseToken: 'lease-1',
      result: COMPLETE_RESULT,
    });
    assert.equal('accountId' in calls[0], false);
    assert.equal('companyId' in calls[0], false);
    assert.equal('portfolioId' in calls[0], false);
  });

  it('fails closed with provider_unavailable when no provider adapter is installed', async () => {
    const calls = [];
    const health = [];
    const client = convexClient([
      CLAIM,
      { status: 'non_reassuring', reason: 'provider_error', receipt: {} },
    ], calls);
    const worker = createCompanyMonitoringWorker({
      client,
      secret: 'worker-secret',
      workerId: 'worker-a',
      publishHealth: async (payload) => { health.push(payload); },
    });

    assert.equal(await worker.tick(), 'non_reassuring');
    assert.deepEqual(calls[1].result, {
      type: 'provider_error',
      reason: 'provider_unavailable',
      costUsdMicros: 0,
    });
    assert.equal(health.at(-1).status, 'error');
    assert.equal(health.at(-1).outcome, 'non_reassuring');
  });

  it('leaves a fetched result unfinalized on a hard crash and safely finalizes the replayed work', async () => {
    const firstCalls = [];
    const firstWorker = createCompanyMonitoringWorker({
      client: convexClient([CLAIM], firstCalls),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeClaim: async () => COMPLETE_RESULT,
      afterExecute: async () => { throw new Error('simulated process crash'); },
      publishHealth: async () => true,
    });

    await assert.rejects(firstWorker.tick(), /simulated process crash/);
    assert.equal(firstCalls.length, 1, 'the crashing attempt must not finalize');

    const replayCalls = [];
    const replayClaim = {
      ...CLAIM,
      work: { ...CLAIM.work, attempt: 2, leaseToken: 'lease-2', leaseExpiresAt: 900 },
    };
    const replayWorker = createCompanyMonitoringWorker({
      client: convexClient([
        replayClaim,
        { status: 'completed', reason: 'complete', receipt: {} },
      ], replayCalls),
      secret: 'worker-secret',
      workerId: 'worker-b',
      executeClaim: async () => COMPLETE_RESULT,
      publishHealth: async () => true,
    });

    assert.equal(await replayWorker.tick(), 'completed');
    assert.equal(replayCalls[1].leaseToken, 'lease-2');
    assert.equal(replayCalls[1].workerId, 'worker-b');
  });

  it('accepts a fenced finalize as authoritative and does not retry it', async () => {
    const calls = [];
    const health = [];
    const worker = createCompanyMonitoringWorker({
      client: convexClient([CLAIM, { status: 'fenced' }], calls),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeClaim: async () => COMPLETE_RESULT,
      publishHealth: async (payload) => { health.push(payload); },
    });

    assert.equal(await worker.tick(), 'fenced');
    assert.equal(calls.length, 2);
    assert.equal(health.at(-1).status, 'error');
    assert.equal(health.at(-1).outcome, 'fenced');
    assert.equal(health.at(-1).counters.fenced, 1);
  });

  it('stops new claims on SIGTERM intent and lets the current finalize finish', async () => {
    const calls = [];
    const started = deferred();
    const release = deferred();
    const client = convexClient([
      CLAIM,
      { status: 'completed', reason: 'complete', receipt: {} },
    ], calls);
    const worker = createCompanyMonitoringWorker({
      client,
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeClaim: async () => {
        started.resolve();
        await release.promise;
        return COMPLETE_RESULT;
      },
      publishHealth: async () => true,
    });

    const running = worker.run();
    await started.promise;
    worker.requestStop('SIGTERM');
    release.resolve();
    await running;

    assert.equal(calls.length, 2, 'one claim and its finalize; no second claim');
    assert.equal(worker.snapshot().stopping, true);
  });

  it('cancels the pending poll timer on SIGTERM instead of delaying shutdown', async () => {
    const published = deferred();
    const client = convexClient([{ status: 'idle' }]);
    const worker = createCompanyMonitoringWorker({
      client,
      secret: 'worker-secret',
      workerId: 'worker-a',
      pollIntervalMs: 60_000,
      publishHealth: async () => { published.resolve(); },
    });

    const running = worker.run();
    await published.promise;
    worker.requestStop('SIGTERM');
    await running;

    assert.equal(worker.snapshot().stopping, true);
  });
});

describe('company monitoring worker health projection', () => {
  it('writes bounded matching canonical/meta payloads and a no-TTL activation marker', async () => {
    const requests = [];
    const publisher = createRedisHealthPublisher({
      env: {
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'redis-token',
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => [{ result: 'OK' }, { result: 'OK' }, { result: 'OK' }] };
      },
      now: () => 1_800_000_000_000,
    });

    const ok = await publisher({
      status: 'ok',
      outcome: 'idle',
      counters: { loops: 1, claims: 0, completed: 0, nonReassuring: 0, fenced: 0, replayed: 0, executorErrors: 0, claimErrors: 0, finalizeErrors: 0 },
    });

    assert.equal(ok, true);
    const commands = JSON.parse(requests[0].init.body);
    assert.equal(commands[0][1], COMPANY_MONITORING_WORKER_HEALTH_KEY);
    assert.equal(commands[1][1], COMPANY_MONITORING_WORKER_META_KEY);
    assert.deepEqual(commands[2].slice(0, 2), ['SET', COMPANY_MONITORING_WORKER_ACTIVATION_KEY]);
    assert.equal(commands[2].at(-1), 'NX');
    assert.equal(commands[2].includes('EX'), false, 'activation marker must have no TTL');
    const canonical = JSON.parse(commands[0][2]);
    const meta = JSON.parse(commands[1][2]);
    assert.equal(canonical.status, meta.status);
    assert.equal(canonical.outcome, meta.outcome);
    assert.deepEqual(canonical.counters, meta.counters);
    assert.equal(JSON.stringify(canonical).includes('worker-secret'), false);
    assert.equal(JSON.stringify(canonical).includes('account-private'), false);
  });

  it('does not write an activation marker for unhealthy control-loop results', async () => {
    const bodies = [];
    const publisher = createRedisHealthPublisher({
      env: {
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'redis-token',
      },
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => [{ result: 'OK' }, { result: 'OK' }] };
      },
      now: () => 1_800_000_000_000,
    });

    for (const outcome of ['claim_error', 'non_reassuring', 'fenced']) {
      assert.equal(await publisher({
        status: outcome === 'claim_error' ? 'error' : 'ok',
        outcome,
        counters: { loops: 1, claims: 0, completed: 0, nonReassuring: 0, fenced: 0, replayed: 0, executorErrors: 0, claimErrors: 1, finalizeErrors: 0 },
      }), true);
    }

    for (const body of bodies) {
      assert.equal(body.some((command) => command[1] === COMPANY_MONITORING_WORKER_ACTIVATION_KEY), false);
    }
  });
});
