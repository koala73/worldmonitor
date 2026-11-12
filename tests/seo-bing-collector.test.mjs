import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  assertNoSecrets,
  collectBingSnapshot,
  createLiveTransport,
  parseBingDate,
  renderBingMarkdown,
  runCli,
} from '../scripts/seo-bing-collect.mjs';
import { isBrandQuery } from '../scripts/seo-gsc-collect.mjs';

const repoPath = (relativePath) => new URL(`../${relativePath}`, import.meta.url).pathname;

const FIXTURES = 'tests/fixtures/bing/';
const FAILED_CRAWL = 'tests/fixtures/bing/failed-crawl/';
const SITE_URL = 'https://worldmonitor.app/';
const silent = () => {};

const collect = (fixtures = FIXTURES) => runCli(['--fixtures', fixtures, '--stdout'], { log: silent });

const recorded = (file) => JSON.parse(readFileSync(repoPath(`tests/fixtures/bing/${file}`), 'utf8')).d;
const recordedDate = (row) => new Date(Number(/\d+/.exec(row.Date)[0])).toISOString().slice(0, 10);

const bingDate = (date) => `/Date(${Date.parse(date)})/`;
const daily = (date, impressions, clicks) => ({ Date: bingDate(date), Impressions: impressions, Clicks: clicks });
const weekly = (date, key, impressions, clicks, impressionPosition = 3, clickPosition = -1) => ({
  Date: bingDate(date),
  Query: key,
  Impressions: impressions,
  Clicks: clicks,
  AvgImpressionPosition: impressionPosition,
  AvgClickPosition: clickPosition,
});

/** Answers each method from `responses`; an Error value answers as that failure. */
const memoryTransport = (responses) => ({
  kind: 'memory',
  async call(method) {
    const response = responses[method] ?? [];
    if (response instanceof Error) throw response;
    return { d: response };
  },
});

const OBSERVED_AT = '2026-11-02T06:00:00Z';

