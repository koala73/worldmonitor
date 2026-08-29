/** Cockpit brackets stay legible without dominating the first-person view. */
export const COCKPIT_BRACKET_OPACITY = 0.45;

/**
 * Resolve the bracket-only opacity multiplier for the current presentation.
 * Detection callouts and user tuning are intentionally unaffected.
 * @param {boolean} cockpitActive - Whether Cockpit view owns the viewport.
 * @returns {number} Bracket stroke opacity multiplier.
 */
export function detectionBracketOpacity(cockpitActive) {
  return cockpitActive === true ? COCKPIT_BRACKET_OPACITY : 1;
}

