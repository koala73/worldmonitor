import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCrossStraitActivityPanelModel,
  crossStraitSourceHealthHeading,
  isCrossStraitActivitySnapshot,
  tryBuildCrossStraitActivityPanelModel,
} from '../src/components/cross-strait-activity-summary';
import type { CrossStraitActivitySnapshot } from '../src/types/cross-strait-activity';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Force Posture official-activity supplement (#5575)', () => {
  it('labels official claims, reports baseline samples, and keeps Japan augmentation separate', () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: '2026-07-25T09:00:00.000Z',
      status: 'healthy',
      sources: [],
      coverage: {
        usableMndReportingDays: 91,
        earliestMndReportingDay: '2026-04-25',
        latestMndReportingDay: '2026-07-25',
        backfillComplete: true,
      },
      observations: [
        {
          id: 'taiwan-mnd:2026-07-25',
          sourceId: 'taiwan-mnd',
          observationKind: 'official_daily_claim',
          reportingDay: '2026-07-25',
          reportingPeriod: {
            start: '2026-07-23T22:00:00.000Z',
            end: '2026-07-24T22:00:00.000Z',
            timezone: 'Asia/Taipei',
            utcOffset: '+08:00',
            semantics: 'publisher-defined-06:00-to-06:00',
          },
          publicationTime: '2026-07-25',
          retrievalTime: '2026-07-25T09:00:00.000Z',
          categories: {
            plaAircraftSorties: 29,
            planShips: 6,
            officialShips: 5,
            medianLineCrossings: 17,
            adizEntries: 17,
          },
          originalTerminology: {},
          sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
          originalLanguage: 'en',
          translation: { state: 'not_translated' },
          revision: { sequence: 1, state: 'original', vintageId: 'fixture' },
          history: [],
          provenance: {},
        },
        {
          id: 'japan-mod:p20260724_05e',
          sourceId: 'japan-mod',
          observationKind: 'reviewed_regional_augmentation',
          reportingDay: '2026-07-21',
          reportingPeriod: {
            start: '2026-07-20T21:00:00.000Z',
            end: '2026-07-20T21:00:00.000Z',
            timezone: 'Asia/Tokyo',
            utcOffset: '+09:00',
            semantics: 'publisher-stated-observation-time',
          },
          publicationTime: '2026-07-24',
          retrievalTime: '2026-07-25T09:00:00.000Z',
          categories: { plaAircraft: null, planShips: 3, russianNavyShips: 1 },
          originalTerminology: {},
          sourceUrl: 'https://www.mod.go.jp:444/js/pdf/2026/p20260724_05e.pdf',
          originalLanguage: 'en',
          translation: { state: 'not_translated' },
          revision: { sequence: 1, state: 'original', vintageId: 'fixture' },
          history: [],
          provenance: {},
        },
      ],
      baselines: {
        sourceId: 'taiwan-mnd',
        semantics: 'prior-usable-reporting-days-excluding-current',
        categories: {
          plaAircraftSorties: {
            current: { value: 29, reportingDay: '2026-07-25', sourceId: 'taiwan-mnd' },
            windows: {
              30: {
                windowDays: 30,
                state: 'sufficient',
                statistic: 'median',
                value: 12,
                sampleSize: 30,
                requiredSampleSize: 30,
                calendarSpanDays: 31,
                missingCalendarDays: 1,
                sourceIds: ['taiwan-mnd'],
                difference: 17,
                ratio: 2.4167,
              },
              90: {
                windowDays: 90,
                state: 'sufficient',
                statistic: 'median',
                value: 13,
                sampleSize: 90,
                requiredSampleSize: 90,
                calendarSpanDays: 92,
                missingCalendarDays: 2,
                sourceIds: ['taiwan-mnd'],
                difference: 16,
                ratio: 2.2308,
              },
            },
          },
        },
      },
    } satisfies CrossStraitActivitySnapshot;
    assert.equal(isCrossStraitActivitySnapshot(snapshot), true);
    assert.ok(tryBuildCrossStraitActivityPanelModel(snapshot));
    const model = buildCrossStraitActivityPanelModel(snapshot);

    assert.equal(model.heading, 'Official activity claims');
    assert.match(model.disclaimer, /Publisher claim/);
    assert.match(model.disclaimer, /not ADS-B or AIS tracks/);
    assert.equal(model.mnd?.categories[0].current, '29');
    assert.equal(model.mnd?.sourceUrl, 'https://www.mnd.gov.tw/en/News/PLAAct/87151');
    assert.match(model.mnd?.categories[0].comparisons[0].label ?? '', /30-report median 12/);
    assert.match(model.mnd?.categories[0].comparisons[0].coverage ?? '', /n=30/);
    assert.match(model.mnd?.categories[0].comparisons[1].coverage ?? '', /n=90/);
    assert.equal(model.japan.length, 1);
    assert.match(model.japan[0].label, /Japan Joint Staff/);
    assert.equal(model.japan[0].sourceUrl, '', 'non-default HTTPS ports must not become official links');
    assert.doesNotMatch(JSON.stringify(model.mnd), /Japan Joint Staff/);
  });

  it('shows insufficient coverage instead of fabricating a baseline', () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: '2026-07-25T09:00:00.000Z',
      status: 'backfilling',
      sources: [],
      coverage: {
        usableMndReportingDays: 12,
        earliestMndReportingDay: '2026-07-14',
        latestMndReportingDay: '2026-07-25',
        backfillComplete: false,
      },
      observations: [],
      baselines: {
        sourceId: 'taiwan-mnd',
        semantics: 'prior-usable-reporting-days-excluding-current',
        categories: {},
      },
    } satisfies CrossStraitActivitySnapshot;
    const model = buildCrossStraitActivityPanelModel(snapshot);
    assert.match(model.coverageLabel, /12 usable reporting days/);
    assert.match(model.coverageLabel, /backfill in progress/);
  });

  it('does not claim category-specific baseline availability from aggregate backfill coverage', () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: '2026-07-25T09:00:00.000Z',
      status: 'healthy',
      sources: [],
      coverage: {
        usableMndReportingDays: 91,
        earliestMndReportingDay: '2026-04-25',
        latestMndReportingDay: '2026-07-25',
        backfillComplete: true,
      },
      observations: [{
        id: 'taiwan-mnd:2026-07-25',
        sourceId: 'taiwan-mnd',
        observationKind: 'official_daily_claim',
        reportingDay: '2026-07-25',
        reportingPeriod: {
          start: '2026-07-23T22:00:00.000Z',
          end: '2026-07-24T22:00:00.000Z',
          timezone: 'Asia/Taipei',
          utcOffset: '+08:00',
          semantics: 'publisher-defined-06:00-to-06:00',
        },
        publicationTime: '2026-07-25',
        retrievalTime: '2026-07-25T09:00:00.000Z',
        categories: {
          plaAircraftSorties: 29,
          planShips: 6,
          officialShips: 5,
          medianLineCrossings: 17,
          adizEntries: 17,
        },
        originalTerminology: {},
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
        originalLanguage: 'en',
        translation: { state: 'not_translated' },
        revision: { sequence: 1, state: 'original', vintageId: 'fixture' },
        history: [],
        provenance: {},
      }],
      baselines: {
        sourceId: 'taiwan-mnd',
        semantics: 'prior-usable-reporting-days-excluding-current',
        categories: {
          officialShips: {
            current: { value: 5, reportingDay: '2026-07-25', sourceId: 'taiwan-mnd' },
            windows: {
              30: {
                windowDays: 30,
                state: 'insufficient_data',
                statistic: 'median',
                value: null,
                sampleSize: 22,
                requiredSampleSize: 30,
                calendarSpanDays: 90,
                missingCalendarDays: 68,
                sourceIds: ['taiwan-mnd'],
                difference: null,
                ratio: null,
                reason: 'insufficient_prior_reporting_days',
              },
              90: {
                windowDays: 90,
                state: 'insufficient_data',
                statistic: 'median',
                value: null,
                sampleSize: 22,
                requiredSampleSize: 90,
                calendarSpanDays: 90,
                missingCalendarDays: 68,
                sourceIds: ['taiwan-mnd'],
                difference: null,
                ratio: null,
                reason: 'insufficient_prior_reporting_days',
              },
            },
          },
        },
      },
    } satisfies CrossStraitActivitySnapshot;

    const model = buildCrossStraitActivityPanelModel(snapshot);
    assert.match(model.coverageLabel, /source backfill complete/);
    assert.doesNotMatch(model.coverageLabel, /baseline available/);
    assert.match(
      model.mnd?.categories.find((category) => category.key === 'officialShips')
        ?.comparisons[1]?.label ?? '',
      /90-report median unavailable/,
    );
  });

  it('discloses per-source transport failures so retained counts cannot appear fresh', () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: '2026-07-25T09:00:00.000Z',
      status: 'degraded',
      sources: [
        {
          id: 'taiwan-mnd',
          publisher: 'Taiwan Ministry of National Defense',
          publisherType: 'gov',
          claimSemantics: 'publisher_claim_not_independent_observation',
          transportStatus: 'error',
          requestCount: 1,
          errorCodes: ['mnd_http_503'],
          lastSuccessAt: '2026-07-24T09:00:00.000Z',
        },
        {
          id: 'japan-mod',
          publisher: 'Japan Joint Staff',
          publisherType: 'gov',
          claimSemantics: 'reviewed_regional_augmentation',
          transportStatus: 'fresh',
          requestCount: 1,
          errorCodes: [],
          lastSuccessAt: '2026-07-25T09:00:00.000Z',
        },
      ],
      coverage: {
        usableMndReportingDays: 1,
        earliestMndReportingDay: '2026-07-24',
        latestMndReportingDay: '2026-07-24',
        backfillComplete: false,
      },
      observations: [],
      baselines: {
        sourceId: 'taiwan-mnd',
        semantics: 'prior-usable-reporting-days-excluding-current',
        categories: {},
      },
    } satisfies CrossStraitActivitySnapshot;

    const model = buildCrossStraitActivityPanelModel(snapshot);
    assert.equal(model.sourceHealth?.state, 'degraded');
    assert.match(model.sourceHealth?.summary ?? '', /last-good counts may be retained/);
    assert.deepEqual(model.sourceHealth?.sources.map((source) => source.id), ['taiwan-mnd', 'japan-mod']);
    assert.deepEqual(model.sourceHealth?.sources[0]?.errorCodes, ['mnd_http_503']);
    assert.equal(model.sourceHealth?.sources[0]?.lastSuccessAt, '2026-07-24T09:00:00.000Z');
    assert.equal(model.sourceHealth?.sources[1]?.transportStatus, 'fresh');

    const unavailable = buildCrossStraitActivityPanelModel({ ...snapshot, status: 'unavailable' });
    assert.equal(unavailable.sourceHealth?.state, 'unavailable');
    assert.match(unavailable.sourceHealth?.summary ?? '', /snapshot unavailable/);

    const blocked = buildCrossStraitActivityPanelModel({
      ...snapshot,
      status: 'healthy',
      sources: [
        snapshot.sources[0],
        {
          ...snapshot.sources[1],
          transportStatus: 'error',
          blockedReason: 'HTTP_403',
          errorCodes: ['HTTP_403'],
          lastSuccessAt: '2026-07-24T09:00:00.000Z',
        },
      ],
    });
    assert.equal(blocked.sourceHealth?.state, 'blocked');
    assert.match(blocked.sourceHealth?.summary ?? '', /externally blocked/);
    assert.equal(blocked.sourceHealth?.sources[1]?.blockedReason, 'HTTP_403');
    assert.equal(
      blocked.sourceHealth?.sources[1]?.lastSuccessAt,
      '2026-07-24T09:00:00.000Z',
    );
    assert.equal(
      crossStraitSourceHealthHeading(blocked.sourceHealth?.state ?? 'degraded'),
      'Official activity source blocked',
    );
    assert.equal(
      crossStraitSourceHealthHeading(unavailable.sourceHealth?.state ?? 'degraded'),
      'Official activity unavailable',
    );

    // A proxy-target block reaches the reader through the same disclosure as an
    // upstream refusal: both mean no transport path exists and the displayed
    // counts are retained reviewed records, not current ones.
    const proxyBlockedSource = {
      ...snapshot.sources[1],
      transportStatus: 'error' as const,
      blockedReason: 'PROXY_TARGET_FORBIDDEN' as const,
      proxyFailureReason: 'PROXY_CONNECT_FORBIDDEN',
      proxyControlProbe: 'reachable' as const,
      errorCodes: ['HTTP_403', 'PROXY_CONNECT_FORBIDDEN'],
      lastSuccessAt: null,
    };
    const proxyBlockedSnapshot = {
      ...snapshot,
      status: 'healthy' as const,
      sources: [snapshot.sources[0], proxyBlockedSource],
    };
    assert.ok(
      isCrossStraitActivitySnapshot(proxyBlockedSnapshot),
      'the runtime guard must admit the new reason or the panel renders nothing',
    );
    const proxyBlocked = buildCrossStraitActivityPanelModel(proxyBlockedSnapshot);
    assert.equal(proxyBlocked.sourceHealth?.state, 'blocked');
    assert.equal(
      proxyBlocked.sourceHealth?.sources[1]?.blockedReason,
      'PROXY_TARGET_FORBIDDEN',
    );
    assert.equal(
      crossStraitSourceHealthHeading(proxyBlocked.sourceHealth?.state ?? 'degraded'),
      'Official activity source blocked',
    );
  });

  it('rejects malformed nested cache snapshots and soft-fails the supplement model', () => {
    const base = {
      schemaVersion: 1,
      generatedAt: '2026-07-25T09:00:00.000Z',
      status: 'healthy',
      sources: [],
      coverage: {
        usableMndReportingDays: 1,
        earliestMndReportingDay: '2026-07-25',
        latestMndReportingDay: '2026-07-25',
        backfillComplete: false,
      },
      baselines: {
        sourceId: 'taiwan-mnd',
        semantics: 'prior-usable-reporting-days-excluding-current',
        categories: {},
      },
    };
    const missingReportingPeriod = {
      ...base,
      observations: [{
        sourceId: 'taiwan-mnd',
        reportingDay: '2026-07-25',
        categories: {
          plaAircraftSorties: 1,
          planShips: 1,
          officialShips: 1,
          medianLineCrossings: 1,
          adizEntries: 1,
        },
        sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
      }],
    };
    const missingBaselineCategories = {
      ...base,
      observations: [],
      baselines: {
        ...base.baselines,
        categories: undefined,
      },
    };

    assert.equal(isCrossStraitActivitySnapshot(missingReportingPeriod), false);
    assert.equal(tryBuildCrossStraitActivityPanelModel(missingReportingPeriod), null);
    assert.equal(isCrossStraitActivitySnapshot(missingBaselineCategories), false);
    assert.equal(tryBuildCrossStraitActivityPanelModel(missingBaselineCategories), null);
  });

  it('waits for slow-tier hydration before using the CDN-shielded fallback and rerendering', () => {
    const panel = read('src/components/MilitaryCorrelationPanel.ts');
    const basePanel = read('src/components/CorrelationPanel.ts');
    const renderer = read('src/components/cross-strait-activity-summary.ts');

    assert.match(panel, /await waitForBootstrapSlowTier\(\)/);
    assert.match(panel, /await ensureHydrated\('crossStraitActivity'\)/);
    assert.match(panel, /this\.officialActivitySupplement = undefined;/);
    assert.match(panel, /this\.requestRender\(\)/);
    assert.match(panel, /if \(this\.officialActivity\) this\.requestRender\(\)/);
    assert.match(panel, /override destroy\(\): void \{[\s\S]*?this\.officialActivityDestroyed = true;/);
    assert.match(panel, /model\.sourceHealth/);
    assert.match(panel, /crossStraitSourceHealthHeading\(model\.sourceHealth\.state\)/);
    assert.match(panel, /last success:/);
    assert.match(basePanel, /protected requestRender\(\): void/);
    assert.match(renderer, /url\.port === ''/);
  });
});
