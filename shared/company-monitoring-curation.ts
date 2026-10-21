// Private/offline public-evidence curation contracts for Company Monitoring.
//
// Raw identities, URLs, excerpts, and labels are inputs only. The compiler emits
// the opaque artifacts accepted by company-monitoring-blind-evaluation.ts and
// never performs network access or persistence.
import { createHash } from 'node:crypto';
import {
  OPAQUE_EXAMPLE_ID,
  canonicalJson,
  hasExactKeys,
  type JsonObject,
} from './company-monitoring-evaluation.ts';
import type {
  BlindCorpus,
  GoldLabelSet,
} from './company-monitoring-blind-evaluation.ts';

export type CompanyMonitoringGeography = 'US' | 'GB';
export type CompanyMonitoringTimePrecision = 'day' | 'second';
export type CompanyMonitoringEvidenceAuthority =
  | 'official_company'
  | 'official_government'
  | 'verified_account'
  | 'sec'
  | 'companies_house'
  | 'fca'
  | 'rns'
  | 'regulator'
  | 'court'
  | 'recall'
  | 'independent_news'
  | 'trade_press';

export type CompanyMonitoringCurationSource = {
  sourceId: string;
  url: string;
  publisher: string;
  sourceOrigin: string;
  title: string;
  boundedExcerpt: string;
  publishedAt: string;
  publishedAtPrecision: CompanyMonitoringTimePrecision;
  observedAt: string;
  retrievedAt: string;
  evidenceAuthority: CompanyMonitoringEvidenceAuthority;
  syndication: {
    relationship: 'original' | 'independent' | 'syndicated';
    upstreamUrl: string | null;
    groupIdentity: string;
  };
};

export type CompanyMonitoringCurationCandidate = {
  candidateId: string;
  disposition: 'included' | 'excluded';
  exclusionReason: string | null;
  opaqueExampleId: string | null;
  company: {
    legalName: string;
    stableIdentity: string;
    corporateFamilyIdentity: string;
    officialDomains: string[];
    verifiedXAccountIds: string[];
    geography: CompanyMonitoringGeography;
    privateStatus: 'private' | 'private_subsidiary';
    privateStatusEvidence: {
      url: string;
      publisher: string;
      sourceOrigin: string;
      retrievedAt: string;
    };
  };
  occurrence: {
    stableIdentity: string;
    occurredAt: string;
    occurredAtPrecision: CompanyMonitoringTimePrecision;
    geography: CompanyMonitoringGeography;
  };
  primarySourceId: string;
  sources: CompanyMonitoringCurationSource[];
};

export type CompanyMonitoringCurationManifest = {
  schemaVersion: 'cm_public_evidence_curation_v1';
  collectionVersion: string;
  corpusVersion: string;
  purpose: BlindCorpus['purpose'];
  collectedAt: string;
  custody: {
    collectorTool: string;
    collectorModel: string;
    collectorRunId: string;
    storageClass: 'sealed_external';
    labelsVisibleToPolicyAuthors: false;
  };
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  classifierRuntimeSha256: string;
  queryVersion: string;
  curatorAccessVersion: string;
  candidates: CompanyMonitoringCurationCandidate[];
};

export type CompanyMonitoringGoldCurationManifest = {
  schemaVersion: 'cm_gold_curation_v1';
  corpusVersion: string;
  goldLabelVersion: string;
  curatorAccessVersion: string;
  labels: Array<{
    opaqueExampleId: string;
    publicationEligible: boolean;
    goldMateriality: 'material' | 'immaterial';
    goldDirection: 'positive' | 'negative' | 'mixed';
    customerUseful: boolean | null;
  }>;
};

export type CompanyMonitoringCurationSummary = {
  researchedCandidates: number;
  verifiedEvidenceBundles: number;
  geography: Record<CompanyMonitoringGeography, number>;
  evidenceAuthority: Partial<Record<CompanyMonitoringEvidenceAuthority, number>>;
  exclusions: Record<string, number>;
};

export class CompanyMonitoringCurationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CompanyMonitoringCurationError';
    this.code = code;
  }
}

