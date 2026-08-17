import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPANY_MONITORING_CLASSIFIER_RUNTIME_APPROVED,
  COMPANY_MONITORING_CONVEX_TIMEOUT_MS,
  COMPANY_MONITORING_FINALIZE_TRANSPORT_BUFFER_MS,
  COMPANY_MONITORING_WORKER_ACTIVATION_KEY,
  COMPANY_MONITORING_WORKER_HEALTH_KEY,
  COMPANY_MONITORING_WORKER_META_KEY,
  createApprovedCompanyMonitoringAdmissionClassifier,
  createCompanyMonitoringAdmissionClassifier,
  createCompanyMonitoringExecutor,
  createCompanyMonitoringWorker,
  createConvexFetch,
  createRedisHealthPublisher,
} from '../scripts/company-monitoring-worker.mjs';
import {
  COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS,
  createXRecentSearchExecutor,
} from '../scripts/lib/company-monitoring-x-provider.mjs';

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

describe('company-monitoring classifier rollout gate', () => {
  it('keeps complete provisioned classifier configuration inert while Stage 0 is stopped', () => {
    assert.equal(COMPANY_MONITORING_CLASSIFIER_RUNTIME_APPROVED, false);
    assert.equal(createApprovedCompanyMonitoringAdmissionClassifier({
      apiKey: 'provisioned-key',
      model: 'provider/classifier-v1',
      providerRoute: 'pinned-route',
      expectedResolvedProvider: 'Pinned Provider',
    }), undefined);
  });
});

