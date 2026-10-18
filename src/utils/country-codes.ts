export { iso2ToUnCode, iso2ToComtradeReporterCode } from '../../shared/country-numeric-codes';

export const ISO2_TO_ISO3: Record<string, string> = {
  AD: 'AND', AE: 'ARE', AF: 'AFG', AG: 'ATG', AI: 'AIA', AL: 'ALB', AM: 'ARM', AO: 'AGO',
  AQ: 'ATA', AR: 'ARG', AS: 'ASM', AT: 'AUT', AU: 'AUS', AW: 'ABW', AX: 'ALA', AZ: 'AZE',
  BA: 'BIH', BB: 'BRB', BD: 'BGD', BE: 'BEL', BF: 'BFA', BG: 'BGR', BH: 'BHR', BI: 'BDI',
  BJ: 'BEN', BL: 'BLM', BM: 'BMU', BN: 'BRN', BO: 'BOL', BR: 'BRA', BS: 'BHS', BT: 'BTN',
  BW: 'BWA', BY: 'BLR', BZ: 'BLZ', CA: 'CAN', CD: 'COD', CF: 'CAF', CG: 'COG', CH: 'CHE',
  CI: 'CIV', CK: 'COK', CL: 'CHL', CM: 'CMR', CN: 'CHN', CO: 'COL', CR: 'CRI', CU: 'CUB',
  CV: 'CPV', CW: 'CUW', CY: 'CYP', CZ: 'CZE', DE: 'DEU', DJ: 'DJI', DK: 'DNK', DM: 'DMA',
  DO: 'DOM', DZ: 'DZA', EC: 'ECU', EE: 'EST', EG: 'EGY', EH: 'ESH', ER: 'ERI', ES: 'ESP',
  ET: 'ETH', FI: 'FIN', FJ: 'FJI', FK: 'FLK', FM: 'FSM', FO: 'FRO', FR: 'FRA', GA: 'GAB',
  GB: 'GBR', GD: 'GRD', GE: 'GEO', GG: 'GGY', GH: 'GHA', GI: 'GIB', GL: 'GRL', GM: 'GMB',
  GN: 'GIN', GQ: 'GNQ', GR: 'GRC', GS: 'SGS', GT: 'GTM', GU: 'GUM', GW: 'GNB', GY: 'GUY',
  HK: 'HKG', HM: 'HMD', HN: 'HND', HR: 'HRV', HT: 'HTI', HU: 'HUN', ID: 'IDN', IE: 'IRL',
  IL: 'ISR', IM: 'IMN', IN: 'IND', IO: 'IOT', IQ: 'IRQ', IR: 'IRN', IS: 'ISL', IT: 'ITA',
  JE: 'JEY', JM: 'JAM', JO: 'JOR', JP: 'JPN', KE: 'KEN', KG: 'KGZ', KH: 'KHM', KI: 'KIR',
  KM: 'COM', KN: 'KNA', KP: 'PRK', KR: 'KOR', KW: 'KWT', KY: 'CYM', KZ: 'KAZ', LA: 'LAO',
  LB: 'LBN', LC: 'LCA', LI: 'LIE', LK: 'LKA', LR: 'LBR', LS: 'LSO', LT: 'LTU', LU: 'LUX',
  LV: 'LVA', LY: 'LBY', MA: 'MAR', MC: 'MCO', MD: 'MDA', ME: 'MNE', MF: 'MAF', MG: 'MDG',
  MH: 'MHL', MK: 'MKD', ML: 'MLI', MM: 'MMR', MN: 'MNG', MO: 'MAC', MP: 'MNP', MR: 'MRT',
  MS: 'MSR', MT: 'MLT', MU: 'MUS', MV: 'MDV', MW: 'MWI', MX: 'MEX', MY: 'MYS', MZ: 'MOZ',
  NA: 'NAM', NC: 'NCL', NE: 'NER', NF: 'NFK', NG: 'NGA', NI: 'NIC', NL: 'NLD', NO: 'NOR',
  NP: 'NPL', NR: 'NRU', NU: 'NIU', NZ: 'NZL', OM: 'OMN', PA: 'PAN', PE: 'PER', PF: 'PYF',
  PG: 'PNG', PH: 'PHL', PK: 'PAK', PL: 'POL', PM: 'SPM', PN: 'PCN', PR: 'PRI', PS: 'PSE',
  PT: 'PRT', PW: 'PLW', PY: 'PRY', QA: 'QAT', RO: 'ROU', RS: 'SRB', RU: 'RUS', RW: 'RWA',
  SA: 'SAU', SB: 'SLB', SC: 'SYC', SD: 'SDN', SE: 'SWE', SG: 'SGP', SH: 'SHN', SI: 'SVN',
  SK: 'SVK', SL: 'SLE', SM: 'SMR', SN: 'SEN', SO: 'SOM', SR: 'SUR', SS: 'SSD', ST: 'STP',
  SV: 'SLV', SX: 'SXM', SY: 'SYR', SZ: 'SWZ', TC: 'TCA', TD: 'TCD', TF: 'ATF', TG: 'TGO',
  TH: 'THA', TJ: 'TJK', TL: 'TLS', TM: 'TKM', TN: 'TUN', TO: 'TON', TR: 'TUR', TT: 'TTO',
  TV: 'TUV', TW: 'TWN', TZ: 'TZA', UA: 'UKR', UG: 'UGA', UM: 'UMI', US: 'USA', UY: 'URY',
  UZ: 'UZB', VA: 'VAT', VC: 'VCT', VE: 'VEN', VG: 'VGB', VI: 'VIR', VN: 'VNM', VU: 'VUT',
  WF: 'WLF', WS: 'WSM', XK: 'XKX', YE: 'YEM', ZA: 'ZAF', ZM: 'ZMB', ZW: 'ZWE',
};

export function iso2ToIso3(iso2: string): string | null {
  return ISO2_TO_ISO3[iso2.toUpperCase()] ?? null;
}

const ISO3_TO_ISO2: Record<string, string> = Object.fromEntries(
  Object.entries(ISO2_TO_ISO3).map(([iso2, iso3]) => [iso3, iso2]),
);

// Tight alias map for the most common name forms. Keep <30 entries; reject
// unknown rather than try to be a full geocoder. Keys are lowercase.
const NAME_ALIASES_TO_ISO2: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  'america': 'US',
  'united kingdom': 'GB',
  'uk': 'GB',
  'u.k.': 'GB',
  'britain': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'russia': 'RU',
  'russian federation': 'RU',
  'south korea': 'KR',
  'korea, south': 'KR',
  'republic of korea': 'KR',
  'north korea': 'KP',
  'korea, north': 'KP',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'ivory coast': 'CI',
  "cote d'ivoire": 'CI',
  'vietnam': 'VN',
  'viet nam': 'VN',
  'iran': 'IR',
  'syria': 'SY',
  'taiwan': 'TW',
  'palestine': 'PS',
  'vatican': 'VA',
  'uae': 'AE',
};

export function toIso2(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && ISO2_TO_ISO3[upper]) return upper;
  if (upper.length === 3 && ISO3_TO_ISO2[upper]) return ISO3_TO_ISO2[upper];
  return NAME_ALIASES_TO_ISO2[trimmed.toLowerCase()] ?? null;
}
