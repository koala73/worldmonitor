// FX panel row mappers — issue #6199 (#6231).
//
// Four seeded payloads feed one panel, and they do NOT agree on quote
// direction, envelope shape, or nullability. That disagreement is the whole
// reason these mappers exist rather than object literals at the call site:
//
//   economic:fx:yoy:v1   { rates: [...] }        currentRate = USD per 1 CCY
//   shared:fx-rates:v1   { CCY: number } flat    value       = USD per 1 CCY
//   economic:ecb-fx-rates:v1 (via RPC)           rate        = CCY per 1 EUR
//   economic:cbr-rates:v1 { rates: {...} }       rate        = RUB per 1 CCY
//
// Rendering any of these under the wrong base quotes the rate upside down —
// the exact failure the issue calls out for the RUB table. These tests pin the
// direction on each mapper so a later "simplification" cannot silently flip it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FX_STRESS_THRESHOLD_PCT,
  degradedSources,
  toFxStressRows,
  toRubQuoteRows,
  toUsdSpotRows,
  toEurSpotRows,
} from '../src/services/economic/fx-rates.ts';

// ─── economic:fx:yoy:v1 ────────────────────────────────────────────────────────
//
// Shape per scripts/seed-fx-yoy.mjs:136-147. `currentRate` is the close of the
// Yahoo symbol `{CCY}USD=X`, i.e. the price of one unit of CCY in USD, so a
// FALLING series is depreciation and both yoyChange and drawdown24m are
// negative for a currency under stress.

function yoyRecord(overrides = {}) {
  return {
    countryCode: 'AR',
    currency: 'ARS',
    currentRate: 0.00069,
    yearAgoRate: 0.00112,
    yoyChange: -38.4,
    drawdown24m: -41.0,
    peakRate: 0.00117,
    peakDate: '2024-09-01',
    troughRate: 0.00069,
    troughDate: '2026-07-01',
    asOf: '2026-08-01',
    yearAgo: '2025-08-01',
    ...overrides,
  };
}

function yoyPayload(rates = [yoyRecord()]) {
  return { rates, fetchedAt: '2026-08-05T06:30:00.000Z' };
}

test('maps an fx:yoy record onto a stress row, preserving sign', () => {
  const [row] = toFxStressRows(yoyPayload());
  assert.equal(row.countryCode, 'AR');
  assert.equal(row.currency, 'ARS');
  assert.equal(row.yoyChange, -38.4);
  assert.equal(row.drawdown24m, -41.0);
  assert.equal(row.peakDate, '2024-09-01');
  assert.equal(row.troughDate, '2026-07-01');
  assert.equal(row.asOf, '2026-08-01');
  // Depreciation must stay negative. An abs() or a flipped subtraction here
  // would render Argentina as a 38% GAIN.
  assert.ok(row.yoyChange < 0, 'ARS depreciated against USD');
  assert.ok(row.drawdown24m < 0, 'a drawdown is never positive');
});

test('sorts worst drawdown first, not by currency or insertion order', () => {
  const rows = toFxStressRows(yoyPayload([
    yoyRecord({ currency: 'CHF', countryCode: 'CH', drawdown24m: -2.1, yoyChange: 1.4 }),
    yoyRecord({ currency: 'ARS', countryCode: 'AR', drawdown24m: -41.0 }),
    yoyRecord({ currency: 'TRY', countryCode: 'TR', drawdown24m: -30.1, yoyChange: -28.4 }),
  ]));
  assert.deepEqual(rows.map((r) => r.currency), ['ARS', 'TRY', 'CHF']);
});

