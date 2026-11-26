'use strict';

const { countryNameToIso2, COUNTRY_NAME_TO_ISO2 } = require('./country-name-to-iso2.cjs');
const UNKNOWN_PARTY = '[unknown]';
const COUNTRY_CODES = new Set(Object.values(COUNTRY_NAME_TO_ISO2));

function withoutHistoricalName(name) {
  return String(name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Shared with active-wars: candidate XXX<n> actors have not been identified.
function actorName(side) {
  const name = withoutHistoricalName(side);
  return /^XXX\d+$/.test(name) ? '' : name;
}

function statePartyIso2(side) {
  const match = /^Government of (.+)$/.exec(actorName(side));
  const code = match ? countryNameToIso2(match[1]) : null;
  return COUNTRY_CODES.has(code) ? code : null;
}

/** @typedef {{country: string, sideA: string, sideB: string, month: string, deaths: number, events: number}} UcdpPartyMonth */

/** Reject a malformed table as a whole; never silently trim away a party. @returns {UcdpPartyMonth[] | null} */
function parsePartyMonths(value) {
  if (!Array.isArray(value)) return null;
  const rows = [];
  for (const row of value) {
    if (!row || ['country', 'sideA', 'sideB'].some((key) => typeof row[key] !== 'string' || !row[key].trim())
      || typeof row.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)
      || typeof row.deaths !== 'number' || !Number.isFinite(row.deaths) || row.deaths < 0
      || !Number.isSafeInteger(row.events) || row.events < 1) return null;
    rows.push({ country: row.country, sideA: row.sideA, sideB: row.sideB, month: row.month, deaths: row.deaths, events: row.events });
  }
  return rows;
}

module.exports = { UNKNOWN_PARTY, actorName, withoutHistoricalName, statePartyIso2, parsePartyMonths };
