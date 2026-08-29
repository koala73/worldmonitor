#!/usr/bin/env node
/**
 * Deterministic QA for the detection overlay's bounded two-lane label pipeline.
 *
 * Run:
 *   node scripts/qa-labels.mjs --url http://localhost:4173
 *
 * The harness replaces only the three detection read APIs in the loaded page.
 * It does not enable their network pollers or mutate repository data. The field
 * contains 12,000 stable observations and is sampled while the global camera
 * makes a small orbit.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const APP_ORIGIN = new URL(APP_URL).origin;
const HEADFUL = getFlag('--headful');
const SHOT_DIR = path.resolve('qa-shots/labels');
const STORAGE_KEY = 'gev:detection-allocation:v1';
const OBSERVATION_COUNT = 12000;
const SYNTHETIC_SAMPLE_MS = 10000;
const NORMAL_SAMPLE_MS = 6000;
const SAMPLE_TIMEOUT_MS = 120000;
const MIN_SYNTHETIC_SOLVES = 20;
const MIN_SYNTHETIC_SPAN_MS = SYNTHETIC_SAMPLE_MS;
const MIN_NORMAL_FRAMES = 20;
const SETTLED_SOLVE_COUNT = 3;
const GLOBAL_CAMERA_MIN_HEIGHT_M = 20_000_000;
const GLOBAL_CAMERA_MAX_HEIGHT_M = 30_000_000;
const FIELD_COUNTS = Object.freeze({
  flights: 7200,
  military: 1000,
  satellites: 3800,
});
const NORMAL_COUNTS = Object.freeze({
  flights: 4300,
  military: 70,
  satellites: 830,
});

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
      // Let Puppeteer use its bundled browser.
    }
  }
  return null;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1)];
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function analyzeMembership(samples) {
  let replacements = 0;
  let exposure = 0;
  const transitions = new Map();

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const current = new Set(sample.labeledKeys);
    if (index > 0) {
      const previous = new Set(samples[index - 1].labeledKeys);
      const removed = [...previous].filter((key) => !current.has(key)).length;
      const added = [...current].filter((key) => !previous.has(key)).length;
      replacements += Math.max(removed, added);
      const elapsedSec = Math.max(0.001, (sample.t - samples[index - 1].t) / 1000);
      exposure += Math.max(1, (previous.size + current.size) / 2) * elapsedSec;
    }
    for (const key of current) {
      if (!transitions.has(key)) transitions.set(key, []);
      transitions.get(key).push(sample.t);
    }
  }

  let showHideShow = 0;
  for (const times of transitions.values()) {
    for (let index = 1; index < times.length; index++) {
      const previousIndex = samples.findIndex((sample) => sample.t === times[index - 1]);
      const nextIndex = samples.findIndex((sample) => sample.t === times[index]);
      if (nextIndex - previousIndex > 1 && times[index] - times[index - 1] <= 2000) {
        showHideShow++;
        break;
      }
    }
  }

  const churnPctPerSec = exposure > 0
    ? replacements / exposure * 100
    : 0;
  return {
    churnPctPerSec,
    showHideShow,
    replacements,
    exposure,
    transitions: Math.max(0, samples.length - 1),
    minimumPopulation: samples.length
      ? Math.min(...samples.map((sample) => sample.labeledKeys.length))
      : 0,
    maximumPopulation: samples.length
      ? Math.max(...samples.map((sample) => sample.labeledKeys.length))
      : 0,
  };
}

async function waitForConclusiveSamples(page, {
  minimumElapsedMs,
  minimumSolves = 0,
  minimumSolveSpanMs = 0,
  minimumNormalFrames = 0,
}) {
  const deadline = Date.now() + SAMPLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const qa = window.__LABEL_QA;
      const solves = qa?.solve || [];
      const matchingFrames = (qa?.frames || []).filter(
        (sample) => sample.observationCount === 5200,
      );
      return {
        elapsedMs: performance.now() - (qa?.startedAt || performance.now()),
        solveCount: solves.length,
        solveSpanMs: solves.length > 1 ? solves.at(-1).t - solves[0].t : 0,
        normalFrameCount: matchingFrames.length,
      };
    });
    if (state.elapsedMs >= minimumElapsedMs
        && state.solveCount >= minimumSolves
        && state.solveSpanMs >= minimumSolveSpanMs
        && state.normalFrameCount >= minimumNormalFrames) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function waitForSettledSyntheticField(page) {
  await page.waitForFunction(
    ({ observationCount, settledSolveCount, minHeight, maxHeight }) => {
      const solves = window.__LABEL_QA?.solve || [];
      if (solves.length < settledSolveCount) return false;
      return solves.slice(-settledSolveCount).every((sample) => (
        sample.observationCount === observationCount
        && sample.labeledKeys.length > 0
        && sample.selectedCount === sample.labeledKeys.length
        && sample.cameraHeight >= minHeight
        && sample.cameraHeight <= maxHeight
      ));
    },
    { timeout: SAMPLE_TIMEOUT_MS, polling: 100 },
    {
      observationCount: OBSERVATION_COUNT,
      settledSolveCount: SETTLED_SOLVE_COUNT,
      minHeight: GLOBAL_CAMERA_MIN_HEIGHT_M,
      maxHeight: GLOBAL_CAMERA_MAX_HEIGHT_M,
    },
  );
}

async function main() {
  console.log('\nDetection Label QA');
  console.log(`  App URL      : ${APP_URL}`);
  console.log(`  Observations : ${OBSERVATION_COUNT}`);
  console.log(`  Sample window: >=${SYNTHETIC_SAMPLE_MS / 1000}s synthetic + >=${NORMAL_SAMPLE_MS / 1000}s normal\n`);

  try {
    const response = await fetch(APP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`Dev server not reachable at ${APP_URL}: ${error.message}`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const executablePath = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
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
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const sourceUrl = message.location()?.url || '';
      if (!/Failed to load resource.*404/i.test(text)) {
        consoleErrors.push(sourceUrl ? `${text} [${sourceUrl}]` : text);
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    await page.evaluateOnNewDocument((storageKey, appOrigin) => {
      localStorage.setItem(storageKey, 'WEIGHTED');
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' || input instanceof URL
          ? String(input)
          : input?.url;
        const url = new URL(requestUrl, window.location.href);
        if (url.origin === appOrigin && url.pathname === '/api/openai/hud-summary') {
          return Promise.resolve(new Response(JSON.stringify({ summary: 'QA globe ready' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return realFetch(input, init);
      };
    }, STORAGE_KEY, APP_ORIGIN);

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.styleManager,
      { timeout: 60000, polling: 100 },
    );

    // flyToAustin schedules its 600 m arrival 500 ms after initialization.
    // Let that callback start, then cancel it before establishing the global
    // measurement camera so startup motion cannot invalidate the sample.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.evaluate(() => window.__godsEyeView.viewer.camera.cancelFlight());

    const stateChecks = await page.evaluate((storageKey) => {
      const manager = window.__godsEyeView.styleManager;
      const restored = manager.getDetectionState();
      manager._syncDetectionUiFromEngine();
      const storedAfterPassiveSync = localStorage.getItem(storageKey);
      const off = manager.setDetection({ enabled: false, densityPct: 25 });
      const restoredFromOff = manager.setDetection({ enabled: true });
      return { restored, storedAfterPassiveSync, off, restoredFromOff };
    }, STORAGE_KEY);

    record(
      'allocation preference survives passive UI sync',
      stateChecks.storedAfterPassiveSync === 'WEIGHTED',
      `share/engine=${stateChecks.restored.allocationStrategy}, stored=${stateChecks.storedAfterPassiveSync}`,
    );
    record(
      'density update while OFF restores the matching profile',
      stateChecks.off.detectionMode === 'OFF'
        && stateChecks.off.densityPct === 25
        && stateChecks.restoredFromOff.detectionMode === 'SPARSE'
        && stateChecks.restoredFromOff.densityPct === 25,
      `OFF=${stateChecks.off.densityPct}%, restore=${stateChecks.restoredFromOff.detectionMode}/${stateChecks.restoredFromOff.densityPct}%`,
    );

    const injected = await page.evaluate(({ fieldCounts, normalCounts }) => {
      const { viewer, dataManager, styleManager } = window.__godsEyeView;
      viewer.camera.cancelFlight();
      const Cartesian3 = viewer.camera.position.constructor;
      const field = { flights: [], military: [], satellites: [] };
      const layerIds = Object.keys(field);
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));

      for (const layerId of layerIds) {
        const count = fieldCounts[layerId];
        for (let localIndex = 0; localIndex < count; localIndex++) {
          const radius = 57 * Math.sqrt((localIndex + 0.5) / count);
          const angle = localIndex * goldenAngle + layerIds.indexOf(layerId) * 0.7;
          const lat = Math.max(-65, Math.min(75, 30 + radius * Math.sin(angle)));
          const lon = -97 + radius * Math.cos(angle) / Math.max(0.4, Math.cos(lat * Math.PI / 180));
          const sourceId = `${layerId.slice(0, 1)}-${String(localIndex).padStart(4, '0')}`;
          field[layerId].push({
            sourceId,
            id: sourceId.toUpperCase(),
            metric: layerId === 'satellites' ? 'LEO' : `${250 + (localIndex % 450)}KT`,
            position: Cartesian3.fromDegrees(lon, lat, layerId === 'satellites' ? 550000 : 9000),
            type: layerId === 'satellites' ? 'SAT' : 'AIR',
            tier: layerId === 'military' ? 'military' : (layerId === 'satellites' ? 'space' : 'civil'),
          });
        }
      }

      window.__LABEL_QA_FIELD = field;
      window.__LABEL_QA_NORMAL_COUNTS = normalCounts;
      for (const layerId of layerIds) {
        const entry = dataManager.layers.get(layerId);
        entry.module.getDetectableObjects = () => window.__LABEL_QA_FIELD[layerId];
      }

      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(-97, 30, 25000000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      styleManager.setDetection({
        enabled: true,
        densityPct: 100,
        allocationStrategy: 'elastic',
      });

      window.__LABEL_QA = {
        solve: [],
        frames: [],
        lastRevision: -1,
        lastFrameNumber: -1,
        startedAt: performance.now(),
      };
      let lastOrbitAt = performance.now();
      window.__LABEL_QA_ORBIT = setInterval(() => {
        const now = performance.now();
        viewer.camera.rotateRight((now - lastOrbitAt) * 0.0000012);
        lastOrbitAt = now;
        viewer.scene.requestRender();
      }, 100);
      const sample = () => {
        const diagnostics = styleManager.getDetectionDiagnostics();
        const frameNumber = viewer.scene.frameState?.frameNumber ?? -1;
        if (diagnostics && frameNumber !== window.__LABEL_QA.lastFrameNumber) {
          window.__LABEL_QA.lastFrameNumber = frameNumber;
          window.__LABEL_QA.frames.push({
            didSolve: diagnostics.didSolve,
            placementBuildCount: diagnostics.placementBuildCount,
            selectedCount: diagnostics.selectedCount,
            fadingCount: diagnostics.fadingCount,
            cohortCount: diagnostics.cohortCount,
            observationCount: diagnostics.observationCount,
            frameTotalMs: diagnostics.frameTotalMs,
            paintMs: diagnostics.paintMs,
            throttleSkipCount: diagnostics.throttleSkipCount,
          });
        }
        const dataset = document.querySelector('#world-overlay-canvas')?.dataset;
        const revision = Number(dataset?.solveRevision || 0);
        if (dataset && revision > 0 && revision !== window.__LABEL_QA.lastRevision) {
          window.__LABEL_QA.lastRevision = revision;
          window.__LABEL_QA.solve.push({
            t: performance.now(),
            revision,
            solveMs: Number(dataset.solveMs),
            frameTotalMs: Number(dataset.frameTotalMs),
            paintMs: Number(dataset.paintMs),
            throttleSkipCount: Number(dataset.throttleSkipCount),
            placementBuildCount: Number(dataset.placementBuildCount),
            observationCount: Number(dataset.observationCount),
            selectedCount: Number(dataset.selectedCount),
            fadingCount: Number(dataset.fadingCount),
            cameraHeight: viewer.camera.positionCartographic.height,
            demandByLayer: JSON.parse(dataset.demandByLayer || '{}'),
            cohortByLayer: JSON.parse(dataset.cohortByLayer || '{}'),
            entitlementByLayer: JSON.parse(dataset.entitlementByLayer || '{}'),
            labeledKeys: JSON.parse(dataset.labeledKeys || '[]'),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return Object.fromEntries(layerIds.map((layerId) => [layerId, field[layerId].length]));
    }, { fieldCounts: FIELD_COUNTS, normalCounts: NORMAL_COUNTS });

    record(
      'deterministic field contains exactly 12,000 observations',
      Object.values(injected).reduce((sum, count) => sum + count, 0) === OBSERVATION_COUNT,
      JSON.stringify(injected),
    );

    // Warm-up before steady-state p95: the first solves after field
    // injection run on cold-tier code paths and skew p95 on a fresh server.
    // (perf wave 2 added a 2.5 s sleep for this; main's settle+conclusive
    // -samples gates supersede it — same fix, deterministic instead of timed.)
    await waitForSettledSyntheticField(page);
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const revision = Number(document.querySelector('#world-overlay-canvas')?.dataset?.solveRevision || 0);
      window.__LABEL_QA.solve = [];
      window.__LABEL_QA.frames = [];
      window.__LABEL_QA.lastRevision = revision;
      window.__LABEL_QA.lastFrameNumber = viewer.scene.frameState?.frameNumber ?? -1;
      window.__LABEL_QA.startedAt = performance.now();
    });
    const syntheticSampling = await waitForConclusiveSamples(page, {
      minimumElapsedMs: SYNTHETIC_SAMPLE_MS,
      minimumSolves: MIN_SYNTHETIC_SOLVES,
      minimumSolveSpanMs: MIN_SYNTHETIC_SPAN_MS,
    });

    await page.screenshot({
      path: path.join(SHOT_DIR, 'deterministic-12000.png'),
      fullPage: false,
    });

    const syntheticSamples = await page.evaluate(() => {
      const completed = window.__LABEL_QA;
      const counts = window.__LABEL_QA_NORMAL_COUNTS;
      for (const layerId of Object.keys(window.__LABEL_QA_FIELD)) {
        window.__LABEL_QA_FIELD[layerId] = window.__LABEL_QA_FIELD[layerId].slice(0, counts[layerId]);
      }
      window.__LABEL_QA = {
        solve: [],
        frames: [],
        lastRevision: -1,
        lastFrameNumber: -1,
        startedAt: performance.now(),
      };
      return completed;
    });

    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.getDetectionDiagnostics()?.observationCount === 5200,
      { timeout: SAMPLE_TIMEOUT_MS, polling: 100 },
    );
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const revision = Number(document.querySelector('#world-overlay-canvas')?.dataset?.solveRevision || 0);
      window.__LABEL_QA.solve = [];
      window.__LABEL_QA.frames = [];
      window.__LABEL_QA.lastRevision = revision;
      window.__LABEL_QA.lastFrameNumber = viewer.scene.frameState?.frameNumber ?? -1;
      window.__LABEL_QA.startedAt = performance.now();
    });
    const normalSampling = await waitForConclusiveSamples(page, {
      minimumElapsedMs: NORMAL_SAMPLE_MS,
      minimumNormalFrames: MIN_NORMAL_FRAMES,
    });
    const normalSamples = await page.evaluate(() => {
      clearInterval(window.__LABEL_QA_ORBIT);
      return window.__LABEL_QA;
    });

    await page.screenshot({
      path: path.join(SHOT_DIR, 'normal-global-5200.png'),
      fullPage: false,
    });

    const solveSamples = syntheticSamples.solve;
    const steadySolveSamples = solveSamples.filter((sample) => (
      sample.observationCount === OBSERVATION_COUNT
      && sample.labeledKeys.length > 0
      && sample.selectedCount === sample.labeledKeys.length
      && sample.cameraHeight >= GLOBAL_CAMERA_MIN_HEIGHT_M
      && sample.cameraHeight <= GLOBAL_CAMERA_MAX_HEIGHT_M
    ));
    const normalFieldFrames = normalSamples.frames.filter(
      (sample) => sample.observationCount === 5200,
    );
    const normalFrames = normalFieldFrames.filter((sample) => !sample.didSolve);
    const solveP95 = percentile(solveSamples.map((sample) => sample.solveMs), 0.95);
    const renderP95 = percentile(normalFrames.map((sample) => sample.frameTotalMs), 0.95);
    // SwiftShader can render the complete Cesium scene below 8 FPS, making
    // every sampled overlay frame eligible for the 125 ms solve tick. Paint is
    // timed separately from solve, so it remains the deterministic frame-lane
    // measurement even when there are no non-solve frames in this backend.
    const paintP95 = percentile(
      (normalFrames.length ? normalFrames : normalFieldFrames).map((sample) => sample.paintMs),
      0.95,
    );
    const throttles = normalSamples.frames.map((sample) => sample.throttleSkipCount).filter(Number.isFinite);
    const throttleDelta = throttles.length ? Math.max(...throttles) - Math.min(...throttles) : 0;
    const normalPlacementOverflow = normalFieldFrames.filter(
      (sample) => sample.placementBuildCount > sample.selectedCount + sample.fadingCount
        + (sample.didSolve ? sample.cohortCount : 0),
    );
    const solvePlacementOverflow = solveSamples.filter((sample) => {
      const cohort = Object.values(sample.cohortByLayer).reduce((sum, count) => sum + count, 0);
      return sample.placementBuildCount > cohort + sample.selectedCount + sample.fadingCount;
    });
    const cohortOverflow = solveSamples.filter((sample) => Object.entries(sample.cohortByLayer)
      .some(([layerId, count]) => {
        const quota = sample.entitlementByLayer[layerId] || 0;
        return count > Math.min(256, Math.max(64, 4 * quota));
      }));
    const membership = analyzeMembership(solveSamples);

    record(
      'sampling is conclusive across the pathological and normal fields',
      Boolean(syntheticSampling && normalSampling)
        && solveSamples.length >= MIN_SYNTHETIC_SOLVES
        && syntheticSampling.solveSpanMs >= MIN_SYNTHETIC_SPAN_MS
        && normalFieldFrames.length >= MIN_NORMAL_FRAMES,
      `synthetic solves=${solveSamples.length}, span=${syntheticSampling?.solveSpanMs?.toFixed(0) || 0}ms; normal frames=${normalFieldFrames.length}`,
    );

    record(
      'synthetic churn samples remain non-empty at the 12,000-contact global view',
      steadySolveSamples.length === solveSamples.length,
      `steady=${steadySolveSamples.length}/${solveSamples.length}; population=${membership.minimumPopulation}-${membership.maximumPopulation}`,
    );

    record(
      'solve cohort remains bounded per layer',
      cohortOverflow.length === 0,
      `${solveSamples.length} solves checked`,
    );
    record(
      'placement construction is bounded in both lanes',
      normalPlacementOverflow.length === 0 && solvePlacementOverflow.length === 0,
      `normal overflow=${normalPlacementOverflow.length}, solve overflow=${solvePlacementOverflow.length}`,
    );
    record(
      'solve p95 is below approximately 4 ms',
      solveP95 < 4.5,
      `${solveP95.toFixed(2)} ms`,
    );
    record(
      'normal-field overlay paint p95 is at or below 10 ms',
      paintP95 <= 10,
      `paint=${paintP95.toFixed(2)} ms${Number.isFinite(renderP95) ? `, non-solve total=${renderP95.toFixed(2)} ms` : ', every sampled frame included a solve'}`,
    );
    record(
      'normal scene does not trigger adaptive throttling',
      throttleDelta === 0,
      `skip delta=${throttleDelta}`,
    );
    record(
      'label churn remains below 8% per second',
      membership.churnPctPerSec < 8,
      `${membership.churnPctPerSec.toFixed(2)}%/s; replacements=${membership.replacements}, exposure=${membership.exposure.toFixed(1)} label-s, transitions=${membership.transitions}, population=${membership.minimumPopulation}-${membership.maximumPopulation}`,
    );
    record(
      'no show-hide-show cycle occurs within two seconds',
      membership.showHideShow === 0,
      `cycles=${membership.showHideShow}`,
    );
    record(
      'console remains clean',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ') || '0 errors',
    );
    record(
      'no HTTP 5xx responses occur',
      failedResponses.length === 0,
      failedResponses.slice(0, 3).join(' | ') || '0 responses',
    );

    console.log(`\n  Screenshot: ${path.join(SHOT_DIR, 'deterministic-12000.png')}`);
    console.log(`  Screenshot: ${path.join(SHOT_DIR, 'normal-global-5200.png')}`);
    console.log(`  Synthetic solves: ${solveSamples.length}; normal frames: ${normalFieldFrames.length} (${normalFrames.length} non-solve)`);
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
