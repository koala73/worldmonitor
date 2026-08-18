#!/usr/bin/env node
// @ts-check
/**
 * Company Monitoring scan worker — always-on Railway service.
 *
 * Railway config:
 *   - Service name: company-monitoring-worker
 *   rootDirectory: scripts
 *   startCommand: node company-monitoring-worker.mjs
 *   cronSchedule: <none> (always-on long-running process)
 *
 * Convex owns work selection, leases, replay, checkpoints, and receipts. This
 * process accepts no tenant target. Redis receives only disposable, bounded
 * control-plane health metadata and is never part of the work protocol.
 */

import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';

import { loadEnvFile } from './_seed-utils.mjs';
import {
  COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS,
  createXRecentSearchExecutor,
} from './lib/company-monitoring-x-provider.mjs';
import {
  COMPANY_MONITORING_EXA_CONTRACT,
  createExaCohortExecutor,
} from './lib/company-monitoring-exa.mjs';
import {
  requestCompanyMonitoringClassification,
} from './lib/company-monitoring-classifier-client.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const COMPANY_MONITORING_WORKER_HEALTH_KEY = 'company-monitoring:worker-health:v1';
export const COMPANY_MONITORING_WORKER_META_KEY = 'seed-meta:company-monitoring:worker';
export const COMPANY_MONITORING_WORKER_ACTIVATION_KEY = 'seed-activated:company-monitoring:worker';
// The checked-in Stage 0 protocol remains STOP. Credentials can be provisioned
// before rollout, but they must not make live model calls on their own.
export const COMPANY_MONITORING_CLASSIFIER_RUNTIME_APPROVED = false;

const HEALTH_TTL_SECONDS = 900;
const META_TTL_SECONDS = 86_400;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const COMPANY_MONITORING_CONVEX_TIMEOUT_MS = 15_000;
export const COMPANY_MONITORING_FINALIZE_TRANSPORT_BUFFER_MS = 5_000;
const REDIS_TIMEOUT_MS = 5_000;

if (
  COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS <
    COMPANY_MONITORING_CONVEX_TIMEOUT_MS + COMPANY_MONITORING_FINALIZE_TRANSPORT_BUFFER_MS
) {
  throw new Error('Company Monitoring provider lease reserve cannot safely finalize through Convex');
}
const COUNTER_NAMES = Object.freeze([
  'loops',
  'claims',
  'completed',
  'nonReassuring',
  'fenced',
  'replayed',
  'executorErrors',
  'claimErrors',
  'finalizeErrors',
  'admissionClaims',
  'admissionRecorded',
  'admissionReplayed',
  'admissionTransportFailures',
  'admissionClaimErrors',
  'admissionFinalizeErrors',
]);
const SCAN_HEALTH_OUTCOMES = new Set([
  'starting',
  'disabled',
  'idle',
  'completed',
  'non_reassuring',
  'fenced',
  'replayed',
  'claim_error',
  'finalize_error',
]);
const ADMISSION_HEALTH_OUTCOMES = new Set([
  'disabled',
  'idle',
  'admission_recorded',
  'admission_replayed',
  'admission_transport_failure',
  'admission_claim_error',
  'admission_finalize_error',
]);
const HEALTHY_SCAN_OUTCOMES = new Set([
  'disabled',
  'idle',
  'completed',
  'replayed',
]);
const HEALTHY_ADMISSION_OUTCOMES = new Set([
  'disabled',
  'idle',
  'admission_recorded',
  'admission_replayed',
]);

/** @typedef {'ok' | 'error'} WorkerHealthStatus */
/** @typedef {'starting' | 'disabled' | 'idle' | 'completed' | 'non_reassuring' | 'fenced' | 'replayed' | 'claim_error' | 'finalize_error' | 'admission_recorded' | 'admission_replayed' | 'admission_transport_failure' | 'admission_claim_error' | 'admission_finalize_error'} WorkerOutcome */

function boundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 9_999_999_999) : 0;
}

