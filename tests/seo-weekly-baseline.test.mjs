import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  collectBingSnapshot,
  createFixtureTransport as createBingFixtureTransport,
} from '../scripts/seo-bing-collect.mjs';
import { REFERRAL_METRICS, SEARCH_METRICS } from '../scripts/seo-ai-visibility-scorecard.mjs';
import {
  collectGscSnapshot,
  createFixtureTransport as createGscFixtureTransport,
  deriveWindows,
} from '../scripts/seo-gsc-collect.mjs';
import {
  collectUmamiSnapshot,
  createFixtureTransport as createUmamiFixtureTransport,
} from '../scripts/seo-umami-collect.mjs';
import {
  AI_SURFACE_REASON,
  buildWeeklyBaseline,
  findPreviousBaseline,
  runCli,
} from '../scripts/seo-weekly-baseline.mjs';

const repoPath = (relativePath) => new URL(`../${relativePath}`, import.meta.url).pathname;
const readJson = (relativePath) => JSON.parse(readFileSync(repoPath(relativePath), 'utf8'));

const DATE = '2026-11-02';
// The Bing and Umami recordings were made at this instant; the Search Console
// recording is keyed by window, so it is collected as of the same instant.
const OBSERVED_AT = '2026-11-02T06:00:00Z';
const REVISION = 'fixture-revision';
const querySet = readJson('docs/research/seo-ai-visibility/query-set.json');
const previous = readJson('docs/research/seo-ai-visibility/baselines/2026-07-27.json');
const reviewed = (id) => querySet.queries.find((query) => query.id === id).query;

async function gscSnapshot() {
  const transport = createGscFixtureTransport(repoPath('tests/fixtures/gsc/'));
  return collectGscSnapshot({
    transport,
    documents: transport.sitemaps(),
    observedAt: OBSERVED_AT,
    windows: deriveWindows(OBSERVED_AT),
    propertyKind: transport.manifest.propertyKind,
    reportedTotals: transport.manifest.reportedTotals,
    revision: REVISION,
  });
}

async function bingSnapshot() {
  const transport = createBingFixtureTransport(repoPath('tests/fixtures/bing/'));
  assert.equal(transport.manifest.recordedAt, OBSERVED_AT);
  return collectBingSnapshot({ transport, observedAt: OBSERVED_AT });
}

async function umamiSnapshot() {
  const transport = createUmamiFixtureTransport(repoPath('tests/fixtures/umami/'));
  return collectUmamiSnapshot({ transport, observedAt: OBSERVED_AT });
}

async function allSnapshots() {
  return { gsc: await gscSnapshot(), bing: await bingSnapshot(), umami: await umamiSnapshot() };
}

const build = (snapshots) => buildWeeklyBaseline({
  date: DATE,
  snapshots,
  querySet,
  previous,
  repositoryRevision: REVISION,
});

const windowOf = (source, label) => source.windows.find((window) => window.label === label);

/** Every number anywhere under `value`, for "this count never appears" checks. */
function numbersIn(value, found = []) {
  if (typeof value === 'number') found.push(value);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) numbersIn(entry, found);
  return found;
}

