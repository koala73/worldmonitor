import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toIso2 } from '../src/utils/country-codes.ts';

describe('toIso2 — happy path', () => {
  it('returns alpha-2 unchanged when canonical', () => {
    assert.equal(toIso2('US'), 'US');
    assert.equal(toIso2('GB'), 'GB');
    assert.equal(toIso2('FR'), 'FR');
  });

  it('uppercases lowercase alpha-2', () => {
    assert.equal(toIso2('us'), 'US');
    assert.equal(toIso2('gb'), 'GB');
    assert.equal(toIso2('fr'), 'FR');
  });

  it('uppercases mixed-case alpha-2', () => {
    assert.equal(toIso2('Us'), 'US');
    assert.equal(toIso2('gB'), 'GB');
  });

  it('converts alpha-3 to alpha-2', () => {
    assert.equal(toIso2('USA'), 'US');
    assert.equal(toIso2('GBR'), 'GB');
    assert.equal(toIso2('FRA'), 'FR');
    assert.equal(toIso2('DEU'), 'DE');
  });

  it('converts lowercase alpha-3 to alpha-2', () => {
    assert.equal(toIso2('usa'), 'US');
    assert.equal(toIso2('gbr'), 'GB');
  });

  it('converts common country names to alpha-2', () => {
    assert.equal(toIso2('United States'), 'US');
    assert.equal(toIso2('United States of America'), 'US');
    assert.equal(toIso2('United Kingdom'), 'GB');
    assert.equal(toIso2('UK'), 'GB');
    assert.equal(toIso2('Britain'), 'GB');
    assert.equal(toIso2('Russia'), 'RU');
    assert.equal(toIso2('South Korea'), 'KR');
    assert.equal(toIso2('North Korea'), 'KP');
    assert.equal(toIso2('Czech Republic'), 'CZ');
    assert.equal(toIso2('Czechia'), 'CZ');
  });

  it('country-name lookup is case-insensitive', () => {
    assert.equal(toIso2('united states'), 'US');
    assert.equal(toIso2('UNITED STATES'), 'US');
    assert.equal(toIso2('united kingdom'), 'GB');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(toIso2('  US  '), 'US');
    assert.equal(toIso2('\tUSA\n'), 'US');
    assert.equal(toIso2('  United States  '), 'US');
  });
});

describe('toIso2 — null/empty input', () => {
  it('returns null for null', () => {
    assert.equal(toIso2(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(toIso2(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(toIso2(''), null);
  });

  it('returns null for whitespace-only string', () => {
    assert.equal(toIso2('   '), null);
    assert.equal(toIso2('\t\n'), null);
  });
});

describe('toIso2 — unrecognized input', () => {
  it('returns null for unrecognized country name', () => {
    assert.equal(toIso2('Atlantis'), null);
    assert.equal(toIso2('Wakanda'), null);
  });

  it('returns null for alpha-3 not in registry', () => {
    // ZZZ is reserved for "unknown country" in ISO; not in our map.
    assert.equal(toIso2('ZZZ'), null);
    // QQQ has never been assigned.
    assert.equal(toIso2('QQQ'), null);
  });

  it('returns null for alpha-2 not in registry', () => {
    // ZZ is not assigned in ISO-3166-1.
    assert.equal(toIso2('ZZ'), null);
    assert.equal(toIso2('QQ'), null);
  });

  it('returns null for arbitrary-length non-alias strings', () => {
    assert.equal(toIso2('U'), null);
    assert.equal(toIso2('USAA'), null);
    assert.equal(toIso2('not a country'), null);
  });
});
