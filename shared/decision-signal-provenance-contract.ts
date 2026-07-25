import type { PropagandaRisk, SourceType } from './source-provenance';

export const DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION = 'decision-signal-provenance/v1' as const;

export const DECISION_SIGNAL_PROVENANCE_DIMENSIONS = [
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
] as const;

export type DecisionSignalProvenanceDimension =
  (typeof DECISION_SIGNAL_PROVENANCE_DIMENSIONS)[number];

export const DECISION_SIGNAL_PROVENANCE_DECLARATION_POLICIES = [
  'required',
  'unknown_allowed',
  'not_applicable',
] as const;

export type DecisionSignalProvenanceDeclarationPolicy =
  (typeof DECISION_SIGNAL_PROVENANCE_DECLARATION_POLICIES)[number];

export const DECISION_SIGNAL_PROVENANCE_CLAIM_STATUSES = [
  'known',
  'unknown',
  'not_applicable',
] as const;

export type DecisionSignalProvenanceClaimStatus =
  (typeof DECISION_SIGNAL_PROVENANCE_CLAIM_STATUSES)[number];

export type KnownProvenanceClaim<T> = Readonly<{
  status: 'known';
  value: T;
}>;

export type UnknownProvenanceClaim = Readonly<{
  status: 'unknown';
  reason: string;
}>;

export type NotApplicableProvenanceClaim = Readonly<{
  status: 'not_applicable';
  reason: string;
}>;

export type DecisionSignalProvenanceClaim<T> =
  | KnownProvenanceClaim<T>
  | UnknownProvenanceClaim
  | NotApplicableProvenanceClaim;

export const DECISION_SIGNAL_PUBLISHER_TYPES = [
  'official_government',
  'state_controlled_media',
  'official_exchange',
  'independent_observation',
  'independent_media',
  'wire_service',
  'market_publisher',
  'derived_output',
  'unknown',
] as const;

export type DecisionSignalPublisherType = (typeof DECISION_SIGNAL_PUBLISHER_TYPES)[number];

export interface DecisionSignalSourceRegistryReference {
  sourceName: string;
  sourceType: SourceType;
  propagandaRisk: PropagandaRisk;
}

export interface DecisionSignalPublisherReference {
  id: string;
  name: string;
  type: DecisionSignalPublisherType;
  registryReference: DecisionSignalSourceRegistryReference | null;
}

export const DECISION_SIGNAL_ORIGINAL_REFERENCE_KINDS = [
  'document',
  'text',
  'observation',
  'event',
  'dataset',
] as const;

export interface DecisionSignalOriginalReference {
  kind: (typeof DECISION_SIGNAL_ORIGINAL_REFERENCE_KINDS)[number];
  id: string;
  contentHash?: string;
}

export const DECISION_SIGNAL_TRANSLATION_STATES = [
  'unavailable',
  'not_translated',
  'machine_assisted',
  'human_reviewed',
] as const;

export interface DecisionSignalTranslation {
  state: (typeof DECISION_SIGNAL_TRANSLATION_STATES)[number];
  targetLanguage?: string;
}

export const DECISION_SIGNAL_TIME_ROLES = [
  'observation',
  'effective',
  'publication',
  'retrieval',
] as const;

export const DECISION_SIGNAL_TIME_PRECISIONS = [
  'instant',
  'day',
  'month',
  'year',
] as const;

export interface DecisionSignalTimeReference {
  role: (typeof DECISION_SIGNAL_TIME_ROLES)[number];
  value: string;
  precision: (typeof DECISION_SIGNAL_TIME_PRECISIONS)[number];
}

export const DECISION_SIGNAL_REVISION_STATES = [
  'preliminary',
  'original',
  'revised',
  'corrected',
] as const;

export interface DecisionSignalRevision {
  vintageId: string;
  sequence: number;
  state: (typeof DECISION_SIGNAL_REVISION_STATES)[number];
}

export const DECISION_SIGNAL_SUPERSESSION_STATES = [
  'current',
  'corrected',
  'cancelled',
  'superseded',
] as const;

