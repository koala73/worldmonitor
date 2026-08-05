import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  CHINA_STOCK_CONNECT_MAX_NETWORK_MS,
  HISTORY_LIMIT,
  NORTHBOUND_NET_FLOW_UNAVAILABLE_REASON,
  STOCK_CONNECT_SOURCE_CONTRACTS,
  STOCK_CONNECT_SOURCE_IDS,
  buildChinaStockConnectSnapshot,
  fetchChinaStockConnectSnapshot,
  normalizeSseMargin,
  normalizeSseNorthbound,
  normalizeSzseMargin,
  normalizeSzseNorthbound,
  normalizeSzseTradingCalendar,
  parseExchangeNumber,
  tradingDayCandidates,
  weekdayCandidates,
} from '../scripts/china-stock-connect/adapters.mjs';
import {
  chinaStockConnectContentMeta,
  chinaStockConnectRecordCount,
  validateChinaStockConnectSnapshot,
} from '../scripts/seed-china-stock-connect.mjs';

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/china-stock-connect');
const fixture = (name: string) => JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'));

// Captured live from SSE/SZSE on 2026-08-05.
const sseNorthboundFixture = fixture('sse-northbound-daily.json');
const sseMarginFixture = fixture('sse-margin-summary.json');
const szseNorthboundFixture = fixture('szse-northbound-daily.json');
const szseMarginFixture = fixture('szse-margin-summary.json');
const szseNorthboundEmptyFixture = fixture('szse-northbound-empty.json');
const szseCalendarFixture = fixture('szse-trading-calendar.json');

const YI = 100_000_000;

// The adapter asserts on response.url, which cannot be set through the Response
// constructor. This stub mirrors just enough of the interface.
function stubResponse(payload: unknown, url: string) {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    redirected: false,
    url,
    headers: new Headers({
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(body).byteLength),
    }),
    text: async () => body,
  };
}

interface FetchLogEntry {
  url: string;
  init: RequestInit;
}

/**
 * Routes the four live endpoints plus the calendar off the captured fixtures.
 * `overrides` replaces the payload for any URL substring, so a test can make a
 * single source empty or malformed without restating the others.
 */
function fixtureFetch(
  log: FetchLogEntry[],
  overrides: Array<[string, unknown | (() => never)]> = [],
) {
  return async (input: unknown, init: RequestInit) => {
    const url = String(input);
    log.push({ url, init });
    for (const [needle, payload] of overrides) {
      if (url.includes(needle)) {
        if (typeof payload === 'function') (payload as () => never)();
        return stubResponse(payload, url);
      }
    }
    if (url.includes('onepersistenthour/monthList')) {
      return stubResponse(szseCalendarFixture, url);
    }
    if (url.includes('FW_HGTZL_HGTSCSJ_HGTCJGK_MRTJ')) {
      return stubResponse(sseNorthboundFixture, url);
    }
    if (url.includes('queryMargin.do')) {
      return stubResponse(sseMarginFixture, url);
    }
    if (url.includes('CATALOGID=SGT_SGTJYRB')) {
      const day = new URL(url).searchParams.get('txtDate');
      return stubResponse(
        day === '2026-08-04' ? szseNorthboundFixture : szseNorthboundEmptyFixture,
        url,
      );
    }
    if (url.includes('CATALOGID=1837_xxpl')) {
      const day = new URL(url).searchParams.get('txtDate');
      return stubResponse(
        day === '2026-08-03' ? szseMarginFixture : szseNorthboundEmptyFixture,
        url,
      );
    }
    throw new Error(`unexpected url ${url}`);
  };
}

// 2026-08-05T04:00 Beijing -- inside the session that has not published yet, so
// the newest available northbound day is 08-04 and margin is 08-03.
const NOW = Date.parse('2026-08-04T20:00:00.000Z');

async function fetchWithFixtures(options: Record<string, unknown> = {}) {
  const log: FetchLogEntry[] = [];
  const snapshot = await fetchChinaStockConnectSnapshot({
    fetchFn: fixtureFetch(log, (options.overrides as never) ?? []),
    proxyUrl: '',
    sseProxyUrl: '',
    edgeEgress: null,
    now: NOW,
    onDecision: () => {},
    ...options,
  });
  return { snapshot, log };
}