describe('weekly baseline: determinism', () => {
  it('builds the same baseline and scorecard from the same snapshots', async () => {
    const first = build(await allSnapshots());
    const second = build(await allSnapshots());
    assert.deepEqual(first.baseline, second.baseline);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.baseline.baselineId, DATE);
    assert.equal(first.baseline.observedAt, OBSERVED_AT);
    assert.equal(first.baseline.schemaVersion, 2);
    assert.equal(first.baseline.repositoryRevision, REVISION);
    assert.match(first.markdown, /Compared `2026-07-27` with `2026-11-02`/);
  });

  it('writes the pair through the CLI, byte-identical on a rerun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-seo-weekly-'));
    try {
      writeFileSync(join(dir, 'query-set.json'), JSON.stringify(querySet));
      mkdirSync(join(dir, 'baselines'));
      cpSync(repoPath('docs/research/seo-ai-visibility/baselines/2026-07-27.json'), join(dir, 'baselines', '2026-07-27.json'));
      const snapshots = await allSnapshots();
      for (const [name, snapshot] of Object.entries(snapshots)) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, `${DATE}.json`), JSON.stringify(snapshot, null, 2));
      }
      const args = ['--date', DATE, '--dir', dir, '--repository-revision', REVISION];
      const read = () => [
        readFileSync(join(dir, 'baselines', `${DATE}.json`), 'utf8'),
        readFileSync(join(dir, 'scorecards', `${DATE}.md`), 'utf8'),
      ];
      await runCli(args, { log: () => {} });
      const first = read();
      // The rerun must compare with 2026-07-27 again, not with its own output.
      assert.equal(findPreviousBaseline(join(dir, 'baselines'), DATE), join(dir, 'baselines', '2026-07-27.json'));
      await runCli(args, { log: () => {} });
      assert.deepEqual(read(), first);
      assert.deepEqual(JSON.parse(first[0]), build(snapshots).baseline);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run without the Search Console snapshot or with a snapshot from another day', async () => {
    const { bing, umami } = await allSnapshots();
    assert.throws(() => build({ bing, umami }), /Search Console snapshot for 2026-11-02 is required/);
    const stale = { ...(await gscSnapshot()), observedAt: '2026-10-27T05:00:00Z' };
    assert.throws(() => build({ gsc: stale, bing, umami }), /observed on 2026-10-27, not 2026-11-02/);
  });
});

describe('weekly baseline: Search Console', () => {
  it('takes window totals from the by-property site totals, not the page-row sum', async () => {
    const gsc = await gscSnapshot();
    const { baseline } = build({ gsc });
    const source = baseline.search.googleSearchConsole;
    const snapshotWindow = windowOf(gsc.performance, '28d');
    assert.equal(source.status, 'partial');
    assert.deepEqual(windowOf(source, '28d').metrics, {
      // The fixture's inspection sample is not complete, so there is no count.
      indexedPages: null,
      impressions: snapshotWindow.siteTotals.all.impressions,
      clicks: snapshotWindow.siteTotals.all.clicks,
      ctr: snapshotWindow.siteTotals.all.ctr,
      averagePosition: snapshotWindow.siteTotals.all.averagePosition,
    });
    assert.notEqual(windowOf(source, '28d').metrics.impressions, snapshotWindow.totals.impressions);
    assert.match(source.reason, /indexedPages is null: the URL Inspection sample is not a complete count/);
    const homepage = source.pageFamilyRows.find((row) => row.windowLabel === '28d' && row.pageFamily === 'homepage');
    assert.equal(homepage.metrics.impressions, snapshotWindow.byFamily.homepage.impressions);
  });

  it('gives a family no row in a truncated window instead of a zero', async () => {
    const gsc = await gscSnapshot();
    const truncated = windowOf(gsc.performance, '90d');
    assert.equal(truncated.status, 'partial', 'the 90d fixture hit the query quota');
    const empty = Object.entries(truncated.byFamily).filter(([, row]) => row.urls === 0).map(([family]) => family);
    assert.ok(empty.length > 0, 'the fixture has a declared family with no page row');
    const { baseline } = build({ gsc });
    const rows90 = baseline.search.googleSearchConsole.pageFamilyRows.filter((row) => row.windowLabel === '90d');
    for (const family of empty) assert.equal(rows90.some((row) => row.pageFamily === family), false, family);
  });

  it('keeps the by-property total when only a brand split failed', async () => {
    const gsc = await gscSnapshot();
    const window = windowOf(gsc.performance, '28d');
    // buildSiteTotals reports partial with a valid `all` when brand or non-brand fails.
    window.siteTotals = { ...window.siteTotals, status: 'partial', reason: 'the brand view was truncated', brand: null };
    const { baseline } = build({ gsc });
    const metrics = windowOf(baseline.search.googleSearchConsole, '28d').metrics;
    assert.equal(metrics.impressions, window.siteTotals.all.impressions);
    assert.equal(metrics.clicks, window.siteTotals.all.clicks);
    assert.doesNotMatch(baseline.search.googleSearchConsole.reason, /no by-property site totals/);
  });

  it('keeps the window null when site totals are missing, even beside reviewed query rows', async () => {
    const gsc = await gscSnapshot();
    const window = windowOf(gsc.performance, '28d');
    window.siteTotals = { status: 'unavailable', reason: 'the site view was not collected' };
    window.topQueries.push({ query: reviewed('q23'), brand: true, clicks: 7, impressions: 70, position: 1.5 });
    const { baseline } = build({ gsc });
    const source = baseline.search.googleSearchConsole;
    assert.deepEqual(
      windowOf(source, '28d').metrics,
      Object.fromEntries(SEARCH_METRICS.map((metric) => [metric, null])),
    );
    assert.equal(source.queryRows.length, 1, 'the reviewed row itself is kept');
    assert.match(source.reason, /28d: no by-property site totals/);
  });
});

