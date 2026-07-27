import {
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
  DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS,
  type DecisionSignalProvenance,
  type DecisionSignalPublisherType,
} from './decision-signal-provenance';
import {
  CHINA_DECISION_SIGNAL_GROUP_IDS,
  CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP,
  type ChinaDecisionSignalGroupId,
} from './china-decision-signal-manifest';

export {
  CHINA_DECISION_SIGNAL_GROUP_IDS,
  CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP,
} from './china-decision-signal-manifest';
export type { ChinaDecisionSignalGroupId } from './china-decision-signal-manifest';

export const CHINA_DECISION_SIGNAL_SCHEMA_VERSION = 1 as const;
export const CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES = 65_536;

export type ChinaDecisionSignalState =
  | 'available'
  | 'partial'
  | 'stale'
  | 'unavailable';

export interface ChinaDecisionSignalItem {
  id: string;
  lineageId: string;
  label: string;
  summary: string;
  sourceName: string;
  sourceUrl: string | null;
  publisherType: DecisionSignalPublisherType;
  observedAt: string | null;
  publishedAt: string | null;
  effectiveAt: string | null;
  retrievedAt: string | null;
  stale: boolean;
  metadata: Record<string, unknown>;
  provenance: DecisionSignalProvenance;
}

export interface ChinaDecisionSignalGroup {
  id: ChinaDecisionSignalGroupId;
  state: ChinaDecisionSignalState;
  reason: string | null;
  items: ChinaDecisionSignalItem[];
  metadata: Record<string, unknown>;
}

export interface ChinaDecisionSignalSnapshot {
  schemaVersion: typeof CHINA_DECISION_SIGNAL_SCHEMA_VERSION;
  generatedAt: string;
  groups: ChinaDecisionSignalGroup[];
  access: {
    anonymous: 'bounded_public_summary';
    pro: 'same_provenance_via_mcp';
    operator: 'source_health_only';
  };
}

