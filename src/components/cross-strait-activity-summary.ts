import type {
  CrossStraitActivitySnapshot,
  CrossStraitBaselineWindow,
  CrossStraitSourceId,
  TaiwanMndActivityCategories,
} from '@/types/cross-strait-activity';

export interface CrossStraitComparisonModel {
  label: string;
  coverage: string;
  state: 'sufficient' | 'insufficient_data';
}

export interface CrossStraitCategoryModel {
  key: keyof TaiwanMndActivityCategories;
  label: string;
  current: string;
  comparisons: CrossStraitComparisonModel[];
}

export interface CrossStraitActivityPanelModel {
  heading: string;
  disclaimer: string;
  coverageLabel: string;
  mnd: {
    publisher: string;
    reportingLabel: string;
    sourceUrl: string;
    categories: CrossStraitCategoryModel[];
  } | null;
  japan: Array<{
    label: string;
    reportingLabel: string;
    summary: string;
    sourceUrl: string;
  }>;
  sourceHealth: {
    state: 'degraded' | 'unavailable';
    summary: string;
    sources: Array<{
      id: CrossStraitSourceId;
      publisher: string;
      transportStatus: 'fresh' | 'error';
      errorCodes: string[];
      lastSuccessAt: string | null;
    }>;
  } | null;
}

const CATEGORY_LABELS: ReadonlyArray<[
  keyof TaiwanMndActivityCategories,
  string,
]> = [
  ['plaAircraftSorties', 'PLA aircraft sorties'],
  ['planShips', 'PLAN ships'],
  ['officialShips', 'Official ships'],
  ['medianLineCrossings', 'Median-line crossings'],
  ['adizEntries', 'ADIZ entries'],
];

const JAPAN_CATEGORY_KEYS = [
  'plaAircraft',
  'planShips',
  'russianNavyShips',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && Number(value) >= 0);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || Number.isFinite(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNullableDateString(value: unknown): boolean {
  return value === null || isDateString(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isBaselineWindow(value: unknown, windowDays: 30 | 90): boolean {
  if (!isRecord(value)) return false;
  return value.windowDays === windowDays
    && (value.state === 'sufficient' || value.state === 'insufficient_data')
    && value.statistic === 'median'
    && isNullableFiniteNumber(value.value)
    && isNonNegativeInteger(value.sampleSize)
    && isNonNegativeInteger(value.requiredSampleSize)
    && isNonNegativeInteger(value.calendarSpanDays)
    && isNonNegativeInteger(value.missingCalendarDays)
    && Array.isArray(value.sourceIds)
    && value.sourceIds.length === 1
    && value.sourceIds[0] === 'taiwan-mnd'
    && isNullableFiniteNumber(value.difference)
    && isNullableFiniteNumber(value.ratio)
    && (value.reason === undefined || typeof value.reason === 'string');
}

function isCategoryBaseline(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.current) || !isRecord(value.windows)) return false;
  return isNullableNonNegativeInteger(value.current.value)
    && typeof value.current.reportingDay === 'string'
    && value.current.sourceId === 'taiwan-mnd'
    && isBaselineWindow(value.windows[30], 30)
    && isBaselineWindow(value.windows[90], 90);
}

function isObservation(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.reportingDay !== 'string'
    || !isRecord(value.reportingPeriod)
    || !isDateString(value.reportingPeriod.start)
    || !isDateString(value.reportingPeriod.end)
    || !['Asia/Taipei', 'Asia/Tokyo'].includes(String(value.reportingPeriod.timezone))
    || !['+08:00', '+09:00'].includes(String(value.reportingPeriod.utcOffset))
    || ![
      'publisher-defined-06:00-to-06:00',
      'publisher-stated-observation-time',
      'publisher-stated-afternoon-observation',
    ].includes(String(value.reportingPeriod.semantics))
    || !isDateString(value.publicationTime)
    || !isDateString(value.retrievalTime)
    || !isStringRecord(value.originalTerminology)
    || typeof value.sourceUrl !== 'string'
    || typeof value.originalLanguage !== 'string'
    || !isRecord(value.translation)
    || typeof value.translation.state !== 'string'
    || (
      value.translation.targetLanguage !== undefined
      && typeof value.translation.targetLanguage !== 'string'
    )
    || !isRecord(value.revision)
    || !Number.isInteger(value.revision.sequence)
    || typeof value.revision.state !== 'string'
    || typeof value.revision.vintageId !== 'string'
    || !Array.isArray(value.history)
    || !('provenance' in value)
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || !isRecord(value.categories)
  ) return false;
  const categories = value.categories;
  if (value.sourceId === 'taiwan-mnd') {
    return value.observationKind === 'official_daily_claim'
      && CATEGORY_LABELS.every(([key]) => isNullableNonNegativeInteger(categories[key]));
  }
  if (value.sourceId === 'japan-mod') {
    return value.observationKind === 'reviewed_regional_augmentation'
      && JAPAN_CATEGORY_KEYS.every((key) => isNullableNonNegativeInteger(categories[key]))
      && (
        value.indexPresence === undefined
        || value.indexPresence === 'present'
        || value.indexPresence === 'not_observed_in_current_index'
        || value.indexPresence === 'unknown'
      );
  }
  return false;
}

