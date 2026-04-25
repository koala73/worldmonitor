// Schema-extension tests for swf-manifest-loader.mjs (Phase 1).
//
// Pins the new schema fields' canonical placement and rejection rules:
//   - top-level (per-fund): aum_usd, aum_year, aum_verified
//   - under classification: aum_pct_of_audited, excluded_overlaps_with_reserves
//
// Codex Round 1 #4 mandated a SINGLE canonical placement for each new
// field, with the loader REJECTING misplacement (positive control)
// rather than silently accepting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateManifest } from '../scripts/shared/swf-manifest-loader.mjs';
import {
  shouldSkipFundForBuffer,
  applyAumPctOfAudited,
  buildCoverageSummary,
} from '../scripts/seed-sovereign-wealth.mjs';

function makeFund(overrides = {}) {
  return {
    country: 'AE',
    fund: 'test-fund',
    display_name: 'Test Fund',
    classification: { access: 0.5, liquidity: 0.5, transparency: 0.5 },
    rationale: { access: 'a', liquidity: 'l', transparency: 't' },
    sources: ['https://example.com/'],
    ...overrides,
  };
}

function makeManifest(funds) {
  return {
    manifest_version: 1,
    last_reviewed: '2026-04-25',
    external_review_status: 'REVIEWED',
    funds,
  };
}

test('REJECTS aum_pct_of_audited placed at fund top level (must be under classification)', () => {
  const m = makeManifest([
    makeFund({ aum_pct_of_audited: 0.05 }),
  ]);
  assert.throws(() => validateManifest(m), /aum_pct_of_audited must be placed under classification/);
});

test('REJECTS excluded_overlaps_with_reserves placed at fund top level', () => {
  const m = makeManifest([
    makeFund({ excluded_overlaps_with_reserves: true }),
  ]);
  assert.throws(() => validateManifest(m), /excluded_overlaps_with_reserves must be placed under classification/);
});

test('ACCEPTS aum_pct_of_audited under classification when paired with rationale', () => {
  const m = makeManifest([
    makeFund({
      classification: { access: 0.9, liquidity: 0.8, transparency: 0.4, aum_pct_of_audited: 0.05 },
      rationale: { access: 'a', liquidity: 'l', transparency: 't', aum_pct_of_audited: 'GRF is ~5% of audited KIA AUM' },
    }),
  ]);
  const out = validateManifest(m);
  assert.equal(out.funds[0].classification.aumPctOfAudited, 0.05);
  assert.equal(out.funds[0].rationale.aumPctOfAudited, 'GRF is ~5% of audited KIA AUM');
});

test('REJECTS aum_pct_of_audited under classification WITHOUT a rationale paragraph', () => {
  const m = makeManifest([
    makeFund({
      classification: { access: 0.9, liquidity: 0.8, transparency: 0.4, aum_pct_of_audited: 0.05 },
      // rationale.aum_pct_of_audited is missing
    }),
  ]);
  assert.throws(() => validateManifest(m),
    /rationale\.aum_pct_of_audited: required when classification\.aum_pct_of_audited is set/);
});

test('REJECTS aum_pct_of_audited outside (0, 1] range', () => {
  // `null` is intentionally NOT in this list — the loader treats null
  // as "field absent" (the value is optional), which is correct.
  for (const bad of [0, -0.1, 1.5, 'x', NaN]) {
    const m = makeManifest([
      makeFund({
        classification: { access: 0.9, liquidity: 0.8, transparency: 0.4, aum_pct_of_audited: bad },
      }),
    ]);
    assert.throws(() => validateManifest(m), /aum_pct_of_audited: expected number in \(0, 1\]/);
  }
});

test('ACCEPTS excluded_overlaps_with_reserves: true with paired rationale', () => {
  const m = makeManifest([
    makeFund({
      classification: { access: 0.5, liquidity: 0.7, transparency: 0.3, excluded_overlaps_with_reserves: true },
      rationale: { access: 'a', liquidity: 'l', transparency: 't', excluded_overlaps_with_reserves: 'SAFE-IC overlaps PBOC reserves' },
    }),
  ]);
  const out = validateManifest(m);
  assert.equal(out.funds[0].classification.excludedOverlapsWithReserves, true);
});

