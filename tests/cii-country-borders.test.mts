// CII places geo events (fires, GPS jamming, earthquakes, climate anomalies,
// strikes, military flights and vessels) in a Tier-1 country by real borders,
// not bounding boxes. Bounding boxes overlap across most of the world's
// borders: before v11 they put Jizan in Yemen, Bahrain and Al Udeid in Saudi
// Arabia, Kuwait City in Iraq, Nogales (Arizona) in Mexico and Wagah's Indian
// side in Pakistan, and dropped Honolulu and Anchorage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { geoToCountry } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import { geoToCountry as seedGeoToCountry } from '../scripts/seed-military-cii.mjs';
import {
  CII_BORDER_COUNTRIES,
  CII_COASTAL_WATERS_KM,
  ciiCountryAt,
} from '../scripts/shared/cii-country-borders.mjs';
import { generateCiiCountryBorders } from '../scripts/generate-cii-country-borders.mjs';

const require = createRequire(import.meta.url);
const gazetteer = require('../scripts/lib/middle-east-strikes-gazetteer.cjs');

type Case = [name: string, lat: number, lon: number, expected: string | null];

const BORDER_CASES: Case[] = [
  // Gulf
  ['Jizan, Saudi Red Sea coast', 16.89, 42.55, 'SA'],
  ['Samtah, Saudi side of the Yemen border', 16.6, 42.94, 'SA'],
  ['Najran, Saudi side of the Yemen border', 17.5656, 44.2289, 'SA'],
  ['Sanaa', 15.3694, 44.191, 'YE'],
  ['Manama, Bahrain (not Tier-1)', 26.2235, 50.5876, null],
  ['Al Udeid air base, Qatar', 25.117, 51.315, 'QA'],
  ['Kuwait City (not Tier-1)', 29.3759, 47.9774, null],
  ['Amman, Jordan (not Tier-1)', 31.9539, 35.9106, null],
  ['Muscat, Oman (not Tier-1)', 23.588, 58.3829, null],
  ['Dammam', 26.4207, 50.0888, 'SA'],
  ['Abu Dhabi', 24.4539, 54.3773, 'AE'],
  // North America
  ['Nogales, Arizona', 31.35, -110.94, 'US'],
  ['Nogales, Sonora', 31.3, -110.94, 'MX'],
  ['Calexico, California', 32.68, -115.5, 'US'],
  ['Mexicali, Baja California', 32.62, -115.45, 'MX'],
  ['Chula Vista, California', 32.64, -117.08, 'US'],
  ['Tijuana', 32.5149, -117.0382, 'MX'],
  ['Laredo, Texas', 27.53, -99.48, 'US'],
  ['Nuevo Laredo', 27.4763, -99.5164, 'MX'],
  ['Honolulu', 21.3, -157.85, 'US'],
  ['Anchorage', 61.2, -149.9, 'US'],
  // South Asia
  ['Ferozepur, Indian Punjab', 30.92, 74.61, 'IN'],
  ['Kasur, Pakistani Punjab', 31.12, 74.45, 'PK'],
  ['Jammu', 32.73, 74.86, 'IN'],
  ['Sialkot', 32.49, 74.53, 'PK'],
  ['Srinagar', 34.08, 74.8, 'IN'],
  ['Muzaffarabad', 34.37, 73.47, 'PK'],
  ['Torkham, Afghan side', 34.13, 71.08, 'AF'],
  ['Landi Kotal, Pakistani side', 34.1, 71.15, 'PK'],
  // Levant
  ['Kiryat Shmona', 33.21, 35.57, 'IL'],
  ['Marjayoun', 33.36, 35.59, 'LB'],
  ['Nahariya', 33.0, 35.1, 'IL'],
  ['Tyre', 33.27, 35.2, 'LB'],
  ['Bint Jbeil', 33.12, 35.43, 'LB'],
  ['Damascus', 33.5138, 36.2765, 'SY'],
  ['Beirut', 33.8938, 35.5018, 'LB'],
  ['Kilis, Turkey', 36.72, 37.12, 'TR'],
  ['Azaz, Syria', 36.59, 37.04, 'SY'],
  ['Zakho, Iraq', 37.14, 42.68, 'IQ'],
  ['Cizre, Turkey', 37.33, 42.19, 'TR'],
  ['Herat', 34.35, 62.2, 'AF'],
  ['Mashhad', 36.3, 59.6, 'IR'],
  // Europe
  ['Strasbourg', 48.58, 7.75, 'FR'],
  ['Kehl', 48.57, 7.82, 'DE'],
  ['Dover', 51.13, 1.31, 'GB'],
  ['Calais', 50.95, 1.86, 'FR'],
  ['Lublin', 51.25, 22.57, 'PL'],
  ['Lviv', 49.8397, 24.0297, 'UA'],
  ['Kharkiv', 49.9935, 36.2304, 'UA'],
  ['Belgorod', 50.5954, 36.5873, 'RU'],
  ['Sevastopol, Crimea counts as Ukraine', 44.6, 33.52, 'UA'],
  // East Asia
  ['Dandong', 40.12, 124.39, 'CN'],
  ['Sinuiju', 40.1, 124.4, 'KP'],
  ['Kaesong', 37.9382, 126.5878, 'KP'],
  ['Seoul', 37.5665, 126.978, 'KR'],
  ['Busan', 35.1, 129.04, 'KR'],
  ['Tsushima', 34.4, 129.3, 'JP'],
  ['Kinmen', 24.44, 118.38, 'TW'],
  ['Xiamen', 24.48, 118.09, 'CN'],
  ['Vladivostok', 43.1155, 131.8855, 'RU'],
  ['Heihe', 50.2458, 127.4886, 'CN'],
  ['Yuzhno-Sakhalinsk', 46.9591, 142.738, 'RU'],
  ['Wakkanai', 45.415, 141.673, 'JP'],
  ['Ruili', 24.0128, 97.8519, 'CN'],
  ['Muse, Myanmar', 23.98, 97.9, 'MM'],
  // South America and Caribbean
  ['Pacaraima, Brazil', 4.48, -61.15, 'BR'],
  ['Santa Elena de Uairen, Venezuela', 4.6, -61.11, 'VE'],
  ['Havana', 23.1136, -82.3666, 'CU'],
  ['Key West', 24.55, -81.8, 'US'],
  // Russia's mainland crosses the antimeridian: a naive ray cast flips whole
  // latitude bands (Karelia read as nothing, Finnish Lapland as Russia).
  ['Louhi, Russian Karelia', 66.08, 33.03, 'RU'],
  ['Kalevala, Russian Karelia', 65.2, 31.16, 'RU'],
  ['Kuusamo, Finland (not Tier-1)', 65.96, 29.19, null],
  ['Salla, Finland (not Tier-1)', 66.83, 28.67, null],
  ['Anadyr, Chukotka', 64.73, 177.5, 'RU'],
  ['Uelen, Chukotka east of the antimeridian', 66.16, -169.8, 'RU'],
  ['Norilsk', 69.35, 88.2, 'RU'],
  // Non-Tier-1 land and open sea
  ['Gibraltar', 36.14, -5.35, null],
  ['Basel, Switzerland', 47.56, 7.59, null],
  ['Cayenne, French Guiana (own ISO code GF)', 4.93, -52.33, null],
  ['open Pacific', 0, -150, null],
  ['central Red Sea', 20.0, 38.9, null],
];