function isSourceHealth(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.id === 'taiwan-mnd' || value.id === 'japan-mod')
    && typeof value.publisher === 'string'
    && typeof value.publisherType === 'string'
    && typeof value.claimSemantics === 'string'
    && (value.transportStatus === 'fresh' || value.transportStatus === 'error')
    && isNonNegativeInteger(value.requestCount)
    && (
      value.transportPath === undefined
      || value.transportPath === 'direct'
      || value.transportPath === 'proxy'
    )
    && (
      value.fallbackReason === undefined
      || typeof value.fallbackReason === 'string'
    )
    && (
      value.proxyFailureReason === undefined
      || typeof value.proxyFailureReason === 'string'
    )
    && Array.isArray(value.errorCodes)
    && value.errorCodes.every((code) => typeof code === 'string')
    && isNullableDateString(value.lastSuccessAt)
    && (
      value.admittedDocumentCount === undefined
      || isNonNegativeInteger(value.admittedDocumentCount)
    )
    && (
      value.unreviewedCandidateCount === undefined
      || isNonNegativeInteger(value.unreviewedCandidateCount)
    );
}

export function isCrossStraitActivitySnapshot(value: unknown): value is CrossStraitActivitySnapshot {
  if (!isRecord(value)) return false;
  const coverage = value.coverage;
  const baselines = value.baselines;
  if (
    value.schemaVersion !== 1
    || !isDateString(value.generatedAt)
    || !['healthy', 'backfilling', 'degraded', 'unavailable'].includes(String(value.status))
    || !Array.isArray(value.observations)
    || !value.observations.every(isObservation)
    || !Array.isArray(value.sources)
    || !value.sources.every(isSourceHealth)
    || !isRecord(coverage)
    || !isNonNegativeInteger(coverage.usableMndReportingDays)
    || !isNullableDateString(coverage.earliestMndReportingDay)
    || !isNullableDateString(coverage.latestMndReportingDay)
    || typeof coverage.backfillComplete !== 'boolean'
    || (
      coverage.requiredFor30DayComparison !== undefined
      && !isNonNegativeInteger(coverage.requiredFor30DayComparison)
    )
    || (
      coverage.requiredFor90DayComparison !== undefined
      && !isNonNegativeInteger(coverage.requiredFor90DayComparison)
    )
    || !isRecord(baselines)
    || baselines.sourceId !== 'taiwan-mnd'
    || baselines.semantics !== 'prior-usable-reporting-days-excluding-current'
    || !isRecord(baselines.categories)
    || !Object.values(baselines.categories).every(isCategoryBaseline)
  ) return false;
  return true;
}

function numberLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Not reported';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function comparisonModel(window: CrossStraitBaselineWindow): CrossStraitComparisonModel {
  if (window.state !== 'sufficient' || window.value == null) {
    return {
      label: `${window.windowDays}-report median unavailable`,
      coverage: `n=${window.sampleSize}/${window.requiredSampleSize}`,
      state: 'insufficient_data',
    };
  }
  return {
    label: `${window.windowDays}-report median ${numberLabel(window.value)}`,
    coverage: `n=${window.sampleSize}; ${window.calendarSpanDays} calendar days; ${window.missingCalendarDays} missing`,
    state: 'sufficient',
  };
}

function safeOfficialSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.origin === 'https://www.mnd.gov.tw' || url.origin === 'https://www.mod.go.jp')
      && url.port === ''
      && !url.username
      && !url.password
    ) {
      return url.href;
    }
  } catch {
    // A malformed cache value remains plain text, never a link.
  }
  return null;
}

export function buildCrossStraitActivityPanelModel(
  snapshot: CrossStraitActivitySnapshot,
): CrossStraitActivityPanelModel {
  const latestMnd = snapshot.observations
    .filter((row) => row.sourceId === 'taiwan-mnd')
    .sort((a, b) => Date.parse(b.reportingPeriod.end) - Date.parse(a.reportingPeriod.end))[0];
  const categories = latestMnd
    ? CATEGORY_LABELS.map(([key, label]) => {
        const baseline = snapshot.baselines.categories[key];
        return {
          key,
          label,
          current: numberLabel(latestMnd.categories[key]),
          comparisons: baseline
            ? [comparisonModel(baseline.windows[30]), comparisonModel(baseline.windows[90])]
            : [],
        };
      })
    : [];

  const japan = snapshot.observations
    .filter((row) => row.sourceId === 'japan-mod')
    .sort((a, b) => b.reportingDay.localeCompare(a.reportingDay))
    .slice(0, 3)
    .map((row) => {
      const counts = row.categories;
      const countSummary = [
        counts.plaAircraft != null ? `${counts.plaAircraft} PLA aircraft` : null,
        counts.planShips != null ? `${counts.planShips} PLAN ships` : null,
        counts.russianNavyShips != null ? `${counts.russianNavyShips} Russian Navy ships` : null,
      ].filter(Boolean).join(', ');
      return {
        label: `Japan Joint Staff · ${countSummary || 'reviewed activity document'}`,
        reportingLabel: row.reportingDay,
        summary: row.summary ?? 'Reviewed regional augmentation; not reconciled with Taiwan MND counts.',
        sourceUrl: safeOfficialSourceUrl(row.sourceUrl) ?? '',
      };
    });

  const progress = `${snapshot.coverage.usableMndReportingDays} usable reporting days`;
  const sourceHealth = snapshot.status === 'degraded' || snapshot.status === 'unavailable'
    ? {
        state: snapshot.status,
        summary: snapshot.status === 'unavailable'
          ? 'Official activity snapshot unavailable; no current source transport is confirmed.'
          : 'Official source transport is degraded; last-good counts may be retained.',
        sources: snapshot.sources.map((source) => ({
          id: source.id,
          publisher: source.publisher,
          transportStatus: source.transportStatus,
          errorCodes: source.errorCodes,
          lastSuccessAt: source.lastSuccessAt,
        })),
      }
    : null;
  return {
    heading: 'Official activity claims',
    disclaimer: 'Publisher claim · category counts are kept separate and are not ADS-B or AIS tracks.',
    coverageLabel: snapshot.coverage.backfillComplete
      ? `${progress} · source backfill complete`
      : `${progress} · backfill in progress`,
    mnd: latestMnd
      ? {
          publisher: 'Taiwan Ministry of National Defense',
          reportingLabel: `Report ending ${latestMnd.reportingDay} at 06:00 UTC+8`,
          sourceUrl: safeOfficialSourceUrl(latestMnd.sourceUrl) ?? '',
          categories,
        }
      : null,
    japan,
    sourceHealth,
  };
}

export function tryBuildCrossStraitActivityPanelModel(
  value: unknown,
): CrossStraitActivityPanelModel | null {
  if (!isCrossStraitActivitySnapshot(value)) return null;
  try {
    return buildCrossStraitActivityPanelModel(value);
  } catch {
    return null;
  }
}