test('REJECTS excluded_overlaps_with_reserves: true WITHOUT rationale paragraph', () => {
  const m = makeManifest([
    makeFund({
      classification: { access: 0.5, liquidity: 0.7, transparency: 0.3, excluded_overlaps_with_reserves: true },
    }),
  ]);
  assert.throws(() => validateManifest(m),
    /rationale\.excluded_overlaps_with_reserves: required when classification\.excluded_overlaps_with_reserves is true/);
});

test('REJECTS excluded_overlaps_with_reserves of non-boolean type', () => {
  const m = makeManifest([
    makeFund({
      classification: { access: 0.5, liquidity: 0.7, transparency: 0.3, excluded_overlaps_with_reserves: 'true' },
    }),
  ]);
  assert.throws(() => validateManifest(m), /excluded_overlaps_with_reserves: expected boolean/);
});

test('ACCEPTS aum_usd + aum_year + aum_verified=true together', () => {
  const m = makeManifest([
    makeFund({
      aum_usd: 320_000_000_000,
      aum_year: 2024,
      aum_verified: true,
    }),
  ]);
  const out = validateManifest(m);
  assert.equal(out.funds[0].aumUsd, 320_000_000_000);
  assert.equal(out.funds[0].aumYear, 2024);
  assert.equal(out.funds[0].aumVerified, true);
});

test('REJECTS aum_verified: true without aum_usd', () => {
  const m = makeManifest([
    makeFund({
      aum_verified: true,
      aum_year: 2024,
    }),
  ]);
  assert.throws(() => validateManifest(m),
    /aum_verified=true requires both aum_usd and aum_year to be present/);
});

test('REJECTS aum_verified: true without aum_year', () => {
  const m = makeManifest([
    makeFund({
      aum_verified: true,
      aum_usd: 100_000_000_000,
    }),
  ]);
  assert.throws(() => validateManifest(m),
    /aum_verified=true requires both aum_usd and aum_year to be present/);
});

test('ACCEPTS aum_verified: false (entry loaded for documentation only)', () => {
  // No aum_usd / aum_year required when verified=false — the entry
  // documents an unverifiable fund that the seeder will skip from
  // scoring. This is the EIA / data-integrity-rule path.
  const m = makeManifest([
    makeFund({
      aum_verified: false,
    }),
  ]);
  const out = validateManifest(m);
  assert.equal(out.funds[0].aumVerified, false);
  assert.equal(out.funds[0].aumUsd, undefined);
});

test('REJECTS aum_year out of [2000, 2100]', () => {
  // `null` excluded — treated as field-absent, intentional.
  for (const bad of [1999, 2101, 0, -1, 'x']) {
    const m = makeManifest([
      makeFund({
        aum_usd: 100_000_000_000,
        aum_year: bad,
        aum_verified: true,
      }),
    ]);
    assert.throws(() => validateManifest(m), /aum_year/);
  }
});

test('REJECTS aum_usd of non-positive or non-finite type', () => {
  // `null` excluded — treated as field-absent, intentional.
  for (const bad of [0, -1, NaN, Infinity, 'big']) {
    const m = makeManifest([
      makeFund({
        aum_usd: bad,
        aum_year: 2024,
        aum_verified: true,
      }),
    ]);
    assert.throws(() => validateManifest(m), /aum_usd/);
  }
});

test('Backward-compat: existing entries without new fields still validate', () => {
  // The 8 existing entries on origin/main don't carry aum_usd /
  // aum_pct / excluded flags. Ensure the schema extension is purely
  // additive — existing fields produce a clean parse.
  const m = makeManifest([makeFund()]);
  const out = validateManifest(m);
  assert.equal(out.funds[0].aumUsd, undefined);
  assert.equal(out.funds[0].aumVerified, undefined);
  assert.equal(out.funds[0].classification.aumPctOfAudited, undefined);
  assert.equal(out.funds[0].classification.excludedOverlapsWithReserves, undefined);
});

// ── Seeder-side pure helpers ──────────────────────────────────────

test('shouldSkipFundForBuffer: returns null for a normal fund', () => {
  const fund = { classification: { access: 0.5 }, aumVerified: true };
  assert.equal(shouldSkipFundForBuffer(fund), null);
});

