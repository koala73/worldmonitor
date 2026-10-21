/**
 * CLS mover attribution (#5332, #4580).
 *
 * `largestShiftTarget`/shifted-content rankings name shift VICTIMS — what
 * moved — not MOVERS — what changed size and pushed them. That distinction
 * was proven the hard way twice: fixing the banner (#5137) removed `#main`
 * from the victim rankings, and pinning the ranked panels' heights (#5333)
 * left field CLS unmoved because the pinned panels were themselves victims.
 *
 * This tracker names movers directly. It keeps a per-panel geometry cache
 * (stable mover key -> {top, height}) and, on every qualifying layout-shift delivery,
 * diffs the current geometry against the cache: a panel whose HEIGHT changed
 * is a mover; a panel whose position changed at constant height is a victim;
 * a panel present now but absent from the cache is an insertion (mount-order
 * suspects). The six-record ring's three largest deliveries ride the CLS
 * Sentry report (bad-tail only, same volume policy) as compact strings.
 *
 * The diff core is pure and unit-tested without DOM (tests/cls-mover-tracker).
 */

export interface PanelRect {
  top: number;
  height: number;
}

export interface PanelGeometryDiff {
  heightChangers: Array<{ key: string; delta: number }>;
  movedOnly: string[];
  inserted: string[];
  /** Panels in the cache but gone from the layout — removal collapses their
   *  occupied height and pulls siblings up, a mover class of its own. */
  removed: string[];
}

export interface MoverRecord extends PanelGeometryDiff {
  /** startTime of the latest layout-shift entry in this delivery, rounded. */
  t: number;
  /** Sum of the non-input layout-shift values delivered together. */
  value: number;
  /** Number of layout-shift entries represented when a delivery was batched. */
  entryCount?: number;
  /** The shift arrived before any baseline snapshot existed — the mover is
   *  unattributable, but the report should still show a big shift happened. */
  coldStart?: boolean;
}

/** Ignore sub-pixel/jitter deltas — real row growth is tens of pixels. */
const GEOMETRY_JITTER_PX = 2;
/** Only diff on shifts big enough to matter; the cache still refreshes below it. */
const RECORD_SHIFT_THRESHOLD = 0.05;
/** Ring size for recorded diffs; the report keeps the top 3 by value. */
const MAX_RECORDS = 6;
/** Cache refreshes are rate-limited between recorded diffs. */
const CACHE_REFRESH_MIN_MS = 500;

/** Pure: classify panels by what changed between two geometry snapshots. */
export function diffPanelGeometry(
  cache: Record<string, PanelRect>,
  current: Record<string, PanelRect>,
): PanelGeometryDiff {
  const heightChangers: Array<{ key: string; delta: number }> = [];
  const movedOnly: string[] = [];
  const inserted: string[] = [];
  const removed = Object.keys(cache).filter((key) => !(key in current));
  for (const [key, rect] of Object.entries(current)) {
    const prev = cache[key];
    if (!prev) {
      inserted.push(key);
      continue;
    }
    const dH = rect.height - prev.height;
    const dTop = rect.top - prev.top;
    if (Math.abs(dH) > GEOMETRY_JITTER_PX) {
      heightChangers.push({ key, delta: Math.round(dH) });
    } else if (Math.abs(dTop) > GEOMETRY_JITTER_PX) {
      movedOnly.push(key);
    }
  }
  return { heightChangers, movedOnly, inserted, removed };
}

/**
 * Pure: compact per-record strings for the Sentry extra, largest shift first,
 * capped at three. Example: "t=1240 v=0.31 sized:threat-timeline+180 moved:2".
 */
export function formatMoverRecords(records: MoverRecord[]): string[] {
  return [...records]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((r) => {
      const parts = [`t=${r.t} v=${r.value}`];
      if (r.heightChangers.length > 0) {
        // 'sized:' not 'grew:' — the signed delta carries direction, and a
        // shrinking panel that pulled space away is a mover too (review P2).
        parts.push(
          `sized:${r.heightChangers
            .map((c) => `${c.key}${c.delta >= 0 ? '+' : ''}${c.delta}`)
            .join(',')}`,
        );
      }
      if (r.inserted.length > 0) parts.push(`ins:${r.inserted.join(',')}`);
      if (r.removed.length > 0) parts.push(`rem:${r.removed.join(',')}`);
      if (r.movedOnly.length > 0) parts.push(`moved:${r.movedOnly.length}`);
      if ((r.entryCount ?? 1) > 1) parts.push(`n=${r.entryCount}`);
      if (r.coldStart) parts.push('cold');
      return parts.join(' ');
    });
}

