// A headline about an attack on Saudi Arabia must count toward Saudi Arabia even
// when it names the attacker first. Both extractors used to attribute exactly one
// country: seed-insights took the first country named ("Iran-backed Houthis ... after
// Riyadh airport attack" → IR only), and the relay threat summary took the country
// after an attack verb, by full name only, so "attacks on Saudi infrastructure" and
// "Saudi Arabia intercepts missile" were attributed to nobody. In October 2026 that
// left Saudi Arabia's CII information score at 0 during the Houthi airport strikes.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { extractCountryCode, extractCountryCodes, extractStoryCountries } from '../scripts/shared/geo-extract.mjs';

const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function relaySlice(fromMarker, toFunction) {
  const start = RELAY_SOURCE.indexOf(fromMarker);
  assert.notEqual(start, -1, `could not find ${fromMarker} in ais-relay.cjs`);
  const fnStart = RELAY_SOURCE.indexOf(`function ${toFunction}(`, start);
  assert.notEqual(fnStart, -1, `could not find ${toFunction} in ais-relay.cjs`);
  const bodyStart = RELAY_SOURCE.indexOf('{', fnStart);
  let depth = 0;
  for (let i = bodyStart; i < RELAY_SOURCE.length; i += 1) {
    if (RELAY_SOURCE[i] === '{') depth += 1;
    if (RELAY_SOURCE[i] === '}') depth -= 1;
    if (depth === 0) return RELAY_SOURCE.slice(start, i + 1);
  }
  throw new Error(`unterminated ${toFunction} in ais-relay.cjs`);
}

const relay = Function(
  'require',
  `${relaySlice('const THREAT_COUNTRY_NAME_TO_ISO2 = {', 'threatSummaryCountries')}
  return { matchCountryNamesInText, threatSummaryCountries };`,
)(createRequire(new URL('../scripts/ais-relay.cjs', import.meta.url)));

const SAUDI_HEADLINES = [
  ['Iran-backed Houthis warn of long conflict after Riyadh airport attack', ['IR', 'YE', 'SA']],
  ["Yemen's Houthis hit palace in Aden, coalition details attacks on Saudi infrastructure", ['YE', 'SA']],
  ['Saudi Arabia intercepts missile near Red Sea oil hub', ['SA']],
  ['Houthis strike Saudi Arabia airport in Dammam', ['YE', 'SA']],
  ['Missile debris falls near Jeddah as Saudi air defences engage', ['SA']],
];