export interface ComposeChinaDecisionSignalsInput {
  generatedAt: string;
  macro?: unknown;
  policy?: unknown;
  crossStrait?: unknown;
  corporate?: unknown;
  corridors?: unknown;
  nowcast?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is UnknownRecord => item !== null)
    : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function parseRecord(value: unknown): UnknownRecord | null {
  const parsedRecord = record(value);
  if (parsedRecord !== null) return parsedRecord;
  if (typeof value !== 'string') return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function knownClaimValue(
  provenance: DecisionSignalProvenance,
  dimension: keyof DecisionSignalProvenance['claims'],
): unknown {
  const claim = provenance.claims[dimension];
  return claim.status === 'known' ? claim.value : null;
}

function claimTime(
  provenance: DecisionSignalProvenance,
  dimension: 'observation_time' | 'publication_time' | 'effective_time' | 'retrieval_time',
): string | null {
  const value = record(knownClaimValue(provenance, dimension));
  return text(value?.value);
}

function canonicalProvenance(value: unknown): DecisionSignalProvenance | null {
  const parsed = parseRecord(value);
  if (parsed === null) return null;
  try {
    const provenance = DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS.api.deserialize(parsed);
    return DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS[provenance.familyId]?.launchStatus
      === 'launched'
      ? provenance
      : null;
  } catch {
    return null;
  }
}

function provenanceIsStale(provenance: DecisionSignalProvenance): boolean {
  const transport = record(knownClaimValue(provenance, 'transport_freshness'));
  const content = record(knownClaimValue(provenance, 'content_freshness'));
  return transport?.state === 'stale'
    || transport?.state === 'missing'
    || transport?.state === 'error'
    || content?.state === 'stale'
    || content?.state === 'unavailable'
    || content?.state === 'partial'
    || content?.state === 'timestamp_unknown';
}

function itemFromProvenance(input: {
  provenance: unknown;
  lineageId?: unknown;
  label: unknown;
  summary: unknown;
  metadata?: Record<string, unknown>;
}): ChinaDecisionSignalItem | null {
  const provenance = canonicalProvenance(input.provenance);
  if (provenance === null) return null;
  const publisher = record(knownClaimValue(provenance, 'publisher'));
  const sourceUrl = knownClaimValue(provenance, 'source_url');
  const revision = record(knownClaimValue(provenance, 'revision'));
  const lineageId = text(input.lineageId)
    ?? text(record(knownClaimValue(provenance, 'original_reference'))?.id)
    ?? provenance.signalId;
  return {
    id: provenance.signalId,
    lineageId,
    label: text(input.label) ?? provenance.signalId,
    summary: text(input.summary) ?? 'No normalized summary is available.',
    sourceName: text(publisher?.name) ?? 'Unknown publisher',
    sourceUrl: text(sourceUrl),
    publisherType: (
      text(publisher?.type) ?? 'unknown'
    ) as DecisionSignalPublisherType,
    observedAt: claimTime(provenance, 'observation_time'),
    publishedAt: claimTime(provenance, 'publication_time'),
    effectiveAt: claimTime(provenance, 'effective_time'),
    retrievedAt: claimTime(provenance, 'retrieval_time'),
    stale: provenanceIsStale(provenance),
    metadata: {
      ...input.metadata,
      revision: revision ?? null,
      supersession: knownClaimValue(provenance, 'supersession'),
      translation: knownClaimValue(provenance, 'translation'),
      extractionConfidence: knownClaimValue(provenance, 'extraction_confidence'),
      classificationConfidence: knownClaimValue(provenance, 'classification_confidence'),
      corroboration: knownClaimValue(provenance, 'corroboration'),
    },
    provenance,
  };
}

function stateFor(
  items: ChinaDecisionSignalItem[],
  upstreamState: string | null,
  rejected: number,
): ChinaDecisionSignalState {
  if (items.length === 0) return 'unavailable';
  if (items.every((item) => item.stale)) return 'stale';
  if (
    rejected > 0
    || items.some((item) => item.stale)
    || ['degraded', 'backfilling', 'cached', 'partial', 'low'].includes(upstreamState ?? '')
  ) return 'partial';
  return 'available';
}

/**
 * Recompute state after the bounded-publication trimmer drops an item.
 * Mirrors stateFor's staleness checks so a group whose remaining items are
 * all stale keeps reporting 'stale' rather than being relabeled 'partial'
 * purely because wire-size trimming touched it. Trimming can never make a
 * group look healthier than it is, so 'available' is never returned here.
 */
function recomputeStateAfterTrim(
  items: ChinaDecisionSignalItem[],
): ChinaDecisionSignalState {
  if (items.length === 0) return 'unavailable';
  if (items.every((item) => item.stale)) return 'stale';
  return 'partial';
}

function group(
  id: ChinaDecisionSignalGroupId,
  candidates: Array<ChinaDecisionSignalItem | null>,
  upstreamState: string | null,
  metadata: Record<string, unknown> = {},
): ChinaDecisionSignalGroup {
  const items = candidates.filter((item): item is ChinaDecisionSignalItem => item !== null);
  const rejected = candidates.length - items.length;
  const state = stateFor(items, upstreamState, rejected);
  const omittedItemCount = Math.max(
    0,
    items.length - CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP,
  );
  return {
    id,
    state,
    reason: state === 'unavailable'
      ? 'No launched, provenance-valid signal is currently available.'
      : rejected > 0
        ? `${rejected} signal${rejected === 1 ? '' : 's'} failed the launch/provenance boundary.`
        : null,
    items: items.slice(0, CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP),
    metadata: {
      ...metadata,
      totalValidItems: items.length,
      omittedItemCount,
    },
  };
}

const UTF8_ENCODER = new TextEncoder();

function serializedByteLength(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0
    ? value as number
    : fallback;
}

function compactGroupMetadata(
  group: ChinaDecisionSignalGroup,
): Record<string, unknown> {
  const serializationOmittedItemCount = nonNegativeInteger(
    group.metadata.serializationOmittedItemCount,
    0,
  );
  return {
    totalValidItems: nonNegativeInteger(
      group.metadata.totalValidItems,
      group.items.length,
    ),
    omittedItemCount: nonNegativeInteger(
      group.metadata.omittedItemCount,
      0,
    ),
    ...(serializationOmittedItemCount > 0
      ? { serializationOmittedItemCount }
      : {}),
    metadataOmittedForSerialization: true,
  };
}

function isCompactGroupMetadata(metadata: Record<string, unknown>): boolean {
  return metadata.metadataOmittedForSerialization === true
    && Object.keys(metadata).every((key) => [
      'totalValidItems',
      'omittedItemCount',
      'serializationOmittedItemCount',
      'metadataOmittedForSerialization',
    ].includes(key));
}

/**
 * Preserve whole provenance records and omit only complete supplemental
 * metadata objects or complete signal items when the canonical public shape
 * would exceed the MCP/publication byte contract.
 */
function boundChinaDecisionSignalSnapshot(
  snapshot: ChinaDecisionSignalSnapshot,
): ChinaDecisionSignalSnapshot {
  const originalReasons = new Map(
    snapshot.groups.map((candidate) => [candidate.id, candidate.reason]),
  );
  const serializationOmittedCounts = new Map<ChinaDecisionSignalGroupId, number>();

  while (serializedByteLength(snapshot) > CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES) {
    let metadataCandidate: {
      group: ChinaDecisionSignalGroup;
      compact: Record<string, unknown>;
      savings: number;
    } | null = null;

    for (const candidate of snapshot.groups) {
      if (isCompactGroupMetadata(candidate.metadata)) continue;
      const compact = compactGroupMetadata(candidate);
      const savings = serializedByteLength(candidate.metadata)
        - serializedByteLength(compact);
      if (savings > 0 && (metadataCandidate === null || savings > metadataCandidate.savings)) {
        metadataCandidate = { group: candidate, compact, savings };
      }
    }

    if (metadataCandidate !== null) {
      metadataCandidate.group.metadata = metadataCandidate.compact;
      metadataCandidate.group.state = recomputeStateAfterTrim(metadataCandidate.group.items);
      metadataCandidate.group.reason = [
        originalReasons.get(metadataCandidate.group.id),
        'Supplemental group metadata omitted to satisfy the bounded publication contract.',
      ].filter((reason): reason is string => reason !== null).join(' ');
      continue;
    }

    let itemCandidate: {
      group: ChinaDecisionSignalGroup;
      index: number;
      bytes: number;
    } | null = null;
    for (const candidate of snapshot.groups) {
      for (const [index, item] of candidate.items.entries()) {
        const bytes = serializedByteLength(item);
        if (itemCandidate === null || bytes > itemCandidate.bytes) {
          itemCandidate = { group: candidate, index, bytes };
        }
      }
    }

    if (itemCandidate === null) {
      throw new RangeError(
        'China decision-signal snapshot cannot fit the bounded publication contract.',
      );
    }

    itemCandidate.group.items.splice(itemCandidate.index, 1);
    const omittedCount = (serializationOmittedCounts.get(itemCandidate.group.id) ?? 0) + 1;
    serializationOmittedCounts.set(itemCandidate.group.id, omittedCount);
    itemCandidate.group.metadata = {
      ...itemCandidate.group.metadata,
      omittedItemCount: nonNegativeInteger(
        itemCandidate.group.metadata.omittedItemCount,
        0,
      ) + 1,
      serializationOmittedItemCount: omittedCount,
    };
    itemCandidate.group.state = recomputeStateAfterTrim(itemCandidate.group.items);
    itemCandidate.group.reason = [
      originalReasons.get(itemCandidate.group.id),
      itemCandidate.group.metadata.metadataOmittedForSerialization === true
        ? 'Supplemental group metadata omitted to satisfy the bounded publication contract.'
        : null,
      `${omittedCount} provenance-valid signal${omittedCount === 1 ? '' : 's'} omitted to satisfy the bounded publication contract.`,
    ].filter((reason): reason is string => reason !== null).join(' ');
  }

  return snapshot;
}

function baselineBand(value: UnknownRecord): string {
  if (text(value.state) !== 'sufficient') return 'insufficient_data';
  const ratio = finite(value.ratio);
  if (ratio === null) return 'unavailable';
  if (ratio >= 1.5) return 'elevated';
  if (ratio <= 0.5) return 'below_baseline';
  return 'typical';
}

function distillBaselineBands(crossStrait: UnknownRecord | null): UnknownRecord[] {
  const categories = record(record(crossStrait?.baselines)?.categories) ?? {};
  return Object.entries(categories).flatMap(([category, candidate]) => {
    const windows = record(record(candidate)?.windows);
    return [30, 90].flatMap((windowDays) => {
      const window = record(windows?.[windowDays]) ?? record(windows?.[String(windowDays)]);
      if (window === null) return [];
      return [{
        category,
        windowDays,
        state: text(window.state) ?? 'insufficient_data',
        band: baselineBand(window),
        difference: finite(window.difference),
        ratio: finite(window.ratio),
      }];
    });
  });
}

function summarizeValues(value: unknown): string {
  const source = record(value);
  if (source === null) return 'Reviewed activity record';
  const parts = Object.entries(source)
    .filter(([, candidate]) => finite(candidate) !== null)
    .slice(0, 4)
    .map(([key, candidate]) => `${key}: ${String(candidate)}`);
  return parts.length > 0 ? parts.join(' · ') : 'Reviewed activity record';
}

function buildDerivedNowcastProvenance(
  nowcast: UnknownRecord,
  generatedAt: string,
): DecisionSignalProvenance | null {
  const state = text(nowcast.state);
  const methodVersion = text(nowcast.methodVersion);
  const window = record(nowcast.comparisonWindow);
  const observedAt = text(window?.endsAt) ?? text(nowcast.evaluatedAt) ?? generatedAt;
  if (!state || state === 'insufficient_data' || !methodVersion) return null;
  const official = record(nowcast.official);
  const contributions = records(nowcast.contributions).filter((candidate) => bool(candidate.included));
  const inputSignalIds = [
    text(record(parseRecord(official?.provenance))?.signalId),
    ...contributions.map((candidate) =>
      text(record(parseRecord(candidate.provenance))?.signalId)
        ?? text(candidate.observationId)),
  ].filter((value): value is string => value !== null);
  if (inputSignalIds.length === 0) return null;
  const score = record(nowcast.confidence)?.level === 'high'
    ? 0.9
    : record(nowcast.confidence)?.level === 'medium'
      ? 0.75
      : 0.55;
  return canonicalProvenance({
    contractVersion: 'decision-signal-provenance/v1',
    signalId: `china-activity-nowcast:${methodVersion}:${observedAt}`,
    familyId: 'derived_comparison',
    claims: {
      publisher: {
        status: 'known',
        value: {
          id: 'worldmonitor-china-activity-nowcast',
          name: 'WorldMonitor China Activity Nowcast',
          type: 'derived_output',
          registryReference: null,
        },
      },
      source_url: { status: 'not_applicable', reason: 'Derived output has no source URL.' },
      original_reference: { status: 'not_applicable', reason: 'Derived output has no original document.' },
      original_language: { status: 'not_applicable', reason: 'Derived output is language independent.' },
      translation: { status: 'not_applicable', reason: 'Derived output is not translated source text.' },
      observation_time: {
        status: 'known',
        value: { role: 'observation', value: observedAt, precision: 'instant' },
      },
      effective_time: {
        status: 'known',
        value: { role: 'effective', value: observedAt, precision: 'instant' },
      },
      publication_time: { status: 'not_applicable', reason: 'Derived output is computed, not published.' },
      retrieval_time: {
        status: 'known',
        value: { role: 'retrieval', value: generatedAt, precision: 'instant' },
      },
      revision: {
        status: 'known',
        value: {
          vintageId: `${methodVersion}:${observedAt}`,
          sequence: 1,
          state: 'original',
        },
      },
      supersession: {
        status: 'known',
        value: { state: 'current' },
      },
      extraction_confidence: {
        status: 'not_applicable',
        reason: 'The comparison is deterministic and does not extract source text.',
      },
      classification_confidence: {
        status: 'known',
        value: { score, method: `${methodVersion}:confidence-level` },
      },
      corroboration: {
        status: 'known',
        value: {
          state: inputSignalIds.length > 1 ? 'multi_source' : 'single_source',
          sourceSignalIds: inputSignalIds,
        },
      },
      transport_freshness: {
        status: 'known',
        value: { state: 'fresh', assessedAt: generatedAt, lastSuccessAt: generatedAt },
      },
      content_freshness: {
        status: 'known',
        value: { state: 'current', assessedAt: generatedAt, contentAsOf: observedAt },
      },
      derivation: {
        status: 'known',
        value: {
          methodId: 'china-activity-nowcast',
          methodVersion,
          computedAt: generatedAt,
          inputSignalIds,
        },
      },
    },
  });
}

export function composeChinaDecisionSignals(
  input: ComposeChinaDecisionSignalsInput,
): ChinaDecisionSignalSnapshot {
  const macro = record(input.macro);
  const policy = record(input.policy);
  const crossStrait = record(input.crossStrait);
  const corporate = record(input.corporate);
  const corridors = record(input.corridors);
  const nowcast = record(input.nowcast);

  const macroIndicators = records(macro?.indicators);
  const policyEvents = records(policy?.events)
    .filter((event) => record(event.supersession)?.state === 'current');
  const crossStraitObservations = records(crossStrait?.observations);
  const corporateEvents = records(corporate?.events)
    .filter((event) => ['current', 'corrected'].includes(text(event.status) ?? ''));
  const corridorConditions = records(corridors?.corridors)
    .flatMap((corridor) => records(corridor.conditions).map((condition) => ({
      corridor,
      condition,
    })));

  const macroGroup = group(
    'macro',
    macroIndicators.map((indicator) => itemFromProvenance({
      provenance: indicator.provenanceJson ?? indicator.provenance,
      label: indicator.label,
      summary: finite(indicator.value) === null
        ? 'Published without a finite normalized value.'
        : `${String(indicator.value)}${text(indicator.unit) ? ` ${text(indicator.unit)}` : ''}`,
      metadata: {
        category: text(indicator.category),
        direction: text(indicator.direction),
        vintageId: text(indicator.vintageId),
      },
    })),
    bool(macro?.unavailable) ? 'unavailable' : null,
  );

  const policyGroup = group(
    'policy-enforcement',
    policyEvents.map((event) => itemFromProvenance({
      provenance: event.provenance,
      lineageId: event.lineageId,
      label: event.titleTranslated ?? event.titleOriginal,
      summary: [text(event.agency), text(event.actionType), text(event.status)]
        .filter(Boolean)
        .join(' · '),
      metadata: {
        actionType: text(event.actionType),
        status: text(event.status),
        sectors: records(event.sectors).map((sector) => text(sector.label) ?? text(sector.id)).filter(Boolean),
        entities: records(event.entities).map((entity) => text(entity.name) ?? text(entity.id)).filter(Boolean),
      },
    })),
    Object.values(record(policy?.agencies) ?? {}).some((agency) => record(agency)?.status !== 'ok')
      ? 'degraded'
      : null,
  );

  const crossStraitGroup = group(
    'cross-strait-activity',
    crossStraitObservations.map((observation) => itemFromProvenance({
      provenance: observation.provenance,
      label: observation.summary ?? `${text(observation.sourceId) ?? 'Official'} activity`,
      summary: summarizeValues(observation.categories),
      metadata: {
        sourceId: text(observation.sourceId),
        observationKind: text(observation.observationKind),
        reportingDay: text(observation.reportingDay),
      },
    })),
    text(crossStrait?.status),
    {
      baselineSemantics: text(record(crossStrait?.baselines)?.semantics),
      baselineBands: distillBaselineBands(crossStrait),
      coverage: record(crossStrait?.coverage),
    },
  );

  const corporateGroup = group(
    'corporate-disclosures',
    corporateEvents.map((event) => {
      const issuer = record(event.issuer);
      return itemFromProvenance({
        provenance: event.provenance,
        lineageId: event.announcementId,
        label: event.titleOriginal,
        summary: [
          text(event.exchange),
          text(issuer?.symbol),
          text(event.disclosureType),
          text(event.status),
        ].filter(Boolean).join(' · '),
        metadata: {
          exchange: text(event.exchange),
          disclosureType: text(event.disclosureType),
          status: text(event.status),
          issuer: issuer,
        },
      });
    }),
    text(corporate?.status),
  );

  const corridorGroup = group(
    'corridor-conditions',
    corridorConditions.map(({ corridor, condition }) => itemFromProvenance({
      provenance: condition.provenance,
      label: `${text(corridor.name) ?? text(corridor.id) ?? 'China corridor'} · ${text(condition.family) ?? 'condition'}`,
      summary: text(condition.summary) ?? text(condition.availability) ?? 'Condition unavailable',
      metadata: {
        corridorId: text(corridor.id),
        family: text(condition.family),
        availability: text(condition.availability),
      },
    })),
    records(corridors?.corridors).every((corridor) => corridor.availability === 'unavailable')
      ? 'unavailable'
      : null,
  );

  const nowcastProvenance = nowcast === null
    ? null
    : buildDerivedNowcastProvenance(nowcast, input.generatedAt);
  const nowcastGroup = group(
    'activity-nowcast',
    [itemFromProvenance({
      provenance: nowcastProvenance,
      label: 'Official activity versus independent proxies',
      summary: nowcast === null
        ? 'Nowcast unavailable'
        : `${text(nowcast.state) ?? 'unknown'} · ${text(record(nowcast.confidence)?.level) ?? 'unknown'} confidence`,
      metadata: {
        comparisonState: text(nowcast?.state),
        confidence: record(nowcast?.confidence),
        missingInputs: records(nowcast?.missingInputs),
        sensitivity: records(nowcast?.sensitivity),
        limitations: Array.isArray(nowcast?.limitations) ? nowcast.limitations : [],
      },
    })],
    text(record(nowcast?.confidence)?.level),
    {
      methodVersion: text(nowcast?.methodVersion),
      comparisonWindow: record(nowcast?.comparisonWindow),
      deterministic: record(nowcast?.audit)?.deterministic === true,
      llmNumericComputation: record(nowcast?.audit)?.llmNumericComputation === true,
    },
  );

  return boundChinaDecisionSignalSnapshot({
    schemaVersion: CHINA_DECISION_SIGNAL_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    groups: [
      macroGroup,
      policyGroup,
      crossStraitGroup,
      corporateGroup,
      corridorGroup,
      nowcastGroup,
    ],
    access: {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    },
  });
}

export function isChinaDecisionSignalSnapshot(
  value: unknown,
): value is ChinaDecisionSignalSnapshot {
  const snapshot = record(value);
  const access = record(snapshot?.access);
  if (
    snapshot?.schemaVersion !== CHINA_DECISION_SIGNAL_SCHEMA_VERSION
    || text(snapshot.generatedAt) === null
    || !Array.isArray(snapshot.groups)
    || access?.anonymous !== 'bounded_public_summary'
    || access?.pro !== 'same_provenance_via_mcp'
    || access?.operator !== 'source_health_only'
  ) return false;
  try {
    if (serializedByteLength(snapshot) > CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES) {
      return false;
    }
  } catch {
    return false;
  }
  const groups = records(snapshot.groups);
  return groups.length === CHINA_DECISION_SIGNAL_GROUP_IDS.length
    && groups.every((candidate, index) => {
      const state = text(candidate.state);
      const items = records(candidate.items);
      if (
        candidate.id !== CHINA_DECISION_SIGNAL_GROUP_IDS[index]
        || !['available', 'partial', 'stale', 'unavailable'].includes(state ?? '')
        || (candidate.reason !== null && text(candidate.reason) === null)
        || !Array.isArray(candidate.items)
        || candidate.items.length !== items.length
        || items.length > CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP
        || record(candidate.metadata) === null
        || (state === 'unavailable') !== (items.length === 0)
      ) return false;
      return items.every((item) => {
        const provenance = canonicalProvenance(item.provenance);
        if (provenance === null) return false;
        const publisher = record(knownClaimValue(provenance, 'publisher'));
        return text(item.id) === provenance.signalId
          && text(item.lineageId) !== null
          && text(item.label) !== null
          && text(item.summary) !== null
          && text(item.sourceName) === text(publisher?.name)
          && (item.sourceUrl === null || text(item.sourceUrl) !== null)
          && text(item.sourceUrl) === text(knownClaimValue(provenance, 'source_url'))
          && text(item.publisherType) === text(publisher?.type)
          && (item.observedAt === null || text(item.observedAt) !== null)
          && text(item.observedAt) === claimTime(provenance, 'observation_time')
          && (item.publishedAt === null || text(item.publishedAt) !== null)
          && text(item.publishedAt) === claimTime(provenance, 'publication_time')
          && (item.effectiveAt === null || text(item.effectiveAt) !== null)
          && text(item.effectiveAt) === claimTime(provenance, 'effective_time')
          && (item.retrievedAt === null || text(item.retrievedAt) !== null)
          && text(item.retrievedAt) === claimTime(provenance, 'retrieval_time')
          && typeof item.stale === 'boolean'
          && item.stale === provenanceIsStale(provenance)
          && record(item.metadata) !== null;
      });
    });
}
