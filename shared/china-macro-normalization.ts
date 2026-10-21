import {
  CHINA_MACRO_MAX_TRANSPORT_AGE_MIN,
  CHINA_MACRO_PUBLISHER_IDS,
  CHINA_MACRO_PROVENANCE_FAMILY,
  CHINA_MACRO_SERIES_CONTRACT,
  CHINA_MACRO_SERIES_IDS,
  chinaMacroObservationDateMs,
  isChinaMacroObservationStale,
} from './china-macro-contract.js';
import { validateDecisionSignalProvenance } from './decision-signal-provenance';

type JsonRecord = Record<string, unknown>;

export interface NormalizedChinaMacroVintage {
  vintageId: string;
  sequence: number;
  state: string;
  value: number;
  hasValue: boolean;
  observationPeriod: string;
  periodKind: string;
  releaseTime: string;
  retrievalTime: string;
  supersededBy: string;
  provenanceJson: string;
}

export interface NormalizedChinaMacroIndicator {
  id: string;
  label: string;
  category: string;
  value: number;
  hasValue: boolean;
  priorValue: number;
  hasPriorValue: boolean;
  unit: string;
  observationDate: string;
  source: string;
  sourceUrl: string;
  stale: boolean;
  unavailableReason: string;
  contextOnly: boolean;
  geography: string;
  seasonalAdjustment: string;
  periodKind: string;
  observationPeriod: string;
  releaseTime: string;
  retrievalTime: string;
  direction: string;
  directionReason: string;
  comparisonBasis: string;
  comparisonValue: number;
  hasComparisonValue: boolean;
  revisionState: string;
  vintageId: string;
  revisionSequence: number;
  provenanceJson: string;
  vintages: NormalizedChinaMacroVintage[];
  transportStatus: string;
  transportFailureReason: string;
}

export interface NormalizedChinaMacroSourceDecision {
  source: string;
  host: string;
  status: string;
  reason: string;
  checkedAt: string;
  optional: boolean;
  requestCount: number;
  publisherId: string;
  redirectBehavior: string;
  requestBudget: number;
  robotsStatus: string;
  termsStatus: string;
  sourceUrl: string;
}

export interface NormalizedChinaMacroPillarPulse {
  pillar: string;
  direction: string;
  reason: string;
  observationIds: string[];
}

export interface NormalizedChinaReleaseEvent {
  id: string;
  event: string;
  countryCode: string;
  releaseDate: string;
  releaseTime: string;
  timezone: string;
  kind: string;
  status: string;
  source: string;
  sourceUrl: string;
}

const CHINA_MACRO_PILLARS = [
  'activity',
  'investment_property',
  'credit_liquidity',
  'external_pressure',
  'trade',
] as const;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const CHINA_MACRO_PREFLIGHTS = [
  {
    publisherId: CHINA_MACRO_PUBLISHER_IDS.nbs,
    source: 'National Bureau of Statistics of China',
    host: 'www.stats.gov.cn',
    requestBudget: 8,
    mayAccept: true,
    path: (pathname: string) => pathname.startsWith('/english/PressRelease/'),
  },
  {
    publisherId: CHINA_MACRO_PUBLISHER_IDS.safe,
    source: 'State Administration of Foreign Exchange',
    host: 'www.safe.gov.cn',
    requestBudget: 6,
    mayAccept: true,
    path: (pathname: string) => pathname.startsWith('/safe/'),
  },
  {
    publisherId: CHINA_MACRO_PUBLISHER_IDS.pboc,
    source: 'People’s Bank of China',
    host: 'www.pbc.gov.cn',
    requestBudget: 2,
    mayAccept: false,
    path: (pathname: string) => pathname === '/',
  },
  {
    publisherId: CHINA_MACRO_PUBLISHER_IDS.gacc,
    source: 'General Administration of Customs of China',
    host: 'english.customs.gov.cn',
    requestBudget: 2,
    mayAccept: false,
    path: (pathname: string) => pathname === '/',
  },
] as const;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validTemporalOrder(row: JsonRecord, generatedAtMs?: number): boolean {
  const observedAt = chinaMacroObservationDateMs(asString(row.observationPeriod));
  const publishedAt = Date.parse(asString(row.releaseTime));
  const retrievedAt = Date.parse(asString(row.retrievalTime));
  return observedAt != null
    && Number.isFinite(publishedAt)
    && Number.isFinite(retrievedAt)
    && observedAt <= publishedAt
    && publishedAt <= retrievedAt
    && (generatedAtMs === undefined || retrievedAt <= generatedAtMs);
}