let records: MoverRecord[] = [];
let cache: Record<string, PanelRect> | null = null;
let lastRefresh = 0;
let started = false;
let observer: PerformanceObserver | null = null;
let onPageShow: ((event: PageTransitionEvent) => void) | null = null;

function snapshotPanels(): Record<string, PanelRect> | null {
  const grids = ['panelsGrid', 'mapBottomGrid']
    .map((id) => document.getElementById(id))
    .filter((grid): grid is HTMLElement => grid !== null);
  if (grids.length === 0) return null;
  const out: Record<string, PanelRect> = {};
  for (const grid of grids) {
    for (const el of grid.querySelectorAll<HTMLElement>(':scope > [data-panel], :scope > [data-cls-mover]')) {
      const key = el.dataset.panel ?? el.dataset.clsMover;
      if (!key) continue;
      const rect = el.getBoundingClientRect();
      out[key] = { top: Math.round(rect.top + window.scrollY), height: Math.round(rect.height) };
    }
  }
  return out;
}

function resetMoverState(): void {
  records = [];
  cache = snapshotPanels();
  lastRefresh = cache ? performance.now() : 0;
}

/** Records captured at shift time, for the CLS report to attach at hide time. */
export function getMoverRecordStrings(): string[] {
  return formatMoverRecords(records);
}

/** Test hook: reset module state. */
export function resetClsMoverTrackingForTesting(): void {
  observer?.disconnect();
  observer = null;
  if (onPageShow && typeof window !== 'undefined') window.removeEventListener('pageshow', onPageShow);
  onPageShow = null;
  records = [];
  cache = null;
  lastRefresh = 0;
  started = false;
}

/**
 * Start shift-time geometry tracking. Browser-only, idempotent, and inert
 * when PerformanceObserver/layout-shift is unavailable. Reads ~80 panel rects
 * per qualifying shift — the observer callback runs after layout, so the
 * reads are clean; refreshes between recorded shifts are rate-limited.
 */
export function startClsMoverTracking(): void {
  if (started || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  started = true;
  resetMoverState();
  try {
    observer = new PerformanceObserver((list) => {
      const entries = list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>;
      if (entries.length === 0) return;
      const now = performance.now();

      // Callback-time geometry cannot be separated when input and non-input
      // entries are delivered together. Refresh the baseline once and skip
      // attribution rather than charging input-driven movement to a later CLS.
      if (entries.some((entry) => entry.hadRecentInput)) {
        const current = snapshotPanels();
        if (current) {
          cache = current;
          lastRefresh = now;
        }
        return;
      }

      const value = entries.reduce((sum, entry) => sum + entry.value, 0);
      const latest = entries[entries.length - 1]!;
      if (value >= RECORD_SHIFT_THRESHOLD) {
        const current = snapshotPanels();
        if (!current) return;
        const roundedValue = Math.round(value * 1000) / 1000;
        const entryCount = entries.length > 1 ? entries.length : undefined;
        if (!cache) {
          records.push({
            t: Math.round(latest.startTime), value: roundedValue, entryCount,
            heightChangers: [], movedOnly: [], inserted: [], removed: [],
            coldStart: true,
          });
        } else {
          const diff = diffPanelGeometry(cache, current);
          if (diff.heightChangers.length > 0 || diff.inserted.length > 0 || diff.removed.length > 0 || diff.movedOnly.length > 0) {
            records.push({ t: Math.round(latest.startTime), value: roundedValue, entryCount, ...diff });
          }
        }
        if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
        cache = current;
        lastRefresh = now;
      } else if (now - lastRefresh > CACHE_REFRESH_MIN_MS) {
        const current = snapshotPanels();
        if (current) {
          cache = current;
          lastRefresh = now;
        }
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });
    onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) resetMoverState();
    };
    window.addEventListener('pageshow', onPageShow);
  } catch {
    /* layout-shift unsupported (Safari/Firefox) — CLS reporting is Chromium-sourced anyway. */
  }
}
