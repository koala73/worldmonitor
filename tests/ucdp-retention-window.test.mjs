import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readRepoFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('UCDP retained window equals the window the CII term assumes (P9)', () => {
  it('the CII UCDP window is the writers\' 365-day trailing window', async () => {
    const { CII_UCDP_WINDOW_DAYS } = await import('../server/worldmonitor/intelligence/v1/_risk-config.ts');
    const standaloneSeed = readRepoFile('scripts/seed-ucdp-events.mjs');
    const relay = readRepoFile('scripts/ais-relay.cjs');

    assert.equal(CII_UCDP_WINDOW_DAYS, 365, 'the CII UCDP window changed; change the writers\' TRAILING_WINDOW_MS with it');
    assert.match(
      standaloneSeed,
      /const TRAILING_WINDOW_MS = 365 \* 24 \* 60 \* 60 \* 1000;/,
      'standalone UCDP seed retention must equal CII_UCDP_WINDOW_DAYS',
    );
    assert.match(
      relay,
      /const UCDP_TRAILING_WINDOW_MS = 365 \* 24 \* 60 \* 60 \* 1000;/,
      'relay UCDP retention must equal CII_UCDP_WINDOW_DAYS',
    );
  });

  it('both writers fetch the window (annual by date, every candidate month) and publish its aggregates', () => {
    const standaloneSeed = readRepoFile('scripts/seed-ucdp-events.mjs');
    const relay = readRepoFile('scripts/ais-relay.cjs');
    for (const [name, src, prefix] of [['seed-ucdp-events.mjs', standaloneSeed, ''], ['ais-relay.cjs', relay, 'ucdp']]) {
      assert.doesNotMatch(src, /MAX_PAGES = 6;/, `${name} must not fetch "the newest six" annual pages: they are not in date order`);
      assert.match(src, new RegExp(`${prefix ? 'ucdpFetchAnnualWindow' : 'fetchAnnualWindow'}\\(`), `${name} must fetch the annual release by date`);
      assert.match(src, new RegExp(`${prefix ? 'ucdpFetchCandidateWindow' : 'fetchCandidateWindow'}\\(`), `${name} must fetch every candidate month`);
      assert.match(src, /countryDays: summary\.countryDays/, `${name} must publish the per-country day aggregates the CII reads`);
      assert.match(src, /windowGapMonths/, `${name} must publish the window's gap months into seed-meta`);
      assert.match(src, /country: ucdpLocatedCountry\(e\)/, `${name} must aggregate by where each event happened (Gaza and the West Bank are not Israel)`);
    }
    assert.match(standaloneSeed, /const MAX_EVENTS = 2000;/, 'the capped events slice for the map and the RPC changed; update the docs deliberately');
    assert.match(relay, /const UCDP_MAX_EVENTS = 2000;/, 'the capped events slice for the map and the RPC changed; update the docs deliberately');
  });

  it('documents the relay reader page cap separately from Redis writer retention', () => {
    const relay = readRepoFile('scripts/ais-relay.cjs');
    const methodology = readRepoFile('docs/methodology/cii-risk-scores.mdx');

    assert.match(
      relay,
      /const UCDP_RELAY_MAX_PAGES = 12;/,
      'public relay UCDP reader page cap changed; update docs deliberately',
    );
    assert.match(methodology, /every monthly GED Candidate release/);
    assert.match(methodology, /StartDate/);
    assert.match(methodology, /2,000 mapped events/);
    assert.match(methodology, /365-day/);
  });
});
