// #4922: markets↔news wiring — macro-print actuals, earnings into the
// daily market brief, and the finance-demotion seam.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_SERIES, computePrintValues, fillEventActuals } from '../scripts/_econ-actuals.mjs';
import { scoreImportance } from '../scripts/_clustering.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

describe('computePrintValues (#4922b)', () => {
  it('pct_mom: index levels become MoM % change with a previous period', () => {
    const obs = [
      { date: '2026-06-01', value: '321.5' },
      { date: '2026-05-01', value: '320.2' },
      { date: '2026-04-01', value: '319.9' },
    ];
    const out = computePrintValues(obs, 'pct_mom');
    assert.equal(out.actual, '+0.4', 'unitless — event.unit carries the % (double-render fix)');
    assert.equal(out.previous, '+0.1');
    assert.equal(out.obsDate, '2026-06-01');
  });

  it('diff_k: payroll levels become monthly change in K', () => {
    const obs = [
      { date: '2026-06-01', value: '159412' },
      { date: '2026-05-01', value: '159190' },
      { date: '2026-04-01', value: '159305' },
    ];
    const out = computePrintValues(obs, 'diff_k');
    assert.equal(out.actual, '+222', 'unitless — event.unit carries the K');
    assert.equal(out.previous, '-115');
  });

  it('direct: headline % series passes through', () => {
    const out = computePrintValues([
      { date: '2026-04-01', value: '2.8' },
      { date: '2026-01-01', value: '3.1' },
    ], 'direct');
    assert.equal(out.actual, '2.8');
    assert.equal(out.previous, '3.1');
  });

  it("FRED '.' missing markers and short series degrade to empty strings", () => {
    assert.equal(computePrintValues([{ date: '2026-06-01', value: '.' }], 'pct_mom').actual, '');
    assert.equal(computePrintValues([{ date: '2026-06-01', value: '321.5' }], 'pct_mom').actual, '');
    assert.equal(computePrintValues([], 'direct').actual, '');
  });

  it("a '.' LEADING observation never falls back to an older row as 'current'", () => {
    const out = computePrintValues([
      { date: '2026-06-01', value: '.' },
      { date: '2026-05-01', value: '320.2' },
      { date: '2026-04-01', value: '319.9' },
    ], 'pct_mom');
    assert.equal(out.actual, '', 'print not out yet — must not present the prior month as current');
  });

  it('a mid-series month gap rejects the pair instead of mislabeling a 2-month change', () => {
    const out = computePrintValues([
      { date: '2026-06-01', value: '321.5' },
      { date: '2026-03-01', value: '318.0' },
    ], 'pct_mom');
    assert.equal(out.actual, '', 'non-adjacent periods must not compute as MoM');
  });

  it('EVENT_SERIES keys stay in lockstep with FRED_RELEASES event names', async () => {
    const src = readSrc('scripts/seed-economic-calendar.mjs');
    for (const eventName of Object.keys(EVENT_SERIES)) {
      assert.ok(src.includes(`event: '${eventName}'`), `FRED_RELEASES must contain '${eventName}' — the maps correlate by name`);
    }
  });

  it('every mapped event has a series and transform', () => {
    for (const [event, mapping] of Object.entries(EVENT_SERIES)) {
      assert.ok(mapping.series.length > 2, `${event} series`);
      assert.ok(['pct_mom', 'diff_k', 'direct'].includes(mapping.transform), `${event} transform`);
    }
  });
});

describe('fillEventActuals (#4922b)', () => {
  const TODAY = '2026-07-06';

  it('fills print-day events and counts them; leaves future events empty', () => {
    const events = [
      { event: 'CPI', date: '2026-07-06', actual: '', previous: '' },
      { event: 'CPI', date: '2026-07-20', actual: '', previous: '' },
      { event: 'FOMC Rate Decision', date: '2026-07-06', actual: '', previous: '' },
    ];
    const filled = fillEventActuals(events, { CPI: { actual: '+0.3', previous: '+0.2', obsDate: '2026-06-01' } }, TODAY);
    assert.equal(filled, 1);
    assert.equal(events[0].actual, '+0.3');
    assert.equal(events[0].previous, '+0.2');
    assert.equal(events[1].actual, '', 'future release stays empty');
    assert.equal(events[2].actual, '', 'unmapped event untouched');
  });

  it('never overwrites an existing actual', () => {
    const events = [{ event: 'CPI', date: '2026-07-06', actual: '+0.9', previous: '' }];
    const filled = fillEventActuals(events, { CPI: { actual: '+0.3', previous: '+0.2', obsDate: '2026-06-01' } }, TODAY);
    assert.equal(filled, 0);
    assert.equal(events[0].actual, '+0.9');
  });
});

