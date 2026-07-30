import { createHash } from 'node:crypto';
import { decodeHtmlEntities } from '../_html-entities.mjs';
import { readCanonicalValue } from '../_seed-utils.mjs';
import {
  CHINA_MACRO_CACHE_KEY,
  CHINA_MACRO_PROVENANCE_FAMILY,
  CHINA_MACRO_PUBLISHER_IDS,
  CHINA_MACRO_REQUIRED_SERIES,
  chinaMacroObservationDateMs,
  isChinaMacroObservationStale,
} from '../_china-macro-contract.mjs';
import {
  assertRobotsAllowed,
  checkRobots,
  fetchText,
  findReleaseUrl,
  reasonFor,
  requestBudget,
  robotsDisallowAll,
} from './source-runtime.mjs';
import {
  GACC_MAX_REQUESTS_PER_RUN,
  GACC_ROBOTS_URL,
  NBS_LIST_URL,
  NBS_MAX_REQUESTS_PER_RUN,
  NBS_ROBOTS_URL,
  PBOC_MAX_REQUESTS_PER_RUN,
  PBOC_ROBOTS_URL,
  PUBLISHERS,
  SAFE_LIST_URL,
  SAFE_MAX_REQUESTS_PER_RUN,
  SAFE_ROBOTS_URL,
  SOURCE_POLICIES,
  UNAVAILABLE_DEFINITIONS,
} from './source-contracts.mjs';
import {
  buildChinaMacroPillars,
  buildChinaMacroSnapshot,
} from './snapshot-builder.mjs';

export { CHINA_MACRO_CACHE_KEY };
export { buildChinaMacroPillars, buildChinaMacroSnapshot };
export {
  GACC_MAX_REQUESTS_PER_RUN,
  NBS_MAX_REQUESTS_PER_RUN,
  PBOC_MAX_REQUESTS_PER_RUN,
  SAFE_MAX_REQUESTS_PER_RUN,
};

const CONTRACT_VERSION = 'decision-signal-provenance/v1';
const MAX_VINTAGES_PER_SERIES = 24;

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function contentHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function revisionMarker(title) {
  if (/preliminary|初步/i.test(title)) return 'preliminary';
  if (/correct|更正/i.test(title)) return 'corrected';
  if (/revis|修订/i.test(title)) return 'revised';
  return 'original';
}

function semanticFingerprint(observation) {
  return contentHash(JSON.stringify({
    seriesId: observation.seriesId,
    observationPeriod: observation.observationPeriod,
    periodKind: observation.periodKind,
    value: observation.value,
    comparisonValue: observation.comparisonValue,
    comparisonBasis: observation.comparisonBasis,
    unit: observation.unit,
    seasonalAdjustment: observation.seasonalAdjustment,
    revisionMarker: revisionMarker(observation.releaseTitle),
  }));
}

function decodeHtml(value) {
  // The helper decodes `&#160;` to a literal U+00A0; normalize it back to a
  // plain space to keep this decoder's historical `&nbsp;|&#160;` -> ' '
  // contract for `metaContent` (which only trims, never collapses).
  return decodeHtmlEntities(String(value)).replace(/\u00A0/g, ' ');
}

function stripHtml(value) {
  return decodeHtml(
    String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function metaContent(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeHtml(match[1]).trim();
  }
  return '';
}

function requireMatch(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match) throw new Error(`MALFORMED_RELEASE:${label}`);
  return match;
}

function signedValue(direction, magnitude) {
  const value = Number(magnitude);
  if (!Number.isFinite(value)) throw new Error('MALFORMED_RELEASE:NON_NUMERIC_VALUE');
  return /decrease|down|下降|减少/i.test(direction) ? -value : value;
}

function directionFromChange(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  if (value > 0) return 'strengthening';
  if (value < 0) return 'weakening';
  return 'unchanged';
}

function nbsPublicationTime(html) {
  const value = metaContent(html, 'PubDate');
  const match = requireMatch(value, /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/, 'NBS_PUBLICATION_TIME');
  return {
    value: new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]) - 8,
      Number(match[5]),
    )).toISOString(),
    precision: 'instant',
  };
}

function safePublicationTime(html) {
  const value = metaContent(html, 'PubDate');
  requireMatch(value, /^\d{4}-\d{2}-\d{2}$/, 'SAFE_PUBLICATION_TIME');
  return { value, precision: 'day' };
}

