// src/data/detectionRenderDemand.test.mjs
//
// Detection must not hold the render loop open — and must not drop work on the
// floor once it stops holding.
//
// It used to take an unconditional continuous-render hold for as long as it was
// on. That was invisible while detection defaulted OFF; turning it ON by default
// (2026-08-22) would have shipped a permanent 60 fps loop to every idle
// first-run tab, defeating the render governor whose entire purpose is that a
// parked scene costs nothing.
//
// Removing a hold moves the burden of proof. Under the hold a frame was always
// coming, so anything could be deferred for free; without it, the frame a piece
// of work was given may be the ONLY one, and whatever consumes that frame
// without finishing the work strands it indefinitely. The first cut of this
// module stranded four different things — a review reproduced all four live on a
// parked scene — so these pins are organized around that failure mode:
//
//   1. POLICY — what counts as outstanding work, and that every kind of it can
//      reach a state where it stops asking. A predicate that can stay true
//      forever is the old hold under another name.
//   2. ANIMATION accounting — fade-IN counts, not only the fade-out tail. A
//      newly selected label is `selected`, so counting only unselected rows left
//      it invisible on a parked scene until some unrelated frame arrived.
//   3. ONE CLOCK — paint and demand read the same per-frame timestamp, so the
//      frame that paints an animation's final state is the frame that ends its
//      demand, and a non-monotonic clock cannot make demand permanent.
//   4. WIRING — the hold is really gone; a skipped paint re-requests instead of
//      swallowing; a layer whose contents changed dirties the solve.
//
// The runtime counterpart — parked scene, detection ON vs OFF, near-zero renders
// either way, and the overlay still painting — is `scripts/qa-perf.mjs` §1b.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DETECTION_ENABLE_FADE_MS,
  DETECTION_PAINT_SKIP_THRESHOLD_MS,
  SCANLINE_PERIOD_PX,
  SCANLINE_STEP_MS,
  countAnimatingRenderEntries,
  detectionNeedsFollowUpFrame,
  detectionPaintSkipDecision,
  renderEntryIsAnimating,
  scanlineOffsetPx,
} from './detectionRenderDemand.js';

// ---------------------------------------------------------------------------
// 1. Policy — outstanding work, and that all of it terminates
// ---------------------------------------------------------------------------

test('a follow-up frame is owed only while work spans frames', () => {
  const base = { active: true, enabledAtMs: 1_000, fadeMs: DETECTION_ENABLE_FADE_MS };

  // Enable fade-in: open during the window, closed at and after its end. The
  // boundary IS the termination condition — at exactly `fadeMs` the fade has
  // landed on its final alpha, and asking for a frame to repaint an unchanged
  // pixel is the off-by-one that never lets the chain stop.
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 1_000 }), true);
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 1_000 + DETECTION_ENABLE_FADE_MS - 1 }), true);
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 1_000 + DETECTION_ENABLE_FADE_MS }), false,
    'the chain must terminate exactly when the fade lands');
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 9_999_999 }), false);

  // Labels mid-fade, in EITHER direction, owe a frame regardless of how long
  // detection has been on.
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 9_999_999, animatingLabelCount: 3 }), true);
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 9_999_999, animatingLabelCount: 0 }), false);

  // A solve the frame could not run is outstanding work too: the frame that
  // carried its request cannot be the last one.
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 9_999_999, solvePending: true }), true);
  assert.equal(detectionNeedsFollowUpFrame({ ...base, nowMs: 9_999_999, solvePending: false }), false);
});

test('nothing is owed while detection is off or suspended — that is the whole point', () => {
  for (const extra of [{}, { animatingLabelCount: 5 }, { solvePending: true }]) {
    assert.equal(
      detectionNeedsFollowUpFrame({ active: false, nowMs: 1_000, enabledAtMs: 1_000, ...extra }),
      false,
      'an inactive overlay must never keep the scene awake',
    );
  }
});

