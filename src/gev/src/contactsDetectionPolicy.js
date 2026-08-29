// src/contactsDetectionPolicy.js — Contacts-scoped detection policy.
//
// Field test 2026-08-18: "when you click on Contacts, detections should just
// turn on, and they should stay on in Cockpit or in third-person tracking inside
// Contacts or inside Cockpit, both… when I leave the Cockpit, detections go off"
// — that last part being the bug.
//
// The scope is CONTACTS, not Cockpit. Three rules follow:
//
//  1. ACTIVATING Contacts turns detection on at the tactical preset the military
//     styles use. The session-wide `_detectionUserOverridden` flag gates the map
//     STYLE presets only (an explicit Sparse/Off must survive a style switch)
//     and is deliberately NOT consulted here — Contacts is a mode you enter, not
//     a preset that fires behind your back.
//  2. Detection then STAYS on for the whole Contacts session. Cockpit enter and
//     exit, and third-person tracking, do not touch it at all — they are moves
//     WITHIN Contacts, and an earlier build that captured/restored around
//     cockpit is exactly what turned detections off on cockpit exit.
//  3. Whatever the operator does next INSIDE the session stands. Detection is
//     never re-forced while Contacts stays active, so a manual DETECT-off holds
//     until the next activation.
//
// Deactivating Contacts restores the pre-Contacts state, mirroring the
// established `_cockpitVisionRestore` pattern in ui.js: a mode's look is scoped
// to that mode and never leaks out.

/**
 * Normalize a detection state snapshot.
 *
 * The snapshot must cover EVERYTHING activation mutates, not just the mode.
 * Activation applies the tactical preset, which writes density as well — so a
 * mode-only snapshot restored OFF @ 25% as OFF @ 75%, and the operator's next
 * manual enable came back Dense instead of the Sparse they had been using.
 * @param {?{mode?: string, densityPct?: number}} state
 * @returns {{mode: string, densityPct: ?number}}
 */
function normalizeDetectionState(state) {
  const densityPct = Number(state?.densityPct);
  return {
    mode: String(state?.mode || 'OFF').toUpperCase(),
    densityPct: Number.isFinite(densityPct) ? densityPct : null,
  };
}

/**
 * Plan the detection change for a Contacts ACTIVATION.
 * @param {?{mode: string, densityPct: ?number}} current Detection state right now.
 * @param {?{mode: string, densityPct: ?number}} restore Saved pre-Contacts state,
 *   if the session already owns it.
 * @returns {?{restore: {mode: string, densityPct: ?number}, turnOn: boolean}} Null
 *   while Contacts is already active (re-entrancy: every context-mode sync
 *   re-runs this hook).
 */
export function contactsDetectionEnterPlan(current, restore) {
  if (restore) return null;
  const state = normalizeDetectionState(current);
  return { restore: state, turnOn: state.mode === 'OFF' };
}

/**
 * Plan the detection change for a Contacts DEACTIVATION.
 *
 * The entry snapshot is NOT replayed blindly. A map STYLE chosen during the
 * session carries its own detection preset for the world outside Contacts (the
 * military styles auto-enable Panoptic), and that rule is younger than the
 * snapshot: replaying an entry-time OFF over it would defeat the style the
 * operator just picked. The snapshot only wins when no style auto-enable rule
 * applies on the way out.
 *
 * @param {?{mode: string, densityPct: ?number}} restore Saved pre-Contacts state.
 * @param {?{mode: string, densityPct: ?number}} current Detection state right now.
 * @param {boolean} [styleOwnsDetection] Whether the CURRENT map style's
 *   detection preset would apply outside Contacts (i.e. the style has one and
 *   the operator has not overridden detection this session).
 * @returns {?{mode: string, densityPct: ?number}} State to replay, or null when
 *   there is nothing to do.
 */
export function contactsDetectionExitPlan(restore, current, styleOwnsDetection = false) {
  if (!restore || styleOwnsDetection) return null;
  const saved = normalizeDetectionState(restore);
  const now = normalizeDetectionState(current);
  if (saved.mode === now.mode && saved.densityPct === now.densityPct) return null;
  return saved;
}

