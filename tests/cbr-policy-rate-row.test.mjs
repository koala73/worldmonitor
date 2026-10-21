// CBR key rate -> BIS policy-rate row — issue #6192.
//
// BIS WS_CBPOL covers 12 central banks and Russia is not one of them
// (scripts/seed-bis-data.mjs), so the Central Banks tab has a hole that cannot
// be closed upstream. #6154 publishes the CBR key rate; this maps it onto the
// same BisPolicyRate shape the tab already renders.
//
// The mapping is where the two contracts disagree, which is what these lock:
// BisPolicyRate requires `previousRate: number` and `date: string`, while the
// CBR payload makes both nullable — `previousRate`/`changedAt` are null whenever
// the queried window shows no rate move. Reading those straight through would
// render "NaN" and a cut/hike arrow computed from undefined.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cbrKeyRateAsPolicyRate, mergeCbrPolicyRate } from '../src/services/economic/cbr-policy-rate.ts';

/** The shape scripts/seed-cbr-rates.mjs publishes, as probed live 2026-08-05. */
function cbrPayload({ keyRate: keyRateOverrides, ...rest } = {}) {
  return {
    quoteCurrency: 'RUB',
    effectiveDate: '2026-08-05',
    rates: { USD: { rate: 81.1291, nominal: 1 } },
    ...rest,
    keyRate: {
      rate: 14,
      observedAt: '2026-08-04',
      previousRate: 14.25,
      previousObservedAt: '2026-07-24',
      changedAt: '2026-07-27',
      change: -0.25,
      observationCount: 509,
      windowStart: { date: '2024-08-05', rate: 18 },
      changes: [{ date: '2026-07-27', rate: 14 }],
      ...(keyRateOverrides ?? {}),
    },
  };
}

test('maps the CBR key rate onto the BIS policy-rate shape', () => {
  const row = cbrKeyRateAsPolicyRate(cbrPayload());
  assert.deepEqual(row, {
    countryCode: 'RU',
    countryName: 'Russia',
    centralBank: 'Bank of Russia',
    rate: 14,
    previousRate: 14.25,
    date: '2026-07-27',
  });
});

test('the row renders as a CUT, matching the direction the rate actually moved', () => {
  // The tab derives its arrow from `rate - previousRate` (EconomicPanel.ts:403),
  // so an inverted or absent previousRate silently mislabels policy direction.
  const row = cbrKeyRateAsPolicyRate(cbrPayload());
  assert.ok(row.rate - row.previousRate < 0, 'CBR cut 14.25 -> 14.00 on 2026-07-27');
});

test('a flat window falls back to the current rate rather than emitting NaN', () => {
  // previousRate/changedAt are null when the queried window shows no move. The
  // tab has no null branch: `r.rate - r.previousRate` would be NaN, and the
  // arrow would come out as neither cut, hike, nor hold.
  const row = cbrKeyRateAsPolicyRate(cbrPayload({
    keyRate: { previousRate: null, previousObservedAt: null, changedAt: null, change: null },
  }));
  assert.equal(row.previousRate, 14, 'equal to rate => renders as HOLD');
  assert.equal(row.rate - row.previousRate, 0);
  assert.ok(Number.isFinite(row.rate - row.previousRate));
});

test('a flat window dates the row from the newest observation', () => {
  // changedAt is null, but the row still needs a date string — the newest
  // observation is the honest one: it is when we last saw this rate in force.
  const row = cbrKeyRateAsPolicyRate(cbrPayload({
    keyRate: { previousRate: null, changedAt: null },
  }));
  assert.equal(row.date, '2026-08-04');
  assert.notEqual(row.date, '', 'an empty date would render a blank line in the tab');
});

