import type {
  ServerContext,
  GetTemporalBaselineRequest,
  GetTemporalBaselineResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import {
  VALID_BASELINE_TYPES,
  MIN_SAMPLES,
  MIN_SAMPLES_SHORT,
  Z_THRESHOLD_LOW,
  makeBaselineKey,
  makeShortBaselineKey,
  getDualBaselineSeverity,
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
    const longKey = makeBaselineKey(type, region, weekday, month);
    const shortKey = makeShortBaselineKey(type, region);

    // Fetch both baselines in parallel
    const [longBaseline, shortBaseline] = await Promise.all([
      getCachedJson(longKey) as Promise<BaselineEntry | null>,
      getCachedJson(shortKey) as Promise<BaselineEntry | null>,
    ]);

    const longReady = longBaseline && longBaseline.sampleCount >= MIN_SAMPLES;
    const shortReady = shortBaseline && shortBaseline.sampleCount >= MIN_SAMPLES_SHORT;

    // If neither baseline is ready, still learning
    if (!longReady && !shortReady) {
      return {
        learning: true,
        sampleCount: Math.max(longBaseline?.sampleCount ?? 0, shortBaseline?.sampleCount ?? 0),
        samplesNeeded: MIN_SAMPLES_SHORT, // Short-term warms up faster
        error: '',
      };
    }

    // Calculate z-scores for each ready baseline
    let zScoreLong = 0;
    let zScoreShort = 0;
    let primaryMean = 0;
    let primaryStdDev = 0;
    let primarySampleCount = 0;

    if (longReady) {
      const variance = Math.max(0, longBaseline!.m2 / (longBaseline!.sampleCount - 1));
      const stdDev = Math.sqrt(variance);
      primaryStdDev = stdDev;
      primarySampleCount = longBaseline!.sampleCount;

      // Compare against anchor mean (not running mean) to detect boiling frog
      const compareMean = longBaseline!.anchorMean ?? longBaseline!.mean;
      primaryMean = compareMean;
      zScoreLong = stdDev > 0 ? Math.abs((count - compareMean) / stdDev) : 0;
    }

    if (shortReady) {
      const variance = Math.max(0, shortBaseline!.m2 / (shortBaseline!.sampleCount - 1));
      const stdDev = Math.sqrt(variance);
      zScoreShort = stdDev > 0 ? Math.abs((count - shortBaseline!.mean) / stdDev) : 0;

      // If long-term isn't ready, use short-term as primary
      if (!longReady) {
        primaryMean = shortBaseline!.mean;
        primaryStdDev = stdDev;
        primarySampleCount = shortBaseline!.sampleCount;
      }
    }

    // Report max of both z-scores — catches sudden spikes AND gradual escalation
    const maxZScore = Math.max(zScoreShort, zScoreLong);
    const severity = getDualBaselineSeverity(zScoreShort, zScoreLong);
    const multiplier = primaryMean > 0
      ? Math.round((count / primaryMean) * 100) / 100
      : count > 0 ? 999 : 1;

    return {
      anomaly: maxZScore >= Z_THRESHOLD_LOW ? {
        zScore: Math.round(maxZScore * 100) / 100,
        severity,
        multiplier,
      } : undefined,
      baseline: {
        mean: Math.round(primaryMean * 100) / 100,
        stdDev: Math.round(primaryStdDev * 100) / 100,
        sampleCount: primarySampleCount,
      },
      learning: false,
      sampleCount: primarySampleCount,
      samplesNeeded: MIN_SAMPLES_SHORT,
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