function englishMonthPeriod(title) {
  const monthNames = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const match = requireMatch(title, /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i, 'OBSERVATION_PERIOD');
  return `${match[2]}-${String(monthNames[match[1].toLowerCase()]).padStart(2, '0')}`;
}

function chineseMonthPeriod(value) {
  const match = requireMatch(value, /(\d{4})年(\d{1,2})月/, 'OBSERVATION_PERIOD');
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
}

function known(value) {
  return { status: 'known', value };
}

function unknown(reason) {
  return { status: 'unknown', reason };
}

function notApplicable(reason) {
  return { status: 'not_applicable', reason };
}

function buildProvenance(observation, revision) {
  const publisher = PUBLISHERS[observation.publisherKey];
  const vintageId = `${observation.seriesId}:${observation.observationPeriod}:v${revision.sequence}`;
  const signalId = `signal:${vintageId}`;
  return {
    contractVersion: CONTRACT_VERSION,
    signalId,
    familyId: CHINA_MACRO_PROVENANCE_FAMILY,
    claims: {
      publisher: known({
        id: publisher.id,
        name: publisher.name,
        type: 'official_government',
        registryReference: {
          sourceName: publisher.sourceName,
          sourceType: 'gov',
          propagandaRisk: 'high',
        },
      }),
      source_url: known(observation.sourceUrl),
      original_reference: known({
        kind: 'observation',
        id: vintageId,
        contentHash: observation.contentHash,
      }),
      original_language: known(observation.originalLanguage),
      translation: notApplicable('The normalized signal is numeric and carries no translated text.'),
      observation_time: known({
        role: 'observation',
        value: observation.observationPeriod,
        precision: 'month',
      }),
      effective_time: unknown('The release does not declare a separate effective date.'),
      publication_time: known({
        role: 'publication',
        value: observation.releaseTime,
        precision: observation.releasePrecision,
      }),
      retrieval_time: known({
        role: 'retrieval',
        value: observation.retrievalTime,
        precision: 'instant',
      }),
      revision: known({
        vintageId,
        sequence: revision.sequence,
        state: revision.state,
      }),
      supersession: known({ state: 'current' }),
      extraction_confidence: known({
        score: observation.extractionConfidence,
        method: 'reviewed-release-regex/v1',
      }),
      classification_confidence: notApplicable('The canonical series identity is configured rather than inferred.'),
      corroboration: unknown('No independent comparison has been performed.'),
      transport_freshness: known({
        state: 'fresh',
        assessedAt: observation.retrievalTime,
        lastSuccessAt: observation.retrievalTime,
      }),
      content_freshness: known({
        state: observation.stale ? 'stale' : 'current',
        assessedAt: observation.retrievalTime,
        contentAsOf: observation.observationPeriod,
      }),
      derivation: notApplicable('This is a source observation, not a computed output.'),
    },
  };
}

function supersedeVintage(vintage, relatedSignalId) {
  const cloned = structuredClone(vintage);
  if (isRecord(cloned.provenance?.claims?.supersession)) {
    cloned.provenance.claims.supersession = known({
      state: 'superseded',
      relatedSignalId,
      reason: 'A later official release changed the same series and observation period.',
    });
  }
  cloned.supersededBy = relatedSignalId;
  return cloned;
}

function vintageFromObservation(observation) {
  return {
    seriesId: observation.seriesId,
    vintageId: observation.vintageId,
    sequence: observation.revisionSequence,
    state: observation.revisionState,
    value: observation.value,
    observationPeriod: observation.observationPeriod,
    periodKind: observation.periodKind,
    releaseTime: observation.releaseTime,
    retrievalTime: observation.retrievalTime,
    sourceUrl: observation.sourceUrl,
    supersededBy: '',
    semanticFingerprint: observation.semanticFingerprint,
    provenance: observation.provenance,
  };
}

