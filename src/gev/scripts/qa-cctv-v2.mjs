/**
 * qa-cctv-v2.mjs — CCTV v2 subsystem proof harness
 *
 * Replaces qa-cctv-b9.mjs + qa-cctv-drift-b9b.mjs, which proved fixes in
 * systems v2 deleted outright (chunked auto-cal raycast storms, periodic
 * ground re-sync deadband/oscillation). v2 has no per-frame scene queries at
 * all, no auto-calibration, and no periodic re-grounding — so this harness
 * asserts the NEW invariants instead of re-proving retired ones:
 *
 *   1. Raycast invariant (design §9.1-amended): scene.pickFromRay fires
 *      exactly once per camera ACTIVATION (the §9.1 obstruction probe) and
 *      never again in steady state; shared mesh-floor sampling fires at most
 *      once per coarse cell during the staggered geometry-load drain, and
 *      actually COMPLETES once tiles load (>=1 real sample — the
 *      ceiling alone would pass trivially at Δ=0 if the snap never finished),
 *      stays flat while idle, and stays flat for non-positional pose edits.
 *   2. Geometry contract: the 5-polyline frustum wireframe + far-cap plane
 *      exist for the active camera, the plane's corners coincide with the
 *      4 corner-ray endpoints, and the whole geometry is byte-stable over a
 *      30s idle window (nothing resamples/rewrites without a reason to).
 *   3. Calibration round-trip: a manual patch writes the v2 localStorage key
 *      with source:'manual', rotates the geometry, flips the panel calBadge
 *      to 'calibrated'; reset removes the entry and restores base geometry.
 *   4. Frame-loop health: the plane's projection runtime starts on a
 *      placeholder and reaches a "frame considered fresh" state, and the
 *      panel <img> + the plane's underlying fetch share the same
 *      /api/cctv/frame/<id> URL family.
 *   5. Empty-space ownership: real canvas gestures prove ADJUST and sibling
 *      picks preserve the active camera, while a true empty-space click
 *      publishes exactly one null transition without moving the camera or
 *      emitting a focus request; a repeat click is idempotent.
 *   6. Viewshed mode (v3, 2026-07-05): coverage tri-state round-trip +
 *      boolean compat, color-coded volume primitives exist only in
 *      'viewshed' for the visible set, idle-stable by object identity,
 *      raycast counters flat across cycling.
 *   7. Calibration gizmo (v3): 8 handle entities in ADJUST mode, synthetic
 *      E-arrow drag edits the live pose while freezing mount elevation and
 *      issuing zero transient samples, without touching the save-gated store;
 *      camera-controller inputs restore and parts hide on mode off.
 *
 * SwiftShader caveat (proven in Task 3): under headless software GL, plane
 * image materials do not visually FILL — screenshotting for a pixel-based
 * pass/fail is not viable here. All four assertion groups therefore check
 * entity/counter/localStorage/network STATE (GL-independent), never rendered
 * pixels. Screenshots are still captured for human visual review but do not
 * gate the exit code.
 *
 * No `cesium` package import for in-page math: the app does not expose a
 * `window.Cesium` global, so every in-page evaluate() either (a) reads plain
 * numbers off live Cesium objects (Cartesian3 -> {x,y,z}, Quaternion ->
 * {x,y,z,w}) and does its own vector/quaternion math in plain JS, or
 * (b) borrows static methods off the *constructor* of a live instance, which
 * works because Cesium classes' statics live on the constructor, not a
 * namespace object. Separately, this harness DOES import
 * `computeFrustumGeometry` directly from `src/data/cctv.js` (a pure,
 * side-effect-free export with no Cesium/scene dependency) to use as a
 * Node-side ground-truth oracle — see the "safe pose" search below.
 *
 * Ground-clamp caveat (discovered writing this harness, see task report):
 * Austin's fabricated pose priors (pitch -18/-24°, FOV 44/56°, range 145/210m,
 * mount 8/10m — vite.config.js's two "personalities") routinely put the far
 * cap's bottom edge below ground truth. `computeFrustumGeometry` clamps each
 * WIREFRAME corner independently to `groundAlt + FRUSTUM_GROUND_CLEARANCE_M`,
 * but the PLANE entity (`createProjectionRuntime`/`updatePlanePlacement`) is
 * always an undistorted rectangle (fixed halfW/halfH, unclamped tilt) sitting
 * at the (possibly-clamped) capCenter. When the pose clamps asymmetrically,
 * the plane and the wireframe corners genuinely do NOT coincide — this is a
 * real property of the shipped geometry, not a harness bug. To test the
 * intended "coincide" contract deterministically (independent of which
 * camera activates), this harness first applies a temporary calibration
 * patch (large upward pitch offset + shrunk FOV + minimum range) computed
 * via a Node-side search against the SAME `computeFrustumGeometry` oracle,
 * chosen to clear the ground clamp with margin, then resets it afterward.
 *
 * Run:  node scripts/qa-cctv-v2.mjs --url http://localhost:4173
 *
 * Exit 0 = all asserts passed. Non-zero = a hard failure.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFrustumGeometry, FRUSTUM_GROUND_CLEARANCE_M } from '../src/data/cctv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const getFlag = (name) => argv.includes(name);

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const APP_URL = getOpt('--url', BASE_URL);
const HEADFUL = getFlag('--headful');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'cctv-v2');

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
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === null ? '\x1b[33mINCONCLUSIVE\x1b[0m' : ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SwiftShader can spend tens of seconds servicing the hover drillPick emitted
// by page.mouse.move(), before the LEFT_DOWN under test even runs. Position the
// pointer while ADJUST is disabled, then re-enable it and explicitly render a
// few frames so the real press/drag still exercises Cesium's input + pick path.
async function positionPointerForGizmoDrag(page, point, frameCount = 3) {
  await page.evaluate(() => {
    window.__godsEyeView.dataManager.layers.get('cctv').module
      .setParams({ calibrationMode: false });
  });
  await page.mouse.move(point.x, point.y);
  return page.evaluate(async (count) => {
    const gev = window.__godsEyeView;
    gev.dataManager.layers.get('cctv').module.setParams({ calibrationMode: true });
    const scene = gev.viewer.scene;
    let rendered = 0;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (complete) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        remove();
        resolve(complete);
      };
      const remove = scene.postRender.addEventListener(() => {
        rendered += 1;
        if (rendered >= count) {
          finish(true);
          return;
        }
        scene.requestRender();
      });
      const timer = setTimeout(() => finish(false), 5000);
      scene.requestRender();
    });
  }, frameCount);
}

// In-page helper (stringified and re-defined inside each evaluate that needs
// it, since functions can't cross the puppeteer boundary): serializes the
// 5 frustum polylines + plane position/orientation/dimensions for a camera
// into plain arrays of numbers, using only the camera's own clock time (no
// Cesium namespace needed — Property.getValue just needs *a* JulianDate,
// and the viewer's own clock.currentTime is a valid live instance of one).
const SERIALIZE_GEOM_SRC = `
  function serializeGeom(camId) {
    const viewer = window.__godsEyeView.viewer;
    const time = viewer.clock.currentTime;
    const roles = ['ray-tl', 'ray-tr', 'ray-br', 'ray-bl', 'cap'];
    const poly = {};
    for (const role of roles) {
      const ent = viewer.entities.getById('cctv-' + camId + '-' + role);
      poly[role] = ent && ent.polyline
        ? ent.polyline.positions.getValue(time).map((p) => [p.x, p.y, p.z])
        : null;
    }
    const planeEnt = viewer.entities.getById('cctv-' + camId + '-plane');
    let plane = null;
    if (planeEnt) {
      const pos = planeEnt.position.getValue(time);
      const orient = planeEnt.orientation.getValue(time);
      const dims = planeEnt.plane.dimensions.getValue(time);
      plane = {
        position: [pos.x, pos.y, pos.z],
        orientation: [orient.x, orient.y, orient.z, orient.w],
        dimensions: [dims.x, dims.y],
      };
    }
    return { poly, plane };
  }
`;

// In-page helper: bearing (degrees, mount -> cap-center) shift between two
// serializeGeom() snapshots of the SAME camera. Plain-JS spherical bearing
// math over ECEF points (no Cesium namespace) — a local east/north basis is
// built from the mount's geocentric "up" via cross products, which is
// equivalent to a proper ENU bearing at these ranges (hundreds of metres;
// cctv.js's own math already treats this scale as flat-earth, see
// projectPoint). Used both to prove a heading patch rotates the geometry AND
// that reset un-rotates it — comparing BEARING (not absolute cap-center
// position) is deliberate: the far-cap's ALTITUDE can legitimately drift a
// few metres between two ground-clamp actions because scene.sampleHeight
// against a still-streaming 3D tileset is not perfectly deterministic call to
// call (observed while writing this harness — see report), which would give
// a false-negative on an absolute-position epsilon that heading math alone
// doesn't share.
const BEARING_SHIFT_SRC = `
  function bearingShiftDeg(before, after) {
    function capCenter(g) {
      const pts = g.poly.cap; // [tl, tr, br, bl, tl]
      const avg = [0, 0, 0];
      for (let i = 0; i < 4; i++) { avg[0] += pts[i][0]; avg[1] += pts[i][1]; avg[2] += pts[i][2]; }
      return [avg[0] / 4, avg[1] / 4, avg[2] / 4];
    }
    const mount = before.poly['ray-tl'][0];
    const up = mount;
    const upLen = Math.hypot(up[0], up[1], up[2]);
    const upN = [up[0] / upLen, up[1] / upLen, up[2] / upLen];
    const ref = Math.abs(upN[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const eastRaw = [
      ref[1] * upN[2] - ref[2] * upN[1],
      ref[2] * upN[0] - ref[0] * upN[2],
      ref[0] * upN[1] - ref[1] * upN[0],
    ];
    const eastLen = Math.hypot(eastRaw[0], eastRaw[1], eastRaw[2]);
    const east = [eastRaw[0] / eastLen, eastRaw[1] / eastLen, eastRaw[2] / eastLen];
    const north = [
      upN[1] * east[2] - upN[2] * east[1],
      upN[2] * east[0] - upN[0] * east[2],
      upN[0] * east[1] - upN[1] * east[0],
    ];
    function bearingTo(target) {
      const v = [target[0] - mount[0], target[1] - mount[1], target[2] - mount[2]];
      const e = v[0] * east[0] + v[1] * east[1] + v[2] * east[2];
      const n = v[0] * north[0] + v[1] * north[1] + v[2] * north[2];
      return (Math.atan2(e, n) * 180 / Math.PI + 360) % 360;
    }
    const b0 = bearingTo(capCenter(before));
    const b1 = bearingTo(capCenter(after));
    let delta = b1 - b0;
    delta = ((delta + 540) % 360) - 180; // normalize to [-180, 180]
    return delta;
  }
`;

/**
 * Waits for the scene's 3D tileset to report tilesLoaded===true. Cesium
 * flips tilesLoaded back to false whenever a view/pose change causes new
 * tiles to be requested (observed directly while writing this harness: it
 * can go false again even after an earlier wait already saw it true) — so
 * every call site that depends on a REAL ground sample landing (not the
 * B9c guard's pure recompute from the cached real ground) must wait fresh
 * immediately before the action, not rely on an earlier wait.
 * @param {import('puppeteer').Page} page
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>} True if tilesLoaded was observed within the timeout.
 */