describe('extractCountryCodes (seed-insights top stories)', () => {
  for (const [title, expected] of SAUDI_HEADLINES) {
    it(`attributes every country named: ${title}`, () => {
      const codes = extractCountryCodes(title);
      for (const code of expected) assert.ok(codes.includes(code), `${code} missing from ${JSON.stringify(codes)}`);
    });
  }

  it('always includes the primary countryCode', () => {
    for (const [title] of SAUDI_HEADLINES) {
      assert.ok(extractCountryCodes(title).includes(extractCountryCode(title)), title);
    }
  });

  it('attributes city and region names worldwide', () => {
    assert.deepEqual(extractCountryCodes('Drone strike hits Kharkiv power plant overnight'), ['UA']);
    assert.deepEqual(extractCountryCodes('Shelling reported in Aleppo countryside'), ['SY']);
    assert.deepEqual(extractCountryCodes('RSF fighters enter El Fasher as civilians flee'), ['SD']);
    assert.deepEqual(extractCountryCodes('Car bomb in Mosul kills five'), ['IQ']);
  });

  it('does not read ordinary words, people or brands as places', () => {
    assert.deepEqual(extractCountryCodes('Brent crude climbs as Meta shares slide'), []);
    assert.deepEqual(extractCountryCodes('Bolton says Austin should resign'), []);
    assert.deepEqual(extractCountryCodes('Lira hits record low after rate decision'), []);
  });

  it('ignores a trailing publisher credit', () => {
    assert.deepEqual(extractCountryCodes('Under siege, Ukraine uses F-16s to shoot down drones - The New York Times'), ['UA']);
    assert.deepEqual(extractCountryCodes('Iran urges talks to reopen Strait of Hormuz | Arab News'), ['IR']);
    assert.deepEqual(
      extractCountryCodes('Manipur violence - protesters place bodies outside the chief minister bungalow after militant attack'),
      ['IN'],
    );
  });

  it('keeps a dash-separated ending that is headline content, not a publisher credit', () => {
    assert.deepEqual(extractCountryCodes('India – Pakistan tensions rise after border clash'), ['IN', 'PK']);
    assert.deepEqual(extractCountryCodes('Peace talks resume — Ukraine and Russia'), ['UA', 'RU']);
    assert.deepEqual(extractCountryCodes('Live updates – Israel strikes Gaza'), ['IL', 'PS']);
    assert.deepEqual(extractCountryCodes('Drone strike hits Kharkiv power plant - The Washington Post'), ['UA']);
    assert.deepEqual(extractCountryCodes('Ceasefire holds in Gaza - Al Jazeera'), ['PS']);
    assert.deepEqual(extractCountryCodes('Floods hit Lahore - Times of India'), ['PK']);
    assert.deepEqual(extractCountryCodes('Public Schedule – October 19, 2026 - U.S. Department of State (.gov)'), []);
  });

  it('strips a credit from a very long title in linear time', () => {
    const title = `x${' '.repeat(60_000)}y`;
    const started = performance.now();
    extractCountryCodes(title);
    relay.threatSummaryCountries(title);
    assert.ok(performance.now() - started < 1000, 'publisher-credit match must not backtrack quadratically');
  });

  it('reads U.S. and splits places joined by dashes, ampersands or curly apostrophes', () => {
    assert.deepEqual(extractCountryCodes('U.S. sanctions target Caracas officials'), ['US', 'VE']);
    assert.deepEqual(extractCountryCodes('Kharkiv\u2019s power grid hit again'), ['UA']);
    assert.deepEqual(extractCountryCodes('Mosul–Aleppo road reopens'), ['IQ', 'SY']);
  });

  it('leaves extractCountryCode on country and alias names only', () => {
    assert.equal(extractCountryCode('Drone strike hits Kharkiv power plant overnight'), null);
  });

  it('does not double-count a country named twice or credit the shorter name inside a longer one', () => {
    assert.deepEqual(extractCountryCodes('South Sudan and Sudan sign deal; South Sudan army withdraws'), ['SS', 'SD']);
    assert.deepEqual(extractCountryCodes('Saudi Arabia: Saudi officials confirm Riyadh closure'), ['SA']);
  });

  it('returns an empty list for supranational-only or country-less titles', () => {
    assert.deepEqual(extractCountryCodes('NATO ministers meet as the EU responds'), []);
    assert.deepEqual(extractCountryCodes('Markets rally as inflation cools'), []);
    assert.deepEqual(extractCountryCodes(''), []);
  });
});

describe('extractStoryCountries (top-story countryCode + countryCodes)', () => {
  it('puts the primary country first in countryCodes', () => {
    assert.deepEqual(extractStoryCountries('Missile hits Dammam airport after Houthi attack'), {
      countryCode: 'YE',
      countryCodes: ['YE', 'SA'],
    });
  });

  it('never takes the primary country from a publisher credit', () => {
    assert.deepEqual(extractStoryCountries('Drone strike hits Kharkiv power plant - The Washington Post'), {
      countryCode: 'UA',
      countryCodes: ['UA'],
    });
  });

  it('does not take the primary country from a word inside a place name', () => {
    assert.deepEqual(extractStoryCountries('New Mexico wildfire spreads'), { countryCode: 'US', countryCodes: ['US'] });
  });

  it('returns null and an empty list for a title naming no country', () => {
    assert.deepEqual(extractStoryCountries('Markets rally as inflation cools'), { countryCode: null, countryCodes: [] });
  });
});