function completeObservation(base, previousObservation) {
  const previous = isRecord(previousObservation)
    && previousObservation.seriesId === base.seriesId
    ? previousObservation
    : null;
  const priorVintages = Array.isArray(previous?.vintages)
    ? structuredClone(previous.vintages)
    : (previous ? [vintageFromObservation(previous)] : []);
  const nextBase = {
    ...base,
    semanticFingerprint: semanticFingerprint(base),
  };
  const periodVintages = priorVintages
    .map((vintage, index) => ({ vintage, index }))
    .filter(({ vintage }) => vintage.observationPeriod === base.observationPeriod)
    .sort((left, right) => Number(left.vintage.sequence) - Number(right.vintage.sequence));
  const latestPeriod = periodVintages.at(-1);
  const sameContent = latestPeriod?.vintage.semanticFingerprint === nextBase.semanticFingerprint;
  const revisionSequence = latestPeriod
    ? Math.max(1, Number(latestPeriod.vintage.sequence) || 1) + (sameContent ? 0 : 1)
    : 1;
  const marker = revisionMarker(base.releaseTitle);
  const revisionState = sameContent
    ? String(latestPeriod?.vintage.state || marker)
    : latestPeriod
      ? (marker === 'corrected' ? 'corrected' : 'revised')
      : marker === 'corrected' || marker === 'revised'
        ? 'original'
        : marker;
  const observation = {
    ...nextBase,
    revisionState,
    revisionSequence,
  };
  observation.provenance = buildProvenance(observation, {
    sequence: revisionSequence,
    state: revisionState,
  });
  observation.vintageId = observation.provenance.claims.revision.value.vintageId;

  if (sameContent && latestPeriod) {
    const currentIndex = latestPeriod.index;
    const refreshed = vintageFromObservation(observation);
    priorVintages[currentIndex] = refreshed;
  } else {
    if (latestPeriod) {
      priorVintages[latestPeriod.index] = supersedeVintage(
        priorVintages[latestPeriod.index],
        observation.provenance.signalId,
      );
    }
    priorVintages.push(vintageFromObservation(observation));
  }
  const vintages = priorVintages.slice(-MAX_VINTAGES_PER_SERIES);
  if (previous && previous.observationPeriod > observation.observationPeriod) {
    return markRetainedTransport({
      ...structuredClone(previous),
      vintages,
    }, base.retrievalTime, {
      state: 'fresh',
      failureReason: '',
    });
  }
  observation.vintages = vintages;
  return observation;
}

function baseObservation(definition, parsed, html, options) {
  const retrievalTime = options?.retrievalTime || new Date().toISOString();
  const observedAt = chinaMacroObservationDateMs(parsed.observationPeriod);
  const publishedAt = Date.parse(parsed.publication.value);
  const retrievedAt = Date.parse(retrievalTime);
  if (
    observedAt == null
    || !Number.isFinite(publishedAt)
    || !Number.isFinite(retrievedAt)
    || observedAt > publishedAt
    || publishedAt > retrievedAt
  ) {
    throw new Error('MALFORMED_RELEASE:TEMPORAL_ORDER');
  }
  const stale = isChinaMacroObservationStale(
    definition.seriesId,
    parsed.observationPeriod,
    retrievedAt,
  );
  return completeObservation({
    ...definition,
    geography: 'CN',
    seasonalAdjustment: definition.seasonalAdjustment || 'not_seasonally_adjusted',
    value: parsed.value,
    comparisonValue: parsed.comparisonValue,
    comparisonBasis: parsed.comparisonBasis,
    observationPeriod: parsed.observationPeriod,
    releaseTime: parsed.publication.value,
    releasePrecision: parsed.publication.precision,
    retrievalTime,
    direction: directionFromChange(parsed.comparisonValue),
    directionReason: parsed.directionReason,
    transportStatus: 'fresh',
    transportFailureReason: '',
    stale,
    unavailableReason: stale ? 'STALE_OBSERVATION' : '',
    sourceUrl: options?.sourceUrl || definition.defaultSourceUrl,
    releaseTitle: parsed.releaseTitle,
    contentHash: contentHash(html),
  }, options?.previousObservation);
}

export function parseNbsIndustrialRelease(html, options = {}) {
  const releaseTitle = metaContent(html, 'ArticleTitle');
  const text = stripHtml(html);
  const match = requireMatch(
    text,
    /total value added of industrial enterprises above the designated size\s+(increased|decreased) by\s+([\d.]+)%\s+year on year/i,
    'NBS_INDUSTRIAL_VALUE_ADDED',
  );
  const value = signedValue(match[1], match[2]);
  return baseObservation({
    seriesId: 'nbs_industrial_value_added_yoy',
    label: 'Industrial Value Added (YoY)',
    pillar: 'activity',
    unit: '%',
    periodKind: 'month',
    source: PUBLISHERS.nbs.name,
    defaultSourceUrl: 'https://www.stats.gov.cn/english/PressRelease/',
    publisherKey: 'nbs',
    originalLanguage: 'en',
    extractionConfidence: 0.98,
  }, {
    value,
    comparisonValue: value,
    comparisonBasis: 'year_over_year',
    directionReason: value > 0 ? 'POSITIVE_YEAR_OVER_YEAR_CHANGE' : value < 0 ? 'NEGATIVE_YEAR_OVER_YEAR_CHANGE' : 'ZERO_YEAR_OVER_YEAR_CHANGE',
    observationPeriod: englishMonthPeriod(releaseTitle),
    publication: nbsPublicationTime(html),
    releaseTitle,
  }, html, options);
}

