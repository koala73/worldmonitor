import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeNqCatalystsHtml,
  calendarFreshnessLabelForAsOf,
  filterNqEarnings,
  filterNqMacroEvents,
  NQ_EARNINGS_EMPTY,
  NQ_MACRO_EMPTY,
  NQ_SECTION_UNAVAILABLE,
} from '../src/components/nq-catalysts-content.ts';
import { nqCalendarWindow } from '../src/components/nq-calendar-window.ts';
import { NQ_PULSE_DISCLOSURE } from '../src/config/nq-context.ts';
import {
  enabledNewsCategoryKeys,
  resolveNewsCategories,
} from '../src/config/feed-resolution.ts';
import { buildEconomicCalendarResponse } from '../server/worldmonitor/economic/v1/get-economic-calendar.ts';
import { buildEarningsCalendarResponse } from '../server/worldmonitor/market/v1/list-earnings-calendar.ts';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import type { Feed } from '../src/types/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(root, 'tmp-nq-catalysts-feeds-test');
const now = new Date('2026-08-31T14:00:00.000Z');

interface FeedsModule {
  FEEDS: Record<string, Feed[]>;
  CANONICAL_FEEDS: Record<string, Feed[]>;
  ON_DEMAND_FEEDS: Record<string, Feed[]>;
}

let feeds: FeedsModule;