test('a broken or backward clock terminates demand instead of extending it', () => {
  // The failure mode that matters is the one that keeps rendering, so it is the
  // one pinned. A non-finite timestamp reads as "no animation".
  for (const nowMs of [undefined, null, NaN, Infinity]) {
    assert.equal(detectionNeedsFollowUpFrame({ active: true, nowMs, enabledAtMs: 0 }), false);
  }
  for (const enabledAtMs of [undefined, null, NaN, Infinity]) {
    assert.equal(detectionNeedsFollowUpFrame({ active: true, nowMs: 1_000, enabledAtMs }), false);
  }
  assert.equal(detectionNeedsFollowUpFrame(), false, 'no argument at all is still not an animation');

  // And a timestamp BEHIND the enable stamp — impossible on the monotonic clock
  // this is fed, but the answer must be "stop", not "ask until time catches up",
  // which is what a wall-clock jump used to produce.
  assert.equal(
    detectionNeedsFollowUpFrame({ active: true, nowMs: 500, enabledAtMs: 1_000 }),
    false,
    'a backward clock must fail toward idle',
  );
  assert.equal(
    detectionNeedsFollowUpFrame({ active: true, nowMs: -5_000, enabledAtMs: 1_000 }),
    false,
  );
});

// ---------------------------------------------------------------------------
// 2. Animation accounting — fade-IN is an animation too
// ---------------------------------------------------------------------------

test('a label fading IN is animating, not just one fading out', () => {
  // The regression this pins: counting only the fade-out tail (`!selected`) meant
  // a freshly selected label registered no demand at all. On a parked scene it
  // was painted once at a partial alpha and then left invisible until some
  // unrelated frame happened along.
  assert.equal(renderEntryIsAnimating({ selected: true, temporalAlpha: 0.01 }), true,
    'a label that has just been selected is still climbing');
  assert.equal(renderEntryIsAnimating({ selected: true, temporalAlpha: 0.5 }), true);
  assert.equal(renderEntryIsAnimating({ selected: true, temporalAlpha: 1 }), false,
    'a settled label is done — otherwise every visible label would demand frames forever');

  // Unselected rows only survive the arbiter's render pass while their exit tail
  // is above zero, so any that reaches here is still moving.
  assert.equal(renderEntryIsAnimating({ selected: false, temporalAlpha: 1 }), true);
  assert.equal(renderEntryIsAnimating({ selected: false, temporalAlpha: 0.2 }), true);

  assert.equal(renderEntryIsAnimating(null), false);
  assert.equal(renderEntryIsAnimating(undefined), false);

  assert.equal(countAnimatingRenderEntries([]), 0);
  assert.equal(countAnimatingRenderEntries([
    { selected: true, temporalAlpha: 1 },      // settled — no demand
    { selected: true, temporalAlpha: 0.4 },    // fading IN
    { selected: false, temporalAlpha: 0.7 },   // fading out
    { selected: true, temporalAlpha: 1 },      // settled
  ]), 2);

  // A screen full of settled labels must demand nothing — this is the property
  // that keeps a parked scene at zero renders.
  const settled = Array.from({ length: 40 }, () => ({ selected: true, temporalAlpha: 1 }));
  assert.equal(countAnimatingRenderEntries(settled), 0);
});

// ---------------------------------------------------------------------------
// 2b. The relief valve defers, it never cancels
// ---------------------------------------------------------------------------

