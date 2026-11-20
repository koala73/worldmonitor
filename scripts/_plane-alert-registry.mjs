// @ts-check
//
// Reader for the vendored plane-alert-db aircraft watchlist
// (scripts/data/plane-alert-watchlist.json). NOT an entry point; the file is
// produced by build-plane-alert-watchlist.mjs, which is also the refresh and
// drift-check path (#6228).
//
// The watchlist is a static join over the ICAO 24-bit hex the military flight
// seeder already carries: a hex that matches resolves to a named operator and
// an upstream category with no callsign heuristic and no network call. It is
// loaded lazily on first lookup so importing the seeder for tests or for the
// classification helpers does not pay for a megabyte of JSON.

import { readFileSync } from 'node:fs';

const WATCHLIST_PATH = new URL('./data/plane-alert-watchlist.json', import.meta.url);
const HEX_RE = /^[0-9A-F]{6}$/;
const REQUIRED_COLUMNS = ['hex', 'registration', 'operator', 'type', 'icaoType', 'group', 'category'];
// A refresh that drops the list far below its vendored size is a broken
// conversion, not a smaller upstream.
const MIN_AIRCRAFT = 5000;

/**
 * @typedef {{ hex: string, registration: string, operator: string, type: string,
 *   icaoType: string, group: string, category: string }} PlaneAlertAircraft
 */

/**
 * Structural check for the committed watchlist. Returns the problems found so
 * a test or a refresh can name them; an empty array means the file is usable.
 * @param {unknown} data
 * @returns {string[]}
 */
export function validatePlaneAlertWatchlist(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['watchlist is not an object'];
  const obj = /** @type {Record<string, any>} */ (data);
  if (obj.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${obj.schemaVersion}`);
  for (const field of ['source', 'sourceUrl', 'sourceFileUrl', 'license', 'licenseUrl', 'attribution']) {
    if (typeof obj[field] !== 'string' || obj[field].length === 0) errors.push(`${field} must be a non-empty string`);
  }
  if (typeof obj.retrievedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.retrievedAt)) errors.push('retrievedAt must be an ISO date');
  if (typeof obj.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.sourceSha256)) errors.push('sourceSha256 must be a sha256 hex digest');
  if (!Array.isArray(obj.includedGroups) || obj.includedGroups.length === 0) errors.push('includedGroups must be a non-empty array');
  if (JSON.stringify(obj.columns) !== JSON.stringify(REQUIRED_COLUMNS)) errors.push(`columns must be ${REQUIRED_COLUMNS.join(',')}`);
  if (!Array.isArray(obj.aircraft)) {
    errors.push('aircraft must be an array');
    return errors;
  }
  if (obj.rows !== obj.aircraft.length) errors.push(`rows (${obj.rows}) does not match aircraft length (${obj.aircraft.length})`);
  if (obj.aircraft.length < MIN_AIRCRAFT) errors.push(`expected at least ${MIN_AIRCRAFT} aircraft, got ${obj.aircraft.length}`);
  const groups = new Set(Array.isArray(obj.includedGroups) ? obj.includedGroups : []);
  let previous = '';
  for (const [i, row] of obj.aircraft.entries()) {
    if (!Array.isArray(row) || row.length !== REQUIRED_COLUMNS.length || row.some((cell) => typeof cell !== 'string')) {
      errors.push(`aircraft[${i}] must be ${REQUIRED_COLUMNS.length} strings`);
      if (errors.length > 20) break;
      continue;
    }
    const [hex, , operator, , , group, category] = row;
    if (!HEX_RE.test(hex)) errors.push(`aircraft[${i}] hex "${hex}" is not six uppercase hex characters`);
    if (hex <= previous) errors.push(`aircraft[${i}] hex "${hex}" is out of order or duplicated`);
    if (!groups.has(group)) errors.push(`aircraft[${i}] group "${group}" is outside includedGroups`);
    if (!operator && !category) errors.push(`aircraft[${i}] has neither operator nor category`);
    previous = hex;
    if (errors.length > 20) break;
  }
  return errors;
}

/** @type {Map<string, PlaneAlertAircraft> | null} */
let index = null;
/** @type {Record<string, any> | null} */
let loaded = null;

function load() {
  if (index) return index;
  const data = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8'));
  const errors = validatePlaneAlertWatchlist(data);
  if (errors.length) throw new Error(`plane-alert-watchlist.json is invalid: ${errors.slice(0, 3).join('; ')}`);
  index = new Map();
  for (const [hex, registration, operator, type, icaoType, group, category] of data.aircraft) {
    index.set(hex, { hex, registration, operator, type, icaoType, group, category });
  }
  loaded = data;
  return index;
}

/** Metadata block of the committed watchlist (source, license, retrievedAt, counts). */
export function getPlaneAlertWatchlistMeta() {
  load();
  const { aircraft, ...meta } = /** @type {Record<string, any>} */ (loaded);
  return meta;
}

/**
 * Resolve an ICAO 24-bit hex to its watchlist entry, or null when the aircraft
 * is not listed. Case-insensitive; surrounding whitespace is ignored.
 * @param {string | null | undefined} hexCode
 * @returns {PlaneAlertAircraft | null}
 */
export function lookupPlaneAlertAircraft(hexCode) {
  if (typeof hexCode !== 'string') return null;
  const hex = hexCode.trim().toUpperCase();
  if (!HEX_RE.test(hex)) return null;
  return load().get(hex) ?? null;
}

/** Test seam: drop the cached index so a fixture can be reloaded. */
export function _resetPlaneAlertWatchlistForTests() {
  index = null;
  loaded = null;
}