describe('Bing Webmaster collector', () => {
  it('produces the same snapshot from the same fixtures', async () => {
    const first = await collect();
    const second = await collect();
    assert.deepEqual(first.snapshot, second.snapshot);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.snapshot.snapshotId, 'bing-2026-11-02');
    assert.equal(first.snapshot.site, null);
  });

  it('ends both windows on the latest date the daily traffic reports', async () => {
    const { snapshot } = await collect();
    assert.equal(snapshot.windowEndSource, 'GetRankAndTrafficStats');
    assert.deepEqual(snapshot.windows, [
      { label: '28d', startDate: '2026-10-04', endDate: '2026-10-31' },
      { label: '90d', startDate: '2026-08-03', endDate: '2026-10-31' },
    ]);
  });

  it('sums the daily traffic rows inside each window and nothing outside it', async () => {
    const { snapshot } = await collect();
    const rows = recorded('rank-and-traffic.json');
    for (const window of snapshot.windows) {
      const inside = rows.filter((row) => {
        const date = recordedDate(row);
        return date >= window.startDate && date <= window.endDate;
      });
      const measured = snapshot.traffic.windows[window.label];
      assert.equal(measured.daysReported, inside.length);
      assert.equal(measured.impressions, inside.reduce((total, row) => total + row.Impressions, 0));
      assert.equal(measured.clicks, inside.reduce((total, row) => total + row.Clicks, 0));
    }
    assert.ok(rows.length > 90, 'the recording must reach past the 90-day window to prove the cut');
    assert.equal(snapshot.traffic.availability, 'available');
    assert.equal(snapshot.traffic.basis, 'daily-site-totals');
    const newest = snapshot.traffic.weeklyTrend.at(-1);
    assert.deepEqual(
      [newest.startDate, newest.endDate, newest.days],
      ['2026-10-25', '2026-10-31', 7],
    );
  });

  it('marks the traffic partial when Bing skips a day in the window', async () => {
    const days = Array.from({ length: 90 }, (_, index) => (
      new Date(Date.parse('2026-08-03') + index * 86_400_000).toISOString().slice(0, 10)
    ));
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: days.filter((date) => date !== '2026-10-20').map((date) => daily(date, 10, 1)),
      }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.traffic.availability, 'partial');
    assert.equal(snapshot.traffic.windows['28d'].daysReported, 27);
    assert.equal(snapshot.traffic.windows['28d'].impressions, 270);
    assert.match(snapshot.traffic.reason, /28d: Bing reported 27 of 28 days/);
  });

  it('counts a repeated date once and leaves out a date whose rows disagree', async () => {
    const days = Array.from({ length: 90 }, (_, index) => (
      new Date(Date.parse('2026-08-03') + index * 86_400_000).toISOString().slice(0, 10)
    ));
    const rows = days.map((date) => daily(date, 10, 1));
    // One date repeated verbatim, and one repeated with a different count.
    // A row count would read both as 28 complete days and double-count.
    rows.push(daily('2026-10-10', 10, 1), daily('2026-10-20', 99, 9));
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({ GetRankAndTrafficStats: rows }),
      observedAt: OBSERVED_AT,
    });
    const window = snapshot.traffic.windows['28d'];
    assert.equal(window.daysReported, 27, 'the conflicting date is not a reported day');
    assert.equal(window.impressions, 270, 'no row is counted twice');
    assert.equal(snapshot.traffic.availability, 'partial');
    assert.match(snapshot.traffic.reason, /conflicting rows for 2026-10-20/);
  });

  it('splits query rows into brand and non-brand with the shared pattern', async () => {
    const { snapshot } = await collect();
    const window = snapshot.queries.windows['28d'];
    const rows = recorded('query-stats.json').filter((row) => {
      const date = recordedDate(row);
      return date >= window.startDate && date <= window.endDate;
    });
    const sum = (subset, field) => subset.reduce((total, row) => total + row[field], 0);
    const brand = rows.filter((row) => isBrandQuery(row.Query));
    const nonBrand = rows.filter((row) => !isBrandQuery(row.Query));
    assert.ok(brand.length > 0 && nonBrand.length > 0, 'the recording must carry both sides');
    assert.equal(window.brand.impressions, sum(brand, 'Impressions'));
    assert.equal(window.brand.clicks, sum(brand, 'Clicks'));
    assert.equal(window.nonBrand.impressions, sum(nonBrand, 'Impressions'));
    assert.equal(window.nonBrand.clicks, sum(nonBrand, 'Clicks'));
    assert.equal(window.impressions, window.brand.impressions + window.nonBrand.impressions);
    assert.equal(window.weeks, 4);
    assert.deepEqual([window.firstWeekEnding, window.lastWeekEnding], ['2026-10-09', '2026-10-30']);
    const top = window.topQueries.find((row) => row.query === 'world monitor');
    assert.equal(top.brand, true);
  });

  it('labels query and page sums as top-100-per-week, never as totals', async () => {
    const { snapshot, markdown } = await collect();
    for (const section of [snapshot.queries, snapshot.pages]) {
      assert.equal(section.availability, 'partial');
      assert.equal(section.basis, 'top-100-per-week');
      assert.match(section.reason, /at most 100 rows per weekly bucket.*not totals/);
    }
    assert.match(markdown, /## Queries \(top 100 per week, not totals\)/);
    assert.match(markdown, /## Page families \(28d, top 100 per week\)/);
  });

  it('counts the weeks that hit the 100-row cap', async () => {
    const full = Array.from({ length: 100 }, (_, index) => weekly('2026-10-30', `query ${index}`, 5, 0));
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: [daily('2026-10-31', 1, 0)],
        GetQueryStats: [...full, weekly('2026-10-23', 'world monitor', 50, 10)],
      }),
      observedAt: OBSERVED_AT,
    });
    const window = snapshot.queries.windows['28d'];
    assert.equal(window.weeks, 2);
    assert.equal(window.weeksAtRowCap, 1);
    assert.equal(window.topQueries.length, 20);
  });

  it('records a -1 position as null and keeps it out of the weighted average', async () => {
    const { snapshot } = await collect();
    for (const row of snapshot.queries.windows['28d'].topQueries) {
      assert.equal(row.avgClickPosition, null, `${row.query} kept Bing's -1`);
      assert.ok(row.avgImpressionPosition > 0);
    }
    const weighted = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: [daily('2026-10-31', 1, 0)],
        GetQueryStats: [
          weekly('2026-10-30', 'world monitor', 30, 3, 2, 4),
          weekly('2026-10-23', 'world monitor', 10, 1, 6, -1),
        ],
      }),
      observedAt: OBSERVED_AT,
    });
    const [row] = weighted.queries.windows['28d'].topQueries;
    assert.equal(row.avgImpressionPosition, 3);
    assert.equal(row.avgClickPosition, 4);
  });

  it('maps pages to families and lists unmapped URLs without their scheme', async () => {
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: [daily('2026-10-31', 1, 0)],
        GetPageStats: [
          weekly('2026-10-30', SITE_URL, 100, 20),
          weekly('2026-10-30', 'https://www.worldmonitor.app/pro', 10, 1),
          weekly('2026-10-30', 'https://status.worldmonitor.app/', 4, 0),
          weekly('2026-10-23', 'https://status.worldmonitor.app/', 3, 1),
        ],
      }),
      observedAt: OBSERVED_AT,
    });
    const window = snapshot.pages.windows['28d'];
    assert.equal(window.byFamily.homepage.impressions, 100);
    assert.equal(window.byFamily.pricing.urls, 1);
    assert.equal(window.impressions, 117);
    assert.equal(window.unmapped.impressions, 7);
    assert.deepEqual(window.unmapped.urls.map((row) => [row.url, row.impressions, row.clicks]), [
      ['status.worldmonitor.app/', 7, 1],
    ]);
    assert.match(window.unmapped.urls[0].reason, /no page family/);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(SITE_URL), false);
    assert.doesNotThrow(() => assertNoSecrets(serialized));
    assert.match(renderBingMarkdown(snapshot), /`status\.worldmonitor\.app\/`: 7 impressions, 1 clicks/);
  });

  it('reports the latest crawl row and its change over 28 days', async () => {
    const { snapshot } = await collect();
    const rows = recorded('crawl-stats.json');
    const latest = rows.at(-1);
    const baseline = rows.find((row) => recordedDate(row) === '2026-10-02');
    assert.equal(snapshot.crawl.availability, 'available');
    assert.equal(snapshot.crawl.latest.date, '2026-10-30');
    assert.equal(snapshot.crawl.latest.inIndex, latest.InIndex);
    assert.equal(snapshot.crawl.change.fromDate, '2026-10-02');
    assert.equal(snapshot.crawl.change.inIndex, latest.InIndex - baseline.InIndex);
    assert.equal(snapshot.crawl.change.code4xx, latest.Code4xx - baseline.Code4xx);
  });

  it('keeps the crawl change null with a reason when the baseline day is missing', async () => {
    const crawl = (date, inIndex) => ({
      Date: bingDate(date),
      InIndex: inIndex,
      CrawledPages: 1,
      CrawlErrors: 0,
      Code2xx: 1,
      Code301: 0,
      Code302: 0,
      Code4xx: 0,
      Code5xx: 0,
      BlockedByRobotsTxt: 0,
      AllOtherCodes: 0,
      DnsFailures: 0,
      ConnectionTimeout: 0,
      ContainsMalware: 0,
      InLinks: 9,
    });
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({ GetCrawlStats: [crawl('2026-10-29', 5), crawl('2026-10-30', 6)] }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.crawl.availability, 'partial');
    assert.equal(snapshot.crawl.change, null);
    assert.match(snapshot.crawl.reason, /no crawl row for 2026-10-02/);
    assert.equal(snapshot.crawl.latest.inIndex, 6);
  });

  it('records AI Performance as unavailable with a reason, never as zero', async () => {
    const { snapshot, markdown } = await collect();
    assert.deepEqual(Object.keys(snapshot.aiPerformance).sort(), ['availability', 'method', 'reason']);
    assert.equal(snapshot.aiPerformance.availability, 'unavailable');
    assert.match(snapshot.aiPerformance.reason, /no method/);
    assert.match(markdown, /## AI Performance\n\nNot measured: /);
  });
});

