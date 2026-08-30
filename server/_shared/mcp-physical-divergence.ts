import { normalizePhysicalDivergenceSnapshot } from './physical-divergence-snapshot';
import { McpStoredDataValidationError } from './mcp-stored-data-validation-error';

export { McpStoredDataValidationError } from './mcp-stored-data-validation-error';

export const PHYSICAL_PREMIUM_SYMBOL_ALIASES: Record<string, string[]> = {
  gold: ['gold', 'xau', 'gc=f'],
  silver: ['silver', 'xag', 'si=f'],
};

export const PHYSICAL_PREMIUM_OUTPUT_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    premiums: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          metal: { type: 'string', enum: ['gold', 'silver'] },
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
          metal: { type: 'string', enum: ['gold', 'silver'] },
          state: { type: 'string', enum: ['ok', 'insufficient_history', 'stale_input', 'missing_input'] },
          reason: { type: 'string' },
          regime: { type: ['string', 'null'], enum: ['normal', 'elevated', 'stressed', 'extreme', null] },
          index: { type: ['number', 'null'] },
          premiumPct: { type: ['number', 'null'] },
          premiumUsdPerOz: { type: ['number', 'null'] },
          percentile: { type: ['number', 'null'] },
          robustZ: { type: ['number', 'null'] },
          delta5d: { type: ['number', 'null'] },
          delta20d: { type: ['number', 'null'] },
          trend5d: { type: ['string', 'null'], enum: ['widening', 'stable', 'narrowing', null] },
          trend20d: { type: ['string', 'null'], enum: ['widening', 'stable', 'narrowing', null] },
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
        state: { type: 'string', enum: ['ok', 'insufficient_history', 'stale_input', 'missing_input'] },
        reason: { type: 'string' },
        index: { type: ['number', 'null'] },
        weights: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              metal: { type: 'string', enum: ['gold', 'silver'] },
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
    if (error instanceof TypeError && error.message.startsWith('Unknown physical divergence state:')) {
      throw new McpStoredDataValidationError(error.message);
    }
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
