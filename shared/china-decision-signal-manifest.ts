export const CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP = 4 as const;

export const CHINA_DECISION_SIGNAL_GROUP_MANIFEST = [
  {
    groupId: 'macro',
    provenanceFamily: 'china_macro_official_numeric_observation',
    sourceKey: 'economic:china:macro:v2',
  },
  {
    groupId: 'policy-enforcement',
    provenanceFamily: 'typed_document_event',
    sourceKey: 'china:policy-events:v1',
  },
  {
    groupId: 'cross-strait-activity',
    provenanceFamily: 'operational_activity_record',
    sourceKey: 'military:cross-strait-activity:v1',
  },
  {
    groupId: 'corporate-disclosures',
    provenanceFamily: 'exchange_disclosure',
    sourceKey: 'market:china:corporate-disclosures:v1',
  },
  {
    groupId: 'corridor-conditions',
    provenanceFamily: 'composed_corridor_condition',
    sourceKey: 'supply-chain:china-corridor-control-towers',
  },
  {
    groupId: 'activity-nowcast',
    provenanceFamily: 'derived_comparison',
    sourceKey: 'economic:china-activity-nowcast',
  },
] as const;

export type ChinaDecisionSignalGroupId =
  (typeof CHINA_DECISION_SIGNAL_GROUP_MANIFEST)[number]['groupId'];

export const CHINA_DECISION_SIGNAL_GROUP_IDS: readonly ChinaDecisionSignalGroupId[] =
  Object.freeze(
    CHINA_DECISION_SIGNAL_GROUP_MANIFEST.map(({ groupId }) => groupId),
  );
