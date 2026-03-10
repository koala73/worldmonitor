export interface CuratedCountryConfig {
  name: string;
  scoringKeywords: string[];
  searchAliases: string[];
  baselineRisk: number;
  eventMultiplier: number;
}

export const CURATED_COUNTRIES: Record<string, CuratedCountryConfig> = {
  US: {
    name: 'United States',
    scoringKeywords: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
    searchAliases: ['united states', 'american', 'washington', 'pentagon', 'white house', 'usa', 'america', 'biden', 'trump'],
    baselineRisk: 5,
    eventMultiplier: 0.3,
  },
  RU: {
    name: 'Russia',
    scoringKeywords: ['russia', 'moscow', 'kremlin', 'putin'],
    searchAliases: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'ukraine war'],
    baselineRisk: 35,
    eventMultiplier: 2.0,
  },
  CN: {
    name: 'China',
    scoringKeywords: ['china', 'beijing', 'xi jinping', 'prc'],
    searchAliases: ['china', 'chinese', 'beijing', 'taiwan strait', 'south china sea', 'xi jinping'],
    baselineRisk: 25,
    eventMultiplier: 2.5,
  },
  UA: {
    name: 'Ukraine',
    scoringKeywords: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
    searchAliases: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'zelenskyy'],
    baselineRisk: 50,
    eventMultiplier: 0.8,
  },
  IR: {
    name: 'Iran',
    scoringKeywords: ['iran', 'tehran', 'khamenei', 'irgc'],
    searchAliases: ['iran', 'iranian', 'tehran', 'persian', 'irgc', 'khamenei'],
    baselineRisk: 40,
    eventMultiplier: 2.0,
  },
  IL: {
    name: 'Israel',
    scoringKeywords: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
    searchAliases: ['israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'idf', 'west bank', 'tel aviv', 'jerusalem'],
    baselineRisk: 45,
    eventMultiplier: 0.7,
  },
  TW: {
    name: 'Taiwan',
    scoringKeywords: ['taiwan', 'taipei'],
    searchAliases: ['taiwan', 'taiwanese', 'taipei'],
    baselineRisk: 30,
    eventMultiplier: 1.5,
  },
  KP: {
    name: 'North Korea',
    scoringKeywords: ['north korea', 'pyongyang', 'kim jong'],
    searchAliases: ['north korea', 'pyongyang', 'kim jong'],
    baselineRisk: 45,
    eventMultiplier: 3.0,
  },
  SA: {
    name: 'Saudi Arabia',
    scoringKeywords: ['saudi arabia', 'riyadh', 'mbs'],
    searchAliases: ['saudi', 'riyadh', 'mbs'],
    baselineRisk: 20,
    eventMultiplier: 2.0,
  },
  TR: {
    name: 'Turkey',
    scoringKeywords: ['turkey', 'ankara', 'erdogan'],
    searchAliases: ['turkey', 'turkish', 'ankara', 'erdogan', 'türkiye'],
    baselineRisk: 25,
    eventMultiplier: 1.2,
  },
  PL: {
    name: 'Poland',
    scoringKeywords: ['poland', 'warsaw'],
    searchAliases: ['poland', 'polish', 'warsaw'],
    baselineRisk: 10,
    eventMultiplier: 0.8,
  },
  DE: {
    name: 'Germany',
    scoringKeywords: ['germany', 'berlin'],
    searchAliases: ['germany', 'german', 'berlin'],
    baselineRisk: 5,
    eventMultiplier: 0.5,
  },
  FR: {
    name: 'France',
    scoringKeywords: ['france', 'paris', 'macron'],
    searchAliases: ['france', 'french', 'paris', 'macron'],
    baselineRisk: 10,
    eventMultiplier: 0.6,
  },
  GB: {
    name: 'United Kingdom',
    scoringKeywords: ['britain', 'uk', 'london', 'starmer'],
    searchAliases: ['united kingdom', 'british', 'london', 'uk '],
    baselineRisk: 5,
    eventMultiplier: 0.5,
  },
  IN: {
    name: 'India',
    scoringKeywords: ['india', 'delhi', 'modi'],
    searchAliases: ['india', 'indian', 'new delhi', 'modi'],
    baselineRisk: 20,
    eventMultiplier: 0.8,
  },
  PK: {
    name: 'Pakistan',
    scoringKeywords: ['pakistan', 'islamabad'],
    searchAliases: ['pakistan', 'pakistani', 'islamabad'],
    baselineRisk: 35,
    eventMultiplier: 1.5,
  },
  SY: {
    name: 'Syria',
    scoringKeywords: ['syria', 'damascus', 'assad'],
    searchAliases: ['syria', 'syrian', 'damascus', 'assad'],
    baselineRisk: 50,
    eventMultiplier: 0.7,
  },
  YE: {
    name: 'Yemen',
    scoringKeywords: ['yemen', 'sanaa', 'houthi'],
    searchAliases: ['yemen', 'houthi', 'sanaa'],
    baselineRisk: 50,
    eventMultiplier: 0.7,
  },
  MM: {
    name: 'Myanmar',
    scoringKeywords: ['myanmar', 'burma', 'rangoon'],
    searchAliases: ['myanmar', 'burmese', 'burma', 'rangoon'],
    baselineRisk: 45,
    eventMultiplier: 1.8,
  },
  VE: {
    name: 'Venezuela',
    scoringKeywords: ['venezuela', 'caracas', 'maduro'],
    searchAliases: ['venezuela', 'venezuelan', 'caracas', 'maduro'],
    baselineRisk: 40,
    eventMultiplier: 1.8,
  },
  BR: {
    name: 'Brazil',
    scoringKeywords: ['brazil', 'brasilia', 'lula', 'bolsonaro'],
    searchAliases: ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro'],
    baselineRisk: 15,
    eventMultiplier: 0.6,
  },
  AE: {
    name: 'United Arab Emirates',
    scoringKeywords: ['uae', 'emirates', 'dubai', 'abu dhabi'],
    searchAliases: ['united arab emirates', 'uae', 'emirati', 'dubai', 'abu dhabi'],
    baselineRisk: 10,
    eventMultiplier: 1.5,
  },
  MX: {
    name: 'Mexico',
    scoringKeywords: ['mexico', 'mexican', 'amlo', 'sheinbaum', 'cartel', 'sinaloa', 'jalisco', 'cjng', 'tijuana', 'juarez', 'sedena'],
    searchAliases: ['mexico', 'mexican', 'amlo', 'sheinbaum', 'cartel', 'sinaloa', 'jalisco', 'cjng', 'tijuana', 'juarez', 'sedena', 'fentanyl', 'narco'],
    baselineRisk: 35,
    eventMultiplier: 1.0,
  },
  KR: {
    name: 'South Korea',
    scoringKeywords: ['south korea', 'seoul'],
    searchAliases: ['south korea', 'seoul'],
    baselineRisk: 15,
    eventMultiplier: 1.0,
  },
  IQ: {
    name: 'Iraq',
    scoringKeywords: ['iraq', 'iraqi', 'baghdad'],
    searchAliases: ['iraq', 'iraqi', 'baghdad'],
    baselineRisk: 35,
    eventMultiplier: 1.0,
  },
  AF: {
    name: 'Afghanistan',
    scoringKeywords: ['afghanistan', 'afghan', 'kabul', 'taliban'],
    searchAliases: ['afghanistan', 'afghan', 'kabul', 'taliban'],
    baselineRisk: 15,
    eventMultiplier: 1.0,
  },
  LB: {
    name: 'Lebanon',
    scoringKeywords: ['lebanon', 'lebanese', 'beirut'],
    searchAliases: ['lebanon', 'lebanese', 'beirut'],
    baselineRisk: 15,
    eventMultiplier: 1.0,
  },
  EG: {
    name: 'Egypt',
    scoringKeywords: ['egypt', 'egyptian', 'cairo', 'suez'],
    searchAliases: ['egypt', 'egyptian', 'cairo', 'suez'],
    baselineRisk: 15,
    eventMultiplier: 1.0,
  },
  JP: {
    name: 'Japan',
    scoringKeywords: ['japan', 'japanese', 'tokyo'],
    searchAliases: ['japan', 'japanese', 'tokyo'],
    baselineRisk: 15,
    eventMultiplier: 1.0,
  },
  QA: {
    name: 'Qatar',
    scoringKeywords: ['qatar', 'qatari', 'doha'],
    searchAliases: ['qatar', 'qatari', 'doha'],
    baselineRisk: 15,
    eventMultiplier: 1.0,
  },
  CU: {
    name: 'Cuba',
    scoringKeywords: ['cuba', 'cuban', 'havana', 'diaz-canel'],
    searchAliases: ['cuba', 'cuban', 'havana', 'diaz-canel', 'canel'],
    baselineRisk: 45,
    eventMultiplier: 2.0,
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
};

export const DEFAULT_BASELINE_RISK = 15;
export const DEFAULT_EVENT_MULTIPLIER = 1.0;

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
