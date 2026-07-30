/**
 * Globe marker-load probe for field INP attribution (#5368).
 *
 * The 3D globe renders every marker as a DOM node (globe.gl `htmlElementsData`),
 * and three's CSS2DRenderer rewrites `display`, `transform` and `zIndex` on each
 * of them on every animation frame — so interaction cost scales with the marker
 * count. A lab census can measure the counts on ONE machine; it cannot tell us
 * the distribution real users carry, and globe mode is opt-in, so that
 * population is self-selected. Field INP regressed hardest on mobile, where the
 * lab default view is smallest — a contradiction only field data can settle.
 *
 * So GlobeMap publishes its marker load here, and `inp-report` attaches it to
 * the INP events it already sends. Same play as the #5336 CLS mover tracker:
 * instrument cheaply, let RUM name the mover, then fix what it points at.
 *
 * Deliberately a plain module-level snapshot rather than another
 * PerformanceObserver: the INP pipeline already samples, trims the good tail,
 * and survives Sentry's deferred init, and an observer of our own would attach
 * globe state to page-wide interactions the globe never handled.
 */

export interface GlobeMarkerLoad {
  /** HTML markers handed to globe.gl on the last flush. */
  rendered: number;
  /** Layers the budget is withholding markers from, `layer: shown/total`. */
  truncated: Record<string, { shown: number; total: number }>;
  /** How many layers are switched on. */
  activeLayerCount: number;
  /**
   * Which budget the globe applied. Reported explicitly because it does NOT
   * track the INP event's own `formFactor`: the budget splits at the app's
   * 768px layout breakpoint, while `getWebVitalsFormFactor` calls anything
   * coarse-pointer or <=1024px "mobile". A 900px tablet is therefore a mobile
   * form factor running the desktop budget, and a join that assumed otherwise
   * would mis-attribute it.
   */
  budgetProfile: 'mobile' | 'desktop';
}

let current: GlobeMarkerLoad | null = null;

/** Called by GlobeMap on every marker flush; pass `null` when the globe unmounts. */
export function setGlobeMarkerLoad(load: GlobeMarkerLoad | null): void {
  current = load;
}

/** Coarse buckets keep the tag low-cardinality and the distribution readable. */
export function bucketMarkerCount(markers: number): string {
  if (markers <= 200) return '0-200';
  if (markers <= 500) return '201-500';
  if (markers <= 1000) return '501-1000';
  if (markers <= 2000) return '1001-2000';
  return '2000+';
}

/**
 * Compact extras for one INP event, or `null` when the globe is not mounted
 * (the flat map is the default, so most reports carry nothing).
 *
 * Reports the marker load and which layers are being trimmed — the two things
 * that decide globe frame cost. It deliberately does NOT send the user's full
 * enabled-layer list, viewport size, `deviceMemory` or `hardwareConcurrency`:
 * a per-user layer-interest vector plus device dimensions is a fingerprint, and
 * none of it is needed to size a marker budget. `formFactor` on the parent INP
 * event already covers the device split.
 */
export function getGlobeMarkerExtra(
  load: GlobeMarkerLoad | null = current,
): Record<string, unknown> | null {
  if (!load) return null;
  const truncated = Object.entries(load.truncated)
    .map(([layer, counts]) => `${layer}:${counts.shown}/${counts.total}`)
    .sort();
  return {
    globeMarkers: load.rendered,
    globeMarkerBucket: bucketMarkerCount(load.rendered),
    globeActiveLayerCount: load.activeLayerCount,
    globeTruncated: truncated,
    globeBudgetProfile: load.budgetProfile,
  };
}

/** Test hook: reset module state. */
export function resetGlobeMarkerLoadForTesting(): void {
  current = null;
}
