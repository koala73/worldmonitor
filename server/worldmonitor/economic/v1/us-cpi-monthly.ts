export const CPI_COMPONENTS = ['headline', 'core', 'food', 'energy', 'shelter', 'services'] as const;

export type CpiComponent = (typeof CPI_COMPONENTS)[number];

export const CPI_CANONICAL_KEY = 'economic:us-cpi:v1';
export const CPI_LATEST_KEY = 'economic:us-cpi:latest:v1';
export const CPI_DECADE_STARTS = [1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030] as const;

export interface CpiObservation {
  date: string;
  value: number;
}

export interface CpiSeed {
  components?: Partial<Record<CpiComponent, CpiObservation[]>>;
}

export interface CpiPercentChange {
  percent: number;
}

export interface CpiReading {
  index: number;
  monthOverMonth?: CpiPercentChange;
  yearOverYear?: CpiPercentChange;
}

export interface CpiMonth {
  month: number;
  headline?: CpiReading;
  core?: CpiReading;
  food?: CpiReading;
  energy?: CpiReading;
  shelter?: CpiReading;
  services?: CpiReading;
}

export function cpiDecadeKey(decade: number): string {
  return `${CPI_CANONICAL_KEY}:${decade}`;
}

export function shiftMonth(isoDate: string, delta: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-01$/.exec(isoDate);
  if (!match) return undefined;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-01`;
}

export function monthStartMs(isoDate: string): number | undefined {
  if (!/^\d{4}-\d{2}-01$/.test(isoDate)) return undefined;
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

function roundPercent(value: number): number {
  const scaled = value * 10_000;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / 10_000;
}

export function percentChange(current: number, base: number): number | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return undefined;
  return roundPercent((current / base - 1) * 100);
}

function indexByDate(points: CpiObservation[] | undefined): Map<string, number> {
  const indexed = new Map<string, number>();
  for (const point of points ?? []) {
    if (!/^\d{4}-\d{2}-01$/.test(point.date) || !Number.isFinite(point.value)) continue;
    indexed.set(point.date, point.value);
  }
  return indexed;
}

function reading(indexed: Map<string, number>, date: string): CpiReading | undefined {
  const index = indexed.get(date);
  if (index == null) return undefined;
  const previous = shiftMonth(date, -1);
  const yearAgo = shiftMonth(date, -12);
  const monthOverMonth = previous == null ? undefined : percentChange(index, indexed.get(previous) ?? Number.NaN);
  const yearOverYear = yearAgo == null ? undefined : percentChange(index, indexed.get(yearAgo) ?? Number.NaN);
  return {
    index,
    ...(monthOverMonth == null ? {} : { monthOverMonth: { percent: monthOverMonth } }),
    ...(yearOverYear == null ? {} : { yearOverYear: { percent: yearOverYear } }),
  };
}

export function buildUsCpiMonths(seed: CpiSeed, history: boolean): CpiMonth[] {
  const indexes = new Map<CpiComponent, Map<string, number>>();
  const dates = new Set<string>();
  for (const component of CPI_COMPONENTS) {
    const indexed = indexByDate(seed.components?.[component]);
    indexes.set(component, indexed);
    for (const date of indexed.keys()) dates.add(date);
  }
  const ordered = [...dates].filter((date) => monthStartMs(date) != null).sort();
  const selected = history ? ordered : ordered.slice(-1);
  const months: CpiMonth[] = [];
  for (const date of selected) {
    const month = monthStartMs(date);
    if (month == null) continue;
    const row: CpiMonth = { month };
    let present = false;
    for (const component of CPI_COMPONENTS) {
      const value = reading(indexes.get(component) ?? new Map(), date);
      if (!value) continue;
      row[component] = value;
      present = true;
    }
    if (present) months.push(row);
  }
  return months;
}

export function mergeCpiShards(shards: CpiSeed[]): CpiSeed {
  const components: CpiSeed['components'] = {};
  for (const component of CPI_COMPONENTS) {
    const indexed = new Map<string, number>();
    for (const shard of shards) {
      for (const [date, value] of indexByDate(shard.components?.[component])) indexed.set(date, value);
    }
    if (indexed.size === 0) continue;
    components[component] = [...indexed.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([date, value]) => ({ date, value }));
  }
  return { components };
}
