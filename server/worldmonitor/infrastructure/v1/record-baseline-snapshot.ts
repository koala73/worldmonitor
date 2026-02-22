import type {
  ServerContext,
  RecordBaselineSnapshotRequest,
  RecordBaselineSnapshotResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { setCachedJson } from '../../../_shared/redis';
import {
  VALID_BASELINE_TYPES,
  BASELINE_TTL,
  SHORT_BASELINE_TTL,
  EMA_ALPHA,
  ANCHOR_FREEZE_COUNT,
  makeBaselineKey,
  makeShortBaselineKey,
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

    // Fetch both long-term and short-term baselines in parallel
    const longKeys = batch.map(u => makeBaselineKey(u.type, u.region || 'global', weekday, month));
    const shortKeys = batch.map(u => makeShortBaselineKey(u.type, u.region || 'global'));
    const allKeys = [...longKeys, ...shortKeys];
    const allExisting = await mgetJson(allKeys) as (BaselineEntry | null)[];
    const existingLong = allExisting.slice(0, batch.length);
    const existingShort = allExisting.slice(batch.length);

    const writes: Promise<void>[] = [];

    for (let i = 0; i < batch.length; i++) {
      const { type, count } = batch[i]!;
      if (!VALID_BASELINE_TYPES.includes(type) || typeof count !== 'number' || isNaN(count)) continue;

      // --- Long-term baseline (90d TTL, weekday+month stratified) ---
      const prevLong: BaselineEntry = existingLong[i] as BaselineEntry || { mean: 0, m2: 0, sampleCount: 0, lastUpdated: '' };

      // Welford's online algorithm
      const nLong = prevLong.sampleCount + 1;
      const deltaLong = count - prevLong.mean;
      const newMeanLong = prevLong.mean + deltaLong / nLong;
      const delta2Long = count - newMeanLong;
      const newM2Long = prevLong.m2 + deltaLong * delta2Long;

      // EMA update (exponential moving average for trend detection)
      const prevEma = prevLong.emaMean ?? prevLong.mean;
      const newEma = prevEma + EMA_ALPHA * (count - prevEma);

      // Anchor mean: frozen after ANCHOR_FREEZE_COUNT samples (boiling frog detection)
      const prevAnchorCount = prevLong.anchorSampleCount ?? 0;
      const prevAnchorMean = prevLong.anchorMean ?? prevLong.mean;
      const anchorFrozen = prevAnchorCount >= ANCHOR_FREEZE_COUNT;
      const newAnchorMean = anchorFrozen
        ? prevAnchorMean
        : prevAnchorMean + (count - prevAnchorMean) / (prevAnchorCount + 1);
      const newAnchorCount = anchorFrozen ? prevAnchorCount : prevAnchorCount + 1;

      writes.push(setCachedJson(longKeys[i]!, {
        mean: newMeanLong,
        m2: newM2Long,
        sampleCount: nLong,
        lastUpdated: now.toISOString(),
        emaMean: newEma,
        anchorMean: newAnchorMean,
        anchorSampleCount: newAnchorCount,
      }, BASELINE_TTL));

      // --- Short-term baseline (7d TTL, natural reset via expiry) ---
      const prevShort: BaselineEntry = existingShort[i] as BaselineEntry || { mean: 0, m2: 0, sampleCount: 0, lastUpdated: '' };

      const nShort = prevShort.sampleCount + 1;
      const deltaShort = count - prevShort.mean;
      const newMeanShort = prevShort.mean + deltaShort / nShort;
      const delta2Short = count - newMeanShort;
      const newM2Short = prevShort.m2 + deltaShort * delta2Short;

      writes.push(setCachedJson(shortKeys[i]!, {
        mean: newMeanShort,
        m2: newM2Short,
        sampleCount: nShort,
        lastUpdated: now.toISOString(),
      }, SHORT_BASELINE_TTL));
    }

    if (writes.length > 0) {
      await Promise.all(writes);
    }

    return { updated: writes.length, error: '' };
  } catch {
    return { updated: 0, error: 'Internal error' };
  }
}
