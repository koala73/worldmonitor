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
 * (`data-panel` → {top, height}) and, on every qualifying layout-shift entry,
 * diffs the current geometry against the cache: a panel whose HEIGHT changed
 * is a mover; a panel whose position changed at constant height is a victim;
 * a panel present now but absent from the cache is an insertion (mount-order
 * suspects). The most recent records ride the CLS Sentry report (bad-tail
 * only, same volume policy) as compact strings.
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
}

export interface MoverRecord extends PanelGeometryDiff {
  /** performance.now() of the triggering layout-shift entry, rounded. */
  t: number;
  /** The layout-shift entry's value. */
  value: number;
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
  return { heightChangers, movedOnly, inserted };
}

/**
 * Pure: compact per-record strings for the Sentry extra, largest shift first,
 * capped at three. Example: "t=1240 v=0.31 grew:threat-timeline+180 moved:2".
 */
export function formatMoverRecords(records: MoverRecord[]): string[] {
  return [...records]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((r) => {
      const parts = [`t=${r.t} v=${r.value}`];
      if (r.heightChangers.length > 0) {
        parts.push(
          `grew:${r.heightChangers
            .map((c) => `${c.key}${c.delta >= 0 ? '+' : ''}${c.delta}`)
            .join(',')}`,
        );
      }
      if (r.inserted.length > 0) parts.push(`ins:${r.inserted.join(',')}`);
      if (r.movedOnly.length > 0) parts.push(`moved:${r.movedOnly.length}`);
      return parts.join(' ');
    });
}

let records: MoverRecord[] = [];
let cache: Record<string, PanelRect> | null = null;
let lastRefresh = 0;
let started = false;

function snapshotPanels(): Record<string, PanelRect> | null {
  const grid = document.getElementById('panelsGrid');
  if (!grid) return null;
  const out: Record<string, PanelRect> = {};
  for (const el of grid.querySelectorAll<HTMLElement>(':scope > [data-panel]')) {
    const key = el.dataset.panel;
    if (!key) continue;
    const rect = el.getBoundingClientRect();
    out[key] = { top: Math.round(rect.top + window.scrollY), height: Math.round(rect.height) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Records captured at shift time, for the CLS report to attach at hide time. */
export function getMoverRecordStrings(): string[] {
  return formatMoverRecords(records);
}

/** Test hook: reset module state. */
export function resetClsMoverTrackingForTesting(): void {
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
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (entry.hadRecentInput) continue;
        const now = performance.now();
        if (entry.value >= RECORD_SHIFT_THRESHOLD && cache) {
          const current = snapshotPanels();
          if (current) {
            const diff = diffPanelGeometry(cache, current);
            if (diff.heightChangers.length > 0 || diff.inserted.length > 0 || diff.movedOnly.length > 0) {
              records.push({ t: Math.round(entry.startTime), value: Math.round(entry.value * 1000) / 1000, ...diff });
              if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
            }
            cache = current;
            lastRefresh = now;
          }
        } else if (now - lastRefresh > CACHE_REFRESH_MIN_MS) {
          const current = snapshotPanels();
          if (current) {
            cache = current;
            lastRefresh = now;
          }
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* layout-shift unsupported (Safari/Firefox) — CLS reporting is Chromium-sourced anyway. */
  }
}