describe('Bing Webmaster collector degradation', () => {
  it('degrades only the section whose method failed', async () => {
    const healthy = (await collect()).snapshot;
    const { snapshot, markdown } = await collect(FAILED_CRAWL);
    assert.deepEqual(snapshot.crawl, {
      method: 'GetCrawlStats',
      availability: 'unavailable',
      reason: 'GetCrawlStats failed with HTTP 503',
    });
    for (const section of ['traffic', 'queries', 'pages', 'aiPerformance']) {
      assert.deepEqual(snapshot[section], healthy[section], `${section} changed when only the crawl failed`);
    }
    assert.match(markdown, /## Crawl and index\n\nNot measured: GetCrawlStats failed with HTTP 503/);
  });

  it('falls back to the weekly buckets for the window end when the traffic fails', async () => {
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: new Error('[seo-bing] GetRankAndTrafficStats failed with HTTP 500 after 4 attempts'),
        GetQueryStats: [weekly('2026-10-30', 'world monitor', 50, 10)],
      }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.traffic.availability, 'unavailable');
    assert.match(snapshot.traffic.reason, /HTTP 500/);
    assert.equal(snapshot.windowEndSource, 'GetQueryStats');
    assert.equal(snapshot.windows[0].endDate, '2026-10-30');
    assert.equal(snapshot.queries.windows['28d'].brand.impressions, 50);
    assert.match(renderBingMarkdown(snapshot), /## Totals\n\nNot measured: /);
  });

  it('ends the fallback window on the newest bucket across queries and pages', async () => {
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: new Error('[seo-bing] GetRankAndTrafficStats failed with HTTP 500 after 4 attempts'),
        GetQueryStats: [weekly('2026-10-23', 'world monitor', 50, 10)],
        GetPageStats: [weekly('2026-10-30', `${SITE_URL}chokepoints/`, 7, 1)],
      }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.windowEndSource, 'GetPageStats');
    assert.equal(snapshot.windows[0].endDate, '2026-10-30');
    assert.equal(snapshot.pages.windows['28d'].impressions, 7);
    assert.equal(snapshot.queries.windows['28d'].impressions, 50);
  });

  it('makes a section unavailable when a row is malformed', async () => {
    const snapshot = await collectBingSnapshot({
      transport: memoryTransport({
        GetRankAndTrafficStats: [daily('2026-10-31', 1, 0)],
        GetPageStats: [{ ...weekly('2026-10-30', SITE_URL, 5, 0), Impressions: '5' }],
      }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.pages.availability, 'unavailable');
    assert.match(snapshot.pages.reason, /not a non-negative integer/);
    assert.equal(snapshot.traffic.windows['28d'].impressions, 1);
  });

  it('refuses to write a snapshot when every method failed', async () => {
    const failure = new Error('[seo-bing] failed with HTTP 401');
    await assert.rejects(
      collectBingSnapshot({
        transport: memoryTransport({
          GetRankAndTrafficStats: failure,
          GetQueryStats: failure,
          GetPageStats: failure,
          GetCrawlStats: failure,
        }),
        observedAt: OBSERVED_AT,
      }),
      /every Bing method failed/,
    );
  });

  it('parses the Bing date format, with or without an offset', () => {
    assert.equal(parseBingDate('/Date(1772755200000)/'), '2026-03-06');
    assert.equal(parseBingDate('/Date(1772755200000-0800)/'), '2026-03-06');
    assert.throws(() => parseBingDate('2026-03-06'), /date Bing does not normally send/);
  });
});

