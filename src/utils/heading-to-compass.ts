const COMPASS_DIRECTIONS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

export function headingToCompass(heading: number | null | undefined): string {
  const normalized = (((heading ?? 0) % 360) + 360) % 360;
  return COMPASS_DIRECTIONS[Math.round(normalized / 22.5) % COMPASS_DIRECTIONS.length] ?? 'N';
}
