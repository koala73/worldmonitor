import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTED_FRESHNESS_MS,
  FINAL_ACCEPTANCE_STEP_NAME,
  GITHUB_API_VERSION,
  GITHUB_PAGE_SIZE,
  GITHUB_WATCHDOG_USER_AGENT,
  GitHubWatchdogClient,
  GitHubWatchdogError,
  GITHUB_DISPATCH_REJECTION_STEP_NAME,
  MANUAL_RECOVERY_DISPATCH_JOB_NAME,
  MANUAL_RECOVERY_DISPATCH_STEP_NAME,
  MANUAL_REQUIRED_STEP_NAME,
  MUTATION_STARTED_STEP_NAME,
  PRE_MUTATION_ACTIVE_MS,
  PRE_DISPATCH_REJECTION_STEP_NAME,
  WATCHDOG_DISPATCH_JOB_NAME,
  WATCHDOG_DISPATCH_STEP_NAME,
  WATCHDOG_HISTORY_WINDOW_MS,
  WATCHDOG_JOB_READ_CONCURRENCY,
  WATCHDOG_MAX_PAGES,
  WATCHDOG_READ_FAILURE_STEP_NAME,
  WATCHDOG_READ_RETRY_ATTEMPTS,
  WATCHDOG_READ_RETRY_BASE_MS,
  WATCHDOG_READ_RETRY_MAX_MS,
  WATCHDOG_SOURCE_WORKFLOW_FILE,
  classifyWatchdogSnapshot,
  dispatchGitHubRecovery,
  prepareRecoveryDispatch,
  readWatchdogSnapshot,
  rejectAuthorizedRecovery,
  resolveReadFailureExit,
  retryAttemptsFor,
} from '../scripts/dispatch-stale-railway-reconcile.mjs';

const NOW = Date.parse('2026-08-07T12:00:00Z');
const HEAD = 'a'.repeat(40);
const SCRIPT = fileURLToPath(new URL('../scripts/dispatch-stale-railway-reconcile.mjs', import.meta.url));

function acceptedRun({ minutesAgo = 10 } = {}) {
  return {
    id: 101,
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    createdAt: new Date(NOW - (minutesAgo + 5) * 60_000).toISOString(),
    updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    attempts: [{
      attempt: 1,
      jobs: [{ steps: [{ name: FINAL_ACCEPTANCE_STEP_NAME, conclusion: 'success' }] }],
    }],
  };
}

function activeRun({
  id = 202,
  minutesAgo = 5,
  headSha = HEAD,
  stepName = null,
  status = 'in_progress',
} = {}) {
  return {
    id,
    headSha,
    status,
    conclusion: null,
    createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    updatedAt: new Date(NOW - Math.max(0, minutesAgo - 1) * 60_000).toISOString(),
    attempts: [{
      attempt: 1,
      jobs: [{ steps: stepName ? [{ name: stepName, conclusion: 'success' }] : [] }],
    }],
  };
}