const VERSION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TOKEN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_EXCERPT_LENGTH = 600;
const MAX_TITLE_LENGTH = 300;
const MAX_SOURCES_PER_CANDIDATE = 20;
const GEOGRAPHIES = new Set<CompanyMonitoringGeography>(['US', 'GB']);
const PURPOSES = new Set<BlindCorpus['purpose']>(['pilot', 'tracer_gate', 'stage3_gate']);
const AUTHORITIES = new Set<CompanyMonitoringEvidenceAuthority>([
  'official_company',
  'official_government',
  'verified_account',
  'sec',
  'companies_house',
  'fca',
  'rns',
  'regulator',
  'court',
  'recall',
  'independent_news',
  'trade_press',
]);

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'collectionVersion',
  'corpusVersion',
  'purpose',
  'collectedAt',
  'custody',
  'protocolVersion',
  'policyVersion',
  'modelVersion',
  'classifierRuntimeSha256',
  'queryVersion',
  'curatorAccessVersion',
  'candidates',
]);
const CUSTODY_KEYS = new Set([
  'collectorTool',
  'collectorModel',
  'collectorRunId',
  'storageClass',
  'labelsVisibleToPolicyAuthors',
]);
const CANDIDATE_KEYS = new Set([
  'candidateId',
  'disposition',
  'exclusionReason',
  'opaqueExampleId',
  'company',
  'occurrence',
  'primarySourceId',
  'sources',
]);
const COMPANY_KEYS = new Set([
  'legalName',
  'stableIdentity',
  'corporateFamilyIdentity',
  'officialDomains',
  'verifiedXAccountIds',
  'geography',
  'privateStatus',
  'privateStatusEvidence',
]);
const PRIVATE_STATUS_EVIDENCE_KEYS = new Set([
  'url',
  'publisher',
  'sourceOrigin',
  'retrievedAt',
]);
const OCCURRENCE_KEYS = new Set([
  'stableIdentity',
  'occurredAt',
  'occurredAtPrecision',
  'geography',
]);
const SOURCE_KEYS = new Set([
  'sourceId',
  'url',
  'publisher',
  'sourceOrigin',
  'title',
  'boundedExcerpt',
  'publishedAt',
  'publishedAtPrecision',
  'observedAt',
  'retrievedAt',
  'evidenceAuthority',
  'syndication',
]);
const SYNDICATION_KEYS = new Set([
  'relationship',
  'upstreamUrl',
  'groupIdentity',
]);
const GOLD_MANIFEST_KEYS = new Set([
  'schemaVersion',
  'corpusVersion',
  'goldLabelVersion',
  'curatorAccessVersion',
  'labels',
]);
const GOLD_LABEL_KEYS = new Set([
  'opaqueExampleId',
  'publicationEligible',
  'goldMateriality',
  'goldDirection',
  'customerUseful',
]);

function fail(code: string): never {
  throw new CompanyMonitoringCurationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: unknown, keys: Set<string>, code: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value as JsonObject, keys)) fail(code);
}

function requireText(value: unknown, code: string, maximumLength = 500): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(code);
  return value;
}

function requireVersion(value: unknown, code: string): string {
  const text = requireText(value, code, 200);
  if (!VERSION.test(text)) fail(code);
  return text;
}

function timestamp(value: unknown, code: string): number {
  const text = requireText(value, code, 100);
  if (!RFC3339.test(text)) fail(code);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function evidenceTimestamp(value: unknown, precision: unknown, code: string): number {
  if (precision === 'second') return timestamp(value, `${code}_invalid`);
  if (precision !== 'day') fail(`${code}_precision_invalid`);
  const text = requireText(value, `${code}_invalid`, 10);
  if (!CALENDAR_DATE.test(text)) fail(`${code}_invalid`);
  const parsed = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text) {
    fail(`${code}_invalid`);
  }
  return parsed;
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function normalizedContent(value: string): string {
  return normalizedIdentity(value).replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function evidenceDigest(dimension: string, value: string): string {
  const digest = sha256({
    version: 'cm_public_evidence_identity_v1',
    dimension,
    value: normalizedIdentity(value),
  });
  if (!SHA256.test(digest)) fail('curation_digest_invalid');
  return digest;
}

function sourceContentFingerprint(source: CompanyMonitoringCurationSource): string {
  return sha256({
    version: 'cm_public_evidence_content_v1',
    title: normalizedContent(source.title),
    excerpt: normalizedContent(source.boundedExcerpt),
  });
}

function normalizedOrigin(value: string, code: string): string {
  const text = requireText(value, code, 253).toLocaleLowerCase('en-US').replace(/^www\./, '');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(text) || !text.includes('.')) fail(code);
  return text;
}

function checkedUrl(value: unknown, code: string): URL {
  const text = requireText(value, code, 2_000);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(code);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) fail(code);
  return url;
}