export function parseNbsFaiRelease(html, options = {}) {
  const releaseTitle = metaContent(html, 'ArticleTitle');
  const text = stripHtml(html);
  const match = requireMatch(
    text,
    /national investment in fixed assets \(excluding rural households\).*?year-on-year (increase|decrease) of\s+([\d.]+)%/i,
    'NBS_FIXED_ASSET_INVESTMENT',
  );
  const value = signedValue(match[1], match[2]);
  return baseObservation({
    seriesId: 'nbs_fixed_asset_investment_yoy',
    label: 'Fixed-Asset Investment (YoY)',
    pillar: 'investment_property',
    unit: '%',
    periodKind: 'cumulative_year',
    source: PUBLISHERS.nbs.name,
    defaultSourceUrl: 'https://www.stats.gov.cn/english/PressRelease/',
    publisherKey: 'nbs',
    originalLanguage: 'en',
    extractionConfidence: 0.98,
  }, {
    value,
    comparisonValue: value,
    comparisonBasis: 'year_over_year',
    directionReason: value > 0 ? 'POSITIVE_YEAR_OVER_YEAR_CHANGE' : value < 0 ? 'NEGATIVE_YEAR_OVER_YEAR_CHANGE' : 'ZERO_YEAR_OVER_YEAR_CHANGE',
    observationPeriod: englishMonthPeriod(releaseTitle),
    publication: nbsPublicationTime(html),
    releaseTitle,
  }, html, options);
}

export function parseNbsPropertyRelease(html, options = {}) {
  const releaseTitle = metaContent(html, 'ArticleTitle');
  const text = stripHtml(html);
  const match = requireMatch(
    text,
    /investment in real estate development.*?year-on-year (increase|decrease) of\s+([\d.]+)%/i,
    'NBS_REAL_ESTATE_INVESTMENT',
  );
  const value = signedValue(match[1], match[2]);
  return baseObservation({
    seriesId: 'nbs_real_estate_investment_yoy',
    label: 'Real Estate Development Investment (YoY)',
    pillar: 'investment_property',
    unit: '%',
    periodKind: 'cumulative_year',
    source: PUBLISHERS.nbs.name,
    defaultSourceUrl: 'https://www.stats.gov.cn/english/PressRelease/',
    publisherKey: 'nbs',
    originalLanguage: 'en',
    extractionConfidence: 0.98,
  }, {
    value,
    comparisonValue: value,
    comparisonBasis: 'year_over_year',
    directionReason: value > 0 ? 'POSITIVE_YEAR_OVER_YEAR_CHANGE' : value < 0 ? 'NEGATIVE_YEAR_OVER_YEAR_CHANGE' : 'ZERO_YEAR_OVER_YEAR_CHANGE',
    observationPeriod: englishMonthPeriod(releaseTitle),
    publication: nbsPublicationTime(html),
    releaseTitle,
  }, html, options);
}

export function parseSafeReserveRelease(html, options = {}) {
  const releaseTitle = metaContent(html, 'ArticleTitle');
  const description = metaContent(html, 'Description');
  const valueMatch = requireMatch(description, /外汇储备规模为\s*([\d.]+)\s*亿美元/, 'SAFE_FX_RESERVES');
  const changeMatch = requireMatch(description, /(?:降幅|升幅)为\s*([\d.]+)%/, 'SAFE_FX_RESERVES_CHANGE');
  const change = /下降|降幅/.test(description) ? -Number(changeMatch[1]) : Number(changeMatch[1]);
  return baseObservation({
    seriesId: 'safe_fx_reserves',
    label: 'Foreign-Exchange Reserves',
    pillar: 'external_pressure',
    unit: 'USD 100 million',
    periodKind: 'point_in_time',
    source: PUBLISHERS.safe.name,
    defaultSourceUrl: SAFE_LIST_URL,
    publisherKey: 'safe',
    originalLanguage: 'zh-CN',
    extractionConfidence: 0.99,
  }, {
    value: Number(valueMatch[1]),
    comparisonValue: change,
    comparisonBasis: 'month_over_month_percent_change',
    directionReason: change > 0 ? 'RESERVES_INCREASED' : change < 0 ? 'RESERVES_DECREASED' : 'RESERVES_UNCHANGED',
    observationPeriod: chineseMonthPeriod(`${releaseTitle} ${description}`),
    publication: safePublicationTime(html),
    releaseTitle,
  }, html, options);
}

