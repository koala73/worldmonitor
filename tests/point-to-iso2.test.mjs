import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hazardCountryCodes, pointToIso2, textToIso2 } from '../scripts/lib/point-to-iso2.mjs';

// natural.hazard subscriptions scope on countryCodes strictly, so a wrong code
// is a missed delivery for one subscriber and a stray one for another. The
// agencies name the country in their own text (USGS and NRCan `place`, GDACS
// and EONET titles); bounding boxes overlap (Canada's box covers Seattle), so
// they are only the fallback for a point the text does not place.

describe('pointToIso2 (bounding boxes, smallest first)', () => {
  it('picks the smallest box that contains the point', () => {
    assert.equal(pointToIso2(-29.5, 28.2), 'LS', 'Lesotho sits inside South Africa\'s box');
    assert.equal(pointToIso2(49.6, 6.1), 'LU');
    assert.equal(pointToIso2(8.5, -80), 'PA');
  });

  it('handles the box that crosses the antimeridian', () => {
    assert.equal(pointToIso2(51.98, 157.27), 'RU');
    assert.equal(pointToIso2(65, -175), 'RU');
  });

  it('returns null in open ocean and for invalid coordinates', () => {
    assert.equal(pointToIso2(0.17, -19.86), null);
    assert.equal(pointToIso2(Number.NaN, 10), null);
    assert.equal(pointToIso2(95, 10), null);
  });

  it('is only a fallback: the contiguous US box contains Windsor, Ontario', () => {
    assert.equal(pointToIso2(42.3, -83.0), 'US');
  });
});

describe('textToIso2 (agency place strings and titles)', () => {
  it('reads the country from the last comma segment of a USGS place', () => {
    assert.equal(textToIso2('76 km NE of Ozernovskiy, Russia'), 'RU');
    assert.equal(textToIso2('48 km WNW of Khuzdar, Pakistan'), 'PK');
    assert.equal(textToIso2('Kermadec Islands, New Zealand'), 'NZ');
    assert.equal(textToIso2('12 km SW of Ensenada, B.C., MX'), 'MX', 'an ISO2 last segment passes through');
  });

  it('maps US states, and USGS\'s CA for California, to US', () => {
    assert.equal(textToIso2('10 km NE of Seattle, Washington'), 'US');
    assert.equal(textToIso2('5 km NW of Ridgecrest, CA'), 'US');
    assert.equal(textToIso2('Wildfire CYRUS, Kern, California'), 'US');
    assert.equal(textToIso2('64 km SW of Adak, Alaska'), 'US');
    assert.equal(textToIso2('Wildfire Bear Trap, Socorro, New Mexico'), 'US', 'the state, not Mexico');
  });

  it('settles Georgia by the point: the US state inside the US box, the country otherwise', () => {
    assert.equal(textToIso2('Wildfire Bay Branch, Ware, Georgia', { lat: 31.2, lon: -82.3 }), 'US');
    assert.equal(textToIso2('10 km N of Tbilisi, Georgia', { lat: 41.8, lon: 44.8 }), 'GE');
    assert.equal(textToIso2('Wildfires in Georgia', { lat: 31.2, lon: -82.3 }), 'US', 'also when the name is found inside a title');
    assert.equal(textToIso2('Earthquake in Georgia', { lat: 42, lon: 44 }), 'GE');
  });

  it('reads Earthquakes Canada province codes as Canada, not as the countries that share them (NL, PE)', () => {
    assert.equal(textToIso2('192 km SW of Port Hardy, BC'), 'CA');
    assert.equal(textToIso2('40 km E of St. John\'s, NL'), 'CA');
    assert.equal(textToIso2('12 km N of Charlottetown, PE'), 'CA');
    assert.equal(textToIso2('30 km W of Iqaluit, NU'), 'CA');
    assert.equal(textToIso2('15 km S of Sudbury, Ontario'), 'CA');
  });

  it('finds a country named anywhere in a title, longest name first', () => {
    assert.equal(textToIso2('Flood in Nigeria'), 'NG');
    assert.equal(textToIso2('Fiji region'), 'FJ');
    assert.equal(textToIso2('south of the Fiji Islands'), 'FJ');
    assert.equal(textToIso2('Hong Kong Tropical Cyclone Warning Signal No. 8'), 'HK');
    assert.equal(textToIso2('Forest fires in Papua New Guinea'), 'PG', 'not Guinea');
  });

  it('returns null when the text names no country', () => {
    assert.equal(textToIso2('central Mid-Atlantic Ridge'), null);
    assert.equal(textToIso2('Super Typhoon Champi'), null);
    assert.equal(textToIso2(''), null);
    assert.equal(textToIso2(undefined), null);
  });
});