function validateOriginMatchesUrl(url: URL, origin: unknown, code: string): string {
  const normalized = normalizedOrigin(String(origin ?? ''), code);
  const hostname = url.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '');
  if (hostname !== normalized) fail(code);
  return normalized;
}

function increment(target: Record<string, number>, key: string): void {
  const current = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
  target[key] = (current ?? 0) + 1;
}

type ValidatedCandidate = {
  candidate: CompanyMonitoringCurationCandidate;
  primarySource: CompanyMonitoringCurationSource | null;
};

function validatePrivateStatusEvidence(
  value: unknown,
  collectedAt: number,
): void {
  requireExactKeys(value, PRIVATE_STATUS_EVIDENCE_KEYS, 'private_status_evidence_schema_invalid');
  const url = checkedUrl(value.url, 'private_status_evidence_url_invalid');
  requireText(value.publisher, 'private_status_evidence_publisher_invalid');
  validateOriginMatchesUrl(url, value.sourceOrigin, 'private_status_evidence_origin_invalid');
  const retrievedAt = timestamp(value.retrievedAt, 'private_status_evidence_retrieved_at_invalid');
  if (retrievedAt > collectedAt) fail('private_status_evidence_retrieved_after_collection');
}

function validateSource(
  value: unknown,
  collectedAt: number,
): CompanyMonitoringCurationSource {
  requireExactKeys(value, SOURCE_KEYS, 'source_schema_invalid');
  requireText(value.sourceId, 'source_id_invalid', 200);
  const url = checkedUrl(value.url, 'source_url_invalid');
  requireText(value.publisher, 'source_publisher_invalid');
  validateOriginMatchesUrl(url, value.sourceOrigin, 'source_origin_invalid');
  requireText(value.title, 'source_title_invalid', MAX_TITLE_LENGTH);
  const excerpt = requireText(value.boundedExcerpt, 'source_excerpt_invalid', 10_000);
  if (excerpt.length > MAX_EXCERPT_LENGTH) fail('source_excerpt_too_long');
  if (!AUTHORITIES.has(value.evidenceAuthority as CompanyMonitoringEvidenceAuthority)) {
    fail('source_authority_invalid');
  }

  const publishedAt = evidenceTimestamp(
    value.publishedAt,
    value.publishedAtPrecision,
    'source_published_at',
  );
  const observedAt = timestamp(value.observedAt, 'source_observed_at_invalid');
  const retrievedAt = timestamp(value.retrievedAt, 'source_retrieved_at_invalid');
  if (observedAt > collectedAt) fail('source_observed_after_collection');
  if (retrievedAt > collectedAt) fail('source_retrieved_after_collection');
  if (publishedAt > observedAt) fail('source_published_after_observation');
  if (observedAt > retrievedAt) fail('source_observed_after_retrieval');

  requireExactKeys(value.syndication, SYNDICATION_KEYS, 'source_syndication_schema_invalid');
  const relationship = value.syndication.relationship;
  if (!['original', 'independent', 'syndicated'].includes(String(relationship))) {
    fail('source_syndication_relationship_invalid');
  }
  requireText(value.syndication.groupIdentity, 'source_syndication_group_invalid');
  if (relationship === 'syndicated') {
    if (value.syndication.upstreamUrl === null) fail('source_syndication_upstream_missing');
    checkedUrl(value.syndication.upstreamUrl, 'source_syndication_upstream_invalid');
  } else if (value.syndication.upstreamUrl !== null) {
    fail('source_syndication_upstream_unexpected');
  }

  return value as unknown as CompanyMonitoringCurationSource;
}