/**
 * Run one Contacts activation/deactivation transition against a detection engine.
 *
 * The engine is injected so this is the SAME code the UI runs and the tests
 * exercise, driven against the real `src/data/detection.js` in both. Turning on
 * applies the TACTICAL PRESET the military styles use — field test: "I want
 * that as the default. It should just happen" — rather than restoring whatever
 * profile the operator last left detection at.
 *
 * @param {object} input
 * @param {boolean} input.active Whether Contacts is now active.
 * @param {?{mode: string, densityPct: ?number}} input.restore Saved pre-Contacts state.
 * @param {() => {mode: string, densityPct: ?number}} input.getState Reads the
 *   engine's full restorable detection state.
 * @param {() => void} input.applyPreset Applies the tactical detection preset.
 * @param {(state: {mode: string, densityPct: ?number}) => void} input.restoreState
 *   Replays a saved state.
 * @param {boolean} [input.styleOwnsDetection] See contactsDetectionExitPlan.
 * @returns {{restore: ?{mode: string, densityPct: ?number}, changed: boolean}} New
 *   saved state, and whether the engine was touched (so the caller can skip
 *   redundant UI syncs).
 */
export function applyContactsDetection({
  active,
  restore,
  getState,
  applyPreset,
  restoreState,
  styleOwnsDetection = false,
}) {
  if (active) {
    const plan = contactsDetectionEnterPlan(getState(), restore);
    if (!plan) return { restore, changed: false };
    if (plan.turnOn) applyPreset();
    return { restore: plan.restore, changed: plan.turnOn };
  }
  const plan = contactsDetectionExitPlan(restore, getState(), styleOwnsDetection);
  if (plan) restoreState(plan);
  return { restore: null, changed: Boolean(plan) };
}

/**
 * Detection as a DURABLE preference, for serialization into a share link.
 *
 * While Contacts is active it OWNS detection and forces the tactical preset
 * (Dense @ 75%). That is a session-scoped override, not an operator choice: it
 * is undone verbatim on deactivation. Serializing the FORCED values shipped a
 * link that pinned Dense @ 75% on the recipient as a durable preference, with
 * no Contacts mode present to explain or undo it, even when the author's own
 * setting was OFF @ 50%. Publish what deactivation would restore instead.
 *
 * @param {object} input
 * @param {?{mode: string, densityPct: ?number}} input.owned Saved pre-Contacts
 *   state; null whenever Contacts does not own detection.
 * @param {string} input.liveMode Current engine detection mode.
 * @param {number} input.liveDensityPct Current density percent.
 * @returns {{mode: string, densityPct: number}} Values safe to serialize.
 */
export function shareableDetectionState({ owned, liveMode, liveDensityPct }) {
  if (!owned) return { mode: liveMode, densityPct: liveDensityPct };
  return {
    mode: owned.mode ?? liveMode,
    densityPct: Number.isFinite(owned.densityPct) ? owned.densityPct : liveDensityPct,
  };
}

/**
 * Whether the cached share state must be re-published after a Contacts
 * transition.
 *
 * Serialization is ownership-dependent: while Contacts owns detection the link
 * carries the SAVED snapshot, and once ownership is released it carries live
 * state. So the cache goes stale on any ownership transition, whether or not
 * the detection engine itself moved — and it does not always move. Exiting
 * while a military style owns detection produces `changed: false` (that style's
 * preset already matches what is on screen), which previously returned early
 * and left a copied link advertising the operator's pre-Contacts values while
 * the map showed Dense @ 75%.
 *
 * @param {object} input
 * @param {boolean} input.changed Whether the detection engine was touched.
 * @param {boolean} input.hadOwnership Contacts owned detection before.
 * @param {boolean} input.hasOwnership Contacts owns detection now.
 * @returns {boolean} True when the share cache must be re-synced.
 */
export function shareCacheNeedsHeal({ changed, hadOwnership, hasOwnership }) {
  return Boolean(changed) || Boolean(hadOwnership) !== Boolean(hasOwnership);
}