describe('geoToCountry places points by real borders, worldwide', () => {
  for (const [name, lat, lon, expected] of BORDER_CASES) {
    it(`${name} -> ${expected}`, () => {
      assert.equal(geoToCountry(lat, lon), expected, `server at (${lat}, ${lon})`);
      assert.equal(seedGeoToCountry(lat, lon), expected, `military seeder at (${lat}, ${lon})`);
    });
  }

  it('places every Tier-1 capital in its own country', () => {
    const CAPITALS: Record<string, [number, number]> = {
      US: [38.9, -77.04], RU: [55.75, 37.62], CN: [39.9, 116.4], UA: [50.45, 30.52], IR: [35.69, 51.39],
      IL: [32.08, 34.78], TW: [25.03, 121.56], KP: [39.02, 125.75], SA: [24.71, 46.68], TR: [39.93, 32.86],
      PL: [52.23, 21.01], DE: [52.52, 13.4], FR: [48.86, 2.35], GB: [51.51, -0.13], IN: [28.61, 77.21],
      PK: [33.68, 73.05], SY: [33.51, 36.28], YE: [15.37, 44.19], MM: [19.76, 96.08], VE: [10.49, -66.88],
      CU: [23.11, -82.37], MX: [19.43, -99.13], BR: [-15.79, -47.88], AE: [24.45, 54.38], KR: [37.57, 126.98],
      IQ: [33.31, 44.36], AF: [34.53, 69.17], LB: [33.89, 35.5], EG: [30.04, 31.24], JP: [35.68, 139.69],
      QA: [25.29, 51.53],
    };
    assert.deepEqual(Object.keys(CAPITALS).sort(), Object.keys(TIER1_COUNTRIES).sort());
    for (const [code, [lat, lon]] of Object.entries(CAPITALS)) assert.equal(geoToCountry(lat, lon), code, code);
  });

  it('treats a point within 12 nautical miles of a Tier-1 coast as that country', () => {
    // Off Jeddah's port and off the Japanese coast near Sendai, both outside the 1:50m land.
    assert.equal(geoToCountry(21.45, 39.08), 'SA');
    assert.equal(geoToCountry(38.25, 141.2), 'JP');
    assert.equal(CII_COASTAL_WATERS_KM, 22.224);
    // Well beyond territorial waters.
    assert.equal(geoToCountry(38.3, 143.5), null);
  });

  it('returns null for non-numeric and out-of-range coordinates', () => {
    for (const [lat, lon] of [[NaN, 35], [35, Infinity], [91, 0], [0, 181]]) {
      assert.equal(geoToCountry(lat, lon), null);
      assert.equal(seedGeoToCountry(lat, lon), null);
    }
  });

  it('places every strike-gazetteer town in its own country (Palestinian places count toward Israel)', () => {
    // Known exceptions, all outside 1:50m land resolution: Quneitra sits on the
    // Golan ceasefire line the map draws on Israel's side; Kharg Island is
    // missing from the 1:50m map; the Strait of Hormuz is open water (strike
    // events carry countryCode for exactly these).
    const KNOWN = new Set(['Quneitra', 'Kharg Island', 'Strait of Hormuz']);
    const wrong: string[] = [];
    for (const place of gazetteer.gazetteerPlaces()) {
      if (KNOWN.has(place.name)) continue;
      const expected = place.iso2 === 'PS' ? 'IL' : place.iso2 in TIER1_COUNTRIES ? place.iso2 : null;
      const got = geoToCountry(place.lat, place.lon);
      if (got !== expected) wrong.push(`${place.name} ${place.iso2} -> ${got}`);
    }
    assert.deepEqual(wrong, []);
  });
});

describe('generated CII border file', () => {
  it('covers exactly the Tier-1 countries', () => {
    assert.deepEqual([...CII_BORDER_COUNTRIES], Object.keys(TIER1_COUNTRIES).sort());
  });

  it('is current with its generator and source map', () => {
    const { stale, bytes } = generateCiiCountryBorders({ check: true });
    assert.equal(stale, false, 'run node scripts/generate-cii-country-borders.mjs');
    assert.ok(bytes < 200_000, `border file grew to ${bytes} bytes; it ships in the Edge bundle`);
  });

  it('the server and the military seeder share one implementation', () => {
    assert.equal(geoToCountry, ciiCountryAt);
    assert.equal(seedGeoToCountry, ciiCountryAt);
  });
});
