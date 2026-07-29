import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AI_PLATFORMS,
  PAGE_FAMILIES,
  buildScorecard,
  compareScorecards,
  formatScorecardMarkdown,
  runCli,
  validateBaseline,
  validateQuerySet,
} from '../scripts/seo-ai-visibility-scorecard.mjs';

const readJson = (relativePath) => JSON.parse(
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
);

const querySet = readJson('docs/research/seo-ai-visibility/query-set.json');
const baseline = readJson(
  'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
);

function buildComparableScorecards() {
  const currentBaseline = structuredClone(baseline);
  currentBaseline.baselineId = '2026-08-27';
  currentBaseline.observedAt = '2026-08-27T12:00:00Z';
  return [
    buildScorecard(querySet, baseline),
    buildScorecard(querySet, currentBaseline),
  ];
}

describe('SEO and AI visibility query registry', () => {
  it('keeps a reviewed 20-30 query set with every required decision field', () => {
    assert.doesNotThrow(() => validateQuerySet(querySet));
    assert.equal(querySet.queries.length, 25);
    assert.deepEqual(
      [...new Set(querySet.queries.map((query) => query.intent))].sort(),
      [
        'branded_entity',
        'category_definition',
        'developer_agent',
        'evaluation',
        'use_case',
      ],
    );
    assert.deepEqual(
      [...new Set(querySet.queries.map((query) => query.targetPage.family))].sort(),
      [...PAGE_FAMILIES].sort(),
    );
    for (const query of querySet.queries) {
      assert.ok(query.targetAudience.length > 0, query.id);
      assert.ok(query.conversionGoal.length > 0, query.id);
      assert.ok(query.referenceEntities.length > 0, query.id);
      assert.ok(
        query.referenceEntities.every((entity) => entity.name && entity.url),
        `${query.id}: named competitors/sources need URLs`,
      );
    }
  });

  it('rejects duplicate IDs and incomplete competitor/source evidence', () => {
    const duplicate = structuredClone(querySet);
    duplicate.queries[1].id = duplicate.queries[0].id;
    assert.throws(() => validateQuerySet(duplicate), /duplicate query id/);

    const missingReference = structuredClone(querySet);
    missingReference.queries[0].referenceEntities = [];
    assert.throws(
      () => validateQuerySet(missingReference),
      /referenceEntities must contain at least one/,
    );
  });

  it('rejects impossible and non-ISO review dates', () => {
    for (const reviewedAt of ['2026-02-30', 'July 27, 2026']) {
      const invalid = structuredClone(querySet);
      invalid.reviewedAt = reviewedAt;
      assert.throws(
        () => validateQuerySet(invalid),
        /reviewedAt must be an ISO calendar date/,
      );
    }
  });
});