function rawRun({
  id,
  runAttempt = 1,
  displayTitle = `routine-${id}`,
  headSha = HEAD,
  status = 'completed',
  conclusion = 'success',
  createdAt = new Date(NOW - 2 * 60 * 60_000).toISOString(),
  updatedAt = new Date(NOW - 2 * 60 * 60_000 + 60_000).toISOString(),
} = {}) {
  return {
    id,
    run_attempt: runAttempt,
    display_title: displayTitle,
    head_sha: headSha,
    status,
    conclusion,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function sourceWorkflowRun({
  id = 9001,
  runAttempt = 1,
  path = '.github/workflows/railway-deploy-trigger-watchdog.yml@refs/heads/main',
  event = 'schedule',
  headBranch = 'main',
  headSha = HEAD,
  status = 'completed',
  conclusion = 'cancelled',
} = {}) {
  return {
    id,
    run_attempt: runAttempt,
    path,
    event,
    head_branch: headBranch,
    head_sha: headSha,
    status,
    conclusion,
  };
}

describe('stale Railway reconcile classification', () => {
  it('reports a recent exact terminal acceptance as healthy', () => {
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [acceptedRun()],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: { state: 'TERMINAL_ACCEPTED', headSha: HEAD },
        lastAccepted: {
          attemptId: 'attempt-accepted',
          headSha: HEAD,
          acceptedAt: NOW - 10 * 60_000,
        },
      },
      autoRecoveryEnabled: true,
    });

    assert.equal(ACCEPTED_FRESHNESS_MS, 60 * 60_000);
    assert.equal(result.outcome, 'HEALTHY');
    assert.equal(result.dispatchEligible, false);
  });

  it('makes a stale accepted head with zero target runs eligible for recovery', () => {
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: { state: 'TERMINAL_ACCEPTED', headSha: HEAD },
        lastAccepted: {
          attemptId: 'old-accepted-attempt',
          headSha: HEAD,
          acceptedAt: NOW - ACCEPTED_FRESHNESS_MS - 1,
        },
      },
      autoRecoveryEnabled: true,
    });

    assert.equal(result.outcome, 'RECOVERY_ELIGIBLE_OBSERVE_ONLY');
    assert.equal(result.dispatchEligible, true);
    assert.equal(result.headSha, HEAD);
  });

  it('defers a moved or non-green main before considering stale history', () => {
    const base = {
      now: NOW,
      runs: [],
      controlState: { barrier: null, lease: null, dispatchHolds: [], lastAccepted: null },
      autoRecoveryEnabled: true,
    };
    for (const gate of ['failure', 'pending', 'missing']) {
      const result = classifyWatchdogSnapshot({
        ...base,
        main: { sha: HEAD, gate: { state: gate } },
      });
      assert.equal(result.outcome, 'DEFERRED_NON_GREEN_MAIN');
      assert.equal(result.dispatchEligible, false);
    }
  });

  it('waits only for a young active post-mutation verifier, then requires manual action globally', () => {
    const controlState = {
      barrier: { attemptId: 'mutated', runId: '202', headSha: 'b'.repeat(40) },
      lease: null,
      dispatchHolds: [],
      currentAttempt: {
        attemptId: 'mutated', runId: '202', state: 'MUTATION_STARTED', headSha: 'b'.repeat(40),
      },
      lastAccepted: null,
    };
    const young = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [activeRun({
        headSha: 'b'.repeat(40),
        minutesAgo: 44,
        stepName: 'Mark Railway mutation started',
      })],
      controlState,
      autoRecoveryEnabled: true,
    });
    assert.equal(young.outcome, 'WAITING_FOR_ACTIVE_RUN');
    assert.equal(young.dispatchEligible, false);

    const old = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [activeRun({
        headSha: 'b'.repeat(40),
        minutesAgo: 45,
        stepName: 'Mark Railway mutation started',
      })],
      controlState,
      autoRecoveryEnabled: true,
    });
    assert.equal(old.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
    assert.equal(old.dispatchEligible, false);

    const unrelated = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [activeRun({
        id: 999,
        headSha: 'b'.repeat(40),
        minutesAgo: 5,
        stepName: MUTATION_STARTED_STEP_NAME,
      })],
      controlState,
      autoRecoveryEnabled: true,
    });
    assert.equal(unrelated.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');

    const mismatchedAttempt = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [activeRun({ id: 202, headSha: 'b'.repeat(40), minutesAgo: 5 })],
      controlState: {
        ...controlState,
        currentAttempt: { ...controlState.currentAttempt, attemptId: 'different-attempt' },
      },
      autoRecoveryEnabled: true,
    });
    assert.equal(mismatchedAttempt.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('waits for a young active pre-mutation run and ignores an old runner-less orphan', () => {
    const input = {
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      controlState: {
        barrier: null, lease: null, dispatchHolds: [], currentAttempt: null, lastAccepted: null,
      },
      autoRecoveryEnabled: true,
    };
    const young = classifyWatchdogSnapshot({
      ...input,
      runs: [activeRun({ minutesAgo: 19 })],
    });
    assert.equal(PRE_MUTATION_ACTIVE_MS, 20 * 60_000);
    assert.equal(young.outcome, 'WAITING_FOR_ACTIVE_RUN');

    const orphan = classifyWatchdogSnapshot({
      ...input,
      runs: [activeRun({ minutesAgo: 20, status: 'waiting' })],
    });
    assert.equal(orphan.outcome, 'RECOVERY_ELIGIBLE_OBSERVE_ONLY');
    assert.equal(orphan.dispatchEligible, true);
  });

  it('keeps an earlier run attempt mutation marker authoritative when the rerun looks clean', () => {
    const run = activeRun({ minutesAgo: 50, status: 'completed' });
    run.conclusion = 'success';
    run.attempts = [
      { attempt: 1, jobs: [{ steps: [{ name: MUTATION_STARTED_STEP_NAME, conclusion: 'success' }] }] },
      { attempt: 2, jobs: [{ steps: [{ name: 'Admission', conclusion: 'success' }] }] },
    ];

    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [run],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: null,
        lastAccepted: null,
      },
      autoRecoveryEnabled: true,
    });

    assert.equal(result.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
    assert.equal(result.dispatchEligible, false);
  });

  it('retires a mutation marker accepted by a different job in the same run attempt', () => {
    const run = activeRun({ id: 706, minutesAgo: 10, status: 'completed' });
    run.conclusion = 'success';
    run.attempts = [{
      attempt: 1,
      jobs: [
        { steps: [{ name: MUTATION_STARTED_STEP_NAME, conclusion: 'success' }] },
        { steps: [{ name: FINAL_ACCEPTANCE_STEP_NAME, conclusion: 'success' }] },
      ],
    }];

    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [run],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: { state: 'TERMINAL_ACCEPTED', headSha: HEAD, runId: '706', runAttempt: 1 },
        lastAccepted: { attemptId: 'accepted-706', headSha: HEAD, acceptedAt: NOW - 5 * 60_000 },
      },
      autoRecoveryEnabled: true,
    });

    assert.equal(result.outcome, 'HEALTHY');
    assert.equal(result.dispatchEligible, false);
  });

  it('retires only markers named by exact accepted superseded-run evidence', () => {
    const historical = {
      ...activeRun({ id: 707, minutesAgo: 30, stepName: MUTATION_STARTED_STEP_NAME }),
      status: 'completed',
      conclusion: 'failure',
    };
    const controlState = {
      barrier: null,
      lease: null,
      dispatchHolds: [],
      currentAttempt: {
        attemptId: 'operator-resolution-1',
        state: 'TERMINAL_ACCEPTED',
        createdAt: NOW - 5 * 60_000,
        headSha: HEAD,
        supersededRuns: [{ runId: '707', runAttempt: 1 }],
      },
      lastAccepted: null,
    };
    const retired = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [historical],
      controlState,
    });
    assert.equal(retired.outcome, 'RECOVERY_ELIGIBLE_OBSERVE_ONLY');

    const newer = activeRun({ id: 708, minutesAgo: 1, stepName: MUTATION_STARTED_STEP_NAME });
    const stillAuthoritative = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [historical, newer],
      controlState,
    });
    assert.equal(stillAuthoritative.outcome, 'WAITING_FOR_ACTIVE_RUN');
  });

  it('retires an old mutation marker as soon as an operator-authorized retry supersedes it', () => {
    const historical = {
      ...activeRun({ id: 717, minutesAgo: 30, stepName: MUTATION_STARTED_STEP_NAME }),
      status: 'completed',
      conclusion: 'failure',
    };
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [historical],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [{ state: 'DISPATCH_HELD', recoveryAttemptId: 'operator-retry-1', headSha: HEAD }],
        currentAttempt: {
          attemptId: 'operator-retry-1',
          state: 'OPERATOR_RESOLVED',
          headSha: HEAD,
          supersededRuns: [{ runId: '717', runAttempt: 1 }],
        },
        lastAccepted: null,
      },
    });
    assert.notEqual(result.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('keeps exact durable acceptance supersession after currentAttempt advances', () => {
    const acceptedAt = NOW - 10 * 60_000;
    const acceptedMarker = {
      ...activeRun({ id: 709, minutesAgo: 20, stepName: MANUAL_REQUIRED_STEP_NAME }),
      status: 'completed',
      conclusion: 'failure',
    };
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [acceptedMarker],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: {
          attemptId: 'newer-attempt',
          state: 'PRE_MUTATION_ABORTED',
          createdAt: NOW - 60_000,
          headSha: HEAD,
        },
        lastAccepted: {
          attemptId: 'durably-accepted-attempt',
          headSha: HEAD,
          acceptedAt,
          supersededRuns: [{ runId: '709', runAttempt: 1 }],
        },
      },
    });

    assert.equal(result.outcome, 'RECOVERY_ELIGIBLE_OBSERVE_ONLY');
    assert.equal(result.dispatchEligible, true);

    const newerMarker = activeRun({ id: 710, minutesAgo: 1, stepName: MANUAL_REQUIRED_STEP_NAME });
    const notRetired = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [acceptedMarker, newerMarker],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: null,
        lastAccepted: {
          attemptId: 'durably-accepted-attempt',
          headSha: HEAD,
          acceptedAt,
          supersededRuns: [{ runId: '709', runAttempt: 1 }],
        },
      },
    });
    assert.equal(notRetired.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('uses exact run-attempt acceptance evidence before timestamp fallback', () => {
    const run = activeRun({ id: 711, minutesAgo: 5, status: 'completed' });
    run.conclusion = 'success';
    run.attempts = [
      { attempt: 1, jobs: [{ steps: [{ name: MANUAL_REQUIRED_STEP_NAME, conclusion: 'success' }] }] },
      { attempt: 2, jobs: [{ steps: [{ name: FINAL_ACCEPTANCE_STEP_NAME, conclusion: 'success' }] }] },
    ];

    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [run],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: { state: 'PRE_MUTATION_ABORTED', headSha: HEAD },
        lastAccepted: { attemptId: 'accepted-rerun', headSha: HEAD, acceptedAt: NOW - 10 * 60_000 },
      },
    });

    assert.notEqual(result.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('does not let timestamp fallback override a mismatched exact accepted run id', () => {
    const marker = {
      ...activeRun({ id: 712, minutesAgo: 20, stepName: MANUAL_REQUIRED_STEP_NAME }),
      status: 'completed',
      conclusion: 'failure',
    };
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [marker],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: {
          attemptId: 'accepted-other-run',
          state: 'TERMINAL_ACCEPTED',
          runId: '999',
          headSha: HEAD,
          acceptedAt: NOW - 10 * 60_000,
        },
        lastAccepted: null,
      },
    });

    assert.equal(result.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('keeps matching-head timestamp evidence fail-closed without an exact superseded run entry', () => {
    const marker = {
      ...activeRun({ id: 713, minutesAgo: 20, stepName: MUTATION_STARTED_STEP_NAME }),
      status: 'completed',
      conclusion: 'failure',
    };
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [marker],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [],
        currentAttempt: null,
        lastAccepted: {
          attemptId: 'accepted-by-time-only',
          headSha: HEAD,
          acceptedAt: NOW - 5 * 60_000,
          supersededRuns: [],
        },
      },
    });

    assert.equal(result.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('retires old-head mutation and manual markers after an authorized current-head retry is accepted', () => {
    const oldHead = 'b'.repeat(40);
    for (const [id, stepName] of [
      [714, MUTATION_STARTED_STEP_NAME],
      [715, MANUAL_REQUIRED_STEP_NAME],
    ]) {
      const oldRun = {
        ...activeRun({ id, minutesAgo: 90, headSha: oldHead, stepName }),
        status: 'completed',
        conclusion: 'failure',
      };
      const result = classifyWatchdogSnapshot({
        now: NOW,
        main: { sha: HEAD, gate: { state: 'success' } },
        runs: [oldRun, acceptedRun()],
        controlState: {
          barrier: null,
          lease: null,
          dispatchHolds: [],
          currentAttempt: {
            attemptId: 'authorized-current-head-retry',
            state: 'TERMINAL_ACCEPTED',
            headSha: HEAD,
            supersededRuns: [{ runId: String(id), runAttempt: 1 }],
          },
          lastAccepted: {
            attemptId: 'authorized-current-head-retry',
            headSha: HEAD,
            acceptedAt: NOW - 10 * 60_000,
            supersededRuns: [{ runId: String(id), runAttempt: 1 }],
          },
        },
      });

      assert.equal(result.outcome, 'HEALTHY');
    }
  });

  it('never ages an unresolved dispatch hold into another automatic dispatch', () => {
    const result = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [],
      controlState: {
        barrier: null,
        lease: null,
        dispatchHolds: [{
          recoveryAttemptId: 'recovery-lost-response',
          headSha: HEAD,
          createdAt: NOW - 30 * 24 * 60 * 60_000,
          state: 'AMBIGUOUS',
        }],
        currentAttempt: null,
        lastAccepted: null,
      },
      autoRecoveryEnabled: true,
    });

    assert.equal(result.outcome, 'DEFERRED_AMBIGUOUS');
    assert.equal(result.dispatchEligible, false);
    assert.match(result.reason, /dispatch hold/i);
  });

  it('defers an active lease, but recovers LEASED or PREPARED abandoned work after expiry', () => {
    const state = (expiresAt, attemptState = 'PREPARED', resultKind = null) => ({
      barrier: null,
      lease: {
        attemptId: 'prepared-attempt',
        headSha: HEAD,
        expiresAt,
      },
      dispatchHolds: [],
      currentAttempt: {
        attemptId: 'prepared-attempt',
        headSha: HEAD,
        state: attemptState,
        resultKind,
      },
      lastAccepted: null,
    });

    const held = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [activeRun({ minutesAgo: 25 })],
      controlState: state(NOW + 1),
      autoRecoveryEnabled: true,
    });
    assert.equal(held.outcome, 'WAITING_FOR_ACTIVE_RUN');
    assert.equal(held.dispatchEligible, false);

    for (const attemptState of ['LEASED', 'PREPARED']) {
      const expired = classifyWatchdogSnapshot({
        now: NOW,
        main: { sha: HEAD, gate: { state: 'success' } },
        runs: [{ ...activeRun({ minutesAgo: 35 }), status: 'completed', conclusion: 'cancelled' }],
        controlState: state(NOW - 1, attemptState),
        autoRecoveryEnabled: true,
      });
      assert.equal(expired.outcome, 'RECOVERY_ELIGIBLE_OBSERVE_ONLY');
      assert.equal(expired.dispatchEligible, true);
    }

    const verificationPending = classifyWatchdogSnapshot({
      now: NOW,
      main: { sha: HEAD, gate: { state: 'success' } },
      runs: [{ ...activeRun({ minutesAgo: 35 }), status: 'completed', conclusion: 'success' }],
      controlState: state(NOW - 1, 'PREPARED', 'NO_MUTATION'),
      autoRecoveryEnabled: true,
    });
    assert.equal(verificationPending.outcome, 'DEFERRED_AMBIGUOUS');
    assert.equal(verificationPending.dispatchEligible, false);
  });

  it('fails closed on missing or malformed run history', () => {
    for (const runs of [undefined, null, [{}]]) {
      const result = classifyWatchdogSnapshot({
        now: NOW,
        main: { sha: HEAD, gate: { state: 'success' } },
        runs,
        controlState: {
          barrier: null, lease: null, dispatchHolds: [], currentAttempt: null, lastAccepted: null,
        },
        autoRecoveryEnabled: true,
      });
      assert.equal(result.outcome, 'DEFERRED_AMBIGUOUS');
      assert.equal(result.dispatchEligible, false);
    }
  });
});

const REPOSITORY_ID = 1130564872;

// GitHub answers every paginated read with a `next` link on the numeric
// repository-ID path (`/repositories/<id>/...`), never the
// `/repos/<owner>/<repo>/...` path that was requested. Building the link from
// the request pathname is the mock shape that let the watchdog paginate fine
// in tests and defer forever in production, so the production form is the
// shared default here: pass `next: <request url>` and every collection —
// statuses, runs, jobs, the fail-closed table, the budget walk — is exercised
// against the rewritten path. `link` stays available for the cases that must
// forge some other shape.
function productionNextLink(requestUrl, page = null) {
  const next = new URL(requestUrl);
  next.pathname = next.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, `/repositories/${REPOSITORY_ID}`);
  next.searchParams.set('page', String(page ?? Number(next.searchParams.get('page')) + 1));
  return `<${next}>; rel="next"`;
}