test('flags rows past the methodology stress threshold', () => {
  // -15% is the threshold the resilience FX Stress family uses
  // (scripts/backtest-resilience-outcomes.mjs:348). Surfacing it lets the panel
  // mark which currencies the methodology would actually call stressed.
  assert.equal(FX_STRESS_THRESHOLD_PCT, -15);
  const rows = toFxStressRows(yoyPayload([
    yoyRecord({ currency: 'ARS', drawdown24m: -41.0 }),
    yoyRecord({ currency: 'CHF', drawdown24m: -2.1 }),
    yoyRecord({ currency: 'EGP', drawdown24m: -15 }),
  ]));
  const byCcy = Object.fromEntries(rows.map((r) => [r.currency, r.stressed]));
  assert.equal(byCcy.ARS, true);
  assert.equal(byCcy.CHF, false);
  assert.equal(byCcy.EGP, true, 'the threshold is inclusive — -15 is stressed');
});

test('drops records that cannot be rendered rather than emitting NaN rows', () => {
  const rows = toFxStressRows(yoyPayload([
    yoyRecord(),
    yoyRecord({ currency: 'XXX', countryCode: 'ZZ', drawdown24m: null, yoyChange: null }),
    yoyRecord({ currency: 'YYY', countryCode: 'ZY', drawdown24m: Number.NaN }),
    yoyRecord({ currency: '', countryCode: '' }),
    yoyRecord({ currency: 'ZZZ', countryCode: 'ZX', drawdown24m: '-20' }),
    null,
    'not-a-record',
  ]));
  assert.deepEqual(rows.map((r) => r.currency), ['ARS']);
});

test('rejects a drawdown outside the physically possible [-100, 0] range', () => {
  // A drawdown is a percentage of the peak, and the seeder rejects non-positive
  // closes, so the trough is always > 0 — a loss past -100% cannot happen and a
  // record claiming one is malformed. -100 exactly is the boundary and stays.
  const rows = toFxStressRows(yoyPayload([
    yoyRecord({ currency: 'DEEP', countryCode: 'ZZ', drawdown24m: -250 }),
    yoyRecord({ currency: 'EDGE', countryCode: 'ZY', drawdown24m: -100 }),
    yoyRecord({ currency: 'PAST', countryCode: 'ZX', drawdown24m: -100.1 }),
  ]));
  assert.deepEqual(rows.map((r) => r.currency), ['EDGE']);
});

test('rejects a positive drawdown as malformed, but keeps a zero one', () => {
  // A peak-to-trough loss cannot be positive: seed-fx-yoy.mjs seeds
  // worstDrawdown = 0 and only ever lowers it. A positive value means the
  // record is malformed, and rendering it paints a green "+7.0%" gain into a
  // loss-only column. Zero is legitimate (a currency that only appreciated).
  const rows = toFxStressRows(yoyPayload([
    yoyRecord({ currency: 'BAD', countryCode: 'ZZ', drawdown24m: 7 }),
    yoyRecord({ currency: 'AED', countryCode: 'AE', drawdown24m: 0, yoyChange: 0 }),
    yoyRecord({ currency: 'INF', countryCode: 'ZY', drawdown24m: Number.POSITIVE_INFINITY }),
  ]));
  assert.deepEqual(rows.map((r) => r.currency), ['AED']);
  assert.equal(rows[0].drawdown24m, 0);
  assert.equal(rows[0].stressed, false);
});

test('a record with a usable drawdown but no yoyChange still renders', () => {
  // The two numbers are independent: drawdown24m is the differentiated signal
  // and must not be withheld just because the 12-month anchor bar was missing.
  const [row] = toFxStressRows(yoyPayload([yoyRecord({ yoyChange: null })]));
  assert.equal(row.currency, 'ARS');
  assert.equal(row.yoyChange, null);
  assert.equal(row.drawdown24m, -41.0);
});

