'use strict';

const COUNTRY_NAME_TO_ISO2 = Object.freeze({
  bahrain: 'BH',
  israel: 'IL',
  kuwait: 'KW',
  oman: 'OM',
  qatar: 'QA',
  'saudi arabia': 'SA',
  uae: 'AE',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  uk: 'GB',
  'united states': 'US',
  usa: 'US',
});

function countryNameToIso2(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  const alias = COUNTRY_NAME_TO_ISO2[trimmed.toLowerCase()];
  if (alias) return alias;
  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

module.exports = {
  COUNTRY_NAME_TO_ISO2,
  countryNameToIso2,
};