export function parseSafeSettlementRelease(html, options = {}) {
  const releaseTitle = metaContent(html, 'ArticleTitle');
  const description = metaContent(html, 'Description');
  const match = requireMatch(
    description,
    /(\d{4})年(\d{1,2})月，银行结汇\s*([\d.]+)\s*亿元人民币，售汇\s*([\d.]+)\s*亿元人民币/,
    'SAFE_BANK_SETTLEMENT',
  );
  const settlement = Number(match[3]);
  return baseObservation({
    seriesId: 'safe_bank_fx_settlement',
    label: 'Bank FX Settlement',
    pillar: 'external_pressure',
    unit: 'CNY 100 million',
    periodKind: 'month',
    source: PUBLISHERS.safe.name,
    defaultSourceUrl: SAFE_LIST_URL,
    publisherKey: 'safe',
    originalLanguage: 'zh-CN',
    extractionConfidence: 0.99,
  }, {
    value: settlement,
    comparisonValue: null,
    comparisonBasis: 'not_available',
    directionReason: 'NO_COMPARABLE_OFFICIAL_PRIOR_PERIOD',
    observationPeriod: `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`,
    publication: safePublicationTime(html),
    releaseTitle,
  }, html, options);
}

function unavailableObservation(definition, reason) {
  return {
    ...definition,
    geography: 'CN',
    seasonalAdjustment: 'unknown',
    value: null,
    comparisonValue: null,
    comparisonBasis: '',
    observationPeriod: '',
    releaseTime: '',
    releasePrecision: '',
    retrievalTime: '',
    direction: 'unavailable',
    directionReason: reason,
    transportStatus: 'blocked',
    transportFailureReason: reason,
    stale: false,
    unavailableReason: reason,
    revisionState: 'unavailable',
    vintageId: '',
    revisionSequence: 0,
    provenance: null,
    vintages: [],
  };
}

function markRetainedTransport(previousObservation, checkedAt, {
  state,
  failureReason,
}) {
  const observation = structuredClone(previousObservation);
  const previousLastSuccessAt = observation.provenance
    ?.claims?.transport_freshness?.value?.lastSuccessAt;
  const lastSuccessAt = state === 'fresh'
    ? checkedAt
    : typeof previousLastSuccessAt === 'string' && previousLastSuccessAt
      ? previousLastSuccessAt
      : observation.retrievalTime;
  const stale = isChinaMacroObservationStale(
    observation.seriesId,
    observation.observationPeriod,
    Date.parse(checkedAt),
  );
  observation.stale = stale;
  observation.unavailableReason = stale ? 'STALE_OBSERVATION' : '';
  observation.transportStatus = state;
  observation.transportFailureReason = failureReason;
  if (stale) {
    observation.direction = 'unavailable';
    observation.directionReason = 'STALE_OBSERVATION';
  }

  const updateFreshness = (provenance) => {
    if (!isRecord(provenance?.claims)) return;
    provenance.claims.transport_freshness = known({
      state,
      assessedAt: checkedAt,
      lastSuccessAt,
    });
    provenance.claims.content_freshness = known({
      state: stale ? 'stale' : 'current',
      assessedAt: checkedAt,
      contentAsOf: observation.observationPeriod,
    });
  };

  updateFreshness(observation.provenance);
  const currentVintage = Array.isArray(observation.vintages)
    ? observation.vintages.find((vintage) => vintage.vintageId === observation.vintageId)
    : null;
  if (currentVintage) updateFreshness(currentVintage.provenance);
  return observation;
}

function preserveFailedRequiredSource({
  source,
  error,
  seriesIds,
  previousById,
  checkedAt,
}) {
  if (!error) return [];
  const previous = seriesIds.map((seriesId) => previousById.get(seriesId));
  const canPreserve = previous.every((observation) => (
    isRecord(observation)
    && Number.isFinite(observation.value)
    && isRecord(observation.provenance)
    && observation.provenance.familyId === CHINA_MACRO_PROVENANCE_FAMILY
  ));
  if (!canPreserve) throw requiredSourceError(source, error);
  const reason = reasonFor(error);
  return previous.map((observation) => (
    markRetainedTransport(observation, checkedAt, {
      state: 'error',
      failureReason: reason,
    })
  ));
}

