// The country a fire detection lies in, from its coordinates. A FIRMS area
// query is a rectangle that reaches into neighbouring countries, so the query's
// name is not the detection's country.

import { ciiCountryAt } from '../shared/cii-country-borders.mjs';

// One label per country the border file covers (CII_BORDER_COUNTRIES).
const FIRE_REGION_BY_CODE = Object.freeze({
  AE: 'United Arab Emirates', AF: 'Afghanistan', BR: 'Brazil', CN: 'China', CU: 'Cuba',
  DE: 'Germany', EG: 'Egypt', FR: 'France', GB: 'United Kingdom', IL: 'Israel/Gaza',
  IN: 'India', IQ: 'Iraq', IR: 'Iran', JP: 'Japan', KP: 'North Korea', KR: 'South Korea',
  LB: 'Lebanon', MM: 'Myanmar', MX: 'Mexico', PK: 'Pakistan', PL: 'Poland', QA: 'Qatar',
  RU: 'Russia', SA: 'Saudi Arabia', SY: 'Syria', TR: 'Turkey', TW: 'Taiwan', UA: 'Ukraine',
  US: 'United States', VE: 'Venezuela', YE: 'Yemen',
});
const CODE_BY_FIRE_REGION = new Map(Object.entries(FIRE_REGION_BY_CODE).map(([code, name]) => [name, code]));

/** Label for detections outside every country the border file covers, or at sea beyond 12 nautical miles. */
export const OTHER_FIRE_REGION = 'Other';

export function fireRegionAt(latitude, longitude) {
  const code = ciiCountryAt(latitude, longitude);
  return code ? FIRE_REGION_BY_CODE[code] : OTHER_FIRE_REGION;
}

/** ISO2 code of a label fireRegionAt returns, or null for any other region label. */
export function fireRegionCountryCode(region) {
  return CODE_BY_FIRE_REGION.get(region) ?? null;
}

export { FIRE_REGION_BY_CODE };
