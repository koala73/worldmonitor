// Pin the BIS LBS combination math. Plan 2026-04-25-004 §Component 2.
//
// The pure helpers `combineLbsByCounterparty` and
// `extractClaimsByCounterparty` are exported so these tests run fully
// offline. Real BIS SDMX network shape is known and pinned via a
// realistic SDMX-JSON fixture below.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  combineLbsByCounterparty,
  extractClaimsByCounterparty,
  validate,
  PARENT_COUNTRIES,
} from '../scripts/seed-bis-lbs.mjs';

describe('combineLbsByCounterparty — sum across parents + GDP normalization', () => {
  it('Brazil: $300B claims aggregated from US + GB / $2T GDP = 15% of GDP, parentCount=2', () => {
    const perParent = {
      US: { byCounterparty: { BR: 200_000 }, latestPeriod: '2024-Q4' }, // 200B in millions
      GB: { byCounterparty: { BR: 100_000 }, latestPeriod: '2024-Q4' }, // 100B
    };
    const gdpByCountry = { BR: { value: 2_000_000_000_000, year: 2024 } }; // $2T
    const out = combineLbsByCounterparty(perParent, gdpByCountry);
    assert.equal(out.BR.totalXborderPctGdp, 15.0);
    assert.equal(out.BR.parentCount, 2, 'both parents have claims > 1% GDP');
  });

  it('parentCount counts ONLY parents above the 1% GDP threshold', () => {
    // GB has only $5B claims = 0.25% of $2T GDP → below 1% threshold.
    const perParent = {
      US: { byCounterparty: { BR: 200_000 }, latestPeriod: '2024-Q4' }, // 200B = 10% GDP
      GB: { byCounterparty: { BR: 5_000 }, latestPeriod: '2024-Q4' },   // 5B = 0.25% GDP
    };
    const gdpByCountry = { BR: { value: 2_000_000_000_000, year: 2024 } };
    const out = combineLbsByCounterparty(perParent, gdpByCountry);
    assert.equal(out.BR.parentCount, 1, 'GB is below the 1% GDP threshold');
  });

  it('drops counterparty without GDP data (cannot normalize)', () => {
    const perParent = {
      US: { byCounterparty: { XX: 50_000 }, latestPeriod: '2024-Q4' },
    };
    const gdpByCountry = {}; // no XX
    const out = combineLbsByCounterparty(perParent, gdpByCountry);
    assert.equal(Object.keys(out).length, 0);
  });

  it('preserves per-parent provenance in the parents map', () => {
    const perParent = {
      US: { byCounterparty: { BR: 200_000 }, latestPeriod: '2024-Q4' },
      DE: { byCounterparty: { BR: 50_000 }, latestPeriod: '2024-Q4' },
    };
    const gdpByCountry = { BR: { value: 2_000_000_000_000, year: 2024 } };
    const out = combineLbsByCounterparty(perParent, gdpByCountry);
    assert.deepEqual(out.BR.parents, { US: 200_000, DE: 50_000 });
  });

  it('aggregates across all 16 enumerated parents', () => {
    // Each parent contributes $10B claims = 0.5% GDP individually.
    // 16 × 0.5% = 8% total exposure; only the parents above 1% individually
    // count toward parentCount, so 0 here (each below threshold) — this
    // pins the threshold semantics: parentCount measures redundancy at the
    // SINGLE-parent level, not aggregate.
    const perParent = {};
    for (const parent of PARENT_COUNTRIES) {
      perParent[parent] = { byCounterparty: { BR: 10_000 }, latestPeriod: '2024-Q4' };
    }
    const gdpByCountry = { BR: { value: 2_000_000_000_000, year: 2024 } };
    const out = combineLbsByCounterparty(perParent, gdpByCountry);
    assert.equal(out.BR.totalXborderPctGdp, 8.0, 'sum across 16 parents at $10B each = $160B = 8% of $2T');
    assert.equal(out.BR.parentCount, 0, 'no single parent above 1% threshold');
  });
});