test('tolerates a raw {_seed, data} envelope from a non-bootstrap reader', () => {
  // /api/bootstrap strips the envelope (api/bootstrap.js:300), so the client
  // path never sees one. This covers a reader that goes straight to the cache:
  // an enveloped payload has no top-level `rates`, so without the unwrap the
  // mapper would return [] and the panel would show "no data" against a
  // perfectly healthy seed.
  const rows = toFxStressRows({ _seed: { fetchedAt: 1 }, data: yoyPayload() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, 'ARS');
});

test('returns an empty list for every unusable fx:yoy payload', () => {
  for (const bad of [undefined, null, {}, { rates: null }, { rates: {} }, { rates: [] }, 'x', 42]) {
    assert.deepEqual(toFxStressRows(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

// ─── shared:fx-rates:v1 ────────────────────────────────────────────────────────
//
// A FLAT map, not a list: { USD: 1.0, JPY: 0.0067, ... } where the value is the
// close of `{CCY}USD=X` — USD per ONE unit of CCY (scripts/seed-fx-rates.mjs:38,
// fallbacks at scripts/_seed-utils.mjs:190-201 confirm the direction: JPY 0.0067).
// Market convention quotes the inverse (USD/JPY ~ 149), so the mapper carries
// BOTH and names each explicitly.

const USD_PAYLOAD = { USD: 1, JPY: 0.0067, GBP: 1.27, KWD: 3.252, ARS: 0.00069 };

test('maps USD rates carrying both directions, correctly named', () => {
  const rows = toUsdSpotRows(USD_PAYLOAD);
  const jpy = rows.find((r) => r.currency === 'JPY');
  assert.equal(jpy.usdPerUnit, 0.0067, 'one yen is a fraction of a dollar');
  assert.ok(Math.abs(jpy.unitsPerUsd - 149.2537) < 0.001, 'one dollar is ~149 yen');
  // Inverting the wrong one is the classic bug: it would print "1 USD = 0.0067 JPY".
  assert.ok(jpy.unitsPerUsd > 1 && jpy.usdPerUnit < 1);

  const kwd = rows.find((r) => r.currency === 'KWD');
  assert.equal(kwd.usdPerUnit, 3.252, 'the dinar is worth more than a dollar');
  assert.ok(kwd.unitsPerUsd < 1, 'so one dollar buys less than one dinar');
});

test('drops the USD self-quote', () => {
  // "1 USD = 1 USD" is noise, and it sorts to the top of any rate-ordered list.
  assert.equal(toUsdSpotRows(USD_PAYLOAD).some((r) => r.currency === 'USD'), false);
});

test('drops unusable USD values instead of rendering 0 or Infinity', () => {
  // Defensive, NOT the observed failure path. seed-fx-rates.mjs:52 writes
  // `fallbacks[c] ?? null`, but SHARED_FX_FALLBACKS covers all 47 currencies,
  // so the `?? null` arm is unreachable — a failed fetch publishes a hardcoded
  // constant instead. These inputs are still worth pinning (0 divides to
  // Infinity on the inverse; a string renders NaN), but do NOT read this test
  // as evidence that a failed upstream fetch is visibly handled. It is not.
  const rows = toUsdSpotRows({
    JPY: 0.0067, NGN: null, VND: undefined, LBP: 0, EGP: Number.NaN, ZAR: '0.054',
    // A positive denormal clears both the finite check and `> 0`, then divides
    // to Infinity — which formatRate would render as a bare infinity sign under
    // a live-rate heading. The inverse itself has to be checked.
    SYP: Number.MIN_VALUE,
    TRY: -0.03,
  });
  assert.deepEqual(rows.map((r) => r.currency), ['JPY']);
  for (const row of rows) assert.ok(Number.isFinite(row.unitsPerUsd), `${row.currency} inverted to a non-finite value`);
});

test('drops fallback-sourced currencies and the provenance array itself', () => {
  // The real post-#6233 shape: seed-fx-rates.mjs nulls every currency whose
  // live fetch failed and lists them under `fallbackCurrencies`, so a null here
  // means "hardcoded constant, not a quote". Rendering those as live rates
  // under a Yahoo heading was #6220. `fallbackCurrencies` rides in the same
  // flat map and must never be mistaken for a currency.
  const rows = toUsdSpotRows({
    USD: 1,
    JPY: 0.0067,
    GBP: 1.27,
    KRW: null,
    VND: null,
    fallbackCurrencies: ['KRW', 'VND'],
  });
  assert.deepEqual(rows.map((r) => r.currency), ['GBP', 'JPY']);
  assert.equal(rows.some((r) => r.currency === 'fallbackCurrencies'), false);
});

test('sorts USD spot rows alphabetically for a scannable table', () => {
  assert.deepEqual(
    toUsdSpotRows(USD_PAYLOAD).map((r) => r.currency),
    ['ARS', 'GBP', 'JPY', 'KWD'],
  );
});

test('tolerates a raw envelope and rejects unusable USD payloads', () => {
  assert.equal(toUsdSpotRows({ _seed: {}, data: USD_PAYLOAD }).length, 4);
  for (const bad of [undefined, null, {}, [], 'x', 42]) {
    assert.deepEqual(toUsdSpotRows(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

// ─── degraded-source detection ─────────────────────────────────────────────────
//
// The client loaders return the same value for a transport failure and a cache
// miss, so "this source is empty" is the only signal available. None of the
// four has a plausible genuine empty — 45 currencies, 47 USD rates, 7 ECB
// pairs, 54 CBR pairs — so an empty one is a dead one, and that inference is
// what drives the panel's degraded notice and its retry.

test('names exactly the sources that came back empty', () => {
  const full = { stress: [{}], usd: [{}], eur: [{}], rub: [{}] };
  assert.deepEqual(degradedSources(full), []);
  assert.deepEqual(degradedSources({ ...full, stress: [] }), ['stress']);
  assert.deepEqual(degradedSources({ ...full, usd: [] }), ['usd']);
  assert.deepEqual(degradedSources({ ...full, eur: [] }), ['eur']);
  assert.deepEqual(degradedSources({ ...full, rub: [] }), ['rub']);
});

test('reports every empty source, not just the first', () => {
  // A one-source-only report would leave the panel silently omitting a table
  // it never named.
  assert.deepEqual(
    degradedSources({ stress: [], usd: [], eur: [], rub: [] }),
    ['stress', 'usd', 'eur', 'rub'],
  );
  assert.deepEqual(
    degradedSources({ stress: [], usd: [{}], eur: [], rub: [] }),
    ['stress', 'eur', 'rub'],
  );
  assert.deepEqual(
    degradedSources({ stress: [], usd: [{}], eur: [], rub: [{}] }),
    ['stress', 'eur'],
  );
});

// ─── freshness span ────────────────────────────────────────────────────────────

test('stress rows can disagree on asOf — the mapper preserves each row date', () => {
  // The seeder fetches per currency and skips a failed one rather than failing
  // the run, so a frozen currency keeps an older `asOf` while its neighbours
  // advance. The panel needs both ends to show a span instead of presenting the
  // freshest row's date as the whole table's freshness.
  const rows = toFxStressRows(yoyPayload([
    yoyRecord({ currency: 'ARS', drawdown24m: -41, asOf: '2026-08-01' }),
    yoyRecord({ currency: 'TRY', drawdown24m: -30, asOf: '2026-07-24' }),
  ]));
  assert.deepEqual(rows.map((r) => r.asOf), ['2026-08-01', '2026-07-24']);
});

// ─── economic:ecb-fx-rates:v1 ──────────────────────────────────────────────────
//
// Reaches the client already typed, through the existing getEcbFxRatesData()
// RPC (server/worldmonitor/economic/v1/get-ecb-fx-rates.ts). `pair` is EURXXX
// and `rate` is XXX per ONE euro — the opposite base from both keys above,
// which is why these rows are a separate list and never merged with them.

const ECB_RATES = [
  { pair: 'EURJPY', rate: 171.2, date: '2026-08-04', change1d: -0.31 },
  { pair: 'EURUSD', rate: 1.148, date: '2026-08-04', change1d: 0.12 },
  { pair: 'EURGBP', rate: 0.861, date: '2026-08-04', change1d: 0 },
];

test('maps ECB pairs to EUR-base rows in the established display order', () => {
  // The order matches EUR_FX_ORDER in src/app/data-loader.ts:2394, which the
  // CommoditiesPanel FX tab already uses — the same seven pairs must not
  // reorder depending on which surface renders them.
  const rows = toEurSpotRows(ECB_RATES);
  assert.deepEqual(rows.map((r) => r.currency), ['USD', 'GBP', 'JPY']);
  const jpy = rows.find((r) => r.currency === 'JPY');
  assert.equal(jpy.rate, 171.2, 'one euro is many yen');
  assert.equal(jpy.change1d, -0.31);
});

test('appends an unranked pair after the seven, rather than dropping it', () => {
  // The rank fallback (MAX_SAFE_INTEGER for a pair outside EUR_FX_ORDER) was
  // untested: every other fixture uses ranked pairs, so deleting it changed
  // nothing. If the ECB seeder ever publishes an eighth pair it must surface
  // here rather than vanish — and must not jump ahead of the curated seven.
  const rows = toEurSpotRows([
    { pair: 'EURSEK', rate: 11.2, change1d: 0.03 },
    { pair: 'EURJPY', rate: 171.2, change1d: -0.31 },
    { pair: 'EURUSD', rate: 1.148, change1d: 0.12 },
  ]);
  assert.deepEqual(rows.map((r) => r.currency), ['USD', 'JPY', 'SEK']);
});

test('preserves a zero change1d instead of collapsing it to null', () => {
  // 0 is "unchanged today" and is a real observation; ?? vs || matters here.
  const gbp = toEurSpotRows(ECB_RATES).find((r) => r.currency === 'GBP');
  assert.equal(gbp.change1d, 0);
  assert.notEqual(gbp.change1d, null);
});

test('renders a pair with no change1d rather than dropping the rate', () => {
  const rows = toEurSpotRows([{ pair: 'EURUSD', rate: 1.148, date: '2026-08-04' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rate, 1.148);
  assert.equal(rows[0].change1d, null);
});

test('drops ECB entries with an unusable pair or rate', () => {
  const rows = toEurSpotRows([
    { pair: 'EURUSD', rate: 1.148, change1d: 0.12 },
    { pair: 'EURXXX', rate: null },
    { pair: 'USDJPY', rate: 149 },
    { pair: 'EUR', rate: 1 },
    { rate: 1.1 },
    null,
    // A rate of 0 or below is not a quote. Without these the `rate <= 0` half
    // of the guard is untested: deleting it leaves every other case passing
    // because they are all caught by the null check.
    { pair: 'EURZZZ', rate: 0 },
    { pair: 'EURYYY', rate: -1.5 },
  ]);
  assert.deepEqual(rows.map((r) => r.currency), ['USD']);
});

test('returns an empty list for every unusable ECB input', () => {
  for (const bad of [undefined, null, [], {}, 'x']) {
    assert.deepEqual(toEurSpotRows(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

// ─── economic:cbr-rates:v1 ────────────────────────────────────────────────────
//
// Reaches the client via ensureHydrated('cbrRates'). `rates` is a MAP of code
// -> { rate, valuePerNominal, nominal, name, numCode, id, change1d }, and
// `rate` is RUB per ONE unit of the listed currency (Value / Nominal,
// scripts/seed-cbr-rates.mjs:200). That is a THIRD quote direction — the
// direct inverse of both Spot lists — so these rows are a separate list and
// never merged with them. `nominal` rides in the payload precisely so a
// consumer that reaches for it instead of `rate` is off by that factor and
// gets caught; this mapper reads `rate` alone.

const CBR_PAYLOAD = {
  quoteCurrency: 'RUB',
  rateUnit: 'RUB per 1 unit of the listed currency',
  effectiveDate: '2026-08-05',
  rates: {
    USD: { rate: 81.1291, valuePerNominal: 81.1291, nominal: 1, name: 'Доллар США', numCode: '840', id: 'R01235', change1d: 0.32 },
    JPY: { rate: 0.515171, valuePerNominal: 51.5171, nominal: 100, name: 'Иен', numCode: '392', id: 'R01820', change1d: 0.0012 },
    UZS: { rate: 0.0064657, valuePerNominal: 64.657, nominal: 10000, name: 'Узбекских сумов', numCode: '860', id: 'R01717', change1d: -0.00001 },
  },
  keyRate: { rate: 14, observedAt: '2026-08-04', previousRate: 14, changedAt: '2026-07-24', change: 0 },
  updatedAt: '2026-08-05T06:30:00.000Z',
  seededAt: 1,
};

function cbrRates(rates) {
  return { ...CBR_PAYLOAD, rates };
}

test('maps CBR rates to RUB-per-unit rows, preserving the non-USD direction', () => {
  const rows = toRubQuoteRows(CBR_PAYLOAD);
  assert.deepEqual(rows.map((r) => r.currency), ['JPY', 'USD', 'UZS']);
  const usd = rows.find((r) => r.currency === 'USD');
  // 1 USD costs ~81 RUB — a magnitude that inverts to "1 RUB buys 0.012 USD".
  // Rendering this pair into either Spot list would silently flip the quote.
  assert.ok(usd.rubPerUnit > 1);
  assert.equal(usd.rubPerUnit, 81.1291);
  assert.equal(usd.change1d, 0.32);
  const jpy = rows.find((r) => r.currency === 'JPY');
  // JPY is quoted per 100 by CBR, so the mapped rate must already be per-unit
  // (51.5 / 100). A mapper that reached for the raw Value would report 51.5.
  assert.ok(jpy.rubPerUnit < 1);
  assert.equal(jpy.rubPerUnit, 0.515171);
});

test('skips the RUB self-quote', () => {
  // "1 RUB = 1 RUB" is the same noise the USD self-quote is in the USD list.
  assert.equal(toRubQuoteRows(cbrRates({ RUB: { rate: 1, nominal: 1, change1d: 0 } }))
    .some((r) => r.currency === 'RUB'), false);
});

test('keeps a RUB row with no change1d rather than dropping the rate', () => {
  // A missing prior-day table leaves change1d null (never 0); the rate itself
  // is still CBR's official quote and must render.
  const rows = toRubQuoteRows(cbrRates({
    USD: { rate: 81.1291, nominal: 1, name: '', numCode: '840', id: '' },
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rubPerUnit, 81.1291);
  assert.equal(rows[0].change1d, null);
});

test('drops RUB entries with an unusable rate or a null rate object', () => {
  const rows = toRubQuoteRows(cbrRates({
    USD: { rate: 81.1291, nominal: 1, change1d: 0.32 },
    EUR: { rate: 0, nominal: 1, change1d: 0 },        // 0 is not a quote
    GBP: { rate: -1, nominal: 1, change1d: 0 },       // a negative rate cannot happen
    CNY: { rate: Number.NaN, nominal: 1, change1d: 0 },
    KZT: { rate: '12.34', nominal: 1, change1d: 0 },  // string, not a number
    TRY: { rate: undefined, nominal: 1, change1d: 0 },
    BRL: null,                                        // whole record malformed
    RUB: { rate: 1, nominal: 1, change1d: 0 },
  }));
  assert.deepEqual(rows.map((r) => r.currency), ['USD']);
});

test('sorts RUB rows alphabetically for a scannable table', () => {
  const rows = toRubQuoteRows(cbrRates({
    ZAR: { rate: 4.5, nominal: 1, change1d: 0 },
    USD: { rate: 81.1291, nominal: 1, change1d: 0 },
    KZT: { rate: 0.17, nominal: 1, change1d: 0 },
  }));
  assert.deepEqual(rows.map((r) => r.currency), ['KZT', 'USD', 'ZAR']);
});

test('tolerates a raw envelope and rejects unusable RUB payloads', () => {
  assert.equal(toRubQuoteRows({ _seed: {}, data: CBR_PAYLOAD }).length, 3);
  for (const bad of [undefined, null, {}, { rates: [] }, { rates: null }, [], 'x', 42]) {
    assert.deepEqual(toRubQuoteRows(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});
