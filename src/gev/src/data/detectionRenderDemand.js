/**
 * Detection's render demand — when the overlay actually needs another frame.
 *
 * Detection used to take an unconditional continuous-render hold for as long as
 * it was on (`holdContinuousRender('detection')`). That was honest when it was
 * written: the overlay repainted from scratch every frame, so "on" really did
 * mean "per-frame work". It stopped being honest once the world-overlay host
 * became demand-driven — `invalidateHost()` already requests a frame on every
 * content change, and Cesium's `requestRenderMode` already renders on camera
 * input and tile loads, so a parked scene with detection on was paying 60 fps
 * for pixels that do not change.
 *
 * Nobody noticed because detection was OFF by default. Turning it ON by default
 * (2026-08-22) would have shipped that hot loop to every idle first-run tab —
 * defeating the render governor, whose whole reason for existing is the ~60% GPU
 * and ~54% of a core a parked scene used to burn (`src/renderGovernor.js`).
 *
 * So detection no longer holds. It is driven the way the rest of the host is:
 * repaint on CHANGE, and — for work that spans frames — ask for exactly one more
 * frame while that work is outstanding. That is the pattern `drawWorldOverlay`
 * already uses for its own fades, and the same shape as the earthquake-disc fix
 * (static geometry, hold removed) that this follows.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 *
 * Every input below must be able to reach a state where it stops asking. A
 * predicate that can stay true forever is the old hold under another name, and
 * that is the property the unit pins defend hardest.
 *
 * Three kinds of outstanding work qualify, and each terminates:
 *
 *   1. the fade-in when detection (re)activates — a bounded window;
 *   2. label fades, IN as well as out — the arbiter drives every one of them to
 *      a settled alpha;
 *   3. a label solve the frame could not run — the throttle defers it by at most
 *      one interval, a skipped paint by exactly one frame.
 *
 * (2) said "out" only, once. A newly selected label fading IN is `selected`, so
 * counting the fade-OUT tail missed it entirely: on a parked scene a label could
 * be selected and then never painted past its first frame — invisible until some
 * unrelated frame happened along. Fade-in and fade-out are the same animation
 * seen from two ends, with the same termination. Both count.
 *
 * ── ONE CLOCK ────────────────────────────────────────────────────────────────
 *
 * The timestamp is the host frame's own `frame.timestamp` — `performance.now()`,
 * sampled ONCE per frame by `drawWorldOverlay` — and the SAME value must reach
 * both the paint and this policy.
 *
 * Two samples of a clock taken a millisecond apart inside one frame is a real
 * defect, not pedantry: paint at age 219 ms draws alpha 0.99545, and a policy
 * re-sampling at 220 ms answers "done", so the frame that would have painted the
 * settled alpha is never requested and the fade visibly stops a hair short.
 * Sharing one timestamp makes the frame that paints final state the same frame
 * that ends demand, by construction. Monotonicity removes the other half of that
 * defect: a wall clock can jump backwards and leave an elapsed-time test true
 * until it catches up, which is exactly the "asks forever" failure this module
 * exists to prevent.
 *
 * Pure functions + constants so the policy is unit-testable without a viewer or
 * a canvas; detection.js owns the plumbing.
 */

/** Duration of the fade-in when detection (re)activates, in ms. */
export const DETECTION_ENABLE_FADE_MS = 220;

/**
 * Cadence of the scanline's scroll, in ms per 2px step — one frame at 60 fps.
 *
 * Derived rather than written as `16`: a rounded 16 ms is 62.5 Hz, which against
 * a real 60 fps frame clock beats slowly and repeats an offset every few frames
 * instead of alternating. Deriving the cadence from a clock rather than from a
 * frame counter is what lets the animation rest without a render hold.
 */
export const SCANLINE_STEP_MS = 1000 / 60;

/** Scanline pattern period in px — the offset walks 0, 2, 0, 2, … */
export const SCANLINE_PERIOD_PX = 4;

/**
 * Scanline scroll offset for a monotonic frame timestamp.
 *
 * @param {number} nowMs - Frame timestamp in ms (`performance.now()`).
 * @returns {number} Vertical offset in px, within [0, SCANLINE_PERIOD_PX).
 */
export function scanlineOffsetPx(nowMs) {
  if (!Number.isFinite(nowMs)) return 0;
  return (Math.floor(nowMs / SCANLINE_STEP_MS) * 2) % SCANLINE_PERIOD_PX;
}