function validateCandidate(
  value: unknown,
  collectedAt: number,
): ValidatedCandidate {
  requireExactKeys(value, CANDIDATE_KEYS, 'curation_candidate_schema_invalid');
  requireText(value.candidateId, 'candidate_id_invalid', 200);
  if (value.disposition !== 'included' && value.disposition !== 'excluded') {
    fail('candidate_disposition_invalid');
  }
  if (value.disposition === 'included') {
    if (value.exclusionReason !== null) fail('candidate_exclusion_reason_unexpected');
    if (typeof value.opaqueExampleId !== 'string' || !OPAQUE_EXAMPLE_ID.test(value.opaqueExampleId)) {
      fail('candidate_opaque_id_invalid');
    }
  } else {
    if (value.opaqueExampleId !== null) fail('excluded_candidate_opaque_id_present');
    const reason = requireText(value.exclusionReason, 'candidate_exclusion_reason_invalid', 100);
    if (!TOKEN.test(reason)) fail('candidate_exclusion_reason_invalid');
  }

  requireExactKeys(value.company, COMPANY_KEYS, 'candidate_company_schema_invalid');
  requireText(value.company.legalName, 'company_legal_name_invalid');
  requireText(value.company.stableIdentity, 'company_identity_invalid');
  requireText(value.company.corporateFamilyIdentity, 'corporate_family_identity_invalid');
  if (!Array.isArray(value.company.officialDomains)) fail('company_official_domains_invalid');
  const officialDomains = value.company.officialDomains.map((domain) =>
    normalizedOrigin(String(domain), 'company_official_domains_invalid')
  );
  if (new Set(officialDomains).size !== officialDomains.length) {
    fail('company_official_domains_invalid');
  }
  if (!Array.isArray(value.company.verifiedXAccountIds)) fail('company_x_accounts_invalid');
  const verifiedXAccountIds = value.company.verifiedXAccountIds.map((accountId) =>
    requireText(accountId, 'company_x_accounts_invalid', 20)
  );
  if (
    verifiedXAccountIds.some((accountId) => !/^\d{1,20}$/.test(accountId)) ||
    new Set(verifiedXAccountIds).size !== verifiedXAccountIds.length
  ) fail('company_x_accounts_invalid');
  if (!GEOGRAPHIES.has(value.company.geography as CompanyMonitoringGeography)) {
    fail('company_geography_invalid');
  }
  if (value.company.privateStatus !== 'private' && value.company.privateStatus !== 'private_subsidiary') {
    fail('company_private_status_invalid');
  }
  validatePrivateStatusEvidence(value.company.privateStatusEvidence, collectedAt);

  requireExactKeys(value.occurrence, OCCURRENCE_KEYS, 'candidate_occurrence_schema_invalid');
  requireText(value.occurrence.stableIdentity, 'occurrence_identity_invalid');
  const occurredAt = evidenceTimestamp(
    value.occurrence.occurredAt,
    value.occurrence.occurredAtPrecision,
    'occurrence_timestamp',
  );
  if (occurredAt > collectedAt) fail('occurrence_after_collection');
  if (!GEOGRAPHIES.has(value.occurrence.geography as CompanyMonitoringGeography)) {
    fail('occurrence_geography_invalid');
  }
  if (value.occurrence.geography !== value.company.geography) {
    fail('candidate_geography_mismatch');
  }

  if (!Array.isArray(value.sources)) fail('candidate_sources_invalid');
  if (
    (value.disposition === 'included' && value.sources.length === 0)
    || value.sources.length > MAX_SOURCES_PER_CANDIDATE
  ) fail('candidate_sources_invalid');
  const sources = value.sources.map((source) => validateSource(source, collectedAt));
  const sourceIds = new Set<string>();
  const sourceUrls = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) fail('candidate_duplicate_source_id');
    sourceIds.add(source.sourceId);
    const canonicalUrl = new URL(source.url).href;
    if (sourceUrls.has(canonicalUrl)) fail('candidate_duplicate_source_url');
    sourceUrls.add(canonicalUrl);
  }
  requireText(value.primarySourceId, 'candidate_primary_source_id_invalid', 200);
  const primarySource = sources.find((source) => source.sourceId === value.primarySourceId);
  if (value.disposition === 'included' && !primarySource) fail('candidate_primary_source_missing');

  return {
    candidate: value as unknown as CompanyMonitoringCurationCandidate,
    primarySource: primarySource ?? sources[0] ?? null,
  };
}

