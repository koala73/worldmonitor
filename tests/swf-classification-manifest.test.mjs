import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  groupFundsByCountry,
  loadSwfManifest,
  validateManifest,
} from '../scripts/shared/swf-manifest-loader.mjs';

// Validate the shipped SWF classification manifest (PR 2 §3.4). This
// test is the only CI gate on the YAML: any schema violation (missing
// rationale, out-of-range score, duplicate fund identifier, missing
// source citation) fails the build before a malformed manifest can
// reach the seeder. Adding a new fund or adjusting a score must run
// this test locally.
//
// The manifest is reviewer-approved metadata, not auto-generated, so
// the test intentionally prefers loud assertion failures over silent
// coercion. Downstream consumers (seeder, future scorer, methodology
// lint) can rely on the returned object shape without re-validating.

describe('SWF classification manifest — shipped YAML', () => {
  const manifest = loadSwfManifest();

  it('parses with a recognized schema version', () => {
    assert.equal(manifest.manifestVersion, 1, 'bump both YAML manifest_version AND this assertion when evolving the schema');
  });

  it('records an external-review status (PENDING until sign-off)', () => {
    assert.ok(
      manifest.externalReviewStatus === 'PENDING' || manifest.externalReviewStatus === 'REVIEWED',
      `external_review_status must be PENDING or REVIEWED, got ${manifest.externalReviewStatus}`,
    );
  });

  it('lists the first-release set of funds from plan §3.4', () => {
    const expected = new Set([
      'NO:gpfg',
      'AE:adia',
      'AE:mubadala',
      'SA:pif',
      'KW:kia',
      'QA:qia',
      'SG:gic',
      'SG:temasek',
    ]);
    const actual = new Set(manifest.funds.map((f) => `${f.country}:${f.fund}`));
    for (const required of expected) {
      assert.ok(actual.has(required), `plan §3.4 required fund missing from manifest: ${required}`);
    }
  });

  it('classification components are all in [0, 1]', () => {
    for (const fund of manifest.funds) {
      const { access, liquidity, transparency } = fund.classification;
      assert.ok(access >= 0 && access <= 1, `${fund.country}:${fund.fund} access out of range: ${access}`);
      assert.ok(liquidity >= 0 && liquidity <= 1, `${fund.country}:${fund.fund} liquidity out of range: ${liquidity}`);
      assert.ok(transparency >= 0 && transparency <= 1, `${fund.country}:${fund.fund} transparency out of range: ${transparency}`);
    }
  });

  it('every fund carries non-empty rationale strings and source citations', () => {
    for (const fund of manifest.funds) {
      assert.ok(fund.rationale.access.length > 20, `${fund.country}:${fund.fund} rationale.access too short`);
      assert.ok(fund.rationale.liquidity.length > 20, `${fund.country}:${fund.fund} rationale.liquidity too short`);
      assert.ok(fund.rationale.transparency.length > 20, `${fund.country}:${fund.fund} rationale.transparency too short`);
      assert.ok(fund.sources.length > 0, `${fund.country}:${fund.fund} has no sources cited`);
    }
  });

  it('groupFundsByCountry handles multi-fund countries (AE, SG)', () => {
    const byCountry = groupFundsByCountry(manifest);
    assert.ok((byCountry.get('AE') ?? []).length >= 2, 'AE should have ADIA + Mubadala at minimum');
    assert.ok((byCountry.get('SG') ?? []).length >= 2, 'SG should have GIC + Temasek at minimum');
    assert.ok((byCountry.get('NO') ?? []).length >= 1, 'NO should have GPFG');
  });
});

describe('validateManifest — schema enforcement', () => {
  const minimalValid = () => ({
    manifest_version: 1,
    last_reviewed: '2026-04-23',
    external_review_status: 'PENDING',
    funds: [
      {
        country: 'NO',
        fund: 'gpfg',
        display_name: 'Government Pension Fund Global',
        classification: { access: 0.6, liquidity: 1.0, transparency: 1.0 },
        rationale: {
          access: 'Norwegian fiscal rule caps annual withdrawal at expected real return.',
          liquidity: '100% publicly listed equities + fixed income per NBIM 2025 report.',
          transparency: 'Full audited AUM, daily returns disclosed. IFSWF full compliance.',
        },
        sources: ['https://www.nbim.no/en/the-fund/'],
      },
    ],
  });

  it('accepts a minimal-valid manifest', () => {
    const out = validateManifest(minimalValid());
    assert.equal(out.funds.length, 1);
    assert.equal(out.funds[0].country, 'NO');
  });

  it('rejects out-of-range classification scores', () => {
    const bad = minimalValid();
    bad.funds[0].classification.access = 1.5;
    assert.throws(() => validateManifest(bad), /access.*expected number in \[0, 1\]/);
  });

  it('rejects non-ISO2 country codes', () => {
    const bad = minimalValid();
    bad.funds[0].country = 'NOR';
    assert.throws(() => validateManifest(bad), /expected ISO-3166-1 alpha-2/);
  });

  it('rejects missing rationale strings', () => {
    const bad = minimalValid();
    bad.funds[0].rationale.access = '';
    assert.throws(() => validateManifest(bad), /rationale.access.*expected non-empty string/);
  });

  it('rejects empty sources list', () => {
    const bad = minimalValid();
    bad.funds[0].sources = [];
    assert.throws(() => validateManifest(bad), /sources.*expected non-empty array/);
  });

  it('rejects duplicate country:fund identifiers', () => {
    const bad = minimalValid();
    bad.funds.push({ ...bad.funds[0] });
    assert.throws(() => validateManifest(bad), /duplicate fund identifier NO:gpfg/);
  });

  it('rejects wrong schema version (forces explicit bump)', () => {
    const bad = minimalValid();
    bad.manifest_version = 2;
    assert.throws(() => validateManifest(bad), /manifest_version: expected 1/);
  });

  it('rejects invalid external_review_status', () => {
    const bad = minimalValid();
    bad.external_review_status = 'APPROVED';
    assert.throws(() => validateManifest(bad), /external_review_status.*expected 'PENDING' or 'REVIEWED'/);
  });
});