before(async () => {
  feeds = await bundleFeedsModule<FeedsModule>({
    repoRoot: root,
    tempDir,
  });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('NQ Catalysts filters', () => {
  it('uses inclusive windows with exactly seven and fourteen local calendar dates', () => {
    assert.deepEqual(nqCalendarWindow(now, 7), { from: '2026-08-31', to: '2026-09-06' });
    assert.deepEqual(nqCalendarWindow(now, 14), { from: '2026-08-31', to: '2026-09-13' });

    const macro = filterNqMacroEvents([
      { event: 'Day seven', country: 'US', date: '2026-09-06', impact: 'High' },
      { event: 'Day eight', country: 'US', date: '2026-09-07', impact: 'High' },
    ], now);
    assert.deepEqual(macro.map((event) => event.event), ['Day seven']);

    const earnings = filterNqEarnings([
      { symbol: 'AAPL', company: 'Apple', date: '2026-09-13' },
      { symbol: 'MSFT', company: 'Microsoft', date: '2026-09-14' },
    ], now);
    assert.deepEqual(earnings.map((entry) => entry.symbol), ['AAPL']);
  });

  it('keeps only high-impact US macro events in the next seven days', () => {
    const filtered = filterNqMacroEvents([
      { event: 'CPI', country: 'US', date: '2026-09-02', impact: 'High' },
      { event: 'ECB Rate', country: 'EU', date: '2026-09-02', impact: 'High' },
      { event: 'Retail Sales', country: 'US', date: '2026-09-02', impact: 'Medium' },
      { event: 'Old NFP', country: 'US', date: '2026-08-20', impact: 'High' },
      { event: 'Too Far', country: 'US', date: '2026-09-20', impact: 'High' },
    ], now);
    assert.deepEqual(filtered.map((event) => event.event), ['CPI']);
  });

  it('keeps influence-basket earnings in chronological order and drops unrelated names', () => {
    const filtered = filterNqEarnings([
      { symbol: 'IBM', company: 'IBM', date: '2026-09-01', hour: 'amc' },
      { symbol: 'NVDA', company: 'NVIDIA', date: '2026-09-10', hour: 'amc' },
      { symbol: 'AAPL', company: 'Apple', date: '2026-09-03', hour: 'bmo' },
      { symbol: 'MSFT', company: 'Microsoft', date: '2026-08-01' },
      { symbol: 'TSLA', company: 'Tesla', date: '2026-09-20' },
    ], now);
    assert.deepEqual(filtered.map((entry) => entry.symbol), ['AAPL', 'NVDA']);
    assert.equal(filtered[0]?.hour, 'bmo');
  });

  it('distinguishes empty, unavailable, and partial catalyst sections', () => {
    const empty = composeNqCatalystsHtml({
      macro: [],
      earnings: [],
      macroUnavailable: false,
      earningsUnavailable: false,
      nowMs: now.getTime(),
    });
    assert.match(empty, new RegExp(NQ_MACRO_EMPTY));
    assert.match(empty, new RegExp(NQ_EARNINGS_EMPTY));
    assert.doesNotMatch(empty, /IBM|ORCL|JPM/);

    const unavailable = composeNqCatalystsHtml({
      macro: [],
      earnings: [],
      macroUnavailable: true,
      earningsUnavailable: true,
      nowMs: now.getTime(),
    });
    assert.match(unavailable, new RegExp(NQ_SECTION_UNAVAILABLE));
    assert.equal((unavailable.match(new RegExp(NQ_SECTION_UNAVAILABLE, 'g')) ?? []).length, 2);

    const partial = composeNqCatalystsHtml({
      macro: [{ event: 'CPI', country: 'US', date: '2026-09-02', impact: 'High' }],
      earnings: [],
      macroUnavailable: false,
      earningsUnavailable: false,
      macroAsOf: '2026-08-31T12:00:00.000Z',
      nowMs: now.getTime(),
    });
    assert.match(partial, /CPI/);
    assert.match(partial, new RegExp(NQ_EARNINGS_EMPTY));
    assert.match(partial, /Time unknown/);
    assert.ok(partial.includes(NQ_PULSE_DISCLOSURE));
  });

  it('preserves unknown macro times and earnings hour when present', () => {
    const html = composeNqCatalystsHtml({
      macro: [{ event: 'FOMC', country: 'US', date: '2026-09-01', impact: 'High' }],
      earnings: [{ symbol: 'AAPL', company: 'Apple', date: '2026-09-03', hour: 'amc' }],
      macroUnavailable: false,
      earningsUnavailable: false,
      nowMs: now.getTime(),
    });
    assert.match(html, /Time unknown/);
    assert.match(html, />amc</);
    assert.doesNotMatch(html, /08:30|14:00 ET|release at/);
  });

  it('uses the 12-hour and 24-hour calendar freshness boundaries', () => {
    const nowMs = Date.parse('2026-08-31T18:00:00.000Z');
    assert.equal(calendarFreshnessLabelForAsOf('2026-08-31T06:00:00.000Z', nowMs), 'Current');
    assert.equal(calendarFreshnessLabelForAsOf('2026-08-31T05:59:59.999Z', nowMs), 'Delayed');
    assert.equal(calendarFreshnessLabelForAsOf('2026-08-30T18:00:00.000Z', nowMs), 'Delayed');
    assert.equal(calendarFreshnessLabelForAsOf('2026-08-30T17:59:59.999Z', nowMs), 'Stale');
    assert.equal(calendarFreshnessLabelForAsOf(undefined, nowMs), 'Freshness unavailable');
  });

  it('carries seed asOf through calendar handlers', () => {
    const macro = buildEconomicCalendarResponse({
      events: [{ event: 'CPI', country: 'US', date: '2026-09-02', impact: 'High', actual: '', estimate: '', previous: '', unit: '' }],
      fromDate: '2026-08-31',
      toDate: '2026-09-07',
      total: 1,
      unavailable: false,
      asOf: '2026-08-31T12:00:00.000Z',
    }, { fromDate: '2026-08-31', toDate: '2026-09-07' });
    assert.equal(macro.asOf, '2026-08-31T12:00:00.000Z');

    const earnings = buildEarningsCalendarResponse({
      earnings: [{
        symbol: 'AAPL', company: 'Apple', date: '2026-09-03', hour: 'bmo',
        epsEstimate: 1, revenueEstimate: 1, epsActual: 0, revenueActual: 0,
        hasActuals: false, surpriseDirection: '',
      }],
      asOf: '2026-08-31T13:00:00.000Z',
    }, { fromDate: '2026-08-31', toDate: '2026-09-14' });
    assert.equal(earnings.asOf, '2026-08-31T13:00:00.000Z');
  });
});

describe('on-demand NQ News', () => {
  it('registers five curated nq-news feeds in the canonical registry only', () => {
    assert.equal(feeds.ON_DEMAND_FEEDS['nq-news']?.length, 5);
    assert.equal(feeds.CANONICAL_FEEDS['nq-news']?.length, 5);
    assert.equal(Object.hasOwn(feeds.FEEDS, 'nq-news'), false);
    assert.ok(feeds.ON_DEMAND_FEEDS['nq-news']?.some((feed) => {
      const url = typeof feed.url === 'string' ? feed.url : '';
      return url.includes('federalreserve.gov/feeds/press_all.xml');
    }));
    const financeSrc = readFileSync(resolve(root, 'src/config/feeds.ts'), 'utf8');
    const financeBody = financeSrc.slice(
      financeSrc.indexOf('const FINANCE_FEEDS: Record<string, Feed[]> = {'),
      financeSrc.indexOf('const HAPPY_FEEDS: Record<string, Feed[]> = {'),
    );
    assert.equal(financeBody.includes("'nq-news'"), false);
  });

  it('resolves nq-news only while that panel is enabled', () => {
    const disabled = resolveNewsCategories(feeds.FEEDS, feeds.CANONICAL_FEEDS, enabledNewsCategoryKeys(
      new Map([['nq-news', 'nq-news'], ['live-news', 'live-news']]),
      { 'nq-news': { enabled: false }, 'live-news': { enabled: true } },
    ));
    assert.equal(disabled.some((category) => category.key === 'nq-news'), false);

    const enabled = resolveNewsCategories(feeds.FEEDS, feeds.CANONICAL_FEEDS, enabledNewsCategoryKeys(
      new Map([['nq-news', 'nq-news']]),
      { 'nq-news': { enabled: true } },
    ));
    const nq = enabled.find((category) => category.key === 'nq-news');
    assert.ok(nq);
    assert.equal(nq.isCustom, true);
    assert.equal(nq.feeds.length, 5);
  });
});
