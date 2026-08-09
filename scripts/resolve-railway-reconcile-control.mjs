#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';
import {
  RailwayReconcileControlClient,
  canonicalJson,
} from './railway-reconcile-control-client.mjs';
import { readDeployments, readRepositoryServices } from './railway-cli.mjs';
import { IN_FLIGHT_STATUSES } from './railway-deployments.mjs';

export const RECOVERY_PROTOCOL_VERSION = 1;
export const TARGET_WORKFLOW = 'railway-deploy-trigger.yml';
export const BREAKGLASS_ENVIRONMENT = 'ingestion-acceptance-production-breakglass';
export const LEASE_DURATION_MS = 30 * 60 * 1000;
export const TERMINATION_GRACE_MS = 5 * 60 * 1000;
export const NETWORK_CLOCK_MARGIN_MS = 60 * 1000;
export const SAFETY_MARGIN_MS = 6 * 60 * 1000;
export const OUTAGE_RETRY_MIN_WAIT_MS = LEASE_DURATION_MS
  + TERMINATION_GRACE_MS
  + NETWORK_CLOCK_MARGIN_MS
  + SAFETY_MARGIN_MS;
export const RECOVERY_GITHUB_MAX_PAGES = 10;
export const RECOVERY_GITHUB_MAX_REQUESTS = 100;
export const RECOVERY_GITHUB_REQUEST_TIMEOUT_MS = 10_000;

const API_VERSION = '2026-03-10';
const DECISIONS = new Set([
  'resolve_pre_mutation_hold',
  'accept_observed_convergence',
  'authorize_current_main_retry',
]);
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const TERMINAL_STATUS = 'completed';
const PROOF_MAX_AGE_MS = 10 * 60 * 1000;
export const MUTATION_BOUNDARY_STEP_NAMES = Object.freeze([
  'Trigger deploys for services this merge changed',
  'Mark Railway mutation started',
  'Record manual-required reconciliation state',
]);
export const MUTATION_BOUNDARY_FALLBACK_STEP_NAMES = Object.freeze([
  'Trigger lease-fenced deploys for the exact green head',
]);
const MUTATION_BOUNDARY_STEPS = new Set(MUTATION_BOUNDARY_STEP_NAMES);
const MUTATION_BOUNDARY_FALLBACK_STEPS = new Set(MUTATION_BOUNDARY_FALLBACK_STEP_NAMES);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9]|\[bot\])?$/;

export class RecoveryResolutionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'RecoveryResolutionError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new RecoveryResolutionError(code, message, options);
}

function exactKeys(value, expected, code = 'EVIDENCE_SCHEMA_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, 'expected a JSON object');
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `closed schema expected only: ${wanted.join(', ')}`);
  }
}

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail('IDENTIFIER_INVALID', `${name} must be an allowlisted 8-128 character identifier`);
  }
  return value;
}

function requireRunId(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,23}$/.test(value)) {
    fail('RUN_ID_INVALID', `${name} must be a decimal GitHub run ID`);
  }
  return value;
}

function requireAttempt(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    fail('RUN_ATTEMPT_INVALID', `${name} must be a positive safe integer`);
  }
  return value;
}

function requireActor(value, name) {
  if (typeof value !== 'string' || value.length > 100 || !ACTOR.test(value)) {
    fail('ACTOR_INVALID', `${name} is not a valid GitHub actor`);
  }
  return value;
}

function requireApprover(value) {
  if (typeof value !== 'string' || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)) {
    fail('APPROVER_INVALID', 'approver must be an allowlisted audit identity');
  }
  return value;
}

function requireTimestamp(value, name, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail('TIMESTAMP_INVALID', `${name} must be a millisecond ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) fail('TIMESTAMP_INVALID', `${name} cannot be in the future`);
  return parsed;
}

function sanitizeReason(value) {
  if (typeof value !== 'string') return null;
  const sanitized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (sanitized !== value || sanitized.length < 10 || sanitized.length > 240
    || /[`<>[\]]/.test(sanitized)
    || /(?:https?:\/\/|www\.)/i.test(sanitized)
    || /(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|bearer\s+|-----BEGIN|(?:secret|token|api[_ -]?key)\s*[:=])/i.test(sanitized)
    || sanitized.includes('${{') || sanitized.includes('::')) return null;
  return sanitized;
}

function validateRetryEvidence(value, now, outerEvidenceId) {
  exactKeys(value, ['kind', 'evidenceId', ...(value?.kind === 'outage_wait' ? [
    'automaticEntrantsDisabledAt', 'allJobsTerminatedAt', 'lastPossibleLeaseAcquiredAt', 'auditedAt',
  ] : ['auditedAt'])]);
  requireIdentifier(value.evidenceId, 'retryEvidence.evidenceId');
  if (value.evidenceId === outerEvidenceId) {
    fail('RETRY_EVIDENCE_NOT_SEPARATE', 'retry evidence must have a separate audit identifier');
  }
  if (value.kind === 'terminal_inactive') {
    requireTimestamp(value.auditedAt, 'retryEvidence.auditedAt', now);
    return;
  }
  if (value.kind !== 'outage_wait') fail('EVIDENCE_SCHEMA_INVALID', 'retry evidence kind is unsupported');
  const disabledAt = requireTimestamp(value.automaticEntrantsDisabledAt, 'automaticEntrantsDisabledAt', now);
  const terminatedAt = requireTimestamp(value.allJobsTerminatedAt, 'allJobsTerminatedAt', now);
  const acquiredAt = requireTimestamp(value.lastPossibleLeaseAcquiredAt, 'lastPossibleLeaseAcquiredAt', now);
  const auditedAt = requireTimestamp(value.auditedAt, 'retryEvidence.auditedAt', now);
  if (disabledAt > terminatedAt || acquiredAt > terminatedAt) {
    fail('OUTAGE_EVIDENCE_ORDER_INVALID', 'entrants must be disabled and the last acquisition identified before job termination');
  }
  const safeAfter = Math.max(acquiredAt + LEASE_DURATION_MS, terminatedAt)
    + TERMINATION_GRACE_MS + NETWORK_CLOCK_MARGIN_MS + SAFETY_MARGIN_MS;
  if (auditedAt < safeAfter || now < safeAfter) {
    fail('OUTAGE_WAIT_INSUFFICIENT', 'outage retry requires the full 42 minute minimum plus any later job termination');
  }
}

