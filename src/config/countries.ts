import {
  DEFAULT_CII_BASELINE_RISK,
  DEFAULT_CII_EVENT_MULTIPLIER,
  getCiiCountryWeight,
} from '../../shared/cii-weights';
import type { CiiCountryCode } from '../../shared/cii-weights';

export interface CuratedCountryConfig {
  name: string;
  scoringKeywords: string[];
  searchAliases: string[];
  baselineRisk: number;
  eventMultiplier: number;
}

function ciiWeights(code: CiiCountryCode): Pick<CuratedCountryConfig, 'baselineRisk' | 'eventMultiplier'> {
  return getCiiCountryWeight(code);
}

export const CURATED_COUNTRIES: Record<string, CuratedCountryConfig> = {
  US: {
    name: 'United States',
    scoringKeywords: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
    searchAliases: ['united states', 'american', 'washington', 'pentagon', 'white house', 'usa', 'america', 'biden', 'trump'],
    ...ciiWeights('US'),
  },
  RU: {
    name: 'Russia',
    scoringKeywords: ['russia', 'moscow', 'kremlin', 'putin'],
    searchAliases: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'ukraine war'],
    ...ciiWeights('RU'),
  },
  CN: {
    name: 'China',
    scoringKeywords: ['china', 'beijing', 'xi jinping', 'prc'],
    searchAliases: ['china', 'chinese', 'beijing', 'taiwan strait', 'south china sea', 'xi jinping'],
    ...ciiWeights('CN'),
  },
  UA: {
    name: 'Ukraine',
    scoringKeywords: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
    searchAliases: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'zelenskyy'],
    ...ciiWeights('UA'),
  },
  IR: {
    name: 'Iran',
    scoringKeywords: ['iran', 'tehran', 'khamenei', 'irgc'],
    searchAliases: ['iran', 'iranian', 'tehran', 'persian', 'irgc', 'khamenei'],
    ...ciiWeights('IR'),
  },
  IL: {
    name: 'Israel',
    scoringKeywords: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
    searchAliases: ['israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'idf', 'west bank', 'tel aviv', 'jerusalem'],
    ...ciiWeights('IL'),
  },
  TW: {
    name: 'Taiwan',
    scoringKeywords: ['taiwan', 'taipei'],
    searchAliases: ['taiwan', 'taiwanese', 'taipei'],
    ...ciiWeights('TW'),
  },
  KP: {
    name: 'North Korea',
    scoringKeywords: ['north korea', 'pyongyang', 'kim jong'],
    searchAliases: ['north korea', 'pyongyang', 'kim jong'],
    ...ciiWeights('KP'),
  },
  SA: {
    name: 'Saudi Arabia',
    scoringKeywords: ['saudi arabia', 'riyadh', 'mbs'],
    searchAliases: ['saudi', 'riyadh', 'mbs'],
    ...ciiWeights('SA'),
  },
  TR: {
    name: 'Turkey',
    scoringKeywords: ['turkey', 'ankara', 'erdogan'],
    searchAliases: ['turkey', 'turkish', 'ankara', 'erdogan', 'türkiye'],
    ...ciiWeights('TR'),
  },
  PL: {
    name: 'Poland',
    scoringKeywords: ['poland', 'warsaw'],
    searchAliases: ['poland', 'polish', 'warsaw'],
    ...ciiWeights('PL'),
  },
  DE: {
    name: 'Germany',
    scoringKeywords: ['germany', 'berlin'],
    searchAliases: ['germany', 'german', 'berlin'],
    ...ciiWeights('DE'),
  },
  FR: {
    name: 'France',
    scoringKeywords: ['france', 'paris', 'macron'],
    searchAliases: ['france', 'french', 'paris', 'macron'],
    ...ciiWeights('FR'),
  },
  GB: {
    name: 'United Kingdom',
    scoringKeywords: ['britain', 'uk', 'london', 'starmer'],
    searchAliases: ['united kingdom', 'british', 'london', 'uk '],
    ...ciiWeights('GB'),
  },
  IN: {
    name: 'India',
    scoringKeywords: ['india', 'delhi', 'modi'],
    searchAliases: ['india', 'indian', 'new delhi', 'modi'],
    ...ciiWeights('IN'),
  },
  PK: {
    name: 'Pakistan',
    scoringKeywords: ['pakistan', 'islamabad'],
    searchAliases: ['pakistan', 'pakistani', 'islamabad'],
    ...ciiWeights('PK'),
  },
  SY: {
    name: 'Syria',
    scoringKeywords: ['syria', 'damascus', 'assad'],
    searchAliases: ['syria', 'syrian', 'damascus', 'assad'],
    ...ciiWeights('SY'),
  },
  YE: {
    name: 'Yemen',
    scoringKeywords: ['yemen', 'sanaa', 'houthi'],
    searchAliases: ['yemen', 'houthi', 'sanaa'],
    ...ciiWeights('YE'),
  },
  MM: {
    name: 'Myanmar',
    scoringKeywords: ['myanmar', 'burma', 'rangoon'],
    searchAliases: ['myanmar', 'burmese', 'burma', 'rangoon'],
    ...ciiWeights('MM'),
  },
  VE: {
    name: 'Venezuela',
    scoringKeywords: ['venezuela', 'caracas', 'maduro'],
    searchAliases: ['venezuela', 'venezuelan', 'caracas', 'maduro'],
    ...ciiWeights('VE'),
  },
  BR: {
    name: 'Brazil',
    scoringKeywords: ['brazil', 'brasilia', 'lula', 'bolsonaro'],
    searchAliases: ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro'],
    ...ciiWeights('BR'),
  },
  AE: {
    name: 'United Arab Emirates',
    scoringKeywords: ['uae', 'emirates', 'dubai', 'abu dhabi'],
    searchAliases: ['united arab emirates', 'uae', 'emirati', 'dubai', 'abu dhabi'],
    ...ciiWeights('AE'),
  },
  MX: {
    name: 'Mexico',
    scoringKeywords: ['mexico', 'mexican', 'amlo', 'sheinbaum', 'cartel', 'sinaloa', 'jalisco', 'cjng', 'tijuana', 'juarez', 'sedena'],
    searchAliases: ['mexico', 'mexican', 'amlo', 'sheinbaum', 'cartel', 'sinaloa', 'jalisco', 'cjng', 'tijuana', 'juarez', 'sedena', 'fentanyl', 'narco'],
    ...ciiWeights('MX'),
  },
  KR: {
    name: 'South Korea',
    scoringKeywords: ['south korea', 'seoul'],
    searchAliases: ['south korea', 'seoul'],
    ...ciiWeights('KR'),
  },
  IQ: {
    name: 'Iraq',
    scoringKeywords: ['iraq', 'iraqi', 'baghdad'],
    searchAliases: ['iraq', 'iraqi', 'baghdad'],
    ...ciiWeights('IQ'),
  },
  AF: {
    name: 'Afghanistan',
    scoringKeywords: ['afghanistan', 'afghan', 'kabul', 'taliban'],
    searchAliases: ['afghanistan', 'afghan', 'kabul', 'taliban'],
    ...ciiWeights('AF'),
  },
  LB: {
    name: 'Lebanon',
    scoringKeywords: ['lebanon', 'lebanese', 'beirut'],
    searchAliases: ['lebanon', 'lebanese', 'beirut'],
    ...ciiWeights('LB'),
  },
  EG: {
    name: 'Egypt',
    scoringKeywords: ['egypt', 'egyptian', 'cairo', 'suez'],
    searchAliases: ['egypt', 'egyptian', 'cairo', 'suez'],
    ...ciiWeights('EG'),
  },
  JP: {
    name: 'Japan',
    scoringKeywords: ['japan', 'japanese', 'tokyo'],
    searchAliases: ['japan', 'japanese', 'tokyo'],
    ...ciiWeights('JP'),
  },
  QA: {
    name: 'Qatar',
    scoringKeywords: ['qatar', 'qatari', 'doha'],
    searchAliases: ['qatar', 'qatari', 'doha'],
    ...ciiWeights('QA'),
  },
  CU: {
    name: 'Cuba',
    scoringKeywords: ['cuba', 'cuban', 'havana', 'diaz-canel'],
    searchAliases: ['cuba', 'cuban', 'havana', 'diaz-canel', 'canel'],
    ...ciiWeights('CU'),
  },
};