function validProvenance(value: unknown): boolean {
  const result = validateDecisionSignalProvenance(value);
  return result.ok && result.value.familyId === CHINA_MACRO_PROVENANCE_FAMILY;
}

function validBoundProvenance(row: JsonRecord, expectedSeriesId?: string): boolean {
  const seriesId = asString(row.seriesId);
  if (expectedSeriesId !== undefined && seriesId !== expectedSeriesId) return false;
  const seriesContract = CHINA_MACRO_SERIES_CONTRACT[seriesId];
  if (!seriesContract) return false;
  if (!validProvenance(row.provenance)) return false;
  const provenance = asRecord(row.provenance);
  const claims = asRecord(provenance.claims);
  const sourceUrl = asRecord(claims.source_url).value;
  const originalReference = asRecord(asRecord(claims.original_reference).value);
  const observationTime = asRecord(asRecord(claims.observation_time).value);
  const publicationTime = asRecord(asRecord(claims.publication_time).value);
  const retrievalTime = asRecord(asRecord(claims.retrieval_time).value);
  const revision = asRecord(asRecord(claims.revision).value);
  const publisher = asRecord(asRecord(claims.publisher).value);
  const transport = asRecord(asRecord(claims.transport_freshness).value);
  const content = asRecord(asRecord(claims.content_freshness).value);
  let parsedSource: URL;
  try {
    parsedSource = new URL(asString(row.sourceUrl));
  } catch {
    return false;
  }
  const vintageId = asString(row.vintageId);
  return validTemporalOrder(row)
    && vintageId.startsWith(`${seriesId}:`)
    && (row.pillar === undefined || row.pillar === seriesContract.pillar)
    && (row.unit === undefined || row.unit === seriesContract.unit)
    && row.periodKind === seriesContract.periodKind
    && (row.source === undefined || row.source === seriesContract.source)
    && publisher.id === seriesContract.publisherId
    && parsedSource.protocol === 'https:'
    && parsedSource.hostname === seriesContract.sourceHost
    && parsedSource.pathname.startsWith(seriesContract.sourcePathPrefix)
    && parsedSource.username === ''
    && parsedSource.password === ''
    && sourceUrl === row.sourceUrl
    && originalReference.id === vintageId
    && observationTime.value === row.observationPeriod
    && publicationTime.value === row.releaseTime
    && retrievalTime.value === row.retrievalTime
    && revision.vintageId === vintageId
    && revision.sequence === row.sequence
    && revision.state === row.state
    && isIsoInstant(transport.lastSuccessAt)
    && isIsoInstant(transport.assessedAt)
    && Date.parse(asString(transport.assessedAt)) >= Date.parse(asString(row.retrievalTime))
    && Date.parse(asString(transport.lastSuccessAt)) >= Date.parse(asString(row.retrievalTime))
    && Date.parse(asString(transport.lastSuccessAt)) <= Date.parse(asString(transport.assessedAt))
    && (
      typeof row.transportStatus !== 'string'
      || transport.state === row.transportStatus
    )
    && content.assessedAt === transport.assessedAt
    && (
      typeof row.stale !== 'boolean'
      || content.state === (row.stale ? 'stale' : 'current')
    )
    && provenance.signalId === `signal:${vintageId}`;
}

