import type {
  ServerContext,
  GetTemporalBaselineRequest,
  GetTemporalBaselineResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import {
  VALID_BASELINE_TYPES,
  MIN_SAMPLES,
  Z_THRESHOLD_LOW,
  makeBaselineKey,
  getBaselineSeverity,
  type BaselineEntry,
} from './_shared';

// ========================================================================
// RPC implementation
// ========================================================================

export async function getTemporalBaseline(
  _ctx: ServerContext,
  req: GetTemporalBaselineRequest,
): Promise<GetTemporalBaselineResponse> {
  try {
    const { type, count } = req;
    const region = req.region || 'global';

    if (!type || !VALID_BASELINE_TYPES.includes(type) || typeof count !== 'number' || isNaN(count)) {
      return {
        learning: false,
        sampleCount: 0,
        samplesNeeded: 0,
        error: 'Missing or invalid params: type and count required',
      };
    }

    const now = new Date();
    const weekday = now.getUTCDay();
    const month = now.getUTCMonth() + 1;
    const key = makeBaselineKey(type, region, weekday, month);

    const baseline = await getCachedJson(key) as BaselineEntry | null;

    if (!baseline || baseline.sampleCount < MIN_SAMPLES) {
      return {
        learning: true,
        sampleCount: baseline?.sampleCount || 0,
        samplesNeeded: MIN_SAMPLES,
        error: '',
      };
    }

    const variance = Math.max(0, baseline.m2 / (baseline.sampleCount - 1));
    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? Math.abs((count - baseline.mean) / stdDev) : 0;
    const severity = getBaselineSeverity(zScore);
    const multiplier = baseline.mean > 0
      ? Math.round((count / baseline.mean) * 100) / 100
      : count > 0 ? 999 : 1;

    return {
      anomaly: zScore >= Z_THRESHOLD_LOW ? {
        zScore: Math.round(zScore * 100) / 100,
        severity,
        multiplier,
      } : undefined,
      baseline: {
        mean: Math.round(baseline.mean * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
        sampleCount: baseline.sampleCount,
      },
      learning: false,
      sampleCount: baseline.sampleCount,
      samplesNeeded: MIN_SAMPLES,
      error: '',
    };
  } catch {
    return {
      learning: false,
      sampleCount: 0,
      samplesNeeded: 0,
      error: 'Internal error',
    };
  }
}