function validateEvidence(value, decision, now) {
  exactKeys(value, [
    'version', 'evidenceId', 'runEvidenceId', 'environmentEvidenceId', 'priorKind',
    'priorCreatedAt', 'targetRunId', 'targetRunAttempt', 'decisionEvidence',
  ]);
  if (value.version !== RECOVERY_PROTOCOL_VERSION) fail('EVIDENCE_VERSION_UNSUPPORTED', 'evidence version is unsupported');
  requireIdentifier(value.evidenceId, 'evidenceId');
  requireIdentifier(value.runEvidenceId, 'runEvidenceId');
  requireIdentifier(value.environmentEvidenceId, 'environmentEvidenceId');
  if (!['attempt', 'dispatch_hold'].includes(value.priorKind)) fail('EVIDENCE_SCHEMA_INVALID', 'priorKind is unsupported');
  requireTimestamp(value.priorCreatedAt, 'priorCreatedAt', now);
  if ((value.targetRunId === null) !== (value.targetRunAttempt === null)) {
    fail('EVIDENCE_SCHEMA_INVALID', 'target run ID and attempt must both be null or both be present');
  }
  if (value.targetRunId !== null) {
    requireRunId(value.targetRunId, 'targetRunId');
    requireAttempt(value.targetRunAttempt, 'targetRunAttempt');
  }

  const details = value.decisionEvidence;
  if (decision === 'resolve_pre_mutation_hold') {
    exactKeys(details, ['kind', 'mutationBoundaryCrossed']);
    if (details.kind !== 'pre_mutation_hold' || details.mutationBoundaryCrossed !== false) {
      fail('MUTATION_BOUNDARY_NOT_PROVEN', 'hold resolution requires positive pre-mutation evidence');
    }
  } else if (decision === 'accept_observed_convergence') {
    if (value.priorKind !== 'attempt') fail('EVIDENCE_SCHEMA_INVALID', 'convergence acceptance requires an attempt prior');
    if (value.targetRunId === null) {
      fail('TARGET_RUN_REQUIRED', 'convergence acceptance requires an exact target run and attempt');
    }
    exactKeys(details, ['kind', 'resultManifest']);
    if (details.kind !== 'observed_convergence' || !details.resultManifest
      || typeof details.resultManifest !== 'object' || Array.isArray(details.resultManifest)) {
      fail('EVIDENCE_SCHEMA_INVALID', 'observed convergence requires one result manifest object');
    }
  } else {
    exactKeys(details, ['kind', 'providerCallsActive', 'retryEvidence']);
    if (details.kind !== 'current_main_retry' || details.providerCallsActive !== false) {
      fail('PROVIDER_ACTIVITY_NOT_CLEARED', 'retry requires positive evidence that no provider call remains active');
    }
    if (details.retryEvidence?.kind !== 'outage_wait' && value.targetRunId === null) {
      fail('TARGET_RUN_REQUIRED', 'terminal retry evidence requires an exact target run and attempt');
    }
    validateRetryEvidence(details.retryEvidence, now, value.evidenceId);
  }
  return value;
}

export function validateRecoveryRequest(value, { now = Date.now } = {}) {
  exactKeys(value, [
    'version', 'decision', 'priorId', 'expectedCurrentHead', 'reason', 'actor',
    'approver', 'triggeringActor', 'operatorRunId', 'operatorRunAttempt', 'evidence',
  ], 'REQUEST_SCHEMA_INVALID');
  if (value.version !== RECOVERY_PROTOCOL_VERSION) fail('REQUEST_VERSION_UNSUPPORTED', 'request version is unsupported');
  if (!DECISIONS.has(value.decision)) fail('DECISION_INVALID', 'operator decision is not in the closed vocabulary');
  requireIdentifier(value.priorId, 'priorId');
  if (typeof value.expectedCurrentHead !== 'string' || !/^[0-9a-f]{40}$/.test(value.expectedCurrentHead)) {
    fail('HEAD_SHA_INVALID', 'expectedCurrentHead must be an exact lowercase commit SHA');
  }
  if (!sanitizeReason(value.reason)) fail('REASON_INVALID', 'reason must be a sanitized single line of 10-240 characters');
  requireActor(value.actor, 'actor');
  requireApprover(value.approver);
  if (value.actor === value.approver) fail('ACTOR_APPROVER_MUST_DIFFER', 'actor and approver must be distinct');
  requireActor(value.triggeringActor, 'triggeringActor');
  requireRunId(value.operatorRunId, 'operatorRunId');
  requireAttempt(value.operatorRunAttempt, 'operatorRunAttempt');
  validateEvidence(value.evidence, value.decision, now());
  return structuredClone(value);
}

