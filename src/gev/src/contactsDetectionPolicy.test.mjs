// Contacts-scoped detection (field test 2026-08-18: "when you click on
// Contacts, detections should just turn on, and they should stay on in Cockpit
// or in third-person tracking inside Contacts").
//
// These drive the REAL detection engine (src/data/detection.js) through the
// REAL transition function ui.js calls — no stand-in for the engine. The one
// thing a Node test cannot boot is the context-mode transaction itself (Cesium
// plus the data-manager intent lanes); that wiring is pinned by source
// assertions here and driven for real in scripts/qa-cockpit-utility.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyContactsDetection,
  contactsDetectionEnterPlan,
  contactsDetectionExitPlan,
  shareCacheNeedsHeal,
  shareableDetectionState,
} from './contactsDetectionPolicy.js';
import {
  cycleMode as cycleDetectionMode,
  getDetectionTuning,
  getMode as getDetectionMode,
  setDetectionTuning,
  setMode as setDetectionModeByLabel,
} from './data/detection.js';
import { canonicalizeDensity } from './data/detectionPolicy.js';

const uiSource = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

/**
 * The tactical preset ui.js hands Contacts. Read out of the source so this test
 * cannot drift from the numbers the military styles actually apply.
 */
const MILITARY_PRESET = (() => {
  const match = uiSource.match(
    /const MILITARY_DETECTION_PRESET = Object\.freeze\(\{ mode: '(\w+)', densityPct: (\d+) \}\)/,
  );
  assert.ok(match, 'ui.js must expose one shared military detection preset');
  return { mode: match[1].toUpperCase(), densityPct: Number(match[2]) };
})();

/** Engine-level equivalent of ui.js's `_applyDetectionPreset`. */
function applyDetectionState({ mode, densityPct }) {
  if (Number.isFinite(densityPct)) setDetectionTuning({ densityPct: canonicalizeDensity(densityPct) });
  if (mode) setDetectionModeByLabel(String(mode).toUpperCase());
}

const readState = () => ({ mode: getDetectionMode(), densityPct: getDetectionTuning().densityPct });

/** Bind the transition to the real engine, as ui.js does. */
function transition(active, { restore = null, styleOwnsDetection = false } = {}) {
  return applyContactsDetection({
    active,
    restore,
    styleOwnsDetection,
    getState: readState,
    applyPreset: () => applyDetectionState(MILITARY_PRESET),
    restoreState: applyDetectionState,
  });
}

/** Put the real engine in a known starting mode. */
function startAt(mode, densityPct = null) {
  if (Number.isFinite(densityPct)) setDetectionTuning({ densityPct: canonicalizeDensity(densityPct) });
  setDetectionModeByLabel(mode);
  assert.equal(getDetectionMode(), mode, 'engine precondition');
}

test('activating Contacts turns the real detection engine on from OFF', () => {
  startAt('OFF', 50);
  const { restore } = transition(true);
  assert.notEqual(getDetectionMode(), 'OFF');
  assert.deepEqual(restore, { mode: 'OFF', densityPct: 50 });
});

test('the snapshot carries every field activation mutates, not just the mode', () => {
  // Activation writes DENSITY as well as mode; a mode-only snapshot returned
  // OFF @ 25% as OFF @ 75%, so the operator's next manual enable came back
  // Dense instead of the Sparse profile they had been using.
  startAt('OFF', 25);
  const { restore } = transition(true);
  assert.deepEqual(restore, { mode: 'OFF', densityPct: 25 });
  assert.equal(getDetectionTuning().densityPct, MILITARY_PRESET.densityPct, 'activation moved density');

  transition(false, { restore });
  assert.equal(getDetectionMode(), 'OFF');
  assert.equal(getDetectionTuning().densityPct, 25, 'deactivation puts the density back');

  // The pin the user would notice: the next manual enable returns their profile.
  cycleDetectionMode();
  assert.equal(getDetectionMode(), 'SPARSE', 'manual enable returns 25%, not the tactical 75%');
  assert.equal(getDetectionTuning().densityPct, 25);
});