function validVintageLineage(row: JsonRecord, vintages: unknown[]): boolean {
  if (vintages.length === 0 || vintages.length > 24) return false;
  const records = vintages.map(asRecord);
  const seriesId = asString(row.seriesId);
  if (records.some((vintage) => asString(vintage.seriesId) !== seriesId)) return false;
  const ids = records.map((vintage) => asString(vintage.vintageId));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
  const current = records.filter((vintage) => vintage.vintageId === row.vintageId);
  if (current.length !== 1) return false;
  const active = current[0];
  if (!active) return false;
  if (
    active.value !== row.value
    || active.observationPeriod !== row.observationPeriod
    || active.periodKind !== row.periodKind
    || active.releaseTime !== row.releaseTime
    || active.retrievalTime !== row.retrievalTime
    || active.sourceUrl !== row.sourceUrl
    || active.sequence !== row.revisionSequence
    || active.state !== row.revisionState
  ) return false;

  const byPeriod = new Map<string, JsonRecord[]>();
  for (const vintage of records) {
    const period = asString(vintage.observationPeriod);
    const group = byPeriod.get(period) ?? [];
    group.push(vintage);
    byPeriod.set(period, group);
  }
  for (const periodVintages of byPeriod.values()) {
    const ordered = [...periodVintages].sort(
      (left, right) => (asNumber(left.sequence) ?? 0) - (asNumber(right.sequence) ?? 0),
    );
    const sequences = ordered.map((vintage) => asNumber(vintage.sequence) ?? 0);
    if (
      new Set(sequences).size !== sequences.length
      || sequences.some((sequence, index) => {
        const previous = sequences[index - 1];
        return index > 0 && (previous === undefined || sequence !== previous + 1);
      })
    ) return false;
    const periodIds = new Map(ordered.map((vintage, index) => [
      `signal:${asString(vintage.vintageId)}`,
      index,
    ]));
    for (const [index, vintage] of ordered.entries()) {
      const provenance = asRecord(vintage.provenance);
      const claims = asRecord(provenance.claims);
      const supersession = asRecord(asRecord(claims.supersession).value);
      const supersededBy = asString(vintage.supersededBy);
      const isPeriodCurrent = index === ordered.length - 1;
      if (isPeriodCurrent) {
        if (supersededBy !== '' || supersession.state !== 'current') return false;
        continue;
      }
      const targetIndex = periodIds.get(supersededBy);
      if (
        supersededBy === ''
        || supersession.state !== 'superseded'
        || supersession.relatedSignalId !== supersededBy
        || targetIndex === undefined
        || targetIndex <= index
      ) return false;
    }
  }
  return true;
}

function normalizeProvenanceForRead(
  value: unknown,
  {
    contentStale,
    contentAsOf,
    retrievalTime,
    transportStatus,
    now,
  }: {
    contentStale: boolean;
    contentAsOf: string;
    retrievalTime: string;
    transportStatus: string;
    now: number;
  },
): { provenanceJson: string; transportStatus: string } {
  if (!validProvenance(value)) return { provenanceJson: '', transportStatus };
  const provenance = structuredClone(asRecord(value));
  const claims = asRecord(provenance.claims);
  const assessedAt = new Date(now).toISOString();
  const transport = asRecord(asRecord(claims.transport_freshness).value);
  const lastSuccessAtMs = Date.parse(asString(transport.lastSuccessAt) || retrievalTime);
  const transportStale = !Number.isFinite(lastSuccessAtMs)
    || now - lastSuccessAtMs > CHINA_MACRO_MAX_TRANSPORT_AGE_MIN * 60_000;
  const effectiveTransportStatus = transportStatus === 'error' || transportStatus === 'blocked'
    ? transportStatus
    : transportStale ? 'stale' : 'fresh';

  claims.transport_freshness = {
    status: 'known',
    value: {
      state: effectiveTransportStatus,
      assessedAt,
      ...(Number.isFinite(lastSuccessAtMs) ? { lastSuccessAt: new Date(lastSuccessAtMs).toISOString() } : {}),
    },
  };
  claims.content_freshness = {
    status: 'known',
    value: {
      state: contentStale ? 'stale' : 'current',
      assessedAt,
      contentAsOf,
    },
  };
  provenance.claims = claims;
  return {
    provenanceJson: JSON.stringify(provenance),
    transportStatus: effectiveTransportStatus,
  };
}

function normalizeVintage(
  value: unknown,
  {
    currentVintageId,
    seriesId,
    transportStatus,
    now,
  }: {
    currentVintageId: string;
    seriesId: string;
    transportStatus: string;
    now: number;
  },
): NormalizedChinaMacroVintage | null {
  const row = asRecord(value);
  const current = asNumber(row.value);
  if (current === null || !validBoundProvenance(row, seriesId)) return null;
  const isCurrent = row.vintageId === currentVintageId;
  const provenanceJson = isCurrent
    ? normalizeProvenanceForRead(row.provenance, {
      contentStale: isChinaMacroObservationStale(
        seriesId,
        asString(row.observationPeriod),
        now,
      ),
      contentAsOf: asString(row.observationPeriod),
      retrievalTime: asString(row.retrievalTime),
      transportStatus,
      now,
    }).provenanceJson
    : JSON.stringify(row.provenance);
  return {
    vintageId: asString(row.vintageId),
    sequence: Math.max(0, Math.trunc(asNumber(row.sequence) ?? 0)),
    state: asString(row.state),
    value: current,
    hasValue: true,
    observationPeriod: asString(row.observationPeriod),
    periodKind: asString(row.periodKind),
    releaseTime: asString(row.releaseTime),
    retrievalTime: asString(row.retrievalTime),
    supersededBy: asString(row.supersededBy),
    provenanceJson,
  };
}

