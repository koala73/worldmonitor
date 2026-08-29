#!/usr/bin/env node
/**
 * qa-sprites-b5.mjs — throwaway QA harness for skylight Tasks 8+9
 * (type-aware billboard silhouettes + per-class 2D/3D scale; Batch 5).
 *
 * Injects synthetic STRAIGHT-FLYING aircraft covering ALL 8 classifyAircraft
 * classes — the flights layer via OpenSky extended categories (state[17]),
 * the military layer via adsb.lol type codes — using the same fetch-shim +
 * history-priming pattern as scripts/qa-heading-b3.mjs (positions analytic at
 * serve time so every fix is self-consistent through the render delay).
 *
 * Machine assertions:
 *   B1 ingest     : both layers ingest the synthetic planes
 *   B2 billboards : every fleet billboard carries EXACTLY the expected
 *                   per-class glyph (image data-URI === aircraftIcon(klass),
 *                   imported from src) and per-class scale (flights:
 *                   CLASS_SCALE_2D; military: 0.7 × CLASS_SCALE_2D)
 *   B3 models     : with 3D on, fleet Cesium.Model.scale === the layer's
 *                   MODEL_SCALE (both 1; legacy scale is baked into the GLB)
 *                   × CLASS_SCALE_3D[klass] per icao; tracked too
 *   B4 clean      : no console errors
 *
 * Visual output (qa-shots/b5/, untracked): top-down 2D spreads of both rows,
 * per-row close-ups, a tracked-cyan tint shot, and 3D cluster shots at two
 * zooms per layer showing per-class model scale differences. The PNGs are the
 * acceptance test — read them.
 *
 * Run:  node scripts/qa-sprites-b5.mjs --url http://localhost:4300
 * Exits non-zero if any assertion fails. Never commits anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { classifyAircraft, CLASS_SCALE_2D, CLASS_SCALE_3D, CLASS_MODEL_REAL } from '../src/data/aircraftClass.js';
// Hangar fleet (2026-08-16): real per-class GLBs render at scale 1; military
// heavies (airliner/quadjet/glider) render airplane.glb at 1 x class; only
// fastjet/unknown keep the per-layer jet/airplane MODEL_SCALE formula.
const flightsWantScale = (klass) => (CLASS_MODEL_REAL[klass] ? 1 : FL_MODEL_SCALE * CLASS_SCALE_3D[klass]);
const MIL_PLANE_CLASSES = new Set(['airliner', 'quadjet', 'glider']);
const militaryWantScale = (klass) => (CLASS_MODEL_REAL[klass] ? 1
  : MIL_PLANE_CLASSES.has(klass) ? MIL_PLANE_MODEL_SCALE * CLASS_SCALE_3D[klass]
    : MIL_MODEL_SCALE * CLASS_SCALE_3D[klass]);
import { aircraftIcon } from '../src/data/aircraftIcons.js';

// ---------------------------------------------------------------------------
// Args (same shape as qa-heading-b3.mjs)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = getFlag('--headful');
const SHOT_DIR = path.resolve('qa-shots/b5');

const FL_MODEL_SCALE = 1;         // flights.js (airplane.glb is transform-applied and meter-scale)
const MIL_PLANE_MODEL_SCALE = 1;  // military heavy classes share the same baked airplane.glb
const MIL_MODEL_SCALE = 1;        // militaryFlights.js (jet.glb is already real-world scale, native radius ~29.8 m)
const MIL_BILLBOARD_SCALE = 0.7;  // militaryFlights BILLBOARD_SCALE

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

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Synthetic straight-flying aircraft.
// Rows (2D spread): flights row at lat 30.32 (6 category-driven classes),
// military row at lat 30.28 (all 8 classes via type codes). Clusters (3D
// scale comparison): tight 130–150 m spacing so the follow-camera frames
// several models at once below the minimumPixelSize clamp distance.
// courseDeg 0 = flying north (glyph nose-up in a north-up top-down view);
// two planes fly rotated courses to confirm sprites still follow the path.
// ---------------------------------------------------------------------------
const ROW_LON0 = -97.82;
const ROW_STEP_DEG = 0.012; // ~1.15 km — full military row (8 planes) fits the unobstructed frame center
const CLUSTER_LON0 = -97.7431;
const mDegLon = (m, lat) => m / (111320 * Math.cos((lat * Math.PI) / 180));

const SPRITES = {
  timeOffsetSec: 0,
  // OpenSky extended categories: 2 light, 4 large airliner, 6 heavy/widebody,
  // 7 high-perf fastjet, 8 rotorcraft, 9 glider. (quadjet/turboprop need type
  // codes, which OpenSky lacks — the military row covers those.)
  flights: [
    { icao: 'caa001', callsign: 'FL-LGT', lon0: ROW_LON0 + 0 * ROW_STEP_DEG, lat0: 30.32, courseDeg: 0, speedMps: 80, altM: 2500, category: 2 },
    { icao: 'caa002', callsign: 'FL-AIR', lon0: ROW_LON0 + 1 * ROW_STEP_DEG, lat0: 30.32, courseDeg: 0, speedMps: 80, altM: 2600, category: 4 },
    { icao: 'caa003', callsign: 'FL-WID', lon0: ROW_LON0 + 2 * ROW_STEP_DEG, lat0: 30.32, courseDeg: 0, speedMps: 80, altM: 2700, category: 6 },
    { icao: 'caa004', callsign: 'FL-FJ',  lon0: ROW_LON0 + 3 * ROW_STEP_DEG, lat0: 30.32, courseDeg: 90, speedMps: 80, altM: 2800, category: 7 },
    { icao: 'caa005', callsign: 'FL-HEL', lon0: ROW_LON0 + 4 * ROW_STEP_DEG, lat0: 30.32, courseDeg: 0, speedMps: 40, altM: 1200, category: 8 },
    { icao: 'caa006', callsign: 'FL-GLD', lon0: ROW_LON0 + 5 * ROW_STEP_DEG, lat0: 30.32, courseDeg: 0, speedMps: 40, altM: 2000, category: 9 },
    // 3D cluster (150 m spacing): widebody vs airliner (tracked) vs fastjet
    { icao: 'cbb001', callsign: '3D-WID', lon0: CLUSTER_LON0 - mDegLon(150, 30.10), lat0: 30.10, courseDeg: 0, speedMps: 60, altM: 3000, category: 6 },
    { icao: 'cbb002', callsign: '3D-AIR', lon0: CLUSTER_LON0, lat0: 30.10, courseDeg: 0, speedMps: 60, altM: 3000, category: 4 },
    { icao: 'cbb003', callsign: '3D-FJ',  lon0: CLUSTER_LON0 + mDegLon(150, 30.10), lat0: 30.10, courseDeg: 0, speedMps: 60, altM: 3000, category: 7 },
  ],
  military: [
    { hex: 'dda001', flight: 'ML-LGT',  t: 'C172', lon0: ROW_LON0 + 0 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 60, altFt: 9000 },
    { hex: 'dda002', flight: 'ML-GLD',  t: 'DISC', lon0: ROW_LON0 + 1 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 40, altFt: 8000 },
    { hex: 'dda003', flight: 'ML-TPR',  t: 'C130', lon0: ROW_LON0 + 2 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 80, altFt: 10000 },
    { hex: 'dda004', flight: 'ML-AIR',  t: 'A320', lon0: ROW_LON0 + 3 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 80, altFt: 11000 },
    { hex: 'dda005', flight: 'ML-WID',  t: 'C17',  lon0: ROW_LON0 + 4 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 80, altFt: 12000 },
    { hex: 'dda006', flight: 'ML-QUAD', t: 'B744', lon0: ROW_LON0 + 5 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 80, altFt: 13000 },
    { hex: 'dda007', flight: 'ML-HEL',  t: 'H60',  lon0: ROW_LON0 + 6 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 40, altFt: 3000 },
    // course 0 like the rest — keeps the row a clean size-comparison line (2D
    // rotation is demoed by caa004 and gated by qa-heading-b3 anyway).
    { hex: 'dda008', flight: 'ML-FJ',   t: 'F16',  lon0: ROW_LON0 + 7 * ROW_STEP_DEG, lat0: 30.28, courseDeg: 0, speedMps: 80, altFt: 15000 },
    // 3D cluster: C17 vs F16 (tracked) vs B744 vs C130. jet.glb is a
    // real-world-scale asset (native bounding radius ~29.8) rendered at
    // MODEL_SCALE 1, so models are ~22–43 m radius — same 150 m spacing and
    // 450–900 m shot ranges as the flights cluster.
    { hex: 'ddb001', flight: '3DMWID', t: 'C17',  lon0: CLUSTER_LON0 - mDegLon(150, 30.05), lat0: 30.05, courseDeg: 0, speedMps: 60, altFt: 12000 },
    { hex: 'ddb002', flight: '3DMFJ',  t: 'F16',  lon0: CLUSTER_LON0, lat0: 30.05, courseDeg: 0, speedMps: 60, altFt: 12000 },
    { hex: 'ddb003', flight: '3DMQUA', t: 'B744', lon0: CLUSTER_LON0 + mDegLon(150, 30.05), lat0: 30.05, courseDeg: 0, speedMps: 60, altFt: 12000 },
    { hex: 'ddb004', flight: '3DMTPR', t: 'C130', lon0: CLUSTER_LON0 - mDegLon(300, 30.05), lat0: 30.05, courseDeg: 0, speedMps: 60, altFt: 12000 },
  ],
};

// Node-side expected classification (same inputs the layers see).
const expectedFlights = new Map(SPRITES.flights.map((p) => [p.icao, classifyAircraft({ category: p.category })]));
const expectedMilitary = new Map(SPRITES.military.map((p) => [p.hex, classifyAircraft({ typeCode: p.t })]));

// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nType-aware sprite QA (Batch 5 / skylight Tasks 8+9)`);
  console.log(`  App URL : ${APP_URL}\n`);
  console.log(`  Expected classes — flights: ${[...expectedFlights.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`  Expected classes — military: ${[...expectedMilitary.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}\n`);

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const chromeExecutable = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
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
  const httpErrors = [];
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
      if (response.status() >= 500) httpErrors.push(`${response.status()} ${response.url()}`);
    });

    // ---- Straight-flight fetch shim (installed before any app code runs) ----
    await page.evaluateOnNewDocument((spec) => {
      window.__SPR = spec;
      window.__SPR.epochMs = Date.now();
      window.__SPR_HITS = { opensky: 0, mil: 0 };

      // Straight line from (lon0, lat0) along courseDeg at speedMps.
      window.__SPR.stateAt = (p, tSec) => {
        const cRad = (p.courseDeg * Math.PI) / 180;
        const dist = p.speedMps * tSec;
        const east = dist * Math.sin(cRad);
        const north = dist * Math.cos(cRad);
        const lat = p.lat0 + north / 111320;
        const lon = p.lon0 + east / (111320 * Math.cos((p.lat0 * Math.PI) / 180));
        return { lon, lat, course: p.courseDeg, speedMps: p.speedMps };
      };

      const realFetch = window.fetch.bind(window);
      const jsonResponse = (obj) => new Response(JSON.stringify(obj), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });

      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const S = window.__SPR;
        if (url.includes('/api/openai/hud-summary')) {
          return Promise.resolve(jsonResponse({ summary: 'Aircraft scale QA' }));
        }
        const nowSec = Date.now() / 1000 + (S.timeOffsetSec || 0);
        const tRel = nowSec - S.epochMs / 1000;

        if (url.includes('/api/opensky-track')) return Promise.resolve(jsonResponse({ path: [] }));
        if (url.includes('/api/adsblol/trace')) {
          return Promise.resolve(jsonResponse({ timestamp: Math.floor(nowSec), trace: [] }));
        }
        if (url.includes('/api/opensky')) {
          window.__SPR_HITS.opensky++;
          const states = S.flights.map((f) => {
            const s = S.stateAt(f, tRel);
            return [
              f.icao, f.callsign, 'Synthetica',
              Math.floor(nowSec), Math.floor(nowSec),
              s.lon, s.lat, f.altM,
              false,                    // on_ground
              s.speedMps, s.course,
              0, null, null, null, false, 0,
              f.category,               // state[17] — extended emitter category
            ];
          });
          return Promise.resolve(jsonResponse({ time: Math.floor(nowSec), states }));
        }
        if (url.includes('/api/adsblol/mil')) {
          window.__SPR_HITS.mil++;
          const ac = S.military.map((m) => {
            const s = S.stateAt(m, tRel);
            return {
              hex: m.hex, flight: m.flight,
              lon: s.lon, lat: s.lat, alt_baro: m.altFt,
              track: s.course, gs: s.speedMps * 1.9438,
              t: m.t, r: `SY-${m.hex.slice(-3)}`, ownOp: 'SYNTH AF',
              seen_pos: Math.max(0, -(S.timeOffsetSec || 0)),
            };
          });
          return Promise.resolve(jsonResponse({ msg: 'No error', now: Date.now(), ac }));
        }
        // Synthetic categories/types already exercise every classification
        // branch. ADSBDB enrichment is incidental to this visual-scale check,
        // so keep an unavailable public enrichment provider from generating an
        // unrelated console error.
        if (url.includes('/api/adsbdb/')) return Promise.resolve(jsonResponse({ found: false }));
        return realFetch(input, init);
      };
    }, SPRITES);

    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 60000, polling: 200 }
    );
    console.log('  App globals ready.');

    // ---- In-page probes: billboard walk, model walk, tracked-model finder ---
    await page.evaluate(() => {
      // Every billboard (image + alignedAxis + id) in every collection.
      window.__collectBillboards = function () {
        const v = window.__godsEyeView.viewer;
        const out = [];
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p;
            try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.image !== undefined && p.alignedAxis !== undefined) {
              out.push({ id: p.id, image: p.image, scale: p.scale, show: p.show });
            }
          }
        };
        walk(v.scene.primitives);
        return out;
      };
      // Every glTF model primitive (modelMatrix + ready flag), with id + scale.
      window.__collectModels = function () {
        const v = window.__godsEyeView.viewer;
        const out = [];
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p;
            try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.modelMatrix && typeof p.ready !== 'undefined' && p.image === undefined) {
              let radius = null;
              try { radius = p.ready && p.boundingSphere ? p.boundingSphere.radius : null; } catch { /* not ready */ }
              out.push({ id: p.id, scale: p.scale, ready: p.ready, show: p.show, radius });
            }
          }
        };
        walk(v.scene.primitives);
        return out;
      };
      // Displayed (render-delayed) latitude of a synthetic plane right now.
      window.__displayedState = function (layer, idx, renderDelaySec) {
        const S = window.__SPR;
        const p = S[layer][idx];
        const tRel = (Date.now() - S.epochMs) / 1000 - renderDelaySec;
        return S.stateAt(p, tRel);
      };
      // Canvas coordinates of every synthetic plane at its displayed position —
      // ground truth for identifying which glyph is which in a screenshot.
      window.__planeCanvasCoords = function (layer, renderDelaySec, altOf) {
        const v = window.__godsEyeView.viewer;
        const S = window.__SPR;
        const C3 = v.camera.position.constructor;
        return S[layer].map((p, i) => {
          const s = window.__displayedState(layer, i, renderDelaySec);
          const pos = C3.fromDegrees(s.lon, s.lat, altOf === 'ft' ? p.altFt * 0.3048 : p.altM);
          const c = v.scene.cartesianToCanvasCoordinates(pos);
          return `${p.icao || p.hex}=(${c ? Math.round(c.x) : '-'},${c ? Math.round(c.y) : '-'})`;
        }).join(' ');
      };
    });

    // ---- Prime history through the render delay (same pattern as b3) -------
    console.log('Priming straight-flight history through the render delay (30 s / 15 s)...');
    const primed = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const v = window.__godsEyeView.viewer;
      window.__SPR.timeOffsetSec = -32;
      await dm.setEnabled('flights', true);
      await dm.setEnabled('military', true);
      const fl = dm.layers.get('flights').module;
      const mil = dm.layers.get('military').module;
      for (const off of [-24, -16, -8, 0]) {
        window.__SPR.timeOffsetSec = off;
        await fl.update(v);
        await mil.update(v);
      }
      window.__SPR.timeOffsetSec = 0;
      window.__SPR_DRIVER = setInterval(() => { fl.update(v); mil.update(v); }, 15000);
      return { fl: fl.getStats().count, mil: mil.getStats().count, hits: window.__SPR_HITS };
    });
    console.log(`  flights count=${primed.fl} military count=${primed.mil} | shim hits opensky=${primed.hits.opensky} mil=${primed.hits.mil}`);
    record('B1 ingest: synthetic planes in both layers',
      primed.fl === SPRITES.flights.length && primed.mil === SPRITES.military.length,
      `flights=${primed.fl}/${SPRITES.flights.length} military=${primed.mil}/${SPRITES.military.length}`);
    if (!(primed.fl > 0 && primed.mil > 0)) { finish(); return; }

    // ========================================================================
    // B2 — billboard glyph + scale per class (machine check)
    // ========================================================================
    console.log('\nB2 — per-class billboard glyph + scale');
    const bbs = await page.evaluate(() => window.__collectBillboards());
    const bbById = new Map(bbs.map((b) => [b.id, b]));
    let glyphBad = [];
    let scaleBad = [];
    for (const [id, klass] of expectedFlights) {
      const bb = bbById.get(id);
      const wantImg = aircraftIcon(klass);
      const wantScale = CLASS_SCALE_2D[klass] || 1;
      if (!bb || bb.image !== wantImg) glyphBad.push(`${id}(${klass})${bb ? ':wrong-image' : ':missing'}`);
      if (bb && Math.abs(bb.scale - wantScale) > 1e-9) scaleBad.push(`${id}: ${bb.scale} != ${wantScale}`);
    }
    for (const [id, klass] of expectedMilitary) {
      const bb = bbById.get(id);
      const wantImg = aircraftIcon(klass);
      const wantScale = MIL_BILLBOARD_SCALE * (CLASS_SCALE_2D[klass] || 1);
      if (!bb || bb.image !== wantImg) glyphBad.push(`${id}(${klass})${bb ? ':wrong-image' : ':missing'}`);
      if (bb && Math.abs(bb.scale - wantScale) > 1e-9) scaleBad.push(`${id}: ${bb.scale} != ${wantScale}`);
    }
    record('B2a: every synthetic billboard has its class glyph (data-URI match)',
      glyphBad.length === 0, glyphBad.length ? glyphBad.join(' ') : `${expectedFlights.size + expectedMilitary.size} billboards matched`);
    record('B2b: every synthetic billboard has its class scale',
      scaleBad.length === 0, scaleBad.length ? scaleBad.join(' ') : 'all scales exact');
    const distinctGlyphs = new Set([...expectedFlights.values(), ...expectedMilitary.values()].map((k) => aircraftIcon(k)));
    record('B2c: all 8 classes exercised with 8 distinct glyphs',
      distinctGlyphs.size === 8, `${distinctGlyphs.size} distinct data URIs`);

    // ========================================================================
    // 2D screenshots
    // ========================================================================
    console.log('\n2D screenshots → qa-shots/b5/');
    const topDown = async (lat, lon, height) => {
      await page.evaluate(({ lat, lon, height }) => {
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight(); // the boot fly-to-Austin otherwise stomps setView
        const C3 = v.camera.position.constructor;
        v.camera.setView({
          destination: C3.fromDegrees(lon, lat, height),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
      }, { lat, lon, height });
      await sleep(1800); // let fleet tick land positions + rotations at the new pose
    };
    // Zoom the follow-camera to an absolute range from the tracked entity.
    // In tracked mode camera.position lives in the ENTITY's reference frame, so
    // its magnitude IS the range — fixed zoomIn() amounts compound across phases
    // (the second tracked plane inherits the previous phase's close-in offset).
    const zoomToRange = async (want) => {
      await page.evaluate((want) => {
        const v = window.__godsEyeView.viewer;
        const p = v.camera.position;
        const d = Math.hypot(p.x, p.y, p.z);
        if (d > 1e6) return; // not in a tracked reference frame — leave it alone
        v.camera.zoomIn(d - want);
      }, want);
      await sleep(1500);
    };
    // Rows drift north while flying; recenter on the DISPLAYED (render-delayed) row.
    const rowLat = async (layer, idx, delay) =>
      (await page.evaluate(({ layer, idx, delay }) => window.__displayedState(layer, idx, delay), { layer, idx, delay })).lat;

    const flRowLat = await rowLat('flights', 2, 30);
    const milRowLat = await rowLat('military', 4, 15);
    await topDown((flRowLat + milRowLat) / 2, ROW_LON0 + 3 * ROW_STEP_DEG, 16000);
    await page.screenshot({ path: path.join(SHOT_DIR, 'b5-2d-spread-bothrows.png') });
    console.log('  saved b5-2d-spread-bothrows.png (flights row top, military row bottom)');

    // Row widths: military spans 7 steps (~8.1 km) → frame ~13.9 km at 12 km up;
    // flights spans 5 steps (~5.8 km, +caa004's eastward drift) → ~10.4 km at 9 km up.
    await topDown(await rowLat('military', 4, 15), ROW_LON0 + 3.5 * ROW_STEP_DEG, 17000);
    await page.screenshot({ path: path.join(SHOT_DIR, 'b5-2d-military-row.png') });
    console.log('  saved b5-2d-military-row.png (8 classes, amber)');
    console.log(`    glyph positions: ${await page.evaluate(() => window.__planeCanvasCoords('military', 15, 'ft'))}`);

    await topDown(await rowLat('flights', 2, 30), ROW_LON0 + 2.5 * ROW_STEP_DEG, 12000);
    await page.screenshot({ path: path.join(SHOT_DIR, 'b5-2d-flights-row.png') });
    console.log('  saved b5-2d-flights-row.png (6 category classes, white)');
    console.log(`    glyph positions: ${await page.evaluate(() => window.__planeCanvasCoords('flights', 30, 'm'))}`);

    // Tracked tint: commercial tracked plane goes cyan; neighbors stay white.
    await page.evaluate((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, 'caa002');
    await sleep(3000);
    await page.screenshot({ path: path.join(SHOT_DIR, 'b5-2d-tracked-cyan.png') });
    console.log('  saved b5-2d-tracked-cyan.png (tracked airliner cyan, follow camera)');

    // ========================================================================
    // B3 + 3D screenshots — flights cluster
    // ========================================================================
    console.log('\n3D — flights cluster (airplane.glb, per-class scale)');
    await page.evaluate(() => {
      const dm = window.__godsEyeView.dataManager;
      dm.layers.get('flights').module.setParams({ models3d: true });
      dm.layers.get('flights').module.trackById('cbb002');
    });
    const flModelsUp = await page.waitForFunction(() => {
      const models = window.__collectModels().filter((m) => m.ready && m.show);
      const ids = new Set(models.map((m) => m.id));
      return ids.has('cbb001') && ids.has('cbb002') && ids.has('cbb003');
    }, { timeout: 40000, polling: 400 }).then(() => true).catch(() => false);
    record('3D flights: tracked model + 2 fleet cluster models rendered', flModelsUp, flModelsUp ? 'all up' : 'timed out');

    if (flModelsUp) {
      const flModels = await page.evaluate(() => window.__collectModels().filter((m) => m.ready));
      const modelScaleBad = [];
      for (const [id, want] of [
        ['cbb001', flightsWantScale(expectedFlights.get('cbb001'))],
        ['cbb003', flightsWantScale(expectedFlights.get('cbb003'))],
      ]) {
        const m = flModels.find((x) => x.id === id);
        if (!m || Math.abs(m.scale - want) > 1e-9) modelScaleBad.push(`${id}: ${m ? m.scale : 'missing'} != ${want}`);
      }
      const trackedM = flModels.find((x) => x.id === 'cbb002');
      const trackedWant = flightsWantScale(expectedFlights.get('cbb002'));
      if (!trackedM || Math.abs(trackedM.scale - trackedWant) > 1e-9) {
        modelScaleBad.push(`tracked: ${trackedM ? trackedM.scale : 'missing'} != ${trackedWant}`);
      }
      record('B3a flights: model scales match the per-class registry (all GLBs meter-scale; shared @1×class)',
        modelScaleBad.length === 0,
        modelScaleBad.length ? modelScaleBad.join(' ') : 'all exact per registry');
      console.log(`  world bounding radii (m): ${flModels.filter((m) => m.scale !== undefined).map((m) => `${m.id ?? 'tracked'}=${m.radius?.toFixed(1)}`).join(' ')}`);

      await sleep(1500);
      await zoomToRange(900);
      await page.screenshot({ path: path.join(SHOT_DIR, 'b5-3d-flights-mid.png') });
      console.log('  saved b5-3d-flights-mid.png (900 m range — near the min-pixel clamp)');
      await zoomToRange(450);
      await page.screenshot({ path: path.join(SHOT_DIR, 'b5-3d-flights-close.png') });
      console.log('  saved b5-3d-flights-close.png (450 m range: widebody left, airliner center, fastjet right)');
    }

    // ========================================================================
    // B3 + 3D screenshots — military cluster
    // ========================================================================
    console.log('\n3D — military cluster (jet.glb, per-class scale)');
    await page.evaluate(() => {
      const dm = window.__godsEyeView.dataManager;
      dm.layers.get('military').module.setParams({ models3d: true });
      dm.layers.get('military').module.trackById('ddb002');
    });
    const milModelsUp = await page.waitForFunction(() => {
      const models = window.__collectModels().filter((m) => m.ready && m.show);
      const ids = new Set(models.map((m) => m.id));
      return ids.has('ddb001') && ids.has('ddb002') && ids.has('ddb003') && ids.has('ddb004');
    }, { timeout: 40000, polling: 400 }).then(() => true).catch(() => false);
    record('3D military: tracked model + 3 fleet cluster models rendered', milModelsUp, milModelsUp ? 'all up' : 'timed out');

    if (milModelsUp) {
      const milModels = await page.evaluate(() => window.__collectModels().filter((m) => m.ready));
      const modelScaleBad = [];
      for (const [id, want] of [
        ['ddb001', militaryWantScale(expectedMilitary.get('ddb001'))],
        ['ddb003', militaryWantScale(expectedMilitary.get('ddb003'))],
        ['ddb004', militaryWantScale(expectedMilitary.get('ddb004'))],
      ]) {
        const m = milModels.find((x) => x.id === id);
        if (!m || Math.abs(m.scale - want) > 1e-9) modelScaleBad.push(`${id}: ${m ? m.scale : 'missing'} != ${want}`);
      }
      const trackedM = milModels.find((x) => x.id === 'ddb002');
      const trackedWant = militaryWantScale(expectedMilitary.get('ddb002'));
      if (!trackedM || Math.abs(trackedM.scale - trackedWant) > 1e-9) {
        modelScaleBad.push(`tracked: ${trackedM ? trackedM.scale : 'missing'} != ${trackedWant}`);
      }
      record('B3b military: model scales match the weight-class registry (real/heavy/jet assets @1×class)',
        modelScaleBad.length === 0,
        modelScaleBad.length ? modelScaleBad.join(' ') : 'all exact per registry');
      console.log(`  world bounding radii (m): ${milModels.filter((m) => m.scale !== undefined).map((m) => `${m.id ?? 'tracked'}=${m.radius?.toFixed(1)}`).join(' ')}`);

      await sleep(1500);
      // jet.glb at MODEL_SCALE 1 is real-world size — same shot ranges as the
      // flights cluster (close zoom no longer puts the camera inside a model).
      await zoomToRange(900);
      await page.screenshot({ path: path.join(SHOT_DIR, 'b5-3d-military-far.png') });
      console.log('  saved b5-3d-military-far.png (900 m range: C130/C17 left, F16 center, B744 right)');
      await zoomToRange(450);
      await page.screenshot({ path: path.join(SHOT_DIR, 'b5-3d-military-close.png') });
      console.log('  saved b5-3d-military-close.png (450 m range: C17 left, F16 center, B744 right)');
    }

    record('B4: no console errors during QA run', consoleErrors.length === 0,
      consoleErrors.length
        ? `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}; HTTP: ${httpErrors.slice(0, 8).join(' | ') || 'none observed'}`
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
