// CII location rule for Palestinian territory (owner ruling, 2026-10-23): an
// event scores the place where it happens, so Gaza and West Bank events count
// for Palestine (PS), not Israel (IL). PS has no Tier-1 row, so they score no
// Tier-1 country. Every path that used to fold PS into IL is pinned here: the
// border polygons, ISO2-coded strike events, the strike tally, and the
// country keywords that place headlines and uncoded strikes.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { CII_STRIKE_SEVERITY_WEIGHTS } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import {
  type CiiCountryTerms,
  computeCIIScores,
  confirmedStrikeDaysFromSeed,
  geoToCountry,
  normalizeCountryName,
  strikeEventCountry,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { ciiCountryForIso2 } from '../scripts/shared/cii-country-borders.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 3_600_000;
const today = new Date(NOW).toISOString().slice(0, 10);

const PALESTINIAN_PLACES: Array<[string, number, number]> = [
  ['Gaza City', 31.5017, 34.4668],
  ['Beit Lahia', 31.5464, 34.4951],
  ['Deir al-Balah', 31.418, 34.351],
  ['Khan Younis', 31.3462, 34.3063],
  ['Rafah', 31.2969, 34.2455],
  ['Jenin', 32.461, 35.3],
  ['Tulkarm', 32.3104, 35.0286],
  ['Nablus', 32.2211, 35.2544],
  ['Ramallah', 31.9038, 35.2034],
  ['Jericho', 31.856, 35.459],
  ['Bethlehem', 31.7054, 35.2024],
  ['Hebron', 31.5326, 35.0998],
];

const ISRAELI_PLACES: Array<[string, number, number]> = [
  ['Tel Aviv', 32.0853, 34.7818],
  ['Haifa', 32.794, 34.9896],
  ['Ashkelon', 31.6688, 34.5743],
  ['Sderot', 31.525, 34.5965],
  ['Beersheba', 31.2518, 34.7913],
];

function aux(extra: Record<string, unknown> = {}) {
  return {
    ucdpEvents: [], outages: [], climate: [], fires: {}, gpsHexes: [], iranEvents: [],
    orefData: null, advisories: null, displacedByIso3: {}, crossBorderSurgeCountries: [],
    newsTopStories: [], threatSummaryByCountry: null, aviationAlerts: [], earthquakes: [],
    sanctionsCountries: [], sanctionsCountryCounts: null, temporalAnomalies: [], militaryCii: null,
    gdeltCountryEvents: null, confirmedStrikes: null,
    ...extra,
  } as any;
}

function ilTerms(a: any): CiiCountryTerms {
  const sink: Record<string, CiiCountryTerms> = {};
  computeCIIScores([], a, { nowMs: NOW }, sink);
  return sink.IL!;
}

const BASELINE_IL = ilTerms(aux());

function strike(fields: Record<string, unknown>) {
  return { id: `s-${Math.random()}`, severity: 'critical', timestamp: NOW - HOUR, ...fields };
}

