import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OUTAGE_RETRY_MIN_WAIT_MS,
  RECOVERY_GITHUB_MAX_PAGES,
  ReadOnlyGitHubClient,
  RecoveryResolutionError,
  buildRecoveryProof,
  createOperatorOperationId,
  createRecoveryEvidenceDigest,
  resolveRailwayReconcileControl,
  validateRecoveryRequest,
  verifyNoActiveRailwayDeployments,
} from '../scripts/resolve-railway-reconcile-control.mjs';
import { RailwayReconcileControlClient } from '../scripts/railway-reconcile-control-client.mjs';
import { readAllDeployments } from '../scripts/railway-cli.mjs';

const HEAD = 'a'.repeat(40);
const PRIOR_ID = 'attempt-prior-0001';
const NOW = Date.parse('2026-08-07T12:00:00.000Z');

function evidence(decision, overrides = {}) {
  const decisionEvidence = {
    resolve_pre_mutation_hold: {
      kind: 'pre_mutation_hold',
      mutationBoundaryCrossed: false,
    },
    accept_observed_convergence: {
      kind: 'observed_convergence',
      resultManifest: {
        version: 'railway-reconcile-result/v1',
        intent: {
          attemptId: PRIOR_ID,
          headSha: HEAD,
          owner: 'github-run:31181545167:2',
          producer: {
            repository: 'koala73/worldmonitor',
            workflow: 'railway-deploy-trigger.yml',
            runId: '31181545167',
            runAttempt: 2,
          },
        },
      },
    },
    authorize_current_main_retry: {
      kind: 'current_main_retry',
      providerCallsActive: false,
      retryEvidence: {
        kind: 'terminal_inactive',
        evidenceId: 'retry-audit-0001',
        auditedAt: '2026-08-07T11:58:00.000Z',
      },
    },
  }[decision];
  return {
    version: 1,
    evidenceId: 'operator-evidence-0001',
    runEvidenceId: 'github-run-evidence-0001',
    environmentEvidenceId: 'breakglass-review-evidence-0001',
    priorKind: decision === 'resolve_pre_mutation_hold' ? 'dispatch_hold' : 'attempt',
    priorCreatedAt: '2026-08-07T10:30:00.000Z',
    targetRunId: '31181545167',
    targetRunAttempt: 2,
    decisionEvidence,
    ...overrides,
  };
}

