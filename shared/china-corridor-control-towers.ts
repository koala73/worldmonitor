import type {
  DecisionSignalContentFreshness,
  DecisionSignalProvenance,
  DecisionSignalProvenanceSurface,
  DecisionSignalTransportFreshness,
} from './decision-signal-provenance';
import {
  DECISION_SIGNAL_CONTENT_FRESHNESS_STATES,
  DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS,
  DECISION_SIGNAL_TRANSPORT_FRESHNESS_STATES,
} from './decision-signal-provenance';
import type {
  ChinaCorridorNode,
  ChinaCorridorPoint,
  ChinaCorridorSignalFamily,
  ChinaLogisticsCorridorId,
} from './china-logistics-corridors';
import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  CHINA_CORRIDOR_NODE_TYPES,
  CHINA_LOGISTICS_CORRIDORS,
  CHINA_LOGISTICS_CORRIDOR_IDS,
  findCorridorsForSourceSelector,
} from './china-logistics-corridors';

export const CHINA_CORRIDOR_AVAILABILITIES = [
  'available',
  'partial',
  'stale',
  'unavailable',
] as const;
export const CHINA_CORRIDOR_SIGNAL_AVAILABILITIES = [
  'available',
  'stale',
  'unavailable',
] as const;
export const CHINA_CORRIDOR_TIME_PRECISIONS = [
  'instant',
  'day',
  'month',
  'year',
  'unknown',
] as const;
export const CHINA_CORRIDOR_PUBLISHER_TYPES = [
  'official',
  'market',
  'independent',
  'derived',
  'unknown',
] as const;
export const CHINA_CORRIDOR_SOURCE_SCOPES = [
  'node',
  'regional',
  'national',
] as const;
export const CHINA_CORRIDOR_REVISION_STATES = [
  'original',
  'revised',
  'corrected',
] as const;

export type CorridorAvailability = (typeof CHINA_CORRIDOR_AVAILABILITIES)[number];
export type CorridorTimePrecision = (typeof CHINA_CORRIDOR_TIME_PRECISIONS)[number];

export interface CorridorSourceSignal {
  id: string;
  family: ChinaCorridorSignalFamily;
  selectorId: string;
  corridorIds?: ChinaLogisticsCorridorId[];
  availability: (typeof CHINA_CORRIDOR_SIGNAL_AVAILABILITIES)[number];
  publisher: {
    id: string;
    name: string;
    type: (typeof CHINA_CORRIDOR_PUBLISHER_TYPES)[number];
  };
  sourceUrl: string | null;
  sourceScope: (typeof CHINA_CORRIDOR_SOURCE_SCOPES)[number];
  observationTime: string | null;
  observationTimePrecision: CorridorTimePrecision;
  releaseTime: string | null;
  releaseTimePrecision: CorridorTimePrecision;
  retrievalTime: string | null;
  retrievalTimePrecision: CorridorTimePrecision;
  revision: {
    vintageId: string;
    sequence: number;
    state: (typeof CHINA_CORRIDOR_REVISION_STATES)[number];
  } | null;
  transportFreshness: DecisionSignalTransportFreshness['state'];
  contentFreshness: DecisionSignalContentFreshness['state'];
  summary: string;
  metrics: Record<string, string | number | boolean | null>;
}

/**
 * Metric keys the `power_energy` condition uses to publish China's observed
 * oil-product demand change (#6067).
 *
 * `metrics` is an untyped string-keyed map, so a rename on either side of the
 * producer/consumer seam would compile, pass both files' own unit tests, and
 * silently disable the `china_energy_demand_change` proxy in production with no
 * crash or alert. Naming the keys once removes that failure mode.
 */
export const CHINA_ENERGY_DEMAND_METRIC_KEYS = Object.freeze({
  /** Period end of the demand series, published whether or not a change exists. */
  periodEnd: 'demandPeriodEnd',
  percent: 'demandChangePercent',
  basis: 'demandChangeBasis',
  unit: 'demandChangeUnit',
  currentMonth: 'demandChangeCurrentMonth',
  priorMonth: 'demandChangePriorMonth',
  changePeriodEnd: 'demandChangePeriodEnd',
  changePriorPeriodEnd: 'demandChangePriorPeriodEnd',
  productCount: 'demandChangeProductCount',
  products: 'demandChangeProducts',
  currentDemandKbd: 'demandChangeCurrentDemandKbd',
  priorDemandKbd: 'demandChangePriorDemandKbd',
} as const);

