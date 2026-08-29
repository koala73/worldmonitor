#!/usr/bin/env node
/**
 * qa-heading-b3.mjs — throwaway QA harness for skylight Task 4
 * (path-derived, rate-limited display course; Batch 3 overnight run).
 *
 * The permanent track-regression harness flies planes STRAIGHT, so it cannot
 * exercise the new heading behavior. This script injects synthetic TURNING
 * aircraft — the fetch shim computes each plane's position ANALYTICALLY on a
 * constant-rate-turn circle from Date.now() at serve time, so every poll
 * (this script's driver or the layers' own setInterval pollers) serves a fix
 * whose position, track, and timestamp are mutually consistent.
 *
 * What it checks, on the REAL app (same puppeteer flags as
 * scripts/track-regression.mjs):
 *
 *   LOGIC — track a turning plane in 3D, sample the DISPLAYED course every
 *   frame for ~40 s. Sampling happens in scene.preRender, which fires AFTER
 *   the layer's _fleetTick/_updateTrackedModel listener (Cesium events fire in
 *   add order and the app registered first), i.e. at the exact wall-clock the
 *   rate limiter advanced — postRender sampling skews apparent rates by the
 *   variable render-pass duration (~40% at SwiftShader's ~3 fps). The course
 *   is derived from the tracked standalone Cesium.Model's modelMatrix (the
 *   actually-rendered transform), inverting _modelMatrix: with pitch=roll=0
 *   the matrix is ENU·Rz(−h), so local x in ENU = (cos h, −sin h, 0) →
 *   h = atan2(−x·north, x·east), course = norm360(deg(h) − MODEL_HEADING_OFFSET).
 *   The 15 s fix cadence × 3°/s turn = 45° course step per interpolation
 *   segment, so the 60°/s-limited glide lasts 0.75 s — multiple frames even
 *   under SwiftShader.
 *   Assertions:
 *     A1 rate-limit   : per-frame |Δcourse|/Δt ≤ COURSE_MAX_DPS (60°/s) + 15% tol
 *                       (pairs with |Δ| ≤ 1.5° skipped — noise-dominated rates)
 *     A2 no snap      : no single frame carries the whole ~45° segment step:
 *                       fail if |Δ| ≥ 33.75° (0.75×step) in a frame of ≤ 500 ms
 *                       (the limiter needs ≥ 562 ms to emit that legitimately)
 *     A3 spread       : the slew is spread across ≥4 frames (>0.5°) with ≥2
 *                       consecutive — the old snap was ONE spike per poll
 *     A4 turning      : total unwrapped course change ≥ +40° over the window
 *                       (the plane really turns 3°/s ≈ +120°/40 s)
 *     A5 alignment    : sampled course agrees with the analytic arc tangent at
 *                       the DISPLAYED (render-delayed) time within 35° — catches
 *                       sign/offset inversion in the whole chain (chord lags the
 *                       tangent by ≤ half a segment ≈ 22.5°)
 *   Both layers: flights (airplane.glb, offset 180°) then military (jet.glb,
 *   normalized nose -X, offset 180°).
 *
 *   VISUAL — with the turning flights plane tracked in 3D, capture screenshots
 *   (two zoom levels × two orbit angles) into qa-shots/b3/ for human review:
 *   the nose must lead the curved trail, never sideways/backwards.
 *
 *   LOW-SPEED (heading-v2, 2026-07-03 field-test regression) — two extra
 *   flights-layer scenarios that the fast turning planes cannot catch:
 *
 *   Phase 3 — HOVERING HELICOPTER (klass=helicopter via OpenSky category 8):
 *   position drifts a few metres (smooth pseudo-random GPS walk), reported
 *   track flips ±45° around 90° (the velocity-vector noise a hovering
 *   transponder actually emits), velocity 1 m/s. Assertions:
 *     H1 coverage   : >=12 sampled frames spanning >=30 s
 *     H2 stability  : total |Δcourse| <= 25° over the ~35 s window (pre-fix the
 *                     nose chased the flipping reported track at 60°/s: ~90°
 *                     per poll)
 *     H3 no spin    : max unwrapped excursion from the initial course <= 60°
 *
 *   Phase 4 — SLOW PLANE, TIGHT CONTINUOUS TURN (25 kt, 4°/s right, R=184 m):
 *   fixes every ~15 s → the chord course used to STEP 60° at each segment
 *   boundary (a 1 s whip at the 60°/s cap, then ~14 s frozen). Assertions:
 *     S1 smooth     : max per-frame course rate (pairs with |Δ|>1.5°) <= 20°/s
 *                     — the real turn is 4°/s; pre-fix bursts hit the 60°/s cap
 *     S2 monotonic  : course tracks the turn direction — total counter-turn
 *                     movement (sum of negative deltas) >= −8°
 *     S3 turning    : total course change >= 0.5 × (4°/s × window)
 *   Screenshots for both into qa-shots/heading-v2/ (heli nose stable between
 *   two shots 8 s apart; slow plane nose tangent to its curved trail).
 *
 *   Phase 5 — TRACKED↔FLEET COURSE HANDOFF (2026-07-03 field report: tracking
 *   a Bell 429 at 65 kt FLIPPED the nose on click/click-away — the fleet pass
 *   and the tracked path kept SEPARATE smoothed-course states, so the fleet's
 *   per-icao entry froze while tracked and snapped on release). A 65 kt
 *   helicopter (category 8, klass=helicopter) orbits at 2°/s; the RENDERED
 *   orientation is sampled continuously across an untrack and a re-track:
 *     C1 (click-away, 3D OFF): the SCREEN rotation actually drawn — the
 *       tracked entity's rotation callback while tracked, the fleet
 *       billboard's rotation after — with the camera static across the
 *       release-in-place, so rotation deltas are course deltas. This is the
 *       exact pixel the owner saw flip; it also catches the stale-rotation
 *       restore (the fleet billboard reappearing with its frozen pre-track
 *       rotation for up to a rotation-refresh).
 *     C2 (click, 3D ON): world course from the model matrix (fleet model →
 *       tracked standalone model, both id=icao) — camera-independent, so the
 *       re-track camera flight can't contaminate it.
 *   Assertions (each direction): near the click boundary, no consecutive-
 *   sample step exceeds the real turn by > 15°, and no near-boundary rate
 *   exceeds 15°/s (truth is 2°/s; the pre-fix snap replayed ~120° of frozen
 *   divergence at the 60°/s slew cap).
 *
 * Run:  node scripts/qa-heading-b3.mjs --url http://localhost:4300
 * Exits non-zero if any assertion fails. Never commits anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

// ---------------------------------------------------------------------------
// Args (same shape as track-regression.mjs)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = getFlag('--headful');
const SHOT_DIR = path.resolve('qa-shots/b3');
const SHOT_DIR_V2 = path.resolve('qa-shots/heading-v2');

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Prefer puppeteer's version-pinned Chrome-for-Testing over the system
  // Chrome: /Applications auto-updates underneath the harnesses, and its
  // software-GL behavior shifts across majors (system Chrome 150 blew the
  // tile-gated drain budget under SwiftShader on 2026-07-30 — six
  // false-negative qa-cctv-v2 runs against a healthy build). A deterministic
  // pinned browser beats the newest one for regression harnesses.
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PASS/FAIL reporting
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function observeTrackedHostPaint(page, timeoutMs = 5000) {
  return page.evaluate((boundedTimeoutMs) => new Promise((resolve) => {
    const viewer = window.__godsEyeView?.viewer;
    const scene = viewer?.scene;
    const history = [];
    const startedAt = performance.now();
    let removePostRender = null;
    let requestTimer = null;
    let timeoutTimer = null;
    let finished = false;
    const finish = (observed) => {
      if (finished) return;
      finished = true;
      removePostRender?.();
      clearInterval(requestTimer);
      clearTimeout(timeoutTimer);
      resolve({ observed, history, sample: history.at(-1) || null });
    };
    const sample = () => {
      const diagnostics = window.__gevWorldOverlay?.getDiagnostics?.() || {};
      const tracked = viewer?.trackedEntity;
      const current = {
        elapsedMs: Math.round(performance.now() - startedAt),
        entryId: tracked?.gevTrackedId || null,
        hasPresentationModel: Boolean(tracked?.gevLabelModel?.title),
        candidateCount: diagnostics.candidateCount || 0,
        projectedCount: diagnostics.projectedCount || 0,
        selectedCount: diagnostics.selectedCount || 0,
        entryCount: diagnostics.entriesBySource?.tracked || 0,
        painted: diagnostics.paintedBySource?.tracked || 0,
        paintedCount: diagnostics.paintedCount || 0,
      };
      history.push(current);
      if (history.length > 80) history.shift();
      if (current.entryCount === 1 && current.painted >= 1) finish(true);
    };
    if (!scene?.postRender?.addEventListener) {
      finish(false);
      return;
    }
    // The overlay registered first during bootstrap, so this later listener
    // sees projection and paint from the same frame before diagnostics reset.
    removePostRender = scene.postRender.addEventListener(sample);
    requestTimer = setInterval(() => scene.requestRender(), 100);
    timeoutTimer = setTimeout(() => finish(false), boundedTimeoutMs);
    scene.requestRender();
  }), timeoutMs);
}

const norm360 = (d) => ((d % 360) + 360) % 360;
const norm180 = (d) => { const n = norm360(d); return n > 180 ? n - 360 : n; };

// ---------------------------------------------------------------------------
// Synthetic TURNING aircraft — constant-rate-turn circles near Austin.
// alphaDeg0 = position angle on the circle at shim-install epoch; the plane
// sits at center + R·(sin α, cos α) and flies CLOCKWISE (right turn):
// course(t) = α(t) + 90, turn rate = turnDps (course °/s), speed = R·ω.
// 3°/s × 15 s driver cadence → ~45° course step per interpolation segment.
// ---------------------------------------------------------------------------
const TURN = {
  timeOffsetSec: 0, // shim knob: serve fixes as of (now + offset) — used to back-date priming fixes
  flights: [
    { icao: 'aaa001', callsign: 'TRN001', cLon: -97.7431, cLat: 30.2672, radiusM: 2673, alphaDeg0: 0, turnDps: 3, altM: 3000 },
    { icao: 'aaa002', callsign: 'TRN002', cLon: -97.7800, cLat: 30.2900, radiusM: 2673, alphaDeg0: 120, turnDps: 3, altM: 3400 },
    { icao: 'aaa003', callsign: 'TRN003', cLon: -97.7100, cLat: 30.2400, radiusM: 2673, alphaDeg0: 240, turnDps: 3, altM: 2800 },
  ],
  military: [
    { hex: 'bbb201', flight: 'TRNMIL1', cLon: -97.7550, cLat: 30.2750, radiusM: 2947, alphaDeg0: 45, turnDps: 3, altFt: 12000, t: 'F16', r: 'AF-201' },
    { hex: 'bbb202', flight: 'TRNMIL2', cLon: -97.7250, cLat: 30.2500, radiusM: 2947, alphaDeg0: 200, turnDps: 3, altFt: 14000, t: 'F18', r: 'AF-202' },
  ],
  // Low-speed scenarios (heading-v2). The heli HOVERS: position = smooth
  // pseudo-random GPS drift (driftAmpM metres per sinusoid pair → fix-to-fix
  // chords well under the 25 m gate), reported track flips ±45° around
  // baseTrack every ~trackFlipSec/2 (hover velocity-vector noise), category 8
  // classifies it klass=helicopter at ingest. The slow plane reuses the circle
  // math: R=184.2 m at 4°/s ⇒ ground speed R·ω = 12.86 m/s ≈ 25 kt; category 2
  // (light). Both served by the flights (OpenSky) shim branch.
  hover: { icao: 'aaa010', callsign: 'HOVER1', cLon: -97.7431, cLat: 30.2672, altM: 450, driftAmpM: 4, baseTrack: 90, trackFlipSec: 29, category: 8 },
  slow: { icao: 'aaa011', callsign: 'SLOW25', cLon: -97.7000, cLat: 30.2300, radiusM: 184.2, alphaDeg0: 0, turnDps: 4, altM: 900, category: 2 },
  // Phase 5 (course-handoff consistency): 65 kt helicopter in a wide orbit —
  // R=958 m at 2°/s ⇒ ground speed R·ω = 33.4 m/s ≈ 65 kt (the owner's Bell
  // 429 case). Category 8 classifies it klass=helicopter, so its display
  // course is the reported per-fix track (chords are ignored for rotorcraft).
  // `active` gates it INTO the feed only when phase 5 starts, so phases 1–4
  // run against exactly the fleet they were calibrated on.
  heli65: { icao: 'aaa012', callsign: 'HELI65', cLon: -97.7750, cLat: 30.2150, radiusM: 958, alphaDeg0: 0, turnDps: 2, altM: 600, category: 8, active: false },
};

/** Analytic ground truth (Node side too, for A5): plane state at epoch-relative tSec. */
function arcState(p, tSec) {
  const alpha = p.alphaDeg0 + p.turnDps * tSec;
  const aRad = (alpha * Math.PI) / 180;
  const east = p.radiusM * Math.sin(aRad);
  const north = p.radiusM * Math.cos(aRad);
  const lat = p.cLat + north / 111320;
  const lon = p.cLon + east / (111320 * Math.cos((p.cLat * Math.PI) / 180));
  const course = norm360(alpha + 90); // clockwise tangent
  const speedMps = p.radiusM * ((p.turnDps * Math.PI) / 180);
  return { lon, lat, course, speedMps };
}

