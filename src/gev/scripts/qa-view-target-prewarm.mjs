#!/usr/bin/env node
/**
 * Regression proof for the view-target prewarm crash.
 *
 * `getViewTargetCartographic()` converts whatever `scene.pickPosition()` hands
 * back into a Cartographic. Over empty sky the depth sample is degenerate, the
 * pick yields a non-finite / zero-magnitude Cartesian, and
 * `Cartographic.fromCartesian` throws `DeveloperError: normalized result is not
 * a number`. Because the prewarm runs inside `requestIdleCallback`, the throw
 * escapes as an UNCAUGHT page error on a plain camera flight — a red console
 * error on the demo path, with no scene and no tracking involved.
 *
 * This harness flies the camera the way the demo does and asserts the flight
 * produces zero uncaught errors and zero unhandled rejections.
 *
 *   QA_BASE_URL=http://localhost:4173 node scripts/qa-view-target-prewarm.mjs
 *
 * `QA_LABEL=before` names the evidence files so a before/after pair can sit
 * side by side in qa-shots/prewarm/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(repoRoot, 'qa-shots', 'prewarm');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const label = process.env.QA_LABEL || 'after';
const headful = process.argv.includes('--headful');
fs.mkdirSync(shotsDir, { recursive: true });

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox'],
});
const page = await browser.newPage();
const failures = [];
const pageErrors = [];
const consoleErrors = [];
// Keep the message AND the stack: an ownerless promise rejection is reported
// here with an "Uncaught (in promise)" message but a stack that does not say
// so, while a Cesium DeveloperError puts the useful frames only in the stack.
page.on('pageerror', (error) => pageErrors.push(
  `${String(error?.message || error)}\n${String(error?.stack || '')}`.trim(),
));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/Failed to load resource/i.test(text)) return;
  consoleErrors.push(text);
});

// Unhandled rejections do not surface through `pageerror`, so capture them in
// the page and read the buffer back after the flight.
await page.evaluateOnNewDocument(() => {
  window.__qaPrewarmRejections = [];
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__qaPrewarmRejections.push(String(reason?.stack || reason?.message || reason));
  });
});

const check = (name, passed, detail) => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

/** High, straight-down, and horizon-grazing views all miss the rendered mesh. */
const FLIGHT_LEGS = [
  { name: 'austin-high', lon: -97.7431, lat: 30.2672, height: 900_000, pitch: -90 },
  { name: 'ocean-horizon', lon: -140.0, lat: 5.0, height: 2_500_000, pitch: -12 },
  { name: 'polar-limb', lon: 10.0, lat: 82.0, height: 6_000_000, pitch: -20 },
  { name: 'globe-out', lon: -30.0, lat: 12.0, height: 14_000_000, pitch: -90 },
];

