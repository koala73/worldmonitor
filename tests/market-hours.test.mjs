// #4922d: market-hours awareness — shared US-equity session helper
// (scripts/shared/market-hours.cjs), its server-side TS twin, and the
// closed-market seeding gates in seed-market-quotes.mjs / ais-relay.cjs.
//
// Every session assertion passes an EXPLICIT Date — never wall-clock.
// ET offsets: EDT (UTC-4) mid-March..early-Nov, EST (UTC-5) otherwise.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getUsEquitySession,
  isUsEquityMarketOpen,
  isUsEquityTradingDay,
} from '../scripts/shared/market-hours.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

// [isoUtc, expectedSession, label]
const SESSION_FIXTURES = [
  // Ordinary Wednesday (2026-07-08, EDT = UTC-4)
  ['2026-07-08T19:00:00Z', 'regular', 'Wed 15:00 ET — regular'],
  ['2026-07-08T11:00:00Z', 'pre', 'Wed 07:00 ET — pre'],
  ['2026-07-08T21:30:00Z', 'post', 'Wed 17:30 ET — post'],
  ['2026-07-09T03:00:00Z', 'closed', 'Wed 23:00 ET — overnight closed'],
  // Exact boundaries
  ['2026-07-08T08:00:00Z', 'pre', 'Wed 04:00 ET — pre begins'],
  ['2026-07-08T13:30:00Z', 'regular', 'Wed 09:30 ET — open'],
  ['2026-07-08T13:29:00Z', 'pre', 'Wed 09:29 ET — still pre'],
  ['2026-07-08T20:00:00Z', 'post', 'Wed 16:00 ET — close → post'],
  ['2026-07-08T23:59:00Z', 'post', 'Wed 19:59 ET — post'],
  ['2026-07-09T00:00:00Z', 'closed', 'Wed 20:00 ET — post ends'],
  ['2026-07-08T07:59:00Z', 'closed', 'Wed 03:59 ET — before pre'],
  // Weekend
  ['2026-07-11T16:00:00Z', 'closed', 'Sat noon ET — weekend'],
  // Full holidays (all-day closed)
  ['2026-12-25T17:00:00Z', 'closed', 'Christmas 2026 (Fri) noon ET'],
  ['2026-11-26T17:00:00Z', 'closed', 'Thanksgiving 2026 (4th Thu Nov) noon ET'],
  ['2026-07-03T14:00:00Z', 'closed', 'Jul 3 2026 (Fri) — observed Jul-4 (Sat→Fri shift)'],
  ['2027-07-05T14:00:00Z', 'closed', 'Jul 5 2027 (Mon) — observed Jul-4 (Sun→Mon shift)'],
  ['2027-01-18T17:00:00Z', 'closed', 'MLK 2027 — 3rd Mon Jan'],
  ['2026-04-03T14:00:00Z', 'closed', 'Good Friday 2026 (Easter 2026 = Apr 5, computus)'],
  ['2026-06-19T14:00:00Z', 'closed', 'Juneteenth 2026 (Fri)'],
  ['2027-06-18T14:00:00Z', 'closed', 'Juneteenth 2027 — Jun 19 Sat → observed Fri Jun 18'],
  // New Year's NYSE exception: Jan 1 2028 is a Saturday → NOT shifted to
  // Friday (rule 7.2 — the exchange stays open Fri Dec 31 2027).
  ['2027-12-31T17:00:00Z', 'regular', 'Fri Dec 31 2027 — open despite Jan 1 2028 Sat'],
  // Early-close days (regular ends 13:00, post 13:00–17:00)
  ['2026-11-27T19:00:00Z', 'post', 'Day after Thanksgiving 14:00 ET — early close → post'],
  ['2026-11-27T17:00:00Z', 'regular', 'Day after Thanksgiving 12:00 ET — regular'],
  ['2026-11-27T22:30:00Z', 'closed', 'Day after Thanksgiving 17:30 ET — post ended 17:00'],
  ['2026-12-24T19:00:00Z', 'post', 'Dec 24 2026 (Thu) 14:00 ET — early close → post'],
  // DST correctness: the same UTC hour maps to different ET sessions
  ['2026-01-14T14:00:00Z', 'pre', '14:00 UTC in January = 09:00 EST — pre'],
  ['2026-07-08T14:00:00Z', 'regular', '14:00 UTC in July = 10:00 EDT — regular'],
];

