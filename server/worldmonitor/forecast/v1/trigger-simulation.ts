import type {
  ServerContext,
  TriggerSimulationRequest,
  TriggerSimulationResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import {
  enqueueSimulationTaskForServer,
  getQueueDepth,
  getSimulationOutcomeLatest,
  getSimulationPackagePointer,
} from '../../../_shared/simulation-queue';
// Shim lives in scripts/ (not server/_shared/) so the Railway workers can
// resolve it under their nixpacks root_dir=scripts packaging. See
// scripts/_simulation-queue-constants.mjs header. esbuild inlines it here
// at Vercel build time.
import { MAX_QUEUE_DEPTH } from '../../../../scripts/_simulation-queue-constants.mjs';

/**
 * POST /api/forecast/v1/trigger-simulation
 *
 * PRO-gated mutation that enqueues a simulation task for the current
 * SIMULATION_PACKAGE_LATEST_KEY pointer. Mirrors run-scenario.ts shape
 * (gateway Pro gate + per-IP rate-limit + queue-depth backpressure +
 * ApiError for non-200 status codes). See #3734.
 *
 * Order of operations (gateway-side gates fire before this handler runs):
 *   1. isCallerPremium → 403 if false (defense-in-depth; gateway already
 *      gates via PREMIUM_RPC_PATHS).
 *   2. getQueueDepth → 429 if > MAX_QUEUE_DEPTH (matches run-scenario).
 *   3. getSimulationPackagePointer → 200 no_package if absent.
 *   4. getSimulationOutcomeLatest → 200 already-handled if cycle complete.
 *   5. enqueueSimulationTaskForServer → 200 queued or 200 already-handled
 *      (NX-collision) or 503 redis_error or 500 invalid_run_id_format
 *      (server bug — should not happen with server-derived runId).
 *
 * Idempotency response taxonomy (D5):
 *   - External reason values: '', 'no_package', 'already-handled'.
 *   - Server logs retain the distinction between "already-queued" and
 *     "already-completed-this-cycle" for diagnostics. Collapsing them
 *     externally avoids a cron-timing oracle (Sec4 round 1+2).
 *
 * Success-path observability (D5 / SG-4 round 2):
 *   - console.log "queued" line with runId + auth_kind. Drives the 30-day
 *     demand experiment described in the Problem Frame. Identity is
 *     classified team-vs-external downstream from the Sentry breadcrumb
 *     (auth_kind ∈ {'user_api_key', 'enterprise_api_key'} → external).
 */
export async function triggerSimulation(
  ctx: ServerContext,
  req: TriggerSimulationRequest,
): Promise<TriggerSimulationResponse> {
  // Step 1: Pro gate (defense-in-depth).
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    throw new ApiError(403, 'Pro subscription required', '');
  }

  // Step 2: queue-depth backpressure (mirrors run-scenario:50).
  const depth = await getQueueDepth();
  if (depth > MAX_QUEUE_DEPTH) {
    throw new ApiError(429, 'Simulation queue at capacity, please try again later', '');
  }

  // Step 3: derive runId from package pointer; no UUID fallback.
  let pointer;
  try {
    pointer = await getSimulationPackagePointer();
  } catch (err) {
    console.warn(`[TriggerSimulation] 503-redis-error pointer-read: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiError(503, 'Simulation queue unavailable', '');
  }
  if (!pointer) {
    console.log('[TriggerSimulation] no-package');
    markNoCacheResponse(ctx.request);
    return { queued: false, runId: '', pkgFingerprint: '', reason: 'no_package' };
  }

  // Step 4: pre-enqueue idempotency fast-path (D5). Authoritative
  // concurrency primitive is the SET NX inside enqueueSimulationTaskForServer
  // — this check just avoids consuming a rate-limit slot on a sure no-op.
  try {
    const outcome = await getSimulationOutcomeLatest();
    if (outcome && outcome.runId === pointer.runId) {
      // Internal log distinguishes the two idempotency states; external
      // response collapses to 'already-handled' (cron-timing-oracle defense).
      console.log(`[TriggerSimulation] already-completed-this-cycle runId=${pointer.runId}`);
      markNoCacheResponse(ctx.request);
      return {
        queued: false,
        runId: pointer.runId,
        pkgFingerprint: pointer.pkgFingerprint,
        reason: 'already-handled',
      };
    }
  } catch (err) {
    // Outcome read failure is non-fatal — fall through to enqueue. SET NX
    // is authoritative; this read is the fast-path optimization only.
    console.warn(`[TriggerSimulation] outcome-pre-check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 5: enqueue.
  const result = await enqueueSimulationTaskForServer(pointer.runId, pointer.pkgFingerprint);
  if (result.reason === 'duplicate') {
    console.log(`[TriggerSimulation] already-queued runId=${pointer.runId}`);
    markNoCacheResponse(ctx.request);
    return {
      queued: false,
      runId: pointer.runId,
      pkgFingerprint: pointer.pkgFingerprint,
      reason: 'already-handled',
    };
  }
  if (result.reason === 'redis_error') {
    console.warn(`[TriggerSimulation] 503-redis-error enqueue runId=${pointer.runId}`);
    throw new ApiError(503, 'Simulation queue unavailable', '');
  }
  if (result.reason === 'invalid_run_id_format') {
    // Should not happen with server-derived runId; signals a bug in the
    // package-pointer write path.
    console.error(`[TriggerSimulation] 500-invalid-run-id pointer.runId=${pointer.runId}`);
    throw new ApiError(500, 'Internal: invalid runId from package pointer', '');
  }
  if (result.reason === 'missing_run_id') {
    // Defensive — pointer.runId is non-empty per the getSimulationPackagePointer
    // contract; reaching here means the contract was violated.
    console.error('[TriggerSimulation] 500-missing-run-id pointer.runId was empty');
    throw new ApiError(500, 'Internal: missing runId from package pointer', '');
  }
  // Happy path.
  // Identity-aware success log drives the 30-day demand experiment. The
  // shape (auth_kind in the log line) lets a follow-up dashboard / Sentry
  // filter separate team-test traffic from external Pro callers.
  const authHeader = ctx.request.headers.get('authorization') ?? '';
  const apiKeyHeader = ctx.request.headers.get('x-api-key') || ctx.request.headers.get('x-worldmonitor-key') || '';
  const authKind = apiKeyHeader
    ? (apiKeyHeader.startsWith('wm_') ? 'user_api_key' : 'enterprise_api_key')
    : (authHeader ? 'clerk_jwt' : 'unknown');
  // clientVersion echoed per the proto comment promise (Greptile P2 review on PR #3811).
  // Sanitized to a short slug to keep the log line bounded; never persisted.
  const clientVersion = String(req.clientVersion ?? '').slice(0, 64).replace(/[^a-zA-Z0-9._/\-]/g, '');
  console.log(`[TriggerSimulation] queued runId=${pointer.runId} authKind=${authKind} pkgFingerprint=${pointer.pkgFingerprint} clientVersion=${clientVersion}`);
  markNoCacheResponse(ctx.request);
  return {
    queued: true,
    runId: pointer.runId,
    pkgFingerprint: pointer.pkgFingerprint,
    reason: '',
  };
}