test('shouldSkipFundForBuffer: skips when excluded_overlaps_with_reserves=true', () => {
  const fund = {
    classification: { access: 0.5, excludedOverlapsWithReserves: true },
    aumVerified: true,
  };
  assert.equal(shouldSkipFundForBuffer(fund), 'excluded_overlaps_with_reserves');
});

test('shouldSkipFundForBuffer: skips when aum_verified=false', () => {
  const fund = {
    classification: { access: 0.5 },
    aumVerified: false,
  };
  assert.equal(shouldSkipFundForBuffer(fund), 'aum_unverified');
});

test('shouldSkipFundForBuffer: excluded takes precedence over unverified (single skip reason)', () => {
  // If a fund is BOTH excluded (overlaps reserves) AND unverified,
  // we surface the excluded reason because that's the more
  // architectural concern (double-counting risk).
  const fund = {
    classification: { excludedOverlapsWithReserves: true },
    aumVerified: false,
  };
  assert.equal(shouldSkipFundForBuffer(fund), 'excluded_overlaps_with_reserves');
});

test('shouldSkipFundForBuffer: returns null when neither flag is set', () => {
  // Backward-compat: existing entries on origin/main don't carry
  // aumVerified or excludedOverlapsWithReserves. They must NOT skip.
  assert.equal(shouldSkipFundForBuffer({ classification: { access: 0.5 } }), null);
});

test('shouldSkipFundForBuffer: handles malformed / null input defensively', () => {
  assert.equal(shouldSkipFundForBuffer(null), null);
  assert.equal(shouldSkipFundForBuffer(undefined), null);
  assert.equal(shouldSkipFundForBuffer({}), null);
});

test('applyAumPctOfAudited: returns AUM unchanged when no multiplier set', () => {
  const fund = { classification: { access: 0.5 } };
  assert.equal(applyAumPctOfAudited(1_000_000_000_000, fund), 1_000_000_000_000);
});

test('applyAumPctOfAudited: applies the fraction (KIA-GRF case)', () => {
  // KIA combined audited AUM = $1.072T; GRF is ~5%
  const fund = { classification: { access: 0.9, aumPctOfAudited: 0.05 } };
  const out = applyAumPctOfAudited(1_072_000_000_000, fund);
  assert.equal(out, 53_600_000_000);
});

test('applyAumPctOfAudited: KIA-GRF + KIA-FGF sum equals combined AUM', () => {
  // The split must be conservative — sum of fractional parts equals
  // the original audited AUM. Pinned because a future edit that
  // changes 5/95 split to e.g. 5/90 would silently drop $50B.
  const audited = 1_072_000_000_000;
  const grf = applyAumPctOfAudited(audited, { classification: { aumPctOfAudited: 0.05 } });
  const fgf = applyAumPctOfAudited(audited, { classification: { aumPctOfAudited: 0.95 } });
  assert.equal(grf + fgf, audited);
});

test('applyAumPctOfAudited: ignores out-of-range multipliers (defensive)', () => {
  // The loader rejects out-of-range values at parse time; this is a
  // belt-and-suspenders runtime check that doesn't multiply by an
  // invalid fraction even if the loader's gate is somehow bypassed.
  for (const bad of [0, -0.1, 1.5, NaN, 'big']) {
    const fund = { classification: { aumPctOfAudited: bad } };
    assert.equal(applyAumPctOfAudited(1_000, fund), 1_000);
  }
});

// ── buildCoverageSummary regression: completeness denominator ──────
//
// User's PR-3391 review caught a P1: completeness used `funds.length`
// (manifest count) as the denominator, which depresses the ratio for
// countries whose manifest contains documentation-only entries
// (excluded_overlaps_with_reserves OR aum_verified=false). The shipped
// manifest has this state for UAE (EIA unverified) and CN (SAFE-IC
// excluded). These tests pin the corrected denominator: only scorable
// funds count toward expected.