describe('getUsEquitySession (#4922d)', () => {
  for (const [iso, expected, label] of SESSION_FIXTURES) {
    it(label, () => {
      assert.equal(getUsEquitySession(new Date(iso)), expected);
    });
  }
});

describe('isUsEquityMarketOpen / isUsEquityTradingDay (#4922d)', () => {
  it('open only during the regular session', () => {
    assert.equal(isUsEquityMarketOpen(new Date('2026-07-08T19:00:00Z')), true);
    assert.equal(isUsEquityMarketOpen(new Date('2026-07-08T11:00:00Z')), false);
    assert.equal(isUsEquityMarketOpen(new Date('2026-07-11T16:00:00Z')), false);
  });

  it('trading-day gate: weekday yes, weekend/holiday no, early-close still a trading day', () => {
    assert.equal(isUsEquityTradingDay(new Date('2026-07-08T19:00:00Z')), true);
    // Weekday overnight (ET Wed 23:00) is still a trading DAY — the seeder
    // gate must not freeze the mixed NSE symbols during their IST session.
    assert.equal(isUsEquityTradingDay(new Date('2026-07-09T03:00:00Z')), true);
    assert.equal(isUsEquityTradingDay(new Date('2026-07-11T16:00:00Z')), false);
    assert.equal(isUsEquityTradingDay(new Date('2026-11-26T17:00:00Z')), false);
    assert.equal(isUsEquityTradingDay(new Date('2026-11-27T17:00:00Z')), true);
  });
});

describe('server TS twin stays in lockstep with the .cjs helper', () => {
  it('functional cross-check on every fixture', async () => {
    const { getUsEquitySessionAt } = await import('../server/worldmonitor/market/v1/analyze-stock.ts');
    for (const [iso, expected, label] of SESSION_FIXTURES) {
      assert.equal(getUsEquitySessionAt(new Date(iso)), expected, `TS twin diverges: ${label}`);
    }
  });

  it('both files carry the same session-boundary markers', () => {
    const cjs = readSrc('scripts/shared/market-hours.cjs');
    const ts = readSrc('server/worldmonitor/market/v1/analyze-stock.ts');
    for (const marker of ["'09:30'", "'16:00'", "'04:00'", "'20:00'", "'13:00'", "'17:00'"]) {
      // markers live in a boundary comment adjacent to the constants
      assert.ok(cjs.includes(marker.slice(1, -1)), `cjs missing boundary marker ${marker}`);
      assert.ok(ts.includes(marker.slice(1, -1)), `ts missing boundary marker ${marker}`);
    }
    assert.match(ts, /scripts\/shared\/market-hours\.cjs/, 'ts twin must cross-reference the cjs source of truth');
  });
});

describe('closed-market seeding gates (source-textual, #4922d)', () => {
  it('seed-market-quotes skips upstream fetch on non-trading days and reuses the exit-75 TTL machinery', () => {
    const src = readSrc('scripts/seed-market-quotes.mjs');
    assert.match(src, /from '\.\/shared\/market-hours\.cjs'/);
    assert.match(src, /isUsEquityTradingDay\(/);
    assert.match(src, /extendExistingTtl\(/, 'must reuse the runSeed phase-1 graceful helper');
    assert.match(src, /process\.exit\(0\)/, 'closed-market skip is exit 0, never 75');
  });

  it('ais-relay gates the equity block only, with a state-transition log', () => {
    const src = readSrc('scripts/ais-relay.cjs');
    assert.match(src, /require\('\.\/shared\/market-hours\.cjs'\)/);
    assert.match(src, /isUsEquityTradingDay\(/);
    // crypto is 24/7 — its seeding call must not sit behind the equity gate
    assert.match(src, /const cr = await seedCryptoQuotes\(\);/);
  });

  it('Dockerfile.relay COPYs the new shared helper (scripts/shared/ is copied per-file)', () => {
    const src = readSrc('Dockerfile.relay');
    assert.match(src, /COPY scripts\/shared\/closed-market-equity-maintenance\.cjs \.\/scripts\/shared\/closed-market-equity-maintenance\.cjs/);
    assert.match(src, /COPY scripts\/shared\/market-hours\.cjs \.\/scripts\/shared\/market-hours\.cjs/);
  });
});
