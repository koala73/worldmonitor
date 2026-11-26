export type GridClockRegionCode = 'CA' | 'TN' | 'TX' | 'FL' | 'NY' | 'WA';
export const GRID_CLOCK_REGIONS: Record<GridClockRegionCode, { name: string; fips: string; slug: string }>;
export type GridClockWarningKind = 'grid' | 'weather' | 'space-weather';

export interface GridClockPoint {
  observedAt: number;
  customersOut: number | null;
  customersTracked: number | null;
  coverageKey: string;
  coverageLabel: string;
  sourceName: string;
  sourceUrl: string;
  /** Provider reported mixed-age data or incomplete inputs for this collection. */
  partial?: boolean;
  /** Only an explicit operator or incident report may set this field. */
  impact?: 'disrupted' | 'recovering' | 'restored';
  /** Restored electrical load and restored customers are different measures. */
  peakLoadRestoredPct?: number;
  detail?: string;
}

export interface GridClockWarning {
  title: string;
  kind: GridClockWarningKind;
  sourceName: string;
  sourceUrl: string;
  issuedAt: number;
  expiresAt: number;
}

export interface GridClockWarningSource {
  kind: GridClockWarningKind;
  sourceName: string;
  sourceUrl: string;
  checkedAt: number | null;
  status: 'available' | 'unavailable' | 'not_monitored';
}

export interface GridClockRegion {
  code: GridClockRegionCode;
  current: GridClockPoint | null;
  history: GridClockPoint[];
  lastImpactGapAt?: number | null;
  warnings: GridClockWarning[];
  recentWarnings?: GridClockWarning[];
  warningSources: GridClockWarningSource[];
  warningsCheckedAt: number | null;
}

export interface GridClockSnapshot {
  regions: GridClockRegion[];
}

export interface GridClockReading {
  phase: 'unknown' | 'monitoring' | 'watch' | 'disrupted' | 'recovering' | 'restored';
  freshness: 'fresh' | 'stale' | 'unavailable';
  warningsFresh: boolean;
  activeWarnings: GridClockWarning[];
  /** Net change between published totals within the same reporting footprint. */
  changeCustomers: number | null;
  comparisonAt: number | null;
}

export const GRID_CLOCK_MAX_AGE_MS: number;
export function isGridClockSnapshot(value: unknown): value is GridClockSnapshot;
export function deriveGridClock(region: GridClockRegion, now?: number): GridClockReading;
