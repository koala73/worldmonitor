export type CrossStraitSourceId = 'taiwan-mnd' | 'japan-mod';

export interface CrossStraitReportingPeriod {
  start: string;
  end: string;
  timezone: 'Asia/Taipei' | 'Asia/Tokyo';
  utcOffset: '+08:00' | '+09:00';
  semantics:
    | 'publisher-defined-06:00-to-06:00'
    | 'publisher-stated-observation-time'
    | 'publisher-stated-afternoon-observation';
}

export interface TaiwanMndActivityCategories {
  plaAircraftSorties: number | null;
  planShips: number | null;
  officialShips: number | null;
  medianLineCrossings: number | null;
  adizEntries: number | null;
}

export interface JapanModActivityCategories {
  plaAircraft: number | null;
  planShips: number | null;
  russianNavyShips: number | null;
}

interface CrossStraitActivityObservationBase {
  id: string;
  reportingDay: string;
  reportingPeriod: CrossStraitReportingPeriod;
  publicationTime: string;
  retrievalTime: string;
  originalTerminology: Record<string, string>;
  summary?: string;
  sourceUrl: string;
  originalLanguage: string;
  translation: { state: string; targetLanguage?: string };
  revision: { sequence: number; state: string; vintageId: string };
  history: unknown[];
  provenance: unknown;
}

export interface TaiwanMndActivityObservation extends CrossStraitActivityObservationBase {
  sourceId: 'taiwan-mnd';
  observationKind: 'official_daily_claim';
  categories: TaiwanMndActivityCategories;
}

export interface JapanModActivityObservation extends CrossStraitActivityObservationBase {
  sourceId: 'japan-mod';
  observationKind: 'reviewed_regional_augmentation';
  categories: JapanModActivityCategories;
  /**
   * Schema-v1 wire values are kept compatible with the original contract.
   * `indexCoverage` carries the finer distinction for a discovery surface that
   * does not enumerate this document's series at all.
   */
  indexPresence?: CrossStraitIndexPresence;
  indexCoverage?: CrossStraitIndexCoverage;
}

export const CROSS_STRAIT_INDEX_PRESENCE_VALUES = [
  'present',
  'not_observed_in_current_index',
  'unknown',
] as const;

export type CrossStraitIndexPresence = typeof CROSS_STRAIT_INDEX_PRESENCE_VALUES[number];

export const CROSS_STRAIT_INDEX_COVERAGE_VALUES = [
  'covered_by_current_index',
  'not_covered_by_current_index',
] as const;

export type CrossStraitIndexCoverage = typeof CROSS_STRAIT_INDEX_COVERAGE_VALUES[number];

export type CrossStraitActivityObservation =
  | TaiwanMndActivityObservation
  | JapanModActivityObservation;

export interface CrossStraitBaselineWindow {
  windowDays: 30 | 90;
  state: 'sufficient' | 'insufficient_data';
  statistic: 'median';
  value: number | null;
  sampleSize: number;
  requiredSampleSize: number;
  calendarSpanDays: number;
  missingCalendarDays: number;
  sourceIds: ['taiwan-mnd'];
  difference: number | null;
  ratio: number | null;
  reason?: string;
}

export interface CrossStraitCategoryBaseline {
  current: {
    value: number | null;
    reportingDay: string;
    sourceId: 'taiwan-mnd';
  };
  windows: {
    30: CrossStraitBaselineWindow;
    90: CrossStraitBaselineWindow;
  };
}