export const TIER1_COUNTRIES: Record<string, string> = {
  US: 'United States',
  RU: 'Russia',
  CN: 'China',
  UA: 'Ukraine',
  IR: 'Iran',
  IL: 'Israel',
  TW: 'Taiwan',
  KP: 'North Korea',
  SA: 'Saudi Arabia',
  TR: 'Turkey',
  PL: 'Poland',
  DE: 'Germany',
  FR: 'France',
  GB: 'United Kingdom',
  IN: 'India',
  PK: 'Pakistan',
  SY: 'Syria',
  YE: 'Yemen',
  MM: 'Myanmar',
  VE: 'Venezuela',
  BR: 'Brazil',
  AE: 'United Arab Emirates',
  MX: 'Mexico',
  CU: 'Cuba',
  KR: 'South Korea',
  IQ: 'Iraq',
  AF: 'Afghanistan',
  LB: 'Lebanon',
  EG: 'Egypt',
  JP: 'Japan',
  QA: 'Qatar',
};

export const DEFAULT_BASELINE_RISK = DEFAULT_CII_BASELINE_RISK;
export const DEFAULT_EVENT_MULTIPLIER = DEFAULT_CII_EVENT_MULTIPLIER;

export const HOTSPOT_COUNTRY_MAP: Record<string, string | string[]> = {
  tehran: 'IR', moscow: 'RU', beijing: 'CN', kyiv: 'UA', taipei: 'TW',
  telaviv: 'IL', pyongyang: 'KP', sanaa: 'YE', riyadh: 'SA', ankara: 'TR',
  damascus: 'SY', caracas: 'VE', dc: 'US', london: 'GB',
  brussels: 'BE', baghdad: 'IQ', beirut: 'LB', doha: 'QA', abudhabi: 'AE',
  mexico: 'MX', havana: 'CU', nuuk: 'GL', sahel: ['ML', 'NE', 'BF'], haiti: 'HT',
  horn_africa: ['ET', 'SO', 'SD'], silicon_valley: 'US', wall_street: 'US',
  houston: 'US', cairo: 'EG',
};

export function getHotspotCountries(hotspotId: string): string[] {
  const val = HOTSPOT_COUNTRY_MAP[hotspotId];
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}
