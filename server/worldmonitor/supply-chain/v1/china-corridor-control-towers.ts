import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  CHINA_LOGISTICS_CORRIDORS,
  findCorridorsForSourceSelector,
  type ChinaCorridorSignalFamily,
  type ChinaLogisticsCorridorId,
} from '../../../../shared/china-logistics-corridors';
import {
  deriveChinaCorridorConditionAvailability,
  deriveChinaCorridorAvailability,
  type ChinaCorridorCondition,
  type ChinaCorridorControlTowerResponse,
  type ChinaCorridorSourceBundle,
  type CorridorFamilySource,
  type CorridorSourceSignal,
} from '../../../../shared/china-corridor-control-towers';
import {
  DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION,
  DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS,
  type DecisionSignalContentFreshness,
  type DecisionSignalProvenance,
  type DecisionSignalTransportFreshness,
} from '../../../../shared/decision-signal-provenance';

export type {
  ChinaCorridorControlTowerResponse,
  ChinaCorridorSourceBundle,
  CorridorSourceSignal,
} from '../../../../shared/china-corridor-control-towers';

const transportRank: Record<DecisionSignalTransportFreshness['state'], number> = {
  fresh: 0,
  stale: 1,
  missing: 2,
  error: 3,
};

const contentRank: Record<DecisionSignalContentFreshness['state'], number> = {
  current: 0,
  timestamp_unknown: 1,
  stale: 2,
  partial: 3,
  unavailable: 4,
};

function worstState<T extends string>(values: readonly T[], rank: Record<T, number>): T {
  return values.reduce((worst, item) => rank[item] > rank[worst] ? item : worst);
}

function latestTimedSignal(
  signals: readonly CorridorSourceSignal[],
  field: 'observationTime' | 'retrievalTime',
): CorridorSourceSignal | null {
  const present = signals.filter((signal) => {
    const timestamp = signal[field];
    return timestamp !== null && Number.isFinite(Date.parse(timestamp));
  });
  if (present.length === 0) return null;
  return present.reduce((latest, signal) =>
    Date.parse(signal[field] ?? '') > Date.parse(latest[field] ?? '') ? signal : latest);
}

function timestampAtPrecision(
  timestamp: string,
  precision: CorridorSourceSignal['observationTimePrecision'],
): string {
  if (precision === 'year') return timestamp.slice(0, 4);
  if (precision === 'month') return timestamp.slice(0, 7);
  if (precision === 'day') return timestamp.slice(0, 10);
  return timestamp;
}