function projectCounters(value) {
  return Object.fromEntries(COUNTER_NAMES.map((name) => [name, boundedCounter(value?.[name])]));
}

function providerCoverage(outcome) {
  if (outcome === 'completed') return 'complete';
  if (outcome === 'non_reassuring') return 'non_reassuring';
  return 'not_evaluated';
}

function projectSubsystemHealth(value, outcomes, healthyOutcomes, fallback) {
  const outcome = outcomes.has(value?.outcome) ? value.outcome : fallback.outcome;
  const status = value?.status === 'ok' && healthyOutcomes.has(outcome) ? 'ok' : 'error';
  return { status, outcome };
}

function projectWorkerHealth(input) {
  const scan = projectSubsystemHealth(
    input?.subsystems?.scan,
    SCAN_HEALTH_OUTCOMES,
    HEALTHY_SCAN_OUTCOMES,
    { status: 'error', outcome: 'starting' },
  );
  const admission = projectSubsystemHealth(
    input?.subsystems?.admission,
    ADMISSION_HEALTH_OUTCOMES,
    HEALTHY_ADMISSION_OUTCOMES,
    { status: 'ok', outcome: 'disabled' },
  );
  const activeSubsystem = input?.activeSubsystem === 'admission' ||
    input?.outcome === input?.subsystems?.admission?.outcome
    ? 'admission'
    : 'scan';
  const activeHealth = activeSubsystem === 'admission' ? admission : scan;
  const failingSubsystem = activeHealth.status === 'error'
    ? activeSubsystem
    : scan.status === 'error'
      ? 'scan'
      : admission.status === 'error'
        ? 'admission'
        : null;
  const selectedSubsystem = failingSubsystem ?? activeSubsystem;
  const selected = selectedSubsystem === 'admission' ? admission : scan;

  return {
    version: 1,
    status: failingSubsystem === null ? 'ok' : 'error',
    outcome: selected.outcome,
    providerCoverage: providerCoverage(scan.outcome),
    subsystems: { scan, admission },
    counters: projectCounters(input?.counters),
  };
}

function workerHealthPayload(input, now) {
  return {
    ...projectWorkerHealth(input),
    observedAt: now,
  };
}

/**
 * Create a best-effort Redis publisher. Failure is returned as `false`; it is
 * never allowed to change claim/finalize behavior.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {{ warn?: (...args: unknown[]) => void }} [options.logger]
 */
export function createRedisHealthPublisher(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;

  return async (input) => {
    const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, '');
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return false;

    const observedAt = now();
    const canonical = workerHealthPayload(input, observedAt);
    const meta = {
      ...canonical,
      fetchedAt: observedAt,
      recordCount: 1,
      sourceState: canonical.status === 'ok' ? 'ok' : 'error',
    };
    const commands = [
      ['SET', COMPANY_MONITORING_WORKER_HEALTH_KEY, JSON.stringify(canonical), 'EX', String(HEALTH_TTL_SECONDS)],
      ['SET', COMPANY_MONITORING_WORKER_META_KEY, JSON.stringify(meta), 'EX', String(META_TTL_SECONDS)],
    ];
    if (canonical.status === 'ok') {
      commands.push([
        'SET',
        COMPANY_MONITORING_WORKER_ACTIVATION_KEY,
        JSON.stringify({ version: 1, activatedAt: observedAt }),
        'NX',
      ]);
    }

    try {
      const response = await fetchImpl(`${url}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmonitor-company-monitoring-worker/1.0',
        },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Redis health HTTP ${response.status}`);
      const results = await response.json();
      if (!Array.isArray(results) || results.some((result) => result?.error)) {
        throw new Error('Redis health pipeline rejected a command');
      }
      return true;
    } catch (error) {
      logger.warn?.('[company-monitoring-worker] health publish unavailable:', error?.message ?? String(error));
      return false;
    }
  };
}

async function unavailableExecutor() {
  return {
    type: 'provider_error',
    reason: 'provider_unavailable',
    costUsdMicros: 0,
  };
}