function sourceDecision({
  publisherId,
  source,
  host,
  status,
  reason,
  checkedAt,
  redirectBehavior,
  requestBudget,
  requestCount,
  robotsStatus,
  termsStatus,
  sourceUrl,
}) {
  return {
    publisherId,
    source,
    host,
    status,
    reason,
    checkedAt,
    redirectBehavior,
    requestBudget,
    requestCount,
    robotsStatus,
    termsStatus,
    sourceUrl,
  };
}

function requiredSourceError(source, error) {
  const reason = reasonFor(error);
  const wrapped = new Error(`${source}_REQUIRED_SOURCE_UNAVAILABLE:${reason}`);
  wrapped.nonRetryable = true;
  return wrapped;
}

export async function fetchChinaMacroSnapshot({
  now = Date.now(),
  fetchFn = globalThis.fetch,
  readCachedFn = readCanonicalValue,
  onDecision = (entry) => console.log(JSON.stringify({
    event: 'china_macro_source_preflight',
    ...entry,
  })),
} = {}) {
  const checkedAt = new Date(now).toISOString();
  let previousSnapshot = null;
  try {
    previousSnapshot = await readCachedFn(CHINA_MACRO_CACHE_KEY);
  } catch {
    previousSnapshot = null;
  }
  const previousById = new Map(
    (Array.isArray(previousSnapshot?.observations) ? previousSnapshot.observations : [])
      .map((observation) => [observation.seriesId, observation]),
  );
  const decisions = [];
  const record = (entry) => {
    decisions.push(entry);
    onDecision(entry);
  };
  const observations = [];
  const nbsDecisionBase = Object.freeze({
    publisherId: CHINA_MACRO_PUBLISHER_IDS.nbs,
    source: PUBLISHERS.nbs.name,
    host: 'www.stats.gov.cn',
    checkedAt,
    requestBudget: NBS_MAX_REQUESTS_PER_RUN,
    termsStatus: 'reviewed_2026-07-25_attribution_required',
    sourceUrl: NBS_LIST_URL,
  });
  const safeDecisionBase = Object.freeze({
    publisherId: CHINA_MACRO_PUBLISHER_IDS.safe,
    source: PUBLISHERS.safe.name,
    host: 'www.safe.gov.cn',
    checkedAt,
    requestBudget: SAFE_MAX_REQUESTS_PER_RUN,
    termsStatus: 'reviewed_2026-07-25_facts_only_attribution_required',
    sourceUrl: SAFE_LIST_URL,
  });

  const nbsBudget = requestBudget(NBS_MAX_REQUESTS_PER_RUN);
  let nbsRedirectBehavior = 'none';
  let nbsRobotsStatus = 'unknown';
  let nbsError = null;
  try {
    const robots = await checkRobots(fetchFn, NBS_ROBOTS_URL, {
      policy: SOURCE_POLICIES.nbsRobots,
      budget: nbsBudget,
      candidatePaths: [new URL(NBS_LIST_URL).pathname],
      onRedirect: (state) => { nbsRedirectBehavior = state; },
    });
    nbsRobotsStatus = robots.status;
    const listing = await fetchText(fetchFn, NBS_LIST_URL, {
      policy: SOURCE_POLICIES.nbs,
      budget: nbsBudget,
      assertTargetAllowed: (url) => assertRobotsAllowed(robots.text, [url.pathname]),
      onRedirect: (state) => { nbsRedirectBehavior = state; },
    });
    const industrialUrl = findReleaseUrl(
      listing.text,
      listing.url,
      /Industrial Production Operation/i,
      'NBS_INDUSTRIAL',
      SOURCE_POLICIES.nbs,
    );
    const fixedAssetUrl = findReleaseUrl(
      listing.text,
      listing.url,
      /Investment in Fixed Assets/i,
      'NBS_FIXED_ASSET',
      SOURCE_POLICIES.nbs,
    );
    const propertyUrl = findReleaseUrl(
      listing.text,
      listing.url,
      /Investment in Real Estate Development/i,
      'NBS_PROPERTY',
      SOURCE_POLICIES.nbs,
    );
    assertRobotsAllowed(robots.text, [industrialUrl, fixedAssetUrl, propertyUrl].map(
      (url) => new URL(url).pathname,
    ));
    const pages = [];
    for (const url of [industrialUrl, fixedAssetUrl, propertyUrl]) {
      const page = await fetchText(fetchFn, url, {
        policy: SOURCE_POLICIES.nbs,
        budget: nbsBudget,
        assertTargetAllowed: (target) => assertRobotsAllowed(robots.text, [target.pathname]),
        onRedirect: (state) => { nbsRedirectBehavior = state; },
      });
      pages.push(page);
    }
    observations.push(
      parseNbsIndustrialRelease(pages[0].text, {
        retrievalTime: checkedAt,
        sourceUrl: pages[0].url,
        previousObservation: previousById.get('nbs_industrial_value_added_yoy'),
      }),
      parseNbsFaiRelease(pages[1].text, {
        retrievalTime: checkedAt,
        sourceUrl: pages[1].url,
        previousObservation: previousById.get('nbs_fixed_asset_investment_yoy'),
      }),
      parseNbsPropertyRelease(pages[2].text, {
        retrievalTime: checkedAt,
        sourceUrl: pages[2].url,
        previousObservation: previousById.get('nbs_real_estate_investment_yoy'),
      }),
    );
    record(sourceDecision({
      ...nbsDecisionBase,
      robotsStatus: nbsRobotsStatus,
      status: 'accepted',
      reason: 'OK',
      redirectBehavior: nbsRedirectBehavior,
      requestCount: nbsBudget.count,
      sourceUrl: listing.url,
    }));
  } catch (error) {
    nbsError = error;
    if (nbsRobotsStatus === 'unknown') nbsRobotsStatus = 'unavailable';
    record(sourceDecision({
      ...nbsDecisionBase,
      robotsStatus: nbsRobotsStatus,
      status: 'blocked',
      reason: reasonFor(error),
      redirectBehavior: nbsRedirectBehavior,
      requestCount: nbsBudget.count,
    }));
  }

  const safeBudget = requestBudget(SAFE_MAX_REQUESTS_PER_RUN);
  let safeRedirectBehavior = 'none';
  let safeRobotsStatus = 'unknown';
  let safeError = null;
  try {
    const robots = await checkRobots(fetchFn, SAFE_ROBOTS_URL, {
      policy: SOURCE_POLICIES.safeRobots,
      budget: safeBudget,
      candidatePaths: [new URL(SAFE_LIST_URL).pathname],
      onRedirect: (state) => { safeRedirectBehavior = state; },
    });
    safeRobotsStatus = robots.status;
    const listing = await fetchText(fetchFn, SAFE_LIST_URL, {
      policy: SOURCE_POLICIES.safe,
      budget: safeBudget,
      assertTargetAllowed: (url) => assertRobotsAllowed(robots.text, [url.pathname]),
      onRedirect: (state) => { safeRedirectBehavior = state; },
    });
    const reserveUrl = findReleaseUrl(
      listing.text,
      listing.url,
      /外汇储备规模数据/,
      'SAFE_RESERVES',
      SOURCE_POLICIES.safe,
    );
    const settlementUrl = findReleaseUrl(
      listing.text,
      listing.url,
      /银行结售汇/,
      'SAFE_SETTLEMENT',
      SOURCE_POLICIES.safe,
    );
    assertRobotsAllowed(robots.text, [reserveUrl, settlementUrl].map(
      (url) => new URL(url).pathname,
    ));
    const pages = [];
    for (const url of [reserveUrl, settlementUrl]) {
      const page = await fetchText(fetchFn, url, {
        policy: SOURCE_POLICIES.safe,
        budget: safeBudget,
        assertTargetAllowed: (target) => assertRobotsAllowed(robots.text, [target.pathname]),
        onRedirect: (state) => { safeRedirectBehavior = state; },
      });
      pages.push(page);
    }
    observations.push(
      parseSafeReserveRelease(pages[0].text, {
        retrievalTime: checkedAt,
        sourceUrl: pages[0].url,
        previousObservation: previousById.get('safe_fx_reserves'),
      }),
      parseSafeSettlementRelease(pages[1].text, {
        retrievalTime: checkedAt,
        sourceUrl: pages[1].url,
        previousObservation: previousById.get('safe_bank_fx_settlement'),
      }),
    );
    record(sourceDecision({
      ...safeDecisionBase,
      robotsStatus: safeRobotsStatus,
      status: 'accepted',
      reason: 'OK',
      redirectBehavior: safeRedirectBehavior,
      requestCount: safeBudget.count,
      sourceUrl: listing.url,
    }));
  } catch (error) {
    safeError = error;
    if (safeRobotsStatus === 'unknown') safeRobotsStatus = 'unavailable';
    record(sourceDecision({
      ...safeDecisionBase,
      robotsStatus: safeRobotsStatus,
      status: 'blocked',
      reason: reasonFor(error),
      redirectBehavior: safeRedirectBehavior,
      requestCount: safeBudget.count,
    }));
  }

  let pbocReason = 'SOURCE_CONTRACT_NOT_LAUNCHED';
  let pbocRobotsStatus = 'unknown';
  const pbocBudget = requestBudget(PBOC_MAX_REQUESTS_PER_RUN);
  let pbocRedirectBehavior = 'none';
  try {
    const robots = await fetchText(fetchFn, PBOC_ROBOTS_URL, {
      policy: SOURCE_POLICIES.pboc,
      budget: pbocBudget,
      onRedirect: (state) => { pbocRedirectBehavior = state; },
    });
    if (robotsDisallowAll(robots.text)) {
      pbocReason = 'ROBOTS_DISALLOW';
      pbocRobotsStatus = 'disallow_all';
    } else {
      pbocRobotsStatus = 'allows_candidate_paths';
    }
  } catch (error) {
    pbocReason = reasonFor(error);
    pbocRobotsStatus = 'unavailable';
  }
  record(sourceDecision({
    publisherId: CHINA_MACRO_PUBLISHER_IDS.pboc,
    source: 'People’s Bank of China',
    host: 'www.pbc.gov.cn',
    status: 'blocked',
    reason: pbocReason,
    checkedAt,
    redirectBehavior: pbocRedirectBehavior,
    requestBudget: PBOC_MAX_REQUESTS_PER_RUN,
    requestCount: pbocBudget.count,
    robotsStatus: pbocRobotsStatus,
    termsStatus: pbocReason === 'ROBOTS_DISALLOW' ? 'not_evaluated_robots_blocked' : 'review_required',
    sourceUrl: 'https://www.pbc.gov.cn/',
  }));
  observations.push(
    ...UNAVAILABLE_DEFINITIONS
      .filter((definition) => definition.seriesId.startsWith('pboc_'))
      .map((definition) => unavailableObservation(definition, pbocReason)),
  );

  let gaccReason = 'SOURCE_CONTRACT_NOT_LAUNCHED';
  let gaccRobotsStatus = 'unknown';
  const gaccBudget = requestBudget(GACC_MAX_REQUESTS_PER_RUN);
  let gaccRedirectBehavior = 'none';
  try {
    const robots = await fetchText(fetchFn, GACC_ROBOTS_URL, {
      policy: SOURCE_POLICIES.gacc,
      budget: gaccBudget,
      onRedirect: (state) => { gaccRedirectBehavior = state; },
    });
    gaccRobotsStatus = robotsDisallowAll(robots.text) ? 'disallow_all' : 'no_disallow_all_rule';
    if (gaccRobotsStatus === 'disallow_all') gaccReason = 'ROBOTS_DISALLOW';
  } catch (error) {
    gaccReason = reasonFor(error);
    gaccRobotsStatus = gaccReason === 'TLS_CERTIFICATE_ERROR' ? 'unavailable_tls' : 'unavailable';
  }
  record(sourceDecision({
    publisherId: CHINA_MACRO_PUBLISHER_IDS.gacc,
    source: 'General Administration of Customs of China',
    host: 'english.customs.gov.cn',
    status: 'blocked',
    reason: gaccReason,
    checkedAt,
    redirectBehavior: gaccRedirectBehavior,
    requestBudget: GACC_MAX_REQUESTS_PER_RUN,
    requestCount: gaccBudget.count,
    robotsStatus: gaccRobotsStatus,
    termsStatus: 'reviewed_all_rights_reserved_chinese_authoritative',
    sourceUrl: 'https://english.customs.gov.cn/',
  }));
  observations.push(
    ...UNAVAILABLE_DEFINITIONS
      .filter((definition) => definition.seriesId.startsWith('gacc_'))
      .map((definition) => unavailableObservation(definition, gaccReason)),
  );

  observations.push(
    ...preserveFailedRequiredSource({
      source: 'NBS',
      error: nbsError,
      seriesIds: CHINA_MACRO_REQUIRED_SERIES.filter((seriesId) => seriesId.startsWith('nbs_')),
      previousById,
      checkedAt,
    }),
    ...preserveFailedRequiredSource({
      source: 'SAFE',
      error: safeError,
      seriesIds: CHINA_MACRO_REQUIRED_SERIES.filter((seriesId) => seriesId.startsWith('safe_')),
      previousById,
      checkedAt,
    }),
  );

  return buildChinaMacroSnapshot({
    observations,
    sourceDecisions: decisions,
    generatedAt: checkedAt,
  });
}
