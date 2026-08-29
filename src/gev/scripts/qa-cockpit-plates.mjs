#!/usr/bin/env node
/**
 * Rendered proof for backdrop-selective callout plates at GROUND LEVEL.
 *
 * The owner's scenario: a cockpit sitting at JFK, where the geoid runs ~34 m
 * under the ellipsoid so the HUD honestly reads a NEGATIVE altitude. Every
 * label against the open sky came back with a full dark plate, because a
 * sub-ellipsoid camera fell into `skyBackdropFactor`'s degenerate guard.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS NOT A UNIT TEST IN DISGUISE. An earlier
 * version of this harness called `skyBackdropFactor` directly and would have
 * passed with the painter stubbed out — the number was right and nothing was
 * drawn. Every assertion here now comes from the RENDERED path instead:
 *
 *   ids/counts — `styleManager.getDetectionDiagnostics()` (src/ui.js), the
 *     overlay's own published `visibleCount` / `labeledKeys`, so a contact only
 *     counts once the sweep, the arbiter and the placement solve have all run.
 *   plate scale — tapped off `CanvasRenderingContext2D` while the frame paints.
 *     `paintDetectionCallout` fills the plate at `alpha * plateScale` and the
 *     accent bar at `alpha`, in that order, then draws the callsign, so the
 *     ratio of the two fills IS the plate scale and the callsign attributes it
 *     to a named contact. Nothing is recomputed; this reads what was painted.
 *   pixels — the plate rect comes from the same tap (`roundRect` immediately
 *     precedes its `fill`), and the harness reads back mean alpha inside that
 *     rect on `#world-overlay-canvas`, the real compositing surface.
 *
 * `--teeth` proves those assertions have teeth: it stubs the canvas paint calls
 * the callout painter uses to no-ops, so nothing reaches the framebuffer, and
 * the plate-scale and pixel checks must go RED. Run it after any change here.
 *
 * Three poses over one synthetic contact field:
 *   level        — cockpit on the ramp, nose on the horizon. This is the frame
 *                  the owner shot: approach traffic against open sky.
 *   tilted-down  — same cockpit, pitched down over the apron. Asserts that NO
 *                  ground contact is labelled, which is not this fix's doing:
 *                  from a camera under the ellipsoid Cesium's
 *                  `EllipsoidalOccluder` culls every point below the local
 *                  horizontal before detection ever sees it.
 *   lifted       — the same view a moment after rotate, at +40 m of ellipsoid
 *                  height. The apron contacts are back, and they keep their
 *                  FULL plates: the proof that sky selectivity did not quietly
 *                  become "no plates anywhere".
 *
 * Run (dev server already up):
 *   node scripts/qa-cockpit-plates.mjs --url http://localhost:4268
 *   node scripts/qa-cockpit-plates.mjs --url http://localhost:4268 --tag before
 *   node scripts/qa-cockpit-plates.mjs --url http://localhost:4268 --teeth
 *
 * Defaults to the real GPU (ANGLE/Metal). `--swiftshader` selects software GL,
 * which is deterministic but is NOT real-GPU evidence; the banner says which
 * backend actually ran and the run records it alongside the results.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const APP_ORIGIN = new URL(APP_URL).origin;
const TAG = getOpt('--tag', 'after');
const HEADFUL = argv.includes('--headful');
const TEETH = argv.includes('--teeth');
const SWIFTSHADER = argv.includes('--swiftshader');
const SHOT_DIR = path.resolve('qa-shots/cockpitplates');

/** Mirrors `SKY_PLATE_SCALE` in src/overlays/worldOverlayTokens.js. */
const SKY_PLATE_SCALE = 0.22;
/** Painted alpha is a ratio of two floats; this is generous slack on it. */
const PLATE_SCALE_TOLERANCE = 0.02;

// JFK. Ramp ~4 m MSL with a geoid height of about -34 m, so ellipsoid height
// on the deck is ~-30 m and a widebody cockpit reads ALT -18 m: the owner's
// exact HUD number, and a camera genuinely INSIDE the ellipsoid.
const JFK_LON = -73.7781;
const JFK_LAT = 40.6413;
const COCKPIT_H = -18;
const RAMP_H = -30;
const M_PER_DEG_LAT = 110_574;

/**
 * Contacts are placed due north of the cockpit, which faces north, so the sky
 * set and the ground set share one frame and one screenshot can show both.
 */