export interface DecisionSignalSupersession {
  state: (typeof DECISION_SIGNAL_SUPERSESSION_STATES)[number];
  relatedSignalId?: string;
  reason?: string;
}

export interface DecisionSignalConfidence {
  score: number;
  method: string;
}

export const DECISION_SIGNAL_CORROBORATION_STATES = [
  'single_source',
  'multi_source',
  'independently_corroborated',
  'contradicted',
] as const;

export interface DecisionSignalCorroboration {
  state: (typeof DECISION_SIGNAL_CORROBORATION_STATES)[number];
  sourceSignalIds: string[];
}

export const DECISION_SIGNAL_TRANSPORT_FRESHNESS_STATES = [
  'fresh',
  'stale',
  'missing',
  'error',
] as const;

export type DecisionSignalTransportFreshnessState =
  (typeof DECISION_SIGNAL_TRANSPORT_FRESHNESS_STATES)[number];

export interface DecisionSignalTransportFreshness {
  state: DecisionSignalTransportFreshnessState;
  assessedAt: string;
  lastSuccessAt?: string;
}

export const DECISION_SIGNAL_CONTENT_FRESHNESS_STATES = [
  'current',
  'stale',
  'unavailable',
  'partial',
  'timestamp_unknown',
] as const;

export type DecisionSignalContentFreshnessState =
  (typeof DECISION_SIGNAL_CONTENT_FRESHNESS_STATES)[number];

export interface DecisionSignalContentFreshness {
  state: DecisionSignalContentFreshnessState;
  assessedAt: string;
  contentAsOf?: string;
}

export interface DecisionSignalDerivation {
  methodId: string;
  methodVersion: string;
  computedAt: string;
  inputSignalIds: string[];
}

export interface DecisionSignalProvenanceValueMap {
  publisher: DecisionSignalPublisherReference;
  source_url: string;
  original_reference: DecisionSignalOriginalReference;
  original_language: string;
  translation: DecisionSignalTranslation;
  observation_time: DecisionSignalTimeReference;
  effective_time: DecisionSignalTimeReference;
  publication_time: DecisionSignalTimeReference;
  retrieval_time: DecisionSignalTimeReference;
  revision: DecisionSignalRevision;
  supersession: DecisionSignalSupersession;
  extraction_confidence: DecisionSignalConfidence;
  classification_confidence: DecisionSignalConfidence;
  corroboration: DecisionSignalCorroboration;
  transport_freshness: DecisionSignalTransportFreshness;
  content_freshness: DecisionSignalContentFreshness;
  derivation: DecisionSignalDerivation;
}

export type DecisionSignalProvenanceClaims = Readonly<{
  [Dimension in DecisionSignalProvenanceDimension]:
    DecisionSignalProvenanceClaim<DecisionSignalProvenanceValueMap[Dimension]>;
}>;

export interface DecisionSignalProvenance {
  contractVersion: typeof DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION;
  signalId: string;
  familyId: string;
  claims: DecisionSignalProvenanceClaims;
}

export const DECISION_SIGNAL_FAMILY_KINDS = [
  'official_numeric_observation',
  'typed_document_event',
  'operational_activity_record',
  'exchange_disclosure',
  'composed_corridor_condition',
  'derived_comparison',
] as const;

export type DecisionSignalFamilyKind = (typeof DECISION_SIGNAL_FAMILY_KINDS)[number];

export interface DecisionSignalProvenanceFamilyDeclaration {
  id: string;
  kind: DecisionSignalFamilyKind;
  description: string;
  dimensions: Readonly<
    Record<DecisionSignalProvenanceDimension, DecisionSignalProvenanceDeclarationPolicy>
  >;
}

export interface DecisionSignalProvenanceFamilyRegistration {
  launchStatus: 'reference' | 'launched';
  serializationFixtureId: string;
}

export const DECISION_SIGNAL_PROVENANCE_SURFACES = [
  'cache_storage',
  'api',
  'mcp',
  'ui',
] as const;

export type DecisionSignalProvenanceSurface =
  (typeof DECISION_SIGNAL_PROVENANCE_SURFACES)[number];