describe('weekly baseline: reviewed queries only', () => {
  it('maps exact reviewed query text and drops everything else', async () => {
    const snapshots = await allSnapshots();
    const gscWindow = windowOf(snapshots.gsc.performance, '28d');
    gscWindow.topQueries.push(
      { query: reviewed('q23'), brand: true, clicks: 7, impressions: 70, position: 1.5 },
      // Case and spacing variants are different queries, not the reviewed one.
      { query: reviewed('q23').toLowerCase(), brand: true, clicks: 3, impressions: 30, position: 2 },
      { query: 'an unreviewed query', brand: false, clicks: 1, impressions: 10, position: 9 },
    );
    snapshots.bing.queries.windows['28d'].topQueries.push({
      query: reviewed('q18'),
      brand: true,
      impressions: 40,
      clicks: 4,
      ctr: 0.1,
      avgImpressionPosition: 3.2,
      avgClickPosition: null,
    });
    const { baseline } = build(snapshots);
    const gscRows = baseline.search.googleSearchConsole.queryRows;
    assert.deepEqual(gscRows, [{
      windowLabel: '28d',
      queryId: 'q23',
      metrics: { impressions: 70, clicks: 7, ctr: 0.1, averagePosition: 1.5 },
    }]);
    assert.deepEqual(baseline.search.bingWebmaster.queryRows, [{
      windowLabel: '28d',
      queryId: 'q18',
      metrics: { impressions: 40, clicks: 4, ctr: 0.1, averagePosition: 3.2 },
    }]);
    // The fixtures' own top queries ("world monitor", ...) are not reviewed.
    const ids = new Set(querySet.queries.map((query) => query.id));
    for (const row of [...gscRows, ...baseline.search.bingWebmaster.queryRows]) assert.ok(ids.has(row.queryId));
  });
});

