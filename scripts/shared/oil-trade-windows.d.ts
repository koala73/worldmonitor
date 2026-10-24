export interface OilWindowAverage {
  kbd: number | null;
  monthsCovered: number;
}

export interface OilWindowMetric {
  current: OilWindowAverage;
  prior: OilWindowAverage;
  yearAgo: OilWindowAverage;
  /** The current-window average yoyPct compares with yearAgo (mirror metrics: on basis.yoyReporters). */
  currentForYoy: OilWindowAverage;
  changePct: number | null;
  yoyPct: number | null;
  complete: boolean;
  basis?: { reporters: string[]; yoyReporters: string[] };
}

export interface OilWindowComparison {
  windowMonths: number;
  windows: Record<'current' | 'prior' | 'yearAgo', { from: string; to: string }>;
  metrics: Record<
    | 'production'
    | 'jodiCrudeExports'
    | 'jodiProductExports'
    | 'aisTankerLoadings'
    | 'mirrorCrudeImports'
    | 'mirrorProductImports',
    OilWindowMetric
  >;
}

export function shiftMonth(month: string, delta: number): string;
export function monthDays(month: string): number;
export function lastCompleteMonth(nowMs: number): string;
export function monthRange(from: string, to: string): string[];
export function compareOilWindows(
  country: { months?: Array<Record<string, unknown>> } | null | undefined,
  opts?: { nowMs?: number; windowMonths?: number },
): OilWindowComparison;
export function compactCountry(country: { months: Array<Record<string, any>> } & Record<string, any>): Record<string, any>;
export function expandCountry(compact: Record<string, any> | null | undefined): { months: Array<Record<string, any>> } & Record<string, any>;