describe('extractClaimsByCounterparty — SDMX-JSON shape parsing', () => {
  // Minimal SDMX-JSON fixture matching BIS WS_LBS_D_PUB response shape.
  // The dimensions array order and the colon-separated coord-string format
  // match the SDMX-JSON 1.0.0 spec.
  function buildFixture(parentClaim) {
    return {
      data: {
        dataSets: [
          {
            series: {
              // coord = "0:0:0:0:0:0:0:0:0:0:cpIdx:0" — only L_CP_COUNTRY varies
              '0:0:0:0:0:0:0:0:0:0:0:0': { observations: { '0': [parentClaim.BR] } },
              '0:0:0:0:0:0:0:0:0:0:1:0': { observations: { '0': [parentClaim.MX] } },
              '0:0:0:0:0:0:0:0:0:0:2:0': { observations: { '0': [parentClaim['5J']] } }, // BIS-aggregate, must be skipped
            },
          },
        ],
        structure: {
          dimensions: {
            series: [
              { id: 'FREQ', values: [{ id: 'Q' }] },
              { id: 'MEASURE', values: [{ id: 'S' }] },
              { id: 'L_POSITION', values: [{ id: 'C' }] },
              { id: 'L_INSTR', values: [{ id: 'A' }] },
              { id: 'L_DENOM', values: [{ id: 'TO1' }] },
              { id: 'L_CURR_TYPE', values: [{ id: 'A' }] },
              { id: 'L_PARENT_CTY', values: [{ id: 'US' }] },
              { id: 'L_REP_BANK_TYPE', values: [{ id: 'A' }] },
              { id: 'L_REP_CTY', values: [{ id: '5A' }] },
              { id: 'L_CP_SECTOR', values: [{ id: 'A' }] },
              { id: 'L_CP_COUNTRY', values: [{ id: 'BR' }, { id: 'MX' }, { id: '5J' }] },
              { id: 'L_POS_TYPE', values: [{ id: 'N' }] },
            ],
            observation: [{ id: 'TIME_PERIOD', values: [{ id: '2024-Q4' }] }],
          },
        },
      },
    };
  }

  it('extracts per-counterparty claims, skipping BIS aggregate codes (5J)', () => {
    const fixture = buildFixture({ BR: 200_000, MX: 50_000, '5J': 999_999 });
    const result = extractClaimsByCounterparty(fixture);
    assert.equal(result.byCounterparty.BR, 200_000);
    assert.equal(result.byCounterparty.MX, 50_000);
    assert.ok(!('5J' in result.byCounterparty), 'BIS aggregate 5J must be skipped');
    assert.equal(result.latestPeriod, '2024-Q4');
  });

  it('returns empty maps gracefully when SDMX shape is unexpected', () => {
    const result = extractClaimsByCounterparty({ data: { dataSets: [] } });
    assert.deepEqual(result.byCounterparty, {});
    assert.equal(result.latestPeriod, null);
  });

  it('drops counterparty when claim value exceeds 1e8 millions (upper-bound corruption guard)', () => {
    // 2e8 millions = $200T — far above any plausible bilateral claim
    // (global GDP is ~$110T). Treat as parser corruption, drop silently.
    function buildFixtureWithCorruptValue(corruptVal) {
      return {
        data: {
          dataSets: [
            {
              series: {
                '0:0:0:0:0:0:0:0:0:0:0:0': { observations: { '0': [corruptVal] } },
                '0:0:0:0:0:0:0:0:0:0:1:0': { observations: { '0': [50_000] } }, // legitimate
              },
            },
          ],
          structure: {
            dimensions: {
              series: [
                { id: 'FREQ', values: [{ id: 'Q' }] },
                { id: 'MEASURE', values: [{ id: 'S' }] },
                { id: 'L_POSITION', values: [{ id: 'C' }] },
                { id: 'L_INSTR', values: [{ id: 'A' }] },
                { id: 'L_DENOM', values: [{ id: 'TO1' }] },
                { id: 'L_CURR_TYPE', values: [{ id: 'A' }] },
                { id: 'L_PARENT_CTY', values: [{ id: 'US' }] },
                { id: 'L_REP_BANK_TYPE', values: [{ id: 'A' }] },
                { id: 'L_REP_CTY', values: [{ id: '5A' }] },
                { id: 'L_CP_SECTOR', values: [{ id: 'A' }] },
                { id: 'L_CP_COUNTRY', values: [{ id: 'BR' }, { id: 'MX' }] },
                { id: 'L_POS_TYPE', values: [{ id: 'N' }] },
              ],
              observation: [{ id: 'TIME_PERIOD', values: [{ id: '2024-Q4' }] }],
            },
          },
        },
      };
    }
    const result = extractClaimsByCounterparty(buildFixtureWithCorruptValue(2e8));
    assert.ok(!('BR' in result.byCounterparty), 'corrupt value must be dropped');
    assert.equal(result.byCounterparty.MX, 50_000, 'legitimate value passes through');
  });

  it('throws when L_CP_COUNTRY dimension is missing (parser regression guard)', () => {
    const broken = {
      data: {
        dataSets: [{ series: { '0:0:0:0': { observations: { '0': [100] } } } }],
        structure: { dimensions: { series: [{ id: 'X', values: [] }], observation: [{ id: 'TIME_PERIOD', values: [] }] } },
      },
    };
    assert.throws(() => extractClaimsByCounterparty(broken), /missing L_CP_COUNTRY/);
  });
});

describe('validate', () => {
  it('rejects empty payload', () => {
    assert.equal(validate({ countries: {} }), false);
  });

  it('rejects payload below 150-country floor', () => {
    const tiny = {};
    for (let i = 0; i < 100; i++) {
      tiny[`X${i.toString().padStart(2, '0')}`] = { totalXborderPctGdp: 5, parentCount: 2, parents: {}, gdpYear: 2024 };
    }
    assert.equal(validate({ countries: tiny }), false);
  });

  it('accepts payload at or above the BIS LBS floor', () => {
    const ample = {};
    for (let i = 0; i < 160; i++) {
      ample[`X${i.toString().padStart(2, '0')}`] = { totalXborderPctGdp: 5, parentCount: 2, parents: {}, gdpYear: 2024 };
    }
    assert.equal(validate({ countries: ample }), true);
  });
});
