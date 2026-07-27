import assert from 'node:assert/strict';
import {
  mkdtempSync,
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
          startDate: '2026-07-03',
          endDate: '2026-07-30',
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
    assert.equal(comparison.search.googleSearchConsole.impressions.absolute, 500);
    assert.equal(comparison.search.googleSearchConsole.impressions.relative, 0.5);
    assert.equal(comparison.search.googleSearchConsole.ctr.absolute, 0.01);
    assert.equal(comparison.search.googleSearchConsole.indexedPages.absolute, -10);
    assert.equal(comparison.referrals.sessions.absolute, 15);

    next.comparison = comparison;
    const markdown = formatScorecardMarkdown(next);
    assert.match(markdown, /Indexing regressions: googleSearchConsole: 220 → 210/);
    assert.match(markdown, /Referral\/outcome movement: sessions: 20 → 35/);
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
    const previous = buildScorecard(querySet, baseline);
    const current = buildScorecard(querySet, baseline);
    previous.search.googleSearchConsole = {
      status: 'partial',
      reason: 'Indexation was not exported.',
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
      reason: 'Indexation was not exported.',
      windows: [{
        label: '28d',
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

    assert.equal(comparison.search.googleSearchConsole.impressions.absolute, 150);
    assert.equal(comparison.search.googleSearchConsole.indexedPages, null);
  });

  it('renders availability, reproducibility, risks, and the top-five work queue', () => {
    const markdown = formatScorecardMarkdown(buildScorecard(querySet, baseline));

    assert.match(markdown, /Google Search Console \\| Unavailable/);
    assert.match(markdown, /Perplexity \\| Mention \\| No direct citation/);
    assert.match(markdown, /France/);
    assert.match(markdown, /signed-out/);
    assert.match(markdown, /signed-in/);
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
