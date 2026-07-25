#!/usr/bin/env node
import {
  loadEnvFile,
  runSeed,
  writeFreshnessMetadataSafely,
} from './_seed-utils.mjs';
import {
  GACC_MAX_REQUESTS_PER_RUN,
  NBS_MAX_REQUESTS_PER_RUN,
  PBOC_MAX_REQUESTS_PER_RUN,
  SAFE_MAX_REQUESTS_PER_RUN,
  buildChinaMacroPillars,
  fetchChinaMacroSnapshot,
} from './china-macro/adapters.mjs';
import {
  CHINA_MACRO_MAX_CONTENT_AGE_MIN,
  CHINA_MACRO_MAX_TRANSPORT_AGE_MIN,
  CHINA_MACRO_CACHE_KEY,
  CHINA_MACRO_PUBLISHER_IDS,
  CHINA_MACRO_PROVENANCE_FAMILY,
  CHINA_MACRO_REQUIRED_SERIES,
  CHINA_MACRO_SCHEMA_VERSION,
  CHINA_MACRO_SERIES_CONTRACT,
  CHINA_MACRO_SERIES_IDS,
  chinaMacroObservationDateMs,
} from './_china-macro-contract.mjs';

loadEnvFile(import.meta.url);

export const CHINA_MACRO_KEY = CHINA_MACRO_CACHE_KEY;
export const CHINA_MACRO_TTL_SECONDS = 7 * 24 * 60 * 60;
export { CHINA_MACRO_MAX_CONTENT_AGE_MIN };
const REQUIRED_PROVENANCE_CLAIMS = [
  'publisher',
  'source_url',
  'original_reference',
  'original_language',
  'translation',
  'observation_time',
  'effective_time',
  'publication_time',
  'retrieval_time',
  'revision',
  'supersession',
  'extraction_confidence',
  'classification_confidence',
  'corroboration',
  'transport_freshness',
  'content_freshness',
  'derivation',
];
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isIsoInstant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function knownClaim(claim) {
  return hasExactKeys(claim, ['status', 'value']) && claim.status === 'known';
}

function unavailableClaim(claim, status) {
  return hasExactKeys(claim, ['status', 'reason'])
    && claim.status === status
    && typeof claim.reason === 'string'
    && claim.reason.length > 0;
}

function hasValidTemporalOrder(observation, generatedAtMs = Number.POSITIVE_INFINITY) {
  const observedAt = chinaMacroObservationDateMs(observation?.observationPeriod);
  const publishedAt = Date.parse(observation?.releaseTime);
  const retrievedAt = Date.parse(observation?.retrievalTime);
  return observedAt != null
    && Number.isFinite(publishedAt)
    && Number.isFinite(retrievedAt)
    && observedAt <= publishedAt
    && publishedAt <= retrievedAt
    && retrievedAt <= generatedAtMs;
}