describe('Bing Webmaster collector secrecy', () => {
  const API_KEY = 'fake-bing-key-0123456789abcdef';

  it('refuses output that carries the key, the site URL or a raw payload', () => {
    const refused = [
      `{"note":"${API_KEY}"}`,
      `{"note":"${SITE_URL}"}`,
      `{"note":"${encodeURIComponent(SITE_URL)}"}`,
      '{"note":"?apikey=x"}',
      '{"__type":"QueryStats:#Microsoft.Bing.Webmaster.Api"}',
      '{"Date":"/Date(1772755200000)/"}',
    ];
    for (const serialized of refused) {
      assert.throws(() => assertNoSecrets(serialized, { apiKey: API_KEY }), /refusing to write output/);
    }
    assert.equal(
      assertNoSecrets('{"url":"worldmonitor.app/"}', { apiKey: API_KEY }),
      '{"url":"worldmonitor.app/"}',
    );
  });

  it('writes no marker from the recorded payloads into the snapshot or summary', async () => {
    // The recordings keep Bing's __type and /Date( fields, so a payload copied
    // wholesale would fail here; without them this test could not fail.
    assert.match(readFileSync(repoPath('tests/fixtures/bing/page-stats.json'), 'utf8'), /__type[\s\S]*"https:\/\/worldmonitor\.app\/"/);
    const { snapshot, markdown } = await collect();
    for (const output of [JSON.stringify(snapshot), markdown]) {
      assert.doesNotThrow(() => assertNoSecrets(output, { apiKey: API_KEY }));
    }
  });

  it('keeps the key and the request URL out of a live failure', async () => {
    const requested = [];
    const transport = createLiveTransport({
      apiKey: API_KEY,
      fetchImpl: async (url, init) => {
        requested.push(url);
        assert.ok(init.signal, 'every request needs a deadline');
        assert.match(init.headers['User-Agent'] ?? '', /\S/, 'every request names a User-Agent');
        return new Response('{"Message":"bad key"}', { status: 401 });
      },
      sleep: async () => {},
    });
    await assert.rejects(transport.call('GetQueryStats'), (error) => {
      assert.equal(error.message, '[seo-bing] GetQueryStats failed with HTTP 401');
      assert.equal(error.message.includes(API_KEY), false);
      return true;
    });
    assert.equal(requested.length, 1, 'a 4xx must not be retried');
    assert.match(requested[0], /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetQueryStats\?siteUrl=https%3A%2F%2Fworldmonitor\.app%2F&apikey=/);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const statuses = [503, 200];
    const delays = [];
    const transport = createLiveTransport({
      apiKey: API_KEY,
      fetchImpl: async () => {
        const status = statuses.shift();
        return new Response(status === 200 ? '{"d":[]}' : 'busy', { status });
      },
      sleep: async (ms) => { delays.push(ms); },
    });
    assert.deepEqual(await transport.call('GetCrawlStats'), { d: [] });
    assert.deepEqual(delays, [2_000]);
  });

  it('gives up on a persistent 5xx with the status in the error', async () => {
    let calls = 0;
    const transport = createLiveTransport({
      apiKey: API_KEY,
      fetchImpl: async () => {
        calls += 1;
        return new Response('down', { status: 502 });
      },
      sleep: async () => {},
    });
    await assert.rejects(transport.call('GetPageStats'), /GetPageStats failed with HTTP 502 after 4 attempts/);
    assert.equal(calls, 4);
  });

  it('keeps every committed Bing artifact free of the key markers and the site URL', () => {
    const root = repoPath('docs/research/seo-ai-visibility/bing');
    const files = readdirSync(root).map((name) => join(root, name));
    assert.ok(files.length > 0, 'the Bing research directory must not be empty');
    for (const path of files) {
      assert.doesNotThrow(() => assertNoSecrets(readFileSync(path, 'utf8')), path);
    }
  });
});

