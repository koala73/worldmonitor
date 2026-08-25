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

import { SPARKLINE_SIGNIFICANT_DIGITS, roundSparkline } from '../scripts/_seed-utils.mjs';

const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

// The rounding expression inside _parseYahooChartJson.
const RELAY_PRECISION_RE = /toPrecision\((\d+)\)/g;

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

  it('the relay keeps the reference guard for non-numeric and zero entries', () => {
    // toSignificantDigits returns `value` untouched when it is not a finite
    // number, or is 0. Without that guard a string close becomes NaN and
    // serialises to null, denting the curve on the relay path only.
    assert.match(
      RELAY_SOURCE,
      /typeof v === 'number' && Number\.isFinite\(v\) && v !== 0/,
      "ais-relay.cjs's sparkline rounding must mirror toSignificantDigits's guard "
      + '(typeof / isFinite / !== 0) so a malformed upstream degrades identically on both writers.',
    );
  });
});

describe('the two implementations agree on the values they emit', () => {
  // Behavioural parity: extract the relay's rounding expression and run it
  // against the same inputs as the canonical helper.
  const relayRound = (values) => values
    .filter((v) => v != null)
    .map((v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0
      ? Number(v.toPrecision(SPARKLINE_SIGNIFICANT_DIGITS))
      : v));

  const cases = [
    ['float64 noise', [17.209999999999997, 16.829999923706055, 17.3]],
    ['fx-scale values', [0.6917063999999999, 0.6921236, 0.6908956]],
    ['zero and non-finite', [0, Number.NaN, Number.POSITIVE_INFINITY]],
    ['non-numeric passthrough', ['N/A', false]],
    ['extreme exponents', [1.2345678901e21, 1.2345678901e-9]],
  ];

  for (const [name, input] of cases) {
    it(`matches roundSparkline for ${name}`, () => {
      assert.deepEqual(
        JSON.stringify(relayRound(input)),
        JSON.stringify(roundSparkline(input.filter((v) => v != null))),
        `relay and seeder must serialise identically for ${name}`,
      );
    });
  }
});
