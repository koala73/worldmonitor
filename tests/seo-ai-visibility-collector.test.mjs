import assert from 'node:assert/strict';
import {
  collectBaseline,
  deriveTrailingWindows,
  normalizeBingAiPerformance,
  normalizeReferralExport,
  normalizeSearchExport,
  runCli,
} from '../scripts/seo-ai-visibility-collector.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

const readJson = (relativePath) => JSON.parse(
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
);

const querySet = readJson('docs/research/seo-ai-visibility/query-set.json');
const template = readJson(
  'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
);
const observedAt = '2026-08-01T12:00:00Z';

const searchRows = (metrics) => ({
  status: 'available',
  property: 'operator-only-property-id',
  windows: [
    {
      label: '28d',
      startDate: '2026-07-05',
      endDate: '2026-08-01',
      metrics,
      queryRows: [
        {
          query: querySet.queries[0].query,
          clicks: 4,
          impressions: 20,
          ctr: 0.2,
          position: 8,
        },
      ],
      pageRows: [
        {
          page: 'https://www.worldmonitor.app/',
          clicks: 4,
          impressions: 20,
          ctr: 0.2,
          position: 8,
        },
      ],
    },
    {
      label: '90d',
      startDate: '2026-05-04',
      endDate: '2026-08-01',
      metrics,
      queryRows: [],
      pageRows: [],
    },
  ],
  token: 'must never be copied',
});

