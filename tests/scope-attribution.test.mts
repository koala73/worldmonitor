/**
 * Dashboard focus (#10453): which country an item is about. Headlines go
 * through the shared country-mention matcher; airports through the monitored
 * airport table.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MONITORED_AIRPORTS } from '../src/config/airports.ts';
import { COUNTRY_COORDS } from '../scripts/lib/radar-country-coords.mjs';
import {
  airportCountry,
  countryCodeFromName,
  headlineCountries,
  MAX_ATTRIBUTION_CHARS,
  withoutOwnSourceSuffix,
} from '../src/services/scope-attribution.ts';

const FOCUS = ['TH', 'VN', 'ID', 'KH', 'LA', 'MM', 'MY', 'CN'];

describe('headlineCountries', () => {
  it('reads only the first MAX_ATTRIBUTION_CHARS of a hostile, unbounded title', () => {
    const filler = 'border talks '.repeat(Math.ceil(MAX_ATTRIBUTION_CHARS / 13) + 1);
    assert.deepEqual(headlineCountries(`Thailand ${filler}`, FOCUS), ['TH']);
    assert.deepEqual(headlineCountries(`${filler}Thailand`, FOCUS), []);
    const started = performance.now();
    headlineCountries('ไทย '.repeat(250_000), FOCUS, 'th');
    assert.ok(performance.now() - started < 100, 'attribution cost must not grow with title length');
  });

  it('returns the focused countries a headline names, in focus order', () => {
    assert.deepEqual(headlineCountries('Thailand imposes a curfew', FOCUS), ['TH']);
    assert.deepEqual(headlineCountries('Cambodia accuses Thailand of shelling', FOCUS), ['TH', 'KH']);
    assert.deepEqual(headlineCountries('Indonesian VP resigns over election ruling', FOCUS), ['ID']);
  });

  it('returns another country it names when it names none of the focus', () => {
    assert.deepEqual(headlineCountries('France votes on the budget', FOCUS), ['FR']);
  });

  it('returns nothing for a headline with no country', () => {
    assert.deepEqual(headlineCountries('Global markets rally on rate cut hopes', FOCUS), []);
    assert.deepEqual(headlineCountries('   ', FOCUS), []);
  });

  it('keeps the matcher exclusions: South Sudan is not Sudan', () => {
    assert.deepEqual(headlineCountries('South Sudan peace talks resume', ['SD']), ['SS']);
  });

  it('matches a focused country by its name in the headline language', () => {
    assert.deepEqual(headlineCountries('La Thaïlande impose un couvre-feu', FOCUS, 'fr'), ['TH']);
  });
});

describe('withoutOwnSourceSuffix', () => {
  it('strips a source whose own name contains a separator, as a whole', () => {
    assert.equal(withoutOwnSourceSuffix('Rates unchanged - Thailand - News', 'Thailand - News'), 'Rates unchanged');
    assert.equal(withoutOwnSourceSuffix('Rates unchanged | Thailand | News', 'Thailand | News'), 'Rates unchanged');
    // Only the item's own source: another outlet's suffix stays.
    assert.equal(withoutOwnSourceSuffix('Rates unchanged - Thailand - News', 'News'), 'Rates unchanged - Thailand');
    assert.equal(withoutOwnSourceSuffix('Rates unchanged - Thailand - News', 'Bangkok Post'), 'Rates unchanged - Thailand - News');
    assert.equal(withoutOwnSourceSuffix('Rates unchangedThailand - News', 'Thailand - News'), 'Rates unchangedThailand - News');
  });

  it('stays linear on a long whitespace run (feed titles are third-party input)', () => {
    const started = performance.now();
    assert.equal(withoutOwnSourceSuffix(' '.repeat(200_000), 'Vietnam News'), ' '.repeat(200_000));
    assert.equal(withoutOwnSourceSuffix(`x${' '.repeat(200_000)}- Vietnam News`, 'Vietnam News'), 'x');
    assert.ok(performance.now() - started < 250, 'suffix stripping must not backtrack quadratically');
  });

  it('removes a trailing outlet name only when it is the item source', () => {
    assert.equal(withoutOwnSourceSuffix('Fed holds rates - Vietnam News', 'Vietnam News'), 'Fed holds rates');
    assert.equal(withoutOwnSourceSuffix('Fed holds rates | Thai PBS World', 'thai pbs world'), 'Fed holds rates');
    assert.equal(withoutOwnSourceSuffix('Talks resume - Vietnam', 'Reuters'), 'Talks resume - Vietnam');
    assert.equal(withoutOwnSourceSuffix('Fed holds rates', undefined), 'Fed holds rates');
  });

  it('so an outlet named after a country does not attribute its stories', () => {
    const title = withoutOwnSourceSuffix('Fed holds rates - Vietnam News', 'Vietnam News');
    assert.deepEqual(headlineCountries(title, FOCUS), []);
  });
});

describe('airportCountry', () => {
  it('resolves monitored airports, including feed spellings like UK and USA', () => {
    assert.equal(airportCountry('BKK'), 'TH');
    assert.equal(airportCountry('kul'), 'MY');
    assert.equal(airportCountry('LHR'), 'GB');
    assert.equal(airportCountry('JFK'), 'US');
    assert.equal(airportCountry('DXB'), 'AE');
    assert.equal(airportCountry('VTE'), null);
  });

  it('resolves every monitored airport to a country', () => {
    const unresolved = MONITORED_AIRPORTS.filter((a) => !airportCountry(a.iata)).map((a) => `${a.iata} (${a.country})`);
    assert.deepEqual(unresolved, []);
  });
});

describe('countryCodeFromName', () => {
  it('resolves every country name in the 2026-11-12 live Cloudflare outage snapshot', () => {
    for (const [name, code] of Object.entries({
      Ukraine: 'UA', 'Dominican Republic': 'DO', Peru: 'PE', Guyana: 'GY',
      Bangladesh: 'BD', Syria: 'SY', 'Sri Lanka': 'LK',
    })) assert.equal(countryCodeFromName(name), code, name);
  });

  it('resolves the English name of every country the outage seeder can emit', () => {
    // seed-internet-outages writes Radar's location name as `country`, but
    // only for codes in COUNTRY_COORDS; the focus attributes by that name.
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const misses = Object.keys(COUNTRY_COORDS)
      .filter((code) => countryCodeFromName(names.of(code)) !== code)
      .map((code) => `${code} ${names.of(code)}`);
    assert.deepEqual(misses, []);
  });

  it('resolves UCDP spellings', () => {
    assert.equal(countryCodeFromName('Myanmar (Burma)'), 'MM');
    assert.equal(countryCodeFromName('DR Congo (Zaire)'), 'CD');
    assert.equal(countryCodeFromName(''), null);
  });
});
