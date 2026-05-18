// Server-side enqueue + queue-state helpers for the simulation pipeline.
// Mirrors scripts/seed-forecasts.mjs enqueueSimulationTask() but is callable
// from Vercel Edge handlers. The constants come from
// _simulation-queue-constants.mjs so the seeder and this module are
// guaranteed to agree on the Redis schema. See #3734 +
// docs/plans/2026-05-18-003-feat-simulation-trigger-and-runid-filter-plan.md
// D3, D4, D5, D7.

import { runRedisPipeline } from './redis';
import {
  SIMULATION_TASK_KEY_PREFIX,
  SIMULATION_TASK_QUEUE_KEY,
  SIMULATION_TASK_TTL_SECONDS,
  SIMULATION_OUTCOME_LATEST_KEY,
  SIMULATION_PACKAGE_LATEST_KEY,
  VALID_RUN_ID_RE,
  pkgFingerprint,
} from './_simulation-queue-constants.mjs';

const TASK_QUEUE_TTL_SECONDS = 60 * 24 * 60 * 60; // mirrors TRACE_REDIS_TTL_SECONDS in the seeder
const REDIS_READ_TIMEOUT_MS = 5_000;

/**
 * Direct Upstash GET that throws on transport error (vs runRedisPipeline,
 * which silently swallows). The trigger handler needs the distinction
 * between "no pointer" and "Redis is down" so it can return 503 vs 200
 * no_package per the D5 taxonomy.
 */
async function redisGetThrowing(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis credentials not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REDIS_READ_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string | null };
  return data.result ?? null;
}

export interface EnqueueResult {
  queued: boolean;
  reason: '' | 'missing_run_id' | 'invalid_run_id_format' | 'duplicate' | 'redis_error';
}

export interface PackagePointer {
  runId: string;
  pkgKey: string;
  pkgFingerprint: string;
}

export interface OutcomePointer {
  runId: string;
}

export function validateRunId(runId: string): boolean {
  return typeof runId === 'string' && VALID_RUN_ID_RE.test(runId);
}

function buildSimulationTaskKey(runId: string): string {
  return `${SIMULATION_TASK_KEY_PREFIX}:${runId}`;
}

/**
 * Server-side enqueue. Mirrors the seeder's enqueueSimulationTask exactly
 * (SET NX -> ZADD -> EXPIRE) but uses TS Redis helpers and stores the
 * package fingerprint alongside the runId so the worker can detect cron
 * rotation between handler-time and worker-drain-time. See D5 + D7.
 */
export async function enqueueSimulationTaskForServer(
  runId: string,
  pkgFingerprintValue: string,
): Promise<EnqueueResult> {
  if (!runId) return { queued: false, reason: 'missing_run_id' };
  if (!validateRunId(runId)) return { queued: false, reason: 'invalid_run_id_format' };

  const taskKey = buildSimulationTaskKey(runId);
  const payload = JSON.stringify({
    runId,
    pkgFingerprint: pkgFingerprintValue,
    createdAt: Date.now(),
  });

  // SET NX: returns OK on first write, nil on collision. runRedisPipeline
  // returns [] on transport failure — distinguish via shape: result===null
  // is the documented NX-collision return; absence-of-entry is transport.
  let setEntry: { result?: unknown } | undefined;
  try {
    [setEntry] = await runRedisPipeline(
      [['SET', taskKey, payload, 'EX', String(SIMULATION_TASK_TTL_SECONDS), 'NX']],
      true,
    );
  } catch (_err) {
    // runRedisPipeline swallows but we keep this catch for defense-in-depth.
    return { queued: false, reason: 'redis_error' };
  }
  if (!setEntry) return { queued: false, reason: 'redis_error' };
  if (setEntry.result !== 'OK') return { queued: false, reason: 'duplicate' };

  // Best-effort ZADD + EXPIRE — if these fail, the task key is already
  // written and the worker's queue-scan in processNextSimulationTask
  // will still find it via ZRANGE-then-task-key lookup.
  await runRedisPipeline(
    [
      ['ZADD', SIMULATION_TASK_QUEUE_KEY, String(Date.now()), runId],
      ['EXPIRE', SIMULATION_TASK_QUEUE_KEY, String(TASK_QUEUE_TTL_SECONDS)],
    ],
    true,
  );

  return { queued: true, reason: '' };
}

/**
 * Returns the current depth of the simulation task ZSET. Used by the
 * trigger handler for queue-capacity backpressure (mirrors run-scenario).
 */
export async function getQueueDepth(): Promise<number> {
  const [entry] = await runRedisPipeline([['ZCARD', SIMULATION_TASK_QUEUE_KEY]], true);
  return typeof entry?.result === 'number' ? entry.result : 0;
}

/**
 * Reads SIMULATION_PACKAGE_LATEST_KEY and computes the opaque fingerprint
 * over its pkgKey. Returns null when the pointer is absent or has no runId.
 * THROWS on Redis transport errors — the handler distinguishes "no pointer"
 * (200 no_package) from "Redis down" (503).
 */
export async function getSimulationPackagePointer(): Promise<PackagePointer | null> {
  const raw = await redisGetThrowing(SIMULATION_PACKAGE_LATEST_KEY);
  if (!raw) return null;
  let parsed: { runId?: unknown; pkgKey?: unknown };
  try {
    parsed = JSON.parse(raw) as { runId?: unknown; pkgKey?: unknown };
  } catch {
    return null;
  }
  const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
  const pkgKey = typeof parsed.pkgKey === 'string' ? parsed.pkgKey : '';
  if (!runId) return null;
  return { runId, pkgKey, pkgFingerprint: pkgFingerprint(pkgKey) };
}

/**
 * Reads SIMULATION_OUTCOME_LATEST_KEY and returns just the runId field.
 * Used by the trigger handler's idempotency pre-check. Returns null when
 * the key is absent or malformed. THROWS on transport (handler catches
 * and falls through — the pre-check is a fast-path optimization only).
 */
export async function getSimulationOutcomeLatest(): Promise<OutcomePointer | null> {
  const raw = await redisGetThrowing(SIMULATION_OUTCOME_LATEST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { runId?: unknown };
    if (typeof parsed.runId !== 'string') return null;
    return { runId: parsed.runId };
  } catch {
    return null;
  }
}

/**
 * Returns the currently-queued runIds (ZSET members of the task queue).
 * Used by get-simulation-outcome to distinguish "runId is processing" from
 * "runId has expired beyond 24h retention". See #3734 review round 2 PL-2.
 */
export async function listProcessingRunIds(limit = 100): Promise<string[]> {
  const [entry] = await runRedisPipeline(
    [['ZRANGE', SIMULATION_TASK_QUEUE_KEY, '0', String(Math.max(0, limit - 1))]],
    true,
  );
  return Array.isArray(entry?.result)
    ? (entry.result as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
}