const ADMISSION_CLAIM = {
  status: 'claimed',
  leaseToken: 'admission-lease-1',
  leaseExpiresAt: 1_700_000_300_000,
  expectedEvidenceRevision: 3,
  candidate: {
    ownerAccountId: 'account-private',
    companyId: 'company-private',
    candidateId: 'candidate-1',
    occurrenceDedupeKey: 'occurrence-1',
    firstDiscoveredAt: 1_700_000_000_000,
    attemptCount: 1,
    expiresAt: 1_700_259_200_000,
    referenceEvidenceFingerprints: ['evidence-1'],
    referencesTruncated: false,
    selectionPolicyVersion: 'selection-v1',
  },
  evidence: [{
    ownerAccountId: 'account-private',
    companyId: 'company-private',
    occurrenceDedupeKey: 'occurrence-1',
    evidenceFingerprint: 'evidence-1',
    provider: 'exa',
    providerLocator: 'https://example.com/story',
    providerOriginFingerprint: 'origin-1',
    sourceAuthority: 'independent_source',
    independence: 'independent',
    queryVersion: 'exa-company-discovery-v1',
    title: 'Company signs material contract',
    text: 'The company signed a material customer contract.',
    publishedAt: 1_700_000_000_000,
    observedAt: 1_700_000_060_000,
  }],
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
  it('reserves enough provider lease time for Convex finalize transport and serialization', () => {
    assert.ok(
      COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS >=
        COMPANY_MONITORING_CONVEX_TIMEOUT_MS + COMPANY_MONITORING_FINALIZE_TRANSPORT_BUFFER_MS,
    );
  });

  it('routes only X to the installed adapter and keeps Exa outside this slice', async () => {
    const execute = createCompanyMonitoringExecutor({
      xExecutor: createXRecentSearchExecutor({ bearerToken: '' }),
    });
    assert.deepEqual(await execute({ source: 'x' }), {
      type: 'provider_error',
      reason: 'authentication_failed',
      costUsdMicros: 0,
    });
    assert.deepEqual(await execute({ source: 'exa' }), {
      type: 'provider_error',
      reason: 'provider_unavailable',
      costUsdMicros: 0,
    });
  });

  it('routes Exa and X through their independent installed adapters', async () => {
    const execute = createCompanyMonitoringExecutor({
      exaExecutor: async () => ({ provider: 'exa' }),
      xExecutor: async () => ({ provider: 'x' }),
    });

    assert.deepEqual(await execute({ source: 'exa' }), { provider: 'exa' });
    assert.deepEqual(await execute({ source: 'x' }), { provider: 'x' });
  });

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

  it('claims one exact admission snapshot and finalizes its untrusted model output', async () => {
    const calls = [];
    const rawModelOutput = '{"untrusted":"classification"}';
    const worker = createCompanyMonitoringWorker({
      client: convexClient([
        ADMISSION_CLAIM,
        { status: 'recorded', decision: 'hold' },
      ], calls),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeAdmission: async (input) => {
        assert.equal(input.candidate, ADMISSION_CLAIM.candidate);
        assert.equal(input.evidence, ADMISSION_CLAIM.evidence);
        return {
          requestedModelVersion: 'provider/classifier-v1',
          modelVersion: 'provider/classifier-v1',
          modelOutput: rawModelOutput,
        };
      },
      admissionModelVersion: 'provider/classifier-v1',
      classificationRunId: () => 'classification-run-1',
      publishHealth: async () => true,
    });

    assert.equal(await worker.admissionTick(), 'recorded');
    assert.deepEqual(calls[0], {
      secret: 'worker-secret',
      workerId: 'worker-a',
      classificationRunId: 'classification-run-1',
      requestedModelVersion: 'provider/classifier-v1',
    });
    assert.deepEqual(calls[1], {
      secret: 'worker-secret',
      workerId: 'worker-a',
      leaseToken: 'admission-lease-1',
      ownerAccountId: 'account-private',
      companyId: 'company-private',
      occurrenceDedupeKey: 'occurrence-1',
      expectedEvidenceRevision: 3,
      classificationRunId: 'classification-run-1',
      modelVersion: 'provider/classifier-v1',
      requestedModelVersion: 'provider/classifier-v1',
      modelOutput: rawModelOutput,
    });
  });

  it('finalizes classifier transport failure as a durable hold and publishes admission health', async () => {
    const calls = [];
    const health = [];
    const worker = createCompanyMonitoringWorker({
      client: convexClient([
        { status: 'idle' },
        ADMISSION_CLAIM,
        { status: 'recorded', decision: 'hold' },
      ], calls),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeAdmission: async () => { throw new Error('provider unavailable'); },
      admissionModelVersion: 'provider/classifier-v1',
      classificationRunId: () => 'classification-run-transport-1',
      publishHealth: async (payload) => { health.push(payload); },
    });

    assert.equal(await worker.tick(), 'idle');
    assert.equal(health.at(-1).status, 'ok');
    assert.equal(await worker.admissionTick(), 'provider_error');
    assert.equal(calls.length, 3, 'provider failure must finalize its leased candidate');
    assert.deepEqual(calls[2], {
      secret: 'worker-secret',
      workerId: 'worker-a',
      leaseToken: 'admission-lease-1',
      ownerAccountId: 'account-private',
      companyId: 'company-private',
      occurrenceDedupeKey: 'occurrence-1',
      expectedEvidenceRevision: 3,
      classificationRunId: 'classification-run-transport-1',
      requestedModelVersion: 'provider/classifier-v1',
    });
    assert.equal(health.at(-1).status, 'error');
    assert.equal(health.at(-1).outcome, 'admission_transport_failure');
    assert.equal(health.at(-1).counters.admissionClaims, 1);
    assert.equal(health.at(-1).counters.admissionRecorded, 1);
    assert.equal(health.at(-1).counters.admissionTransportFailures, 1);
  });

  it('publishes admission claim and finalize failures through bounded counters', async () => {
    const claimHealth = [];
    const claimWorker = createCompanyMonitoringWorker({
      client: convexClient([new Error('claim unavailable')]),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeAdmission: async () => ({
        requestedModelVersion: 'provider/classifier-v1',
        modelVersion: 'provider/classifier-v1',
        modelOutput: '{}',
      }),
      admissionModelVersion: 'provider/classifier-v1',
      publishHealth: async (payload) => { claimHealth.push(payload); },
    });
    assert.equal(await claimWorker.admissionTick(), 'claim_error');
    assert.equal(claimHealth.at(-1).outcome, 'admission_claim_error');
    assert.equal(claimHealth.at(-1).counters.admissionClaimErrors, 1);

    const finalizeHealth = [];
    const finalizeWorker = createCompanyMonitoringWorker({
      client: convexClient([ADMISSION_CLAIM, new Error('finalize unavailable')]),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeAdmission: async () => ({
        requestedModelVersion: 'provider/classifier-v1',
        modelVersion: 'provider/classifier-v1',
        modelOutput: '{}',
      }),
      admissionModelVersion: 'provider/classifier-v1',
      classificationRunId: () => 'classification-run-finalize-error',
      publishHealth: async (payload) => { finalizeHealth.push(payload); },
    });
    assert.equal(await finalizeWorker.admissionTick(), 'finalize_error');
    assert.equal(finalizeHealth.at(-1).outcome, 'admission_finalize_error');
    assert.equal(finalizeHealth.at(-1).counters.admissionClaims, 1);
    assert.equal(finalizeHealth.at(-1).counters.admissionFinalizeErrors, 1);
  });

  it('does not claim admission work when classification is not configured', async () => {
    const calls = [];
    const worker = createCompanyMonitoringWorker({
      client: convexClient([], calls),
      secret: 'worker-secret',
      workerId: 'worker-a',
      publishHealth: async () => true,
    });

    assert.equal(await worker.admissionTick(), 'disabled');
    assert.equal(calls.length, 0);
  });

  it('uses the configured classifier model and returns raw transport content', async () => {
    let capturedBody;
    const executeAdmission = createCompanyMonitoringAdmissionClassifier({
      apiKey: 'openrouter-test-key',
      model: 'provider/classifier-v1',
      providerRoute: 'pinned-route',
      expectedResolvedProvider: 'Pinned Provider',
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          id: 'gen-company-monitoring-worker-1',
          model: 'provider/classifier-v1',
          provider: 'Pinned Provider',
          usage: { cost: 0.001 },
          openrouter_metadata: {
            requested: 'provider/classifier-v1',
            strategy: 'direct',
            attempt: 1,
            endpoints: {
              total: 1,
              available: [{
                provider: 'Pinned Provider',
                model: 'provider/classifier-v1',
                selected: true,
              }],
            },
            attempts: [{
              provider: 'Pinned Provider',
              model: 'provider/classifier-v1',
              status: 200,
            }],
            pipeline: [],
          },
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'not-json' },
          }],
        }), { status: 200 });
      },
    });

    assert.deepEqual(await executeAdmission({
      candidate: ADMISSION_CLAIM.candidate,
      evidence: ADMISSION_CLAIM.evidence,
    }), {
      requestedModelVersion: 'provider/classifier-v1@pinned-route#Pinned Provider',
      modelVersion: 'provider/classifier-v1@pinned-route#Pinned Provider',
      modelOutput: 'not-json',
    });
    assert.equal(capturedBody.model, 'provider/classifier-v1');
    assert.deepEqual(capturedBody.provider.only, ['pinned-route']);
    assert.equal('tools' in capturedBody, false);
  });

  it('keeps an admission finalize error visible across the next healthy scan heartbeat', async () => {
    const health = [];
    let classifierCalls = 0;
    const worker = createCompanyMonitoringWorker({
      client: convexClient([
        ADMISSION_CLAIM,
        new Error('finalize response unavailable'),
        { status: 'idle' },
        ADMISSION_CLAIM,
        { status: 'recorded', decision: 'publish' },
      ]),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeAdmission: async () => {
        classifierCalls += 1;
        return {
          requestedModelVersion: 'provider/classifier-v1',
          modelVersion: 'provider/classifier-v1',
          modelOutput: '{}',
        };
      },
      admissionModelVersion: 'provider/classifier-v1',
      classificationRunId: () => 'classification-run-sticky-error',
      publishHealth: async (payload) => { health.push(payload); },
    });

    assert.equal(await worker.admissionTick(), 'finalize_error');
    assert.equal(classifierCalls, 1);
    assert.equal(health.at(-1).outcome, 'admission_finalize_error');
    assert.deepEqual(health.at(-1).subsystems.admission, {
      status: 'error',
      outcome: 'admission_finalize_error',
    });

    assert.equal(await worker.tick(), 'idle');
    assert.equal(classifierCalls, 1, 'a scan heartbeat must not invoke the classifier');
    assert.equal(health.at(-1).status, 'error');
    assert.equal(health.at(-1).outcome, 'admission_finalize_error');
    assert.deepEqual(health.at(-1).subsystems.scan, { status: 'ok', outcome: 'idle' });
    assert.deepEqual(health.at(-1).subsystems.admission, {
      status: 'error',
      outcome: 'admission_finalize_error',
    });

    assert.equal(await worker.admissionTick(), 'recorded');
    assert.equal(classifierCalls, 2);
    assert.equal(health.at(-1).status, 'ok');
    assert.equal(health.at(-1).outcome, 'admission_recorded');
    assert.deepEqual(health.at(-1).subsystems.admission, {
      status: 'ok',
      outcome: 'admission_recorded',
    });
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

  it('routes Exa work through the adapter and finalizes only its closed receipt projection', async () => {
    const calls = [];
    const reports = [];
    const executeClaim = createCompanyMonitoringExecutor({
      exaExecutor: async (work) => {
        reports.push({ workId: work.workId, providerRows: 2 });
        return { finalizeResult: COMPLETE_RESULT, report: reports.at(-1) };
      },
    });
    const worker = createCompanyMonitoringWorker({
      client: convexClient([
        CLAIM,
        { status: 'completed', reason: 'complete', receipt: {} },
      ], calls),
      secret: 'worker-secret',
      workerId: 'worker-a',
      executeClaim,
      publishHealth: async () => true,
    });

    assert.equal(await worker.tick(), 'completed');
    assert.deepEqual(reports, [{ workId: 'work-1', providerRows: 2 }]);
    assert.deepEqual(calls[1].result, COMPLETE_RESULT);
    assert.equal('report' in calls[1].result, false);
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
      activeSubsystem: 'scan',
      subsystems: {
        scan: { status: 'ok', outcome: 'idle' },
        admission: { status: 'ok', outcome: 'disabled' },
      },
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
    assert.deepEqual(canonical.subsystems, meta.subsystems);
    assert.deepEqual(canonical.subsystems, {
      scan: { status: 'ok', outcome: 'idle' },
      admission: { status: 'ok', outcome: 'disabled' },
    });
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
        activeSubsystem: 'scan',
        subsystems: {
          scan: { status: outcome === 'claim_error' ? 'error' : 'ok', outcome },
          admission: { status: 'ok', outcome: 'disabled' },
        },
        counters: { loops: 1, claims: 0, completed: 0, nonReassuring: 0, fenced: 0, replayed: 0, executorErrors: 0, claimErrors: 1, finalizeErrors: 0 },
      }), true);
    }

    for (const body of bodies) {
      assert.equal(body.some((command) => command[1] === COMPANY_MONITORING_WORKER_ACTIVATION_KEY), false);
    }
  });
});
