// Drift guard for scripts/seed-military-cii.mjs.
//
// The seed job is self-contained by necessity — scripts/ cannot import from server/ or
// src/ under the Railway nixpacks packaging — so it re-embeds country reference tables
// with the server modules as the implicit source of truth. Nothing at runtime detects
// when the two copies diverge. Tests CAN cross the boundary, so this asserts parity.
//
// Covers the two exact-match tables (TIER1 country set, country bounding boxes). The
// seed's COUNTRY_KEYWORDS and MMSI MID tables are intentionally trimmed subsets and are
// not asserted here — behavioural tests in seed-military-cii.test.mts cover those.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER1_COUNTRIES as SEED_TIER1,
  COUNTRY_BBOX as SEED_BBOX,
  geoToCountry as seedGeoToCountry,
} from '../scripts/seed-military-cii.mjs';
import { TIER1_COUNTRIES as SERVER_TIER1 } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import {
  COUNTRY_BBOX as SERVER_BBOX,
  geoToCountry as serverGeoToCountry,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';

test('seed TIER1_COUNTRIES matches the server source of truth exactly', () => {
  assert.deepEqual(
    SEED_TIER1,
    SERVER_TIER1,
    'scripts/seed-military-cii.mjs TIER1_COUNTRIES has drifted from server/.../_shared.ts — '
      + 'the seed would score a different country set than the CII engine',
  );
});

test('seed COUNTRY_BBOX matches the server source of truth exactly', () => {
  assert.deepEqual(
    SEED_BBOX,
    SERVER_BBOX,
    'scripts/seed-military-cii.mjs COUNTRY_BBOX has drifted from get-risk-scores.ts — '
      + 'the seed would attribute flights/vessels to stale country boundaries',
  );
});

test('seed geoToCountry agrees with server geoToCountry and the intended border heuristic', () => {
  const PROBES: Array<{ name: string; lat: number; lon: number; expected: string | null }> = [
    { name: 'San Diego, US side of US/MX border', lat: 32.7157, lon: -117.1611, expected: 'US' },
    { name: 'Tijuana, MX side of US/MX border', lat: 32.5149, lon: -117.0382, expected: 'MX' },
    { name: 'El Paso, US side of US/MX border', lat: 31.7619, lon: -106.4850, expected: 'US' },
    { name: 'Ciudad Juarez, MX side of US/MX border', lat: 31.6904, lon: -106.4245, expected: 'MX' },
    { name: 'Brownsville, US side of Rio Grande', lat: 25.9017, lon: -97.4975, expected: 'US' },
    { name: 'Nuevo Laredo, MX side of Rio Grande', lat: 27.4763, lon: -99.5164, expected: 'MX' },
    { name: 'Piedras Negras, MX side of Rio Grande', lat: 28.6916, lon: -100.5409, expected: 'MX' },
    { name: 'Ciudad Acuna, MX side of Rio Grande', lat: 29.3232, lon: -100.9522, expected: 'MX' },
    { name: 'Kaesong, KP side of western DMZ', lat: 37.9382, lon: 126.5878, expected: 'KP' },
    { name: 'Haeju, KP side of western DMZ', lat: 38.0400, lon: 125.7140, expected: 'KP' },
    { name: 'Seoul, KR side of DMZ', lat: 37.5665, lon: 126.9780, expected: 'KR' },
    { name: 'Damascus, Syria side of SY/LB overlap', lat: 33.5138, lon: 36.2765, expected: 'SY' },
    { name: 'Beirut, Lebanon side of SY/LB overlap', lat: 33.8938, lon: 35.5018, expected: 'LB' },
    { name: 'Najran, Saudi side of SA/YE overlap', lat: 17.5656, lon: 44.2289, expected: 'SA' },
    { name: 'Sanaa, Yemen side of SA/YE overlap', lat: 15.3694, lon: 44.1910, expected: 'YE' },
    { name: 'southern Lebanon inside IL bbox, LB wins by area fallback', lat: 33.2000, lon: 35.5000, expected: 'LB' },
    { name: 'Abu Dhabi inside SA bbox, AE wins by area fallback', lat: 24.0000, lon: 53.0000, expected: 'AE' },
    { name: 'western Afghanistan inside IR bbox, AF wins by area fallback', lat: 33.0000, lon: 62.0000, expected: 'AF' },
    { name: 'North Korea inside CN bbox, KP wins by area fallback', lat: 40.0000, lon: 126.0000, expected: 'KP' },
    { name: 'Rostov-on-Don, Russia side of RU/UA overlap', lat: 47.2357, lon: 39.7015, expected: 'RU' },
    { name: 'Kursk, Russia side of northern RU/UA overlap', lat: 51.7304, lon: 36.1939, expected: 'RU' },
    { name: 'Belgorod, Russia side of northern RU/UA overlap', lat: 50.5954, lon: 36.5873, expected: 'RU' },
    { name: 'Sumy, Ukraine side of northern RU/UA overlap', lat: 50.9077, lon: 34.7981, expected: 'UA' },
    { name: 'Kharkiv, Ukraine side of RU/UA overlap', lat: 49.9935, lon: 36.2304, expected: 'UA' },
    { name: 'Lahore, Pakistan side of IN/PK overlap', lat: 31.5204, lon: 74.3587, expected: 'PK' },
    { name: 'Amritsar, India side of IN/PK overlap', lat: 31.6340, lon: 74.8723, expected: 'IN' },
    { name: 'Vladivostok, Russia side of CN/RU overlap', lat: 43.1155, lon: 131.8855, expected: 'RU' },
    { name: 'Blagoveshchensk, Russia side of Amur CN/RU overlap', lat: 50.2907, lon: 127.5272, expected: 'RU' },
    { name: 'Heihe, China side of Amur CN/RU overlap', lat: 50.2458, lon: 127.4886, expected: 'CN' },
    { name: 'Mohe, China side of high-latitude CN/RU overlap', lat: 52.9721, lon: 122.5386, expected: 'CN' },
    { name: 'Harbin, China side of CN/RU overlap', lat: 45.8038, lon: 126.5350, expected: 'CN' },
    { name: 'Yuzhno-Sakhalinsk, Russia side of RU/JP overlap', lat: 46.9591, lon: 142.7380, expected: 'RU' },
    { name: 'southern Sakhalin inside JP bbox, Russia side of RU/JP overlap', lat: 45.4500, lon: 142.0500, expected: 'RU' },
    { name: 'Wakkanai, Japan side of RU/JP overlap', lat: 45.4150, lon: 141.6730, expected: 'JP' },
    { name: 'Sapporo, Japan side of RU/JP overlap', lat: 43.0618, lon: 141.3545, expected: 'JP' },
    { name: 'open Pacific', lat: 0.0, lon: -150.0, expected: null },
  ];
  for (const { name, lat, lon, expected } of PROBES) {
    const seedResult = seedGeoToCountry(lat, lon);
    const serverResult = serverGeoToCountry(lat, lon);
    assert.equal(
      seedResult,
      serverResult,
      `${name}: seed/server geoToCountry disagree at (${lat}, ${lon}): seed=${seedResult} server=${serverResult}`,
    );
    assert.equal(
      seedResult,
      expected,
      `${name}: expected heuristic-correct ${expected}, both returned ${seedResult}`,
    );
  }
});
