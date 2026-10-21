// GDELT ActionGeo_CountryCode and GKG V1LOCATIONS use FIPS 10-4 rather than
// ISO-2. The full table, not the conflict subset: the per-country article
// index (#7748) needs every country the crawlable corpus renders, and a
// naive "FIPS equals ISO" fallback would file Algeria (AG) under Antigua,
// Australia (AS) under American Samoa and Germany (GM) under The Gambia.
// Palestine can appear as either Gaza (GZ) or West Bank (WE); Serbia is RI
// and Kosovo KV. Consumers gate on their own country lists (the conflict
// mapper on GDELT_COUNTRY_NAMES), so widening the table changes nothing for
// them.
//
// Pure data with no imports, on purpose: the bulk materializer's source is a
// `make generate` input (the OpenAPI example injector reads it), so anything
// it imports becomes a proto-freshness input too. The conflict-bulk module
// re-exports this table for its existing consumers.
export const GDELT_FIPS_TO_ISO2 = Object.freeze({
  AA: 'AW', AC: 'AG', AE: 'AE', AF: 'AF', AG: 'DZ', AJ: 'AZ', AL: 'AL', AM: 'AM',
  AN: 'AD', AO: 'AO', AQ: 'AS', AR: 'AR', AS: 'AU', AU: 'AT', AV: 'AI', AY: 'AQ',
  BA: 'BH', BB: 'BB', BC: 'BW', BD: 'BM', BE: 'BE', BF: 'BS', BG: 'BD', BH: 'BZ',
  BK: 'BA', BL: 'BO', BM: 'MM', BN: 'BJ', BO: 'BY', BP: 'SB', BR: 'BR', BT: 'BT',
  BU: 'BG', BV: 'BV', BX: 'BN', BY: 'BI', CA: 'CA', CB: 'KH', CD: 'TD', CE: 'LK',
  CF: 'CG', CG: 'CD', CH: 'CN', CI: 'CL', CJ: 'KY', CK: 'CC', CM: 'CM', CN: 'KM',
  CO: 'CO', CQ: 'MP', CS: 'CR', CT: 'CF', CU: 'CU', CV: 'CV', CW: 'CK', CY: 'CY',
  DA: 'DK', DJ: 'DJ', DO: 'DM', DR: 'DO', EC: 'EC', EG: 'EG', EI: 'IE', EK: 'GQ',
  EN: 'EE', ER: 'ER', ES: 'SV', ET: 'ET', EZ: 'CZ', FG: 'GF', FI: 'FI', FJ: 'FJ',
  FK: 'FK', FM: 'FM', FO: 'FO', FP: 'PF', FR: 'FR', FS: 'TF', GA: 'GM', GB: 'GA',
  GG: 'GE', GH: 'GH', GI: 'GI', GJ: 'GD', GK: 'GG', GL: 'GL', GM: 'DE', GP: 'GP',
  GQ: 'GU', GR: 'GR', GT: 'GT', GV: 'GN', GY: 'GY', GZ: 'PS', HA: 'HT', HK: 'HK',
  HM: 'HM', HO: 'HN', HR: 'HR', HU: 'HU', IC: 'IS', ID: 'ID', IM: 'IM', IN: 'IN',
  IO: 'IO', IR: 'IR', IS: 'IL', IT: 'IT', IV: 'CI', IZ: 'IQ', JA: 'JP', JE: 'JE',
  JM: 'JM', JN: 'SJ', JO: 'JO', KE: 'KE', KG: 'KG', KN: 'KP', KR: 'KI', KS: 'KR',
  KT: 'CX', KU: 'KW', KV: 'XK', KZ: 'KZ', LA: 'LA', LE: 'LB', LG: 'LV', LH: 'LT',
  LI: 'LR', LO: 'SK', LS: 'LI', LT: 'LS', LU: 'LU', LY: 'LY', MA: 'MG', MB: 'MQ',
  MC: 'MO', MD: 'MD', MF: 'YT', MG: 'MN', MH: 'MS', MI: 'MW', MJ: 'ME', MK: 'MK',
  ML: 'ML', MN: 'MC', MO: 'MA', MP: 'MU', MR: 'MR', MT: 'MT', MU: 'OM', MV: 'MV',
  MX: 'MX', MY: 'MY', MZ: 'MZ', NC: 'NC', NE: 'NU', NF: 'NF', NG: 'NE', NH: 'VU',
  NI: 'NG', NL: 'NL', NO: 'NO', NP: 'NP', NR: 'NR', NS: 'SR', NT: 'AN', NU: 'NI',
  NZ: 'NZ', OD: 'SS', PA: 'PY', PC: 'PN', PE: 'PE', PK: 'PK', PL: 'PL', PM: 'PA',
  PO: 'PT', PP: 'PG', PS: 'PW', PU: 'GW', QA: 'QA', RE: 'RE', RI: 'RS', RM: 'MH',
  RN: 'MF', RO: 'RO', RP: 'PH', RQ: 'PR', RS: 'RU', RW: 'RW', SA: 'SA', SB: 'PM',
  SC: 'KN', SE: 'SC', SF: 'ZA', SG: 'SN', SH: 'SH', SI: 'SI', SL: 'SL', SM: 'SM',
  SN: 'SG', SO: 'SO', SP: 'ES', ST: 'LC', SU: 'SD', SV: 'SJ', SW: 'SE', SX: 'GS',
  SY: 'SY', SZ: 'CH', TB: 'BL', TD: 'TT', TH: 'TH', TI: 'TJ', TK: 'TC', TL: 'TK',
  TN: 'TO', TO: 'TG', TP: 'ST', TS: 'TN', TT: 'TL', TU: 'TR', TV: 'TV', TW: 'TW',
  TX: 'TM', TZ: 'TZ', UG: 'UG', UK: 'GB', UP: 'UA', US: 'US', UV: 'BF', UY: 'UY',
  UZ: 'UZ', VC: 'VC', VE: 'VE', VI: 'VG', VM: 'VN', VQ: 'VI', VT: 'VA', WA: 'NA',
  WE: 'PS', WF: 'WF', WI: 'EH', WS: 'WS', WZ: 'SZ', YM: 'YE', ZA: 'ZM', ZI: 'ZW',
});