function json(data, { status = 200, next = null, nextPage = null, link = null } = {}) {
  const header = link ?? (next === null ? null : productionNextLink(next, nextPage));
  return Response.json(data, {
    status,
    headers: header ? { link: header } : undefined,
  });
}

function throttled(status, headers = {}) {
  return new Response(JSON.stringify({ message: `HTTP ${status}` }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stalledBody(signal, { status = 200 } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function assertRejectsBeforeBodyDeadline(promise, predicate) {
  let deadline;
  try {
    await assert.rejects(Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('response body remained stalled')), 250);
      }),
    ]), predicate);
  } finally {
    clearTimeout(deadline);
  }
}

describe('allowlisted GitHub watchdog transport', () => {
  it('pins API 2026-03-10 and fully paginates status, runs, and every run attempt job page', async () => {
    const calls = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        const parsed = new URL(url);
        const page = parsed.searchParams.get('page');
        if (parsed.pathname.endsWith('/statuses')) {
          return page === '1'
            ? json([{ context: 'other', state: 'success' }], { next: url })
            : json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
        }
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          if (page === '1') {
            return json({ total_count: 2, workflow_runs: [{
              ...rawRun({ id: 11, runAttempt: 2, displayTitle: 'ordinary' }),
              created_at: '2026-08-07T11:00:00Z',
              updated_at: '2026-08-07T11:10:00Z',
            }] }, { next: url });
          }
          return json({ total_count: 2, workflow_runs: [rawRun({ id: 12 })] });
        }
        if (parsed.pathname.includes('/runs/11/attempts/1/jobs')) {
          return page === '1'
            ? json({ total_count: 2, jobs: [{ id: 1, steps: [] }] }, { next: url })
            : json({ total_count: 2, jobs: [{ id: 2, steps: [] }] });
        }
        if (parsed.pathname.includes('/runs/11/attempts/2/jobs')) {
          return json({ total_count: 1, jobs: [{ id: 3, steps: [] }] });
        }
        if (parsed.pathname.includes('/runs/12/attempts/1/jobs')) {
          return json({ total_count: 0, jobs: [] });
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    assert.equal((await client.readNewestGate(HEAD)).state, 'success');
    const runs = await client.readTargetRuns();
    assert.equal(runs[0].runAttempt, 2);
    assert.deepEqual(runs[0].attempts.map((attempt) => attempt.jobs.length), [2, 1]);
    assert.ok(calls.every((call) => call.options.headers['x-github-api-version'] === GITHUB_API_VERSION));
    assert.ok(calls.every((call) => call.options.headers['user-agent'] === GITHUB_WATCHDOG_USER_AGENT));
    assert.ok(calls.some((call) => call.url.includes(
      encodeURIComponent(`>=${new Date(NOW - WATCHDOG_HISTORY_WINDOW_MS).toISOString()}`),
    )));
    assert.ok(calls.some((call) => call.url.includes('/attempts/1/jobs?per_page=100&page=2')));
    assert.ok(calls.some((call) => call.url.includes('/attempts/2/jobs?per_page=100&page=1')));
  });

  // GitHub rewrites every paginated Link header to the numeric repository-ID
  // form (`/repositories/<id>/statuses/<sha>`), never echoing back the
  // `/repos/<owner>/<repo>/commits/<sha>/statuses` path that was requested.
  // Mocks that build the next link from the request pathname cannot observe
  // this, so the watchdog paginated fine in tests and deferred forever in
  // production. Every paginated collection is affected; statuses is the one
  // that always exceeds a single page on this repository.
  it('paginates when GitHub rewrites next links to the repository-ID form', async () => {
    const calls = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        calls.push(String(url));
        const parsed = new URL(url);
        const page = parsed.searchParams.get('page');
        if (!parsed.pathname.endsWith('/statuses')) throw new Error(`unexpected ${url}`);
        return page === '1'
          ? json([{ context: 'other', state: 'success' }], {
            link: `<https://api.github.com/repositories/${REPOSITORY_ID}/statuses/${HEAD}`
              + '?per_page=100&page=2>; rel="next"',
          })
          : json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
      },
    });

    assert.equal((await client.readNewestGate(HEAD)).state, 'success');
    // Page two must be fetched on the allowlisted canonical path we synthesized,
    // never on the origin-supplied `/repositories/<id>/...` URL.
    assert.deepEqual(calls, [
      `https://api.github.com/repos/o/r/commits/${HEAD}/statuses?per_page=100&page=1`,
      `https://api.github.com/repos/o/r/commits/${HEAD}/statuses?per_page=100&page=2`,
    ]);
  });

  // `readNewestGate` is the only paginated read with no `total_count`, so the
  // frozen-total, duplicate-id, and truncation invariants are all inert on the
  // one collection that actually paginates in production. Statuses come back
  // newest-first, so the walk stops on the first `gate` and never pays for the
  // pages behind it.
  it('stops the status walk on the newest gate instead of draining every page', async () => {
    const pages = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        pages.push(Number(new URL(url).searchParams.get('page')));
        return json(
          [
            { context: 'other', state: 'success' },
            { context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' },
            { context: 'gate', state: 'failure', updated_at: '2026-08-07T10:00:00Z' },
          ],
          { next: url },
        );
      },
    });

    assert.deepEqual(await client.readNewestGate(HEAD), {
      state: 'success',
      updatedAt: '2026-08-07T11:59:00Z',
    });
    assert.deepEqual(pages, [1]);
  });

  // A short or Link-less origin response used to return a partial prefix, and
  // a walk that never reached the gate reported it as `missing`. That is
  // fail-closed today only by accident of the `'missing'` mapping; a full
  // final page with no `next` is a truncated read, not an absent gate.
  it('rejects a truncated status walk instead of reporting the gate missing', async () => {
    const fullPage = (context) => Array.from(
      { length: GITHUB_PAGE_SIZE },
      () => ({ context, state: 'success', updated_at: '2026-08-07T11:00:00Z' }),
    );
    const truncated = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async () => json(fullPage('other')),
    });
    await assert.rejects(
      truncated.readNewestGate(HEAD),
      (error) => error instanceof GitHubWatchdogError && error.code === 'GITHUB_READ_FAILED',
    );

    // A genuinely absent gate ends on a short page and stays `missing`, which
    // the classifier maps to DEFERRED_NON_GREEN_MAIN.
    const absent = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => (Number(new URL(url).searchParams.get('page')) === 1
        ? json(fullPage('other'), { next: url })
        : json([{ context: 'other', state: 'success' }])),
    });
    assert.deepEqual(await absent.readNewestGate(HEAD), { state: 'missing', updatedAt: null });
  });

  // One transient 403 mid-walk used to abort the whole read and land in the
  // silent DEFERRED_AMBIGUOUS tier — during a failure storm, exactly the
  // condition the watchdog exists to catch.
  it('retries transient read failures with bounded jittered backoff', async () => {
    const delays = [];
    const responses = [
      throttled(403),
      throttled(500),
      json({ object: { sha: HEAD } }),
    ];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      sleep: async (ms) => { delays.push(ms); },
      random: () => 1,
      fetchImpl: async () => responses.shift(),
    });

    assert.equal(await client.readCurrentMain(), HEAD);
    assert.equal(responses.length, 0);
    // Every attempt is a real request, so retries are charged to the budget.
    assert.equal(client.requestCount, 3);
    assert.deepEqual(delays, [WATCHDOG_READ_RETRY_BASE_MS, WATCHDOG_READ_RETRY_BASE_MS * 2]);
  });

  it('bounds the retry ladder and keeps definitive read failures single-shot', async () => {
    const exhausted = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      sleep: async () => {},
      fetchImpl: async () => throttled(429),
    });
    await assert.rejects(
      exhausted.readCurrentMain(),
      (error) => error instanceof GitHubWatchdogError
        && error.code === 'GITHUB_READ_FAILED'
        && error.status === 429,
    );
    assert.equal(exhausted.requestCount, WATCHDOG_READ_RETRY_ATTEMPTS + 1);

    for (const status of [401, 404, 422]) {
      const definitive = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        now: () => NOW,
        sleep: async () => { throw new Error('a definitive read must not back off'); },
        fetchImpl: async () => throttled(status),
      });
      await assert.rejects(
        definitive.readCurrentMain(),
        (error) => error.code === 'GITHUB_READ_FAILED' && error.status === status,
      );
      assert.equal(definitive.requestCount, 1, `HTTP ${status}`);
    }
  });

  it('honors Retry-After and the rate-limit reset ahead of the exponential ceiling', async () => {
    const cases = [
      [{ 'retry-after': '3' }, 3_000],
      [{ 'retry-after': new Date(NOW + 2_000).toUTCString() }, 2_000],
      [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1_000) + 5) }, 5_000],
      // A secondary-limit window longer than the ladder is clamped: sleeping it
      // out would blow the classify job's own timeout, and the exhausted read
      // fails the current manual invocation instead.
      [{ 'retry-after': '600' }, WATCHDOG_READ_RETRY_MAX_MS],
    ];
    for (const [headers, expected] of cases) {
      const delays = [];
      const responses = [throttled(403, headers), json({ object: { sha: HEAD } })];
      const client = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        now: () => NOW,
        sleep: async (ms) => { delays.push(ms); },
        random: () => 0,
        fetchImpl: async () => responses.shift(),
      });
      assert.equal(await client.readCurrentMain(), HEAD);
      assert.deepEqual(delays, [expected], JSON.stringify(headers));
    }
  });

  // The dispatch POST may already have created a run, so a resend would be a
  // second Railway deploy. Transient POST statuses stay ambiguous and the
  // durable hold decides — the retry ladder must never touch them.
  it('never retries the dispatch POST', async () => {
    for (const status of [403, 429, 500]) {
      let calls = 0;
      const client = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        now: () => NOW,
        sleep: async () => { throw new Error('a dispatch must not back off'); },
        fetchImpl: async () => { calls += 1; return throttled(status); },
      });
      await assert.rejects(
        client.dispatchRecovery({ recoveryAttemptId: 'recovery-1', expectedHeadSha: HEAD }),
        (error) => error.code === 'GITHUB_DISPATCH_AMBIGUOUS' && error.ambiguous === true,
      );
      assert.equal(calls, 1, `HTTP ${status}`);
    }
    // The observed single call above holds even if the outer guard is removed,
    // because a POST error never satisfies the read-retry classifier either.
    // Pin the outer guard directly so it is not a rule only a second rule
    // proves.
    assert.equal(retryAttemptsFor('POST', WATCHDOG_READ_RETRY_ATTEMPTS), 1);
    assert.equal(
      retryAttemptsFor('GET', WATCHDOG_READ_RETRY_ATTEMPTS),
      WATCHDOG_READ_RETRY_ATTEMPTS + 1,
    );
  });

  // Replaces the former 'skipped next page' rejection case. A skipped cursor
  // was only dangerous while the origin's next URL was followed; now that the
  // walk is synthesized, an origin advertising page 3 cannot make the watchdog
  // skip page 2, and total_count still proves the read was complete.
  it('ignores an origin-advertised page number and still walks every page', async () => {
    const seen = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get('page'));
        seen.push(page);
        return json(
          page === 1
            ? { total_count: 2, workflow_runs: [rawRun({ id: 1 })] }
            : { total_count: 2, workflow_runs: [rawRun({ id: 2 })] },
          page === 1 ? { next: url, nextPage: 9 } : {},
        );
      },
    });

    await client.readTargetRunSummaries();
    // Every collection walked 1 then 2. The advertised page 9 was never fetched.
    assert.deepEqual([...new Set(seen)].sort(), [1, 2]);
    assert.equal(seen.length % 2, 0);
  });

  it('hydrates attempt jobs with bounded concurrency while preserving attempt order', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const attemptCount = WATCHDOG_JOB_READ_CONCURRENCY + 2;
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          return json({
            total_count: 1,
            workflow_runs: [rawRun({
              id: 11,
              runAttempt: attemptCount,
              displayTitle: 'ordinary',
              createdAt: '2026-08-07T11:00:00Z',
              updatedAt: '2026-08-07T11:10:00Z',
            })],
          });
        }
        if (parsed.pathname.includes('/attempts/')) {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise((resolve) => setImmediate(resolve));
          activeReads -= 1;
          return json({
            total_count: 1,
            jobs: [{ id: Number(parsed.pathname.match(/attempts\/(\d+)/)?.[1]) }],
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    const [run] = await client.readTargetRuns();
    assert.equal(maxActiveReads, WATCHDOG_JOB_READ_CONCURRENCY);
    assert.deepEqual(run.attempts.map(({ attempt }) => attempt),
      Array.from({ length: attemptCount }, (_, index) => index + 1));
  });

  it('includes an active target run even when it started before the 24-hour history window', async () => {
    const oldActive = rawRun({
      id: 77,
      status: 'in_progress',
      conclusion: null,
      createdAt: new Date(NOW - 48 * 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (!parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          throw new Error(`unexpected ${url}`);
        }
        const status = parsed.searchParams.get('status');
        if (status === 'in_progress') {
          return json({ total_count: 1, workflow_runs: [oldActive] });
        }
        return json({ total_count: 0, workflow_runs: [] });
      },
    });

    const runs = await client.readTargetRunSummaries();
    assert.deepEqual(runs.map((run) => run.id), [77]);
    assert.equal(runs[0].status, 'in_progress');
  });

  it('correlates accepted dispatches from run summaries without hydrating jobs', async () => {
    const calls = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        calls.push(String(url));
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          return json({
            total_count: 1,
            workflow_runs: [rawRun({
              id: 22,
              runAttempt: 9,
              displayTitle: 'Railway reconcile recovery-accepted',
            })],
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    const correlated = await client.findRunByRecoveryAttemptId('recovery-accepted');
    assert.equal(correlated.id, 22);
    assert.equal(correlated.runAttempt, 9);
    assert.ok(calls.every((url) => !url.includes('/jobs')));
  });

  it('reads exact source attempts for both hold-owning workflows and maps their named POST boundary', async () => {
    const cases = [
      {
        id: 9001,
        path: '.github/workflows/railway-deploy-trigger-watchdog.yml@refs/heads/main',
        event: 'schedule',
        jobName: WATCHDOG_DISPATCH_JOB_NAME,
        stepName: WATCHDOG_DISPATCH_STEP_NAME,
      },
      {
        id: 9002,
        path: '.github/workflows/railway-reconcile-manual-recovery.yml@refs/heads/main',
        event: 'workflow_dispatch',
        jobName: MANUAL_RECOVERY_DISPATCH_JOB_NAME,
        stepName: MANUAL_RECOVERY_DISPATCH_STEP_NAME,
      },
    ];

    for (const testCase of cases) {
      const calls = [];
      const client = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        fetchImpl: async (url) => {
          calls.push(String(url));
          const parsed = new URL(url);
          if (parsed.pathname.endsWith(`/actions/runs/${testCase.id}/attempts/2`)) {
            return json(sourceWorkflowRun({
              id: testCase.id,
              runAttempt: 2,
              path: testCase.path,
              event: testCase.event,
            }));
          }
          if (parsed.pathname.endsWith(`/actions/runs/${testCase.id}/attempts/2/jobs`)) {
            return json({ total_count: 0, jobs: [] });
          }
          throw new Error(`unexpected ${url}`);
        },
      });

      const evidence = await client.readSourceDispatchEvidence({
        sourceRunId: String(testCase.id),
        sourceRunAttempt: 2,
        expectedSourceHeadSha: HEAD,
      });
      assert.equal(evidence.workflowPath, testCase.path.split('@')[0]);
      assert.equal(evidence.dispatchJobName, testCase.jobName);
      assert.equal(evidence.dispatchStepName, testCase.stepName);
      assert.equal(evidence.sourceRunId, String(testCase.id));
      assert.equal(evidence.sourceRunAttempt, 2);
      assert.ok(calls.some((url) => url.endsWith(`/actions/runs/${testCase.id}/attempts/2`)));
      assert.ok(calls.some((url) => url.includes(`/actions/runs/${testCase.id}/attempts/2/jobs?`)));
    }
  });

  it('fails closed when exact source path, ref, head, event, or attempt does not match', async () => {
    const cases = [
      { path: '.github/workflows/not-the-watchdog.yml@refs/heads/main' },
      { headBranch: 'feature' },
      { headSha: 'b'.repeat(40) },
      { event: 'push' },
      { runAttempt: 3 },
    ];

    for (const mutation of cases) {
      const client = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname.endsWith('/actions/runs/9003/attempts/2')) {
            return json(sourceWorkflowRun({ id: 9003, runAttempt: 2, ...mutation }));
          }
          throw new Error(`unexpected ${url}`);
        },
      });
      await assert.rejects(
        client.readSourceDispatchEvidence({
          sourceRunId: '9003',
          sourceRunAttempt: 2,
          expectedSourceHeadSha: HEAD,
        }),
        (error) => error instanceof GitHubWatchdogError && error.code === 'GITHUB_READ_FAILED',
      );
    }
  });

  it('classifies a durable barrier from only active and durably referenced hydrated runs', async () => {
    const selectedIds = new Set([2, 4, 5, 6, 7, 8, 9]);
    const allRuns = Array.from({ length: 792 }, (_, index) => rawRun({ id: index + 1 }));
    allRuns[1] = rawRun({ id: 2, status: 'in_progress', conclusion: null });
    allRuns[2] = rawRun({
      id: 3,
      updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    allRuns[3] = rawRun({ id: 4 });
    allRuns[4] = rawRun({ id: 5, displayTitle: 'reconcile current-attempt-id' });
    allRuns[5] = rawRun({ id: 6 });
    allRuns[6] = rawRun({ id: 7, displayTitle: 'reconcile held-recovery-id' });
    allRuns[7] = rawRun({ id: 8 });
    allRuns[8] = rawRun({ id: 9, displayTitle: 'reconcile barrier-attempt-id' });

    const hydratedIds = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/git/ref/heads/main')) {
          return json({ object: { sha: HEAD } });
        }
        if (parsed.pathname.endsWith('/statuses')) {
          return json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
        }
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          const status = parsed.searchParams.get('status');
          if (status !== null) {
            const workflowRuns = status === 'in_progress' ? [allRuns[1]] : [];
            return json({ total_count: workflowRuns.length, workflow_runs: workflowRuns });
          }
          const page = Number(parsed.searchParams.get('page'));
          const start = (page - 1) * 100;
          const workflowRuns = allRuns.slice(start, start + 100);
          return json(
            { total_count: allRuns.length, workflow_runs: workflowRuns },
            start + workflowRuns.length < allRuns.length ? { next: url } : {},
          );
        }
        const match = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(parsed.pathname);
        if (match) {
          const runId = Number(match[1]);
          hydratedIds.push(runId);
          return json({
            total_count: 1,
            jobs: [{
              id: runId,
              steps: [],
            }],
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const controlState = eligibleControl({
      currentAttempt: { attemptId: 'current-attempt-id', runId: '4', state: 'PREPARED' },
      barrier: { attemptId: 'barrier-attempt-id', runId: '8' },
      lastAccepted: { attemptId: 'accepted-attempt-id', runId: '6', headSha: HEAD, acceptedAt: NOW - 120_000 },
      dispatchHolds: [{
        state: 'RUN_BOUND',
        recoveryAttemptId: 'held-recovery-id',
        runId: '8',
        runAttempt: 1,
        headSha: HEAD,
      }],
    });
    const snapshot = await readWatchdogSnapshot({
      github: client,
      control: { status: async () => ({ data: controlState }) },
      clock: () => NOW,
    });

    assert.equal(snapshot.runs.length, selectedIds.size);
    assert.deepEqual(new Set(hydratedIds), selectedIds);
    assert.ok(snapshot.runs.every((run) => run.hydrated === true));
    assert.equal(snapshot.runs.some(({ id }) => id === 1), false);
    assert.ok(client.requestCount < 40, `expected bounded requests, received ${client.requestCount}`);
    assert.ok(client.requestCount <= 250);
  });

  it('keeps a durable barrier observable with more old failures than the request budget', async () => {
    const barrierRunId = 300;
    const allRuns = Array.from({ length: barrierRunId }, (_, index) => rawRun({
      id: index + 1,
      status: 'completed',
      conclusion: 'failure',
      createdAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 2 * 60 * 60_000 + 60_000).toISOString(),
    }));
    const hydratedIds = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/git/ref/heads/main')) {
          return json({ object: { sha: HEAD } });
        }
        if (parsed.pathname.endsWith('/statuses')) {
          return json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
        }
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          const page = Number(parsed.searchParams.get('page'));
          const start = (page - 1) * 100;
          const workflowRuns = allRuns.slice(start, start + 100);
          return json(
            { total_count: allRuns.length, workflow_runs: workflowRuns },
            start + workflowRuns.length < allRuns.length ? { next: url } : {},
          );
        }
        const match = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(parsed.pathname);
        if (match) {
          const runId = Number(match[1]);
          hydratedIds.push(runId);
          return json({ total_count: 1, jobs: [{ id: runId, steps: [] }] });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const snapshot = await readWatchdogSnapshot({
      github: client,
      control: {
        status: async () => ({
          data: eligibleControl({
            barrier: { attemptId: 'barrier-attempt', runId: String(barrierRunId) },
            currentAttempt: {
              attemptId: 'barrier-attempt',
              runId: String(barrierRunId),
              state: 'MUTATION_STARTED',
            },
          }),
        }),
      },
      clock: () => NOW,
    });

    assert.deepEqual(hydratedIds, [barrierRunId]);
    assert.ok(client.requestCount < 30, `expected bounded requests, received ${client.requestCount}`);
    assert.equal(classifyWatchdogSnapshot(snapshot).outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('uses strict terminal acceptance as a watermark but still reads later failed work', async () => {
    const acceptedAt = NOW - 30 * 60_000;
    const oldFailures = Array.from({ length: 300 }, (_, index) => rawRun({
      id: index + 1,
      status: 'completed',
      conclusion: 'failure',
      createdAt: new Date(acceptedAt - 2 * 60 * 60_000).toISOString(),
      updatedAt: new Date(acceptedAt - 60_000).toISOString(),
    }));
    const acceptance = rawRun({
      id: 301,
      status: 'completed',
      conclusion: 'success',
      createdAt: new Date(acceptedAt - 10 * 60_000).toISOString(),
      updatedAt: new Date(acceptedAt).toISOString(),
    });
    const laterFailure = rawRun({
      id: 302,
      status: 'completed',
      conclusion: 'failure',
      createdAt: new Date(acceptedAt - 5 * 60_000).toISOString(),
      updatedAt: new Date(acceptedAt + 5 * 60_000).toISOString(),
    });
    const allRuns = [...oldFailures, acceptance, laterFailure];
    const hydratedIds = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/git/ref/heads/main')) {
          return json({ object: { sha: HEAD } });
        }
        if (parsed.pathname.endsWith('/statuses')) {
          return json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
        }
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          const page = Number(parsed.searchParams.get('page'));
          const start = (page - 1) * 100;
          const workflowRuns = allRuns.slice(start, start + 100);
          return json(
            { total_count: allRuns.length, workflow_runs: workflowRuns },
            start + workflowRuns.length < allRuns.length ? { next: url } : {},
          );
        }
        const match = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(parsed.pathname);
        if (match) {
          const runId = Number(match[1]);
          hydratedIds.push(runId);
          const steps = runId === 301
            ? [{ name: FINAL_ACCEPTANCE_STEP_NAME, conclusion: 'success' }]
            : [{ name: MUTATION_STARTED_STEP_NAME, conclusion: 'success' }];
          return json({ total_count: 1, jobs: [{ id: runId, steps }] });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const snapshot = await readWatchdogSnapshot({
      github: client,
      control: {
        status: async () => ({
          data: eligibleControl({
            currentAttempt: { attemptId: 'accepted-attempt', state: 'TERMINAL_ACCEPTED' },
            lastAccepted: {
              attemptId: 'accepted-attempt',
              runId: '301',
              headSha: HEAD,
              acceptedAt,
            },
          }),
        }),
      },
      clock: () => NOW,
    });

    assert.deepEqual(new Set(hydratedIds), new Set([301, 302]));
    assert.ok(client.requestCount < 30, `expected bounded requests, received ${client.requestCount}`);
    assert.equal(classifyWatchdogSnapshot(snapshot).outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
  });

  it('hydrates an old failed run when no trusted acceptance watermark exists', async () => {
    const oldFailure = rawRun({
      id: 61,
      status: 'completed',
      conclusion: 'failure',
      createdAt: new Date(NOW - 61 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 61 * 60_000).toISOString(),
    });
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/git/ref/heads/main')) {
          return json({ object: { sha: HEAD } });
        }
        if (parsed.pathname.endsWith('/statuses')) {
          return json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
        }
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          return json({ total_count: 1, workflow_runs: [oldFailure] });
        }
        if (parsed.pathname.endsWith('/actions/runs/61/attempts/1/jobs')) {
          return json({
            total_count: 1,
            jobs: [{
              id: 61,
              steps: [{ name: MUTATION_STARTED_STEP_NAME, conclusion: 'success' }],
            }],
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const snapshot = await readWatchdogSnapshot({
      github: client,
      control: {
        status: async () => ({
          data: eligibleControl({
            lastAccepted: {
              attemptId: 'malformed-watermark',
              runId: 'not-a-run-id',
              headSha: HEAD,
              acceptedAt: NOW - 10 * 60_000,
            },
          }),
        }),
      },
      clock: () => NOW,
    });

    assert.equal(snapshot.runs[0].hydrated, true);
    const classified = classifyWatchdogSnapshot(snapshot);
    assert.equal(classified.outcome, 'MANUAL_REQUIRED_AFTER_MUTATION');
    assert.equal(classified.dispatchEligible, false);
  });

  it('hydrates only a recent acceptance proof when the durable run id is unavailable', async () => {
    const recentSuccess = rawRun({
      id: 71,
      createdAt: new Date(NOW - 15 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    const olderSuccess = rawRun({
      id: 72,
      createdAt: new Date(NOW - 125 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 120 * 60_000).toISOString(),
    });
    const hydratedIds = [];
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      now: () => NOW,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/git/ref/heads/main')) {
          return json({ object: { sha: HEAD } });
        }
        if (parsed.pathname.endsWith('/statuses')) {
          return json([{ context: 'gate', state: 'success', updated_at: '2026-08-07T11:59:00Z' }]);
        }
        if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
          if (parsed.searchParams.has('status')) {
            return json({ total_count: 0, workflow_runs: [] });
          }
          return json({ total_count: 2, workflow_runs: [recentSuccess, olderSuccess] });
        }
        const match = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(parsed.pathname);
        if (match) {
          const runId = Number(match[1]);
          hydratedIds.push(runId);
          return json({
            total_count: 1,
            jobs: [{
              id: runId,
              steps: [{ name: FINAL_ACCEPTANCE_STEP_NAME, conclusion: 'success' }],
            }],
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const snapshot = await readWatchdogSnapshot({
      github: client,
      control: {
        status: async () => ({
          data: eligibleControl({
            lastAccepted: {
              attemptId: 'accepted-without-run-id',
              runId: null,
              headSha: HEAD,
              acceptedAt: NOW - 10 * 60_000,
            },
          }),
        }),
      },
      clock: () => NOW,
    });

    assert.deepEqual(hydratedIds, [recentSuccess.id]);
    const classified = classifyWatchdogSnapshot(snapshot);
    assert.equal(classified.outcome, 'HEALTHY');
    assert.equal(classified.dispatchEligible, false);
  });

  it('fails closed on mutable totals, duplicate ids, truncation, and empty counted pages', async () => {
    const cases = [
      ['invalid total', [{ total_count: '1', workflow_runs: [rawRun({ id: 1 })] }]],
      ['changed total', [
        { total_count: 2, workflow_runs: [rawRun({ id: 1 })], next: true },
        { total_count: 3, workflow_runs: [rawRun({ id: 2 })] },
      ]],
      ['duplicate id', [{ total_count: 2, workflow_runs: [rawRun({ id: 1 }), rawRun({ id: 1 })] }]],
      ['missing next', [{ total_count: 2, workflow_runs: [rawRun({ id: 1 })] }]],
      ['empty page', [
        { total_count: 2, workflow_runs: [rawRun({ id: 1 })], next: true },
        { total_count: 2, workflow_runs: [] },
      ]],
      ['next after total', [{ total_count: 1, workflow_runs: [rawRun({ id: 1 })], next: true }]],
    ];

    for (const [name, pages] of cases) {
      const client = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        now: () => NOW,
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get('page'));
          const body = pages[page - 1] ?? pages.at(-1);
          return json(body, body.next ? { next: url, nextPage: body.nextPage ?? null } : {});
        },
      });
      await assert.rejects(
        client.readTargetRunSummaries(),
        (error) => error instanceof GitHubWatchdogError && error.code === 'GITHUB_READ_FAILED',
        name,
      );
    }

    for (const pages of [
      [{ total_count: '1', jobs: [{ id: 1, steps: [] }] }],
      [{ total_count: 2, jobs: [{ id: 1, steps: [] }] }],
      [{ total_count: 2, jobs: [{ id: 1, steps: [] }, { id: 1, steps: [] }] }],
      [
        { total_count: 2, jobs: [{ id: 1, steps: [] }], next: true },
        { total_count: 3, jobs: [{ id: 2, steps: [] }] },
      ],
      [
        { total_count: 2, jobs: [{ id: 1, steps: [] }], next: true },
        { total_count: 2, jobs: [] },
      ],
    ]) {
      const client = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        now: () => NOW,
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname.endsWith('/railway-deploy-trigger.yml/runs')) {
            if (parsed.searchParams.has('status')) {
              return json({ total_count: 0, workflow_runs: [] });
            }
            return json({ total_count: 1, workflow_runs: [rawRun({ id: 1 })] });
          }
          const page = Number(parsed.searchParams.get('page'));
          const body = pages[page - 1] ?? pages.at(-1);
          return json(body, body.next ? { next: url } : {});
        },
      });
      await assert.rejects(
        client.readTargetRuns(),
        (error) => error instanceof GitHubWatchdogError && error.code === 'GITHUB_READ_FAILED',
      );
    }
  });

  it('fails closed when pagination or one request exceeds its explicit budget', async () => {
    assert.throws(
      () => new GitHubWatchdogClient({ repository: 'o/r', token: 'token', maxRequests: 251 }),
      /integer from 1 to 250/,
    );
    let pages = 0;
    const paged = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      fetchImpl: async (url) => {
        pages += 1;
        return json([], { next: url });
      },
    });
    await assert.rejects(
      paged.readNewestGate(HEAD),
      (error) => error.code === 'GITHUB_READ_BUDGET_EXCEEDED',
    );
    assert.equal(pages, WATCHDOG_MAX_PAGES);

    const stalled = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      requestTimeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    await assert.rejects(
      stalled.readCurrentMain(),
      (error) => error.code === 'GITHUB_READ_TIMEOUT',
    );
  });

  it('keeps the GET timeout active while consuming a stalled response body', async () => {
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      requestTimeoutMs: 5,
      fetchImpl: async (_url, { signal }) => stalledBody(signal),
    });

    await assertRejectsBeforeBodyDeadline(
      client.readCurrentMain(),
      (error) => error instanceof GitHubWatchdogError && error.code === 'GITHUB_READ_TIMEOUT',
    );
  });

  it('keeps the POST timeout active while consuming a stalled dispatch body', async () => {
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      requestTimeoutMs: 5,
      fetchImpl: async (_url, { signal }) => stalledBody(signal, { status: 202 }),
    });

    await assertRejectsBeforeBodyDeadline(
      client.dispatchRecovery({ recoveryAttemptId: 'recovery-stalled', expectedHeadSha: HEAD }),
      (error) => error instanceof GitHubWatchdogError
        && error.code === 'GITHUB_DISPATCH_AMBIGUOUS'
        && error.ambiguous === true,
    );
  });

  it('rejects cancellation, rerun, review, other dispatch, near-miss, and unrelated writes before transport', async () => {
    let transports = 0;
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      fetchImpl: async () => { transports += 1; return json({}); },
    });
    const forbidden = [
      ['POST', '/repos/o/r/actions/runs/1/cancel'],
      ['POST', '/repos/o/r/actions/runs/1/force-cancel'],
      ['POST', '/repos/o/r/actions/runs/1/rerun'],
      ['POST', '/repos/o/r/actions/runs/1/pending_deployments'],
      ['POST', '/repos/o/r/environments/production/deployment-branch-policies'],
      ['POST', '/repos/o/r/actions/workflows/other.yml/dispatches'],
      ['POST', '/repos/o/r/actions/workflows/railway-deploy-trigger.yml/dispatches/'],
      ['PATCH', `/repos/o/r/git/refs/heads/main`],
    ];
    for (const [method, path] of forbidden) {
      await assert.rejects(client.request(method, path), /outside the watchdog allowlist/);
    }
    assert.equal(transports, 0);
  });

  it('never retries a state-changing dispatch after a lost response', async () => {
    let calls = 0;
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      fetchImpl: async () => { calls += 1; throw new Error('socket lost'); },
    });
    await assert.rejects(
      client.dispatchRecovery({ recoveryAttemptId: 'recovery-1', expectedHeadSha: HEAD }),
      (error) => error instanceof GitHubWatchdogError && error.ambiguous === true,
    );
    assert.equal(calls, 1);
  });

  it('keeps a dispatch hold on GitHub 403 because secondary rate limits are transient', async () => {
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      fetchImpl: async () => new Response('secondary rate limit', { status: 403 }),
    });
    await assert.rejects(
      client.dispatchRecovery({ recoveryAttemptId: 'recovery-rate-limited', expectedHeadSha: HEAD }),
      (error) => error instanceof GitHubWatchdogError
        && error.code === 'GITHUB_DISPATCH_AMBIGUOUS'
        && error.status === 403
        && error.ambiguous === true,
    );
  });

  it('treats a malformed successful dispatch response as permanently ambiguous without retry', async () => {
    let calls = 0;
    const client = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      fetchImpl: async () => {
        calls += 1;
        return new Response('{', { status: 202, headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(
      client.dispatchRecovery({ recoveryAttemptId: 'recovery-malformed', expectedHeadSha: HEAD }),
      (error) => error instanceof GitHubWatchdogError && error.ambiguous === true,
    );
    assert.equal(calls, 1);
  });

  it('parses only the 2026-03-10 workflow_run_id dispatch response field', async () => {
    let requestBody;
    const accepted = new GitHubWatchdogClient({
      repository: 'o/r',
      token: 'token',
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return Response.json({ workflow_run_id: 4242 }, { status: 202 });
      },
    });
    assert.deepEqual(
      await accepted.dispatchRecovery({ recoveryAttemptId: 'recovery-exact-schema', expectedHeadSha: HEAD }),
      { runId: 4242, runAttempt: 1 },
    );
    assert.equal(requestBody.return_run_details, true);

    for (const body of [{ run_id: 4242 }, { id: 4242 }]) {
      const aliased = new GitHubWatchdogClient({
        repository: 'o/r',
        token: 'token',
        fetchImpl: async () => Response.json(body, { status: 202 }),
      });
      await assert.rejects(
        aliased.dispatchRecovery({ recoveryAttemptId: 'recovery-wrong-schema', expectedHeadSha: HEAD }),
        (error) => error instanceof GitHubWatchdogError
          && error.code === 'GITHUB_DISPATCH_AMBIGUOUS'
          && error.ambiguous === true,
      );
    }
  });
});