let rejections = [];
try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, { timeout: 90_000 });
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  // Boot noise (tile / network warm-up) is not what this harness is about.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  pageErrors.length = 0;
  consoleErrors.length = 0;
  await page.evaluate(() => { window.__qaPrewarmRejections.length = 0; });

  const legReports = [];
  for (const leg of FLIGHT_LEGS) {
    const report = await page.evaluate(async (spec) => {
      const { viewer } = window.__godsEyeView;
      // No window.Cesium global (qa-cctv-v2 / qa-height-datum precedent) —
      // borrow Cartesian3's statics off a live camera-position instance.
      const Cartesian3 = viewer.camera.position.constructor;
      await new Promise((resolve) => {
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(spec.lon, spec.lat, spec.height),
          orientation: { heading: 0, pitch: (spec.pitch * Math.PI) / 180, roll: 0 },
          duration: 1.2,
          complete: resolve,
          cancel: resolve,
        });
      });
      // Let moveEnd (120 ms debounce) + requestIdleCallback (500 ms timeout) run.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // Record what the center pick actually yields so the root cause is
      // visible in the evidence dump rather than merely asserted.
      const scene = viewer.scene;
      const canvas = scene.canvas;
      const center = {
        x: (canvas.clientWidth || canvas.width) / 2,
        y: (canvas.clientHeight || canvas.height) / 2,
      };
      let picked;
      try {
        const raw = scene.pickPosition(center);
        picked = raw ? { x: raw.x, y: raw.y, z: raw.z } : null;
      } catch (error) {
        picked = { threw: String(error?.message || error) };
      }
      return { leg: spec.name, picked };
    }, leg);
    legReports.push(report);
    console.log(`  · ${report.leg}: center pick = ${JSON.stringify(report.picked)}`);
  }

  await page.screenshot({ path: path.join(shotsDir, `${label}-final-view.png`) });

  // ── Phase 2: the degenerate depth pick, injected ──────────────────────────
  // A depth pick over empty sky can hand back a Cartesian that is not a place.
  // Cesium produces those only under conditions this harness cannot schedule
  // reliably, so the precondition is injected directly: replace
  // `scene.pickPosition` with one that returns each degenerate shape in turn.
  // Everything downstream — the moveEnd prewarm inside requestIdleCallback and
  // the HUD summary interval — is the real shipped code.
  const injection = await page.evaluate(async () => {
    const { viewer, styleManager } = window.__godsEyeView;
    const Cartesian3 = viewer.camera.position.constructor;
    const shapes = [
      // Throws inside Cesium's normalize.
      { name: 'nan', value: new Cartesian3(Number.NaN, Number.NaN, Number.NaN) },
      { name: 'origin', value: new Cartesian3(0, 0, 0) },
      { name: 'infinite', value: new Cartesian3(Number.POSITIVE_INFINITY, 0, 0) },
      // Converts SILENTLY to a point 6,378 km underground — the quiet failure a
      // bare non-zero check lets through, which then reverse-geocodes 0°, 0°.
      { name: 'core-interior', value: new Cartesian3(500, 0, 0) },
      // Finite, but large enough to overflow the geodetic iteration into NaN.
      { name: 'absurd-magnitude', value: new Cartesian3(1e155, 0, 0) },
    ];
    const scene = viewer.scene;
    const originalPick = Object.getOwnPropertyDescriptor(scene, 'pickPosition');
    let current = shapes[0].value;
    // The counter proves the prewarm re-picked under injection, so a clean
    // result cannot be clean merely because nothing ran.
    let pickCalls = 0;
    scene.pickPosition = () => { pickCalls += 1; return current; };

    const hudErrors = [];
    const nudge = (step) => {
      const carto = viewer.camera.positionCartographic;
      viewer.camera.setView({
        destination: Cartesian3.fromRadians(
          carto.longitude + 0.0015 * (step + 1),
          carto.latitude,
          carto.height,
        ),
        orientation: { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: 0 },
      });
      viewer.camera.moveEnd.raiseEvent();
    };

    try {
      for (let step = 0; step < shapes.length; step += 1) {
        current = shapes[step].value;
        // Nudge the camera so the 2.5 s view-target cache misses and the
        // moveEnd prewarm actually re-picks.
        nudge(step);
        // moveEnd debounce (120 ms) + requestIdleCallback timeout (500 ms).
        await new Promise((resolve) => setTimeout(resolve, 900));

        // The HUD summary walks the same view target. Enter through the REAL
        // boundary the 15 s interval uses — `void this._updateSummary(true)`,
        // with nobody owning the promise — so a rejection lands in the page's
        // unhandledrejection buffer exactly as it would in production.
        void styleManager.hud._updateSummary(true);
        await new Promise((resolve) => setTimeout(resolve, 250));

        // …and separately confirm the context itself is clean, with its error
        // attributed to this shape rather than pooled into the page buffer.
        try {
          await styleManager.hud._summaryContext();
        } catch (error) {
          hudErrors.push(`${shapes[step].name}: ${String(error?.message || error)}`);
        }
      }
    } finally {
      if (originalPick) Object.defineProperty(scene, 'pickPosition', originalPick);
      else delete scene.pickPosition;
    }
    return { hudErrors, shapes: shapes.length, pickCalls };
  });
  console.log(`  · injected ${injection.shapes} degenerate pick shapes; ${injection.pickCalls} pick(s) served; HUD context threw ${injection.hudErrors.length}×`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  check(
    'the injected picks actually reached the shipped code',
    injection.pickCalls > 0,
    `${injection.pickCalls} pick call(s) served`,
  );
  check(
    'a degenerate depth pick does not break the HUD view-target context',
    injection.hudErrors.length === 0,
    injection.hudErrors.length ? injection.hudErrors.slice(0, 5).join(' | ').slice(0, 500) : 'clean',
  );

  // ── Phase 3: the HUD summary's own async boundary ─────────────────────────
  // Phase 2 proves the guard keeps the context healthy. This proves the
  // boundary holds even when it is NOT — `_updateSummary` awaits the context
  // before its own try, and every caller invokes it as `void`, so any rejection
  // from anywhere in that walk is ownerless. Isolate the boundary by making the
  // context reject, then enter through the interval's exact statement.
  // The QA marker makes this round's rejection attributable no matter which
  // channel reports it.
  const boundaryMarker = 'QA: scene context unavailable';
  const pageErrorsBeforeBoundary = pageErrors.length;
  const rejectionsBeforeBoundary = await page.evaluate(() => window.__qaPrewarmRejections.length);
  const boundary = await page.evaluate((marker) => {
    const hud = window.__godsEyeView.styleManager.hud;
    window.__qaPriorSummaryContext = hud._summaryContext;
    window.__qaStubCalls = 0;
    hud._summaryContext = async () => {
      window.__qaStubCalls += 1;
      throw new Error(marker);
    };
    // `_updateSummary` returns before the await unless metrics exist and the
    // summary is dirty. Satisfy both, or this check passes vacuously.
    hud._latestMetrics = hud._latestMetrics || {};
    hud._summaryRequest = null;
    hud._summaryDirty = true;
    // Byte-for-byte the statement in the HUD's summary interval. Nothing waits
    // inside this evaluate: an ownerless rejection must be observed from
    // OUTSIDE the page, because the browser reports it to the driver rather
    // than always reaching an in-page listener.
    void hud._updateSummary(true);
    return window.__qaStubCalls;
  }, boundaryMarker);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const boundaryStubCalls = await page.evaluate(() => {
    const hud = window.__godsEyeView.styleManager.hud;
    hud._summaryContext = window.__qaPriorSummaryContext;
    return window.__qaStubCalls;
  });
  const boundaryRejections = [
    ...pageErrors.slice(pageErrorsBeforeBoundary),
    ...(await page.evaluate((n) => window.__qaPrewarmRejections.slice(n), rejectionsBeforeBoundary)),
  ].filter((text) => text.includes(boundaryMarker));
  console.log(`  · void _updateSummary() reached the context ${boundaryStubCalls}× (sync ${boundary}) → ${boundaryRejections.length} escaped rejection(s)`);

  check(
    'the void _updateSummary() call actually reached its context await',
    boundaryStubCalls > 0,
    `${boundaryStubCalls} call(s)`,
  );
  check(
    'a rejecting summary context does not escape the void _updateSummary() call',
    boundaryRejections.length === 0,
    boundaryRejections.length ? boundaryRejections.join(' | ').slice(0, 400) : 'clean',
  );

  // An ownerless rejection reaches the driver as a page error prefixed
  // "Uncaught (in promise)"; the in-page listener is a second, less reliable
  // channel. Union both so neither can hide one.
  const inPageRejections = await page.evaluate(() => window.__qaPrewarmRejections.slice());
  rejections = [
    ...pageErrors.filter((text) => /Uncaught \(in promise\)/i.test(text)),
    ...inPageRejections,
  ];

  // Cesium's DeveloperError stringifies as "DeveloperError: DeveloperError",
  // so the diagnostic text only survives on the caught HUD errors — scan those
  // too or this check reads clean while the page is throwing.
  const allText = [...pageErrors, ...consoleErrors, ...rejections, ...injection.hudErrors];
  const normalizeErrors = allText
    .filter((text) => /normalized result is not a number/i.test(text));

  check(
    'no uncaught page errors across the flight and the degenerate picks',
    pageErrors.length === 0,
    pageErrors.length
      ? `${pageErrors.length}: ${pageErrors.slice(0, 3).join(' | ').slice(0, 400)}`
      : 'clean',
  );
  check(
    'no unhandled promise rejections across the flight and the degenerate picks',
    rejections.length === 0,
    rejections.length
      ? `${rejections.length}: ${rejections.slice(0, 3).join(' | ').slice(0, 400)}`
      : 'clean',
  );
  check(
    'no "normalized result is not a number" DeveloperError on the flight',
    normalizeErrors.length === 0,
    normalizeErrors.length ? `${normalizeErrors.length} occurrence(s)` : 'clean',
  );
  check(
    'no console errors on the flight',
    consoleErrors.length === 0,
    consoleErrors.length
      ? `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 400)}`
      : 'clean',
  );

  fs.writeFileSync(
    path.join(shotsDir, `${label}-console.json`),
    `${JSON.stringify({
      appUrl,
      label,
      capturedAt: new Date().toISOString(),
      legs: legReports,
      injectedShapes: injection.shapes,
      injectedPickCalls: injection.pickCalls,
      hudContextErrors: injection.hudErrors,
      voidBoundaryRejections: boundaryRejections,
      pageErrors,
      consoleErrors,
      unhandledRejections: rejections,
      normalizeErrors,
    }, null, 2)}\n`,
  );
} catch (error) {
  check('harness ran to completion', false, String(error?.message || error));
} finally {
  await browser.close();
}

console.log(`\n${failures.length ? `FAIL (${failures.length})` : 'PASS'} — evidence in ${path.relative(repoRoot, shotsDir)}/`);
process.exit(failures.length ? 1 : 0);