export interface CorridorFamilySource {
  providerId: string;
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

export function deriveChinaCorridorConditionAvailability(
  signals: readonly CorridorSourceSignal[],
): CorridorAvailability {
  const available = signals.filter((signal) => signal.availability !== 'unavailable');
  if (available.length === 0) return 'unavailable';
  if (available.length !== signals.length) return 'partial';
  if (signals.some((signal) =>
    signal.transportFreshness === 'missing'
    || signal.transportFreshness === 'error'
    || signal.contentFreshness === 'partial'
    || signal.contentFreshness === 'unavailable'
    || signal.contentFreshness === 'timestamp_unknown')) {
    return 'partial';
  }
  if (signals.some((signal) =>
    signal.availability === 'stale'
    || signal.transportFreshness === 'stale'
    || signal.contentFreshness === 'stale')) {
    return 'stale';
  }
  return 'available';
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error('Invalid China corridor control-tower response');
  }

  if (!isChinaCorridorResponse(parsed)) {
    throw new Error('Invalid China corridor control-tower response');
  }
  return validateChinaCorridorProvenanceForSurface(
    parsed,
    'ui',
  );
}

type UnknownRecord = Record<string, unknown>;

const CORRIDOR_AVAILABILITIES = new Set<CorridorAvailability>([
  ...CHINA_CORRIDOR_AVAILABILITIES,
]);
const SIGNAL_AVAILABILITIES = new Set<CorridorSourceSignal['availability']>([
  ...CHINA_CORRIDOR_SIGNAL_AVAILABILITIES,
]);
const TIME_PRECISIONS = new Set<CorridorTimePrecision>([
  ...CHINA_CORRIDOR_TIME_PRECISIONS,
]);
const TRANSPORT_FRESHNESS = new Set<CorridorSourceSignal['transportFreshness']>([
  ...DECISION_SIGNAL_TRANSPORT_FRESHNESS_STATES,
]);
const CONTENT_FRESHNESS = new Set<CorridorSourceSignal['contentFreshness']>([
  ...DECISION_SIGNAL_CONTENT_FRESHNESS_STATES,
]);
const CORRIDOR_IDS = new Set<ChinaLogisticsCorridorId>(CHINA_LOGISTICS_CORRIDOR_IDS);
const SIGNAL_FAMILIES = new Set<ChinaCorridorSignalFamily>(CHINA_CORRIDOR_SIGNAL_FAMILIES);
const NODE_TYPES = new Set<ChinaCorridorNode['type']>([
  ...CHINA_CORRIDOR_NODE_TYPES,
]);
const REVISION_STATES = new Set<NonNullable<CorridorSourceSignal['revision']>['state']>([
  ...CHINA_CORRIDOR_REVISION_STATES,
]);
const PUBLISHER_TYPES = new Set<CorridorSourceSignal['publisher']['type']>([
  ...CHINA_CORRIDOR_PUBLISHER_TYPES,
]);
const SOURCE_SCOPES = new Set<CorridorSourceSignal['sourceScope']>([
  ...CHINA_CORRIDOR_SOURCE_SCOPES,
]);