describe('weekly baseline: Bing', () => {
  it('reports partial, with totals from daily traffic and no site position', async () => {
    const snapshots = await allSnapshots();
    snapshots.bing.queries.windows['28d'].topQueries.push({
      query: reviewed('q18'), brand: true, impressions: 40, clicks: 4, ctr: 0.1, avgImpressionPosition: 3.2, avgClickPosition: null,
    });
    const { baseline } = build(snapshots);
    const bing = baseline.search.bingWebmaster;
    assert.equal(bing.status, 'partial');
    assert.match(bing.reason, /top-100-per-week sums, not totals/);
    const traffic = snapshots.bing.traffic.windows['28d'];
    assert.deepEqual(windowOf(bing, '28d').metrics, {
      indexedPages: snapshots.bing.crawl.latest.inIndex,
      impressions: traffic.impressions,
      clicks: traffic.clicks,
      ctr: traffic.ctr,
      // A reviewed query row with a position must not become the site position.
      averagePosition: null,
    });
    const pageRows = bing.pageFamilyRows.filter((row) => row.windowLabel === '28d');
    assert.deepEqual(
      pageRows.map((row) => row.pageFamily).sort(),
      Object.keys(snapshots.bing.pages.windows['28d'].byFamily).sort(),
    );
    for (const row of pageRows) {
      assert.equal(row.metrics.averagePosition, null);
      assert.equal(row.metrics.indexedPages, null);
    }
    assert.equal(bing.aiPerformance.status, 'unavailable');
    assert.equal(bing.aiPerformance.reason, snapshots.bing.aiPerformance.reason);
    for (const window of bing.aiPerformance.windows) {
      assert.deepEqual(window.metrics, { totalCitations: null, averageCitedPages: null });
    }
  });

  it('nulls a window total Bing did not report every day of', async () => {
    const snapshots = await allSnapshots();
    snapshots.bing.traffic.windows['90d'].daysReported = 80;
    const { baseline } = build(snapshots);
    const window90 = windowOf(baseline.search.bingWebmaster, '90d');
    assert.equal(window90.metrics.impressions, null);
    assert.equal(window90.metrics.clicks, null);
    assert.equal(window90.metrics.ctr, null);
    assert.match(baseline.search.bingWebmaster.reason, /90d: Bing reported 80 of 90 days/);
    assert.notEqual(windowOf(baseline.search.bingWebmaster, '28d').metrics.impressions, null);
  });

  it('drops a week whose Bing data has not moved instead of failing the comparison', async () => {
    const first = build(await allSnapshots());
    // A week later Bing still reports the same latest date.
    const nextWeek = '2026-11-09T06:00:00Z';
    const transport = createGscFixtureTransport(repoPath('tests/fixtures/gsc/'));
    const gsc = await collectGscSnapshot({
      transport,
      documents: transport.sitemaps(),
      observedAt: nextWeek,
      windows: deriveWindows(nextWeek),
      revision: REVISION,
    });
    const bing = { ...(await bingSnapshot()), observedAt: nextWeek };
    const second = buildWeeklyBaseline({
      date: '2026-11-09',
      snapshots: { gsc, bing },
      querySet,
      previous: first.baseline,
      repositoryRevision: REVISION,
    });
    const source = second.baseline.search.bingWebmaster;
    assert.equal(source.status, 'unavailable');
    assert.match(source.reason, /Bing data has not advanced since the 2026-11-02 baseline: its 28d window still ends on 2026-10-31/);
    assert.deepEqual(source.queryRows, []);
    assert.equal(source.aiPerformance.reason, bing.aiPerformance.reason);
    assert.match(second.markdown, /Compared `2026-11-02` with `2026-11-09`/);
  });

  it('is unavailable with a reason, and nothing else, when the snapshot is absent', async () => {
    const { gsc, umami } = await allSnapshots();
    const { baseline } = build({ gsc, umami });
    const bing = baseline.search.bingWebmaster;
    assert.equal(bing.status, 'unavailable');
    assert.match(bing.reason, /No Bing Webmaster snapshot for 2026-11-02/);
    assert.deepEqual(bing.queryRows, []);
    assert.deepEqual(bing.pageFamilyRows, []);
    for (const window of bing.windows) {
      assert.deepEqual(window.metrics, Object.fromEntries(SEARCH_METRICS.map((metric) => [metric, null])));
    }
    assert.equal(bing.aiPerformance.status, 'unavailable');
    assert.match(bing.aiPerformance.reason, /no Webmaster API method/);
  });
});

