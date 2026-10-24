export interface CiiCountryWeight {
  baselineRisk: number;
}

export const DEFAULT_CII_BASELINE_RISK = 15;

export const CII_COUNTRY_WEIGHTS = {
  US: { baselineRisk: 5 },
  RU: { baselineRisk: 35 },
  CN: { baselineRisk: 25 },
  UA: { baselineRisk: 50 },
  IR: { baselineRisk: 40 },
  IL: { baselineRisk: 45 },
  TW: { baselineRisk: 30 },
  KP: { baselineRisk: 45 },
  SA: { baselineRisk: 20 },
  TR: { baselineRisk: 25 },
  PL: { baselineRisk: 10 },
  DE: { baselineRisk: 5 },
  FR: { baselineRisk: 10 },
  GB: { baselineRisk: 5 },
  IN: { baselineRisk: 20 },
  PK: { baselineRisk: 35 },
  SY: { baselineRisk: 50 },
  YE: { baselineRisk: 50 },
  MM: { baselineRisk: 45 },
  VE: { baselineRisk: 40 },
  CU: { baselineRisk: 45 },
  MX: { baselineRisk: 35 },
  BR: { baselineRisk: 15 },
  AE: { baselineRisk: 10 },
  KR: { baselineRisk: 15 },
  IQ: { baselineRisk: 40 },
  AF: { baselineRisk: 45 },
  LB: { baselineRisk: 40 },
  EG: { baselineRisk: 20 },
  JP: { baselineRisk: 5 },
  QA: { baselineRisk: 10 },
} as const satisfies Record<string, CiiCountryWeight>;

export type CiiCountryCode = keyof typeof CII_COUNTRY_WEIGHTS;

export const CII_COUNTRY_CODES = Object.freeze(
  Object.keys(CII_COUNTRY_WEIGHTS) as CiiCountryCode[],
);

export const CII_BASELINE_RISK: Record<CiiCountryCode, number> =
  Object.fromEntries(
    Object.entries(CII_COUNTRY_WEIGHTS).map(([code, weights]) => [code, weights.baselineRisk]),
  ) as Record<CiiCountryCode, number>;

export function getCiiCountryWeight(code: string): CiiCountryWeight {
  return CII_COUNTRY_WEIGHTS[code as CiiCountryCode] ?? {
    baselineRisk: DEFAULT_CII_BASELINE_RISK,
  };
}
