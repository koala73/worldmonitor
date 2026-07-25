import type {
  DecisionSignalContentFreshness,
  DecisionSignalProvenance,
  DecisionSignalProvenanceSurface,
  DecisionSignalTransportFreshness,
} from './decision-signal-provenance';
import { DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS } from './decision-signal-provenance';
import type {
  ChinaCorridorNode,
  ChinaCorridorPoint,
  ChinaCorridorSignalFamily,
  ChinaLogisticsCorridorId,
} from './china-logistics-corridors';
import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  CHINA_LOGISTICS_CORRIDORS,
  CHINA_LOGISTICS_CORRIDOR_IDS,
} from './china-logistics-corridors';

export type CorridorAvailability = 'available' | 'partial' | 'stale' | 'unavailable';
export type CorridorSourceAvailability = CorridorAvailability | 'error';
export type CorridorTimePrecision = 'instant' | 'day' | 'month' | 'year' | 'unknown';

export interface CorridorSourceSignal {
  id: string;
  family: ChinaCorridorSignalFamily;
  selectorId: string;
  corridorIds?: ChinaLogisticsCorridorId[];
  availability: 'available' | 'stale' | 'unavailable';
  publisher: {
    id: string;
    name: string;
    type: 'official' | 'market' | 'independent' | 'derived' | 'unknown';
  };
  sourceUrl: string | null;
  sourceScope: 'node' | 'regional' | 'national';
  observationTime: string | null;
  observationTimePrecision: CorridorTimePrecision;
  releaseTime: string | null;
  releaseTimePrecision: CorridorTimePrecision;
  retrievalTime: string | null;
  retrievalTimePrecision: CorridorTimePrecision;
  revision: {
    vintageId: string;
    sequence: number;
    state: 'original' | 'revised' | 'corrected';
  } | null;
  transportFreshness: DecisionSignalTransportFreshness['state'];
  contentFreshness: DecisionSignalContentFreshness['state'];
  summary: string;
  metrics: Record<string, string | number | boolean | null>;
}

export interface CorridorFamilySource {
  providerId: string;
  availability: CorridorSourceAvailability;
  reason?: string;
  signals: CorridorSourceSignal[];
}

export interface ChinaCorridorSourceBundle {
  assessedAt: string;
  families: Record<ChinaCorridorSignalFamily, CorridorFamilySource>;
}

export interface ChinaCorridorCondition {
  family: ChinaCorridorSignalFamily;
  providerId: string;
  availability: CorridorAvailability;
  reason: string | null;
  sourceSignals: CorridorSourceSignal[];
  provenance: DecisionSignalProvenance | null;
}

export interface ChinaCorridorControlTower {
  id: ChinaLogisticsCorridorId;
  name: string;
  description: string;
  boundary: readonly ChinaCorridorPoint[];
  nodes: readonly ChinaCorridorNode[];
  availability: CorridorAvailability;
  conditions: ChinaCorridorCondition[];
}

export interface ChinaCorridorControlTowerResponse {
  generatedAt: string;
  corridors: ChinaCorridorControlTower[];
}

export function deriveChinaCorridorAvailability(
  conditions: readonly ChinaCorridorCondition[],
): CorridorAvailability {
  if (conditions.every((condition) => condition.availability === 'unavailable')) {
    return 'unavailable';
  }
  if (conditions.every((condition) => condition.availability === 'available')) {
    return 'available';
  }
  if (
    conditions.every((condition) =>
      condition.availability === 'available' || condition.availability === 'stale')
    && conditions.some((condition) => condition.availability === 'stale')
  ) {
    return 'stale';
  }
  return 'partial';
}

const PROVENANCE_VALIDATION_FAILURE_REASON =
  'Condition provenance failed validation; this condition is partial until a valid envelope is published.';

export function createUnavailableChinaCorridorControlTowerResponse(
  generatedAt: string,
  reason = 'China corridor source observations are unavailable.',
): ChinaCorridorControlTowerResponse {
  return {
    generatedAt,
    corridors: CHINA_LOGISTICS_CORRIDORS.map((corridor) => ({
      id: corridor.id,
      name: corridor.name,
      description: corridor.description,
      boundary: corridor.boundary,
      nodes: corridor.nodes,
      availability: 'unavailable',
      conditions: CHINA_CORRIDOR_SIGNAL_FAMILIES.map((family) => ({
        family,
        providerId: 'unavailable',
        availability: 'unavailable',
        reason,
        sourceSignals: [],
        provenance: null,
      })),
    })),
  };
}

export function validateChinaCorridorProvenanceForSurface(
  response: ChinaCorridorControlTowerResponse,
  surface: DecisionSignalProvenanceSurface,
): ChinaCorridorControlTowerResponse {
  const adapter = DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS[surface];
  return {
    ...response,
    corridors: response.corridors.map((corridor) => {
      const conditions: ChinaCorridorCondition[] = corridor.conditions.map((condition) => {
        if (condition.provenance === null) return condition;
        try {
          return {
            ...condition,
            provenance: adapter.deserialize(adapter.serialize(condition.provenance)),
          };
        } catch {
          return {
            ...condition,
            availability: condition.availability === 'unavailable' ? 'unavailable' : 'partial',
            reason: PROVENANCE_VALIDATION_FAILURE_REASON,
            provenance: null,
          };
        }
      });
      return {
        ...corridor,
        availability: deriveChinaCorridorAvailability(conditions),
        conditions,
      };
    }),
  };
}

export function parseChinaCorridorWirePayload(
  payloadJson: string,
): ChinaCorridorControlTowerResponse {
  const parsed: unknown = JSON.parse(payloadJson);
  const corridors = typeof parsed === 'object' && parsed !== null
    ? (parsed as { corridors?: unknown }).corridors
    : null;
  if (
    typeof parsed !== 'object'
    || parsed === null
    || typeof (parsed as { generatedAt?: unknown }).generatedAt !== 'string'
    || !Array.isArray(corridors)
    || corridors.length !== CHINA_LOGISTICS_CORRIDOR_IDS.length
  ) {
    throw new Error('Invalid China corridor control-tower response');
  }
  const corridorIds = new Set(corridors.map((corridor) =>
    typeof corridor === 'object' && corridor !== null
      ? (corridor as { id?: unknown }).id
      : null));
  if (
    corridorIds.size !== CHINA_LOGISTICS_CORRIDOR_IDS.length
    || !CHINA_LOGISTICS_CORRIDOR_IDS.every((id) => corridorIds.has(id))
  ) {
    throw new Error('Invalid China corridor control-tower response');
  }
  return validateChinaCorridorProvenanceForSurface(
    parsed as ChinaCorridorControlTowerResponse,
    'ui',
  );
}