function request(decision, overrides = {}) {
  return {
    version: 1,
    decision,
    priorId: PRIOR_ID,
    expectedCurrentHead: HEAD,
    reason: 'Reviewed production evidence; proceed with the bounded recovery.',
    actor: 'operator-user',
    approver: 'independent-approver',
    triggeringActor: 'triggering-user',
    operatorRunId: '40000000001',
    operatorRunAttempt: 1,
    evidence: evidence(decision),
    ...overrides,
  };
}

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function githubClient({
  head = HEAD,
  runHead = head,
  gate = 'success',
  active = false,
  calls = [],
} = {}) {
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push(`${options.method} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname.endsWith('/git/ref/heads/main')) {
      return responseJson({ object: { sha: head } });
    }
    if (parsed.pathname.includes('/statuses')) {
      return responseJson(parsed.searchParams.get('page') === '1'
        ? [{ id: 99, context: 'gate', state: gate, updated_at: '2026-08-07T11:59:00Z' }]
        : []);
    }
    if (parsed.pathname.endsWith('/actions/workflows/railway-deploy-trigger.yml/runs')) {
      return responseJson({
        total_count: 1,
        workflow_runs: [{
          id: 31181545167,
          run_attempt: 2,
          path: '.github/workflows/railway-deploy-trigger.yml',
          event: 'workflow_dispatch',
          head_branch: 'main',
          head_sha: runHead,
          status: active ? 'in_progress' : 'completed',
          conclusion: active ? null : 'failure',
          display_title: `Railway reconciliation ${PRIOR_ID}`,
        }],
      });
    }
    if (parsed.pathname.endsWith('/actions/runs/31181545167')) {
      return responseJson({
        id: 31181545167,
        run_attempt: 2,
        path: '.github/workflows/railway-deploy-trigger.yml',
        event: 'workflow_dispatch',
        head_branch: 'main',
        head_sha: runHead,
        status: active ? 'in_progress' : 'completed',
        conclusion: active ? null : 'failure',
        display_title: `Railway reconciliation ${PRIOR_ID}`,
      });
    }
    if (/\/actions\/runs\/31181545167\/attempts\/[12]\/jobs$/.test(parsed.pathname)) {
      return responseJson({
        total_count: 1,
        jobs: [{
          id: Number(parsed.pathname.includes('/attempts/1/') ? 501 : 502),
          status: active ? 'in_progress' : 'completed',
          conclusion: active ? null : 'failure',
          name: 'Railway mutation',
          steps: [],
        }],
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  };
  return new ReadOnlyGitHubClient({
    repository: 'koala73/worldmonitor',
    token: 'read-token',
    fetchImpl,
  });
}

function resolutionEnvelope(decision, body, overrides = {}) {
  return {
    version: 1,
    ok: true,
    outcome: 'OPERATOR_RESOLUTION_RECORDED',
    data: {
      resolutionId: 'superseding-attempt-0001',
      operationId: body.operationId,
      priorId: PRIOR_ID,
      priorGeneration: 7,
      supersedingGeneration: 8,
      supersedingAttemptId: 'superseding-attempt-0001',
      headSha: HEAD,
      evidenceId: body.evidenceId,
      evidenceDigest: body.evidenceDigest,
      decision,
      ...overrides,
    },
  };
}

function controlClient(decision, calls) {
  return {
    async resolve(body) {
      calls.push(body);
      return resolutionEnvelope(decision, body);
    },
  };
}

describe('protected Railway reconciliation request validation', () => {
  it('accepts exactly the three closed decisions and rejects malformed audit evidence', () => {
    for (const decision of [
      'resolve_pre_mutation_hold',
      'accept_observed_convergence',
      'authorize_current_main_retry',
    ]) {
      assert.equal(validateRecoveryRequest(request(decision), { now: () => NOW }).decision, decision);
    }
    assert.doesNotThrow(() => validateRecoveryRequest(request(
      'authorize_current_main_retry',
      { approver: 'operator-user' },
    ), { now: () => NOW }));

    const invalid = [
      request('authorize_current_main_retry', { decision: 'clear_barrier' }),
      request('authorize_current_main_retry', { expectedCurrentHead: 'main' }),
      request('authorize_current_main_retry', { reason: 'too short' }),
      request('authorize_current_main_retry', { reason: 'unsafe\nreason text' }),
      request('authorize_current_main_retry', { actor: 'bad actor' }),
      request('authorize_current_main_retry', { reason: 'Reviewed at https://unsafe.example now.' }),
      request('authorize_current_main_retry', { reason: 'Reviewed secret: leaked-value now.' }),
      request('authorize_current_main_retry', { operatorRunId: 'run-1' }),
      request('authorize_current_main_retry', {
        evidence: { ...evidence('authorize_current_main_retry'), unexpected: true },
      }),
      request('authorize_current_main_retry', {
        evidence: { ...evidence('authorize_current_main_retry'), evidenceId: 'short' },
      }),
      request('authorize_current_main_retry', {
        evidence: { ...evidence('authorize_current_main_retry'), priorCreatedAt: '2026-08-07T10:30:00Z' },
      }),
      request('resolve_pre_mutation_hold', {
        evidence: {
          ...evidence('resolve_pre_mutation_hold'),
          decisionEvidence: { kind: 'pre_mutation_hold', mutationBoundaryCrossed: true },
        },
      }),
      request('accept_observed_convergence', {
        evidence: {
          ...evidence('accept_observed_convergence'),
          targetRunId: null,
          targetRunAttempt: null,
        },
      }),
      request('authorize_current_main_retry', {
        evidence: {
          ...evidence('authorize_current_main_retry'),
          targetRunId: null,
          targetRunAttempt: null,
        },
      }),
    ];
    for (const value of invalid) {
      assert.throws(() => validateRecoveryRequest(value, { now: () => NOW }), RecoveryResolutionError);
    }
  });

  it('enforces the decomposed 30m + 5m + 1m + 6m outage bound before a separate retry audit', () => {
    assert.equal(OUTAGE_RETRY_MIN_WAIT_MS, 42 * 60 * 1000);
    const outage = (auditedAt) => request('authorize_current_main_retry', {
      evidence: {
        ...evidence('authorize_current_main_retry'),
        decisionEvidence: {
          kind: 'current_main_retry',
          providerCallsActive: false,
          retryEvidence: {
            kind: 'outage_wait',
            evidenceId: 'separate-retry-audit-0001',
            automaticEntrantsDisabledAt: '2026-08-07T10:55:00.000Z',
            allJobsTerminatedAt: '2026-08-07T11:05:00.000Z',
            lastPossibleLeaseAcquiredAt: '2026-08-07T11:00:00.000Z',
            auditedAt,
          },
        },
      },
    });
    assert.throws(
      () => validateRecoveryRequest(outage('2026-08-07T11:41:59.999Z'), { now: () => NOW }),
      (error) => error.code === 'OUTAGE_WAIT_INSUFFICIENT',
    );
    assert.doesNotThrow(
      () => validateRecoveryRequest(outage('2026-08-07T11:42:00.000Z'), { now: () => NOW }),
    );
    const outageWithoutTarget = outage('2026-08-07T11:42:00.000Z');
    outageWithoutTarget.evidence.targetRunId = null;
    outageWithoutTarget.evidence.targetRunAttempt = null;
    assert.doesNotThrow(
      () => validateRecoveryRequest(outageWithoutTarget, { now: () => NOW }),
    );

    const invalidOrdering = outage('2026-08-07T11:42:00.000Z');
    invalidOrdering.evidence.decisionEvidence.retryEvidence.automaticEntrantsDisabledAt =
      '2026-08-07T11:06:00.000Z';
    assert.throws(
      () => validateRecoveryRequest(invalidOrdering, { now: () => NOW }),
      (error) => error.code === 'OUTAGE_EVIDENCE_ORDER_INVALID',
    );

    const duplicateEvidenceId = outage('2026-08-07T11:42:00.000Z');
    duplicateEvidenceId.evidence.decisionEvidence.retryEvidence.evidenceId =
      duplicateEvidenceId.evidence.evidenceId;
    assert.throws(
      () => validateRecoveryRequest(duplicateEvidenceId, { now: () => NOW }),
      (error) => error.code === 'RETRY_EVIDENCE_NOT_SEPARATE',
    );
  });

  it('keeps operation identity stable across workflow reruns and refreshed audit evidence', () => {
    const original = request('authorize_current_main_retry');
    const refreshed = structuredClone(original);
    refreshed.triggeringActor = 'rerun-trigger-user';
    refreshed.operatorRunId = '40000000002';
    refreshed.operatorRunAttempt = 7;
    refreshed.evidence.evidenceId = 'operator-evidence-0002';
    refreshed.evidence.runEvidenceId = 'github-run-evidence-0002';
    refreshed.evidence.environmentEvidenceId = 'breakglass-review-evidence-0002';
    refreshed.evidence.decisionEvidence.retryEvidence = {
      ...refreshed.evidence.decisionEvidence.retryEvidence,
      evidenceId: 'retry-audit-0002',
      auditedAt: '2026-08-07T11:59:00.000Z',
    };

    const operationId = createOperatorOperationId(original);
    assert.equal(createOperatorOperationId(refreshed), operationId);

    const immutableChanges = [
      { ...original, decision: 'resolve_pre_mutation_hold' },
      { ...original, priorId: 'attempt-prior-0002' },
      { ...original, expectedCurrentHead: 'b'.repeat(40) },
      { ...original, actor: 'other-operator' },
      { ...original, approver: 'other-approver' },
      { ...original, reason: 'A different reviewed recovery decision is now approved.' },
      {
        ...original,
        evidence: { ...original.evidence, targetRunAttempt: 1 },
      },
      {
        ...original,
        evidence: { ...original.evidence, priorCreatedAt: '2026-08-07T10:30:01.000Z' },
      },
    ];
    for (const changed of immutableChanges) {
      assert.notEqual(createOperatorOperationId(changed), operationId);
    }
  });
});

describe('read-only GitHub recovery proof', () => {
  it('rejects non-allowlisted methods and endpoints', async () => {
    const github = githubClient();
    await assert.rejects(
      github.request('POST', '/repos/koala73/worldmonitor/actions/workflows/railway-deploy-trigger.yml/dispatches'),
      (error) => error.code === 'GITHUB_ROUTE_FORBIDDEN',
    );
    await assert.rejects(
      github.request('GET', '/repos/koala73/worldmonitor/actions/runs/1/cancel'),
      (error) => error.code === 'GITHUB_ROUTE_FORBIDDEN',
    );
  });

  it('requires exact current green main and no matching active run or job across every attempt', async () => {
    await assert.rejects(
      buildRecoveryProof(request('resolve_pre_mutation_hold'), { githubClient: githubClient({ head: 'b'.repeat(40) }), now: () => NOW }),
      (error) => error.code === 'CURRENT_HEAD_MISMATCH',
    );
    await assert.rejects(
      buildRecoveryProof(request('resolve_pre_mutation_hold'), { githubClient: githubClient({ gate: 'failure' }), now: () => NOW }),
      (error) => error.code === 'CURRENT_GATE_NOT_GREEN',
    );
    for (const decision of ['resolve_pre_mutation_hold', 'authorize_current_main_retry']) {
      await assert.rejects(
        buildRecoveryProof(request(decision), {
          githubClient: githubClient({ active: true }),
          verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
          now: () => NOW,
        }),
        (error) => error.code === 'MATCHING_WORK_ACTIVE',
      );
    }
  });

  it('rejects self-attested pre-mutation evidence when job history may have crossed the boundary', async () => {
    for (const step of [
      { name: 'Mark Railway mutation started', conclusion: 'cancelled' },
      { name: 'Trigger lease-fenced deploys for the exact green head', conclusion: 'failure' },
      { name: 'Trigger lease-fenced deploys for the exact green head', conclusion: 'cancelled' },
    ]) {
      const github = githubClient();
      const readJobs = github.readAllAttemptJobs.bind(github);
      github.readAllAttemptJobs = async (...args) => (await readJobs(...args)).map((job) => ({
        ...job,
        steps: [step],
      }));
      await assert.rejects(
        buildRecoveryProof(request('resolve_pre_mutation_hold'), { githubClient: github, now: () => NOW }),
        (error) => error.code === 'MUTATION_BOUNDARY_NOT_PROVEN',
        JSON.stringify(step),
      );
    }
  });

  it('does not treat a successful structured mutation wrapper as boundary proof by itself', async () => {
    const github = githubClient();
    const readJobs = github.readAllAttemptJobs.bind(github);
    github.readAllAttemptJobs = async (...args) => (await readJobs(...args)).map((job) => ({
      ...job,
      steps: [{
        name: 'Trigger lease-fenced deploys for the exact green head',
        conclusion: 'success',
      }],
    }));
    const proof = await buildRecoveryProof(request('resolve_pre_mutation_hold'), {
      githubClient: github,
      now: () => NOW,
    });
    assert.equal(proof.github.attempts[0].possibleMutationBoundarySteps, 0);
  });

  it('rejects an exact run ID from another workflow or ref', async () => {
    for (const changed of [
      { path: '.github/workflows/other.yml' },
      { head_branch: 'feature/unsafe' },
    ]) {
      const github = githubClient();
      const readTargetRun = github.readTargetRun.bind(github);
      github.readTargetRun = async (...args) => ({ ...await readTargetRun(...args), ...changed });
      await assert.rejects(
        buildRecoveryProof(request('resolve_pre_mutation_hold'), {
          githubClient: github,
          now: () => NOW,
        }),
        (error) => error.code === 'TARGET_RUN_IDENTITY_MISMATCH',
        JSON.stringify(changed),
      );
    }
  });

  it('allows superseding recovery decisions to inspect an old-head incident run', async () => {
    const oldHead = 'b'.repeat(40);
    for (const decision of ['resolve_pre_mutation_hold', 'authorize_current_main_retry']) {
      const proof = await buildRecoveryProof(request(decision), {
        githubClient: githubClient({ runHead: oldHead }),
        verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
        now: () => NOW,
      });
      assert.equal(proof.github.headSha, HEAD);
      assert.equal(proof.github.matchingRuns[0].runId, '31181545167');
    }
  });

  it('accepts exact old-head convergence while separately revalidating current green main', async () => {
    const incidentHead = 'b'.repeat(40);
    const req = request('accept_observed_convergence');
    req.evidence.decisionEvidence.resultManifest.intent.headSha = incidentHead;
    const expectedHeads = [];
    const verifyConvergence = async (_manifest, expectedHead) => {
      expectedHeads.push(expectedHead);
      return {
        ok: true,
        attemptId: PRIOR_ID,
        headSha: incidentHead,
        intentDigest: 'b'.repeat(64),
        resultDigest: 'c'.repeat(64),
        acceptedDeploymentIds: [],
        strict: { ok: true },
      };
    };
    const proof = await buildRecoveryProof(req, {
      githubClient: githubClient({ runHead: incidentHead }),
      verifyConvergence,
      now: () => NOW,
    });
    const resolveCalls = [];
    await resolveRailwayReconcileControl(req, {
      proof,
      githubClient: githubClient({ runHead: incidentHead }),
      controlClient: controlClient(req.decision, resolveCalls),
      verifyConvergence,
      now: () => NOW,
    });
    assert.equal(proof.github.headSha, HEAD);
    assert.equal(proof.github.matchingRuns[0].headSha, incidentHead);
    assert.deepEqual(expectedHeads, [incidentHead, incidentHead]);
    assert.equal(resolveCalls[0].expectedHead, HEAD);
    assert.equal(resolveCalls[0].targetHead, incidentHead);
  });

  it('rejects a convergence manifest from another workflow producer', async () => {
    const req = request('accept_observed_convergence');
    req.evidence.decisionEvidence.resultManifest.intent.producer.workflow = 'other.yml';
    await assert.rejects(
      buildRecoveryProof(req, {
        githubClient: githubClient(),
        verifyConvergence: async () => ({
          ok: true,
          attemptId: PRIOR_ID,
          headSha: HEAD,
          intentDigest: 'b'.repeat(64),
          resultDigest: 'c'.repeat(64),
          acceptedDeploymentIds: [],
          strict: { ok: true },
        }),
        now: () => NOW,
      }),
      (error) => error.code === 'MANIFEST_PRODUCER_MISMATCH',
    );
  });

  it('accepts an evidence-bound historical attempt while inspecting every current attempt', async () => {
    const calls = [];
    const req = request('accept_observed_convergence');
    req.evidence.targetRunAttempt = 1;
    req.evidence.decisionEvidence.resultManifest.intent.owner = 'github-run:31181545167:1';
    req.evidence.decisionEvidence.resultManifest.intent.producer.runAttempt = 1;

    const verifyConvergence = async () => ({
      ok: true,
      attemptId: PRIOR_ID,
      headSha: HEAD,
      intentDigest: 'b'.repeat(64),
      resultDigest: 'c'.repeat(64),
      acceptedDeploymentIds: ['deployment-1'],
      strict: { ok: true },
    });
    const proof = await buildRecoveryProof(req, {
      githubClient: githubClient({ calls }),
      verifyConvergence,
      now: () => NOW,
    });

    assert.deepEqual(proof.github.attempts.map(({ runAttempt }) => runAttempt), [1, 2]);
    assert.ok(calls.some((call) => call.includes('/actions/runs/31181545167/attempts/1/jobs')));
    assert.ok(calls.some((call) => call.includes('/actions/runs/31181545167/attempts/2/jobs')));
    assert.ok(calls.some((call) => call.includes('/actions/runs/31181545167')));
    assert.ok(calls.some((call) => call.includes('status=queued')));
    assert.ok(!calls.some((call) => call.includes('/runs?created=')));

    const resolveCalls = [];
    await resolveRailwayReconcileControl(req, {
      proof,
      githubClient: githubClient(),
      controlClient: controlClient(req.decision, resolveCalls),
      verifyConvergence,
      now: () => NOW,
    });
    assert.equal(resolveCalls[0].targetRunAttempt, 1);

    const futureAttempt = request('resolve_pre_mutation_hold');
    futureAttempt.evidence.targetRunAttempt = 3;
    await assert.rejects(
      buildRecoveryProof(futureAttempt, { githubClient: githubClient(), now: () => NOW }),
      (error) => error.code === 'TARGET_RUN_ATTEMPT_MISMATCH',
    );
  });

  it('timestamps prepared proof after slow convergence while retaining the GitHub observation time', async () => {
    let clock = NOW;
    const proof = await buildRecoveryProof(request('accept_observed_convergence'), {
      githubClient: githubClient(),
      verifyConvergence: async () => {
        clock += 35 * 60 * 1000;
        return {
          ok: true,
          attemptId: PRIOR_ID,
          headSha: HEAD,
          intentDigest: 'b'.repeat(64),
          resultDigest: 'c'.repeat(64),
          acceptedDeploymentIds: ['deployment-1'],
          strict: { ok: true },
        };
      },
      now: () => clock,
    });

    assert.equal(proof.github.observedAt, new Date(NOW).toISOString());
    assert.equal(proof.preparedAt, new Date(clock).toISOString());
  });

  it('fully paginates target runs and every matching run attempt job page', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      const parsed = new URL(url);
      calls.push(`${options.method} ${parsed.pathname}${parsed.search}`);
      if (parsed.pathname.endsWith('/git/ref/heads/main')) return responseJson({ object: { sha: HEAD } });
      if (parsed.pathname.includes('/statuses')) {
        return responseJson([{ id: 99, context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
      }
      if (parsed.pathname.endsWith('/actions/workflows/railway-deploy-trigger.yml/runs')) {
        if (parsed.searchParams.has('status')) {
          return responseJson({ total_count: 0, workflow_runs: [] });
        }
        const page = Number(parsed.searchParams.get('page'));
        const workflow_runs = page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
            id: 1000 + index, run_attempt: 1, status: 'completed', conclusion: 'success', display_title: 'ordinary reconcile',
          }))
          : [{ id: 31181545167, run_attempt: 1, status: 'completed', conclusion: 'failure', display_title: PRIOR_ID }];
        return responseJson({ total_count: 101, workflow_runs });
      }
      if (parsed.pathname.endsWith('/actions/runs/31181545167/attempts/1/jobs')) {
        const page = Number(parsed.searchParams.get('page'));
        const jobs = page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
            id: 5000 + index, status: 'completed', conclusion: 'success', name: `job-${index}`, steps: [],
          }))
          : [{ id: 5100, status: 'completed', conclusion: 'failure', name: 'final verifier', steps: [] }];
        return responseJson({ total_count: 101, jobs });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };
    const github = new ReadOnlyGitHubClient({
      repository: 'koala73/worldmonitor', token: 'read-token', fetchImpl,
    });
    await buildRecoveryProof(request('resolve_pre_mutation_hold', {
      evidence: {
        ...evidence('resolve_pre_mutation_hold'),
        priorKind: 'dispatch_hold',
        targetRunId: null,
        targetRunAttempt: null,
      },
    }), { githubClient: github, now: () => NOW });
    assert.ok(calls.some((call) => call.includes('/runs?created=') && call.includes('page=2')));
    assert.ok(calls.some((call) => call.includes('/jobs?filter=all&per_page=100&page=2')));
  });

  it('bounds targetless dispatch-hold history from durable creation through observation and queries active statuses', async () => {
    const calls = [];
    const req = request('resolve_pre_mutation_hold');
    req.evidence.targetRunId = null;
    req.evidence.targetRunAttempt = null;

    await buildRecoveryProof(req, {
      githubClient: githubClient({ calls }),
      now: () => NOW,
    });

    const createdCall = calls.find((call) => call.includes('/runs?created='));
    assert.ok(createdCall);
    const createdUrl = new URL(`https://api.github.test${createdCall.slice('GET '.length)}`);
    assert.equal(
      createdUrl.searchParams.get('created'),
      '2026-08-07T10:30:00.000Z..2026-08-07T12:00:00.000Z',
    );
    assert.equal(calls.filter((call) => call.includes('status=')).length, 5);
    assert.ok(!createdUrl.searchParams.get('created').startsWith('>='));
  });

  it('bounds targetless outage history to its incident interval and queries active statuses separately', async () => {
    const calls = [];
    const req = request('authorize_current_main_retry');
    req.evidence.targetRunId = null;
    req.evidence.targetRunAttempt = null;
    req.evidence.decisionEvidence.retryEvidence = {
      kind: 'outage_wait',
      evidenceId: 'separate-retry-audit-0001',
      automaticEntrantsDisabledAt: '2026-08-07T10:55:00.000Z',
      allJobsTerminatedAt: '2026-08-07T11:05:00.000Z',
      lastPossibleLeaseAcquiredAt: '2026-08-07T11:00:00.000Z',
      auditedAt: '2026-08-07T11:42:00.000Z',
    };

    await buildRecoveryProof(req, {
      githubClient: githubClient({ calls }),
      verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
      now: () => NOW,
    });

    const createdCall = calls.find((call) => call.includes('/runs?created='));
    assert.ok(createdCall);
    const createdUrl = new URL(`https://api.github.test${createdCall.slice('GET '.length)}`);
    assert.equal(
      createdUrl.searchParams.get('created'),
      '2026-08-07T10:13:00.000Z..2026-08-07T12:00:00.000Z',
    );
    assert.equal(calls.filter((call) => call.includes('status=')).length, 5);
  });

  it('fails closed at the recovery page and request-time budgets', async () => {
    let pages = 0;
    const paged = new ReadOnlyGitHubClient({
      repository: 'koala73/worldmonitor',
      token: 'read-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/git/ref/heads/main')) {
          return responseJson({ object: { sha: HEAD } });
        }
        pages += 1;
        return responseJson(Array.from({ length: 100 }, (_, index) => ({
          id: (pages * 1000) + index,
          context: 'other',
          state: 'success',
        })));
      },
    });
    await assert.rejects(
      paged.readCurrentGreenMain(HEAD),
      (error) => error.code === 'GITHUB_EVIDENCE_BUDGET_EXCEEDED',
    );
    assert.equal(pages, RECOVERY_GITHUB_MAX_PAGES);

    const stalled = new ReadOnlyGitHubClient({
      repository: 'koala73/worldmonitor',
      token: 'read-token',
      requestTimeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    await assert.rejects(
      stalled.request('GET', '/repos/koala73/worldmonitor/git/ref/heads/main'),
      (error) => error.code === 'GITHUB_EVIDENCE_TIMEOUT',
    );
  });
});

