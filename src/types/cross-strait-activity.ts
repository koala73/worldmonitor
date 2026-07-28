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
  indexPresence?: 'present' | 'not_observed_in_current_index' | 'unknown';
}

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

export interface CrossStraitActivitySourceHealth {
  id: CrossStraitSourceId;
  publisher: string;
  publisherType: string;
  claimSemantics: string;
  transportStatus: 'fresh' | 'error';
  requestCount: number;
  transportPath?: 'direct' | 'proxy';
  blockedReason?: 'HTTP_403';
  fallbackReason?: string;
  proxyFailureReason?: string;
  proxyFailureDetail?: CrossStraitProxyFailureDetail;
  errorCodes: string[];
  lastSuccessAt: string | null;
  admittedDocumentCount?: number;
  unreviewedCandidateCount?: number;
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
