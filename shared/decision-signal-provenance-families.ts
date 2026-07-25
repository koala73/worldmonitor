import type {
  DecisionSignalFamilyKind,
  DecisionSignalProvenanceDeclarationPolicy,
  DecisionSignalProvenanceDimension,
  DecisionSignalProvenanceFamilyDeclaration,
  DecisionSignalProvenanceFamilyRegistration,
} from './decision-signal-provenance-contract';

type DimensionPolicies = Readonly<
  Record<DecisionSignalProvenanceDimension, DecisionSignalProvenanceDeclarationPolicy>
>;

function dimensions(policies: DimensionPolicies): DimensionPolicies {
  return Object.freeze(policies);
}

function declaration(
  id: string,
  kind: DecisionSignalFamilyKind,
  description: string,
  policies: DimensionPolicies,
): Readonly<DecisionSignalProvenanceFamilyDeclaration> {
  return Object.freeze({
    id,
    kind,
    description,
    dimensions: dimensions(policies),
  });
}

export const DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS: Readonly<
  Record<string, Readonly<DecisionSignalProvenanceFamilyDeclaration>>
> = Object.freeze({
  official_numeric_observation: declaration(
    'official_numeric_observation',
    'official_numeric_observation',
    'A revision-aware numeric observation released by an official publisher.',
    {
      publisher: 'required',
      source_url: 'required',
      original_reference: 'required',
      original_language: 'unknown_allowed',
      translation: 'not_applicable',
      observation_time: 'required',
      effective_time: 'unknown_allowed',
      publication_time: 'required',
      retrieval_time: 'required',
      revision: 'required',
      supersession: 'required',
      extraction_confidence: 'required',
      classification_confidence: 'not_applicable',
      corroboration: 'unknown_allowed',
      transport_freshness: 'required',
      content_freshness: 'required',
      derivation: 'not_applicable',
    },
  ),
  typed_document_event: declaration(
    'typed_document_event',
    'typed_document_event',
    'A typed event extracted from a policy, enforcement, or other source document.',
    {
      publisher: 'required',
      source_url: 'required',
      original_reference: 'required',
      original_language: 'required',
      translation: 'required',
      observation_time: 'not_applicable',
      effective_time: 'unknown_allowed',
      publication_time: 'required',
      retrieval_time: 'required',
      revision: 'unknown_allowed',
      supersession: 'required',
      extraction_confidence: 'required',
      classification_confidence: 'required',
      corroboration: 'unknown_allowed',
      transport_freshness: 'required',
      content_freshness: 'required',
      derivation: 'not_applicable',
    },
  ),
  operational_activity_record: declaration(
    'operational_activity_record',
    'operational_activity_record',
    'A time-bounded operational observation such as activity, movement, or disruption.',
    {
      publisher: 'required',
      source_url: 'required',
      original_reference: 'required',
      original_language: 'unknown_allowed',
      translation: 'unknown_allowed',
      observation_time: 'required',
      effective_time: 'unknown_allowed',
      publication_time: 'unknown_allowed',
      retrieval_time: 'required',
      revision: 'unknown_allowed',
      supersession: 'required',
      extraction_confidence: 'required',
      classification_confidence: 'required',
      corroboration: 'unknown_allowed',
      transport_freshness: 'required',
      content_freshness: 'required',
      derivation: 'not_applicable',
    },
  ),
  exchange_disclosure: declaration(
    'exchange_disclosure',
    'exchange_disclosure',
    'An issuer disclosure or correction published through an official market authority.',
    {
      publisher: 'required',
      source_url: 'required',
      original_reference: 'required',
      original_language: 'required',
      translation: 'required',
      observation_time: 'not_applicable',
      effective_time: 'unknown_allowed',
      publication_time: 'required',
      retrieval_time: 'required',
      revision: 'required',
      supersession: 'required',
      extraction_confidence: 'required',
      classification_confidence: 'required',
      corroboration: 'unknown_allowed',
      transport_freshness: 'required',
      content_freshness: 'required',
      derivation: 'not_applicable',
    },
  ),
  composed_corridor_condition: declaration(
    'composed_corridor_condition',
    'composed_corridor_condition',
    'A derived corridor state composed from explicitly identified operational inputs.',
    {
      publisher: 'required',
      source_url: 'not_applicable',
      original_reference: 'not_applicable',
      original_language: 'not_applicable',
      translation: 'not_applicable',
      observation_time: 'required',
      effective_time: 'required',
      publication_time: 'not_applicable',
      retrieval_time: 'required',
      revision: 'required',
      supersession: 'required',
      extraction_confidence: 'not_applicable',
      classification_confidence: 'required',
      corroboration: 'required',
      transport_freshness: 'required',
      content_freshness: 'required',
      derivation: 'required',
    },
  ),
  derived_comparison: declaration(
    'derived_comparison',
    'derived_comparison',
    'A transparent comparison derived from time-aligned source observations.',
    {
      publisher: 'required',
      source_url: 'not_applicable',
      original_reference: 'not_applicable',
      original_language: 'not_applicable',
      translation: 'not_applicable',
      observation_time: 'required',
      effective_time: 'required',
      publication_time: 'not_applicable',
      retrieval_time: 'required',
      revision: 'required',
      supersession: 'required',
      extraction_confidence: 'not_applicable',
      classification_confidence: 'required',
      corroboration: 'required',
      transport_freshness: 'required',
      content_freshness: 'required',
      derivation: 'required',
    },
  ),
});

export const DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS: Readonly<
  Record<string, Readonly<DecisionSignalProvenanceFamilyRegistration>>
> = Object.freeze({
  official_numeric_observation: Object.freeze({
    launchStatus: 'reference',
    serializationFixtureId: 'official-numeric-revised',
  }),
  typed_document_event: Object.freeze({
    launchStatus: 'reference',
    serializationFixtureId: 'typed-document-translated',
  }),
  operational_activity_record: Object.freeze({
    // Launched by the cross-Strait official-activity lane (#5575). Domain
    // fixtures validate daily Taiwan MND claims and reviewed Japan MOD records.
    launchStatus: 'launched',
    serializationFixtureId: 'operational-stale-transport',
  }),
  exchange_disclosure: Object.freeze({
    launchStatus: 'reference',
    serializationFixtureId: 'exchange-disclosure-superseded',
  }),
  composed_corridor_condition: Object.freeze({
    launchStatus: 'reference',
    serializationFixtureId: 'corridor-stale-content',
  }),
  derived_comparison: Object.freeze({
    launchStatus: 'reference',
    serializationFixtureId: 'derived-comparison',
  }),
});