describe('SEO and AI visibility baseline', () => {
  it('validates explicit availability, observation, and reproduction contracts', () => {
    assert.doesNotThrow(() => validateBaseline(baseline, querySet));
    assert.deepEqual(
      [...new Set(baseline.aiObservations.map((row) => row.platform))].sort(),
      [...AI_PLATFORMS].sort(),
    );
    assert.equal(baseline.aiObservations.length, 4);
    assert.equal(baseline.opportunities.length, 5);
    assert.equal(baseline.collectionContext.geography, 'France');
    assert.equal(baseline.collectionContext.locale, 'en');
    assert.deepEqual(
      baseline.aiSurfaces.map(({ platform }) => platform).sort(),
      [...AI_PLATFORMS].sort(),
    );
    assert.deepEqual(
      baseline.referrals.classification.families.map((family) => family.id),
      [
        'chatgpt',
        'perplexity',
        'google_search_ai',
        'copilot_bing',
        'claude',
        'other_ai_search',
        'unknown_direct',
      ],
    );
    assert.deepEqual(baseline.search.googleSearchConsole.queryRows, []);
    assert.deepEqual(baseline.search.googleSearchConsole.pageFamilyRows, []);
    assert.deepEqual(baseline.search.bingWebmaster.queryRows, []);
    assert.deepEqual(baseline.search.bingWebmaster.pageFamilyRows, []);
    assert.deepEqual(baseline.referrals.segments, []);
  });

  it('never lets unavailable data masquerade as zero', () => {
    const invalid = structuredClone(baseline);
    invalid.search.googleSearchConsole.windows[0].metrics.impressions = 0;
    assert.throws(
      () => validateBaseline(invalid, querySet),
      /unavailable metrics must be null/,
    );
  });

  it('distinguishes an AI brand mention from a direct citation', () => {
    const invalid = structuredClone(baseline);
    invalid.aiObservations[0].directCitation = true;
    invalid.aiObservations[0].citedUrls = [];
    assert.throws(
      () => validateBaseline(invalid, querySet),
      /directCitation must match World Monitor cited URLs/,
    );

    const citationWithoutBrandText = structuredClone(baseline);
    citationWithoutBrandText.aiObservations[0].brandMention = false;
    assert.doesNotThrow(
      () => validateBaseline(citationWithoutBrandText, querySet),
    );

    const contradictory = structuredClone(baseline);
    contradictory.aiObservations[0].directCitation = false;
    assert.throws(
      () => validateBaseline(contradictory, querySet),
      /directCitation must match World Monitor cited URLs/,
    );
  });

  it('represents unavailable AI surfaces without fabricating observations', () => {
    const unavailable = structuredClone(baseline);
    const perplexity = unavailable.aiSurfaces.find(
      ({ platform }) => platform === 'perplexity',
    );
    perplexity.status = 'unavailable';
    perplexity.reason = 'Surface was not available in the recorded geography.';
    unavailable.aiObservations = unavailable.aiObservations.filter(
      ({ platform }) => platform !== 'perplexity',
    );

    assert.doesNotThrow(() => validateBaseline(unavailable, querySet));
    const scorecard = buildScorecard(querySet, unavailable);
    assert.equal(scorecard.ai.targetPossible, 100);
    assert.equal(scorecard.ai.possible, 75);
    assert.equal(scorecard.ai.observed, 3);
    assert.equal(scorecard.ai.coverageRate, 0.04);
  });

  it('rejects committed property IDs, malformed guardrails, and invalid priorities', () => {
    const property = structuredClone(baseline);
    property.search.googleSearchConsole.property = 'sc-domain:worldmonitor.app';
    assert.throws(
      () => validateBaseline(property, querySet),
      /property must remain null/,
    );

    const guardrails = structuredClone(baseline);
    guardrails.guardrails = 'do not scrape';
    assert.throws(
      () => validateBaseline(guardrails, querySet),
      /guardrails must be a non-empty array/,
    );

    const priority = structuredClone(baseline);
    priority.opportunities[4].priority = 4.5;
    assert.throws(
      () => validateBaseline(priority, querySet),
      /priorities must be exactly the integers 1-5/,
    );

    const duplicateWindow = structuredClone(baseline);
    duplicateWindow.search.googleSearchConsole.windows[1].label = '28d';
    assert.throws(
      () => validateBaseline(duplicateWindow, querySet),
      /window labels must be unique/,
    );
  });

  it('rejects reversed and mislabeled numeric reporting periods', () => {
    const reversed = structuredClone(baseline);
    reversed.search.googleSearchConsole.windows[0].startDate = '2026-07-28';
    assert.throws(
      () => validateBaseline(reversed, querySet),
      /startDate must not be after endDate/,
    );

    const mislabeled = structuredClone(baseline);
    mislabeled.search.googleSearchConsole.windows[0].label = '7d';
    assert.throws(
      () => validateBaseline(mislabeled, querySet),
      /label must match the inclusive calendar-day span/,
    );
  });

  it('rejects impossible calendar dates and malformed UTC observation times', () => {
    const impossibleDate = structuredClone(baseline);
    impossibleDate.search.googleSearchConsole.windows[0].startDate = '2026-02-30';
    impossibleDate.search.googleSearchConsole.windows[0].endDate = '2026-03-29';
    assert.throws(
      () => validateBaseline(impossibleDate, querySet),
      /startDate must be an ISO calendar date/,
    );

    const malformedTimestamp = structuredClone(baseline);
    malformedTimestamp.observedAt = '2026-02-30T17:15:05Z';
    assert.throws(
      () => validateBaseline(malformedTimestamp, querySet),
      /observedAt must be an ISO UTC date-time/,
    );
  });

  it('pins baselines to the exact reviewed query contract', () => {
    const changedQuerySet = structuredClone(querySet);
    changedQuerySet.queries[0].query = 'a materially different category query';

    assert.throws(
      () => validateBaseline(baseline, changedQuerySet),
      /querySetDigest must match the supplied query set/,
    );
  });

  it('rejects evidence recorded after the baseline snapshot', () => {
    const futureObservation = structuredClone(baseline);
    futureObservation.aiObservations[0].observedAt = '2026-07-27T18:00:00Z';
    assert.throws(
      () => validateBaseline(futureObservation, querySet),
      /aiObservations\[0\]\.observedAt must not be after baseline\.observedAt/,
    );

    const futureWindow = structuredClone(baseline);
    futureWindow.search.googleSearchConsole.windows[0] = {
      ...futureWindow.search.googleSearchConsole.windows[0],
      startDate: '2026-07-01',
      endDate: '2026-07-28',
    };
    assert.throws(
      () => validateBaseline(futureWindow, querySet),
      /endDate must not be after the baseline observation date/,
    );

    const futureReview = structuredClone(querySet);
    futureReview.reviewedAt = '2026-07-28';
    assert.throws(
      () => validateBaseline(baseline, futureReview),
      /reviewedAt must not be after baseline\.observedAt/,
    );
  });

  it('rejects metrics outside their measurement domains', () => {
    const availableSource = (metrics) => ({
      status: 'available',
      property: null,
      reason: null,
      windows: baseline.search.googleSearchConsole.windows.map((window) => ({
        ...structuredClone(window),
        metrics,
      })),
      queryRows: [],
      pageFamilyRows: [],
    });
    const invalidMetrics = [
      ['impressions', -1, /impressions must be non-negative/],
      ['ctr', 1.01, /ctr must be between 0 and 1/],
      ['averagePosition', -0.1, /averagePosition must be non-negative/],
    ];

    for (const [metric, value, expected] of invalidMetrics) {
      const invalid = structuredClone(baseline);
      invalid.search.googleSearchConsole = availableSource({
        indexedPages: 1,
        impressions: 10,
        clicks: 1,
        ctr: 0.1,
        averagePosition: 2,
        [metric]: value,
      });
      assert.throws(() => validateBaseline(invalid, querySet), expected);
    }
  });

  it('keeps observation context inside the declared collection contract', () => {
    const wrongGeography = structuredClone(baseline);
    wrongGeography.aiObservations[0].geography = 'United States';
    assert.throws(
      () => validateBaseline(wrongGeography, querySet),
      /geography must equal collectionContext.geography/,
    );

    const undeclaredSignedInState = structuredClone(baseline);
    undeclaredSignedInState.collectionContext.signedInStates = ['signed-out'];
    assert.throws(
      () => validateBaseline(undeclaredSignedInState, querySet),
      /signedInState must be declared in collectionContext.signedInStates/,
    );
  });

  it('validates every committed baseline in the directory', () => {
    const baselinesDir = new URL(
      '../docs/research/seo-ai-visibility/baselines/',
      import.meta.url,
    );
    const names = readdirSync(baselinesDir).filter((name) => name.endsWith('.json'));
    assert.ok(names.length >= 1, 'expected at least one committed baseline');
    for (const name of names) {
      const committed = JSON.parse(
        readFileSync(new URL(name, baselinesDir), 'utf8'),
      );
      assert.doesNotThrow(() => validateBaseline(committed, querySet), name);
    }
  });
});