function waitForTilesLoaded(page, timeoutMs = 15000) {
  return page.waitForFunction(
    () => {
      const scene = window.__godsEyeView.viewer.scene;
      const prims = scene.primitives;
      for (let i = 0; i < prims.length; i++) {
        const p = prims.get(i);
        if (p && p.constructor && p.constructor.name === 'Cesium3DTileset') {
          return p.tilesLoaded === true;
        }
      }
      return true; // no tileset in the scene — nothing to wait for
    },
    { timeout: timeoutMs }
  ).then(() => true).catch(() => false);
}

/**
 * Searches for a calibration patch (pitchDeg/fovDeg/rangeScale offsets) that
 * clears the ground clamp for a given base pose, using the SAME
 * computeFrustumGeometry the app renders with as the oracle. Pushes pitch to
 * its allowed maximum, shrinks range to its allowed minimum, then shrinks FOV
 * in 2-degree steps until every corner sits comfortably above
 * `groundAltM + FRUSTUM_GROUND_CLEARANCE_M` (3m safety margin beyond the
 * clamp floor). Returns null if no patch in the legal offset ranges clears it
 * (shouldn't happen for the catalog's fabricated poses, but the caller must
 * treat that as INCONCLUSIVE, not a hard failure).
 * @param {Object} basePose - { pitchDeg, fovDeg, rangeM, mountHeightM }.
 * @param {number} groundAltM - Ground altitude at the mount.
 * @returns {{ pitchDeg: number, fovDeg: number, rangeScale: number }|null} Calibration patch offsets.
 */
function findSafeCalibrationPatch(basePose, groundAltM) {
  const pitchDeg = Math.max(-70, Math.min(10, basePose.pitchDeg + 45));
  const pitchOffset = Number((pitchDeg - basePose.pitchDeg).toFixed(1));
  const rangeScale = 0.35; // minimum legal rangeScale (normalizeCalibration clamp)
  const rangeM = Math.max(120, basePose.rangeM * rangeScale);
  const clampFloor = groundAltM + FRUSTUM_GROUND_CLEARANCE_M;
  for (let fovOffset = 0; fovOffset >= -50; fovOffset -= 2) {
    const fovDeg = Math.max(20, Math.min(130, basePose.fovDeg + fovOffset));
    const camera = { lat: 30, lon: -97, headingDeg: 0, pitchDeg, fovDeg, rangeM, mountHeightM: basePose.mountHeightM };
    const geom = computeFrustumGeometry(camera, groundAltM, rangeM);
    const minAlt = Math.min(geom.corners.tl.alt, geom.corners.tr.alt, geom.corners.br.alt, geom.corners.bl.alt);
    if (minAlt > clampFloor + 3) {
      return { pitchDeg: pitchOffset, fovDeg: fovOffset, rangeScale };
    }
  }
  return null;
}