function memberOf<Value extends string>(
  values: ReadonlySet<Value>,
  value: unknown,
): value is Value {
  return typeof value === 'string' && values.has(value as Value);
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function finitePoint(value: unknown): boolean {
  const item = record(value);
  return item !== null
    && typeof item.lat === 'number'
    && Number.isFinite(item.lat)
    && typeof item.lon === 'number'
    && Number.isFinite(item.lon);
}

function validNode(value: unknown): boolean {
  const item = record(value);
  if (
    item === null
    || !finitePoint(item)
    || typeof item.id !== 'string'
    || typeof item.name !== 'string'
    || typeof item.sourceOwner !== 'string'
    || !memberOf(NODE_TYPES, item.type)
  ) {
    return false;
  }
  if (item.sourceSelector === undefined) return true;
  const selector = record(item.sourceSelector);
  return selector !== null
    && memberOf(SIGNAL_FAMILIES, selector.family)
    && typeof selector.id === 'string';
}

function validRevision(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  return item !== null
    && typeof item.vintageId === 'string'
    && typeof item.sequence === 'number'
    && Number.isFinite(item.sequence)
    && memberOf(REVISION_STATES, item.state);
}

function validMetrics(value: unknown): boolean {
  const item = record(value);
  return item !== null && Object.values(item).every((metric) =>
    metric === null
    || typeof metric === 'string'
    || typeof metric === 'boolean'
    || (typeof metric === 'number' && Number.isFinite(metric)));
}

function validSourceSignal(value: unknown): value is CorridorSourceSignal {
  const item = record(value);
  const publisher = record(item?.publisher);
  const corridorIds = item?.corridorIds;
  return item !== null
    && typeof item.id === 'string'
    && memberOf(SIGNAL_FAMILIES, item.family)
    && typeof item.selectorId === 'string'
    && (
      corridorIds === undefined
      || (
        Array.isArray(corridorIds)
        && corridorIds.every((id) => memberOf(CORRIDOR_IDS, id))
      )
    )
    && memberOf(SIGNAL_AVAILABILITIES, item.availability)
    && publisher !== null
    && typeof publisher.id === 'string'
    && typeof publisher.name === 'string'
    && memberOf(PUBLISHER_TYPES, publisher.type)
    && nullableString(item.sourceUrl)
    && memberOf(SOURCE_SCOPES, item.sourceScope)
    && nullableString(item.observationTime)
    && memberOf(TIME_PRECISIONS, item.observationTimePrecision)
    && nullableString(item.releaseTime)
    && memberOf(TIME_PRECISIONS, item.releaseTimePrecision)
    && nullableString(item.retrievalTime)
    && memberOf(TIME_PRECISIONS, item.retrievalTimePrecision)
    && validRevision(item.revision)
    && memberOf(TRANSPORT_FRESHNESS, item.transportFreshness)
    && memberOf(CONTENT_FRESHNESS, item.contentFreshness)
    && typeof item.summary === 'string'
    && validMetrics(item.metrics);
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.every((value) => typeof value === 'string')
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function provenanceBindingMatches(
  value: unknown,
  corridorId: ChinaLogisticsCorridorId,
  family: ChinaCorridorSignalFamily,
  signals: readonly CorridorSourceSignal[],
): boolean {
  if (value === null) return true;
  const provenance = record(value);
  if (provenance === null) return true;
  if (
    typeof provenance.signalId === 'string'
    && !provenance.signalId.startsWith(
      `signal:corridor-condition:${corridorId}:${family}:`,
    )
  ) {
    return false;
  }
  const claims = record(provenance.claims);
  if (claims === null) return true;
  const usableSignals = signals.filter((signal) => signal.availability !== 'unavailable');
  const expectedInputIds = usableSignals.map((signal) => signal.id);
  const expectedInputIdSet = new Set(expectedInputIds);
  const expectedPublisherIds = new Set(usableSignals.map((signal) => signal.publisher.id));
  const corroboration = record(claims.corroboration);
  if (corroboration?.status === 'known') {
    const corroborationValue = record(corroboration.value);
    const sourceSignalIds = corroborationValue?.sourceSignalIds;
    const expectedState = expectedPublisherIds.size > 1
      ? 'multi_source'
      : 'single_source';
    if (
      corroborationValue?.state !== expectedState
      || !Array.isArray(sourceSignalIds)
      || sourceSignalIds.length === 0
      || !sourceSignalIds.every((id) =>
        typeof id === 'string' && expectedInputIdSet.has(id))
      || (
        expectedPublisherIds.size > 1
          ? !sameStringSet(sourceSignalIds, expectedInputIds)
          : sourceSignalIds.length !== 1
      )
    ) {
      return false;
    }
  }
  const derivation = record(claims.derivation);
  if (
    derivation?.status === 'known'
    && !sameStringSet(
      record(derivation.value)?.inputSignalIds,
      expectedInputIds,
    )
  ) {
    return false;
  }
  return true;
}

function signalBelongsToCorridor(
  signal: CorridorSourceSignal,
  corridorId: ChinaLogisticsCorridorId,
  family: ChinaCorridorSignalFamily,
): boolean {
  if (signal.corridorIds !== undefined) {
    return signal.corridorIds.includes(corridorId);
  }
  return findCorridorsForSourceSelector(family, signal.selectorId)
    .includes(corridorId);
}

function validCondition(
  value: unknown,
  corridorId: ChinaLogisticsCorridorId,
): boolean {
  const item = record(value);
  if (
    item === null
    || !memberOf(SIGNAL_FAMILIES, item.family)
    || typeof item.providerId !== 'string'
    || !memberOf(CORRIDOR_AVAILABILITIES, item.availability)
    || !nullableString(item.reason)
    || !Array.isArray(item.sourceSignals)
    || (item.provenance !== null && record(item.provenance) === null)
  ) {
    return false;
  }
  const family = item.family as ChinaCorridorSignalFamily;
  if (!item.sourceSignals.every((signal) =>
    validSourceSignal(signal)
    && signal.family === family
    && signalBelongsToCorridor(signal, corridorId, family))) {
    return false;
  }
  const sourceSignals = item.sourceSignals as CorridorSourceSignal[];
  if (!provenanceBindingMatches(
    item.provenance,
    corridorId,
    family,
    sourceSignals,
  )) {
    return false;
  }
  const derivedAvailability =
    deriveChinaCorridorConditionAvailability(sourceSignals);
  if (derivedAvailability === 'unavailable') {
    return item.availability === 'unavailable' && item.provenance === null;
  }
  const expectedAvailability =
    item.provenance === null
      ? 'partial'
      : derivedAvailability;
  return item.availability === expectedAvailability;
}

function matchesCanonicalCorridor(
  item: UnknownRecord & { id: ChinaLogisticsCorridorId },
): boolean {
  const definition = CHINA_LOGISTICS_CORRIDORS.find((corridor) =>
    corridor.id === item.id);
  if (
    definition === undefined
    || item.name !== definition.name
    || !Array.isArray(item.boundary)
    || item.boundary.length !== definition.boundary.length
    || !item.boundary.every((point, index) => {
      const actual = record(point);
      const expected = definition.boundary[index];
      return expected !== undefined
        && actual?.lat === expected.lat
        && actual.lon === expected.lon;
    })
    || !Array.isArray(item.nodes)
    || item.nodes.length === 0
  ) {
    return false;
  }
  const nodeIds = new Set<string>();
  return item.nodes.every((node) => {
    const actual = record(node);
    if (typeof actual?.id !== 'string' || nodeIds.has(actual.id)) return false;
    nodeIds.add(actual.id);
    const expected = definition.nodes.find((candidate) =>
      candidate.id === actual.id);
    if (expected === undefined) return false;
    return actual?.name === expected.name
      && actual.type === expected.type
      && actual.lat === expected.lat
      && actual.lon === expected.lon
      && actual.sourceOwner === expected.sourceOwner
      && (
        expected.sourceSelector === undefined
          ? actual.sourceSelector === undefined
          : record(actual.sourceSelector)?.family === expected.sourceSelector.family
            && record(actual.sourceSelector)?.id === expected.sourceSelector.id
      );
  });
}

function validCorridor(value: unknown): value is ChinaCorridorControlTower {
  const item = record(value);
  if (
    item === null
    || !memberOf(CORRIDOR_IDS, item.id)
    || typeof item.name !== 'string'
    || typeof item.description !== 'string'
    || !memberOf(CORRIDOR_AVAILABILITIES, item.availability)
    || !Array.isArray(item.boundary)
    || item.boundary.length < 4
    || !item.boundary.every(finitePoint)
    || !Array.isArray(item.nodes)
    || !item.nodes.every(validNode)
    || !Array.isArray(item.conditions)
    || item.conditions.length !== CHINA_CORRIDOR_SIGNAL_FAMILIES.length
  ) {
    return false;
  }
  if (
    !matchesCanonicalCorridor(
      item as UnknownRecord & { id: ChinaLogisticsCorridorId },
    )
    || !item.conditions.every((condition) => validCondition(
      condition,
      item.id as ChinaLogisticsCorridorId,
    ))
  ) {
    return false;
  }
  const families = new Set(item.conditions.map((condition) =>
    (condition as { family: unknown }).family));
  return families.size === CHINA_CORRIDOR_SIGNAL_FAMILIES.length
    && CHINA_CORRIDOR_SIGNAL_FAMILIES.every((family) => families.has(family));
}

function isChinaCorridorResponse(
  value: unknown,
): value is ChinaCorridorControlTowerResponse {
  const item = record(value);
  if (
    item === null
    || typeof item.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(item.generatedAt))
    || !Array.isArray(item.corridors)
    || item.corridors.length !== CHINA_LOGISTICS_CORRIDOR_IDS.length
    || !item.corridors.every(validCorridor)
  ) {
    return false;
  }
  const ids = new Set(item.corridors.map((corridor) => corridor.id));
  return ids.size === CHINA_LOGISTICS_CORRIDOR_IDS.length
    && CHINA_LOGISTICS_CORRIDOR_IDS.every((id) => ids.has(id));
}
