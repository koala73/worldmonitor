import {
  isPhysicalDivergenceContractError,
  normalizePhysicalDivergenceSnapshot,
} from './physical-divergence-snapshot';
import { PHYSICAL_DIVERGENCE_CONTRACT } from '../../shared/physical-divergence-contract.js';

export const PHYSICAL_PREMIUM_SYMBOL_ALIASES: Record<string, string[]> = {
  gold: ['gold', 'xau', PHYSICAL_DIVERGENCE_CONTRACT.metals.gold.paperSymbol.toLowerCase()],
  silver: ['silver', 'xag', PHYSICAL_DIVERGENCE_CONTRACT.metals.silver.paperSymbol.toLowerCase()],
};

export const PHYSICAL_PREMIUM_OUTPUT_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    premiums: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          metal: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.metalOrder },
          physical: { type: 'object', properties: { price: { type: 'number' }, currency: { type: 'string' }, unit: { type: 'string' }, source: { type: 'string' }, asOf: { type: 'string' } } },
          paper: { type: 'object', properties: { price: { type: 'number' }, source: { type: 'string' }, asOf: { type: 'string' } } },
          premiumUsdPerOz: { type: 'number' },
          premiumPct: { type: 'number' },
          computedAt: { type: 'string' },
        },
      },
    },
    fx: { type: 'object', properties: { pair: { type: 'string' }, rate: { type: 'number' }, source: { type: 'string' }, asOf: { type: 'string' } } },
  },
} as const;

export const PHYSICAL_DIVERGENCE_OUTPUT_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    methodologyVersion: { type: 'string' },
    evaluatedAt: { type: 'string' },
    readings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          metal: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.metalOrder },
          state: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.states },
          reason: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.readingReasonValues },
          regime: { type: ['string', 'null'], enum: [...PHYSICAL_DIVERGENCE_CONTRACT.regimes, null] },
          index: { type: ['number', 'null'] },
          premiumPct: { type: ['number', 'null'] },
          premiumUsdPerOz: { type: ['number', 'null'] },
          percentile: { type: ['number', 'null'] },
          robustZ: { type: ['number', 'null'] },
          delta5d: { type: ['number', 'null'] },
          delta20d: { type: ['number', 'null'] },
          trend5d: { type: ['string', 'null'], enum: [...PHYSICAL_DIVERGENCE_CONTRACT.trends, null] },
          trend20d: { type: ['string', 'null'], enum: [...PHYSICAL_DIVERGENCE_CONTRACT.trends, null] },
          historyPoints: { type: 'number' },
          historyWindowStart: { type: 'string' },
          historyWindowEnd: { type: 'string' },
          physicalAsOf: { type: 'string' },
          paperAsOf: { type: 'string' },
          historyKey: { type: 'string' },
          methodologyVersion: { type: 'string' },
          provenance: {
            type: 'object',
            properties: {
              physicalSource: { type: 'string' },
              physicalSymbol: { type: 'string' },
              physicalAsOf: { type: 'string' },
              paperSource: { type: 'string' },
              paperSymbol: { type: 'string' },
              paperAsOf: { type: 'string' },
              fxSource: { type: 'string' },
              fxPair: { type: 'string' },
              fxAsOf: { type: 'string' },
              historyKey: { type: 'string' },
              historyWindowPoints: { type: 'number' },
              methodologyVersion: { type: 'string' },
            },
          },
        },
      },
    },
    composite: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.states },
        reason: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.compositeReasonValues },
        index: { type: ['number', 'null'] },
        weights: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              metal: { type: 'string', enum: PHYSICAL_DIVERGENCE_CONTRACT.metalOrder },
              weight: { type: 'number' },
              methodologyVersion: { type: 'string' },
            },
          },
        },
        methodologyVersion: { type: 'string' },
      },
    },
  },
} as const;

export function normalizePhysicalDivergenceDataset(data: Record<string, unknown>, nowMs = Date.now()): void {
  const raw = data['physical-divergence'];
  if (raw == null) return;
  let normalized: ReturnType<typeof normalizePhysicalDivergenceSnapshot>;
  try {
    normalized = normalizePhysicalDivergenceSnapshot(raw, nowMs);
  } catch (error) {
    // Isolate corrupt stored data — one bad blob must not take down the rest of the MCP
    // response. But a CONTRACT violation (an unknown state, or a methodology this build
    // does not implement) is producer/consumer disagreement, and #6448 requires it surface
    // rather than silently vanish. A bare `catch` here would also swallow a future bug in
    // the normalizer itself.
    if (isPhysicalDivergenceContractError(error)) throw error;
    delete data['physical-divergence'];
    return;
  }
  const { transitions: _, ...normalizedWithoutTransitions } = normalized;
  const agentDataset = {
    ...normalizedWithoutTransitions,
    readings: normalizedWithoutTransitions.readings.map((reading) => ({
      ...reading,
      historyKey: reading.provenance.historyKey,
    })),
  };
  if (!matchesPhysicalPremiumCohort(data['physical-premium'], agentDataset.readings)) {
    delete data['physical-divergence'];
    return;
  }
  data['physical-divergence'] = agentDataset;
}

function matchesPhysicalPremiumCohort(
  value: unknown,
  readings: ReturnType<typeof normalizePhysicalDivergenceSnapshot>['readings'],
): boolean {
  const unavailableWithoutCohort = readings.every((reading) => (
    reading.state === 'missing_input'
    && reading.physicalAsOf === ''
    && reading.paperAsOf === ''
  ));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unavailableWithoutCohort;
  }
  const dataset = value as Record<string, unknown>;
  if (!Array.isArray(dataset.premiums) || !dataset.fx || typeof dataset.fx !== 'object' || Array.isArray(dataset.fx)) {
    return false;
  }
  const fxAsOf = (dataset.fx as Record<string, unknown>).asOf;
  if (typeof fxAsOf !== 'string' || fxAsOf === '') return false;

  const premiums = new Map<string, Record<string, unknown>>();
  for (const candidate of dataset.premiums) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const premium = candidate as Record<string, unknown>;
    if (typeof premium.metal !== 'string') return false;
    premiums.set(premium.metal, premium);
  }

  return readings.every((reading) => {
    if (
      reading.state === 'missing_input'
      && reading.physicalAsOf === ''
      && reading.paperAsOf === ''
    ) return true;
    const premium = premiums.get(reading.metal);
    if (!premium) return false;
    const physical = premium.physical;
    const paper = premium.paper;
    if (!physical || typeof physical !== 'object' || Array.isArray(physical)) return false;
    if (!paper || typeof paper !== 'object' || Array.isArray(paper)) return false;
    return (physical as Record<string, unknown>).asOf === reading.physicalAsOf
      && (paper as Record<string, unknown>).asOf === reading.paperAsOf
      && fxAsOf === reading.provenance.fxAsOf;
  });
}