// ---------------------------------------------------------------------------
// Node-side analysis of a sampled {tMs, course} series
// ---------------------------------------------------------------------------
function analyze(label, samples, plan) {
  const { capDps = 60, tolFactor = 1.15, snapCeilDeg = 33.75, snapDtCeilMs = 500, minTotalDeg = 40 } = plan;
  const valid = samples.filter((s) => s && Number.isFinite(s.course));
  const windowSec = valid.length ? (valid[valid.length - 1].tMs - valid[0].tMs) / 1000 : 0;
  console.log(`\n  ${label}: ${valid.length}/${samples.length} valid frames over ${windowSec.toFixed(1)} s`);
  if (valid.length < 12 || windowSec < 30) {
    record(`${label}: >=12 sampled frames spanning >=30 s`, false, `${valid.length} frames over ${windowSec.toFixed(1)} s`);
    return;
  }
  record(`${label}: >=12 sampled frames spanning >=30 s`, true, `${valid.length} frames over ${windowSec.toFixed(1)} s`);

  const deltas = []; // {d, dtMs, rate, tMs}
  let total = 0;
  for (let i = 1; i < valid.length; i++) {
    const dtMs = valid[i].tMs - valid[i - 1].tMs;
    if (dtMs < 4 || dtMs > 10000) continue; // keep slow SwiftShader frames; skip only genuine stalls
    const d = norm180(valid[i].course - valid[i - 1].course);
    total += d;
    deltas.push({ d, dtMs, rate: Math.abs(d) / (dtMs / 1000), tMs: valid[i].tMs });
  }
  const dts = deltas.map((x) => x.dtMs).sort((a, b) => a - b);
  const dtMed = dts[Math.floor(dts.length / 2)] || 0;
  // Rate check only on pairs with meaningful motion — sub-1.5° deltas divided
  // by small dts are numerically noise, not slew.
  const moving = deltas.filter((x) => Math.abs(x.d) > 1.5);
  const maxRate = moving.length ? Math.max(...moving.map((x) => x.rate)) : 0;
  const maxAbsD = Math.max(...deltas.map((x) => Math.abs(x.d)));
  const snapFrames = deltas.filter((x) => Math.abs(x.d) >= snapCeilDeg && x.dtMs <= snapDtCeilMs);
  const active = deltas.filter((x) => Math.abs(x.d) > 0.5);
  let maxRun = 0, run = 0;
  for (const x of deltas) { run = Math.abs(x.d) > 0.5 ? run + 1 : 0; if (run > maxRun) maxRun = run; }
  const top = [...deltas].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
  const t0 = valid[0].tMs;
  console.log(`    frame dt median=${dtMed.toFixed(0)} ms | max rate (|Δ|>1.5°)=${maxRate.toFixed(1)} °/s | max |Δ|=${maxAbsD.toFixed(2)}°`);
  console.log(`    active frames (|Δ|>0.5°): ${active.length} (longest consecutive run ${maxRun}) | total signed change=${total.toFixed(1)}°`);
  console.log(`    top deltas: ${top.map((x) => `${x.d.toFixed(1)}°/${x.dtMs.toFixed(0)}ms@t+${((x.tMs - t0) / 1000).toFixed(1)}s`).join('  ')}`);

  record(`${label} A1: per-frame course rate <= ${capDps}°/s cap (+${Math.round((tolFactor - 1) * 100)}%)`,
    maxRate <= capDps * tolFactor,
    `max ${maxRate.toFixed(1)} °/s vs ${(capDps * tolFactor).toFixed(0)} °/s (over ${moving.length} moving pairs)`);
  record(`${label} A2: no once-per-poll snap (no |Δ| >= ${snapCeilDeg}° in a <= ${snapDtCeilMs} ms frame; full step ~45°)`,
    snapFrames.length === 0,
    snapFrames.length ? `snap frames: ${snapFrames.map((x) => `${x.d.toFixed(1)}°/${x.dtMs.toFixed(0)}ms`).join(' ')}` : `max |Δ| ${maxAbsD.toFixed(2)}°`);
  record(`${label} A3: slew spread over frames (>=4 active, >=2 consecutive)`,
    active.length >= 4 && maxRun >= 2,
    `${active.length} active, run ${maxRun}`);
  record(`${label} A4: really turning (total change >= +${minTotalDeg}°)`,
    total >= minTotalDeg,
    `total ${total.toFixed(1)}° over ${((valid[valid.length - 1].tMs - t0) / 1000).toFixed(1)} s`);
}