describe('operator resolution decisions', () => {
  for (const decision of [
    'resolve_pre_mutation_hold',
    'accept_observed_convergence',
    'authorize_current_main_retry',
  ]) {
    it(`${decision} submits immutable evidence through only the operator resolution route`, async () => {
      const resolveCalls = [];
      const req = request(decision);
      const options = { githubClient: githubClient(), now: () => NOW };
      if (decision === 'accept_observed_convergence') {
        options.verifyConvergence = async () => ({
          ok: true,
          attemptId: PRIOR_ID,
          headSha: HEAD,
          intentDigest: 'b'.repeat(64),
          resultDigest: 'c'.repeat(64),
          acceptedDeploymentIds: ['deployment-1'],
          strict: { ok: true },
        });
      }
      if (decision === 'authorize_current_main_retry') {
        options.verifyProviderInactive = async () => ({ ok: true, checkedServices: 80 });
      }
      const proof = await buildRecoveryProof(req, options);
      const result = await resolveRailwayReconcileControl(req, {
        proof,
        githubClient: githubClient(),
        controlClient: controlClient(decision, resolveCalls),
        verifyConvergence: options.verifyConvergence,
        verifyProviderInactive: options.verifyProviderInactive,
        now: () => NOW,
      });

      assert.equal(resolveCalls.length, 1);
      assert.deepEqual(Object.keys(resolveCalls[0]).sort(), [
        'actor', 'approver', 'decision', 'environmentEvidenceId', 'evidenceDigest',
        'evidenceId', 'expectedHead', 'gateStatusId', 'gateUpdatedAt', 'intentDigest', 'operationId',
        'operatorRunAttempt', 'operatorRunId', 'priorCreatedAt', 'priorId', 'reason', 'runEvidenceId',
        'targetHead', 'targetRunAttempt', 'targetRunId', 'triggeringActor',
      ]);
      assert.equal(resolveCalls[0].priorId, PRIOR_ID);
      assert.equal(resolveCalls[0].priorCreatedAt, req.evidence.priorCreatedAt);
      assert.equal(resolveCalls[0].expectedHead, HEAD);
      assert.equal(resolveCalls[0].actor, 'operator-user');
      assert.equal(resolveCalls[0].approver, 'independent-approver');
      assert.notEqual(resolveCalls[0].actor, resolveCalls[0].approver);
      assert.equal(resolveCalls[0].reason, req.reason);
      assert.equal(resolveCalls[0].triggeringActor, req.triggeringActor);
      assert.equal(resolveCalls[0].operatorRunId, req.operatorRunId);
      assert.equal(resolveCalls[0].operatorRunAttempt, req.operatorRunAttempt);
      assert.equal(resolveCalls[0].evidenceId, req.evidence.evidenceId);
      assert.equal(resolveCalls[0].runEvidenceId, req.evidence.runEvidenceId);
      assert.equal(resolveCalls[0].environmentEvidenceId, req.evidence.environmentEvidenceId);
      assert.equal(resolveCalls[0].gateStatusId, '99');
      assert.equal(resolveCalls[0].gateUpdatedAt, '2026-08-07T11:59:00Z');
      assert.equal(resolveCalls[0].operationId, createOperatorOperationId(req));
      assert.equal(resolveCalls[0].targetRunId, req.evidence.targetRunId);
      assert.equal(resolveCalls[0].targetRunAttempt, req.evidence.targetRunAttempt);
      assert.equal(resolveCalls[0].targetHead, HEAD);
      assert.equal(
        resolveCalls[0].intentDigest,
        decision === 'accept_observed_convergence' ? proof.convergence.intentDigest : null,
      );
      assert.match(resolveCalls[0].evidenceDigest, /^[0-9a-f]{64}$/);
      assert.equal(
        resolveCalls[0].evidenceDigest,
        createRecoveryEvidenceDigest(req, proof, {
          github: proof.github,
          convergence: proof.convergence,
          provider: proof.provider,
        }),
      );
      assert.equal(result.evidenceDigest, resolveCalls[0].evidenceDigest);
      assert.equal(result.resolution.operationId, resolveCalls[0].operationId);
      assert.equal(result.resolution.evidenceId, resolveCalls[0].evidenceId);
      assert.equal(result.resolution.evidenceDigest, resolveCalls[0].evidenceDigest);
      assert.equal(result.dispatch !== null, decision === 'authorize_current_main_retry');
      if (result.dispatch) {
        assert.deepEqual(result.dispatch, {
          workflow: 'railway-deploy-trigger.yml',
          ref: 'main',
          expectedHead: HEAD,
          recoveryAttemptId: 'superseding-attempt-0001',
          supersedingGeneration: 8,
        });
      }
    });
  }

  it('compares refreshed GitHub proof semantically while preserving each observation timestamp', async () => {
    const req = request('authorize_current_main_retry');
    const proof = await buildRecoveryProof(req, {
      githubClient: githubClient(),
      verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
      now: () => NOW,
    });
    const resolveCalls = [];
    let clock = NOW;
    const result = await resolveRailwayReconcileControl(req, {
      proof,
      githubClient: githubClient(),
      controlClient: controlClient(req.decision, resolveCalls),
      verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
      now: () => {
        clock += 1_000;
        return clock;
      },
    });

    assert.equal(resolveCalls.length, 1);
    assert.equal(result.outcome, 'OPERATOR_RESOLUTION_RECORDED');
    assert.notEqual(proof.github.observedAt, new Date(clock).toISOString());
  });

  it('still fails closed when refreshed GitHub proof changes semantically', async () => {
    const req = request('authorize_current_main_retry');
    const proof = await buildRecoveryProof(req, {
      githubClient: githubClient(),
      verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
      now: () => NOW,
    });
    const github = githubClient();
    let mainReads = 0;
    github.readCurrentGreenMain = async () => ({
      headSha: HEAD,
      gateStatusId: mainReads++ < 2 ? '99' : '100',
      gateState: 'success',
      gateUpdatedAt: '2026-08-07T11:59:00Z',
    });

    await assert.rejects(
      resolveRailwayReconcileControl(req, {
        proof,
        githubClient: github,
        controlClient: controlClient(req.decision, []),
        verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
        now: () => NOW,
      }),
      (error) => error.code === 'GITHUB_EVIDENCE_CHANGED',
    );
  });

  it('accepts the originally committed response across a full workflow and evidence rerun', async () => {
    const original = request('resolve_pre_mutation_hold');
    const originalProof = await buildRecoveryProof(original, {
      githubClient: githubClient(),
      now: () => NOW,
    });
    let committedResponse;
    const first = await resolveRailwayReconcileControl(original, {
      proof: originalProof,
      githubClient: githubClient(),
      controlClient: {
        async resolve(body) {
          committedResponse = resolutionEnvelope(original.decision, body);
          return committedResponse;
        },
      },
      now: () => NOW,
    });

    const refreshed = structuredClone(original);
    refreshed.triggeringActor = 'rerun-trigger-user';
    refreshed.operatorRunId = '40000000002';
    refreshed.operatorRunAttempt = 2;
    refreshed.evidence.evidenceId = 'operator-evidence-0002';
    refreshed.evidence.runEvidenceId = 'github-run-evidence-0002';
    refreshed.evidence.environmentEvidenceId = 'breakglass-review-evidence-0002';
    const refreshedProof = await buildRecoveryProof(refreshed, {
      githubClient: githubClient(),
      now: () => NOW,
    });
    let refreshedBody;
    const replayed = await resolveRailwayReconcileControl(refreshed, {
      proof: refreshedProof,
      githubClient: githubClient(),
      controlClient: {
        async resolve(body) {
          refreshedBody = body;
          return structuredClone(committedResponse);
        },
      },
      now: () => NOW,
    });

    assert.equal(refreshedBody.operationId, createOperatorOperationId(original));
    assert.equal(refreshedBody.operationId, createOperatorOperationId(refreshed));
    assert.equal(refreshedBody.evidenceId, refreshed.evidence.evidenceId);
    assert.notEqual(refreshedBody.evidenceDigest, first.evidenceDigest);
    assert.equal(replayed.resolution.evidenceId, original.evidence.evidenceId);
    assert.equal(replayed.evidenceDigest, first.evidenceDigest);
    assert.equal(replayed.resolution.evidenceDigest, first.resolution.evidenceDigest);

    for (const overrides of [
      { operationId: 'e'.repeat(64) },
      { evidenceId: 'bad evidence id' },
      { evidenceDigest: 'not-a-sha256-digest' },
      { priorId: 'attempt-prior-9999' },
      { headSha: 'b'.repeat(40) },
      { decision: 'accept_observed_convergence' },
      { priorGeneration: -1 },
      { resolutionId: 'other-resolution-0001' },
      { supersedingGeneration: 9 },
    ]) {
      await assert.rejects(
        resolveRailwayReconcileControl(refreshed, {
          proof: refreshedProof,
          githubClient: githubClient(),
          controlClient: {
            async resolve(body) {
              return resolutionEnvelope(refreshed.decision, body, overrides);
            },
          },
          now: () => NOW,
        }),
        (error) => error.code === 'CONTROL_RESPONSE_INVALID',
      );
    }
  });

  it('fails closed when Railway evidence changes across environment approval', async () => {
    const req = request('authorize_current_main_retry');
    const proof = await buildRecoveryProof(req, {
      githubClient: githubClient(),
      verifyProviderInactive: async () => ({ ok: true, checkedServices: 80 }),
      now: () => NOW,
    });
    await assert.rejects(
      resolveRailwayReconcileControl(req, {
        proof,
        githubClient: githubClient(),
        controlClient: controlClient(req.decision, []),
        verifyProviderInactive: async () => ({ ok: true, checkedServices: 79 }),
        now: () => NOW,
      }),
      (error) => error.code === 'RAILWAY_EVIDENCE_CHANGED',
    );
  });

  it('sends the Worker exactly its versioned closed operator body', async () => {
    const req = request('resolve_pre_mutation_hold');
    const proof = await buildRecoveryProof(req, { githubClient: githubClient(), now: () => NOW });
    let sentBody;
    const controlClient = new RailwayReconcileControlClient({
      baseUrl: 'https://railway-reconcile-control.worldmonitor.app',
      role: 'operator',
      secret: 'operator-secret-at-least-32-bytes-0001',
      now: () => NOW,
      nonce: () => 'operator-resolution-nonce-0001',
      fetchImpl: async (_url, options) => {
        sentBody = JSON.parse(options.body);
        return responseJson({
          version: 1,
          ok: true,
          outcome: 'OPERATOR_RESOLUTION_RECORDED',
          data: {
            resolutionId: 'superseding-attempt-0001',
            operationId: sentBody.operationId,
            priorId: PRIOR_ID,
            priorGeneration: 7,
            supersedingGeneration: 8,
            supersedingAttemptId: 'superseding-attempt-0001',
            headSha: HEAD,
            evidenceId: sentBody.evidenceId,
            evidenceDigest: sentBody.evidenceDigest,
            decision: req.decision,
          },
        });
      },
    });
    await resolveRailwayReconcileControl(req, {
      proof,
      githubClient: githubClient(),
      controlClient,
      now: () => NOW,
    });
    assert.deepEqual(Object.keys(sentBody).sort(), [
      'actor', 'approver', 'decision', 'environmentEvidenceId', 'evidenceDigest',
      'evidenceId', 'expectedHead', 'gateStatusId', 'gateUpdatedAt', 'intentDigest', 'operationId',
      'operatorRunAttempt', 'operatorRunId', 'priorCreatedAt', 'priorId', 'reason', 'runEvidenceId',
      'targetHead', 'targetRunAttempt', 'targetRunId', 'triggeringActor', 'version',
    ]);
    assert.equal(sentBody.version, 1);
    assert.match(sentBody.evidenceDigest, /^[0-9a-f]{64}$/);
  });
});