describe('relay threat summary attribution', () => {
  it('keeps the affected-country rule when it fires', () => {
    assert.deepEqual(relay.threatSummaryCountries('US strikes on Yemen condemned by Iran'), ['YE']);
    assert.deepEqual(relay.threatSummaryCountries('Houthi attack on Riyadh airport kills 12'), ['SA']);
  });

  it('recognises Saudi and Houthis after an attack verb', () => {
    assert.deepEqual(relay.matchCountryNamesInText('Coalition details attacks on Saudi infrastructure'), ['SA']);
    assert.deepEqual(relay.matchCountryNamesInText('US strikes on Houthis in Hodeidah'), ['YE']);
  });

  it('credits cities and regions worldwide when no attack verb names a country', () => {
    assert.deepEqual(relay.threatSummaryCountries('Drone strike on Dammam airport'), ['SA']);
    assert.deepEqual(relay.threatSummaryCountries('Overnight attack on Kharkiv leaves city without power'), ['UA']);
    assert.deepEqual(relay.threatSummaryCountries('Brent crude climbs as Meta shares slide'), []);
    assert.deepEqual(relay.threatSummaryCountries('Tehran seeks to punish Trump with oil price pain - The Washington Post'), ['IR']);
  });

  it('keeps headline endings that name a country', () => {
    assert.deepEqual(
      [...relay.threatSummaryCountries('Iran warns Israel — Saudi Arabia calls for restraint')].sort(),
      ['IL', 'IR', 'SA'],
    );
    assert.deepEqual([...relay.threatSummaryCountries('Peace talks resume — Ukraine and Russia')].sort(), ['RU', 'UA']);
  });

  it('reads the US and UK abbreviations but not the pronoun', () => {
    assert.deepEqual([...relay.threatSummaryCountries('US and UK agree to expand sanctions')].sort(), ['GB', 'US']);
    assert.deepEqual(relay.threatSummaryCountries('U.S. envoy lands for talks'), ['US']);
    assert.deepEqual(relay.threatSummaryCountries('Tell us what you think about the budget'), []);
    assert.deepEqual(relay.threatSummaryCountries('Public Schedule – October 19, 2026 - U.S. Department of State (.gov)'), []);
  });

  it('resolves a place phrase before a country name inside it', () => {
    assert.deepEqual(relay.threatSummaryCountries('New Mexico wildfire spreads'), ['US']);
    assert.deepEqual(extractCountryCodes('New Mexico wildfire spreads'), ['US']);
  });

  it('splits places joined by dashes or ampersands', () => {
    assert.deepEqual([...relay.threatSummaryCountries('Mosul–Aleppo road reopens')].sort(), ['IQ', 'SY']);
    assert.deepEqual([...relay.threatSummaryCountries('Kharkiv & Odesa lose power')], ['UA']);
  });

  it('falls back to every country named when no attack verb points at one', () => {
    assert.deepEqual(relay.threatSummaryCountries('Saudi Arabia intercepts missile near Red Sea oil hub'), ['SA']);
    assert.deepEqual(
      [...relay.threatSummaryCountries('Iran-backed Houthis warn of long conflict after Riyadh airport attack')].sort(),
      ['IR', 'SA', 'YE'],
    );
    assert.deepEqual(relay.threatSummaryCountries('South Sudan peace talks resume'), ['SS']);
    assert.deepEqual(relay.threatSummaryCountries('Markets rally as inflation cools'), []);
  });

  it('feeds both classify loops through the summary attribution, not the alert-routing one', () => {
    const accumulations = [...RELAY_SOURCE.matchAll(/for \(const code of (\w+)\(([^)]*)\)\) \{\s*if \(!byCountry\[code\]\)/g)];
    assert.equal(accumulations.length, 2, 'cached-hit and fresh-classification loops');
    for (const [, fn] of accumulations) assert.equal(fn, 'threatSummaryCountries');
  });
});