/** Per-frame deltas of a sampled {tMs, course} series (shared by the
 *  low-speed analyzers): skips invalid frames and stalled/double-fired pairs. */
function courseDeltas(samples) {
  const valid = samples.filter((s) => s && Number.isFinite(s.course));
  const deltas = [];
  for (let i = 1; i < valid.length; i++) {
    const dtMs = valid[i].tMs - valid[i - 1].tMs;
    if (dtMs < 4 || dtMs > 10000) continue;
    deltas.push({ d: norm180(valid[i].course - valid[i - 1].course), dtMs });
  }
  return { valid, deltas };
}

/** Phase 3 (hovering helicopter): the displayed course must HOLD — chord and
 *  reported track are both noise at hover, so any movement is chasing noise. */
function analyzeHover(label, samples, { maxTotalAbsDeg = 25, maxExcursionDeg = 60 } = {}) {
  const { valid, deltas } = courseDeltas(samples);
  const windowSec = valid.length ? (valid[valid.length - 1].tMs - valid[0].tMs) / 1000 : 0;
  console.log(`\n  ${label}: ${valid.length}/${samples.length} valid frames over ${windowSec.toFixed(1)} s`);
  const covered = valid.length >= 12 && windowSec >= 30;
  record(`${label} H1: >=12 sampled frames spanning >=30 s`, covered, `${valid.length} frames over ${windowSec.toFixed(1)} s`);
  if (!covered) return;
  let totalAbs = 0, cum = 0, maxExcursion = 0;
  for (const x of deltas) {
    totalAbs += Math.abs(x.d);
    cum += x.d;
    maxExcursion = Math.max(maxExcursion, Math.abs(cum));
  }
  console.log(`    total |Δcourse|=${totalAbs.toFixed(1)}° | max excursion from start=${maxExcursion.toFixed(1)}° | start=${valid[0].course.toFixed(0)}° end=${valid[valid.length - 1].course.toFixed(0)}°`);
  record(`${label} H2: displayed course stays put (total |Δ| <= ${maxTotalAbsDeg}° over ${windowSec.toFixed(0)} s)`,
    totalAbs <= maxTotalAbsDeg, `total |Δ| ${totalAbs.toFixed(1)}°`);
  record(`${label} H3: no spins (max excursion from initial course <= ${maxExcursionDeg}°)`,
    maxExcursion <= maxExcursionDeg, `max excursion ${maxExcursion.toFixed(1)}°`);
}

/** Phase 4 (25 kt tight turn): the course must ADVANCE like the real 4°/s turn —
 *  smooth (no 60°/s boundary whips), monotonic (no counter-turn reversals). */