function eligibleControl(overrides = {}) {
  return {
    barrier: null,
    lease: null,
    dispatchHolds: [],
    currentAttempt: null,
    lastAccepted: null,
    ...overrides,
  };
}

function controllerFixture({ autoRecoveryEnabled = true, mainSequence = [HEAD, HEAD, HEAD], dispatchError = null } = {}) {
  const events = [];
  const holdBodies = [];
  const rejectBodies = [];
  let mainRead = 0;
  const github = {
    async readMainAndGate() {
      events.push(`main:${mainRead + 1}`);
      return { sha: mainSequence[mainRead++] ?? mainSequence.at(-1), gate: { state: 'success' } };
    },
    async readTargetRunSummaries() { events.push('runs'); return []; },
    async hydrateTargetRuns() { return []; },
    async readSourceRunIdentity({ sourceRunId, sourceRunAttempt }) {
      events.push('source');
      return { sourceRunId: String(sourceRunId), sourceRunAttempt, headSha: HEAD };
    },
    async findRunByRecoveryAttemptId() { events.push('correlate'); return null; },
    async dispatchRecovery() {
      events.push('dispatch');
      if (dispatchError) throw dispatchError;
      return { runId: 808, runAttempt: 1 };
    },
    async readDispatchedRunIdentity({ runId, runAttempt }) {
      events.push('verify');
      return { id: String(runId), runAttempt };
    },
  };
  const control = {
    async status() { events.push('status'); return { data: eligibleControl() }; },
    async createDispatchHold(body) { events.push('hold'); holdBodies.push(body); return { data: {} }; },
    async bindRun() { events.push('bind'); return { data: {} }; },
    async rejectDispatch(body) { events.push('reject'); rejectBodies.push(body); return { data: {} }; },
  };
  return {
    github,
    control,
    events,
    holdBodies,
    rejectBodies,
    autoRecoveryEnabled,
    sourceRunId: '9000',
    sourceRunAttempt: 3,
  };
}