/**
 * Whether detection still has work spanning frames, and therefore needs one more
 * frame after the one it just painted.
 *
 * Returns false for everything change-driven: those paths already request their
 * own frame through `invalidateHost()`, and asking here as well would turn a
 * bounded chain into a permanent one.
 *
 * @param {object} input
 * @param {boolean} input.active - Detection is on and not suspended.
 * @param {number} input.nowMs - The frame's monotonic timestamp (see header).
 * @param {number} input.enabledAtMs - When detection last (re)activated, same clock.
 * @param {number} [input.fadeMs] - Enable fade-in duration.
 * @param {number} [input.animatingLabelCount] - Labels mid-fade, IN or out.
 * @param {boolean} [input.solvePending] - A label solve is owed but did not run.
 * @returns {boolean} True when one more frame is owed.
 */
export function detectionNeedsFollowUpFrame({
  active,
  nowMs,
  enabledAtMs,
  fadeMs = DETECTION_ENABLE_FADE_MS,
  animatingLabelCount = 0,
  solvePending = false,
} = {}) {
  if (!active) return false;
  if (Number(animatingLabelCount) > 0) return true;
  if (solvePending === true) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(enabledAtMs)) return false;
  const age = nowMs - enabledAtMs;
  // `age >= 0` is the fail-toward-idle guard. It cannot trip on the monotonic
  // clock this is fed, but if a caller ever mixes clocks the wrong answer must
  // be "stop asking", never "keep asking until time catches up".
  return age >= 0 && age < fadeMs;
}

/**
 * Paint cost above which the relief valve may skip alternate detection paints.
 * Unchanged from when the valve was introduced; only its demand accounting moved.
 */
export const DETECTION_PAINT_SKIP_THRESHOLD_MS = 22;

/**
 * The pathological-load relief valve: may this frame's detection paint be
 * skipped, and if so, what does the skip owe?
 *
 * Extracted as a pure decision because the answer has two halves that MUST stay
 * welded together. Under the old continuous hold a skip cost nothing — the next
 * frame was guaranteed — so the valve could simply return false and forget. With
 * no hold, the frame it declines may be the only one anybody asked for, and a
 * skip that forgets strands whatever requested it: a reactivation, a new label,
 * a fresh solve. Skipping is a DEFERRAL, never a cancellation.
 *
 * `requestFollowUp` is therefore exactly `skip`, and that equality is the
 * invariant worth pinning — a wrapper cannot skip without re-requesting, because
 * the same decision produces both.
 *
 * @param {object} input
 * @param {boolean} input.layoutChanged - The host's layout revision moved this frame.
 * @param {number} input.lastPaintMs - Cost of the previous detection paint.
 * @param {number} input.frameCount - Monotonic detection frame counter.
 * @param {number} [input.thresholdMs]
 * @returns {{skip: boolean, requestFollowUp: boolean}}
 */
export function detectionPaintSkipDecision({
  layoutChanged,
  lastPaintMs,
  frameCount,
  thresholdMs = DETECTION_PAINT_SKIP_THRESHOLD_MS,
} = {}) {
  const skip = !layoutChanged
    && Number(lastPaintMs) > thresholdMs
    && Number(frameCount) % 2 !== 0;
  return { skip, requestFollowUp: skip };
}

/**
 * Whether a rendered label row's alpha will still change on a later frame.
 *
 * A `selected` row is still climbing while its alpha is below 1. An unselected
 * row only survives the arbiter's render pass while its exit tail is above 0, so
 * any that reaches here is by definition still moving. Stateless rows have hard
 * cliffs (exactly 1, or gone) and never animate.
 *
 * @param {{selected?: boolean, temporalAlpha?: number}} entry - Arbiter render row.
 * @returns {boolean}
 */
export function renderEntryIsAnimating(entry) {
  if (!entry) return false;
  if (!entry.selected) return true;
  return Number(entry.temporalAlpha) < 1;
}

/**
 * Count rendered rows whose alpha is still moving, in either direction.
 * @param {Array<{selected?: boolean, temporalAlpha?: number}>} renderEntries
 * @returns {number}
 */
export function countAnimatingRenderEntries(renderEntries) {
  let count = 0;
  for (let i = 0; i < renderEntries.length; i++) {
    if (renderEntryIsAnimating(renderEntries[i])) count++;
  }
  return count;
}