function analyzeSlowTurn(label, samples, {
  maxRateDps = 20,
  maxReversalDeg = 8,
  expectDps = 4,
  minSamples = 12,
  minWindowSec = 30,
  minProgressFraction = 0.4,
  scoreProgress = true,
} = {}) {
  const { valid, deltas } = courseDeltas(samples);
  const windowSec = valid.length ? (valid[valid.length - 1].tMs - valid[0].tMs) / 1000 : 0;
  console.log(`\n  ${label}: ${valid.length}/${samples.length} valid frames over ${windowSec.toFixed(1)} s`);
  const covered = valid.length >= minSamples && windowSec >= minWindowSec;
  record(`${label} S0: >=${minSamples} frames spanning >=${minWindowSec} s`, covered, `${valid.length} frames over ${windowSec.toFixed(1)} s`);
  if (!covered) return;
  const moving = deltas.filter((x) => Math.abs(x.d) > 1.5);
  const maxRate = moving.length ? Math.max(...moving.map((x) => Math.abs(x.d) / (x.dtMs / 1000))) : 0;
  let total = 0, reversal = 0;
  for (const x of deltas) { total += x.d; if (x.d < 0) reversal += x.d; }
  const top = [...deltas].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 4);
  console.log(`    max rate (|Δ|>1.5°)=${maxRate.toFixed(1)} °/s | total=${total.toFixed(1)}° | counter-turn sum=${reversal.toFixed(1)}°`);
  console.log(`    top deltas: ${top.map((x) => `${x.d.toFixed(1)}°/${x.dtMs.toFixed(0)}ms`).join('  ')}`);
  record(`${label} S1: smooth slow turn (max per-frame rate <= ${maxRateDps}°/s; real turn ${expectDps}°/s)`,
    maxRate <= maxRateDps, `max ${maxRate.toFixed(1)} °/s (over ${moving.length} moving pairs)`);
  // The default 100 ms request cadence can still produce multi-second render
  // gaps under SwiftShader. Use it for load/coverage/rate, but score direction
  // and progress only in the dedicated 600 ms cadence pass below, which
  // demonstrated stable consecutive samples on this backend.
  if (!scoreProgress) return;
  record(`${label} S2: monotonic in the turn direction (counter-turn sum >= -${maxReversalDeg}°)`,
    reversal >= -maxReversalDeg, `counter-turn ${reversal.toFixed(1)}°`);
  // The window can begin halfway through the 15 s fix interval, before the
  // next segment-boundary slew starts. Require substantial forward progress
  // without assuming a favorable phase alignment.
  const minTotal = minProgressFraction * expectDps * windowSec;
  record(`${label} S3: really turning (total >= ${minTotal.toFixed(0)}°)`,
    total >= minTotal, `total ${total.toFixed(1)}° over ${windowSec.toFixed(1)} s`);
}

/** Phase 5 (tracked↔fleet handoff): the sampled RENDERED course must stay
 *  continuous across a click/click-away, modulo the real 2°/s turn. Two
 *  signals, both scored only NEAR the action (−1 s .. +postWindowMs):
 *   - step excess: |Δcourse| of a consecutive-sample pair minus the truth
 *     advance truthDps·dt — a snapped handoff carries the whole frozen-state
 *     divergence in one pair;
 *   - course rate: the pre-fix snap-back replayed the divergence at the
 *     60°/s slew cap, so ANY two near-boundary samples catch it even when the
 *     fleet model appears a few frames late. */
