import type {
  GetPhysicalDivergenceIndexResponse,
  MarketServiceHandler,
  PhysicalDivergenceReading,
  PhysicalDivergenceState,
  PhysicalPremiumRegime,
  PhysicalPremiumTrend,
  PhysicalStressComposite,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import {
  PHYSICAL_DIVERGENCE_METALS,
  PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
  type PhysicalDivergenceRawComposite,
  type PhysicalDivergenceRawReading,
  type PhysicalDivergenceRawRegime,
  type PhysicalDivergenceRawState,
  type PhysicalDivergenceRawTrend,
  isUnsupportedPhysicalDivergenceMethodology,
  normalizePhysicalDivergenceSnapshot,
} from '../../../_shared/physical-divergence-snapshot';
import { readCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { parseStringArray } from './_shared';
import { resolvePhysicalPremiumMetals } from './get-physical-premiums';

const PHYSICAL_DIVERGENCE_KEY = 'market:physical-divergence:v1';

const STATE_MAP: Record<PhysicalDivergenceRawState, PhysicalDivergenceState> = {
  ok: 'PHYSICAL_DIVERGENCE_STATE_OK',
  insufficient_history: 'PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY',
  stale_input: 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT',
  missing_input: 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT',
};

const REGIME_MAP: Record<PhysicalDivergenceRawRegime, PhysicalPremiumRegime> = {
  normal: 'PHYSICAL_PREMIUM_REGIME_NORMAL',
  elevated: 'PHYSICAL_PREMIUM_REGIME_ELEVATED',
  stressed: 'PHYSICAL_PREMIUM_REGIME_STRESSED',
  extreme: 'PHYSICAL_PREMIUM_REGIME_EXTREME',
};

const TREND_MAP: Record<PhysicalDivergenceRawTrend, PhysicalPremiumTrend> = {
  widening: 'PHYSICAL_PREMIUM_TREND_WIDENING',
  stable: 'PHYSICAL_PREMIUM_TREND_STABLE',
  narrowing: 'PHYSICAL_PREMIUM_TREND_NARROWING',
};

function instantMsOrUnavailable(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapReading(raw: PhysicalDivergenceRawReading): PhysicalDivergenceReading {
  return {
    metal: raw.metal,
    state: STATE_MAP[raw.state],
    reason: raw.reason,
    regime: raw.regime == null
      ? 'PHYSICAL_PREMIUM_REGIME_UNSPECIFIED'
      : REGIME_MAP[raw.regime],
    index: raw.index ?? undefined,
    premiumPct: raw.premiumPct ?? undefined,
    premiumUsdPerOz: raw.premiumUsdPerOz ?? undefined,
    percentile: raw.percentile ?? undefined,
    robustZ: raw.robustZ ?? undefined,
    delta5d: raw.delta5d ?? undefined,
    delta20d: raw.delta20d ?? undefined,
    trend5d: raw.trend5d == null
      ? 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED'
      : TREND_MAP[raw.trend5d],
    trend20d: raw.trend20d == null
      ? 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED'
      : TREND_MAP[raw.trend20d],
    historyPoints: raw.historyPoints,
    historyWindowStart: raw.historyWindowStart,
    historyWindowEnd: raw.historyWindowEnd,
    physicalAsOf: raw.physicalAsOf,
    paperAsOf: instantMsOrUnavailable(raw.paperAsOf),
    historyKey: raw.provenance.historyKey,
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
    provenance: {
      ...raw.provenance,
      paperAsOf: instantMsOrUnavailable(raw.provenance.paperAsOf),
      fxAsOf: instantMsOrUnavailable(raw.provenance.fxAsOf),
    },
  };
}

function mapComposite(raw: PhysicalDivergenceRawComposite): PhysicalStressComposite {
  return {
    state: STATE_MAP[raw.state],
    reason: raw.reason,
    index: raw.index ?? undefined,
    weights: raw.weights,
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
  };
}

function missingResponse(
  metals: readonly string[],
  reason = 'divergence_snapshot_unavailable',
): GetPhysicalDivergenceIndexResponse {
  const selected = metals.length > 0 ? metals : PHYSICAL_DIVERGENCE_METALS;
  return {
    readings: selected.map((metal) => ({
      metal,
      state: 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT',
      reason,
      regime: 'PHYSICAL_PREMIUM_REGIME_UNSPECIFIED',
      trend5d: 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED',
      trend20d: 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED',
      historyPoints: 0,
      historyWindowStart: '',
      historyWindowEnd: '',
      physicalAsOf: '',
      paperAsOf: 0,
      historyKey: `market:physical-premium-history:v1:${metal}`,
      methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
    })),
    composite: {
      state: 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT',
      reason,
      weights: [
        { metal: 'gold', weight: 0.7, methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION },
        { metal: 'silver', weight: 0.3, methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION },
      ],
      methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
    },
    evaluatedAt: 0,
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
  };
}

export const getPhysicalDivergenceIndex: MarketServiceHandler['getPhysicalDivergenceIndex'] = async (ctx, req) => {
  const metals = resolvePhysicalPremiumMetals(parseStringArray(req.metals));
  const cacheRead = await readCachedJson(PHYSICAL_DIVERGENCE_KEY, true);
  if (cacheRead.status === 'error') throw cacheRead.error;
  if (cacheRead.status !== 'hit') {
    return markNoStoreFallbackResponse(ctx.request, missingResponse(metals));
  }
  // The Railway seeder and this API deploy independently, so a methodology bump lands on one
  // side first. Fail closed with a reason for the length of that window rather than turning
  // every request into a 500 — the same graceful shape an absent key already returns. An
  // unknown STATE is not covered here: #6448 requires that surface as an error.
  let snapshot: ReturnType<typeof normalizePhysicalDivergenceSnapshot>;
  try {
    snapshot = normalizePhysicalDivergenceSnapshot(cacheRead.value, Date.now());
  } catch (error) {
    if (isUnsupportedPhysicalDivergenceMethodology(error)) {
      return markNoStoreFallbackResponse(
        ctx.request,
        missingResponse(metals, 'divergence_methodology_unsupported'),
      );
    }
    throw error;
  }
  const readings = snapshot.readings.map(mapReading);
  const selected = new Set(metals);
  return {
    readings: metals.length === 0 ? readings : readings.filter((reading) => selected.has(reading.metal)),
    composite: mapComposite(snapshot.composite),
    evaluatedAt: instantMsOrUnavailable(snapshot.evaluatedAt),
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
  };
};