function hasCompleteProvenance(observation) {
  const seriesContract = CHINA_MACRO_SERIES_CONTRACT[observation?.seriesId];
  if (!seriesContract) return false;
  const provenance = observation?.provenance;
  if (
    !hasExactKeys(provenance, ['contractVersion', 'signalId', 'familyId', 'claims'])
    || provenance.contractVersion !== 'decision-signal-provenance/v1'
    || provenance.familyId !== CHINA_MACRO_PROVENANCE_FAMILY
    || typeof provenance.signalId !== 'string'
    || provenance.signalId.length === 0
    || !hasExactKeys(provenance.claims, REQUIRED_PROVENANCE_CLAIMS)
  ) return false;
  const claims = provenance.claims;
  const publisher = claims.publisher?.value;
  const registry = publisher?.registryReference;
  const sourceUrl = claims.source_url?.value;
  const original = claims.original_reference?.value;
  const observationTime = claims.observation_time?.value;
  const publicationTime = claims.publication_time?.value;
  const retrievalTime = claims.retrieval_time?.value;
  const revision = claims.revision?.value;
  const supersession = claims.supersession?.value;
  const extraction = claims.extraction_confidence?.value;
  const transport = claims.transport_freshness?.value;
  const content = claims.content_freshness?.value;
  const expectedSequence = observation.revisionSequence ?? observation.sequence;
  const expectedState = observation.revisionState ?? observation.state;
  let parsedSource;
  try {
    parsedSource = new URL(sourceUrl);
  } catch {
    return false;
  }
  return hasValidTemporalOrder(observation)
    && knownClaim(claims.publisher)
    && hasExactKeys(publisher, ['id', 'name', 'type', 'registryReference'])
    && publisher.id === seriesContract.publisherId
    && typeof publisher.name === 'string'
    && publisher.name.length > 0
    && publisher.type === 'official_government'
    && hasExactKeys(registry, ['sourceName', 'sourceType', 'propagandaRisk'])
    && (registry.sourceName === 'NBS (China)' || registry.sourceName === 'SAFE (China)')
    && registry.sourceType === 'gov'
    && registry.propagandaRisk === 'high'
    && (
      seriesContract.publisherId === CHINA_MACRO_PUBLISHER_IDS.nbs
        ? publisher.name === 'National Bureau of Statistics of China'
          && registry.sourceName === 'NBS (China)'
        : publisher.name === 'State Administration of Foreign Exchange'
          && registry.sourceName === 'SAFE (China)'
    )
    && knownClaim(claims.source_url)
    && parsedSource.protocol === 'https:'
    && !parsedSource.username
    && !parsedSource.password
    && parsedSource.hostname === seriesContract.sourceHost
    && parsedSource.pathname.startsWith(seriesContract.sourcePathPrefix)
    && sourceUrl === observation.sourceUrl
    && knownClaim(claims.original_reference)
    && hasExactKeys(original, ['kind', 'id', 'contentHash'])
    && original.kind === 'observation'
    && typeof original.id === 'string'
    && original.id.length > 0
    && original.id === observation.vintageId
    && /^sha256:[0-9a-f]{64}$/.test(original.contentHash)
    && knownClaim(claims.original_language)
    && (claims.original_language.value === 'en' || claims.original_language.value === 'zh-CN')
    && unavailableClaim(claims.translation, 'not_applicable')
    && knownClaim(claims.observation_time)
    && hasExactKeys(observationTime, ['role', 'value', 'precision'])
    && observationTime.role === 'observation'
    && observationTime.precision === 'month'
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(observationTime.value)
    && observationTime.value === observation.observationPeriod
    && unavailableClaim(claims.effective_time, 'unknown')
    && knownClaim(claims.publication_time)
    && hasExactKeys(publicationTime, ['role', 'value', 'precision'])
    && publicationTime.role === 'publication'
    && (
      publicationTime.precision === 'instant'
        ? isIsoInstant(publicationTime.value)
        : publicationTime.precision === 'day'
          && isCalendarDay(publicationTime.value)
    )
    && publicationTime.value === observation.releaseTime
    && knownClaim(claims.retrieval_time)
    && hasExactKeys(retrievalTime, ['role', 'value', 'precision'])
    && retrievalTime.role === 'retrieval'
    && retrievalTime.precision === 'instant'
    && isIsoInstant(retrievalTime.value)
    && retrievalTime.value === observation.retrievalTime
    && knownClaim(claims.revision)
    && hasExactKeys(revision, ['vintageId', 'sequence', 'state'])
    && typeof revision.vintageId === 'string'
    && revision.vintageId === observation.vintageId
    && Number.isInteger(revision.sequence)
    && revision.sequence > 0
    && revision.sequence === expectedSequence
    && ['preliminary', 'original', 'revised', 'corrected'].includes(revision.state)
    && revision.state === expectedState
    && (
      revision.sequence === 1
        ? revision.state === 'preliminary' || revision.state === 'original'
        : revision.state === 'revised' || revision.state === 'corrected'
    )
    && knownClaim(claims.supersession)
    && (
      hasExactKeys(supersession, ['state'])
        ? supersession.state === 'current'
        : hasExactKeys(supersession, ['state', 'relatedSignalId', 'reason'])
          && supersession.state === 'superseded'
          && typeof supersession.relatedSignalId === 'string'
          && supersession.relatedSignalId.length > 0
          && typeof supersession.reason === 'string'
          && supersession.reason.length > 0
    )
    && knownClaim(claims.extraction_confidence)
    && hasExactKeys(extraction, ['score', 'method'])
    && Number.isFinite(extraction.score)
    && extraction.score >= 0
    && extraction.score <= 1
    && extraction.method === 'reviewed-release-regex/v1'
    && unavailableClaim(claims.classification_confidence, 'not_applicable')
    && unavailableClaim(claims.corroboration, 'unknown')
    && knownClaim(claims.transport_freshness)
    && (
      hasExactKeys(transport, ['state', 'assessedAt', 'lastSuccessAt'])
      || hasExactKeys(transport, ['state', 'assessedAt'])
    )
    && ['fresh', 'stale', 'error', 'blocked'].includes(transport.state)
    && isIsoInstant(transport.assessedAt)
    && isIsoInstant(transport.lastSuccessAt)
    && Date.parse(transport.assessedAt) >= Date.parse(observation.retrievalTime)
    && Date.parse(transport.lastSuccessAt) >= Date.parse(observation.retrievalTime)
    && Date.parse(transport.lastSuccessAt) <= Date.parse(transport.assessedAt)
    && (
      typeof observation.transportStatus !== 'string'
      || transport.state === observation.transportStatus
    )
    && knownClaim(claims.content_freshness)
    && hasExactKeys(content, ['state', 'assessedAt', 'contentAsOf'])
    && (content.state === 'current' || content.state === 'stale')
    && isIsoInstant(content.assessedAt)
    && content.assessedAt === transport.assessedAt
    && (
      typeof observation.stale !== 'boolean'
      || content.state === (observation.stale ? 'stale' : 'current')
    )
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(content.contentAsOf)
    && content.contentAsOf === observation.observationPeriod
    && provenance.signalId === `signal:${observation.vintageId}`
    && unavailableClaim(claims.derivation, 'not_applicable');
}