function buildProvenance(
  corridorId: ChinaLogisticsCorridorId,
  family: ChinaCorridorSignalFamily,
  signals: readonly CorridorSourceSignal[],
  assessedAt: string,
): DecisionSignalProvenance | null {
  const usable = signals.filter((signal) => signal.availability !== 'unavailable');
  const observationSignal = latestTimedSignal(usable, 'observationTime');
  if (usable.length === 0 || observationSignal === null || observationSignal.observationTime === null) return null;
  const observationTime = observationSignal.observationTime;
  const observationPrecision = observationSignal.observationTimePrecision;
  if (observationPrecision === 'unknown') return null;
  const observationValue = timestampAtPrecision(observationTime, observationPrecision);
  const retrievalSignal = latestTimedSignal(usable, 'retrievalTime');
  const retrievalTime = retrievalSignal?.retrievalTime ?? assessedAt;
  const retrievalPrecision = retrievalSignal?.retrievalTimePrecision ?? 'instant';
  if (retrievalPrecision === 'unknown') return null;
  const retrievalValue = timestampAtPrecision(retrievalTime, retrievalPrecision);
  const inputSignalIds = usable.map((signal) => signal.id);
  const publisherIds = new Set(usable.map((signal) => signal.publisher.id));
  const transportState = worstState(
    usable.map((signal) => signal.transportFreshness),
    transportRank,
  );
  const contentState = worstState(
    usable.map((signal) => signal.contentFreshness),
    contentRank,
  );
  const signalId = `signal:corridor-condition:${corridorId}:${family}:${observationTime}`;
  const provenance: DecisionSignalProvenance = {
    contractVersion: DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION,
    signalId,
    familyId: 'composed_corridor_condition',
    claims: {
      publisher: {
        status: 'known',
        value: {
          id: 'publisher:worldmonitor-derived',
          name: 'WorldMonitor derived output',
          type: 'derived_output',
          registryReference: null,
        },
      },
      source_url: {
        status: 'not_applicable',
        reason: 'The corridor condition links source URLs through its input signals.',
      },
      original_reference: {
        status: 'not_applicable',
        reason: 'The corridor condition is composed from multiple source records.',
      },
      original_language: {
        status: 'not_applicable',
        reason: 'The deterministic composition has no original-language text.',
      },
      translation: {
        status: 'not_applicable',
        reason: 'The deterministic composition has no translated source text.',
      },
      observation_time: {
        status: 'known',
        value: { role: 'observation', value: observationValue, precision: observationPrecision },
      },
      effective_time: {
        status: 'known',
        value: { role: 'effective', value: observationValue, precision: observationPrecision },
      },
      publication_time: {
        status: 'not_applicable',
        reason: 'The computed condition is not a publisher release.',
      },
      retrieval_time: {
        status: 'known',
        value: { role: 'retrieval', value: retrievalValue, precision: retrievalPrecision },
      },
      revision: {
        status: 'known',
        value: {
          vintageId: `${corridorId}:${family}:${observationTime}`,
          sequence: 1,
          state: 'original',
        },
      },
      supersession: { status: 'known', value: { state: 'current' } },
      extraction_confidence: {
        status: 'not_applicable',
        reason: 'Each input signal owns its extraction confidence.',
      },
      classification_confidence: {
        status: 'known',
        value: {
          score: 1,
          method: 'exact-reviewed-selector/v1',
        },
      },
      corroboration: {
        status: 'known',
        value: {
          state: publisherIds.size > 1 ? 'multi_source' : 'single_source',
          sourceSignalIds: publisherIds.size > 1 ? inputSignalIds : inputSignalIds.slice(0, 1),
        },
      },
      transport_freshness: {
        status: 'known',
        value: {
          state: transportState,
          assessedAt,
          ...(transportState === 'fresh' || transportState === 'stale'
            ? { lastSuccessAt: retrievalTime }
            : {}),
        },
      },
      content_freshness: {
        status: 'known',
        value: {
          state: contentState,
          assessedAt,
          ...(contentState === 'timestamp_unknown' ? {} : { contentAsOf: observationValue }),
        },
      },
      derivation: {
        status: 'known',
        value: {
          methodId: 'worldmonitor:china-corridor-condition',
          methodVersion: '1',
          computedAt: assessedAt,
          inputSignalIds,
        },
      },
    },
  };
  return DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS.api.deserialize(
    DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS.api.serialize(provenance),
  );
}

function composeCondition(
  corridorId: ChinaLogisticsCorridorId,
  family: ChinaCorridorSignalFamily,
  source: CorridorFamilySource,
  assessedAt: string,
): ChinaCorridorCondition {
  const sourceSignals = source.signals.filter((signal) =>
    signal.family === family
    && (
      signal.corridorIds?.includes(corridorId)
      || findCorridorsForSourceSelector(family, signal.selectorId).includes(corridorId)
    ));
  if (sourceSignals.length === 0) {
    return {
      family,
      providerId: source.providerId,
      availability: 'unavailable',
      reason: source.reason ?? 'No reviewed source signal is available for this corridor.',
      sourceSignals: [],
      provenance: null,
    };
  }
  if (sourceSignals.every((signal) => signal.availability === 'unavailable')) {
    return {
      family,
      providerId: source.providerId,
      availability: 'unavailable',
      reason: source.reason ?? 'Provider unavailable',
      sourceSignals,
      provenance: null,
    };
  }

  const availability = deriveChinaCorridorConditionAvailability(sourceSignals);
  let provenance: DecisionSignalProvenance | null = null;
  let provenanceFailed = false;
  try {
    provenance = buildProvenance(corridorId, family, sourceSignals, assessedAt);
  } catch {
    provenanceFailed = true;
  }
  return {
    family,
    providerId: source.providerId,
    availability: provenance === null && availability !== 'unavailable' ? 'partial' : availability,
    reason: provenanceFailed
      ? 'Source provenance failed validation for this corridor condition.'
      : provenance === null
        ? 'Source observations lack the timestamps required for a composed provenance envelope.'
      : availability === 'available'
        ? null
        : source.reason ?? null,
    sourceSignals,
    provenance,
  };
}

export function composeChinaCorridorControlTowers(
  bundle: ChinaCorridorSourceBundle,
): ChinaCorridorControlTowerResponse {
  const corridors = CHINA_LOGISTICS_CORRIDORS.map((definition) => {
    const conditions = CHINA_CORRIDOR_SIGNAL_FAMILIES.map((family) =>
      composeCondition(definition.id, family, bundle.families[family], bundle.assessedAt));
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      boundary: definition.boundary,
      nodes: definition.nodes,
      availability: deriveChinaCorridorAvailability(conditions),
      conditions,
    };
  });
  return {
    generatedAt: bundle.assessedAt,
    corridors,
  };
}
