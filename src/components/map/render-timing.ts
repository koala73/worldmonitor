/**
 * DEV-only render-frame timing attribution for DeckGLMap (#4558 / #4537).
 *
 * Pure, dependency-free so it is unit-testable under `tsx --test` without a
 * DOM/WebGL context. `DeckGLMap.updateLayers()` feeds it the measured parts of a
 * render frame; `summarizeRenderTiming` splits the cost into the JS-build bucket
 * (our `buildLayers()` — layer construction + any Supercluster index rebuild that
 * fires inside it) vs the deck.gl commit bucket (tessellation + attribute
 * generation inside `setProps`). That distinction is the core #4558 question: is
 * a slow frame our synchronous JS or deck.gl's intrinsic tessellation?
 */

/** The 16ms single-frame budget the existing DEV warning checks against. */
export const FRAME_BUDGET_MS = 16;

export interface RenderTimingParts {
  /** Total wall-clock for the render frame (performance.now delta). */
  total: number;
  /** Time spent in `buildLayers()` (layer construction + in-build Supercluster rebuilds). */
  jsBuild?: number;
  /** Number of deck.gl layers committed this frame. */
  layerCount?: number;
  /** Heavy layers whose data changed this frame (e.g. conflict-zones, clusters). */
  changedHeavyLayers?: string[];
}

export interface RenderTimingSummary {
  total: number;
  /** Our synchronous JS cost (`buildLayers`). */
  jsBuild: number;
  /** Remainder attributed to the deck.gl commit (tessellation + attributes). */
  deckCommit: number;
  layerCount: number;
  changedHeavyLayers: string[];
  /** True when the frame exceeded the single-frame budget. */
  overBudget: boolean;
}

const clampNonNegative = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * Split a measured render frame into attributable buckets. `deckCommit` is the
 * remainder after the JS build, floored at 0 so a noisy measurement (build
 * slightly exceeding total) never reports a negative bucket.
 */
export function summarizeRenderTiming(parts: RenderTimingParts): RenderTimingSummary {
  const total = clampNonNegative(parts.total);
  const jsBuild = Math.min(total, clampNonNegative(parts.jsBuild));
  return {
    total,
    jsBuild,
    deckCommit: Math.max(0, total - jsBuild),
    layerCount: clampNonNegative(parts.layerCount),
    changedHeavyLayers: parts.changedHeavyLayers ? [...parts.changedHeavyLayers] : [],
    overBudget: total > FRAME_BUDGET_MS,
  };
}

/** Compact one-line DEV log string for a slow frame. */
export function formatRenderTiming(summary: RenderTimingSummary): string {
  const heavy = summary.changedHeavyLayers.length
    ? ` changed=[${summary.changedHeavyLayers.join(',')}]`
    : '';
  return (
    `[DeckGLMap] render ${summary.total.toFixed(1)}ms ` +
    `(jsBuild ${summary.jsBuild.toFixed(1)} / ` +
    `deck ${summary.deckCommit.toFixed(1)}) layers=${summary.layerCount}${heavy}`
  );
}
