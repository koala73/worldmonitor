import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  auditCountryStockIndexes,
  chartUrl,
  classify,
  countFiniteCloses,
  exitCodeFor,
} from '../scripts/audit-country-stock-index-symbols.mjs';

// #6240: the audit is the only thing that can say when an `unavailable` flag
// should be lifted or a live symbol has died, so its decision table is pinned
// here without the network. The seeder's URL shape is reused verbatim so the
// audit cannot pass on a chart the seeder would never request.

function chart(closes) {
  return { chart: { result: [{ meta: { currency: 'EUR' }, indicators: { quote: [{ close: closes }] } }] } };
}

test('the audit requests the exact chart the seeder requests', () => {
  assert.equal(
    chartUrl('^PX'),
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EPX?range=1mo&interval=1d',
  );
  const seederSource = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
  assert.ok(
    seederSource.includes('/v8/finance/chart/${encodeURIComponent(index.symbol)}?range=1mo&interval=1d'),
    'the seeder changed its country-index chart URL; update chartUrl() to match',
  );
});

test('finite-close counting ignores nulls and a missing result', () => {
  assert.equal(countFiniteCloses(chart([1, null, 2, Number.NaN, 3])), 3);
  assert.equal(countFiniteCloses({ chart: { result: [] } }), 0);
  assert.equal(countFiniteCloses(undefined), 0);
});

test('the decision table distinguishes the contract-versus-Yahoo outcomes', () => {
  const live = { code: 'DE', symbol: '^GDAXI', name: 'DAX' };
  const flagged = { ...live, code: 'RU', unavailable: { checked: '2026-09-13', reason: 'dead' } };
  assert.equal(classify(live, { snapshot: true, error: null }), 'ok');
  assert.equal(classify(live, { snapshot: false, error: null }), 'dead-but-serviceable');
  assert.equal(classify(flagged, { snapshot: false, error: null }), 'flagged-still-dead');
  assert.equal(classify(flagged, { snapshot: true, error: null }), 'flag-can-lift');
});

test('a failed probe is inconclusive for flagged and serviceable entries alike', () => {
  // A rate-limited run must not tell the operator to flag a live country or
  // confirm a flag it never actually checked.
  const live = { code: 'DE', symbol: '^GDAXI', name: 'DAX' };
  const flagged = { ...live, code: 'RU', unavailable: { checked: '2026-09-13', reason: 'dead' } };
  assert.equal(classify(live, { snapshot: false, error: 'HTTP 429' }), 'probe-error');
  assert.equal(classify(flagged, { snapshot: false, error: 'HTTP 429' }), 'probe-error');
});

test('the exit code separates a contract disagreement from an inconclusive run', () => {
  const rows = (...verdicts) => verdicts.map((verdict) => ({ verdict }));
  assert.equal(exitCodeFor(rows('ok', 'flagged-still-dead')), 0);
  assert.equal(exitCodeFor(rows('ok', 'probe-error')), 2);
  assert.equal(exitCodeFor(rows('probe-error', 'dead-but-serviceable')), 1);
  assert.equal(exitCodeFor(rows('flag-can-lift')), 1);
});

test('a probe failure is recorded per country and never aborts the run', async () => {
  const indexes = [
    { code: 'DE', symbol: '^GDAXI', name: 'DAX' },
    { code: 'PL', symbol: '^WIG20', name: 'WIG20', unavailable: { checked: '2026-09-13', reason: 'dead' } },
    { code: 'PT', symbol: 'PSI20.LS', name: 'PSI' },
  ];
  const requested = [];
  const rows = await auditCountryStockIndexes({
    indexes,
    delayMs: 0,
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes('GDAXI')) return chart([100, 101, 102]);
      if (url.includes('WIG20')) return chart([]);
      throw new Error('retries exhausted');
    },
  });

  assert.equal(requested.length, 3, 'every declared entry is probed, flagged ones included');
  assert.deepEqual(
    rows.map((row) => [row.code, row.verdict, row.snapshot]),
    [
      ['DE', 'ok', true],
      ['PL', 'flagged-still-dead', false],
      ['PT', 'probe-error', false],
    ],
  );
  assert.equal(rows[2].error, 'retries exhausted');
});