export function createCompanyMonitoringExecutor(options = {}) {
  const { exaExecutor, xExecutor } = options;
  return async (work) => {
    if (work?.source === 'exa' && typeof exaExecutor === 'function') return exaExecutor(work);
    if (work?.source === 'x' && typeof xExecutor === 'function') return xExecutor(work);
    return unavailableExecutor();
  };
}

/**
 * Bind explicit classifier configuration to the provider transport. The raw
 * content remains untrusted; Convex applies the deterministic policy when it
 * finalizes the leased candidate.
 *
 * @param {object} options
 * @param {string | undefined} options.apiKey
 * @param {string | undefined} options.model
 * @param {string | undefined} options.providerRoute
 * @param {string | undefined} options.expectedResolvedProvider
 * @param {string[]} [options.approvedResolvedModels]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createCompanyMonitoringAdmissionClassifier(options) {
  const {
    apiKey,
    model,
    providerRoute,
    expectedResolvedProvider,
    approvedResolvedModels,
    fetchImpl,
  } = options;
  return async ({ candidate, evidence }) => {
    const classification = await requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      providerRoute,
      expectedResolvedProvider,
      approvedResolvedModels,
      fetchImpl,
    });
    return {
      requestedModelVersion: `${model}@${providerRoute}#${expectedResolvedProvider}`,
      modelVersion:
        `${classification.route.resolvedModel}@${classification.route.configuredProviderRoute}` +
        `#${classification.route.resolvedProvider}`,
      modelOutput: classification.content,
    };
  };
}

/**
 * Keep provisioned credentials inert until the checked-in runtime gate is
 * deliberately changed together with the frozen protocol decision.
 */
export function createApprovedCompanyMonitoringAdmissionClassifier(options) {
  return COMPANY_MONITORING_CLASSIFIER_RUNTIME_APPROVED
    ? createCompanyMonitoringAdmissionClassifier(options)
    : undefined;
}

function finalizeResult(execution) {
  if (execution?.finalizeResult && typeof execution.finalizeResult === 'object') {
    return execution.finalizeResult;
  }
  return execution;
}

/**
 * ConvexHttpClient has no default request timeout. Keep every control-plane
 * request inside the lease budget and identify this server-side caller.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {typeof fetch}
 */
export function createConvexFetch(fetchImpl = globalThis.fetch) {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', 'worldmonitor-company-monitoring-worker/1.0');
    return fetchImpl(input, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(COMPANY_MONITORING_CONVEX_TIMEOUT_MS),
    });
  };
}

/**
 * Create the control loop with explicit seams for local replay and shutdown
 * tests. `afterExecute` models the exact crash point after provider fetch and
 * before finalize; production leaves it unset.
 *
 * @param {object} options
 * @param {{ mutation: (fn: unknown, args: Record<string, unknown>) => Promise<any> }} options.client
 * @param {string} options.secret
 * @param {string} options.workerId
 * @param {(work: Record<string, unknown>) => Promise<Record<string, unknown>>} [options.executeClaim]
 * @param {(input: { candidate: Record<string, unknown>, evidence: Record<string, unknown>[] }) => Promise<{ requestedModelVersion: string, modelVersion: string, modelOutput: unknown }>} [options.executeAdmission]
 * @param {string} [options.admissionModelVersion]
 * @param {() => string} [options.classificationRunId]
 * @param {(result: Record<string, unknown>, work: Record<string, unknown>) => Promise<void>} [options.afterExecute]
 * @param {(payload: Record<string, unknown>) => Promise<unknown>} [options.publishHealth]
 * @param {number} [options.pollIntervalMs]
 * @param {{ warn?: (...args: unknown[]) => void }} [options.logger]
 */
