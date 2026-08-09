// Guards the recorded China macro fixture against wall-clock rot (#5762).
//
// The fixture is a snapshot of a moment in time, but two read paths re-derive
// freshness against Date.now():
//
//   transport  now - (lastSuccessAt ?? retrievalTime) vs CHINA_MACRO_MAX_TRANSPORT_AGE_MIN (72h)
//   content    now - observationPeriod                vs CHINA_MACRO_SERIES_MAX_AGE_DAYS  (75d)
//
// Both expire on a calendar date. When the transport window lapsed on
// 2026-07-28T14:30Z it turned `tests/mcp.test.mjs` red on every branch at once
// and blocked every open PR, with a failure message ('stale' !== 'fresh') that
// said nothing about the cause.
//
// Both are now structurally fixed. Consumers that re-derive freshness build the
// fixture with the live clock, and the recorded dates are rebased per build so
// the snapshot always describes "last month's release, published days ago"
// rather than one literal moment. This file locks both properties in.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_MACRO_SERIES_MAX_AGE_DAYS,
  chinaMacroObservationDateMs,
  isChinaMacroObservationStale,
} from '../scripts/_china-macro-contract.mjs';
import {
  buildOfficialChinaMacroFixture,
  CHINA_MACRO_FIXTURE_RETRIEVAL_TIME,
} from './helpers/china-macro-fixture.mjs';

// The rebased period is the previous whole month, so age peaks at ~31 days.
// The tightest series budget is SAFE at 45 days, leaving a guaranteed floor of
// ~14 days. Sit just under that: firing means the rebase or a budget changed.
const REQUIRED_HEADROOM_DAYS = 10;
const DAY_MS = 86_400_000;

describe('China macro fixture freshness', () => {
  it('reads as freshly retrieved when built with the live clock', async () => {
    // This is the invariant #5762 broke. Building with the live clock is what
    // makes every wall-clock-re-deriving consumer time-invariant; if this
    // regresses, `tests/mcp.test.mjs` goes red on a calendar date again.
    const snapshot = await buildOfficialChinaMacroFixture(Date.now());
    const observations = (snapshot as { observations?: Record<string, unknown>[] }).observations ?? [];
    assert.ok(observations.length > 0, 'fixture must produce observations');

    const succeeded = observations.filter((o) => o.transportStatus === 'fresh');
    assert.ok(
      succeeded.length > 0,
      'at least one fixture source must transport successfully, or the guard proves nothing',
    );
    for (const observation of succeeded) {
      const age = Date.now() - Date.parse(String(observation.retrievalTime));
      assert.ok(
        age < 60_000,
        `${observation.seriesId} retrievalTime must track the clock the fixture was built with, got age ${Math.round(age / 1000)}s`,
      );
    }
  });

  it('keeps the pinned default for snapshot-asserting consumers', async () => {
    // tests/china-macro-rpc.test.mts and tests/macro-tiles-china-ui.test.mts
    // assert against CHINA_MACRO_FIXTURE_RETRIEVAL_TIME directly, so the
    // no-argument default must stay byte-stable.
    const snapshot = await buildOfficialChinaMacroFixture();
    const observations = (snapshot as { observations?: Record<string, unknown>[] }).observations ?? [];
    const fresh = observations.find((o) => o.transportStatus === 'fresh');
    assert.equal(fresh?.retrievalTime, CHINA_MACRO_FIXTURE_RETRIEVAL_TIME);
  });

  it('recorded observation periods retain content-window headroom', async () => {
    const snapshot = await buildOfficialChinaMacroFixture(Date.now());
    const observations = (snapshot as { observations?: Record<string, unknown>[] }).observations ?? [];
    const now = Date.now();
    const expiring: string[] = [];

    for (const observation of observations) {
      const seriesId = String(observation.seriesId);
      const period = String(observation.observationPeriod);
      const maxAgeDays = (CHINA_MACRO_SERIES_MAX_AGE_DAYS as Record<string, number>)[seriesId];
      const observedAt = chinaMacroObservationDateMs(period);
      if (!Number.isFinite(maxAgeDays) || observedAt == null) continue;
      // Already stale is a hard failure; nearly stale is the early warning.
      const expiresAt = observedAt + maxAgeDays * DAY_MS;
      const headroomDays = (expiresAt - now) / DAY_MS;
      if (headroomDays < REQUIRED_HEADROOM_DAYS) {
        expiring.push(
          `${seriesId} (period ${period}, ${maxAgeDays}d budget) goes stale at ${new Date(expiresAt).toISOString()} -- ${headroomDays.toFixed(1)}d left`,
        );
      }
      assert.equal(
        isChinaMacroObservationStale(seriesId, period, now),
        false,
        `${seriesId} recorded content has already aged out; refresh tests/fixtures/china-macro/*.html`,
      );
    }

    assert.deepEqual(
      expiring,
      [],
      `Recorded China macro fixture content is within ${REQUIRED_HEADROOM_DAYS} days of aging out of its content-freshness budget.\n`
      + 'Refresh tests/fixtures/china-macro/*.html with a more recent NBS/SAFE release (and update the\n'
      + 'route URLs plus CHINA_MACRO_FIXTURE_RETRIEVAL_TIME to match) before it turns mcp.test.mjs red.\n'
      + `Expiring:\n  ${expiring.join('\n  ')}`,
    );
  });
});