test('buildCoverageSummary: country with all scorable funds matched is "complete" even if manifest also has unverified entries', () => {
  // UAE-shape: 4 scorable (ADIA, Mubadala, ICD, ADQ) + 1 unverified (EIA).
  // If all 4 scorable matched, country is COMPLETE, not partial.
  const manifest = {
    funds: [
      { country: 'AE', fund: 'adia',    classification: { access: 0.4 } },
      { country: 'AE', fund: 'mubadala',classification: { access: 0.5 } },
      { country: 'AE', fund: 'icd',     classification: { access: 0.5 } },
      { country: 'AE', fund: 'adq',     classification: { access: 0.5 } },
      { country: 'AE', fund: 'eia',     classification: { access: 0.4 }, aumVerified: false },
    ],
  };
  const imports = { AE: { importsUsd: 481.9e9 } };
  const countries = {
    AE: {
      // expectedFunds is computed PER-COUNTRY in fetchSovereignWealth using
      // shouldSkipFundForBuffer, so this test fixture mirrors the seeder's
      // post-fix output (expectedFunds = 4 scorable, completeness = 1.0).
      matchedFunds: 4,
      expectedFunds: 4,
      completeness: 1.0,
    },
  };
  const summary = buildCoverageSummary(manifest, imports, countries);
  // Only 4 scorable funds in AE; 1 unverified entry doesn't count.
  assert.equal(summary.expectedFunds, 4,
    `headline expected funds should exclude documentation-only entries; got ${summary.expectedFunds}`);
  const aeStatus = summary.countryStatuses.find((s) => s.country === 'AE');
  assert.equal(aeStatus.status, 'complete');
});

test('buildCoverageSummary: excludes excluded_overlaps_with_reserves entries from expectedFundsTotal', () => {
  // CN-shape: CIC + NSSF scorable + SAFE-IC excluded.
  const manifest = {
    funds: [
      { country: 'CN', fund: 'cic',  classification: { access: 0.4 } },
      { country: 'CN', fund: 'nssf', classification: { access: 0.20 } },
      { country: 'CN', fund: 'safe-ic', classification: { access: 0.5, excludedOverlapsWithReserves: true } },
    ],
  };
  const imports = { CN: { importsUsd: 3.0e12 } };
  const countries = {
    CN: { matchedFunds: 2, expectedFunds: 2, completeness: 1.0 },
  };
  const summary = buildCoverageSummary(manifest, imports, countries);
  assert.equal(summary.expectedFunds, 2,
    `SAFE-IC should NOT count toward expected funds; got ${summary.expectedFunds}`);
  const cnStatus = summary.countryStatuses.find((s) => s.country === 'CN');
  assert.equal(cnStatus.status, 'complete');
});

test('buildCoverageSummary: missing-country path uses scorable count, not raw manifest count', () => {
  // Country with mixed scorable + excluded entries that fails to seed
  // entirely (e.g. WB imports missing). The "expected" figure on the
  // missing-country status row should reflect SCORABLE funds, not all
  // manifest entries — otherwise an operator dashboard shows
  // "0/3 funds" when the truth is "0/2 funds, 1 documentation-only".
  const manifest = {
    funds: [
      { country: 'CN', fund: 'cic',  classification: { access: 0.4 } },
      { country: 'CN', fund: 'nssf', classification: { access: 0.20 } },
      { country: 'CN', fund: 'safe-ic', classification: { access: 0.5, excludedOverlapsWithReserves: true } },
    ],
  };
  const imports = {}; // CN imports missing → country not seeded
  const countries = {}; // no country payload at all
  const summary = buildCoverageSummary(manifest, imports, countries);
  const cnStatus = summary.countryStatuses.find((s) => s.country === 'CN');
  assert.equal(cnStatus.status, 'missing');
  assert.equal(cnStatus.expected, 2,
    `missing-country expected should be SCORABLE count (2), not all-manifest (3); got ${cnStatus.expected}`);
});

test('buildCoverageSummary: country with ONLY documentation-only entries is excluded from expectedCountries', () => {
  // Edge case: hypothetical country where every manifest entry is
  // documentation-only (e.g. only EIA-style unverified). Such a
  // country has 0 scorable funds → should not appear in
  // expectedCountries because there's nothing scorable to expect.
  const manifest = {
    funds: [
      { country: 'XX', fund: 'placeholder', classification: { access: 0.4 }, aumVerified: false },
    ],
  };
  const summary = buildCoverageSummary(manifest, {}, {});
  assert.equal(summary.expectedCountries, 0,
    `XX has zero scorable funds — should not be in expectedCountries`);
  assert.equal(summary.expectedFunds, 0);
});