export function normalizeChinaMacroObservation(
  value: unknown,
  now = Date.now(),
): NormalizedChinaMacroIndicator | null {
  const row = asRecord(value);
  const current = asNumber(row.value);
  const provenanceRow = {
    ...row,
    sequence: row.revisionSequence,
    state: row.revisionState,
  };
  const provenanceIsValid = validBoundProvenance(provenanceRow);
  const rawVintages = Array.isArray(row.vintages) ? row.vintages : [];
  const seriesId = asString(row.seriesId);
  const vintages = rawVintages.map((vintage) => normalizeVintage(vintage, {
    currentVintageId: asString(row.vintageId),
    seriesId,
    transportStatus: asString(row.transportStatus),
    now,
  }));

  if (
    (current === null && row.provenance != null)
    || (
      current !== null
      && (
        !provenanceIsValid
        || vintages.some((item) => item === null)
        || !validVintageLineage(row, rawVintages)
      )
    )
  ) return null;

  const observationPeriod = asString(row.observationPeriod);
  const stale = current !== null
    ? isChinaMacroObservationStale(seriesId, observationPeriod, now)
    : row.stale === true;
  const unavailableReason = current !== null && stale
    ? 'STALE_OBSERVATION'
    : asString(row.unavailableReason);
  const comparison = asNumber(row.comparisonValue);
  const normalizedProvenance = normalizeProvenanceForRead(row.provenance, {
    contentStale: stale,
    contentAsOf: observationPeriod,
    retrievalTime: asString(row.retrievalTime),
    transportStatus: asString(row.transportStatus),
    now,
  });

  return {
    id: seriesId,
    label: asString(row.label),
    category: asString(row.pillar),
    value: current ?? 0,
    hasValue: current !== null,
    priorValue: 0,
    hasPriorValue: false,
    unit: asString(row.unit),
    observationDate: observationPeriod,
    source: asString(row.source),
    sourceUrl: asString(row.sourceUrl),
    stale,
    unavailableReason,
    contextOnly: false,
    geography: asString(row.geography),
    seasonalAdjustment: asString(row.seasonalAdjustment),
    periodKind: asString(row.periodKind),
    observationPeriod,
    releaseTime: asString(row.releaseTime),
    retrievalTime: asString(row.retrievalTime),
    direction: stale ? 'unavailable' : asString(row.direction),
    directionReason: stale ? 'STALE_OBSERVATION' : asString(row.directionReason),
    comparisonBasis: asString(row.comparisonBasis),
    comparisonValue: comparison ?? 0,
    hasComparisonValue: comparison !== null,
    revisionState: asString(row.revisionState),
    vintageId: asString(row.vintageId),
    revisionSequence: Math.max(0, Math.trunc(asNumber(row.revisionSequence) ?? 0)),
    provenanceJson: provenanceIsValid ? normalizedProvenance.provenanceJson : '',
    vintages: vintages.filter((item): item is NormalizedChinaMacroVintage => item !== null),
    transportStatus: normalizedProvenance.transportStatus,
    transportFailureReason: asString(row.transportFailureReason),
  };
}

