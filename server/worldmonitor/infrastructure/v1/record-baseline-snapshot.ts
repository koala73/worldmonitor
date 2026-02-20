import type {
  ServerContext,
  RecordBaselineSnapshotRequest,
  RecordBaselineSnapshotResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { setCachedJson } from '../../../_shared/redis';
import {
  VALID_BASELINE_TYPES,
  BASELINE_TTL,
  makeBaselineKey,
  mgetJson,
  type BaselineEntry,
} from './_shared';

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

    const keys = batch.map(u => makeBaselineKey(u.type, u.region || 'global', weekday, month));
    const existing = await mgetJson(keys) as (BaselineEntry | null)[];

    const writes: Promise<void>[] = [];

    for (let i = 0; i < batch.length; i++) {
      const { type, count } = batch[i]!;
      if (!VALID_BASELINE_TYPES.includes(type) || typeof count !== 'number' || isNaN(count)) continue;

      const prev: BaselineEntry = existing[i] as BaselineEntry || { mean: 0, m2: 0, sampleCount: 0, lastUpdated: '' };

      // Welford's online algorithm
      const n = prev.sampleCount + 1;
      const delta = count - prev.mean;
      const newMean = prev.mean + delta / n;
      const delta2 = count - newMean;
      const newM2 = prev.m2 + delta * delta2;

      writes.push(setCachedJson(keys[i]!, {
        mean: newMean,
        m2: newM2,
        sampleCount: n,
        lastUpdated: now.toISOString(),
      }, BASELINE_TTL));
    }

    if (writes.length > 0) {
      await Promise.all(writes);
    }

    return { updated: writes.length, error: '' };
  } catch {
    return { updated: 0, error: 'Internal error' };
  }
}
