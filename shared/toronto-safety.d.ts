export type TorontoSafetySemantic = 'live_dispatch' | 'reported_occurrence' | 'annual_aggregate';

export interface TorontoSafetySourceDescriptor {
  id: 'gta-update-police' | 'gta-update-fire' | 'tps-mci' | 'tps-calls-attended';
  semantic: TorontoSafetySemantic;
  canonicalKey: string;
  seedMetaKey: string;
  label: string;
  disclaimer: string;
  attribution: string;
  sourceUrl: string;
  productionWriter: 'disabled' | 'on-demand';
  bootstrap: 'none';
  geocode: false;
}

export declare const TORONTO_SAFETY_SEMANTICS: Readonly<{
  liveDispatch: 'live_dispatch';
  reportedOccurrence: 'reported_occurrence';
  annualAggregate: 'annual_aggregate';
}>;

export declare const TORONTO_SAFETY_SOURCES: readonly TorontoSafetySourceDescriptor[];
export declare const TORONTO_SAFETY_CANONICAL_KEYS: Readonly<Record<string, string>>;
export declare function torontoSafetySourceById(id: string): TorontoSafetySourceDescriptor | undefined;
export declare function torontoSafetySourcesForSemantic(semantic: TorontoSafetySemantic): TorontoSafetySourceDescriptor[];
