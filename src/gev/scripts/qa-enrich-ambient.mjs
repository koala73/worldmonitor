#!/usr/bin/env node
/**
 * qa-enrich-ambient.mjs — headless proof for AMBIENT fleet type enrichment
 * (fleet-enrichment widening of skylight Task 14).
 *
 * Field data (2026-07-02): OpenSky's live category field is 0/"no info" for
 * ~94% of planes, so ambient classification defaulted nearly the whole fleet
 * to the airliner silhouette. This harness reproduces exactly that case —
 * 12 synthetic planes, ALL category 0 — and proves that the per-poll
 * on-screen enrichment sweep (`_sweepAmbientEnrichment` in flights.js) gives
 * them real types AMBIENTLY (nothing is ever tracked, 3D stays off), while
 * honoring the politeness bounds.
 *
 * Fetch shim (installed before app code, same pattern as qa-sprites-b5.mjs):
 *   - /api/opensky           → 12 straight-flying planes, category 0
 *   - /api/adsbdb/type/:hex  → varied REAL type codes (C172, B744, DH8D, H60,
 *                              F16, GLID, B77W, A320, B738, PC12, R44) + one
 *                              found:false miss; responses are HELD until the
 *                              harness releases them (deterministic baseline),
 *                              then served with 400 ms latency; every request
 *                              start/inflight count is logged for the bounds
 *                              assertions.
 *
 * Machine assertions:
 *   E1 ingest    : all 12 synthetic planes in the flights layer
 *   E2 baseline  : BEFORE any enrichment answer, all 12 billboards carry the
 *                  default airliner glyph at scale 1 (the real-world problem)
 *   E3 requests  : the sweep requested all 12 hexes, each exactly once
 *   E4 diversity : ≥5 distinct glyph data-URIs displayed ambiently after
 *                  enrichment (expected: 8)
 *   E5 glyphs    : every billboard's image === aircraftIcon(classify(typeCode))
 *   E6 scales    : every billboard's scale === CLASS_SCALE_2D[klass]
 *   E7 bounds    : ≤4 concurrent requests, ≥185 ms between dispatches (≤5/s
 *                  drip), total ≤300 (budget ceiling)
 *   E8 next poll : another poll neither reverts glyphs nor re-requests hexes
 *   E10 exhaust  : the ROLLING ambient budget exhausts — new on-screen planes
 *                  stop being requested once the bucket is empty (shrunk via
 *                  the __GEV_ENRICH_AMBIENT_QA seam; a real 5-min window can't
 *                  be waited out headlessly)
 *   E11 resume   : after a refill window passes, ambient enrichment RESUMES
 *                  for the still-unrequested planes (the 2026-07-03 field bug:
 *                  the old one-shot session cap never refilled, so hours-long
 *                  sessions showed airliner monoculture in every new region)
 *   E12 clean    : no console errors
 *
 * Visual output (qa-shots/enrich-ambient/, untracked): before/after top-down
 * spreads of the row.
 *
 * Run:  node scripts/qa-enrich-ambient.mjs --url http://localhost:4304
 * Exits non-zero if any assertion fails. Never commits anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { classifyAircraft, CLASS_SCALE_2D } from '../src/data/aircraftClass.js';
import { aircraftIcon } from '../src/data/aircraftIcons.js';

// ---------------------------------------------------------------------------
// Args (same shape as qa-sprites-b5.mjs)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = getFlag('--headful');
const SHOT_DIR = path.resolve('qa-shots/enrich-ambient');

// Client-side bounds under test (flights.js constants):
const MAX_INFLIGHT = 4;        // ENRICH_MAX_INFLIGHT
const DISPATCH_GAP_MS = 200;   // ENRICH_DISPATCH_GAP_MS (≤5 req/s)
const GAP_TOLERANCE_MS = 15;   // clock-quantization allowance on the gap check
const SESSION_CAP = 300;       // ENRICH_AMBIENT_BUDGET_CEIL (rolling-bucket ceiling)

// Rolling-budget QA seam (window.__GEV_ENRICH_AMBIENT_QA in flights.js):
// shrunk so the exhaust→refill cycle is observable headlessly. windowMs starts
// effectively-infinite (1 h) so E10 exhausts deterministically (no refill can
// land mid-phase); E11 then shortens it in-page so refill windows have
// "passed" and the bucket refills (clamped at ceil). ceil=20 leaves 8 tokens
// after the 12 baseline planes — E10's batch exhausts those 8 and stalls.
const BUDGET_QA = { ceil: 20, refillTokens: 6, windowMs: 3600000 };
const RESUME_WINDOW_MS = 1000; // E11 swaps windowMs to this to unlock refills

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
// Synthetic fleet: one east-west row near Austin, ALL category 0 ("no info" —
// the 94% real-world case). adsbdb type answers cover 8 distinct classes;
// aa000c answers found:false (negative-cache case → stays airliner).
// ---------------------------------------------------------------------------
const ROW_LAT = 30.30;
const ROW_LON0 = -97.82;
const ROW_STEP_DEG = 0.012; // ~1.15 km — 12 planes span ~12.7 km, fits a 20 km-up frame

/** hex → adsbdb icao_type (null = adsbdb miss / negative cache). */
const TYPES = {
  aa0001: 'C172', // light
  aa0002: 'B744', // quadjet
  aa0003: 'DH8D', // turboprop
  aa0004: 'H60',  // helicopter
  aa0005: 'F16',  // fastjet
  aa0006: 'GLID', // glider
  aa0007: 'B77W', // widebody
  aa0008: 'A320', // airliner
  aa0009: 'B738', // airliner (known code outside the special sets)
  aa000a: 'PC12', // turboprop
  aa000b: 'R44',  // helicopter
  aa000c: null,   // adsbdb 404 → found:false → stays airliner, never re-asked
};