function hasValidVintage(vintage, observation) {
  if (
    !vintage
    || vintage.seriesId !== observation.seriesId
    || !Number.isFinite(vintage.value)
    || !Number.isInteger(vintage.sequence)
    || vintage.sequence < 1
    || typeof vintage.vintageId !== 'string'
    || vintage.vintageId.length === 0
    || !vintage.vintageId.startsWith(`${observation.seriesId}:`)
    || typeof vintage.observationPeriod !== 'string'
    || vintage.observationPeriod.length === 0
    || vintage.periodKind !== observation.periodKind
    || !hasCompleteProvenance(vintage)
  ) return false;
  const revision = vintage.provenance.claims.revision;
  return revision?.status === 'known'
    && revision.value?.vintageId === vintage.vintageId
    && revision.value?.sequence === vintage.sequence
    && revision.value?.state === vintage.state;
}

function hasValidVintageLineage(observation) {
  if (
    !Array.isArray(observation.vintages)
    || observation.vintages.length === 0
    || observation.vintages.length > 24
    || observation.vintages.some((vintage) => !hasValidVintage(vintage, observation))
  ) return false;
  const ids = observation.vintages.map((vintage) => vintage.vintageId);
  if (new Set(ids).size !== ids.length) return false;
  const current = observation.vintages.find((vintage) => vintage.vintageId === observation.vintageId);
  if (
    !current
    || current.sequence !== observation.revisionSequence
    || current.value !== observation.value
    || current.observationPeriod !== observation.observationPeriod
    || current.periodKind !== observation.periodKind
    || current.releaseTime !== observation.releaseTime
    || current.retrievalTime !== observation.retrievalTime
    || current.sourceUrl !== observation.sourceUrl
    || current.state !== observation.revisionState
    || current.provenance.signalId !== observation.provenance.signalId
  ) return false;
  const currentRevision = observation.provenance.claims.revision;
  if (
    currentRevision?.status !== 'known'
    || currentRevision.value?.vintageId !== observation.vintageId
    || currentRevision.value?.sequence !== observation.revisionSequence
    || currentRevision.value?.state !== observation.revisionState
  ) return false;

  const periods = Map.groupBy(
    observation.vintages,
    (vintage) => vintage.observationPeriod,
  );
  for (const periodVintages of periods.values()) {
    const ordered = [...periodVintages].sort((left, right) => left.sequence - right.sequence);
    const sequences = ordered.map((vintage) => vintage.sequence);
    if (
      new Set(sequences).size !== sequences.length
      || sequences.some((sequence, index) => index > 0 && sequence !== sequences[index - 1] + 1)
    ) return false;
    const periodIds = new Map(ordered.map((vintage, index) => [
      `signal:${vintage.vintageId}`,
      index,
    ]));
    for (const [index, vintage] of ordered.entries()) {
      const supersession = vintage.provenance.claims.supersession;
      const isPeriodCurrent = index === ordered.length - 1;
      if (isPeriodCurrent) {
        if (
          vintage.supersededBy
          || supersession?.status !== 'known'
          || supersession.value?.state !== 'current'
        ) return false;
        continue;
      }
      const targetIndex = periodIds.get(vintage.supersededBy);
      if (
        !vintage.supersededBy
        || supersession?.status !== 'known'
        || supersession.value?.state !== 'superseded'
        || supersession.value?.relatedSignalId !== vintage.supersededBy
        || targetIndex === undefined
        || targetIndex <= index
      ) return false;
    }
  }
  return true;
}

