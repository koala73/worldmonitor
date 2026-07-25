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