describe('durably held recovery dispatch orchestration', () => {
  it('starts independent read-only snapshot evidence in parallel', async () => {
    const started = new Set();
    let release;
    const pendingRead = new Promise((resolve) => { release = resolve; });
    const github = {
      async readMainAndGate() {
        started.add('main');
        await pendingRead;
        return { sha: HEAD, gate: { state: 'success' } };
      },
      async readTargetRunSummaries() {
        started.add('runs');
        await pendingRead;
        return [];
      },
      async hydrateTargetRuns() { return []; },
    };
    const control = {
      async status() {
        started.add('status');
        await pendingRead;
        return { data: eligibleControl() };
      },
    };

    const snapshotPromise = readWatchdogSnapshot({ github, control, clock: () => NOW });
    await Promise.resolve();
    assert.deepEqual([...started].sort(), ['main', 'runs', 'status']);
    release();
    assert.equal((await snapshotPromise).main.sha, HEAD);
  });

  it('repairs an already-issued dispatch hold during classification without creating a new dispatch', async () => {
    const hold = {
      state: 'DISPATCH_HELD',
      recoveryAttemptId: 'operator-retry-already-issued',
      headSha: HEAD,
      sourceRunId: '9007',
      sourceRunAttempt: 1,
      sourceHeadSha: HEAD,
    };
    const bindCalls = [];
    let bound = false;
    const snapshot = await readWatchdogSnapshot({
      github: {
        readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
        readTargetRunSummaries: async () => [],
        hydrateTargetRuns: async () => [],
        findRunByRecoveryAttemptId: async () => ({ id: 9008, runAttempt: 1 }),
      },
      control: {
        status: async () => ({
          data: eligibleControl({
            dispatchHolds: bound
              ? [{ ...hold, state: 'RUN_BOUND', runId: '9008', runAttempt: 1 }]
              : [hold],
          }),
        }),
        bindRun: async (body) => {
          bindCalls.push(body);
          bound = true;
        },
      },
      clock: () => NOW,
    });

    assert.deepEqual(bindCalls, [{
      recoveryAttemptId: hold.recoveryAttemptId,
      headSha: hold.headSha,
      runId: '9008',
      runAttempt: 1,
    }]);
    assert.equal(snapshot.controlState.dispatchHolds[0].state, 'RUN_BOUND');
  });

  it('closes a cancellation-before-job hold only after exact terminal source evidence proves POST never started', async () => {
    const hold = {
      state: 'DISPATCH_HELD',
      recoveryAttemptId: 'recovery-cancelled-before-job',
      headSha: HEAD,
      sourceRunId: '9001',
      sourceRunAttempt: 2,
      sourceHeadSha: 'b'.repeat(40),
    };
    const rejectCalls = [];
    let rejected = false;
    const snapshot = await readWatchdogSnapshot({
      github: {
        readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
        readTargetRunSummaries: async () => [],
        hydrateTargetRuns: async () => [],
        findRunByRecoveryAttemptId: async () => null,
        readSourceDispatchEvidence: async () => ({
          sourceRunId: hold.sourceRunId,
          sourceRunAttempt: hold.sourceRunAttempt,
          workflowPath: '.github/workflows/railway-deploy-trigger-watchdog.yml',
          event: 'schedule',
          ref: 'refs/heads/main',
          headSha: hold.sourceHeadSha,
          status: 'completed',
          conclusion: 'cancelled',
          dispatchJobName: WATCHDOG_DISPATCH_JOB_NAME,
          dispatchStepName: WATCHDOG_DISPATCH_STEP_NAME,
          jobs: [],
        }),
      },
      control: {
        status: async () => ({ data: eligibleControl({ dispatchHolds: rejected ? [] : [hold] }) }),
        rejectDispatch: async (body) => {
          rejectCalls.push(body);
          rejected = true;
        },
      },
      clock: () => NOW,
    });

    assert.deepEqual(snapshot.controlState.dispatchHolds, []);
    assert.equal(rejectCalls.length, 1);
    assert.equal(rejectCalls[0].reason, 'PRE_DISPATCH_NOT_STARTED');
    assert.equal(rejectCalls[0].sourceRunId, hold.sourceRunId);
    assert.equal(rejectCalls[0].sourceRunAttempt, hold.sourceRunAttempt);
    assert.match(rejectCalls[0].evidenceDigest, /^[0-9a-f]{64}$/);
  });

  it('keeps cancellation during the named POST step permanently ambiguous', async () => {
    const hold = {
      state: 'DISPATCH_HELD',
      recoveryAttemptId: 'recovery-cancelled-during-post',
      headSha: HEAD,
      sourceRunId: '9004',
      sourceRunAttempt: 1,
      sourceHeadSha: HEAD,
    };
    const rejectCalls = [];
    const snapshot = await readWatchdogSnapshot({
      github: {
        readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
        readTargetRunSummaries: async () => [],
        hydrateTargetRuns: async () => [],
        findRunByRecoveryAttemptId: async () => null,
        readSourceDispatchEvidence: async () => ({
          sourceRunId: hold.sourceRunId,
          sourceRunAttempt: hold.sourceRunAttempt,
          workflowPath: '.github/workflows/railway-deploy-trigger-watchdog.yml',
          event: 'workflow_dispatch',
          ref: 'refs/heads/main',
          headSha: HEAD,
          status: 'completed',
          conclusion: 'cancelled',
          dispatchJobName: WATCHDOG_DISPATCH_JOB_NAME,
          dispatchStepName: WATCHDOG_DISPATCH_STEP_NAME,
          jobs: [{
            id: 77,
            name: WATCHDOG_DISPATCH_JOB_NAME,
            status: 'completed',
            conclusion: 'cancelled',
            started_at: new Date(NOW - 60_000).toISOString(),
            steps: [{
              name: WATCHDOG_DISPATCH_STEP_NAME,
              status: 'completed',
              conclusion: 'cancelled',
            }],
          }],
        }),
      },
      control: {
        status: async () => ({ data: eligibleControl({ dispatchHolds: [hold] }) }),
        rejectDispatch: async (body) => { rejectCalls.push(body); },
      },
      clock: () => NOW,
    });

    assert.equal(snapshot.controlState.dispatchHolds[0].recoveryAttemptId, hold.recoveryAttemptId);
    assert.deepEqual(rejectCalls, []);
  });

  it('recovers a hold when the source run recorded a definitive rejection before cancellation', async () => {
    for (const [marker, reason] of [
      [PRE_DISPATCH_REJECTION_STEP_NAME, 'PRE_DISPATCH_NOT_STARTED'],
      [GITHUB_DISPATCH_REJECTION_STEP_NAME, 'DISPATCH_CONFIRMED_REJECTED'],
    ]) {
      const hold = {
        state: 'DISPATCH_HELD',
        recoveryAttemptId: `recovery-recorded-${reason.toLowerCase()}`,
        headSha: HEAD,
        sourceHeadSha: 'b'.repeat(40),
        sourceRunId: '9005',
        sourceRunAttempt: 1,
      };
      const rejectCalls = [];
      let rejected = false;
      const snapshot = await readWatchdogSnapshot({
        github: {
          readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
          readTargetRunSummaries: async () => [],
          hydrateTargetRuns: async () => [],
          findRunByRecoveryAttemptId: async () => null,
          readSourceDispatchEvidence: async () => ({
            sourceRunId: hold.sourceRunId,
            sourceRunAttempt: hold.sourceRunAttempt,
            workflowPath: '.github/workflows/railway-deploy-trigger-watchdog.yml',
            event: 'schedule',
            ref: 'refs/heads/main',
            headSha: hold.sourceHeadSha,
            status: 'completed',
            conclusion: 'cancelled',
            dispatchJobName: WATCHDOG_DISPATCH_JOB_NAME,
            dispatchStepName: WATCHDOG_DISPATCH_STEP_NAME,
            jobs: [{
              id: 78,
              name: WATCHDOG_DISPATCH_JOB_NAME,
              status: 'completed',
              conclusion: 'cancelled',
              steps: [
                { name: WATCHDOG_DISPATCH_STEP_NAME, status: 'completed', conclusion: 'success' },
                { name: marker, status: 'completed', conclusion: 'success' },
              ],
            }],
          }),
        },
        control: {
          status: async () => ({ data: eligibleControl({ dispatchHolds: rejected ? [] : [hold] }) }),
          rejectDispatch: async (body) => {
            rejectCalls.push(body);
            rejected = true;
          },
        },
        clock: () => NOW,
      });
      assert.deepEqual(snapshot.controlState.dispatchHolds, []);
      assert.equal(rejectCalls[0].reason, reason);
    }
  });

  it('remains observe-only when automatic recovery is false', async () => {
    const fixture = controllerFixture({ autoRecoveryEnabled: false });
    const result = await prepareRecoveryDispatch({
      ...fixture,
      clock: () => NOW,
      recoveryId: () => 'recovery-observe',
    });
    assert.equal(result.outcome, 'RECOVERY_ELIGIBLE_OBSERVE_ONLY');
    assert.equal(result.dispatchAuthorized, false);
    assert.ok(!fixture.events.includes('hold'));
    assert.ok(!fixture.events.includes('dispatch'));
  });

  it('separates hold authorization, one GitHub dispatch, exact verification, and durable binding', async () => {
    const fixture = controllerFixture();
    const prepared = await prepareRecoveryDispatch({
      ...fixture,
      clock: () => NOW,
      recoveryId: () => 'recovery-exact',
    });
    const dispatched = await dispatchGitHubRecovery({
      github: fixture.github,
      expectedHeadSha: prepared.headSha,
      recoveryAttemptId: prepared.recoveryAttemptId,
      sourceRunId: fixture.sourceRunId,
      sourceRunAttempt: fixture.sourceRunAttempt,
    });
    assert.equal(dispatched.outcome, 'RECOVERY_DISPATCH_ACCEPTED');
    assert.equal(dispatched.runId, '808');
    assert.equal(dispatched.runAttempt, 1);
    assert.deepEqual(fixture.events, [
      'main:1', 'runs', 'status', 'main:2', 'source', 'hold', 'main:3', 'dispatch', 'verify',
    ]);
    assert.ok(!fixture.events.includes('bind'));
  });

  it('reports authorization distinctly before the actions-write dispatch phase', async () => {
    const fixture = controllerFixture();
    const prepared = await prepareRecoveryDispatch({
      ...fixture,
      clock: () => NOW,
      recoveryId: () => 'recovery-authorized',
    });
    assert.equal(prepared.outcome, 'RECOVERY_AUTHORIZED');
    assert.equal(prepared.dispatchAuthorized, true);
    assert.deepEqual(fixture.holdBodies, [{
      recoveryAttemptId: 'recovery-authorized',
      headSha: HEAD,
      sourceHeadSha: HEAD,
      sourceRunId: '9000',
      sourceRunAttempt: 3,
    }]);
    assert.ok(fixture.events.includes('hold'));
    assert.ok(!fixture.events.includes('dispatch'));
  });

  it('binds a hold to the source workflow frozen head separately from current main', async () => {
    const fixture = controllerFixture();
    fixture.github.readSourceRunIdentity = async ({ sourceRunId, sourceRunAttempt }) => ({
      sourceRunId: String(sourceRunId),
      sourceRunAttempt,
      headSha: 'b'.repeat(40),
    });
    const prepared = await prepareRecoveryDispatch({
      ...fixture,
      clock: () => NOW,
      recoveryId: () => 'recovery-source-head',
    });
    assert.equal(prepared.headSha, HEAD);
    assert.equal(fixture.holdBodies[0].headSha, HEAD);
    assert.equal(fixture.holdBodies[0].sourceHeadSha, 'b'.repeat(40));
  });

  it('closes a pre-POST hold only in the separate watchdog-capability phase', async () => {
    const fixture = controllerFixture({ mainSequence: [HEAD, HEAD, 'b'.repeat(40)] });
    const prepared = await prepareRecoveryDispatch({
      ...fixture,
      clock: () => NOW,
      recoveryId: () => 'recovery-moved',
    });
    const dispatched = await dispatchGitHubRecovery({
      github: fixture.github,
      expectedHeadSha: prepared.headSha,
      recoveryAttemptId: prepared.recoveryAttemptId,
      sourceRunId: fixture.sourceRunId,
      sourceRunAttempt: fixture.sourceRunAttempt,
    });
    assert.equal(dispatched.outcome, 'PRE_DISPATCH_NOT_STARTED');
    assert.deepEqual(fixture.rejectBodies, []);
    const rejected = await rejectAuthorizedRecovery({
      control: fixture.control,
      expectedHeadSha: prepared.headSha,
      recoveryAttemptId: prepared.recoveryAttemptId,
      sourceRunId: fixture.sourceRunId,
      sourceRunAttempt: fixture.sourceRunAttempt,
      rejection: dispatched.rejection,
    });
    assert.equal(rejected.outcome, 'RECOVERY_DISPATCH_REJECTED');
    assert.equal(fixture.rejectBodies[0].reason, 'PRE_DISPATCH_NOT_STARTED');
    assert.ok(!fixture.events.includes('dispatch'));
  });

  it('returns definitive pre-POST evidence when the exact main read exits', async () => {
    const result = await dispatchGitHubRecovery({
      github: {
        readMainAndGate: async () => { throw new Error('read failed'); },
      },
      expectedHeadSha: HEAD,
      recoveryAttemptId: 'recovery-read-exit',
      sourceRunId: '9010',
      sourceRunAttempt: 4,
    });

    assert.equal(result.outcome, 'PRE_DISPATCH_NOT_STARTED');
    assert.equal(result.rejection.reason, 'PRE_DISPATCH_NOT_STARTED');
    assert.equal(result.rejection.evidence.sourceRunId, '9010');
    assert.equal(result.rejection.evidence.sourceRunAttempt, 4);
  });

  it('leaves an ambiguous durable hold after a lost or 5xx dispatch response', async () => {
    for (const error of [
      new GitHubWatchdogError('GITHUB_DISPATCH_AMBIGUOUS', 'lost', { ambiguous: true }),
      new GitHubWatchdogError('GITHUB_DISPATCH_AMBIGUOUS', 'HTTP 503', { status: 503, ambiguous: true }),
    ]) {
      const fixture = controllerFixture({ dispatchError: error });
      const result = await dispatchGitHubRecovery({
        github: fixture.github,
        expectedHeadSha: HEAD,
        recoveryAttemptId: 'recovery-ambiguous',
        sourceRunId: fixture.sourceRunId,
        sourceRunAttempt: fixture.sourceRunAttempt,
      });
      assert.equal(result.outcome, 'DEFERRED_AMBIGUOUS');
      assert.equal(fixture.events.filter((event) => event === 'dispatch').length, 1);
      assert.equal(result.rejection, undefined);
    }
  });

  it('returns closable evidence only after a definitive dispatch rejection', async () => {
    const result = await dispatchGitHubRecovery({
      github: {
        readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
        dispatchRecovery: async () => {
          throw new GitHubWatchdogError('GITHUB_DISPATCH_REJECTED', 'HTTP 422', { status: 422 });
        },
      },
      expectedHeadSha: HEAD,
      recoveryAttemptId: 'recovery-rejected',
      sourceRunId: '9011',
      sourceRunAttempt: 1,
    });
    assert.equal(result.outcome, 'DISPATCH_CONFIRMED_REJECTED');
    assert.equal(result.rejection.reason, 'DISPATCH_CONFIRMED_REJECTED');
    assert.equal(result.rejection.evidence.status, 422);
  });

  it('boundedly polls and verifies the exact run after a 204 dispatch', async () => {
    const events = [];
    let polls = 0;
    const result = await dispatchGitHubRecovery({
      github: {
        readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
        dispatchRecovery: async () => ({ runId: null }),
        findRunByRecoveryAttemptId: async (recoveryAttemptId) => {
          events.push(`poll:${recoveryAttemptId}`);
          polls += 1;
          return polls === 2 ? { id: 909, runAttempt: 1 } : null;
        },
        readDispatchedRunIdentity: async ({ runId, runAttempt }) => {
          events.push(`verify:${runId}:${runAttempt}`);
          return { id: String(runId), runAttempt };
        },
      },
      expectedHeadSha: HEAD,
      recoveryAttemptId: 'recovery-no-id',
      sleep: async (ms) => { events.push(`sleep:${ms}`); },
      correlationAttempts: 3,
    });

    assert.equal(result.outcome, 'RECOVERY_DISPATCH_ACCEPTED');
    assert.equal(result.runId, '909');
    assert.equal(result.runAttempt, 1);
    assert.equal(events.at(-1), 'verify:909:1');
    assert.equal(events.filter((event) => event.startsWith('sleep:')).length, 1);
  });

  it('keeps the hold and defers when a 204 dispatch cannot be correlated', async () => {
    const events = [];
    const result = await dispatchGitHubRecovery({
      github: {
        readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }),
        dispatchRecovery: async () => ({ runId: null }),
        findRunByRecoveryAttemptId: async () => { events.push('poll'); return null; },
      },
      expectedHeadSha: HEAD,
      recoveryAttemptId: 'recovery-uncorrelated',
      sleep: async () => { events.push('sleep'); },
      correlationAttempts: 3,
    });

    assert.equal(result.outcome, 'DEFERRED_AMBIGUOUS');
    assert.equal(result.recoveryAttemptId, 'recovery-uncorrelated');
    assert.deepEqual(events, ['poll', 'sleep', 'poll', 'sleep', 'poll']);
    assert.equal(result.rejection, undefined);
  });
});