export function createCompanyMonitoringWorker(options) {
  const {
    client,
    secret,
    workerId,
    executeClaim = unavailableExecutor,
    executeAdmission,
    admissionModelVersion,
    classificationRunId = () => `classification-${randomUUID()}`,
    afterExecute,
    publishHealth = async () => false,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    logger = console,
  } = options;
  if (!client || typeof client.mutation !== 'function') throw new Error('Convex client is required');
  if (!secret) throw new Error('COMPANY_MONITORING_WORKER_SECRET is required');
  if (!workerId) throw new Error('workerId is required');

  let stopping = false;
  let stopSignal = null;
  let pollTimer = null;
  let finishPoll = null;
  let inFlight = false;
  const counters = projectCounters({});
  const health = {
    scan: { status: 'error', outcome: 'starting' },
    admission: typeof executeAdmission === 'function'
      ? { status: 'ok', outcome: 'idle' }
      : { status: 'ok', outcome: 'disabled' },
  };

  const safePublish = async (subsystem, status, outcome) => {
    health[subsystem] = { status, outcome };
    try {
      await publishHealth(projectWorkerHealth({
        activeSubsystem: subsystem,
        subsystems: health,
        counters,
      }));
    } catch (error) {
      logger.warn?.('[company-monitoring-worker] health publisher failed:', error?.message ?? String(error));
    }
  };

  const tick = async () => {
    if (stopping) return 'stopping';
    counters.loops += 1;
    let claim;
    try {
      claim = await client.mutation(
        anyApi.companyMonitoring.orchestration.claimNextWork,
        { secret, workerId },
      );
    } catch {
      counters.claimErrors += 1;
      await safePublish('scan', 'error', 'claim_error');
      return 'claim_error';
    }

    if (claim?.status === 'disabled' || claim?.status === 'idle') {
      await safePublish('scan', 'ok', claim.status);
      return claim.status;
    }
    if (claim?.status !== 'claimed' || !claim.work) {
      counters.claimErrors += 1;
      await safePublish('scan', 'error', 'claim_error');
      return 'claim_error';
    }

    counters.claims += 1;
    inFlight = true;
    let result;
    try {
      result = finalizeResult(await executeClaim(claim.work));
    } catch {
      counters.executorErrors += 1;
      result = await unavailableExecutor();
    }

    // This test-only hook deliberately remains outside the executor catch. A
    // throw models abrupt process death: no finalize is attempted, so Convex
    // alone decides when the expired lease can be replayed with a fresh fence.
    if (afterExecute) await afterExecute(result, claim.work);

    let finalized;
    try {
      finalized = await client.mutation(
        anyApi.companyMonitoring.orchestration.finalizeWork,
        {
          secret,
          workerId,
          workId: claim.work.workId,
          leaseToken: claim.work.leaseToken,
          result,
        },
      );
    } catch {
      inFlight = false;
      counters.finalizeErrors += 1;
      await safePublish('scan', 'error', 'finalize_error');
      return 'finalize_error';
    }
    inFlight = false;

    const outcome = finalized?.status;
    if (outcome === 'completed') counters.completed += 1;
    else if (outcome === 'non_reassuring') counters.nonReassuring += 1;
    else if (outcome === 'fenced') counters.fenced += 1;
    else if (outcome === 'replayed') counters.replayed += 1;
    else {
      counters.finalizeErrors += 1;
      await safePublish('scan', 'error', 'finalize_error');
      return 'finalize_error';
    }
    await safePublish('scan', HEALTHY_SCAN_OUTCOMES.has(outcome) ? 'ok' : 'error', outcome);
    return outcome;
  };

  const admissionTick = async () => {
    if (stopping) return 'stopping';
    if (typeof executeAdmission !== 'function') return 'disabled';

    const runId = classificationRunId();
    if (
      typeof runId !== 'string' ||
      runId.length === 0 ||
      typeof admissionModelVersion !== 'string' ||
      admissionModelVersion.length === 0
    ) {
      counters.admissionFinalizeErrors += 1;
      await safePublish('admission', 'error', 'admission_finalize_error');
      return 'finalize_error';
    }

    let claim;
    try {
      claim = await client.mutation(
        anyApi.companyMonitoring.orchestration.claimNextAdmissionCandidate,
        {
          secret,
          workerId,
          classificationRunId: runId,
          requestedModelVersion: admissionModelVersion,
        },
      );
    } catch {
      counters.admissionClaimErrors += 1;
      await safePublish('admission', 'error', 'admission_claim_error');
      return 'claim_error';
    }
    if (claim?.status === 'idle') return 'idle';
    if (
      claim?.status !== 'claimed' ||
      !claim.candidate ||
      !Array.isArray(claim.evidence) ||
      typeof claim.leaseToken !== 'string' ||
      !Number.isSafeInteger(claim.expectedEvidenceRevision)
    ) {
      counters.admissionClaimErrors += 1;
      await safePublish('admission', 'error', 'admission_claim_error');
      return 'claim_error';
    }

    counters.admissionClaims += 1;
    inFlight = true;
    try {
      let classification;
      try {
        classification = await executeAdmission({
          candidate: claim.candidate,
          evidence: claim.evidence,
        });
        if (
          !classification ||
          typeof classification.requestedModelVersion !== 'string' ||
          classification.requestedModelVersion.length === 0 ||
          typeof classification.modelVersion !== 'string' ||
          classification.modelVersion.length === 0 ||
          (admissionModelVersion !== undefined &&
            classification.requestedModelVersion !== admissionModelVersion)
        ) {
          throw new Error('Classifier returned invalid finalization metadata');
        }
      } catch {
        let failureFinalized;
        try {
          failureFinalized = await client.mutation(
            anyApi.companyMonitoring.orchestration.finalizeAdmissionTransportFailure,
            {
              secret,
              workerId,
              leaseToken: claim.leaseToken,
              ownerAccountId: claim.candidate.ownerAccountId,
              companyId: claim.candidate.companyId,
              occurrenceDedupeKey: claim.candidate.occurrenceDedupeKey,
              expectedEvidenceRevision: claim.expectedEvidenceRevision,
              classificationRunId: runId,
              requestedModelVersion: admissionModelVersion,
            },
          );
        } catch {
          counters.admissionFinalizeErrors += 1;
          await safePublish('admission', 'error', 'admission_finalize_error');
          return 'finalize_error';
        }
        if (
          failureFinalized?.status !== 'recorded' &&
          failureFinalized?.status !== 'replayed'
        ) {
          counters.admissionFinalizeErrors += 1;
          await safePublish('admission', 'error', 'admission_finalize_error');
          return 'finalize_error';
        }
        counters.admissionTransportFailures += 1;
        if (failureFinalized.status === 'recorded') counters.admissionRecorded += 1;
        else counters.admissionReplayed += 1;
        await safePublish('admission', 'error', 'admission_transport_failure');
        return 'provider_error';
      }

      let finalized;
      try {
        finalized = await client.mutation(
          anyApi.companyMonitoring.orchestration.finalizeAdmissionCandidate,
          {
            secret,
            workerId,
            leaseToken: claim.leaseToken,
            ownerAccountId: claim.candidate.ownerAccountId,
            companyId: claim.candidate.companyId,
            occurrenceDedupeKey: claim.candidate.occurrenceDedupeKey,
            expectedEvidenceRevision: claim.expectedEvidenceRevision,
            classificationRunId: runId,
            modelVersion: classification.modelVersion,
            requestedModelVersion: classification.requestedModelVersion,
            modelOutput: classification.modelOutput,
          },
        );
      } catch {
        counters.admissionFinalizeErrors += 1;
        await safePublish('admission', 'error', 'admission_finalize_error');
        return 'finalize_error';
      }

      if (finalized?.status === 'recorded') {
        counters.admissionRecorded += 1;
        await safePublish('admission', 'ok', 'admission_recorded');
        return 'recorded';
      }
      if (finalized?.status === 'replayed') {
        counters.admissionReplayed += 1;
        await safePublish('admission', 'ok', 'admission_replayed');
        return 'replayed';
      }
      counters.admissionFinalizeErrors += 1;
      await safePublish('admission', 'error', 'admission_finalize_error');
      return 'finalize_error';
    } finally {
      inFlight = false;
    }
  };

  const waitForNextPoll = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      finishPoll = null;
      resolve();
    };
    finishPoll = finish;
    pollTimer = setTimeout(finish, Math.max(0, pollIntervalMs));
  });

  return {
    tick,
    admissionTick,
    async run() {
      while (!stopping) {
        await tick();
        if (!stopping) await admissionTick();
        if (!stopping) await waitForNextPoll();
      }
    },
    requestStop(signal = 'SIGTERM') {
      stopping = true;
      stopSignal = signal;
      finishPoll?.();
    },
    snapshot() {
      return {
        stopping,
        stopSignal,
        inFlight,
        counters: projectCounters(counters),
      };
    },
  };
}