describe('finance demotion seam (#4922f)', () => {
  const financeCluster = {
    primaryTitle: 'Startup CEO announces record quarterly revenue and IPO plans',
    primarySource: 'TechCrunch',
    primaryLink: 'https://t/1',
    pubDate: new Date().toISOString(),
    sources: ['TechCrunch'],
    isAlert: false,
    tier: 3,
  };

  it('demotes finance-keyword clusters by default, ranks neutrally when disabled', () => {
    const demoted = scoreImportance({ ...financeCluster });
    const neutral = scoreImportance({ ...financeCluster }, { demoteFinance: false });
    assert.ok(neutral > demoted, `neutral (${neutral}) must exceed demoted (${demoted})`);
    assert.ok(Math.abs(demoted / neutral - 0.35) < 0.01, 'default demotion is the documented ×0.35');
  });
});

describe('wiring (source-textual)', () => {
  it('economic calendar publishes recentPrints and fills actuals', () => {
    const src = readSrc('scripts/seed-economic-calendar.mjs');
    assert.match(src, /fred\/series\/observations\?series_id=/);
    assert.match(src, /fillEventActuals\(events, printsByEvent, today\)/);
    assert.match(src, /recentPrints/);
  });

  it('daily market brief consumes earnings context in prompt and options', () => {
    const src = readSrc('src/services/daily-market-brief.ts');
    assert.match(src, /earningsContext\?: EarningsBriefContext/);
    assert.match(src, /Upcoming earnings \(14d\)/);
    const loader = readSrc('src/app/data-loader.ts');
    assert.match(loader, /_collectEarningsContext/);
    assert.match(loader, /listEarningsCalendar\(\{/);
  });
});

// ── #4929 review-round additions ───────────────────────────────────────────

import { buildEarningsBriefContext } from '../src/services/daily-market-brief.ts';
import { selectTopStories } from '../scripts/_clustering.mjs';

describe('buildEarningsBriefContext (pure, #4929 review)', () => {
  const TODAY = '2026-07-06';
  const entries = [
    { symbol: 'MSFT', date: '2026-07-03', hasActuals: true, surpriseDirection: 'beat' },
    { symbol: 'TSLA', date: '2026-07-05', hasActuals: true, surpriseDirection: 'miss' },
    { symbol: 'ORCL', date: '2026-07-01', hasActuals: true, surpriseDirection: '' },
    { symbol: 'AAPL', date: '2026-07-10', hasActuals: false },
    { symbol: 'NVDA', date: '2026-07-12', hasActuals: false },
  ];

  it('collects recent beats/misses newest-first and counts upcoming', () => {
    const out = buildEarningsBriefContext(entries, TODAY);
    assert.ok(out);
    assert.deepEqual(out.recent.map((r) => r.symbol), ['TSLA', 'MSFT'], 'no-surprise reporters excluded');
    assert.equal(out.upcomingCount, 2);
  });

  it('returns undefined when there is nothing to say', () => {
    assert.equal(buildEarningsBriefContext([], TODAY), undefined);
    assert.equal(buildEarningsBriefContext([{ symbol: 'X', date: '2026-06-01', hasActuals: true, surpriseDirection: '' }], TODAY), undefined);
  });
});

describe('earnings context in the brief prompt (#4929 review)', () => {
  it('renders the earnings block into geoContext and is stable across rebuilds', async () => {
    const { buildDailyMarketBrief } = await import('../src/services/daily-market-brief.ts');
    const captured = [];
    const opts = {
      markets: [{ symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 212, change: 1.0 }],
      newsByCategory: { markets: [{ source: 'Reuters', title: 'Apple extends gains after strong outlook', link: 'https://x', pubDate: new Date('2026-07-06T01:00:00Z'), isAlert: false }] },
      timezone: 'UTC',
      now: new Date('2026-07-06T10:30:00.000Z'),
      earningsContext: { recent: [{ symbol: 'MSFT', direction: 'beat' }, { symbol: 'TSLA', direction: 'miss' }], upcomingCount: 12 },
      summarize: async (_h, _p, geoContext) => {
        captured.push(geoContext ?? '');
        return { summary: 'A stable-enough one liner for the earnings capture test.', provider: 't', model: 't', cached: false };
      },
    };
    await buildDailyMarketBrief(opts);
    await buildDailyMarketBrief(opts);
    assert.match(captured[0], /Earnings: MSFT beat, TSLA miss/);
    assert.match(captured[0], /Upcoming earnings \(14d\): 12/);
    assert.equal(captured[1], captured[0], 'earnings block must not churn the cache identity across rebuilds');
  });
});

describe('selectTopStories opts pass-through (#4929 review)', () => {
  it('demoteFinance:false changes the ranking through the selection path', () => {
    const finance = {
      primaryTitle: 'Startup CEO announces record quarterly revenue and IPO plans today',
      primarySource: 'TechCrunch', primaryLink: 'https://t/1',
      pubDate: new Date().toISOString(), sources: ['TechCrunch', 'The Verge'], isAlert: true, tier: 2,
    };
    const geo = {
      primaryTitle: 'Border clashes escalate along disputed frontier region overnight',
      primarySource: 'Reuters', primaryLink: 'https://r/2',
      pubDate: new Date().toISOString(), sources: ['Reuters', 'BBC'], isAlert: true, tier: 2,
    };
    const demoted = selectTopStories([finance, geo], 8);
    const neutral = selectTopStories([finance, geo], 8, undefined, { demoteFinance: false });
    const dScore = demoted.find((s) => s.primarySource === 'TechCrunch').importanceScore;
    const nScore = neutral.find((s) => s.primarySource === 'TechCrunch').importanceScore;
    assert.ok(nScore > dScore, 'opts must thread through selectTopStories to scoreImportance');
  });
});

// ── #4929 external-review round ────────────────────────────────────────────

import { observationMatchesRelease } from '../scripts/_econ-actuals.mjs';

describe('release-day stale-print guard (#4929 external review P1)', () => {
  it('REGRESSION: pre-print on release day, the prior-period observation is NOT presented as the print', () => {
    // July 15 CPI release reports JUNE. Before 08:30 ET the latest FRED
    // obs is still MAY — filling with it showed a stale number as today's.
    const events = [{ event: 'CPI', date: '2026-07-15', actual: '', previous: '' }];
    const stale = fillEventActuals(events, { CPI: { actual: '+0.2', previous: '+0.3', obsDate: '2026-05-01' } }, '2026-07-15');
    assert.equal(stale, 0, 'May observation must not fill the June-reporting release');
    assert.equal(events[0].actual, '');

    const fresh = fillEventActuals(events, { CPI: { actual: '+0.3', previous: '+0.2', obsDate: '2026-06-01' } }, '2026-07-15');
    assert.equal(fresh, 1, 'June observation fills the June-reporting release');
  });

  it('quarterly GDP tolerates the advance/second/third estimate window', () => {
    assert.equal(observationMatchesRelease('2026-07-30', '2026-04-01', 'q'), true, 'advance estimate: Q2 obs, July release');
    assert.equal(observationMatchesRelease('2026-09-25', '2026-04-01', 'q'), true, 'third estimate');
    assert.equal(observationMatchesRelease('2026-07-30', '2026-01-01', 'q'), false, 'stale prior quarter rejected');
  });
});

describe('misplaced-opts guard (#4929 external review)', () => {
  it('passing { demoteFinance:false } in the stats slot still disables demotion', () => {
    const finance = {
      primaryTitle: 'Startup CEO announces record quarterly revenue and IPO plans today',
      primarySource: 'TechCrunch', primaryLink: 'https://t/1',
      pubDate: new Date().toISOString(), sources: ['TechCrunch', 'The Verge'], isAlert: true, tier: 2,
    };
    const shifted = selectTopStories([finance], 8, { demoteFinance: false });
    const explicit = selectTopStories([finance], 8, undefined, { demoteFinance: false });
    assert.equal(shifted[0].importanceScore, explicit[0].importanceScore, 'opts in the stats slot must auto-shift');
  });
});

describe('recall benchmark fast-fail wiring (source-textual)', () => {
  it('uses benchmark-grade limits and a shared GDELT deadline', () => {
    const src = readSrc('scripts/seed-recall-benchmark.mjs');
    assert.match(src, /maxRetries: 1/);
    assert.match(src, /proxyMaxAttempts: 1/);
    assert.match(src, /GDELT_DEADLINE_MS = 4 \* 60 \* 1000/);
  });
});