export interface CrossStraitProxyFailureDetail {
  stage: 'connect' | 'request' | 'response' | 'parse';
  httpStatus: number | null;
  contentType: string | null;
  bodyPrefix: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Mirrors CROSS_STRAIT_BLOCKED_SOURCE_REASONS in
 * scripts/cross-strait-activity/adapters.mjs. The producer lives under scripts/
 * because Railway's nixpacks service copies only that directory, so this list
 * is a hand-kept mirror rather than an import; the production-registration test
 * pins the two together, because a producer reason missing here is not a type
 * error — it silently fails the runtime source-health guard and drops the whole
 * snapshot on the client.
 */
export const CROSS_STRAIT_BLOCKED_SOURCE_REASONS = [
  'HTTP_403',
  'PROXY_TARGET_FORBIDDEN',
] as const;

export type CrossStraitBlockedReason = typeof CROSS_STRAIT_BLOCKED_SOURCE_REASONS[number];

export const CROSS_STRAIT_TRANSPORT_MODES = [
  'japanese_homepage_candidate_discovery',
] as const;

export type CrossStraitTransportMode = typeof CROSS_STRAIT_TRANSPORT_MODES[number];

export const CROSS_STRAIT_COMPANION_RESOLUTIONS = [
  'english_index_blocked_no_derivable_companion',
] as const;

export type CrossStraitCompanionResolution = typeof CROSS_STRAIT_COMPANION_RESOLUTIONS[number];

export interface CrossStraitActivitySourceHealth {
  id: CrossStraitSourceId;
  publisher: string;
  publisherType: string;
  claimSemantics: string;
  transportStatus: 'fresh' | 'error';
  requestCount: number;
  transportPath?: 'direct' | 'proxy';
  blockedReason?: CrossStraitBlockedReason;
  fallbackReason?: string;
  proxyFailureReason?: string;
  /**
   * Operator-only. Stripped from the anonymous bootstrap projection, so this is
   * never populated on a client-hydrated snapshot -- it is modelled here because
   * this interface describes the durable source-health record the seeder writes,
   * of which the bootstrap is a narrowed projection.
   */
  proxyFailureDetail?: CrossStraitProxyFailureDetail;
  /**
   * Operator-only, same projection carve-out as `proxyFailureDetail`. Present
   * only when a proxy CONNECT refusal was tested against a control host:
   * `reachable` means the proxy tunnels elsewhere and refuses this target
   * specifically, which is what licenses `PROXY_TARGET_FORBIDDEN`.
   */
  proxyControlProbe?: 'reachable' | 'unreachable';
  /** Which publisher surface discovery ran against. */
  transportMode?: CrossStraitTransportMode;
  /**
   * Why no English-language document URL accompanies a Japanese release. The
   * English press index is Cloudflare-blocked and the English series carries its
   * own counter, so no companion URL is derivable from a discovered release.
   */
  companionResolution?: CrossStraitCompanionResolution;
  /**
   * Operator-only, same projection carve-out as `proxyFailureDetail`. Bounded
   * list of official releases the last successful fetch discovered, so newly
   * admitted rows can be tied back to a specific transport success. Discovery
   * only -- nothing here is an admitted observation.
   */
  candidates?: CrossStraitJapanModCandidate[];
  /**
   * Operator-only, same projection carve-out as `proxyFailureDetail`. Last
   * result of the low-frequency diagnostic against the blocked English press
   * index. Never affects transportStatus, lastSuccessAt, or errorCodes.
   */
  shadowIndexProbe?: CrossStraitShadowIndexProbe;
  errorCodes: string[];
  lastSuccessAt: string | null;
  admittedDocumentCount?: number;
  unreviewedCandidateCount?: number;
}

export interface CrossStraitJapanModCandidate {
  sourceUrl: string;
  documentId: string;
  publicationDay: string;
  title: string;
}

export interface CrossStraitShadowIndexProbe {
  url: string;
  checkedAt: string;
  status?: 'reachable' | 'blocked' | 'error';
  httpStatus?: number | null;
  errorCode?: string | null;
}

export interface CrossStraitActivitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  status: 'healthy' | 'backfilling' | 'degraded' | 'unavailable';
  sources: CrossStraitActivitySourceHealth[];
  coverage: {
    usableMndReportingDays: number;
    earliestMndReportingDay: string | null;
    latestMndReportingDay: string | null;
    backfillComplete: boolean;
    requiredFor30DayComparison?: number;
    requiredFor90DayComparison?: number;
  };
  observations: CrossStraitActivityObservation[];
  baselines: {
    sourceId: 'taiwan-mnd';
    semantics: 'prior-usable-reporting-days-excluding-current';
    categories: Partial<Record<keyof TaiwanMndActivityCategories, CrossStraitCategoryBaseline>>;
  };
}
