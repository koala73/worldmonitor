#!/usr/bin/env node
/**
 * Moving visual evidence for focus de-emphasis and aircraft recession.
 *
 * The operator owns the live dev server; this script never starts one:
 *   node scripts/qa-focus-evidence.mjs --url http://localhost:4173 \
 *     --screenshots-dir qa-shots/focus-evidence \
 *     --json qa-shots/focus-evidence/report.json
 *   node scripts/qa-focus-evidence.mjs --headful --smoke
 *   node scripts/qa-focus-evidence.mjs --url http://localhost:4173 \
 *     --params '{"focus":{"dimFloor":0.35},"horizon":{"scaleFloor":0.5}}'
 *   node scripts/qa-focus-evidence.mjs --headful --basemap osm
 *
 * The harness owns the Cesium frame clock during capture: every frame applies
 * synthetic updates, advances explicit virtual time, calls scene.render(),
 * then screenshots. Headless mode keeps SwiftShader for CI-relative evidence;
 * --headful drops those flags and is the real-GPU visual sign-off path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const hasFlag = (name) => argv.includes(name);

const APP_URL = getOpt('--url', 'http://localhost:4173');
const JSON_PATH = path.resolve(getOpt('--json', 'qa-shots/focus-evidence/report.json'));
const SCREENSHOTS_DIR = path.resolve(getOpt('--screenshots-dir', 'qa-shots/focus-evidence'));
const HEADFUL = hasFlag('--headful');
const SMOKE = hasFlag('--smoke');
const MAP_STACK_IDS = Object.freeze(['photoreal', 'bing-aerial', 'bing-labels', 'osm']);
const BASEMAP = getOpt('--basemap', 'photoreal');
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const FRAME_COUNT = SMOKE ? 6 : 30;
const FRAME_MS = 100;
const TILE_SETTLE_TIMEOUT_MS = 45_000;
const TARGET_ID = 'f0c001';
const _firstCaptureScenarios = new Set();
if (!MAP_STACK_IDS.includes(BASEMAP)) {
  throw new Error(`Invalid --basemap ${BASEMAP}; expected one of ${MAP_STACK_IDS.join(', ')}`);
}
const TARGET = Object.freeze({
  id: TARGET_ID,
  callsign: 'FOCUS1',
  longitude: -97.7431,
  latitude: 30.2672,
  altitudeM: 3_000,
  klass: 'airliner',
});
// Owner's 13:58 horizon composition: a low, east-facing regional view whose
// distant field sits close to the geometric limb instead of a whole-globe view.
const HORIZON_CAMERA = Object.freeze([
  -100, 30, 1_000_000, Math.PI / 2, -0.52,
]);

function parseParams() {
  const raw = getOpt('--params');
  if (!raw) return { focus: {}, horizon: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid --params JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--params must be a JSON object');
  }
  if (parsed.focus || parsed.horizon) {
    if ((parsed.focus && (typeof parsed.focus !== 'object' || Array.isArray(parsed.focus)))
      || (parsed.horizon && (typeof parsed.horizon !== 'object' || Array.isArray(parsed.horizon)))) {
      throw new Error('--params focus and horizon values must be JSON objects');
    }
    return { focus: parsed.focus || {}, horizon: parsed.horizon || {} };
  }
  const focusKeys = new Set([
    'paddingPx', 'dimFloor', 'nearerBehavior', 'hysteresisPx',
    'distanceHysteresisRatio', 'attackMs', 'releaseMs', 'writeEpsilon',
  ]);
  const horizonKeys = new Set([
    'startLimbRatio', 'scaleFloor', 'alphaFloor', 'combinedAlphaFloor',
    'globeViewBlendStartM', 'globeViewBlendEndM', 'globeViewHeightM',
    'earthRadiusM', 'writeEpsilon',
  ]);
  const focus = {};
  const horizon = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (focusKeys.has(key)) focus[key] = value;
    if (horizonKeys.has(key)) horizon[key] = value;
  }
  return { focus, horizon };
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v, amount) {
  return [v[0] * amount, v[1] * amount, v[2] * amount];
}

function screenPlanePosition(basis, xPx, yPx, fartherM = 0) {
  return add(
    add(
      add(basis.target, scale(basis.right, xPx * basis.metresPerPixel)),
      scale(basis.up, yPx * basis.metresPerPixel),
    ),
    scale(basis.away, fartherM),
  );
}

function shotPath(scenario, frame) {
  return path.join(SCREENSHOTS_DIR, `${scenario}-${frame}.png`);
}

async function readTileReadiness(page) {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const controller = gev.mapStackController;
    const activeStack = controller?.getActiveId?.() || null;
    const tileset = controller?.googleTileset || gev.tileset || null;
    const applicable = activeStack === 'photoreal' && tileset?.show !== false;
    return {
      tilesSettled: !applicable || tileset?.tilesLoaded === true,
      tileSettleApplicable: applicable,
      activeStack,
    };
  });
}

async function awaitTilesSettled(page, scenario) {
  const result = await page.evaluate(async (timeoutMs) => {
    const gev = window.__godsEyeView;
    const controller = gev.mapStackController;
    const activeStack = controller?.getActiveId?.() || null;
    // The map-stack controller owns the authoritative Google tileset handle;
    // the bootstrap field is retained only as a compatibility fallback.
    const tileset = controller?.googleTileset || gev.tileset || null;
    const applicable = activeStack === 'photoreal' && tileset?.show !== false;
    if (!applicable) {
      return {
        tilesSettled: true,
        tileSettleApplicable: false,
        activeStack,
        timedOut: false,
      };
    }
    if (tileset.tilesLoaded === true) {
      return {
        tilesSettled: true,
        tileSettleApplicable: true,
        activeStack,
        timedOut: false,
      };
    }

    let allTilesLoadedObserved = false;
    const removeListener = tileset.allTilesLoaded?.addEventListener?.(() => {
      allTilesLoadedObserved = true;
    });
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        gev.viewer.scene.render(gev.viewer.clock.currentTime);
        if (tileset.tilesLoaded === true || allTilesLoadedObserved) {
          return {
            tilesSettled: true,
            tileSettleApplicable: true,
            activeStack,
            timedOut: false,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        tilesSettled: false,
        tileSettleApplicable: true,
        activeStack,
        timedOut: true,
      };
    } finally {
      if (typeof removeListener === 'function') removeListener();
    }
  }, TILE_SETTLE_TIMEOUT_MS);
  const status = result.tilesSettled ? 'settled' : `NOT settled after ${TILE_SETTLE_TIMEOUT_MS / 1000}s`;
  console.log(`    tiles (${scenario}): ${status}`);
  return result;
}

async function capture(page, scenario, frame) {
  if (!_firstCaptureScenarios.has(scenario)) {
    _firstCaptureScenarios.add(scenario);
    await awaitTilesSettled(page, scenario);
  }
  const tileReadiness = await readTileReadiness(page);
  const out = shotPath(scenario, frame);
  // Chromium's Page.captureScreenshot can wedge while a manually driven
  // WebGL surface is paused. Reading the explicitly rendered canvas captures
  // that same frame without handing frame ownership back to the browser.
  const dataUrl = await page.evaluate(() => (
    window.__godsEyeView.viewer.scene.canvas.toDataURL('image/png')
  ));
  fs.writeFileSync(out, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return { file: out, ...tileReadiness };
}

async function captureSequenceFrame(page, scenario, frameIndex, update) {
  if (SMOKE) console.log(`    frame ${frameIndex + 1}/${FRAME_COUNT}: update`);
  await update();
  if (SMOKE) console.log(`    frame ${frameIndex + 1}/${FRAME_COUNT}: render`);
  await advanceEvidenceFrame(page, FRAME_MS);
  if (SMOKE) console.log(`    frame ${frameIndex + 1}/${FRAME_COUNT}: screenshot`);
  return capture(page, scenario, `frame-${String(frameIndex).padStart(2, '0')}`);
}

async function takeFrameClock(page) {
  const result = await page.evaluate(() => {
    const seam = window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence;
    return seam.takeFrameClock();
  });
  if (!result?.ok) throw new Error('Unable to take ownership of the evidence frame clock');
}

async function advanceEvidenceFrame(page, deltaMs = FRAME_MS) {
  return page.evaluate((stepMs) => {
    const gev = window.__godsEyeView;
    const viewer = gev.viewer;
    const seam = gev.dataManager.layers.get('flights').module.__focusEvidence;
    const nowMs = seam.advanceFrameClock(stepMs);
    const JulianDate = viewer.clock.currentTime.constructor;
    JulianDate.addSeconds(viewer.clock.currentTime, stepMs / 1000, viewer.clock.currentTime);
    viewer.dataSourceDisplay?.update(viewer.clock.currentTime);
    viewer.scene.render(viewer.clock.currentTime);
    // Cross a task boundary so Chrome can commit the explicitly rendered
    // surface before capture. Cesium's drained default loop stays disabled.
    return new Promise((resolve) => setTimeout(() => resolve(nowMs), 0));
  }, deltaMs);
}

async function advanceEvidenceDuration(page, durationMs) {
  // Cross one 80 ms consumer quantum to publish newly changed desired state,
  // then jump to the requested endpoint. A zero-delta render is insufficient:
  // the production focus passes correctly retain their cadence gate.
  const totalMs = Math.max(0, durationMs);
  const publishMs = Math.min(80, totalMs);
  await advanceEvidenceFrame(page, publishMs);
  if (totalMs > publishMs) await advanceEvidenceFrame(page, totalMs - publishMs);
}

async function releaseFrameClock(page) {
  await page.evaluate(() => {
    window.__godsEyeView.dataManager.layers
      .get('flights').module.__focusEvidence.releaseFrameClock();
  });
}

async function installSyntheticFetches(page) {
  await page.evaluateOnNewDocument(() => {
    const realFetch = window.fetch.bind(window);
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/api/opensky-track')) return json({ path: [] });
      if (url.includes('/api/adsblol/trace')) return json({ timestamp: Date.now() / 1000, trace: [] });
      if (url.includes('/api/opensky')) return json({ time: Math.floor(Date.now() / 1000), states: [] });
      if (url.includes('/api/adsbdb/')) return json({ found: false });
      if (url.includes('/api/ais-live')) return json({ status: 'open', rows: [] });
      return realFetch(input, init);
    };
  });
}

async function waitForApp(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => Boolean(window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager),
    { timeout: 60_000, polling: 200 },
  );
}

async function setBasemap(page, stackId) {
  const result = await page.evaluate(async (id) => (
    window.__godsEyeView.styleManager.setMapStack(id)
  ), stackId);
  if (!result?.ok) {
    throw new Error(`Unable to activate --basemap ${stackId}: ${result?.error || 'unknown error'}`);
  }
  return result.activeStack;
}

async function enableLayer(page, layerId) {
  await page.evaluate(async (id) => {
    await window.__godsEyeView.dataManager.setEnabled(id, true);
  }, layerId);
}

async function requireEvidenceSeams(page) {
  const result = await page.evaluate(() => {
    const manager = window.__godsEyeView.dataManager;
    return {
      flights: Boolean(manager.layers.get('flights')?.module?.__focusEvidence),
      vessels: Boolean(manager.layers.get('ais-live-vessels')?.module?.__focusEvidence),
    };
  });
  if (!result.flights || !result.vessels) {
    throw new Error('Focus evidence seams are unavailable. Use the Vite dev server (not a production preview/build).');
  }
}

async function setCamera(page, values) {
  await page.evaluate(([lon, lat, height, heading, pitch]) => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.trackedEntity = undefined;
    viewer.camera.cancelFlight?.();
    viewer.scene.tweens?.removeAll?.();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: lon * Math.PI / 180,
        latitude: lat * Math.PI / 180,
        height,
      }),
      orientation: { heading, pitch, roll: 0 },
    });
  }, values);
  await advanceEvidenceDuration(page, 300);
}

async function injectAndTrackTarget(page, extraAircraft = [], target = TARGET) {
  const result = await page.evaluate(({ targetRecord, extras }) => {
    const layer = window.__godsEyeView.dataManager.layers.get('flights').module;
    const injected = layer.__focusEvidence.setAircraft([targetRecord, ...extras]);
    const tracked = layer.trackById(targetRecord.id);
    return { injected, tracked };
  }, { targetRecord: target, extras: extraAircraft });
  if (!result.injected?.ok || !result.tracked) {
    throw new Error(`Synthetic target setup failed: ${JSON.stringify(result)}`);
  }
  await page.waitForFunction(
    () => Boolean(window.__godsEyeView.viewer.trackedEntity),
    { timeout: 10_000 },
  );
  await advanceEvidenceDuration(page, 400);
}

async function readTrackedBasis(page) {
  return page.evaluate((targetId) => {
    const gev = window.__godsEyeView;
    const layer = gev.dataManager.layers.get('flights').module;
    const target = layer.getAllPositions(100).find((entry) => entry.id === targetId)?.position;
    const camera = gev.viewer.camera;
    if (!target) throw new Error('Tracked target position unavailable');
    const toTarget = {
      x: target.x - camera.positionWC.x,
      y: target.y - camera.positionWC.y,
      z: target.z - camera.positionWC.z,
    };
    const distance = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
    const canvasHeight = gev.viewer.scene.canvas.clientHeight;
    const metresPerPixel = (2 * distance * Math.tan(camera.frustum.fovy / 2)) / canvasHeight;
    return {
      target: [target.x, target.y, target.z],
      right: [camera.rightWC.x, camera.rightWC.y, camera.rightWC.z],
      up: [camera.upWC.x, camera.upWC.y, camera.upWC.z],
      away: [toTarget.x / distance, toTarget.y / distance, toTarget.z / distance],
      metresPerPixel,
      targetDistanceM: distance,
    };
  }, TARGET_ID);
}

async function flightSnapshot(page) {
  return page.evaluate(() => (
    window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence.snapshot()
  ));
}

async function setTuning(page, params) {
  return page.evaluate((next) => (
    window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence.setTuning(next)
  ), params);
}

async function runControlledCrossing(page, effectiveParams) {
  const scenario = 's1-controlled-crossing';
  if (SMOKE) console.log('    setup: inject + track');
  await injectAndTrackTarget(page, [{ ...TARGET, id: 'f0c002', callsign: 'CROSS2' }]);
  if (SMOKE) console.log('    setup: read tracked basis');
  const basis = await readTrackedBasis(page);
  // Stay beyond the default 8% range-side hysteresis band so S1 exercises
  // the farther-contact dim path instead of hovering in its neutral band.
  const crossingDepthM = Math.max(600, basis.targetDistanceM * 0.12);
  const start = screenPlanePosition(basis, -180, 0, crossingDepthM);
  await page.evaluate((position) => {
    const seam = window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence;
    seam.moveAircraft([{ id: 'f0c002', cartesian: position, trackDeg: 90 }]);
  }, start);
  // The placeholder begins at the target so tracking can establish its camera
  // first. Restore fully off-target before frame 0; otherwise the sequence
  // would start with inherited dimming rather than showing a true attack.
  if (SMOKE) console.log('    setup: settle off-target contact');
  await advanceEvidenceDuration(page, effectiveParams.focus.releaseMs + 150);
  const frames = [];
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    const xPx = -180 + (360 * i) / (FRAME_COUNT - 1);
    const cartesian = screenPlanePosition(basis, xPx, 0, crossingDepthM);
    const captured = await captureSequenceFrame(page, scenario, i, () => page.evaluate((position) => {
      const seam = window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence;
      seam.moveAircraft([{ id: 'f0c002', cartesian: position, trackDeg: 90 }]);
    }, cartesian));
    const snapshot = await flightSnapshot(page);
    frames.push({ index: i, xPx, ...captured, contacts: snapshot });
  }
  return { id: scenario, frameCount: frames.length, basis, crossingDepthM, frames };
}

async function vesselRowsAroundTarget(page) {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const layer = gev.dataManager.layers.get('flights').module;
    const target = layer.getAllPositions(100).find((entry) => entry.id === 'f0c001')?.position;
    const Cartographic = gev.viewer.camera.positionCartographic.constructor;
    const ellipsoid = gev.viewer.scene.globe.ellipsoid;
    const rows = [];
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      const eastM = Math.cos(angle) * (15 + (i % 3) * 12);
      const northM = Math.sin(angle) * (15 + (i % 3) * 12);
      // Cesium.Transforms is not global; a small local lat/lon offset is
      // sufficient at harbor scale and keeps the injected vessel at sea level.
      const carto = Cartographic.fromCartesian(target, ellipsoid);
      const lat = carto.latitude * 180 / Math.PI + northM / 111_320;
      const lon = carto.longitude * 180 / Math.PI
        + eastM / (111_320 * Math.cos(carto.latitude));
      rows.push({
        mmsi: String(990000000 + i),
        name: `HARBOR ${String(i + 1).padStart(2, '0')}`,
        lat,
        lon,
        speed: 4 + (i % 5),
        course: (i * 31) % 360,
        type: i % 3 === 0 ? 'Cargo' : 'Tug',
      });
    }
    return rows;
  });
}

async function runHarborClutter(page, effectiveParams) {
  const scenario = 's2-harbor-clutter';
  const lowTarget = { ...TARGET, altitudeM: 50 };
  // Harbor contacts straddle the tracked low-altitude subject's range. This
  // scenario deliberately exercises the documented tunable all-overlap policy
  // instead of being neutralized by the production `allow` range band.
  const clutterFocus = { ...effectiveParams.focus, nearerBehavior: 'dim' };
  await injectAndTrackTarget(page, [], lowTarget);
  const rows = await vesselRowsAroundTarget(page);
  await page.evaluate((vessels) => {
    const seam = window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels').module.__focusEvidence;
    seam.setVessels(vessels);
  }, rows);

  await setTuning(page, { focus: { ...clutterFocus, dimFloor: 1 } });
  await advanceEvidenceDuration(page, 450);
  const beforeCapture = await capture(page, scenario, 'before');
  const before = await page.evaluate(() => (
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels').module.__focusEvidence.snapshot()
  ));

  await setTuning(page, { ...effectiveParams, focus: clutterFocus });
  await advanceEvidenceDuration(page, Math.max(500, effectiveParams.focus.attackMs + 200));
  const afterCapture = await capture(page, scenario, 'after');
  const after = await page.evaluate(() => (
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels').module.__focusEvidence.snapshot()
  ));
  await setTuning(page, effectiveParams);
  return {
    id: scenario,
    focusParams: clutterFocus,
    frames: [
      { phase: 'before', ...beforeCapture, contacts: before },
      { phase: 'after', ...afterCapture, contacts: after },
    ],
  };
}

async function runAirportTraffic(page, effectiveParams) {
  const scenario = 's3-airport-traffic';
  const placeholders = Array.from({ length: 40 }, (_, index) => ({
    ...TARGET,
    id: `f3${String(index).padStart(4, '0')}`,
    callsign: `APT${String(index).padStart(2, '0')}`,
    klass: index % 7 === 0 ? 'widebody' : index % 5 === 0 ? 'fastjet' : 'airliner',
  }));
  await injectAndTrackTarget(page, placeholders);
  const basis = await readTrackedBasis(page);
  const trafficDepthM = Math.max(600, basis.targetDistanceM * 0.12);
  const startingMoves = placeholders.map((record, index) => {
    const angle = (index / placeholders.length) * Math.PI * 2;
    return {
      id: record.id,
      cartesian: screenPlanePosition(
        basis,
        Math.cos(angle) * 220,
        Math.sin(angle) * 220 * 0.55,
        trafficDepthM + index * 3,
      ),
      trackDeg: (angle * 180 / Math.PI + 180) % 360,
    };
  });
  await page.evaluate((positions) => {
    const seam = window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence;
    seam.moveAircraft(positions);
  }, startingMoves);
  await advanceEvidenceDuration(page, effectiveParams.focus.releaseMs + 150);
  const frames = [];
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const progress = frame / (FRAME_COUNT - 1);
    const radiusPx = 220 - 205 * progress;
    const moves = placeholders.map((record, index) => {
      const angle = (index / placeholders.length) * Math.PI * 2 + progress * 0.35;
      return {
        id: record.id,
        cartesian: screenPlanePosition(
          basis,
          Math.cos(angle) * radiusPx,
          Math.sin(angle) * radiusPx * 0.55,
          trafficDepthM + index * 3,
        ),
        trackDeg: (angle * 180 / Math.PI + 180) % 360,
      };
    });
    const captured = await captureSequenceFrame(page, scenario, frame, () => page.evaluate((positions) => {
      const seam = window.__godsEyeView.dataManager.layers.get('flights').module.__focusEvidence;
      seam.moveAircraft(positions);
    }, moves));
    frames.push({ index: frame, radiusPx, ...captured, contacts: await flightSnapshot(page) });
  }
  return { id: scenario, frameCount: frames.length, basis, frames };
}

async function runHorizonBand(page, effectiveParams) {
  const scenario = 's4-horizon-band';
  await page.evaluate(() => {
    window.__godsEyeView.dataManager.layers.get('flights').module.stopTracking();
  });
  const contacts = [];
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 10; column += 1) {
      contacts.push({
        id: `f4${String(row * 10 + column).padStart(4, '0')}`,
        callsign: `LIMB${String(row * 10 + column).padStart(2, '0')}`,
        longitude: -70.5 + column * 0.42,
        latitude: 27.5 + row * 0.95,
        altitudeM: 10_000 + (column % 3) * 800,
        klass: column % 4 === 0 ? 'widebody' : 'airliner',
      });
    }
  }
  await page.evaluate((records) => {
    window.__godsEyeView.dataManager.layers.get('flights')
      .module.__focusEvidence.setAircraft(records);
  }, contacts);
  await setCamera(page, HORIZON_CAMERA);

  await setTuning(page, {
    horizon: { ...effectiveParams.horizon, scaleFloor: 1, alphaFloor: 1 },
  });
  await advanceEvidenceDuration(page, 450);
  const beforeCapture = await capture(page, scenario, 'before');
  const before = await flightSnapshot(page);

  await setTuning(page, effectiveParams);
  await advanceEvidenceDuration(page, 450);
  const afterCapture = await capture(page, scenario, 'after');
  const after = await flightSnapshot(page);
  return {
    id: scenario,
    camera: HORIZON_CAMERA,
    frames: [
      { phase: 'before', ...beforeCapture, contacts: before },
      { phase: 'after', ...afterCapture, contacts: after },
    ],
  };
}

async function browserContext(page, browser) {
  const gl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      dpr: window.devicePixelRatio,
      vendor: debug
        ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL)
        : context?.getParameter(context.VENDOR) || 'unavailable',
      renderer: debug
        ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : context?.getParameter(context.RENDERER) || 'unavailable',
    };
  });
  return {
    browser: await browser.version(),
    userAgent: gl.userAgent,
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    viewport: { ...VIEWPORT, dpr: gl.dpr },
    machine: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
    },
    caveat: HEADFUL
      ? 'Headful capture omits SwiftShader flags and is the real-GPU visual sign-off path.'
      : 'SwiftShader/headless output is relative-only; rerun with --headful for real-GPU sign-off.',
  };
}

async function main() {
  const requestedParams = parseParams();
  const response = await fetch(APP_URL).catch((error) => ({ ok: false, statusText: error.message }));
  if (!response.ok) {
    throw new Error(`Live dev server unavailable at ${APP_URL}: ${response.status || response.statusText}`);
  }
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });

  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    protocolTimeout: 300000,
    args: [
      ...(HEADFUL ? [] : ['--enable-unsafe-swiftshader', '--use-gl=swiftshader']),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const consoleMessages = [];
  page.on('console', (message) => {
    if (['error', 'warning', 'warn'].includes(message.type())) {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message }));

  const report = {
    generatedAt: new Date().toISOString(),
    url: APP_URL,
    screenshotsDir: SCREENSHOTS_DIR,
    requestedParams,
    requestedBasemap: BASEMAP,
    activeBasemap: null,
    smoke: SMOKE,
    effectiveParams: null,
    context: null,
    scenarios: [],
    consoleMessages,
  };
  try {
    await installSyntheticFetches(page);
    await waitForApp(page);
    report.activeBasemap = await setBasemap(page, BASEMAP);
    await enableLayer(page, 'flights');
    await enableLayer(page, 'ais-live-vessels');
    await requireEvidenceSeams(page);
    await takeFrameClock(page);
    report.context = await browserContext(page, browser);
    report.effectiveParams = await setTuning(page, requestedParams);

    console.log(`Focus evidence → ${APP_URL}`);
    console.log(`  screenshots: ${SCREENSHOTS_DIR}`);
    console.log(`  renderer   : ${report.context.webglRenderer}`);
    console.log(`  basemap    : ${report.activeBasemap}`);
    console.log(`  params     : ${JSON.stringify(report.effectiveParams)}`);
    console.log(`  mode       : ${SMOKE ? 'smoke (S1, 6 frames)' : 'full (S1-S4)'}`);
    console.log(`  caveat     : ${report.context.caveat}`);

    const scenarios = [
      ['S1 controlled crossing', () => runControlledCrossing(page, report.effectiveParams)],
      ['S2 harbor clutter', () => runHarborClutter(page, report.effectiveParams)],
      ['S3 airport traffic', () => runAirportTraffic(page, report.effectiveParams)],
      ['S4 horizon band', () => runHorizonBand(page, report.effectiveParams)],
    ];
    for (const [label, run] of (SMOKE ? scenarios.slice(0, 1) : scenarios)) {
      console.log(`  capture    : ${label}`);
      await page.bringToFront();
      report.scenarios.push(await run());
    }
  } finally {
    if (!page.isClosed()) await releaseFrameClock(page).catch(() => {});
    await browser.close();
  }

  fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`  report     : ${JSON_PATH}`);
  if (consoleMessages.some((message) => message.type === 'error' || message.type === 'pageerror')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