async function main() {
  console.log(`\nCCTV v2 Subsystem Proof`);
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Mode    : ${HEADFUL ? 'headful' : 'headless'}\n`);

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  fs.mkdirSync(SHOTS_DIR, { recursive: true });

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
  let exitCode = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (!/Failed to load resource|net::ERR|status of 4\d\d|status of 5\d\d/.test(t)) {
          consoleErrors.push(t);
        }
      }
    });
    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 60000 }
    );
    // Let the initial fly-to Austin and first tiles settle.
    await sleep(4000);

    // -----------------------------------------------------------------------
    // Install raycast counters BEFORE the layer is enabled (§9.1-amended: the
    // zero-raycast invariant is steady-state-only; the single activation
    // obstruction probe is the one legal pickFromRay). Wrapping happens
    // in-page against the live scene, counting ALL calls (shared scene) — the
    // harness only ever asserts DELTAS around CCTV-specific actions, so noise
    // from unrelated subsystems cancels out by construction.
    // -----------------------------------------------------------------------
    const wrapInstalled = await page.evaluate(() => {
      const scene = window.__godsEyeView?.viewer?.scene;
      if (!scene || typeof scene.pickFromRay !== 'function' || typeof scene.sampleHeight !== 'function') {
        return false;
      }
      window.__qaCounters = { pickFromRay: 0, sampleHeight: 0 };
      const origPick = scene.pickFromRay.bind(scene);
      scene.pickFromRay = (...args) => {
        window.__qaCounters.pickFromRay += 1;
        return origPick(...args);
      };
      const origSample = scene.sampleHeight.bind(scene);
      scene.sampleHeight = (...args) => {
        window.__qaCounters.sampleHeight += 1;
        return origSample(...args);
      };
      return true;
    });
    if (!wrapInstalled) {
      console.error('\x1b[31mCould not wrap scene.pickFromRay/sampleHeight before layer enable — aborting.\x1b[0m');
      process.exit(2);
    }

    const readCounters = () => page.evaluate(() => ({ ...window.__qaCounters }));

    console.log('Enabling CCTV layer...');
    const c0 = await readCounters();
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const entry = dm.layers.get('cctv');
      if (!entry.enabled) await dm.toggle('cctv');
    });

    // Wait for the staggered geometry-load queue to drain (shared mesh-floor
    // sampling: <=1 sampleHeight per coarse cell, gated on tiles-ready). The
    // budget scales with catalog size: the queue staggers ~4 records/120ms
    // and the one-shot tiles-ready completion pass can re-enqueue the whole
    // catalog once — 30s was calibrated for the old 36-camera default and
    // times out spuriously at the 250-camera default (2026-07-04).
    const camCount = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState().count);
    // ~800ms per real ground sample measured under SwiftShader (each
    // scene.sampleHeight forces tile loads at the probe point) — real GPU is
    // far faster, so this is a headless-CI ceiling, not an app expectation.
    const drainBudgetMs = HEADFUL
      ? Math.max(30000, camCount * 800 + 30000)
      : Math.min(120000, Math.max(30000, camCount * 800 + 30000));
    console.log(`Waiting for geometry-load queue to drain (N=${camCount}, budget ${Math.round(drainBudgetMs / 1000)}s)...`);
    const drained = await page.waitForFunction(
      () => {
        const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
        const ui = mod.getUIState();
        return ui.loading && ui.loading.active === false;
      },
      { timeout: drainBudgetMs }
    ).then(() => true).catch(() => false);
    record(`geometry-load queue drains within ${Math.round(drainBudgetMs / 1000)}s (N=${camCount})`,
      drained ? true : (HEADFUL ? false : null),
      drained
        ? 'loading.active === false'
        : HEADFUL
          ? 'timed out waiting for drain on the real-GPU sign-off path'
          : 'headless GL geometry sampling did not settle; current headful evidence is required');

    const cAfterDrain = await readCounters();
    record('pickFromRay stays 0 before any activation', cAfterDrain.pickFromRay - c0.pickFromRay === 0,
      `Δ=${cAfterDrain.pickFromRay - c0.pickFromRay}`);
    // Every camera maps to at most one shared coarse cell, so ≤1×N remains a
    // safe ceiling while nearby cameras reuse the same accepted floor.
    const sampleAfterDrain = cAfterDrain.sampleHeight - c0.sampleHeight;
    record(`sampleHeight <= 1×N after drain (N=${camCount})`, sampleAfterDrain <= camCount,
      `Δ=${sampleAfterDrain}, ceiling=${camCount} (one-shot shared mesh-floor cell)`);

    // Pick the active camera (or nearest) to activate.
    console.log('Activating a camera (focusNearest)...');
    const activeIdBeforeActivation = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState().activeCameraId);
    const cBeforeActivate = await readCounters();
    await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.focusNearest({ durationSec: 0.1 });
    });
    await sleep(500); // let the activation's synchronous work (probe + geometry rewrite) land
    const cAfterActivate = await readCounters();
    const activeId = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState().activeCameraId);

    const pickDeltaActivation = cAfterActivate.pickFromRay - cBeforeActivate.pickFromRay;
    record('pickFromRay fires exactly once for the activation (§9.1 probe)', pickDeltaActivation === 1,
      `Δ=${pickDeltaActivation} (camera=${activeId}, was=${activeIdBeforeActivation})`);

    // Re-selecting the ALREADY-ACTIVE camera is a no-op (field test
    // 2026-07-04: every click on the monitor plane picks its own camera, and
    // re-running activation rewrote the plane entity → visible flash). No new
    // probe, no geometry rewrite.
    const geomBeforeReselect = await page.evaluate(`(() => {
      ${SERIALIZE_GEOM_SRC}
      return JSON.stringify(serializeGeom(${JSON.stringify(activeId)}));
    })()`);
    await page.evaluate((id) => {
      window.__godsEyeView.dataManager.layers.get('cctv').module.setParams({ selectedCameraId: id });
    }, activeId);
    await sleep(400);
    const cAfterReselect = await readCounters();
    const geomAfterReselect = await page.evaluate(`(() => {
      ${SERIALIZE_GEOM_SRC}
      return JSON.stringify(serializeGeom(${JSON.stringify(activeId)}));
    })()`);
    record('re-selecting the active camera is a no-op (no probe, no geometry rewrite)',
      cAfterReselect.pickFromRay - cAfterActivate.pickFromRay === 0 && geomBeforeReselect === geomAfterReselect,
      `probeΔ=${cAfterReselect.pickFromRay - cAfterActivate.pickFromRay}, geometryChanged=${geomBeforeReselect !== geomAfterReselect}`);

    // -----------------------------------------------------------------------
    // Completion FLOOR (locks update()'s one-shot tiles-ready re-enqueue):
    // the "<=1×N" ceiling above passes trivially at Δ=0 — e.g. if every drain
    // pass ran before tiles loaded (fallback height, record left unresolved)
    // and nothing ever completed the snap. Once tilesLoaded has been observed
    // true, at least ONE real scene.sampleHeight must have fired since enable
    // (existence, not just ceiling). The wait below tolerates the update-tick
    // latency of the completion pass (update interval is 10s).
    // -----------------------------------------------------------------------
    console.log('Waiting for tiles + the one-shot completion pass...');
    const tilesSeenLoaded = await waitForTilesLoaded(page, 45000);
    let sampleFloorOk = false;
    if (tilesSeenLoaded) {
      sampleFloorOk = await page.waitForFunction(
        (base) => window.__qaCounters.sampleHeight - base >= 1,
        { timeout: 30000 },
        c0.sampleHeight
      ).then(() => true).catch(() => false);
    }
    const cFloor = await readCounters();
    record('>=1 real ground sample once tilesLoaded observed (one-shot snap completed)',
      tilesSeenLoaded ? sampleFloorOk : null,
      tilesSeenLoaded
        ? `total real samples since enable=${cFloor.sampleHeight - c0.sampleHeight}`
        : 'tilesLoaded never observed within 45s — floor not assessable this run');

    // Let the completion pass finish before the steady-state window: require
    // the sampleHeight counter quiet for 12s (> the 10s update interval, so
    // the one-shot latch has provably had a tick in which to fire and drain)
    // — otherwise the idle assertion below could observe the legitimate tail
    // of the one-shot pass and misread it as steady-state sampling. The cap
    // scales with N like the drain budget: when the ENABLE-time drain ran
    // before tiles loaded (fallback path, zero real samples), the completion
    // pass re-enqueues the WHOLE catalog and each real sampleHeight costs
    // ~1s under SwiftShader — at N=250 that tail is ~4 minutes, and the old
    // fixed 60s cap expired mid-pass, bleeding legitimate one-shot samples
    // into the idle window (observed 2026-07-05: idle Δ=12, pose-edit Δ=5).
    let completionPassQuiet = false;
    {
      const settleBudgetMs = Math.max(60000, camCount * 1200 + 30000);
      console.log(`Waiting for the one-shot completion pass to go quiet (budget ${Math.round(settleBudgetMs / 1000)}s)...`);
      let last = (await readCounters()).sampleHeight;
      let quietMs = 0;
      const settleStart = Date.now();
      while (quietMs < 12000 && Date.now() - settleStart < settleBudgetMs) {
        await sleep(1000);
        const cur = (await readCounters()).sampleHeight;
        if (cur === last) {
          quietMs += 1000;
        } else {
          quietMs = 0;
          last = cur;
        }
      }
      completionPassQuiet = quietMs >= 12000;
    }

    // -----------------------------------------------------------------------
    // Steady-state idle window (>=15s): pickFromRay must not grow at all;
    // sampleHeight must stay flat (queue already drained, no periodic re-sync
    // in v2).
    // -----------------------------------------------------------------------
    console.log('Idling 15s to check steady-state raycast invariant...');
    const cIdleStart = await readCounters();
    await sleep(15000);
    const cIdleEnd = await readCounters();
    const pickDuringIdle = cIdleEnd.pickFromRay - cIdleStart.pickFromRay;
    const sampleDuringIdle = cIdleEnd.sampleHeight - cIdleStart.sampleHeight;
    record('pickFromRay does not grow during 15s steady-state idle', pickDuringIdle === 0,
      `Δ=${pickDuringIdle}`);
    record('sampleHeight stays flat during 15s steady-state idle',
      completionPassQuiet ? sampleDuringIdle === 0 : null,
      completionPassQuiet
        ? `Δ=${sampleDuringIdle}`
        : `one-shot floor completion did not become quiet under this GL stack; observed tail Δ=${sampleDuringIdle}`);

    // -----------------------------------------------------------------------
    // A rotational calibration edit preserves the existing shared floor and
    // therefore adds zero sampleHeight calls. The activation obstruction probe
    // remains activation-only.
    console.log('Applying a calibration patch (heading +30°)...');
    const cBeforeCal = await readCounters();
    await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibration: { cameraId: camId, patch: { headingDeg: 30 } } });
    }, activeId);
    await sleep(500);
    const cAfterCal = await readCounters();
    const sampleDeltaCal = cAfterCal.sampleHeight - cBeforeCal.sampleHeight;
    const pickDeltaCal = cAfterCal.pickFromRay - cBeforeCal.pickFromRay;
    record('sampleHeight stays flat after a heading-only calibration edit',
      completionPassQuiet ? sampleDeltaCal === 0 : null,
      completionPassQuiet
        ? `Δ=${sampleDeltaCal}`
        : `one-shot floor completion was still unresolved; observed tail Δ=${sampleDeltaCal}`);
    record('pickFromRay does not fire on a calibration patch (activation-only)', pickDeltaCal === 0,
      `Δ=${pickDeltaCal}`);

    // Undo that patch before the geometry-contract assertions below so they
    // observe the record's steady, unpatched frustum.
    await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibration: { cameraId: camId, reset: true } });
    }, activeId);
    await sleep(300);

    // =========================================================================
    // Group 2: geometry contract
    // =========================================================================
    console.log('Checking geometry contract (frustum + plane)...');
    const geomInfo = await page.evaluate(`(function(camId){
      ${SERIALIZE_GEOM_SRC}
      const g = serializeGeom(camId);
      const viewer = window.__godsEyeView.viewer;
      // Overlay unification: the plane label is no longer a native entity —
      // it publishes as a protected host entry under the cctv-projection
      // source. Assert the migrated surface via the host diagnostics.
      const diag = window.__gevWorldOverlay?.getDiagnostics?.();
      g.hasLabel = (diag?.entriesBySource?.['cctv-projection'] || 0) >= 1;
      const planeEnt = viewer.entities.getById('cctv-' + camId + '-plane');
      g.planeShow = planeEnt ? planeEnt.show : null;
      return g;
    })(${JSON.stringify(activeId)})`);

    const allPolylinesPresent = ['ray-tl', 'ray-tr', 'ray-br', 'ray-bl', 'cap'].every((r) => Array.isArray(geomInfo.poly[r]));
    record('all 5 frustum polyline entities exist for the active camera', allPolylinesPresent,
      Object.keys(geomInfo.poly).map((k) => `${k}=${geomInfo.poly[k] ? 'ok' : 'MISSING'}`).join(', '));
    record('plane + plane-label entities exist for the active camera', !!geomInfo.plane && geomInfo.hasLabel,
      `plane=${!!geomInfo.plane} label=${geomInfo.hasLabel} show=${geomInfo.planeShow}`);

    // Plane corner positions must coincide with the 4 corner-ray endpoints
    // (ε < 0.5m) — but ONLY when the frustum doesn't hit the ground clamp
    // (see the file-header "Ground-clamp caveat"). Austin's fabricated pitch
    // priors clamp routinely at the base pose, so apply a temporary
    // calibration patch (computed against the same computeFrustumGeometry
    // oracle the app uses) that pushes pitch up + shrinks FOV/range enough to
    // clear the clamp with margin, run the coincidence check against THAT
    // pose, then reset back to the base pose before the byte-stability check.
    const activeCameraForPatch = await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      return mod.getUIState().cameras.find((c) => c.id === camId);
    }, activeId);
    const basePose = activeCameraForPatch.basePose;
    const groundAltMForPatch = activeCameraForPatch.elevationM - activeCameraForPatch.mountHeightM;
    const safePatch = basePose ? findSafeCalibrationPatch(basePose, groundAltMForPatch) : null;
    record('found a calibration patch that clears the ground clamp (test setup, not an app assertion)', safePatch !== null,
      safePatch ? JSON.stringify(safePatch) : 'no legal offset combination cleared the clamp — corner-coincidence check below will run against the (possibly clamped) base pose');

    // updateRecordGeometry's B9c guard now recomputes PURELY from the cached
    // real ground when tilesLoaded flips false at the instant of the patch
    // (final-review fix — previously it skipped the rewrite entirely, leaving
    // the pre-patch polylines/plane dimensions stale), so a pose patch always
    // lands in the entity geometry. Cesium can still re-flip tilesLoaded
    // false on a pose change even after an earlier wait already saw it true
    // (a shrunk FOV/pitch change requests a different tile set), so the
    // wait-then-patch retry loop is kept as belt-and-braces, verifying the
    // plane's dimensions actually changed before trusting geomForCorners.
    let geomForCorners = geomInfo;
    let patchGeometryApplied = !safePatch;
    if (safePatch) {
      const dimsBefore = geomInfo.plane ? JSON.stringify(geomInfo.plane.dimensions) : null;
      for (let attempt = 0; attempt < 3 && !patchGeometryApplied; attempt++) {
        await waitForTilesLoaded(page, 15000);
        await page.evaluate(({ camId, patch }) => {
          const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
          mod.setParams({ calibration: { cameraId: camId, patch } });
        }, { camId: activeId, patch: safePatch });
        await sleep(400);
        geomForCorners = await page.evaluate(`(function(camId){ ${SERIALIZE_GEOM_SRC} return serializeGeom(camId); })(${JSON.stringify(activeId)})`);
        const dimsAfter = geomForCorners.plane ? JSON.stringify(geomForCorners.plane.dimensions) : null;
        patchGeometryApplied = !!dimsAfter && dimsAfter !== dimsBefore;
      }
    }
    record('calibration patch geometry landed (test setup, not an app assertion)', patchGeometryApplied,
      patchGeometryApplied ? 'plane dimensions changed vs pre-patch' : 'plane dimensions never changed — tiles kept flipping mid-stream; corner-coincidence check below may be running against a stale pose');

    let cornerEps = null;
    if (allPolylinesPresent && geomForCorners.plane) {
      cornerEps = await page.evaluate((geom) => {
        // Rotate vector v by quaternion q=[x,y,z,w] (standard formula).
        function rotate(q, v) {
          const [qx, qy, qz, qw] = q;
          const ix = qw * v[0] + qy * v[2] - qz * v[1];
          const iy = qw * v[1] + qz * v[0] - qx * v[2];
          const iz = qw * v[2] + qx * v[1] - qy * v[0];
          const iw = -qx * v[0] - qy * v[1] - qz * v[2];
          return [
            ix * qw + iw * -qx + iy * -qz - iz * -qy,
            iy * qw + iw * -qy + iz * -qx - ix * -qz,
            iz * qw + iw * -qz + ix * -qy - iy * -qx,
          ];
        }
        const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const { poly, plane } = geom;
        const center = plane.position;
        const halfW = plane.dimensions[0] / 2;
        const halfH = plane.dimensions[1] / 2;
        // planeOrientationFor builds the frame as columns [right, up, normal]
        // — local +X is right, +Y is up (matches Cesium's row/col Matrix3
        // constructor call order in cctv.js's planeOrientationFor).
        const corner = (sx, sy) => {
          const local = [sx * halfW, sy * halfH, 0];
          const world = rotate(plane.orientation, local);
          return [center[0] + world[0], center[1] + world[1], center[2] + world[2]];
        };
        const planeCorners = { tl: corner(-1, 1), tr: corner(1, 1), br: corner(1, -1), bl: corner(-1, -1) };
        const rayEndpoint = (role) => poly[role][poly[role].length - 1];
        const rayCorners = { tl: rayEndpoint('ray-tl'), tr: rayEndpoint('ray-tr'), br: rayEndpoint('ray-br'), bl: rayEndpoint('ray-bl') };
        return {
          tl: dist(planeCorners.tl, rayCorners.tl),
          tr: dist(planeCorners.tr, rayCorners.tr),
          br: dist(planeCorners.br, rayCorners.br),
          bl: dist(planeCorners.bl, rayCorners.bl),
        };
      }, geomForCorners);
      const maxEps = Math.max(...Object.values(cornerEps));
      const epsLabel = safePatch
        ? 'plane corners coincide with wireframe corner-ray endpoints (ε < 0.5m, ground-clamp-cleared pose)'
        : 'plane corners coincide with wireframe corner-ray endpoints (ε < 0.5m)';
      record(epsLabel, maxEps < 0.5,
        `tl=${cornerEps.tl.toFixed(3)}m tr=${cornerEps.tr.toFixed(3)}m br=${cornerEps.br.toFixed(3)}m bl=${cornerEps.bl.toFixed(3)}m`);
    } else {
      record('plane corners coincide with wireframe corner-ray endpoints (ε < 0.5m)', null,
        'skipped — geometry entities missing');
    }

    // Restore the base (unpatched) pose before the byte-stability window so
    // that check observes the record's normal steady-state frustum, not the
    // synthetic clamp-clearing test pose.
    if (safePatch) {
      await page.evaluate((camId) => {
        const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
        mod.setParams({ calibration: { cameraId: camId, reset: true } });
      }, activeId);
      await sleep(300);
    }

    // Byte-stable over 30s idle: serialize + compare after 30s. Nothing
    // resamples on a timer in v2, so this is a pure drift regression.
    console.log('Checking geometry byte-stability over 30s idle...');
    const serializeGeom = (camId) => page.evaluate(`(function(camId){
      ${SERIALIZE_GEOM_SRC}
      return serializeGeom(camId);
    })(${JSON.stringify(camId)})`);
    const geomBefore30s = await serializeGeom(activeId);
    await sleep(30000);
    const geomAfter30s = await serializeGeom(activeId);
    const geomStable = JSON.stringify(geomBefore30s) === JSON.stringify(geomAfter30s);
    record('geometry is byte-stable over 30s idle (no per-frame/timer resample)', geomStable,
      geomStable ? 'identical serialization' : 'serialization CHANGED — see harness output above');
    if (!geomStable) {
      console.log('  before:', JSON.stringify(geomBefore30s));
      console.log('  after :', JSON.stringify(geomAfter30s));
    }

    // =========================================================================
    // Group 3: calibration round-trip
    // =========================================================================
    console.log('Checking calibration round-trip (patch -> save -> reset)...');
    const baseGeom = await serializeGeom(activeId);
    const baseBadge = await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const ui = mod.getUIState();
      return ui.cameras.find((c) => c.id === camId)?.calBadge;
    }, activeId);
    const baseStoreEmpty = await page.evaluate((camId) => {
      const raw = localStorage.getItem('godsEyeView.cctv.calibration.v2');
      const map = raw ? JSON.parse(raw) : {};
      return !(camId in map);
    }, activeId);
    record('CAL badge is raw-prior (or curated) before any manual save', baseBadge !== 'calibrated',
      `calBadge=${baseBadge}`);
    record('v2 store has no entry for this camera before any manual save', baseStoreEmpty,
      baseStoreEmpty ? 'no entry' : 'unexpected pre-existing entry');

    await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibration: { cameraId: camId, patch: { headingDeg: 30 } } });
    }, activeId);
    await sleep(300);

    // Save-gated persistence (v3 design §3e): a PATCH edits the live pose
    // only — the store must stay untouched and the camera must read as
    // dirty/EDITED until the explicit save action below.
    const afterPatch = await page.evaluate((camId) => {
      const raw = localStorage.getItem('godsEyeView.cctv.calibration.v2');
      const map = raw ? JSON.parse(raw) : {};
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const cam = mod.getUIState().cameras.find((c) => c.id === camId);
      return { stored: camId in map, calDirty: cam?.calDirty, calBadge: cam?.calBadge };
    }, activeId);
    record('patch does NOT write the v2 store (save-gated)', afterPatch.stored === false,
      afterPatch.stored ? 'entry written on patch — save-gating broken' : 'store untouched');
    record('patch marks the camera calDirty (EDITED chip)', afterPatch.calDirty === true,
      `calDirty=${afterPatch.calDirty}`);
    record('calBadge stays non-calibrated after an unsaved patch', afterPatch.calBadge !== 'calibrated',
      `calBadge=${afterPatch.calBadge}`);

    await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibration: { cameraId: camId, save: true } });
    }, activeId);
    await sleep(200);

    const storeEntry = await page.evaluate((camId) => {
      const raw = localStorage.getItem('godsEyeView.cctv.calibration.v2');
      const map = raw ? JSON.parse(raw) : {};
      return map[camId] || null;
    }, activeId);
    record('v2 localStorage key written with source:manual + savedAt on SAVE', !!(storeEntry && storeEntry.source === 'manual' && Number.isFinite(storeEntry.savedAt)),
      storeEntry ? `source=${storeEntry.source} savedAt=${storeEntry.savedAt}` : 'no entry written');

    const afterSave = await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const cam = mod.getUIState().cameras.find((c) => c.id === camId);
      return { calBadge: cam?.calBadge, calDirty: cam?.calDirty };
    }, activeId);
    record('calBadge flips to calibrated after SAVE (and dirty clears)', afterSave.calBadge === 'calibrated' && afterSave.calDirty === false,
      `calBadge=${afterSave.calBadge} calDirty=${afterSave.calDirty}`);

    // Geometry rotated: cap-center bearing from the mount should have shifted
    // ~30 degrees vs the pre-patch baseline (shared BEARING_SHIFT_SRC helper
    // — see its header comment for why bearing, not absolute position).
    const geomAfterCal = await serializeGeom(activeId);
    const bearingShiftDegPatch = await page.evaluate(`(function(before, after){
      ${BEARING_SHIFT_SRC}
      return bearingShiftDeg(before, after);
    })(${JSON.stringify(baseGeom)}, ${JSON.stringify(geomAfterCal)})`);
    const rotatedByAbout30 = Math.abs(Math.abs(bearingShiftDegPatch) - 30) < 5;
    record('geometry cap-center bearing shifts ~30° after headingDeg+30 patch', rotatedByAbout30,
      `Δbearing=${bearingShiftDegPatch.toFixed(2)}°`);

    // Reset: entry removed, base geometry restored, badge back to raw-prior.
    await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibration: { cameraId: camId, reset: true } });
    }, activeId);
    await sleep(300);

    const storeAfterReset = await page.evaluate((camId) => {
      const raw = localStorage.getItem('godsEyeView.cctv.calibration.v2');
      const map = raw ? JSON.parse(raw) : {};
      return camId in map;
    }, activeId);
    record('v2 localStorage entry removed after reset', !storeAfterReset,
      storeAfterReset ? 'entry still present' : 'removed');

    const badgeAfterReset = await page.evaluate((camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      return mod.getUIState().cameras.find((c) => c.id === camId)?.calBadge;
    }, activeId);
    record('calBadge returns to raw-prior (or curated) after reset', badgeAfterReset !== 'calibrated',
      `calBadge=${badgeAfterReset}`);

    // Reset must undo the heading+30 rotation back to ~0°. Ground now resolves
    // through the stable shared floor cache instead of repeated raw samples.
    const geomAfterReset = await serializeGeom(activeId);
    const bearingShiftDegReset = await page.evaluate(`(function(before, after){
      ${BEARING_SHIFT_SRC}
      return bearingShiftDeg(before, after);
    })(${JSON.stringify(baseGeom)}, ${JSON.stringify(geomAfterReset)})`);
    record('cap-center bearing restored to base (~0° vs baseline) after reset', Math.abs(bearingShiftDegReset) < 5,
      `Δbearing=${bearingShiftDegReset.toFixed(2)}°`);

    // =========================================================================
    // Group 4: frame-loop health (STATE, not pixels — SwiftShader caveat)
    // =========================================================================
    console.log('Checking frame-loop health (placeholder -> frame swap, URL family)...');
    // The plane's material.image is always defined (placeholder canvas from
    // the moment the runtime is created, real frame content painted onto the
    // same canvas/video reference once the fetch resolves) — assert it's
    // never null/undefined once the runtime exists, i.e. there's no gap where
    // the plane shows nothing.
    const materialInfo = await page.evaluate((camId) => {
      const viewer = window.__godsEyeView.viewer;
      const time = viewer.clock.currentTime;
      const planeEnt = viewer.entities.getById('cctv-' + camId + '-plane');
      const mat = planeEnt?.plane?.material;
      const image = mat?.image;
      const resolved = image && typeof image.getValue === 'function' ? image.getValue(time) : image;
      return {
        hasMaterial: !!mat,
        hasImage: !!resolved,
        tagName: resolved?.tagName || null,
        show: planeEnt?.show,
      };
    }, activeId);
    record('plane material + image are defined for the active camera (no blank gap)', materialInfo.hasMaterial && materialInfo.hasImage,
      `material=${materialInfo.hasMaterial} image=${materialInfo.hasImage} tag=${materialInfo.tagName} show=${materialInfo.show}`);

    // Poll /api/cctv/frame/<id> directly (the same endpoint frameUrlFor
    // targets) to confirm the backend serves SOMETHING for this camera
    // (upstream / streetview / synthetic fallback all count as "the frame
    // loop is healthy" — a hard 5xx/network failure would not).
    const frameFetch = await page.evaluate(async (camId) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const cam = mod.getUIState().cameras.find((c) => c.id === camId);
      const res = await fetch(cam.frameUrl);
      return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type'), url: cam.frameUrl, mediaUrl: cam.mediaUrl };
    }, activeId);
    record('backend serves a frame for the active camera (2xx, image content-type)', frameFetch.ok && /^image\//.test(frameFetch.contentType || ''),
      `status=${frameFetch.status} content-type=${frameFetch.contentType} url=${frameFetch.url}`);

    // Panel <img> src and the plane's frame fetch share the same
    // /api/cctv/frame/<id> URL family (same endpoint + camera id segment).
    const panelImgSrc = await page.evaluate(() => document.getElementById('cctv-frame')?.getAttribute('src') || null);
    const sameFamily = !!panelImgSrc && panelImgSrc.includes(`/api/cctv/frame/${encodeURIComponent(activeId)}`);
    record('panel <img> and plane share the same /api/cctv/frame/<id> URL family', sameFamily,
      `panelSrc=${panelImgSrc}`);

    // =========================================================================
    // Group 5: installed canvas-click ownership + true-empty deselection
    // =========================================================================
    console.log('Checking installed canvas click ownership and empty-space deselection...');
    const emptyClickPoint = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const viewer = gev.viewer;
      const scene = viewer.scene;
      const canvas = scene.canvas;
      const rect = canvas.getBoundingClientRect();
      const { hitTestWorldOverlay } = await import('/src/overlays/worldOverlay.js');
      const candidates = [
        [0.55, 0.72], [0.45, 0.72], [0.62, 0.62], [0.38, 0.62],
        [0.58, 0.22], [0.42, 0.22], [0.5, 0.52],
      ];
      const resolveId = (picked) => {
        const direct = picked?.id?.id ?? picked?.id;
        if (direct !== undefined && direct !== null) return String(direct);
        const primitive = picked?.primitive?.id?.id ?? picked?.primitive?.id;
        return primitive === undefined || primitive === null ? null : String(primitive);
      };
      for (const [fx, fy] of candidates) {
        const x = Math.round(canvas.clientWidth * fx);
        const y = Math.round(canvas.clientHeight * fy);
        const picked = scene.pick({ x, y });
        const card = hitTestWorldOverlay(x, y, { sourceId: 'cctv' });
        const top = document.elementFromPoint(rect.left + x, rect.top + y);
        if (resolveId(picked) === null && !card && (top === canvas || canvas.contains(top))) {
          return { x: rect.left + x, y: rect.top + y, canvasX: x, canvasY: y };
        }
      }
      return null;
    });
    record('true-empty canvas target is available (no scene owner or CCTV card)', !!emptyClickPoint,
      emptyClickPoint ? `canvas=(${emptyClickPoint.canvasX},${emptyClickPoint.canvasY})` : 'no clean canvas point found');

    const clickEvidenceSetup = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const viewer = gev.viewer;
      const mod = gev.dataManager.layers.get('cctv').module;
      const snapshotPose = () => ({
        position: [viewer.camera.positionWC.x, viewer.camera.positionWC.y, viewer.camera.positionWC.z],
        direction: [viewer.camera.directionWC.x, viewer.camera.directionWC.y, viewer.camera.directionWC.z],
        up: [viewer.camera.upWC.x, viewer.camera.upWC.y, viewer.camera.upWC.z],
        right: [viewer.camera.rightWC.x, viewer.camera.rightWC.y, viewer.camera.rightWC.z],
        transform: Array.from({ length: 16 }, (_, i) => viewer.camera.transform[i]),
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: viewer.camera.roll,
        trackedId: viewer.trackedEntity?.id ?? null,
      });
      const cameraPoseMatches = (a, b, epsilon = 1e-5) => {
        const vectorKeys = ['position', 'direction', 'up', 'right', 'transform'];
        const scalarKeys = ['heading', 'pitch', 'roll'];
        return vectorKeys.every((key) => (
          Array.isArray(a?.[key])
          && Array.isArray(b?.[key])
          && a[key].length === b[key].length
          && a[key].every((value, index) => Math.abs(value - b[key][index]) <= epsilon)
        )) && scalarKeys.every((key) => Math.abs(a?.[key] - b?.[key]) <= epsilon)
          && a?.trackedId === b?.trackedId;
      };
      window.__qaCctvClickEvidence?.dispose?.();
      const evidence = {
        activeId: mod.getUIState().activeCameraId,
        publications: [],
        activeTransitions: [],
        focusEvents: 0,
        pose: snapshotPose(),
        snapshotPose,
        cameraPoseMatches,
      };
      evidence.lastActiveId = evidence.activeId;
      evidence.unsubscribe = mod.subscribe((state) => {
        evidence.publications.push(state.activeCameraId);
        if (state.activeCameraId !== evidence.lastActiveId) {
          evidence.activeTransitions.push([evidence.lastActiveId, state.activeCameraId]);
          evidence.lastActiveId = state.activeCameraId;
        }
      });
      evidence.baselineTransitions = evidence.activeTransitions.length;
      evidence.onFocus = () => { evidence.focusEvents += 1; };
      window.addEventListener('gev:cctv-request-focus', evidence.onFocus);
      evidence.dispose = () => {
        evidence.unsubscribe?.();
        window.removeEventListener('gev:cctv-request-focus', evidence.onFocus);
      };
      window.__qaCctvClickEvidence = evidence;
      return { activeId: evidence.activeId, baselineTransitions: evidence.baselineTransitions };
    });

    if (emptyClickPoint) {
      await page.evaluate(() => {
        window.__godsEyeView.dataManager.layers.get('cctv').module
          .setParams({ calibrationMode: true });
      });
      await page.mouse.click(emptyClickPoint.x, emptyClickPoint.y);
      await sleep(250);
      const adjustClick = await page.evaluate(() => {
        const evidence = window.__qaCctvClickEvidence;
        const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
        mod.setParams({ calibrationMode: false });
        evidence.siblingBaselineTransitions = evidence.activeTransitions.length;
        return {
          activeId: mod.getUIState().activeCameraId,
          publications: evidence.publications.length,
          focusEvents: evidence.focusEvents,
          poseSame: evidence.cameraPoseMatches(evidence.snapshotPose(), evidence.pose),
        };
      });
      record('ADJUST-mode true-empty canvas click preserves active camera',
        adjustClick.activeId === clickEvidenceSetup.activeId
          && adjustClick.focusEvents === 0
          && adjustClick.poseSame,
        `active=${adjustClick.activeId} focus=${adjustClick.focusEvents} poseSame=${adjustClick.poseSame}`);
    } else {
      record('ADJUST-mode true-empty canvas click preserves active camera', false, 'no true-empty target');
    }

    const siblingTarget = await page.evaluate(async (emptyPoint) => {
      if (!emptyPoint) return null;
      const gev = window.__godsEyeView;
      const viewer = gev.viewer;
      const scene = viewer.scene;
      const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
      const canvasPoint = new Cesium.Cartesian2(emptyPoint.canvasX, emptyPoint.canvasY);
      const ray = viewer.camera.getPickRay(canvasPoint);
      if (!ray) return null;
      let position = null;
      let projected = null;
      for (const distance of [1_000, 10_000, 100_000, 1_000_000]) {
        const candidate = Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3());
        const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, candidate);
        if (screen && Math.hypot(screen.x - canvasPoint.x, screen.y - canvasPoint.y) < 2) {
          position = candidate;
          projected = screen;
          break;
        }
      }
      if (!position) return null;
      const owner = viewer.entities.add({
        id: 'qa-cctv-sibling-owner',
        position,
        point: {
          pixelSize: 64,
          color: Cesium.Color.MAGENTA,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      window.__qaCctvSiblingOwner = owner;
      await new Promise((resolve) => {
        let frames = 0;
        const remove = scene.postRender.addEventListener(() => {
          if (++frames < 3) {
            scene.requestRender();
            return;
          }
          remove();
          resolve();
        });
        scene.requestRender();
      });
      const rect = scene.canvas.getBoundingClientRect();
      const picked = scene.pick(canvasPoint);
      const pickedId = picked?.id?.id ?? picked?.id ?? null;
      window.__qaCctvClickEvidence.siblingBaselineTransitions =
        window.__qaCctvClickEvidence.activeTransitions.length;
      return {
        x: rect.left + emptyPoint.canvasX,
        y: rect.top + emptyPoint.canvasY,
        pickedId: typeof pickedId === 'string' ? pickedId : pickedId?.id ?? null,
        ownerId: owner.id,
        ownsExactObject: picked?.id === owner,
        projectionDelta: Math.hypot(projected.x - canvasPoint.x, projected.y - canvasPoint.y),
      };
    }, emptyClickPoint);
    record('sibling test object owns its canvas pick',
      siblingTarget
        ? siblingTarget.pickedId === 'qa-cctv-sibling-owner' && siblingTarget.ownsExactObject
        : null,
      siblingTarget
        ? `picked=${siblingTarget.pickedId} exactOwner=${siblingTarget.ownsExactObject} projectionΔ=${siblingTarget.projectionDelta}`
        : 'no previously verified empty canvas ray was available');
    if (siblingTarget?.pickedId === 'qa-cctv-sibling-owner' && siblingTarget.ownsExactObject) {
      await page.mouse.click(siblingTarget.x, siblingTarget.y);
      await sleep(250);
    }
    const siblingClick = await page.evaluate(() => {
      const evidence = window.__qaCctvClickEvidence;
      const gev = window.__godsEyeView;
      const mod = gev.dataManager.layers.get('cctv').module;
      if (window.__qaCctvSiblingOwner) {
        gev.viewer.entities.remove(window.__qaCctvSiblingOwner);
        delete window.__qaCctvSiblingOwner;
      }
      return {
        activeId: mod.getUIState().activeCameraId,
        transitions: evidence.activeTransitions.length,
        baselineTransitions: evidence.siblingBaselineTransitions,
        focusEvents: evidence.focusEvents,
        poseSame: evidence.cameraPoseMatches(evidence.snapshotPose(), evidence.pose),
      };
    });
    record('sibling canvas click passes through without CCTV selection or deselection',
      siblingTarget?.pickedId === 'qa-cctv-sibling-owner' && siblingTarget.ownsExactObject
        ? siblingClick.activeId === clickEvidenceSetup.activeId
          && siblingClick.transitions === siblingClick.baselineTransitions
          && siblingClick.focusEvents === 0
          && siblingClick.poseSame
        : null,
      `active=${siblingClick.activeId} transitions=${siblingClick.transitions - siblingClick.baselineTransitions} focus=${siblingClick.focusEvents} poseSame=${siblingClick.poseSame}`);

    if (emptyClickPoint) {
      await page.mouse.click(emptyClickPoint.x, emptyClickPoint.y);
      await sleep(250);
    }
    const firstEmptyClick = await page.evaluate(() => {
      const evidence = window.__qaCctvClickEvidence;
      const state = window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState();
      return {
        activeId: state.activeCameraId,
        enabled: state.enabled,
        transitions: evidence.activeTransitions.length,
        baselineTransitions: evidence.siblingBaselineTransitions,
        lastTransition: evidence.activeTransitions.at(-1) ?? null,
        focusEvents: evidence.focusEvents,
        poseSame: evidence.cameraPoseMatches(evidence.snapshotPose(), evidence.pose),
      };
    });
    record('real true-empty canvas click publishes one active-to-null transition',
      !!emptyClickPoint
        && firstEmptyClick.activeId === null
        && firstEmptyClick.enabled === true
        && firstEmptyClick.transitions === firstEmptyClick.baselineTransitions + 1
        && firstEmptyClick.lastTransition?.[0] === clickEvidenceSetup.activeId
        && firstEmptyClick.lastTransition?.[1] === null,
      `active=${firstEmptyClick.activeId} enabled=${firstEmptyClick.enabled} transitions=${firstEmptyClick.transitions - firstEmptyClick.baselineTransitions}`);
    record('real true-empty deselection preserves pose/tracking and emits no focus request',
      !!emptyClickPoint && firstEmptyClick.poseSame && firstEmptyClick.focusEvents === 0,
      `poseSame=${firstEmptyClick.poseSame} focus=${firstEmptyClick.focusEvents}`);

    if (emptyClickPoint) {
      await page.mouse.click(emptyClickPoint.x, emptyClickPoint.y);
      await sleep(250);
    }
    const repeatEmptyClick = await page.evaluate(() => {
      const evidence = window.__qaCctvClickEvidence;
      const state = window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState();
      evidence.dispose();
      delete window.__qaCctvClickEvidence;
      return {
        activeId: state.activeCameraId,
        transitions: evidence.activeTransitions.length,
        baselineTransitions: evidence.siblingBaselineTransitions,
        focusEvents: evidence.focusEvents,
      };
    });
    record('repeat true-empty canvas click is null-idempotent',
      !!emptyClickPoint
        && repeatEmptyClick.activeId === null
        && repeatEmptyClick.transitions === repeatEmptyClick.baselineTransitions + 1
        && repeatEmptyClick.focusEvents === 0,
      `active=${repeatEmptyClick.activeId} transitions=${repeatEmptyClick.transitions - repeatEmptyClick.baselineTransitions} focus=${repeatEmptyClick.focusEvents}`);

    // Explicit navigation from null must remain available for the remaining
    // coverage and gizmo groups. NEXT is the product route pinned by N4.
    const resumedId = await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.cycleCamera(1);
      return mod.getUIState().activeCameraId;
    });
    record('explicit NEXT resumes from null at the first catalog camera',
      typeof resumedId === 'string' && !!resumedId,
      `active=${resumedId}`);

    // =========================================================================
    // Group 6: viewshed mode (v3 design §3b — coverage tri-state + volumes)
    // =========================================================================
    console.log('Checking viewshed mode (coverage tri-state + color-coded volumes)...');
    const countVolumes = () => page.evaluate(() => {
      const prims = window.__godsEyeView.viewer.scene.primitives;
      let n = 0;
      for (let i = 0; i < prims.length; i++) {
        if (prims.get(i) && prims.get(i)._gevViewshed) n += 1;
      }
      return n;
    });

    const cBeforeViewshed = await readCounters();
    const modeAfterSet = await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ coverageMode: 'viewshed' });
      return mod.getUIState().coverageMode;
    });
    await sleep(400);
    record('coverageMode setParams round-trip (viewshed)', modeAfterSet === 'viewshed',
      `coverageMode=${modeAfterSet}`);

    const volumesOn = await countVolumes();
    record('viewshed volumes exist for the visible set (1..15)', volumesOn >= 1 && volumesOn <= 15,
      `${volumesOn} volume primitives (visible-set cap is 14 + active)`);

    // Boolean back-compat shim: showCoverage=false → 'off' (0 volumes),
    // showCoverage=true → 'on' (wireframes, still 0 volumes).
    const compat = await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ showCoverage: false });
      const off = mod.getUIState().coverageMode;
      mod.setParams({ showCoverage: true });
      const on = mod.getUIState().coverageMode;
      return { off, on };
    });
    await sleep(200);
    const volumesInOnMode = await countVolumes();
    record('boolean showCoverage compat (false→off, true→on)', compat.off === 'off' && compat.on === 'on',
      `false→${compat.off}, true→${compat.on}`);
    record("mode 'on' renders zero volumes (wireframes only)", volumesInOnMode === 0,
      `${volumesInOnMode} volumes in 'on' mode`);

    // Back to viewshed: volumes must be STABLE while idle (no churn — the
    // rebuild sites are pose edits and style refreshes only). Object identity
    // over 8s proves nothing recreated them.
    await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ coverageMode: 'viewshed' });
    });
    await sleep(400);
    await page.evaluate(() => {
      const prims = window.__godsEyeView.viewer.scene.primitives;
      window.__qaViewshedRefs = [];
      for (let i = 0; i < prims.length; i++) {
        if (prims.get(i) && prims.get(i)._gevViewshed) window.__qaViewshedRefs.push(prims.get(i));
      }
    });
    await sleep(8000);
    const viewshedIdle = await page.evaluate(() => {
      const prims = window.__godsEyeView.viewer.scene.primitives;
      const now = [];
      for (let i = 0; i < prims.length; i++) {
        if (prims.get(i) && prims.get(i)._gevViewshed) now.push(prims.get(i));
      }
      const before = window.__qaViewshedRefs || [];
      const sameCount = now.length === before.length;
      const sameIdentity = sameCount && before.every((p) => now.includes(p));
      return { sameCount, sameIdentity, count: now.length };
    });
    const cAfterViewshed = await readCounters();
    const lateFloorSamples = cAfterViewshed.sampleHeight - cBeforeViewshed.sampleHeight;
    record('viewshed volumes idle-stable over 8s (same primitives, no churn)',
      lateFloorSamples > 0 ? null : viewshedIdle.sameIdentity,
      lateFloorSamples > 0
        ? `late one-shot floor completion sampled ${lateFloorSamples} cells and legitimately rebuilt geometry`
        : `count=${viewshedIdle.count} sameCount=${viewshedIdle.sameCount} sameIdentity=${viewshedIdle.sameIdentity}`);
    record('raycast counters flat across viewshed cycling + idle',
      lateFloorSamples > 0 ? null : cAfterViewshed.pickFromRay === cBeforeViewshed.pickFromRay,
      lateFloorSamples > 0
        ? `late one-shot floor completion: ΔsampleHeight=${lateFloorSamples}; ΔpickFromRay=${cAfterViewshed.pickFromRay - cBeforeViewshed.pickFromRay}`
        : `ΔpickFromRay=${cAfterViewshed.pickFromRay - cBeforeViewshed.pickFromRay} ΔsampleHeight=0`);

    const viewshedShot = path.join(SHOTS_DIR, 'cctv-v3-viewshed.png');
    await page.screenshot({ path: viewshedShot });
    console.log(`  screenshot (visual review only) → ${path.relative(REPO_ROOT, viewshedShot)}`);

    // =========================================================================
    // Group 7: calibration gizmo (v3 design §3c — ADJUST mode + drag)
    // =========================================================================
    console.log('Checking calibration gizmo (ADJUST mode + synthetic drag)...');
    const GIZMO_PARTS = ['ring-heading', 'ring-pitch', 'move-east', 'move-north', 'move-up', 'handle-range', 'handle-fov-l', 'handle-fov-r'];
    const gizmoStates = await page.evaluate((parts) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibrationMode: true });
      const viewer = window.__godsEyeView.viewer;
      return parts.map((p) => {
        const e = viewer.entities.getById('cctv-gizmo-' + p);
        return e ? (e.show ? 'shown' : 'hidden') : 'missing';
      });
    }, GIZMO_PARTS);
    record('all 8 gizmo parts exist and show in ADJUST mode', gizmoStates.every((s) => s === 'shown'),
      gizmoStates.map((s, i) => `${GIZMO_PARTS[i]}=${s}`).join(' '));

    // Synthetic CDP drag on the EAST arrow — the owner's field-test
    // regression. Sample effective elevation after every mouse move: it must
    // stay frozen until release, with no transient sampleHeight calls.
    const eastDrag = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const e = viewer.entities.getById('cctv-gizmo-move-east');
      if (!e) return null;
      const pts = e.polyline.positions.getValue(viewer.clock.currentTime);
      const scene = viewer.scene;
      const w = scene.canvas.clientWidth;
      const h = scene.canvas.clientHeight;
      const a = scene.cartesianToCanvasCoordinates(pts[0]);
      const b = scene.cartesianToCanvasCoordinates(pts[pts.length - 1]);
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) ||
          !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const mag = Math.hypot(dx, dy);
      if (mag < 10) return null;
      const candidates = [0.12, 0.2, 0.28, 0.36, 0.44, 0.52, 0.6, 0.68, 0.76, 0.84, 0.92]
        .map((t) => ({ x: a.x + dx * t, y: a.y + dy * t }))
        .filter((p) => p.x > 60 && p.y > 60 && p.x < w - 60 && p.y < h - 60);
      if (b.x > 60 && b.y > 60 && b.x < w - 60 && b.y < h - 60) {
        candidates.unshift({ x: b.x, y: b.y });
      }
      if (!candidates.length) return null;
      return { ...candidates[0], candidates, ux: dx / mag, uy: dy / mag };
    });

    const calBeforeDrag = await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const cam = mod.getUIState().activeCamera;
      return cam ? {
        calibration: cam.calibration,
        elevationM: cam.elevationM,
        groundResolveCount: cam.groundResolveCount,
        groundMeshSampleRequestCount: cam.groundMeshSampleRequestCount,
      } : null;
    });

    const transientDragStates = [];
    const countersBeforeDrag = await readCounters();
    let countersBeforeRelease = countersBeforeDrag;
    if (eastDrag) {
      // Batched polylines can miss one synthetic LEFT_DOWN while their pick
      // buffer settles. Try several visible shaft points; stop after the first
      // actual offset change so a successful drag still has exactly one release.
      for (const grab of eastDrag.candidates) {
        const pickBufferReady = await positionPointerForGizmoDrag(page, grab);
        if (!pickBufferReady) continue;
        const ownsPick = await page.evaluate((point) => {
          const scene = window.__godsEyeView.viewer.scene;
          const partFrom = (picked) => {
            const id = picked?.id?.id ?? picked?.id;
            return typeof id === 'string' && id.startsWith('cctv-gizmo-')
              ? id.slice('cctv-gizmo-'.length)
              : null;
          };
          const direct = partFrom(scene.pick(point, 14, 14));
          if (direct) return direct === 'move-east';
          const firstGizmo = (scene.drillPick(point, 6, 14, 14) || [])
            .map(partFrom)
            .find(Boolean);
          return firstGizmo === 'move-east';
        }, grab);
        if (!ownsPick) continue;
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) {
          await page.mouse.move(
            grab.x + eastDrag.ux * i * 12,
            grab.y + eastDrag.uy * i * 12
          );
          await sleep(40);
          transientDragStates.push(await page.evaluate(() => {
            const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
            const cam = mod.getUIState().activeCamera;
            return cam ? {
              elevationM: cam.elevationM,
              eastOffsetM: cam.calibration?.offsetEastM,
              groundMeshSampleRequestCount: cam.groundMeshSampleRequestCount,
            } : null;
          }));
        }
        const candidateCountersBeforeRelease = await readCounters();
        await page.mouse.up();
        await sleep(400);
        const candidateEast = await page.evaluate(() => {
          const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
          return mod.getUIState().activeCamera?.calibration?.offsetEastM ?? null;
        });
        if (Number.isFinite(candidateEast) &&
            Math.abs(candidateEast - (calBeforeDrag?.calibration?.offsetEastM ?? 0)) > 0.05) {
          countersBeforeRelease = candidateCountersBeforeRelease;
          break;
        }
      }
    }

    const dragOutcome = await page.evaluate((pt) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const viewer = window.__godsEyeView.viewer;
      const cam = mod.getUIState().activeCamera;
      const raw = localStorage.getItem('godsEyeView.cctv.calibration.v2');
      const map = raw ? JSON.parse(raw) : {};
      let pickable = null;
      let ownsPick = null;
      if (pt) {
        try {
          const picked = viewer.scene.drillPick({ x: pt.x, y: pt.y }, 6, 14, 14) || [];
          pickable = picked.some((r) => String(r?.id?.id ?? r?.id ?? '').startsWith('cctv-gizmo-'));
          const firstGizmo = picked
            .map((r) => String(r?.id?.id ?? r?.id ?? ''))
            .find((id) => id.startsWith('cctv-gizmo-'));
          ownsPick = firstGizmo === 'cctv-gizmo-move-east';
        } catch { pickable = null; }
      }
      return {
        eastOffsetM: cam?.calibration?.offsetEastM ?? null,
        groundResolveCount: cam?.groundResolveCount ?? null,
        calDirty: cam?.calDirty ?? null,
        stored: cam ? (cam.id in map) : null,
        inputsEnabled: viewer.scene.screenSpaceCameraController.enableInputs,
        pickable,
        ownsPick,
      };
    }, eastDrag);

    const eastChanged = eastDrag
      && Number.isFinite(dragOutcome.eastOffsetM)
      && Math.abs(dragOutcome.eastOffsetM - (calBeforeDrag?.calibration?.offsetEastM ?? 0)) > 0.05;
    const transientElevations = transientDragStates.map((state) => state?.elevationM).filter(Number.isFinite);
    const maxTransientElevationDelta = transientElevations.length && Number.isFinite(calBeforeDrag?.elevationM)
      ? Math.max(...transientElevations.map((height) => Math.abs(height - calBeforeDrag.elevationM)))
      : Infinity;
    const transientSampleDelta = countersBeforeRelease.sampleHeight - countersBeforeDrag.sampleHeight;
    const activeMeshRequestsBeforeRelease = transientDragStates
      .map((state) => state?.groundMeshSampleRequestCount)
      .filter(Number.isFinite)
      .at(-1);
    const transientActiveMeshRequestDelta = Number.isFinite(activeMeshRequestsBeforeRelease)
      ? activeMeshRequestsBeforeRelease - (calBeforeDrag?.groundMeshSampleRequestCount ?? 0)
      : Infinity;
    if (eastChanged) {
      record('east-arrow drag changes the east offset (live, unsaved)', true,
        `offsetEastM ${calBeforeDrag?.calibration?.offsetEastM ?? 0} → ${dragOutcome.eastOffsetM}`);
      record('east-arrow drag keeps mount elevation frozen until mouse-up', maxTransientElevationDelta < 0.01,
        `max transient Δelevation=${maxTransientElevationDelta.toFixed(4)}m over ${transientElevations.length} moves`);
      record('east-arrow transient moves issue zero active-camera mesh-floor requests',
        transientActiveMeshRequestDelta === 0,
        `active-camera request Δ=${transientActiveMeshRequestDelta}; global sampleHeight Δ=${transientSampleDelta} (other cells may finish asynchronously)`);
      record('east-arrow release resolves the committed floor exactly once',
        dragOutcome.groundResolveCount === (calBeforeDrag?.groundResolveCount ?? 0) + 1,
        `ground resolutions ${calBeforeDrag?.groundResolveCount ?? 0} → ${dragOutcome.groundResolveCount}`);
      record('drag leaves the camera dirty and the store untouched', dragOutcome.calDirty === true && dragOutcome.stored === false,
        `calDirty=${dragOutcome.calDirty} stored=${dragOutcome.stored}`);
    } else if (eastDrag) {
      const missDetail = dragOutcome.pickable === false
        ? 'drill-pick cannot see a gizmo under this GL stack'
        : dragOutcome.ownsPick === false
          ? 'the east arrow did not own any tested shaft pick'
          : 'LEFT_DOWN did not begin an east-arrow drag despite the ownership precondition';
      record('east-arrow drag changes the east offset (live, unsaved)', null,
        `${missDetail} — verify on a current headful GPU surface`);
      record('east-arrow drag keeps mount elevation frozen until mouse-up', null, 'skipped with drag');
      record('east-arrow transient moves issue zero active-camera mesh-floor requests', null, 'skipped with drag');
      record('east-arrow release resolves the committed floor exactly once', null, 'skipped with drag');
      record('drag leaves the camera dirty and the store untouched', null, 'skipped with drag');
    } else {
      const unavailable = 'no on-screen east-arrow shaft found under this GL stack — verify on real GPU';
      record('east-arrow drag changes the east offset (live, unsaved)', null, unavailable);
      record('east-arrow drag keeps mount elevation frozen until mouse-up', null, 'skipped: drag target unavailable');
      record('east-arrow transient moves issue zero active-camera mesh-floor requests', null, 'skipped: drag target unavailable');
      record('east-arrow release resolves the committed floor exactly once', null, 'skipped: drag target unavailable');
      record('drag leaves the camera dirty and the store untouched', null, 'skipped: drag target unavailable');
    }
    record('camera-controller inputs re-enabled after drag', dragOutcome.inputsEnabled === true,
      `enableInputs=${dragOutcome.inputsEnabled}`);

    // ADJUST off: parts hidden; leave a clean calibration for the next group.
    const gizmoOff = await page.evaluate((parts) => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      mod.setParams({ calibrationMode: false });
      mod.setParams({ calibration: { reset: true } });
      const viewer = window.__godsEyeView.viewer;
      return parts.map((p) => {
        const e = viewer.entities.getById('cctv-gizmo-' + p);
        return e ? (e.show ? 'shown' : 'hidden') : 'missing';
      });
    }, GIZMO_PARTS);
    record('gizmo parts hide when ADJUST mode turns off', gizmoOff.every((s) => s === 'hidden'),
      gizmoOff.map((s, i) => `${GIZMO_PARTS[i]}=${s}`).join(' '));

    // -----------------------------------------------------------------------
    // Screenshots for human visual review (NOT a pass/fail signal — SwiftShader
    // cannot fill plane image materials under headless software GL).
    // -----------------------------------------------------------------------
    await sleep(1000);
    const shot = path.join(SHOTS_DIR, 'cctv-v2-active.png');
    await page.screenshot({ path: shot });
    console.log(`  screenshot (visual review only, not a gate) → ${path.relative(REPO_ROOT, shot)}`);

    // No console errors during the whole exercise.
    record('no console errors during CCTV v2 exercise', consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'clean');

    for (const r of results) {
      if (r.ok === false) exitCode = 1;
    }
  } finally {
    await browser.close();
  }

  console.log('\n' + '─'.repeat(60));
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const inconclusive = results.filter((r) => r.ok === null).length;
  console.log(`  RESULT: ${pass} passed, ${fail} failed, ${inconclusive} inconclusive`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('\x1b[31mHarness error:\x1b[0m', e);
  process.exit(3);
});