describe('Palestinian territory scores PS, not IL', () => {
  it('a point in Gaza or the West Bank is in no Tier-1 country', () => {
    const wrong = PALESTINIAN_PLACES
      .map(([name, lat, lon]) => [name, geoToCountry(lat, lon)] as const)
      .filter(([, code]) => code !== null);
    assert.deepEqual(wrong, []);
  });

  it('a point in Israel is still Israel', () => {
    for (const [name, lat, lon] of ISRAELI_PLACES) assert.equal(geoToCountry(lat, lon), 'IL', name);
  });

  it('the sea off Gaza belongs to no Tier-1 country; the sea off Ashkelon is still Israel', () => {
    assert.equal(geoToCountry(31.52, 34.4), null, '4 km off Gaza City');
    assert.equal(geoToCountry(31.68, 34.52), 'IL', '4 km off Ashkelon');
  });

  it('an ISO2 PS code maps to no Tier-1 row', () => {
    assert.equal(ciiCountryForIso2('PS'), null);
    assert.equal(ciiCountryForIso2('ps'), null);
    assert.equal(ciiCountryForIso2('IL'), 'IL');
  });

  it('a strike in Gaza raises no IL term, however the event places it', () => {
    const variants = {
      'coded PS': strike({ countryCode: 'PS', latitude: 31.5017, longitude: 34.4668, title: 'Airstrike on Gaza City' }),
      'uncoded, Gaza coordinates, title names the attacker': strike({ latitude: 31.5017, longitude: 34.4668, title: 'Israeli airstrike hits Gaza City' }),
      'uncoded, West Bank coordinates': strike({ latitude: 32.461, longitude: 35.3, title: 'IDF raid in Jenin' }),
      'uncoded, no coordinates, title names only Gaza': strike({ title: 'Strike in Gaza City' }),
    };
    for (const [label, event] of Object.entries(variants)) {
      assert.equal(strikeEventCountry(event), null, label);
      assert.deepEqual(ilTerms(aux({ iranEvents: [event] })), BASELINE_IL, label);
    }
  });

  it('a strike in Israel does raise IL', () => {
    for (const event of [
      strike({ countryCode: 'IL', latitude: 32.0853, longitude: 34.7818, title: 'Missile strike on Tel Aviv' }),
      strike({ latitude: 31.6688, longitude: 34.5743, title: 'Rocket hits Ashkelon' }),
    ]) {
      assert.equal(strikeEventCountry(event), 'IL');
      const terms = ilTerms(aux({ iranEvents: [event] }));
      // The terms, not the final score: v14's advisory floor holds IL at 50 here.
      assert.ok(terms.strikePressure > 0, 'IL strike pressure');
      assert.ok(terms.blended > BASELINE_IL.blended, `${terms.blended} > ${BASELINE_IL.blended}`);
    }
  });

  it('the strike feed files no West Bank report under Israel, whatever name it uses', () => {
    const require = createRequire(import.meta.url);
    const gazetteer = require('../scripts/lib/middle-east-strikes-gazetteer.cjs');
    const strikes = require('../scripts/lib/middle-east-strikes.cjs');
    // GeoNames files the West Bank under Israel as "Judea and Samaria Area".
    assert.deepEqual(gazetteer.gazetteerPlaces().filter((p: any) => /judea|samaria/i.test(p.name)), []);
    for (const place of ['Judea and Samaria Area', 'Judea and Samaria', 'Jenin', 'Gaza City']) {
      assert.equal(gazetteer.resolvePlace({ place, iso2: 'IL' }), null, place);
      assert.equal(telegramCandidate(place)?.iso2, undefined, place);
    }
    assert.equal(gazetteer.resolvePlace({ place: 'Tel Aviv', iso2: 'IL' })?.iso2, 'IL');
    assert.equal(telegramCandidate('Tel Aviv')?.iso2, 'IL');

    function telegramCandidate(place: string) {
      const post = { id: `t:${place}`, channel: 't', url: 'https://t.me/t/1', ts: new Date(NOW - 600_000).toISOString(), text: `Strike reported in ${place}` };
      return strikes.buildTelegramCandidate(post, { isStrike: true, kind: 'strike', place, countryIso2: 'IL', severity: 'critical' }, NOW);
    }
  });

  it("the strike tally's PS days score no Tier-1 country; its IL days score Israel", () => {
    const days = confirmedStrikeDaysFromSeed({
      version: 1,
      updatedAt: NOW,
      days: { [today]: { PS: [3, 2, 0, 0], IL: [0, 1, 0, 0] } },
    }, NOW)!;
    assert.equal(days.PS, undefined);
    assert.deepEqual(days.IL, { [today]: CII_STRIKE_SEVERITY_WEIGHTS.high });
    const psOnly = confirmedStrikeDaysFromSeed({ version: 1, updatedAt: NOW, days: { [today]: { PS: [3, 2, 0, 0] } } }, NOW)!;
    assert.deepEqual(psOnly, {});
    assert.deepEqual(ilTerms(aux({ confirmedStrikes: psOnly })), BASELINE_IL);
  });

  it('an earthquake under the West Bank raises no IL term', () => {
    const quake = { magnitude: 6.8, occurredAt: NOW - HOUR, location: { latitude: 31.856, longitude: 35.459 }, place: '5 km N of Jericho, West Bank' };
    assert.deepEqual(ilTerms(aux({ earthquakes: [quake] })), BASELINE_IL);
  });

  it('no Palestinian place name is an Israel keyword', () => {
    for (const text of ['Gaza', 'Gaza City', 'Gaza Strip', 'West Bank', 'Rafah', 'Khan Younis', 'Khan Yunis', 'Jenin', 'Nablus', 'Ramallah', 'Hebron', 'Tulkarm', 'Bethlehem', 'Jabalia']) {
      assert.equal(normalizeCountryName(`Airstrike kills 20 in ${text}`), null, text);
    }
    assert.equal(normalizeCountryName('Rocket hits Tel Aviv'), 'IL');
  });

  it('a Gaza news headline adds nothing to IL', () => {
    for (const story of [
      { countryCode: 'PS', countryCodes: ['PS'], threatLevel: 'critical', primaryTitle: 'Airstrike kills 20 in Gaza' },
      { countryCode: null, countryCodes: [], threatLevel: 'critical', primaryTitle: 'Airstrike kills 20 in Gaza' },
      { countryCode: null, countryCodes: [], threatLevel: 'critical', primaryTitle: 'Gunfire in the West Bank' },
    ]) {
      assert.deepEqual(ilTerms(aux({ newsTopStories: [story] })), BASELINE_IL, story.primaryTitle);
    }
    const israel = ilTerms(aux({ newsTopStories: [{ countryCode: null, countryCodes: [], threatLevel: 'critical', primaryTitle: 'Rocket hits Tel Aviv' }] }));
    assert.ok(israel.parts.newsScore > 0, 'a headline about Israel still scores IL');
  });
});
