#!/usr/bin/env node
/**
 * qa-perf — render-governor regression gate (perf wave 2).
 *
 * Asserts the governor's observable contract with RELATIVE frame-count
 * assertions (SwiftShader-safe; no wall-clock GPU numbers):
 *
 *  1. Idle + zero layers + parked camera → the scene stops rendering
 *     (near-zero postRender fires over a settle-then-observe window).
 *  2. A discrete mutation while idle (style slider write routed through
 *     governorRequestRender) → at least one render, then settles again.
 *  3. Camera movement while idle → renders happen (Cesium-native path).
 *  4. Flights enabled → continuous mode (postRender cadence ≈ rAF cadence,
 *     and ≥5× the idle count over the same window).
 *  5. Flights disabled again → back to idle (near-zero fires).
 *  6. Governor diagnostics agree with the mode at every step.
 *
 * ── WHAT THE IDLE WINDOWS MEASURE, AND WHY THEY WAIT ────────────────────────
 *
 * The idle checks (1 and 5) measure the STEADY-STATE floor: what a parked scene
 * costs once it has settled. They do not measure how long settling takes, so the
 * counted window has to begin AFTER settling — and "after" is a stronger
 * condition than "nothing is happening right now".
 *
 * That distinction became load-bearing when detection stopped holding the render
 * loop open (2026-08-22) and became a default. With a paint lane active, the
 * world-overlay host honours its occluder observers with frames: chrome that
 * changes SIZE resizes an occluder, `markLayoutDirty` fires, and that becomes a
 * `requestRender`. While detection forced continuous mode this was invisible.
 * Event-driven, it shows up as renders.
 *
 * The specific contaminant, pinned with stack traces on this tree, is triggered
 * by THIS HARNESS'S OWN SETUP. Disabling every layer publishes a `visibility`
 * change; the HUD subscribes to that and marks its semantic summary dirty
 * (`src/hud.js`), and the summary refreshes on a 15-SECOND interval
 * (`HUD_SUMMARY_INTERVAL_MS`). So up to 15 s after the teardown a tick fetches a
 * new summary and TYPES it in with a typewriter animation; the growing text
 * reflows `.hud-corner.hud-top-left`, an occluder, and the host turns that
 * reflow into a handful of frames. Two instrumented runs (150 s and 180 s
 * watches) agree to the second: the teardown lands at 15 s, the burst at 31 s —
 * seven frames in that one second — which is 16 s after the teardown and 4 s
 * INTO the window the old settle had already started counting. Neither run then
 * saw a single further render, across 146 s and 176 s respectively. It is a
 * one-shot: the tick that fetches also clears the summary's dirty flag and
 * commits its context signature, so every later tick returns early.
 *
 * Waiting for "an empty second" cannot survive that, because the scene really IS
 * empty for the ~15 s between the teardown and the tick that notices it. So the
 * settle below requires a quiet RUN LONGER THAN ONE FULL SUMMARY TICK, and that
 * run resets on any activity. Quiet then means something stronger and checkable:
 * a complete refresh period has elapsed in which the app looked at its new state
 * and found nothing to do. The length is derived from the app's own cadence
 * rather than tuned against a flake rate — if that interval changes, this moves
 * with it.
 *
 * The threshold inside the window (≤4 fires / 5 s) is untouched. The teeth live
 * in the WAIT, not the threshold: a scene rendering every frame never produces an
 * empty second at all, so the bounded wait expires and FAILS. Quiet that never
 * arrives IS the failure, which is why the timeout is an assertion rather than a
 * fall-through — and it is what keeps this honest if the churn ever stops being a
 * one-shot. It would: when `/api/openai/hud-summary` is unreachable the summary
 * stays dirty and re-types every 15 s, so that machine gets a loud repeatable
 * failure here rather than a coin flip.
 *
 * The underlying fix belongs to the host, not to this harness: an active lane
 * with nothing to place is not paint work and should not be honoured with a
 * frame. That is worldOverlay surgery — see the post-launch ledger entry
 * "world-overlay honours occluder churn as paint work" in
 * the performance contract in `docs/CURRENT-STATE.md`.
 *
 * Usage: node scripts/qa-perf.mjs [--url http://localhost:4173]
 * Requires a running dev server. Headless; flags disable occlusion
 * throttling so rAF cadence is trustworthy (hidden-pane gotcha).
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4173';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    // Never let background/occlusion throttling freeze rAF or timers — the
    // measurements below depend on an honest frame clock.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  // Boot flyTo + tile warm + all deferred init.
  await new Promise((r) => setTimeout(r, 15_000));

  // Park deterministically and disable every layer.
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    const ell = v.scene.globe.ellipsoid;
    v.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: -97.74 * Math.PI / 180, latitude: 30.27 * Math.PI / 180, height: 60_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) { try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* gate reports via counts */ } }
    }
  });
  // Let tiles finish + fades settle + the settling frames drain.
  await new Promise((r) => setTimeout(r, 12_000));

  /** Count scene postRender fires and rAF ticks over windowMs. */
  const countFrames = (windowMs) => page.evaluate((ms) => new Promise((resolve) => {
    const scene = window.__godsEyeView.viewer.scene;
    let renders = 0; let rafs = 0;
    const remove = scene.postRender.addEventListener(() => { renders += 1; });
    const t0 = performance.now();
    const tick = () => {
      rafs += 1;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else { remove(); resolve({ renders, rafs }); }
    };
    requestAnimationFrame(tick);
  }), windowMs);

  const diag = () => page.evaluate(() => window.__godsEyeView.getRenderGovernorDiagnostics?.()
    || window.__gevRenderGovernor?.getDiagnostics?.() || null);

  /**
   * The HUD's semantic summary refreshes on this cadence (`src/hud.js`,
   * `HUD_SUMMARY_INTERVAL_MS`). A layer-visibility change marks it dirty, and
   * the tick that picks that up types the new text in — reflowing an occluder
   * and, with a paint lane active, costing frames. Mirrored rather than
   * imported because this harness runs against the built app, not the module.
   */
  const HUD_SUMMARY_INTERVAL_MS = 15_000;
  /** One full refresh period, plus a second of margin, in 1 s windows. */
  const QUIET_RUN_WINDOWS = Math.ceil(HUD_SUMMARY_INTERVAL_MS / 1_000) + 1;

  /**
   * Wait until the scene is genuinely settled, and report whether it ever was.
   * This is the START of the idle windows below — see the header.
   *
   * Requires a CONSECUTIVE RUN of empty one-second windows at least one full
   * summary refresh period long, and resets that run on any activity. One empty
   * window — or three — proves nothing here: the scene is genuinely idle for the
   * whole gap between a teardown and the tick that notices it, so a short
   * confirmation happily reports "quiet" moments before the typewriter fires.
   * A run longer than the period cannot straddle that gap: it either contains
   * the burst, and restarts, or it postdates it.
   *
   * `quiet: false` is a FAILURE, not a fall-through: a scene rendering every
   * frame never produces an empty window at all, so this is what catches a real
   * hot loop — and equally a contaminant that has stopped being a one-shot. The
   * bound stays comfortably longer than settling takes and comfortably shorter
   * than forever: worst case is one interrupted run, the burst itself, then a
   * clean run (~55 s), against a 120 s ceiling.
   */
  const settleUntilQuiet = async (maxMs = 120_000, requiredConsecutive = QUIET_RUN_WINDOWS) => {
    const deadline = Date.now() + maxMs;
    let windows = 0;
    let consecutive = 0;
    let busiest = 0;
    let restarts = 0;
    while (Date.now() < deadline) {
      windows += 1;
      const { renders } = await countFrames(1_000);
      busiest = Math.max(busiest, renders);
      if (renders === 0) consecutive += 1;
      else { if (consecutive > 0) restarts += 1; consecutive = 0; }
      if (consecutive >= requiredConsecutive) {
        return { quiet: true, windows, busiest, restarts, ranFor: consecutive, needRun: requiredConsecutive };
      }
    }
    // A failure here reads as "never held N empty seconds in a row, best run was
    // M, restarted R times, busiest window was B" — enough to tell a hot loop
    // from a contaminant that has stopped being a one-shot.
    return { quiet: false, windows, busiest, restarts, ranFor: consecutive, needRun: requiredConsecutive };
  };

  // ── 1. idle: near-zero renders ────────────────────────────────────────
  const idleSettle = await settleUntilQuiet();
  const idle = await countFrames(5_000);
  const d1 = await diag();
  // Quiet that never arrives is the hot-loop failure — assert it, do not skip it.
  check('the parked scene holds a settled quiet run before the idle window is counted', idleSettle.quiet, idleSettle);
  check('governor reports idle mode with zero layers', d1?.mode === 'idle', d1);
  check('idle parked scene stops rendering (≤4 fires / 5s)', idle.renders <= 4, idle);

  // ── 1b. detection at its FIRST-RUN DEFAULT must not hold the parked scene ─
  //
  // Detection became ON by default on 2026-08-22. It used to take an
  // unconditional continuous-render hold whenever it was on — nobody felt that
  // while it defaulted OFF, but as a DEFAULT it would pin every idle first-run
  // tab at 60 fps forever, defeating this governor outright. The hold is gone
  // (`src/data/detectionRenderDemand.js`): detection repaints on change and asks
  // for single frames only while a bounded animation is running.
  //
  // This is the gate for that. The scene above is parked with zero layers, so
  // detection-on and detection-off must yield the SAME near-zero render count.
  const detectionDefault = await page.evaluate(
    () => window.__godsEyeView.styleManager.getDetectionState?.() || null,
  );
  check(
    'precondition: detection is ON at its first-run default (Dense @ 75)',
    detectionDefault?.detectionMode === 'DENSE' && detectionDefault?.densityPct === 75,
    detectionDefault,
  );
  check(
    'detection ON takes NO continuous-render hold',
    d1?.mode === 'idle' && !d1.holds.includes('detection'),
    d1,
  );
  // The control: the same window with detection explicitly OFF.
  await page.evaluate(() => { window.__godsEyeView.styleManager._setDetectionMode('OFF'); });
  await new Promise((r) => setTimeout(r, 1_500)); // let any fade chain terminate
  const idleDetectOff = await countFrames(5_000);
  check('idle baseline with detection OFF (≤4 fires / 5s)', idleDetectOff.renders <= 4, idleDetectOff);
  // Back to the default. A regression here is the entire point of this gate: the
  // old hold produced a full 60 fps window instead of near-zero.
  await page.evaluate(() => { window.__godsEyeView.styleManager._setDetectionMode('DENSE'); });
  await new Promise((r) => setTimeout(r, 1_500));
  const idleDetectOn = await countFrames(5_000);
  const dDetect = await diag();
  check('idle parked scene with detection ON (≤4 fires / 5s)', idleDetectOn.renders <= 4, idleDetectOn);
  check(
    'detection ON costs no more idle frames than detection OFF',
    idleDetectOn.renders <= idleDetectOff.renders + 2,
    { on: idleDetectOn.renders, off: idleDetectOff.renders },
  );
  check(
    'governor still idle with detection ON',
    dDetect?.mode === 'idle' && !dDetect.holds.includes('detection'),
    dDetect,
  );
  // …and the overlay must still be LIVE, not merely quiet: with detection on, a
  // camera nudge has to repaint promptly, or "idle" would only mean "stale".
  const detectMove = await Promise.all([
    countFrames(2_500),
    page.evaluate(() => new Promise((resolve) => {
      const v = window.__godsEyeView.viewer;
      let steps = 0;
      const id = setInterval(() => {
        v.camera.moveForward(50);
        steps += 1;
        if (steps >= 20) { clearInterval(id); resolve(true); }
      }, 60);
    })),
  ]).then(([frames]) => frames);
  check(
    'detection ON still repaints promptly on camera motion (≥10 / 2.5s)',
    detectMove.renders >= 10,
    detectMove,
  );
  // A render count alone proves the SCENE rendered, not that the detection
  // painter ran — a painter disabled outright would score a perfect idle and
  // sail through every check above. Count the painter's own frames across the
  // same kind of motion, so the teeth reach the thing this change touched.
  const detectPainted = await page.evaluate(() => new Promise((resolve) => {
    const gev = window.__godsEyeView;
    const before = gev.styleManager.getDetectionDiagnostics?.()?.frameCount ?? null;
    let paints = 0;
    // The diagnostics object is rebuilt on every detection paint, so a fresh
    // identity is one painted frame. Sampling it per scene frame is enough to
    // tell "painting" from "silent" without reaching into module internals.
    let last = gev.styleManager.getDetectionDiagnostics?.();
    const remove = gev.viewer.scene.postRender.addEventListener(() => {
      const now = gev.styleManager.getDetectionDiagnostics?.();
      if (now && now !== last) { paints += 1; last = now; }
    });
    let steps = 0;
    const id = setInterval(() => {
      gev.viewer.camera.moveForward(50);
      steps += 1;
      if (steps >= 20) {
        clearInterval(id);
        setTimeout(() => {
          remove();
          resolve({ paints, before, after: gev.styleManager.getDetectionDiagnostics?.()?.frameCount ?? null });
        }, 400);
      }
    }, 60);
  }));
  check(
    'detection is still PAINTING, not merely quiet (≥5 painted frames on motion)',
    detectPainted.paints >= 5,
    detectPainted,
  );
  await new Promise((r) => setTimeout(r, 3_000)); // settle back to parked

  // ── 2. a REAL slider mutation renders (full UI → uniform → request path) ─
  const afterMutation = await Promise.all([
    countFrames(2_500),
    page.evaluate(() => new Promise((resolve) => setTimeout(() => {
      // Drive the actual sharpen slider: input event → handler →
      // _applySharpenIntensity → governorRequestRender. Proves the wiring,
      // not just the facade.
      const slider = document.getElementById('sharpen-intensity-slider');
      if (!slider) { resolve({ ok: false }); return; }
      slider.value = String(Math.min(100, Number(slider.value) + 7));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      resolve({ ok: true });
    }, 500))),
  ]).then(([frames]) => frames);
  check('real slider mutation while idle renders ≥1 and ≤10 frames', afterMutation.renders >= 1 && afterMutation.renders <= 10, afterMutation);

  // ── 2b. animated style cycle: style-anim holds, then releases ─────────
  await page.evaluate(() => { window.__godsEyeView.styleManager.setStyle('retro'); });
  await new Promise((r) => setTimeout(r, 900)); // crossfade + first ticks
  const dAnim = await diag();
  check('animated style takes the style-anim hold (continuous)', dAnim?.mode === 'continuous' && dAnim.holds.includes('style-anim'), dAnim);
  const animFrames = await countFrames(2_000);
  check('animated style keeps frames flowing (≥50% rAF)', animFrames.renders >= animFrames.rafs * 0.5, animFrames);
  // Returning to normal keeps detection ON by design (it is the default, and
  // detection persists across style switches). Since 2026-08-22 detection holds
  // nothing, so this asserts the strictly harder thing: the scene returns to
  // idle with detection still ON — where before it could only go idle by also
  // turning detection off.
  await page.evaluate(() => { window.__godsEyeView.styleManager.setStyle('normal'); });
  await new Promise((r) => setTimeout(r, 1_500)); // fade out + loop self-stop
  const dAnimOff = await diag();
  const detectionStillOn = await page.evaluate(
    () => window.__godsEyeView.styleManager.getDetectionState?.()?.detectionMode || null,
  );
  check(
    'style-anim hold releases and the scene goes idle with detection still ON',
    dAnimOff?.mode === 'idle'
      && !dAnimOff.holds.includes('style-anim')
      && !dAnimOff.holds.includes('detection')
      && detectionStillOn !== 'OFF',
    { diag: dAnimOff, detection: detectionStillOn },
  );

  // ── 2c. satellites holder enters and leaves diagnostics ───────────────
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('satellites', true, { origin: 'user' });
  });
  const dSat = await diag();
  check('satellites enable registers its holder', dSat?.holds.includes('satellites'), dSat);
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('satellites', false, { origin: 'user' });
  });
  await new Promise((r) => setTimeout(r, 2_000));
  const dSatOff = await diag();
  check('satellites disable releases its holder', !dSatOff?.holds.includes('satellites'), dSatOff);

  // ── 3. camera movement renders (Cesium-native path) ───────────────────
  const duringMove = await Promise.all([
    countFrames(2_500),
    page.evaluate(() => new Promise((resolve) => {
      const v = window.__godsEyeView.viewer;
      let steps = 0;
      const id = setInterval(() => {
        v.camera.moveForward(50);
        steps += 1;
        if (steps >= 20) { clearInterval(id); resolve(true); }
      }, 60);
    })),
  ]).then(([frames]) => frames);
  check('camera movement while idle produces renders (≥10 / 2.5s)', duringMove.renders >= 10, duringMove);
  await new Promise((r) => setTimeout(r, 3_000)); // settle

  // ── 4. flights enabled → continuous ───────────────────────────────────
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('flights', true, { origin: 'user' });
  });
  await new Promise((r) => setTimeout(r, 5_000));
  const active = await countFrames(5_000);
  const d4 = await diag();
  check('governor reports continuous mode with flights on', d4?.mode === 'continuous', d4);
  check('flights-on cadence ≈ rAF cadence (≥70%)', active.renders >= active.rafs * 0.7, active);
  check('flights-on renders ≥5× idle renders', active.renders >= Math.max(1, idle.renders) * 5, { active: active.renders, idle: idle.renders });

  // ── 5. flights disabled → idle again ──────────────────────────────────
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('flights', false, { origin: 'user' });
  });
  // Deselect flows, fades, and the chrome churn the overlay host re-evaluates
  // its occluders against all have to drain first — and this teardown, like the
  // one in the setup above, marks the HUD summary dirty, so the same deferred
  // typewriter is still ahead of us. Same rule: hold a quiet run longer than one
  // refresh period before counting anything.
  const teardownSettle = await settleUntilQuiet();
  const idleAgain = await countFrames(5_000);
  const d5 = await diag();
  check('the scene holds a settled quiet run again before the second idle window', teardownSettle.quiet, teardownSettle);
  check('governor returns to idle after disable', d5?.mode === 'idle', d5);
  check('scene stops rendering again (≤4 fires / 5s)', idleAgain.renders <= 4, idleAgain);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-perf: ${passed}/${results.length} passed`);
console.log(`RESULT: ${passed} passed, ${results.length - passed} failed, 0 skipped`);
process.exit(passed === results.length ? 0 : 1);