test('returns null when the payload carries no usable key rate', () => {
  // Every one of these must be skipped rather than rendered as a zero-rate
  // central bank, which would sort into the tab as a real 0% policy rate.
  for (const bad of [
    undefined, null, {}, { keyRate: null }, { keyRate: {} },
    { keyRate: { rate: null, observedAt: '2026-08-04' } },
    { keyRate: { rate: Number.NaN, observedAt: '2026-08-04' } },
    { keyRate: { rate: '14', observedAt: '2026-08-04' } },
  ]) {
    assert.equal(cbrKeyRateAsPolicyRate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('returns null when the key rate has no date at all', () => {
  assert.equal(
    cbrKeyRateAsPolicyRate(cbrPayload({ keyRate: { changedAt: null, observedAt: null } })),
    null,
    'a dateless row would render a blank date line',
  );
});

test('tolerates the envelope wrapper the bootstrap endpoint may return', () => {
  // Seeded keys are written as {_seed, data} envelopes; readers vary in whether
  // they unwrap. Accepting both shapes keeps the caller from having to know.
  const inner = cbrPayload();
  const row = cbrKeyRateAsPolicyRate({ _seed: { fetchedAt: 1 }, data: inner });
  assert.equal(row?.rate, 14);
  assert.equal(row?.countryCode, 'RU');
});

// ─── merge seam ────────────────────────────────────────────────────────────────
//
// The mapper above is only half the feature; the decision of WHETHER to append
// lives in mergeCbrPolicyRate. Testing only the mapper would leave both guards
// below unreachable by the suite while every mapper test stayed green.

const BIS_ROWS = Object.freeze([
  { countryCode: 'US', countryName: 'United States', centralBank: 'Federal Reserve', rate: 4.5, previousRate: 4.75, date: '2026-06-18' },
  { countryCode: 'BR', countryName: 'Brazil', centralBank: 'Banco Central do Brasil', rate: 15, previousRate: 15, date: '2026-07-30' },
]);

test('mergeCbrPolicyRate appends Russia to the BIS rows', () => {
  const merged = mergeCbrPolicyRate(BIS_ROWS, cbrPayload());
  assert.equal(merged.length, 3);
  const ru = merged.find((r) => r.countryCode === 'RU');
  assert.equal(ru.centralBank, 'Bank of Russia');
  assert.equal(ru.rate, 14);
  // The input must not be mutated — BIS_ROWS is shared frozen state here, and in
  // production the array comes from a circuit-breaker cache that may be replayed.
  assert.equal(BIS_ROWS.length, 2);
});

test('mergeCbrPolicyRate does NOT carry the list on Russia alone', () => {
  // With BIS down, appending one row turns the tab's "no data" empty state into
  // a one-bank policy-rate table — a working feed missing eleven countries,
  // rather than a visible outage.
  assert.deepEqual(mergeCbrPolicyRate([], cbrPayload()), []);
  assert.deepEqual(mergeCbrPolicyRate(null, cbrPayload()), []);
  assert.deepEqual(mergeCbrPolicyRate(undefined, cbrPayload()), []);
});

test('mergeCbrPolicyRate lets BIS win if WS_CBPOL ever adds Russia', () => {
  // Appending unconditionally would render two "Bank of Russia" cards with
  // nothing to tell the reader which is authoritative.
  const withRu = [...BIS_ROWS, { countryCode: 'RU', countryName: 'Russia', centralBank: 'Bank of Russia', rate: 13.5, previousRate: 14, date: '2026-08-01' }];
  const merged = mergeCbrPolicyRate(withRu, cbrPayload());
  assert.equal(merged.filter((r) => r.countryCode === 'RU').length, 1);
  assert.equal(merged.find((r) => r.countryCode === 'RU').rate, 13.5, 'BIS row survives, not ours');
});

test('mergeCbrPolicyRate returns the BIS rows untouched when CBR is unavailable', () => {
  // ensureHydrated resolves undefined when the key is absent or the fetch failed.
  for (const missing of [undefined, null, {}, { keyRate: null }]) {
    assert.deepEqual(mergeCbrPolicyRate(BIS_ROWS, missing), [...BIS_ROWS]);
  }
});