test('a skipped paint always hands its frame forward — skip and re-request are one decision', () => {
  // The regression this pins: under the old continuous hold a skipped paint cost
  // nothing, because the next frame was guaranteed. With no hold, the frame the
  // valve declines may be the ONLY one anybody requested — a reactivation, a new
  // label, a fresh solve — and swallowing it strands that work indefinitely.
  //
  // These drive the REAL decision the production valve calls, not a description
  // of it: the earlier version of this check hand-fed frames to a stub, which is
  // exactly how the defect survived review.
  const heavy = DETECTION_PAINT_SKIP_THRESHOLD_MS + 13; // a 35 ms paint

  // The one case that skips: expensive previous paint, odd frame, stable layout.
  const skipped = detectionPaintSkipDecision({ layoutChanged: false, lastPaintMs: heavy, frameCount: 1 });
  assert.deepEqual(skipped, { skip: true, requestFollowUp: true },
    'a skip must carry its own follow-up request');

  // Every other case paints, and a paint needs no deferral.
  for (const input of [
    { layoutChanged: true, lastPaintMs: heavy, frameCount: 1 },   // layout moved — never skip
    { layoutChanged: false, lastPaintMs: heavy, frameCount: 2 },  // even frame — the valve's duty cycle
    { layoutChanged: false, lastPaintMs: 1, frameCount: 1 },      // cheap paint — no relief needed
    { layoutChanged: false, lastPaintMs: DETECTION_PAINT_SKIP_THRESHOLD_MS, frameCount: 1 }, // at the threshold, not past it
  ]) {
    assert.deepEqual(detectionPaintSkipDecision(input), { skip: false, requestFollowUp: false },
      `expected a paint for ${JSON.stringify(input)}`);
  }

  // The invariant, stated as one law over the whole input space: the valve can
  // never skip without re-requesting. A wrapper cannot break this, because both
  // halves come from the same decision.
  for (const layoutChanged of [true, false]) {
    for (const lastPaintMs of [0, 1, 22, 23, 35, 500, NaN]) {
      for (const frameCount of [0, 1, 2, 3, 41, 100]) {
        const d = detectionPaintSkipDecision({ layoutChanged, lastPaintMs, frameCount });
        assert.equal(d.requestFollowUp, d.skip,
          `skip/re-request diverged at ${JSON.stringify({ layoutChanged, lastPaintMs, frameCount })}`);
      }
    }
  }

  // And the deferral is bounded: consecutive frames cannot both skip, so the
  // work waits one frame rather than forever.
  const first = detectionPaintSkipDecision({ layoutChanged: false, lastPaintMs: heavy, frameCount: 7 });
  const second = detectionPaintSkipDecision({ layoutChanged: false, lastPaintMs: heavy, frameCount: 8 });
  assert.equal(first.skip, true);
  assert.equal(second.skip, false, 'the very next frame paints — a skip costs one frame, not the work');

  assert.deepEqual(detectionPaintSkipDecision(), { skip: false, requestFollowUp: false },
    'no input is not a reason to drop a frame');
});

// ---------------------------------------------------------------------------
// 3. One clock
// ---------------------------------------------------------------------------

test('the scanline scrolls off the clock, at an exact 60 fps cadence', () => {
  // Derived, not the rounded 16 it used to be: 16 ms is 62.5 Hz, which beats
  // against a real 60 fps frame clock and repeats an offset every few frames
  // instead of alternating.
  assert.equal(SCANLINE_STEP_MS, 1000 / 60);
  assert.equal(SCANLINE_PERIOD_PX, 4);
  assert.equal(scanlineOffsetPx(0), 0);
  assert.equal(scanlineOffsetPx(SCANLINE_STEP_MS), 2);
  assert.equal(scanlineOffsetPx(SCANLINE_STEP_MS * 2), 0);
  assert.equal(scanlineOffsetPx(SCANLINE_STEP_MS * 3), 2);

  // At an ideal 60 fps the offset alternates on EVERY frame — no repeats.
  const walk = Array.from({ length: 12 }, (_, i) => scanlineOffsetPx(SCANLINE_STEP_MS * i + 0.001));
  for (let i = 1; i < walk.length; i++) {
    assert.notEqual(walk[i], walk[i - 1], `frame ${i} repeated the previous offset`);
  }

  // It stays inside the pattern period for any timestamp — an offset that walked
  // past the period would leave a visible seam at the top of the canvas.
  for (const t of [1, 1_000, 1_700_000_000_000, 1_700_000_000_016]) {
    const offset = scanlineOffsetPx(t);
    assert.ok(offset >= 0 && offset < SCANLINE_PERIOD_PX, `offset ${offset} outside the period at t=${t}`);
  }

  // Two paints inside one step render identically — the animation is a function
  // of elapsed TIME, so a parked scene rests instead of demanding frames.
  const stepStart = SCANLINE_STEP_MS * 100;
  assert.equal(scanlineOffsetPx(stepStart), scanlineOffsetPx(stepStart + SCANLINE_STEP_MS - 1));
  assert.equal(scanlineOffsetPx(Number.NaN), 0, 'a broken clock paints a stable pattern, not a wandering one');
});

