export const TREASURY_START_YEAR = 1990;
export const TREASURY_CANONICAL_KEY = 'economic:us-treasury-par-yield:v1';
export const TREASURY_LATEST_KEY = 'economic:us-treasury-par-yield:latest:v1';

export const YIELD_FIELDS = [
  'oneMonth',
  'oneAndAHalfMonth',
  'twoMonth',
  'threeMonth',
  'fourMonth',
  'sixMonth',
  'oneYear',
  'twoYear',
  'threeYear',
  'fiveYear',
  'sevenYear',
  'tenYear',
  'twentyYear',
  'thirtyYear',
] as const;

export type YieldField = (typeof YIELD_FIELDS)[number];

export interface TreasuryCurveSeed {
  date: string;
  oneMonth?: number;
  oneAndAHalfMonth?: number;
  twoMonth?: number;
  threeMonth?: number;
  fourMonth?: number;
  sixMonth?: number;
  oneYear?: number;
  twoYear?: number;
  threeYear?: number;
  fiveYear?: number;
  sevenYear?: number;
  tenYear?: number;
  twentyYear?: number;
  thirtyYear?: number;
}

export interface TreasuryCurve {
  date: number;
  oneMonth?: number;
  oneAndAHalfMonth?: number;
  twoMonth?: number;
  threeMonth?: number;
  fourMonth?: number;
  sixMonth?: number;
  oneYear?: number;
  twoYear?: number;
  threeYear?: number;
  fiveYear?: number;
  sevenYear?: number;
  tenYear?: number;
  twentyYear?: number;
  thirtyYear?: number;
}

export function treasuryYearKey(year: number): string {
  return `${TREASURY_CANONICAL_KEY}:${year}`;
}

export function treasuryYears(now = new Date()): number[] {
  const end = now.getUTCFullYear();
  const years: number[] = [];
  for (let year = TREASURY_START_YEAR; year <= end; year += 1) years.push(year);
  return years;
}

function businessDayMs(isoDate: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

export function toTreasuryCurve(seed: TreasuryCurveSeed): TreasuryCurve | undefined {
  const date = businessDayMs(seed.date);
  if (date == null) return undefined;
  const curve: TreasuryCurve = { date };
  let present = false;
  for (const field of YIELD_FIELDS) {
    const value = seed[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    curve[field] = value;
    present = true;
  }
  return present ? curve : undefined;
}

function isCurveSeed(value: unknown): value is TreasuryCurveSeed {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as TreasuryCurveSeed).date === 'string';
}

export function treasuryCurvesFromSeed(value: unknown): TreasuryCurve[] {
  return treasuryCurvesFromShards([value]);
}

export function treasuryCurvesFromShards(values: unknown[]): TreasuryCurve[] {
  const byDate = new Map<number, TreasuryCurve>();
  for (const value of values) {
    const record = value && typeof value === 'object' ? value as { curves?: unknown } : undefined;
    const seeds = Array.isArray(record?.curves)
      ? record.curves.filter(isCurveSeed)
      : isCurveSeed(value) ? [value] : [];
    for (const seed of seeds) {
      const curve = toTreasuryCurve(seed);
      if (curve) byDate.set(curve.date, curve);
    }
  }
  return [...byDate.values()].sort((left, right) => left.date - right.date);
}