export function normalizeChinaMacroObservations(
  values: unknown[],
  now = Date.now(),
  generatedAt?: string,
): NormalizedChinaMacroIndicator[] | null {
  let generatedAtMs: number | undefined;
  if (generatedAt !== undefined) {
    if (!isIsoInstant(generatedAt)) return null;
    generatedAtMs = Date.parse(generatedAt);
    if (generatedAtMs > now + MAX_CLOCK_SKEW_MS) return null;
  }
  if (
    values.length !== CHINA_MACRO_SERIES_IDS.length
    || values.some((value, index) => {
      const row = asRecord(value);
      const seriesId = asString(row.seriesId);
      const contract = CHINA_MACRO_SERIES_CONTRACT[seriesId];
      if (
        seriesId !== CHINA_MACRO_SERIES_IDS[index]
        || !contract
        || row.pillar !== contract.pillar
        || row.geography !== 'CN'
        || row.unit !== contract.unit
        || row.periodKind !== contract.periodKind
        || row.source !== contract.source
      ) return true;
      try {
        const sourceUrl = new URL(asString(row.sourceUrl));
        return sourceUrl.protocol !== 'https:'
          || sourceUrl.hostname !== contract.sourceHost
          || !sourceUrl.pathname.startsWith(contract.sourcePathPrefix)
          || sourceUrl.username !== ''
          || sourceUrl.password !== '';
      } catch {
        return true;
      }
    })
  ) return null;
  if (generatedAtMs !== undefined && values.some((value) => {
    const row = asRecord(value);
    if (asNumber(row.value) === null) return false;
    if (!validTemporalOrder(row, generatedAtMs)) return true;
    const vintages = Array.isArray(row.vintages) ? row.vintages : [];
    return vintages.some((vintage) => !validTemporalOrder(asRecord(vintage), generatedAtMs));
  })) return null;
  if (generatedAtMs !== undefined && values.some((value) => {
    const row = asRecord(value);
    if (asNumber(row.value) === null) return false;
    const rows = [row, ...(Array.isArray(row.vintages) ? row.vintages.map(asRecord) : [])];
    return rows.some((candidate) => {
      const claims = asRecord(asRecord(candidate.provenance).claims);
      const transport = asRecord(asRecord(claims.transport_freshness).value);
      const content = asRecord(asRecord(claims.content_freshness).value);
      return Date.parse(asString(transport.assessedAt)) > generatedAtMs
        || Date.parse(asString(content.assessedAt)) > generatedAtMs;
    });
  })) return null;
  const normalized = values.map((value) => normalizeChinaMacroObservation(value, now));
  return normalized.some((value) => value === null)
    ? null
    : normalized.filter((value): value is NormalizedChinaMacroIndicator => value !== null);
}

export function normalizeChinaMacroSourceDecision(
  value: unknown,
): NormalizedChinaMacroSourceDecision {
  const row = asRecord(value);
  return {
    source: asString(row.source),
    host: asString(row.host),
    status: asString(row.status),
    reason: asString(row.reason),
    checkedAt: asString(row.checkedAt),
    optional: row.optional === true,
    requestCount: Math.max(0, Math.trunc(asNumber(row.requestCount) ?? 0)),
    publisherId: asString(row.publisherId),
    redirectBehavior: asString(row.redirectBehavior),
    requestBudget: Math.max(0, Math.trunc(asNumber(row.requestBudget) ?? 0)),
    robotsStatus: asString(row.robotsStatus),
    termsStatus: asString(row.termsStatus),
    sourceUrl: asString(row.sourceUrl),
  };
}

export function normalizeChinaMacroPreflight(
  values: unknown[],
  generatedAt: string,
  now = Date.now(),
): NormalizedChinaMacroSourceDecision[] | null {
  const generatedAtMs = Date.parse(generatedAt);
  if (
    !isIsoInstant(generatedAt)
    || generatedAtMs > now + MAX_CLOCK_SKEW_MS
    || values.length !== CHINA_MACRO_PREFLIGHTS.length
  ) return null;
  const normalized = values.map(normalizeChinaMacroSourceDecision);
  const valid = CHINA_MACRO_PREFLIGHTS.every((expected) => {
    const matches = normalized.filter((decision) => decision.publisherId === expected.publisherId);
    if (matches.length !== 1) return false;
    const decision = matches[0];
    if (!decision) return false;
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(decision.sourceUrl);
    } catch {
      return false;
    }
    const checkedAt = Date.parse(decision.checkedAt);
    const minimumRequests = decision.status === 'accepted'
      ? (expected.publisherId === CHINA_MACRO_PUBLISHER_IDS.nbs ? 5 : 4)
      : 1;
    const validPolicyReview = expected.publisherId === CHINA_MACRO_PUBLISHER_IDS.nbs
      ? decision.termsStatus === 'reviewed_2026-07-25_attribution_required'
        && ['allows_candidate_paths', 'no_rules_published', 'unavailable'].includes(decision.robotsStatus)
      : expected.publisherId === CHINA_MACRO_PUBLISHER_IDS.safe
        ? decision.termsStatus === 'reviewed_2026-07-25_facts_only_attribution_required'
          && ['allows_candidate_paths', 'no_rules_published', 'unavailable'].includes(decision.robotsStatus)
        : expected.publisherId === CHINA_MACRO_PUBLISHER_IDS.pboc
          ? decision.termsStatus === (
            decision.reason === 'ROBOTS_DISALLOW'
              ? 'not_evaluated_robots_blocked'
              : 'review_required'
          )
          : decision.termsStatus === 'reviewed_all_rights_reserved_chinese_authoritative';
    return decision.source === expected.source
      && decision.host === expected.host
      && decision.status !== ''
      && (decision.status === 'accepted' || decision.status === 'blocked')
      && (expected.mayAccept || decision.status === 'blocked')
      && decision.reason !== ''
      && (decision.status === 'accepted' ? decision.reason === 'OK' : decision.reason !== 'OK')
      && isIsoInstant(decision.checkedAt)
      && checkedAt <= generatedAtMs
      && checkedAt <= now + MAX_CLOCK_SKEW_MS
      && decision.optional === false
      && Number.isInteger(decision.requestCount)
      && decision.requestCount >= minimumRequests
      && decision.requestCount <= expected.requestBudget
      && decision.requestBudget === expected.requestBudget
      && ['none', 'followed', 'rejected'].includes(decision.redirectBehavior)
      && (decision.redirectBehavior !== 'followed' || decision.requestCount >= 2)
      && validPolicyReview
      && sourceUrl.protocol === 'https:'
      && sourceUrl.hostname === expected.host
      && sourceUrl.username === ''
      && sourceUrl.password === ''
      && expected.path(sourceUrl.pathname);
  });
  return valid ? normalized : null;
}