function hasValidSourceDecisions(sourceDecisions, generatedAtMs, now) {
  const expected = [
    [CHINA_MACRO_PUBLISHER_IDS.nbs, 'National Bureau of Statistics of China', 'www.stats.gov.cn', NBS_MAX_REQUESTS_PER_RUN, true],
    [CHINA_MACRO_PUBLISHER_IDS.safe, 'State Administration of Foreign Exchange', 'www.safe.gov.cn', SAFE_MAX_REQUESTS_PER_RUN, true],
    [CHINA_MACRO_PUBLISHER_IDS.pboc, 'People’s Bank of China', 'www.pbc.gov.cn', PBOC_MAX_REQUESTS_PER_RUN, false],
    [CHINA_MACRO_PUBLISHER_IDS.gacc, 'General Administration of Customs of China', 'english.customs.gov.cn', GACC_MAX_REQUESTS_PER_RUN, false],
  ];
  if (!Array.isArray(sourceDecisions) || sourceDecisions.length !== expected.length) return false;
  return expected.every(([publisherId, source, host, requestBudget, mayAccept]) => {
    const matches = sourceDecisions.filter((decision) => decision?.publisherId === publisherId);
    if (matches.length !== 1) return false;
    const decision = matches[0];
    let sourceUrl;
    try {
      sourceUrl = new URL(decision.sourceUrl);
    } catch {
      return false;
    }
    const checkedAt = Date.parse(decision.checkedAt);
    const minimumRequests = decision.status === 'accepted'
      ? (publisherId === CHINA_MACRO_PUBLISHER_IDS.nbs ? 5 : 4)
      : 1;
    const validPath = publisherId === CHINA_MACRO_PUBLISHER_IDS.nbs
      ? sourceUrl.pathname.startsWith('/english/PressRelease/')
      : publisherId === CHINA_MACRO_PUBLISHER_IDS.safe
        ? sourceUrl.pathname.startsWith('/safe/')
        : sourceUrl.pathname === '/';
    const validPolicyReview = publisherId === CHINA_MACRO_PUBLISHER_IDS.nbs
      ? decision.termsStatus === 'reviewed_2026-07-25_attribution_required'
        && ['allows_candidate_paths', 'no_rules_published', 'unavailable'].includes(decision.robotsStatus)
      : publisherId === CHINA_MACRO_PUBLISHER_IDS.safe
        ? decision.termsStatus === 'reviewed_2026-07-25_facts_only_attribution_required'
          && ['allows_candidate_paths', 'no_rules_published', 'unavailable'].includes(decision.robotsStatus)
        : publisherId === CHINA_MACRO_PUBLISHER_IDS.pboc
          ? decision.termsStatus === (
            decision.reason === 'ROBOTS_DISALLOW'
              ? 'not_evaluated_robots_blocked'
              : 'review_required'
          )
          : decision.termsStatus === 'reviewed_all_rights_reserved_chinese_authoritative';
    return decision.source === source
      && decision.host === host
      && sourceUrl.protocol === 'https:'
      && sourceUrl.hostname === host
      && !sourceUrl.username
      && !sourceUrl.password
      && validPath
      && typeof decision.source === 'string'
      && decision.source.length > 0
      && (decision.status === 'accepted' || decision.status === 'blocked')
      && (mayAccept || decision.status === 'blocked')
      && typeof decision.reason === 'string'
      && decision.reason.length > 0
      && (decision.status === 'accepted' ? decision.reason === 'OK' : decision.reason !== 'OK')
      && isIsoInstant(decision.checkedAt)
      && checkedAt <= generatedAtMs
      && checkedAt <= now + MAX_CLOCK_SKEW_MS
      && (decision.optional === undefined || decision.optional === false)
      && decision.requestBudget === requestBudget
      && Number.isInteger(decision.requestCount)
      && decision.requestCount >= minimumRequests
      && decision.requestCount <= requestBudget
      && ['none', 'followed', 'rejected'].includes(decision.redirectBehavior)
      && (decision.redirectBehavior !== 'followed' || decision.requestCount >= 2)
      && validPolicyReview;
  });
}