async function main() {
  loadEnvFile(import.meta.url, {
    only: [
      'CONVEX_URL',
      'COMPANY_MONITORING_WORKER_SECRET',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'X_BEARER_TOKEN',
      'X_POST_STORAGE_MODE',
      'X_RECENT_SEARCH_REQUEST_COST_USD_MICROS',
      'EXA_API_KEYS',
      'OPENROUTER_API_KEY',
      'COMPANY_MONITORING_CLASSIFIER_MODEL',
      'COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE',
      'COMPANY_MONITORING_CLASSIFIER_RESOLVED_PROVIDER',
    ],
  });
  const convexUrl = process.env.CONVEX_URL;
  const secret = process.env.COMPANY_MONITORING_WORKER_SECRET;
  if (!convexUrl || !secret) {
    throw new Error('CONVEX_URL and COMPANY_MONITORING_WORKER_SECRET are required');
  }

  const client = new ConvexHttpClient(convexUrl, { fetch: createConvexFetch() });
  const executeClaim = createCompanyMonitoringExecutor({
    exaExecutor: createExaCohortExecutor({
      apiKeys: (process.env.EXA_API_KEYS ?? '').split(/[\n,]+/),
      runtimeApproved: COMPANY_MONITORING_EXA_CONTRACT.paidRuntimeApproved,
    }),
    xExecutor: createXRecentSearchExecutor({
      bearerToken: process.env.X_BEARER_TOKEN,
      storageMode: process.env.X_POST_STORAGE_MODE,
      requestCostUsdMicros: Number(process.env.X_RECENT_SEARCH_REQUEST_COST_USD_MICROS ?? 0),
    }),
  });
  const classifierApiKey = process.env.OPENROUTER_API_KEY;
  const classifierModel = process.env.COMPANY_MONITORING_CLASSIFIER_MODEL;
  const classifierProviderRoute = process.env.COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE;
  const classifierResolvedProvider = process.env.COMPANY_MONITORING_CLASSIFIER_RESOLVED_PROVIDER;
  const classifierVersion = classifierModel && classifierProviderRoute && classifierResolvedProvider
    ? `${classifierModel}@${classifierProviderRoute}#${classifierResolvedProvider}`
    : undefined;
  const executeAdmission = classifierApiKey && classifierModel && classifierProviderRoute && classifierResolvedProvider
    ? createApprovedCompanyMonitoringAdmissionClassifier({
      apiKey: classifierApiKey,
      model: classifierModel,
      providerRoute: classifierProviderRoute,
      expectedResolvedProvider: classifierResolvedProvider,
    })
    : undefined;
  const worker = createCompanyMonitoringWorker({
    client,
    secret,
    workerId: `railway-${process.pid}-${randomUUID()}`,
    executeClaim,
    executeAdmission,
    admissionModelVersion: classifierVersion,
    publishHealth: createRedisHealthPublisher(),
  });
  let shutdownSignal = 'SIGTERM';
  process.on('SIGTERM', () => {
    shutdownSignal = 'SIGTERM';
    worker.requestStop(shutdownSignal);
  });
  process.on('SIGINT', () => {
    shutdownSignal = 'SIGINT';
    worker.requestStop(shutdownSignal);
  });

  console.log('[company-monitoring-worker] control loop started');
  await worker.run();
  console.log(`[company-monitoring-worker] shutdown complete (${shutdownSignal} received)`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('[company-monitoring-worker] fatal:', error?.message ?? String(error));
    process.exitCode = 1;
  });
}