describe('SEO/AI visibility collector', () => {
  it('derives inclusive trailing 28d and 90d windows from the observation date', () => {
    assert.deepEqual(deriveTrailingWindows(observedAt), [
      { label: '28d', startDate: '2026-07-05', endDate: '2026-08-01' },
      { label: '90d', startDate: '2026-05-04', endDate: '2026-08-01' },
    ]);
  });

  it('normalizes exact reviewed queries and page families without copying property or token data', () => {
    const normalized = normalizeSearchExport(
      searchRows({
        indexedPages: 0,
        impressions: 20,
        clicks: 4,
        ctr: 0.2,
        averagePosition: 8,
      }),
      { querySet, observedAt, provider: 'googleSearchConsole' },
    );

    assert.equal(normalized.property, null);
    assert.equal(normalized.status, 'partial');
    assert.deepEqual(normalized.queryRows, [{
      windowLabel: '28d',
      queryId: 'q01',
      metrics: {
        impressions: 20,
        clicks: 4,
        ctr: 0.2,
        averagePosition: 8,
      },
    }]);
    assert.deepEqual(normalized.pageFamilyRows, [{
      windowLabel: '28d',
      pageFamily: 'homepage',
      metrics: {
        indexedPages: null,
        impressions: 20,
        clicks: 4,
        ctr: 0.2,
        averagePosition: 8,
      },
    }]);
    assert.equal(normalized.windows[0].metrics.indexedPages, 0);
    assert.equal('token' in normalized, false);
  });

  it('fails closed when an imported query is not an exact reviewed query', () => {
    const source = searchRows({
      indexedPages: 1,
      impressions: 1,
      clicks: 1,
      ctr: 1,
      averagePosition: 1,
    });
    source.windows[0].queryRows[0].query = 'a paraphrase that is not reviewed';
    assert.throws(
      () => normalizeSearchExport(source, {
        querySet,
        observedAt,
        provider: 'googleSearchConsole',
      }),
      /exact reviewed query text/,
    );
  });

  it('normalizes Bing AI Performance totals, cited pages, and grounding queries', () => {
    const normalized = normalizeBingAiPerformance({
      status: 'available',
      windows: [
        {
          label: '28d',
          startDate: '2026-07-05',
          endDate: '2026-08-01',
          totalCitations: 12,
          averageCitedPages: 2.5,
          groundingQueries: [
            { phrase: 'geopolitical risk API', citationCount: 3 },
          ],
          citedPages: [
            { url: 'https://www.worldmonitor.app/docs/api-reference', citationCount: 4 },
          ],
        },
        {
          label: '90d',
          startDate: '2026-05-04',
          endDate: '2026-08-01',
          totalCitations: 20,
          averageCitedPages: 1,
          groundingQueries: [],
          citedPages: [],
        },
      ],
    }, { observedAt });

    assert.equal(normalized.windows[0].metrics.totalCitations, 12);
    assert.deepEqual(normalized.windows[0].groundingQueries, [
      { phrase: 'geopolitical risk API', citationCount: 3 },
    ]);
    assert.deepEqual(normalized.windows[0].citedPages, [
      {
        url: 'https://www.worldmonitor.app/docs/api-reference',
        citationCount: 4,
      },
    ]);
  });

  it('aggregates only bounded outcome events and keeps absent metrics null', () => {
    const normalized = normalizeReferralExport({
      status: 'available',
      windows: [
        {
          label: '28d',
          startDate: '2026-07-05',
          endDate: '2026-08-01',
          rows: [
            {
              referrerFamily: 'chatgpt',
              landingPageFamily: 'homepage',
              event: 'session',
              count: 8,
            },
            {
              referrerFamily: 'chatgpt',
              landingPageFamily: 'homepage',
              event: 'dashboard-launch',
              count: 3,
            },
            {
              referrerFamily: 'chatgpt',
              landingPageFamily: 'pricing',
              event: 'checkout-success',
              count: 1,
            },
            {
              referrerFamily: 'chatgpt',
              landingPageFamily: 'developer_mcp',
              event: 'api-action',
              count: 0,
            },
            {
              referrerFamily: 'chatgpt',
              landingPageFamily: 'developer_mcp',
              event: 'pro-activation-exit',
              count: 2,
              completion: 'complete',
            },
            {
              referrerFamily: 'chatgpt',
              landingPageFamily: 'developer_mcp',
              event: 'mcp-connect-success',
              count: 1,
              prompt: 'must never be copied',
              userId: 'must never be copied',
            },
          ],
        },
      ],
    }, { observedAt, classification: template.referrals.classification });

    assert.equal(normalized.status, 'partial');
    assert.deepEqual(normalized.windows[0].metrics, {
      sessions: 8,
      dashboardLaunches: 3,
      pricingViews: null,
      signUps: null,
      proConversions: 1,
      activations: 2,
      apiActions: 0,
      mcpActions: 1,
    });
    assert.equal(normalized.segments.length, 3);
    assert.equal(JSON.stringify(normalized).includes('must never be copied'), false);
  });

  it('builds a validated dated baseline while leaving omitted manual AI observations empty', () => {
    const sources = {
      googleSearchConsole: searchRows({
        indexedPages: 1,
        impressions: 20,
        clicks: 4,
        ctr: 0.2,
        averagePosition: 8,
      }),
      bingWebmaster: {
        status: 'unavailable',
        reason: 'No supported export was supplied.',
      },
      referrals: {
        status: 'unavailable',
        reason: 'No aggregate analytics export was supplied.',
      },
      aiSurfaces: template.aiSurfaces,
    };
    const baseline = collectBaseline({
      template,
      querySet,
      sources,
      observedAt,
      repositoryRevision: 'test-revision',
    });

    assert.equal(baseline.baselineId, '2026-08-01');
    assert.equal(baseline.repositoryRevision, 'test-revision');
    assert.equal(baseline.aiObservations.length, 0);
    assert.equal(baseline.search.googleSearchConsole.windows[0].metrics.clicks, 4);
    assert.equal(baseline.referrals.windows[0].metrics.activations, null);
    assert.equal(JSON.stringify(baseline).includes('operator-only-property-id'), false);
  });

  it('whitelists manual observation fields before writing a baseline', () => {
    const sources = {
      googleSearchConsole: { status: 'unavailable', reason: 'No export.' },
      bingWebmaster: { status: 'unavailable', reason: 'No export.' },
      referrals: { status: 'unavailable', reason: 'No export.' },
      aiSurfaces: template.aiSurfaces,
      aiObservations: [{
        ...template.aiObservations[0],
        prompt: 'must never be copied',
        userId: 'must never be copied',
      }],
    };
    const baseline = collectBaseline({
      template,
      querySet,
      sources,
      observedAt,
      repositoryRevision: 'test-revision',
    });

    assert.equal(JSON.stringify(baseline).includes('must never be copied'), false);
    assert.equal(baseline.aiObservations[0].queryId, 'q01');
  });

  it('reproduces the collector CLI output and its check gate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'seo-visibility-collector-'));
    const sourcesPath = join(directory, 'sources.json');
    const outputPath = join(directory, 'baseline.json');
    writeFileSync(sourcesPath, JSON.stringify({
      googleSearchConsole: { status: 'unavailable', reason: 'No export.' },
      bingWebmaster: { status: 'unavailable', reason: 'No export.' },
      referrals: { status: 'unavailable', reason: 'No export.' },
      aiSurfaces: template.aiSurfaces,
    }));
    const args = [
      '--queries', 'docs/research/seo-ai-visibility/query-set.json',
      '--template', 'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
      '--sources', sourcesPath,
      '--observed-at', observedAt,
      '--repository-revision', 'test-revision',
      '--output', outputPath,
    ];
    try {
      await runCli(args);
      assert.match(readFileSync(outputPath, 'utf8'), /"baselineId": "2026-08-01"/);
      await runCli([...args, '--check']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