export function validateChinaMacroTransportSnapshot(snapshot, now = Date.now()) {
  const generatedAtMs = Date.parse(snapshot?.generatedAt);
  const required = CHINA_MACRO_REQUIRED_SERIES.map((seriesId) => (
    snapshot?.observations?.filter((item) => item?.seriesId === seriesId) ?? []
  ));
  if (
    snapshot?.schemaVersion !== CHINA_MACRO_SCHEMA_VERSION
    || snapshot?.countryCode !== 'CN'
    || !Array.isArray(snapshot?.observations)
    || snapshot.observations.length !== CHINA_MACRO_SERIES_IDS.length
    || snapshot.observations.some((observation, index) => (
      observation?.seriesId !== CHINA_MACRO_SERIES_IDS[index]
      || observation?.geography !== 'CN'
      || observation?.pillar !== CHINA_MACRO_SERIES_CONTRACT[observation.seriesId]?.pillar
      || observation?.unit !== CHINA_MACRO_SERIES_CONTRACT[observation.seriesId]?.unit
      || observation?.periodKind !== CHINA_MACRO_SERIES_CONTRACT[observation.seriesId]?.periodKind
      || observation?.source !== CHINA_MACRO_SERIES_CONTRACT[observation.seriesId]?.source
    ))
    || !isIsoInstant(snapshot?.generatedAt)
    || generatedAtMs > now + MAX_CLOCK_SKEW_MS
    || !hasValidSourceDecisions(snapshot?.sourceDecisions, generatedAtMs, now)
    || required.some((matches) => matches.length !== 1)
  ) return false;
  const requiredObservations = required.map(([observation]) => observation);
  const transportLastSuccessAt = Date.parse(snapshot.transportLastSuccessAt);
  const requiredTransportTimes = requiredObservations.map((observation) => (
    observation.provenance?.claims?.transport_freshness?.value?.lastSuccessAt
    || observation.retrievalTime
  ));
  const oldestRequiredTransport = [...requiredTransportTimes].sort()[0];
  const requiredPeriods = requiredObservations.map((observation) => observation.observationPeriod).sort();
  const sourceCohorts = [
    [CHINA_MACRO_PUBLISHER_IDS.nbs, requiredObservations.filter((observation) => observation.seriesId.startsWith('nbs_'))],
    [CHINA_MACRO_PUBLISHER_IDS.safe, requiredObservations.filter((observation) => observation.seriesId.startsWith('safe_'))],
  ];
  const hasDegradedObservation = snapshot.observations.some((observation) => (
    !Number.isFinite(observation?.value)
    || observation?.stale === true
    || Boolean(observation?.unavailableReason)
    || observation?.transportStatus === 'error'
    || observation?.transportStatus === 'blocked'
  ));
  const hasBlockedSource = snapshot.sourceDecisions.some((decision) => decision.status !== 'accepted');
  const allObservationsValid = snapshot.observations.every((observation) => {
    const contract = CHINA_MACRO_SERIES_CONTRACT[observation.seriesId];
    const decision = snapshot.sourceDecisions.find(
      (entry) => entry.publisherId === contract?.publisherId,
    );
    if (Number.isFinite(observation.value)) {
      const rows = [observation, ...(Array.isArray(observation.vintages) ? observation.vintages : [])];
      return hasCompleteProvenance(observation)
        && hasValidTemporalOrder(observation, generatedAtMs)
        && hasValidVintageLineage(observation)
        && rows.every((row) => {
          const transport = row.provenance?.claims?.transport_freshness?.value;
          const content = row.provenance?.claims?.content_freshness?.value;
          return Date.parse(transport?.assessedAt) <= generatedAtMs
            && Date.parse(content?.assessedAt) <= generatedAtMs;
        });
    }
    return observation.value === null
      && decision?.status === 'blocked'
      && observation.unavailableReason === decision.reason
      && observation.transportStatus === 'blocked'
      && observation.transportFailureReason === decision.reason
      && observation.provenance === null
      && Array.isArray(observation.vintages)
      && observation.vintages.length === 0
      && observation.observationPeriod === ''
      && observation.releaseTime === ''
      && observation.retrievalTime === '';
  });
  const expectedLaunchReady = requiredObservations.every((observation) => (
    observation
      && Number.isFinite(observation.value)
      && observation.stale !== true
      && !observation.unavailableReason
      && typeof observation.observationPeriod === 'string'
      && observation.observationPeriod.length > 0
      && typeof observation.releaseTime === 'string'
      && observation.releaseTime.length > 0
      && hasValidTemporalOrder(observation, generatedAtMs)
      && hasCompleteProvenance(observation)
      && observation.vintages.every((vintage) => hasValidTemporalOrder(vintage, generatedAtMs))
      && hasValidVintageLineage(observation)
  ));
  const hasAvailableObservation = snapshot.observations.some((observation) => (
    Number.isFinite(observation?.value)
  ));
  const expectedStatus = expectedLaunchReady
    ? (hasDegradedObservation || hasBlockedSource ? 'degraded' : 'ready')
    : (hasAvailableObservation ? 'degraded' : 'unavailable');
  if (
    snapshot.launchReady !== expectedLaunchReady
    || snapshot.status !== expectedStatus
    || !isIsoInstant(snapshot.transportLastSuccessAt)
    || transportLastSuccessAt > generatedAtMs
    || transportLastSuccessAt > now + MAX_CLOCK_SKEW_MS
    || snapshot.transportLastSuccessAt !== oldestRequiredTransport
    || snapshot.contentObservationDate !== (expectedLaunchReady ? requiredPeriods[0] : '')
    || snapshot.latestObservationDate !== requiredPeriods.at(-1)
    || JSON.stringify(snapshot.pillars) !== JSON.stringify(buildChinaMacroPillars(snapshot.observations))
    || !allObservationsValid
    || sourceCohorts.some(([publisherId, observations]) => {
      const decision = snapshot.sourceDecisions.find((entry) => entry.publisherId === publisherId);
      return decision?.status === 'accepted'
        ? observations.some((observation) => (
          observation.provenance?.claims?.transport_freshness?.value?.lastSuccessAt !== decision.checkedAt
          || observation.transportStatus !== 'fresh'
          || observation.transportFailureReason !== ''
        ))
        : observations.some((observation) => (
          observation.transportStatus !== 'error'
          || observation.transportFailureReason !== decision?.reason
          || Date.parse(
            observation.provenance?.claims?.transport_freshness?.value?.lastSuccessAt,
          ) >= Date.parse(decision?.checkedAt)
        ));
    })
  ) return false;

  return true;
}