export function validateChinaMacroAvailabilityBindings(
  values: unknown[],
  decisions: NormalizedChinaMacroSourceDecision[],
): boolean {
  return values.every((value) => {
    const row = asRecord(value);
    const contract = CHINA_MACRO_SERIES_CONTRACT[asString(row.seriesId)];
    const decision = decisions.find((entry) => entry.publisherId === contract?.publisherId);
    if (asNumber(row.value) !== null) {
      return decision?.status === 'accepted'
        ? row.transportStatus === 'fresh' && row.transportFailureReason === ''
        : decision?.status === 'blocked'
          && row.transportStatus === 'error'
          && row.transportFailureReason === decision.reason;
    }
    return row.value === null
      && decision?.status === 'blocked'
      && row.unavailableReason === decision.reason
      && row.transportStatus === 'blocked'
      && row.transportFailureReason === decision.reason
      && row.provenance === null
      && Array.isArray(row.vintages)
      && row.vintages.length === 0
      && row.observationPeriod === ''
      && row.releaseTime === ''
      && row.retrievalTime === '';
  });
}

export function normalizeChinaReleaseEvent(value: unknown): NormalizedChinaReleaseEvent {
  const row = asRecord(value);
  return {
    id: asString(row.id),
    event: asString(row.event),
    countryCode: asString(row.countryCode),
    releaseDate: asString(row.releaseDate),
    releaseTime: asString(row.releaseTime),
    timezone: asString(row.timezone),
    kind: asString(row.kind),
    status: asString(row.status),
    source: asString(row.source),
    sourceUrl: asString(row.sourceUrl),
  };
}

export function recomputeChinaMacroPillars(
  observations: NormalizedChinaMacroIndicator[],
): NormalizedChinaMacroPillarPulse[] {
  return CHINA_MACRO_PILLARS.map((pillar) => {
    const candidates = observations.filter((observation) => observation.category === pillar);
    const comparable = candidates.filter((observation) => (
      observation.hasValue
      && !observation.stale
      && observation.direction !== 'unavailable'
    ));
    const comparisonFrames = new Set(comparable.map((observation) => (
      `${observation.observationPeriod}|${observation.periodKind}|${observation.comparisonBasis}`
    )));
    const directions = [...new Set(comparable.map((observation) => observation.direction))];
    const comparableFrame = comparisonFrames.size <= 1;
    return {
      pillar,
      direction: comparableFrame && directions.length === 1
        ? (directions[0] ?? 'unavailable')
        : 'unavailable',
      reason: !comparableFrame
        ? 'INCOMPARABLE_PERIOD_OR_BASIS'
        : directions.length === 0
        ? 'NO_AVAILABLE_OFFICIAL_OBSERVATION'
        : directions.length === 1
          ? 'CONSISTENT_AVAILABLE_OBSERVATIONS'
          : 'MIXED_OFFICIAL_SIGNALS',
      observationIds: candidates.map((observation) => observation.id),
    };
  });
}
