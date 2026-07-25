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

export function validateChinaCorridorProvenanceForSurface(
  response: ChinaCorridorControlTowerResponse,
  surface: DecisionSignalProvenanceSurface,
): ChinaCorridorControlTowerResponse {
  const adapter = DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS[surface];
  return {
    ...response,
    corridors: response.corridors.map((corridor) => ({
      ...corridor,
      conditions: corridor.conditions.map((condition) => ({
        ...condition,
        provenance: condition.provenance === null
          ? null
          : adapter.deserialize(adapter.serialize(condition.provenance)),
      })),
    })),
  };
}