describe('read-only Railway provider inactivity proof', () => {
  it('reads up to the CLI maximum for every service with bounded concurrency and positive exhaustion', async () => {
    const services = Array.from({ length: 17 }, (_, index) => ({ name: `seed-${index + 1}` }));
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const proof = await verifyNoActiveRailwayDeployments({
      environment: 'production',
      readRepositoryServicesImpl(environment) {
        assert.equal(environment, 'production');
        return services;
      },
      async readDeploymentsImpl(service, environment, limit) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push({ service, environment, limit });
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return [{ id: `deployment-${service.name}`, status: 'SUCCESS' }];
      },
    });

    assert.deepEqual(proof, { ok: true, checkedServices: 17 });
    assert.equal(calls.length, 34, 'the complete scan is followed by a final fleet sweep');
    assert.ok(calls.every(({ environment, limit }) => environment === 'production' && limit === 1000));
    assert.equal(maxActive, 8);
  });

  it('shares one monotonic deadline with bounded and complete-history reads', async () => {
    const service = { id: 'service-full', name: 'seed-full-history' };
    const boundedOptions = [];
    let boundedCalls = 0;
    let completeOptions;
    const monotonicNow = () => 1_000;
    const proof = await verifyNoActiveRailwayDeployments({
      deadline: 6_000,
      monotonicNow,
      readRepositoryServicesImpl: () => [service],
      readDeploymentsImpl: async (_service, _environment, _limit, options) => {
        boundedOptions.push(options);
        boundedCalls += 1;
        return boundedCalls === 1
          ? Array.from({ length: 1000 }, (_, index) => ({ id: `deployment-${index}`, status: 'SUCCESS' }))
          : [{ id: 'deployment-final', status: 'SUCCESS' }];
      },
      resolveEnvironmentIdImpl: () => 'environment-1',
      readAllDeploymentsImpl: async (_service, _environmentId, options) => {
        completeOptions = options;
        return [{ id: 'deployment-complete', status: 'SUCCESS' }];
      },
    });

    assert.deepEqual(proof, { ok: true, checkedServices: 1 });
    assert.deepEqual(boundedOptions, [{ timeoutMs: 5000 }, { timeoutMs: 5000 }]);
    assert.equal(completeOptions.deadline, 6000);
    assert.equal(completeOptions.now, monotonicNow);
  });

  it('returns page-deadline exhaustion as incomplete provider evidence', async () => {
    const service = { id: 'service-full', name: 'seed-full-history' };
    let clock = 0;
    await assert.rejects(
      verifyNoActiveRailwayDeployments({
        deadline: 10,
        monotonicNow: () => clock,
        readRepositoryServicesImpl: () => [service],
        readDeploymentsImpl: async () => Array.from(
          { length: 1000 },
          (_, index) => ({ id: `deployment-${index}`, status: 'SUCCESS' }),
        ),
        resolveEnvironmentIdImpl: () => 'environment-1',
        readAllDeploymentsImpl: (observedService, environmentId, options) => readAllDeployments(
          observedService,
          environmentId,
          {
            ...options,
            api: async () => {
              clock = 10;
              return {
                deployments: {
                  edges: [],
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                },
              };
            },
          },
        ),
      }),
      (error) => error.code === 'PROVIDER_EVIDENCE_INCOMPLETE'
        && error.cause?.message.includes('deadline expired before page 2'),
    );
  });

  it('fails closed for REMOVING and unknown statuses in bounded histories', async () => {
    for (const status of ['REMOVING', 'PROVIDER_ADDED_A_NEW_STATUS']) {
      await assert.rejects(
        verifyNoActiveRailwayDeployments({
          readRepositoryServicesImpl: () => [{ id: 'service-1', name: 'seed-one' }],
          readDeploymentsImpl: async () => [{ id: 'deployment-1', status }],
        }),
        (error) => error.code === 'PROVIDER_ACTIVITY_NOT_CLEARED',
        status,
      );
    }
  });

  it('fails closed for REMOVING and unknown statuses in paginated histories', async () => {
    for (const status of ['REMOVING', 'PROVIDER_ADDED_A_NEW_STATUS']) {
      await assert.rejects(
        verifyNoActiveRailwayDeployments({
          readRepositoryServicesImpl: () => [{ id: 'service-1', name: 'seed-one' }],
          readDeploymentsImpl: async () => Array.from(
            { length: 1000 },
            (_, index) => ({ id: `deployment-${index}`, status: 'SUCCESS' }),
          ),
          resolveEnvironmentIdImpl: () => 'environment-1',
          readAllDeploymentsImpl: async () => [{ id: 'deployment-complete', status }],
        }),
        (error) => error.code === 'PROVIDER_ACTIVITY_NOT_CLEARED',
        status,
      );
    }
  });

  it('rejects active work that appears only in the final fleet sweep', async () => {
    let calls = 0;
    await assert.rejects(
      verifyNoActiveRailwayDeployments({
        readRepositoryServicesImpl: () => [{ id: 'service-1', name: 'seed-one' }],
        readDeploymentsImpl: async () => {
          calls += 1;
          return [{
            id: calls === 1 ? 'deployment-initial' : 'deployment-inserted',
            status: calls === 1 ? 'SUCCESS' : 'BUILDING',
          }];
        },
      }),
      (error) => error.code === 'PROVIDER_ACTIVITY_NOT_CLEARED',
    );
    assert.equal(calls, 2);
  });

  it('pages a full CLI window to positive exhaustion and checks older active work', async () => {
    const service = { id: 'service-full', name: 'seed-full-history' };
    const complete = Array.from(
      { length: 1001 },
      (_, index) => ({ id: `deployment-${index}`, status: index === 1000 ? 'BUILDING' : 'SUCCESS' }),
    );
    await assert.rejects(
      verifyNoActiveRailwayDeployments({
        readRepositoryServicesImpl: () => [service],
        readDeploymentsImpl: async () => complete.slice(0, 1000),
        resolveEnvironmentIdImpl(environment) {
          assert.equal(environment, 'production');
          return 'environment-1';
        },
        readAllDeploymentsImpl(observedService, environmentId) {
          assert.equal(observedService, service);
          assert.equal(environmentId, 'environment-1');
          return complete;
        },
      }),
      (error) => error.code === 'PROVIDER_ACTIVITY_NOT_CLEARED',
    );
  });

  it('accepts a complete paginated history with no active provider work', async () => {
    const complete = Array.from(
      { length: 1001 },
      (_, index) => ({ id: `deployment-${index}`, status: 'SUCCESS' }),
    );
    const proof = await verifyNoActiveRailwayDeployments({
      readRepositoryServicesImpl: () => [{ id: 'service-full', name: 'seed-full-history' }],
      readDeploymentsImpl: async () => complete.slice(0, 1000),
      resolveEnvironmentIdImpl: () => 'environment-1',
      readAllDeploymentsImpl: async () => complete,
    });

    assert.deepEqual(proof, { ok: true, checkedServices: 1 });
  });

  it('fails closed when complete history paging cannot prove exhaustion', async () => {
    await assert.rejects(
      verifyNoActiveRailwayDeployments({
        readRepositoryServicesImpl: () => [{ id: 'service-full', name: 'seed-full-history' }],
        readDeploymentsImpl: async () => Array.from(
          { length: 1000 },
          (_, index) => ({ id: `deployment-${index}`, status: 'SUCCESS' }),
        ),
        resolveEnvironmentIdImpl: () => 'environment-1',
        readAllDeploymentsImpl: async () => {
          throw new Error('page budget exhausted');
        },
      }),
      (error) => error.code === 'PROVIDER_EVIDENCE_INCOMPLETE',
    );
  });
});
