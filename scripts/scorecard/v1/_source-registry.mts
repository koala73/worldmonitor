export type ScorecardSourceField =
  | 'population' | 'foodStocks' | 'demographics' | 'defense' | 'energyMix'
  | 'staticByCountry' | 'lowCarbon' | 'powerLosses' | 'importHhi' | 'techByIso2';

export const SCORECARD_SOURCE_KEYS = {
  population: 'economic:imf:labor:v1',
  foodStocks: 'resilience:food-stocks:v1',
  demographics: 'demographics:capability:v1',
  defense: 'military:industrial-base:v1',
  energyMix: 'energy:mix:v1:_all',
  staticByCountry: 'resilience:static:{ISO2}',
  lowCarbon: 'resilience:low-carbon-generation:v1',
  powerLosses: 'resilience:power-losses:v1',
  importHhi: 'resilience:recovery:import-hhi:v1',
  techByIso2: 'economic:worldbank-techreadiness:v1',
} as const satisfies Record<ScorecardSourceField, string>;