function validateManifest(
  value: unknown,
): {
  manifest: CompanyMonitoringCurationManifest;
  included: Array<ValidatedCandidate & { primarySource: CompanyMonitoringCurationSource }>;
} {
  requireExactKeys(value, MANIFEST_KEYS, 'curation_manifest_schema_invalid');
  if (value.schemaVersion !== 'cm_public_evidence_curation_v1') fail('curation_schema_version_invalid');
  requireVersion(value.collectionVersion, 'curation_collection_version_invalid');
  requireVersion(value.corpusVersion, 'curation_corpus_version_invalid');
  if (!PURPOSES.has(value.purpose as BlindCorpus['purpose'])) fail('curation_purpose_invalid');
  const collectedAt = timestamp(value.collectedAt, 'curation_collected_at_invalid');
  for (const [field, code] of [
    ['protocolVersion', 'curation_protocol_version_invalid'],
    ['policyVersion', 'curation_policy_version_invalid'],
    ['modelVersion', 'curation_model_version_invalid'],
    ['queryVersion', 'curation_query_version_invalid'],
    ['curatorAccessVersion', 'curation_access_version_invalid'],
  ] as const) requireVersion(value[field], code);
  if (!SHA256.test(value.classifierRuntimeSha256 as string)) {
    fail('curation_classifier_runtime_digest_invalid');
  }

  requireExactKeys(value.custody, CUSTODY_KEYS, 'curation_custody_schema_invalid');
  requireText(value.custody.collectorTool, 'curation_collector_tool_invalid', 200);
  requireText(value.custody.collectorModel, 'curation_collector_model_invalid', 200);
  requireText(value.custody.collectorRunId, 'curation_collector_run_invalid', 200);
  if (value.custody.storageClass !== 'sealed_external') fail('curation_storage_class_invalid');
  if (value.custody.labelsVisibleToPolicyAuthors !== false) fail('curation_blind_boundary_invalid');

  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    fail('curation_candidates_invalid');
  }
  const validated = value.candidates.map((candidate) => validateCandidate(candidate, collectedAt));
  const included = validated.filter(
    (row): row is ValidatedCandidate & { primarySource: CompanyMonitoringCurationSource } =>
      row.candidate.disposition === 'included' && row.primarySource !== null,
  );
  if (included.length === 0) fail('curation_included_candidates_missing');
  const candidateIds = new Set<string>();
  const opaqueIds = new Set<string>();
  const occurrenceDigests = new Set<string>();
  const contentFingerprints = new Set<string>();
  const primaryUrls = new Set<string>();
  for (const row of validated) {
    if (candidateIds.has(row.candidate.candidateId)) fail('curation_duplicate_candidate_id');
    candidateIds.add(row.candidate.candidateId);
    if (row.candidate.disposition !== 'included') continue;
    const primarySource = row.primarySource;
    if (primarySource === null) fail('candidate_primary_source_missing');
    const opaqueId = row.candidate.opaqueExampleId;
    if (opaqueId === null) fail('candidate_opaque_id_invalid');
    const occurrenceDigest = evidenceDigest('occurrence', row.candidate.occurrence.stableIdentity);
    const contentFingerprint = sourceContentFingerprint(primarySource);
    const primaryUrl = new URL(primarySource.url).href;
    if (opaqueIds.has(opaqueId)) fail('curation_duplicate_opaque_id');
    if (occurrenceDigests.has(occurrenceDigest)) fail('curation_duplicate_occurrence');
    if (contentFingerprints.has(contentFingerprint)) fail('curation_duplicate_content');
    if (primaryUrls.has(primaryUrl)) fail('curation_duplicate_primary_source_url');
    opaqueIds.add(opaqueId);
    occurrenceDigests.add(occurrenceDigest);
    contentFingerprints.add(contentFingerprint);
    primaryUrls.add(primaryUrl);
  }

  return {
    manifest: value as unknown as CompanyMonitoringCurationManifest,
    included,
  };
}