describe('China Stock Connect northbound + margin (#6155)', () => {
  describe('numeric parsing and unit normalisation', () => {
    it('parses the grouped strings both exchanges publish', () => {
      assert.equal(parseExchangeNumber('1,354.49'), 1354.49);
      assert.equal(parseExchangeNumber('617.56'), 617.56);
      assert.equal(parseExchangeNumber(1_323_258_064_454), 1_323_258_064_454);
    });

    it('rejects anything that is not a plain number rather than coercing it', () => {
      for (const value of [
        '', '-', 'n/a', '--', '1.2.3', '1e5', '0x10', ' ',
        // Malformed grouping. Stripping separators before validating turns
        // each of these into a confident, wrong number.
        '1,2,', '1,2', ',123', '1,,000', '12,34,567', '1,000,',
        null, undefined, {}, [], NaN,
      ]) {
        assert.equal(parseExchangeNumber(value as never), null, JSON.stringify(value));
      }
    });

    it('accepts both grouped and ungrouped forms the exchanges actually emit', () => {
      assert.equal(parseExchangeNumber('12,489.16'), 12_489.16);
      assert.equal(parseExchangeNumber('1,337,464.97'), 1_337_464.97);
      assert.equal(parseExchangeNumber('0.00'), 0);
      assert.equal(parseExchangeNumber('617.56'), 617.56);
      assert.equal(parseExchangeNumber('-1.5'), -1.5);
    });

    it('scales SSE northbound from 亿元 and 万笔 to CNY and whole trades', () => {
      const normalized = normalizeSseNorthbound(sseNorthboundFixture);
      assert.equal(normalized.tradeDate, '2026-08-04');
      // 1,354.49 亿元
      assert.equal(normalized.turnoverCny, 135_449_000_000);
      // 617.56 万笔 -- a trade count, not a share count, and an integer.
      assert.equal(normalized.tradeCount, 6_175_600);
      assert.equal(Number.isInteger(normalized.tradeCount), true);
      assert.equal(normalized.etfTurnoverCny, 4_187_000_000);
    });

    it('keeps SSE margin in yuan, because that endpoint alone publishes yuan', () => {
      const rows = normalizeSseMargin(sseMarginFixture);
      assert.equal(rows[0].tradeDate, '2026-08-03');
      assert.equal(rows[0].financingBalanceCny, 1_323_258_064_454);
      assert.equal(rows[0].securitiesLendingBalanceCny, 14_206_903_655);
      // The exchange's own total is financing + lending; if the field mapping
      // ever slipped this identity is what would break.
      assert.equal(
        rows[0].totalBalanceCny,
        rows[0].financingBalanceCny + rows[0].securitiesLendingBalanceCny,
      );
    });

    it('returns SSE margin newest-first so history backfill is ordered', () => {
      const rows = normalizeSseMargin(sseMarginFixture);
      assert.ok(rows.length > 1);
      for (let i = 1; i < rows.length; i += 1) {
        assert.ok(rows[i - 1].tradeDate > rows[i].tradeDate);
      }
    });

    it('reads the SZSE northbound labels without confusing ETF for headline turnover', () => {
      const normalized = normalizeSzseNorthbound(szseNorthboundFixture);
      assert.equal(normalized.tradeDate, '2026-08-04');
      assert.equal(normalized.turnoverCny, 160_909_000_000); // 1,609.09 亿元
      assert.equal(normalized.etfTurnoverCny, 3_338_000_000); // 33.38 亿元
      assert.equal(normalized.tradeCount, 6_990_400); // 699.04 万笔
      // 当日ETF交易总额 contains 交易总额 as a substring; a naive ordering here
      // silently reports the ETF row as the headline number.
      assert.notEqual(normalized.turnoverCny, normalized.etfTurnoverCny);
    });

    it('scales SZSE margin from 亿元 to CNY', () => {
      const normalized = normalizeSzseMargin(szseMarginFixture);
      assert.equal(normalized.tradeDate, '2026-08-03');
      assert.equal(normalized.financingBalanceCny, 1_248_916_000_000); // 12,489.16 亿元
      assert.equal(normalized.securitiesLendingBalanceCny, 7_963_000_000);
      assert.equal(
        normalized.totalBalanceCny,
        normalized.financingBalanceCny + normalized.securitiesLendingBalanceCny,
      );
    });

    it('treats an unpublished SZSE date as no data, not as a zero reading', () => {
      assert.equal(normalizeSzseNorthbound(szseNorthboundEmptyFixture), null);
      assert.equal(normalizeSzseMargin(szseNorthboundEmptyFixture), null);
    });

    it('drops only the unusable SSE margin rows, keeping the rest', () => {
      // The per-row skip is degrade-not-crash behaviour, so it has to be
      // exercised with an actually-bad row: a payload of all-good rows would
      // pass even if the skip condition were inverted.
      const good = sseMarginFixture.pageHelp.data[0];
      const payload = {
        pageHelp: {
          data: [
            { ...good, opDate: null },
            { ...good, opDate: '20260731' },
            { ...good, rzye: 'n/a' },
            { ...good, opDate: 'not-a-date' },
          ],
        },
      };
      const rows = normalizeSseMargin(payload);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tradeDate, '2026-07-31');
    });
  });

  describe('trading calendar and date probing', () => {
    it('keeps only days the exchange flags as trading days', () => {
      const days = normalizeSzseTradingCalendar(szseCalendarFixture);
      assert.ok(days.includes('2026-08-04'));
      // 2026-08-01 and 08-02 are a weekend (jybz "0").
      assert.equal(days.includes('2026-08-01'), false);
      assert.equal(days.includes('2026-08-02'), false);
    });

    it('probes newest-first and never ahead of today', () => {
      const days = normalizeSzseTradingCalendar(szseCalendarFixture);
      const candidates = tradingDayCandidates(days, '2026-08-05', 4);
      assert.deepEqual(candidates, ['2026-08-05', '2026-08-04', '2026-08-03', '2026-07-31']
        .filter((day) => days.includes(day)));
      for (const day of candidates) assert.ok(day <= '2026-08-05');
    });

    it('falls back to weekdays when the calendar cannot be fetched', () => {
      // 2026-08-05 is a Wednesday.
      assert.deepEqual(
        weekdayCandidates('2026-08-05', 4),
        ['2026-08-05', '2026-08-04', '2026-08-03', '2026-07-31'],
      );
    });

    it('walks back a month when the current one has too few trading days', async () => {
      // NOW sits early enough in August that the fixture yields fewer than
      // SZSE_MAX_DATE_PROBES eligible days, so previousMonth() must be asked
      // for July. Without asserting the month params this branch runs but is
      // never checked -- the fixture answers identically for any month.
      const { log } = await fetchWithFixtures();
      const months = log
        .filter((entry) => entry.url.includes('onepersistenthour/monthList'))
        .map((entry) => new URL(entry.url).searchParams.get('month'));
      assert.deepEqual(months, ['2026-08', '2026-07']);
    });

    it('rolls the month walk-back across a year boundary', async () => {
      const log: FetchLogEntry[] = [];
      await fetchChinaStockConnectSnapshot({
        fetchFn: fixtureFetch(log, [['onepersistenthour/monthList', { data: [] }]]),
        proxyUrl: '',
        sseProxyUrl: '',
        edgeEgress: null,
        now: Date.parse('2026-01-02T00:00:00.000Z'),
        onDecision: () => {},
      });
      const months = log
        .filter((entry) => entry.url.includes('onepersistenthour/monthList'))
        .map((entry) => new URL(entry.url).searchParams.get('month'));
      assert.deepEqual(months, ['2026-01', '2025-12']);
    });

    it('marks the snapshot when the weekday fallback was used', async () => {
      const { snapshot } = await fetchWithFixtures({
        overrides: [['onepersistenthour/monthList', () => { throw new Error('boom'); }]],
      });
      assert.equal(snapshot.calendarStatus, 'weekday_fallback');
      // The fallback still reaches real data; it only loses holiday awareness.
      assert.equal(snapshot.northbound.turnoverCny.status, 'known');
    });
  });

  describe('snapshot assembly', () => {
    it('combines both exchanges and reports every source', async () => {
      const { snapshot } = await fetchWithFixtures();
      assert.equal(snapshot.schemaVersion, 1);
      assert.equal(snapshot.countryCode, 'CN');
      assert.equal(snapshot.status, 'healthy');
      assert.equal(snapshot.northbound.tradeDate, '2026-08-04');
      assert.equal(
        snapshot.northbound.turnoverCny.value,
        135_449_000_000 + 160_909_000_000,
      );
      assert.equal(snapshot.margin.tradeDate, '2026-08-03');
      assert.equal(
        snapshot.margin.totalBalanceCny.value,
        1_337_464_968_109 + 1_256_879_000_000,
      );
      assert.deepEqual(
        snapshot.sources.map((source: { id: string }) => source.id),
        STOCK_CONNECT_SOURCE_IDS,
      );
      assert.equal(validateChinaStockConnectSnapshot(snapshot), true);
    });

    it('rejects every malformed snapshot shape, arm by arm', async () => {
      // validateChinaStockConnectSnapshot is the publish gate: if it wrongly
      // returns true, a malformed payload reaches the canonical key that
      // api/health.js and the coverage manifest trust. Testing one arm leaves
      // the other seven free to rot.
      const { snapshot } = await fetchWithFixtures();
      assert.equal(validateChinaStockConnectSnapshot(snapshot), true);

      const mutations: Array<[string, Record<string, unknown>]> = [
        ['wrong schemaVersion', { schemaVersion: 2 }],
        ['missing schemaVersion', { schemaVersion: undefined }],
        ['wrong country', { countryCode: 'US' }],
        ['status outside the enum', { status: 'ok' }],
        ['sources not an array', { sources: {} }],
        ['history not an array', { history: null }],
        ['northbound missing', { northbound: null }],
        ['margin missing', { margin: undefined }],
        ['netFlow claimed as known', {
          northbound: { ...snapshot.northbound, netFlow: { status: 'known', value: 1 } },
        }],
        ['a source dropped', { sources: snapshot.sources.slice(1) }],
      ];
      for (const [label, patch] of mutations) {
        assert.equal(
          validateChinaStockConnectSnapshot({ ...snapshot, ...patch }),
          false,
          `accepted a snapshot with: ${label}`,
        );
      }
      assert.equal(validateChinaStockConnectSnapshot(null), false);
      assert.equal(validateChinaStockConnectSnapshot(undefined), false);
    });

    it('never claims a northbound net flow', async () => {
      const { snapshot } = await fetchWithFixtures();
      assert.equal(snapshot.northbound.netFlow.status, 'unavailable');
      assert.equal(
        snapshot.northbound.netFlow.reason,
        NORTHBOUND_NET_FLOW_UNAVAILABLE_REASON,
      );
      assert.equal(snapshot.northbound.netFlowDiscontinuedOn, '2024-08-16');
      // The seeder refuses to publish a payload that dropped the marker.
      assert.equal(
        validateChinaStockConnectSnapshot({
          ...snapshot,
          northbound: { ...snapshot.northbound, netFlow: { status: 'known', value: 1 } },
        }),
        false,
      );
    });

    it('pairs margin on the newest session both exchanges published', () => {
      // SSE returns a page of dated rows; SZSE returns one. When SZSE lags a
      // session the matching SSE row is already in hand, so pairing by position
      // would report TRADE_DATE_MISMATCH and discard a computable figure.
      const snapshot = buildChinaStockConnectSnapshot({
        outcomes: [
          {
            sourceId: 'sse-margin',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [
              { tradeDate: '2026-08-03', financingBalanceCny: 30, securitiesLendingBalanceCny: 3, totalBalanceCny: 33, financingBuyCny: 1 },
              { tradeDate: '2026-07-31', financingBalanceCny: 20, securitiesLendingBalanceCny: 2, totalBalanceCny: 22, financingBuyCny: 1 },
            ],
          },
          {
            sourceId: 'szse-margin',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [
              { tradeDate: '2026-07-31', financingBalanceCny: 10, securitiesLendingBalanceCny: 1, totalBalanceCny: 11, financingBuyCny: 1 },
            ],
          },
        ],
        generatedAt: '2026-08-04T20:00:00.000Z',
      });
      assert.equal(snapshot.margin.tradeDate, '2026-07-31');
      assert.equal(snapshot.margin.totalBalanceCny.status, 'known');
      // 22 (SSE's 07-31 row) + 11, NOT 33 + 11.
      assert.equal(snapshot.margin.totalBalanceCny.value, 33);
    });

    it('separates a missing field from a missing exchange', () => {
      const withHole = buildChinaStockConnectSnapshot({
        outcomes: [
          {
            sourceId: 'sse-northbound',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [{ tradeDate: '2026-08-04', turnoverCny: 1, tradeCount: null, etfTurnoverCny: 1 }],
          },
          {
            sourceId: 'szse-northbound',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [{ tradeDate: '2026-08-04', turnoverCny: 1, tradeCount: 5, etfTurnoverCny: 1 }],
          },
        ],
        generatedAt: '2026-08-04T20:00:00.000Z',
      });
      // Both exchanges answered for the same session, so blaming an absent
      // exchange would send an operator hunting the wrong problem.
      assert.equal(withHole.northbound.tradeCount.status, 'unavailable');
      assert.equal(withHole.northbound.tradeCount.reason, 'INCOMPLETE_EXCHANGE_FIELDS');
      assert.equal(withHole.northbound.turnoverCny.status, 'known');
    });

    it('refuses to add two exchanges that report different sessions', () => {
      const snapshot = buildChinaStockConnectSnapshot({
        outcomes: [
          {
            sourceId: 'sse-northbound',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [{ tradeDate: '2026-08-04', turnoverCny: 10 * YI, tradeCount: 1, etfTurnoverCny: 1 }],
          },
          {
            sourceId: 'szse-northbound',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            // One session behind -- a stale or frozen exchange.
            observations: [{ tradeDate: '2026-08-03', turnoverCny: 20 * YI, tradeCount: 1, etfTurnoverCny: 1 }],
          },
        ],
        generatedAt: '2026-08-04T20:00:00.000Z',
      });
      assert.equal(snapshot.northbound.turnoverCny.status, 'unavailable');
      assert.equal(snapshot.northbound.turnoverCny.reason, 'TRADE_DATE_MISMATCH');
      assert.equal(snapshot.status, 'degraded');
      // Per-exchange readings survive so the mismatch is diagnosable.
      assert.equal(snapshot.northbound.exchanges.sse.tradeDate, '2026-08-04');
      assert.equal(snapshot.northbound.exchanges.szse.tradeDate, '2026-08-03');
      // A mismatched day must not enter the history series.
      assert.deepEqual(snapshot.history, []);
    });

    it('logs the snapshot verdict, not just per-source transport', async () => {
      // A frozen exchange still ANSWERS -- every source reports ok, so a
      // per-source-only decision log emits 4x accepted while the published
      // snapshot is degraded. The freeze detector has to be visible to an
      // operator tailing the log, not only to someone who reads the Redis key.
      const events: Array<Record<string, unknown>> = [];
      // A successful response pinned one session behind SSE -- the shape a
      // frozen exchange actually produces.
      const stale = structuredClone(szseNorthboundFixture);
      stale[0].metadata.subname = '2026-07-31';
      await fetchWithFixtures({
        onDecision: (entry: Record<string, unknown>) => events.push(entry),
        overrides: [['CATALOGID=SGT_SGTJYRB', stale]],
      });
      assert.equal(
        events.filter((entry) => entry.scope === 'source' && entry.status === 'accepted').length,
        4,
        'every source must still look individually healthy -- that is the trap',
      );
      const verdict = events.find((entry) => entry.scope === 'snapshot');
      assert.ok(verdict, 'a snapshot-level decision entry must be emitted');
      assert.equal(verdict.status, 'degraded');
      assert.equal(verdict.northboundReason, 'TRADE_DATE_MISMATCH');
    });

    it('degrades and keeps prior history when one exchange is unreachable', async () => {
      const previousSnapshot = {
        history: [{ day: '2026-08-03', northboundTurnoverCny: 1 }],
        sources: [{ id: 'szse-northbound', lastSuccessAt: '2026-08-03T00:00:00.000Z' }],
      };
      const { snapshot } = await fetchWithFixtures({
        previousSnapshot,
        overrides: [['CATALOGID=SGT_SGTJYRB', () => { throw new Error('fetch failed'); }]],
      });
      assert.equal(snapshot.status, 'degraded');
      assert.equal(snapshot.northbound.turnoverCny.status, 'unavailable');
      const szse = snapshot.sources.find((s: { id: string }) => s.id === 'szse-northbound');
      assert.equal(szse.transportStatus, 'error');
      // Last-good timestamp is carried forward so staleness stays visible.
      assert.equal(szse.lastSuccessAt, '2026-08-03T00:00:00.000Z');
      const merged = snapshot.history.find((e: { day: string }) => e.day === '2026-08-03');
      // Same-day collision: the new margin fields must land ALONGSIDE the prior
      // northbound value, not replace the whole row.
      assert.equal(merged.northboundTurnoverCny, 1, 'prior field was dropped on merge');
      assert.ok(merged.marginTotalBalanceCny > 0, 'new field was not merged in');
      // Margin is independent and unaffected.
      assert.equal(snapshot.margin.totalBalanceCny.status, 'known');
    });

    it('still publishes a first run when only one exchange is reachable', async () => {
      // The edge relay exists precisely because SZSE is often unreachable from
      // Railway. If that happens on the very first run there is no prior
      // snapshot to merge, so a record count derived from combined-only history
      // is 0 -- and with zeroIsValid:false the seeder would discard a perfectly
      // good SSE reading and never create the key, permanently.
      const { snapshot } = await fetchWithFixtures({
        previousSnapshot: null,
        overrides: [['szse.cn', () => { throw new Error('fetch failed'); }]],
      });
      assert.equal(snapshot.status, 'degraded');
      // The usable half must survive into the payload.
      assert.equal(snapshot.northbound.exchanges.sse.turnoverCny, 135_449_000_000);
      assert.equal(snapshot.margin.exchanges.sse.financingBalanceCny, 1_323_258_064_454);
      // ...and the seeder must count it as records, or runSeed rejects the whole
      // snapshot. Zero records has to mean "every source failed", nothing less.
      assert.ok(
        chinaStockConnectRecordCount(snapshot) > 0,
        'a run with a working exchange must not report zero records',
      );
    });

    it('reports zero records only when every source failed', () => {
      const snapshot = buildChinaStockConnectSnapshot({
        outcomes: STOCK_CONNECT_SOURCE_IDS.map((sourceId: string) => ({
          sourceId,
          ok: false,
          requestCount: 1,
          errorCode: 'FETCH_FAILED',
          transportPath: 'direct',
        })),
        previousSnapshot: { history: [{ day: '2026-08-03', northboundTurnoverCny: 1 }] },
        generatedAt: '2026-08-04T20:00:00.000Z',
      });
      // Prior history is still carried, but a total outage must not ride on it
      // to look like a successful run.
      assert.ok(snapshot.history.length > 0);
      assert.equal(chinaStockConnectRecordCount(snapshot), 0);
    });

    it('merges history newest-first and bounds it', () => {
      // Counted backwards from the day before the new observation, so the
      // fresh reading is genuinely the newest entry.
      const previousHistory = Array.from({ length: HISTORY_LIMIT + 40 }, (_, index) => ({
        day: new Date(Date.parse('2026-08-03T00:00:00.000Z') - index * 86_400_000)
          .toISOString().slice(0, 10),
        northboundTurnoverCny: index,
      }));
      const snapshot = buildChinaStockConnectSnapshot({
        outcomes: [
          {
            sourceId: 'sse-northbound',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [{ tradeDate: '2026-08-04', turnoverCny: 3 * YI, tradeCount: 1, etfTurnoverCny: 1 }],
          },
          {
            sourceId: 'szse-northbound',
            ok: true,
            requestCount: 1,
            transportPath: 'direct',
            observations: [{ tradeDate: '2026-08-04', turnoverCny: 4 * YI, tradeCount: 1, etfTurnoverCny: 1 }],
          },
        ],
        previousSnapshot: { history: previousHistory },
        generatedAt: '2026-08-04T20:00:00.000Z',
      });
      assert.equal(snapshot.history.length, HISTORY_LIMIT);
      assert.equal(snapshot.history[0].day, '2026-08-04');
      assert.equal(snapshot.history[0].northboundTurnoverCny, 7 * YI);
      for (let i = 1; i < snapshot.history.length; i += 1) {
        assert.ok(snapshot.history[i - 1].day > snapshot.history[i].day);
      }
    });

    it('derives content age from the trade dates, not from the fetch time', async () => {
      const { snapshot } = await fetchWithFixtures();
      const meta = chinaStockConnectContentMeta(snapshot);
      // Anchored on the laggier of the two series -- see the freeze test below.
      assert.equal(meta.newestItemAt, Date.parse('2026-08-03T00:00:00.000Z'));
      assert.equal(meta.oldestItemAt, Date.parse('2026-08-03T00:00:00.000Z'));
    });

    it('lets either series alone drive the content-age alarm', () => {
      // Health reads newestItemAt. If that were the newer of the two series, a
      // normally-advancing northbound would mask a margin series frozen for
      // months -- and a margin freeze that both exchanges share never trips
      // TRADE_DATE_MISMATCH either, so nothing else would catch it.
      const frozenMargin = chinaStockConnectContentMeta({
        northbound: { tradeDate: '2026-08-04' },
        margin: { tradeDate: '2026-06-01' },
      });
      assert.equal(frozenMargin.newestItemAt, Date.parse('2026-06-01T00:00:00.000Z'));

      // Symmetric: a frozen northbound must not hide behind fresh margin.
      const frozenNorthbound = chinaStockConnectContentMeta({
        northbound: { tradeDate: '2026-06-01' },
        margin: { tradeDate: '2026-08-03' },
      });
      assert.equal(frozenNorthbound.newestItemAt, Date.parse('2026-06-01T00:00:00.000Z'));

      // A series with no date at all falls back to the one that has one; the
      // missing series is already reported unavailable and degrades status.
      const partial = chinaStockConnectContentMeta({
        northbound: { tradeDate: '2026-08-04' },
        margin: { tradeDate: null },
      });
      assert.equal(partial.newestItemAt, Date.parse('2026-08-04T00:00:00.000Z'));
      assert.equal(chinaStockConnectContentMeta({}), null);
    });
  });

  describe('request discipline', () => {
    it('always pins a date on SZSE report requests', async () => {
      const { log } = await fetchWithFixtures();
      const reportCalls = log.filter((entry) => entry.url.includes('ShowReport'));
      assert.ok(reportCalls.length > 0);
      for (const call of reportCalls) {
        const params = new URL(call.url).searchParams;
        // Omitting txtDate makes SZSE return every session since 2010.
        assert.match(String(params.get('txtDate')), /^\d{4}-\d{2}-\d{2}$/u);
        assert.equal(params.get('TABKEY'), 'tab1');
      }
    });

    it('stops probing dates once a session with data is found', async () => {
      const { log } = await fetchWithFixtures();
      const northboundDates = log
        .filter((entry) => entry.url.includes('CATALOGID=SGT_SGTJYRB'))
        .map((entry) => new URL(entry.url).searchParams.get('txtDate'));
      assert.deepEqual(northboundDates, ['2026-08-05', '2026-08-04']);
    });

    it('bounds every SZSE probe by the contract request budget', async () => {
      // Nothing is ever published, so the probe loop runs to its ceiling.
      const { snapshot, log } = await fetchWithFixtures({
        overrides: [['ShowReport', szseNorthboundEmptyFixture]],
      });
      const calls = log.filter((entry) => entry.url.includes('ShowReport'));
      assert.ok(
        calls.length
          <= STOCK_CONNECT_SOURCE_CONTRACTS['szse-northbound'].maxRequestsPerRun
            + STOCK_CONNECT_SOURCE_CONTRACTS['szse-margin'].maxRequestsPerRun,
      );
      const szse = snapshot.sources.find((s: { id: string }) => s.id === 'szse-northbound');
      assert.equal(szse.errorCode, 'NO_PUBLISHED_TRADE_DATE');
      assert.equal(snapshot.status, 'degraded');
    });

    it('calls a malformed SZSE 200 malformed, not an unpublished session', async () => {
      // A schema change upstream returns HTTP 200 with an unexpected body. If
      // that reads as "this date is not published yet" the probe walks every
      // candidate and reports NO_PUBLISHED_TRADE_DATE -- indistinguishable from
      // a market holiday, and a whole diagnostic session wasted.
      const { snapshot, log } = await fetchWithFixtures({
        overrides: [['CATALOGID=SGT_SGTJYRB', { unexpected: 'shape' }]],
      });
      const source = snapshot.sources.find((s: { id: string }) => s.id === 'szse-northbound');
      assert.equal(source.errorCode, 'MALFORMED_RESPONSE');
      // ...and it must stop on the first bad payload rather than burn the budget.
      assert.equal(
        log.filter((e) => e.url.includes('CATALOGID=SGT_SGTJYRB')).length,
        1,
      );
    });

    it('re-walks the ladder when the sticky hop blips', async () => {
      // Sticky exists to stop each date probe re-paying the escalation, but a
      // one-off failure on the remembered hop must not kill the source when
      // another transport is working -- that turns an optimisation into a
      // single point of failure.
      const log: FetchLogEntry[] = [];
      const served = fixtureFetch(log);
      let directReportCalls = 0;
      const snapshot = await fetchChinaStockConnectSnapshot({
        fetchFn: async (input: unknown, init: RequestInit) => {
          const url = String(input);
          // The calendar cannot be reached directly, so it escalates to the
          // proxy and pins sticky='proxy'. The reports can.
          if (url.includes('monthList')) throw new Error('fetch failed');
          if (url.includes('szse.cn')) directReportCalls += 1;
          return served(input, init);
        },
        proxyUrl: 'http://user:pw@exit.example:7001',
        sseProxyUrl: '',
        proxyRequestFn: async (input: string) => {
          // Proxy serves the calendar, then blips for every report.
          if (!input.includes('monthList')) throw new Error('fetch failed');
          const body = JSON.stringify(szseCalendarFixture);
          return {
            status: 200,
            contentType: 'application/json',
            buffer: new TextEncoder().encode(body),
          };
        },
        now: NOW,
        onDecision: () => {},
      });
      assert.ok(
        directReportCalls > 0,
        'the direct hop must be re-tried after the sticky proxy blip',
      );
      assert.equal(
        snapshot.northbound.turnoverCny.status,
        'known',
        'a working direct hop must still produce data after a sticky blip',
      );
    });

    it('gives SZSE its full wall-clock budget regardless of SSE latency', async () => {
      // The budget is shared across every szse.cn request. If SSE work runs
      // between the calendar and the SZSE reports, slow SSE silently eats the
      // SZSE allowance and the reports die on TRANSPORT_BUDGET_EXCEEDED without
      // SZSE ever being at fault.
      const order: string[] = [];
      const log: FetchLogEntry[] = [];
      const served = fixtureFetch(log);
      const snapshot = await fetchChinaStockConnectSnapshot({
        fetchFn: async (input: unknown, init: RequestInit) => {
          order.push(String(input).includes('szse.cn') ? 'szse' : 'sse');
          return served(input, init);
        },
        proxyUrl: '',
        sseProxyUrl: '',
        edgeEgress: null,
        now: NOW,
        onDecision: () => {},
      });
      // Guard against a vacuous pass: both halves must actually have dialled.
      assert.ok(order.includes('szse'), 'SZSE must have made requests');
      assert.ok(order.includes('sse'), 'SSE must have made requests');
      // Every szse.cn request must precede the first sse request, so the shared
      // deadline only ever measures SZSE's own work.
      const firstSse = order.indexOf('sse');
      const lastSzse = order.lastIndexOf('szse');
      assert.ok(
        lastSzse < firstSse,
        `SZSE work must be contiguous before SSE; saw ${order.join(',')}`,
      );
      assert.equal(snapshot.status, 'healthy');
    });

    it('abandons a source on transport failure instead of blaming the trade date', async () => {
      const { snapshot, log } = await fetchWithFixtures({
        overrides: [['CATALOGID=1837_xxpl', () => { throw new Error('fetch failed'); }]],
      });
      const marginCalls = log.filter((entry) => entry.url.includes('CATALOGID=1837_xxpl'));
      // One attempt, not one per candidate date: the network is down, and
      // reporting NO_PUBLISHED_TRADE_DATE here would misdiagnose it.
      assert.equal(marginCalls.length, 1);
      const source = snapshot.sources.find((s: { id: string }) => s.id === 'szse-margin');
      assert.equal(source.errorCode, 'FETCH_FAILED');
      assert.notEqual(source.errorCode, 'NO_PUBLISHED_TRADE_DATE');
      // The dials it really made must reach the decision log; reporting 0 here
      // reads as "never tried" and sends the reader to the wrong layer.
      assert.equal(source.requestCount, marginCalls.length);
      assert.deepEqual(source.probedDates, ['2026-08-05']);
    });

    it('stops dialling SZSE once its wall-clock reservation is spent', async () => {
      // Jumps far past every reservation between creating a deadline and
      // checking it, so each SZSE consumer trips its own budget.
      let now = 0;
      const clock = () => (now += 1_000_000_000);
      const { snapshot } = await fetchWithFixtures({ clock });
      for (const id of ['szse-northbound', 'szse-margin']) {
        const source = snapshot.sources.find((s: { id: string }) => s.id === id);
        assert.equal(source.errorCode, 'TRANSPORT_BUDGET_EXCEEDED', id);
      }
      // SSE is on a different host and keeps working.
      const sse = snapshot.sources.find((s: { id: string }) => s.id === 'sse-northbound');
      assert.equal(sse.transportStatus, 'ok');
    });

    it('routes each exchange through its own configured proxy', async () => {
      // The registration test only regex-matches the two declaration lines, so
      // it stays green if a call site swaps which URL feeds which exchange.
      // This asserts the actual wiring.
      const dialled: Array<{ url: string; proxy: string }> = [];
      const proxyRequestFn = async (input: string, config: { port: number }) => {
        dialled.push({ url: input, proxy: String(config.port) });
        throw new Error('proxy refused');
      };
      const snapshot = await fetchChinaStockConnectSnapshot({
        // Force every direct hop to fail so the proxy hop is always reached.
        fetchFn: async () => { throw new Error('fetch failed'); },
        proxyUrl: 'http://user:pw@szse-exit.example:7001',
        sseProxyUrl: 'http://user:pw@sse-exit.example:9001',
        proxyRequestFn,
        edgeEgress: null,
        now: NOW,
        onDecision: () => {},
      });
      const sseDials = dialled.filter((d) => d.url.includes('sse.com.cn'));
      const szseDials = dialled.filter((d) => d.url.includes('szse.cn'));
      assert.ok(sseDials.length > 0, 'SSE must reach its proxy');
      assert.ok(szseDials.length > 0, 'SZSE must reach its proxy');
      for (const dial of sseDials) assert.equal(dial.proxy, '9001', dial.url);
      for (const dial of szseDials) assert.equal(dial.proxy, '7001', dial.url);
      assert.equal(snapshot.status, 'degraded');
    });

    it('keeps the exchange calendar when SZSE is only reachable over the proxy', async () => {
      // A full escalation costs direct + SZSE_MAX_PROXY_ATTEMPTS, and the
      // calendar can need two months, the second costing one more through the
      // hop that just worked. A budget sized to exactly one escalation threw
      // REQUEST_BUDGET_EXCEEDED and silently dropped holiday awareness at the
      // precise moment the transport was already degraded.
      const log: FetchLogEntry[] = [];
      const served = fixtureFetch(log);
      const snapshot = await fetchChinaStockConnectSnapshot({
        fetchFn: async (input: unknown, init: RequestInit) => {
          if (String(input).includes('szse.cn')) throw new Error('fetch failed');
          return served(input, init);
        },
        proxyUrl: 'http://user:pw@exit.example:7001',
        sseProxyUrl: '',
        proxyRequestFn: async (input: string) => {
          const url = new URL(input);
          const day = url.searchParams.get('txtDate');
          const payload = url.pathname.includes('monthList')
            ? szseCalendarFixture
            : url.searchParams.get('CATALOGID') === 'SGT_SGTJYRB'
              ? (day === '2026-08-04' ? szseNorthboundFixture : szseNorthboundEmptyFixture)
              : (day === '2026-08-03' ? szseMarginFixture : szseNorthboundEmptyFixture);
          const body = JSON.stringify(payload);
          return {
            status: 200,
            contentType: 'application/json',
            buffer: new TextEncoder().encode(body),
          };
        },
        now: NOW,
        onDecision: () => {},
      });
      assert.equal(
        snapshot.calendarStatus,
        'exchange',
        'the calendar must not be abandoned just because it took the proxy hop',
      );
      assert.equal(snapshot.northbound.turnoverCny.status, 'known');
    });

    it('calls a malformed SZSE 200 malformed, not an unpublished session', async () => {
      // A schema change upstream returns HTTP 200 with an unexpected body. If
      // that reads as "this date is not published yet" the probe walks every
      // candidate and reports NO_PUBLISHED_TRADE_DATE -- indistinguishable from
      // a market holiday, and a whole diagnostic session wasted.
      const { snapshot, log } = await fetchWithFixtures({
        overrides: [['CATALOGID=SGT_SGTJYRB', { unexpected: 'shape' }]],
      });
      const source = snapshot.sources.find((s: { id: string }) => s.id === 'szse-northbound');
      assert.equal(source.errorCode, 'MALFORMED_RESPONSE');
      // ...and it must stop on the first bad payload rather than burn the budget.
      assert.equal(
        log.filter((e) => e.url.includes('CATALOGID=SGT_SGTJYRB')).length,
        1,
      );
    });

    it('re-walks the ladder when the sticky hop blips', async () => {
      // Sticky exists to stop each date probe re-paying the escalation, but a
      // one-off failure on the remembered hop must not kill the source when
      // another transport is working -- that turns an optimisation into a
      // single point of failure.
      const log: FetchLogEntry[] = [];
      const served = fixtureFetch(log);
      let directReportCalls = 0;
      const snapshot = await fetchChinaStockConnectSnapshot({
        fetchFn: async (input: unknown, init: RequestInit) => {
          const url = String(input);
          // The calendar cannot be reached directly, so it escalates to the
          // proxy and pins sticky='proxy'. The reports can.
          if (url.includes('monthList')) throw new Error('fetch failed');
          if (url.includes('szse.cn')) directReportCalls += 1;
          return served(input, init);
        },
        proxyUrl: 'http://user:pw@exit.example:7001',
        sseProxyUrl: '',
        proxyRequestFn: async (input: string) => {
          // Proxy serves the calendar, then blips for every report.
          if (!input.includes('monthList')) throw new Error('fetch failed');
          const body = JSON.stringify(szseCalendarFixture);
          return {
            status: 200,
            contentType: 'application/json',
            buffer: new TextEncoder().encode(body),
          };
        },
        now: NOW,
        onDecision: () => {},
      });
      assert.ok(
        directReportCalls > 0,
        'the direct hop must be re-tried after the sticky proxy blip',
      );
      assert.equal(
        snapshot.northbound.turnoverCny.status,
        'known',
        'a working direct hop must still produce data after a sticky blip',
      );
    });

    it('gives SZSE its full wall-clock budget regardless of SSE latency', async () => {
      // The budget is shared across every szse.cn request. If SSE work runs
      // between the calendar and the SZSE reports, slow SSE silently eats the
      // SZSE allowance and the reports die on TRANSPORT_BUDGET_EXCEEDED without
      // SZSE ever being at fault.
      const order: string[] = [];
      const log: FetchLogEntry[] = [];
      const served = fixtureFetch(log);
      const snapshot = await fetchChinaStockConnectSnapshot({
        fetchFn: async (input: unknown, init: RequestInit) => {
          order.push(String(input).includes('szse.cn') ? 'szse' : 'sse');
          return served(input, init);
        },
        proxyUrl: '',
        sseProxyUrl: '',
        edgeEgress: null,
        now: NOW,
        onDecision: () => {},
      });
      // Guard against a vacuous pass: both halves must actually have dialled.
      assert.ok(order.includes('szse'), 'SZSE must have made requests');
      assert.ok(order.includes('sse'), 'SSE must have made requests');
      // Every szse.cn request must precede the first sse request, so the shared
      // deadline only ever measures SZSE's own work.
      const firstSse = order.indexOf('sse');
      const lastSzse = order.lastIndexOf('szse');
      assert.ok(
        lastSzse < firstSse,
        `SZSE work must be contiguous before SSE; saw ${order.join(',')}`,
      );
      assert.equal(snapshot.status, 'healthy');
    });

    it('abandons a source on transport failure instead of blaming the trade date', async () => {
      const { snapshot, log } = await fetchWithFixtures({
        overrides: [['CATALOGID=1837_xxpl', () => { throw new Error('fetch failed'); }]],
      });
      const marginCalls = log.filter((entry) => entry.url.includes('CATALOGID=1837_xxpl'));
      // One attempt, not one per candidate date: the network is down, and
      // reporting NO_PUBLISHED_TRADE_DATE here would misdiagnose it.
      assert.equal(marginCalls.length, 1);
      const source = snapshot.sources.find((s: { id: string }) => s.id === 'szse-margin');
      assert.equal(source.errorCode, 'FETCH_FAILED');
      assert.notEqual(source.errorCode, 'NO_PUBLISHED_TRADE_DATE');
      // The dials it really made must reach the decision log; reporting 0 here
      // reads as "never tried" and sends the reader to the wrong layer.
      assert.equal(source.requestCount, marginCalls.length);
      assert.deepEqual(source.probedDates, ['2026-08-05']);
    });

    it('stops dialling SZSE once its wall-clock reservation is spent', async () => {
      // Jumps far past every reservation between creating a deadline and
      // checking it, so each SZSE consumer trips its own budget.
      let now = 0;
      const clock = () => (now += 1_000_000_000);
      const { snapshot } = await fetchWithFixtures({ clock });
      for (const id of ['szse-northbound', 'szse-margin']) {
        const source = snapshot.sources.find((s: { id: string }) => s.id === id);
        assert.equal(source.errorCode, 'TRANSPORT_BUDGET_EXCEEDED', id);
      }
      // SSE is on a different host and keeps working.
      const sse = snapshot.sources.find((s: { id: string }) => s.id === 'sse-northbound');
      assert.equal(sse.transportStatus, 'ok');
    });

    it('routes each exchange through its own configured proxy', async () => {
      // The registration test only regex-matches the two declaration lines, so
      // it stays green if a call site swaps which URL feeds which exchange.
      // This asserts the actual wiring.
      const dialled: Array<{ url: string; proxy: string }> = [];
      const proxyRequestFn = async (input: string, config: { port: number }) => {
        dialled.push({ url: input, proxy: String(config.port) });
        throw new Error('proxy refused');
      };
      const snapshot = await fetchChinaStockConnectSnapshot({
        // Force every direct hop to fail so the proxy hop is always reached.
        fetchFn: async () => { throw new Error('fetch failed'); },
        proxyUrl: 'http://user:pw@szse-exit.example:7001',
        sseProxyUrl: 'http://user:pw@sse-exit.example:9001',
        proxyRequestFn,
        edgeEgress: null,
        now: NOW,
        onDecision: () => {},
      });
      const sseDials = dialled.filter((d) => d.url.includes('sse.com.cn'));
      const szseDials = dialled.filter((d) => d.url.includes('szse.cn'));
      assert.ok(sseDials.length > 0, 'SSE must reach its proxy');
      assert.ok(szseDials.length > 0, 'SZSE must reach its proxy');
      for (const dial of sseDials) assert.equal(dial.proxy, '9001', dial.url);
      for (const dial of szseDials) assert.equal(dial.proxy, '7001', dial.url);
      assert.equal(snapshot.status, 'degraded');
    });

    it('rejects an oversized SZSE response, which is how the full-history dump fails', async () => {
      // Dropping txtDate makes SZSE return every session since 2010 (~438 KiB
      // observed). That must exceed the ceiling rather than parse.
      const enormous = [{
        metadata: { tabkey: 'tab1', subname: '2026-08-04' },
        data: Array.from({ length: 20_000 }, () => ({ label: '当日交易总额', total: '1.00' })),
      }];
      const { snapshot } = await fetchWithFixtures({
        overrides: [['CATALOGID=SGT_SGTJYRB', enormous]],
      });
      const source = snapshot.sources.find((s: { id: string }) => s.id === 'szse-northbound');
      assert.equal(source.errorCode, 'RESPONSE_TOO_LARGE');
    });

    it('rejects an oversized response instead of parsing the full-history dump', async () => {
      const enormous = { result: Array.from({ length: 20_000 }, () => ({ pad: 'x'.repeat(64) })) };
      const { snapshot } = await fetchWithFixtures({
        overrides: [['FW_HGTZL_HGTSCSJ_HGTCJGK_MRTJ', enormous]],
      });
      const source = snapshot.sources.find((s: { id: string }) => s.id === 'sse-northbound');
      assert.equal(source.errorCode, 'RESPONSE_TOO_LARGE');
    });

    it('declares a network worst case the bundle timeout can absorb', () => {
      const bundle = readFileSync(
        resolve(import.meta.dirname, '../scripts/seed-bundle-market-backup.mjs'),
        'utf8',
      );
      const member = /\{[^\n]*'China-Stock-Connect'[^\n]*\}/u.exec(bundle)?.[0] ?? '';
      const timeoutMs = Number(/timeoutMs:\s*([\d_]+)/u.exec(member)?.[1]?.replace(/_/gu, ''));
      assert.ok(Number.isFinite(timeoutMs), 'bundle member declares a timeout');
      assert.ok(
        CHINA_STOCK_CONNECT_MAX_NETWORK_MS <= timeoutMs,
        `worst case ${CHINA_STOCK_CONNECT_MAX_NETWORK_MS}ms exceeds bundle timeout ${timeoutMs}ms`,
      );
    });
  });

  describe('source contracts', () => {
    it('records terms and robots for every endpoint on both hosts', () => {
      for (const contract of Object.values(STOCK_CONNECT_SOURCE_CONTRACTS)) {
        assert.match(contract.termsUrl, /^https:\/\//u);
        assert.ok(contract.termsNote.length > 0, contract.id);
        assert.ok(['not_published', 'empty'].includes(contract.robots.status), contract.id);
        assert.equal(contract.admissionDecision, 'admitted_aggregate_statistics');
        assert.equal(contract.launchStatus, 'launched');
        assert.equal(new URL(contract.metadataEndpoint).protocol, 'https:');
        assert.equal(new URL(contract.metadataEndpoint).hostname, contract.metadataHost);
      }
    });

    it('keeps the descriptive contract fields bound to real behaviour', () => {
      // These fields document how each source is reached. Nothing in the
      // adapter reads them, so without this test they are inert prose that can
      // drift away from the code and mislead the next reader -- which is what
      // the removed transportRecoverySuccessRuns field did, implying a recovery
      // hysteresis this module never had.
      for (const contract of Object.values(STOCK_CONNECT_SOURCE_CONTRACTS)) {
        // Every source stops at the proxy: a seeder fetches upstream data, the
        // web tier serves it from Redis, and routing an exchange fetch through
        // an edge function to borrow its egress inverts that.
        assert.equal(
          contract.fallbackPolicy,
          'direct_then_proxy_on_transport_failure',
          `${contract.id}: unexpected fallback policy`,
        );
        assert.equal(
          contract.proxyEnvironmentVariable,
          contract.exchange === 'SSE' ? 'SSE_PROXY_URL' : 'SZSE_PROXY_URL',
          `${contract.id}: declares a proxy variable the resolver does not use`,
        );
        // The compliance record that justified admitting the source.
        assert.equal(contract.preflight.reachable, true, contract.id);
        assert.match(contract.preflight.checkedOn, /^\d{4}-\d{2}-\d{2}$/u);
        assert.equal(contract.preflight.metadataHttpStatus, 200, contract.id);
      }
      // ...and the resolver really does read those two variables.
      const source = readFileSync(
        resolve(import.meta.dirname, '../scripts/china-stock-connect/adapters.mjs'),
        'utf8',
      );
      assert.match(source, /process\.env\.SZSE_PROXY_URL \|\| process\.env\.PROXY_URL/);
      assert.match(source, /process\.env\.SSE_PROXY_URL \|\| proxyUrl/);
    });

    it('reuses the terms already recorded for the two exchange hosts', () => {
      const byHost = new Map(
        Object.values(STOCK_CONNECT_SOURCE_CONTRACTS)
          .map((contract) => [contract.metadataHost, contract.termsUrl]),
      );
      assert.equal(byHost.get('query.sse.com.cn'), 'https://www.sse.com.cn/home/legal/');
      assert.equal(byHost.get('www.szse.cn'), 'https://www.szse.cn/application/laws/');
    });
  });
});