const CONTACTS = [
  // --- against open sky: above the cockpit's eye level ---
  { id: 'AAL1042', metric: '168KT', range: 6_000, height: 620, want: 'sky' },
  { id: 'DAL883', metric: '154KT', range: 9_000, height: 940, want: 'sky' },
  { id: 'JBU221', metric: '178KT', range: 12_000, height: 1_500, want: 'sky' },
  { id: 'UAL508', metric: '145KT', range: 4_200, height: 380, want: 'sky' },
  { id: 'FDX1190', metric: '190KT', range: 16_000, height: 2_400, want: 'sky' },
  // --- against the apron: below the cockpit floor ---
  { id: 'N6172G', metric: '12KT', range: 150, height: RAMP_H, want: 'ground' },
  { id: 'SWA2255', metric: '8KT', range: 260, height: RAMP_H, want: 'ground' },
  { id: 'DAL2190', metric: '15KT', range: 400, height: RAMP_H - 4, want: 'ground' },
  { id: 'AAL77', metric: '6KT', range: 620, height: RAMP_H - 6, want: 'ground' },
];

const SKY_IDS = CONTACTS.filter((contact) => contact.want === 'sky').map((contact) => contact.id);
const GROUND_IDS = CONTACTS.filter((contact) => contact.want === 'ground').map((contact) => contact.id);

const POSES = [
  {
    name: 'level',
    height: COCKPIT_H,
    pitchDeg: -1.5,
    // Approach traffic is above eye level, so it survives the occluder and must
    // paint at the feathered scale.
    expectPlated: SKY_IDS,
    expectScale: SKY_PLATE_SCALE,
    expectAbsent: GROUND_IDS,
    note: 'sub-ellipsoid cockpit, nose on the horizon',
  },
  {
    name: 'tilted-down',
    height: COCKPIT_H,
    pitchDeg: -14,
    expectPlated: [],
    expectScale: null,
    expectAbsent: GROUND_IDS,
    note: 'same cockpit pitched down; the occluder owns this emptiness',
  },
  {
    name: 'lifted',
    height: 40,
    pitchDeg: -14,
    expectPlated: GROUND_IDS,
    expectScale: 1,
    expectAbsent: [],
    note: 'above the ellipsoid after rotate; apron plates at full strength',
  },
];

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Version-pinned Chrome-for-Testing over the auto-updating system Chrome:
  // its software-GL behavior shifts across majors and has produced false
  // negatives in this repo's harnesses before.
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const stubJson = (body) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Installed before any app code runs. Records the callout painter's own canvas
 * calls; under `--teeth` it replaces them with no-ops instead, so the painter
 * stops reaching the framebuffer and every rendered assertion should fail.
 */
function installPaintTap(teeth) {
  const proto = CanvasRenderingContext2D.prototype;
  const origRoundRect = proto.roundRect;
  const origFill = proto.fill;
  const origFillText = proto.fillText;
  window.__PLATE_TAP = { on: false, events: [], lastRect: null, teeth };

  if (teeth) {
    // Stub the painter: no record, no pixels. This is the negative control.
    proto.roundRect = function () {};
    proto.fill = function () {};
    proto.fillText = function () {};
    return;
  }

  proto.roundRect = function (x, y, w, h, r) {
    if (window.__PLATE_TAP.on) window.__PLATE_TAP.lastRect = { x, y, w, h };
    return origRoundRect.call(this, x, y, w, h, r);
  };
  proto.fill = function (...args) {
    if (window.__PLATE_TAP.on) {
      window.__PLATE_TAP.events.push({
        kind: 'fill',
        alpha: this.globalAlpha,
        rect: window.__PLATE_TAP.lastRect || null,
      });
    }
    return origFill.apply(this, args);
  };
  proto.fillText = function (text, x, y, ...rest) {
    if (window.__PLATE_TAP.on) {
      window.__PLATE_TAP.events.push({ kind: 'text', alpha: this.globalAlpha, text: String(text) });
    }
    return origFillText.call(this, text, x, y, ...rest);
  };
}