// A manual-only watchdog has no later scheduled run that can turn a warning
// into a failure. The current invocation must therefore go red on its first
// unreadable GitHub result.
describe('manual watchdog read-failure exit', () => {
  it('keeps ambiguity from a non-GitHub dependency separate from read blindness', async () => {
    assert.deepEqual(
      await resolveReadFailureExit({
        result: { outcome: 'DEFERRED_AMBIGUOUS', readFailureCode: null },
      }),
      { failJob: false, reason: null },
    );
  });

  it('fails the first manual invocation that cannot read GitHub', async () => {
    assert.deepEqual(
      await resolveReadFailureExit({
        result: { outcome: 'DEFERRED_AMBIGUOUS', readFailureCode: 'GITHUB_READ_BUDGET_EXCEEDED' },
      }),
      {
        failJob: true,
        reason: 'the manual watchdog could not read GitHub (GITHUB_READ_BUDGET_EXCEEDED)',
      },
    );
  });

  it('reports a GitHub read failure distinctly from a control-plane failure', async () => {
    const github = {
      readMainAndGate: async () => {
        throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'GitHub returned HTTP 500', { status: 500 });
      },
      readTargetRunSummaries: async () => [],
      hydrateTargetRuns: async () => [],
    };
    const blind = await prepareRecoveryDispatch({
      github,
      control: { status: async () => ({ data: {} }) },
      clock: () => NOW,
    });
    assert.equal(blind.outcome, 'DEFERRED_AMBIGUOUS');
    assert.equal(blind.readFailureCode, 'GITHUB_READ_FAILED');

    const controlDown = await prepareRecoveryDispatch({
      github: { ...github, readMainAndGate: async () => ({ sha: HEAD, gate: { state: 'success' } }) },
      control: { status: async () => { throw new Error('control plane unreachable'); } },
      clock: () => NOW,
    });
    assert.equal(controlDown.outcome, 'DEFERRED_AMBIGUOUS');
    assert.equal(controlDown.readFailureCode, null);
  });

  it('preserves GitHub blindness when the control-plane rejection settles first', async () => {
    const order = [];
    const github = {
      readMainAndGate: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push('github');
        throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'GitHub returned HTTP 500', { status: 500 });
      },
      readTargetRunSummaries: async () => [],
    };
    const blind = await prepareRecoveryDispatch({
      github,
      control: {
        status: async () => {
          order.push('control');
          throw new Error('control plane unreachable');
        },
      },
      clock: () => NOW,
    });

    assert.deepEqual(order, ['control', 'github']);
    assert.equal(blind.outcome, 'DEFERRED_AMBIGUOUS');
    assert.equal(blind.readFailureCode, 'GITHUB_READ_FAILED');
    assert.deepEqual(
      await resolveReadFailureExit({ result: blind }),
      {
        failJob: true,
        reason: 'the manual watchdog could not read GitHub (GITHUB_READ_FAILED)',
      },
    );
  });

  // The marker step name is the contract between the controller and workflow.
  it('pins the workflow marker step to the controller constant', () => {
    const workflow = readFileSync(
      resolve(fileURLToPath(new URL('../.github/workflows/', import.meta.url)), WATCHDOG_SOURCE_WORKFLOW_FILE),
      'utf8',
    );
    assert.match(
      workflow,
      new RegExp(`^ {6}- name: ${WATCHDOG_READ_FAILURE_STEP_NAME}$`, 'm'),
    );
    // `always()` records the read failure even after the controller step fails.
    assert.match(
      workflow,
      /^ {8}if: always\(\) && steps\.controller\.outputs\.read_failure == 'true'$/m,
    );
  });
});

describe('watchdog phase process contract', () => {
  it('fails every phase, classify included, when the controller cannot run at all', () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'railway-watchdog-cli-'));
    try {
      for (const phase of ['classify', 'dispatch']) {
        const outputPath = resolve(tempRoot, `${phase}.output`);
        const result = spawnSync(process.execPath, [SCRIPT, '--phase', phase], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            GITHUB_REPOSITORY: 'o/r',
            GH_TOKEN: '',
          },
        });

        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /::warning::DEFERRED_AMBIGUOUS:/);
        assert.match(result.stdout, /::error::WATCHDOG_PHASE_FAILED:/);
        assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).outcome, 'DEFERRED_AMBIGUOUS');
        const output = readFileSync(outputPath, 'utf8');
        assert.match(output, /^outcome=DEFERRED_AMBIGUOUS$/m);
        // A crash is not a classified GitHub read-path failure, so the
        // diagnostic marker remains skipped.
        assert.match(output, /^read_failure=false$/m);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