export function computeCompanyMonitoringCurationManifestDigest(
  manifest: CompanyMonitoringCurationManifest,
): string {
  validateManifest(manifest);
  return sha256(manifest);
}

export function compileCompanyMonitoringBlindCorpus(
  input: CompanyMonitoringCurationManifest,
): {
  corpus: BlindCorpus;
  manifestSha256: string;
  summary: CompanyMonitoringCurationSummary;
} {
  const { manifest, included } = validateManifest(input);
  const geography: Record<CompanyMonitoringGeography, number> = { US: 0, GB: 0 };
  const evidenceAuthority: Partial<Record<CompanyMonitoringEvidenceAuthority, number>> = {};
  const exclusions: Record<string, number> = {};
  for (const candidate of manifest.candidates) {
    if (candidate.disposition === 'excluded') {
      increment(exclusions, candidate.exclusionReason!);
    }
  }
  for (const row of included) {
    geography[row.candidate.company.geography] += 1;
    increment(evidenceAuthority as Record<string, number>, row.primarySource.evidenceAuthority);
  }

  const corpus: BlindCorpus = {
    schemaVersion: 'cm_blind_corpus_v1',
    corpusVersion: manifest.corpusVersion,
    purpose: manifest.purpose,
    status: 'draft',
    protocolVersion: manifest.protocolVersion,
    policyVersion: manifest.policyVersion,
    modelVersion: manifest.modelVersion,
    classifierRuntimeSha256: manifest.classifierRuntimeSha256,
    queryVersion: manifest.queryVersion,
    curatorAccessVersion: manifest.curatorAccessVersion,
    lockedAt: null,
    forecastSha256: null,
    sealedGoldLabelsSha256: null,
    continuation: null,
    precommittedExpansion: null,
    examples: included.map(({ candidate, primarySource }) => ({
      opaqueExampleId: candidate.opaqueExampleId!,
      occurrenceDigest: evidenceDigest('occurrence', candidate.occurrence.stableIdentity),
      contentFingerprint: sourceContentFingerprint(primarySource),
      corporateFamilyDigest: evidenceDigest(
        'corporate_family',
        candidate.company.corporateFamilyIdentity,
      ),
      sourceOriginDigest: evidenceDigest('source_origin', primarySource.sourceOrigin),
    })),
  };

  return {
    corpus,
    manifestSha256: sha256(manifest),
    summary: {
      researchedCandidates: manifest.candidates.length,
      verifiedEvidenceBundles: included.length,
      geography,
      evidenceAuthority,
      exclusions,
    },
  };
}