test('paint and demand share one timestamp, so the terminal frame is painted', async () => {
  // The dropped-frame defect: paint sampled the clock, then demand sampled it
  // again a millisecond later. At age 219 ms the paint drew alpha 0.99545 while
  // the policy, re-reading at 220 ms, answered "done" — so the frame that would
  // have painted the settled alpha was never requested and the fade stopped a
  // hair short of finished.
  //
  // With ONE timestamp the two cannot disagree. Walk the boundary: every frame
  // whose alpha is still short of 1 must also be owed a successor, and the first
  // frame that reaches alpha 1 must be the one that ends demand.
  const { acquireAlpha } = await import('./detectionDraw.js');
  const enabledAtMs = 10_000;
  for (const age of [0, 1, 100, 219, 219.9, DETECTION_ENABLE_FADE_MS, DETECTION_ENABLE_FADE_MS + 1]) {
    const nowMs = enabledAtMs + age;
    const alpha = acquireAlpha(enabledAtMs, nowMs, DETECTION_ENABLE_FADE_MS);
    const owed = detectionNeedsFollowUpFrame({
      active: true, nowMs, enabledAtMs, fadeMs: DETECTION_ENABLE_FADE_MS,
    });
    if (alpha < 1) {
      assert.equal(owed, true, `age ${age}: painted alpha ${alpha} but no successor frame was owed`);
    } else {
      assert.equal(owed, false, `age ${age}: alpha has settled, demand must end on this frame`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Wiring
// ---------------------------------------------------------------------------

test('detection holds nothing, and asks for its own frames instead', async () => {
  const source = await readFile(new URL('./detection.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /holdContinuousRender/,
    'detection must never take a continuous-render hold — that is the regression');
  assert.doesNotMatch(source, /releaseContinuousRender/,
    'and with no hold there is nothing to release');

  assert.match(source, /governorRequestRender\('detection-visibility'\)/,
    'mode/suspend transitions request their own repaint');
  assert.match(source, /if \(detectionNeedsFollowUpFrame\(\{[\s\S]*?\}\)\) \{\s*\n\s*governorRequestRender\('detection-animation'\);/,
    'the follow-up frame is gated on the policy, never unconditional');

  // The demand call must read the FRAME's timestamp, not a fresh sample.
  const paintLane = /function _paintDetectionLane\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(paintLane, 'detection.js still has a paint lane');
  assert.doesNotMatch(paintLane, /nowMs: Date\.now\(\)/,
    'demand must not re-sample the clock — that is the dropped terminal frame');
  assert.match(paintLane, /nowMs: Number\.isFinite\(frame\.timestamp\) \? frame\.timestamp : _nowMs\(\)/);
  assert.match(paintLane, /animatingLabelCount: result\.animatingCount/,
    'demand counts fades in both directions');
  // …and `animatingCount` must really be the BOTH-directions count. Feeding the
  // fade-OUT-only counter into it is exactly the original defect, and it is
  // invisible to every other assertion here — the field name would still line up
  // while a fading-in label registered nothing.
  assert.match(source, /const animatingCount = countAnimatingRenderEntries\(renderEntries\);/,
    'the demand count comes from the both-directions counter, not the fade-out tail');
  assert.match(source, /const fadingCount = countFadingRenderEntries\(renderEntries\);/,
    'and the published fade-out diagnostic keeps its own, unchanged meaning');
  assert.match(paintLane, /solvePending: result\.solvePending === true/,
    'and an unrun solve keeps the chain alive');

  // No exit from the draw pass may report work it cannot finish. The
  // zero-objects exit skips the solve block entirely, so carrying the dirty flag
  // out of it reports "a solve is still owed" on every future frame — which,
  // paired with the follow-up frame an owed solve earns, is a permanent chain on
  // the emptiest possible scene. (Caught by the governor gate at 301 renders/5 s
  // with zero layers; the fix settles the solve there, because with nothing
  // detectable it is vacuously complete.)
  const emptyExit = /\/\/ Drop the replay buffer with it[\s\S]*?return \{ didSolve: false[^\n]*\n/.exec(source)?.[0];
  assert.ok(emptyExit, 'the zero-objects exit is still identifiable');
  assert.match(emptyExit, /_labelSolveDirty = false;/,
    'the zero-objects exit settles the solve instead of carrying it forward');
  assert.match(emptyExit, /solvePending: false/,
    'and reports no outstanding solve — nothing detectable means nothing to place');

  // No wall clock may drive anything the demand model reasons about.
  const drawOverlay = /function _drawOverlay\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(drawOverlay, 'detection.js still has a draw pass');
  assert.doesNotMatch(drawOverlay, /Date\.now\(\)/,
    'the draw pass must run on the frame timestamp, not a wall clock');
  assert.match(drawOverlay, /const now = Number\.isFinite\(frame\.timestamp\) \? frame\.timestamp : _nowMs\(\);/);
  assert.match(source, /_enableTime = _nowMs\(\);/,
    'the enable stamp shares the monotonic clock the fade is measured against');

  // A skipped paint DEFERS demand; it must not consume it. The valve must route
  // through the shared decision rather than re-implementing the threshold, or
  // the skip/re-request pairing proven above would not bind it.
  const shouldPaint = /function _shouldPaintDetectionLane\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(shouldPaint, 'the relief valve is still there');
  assert.match(shouldPaint, /detectionPaintSkipDecision\(\{/,
    'the valve asks the shared policy instead of inlining its own threshold');
  assert.doesNotMatch(shouldPaint, /_lastPaintMs > 22/,
    'the old inline threshold must be gone, not shadowing the policy');
  assert.match(shouldPaint, /if \(decision\.requestFollowUp\) governorRequestRender\('detection-paint-skipped'\)/,
    'skipping a paint must hand the request forward, not swallow it');

  // The scanline must not go back to the frame counter: that is what made a
  // decorative texture demand a permanently hot loop.
  const scanlines = /function _drawScanlines\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(scanlines, 'detection.js still draws scanlines');
  assert.doesNotMatch(scanlines, /_frameCount/,
    'the scroll offset must come from the clock, not from a frame counter');
  assert.match(scanlines, /scanlineOffsetPx\(nowMs\)/,
    'and from the shared policy so the two cannot drift');
});

test('a layer whose detectable set changed dirties the solve', async () => {
  // Detection PULLS candidates per paint but re-solves on a private 125 ms
  // throttle. A poll tick that replaces contact A with contact B requests one
  // frame; without this, that frame could be spent on a paint which declined to
  // re-solve — leaving A labelled, B unlabelled, and nothing left to ask again.
  const detection = await readFile(new URL('./detection.js', import.meta.url), 'utf8');
  assert.match(detection, /export function markDetectionSourcesChanged\(/,
    'detection exposes the source-change hook');
  const hook = /export function markDetectionSourcesChanged\([\s\S]*?\n\}/.exec(detection)[0];
  assert.match(hook, /_labelSolveDirty = true;/, 'and it really dirties the solve');
  assert.doesNotMatch(hook, /governorRequestRender/,
    'the caller already requests the frame — asking twice would double every tick');
  assert.match(hook, /if \(_mode === MODE_OFF\) return;/,
    'and it stays inert while detection is off');

  const manager = await readFile(new URL('./manager.js', import.meta.url), 'utf8');
  assert.match(manager, /import \{ markDetectionSourcesChanged \} from '\.\/detection\.js';/);
  // Both discrete events that can change the detectable set, next to the render
  // request each already made.
  assert.match(manager, /governorRequestRender\(`layer-tick:\$\{layerId\}`\);[\s\S]{0,700}?markDetectionSourcesChanged\(`layer-tick:\$\{layerId\}`\);/,
    'a poll tick marks the solve dirty alongside its render request');
  assert.match(manager, /governorRequestRender\('layer-visibility'\);[\s\S]{0,400}?markDetectionSourcesChanged\('layer-visibility'\);/,
    'so does a layer appearing or disappearing');
});

test('the render-governor gate covers the parked case, with teeth on the painter', async () => {
  // The unit tests above cannot see a duty cycle, and a render count alone
  // cannot see whether the painter still runs — a disabled painter would score a
  // perfect idle. If either half of the runtime gate is dropped, this fails and
  // says so rather than leaving the policy pinned but unobserved.
  const gate = await readFile(new URL('../../scripts/qa-perf.mjs', import.meta.url), 'utf8');
  assert.match(gate, /detection ON takes NO continuous-render hold/);
  assert.match(gate, /idle parked scene with detection ON \(≤4 fires \/ 5s\)/);
  assert.match(gate, /detection ON costs no more idle frames than detection OFF/);
  assert.match(gate, /detection ON still repaints promptly on camera motion/,
    'quiet must not be allowed to mean stale');
  assert.match(gate, /detection is still PAINTING, not merely quiet/,
    'and the activity check must reach the painter, not just the scene');
  // The idle windows must START at a settled quiet RUN, not a fixed sleep and
  // not one empty second. The harness's own teardown marks the HUD summary
  // dirty, and the 15 s tick that notices types the new text in — reflowing an
  // occluder ~16 s later, inside the old counted window. The scene is honestly
  // idle for that whole gap, so only a run longer than one refresh period can
  // tell "settled" from "about to be interrupted".
  assert.match(gate, /const settleUntilQuiet = async \(/,
    'the idle windows wait for quiet rather than sleeping a fixed time');
  assert.match(gate, /const HUD_SUMMARY_INTERVAL_MS = 15_000;/,
    'the quiet run is derived from the app cadence it has to outlast');
  assert.match(gate, /QUIET_RUN_WINDOWS = Math\.ceil\(HUD_SUMMARY_INTERVAL_MS \/ 1_000\) \+ 1/,
    'one full summary refresh period, plus a second of margin');
  assert.match(gate, /requiredConsecutive = QUIET_RUN_WINDOWS/,
    'and the settle actually requires that run, rather than a shorter constant');
  assert.match(gate, /else \{ if \(consecutive > 0\) restarts \+= 1; consecutive = 0; \}/,
    'any activity restarts the run, so it cannot straddle the deferred burst');
  assert.match(gate, /check\('the parked scene holds a settled quiet run before the idle window is counted', idleSettle\.quiet/,
    'quiet that never arrives is asserted as a failure, not skipped past');
  assert.match(gate, /check\('the scene holds a settled quiet run again before the second idle window', teardownSettle\.quiet/);
  assert.match(gate, /idle parked scene stops rendering \(≤4 fires \/ 5s\)/,
    'the threshold inside the settled window stays untouched');
});

// ---------------------------------------------------------------------------
// 5. What keeps aircraft brackets prompt without a detection hold
// ---------------------------------------------------------------------------

// Detection paints AIR brackets — including the alpha-floored ones — inside
// _drawOverlay, from live positions, and does NOT take part in any
// "objects may have changed" notification. With detection's own render hold
// gone, the obvious worry is a floored bracket sitting stale on a parked scene
// until some unrelated frame happens along.
//
// It cannot, and the reason is structural rather than lucky: an AIR bracket can
// only exist while an aircraft layer is enabled, and both aircraft layers take a
// continuous-render hold for their own per-frame fleet animation. So for exactly
// as long as there is anything to bracket, the scene is rendering every frame
// and the overlay repaints with it. (Measured live 2026-08-23 on a parked
// camera: an outside-aircraft population change moved the painted bracket count
// with no camera input, holds = ["flights"], requestRenderMode = false.)
//
// That is a COUPLING, so it deserves a pin. If a later perf pass strips these
// holds the way it stripped detection's — a reasonable-looking change — bracket
// promptness goes with them, silently. This test is where that shows up.
test('aircraft brackets stay prompt because the aircraft layers hold the render loop', async () => {
  for (const file of ['./flights.js', './militaryFlights.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const enable = /\n  enable\([\s\S]*?\n  \},/.exec(source)?.[0];
    assert.ok(enable, `${file}: enable() is still identifiable`);
    assert.match(
      enable,
      /holdContinuousRender\('(flights|military)'\)/,
      `${file}: enabling the layer must hold continuous render — detection no longer ` +
      'holds one, so this is what keeps its AIR brackets repainting on a parked scene',
    );
    assert.match(
      source,
      /releaseContinuousRender\('(flights|military)'\)/,
      `${file}: and the hold must be released, or the governor can never idle`,
    );
  }
});
