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

const bingPerformance = ({
  includeDetailArrays = true,
  firstCitedUrl = 'https://www.worldmonitor.app/docs/api-reference',
} = {}) => ({
  status: 'available',
  windows: [
    {
      label: '28d',
      startDate: '2026-07-05',
      endDate: '2026-08-01',
      totalCitations: 0,
      averageCitedPages: 0,
      ...(includeDetailArrays ? {
        groundingQueries: [],
        citedPages: firstCitedUrl === null
          ? []
          : [{ url: firstCitedUrl, citationCount: 0 }],
      } : {}),
    },
    {
      label: '90d',
      startDate: '2026-05-04',
      endDate: '2026-08-01',
      totalCitations: 0,
      averageCitedPages: 0,
      ...(includeDetailArrays ? {
        groundingQueries: [],
        citedPages: [],
      } : {}),
    },
  ],
});

const completeReferralMetrics = Object.fromEntries([
  ['sessions', 1],
  ['dashboardLaunches', 1],
  ['pricingViews', 1],
  ['signUps', 1],
  ['proConversions', 1],
  ['activations', 1],
  ['apiActions', 1],
  ['mcpActions', 1],
]);

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

  it('detects target-route family collisions without overriding explicit page families', () => {
    const ambiguousQuerySet = structuredClone(querySet);
    ambiguousQuerySet.queries[1].targetPage.url = ambiguousQuerySet.queries[0].targetPage.url;
    const source = searchRows({
      indexedPages: 1,
      impressions: 1,
      clicks: 1,
      ctr: 1,
      averagePosition: 1,
    });

    assert.throws(
      () => normalizeSearchExport(source, {
        querySet: ambiguousQuerySet,
        observedAt,
        provider: 'googleSearchConsole',
      }),
      /maps ambiguously/,
    );

    const explicit = structuredClone(source);
    explicit.windows[0].pageRows[0].pageFamily = 'homepage';
    const normalized = normalizeSearchExport(explicit, {
      querySet: ambiguousQuerySet,
      observedAt,
      provider: 'googleSearchConsole',
    });
    assert.equal(normalized.pageFamilyRows[0].pageFamily, 'homepage');
  });

  it('marks a search export partial when reviewed query or page-family breakdowns are empty', () => {
    const source = searchRows({
      indexedPages: 1,
      impressions: 1,
      clicks: 1,
      ctr: 1,
      averagePosition: 1,
    });
    for (const window of source.windows) {
      window.queryRows = [];
      window.pageRows = [];
    }

    const normalized = normalizeSearchExport(source, {
      querySet,
      observedAt,
      provider: 'googleSearchConsole',
    });
    assert.equal(normalized.status, 'partial');
  });

  it('rejects unknown source statuses instead of treating them as available', () => {
    assert.throws(
      () => normalizeSearchExport({ status: 'mystery' }, { querySet, observedAt }),
      /must be available, partial, or unavailable/,
    );
    assert.throws(
      () => normalizeBingAiPerformance({ status: 'mystery' }, { observedAt }),
      /must be available, partial, or unavailable/,
    );
    assert.throws(
      () => normalizeReferralExport(
        { status: 'mystery' },
        { observedAt, classification: template.referrals.classification },
      ),
      /must be available, partial, or unavailable/,
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

  it('keeps omitted Bing detail arrays partial while preserving explicit empty detail as zero', () => {
    const omitted = normalizeBingAiPerformance(
      bingPerformance({ includeDetailArrays: false }),
      { observedAt },
    );
    assert.equal(omitted.status, 'partial');
    assert.equal(omitted.windows[0].groundingQueries, null);
    assert.equal(omitted.windows[0].citedPages, null);

    const explicitEmpty = normalizeBingAiPerformance(
      bingPerformance({ firstCitedUrl: null }),
      { observedAt },
    );
    assert.equal(explicitEmpty.status, 'available');
    assert.deepEqual(explicitEmpty.windows[0].groundingQueries, []);
    assert.deepEqual(explicitEmpty.windows[0].citedPages, []);
  });

  it('rejects cited URL credentials and stores canonical credential-free URLs', () => {
    const canonical = normalizeBingAiPerformance(
      bingPerformance({ firstCitedUrl: 'https://WWW.worldmonitor.app/docs/api-reference?view=1' }),
      { observedAt },
    );
    assert.equal(
      canonical.windows[0].citedPages[0].url,
      'https://www.worldmonitor.app/docs/api-reference?view=1',
    );

    assert.throws(
      () => normalizeBingAiPerformance(
        bingPerformance({ firstCitedUrl: 'https://operator:secret@www.worldmonitor.app/docs/api-reference' }),
        { observedAt },
      ),
      /must not contain credentials/,
    );
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
              action: 'key-created',
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

  it('omits referral rows with missing dimensions without inventing direct attribution', () => {
    const normalized = normalizeReferralExport({
      status: 'available',
      windows: [
        {
          label: '28d',
          startDate: '2026-07-05',
          endDate: '2026-08-01',
          metrics: completeReferralMetrics,
          rows: [
            {
              landingPageFamily: 'homepage',
              event: 'session',
              count: 99,
            },
            {
              referrerFamily: 'chatgpt',
              event: 'session',
              count: 98,
            },
            {
              referrerFamily: 'unknown_direct',
              landingPageFamily: 'homepage',
              event: 'session',
              count: 2,
            },
          ],
        },
        {
          label: '90d',
          startDate: '2026-05-04',
          endDate: '2026-08-01',
          metrics: completeReferralMetrics,
          rows: [],
        },
      ],
    }, { observedAt, classification: template.referrals.classification });

    assert.equal(normalized.status, 'partial');
    assert.deepEqual(normalized.segments.map(({ referrerFamily }) => referrerFamily), ['unknown_direct']);
    assert.equal(normalized.segments[0].metrics.sessions, 2);
  });

  it('counts only completed activation aliases and quarantines unknown API actions', () => {
    const normalized = normalizeReferralExport({
      status: 'available',
      windows: [{
        label: '28d',
        startDate: '2026-07-05',
        endDate: '2026-08-01',
        rows: [
          {
            referrerFamily: 'chatgpt',
            landingPageFamily: 'developer_mcp',
            event: 'activation',
            count: 99,
          },
          {
            referrerFamily: 'chatgpt',
            landingPageFamily: 'developer_mcp',
            event: 'activation',
            completion: 'complete',
            count: 2,
          },
          {
            referrerFamily: 'chatgpt',
            landingPageFamily: 'developer_mcp',
            event: 'api-action',
            action: 'key-revoked',
            count: 3,
          },
          {
            referrerFamily: 'chatgpt',
            landingPageFamily: 'developer_mcp',
            event: 'api-action',
            action: 'key-deleted',
            count: 100,
          },
        ],
      }],
    }, { observedAt, classification: template.referrals.classification });

    assert.equal(normalized.status, 'partial');
    assert.equal(normalized.windows[0].metrics.activations, 2);
    assert.equal(normalized.windows[0].metrics.apiActions, 3);
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

  it('marks omitted AI surface manifests unavailable instead of inheriting template availability', () => {
    const sources = {
      googleSearchConsole: { status: 'unavailable', reason: 'No export.' },
      bingWebmaster: { status: 'unavailable', reason: 'No export.' },
      referrals: { status: 'unavailable', reason: 'No export.' },
    };
    const baseline = collectBaseline({
      template,
      querySet,
      sources,
      observedAt,
      repositoryRevision: 'test-revision',
    });

    assert.deepEqual(
      baseline.aiSurfaces.map(({ platform, status }) => ({ platform, status })),
      template.aiSurfaces.map(({ platform }) => ({ platform, status: 'unavailable' })),
    );
    assert.equal(baseline.aiObservations.length, 0);
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
      opportunities: template.opportunities.map((opportunity) => ({
        ...opportunity,
        rawPrompt: 'must never be copied',
        userId: 'must never be copied',
        credentials: { token: 'must never be copied' },
      })),
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
    assert.deepEqual(
      Object.keys(baseline.opportunities[0]).sort(),
      ['evidence', 'experiment', 'priority', 'queryIds', 'successCriteria', 'title'],
    );
  });

  it('bounds imported windows, rows, and UTF-8 strings before normalization', () => {
    const oversizedWindows = Array.from({ length: 17 }, (_, index) => ({
      label: `${index + 1}d`,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    }));
    assert.throws(
      () => normalizeSearchExport(
        { status: 'available', windows: oversizedWindows },
        { querySet, observedAt },
      ),
      /windows exceeds the 16-item limit/,
    );

    const oversizedReferralRows = Array.from({ length: 5_001 }, () => ({
      referrerFamily: 'chatgpt',
      landingPageFamily: 'homepage',
      event: 'session',
      count: 1,
    }));
    assert.throws(
      () => normalizeReferralExport({
        status: 'available',
        windows: [{
          label: '28d',
          startDate: '2026-07-05',
          endDate: '2026-08-01',
          rows: oversizedReferralRows,
        }],
      }, { observedAt, classification: template.referrals.classification }),
      /rows exceeds the 5000-item limit/,
    );

    assert.throws(
      () => normalizeSearchExport(
        { status: 'unavailable', reason: '😀'.repeat(2_049) },
        { querySet, observedAt },
      ),
      /exceeds the 4096-byte limit/,
    );

    const oversizedOpportunities = structuredClone(template.opportunities);
    oversizedOpportunities[0].title = '😀'.repeat(2_049);
    assert.throws(
      () => collectBaseline({
        template,
        querySet,
        sources: {
          googleSearchConsole: { status: 'unavailable', reason: 'No export.' },
          bingWebmaster: { status: 'unavailable', reason: 'No export.' },
          referrals: { status: 'unavailable', reason: 'No export.' },
          opportunities: oversizedOpportunities,
        },
        observedAt,
        repositoryRevision: 'test-revision',
      }),
      /opportunities\[0\]\.title exceeds the 4096-byte limit/,
    );
  });

  it('fails closed when no repository revision can be resolved', () => {
    assert.throws(
      () => collectBaseline({
        template,
        querySet,
        sources: {
          googleSearchConsole: { status: 'unavailable', reason: 'No export.' },
          bingWebmaster: { status: 'unavailable', reason: 'No export.' },
          referrals: { status: 'unavailable', reason: 'No export.' },
        },
        observedAt,
        repositoryRevision: 'unknown-local-revision',
      }),
      /local git revision is unavailable/,
    );
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
      writeFileSync(outputPath, 'stale output\n');
      await assert.rejects(
        runCli([...args, '--check']),
        /is stale; regenerate it without --check/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects oversized CLI inputs before loading the full file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'seo-visibility-collector-'));
    const sourcesPath = join(directory, 'oversized-sources.json');
    writeFileSync(sourcesPath, Buffer.alloc((4 * 1024 * 1024) + 1, 0x20));
    try {
      await assert.rejects(
        runCli([
          '--queries', 'docs/research/seo-ai-visibility/query-set.json',
          '--template', 'docs/research/seo-ai-visibility/baselines/2026-07-27.json',
          '--sources', sourcesPath,
          '--observed-at', observedAt,
          '--repository-revision', 'test-revision',
        ]),
        /oversized-sources\.json exceeds the 4194304-byte input limit/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
