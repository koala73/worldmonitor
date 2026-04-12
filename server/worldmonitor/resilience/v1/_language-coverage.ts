export type LanguageCoverageTier = 'primary' | 'secondary' | 'limited' | 'minimal';

export const LANGUAGE_TIERS: Record<LanguageCoverageTier, number> = {
  primary: 1.0,
  secondary: 0.7,
  limited: 0.4,
  minimal: 0.2,
};

export const COUNTRY_LANGUAGE_TIER: Record<string, LanguageCoverageTier> = {
  // primary: English-dominant media landscape
  US: 'primary', GB: 'primary', AU: 'primary', NZ: 'primary',
  CA: 'primary', IE: 'primary', SG: 'primary',

  // secondary: English widely available but not dominant
  IN: 'secondary', PH: 'secondary', NG: 'secondary', KE: 'secondary',
  ZA: 'secondary', GH: 'secondary', MY: 'secondary', PK: 'secondary',
  LK: 'secondary', BD: 'secondary', TZ: 'secondary', UG: 'secondary',
  RW: 'secondary', ZW: 'secondary', ZM: 'secondary', BW: 'secondary',
  NA: 'secondary', MW: 'secondary', SL: 'secondary', LR: 'secondary',
  GM: 'secondary', JM: 'secondary', TT: 'secondary', BB: 'secondary',
  GY: 'secondary', FJ: 'secondary', PG: 'secondary', WS: 'secondary',
  MT: 'secondary', CY: 'secondary', IL: 'secondary', AE: 'secondary',
  QA: 'secondary', BH: 'secondary', KW: 'secondary', JO: 'secondary',
  HK: 'secondary', NP: 'secondary', MM: 'secondary', KH: 'secondary',
  ET: 'secondary', CM: 'secondary', MZ: 'secondary', LS: 'secondary',
  SZ: 'secondary',

  // limited: English available but minority of media
  CN: 'limited', JP: 'limited', RU: 'limited', BR: 'limited',
  FR: 'limited', DE: 'limited', ES: 'limited', IT: 'limited',
  KR: 'limited', TR: 'limited', MX: 'limited', AR: 'limited',
  CO: 'limited', CL: 'limited', PE: 'limited', VE: 'limited',
  EC: 'limited', PL: 'limited', UA: 'limited', RO: 'limited',
  CZ: 'limited', HU: 'limited', GR: 'limited', PT: 'limited',
  SE: 'limited', NO: 'limited', DK: 'limited', FI: 'limited',
  NL: 'limited', BE: 'limited', AT: 'limited', CH: 'limited',
  TH: 'limited', VN: 'limited', ID: 'limited', TW: 'limited',
  EG: 'limited', SA: 'limited', IQ: 'limited', IR: 'limited',
  MA: 'limited', TN: 'limited', DZ: 'limited', LB: 'limited',
  RS: 'limited', BG: 'limited', HR: 'limited', SK: 'limited',
  SI: 'limited', LT: 'limited', LV: 'limited', EE: 'limited',
  BY: 'limited', GE: 'limited', AM: 'limited', AZ: 'limited',
  KZ: 'limited', UZ: 'limited',

  // Unlisted countries default to 'minimal' (0.2)
};

export function getLanguageCoverageFactor(iso2: string): number {
  const tier = COUNTRY_LANGUAGE_TIER[iso2.toUpperCase()] ?? 'minimal';
  return LANGUAGE_TIERS[tier];
}