function numericId(value, name) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return requireRunId(text, name);
}

export class ReadOnlyGitHubClient {
  constructor({
    repository,
    token,
    fetchImpl = (...args) => globalThis.fetch(...args),
    apiUrl = 'https://api.github.com',
    now = Date.now,
    maxRequests = RECOVERY_GITHUB_MAX_REQUESTS,
    requestTimeoutMs = RECOVERY_GITHUB_REQUEST_TIMEOUT_MS,
  }) {
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new TypeError('repository must be owner/name');
    }
    if (typeof token !== 'string' || token.length < 1) throw new TypeError('read-only GitHub token is required');
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
      throw new TypeError('GitHub evidence readers must be functions');
    }
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 500) {
      throw new TypeError('recovery GitHub request budget must be an integer from 1 to 500');
    }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new TypeError('recovery GitHub timeout must be an integer from 1 to 30000ms');
    }
    const base = new URL(apiUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') {
      throw new TypeError('GitHub API base must be one credential-free HTTPS origin');
    }
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiUrl = base.origin;
    this.now = now;
    this.maxRequests = maxRequests;
    this.requestCount = 0;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  #isAllowed(url) {
    const base = `/repos/${this.repository}`;
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const page = url.searchParams.get('page');
    const paginated = page !== null && /^[1-9]\d*$/.test(page);
    const exactQuery = (expected) => {
      const actual = [...url.searchParams.entries()];
      return actual.length === Object.keys(expected).length
        && actual.every(([key, value]) => expected[key] === value);
    };
    if (url.pathname === `${base}/git/ref/heads/main`) return url.search === '';
    if (new RegExp(`^${escapedBase}/commits/[0-9a-f]{40}/statuses$`).test(url.pathname)) {
      return paginated && exactQuery({ per_page: '100', page });
    }
    if (new RegExp(`^${escapedBase}/actions/runs/[1-9]\\d{0,23}$`).test(url.pathname)) {
      return url.search === '';
    }
    if (url.pathname === `${base}/actions/workflows/${TARGET_WORKFLOW}/runs`) {
      const common = { filter: 'all', per_page: '100', page };
      const created = url.searchParams.get('created');
      const status = url.searchParams.get('status');
      return paginated && (
        (/^(?:>=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.test(created ?? '')
          && exactQuery({ ...common, created }))
        || (ACTIVE_STATUSES.has(status) && exactQuery({ ...common, status }))
      );
    }
    return new RegExp(
      `^${escapedBase}/actions/runs/[1-9]\\d{0,23}/attempts/[1-9]\\d{0,3}/jobs$`,
    ).test(url.pathname)
      && paginated
      && exactQuery({ filter: 'all', per_page: '100', page });
  }

  async request(method, path) {
    const url = new URL(path, this.apiUrl);
    if (method !== 'GET' || url.origin !== this.apiUrl || !this.#isAllowed(url)) {
      fail('GITHUB_ROUTE_FORBIDDEN', 'GitHub evidence client allows only read-only recovery proof routes');
    }
    this.requestCount += 1;
    if (this.requestCount > this.maxRequests) {
      fail('GITHUB_EVIDENCE_BUDGET_EXCEEDED', 'GitHub recovery evidence exceeded its request budget');
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('GitHub recovery request timed out', 'TimeoutError')),
      this.requestTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(url.href, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'user-agent': 'worldmonitor-railway-recovery-proof',
          'x-github-api-version': API_VERSION,
        },
      });
      if (!(response instanceof Response) || response.redirected || !response.ok
        || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        fail('GITHUB_EVIDENCE_UNREADABLE', 'GitHub recovery evidence could not be read');
      }
      try {
        return await response.json();
      } catch (cause) {
        if (controller.signal.aborted) {
          fail('GITHUB_EVIDENCE_TIMEOUT', 'GitHub recovery evidence exceeded its request timeout', { cause });
        }
        fail('GITHUB_EVIDENCE_MALFORMED', 'GitHub recovery evidence was malformed JSON', { cause });
      }
    } catch (cause) {
      if (cause instanceof RecoveryResolutionError) throw cause;
      if (controller.signal.aborted) {
        fail('GITHUB_EVIDENCE_TIMEOUT', 'GitHub recovery evidence exceeded its request timeout', { cause });
      }
      fail('GITHUB_EVIDENCE_UNREADABLE', 'GitHub recovery evidence could not be read', { cause });
    } finally {
      clearTimeout(timeout);
    }
  }

  #assertPage(page) {
    if (page > RECOVERY_GITHUB_MAX_PAGES) {
      fail('GITHUB_EVIDENCE_BUDGET_EXCEEDED', 'GitHub recovery pagination exceeded its page budget');
    }
  }

  async readCurrentGreenMain(expectedHead) {
    const ref = await this.request('GET', `/repos/${this.repository}/git/ref/heads/main`);
    const head = ref?.object?.sha;
    if (head !== expectedHead) fail('CURRENT_HEAD_MISMATCH', 'current main is not the exact expected head');
    const statuses = [];
    for (let page = 1; ; page += 1) {
      this.#assertPage(page);
      const batch = await this.request(
        'GET',
        `/repos/${this.repository}/commits/${expectedHead}/statuses?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) fail('GITHUB_EVIDENCE_MALFORMED', 'commit statuses were not an array');
      statuses.push(...batch);
      if (batch.length < 100) break;
    }
    const gate = statuses.find((status) => status?.context === 'gate');
    if (gate?.state !== 'success') fail('CURRENT_GATE_NOT_GREEN', 'newest gate status for current main is not success');
    return {
      headSha: head,
      gateStatusId: numericId(gate.id, 'gateStatusId'),
      gateState: gate.state,
      gateUpdatedAt: gate.updated_at,
    };
  }

  async #readTargetRunPages(query) {
    let expectedTotal = null;
    const runs = [];
    for (let page = 1; ; page += 1) {
      this.#assertPage(page);
      const body = await this.request(
        'GET',
        `/repos/${this.repository}/actions/workflows/${TARGET_WORKFLOW}/runs?${query}&page=${page}`,
      );
      if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.workflow_runs)) {
        fail('GITHUB_EVIDENCE_MALFORMED', 'workflow run pagination schema is invalid');
      }
      if (expectedTotal === null) expectedTotal = body.total_count;
      if (body.total_count !== expectedTotal) fail('GITHUB_PAGINATION_CHANGED', 'workflow run inventory changed during pagination');
      runs.push(...body.workflow_runs);
      if (runs.length >= expectedTotal) break;
      if (body.workflow_runs.length === 0) fail('GITHUB_PAGINATION_INCOMPLETE', 'workflow run pagination ended early');
    }
    const ids = runs.map((run) => numericId(run?.id, 'workflowRunId'));
    if (new Set(ids).size !== ids.length || runs.length !== expectedTotal) {
      fail('GITHUB_PAGINATION_INCOMPLETE', 'workflow run pagination was duplicated or incomplete');
    }
    return runs;
  }

  async readTargetRun(runId) {
    const id = requireRunId(runId, 'workflowRunId');
    const run = await this.request('GET', `/repos/${this.repository}/actions/runs/${id}`);
    if (numericId(run?.id, 'workflowRunId') !== id) {
      fail('GITHUB_EVIDENCE_MALFORMED', 'exact workflow run response did not match its ID');
    }
    return run;
  }

  async readActiveTargetRuns() {
    const runs = [];
    for (const status of ACTIVE_STATUSES) {
      runs.push(...await this.#readTargetRunPages(`filter=all&per_page=100&status=${status}`));
    }
    return [...new Map(runs.map((run) => [numericId(run.id, 'workflowRunId'), run])).values()];
  }

  async #readCreatedTargetRuns(createdFilter) {
    const created = encodeURIComponent(createdFilter);
    const incidentRuns = await this.#readTargetRunPages(
      `created=${created}&filter=all&per_page=100`,
    );
    const active = await this.readActiveTargetRuns();
    return [...new Map(
      [...incidentRuns, ...active].map((run) => [numericId(run.id, 'workflowRunId'), run]),
    ).values()];
  }

  async readTargetRunsCreatedBetween(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      fail('GITHUB_EVIDENCE_UNREADABLE', 'recovery incident interval was invalid');
    }
    return this.#readCreatedTargetRuns(
      `${new Date(from).toISOString()}..${new Date(to).toISOString()}`,
    );
  }

  async readAllAttemptJobs(runId, runAttempt) {
    const jobs = [];
    let expectedTotal = null;
    for (let page = 1; ; page += 1) {
      this.#assertPage(page);
      const body = await this.request(
        'GET',
        `/repos/${this.repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?filter=all&per_page=100&page=${page}`,
      );
      if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.jobs)) {
        fail('GITHUB_EVIDENCE_MALFORMED', 'workflow job pagination schema is invalid');
      }
      if (expectedTotal === null) expectedTotal = body.total_count;
      if (body.total_count !== expectedTotal) fail('GITHUB_PAGINATION_CHANGED', 'workflow job inventory changed during pagination');
      jobs.push(...body.jobs);
      if (jobs.length >= expectedTotal) break;
      if (body.jobs.length === 0) fail('GITHUB_PAGINATION_INCOMPLETE', 'workflow job pagination ended early');
    }
    const ids = jobs.map((job) => numericId(job?.id, 'workflowJobId'));
    if (new Set(ids).size !== ids.length || jobs.length !== expectedTotal) {
      fail('GITHUB_PAGINATION_INCOMPLETE', 'workflow job pagination was duplicated or incomplete');
    }
    return jobs;
  }
}

function titleContainsIdentifier(title, identifier) {
  return typeof title === 'string' && title.split(/[^A-Za-z0-9._:-]+/).includes(identifier);
}

function assertTargetWorkflowRun(run, request) {
  const workflowPath = `.github/workflows/${TARGET_WORKFLOW}`;
  const path = typeof run?.path === 'string' ? run.path : '';
  const pathMatches = path === workflowPath || path === `${workflowPath}@refs/heads/main`;
  const targetHead = run?.head_sha;
  const targetHeadIsValid = typeof targetHead === 'string' && /^[0-9a-f]{40}$/.test(targetHead);
  if (!pathMatches || !['workflow_run', 'workflow_dispatch'].includes(run?.event)
    || run?.head_branch !== 'main' || !targetHeadIsValid) {
    fail(
      'TARGET_RUN_IDENTITY_MISMATCH',
      'the evidence-bound run is not an allowed exact target workflow run on main',
    );
  }
  if (request.evidence.priorKind === 'dispatch_hold'
    && !titleContainsIdentifier(run.display_title, request.priorId)) {
    fail('TARGET_RUN_CORRELATION_MISMATCH', 'the dispatch-hold run lacks its exact recovery identifier');
  }
}

function countPossibleMutationBoundarySteps(jobs) {
  let count = 0;
  for (const job of jobs) {
    if (!Array.isArray(job.steps)) {
      fail('GITHUB_EVIDENCE_MALFORMED', 'workflow job steps were unavailable');
    }
    for (const step of job.steps) {
      if (MUTATION_BOUNDARY_STEPS.has(step?.name) && step?.conclusion !== 'skipped') count += 1;
      if (MUTATION_BOUNDARY_FALLBACK_STEPS.has(step?.name)
        && !['success', 'skipped'].includes(step?.conclusion)) {
        count += 1;
      }
    }
  }
  return count;
}

function outageIncidentInterval(request, observedAt) {
  const retryEvidence = request.evidence.decisionEvidence?.retryEvidence;
  if (retryEvidence?.kind !== 'outage_wait') return null;
  const incidentStart = Math.min(
    Date.parse(retryEvidence.automaticEntrantsDisabledAt),
    Date.parse(retryEvidence.lastPossibleLeaseAcquiredAt),
  );
  return {
    from: incidentStart - OUTAGE_RETRY_MIN_WAIT_MS,
    to: observedAt,
  };
}

function semanticallyEqualGitHubProof(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftEvidence = { ...left };
  const rightEvidence = { ...right };
  delete leftEvidence.observedAt;
  delete rightEvidence.observedAt;
  return canonicalJson(leftEvidence) === canonicalJson(rightEvidence);
}

async function collectGitHubProof(request, githubClient, observedAt) {
  const before = await githubClient.readCurrentGreenMain(request.expectedCurrentHead);
  const targetId = request.evidence.targetRunId;
  let runs;
  if (targetId === null) {
    const interval = outageIncidentInterval(request, observedAt) ?? {
      from: Date.parse(request.evidence.priorCreatedAt),
      to: observedAt,
    };
    runs = await githubClient.readTargetRunsCreatedBetween(interval.from, interval.to);
  } else {
    runs = [...new Map([
      ...await githubClient.readActiveTargetRuns(),
      await githubClient.readTargetRun(targetId),
    ].map((run) => [numericId(run.id, 'workflowRunId'), run])).values()];
  }
  const matching = runs.filter((run) => numericId(run.id, 'workflowRunId') === targetId
    || titleContainsIdentifier(run.display_title, request.priorId));
  if (targetId !== null && !matching.some((run) => numericId(run.id, 'workflowRunId') === targetId)) {
    fail('TARGET_RUN_NOT_FOUND', 'the evidence-bound target run was not found in complete workflow history');
  }
  if (targetId !== null) {
    const target = matching.find((run) => numericId(run.id, 'workflowRunId') === targetId);
    assertTargetWorkflowRun(target, request);
    if (request.evidence.targetRunAttempt
      > requireAttempt(target.run_attempt, 'workflowRunAttempt')) {
      fail('TARGET_RUN_ATTEMPT_MISMATCH', 'the evidence-bound run attempt is outside the complete attempt history');
    }
  }
  const attempts = [];
  for (const run of matching) {
    const runId = numericId(run.id, 'workflowRunId');
    const runAttempt = requireAttempt(run.run_attempt, 'workflowRunAttempt');
    if (ACTIVE_STATUSES.has(run.status) || run.status !== TERMINAL_STATUS) {
      fail('MATCHING_WORK_ACTIVE', 'a matching target workflow run is still active or has an unknown status');
    }
    for (let attempt = 1; attempt <= runAttempt; attempt += 1) {
      const jobs = await githubClient.readAllAttemptJobs(runId, attempt);
      if (jobs.some((job) => ACTIVE_STATUSES.has(job.status) || job.status !== TERMINAL_STATUS)) {
        fail('MATCHING_WORK_ACTIVE', 'a matching target workflow job is still active or has an unknown status');
      }
      const possibleMutationBoundarySteps = countPossibleMutationBoundarySteps(jobs);
      if (request.decision === 'resolve_pre_mutation_hold' && possibleMutationBoundarySteps > 0) {
        fail(
          'MUTATION_BOUNDARY_NOT_PROVEN',
          'matching workflow history contains a mutation-boundary or manual-required step',
        );
      }
      attempts.push({
        runId,
        runAttempt: attempt,
        jobCount: jobs.length,
        terminalJobCount: jobs.filter((job) => job.status === TERMINAL_STATUS).length,
        possibleMutationBoundarySteps,
      });
    }
  }
  const after = await githubClient.readCurrentGreenMain(request.expectedCurrentHead);
  if (canonicalJson(before) !== canonicalJson(after)) {
    fail('GITHUB_EVIDENCE_CHANGED', 'main or its newest gate changed while recovery evidence was collected');
  }
  return {
    version: 1,
    repository: githubClient.repository,
    targetWorkflow: TARGET_WORKFLOW,
    observedAt: new Date(observedAt).toISOString(),
    ...after,
    matchingRuns: matching.map((run) => ({
      runId: numericId(run.id, 'workflowRunId'),
      runAttempt: requireAttempt(run.run_attempt, 'workflowRunAttempt'),
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    })),
    attempts,
  };
}

function digestRequest(request) {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

export function createOperatorOperationId(request) {
  return createHash('sha256').update(canonicalJson({
    version: request.version,
    decision: request.decision,
    priorId: request.priorId,
    priorCreatedAt: request.evidence.priorCreatedAt,
    expectedCurrentHead: request.expectedCurrentHead,
    actor: request.actor,
    approver: request.approver,
    reason: request.reason,
    targetRunId: request.evidence.targetRunId,
    targetRunAttempt: request.evidence.targetRunAttempt,
  })).digest('hex');
}

function targetRunHead(githubProof, request) {
  if (request.evidence.targetRunId === null) return null;
  const target = githubProof?.matchingRuns?.find(
    (run) => run.runId === request.evidence.targetRunId,
  );
  if (!target || typeof target.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(target.headSha)) {
    fail('TARGET_RUN_IDENTITY_MISMATCH', 'the exact target run head was not retained in GitHub evidence');
  }
  return target.headSha;
}

function assertManifestProducer(resultManifest, request, repository, githubProof) {
  const intent = resultManifest?.intent;
  const producer = intent?.producer;
  const targetRunId = request.evidence.targetRunId;
  const targetRunAttempt = request.evidence.targetRunAttempt;
  const incidentHead = targetRunHead(githubProof, request);
  if (!intent || !producer || targetRunId === null
    || intent.attemptId !== request.priorId
    || intent.headSha !== incidentHead
    || producer.repository !== repository
    || producer.workflow !== TARGET_WORKFLOW
    || String(producer.runId) !== targetRunId
    || producer.runAttempt !== targetRunAttempt
    || intent.owner !== `github-run:${targetRunId}:${targetRunAttempt}`) {
    fail(
      'MANIFEST_PRODUCER_MISMATCH',
      'result manifest is not bound to the evidence-bound target workflow producer',
    );
  }
}

function validateConvergenceProof(result, request, incidentHead) {
  if (!result || result.ok !== true || result.attemptId !== request.priorId
    || result.headSha !== incidentHead || result.strict?.ok !== true
    || !/^[0-9a-f]{64}$/.test(result.intentDigest) || !/^[0-9a-f]{64}$/.test(result.resultDigest)
    || !Array.isArray(result.acceptedDeploymentIds)) {
    fail('CONVERGENCE_PROOF_INVALID', 'strict observed convergence did not prove the exact prior attempt and head');
  }
  return result;
}

export async function buildRecoveryProof(uncheckedRequest, {
  githubClient,
  verifyConvergence,
  verifyProviderInactive,
  now = Date.now,
} = {}) {
  const request = validateRecoveryRequest(uncheckedRequest, { now });
  if (!(githubClient instanceof ReadOnlyGitHubClient)) throw new TypeError('read-only GitHub client is required');
  const observedAt = now();
  const github = await collectGitHubProof(request, githubClient, observedAt);
  let convergence = null;
  let provider = null;
  if (request.decision === 'accept_observed_convergence') {
    if (typeof verifyConvergence !== 'function') fail('CONVERGENCE_VERIFIER_REQUIRED', 'strict convergence verifier is required');
    assertManifestProducer(
      request.evidence.decisionEvidence.resultManifest,
      request,
      githubClient.repository,
      github,
    );
    const incidentHead = targetRunHead(github, request);
    convergence = validateConvergenceProof(
      await verifyConvergence(request.evidence.decisionEvidence.resultManifest, incidentHead),
      request,
      incidentHead,
    );
  }
  if (request.decision === 'authorize_current_main_retry') {
    if (typeof verifyProviderInactive !== 'function') fail('PROVIDER_VERIFIER_REQUIRED', 'read-only provider inactivity proof is required');
    provider = await verifyProviderInactive();
    if (!provider || provider.ok !== true || !Number.isSafeInteger(provider.checkedServices) || provider.checkedServices < 1) {
      fail('PROVIDER_ACTIVITY_NOT_CLEARED', 'read-only Railway proof did not clear provider activity');
    }
  }
  const preparedAt = now();
  if (!Number.isFinite(preparedAt)) fail('PROOF_SCHEMA_INVALID', 'recovery proof clock was invalid');
  return {
    version: 1,
    requestDigest: digestRequest(request),
    preparedAt: new Date(preparedAt).toISOString(),
    github,
    convergence,
    provider,
  };
}

function validateProof(proof, request, now) {
  exactKeys(proof, ['version', 'requestDigest', 'preparedAt', 'github', 'convergence', 'provider'], 'PROOF_SCHEMA_INVALID');
  if (proof.version !== 1 || proof.requestDigest !== digestRequest(request)) fail('PROOF_REQUEST_MISMATCH', 'proof is not bound to this request');
  const preparedAt = requireTimestamp(proof.preparedAt, 'proof.preparedAt', now);
  if (!proof.github || typeof proof.github !== 'object' || Array.isArray(proof.github)) {
    fail('PROOF_SCHEMA_INVALID', 'proof must retain its GitHub observation');
  }
  const observedAt = requireTimestamp(proof.github.observedAt, 'proof.github.observedAt', now);
  if (observedAt > preparedAt) fail('PROOF_SCHEMA_INVALID', 'proof predates its GitHub observation');
  if (now - preparedAt > PROOF_MAX_AGE_MS) fail('PROOF_STALE', 'recovery proof is older than ten minutes');
  if (request.decision === 'accept_observed_convergence') {
    validateConvergenceProof(proof.convergence, request, targetRunHead(proof.github, request));
  }
  if (request.decision === 'authorize_current_main_retry' && proof.provider?.ok !== true) {
    fail('PROVIDER_ACTIVITY_NOT_CLEARED', 'retry proof does not establish provider inactivity');
  }
}

function validateResolutionResponse(response, request, operationId) {
  if (!response || response.outcome !== 'OPERATOR_RESOLUTION_RECORDED') {
    fail('CONTROL_RESPONSE_INVALID', 'operator control response has an unexpected outcome');
  }
  exactKeys(response.data, [
    'resolutionId', 'operationId', 'priorId', 'priorGeneration',
    'supersedingGeneration', 'supersedingAttemptId', 'headSha', 'evidenceId',
    'evidenceDigest', 'decision',
  ], 'CONTROL_RESPONSE_INVALID');
  const data = response.data;
  requireIdentifier(data.resolutionId, 'resolutionId');
  requireIdentifier(data.supersedingAttemptId, 'supersedingAttemptId');
  if (!/^[0-9a-f]{64}$/.test(data.operationId)
    || !/^[0-9a-f]{64}$/.test(data.evidenceDigest)
    || typeof data.evidenceId !== 'string' || !IDENTIFIER.test(data.evidenceId)
    || data.operationId !== operationId
    || data.priorId !== request.priorId || data.headSha !== request.expectedCurrentHead
    || data.decision !== request.decision
    || data.resolutionId !== data.supersedingAttemptId
    || !Number.isSafeInteger(data.priorGeneration) || data.priorGeneration < 0
    || !Number.isSafeInteger(data.supersedingGeneration)
    || data.supersedingGeneration !== data.priorGeneration + 1) {
    fail('CONTROL_RESPONSE_INVALID', 'operator control response is not an immutable superseding generation');
  }
  return data;
}

export function createRecoveryEvidenceDigest(request, preparedProof, resolutionProof) {
  return createHash('sha256').update(canonicalJson({
    version: 1,
    request,
    preparedProof,
    resolutionProof,
  })).digest('hex');
}

export async function resolveRailwayReconcileControl(uncheckedRequest, {
  proof,
  githubClient,
  controlClient,
  verifyConvergence,
  verifyProviderInactive,
  now = Date.now,
} = {}) {
  const request = validateRecoveryRequest(uncheckedRequest, { now });
  validateProof(proof, request, now());
  if (!(githubClient instanceof ReadOnlyGitHubClient)) throw new TypeError('read-only GitHub client is required');
  if (!controlClient || typeof controlClient.resolve !== 'function') throw new TypeError('operator control client is required');
  const githubBeforeRailway = await collectGitHubProof(request, githubClient, now());
  if (!semanticallyEqualGitHubProof(githubBeforeRailway, proof.github)) {
    fail('GITHUB_EVIDENCE_CHANGED', 'GitHub evidence changed after protected proof preparation');
  }
  let convergence = null;
  let provider = null;
  if (request.decision === 'accept_observed_convergence') {
    if (typeof verifyConvergence !== 'function') {
      fail('CONVERGENCE_VERIFIER_REQUIRED', 'strict convergence must be refreshed during resolution');
    }
    assertManifestProducer(
      request.evidence.decisionEvidence.resultManifest,
      request,
      githubClient.repository,
      githubBeforeRailway,
    );
    const incidentHead = targetRunHead(githubBeforeRailway, request);
    convergence = validateConvergenceProof(
      await verifyConvergence(
        request.evidence.decisionEvidence.resultManifest,
        incidentHead,
      ),
      request,
      incidentHead,
    );
    if (canonicalJson(convergence) !== canonicalJson(proof.convergence)) {
      fail('RAILWAY_EVIDENCE_CHANGED', 'strict convergence changed before protected resolution');
    }
  }
  if (request.decision === 'authorize_current_main_retry') {
    if (typeof verifyProviderInactive !== 'function') {
      fail('PROVIDER_VERIFIER_REQUIRED', 'provider inactivity must be refreshed during resolution');
    }
    provider = await verifyProviderInactive();
    if (!provider || provider.ok !== true || !Number.isSafeInteger(provider.checkedServices)
      || provider.checkedServices < 1) {
      fail('PROVIDER_ACTIVITY_NOT_CLEARED', 'fresh provider evidence did not clear active work');
    }
    if (canonicalJson(provider) !== canonicalJson(proof.provider)) {
      fail('RAILWAY_EVIDENCE_CHANGED', 'provider inactivity changed before protected resolution');
    }
  }
  const freshGithub = request.decision === 'resolve_pre_mutation_hold'
    ? githubBeforeRailway
    : await collectGitHubProof(request, githubClient, now());
  if (!semanticallyEqualGitHubProof(freshGithub, githubBeforeRailway)) {
    fail('GITHUB_EVIDENCE_CHANGED', 'GitHub evidence changed while fresh Railway proof was collected');
  }
  const resolutionProof = { github: freshGithub, convergence, provider };
  const evidenceDigest = createRecoveryEvidenceDigest(request, proof, resolutionProof);
  const operationId = createOperatorOperationId(request);
  const response = await controlClient.resolve({
    operationId,
    priorId: request.priorId,
    priorCreatedAt: request.evidence.priorCreatedAt,
    expectedHead: request.expectedCurrentHead,
    decision: request.decision,
    actor: request.actor,
    approver: request.approver,
    reason: request.reason,
    evidenceDigest,
    intentDigest: convergence?.intentDigest ?? null,
    triggeringActor: request.triggeringActor,
    operatorRunId: request.operatorRunId,
    operatorRunAttempt: request.operatorRunAttempt,
    evidenceId: request.evidence.evidenceId,
    runEvidenceId: request.evidence.runEvidenceId,
    environmentEvidenceId: request.evidence.environmentEvidenceId,
    gateStatusId: freshGithub.gateStatusId,
    gateUpdatedAt: freshGithub.gateUpdatedAt,
    targetRunId: request.evidence.targetRunId,
    targetRunAttempt: request.evidence.targetRunAttempt,
    targetHead: targetRunHead(freshGithub, request),
  });
  const resolution = validateResolutionResponse(response, request, operationId);
  return {
    version: 1,
    outcome: response.outcome,
    evidenceDigest: resolution.evidenceDigest,
    resolution,
    dispatch: request.decision === 'authorize_current_main_retry' ? {
      workflow: TARGET_WORKFLOW,
      ref: 'main',
      expectedHead: request.expectedCurrentHead,
      recoveryAttemptId: resolution.supersedingAttemptId,
      supersedingGeneration: resolution.supersedingGeneration,
    } : null,
  };
}

export async function verifyNoActiveRailwayDeployments({
  environment = 'production',
  readRepositoryServicesImpl = readRepositoryServices,
  readDeploymentsImpl = readDeployments,
} = {}) {
  if (typeof readRepositoryServicesImpl !== 'function' || typeof readDeploymentsImpl !== 'function') {
    throw new TypeError('Railway evidence readers must be functions');
  }
  const services = readRepositoryServicesImpl(environment);
  if (services.length === 0) fail('PROVIDER_EVIDENCE_UNREADABLE', 'Railway Viewer returned no repository services');
  let checked = 0;
  for (let index = 0; index < services.length; index += 8) {
    const batch = services.slice(index, index + 8);
    const histories = await Promise.all(
      batch.map((service) => readDeploymentsImpl(service, environment, 1000)),
    );
    histories.forEach((deployments, offset) => {
      if (!Array.isArray(deployments)) fail('PROVIDER_EVIDENCE_UNREADABLE', 'Railway deployment history was malformed');
      if (deployments.length >= 1000) {
        fail(
          'PROVIDER_EVIDENCE_INCOMPLETE',
          `Railway deployment history did not prove exhaustion for ${batch[offset].name}`,
        );
      }
      const active = deployments.find((deployment) => IN_FLIGHT_STATUSES.includes(deployment?.status));
      if (active) fail('PROVIDER_ACTIVITY_NOT_CLEARED', `Railway still reports active work for ${batch[offset].name}`);
      checked += 1;
    });
  }
  return { ok: true, checkedServices: checked };
}

function runStrictConvergence(resultManifest, expectedHead) {
  const directory = mkdtempSync(join(tmpdir(), 'wm-railway-recovery-'));
  const manifestPath = join(directory, 'result-manifest.json');
  try {
    writeFileSync(manifestPath, `${JSON.stringify(resultManifest)}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./wait-railway-deploy-convergence.mjs', import.meta.url)),
      '--manifest', manifestPath,
      '--head', expectedHead,
      '--environment', 'production',
    ], { encoding: 'utf8', timeout: 40 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0 || result.signal || result.error) {
      fail('CONVERGENCE_PROOF_FAILED', 'strict Railway convergence did not pass', { cause: result.error });
    }
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function cliRequest() {
  let evidence;
  try {
    evidence = JSON.parse(process.env.RECOVERY_EVIDENCE_JSON || '');
  } catch (cause) {
    fail('EVIDENCE_JSON_INVALID', 'RECOVERY_EVIDENCE_JSON is malformed', { cause });
  }
  return {
    version: 1,
    decision: process.env.RECOVERY_DECISION,
    priorId: process.env.RECOVERY_PRIOR_ID,
    expectedCurrentHead: process.env.RECOVERY_EXPECTED_HEAD,
    reason: process.env.RECOVERY_REASON,
    actor: process.env.RECOVERY_ACTOR,
    approver: process.env.RECOVERY_APPROVER,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    operatorRunId: process.env.GITHUB_RUN_ID,
    operatorRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    evidence,
  };
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value)}\n`);
  }
}

async function main() {
  const mode = process.argv[2];
  const request = cliRequest();
  const githubClient = new ReadOnlyGitHubClient({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
  if (mode === 'proof') {
    const proof = await buildRecoveryProof(request, {
      githubClient,
      verifyConvergence: runStrictConvergence,
      verifyProviderInactive: verifyNoActiveRailwayDeployments,
    });
    const encoded = Buffer.from(JSON.stringify(proof)).toString('base64url');
    writeOutputs({ proof: encoded });
    console.log(JSON.stringify({ ok: true, evidenceId: request.evidence.evidenceId }));
    return;
  }
  if (mode !== 'resolve') fail('MODE_INVALID', 'mode must be proof or resolve');
  const operatorSecret = process.env.RAILWAY_RECONCILE_OPERATOR_HMAC;
  delete process.env.RAILWAY_RECONCILE_OPERATOR_HMAC;
  const controlClient = new RailwayReconcileControlClient({
    role: 'operator',
    secret: operatorSecret,
  });
  const proof = await buildRecoveryProof(request, {
    githubClient,
    verifyConvergence: runStrictConvergence,
    verifyProviderInactive: verifyNoActiveRailwayDeployments,
  });
  const result = await resolveRailwayReconcileControl(request, {
    proof,
    githubClient,
    controlClient,
    verifyConvergence: runStrictConvergence,
    verifyProviderInactive: verifyNoActiveRailwayDeployments,
  });
  writeOutputs({
    dispatch_authorized: result.dispatch !== null,
    expected_head: result.dispatch?.expectedHead ?? '',
    recovery_attempt_id: result.dispatch?.recoveryAttemptId ?? '',
    superseding_generation: result.dispatch?.supersedingGeneration ?? '',
  });
  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: error instanceof RecoveryResolutionError ? error.code : 'RECOVERY_RESOLUTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
