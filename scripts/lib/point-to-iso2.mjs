/**
 * ISO 3166-1 alpha-2 codes for a natural hazard, for the strict country scope
 * of natural.hazard webhook subscriptions (scripts/shipping-webhook-worker.mjs).
 *
 * The agencies name the place in their own text (USGS and NRCan `place`,
 * GDACS and EONET titles), so the text decides first. Bounding boxes
 * (scripts/shared/country-bboxes.json) overlap at every border (Canada's box
 * covers Seattle), so they only place a point the text does not name: the
 * smallest box containing it wins, the ordering seed-climate-disasters.mjs
 * uses, with tighter boxes for the two countries whose published box spans
 * open ocean (BOX_OVERRIDES). Railway runs the worker with rootDirectory=scripts, so everything here
 * reads the scripts/shared copies.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('../shared/country-name-to-iso2.cjs');

const COUNTRY_BBOXES = JSON.parse(readFileSync(new URL('../shared/country-bboxes.json', import.meta.url), 'utf8'));
const COUNTRY_NAMES = JSON.parse(readFileSync(new URL('../shared/country-names.json', import.meta.url), 'utf8'));

const KNOWN_CODES = new Set(Object.values(COUNTRY_NAMES));

function longitudeSpan([, west, , east]) {
  return west > east ? 360 - west + east : east - west;
}

// The published boxes for France (French Guiana) and the United States
// (Alaska to Hawaii) span open ocean: France's reaches the northern
// Mid-Atlantic Ridge and the US box most of the north-east Pacific. Their
// territories are placed with tighter boxes instead [south, west, north, east].
const BOX_OVERRIDES = Object.freeze({
  FR: [[41.3, -5.2, 51.1, 9.6]], // metropolitan France and Corsica
  US: [
    [24.4, -124.8, 49.4, -66.9], // contiguous states
    [54.4, -168.2, 71.4, -129.9], // Alaska, east of the Bering Strait (Chukotka is Russia)
    [51.2, -179.9, 55.4, -164], // Aleutians
    [18.9, -160.3, 22.3, -154.8], // Hawaii
  ],
});

const BBOXES_SMALLEST_FIRST = Object.entries(COUNTRY_BBOXES)
  .flatMap(([code, bbox]) => (BOX_OVERRIDES[code] ? BOX_OVERRIDES[code].map((box) => [code, box]) : [[code, bbox]]))
  .filter(([, bbox]) => Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite))
  .sort(([, a], [, b]) => (a[2] - a[0]) * longitudeSpan(a) - (b[2] - b[0]) * longitudeSpan(b));

function inBox(lat, lon, [south, west, north, east]) {
  if (lat < south || lat > north) return false;
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

function validPoint(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** The smallest country bounding box containing the point, or null. */
export function pointToIso2(lat, lon) {
  if (!validPoint(lat, lon)) return null;
  for (const [code, bbox] of BBOXES_SMALLEST_FIRST) {
    if (inBox(lat, lon, bbox)) return code;
  }
  return null;
}

// Same normalization as country-name-to-iso2.cjs, so scans hit its key space.
function normalize(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''‘’`.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
  'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming',
]);
const US_BBOX = COUNTRY_BBOXES.US;

// Longest first, so "papua new guinea" wins over "guinea".
const NAMES_LONGEST_FIRST = Object.keys(COUNTRY_NAMES)
  .filter((name) => name.length >= 3)
  .sort((a, b) => b.length - a.length);

// Earthquakes Canada ends a place with a province or territory code
// ("192 km SW of Port Hardy, BC"); NL and PE are also country codes.
const CANADA_PROVINCE_CODES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);
const CANADA_PROVINCES = new Set([
  'alberta', 'british columbia', 'manitoba', 'new brunswick', 'newfoundland and labrador', 'newfoundland',
  'labrador', 'nova scotia', 'northwest territories', 'nunavut', 'ontario', 'prince edward island',
  'quebec', 'saskatchewan', 'yukon',
]);

// GDACS and EONET name Australian fires and floods by state ("New South
// Wales" would otherwise match nothing, or Wales if it were listed).
const AUSTRALIA_STATES = ['new south wales', 'queensland', 'south australia', 'western australia', 'tasmania', 'northern territory', 'australian capital territory'];

// Countries, US states, Canadian provinces and Australian states in one longest-first pass, so
// "new mexico" wins over "mexico" and "papua new guinea" over "guinea".
// Georgia stays a country name and is settled by the point.
const PLACES_LONGEST_FIRST = [
  ...NAMES_LONGEST_FIRST.map((name) => [name, COUNTRY_NAMES[name]]),
  ...[...US_STATES].map((name) => [name, 'US']),
  ...[...CANADA_PROVINCES].map((name) => [name, 'CA']),
  ...AUSTRALIA_STATES.map((name) => [name, 'AU']),
].sort((a, b) => b[0].length - a[0].length);

/** "Georgia" is the one name both the country list and the US states carry: inside the US box it is the state. */
function georgia(lat, lon) {
  return validPoint(lat, lon) && US_BBOX && inBox(lat, lon, US_BBOX) ? 'US' : 'GE';
}

function scanForCountry(normalized, lat, lon) {
  const padded = ` ${normalized} `;
  for (const [name, code] of PLACES_LONGEST_FIRST) {
    if (padded.includes(` ${name} `)) return name === 'georgia' ? georgia(lat, lon) : code;
  }
  return null;
}

/**
 * The country an agency's text names, or null. The last comma segment is the
 * country, a US state or a Canadian province in USGS, NRCan and EONET IRWIN
 * places; USGS writes California as `CA`, which would otherwise read as
 * Canada, and NRCan writes provinces as codes, two of which (NL, PE) are also
 * country codes. Otherwise any country, US state or Canadian province named
 * in the text, longest name first. Georgia is settled by the point.
 */
export function textToIso2(text, { lat = Number.NaN, lon = Number.NaN } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const segments = text.split(',').map((segment) => segment.trim()).filter(Boolean);
  const last = segments.length > 1 ? segments[segments.length - 1] : '';
  if (last) {
    if (last === 'CA') return 'US';
    if (CANADA_PROVINCE_CODES.has(last)) return 'CA';
    const token = normalize(last).replace(/ region$/, '');
    if (token === 'georgia') return georgia(lat, lon);
    if (US_STATES.has(token)) return 'US';
    if (CANADA_PROVINCES.has(token)) return 'CA';
    const code = countryNameToIso2(last.replace(/\s+region$/i, ''));
    if (code && KNOWN_CODES.has(code)) return code;
  }
  return scanForCountry(normalize(text), lat, lon);
}

/**
 * 0 or 1 ISO2 codes for a hazard: the text's country, else the smallest box
 * containing the point, else none (open ocean, a mid-ocean ridge).
 */
export function hazardCountryCodes({ lat, lon, text }) {
  const code = textToIso2(text, { lat, lon }) ?? pointToIso2(lat, lon);
  return code ? [code] : [];
}
