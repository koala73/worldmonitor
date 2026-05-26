export type ForecastMacroRegionId =
  | 'mena'
  | 'east-asia'
  | 'europe'
  | 'north-america'
  | 'south-asia'
  | 'latam'
  | 'sub-saharan-africa'
  | 'global';

export function getForecastMacroRegion(
  region: string | null | undefined,
): ForecastMacroRegionId | null;