export function validateChinaMacroSnapshot(snapshot, now = Date.now()) {
  if (
    snapshot?.launchReady !== true
    || !validateChinaMacroTransportSnapshot(snapshot, now)
  ) return false;
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const requiredObservations = CHINA_MACRO_REQUIRED_SERIES.map((seriesId) => (
    snapshot.observations.find((item) => item?.seriesId === seriesId)
  ));
  return requiredObservations.every((observation) => (
    observation
      && Number.isFinite(observation.value)
      && observation.stale !== true
      && !observation.unavailableReason
      && typeof observation.observationPeriod === 'string'
      && observation.observationPeriod.length > 0
      && typeof observation.releaseTime === 'string'
      && observation.releaseTime.length > 0
      && hasValidTemporalOrder(observation, generatedAtMs)
      && hasCompleteProvenance(observation)
      && observation.vintages.every((vintage) => hasValidTemporalOrder(vintage, generatedAtMs))
      && hasValidVintageLineage(observation)
  ));
}

export function chinaMacroContentMeta(snapshot) {
  if (!snapshot?.launchReady || !snapshot.contentObservationDate) return null;
  const observedAt = chinaMacroObservationDateMs(snapshot.contentObservationDate);
  if (observedAt == null) return null;
  return { newestItemAt: observedAt, oldestItemAt: observedAt };
}