describe('China macro fixture time-invariance', () => {
  // The regression #5762 was: a property that held on the day it was written
  // and expired on a calendar date. Asserting it at `Date.now()` alone would
  // reproduce exactly that mistake, so pin it across clocks instead -- month
  // boundaries, month lengths, leap day, and hour-of-day edges.
  const clocks: number[] = [];
  for (let month = 0; month < 30; month += 1) {
    for (const day of [1, 2, 15, 28, 31]) {
      for (const hour of [0, 23]) {
        const at = new Date(Date.UTC(2026, 6 + month, day, hour, 30, 0));
        if (at.getUTCDate() === day) clocks.push(at.getTime());
      }
    }
  }

  // The complete expected outcome, pinned. Asserting freshness only over the
  // observations that happen to BE fresh would let a clock-specific route or
  // parsing regression pass unnoticed: the degraded source would simply drop
  // out of the checked set while its healthy siblings kept the guard green.
  // The blocked entries are deliberate -- the fixture serves robots.txt
  // disallow for PBoC and a self-signed certificate for GACC -- so pinning them
  // also proves the rebase does not accidentally "repair" a source.
  const EXPECTED_TRANSPORT: ReadonlyArray<readonly [string, string, string]> = [
    ['nbs_industrial_value_added_yoy', 'fresh', ''],
    ['nbs_fixed_asset_investment_yoy', 'fresh', ''],
    ['nbs_real_estate_investment_yoy', 'fresh', ''],
    ['safe_fx_reserves', 'fresh', ''],
    ['safe_bank_fx_settlement', 'fresh', ''],
    ['pboc_aggregate_financing_flow', 'blocked', 'ROBOTS_DISALLOW'],
    ['pboc_new_rmb_loans', 'blocked', 'ROBOTS_DISALLOW'],
    ['pboc_m2_yoy', 'blocked', 'ROBOTS_DISALLOW'],
    ['pboc_policy_liquidity_operation', 'blocked', 'ROBOTS_DISALLOW'],
    ['gacc_exports', 'blocked', 'TLS_CERTIFICATE_ERROR'],
    ['gacc_imports', 'blocked', 'TLS_CERTIFICATE_ERROR'],
    ['gacc_trade_balance', 'blocked', 'TLS_CERTIFICATE_ERROR'],
  ];

  it(`builds the complete expected snapshot at every one of ${clocks.length} clocks over 30 months`, async () => {
    const failures: string[] = [];
    for (const now of clocks) {
      const at = new Date(now).toISOString();
      let snapshot: { observations?: Record<string, unknown>[] };
      try {
        snapshot = await buildOfficialChinaMacroFixture(now);
      } catch (error) {
        failures.push(`${at} threw ${(error as Error).message}`);
        continue;
      }
      const observations = snapshot.observations ?? [];

      // 1. The whole observation set, in order, with its exact transport state.
      const actual = observations.map((o) => [
        String(o.seriesId), String(o.transportStatus), String(o.transportFailureReason ?? ''),
      ].join('|'));
      const expected = EXPECTED_TRANSPORT.map((row) => row.join('|'));
      if (actual.join('\n') !== expected.join('\n')) {
        // Pair each row with the actual at the SAME position -- filtering first
        // and then indexing would report mismatched pairs and send the reader
        // to the wrong series.
        const drifted = expected
          .map((row, index) => (actual[index] === row ? null : `[${index}] want ${row} got ${actual[index] ?? '<missing>'}`))
          .filter((row): row is string => row !== null);
        const extra = actual.length > expected.length
          ? ` (+${actual.length - expected.length} unexpected)`
          : '';
        failures.push(`${at} transport set drift${extra}: ${drifted.slice(0, 3).join('; ')}`);
        continue;
      }

      // 2. Freshness of the sources that are supposed to be fresh.
      for (const observation of observations) {
        if (observation.transportStatus !== 'fresh') continue;
        const seriesId = String(observation.seriesId);
        if (isChinaMacroObservationStale(seriesId, String(observation.observationPeriod), now)) {
          failures.push(`${at} ${seriesId} content stale`);
        }
        const transportAgeMs = now - Date.parse(String(observation.retrievalTime));
        if (transportAgeMs > 60_000) {
          failures.push(`${at} ${seriesId} transport age ${transportAgeMs}ms`);
        }
      }
    }
    assert.deepEqual(
      failures.slice(0, 10),
      [],
      `The rebased fixture must produce the complete expected snapshot at any clock; ${failures.length} failed.`,
    );
  });
});