const SPEC = {
  timeOffsetSec: 0,
  responseDelayMs: 400, // adsbdb latency so concurrency is actually observable
  budgetQa: BUDGET_QA,
  types: TYPES,
  planes: Object.keys(TYPES).map((hex, i) => ({
    icao: hex,
    callsign: `AMB${String(i + 1).padStart(3, '0')}`,
    lon0: ROW_LON0 + i * ROW_STEP_DEG,
    lat0: ROW_LAT,
    courseDeg: 0,
    speedMps: 70,
    altM: 2400 + i * 40,
  })),
};

// Node-side expectations (same classifier inputs the layer sees).
const expected = new Map(Object.entries(TYPES).map(([hex, tc]) => [
  hex, classifyAircraft(tc ? { typeCode: tc } : { category: 0 }),
]));
const AIRLINER_ICON = aircraftIcon(classifyAircraft({ category: 0 })); // pre-enrichment default

// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nAmbient fleet type-enrichment QA (fleet-enrichment widening)`);
  console.log(`  App URL : ${APP_URL}\n`);
  console.log(`  Expected classes: ${[...expected.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}\n`);

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

    // ---- Fetch shim: synthetic fleet + instrumented, holdable adsbdb -------
    await page.evaluateOnNewDocument((spec) => {
      window.__ENR = spec;
      window.__ENR.epochMs = Date.now();
      // Rolling-budget QA seam — must exist BEFORE flights.js initializes so
      // the shrunk knobs are read from the very first sweep (see BUDGET_QA).
      window.__GEV_ENRICH_AMBIENT_QA = { ...spec.budgetQa };
      // Request log: starts (hex + performance.now), live/max concurrency,
      // hold gate (responses park until the harness releases them so the
      // pre-enrichment baseline is deterministic).
      window.__ENRICH_LOG = { starts: [], inflight: 0, maxInflight: 0, held: true, holds: [] };
      window.__ENRICH_RELEASE = () => {
        window.__ENRICH_LOG.held = false;
        window.__ENRICH_LOG.holds.splice(0).forEach((fn) => fn());
      };

      // Straight line from (lon0, lat0) along courseDeg at speedMps.
      window.__ENR.stateAt = (p, tSec) => {
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
        const S = window.__ENR;
        const nowSec = Date.now() / 1000 + (S.timeOffsetSec || 0);
        const tRel = nowSec - S.epochMs / 1000;

        if (url.includes('/api/adsbdb/type/')) {
          const hex = url.split('/').pop().split('?')[0].toLowerCase();
          const L = window.__ENRICH_LOG;
          L.starts.push({ hex, t: performance.now() });
          L.inflight += 1;
          L.maxInflight = Math.max(L.maxInflight, L.inflight);
          const tc = S.types[hex];
          const body = tc
            ? { found: true, typeCode: tc, typeName: `Synthetic ${tc}`, registration: `N${hex.slice(-3).toUpperCase()}` }
            : { found: false };
          return new Promise((resolve) => {
            const finish = () => setTimeout(() => { L.inflight -= 1; resolve(jsonResponse(body)); }, S.responseDelayMs);
            if (L.held) L.holds.push(finish); else finish();
          });
        }
        if (url.includes('/api/adsbdb/')) return Promise.resolve(jsonResponse({ found: false }));
        if (url.includes('/api/opensky-track')) return Promise.resolve(jsonResponse({ path: [] }));
        if (url.includes('/api/adsblol/trace')) {
          return Promise.resolve(jsonResponse({ timestamp: Math.floor(nowSec), trace: [] }));
        }
        if (url.includes('/api/adsblol/mil')) {
          return Promise.resolve(jsonResponse({ msg: 'No error', now: Date.now(), ac: [] }));
        }
        if (url.includes('/api/opensky')) {
          const states = S.planes.map((f) => {
            const s = S.stateAt(f, tRel);
            return [
              f.icao, f.callsign, 'Synthetica',
              Math.floor(nowSec), Math.floor(nowSec),
              s.lon, s.lat, f.altM,
              false,                    // on_ground
              s.speedMps, s.course,
              0, null, null, null, false, 0,
              0,                        // state[17] — category 0 = "no info" (the 94% case)
            ];
          });
          return Promise.resolve(jsonResponse({ time: Math.floor(nowSec), states }));
        }
        return realFetch(input, init);
      };
    }, SPEC);

    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 60000, polling: 200 }
    );
    console.log('  App globals ready.');

    // ---- In-page billboard probe (same walk as qa-sprites-b5.mjs) ----------
    await page.evaluate(() => {
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
    });

    // ---- Frame the row FIRST (top-down, all 12 on-screen), then prime ------
    // The ambient sweep runs inside update(), so the camera must already be
    // framing the fleet when the layer polls — otherwise the frustum test
    // (correctly) skips off-screen planes.
    const centerLon = ROW_LON0 + ((SPEC.planes.length - 1) / 2) * ROW_STEP_DEG;
    await page.evaluate(({ lat, lon, height }) => {
      const v = window.__godsEyeView.viewer;
      v.camera.cancelFlight(); // the boot fly-to-Austin otherwise stomps setView
      const C3 = v.camera.position.constructor;
      v.camera.setView({
        destination: C3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, { lat: ROW_LAT, lon: centerLon, height: 20000 });

    console.log('Priming straight-flight history through the render delay (30 s)...');
    const primed = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const v = window.__godsEyeView.viewer;
      window.__ENR.timeOffsetSec = -32;
      await dm.setEnabled('flights', true);
      const fl = dm.layers.get('flights').module;
      for (const off of [-24, -16, -8, 0]) {
        window.__ENR.timeOffsetSec = off;
        await fl.update(v);
      }
      window.__ENR.timeOffsetSec = 0;
      window.__ENR_DRIVER = setInterval(() => { fl.update(v); }, 15000);
      return { count: fl.getStats().count, starts: window.__ENRICH_LOG.starts.length };
    });
    console.log(`  flights count=${primed.count} | adsbdb requests started (held): ${primed.starts}`);
    record('E1 ingest: all synthetic category-0 planes in the flights layer',
      primed.count === SPEC.planes.length, `count=${primed.count}/${SPEC.planes.length}`);
    if (primed.count === 0) { finish(); return; }

    // ========================================================================
    // E2 — deterministic pre-enrichment baseline (responses still held)
    // ========================================================================
    console.log('\nE2 — pre-enrichment baseline (adsbdb responses held)');
    const before = await page.evaluate(() => window.__collectBillboards());
    const beforeById = new Map(before.map((b) => [b.id, b]));
    const baselineBad = [];
    for (const hex of Object.keys(TYPES)) {
      const bb = beforeById.get(hex);
      if (!bb) baselineBad.push(`${hex}:missing`);
      else if (bb.image !== AIRLINER_ICON) baselineBad.push(`${hex}:not-default-glyph`);
      else if (Math.abs(bb.scale - (CLASS_SCALE_2D.airliner || 1)) > 1e-9) baselineBad.push(`${hex}:scale=${bb.scale}`);
    }
    record('E2 baseline: all 12 category-0 planes default to the airliner glyph',
      baselineBad.length === 0,
      baselineBad.length ? baselineBad.join(' ') : 'all 12 identical airliner silhouettes (the field-data problem)');
    await sleep(1200); // let a fleet tick land rotations before the "before" shot
    await page.screenshot({ path: path.join(SHOT_DIR, 'enrich-before-monoculture.png') });
    console.log('  saved enrich-before-monoculture.png (12 identical airliner glyphs)');

    // ========================================================================
    // Release adsbdb + wait for the drip to finish, then for glyph swaps
    // ========================================================================
    console.log('\nReleasing adsbdb responses; waiting for the bounded drip to drain...');
    await page.evaluate(() => window.__ENRICH_RELEASE());
    const drained = await page.waitForFunction(
      (want) => window.__ENRICH_LOG.starts.length >= want && window.__ENRICH_LOG.inflight === 0,
      { timeout: 30000, polling: 100 }, SPEC.planes.length
    ).then(() => true).catch(() => false);
    if (!drained) console.log('  \x1b[33mdrip did not fully drain within 30 s\x1b[0m');
    // Give the enrichment callbacks a beat to apply billboard swaps.
    await page.waitForFunction(() => {
      const images = new Set(window.__collectBillboards().map((b) => b.image));
      return images.size >= 5;
    }, { timeout: 10000, polling: 200 }).catch(() => { /* asserted below */ });

    // ========================================================================
    // E3–E6 — requests + ambient glyph/scale swaps (nothing tracked, 3D off)
    // ========================================================================
    console.log('\nE3–E6 — ambient enrichment results');
    const log1 = await page.evaluate(() => ({
      starts: window.__ENRICH_LOG.starts.map((s) => ({ hex: s.hex, t: s.t })),
      maxInflight: window.__ENRICH_LOG.maxInflight,
    }));
    const startHexes = log1.starts.map((s) => s.hex);
    const uniqueHexes = new Set(startHexes);
    const allRequested = Object.keys(TYPES).every((h) => uniqueHexes.has(h));
    record('E3 requests: sweep requested all 12 hexes, each exactly once',
      allRequested && startHexes.length === Object.keys(TYPES).length,
      `${startHexes.length} requests, ${uniqueHexes.size} unique`);

    const after = await page.evaluate(() => window.__collectBillboards());
    const afterById = new Map(after.map((b) => [b.id, b]));
    const syntheticImages = new Set(
      Object.keys(TYPES).map((hex) => afterById.get(hex)?.image).filter(Boolean)
    );
    record('E4 diversity: ≥5 distinct glyph data-URIs displayed ambiently',
      syntheticImages.size >= 5, `${syntheticImages.size} distinct glyphs (expected 8)`);

    const glyphBad = [];
    const scaleBad = [];
    for (const [hex, klass] of expected) {
      const bb = afterById.get(hex);
      const wantImg = aircraftIcon(klass);
      const wantScale = CLASS_SCALE_2D[klass] || 1;
      if (!bb || bb.image !== wantImg) glyphBad.push(`${hex}(${klass})${bb ? ':wrong-image' : ':missing'}`);
      if (bb && Math.abs(bb.scale - wantScale) > 1e-9) scaleBad.push(`${hex}: ${bb.scale} != ${wantScale}`);
    }
    record('E5 glyphs: every billboard matches aircraftIcon(classify(typeCode))',
      glyphBad.length === 0, glyphBad.length ? glyphBad.join(' ') : `${expected.size} matched (incl. the found:false miss staying airliner)`);
    record('E6 scales: every billboard has its per-class CLASS_SCALE_2D',
      scaleBad.length === 0, scaleBad.length ? scaleBad.join(' ') : 'all scales exact (composes with scaleByDistance)');

    await page.screenshot({ path: path.join(SHOT_DIR, 'enrich-after-diverse.png') });
    console.log('  saved enrich-after-diverse.png (type-diverse row, still untracked)');

    // ========================================================================
    // E7 — politeness bounds (concurrency, drip rate, session cap)
    // ========================================================================
    console.log('\nE7 — client-side bounds');
    const gaps = [];
    for (let i = 1; i < log1.starts.length; i++) gaps.push(log1.starts[i].t - log1.starts[i - 1].t);
    const minGap = gaps.length ? Math.min(...gaps) : Infinity;
    // Max dispatches in any sliding 1 s window (reported for context).
    let maxPerSec = 0;
    for (let i = 0; i < log1.starts.length; i++) {
      let n = 0;
      for (let j = i; j < log1.starts.length && log1.starts[j].t - log1.starts[i].t < 1000; j++) n++;
      maxPerSec = Math.max(maxPerSec, n);
    }
    const boundsOk = log1.maxInflight <= MAX_INFLIGHT
      && minGap >= (DISPATCH_GAP_MS - GAP_TOLERANCE_MS)
      && log1.starts.length <= SESSION_CAP;
    record(`E7 bounds: ≤${MAX_INFLIGHT} concurrent, ≥${DISPATCH_GAP_MS}ms drip gap, ≤${SESSION_CAP}/session`,
      boundsOk,
      `maxConcurrent=${log1.maxInflight} minGap=${Number.isFinite(minGap) ? minGap.toFixed(1) : 'n/a'}ms `
      + `maxIn1s=${maxPerSec} total=${log1.starts.length}`);

    // ========================================================================
    // E8 — next poll: klass persists (poll re-derive keeps enriched types) and
    //      the session dedupe never re-requests an answered/negative hex
    // ========================================================================
    console.log('\nE8 — next poll after enrichment');
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const v = window.__godsEyeView.viewer;
      await dm.layers.get('flights').module.update(v);
    });
    await sleep(500);
    const afterPoll = await page.evaluate(() => ({
      billboards: window.__collectBillboards(),
      starts: window.__ENRICH_LOG.starts.length,
    }));
    const afterPollById = new Map(afterPoll.billboards.map((b) => [b.id, b]));
    const pollBad = [];
    for (const [hex, klass] of expected) {
      const bb = afterPollById.get(hex);
      if (!bb || bb.image !== aircraftIcon(klass)) pollBad.push(`${hex}(${klass})${bb ? ':reverted' : ':missing'}`);
      else if (Math.abs(bb.scale - (CLASS_SCALE_2D[klass] || 1)) > 1e-9) pollBad.push(`${hex}:scale-reverted`);
    }
    const noReRequests = afterPoll.starts === Object.keys(TYPES).length;
    record('E8 next poll: enriched glyphs persist and no hex is re-requested',
      pollBad.length === 0 && noReRequests,
      pollBad.length ? pollBad.join(' ') : `glyphs stable, requests still ${afterPoll.starts}`);

    // ========================================================================
    // E10 — rolling-budget exhaustion (2026-07-03 field bug, red/green): the
    // old ONE-SHOT session cap burned out and never refilled, so every new
    // region after the first polls showed airliner monoculture. With the seam
    // ceil=20 and 12 tokens spent above, only 8 remain — a batch of 26 fresh
    // on-screen planes must stall at exactly 8 new requests, and further polls
    // must enqueue NOTHING while the bucket is empty (windowMs is 1 h here, so
    // no refill can land mid-phase). Pre-fix code fails this phase: there is
    // no rolling bucket to exhaust (the seam is unread and the 300 cap simply
    // admits the whole batch).
    // ========================================================================
    console.log('\nE10 — rolling budget exhausts (batch of 26 new planes, 8 tokens left)');
    const BATCH_COUNT = 26;
    const batchHexes = Array.from({ length: BATCH_COUNT }, (_, i) => `ab00${(i + 1).toString(16).padStart(2, '0')}`);
    const startsBeforeBatch = await page.evaluate(() => window.__ENRICH_LOG.starts.length);
    await page.evaluate(async ({ hexes, rowLat, rowLon0, stepDeg }) => {
      const dm = window.__godsEyeView.dataManager;
      const v = window.__godsEyeView.viewer;
      // Two fresh rows just north of the original one — still inside the
      // top-down 20 km frame, so the sweep's frustum test keeps them.
      // STATIONARY (speed 0): moving planes drift north out of the frustum at
      // run-time-dependent rates, which made this phase timing-sensitive.
      hexes.forEach((hex, i) => {
        window.__ENR.planes.push({
          icao: hex,
          callsign: `BGT${String(i + 1).padStart(3, '0')}`,
          lon0: rowLon0 + (i % 13) * stepDeg,
          lat0: rowLat + (i < 13 ? 0.02 : 0.04),
          courseDeg: 0,
          speedMps: 0,
          altM: 2600 + i * 15,
        });
      });
      const fl = dm.layers.get('flights').module;
      await fl.update(v); // sweep enqueues the last 8 tokens
      await fl.update(v); // bucket empty — must enqueue nothing more
    }, { hexes: batchHexes, rowLat: ROW_LAT, rowLon0: ROW_LON0, stepDeg: ROW_STEP_DEG });
    // Wait for the drip to drain whatever was enqueued, then settle.
    await page.waitForFunction(
      (min) => window.__ENRICH_LOG.starts.length >= min && window.__ENRICH_LOG.inflight === 0,
      { timeout: 20000, polling: 100 }, startsBeforeBatch + (BUDGET_QA.ceil - startsBeforeBatch)
    ).catch(() => { /* asserted below */ });
    await sleep(1500); // any illegal post-exhaustion enqueue would dispatch within ~200 ms
    // One more poll while exhausted — still nothing new.
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.layers.get('flights').module.update(window.__godsEyeView.viewer);
    });
    await sleep(1000);
    const exhausted = await page.evaluate(() => ({
      starts: window.__ENRICH_LOG.starts.length,
      inflight: window.__ENRICH_LOG.inflight,
    }));
    record(`E10 exhaust: requests stall at the budget ceiling (${BUDGET_QA.ceil}) with unrequested planes on-screen`,
      exhausted.starts === BUDGET_QA.ceil && exhausted.inflight === 0,
      `starts=${exhausted.starts} (want ${BUDGET_QA.ceil}: ${startsBeforeBatch} baseline + ${BUDGET_QA.ceil - startsBeforeBatch} tokens; `
      + `${BATCH_COUNT - (BUDGET_QA.ceil - startsBeforeBatch)} planes left waiting) inflight=${exhausted.inflight}`);

    // ========================================================================
    // E11 — refill window passes → enrichment RESUMES. Shorten windowMs so the
    // time since the bucket's refill anchor now spans whole windows; the next
    // sweep refills (clamped at ceil) and the waiting planes get requested.
    // ========================================================================
    console.log('\nE11 — refill window passes; ambient enrichment resumes');
    await page.evaluate((winMs) => { window.__GEV_ENRICH_AMBIENT_QA.windowMs = winMs; }, RESUME_WINDOW_MS);
    await sleep(RESUME_WINDOW_MS + 200); // a full (shortened) refill window elapses
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.layers.get('flights').module.update(window.__godsEyeView.viewer);
    });
    const expectedTotal = startsBeforeBatch + BATCH_COUNT; // every batch plane eventually requested
    const resumed = await page.waitForFunction(
      (want) => window.__ENRICH_LOG.starts.length >= want && window.__ENRICH_LOG.inflight === 0,
      { timeout: 25000, polling: 100 }, expectedTotal
    ).then(() => true).catch(() => false);
    const resumeLog = await page.evaluate(() => window.__ENRICH_LOG.starts.map((s) => s.hex));
    const batchRequested = batchHexes.filter((h) => resumeLog.includes(h)).length;
    const dupes = resumeLog.length !== new Set(resumeLog).size;
    record('E11 resume: enrichment resumes after a refill window (all waiting planes requested, once each)',
      resumed && batchRequested === BATCH_COUNT && resumeLog.length === expectedTotal && !dupes,
      `starts=${resumeLog.length} (want ${expectedTotal}) batchRequested=${batchRequested}/${BATCH_COUNT} dupes=${dupes}`);

    record('E12: no console errors during QA run', consoleErrors.length === 0,
      consoleErrors.length ? `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}` : 'clean');

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