export function chinaMacroTransportMeta(snapshot, now = Date.now()) {
  const generatedAt = Date.parse(snapshot?.generatedAt);
  const lastSuccessAt = Date.parse(snapshot?.transportLastSuccessAt);
  return Number.isFinite(lastSuccessAt)
    && lastSuccessAt > 0
    && Number.isFinite(generatedAt)
    && lastSuccessAt <= generatedAt
    && lastSuccessAt <= now + MAX_CLOCK_SKEW_MS
    ? lastSuccessAt
    : null;
}

export async function recordChinaMacroTransportFreshness(
  snapshot,
  writeMetadataFn = writeFreshnessMetadataSafely,
  now = Date.now(),
) {
  if (!validateChinaMacroTransportSnapshot(snapshot, now)) {
    throw new Error('China macro snapshot is not a structurally valid official transport snapshot');
  }
  const transportAt = chinaMacroTransportMeta(snapshot, now);
  if (transportAt == null) {
    throw new Error('China macro snapshot is missing a valid transportLastSuccessAt');
  }
  await writeMetadataFn(
    'economic',
    'china-macro-transport',
    CHINA_MACRO_REQUIRED_SERIES.length,
    'china-macro-required-official-sources-v2',
    CHINA_MACRO_TTL_SECONDS,
    transportAt,
  );
}

export async function recordChinaMacroCompletedRun(
  snapshot,
  writeMetadataFn = writeFreshnessMetadataSafely,
  now = Date.now(),
) {
  if (!validateChinaMacroTransportSnapshot(snapshot, now)) {
    throw new Error('China macro snapshot is not a structurally valid completed run');
  }
  await writeMetadataFn(
    'economic',
    'china-macro-complete',
    CHINA_MACRO_REQUIRED_SERIES.length,
    'china-macro-required-official-sources-v2',
    CHINA_MACRO_TTL_SECONDS,
    now,
  );
}

if (process.argv[1]?.endsWith('seed-china-macro.mjs')) {
  const fetchAndRecordTransport = async () => {
    const snapshot = await fetchChinaMacroSnapshot();
    await recordChinaMacroTransportFreshness(snapshot);
    return snapshot;
  };
  runSeed('economic', 'china-macro', CHINA_MACRO_KEY, fetchAndRecordTransport, {
    ttlSeconds: CHINA_MACRO_TTL_SECONDS,
    lockTtlMs: 210_000,
    fetchPhaseTimeoutMs: 150_000,
    validateFn: validateChinaMacroSnapshot,
    declareRecords: (data) => data.observations.filter((item) => Number.isFinite(item?.value)).length,
    sourceVersion: 'china-macro-official-nbs-safe-pboc-gacc-v2',
    schemaVersion: CHINA_MACRO_SCHEMA_VERSION,
    maxStaleMin: CHINA_MACRO_MAX_TRANSPORT_AGE_MIN,
    contentMeta: chinaMacroContentMeta,
    maxContentAgeMin: CHINA_MACRO_MAX_CONTENT_AGE_MIN,
    afterPublish: async (data) => recordChinaMacroCompletedRun(data),
    afterPreservedValidationSkip: async (data) => recordChinaMacroCompletedRun(data),
  });
}
