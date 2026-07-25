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

export interface DecisionSignalOriginalReference {
  kind: 'document' | 'text' | 'observation' | 'event' | 'dataset';
  id: string;
  contentHash?: string;
}

export interface DecisionSignalTranslation {
  state: 'unavailable' | 'not_translated' | 'machine_assisted' | 'human_reviewed';
  targetLanguage?: string;
}

export interface DecisionSignalTimeReference {
  role: 'observation' | 'effective' | 'publication' | 'retrieval';
  value: string;
  precision: 'instant' | 'day' | 'month' | 'year';
}

export interface DecisionSignalRevision {
  vintageId: string;
  sequence: number;
  state: 'original' | 'revised' | 'corrected';
}

export interface DecisionSignalSupersession {
  state: 'current' | 'corrected' | 'cancelled' | 'superseded';
  relatedSignalId?: string;
  reason?: string;
}

export interface DecisionSignalConfidence {
  score: number;
  method: string;
}

export interface DecisionSignalCorroboration {
  state: 'single_source' | 'multi_source' | 'independently_corroborated' | 'contradicted';
  sourceSignalIds: string[];
}

export interface DecisionSignalTransportFreshness {
  state: 'fresh' | 'stale' | 'missing' | 'error';
  assessedAt: string;
  lastSuccessAt?: string;
}

export interface DecisionSignalContentFreshness {
  state: 'current' | 'stale' | 'unavailable' | 'partial' | 'timestamp_unknown';
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
