/**
 * Fits expanded panels into a shared vertical corridor. Natural heights are
 * retained when they fit; constrained panels keep a usable floor and share
 * the remaining room in proportion to their unmet height.
 *
 * @param {object} input Layout measurements.
 * @param {number[]} input.naturalHeights Expanded-panel natural heights.
 * @param {number} input.availableHeight Height available to expanded panels.
 * @param {number} [input.minimumHeight=96] Preferred usable floor per panel.
 * @returns {number[]} One allocated height per expanded panel.
 */
export function allocatePanelStackHeights({
  naturalHeights,
  availableHeight,
  minimumHeight = 96,
}) {
  const natural = naturalHeights.map((height) => Math.max(0, Number(height) || 0));
  if (!natural.length) return [];

  const available = Math.max(0, Number(availableHeight) || 0);
  const naturalTotal = natural.reduce((sum, height) => sum + height, 0);
  if (naturalTotal <= available) return natural;
  if (available === 0) return natural.map(() => 0);

  const preferredFloor = Math.max(0, Number(minimumHeight) || 0);
  const base = natural.map((height) => Math.min(height, preferredFloor));
  const baseTotal = base.reduce((sum, height) => sum + height, 0);
  if (baseTotal >= available) {
    const scale = baseTotal > 0 ? available / baseTotal : 0;
    return base.map((height) => height * scale);
  }

  const remaining = available - baseTotal;
  const unmet = natural.map((height, index) => Math.max(0, height - base[index]));
  const unmetTotal = unmet.reduce((sum, height) => sum + height, 0);
  if (unmetTotal <= 0) return base;
  return base.map((height, index) => height + remaining * (unmet[index] / unmetTotal));
}

/**
 * Solves the accordion corridor's bottom boundary against the obstacles that
 * still limit it.
 *
 * Every painted obstacle limits the corridor. This includes Cockpit CONTACT
 * and peripheral HUD surfaces, so reopening a map panel cannot cover them.
 *
 * @param {object} input Corridor measurements.
 * @param {number} input.baseBottom Viewport-inset bottom boundary, in px.
 * @param {Array<{top: number}>} [input.obstacles] Live obstacle tops.
 * @param {number} [input.safeGap=0] Clearance kept above each obstacle, in px.
 * @returns {number} Bottom boundary in px.
 */
export function resolveLeftStackBottomBoundary({
  baseBottom,
  obstacles = [],
  safeGap = 0,
}) {
  let bottom = Number(baseBottom) || 0;
  const gap = Number(safeGap) || 0;
  for (const obstacle of obstacles) {
    const top = Number(obstacle?.top);
    if (!Number.isFinite(top)) continue;
    bottom = Math.min(bottom, top - gap);
  }
  return bottom;
}

/**
 * Returns later expanded panels whose allocation would expose less than the
 * requested share of their intrinsic height. The first panel always remains
 * expanded so every lane keeps one useful primary surface.
 *
 * @param {object} input Panel height measurements.
 * @param {number[]} input.naturalHeights Intrinsic expanded heights.
 * @param {number[]} input.allocatedHeights Allocated expanded heights.
 * @param {number} [input.minimumVisibleRatio=0.5] Minimum useful height share.
 * @param {boolean} [input.collapseLaterPanels=false] Collapse every competitor after the primary panel.
 * @returns {number[]} Candidate indices to present as collapsed controls.
 */
export function panelStackAutoCollapseIndices({
  naturalHeights,
  allocatedHeights,
  minimumVisibleRatio = 0.5,
  collapseLaterPanels = false,
}) {
  const threshold = Math.max(0, Number(minimumVisibleRatio) || 0);
  const collapsed = [];
  for (let index = 1; index < naturalHeights.length; index += 1) {
    if (collapseLaterPanels) {
      collapsed.push(index);
      continue;
    }
    const natural = Math.max(0, Number(naturalHeights[index]) || 0);
    const allocated = Math.max(0, Number(allocatedHeights[index]) || 0);
    if (natural > 0 && allocated / natural < threshold) collapsed.push(index);
  }
  return collapsed;
}

/**
 * Balance a desktop panel corridor around the viewport midpoint without
 * crossing its measured obstacle boundaries. If centering would shrink the
 * lane below its usable minimum, retain the original aligned corridor.
 *
 * @param {object} input Corridor measurements.
 * @param {number} input.viewportHeight Current viewport height.
 * @param {number} input.safeTop Proposed corridor top.
 * @param {number} input.safeBottom Proposed corridor bottom.
 * @param {number} input.obstacleSafeTop Highest obstacle-safe top boundary.
 * @param {number} input.obstacleSafeBottom Lowest obstacle-safe bottom boundary.
 * @param {number} input.minimumHeight Minimum useful lane height.
 * @returns {{ safeTop: number, safeBottom: number }} Bounded corridor.
 */
export function resolvePanelStackCorridor({
  viewportHeight,
  safeTop,
  safeBottom,
  obstacleSafeTop,
  obstacleSafeBottom,
  minimumHeight,
}) {
  const height = Math.max(1, Number(viewportHeight) || 1);
  const boundaryTop = Math.max(0, Number(obstacleSafeTop) || 0);
  const boundaryBottom = Math.max(
    boundaryTop,
    Math.min(height, Number(obstacleSafeBottom) || 0),
  );
  let top = Math.max(boundaryTop, Math.min(boundaryBottom, Number(safeTop) || 0));
  let bottom = Math.max(top, Math.min(boundaryBottom, Number(safeBottom) || 0));
  const minimum = Math.max(0, Number(minimumHeight) || 0);
  const midpoint = height * 0.5;

  if (top < midpoint && bottom > midpoint) {
    const centeredHalfHeight = Math.min(midpoint - top, bottom - midpoint);
    const centeredTop = midpoint - centeredHalfHeight;
    const centeredBottom = midpoint + centeredHalfHeight;
    if (centeredBottom - centeredTop >= minimum) {
      top = centeredTop;
      bottom = centeredBottom;
    }
  }

  if (bottom - top < minimum) {
    top = Math.max(boundaryTop, bottom - minimum);
    bottom = Math.min(boundaryBottom, Math.max(bottom, top + minimum));
  }

  return { safeTop: top, safeBottom: bottom };
}
