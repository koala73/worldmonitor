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
import { isMainModule } from './lib/main-module.mjs';

export const COMPANY_MONITORING_WORKER_HEALTH_KEY = 'company-monitoring:worker-health:v1';
export const COMPANY_MONITORING_WORKER_META_KEY = 'seed-meta:company-monitoring:worker';
export const COMPANY_MONITORING_WORKER_ACTIVATION_KEY = 'seed-activated:company-monitoring:worker';

const HEALTH_TTL_SECONDS = 900;
const META_TTL_SECONDS = 86_400;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const CONVEX_TIMEOUT_MS = 15_000;
const REDIS_TIMEOUT_MS = 5_000;
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
]);
const HEALTH_OUTCOMES = new Set([
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
const HEALTHY_OUTCOMES = new Set([
  'disabled',
  'idle',
  'completed',
  'replayed',
]);

/** @typedef {'ok' | 'error'} WorkerHealthStatus */
/** @typedef {'starting' | 'disabled' | 'idle' | 'completed' | 'non_reassuring' | 'fenced' | 'replayed' | 'claim_error' | 'finalize_error'} WorkerOutcome */

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

function workerHealthPayload(input, now) {
  const outcome = HEALTH_OUTCOMES.has(input?.outcome) ? input.outcome : 'starting';
  const status = input?.status === 'ok' && HEALTHY_OUTCOMES.has(outcome) ? 'ok' : 'error';
  return {
    version: 1,
    status,
    outcome,
    observedAt: now,
    providerCoverage: providerCoverage(outcome),
    counters: projectCounters(input?.counters),
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
      signal: init.signal ?? AbortSignal.timeout(CONVEX_TIMEOUT_MS),
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

  const safePublish = async (status, outcome) => {
    try {
      await publishHealth({ status, outcome, counters: projectCounters(counters) });
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
      await safePublish('error', 'claim_error');
      return 'claim_error';
    }

    if (claim?.status === 'disabled' || claim?.status === 'idle') {
      await safePublish('ok', claim.status);
      return claim.status;
    }
    if (claim?.status !== 'claimed' || !claim.work) {
      counters.claimErrors += 1;
      await safePublish('error', 'claim_error');
      return 'claim_error';
    }

    counters.claims += 1;
    inFlight = true;
    let result;
    try {
      result = await executeClaim(claim.work);
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
      await safePublish('error', 'finalize_error');
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
      await safePublish('error', 'finalize_error');
      return 'finalize_error';
    }
    await safePublish(HEALTHY_OUTCOMES.has(outcome) ? 'ok' : 'error', outcome);
    return outcome;
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
    async run() {
      while (!stopping) {
        await tick();
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
    ],
  });
  const convexUrl = process.env.CONVEX_URL;
  const secret = process.env.COMPANY_MONITORING_WORKER_SECRET;
  if (!convexUrl || !secret) {
    throw new Error('CONVEX_URL and COMPANY_MONITORING_WORKER_SECRET are required');
  }

  const client = new ConvexHttpClient(convexUrl, { fetch: createConvexFetch() });
  const worker = createCompanyMonitoringWorker({
    client,
    secret,
    workerId: `railway-${process.pid}-${randomUUID()}`,
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