describe('Bing Webmaster collector CLI', () => {
  it('writes a dated snapshot and a markdown summary from fixtures', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-bing-'));
    try {
      const { written } = await runCli(
        ['--fixtures', FIXTURES, '--out-dir', outDir, '--date', '2026-11-03'],
        { log: silent },
      );
      assert.deepEqual(written, [join(outDir, '2026-11-03.json'), join(outDir, '2026-11-03.md')]);
      const snapshot = JSON.parse(readFileSync(written[0], 'utf8'));
      assert.equal(snapshot.source, 'fixtures');
      assert.match(readFileSync(written[1], 'utf8'), /^# Bing Webmaster snapshot 2026-11-02\n/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('prints instead of writing with --stdout', async () => {
    const printed = [];
    const { written } = await runCli(['--fixtures', FIXTURES, '--stdout'], { log: (line) => printed.push(line) });
    assert.deepEqual(written, []);
    assert.equal(JSON.parse(printed[0]).snapshotId, 'bing-2026-11-02');
  });

  it('fails a live run with no key before calling Bing', async () => {
    await assert.rejects(runCli(['--live', '--stdout'], { env: {}, log: silent }), /BING_WEBMASTER_API_KEY is not set/);
  });

  it('rejects conflicting or malformed arguments', async () => {
    await assert.rejects(runCli([], { log: silent }), /pass --fixtures <dir> or --live/);
    await assert.rejects(runCli(['--live', '--fixtures', FIXTURES], { log: silent }), /mutually exclusive/);
    await assert.rejects(runCli(['--fixtures', FIXTURES, '--date', '11/02/2026'], { log: silent }), /YYYY-MM-DD/);
    await assert.rejects(runCli(['--fixtures', FIXTURES, '--bogus'], { log: silent }), /unknown argument --bogus/);
  });
});