describe('scorecard computation', () => {
  it('reports intent and page-family slices without inventing missing search data', () => {
    const scorecard = buildScorecard(querySet, baseline);

    assert.equal(scorecard.querySet.total, 25);
    assert.equal(scorecard.ai.observed, 4);
    assert.equal(scorecard.ai.possible, 100);
    assert.equal(scorecard.ai.brandMentions, 4);
    assert.equal(scorecard.ai.directCitations, 3);
    assert.equal(scorecard.ai.coverageRate, 0.04);
    assert.equal(scorecard.ai.brandMentionRate, 1);
    assert.equal(scorecard.ai.directCitationRate, 0.75);
    assert.equal(scorecard.search.googleSearchConsole.status, 'unavailable');
    assert.equal(
      scorecard.search.googleSearchConsole.windows[0].metrics.impressions,
      null,
    );
    assert.equal(scorecard.referrals.status, 'unavailable');
    assert.equal(Object.keys(scorecard.byIntent).length, 5);
    assert.equal(
      Object.keys(scorecard.byPageFamily).length,
      PAGE_FAMILIES.length,
    );
    assert.equal(
      scorecard.byIntent.category_definition.search.googleSearchConsole
        .windows[0].metrics.impressions,
      null,
    );
    assert.equal(
      scorecard.byPageFamily.homepage.search.googleSearchConsole
        .windows[0].metrics.indexedPages,
      null,
    );
    assert.equal(
      scorecard.referrals.byReferrerFamily.chatgpt.windows[0].metrics.sessions,
      null,
    );
  });

  it('aggregates supported query, page-family, and referral outcome rows', () => {
    const measured = structuredClone(baseline);
    measured.search.googleSearchConsole = {
      status: 'available',
      property: null,
      reason: null,
      windows: [
        {
          label: '28d',
          startDate: '2026-06-30',
          endDate: '2026-07-27',
          metrics: {
            indexedPages: 12,
            impressions: 150,
            clicks: 15,
            ctr: 0.1,
            averagePosition: 9.3333,
          },
        },
      ],
      queryRows: [
        {
          windowLabel: '28d',
          queryId: 'q01',
          metrics: {
            impressions: 100,
            clicks: 10,
            ctr: 0.1,
            averagePosition: 8,
          },
        },
        {
          windowLabel: '28d',
          queryId: 'q02',
          metrics: {
            impressions: 50,
            clicks: 5,
            ctr: 0.1,
            averagePosition: 12,
          },
        },
      ],
      pageFamilyRows: [
        {
          windowLabel: '28d',
          pageFamily: 'homepage',
          metrics: {
            indexedPages: 3,
            impressions: 100,
            clicks: 10,
            ctr: 0.1,
            averagePosition: 8,
          },
        },
      ],
    };
    measured.referrals = {
      ...measured.referrals,
      status: 'available',
      property: null,
      reason: null,
      windows: [
        {
          label: '28d',
          startDate: '2026-06-30',
          endDate: '2026-07-27',
          metrics: {
            sessions: 12,
            dashboardLaunches: 4,
            pricingViews: 3,
            signUps: 2,
            proConversions: 1,
            apiActions: 1,
            mcpActions: 1,
          },
        },
      ],
      segments: [
        {
          windowLabel: '28d',
          referrerFamily: 'chatgpt',
          landingPageFamily: 'homepage',
          metrics: {
            sessions: 8,
            dashboardLaunches: 4,
            pricingViews: 2,
            signUps: 1,
            proConversions: 1,
            apiActions: 0,
            mcpActions: 0,
          },
        },
        {
          windowLabel: '28d',
          referrerFamily: 'perplexity',
          landingPageFamily: 'homepage',
          metrics: {
            sessions: 4,
            dashboardLaunches: 0,
            pricingViews: 1,
            signUps: 1,
            proConversions: 0,
            apiActions: 1,
            mcpActions: 1,
          },
        },
      ],
    };

    const scorecard = buildScorecard(querySet, measured);
    const intentMetrics = scorecard.byIntent.category_definition.search
      .googleSearchConsole.windows[0].metrics;
    assert.deepEqual(intentMetrics, {
      indexedPages: null,
      impressions: 150,
      clicks: 15,
      ctr: 0.1,
      averagePosition: 9.3333,
    });
    assert.deepEqual(
      scorecard.byPageFamily.homepage.search.googleSearchConsole
        .windows[0].metrics,
      {
        indexedPages: 3,
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        averagePosition: 8,
      },
    );
    assert.equal(
      scorecard.referrals.byReferrerFamily.chatgpt.windows[0].metrics
        .proConversions,
      1,
    );
    assert.equal(
      scorecard.referrals.byPageFamily.homepage.windows[0].metrics.sessions,
      12,
    );
  });

  it('finds new/lost citations and meaningful search changes between periods', () => {
    const previousBaseline = structuredClone(baseline);
    previousBaseline.aiObservations.push({
      ...structuredClone(previousBaseline.aiObservations[0]),
      queryId: 'q21',
      platform: 'chatgpt_search',
      directCitation: false,
      citedUrls: [],
      summary: 'World Monitor was mentioned without a direct citation.',
    });
    const previous = buildScorecard(querySet, previousBaseline);
    const nextBaseline = structuredClone(baseline);
    nextBaseline.baselineId = '2026-08-27';
    nextBaseline.observedAt = '2026-08-27T12:00:00Z';
    nextBaseline.aiObservations[0].directCitation = false;
    nextBaseline.aiObservations[0].citedUrls = [];
    nextBaseline.aiObservations.push({
      ...structuredClone(nextBaseline.aiObservations[0]),
      queryId: 'q21',
      platform: 'chatgpt_search',
      directCitation: true,
      citedUrls: ['https://www.worldmonitor.app/pricing.md'],
    });
    nextBaseline.search.googleSearchConsole = {
      status: 'available',
      property: null,
      reason: null,
      windows: [
        {
          label: '28d',
          startDate: '2026-07-31',
          endDate: '2026-08-27',
          metrics: {
            indexedPages: 210,
            impressions: 1500,
            clicks: 90,
            ctr: 0.06,
            averagePosition: 11.2,
          },
        },
      ],
      queryRows: [],
      pageFamilyRows: [],
    };
    const next = buildScorecard(querySet, nextBaseline);
    previous.search.googleSearchConsole = {
      status: 'available',
      property: null,
      reason: null,
      windows: [
        {
          label: '28d',
          startDate: '2026-06-30',
          endDate: '2026-07-27',
          metrics: {
            indexedPages: 220,
            impressions: 1000,
            clicks: 50,
            ctr: 0.05,
            averagePosition: 13.5,
          },
        },
      ],
    };
    previous.referrals = {
      ...previous.referrals,
      status: 'available',
      windows: [{
        label: '28d',
        startDate: '2026-06-30',
        endDate: '2026-07-27',
        metrics: {
          sessions: 20,
          dashboardLaunches: 5,
          pricingViews: 4,
          signUps: 2,
          proConversions: 1,
          apiActions: 1,
          mcpActions: 0,
        },
      }],
    };
    next.referrals = {
      ...next.referrals,
      status: 'available',
      windows: [{
        label: '28d',
        startDate: '2026-07-31',
        endDate: '2026-08-27',
        metrics: {
          sessions: 35,
          dashboardLaunches: 7,
          pricingViews: 6,
          signUps: 3,
          proConversions: 2,
          apiActions: 2,
          mcpActions: 1,
        },
      }],
    };

    const comparison = compareScorecards(previous, next);

    assert.deepEqual(
      comparison.newCitations.map(({ queryId, platform }) => ({ queryId, platform })),
      [{ queryId: 'q21', platform: 'chatgpt_search' }],
    );
    assert.deepEqual(
      comparison.lostCitations.map(({ queryId, platform }) => ({ queryId, platform })),
      [{ queryId: 'q01', platform: 'chatgpt_search' }],
    );
    assert.equal(comparison.search.googleSearchConsole.windowLabel, '28d');
    assert.equal(comparison.search.googleSearchConsole.metrics.impressions.absolute, 500);
    assert.equal(comparison.search.googleSearchConsole.metrics.impressions.relative, 0.5);
    assert.equal(comparison.search.googleSearchConsole.metrics.ctr.absolute, 0.01);
    assert.equal(comparison.search.googleSearchConsole.metrics.indexedPages.absolute, -10);
    assert.equal(comparison.referrals.windowLabel, '28d');
    assert.equal(comparison.referrals.metrics.sessions.absolute, 15);

    next.comparison = comparison;
    const markdown = formatScorecardMarkdown(next);
    assert.match(markdown, /Indexing regressions: googleSearchConsole \(28d\): 220 → 210/);
    assert.match(markdown, /Referral\/outcome movement: sessions \(28d\): 20 → 35/);
    assert.match(
      markdown,
      /periods 2026-06-30\.\.2026-07-27 → 2026-07-31\.\.2026-08-27/,
    );
  });

  it('does not turn sparse audit coverage into new or lost citations', () => {
    const previous = buildScorecard(querySet, baseline);
    const sparse = structuredClone(baseline);
    sparse.baselineId = '2026-08-03';
    sparse.observedAt = '2026-08-03T12:00:00Z';
    sparse.aiObservations = sparse.aiObservations.filter(
      ({ platform }) => platform !== 'chatgpt_search',
    );
    const current = buildScorecard(querySet, sparse);

    const comparison = compareScorecards(previous, current);

    assert.deepEqual(comparison.lostCitations, []);
    assert.deepEqual(comparison.newCitations, []);
    assert.deepEqual(
      comparison.noLongerObserved.map(({ queryId, platform }) => ({
        queryId,
        platform,
      })),
      [{ queryId: 'q01', platform: 'chatgpt_search' }],
    );
  });

  it('compares finite metrics from partial provider exports', () => {
    const [previous, current] = buildComparableScorecards();
    previous.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Indexation was not exported.',
      windows: [{
        label: '28d',
        startDate: '2026-06-30',
        endDate: '2026-07-27',
        metrics: {
          indexedPages: null,
          impressions: 100,
          clicks: 10,
          ctr: 0.1,
          averagePosition: 12,
        },
      }],
    };
    current.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Indexation was not exported.',
      windows: [{
        label: '28d',
        startDate: '2026-07-31',
        endDate: '2026-08-27',
        metrics: {
          indexedPages: null,
          impressions: 250,
          clicks: 30,
          ctr: 0.12,
          averagePosition: 10,
        },
      }],
    };

    const comparison = compareScorecards(previous, current);

    assert.equal(comparison.search.googleSearchConsole.metrics.impressions.absolute, 150);
    assert.equal(comparison.search.googleSearchConsole.metrics.indexedPages, null);
  });

  it('prefers the 28d window for comparisons regardless of authored window order', () => {
    const [previous, current] = buildComparableScorecards();
    const searchWindow = (label, startDate, endDate, impressions) => ({
      label,
      startDate,
      endDate,
      metrics: {
        indexedPages: null,
        impressions,
        clicks: 10,
        ctr: 0.1,
        averagePosition: 12,
      },
    });
    previous.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Only aggregate exports were available.',
      windows: [
        searchWindow('90d', '2026-04-29', '2026-07-27', 900),
        searchWindow('28d', '2026-06-30', '2026-07-27', 100),
      ],
    };
    current.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Only aggregate exports were available.',
      windows: [
        searchWindow('28d', '2026-07-31', '2026-08-27', 250),
        searchWindow('90d', '2026-05-30', '2026-08-27', 2000),
      ],
    };

    const comparison = compareScorecards(previous, current);
    const compared = comparison.search.googleSearchConsole;

    assert.equal(compared.windowLabel, '28d');
    assert.equal(compared.metrics.impressions.before, 100);
    assert.equal(compared.metrics.impressions.after, 250);

    current.comparison = comparison;
    const markdown = formatScorecardMarkdown(current);
    assert.match(markdown, /googleSearchConsole\.impressions \(28d\): 100 → 250/);
  });

  it('classifies meaningful changes via the relative arm and guards before=0 ratios', () => {
    const [previous, current] = buildComparableScorecards();
    const referralWindow = (startDate, endDate, metrics) => ({
      label: '28d',
      startDate,
      endDate,
      metrics,
    });
    previous.referrals = {
      ...previous.referrals,
      status: 'available',
      windows: [referralWindow('2026-06-30', '2026-07-27', {
        sessions: 50,
        dashboardLaunches: 5,
        pricingViews: 4,
        signUps: 2,
        proConversions: 1,
        apiActions: 1,
        mcpActions: 0,
      })],
    };
    current.referrals = {
      ...current.referrals,
      status: 'available',
      windows: [referralWindow('2026-07-31', '2026-08-27', {
        sessions: 59,
        dashboardLaunches: 5,
        pricingViews: 4,
        signUps: 2,
        proConversions: 1,
        apiActions: 1,
        mcpActions: 1,
      })],
    };

    const { metrics } = compareScorecards(previous, current).referrals;

    assert.equal(metrics.sessions.absolute, 9);
    assert.equal(metrics.sessions.relative, 0.18);
    assert.equal(metrics.sessions.meaningful, true);
    assert.equal(metrics.mcpActions.relative, null);
    assert.equal(metrics.mcpActions.meaningful, true);
    assert.equal(metrics.dashboardLaunches.meaningful, false);
  });

  it('escapes markdown-significant characters in cited URLs and summaries', () => {
    const hostile = structuredClone(baseline);
    const observation = hostile.aiObservations[0];
    observation.citedUrls = ['https://www.worldmonitor.app/report(2026)?q=a|b'];
    observation.directCitation = true;
    observation.accuracy = 'mixed';
    observation.summary = 'Line one\nwith | pipe';

    const markdown = formatScorecardMarkdown(buildScorecard(querySet, hostile));

    assert.ok(
      markdown.includes('[link](https://www.worldmonitor.app/report%282026%29?q=a\\|b)'),
      'cited URL must be rendered with encoded parentheses and escaped pipe',
    );
    assert.ok(markdown.includes('Line one with \\| pipe'));
    assert.doesNotMatch(markdown, /report\(2026\)/);
  });

  it('does not compare provider metrics for disjoint window labels', () => {
    const [previous, current] = buildComparableScorecards();
    previous.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Only a 28-day export was available.',
      windows: [{
        label: '28d',
        metrics: {
          indexedPages: null,
          impressions: 100,
          clicks: 10,
          ctr: 0.1,
          averagePosition: 12,
        },
      }],
    };
    current.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Only a 7-day export was available.',
      windows: [{
        label: '7d',
        metrics: {
          indexedPages: null,
          impressions: 250,
          clicks: 30,
          ctr: 0.12,
          averagePosition: 10,
        },
      }],
    };

    const comparison = compareScorecards(previous, current);

    assert.equal(comparison.search.googleSearchConsole, null);
  });

  it('rejects provider comparisons whose reporting windows do not advance', () => {
    const [previous, current] = buildComparableScorecards();
    const searchWindow = (startDate, endDate, impressions) => ({
      label: '28d',
      startDate,
      endDate,
      metrics: {
        indexedPages: 10,
        impressions,
        clicks: 10,
        ctr: 0.1,
        averagePosition: 5,
      },
    });
    previous.search.googleSearchConsole = {
      status: 'available',
      windows: [searchWindow('2026-06-30', '2026-07-27', 100)],
    };
    current.search.googleSearchConsole = {
      status: 'available',
      windows: [searchWindow('2026-05-01', '2026-05-28', 200)],
    };

    assert.throws(
      () => compareScorecards(previous, current),
      /googleSearchConsole current 28d window must advance beyond the previous window/,
    );

    current.search.googleSearchConsole.windows = [
      searchWindow('2026-06-30', '2026-07-27', 200),
    ];
    assert.throws(
      () => compareScorecards(previous, current),
      /googleSearchConsole current 28d window must advance beyond the previous window/,
    );
  });

  it('rejects reversed or incompatible scorecard comparisons', () => {
    const [previous, current] = buildComparableScorecards();
    current.generatedAt = previous.generatedAt;
    assert.throws(
      () => compareScorecards(previous, current),
      /current scorecard must be newer than previous scorecard/,
    );

    current.generatedAt = '2026-08-27T12:00:00Z';
    current.collectionContext.geography = 'United States';
    assert.throws(
      () => compareScorecards(previous, current),
      /collectionContext.geography must match/,
    );

    current.collectionContext.geography = previous.collectionContext.geography;
    current.querySetId = 'different-query-set';
    assert.throws(
      () => compareScorecards(previous, current),
      /querySetId must match/,
    );

    current.querySetId = previous.querySetId;
    current.querySetDigest = 'sha256:changed-query-contract';
    assert.throws(
      () => compareScorecards(previous, current),
      /querySetDigest must match/,
    );
  });

  it('does not classify citation changes across different observation contexts', () => {
    const previousBaseline = structuredClone(baseline);
    previousBaseline.aiObservations[0].directCitation = false;
    previousBaseline.aiObservations[0].citedUrls = ['https://example.com/source'];
    const currentBaseline = structuredClone(baseline);
    currentBaseline.baselineId = '2026-08-27';
    currentBaseline.observedAt = '2026-08-27T12:00:00Z';
    currentBaseline.aiObservations[0].signedInState = 'signed-in';

    const comparison = compareScorecards(
      buildScorecard(querySet, previousBaseline),
      buildScorecard(querySet, currentBaseline),
    );

    assert.deepEqual(comparison.newCitations, []);
    assert.deepEqual(comparison.lostCitations, []);
    assert.equal(comparison.newlyObserved[0].signedInState, 'signed-in');
    assert.equal(comparison.noLongerObserved[0].signedInState, 'signed-out');
  });

  it('renders availability, reproducibility, risks, and the top-five work queue', () => {
    const markdown = formatScorecardMarkdown(buildScorecard(querySet, baseline));

    assert.match(markdown, /Google Search Console \\| Unavailable/);
    assert.match(markdown, /Perplexity \\| Mention \\| No direct citation/);
    assert.match(markdown, /France/);
    assert.match(markdown, /signed-out/);
    assert.match(markdown, /signed-in/);
    assert.match(markdown, /\| Query \| Platform \| Observed at \(UTC\) \| Context \|/);
    assert.match(
      markdown,
      /\| q01 \| ChatGPT Search \| 2026-07-27T17:10:00Z \| France \/ en \/ signed-out \|/,
    );
    assert.match(markdown, /## Top five opportunities/);
    assert.doesNotMatch(markdown, /0 impressions/);
  });

  it('reproduces the committed scorecard from a clean output path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'seo-scorecard-'));
    const output = join(directory, 'scorecard.md');
    try {
      await runCli([
        '--queries',
        'docs/research/seo-ai-visibility/query-set.json',
        '--baseline',
        'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
        '--output',
        output,
      ]);
      const generated = readFileSync(output, 'utf8');
      const committed = readFileSync(
        new URL(
          '../docs/research/seo-ai-visibility/scorecards/2026-07-27.md',
          import.meta.url,
        ),
        'utf8',
      );
      assert.equal(generated, committed);
      await runCli([
        '--queries',
        'docs/research/seo-ai-visibility/query-set.json',
        '--baseline',
        'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
        '--output',
        output,
        '--check',
      ]);
      writeFileSync(output, 'stale scorecard\n');
      await assert.rejects(
        runCli([
          '--queries',
          'docs/research/seo-ai-visibility/query-set.json',
          '--baseline',
          'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
          '--output',
          output,
          '--check',
        ]),
        /is stale/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CLI argument validation', () => {
  it('rejects malformed invocations before reading any input', async () => {
    await assert.rejects(runCli(['--bogus']), /unknown argument --bogus/);
    await assert.rejects(runCli(['--queries']), /--queries requires a value/);
    await assert.rejects(runCli(['--baseline', 'b.json']), /--queries is required/);
    await assert.rejects(runCli(['--queries', 'q.json']), /--baseline is required/);
    await assert.rejects(
      runCli(['--queries', 'q.json', '--baseline', 'b.json', '--check']),
      /--check requires --output/,
    );
  });
});
