/**
 * Unit tests for the Route Explorer picker utilities (pure functions only).
 * The DOM-bound CountryPicker / Hs2Picker classes are exercised by E2E in
 * Sprint 6; here we just verify the typeahead filtering and HS2 cargo
 * inference that the modal relies on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  filterCountries,
  getAllCountries,
  filterHs2,
  getAllHs2,
  inferCargoFromHs2,
} from '../src/components/RouteExplorer/RouteExplorer.utils.ts';

describe('getAllCountries', () => {
  it('matches the authoritative port-cluster country registry exactly', () => {
    const list = getAllCountries();
    const clusters = JSON.parse(readFileSync(new URL('../scripts/shared/country-port-clusters.json', import.meta.url), 'utf8'));
    const expectedIso2 = Object.keys(clusters).filter((key) => /^[A-Z]{2}$/.test(key)).sort();
    assert.deepEqual(list.map((country) => country.iso2).sort(), expectedIso2);
    assert.equal(new Set(list.map((country) => country.iso2)).size, list.length, 'country ISO2 identities must be unique');
  });

  it('every entry has iso2 + name + flag + searchKey', () => {
    const list = getAllCountries();
    for (const c of list) {
      assert.match(c.iso2, /^[A-Z]{2}$/);
      assert.ok(c.name.length > 0);
      assert.ok(c.flag.length > 0);
      assert.ok(c.searchKey.length > 0);
    }
  });

  it('is sorted alphabetically by display name', () => {
    const list = getAllCountries();
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i - 1]!.name.localeCompare(list[i]!.name) <= 0,
        `out of order at ${i}: ${list[i - 1]!.name} > ${list[i]!.name}`,
      );
    }
  });
});

describe('filterCountries', () => {
  it('returns full list for empty query', () => {
    assert.equal(filterCountries('').length, getAllCountries().length);
  });

  it('matches by partial display name', () => {
    const out = filterCountries('germ');
    assert.ok(out.some((c) => c.iso2 === 'DE'));
  });

  it('matches by ISO2 code', () => {
    const out = filterCountries('cn');
    assert.ok(out.some((c) => c.iso2 === 'CN'));
  });

  it('case-insensitive', () => {
    const lower = filterCountries('china');
    const upper = filterCountries('CHINA');
    assert.equal(lower.length, upper.length);
  });

  it('returns empty array for nonsense query', () => {
    const out = filterCountries('zzzzzzzzzzzzzz');
    assert.equal(out.length, 0);
  });
});

describe('getAllHs2 + filterHs2', () => {
  it('returns ~50 HS2 entries', () => {
    const list = getAllHs2();
    assert.ok(list.length >= 40 && list.length <= 60);
  });

  it('matches by label substring', () => {
    const out = filterHs2('elect');
    assert.ok(out.some((e) => e.hs2 === '85'));
  });

  it('matches by HS code prefix', () => {
    const out = filterHs2('27');
    assert.ok(out.some((e) => e.hs2 === '27'));
  });

  it('returns empty for nonsense query', () => {
    assert.equal(filterHs2('zzzzzzzzz').length, 0);
  });
});

describe('inferCargoFromHs2', () => {
  it('infers tanker for HS 27', () => {
    assert.equal(inferCargoFromHs2('27'), 'tanker');
  });

  it('infers bulk for cereals (10), oilseeds (12), ores (26)', () => {
    assert.equal(inferCargoFromHs2('10'), 'bulk');
    assert.equal(inferCargoFromHs2('12'), 'bulk');
    assert.equal(inferCargoFromHs2('26'), 'bulk');
  });

  it('infers roro for vehicles (87), ships (89)', () => {
    assert.equal(inferCargoFromHs2('87'), 'roro');
    assert.equal(inferCargoFromHs2('89'), 'roro');
  });

  it('defaults to container for HS 85, 84, 90, 61, 62', () => {
    assert.equal(inferCargoFromHs2('85'), 'container');
    assert.equal(inferCargoFromHs2('84'), 'container');
    assert.equal(inferCargoFromHs2('90'), 'container');
    assert.equal(inferCargoFromHs2('61'), 'container');
    assert.equal(inferCargoFromHs2('62'), 'container');
  });

  it('defaults to container for null / unknown', () => {
    assert.equal(inferCargoFromHs2(null), 'container');
    assert.equal(inferCargoFromHs2('999'), 'container');
  });
});