async function main() {
  const backend = SWIFTSHADER ? 'software GL (SwiftShader)' : 'real GPU (ANGLE/Metal)';
  console.log('\nCockpit Plate Backdrop QA — rendered path');
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Tag     : ${TAG}${TEETH ? '  (TEETH: painter stubbed, expect RED)' : ''}`);
  console.log(`  Backend : ${backend}\n`);

  try {
    const response = await fetch(APP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`Dev server not reachable at ${APP_URL}: ${error.message}`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const executablePath = CHROME_CANDIDATES.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(SWIFTSHADER
        ? ['--use-gl=angle', '--use-angle=swiftshader']
        : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']),
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  });

  const consoleErrors = [];
  const perPose = [];
  let renderer = 'unknown';
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!/Failed to load resource.*404/i.test(text)) consoleErrors.push(text);
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.evaluateOnNewDocument(installPaintTap, TEETH);

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== APP_ORIGIN) return void request.continue();
      // Silence the live feeds: the injected field is the only population.
      if (url.pathname === '/api/ais-live') {
        return void request.respond(stubJson({
          rows: [], source: 'QA', status: 'open', error: null, refreshing: false,
          newestPositionAt: null, lastMessageAt: null,
        }));
      }
      if (url.pathname === '/api/adsblol/mil') {
        return void request.respond(stubJson({ msg: 'No error', now: Date.now(), ac: [] }));
      }
      if (url.pathname === '/api/opensky') {
        return void request.respond(stubJson({ time: Math.floor(Date.now() / 1000), states: [] }));
      }
      if (url.pathname === '/api/opensky-track') {
        return void request.respond(stubJson({ path: [] }));
      }
      if (url.pathname === '/api/openai/hud-summary') {
        return void request.respond(stubJson({ summary: 'Cockpit plate QA' }));
      }
      return void request.continue();
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 90_000 });
    await page.waitForFunction(
      () => document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 90_000 },
    );

    renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
        || document.createElement('canvas').getContext('webgl');
      if (!gl) return 'no webgl';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext
        ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
    });
    const softwareRenderer = /swiftshader|llvmpipe|software/i.test(renderer);
    console.log(`  GL      : ${renderer}\n`);
    record(
      SWIFTSHADER
        ? 'running on software GL as requested (structural checks, not GPU evidence)'
        : 'running on the real GPU, so the screenshots are real-GPU evidence',
      SWIFTSHADER ? softwareRenderer : !softwareRenderer,
      renderer,
    );

    // Inject the field. The layers keep their real pipelines; only the source
    // of observations is replaced, exactly as scripts/qa-labels.mjs does.
    await page.evaluate((payload) => {
      const { viewer, dataManager, styleManager } = window.__godsEyeView;
      viewer.camera.cancelFlight();
      const Cartesian3 = viewer.camera.position.constructor;
      window.__PLATE_QA_FIELD = payload.contacts.map((contact) => ({
        sourceId: contact.id.toLowerCase(),
        id: contact.id,
        metric: contact.metric,
        position: Cartesian3.fromDegrees(
          payload.lon,
          payload.lat + contact.range / payload.mPerDegLat,
          contact.height,
        ),
        type: 'AIR',
        tier: 'civil',
      }));
      for (const layerId of ['flights', 'military', 'satellites']) {
        const entry = dataManager.layers.get(layerId);
        if (!entry?.module) continue;
        entry.module.getDetectableObjects = () => (
          layerId === 'flights' ? window.__PLATE_QA_FIELD : []
        );
      }
      styleManager.setDetection({ enabled: true, densityPct: 100, allocationStrategy: 'elastic' });
    }, { lon: JFK_LON, lat: JFK_LAT, mPerDegLat: M_PER_DEG_LAT, contacts: CONTACTS });

    for (const pose of POSES) {
      console.log(`\n  — pose "${pose.name}" (${pose.note})`);
      await page.evaluate((payload) => {
        const { viewer } = window.__godsEyeView;
        const Cartesian3 = viewer.camera.position.constructor;
        viewer.camera.setView({
          destination: Cartesian3.fromDegrees(payload.lon, payload.lat, payload.height),
          orientation: { heading: 0, pitch: payload.pitchDeg * Math.PI / 180, roll: 0 },
        });
      }, { lon: JFK_LON, lat: JFK_LAT, height: pose.height, pitchDeg: pose.pitchDeg });

      // Let the tiles settle and the label solve run before the tap window.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await page.evaluate(() => {
        window.__PLATE_TAP.events = [];
        window.__PLATE_TAP.on = true;
        // Drive the frames this measurement needs, instead of assuming something
        // else is holding the render loop open.
        //
        // This harness enables no data layer and never enters real Cockpit (which
        // takes its own hold), so nothing in the scene animates. It used to get
        // its frames for free from detection's continuous-render hold — and that
        // hold was itself the bug: it pinned every idle tab at 60 fps, which is
        // why it was removed (see src/data/detectionRenderDemand.js). The scene is
        // now correctly idle during the tap window, so a measurement of PAINT
        // OUTPUT has to ask for its own renders. Production is unaffected: real
        // Cockpit holds, and a parked map keeps showing the last correct frame
        // precisely because nothing changed.
        const scene = window.__godsEyeView.viewer.scene;
        const pump = () => {
          if (!window.__PLATE_TAP.on) return;
          scene.requestRender();
          requestAnimationFrame(pump);
        };
        pump();
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const observed = await page.evaluate((wantedIds) => {
        window.__PLATE_TAP.on = false;
        const events = window.__PLATE_TAP.events;
        const wanted = new Set(wantedIds);
        // paintDetectionCallout paints, in order: the plate (alpha*plateScale),
        // the accent bar (alpha), the leader, then the callsign. So the two
        // fills before a callsign are that callout's plate and accent, and
        // their ratio is the plate scale that was actually painted.
        const byId = new Map();
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (event.kind !== 'text') continue;
          const id = event.text.trim();
          if (!wanted.has(id)) continue;
          const fills = [];
          for (let j = i - 1; j >= 0 && fills.length < 2; j--) {
            if (events[j].kind === 'fill') fills.unshift(events[j]);
          }
          if (fills.length < 2) continue;
          const [plate, accent] = fills;
          if (!(accent.alpha > 0)) continue;
          byId.set(id, {
            id,
            plateAlpha: plate.alpha,
            accentAlpha: accent.alpha,
            plateScale: plate.alpha / accent.alpha,
            rect: plate.rect,
          });
        }

        // Pixel readback from the real compositing surface, over the plate rect
        // the painter itself just used.
        const canvas = document.getElementById('world-overlay-canvas');
        const ctx = canvas?.getContext('2d', { willReadFrequently: true });
        const dpr = canvas && canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
        for (const entry of byId.values()) {
          entry.meanPixelAlpha = null;
          if (!ctx || !entry.rect || !(entry.rect.w > 0) || !(entry.rect.h > 0)) continue;
          const x = Math.max(0, Math.round(entry.rect.x * dpr));
          const y = Math.max(0, Math.round(entry.rect.y * dpr));
          const w = Math.min(canvas.width - x, Math.round(entry.rect.w * dpr));
          const h = Math.min(canvas.height - y, Math.round(entry.rect.h * dpr));
          if (!(w > 0) || !(h > 0)) continue;
          const data = ctx.getImageData(x, y, w, h).data;
          let total = 0;
          for (let p = 3; p < data.length; p += 4) total += data[p];
          entry.meanPixelAlpha = total / (data.length / 4) / 255;
        }

        const diagnostics = window.__godsEyeView.styleManager.getDetectionDiagnostics();
        return {
          plated: [...byId.values()],
          visibleCount: diagnostics?.visibleCount ?? null,
          labeledKeys: diagnostics?.labeledKeys ?? null,
          profile: diagnostics?.profile ?? null,
          fillEvents: events.filter((event) => event.kind === 'fill').length,
        };
      }, [...pose.expectPlated, ...pose.expectAbsent]);

      const labelledIds = (observed.labeledKeys || [])
        .filter((key) => key.startsWith('flights:'))
        .map((key) => key.slice('flights:'.length).toUpperCase());
      console.log(
        `    diagnostics: profile=${observed.profile} visibleCount=${observed.visibleCount}`
        + ` labelled=[${labelledIds.join(' ')}] fills=${observed.fillEvents}`,
      );
      for (const entry of observed.plated) {
        console.log(
          `      ${entry.id.padEnd(8)} plateScale=${entry.plateScale.toFixed(4)}`
          + ` (plate ${entry.plateAlpha.toFixed(4)} / accent ${entry.accentAlpha.toFixed(4)})`
          + ` meanPixelAlpha=${entry.meanPixelAlpha === null ? 'n/a' : entry.meanPixelAlpha.toFixed(4)}`,
        );
      }

      // 1. The overlay actually rendered something this pose.
      record(
        `${pose.name}: the overlay reports live rendered contacts`,
        Number.isFinite(observed.visibleCount) && observed.visibleCount > 0,
        `visibleCount=${observed.visibleCount}`,
      );
      // 2. The contacts we expect to be labelled are labelled, by id.
      const missingLabels = pose.expectPlated.filter((id) => !labelledIds.includes(id));
      record(
        `${pose.name}: every expected contact reaches the label solve`,
        missingLabels.length === 0,
        missingLabels.length
          ? `missing ${missingLabels.join(',')}`
          : `${pose.expectPlated.length} labelled`,
      );
      // 3. The contacts that must NOT be labelled are absent.
      const unexpected = pose.expectAbsent.filter((id) => labelledIds.includes(id));
      record(
        `${pose.name}: below-eye-level contacts stay out of the solve`,
        unexpected.length === 0,
        unexpected.length
          ? `unexpectedly labelled ${unexpected.join(',')}`
          : 'none labelled, as expected',
      );
      // 4/5/6. Painted plate scale and pixels, per named contact.
      if (pose.expectPlated.length > 0) {
        const platedIds = observed.plated.map((entry) => entry.id);
        const missingPaint = pose.expectPlated.filter((id) => !platedIds.includes(id));
        record(
          `${pose.name}: the callout painter ran for every expected contact`,
          missingPaint.length === 0,
          missingPaint.length
            ? `no paint recorded for ${missingPaint.join(',')}`
            : `${platedIds.length} painted`,
        );
        const offScale = observed.plated.filter(
          (entry) => Math.abs(entry.plateScale - pose.expectScale) > PLATE_SCALE_TOLERANCE,
        );
        record(
          `${pose.name}: painted plate scale is ${pose.expectScale}`,
          observed.plated.length > 0 && offScale.length === 0,
          offScale.length
            ? offScale.map((entry) => `${entry.id}=${entry.plateScale.toFixed(3)}`).join(' ')
            : observed.plated.map((entry) => entry.plateScale.toFixed(3)).join(' '),
        );
        const inked = observed.plated.filter((entry) => (entry.meanPixelAlpha ?? 0) > 0.01);
        record(
          `${pose.name}: the plate rect carries real pixels on the overlay canvas`,
          observed.plated.length > 0 && inked.length === observed.plated.length,
          observed.plated
            .map((entry) => `${entry.id}=${entry.meanPixelAlpha === null ? 'n/a' : entry.meanPixelAlpha.toFixed(3)}`)
            .join(' '),
        );
      }

      perPose.push({ pose: pose.name, ...observed, labelledIds });
      const shot = path.join(SHOT_DIR, `${TAG}-${pose.name}.png`);
      await page.screenshot({ path: shot });
      console.log(`    shot: ${shot}`);
    }

    // Cross-pose pixel comparison: the same theme, the same canvas, the same
    // painter — only the backdrop differs, so sky plates must be lighter.
    const skyInk = perPose.find((entry) => entry.pose === 'level')?.plated || [];
    const groundInk = perPose.find((entry) => entry.pose === 'lifted')?.plated || [];
    const meanOf = (rows) => (rows.length
      ? rows.reduce((sum, entry) => sum + (entry.meanPixelAlpha ?? 0), 0) / rows.length
      : null);
    const skyMean = meanOf(skyInk);
    const groundMean = meanOf(groundInk);
    record(
      'sky-backed plates are measurably lighter on the canvas than ground-backed ones',
      Number.isFinite(skyMean) && Number.isFinite(groundMean) && skyMean < groundMean,
      `sky mean alpha ${skyMean === null ? 'n/a' : skyMean.toFixed(4)}`
      + ` vs ground ${groundMean === null ? 'n/a' : groundMean.toFixed(4)}`,
    );

    record(
      'no page errors while the overlay ran at ground level',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ') || 'clean',
    );
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(SHOT_DIR, `${TAG}-rendered.json`),
    `${JSON.stringify({
      tag: TAG,
      teeth: TEETH,
      backend,
      renderer,
      cockpitHeight: COCKPIT_H,
      poses: perPose,
    }, null, 2)}\n`,
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  if (TEETH) {
    // Under --teeth the run is EXPECTED to fail; a green run would mean the
    // assertions do not depend on the painter and the harness is decorative.
    const ok = failed.length > 0;
    console.log(ok
      ? `  \x1b[32mTEETH OK\x1b[0m — ${failed.length} check(s) went red with the painter stubbed:\n    ${failed.map((entry) => entry.name).join('\n    ')}\n`
      : '  \x1b[31mTEETH FAILED\x1b[0m — every check passed with the painter stubbed; the harness proves nothing.\n');
    process.exit(ok ? 0 : 1);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
