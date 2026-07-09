import type {
  ForecastServiceHandler,
  ServerContext,
  GetSimulationOutcomeRequest,
  GetSimulationOutcomeResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getRawJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
// Both keys come from the shim — single source of truth. Importing
// SIMULATION_OUTCOME_LATEST_KEY from cache-keys would create a second
// definition that could silently drift on a schema-version bump.
// (Greptile P2 review on PR #3811.)
//
// Shim lives in scripts/ (not server/_shared/) so the Railway workers can
// resolve it under their nixpacks root_dir=scripts packaging. See
// scripts/_simulation-queue-constants.mjs header. esbuild inlines it here
// at Vercel build time.
import {
  SIMULATION_OUTCOME_LATEST_KEY,
  SIMULATION_OUTCOME_BY_RUN_KEY_PREFIX,
} from '../../../../scripts/_simulation-queue-constants.mjs';
import { listProcessingRunIds } from '../../../_shared/simulation-queue';

type OutcomePointer = {
  runId: string;
  outcomeKey: string;
  schemaVersion: string;
  theaterCount: number;
  generatedAt: number;
  eligibleTheaterCount?: number;
  failedTheaterCount?: number;
  allTheatersFailed?: boolean;
  completionStatus?: string;
  uiTheaters?: unknown[];
};
type TombstonePayload = { runId: string; error: string; tombstoneAt: number };

function isOutcomePointer(v: unknown): v is OutcomePointer {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['runId'] === 'string' && typeof o['outcomeKey'] === 'string'
    && typeof o['schemaVersion'] === 'string' && typeof o['theaterCount'] === 'number'
    && typeof o['generatedAt'] === 'number';
}

function isTombstone(v: unknown): v is TombstonePayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o['error'] === 'by_run_write_failed' && typeof o['runId'] === 'string';
}

const NOT_FOUND: GetSimulationOutcomeResponse = {
  found: false,
  runId: '',
  outcomeKey: '',
  schemaVersion: '',
  theaterCount: 0,
  generatedAt: 0,
  note: '',
  error: '',
  theaterSummariesJson: '',
  processing: false,
  eligibleTheaterCount: 0,
  failedTheaterCount: 0,
  allTheatersFailed: false,
  completionStatus: '',
};

function outcomeToResponse(pointer: OutcomePointer, note: string): GetSimulationOutcomeResponse {
  const theaterSummariesJson = Array.isArray(pointer.uiTheaters) && pointer.uiTheaters.length > 0
    ? JSON.stringify(pointer.uiTheaters)
    : '';
  return {
    found: true,
    runId: pointer.runId,
    outcomeKey: pointer.outcomeKey,
    schemaVersion: pointer.schemaVersion,
    theaterCount: pointer.theaterCount,
    generatedAt: pointer.generatedAt,
    note,
    error: '',
    theaterSummariesJson,
    processing: false,
    eligibleTheaterCount: typeof pointer.eligibleTheaterCount === 'number' ? pointer.eligibleTheaterCount : pointer.theaterCount,
    failedTheaterCount: typeof pointer.failedTheaterCount === 'number' ? pointer.failedTheaterCount : 0,
    allTheatersFailed: pointer.allTheatersFailed === true,
    completionStatus: typeof pointer.completionStatus === 'string' ? pointer.completionStatus : '',
  };
}

export const getSimulationOutcome: ForecastServiceHandler['getSimulationOutcome'] = async (
  ctx: ServerContext,
  req: GetSimulationOutcomeRequest,
): Promise<GetSimulationOutcomeResponse> => {
  // Read path when caller supplied a specific runId:
  //   1. By-run hit (real outcome) → return it.
  //   2. By-run hit (tombstone payload) → fall through with the tombstone note text.
  //   3. By-run miss + runId in queue → return processing=true.
  //   4. By-run miss + runId not queued → fall through to :latest.
  // See #3734 U6.
  if (req.runId) {
    let byRunRaw: unknown = null;
    try {
      byRunRaw = await getRawJson(`${SIMULATION_OUTCOME_BY_RUN_KEY_PREFIX}:${req.runId}`);
    } catch (err) {
      console.warn(`[getSimulationOutcome] by-run lookup failed for ${req.runId}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to :latest below.
    }
    if (isOutcomePointer(byRunRaw)) {
      return outcomeToResponse(byRunRaw, '');
    }
    if (isTombstone(byRunRaw)) {
      // Tombstone hit → still fall through to :latest but signal the distinction
      // via a different note text so callers can react (D9).
      try {
        const latestRaw = await getRawJson(SIMULATION_OUTCOME_LATEST_KEY);
        const latest = isOutcomePointer(latestRaw) ? latestRaw : null;
        if (latest?.outcomeKey) {
          return outcomeToResponse(
            latest,
            'by-run lookup failed (Redis transient); returned latest available outcome instead',
          );
        }
      } catch (err) {
        console.warn('[getSimulationOutcome] :latest lookup failed after tombstone:', err instanceof Error ? err.message : String(err));
      }
      markNoCacheResponse(ctx.request);
      return { ...NOT_FOUND, error: 'redis_unavailable' };
    }
    // By-run miss — probe the queue to distinguish "processing" from "expired".
    try {
      const queued = await listProcessingRunIds();
      if (queued.includes(req.runId)) {
        // CRITICAL: mark no-cache. The processing state is transient —
        // caching it via the gateway's `slow` tier (30-min CDN) would
        // serve stale "still processing" for up to 30 min after the
        // worker actually completes. Polling clients would never see
        // the outcome land. (Human review on PR #3811.)
        markNoCacheResponse(ctx.request);
        return {
          ...NOT_FOUND,
          runId: req.runId,
          processing: true,
        };
      }
    } catch (err) {
      console.warn('[getSimulationOutcome] queue probe failed:', err instanceof Error ? err.message : String(err));
      // Fall through.
    }
    // No match anywhere — fall through to :latest with the expiry note.
  }

  try {
    const raw = await getRawJson(SIMULATION_OUTCOME_LATEST_KEY);
    const pointer = isOutcomePointer(raw) ? raw : null;
    if (!pointer?.outcomeKey) {
      markNoCacheResponse(ctx.request);
      return NOT_FOUND;
    }
    const note = req.runId && req.runId !== pointer.runId
      ? 'requested runId not found (may have expired beyond 24h retention); returned latest available outcome instead'
      : '';
    return outcomeToResponse(pointer, note);
  } catch (err) {
    console.warn('[getSimulationOutcome] Redis error:', err instanceof Error ? err.message : String(err));
    markNoCacheResponse(ctx.request);
    return { ...NOT_FOUND, error: 'redis_unavailable' };
  }
};
