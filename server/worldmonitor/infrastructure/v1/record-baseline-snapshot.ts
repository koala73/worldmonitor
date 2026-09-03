import type {
  ServerContext,
  RecordBaselineSnapshotRequest,
  RecordBaselineSnapshotResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { setCachedJson, setCachedJsonIfAbsent } from '../../../_shared/redis';
import {
  VALID_BASELINE_TYPES,
  VALID_BASELINE_REGIONS,
  MAX_BASELINE_COUNT,
  BASELINE_SAMPLE_INTERVAL_SECONDS,
  BASELINE_TTL,
  makeBaselineKey,
  makeBaselineSampleClaimKey,
  mgetJson,
  type BaselineEntry,
} from './_shared';

/**
 * Reason this update is not a usable observation, or null when it is.
 *
 * Runs before any key is built. `region` reaches a 90-day Redis key and
 * `count` reaches shared statistics, so neither is allowed near Redis until it
 * has been checked.
 */
function rejectReason(type: string, region: string, count: unknown): string | null {
  if (!VALID_BASELINE_TYPES.includes(type)) return 'unknown type';
  if (!VALID_BASELINE_REGIONS.has(region)) return 'unknown region';
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'count must be finite';
  if (count < 0 || count > MAX_BASELINE_COUNT) return 'count out of range';
  return null;
}

// ========================================================================
// RPC implementation
// ========================================================================

export async function recordBaselineSnapshot(
  _ctx: ServerContext,
  req: RecordBaselineSnapshotRequest,
): Promise<RecordBaselineSnapshotResponse> {
  try {
    const updates = req.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return { updated: 0, error: 'Body must have updates array' };
    }

    const batch = updates.slice(0, 20);
    const now = new Date();
    const weekday = now.getUTCDay();
    const month = now.getUTCMonth() + 1;

    // Validate before a key exists. The old order built every key from the
    // caller's `region` and MGET'd them first, so an arbitrary region reached
    // Redis whether or not the update was usable.
    const accepted: { count: number; key: string }[] = [];
    let rejected = 0;
    for (const update of batch) {
      const region = update.region || 'global';
      if (rejectReason(update.type, region, update.count) !== null) {
        rejected++;
        continue;
      }
      accepted.push({ count: update.count, key: makeBaselineKey(update.type, region, weekday, month) });
    }

    if (accepted.length === 0) {
      return { updated: 0, error: rejected > 0 ? 'No valid updates' : '' };
    }

    // Claim this interval's single sample per baseline. SET NX carries two
    // jobs: it caps a baseline at one observation per interval regardless of
    // how many callers report one, and it makes the claim winner the sole
    // writer, so the read-modify-write below cannot interleave with a
    // concurrent request for the same key and lose an update. The previous
    // code MGET'd, computed in the edge function, and issued independent SETs
    // with no lock, so simultaneous callers silently overwrote each other.
    const claims = await Promise.all(accepted.map(entry => setCachedJsonIfAbsent(
      makeBaselineSampleClaimKey(entry.key),
      now.toISOString(),
      BASELINE_SAMPLE_INTERVAL_SECONDS,
    )));
    const claimed = accepted.filter((_, i) => claims[i] === true);

    if (claimed.length === 0) {
      return { updated: 0, error: '' };
    }

    const existing = await mgetJson(claimed.map(entry => entry.key)) as (BaselineEntry | null)[];
    const writes: Promise<boolean>[] = [];

    for (let i = 0; i < claimed.length; i++) {
      const { count, key } = claimed[i]!;
      const prev: BaselineEntry = existing[i] as BaselineEntry || { mean: 0, m2: 0, sampleCount: 0, lastUpdated: '' };

      // Welford's online algorithm
      const n = prev.sampleCount + 1;
      const delta = count - prev.mean;
      const newMean = prev.mean + delta / n;
      const delta2 = count - newMean;
      const newM2 = prev.m2 + delta * delta2;

      writes.push(setCachedJson(key, {
        mean: newMean,
        m2: newM2,
        sampleCount: n,
        lastUpdated: now.toISOString(),
      }, BASELINE_TTL));
    }

    await Promise.all(writes);

    return { updated: writes.length, error: '' };
  } catch {
    return { updated: 0, error: 'Internal error' };
  }
}
