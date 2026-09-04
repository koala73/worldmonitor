// Sparkline precision lockstep audit.
//
// The sparkline rounding lives in TWO independent implementations that write the
// SAME FAST-tier keys (market:stocks-bootstrap:v1, market:commodities-bootstrap:v1):
//
//   1. scripts/_seed-utils.mjs — canonical roundSparkline/toSignificantDigits,
//      driven by the SPARKLINE_SIGNIFICANT_DIGITS constant. Used by the cron seeders.
//   2. scripts/ais-relay.cjs — _parseYahooChartJson's inline copy. CommonJS cannot
//      import the ESM helper, so the duplication is deliberate.
//
// Whichever writer wins the relay/cron race decides what every cold visitor
// downloads. If the constant is bumped (7 -> 6) and the relay's literal is not,
// every existing suite stays green while the two writers silently begin emitting
// different bytes for the same key. This audit is the guard against that, and
// follows the same shape as tests/news-classify-cache-prefix-audit.test.mjs,
// which exists because the classify cache prefix was burned by this exact hazard.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseYahooChart, SPARKLINE_SIGNIFICANT_DIGITS, roundSparkline } from '../scripts/_seed-utils.mjs';

const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

// The rounding expression inside _parseYahooChartJson.
const RELAY_PRECISION_RE = /toPrecision\((\d+)\)/g;

function extractFunction(name) {
  const start = RELAY_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not find ${name} in ais-relay.cjs`);
  const bodyStart = RELAY_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < RELAY_SOURCE.length; i += 1) {
    if (RELAY_SOURCE[i] === '{') depth += 1;
    if (RELAY_SOURCE[i] === '}') depth -= 1;
    if (depth === 0) return RELAY_SOURCE.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name} in ais-relay.cjs`);
}

const relayObservationGuard = RELAY_SOURCE.includes('function _finiteObservation(')
  ? extractFunction('_finiteObservation')
  : '';
const parseRelayYahooChart = Function(
  `${relayObservationGuard}\n${extractFunction('_parseYahooChartJson')}\nreturn _parseYahooChartJson;`,
)();

function chart(meta, close = []) {
  return { chart: { result: [{ meta, indicators: { quote: [{ close }] } }] } };
}

function parseRelayChart(data) {
  return parseRelayYahooChart(JSON.stringify(data));
}

describe('ais-relay sparkline precision stays in lockstep with _seed-utils', () => {
  it('the canonical constant is what the seeder actually uses', () => {
    assert.equal(SPARKLINE_SIGNIFICANT_DIGITS, 7);
    assert.deepEqual(roundSparkline([17.209999999999997]), [17.21]);
  });

  it('every toPrecision literal in ais-relay.cjs matches SPARKLINE_SIGNIFICANT_DIGITS', () => {
    const found = [...RELAY_SOURCE.matchAll(RELAY_PRECISION_RE)].map((m) => Number(m[1]));
    assert.ok(
      found.length > 0,
      'no toPrecision() call found in ais-relay.cjs — the sparkline rounding was removed or '
      + 'renamed. Update this audit deliberately rather than deleting it.',
    );
    for (const digits of found) {
      assert.equal(
        digits, SPARKLINE_SIGNIFICANT_DIGITS,
        `ais-relay.cjs rounds to ${digits} significant digits but _seed-utils.mjs's `
        + `SPARKLINE_SIGNIFICANT_DIGITS is ${SPARKLINE_SIGNIFICANT_DIGITS}. The relay and the cron `
        + 'seeders write the same bootstrap keys — bump both or neither.',
      );
    }
  });
});

describe('the two implementations agree on the values they emit', () => {
  const cases = [
    ['float64 noise', [17.209999999999997, 16.829999923706055, 17.3]],
    ['fx-scale values', [0.6917063999999999, 0.6921236, 0.6908956]],
    ['zero and non-finite', [0, Number.NaN, Number.POSITIVE_INFINITY]],
    ['non-numeric passthrough', ['N/A', false]],
    ['extreme exponents', [1.2345678901e21, 1.2345678901e-9]],
  ];

  for (const [name, input] of cases) {
    it(`matches parseYahooChart for ${name}`, () => {
      const data = chart({ regularMarketPrice: 100, previousClose: 100 }, input);
      assert.deepEqual(
        parseRelayChart(data).sparkline,
        parseYahooChart(data, 'TEST').sparkline,
        `relay and seeder must serialise identically for ${name}`,
      );
    });
  }
});

describe('the relay rejects missing Yahoo observations', () => {
  const missing = [null, undefined, '', '   ', false, true, [], [12], {}, 'bad', NaN, Infinity, -Infinity];

  for (const price of missing) {
    it(`drops a quote whose price is ${JSON.stringify(price)}`, () => {
      assert.equal(parseRelayChart(chart({ regularMarketPrice: price })), null);
    });
  }

  it('filters invalid closes and keeps numeric strings and real zeroes', () => {
    const result = parseRelayChart(
      chart({ regularMarketPrice: 100, previousClose: 100 }, [90, null, '95', false, 0, -2, 'bad']),
    );
    assert.deepEqual(result.sparkline, [90, 95, 0, -2]);
    assert.ok(result.sparkline.every(Number.isFinite));
  });

  it('falls through an unusable previous close', () => {
    const result = parseRelayChart(chart({
      regularMarketPrice: 110,
      chartPreviousClose: 'bad',
      previousClose: 100,
    }));
    assert.equal(result.change, 10);
  });

  it('keeps genuine zero and negative prices', () => {
    assert.equal(parseRelayChart(chart({ regularMarketPrice: 0, previousClose: 100 })).change, -100);
    assert.equal(parseRelayChart(chart({ regularMarketPrice: -10, previousClose: 100 })).price, -10);
  });
});
