export interface CiiCountryWeight {
  baselineRisk: number;
  eventMultiplier: number;
}

export const DEFAULT_CII_BASELINE_RISK = 15;
export const DEFAULT_CII_EVENT_MULTIPLIER = 1.0;

export const CII_COUNTRY_WEIGHTS = {
  US: { baselineRisk: 5, eventMultiplier: 0.3 },
  RU: { baselineRisk: 35, eventMultiplier: 2.0 },
  CN: { baselineRisk: 25, eventMultiplier: 2.5 },
  UA: { baselineRisk: 50, eventMultiplier: 0.8 },
  IR: { baselineRisk: 40, eventMultiplier: 2.0 },
  IL: { baselineRisk: 45, eventMultiplier: 0.7 },
  TW: { baselineRisk: 30, eventMultiplier: 1.5 },
  KP: { baselineRisk: 45, eventMultiplier: 3.0 },
  SA: { baselineRisk: 20, eventMultiplier: 2.0 },
  TR: { baselineRisk: 25, eventMultiplier: 1.2 },
  PL: { baselineRisk: 10, eventMultiplier: 0.8 },
  DE: { baselineRisk: 5, eventMultiplier: 0.5 },
  FR: { baselineRisk: 10, eventMultiplier: 0.6 },
  GB: { baselineRisk: 5, eventMultiplier: 0.5 },
  IN: { baselineRisk: 20, eventMultiplier: 0.8 },
  PK: { baselineRisk: 35, eventMultiplier: 1.5 },
  SY: { baselineRisk: 50, eventMultiplier: 0.7 },
  YE: { baselineRisk: 50, eventMultiplier: 0.7 },
  MM: { baselineRisk: 45, eventMultiplier: 1.8 },
  VE: { baselineRisk: 40, eventMultiplier: 1.8 },
  CU: { baselineRisk: 45, eventMultiplier: 2.0 },
  MX: { baselineRisk: 35, eventMultiplier: 1.0 },
  BR: { baselineRisk: 15, eventMultiplier: 0.6 },
  AE: { baselineRisk: 10, eventMultiplier: 1.5 },
  KR: { baselineRisk: 15, eventMultiplier: 0.8 },
  IQ: { baselineRisk: 40, eventMultiplier: 1.2 },
  AF: { baselineRisk: 45, eventMultiplier: 0.8 },
  LB: { baselineRisk: 40, eventMultiplier: 1.5 },
  EG: { baselineRisk: 20, eventMultiplier: 1.0 },
  JP: { baselineRisk: 5, eventMultiplier: 0.5 },
  QA: { baselineRisk: 10, eventMultiplier: 0.8 },
} as const satisfies Record<string, CiiCountryWeight>;

export type CiiCountryCode = keyof typeof CII_COUNTRY_WEIGHTS;

export const CII_BASELINE_RISK: Record<CiiCountryCode, number> =
  Object.fromEntries(
    Object.entries(CII_COUNTRY_WEIGHTS).map(([code, weights]) => [code, weights.baselineRisk]),
  ) as Record<CiiCountryCode, number>;

export const CII_EVENT_MULTIPLIER: Record<CiiCountryCode, number> =
  Object.fromEntries(
    Object.entries(CII_COUNTRY_WEIGHTS).map(([code, weights]) => [code, weights.eventMultiplier]),
  ) as Record<CiiCountryCode, number>;

export function getCiiCountryWeight(code: string): CiiCountryWeight {
  return CII_COUNTRY_WEIGHTS[code as CiiCountryCode] ?? {
    baselineRisk: DEFAULT_CII_BASELINE_RISK,
    eventMultiplier: DEFAULT_CII_EVENT_MULTIPLIER,
  };
}