describe('hazardCountryCodes', () => {
  it('prefers the agency text over the box, so Windsor is Canada and not the US', () => {
    assert.deepEqual(hazardCountryCodes({ lat: 42.3, lon: -83.0, text: '5 km S of Windsor, Ontario, Canada' }), ['CA']);
    assert.deepEqual(hazardCountryCodes({ lat: 47.6, lon: -122.3, text: '10 km NE of Seattle, Washington' }), ['US']);
  });

  it('falls back to the box when the text names no country', () => {
    assert.deepEqual(hazardCountryCodes({ lat: 8.5, lon: -80, text: 'Tropical Storm Pilar' }), ['PA']);
  });

  it('is empty in open ocean with no named country', () => {
    assert.deepEqual(hazardCountryCodes({ lat: -14.8, lon: -163.2, text: 'Tropical Cyclone 01P' }), []);
    assert.deepEqual(hazardCountryCodes({ lat: 0.17, lon: -19.86, text: 'central Mid-Atlantic Ridge' }), []);
  });

  it('replaces the boxes overseas territories stretch across oceans: France (Guiana) and the United States (Hawaii, Alaska)', () => {
    assert.deepEqual(hazardCountryCodes({ lat: 35.2, lon: -35.9, text: 'northern Mid-Atlantic Ridge' }), [], 'France\'s published box reaches the northern ridge');
    assert.deepEqual(hazardCountryCodes({ lat: 30, lon: -140, text: 'Hurricane Kiko' }), [], 'the published US box covers the north-east Pacific');
    assert.deepEqual(hazardCountryCodes({ lat: 46.5, lon: 2.5, text: 'Storm' }), ['FR'], 'metropolitan France still places');
    assert.deepEqual(hazardCountryCodes({ lat: 61.2, lon: -149.9, text: 'Storm' }), ['US'], 'Alaska still places');
    assert.deepEqual(hazardCountryCodes({ lat: 19.6, lon: -155.5, text: 'Volcano' }), ['US'], 'Hawaii still places');
  });

  it('a longer region name beats the shorter country inside it, wherever it appears', () => {
    assert.equal(textToIso2('Wildfire near Santa Fe in New Mexico'), 'US', 'not Mexico');
    assert.equal(textToIso2('off the coast of New Jersey'), 'US', 'not Jersey');
    assert.equal(textToIso2('Flood in Papua New Guinea'), 'PG');
    assert.equal(textToIso2('Bushfire near Dubbo in New South Wales'), 'AU', 'an Australian state names Australia');
    assert.equal(textToIso2('Flood in Mexico'), 'MX', 'the country alone still resolves');
    assert.equal(textToIso2('Flood in Guinea'), 'GN');
    assert.equal(textToIso2('Flood in Equatorial Guinea'), 'GQ');
    assert.equal(textToIso2('Flood in Guinea-Bissau'), 'GW');
  });

  it('reads a US state named anywhere in the text, not only after the last comma', () => {
    assert.deepEqual(hazardCountryCodes({ lat: 43.6, lon: -127.4, text: 'off the coast of Oregon' }), ['US'], 'not Canada, whose box contains the point');
  });
});