describe('weekly baseline: Umami referrals', () => {
  it('maps visits to sessions and never reports visitor-days as sessions', async () => {
    const snapshots = await allSnapshots();
    const { totals, referrers } = snapshots.umami;
    assert.notEqual(totals.visits, totals.visitorDays, 'the fixture tells the two apart');
    const { baseline } = build(snapshots);
    const { referrals } = baseline;
    assert.equal(referrals.status, 'partial');
    const window28 = windowOf(referrals, '28d');
    assert.deepEqual(window28.metrics, {
      ...Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null])),
      sessions: totals.visits,
    });
    assert.equal(window28.startDate, snapshots.umami.window.startDate);
    assert.equal(window28.endDate, snapshots.umami.window.endDate);
    assert.deepEqual(
      windowOf(referrals, '90d').metrics,
      Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null])),
    );
    // Visitor-day counts reach no metric and no segment.
    assert.deepEqual(referrals.segments, []);
    const metricNumbers = numbersIn(referrals.windows.map((window) => window.metrics));
    const visitorDayCounts = [
      totals.visitorDays,
      ...Object.values(referrers.referrerFamilies).map((family) => family.visitorDays).filter(Number.isFinite),
    ];
    for (const count of visitorDayCounts) assert.equal(metricNumbers.includes(count), false, `visitor-days ${count}`);
    assert.match(referrals.reason, /Umami visitors are visitor-days and are not reported as sessions/);
    // The families are named against the classification, in visitor-days.
    assert.match(referrals.reason, /chatgpt 45;/);
    assert.match(referrals.reason, /google_search_ai unavailable \(Google AI Overviews/);
    assert.match(referrals.reason, /bing\.com counts as search/);
  });

  it('stays within the reason limit when many referrer days failed', async () => {
    const snapshots = await allSnapshots();
    // Ten failed days, each with a long upstream message, as an HTTP 524 run can produce.
    const longReason = `missing 10 of 28 days: ${Array.from({ length: 10 }, (_, index) => (
      `2026-10-${String(index + 10).padStart(2, '0')}: metrics?type=referrer failed with HTTP 524 after 3 attempts (origin timed out behind the proxy)`
    )).join('; ')}. Sums leave out what is missing.`;
    const { referrers } = snapshots.umami;
    referrers.availability = 'partial';
    referrers.reason = longReason;
    for (const family of ['chatgpt', 'perplexity', 'claude', 'copilot_bing', 'other_ai_search']) {
      referrers.referrerFamilies[family] = { ...referrers.referrerFamilies[family], availability: 'partial', reason: longReason };
    }
    const { baseline } = build(snapshots);
    const { reason } = baseline.referrals;
    assert.ok(Buffer.byteLength(reason) <= 4096, `reason is ${Buffer.byteLength(reason)} bytes`);
    assert.equal(reason.split('HTTP 524').length - 1 <= 10, true, 'the shared failure is stated once');
    assert.match(reason, /chatgpt 45 \(partial\)/);
  });

  it('leaves sessions null when a day of totals is missing', async () => {
    const snapshots = await allSnapshots();
    snapshots.umami.totals = {
      ...snapshots.umami.totals,
      availability: 'partial',
      reason: 'missing 1 of 28 days: 2026-10-07. Sums leave out what is missing.',
    };
    const { baseline } = build(snapshots);
    assert.equal(baseline.referrals.status, 'unavailable');
    assert.equal(windowOf(baseline.referrals, '28d').metrics.sessions, null);
    assert.match(baseline.referrals.reason, /sessions is null: Umami totals are partial/);
  });

  it('is unavailable with a reason when the snapshot is absent', async () => {
    const { gsc, bing } = await allSnapshots();
    const { baseline } = build({ gsc, bing });
    assert.equal(baseline.referrals.status, 'unavailable');
    assert.match(baseline.referrals.reason, /No Umami referral snapshot for 2026-11-02/);
    assert.deepEqual(baseline.referrals.segments, []);
    for (const window of baseline.referrals.windows) {
      assert.deepEqual(window.metrics, Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null])));
    }
  });
});

describe('weekly baseline: AI surfaces and context', () => {
  it('records every v2 surface as unavailable with the panel decision and no observation', async () => {
    const { baseline, markdown } = build(await allSnapshots());
    assert.deepEqual(
      baseline.aiSurfaces.map((surface) => surface.platform),
      ['chatgpt_search', 'perplexity', 'google_ai_overview', 'google_ai_mode', 'copilot_search'],
    );
    for (const surface of baseline.aiSurfaces) {
      assert.equal(surface.status, 'unavailable');
      assert.equal(surface.reason, AI_SURFACE_REASON);
    }
    assert.deepEqual(baseline.aiObservations, []);
    assert.match(markdown, /Actual observations: 0\./);
  });

  it('carries the comparable context but not the previous limitations', async () => {
    const { baseline } = build(await allSnapshots());
    for (const field of ['geography', 'locale', 'device', 'signedInStates']) {
      assert.deepEqual(baseline.collectionContext[field], previous.collectionContext[field]);
    }
    for (const limitation of previous.collectionContext.limitations) {
      assert.equal(baseline.collectionContext.limitations.includes(limitation), false, limitation);
    }
    assert.match(baseline.collectionContext.limitations[0], /no export was supplied by hand/);
    assert.deepEqual(baseline.referrals.classification, previous.referrals.classification);
    assert.deepEqual(baseline.opportunities, previous.opportunities);
  });
});