test('a density-only difference is still a restore worth making', () => {
  // Same mode either side, different density: the exit plan must not call it a
  // no-op just because the labels match.
  assert.deepEqual(
    contactsDetectionExitPlan({ mode: 'DENSE', densityPct: 100 }, { mode: 'DENSE', densityPct: 75 }),
    { mode: 'DENSE', densityPct: 100 },
  );
  assert.equal(
    contactsDetectionExitPlan({ mode: 'DENSE', densityPct: 75 }, { mode: 'DENSE', densityPct: 75 }),
    null,
  );
});

test('activating Contacts lands on the tactical preset, not the last profile used', () => {
  // Field test: the Contacts default is the military look, and it "should
  // just happen" — so a SPARSE session does NOT drag SPARSE into Contacts.
  setDetectionTuning({ densityPct: 25 });
  startAt('SPARSE');
  startAt('OFF');
  transition(true);
  assert.equal(getDetectionMode(), MILITARY_PRESET.mode);
  assert.equal(getDetectionTuning().densityPct, MILITARY_PRESET.densityPct);
});

test('the Contacts preset is the very object the military styles apply', () => {
  // Reading the numbers out of ui.js is the point: if a style preset changes,
  // Contacts follows it rather than keeping a stale copy.
  assert.equal(MILITARY_PRESET.mode, 'DENSE');
  assert.equal(MILITARY_PRESET.densityPct, 75);
  const styles = uiSource.match(/detection: MILITARY_DETECTION_PRESET,/g) || [];
  assert.equal(styles.length, 3, 'retro, surveillance and thermal all share the one preset object');
  assert.doesNotMatch(
    uiSource,
    /detection: \{ mode: 'dense'/,
    'no style may keep its own copy of the tactical detection numbers',
  );
  assert.match(
    uiSource,
    /applyPreset: \(\) => this\._applyDetectionPreset\(MILITARY_DETECTION_PRESET\)/,
    'the Contacts force-on must apply that same object',
  );
});

test('the shared preset applier ignores the style override flag — the caller owns it', () => {
  const applier = uiSource.slice(
    uiSource.indexOf('_applyDetectionPreset(det) {'),
    uiSource.indexOf('Applies the global post-processing baseline'),
  );
  assert.ok(applier.length > 0);
  assert.doesNotMatch(applier, /_detectionUserOverridden/);
  // The STYLE path still gates on it; Contacts deliberately does not.
  assert.match(
    uiSource,
    /if \(preset\.detection && !this\._detectionUserOverridden\) \{\s*\n\s*this\._applyDetectionPreset\(preset\.detection\);/,
  );
});

test('activating Contacts leaves an already-on profile untouched', () => {
  startAt('DENSE');
  const { restore, changed } = transition(true);
  assert.equal(getDetectionMode(), 'DENSE');
  assert.equal(changed, false, 'no engine write, so no redundant UI sync');
  assert.deepEqual(restore, { mode: 'DENSE', densityPct: getDetectionTuning().densityPct });
});

test('detection survives cockpit enter and exit inside a Contacts session', () => {
  // The observed bug: "when I leave the Cockpit, detections go off".
  // Cockpit is a move WITHIN Contacts and must not touch detection at all, so
  // the only transitions here are the Contacts ones — repeated syncs while the
  // session stays active.
  startAt('OFF');
  let { restore } = transition(true);
  const insideContacts = getDetectionMode();
  assert.equal(insideContacts, MILITARY_PRESET.mode);

  // Cockpit enter, a vision cycle, third-person tracking, cockpit exit: every
  // one of these re-runs the context-mode sync with Contacts still active.
  for (let sync = 0; sync < 4; sync += 1) {
    ({ restore } = transition(true, { restore }));
    assert.equal(getDetectionMode(), insideContacts, 'a move within Contacts never changes detection');
  }
  assert.deepEqual(restore, { mode: 'OFF', densityPct: restore.densityPct }, 'the entry snapshot is not rewritten');
});

test('a manual detection-off during a Contacts session holds for the session', () => {
  startAt('OFF');
  let { restore } = transition(true);
  assert.notEqual(getDetectionMode(), 'OFF');

  setDetectionModeByLabel('OFF'); // the operator clicks DETECT
  // Entering the cockpit after that must NOT re-force.
  ({ restore } = transition(true, { restore }));
  ({ restore } = transition(true, { restore }));
  assert.equal(getDetectionMode(), 'OFF');
  assert.deepEqual(restore, { mode: 'OFF', densityPct: restore.densityPct }, 'the entry snapshot is not rewritten');
});

test('deactivating Contacts restores the pre-Contacts state in every direction', () => {
  startAt('OFF');
  let { restore } = transition(true);
  ({ restore } = transition(false, { restore }));
  assert.equal(getDetectionMode(), 'OFF', 'a Contacts-forced on reverts on deactivation');
  assert.equal(restore, null);

  startAt('DENSE');
  ({ restore } = transition(true));
  ({ restore } = transition(false, { restore }));
  assert.equal(getDetectionMode(), 'DENSE', 'on stays on when it was on before');

  startAt('DENSE');
  ({ restore } = transition(true));
  setDetectionModeByLabel('OFF');
  transition(false, { restore });
  assert.equal(getDetectionMode(), 'DENSE', 'the Contacts-scoped off does not leak out');
});

test('re-activating Contacts re-enables after a session-scoped off', () => {
  startAt('OFF');
  let { restore } = transition(true);
  setDetectionModeByLabel('OFF');
  ({ restore } = transition(false, { restore }));
  assert.equal(getDetectionMode(), 'OFF');
  transition(true, { restore });
  assert.equal(getDetectionMode(), MILITARY_PRESET.mode);
});

test('a style chosen DURING the session keeps its auto-enable instead of the snapshot', () => {
  // Cross-check that the military-style auto-Panoptic path still composes: the
  // preset is already on, so the style is not fighting Contacts, and on the way
  // out the style rule — younger than the snapshot — wins.
  startAt('OFF');
  const { restore } = transition(true);
  setDetectionModeByLabel('DENSE'); // _applyStylePresetDefaults('surveillance')
  const result = transition(false, { restore, styleOwnsDetection: true });
  assert.equal(getDetectionMode(), 'DENSE');
  assert.equal(result.changed, false, 'the style rule wins, so nothing is replayed');
  assert.equal(result.restore, null);
});

test('an operator who overrode detection still gets the entry snapshot back', () => {
  // styleOwnsDetection is false whenever _detectionUserOverridden is true, so an
  // explicit choice is never overwritten by a style preset.
  startAt('OFF');
  const { restore } = transition(true);
  setDetectionModeByLabel('DENSE');
  transition(false, { restore, styleOwnsDetection: false });
  assert.equal(getDetectionMode(), 'OFF');
});

test('deactivation with no captured Contacts state changes nothing', () => {
  assert.equal(contactsDetectionExitPlan(null, { mode: 'OFF', densityPct: 50 }), null);
  const same = { mode: 'DENSE', densityPct: 75 };
  assert.equal(contactsDetectionExitPlan(same, same), null);
  assert.equal(contactsDetectionExitPlan({ mode: 'OFF', densityPct: 25 }, same, true), null);
  startAt('DENSE');
  const result = transition(false, { restore: null });
  assert.equal(getDetectionMode(), 'DENSE');
  assert.equal(result.changed, false);
});

test('re-entrancy is decided by the saved snapshot, not the engine state', () => {
  assert.equal(
    contactsDetectionEnterPlan({ mode: 'OFF', densityPct: 25 }, { mode: 'DENSE', densityPct: 75 }),
    null,
  );
  assert.deepEqual(
    contactsDetectionEnterPlan({ mode: 'OFF', densityPct: 25 }, null),
    { restore: { mode: 'OFF', densityPct: 25 }, turnOn: true },
  );
  assert.deepEqual(
    contactsDetectionEnterPlan({ mode: 'sparse', densityPct: 25 }, null),
    { restore: { mode: 'SPARSE', densityPct: 25 }, turnOn: false },
  );
  // A missing density is carried as null rather than invented.
  assert.deepEqual(
    contactsDetectionEnterPlan({ mode: 'OFF' }, null),
    { restore: { mode: 'OFF', densityPct: null }, turnOn: true },
  );
});

test('detection is wired to the Contacts transaction, and cockpit no longer touches it', () => {
  // The trigger lives on the context-mode funnel, gated on the transaction
  // having SETTLED so a failed activation cannot strand detection on.
  const helper = uiSource.slice(
    uiSource.indexOf('_syncContactsDetection() {'),
    uiSource.indexOf('/** Apply a temporary cockpit-only'),
  );
  assert.ok(helper.length > 0, 'the Contacts detection helper is present in ui.js');
  assert.match(helper, /if \(this\._contextModeChanging\) return;/, 'fires at settle, not at click');
  assert.match(helper, /active: this\._contextMode === 'flights'/);
  assert.match(helper, /styleOwnsDetection:\s*!this\._detectionUserOverridden/);
  assert.doesNotMatch(
    helper.split('styleOwnsDetection')[0],
    /_detectionUserOverridden/,
    'ACTIVATION turns detection on REGARDLESS of the style-preset override flag',
  );
  assert.match(
    uiSource,
    /this\.cockpitView\?\.syncEntry\(\);[\s\S]{0,220}?this\._syncContactsDetection\(\);/,
    'called from _syncContextModeButtons, the funnel every _contextMode mutation routes through',
  );
  // The cockpit vision hook — the old trigger — must be out of the detection
  // business entirely, or leaving the cockpit turns detections off again.
  const visionHook = uiSource.slice(
    uiSource.indexOf('_setCockpitVision(mode, active, { revealParameters = false } = {}) {'),
    uiSource.indexOf('_syncIrBoost() {'),
  );
  assert.ok(visionHook.length > 0, 'the cockpit vision hook is present in ui.js');
  assert.doesNotMatch(visionHook, /etection/, 'cockpit transitions must not touch detection');
});

// ---------------------------------------------------------------------------
// A link copied while Contacts is active must carry the AUTHOR's preference,
// not the session-scoped override Contacts forces on top of it. Contacts is
// not itself restored by a share link, so a recipient who inherited the forced
// Dense @ 75% had no mode to explain it and no way to undo it.
// ---------------------------------------------------------------------------

test('share serialization publishes the operator preference, not the Contacts override', () => {
  // Contacts inactive: the live values ARE the preference.
  assert.deepEqual(
    shareableDetectionState({ owned: null, liveMode: 'BALANCED', liveDensityPct: 40 }),
    { mode: 'BALANCED', densityPct: 40 },
  );

  // Contacts active: the live values are forced Dense @ 75%, but the author's
  // own OFF @ 50% is what deactivation restores — and what the link must carry.
  assert.deepEqual(
    shareableDetectionState({
      owned: { mode: 'OFF', densityPct: 50 },
      liveMode: 'DENSE',
      liveDensityPct: 75,
    }),
    { mode: 'OFF', densityPct: 50 },
  );

  // A partial snapshot falls back to live values field by field, never to
  // undefined (which would serialize as a malformed dm/dd pair).
  assert.deepEqual(
    shareableDetectionState({
      owned: { mode: 'SPARSE', densityPct: null },
      liveMode: 'DENSE',
      liveDensityPct: 75,
    }),
    { mode: 'SPARSE', densityPct: 75 },
  );
  assert.deepEqual(
    shareableDetectionState({ owned: {}, liveMode: 'DENSE', liveDensityPct: 75 }),
    { mode: 'DENSE', densityPct: 75 },
  );
});

test('the share cache is healed whenever Contacts ownership changes, engine or not', () => {
  // Ordinary case: the engine moved, so the cache is republished.
  assert.equal(
    shareCacheNeedsHeal({ changed: true, hadOwnership: false, hasOwnership: true }),
    true,
  );

  // The regression: exiting Contacts while a MILITARY STYLE owns detection
  // produces changed:false (the style preset already matches what is drawn),
  // but ownership was just released — so serialization flips from the saved
  // snapshot to live state and the cached link is now wrong.
  assert.equal(
    shareCacheNeedsHeal({ changed: false, hadOwnership: true, hasOwnership: false }),
    true,
    'releasing ownership must heal the cache even with no engine change',
  );

  // Symmetric: acquiring ownership with no engine change flips it the other way.
  assert.equal(
    shareCacheNeedsHeal({ changed: false, hadOwnership: false, hasOwnership: true }),
    true,
  );

  // Genuine no-op: nothing moved and ownership is unchanged.
  assert.equal(
    shareCacheNeedsHeal({ changed: false, hadOwnership: false, hasOwnership: false }),
    false,
  );
  assert.equal(
    shareCacheNeedsHeal({ changed: false, hadOwnership: true, hasOwnership: true }),
    false,
  );
});