export function compileCompanyMonitoringGoldLabels(
  curation: CompanyMonitoringCurationManifest,
  labels: CompanyMonitoringGoldCurationManifest,
): GoldLabelSet {
  const { corpus } = compileCompanyMonitoringBlindCorpus(curation);
  requireExactKeys(labels, GOLD_MANIFEST_KEYS, 'gold_curation_schema_invalid');
  if (labels.schemaVersion !== 'cm_gold_curation_v1') fail('gold_curation_schema_version_invalid');
  if (labels.corpusVersion !== corpus.corpusVersion) fail('gold_curation_corpus_version_mismatch');
  requireVersion(labels.goldLabelVersion, 'gold_curation_version_invalid');
  if (labels.curatorAccessVersion !== corpus.curatorAccessVersion) {
    fail('gold_curation_access_version_mismatch');
  }
  if (!Array.isArray(labels.labels)) fail('gold_labels_invalid');

  const expected = new Map(corpus.examples.map((example) => [example.opaqueExampleId, example]));
  const seen = new Set<string>();
  const compiled: GoldLabelSet['labels'] = [];
  for (const value of labels.labels) {
    requireExactKeys(value, GOLD_LABEL_KEYS, 'gold_label_schema_invalid');
    if (typeof value.opaqueExampleId !== 'string' || !OPAQUE_EXAMPLE_ID.test(value.opaqueExampleId)) {
      fail('gold_label_opaque_id_invalid');
    }
    if (seen.has(value.opaqueExampleId)) fail('gold_label_duplicate_opaque_id');
    const example = expected.get(value.opaqueExampleId);
    if (!example) fail('gold_label_unknown_opaque_id');
    if (typeof value.publicationEligible !== 'boolean') fail('gold_label_eligibility_invalid');
    if (value.goldMateriality !== 'material' && value.goldMateriality !== 'immaterial') {
      fail('gold_label_materiality_invalid');
    }
    if (!['positive', 'negative', 'mixed'].includes(String(value.goldDirection))) {
      fail('gold_label_direction_invalid');
    }
    if (value.customerUseful !== null && typeof value.customerUseful !== 'boolean') {
      fail('gold_label_customer_usefulness_invalid');
    }
    seen.add(value.opaqueExampleId);
    compiled.push({
      opaqueExampleId: value.opaqueExampleId,
      publicationEligible: value.publicationEligible,
      goldMateriality: value.goldMateriality,
      goldDirection: value.goldDirection,
      canonicalCorporateFamilyDigest: example.corporateFamilyDigest,
      customerUseful: value.customerUseful,
    });
  }
  if (seen.size !== expected.size) fail('gold_label_coverage_mismatch');

  return {
    schemaVersion: 'cm_gold_labels_v1',
    corpusVersion: corpus.corpusVersion,
    goldLabelVersion: labels.goldLabelVersion,
    curatorAccessVersion: labels.curatorAccessVersion,
    labels: compiled,
  };
}

type SplitManifest = 'pilot' | 'tracer' | 'stage3';
type SplitInput = Record<SplitManifest, CompanyMonitoringCurationManifest>;

export function auditCompanyMonitoringCurationSplit(input: SplitInput): {
  counts: Record<SplitManifest, number>;
  manifestSha256: Record<SplitManifest, string>;
} {
  if (input.pilot.purpose !== 'pilot') fail('curation_split_pilot_purpose_invalid');
  if (input.tracer.purpose !== 'tracer_gate') fail('curation_split_tracer_purpose_invalid');
  if (input.stage3.purpose !== 'stage3_gate') fail('curation_split_stage3_purpose_invalid');
  const compiled = {
    pilot: compileCompanyMonitoringBlindCorpus(input.pilot),
    tracer: compileCompanyMonitoringBlindCorpus(input.tracer),
    stage3: compileCompanyMonitoringBlindCorpus(input.stage3),
  };
  const pairs: Array<[SplitManifest, SplitManifest]> = [
    ['pilot', 'tracer'],
    ['pilot', 'stage3'],
    ['tracer', 'stage3'],
  ];
  const dimensions = [
    ['opaqueExampleId', 'opaque_id'],
    ['occurrenceDigest', 'occurrence'],
    ['contentFingerprint', 'content'],
    ['corporateFamilyDigest', 'corporate_family'],
    ['sourceOriginDigest', 'source_origin'],
  ] as const;
  for (const [leftName, rightName] of pairs) {
    const left = compiled[leftName].corpus.examples;
    const right = compiled[rightName].corpus.examples;
    for (const [field, code] of dimensions) {
      const values = new Set(left.map((example) => example[field]));
      if (right.some((example) => values.has(example[field]))) {
        fail(`curation_split_overlap_${code}`);
      }
    }
  }

  return {
    counts: {
      pilot: compiled.pilot.corpus.examples.length,
      tracer: compiled.tracer.corpus.examples.length,
      stage3: compiled.stage3.corpus.examples.length,
    },
    manifestSha256: {
      pilot: compiled.pilot.manifestSha256,
      tracer: compiled.tracer.manifestSha256,
      stage3: compiled.stage3.manifestSha256,
    },
  };
}