function analyzeHandoff(label, { samples, actionTMs }, {
  truthDps = 2, stepExcessTolDeg = 12, rateTolDps = 12, postWindowMs = 4000,
  minSamples = 30, pairDtCeilMs = 3000, rateDtFloorMs = 0,
} = {}) {
  const valid = samples.filter((s) => s && Number.isFinite(s.course));
  const t0 = valid.length ? valid[0].tMs : 0;
  console.log(`\n  ${label}: ${valid.length}/${samples.length} valid frames; action at t+${Number.isFinite(actionTMs) ? ((actionTMs - t0) / 1000).toFixed(1) : '?'} s`);
  if (valid.length < minSamples || !Number.isFinite(actionTMs)) {
    record(`${label}: enough samples around the transition`, false,
      `valid=${valid.length} (need ${minSamples}) actionTMs=${actionTMs}`);
    return;
  }
  let maxExcess = 0;
  let maxExcessAtMs = 0;
  let maxRate = 0;
  let boundaryPairs = 0;
  for (let i = 1; i < valid.length; i++) {
    const dtMs = valid[i].tMs - valid[i - 1].tMs;
    if (dtMs < 4 || dtMs > pairDtCeilMs) continue; // stalled / model-swap-gap outliers
    // (Step excess is truth-compensated, so long low-fps pairs stay valid —
    // SwiftShader near ground-level 3D tiles can drop under 1 fps.)
    const nearAction = valid[i].tMs >= actionTMs - 1000 && valid[i - 1].tMs <= actionTMs + postWindowMs;
    if (!nearAction) continue;
    boundaryPairs += 1;
    const d = Math.abs(norm180(valid[i].course - valid[i - 1].course));
    const excess = d - truthDps * (dtMs / 1000);
    if (excess > maxExcess) { maxExcess = excess; maxExcessAtMs = valid[i].tMs - actionTMs; }
    // Rate metric: dt floored at the display's own refresh quantum — the fleet
    // billboard's rotation advances in ROTATION_REFRESH_MS batches, so a
    // short-dt sample pair spanning one refresh reads a full second of course
    // advance over a fraction of a second. The pre-fix snap (~120° in one
    // refresh) still reads >100°/s through the floor.
    if (d > 1.5) maxRate = Math.max(maxRate, d / (Math.max(dtMs, rateDtFloorMs) / 1000)); // sub-1.5° deltas are noise
  }
  console.log(`    boundary pairs=${boundaryPairs} | max step excess=${maxExcess.toFixed(1)}° @ action+${(maxExcessAtMs / 1000).toFixed(2)} s | max rate=${maxRate.toFixed(1)} °/s`);
  record(`${label}: no course flip across the handoff (step excess <= ${stepExcessTolDeg}°, rate <= ${rateTolDps}°/s near the boundary)`,
    boundaryPairs > 0 && maxExcess <= stepExcessTolDeg && maxRate <= rateTolDps,
    `maxExcess=${maxExcess.toFixed(1)}° maxRate=${maxRate.toFixed(1)}°/s over ${boundaryPairs} pairs (truth ${truthDps}°/s)`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nTurning-plane heading QA (Batch 3 / skylight Task 4)`);
  console.log(`  App URL : ${APP_URL}\n`);

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR_V2, { recursive: true });

  const chromeExecutable = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(HEADFUL ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  });

  const consoleErrors = [];
  const failedResponses = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!/Failed to load resource.*404/i.test(text)) consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('response', (response) => {
      if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
    });

    // ---- Turning-plane fetch shim (installed before any app code runs) ------
    await page.evaluateOnNewDocument((turn) => {
      window.__TURN = turn;
      window.__TURN.epochMs = Date.now(); // arc phase zero = shim install time
      window.__TURN_HITS = { opensky: 0, mil: 0 };

      const norm360 = (d) => ((d % 360) + 360) % 360;
      // Same arc math as the Node side (keep in sync with arcState()).
      window.__TURN.stateAt = (p, tSec) => {
        const alpha = p.alphaDeg0 + p.turnDps * tSec;
        const aRad = (alpha * Math.PI) / 180;
        const east = p.radiusM * Math.sin(aRad);
        const north = p.radiusM * Math.cos(aRad);
        const lat = p.cLat + north / 111320;
        const lon = p.cLon + east / (111320 * Math.cos((p.cLat * Math.PI) / 180));
        return {
          lon, lat,
          course: norm360(alpha + 90),
          speedMps: p.radiusM * ((p.turnDps * Math.PI) / 180),
        };
      };
      // Hovering-heli truth (keep in sync with hoverState() on the Node side):
      // smooth bounded GPS drift + square-wave reported-track flips.
      window.__TURN.hoverAt = (p, tSec) => {
        const east = p.driftAmpM * (Math.sin(2 * Math.PI * tSec / 41) + 0.6 * Math.sin(2 * Math.PI * tSec / 13.7));
        const north = p.driftAmpM * (Math.sin(2 * Math.PI * tSec / 53 + 1.3) + 0.6 * Math.sin(2 * Math.PI * tSec / 17.3 + 0.7));
        const lat = p.cLat + north / 111320;
        const lon = p.cLon + east / (111320 * Math.cos((p.cLat * Math.PI) / 180));
        const flip = Math.sin(2 * Math.PI * tSec / p.trackFlipSec) >= 0 ? 1 : -1;
        return { lon, lat, course: norm360(p.baseTrack + flip * 45), speedMps: 1.0 };
      };

      const realFetch = window.fetch.bind(window);
      const jsonResponse = (obj) => new Response(JSON.stringify(obj), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });

      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const T = window.__TURN;
        if (url.includes('/api/openai/hud-summary')) {
          return Promise.resolve(jsonResponse({ summary: 'Turning-flight QA' }));
        }
        // Serve-time truth: position/track/timestamp all as of (now + offset).
        const nowSec = Date.now() / 1000 + (T.timeOffsetSec || 0);
        const tRel = nowSec - T.epochMs / 1000;

        if (url.includes('/api/opensky-track')) return Promise.resolve(jsonResponse({ path: [] }));
        if (url.includes('/api/adsblol/trace')) {
          return Promise.resolve(jsonResponse({ timestamp: Math.floor(nowSec), trace: [] }));
        }
        if (url.includes('/api/opensky')) {
          T.__hitsGuard = ++window.__TURN_HITS.opensky;
          const row = (id, callsign, s, altM, category) => [
            id, callsign, 'Synthetica',
            Math.floor(nowSec),        // 3 time_position — the fix epoch the layer stamps history with
            Math.floor(nowSec),        // 4 last_contact
            s.lon, s.lat, altM,        // 5,6,7
            false,                     // 8 on_ground
            s.speedMps,                // 9 velocity (m/s)
            s.course,                  // 10 true_track (deg) — honest arc tangent (hover: flipping GPS-vector noise)
            0, null, null, null, false, 0,
            category ?? null,          // 17 extended=1 emitter category (8 = rotorcraft → klass helicopter)
          ];
          const states = T.flights.map((f) => row(f.icao, f.callsign, T.stateAt(f, tRel), f.altM, null));
          states.push(row(T.hover.icao, T.hover.callsign, T.hoverAt(T.hover, tRel), T.hover.altM, T.hover.category));
          states.push(row(T.slow.icao, T.slow.callsign, T.stateAt(T.slow, tRel), T.slow.altM, T.slow.category));
          if (T.heli65.active) states.push(row(T.heli65.icao, T.heli65.callsign, T.stateAt(T.heli65, tRel), T.heli65.altM, T.heli65.category));
          return Promise.resolve(jsonResponse({ time: Math.floor(nowSec), states }));
        }
        if (url.includes('/api/adsblol/mil')) {
          window.__TURN_HITS.mil++;
          const ac = T.military.map((m) => {
            const s = T.stateAt(m, tRel);
            return {
              hex: m.hex, flight: m.flight,
              lon: s.lon, lat: s.lat, alt_baro: m.altFt,
              track: s.course, gs: s.speedMps * 1.9438,
              t: m.t, r: m.r, ownOp: 'SYNTH AF',
              seen_pos: Math.max(0, -(T.timeOffsetSec || 0)), // age → fixTime = now + offset
            };
          });
          return Promise.resolve(jsonResponse({ msg: 'No error', now: Date.now(), ac }));
        }
        // Classification is supplied by the synthetic OpenSky category, so the
        // best-effort ADSBDB enrichment has no bearing on this scenario. Stub
        // it rather than letting one unrelated public-provider 502 turn a
        // renderer/heading result into a console-cleanliness false negative.
        if (url.includes('/api/adsbdb/')) return Promise.resolve(jsonResponse({ found: false }));
        return realFetch(input, init);
      };
    }, TURN);

    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 60000, polling: 200 }
    );
    console.log('  App globals ready.');

    // ---- Model finder + course derivation, installed once ------------------
    await page.evaluate(() => {
      // Every sampler in this harness targets a KNOWN aircraft, and both the
      // fleet models and the tracked standalone model carry id=icao — so the
      // finder selects by id when given one. (The old nearest-to-tracked
      // fallback could mis-pick ANOTHER plane's model for a frame whenever
      // the tracked display position read null, which injected a one-frame
      // ~90° course spike into the sampled series — a measurement flake, not
      // a product regression.)
      window.__findTrackedModel = function (icao) {
        const v = window.__godsEyeView.viewer;
        const out = [];
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            const p = coll.get(i);
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.modelMatrix && typeof p.ready !== 'undefined') {
              if (icao && p.id !== icao) continue;
              out.push(p);
            }
          }
        };
        walk(v.scene.primitives);
        const shown = out.filter((m) => m.show && m.ready);
        if (icao) return shown[0] || null; // deterministic: the plane's own model or nothing
        const pool = shown.length ? shown : out;
        if (!pool.length) return null;
        const ent = v.trackedEntity;
        let tracked = null;
        if (ent && typeof ent.gevDisplayPosition === 'function') tracked = ent.gevDisplayPosition();
        if (!tracked) return pool[0];
        let best = null, bestD = Infinity;
        for (const m of pool) {
          const mm = m.modelMatrix;
          const dx = mm[12] - tracked.x, dy = mm[13] - tracked.y, dz = mm[14] - tracked.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = m; }
        }
        return best;
      };

      // Invert _modelMatrix (pitch=roll=0): local x in ENU = (cos h, −sin h, 0)
      // → h = atan2(−x·north, x·east); world course = h − headingOffsetDeg.
      window.__courseFromModelMatrix = function (mm, headingOffsetDeg) {
        const v = window.__godsEyeView.viewer;
        const C3 = v.camera.position.constructor;
        const Carto = v.camera.positionCartographic.constructor;
        const carto = Carto.fromCartesian(new C3(mm[12], mm[13], mm[14]));
        if (!carto) return null;
        const sLat = Math.sin(carto.latitude), cLat = Math.cos(carto.latitude);
        const sLon = Math.sin(carto.longitude), cLon = Math.cos(carto.longitude);
        const ex = -sLon, ey = cLon, ez = 0;
        const nx = -sLat * cLon, ny = -sLat * sLon, nz = cLat;
        const xe = mm[0] * ex + mm[1] * ey + mm[2] * ez;
        const xn = mm[0] * nx + mm[1] * ny + mm[2] * nz;
        const hDeg = (Math.atan2(-xn, xe) * 180) / Math.PI;
        return (((hDeg - headingOffsetDeg) % 360) + 360) % 360;
      };

      // Google Photorealistic Tiles can starve SwiftShader's ambient render
      // loop below one frame per second. Drive a bounded, fixed-cadence Viewer
      // render loop while sampling instead: it still invokes the production
      // preUpdate/preRender listeners and reads the rendered model matrix, but
      // does not depend on ambient render-loop scheduling for sample count.
      window.__sampleModelCourse = async function (icao, headingOffsetDeg, windowMs, stepMs = 100) {
        const v = window.__godsEyeView.viewer;
        const tileset = window.__godsEyeView.tileset;
        const out = [];
        const start = performance.now();
        const priorDefaultLoop = v.useDefaultRenderLoop;
        const priorTilesetShow = tileset?.show;
        v.useDefaultRenderLoop = false;
        // This harness measures the production model-matrix slew, not tile LOD.
        // Temporarily removing Google 3D Tiles from scene traversal keeps each
        // explicit render below the sampling cadence under SwiftShader. Restore
        // it before screenshots so the visual evidence remains photoreal.
        if (tileset) tileset.show = false;
        try {
          await new Promise((resolve) => {
            const remove = v.scene.preRender.addEventListener(() => {
              const m = window.__findTrackedModel(icao);
              const c = m ? window.__courseFromModelMatrix(m.modelMatrix, headingOffsetDeg) : null;
              out.push({ tMs: performance.now(), course: c, epochMs: Date.now() });
            });
            const step = () => {
              if (performance.now() - start >= windowMs) {
                remove();
                resolve();
                return;
              }
              v.render();
              setTimeout(step, stepMs);
            };
            step();
          });
        } finally {
          if (tileset) tileset.show = priorTilesetShow;
          v.useDefaultRenderLoop = priorDefaultLoop;
          v.scene.requestRender();
        }
        return out;
      };
    });

    // ---- Enable layers with fixes back-dated 32 s, then prime forward ------
    // First update() fires inside setEnabled, so the FIRST fix must already be
    // the oldest (history appends only monotonically-newer fix times).
    console.log('Priming turning history through the render delay (30 s / 15 s)...');
    const primed = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const v = window.__godsEyeView.viewer;
      window.__TURN.timeOffsetSec = -32;
      await dm.setEnabled('flights', true);
      await dm.setEnabled('military', true);
      const fl = dm.layers.get('flights').module;
      const mil = dm.layers.get('military').module;
      fl.setParams({ models3d: true });
      mil.setParams({ models3d: true });
      for (const off of [-24, -16, -8, 0]) {
        window.__TURN.timeOffsetSec = off;
        await fl.update(v);
        await mil.update(v);
      }
      window.__TURN.timeOffsetSec = 0;
      // Live driver: a fresh fix every 15 s from here on (the layers' own 30 s /
      // 15 s pollers add consistent extras — the shim serves arc truth at serve
      // time). 15 s × 3°/s = 45° course step per segment boundary.
      window.__TURN_DRIVER = setInterval(() => { fl.update(v); mil.update(v); }, 15000);
      return { fl: fl.getStats().count, mil: mil.getStats().count, hits: window.__TURN_HITS };
    });
    console.log(`  flights count=${primed.fl} military count=${primed.mil} | shim hits opensky=${primed.hits.opensky} mil=${primed.hits.mil}`);
    record('inject: turning synthetic planes ingested (both layers)', primed.fl > 0 && primed.mil > 0,
      `flights=${primed.fl} military=${primed.mil}`);
    if (!(primed.fl > 0 && primed.mil > 0)) { finish(); return; }

    // ========================================================================
    // Phase 1 — FLIGHTS layer: track TRN001, sample displayed course 30 s
    // ========================================================================
    console.log('\nPhase 1 — flights layer (airplane.glb, heading offset 180°)');
    await page.evaluate((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, TURN.flights[0].icao);

    const flModelUp = await page.waitForFunction((icao) => {
      const m = window.__findTrackedModel(icao);
      return !!(m && m.ready && m.show);
    }, { timeout: 40000, polling: 250 }, TURN.flights[0].icao).then(() => true).catch(() => false);
    record('flights: tracked 3D model rendered (ready+shown)', flModelUp, flModelUp ? 'model up' : 'model never became ready');
    if (!flModelUp) { finish(); return; }
    await sleep(1500); // let the follow camera + reconciliation settle

    const readoutObservation = await observeTrackedHostPaint(page);
    const readoutHost = await page.evaluate(() => ({
      dedicatedCanvas: Boolean(document.getElementById('tracked-readout')),
      hostCanvas: Boolean(document.getElementById('world-overlay-canvas')),
    }));
    const readoutSample = readoutObservation.sample || {};
    record(
      'tracked readout: host-painted model with no dedicated canvas',
      !readoutHost.dedicatedCanvas && readoutHost.hostCanvas
        && readoutObservation.observed
        && readoutSample.hasPresentationModel
        && readoutSample.entryCount === 1
        && readoutSample.painted >= 1,
      readoutObservation.observed
        ? `id=${readoutSample.entryId} entries=${readoutSample.entryCount} hostPainted=${readoutSample.painted} legacy=${readoutHost.dedicatedCanvas}`
        : `timeout history=${JSON.stringify(readoutObservation.history)} legacy=${readoutHost.dedicatedCanvas}`,
    );

    // Sample in preRender: this listener was added AFTER the layer's _fleetTick
    // (Cesium events fire in add order), so it reads the model matrix at the
    // same wall-clock instant the rate limiter advanced — no render-pass skew.
    const flSamples = await page.evaluate(
      (icao) => window.__sampleModelCourse(icao, 180, 40000),
      TURN.flights[0].icao,
    );
    analyze('flights', flSamples, {});

    // A5 — absolute alignment vs the analytic arc tangent at the DISPLAYED time
    // (render delay 30 s; the chord course lags the tangent by ≤ half a segment).
    {
      const last = [...flSamples].reverse().find((s) => Number.isFinite(s.course));
      const epochMs = await page.evaluate(() => window.__TURN.epochMs);
      if (last) {
        const tDispRel = (last.epochMs - epochMs) / 1000 - 30;
        const expected = arcState(TURN.flights[0], tDispRel).course;
        const err = Math.abs(norm180(last.course - expected));
        record('flights A5: displayed course aligned with arc tangent at displayed time (±35°)',
          err <= 35, `sampled ${last.course.toFixed(1)}° vs tangent ${expected.toFixed(1)}° (|err| ${err.toFixed(1)}°)`);
      } else {
        record('flights A5: displayed course aligned with arc tangent', false, 'no valid sample');
      }
    }

    // ---- Screenshots: two zoom levels × two orbit angles --------------------
    console.log('\n  Screenshots (turning plane tracked in 3D) → qa-shots/b3/');
    await page.evaluate(() => {
      window.__godsEyeView.styleManager._setDetectionMode('DENSE');
    });
    await sleep(800);
    const shots = [
      ['flights-far-orbitA.png', async () => { /* default follow framing */ }],
      ['flights-far-orbitB.png', () => page.evaluate(() => { window.__godsEyeView.viewer.camera.rotateRight(1.9); })],
      ['flights-near-orbitA.png', () => page.evaluate(() => {
        const cam = window.__godsEyeView.viewer.camera;
        // Synthetic cruise frame settles ~5.6 km out; leave ~430 m so model,
        // readout anchor, tracking line, and trail can be judged close-up.
        cam.rotateRight(-1.9); cam.zoomIn(5200);
      })],
      ['flights-near-orbitB.png', () => page.evaluate(() => { window.__godsEyeView.viewer.camera.rotateLeft(1.2); })],
    ];
    for (const [name, move] of shots) {
      try { await move(); } catch (e) { console.log(`    (camera move for ${name} failed: ${e.message})`); }
      await sleep(1200); // let a few frames render at the new pose
      await page.screenshot({ path: path.join(SHOT_DIR, name) });
      console.log(`    saved ${name}`);
    }
    await page.evaluate(() => {
      window.__godsEyeView.styleManager._setDetectionMode('OFF');
    });

    // ========================================================================
    // Phase 2 — MILITARY layer: track TRNMIL1 (flights layer auto-clears)
    // ========================================================================
    console.log('\nPhase 2 — military layer (jet.glb, heading offset 180°)');
    await page.evaluate((hex) => {
      window.__godsEyeView.dataManager.layers.get('military').module.trackById(hex);
    }, TURN.military[0].hex);

    const milModelUp = await page.waitForFunction((hex) => {
      const m = window.__findTrackedModel(hex);
      return !!(m && m.ready && m.show);
    }, { timeout: 40000, polling: 250 }, TURN.military[0].hex).then(() => true).catch(() => false);
    record('military: tracked 3D model rendered (ready+shown)', milModelUp, milModelUp ? 'model up' : 'model never became ready');
    if (milModelUp) {
      await sleep(1500);
      const milSamples = await page.evaluate(
        (icao) => window.__sampleModelCourse(icao, 180, 40000),
        TURN.military[0].hex,
      );
      analyze('military', milSamples, {});
      {
        const last = [...milSamples].reverse().find((s) => Number.isFinite(s.course));
        const epochMs = await page.evaluate(() => window.__TURN.epochMs);
        if (last) {
          const tDispRel = (last.epochMs - epochMs) / 1000 - 15; // military render delay 15 s
          const expected = arcState(TURN.military[0], tDispRel).course;
          const err = Math.abs(norm180(last.course - expected));
          record('military A5: displayed course aligned with arc tangent at displayed time (±35°)',
            err <= 35, `sampled ${last.course.toFixed(1)}° vs tangent ${expected.toFixed(1)}° (|err| ${err.toFixed(1)}°)`);
        } else {
          record('military A5: displayed course aligned with arc tangent', false, 'no valid sample');
        }
      }
      await page.evaluate(() => {
        window.__godsEyeView.styleManager._setDetectionMode('DENSE');
      });
      await sleep(800);
      for (const [name, move] of [
        ['military-orbitA.png', async () => { }],
        ['military-orbitB.png', () => page.evaluate(() => { window.__godsEyeView.viewer.camera.rotateRight(1.6); })],
        ['military-near-orbitA.png', () => page.evaluate(() => {
          const cam = window.__godsEyeView.viewer.camera;
          // 12,000 ft synthetic frame settles ~6.3 km out; leave ~630 m.
          cam.rotateLeft(1.6); cam.zoomIn(5700);
        })],
        ['military-near-orbitB.png', () => page.evaluate(() => {
          window.__godsEyeView.viewer.camera.rotateRight(1.2);
        })],
      ]) {
        try { await move(); } catch (e) { console.log(`    (camera move for ${name} failed: ${e.message})`); }
        await sleep(1200);
        await page.screenshot({ path: path.join(SHOT_DIR, name) });
        console.log(`    saved ${name}`);
      }
      await page.evaluate(() => {
        window.__godsEyeView.styleManager._setDetectionMode('OFF');
      });
    }

    // ========================================================================
    // Low-speed phases (heading-v2). Shared sampler: same preRender discipline
    // as phases 1–2 (reads the tracked model matrix at the instant the rate
    // limiter advanced). Both scenarios live on the flights layer (offset 180°).
    // ========================================================================
    const sampleCourse = (offsetDeg, windowMs, icao, stepMs = 100) => page.evaluate(
      ({ id, offset, duration, step }) => window.__sampleModelCourse(id, offset, duration, step),
      { id: icao, offset: offsetDeg, duration: windowMs, step: stepMs },
    );

    const trackFlightsAndWaitModel = async (icao, label) => {
      await page.evaluate((id) => {
        window.__godsEyeView.dataManager.layers.get('flights').module.trackById(id);
      }, icao);
      const up = await page.waitForFunction((id) => {
        const m = window.__findTrackedModel(id);
        return !!(m && m.ready && m.show);
      }, { timeout: 40000, polling: 250 }, icao).then(() => true).catch(() => false);
      record(`${label}: tracked 3D model rendered (ready+shown)`, up, up ? 'model up' : 'model never became ready');
      return up;
    };

    // ---- Phase 3 — hovering helicopter --------------------------------------
    console.log('\nPhase 3 — hovering helicopter (klass=helicopter, drift ~4 m, track flips ±45°)');
    if (await trackFlightsAndWaitModel(TURN.hover.icao, 'hover-heli')) {
      await sleep(1500);
      const heliSamples = await sampleCourse(180, 35000, TURN.hover.icao);
      analyzeHover('hover-heli', heliSamples, {});
      for (const [name, waitMs] of [['hover-heli-T0.png', 0], ['hover-heli-T8s.png', 8000]]) {
        if (waitMs) await sleep(waitMs);
        await page.screenshot({ path: path.join(SHOT_DIR_V2, name) });
        console.log(`    saved ${name}`);
      }
    }

    // ---- Phase 4 — 25 kt plane in a continuous 4°/s right turn --------------
    console.log('\nPhase 4 — slow plane in a tight turn (25 kt, 4°/s, R=184 m)');
    if (await trackFlightsAndWaitModel(TURN.slow.icao, 'slow-turn')) {
      await sleep(1500);
      const slowSamples = await sampleCourse(180, 40000, TURN.slow.icao);
      analyzeSlowTurn('slow-turn', slowSamples, { scoreProgress: false });
      // Exercise the production dt clamp with render gaps above
      // COURSE_SLEW_DT_MAX_SEC. The regular 10 Hz sampling path cannot enter
      // this regime, so it would miss a slow ambient-loop recovery spike.
      const slowCadenceSamples = await sampleCourse(180, 18000, TURN.slow.icao, 600);
      analyzeSlowTurn('slow-turn / 600 ms cadence', slowCadenceSamples, {
        minSamples: 6,
        minWindowSec: 12,
        maxRateDps: 20,
        maxReversalDeg: 8,
      });
      for (const [name, move] of [
        ['slowturn-far.png', async () => { /* default follow framing */ }],
        ['slowturn-near.png', () => page.evaluate(() => { window.__godsEyeView.viewer.camera.zoomIn(2500); })],
      ]) {
        try { await move(); } catch (e) { console.log(`    (camera move for ${name} failed: ${e.message})`); }
        await sleep(1200);
        await page.screenshot({ path: path.join(SHOT_DIR_V2, name) });
        console.log(`    saved ${name}`);
      }
    }

    // ========================================================================
    // Phase 5 — tracked↔fleet course-handoff consistency (65 kt helicopter).
    // The tracked standalone model AND the fleet model both carry id=icao, so
    // one finder reads the RENDERED course through the whole transition.
    // ========================================================================
    console.log('\nPhase 5 — 65 kt helicopter: tracked↔fleet course handoff (click / click-away)');
    await page.evaluate(() => {
      window.__findModelByIcao = function (icao) {
        const v = window.__godsEyeView.viewer;
        const out = [];
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p;
            try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.modelMatrix && typeof p.ready !== 'undefined' && p.id === icao && p.show && p.ready) out.push(p);
          }
        };
        walk(v.scene.primitives);
        return out[0] || null;
      };
    });

    // Activate the heli in the feed now (kept out of phases 1–4), ingest it,
    // and let it fly UNTRACKED for a few seconds so the fleet pass owns its
    // display-course state first — the exact state the click must hand off.
    // 3D OFF for C1: the billboard is the rendered visual on both sides of
    // the untrack, so the screen rotation IS what the user sees flip (or not).
    await page.evaluate(async () => {
      window.__TURN.heli65.active = true;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      fl.setParams({ models3d: false });
      await fl.update(window.__godsEyeView.viewer); // ingest the first heli fix
    });
    await sleep(4000); // several fleet ticks establish the heli's fleet course
    await page.evaluate((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, TURN.heli65.icao);
    const heliTracked = await page.waitForFunction((icao) => {
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const ti = fl.getTrackedInfo();
      return !!(ti && ti.icao24 === icao && window.__godsEyeView.viewer.trackedEntity);
    }, { timeout: 15000, polling: 250 }, TURN.heli65.icao).then(() => true).catch(() => false);
    record('heli65: tracking engaged (2D billboard mode)', heliTracked,
      heliTracked ? 'tracked' : 'tracking never engaged');

    if (heliTracked) {
      // Stay tracked for 60 s: pre-fix, the fleet's per-icao course entry
      // FROZE at click time, so a snapped handoff replays ~2°/s × 60 s ≈ 120°
      // of divergence; the post-fix shared state must hand off seamlessly.
      console.log('  accumulating tracked time (60 s) so a frozen fleet entry would diverge ~120°...');
      await sleep(60000);

      // C1 — click-away. Sample the rendered SCREEN rotation per preRender:
      // tracked entity rotation callback while tracked, fleet billboard
      // rotation after. The release-in-place keeps the camera static, so
      // rotation deltas across the boundary are course deltas.
      const c1 = await page.evaluate(async ({ icao, actionAtMs, windowMs }) => {
        const v = window.__godsEyeView.viewer;
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        const findFleetBillboard = (id) => {
          const out = [];
          const walk = (coll) => {
            const n = coll.length;
            for (let i = 0; i < n; i++) {
              let p;
              try { p = coll.get(i); } catch { continue; }
              if (!p) continue;
              if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
              if (p.image !== undefined && p.alignedAxis !== undefined && p.id === id && p.show) out.push(p);
            }
          };
          walk(v.scene.primitives);
          return out[0] || null;
        };
        const out = [];
        const start = performance.now();
        let actionTMs = null;
        setTimeout(() => { actionTMs = performance.now(); fl.stopTracking(); }, actionAtMs);
        await new Promise((resolve) => {
          const remove = v.scene.preRender.addEventListener(() => {
            let rotRad = null;
            const ent = v.trackedEntity;
            if (ent && ent.billboard && ent.billboard.rotation) {
              try { rotRad = ent.billboard.rotation.getValue(v.clock.currentTime); } catch { rotRad = null; }
            } else {
              const bb = findFleetBillboard(icao);
              if (bb) rotRad = bb.rotation;
            }
            out.push({ tMs: performance.now(), course: rotRad == null ? null : (rotRad * 180) / Math.PI });
            if (performance.now() - start >= windowMs) { remove(); resolve(); }
          });
          v.scene.requestRender();
        });
        return { samples: out, actionTMs };
      }, { icao: TURN.heli65.icao, actionAtMs: 14000, windowMs: 40000 });
      analyzeHandoff('heli65 C1 (click-away, screen rotation)', c1, {
        truthDps: TURN.heli65.turnDps, stepExcessTolDeg: 15, rateTolDps: 15,
        // Low-fps tolerant: SwiftShader can drop under 1 fps near ground-level
        // 3D tiles. Step excess is truth-compensated so long pairs stay exact;
        // the boundary pair (which always spans the click) carries the snap.
        postWindowMs: 10000, minSamples: 12, pairDtCeilMs: 8000, rateDtFloorMs: 1000,
      });

      // C2 — click. 3D back ON: the fleet model (camera is already parked a
      // few km out by the release-in-place) then the tracked standalone model
      // both carry id=icao, and the model matrix gives the WORLD course, so
      // the re-track camera flight cannot contaminate the series.
      await page.evaluate(() => {
        window.__godsEyeView.dataManager.layers.get('flights').module.setParams({ models3d: true });
      });
      const fleetModelUp = await page.evaluate(async (icao) => {
        const v = window.__godsEyeView.viewer;
        const tileset = window.__godsEyeView.tileset;
        const priorDefaultLoop = v.useDefaultRenderLoop;
        const priorTilesetShow = tileset?.show;
        v.useDefaultRenderLoop = false;
        if (tileset) tileset.show = false;
        try {
          const deadline = performance.now() + 40000;
          while (performance.now() < deadline) {
            v.render();
            if (window.__findModelByIcao(icao)) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return false;
        } finally {
          if (tileset) tileset.show = priorTilesetShow;
          v.useDefaultRenderLoop = priorDefaultLoop;
          v.scene.requestRender();
        }
      }, TURN.heli65.icao);
      if (!fleetModelUp) {
        record('heli65 C2 (click): fleet model rendered before re-track', false, 'fleet model never became ready');
      } else {
        const c2 = await page.evaluate(async ({ icao, offsetDeg, actionAtMs, windowMs }) => {
          const v = window.__godsEyeView.viewer;
          const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
          const out = [];
          const start = performance.now();
          let actionTMs = null;
          setTimeout(() => { actionTMs = performance.now(); fl.trackById(icao); }, actionAtMs);
          await new Promise((resolve) => {
            const remove = v.scene.preRender.addEventListener(() => {
              const m = window.__findModelByIcao(icao);
              const c = m ? window.__courseFromModelMatrix(m.modelMatrix, offsetDeg) : null;
              out.push({ tMs: performance.now(), course: c });
              if (performance.now() - start >= windowMs) { remove(); resolve(); }
            });
            v.scene.requestRender();
          });
          return { samples: out, actionTMs };
        }, { icao: TURN.heli65.icao, offsetDeg: 180, actionAtMs: 12000, windowMs: 35000 });
        analyzeHandoff('heli65 C2 (click, model course)', c2, {
          truthDps: TURN.heli65.turnDps, stepExcessTolDeg: 15, rateTolDps: 15,
          postWindowMs: 10000, minSamples: 12, pairDtCeilMs: 8000,
        });
      }

      await page.evaluate(() => {
        window.__godsEyeView.dataManager.layers.get('flights').module.stopTracking();
      });
    }

    record('no console errors during QA run', consoleErrors.length === 0,
      consoleErrors.length
        ? `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}; responses=${failedResponses.slice(0, 3).join(' | ') || 'unidentified'}`
        : 'clean');

    finish();
  } finally {
    await browser.close();
  }

  function finish() {
    const failed = results.filter((r) => r.ok === false);
    const passed = results.filter((r) => r.ok === true);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  RESULT: ${passed.length} passed, ${failed.length} failed`);
    console.log(`${'─'.repeat(60)}\n`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  }
}

main().catch((err) => {
  console.error('\n\x1b[31mQA harness error:\x1b[0m', err && err.stack ? err.stack : err);
  process.exit(2);
});
