// ICAO nationality marks (Annex 7) -> ISO 3166-1 alpha-2 state of registry.
// A mark is the registration text before the first hyphen. Marks with a
// sub-allocation by the first letter after the hyphen are keyed `MARK-L`.
// Shared or reassigned marks (PJ, T9, SU-Y) are omitted: they name no single state.
const NATIONALITY_MARKS = Object.freeze(Object.assign(Object.create(null), {
  2: 'GG', A2: 'BW', A3: 'TO', A4O: 'OM', A5: 'BT', A6: 'AE', A7: 'QA', A8: 'LR', A9C: 'BH', AP: 'PK',
  C: 'CA', CF: 'CA', C2: 'NR', C3: 'AD', C5: 'GM', C6: 'BS', C9: 'MZ', CC: 'CL', CN: 'MA', CP: 'BO',
  CR: 'PT', CS: 'PT', CU: 'CU', CX: 'UY',
  D: 'DE', D2: 'AO', D4: 'CV', D6: 'KM', DQ: 'FJ',
  E3: 'ER', E5: 'CK', E7: 'BA', EC: 'ES', EI: 'IE', EJ: 'IE', EK: 'AM', EP: 'IR', ER: 'MD', ES: 'EE',
  ET: 'ET', EW: 'BY', EX: 'KG', EY: 'TJ', EZ: 'TM',
  F: 'FR', G: 'GB',
  H4: 'SB', HA: 'HU', HB: 'CH', HC: 'EC', HH: 'HT', HI: 'DO', HK: 'CO', HL: 'KR', HP: 'PA', HR: 'HN',
  HS: 'TH', HZ: 'SA',
  I: 'IT',
  J2: 'DJ', J3: 'GD', J5: 'GW', J6: 'LC', J7: 'DM', J8: 'VC', JA: 'JP', JU: 'MN', JY: 'JO',
  LN: 'NO', LV: 'AR', LX: 'LU', LY: 'LT', LZ: 'BG',
  M: 'IM', N: 'US',
  OB: 'PE', OD: 'LB', OE: 'AT', OH: 'FI', OK: 'CZ', OM: 'SK', OO: 'BE', OY: 'DK',
  P: 'KP', P2: 'PG', P4: 'AW', PH: 'NL', PK: 'ID', PP: 'BR', PR: 'BR', PS: 'BR', PT: 'BR', PU: 'BR',
  PZ: 'SR',
  RA: 'RU', RF: 'RU', RDPL: 'LA', RP: 'PH',
  S2: 'BD', S5: 'SI', S7: 'SC', S9: 'ST', SE: 'SE', SP: 'PL', ST: 'SD', SU: 'EG', SX: 'GR',
  T2: 'TV', T3: 'KI', T7: 'SM', T8A: 'PW', TC: 'TR', TF: 'IS', TG: 'GT', TI: 'CR', TJ: 'CM', TL: 'CF',
  TN: 'CG', TR: 'GA', TS: 'TN', TT: 'TD', TU: 'CI', TY: 'BJ', TZ: 'ML',
  UK: 'UZ', UN: 'KZ', UP: 'KZ', UR: 'UA',
  V2: 'AG', V3: 'BZ', V4: 'KN', V5: 'NA', V6: 'FM', V7: 'MH', V8: 'BN', VH: 'AU', VN: 'VN', VT: 'IN',
  'VP-A': 'AI', 'VP-B': 'BM', 'VQ-B': 'BM', 'VP-C': 'KY', 'VP-F': 'FK', 'VP-L': 'VG', 'VP-M': 'MS',
  'VQ-T': 'TC',
  XA: 'MX', XB: 'MX', XC: 'MX', XT: 'BF', XU: 'KH', XY: 'MM', XZ: 'MM',
  YA: 'AF', YI: 'IQ', YJ: 'VU', YK: 'SY', YL: 'LV', YN: 'NI', YR: 'RO', YS: 'SV', YU: 'RS', YV: 'VE',
  Z: 'ZW', Z3: 'MK', ZA: 'AL', ZK: 'NZ', ZP: 'PY', ZS: 'ZA', ZT: 'ZA', ZU: 'ZA',
  '3A': 'MC', '3B': 'MU', '3C': 'GQ', '3D': 'SZ', '3X': 'GN',
  '4K': 'AZ', '4L': 'GE', '4O': 'ME', '4R': 'LK', '4W': 'TL', '4X': 'IL',
  '5A': 'LY', '5B': 'CY', '5H': 'TZ', '5N': 'NG', '5R': 'MG', '5T': 'MR', '5U': 'NE', '5V': 'TG',
  '5W': 'WS', '5X': 'UG', '5Y': 'KE',
  '6O': 'SO', '6V': 'SN', '6Y': 'JM',
  '7O': 'YE', '7P': 'LS', '7Q': 'MW', '7T': 'DZ',
  '8P': 'BB', '8Q': 'MV', '8R': 'GY',
  '9A': 'HR', '9G': 'GH', '9H': 'MT', '9J': 'ZM', '9K': 'KW', '9L': 'SL', '9M': 'MY', '9N': 'NP',
  '9Q': 'CD', '9U': 'BI', '9V': 'SG', '9XR': 'RW', '9Y': 'TT',
}));

// Registries that write the mark without a hyphen, followed by a digit
// (N200VR, JA8089, HL7xxx, YV2040).
const UNHYPHENATED = /^(N|JA|HL|YV)\d/;

// China, Taiwan, Hong Kong and Macao share the B mark.
function chinaRegistry(suffix) {
  if (/^[HKL]/.test(suffix)) return 'HK';
  if (suffix.startsWith('M')) return 'MO';
  return /^\d{5}$/.test(suffix) ? 'TW' : 'CN';
}

/** State of registry for an aircraft registration mark, or null when it names none. */
export function aircraftRegistrationCountry(raw) {
  const tail = String(raw ?? '').trim().toUpperCase();
  const hyphen = tail.indexOf('-');
  if (hyphen === -1) return NATIONALITY_MARKS[tail.match(UNHYPHENATED)?.[1]] ?? null;
  const mark = tail.slice(0, hyphen);
  const suffix = tail.slice(hyphen + 1);
  if (!suffix) return null;
  if (mark === 'B') return chinaRegistry(suffix);
  if (mark === 'SU' && suffix.startsWith('Y')) return null;
  return NATIONALITY_MARKS[`${mark}-${suffix[0]}`] ?? NATIONALITY_MARKS[mark] ?? null;
}
